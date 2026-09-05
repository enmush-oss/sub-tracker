// ─────────────────────────────────────────────────────────────
// Gemini 판독기 — 사전에 없는 가맹점 이름을 읽어준다.
//
// 규칙 기반 사전(normalize.ts)은 아는 것만 안다. `PADDLE.NET* SETAPP` 이나
// `(주)엔에이치엔벅스` 같은 표기는 사람이 봐야 뭔지 알 수 있다. 그걸 대신 읽는다.
//
// 나가는 데이터는 **가맹점 문자열뿐**이다. 금액·날짜·카드번호·거래건수는 보내지 않는다.
// 판독에 필요 없기도 하고, 소비 패턴이 통째로 넘어가는 걸 막기 위해서다.
//
// 기본은 꺼져 있다. 사용자가 설정에서 키를 넣고 켤 때만 동작한다.
// ─────────────────────────────────────────────────────────────

import type { Category } from '../types'
import { CATEGORY_LABEL } from '../types'

declare const __GEMINI_API_KEY__: string

const API_KEY_STORAGE = 'sub-tracker:gemini-api-key'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

/** 무료티어에서 쓸 수 있는 모델. 빠르고 이 작업엔 충분하다. */
export const GEMINI_MODEL = 'gemini-flash-latest'

/** 한 번에 보낼 가맹점 수. 너무 크게 묶으면 모델이 뒤쪽을 성의없이 처리한다. */
export const BATCH_SIZE = 25

/** 빌드 시점에 `.dev.vars` 에서 들어온 기본 키. 없으면 빈 문자열. */
function builtinKey(): string {
  try {
    return typeof __GEMINI_API_KEY__ === 'string' ? __GEMINI_API_KEY__ : ''
  } catch {
    return ''
  }
}

/** 저장된 키 → 없으면 빌드 기본값. 남이 클론해도 설정 탭에서 넣으면 된다. */
export function getApiKey(): string | null {
  try {
    const saved = localStorage.getItem(API_KEY_STORAGE)
    if (saved) return saved
  } catch {
    /* 시크릿 모드 등 */
  }
  return builtinKey() || null
}

export function setApiKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(API_KEY_STORAGE, key.trim())
    else localStorage.removeItem(API_KEY_STORAGE)
  } catch {
    /* 저장 실패해도 이번 세션은 동작해야 한다 */
  }
}

/** 키가 `.dev.vars` 에서 온 건지. UI 에서 "이미 설정됨"을 보여주기 위해 쓴다. */
export function hasBuiltinKey(): boolean {
  return builtinKey().length > 0
}

export interface ReadRequest {
  /** 명세서에 찍힌 원문 표기 */
  merchantRaw: string
  /** 매칭 키. 응답을 되돌려 붙일 때 쓴다 */
  key: string
}

export interface ReadResult {
  key: string
  /** 사람이 아는 서비스 이름. 못 알아보면 undefined */
  service?: string
  category?: Category
  /** 구독형 서비스로 보이는지. false 면 일회성 가맹점(식당·주유소 등) */
  isSubscription: boolean
  /** 0..1 — 모델이 얼마나 확신하는지 */
  confidence: number
  /** 판단 근거 한 줄. 사용자가 틀린 판독을 알아채려면 이게 필요하다 */
  note?: string
}

const CATEGORY_KEYS = Object.keys(CATEGORY_LABEL) as Category[]

function buildPrompt(items: ReadRequest[]): string {
  const list = items.map((it, i) => `${i + 1}. ${it.merchantRaw}`).join('\n')
  return [
    '아래는 한국 카드 명세서에 찍힌 가맹점 표기다.',
    '각각이 어떤 서비스인지, 구독형 서비스인지 판별해라.',
    '',
    '규칙:',
    '- 결제대행사 표기(NICE정보통신, KG이니시스, PAYPAL, PADDLE 등)가 앞에 붙어 있으면 뒤에 오는 진짜 서비스명을 골라라.',
    '- 식당·편의점·주유소·병원처럼 일회성 결제 가맹점이면 isSubscription 을 false 로 해라.',
    '- 헬스장·학원처럼 정기 결제하는 오프라인 업체는 isSubscription 을 true 로 해라.',
    '- 모르겠으면 service 를 비우고 confidence 를 낮춰라. 지어내지 마라.',
    '- category 는 다음 중 하나여야 한다: ' + CATEGORY_KEYS.join(', '),
    '- OTT(넷플릭스·티빙 등)는 ott, 유튜브 프리미엄은 video 다. 둘을 섞지 마라.',
    '- note 는 한국어 한 문장으로 짧게.',
    '',
    '가맹점 목록:',
    list,
  ].join('\n')
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          service: { type: 'string' },
          category: { type: 'string', enum: CATEGORY_KEYS },
          isSubscription: { type: 'boolean' },
          confidence: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['index', 'isSubscription', 'confidence'],
      },
    },
  },
  required: ['results'],
}

export class GeminiError extends Error {
  constructor(
    message: string,
    /** HTTP 상태. 429 면 무료티어 한도다. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GeminiError'
  }
}

function messageForStatus(status: number, body: string): string {
  if (status === 400 && /API key not valid/i.test(body)) return 'API 키가 올바르지 않습니다.'
  if (status === 401 || status === 403) return 'API 키가 거부됐습니다. 키와 권한을 확인하세요.'
  if (status === 429) return '무료티어 한도에 걸렸습니다. 잠시 후 다시 시도하세요.'
  if (status === 503) return 'Gemini 모델이 혼잡합니다. 잠시 후 다시 시도하세요.'
  if (status >= 500) return 'Gemini 서버 오류입니다. 잠시 후 다시 시도하세요.'
  return `판독 실패 (HTTP ${status})`
}

function extractText(raw: unknown): string | undefined {
  const parts = (raw as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
    ?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return undefined
  const text = parts.map((p) => p?.text ?? '').join('')
  return text.trim() || undefined
}

/** 응답 JSON 을 ReadResult 로 바꾼다. 모델이 뭘 뱉든 여기서 방어한다. */
export function parseReadResponse(raw: unknown, items: ReadRequest[]): ReadResult[] {
  const text = extractText(raw)
  if (!text) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const rows = (parsed as { results?: unknown[] })?.results
  if (!Array.isArray(rows)) return []

  const out: ReadResult[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const r = row as Record<string, unknown>
    const idx = typeof r.index === 'number' ? r.index - 1 : -1
    const item = items[idx]
    if (!item || seen.has(item.key)) continue
    seen.add(item.key)

    const category = CATEGORY_KEYS.includes(r.category as Category)
      ? (r.category as Category)
      : undefined
    const service = typeof r.service === 'string' && r.service.trim() ? r.service.trim() : undefined
    const conf = typeof r.confidence === 'number' ? r.confidence : 0

    out.push({
      key: item.key,
      service,
      category,
      isSubscription: r.isSubscription === true,
      // 모델이 0~100 으로 주는 경우가 있다
      confidence: Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf)),
      note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined,
    })
  }
  return out
}

/**
 * 다시 시도할 가치가 있는 상태코드.
 * 503(모델 과부하)은 흔하다 — 실측으로 3번 중 2번 났다. 한 번 실패했다고 포기하면
 * 판독 기능이 "가끔 되는 버튼"이 된다.
 */
const RETRIABLE = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })

/** 가맹점 한 묶음을 판독한다. 실패하면 GeminiError 를 던진다. */
export async function readBatch(
  items: ReadRequest[],
  opts: { apiKey: string; model?: string; signal?: AbortSignal },
): Promise<ReadResult[]> {
  if (!items.length) return []
  if (!opts.apiKey) throw new GeminiError('API 키가 없습니다.')

  const url = `${ENDPOINT}/${opts.model ?? GEMINI_MODEL}:generateContent`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: buildPrompt(items) }] }],
    generationConfig: {
      // 판독은 매번 같은 답이 나와야 한다. 창의성은 방해다.
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  })

  let last: GeminiError | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      signal: opts.signal,
      body,
    })

    if (res.ok) return parseReadResponse(await res.json(), items)

    const text = await res.text().catch(() => '')
    last = new GeminiError(messageForStatus(res.status, text), res.status)
    if (!RETRIABLE.has(res.status) || attempt === MAX_RETRIES - 1) throw last

    await sleep(500 * 2 ** attempt, opts.signal)
  }
  throw last ?? new GeminiError('판독 실패')
}

/**
 * 전체를 BATCH_SIZE 씩 나눠 판독한다.
 * 중간 배치가 깨져도 앞서 성공한 결과는 살린다 — 20건 중 1건 때문에 전부 날리면 안 된다.
 */
export async function readAll(
  items: ReadRequest[],
  opts: {
    apiKey: string
    model?: string
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
  },
): Promise<{ results: ReadResult[]; error?: string }> {
  const results: ReadResult[] = []
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE)
    try {
      results.push(...(await readBatch(chunk, opts)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : '판독 실패'
      return { results, error: results.length ? `${msg} (${results.length}건은 판독됨)` : msg }
    }
    opts.onProgress?.(Math.min(i + BATCH_SIZE, items.length), items.length)
  }
  return { results }
}
