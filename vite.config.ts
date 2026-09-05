import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 개발 서버를 띄우면 브라우저를 자동으로 연다. 받아서 바로 쓰기 위한 것.
  server: { port: 5273, open: true },
})
