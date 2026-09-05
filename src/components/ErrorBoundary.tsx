import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 초기화 버튼이 눌렸을 때 실행. 보통 localStorage 를 비운다. */
  onReset?: () => void
}
interface State {
  error: Error | null
}

/**
 * 화면 하나가 죽어도 앱 전체가 백지가 되지 않게 막는다.
 * 명세서 데이터가 이상하거나 저장된 상태가 깨졌을 때 사용자가 빠져나갈 길을 준다.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[sub-tracker] 화면 렌더링 실패', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="card" style={{ margin: 24 }}>
        <h3 className="section-title" style={{ fontSize: 15 }}>
          이 화면을 그리다 문제가 생겼어요
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          저장된 데이터가 손상됐을 수 있습니다. 다시 시도해보고, 계속 같은 문제가 나면 데이터를 초기화하세요.
          초기화 전에 <strong>설정 → JSON 내보내기</strong>로 백업할 수 있습니다.
        </p>
        <pre
          style={{
            marginTop: 12,
            padding: 10,
            fontSize: 12,
            background: 'var(--bg-subtle, rgba(127,127,127,.1))',
            borderRadius: 6,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message}
        </pre>
        <div className="modal-actions" style={{ marginTop: 14 }}>
          <button className="btn btn-primary" type="button" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
          {this.props.onReset && (
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                if (confirm('저장된 구독 데이터를 모두 지웁니다. 계속할까요?')) {
                  this.props.onReset!()
                  this.setState({ error: null })
                }
              }}
            >
              데이터 초기화
            </button>
          )}
        </div>
      </div>
    )
  }
}
