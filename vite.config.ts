import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages はリポジトリ名のサブパス(https://<owner>.github.io/UGS/)で配信されるため
  // base を '/UGS/' に固定している。独自ドメイン等に移行する場合はここを '/' に戻すこと。
  // 開発サーバー(npm run dev / dev:host)もこの base 配下(http://localhost:5173/UGS/)で動く。
  base: '/UGS/',
})
