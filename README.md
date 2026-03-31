# 🇳🇴 Norwegian Singles Method - Strava 연동

Strava 공식 API를 사용한 Norwegian Singles Method 훈련 관리 앱입니다.

---

## 📋 배포 전 필수 작업: Strava API 앱 등록

Strava 연동을 위해서는 **먼저 Strava에서 API 앱을 등록**해야 합니다.
이 과정은 **무료**이며, 5분 정도 소요됩니다.

### STEP 1: Strava API 설정 페이지 접속

1. 브라우저에서 열기: https://www.strava.com/settings/api
2. Strava 로그인 (이미 로그인 되어있으면 바로 설정 페이지로 이동)

### STEP 2: API 앱 등록하기

설정 페이지에서 아래 정보를 입력하세요:

| 항목 | 입력값 |
|------|--------|
| **Application Name** | `Norwegian Singles` |
| **Category** | `Training` 선택 |
| **Club** | 비워두기 |
| **Website** | `https://example.com` (아무거나 OK) |
| **Application Description** | `Sub-threshold training tracker` |
| **Authorization Callback Domain** | ⚠️ **중요!** 아래 참고 |

#### Authorization Callback Domain 입력값:

- **Render 사용시**: `norwegian-singles-strava.onrender.com`
  - (나중에 실제 Render 주소로 변경해야 할 수 있음)
- **로컬 테스트시**: `localhost`

### STEP 3: Client ID와 Client Secret 복사

앱 등록이 완료되면 페이지에 다음 정보가 표시됩니다:

```
Client ID: 12345 (숫자)
Client Secret: abcdef1234567890... (긴 문자열)
```

**이 두 값을 메모장에 복사해 두세요!** 
나중에 Render에 입력해야 합니다.

---

## 🚀 Render 배포 가이드

### STEP 1: GitHub에 코드 올리기

1. GitHub 로그인: https://github.com
2. **New repository** 클릭
3. Repository name: `norwegian-singles-strava`
4. **Public** 선택
5. **Create repository** 클릭
6. **uploading an existing file** 클릭
7. 이 폴더의 모든 파일을 드래그해서 업로드:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `public/` 폴더
8. **Commit changes** 클릭

### STEP 2: Render에서 배포하기

1. Render 접속: https://render.com
2. **GitHub으로 로그인**
3. **New +** → **Web Service** 클릭
4. **Build and deploy from a Git repository** → **Next**
5. `norwegian-singles-strava` 저장소 선택 → **Connect**

### STEP 3: 서비스 설정

| 항목 | 입력값 |
|------|--------|
| **Name** | `norwegian-singles-strava` |
| **Region** | `Singapore (Southeast Asia)` |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** 선택 |

### STEP 4: 환경 변수 설정 ⚠️ 중요!

스크롤을 내려 **Environment Variables** 섹션에서:

**Add Environment Variable** 을 3번 클릭해서 추가:

| Key | Value |
|-----|-------|
| `SESSION_SECRET` | `mynorwegiansecret123` (아무 문자열) |
| `STRAVA_CLIENT_ID` | Strava에서 복사한 Client ID (숫자) |
| `STRAVA_CLIENT_SECRET` | Strava에서 복사한 Client Secret |

### STEP 5: 배포 시작

1. **Create Web Service** 클릭
2. 3-5분 기다리기
3. 배포 완료되면 주소 확인 (예: `https://norwegian-singles-strava.onrender.com`)

---

## ⚠️ Strava Callback URL 업데이트

배포 후 Render 주소가 확정되면:

1. https://www.strava.com/settings/api 다시 접속
2. **Authorization Callback Domain** 수정
3. Render 주소에서 `https://` 제외하고 입력
   - 예: `norwegian-singles-strava.onrender.com`
4. **Update** 클릭

---

## 🔗 Garmin → Strava 동기화 설정

Garmin 데이터를 Strava에서 보려면 동기화를 설정해야 합니다:

1. Strava 앱 또는 웹에서 로그인
2. **설정** → **연결된 앱** 또는 **Link Other Services**
3. **Garmin** 찾아서 **연결** 클릭
4. Garmin 로그인
5. 완료! 이후 Garmin 운동이 자동으로 Strava에 동기화됩니다.

---

## 📱 스마트폰 홈 화면에 추가

### iPhone (Safari)
1. Safari에서 Render 주소 열기
2. 하단 공유 버튼 (□↑) 탭
3. "홈 화면에 추가" 선택

### Android (Chrome)
1. Chrome에서 Render 주소 열기
2. 점 3개 메뉴 (⋮) 탭
3. "홈 화면에 추가" 선택

---

## ❓ 문제 해결

| 문제 | 해결 방법 |
|------|----------|
| Strava 연결 버튼 클릭 시 에러 | 환경 변수 STRAVA_CLIENT_ID 확인 |
| "redirect_uri mismatch" 에러 | Strava API 설정에서 Callback Domain 수정 |
| 데이터가 안 불러와짐 | Garmin → Strava 동기화 설정 확인 |
| 무한 로딩 | Render 로그 확인 (Logs 탭) |
| 연결은 되는데 로그인 상태 유지 안됨 | 아래 디버깅 가이드 참고 |

### 🔧 연결 문제 디버깅

연결이 안 될 때 다음 순서로 확인하세요:

#### 1. 디버그 엔드포인트 확인
브라우저에서 `https://YOUR-RENDER-URL/api/debug` 접속

확인해야 할 값:
- `hasStravaId`: true여야 함
- `hasStravaSecret`: true여야 함
- `baseUrl`: Render URL이어야 함 (localhost가 아님!)
- `isProduction`: true여야 함

#### 2. Render 로그 확인
Render 대시보드 → 해당 서비스 → **Logs** 탭

로그인 시도 시 다음 로그가 보여야 함:
```
[Auth] Starting Strava OAuth...
[Auth] BASE_URL: https://your-app.onrender.com
[Callback] Received callback
[Callback] Token response status: 200
[Callback] Session saved successfully
```

#### 3. Strava Callback Domain 확인
https://www.strava.com/settings/api 에서:
- Authorization Callback Domain이 Render URL과 일치하는지 확인
- `https://` 없이 도메인만 입력 (예: `norwegian-singles-strava.onrender.com`)

#### 4. 환경 변수 재확인
Render 대시보드 → Environment 탭에서:
- `STRAVA_CLIENT_ID`: 숫자만 입력 (따옴표 없이)
- `STRAVA_CLIENT_SECRET`: 전체 문자열 복사 (앞뒤 공백 없이)
- `SESSION_SECRET`: 아무 문자열
- `NODE_ENV`: `production`

---

## 📁 파일 구조

```
norwegian-singles-strava/
├── server.js          # Strava OAuth 서버
├── package.json       # Node.js 설정
├── render.yaml        # Render 배포 설정
├── README.md          # 이 파일
└── public/
    └── index.html     # 프론트엔드 앱
```
