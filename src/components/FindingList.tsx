import type { Currency, Finding, Subscription } from '../types'
import { formatMoney } from '../lib/money'

/**
 * 점검 항목 목록. 대시보드 안에 들어간다.
 *
 * 진단만 따로 보는 탭이 있으면 사람들이 거기까지 안 간다. 돈이 얼마 나가는지
 * 보러 온 화면에 "이건 겹칩니다"가 같이 있어야 실제로 읽힌다.
 */

const SEVERITY_META = {
  high: { label: '심각도 높음', color: 'var(--status-critical)' },
  medium: { label: '심각도 보통', color: 'var(--status-serious)' },
  low: { label: '심각도 낮음', color: 'var(--status-warning)' },
} as const

/**
 * 확인 대기 후보 → 구독 폼 초안.
 * 금액과 주기는 비워 둔다. 증거가 없어서 후보로 뜬 건데 앱이 지어내면
 * 그 숫자가 그대로 합계에 들어간다. 사용자가 직접 채우게 한다.
 */
export function candidateToDraft(f: Finding): Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'> {
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

interface Props {
  findings: Finding[]
  base: Currency
  onConfirmCandidate: (draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, key: string) => void
  onDismissCandidate: (key: string) => void
}

export default function FindingList({
  findings,
  base,
  onConfirmCandidate,
  onDismissCandidate,
}: Props) {
  if (findings.length === 0) {
    return <p className="chart-empty">겹치거나 새는 구독이 없습니다.</p>
  }

  const groups = (['high', 'medium', 'low'] as const)
    .map((severity) => ({ severity, items: findings.filter((f) => f.severity === severity) }))
    .filter((g) => g.items.length > 0)

  return (
    <>
      {groups.map((g) => (
        <div key={g.severity}>
          <div className="findings-group-title">
            <span className="status-dot" style={{ background: SEVERITY_META[g.severity].color }} />
            <span style={{ color: SEVERITY_META[g.severity].color }}>
              {SEVERITY_META[g.severity].label}
            </span>
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
    </>
  )
}
