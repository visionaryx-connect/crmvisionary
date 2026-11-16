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
