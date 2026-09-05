/**
 * 엑셀·HTML표 리더.
 *
 * 픽스처는 파일이 아니라 메모리에서 만든다(명세서 CSV 와 같은 이유).
 * 여기서 확인하는 건 "카드사가 실제로 주는 파일 모양을 견디는가" 다.
 */
import { describe, it, expect } from 'vitest'
import { readTableFile, gridToTable } from '../csv'
import { colIndex, serialToDate, parseXlsx, XlsxError } from '../xlsx'
import { looksLikeHtmlTable, parseHtmlTable } from '../htmltable'
import { makeXlsx, makeXlsxDeflated, makeXlsxFile } from './helpers/xlsxfile'

/** 카드사 명세서 모양: 상단 안내 2줄 + 헤더 + 거래 3행 */
const STATEMENT = {
  rows: [
    ['신한카드 이용대금명세서'],
    ['조회기간: 2026.01.01 ~ 2026.09.01'],
    ['이용일자', '가맹점명', '이용금액', '결제수단'],
    [{ date: 46082 }, '(주)넷플릭스서비시스코리아', 17000, '신한체크 1234'],
    [{ date: 46113 }, 'GOOGLE *YouTube Premium', 14900, '신한체크 1234'],
    [{ date: 46143 }, '(주)티빙', 13900, '신한체크 1234'],
  ] as (string | number | { date: number } | null)[][],
  sheetName: '이용내역',
}

describe('serialToDate', () => {
  it('엑셀 일련번호를 ISO 날짜로 바꾼다', () => {
    expect(serialToDate(45292)).toBe('2024-01-01')
    expect(serialToDate(46082)).toBe('2026-03-01')
    expect(serialToDate(45658)).toBe('2025-01-01')
  })

  it('1900-03-01 이후 날짜는 엑셀과 정확히 일치한다', () => {
    // 기준일이 1899-12-30 인 건 엑셀이 1900-02-29 라는 없는 날짜를 세기 때문이다.
    // 그 가짜 하루 이전 구간(1900-01-01~02-28)은 엑셀 자체가 어긋나 있어 맞출 수 없고,
    // 카드 명세서에 나올 일도 없다. 실제로 쓰는 구간만 보증한다.
    expect(serialToDate(61)).toBe('1900-03-01')
    expect(serialToDate(36526)).toBe('2000-01-01')
  })
})

describe('colIndex', () => {
  it('열 문자를 0-based 번호로 바꾼다', () => {
    expect(colIndex('A1')).toBe(0)
    expect(colIndex('Z9')).toBe(25)
    expect(colIndex('AA1')).toBe(26)
    expect(colIndex('BC12')).toBe(54)
  })
})

describe('parseXlsx', () => {
  it('inlineStr 셀을 읽는다', async () => {
    const grid = await parseXlsx(makeXlsx(STATEMENT))
    expect(grid.sheetName).toBe('이용내역')
    expect(grid.rows[2]).toEqual(['이용일자', '가맹점명', '이용금액', '결제수단'])
  })

  it('공유 문자열 테이블을 읽는다', async () => {
    // 실제 엑셀은 거의 항상 이 방식이다
    const grid = await parseXlsx(makeXlsx({ ...STATEMENT, useSharedStrings: true }))
    expect(grid.rows[3][1]).toBe('(주)넷플릭스서비시스코리아')
    expect(grid.rows[5][1]).toBe('(주)티빙')
  })

  it('날짜 서식 셀을 일련번호가 아니라 날짜로 준다', async () => {
    const grid = await parseXlsx(makeXlsx(STATEMENT))
    expect(grid.rows[3][0]).toBe(serialToDate(46082))
    expect(grid.rows[3][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('숫자는 그대로 문자열로 준다', async () => {
    const grid = await parseXlsx(makeXlsx(STATEMENT))
    expect(grid.rows[3][2]).toBe('17000')
  })

  it('중간에 빈 셀이 있어도 열 위치가 밀리지 않는다', async () => {
    // 엑셀은 빈 셀의 <c> 를 아예 생략한다. r="C1" 를 안 보면 열이 왼쪽으로 밀린다.
    const grid = await parseXlsx(
      makeXlsx({ rows: [['A', null, 'C'], ['1', null, '3']] }),
    )
    expect(grid.rows[0]).toEqual(['A', '', 'C'])
    expect(grid.rows[1][2]).toBe('3')
  })

  it('XML 특수문자가 든 가맹점명을 원래대로 돌려놓는다', async () => {
    const grid = await parseXlsx(makeXlsx({ rows: [['A&B <씨> "디"']] }))
    expect(grid.rows[0][0]).toBe('A&B <씨> "디"')
  })

  it('DEFLATE 로 압축된 파일을 푼다', async () => {
    // 실제 엑셀이 만드는 건 항상 이쪽이다. 무압축만 테스트하면 이 경로가 비어 있게 된다.
    const grid = await parseXlsx(await makeXlsxDeflated({ ...STATEMENT, useSharedStrings: true }))
    expect(grid.sheetName).toBe('이용내역')
    expect(grid.rows[2]).toEqual(['이용일자', '가맹점명', '이용금액', '결제수단'])
    expect(grid.rows[3][1]).toBe('(주)넷플릭스서비시스코리아')
    expect(grid.rows[3][0]).toBe(serialToDate(46082))
  })

  it('zip 이 아니면 XlsxError 를 던진다', async () => {
    await expect(parseXlsx(new TextEncoder().encode('그냥,텍스트'))).rejects.toThrow(XlsxError)
  })
})

describe('readTableFile — 엑셀', () => {
  it('상단 안내문을 건너뛰고 헤더를 찾는다', async () => {
    const parsed = await readTableFile(makeXlsxFile(STATEMENT))
    expect(parsed.headers).toEqual(['이용일자', '가맹점명', '이용금액', '결제수단'])
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.format).toContain('이용내역')
  })

  it('CSV 와 같은 모양의 레코드를 준다', async () => {
    const parsed = await readTableFile(makeXlsxFile(STATEMENT))
    expect(parsed.rows[0]['가맹점명']).toBe('(주)넷플릭스서비시스코리아')
    expect(parsed.rows[0]['이용금액']).toBe('17000')
  })

  it('한국어 헤더로 컬럼 매핑을 자동 추측한다', async () => {
    const parsed = await readTableFile(makeXlsxFile(STATEMENT))
    expect(parsed.suggested.date).toBe('이용일자')
    expect(parsed.suggested.merchant).toBe('가맹점명')
    expect(parsed.suggested.amount).toBe('이용금액')
  })

  it('구형 .xls(BIFF)는 다시 저장하라고 안내한다', async () => {
    // OLE2 복합문서 시그니처
    const ole = new Uint8Array(512)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    const buf = new ArrayBuffer(ole.byteLength)
    new Uint8Array(buf).set(ole)
    await expect(readTableFile(new File([buf], 'old.xls'))).rejects.toThrow(/xlsx/)
  })
})

// ─── HTML 표 (.xls 로 위장한 것) ──────────────────────────────

const HTML_XLS = `<html><head><meta charset="utf-8"></head><body>
<table><tr><td>조회기간</td><td>2026.01 ~ 2026.09</td></tr></table>
<table>
<tr><th>이용일자</th><th>가맹점명</th><th>이용금액</th></tr>
<tr><td>2026.03.14</td><td>(주)넷플릭스서비시스코리아</td><td>17,000</td></tr>
<tr><td>2026.04.14</td><td>GOOGLE&nbsp;*YouTube&nbsp;Premium</td><td>14,900</td></tr>
<tr><td>2026.05.14</td><td>A&amp;B<br>스튜디오</td><td>9,900</td></tr>
</table></body></html>`

describe('HTML 표로 위장한 .xls', () => {
  it('HTML 인지 알아본다', () => {
    expect(looksLikeHtmlTable(HTML_XLS)).toBe(true)
    expect(looksLikeHtmlTable('이용일자,가맹점명\n2026.01.01,GS25')).toBe(false)
  })

  it('표가 여러 개면 행이 가장 많은 것을 고른다', () => {
    // 카드사는 요약용 작은 표를 앞에 붙인다. 첫 표를 집으면 조회기간만 읽게 된다.
    const grid = parseHtmlTable(HTML_XLS)
    expect(grid.rows).toHaveLength(4)
    expect(grid.rows[0]).toEqual(['이용일자', '가맹점명', '이용금액'])
  })

  it('&nbsp; 와 <br> 을 공백으로 편다', () => {
    const grid = parseHtmlTable(HTML_XLS)
    expect(grid.rows[2][1]).toBe('GOOGLE *YouTube Premium')
    expect(grid.rows[3][1]).toBe('A&B 스튜디오')
  })

  it('.xls 파일로 넣어도 표로 읽힌다', async () => {
    const parsed = await readTableFile(new File([HTML_XLS], 'statement.xls'))
    expect(parsed.format).toBe('HTML 표(.xls)')
    expect(parsed.headers).toEqual(['이용일자', '가맹점명', '이용금액'])
    expect(parsed.rows[0]['가맹점명']).toBe('(주)넷플릭스서비시스코리아')
  })
})

describe('gridToTable', () => {
  it('이름 없는 헤더 셀에 자리 이름을 붙인다', () => {
    // 빈 헤더가 둘이면 레코드 키가 겹쳐 열이 통째로 사라진다
    const t = gridToTable([
      ['날짜', '', '금액', ''],
      ['2026-01-01', 'a', '1000', 'b'],
    ])
    expect(t.headers).toEqual(['날짜', '열2', '금액', '열4'])
    expect(t.rows[0]['열2']).toBe('a')
    expect(t.rows[0]['열4']).toBe('b')
  })

  it('같은 이름의 헤더가 둘이면 구분해준다', () => {
    const t = gridToTable([
      ['금액', '금액'],
      ['1000', '2000'],
    ])
    expect(t.headers).toEqual(['금액', '금액 (2)'])
    expect(t.rows[0]['금액 (2)']).toBe('2000')
  })
})
