import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeBackoffDelay,
  decodeBase64Url,
  extractBodyFromPayload,
  fetchMessage,
  parseMessageHeaders,
} from '../gmail'

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64url')
}

describe('decodeBase64Url', () => {
  it('decodes a base64url string back to UTF-8 text (including 한글)', () => {
    expect(decodeBase64Url(b64url('안녕 hello 17,000원'))).toBe('안녕 hello 17,000원')
  })

  it('handles strings without padding', () => {
    expect(decodeBase64Url(b64url('a'))).toBe('a')
  })

  it('returns empty string for empty input', () => {
    expect(decodeBase64Url('')).toBe('')
  })
})

describe('extractBodyFromPayload', () => {
  it('prefers text/plain over text/html at the same level', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>HTML 본문</p>') } },
        { mimeType: 'text/plain', body: { data: b64url('평문 본문입니다') } },
      ],
    }
    expect(extractBodyFromPayload(payload)).toBe('평문 본문입니다')
  })

  it('falls back to text/html with tags stripped when there is no text/plain', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<div>결제 <b>완료</b>되었습니다</div>') } }],
    }
    const body = extractBodyFromPayload(payload)
    expect(body).toContain('결제')
    expect(body).toContain('완료')
    expect(body).not.toContain('<')
  })

  it('walks nested multipart/mixed + multipart/alternative trees', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/html', body: { data: b64url('<p>무시됨</p>') } },
            { mimeType: 'text/plain', body: { data: b64url('중첩된 본문') } },
          ],
        },
        { mimeType: 'application/pdf', body: { data: b64url('binary-ish') } },
      ],
    }
    expect(extractBodyFromPayload(payload)).toBe('중첩된 본문')
  })

  it('returns empty string when payload is undefined or has no body', () => {
    expect(extractBodyFromPayload(undefined)).toBe('')
    expect(extractBodyFromPayload({ mimeType: 'text/plain' })).toBe('')
  })
})

describe('parseMessageHeaders', () => {
  it('extracts From/Subject/Date case-insensitively', () => {
    const headers = [
      { name: 'From', value: 'Netflix <info@netflix.com>' },
      { name: 'Subject', value: '결제가 완료되었습니다' },
      { name: 'Date', value: 'Tue, 14 Oct 2025 09:00:00 +0900' },
    ]
    expect(parseMessageHeaders(headers)).toEqual({
      from: 'Netflix <info@netflix.com>',
      subject: '결제가 완료되었습니다',
      date: 'Tue, 14 Oct 2025 09:00:00 +0900',
    })
  })

  it('returns empty strings when headers are missing or absent', () => {
    expect(parseMessageHeaders(undefined)).toEqual({ from: '', subject: '', date: '' })
    expect(parseMessageHeaders([{ name: 'X-Other', value: 'x' }])).toEqual({
      from: '',
      subject: '',
      date: '',
    })
  })
})

describe('computeBackoffDelay', () => {
  it('doubles per attempt starting at 500ms', () => {
    expect(computeBackoffDelay(0)).toBe(500)
    expect(computeBackoffDelay(1)).toBe(1000)
    expect(computeBackoffDelay(2)).toBe(2000)
    expect(computeBackoffDelay(3)).toBe(4000)
  })

  it('caps the delay at 8 seconds', () => {
    expect(computeBackoffDelay(10)).toBe(8000)
  })
})

describe('fetchMessage (fetch mocked, no network)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sends a bearer token and parses headers + body from the mocked response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Netflix <info@netflix.com>' },
            { name: 'Subject', value: '결제 완료' },
            { name: 'Date', value: '2025-10-14T00:00:00Z' },
          ],
          body: { data: b64url('17,000원이 결제되었습니다.') },
        },
      }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const auth = { accessToken: 'test-token', expiresAt: Date.now() + 60_000 }
    const result = await fetchMessage(auth, 'msg-1')

    expect(result).toEqual({
      id: 'msg-1',
      from: 'Netflix <info@netflix.com>',
      subject: '결제 완료',
      date: '2025-10-14T00:00:00Z',
      body: '17,000원이 결제되었습니다.',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/messages/msg-1')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' })
  })
})
