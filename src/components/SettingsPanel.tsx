import { useRef, useState } from 'react'
import type { AppState, Currency } from '../types'
import { emptyState, exportJson, importJson } from '../lib/store'
import { collectRateNeeds, ensureRates } from '../lib/fx'
import { GEMINI_MODEL, getApiKey, hasBuiltinKey, setApiKey } from '../lib/gemini'

const CURRENCIES: Currency[] = ['KRW', 'USD', 'EUR', 'JPY', 'GBP']

interface Props {
  state: AppState
  updateState: (updater: (prev: AppState) => AppState) => void
}

export default function SettingsPanel({ state, updateState }: Props) {
  const [geminiKey, setGeminiKey] = useState(() => getApiKey() ?? '')
  const [geminiSaved, setGeminiSaved] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [fxRefreshing, setFxRefreshing] = useState(false)
  const [fxError, setFxError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  function setFxRate(currency: Currency, rate: number) {
    updateState((prev) => ({
      ...prev,
      settings: { ...prev.settings, fxRates: { ...prev.settings.fxRates, [currency]: rate } },
    }))
  }

  function setFxAuto(auto: boolean) {
    updateState((prev) => ({ ...prev, settings: { ...prev.settings, fxAuto: auto } }))
  }

  /** [지금 갱신] — TTL 을 무시하고 latest 환율을 강제로 다시 받아온다. */
  async function handleFxRefreshNow() {
    setFxError(null)
    setFxRefreshing(true)
    try {
      const needs = collectRateNeeds(state)
      // latest 항목은 표에서 빼서 강제로 다시 받아오게 한다. 과거 날짜 캐시는 그대로 둔다.
      const existingForCall = Object.fromEntries(
        Object.entries(state.fxTable).filter(([k]) => !k.endsWith('-latest')),
      )
      const patch = await ensureRates(needs, state.settings.baseCurrency, existingForCall)
      updateState((prev) => ({
        ...prev,
        fxTable: { ...prev.fxTable, ...patch },
        settings: { ...prev.settings, fxUpdatedAt: new Date().toISOString() },
      }))
    } catch {
      setFxError('환율 갱신에 실패했습니다. 잠시 후 다시 시도해주세요.')
    } finally {
      setFxRefreshing(false)
    }
  }

  function handleExport() {
    const json = exportJson(state)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sub-tracker-backup-${state.settings.baseCurrency}-${new Date()
      .toISOString()
      .slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleImportFile(file: File) {
    setImportError(null)
    try {
      const text = await file.text()
      const imported = importJson(text)
      updateState(() => imported)
    } catch {
      setImportError('가져오기에 실패했습니다. 올바른 백업 파일인지 확인해주세요.')
    }
  }

  return (
    <div>
      <h2 className="section-title">설정</h2>

      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          환율 (1 단위 외화 → {state.settings.baseCurrency})
        </h3>

        <div className="fx-row">
          <label htmlFor="fx-auto-toggle">자동 환율 조회</label>
          <input
            id="fx-auto-toggle"
            type="checkbox"
            checked={state.settings.fxAuto}
            onChange={(e) => setFxAuto(e.target.checked)}
          />
        </div>
        <p className="field-hint">
          출처: 유럽중앙은행(ECB) 공시환율 · Frankfurter API
          {state.settings.fxUpdatedAt ? ` · 마지막 갱신: ${new Date(state.settings.fxUpdatedAt).toLocaleString('ko-KR')}` : ''}
        </p>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <button className="btn btn-sm" type="button" onClick={() => void handleFxRefreshNow()} disabled={fxRefreshing}>
            {fxRefreshing ? '갱신 중…' : '지금 갱신'}
          </button>
        </div>
        {fxError && <p style={{ color: 'var(--status-critical)' }}>{fxError}</p>}

        <p className="field-hint">
          {state.settings.fxAuto
            ? '자동 조회 실패 시 폴백으로 쓰이는 수동 환율입니다.'
            : '자동 조회가 꺼져 있어 아래 수동 환율만 사용합니다.'}
        </p>
        {CURRENCIES.map((c) => (
          <div className="fx-row" key={c}>
            <label>{c}</label>
            <input
              className="input"
              type="number"
              step="0.01"
              min={0}
              disabled={c === state.settings.baseCurrency}
              style={state.settings.fxAuto ? { opacity: 0.6 } : undefined}
              value={state.settings.fxRates[c] ?? ''}
              onChange={(e) => setFxRate(c, Number(e.target.value))}
            />
          </div>
        ))}

        <p className="field-hint" style={{ marginTop: 12 }}>
          환율 조회 시 통화 코드와 날짜만 Frankfurter 로 전송됩니다. 구독 내역·금액·개인정보는 전송되지
          않습니다.
        </p>
      </div>

      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          탐지 기준
        </h3>
        <div className="form-grid">
          <div className="field">
            <label>좀비 구독 기준 (일)</label>
            <input
              className="input"
              type="number"
              min={1}
              value={state.settings.zombieAfterDays}
              onChange={(e) =>
                updateState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, zombieAfterDays: Number(e.target.value) },
                }))
              }
            />
            <span className="field-hint">이 기간 이상 사용 안 하면 좀비 구독으로 표시해요.</span>
          </div>
          <div className="field">
            <label>다가오는 결제 알림 범위 (일)</label>
            <input
              className="input"
              type="number"
              min={1}
              value={state.settings.upcomingWindowDays}
              onChange={(e) =>
                updateState((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, upcomingWindowDays: Number(e.target.value) },
                }))
              }
            />
          </div>
        </div>
      </div>

      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          AI 판독기 (Gemini)
        </h3>
        <p className="field-hint">
          명세서에서 찾은 가맹점 중 <strong>사전에 없는 이름</strong>을 대신 읽어줍니다.
          <br />
          나가는 건 가맹점 이름뿐입니다. 금액·날짜·카드번호·거래 건수는 보내지 않습니다.
          <br />
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            Google AI Studio
          </a>
          에서 무료 키를 받을 수 있습니다. 모델: <code>{GEMINI_MODEL}</code>
        </p>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            type="password"
            className="input"
            placeholder={hasBuiltinKey() ? '.dev.vars 의 키를 쓰는 중' : 'Gemini API 키'}
            value={geminiKey}
            onChange={(e) => {
              setGeminiKey(e.target.value)
              setGeminiSaved(false)
            }}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="btn"
            type="button"
            onClick={() => {
              setApiKey(geminiKey)
              setGeminiSaved(true)
            }}
          >
            저장
          </button>
        </div>
        {geminiSaved && <p className="field-hint" style={{ marginTop: 8 }}>저장했습니다.</p>}
      </div>

      <div className="card settings-section">
        <h3 className="section-title" style={{ fontSize: 14 }}>
          데이터 백업
        </h3>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="btn" type="button" onClick={handleExport}>
            JSON 내보내기
          </button>
          <button className="btn" type="button" onClick={() => fileInputRef.current?.click()}>
            JSON 가져오기
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImportFile(file)
              e.target.value = ''
            }}
          />
        </div>
        {importError && <p style={{ color: 'var(--status-critical)', marginTop: 10 }}>{importError}</p>}
      </div>

      <div className="danger-zone">
        <h3 style={{ marginTop: 0, fontSize: 14 }}>전체 초기화</h3>
        <p className="field-hint">모든 구독, 명세서 탐지 기록, 설정이 삭제됩니다. 되돌릴 수 없어요.</p>
        {confirmReset ? (
          <div className="confirm-inline">
            <span>정말 초기화할까요?</span>
            <span className="spacer" />
            <button className="btn btn-sm" type="button" onClick={() => setConfirmReset(false)}>
              취소
            </button>
            <button
              className="btn btn-sm btn-danger"
              type="button"
              onClick={() => {
                updateState(() => emptyState())
                setConfirmReset(false)
              }}
            >
              초기화
            </button>
          </div>
        ) : (
          <button className="btn btn-danger" type="button" onClick={() => setConfirmReset(true)}>
            전체 초기화
          </button>
        )}
      </div>
    </div>
  )
}
