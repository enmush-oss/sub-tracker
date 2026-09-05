// ─────────────────────────────────────────────────────────────
// 거래내역에서 정기결제 시리즈 탐지
// ─────────────────────────────────────────────────────────────
import type { Cycle, DetectedSeries, Subscription, Txn } from '../types'
import { guessCategory, guessServiceName, normalizeMerchant } from './normalize'

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function stddev(nums: number[]): number {
  if (nums.length === 0) return 0
  const m = nums.reduce((a, b) => a + b, 0) / nums.length
  const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function diffDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime()
  const db = new Date(b + 'T00:00:00Z').getTime()
  return Math.round((db - da) / 86400000)
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + Math.round(days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function inferCycle(medianIntervalDays: number): { cycle: Cycle; cycleDays: number } {
  if (medianIntervalDays >= 5 && medianIntervalDays <= 9) return { cycle: 'weekly', cycleDays: medianIntervalDays }
  if (medianIntervalDays >= 26 && medianIntervalDays <= 35) return { cycle: 'monthly', cycleDays: medianIntervalDays }
  if (medianIntervalDays >= 80 && medianIntervalDays <= 100) return { cycle: 'quarterly', cycleDays: medianIntervalDays }
  if (medianIntervalDays >= 170 && medianIntervalDays <= 195) return { cycle: 'semiannual', cycleDays: medianIntervalDays }
  if (medianIntervalDays >= 350 && medianIntervalDays <= 380) return { cycle: 'yearly', cycleDays: medianIntervalDays }
  return { cycle: 'custom', cycleDays: medianIntervalDays }
}

/** merchantNorm 으로 묶어서 정기결제 시리즈를 만든다. */
export function detectSeries(txns: Txn[], opts?: { minOccurrences?: number; today?: string }): DetectedSeries[] {
  const minOccurrences = opts?.minOccurrences ?? 2
  const today = opts?.today ?? new Date().toISOString().slice(0, 10)

  const groups = new Map<string, Txn[]>()
  for (const t of txns) {
    if (!t.merchantNorm) continue
    const arr = groups.get(t.merchantNorm) ?? []
    arr.push(t)
    groups.set(t.merchantNorm, arr)
  }

  const series: DetectedSeries[] = []
  for (const [key, group] of groups) {
    if (group.length < minOccurrences) continue
    const occurrences = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

    const intervals: number[] = []
    for (let i = 1; i < occurrences.length; i++) {
      intervals.push(diffDays(occurrences[i - 1].date, occurrences[i].date))
    }
    const medianIntervalDays = intervals.length > 0 ? median(intervals) : 0
    const { cycle: inferredCycle, cycleDays: inferredCycleDays } = inferCycle(medianIntervalDays)

    const amounts = occurrences.map((o) => o.amount)
    const medianAmount = median(amounts)
    const maxAmount = Math.max(...amounts)
    const minAmount = Math.min(...amounts)
    const amountSpread = medianAmount > 0 ? (maxAmount - minAmount) / medianAmount : 0

    const intervalStdDev = intervals.length > 0 ? stddev(intervals) : 0
    const intervalStdRatio = medianIntervalDays > 0 ? intervalStdDev / medianIntervalDays : 0

    const countScore = Math.min(1, Math.max(0, occurrences.length - 1) / 2)
    const amountScore = Math.max(0, 1 - amountSpread * 1.5)
    const intervalScore = Math.max(0, 1 - intervalStdRatio)

    let confidence = 0.3 * countScore + 0.35 * amountScore + 0.35 * intervalScore
    if (intervalStdRatio > 0.35) confidence = Math.min(confidence, 0.45)
    confidence = Math.max(0, Math.min(1, confidence))

    const firstSeen = occurrences[0].date
    const lastSeen = occurrences[occurrences.length - 1].date
    const nextExpected = addDays(lastSeen, inferredCycleDays)
    const stale = diffDays(lastSeen, today) > inferredCycleDays * 1.5

    series.push({
      key,
      merchantRaw: occurrences[occurrences.length - 1].merchantRaw,
      occurrences,
      medianAmount,
      currency: group[0]?.currency ?? 'KRW',
      amountSpread,
      medianIntervalDays,
      inferredCycle,
      inferredCycleDays,
      confidence,
      firstSeen,
      lastSeen,
      nextExpected,
      stale,
    })
  }

  series.sort((a, b) => b.confidence - a.confidence)
  return series
}

/** sub.merchantPatterns 중 하나가 series.key 에 포함되면 matchedSubscriptionId 를 채운다. */
export function matchSeriesToSubs(series: DetectedSeries[], subs: Subscription[]): DetectedSeries[] {
  return series.map((s) => {
    let matched: Subscription | undefined
    for (const sub of subs) {
      const patterns = sub.merchantPatterns.length > 0 ? sub.merchantPatterns : [normalizeMerchant(sub.service)]
      if (patterns.some((p) => p && s.key.includes(p))) {
        matched = sub
        break
      }
    }
    return matched ? { ...s, matchedSubscriptionId: matched.id } : { ...s }
  })
}

/** 한 방 등록용 초안. */
export function seriesToSubscriptionDraft(s: DetectedSeries): Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'> {
  const service = guessServiceName(s.key) ?? s.merchantRaw
  const category = guessCategory(s.key)
  const currency = s.occurrences[0]?.currency ?? 'KRW'
  return {
    service,
    plan: '',
    category,
    amount: s.medianAmount,
    currency,
    cycle: s.inferredCycle,
    cycleDays: s.inferredCycle === 'custom' ? s.inferredCycleDays : undefined,
    nextBillingDate: s.nextExpected,
    startedAt: s.firstSeen,
    status: 'active',
    merchantPatterns: [s.key],
    tags: [],
  }
}
