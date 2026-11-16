import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { capturePwaInstallPrompt } from './lib/pwa'
import './styles.css'

capturePwaInstallPrompt()

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
