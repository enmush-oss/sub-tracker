import { useMemo } from 'react'
import type { AppState, Finding } from '../types'
import { analyze } from '../lib/analyze'
import { formatMoney } from '../lib/money'

const SEVERITY_META = {
  high: { label: '심각도 높음', color: 'var(--status-critical)' },
  medium: { label: '심각도 보통', color: 'var(--status-serious)' },
  low: { label: '심각도 낮음', color: 'var(--status-warning)' },
} as const

interface Props {
  state: AppState
}

export default function Findings({ state }: Props) {
  const findings = useMemo(() => analyze(state), [state])
  const base = state.settings.baseCurrency

  const totalSaving = findings.reduce((sum, f) => sum + Math.max(0, f.monthlySaving), 0)
  const forgottenCount = findings.filter((f) => f.kind === 'unmatched_charge').length

  const groups: { severity: keyof typeof SEVERITY_META; items: Finding[] }[] = (
    ['high', 'medium', 'low'] as const
  )
    .map((severity) => ({ severity, items: findings.filter((f) => f.severity === severity) }))
    .filter((g) => g.items.length > 0)

  if (findings.length === 0) {
    return (
      <div className="card empty-state">
        <div style={{ fontSize: 40 }}>✅</div>
        <h3>발견된 문제가 없습니다</h3>
        <p>구독을 더 추가하거나 명세서를 올리면 중복·잊은 구독을 점검해드려요.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="findings-summary">
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <span className="kpi-label">아낄 수 있는 금액 (월)</span>
          <div className="kpi-value kpi-save">{formatMoney(totalSaving, base)}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <span className="kpi-label">잊고 있던 구독 후보</span>
          <div className="kpi-value">{forgottenCount}건</div>
        </div>
      </div>

      {groups.map((g) => (
        <div key={g.severity}>
          <div className="findings-group-title">
            <span className="status-dot" style={{ background: SEVERITY_META[g.severity].color }} />
            <span style={{ color: SEVERITY_META[g.severity].color }}>{SEVERITY_META[g.severity].label}</span>
            <span className="pill">{g.items.length}건</span>
          </div>
          {g.items.map((f) => (
            <div className={`finding-card sev-${f.severity}`} key={f.id}>
              <div className="finding-title">{f.title}</div>
              <div className="finding-detail">{f.detail}</div>
              {f.monthlySaving > 0 && (
                <div className="finding-saving">월 {formatMoney(f.monthlySaving, base)} 절약 가능</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
