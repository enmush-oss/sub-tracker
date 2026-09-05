import { describe, it, expect } from 'vitest'
import { analyze, FEATURE_OVERLAP_GROUPS } from '../analyze'
import type { AppState, DetectedSeries, Settings, Subscription, Txn } from '../../types'

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
