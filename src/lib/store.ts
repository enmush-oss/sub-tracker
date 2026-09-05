// ─────────────────────────────────────────────────────────────
// 로컬 저장소 — localStorage 영속화, 내보내기/가져오기, 샘플 데이터
// ─────────────────────────────────────────────────────────────

import type { AppState, EmailReceipt, Settings, Subscription } from '../types'

export const STORAGE_KEY = 'sub-tracker:v1'

export const DEFAULT_SETTINGS: Settings = {
  baseCurrency: 'KRW',
  fxAuto: true,
  fxRates: { KRW: 1, USD: 1380, EUR: 1500, JPY: 9.2, GBP: 1750 },
  zombieAfterDays: 60,
  upcomingWindowDays: 14,
}

/** crypto.randomUUID 폴백 포함한 고유 id 생성. */
export function uid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through to manual fallback
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function emptyState(): AppState {
  return {
    subscriptions: [],
    series: [],
    ignoredSeriesKeys: [],
    fxTable: {},
    receipts: [],
    settings: { ...DEFAULT_SETTINGS, fxRates: { ...DEFAULT_SETTINGS.fxRates } },
    version: 1,
  }
}

/** localStorage 접근은 전부 try/catch. 실패하면 빈 상태를 돌려준다(절대 throw 금지). */
export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw)
    return normalizeLoadedState(parsed)
  } catch {
    return emptyState()
  }
}

export function saveState(s: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // 저장 실패(시크릿 모드/용량 초과 등)는 무시한다.
  }
}

export function exportJson(s: AppState): string {
  return JSON.stringify(s, null, 2)
}

/** 검증 후 반환, 잘못되면 throw */
export function importJson(text: string): AppState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('유효한 JSON 이 아닙니다.')
  }
  return normalizeLoadedState(parsed)
}

/** 최소한의 구조 검증 후 AppState 로 정규화한다. 형식이 틀리면 throw. */
function normalizeLoadedState(parsed: unknown): AppState {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AppState 형식이 아닙니다.')
  }
  const obj = parsed as Partial<AppState>
  if (!Array.isArray(obj.subscriptions)) {
    throw new Error('subscriptions 배열이 없습니다.')
  }
  if (!Array.isArray(obj.series)) {
    throw new Error('series 배열이 없습니다.')
  }
  if (!obj.settings || typeof obj.settings !== 'object') {
    throw new Error('settings 가 없습니다.')
  }
  return {
    subscriptions: obj.subscriptions as Subscription[],
    series: obj.series,
    ignoredSeriesKeys: Array.isArray(obj.ignoredSeriesKeys) ? obj.ignoredSeriesKeys : [],
    // 이전 버전 저장분에는 receipts 가 없으므로 빈 배열로 마이그레이션한다.
    receipts: Array.isArray(obj.receipts) ? (obj.receipts as EmailReceipt[]) : [],
    // 결제 시점 환율 캐시. 과거 환율은 바뀌지 않으니 그대로 살려 재사용한다.
    fxTable:
      obj.fxTable && typeof obj.fxTable === 'object' ? (obj.fxTable as Record<string, number>) : {},
    settings: {
      baseCurrency: obj.settings.baseCurrency ?? DEFAULT_SETTINGS.baseCurrency,
      fxAuto: typeof obj.settings.fxAuto === 'boolean' ? obj.settings.fxAuto : DEFAULT_SETTINGS.fxAuto,
      fxRates: obj.settings.fxRates ?? { ...DEFAULT_SETTINGS.fxRates },
      fxUpdatedAt: obj.settings.fxUpdatedAt,
      zombieAfterDays: obj.settings.zombieAfterDays ?? DEFAULT_SETTINGS.zombieAfterDays,
      upcomingWindowDays: obj.settings.upcomingWindowDays ?? DEFAULT_SETTINGS.upcomingWindowDays,
    },
    version: typeof obj.version === 'number' ? obj.version : 1,
  }
}

/** 데모용 샘플 구독 6건(넷플릭스/유튜브프리미엄/ChatGPT/쿠팡와우/Google One/피트니스).
 *  "샘플 넣기" 버튼용. 그중 하나는 status 'trial', 하나는 lastUsedAt 이 90일 전. */
export function sampleState(): AppState {
  const now = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const nowIso = new Date().toISOString()

  const plusDays = (days: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + days)
    return iso(d)
  }
  const minusDays = (days: number) => plusDays(-days)

  const base = (over: Partial<Subscription>): Subscription => ({
    id: uid(),
    service: '',
    plan: '',
    category: 'other',
    amount: 0,
    currency: 'KRW',
    cycle: 'monthly',
    nextBillingDate: plusDays(7),
    status: 'active',
    merchantPatterns: [],
    tags: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...over,
  })

  const subscriptions: Subscription[] = [
    base({
      service: 'Netflix',
      paymentMethod: '신한체크 1234',
      plan: '프리미엄 4K',
      category: 'video',
      amount: 17000,
      currency: 'KRW',
      nextBillingDate: plusDays(5),
      merchantPatterns: ['netflix', '넷플릭스'],
      tags: [],
    }),
    base({
      service: 'YouTube Premium',
      paymentMethod: '신한체크 1234',
      plan: '개인',
      category: 'video',
      amount: 14900,
      currency: 'KRW',
      nextBillingDate: plusDays(10),
      merchantPatterns: ['youtube', 'google*youtube'],
      tags: [],
    }),
    base({
      service: 'ChatGPT',
      paymentMethod: '현대카드 8801',
      plan: 'Plus',
      category: 'ai',
      amount: 20,
      currency: 'USD',
      nextBillingDate: plusDays(3),
      status: 'trial',
      trialEndsAt: plusDays(3),
      merchantPatterns: ['openai', 'chatgpt'],
      tags: [],
    }),
    base({
      service: '쿠팡 와우',
      paymentMethod: '신한체크 1234',
      plan: '와우 멤버십',
      category: 'membership',
      amount: 7890,
      currency: 'KRW',
      nextBillingDate: plusDays(12),
      merchantPatterns: ['쿠팡와우', 'coupangwow'],
      tags: [],
    }),
    base({
      service: 'Google One',
      paymentMethod: '현대카드 8801',
      plan: '200GB',
      category: 'cloud',
      amount: 2900,
      currency: 'KRW',
      nextBillingDate: plusDays(20),
      merchantPatterns: ['googleone', 'googlestorage'],
      tags: [],
    }),
    base({
      service: '피트니스',
      paymentMethod: '카카오뱅크 자동이체',
      plan: '헬스장 월회원',
      category: 'fitness',
      amount: 89000,
      currency: 'KRW',
      nextBillingDate: plusDays(15),
      lastUsedAt: minusDays(90),
      merchantPatterns: ['짐앤짐', '휘트니스', '피트니스', '헬스장'],
      tags: [],
    }),
  ]

  return {
    subscriptions,
    series: [],
    ignoredSeriesKeys: [],
    fxTable: {},
    receipts: [],
    settings: { ...DEFAULT_SETTINGS, fxRates: { ...DEFAULT_SETTINGS.fxRates } },
    version: 1,
  }
}
