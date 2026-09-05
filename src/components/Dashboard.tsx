import { useMemo } from 'react'
import type { AppState, Currency } from '../types'
import { CATEGORY_LABEL } from '../types'
import { computeTotals, formatMoney, daysUntil } from '../lib/money'
import { analyze } from '../lib/analyze'

interface Props {
  state: AppState
  onGotoImport: () => void
}

export default function Dashboard({ state, onGotoImport }: Props) {
  const totals = useMemo(
    () => computeTotals(state.subscriptions, state.settings, undefined, { table: state.fxTable }),
    [state],
  )
  const findings = useMemo(() => analyze(state), [state])
  const totalSaving = useMemo(
    () => findings.reduce((sum, f) => sum + Math.max(0, f.monthlySaving), 0),
    [findings],
  )

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
  const maxMethodMonthly = Math.max(1, ...totals.byPaymentMethod.map((m) => m.monthly))
  const sortedCategories = [...totals.byCategory].sort((a, b) => b.monthly - a.monthly)
  const sortedMethods = [...totals.byPaymentMethod].sort((a, b) => b.monthly - a.monthly)

  return (
    <div>
      <div className="grid grid-kpi" style={{ marginBottom: 16 }}>
        <div className="kpi-tile">
          <span className="kpi-label">이번 달 구독료 합계</span>
          <span className="kpi-value kpi-accent">{formatMoney(totals.monthly, base)}</span>
          <span className="kpi-sub">기준통화 {base} 환산, 활성+체험 구독 기준</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">연간 환산</span>
          <span className="kpi-value">{formatMoney(totals.yearly, base)}</span>
          <span className="kpi-sub">1년치로 환산하면</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">활성 구독 수</span>
          <span className="kpi-value">{totals.activeCount}개</span>
          <span className="kpi-sub">이용중 + 무료체험</span>
        </div>
        <div className="kpi-tile">
          <span className="kpi-label">절약 가능액 (월)</span>
          <span className="kpi-value kpi-save">{formatMoney(totalSaving, base)}</span>
          <span className="kpi-sub">점검 탭에서 확인하기</span>
        </div>
      </div>

      <div className="grid grid-dash">
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

        <div className="card">
          <h2 className="section-title">다가오는 결제</h2>
          <UpcomingTimeline
            upcoming={totals.upcoming}
            windowDays={state.settings.upcomingWindowDays}
            base={base}
          />
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="section-title">결제수단별 분해</h2>
          {sortedMethods.length === 0 ? (
            <p className="chart-empty">표시할 데이터가 없습니다.</p>
          ) : (
            sortedMethods.map((m) => (
              <div className="chart-row" key={m.method}>
                <span className="chart-row-label" title={m.method}>
                  {m.method}
                </span>
                <span className="chart-row-track">
                  <span
                    className="chart-row-fill"
                    style={{ width: `${(m.monthly / maxMethodMonthly) * 100}%` }}
                  />
                </span>
                <span className="chart-row-value">{formatMoney(m.monthly, base)}</span>
              </div>
            ))
          )}
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
