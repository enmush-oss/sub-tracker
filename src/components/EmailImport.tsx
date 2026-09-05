import { useMemo, useRef, useState } from 'react'
import type { AppState, DetectedSeries, EmailReceipt, Subscription } from '../types'
import { CYCLE_LABEL } from '../types'
import { detectSeries, matchSeriesToSubs, seriesToSubscriptionDraft } from '../lib/detect'
import { cycleText, formatMoney } from '../lib/money'
import { uid } from '../lib/store'
import {
  GMAIL_SCOPE,
  collectReceipts,
  getClientId,
  getStoredAuth,
  requestToken,
  setClientId,
  storeAuth,
} from '../lib/gmail'
import { parseReceiptEmail, parseReceiptsJson, receiptsToSeries } from '../lib/email'

interface Props {
  state: AppState
  updateState: (updater: (prev: AppState) => AppState) => void
  onRegister: (draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, seriesKey: string) => void
}

const DEFAULT_MONTHS = 12

/** 같은 key 의 시리즈를 합친다. occurrences 를 합쳐서 detect.ts 규칙으로 재계산한다.
 *  (email.ts 가 만든 단건 시리즈처럼 재계산이 불가능하면 확신도가 더 높은 쪽을 채택한다.) */
function mergeSeriesByKey(
  prevSeries: DetectedSeries[],
  incoming: DetectedSeries[],
  subs: Subscription[],
  today?: string,
): DetectedSeries[] {
  const byKey = new Map<string, DetectedSeries>()
  for (const s of prevSeries) byKey.set(s.key, s)

  for (const next of incoming) {
    const existing = byKey.get(next.key)
    if (!existing) {
      byKey.set(next.key, next)
      continue
    }
    const combined = [...existing.occurrences, ...next.occurrences]
    if (combined.length >= 2) {
      const [recomputed] = detectSeries(combined, { minOccurrences: 2, today })
      byKey.set(
        next.key,
        recomputed
          ? { ...recomputed, matchedSubscriptionId: existing.matchedSubscriptionId ?? next.matchedSubscriptionId }
          : next,
      )
    } else {
      byKey.set(next.key, next.confidence >= existing.confidence ? next : existing)
    }
  }

  const merged = Array.from(byKey.values())
  merged.sort((a, b) => b.confidence - a.confidence)
  return matchSeriesToSubs(merged, subs)
}

/** "From:/Subject:/Date:" (또는 한글 표기) 헤더 줄이 붙은 메일 원문 붙여넣기를 분해한다.
 *  헤더를 못 찾으면 전체를 본문으로 본다. */
function parseRawEmailText(raw: string): { from: string; subject: string; date: string; body: string } {
  const lines = raw.split(/\r?\n/)
  let from = ''
  let subject = ''
  let date = ''
  let headerLines = 0

  for (const line of lines) {
    const fromMatch = line.match(/^(from|보낸사람|발신)\s*[:：]\s*(.+)$/i)
    const subjectMatch = line.match(/^(subject|제목)\s*[:：]\s*(.+)$/i)
    const dateMatch = line.match(/^(date|날짜)\s*[:：]\s*(.+)$/i)
    if (fromMatch) {
      from = fromMatch[2].trim()
      headerLines++
    } else if (subjectMatch) {
      subject = subjectMatch[2].trim()
      headerLines++
    } else if (dateMatch) {
      date = dateMatch[2].trim()
      headerLines++
    } else if (headerLines > 0) {
      break
    } else if (line.trim() !== '') {
      break
    } else {
      headerLines++
    }
  }

  const body = headerLines > 0 ? lines.slice(headerLines).join('\n').trim() : raw.trim()
  return {
    from,
    subject,
    date: date || new Date().toISOString().slice(0, 10),
    body: body || raw,
  }
}

export default function EmailImport({ state, updateState, onRegister }: Props) {
  // Gmail 연동
  const [clientIdInput, setClientIdInput] = useState(() => getClientId() ?? '')
  const [savedClientId, setSavedClientId] = useState(() => getClientId())
  const [auth, setAuth] = useState(() => getStoredAuth())
  const [months, setMonths] = useState(DEFAULT_MONTHS)
  const [collecting, setCollecting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [gmailError, setGmailError] = useState<string | null>(null)
  const [lastGmailCount, setLastGmailCount] = useState<number | null>(null)

  // JSON 붙여넣기
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [jsonCount, setJsonCount] = useState<number | null>(null)
  const jsonFileRef = useRef<HTMLInputElement | null>(null)

  // 메일 본문 붙여넣기
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [pastePreview, setPastePreview] = useState<EmailReceipt | null>(null)

  // 이번에 수집/추가된 시리즈 (결과 표시용)
  const [resultKeys, setResultKeys] = useState<string[]>([])

  function ingestReceipts(newReceipts: EmailReceipt[]) {
    if (newReceipts.length === 0) return
    const incomingSeries = receiptsToSeries(newReceipts)
    setResultKeys(incomingSeries.map((s) => s.key))
    updateState((prev) => {
      const existingIds = new Set(prev.receipts.map((r) => r.id))
      const dedupedNew = newReceipts.filter((r) => !existingIds.has(r.id))
      if (dedupedNew.length === 0) return prev
      const dedupedSeries = receiptsToSeries(dedupedNew)
      const mergedSeries = mergeSeriesByKey(prev.series, dedupedSeries, prev.subscriptions)
      return {
        ...prev,
        receipts: [...prev.receipts, ...dedupedNew],
        series: mergedSeries,
      }
    })
  }

  async function handleSaveClientId() {
    const id = clientIdInput.trim()
    if (!id) return
    setClientId(id)
    setSavedClientId(id)
    setGmailError(null)
  }

  async function handleGmailScan() {
    if (!savedClientId) {
      setGmailError('OAuth 클라이언트 ID 를 먼저 등록하세요.')
      return
    }
    setGmailError(null)
    setLastGmailCount(null)
    setCollecting(true)
    setProgress({ done: 0, total: 0 })
    try {
      let currentAuth = auth ?? getStoredAuth()
      if (!currentAuth) {
        currentAuth = await requestToken(savedClientId)
        setAuth(currentAuth)
      }
      const receipts = await collectReceipts(currentAuth, {
        months,
        maxMessages: 200,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setLastGmailCount(receipts.length)
      ingestReceipts(receipts)
    } catch (err) {
      setGmailError(err instanceof Error ? err.message : 'Gmail 연동 중 오류가 발생했습니다.')
    } finally {
      setCollecting(false)
    }
  }

  function handleGmailDisconnect() {
    storeAuth(null)
    setAuth(null)
  }

  function handleJsonLoad() {
    setJsonError(null)
    setJsonCount(null)
    try {
      const receipts = parseReceiptsJson(jsonText)
      if (receipts.length === 0) {
        setJsonError('불러올 수 있는 영수증이 없습니다. 형식을 확인해주세요.')
        return
      }
      setJsonCount(receipts.length)
      ingestReceipts(receipts)
    } catch {
      setJsonError('JSON 을 읽지 못했습니다.')
    }
  }

  function handleJsonFile(file: File) {
    setJsonError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setJsonText(text)
      try {
        const receipts = parseReceiptsJson(text)
        if (receipts.length === 0) {
          setJsonError('불러올 수 있는 영수증이 없습니다. 형식을 확인해주세요.')
          return
        }
        setJsonCount(receipts.length)
        ingestReceipts(receipts)
      } catch {
        setJsonError('JSON 파일을 읽지 못했습니다.')
      }
    }
    reader.onerror = () => setJsonError('파일을 읽지 못했습니다.')
    reader.readAsText(file)
  }

  function handlePasteParse() {
    setPasteError(null)
    setPastePreview(null)
    const raw = pasteText.trim()
    if (!raw) return
    const { from, subject, date, body } = parseRawEmailText(raw)
    const receipt = parseReceiptEmail({ id: uid(), from, subject, date, body, source: 'paste' })
    if (!receipt) {
      setPasteError('구독/결제 관련 메일로 보이지 않습니다.')
      return
    }
    setPastePreview(receipt)
    ingestReceipts([receipt])
  }

  // 탭을 나갔다 오거나 새로고침해도 결과가 남아야 한다.
  // 방금 임포트한 키(로컬)와, 저장된 영수증에서 다시 유도한 키를 합쳐서 본다.
  const receiptKeys = useMemo(
    () => new Set(receiptsToSeries(state.receipts ?? []).map((s) => s.key)),
    [state.receipts],
  )
  const resultSeries = state.series.filter((s) => resultKeys.includes(s.key) || receiptKeys.has(s.key))

  function isForgotten(s: DetectedSeries) {
    return (
      !s.matchedSubscriptionId &&
      !s.stale &&
      s.confidence >= 0.6 &&
      !state.ignoredSeriesKeys.includes(s.key)
    )
  }

  function handleIgnore(key: string) {
    updateState((prev) => ({
      ...prev,
      ignoredSeriesKeys: prev.ignoredSeriesKeys.includes(key)
        ? prev.ignoredSeriesKeys
        : [...prev.ignoredSeriesKeys, key],
    }))
  }

  function handleRegister(s: DetectedSeries) {
    onRegister(seriesToSubscriptionDraft(s), s.key)
  }

  function renderSeriesCard(s: DetectedSeries) {
    const forgotten = isForgotten(s)
    const ignored = state.ignoredSeriesKeys.includes(s.key)
    return (
      <div className={`series-card${forgotten ? ' forgotten' : ''}${ignored ? ' ignored' : ''}`} key={s.key}>
        <div className="series-main">
          <div className="series-name">
            {s.merchantRaw}
            {forgotten && (
              <span className="badge badge-forgotten" style={{ marginLeft: 8 }}>
                잊고 있던 구독?
              </span>
            )}
            {s.matchedSubscriptionId && (
              <span className="pill" style={{ marginLeft: 8 }}>
                등록됨
              </span>
            )}
            {s.stale && (
              <span className="pill" style={{ marginLeft: 8 }}>
                결제 끊김
              </span>
            )}
          </div>
          <div className="series-detail">
            {formatMoney(s.medianAmount, s.currency ?? state.settings.baseCurrency)} · {cycleText(s.inferredCycle, s.inferredCycleDays)}
            {' · '}
            {s.occurrences.length}건 근거 · 확신도 {Math.round(s.confidence * 100)}%
            {' · 다음 예상 '}
            {s.nextExpected}
          </div>
        </div>
        {!s.matchedSubscriptionId && (
          <div className="series-actions">
            <button className="btn btn-sm btn-primary" type="button" onClick={() => handleRegister(s)}>
              등록
            </button>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              disabled={ignored}
              onClick={() => handleIgnore(s.key)}
            >
              {ignored ? '무시함' : '무시'}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <h2 className="section-title">이메일 영수증으로 구독 찾기</h2>
      <p className="section-sub">
        구독 결제/갱신 메일을 모아서 명세서와 같은 방식으로 잊은 구독을 찾아드려요.
      </p>

      {/* 1. Gmail 연동 */}
      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          Gmail 에서 자동으로 찾기
        </h3>
        <p className="email-readonly-notice">읽기 전용({GMAIL_SCOPE.split('/').pop()}) 권한만 사용합니다. 메일을 수정·삭제하지 않아요.</p>

        {!savedClientId ? (
          <>
            <div className="field field-full">
              <label>Google OAuth 클라이언트 ID (웹)</label>
              <input
                className="input"
                type="text"
                placeholder="xxxxxxxx.apps.googleusercontent.com"
                value={clientIdInput}
                onChange={(e) => setClientIdInput(e.target.value)}
              />
              <span className="field-hint">
                발급 방법: 1) Google Cloud Console → OAuth 클라이언트 ID(웹) 생성 2) 승인된 자바스크립트 원본에{' '}
                <code>http://localhost:5273</code> 추가 3) 발급된 클라이언트 ID 를 여기에 붙여넣기
              </span>
            </div>
            <div className="modal-actions" style={{ borderTop: 'none', paddingTop: 10, justifyContent: 'flex-start' }}>
              <button className="btn btn-primary" type="button" disabled={!clientIdInput.trim()} onClick={handleSaveClientId}>
                저장
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <div className="field" style={{ maxWidth: 140 }}>
                <label>최근 몇 개월</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) => setMonths(Math.max(1, Number(e.target.value) || DEFAULT_MONTHS))}
                />
              </div>
              <div className="spacer" />
              <button className="btn btn-primary" type="button" disabled={collecting} onClick={() => void handleGmailScan()}>
                {collecting ? '찾는 중...' : 'Gmail 에서 구독 찾기'}
              </button>
              {auth && (
                <button className="btn btn-ghost" type="button" disabled={collecting} onClick={handleGmailDisconnect}>
                  연결 해제
                </button>
              )}
            </div>

            {collecting && progress && (
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: progress.total > 0 ? `${Math.round((progress.done / progress.total) * 100)}%` : '8%' }}
                />
                <span className="field-hint" style={{ marginTop: 6 }}>
                  {progress.total > 0 ? `${progress.done} / ${progress.total} 건 확인 중` : '메일 목록을 불러오는 중...'}
                </span>
              </div>
            )}

            {!collecting && lastGmailCount !== null && (
              <p className="field-hint">이번에 영수증 {lastGmailCount}건을 찾았습니다.</p>
            )}
            <div className="field-hint">
              클라이언트 ID: <code>{savedClientId}</code>
            </div>
          </>
        )}

        {gmailError && <p style={{ color: 'var(--status-critical)', marginTop: 10 }}>{gmailError}</p>}
      </div>

      {/* 2. Claude 결과 붙여넣기 */}
      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          Claude 가 만든 결과 붙여넣기
        </h3>
        <p className="field-hint">Gmail 을 직접 훑어서 만든 JSON 배열 또는 {'{ receipts: [...] }'} 형태를 붙여넣거나 파일로 올리세요.</p>
        <textarea
          className="textarea"
          rows={6}
          placeholder='[{"from":"info@netflix.com","subject":"결제 완료","receivedAt":"2026-08-14","snippet":"..."}]'
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
        />
        <div className="modal-actions" style={{ borderTop: 'none', paddingTop: 10, justifyContent: 'flex-start' }}>
          <button className="btn btn-primary" type="button" disabled={!jsonText.trim()} onClick={handleJsonLoad}>
            불러오기
          </button>
          <button className="btn" type="button" onClick={() => jsonFileRef.current?.click()}>
            .json 파일 선택
          </button>
        </div>
        <input
          ref={jsonFileRef}
          className="hidden-file-input"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleJsonFile(file)
            e.target.value = ''
          }}
        />
        {jsonError && <p style={{ color: 'var(--status-critical)', marginTop: 10 }}>{jsonError}</p>}
        {jsonCount !== null && !jsonError && <p className="field-hint">영수증 {jsonCount}건을 불러왔습니다.</p>}
      </div>

      {/* 3. 메일 본문 붙여넣기 */}
      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          영수증 메일 하나 붙여넣기
        </h3>
        <p className="field-hint">메일 원문(제목/보낸사람/날짜 + 본문)을 통째로 붙여넣으면 파싱해서 미리 보여드려요.</p>
        <textarea
          className="textarea"
          rows={6}
          placeholder={'From: Netflix <info@netflix.com>\nSubject: 결제가 완료되었습니다\nDate: 2026-08-14\n\n17,000원이 결제되었습니다...'}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <div className="modal-actions" style={{ borderTop: 'none', paddingTop: 10, justifyContent: 'flex-start' }}>
          <button className="btn btn-primary" type="button" disabled={!pasteText.trim()} onClick={handlePasteParse}>
            파싱하기
          </button>
        </div>
        {pasteError && <p style={{ color: 'var(--status-critical)', marginTop: 10 }}>{pasteError}</p>}
        {pastePreview && (
          <div className="series-card" style={{ marginTop: 10 }}>
            <div className="series-main">
              <div className="series-name">{pastePreview.service ?? pastePreview.subject}</div>
              <div className="series-detail">
                {pastePreview.amount != null && pastePreview.currency
                  ? formatMoney(pastePreview.amount, pastePreview.currency)
                  : '금액 미확인'}
                {pastePreview.cycle ? ` · ${CYCLE_LABEL[pastePreview.cycle]}` : ''}
                {' · 확신도 '}
                {Math.round(pastePreview.confidence * 100)}%
              </div>
              <div className="field-hint" style={{ marginTop: 6 }}>{pastePreview.snippet}</div>
            </div>
          </div>
        )}
      </div>

      {/* 결과 목록 */}
      {resultSeries.length > 0 && (
        <div className="card">
          <h3 className="section-title" style={{ fontSize: 14 }}>
            이메일에서 찾은 정기결제 {resultSeries.length}건
          </h3>
          <div className="series-list">{resultSeries.map(renderSeriesCard)}</div>
        </div>
      )}
    </div>
  )
}
