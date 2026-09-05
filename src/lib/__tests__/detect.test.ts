import { describe, it, expect } from 'vitest'
import { detectSeries, matchSeriesToSubs } from '../detect'
import { normalizeMerchant } from '../normalize'
import type { Subscription, Txn } from '../../types'

let seq = 0
function txn(date: string, amount: number, merchantRaw = '넷플릭스'): Txn {
  seq++
  return {
    id: `txn-${seq}`,
    date,
    merchantRaw,
    merchantNorm: normalizeMerchant(merchantRaw),
    amount,
    currency: 'KRW',
  }
}

describe('detectSeries', () => {
  it('detects a monthly series with identical amounts as high confidence', () => {
    const dates = ['2025-01-15', '2025-02-14', '2025-03-16', '2025-04-15', '2025-05-15', '2025-06-14']
    const txns = dates.map((d) => txn(d, 17000, '넷플릭스'))
    const series = detectSeries(txns, { today: '2025-06-20' })
    expect(series).toHaveLength(1)
    expect(series[0].inferredCycle).toBe('monthly')
    expect(series[0].confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('gives low confidence to irregular convenience-store style charges', () => {
    const txns = [
      txn('2025-01-03', 3000, 'GS25'),
      txn('2025-01-08', 15000, 'GS25'),
      txn('2025-02-20', 4200, 'GS25'),
      txn('2025-04-25', 9800, 'GS25'),
    ]
    const series = detectSeries(txns, { today: '2025-05-01' })
    expect(series).toHaveLength(1)
    expect(series[0].confidence).toBeLessThan(0.5)
  })

  it('detects a yearly series from 2 occurrences', () => {
    const txns = [txn('2023-01-10', 55000, '어도비'), txn('2024-01-10', 55000, '어도비')]
    const series = detectSeries(txns, { today: '2024-02-01' })
    expect(series).toHaveLength(1)
    expect(series[0].inferredCycle).toBe('yearly')
  })

  it('marks a series stale when the last payment is long overdue', () => {
    const dates = ['2024-11-15', '2024-12-15', '2025-01-15']
    const txns = dates.map((d) => txn(d, 9900, '왓챠'))
    const series = detectSeries(txns, { today: '2025-05-01' })
    expect(series).toHaveLength(1)
    expect(series[0].stale).toBe(true)
  })
})

describe('matchSeriesToSubs', () => {
  it('links a series to a subscription via merchantPatterns', () => {
    const txns = [txn('2025-01-15', 17000, '넷플릭스'), txn('2025-02-14', 17000, '넷플릭스')]
    const series = detectSeries(txns, { today: '2025-02-20' })
    const sub: Subscription = {
      id: 'sub-1',
      service: 'Netflix',
      plan: '프리미엄',
      category: 'video',
      amount: 17000,
      currency: 'KRW',
      cycle: 'monthly',
      nextBillingDate: '2025-03-14',
      status: 'active',
      merchantPatterns: ['넷플릭스'],
      tags: [],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const matched = matchSeriesToSubs(series, [sub])
    expect(matched[0].matchedSubscriptionId).toBe('sub-1')
  })

  it('leaves matchedSubscriptionId undefined when nothing matches', () => {
    const txns = [txn('2025-01-15', 17000, '넷플릭스'), txn('2025-02-14', 17000, '넷플릭스')]
    const series = detectSeries(txns, { today: '2025-02-20' })
    const matched = matchSeriesToSubs(series, [])
    expect(matched[0].matchedSubscriptionId).toBeUndefined()
  })
})
