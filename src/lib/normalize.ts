// ─────────────────────────────────────────────────────────────
// 가맹점명 정규화 & 알려진 서비스 매칭
// ─────────────────────────────────────────────────────────────
import type { Category } from '../types'

/** "(주)넷플릭스서비시스코리아 12345" -> "넷플릭스서비시스코리아" 처럼
 *  소문자화, 공백/특수문자/지점코드/(주)/㈜/승인번호 꼬리 제거. */
export function normalizeMerchant(raw: string): string {
  if (!raw) return ''
  let s = raw.trim()
  // 상호 표기의 (주)/㈜ 제거
  s = s.replace(/\(주\)|㈜/g, '')
  // 꼬리의 지점코드/승인번호 등 숫자열 제거 (공백/구분자 포함)
  s = s.replace(/[\s\-*#]*\d{2,}[\s\-*#\d]*$/g, '')
  s = s.toLowerCase()
  // 한글/영문/숫자만 남기고 공백/특수문자 전부 제거
  s = s.replace(/[^\p{L}\p{N}]/gu, '')
  return s
}

export interface KnownService {
  service: string // 표시용 정식명 "Netflix"
  category: Category
  match: string[] // merchantNorm 에 포함되면 매칭되는 조각들(소문자)
  cancelUrl?: string
}

/** 최소 60개 이상. 한국 카드 명세서에 실제로 찍히는 표기를 포함할 것. */
export const KNOWN_SERVICES: KnownService[] = [
  { service: 'Netflix', category: 'ott', match: ['netflix', '넷플릭스'], cancelUrl: 'https://www.netflix.com/cancelplan' },
  { service: 'YouTube Premium', category: 'video', match: ['youtube premium', '유튜브프리미엄', 'google*youtube', 'googleyoutube'] },
  { service: 'Spotify', category: 'music', match: ['spotify', '스포티파이'] },
  { service: 'TVING', category: 'ott', match: ['tving', '티빙'] },
  { service: 'Wavve', category: 'ott', match: ['wavve', '웨이브'] },
  { service: 'Watcha', category: 'ott', match: ['watcha', '왓챠'] },
  { service: 'Disney+', category: 'ott', match: ['disney', '디즈니'] },
  { service: 'Coupang Play', category: 'ott', match: ['coupang play', '쿠팡플레이'] },
  { service: 'Laftel', category: 'ott', match: ['laftel', '라프텔'] },
  { service: 'Apple TV', category: 'ott', match: ['apple tv', 'appletv'] },
  { service: 'Melon', category: 'music', match: ['melon', '멜론'] },
  { service: 'Genie', category: 'music', match: ['genie', '지니뮤직', '지니'] },
  { service: 'FLO', category: 'music', match: ['flo', '플로'] },
  { service: 'Bugs', category: 'music', match: ['bugs', '벅스'] },
  { service: 'Apple Music', category: 'music', match: ['apple music', 'applemusic'] },
  { service: 'ChatGPT', category: 'ai', match: ['openai', 'chatgpt'] },
  { service: 'Claude', category: 'ai', match: ['anthropic', 'claude'] },
  { service: 'Google Gemini', category: 'ai', match: ['google gemini', 'gemini'] },
  { service: 'Perplexity', category: 'ai', match: ['perplexity'] },
  { service: 'Midjourney', category: 'ai', match: ['midjourney'] },
  { service: 'Cursor', category: 'dev', match: ['cursor'] },
  { service: 'GitHub Copilot', category: 'dev', match: ['github copilot', 'githubcopilot'] },
  { service: 'Google One', category: 'cloud', match: ['google one', 'googleone', 'google storage'] },
  { service: 'iCloud', category: 'cloud', match: ['icloud', 'apple.com/bill', 'applebill'] },
  { service: 'Dropbox', category: 'cloud', match: ['dropbox'] },
  { service: 'Naver MYBOX', category: 'cloud', match: ['naver mybox', '네이버 mybox', '네이버마이박스'] },
  { service: 'OneDrive', category: 'cloud', match: ['onedrive'] },
  { service: 'Notion', category: 'productivity', match: ['notion'] },
  { service: 'Todoist', category: 'productivity', match: ['todoist'] },
  { service: 'Microsoft 365', category: 'productivity', match: ['microsoft 365', 'office365'] },
  { service: 'Slack', category: 'communication', match: ['slack'] },
  { service: 'Zoom', category: 'communication', match: ['zoom'] },
  { service: 'Evernote', category: 'productivity', match: ['evernote'] },
  { service: 'GitHub', category: 'dev', match: ['github'] },
  { service: 'JetBrains', category: 'dev', match: ['jetbrains'] },
  { service: 'Vercel', category: 'dev', match: ['vercel'] },
  { service: 'Netlify', category: 'dev', match: ['netlify'] },
  { service: 'AWS', category: 'dev', match: ['aws', 'amazon web services'] },
  { service: 'Figma', category: 'design', match: ['figma'] },
  { service: 'Adobe', category: 'design', match: ['adobe'] },
  { service: 'Canva', category: 'design', match: ['canva'] },
  { service: '쿠팡 와우', category: 'membership', match: ['coupang wow', '쿠팡 와우', '쿠팡와우'] },
  { service: '네이버플러스', category: 'membership', match: ['naver plus', '네이버플러스', '네이버 플러스'] },
  { service: 'Amazon Prime', category: 'membership', match: ['amazon prime', '아마존 프라임', '아마존프라임'] },
  { service: '마켓컬리', category: 'membership', match: ['market kurly', '마켓컬리'] },
  { service: 'Xbox Game Pass', category: 'gaming', match: ['xbox game pass', 'xboxgamepass'] },
  { service: 'PlayStation Plus', category: 'gaming', match: ['playstation plus', 'playstationplus'] },
  { service: 'Nintendo Switch Online', category: 'gaming', match: ['nintendo switch online', '닌텐도 스위치 온라인', '닌텐도스위치'] },
  { service: 'Steam', category: 'gaming', match: ['steam', '스팀'] },
  { service: '밀리의서재', category: 'news', match: ['millie', '밀리의서재'] },
  { service: 'RIDI', category: 'news', match: ['ridi', '리디'] },
  { service: '윌라', category: 'news', match: ['willa', '윌라'] },
  { service: 'Class101', category: 'education', match: ['class101', '클래스101'] },
  { service: '인프런', category: 'education', match: ['inflearn', '인프런'] },
  { service: 'Coursera', category: 'education', match: ['coursera'] },
  { service: 'Udemy', category: 'education', match: ['udemy'] },
  { service: 'LinkedIn Learning', category: 'education', match: ['linkedin', '링크드인'] },
  { service: 'NordVPN', category: 'security', match: ['nordvpn'] },
  { service: 'ExpressVPN', category: 'security', match: ['expressvpn'] },
  { service: '1Password', category: 'security', match: ['1password'] },
  { service: 'Bitwarden', category: 'security', match: ['bitwarden'] },
  { service: '알약', category: 'security', match: ['알약'] },
  { service: 'V3', category: 'security', match: ['v3'] },
  { service: '헬스장', category: 'fitness', match: ['헬스장', '피트니스'] },
  { service: 'ClassPass', category: 'fitness', match: ['classpass', '클래스패스'] },
]

/** 정규화된 가맹점명에서 알려진 서비스명을 찾는다. 못 찾으면 undefined. */
export function guessServiceName(merchantNorm: string): string | undefined {
  const found = findKnownService(merchantNorm)
  return found?.service
}

/** 못 찾으면 'other'. */
export function guessCategory(merchantNorm: string): Category {
  const found = findKnownService(merchantNorm)
  return found?.category ?? 'other'
}

function findKnownService(merchantNorm: string): KnownService | undefined {
  if (!merchantNorm) return undefined
  for (const svc of KNOWN_SERVICES) {
    for (const m of svc.match) {
      const normalizedMatch = normalizeMerchant(m)
      if (normalizedMatch && merchantNorm.includes(normalizedMatch)) return svc
    }
  }
  return undefined
}
