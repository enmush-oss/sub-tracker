import { describe, it, expect } from 'vitest'
import { parseAmount, parseCsvText, parseKoreanDate, rowsToTxns, suggestMapping } from '../csv'

describe('parseKoreanDate', () => {
  it('parses dot-separated dates', () => {
    expect(parseKoreanDate('2025.03.14')).toBe('2025-03-14')
  })
  it('parses dash-separated dates', () => {
    expect(parseKoreanDate('2025-03-14')).toBe('2025-03-14')
  })
  it('parses 2-digit year slash dates as 2000s', () => {
    expect(parseKoreanDate('25/03/14')).toBe('2025-03-14')
  })
  it('parses compact yyyymmdd', () => {
    expect(parseKoreanDate('20250314')).toBe('2025-03-14')
  })
  it('parses Korean literal date', () => {
    expect(parseKoreanDate('2025년 3월 14일')).toBe('2025-03-14')
  })
  it('parses dates with trailing time', () => {
    expect(parseKoreanDate('2025.03.14 13:22')).toBe('2025-03-14')
  })
  it('returns null for garbage', () => {
    expect(parseKoreanDate('not-a-date')).toBeNull()
    expect(parseKoreanDate('2025.13.40')).toBeNull()
    expect(parseKoreanDate('')).toBeNull()
  })
})

describe('parseAmount', () => {
  it('parses comma-separated amounts', () => {
    expect(parseAmount('12,900')).toBe(12900)
  })
  it('parses amounts with won suffix', () => {
    expect(parseAmount('12,900원')).toBe(12900)
  })
  it('treats negative amounts as absolute spend', () => {
    expect(parseAmount('-12,900')).toBe(12900)
  })
  it('treats parenthesized amounts as absolute spend', () => {
    expect(parseAmount('(12,900)')).toBe(12900)
  })
  it('parses decimal amounts', () => {
    expect(parseAmount('12900.00')).toBe(12900)
  })
  it('returns null for garbage', () => {
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
  })
})

describe('parseCsvText', () => {
  it('skips leading banner lines and finds the real header', () => {
    const text = [
      'OO카드 이용대금명세서',
      '고객님의 이용을 감사드립니다',
      '2026년 09월 청구서',
      '이용일,가맹점명,이용금액',
      '2025.03.14,스타벅스 OO점,4500',
      '2025.03.15,넷플릭스,17000',
    ].join('\n')
    const { headers, rows } = parseCsvText(text)
    expect(headers).toEqual(['이용일', '가맹점명', '이용금액'])
    expect(rows).toHaveLength(2)
    expect(rows[0]['가맹점명']).toBe('스타벅스 OO점')
  })

  it('does not split commas inside quotes', () => {
    const text = ['이용일,가맹점명,이용금액', '2025.03.14,"스타벅스, OO점",4500'].join('\n')
    const { rows } = parseCsvText(text)
    expect(rows).toHaveLength(1)
    expect(rows[0]['가맹점명']).toBe('스타벅스, OO점')
    expect(rows[0]['이용금액']).toBe('4500')
  })
})

describe('suggestMapping', () => {
  it('maps Korean headers to fields', () => {
    const mapping = suggestMapping(['이용일', '가맹점명', '이용금액'])
    expect(mapping.date).toBe('이용일')
    expect(mapping.merchant).toBe('가맹점명')
    expect(mapping.amount).toBe('이용금액')
  })
})

describe('rowsToTxns', () => {
  it('drops rows with unparsable date/amount or non-positive amount', () => {
    const rows = [
      { 날짜: '2025.03.14', 가맹점: '넷플릭스', 금액: '17,000' },
      { 날짜: 'garbage', 가맹점: '넷플릭스', 금액: '17,000' },
      { 날짜: '2025.03.15', 가맹점: '넷플릭스', 금액: '0' },
    ]
    const txns = rowsToTxns(rows, { date: '날짜', merchant: '가맹점', amount: '금액' }, { defaultCurrency: 'KRW' })
    expect(txns).toHaveLength(1)
    expect(txns[0].amount).toBe(17000)
    expect(txns[0].date).toBe('2025-03-14')
  })
})
