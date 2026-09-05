import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fxKey, fetchRates, ensureRates, FX_ENDPOINT } from '../fx'
import { toBase, resolveRate } from '../money'
import type { Settings } from '../../types'

const settings: Settings = {
  baseCurrency: 'KRW',
  fxAuto: true,
  fxRates: { KRW: 1, USD: 1380, EUR: 1500, JPY: 9.2, GBP: 1750 },
  zombieAfterDays: 60,
  upcomingWindowDays: 14,
}

function mockFetchOnce(rates: Record<string, number>, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ amount: 1, base: 'KRW', date: '2026-07-13', rates }),
  })
}

describe('fxKey', () => {
  it('날짜가 있으면 "통화-날짜" 형태', () => {
    expect(fxKey('USD', '2026-07-13')).toBe('USD-2026-07-13')
  })

  it('날짜가 없으면 "통화-latest"', () => {
    expect(fxKey('USD')).toBe('USD-latest')
  })
})

describe('fetchRates', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('base/symbols/날짜로 올바른 URL 을 만든다', async () => {
    const fetchMock = mockFetchOnce({ USD: 0.00067 })
    vi.stubGlobal('fetch', fetchMock)

    await fetchRates('2026-07-13', 'KRW', ['USD', 'EUR'])

    expect(fetchMock).toHaveBeenCalledWith(`${FX_ENDPOINT}/2026-07-13?base=KRW&symbols=USD,EUR`)
  })

  it('latest 요청도 URL 에 그대로 반영한다', async () => {
    const fetchMock = mockFetchOnce({ USD: 0.00067 })
    vi.stubGlobal('fetch', fetchMock)

    await fetchRates('latest', 'KRW', ['USD'])

    expect(fetchMock).toHaveBeenCalledWith(`${FX_ENDPOINT}/latest?base=KRW&symbols=USD`)
  })

  it('응답이 실패하면 throw 한다', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({}, false))
    await expect(fetchRates('latest', 'KRW', ['USD'])).rejects.toThrow()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })
})

describe('ensureRates', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('표에 이미 있는 조합은 재요청하지 않는다', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const patch = await ensureRates(
      [{ currency: 'USD', date: '2026-07-13' }],
      'KRW',
      { 'USD-2026-07-13': 1494.09 },
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(patch).toEqual({})
  })

  it('통화마다 base=외화&symbols=기준통화 로 직접 조회한다', async () => {
    // 정밀도 때문에 배칭하지 않는다. base=KRW 로 묶어 받고 역수를 취하면
    // 반올림 오차로 1350.35 가 1351.35 로 어긋난다.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ rates: { KRW: url.includes('base=USD') ? 1494.09 : 1300 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const patch = await ensureRates(
      [
        { currency: 'USD', date: '2026-07-13' },
        { currency: 'EUR', date: '2026-07-13' },
      ],
      'KRW',
      {},
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((c) => c[0] as string)
    expect(urls.some((u) => u.includes('base=USD') && u.includes('symbols=KRW'))).toBe(true)
    expect(urls.some((u) => u.includes('base=EUR') && u.includes('symbols=KRW'))).toBe(true)
    // 역수를 거치지 않으므로 API 가 준 값이 그대로 들어간다
    expect(patch['USD-2026-07-13']).toBe(1494.09)
    expect(patch['EUR-2026-07-13']).toBe(1300)
  })

  it('역수 반올림 오차를 만들지 않는다', async () => {
    // API 가 base=USD 로 1350.35 를 주면 그대로 써야 한다.
    // base=KRW 로 받아 1/0.00074 를 계산하면 1351.35 가 나와 0.07% 어긋난다.
    const fetchMock = mockFetchOnce({ KRW: 1350.35 })
    vi.stubGlobal('fetch', fetchMock)
    const patch = await ensureRates([{ currency: 'USD' }], 'KRW', {})
    expect(patch['USD-latest']).toBe(1350.35)
    expect(patch['USD-latest']).not.toBeCloseTo(1351.35, 1)
  })

  it('fetch 가 실패해도 throw 하지 않고 부분 결과를 반환한다', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('base=USD')) throw new Error('network down')
      return { ok: true, status: 200, json: async () => ({ rates: { KRW: 1750 } }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    const patch = await ensureRates(
      [
        { currency: 'USD' }, // 실패
        { currency: 'GBP', date: '2026-07-13' }, // 성공
      ],
      'KRW',
      {},
    )

    expect(patch['USD-latest']).toBeUndefined()
    expect(patch['GBP-2026-07-13']).toBe(1750)
  })
})

describe('resolveRate 폴백 5단계', () => {
  it('① dated — 정확한 날짜가 표에 있으면 그대로 쓴다', () => {
    const r = resolveRate('USD', settings, { table: { 'USD-2026-07-13': 1494.09 }, date: '2026-07-13' })
    expect(r).toEqual({ rate: 1494.09, source: 'dated', date: '2026-07-13' })
  })

  it('② nearby — 주말/공휴일이면 10일 이내 가장 가까운 과거 날짜를 쓴다', () => {
    // 2026-09-05 는 토요일. 직전 영업일 2026-09-04 환율만 표에 있다.
    const r = resolveRate(
      'USD',
      settings,
      { table: { 'USD-2026-09-04': 1350.35 }, date: '2026-09-05' },
    )
    expect(r.source).toBe('nearby')
    expect(r.rate).toBe(1350.35)
    expect(r.date).toBe('2026-09-04')
  })

  it('nearby 는 10일을 넘으면 쓰지 않는다', () => {
    const r = resolveRate(
      'USD',
      settings,
      { table: { 'USD-2026-08-01': 1350.35 }, date: '2026-09-05' },
    )
    expect(r.source).not.toBe('nearby')
  })

  it('③ latest — 정확한 날짜도, 가까운 날짜도 없으면 latest 를 쓴다', () => {
    const r = resolveRate('USD', settings, { table: { 'USD-latest': 1360 }, date: '2026-09-05' })
    expect(r).toEqual({ rate: 1360, source: 'latest' })
  })

  it('④ manual — table 이 아예 없으면 수동 환율을 쓴다', () => {
    const r = resolveRate('USD', settings)
    expect(r).toEqual({ rate: 1380, source: 'manual' })
  })

  it('⑤ none — 아무 것도 없으면 1', () => {
    const bare: Settings = { ...settings, fxRates: {} }
    const r = resolveRate('USD', bare)
    expect(r).toEqual({ rate: 1, source: 'none' })
  })
})

describe('회귀: 자동 환율이 수동 환율(1380)을 덮어써야 한다', () => {
  it('USD 220 을 실측 환율 1494.09 로 환산하면 328,699.8 근처', () => {
    const result = toBase(220, 'USD', settings, {
      table: { 'USD-2026-07-13': 1494.09 },
      date: '2026-07-13',
    })
    expect(result).toBeCloseTo(328699.8, 1)
    expect(result).not.toBeCloseTo(220 * 1380, 1)
  })
})
