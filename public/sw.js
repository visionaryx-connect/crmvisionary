// Visionary X Operations service worker.
// Purpose: make the app installable, keep the shell loading on flaky mobile networks, and show Web Push notifications.
// It never touches /api or /ws — all data stays live and authenticated, nothing private is cached.
const VERSION = 'vx-ops-v3'
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg?v=2', '/icons/icon-192.png?v=2', '/icons/apple-touch-icon.png?v=2', '/brand/vx-orb-64.png', '/brand/vx-orb-128.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return

  // Page navigations: always try the network (fresh deploys), fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(VERSION).then((c) => c.put('/', copy))
          }
          return res
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    )
    return
  }

  // Hashed build assets never change: cache-first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(VERSION).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
  }
})

// ───────── Web Push ─────────
// Payloads are encrypted end-to-end (RFC 8291) by the Worker. They carry a title, a short body and an in-app path;
// the page they open re-checks the person's permissions, so a notification never grants access by itself.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Visionary X', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Visionary X'
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/notifications'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png?v=2',
      // Android draws the badge as a white silhouette: the transparent orb gives a clean circle.
      badge: '/brand/vx-orb-64.png',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url, notificationId: data.notificationId || null },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/notifications', self.location.origin)
  if (target.origin !== self.location.origin) return
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          w.navigate(target.href).catch(() => {})
          return w.focus()
        }
      }
      return self.clients.openWindow(target.href)
    }),
  )
})

// The push service rotated the subscription: re-subscribe with the same key and tell the server (session cookie).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription
      const key = old && old.options && old.options.applicationServerKey
      if (!key) return
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      const json = sub.toJSON()
      const me = await fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (!me || !me.csrfToken) return
      await fetch('/api/notifications/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrfToken },
        body: JSON.stringify({ endpoint: json.endpoint, expirationTime: json.expirationTime, keys: json.keys, deviceLabel: 'Renewed subscription' }),
      })
    })(),
  )
})
