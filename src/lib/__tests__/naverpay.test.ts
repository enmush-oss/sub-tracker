import { describe, it, expect } from 'vitest'
import { isNaverPaySender, parseNaverPay } from '../naverpay'
import { parseReceiptEmail } from '../email'

// 실제 메일의 표 구조만 본떴다. 서비스명·금액·카드번호·상호는 전부 가상 값이다.
const ONLINE_PG = `네이버페이 - 결제완료_일반결제

| 결제번호 | 20260830NP0000000000 |
| 결제일자 | 2026.08.30 |
| 결제처 | NICE정보통신(주) |
| 상품정보 | SPOTIFY |
| 수량 | 1 |
| 상품금액 | 12,900원 |
| 주문금액 | 12,900 원 |
| 최종결제금액 | 12,900원 |
| 카드 간편결제 | 12,900원 |

나이스페이먼츠 정기결제 카드
`

const OFFLINE = `네이버페이NEXT - 결제화면

| 결제일자 | 2026.09.05 16:41 |
| 가맹점명 | 분식나라 OO점 |
| 총 결제 금액 | 14,400원 |
| ㄴ 상품금액 | 14,400원 |
| 결제수단 | 네이버페이 포인트·머니 |
`

const AUTO_REGISTER = `네이버페이 - 등록완료_자동결제

자동결제 등록 정보
| 등록일자 | 2026.08.30 |
| 결제처 | Example Service Co., Ltd. |
| 결제수단 | 카드 간편결제 |
| 상세정보 | 우리 (****-****-****-0000) |
`

describe('isNaverPaySender', () => {
  it('네이버페이 발신자를 알아본다', () => {
    expect(isNaverPaySender('naverpayadmin_noreply@navercorp.com')).toBe(true)
    expect(isNaverPaySender('네이버페이 <naverpayadmin_noreply@navercorp.com>')).toBe(true)
  })
  it('일반 네이버 메일은 네이버페이가 아니다', () => {
    expect(isNaverPaySender('noreply@navercorp.com')).toBe(false)
    expect(isNaverPaySender('info@account.netflix.com')).toBe(false)
  })
})

describe('parseNaverPay', () => {
  it('PG사 뒤에 숨은 진짜 서비스명을 상품정보에서 꺼낸다', () => {
    const r = parseNaverPay('[네이버페이] 결제하신 내역을 안내해드립니다.', ONLINE_PG)!
    expect(r).not.toBeNull()
    // 결제처는 NICE정보통신(주) 지만 그건 결제대행사다
    expect(r.service).toBe('SPOTIFY')
    expect(r.amount).toBe(12900)
    expect(r.currency).toBe('KRW')
    expect(r.paidAt).toBe('2026-08-30')
    expect(r.kind).toBe('payment')
  })

  it('오프라인 결제(편의점·식당)는 구독 후보에서 뺀다', () => {
    // 12개월에 800건대가 이런 결제다. 안 거르면 정기결제 탐지가 뒤덮인다.
    expect(parseNaverPay('[네이버페이] 결제하신 내역을 안내해드립니다.', OFFLINE)).toBeNull()
  })

  it('자동결제 등록 메일은 정기결제로 잡고 결제처를 그대로 쓴다', () => {
    const r = parseNaverPay('[네이버페이] 자동결제 등록내역을 안내해드립니다.', AUTO_REGISTER)!
    expect(r.recurring).toBe(true)
    expect(r.kind).toBe('signup')
    expect(r.service).toBe('Example Service Co., Ltd.')
    expect(r.paidAt).toBe('2026-08-30')
    expect(r.card).toContain('0000')
  })

  it('주문 취소 안내를 구독 해지로 읽지 않는다', () => {
    // 물건 반품 하나 때문에 멀쩡한 구독이 시리즈에서 통째로 사라지면 안 된다.
    expect(parseNaverPay('[네이버페이] 취소하신 내역을 안내해드립니다.', ONLINE_PG)).toBeNull()
  })

  it('자동구매확정 같은 결제 아닌 안내는 버린다', () => {
    expect(
      parseNaverPay('[네이버페이] 구매하신 제품의 자동구매확정 안내입니다.', ONLINE_PG),
    ).toBeNull()
  })

  it('시각까지 붙은 날짜도 읽는다', () => {
    const body = OFFLINE.replace('| 가맹점명 | 분식나라 OO점 |', '| 결제처 | 예시서점 |')
    const r = parseNaverPay('[네이버페이] 결제하신 내역을 안내해드립니다.', body)!
    expect(r.paidAt).toBe('2026-09-05')
    expect(r.service).toBe('예시서점')
  })
})

describe('parseReceiptEmail 이 네이버페이를 전용 파서로 넘긴다', () => {
  const mail = (subject: string, body: string) =>
    parseReceiptEmail({
      id: 'np1',
      from: 'naverpayadmin_noreply@navercorp.com',
      subject,
      date: '2026-08-30',
      body,
      source: 'gmail',
    })

  it('네이버 멤버십으로 오분류하지 않는다', () => {
    const r = mail('[네이버페이] 결제하신 내역을 안내해드립니다.', ONLINE_PG)!
    expect(r).not.toBeNull()
    // 발신 도메인이 navercorp.com 이라고 '네이버'가 되면 안 된다
    expect(r.service).not.toBe('네이버')
    expect(r.category).not.toBe('membership')
    expect(r.amount).toBe(12900)
    expect(r.receivedAt).toBe('2026-08-30')
  })

  it('알려진 서비스면 카테고리를 추론한다', () => {
    const r = mail('[네이버페이] 결제하신 내역을 안내해드립니다.', ONLINE_PG)!
    expect(r.category).toBe('music')
  })

  it('오프라인 결제는 영수증으로 만들지 않는다', () => {
    expect(mail('[네이버페이] 결제하신 내역을 안내해드립니다.', OFFLINE)).toBeNull()
  })

  it('자동결제 등록은 주기와 높은 확신도를 갖는다', () => {
    const r = mail('[네이버페이] 자동결제 등록내역을 안내해드립니다.', AUTO_REGISTER)!
    expect(r.cycle).toBe('monthly')
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('스니펫에 카드 전체번호를 남기지 않는다', () => {
    const r = mail('[네이버페이] 자동결제 등록내역을 안내해드립니다.', AUTO_REGISTER)!
    expect(r.snippet).not.toMatch(/\d{4}-\d{4}-\d{4}-\d{4}/)
  })
})
