import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import WatchView from './components/WatchView.tsx'

// `?watch=1` or the plain path `/watch` (server/src/index.js aliases it to
// the same index.html) renders the 3-number smartwatch view instead of the
// full dashboard — see WatchView.tsx for why both entry points exist.
const isWatchView = new URLSearchParams(window.location.search).has('watch') || window.location.pathname === '/watch'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWatchView ? <WatchView /> : <App />}
  </StrictMode>,
)

// Registered for PWA installability (manifest + active service worker).
// Skipped in local dev (localhost proxies /assets to Vite's dev server,
// which the cache-first handler isn't meant for).
//
// Served from /sw (no extension), not /sw.js — see the /sw route comment
// in server/src/index.js for why: Cloudflare's edge otherwise caches this
// response by URL extension regardless of the origin's Cache-Control.
if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw', { scope: '/' }).catch(() => {});
  });
}
