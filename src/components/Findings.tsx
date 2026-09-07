import { useMemo } from 'react'
import type { AppState, Finding, Subscription } from '../types'
import { analyze } from '../lib/analyze'
import { formatMoney } from '../lib/money'

/**
 * 확인 대기 후보 → 구독 폼 초안.
 * 금액과 주기는 비워 둔다. 증거가 없어서 후보로 뜬 건데 앱이 지어내면
 * 그 숫자가 그대로 합계에 들어간다. 사용자가 직접 채우게 한다.
 */
function candidateToDraft(f: Finding): Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'> {
  const c = f.candidate!
  return {
    service: c.service,
    plan: '',
    category: c.category ?? 'other',
    amount: c.amount ?? 0,
    currency: c.currency ?? 'KRW',
    cycle: c.cycle ?? 'monthly',
    nextBillingDate: c.nextBillingDate ?? '',
    startedAt: '',
    status: 'active',
    merchantPatterns: [c.key],
    tags: [],
  }
}

const SEVERITY_META = {
  high: { label: '심각도 높음', color: 'var(--status-critical)' },
  medium: { label: '심각도 보통', color: 'var(--status-serious)' },
  low: { label: '심각도 낮음', color: 'var(--status-warning)' },
} as const

interface Props {
  state: AppState
  /** "구독이에요" — 폼을 열어 사용자가 금액·주기를 채우게 한다 */
  onConfirmCandidate: (draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, key: string) => void
  /** "아니에요" — 다음 스캔에서 다시 뜨지 않게 기억한다 */
  onDismissCandidate: (key: string) => void
}

export default function Findings({ state, onConfirmCandidate, onDismissCandidate }: Props) {
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
              {f.candidate && (
                <div className="finding-actions">
                  <button
                    className="btn btn-sm btn-primary"
                    type="button"
                    onClick={() => onConfirmCandidate(candidateToDraft(f), f.candidate!.key)}
                  >
                    구독 중이에요
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    type="button"
                    onClick={() => onDismissCandidate(f.candidate!.key)}
                  >
                    아니에요
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
