import { describe, it, expect } from 'vitest'
import {
  cycleToMonths,
  toBase,
  monthlyBase,
  advanceBillingDate,
  computeTotals,
  formatMoney,
} from '../money'
import type { Settings, Subscription } from '../../types'

const settings: Settings = {
  baseCurrency: 'KRW',
  fxAuto: false,
  fxRates: { KRW: 1, USD: 1380, EUR: 1500, JPY: 9.2, GBP: 1750 },
  zombieAfterDays: 60,
  upcomingWindowDays: 14,
}

function makeSub(over: Partial<Subscription>): Subscription {
  return {
    id: over.id ?? 'sub-1',
    service: 'Test',
    plan: '',
    category: 'other',
    amount: 0,
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

describe('cycleToMonths / monthlyBase', () => {
  it('연간 120,000원 구독 -> 월 10,000원', () => {
    expect(cycleToMonths('yearly')).toBe(12)
    const sub = makeSub({ amount: 120000, currency: 'KRW', cycle: 'yearly' })
    expect(monthlyBase(sub, settings)).toBeCloseTo(10000, 5)
  })
})

describe('toBase', () => {
  it('USD 9.99, 환율 1380 -> 13,786원 근처', () => {
    const result = toBase(9.99, 'USD', settings)
    expect(result).toBeCloseTo(13786.2, 1)
  })
})

describe('advanceBillingDate', () => {
  it('2025-01-31 + monthly = 2025-02-28', () => {
    expect(advanceBillingDate('2025-01-31', 'monthly')).toBe('2025-02-28')
  })

  it('2024-01-31 + monthly = 2024-02-29 (윤년)', () => {
    expect(advanceBillingDate('2024-01-31', 'monthly')).toBe('2024-02-29')
  })

  it('2025-12-15 + monthly = 2026-01-15', () => {
    expect(advanceBillingDate('2025-12-15', 'monthly')).toBe('2026-01-15')
  })

  it('월말 뒤 다음달도 절대 넘치지 않는다 (2025-02-28 + monthly = 2025-03-28)', () => {
    const feb = advanceBillingDate('2025-01-31', 'monthly')
    const mar = advanceBillingDate(feb, 'monthly')
    expect(mar).toBe('2025-03-28')
  })

  it('yearly: 2024-02-29 + yearly = 2025-02-28', () => {
    expect(advanceBillingDate('2024-02-29', 'yearly')).toBe('2025-02-28')
  })

  it('yearly 일반 케이스', () => {
    expect(advanceBillingDate('2025-06-15', 'yearly')).toBe('2026-06-15')
  })
})

describe('computeTotals', () => {
  const subs: Subscription[] = [
    makeSub({ id: 'a', amount: 10000, cycle: 'monthly', status: 'active', nextBillingDate: '2026-01-05' }),
    makeSub({ id: 'b', amount: 5000, cycle: 'monthly', status: 'canceled', nextBillingDate: '2026-01-06' }),
    makeSub({ id: 'c', amount: 3000, cycle: 'monthly', status: 'paused', nextBillingDate: '2026-01-07' }),
    makeSub({ id: 'd', amount: 2000, cycle: 'monthly', status: 'trial', nextBillingDate: '2026-01-20' }),
    makeSub({ id: 'e', amount: 1000, cycle: 'monthly', status: 'active', nextBillingDate: '2026-03-01' }),
  ]

  it('canceled/paused 는 총합에서 제외된다', () => {
    const totals = computeTotals(subs, settings, '2026-01-01')
    expect(totals.activeCount).toBe(3) // a, d, e
    expect(totals.monthly).toBeCloseTo(10000 + 2000 + 1000, 5)
  })

  it('upcoming 은 창(window) 안의 것만 날짜순으로 나온다', () => {
    const totals = computeTotals(subs, settings, '2026-01-01')
    // window = 14 days -> 2026-01-01 ~ 2026-01-15 : only 'a' (01-05)
    expect(totals.upcoming.map((u) => u.sub.id)).toEqual(['a'])
  })
})

describe('formatMoney', () => {
  it('KRW 는 소수점 없이 원 단위', () => {
    expect(formatMoney(12900, 'KRW')).toBe('12,900원')
  })
  it('USD 는 $ 기호 + 소수점 2자리', () => {
    expect(formatMoney(9.99, 'USD')).toBe('$9.99')
  })
})
