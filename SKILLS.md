# Norwegian Singles Method - 훈련 방법론

## 개요

Norwegian Singles Method는 sirpoc (James Copeland)이 개발하고 LetsRun 포럼에서 대중화된 Sub-threshold 훈련법입니다.

핵심 원리: **"고강도를 피하면서 질 높은 훈련량 확보"**

---

## 핵심 개념: Sub-Threshold (Sub-T)

### 정의
젖산 역치(LT2) 바로 아래에서 수행하는 인터벌 훈련

| 항목 | 값 |
|------|-----|
| **젖산 농도** | 2-4 mmol/L |
| **RPE** | 5-6/10 ("Comfortably Hard") |
| **HR 존** | 82-88% MaxHR (Karvonen 공식) |
| **페이스** | 하프마라톤 페이스 기준 |

### 핵심 원칙
> "마지막 인터벌도 첫 번째처럼 유지할 수 있어야 한다"

- 너무 빠르면 Sub-T가 아님
- 충분히 회복하면서 볼륨 쌓기
- 일관성 > 단발성 고강도

---

## 페이스 계산

하프마라톤(HM) 페이스를 기준으로 계산합니다.

### Sub-T 페이스
| 인터벌 유형 | 계수 | 설명 |
|------------|------|------|
| 짧은 (1000m) | HM × 0.97 | 약간 빠르게 |
| 중간 (2000m) | HM × 1.00 | HM 페이스 |
| 긴 (10분) | HM × 1.03 | 약간 느리게 |

### Easy 페이스
```
Easy = HM × 1.35
```

### 예시 (HM 페이스 5:00/km)
| 유형 | 계산 | 페이스 |
|------|------|--------|
| Sub-T 짧은 | 5:00 × 0.97 | 4:51/km |
| Sub-T 중간 | 5:00 × 1.00 | 5:00/km |
| Sub-T 긴 | 5:00 × 1.03 | 5:09/km |
| Easy | 5:00 × 1.35 | 6:45/km |

---

## 인터벌 구조

### 짧은 인터벌
```
6 × 1000m @ Sub-T (짧은)
휴식: 60초 조깅
```
- 총 거리: 6km
- 목적: 스피드 유지하면서 볼륨

### 중간 인터벌
```
4 × 2000m @ Sub-T (중간)
휴식: 75초 조깅
```
- 총 거리: 8km
- 목적: 밸런스

### 긴 인터벌
```
3 × 10분 @ Sub-T (긴)
휴식: 90초 조깅
```
- 총 시간: 30분
- 목적: 지구력 + 멘탈

---

## 주간 구조

### 기본 패턴
| 요일 | 훈련 유형 | 설명 |
|------|----------|------|
| 일 | Long Run | 90-120분 |
| 월 | Easy | 회복 |
| 화 | **Sub-T 짧은** | 6×1000m |
| 수 | Easy | 회복 |
| 목 | **Sub-T 중간** | 4×2000m |
| 금 | Easy | 회복 |
| 토 | **Sub-T 긴** | 3×10분 |

### 핵심 규칙
1. **Sub-T 세션**: 주 2-3회
2. **Easy Run**: HR < 70% MaxHR
3. **Long Run**: 주 1회 (90-120분)
4. **고강도 후**: 반드시 Easy Day
5. **Quality Volume**: 총 러닝 시간의 20-25%

---

## HR 존 계산 (Karvonen 공식)

단순 %MaxHR보다 정확한 Karvonen 공식 사용:

```
HR Reserve = MaxHR - RestingHR
Target HR = RestingHR + (HR Reserve × intensity%)
```

### 예시 (MaxHR=190, RestingHR=50)
```
HR Reserve = 190 - 50 = 140

Easy (70%):
  50 + (140 × 0.70) = 148 bpm

Sub-T Low (82%):
  50 + (140 × 0.82) = 165 bpm

Sub-T High (88%):
  50 + (140 × 0.88) = 173 bpm
```

### HR 존 요약
| 존 | 강도 | 용도 |
|----|------|------|
| < 70% | Easy | 회복, 기본 유산소 |
| 70-80% | Moderate | 롱런 |
| **82-88%** | **Sub-T** | **핵심 훈련** |
| > 90% | VO2max | (이 방법론에서 거의 안 함) |

---

## 운동 분류 로직 (앱 구현)

### 자동 분류 우선순위

```javascript
function classifyType(activity, userMaxHR) {
  // 1. 시간 기반
  if (duration < 15분) return 'warmup-cooldown';
  if (duration >= 85분) return 'long';
  
  // 2. HR 기반 Easy 판단
  if (avgHR < 145) return 'easy';
  if (hrPercent < 72%) return 'easy';
  if (hrPercent < 75% && pace > 5:30/km) return 'easy';
  
  // 3. 이름 키워드 + HR 검증
  if (hasSubTKeywords && hrPercent >= 75%) return 'sub-t';
  
  // 4. HR 기반 Sub-T
  if (hrPercent 78-90%) return 'sub-t';
  
  // 5. 기본값
  return 'easy';
}
```

### 인터벌 랩 감지

```javascript
// 페이스 패턴 기반 (HR은 보조)
1. 작업 랩 식별: 거리 ≥ 0.5km, 페이스 ≤ 6:00/km
2. 빠른 페이스 임계값: 작업 랩 중간값 × 1.1
3. 인터벌 판정: 빠른 페이스 + 거리 ≥ 0.5km
4. 휴식 판정: 거리 < 0.1km 또는 페이스 > 8:00/km
5. 연속 인터벌 병합: 세트로 합산
```

---

## Quality Volume 계산

```
Quality Volume % = (Sub-T 세션 시간 × 0.6) / 총 주간 러닝 시간 × 100

목표: 20-25%
```

### 예시
- 주간 총 러닝: 6시간 (360분)
- Sub-T 3세션 × 60분 = 180분
- Quality = (180 × 0.6) / 360 = 30% (약간 높음)

---

## 트레드밀 보정

트레드밀은 GPS가 없어 페이스가 부정확합니다.

### 감지 방법
```javascript
const isTreadmill = 
  activity.type === 'VirtualRun' ||
  name.includes('트레드밀') ||
  name.includes('treadmill') ||
  name.includes('러닝머신');
```

### 수동 보정 항목
1. **전체 평균 페이스**: 트레드밀 표시 페이스
2. **인터벌 구간 페이스**: 실제 인터벌 페이스
3. **인터벌 평균 HR**: 인터벌 중 HR

---

## 예상 레이스 타임 (Riegel 공식)

```
T2 = T1 × (D2 / D1)^1.06
```

Sub-T 평균 페이스에서 하프마라톤 페이스를 추정하고, 이를 기반으로 각 거리 예상 시간 계산.

### 예시 (Sub-T 평균 5:00/km)
| 거리 | 예상 시간 |
|------|----------|
| 5K | 24:15 |
| 10K | 50:00 |
| Half | 1:49:30 |
| Full | 3:50:00 |

---

## 훈련 조정 가이드

### 피로 시
- Sub-T 세션 스킵 → Easy로 대체
- 인터벌 수 줄이기 (6×1000m → 4×1000m)
- 휴식 시간 늘리기

### 컨디션 좋을 때
- 페이스 올리지 말 것! (Sub-T 원칙 유지)
- 대신 볼륨 약간 증가 가능

### 레이스 전
- 레이스 1주 전: Sub-T 1회만
- 레이스 3일 전: Easy only
- 테이퍼링 중에도 Sub-T 강도는 유지 (볼륨만 감소)

---

## 참고 자료

- **LetsRun 포럼**: sirpoc 원본 글
- **Reddit**: r/NorwegianSinglesRun
- **LacTrace 계산기**: https://lactate.duckdns.org/
- **Norwegian Method 비교**: Ingebrigtsen 형제 훈련법과의 차이점

---

## 앱에서 사용하는 상수

```javascript
// 페이스 계수
PACE_MULTIPLIER = {
  'sub-t-short': 0.97,
  'sub-t-medium': 1.00,
  'sub-t-long': 1.03,
  'easy': 1.35
};

// 인터벌 구조
INTERVAL_STRUCTURE = {
  'short': { reps: 6, distance: 1000, rest: 60 },
  'medium': { reps: 4, distance: 2000, rest: 75 },
  'long': { reps: 3, duration: 600, rest: 90 }
};

// HR 존 (Karvonen)
HR_ZONES = {
  'easy': { max: 0.70 },
  'sub-t': { min: 0.82, max: 0.88 }
};

// 주간 패턴
WEEKLY_PATTERN = {
  0: 'long',    // 일요일
  1: 'easy',
  2: 'sub-t',   // 짧은
  3: 'easy',
  4: 'sub-t',   // 중간
  5: 'easy',
  6: 'sub-t'    // 긴
};
```
