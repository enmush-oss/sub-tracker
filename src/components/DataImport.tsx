import { useState } from 'react'
import type { AppState, Subscription } from '../types'
import ImportWizard from './ImportWizard'
import EmailImport from './EmailImport'

/**
 * 자료입력 — 명세서와 이메일을 한 탭에 둔다.
 *
 * 둘은 "구독 근거를 어디서 가져올까"라는 같은 질문의 두 답이다.
 * 상단 탭으로 갈라놓으면 처음 쓰는 사람은 어느 쪽으로 시작해야 하는지 모른다.
 * 안에서 고르게 하고, 바깥 탭은 하나로 줄인다.
 */
type Source = 'statement' | 'email'

const SOURCES: { id: Source; label: string; hint: string }[] = [
  { id: 'statement', label: '카드 명세서', hint: 'CSV·엑셀 파일로 한 번에' },
  { id: 'email', label: '이메일 영수증', hint: 'Gmail 연동 또는 JSON' },
]

interface Props {
  state: AppState
  updateState: (updater: (prev: AppState) => AppState) => void
  onRegister: (draft: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>, seriesKey: string) => void
}

export default function DataImport({ state, updateState, onRegister }: Props) {
  const [source, setSource] = useState<Source>('statement')

  return (
    <div>
      <div className="source-switch">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`source-btn${source === s.id ? ' active' : ''}`}
            onClick={() => setSource(s.id)}
          >
            <span className="source-btn-label">{s.label}</span>
            <span className="source-btn-hint">{s.hint}</span>
          </button>
        ))}
      </div>

      {source === 'statement' ? (
        <ImportWizard state={state} updateState={updateState} onRegister={onRegister} />
      ) : (
        <EmailImport state={state} updateState={updateState} onRegister={onRegister} />
      )}
    </div>
  )
}
