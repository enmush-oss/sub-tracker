// ─────────────────────────────────────────────────────────────
// 확장자만 .xls 인 HTML 표를 읽는다.
//
// 국내 카드사·은행의 "엑셀 다운로드"는 진짜 엑셀이 아닌 경우가 아주 흔하다.
// `<table>` 이 든 HTML 을 .xls 로 저장해서 내려준다. 엑셀이 열어주니까 아무도 신경 안 쓴다.
// 사용자 입장에서는 "엑셀 파일"이므로 이것도 읽어야 한다.
//
// DOMParser 를 쓰지 않는다 — Node 테스트 환경에 없다. 기계가 만든 표라 스캐너로 충분하다.
// ─────────────────────────────────────────────────────────────

import { unescapeXml } from './xlsx'
import type { SheetGrid } from './xlsx'

/** 바이트가 HTML 표처럼 보이는지. 인코딩 판별 전에 불리므로 바이트로 본다. */
export function looksLikeHtmlTable(text: string): boolean {
  const head = text.slice(0, 4000).toLowerCase()
  return /<table[\s>]/.test(head) || (/<html[\s>]/.test(head) && /<t[rd][\s>]/.test(text.slice(0, 20000).toLowerCase()))
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  middot: '·',
  won: '₩',
}

/** 셀 안쪽 HTML → 사람이 보는 문자열. */
function cellText(html: string): string {
  return unescapeXml(
    html
      // <br> 은 줄바꿈이 아니라 공백으로 본다. 한 셀이 여러 줄이어도 값은 하나다.
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&(nbsp|ndash|mdash|middot|won);/gi, (m, e: string) => HTML_ENTITIES[e.toLowerCase()] ?? m),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * HTML 에서 표를 읽는다. 표가 여러 개면 **행이 가장 많은 것**을 고른다.
 * 카드사 페이지는 머리말·요약용 작은 표를 앞에 여러 개 붙여놓기 때문에
 * 첫 번째 표를 집으면 거의 항상 엉뚱한 걸 집는다.
 */
export function parseHtmlTable(text: string): SheetGrid {
  const tables = text.match(/<table[\s\S]*?<\/table>/gi) ?? []
  let best: string[][] = []

  for (const table of tables) {
    const rows: string[][] = []
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells: string[] = []
      const re = /<t([hd])(?:\s[^>]*)?>([\s\S]*?)<\/t\1>/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(tr))) cells.push(cellText(m[2]))
      if (cells.length) rows.push(cells)
    }
    if (rows.length > best.length) best = rows
  }

  if (!best.length) throw new Error('HTML 안에서 표를 찾지 못했습니다.')
  return { sheetName: 'HTML 표', rows: best }
}
