/**
 * Norwegian Singles Method - Strava API Integration
 * 
 * Strava 공식 OAuth API를 사용한 안정적인 연동
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
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${PORT}`;

// Trust proxy for Render
app.set('trust proxy', 1);

// 미들웨어
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'norwegian-singles-strava-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7일
  }
}));

// ===== Strava OAuth =====

// Strava 로그인 시작
app.get('/api/strava/auth', (req, res) => {
  if (!STRAVA_CLIENT_ID) {
    return res.status(500).json({ error: 'Strava Client ID가 설정되지 않았습니다.' });
  }
  
  const redirectUri = `${BASE_URL}/api/strava/callback`;
  const scope = 'read,activity:read_all';
  
  const authUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
  
  res.redirect(authUrl);
});

// Strava OAuth 콜백
app.get('/api/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    return res.redirect('/?error=access_denied');
  }
  
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  
  try {
    const redirectUri = `${BASE_URL}/api/strava/callback`;
    
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
    
    if (data.access_token) {
      // 세션에 저장
      req.session.strava = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: data.expires_at,
        athlete: data.athlete
      };
      
      res.redirect('/?connected=true');
    } else {
      console.error('Strava 토큰 에러:', data);
      res.redirect('/?error=token_failed');
    }
  } catch (error) {
    console.error('Strava 콜백 에러:', error);
    res.redirect('/?error=callback_failed');
  }
});

// 토큰 갱신
async function refreshStravaToken(session) {
  if (!session.strava?.refreshToken) return null;
  
  // 만료 10분 전에 갱신
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

// 로그인 상태 확인
app.get('/api/strava/status', async (req, res) => {
  if (req.session.strava?.accessToken) {
    const token = await refreshStravaToken(req.session);
    if (token) {
      res.json({ 
        loggedIn: true, 
        athlete: req.session.strava.athlete 
      });
      return;
    }
  }
  res.json({ loggedIn: false });
});

// 로그아웃
app.post('/api/strava/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===== 활동 데이터 API =====

// 활동 목록 가져오기
app.get('/api/strava/activities', async (req, res) => {
  const token = await refreshStravaToken(req.session);
  
  if (!token) {
    return res.status(401).json({ error: 'Strava에 연결해주세요.' });
  }
  
  try {
    const perPage = parseInt(req.query.limit) || 30;
    
    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Strava API 에러: ${response.status}`);
    }
    
    const activities = await response.json();
    
    // 러닝 활동만 필터링
    const runningActivities = activities.filter(a => 
      a.type === 'Run' || a.type === 'VirtualRun' || a.type === 'TrailRun'
    );
    
    // Norwegian Singles 형식으로 변환
    const formatted = runningActivities.map(a => ({
      id: a.id,
      date: a.start_date_local.split('T')[0],
      name: a.name,
      type: classifyType(a),
      subType: classifySubType(a),
      duration: Math.round(a.moving_time / 60),
      distance: (a.distance / 1000).toFixed(2),
      avgPace: formatPace(a.average_speed),
      avgHR: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      maxHR: a.max_heartrate ? Math.round(a.max_heartrate) : null,
      calories: a.calories || null,
      elevationGain: a.total_elevation_gain || null,
      isTreadmill: a.type === 'VirtualRun',
      needsPaceCorrection: a.type === 'VirtualRun',
      sufferScore: a.suffer_score || null
    }));
    
    res.json({ success: true, activities: formatted });
  } catch (error) {
    console.error('활동 조회 에러:', error);
    res.status(500).json({ error: '활동을 가져오는 중 오류가 발생했습니다.' });
  }
});

// 활동 상세 정보
app.get('/api/strava/activity/:id', async (req, res) => {
  const token = await refreshStravaToken(req.session);
  
  if (!token) {
    return res.status(401).json({ error: 'Strava에 연결해주세요.' });
  }
  
  try {
    const response = await fetch(
      `https://www.strava.com/api/v3/activities/${req.params.id}?include_all_efforts=true`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Strava API 에러: ${response.status}`);
    }
    
    const activity = await response.json();
    
    // 랩/스플릿 데이터 추출
    const splits = activity.splits_metric?.map((s, i) => ({
      lap: i + 1,
      distance: (s.distance / 1000).toFixed(2),
      pace: formatPace(s.average_speed),
      avgHR: s.average_heartrate ? Math.round(s.average_heartrate) : null,
      elevation: s.elevation_difference
    })) || [];
    
    res.json({
      success: true,
      activity: {
        ...activity,
        splits
      }
    });
  } catch (error) {
    console.error('활동 상세 조회 에러:', error);
    res.status(500).json({ error: '활동 상세 정보를 가져오는 중 오류가 발생했습니다.' });
  }
});

// ===== 헬퍼 함수 =====

function classifyType(a) {
  const duration = a.moving_time / 60;
  const avgHR = a.average_heartrate;
  const maxHR = a.max_heartrate || 190;
  const hrPercent = avgHR ? (avgHR / maxHR) * 100 : 0;
  
  // 롱런 (85분 이상)
  if (duration >= 85) return 'long';
  
  // 이지런 (HR < 72%)
  if (hrPercent > 0 && hrPercent < 72) return 'easy';
  
  // 이름으로 판단
  const name = (a.name || '').toLowerCase();
  if (name.includes('interval') || name.includes('tempo') || 
      name.includes('threshold') || name.includes('sub-t') ||
      name.includes('workout') || name.includes('quality') ||
      name.includes('인터벌') || name.includes('템포')) {
    return 'sub-t';
  }
  
  // HR 기반 판단
  if (hrPercent >= 75 && hrPercent <= 90) {
    return 'sub-t';
  }
  
  // 기본값
  if (hrPercent >= 72) return 'sub-t';
  return 'easy';
}

function classifySubType(a) {
  if (classifyType(a) !== 'sub-t') return null;
  
  const name = (a.name || '').toLowerCase();
  const duration = a.moving_time / 60;
  
  if (name.includes('1000') || name.includes('1k') || name.includes('short') || name.includes('짧은')) return 'short';
  if (name.includes('2000') || name.includes('2k') || name.includes('medium') || name.includes('중간')) return 'medium';
  if (name.includes('10min') || name.includes('long') || name.includes('cruise') || name.includes('긴')) return 'long';
  
  if (duration < 40) return 'short';
  if (duration < 55) return 'medium';
  return 'long';
}

function formatPace(speedMps) {
  if (!speedMps || speedMps === 0) return 'N/A';
  const pace = 1000 / speedMps;
  const min = Math.floor(pace / 60);
  const sec = Math.round(pace % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ===== 기본 라우트 =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== 서버 시작 =====

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     Norwegian Singles Method - Strava Integration          ║
╠════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                               ║
║  BASE_URL: ${BASE_URL}
║                                                            ║
║  Strava Client ID: ${STRAVA_CLIENT_ID ? '설정됨 ✓' : '미설정 ✗'}
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
