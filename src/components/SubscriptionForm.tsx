import { useState } from 'react'
import type { BillingChannel, Category, Currency, Cycle, Subscription, SubStatus } from '../types'
import { BILLING_CHANNEL_LABEL, CATEGORY_LABEL, CYCLE_LABEL, STATUS_LABEL } from '../types'
import { guessCategory, normalizeMerchant } from '../lib/normalize'

type Draft = Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>

interface Props {
  initial?: Subscription | Draft
  isEdit: boolean
  defaultCurrency: Currency
  onSave: (values: Draft) => void
  onCancel: () => void
}

function makeDefault(defaultCurrency: Currency): Draft {
  return {
    service: '',
    plan: '',
    category: 'other',
    amount: 0,
    currency: defaultCurrency,
    cycle: 'monthly',
    nextBillingDate: new Date().toISOString().slice(0, 10),
    status: 'active',
    billingChannel: 'card',
    extraCategories: [],
    merchantPatterns: [],
    tags: [],
  }
}

export default function SubscriptionForm({ initial, isEdit, defaultCurrency, onSave, onCancel }: Props) {
  const [values, setValues] = useState<Draft>(() => ({ ...makeDefault(defaultCurrency), ...initial }))
  const [tagsText, setTagsText] = useState(() => (initial?.tags ?? []).join(', '))
  const [categoryTouched, setCategoryTouched] = useState(isEdit)

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  function handleServiceBlur() {
    if (categoryTouched || !values.service) return
    const guessed = guessCategory(normalizeMerchant(values.service))
    if (guessed !== 'other') {
      set('category', guessed)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const tags = tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const merchantPatterns =
      values.merchantPatterns.length > 0
        ? values.merchantPatterns
        : values.service
          ? [normalizeMerchant(values.service)]
          : []
    onSave({ ...values, tags, merchantPatterns })
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="modal" onSubmit={handleSubmit}>
        <div className="modal-head">
          <h2>{isEdit ? '구독 수정' : '구독 추가'}</h2>
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="form-grid">
          <div className="field">
            <label>서비스명</label>
            <input
              className="input"
              required
              value={values.service}
              onChange={(e) => set('service', e.target.value)}
              onBlur={handleServiceBlur}
              placeholder="예: Netflix"
            />
          </div>

          <div className="field field-plan">
            <label>요금제 (plan)</label>
            <input
              className="input"
              value={values.plan}
              onChange={(e) => set('plan', e.target.value)}
              placeholder="예: 프리미엄 4K"
            />
            <span className="field-hint">같은 서비스라도 요금제가 다르면 별도로 관리돼요.</span>
          </div>

          <div className="field">
            <label>카테고리</label>
            <select
              className="select"
              value={values.category}
              onChange={(e) => {
                setCategoryTouched(true)
                const next = e.target.value as Category
                setValues((prev) => ({
                  ...prev,
                  category: next,
                  extraCategories: (prev.extraCategories ?? []).filter((c) => c !== next),
                }))
              }}
            >
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="field field-full">
            <label>부가 카테고리</label>
            <div className="checkbox-group">
              {(Object.entries(CATEGORY_LABEL) as [Category, string][])
                .filter(([k]) => k !== values.category)
                .map(([k, v]) => (
                  <label key={k} className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={(values.extraCategories ?? []).includes(k)}
                      onChange={(e) => {
                        const current = values.extraCategories ?? []
                        const next = e.target.checked ? [...current, k] : current.filter((c) => c !== k)
                        set('extraCategories', next)
                      }}
                    />
                    {v}
                  </label>
                ))}
            </div>
            <span className="field-hint">
              여러 용도를 겸하는 구독에 쓰세요. 예: Google One 은 저장소이면서 Gemini(AI)를 포함합니다.
            </span>
          </div>

          <div className="field">
            <label>결제 경로</label>
            <select
              className="select"
              value={values.billingChannel ?? 'card'}
              onChange={(e) => set('billingChannel', e.target.value as BillingChannel)}
            >
              {Object.entries(BILLING_CHANNEL_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {values.billingChannel && values.billingChannel !== 'card' && (
              <span className="field-hint">
                이 경로는 카드 명세서·영수증 메일에 안 잡힙니다. 결제 끊김으로 오진하지 않습니다.
              </span>
            )}
          </div>

          <div className="field">
            <label>상태</label>
            <select
              className="select"
              value={values.status}
              onChange={(e) => set('status', e.target.value as SubStatus)}
            >
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>금액 / 통화</label>
            <div className="amount-row">
              <input
                className="input"
                type="number"
                min={0}
                step="0.01"
                required
                value={values.amount}
                onChange={(e) => set('amount', Number(e.target.value))}
              />
              <select
                className="select"
                value={values.currency}
                onChange={(e) => set('currency', e.target.value as Currency)}
              >
                {(['KRW', 'USD', 'EUR', 'JPY', 'GBP'] as Currency[]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label>결제 주기</label>
            <select
              className="select"
              value={values.cycle}
              onChange={(e) => set('cycle', e.target.value as Cycle)}
            >
              {Object.entries(CYCLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          {values.cycle === 'custom' && (
            <div className="field">
              <label>주기 일수</label>
              <input
                className="input"
                type="number"
                min={1}
                value={values.cycleDays ?? ''}
                onChange={(e) => set('cycleDays', Number(e.target.value))}
              />
            </div>
          )}

          <div className="field">
            <label>다음 결제일</label>
            <input
              className="input"
              type="date"
              required
              value={values.nextBillingDate}
              onChange={(e) => set('nextBillingDate', e.target.value)}
            />
          </div>

          {values.status === 'trial' && (
            <div className="field">
              <label>무료체험 종료일</label>
              <input
                className="input"
                type="date"
                value={values.trialEndsAt ?? ''}
                onChange={(e) => set('trialEndsAt', e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label>결제수단</label>
            <input
              className="input"
              value={values.paymentMethod ?? ''}
              onChange={(e) => set('paymentMethod', e.target.value)}
              placeholder="예: 신한체크 1234"
            />
          </div>

          <div className="field">
            <label>가족요금제 인원</label>
            <input
              className="input"
              type="number"
              min={1}
              value={values.seats ?? ''}
              onChange={(e) => set('seats', e.target.value ? Number(e.target.value) : undefined)}
            />
          </div>

          <div className="field">
            <label>마지막 사용일</label>
            <input
              className="input"
              type="date"
              value={values.lastUsedAt ?? ''}
              onChange={(e) => set('lastUsedAt', e.target.value)}
            />
            <span className="field-hint">오래 비워두면 좀비 구독으로 감지돼요.</span>
          </div>

          <div className="field field-full">
            <label>해지 URL</label>
            <input
              className="input"
              type="url"
              value={values.cancelUrl ?? ''}
              onChange={(e) => set('cancelUrl', e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="field field-full">
            <label>태그 (쉼표로 구분)</label>
            <input
              className="input"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="예: annual-available, 업무용"
            />
          </div>

          <div className="field field-full">
            <label>메모</label>
            <textarea
              className="textarea"
              rows={3}
              value={values.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="btn btn-primary">
            저장
          </button>
        </div>
      </form>
    </div>
  )
}
