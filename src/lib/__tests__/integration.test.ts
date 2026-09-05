/**
 * 엔드투엔드: 명세서 생성 → 파싱 → 정기결제 탐지.
 *
 * 명세서는 파일이 아니라 메모리에서 만든다. 저장소에 데이터 파일을 두지 않기 위해서다.
 * EUC-KR 디코딩이 제대로 되는지가 이 앱의 생명줄이라 실제 바이트로 확인한다.
 */
import { describe, it, expect } from 'vitest'
import { readCsvFile, rowsToTxns, suggestMapping } from '../csv'
import { detectSeries } from '../detect'
import type { ColumnMapping } from '../../types'
import { makeStatementFile } from './helpers/statement'

/** 명세서는 생성 시점 기준 상대 날짜다. 마지막 거래 다음날을 "오늘"로 삼으면
 *  시간이 지나도 테스트가 깨지지 않는다. */
function todayFrom(dates: string[]): string {
  const max = dates.reduce((a, b) => (a > b ? a : b))
  const d = new Date(max + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

async function pipeline(encoding: 'utf-8' | 'euc-kr') {
  const parsed = await readCsvFile(makeStatementFile(encoding))
  const mapping = { ...suggestMapping(parsed.headers), ...parsed.suggested } as ColumnMapping
  const txns = rowsToTxns(parsed.rows, mapping, { defaultCurrency: 'KRW', sourceFile: encoding })
  const today = todayFrom(txns.map((t) => t.date))
  const series = detectSeries(txns, { today })
  return { parsed, mapping, txns, series, today }
}

describe('명세서 엔드투엔드', () => {
  for (const [label, encoding] of [
    ['UTF-8', 'utf-8'],
    ['EUC-KR', 'euc-kr'],
  ] as const) {
    describe(label, () => {
      it('한글 가맹점명이 깨지지 않고 디코딩된다', async () => {
        const { parsed } = await pipeline(encoding)
        const blob = JSON.stringify(parsed.rows)
        expect(blob).toContain('넷플릭스')
        expect(blob).not.toContain('�') // 치환문자 = 인코딩 실패
      })

      it('상단 안내문 3줄을 건너뛰고 헤더를 찾는다', async () => {
        const { parsed } = await pipeline(encoding)
        expect(parsed.headers).toContain('이용일자')
        expect(parsed.headers).toContain('가맹점명')
        expect(parsed.headers).toContain('이용금액')
      })

      it('한국어 헤더로 컬럼 매핑을 자동 추측한다', async () => {
        const { mapping } = await pipeline(encoding)
        expect(mapping.date).toBe('이용일자')
        expect(mapping.merchant).toBe('가맹점명')
        expect(mapping.amount).toBe('이용금액')
      })

      it('따옴표 안의 쉼표가 든 금액을 온전히 파싱한다', async () => {
        const { txns } = await pipeline(encoding)
        expect(txns.length).toBeGreaterThan(190)
        // 178,000 이 178 로 잘리지 않았는지
        expect(txns.some((t) => t.amount === 178000)).toBe(true)
        expect(txns.every((t) => t.amount > 0)).toBe(true)
      })

      it('정기 구독 10건을 높은 확신도로 찾아낸다', async () => {
        const { series } = await pipeline(encoding)
        const confident = series.filter((s) => s.confidence >= 0.6 && !s.stale)
        const names = confident.map((s) => s.merchantRaw).join(' | ')

        for (const expected of ['넷플릭스', 'YouTube', 'SPOTIFY', 'CHATGPT', '와우멤버십', 'Google One', '티빙', 'APPLE', '짐앤짐', 'ADOBE']) {
          expect(names, `${expected} 를 정기결제로 못 찾음`).toContain(expected)
        }
      })

      it('월간 구독의 주기를 monthly 로 판정한다', async () => {
        const { series } = await pipeline(encoding)
        const netflix = series.find((s) => s.merchantRaw.includes('넷플릭스'))
        expect(netflix).toBeDefined()
        expect(netflix!.inferredCycle).toBe('monthly')
        expect(netflix!.medianAmount).toBe(17000)
        expect(netflix!.amountSpread).toBe(0)
        expect(netflix!.confidence).toBeGreaterThanOrEqual(0.9)
      })

      it('결제가 끊긴 구독을 stale 로 표시한다', async () => {
        const { series } = await pipeline(encoding)
        const watcha = series.find((s) => s.merchantRaw.includes('왓챠'))
        expect(watcha).toBeDefined()
        expect(watcha!.stale).toBe(true)
      })

      it('연 1회 결제를 yearly 로 판정한다', async () => {
        const { series } = await pipeline(encoding)
        const jb = series.find((s) => s.merchantRaw.includes('JETBRAINS'))
        expect(jb).toBeDefined()
        expect(jb!.inferredCycle).toBe('yearly')
      })

      it('불규칙한 일반 소비는 정기결제로 오탐하지 않는다', async () => {
        const { series } = await pipeline(encoding)
        for (const noise of ['스타벅스', '배달의민족', 'GS25', '올리브영']) {
          const hit = series.find((s) => s.merchantRaw.includes(noise))
          if (hit) {
            expect(hit.confidence, `${noise} 를 정기결제로 오탐 (confidence ${hit.confidence})`).toBeLessThan(0.6)
          }
        }
      })
    })
  }
})
