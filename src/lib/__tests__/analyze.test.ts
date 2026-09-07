import { describe, it, expect } from 'vitest'
import { analyze, FEATURE_OVERLAP_GROUPS } from '../analyze'
import type { AppState, Category, DetectedSeries, Settings, Subscription, Txn } from '../../types'

const settings: Settings = {
  baseCurrency: 'KRW',
  fxAuto: false,
  fxRates: { KRW: 1, USD: 1380, EUR: 1500, JPY: 9.2, GBP: 1750 },
  zombieAfterDays: 60,
  upcomingWindowDays: 14,
}

function makeSub(over: Partial<Subscription>): Subscription {
  return {
    id: over.id ?? 'sub',
    service: 'Test',
    plan: '',
    category: 'other',
    amount: 10000,
    currency: 'KRW',
    cycle: 'monthly',
    nextBillingDate: '2026-01-01',
    status: 'active',
    merchantPatterns: [],
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function makeTxn(over: Partial<Txn>): Txn {
  return {
    id: over.id ?? 't',
    date: '2026-01-01',
    merchantRaw: 'raw',
    merchantNorm: 'norm',
    amount: 9900,
    currency: 'KRW',
    ...over,
  }
}

function makeSeries(over: Partial<DetectedSeries>): DetectedSeries {
  return {
    key: over.key ?? 'series-key',
    merchantRaw: '미상 서비스',
    occurrences: [makeTxn({}), makeTxn({ id: 't2', date: '2026-02-01' })],
    medianAmount: 9900,
    amountSpread: 0,
    medianIntervalDays: 30,
    inferredCycle: 'monthly',
    inferredCycleDays: 30,
    confidence: 0.8,
    firstSeen: '2026-01-01',
    lastSeen: '2026-02-01',
    nextExpected: '2026-03-01',
    stale: false,
    ...over,
  }
}

function emptyAppState(over: Partial<AppState> = {}): AppState {
  return {
    subscriptions: [],
    series: [],
    ignoredSeriesKeys: [],
    dismissedCandidates: [],
  fxTable: {},
  receipts: [],
    settings,
    version: 1,
    ...over,
  }
}

describe('analyze - category_overlap', () => {
  it('같은 카테고리 3개 -> category_overlap 1건', () => {
    const subs = [
      makeSub({ id: 'a', service: 'Netflix', category: 'video', amount: 17000 }),
      makeSub({ id: 'b', service: '티빙', category: 'video', amount: 13900 }),
      makeSub({ id: 'c', service: '디즈니+', category: 'video', amount: 9900 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    const overlaps = findings.filter((f) => f.kind === 'category_overlap')
    expect(overlaps.length).toBe(1)
    expect(overlaps[0].subscriptionIds.sort()).toEqual(['a', 'b', 'c'])
    // 가장 비싼 것(넷플릭스 17000)은 남기고, 나머지 중 제일 싼 것(디즈니+ 9900)이 절약 후보
    expect(overlaps[0].monthlySaving).toBeCloseTo(9900, 5)
  })
})

describe('analyze - unmatched_charge', () => {
  it('미등록 series(confidence 0.8) -> unmatched_charge severity high', () => {
    const series = [makeSeries({ key: 'unknown-service', confidence: 0.8 })]
    const findings = analyze(emptyAppState({ series }))
    const unmatched = findings.filter((f) => f.kind === 'unmatched_charge')
    expect(unmatched.length).toBe(1)
    expect(unmatched[0].severity).toBe('high')
    expect(unmatched[0].seriesKeys).toEqual(['unknown-service'])
  })

  it('ignoredSeriesKeys 에 있으면 안 나온다', () => {
    const series = [makeSeries({ key: 'ignored-one', confidence: 0.8 })]
    const findings = analyze(emptyAppState({ series, ignoredSeriesKeys: ['ignored-one'] }))
    expect(findings.filter((f) => f.kind === 'unmatched_charge')).toHaveLength(0)
  })

  it('confidence 가 낮으면 안 나온다', () => {
    const series = [makeSeries({ key: 'low-conf', confidence: 0.5 })]
    const findings = analyze(emptyAppState({ series }))
    expect(findings.filter((f) => f.kind === 'unmatched_charge')).toHaveLength(0)
  })

  it('stale 이면 안 나온다', () => {
    const series = [makeSeries({ key: 'stale-one', confidence: 0.9, stale: true })]
    const findings = analyze(emptyAppState({ series }))
    expect(findings.filter((f) => f.kind === 'unmatched_charge')).toHaveLength(0)
  })

  it('matchedSubscriptionId 가 있으면 안 나온다', () => {
    const series = [makeSeries({ key: 'matched-one', confidence: 0.9, matchedSubscriptionId: 'sub-x' })]
    const findings = analyze(emptyAppState({ series }))
    expect(findings.filter((f) => f.kind === 'unmatched_charge')).toHaveLength(0)
  })
})

describe('analyze - feature_overlap', () => {
  it('YouTube Premium + Spotify -> feature_overlap (음악 그룹)', () => {
    const musicGroup = FEATURE_OVERLAP_GROUPS.find((g) => g.id === 'music')
    expect(musicGroup).toBeTruthy()

    const subs = [
      makeSub({ id: 'yt', service: 'YouTube Premium', category: 'video', amount: 14900 }),
      makeSub({ id: 'sp', service: 'Spotify', category: 'music', amount: 10900 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    const overlaps = findings.filter((f) => f.kind === 'feature_overlap')
    expect(overlaps.length).toBeGreaterThanOrEqual(1)
    const musicOverlap = overlaps.find((f) => f.subscriptionIds.includes('yt') && f.subscriptionIds.includes('sp'))
    expect(musicOverlap).toBeTruthy()
  })
})

describe('analyze - stale_series 와 billingChannel', () => {
  it('통신사 결합(carrier) 구독의 stale series -> stale_series 안 나온다', () => {
    const subs = [makeSub({ id: 'yt-lite', service: 'YouTube Premium Lite', billingChannel: 'carrier' })]
    const series = [makeSeries({ key: 'yt-series', matchedSubscriptionId: 'yt-lite', stale: true })]
    const findings = analyze(emptyAppState({ subscriptions: subs, series }))
    expect(findings.filter((f) => f.kind === 'stale_series')).toHaveLength(0)
  })

  it('billingChannel 이 card 면 stale_series 가 그대로 나온다 (회귀 방지)', () => {
    const subs = [makeSub({ id: 'netflix', service: 'Netflix', billingChannel: 'card' })]
    const series = [makeSeries({ key: 'netflix-series', matchedSubscriptionId: 'netflix', stale: true })]
    const findings = analyze(emptyAppState({ subscriptions: subs, series }))
    const stale = findings.filter((f) => f.kind === 'stale_series')
    expect(stale.length).toBe(1)
    expect(stale[0].subscriptionIds).toEqual(['netflix'])
  })
})

describe('analyze - category_overlap 와 extraCategories', () => {
  it('Google One(cloud+ai) + ChatGPT(ai) -> AI 카테고리 중복이 잡힌다', () => {
    const subs = [
      makeSub({ id: 'g1', service: 'Google One', category: 'cloud', extraCategories: ['ai'], amount: 2900 }),
      makeSub({ id: 'gpt', service: 'ChatGPT', category: 'ai', amount: 20000 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    const aiOverlap = findings.find((f) => f.kind === 'category_overlap' && f.id.startsWith('category_overlap:ai|'))
    expect(aiOverlap).toBeTruthy()
    expect(aiOverlap!.subscriptionIds.sort()).toEqual(['g1', 'gpt'])
  })

  it('같은 Google One 이 클라우드 중복에도 여전히 잡힌다', () => {
    const subs = [
      makeSub({ id: 'g1', service: 'Google One', category: 'cloud', extraCategories: ['ai'], amount: 2900 }),
      makeSub({ id: 'dbx', service: 'Dropbox', category: 'cloud', amount: 12000 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    const cloudOverlap = findings.find(
      (f) => f.kind === 'category_overlap' && f.id.startsWith('category_overlap:cloud|'),
    )
    expect(cloudOverlap).toBeTruthy()
    expect(cloudOverlap!.subscriptionIds.sort()).toEqual(['dbx', 'g1'])
  })
})

describe('analyze - feature_overlap ai-chat 그룹에 Google One 포함', () => {
  it('FEATURE_OVERLAP_GROUPS 의 ai-chat 그룹이 google one 을 매칭한다', () => {
    const aiChatGroup = FEATURE_OVERLAP_GROUPS.find((g) => g.id === 'ai-chat')
    expect(aiChatGroup).toBeTruthy()
    expect(aiChatGroup!.services).toContain('google one')

    const subs = [
      makeSub({ id: 'g1', service: 'Google One', category: 'cloud', extraCategories: ['ai'], amount: 2900 }),
      makeSub({ id: 'claude', service: 'Claude', category: 'ai', amount: 20000 }),
    ]
    // 이 묶음은 부가 카테고리 덕분에 category_overlap 으로도 잡힌다.
    // 같은 얘기를 두 번 하지 않으려고 feature_overlap 쪽은 지워지므로,
    // 여기서는 "겹침이 하나라도 보고되는가"를 본다.
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    const overlap = findings.find(
      (f) =>
        (f.kind === 'feature_overlap' || f.kind === 'category_overlap') &&
        f.subscriptionIds.includes('g1') &&
        f.subscriptionIds.includes('claude'),
    )
    expect(overlap).toBeTruthy()
  })

  it('카테고리가 안 겹치면 기능 겹침이 살아남는다', () => {
    // Google One 에 부가 카테고리를 안 붙인 경우. 이때는 기능 겹침만이 유일한 단서다.
    const subs = [
      makeSub({ id: 'g1', service: 'Google One', category: 'cloud', amount: 2900 }),
      makeSub({ id: 'claude', service: 'Claude', category: 'ai', amount: 20000 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    expect(findings.some((f) => f.kind === 'feature_overlap')).toBe(true)
  })
})

describe('analyze - severity 정렬', () => {
  it('high 가 medium/low 보다 앞에 온다', () => {
    const subs = [
      makeSub({ id: 'a', service: 'Netflix', category: 'video', amount: 17000 }),
      makeSub({ id: 'b', service: '티빙', category: 'video', amount: 13900 }),
    ]
    const series = [makeSeries({ key: 'unknown-service', confidence: 0.8 })]
    const findings = analyze(emptyAppState({ subscriptions: subs, series }))
    const firstHighIndex = findings.findIndex((f) => f.severity === 'high')
    const firstMediumIndex = findings.findIndex((f) => f.severity === 'medium')
    if (firstHighIndex !== -1 && firstMediumIndex !== -1) {
      expect(firstHighIndex).toBeLessThan(firstMediumIndex)
    }
  })

  it('같은 구독 묶음을 카테고리 중복과 기능 겹침으로 두 번 보고하지 않는다', () => {
    const subs = [
      makeSub({ id: 'a', service: 'ChatGPT', category: 'ai', amount: 30000 }),
      makeSub({ id: 'b', service: 'Claude', category: 'ai', amount: 25000 }),
      makeSub({ id: 'c', service: 'Google One', category: 'cloud', extraCategories: ['ai'], amount: 7500 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    const ai = findings.filter(
      (f) =>
        (f.kind === 'category_overlap' || f.kind === 'feature_overlap') &&
        f.subscriptionIds.length === 3,
    )
    expect(ai).toHaveLength(1)
    expect(ai[0].kind).toBe('category_overlap')
  })

  it('YouTube 와 넷플릭스를 같은 영상 중복으로 묶지 않는다', () => {
    // 유튜브 프리미엄은 넷플릭스 대체재가 아니다.
    const subs = [
      makeSub({ id: 'n', service: 'Netflix', category: 'ott', amount: 21000 }),
      makeSub({ id: 'y', service: 'YouTube Premium Lite', category: 'video', amount: 8500 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    expect(findings.filter((f) => f.kind === 'category_overlap')).toHaveLength(0)
    expect(findings.filter((f) => f.kind === 'feature_overlap')).toHaveLength(0)
  })

  it('OTT 끼리는 여전히 중복으로 잡는다', () => {
    const subs = [
      makeSub({ id: 'n', service: 'Netflix', category: 'ott', amount: 21000 }),
      makeSub({ id: 't', service: 'TVING', category: 'ott', amount: 13900 }),
    ]
    const findings = analyze(emptyAppState({ subscriptions: subs }))
    expect(findings.some((f) => f.kind === 'category_overlap')).toBe(true)
  })

  it('YouTube Premium Lite 는 음악 겹침에서 뺀다', () => {
    // Lite 요금제에는 YouTube Music 이 없다.
    const lite = analyze(emptyAppState({
      subscriptions: [
        makeSub({ id: 'y', service: 'YouTube Premium', plan: 'Lite', category: 'video', amount: 8500 }),
        makeSub({ id: 's', service: 'Spotify', category: 'music', amount: 11990 }),
      ],
    }))
    expect(lite.some((f) => f.kind === 'feature_overlap')).toBe(false)

    // 일반 Premium 은 Music 을 포함하므로 겹침이 맞다
    const full = analyze(emptyAppState({
      subscriptions: [
        makeSub({ id: 'y', service: 'YouTube Premium', plan: '개인', category: 'video', amount: 14900 }),
        makeSub({ id: 's', service: 'Spotify', category: 'music', amount: 11990 }),
      ],
    }))
    expect(full.some((f) => f.kind === 'feature_overlap')).toBe(true)
  })
})

describe('겹침 진단을 두 번 말하지 않는다', () => {
  const sub = (
    id: string,
    service: string,
    amount: number,
    category: Category,
    extra?: Category[],
  ): Subscription => ({
    id,
    service,
    plan: '',
    category,
    ...(extra ? { extraCategories: extra } : {}),
    amount,
    currency: 'KRW',
    cycle: 'monthly',
    nextBillingDate: '2026-10-01',
    startedAt: '2026-01-01',
    status: 'active',
    merchantPatterns: [],
    tags: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  })

  const state = emptyAppState({
    subscriptions: [
      sub('a', 'ChatGPT', 30000, 'ai'),
      sub('b', 'Claude', 25000, 'ai'),
      // Google One 은 저장소지만 Gemini 를 포함해 AI 겹침에도 걸린다
      sub('c', 'Google One', 7500, 'cloud', ['ai']),
    ],
  })

  const overlaps = analyze(state, '2026-09-07').filter(
    (f) => f.kind === 'feature_overlap' || f.kind === 'category_overlap',
  )

  it('구독 집합이 포개지는 겹침 진단은 하나만 남는다', () => {
    // 예전에는 "AI 서비스 2개"(ChatGPT·Claude)와
    // "AI 챗봇 기능 겹침"(ChatGPT·Claude·Google One)이 나란히 떴다.
    expect(overlaps.length).toBe(1)
  })

  it('남은 진단이 세 구독을 모두 다룬다', () => {
    // Google One 은 주 카테고리가 저장소지만 Gemini 를 포함하므로 AI 겹침에도 들어간다.
    // 하나로 합치면서 이 사실이 빠지면 안 된다.
    expect(new Set(overlaps[0].subscriptionIds)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('절약 가능액을 두 번 세지 않는다', () => {
    // 두 진단의 절약액을 합치면 같은 겹침을 중복 계산해 헤드라인이 부푼다
    const total = overlaps.reduce((n, f) => n + f.monthlySaving, 0)
    expect(total).toBeLessThan(30000)
  })
})

describe('증거 없는 구독 후보 (unconfirmed_service)', () => {
  const receipt = (service: string, receivedAt: string) => ({
    id: `r:${service}:${receivedAt}`,
    source: 'json' as const,
    receivedAt,
    from: 'info@example.com',
    subject: '약관 변경 안내',
    kind: 'unknown' as const,
    service,
    category: 'ott' as const,
    confidence: 0.5,
    snippet: '',
  })

  const withReceipts = (over: Partial<AppState> = {}) =>
    emptyAppState({
      receipts: [receipt('Netflix', '2026-09-05'), receipt('Netflix', '2026-06-01')],
      ...over,
    })

  const candidates = (state: AppState) =>
    analyze(state, '2026-09-07').filter((f) => f.kind === 'unconfirmed_service')

  it('계정 메일만 있고 결제 영수증이 없으면 확인 후보로 올린다', () => {
    // 통신사 결합으로 내면 영수증이 안 온다. 앱이 구독 여부를 판단할 수 없으니 물어본다.
    const c = candidates(withReceipts())
    expect(c).toHaveLength(1)
    expect(c[0].candidate?.service).toBe('Netflix')
    expect(c[0].candidate?.key).toBeTruthy()
    // 금액을 지어내면 안 된다 — 그 숫자가 그대로 월 합계에 들어간다
    expect(c[0].monthlySaving).toBe(0)
    expect(c[0].candidate?.amount).toBeUndefined()
  })

  it('같은 서비스 메일이 여러 건이어도 후보는 하나다', () => {
    expect(candidates(withReceipts())).toHaveLength(1)
    expect(candidates(withReceipts())[0].detail).toContain('2건')
  })

  it('이미 등록된 구독은 후보로 올리지 않는다', () => {
    const state = withReceipts({
      subscriptions: [makeSub({ id: 'n', service: 'Netflix', category: 'ott', amount: 17000 })],
    })
    expect(candidates(state)).toHaveLength(0)
  })

  it('결제 시리즈가 잡힌 서비스는 후보로 올리지 않는다', () => {
    // 이미 증거가 있다. 여기 낄 자리가 아니다.
    const state = withReceipts({
      series: [makeSeries({ key: 'netflix', merchantRaw: 'Netflix' })],
    })
    expect(candidates(state)).toHaveLength(0)
  })

  it('"아니에요"로 정리하면 다시 스캔해도 올라오지 않는다', () => {
    // 이게 없으면 메일을 스캔할 때마다 지운 항목이 되살아나 점검 화면이 쓸모없어진다.
    const key = candidates(withReceipts())[0].candidate!.key
    const state = withReceipts({ dismissedCandidates: [key] })
    expect(candidates(state)).toHaveLength(0)
  })

  it('"구독 중이에요"로 등록하면 다음 스캔에서 중복으로 뜨지 않는다', () => {
    // 등록 시 merchantPatterns 에 같은 키가 들어가므로 이후엔 등록된 것으로 인식된다.
    const key = candidates(withReceipts())[0].candidate!.key
    const state = withReceipts({
      subscriptions: [
        makeSub({ id: 'n', service: 'Netflix', category: 'ott', amount: 17000, merchantPatterns: [key] }),
      ],
    })
    expect(candidates(state)).toHaveLength(0)
  })

  it('서비스명이 다르게 적혀도 같은 구독이면 중복으로 올리지 않는다', () => {
    // 메일마다 표기가 다르다. 정규화 키로 비교해야 중복이 안 생긴다.
    const state = emptyAppState({
      receipts: [receipt('Netflix', '2026-09-05'), receipt('NETFLIX', '2026-08-05')],
    })
    expect(candidates(state)).toHaveLength(1)
  })
})
