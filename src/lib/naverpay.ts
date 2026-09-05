// ─────────────────────────────────────────────────────────────
// 네이버페이 결제 안내 메일 전용 파서.
//
// 네이버페이는 결제대행이라 발신 도메인(navercorp.com)만 보면 "네이버 멤버십"으로
// 오분류된다. 실제 서비스명은 본문 표 안에 있다.
//
// 그리고 이 메일은 양이 압도적으로 많다(12개월에 800건대). 대부분 편의점·식당
// 오프라인 결제라 구독과 무관하다. 그걸 걸러내는 게 이 파서의 절반이다.
// ─────────────────────────────────────────────────────────────

import type { Currency, ReceiptKind } from '../types'

export const NAVERPAY_SENDERS = ['naverpayadmin_noreply@navercorp.com', 'naverpay_noreply@navercorp.com']

/** 네이버페이 발신자인지. 주소 전체로 판단한다(navercorp.com 은 네이버 멤버십 메일도 쓴다). */
export function isNaverPaySender(from: string): boolean {
  const f = (from || '').toLowerCase()
  return NAVERPAY_SENDERS.some((s) => f.includes(s)) || /naverpay[\w.-]*@/.test(f)
}

/**
 * `결제처` 에 들어오는 건 서비스가 아니라 PG사인 경우가 많다.
 * 그때 진짜 서비스명은 `상품정보` 쪽에 있다.
 */
const PG_COMPANIES = [
  'nice정보통신',
  '나이스페이먼츠',
  'kg이니시스',
  '이니시스',
  '토스페이먼츠',
  'kcp',
  '한국사이버결제',
  '다날',
  '헥토',
  '갤럭시아',
  '올더게이트',
  'ksnet',
  '스마트로',
]

function isPgCompany(name: string): boolean {
  const n = name.toLowerCase().replace(/[\s()（）주]/g, '')
  return PG_COMPANIES.some((p) => n.includes(p.replace(/\s/g, '')))
}

/** 본문은 `| 라벨 | 값 |` 형태의 표로 온다. 라벨로 값을 뽑는다. */
function cell(body: string, label: string): string | undefined {
  const re = new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`)
  const m = re.exec(body)
  const v = m?.[1]?.trim()
  return v && v !== '-' ? v : undefined
}

/** 여러 라벨을 우선순위대로 시도한다. */
function firstCell(body: string, labels: string[]): string | undefined {
  for (const l of labels) {
    const v = cell(body, l)
    if (v) return v
  }
  return undefined
}

/** "12,900원" / "12,900 원" → 12900 */
function amountOf(raw?: string): number | undefined {
  if (!raw) return undefined
  const m = /(\d[\d,]*)\s*원/.exec(raw)
  if (!m) return undefined
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** "2026.09.05 16:41" / "2026.08.30" → "2026-09-05" */
function dateOf(raw?: string): string | undefined {
  if (!raw) return undefined
  const m = /(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(raw)
  if (!m) return undefined
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "카드사 (****-****-****-0000)" → "카드사 0000" */
function cardOf(raw?: string): string | undefined {
  if (!raw) return undefined
  const digits = /(\d{4})\s*\)?\s*$/.exec(raw.replace(/[^\d)]+$/, ''))
  const name = raw.split('(')[0]?.trim()
  const last4 = digits?.[1] ?? /(\d{4})(?!.*\d)/.exec(raw)?.[1]
  if (!name) return undefined
  return last4 ? `${name} ${last4}` : name
}

export interface NaverPayParsed {
  /** 실제 서비스/가맹점 이름 */
  service: string
  amount?: number
  currency: Currency
  paidAt?: string
  kind: ReceiptKind
  card?: string
  /** 자동결제(정기결제) 등록 메일이면 true */
  recurring: boolean
}

/**
 * 네이버페이 메일 1건을 파싱한다. 구독 후보가 아니면 null.
 *
 * null 을 돌려주는 경우가 이 파서의 핵심이다:
 *  - 오프라인 결제(`가맹점명`) — 편의점·식당. 800건 대부분이 여기다
 *  - 주문 취소 안내 — 물건 반품이지 구독 해지가 아니다. 이걸 해지로 읽으면
 *    멀쩡한 구독이 시리즈에서 통째로 사라진다
 *  - 자동구매확정 등 결제와 무관한 안내
 */
export function parseNaverPay(subject: string, body: string): NaverPayParsed | null {
  const s = subject || ''
  const b = body || ''

  // 결제 자체가 아닌 메일들. 특히 '취소'를 구독 해지로 읽으면 안 된다.
  if (/취소하신 내역|자동구매확정|배송|리뷰|적립|쿠폰/.test(s)) return null

  const recurring = /자동결제\s*등록내역/.test(s) || /등록완료_자동결제|자동결제 등록 정보/.test(b)
  const isPayment = /결제하신 내역/.test(s) || /결제완료_일반결제/.test(b)
  if (!recurring && !isPayment) return null

  const merchantOffline = cell(b, '가맹점명')
  const payee = cell(b, '결제처')
  const product = cell(b, '상품정보')

  // 오프라인 결제는 구독이 아니다. 여기서 잘라내지 않으면 편의점 결제가
  // "정기결제 후보"로 쏟아져 들어온다.
  if (merchantOffline && !payee && !product) return null

  // 결제처가 PG사면 진짜 서비스명은 상품정보 쪽에 있다.
  let service: string | undefined
  if (payee && !isPgCompany(payee)) service = payee
  else if (product) service = product
  else if (payee) service = payee

  if (!service) return null
  service = service.replace(/\s+/g, ' ').trim()
  if (!service || service.length > 60) return null

  const amount = amountOf(
    firstCell(b, ['최종결제금액', '주문금액', '총 결제 금액', '총결제금액', '상품금액']),
  )
  const paidAt = dateOf(firstCell(b, ['결제일자', '등록일자', '주문일자']))
  const card = cardOf(cell(b, '상세정보')) ?? cell(b, '결제수단')

  return {
    service,
    amount,
    currency: 'KRW',
    paidAt,
    kind: recurring ? 'signup' : 'payment',
    card,
    recurring,
  }
}
