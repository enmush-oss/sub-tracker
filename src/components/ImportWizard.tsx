import { useMemo, useRef, useState } from 'react'
import type { AppState, ColumnMapping, DetectedSeries, ParsedCsv, Subscription } from '../types'
import { CATEGORY_LABEL, CYCLE_LABEL } from '../types'
import { readCsvFile, rowsToTxns } from '../lib/csv'
import { detectSeries, matchSeriesToSubs, seriesToSubscriptionDraft } from '../lib/detect'
import { cycleText, formatMoney } from '../lib/money'
import { guessServiceName } from '../lib/normalize'
import { getApiKey, readAll, type ReadResult } from '../lib/gemini'

interface Props {
  state: AppState
  updateState: (updater: (prev: AppState) => AppState) => void
  onRegister: (draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, seriesKey: string) => void
}

type Step = 1 | 2 | 3

const MAPPING_FIELDS: { key: keyof ColumnMapping; label: string; required: boolean }[] = [
  { key: 'date', label: '날짜', required: true },
  { key: 'merchant', label: '가맹점', required: true },
  { key: 'amount', label: '금액', required: true },
  { key: 'card', label: '카드/결제수단', required: false },
  { key: 'memo', label: '메모', required: false },
  { key: 'currency', label: '통화', required: false },
]

export default function ImportWizard({ state, updateState, onRegister }: Props) {
  const [step, setStep] = useState<Step>(1)
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [mapping, setMapping] = useState<Partial<ColumnMapping>>({})
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [series, setSeries] = useState<DetectedSeries[]>([])
  // AI 판독 결과. key = series.key
  const [readings, setReadings] = useState<Record<string, ReadResult>>({})
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  async function handleFile(file: File) {
    setError(null)
    setLoading(true)
    try {
      const result = await readCsvFile(file)
      setFileName(file.name)
      setParsed(result)
      setMapping(result.suggested)
      setStep(2)
    } catch {
      setError('CSV 파일을 읽지 못했습니다. 형식을 확인해주세요.')
    } finally {
      setLoading(false)
    }
  }

  const mappingComplete = !!(mapping.date && mapping.merchant && mapping.amount)

  function runDetection() {
    if (!parsed || !mappingComplete) return
    const txns = rowsToTxns(parsed.rows, mapping as ColumnMapping, {
      sourceFile: fileName,
      defaultCurrency: state.settings.baseCurrency,
    })
    const detected = matchSeriesToSubs(detectSeries(txns), state.subscriptions)
    setSeries(detected)
    updateState((prev) => ({ ...prev, series: detected }))
    setStep(3)
  }

  function isForgotten(s: DetectedSeries) {
    return (
      !s.matchedSubscriptionId &&
      !s.stale &&
      s.confidence >= 0.6 &&
      !state.ignoredSeriesKeys.includes(s.key)
    )
  }

  // 편의점·배달처럼 자주 쓰지만 불규칙한 결제가 "정기결제"로 섞여 보이면 신뢰를 잃는다.
  // 확신도 50% 미만은 접어두고, 잊은 구독을 맨 위로 올린다.
  const CONFIDENT_MIN = 0.5
  const forgottenList = series.filter((s) => s.confidence >= CONFIDENT_MIN && isForgotten(s))
  const knownList = series.filter((s) => s.confidence >= CONFIDENT_MIN && !isForgotten(s))
  const confident = [...forgottenList, ...knownList]
  const lowConfidence = series.filter((s) => s.confidence < CONFIDENT_MIN)

  // 사전이 못 알아본 것들. AI 판독 대상이자, 판독 버튼을 보여줄 이유.
  const unknownSeries = confident.filter(
    (s) => !s.matchedSubscriptionId && !guessServiceName(s.key) && !readings[s.key],
  )

  function renderSeriesCard(s: DetectedSeries) {
    const forgotten = isForgotten(s)
    const ignored = state.ignoredSeriesKeys.includes(s.key)
    const reading_ = readings[s.key]
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
            {s.occurrences.length}회 결제 · 확신도 {Math.round(s.confidence * 100)}%
            {' · 다음 예상 '}
            {s.nextExpected}
          </div>
          {reading_ && (
            <div className={`series-reading${reading_.isSubscription ? '' : ' not-sub'}`}>
              <span className="pill pill-ai">AI 판독</span>{' '}
              {reading_.service ?? '알아보지 못함'}
              {reading_.category && ` · ${CATEGORY_LABEL[reading_.category]}`}
              {!reading_.isSubscription && ' · 구독이 아닌 것 같음'}
              {reading_.note && <div className="series-reading-note">{reading_.note}</div>}
            </div>
          )}
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

  /**
   * 사전에 없는 가맹점만 골라 AI 판독기로 보낸다.
   * 이미 아는 건 보낼 이유가 없다 — 호출도 아끼고, 나가는 데이터도 줄인다.
   */
  async function handleRead() {
    const apiKey = getApiKey()
    if (!apiKey) {
      setReadError('설정 탭에서 Gemini API 키를 먼저 넣어주세요.')
      return
    }
    setReading(true)
    setReadError(null)
    const { results, error } = await readAll(
      unknownSeries.map((s) => ({ key: s.key, merchantRaw: s.merchantRaw })),
      { apiKey },
    )
    setReadings((prev) => {
      const next = { ...prev }
      for (const r of results) next[r.key] = r
      return next
    })
    if (error) setReadError(error)
    setReading(false)
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
    const draft = seriesToSubscriptionDraft(s)
    const r = readings[s.key]
    // 사전이 못 알아본 건 원문 표기가 그대로 서비스명이 된다. 판독 결과가 있으면 그게 낫다.
    if (r?.service && !guessServiceName(s.key)) draft.service = r.service
    if (r?.category && !guessServiceName(s.key)) draft.category = r.category
    onRegister(draft, s.key)
  }

  const previewRows = useMemo(() => parsed?.rows.slice(0, 5) ?? [], [parsed])

  return (
    <div>
      <h2 className="section-title">명세서로 잊은 구독 찾기</h2>
      <p className="section-sub">
        카드 명세서 CSV 를 올리면 반복 결제를 자동으로 찾아서, 등록 안 된 정기결제를 알려드려요.
      </p>

      <div className="wizard-steps">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`wizard-step-dot${step === n ? ' active' : step > n ? ' done' : ''}`}
          />
        ))}
      </div>

      {step === 1 && (
        <div className="card">
          <div
            className={`dropzone${dragOver ? ' dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files?.[0]
              if (file) void handleFile(file)
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
            {loading ? '읽는 중...' : 'CSV 파일을 여기로 끌어다 놓거나 클릭해서 선택하세요'}
            <div className="field-hint" style={{ marginTop: 6 }}>
              한국 카드사 명세서(euc-kr 인코딩)도 자동으로 인식합니다.
            </div>
          </div>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
          {error && <p style={{ color: 'var(--status-critical)', marginTop: 10 }}>{error}</p>}
        </div>
      )}

      {step === 2 && parsed && (
        <div className="card">
          <h3 className="section-title" style={{ fontSize: 14 }}>
            컬럼 매핑 확인 · {fileName}
          </h3>
          <div className="mapping-grid">
            {MAPPING_FIELDS.map((f) => (
              <div className="field" key={f.key}>
                <label>
                  {f.label} {f.required && '*'}
                </label>
                <select
                  className="select"
                  value={mapping[f.key] ?? ''}
                  onChange={(e) =>
                    setMapping((prev) => ({ ...prev, [f.key]: e.target.value || undefined }))
                  }
                >
                  <option value="">{f.required ? '선택하세요' : '없음'}</option>
                  {parsed.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <h4 style={{ fontSize: 13, margin: '14px 0 8px' }}>미리보기 (상위 5줄)</h4>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {parsed.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => (
                  <tr key={i}>
                    {parsed.headers.map((h) => (
                      <td key={h}>{row[h]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="modal-actions" style={{ borderTop: 'none', paddingTop: 10 }}>
            <button className="btn" type="button" onClick={() => setStep(1)}>
              이전
            </button>
            <button className="btn btn-primary" type="button" disabled={!mappingComplete} onClick={runDetection}>
              탐지 시작
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3 className="section-title" style={{ fontSize: 14 }}>
            정기결제 {confident.length}건
            {forgottenList.length > 0 && ` · 잊고 있던 구독 ${forgottenList.length}건`}
          </h3>

          {unknownSeries.length > 0 && (
            <div className="ai-read-bar">
              <div>
                <strong>{unknownSeries.length}건</strong>이 무슨 서비스인지 사전에 없습니다.
                AI 로 읽어볼 수 있어요.
                <div className="ai-read-note">
                  가맹점 이름만 Gemini 로 보냅니다. 금액·날짜·카드번호는 보내지 않습니다.
                </div>
              </div>
              <button className="btn btn-sm" type="button" disabled={reading} onClick={handleRead}>
                {reading ? '판독 중…' : 'AI 판독'}
              </button>
            </div>
          )}
          {readError && <p className="form-error">{readError}</p>}
          {series.length === 0 ? (
            <p className="chart-empty">반복되는 결제를 찾지 못했습니다.</p>
          ) : (
            <>
              {forgottenList.length > 0 && (
                <>
                  <p className="series-group-note">
                    아래 결제는 명세서에는 있는데 구독 목록에 없습니다. 아직 돈이 나가고 있어요.
                  </p>
                  <div className="series-list">{forgottenList.map(renderSeriesCard)}</div>
                </>
              )}

              {knownList.length > 0 && (
                <>
                  <h4 className="series-group-title">확인된 반복 결제 {knownList.length}건</h4>
                  <div className="series-list">{knownList.map(renderSeriesCard)}</div>
                </>
              )}

              {lowConfidence.length > 0 && (
                <details className="series-lowconf">
                  <summary>
                    확신도 낮은 반복 결제 {lowConfidence.length}건 — 정기구독이 아닐 수 있어요
                  </summary>
                  <div className="series-list">{lowConfidence.map(renderSeriesCard)}</div>
                </details>
              )}
            </>
          )}

          <div className="modal-actions" style={{ borderTop: 'none', paddingTop: 10 }}>
            <button className="btn" type="button" onClick={() => setStep(2)}>
              이전
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setStep(1)
                setParsed(null)
                setSeries([])
                setFileName('')
              }}
            >
              다른 파일 올리기
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
