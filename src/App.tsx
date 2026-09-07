import { useEffect, useMemo, useState } from 'react'
import type { AppState, Subscription } from './types'
import { emptyState, loadState, saveState, uid } from './lib/store'
import { collectRateNeeds, ensureRates } from './lib/fx'
import { computeTotals, formatMoney } from './lib/money'
import { analyze } from './lib/analyze'
import { ErrorBoundary } from './components/ErrorBoundary'
import Dashboard from './components/Dashboard'
import DataImport from './components/DataImport'
import SettingsPanel from './components/SettingsPanel'
import SubscriptionForm from './components/SubscriptionForm'

type Tab = 'dashboard' | 'import' | 'settings'

// 탭은 세 개다. 보는 화면(대시보드) / 넣는 화면(자료입력) / 설정.
//
// 구독 목록·점검을 대시보드에 함께 둔 이유는 셋이 한 질문의 세 부분이라서다 —
// 얼마 나가는가, 뭘 구독 중인가, 뭐가 문제인가. 탭으로 갈라놓으면 매번
// 왔다갔다 해야 답이 맞춰진다. 진단만 따로 있는 탭은 아예 안 들어간다.
const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'import', label: '자료입력' },
  { id: 'settings', label: '설정' },
]

type FormModal =
  | { mode: 'add'; draft?: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>; fromSeriesKey?: string }
  | { mode: 'edit'; sub: Subscription }

const THEME_KEY = 'sub-tracker:theme'

function initialTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [tab, setTab] = useState<Tab>('dashboard')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => initialTheme())
  const [formModal, setFormModal] = useState<FormModal | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  /** 환율 자동 부트스트랩. 구독/시리즈/영수증이 바뀔 때마다 표에 없는 조합만 채운다.
   *  latest 환율은 6시간 지났을 때만 다시 조회한다(과거 날짜 환율은 영구 캐시라 항상 그대로 둔다). */
  useEffect(() => {
    if (!state.settings.fxAuto) return
    const needs = collectRateNeeds(state)
    if (needs.length === 0) return

    const updatedAt = state.settings.fxUpdatedAt
    const latestStale = !updatedAt || Date.now() - new Date(updatedAt).getTime() > 6 * 60 * 60 * 1000
    // latest 가 오래됐으면 표에서 latest 항목만 빼서 ensureRates 가 다시 받아오게 한다.
    const existingForCall = latestStale
      ? Object.fromEntries(Object.entries(state.fxTable).filter(([k]) => !k.endsWith('-latest')))
      : state.fxTable

    let cancelled = false
    ensureRates(needs, state.settings.baseCurrency, existingForCall)
      .then((patch) => {
        if (cancelled || Object.keys(patch).length === 0) return
        updateState((prev) => ({
          ...prev,
          fxTable: { ...prev.fxTable, ...patch },
          settings: { ...prev.settings, fxUpdatedAt: new Date().toISOString() },
        }))
      })
      .catch((err) => {
        console.warn('[fx] 환율 자동 갱신 실패', err)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.subscriptions, state.series, state.receipts, state.settings.fxAuto, state.settings.baseCurrency])

  /** 상태를 갱신하고 즉시 저장한다. AppState 의 유일한 변경 경로. */
  function updateState(updater: (prev: AppState) => AppState) {
    setState((prev) => {
      const next = updater(prev)
      saveState(next)
      return next
    })
  }

  /** 저장된 상태가 깨져 화면이 죽었을 때의 탈출구. ErrorBoundary 에서 호출한다. */
  function handleHardReset() {
    const fresh = emptyState()
    saveState(fresh)
    setState(fresh)
  }

  function openAddForm() {
    setFormModal({ mode: 'add' })
  }

  function openEditForm(sub: Subscription) {
    setFormModal({ mode: 'edit', sub })
  }

  function openDraftForm(draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, seriesKey: string) {
    setFormModal({ mode: 'add', draft, fromSeriesKey: seriesKey })
  }

  /**
   * "구독 아님"으로 정리한 후보를 기억한다.
   * 이걸 저장하지 않으면 메일을 다시 스캔할 때마다 같은 항목이 되살아난다.
   */
  function dismissCandidate(key: string) {
    updateState((prev) => ({
      ...prev,
      dismissedCandidates: prev.dismissedCandidates.includes(key)
        ? prev.dismissedCandidates
        : [...prev.dismissedCandidates, key],
    }))
  }

  function closeForm() {
    setFormModal(null)
  }

  function handleSaveForm(values: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = new Date().toISOString()
    if (formModal?.mode === 'edit') {
      const id = formModal.sub.id
      updateState((prev) => ({
        ...prev,
        subscriptions: prev.subscriptions.map((s) =>
          s.id === id ? { ...values, id, createdAt: s.createdAt, updatedAt: now } : s,
        ),
      }))
    } else {
      const id = uid()
      const seriesKey = formModal?.mode === 'add' ? formModal.fromSeriesKey : undefined
      updateState((prev) => ({
        ...prev,
        subscriptions: [...prev.subscriptions, { ...values, id, createdAt: now, updatedAt: now }],
        series: seriesKey
          ? prev.series.map((s) => (s.key === seriesKey ? { ...s, matchedSubscriptionId: id } : s))
          : prev.series,
      }))
    }
    closeForm()
  }

  function deleteSubscription(id: string) {
    updateState((prev) => ({
      ...prev,
      subscriptions: prev.subscriptions.filter((s) => s.id !== id),
    }))
  }

  const formInitial = useMemo(() => {
    if (!formModal) return undefined
    if (formModal.mode === 'edit') return formModal.sub
    return formModal.draft
  }, [formModal])

  const base = state.settings.baseCurrency
  const totals = useMemo(
    () => computeTotals(state.subscriptions, state.settings, undefined, { table: state.fxTable }),
    [state],
  )
  const totalSaving = useMemo(
    () => analyze(state).reduce((sum, f) => sum + Math.max(0, f.monthlySaving), 0),
    [state],
  )

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">구독 트래커</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab-btn${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </nav>
        {/* 구독료는 어느 화면에 있든 늘 보여야 하는 숫자다. 헤더에 둔다. */}
        <div className="header-stats">
          <div className="header-stat">
            <span className="header-stat-label">이번 달</span>
            <span className="header-stat-value kpi-accent">{formatMoney(totals.monthly, base)}</span>
          </div>
          <div className="header-stat">
            <span className="header-stat-label">연 환산</span>
            <span className="header-stat-value">{formatMoney(totals.yearly, base)}</span>
          </div>
          <div className="header-stat">
            <span className="header-stat-label">구독</span>
            <span className="header-stat-value">{totals.activeCount}개</span>
          </div>
          {totalSaving > 0 && (
            <div className="header-stat">
              <span className="header-stat-label">절약 가능</span>
              <span className="header-stat-value kpi-save">{formatMoney(totalSaving, base)}</span>
            </div>
          )}
        </div>
        <button
          className="icon-btn"
          type="button"
          title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          onClick={() => setTheme((p) => (p === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </header>

      <main className="app-main">
        <ErrorBoundary key={tab} onReset={handleHardReset}>
        {tab === 'dashboard' && (
          <Dashboard
            state={state}
            onGotoImport={() => setTab('import')}
            onConfirmCandidate={openDraftForm}
            onDismissCandidate={dismissCandidate}
            onAdd={openAddForm}
            onEdit={openEditForm}
            onDelete={deleteSubscription}
          />
        )}
        {tab === 'import' && (
          <DataImport state={state} updateState={updateState} onRegister={openDraftForm} />
        )}
        {tab === 'settings' && <SettingsPanel state={state} updateState={updateState} />}
        </ErrorBoundary>
      </main>

      {formModal && (
        <SubscriptionForm
          initial={formInitial}
          isEdit={formModal.mode === 'edit'}
          defaultCurrency={state.settings.baseCurrency}
          onSave={handleSaveForm}
          onCancel={closeForm}
        />
      )}
    </div>
  )
}
