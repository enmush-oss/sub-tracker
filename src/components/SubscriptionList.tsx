import { useMemo, useState } from 'react'
import type { AppState, Category, Subscription, SubStatus } from '../types'
import { BILLING_CHANNEL_LABEL, CATEGORY_LABEL, STATUS_LABEL } from '../types'
import { cycleText, formatMoney, monthlyBase, daysUntil } from '../lib/money'

type SortKey = 'amount' | 'nextBillingDate' | 'name'

interface Props {
  state: AppState
  onAdd: () => void
  onEdit: (sub: Subscription) => void
  onDelete: (id: string) => void
  onGotoImport: () => void
  /** 대시보드 카드 안에 들어갈 때. 제목·추가 버튼은 바깥이 이미 그린다. */
  embedded?: boolean
}

export default function SubscriptionList({
  state,
  onAdd,
  onEdit,
  onDelete,
  onGotoImport,
  embedded,
}: Props) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<Category | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<SubStatus | 'all'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('amount')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = state.subscriptions.filter((s) => {
      if (categoryFilter !== 'all' && s.category !== categoryFilter) return false
      if (statusFilter !== 'all' && s.status !== statusFilter) return false
      if (q && !`${s.service} ${s.plan}`.toLowerCase().includes(q)) return false
      return true
    })
    list = [...list].sort((a, b) => {
      if (sortKey === 'amount') return monthlyBase(b, state.settings) - monthlyBase(a, state.settings)
      if (sortKey === 'nextBillingDate') return a.nextBillingDate < b.nextBillingDate ? -1 : 1
      return a.service.localeCompare(b.service, 'ko')
    })
    return list
  }, [state, search, categoryFilter, statusFilter, sortKey])

  const base = state.settings.baseCurrency
  const fx = { table: state.fxTable }
  // 막대 길이의 기준. 가장 비싼 구독이 100%다.
  const maxMonthly = Math.max(
    1,
    ...state.subscriptions.map((s) => monthlyBase(s, state.settings, fx)),
  )

  if (state.subscriptions.length === 0) {
    return (
      <div className="card empty-state">
        <div style={{ fontSize: 40 }}>📋</div>
        <h3>등록된 구독이 없습니다</h3>
        <p>새 구독을 직접 추가하거나, 명세서를 올려 자동으로 찾아보세요.</p>
        <div className="empty-state-actions">
          <button className="btn btn-primary" type="button" onClick={onAdd}>
            구독 추가하기
          </button>
          <button className="btn" type="button" onClick={onGotoImport}>
            명세서 올리기
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="toolbar">
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="서비스/요금제 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          style={{ maxWidth: 140 }}
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as Category | 'all')}
        >
          <option value="all">전체 카테고리</option>
          {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ maxWidth: 130 }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as SubStatus | 'all')}
        >
          <option value="all">전체 상태</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ maxWidth: 140 }}
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          <option value="amount">금액순</option>
          <option value="nextBillingDate">다음 결제일순</option>
          <option value="name">이름순</option>
        </select>
        {!embedded && (
          <>
            <span className="spacer" />
            <button className="btn btn-primary" type="button" onClick={onAdd}>
              + 구독 추가
            </button>
          </>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="chart-empty">조건에 맞는 구독이 없습니다.</p>
      ) : (
        <div className="sub-list">
          {filtered.map((s) => {
            const d = daysUntil(s.nextBillingDate)
            const monthly = monthlyBase(s, state.settings, { table: state.fxTable })
            return (
              <div className="sub-row" key={s.id}>
                <div className="sub-row-main">
                  <div className="sub-row-name">
                    <span className="sub-row-service">{s.service}</span>
                    {s.plan && <span className="sub-row-plan">{s.plan}</span>}
                    <span className="pill">{CATEGORY_LABEL[s.category]}</span>
                    {(s.extraCategories ?? []).map((c) => (
                      <span className="pill" key={c}>
                        +{CATEGORY_LABEL[c]}
                      </span>
                    ))}
                    {s.status !== 'active' && <span className="pill">{STATUS_LABEL[s.status]}</span>}
                    {s.billingChannel && s.billingChannel !== 'card' && (
                      <span className="pill">{BILLING_CHANNEL_LABEL[s.billingChannel]}</span>
                    )}
                  </div>

                  {/* 막대는 월 환산 기준이다. 연간 결제를 원금 그대로 그리면
                      2년 약정 하나가 화면을 다 차지해 나머지가 안 보인다. */}
                  <div className="sub-row-bar">
                    <span
                      className="sub-row-fill"
                      style={{ width: `${Math.max(2, (monthly / maxMonthly) * 100)}%` }}
                    />
                  </div>
                </div>

                <div className="sub-row-figures">
                  <span className="sub-row-monthly">{formatMoney(monthly, base)}</span>
                  <span className="sub-row-raw">
                    {s.currency !== base || s.cycle !== 'monthly'
                      ? `${formatMoney(s.amount, s.currency)} · ${cycleText(s.cycle, s.cycleDays)}`
                      : '월'}
                  </span>
                </div>

                <div className="sub-row-next">
                  <span className={`pill${d >= 0 && d <= 7 ? ' pill-warn' : ''}`}>
                    {d < 0 ? '지남' : d === 0 ? '오늘' : `D-${d}`}
                  </span>
                  <span className="sub-row-date">{s.nextBillingDate}</span>
                </div>

                {confirmDeleteId === s.id ? (
                  <div className="sub-row-actions">
                    <button className="btn btn-sm" type="button" onClick={() => setConfirmDeleteId(null)}>
                      취소
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      type="button"
                      onClick={() => {
                        onDelete(s.id)
                        setConfirmDeleteId(null)
                      }}
                    >
                      삭제
                    </button>
                  </div>
                ) : (
                  <div className="sub-row-actions">
                    <button className="btn btn-sm" type="button" onClick={() => onEdit(s)}>
                      수정
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      type="button"
                      onClick={() => setConfirmDeleteId(s.id)}
                    >
                      삭제
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

