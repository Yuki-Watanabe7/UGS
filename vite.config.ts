import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFile } from 'node:fs/promises'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'github-pages-spa-fallback',
      // GitHub Pagesは存在しないパスを404.htmlへ渡す。ビルド後のindex.htmlと同じ
      // アプリシェルを404.htmlにも配置し、共有URL・再読み込みでもHistory APIの
      // pathnameを保ったままクライアント側ルーターを起動できるようにする。
      async closeBundle() {
        await copyFile('dist/index.html', 'dist/404.html')
      },
    },
  ],
  // GitHub Pages はリポジトリ名のサブパス(https://<owner>.github.io/UGS/)で配信されるため
  // base を '/UGS/' に固定している。独自ドメイン等に移行する場合はここを '/' に戻すこと。
  // 開発サーバー(npm run dev / dev:host)もこの base 配下(http://localhost:5173/UGS/)で動く。
  base: '/UGS/',
})
