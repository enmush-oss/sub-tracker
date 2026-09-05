// ─────────────────────────────────────────────────────────────
// CSV 파일 읽기 / 파싱 / 컬럼 매핑 추측 / 날짜·금액 파서
// 외부 라이브러리 없이 직접 구현. 브라우저 내장 API만 사용.
// ─────────────────────────────────────────────────────────────
import type { ColumnMapping, Currency, ParsedCsv, Txn } from '../types'
import { normalizeMerchant } from './normalize'
import { isZip, parseXlsx, XlsxError } from './xlsx'
import { looksLikeHtmlTable, parseHtmlTable } from './htmltable'

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
  const { headers, rows } = gridToTable(lines.map((l) => parseLineFields(l, delimiter)))
  return { headers, rows, delimiter }
}

/**
 * 셀 격자에서 헤더 줄을 찾아 레코드 배열로 만든다.
 *
 * CSV·엑셀·HTML 표가 전부 이 함수를 지난다. 셋 다 같은 문제를 갖고 있어서다:
 * 위쪽에 "OO카드 이용대금명세서", "조회기간: ..." 같은 안내 줄이 몇 개 붙어 있다.
 * 컬럼 수가 가장 흔한 값을 본문으로 보고, 그 폭이 처음 나타나는 줄을 헤더로 잡는다.
 */
export function gridToTable(grid: string[][]): { headers: string[]; rows: Record<string, string>[] } {
  const cells = grid.filter((r) => r.some((c) => c.trim() !== ''))
  if (cells.length === 0) return { headers: [], rows: [] }

  const counts = cells.map((f) => f.length)
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
  if (targetCount === 0) targetCount = Math.max(...counts)

  const headerIdx = counts.findIndex((c) => c === targetCount)
  if (headerIdx === -1) return { headers: [], rows: [] }

  // 엑셀은 빈 헤더 셀을 그대로 준다. 이름이 없으면 레코드 키가 겹쳐 열이 통째로 사라진다.
  const seen = new Map<string, number>()
  const headers = cells[headerIdx].map((h, i) => {
    const base = h.trim() || `열${i + 1}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base} (${n + 1})`
  })

  const rows: Record<string, string>[] = []
  for (let i = headerIdx + 1; i < cells.length; i++) {
    if (cells[i].length !== headers.length) continue
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = cells[i][idx] ?? ''
    })
    rows.push(row)
  }
  return { headers, rows }
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
/** 바이트를 문자열로. 국내 카드사 파일은 UTF-8 이 아닌 경우가 흔해 EUC-KR 로 넘어간다. */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.slice(3)), encoding: 'utf-8' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    try {
      return { text: new TextDecoder('euc-kr', { fatal: true }).decode(bytes), encoding: 'euc-kr' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' }
    }
  }
}

/** 구형 .xls(BIFF)는 OLE2 복합문서다. 이 시그니처면 우리가 못 읽는 형식이다. */
function isOle2(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
    b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1
  )
}

/**
 * 명세서 파일 하나를 읽는다. CSV·엑셀(.xlsx)·HTML 표(.xls) 를 내용으로 구분한다.
 *
 * 확장자를 믿지 않는 이유: 국내 카드사의 "엑셀 다운로드"가 주는 .xls 는
 * 진짜 엑셀이 아니라 HTML 표인 경우가 아주 흔하다. 확장자로 갈래를 타면 그걸 놓친다.
 */
export async function readTableFile(file: File): Promise<ParsedCsv> {
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (isZip(bytes)) {
    const grid = await parseXlsx(bytes)
    const { headers, rows } = gridToTable(grid.rows)
    if (!headers.length) throw new XlsxError('엑셀 시트에서 표를 찾지 못했습니다.')
    return { headers, rows, encoding: 'xlsx', delimiter: '', suggested: suggestMapping(headers), format: `엑셀 · ${grid.sheetName}` }
  }

  if (isOle2(bytes)) {
    throw new XlsxError(
      '구형 엑셀(.xls) 형식은 읽지 못합니다. 엑셀에서 열어 .xlsx 또는 CSV 로 다시 저장해 주세요.',
    )
  }

  const { text, encoding } = decodeBytes(bytes)

  if (looksLikeHtmlTable(text)) {
    const grid = parseHtmlTable(text)
    const { headers, rows } = gridToTable(grid.rows)
    if (!headers.length) throw new XlsxError('표에서 헤더를 찾지 못했습니다.')
    return { headers, rows, encoding, delimiter: '', suggested: suggestMapping(headers), format: 'HTML 표(.xls)' }
  }

  const { headers, rows, delimiter } = parseCsvText(text)
  return { headers, rows, encoding, delimiter, suggested: suggestMapping(headers), format: 'CSV' }
}

/** @deprecated `readTableFile` 을 쓴다. 이름만 남겨둔 별칭. */
export const readCsvFile = readTableFile
