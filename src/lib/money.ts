// ─────────────────────────────────────────────────────────────
// 금액/주기/날짜 계산 유틸
// ─────────────────────────────────────────────────────────────

import type { Currency, Cycle, Settings, Subscription, Totals } from '../types'
import { CYCLE_LABEL } from '../types'

/** 결제 주기를 일수로 환산한다. weekly 7, monthly 30.4375, yearly 365.25 */
export function cycleToDays(cycle: Cycle, cycleDays?: number): number {
  switch (cycle) {
    case 'weekly':
      return 7
    case 'monthly':
      return 30.4375
    case 'quarterly':
      return 91.3125
    case 'semiannual':
      return 182.625
    case 'yearly':
      return 365.25
    case 'custom':
      return cycleDays && cycleDays > 0 ? cycleDays : 30.4375
  }
}

/** 결제 주기를 월수로 환산한다. monthly 1, quarterly 3, yearly 12 */
export function cycleToMonths(cycle: Cycle, cycleDays?: number): number {
  switch (cycle) {
    case 'weekly':
      return 7 / 30.4375
    case 'monthly':
      return 1
    case 'quarterly':
      return 3
    case 'semiannual':
      return 6
    case 'yearly':
      return 12
    case 'custom':
      return (cycleDays && cycleDays > 0 ? cycleDays : 30.4375) / 30.4375
  }
}

/** 자동 환율 조회 결과를 넘길 때 쓰는 컨텍스트. table/date 모두 선택적 — 안 넘기면 수동 환율만 쓴다. */
export interface FxContext {
  /** fx.ts 의 fxTable. 키는 "USD-2026-07-13" 또는 "USD-latest". */
  table?: Record<string, number>
  /** 이 결제(거래)가 일어난 날짜. 있어야 ①②단계(결제 시점 환율)를 시도한다. */
  date?: string
}

/**
 * 통화별 환율을 결정한다. 자동 조회가 실패해도 앱은 계속 동작해야 하므로 아래 순서로 폴백한다.
 *  ① table[`${cur}-${date}`]              — 결제 시점 환율
 *  ② table 안에서 date 보다 이르면서 가장 가까운 날짜 (10일 이내) — 주말/공휴일 보정
 *  ③ table[`${cur}-latest`]
 *  ④ settings.fxRates[cur]                — 수동 폴백
 *  ⑤ 1
 */
export function resolveRate(
  currency: Currency,
  settings: Settings,
  fx?: FxContext,
): { rate: number; source: 'dated' | 'nearby' | 'latest' | 'manual' | 'none'; date?: string } {
  const table = fx?.table
  const date = fx?.date

  if (table && date) {
    const dated = table[`${currency}-${date}`]
    if (typeof dated === 'number' && !Number.isNaN(dated)) {
      return { rate: dated, source: 'dated', date }
    }

    const prefix = `${currency}-`
    let bestDate: string | undefined
    for (const key of Object.keys(table)) {
      if (!key.startsWith(prefix)) continue
      const candidateDate = key.slice(prefix.length)
      if (candidateDate === 'latest' || candidateDate >= date) continue
      const diff = daysUntil(date, candidateDate)
      if (diff < 0 || diff > 10) continue
      if (!bestDate || candidateDate > bestDate) bestDate = candidateDate
    }
    if (bestDate) {
      return { rate: table[`${currency}-${bestDate}`], source: 'nearby', date: bestDate }
    }
  }

  if (table) {
    const latest = table[`${currency}-latest`]
    if (typeof latest === 'number' && !Number.isNaN(latest)) {
      return { rate: latest, source: 'latest' }
    }
  }

  const manual = settings.fxRates[currency]
  if (typeof manual === 'number' && !Number.isNaN(manual)) {
    return { rate: manual, source: 'manual' }
  }

  return { rate: 1, source: 'none' }
}

/** 외화 금액을 기준통화로 환산한다. fx 를 안 넘기면 수동 환율(settings.fxRates)만 쓴다. */
export function toBase(amount: number, currency: Currency, settings: Settings, fx?: FxContext): number {
  const { rate } = resolveRate(currency, settings, fx)
  return amount * rate
}

/** 구독 1건의 월 환산 금액(기준통화). */
export function monthlyBase(sub: Subscription, settings: Settings, fx?: FxContext): number {
  const base = toBase(sub.amount, sub.currency, settings, fx)
  return base / cycleToMonths(sub.cycle, sub.cycleDays)
}

/** 구독 1건의 연 환산 금액(기준통화). */
export function yearlyBase(sub: Subscription, settings: Settings, fx?: FxContext): number {
  return monthlyBase(sub, settings, fx) * 12
}

/** KRW 는 소수점 없이 "12,900원", 그 외는 "$9.99" 형태. */
/**
 * 사용자에게 보여줄 주기 문구.
 * 'custom' 의 라벨은 '직접입력'인데, 그건 폼에서 쓰는 입력 방식 이름이지
 * 결제 주기 설명이 아니다. 결과 화면에 그대로 나가면 뜻이 통하지 않는다.
 */
export function cycleText(cycle: Cycle, cycleDays?: number): string {
  if (cycle === 'custom') {
    const d = Math.round(cycleDays ?? cycleToDays('custom', cycleDays))
    return `${d}일마다`
  }
  return CYCLE_LABEL[cycle]
}

export function formatMoney(amount: number, currency: Currency): string {
  if (currency === 'KRW') {
    return `${Math.round(amount).toLocaleString('ko-KR')}원`
  }
  const symbols: Record<Exclude<Currency, 'KRW'>, string> = {
    USD: '$',
    EUR: '€',
    JPY: '¥',
    GBP: '£',
  }
  const symbol = symbols[currency as Exclude<Currency, 'KRW'>] ?? ''
  return `${symbol}${amount.toFixed(2)}`
}

/** 해당 월의 마지막 날짜(일)를 반환한다. */
function lastDayOfMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

/** yyyy-mm-dd 문자열을 로컬 날짜 파츠로 분해한다. */
function parseIsoDate(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((v) => parseInt(v, 10))
  return { y, m, d }
}

function toIso(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/** 날짜에 일수를 더한다(달력 기준, 넘침 허용 - 커스텀/주간/분기 등에 사용). */
function addDays(iso: string, days: number): string {
  const { y, m, d } = parseIsoDate(iso)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + Math.round(days))
  return toIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

/** 월 단위로 날짜를 전진시킨다. 월말 처리: 1/31 + 1개월 = 2/28(윤년 2/29).
 *  넘침(예: 3/31 -> 3/3) 은 절대 발생하지 않는다 - 목표월의 마지막 날로 clamp 한다. */
function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = parseIsoDate(iso)
  const totalMonthIndex0 = (m - 1) + months
  const targetYear = y + Math.floor(totalMonthIndex0 / 12)
  const targetMonthIndex0 = ((totalMonthIndex0 % 12) + 12) % 12
  const lastDay = lastDayOfMonth(targetYear, targetMonthIndex0)
  const targetDay = Math.min(d, lastDay)
  return toIso(targetYear, targetMonthIndex0 + 1, targetDay)
}

/** 다음 결제일 1회 전진. 월말 처리 주의: 1/31 + 월간 = 2/28(윤년 2/29). */
export function advanceBillingDate(dateIso: string, cycle: Cycle, cycleDays?: number): string {
  switch (cycle) {
    case 'monthly':
      return addMonthsClamped(dateIso, 1)
    case 'quarterly':
      return addMonthsClamped(dateIso, 3)
    case 'semiannual':
      return addMonthsClamped(dateIso, 6)
    case 'yearly':
      return addMonthsClamped(dateIso, 12)
    case 'weekly':
      return addDays(dateIso, 7)
    case 'custom':
      return addDays(dateIso, cycleDays && cycleDays > 0 ? cycleDays : 30)
  }
}

function todayIso(): string {
  const d = new Date()
  return toIso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/** 오늘 기준 남은 일수. 과거면 음수. */
export function daysUntil(iso: string, today?: string): number {
  const t = today ?? todayIso()
  const { y: ty, m: tm, d: td } = parseIsoDate(t)
  const { y, m, d } = parseIsoDate(iso)
  const a = Date.UTC(ty, tm - 1, td)
  const b = Date.UTC(y, m - 1, d)
  return Math.round((b - a) / (1000 * 60 * 60 * 24))
}

/** status 가 'active' | 'trial' 인 것만 합산.
 *  upcoming 은 nextBillingDate 가 오늘~+settings.upcomingWindowDays 인 것, 날짜 오름차순. */
export function computeTotals(
  subs: Subscription[],
  settings: Settings,
  today?: string,
  fx?: FxContext,
): Totals {
  const t = today ?? todayIso()
  const counted = subs.filter((s) => s.status === 'active' || s.status === 'trial')

  let monthly = 0
  const byCategoryMap = new Map<string, { monthly: number; count: number }>()
  const byCurrencyMap = new Map<string, { monthly: number; count: number }>()
  const byPaymentMethodMap = new Map<string, { monthly: number; count: number }>()

  for (const sub of counted) {
    const m = monthlyBase(sub, settings, fx)
    monthly += m

    const cat = byCategoryMap.get(sub.category) ?? { monthly: 0, count: 0 }
    cat.monthly += m
    cat.count += 1
    byCategoryMap.set(sub.category, cat)

    const cur = byCurrencyMap.get(sub.currency) ?? { monthly: 0, count: 0 }
    cur.monthly += m
    cur.count += 1
    byCurrencyMap.set(sub.currency, cur)

    const method = sub.paymentMethod ?? '미지정'
    const pm = byPaymentMethodMap.get(method) ?? { monthly: 0, count: 0 }
    pm.monthly += m
    pm.count += 1
    byPaymentMethodMap.set(method, pm)
  }

  const upcoming = counted
    .filter((s) => {
      const diff = daysUntil(s.nextBillingDate, t)
      return diff >= 0 && diff <= settings.upcomingWindowDays
    })
    .map((s) => ({
      sub: s,
      date: s.nextBillingDate,
      amountBase: toBase(s.amount, s.currency, settings, fx),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  return {
    monthly,
    yearly: monthly * 12,
    activeCount: counted.length,
    byCategory: Array.from(byCategoryMap.entries()).map(([category, v]) => ({
      category: category as Subscription['category'],
      monthly: v.monthly,
      count: v.count,
    })),
    byCurrency: Array.from(byCurrencyMap.entries()).map(([currency, v]) => ({
      currency: currency as Currency,
      monthly: v.monthly,
      count: v.count,
    })),
    byPaymentMethod: Array.from(byPaymentMethodMap.entries()).map(([method, v]) => ({
      method,
      monthly: v.monthly,
      count: v.count,
    })),
    upcoming,
  }
}
