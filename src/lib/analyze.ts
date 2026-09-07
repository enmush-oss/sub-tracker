// ─────────────────────────────────────────────────────────────
// 진단 로직 — 중복/겹침/미등록/좀비 등을 Finding 으로 만든다.
// ─────────────────────────────────────────────────────────────

import type { AppState, Category, Finding, FindingKind, Settings, Subscription } from '../types'
import { CATEGORY_LABEL, CYCLE_LABEL, CHANNELS_WITHOUT_RECEIPTS, categoriesOf } from '../types'
import { cycleText, cycleToMonths, formatMoney, monthlyBase, toBase } from './money'
import { normalizeMerchant } from './normalize'

/** 기능이 겹치는 서비스 묶음. 카테고리가 달라도 잡아내기 위한 것.
 *  예: YouTube Premium 은 category 가 video 지만 음악 그룹에도 들어간다. */
export const FEATURE_OVERLAP_GROUPS: {
  id: string
  label: string
  services: string[]
  /** 이름은 매칭되지만 실제로는 기능이 빠진 요금제를 걸러낸다 (예: Premium Lite) */
  exclude?: string[]
  note: string
}[] = [
  {
    id: 'music',
    label: '음악 스트리밍',
    services: ['youtube premium', 'youtube music', 'spotify', '스포티파이', 'melon', '멜론', 'genie', '지니', 'flo', '플로', 'bugs', '벅스', 'apple music', '애플뮤직'],
    // YouTube Premium 은 YouTube Music 을 포함해서 음악 그룹에 넣지만,
    // Lite 요금제는 Music 이 빠진다. 이름만 보고 묶으면 없는 겹침을 만들어낸다.
    exclude: ['lite'],
    note: '음악을 들을 수 있는 서비스가 겹칩니다.',
  },
  {
    id: 'ott',
    label: 'OTT 스트리밍',
    // YouTube 는 일부러 뺐다. 광고 제거 서비스지 OTT 대체재가 아니라서,
    // 넷플릭스와 묶어 "하나 정리하라"고 하면 틀린 조언이 된다.
    services: ['netflix', '넷플릭스', 'tving', '티빙', 'wavve', '웨이브', 'watcha', '왓챠', 'disney', '디즈니', 'coupang play', '쿠팡플레이', 'apple tv', '라프텔'],
    note: '볼 수 있는 영상 콘텐츠가 겹칩니다.',
  },
  {
    id: 'ai-chat',
    label: 'AI 챗봇',
    services: ['chatgpt', 'openai', 'claude', 'anthropic', 'gemini', 'perplexity', 'copilot', 'google one', 'google ai'],
    note: 'AI 어시스턴트 기능이 겹칩니다.',
  },
  {
    id: 'cloud-storage',
    label: '클라우드 저장소',
    services: ['google one', 'icloud', 'dropbox', 'onedrive', 'mybox', '네이버 mybox'],
    note: '파일 백업/저장 공간이 겹칩니다.',
  },
  {
    id: 'office-productivity',
    label: '오피스/생산성',
    services: ['microsoft 365', 'office365', 'notion', '노션', 'google workspace'],
    note: '문서/협업 도구 기능이 겹칩니다.',
  },
  {
    id: 'ecommerce-membership',
    label: '이커머스 멤버십',
    services: ['coupang wow', '쿠팡 와우', 'naver plus', '네이버플러스', 'amazon prime', '아마존 프라임'],
    note: '배송/할인 혜택이 겹칩니다.',
  },
]

const SEVERITY_ORDER: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2 }

/**
 * 겹치는 구독 묶음의 금액을 계산한다.
 *
 * 절약액을 "가장 싼 것 하나"로만 잡으면 이상치 앞에서 무의미해진다.
 * 월 27만원짜리와 월 7,500원짜리가 겹칠 때 "7,500원 아낍니다"라고 말하면
 * 정작 중요한 사실을 숨기는 셈이다. 그래서 두 숫자를 같이 낸다.
 *  - conservative: 가장 싼 것 하나만 정리 (합계 집계에 쓰는 안전한 값)
 *  - max: 제일 싼 것 하나만 남기고 나머지 정리 (실제 상한)
 */
function overlapAmounts(subs: Subscription[], settings: Settings) {
  const withMonthly = subs
    .map((s) => ({ sub: s, monthly: monthlyBase(s, settings) }))
    .sort((a, b) => b.monthly - a.monthly)
  const total = withMonthly.reduce((sum, x) => sum + x.monthly, 0)
  const cheapest = withMonthly[withMonthly.length - 1]
  const rest = withMonthly.slice(1)
  const conservative = rest.reduce((min, cur) => (cur.monthly < min.monthly ? cur : min), rest[0]).monthly
  return {
    withMonthly,
    names: withMonthly.map((x) => x.sub.service),
    total,
    conservative,
    max: total - cheapest.monthly,
    cheapestName: cheapest.sub.service,
  }
}

/** 겹침 안내 문구. 보수적 절약액과 상한을 같이 보여준다. */
function overlapSavingText(
  a: ReturnType<typeof overlapAmounts>,
  settings: Settings,
): string {
  const money = (n: number) => formatMoney(n, settings.baseCurrency)
  // 두 값이 사실상 같으면(구독 2개) 한 번만 말한다.
  if (Math.round(a.max) <= Math.round(a.conservative)) {
    return `가장 안 쓰는 하나를 정리하면 월 ${money(a.conservative)}을 아낍니다.`
  }
  return `가장 안 쓰는 하나만 정리해도 월 ${money(a.conservative)}, ${a.cheapestName} 하나로 합치면 최대 월 ${money(a.max)}을 아낍니다.`
}



function makeId(kind: FindingKind, parts: string[]): string {
  return `${kind}:${parts.join('|')}`
}

function matchesService(service: string, pattern: string): boolean {
  const s = service.toLowerCase()
  const p = pattern.toLowerCase()
  return s.includes(p) || p.includes(s)
}

/** 아래 Finding 을 전부 생성. monthlySaving 은 기준통화 월 환산. */
export function analyze(state: AppState, today?: string): Finding[] {
  const { subscriptions, series, ignoredSeriesKeys, settings } = state
  const dismissed = new Set(state.dismissedCandidates ?? [])
  const t = today ?? isoToday()
  const findings: Finding[] = []
  // 겹침 항목은 보수적 절약액이 아니라 '정리 상한'으로 줄세운다.
  // 그러지 않으면 월 30만원짜리 중복이 월 3만원짜리 밑으로 밀린다.
  const sortWeight = new Map<string, number>()

  const activeSubs = subscriptions.filter((s) => s.status === 'active' || s.status === 'trial')

  // ── category_overlap ────────────────────────────────────
  // categoriesOf() 는 주 카테고리 + 부가 카테고리를 모두 반환한다.
  // 한 구독이 여러 카테고리 그룹에 동시에 속할 수 있다(Google One: cloud + ai).
  const byCategory = new Map<Category, Subscription[]>()
  for (const sub of activeSubs) {
    for (const category of categoriesOf(sub)) {
      const list = byCategory.get(category) ?? []
      list.push(sub)
      byCategory.set(category, list)
    }
  }
  for (const [category, subs] of byCategory) {
    if (subs.length < 2) continue
    const amounts = overlapAmounts(subs, settings)
    const id = makeId('category_overlap', [category, ...subs.map((s) => s.id)])
    sortWeight.set(id, amounts.max)
    findings.push({
      id,
      kind: 'category_overlap',
      severity: 'medium',
      title: `${CATEGORY_LABEL[category]} 서비스 ${subs.length}개를 동시에 쓰고 있어요`,
      detail: `${amounts.names.join(', ')} 를 함께 구독 중입니다. 월 ${formatMoney(amounts.total, settings.baseCurrency)}. ${overlapSavingText(amounts, settings)}`,
      subscriptionIds: subs.map((s) => s.id),
      seriesKeys: [],
      monthlySaving: amounts.conservative,
    })
  }

  // ── feature_overlap ─────────────────────────────────────
  for (const group of FEATURE_OVERLAP_GROUPS) {
    const matched = activeSubs.filter((s) => {
      if (!group.services.some((p) => matchesService(s.service, p))) return false
      // 요금제 이름까지 봐야 한다. "YouTube Premium Lite" 는 Music 이 없다.
      const full = `${s.service} ${s.plan ?? ''}`.toLowerCase()
      return !(group.exclude ?? []).some((x) => full.includes(x.toLowerCase()))
    })
    if (matched.length < 2) continue
    const amounts = overlapAmounts(matched, settings)
    const id = makeId('feature_overlap', [group.id, ...matched.map((s) => s.id)])
    sortWeight.set(id, amounts.max)
    findings.push({
      id,
      kind: 'feature_overlap',
      severity: 'medium',
      title: `${group.label} 기능이 겹치는 서비스가 있어요`,
      detail: `${amounts.names.join(', ')} 를 함께 쓰고 있어요. ${group.note} 월 ${formatMoney(amounts.total, settings.baseCurrency)}. ${overlapSavingText(amounts, settings)}`,
      subscriptionIds: matched.map((s) => s.id),
      seriesKeys: [],
      monthlySaving: amounts.conservative,
    })
  }

  // ── unmatched_charge ─────────────────────────────────────
  for (const s of series) {
    if (s.matchedSubscriptionId) continue
    if (s.stale) continue
    if (s.confidence < 0.6) continue
    if (ignoredSeriesKeys.includes(s.key)) continue
    // 두 가지를 반드시 맞춰야 한다.
    //  ① 통화: $220 짜리를 220원으로 세면 절약액이 100배 넘게 틀어진다.
    //  ② 주기: 연간/다년 결제를 그대로 쓰면 월 절약액이 부풀려진다.
    const seriesCurrency = s.currency ?? settings.baseCurrency
    const months = cycleToMonths(s.inferredCycle, s.inferredCycleDays)
    const monthlySaving = toBase(s.medianAmount, seriesCurrency, settings) / months

    const cycleWord =
      s.inferredCycle === 'custom'
        ? cycleText(s.inferredCycle, s.inferredCycleDays)
        : `${cycleText(s.inferredCycle)} 결제`
    // 월 환산이 필요 없고 기준통화와 같으면 굳이 괄호를 달지 않는다.
    const needsNote = months !== 1 || seriesCurrency !== settings.baseCurrency
    const cycleNote = needsNote
      ? ` (${cycleWord} → 월 ${formatMoney(monthlySaving, settings.baseCurrency)} 꼴)`
      : ''
    const evidence =
      s.occurrences.length >= 2
        ? `${s.occurrences.length}차례 결제가 반복됐습니다`
        : '반복 결제로 보이는 기록이 있습니다'

    findings.push({
      id: makeId('unmatched_charge', [s.key]),
      kind: 'unmatched_charge',
      severity: 'high',
      title: `${s.merchantRaw} 에서 잊고 있던 구독이 발견됐어요`,
      detail: `${s.merchantRaw} 로 ${evidence}. 매번 약 ${formatMoney(s.medianAmount, seriesCurrency)}씩${cycleNote}, 등록부엔 없는 결제입니다. 계속 필요한지 확인해보세요.`,
      subscriptionIds: [],
      seriesKeys: [s.key],
      monthlySaving,
    })
  }

  // ── zombie ───────────────────────────────────────────────
  for (const sub of activeSubs) {
    if (!sub.lastUsedAt) continue
    const idleDays = daysBetween(sub.lastUsedAt, t)
    if (idleDays < settings.zombieAfterDays) continue
    const saving = monthlyBase(sub, settings)
    findings.push({
      id: makeId('zombie', [sub.id]),
      kind: 'zombie',
      severity: 'low',
      title: `${sub.service} 를 ${idleDays}일 동안 안 썼어요`,
      detail: `${sub.service}(${sub.plan || '기본 요금제'})를 마지막으로 쓴 지 ${idleDays}일이 지났습니다. 해지하면 월 ${formatMoney(saving, settings.baseCurrency)}을 아낍니다.`,
      subscriptionIds: [sub.id],
      seriesKeys: [],
      monthlySaving: saving,
    })
  }

  // ── stale_series ─────────────────────────────────────────
  for (const s of series) {
    if (!s.matchedSubscriptionId) continue
    if (!s.stale) continue
    const sub = subscriptions.find((x) => x.id === s.matchedSubscriptionId)
    // 통신사 결합/번들/기프트카드 등은 명세서·영수증에 안 잡히는 게 정상이다.
    // 이 결제 경로로 등록된 구독은 결제가 실제로 끊겼다고 오진하지 않는다.
    if (sub?.billingChannel && CHANNELS_WITHOUT_RECEIPTS.includes(sub.billingChannel)) continue
    findings.push({
      id: makeId('stale_series', [s.key]),
      kind: 'stale_series',
      severity: 'low',
      title: `${s.merchantRaw} 결제가 끊긴 것 같아요`,
      detail: `${sub ? sub.service : s.merchantRaw} 는 등록돼 있지만 최근 결제 내역이 끊겼습니다(마지막 결제 ${s.lastSeen}). 등록부 정리가 필요합니다.`,
      subscriptionIds: sub ? [sub.id] : [],
      seriesKeys: [s.key],
      monthlySaving: 0,
    })
  }

  // ── unconfirmed_service ──────────────────────────────────
  //
  // 계정 메일은 오는데 결제 영수증이 없는 서비스. Netflix 처럼 통신사 결합으로
  // 내면 정상적으로 이렇게 된다 — 진짜 쓰고 있는데 증거만 없는 것이다.
  // 반대로 예전에 해지했는데 마케팅 메일만 남은 것일 수도 있다.
  // 앱은 둘을 구분할 수 없다. 그래서 지우지도 등록하지도 않고 사용자에게 물어본다.
  {
    const registered = new Set<string>()
    for (const sub of subscriptions) {
      registered.add(normalizeMerchant(sub.service))
      for (const p of sub.merchantPatterns) registered.add(normalizeMerchant(p))
    }
    // 반복 결제가 잡힌 서비스는 이미 증거가 있다. 여기 낄 자리가 아니다.
    const proven = new Set(series.map((s) => s.key))

    const candidates = new Map<string, { service: string; category?: Category; last: string; n: number }>()
    for (const r of state.receipts ?? []) {
      if (!r.service) continue
      const key = normalizeMerchant(r.service)
      // 이미 등록됐거나, 결제 증거가 있거나, 사용자가 아니라고 정리한 건 뺀다.
      // 이 세 줄이 "다음 스캔에서 또 뜨는" 문제를 막는다.
      if (registered.has(key) || proven.has(key) || dismissed.has(key)) continue
      if (ignoredSeriesKeys.includes(key)) continue

      const prev = candidates.get(key)
      candidates.set(key, {
        service: r.service,
        category: r.category ?? prev?.category,
        last: !prev || r.receivedAt > prev.last ? r.receivedAt : prev.last,
        n: (prev?.n ?? 0) + 1,
      })
    }

    for (const [key, c] of candidates) {
      findings.push({
        id: makeId('unconfirmed_service', [key]),
        kind: 'unconfirmed_service',
        severity: 'low',
        title: `${c.service} 를 구독 중인가요?`,
        detail:
          `${c.service} 계정 메일은 ${c.n}건 왔는데(마지막 ${c.last}) 결제 영수증이 없습니다. ` +
          '통신사 결합이나 기프트카드로 내면 영수증이 안 오기도 하고, 예전에 해지했는데 안내 메일만 남은 것일 수도 있어요. ' +
          '구독 중이면 추가하고, 아니면 목록에서 지우세요.',
        subscriptionIds: [],
        seriesKeys: [],
        monthlySaving: 0,
        candidate: { key, service: c.service, category: c.category },
      })
    }
  }

  // ── trial_ending ─────────────────────────────────────────
  for (const sub of subscriptions) {
    if (sub.status !== 'trial') continue
    if (!sub.trialEndsAt) continue
    const remaining = daysBetween(t, sub.trialEndsAt)
    if (remaining < 0 || remaining > 7) continue
    findings.push({
      id: makeId('trial_ending', [sub.id]),
      kind: 'trial_ending',
      severity: 'high',
      title: `${sub.service} 무료체험이 곧 끝나요`,
      detail: `${sub.service} 무료체험이 ${remaining}일 후(${sub.trialEndsAt}) 종료되고 유료 전환됩니다. 계속 쓸지 지금 결정하세요.`,
      subscriptionIds: [sub.id],
      seriesKeys: [],
      monthlySaving: 0,
    })
  }

  // ── annual_saving ────────────────────────────────────────
  for (const sub of activeSubs) {
    if (sub.cycle !== 'monthly') continue
    if (!sub.tags.includes('annual-available')) continue
    const saving = monthlyBase(sub, settings) * 0.15
    findings.push({
      id: makeId('annual_saving', [sub.id]),
      kind: 'annual_saving',
      severity: 'low',
      title: `${sub.service} 를 연간 결제로 바꾸면 절약돼요`,
      detail: `${sub.service} 는 연간 결제 옵션이 있습니다. 연간으로 바꾸면 약 15%, 월 ${formatMoney(saving, settings.baseCurrency)}을 아낄 수 있습니다.`,
      subscriptionIds: [sub.id],
      seriesKeys: [],
      monthlySaving: saving,
    })
  }

  // ── duplicate_plan ───────────────────────────────────────
  const byService = new Map<string, Subscription[]>()
  for (const sub of activeSubs) {
    const key = sub.service.trim().toLowerCase()
    const list = byService.get(key) ?? []
    list.push(sub)
    byService.set(key, list)
  }
  for (const subs of byService.values()) {
    if (subs.length < 2) continue
    const withMonthly = subs
      .map((s) => ({ sub: s, monthly: monthlyBase(s, settings) }))
      .sort((a, b) => b.monthly - a.monthly)
    const rest = withMonthly.slice(1)
    const cheapestOfRest = rest.reduce((min, cur) => (cur.monthly < min.monthly ? cur : min), rest[0])
    const plans = withMonthly.map((x) => x.sub.plan || '(요금제 미지정)')
    findings.push({
      id: makeId('duplicate_plan', subs.map((s) => s.id)),
      kind: 'duplicate_plan',
      severity: 'medium',
      title: `${subs[0].service} 요금제가 중복 등록돼 있어요`,
      detail: `${subs[0].service} 요금제(${plans.join(', ')})가 ${subs.length}건 등록돼 있습니다. 하나로 정리하면 월 ${formatMoney(cheapestOfRest.monthly, settings.baseCurrency)}을 아낍니다.`,
      subscriptionIds: subs.map((s) => s.id),
      seriesKeys: [],
      monthlySaving: cheapestOfRest.monthly,
    })
  }

  // 같은 구독 묶음을 카테고리 중복과 기능 겹침이 둘 다 잡으면 사용자는 같은 얘기를
  // 같은 겹침을 두 번 말하지 않는다.
  //
  // 한쪽 구독 집합이 다른 쪽에 통째로 들어가면 둘은 같은 사실을 다르게 말하는 것이다.
  // 예전에는 "기능 겹침 ⊆ 카테고리 중복" 한 방향만 봤는데, 반대 방향이 실제로 나왔다:
  // 카테고리 중복(ChatGPT·Claude)이 기능 겹침(ChatGPT·Claude·Google One)에 포함돼
  // "AI 서비스 2개"와 "AI 챗봇 기능 겹침"이 나란히 떴다.
  //
  // 더 나쁜 건 헤드라인이다. 둘의 절약액을 합산하니 같은 겹침을 두 번 세어
  // "아낄 수 있는 금액"이 부풀었다. 그래서 겹치면 하나만 남기고,
  // 남길 쪽은 실제로 더 아낄 수 있는 안내를 고른다.
  const nested = (a: Finding, b: Finding) =>
    a.subscriptionIds.length > 0 && a.subscriptionIds.every((id) => b.subscriptionIds.includes(id))

  const overlaps = findings.filter(
    (f) => f.kind === 'feature_overlap' || f.kind === 'category_overlap',
  )
  const dropped = new Set<string>()
  for (const a of overlaps) {
    if (dropped.has(a.id)) continue
    for (const b of overlaps) {
      if (a.id === b.id || dropped.has(b.id)) continue
      if (!nested(a, b) && !nested(b, a)) continue
      const loser = a.monthlySaving >= b.monthlySaving ? b : a
      dropped.add(loser.id)
      if (loser.id === a.id) break
    }
  }
  const deduped = findings.filter((f) => !dropped.has(f.id))
  findings.length = 0
  findings.push(...deduped)

  findings.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (sev !== 0) return sev
    const wa = sortWeight.get(a.id) ?? a.monthlySaving
    const wb = sortWeight.get(b.id) ?? b.monthlySaving
    return wb - wa
  })

  return findings
}

function isoToday(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map((v) => parseInt(v, 10))
  const [ty, tm, td] = toIso.split('-').map((v) => parseInt(v, 10))
  const a = Date.UTC(fy, fm - 1, fd)
  const b = Date.UTC(ty, tm - 1, td)
  return Math.round((b - a) / (1000 * 60 * 60 * 24))
}
