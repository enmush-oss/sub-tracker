# 이메일 수집 계약 (2차 작업)

기존 `docs/CONTRACT.md` 와 `src/types.ts` 를 먼저 읽어라. 여기 없는 건 전부 거기 규칙을 따른다.

## 설계 원칙

**이메일 영수증은 결국 `DetectedSeries` 로 변환해서 기존 파이프라인에 합류시킨다.**
그래야 `matchSeriesToSubs` / `analyze` 의 `unmatched_charge`(잊고 있던 구독) 로직을
CSV 와 똑같이 재사용할 수 있다. 새 진단 경로를 만들지 마라.

수집 경로는 3가지이고 전부 같은 `EmailReceipt[]` 로 수렴한다:

1. **Gmail 직접 연동** — 앱이 OAuth 로 Gmail 을 읽는다
2. **JSON 임포트** — Claude 가 훑어서 만들어준 목록을 붙여넣기/파일로 받는다
3. **메일 본문 붙여넣기** — 영수증 메일 하나를 통째로 붙여넣으면 파싱한다

## `src/types.ts` 에 추가할 타입 (이건 추가해도 된다. 기존 타입 수정은 금지)

```ts
export type ReceiptKind =
  | 'payment'         // 결제 완료 영수증
  | 'renewal_notice'  // 갱신 예정 안내
  | 'trial_ending'    // 무료체험 종료 안내
  | 'signup'          // 가입/구독 시작
  | 'cancel'          // 해지 완료
  | 'price_change'    // 요금 인상 안내
  | 'unknown'

export interface EmailReceipt {
  id: string
  source: 'gmail' | 'json' | 'paste'
  receivedAt: string          // ISO yyyy-mm-dd
  from: string                // 발신 주소
  subject: string
  kind: ReceiptKind
  service?: string            // 추론된 서비스명 (Netflix 등)
  plan?: string               // 본문에서 요금제를 찾았으면
  category?: Category
  amount?: number
  currency?: Currency
  cycle?: Cycle
  nextBillingDate?: string    // ISO
  confidence: number          // 0..1
  snippet: string             // 근거가 된 본문 일부 (최대 300자)
}

export interface GmailAuth {
  accessToken: string
  expiresAt: number           // epoch ms
  email?: string
}
```

`AppState` 에 `receipts: EmailReceipt[]` 를 추가하고 `store.ts` 의
`emptyState`/`sampleState`/`importJson` 이 이 필드를 다루게 해라 (없으면 빈 배열로 마이그레이션).

---

## `src/lib/email.ts` — 영수증 파싱

```ts
/** Gmail 검색 쿼리. 최근 12개월 구독/결제 메일. 발신자 화이트리스트 + 키워드 조합. */
export function buildGmailQuery(opts?: { months?: number }): string

/** 메일 1건 → EmailReceipt. 구독과 무관해 보이면 null.
 *  본문은 text/plain 우선, 없으면 HTML 태그 제거 후 사용. */
export function parseReceiptEmail(input: {
  id: string
  from: string
  subject: string
  date: string        // ISO 또는 RFC2822
  body: string
  source: EmailReceipt['source']
}): EmailReceipt | null

/** 금액 추출. 아래를 전부 지원:
 *  "₩17,000" "17,000원" "KRW 17,000" "$9.99" "USD 9.99" "US$9.99" "9,900 원"
 *  "월 14,900원" "연 189,000원"
 *  반환: { amount, currency } 또는 null. 여러 개면 가장 큰 값(합계/총액일 확률). */
export function extractAmount(text: string): { amount: number; currency: Currency } | null

/** 주기 추출: 월간/매월/monthly/mo/월 요금 → monthly, 연간/매년/yearly/annual/yr → yearly,
 *  분기/quarterly → quarterly, 주간/weekly → weekly. 못 찾으면 undefined. */
export function extractCycle(text: string): Cycle | undefined

/** 다음 결제일 추출: "다음 결제일 2026-10-14", "2026년 10월 14일에 갱신", "renews on Oct 14, 2026" 등. */
export function extractNextBillingDate(text: string, receivedAt: string): string | undefined

/** 메일 종류 판정. 제목 우선, 본문 보조.
 *  결제완료/영수증/receipt/invoice/payment → payment
 *  갱신예정/자동결제 예정/renews/will renew → renewal_notice
 *  체험 종료/trial ends/무료 체험이 곧 → trial_ending
 *  구독이 취소/해지되었/canceled → cancel
 *  가격 인상/price change → price_change */
export function classifyReceipt(subject: string, body: string): ReceiptKind

/** 영수증들을 서비스별로 묶어 DetectedSeries 로 변환한다.
 *  - kind 가 'cancel' 인 서비스는 시리즈에서 제외(이미 해지)
 *  - 같은 서비스의 payment 영수증이 2건 이상이면 날짜 간격으로 detect.ts 와 같은 규칙으로 주기 판정
 *  - 1건뿐이어도 메일 본문에 주기가 명시돼 있으면 시리즈로 만든다 (confidence 0.6)
 *  - key 는 normalizeMerchant(service)
 *  - occurrences 는 EmailReceipt 를 Txn 형태로 변환해 채운다 (merchantRaw = service) */
export function receiptsToSeries(receipts: EmailReceipt[], today?: string): DetectedSeries[]

/** Claude 가 만들어준 JSON 을 읽는다. 배열이거나 { receipts: [...] } 형태 둘 다 허용.
 *  각 항목을 검증하고 빠진 필드는 채운다. 잘못된 항목은 조용히 버린다. */
export function parseReceiptsJson(text: string): EmailReceipt[]

/** 구독 메일을 보내는 알려진 발신자 → 서비스/카테고리. 최소 40개.
 *  normalize.ts 의 KNOWN_SERVICES 와 중복되지 않게, 여기선 "발신 도메인" 기준으로 만든다. */
export const RECEIPT_SENDERS: { domain: string; service: string; category: Category }[]
```

`RECEIPT_SENDERS` 에 넣을 도메인 예:
`netflix.com`, `spotify.com`, `youtube.com`, `google.com`(Google One/Workspace),
`apple.com`(App Store 영수증), `openai.com`, `anthropic.com`, `adobe.com`,
`github.com`, `jetbrains.com`, `notion.so`, `figma.com`, `slack.com`, `zoom.us`,
`dropbox.com`, `microsoft.com`, `coupang.com`, `navercorp.com`, `naver.com`,
`tving.com`, `wavve.co.kr`, `watcha.com`, `melon.com`, `genie.co.kr`,
`ridibooks.com`, `millie.co.kr`, `class101.net`, `inflearn.com`,
`disneyplus.com`, `amazon.com`, `paypal.com`, `stripe.com`, `toss.im`, `kakaopay.com`

## `src/lib/gmail.ts` — Gmail 연동

브라우저에서 서버 없이 동작해야 한다. Google Identity Services(GIS) 토큰 클라이언트를 쓴다.
스코프는 **`https://www.googleapis.com/auth/gmail.readonly` 하나만**. 절대 쓰기 스코프를 넣지 마라.

```ts
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** localStorage 에서 클라이언트 ID 를 읽는다. 설정 탭에서 사용자가 넣는다. */
export function getClientId(): string | null
export function setClientId(id: string): void

/** GIS 스크립트를 동적으로 로드한다 (https://accounts.google.com/gsi/client). 이미 있으면 즉시 resolve. */
export function loadGis(): Promise<void>

/** 토큰 요청. 팝업이 뜬다. 사용자가 거부하면 reject. */
export function requestToken(clientId: string): Promise<GmailAuth>

/** 저장된 토큰. 만료됐으면 null. sessionStorage 에 둔다(브라우저 닫으면 사라지게). */
export function getStoredAuth(): GmailAuth | null
export function storeAuth(a: GmailAuth | null): void

/** 쿼리로 메시지 id 목록을 가져온다. 페이지네이션 처리, maxTotal 로 상한. */
export function listMessageIds(auth: GmailAuth, query: string, maxTotal?: number): Promise<string[]>

/** 메시지 본문을 가져와 파싱 가능한 형태로 만든다. base64url 디코딩, multipart 순회,
 *  text/plain 우선, 없으면 text/html 태그 제거. */
export function fetchMessage(auth: GmailAuth, id: string): Promise<{
  id: string; from: string; subject: string; date: string; body: string
}>

/** 전체 수집 파이프라인. onProgress 로 진행률을 UI 에 흘린다. */
export function collectReceipts(
  auth: GmailAuth,
  opts: { months: number; maxMessages?: number; onProgress?: (done: number, total: number) => void },
): Promise<EmailReceipt[]>
```

주의:
- 요청은 반드시 순차/소량 배치로. 한 번에 수백 개를 병렬로 던지면 429 가 난다. 동시 5개 이하.
- 429/5xx 는 지수 백오프로 3회까지 재시도.
- 토큰은 sessionStorage 에만. localStorage 에 저장하지 마라.
- 실패해도 앱이 죽지 않게 전부 try/catch.

## `src/components/EmailImport.tsx` — 이메일 탭

3개 섹션을 한 화면에:

1. **Gmail 연동**
   - 클라이언트 ID 가 없으면: 입력칸 + 발급 방법 3줄 안내 (Google Cloud Console → OAuth 클라이언트 ID(웹) → 승인된 JS 원본에 `http://localhost:5273` 추가)
   - 있으면: [Gmail 에서 구독 찾기] 버튼, 진행률 표시, 결과 요약
   - 읽기 전용 권한만 쓴다는 문구를 눈에 띄게

2. **Claude 결과 붙여넣기** — textarea + [불러오기]. `.json` 파일 드롭도 지원.

3. **메일 본문 붙여넣기** — 영수증 메일 하나를 붙여넣으면 파싱해서 미리보기

수집된 `EmailReceipt` 는 `receiptsToSeries` 로 변환한 뒤,
기존 `matchSeriesToSubs` 로 등록부와 대조하고 `state.series` 에 **병합**한다
(CSV 로 만든 시리즈를 지우지 말고 key 기준으로 합친다. 같은 key 면 occurrences 를 합치고 재계산).

결과 목록은 `ImportWizard` 와 같은 모양으로: 미등록은 `잊고 있던 구독?` 배지 + [등록] [무시].

## `src/App.tsx`

탭에 `이메일` 을 `명세서` 다음에 추가한다. 나머지 구조는 건드리지 마라.
`ErrorBoundary` 로 이미 감싸져 있으니 그대로 둔다.

## 하지 말 것

- 외부 라이브러리 추가 금지 (GIS 스크립트만 예외, 동적 로드)
- 메일 본문을 localStorage 에 통째로 저장 금지. `snippet` 300자까지만.
- 쓰기 권한 스코프 금지.
