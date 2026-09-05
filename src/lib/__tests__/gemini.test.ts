/**
 * 판독기는 남의 모델이 뱉은 JSON 을 받는다. 스키마를 걸어놨어도 형태가 어긋날 수 있고,
 * 그때 앱이 죽으면 안 된다. 여기 테스트는 전부 "이상한 응답이 와도 버틴다" 를 확인한다.
 */
import { describe, it, expect } from 'vitest'
import { parseReadResponse, type ReadRequest } from '../gemini'

const items: ReadRequest[] = [
  { key: 'paddlenetsetapp', merchantRaw: 'PADDLE.NET* SETAPP' },
  { key: 'emart24', merchantRaw: '이마트24 역삼점' },
  { key: 'niceopenai', merchantRaw: 'NICE정보통신(주) OPENAI' },
]

/** 실제 API 응답 껍데기. text 안에 JSON 문자열이 들어온다. */
function envelope(payload: unknown) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }
}

describe('parseReadResponse', () => {
  it('정상 응답을 인덱스로 되돌려 붙인다', () => {
    const out = parseReadResponse(
      envelope({
        results: [
          { index: 1, service: 'Setapp', category: 'productivity', isSubscription: true, confidence: 0.95 },
          { index: 2, service: '이마트24', category: 'other', isSubscription: false, confidence: 0.99 },
        ],
      }),
      items,
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ key: 'paddlenetsetapp', service: 'Setapp', category: 'productivity' })
    expect(out[1].isSubscription).toBe(false)
  })

  it('알 수 없는 카테고리는 버린다', () => {
    // 모델이 'streaming' 같은 걸 지어내도 Category 유니온이 오염되면 안 된다.
    const out = parseReadResponse(
      envelope({ results: [{ index: 1, category: 'streaming', isSubscription: true, confidence: 0.9 }] }),
      items,
    )
    expect(out[0].category).toBeUndefined()
  })

  it('0~100 으로 준 확신도를 0~1 로 맞춘다', () => {
    const out = parseReadResponse(
      envelope({ results: [{ index: 1, isSubscription: true, confidence: 95 }] }),
      items,
    )
    expect(out[0].confidence).toBeCloseTo(0.95)
  })

  it('확신도를 0~1 밖으로 주면 잘라낸다', () => {
    const out = parseReadResponse(
      envelope({
        results: [
          { index: 1, isSubscription: true, confidence: -3 },
          { index: 2, isSubscription: true, confidence: 250 },
        ],
      }),
      items,
    )
    expect(out[0].confidence).toBe(0)
    expect(out[1].confidence).toBe(1)
  })

  it('범위 밖 인덱스는 무시한다', () => {
    const out = parseReadResponse(
      envelope({
        results: [
          { index: 99, service: '유령', isSubscription: true, confidence: 1 },
          { index: 0, service: '0번', isSubscription: true, confidence: 1 },
          { index: 3, service: 'OpenAI', isSubscription: true, confidence: 1 },
        ],
      }),
      items,
    )
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('niceopenai')
  })

  it('같은 항목을 두 번 주면 첫 번째만 쓴다', () => {
    const out = parseReadResponse(
      envelope({
        results: [
          { index: 1, service: '먼저', isSubscription: true, confidence: 0.9 },
          { index: 1, service: '나중', isSubscription: true, confidence: 0.9 },
        ],
      }),
      items,
    )
    expect(out).toHaveLength(1)
    expect(out[0].service).toBe('먼저')
  })

  it('isSubscription 이 문자열이면 true 로 읽지 않는다', () => {
    // "false" 같은 문자열을 truthy 로 읽으면 편의점이 구독이 된다.
    const out = parseReadResponse(
      envelope({ results: [{ index: 2, isSubscription: 'false', confidence: 0.9 }] }),
      items,
    )
    expect(out[0].isSubscription).toBe(false)
  })

  it('빈 문자열 service 는 undefined 로 만든다', () => {
    const out = parseReadResponse(
      envelope({ results: [{ index: 1, service: '   ', isSubscription: true, confidence: 0.5 }] }),
      items,
    )
    expect(out[0].service).toBeUndefined()
  })

  it('깨진 JSON 이 와도 던지지 않고 빈 배열을 준다', () => {
    const broken = { candidates: [{ content: { parts: [{ text: '{ results: [' }] } }] }
    expect(parseReadResponse(broken, items)).toEqual([])
  })

  it('응답 껍데기가 아예 다른 모양이어도 버틴다', () => {
    expect(parseReadResponse({}, items)).toEqual([])
    expect(parseReadResponse(null, items)).toEqual([])
    expect(parseReadResponse({ candidates: [] }, items)).toEqual([])
    expect(parseReadResponse(envelope({ results: 'nope' }), items)).toEqual([])
  })
})
