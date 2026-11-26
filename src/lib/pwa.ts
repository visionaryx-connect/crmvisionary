// Install-to-home-screen support. Android/desktop Chrome fire `beforeinstallprompt`, which we hold until the user
// asks to install. iOS Safari has no prompt API, so the UI shows the Share → Add to Home Screen steps instead.
import { useEffect, useState } from 'react'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

export function capturePwaInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
}

export const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/**
 * iOS home-screen apps run under the status bar (black-translucent), and iOS can report the viewport (100dvh /
 * innerHeight) shorter than the physical screen. Anything sized or pinned to that viewport then stops short and
 * leaves a dead strip at the bottom. In that mode we size the app to the physical screen instead
 * (--app-height) and stop the document itself from scrolling (html.ios-app).
 */
export function lockIosAppHeight() {
  if (!isIos() || !isStandalone()) return
  const root = document.documentElement
  root.classList.add('ios-app')
  const apply = () => {
    const portrait = window.matchMedia('(orientation: portrait)').matches
    const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)
    root.style.setProperty('--app-height', `${Math.max(window.innerHeight, screenH)}px`)
  }
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', () => setTimeout(apply, 250))
  // Returning from the background is when iOS most often mis-reports the height.
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && apply())
}

export function usePwaInstall() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  const installed = isStandalone()
  return {
    installed,
    /** Native one-tap install is available (Android / Chromium). */
    canPrompt: !installed && deferred !== null,
    ios: isIos(),
    async prompt(): Promise<boolean> {
      if (!deferred) return false
      const ev = deferred
      deferred = null
      notify()
      await ev.prompt()
      return (await ev.userChoice).outcome === 'accepted'
    },
  }
}
