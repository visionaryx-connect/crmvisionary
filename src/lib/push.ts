// Browser / installed-PWA push subscriptions. The browser permission prompt is only ever shown after the person
// clicks "Enable on this device" — never automatically — and never again once they have denied it (the browser
// remembers the denial; we show how to re-enable it in site settings instead).
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

export type PushState = 'unsupported' | 'disabled-server' | 'denied' | 'subscribed' | 'available' | 'ios-install'

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing) return existing
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  const os = /android/i.test(ua) ? 'Android' : isIos() ? 'iPhone/iPad' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Device'
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser'
  return `${browser} on ${os}${isStandalone() ? ' (app)' : ''}`
}

export function usePush() {
  const [state, setState] = useState<PushState>('unsupported')
  const [busy, setBusy] = useState(false)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [serverProblem, setServerProblem] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!pushSupported()) return setState(isIos() && !isStandalone() ? 'ios-install' : 'unsupported')
    const cfg = await api.get<{ enabled: boolean; publicKey: string | null; problem?: string | null }>('/api/notifications/push/config').catch(() => ({ enabled: false, publicKey: null, problem: null }))
    setServerProblem(cfg.problem ?? null)
    if (!cfg.enabled) return setState('disabled-server')
    if (Notification.permission === 'denied') return setState('denied')
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    setEndpoint(sub?.endpoint ?? null)
    setState(sub && Notification.permission === 'granted' ? 'subscribed' : 'available')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      const cfg = await api.get<{ enabled: boolean; publicKey: string | null; problem?: string | null }>('/api/notifications/push/config')
      if (!cfg.enabled || !cfg.publicKey) throw new Error(cfg.problem ?? 'Push notifications are not configured on the server yet.')
      // Only now, in response to the click, does the browser ask for permission.
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'available')
        return false
      }
      const reg = await registration()
      const serverKey = keyBytes(cfg.publicKey)
      let sub = await reg.pushManager.getSubscription()
      // A subscription made with an older server key can never receive pushes (and blocks a new one): replace it.
      if (sub && !sameKey(sub.options.applicationServerKey, serverKey)) {
        await sub.unsubscribe().catch(() => undefined)
        sub = null
      }
      if (!sub) {
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(/applicationServerKey|key/i.test(msg)
            ? 'The server’s push key was rejected by this browser. Ask an administrator to check the VAPID keys in Notification center → Overview.'
            : `This browser could not subscribe to push notifications (${msg}). Check that notifications are allowed for this site and try again.`)
        }
      }
      const json = sub.toJSON() as { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } }
      await api.post('/api/notifications/push/subscriptions', { endpoint: json.endpoint, expirationTime: json.expirationTime, keys: json.keys, deviceLabel: deviceLabel() })
      setEndpoint(json.endpoint)
      setState('subscribed')
      return true
    } finally {
      setBusy(false)
    }
  }, [])

  const disable = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration('/')
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await api.post('/api/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined)
        await sub.unsubscribe()
      }
      setEndpoint(null)
      setState('available')
    } finally {
      setBusy(false)
    }
  }, [])

  return { state, busy, endpoint, serverProblem, enable, disable, refresh }
}

/**
 * After sign-in, re-register an existing subscription so the server binds it to whoever is signed in on this
 * browser (and picks up rotated keys). Never prompts.
 */
export async function syncPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return
  try {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return
    const cfg = await api.get<{ enabled: boolean; publicKey: string | null }>('/api/notifications/push/config')
    if (!cfg.enabled || !cfg.publicKey) return
    if (!sameKey(sub.options.applicationServerKey, keyBytes(cfg.publicKey))) {
      // Keys were rotated: the old subscription is dead. The person re-enables from Preferences → Devices.
      await sub.unsubscribe().catch(() => undefined)
      return
    }
    const json = sub.toJSON() as { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } }
    await api.post('/api/notifications/push/subscriptions', { endpoint: json.endpoint, expirationTime: json.expirationTime, keys: json.keys, deviceLabel: deviceLabel() })
  } catch {
    /* best effort */
  }
}
