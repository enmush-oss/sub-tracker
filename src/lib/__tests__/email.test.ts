import { describe, it, expect } from 'vitest'
import {
  buildGmailQuery,
  classifyReceipt,
  extractAmount,
  extractCycle,
  extractNextBillingDate,
  mergeSeries,
  parseReceiptEmail,
  parseReceiptsJson,
  receiptsToSeries,
} from '../email'
import type { EmailReceipt } from '../../types'

const mail = (over: Partial<Parameters<typeof parseReceiptEmail>[0]> = {}) =>
  parseReceiptEmail({
    id: 'm1',
    from: 'info@account.netflix.com',
    subject: 'Netflix 결제 영수증',
    date: '2026-08-14',
    body: '넷플릭스 프리미엄 멤버십 월 17,000원이 결제되었습니다. 다음 결제일은 2026년 9월 14일입니다.',
    source: 'gmail',
    ...over,
  })

describe('extractAmount', () => {
  it('한국어 원 표기를 읽는다', () => {
    expect(extractAmount('결제금액 17,000원')).toEqual({ amount: 17000, currency: 'KRW' })
  })
  it('통화 기호가 앞에 오는 표기를 읽는다', () => {
    expect(extractAmount('Total: $9.99')).toEqual({ amount: 9.99, currency: 'USD' })
    expect(extractAmount('청구금액 ₩29,800')).toEqual({ amount: 29800, currency: 'KRW' })
    expect(extractAmount('Amount: USD 20.00')).toEqual({ amount: 20, currency: 'USD' })
  })
  it('여러 금액이 있으면 총액(최댓값)을 고른다', () => {
    const body = '상품금액 15,455원\n부가세 1,545원\n총 결제금액 17,000원'
    expect(extractAmount(body)).toEqual({ amount: 17000, currency: 'KRW' })
  })
  it('통화가 섞이면 더 자주 나온 통화를 따른다', () => {
    const body = '월 14,900원 (부가세 포함) / 참고 환율 $1 = 1,380원 / 결제 14,900원'
    expect(extractAmount(body)?.currency).toBe('KRW')
  })
  it('금액이 없으면 null', () => {
    expect(extractAmount('구독이 갱신되었습니다.')).toBeNull()
    expect(extractAmount('')).toBeNull()
  })
  it('연도를 금액으로 오인하지 않는다', () => {
    expect(extractAmount('2026 구독 안내')).toBeNull()
  })
})

describe('extractCycle', () => {
  it.each([
    ['월 14,900원 자동결제', 'monthly'],
    ['매월 청구됩니다', 'monthly'],
    ['Billed monthly', 'monthly'],
    ['$100/year', 'yearly'],
    ['연간 구독이 갱신되었습니다', 'yearly'],
    ['분기마다 청구', 'quarterly'],
    ['매주 결제', 'weekly'],
  ] as const)('%s → %s', (text, expected) => {
    expect(extractCycle(text)).toBe(expected)
  })

  it('6개월을 월간으로 뭉개지 않는다', () => {
    expect(extractCycle('6개월 단위로 청구됩니다')).toBe('semiannual')
  })
  it('못 찾으면 undefined', () => {
    expect(extractCycle('결제가 완료되었습니다')).toBeUndefined()
  })
})

describe('extractNextBillingDate', () => {
  it('한국어 "다음 결제일" 뒤의 날짜를 잡는다', () => {
    expect(extractNextBillingDate('다음 결제일: 2026-09-14', '2026-08-14')).toBe('2026-09-14')
  })
  it('날짜가 표현 앞에 오는 한국어 어순도 잡는다', () => {
    expect(extractNextBillingDate('2026년 9월 14일에 자동 갱신됩니다.', '2026-08-14')).toBe('2026-09-14')
  })
  it('영문 renews on 표기를 잡는다', () => {
    expect(extractNextBillingDate('Your plan renews on October 14, 2026.', '2026-08-14')).toBe('2026-10-14')
  })
  it('수신일보다 과거인 날짜는 다음 결제일이 아니다', () => {
    expect(extractNextBillingDate('결제일 2026-07-14 에 처리됨', '2026-08-14')).toBeUndefined()
  })
})

describe('classifyReceipt', () => {
  it.each([
    ['Netflix 결제 영수증', 'payment'],
    ['Your receipt from Spotify', 'payment'],
    ['구독 갱신 예정 안내', 'renewal_notice'],
    ['Your subscription will renew soon', 'renewal_notice'],
    ['무료 체험이 곧 종료됩니다', 'trial_ending'],
    ['구독이 해지되었습니다', 'cancel'],
    ['요금 인상 안내', 'price_change'],
  ] as const)('%s → %s', (subject, expected) => {
    expect(classifyReceipt(subject, '')).toBe(expected)
  })

  it('해지가 결제보다 우선한다', () => {
    expect(classifyReceipt('구독 해지 및 결제 안내', '')).toBe('cancel')
  })
})

describe('parseReceiptEmail', () => {
  it('넷플릭스 영수증을 온전히 파싱한다', () => {
    const r = mail()!
    expect(r.service).toBe('Netflix')
    expect(r.category).toBe('ott')
    expect(r.kind).toBe('payment')
    expect(r.amount).toBe(17000)
    expect(r.currency).toBe('KRW')
    expect(r.cycle).toBe('monthly')
    expect(r.nextBillingDate).toBe('2026-09-14')
    expect(r.confidence).toBeGreaterThan(0.8)
  })

  it('서브도메인 발신자도 서비스로 인식한다', () => {
    expect(mail({ from: 'no-reply@e.spotify.com', subject: 'Spotify 결제 영수증' })!.service).toBe('Spotify')
  })

  it('구독과 무관한 메일은 버린다', () => {
    expect(mail({ subject: '택배가 배송되었습니다', body: '오늘 도착 예정입니다.' })).toBeNull()
  })

  it('결제대행사(PayPal)를 서비스명으로 쓰지 않는다', () => {
    const r = mail({
      from: 'service@paypal.com',
      subject: 'You sent a payment - 결제 영수증',
      body: 'Netflix 구독료 월 17,000원이 결제되었습니다.',
    })!
    expect(r.service).not.toBe('PayPal')
  })

  it('인증코드를 스니펫에 남기지 않는다', () => {
    const r = mail({
      subject: '결제 인증 안내',
      body: '구독 결제 인증코드: 483920 을 입력하세요. 금액 17,000원',
    })!
    expect(r.snippet).not.toContain('483920')
  })

  it('스니펫은 300자를 넘지 않는다', () => {
    const r = mail({ body: '구독 결제 ' + 'x'.repeat(2000) })!
    expect(r.snippet.length).toBeLessThanOrEqual(300)
  })
})

describe('buildGmailQuery', () => {
  it('기간과 노이즈 제외가 들어간다', () => {
    const q = buildGmailQuery({ months: 12 })
    expect(q).toContain('newer_than:12m')
    expect(q).toContain('-from:notifications@github.com')
    expect(q).toContain('영수증')
    // 네이버페이 자동결제 등록 메일이 안 걸리면 대행결제 구독을 통째로 놓친다
    expect(q).toContain('자동결제')
  })
})

// ── 시리즈 변환 ────────────────────────────────────────────

const receipt = (over: Partial<EmailReceipt>): EmailReceipt => ({
  id: Math.random().toString(36).slice(2),
  source: 'gmail',
  receivedAt: '2026-08-14',
  from: 'info@account.netflix.com',
  subject: '결제 영수증',
  kind: 'payment',
  service: 'Netflix',
  category: 'video',
  amount: 17000,
  currency: 'KRW',
  confidence: 0.9,
  snippet: '',
  ...over,
})

describe('receiptsToSeries', () => {
  it('반복 결제 영수증을 월간 시리즈로 만든다', () => {
    const rs = ['2026-05-14', '2026-06-14', '2026-07-14', '2026-08-14'].map((d) => receipt({ receivedAt: d }))
    const series = receiptsToSeries(rs, '2026-08-20')
    expect(series).toHaveLength(1)
    expect(series[0].inferredCycle).toBe('monthly')
    expect(series[0].confidence).toBeGreaterThanOrEqual(0.9)
    expect(series[0].occurrences).toHaveLength(4)
  })

  it('해지 메일이 온 서비스는 시리즈에서 뺀다', () => {
    const rs = [
      receipt({ receivedAt: '2026-06-14' }),
      receipt({ receivedAt: '2026-07-14' }),
      receipt({ receivedAt: '2026-08-01', kind: 'cancel', subject: '구독이 해지되었습니다' }),
    ]
    expect(receiptsToSeries(rs, '2026-08-20')).toHaveLength(0)
  })

  it('금액과 주기가 명시된 영수증 1건이면 잊은 구독 임계값(0.6)을 넘긴다', () => {
    const rs = [receipt({ service: 'Figma', category: 'design', cycle: 'monthly', amount: 20000 })]
    const series = receiptsToSeries(rs, '2026-08-20')
    expect(series).toHaveLength(1)
    expect(series[0].merchantRaw).toBe('Figma')
    // 연간 구독은 근거 메일이 1건뿐인 게 정상이다. 여기서 눌러버리면 영원히 못 찾는다.
    expect(series[0].confidence).toBeGreaterThanOrEqual(0.6)
    // 그래도 반복 결제 기록만큼 확신하지는 않는다
    expect(series[0].confidence).toBeLessThanOrEqual(0.8)
  })

  it('금액 없이 주기만 있는 메일은 임계값을 넘기지 않는다', () => {
    const rs = [receipt({ service: 'Figma', category: 'design', cycle: 'monthly', amount: undefined })]
    const series = receiptsToSeries(rs, '2026-08-20')
    expect(series[0].confidence).toBeLessThan(0.6)
  })

  it('주기 정보가 없는 단발 메일은 시리즈로 만들지 않는다', () => {
    const rs = [receipt({ service: 'Figma', category: 'design', cycle: undefined })]
    expect(receiptsToSeries(rs, '2026-08-20')).toHaveLength(0)
  })
})

describe('mergeSeries', () => {
  it('같은 서비스의 CSV 시리즈와 메일 시리즈를 합친다', () => {
    const csv = receiptsToSeries(
      ['2026-05-14', '2026-06-14'].map((d) => receipt({ receivedAt: d })),
      '2026-08-20',
    )
    const email = receiptsToSeries(
      ['2026-07-14', '2026-08-14'].map((d) => receipt({ receivedAt: d })),
      '2026-08-20',
    )
    const merged = mergeSeries(csv, email, '2026-08-20')
    expect(merged).toHaveLength(1)
    expect(merged[0].occurrences).toHaveLength(4)
  })

  it('중복 거래를 두 번 세지 않는다', () => {
    const a = receiptsToSeries(['2026-06-14', '2026-07-14'].map((d) => receipt({ receivedAt: d })), '2026-08-20')
    const merged = mergeSeries(a, a, '2026-08-20')
    expect(merged[0].occurrences).toHaveLength(2)
  })

  it('등록부 연결 정보를 잃지 않는다', () => {
    const a = receiptsToSeries(['2026-06-14', '2026-07-14'].map((d) => receipt({ receivedAt: d })), '2026-08-20')
    a[0].matchedSubscriptionId = 'sub-1'
    const b = receiptsToSeries(['2026-08-14', '2026-09-14'].map((d) => receipt({ receivedAt: d })), '2026-09-20')
    expect(mergeSeries(a, b, '2026-09-20')[0].matchedSubscriptionId).toBe('sub-1')
  })
})

describe('parseReceiptsJson', () => {
  const valid = {
    receipts: [
      { id: 'a', receivedAt: '2026-08-14', service: 'Netflix', kind: 'payment', amount: 17000, currency: 'KRW', cycle: 'monthly' },
      { id: 'b', receivedAt: '2026-08-03', service: 'Spotify', kind: 'payment', amount: 11990, currency: 'KRW' },
    ],
  }

  it('{ receipts: [...] } 형태를 읽는다', () => {
    expect(parseReceiptsJson(JSON.stringify(valid))).toHaveLength(2)
  })

  it('최상위 배열 형태도 읽는다', () => {
    expect(parseReceiptsJson(JSON.stringify(valid.receipts))).toHaveLength(2)
  })

  it('잘못된 항목만 건너뛰고 나머지는 살린다', () => {
    const mixed = { receipts: [...valid.receipts, { service: '' }, { receivedAt: 'not-a-date', service: 'X' }, null] }
    expect(parseReceiptsJson(JSON.stringify(mixed))).toHaveLength(2)
  })

  it('JSON 이 아니면 명확한 에러를 던진다', () => {
    expect(() => parseReceiptsJson('그냥 텍스트')).toThrow(/JSON/)
  })

  it('유효한 항목이 하나도 없으면 에러를 던진다', () => {
    expect(() => parseReceiptsJson(JSON.stringify({ receipts: [{ service: '' }] }))).toThrow()
  })

  it('알 수 없는 kind/cycle 은 안전한 기본값으로 떨어뜨린다', () => {
    const r = parseReceiptsJson(
      JSON.stringify({ receipts: [{ receivedAt: '2026-08-14', service: 'X', kind: '이상함', cycle: '이상함' }] }),
    )[0]
    expect(r.kind).toBe('unknown')
    expect(r.cycle).toBeUndefined()
  })
})

describe('해지 메일이 살아있는 구독을 지우지 않는다', () => {
  const r = (
    receivedAt: string,
    kind: 'payment' | 'cancel',
    amount?: number,
  ) => ({
    id: `${kind}:${receivedAt}`,
    source: 'json' as const,
    receivedAt,
    from: 'googleplay-noreply@google.com',
    subject: kind === 'cancel' ? '구독이 취소되었습니다' : '구독이 갱신되었습니다',
    kind,
    service: 'Google One',
    category: 'cloud' as const,
    ...(amount ? { amount, currency: 'KRW' as const } : {}),
    cycle: 'monthly' as const,
    confidence: 0.95,
    snippet: '',
  })

  it('연간 → 월간으로 갈아타면 해지 메일이 와도 구독은 살아있다', () => {
    // 실제로 겪은 일이다. 연간 플랜을 해지하고 같은 날 월간으로 갈아탔는데,
    // 해지 메일 하나 때문에 그 뒤 6개월치 결제가 통째로 사라졌다.
    const series = receiptsToSeries(
      [
        r('2025-10-03', 'payment', 24000),
        r('2026-02-19', 'cancel'),
        r('2026-03-19', 'payment', 29000),
        r('2026-04-19', 'payment', 29000),
        r('2026-05-19', 'payment', 29000),
        r('2026-06-19', 'payment', 29000),
        r('2026-07-19', 'payment', 7500),
        r('2026-08-19', 'payment', 7500),
      ],
      '2026-09-07',
    )
    const g = series.find((s) => s.merchantRaw === 'Google One')
    expect(g, '해지 메일 때문에 살아있는 구독이 사라짐').toBeDefined()
    expect(g!.inferredCycle).toBe('monthly')
    // 대표 금액은 중앙값(29,000)이 아니라 지금 나가는 돈이어야 한다
    expect(g!.medianAmount).toBe(7500)
    // 해지 이전 기록은 끌고 오지 않는다 — 끝난 요금제다
    expect(g!.firstSeen > '2026-02-19').toBe(true)
  })

  it('해지 후 결제가 없으면 시리즈에서 뺀다', () => {
    const series = receiptsToSeries(
      [r('2025-10-03', 'payment', 24000), r('2025-11-03', 'payment', 24000), r('2025-12-01', 'cancel')],
      '2026-09-07',
    )
    expect(series.find((s) => s.merchantRaw === 'Google One')).toBeUndefined()
  })
})

describe('비표준 주기를 30일로 뭉개지 않는다', () => {
  it('2년 약정은 다음 결제일에서 실제 일수를 계산한다', () => {
    // custom 을 30일로 두면 109,890원짜리 2년 약정이 매달 나가는 것처럼 잡힌다. 27배다.
    const series = receiptsToSeries(
      [
        {
          id: 'nord',
          source: 'json',
          receivedAt: '2025-11-24',
          from: 'support@nordaccount.com',
          subject: 'Your payment confirmation and receipt',
          kind: 'payment',
          service: 'NordVPN',
          category: 'security',
          amount: 99000,
          currency: 'KRW',
          cycle: 'custom',
          nextBillingDate: '2028-02-24',
          confidence: 0.95,
          snippet: '',
        },
      ],
      '2026-09-07',
    )
    const n = series.find((s) => s.merchantRaw === 'NordVPN')
    expect(n).toBeDefined()
    // 823일이다. '연간'(365)으로 뭉개도 >360 은 통과해버리므로 실제 일수로 못박는다.
    expect(n!.inferredCycleDays).toBeGreaterThan(700)
    expect(n!.inferredCycle).toBe('custom')
  })
})

describe('대표 영수증은 증거가 강한 쪽을 고른다', () => {
  it('가입 안내의 어림 주기가 결제 영수증의 정확한 갱신일을 덮어쓰지 않는다', () => {
    const base = {
      source: 'json' as const,
      from: 'support@nordaccount.com',
      category: 'security' as const,
      confidence: 0.9,
      snippet: '',
    }
    const series = receiptsToSeries(
      [
        // 가입 안내가 결제 영수증보다 뒤(또는 같은 날)에 와도 밀리면 안 된다
        {
          ...base,
          id: 'pay',
          receivedAt: '2025-11-24',
          subject: 'Your payment confirmation and receipt',
          kind: 'payment',
          service: 'NordVPN',
          amount: 99000,
          currency: 'KRW',
          cycle: 'custom',
          nextBillingDate: '2028-02-24',
        },
        {
          ...base,
          id: 'signup',
          receivedAt: '2025-11-24',
          subject: '자동결제 등록내역',
          kind: 'signup',
          service: 'NordVPN',
          cycle: 'yearly',
        },
      ],
      '2026-09-07',
    )
    const n = series.find((s) => s.merchantRaw === 'NordVPN')!
    expect(n.inferredCycleDays).toBeGreaterThan(700)
  })
})

describe('전달된(FW) 메일', () => {
  // 메일함을 다른 계정으로 포워딩해두면 발신자와 날짜가 전달 시점 값으로 바뀐다.
  // 원본을 되찾지 못하면 영수증이 통째로 엉뚱하게 읽힌다.
  const body = `-----Original Message-----
From: "네이버플러스 멤버십"<naverplus_noreply@navercorp.com>
To: <me@naver.com>;
Sent: 2025-09-12 (금) 12:31:51 (GMT+09:00)
Subject: [네이버플러스 멤버십] 결제 내역 안내

네이버플러스 멤버십
결제 완료

상품명 네이버플러스 연간 이용권
결제일 2025. 09. 12.
결제금액 49,000원 (VAT 포함)
이용기간 2025. 09. 12.~2026. 09. 12.
다음 결제 예정일 2026. 09. 12.`

  const parsed = parseReceiptEmail({
    id: 'fw1',
    from: 'me@naver.com',
    subject: 'FW: [네이버플러스 멤버십] 결제 내역 안내',
    date: '2026-09-07',
    body,
    source: 'gmail',
  })!

  it('본문 헤더에서 원래 발신자를 되찾는다', () => {
    // 전달 주소(me@naver.com)로 판단하면 그냥 "네이버"가 된다
    expect(parsed.service).toBe('네이버플러스 멤버십')
    expect(parsed.service).not.toBe('네이버')
  })

  it('전달한 날이 아니라 원본 발송일을 결제일로 쓴다', () => {
    // 이게 틀리면 작년 결제가 오늘 것이 된다. 1년치를 몰아 전달하면
    // 전부 같은 날짜가 되어 주기 계산이 통째로 무너진다.
    expect(parsed.receivedAt).toBe('2025-09-12')
    expect(parsed.receivedAt).not.toBe('2026-09-07')
  })

  it('금액·주기·종류를 읽는다', () => {
    expect(parsed.amount).toBe(49000)
    expect(parsed.cycle).toBe('yearly')
    expect(parsed.kind).toBe('payment')
    expect(parsed.category).toBe('membership')
  })

  it('"2025. 09. 12." 처럼 점 뒤에 공백이 있는 날짜를 읽는다', () => {
    // 국내 영수증에 아주 흔한 표기다. 못 읽으면 다음 결제일이 통째로 빈다.
    expect(parsed.nextBillingDate).toBe('2026-09-12')
  })

  it('전달 메일이 아니면 원래 발신자를 그대로 쓴다', () => {
    const r = parseReceiptEmail({
      id: 'n1',
      from: 'info@account.netflix.com',
      subject: '결제가 완료되었습니다',
      date: '2026-08-14',
      body: '17,000원이 결제되었습니다.',
      source: 'gmail',
    })!
    expect(r.service).toBe('Netflix')
    expect(r.receivedAt).toBe('2026-08-14')
  })
})
