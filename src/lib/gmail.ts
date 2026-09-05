// ─────────────────────────────────────────────────────────────
// Gmail 연동 — Google Identity Services(GIS) 토큰 클라이언트 + Gmail REST API
// 읽기 전용(gmail.readonly) 스코프만 사용한다. 서버 없이 브라우저에서 동작.
// ─────────────────────────────────────────────────────────────
import type { EmailReceipt, GmailAuth } from '../types'
import { buildGmailQuery, parseReceiptEmail } from './email'

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

const CLIENT_ID_KEY = 'sub-tracker:gmail-client-id'
const AUTH_SESSION_KEY = 'sub-tracker:gmail-auth'
const GIS_SRC = 'https://accounts.google.com/gsi/client'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CONCURRENCY = 5
const MAX_RETRIES = 3

/** localStorage 에서 클라이언트 ID 를 읽는다. 설정 탭에서 사용자가 넣는다. */
export function getClientId(): string | null {
  try {
    return localStorage.getItem(CLIENT_ID_KEY)
  } catch {
    return null
  }
}

export function setClientId(id: string): void {
  try {
    localStorage.setItem(CLIENT_ID_KEY, id)
  } catch {
    // 저장 실패는 무시한다.
  }
}

interface GisTokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface GisTokenClient {
  requestAccessToken: () => void
}

interface GisGlobal {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (resp: GisTokenResponse) => void
      }) => GisTokenClient
    }
  }
}

function getGis(): GisGlobal | undefined {
  return (window as unknown as { google?: GisGlobal }).google
}

let gisPromise: Promise<void> | null = null

/** GIS 스크립트를 동적으로 로드한다. 이미 있으면 즉시 resolve. */
export function loadGis(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('브라우저 환경이 아닙니다.'))
  if (getGis()?.accounts?.oauth2) return Promise.resolve()
  if (gisPromise) return gisPromise

  gisPromise = new Promise<void>((resolve, reject) => {
    try {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`)
      if (existing) {
        existing.addEventListener('load', () => resolve())
        existing.addEventListener('error', () => reject(new Error('Google Identity Services 로드에 실패했습니다.')))
        return
      }
      const script = document.createElement('script')
      script.src = GIS_SRC
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Google Identity Services 로드에 실패했습니다.'))
      document.head.appendChild(script)
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Google Identity Services 로드에 실패했습니다.'))
    }
  }).catch((err) => {
    gisPromise = null
    throw err
  })

  return gisPromise
}

/** 토큰 요청. 팝업이 뜬다. 사용자가 거부하면 reject. */
export async function requestToken(clientId: string): Promise<GmailAuth> {
  await loadGis()
  const gis = getGis()
  if (!gis?.accounts?.oauth2) {
    throw new Error('Google Identity Services 를 사용할 수 없습니다.')
  }
  return new Promise<GmailAuth>((resolve, reject) => {
    try {
      const client = gis.accounts!.oauth2!.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPE,
        callback: (resp) => {
          if (!resp.access_token) {
            reject(new Error(resp.error_description || resp.error || '권한 요청이 거부되었습니다.'))
            return
          }
          const auth: GmailAuth = {
            accessToken: resp.access_token,
            expiresAt: Date.now() + Math.max(0, Number(resp.expires_in ?? 3600)) * 1000,
          }
          storeAuth(auth)
          resolve(auth)
        },
      })
      client.requestAccessToken()
    } catch (err) {
      reject(err instanceof Error ? err : new Error('토큰 요청에 실패했습니다.'))
    }
  })
}

/** 저장된 토큰. 만료됐으면 null. sessionStorage 에 둔다(브라우저 닫으면 사라지게). */
export function getStoredAuth(): GmailAuth | null {
  try {
    const raw = sessionStorage.getItem(AUTH_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<GmailAuth>
    if (!parsed.accessToken || typeof parsed.expiresAt !== 'number') return null
    if (Date.now() >= parsed.expiresAt) return null
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt, email: parsed.email }
  } catch {
    return null
  }
}

export function storeAuth(a: GmailAuth | null): void {
  try {
    if (!a) {
      sessionStorage.removeItem(AUTH_SESSION_KEY)
      return
    }
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(a))
  } catch {
    // 저장 실패는 무시한다.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 지수 백오프 지연(ms). 429/5xx 재시도에 사용. 최대 8초로 캡. */
export function computeBackoffDelay(attempt: number): number {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt))
}

class GmailApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function gmailFetch(auth: GmailAuth, path: string): Promise<unknown> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${GMAIL_API}${path}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      })
      if (!res.ok) {
        throw new GmailApiError(res.status, `Gmail API 오류: ${res.status}`)
      }
      return await res.json()
    } catch (err) {
      lastErr = err
      const status = err instanceof GmailApiError ? err.status : undefined
      const retryable = typeof status === 'number' && isRetryableStatus(status)
      if (!retryable || attempt === MAX_RETRIES) throw err
      await sleep(computeBackoffDelay(attempt))
    }
  }
  throw lastErr
}

interface GmailListResponse {
  messages?: { id: string }[]
  nextPageToken?: string
}

/** 쿼리로 메시지 id 목록을 가져온다. 페이지네이션 처리, maxTotal 로 상한. */
export async function listMessageIds(auth: GmailAuth, query: string, maxTotal = 200): Promise<string[]> {
  const ids: string[] = []
  try {
    let pageToken: string | undefined
    do {
      const remaining = maxTotal - ids.length
      if (remaining <= 0) break
      const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100, remaining)) })
      if (pageToken) params.set('pageToken', pageToken)
      const data = (await gmailFetch(auth, `/messages?${params.toString()}`)) as GmailListResponse
      for (const m of data.messages ?? []) {
        ids.push(m.id)
        if (ids.length >= maxTotal) break
      }
      pageToken = data.nextPageToken
    } while (pageToken && ids.length < maxTotal)
  } catch {
    // 실패해도 지금까지 모은 id 만 반환한다.
  }
  return ids
}

interface GmailMessagePart {
  mimeType?: string
  body?: { data?: string; size?: number }
  parts?: GmailMessagePart[]
}

interface GmailMessageHeader {
  name: string
  value: string
}

interface GmailMessageResponse {
  payload?: GmailMessagePart & { headers?: GmailMessageHeader[] }
}

/** base64url(패딩 없는 URL-safe base64) 문자열을 UTF-8 텍스트로 디코딩한다. */
export function decodeBase64Url(data: string): string {
  if (!data) return ''
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  try {
    if (typeof atob === 'function') {
      const binary = atob(padded)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new TextDecoder('utf-8').decode(bytes)
    }
  } catch {
    // atob 실패 시 아래 Buffer 폴백으로.
  }
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf-8')
    }
  } catch {
    // fall through
  }
  return ''
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** multipart 트리를 순회해 본문을 뽑는다. text/plain 우선, 없으면 text/html 태그 제거 후 사용. */
export function extractBodyFromPayload(payload: GmailMessagePart | undefined): string {
  if (!payload) return ''
  let plain: string | undefined
  let html: string | undefined

  function walk(part: GmailMessagePart) {
    const mime = (part.mimeType ?? '').toLowerCase()
    if (mime === 'text/plain' && part.body?.data && plain === undefined) {
      plain = decodeBase64Url(part.body.data)
    } else if (mime === 'text/html' && part.body?.data && html === undefined) {
      html = decodeBase64Url(part.body.data)
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)

  if (plain !== undefined && plain.trim()) return plain
  if (html !== undefined) return stripHtml(html)
  return ''
}

/** 헤더 배열에서 From/Subject/Date 를 대소문자 무관하게 뽑는다. */
export function parseMessageHeaders(
  headers: GmailMessageHeader[] | undefined,
): { from: string; subject: string; date: string } {
  const map = new Map<string, string>()
  for (const h of headers ?? []) {
    map.set(h.name.toLowerCase(), h.value)
  }
  return {
    from: map.get('from') ?? '',
    subject: map.get('subject') ?? '',
    date: map.get('date') ?? '',
  }
}

/** 메시지 본문을 가져와 파싱 가능한 형태로 만든다. */
export async function fetchMessage(
  auth: GmailAuth,
  id: string,
): Promise<{ id: string; from: string; subject: string; date: string; body: string }> {
  const data = (await gmailFetch(auth, `/messages/${id}?format=full`)) as GmailMessageResponse
  const { from, subject, date } = parseMessageHeaders(data.payload?.headers)
  const body = extractBodyFromPayload(data.payload)
  return { id, from, subject, date, body }
}

/** 전체 수집 파이프라인. onProgress 로 진행률을 UI 에 흘린다. 동시 5개 이하로 제한. */
export async function collectReceipts(
  auth: GmailAuth,
  opts: { months: number; maxMessages?: number; onProgress?: (done: number, total: number) => void },
): Promise<EmailReceipt[]> {
  const receipts: EmailReceipt[] = []
  try {
    const query = buildGmailQuery({ months: opts.months })
    const ids = await listMessageIds(auth, query, opts.maxMessages ?? 200)
    const total = ids.length
    let done = 0
    opts.onProgress?.(done, total)

    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            const msg = await fetchMessage(auth, id)
            return parseReceiptEmail({ ...msg, source: 'gmail' })
          } catch {
            return null
          } finally {
            done++
            opts.onProgress?.(done, total)
          }
        }),
      )
      for (const r of results) if (r) receipts.push(r)
    }
  } catch {
    // 실패해도 지금까지 모은 영수증만 반환한다.
  }
  return receipts
}
