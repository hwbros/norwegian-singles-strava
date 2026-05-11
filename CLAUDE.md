# Norwegian Singles Method Training App

## 프로젝트 개요

Strava와 연동하여 Norwegian Singles Method 훈련을 관리하고 분석하는 웹 앱입니다.

- **배포 URL**: https://norwegian-singles-strava.onrender.com
- **GitHub**: (사용자 저장소)
- **호스팅**: Render (무료 플랜)
- **데이터베이스**: Supabase (PostgreSQL)

---

## 기술 스택

| 구분 | 기술 |
|------|------|
| Backend | Node.js + Express |
| Frontend | Vanilla JS (단일 HTML 파일) |
| Database | Supabase (PostgreSQL) |
| Auth | Strava OAuth 2.0 |
| Hosting | Render |

---

## 파일 구조

```
norwegian-singles-strava/
├── server.js              # Express 서버 + API
├── package.json           # 의존성
├── render.yaml            # Render 배포 설정
├── README.md              # 배포/설정 가이드
├── CLAUDE.md              # 이 파일
├── SKILLS.md              # 훈련 방법론 상세
└── public/
    └── index.html         # 프론트엔드 (SPA)
```

---

## 환경 변수 (Render)

| Key | 설명 |
|-----|------|
| `SESSION_SECRET` | 세션 암호화 키 |
| `STRAVA_CLIENT_ID` | Strava API Client ID |
| `STRAVA_CLIENT_SECRET` | Strava API Client Secret |
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | Supabase anon public 키 |

---

## Supabase 테이블

### corrections
사용자가 수동 수정한 운동 분류/페이스 저장

```sql
CREATE TABLE corrections (
  id SERIAL PRIMARY KEY,
  strava_athlete_id BIGINT NOT NULL,
  activity_id BIGINT NOT NULL,
  type VARCHAR(50),          -- 'sub-t', 'easy', 'long', 'warmup-cooldown'
  sub_type VARCHAR(50),      -- 'short', 'medium', 'long' (Sub-T용)
  pace VARCHAR(20),          -- 전체 평균 페이스 (예: "5:30")
  interval_pace VARCHAR(20), -- 인터벌 구간 페이스
  interval_hr INTEGER,       -- 인터벌 평균 HR
  laps JSONB DEFAULT '{}',   -- 랩별 수정 데이터
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(strava_athlete_id, activity_id)
);
```

### user_settings
사용자 개인 설정 (MaxHR, RestingHR)

```sql
CREATE TABLE user_settings (
  id SERIAL PRIMARY KEY,
  strava_athlete_id BIGINT NOT NULL UNIQUE,
  max_hr INTEGER DEFAULT 190,
  resting_hr INTEGER DEFAULT 60,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## API 엔드포인트

### 인증
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/strava/auth` | Strava OAuth 시작 |
| GET | `/api/strava/callback` | OAuth 콜백 |
| GET | `/api/strava/status` | 로그인 상태 확인 |
| POST | `/api/strava/logout` | 로그아웃 |

### 활동
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/strava/activities` | 활동 목록 (최근 30개) |
| GET | `/api/strava/activity/:id` | 활동 상세 + 랩 분석 |

### 수정
| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/strava/activity/:id/correction` | 분류/페이스 수정 저장 |
| DELETE | `/api/strava/activity/:id/correction` | 수정 초기화 |
| POST | `/api/strava/activity/:id/lap/:lapNum/correction` | 랩별 수정 |
| DELETE | `/api/strava/activity/:id/lap/:lapNum/correction` | 랩 수정 삭제 |
| DELETE | `/api/strava/activity/:id/laps/correction` | 모든 랩 수정 초기화 |

### 설정
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/settings` | 사용자 설정 조회 |
| POST | `/api/settings` | 설정 저장 (maxHR, restingHR) |
| GET | `/api/settings/debug` | 디버그 정보 |

### 분석
| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/schedule/analysis` | 주간 일정 불일치 분석 |
| GET | `/api/debug` | 서버 설정 디버그 |

---

## 핵심 함수 (server.js)

### classifyType(activity, userMaxHR)
활동을 자동 분류합니다.
- `warmup-cooldown`: 15분 미만
- `easy`: HR < 70% MaxHR 또는 < 145bpm
- `sub-t`: HR 78-90% + 인터벌 키워드
- `long`: 85분 이상

### analyzeLaps(laps, activity, lapCorrections, userMaxHR)
랩 데이터를 분석하여 인터벌/휴식 구분합니다.
- 페이스 패턴 기반 감지 (HR은 보조)
- 연속 인터벌 랩을 세트로 병합
- 랩별 수정 적용

### getUserSettings / saveUserSettings
Supabase에서 사용자 설정을 조회/저장합니다.
- Supabase 미연결 시 세션 폴백

### getCorrection / saveCorrection / getAllCorrections
활동별 수정 데이터를 Supabase에서 관리합니다.

---

## 프론트엔드 탭 구조 (index.html)

1. **대시보드** - 통계, 오늘의 추천, 주간 구조, 일정 불일치
2. **훈련 추천** - 오늘 상세 + 주간 계획 + 다음 주 미리보기
3. **운동 기록** - 활동 목록, 인터벌 분석, 수정 기능
4. **분석** - Sub-T 강도 체크, Easy HR 체크, Quality Volume
5. **계산기** - 멀티 거리 입력, 예상 레이스 타임
6. **가이드** - Norwegian Singles Method 설명

---

## 주요 설정값

```javascript
// 기본값 (사용자 설정으로 변경 가능)
userMaxHR = 190;      // 최대 심박수
userRestingHR = 60;   // 안정 심박수

// HR 존 (Karvonen 공식)
// Target HR = RestingHR + (HR Reserve × intensity%)
Easy: < 70%
Sub-T: 82-88%

// 페이스 계산 (하프마라톤 페이스 기준)
Sub-T 짧은: HM × 0.97
Sub-T 중간: HM × 1.00
Sub-T 긴: HM × 1.03
Easy: HM × 1.35
```

---

## 개발 시 주의사항

### ID 비교
Strava activity ID는 숫자/문자열 혼용 가능. `===` 대신 `==` 사용.

```javascript
// ✅ 올바른 방법
workouts.find(w => w.id == id)

// ❌ 문제 발생 가능
workouts.find(w => w.id === id)
```

### MaxHR 사용
활동의 `max_heartrate`가 아닌 사용자 설정 `userMaxHR` 사용.

```javascript
// ✅ 올바른 방법
const userMaxHR = userSettings.maxHR;
const hrPercent = avgHR / userMaxHR * 100;

// ❌ 잘못된 방법
const hrPercent = avgHR / activity.max_heartrate * 100;
```

### 세션 저장
OAuth 콜백 후 반드시 `req.session.save()` 호출.

```javascript
req.session.save((err) => {
  if (err) return res.redirect('/?error=session_failed');
  res.redirect('/?connected=true');
});
```

### Supabase 폴백
Supabase 미연결 시 세션 저장으로 폴백 (동기화 안 됨).

---

## 로컬 개발

```bash
# 의존성 설치
npm install

# 환경 변수 설정 (.env 파일 또는 export)
export STRAVA_CLIENT_ID=your_client_id
export STRAVA_CLIENT_SECRET=your_client_secret
export SESSION_SECRET=any_secret_string

# 서버 실행
npm start

# 브라우저에서 http://localhost:3000
```

---

## 배포

GitHub에 push하면 Render에서 자동 배포됩니다.

```bash
git add .
git commit -m "feat: 기능 설명"
git push origin main
```

---

## 알려진 제한사항

1. **Strava API 15명 제한**: 개발 모드 제한, 프로덕션 승인 필요
2. **Render 무료 플랜**: 15분 비활성 시 슬립, 첫 요청 느림
3. **세션 기반 토큰**: 서버 재시작 시 재로그인 필요

---

## 향후 개선 가능 항목

- [ ] 사용자 프로필 페이지
- [ ] 데이터 내보내기 (CSV)
- [ ] 계정 삭제 기능
- [ ] PWA 지원 (오프라인)
- [ ] 훈련 히스토리 그래프

---

## Agent skills

### Issue tracker

Issues live in GitHub Issues (gh CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — `CONTEXT.md` + `docs/adr/` at the root. See `docs/agents/domain.md`.
