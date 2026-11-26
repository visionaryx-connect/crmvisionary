import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { capturePwaInstallPrompt, lockIosAppHeight } from './lib/pwa'
import './styles.css'

capturePwaInstallPrompt()
lockIosAppHeight()

// Fixed-scale app: block pinch-zoom (iOS gesture events, multi-touch moves) and trackpad pinch (ctrl + wheel).
// Keyboard/browser-menu zoom on desktop is left to the browser.
const block = (e: Event) => e.preventDefault()
document.addEventListener('gesturestart', block, { passive: false })
document.addEventListener('gesturechange', block, { passive: false })
document.addEventListener('gestureend', block, { passive: false })
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault() }, { passive: false })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Installable app: register the service worker in production builds only (dev uses Vite HMR).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  })
}
