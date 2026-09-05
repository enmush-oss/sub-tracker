// ─────────────────────────────────────────────────────────────
// 환율 자동 조회 — Frankfurter API(ECB 공시환율) 기반.
// 과거 날짜 환율은 영구 캐시, latest 는 6시간 TTL(settings.fxUpdatedAt 로 판단).
// ─────────────────────────────────────────────────────────────

import type { AppState, Currency } from '../types'

export const FX_ENDPOINT = 'https://api.frankfurter.dev/v1'

/** 동시 요청 상한. Frankfurter 는 무료 공개 API 라 과도한 동시 요청을 피한다. */
const MAX_CONCURRENT = 3

/** 환율 표 키. date 가 없으면 최신 환율 키를 만든다. */
export function fxKey(currency: Currency, date?: string): string {
  return date ? `${currency}-${date}` : `${currency}-latest`
}

/** 실패하면 throw. 호출부가 잡는다. */
export async function fetchRates(
  dateOrLatest: string,
  base: Currency,
  symbols: Currency[],
): Promise<Record<string, number>> {
  const url = `${FX_ENDPOINT}/${dateOrLatest}?base=${base}&symbols=${symbols.join(',')}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`fx fetch failed: ${res.status}`)
  }
  const json = (await res.json()) as { rates?: Record<string, number> }
  return json.rates ?? {}
}

/** 배열을 동시 실행 개수를 제한해 처리한다. 각 작업의 실패는 개별적으로 무시된다. */
async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<void> {
  let cursor = 0
  async function worker() {
    while (cursor < tasks.length) {
      const idx = cursor++
      try {
        await tasks[idx]()
      } catch (err) {
        console.warn('[fx] 환율 조회 실패, 건너뜁니다.', err)
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  await Promise.all(workers)
}

/**
 * 필요한 (통화, 날짜) 조합 중 표에 없는 것만 골라 받아온다.
 * - 같은 날짜의 여러 통화는 한 번에 요청 (symbols 파라미터)
 * - 동시 요청 3개 이하, 실패는 조용히 건너뛴다(앱이 죽으면 안 된다)
 * - 반환값은 새로 받은 항목만 담은 patch 객체
 */
export async function ensureRates(
  need: { currency: Currency; date?: string }[],
  base: Currency,
  existing: Record<string, number>,
): Promise<Record<string, number>> {
  // dateOrLatest 별로 아직 표에 없는 통화만 묶는다.
  const groups = new Map<string, Set<Currency>>()
  for (const n of need) {
    if (n.currency === base) continue
    const key = fxKey(n.currency, n.date)
    if (typeof existing[key] === 'number') continue
    const groupKey = n.date ?? 'latest'
    const set = groups.get(groupKey) ?? new Set<Currency>()
    set.add(n.currency)
    groups.set(groupKey, set)
  }

  const patch: Record<string, number> = {}
  // base=기준통화 로 한 번에 묶어 받고 역수를 취하면 요청 수는 줄지만 정밀도를 잃는다.
  // API 가 KRW→USD 를 0.00074 같은 소수로 반올림해 주기 때문에, 뒤집으면 1350.35 가
  // 1351.35 로 어긋난다. 27만원짜리 결제에서 200원이 틀어지는 오차다.
  // 그래서 통화마다 base=외화&symbols=기준통화 로 직접 조회한다. 통화 종류는 많아야 서넛이다.
  const tasks: (() => Promise<void>)[] = []
  for (const [dateOrLatest, currencies] of groups) {
    for (const cur of currencies) {
      tasks.push(async () => {
        const rates = await fetchRates(dateOrLatest, cur, [base])
        const raw = rates[base]
        if (typeof raw !== 'number' || raw <= 0) return
        const key = dateOrLatest === 'latest' ? fxKey(cur) : fxKey(cur, dateOrLatest)
        patch[key] = raw
      })
    }
  }

  await runLimited(tasks, MAX_CONCURRENT)
  return patch
}

/** 앱 상태에서 환율이 필요한 (통화, 날짜) 조합을 전부 뽑는다.
 *  - 구독: 통화가 기준통화와 다르면 latest 필요 (앞으로 나갈 돈이므로 최신 환율)
 *  - 시리즈의 각 거래(occurrences): 그 거래 날짜의 환율 필요 (과거 결제이므로 결제 시점 환율)
 *  - 영수증(receipts): receivedAt 날짜의 환율 필요 */
export function collectRateNeeds(state: AppState): { currency: Currency; date?: string }[] {
  const base = state.settings.baseCurrency
  const needs: { currency: Currency; date?: string }[] = []

  for (const sub of state.subscriptions) {
    if (sub.currency !== base) {
      needs.push({ currency: sub.currency })
    }
  }

  for (const series of state.series) {
    const currency = series.currency
    if (!currency || currency === base) continue
    for (const occ of series.occurrences) {
      needs.push({ currency, date: occ.date })
    }
  }

  for (const receipt of state.receipts) {
    if (receipt.currency && receipt.currency !== base) {
      needs.push({ currency: receipt.currency, date: receipt.receivedAt })
    }
  }

  return needs
}
