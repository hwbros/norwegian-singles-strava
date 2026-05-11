/**
 * Norwegian Singles Method - Strava API Integration (v2)
 * 
 * 개선 사항:
 * 1. 인터벌/휴식 구간 자동 분리 (HR 존 기반)
 * 2. 트레드밀 페이스 수동 보정
 * 3. 훈련 일정 불일치 감지
 * 4. Supabase 영구 저장 (기기 간 동기화)
 */

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Strava API 설정
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_VERIFY_TOKEN = process.env.STRAVA_VERIFY_TOKEN || 'norwegian-strava-webhook-verify';

// Supabase 설정
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('Supabase connected');
} else {
  console.log('Supabase not configured - using session storage (not persistent)');
}

// ===== stravaFetch: Rate-limit-aware Strava v3 API wrapper =====

const rateLimitState = { usage15min: null, usageDaily: null, limit15min: null, limitDaily: null };

async function stravaFetch(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);

    const limitHdr = response.headers.get('X-RateLimit-Limit');
    const usageHdr = response.headers.get('X-RateLimit-Usage');
    if (limitHdr && usageHdr) {
      const [l15, lDay] = limitHdr.split(',').map(s => parseInt(s.trim(), 10));
      const [u15, uDay] = usageHdr.split(',').map(s => parseInt(s.trim(), 10));
      Object.assign(rateLimitState, { limit15min: l15, limitDaily: lDay, usage15min: u15, usageDaily: uDay });
      console.log(`[RateLimit] 15min: ${u15}/${l15}  Daily: ${uDay}/${lDay}`);
    }

    if (response.status !== 429) return response;

    if (attempt === retries) {
      console.error(`[stravaFetch] 429 — max retries exceeded: ${url}`);
      return response;
    }
    const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
    console.warn(`[stravaFetch] 429 — waiting ${retryAfter}s (attempt ${attempt + 1}/${retries})`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
  }
}

// ===== In-memory activities cache =====

const activitiesCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedActivities(athleteId) {
  const entry = activitiesCache.get(String(athleteId));
  if (!entry || Date.now() > entry.expiresAt) { activitiesCache.delete(String(athleteId)); return null; }
  return entry.data;
}
function setCachedActivities(athleteId, data) {
  activitiesCache.set(String(athleteId), { data, expiresAt: Date.now() + CACHE_TTL_MS });
}
function invalidateCache(athleteId) {
  activitiesCache.delete(String(athleteId));
  console.log(`[Cache] Invalidated for athlete ${athleteId}`);
}

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
console.log('SUPABASE_URL:', SUPABASE_URL ? 'SET' : 'NOT SET');
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

// ===== Webhook =====

app.get('/api/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === STRAVA_VERIFY_TOKEN) {
    console.log('[Webhook] Verification handshake accepted');
    return res.json({ 'hub.challenge': challenge });
  }
  console.warn('[Webhook] Verification failed — token mismatch or wrong mode');
  res.status(403).json({ error: 'Forbidden' });
});

app.post('/api/webhook', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  setImmediate(async () => {
    try {
      const { object_type, owner_id } = req.body;
      console.log('[Webhook] Event received:', JSON.stringify(req.body));
      if (object_type === 'activity' && owner_id) invalidateCache(owner_id);
    } catch (err) {
      console.error('[Webhook] Async processing error:', err);
    }
  });
});

app.post('/api/webhook/subscribe', async (req, res) => {
  try {
    const callbackUrl = `${getBaseUrl(req)}/api/webhook`;
    const body = new URLSearchParams({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: STRAVA_VERIFY_TOKEN
    });
    const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await r.json();
    r.ok ? res.json({ success: true, subscription: data }) : res.status(r.status).json({ error: data });
  } catch (err) {
    console.error('[Webhook] Subscribe error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/webhook/status', async (req, res) => {
  try {
    const r = await fetch(`https://www.strava.com/api/v3/push_subscriptions?client_id=${STRAVA_CLIENT_ID}&client_secret=${STRAVA_CLIENT_SECRET}`);
    res.json({ subscriptions: await r.json() });
  } catch (err) {
    console.error('[Webhook] Status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.delete('/api/webhook/unsubscribe', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param required' });
  try {
    const body = new URLSearchParams({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET });
    const r = await fetch(`https://www.strava.com/api/v3/push_subscriptions/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    r.status === 204 ? res.json({ success: true }) : res.status(r.status).json({ error: 'Deletion failed' });
  } catch (err) {
    console.error('[Webhook] Unsubscribe error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ===== 활동 데이터 API =====

app.get('/api/strava/activities', async (req, res) => {
  const token = await refreshStravaToken(req.session);
  
  if (!token) {
    return res.status(401).json({ error: 'Strava에 연결해주세요.' });
  }
  
  try {
    const perPage = parseInt(req.query.limit) || 30;
    const athleteId = req.session.strava?.athlete?.id;
    const forceRefresh = req.query.refresh === 'true';

    if (!forceRefresh && athleteId) {
      const cached = getCachedActivities(athleteId);
      if (cached) {
        console.log(`[Cache] HIT for athlete ${athleteId}`);
        return res.json({ ...cached, fromCache: true });
      }
    }

    // 사용자 설정 조회
    const userSettings = await getUserSettings(athleteId, req.session);
    const userMaxHR = userSettings.maxHR;

    const response = await stravaFetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (!response.ok) {
      throw new Error(`Strava API 에러: ${response.status}`);
    }

    const activities = await response.json();

    // 모든 활동의 correction을 한 번에 조회
    const corrections = await getAllCorrections(athleteId, activities.map(a => a.id), req.session);
    
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
        const autoType = classifyType(a, userMaxHR);
        
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
    
    const result = { success: true, activities: formatted, userMaxHR: userMaxHR };
    if (athleteId) {
      setCachedActivities(athleteId, result);
      console.log(`[Cache] SET for athlete ${athleteId}`);
    }
    res.json(result);
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
    const athleteId = req.session.strava?.athlete?.id;
    
    // 사용자 설정 조회
    const userSettings = await getUserSettings(athleteId, req.session);
    const userMaxHR = userSettings.maxHR;
    
    const [activityRes, lapsRes] = await Promise.all([
      stravaFetch(`https://www.strava.com/api/v3/activities/${req.params.id}`,
        { headers: { 'Authorization': `Bearer ${token}` } }),
      stravaFetch(`https://www.strava.com/api/v3/activities/${req.params.id}/laps`,
        { headers: { 'Authorization': `Bearer ${token}` } })
    ]);
    
    if (!activityRes.ok) {
      throw new Error(`Strava API 에러: ${activityRes.status}`);
    }
    
    const activity = await activityRes.json();
    const laps = lapsRes.ok ? await lapsRes.json() : [];
    
    // Supabase 또는 세션에서 correction 조회
    const correction = await getCorrection(athleteId, req.params.id, req.session);
    const lapCorrections = correction.laps || {};
    
    const analysis = analyzeLaps(laps, activity, lapCorrections, userMaxHR);

    // 랩 수정이 있으면 수정된 랩들의 시간/유효거리로 평균 페이스 재계산
    // (전체 랩 평균이 아닌 수정 구간만 사용 → rest 랩 GPS 오차 영향 배제)
    let avgPace = formatPace(activity.average_speed);
    if (analysis.hasLapCorrections && analysis.laps.length > 0) {
      const correctedLaps = analysis.laps.filter(l => l.userCorrected && l.paceSeconds > 0);
      const totalCorrectedDur = correctedLaps.reduce((sum, l) => sum + l.durationSeconds, 0);
      const totalCorrectedEffKm = correctedLaps.reduce((sum, l) => sum + l.durationSeconds / l.paceSeconds, 0);
      if (totalCorrectedEffKm > 0 && totalCorrectedDur > 0) {
        avgPace = formatPaceFromSeconds(totalCorrectedDur / totalCorrectedEffKm);
      }
    }

    res.json({
      success: true,
      activity: {
        id: activity.id,
        name: activity.name,
        date: activity.start_date_local,
        type: correction.type || classifyType(activity, userMaxHR),
        duration: Math.round(activity.moving_time / 60),
        distance: (activity.distance / 1000).toFixed(2),
        avgPace: avgPace,
        stravaAvgPace: formatPace(activity.average_speed),
        avgHR: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
        maxHR: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
        isTreadmill: activity.type === 'VirtualRun'
      },
      laps: analysis.laps,
      intervalStats: analysis.intervalAnalysis,
      intervalSets: analysis.intervalSets || [],
      correction: correction,
      lapCorrections: lapCorrections,
      userMaxHR: userMaxHR
    });
  } catch (error) {
    console.error('활동 상세 조회 에러:', error);
    res.status(500).json({ error: '활동 상세 정보를 가져오는 중 오류가 발생했습니다.' });
  }
});

// ===== Supabase 헬퍼 함수 =====

async function getAllCorrections(athleteId, activityIds, session) {
  const corrections = {};
  
  // Supabase가 설정되어 있으면 Supabase에서 조회
  if (supabase && athleteId && activityIds.length > 0) {
    try {
      const { data, error } = await supabase
        .from('corrections')
        .select('*')
        .eq('strava_athlete_id', athleteId)
        .in('activity_id', activityIds);
      
      if (error) {
        console.error('Supabase 일괄 조회 에러:', error);
      } else if (data) {
        data.forEach(row => {
          corrections[row.activity_id] = {
            type: row.type,
            subType: row.sub_type,
            pace: row.pace,
            intervalPace: row.interval_pace,
            intervalHR: row.interval_hr,
            laps: row.laps || {}
          };
        });
      }
    } catch (err) {
      console.error('Supabase getAllCorrections 에러:', err);
    }
  }
  
  // 세션의 corrections도 병합 (Supabase 결과가 우선)
  const sessionCorrections = session.corrections || {};
  activityIds.forEach(id => {
    if (!corrections[id] && sessionCorrections[id]) {
      corrections[id] = sessionCorrections[id];
    }
  });
  
  return corrections;
}

async function getCorrection(athleteId, activityId, session) {
  // Supabase가 설정되어 있으면 Supabase에서 조회
  if (supabase && athleteId) {
    try {
      const { data, error } = await supabase
        .from('corrections')
        .select('*')
        .eq('strava_athlete_id', athleteId)
        .eq('activity_id', activityId)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        console.error('Supabase 조회 에러:', error);
      }
      
      if (data) {
        return {
          type: data.type,
          subType: data.sub_type,
          pace: data.pace,
          intervalPace: data.interval_pace,
          intervalHR: data.interval_hr,
          laps: data.laps || {}
        };
      }
    } catch (err) {
      console.error('Supabase getCorrection 에러:', err);
    }
  }
  
  // 폴백: 세션에서 조회
  return (session.corrections || {})[activityId] || {};
}

async function saveCorrection(athleteId, activityId, correctionData, session) {
  // Supabase가 설정되어 있으면 Supabase에 저장
  if (supabase && athleteId) {
    try {
      const { data, error } = await supabase
        .from('corrections')
        .upsert({
          strava_athlete_id: athleteId,
          activity_id: activityId,
          type: correctionData.type,
          sub_type: correctionData.subType,
          pace: correctionData.pace,
          interval_pace: correctionData.intervalPace,
          interval_hr: correctionData.intervalHR,
          laps: correctionData.laps || {}
        }, {
          onConflict: 'strava_athlete_id,activity_id'
        })
        .select()
        .single();
      
      if (error) {
        console.error('Supabase 저장 에러:', error);
      } else {
        console.log('Supabase 저장 성공:', activityId);
        return data;
      }
    } catch (err) {
      console.error('Supabase saveCorrection 에러:', err);
    }
  }
  
  // 폴백: 세션에 저장
  if (!session.corrections) {
    session.corrections = {};
  }
  session.corrections[activityId] = correctionData;
  return correctionData;
}

async function deleteCorrection(athleteId, activityId, session) {
  // Supabase가 설정되어 있으면 Supabase에서 삭제
  if (supabase && athleteId) {
    try {
      const { error } = await supabase
        .from('corrections')
        .delete()
        .eq('strava_athlete_id', athleteId)
        .eq('activity_id', activityId);
      
      if (error) {
        console.error('Supabase 삭제 에러:', error);
      } else {
        console.log('Supabase 삭제 성공:', activityId);
      }
    } catch (err) {
      console.error('Supabase deleteCorrection 에러:', err);
    }
  }
  
  // 세션에서도 삭제
  if (session.corrections) {
    delete session.corrections[activityId];
  }
}

// ===== 사용자 설정 헬퍼 함수 =====

async function getUserSettings(athleteId, session) {
  const defaults = { maxHR: 190, restingHR: 60 };
  
  // Supabase가 설정되어 있으면 Supabase에서 조회
  if (supabase && athleteId) {
    try {
      const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .eq('strava_athlete_id', athleteId)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        console.error('Supabase 설정 조회 에러:', error);
      }
      
      if (data) {
        return {
          maxHR: data.max_hr || defaults.maxHR,
          restingHR: data.resting_hr || defaults.restingHR
        };
      }
    } catch (err) {
      console.error('Supabase getUserSettings 에러:', err);
    }
  }
  
  // 폴백: 세션에서 조회
  return session.userSettings || defaults;
}

async function saveUserSettings(athleteId, settings, session) {
  // Supabase가 설정되어 있으면 Supabase에 저장
  if (supabase && athleteId) {
    try {
      const { data, error } = await supabase
        .from('user_settings')
        .upsert({
          strava_athlete_id: athleteId,
          max_hr: settings.maxHR,
          resting_hr: settings.restingHR
        }, {
          onConflict: 'strava_athlete_id'
        })
        .select()
        .single();
      
      if (error) {
        console.error('Supabase 설정 저장 에러:', error);
      } else {
        console.log('Supabase 설정 저장 성공');
        return data;
      }
    } catch (err) {
      console.error('Supabase saveUserSettings 에러:', err);
    }
  }
  
  // 폴백: 세션에 저장
  session.userSettings = settings;
  return settings;
}

// 사용자 설정 API
app.get('/api/settings', async (req, res) => {
  const athleteId = req.session.strava?.athlete?.id;
  console.log('[Settings GET] athleteId:', athleteId, 'supabase:', !!supabase);
  
  const settings = await getUserSettings(athleteId, req.session);
  console.log('[Settings GET] result:', settings);
  
  res.json({ success: true, settings, athleteId: athleteId, supabaseConnected: !!supabase });
});

app.post('/api/settings', async (req, res) => {
  const athleteId = req.session.strava?.athlete?.id;
  const { maxHR, restingHR } = req.body;
  
  console.log('[Settings POST] athleteId:', athleteId, 'supabase:', !!supabase);
  console.log('[Settings POST] input:', { maxHR, restingHR });
  
  if (!athleteId) {
    return res.status(401).json({ success: false, error: 'Not logged in' });
  }
  
  const settings = {
    maxHR: maxHR ? parseInt(maxHR) : 190,
    restingHR: restingHR ? parseInt(restingHR) : 60
  };
  
  const result = await saveUserSettings(athleteId, settings, req.session);
  console.log('[Settings POST] saved:', result);
  
  res.json({ success: true, settings, savedToSupabase: !!supabase });
});

// 설정 디버그 엔드포인트
app.get('/api/settings/debug', async (req, res) => {
  const athleteId = req.session.strava?.athlete?.id;
  
  let supabaseStatus = 'not configured';
  let tableExists = false;
  let savedData = null;
  
  if (supabase) {
    supabaseStatus = 'connected';
    try {
      // 테이블 존재 여부 확인
      const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .limit(1);
      
      if (error) {
        supabaseStatus = `table error: ${error.message}`;
      } else {
        tableExists = true;
        
        // 현재 사용자 데이터 조회
        if (athleteId) {
          const { data: userData, error: userError } = await supabase
            .from('user_settings')
            .select('*')
            .eq('strava_athlete_id', athleteId)
            .single();
          
          if (userError && userError.code !== 'PGRST116') {
            savedData = { error: userError.message };
          } else {
            savedData = userData || 'no data for this user';
          }
        }
      }
    } catch (err) {
      supabaseStatus = `exception: ${err.message}`;
    }
  }
  
  res.json({
    athleteId,
    supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'NOT SET',
    supabaseKey: process.env.SUPABASE_ANON_KEY ? 'SET' : 'NOT SET',
    supabaseStatus,
    tableExists,
    savedData,
    sessionSettings: req.session.userSettings || 'none'
  });
});

// 보정 데이터 저장 (분류, 페이스 등)
app.post('/api/strava/activity/:id/correction', async (req, res) => {
  const { id } = req.params;
  const { type, subType, pace, intervalPace, intervalHR } = req.body;
  const athleteId = req.session.strava?.athlete?.id;
  
  // 기존 데이터 조회
  const existing = await getCorrection(athleteId, id, req.session);
  
  // 병합
  const correctionData = {
    ...existing,
    type: type !== undefined ? type : existing.type,
    subType: subType !== undefined ? subType : existing.subType,
    pace: pace !== undefined ? pace : existing.pace,
    intervalPace: intervalPace !== undefined ? intervalPace : existing.intervalPace,
    intervalHR: intervalHR !== undefined ? (intervalHR ? parseInt(intervalHR) : null) : existing.intervalHR,
    laps: existing.laps || {}
  };
  
  await saveCorrection(athleteId, id, correctionData, req.session);
  
  res.json({ success: true, correction: correctionData });
});

app.delete('/api/strava/activity/:id/correction', async (req, res) => {
  const athleteId = req.session.strava?.athlete?.id;
  await deleteCorrection(athleteId, req.params.id, req.session);
  res.json({ success: true });
});

// 랩별 수정 API
app.post('/api/strava/activity/:id/lap/:lapNum/correction', async (req, res) => {
  const { id, lapNum } = req.params;
  const { type, pace } = req.body;
  const athleteId = req.session.strava?.athlete?.id;
  
  // 기존 데이터 조회
  const existing = await getCorrection(athleteId, id, req.session);
  
  // 랩 수정 추가
  const laps = existing.laps || {};
  laps[lapNum] = {
    type: type || null,
    pace: pace || null
  };
  
  const correctionData = {
    ...existing,
    laps: laps
  };
  
  await saveCorrection(athleteId, id, correctionData, req.session);
  
  res.json({ success: true, lapCorrection: laps[lapNum] });
});

app.delete('/api/strava/activity/:id/lap/:lapNum/correction', async (req, res) => {
  const { id, lapNum } = req.params;
  const athleteId = req.session.strava?.athlete?.id;
  
  // 기존 데이터 조회
  const existing = await getCorrection(athleteId, id, req.session);
  
  // 랩 수정 삭제
  const laps = existing.laps || {};
  delete laps[lapNum];
  
  const correctionData = {
    ...existing,
    laps: laps
  };
  
  await saveCorrection(athleteId, id, correctionData, req.session);
  
  res.json({ success: true });
});

// 모든 랩 수정 초기화
app.delete('/api/strava/activity/:id/laps/correction', async (req, res) => {
  const { id } = req.params;
  const athleteId = req.session.strava?.athlete?.id;
  
  // 기존 데이터 조회
  const existing = await getCorrection(athleteId, id, req.session);
  
  // 랩 수정만 초기화
  const correctionData = {
    ...existing,
    laps: {}
  };
  
  await saveCorrection(athleteId, id, correctionData, req.session);
  
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
    const athleteId = req.session.strava?.athlete?.id;
    
    // 사용자 설정 조회
    const userSettings = await getUserSettings(athleteId, req.session);
    const userMaxHR = userSettings.maxHR;
    
    const response = await stravaFetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=14`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    
    const activities = await response.json();
    
    // 모든 활동의 correction을 한 번에 조회
    const corrections = await getAllCorrections(athleteId, activities.map(a => a.id), req.session);
    
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
          
          // 수동 수정된 분류가 있으면 우선 사용
          const correction = corrections[a.id] || {};
          const actual = correction.type || classifyType(a, userMaxHR);
          
          // warmup-cooldown 및 race 타입은 비교에서 제외
          if (actual === 'warmup-cooldown') return;
          if (['race-hm', 'race-fm', 'race-5k', 'race-10k'].includes(actual)) return;
          
          if (recommended !== actual) {
            mismatches.push({
              date: a.start_date_local.split('T')[0],
              dayOfWeek: dayOfWeek,
              dayName: ['일', '월', '화', '수', '목', '금', '토'][dayOfWeek],
              recommended: recommended,
              actual: actual,
              activityName: a.name,
              activityId: a.id,
              userCorrected: !!correction.type
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

function analyzeLaps(laps, activity, lapCorrections = {}, userMaxHR = 190) {
  if (!laps || laps.length === 0) {
    return { laps: [], intervalAnalysis: null, intervalSets: [] };
  }
  
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
    // 사용자가 수동으로 수정한 데이터 확인
    const correction = lapCorrections[lap.lap] || {};
    
    // 페이스가 수정되었으면 적용 (type 수정 여부와 무관하게)
    let correctedPace = lap.pace;
    let correctedPaceFormatted = lap.paceFormatted;
    let correctedPaceSeconds = lap.paceSeconds;
    
    if (correction.pace) {
      correctedPace = parsePaceToSeconds(correction.pace);
      correctedPaceFormatted = correction.pace;
      correctedPaceSeconds = correctedPace;
    }
    
    // 분류가 수동으로 지정되었으면 바로 반환
    if (correction.type) {
      return {
        ...lap,
        pace: correctedPace,
        paceFormatted: correctedPaceFormatted,
        paceSeconds: correctedPaceSeconds,
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
      pace: correctedPace,
      paceFormatted: correctedPaceFormatted,
      paceSeconds: correctedPaceSeconds,
      type: lapType,
      userCorrected: !!correction.pace // 페이스만 수정해도 userCorrected
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
          totalEffectiveKm: lap.paceSeconds > 0 ? lap.durationSeconds / lap.paceSeconds : parseFloat(lap.distance),
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
        currentSet.totalEffectiveKm += lap.paceSeconds > 0 ? lap.durationSeconds / lap.paceSeconds : parseFloat(lap.distance);
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
        // 세트 통계 계산 (수정된 페이스 기반 유효 거리로 평균 페이스 계산)
        const lapCount = currentSet.laps.length;
        currentSet.avgPaceSeconds = currentSet.totalDurationSeconds / currentSet.totalEffectiveKm;
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
    currentSet.avgPaceSeconds = currentSet.totalDurationSeconds / currentSet.totalEffectiveKm;
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
    const totalEffectiveKm = intervalSets.reduce((sum, s) => sum + (s.totalEffectiveKm || parseFloat(s.totalDistance)), 0);
    const totalDurationSeconds = intervalSets.reduce((sum, s) => sum + s.totalDurationSeconds, 0);
    const avgPaceSeconds = totalDurationSeconds / totalEffectiveKm;
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
  
  const hasLapCorrections = finalLaps.some(l => l.userCorrected);
  return { laps: finalLaps, intervalAnalysis, intervalSets, hasLapCorrections };
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

function classifyType(a, userMaxHR = 190) {
  const duration = a.moving_time / 60;
  const avgHR = a.average_heartrate;
  const pace = a.average_speed ? 1000 / a.average_speed : 0; // 초/km

  const hrPercent = avgHR ? (avgHR / userMaxHR) * 100 : 0;

  // 0. 매우 짧은 활동 (15분 미만) → 워밍업/쿨다운으로 간주
  //    Sub-T 분석에서 제외됨
  if (duration < 15) {
    return 'warmup-cooldown';
  }

  // 1. Race/TT 자동 감지 (이름 키워드 + 거리 기반)
  const distKm = a.distance / 1000;
  const nameLower = (a.name || '').toLowerCase();
  const isRaceKeyword = nameLower.includes('대회') || nameLower.includes('race') ||
                        nameLower.includes('레이스') || nameLower.includes('경기');
  const isTTKeyword = nameLower.includes(' tt') || nameLower.includes('time trial') ||
                      nameLower.includes('타임트라이얼') || nameLower.includes('타임 트라이얼');

  // 풀코스 마라톤 (~42km)
  if (distKm >= 40 && distKm <= 44 &&
      (isRaceKeyword || nameLower.includes('마라톤') || nameLower.includes('marathon') || nameLower.includes('풀코스'))) {
    return 'race-fm';
  }
  // 하프마라톤 (~21km)
  if (distKm >= 19 && distKm <= 23 &&
      (isRaceKeyword || nameLower.includes('하프') || nameLower.includes('half'))) {
    return 'race-hm';
  }
  // 10K TT/레이스 (~10km)
  if (distKm >= 9 && distKm <= 11.5 && (isRaceKeyword || isTTKeyword)) {
    return 'race-10k';
  }
  // 5K TT/레이스 (~5km)
  if (distKm >= 4.5 && distKm <= 5.5 && (isRaceKeyword || isTTKeyword)) {
    return 'race-5k';
  }

  // 2. 롱런 (85분 이상)
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
