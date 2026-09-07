import { useMemo } from 'react'
import type { AppState, Currency, Subscription } from '../types'
import { CATEGORY_LABEL } from '../types'
import { computeTotals, formatMoney, daysUntil } from '../lib/money'
import { analyze } from '../lib/analyze'
import FindingList from './FindingList'
import SubscriptionList from './SubscriptionList'

interface Props {
  state: AppState
  onGotoImport: () => void
  onConfirmCandidate: (draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, key: string) => void
  onDismissCandidate: (key: string) => void
  onAdd: () => void
  onEdit: (sub: Subscription) => void
  onDelete: (id: string) => void
}

export default function Dashboard({
  state,
  onGotoImport,
  onConfirmCandidate,
  onDismissCandidate,
  onAdd,
  onEdit,
  onDelete,
}: Props) {
  const totals = useMemo(
    () => computeTotals(state.subscriptions, state.settings, undefined, { table: state.fxTable }),
    [state],
  )
  const findings = useMemo(() => analyze(state), [state])
  const base = state.settings.baseCurrency

  if (state.subscriptions.length === 0) {
    return (
      <div className="card empty-state">
        <div style={{ fontSize: 40 }}>🧾</div>
        <h3>아직 등록된 구독이 없어요</h3>
        <p>
          손으로 하나씩 넣어도 되지만, <strong>카드 명세서를 올리면 반복 결제를 자동으로 찾아</strong>{' '}
          잊고 있던 구독까지 알려드려요.
        </p>
        <div className="empty-state-actions">
          <button className="btn btn-primary" type="button" onClick={onGotoImport}>
            명세서 올리고 시작하기
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 14 }}>
          카드사 홈페이지·앱에서 이용대금명세서를 CSV 나 엑셀로 내려받아 올리면 됩니다.
          파일은 브라우저 안에서만 읽고 어디로도 보내지 않습니다.
        </p>
      </div>
    )
  }

  const maxCategoryMonthly = Math.max(1, ...totals.byCategory.map((c) => c.monthly))
  const sortedCategories = [...totals.byCategory].sort((a, b) => b.monthly - a.monthly)

  return (
    <div className="grid grid-dash">
      {/* 왼쪽: 지금 뭘 구독 중인가 */}
      <div className="dash-main">
        <div className="card">
          <div className="section-head">
            <h2 className="section-title" style={{ margin: 0 }}>
              구독
              <span className="pill" style={{ marginLeft: 8 }}>{state.subscriptions.length}개</span>
            </h2>
            <div className="toolbar" style={{ margin: 0 }}>
              <button className="btn btn-sm" type="button" onClick={onGotoImport}>
                자료 가져오기
              </button>
              <button className="btn btn-sm btn-primary" type="button" onClick={onAdd}>
                구독 추가
              </button>
            </div>
          </div>
          <SubscriptionList
            state={state}
            onAdd={onAdd}
            onEdit={onEdit}
            onDelete={onDelete}
            onGotoImport={onGotoImport}
            embedded
          />
        </div>

        <div className="card">
          <h2 className="section-title">카테고리별 지출</h2>
          {sortedCategories.length === 0 ? (
            <p className="chart-empty">표시할 데이터가 없습니다.</p>
          ) : (
            sortedCategories.map((c) => (
              <div className="chart-row" key={c.category}>
                <span className="chart-row-label" title={CATEGORY_LABEL[c.category]}>
                  {CATEGORY_LABEL[c.category]}
                </span>
                <span className="chart-row-track">
                  <span
                    className="chart-row-fill"
                    style={{ width: `${(c.monthly / maxCategoryMonthly) * 100}%` }}
                  />
                </span>
                <span className="chart-row-value">{formatMoney(c.monthly, base)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 오른쪽: 손대야 할 것 — 알림과 안내만 모은다 */}
      <div className="dash-side">
        <div className="card">
          <h2 className="section-title">다가오는 결제</h2>
          <UpcomingTimeline
            upcoming={totals.upcoming}
            windowDays={state.settings.upcomingWindowDays}
            base={base}
          />
        </div>

        <div className="card">
          <h2 className="section-title">
            점검
            {findings.length > 0 && (
              <span className="pill" style={{ marginLeft: 8 }}>{findings.length}건</span>
            )}
          </h2>
          <FindingList
            findings={findings}
            base={base}
            onConfirmCandidate={onConfirmCandidate}
            onDismissCandidate={onDismissCandidate}
          />
        </div>
      </div>
    </div>
  )
}

function UpcomingTimeline({
  upcoming,
  windowDays,
  base,
}: {
  upcoming: { sub: { id: string; service: string; plan: string }; date: string; amountBase: number }[]
  windowDays: number
  base: Currency
}) {
  if (upcoming.length === 0) {
    return <p className="chart-empty">{windowDays}일 안에 예정된 결제가 없습니다.</p>
  }

  const svgW = 640
  const svgH = 56

  return (
    <div>
      <svg className="timeline-svg" viewBox={`0 0 ${svgW} ${svgH}`} role="img" aria-label="다가오는 결제 타임라인">
        <line x1={8} y1={30} x2={svgW - 8} y2={30} stroke="var(--baseline)" strokeWidth={1} />
        {[0, windowDays].map((d) => {
          const x = 8 + (d / Math.max(windowDays, 1)) * (svgW - 16)
          return (
            <g key={d}>
              <line x1={x} y1={25} x2={x} y2={35} stroke="var(--gridline)" strokeWidth={1} />
              <text x={x} y={50} fontSize={10} fill="var(--text-muted)" textAnchor="middle">
                {d === 0 ? '오늘' : `+${d}일`}
              </text>
            </g>
          )
        })}
        {upcoming.map((u) => {
          const d = daysUntil(u.date)
          const x = 8 + (Math.min(Math.max(d, 0), windowDays) / Math.max(windowDays, 1)) * (svgW - 16)
          return (
            <circle
              key={u.sub.id}
              cx={x}
              cy={30}
              r={5}
              fill="var(--seq-400)"
              stroke="var(--surface-1)"
              strokeWidth={2}
            >
              <title>
                {u.sub.service} · {formatMoney(u.amountBase, base)} · {u.date}
              </title>
            </circle>
          )
        })}
      </svg>
      <div className="timeline-list">
        {upcoming.slice(0, 8).map((u) => {
          const d = daysUntil(u.date)
          return (
            <div className="timeline-item" key={u.sub.id}>
              <span className="timeline-dday">{d <= 0 ? '오늘' : `D-${d}`}</span>
              <span className="timeline-name">
                {u.sub.service}
                {u.sub.plan ? ` · ${u.sub.plan}` : ''}
              </span>
              <span className="timeline-amount">{formatMoney(u.amountBase, base)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
