# 구현 계약 (모든 모듈이 이 시그니처를 따른다)

기준 타입은 전부 `src/types.ts`. 새 타입을 만들지 말고 거기 있는 걸 쓴다.
파일마다 담당자가 정해져 있으니 **자기 담당 파일 외에는 절대 생성/수정하지 않는다.**
`src/types.ts` 는 수정 금지 (부족한 점이 있으면 보고만 한다).

---

## A담당 — 파싱 & 탐지

### `src/lib/normalize.ts`

```ts
/** "(주)넷플릭스서비시스코리아 12345" -> "넷플릭스서비시스코리아" 처럼
 *  소문자화, 공백/특수문자/지점코드/(주)/㈜/승인번호 꼬리 제거. */
export function normalizeMerchant(raw: string): string

/** 정규화된 가맹점명에서 알려진 서비스명을 찾는다. 못 찾으면 undefined. */
export function guessServiceName(merchantNorm: string): string | undefined

/** 못 찾으면 'other'. */
export function guessCategory(merchantNorm: string): Category

export interface KnownService {
  service: string          // 표시용 정식명 "Netflix"
  category: Category
  match: string[]          // merchantNorm 에 포함되면 매칭되는 조각들(소문자)
  cancelUrl?: string
}

/** 최소 60개 이상. 한국 카드 명세서에 실제로 찍히는 표기를 포함할 것. */
export const KNOWN_SERVICES: KnownService[]
```

`KNOWN_SERVICES` 에 반드시 포함할 계열(각각 한/영 표기 모두):
netflix·넷플릭스, youtube premium·google\*youtube, spotify·스포티파이, 티빙·tving,
웨이브·wavve, 왓챠·watcha, 디즈니·disney, 쿠팡플레이, 라프텔, 애플tv·apple tv,
멜론·melon, 지니·genie, 플로·flo, 벅스·bugs, 애플뮤직·apple music,
openai·chatgpt, anthropic·claude, google gemini, perplexity, midjourney, cursor, github copilot,
google one·google storage, icloud·apple.com/bill, dropbox, 네이버 mybox, onedrive,
notion, todoist, microsoft 365·office365, slack, zoom, evernote,
github, jetbrains, vercel, netlify, aws, figma, adobe, canva,
쿠팡 와우·coupang wow, 네이버플러스·naver plus, 아마존 프라임·amazon prime, 마켓컬리,
xbox game pass, playstation plus, nintendo switch online, 스팀,
밀리의서재, 리디·ridi, 윌라, 클래스101, 인프런, coursera, udemy, 링크드인,
nordvpn, expressvpn, 1password, bitwarden, 알약, v3,
헬스장·피트니스, 클래스패스

### `src/lib/csv.ts`

```ts
/** File 을 읽어 인코딩 자동 판별(utf-8 BOM / utf-8 / euc-kr(cp949)) 후 파싱.
 *  한국 카드사 CSV 는 대부분 euc-kr 이므로 반드시 TextDecoder('euc-kr') 폴백을 넣을 것.
 *  판별법: utf-8 로 fatal 디코딩 시도 -> 실패하면 euc-kr 로 재시도.
 *  euc-kr 도 실패하면 utf-8 관대 모드. */
export async function readCsvFile(file: File): Promise<ParsedCsv>

/** 구분자(, ; tab |) 자동 추정, 따옴표 이스케이프 처리, 앞쪽 안내문 줄 스킵.
 *  한국 카드사 CSV 는 상단에 "OO카드 이용대금명세서" 같은 잡줄이 1~5줄 있다.
 *  컬럼 수가 가장 많고 그 아래로 일관되게 이어지는 줄을 헤더로 잡는다. */
export function parseCsvText(text: string): { headers: string[]; rows: Record<string,string>[]; delimiter: string }

/** 헤더명으로 매핑 추측. 한국어 헤더 필수 지원:
 *  날짜: 이용일, 이용일자, 거래일, 거래일자, 승인일, 승인일자, 결제일, date
 *  가맹점: 가맹점, 가맹점명, 이용하신곳, 내용, 적요, 상호, merchant, description
 *  금액: 이용금액, 승인금액, 결제금액, 출금액, 거래금액, 금액, amount
 *  카드: 카드, 카드명, 카드번호, 결제수단 */
export function suggestMapping(headers: string[]): Partial<ColumnMapping>

/** "2025.03.14", "2025-03-14", "25/03/14", "2025년 3월 14일", "20250314",
 *  "2025.03.14 13:22" 지원. 실패시 null. 2자리 연도는 2000년대로 본다. */
export function parseKoreanDate(s: string): string | null

/** "12,900", "12,900원", "-12,900", "(12,900)", "12900.00" 지원. 실패시 null.
 *  음수/괄호는 절대값 지출로 본다. */
export function parseAmount(s: string): number | null

export function rowsToTxns(
  rows: Record<string,string>[],
  mapping: ColumnMapping,
  opts: { sourceFile?: string; defaultCurrency: Currency },
): Txn[]
```

`rowsToTxns` 는 날짜/금액 파싱 실패 행과 금액 0 이하 행을 버린다.

### `src/lib/detect.ts`

```ts
/** merchantNorm 으로 묶어서 정기결제 시리즈를 만든다.
 *  규칙:
 *   - 최소 minOccurrences(기본 2)회 이상
 *   - 간격 중앙값이 아래 창 안에 들면 해당 주기로 본다
 *       주간 5~9 / 월간 26~35 / 분기 80~100 / 반기 170~195 / 연간 350~380 (일)
 *       그 외는 custom + inferredCycleDays = 간격 중앙값
 *   - confidence(0~1): 결제횟수가 많을수록, 금액편차가 작을수록, 간격편차가 작을수록 높다.
 *     동일금액 3회 이상 월간이면 0.9 이상이 나와야 한다.
 *     간격 표준편차가 중앙값의 35% 를 넘으면 0.5 미만.
 *   - amountSpread = (max-min)/median
 *   - nextExpected = lastSeen + inferredCycleDays
 *   - stale = today > lastSeen + inferredCycleDays * 1.5
 *  confidence 내림차순 정렬해서 반환. */
export function detectSeries(txns: Txn[], opts?: { minOccurrences?: number; today?: string }): DetectedSeries[]

/** sub.merchantPatterns 중 하나가 series.key 에 포함되면 matchedSubscriptionId 를 채운다.
 *  패턴이 비어있으면 sub.service 를 normalizeMerchant 한 값으로도 시도. 새 배열 반환. */
export function matchSeriesToSubs(series: DetectedSeries[], subs: Subscription[]): DetectedSeries[]

/** 한 방 등록용 초안. service/category 는 normalize.ts 로 추론.
 *  plan 은 빈 문자열, status 'active', merchantPatterns 는 [series.key],
 *  nextBillingDate 는 series.nextExpected. */
export function seriesToSubscriptionDraft(s: DetectedSeries): Omit<Subscription,'id'|'createdAt'|'updatedAt'>
```

---

## B담당 — 계산 & 진단 & 저장

### `src/lib/money.ts`

```ts
export function cycleToDays(cycle: Cycle, cycleDays?: number): number      // weekly 7, monthly 30.4375, yearly 365.25
export function cycleToMonths(cycle: Cycle, cycleDays?: number): number    // monthly 1, quarterly 3, yearly 12
export function toBase(amount: number, currency: Currency, settings: Settings): number
export function monthlyBase(sub: Subscription, settings: Settings): number
export function yearlyBase(sub: Subscription, settings: Settings): number
/** KRW 는 소수점 없이 "12,900원", 그 외는 "$9.99" 형태. */
export function formatMoney(amount: number, currency: Currency): string
/** 다음 결제일 1회 전진. 월말 처리 주의: 1/31 + 월간 = 2/28(윤년 2/29). */
export function advanceBillingDate(dateIso: string, cycle: Cycle, cycleDays?: number): string
/** 오늘 기준 남은 일수. 과거면 음수. */
export function daysUntil(iso: string, today?: string): number
/** status 가 'active' | 'trial' 인 것만 합산.
 *  upcoming 은 nextBillingDate 가 오늘~+settings.upcomingWindowDays 인 것, 날짜 오름차순. */
export function computeTotals(subs: Subscription[], settings: Settings, today?: string): Totals
```

### `src/lib/analyze.ts`

```ts
/** 기능이 겹치는 서비스 묶음. 카테고리가 달라도 잡아내기 위한 것.
 *  예: YouTube Premium 은 category 가 video 지만 음악 그룹에도 들어간다.
 *  최소 6개 그룹: 음악 / 영상 / AI채팅 / 클라우드저장소 / 오피스생산성 / 이커머스멤버십 */
export const FEATURE_OVERLAP_GROUPS: { id: string; label: string; services: string[]; note: string }[]

/** 아래 Finding 을 전부 생성. monthlySaving 은 기준통화 월 환산.
 *  - category_overlap: 같은 category 의 active 구독 2개 이상.
 *    가장 비싼 것 1개는 남긴다고 보고, 나머지 중 제일 싼 1개 금액을 절약 후보로(보수적).
 *  - feature_overlap: FEATURE_OVERLAP_GROUPS 에서 2개 이상 매칭
 *  - unmatched_charge: series 중 matchedSubscriptionId 없고 stale 이 아니고
 *    confidence >= 0.6 이고 ignoredSeriesKeys 에 없는 것 -> severity 'high'
 *    (이게 사용자가 "잊고 있던 구독")
 *  - zombie: lastUsedAt 이 settings.zombieAfterDays 보다 오래됨 (lastUsedAt 없으면 제외)
 *  - stale_series: matched 인데 series.stale -> 등록부 정리 필요, saving 0
 *  - trial_ending: status 'trial' 이고 trialEndsAt 이 7일 이내
 *  - annual_saving: cycle 'monthly' 이고 tags 에 'annual-available' 포함 -> 15% 절약 가정
 *  - duplicate_plan: 같은 service 의 active 구독이 2건 이상
 *  severity high -> medium -> low, 그 안에서 monthlySaving 내림차순 정렬. */
export function analyze(state: AppState, today?: string): Finding[]
```

### `src/lib/store.ts`

```ts
export const STORAGE_KEY = 'sub-tracker:v1'
/** baseCurrency 'KRW', fxRates {KRW:1, USD:1380, EUR:1500, JPY:9.2, GBP:1750},
 *  zombieAfterDays 60, upcomingWindowDays 14 */
export const DEFAULT_SETTINGS: Settings
/** localStorage 접근은 전부 try/catch. 실패하면 빈 상태를 돌려준다(절대 throw 금지). */
export function loadState(): AppState
export function saveState(s: AppState): void
export function exportJson(s: AppState): string          // pretty JSON
export function importJson(text: string): AppState       // 검증 후 반환, 잘못되면 throw
export function uid(): string                            // crypto.randomUUID 폴백 포함
export function emptyState(): AppState
/** 데모용 샘플 구독 6건(넷플릭스/유튜브프리미엄/ChatGPT/쿠팡와우/Google One/피트니스).
 *  "샘플 넣기" 버튼용. 그중 하나는 status 'trial', 하나는 lastUsedAt 이 90일 전. */
export function sampleState(): AppState
```

---

## C담당 — UI

라우팅 없이 App.tsx 안에서 탭 상태로 5개 화면 전환:
`대시보드 / 구독 / 명세서 / 점검 / 설정`

- `src/styles.css` — CSS 변수 기반 디자인 토큰, 라이트+다크 둘 다. 한글 폰트 스택 필수:
  `-apple-system, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif`
- `src/main.tsx` — createRoot, `./styles.css` import
- `src/App.tsx` — AppState 를 useState 로 들고, 변경 시마다 saveState. 탭 전환.
- `src/components/Dashboard.tsx` — KPI 4개(월 합계 / 연 환산 / 활성 구독 수 / 절약 가능액),
  카테고리별 가로 막대, 다가오는 결제 타임라인, 결제수단별 분해
- `src/components/SubscriptionList.tsx` — 정렬(금액/다음결제일/이름), 카테고리·상태 필터,
  검색, 추가/수정/삭제. 카드형 그리드.
- `src/components/SubscriptionForm.tsx` — 등록/수정 모달 폼. plan(요금제) 필드를 눈에 띄게.
- `src/components/ImportWizard.tsx` — 3스텝: (1)파일 드롭 (2)컬럼 매핑 확인 + 미리보기 5줄
  (3)탐지 결과. 미등록 시리즈는 "잊고 있던 구독?" 배지 + [등록] [무시] 버튼.
- `src/components/Findings.tsx` — analyze() 결과를 severity 별 카드로. 절약 가능액 합계를 상단에.
- `src/components/SettingsPanel.tsx` — 환율 편집, 좀비 기준일수, JSON 내보내기/가져오기, 전체 초기화.

규칙:
- 외부 UI/차트 라이브러리 금지. 차트는 인라인 SVG 로 직접 그린다.
- 모든 사용자 노출 텍스트는 한국어.
- 금액 표시는 반드시 `formatMoney` 사용.
- 반응형: 모바일 1열, 데스크톱 다열. 가로 스크롤 발생 금지.
