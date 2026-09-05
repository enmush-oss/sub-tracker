/**
 * 테스트용 카드 명세서를 메모리에서 만든다.
 *
 * 저장소에는 어떤 데이터 파일도 두지 않는다. 명세서 픽스처를 커밋해두면
 * (1) 남의 소비 내역처럼 보이고 (2) 날짜가 박제돼 시간이 지나면 전부
 * "결제 끊김"으로 잡혀 테스트가 무의미해진다. 그래서 매번 오늘 기준으로 생성한다.
 */

const CRLF = '\r\n'
const pad = (n: number) => String(n).padStart(2, '0')

/** monthsAgo 개월 전의 dayOfMonth 일. 그 달에 없는 날짜면 말일로 맞춘다. */
function dAgo(today: Date, monthsAgo: number, dayOfMonth: number): string {
  const y = today.getFullYear()
  const m = today.getMonth() - monthsAgo
  const lastDay = new Date(y, m + 1, 0).getDate()
  const dt = new Date(y, m, Math.min(dayOfMonth, lastDay))
  return `${dt.getFullYear()}.${pad(dt.getMonth() + 1)}.${pad(dt.getDate())}`
}

/** 정기 구독으로 잡혀야 하는 것들 (가맹점 표기, 금액, 결제일) */
export const RECURRING = [
  ['(주)넷플릭스서비시스코리아', 17000, 14],
  ['GOOGLE *YouTube Premium', 14900, 3],
  ['SPOTIFY P0A1B2C3', 11990, 21],
  ['OPENAI *CHATGPT SUBSCR', 29800, 7],
  ['쿠팡(주) 와우멤버십', 7890, 26],
  ['GOOGLE *Google One', 2400, 11],
  ['(주)티빙', 13900, 18],
  ['APPLE.COM/BILL', 1100, 9],
  ['짐앤짐휘트니스', 89000, 5],
  ['ADOBE CREATIVE CLOUD', 24000, 23],
] as const

/** 정기결제로 오탐하면 안 되는 불규칙 소비 */
const NOISE = ['GS25', '스타벅스', '배달의민족', '쿠팡(주)', '올리브영', '카카오T', '이마트24', '투썸플레이스']

/**
 * 한국 카드사 명세서 형태의 CSV 문자열.
 * 상단 안내문 3줄 + 헤더 + 거래 205행. 전부 가상 데이터다.
 */
export function makeStatementCsv(today = new Date()): string {
  const rows: [string, string, number][] = []

  for (const [name, amt, day] of RECURRING) {
    for (let i = 8; i >= 1; i--) rows.push([dAgo(today, i, day), name, amt])
  }
  // 결제가 끊긴 구독 (stale 로 잡혀야 함)
  for (let i = 8; i >= 6; i--) rows.push([dAgo(today, i, 16), '왓챠(주)', 7900])
  // 연 1회 결제 (yearly 로 잡혀야 함)
  rows.push([dAgo(today, 17, 2), 'JETBRAINS AMERICAS INC', 178000])
  rows.push([dAgo(today, 5, 2), 'JETBRAINS AMERICAS INC', 189000])

  // 결정적 난수 — 테스트가 실행마다 달라지면 안 된다
  let seed = 42
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let i = 0; i < 120; i++) {
    const monthsAgo = 1 + Math.floor(rnd() * 8)
    rows.push([
      dAgo(today, monthsAgo, 1 + Math.floor(rnd() * 28)),
      NOISE[Math.floor(rnd() * NOISE.length)],
      1500 + Math.floor(rnd() * 40000),
    ])
  }

  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1))

  const lines = [
    '신한카드 이용대금명세서',
    `조회기간: ${dAgo(today, 18, 1)} ~ ${dAgo(today, 0, 1)}`,
    '',
    '이용일자,가맹점명,이용금액,결제수단',
    ...rows.map((r) =>
      [r[0], JSON.stringify(r[1]), JSON.stringify(r[2].toLocaleString('en-US')), '신한체크 1234'].join(','),
    ),
  ]
  return lines.join(CRLF) + CRLF
}

// ─── EUC-KR 인코딩 ───────────────────────────────────────────
// Node/브라우저에는 euc-kr 디코더는 있어도 인코더는 없다. 외부 의존성을 붙이는 대신
// 디코더를 뒤집어 역방향 표를 만든다. 2바이트 조합이 8836개뿐이라 즉시 끝난다.

let reverseTable: Map<string, [number, number]> | null = null

function buildReverseTable(): Map<string, [number, number]> {
  if (reverseTable) return reverseTable
  const dec = new TextDecoder('euc-kr')
  const map = new Map<string, [number, number]>()
  const buf = new Uint8Array(2)
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x41; lo <= 0xfe; lo++) {
      buf[0] = hi
      buf[1] = lo
      const ch = dec.decode(buf)
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo])
    }
  }
  reverseTable = map
  return map
}

/** 문자열을 EUC-KR(CP949) 바이트로 인코딩한다. 표에 없는 문자는 '?' 로 떨어뜨린다. */
export function encodeEucKr(text: string): Uint8Array {
  const table = buildReverseTable()
  const out: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) {
      out.push(code)
      continue
    }
    const pair = table.get(ch)
    if (pair) out.push(pair[0], pair[1])
    else out.push(0x3f) // '?'
  }
  return new Uint8Array(out)
}

/** 테스트에서 바로 쓸 수 있는 File 객체. */
export function makeStatementFile(encoding: 'utf-8' | 'euc-kr', today = new Date()): File {
  const text = makeStatementCsv(today)
  const bytes = encoding === 'euc-kr' ? encodeEucKr(text) : new TextEncoder().encode(text)
  // Uint8Array 를 그대로 넘기면 SharedArrayBuffer 가능성 때문에 타입이 안 맞는다.
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  return new File([buf], `statement-${encoding}.csv`, { type: 'text/csv' })
}
