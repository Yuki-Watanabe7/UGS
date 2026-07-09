import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// PWA用Service Worker(public/sw.js)の登録。devサーバーではHMRとの干渉や
// キャッシュ起因の混乱を避けるため本番ビルドのみ有効にする。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
      console.warn('Service Workerの登録に失敗しました:', error)
    })
  })
}
