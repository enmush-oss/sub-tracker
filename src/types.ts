// ─────────────────────────────────────────────────────────────
// 구독 트래커 — 공용 타입 계약
// 모든 lib/* 와 components/* 는 이 파일의 시그니처만 신뢰한다.
// ─────────────────────────────────────────────────────────────

export type Currency = 'KRW' | 'USD' | 'EUR' | 'JPY' | 'GBP'

/** 결제 주기. custom 은 cycleDays 로 일수 지정. */
export type Cycle =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'yearly'
  | 'custom'

/** 중복 탐지의 기준축. 같은 카테고리가 2개 이상이면 후보로 잡힌다. */
export type Category =
  | 'ott'            // 구독형 영상 스트리밍: 넷플릭스, 디즈니+, 티빙, 웨이브, 왓챠, 쿠팡플레이
  // 동영상 플랫폼: YouTube Premium 등. OTT 와 분리한다 —
  // 유튜브는 넷플릭스의 대체재가 아니라서 "둘 중 하나 정리하라"가 성립하지 않는다.
  | 'video'
  | 'music'          // 스포티파이, 유튜브뮤직, 애플뮤직, 멜론
  | 'ai'             // ChatGPT, Claude, Gemini, Perplexity
  | 'cloud'          // Google One, iCloud, Dropbox, 네이버 MYBOX
  | 'productivity'   // Notion, Todoist, MS365
  | 'dev'            // GitHub, Vercel, JetBrains, Cursor
  | 'design'         // Figma, Adobe CC, Canva
  | 'news'           // 뉴스레터, 신문, 매거진
  | 'gaming'         // Xbox Game Pass, PS Plus, 닌텐도
  | 'fitness'        // 헬스장, 요가앱, 클래스패스
  | 'education'      // 인강, 코세라, 링크드인러닝
  | 'membership'     // 쿠팡 와우, 네이버플러스, 아마존 프라임
  | 'security'       // VPN, 비밀번호관리자, 백신
  | 'communication'  // Slack, Zoom, 통신부가서비스
  | 'finance'        // 증권 유료정보, 회계 SaaS
  | 'other'

export type SubStatus = 'active' | 'trial' | 'paused' | 'canceled'

/**
 * 결제가 어느 경로로 빠져나가는지.
 * 'card' 가 아니면 카드 명세서에도, 서비스 영수증 메일에도 안 잡힌다.
 * 통신사 결합/번들로 내는 구독을 "결제 끊김"이라고 오진하지 않기 위해 필요하다.
 */
export type BillingChannel =
  | 'card'      // 카드/체크카드 — 명세서에 찍힌다
  | 'carrier'   // 통신사 결합·휴대폰 소액결제 — 통신요금에 합산돼 별도 영수증이 없다
  | 'bundle'    // 다른 상품에 끼워진 것 (제휴 멤버십 등)
  | 'giftcard'  // 기프트카드/포인트 선결제
  | 'manual'    // 계좌이체 등 직접 납부
  | 'other'

/** 등록된 구독 1건. `plan` 이 요금제(모델) 축이다. */
export interface Subscription {
  id: string
  service: string              // "Netflix"
  plan: string                 // "프리미엄 4K" — 같은 서비스의 여러 모델을 구분
  category: Category
  /**
   * 부가 카테고리. 한 구독이 여러 용도를 겸하는 경우를 위한 것.
   * 예: Google One 은 저장소(cloud)이면서 Gemini(ai)를 포함한다.
   * 중복 진단은 category + extraCategories 를 모두 본다.
   */
  extraCategories?: Category[]
  amount: number               // 결제 1회당 금액 (currency 단위)
  currency: Currency
  cycle: Cycle
  cycleDays?: number           // cycle === 'custom' 일 때만
  nextBillingDate: string      // ISO yyyy-mm-dd
  startedAt?: string           // ISO yyyy-mm-dd
  status: SubStatus
  trialEndsAt?: string         // ISO yyyy-mm-dd, status === 'trial'
  paymentMethod?: string       // "신한체크 1234"
  /** 기본 'card'. 'card' 가 아니면 명세서/메일에 안 잡히는 게 정상이다. */
  billingChannel?: BillingChannel
  /** CSV 명세서의 가맹점명을 이 구독에 붙이기 위한 매칭 키(정규화된 소문자) */
  merchantPatterns: string[]
  seats?: number               // 가족요금제 총 인원
  sharedWith?: string[]        // 나눠쓰는 사람 (분담 계산용)
  lastUsedAt?: string          // ISO yyyy-mm-dd — 미사용/좀비 구독 탐지에 사용
  cancelUrl?: string           // 해지 페이지 바로가기
  notes?: string
  tags: string[]
  createdAt: string            // ISO datetime
  updatedAt: string            // ISO datetime
}

/** 명세서 CSV 에서 파싱된 거래 1줄. */
export interface Txn {
  id: string
  date: string                 // ISO yyyy-mm-dd
  merchantRaw: string          // 원본 가맹점명
  merchantNorm: string         // 정규화 결과 (소문자, 공백/특수문자/지점번호 제거)
  amount: number               // 양수 = 지출
  currency: Currency
  card?: string                // 카드/계좌 식별자
  memo?: string
  sourceFile?: string
}

/** CSV 컬럼 → Txn 필드 매핑. 사용자가 임포트 화면에서 확정한다. */
export interface ColumnMapping {
  date: string
  merchant: string
  amount: string
  card?: string
  memo?: string
  currency?: string
}

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
  /** 파일에서 감지한 인코딩 (euc-kr/cp949 한국 카드사 CSV 대응) */
  encoding: string
  delimiter: string
  /** 헤더 이름으로 추측한 매핑 초안. 확신 없으면 필드가 비어있다. */
  suggested: Partial<ColumnMapping>
  /** 사용자에게 보여줄 형식 표시. "엑셀 · Sheet1" / "CSV" / "HTML 표(.xls)" */
  format?: string
}

/** 같은 가맹점의 반복 결제 묶음 = 정기결제 후보. */
export interface DetectedSeries {
  key: string                  // merchantNorm
  merchantRaw: string          // 대표 표기
  occurrences: Txn[]           // 날짜 오름차순
  medianAmount: number
  /** 이 시리즈의 통화. 없으면 기준통화로 본다. USD 구독을 원화로 찍지 않기 위한 필드. */
  currency?: Currency
  amountSpread: number         // 0 = 매번 동일 금액, 클수록 변동
  medianIntervalDays: number
  inferredCycle: Cycle
  inferredCycleDays: number
  confidence: number           // 0..1 — 정기결제일 확신도
  firstSeen: string
  lastSeen: string
  nextExpected: string         // ISO yyyy-mm-dd
  /** 등록부의 어떤 구독과 연결됐는지. undefined = 미등록 = "잊고 있던 구독" 후보 */
  matchedSubscriptionId?: string
  /** 마지막 결제 후 주기의 1.5배가 지났으면 true → 이미 해지됐을 수 있음 */
  stale: boolean
}

export type FindingKind =
  | 'category_overlap'   // 같은 카테고리 중복 (동영상 3개 등)
  | 'feature_overlap'    // 다른 카테고리지만 기능이 겹침 (YT Premium ↔ Spotify)
  | 'unmatched_charge'   // CSV엔 있는데 등록 안 된 결제 = 잊은 구독
  | 'zombie'             // 오래 안 쓴 구독
  | 'stale_series'       // 결제가 끊긴 시리즈 → 등록부 정리 필요
  | 'trial_ending'       // 무료체험 종료 임박
  | 'annual_saving'      // 연간 결제로 바꾸면 절약
  | 'duplicate_plan'     // 같은 서비스 요금제 중복 등록
  // 구독처럼 보이는데 결제 증거가 없음. 계정 관련 메일(약관 변경·비밀번호 등)만
  // 오고 영수증이 없는 경우다. 통신사 결합·기프트카드로 내면 정상적으로 이렇게 된다.
  // 앱이 판단할 수 없으니 사용자에게 물어본다.
  | 'unconfirmed_service'

export interface Finding {
  id: string
  kind: FindingKind
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  subscriptionIds: string[]
  seriesKeys: string[]
  /** 이 건을 정리하면 아낄 수 있는 월 환산 금액 (기준통화) */
  monthlySaving: number
  /**
   * 사용자가 직접 확인해야 하는 건. 채워져 있으면 점검 화면에 확인 버튼이 붙는다.
   * `unconfirmed_service` 가 이걸 쓴다.
   */
  candidate?: {
    /** normalizeMerchant 로 만든 키. 확인/무시 상태를 이 키로 기억한다. */
    key: string
    service: string
    category?: Category
    amount?: number
    currency?: Currency
    cycle?: Cycle
    nextBillingDate?: string
  }
}

export interface Settings {
  baseCurrency: Currency
  /** 자동 환율 조회를 쓸지. 끄면 아래 수동 환율만 쓴다. */
  fxAuto: boolean
  /** 자동 조회가 실패했을 때 쓰는 수동 환율. 1 단위 외화 → 기준통화. */
  fxRates: Record<string, number>
  fxUpdatedAt?: string
  /** 이 일수 이상 안 썼으면 좀비로 본다 */
  zombieAfterDays: number
  /** 알림 리드타임(일) — 다가오는 결제 강조 */
  upcomingWindowDays: number
}

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

export interface AppState {
  subscriptions: Subscription[]
  series: DetectedSeries[]
  ignoredSeriesKeys: string[]
  /**
   * "구독 아님"이라고 사용자가 직접 정리한 후보들(normalizeMerchant 키).
   *
   * 메일을 다시 스캔하면 같은 계정 메일이 또 걸린다. 이 목록이 없으면
   * 사용자가 지운 항목이 스캔할 때마다 되살아나 점검 화면이 쓸모없어진다.
   */
  dismissedCandidates: string[]
  /**
   * 결제 시점 환율 표. 키는 "USD-2026-07-13" 형태.
   * 과거 날짜의 환율은 바뀌지 않으므로 한 번 받으면 영구 캐시다.
   * 최신 환율은 "USD-latest" 로 따로 둔다.
   */
  fxTable: Record<string, number>
  receipts: EmailReceipt[]
  settings: Settings
  version: number
}

/** 대시보드 집계 결과. */
export interface Totals {
  monthly: number              // 기준통화 월 환산 합계
  yearly: number
  activeCount: number
  byCategory: { category: Category; monthly: number; count: number }[]
  byCurrency: { currency: Currency; monthly: number; count: number }[]
  byPaymentMethod: { method: string; monthly: number; count: number }[]
  /** 앞으로 upcomingWindowDays 안에 빠져나갈 결제 */
  upcoming: { sub: Subscription; date: string; amountBase: number }[]
}

export const CATEGORY_LABEL: Record<Category, string> = {
  ott: 'OTT 스트리밍',
  video: '동영상 플랫폼',
  music: '음악',
  ai: 'AI',
  cloud: '클라우드/저장소',
  productivity: '생산성',
  dev: '개발',
  design: '디자인',
  news: '뉴스/콘텐츠',
  gaming: '게임',
  fitness: '운동/건강',
  education: '교육',
  membership: '멤버십',
  security: '보안/VPN',
  communication: '커뮤니케이션',
  finance: '금융',
  other: '기타',
}

export const CYCLE_LABEL: Record<Cycle, string> = {
  weekly: '주간',
  monthly: '월간',
  quarterly: '분기',
  semiannual: '반기',
  yearly: '연간',
  custom: '직접입력',
}

export const BILLING_CHANNEL_LABEL: Record<BillingChannel, string> = {
  card: '카드 결제',
  carrier: '통신사 결합/휴대폰 결제',
  bundle: '다른 상품에 포함',
  giftcard: '기프트카드/포인트',
  manual: '계좌이체 등 직접 납부',
  other: '기타',
}

/** 명세서나 영수증 메일에 결제 기록이 남지 않는 경로. */
export const CHANNELS_WITHOUT_RECEIPTS: BillingChannel[] = ['carrier', 'bundle', 'giftcard']

/** 구독이 속한 모든 카테고리. 중복 진단은 반드시 이걸 써야 한다. */
export function categoriesOf(sub: Subscription): Category[] {
  return [sub.category, ...(sub.extraCategories ?? [])].filter(
    (c, i, arr) => arr.indexOf(c) === i,
  )
}

export const STATUS_LABEL: Record<SubStatus, string> = {
  active: '이용중',
  trial: '무료체험',
  paused: '일시정지',
  canceled: '해지',
}
