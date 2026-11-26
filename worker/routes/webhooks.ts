// Provider webhooks. Not behind a staff session: authenticity is proven by a shared secret that Brevo sends with
// every call (configure the webhook with a custom header `X-VX-Webhook-Token: <BREVO_WEBHOOK_SECRET>`, or its
// bearer-token authentication). Requests without a valid secret are rejected before the body is parsed. Each event
// is stored once (unique dedupe key), so Brevo's retries and duplicate deliveries are harmless.

import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { newId, safeEqual, sha256Hex } from '../lib/crypto'
import { nowIso, one } from '../lib/db'
import { ApiError } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'
import { normaliseMessageId } from '../services/brevo'

const webhooks = new Hono<AppBindings>()

/** How each Brevo transactional event moves a delivery. Ranked so late / out-of-order events never regress state. */
const BREVO_EVENT: Record<string, { status?: string; rank: number; stamp?: 'delivered_at' | 'opened_at' | 'clicked_at'; suppress?: string }> = {
  request: { status: 'sent', rank: 2 },
  sent: { status: 'sent', rank: 2 },
  deferred: { status: 'deferred', rank: 3 },
  soft_bounce: { status: 'deferred', rank: 3 },
  delivered: { status: 'delivered', rank: 4, stamp: 'delivered_at' },
  opened: { status: 'opened', rank: 5, stamp: 'opened_at' },
  unique_opened: { status: 'opened', rank: 5, stamp: 'opened_at' },
  proxy_open: { status: 'opened', rank: 5, stamp: 'opened_at' },
  unique_proxy_open: { status: 'opened', rank: 5, stamp: 'opened_at' },
  click: { status: 'clicked', rank: 6, stamp: 'clicked_at' },
  // Terminal failures override any progress state.
  hard_bounce: { status: 'bounced', rank: 10, suppress: 'Hard bounce' },
  invalid_email: { status: 'bounced', rank: 10, suppress: 'Invalid address' },
  blocked: { status: 'blocked', rank: 10, suppress: 'Blocked by Brevo' },
  spam: { status: 'spam', rank: 10, suppress: 'Marked as spam' },
  unsubscribed: { status: 'unsubscribed', rank: 9, suppress: 'Unsubscribed' },
  error: { status: 'failed', rank: 10 },
}
const RANK: Record<string, number> = { queued: 0, sending: 0, retry: 0, accepted: 1, sent: 2, deferred: 3, delivered: 4, opened: 5, clicked: 6, unsubscribed: 9, failed: 10, bounced: 10, blocked: 10, spam: 10, skipped: 0 }

function authorised(c: { req: { header(n: string): string | undefined } }, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false
  const token = c.req.header('x-vx-webhook-token')
  if (token && safeEqual(token, secret)) return true
  const auth = c.req.header('authorization') ?? ''
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), secret)) return true
  if (auth.startsWith('Basic ')) {
    try {
      const [, pass] = atob(auth.slice(6).trim()).split(':')
      if (pass && safeEqual(pass, secret)) return true
    } catch {
      /* malformed */
    }
  }
  return false
}

interface BrevoEvent {
  event?: string
  email?: string
  'message-id'?: string
  messageId?: string
  ts_event?: number
  ts?: number
  ts_epoch?: number
  date?: string
  reason?: string
  link?: string
  'X-Mailin-custom'?: string
}

webhooks.post('/brevo', async (c) => {
  if (!c.env.BREVO_WEBHOOK_SECRET) throw new ApiError(503, 'NOT_CONFIGURED', 'Webhook secret is not configured')
  if (!authorised(c, c.env.BREVO_WEBHOOK_SECRET)) {
    await rateLimit(c.env.DB, `brevo-webhook-bad:${c.req.header('cf-connecting-ip') ?? 'unknown'}`, 30, 600)
    throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid webhook credentials')
  }
  const text = await c.req.text()
  if (text.length > 512 * 1024) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed JSON')
  }
  const events = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, 500) as BrevoEvent[]
  let processed = 0
  let duplicates = 0
  let unmatched = 0
  for (const e of events) {
    const name = String(e.event ?? '').toLowerCase()
    const messageId = normaliseMessageId(e['message-id'] ?? e.messageId ?? null)
    const occurredSec = e.ts_event ?? e.ts ?? (e.ts_epoch ? Math.floor(e.ts_epoch / 1000) : null)
    const occurredAt = occurredSec ? new Date(occurredSec * 1000).toISOString() : null
    const dedupe = await sha256Hex(`${messageId}|${name}|${occurredSec ?? e.date ?? ''}|${e.link ?? ''}|${e.email ?? ''}`)
    // Our own delivery id travels in X-Mailin-custom; fall back to the Brevo message id.
    const custom = typeof e['X-Mailin-custom'] === 'string' ? e['X-Mailin-custom'] : null
    const delivery = await one<{ id: string; status: string; user_id: string }>(
      c.env.DB,
      `SELECT id, status, user_id FROM notification_deliveries WHERE channel = 'email' AND (id = ? OR (provider_message_id IS NOT NULL AND provider_message_id = ?)) LIMIT 1`,
      custom ?? '',
      messageId ?? '',
    )
    const ins = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO notification_delivery_events (id, delivery_id, provider, event, message_id, email, reason, occurred_at, dedupe_key, raw, received_at) VALUES (?, ?, 'brevo', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(newId('nde'), delivery?.id ?? null, name.slice(0, 40), messageId, e.email?.slice(0, 254) ?? null, e.reason?.slice(0, 500) ?? null, occurredAt, dedupe, JSON.stringify(e).slice(0, 4000), nowIso())
      .run()
    if (!ins.meta.changes) {
      duplicates++
      continue
    }
    if (!delivery) {
      unmatched++
      continue
    }
    processed++
    const map = BREVO_EVENT[name]
    if (!map) continue
    const now = nowIso()
    const stampCol = map.stamp
    const advance = map.status && map.rank >= (RANK[delivery.status] ?? 0) && !(RANK[delivery.status] >= 9 && map.rank < 9)
    await c.env.DB.prepare(
      `UPDATE notification_deliveries SET ${advance ? 'status = ?,' : ''} ${stampCol ? `${stampCol} = COALESCE(${stampCol}, ?),` : ''}
         last_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END, updated_at = ? WHERE id = ?`,
    )
      .bind(...(advance ? [map.status] : []), ...(stampCol ? [occurredAt ?? now] : []), map.rank >= 9 ? (e.reason ?? name) : null, map.rank >= 9 ? `${name}: ${e.reason ?? ''}`.slice(0, 500) : null, now, delivery.id)
      .run()
    if (map.suppress) {
      // Stop emailing an address the provider says is undeliverable or that opted out. An admin can clear it.
      await c.env.DB.prepare(
        `INSERT INTO notification_user_settings (user_id, email_suppressed_at, email_suppressed_reason, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET email_suppressed_at = COALESCE(email_suppressed_at, excluded.email_suppressed_at), email_suppressed_reason = COALESCE(email_suppressed_reason, excluded.email_suppressed_reason), updated_at = excluded.updated_at`,
      )
        .bind(delivery.user_id, now, `${map.suppress}${e.reason ? `: ${e.reason}` : ''}`.slice(0, 300), now)
        .run()
    }
  }
  return c.json({ ok: true, processed, duplicates, unmatched })
})

export default webhooks
