import { readFileSync, existsSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `.dev.vars` 에서 **브라우저에 나가도 되는 값만** 골라 읽는다.
 *
 * 이 앱은 서버가 없다. define 으로 넣은 값은 전부 JS 번들에 평문으로 박힌다.
 * 그래서 화이트리스트 방식이다. GOOGLE_CLIENT_SECRET / SESSION_SECRET 같은 건
 * 여기 목록에 없으므로 실수로도 새어나가지 않는다.
 *
 * - GOOGLE_CLIENT_ID: OAuth implicit flow 에서 공개되는 게 정상인 값
 * - GEMINI_API_KEY:   개인 무료티어 키. 로컬 전용이라 편의상 허용한다.
 *                     남에게 배포할 빌드라면 이걸 비우고 설정 탭에서 직접 넣게 한다.
 */
const PUBLIC_KEYS = ['GOOGLE_CLIENT_ID', 'GEMINI_API_KEY'] as const

function loadDevVars(): Record<string, string> {
  if (!existsSync('.dev.vars')) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    if (!(PUBLIC_KEYS as readonly string[]).includes(m[1])) continue
    const v = m[2].trim().replace(/^["']|["']$/g, '')
    if (v) out[m[1]] = v
  }
  return out
}

export default defineConfig(() => {
  const vars = loadDevVars()
  return {
    plugins: [react()],
    define: {
      __GOOGLE_CLIENT_ID__: JSON.stringify(vars.GOOGLE_CLIENT_ID ?? ''),
      __GEMINI_API_KEY__: JSON.stringify(vars.GEMINI_API_KEY ?? ''),
    },
    // 개발 서버를 띄우면 브라우저를 자동으로 연다. 받아서 바로 쓰기 위한 것.
    server: { port: 5273, open: true },
  }
})
