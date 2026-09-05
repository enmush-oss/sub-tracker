// ─────────────────────────────────────────────────────────────
// CSV 파일 읽기 / 파싱 / 컬럼 매핑 추측 / 날짜·금액 파서
// 외부 라이브러리 없이 직접 구현. 브라우저 내장 API만 사용.
// ─────────────────────────────────────────────────────────────
import type { ColumnMapping, Currency, ParsedCsv, Txn } from '../types'
import { normalizeMerchant } from './normalize'

const DELIMITER_CANDIDATES = [',', ';', '\t', '|']

/** 한 줄을 구분자 기준으로 나눈다. 따옴표 안의 구분자는 무시하고, ""(이스케이프된 따옴표)를 처리한다. */
function parseLineFields(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === delimiter) {
      fields.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  fields.push(cur.trim())
  return fields
}

function detectDelimiter(lines: string[]): string {
  let best = ','
  let bestScore = -1
  for (const d of DELIMITER_CANDIDATES) {
    const counts = lines.map((l) => parseLineFields(l, d).length)
    const freq = new Map<number, number>()
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1)
    let modeCount = 0
    let modeFreq = 0
    for (const [c, f] of freq) {
      if (c > 1 && f > modeFreq) {
        modeFreq = f
        modeCount = c
      }
    }
    const score = modeFreq * modeCount
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** 구분자(, ; tab |) 자동 추정, 따옴표 이스케이프 처리, 앞쪽 안내문 줄 스킵.
 *  한국 카드사 CSV 는 상단에 "OO카드 이용대금명세서" 같은 잡줄이 1~5줄 있다.
 *  컬럼 수가 가장 많고 그 아래로 일관되게 이어지는 줄을 헤더로 잡는다. */
export function parseCsvText(text: string): { headers: string[]; rows: Record<string, string>[]; delimiter: string } {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== '')
  if (lines.length === 0) return { headers: [], rows: [], delimiter: ',' }

  const delimiter = detectDelimiter(lines)
  const parsedLines = lines.map((l) => parseLineFields(l, delimiter))
  const counts = parsedLines.map((f) => f.length)

  // 본문의 실제 컬럼 수(가장 흔한 컬럼 수, 2 이상)를 찾는다.
  const freq = new Map<number, number>()
  for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1)
  let targetCount = 0
  let targetFreq = 0
  for (const [c, f] of freq) {
    if (c > 1 && f > targetFreq) {
      targetFreq = f
      targetCount = c
    }
  }
  if (targetCount === 0) {
    // 구분자를 못 찾은 단일 컬럼 CSV
    targetCount = Math.max(...counts)
  }

  const headerIdx = counts.findIndex((c) => c === targetCount)
  if (headerIdx === -1) return { headers: [], rows: [], delimiter }

  const headers = parsedLines[headerIdx]
  const rows: Record<string, string>[] = []
  for (let i = headerIdx + 1; i < parsedLines.length; i++) {
    if (parsedLines[i].length !== headers.length) continue
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = parsedLines[i][idx] ?? ''
    })
    rows.push(row)
  }
  return { headers, rows, delimiter }
}

const FIELD_CANDIDATES: Record<'date' | 'merchant' | 'amount' | 'card', string[]> = {
  date: ['이용일자', '이용일', '거래일자', '거래일', '승인일자', '승인일', '결제일', 'date'],
  merchant: ['가맹점명', '가맹점', '이용하신곳', '내용', '적요', '상호', 'merchant', 'description'],
  amount: ['이용금액', '승인금액', '결제금액', '출금액', '거래금액', '금액', 'amount'],
  card: ['카드명', '카드번호', '카드', '결제수단'],
}

const norm = (s: string) => s.trim().toLowerCase()

/** 헤더명으로 매핑 추측. 한국어 헤더 필수 지원. */
export function suggestMapping(headers: string[]): Partial<ColumnMapping> {
  const result: Partial<ColumnMapping> = {}
  const used = new Set<string>()
  const keys = ['date', 'merchant', 'amount', 'card'] as const

  // 1차: 완전 일치
  for (const key of keys) {
    for (const h of headers) {
      if (used.has(h)) continue
      if (FIELD_CANDIDATES[key].some((c) => norm(c) === norm(h))) {
        result[key] = h
        used.add(h)
        break
      }
    }
  }
  // 2차: 부분 포함
  for (const key of keys) {
    if (result[key]) continue
    for (const h of headers) {
      if (used.has(h)) continue
      if (FIELD_CANDIDATES[key].some((c) => norm(h).includes(norm(c)))) {
        result[key] = h
        used.add(h)
        break
      }
    }
  }
  return result
}

function toIso(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${y}-${pad(mo)}-${pad(d)}`
}

/** "2025.03.14", "2025-03-14", "25/03/14", "2025년 3월 14일", "20250314",
 *  "2025.03.14 13:22" 지원. 실패시 null. 2자리 연도는 2000년대로 본다. */
export function parseKoreanDate(s: string): string | null {
  if (!s) return null
  const str = s.trim()
  if (!str) return null

  let m = str.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/)
  if (m) return toIso(+m[1], +m[2], +m[3])

  m = str.match(/^(\d{2,4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/)
  if (m) {
    let y = +m[1]
    if (m[1].length === 2) y = 2000 + y
    return toIso(y, +m[2], +m[3])
  }

  m = str.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return toIso(+m[1], +m[2], +m[3])

  return null
}

/** "12,900", "12,900원", "-12,900", "(12,900)", "12900.00" 지원. 실패시 null.
 *  음수/괄호는 절대값 지출로 본다. */
export function parseAmount(s: string): number | null {
  if (s == null) return null
  let str = String(s).trim()
  if (!str) return null
  str = str.replace(/원/g, '').replace(/[()]/g, '').replace(/,/g, '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(str)) return null
  const n = parseFloat(str)
  if (Number.isNaN(n)) return null
  return Math.abs(n)
}

function genTxnId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `txn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

export function rowsToTxns(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  opts: { sourceFile?: string; defaultCurrency: Currency },
): Txn[] {
  const out: Txn[] = []
  for (const row of rows) {
    const iso = parseKoreanDate(row[mapping.date] ?? '')
    if (!iso) continue
    const amount = parseAmount(row[mapping.amount] ?? '')
    if (amount === null || amount <= 0) continue

    const merchantRaw = (row[mapping.merchant] ?? '').trim()
    const merchantNorm = normalizeMerchant(merchantRaw)
    const card = mapping.card ? row[mapping.card]?.trim() : undefined
    const memo = mapping.memo ? row[mapping.memo]?.trim() : undefined
    const currencyRaw = mapping.currency ? row[mapping.currency]?.trim() : undefined
    const currency = (currencyRaw as Currency) || opts.defaultCurrency

    out.push({
      id: genTxnId(),
      date: iso,
      merchantRaw,
      merchantNorm,
      amount,
      currency,
      card: card || undefined,
      memo: memo || undefined,
      sourceFile: opts.sourceFile,
    })
  }
  return out
}

/** File 을 읽어 인코딩 자동 판별(utf-8 BOM / utf-8 / euc-kr(cp949)) 후 파싱.
 *  한국 카드사 CSV 는 대부분 euc-kr 이므로 반드시 TextDecoder('euc-kr') 폴백을 넣을 것.
 *  판별법: utf-8 로 fatal 디코딩 시도 -> 실패하면 euc-kr 로 재시도.
 *  euc-kr 도 실패하면 utf-8 관대 모드. */
export async function readCsvFile(file: File): Promise<ParsedCsv> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)

  let text: string
  let encoding: string
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder('utf-8').decode(bytes.slice(3))
    encoding = 'utf-8'
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      encoding = 'utf-8'
    } catch {
      try {
        text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes)
        encoding = 'euc-kr'
      } catch {
        text = new TextDecoder('utf-8').decode(bytes)
        encoding = 'utf-8'
      }
    }
  }

  const { headers, rows, delimiter } = parseCsvText(text)
  const suggested = suggestMapping(headers)
  return { headers, rows, encoding, delimiter, suggested }
}
