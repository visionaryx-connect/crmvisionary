// Delivery worker for the durable outbox (notification_deliveries).
//
// Rows are claimed atomically (queued|retry → sending) so the immediate waitUntil dispatch and the 5-minute cron can
// never send the same delivery twice. Each channel is processed independently: an email failure never blocks push or
// the in-app notification, which was already written. Temporary failures back off exponentially; permanent ones and
// rows that exhaust their attempts end in "failed" (the dead-letter state shown under Failed notifications, where an
// administrator can retry them).

import type { Env } from '../env'
import { many, nowIso, one } from '../lib/db'
import { isValidEmail, sendBrevoEmail } from './brevo'
import { emailConfigured, notify, pushConfigured } from './notify'
import { sendWebPush } from './push'
import type { Waiter } from './realtime'
import { superAdmins } from './notificationRouting'
import { renderEmail, renderPush, templateOverrides, type DeliveryPayload } from './notificationTemplates'

export const MAX_ATTEMPTS = 5
/** Seconds to wait after attempt n (1-based) fails temporarily. */
export const BACKOFF_SECONDS = [60, 300, 900, 3600, 3 * 3600]
const STALE_LOCK_MS = 10 * 60_000

interface DeliveryRow {
  id: string
  event_key: string
  user_id: string
  channel: 'email' | 'push'
  priority: string
  payload: string
  attempts: number
  recipient: string | null
}

export interface ProcessOptions {
  ids?: string[]
  limit?: number
  now?: Date
  fetcher?: typeof fetch
}

export async function processDeliveries(env: Env, waiter: Waiter, opts: ProcessOptions = {}) {
  const now = opts.now ?? new Date()
  const nowS = now.toISOString()
  await env.DB.prepare(`UPDATE notification_deliveries SET status = 'retry', locked_at = NULL, updated_at = ? WHERE status = 'sending' AND locked_at < ?`)
    .bind(nowS, new Date(now.getTime() - STALE_LOCK_MS).toISOString())
    .run()
  const limit = Math.min(opts.limit ?? 40, 100)
  // (explicit ids are capped at 90 per call by D1's bound-parameter limit)
  const rows = opts.ids?.length
    ? await many<DeliveryRow>(
        env.DB,
        `SELECT id, event_key, user_id, channel, priority, payload, attempts, recipient FROM notification_deliveries
          WHERE id IN (${opts.ids.slice(0, 90).map(() => '?').join(', ')}) AND status IN ('queued','retry') AND next_attempt_at <= ?`,
        ...opts.ids.slice(0, 90),
        nowS,
      )
    : await many<DeliveryRow>(
        env.DB,
        `SELECT id, event_key, user_id, channel, priority, payload, attempts, recipient FROM notification_deliveries
          WHERE status IN ('queued','retry') AND next_attempt_at <= ?
          ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, next_attempt_at LIMIT ?`,
        nowS,
        limit,
      )
  const stats = { processed: 0, accepted: 0, sent: 0, retry: 0, failed: 0, skipped: 0 }
  const alerts = new Set<'email' | 'push'>()
  for (const row of rows) {
    const claimed = await one<{ id: string }>(env.DB, `UPDATE notification_deliveries SET status = 'sending', locked_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retry') RETURNING id`, nowS, nowS, row.id)
    if (!claimed) continue
    stats.processed++
    try {
      const r = row.channel === 'email' ? await deliverEmail(env, row, now, opts.fetcher) : await deliverPush(env, row, now, opts.fetcher)
      stats[r.state]++
      if (r.alert) alerts.add(row.channel)
    } catch (err) {
      // Unexpected bug: never leave the row locked; treat as a temporary failure.
      await finish(env, row, now, { kind: 'retry', error: `Internal error: ${err instanceof Error ? err.message : String(err)}` })
      stats.retry++
    }
  }
  for (const channel of alerts) await providerAlert(env, waiter, channel, now)
  return stats
}

type Finish =
  | { kind: 'accepted' | 'sent'; messageId?: string | null; response?: string; recipient?: string | null; subject?: string }
  | { kind: 'retry' | 'failed' | 'skipped'; error: string; response?: string; recipient?: string | null; subject?: string }

async function finish(env: Env, row: DeliveryRow, now: Date, f: Finish): Promise<'accepted' | 'sent' | 'retry' | 'failed' | 'skipped'> {
  const attempts = row.attempts + (f.kind === 'skipped' ? 0 : 1)
  const nowS = now.toISOString()
  let status: string = f.kind
  let next = nowS
  if (f.kind === 'retry') {
    if (attempts >= MAX_ATTEMPTS) status = 'failed'
    else next = new Date(now.getTime() + (BACKOFF_SECONDS[attempts - 1] ?? 3600) * 1000).toISOString()
  }
  await env.DB.prepare(
    `UPDATE notification_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, locked_at = NULL, updated_at = ?,
       provider = ?, provider_message_id = COALESCE(?, provider_message_id), provider_response = COALESCE(?, provider_response),
       last_error = ?, recipient = COALESCE(?, recipient), subject = COALESCE(?, subject),
       sent_at = CASE WHEN ? IN ('accepted','sent') THEN ? ELSE sent_at END
     WHERE id = ?`,
  )
    .bind(
      status, attempts, next, nowS,
      row.channel === 'email' ? 'brevo' : 'webpush',
      'messageId' in f ? (f.messageId ?? null) : null,
      f.response ? f.response.slice(0, 2000) : null,
      'error' in f ? f.error.slice(0, 500) : null,
      f.recipient ?? null,
      f.subject ?? null,
      status, nowS,
      row.id,
    )
    .run()
  return status as 'accepted' | 'sent' | 'retry' | 'failed' | 'skipped'
}

async function deliverEmail(env: Env, row: DeliveryRow, now: Date, fetcher?: typeof fetch): Promise<{ state: 'accepted' | 'sent' | 'retry' | 'failed' | 'skipped'; alert?: boolean }> {
  if (!emailConfigured(env)) return { state: await finish(env, row, now, { kind: 'skipped', error: 'Email is not configured' }) }
  const user = await one<{ name: string; email: string; status: string; suppressed: string | null }>(
    env.DB,
    `SELECT u.name, u.email, u.status, s.email_suppressed_at AS suppressed FROM users u LEFT JOIN notification_user_settings s ON s.user_id = u.id WHERE u.id = ?`,
    row.user_id,
  )
  if (!user || user.status !== 'active') return { state: await finish(env, row, now, { kind: 'skipped', error: 'Recipient account is not active' }) }
  if (user.suppressed) return { state: await finish(env, row, now, { kind: 'skipped', error: 'Address suppressed after a bounce, block or unsubscribe' }) }
  if (!isValidEmail(user.email)) return { state: await finish(env, row, now, { kind: 'failed', error: 'Invalid recipient address', recipient: user.email }) }
  const payload = JSON.parse(row.payload) as DeliveryPayload
  payload.recipientName = user.name
  const overrides = await templateOverrides(env.DB, row.event_key)
  const { subject, html, text } = await renderEmail(env, row.event_key, payload, overrides.email)
  const r = await sendBrevoEmail(env, { to: [{ email: user.email, name: user.name }], subject, htmlContent: html, textContent: text, tags: ['crm', row.event_key.toLowerCase()], custom: row.id, headers: { 'X-VX-Delivery': row.id } }, fetcher)
  if (r.outcome === 'accepted') return { state: await finish(env, row, now, { kind: 'accepted', messageId: r.messageId, response: r.response, recipient: user.email, subject }) }
  const state = await finish(env, row, now, { kind: r.outcome === 'retryable' ? 'retry' : 'failed', error: r.error, response: r.response, recipient: user.email, subject })
  return { state, alert: r.outcome === 'permanent' && r.credentialProblem }
}

async function deliverPush(env: Env, row: DeliveryRow, now: Date, fetcher?: typeof fetch): Promise<{ state: 'accepted' | 'sent' | 'retry' | 'failed' | 'skipped'; alert?: boolean }> {
  if (!pushConfigured(env)) return { state: await finish(env, row, now, { kind: 'skipped', error: 'Push is not configured' }) }
  const subs = await many<{ id: string; endpoint: string; p256dh: string; auth: string; failure_count: number }>(
    env.DB,
    `SELECT id, endpoint, p256dh, auth, failure_count FROM push_subscriptions WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 10`,
    row.user_id,
  )
  if (subs.length === 0) return { state: await finish(env, row, now, { kind: 'skipped', error: 'No active devices' }) }
  const payload = JSON.parse(row.payload) as DeliveryPayload
  const overrides = await templateOverrides(env.DB, row.event_key)
  const msg = renderPush(env, row.event_key, payload, overrides.push)
  const urgency = row.priority === 'critical' || row.priority === 'high' ? 'high' : row.priority === 'low' ? 'low' : 'normal'
  const nowS = now.toISOString()
  const results: { sub: string; outcome: string; status: number; error?: string }[] = []
  let alert = false
  for (const s of subs) {
    const r = await sendWebPush(env, { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, msg, { urgency, topic: payload.notificationId ?? undefined }, fetcher)
    results.push({ sub: s.id, outcome: r.outcome, status: r.status, ...('error' in r ? { error: r.error } : {}) })
    if (r.outcome === 'sent') {
      await env.DB.prepare('UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0, last_error = NULL, updated_at = ? WHERE id = ?').bind(nowS, nowS, s.id).run()
    } else if (r.outcome === 'expired') {
      await env.DB.prepare(`UPDATE push_subscriptions SET status = 'expired', last_failure_at = ?, last_error = ?, updated_at = ? WHERE id = ?`).bind(nowS, r.error, nowS, s.id).run()
    } else {
      const failures = s.failure_count + 1
      await env.DB.prepare(`UPDATE push_subscriptions SET failure_count = ?, last_failure_at = ?, last_error = ?, status = CASE WHEN ? >= 10 THEN 'expired' ELSE status END, updated_at = ? WHERE id = ?`)
        .bind(failures, nowS, r.error, failures, nowS, s.id)
        .run()
      if (r.outcome === 'permanent' && (r.status === 401 || r.status === 403)) alert = true
    }
  }
  const response = JSON.stringify(results)
  const sent = results.filter((r) => r.outcome === 'sent').length
  const recipient = `${sent}/${subs.length} device(s)`
  if (sent > 0) return { state: await finish(env, row, now, { kind: 'sent', response, recipient, subject: msg.title }), alert }
  if (results.every((r) => r.outcome === 'expired')) return { state: await finish(env, row, now, { kind: 'skipped', error: 'All devices have expired subscriptions', response, recipient, subject: msg.title }) }
  const retryable = results.some((r) => r.outcome === 'retryable')
  return { state: await finish(env, row, now, { kind: retryable ? 'retry' : 'failed', error: results.find((r) => r.error)?.error ?? 'Push failed', response, recipient, subject: msg.title }), alert }
}

async function providerAlert(env: Env, waiter: Waiter, channel: 'email' | 'push', now: Date) {
  const admins = await superAdmins(env.DB)
  const day = now.toISOString().slice(0, 10)
  await notify(
    env,
    waiter,
    admins.map((u) => ({
      userId: u,
      event: channel === 'email' ? ('SYSTEM_EMAIL_PROVIDER_ERROR' as const) : ('SYSTEM_PUSH_ERROR' as const),
      title: channel === 'email' ? 'Brevo rejected an email: check the API key, sender and account credits' : 'Push service rejected deliveries: check the VAPID keys',
      body: 'See Notification center → Delivery logs for the provider response.',
      link: '/admin/notifications?tab=failed',
      channels: ['in_app' as const],
      dedupeKey: `provider-alert:${channel}:${day}`,
    })),
  )
}

/** Manually re-queue failed / skipped deliveries (one more attempt each). */
export async function requeueDeliveries(env: Env, ids: string[]) {
  const nowS = nowIso()
  let n = 0
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90)
    const r = await env.DB.prepare(
      `UPDATE notification_deliveries SET status = 'retry', next_attempt_at = ?, locked_at = NULL, updated_at = ?
        WHERE id IN (${part.map(() => '?').join(', ')}) AND status IN ('failed','skipped','retry','deferred')`,
    )
      .bind(nowS, nowS, ...part)
      .run()
    n += r.meta.changes ?? 0
  }
  return n
}
