/**
 * Norwegian Singles Method - Strava API Integration (v2)
 * 
 * 개선 사항:
 * 1. 인터벌/휴식 구간 자동 분리 (HR 존 기반)
 * 2. 트레드밀 페이스 수동 보정
 * 3. 훈련 일정 불일치 감지
 */

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Strava API 설정
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

// BASE_URL 결정 함수 (요청 시점에 동적으로 결정)
function getBaseUrl(req) {
  // 환경 변수에 명시적으로 설정된 경우 우선 사용
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  
  // 요청 헤더에서 추출
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  
  if (host) {
    return `${protocol}://${host}`;
  }
  
  return `http://localhost:${PORT}`;
}

// Render/Heroku 등 프록시 환경 지원
app.set('trust proxy', 1);

// 환경 확인 (디버그용)
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER_EXTERNAL_URL;
console.log('=== Server Config ===');
console.log('PORT:', PORT);
console.log('isProduction:', isProduction);
console.log('STRAVA_CLIENT_ID:', STRAVA_CLIENT_ID ? 'SET' : 'NOT SET');
console.log('STRAVA_CLIENT_SECRET:', STRAVA_CLIENT_SECRET ? 'SET' : 'NOT SET');
console.log('====================');

// 미들웨어
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static('public'));

// 세션 설정 - Render 환경에 맞게 조정
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'norwegian-singles-strava-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { 
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7일
  }
};

// 프로덕션 환경에서만 secure 쿠키 사용
if (isProduction) {
  sessionConfig.cookie.secure = true;
  sessionConfig.cookie.sameSite = 'lax'; // 같은 사이트 내에서는 lax가 더 안정적
}

app.use(session(sessionConfig));

// 디버그 엔드포인트
app.get('/api/debug', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    baseUrl: baseUrl,
    isProduction,
    hasStravaId: !!STRAVA_CLIENT_ID,
    hasStravaSecret: !!STRAVA_CLIENT_SECRET,
    sessionId: req.sessionID,
    hasSession: !!req.session,
    hasStravaData: !!req.session?.strava,
    cookies: req.headers.cookie ? 'present' : 'none',
    headers: {
      host: req.headers.host,
      xForwardedProto: req.headers['x-forwarded-proto'],
      xForwardedHost: req.headers['x-forwarded-host']
    }
  });
});

// ===== Strava OAuth =====

app.get('/api/strava/auth', (req, res) => {
  const baseUrl = getBaseUrl(req);
  console.log('[Auth] Starting Strava OAuth...');
  console.log('[Auth] BASE_URL:', baseUrl);
  
  if (!STRAVA_CLIENT_ID) {
    console.error('[Auth] STRAVA_CLIENT_ID not set!');
    return res.status(500).json({ error: 'Strava Client ID가 설정되지 않았습니다.' });
  }
  
  const redirectUri = `${baseUrl}/api/strava/callback`;
  const scope = 'read,activity:read_all';
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
  
  console.log('[Auth] Redirect URI:', redirectUri);
  console.log('[Auth] Redirecting to Strava...');
  
  res.redirect(authUrl);
});

app.get('/api/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  
  console.log('[Callback] Received callback');
  console.log('[Callback] Code:', code ? 'present' : 'missing');
  console.log('[Callback] Error:', error || 'none');
  
  if (error || !code) {
    console.error('[Callback] Access denied or no code');
    return res.redirect('/?error=access_denied');
  }
  
  try {
    console.log('[Callback] Exchanging code for token...');
    
    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code'
      })
    });
    
    const data = await response.json();
    
    console.log('[Callback] Token response status:', response.status);
    console.log('[Callback] Has access_token:', !!data.access_token);
    
    if (data.access_token) {
      req.session.strava = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        athlete: data.athlete
      };
      req.session.corrections = req.session.corrections || {};
      
      // 세션 저장 확인
      req.session.save((err) => {
        if (err) {
          console.error('[Callback] Session save error:', err);
          return res.redirect('/?error=session_failed');
        }
        console.log('[Callback] Session saved successfully');
        console.log('[Callback] Athlete:', data.athlete?.firstname, data.athlete?.lastname);
        res.redirect('/?connected=true');
      });
    } else {
      console.error('[Callback] Token exchange failed:', data);
      res.redirect('/?error=token_failed');
    }
  } catch (error) {
    console.error('[Callback] Exception:', error);
    res.redirect('/?error=callback_failed');
  }
});

async function refreshStravaToken(session) {
  if (!session.strava?.refreshToken) return null;
  
  if (session.strava.expiresAt > (Date.now() / 1000) + 600) {
    return session.strava.accessToken;
  }
  
  try {
    const response = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        refresh_token: session.strava.refreshToken,
        grant_type: 'refresh_token'
      })
    });
    
    const data = await response.json();
    
    if (data.access_token) {
      session.strava.accessToken = data.access_token;
      session.strava.refreshToken = data.refresh_token;
      session.strava.expiresAt = data.expires_at;
      return data.access_token;
    }
  } catch (error) {
    console.error('토큰 갱신 에러:', error);
  }
  
  return null;
}

app.get('/api/strava/status', async (req, res) => {
  console.log('[Status] Checking session...');
  console.log('[Status] Session ID:', req.sessionID);
  console.log('[Status] Has strava data:', !!req.session.strava);
  
  if (req.session.strava?.accessToken) {
    console.log('[Status] Token exists, refreshing if needed...');
    const token = await refreshStravaToken(req.session);
    if (token) {
      console.log('[Status] User logged in:', req.session.strava.athlete?.firstname);
      return res.json({ 
        loggedIn: true, 
        athlete: req.session.strava.athlete 
      });
    }
  }
  console.log('[Status] Not logged in');
  res.json({ loggedIn: false });
});

app.post('/api/strava/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===== 활동 데이터 API =====

app.get('/api/strava/activities', async (req, res) => {
  const token = await refreshStravaToken(req.session);
  
  if (!token) {
    return res.status(401).json({ error: 'Strava에 연결해주세요.' });
  }
  
  try {
    const perPage = parseInt(req.query.limit) || 30;
    
    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    
    if (!response.ok) {
      throw new Error(`Strava API 에러: ${response.status}`);
    }
    
    const activities = await response.json();
    const corrections = req.session.corrections || {};
    
    const formatted = activities
      .filter(a => a.type === 'Run' || a.type === 'VirtualRun' || a.type === 'TrailRun')
      .map(a => {
        const correction = corrections[a.id] || {};
        const name = (a.name || '').toLowerCase();
        // 트레드밀 감지: VirtualRun 타입 또는 이름에 "트레드밀", "treadmill" 포함
        const isTreadmill = a.type === 'VirtualRun' || 
                           name.includes('트레드밀') || 
                           name.includes('treadmill') ||
                           name.includes('러닝머신');
        const autoType = classifyType(a);
        
        // 사용자가 수정한 분류가 있으면 우선 사용
        const workoutType = correction.type || autoType;
        const workoutSubType = correction.subType || classifySubType(a, workoutType);
        
        return {
          id: a.id,
          date: a.start_date_local.split('T')[0],
          name: a.name,
          type: workoutType,
          autoType: autoType, // 자동 분류 결과도 함께 전달
          subType: workoutSubType,
          duration: Math.round(a.moving_time / 60),
          distance: (a.distance / 1000).toFixed(2),
          avgPace: formatPace(a.average_speed),
          avgHR: a.average_heartrate ? Math.round(a.average_heartrate) : null,
          maxHR: a.max_heartrate ? Math.round(a.max_heartrate) : null,
          isTreadmill: isTreadmill,
          needsPaceCorrection: isTreadmill && !correction.pace,
          correctedPace: correction.pace || null,
          intervalPace: correction.intervalPace || null,
          intervalHR: correction.intervalHR || null,
          hasUserCorrection: !!(correction.type || correction.pace || correction.intervalPace),
          elevationGain: a.total_elevation_gain || null,
          sufferScore: a.suffer_score || null
        };
      });
    
    res.json({ success: true, activities: formatted });
  } catch (error) {
    console.error('활동 조회 에러:', error);
    res.status(500).json({ error: '활동을 가져오는 중 오류가 발생했습니다.' });
  }
});

// 활동 상세 + 랩 분석
app.get('/api/strava/activity/:id', async (req, res) => {
  const token = await refreshStravaToken(req.session);
  
  if (!token) {
    return res.status(401).json({ error: 'Strava에 연결해주세요.' });
  }
  
  try {
    const [activityRes, lapsRes] = await Promise.all([
      fetch(`https://www.strava.com/api/v3/activities/${req.params.id}`, 
        { headers: { 'Authorization': `Bearer ${token}` } }),
      fetch(`https://www.strava.com/api/v3/activities/${req.params.id}/laps`, 
        { headers: { 'Authorization': `Bearer ${token}` } })
    ]);
    
    if (!activityRes.ok) {
      throw new Error(`Strava API 에러: ${activityRes.status}`);
    }
    
    const activity = await activityRes.json();
    const laps = lapsRes.ok ? await lapsRes.json() : [];
    
    const correction = (req.session.corrections || {})[req.params.id] || {};
    const lapCorrections = correction.laps || {};
    
    const analysis = analyzeLaps(laps, activity, lapCorrections);
    
    res.json({
      success: true,
      activity: {
        id: activity.id,
        name: activity.name,
        date: activity.start_date_local,
        type: correction.type || classifyType(activity),
        duration: Math.round(activity.moving_time / 60),
        distance: (activity.distance / 1000).toFixed(2),
        avgPace: formatPace(activity.average_speed),
        avgHR: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
        maxHR: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
        isTreadmill: activity.type === 'VirtualRun'
      },
      laps: analysis.laps,
      intervalStats: analysis.intervalAnalysis,
      intervalSets: analysis.intervalSets || [],
      correction: correction,
      lapCorrections: lapCorrections
    });
  } catch (error) {
    console.error('활동 상세 조회 에러:', error);
    res.status(500).json({ error: '활동 상세 정보를 가져오는 중 오류가 발생했습니다.' });
  }
});

// 보정 데이터 저장 (분류, 페이스 등)
app.post('/api/strava/activity/:id/correction', (req, res) => {
  const { id } = req.params;
  const { type, subType, pace, intervalPace, intervalHR } = req.body;
  
  if (!req.session.corrections) {
    req.session.corrections = {};
  }
  
  // 기존 데이터와 병합
  const existing = req.session.corrections[id] || {};
  req.session.corrections[id] = {
    ...existing,
    type: type !== undefined ? type : existing.type,
    subType: subType !== undefined ? subType : existing.subType,
    pace: pace !== undefined ? pace : existing.pace,
    intervalPace: intervalPace !== undefined ? intervalPace : existing.intervalPace,
    intervalHR: intervalHR !== undefined ? (intervalHR ? parseInt(intervalHR) : null) : existing.intervalHR,
    updatedAt: new Date().toISOString()
  };
  
  res.json({ success: true, correction: req.session.corrections[id] });
});

app.delete('/api/strava/activity/:id/correction', (req, res) => {
  if (req.session.corrections) {
    delete req.session.corrections[req.params.id];
  }
  res.json({ success: true });
});

// 랩별 수정 API
app.post('/api/strava/activity/:id/lap/:lapNum/correction', (req, res) => {
  const { id, lapNum } = req.params;
  const { type, pace } = req.body;
  
  if (!req.session.corrections) {
    req.session.corrections = {};
  }
  
  if (!req.session.corrections[id]) {
    req.session.corrections[id] = {};
  }
  
  if (!req.session.corrections[id].laps) {
    req.session.corrections[id].laps = {};
  }
  
  req.session.corrections[id].laps[lapNum] = {
    type: type || null,
    pace: pace || null,
    updatedAt: new Date().toISOString()
  };
  
  res.json({ success: true, lapCorrection: req.session.corrections[id].laps[lapNum] });
});

app.delete('/api/strava/activity/:id/lap/:lapNum/correction', (req, res) => {
  const { id, lapNum } = req.params;
  
  if (req.session.corrections?.[id]?.laps) {
    delete req.session.corrections[id].laps[lapNum];
  }
  res.json({ success: true });
});

// 모든 랩 수정 초기화
app.delete('/api/strava/activity/:id/laps/correction', (req, res) => {
  const { id } = req.params;
  
  if (req.session.corrections?.[id]) {
    req.session.corrections[id].laps = {};
  }
  res.json({ success: true });
});

// ===== 훈련 일정 API =====

app.get('/api/schedule/recommended', (req, res) => {
  const today = new Date();
  const dayOfWeek = today.getDay();
  
  const weeklyPattern = {
    0: { type: 'long', name: 'Long Run', desc: '90-120분 @ Easy 페이스' },
    1: { type: 'easy', name: 'Easy Run', desc: '40-60분 회복' },
    2: { type: 'sub-t', subType: 'short', name: 'Sub-T (짧은)', desc: '6×1000m (60초 휴식)' },
    3: { type: 'easy', name: 'Easy Run', desc: '40-60분 회복' },
    4: { type: 'sub-t', subType: 'medium', name: 'Sub-T (중간)', desc: '4×2000m (75초 휴식)' },
    5: { type: 'easy', name: 'Easy Run', desc: '40-60분 회복' },
    6: { type: 'sub-t', subType: 'long', name: 'Sub-T (긴)', desc: '3×10분 (90초 휴식)' }
  };
  
  res.json({
    success: true,
    today: weeklyPattern[dayOfWeek],
    week: weeklyPattern
  });
});

app.get('/api/schedule/analysis', async (req, res) => {
  const token = await refreshStravaToken(req.session);
  
  if (!token) {
    return res.status(401).json({ error: 'Strava에 연결해주세요.' });
  }
  
  try {
    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=14`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    
    const activities = await response.json();
    
    const today = new Date();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    
    const weeklyPattern = {
      0: 'long', 1: 'easy', 2: 'sub-t', 3: 'easy', 4: 'sub-t', 5: 'easy', 6: 'sub-t'
    };
    
    const mismatches = [];
    
    activities
      .filter(a => a.type === 'Run' || a.type === 'VirtualRun' || a.type === 'TrailRun')
      .forEach(a => {
        const activityDate = new Date(a.start_date_local);
        if (activityDate >= startOfWeek && activityDate <= today) {
          const dayOfWeek = activityDate.getDay();
          const recommended = weeklyPattern[dayOfWeek];
          const actual = classifyType(a);
          
          if (recommended !== actual) {
            mismatches.push({
              date: a.start_date_local.split('T')[0],
              dayOfWeek: dayOfWeek,
              dayName: ['일', '월', '화', '수', '목', '금', '토'][dayOfWeek],
              recommended: recommended,
              actual: actual,
              activityName: a.name,
              activityId: a.id
            });
          }
        }
      });
    
    res.json({
      success: true,
      mismatches: mismatches,
      hasMismatches: mismatches.length > 0
    });
  } catch (error) {
    console.error('일정 분석 에러:', error);
    res.status(500).json({ error: '일정 분석 중 오류가 발생했습니다.' });
  }
});

// ===== 헬퍼 함수 =====

function analyzeLaps(laps, activity, lapCorrections = {}) {
  if (!laps || laps.length === 0) {
    return { laps: [], intervalAnalysis: null, intervalSets: [] };
  }
  
  const userMaxHR = 190; // 사용자 최대 심박수
  
  // 1단계: 기본 데이터 추출
  const lapData = laps.map((lap, index) => {
    const avgHR = lap.average_heartrate || 0;
    const hrPercent = userMaxHR > 0 ? (avgHR / userMaxHR) * 100 : 0;
    const pace = lap.average_speed > 0 ? 1000 / lap.average_speed : 999;
    const distance = lap.distance / 1000;
    
    return {
      index,
      lap: index + 1,
      distance,
      distanceMeters: lap.distance,
      duration: Math.round(lap.moving_time / 60 * 10) / 10,
      durationSeconds: lap.moving_time,
      pace,
      paceFormatted: formatPaceFromSeconds(pace),
      paceSeconds: Math.round(pace),
      avgHR: avgHR ? Math.round(avgHR) : null,
      hrPercent: Math.round(hrPercent)
    };
  });
  
  // 2단계: 인터벌 후보 식별 (거리 0.5km 이상, 페이스 6분/km 이하)
  const workLaps = lapData.filter(l => l.distance >= 0.5 && l.pace <= 360);
  const restLaps = lapData.filter(l => l.distance < 0.1 || l.pace > 480);
  
  // 3단계: 작업 랩들의 페이스 분포 분석
  let fastPaceThreshold = 300; // 기본 5분/km
  if (workLaps.length >= 3) {
    const workPaces = workLaps.map(l => l.pace).sort((a, b) => a - b);
    const fastestQuartile = workPaces[Math.floor(workPaces.length * 0.25)];
    const medianPace = workPaces[Math.floor(workPaces.length * 0.5)];
    // 빠른 랩 기준: 중간값의 1.1배 이내
    fastPaceThreshold = medianPace * 1.1;
  }
  
  // 4단계: 랩 분류
  const analyzedLaps = lapData.map((lap, index) => {
    // 사용자가 수동으로 수정한 분류가 있으면 우선 적용
    const correction = lapCorrections[lap.lap] || {};
    if (correction.type) {
      return {
        ...lap,
        pace: correction.pace ? parsePaceToSeconds(correction.pace) : lap.pace,
        paceFormatted: correction.pace || lap.paceFormatted,
        paceSeconds: correction.pace ? parsePaceToSeconds(correction.pace) : lap.paceSeconds,
        type: correction.type,
        userCorrected: true
      };
    }
    
    let lapType = 'unknown';
    
    // 매우 짧은 거리 (0.1km 미만) → 휴식
    if (lap.distance < 0.1) {
      lapType = 'rest';
    }
    // 매우 느린 페이스 (8분/km 이상) → 휴식
    else if (lap.pace > 480) {
      lapType = 'rest';
    }
    // 빠른 페이스 + 적절한 거리 (0.5km 이상) → 인터벌
    else if (lap.pace <= fastPaceThreshold && lap.distance >= 0.5) {
      lapType = 'interval';
    }
    // 느린 페이스 (기준보다 30% 이상 느림) → 휴식 또는 이지
    else if (lap.pace > fastPaceThreshold * 1.3) {
      lapType = lap.distance < 0.3 ? 'rest' : 'easy';
    }
    // HR 기반 보조 분류
    else if (lap.hrPercent >= 75) {
      lapType = 'interval';
    }
    else if (lap.hrPercent >= 65 && lap.hrPercent < 75) {
      lapType = 'easy';
    }
    // 마지막 랩이고 짧으면 쿨다운
    else if (index === lapData.length - 1 && lap.distance < 0.5) {
      lapType = 'cooldown';
    }
    // 첫 번째 랩이고 다음 랩이 휴식이면 워밍업일 가능성
    else if (index === 0 && lapData.length > 1) {
      const nextLap = lapData[1];
      if (nextLap.distance < 0.1 || nextLap.pace > 480) {
        // 다음이 휴식이면 현재는 인터벌
        lapType = 'interval';
      } else if (lap.hrPercent < 70) {
        lapType = 'warmup';
      } else {
        lapType = 'interval';
      }
    }
    else {
      // 기본: 페이스가 빠른 편이면 인터벌, 아니면 이지
      lapType = lap.pace <= fastPaceThreshold * 1.15 ? 'interval' : 'easy';
    }
    
    return {
      ...lap,
      paceFormatted: lap.paceFormatted,
      type: lapType,
      userCorrected: false
    };
  });
  
  // 최종 형식으로 변환
  const finalLaps = analyzedLaps.map(lap => ({
    lap: lap.lap,
    distance: lap.distance.toFixed(2),
    distanceMeters: lap.distanceMeters,
    duration: lap.duration,
    durationSeconds: lap.durationSeconds,
    pace: lap.paceFormatted,
    paceSeconds: lap.paceSeconds,
    avgHR: lap.avgHR,
    hrPercent: lap.hrPercent,
    type: lap.type,
    userCorrected: lap.userCorrected || false
  }));
  
  // === 연속 인터벌 랩을 "인터벌 세트"로 합치기 ===
  const intervalSets = [];
  let currentSet = null;
  
  finalLaps.forEach((lap, index) => {
    if (lap.type === 'interval') {
      if (!currentSet) {
        // 새로운 인터벌 세트 시작
        currentSet = {
          startLap: lap.lap,
          endLap: lap.lap,
          laps: [lap],
          totalDistance: parseFloat(lap.distance),
          totalDistanceMeters: lap.distanceMeters,
          totalDuration: lap.duration,
          totalDurationSeconds: lap.durationSeconds,
          paceSum: lap.paceSeconds,
          hrSum: lap.avgHR || 0,
          hrCount: lap.avgHR ? 1 : 0
        };
      } else {
        // 기존 세트에 추가
        currentSet.endLap = lap.lap;
        currentSet.laps.push(lap);
        currentSet.totalDistance += parseFloat(lap.distance);
        currentSet.totalDistanceMeters += lap.distanceMeters;
        currentSet.totalDuration += lap.duration;
        currentSet.totalDurationSeconds += lap.durationSeconds;
        currentSet.paceSum += lap.paceSeconds;
        if (lap.avgHR) {
          currentSet.hrSum += lap.avgHR;
          currentSet.hrCount++;
        }
      }
    } else {
      // 인터벌이 아닌 랩 → 현재 세트 종료
      if (currentSet) {
        // 세트 통계 계산
        const lapCount = currentSet.laps.length;
        currentSet.avgPaceSeconds = currentSet.totalDurationSeconds / (currentSet.totalDistanceMeters / 1000);
        currentSet.avgPace = formatPaceFromSeconds(currentSet.avgPaceSeconds);
        currentSet.avgHR = currentSet.hrCount > 0 ? Math.round(currentSet.hrSum / currentSet.hrCount) : null;
        currentSet.totalDistance = currentSet.totalDistance.toFixed(2);
        currentSet.lapCount = lapCount;
        intervalSets.push(currentSet);
        currentSet = null;
      }
    }
  });
  
  // 마지막 세트 처리
  if (currentSet) {
    const lapCount = currentSet.laps.length;
    currentSet.avgPaceSeconds = currentSet.totalDurationSeconds / (currentSet.totalDistanceMeters / 1000);
    currentSet.avgPace = formatPaceFromSeconds(currentSet.avgPaceSeconds);
    currentSet.avgHR = currentSet.hrCount > 0 ? Math.round(currentSet.hrSum / currentSet.hrCount) : null;
    currentSet.totalDistance = currentSet.totalDistance.toFixed(2);
    currentSet.lapCount = lapCount;
    intervalSets.push(currentSet);
  }
  
  // 인터벌 세트 기반 분석
  let intervalAnalysis = null;
  if (intervalSets.length > 0) {
    const totalDistance = intervalSets.reduce((sum, s) => sum + parseFloat(s.totalDistance), 0);
    const totalDurationSeconds = intervalSets.reduce((sum, s) => sum + s.totalDurationSeconds, 0);
    const avgPaceSeconds = totalDurationSeconds / totalDistance;
    const validHRSets = intervalSets.filter(s => s.avgHR);
    const avgHR = validHRSets.length > 0
      ? Math.round(validHRSets.reduce((sum, s) => sum + s.avgHR, 0) / validHRSets.length)
      : null;
    
    intervalAnalysis = {
      count: intervalSets.length, // 인터벌 세트 수
      avgPace: formatPaceFromSeconds(avgPaceSeconds),
      avgPaceSeconds: Math.round(avgPaceSeconds),
      avgHR: avgHR,
      totalDistance: totalDistance.toFixed(2),
      sets: intervalSets // 각 인터벌 세트 상세
    };
  }
  
  return { laps: finalLaps, intervalAnalysis, intervalSets };
}

// 페이스 문자열을 초로 변환 (예: "4:30" → 270)
function parsePaceToSeconds(paceStr) {
  if (!paceStr) return 0;
  const parts = paceStr.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }
  return 0;
}

function classifyType(a) {
  const duration = a.moving_time / 60;
  const avgHR = a.average_heartrate;
  const pace = a.average_speed ? 1000 / a.average_speed : 0; // 초/km
  
  // 사용자 MaxHR - 고정값 190 사용 (운동의 max_heartrate가 아님!)
  const userMaxHR = 190;
  const hrPercent = avgHR ? (avgHR / userMaxHR) * 100 : 0;
  
  // 0. 매우 짧은 활동 (15분 미만) → 워밍업/쿨다운으로 간주
  //    Sub-T 분석에서 제외됨
  if (duration < 15) {
    return 'warmup-cooldown';
  }
  
  // 1. 롱런 (85분 이상)
  if (duration >= 85) return 'long';
  
  // 2. Easy Run 판단 - 여러 조건 중 하나라도 충족하면 Easy
  //    - 절대 HR: 평균 HR < 145bpm (낮은 절대값)
  //    - 상대 HR: HR < 72% MaxHR
  //    - 복합: HR < 75% & 페이스 > 5:30/km
  if (avgHR && avgHR < 145) return 'easy';
  if (hrPercent > 0 && hrPercent < 72) return 'easy';
  if (hrPercent > 0 && hrPercent < 75 && pace > 330) return 'easy';
  
  // 3. 짧은 활동 (25분 미만) + HR 낮음 → Easy (워밍업성 조깅)
  if (duration < 25 && avgHR && avgHR < 155) return 'easy';
  
  // 4. 이름 기반 판단 (단, HR이 너무 낮으면 무시)
  const name = (a.name || '').toLowerCase();
  const hasSubTKeywords = name.includes('interval') || name.includes('tempo') || 
      name.includes('threshold') || name.includes('sub-t') ||
      name.includes('workout') || name.includes('quality') ||
      name.includes('인터벌') || name.includes('템포') ||
      name.includes('sub') || name.includes('서브');
  
  if (hasSubTKeywords) {
    // 키워드가 있어도 HR이 낮으면 Easy (잘못된 이름 또는 쉬운 세션)
    if (avgHR && avgHR < 150) return 'easy';
    if (hrPercent > 0 && hrPercent < 75) return 'easy';
    return 'sub-t';
  }
  
  // 5. HR 기반 Sub-T (78-90%)
  if (hrPercent >= 78 && hrPercent <= 90) return 'sub-t';
  
  // 6. HR 정보 없으면 페이스로 판단
  if (!avgHR) {
    if (pace > 360) return 'easy'; // 6:00/km보다 느림
    if (pace < 330 && duration >= 40) return 'sub-t'; // 빠르고 길면 Sub-T
    return 'easy';
  }
  
  // 7. 기본값: HR 75% 미만이면 Easy
  if (hrPercent < 75) return 'easy';
  
  return 'sub-t';
}

function classifySubType(a, type) {
  if (type !== 'sub-t') return null;
  
  const name = (a.name || '').toLowerCase();
  const duration = a.moving_time / 60;
  
  if (name.includes('1000') || name.includes('1k') || name.includes('short') || name.includes('짧은')) return 'short';
  if (name.includes('2000') || name.includes('2k') || name.includes('medium') || name.includes('중간')) return 'medium';
  if (name.includes('10min') || name.includes('10분') || name.includes('long') || name.includes('긴')) return 'long';
  
  if (duration < 40) return 'short';
  if (duration < 55) return 'medium';
  return 'long';
}

function formatPace(speedMps) {
  if (!speedMps || speedMps === 0) return 'N/A';
  const pace = 1000 / speedMps;
  return formatPaceFromSeconds(pace);
}

function formatPaceFromSeconds(seconds) {
  if (!seconds || seconds === 0 || seconds > 900) return 'N/A';
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ===== 기본 라우트 =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     Norwegian Singles Method - Strava Integration v2       ║
╠════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                             ║
║  Strava Client ID: ${STRAVA_CLIENT_ID ? '✓ 설정됨' : '✗ 미설정'}
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
