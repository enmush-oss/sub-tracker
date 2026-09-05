/**
 * 테스트용 xlsx 를 메모리에서 만든다.
 *
 * 저장소에 바이너리 픽스처를 두지 않는다는 원칙은 명세서 CSV 와 같다.
 * 무압축(stored)과 DEFLATE 둘 다 만들 수 있다. 실제 엑셀은 항상 DEFLATE 라
 * 그쪽을 테스트하지 않으면 진짜 파일이 첫 시험대가 된다.
 */

const enc = new TextEncoder()

// ─── CRC32 ───────────────────────────────────────────────────
let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * zip 을 만든다. 로컬 헤더 + 중앙 디렉터리 + EOCD.
 * `deflate` 를 주면 각 항목을 압축한다(method 8) — 실제 엑셀과 같은 경로.
 */
export function makeZip(files: Record<string, string>): Uint8Array {
  return buildZip(
    Object.entries(files).map(([name, text]) => ({ name, data: enc.encode(text), method: 0, stored: enc.encode(text) })),
  )
}

export async function makeZipDeflated(files: Record<string, string>): Promise<Uint8Array> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      const raw = enc.encode(text)
      return { name, data: await deflateRaw(raw), method: 8, stored: raw }
    }),
  )
  return buildZip(entries)
}

function buildZip(entries: { name: string; data: Uint8Array; method: number; stored: Uint8Array }[]): Uint8Array {

  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    // CRC 와 uncompressed size 는 압축 전 원본 기준이다.
    const crc = crc32(e.stored)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version
    lv.setUint16(8, e.method, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, e.data.length, true)
    lv.setUint32(22, e.stored.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, e.method, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, e.data.length, true)
    cv.setUint32(24, e.stored.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cen.set(nameBytes, 46)

    chunks.push(local, e.data)
    central.push(cen)
    offset += local.length + e.data.length
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + cdSize + 22
  const out = new Uint8Array(total)
  let p = 0
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, p)
    p += c.length
  }
  return out
}

export interface SheetSpec {
  /** 셀 값. 문자열은 inlineStr, 숫자는 그대로, {date} 는 일련번호+날짜 서식으로 쓴다. */
  rows: (string | number | { date: number } | null)[][]
  sheetName?: string
  /** 공유 문자열 테이블을 쓸지. 실제 엑셀은 거의 항상 쓴다. */
  useSharedStrings?: boolean
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function colName(i: number): string {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function xlsxFiles(spec: SheetSpec): Record<string, string> {
  const sheetName = spec.sheetName ?? '명세서'
  const shared: string[] = []
  const sharedIdx = new Map<string, number>()

  const rowXml = spec.rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) => {
          const ref = `${colName(c)}${r + 1}`
          if (v == null || v === '') return ''
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
          if (typeof v === 'object') {
            // s="1" = 아래 styles.xml 의 두 번째 xf = 날짜 서식
            return `<c r="${ref}" s="1"><v>${v.date}</v></c>`
          }
          if (spec.useSharedStrings) {
            let i = sharedIdx.get(v)
            if (i == null) {
              i = shared.length
              shared.push(v)
              sharedIdx.set(v, i)
            }
            return `<c r="${ref}" t="s"><v>${i}</v></c>`
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cs}</row>`
    })
    .join('')

  const files: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    // cellXfs: 0 = 일반, 1 = numFmtId 14 (날짜)
    'xl/styles.xml':
      '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
  }

  if (spec.useSharedStrings) {
    files['xl/sharedStrings.xml'] =
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
      shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('') +
      '</sst>'
  }

  return files
}

/** 최소한의 유효한 xlsx 바이트를 만든다(무압축). */
export function makeXlsx(spec: SheetSpec): Uint8Array {
  return makeZip(xlsxFiles(spec))
}

/** 실제 엑셀과 같은 DEFLATE 압축 xlsx. */
export function makeXlsxDeflated(spec: SheetSpec): Promise<Uint8Array> {
  return makeZipDeflated(xlsxFiles(spec))
}

/** 테스트에서 바로 쓰는 File 객체. */
export function makeXlsxFile(spec: SheetSpec, name = 'statement.xlsx'): File {
  const bytes = makeXlsx(spec)
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  return new File([buf], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
