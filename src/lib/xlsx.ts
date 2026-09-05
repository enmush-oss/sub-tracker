// ─────────────────────────────────────────────────────────────
// 엑셀(.xlsx) 리더 — 의존성 없음.
//
// xlsx 는 XML 몇 개를 zip 으로 묶은 것뿐이고, 브라우저에는 이미
// DecompressionStream('deflate-raw') 이 있다. SheetJS 를 붙이면 번들이 두 배가 되고,
// npm 배포판은 오래 방치돼 알려진 취약점이 남아 있다. 직접 읽는 게 낫다.
//
// 카드사 "엑셀 다운로드"가 주는 파일은 세 종류다:
//  1. 진짜 xlsx (zip)            → 여기서 읽는다
//  2. 확장자만 .xls 인 HTML 표    → html.ts 가 읽는다. 국내 카드사에 아주 흔하다
//  3. 진짜 .xls (BIFF 바이너리)   → 못 읽는다. 안내 메시지를 준다
// ─────────────────────────────────────────────────────────────

/** 표 형태로 읽어낸 결과. CSV 파서 출력과 같은 모양이라 뒷단이 구분할 필요가 없다. */
export interface SheetGrid {
  /** 시트 이름. 어느 시트를 읽었는지 사용자에게 보여주기 위해 쓴다. */
  sheetName: string
  /** 행 배열. 각 행은 셀 문자열 배열이고, 뒤쪽 빈 칸은 잘려 있을 수 있다. */
  rows: string[][]
}

export class XlsxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XlsxError'
  }
}

// ─── ZIP ─────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

interface ZipEntry {
  name: string
  method: number
  offset: number
  compressedSize: number
}

/**
 * 중앙 디렉터리를 읽어 항목 목록을 만든다.
 * 로컬 헤더를 앞에서부터 훑는 방법도 있지만, 그쪽은 크기가 0 으로 적히고
 * data descriptor 로 뒤에 붙는 경우가 있어 신뢰할 수 없다.
 */
function readCentralDirectory(b: Uint8Array): ZipEntry[] {
  // EOCD 는 파일 끝에 있다. 주석이 최대 64KB 라 그 범위만 뒤에서 찾는다.
  let eocd = -1
  const from = Math.max(0, b.length - (0xffff + 22))
  for (let i = b.length - 22; i >= from; i--) {
    if (u32(b, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new XlsxError('엑셀 파일 구조를 읽지 못했습니다. 파일이 손상됐을 수 있습니다.')

  const count = u16(b, eocd + 10)
  let p = u32(b, eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (u32(b, p) !== CEN_SIG) break
    const nameLen = u16(b, p + 28)
    const extraLen = u16(b, p + 30)
    const commentLen = u16(b, p + 32)
    entries.push({
      name: new TextDecoder('utf-8').decode(b.subarray(p + 46, p + 46 + nameLen)),
      method: u16(b, p + 10),
      compressedSize: u32(b, p + 20),
      offset: u32(b, p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** zip 에서 파일 하나를 꺼내 문자열로 준다. 없으면 undefined. */
async function readZipText(
  b: Uint8Array,
  entries: ZipEntry[],
  name: string,
): Promise<string | undefined> {
  const e = entries.find((x) => x.name === name)
  if (!e) return undefined

  // 중앙 디렉터리의 offset 은 로컬 헤더 위치다. 실제 데이터는 이름·extra 길이만큼 뒤에 있고,
  // 이 두 길이는 중앙 디렉터리 쪽 값과 다를 수 있어서 로컬 헤더에서 다시 읽어야 한다.
  const lh = e.offset
  const dataStart = lh + 30 + u16(b, lh + 26) + u16(b, lh + 28)
  const raw = b.subarray(dataStart, dataStart + e.compressedSize)
  const out = e.method === 0 ? raw : await inflateRaw(raw)
  return new TextDecoder('utf-8').decode(out)
}

// ─── XML ─────────────────────────────────────────────────────
// DOMParser 는 Node 테스트 환경에 없다. xlsx 의 XML 은 기계가 만든 평평한 구조라
// 스캐너로 충분하다.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

export function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[ent] ?? m
  })
}

/** `<tag ...>` 의 속성 하나를 꺼낸다. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? unescapeXml(m[1]) : undefined
}

/** 여는 태그 하나하나를 순회한다. 자기닫힘(`<c/>`)인지도 알려준다. */
function* eachTag(xml: string, tagName: string): Generator<{ tag: string; end: number; selfClosing: boolean }> {
  const re = new RegExp(`<${tagName}(\\s[^>]*?)?(/?)>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    yield { tag: m[0], end: re.lastIndex, selfClosing: m[2] === '/' }
  }
}

/** 여는 태그 끝 위치부터 대응하는 닫는 태그까지의 내용. */
function innerFrom(xml: string, start: number, tagName: string): string {
  const close = xml.indexOf(`</${tagName}>`, start)
  return close < 0 ? '' : xml.slice(start, close)
}

/** 안에 있는 모든 `<t>` 텍스트를 이어붙인다. 서식이 섞인 셀은 여러 조각으로 온다. */
function joinText(xml: string): string {
  let out = ''
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out += unescapeXml(m[1] ?? '')
  return out
}

// ─── 셀 ──────────────────────────────────────────────────────

/** "BC12" → 54 (0-based 열 번호) */
export function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

/**
 * 엑셀 날짜 일련번호 → "yyyy-mm-dd".
 * 기준일이 1899-12-30 인 건 엑셀이 1900 년을 윤년으로 잘못 세기 때문이다.
 */
export function serialToDate(serial: number): string {
  const ms = Math.round(serial * 86400000)
  const d = new Date(Date.UTC(1899, 11, 30) + ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 내장 날짜 서식 id. 14~17,22 는 날짜/일시다. */
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 22])

/** styles.xml → 스타일 인덱스별 "날짜인가" 표. */
function parseDateStyles(stylesXml: string | undefined): boolean[] {
  if (!stylesXml) return []

  // 사용자 지정 서식 중 y/m/d 가 들어간 것도 날짜로 본다.
  const custom = new Map<number, boolean>()
  for (const { tag } of eachTag(stylesXml, 'numFmt')) {
    const id = Number(attr(tag, 'numFmtId'))
    const code = attr(tag, 'formatCode') ?? ''
    // [$-409] 같은 로케일 접두어와 따옴표 안 리터럴은 서식 문자가 아니다.
    const bare = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')
    if (Number.isFinite(id)) custom.set(id, /[ymd]/i.test(bare))
  }

  const cellXfs = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(stylesXml)?.[0]
  if (!cellXfs) return []

  const out: boolean[] = []
  for (const { tag } of eachTag(cellXfs, 'xf')) {
    const id = Number(attr(tag, 'numFmtId') ?? 0)
    out.push(BUILTIN_DATE_FMT.has(id) || custom.get(id) === true)
  }
  return out
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return []
  const out: string[] = []
  for (const { end, selfClosing } of eachTag(xml, 'si')) {
    out.push(selfClosing ? '' : joinText(innerFrom(xml, end, 'si')))
  }
  return out
}

function parseSheet(xml: string, shared: string[], dateStyles: boolean[]): string[][] {
  const rows: string[][] = []

  for (const row of eachTag(xml, 'row')) {
    if (row.selfClosing) continue
    const body = innerFrom(xml, row.end, 'row')
    const cells: string[] = []

    for (const c of eachTag(body, 'c')) {
      const ref = attr(c.tag, 'r')
      const idx = ref ? colIndex(ref) : cells.length
      const type = attr(c.tag, 't') ?? 'n'
      const styleIdx = Number(attr(c.tag, 's') ?? -1)

      let value = ''
      if (!c.selfClosing) {
        const inner = innerFrom(body, c.end, 'c')
        if (type === 'inlineStr') {
          value = joinText(inner)
        } else {
          const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1]
          if (v != null) {
            const raw = unescapeXml(v)
            if (type === 's') {
              value = shared[Number(raw)] ?? ''
            } else if (type === 'b') {
              value = raw === '1' ? 'TRUE' : 'FALSE'
            } else if (dateStyles[styleIdx] && raw !== '' && Number.isFinite(Number(raw))) {
              value = serialToDate(Number(raw))
            } else {
              value = raw
            }
          }
        }
      }

      while (cells.length < idx) cells.push('')
      cells[idx] = value
    }
    rows.push(cells)
  }
  return rows
}

/** workbook 에서 첫 시트의 파일 경로와 이름을 찾는다. */
function firstSheetPath(
  workbook: string | undefined,
  rels: string | undefined,
  entries: ZipEntry[],
): { path: string; name: string } {
  const fallback = entries.find((e) => /^xl\/worksheets\/.*\.xml$/.test(e.name))?.name

  for (const { tag } of eachTag(workbook ?? '', 'sheet')) {
    const name = attr(tag, 'name') ?? '시트1'
    const rid = attr(tag, 'r:id') ?? attr(tag, 'id')
    if (rid && rels) {
      for (const r of eachTag(rels, 'Relationship')) {
        if (attr(r.tag, 'Id') !== rid) continue
        const target = (attr(r.tag, 'Target') ?? '').replace(/^\/?xl\//, '').replace(/^\//, '')
        const path = target.startsWith('worksheets/') ? `xl/${target}` : `xl/${target}`
        if (entries.some((e) => e.name === path)) return { path, name }
      }
    }
    if (fallback) return { path: fallback, name }
  }

  if (!fallback) throw new XlsxError('엑셀 파일에서 시트를 찾지 못했습니다.')
  return { path: fallback, name: '시트1' }
}

/** xlsx 바이트를 표로 읽는다. 첫 번째 시트만 읽는다. */
export async function parseXlsx(bytes: Uint8Array): Promise<SheetGrid> {
  const entries = readCentralDirectory(bytes)
  if (!entries.some((e) => e.name.startsWith('xl/'))) {
    throw new XlsxError('엑셀 파일이 아닙니다. zip 안에 시트가 없습니다.')
  }

  const [workbook, rels, sharedXml, stylesXml] = await Promise.all([
    readZipText(bytes, entries, 'xl/workbook.xml'),
    readZipText(bytes, entries, 'xl/_rels/workbook.xml.rels'),
    readZipText(bytes, entries, 'xl/sharedStrings.xml'),
    readZipText(bytes, entries, 'xl/styles.xml'),
  ])

  const { path, name } = firstSheetPath(workbook, rels, entries)
  const sheetXml = await readZipText(bytes, entries, path)
  if (!sheetXml) throw new XlsxError('엑셀 시트를 읽지 못했습니다.')

  return {
    sheetName: name,
    rows: parseSheet(sheetXml, parseSharedStrings(sharedXml), parseDateStyles(stylesXml)),
  }
}
