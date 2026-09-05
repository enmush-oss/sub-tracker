// ─────────────────────────────────────────────────────────────
// 구독 영수증 메일 파싱.
//
// 수집 경로가 Gmail 이든, Claude 가 만들어준 JSON 이든, 사용자가 붙여넣은
// 본문이든 전부 EmailReceipt 로 수렴시킨 뒤 DetectedSeries 로 변환한다.
// 그래야 CSV 명세서와 똑같은 진단 파이프라인(matchSeriesToSubs → analyze)을 탄다.
// ─────────────────────────────────────────────────────────────

import type {
  Category,
  Currency,
  Cycle,
  DetectedSeries,
  EmailReceipt,
  ReceiptKind,
  Txn,
} from '../types'
import { guessCategory, guessServiceName, normalizeMerchant } from './normalize'
import { detectSeries } from './detect'
import { isNaverPaySender, parseNaverPay } from './naverpay'

// ─── 알려진 구독 메일 발신 도메인 ─────────────────────────────
// normalize.ts 의 KNOWN_SERVICES 는 "카드 명세서 가맹점명" 기준이고,
// 이건 "메일 발신 도메인" 기준이다. 축이 달라서 따로 둔다.

export const RECEIPT_SENDERS: { domain: string; service: string; category: Category }[] = [
  // 영상
  { domain: 'netflix.com', service: 'Netflix', category: 'ott' },
  { domain: 'disneyplus.com', service: 'Disney+', category: 'ott' },
  { domain: 'tving.com', service: '티빙', category: 'ott' },
  { domain: 'wavve.co.kr', service: '웨이브', category: 'ott' },
  { domain: 'watcha.com', service: '왓챠', category: 'ott' },
  { domain: 'laftel.net', service: '라프텔', category: 'ott' },
  { domain: 'primevideo.com', service: 'Prime Video', category: 'ott' },
  // 음악
  { domain: 'spotify.com', service: 'Spotify', category: 'music' },
  { domain: 'melon.com', service: '멜론', category: 'music' },
  { domain: 'genie.co.kr', service: '지니뮤직', category: 'music' },
  { domain: 'music.flo.com', service: 'FLO', category: 'music' },
  { domain: 'bugs.co.kr', service: '벅스', category: 'music' },
  { domain: 'youtube.com', service: 'YouTube Premium', category: 'video' },
  // AI
  { domain: 'openai.com', service: 'ChatGPT', category: 'ai' },
  { domain: 'anthropic.com', service: 'Claude', category: 'ai' },
  { domain: 'perplexity.ai', service: 'Perplexity', category: 'ai' },
  { domain: 'midjourney.com', service: 'Midjourney', category: 'ai' },
  { domain: 'cursor.com', service: 'Cursor', category: 'ai' },
  { domain: 'cursor.sh', service: 'Cursor', category: 'ai' },
  // 클라우드/저장소
  { domain: 'dropbox.com', service: 'Dropbox', category: 'cloud' },
  { domain: 'apple.com', service: 'Apple', category: 'cloud' },
  { domain: 'icloud.com', service: 'iCloud+', category: 'cloud' },
  // 생산성
  { domain: 'notion.so', service: 'Notion', category: 'productivity' },
  { domain: 'notion.com', service: 'Notion', category: 'productivity' },
  { domain: 'todoist.com', service: 'Todoist', category: 'productivity' },
  { domain: 'evernote.com', service: 'Evernote', category: 'productivity' },
  { domain: 'microsoft.com', service: 'Microsoft 365', category: 'productivity' },
  // 개발
  { domain: 'github.com', service: 'GitHub', category: 'dev' },
  { domain: 'jetbrains.com', service: 'JetBrains', category: 'dev' },
  { domain: 'vercel.com', service: 'Vercel', category: 'dev' },
  { domain: 'netlify.com', service: 'Netlify', category: 'dev' },
  { domain: 'cloudflare.com', service: 'Cloudflare', category: 'dev' },
  { domain: 'amazonaws.com', service: 'AWS', category: 'dev' },
  { domain: 'digitalocean.com', service: 'DigitalOcean', category: 'dev' },
  // 디자인
  { domain: 'figma.com', service: 'Figma', category: 'design' },
  { domain: 'adobe.com', service: 'Adobe', category: 'design' },
  { domain: 'canva.com', service: 'Canva', category: 'design' },
  // 커뮤니케이션
  { domain: 'slack.com', service: 'Slack', category: 'communication' },
  { domain: 'zoom.us', service: 'Zoom', category: 'communication' },
  // 멤버십
  { domain: 'coupang.com', service: '쿠팡 와우', category: 'membership' },
  { domain: 'navercorp.com', service: '네이버', category: 'membership' },
  { domain: 'naver.com', service: '네이버', category: 'membership' },
  { domain: 'amazon.com', service: 'Amazon Prime', category: 'membership' },
  // 교육/독서
  { domain: 'ridibooks.com', service: '리디', category: 'education' },
  { domain: 'millie.co.kr', service: '밀리의 서재', category: 'education' },
  { domain: 'class101.net', service: '클래스101', category: 'education' },
  { domain: 'inflearn.com', service: '인프런', category: 'education' },
  { domain: 'coursera.org', service: 'Coursera', category: 'education' },
  { domain: 'udemy.com', service: 'Udemy', category: 'education' },
  // 게임
  { domain: 'xbox.com', service: 'Xbox Game Pass', category: 'gaming' },
  { domain: 'playstation.com', service: 'PlayStation Plus', category: 'gaming' },
  { domain: 'nintendo.com', service: 'Nintendo Switch Online', category: 'gaming' },
  // 보안
  { domain: 'nordvpn.com', service: 'NordVPN', category: 'security' },
  { domain: '1password.com', service: '1Password', category: 'security' },
  { domain: 'bitwarden.com', service: 'Bitwarden', category: 'security' },
]

/** 결제대행사·간편결제는 서비스 자체가 아니라 "중개자"다.
 *  이 도메인에서 온 메일은 발신자로 서비스를 정하면 안 되고, 제목/본문에서 찾아야 한다. */
const PAYMENT_INTERMEDIARIES = [
  'paypal.com',
  'stripe.com',
  'toss.im',
  'tossbank.com',
  'tosspayments.com',
  'kakaopay.com',
  'kcp.co.kr',
  'nicepay.co.kr',
  'inicis.com',
  'payple.kr',
]

// ─── Gmail 검색 쿼리 ─────────────────────────────────────────

/** 구독 결제 메일을 넓게 긁되, GitHub CI 알림처럼 양 많은 노이즈는 뺀다. */
export function buildGmailQuery(opts?: { months?: number }): string {
  const months = opts?.months ?? 12
  // 네이버페이 자동결제 등록 메일은 정기결제의 직접 증거라 반드시 걸려야 한다.
  const subjectKo =
    '영수증 OR 결제완료 OR 정기결제 OR 자동결제 OR 구독 OR 멤버십 OR 이용요금 OR 자동결제 등록내역'
  const subjectEn =
    'receipt OR invoice OR subscription OR "payment received" OR "has renewed" OR "will renew" OR "free trial"'
  const noise =
    '-from:notifications@github.com -from:noreply@github.com -from:ci_activity@noreply.github.com -category:promotions'
  return `newer_than:${months}m subject:(${subjectKo} OR ${subjectEn}) ${noise}`.trim()
}

// ─── 금액 추출 ───────────────────────────────────────────────

const CURRENCY_BY_SYMBOL: Record<string, Currency> = {
  '₩': 'KRW',
  원: 'KRW',
  KRW: 'KRW',
  $: 'USD',
  USD: 'USD',
  'US$': 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  '¥': 'JPY',
  JPY: 'JPY',
  '£': 'GBP',
  GBP: 'GBP',
}

function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * 본문에서 금액을 뽑는다. 여러 개면 가장 큰 값을 쓴다.
 * 영수증에는 보통 소계·부가세·할인이 같이 찍히고, 우리가 원하는 건 총액이라
 * 최댓값이 총액일 확률이 가장 높다.
 */
export function extractAmount(text: string): { amount: number; currency: Currency } | null {
  if (!text) return null
  const found: { amount: number; currency: Currency }[] = []

  // ① 기호/코드가 앞에 오는 형태: ₩17,000 / $9.99 / USD 9.99 / US$9.99 / KRW 17,000
  const prefixRe = /(US\$|KRW|USD|EUR|JPY|GBP|[₩$€¥£])\s?(\d[\d,]*(?:\.\d{1,2})?)/gi
  for (const m of text.matchAll(prefixRe)) {
    const cur = CURRENCY_BY_SYMBOL[m[1].toUpperCase()] ?? CURRENCY_BY_SYMBOL[m[1]]
    const amt = toNumber(m[2])
    if (cur && amt !== null) found.push({ amount: amt, currency: cur })
  }

  // ② 단위가 뒤에 오는 한국어 형태: 17,000원 / 17,000 원
  const suffixRe = /(\d[\d,]*(?:\.\d{1,2})?)\s?원/g
  for (const m of text.matchAll(suffixRe)) {
    const amt = toNumber(m[1])
    if (amt !== null) found.push({ amount: amt, currency: 'KRW' })
  }

  if (found.length === 0) return null

  // 통화가 섞여 있으면 가장 많이 등장한 통화로 좁힌 뒤 최댓값.
  const byCurrency = new Map<Currency, { amount: number; currency: Currency }[]>()
  for (const f of found) {
    const list = byCurrency.get(f.currency) ?? []
    list.push(f)
    byCurrency.set(f.currency, list)
  }
  let best: { amount: number; currency: Currency }[] = []
  for (const list of byCurrency.values()) if (list.length > best.length) best = list

  return best.reduce((max, cur) => (cur.amount > max.amount ? cur : max), best[0])
}

// ─── 주기 추출 ───────────────────────────────────────────────

export function extractCycle(text: string): Cycle | undefined {
  if (!text) return undefined
  const t = text.toLowerCase()
  // 순서 주의: '6개월'을 '월'보다 먼저 봐야 반기가 월간으로 뭉개지지 않는다.
  if (/(반기|6\s?개월|semi-?annual|every 6 months)/.test(t)) return 'semiannual'
  // "연 189,000원" 처럼 단위가 금액 바로 앞에 붙는 표기가 국내 영수증에서 가장 흔하다.
  if (/(연간|매년|1\s?년|연\s*\d[\d,]*\s*원|annually|annual|yearly|per year|\/\s?year|\/\s?yr)/.test(t)) return 'yearly'
  if (/(분기|3\s?개월|quarterly|every 3 months)/.test(t)) return 'quarterly'
  if (/(주간|매주|weekly|per week|\/\s?week|\/\s?wk)/.test(t)) return 'weekly'
  if (
    /(월간|매월|매달|1\s?개월|월\s*\d[\d,]*\s*원|monthly|per month|\/\s?month|\/\s?mo\b|월 요금|월정액)/.test(t)
  )
    return 'monthly'
  return undefined
}

// ─── 날짜 추출 ───────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** 문자열 하나에서 날짜를 찾는다. 여러 표기 지원. */
function scanDates(text: string): string[] {
  const out: string[] = []

  // 2026-10-14 / 2026.10.14 / 2026/10/14
  for (const m of text.matchAll(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/g)) {
    const v = iso(+m[1], +m[2], +m[3])
    if (v) out.push(v)
  }
  // 2026년 10월 14일
  for (const m of text.matchAll(/(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    const v = iso(+m[1], +m[2], +m[3])
    if (v) out.push(v)
  }
  // October 14, 2026 / Oct 14 2026
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g)) {
    const mo = MONTH_NAMES[m[1].slice(0, 3).toLowerCase()]
    if (!mo) continue
    const v = iso(+m[3], mo, +m[2])
    if (v) out.push(v)
  }
  // 14 October 2026
  for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(20\d{2})\b/g)) {
    const mo = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()]
    if (!mo) continue
    const v = iso(+m[3], mo, +m[1])
    if (v) out.push(v)
  }
  return out
}

/**
 * 다음 결제일. "다음 결제", "갱신", "renews" 같은 표현 근처의 날짜를 우선하고,
 * 없으면 수신일 이후의 가장 이른 날짜를 쓴다.
 */
export function extractNextBillingDate(text: string, receivedAt: string): string | undefined {
  if (!text) return undefined

  const cueRe =
    /(다음\s*결제|다음\s*청구|갱신|자동\s*연장|next\s+(?:billing|payment|charge)|renew(?:s|ed|al)?|will\s+be\s+charged)/gi

  for (const m of text.matchAll(cueRe)) {
    // 표현 앞뒤 120자 안에서 날짜를 찾는다. 한국어는 날짜가 앞에 오는 경우가 흔하다
    // ("2026년 10월 14일에 갱신됩니다").
    const start = Math.max(0, m.index! - 120)
    const window = text.slice(start, m.index! + 120)
    const future = scanDates(window).filter((d) => d > receivedAt)
    if (future.length > 0) return future.sort()[0]
  }

  const future = scanDates(text).filter((d) => d > receivedAt)
  return future.length > 0 ? future.sort()[0] : undefined
}

// ─── 메일 종류 판정 ──────────────────────────────────────────

export function classifyReceipt(subject: string, body: string): ReceiptKind {
  const s = (subject || '').toLowerCase()
  const b = (body || '').slice(0, 2000).toLowerCase()
  const both = s + '\n' + b
  const inSubject = (re: RegExp) => re.test(s)

  // 해지/취소가 가장 강한 신호다. 먼저 본다.
  if (inSubject(/(해지|취소|구독\s*종료|canceled|cancelled|cancellation|subscription ended)/)) return 'cancel'
  if (inSubject(/(무료\s*체험|체험\s*(기간)?\s*(종료|만료)|trial (ends|ending|expir))/)) return 'trial_ending'
  if (inSubject(/(가격\s*(인상|변경)|요금\s*(인상|변경)|price (change|increase)|pricing update)/)) return 'price_change'
  if (inSubject(/(결제\s*(완료|성공)|영수증|receipt|invoice|payment (received|confirmation)|payment successful)/))
    return 'payment'
  if (inSubject(/(갱신\s*예정|자동\s*결제\s*예정|정기\s*결제\s*안내|will renew|upcoming (payment|charge)|renews on)/))
    return 'renewal_notice'
  if (inSubject(/(구독\s*(시작|신청|가입)|welcome to|subscription (started|confirmed)|가입을?\s*환영)/)) return 'signup'

  // 제목으로 못 정하면 본문으로 한 번 더.
  if (/(해지되었|취소되었|has been canceled|has been cancelled)/.test(both)) return 'cancel'
  if (/(결제가 완료|영수증|receipt for|invoice for|payment of)/.test(both)) return 'payment'
  if (/(갱신됩니다|자동으로 결제|will automatically renew|next billing date|다음 결제일)/.test(both))
    return 'renewal_notice'
  if (/(무료 체험|free trial)/.test(both)) return 'trial_ending'

  return 'unknown'
}

// ─── 메일 1건 파싱 ───────────────────────────────────────────

function domainOf(from: string): string {
  const m = /@([\w.-]+)/.exec(from || '')
  return m ? m[1].toLowerCase() : ''
}

/** 도메인이 서브도메인이어도 매칭되게 뒤에서부터 비교한다.
 *  info@account.netflix.com → netflix.com */
function senderEntry(from: string) {
  const dom = domainOf(from)
  if (!dom) return undefined
  return RECEIPT_SENDERS.find((e) => dom === e.domain || dom.endsWith('.' + e.domain))
}

function isIntermediary(from: string): boolean {
  const dom = domainOf(from)
  return PAYMENT_INTERMEDIARIES.some((d) => dom === d || dom.endsWith('.' + d))
}

/** 구독과 무관한 메일을 거르는 최소 조건. */
function looksSubscriptionRelated(subject: string, body: string): boolean {
  const t = (subject + '\n' + body.slice(0, 1500)).toLowerCase()
  return /(구독|정기결제|자동결제|멤버십|영수증|결제|요금|갱신|체험|subscription|receipt|invoice|billing|renew|membership|plan)/.test(
    t,
  )
}

/** 인증코드처럼 새어나가면 안 되는 것들을 스니펫에서 지운다. */
function sanitizeSnippet(text: string): string {
  return text
    .replace(/\b\d{4,8}\b(?=\s*(?:코드|code))/gi, '****')
    .replace(/(인증\s*(?:번호|코드)\s*[:：]?\s*)\d{4,8}/g, '$1****')
    .replace(/((?:code|otp)\s*[:：]?\s*)\d{4,8}/gi, '$1****')
    .replace(/\b(?:\d[ -]?){12,16}\b/g, '****')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function toIsoDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  const scanned = scanDates(raw)
  return scanned[0] ?? new Date().toISOString().slice(0, 10)
}

export function parseReceiptEmail(input: {
  id: string
  from: string
  subject: string
  date: string
  body: string
  source: EmailReceipt['source']
}): EmailReceipt | null {
  const subject = input.subject ?? ''
  const body = input.body ?? ''

  // 네이버페이는 결제대행이라 일반 경로로 파싱하면 "네이버 멤버십"이 돼버린다.
  // 실제 서비스명·금액은 본문 표 안에 있으므로 전용 파서로 넘긴다.
  if (isNaverPaySender(input.from)) {
    const np = parseNaverPay(subject, body)
    if (!np) return null // 오프라인 결제·주문취소 등 구독과 무관한 건
    const receivedAt = np.paidAt ?? toIsoDate(input.date)
    const norm = normalizeMerchant(np.service)
    const service = guessServiceName(norm) ?? np.service
    return {
      id: input.id,
      source: input.source,
      receivedAt,
      from: input.from,
      subject,
      kind: np.kind,
      service,
      category: guessCategory(norm),
      ...(np.amount !== undefined ? { amount: np.amount, currency: np.currency } : {}),
      ...(np.recurring ? { cycle: 'monthly' as Cycle } : {}),
      // 자동결제 등록 메일은 정기결제라는 직접 증거다. 일반 결제 건은 반복 여부를
      // 이 메일 하나로는 알 수 없으므로 낮게 잡고 반복 횟수로 올라가게 둔다.
      confidence: np.recurring ? 0.85 : 0.55,
      snippet: sanitizeSnippet(`${np.service} ${np.amount ?? ''} ${np.card ?? ''}`),
    }
  }

  if (!looksSubscriptionRelated(subject, body)) return null

  const kind = classifyReceipt(subject, body)
  const receivedAt = toIsoDate(input.date)

  // 서비스 판별: 발신 도메인 → 제목/본문 사전 → 도메인 이름 그대로
  let service: string | undefined
  let category: Category | undefined

  const entry = senderEntry(input.from)
  if (entry && !isIntermediary(input.from)) {
    service = entry.service
    category = entry.category
  }

  if (!service) {
    // 결제대행사 메일이거나 모르는 발신자. 제목 → 본문 앞부분 순으로 사전 조회.
    for (const text of [subject, body.slice(0, 800)]) {
      const guessed = guessServiceName(normalizeMerchant(text))
      if (guessed) {
        service = guessed
        category = guessCategory(normalizeMerchant(text))
        break
      }
    }
  }

  if (!service) {
    const dom = domainOf(input.from)
    if (!dom) return null
    // noreply@somesaas.io → "somesaas"
    const label = dom.split('.').filter((p) => !['com', 'net', 'org', 'co', 'kr', 'io', 'so', 'ai', 'mail', 'email', 'account', 'no-reply', 'noreply'].includes(p))
    service = label[label.length - 1] ?? dom
    category = 'other'
  }

  const amount = extractAmount(subject + '\n' + body)
  const cycle = extractCycle(subject + '\n' + body)
  const nextBillingDate = extractNextBillingDate(body || subject, receivedAt)

  // 확신도: 발신자를 알고, 금액이 있고, 주기가 있고, 종류가 분명할수록 높다.
  let confidence = 0.25
  if (entry) confidence += 0.3
  if (amount) confidence += 0.25
  if (cycle) confidence += 0.15
  if (kind === 'payment') confidence += 0.15
  else if (kind === 'renewal_notice' || kind === 'trial_ending') confidence += 0.1
  else if (kind === 'unknown') confidence -= 0.15
  confidence = Math.max(0, Math.min(1, confidence))

  return {
    id: input.id,
    source: input.source,
    receivedAt,
    from: input.from,
    subject,
    kind,
    service,
    category: category ?? 'other',
    ...(amount ? { amount: amount.amount, currency: amount.currency } : {}),
    ...(cycle ? { cycle } : {}),
    ...(nextBillingDate ? { nextBillingDate } : {}),
    confidence,
    snippet: sanitizeSnippet(body || subject),
  }
}

// ─── 영수증 → DetectedSeries ────────────────────────────────

function receiptToTxn(r: EmailReceipt): Txn {
  return {
    id: 'mail:' + r.id,
    date: r.receivedAt,
    merchantRaw: r.service ?? r.from,
    merchantNorm: normalizeMerchant(r.service ?? r.from),
    amount: r.amount ?? 0,
    currency: r.currency ?? 'KRW',
    memo: r.subject,
    sourceFile: '이메일',
  }
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

const CYCLE_DAYS: Record<Cycle, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  semiannual: 182,
  yearly: 365,
  custom: 30,
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

/**
 * 결제일 간격(일)로 주기를 정한다. detect.ts 와 같은 창을 쓴다.
 * 2년 약정 VPN 처럼 표준 주기에 안 맞는 건 custom 으로 남겨 일수를 그대로 보존한다.
 */
export function inferCycleFromGap(days: number): { cycle: Cycle; cycleDays: number } | undefined {
  if (!Number.isFinite(days) || days < 3) return undefined
  if (days <= 9) return { cycle: 'weekly', cycleDays: 7 }
  if (days >= 26 && days <= 35) return { cycle: 'monthly', cycleDays: 30 }
  if (days >= 80 && days <= 100) return { cycle: 'quarterly', cycleDays: 91 }
  if (days >= 170 && days <= 195) return { cycle: 'semiannual', cycleDays: 182 }
  if (days >= 350 && days <= 380) return { cycle: 'yearly', cycleDays: 365 }
  // VPN 2~3년 약정처럼 흔치 않은 주기. 버리면 가장 잊기 쉬운 구독을 통째로 놓친다.
  if (days <= 1100) return { cycle: 'custom', cycleDays: days }
  return undefined
}

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 영수증들을 서비스별로 묶어 정기결제 시리즈로 만든다.
 *
 * - 해지 메일이 온 서비스는 통째로 뺀다 (이미 끊은 걸 "잊은 구독"이라 부르면 안 된다)
 * - 결제 영수증이 2건 이상이면 CSV 와 동일한 detectSeries 규칙을 그대로 태운다
 * - 1건뿐이어도 메일에 주기가 명시돼 있으면 시리즈로 인정한다 (확신도는 낮게)
 */
export function receiptsToSeries(receipts: EmailReceipt[], today?: string): DetectedSeries[] {
  const t = today ?? new Date().toISOString().slice(0, 10)

  const canceled = new Set(
    receipts.filter((r) => r.kind === 'cancel' && r.service).map((r) => normalizeMerchant(r.service!)),
  )

  const live = receipts.filter((r) => r.service && !canceled.has(normalizeMerchant(r.service)))

  // 서비스별로 묶는다. 금액은 영수증마다 빠져 있는 경우가 흔해서(게임 정기권, 가입 안내 등)
  // 같은 서비스에서 알아낸 금액을 서로 빌려 쓴다.
  const groups = new Map<string, EmailReceipt[]>()
  for (const r of live) {
    const key = normalizeMerchant(r.service!)
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  const series: DetectedSeries[] = []

  for (const [key, group] of groups) {
    group.sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1))
    const knownAmounts = group.map((r) => r.amount).filter((a): a is number => typeof a === 'number' && a > 0)
    const fallbackAmount = median(knownAmounts)
    const payments = group.filter((r) => r.kind === 'payment')

    // ① 결제 영수증이 2건 이상이면 CSV 와 같은 탐지기를 그대로 태운다.
    if (payments.length >= 2) {
      const txns: Txn[] = payments.map((r) => ({
        ...receiptToTxn(r),
        amount: r.amount ?? fallbackAmount ?? 0,
      }))
      const [detected] = detectSeries(txns, { minOccurrences: 2, today: t })
      if (detected) {
        // 요금제가 바뀐 서비스(Google One 처럼)는 중앙값이 옛날 가격을 가리킨다.
        // 앞으로 나갈 돈은 "가장 최근 결제 금액"이므로 그걸 대표값으로 쓴다.
        const latestAmount = [...payments].reverse().find((r) => typeof r.amount === 'number' && r.amount > 0)?.amount

        // 요금이 바뀌면 금액 편차 때문에 확신도가 떨어진다. 하지만 같은 곳에서
        // 일정한 간격으로 여러 번 빠져나갔다면 그건 요금제가 바뀌었든 말든 구독이다.
        // 간격이 고른 반복 결제는 금액 변동으로 깎지 않는다.
        // 편차는 최댓값이 아니라 중앙값으로 본다. 요금제를 갈아탄 이력(연간 → 월간)이
        // 섞이면 간격 하나가 167일씩 튀는데, 최대편차로 재면 그 하나가 나머지 규칙적인
        // 결제 전부를 무효화해버린다.
        const gaps = txns.slice(1).map((tx, i) => daysBetween(txns[i].date, tx.date))
        const gapMedian = median(gaps) ?? 0
        const gapDeviation = median(gaps.map((g) => Math.abs(g - gapMedian))) ?? Infinity
        const gapSpread = gapMedian > 0 ? gapDeviation / gapMedian : 1
        const intervalsAreRegular = txns.length >= 3 && gapSpread <= 0.2

        series.push({
          ...detected,
          key,
          merchantRaw: group[group.length - 1].service!,
          medianAmount: latestAmount ?? detected.medianAmount,
          currency: payments.find((r) => r.currency)?.currency ?? 'KRW',
          confidence: intervalsAreRegular ? Math.max(detected.confidence, 0.75) : detected.confidence,
        })
        continue
      }
    }

    // ② 결제 영수증이 1건뿐이거나 갱신 안내만 온 서비스도 놓치면 안 된다.
    //    주기는 본문 표기 → 다음 결제일까지의 간격 순으로 알아낸다.
    const rep = [...group].reverse().find((r) => r.cycle || r.nextBillingDate) ?? group[group.length - 1]
    let cycle: Cycle | undefined = rep.cycle
    let cycleDays: number | undefined = cycle ? CYCLE_DAYS[cycle] : undefined

    if (!cycle && rep.nextBillingDate) {
      // 2년 약정처럼 본문에 주기 단어가 없고 갱신일만 적힌 경우가 여기서 구제된다.
      const inferred = inferCycleFromGap(daysBetween(rep.receivedAt, rep.nextBillingDate))
      if (inferred) {
        cycle = inferred.cycle
        cycleDays = inferred.cycleDays
      }
    }
    if (!cycle || !cycleDays) continue

    series.push({
      key,
      merchantRaw: rep.service!,
      occurrences: group.map((r) => ({ ...receiptToTxn(r), amount: r.amount ?? fallbackAmount ?? 0 })),
      medianAmount: rep.amount ?? fallbackAmount ?? 0,
      currency: rep.currency ?? group.find((r) => r.currency)?.currency ?? 'KRW',
      amountSpread: 0,
      medianIntervalDays: cycleDays,
      inferredCycle: cycle,
      inferredCycleDays: cycleDays,
      // 근거가 메일 한두 건뿐이라 반복 결제 기록보다는 약하다. 다만
      // "연 $220, 다음 갱신 2027-07-13" 처럼 금액과 주기가 본문에 명시된 영수증은
      // 그 자체로 구독의 직접 증거다. 이걸 일률적으로 눌러버리면 연간 구독은
      // 영원히 "잊고 있던 구독"으로 못 뜬다 — 정작 가장 잊기 쉬운 게 그건데도.
      confidence: Math.min(
        rep.amount && (rep.cycle || rep.nextBillingDate) ? 0.8 : 0.55,
        0.35 + rep.confidence * 0.45,
      ),
      firstSeen: group[0].receivedAt,
      lastSeen: rep.receivedAt,
      nextExpected: rep.nextBillingDate ?? addDays(rep.receivedAt, cycleDays),
      stale: t > addDays(rep.nextBillingDate ?? rep.receivedAt, cycleDays * 1.5),
    })
  }

  return series.sort((a, b) => b.confidence - a.confidence)
}

/** 같은 key 의 시리즈를 합친다. CSV 로 만든 것과 메일로 만든 것을 병합할 때 쓴다. */
export function mergeSeries(base: DetectedSeries[], incoming: DetectedSeries[], today?: string): DetectedSeries[] {
  const t = today ?? new Date().toISOString().slice(0, 10)
  const byKey = new Map<string, DetectedSeries>()
  for (const s of base) byKey.set(s.key, s)

  for (const s of incoming) {
    const prev = byKey.get(s.key)
    if (!prev) {
      byKey.set(s.key, s)
      continue
    }
    // 거래를 합쳐 중복 제거 후, 근거가 많은 쪽 기준으로 다시 계산한다.
    const seen = new Set<string>()
    const merged: Txn[] = []
    for (const o of [...prev.occurrences, ...s.occurrences]) {
      const sig = o.date + '|' + o.amount
      if (seen.has(sig)) continue
      seen.add(sig)
      merged.push(o)
    }
    merged.sort((a, b) => (a.date < b.date ? -1 : 1))

    const recomputed = detectSeries(merged, { minOccurrences: 2, today: t })[0]
    const winner = recomputed ?? (prev.confidence >= s.confidence ? prev : s)
    byKey.set(s.key, {
      ...winner,
      key: s.key,
      merchantRaw: prev.merchantRaw || s.merchantRaw,
      occurrences: merged,
      // 등록부 연결 정보는 잃어버리면 안 된다
      matchedSubscriptionId: prev.matchedSubscriptionId ?? s.matchedSubscriptionId,
    })
  }

  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence)
}

// ─── Claude 가 만들어준 JSON 임포트 ─────────────────────────

const VALID_KINDS: ReceiptKind[] = [
  'payment',
  'renewal_notice',
  'trial_ending',
  'signup',
  'cancel',
  'price_change',
  'unknown',
]
const VALID_CYCLES: Cycle[] = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'custom']
const VALID_CURRENCIES: Currency[] = ['KRW', 'USD', 'EUR', 'JPY', 'GBP']

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

/**
 * 배열이거나 { receipts: [...] } 형태 둘 다 받는다.
 * 항목 하나가 이상해도 전체를 버리지 않고 그것만 조용히 건너뛴다.
 */
export function parseReceiptsJson(text: string): EmailReceipt[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('JSON 형식이 아닙니다. 붙여넣은 내용을 확인해주세요.')
  }

  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { receipts?: unknown }).receipts)
      ? ((data as { receipts: unknown[] }).receipts)
      : []

  if (list.length === 0) throw new Error('영수증 목록을 찾지 못했습니다. receipts 배열이 있는지 확인해주세요.')

  const out: EmailReceipt[] = []
  for (const [i, item] of list.entries()) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>

    const service = typeof r.service === 'string' ? r.service.trim() : ''
    if (!service) continue

    const receivedAt = isIsoDate(r.receivedAt) ? r.receivedAt : undefined
    if (!receivedAt) continue

    const kind = VALID_KINDS.includes(r.kind as ReceiptKind) ? (r.kind as ReceiptKind) : 'unknown'
    const cycle = VALID_CYCLES.includes(r.cycle as Cycle) ? (r.cycle as Cycle) : undefined
    const currency = VALID_CURRENCIES.includes(r.currency as Currency) ? (r.currency as Currency) : undefined
    const amount = typeof r.amount === 'number' && r.amount > 0 ? r.amount : undefined
    const confidence =
      typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : 0.7

    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `json:${i}:${service}:${receivedAt}`,
      source: 'json',
      receivedAt,
      from: typeof r.from === 'string' ? r.from : '',
      subject: typeof r.subject === 'string' ? r.subject : '',
      kind,
      service,
      ...(typeof r.plan === 'string' && r.plan ? { plan: r.plan } : {}),
      category: (typeof r.category === 'string' ? r.category : 'other') as Category,
      ...(amount !== undefined ? { amount } : {}),
      ...(currency ? { currency } : amount !== undefined ? { currency: 'KRW' as Currency } : {}),
      ...(cycle ? { cycle } : {}),
      ...(isIsoDate(r.nextBillingDate) ? { nextBillingDate: r.nextBillingDate } : {}),
      confidence,
      snippet: typeof r.snippet === 'string' ? sanitizeSnippet(r.snippet) : '',
    })
  }

  if (out.length === 0) throw new Error('유효한 영수증 항목이 없습니다. service 와 receivedAt 이 필요합니다.')
  return out
}
