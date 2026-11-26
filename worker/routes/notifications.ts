// The signed-in person's own notification centre: inbox, read/ack/archive/snooze, preferences, push devices and the
// communication timeline of records they can see. Every query is scoped to the caller's user id.

import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { CHANNELS, LOCKED_GROUPS, NOTIFICATION_CATEGORIES, NOTIFICATION_EVENTS, PREFERENCE_GROUPS, type PreferenceGroup } from '@shared/notificationEvents'
import { projectAccess, taskAccess } from '../lib/authz'
import { newId } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { badRequest, body, forbidden, notFound, query } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'
import { requireStaff } from '../lib/session'
import { emailConfigured, notify, pushConfigured } from '../services/notify'
import { isAllowedEndpoint, vapidConfig, vapidProblem } from '../services/push'
import { processDeliveries } from '../services/notificationQueue'

const notifications = new Hono<AppBindings>()
notifications.use('*', requireStaff())

/** Visible = not archived (unless asked), not expired, not snoozed into the future. */
const VISIBLE = `n.archived_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?) AND (n.snoozed_until IS NULL OR n.snoozed_until <= ?)`

notifications.get('/', async (c) => {
  const a = c.get('auth')
  const now = nowIso()
  const view = query(c, 'view') ?? (query(c, 'unread') === '1' ? 'unread' : 'all') // all | unread | action | archived | snoozed
  const where: string[] = ['n.user_id = ?']
  const params: unknown[] = [a.userId]
  if (view === 'snoozed') where.push(`n.snoozed_until > ? AND n.archived_at IS NULL`), params.push(now)
  else if (view === 'archived') where.push('n.archived_at IS NOT NULL')
  else where.push(VISIBLE), params.push(now, now)
  if (view === 'unread') where.push('n.read_at IS NULL')
  if (view === 'action') where.push('n.requires_ack = 1 AND n.acknowledged_at IS NULL')
  const category = query(c, 'category')
  if (category && category in NOTIFICATION_CATEGORIES) where.push('n.category = ?'), params.push(category)
  const priority = query(c, 'priority')
  if (priority && ['critical', 'high', 'normal', 'low'].includes(priority)) where.push('n.priority = ?'), params.push(priority)
  const q = query(c, 'q')?.slice(0, 100)
  if (q) where.push(`(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')`), params.push(...Array(2).fill(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`))
  const broadcast = query(c, 'broadcast')
  if (broadcast) where.push('n.broadcast_id = ?'), params.push(broadcast)
  const before = query(c, 'before')
  if (before) where.push('n.created_at < ?'), params.push(before)
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT n.id, n.kind, n.event_key, n.category, n.priority, n.title, n.body, n.link, n.entity_type, n.entity_id, n.read_at, n.created_at,
            n.requires_ack, n.acknowledged_at, n.archived_at, n.snoozed_until, n.broadcast_id, act.name AS actor_name
       FROM notifications n LEFT JOIN users act ON act.id = n.actor_id
      WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT 50`,
    ...params,
  )
  const counts = await one<{ unread: number; action: number }>(
    c.env.DB,
    `SELECT SUM(CASE WHEN n.read_at IS NULL THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN n.requires_ack = 1 AND n.acknowledged_at IS NULL THEN 1 ELSE 0 END) AS action
       FROM notifications n WHERE n.user_id = ? AND ${VISIBLE}`,
    a.userId,
    now,
    now,
  )
  return c.json({
    notifications: rows.map((r) => ({ ...r, requires_ack: Boolean(r.requires_ack) })),
    unread: counts?.unread ?? 0,
    actionRequired: counts?.action ?? 0,
    nextBefore: rows.length === 50 ? rows[rows.length - 1].created_at : null,
  })
})

notifications.get('/count', async (c) => {
  const a = c.get('auth')
  const now = nowIso()
  const r = await one<{ unread: number; action: number; urgent: number }>(
    c.env.DB,
    `SELECT SUM(CASE WHEN n.read_at IS NULL THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN n.requires_ack = 1 AND n.acknowledged_at IS NULL THEN 1 ELSE 0 END) AS action,
            SUM(CASE WHEN n.read_at IS NULL AND n.priority IN ('critical','high') THEN 1 ELSE 0 END) AS urgent
       FROM notifications n WHERE n.user_id = ? AND ${VISIBLE}`,
    a.userId,
    now,
    now,
  )
  return c.json({ unread: r?.unread ?? 0, actionRequired: r?.action ?? 0, urgent: r?.urgent ?? 0 })
})

const idsSchema = z.object({ ids: z.array(z.string().max(40)).max(200).optional(), all: z.boolean().optional() })

notifications.post('/read', async (c) => {
  const a = c.get('auth')
  const input = await body(c, idsSchema)
  const now = nowIso()
  if (input.all) {
    await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(now, a.userId).run()
  } else if (input.ids?.length) {
    await c.env.DB.batch(input.ids.map((id) => c.env.DB.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').bind(now, id, a.userId)))
  }
  return c.json({ ok: true })
})

notifications.post('/unread', async (c) => {
  const a = c.get('auth')
  const { ids } = await body(c, z.object({ ids: z.array(z.string().max(40)).min(1).max(200) }))
  await c.env.DB.batch(ids.map((id) => c.env.DB.prepare('UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?').bind(id, a.userId)))
  return c.json({ ok: true })
})

notifications.post('/archive', async (c) => {
  const a = c.get('auth')
  const input = await body(c, z.object({ ids: z.array(z.string().max(40)).min(1).max(200), restore: z.boolean().optional() }))
  const now = nowIso()
  // Unacknowledged required notices cannot be archived away.
  await c.env.DB.batch(
    input.ids.map((id) =>
      input.restore
        ? c.env.DB.prepare('UPDATE notifications SET archived_at = NULL WHERE id = ? AND user_id = ?').bind(id, a.userId)
        : c.env.DB.prepare('UPDATE notifications SET archived_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ? AND NOT (requires_ack = 1 AND acknowledged_at IS NULL)').bind(now, now, id, a.userId),
    ),
  )
  return c.json({ ok: true })
})

notifications.post('/:id/ack', async (c) => {
  const a = c.get('auth')
  const now = nowIso()
  const r = await c.env.DB.prepare('UPDATE notifications SET acknowledged_at = COALESCE(acknowledged_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').bind(now, now, c.req.param('id'), a.userId).run()
  if (!r.meta.changes) throw notFound('Notification')
  return c.json({ ok: true, acknowledgedAt: now })
})

notifications.post('/:id/snooze', async (c) => {
  const a = c.get('auth')
  const { until } = await body(c, z.object({ until: z.string().datetime().nullable() }))
  if (until) {
    const t = Date.parse(until)
    if (t <= Date.now() || t > Date.now() + 14 * 86400_000) throw badRequest('Snooze for up to 14 days')
  }
  const r = await c.env.DB.prepare('UPDATE notifications SET snoozed_until = ?, read_at = CASE WHEN ? IS NULL THEN read_at ELSE NULL END WHERE id = ? AND user_id = ?').bind(until, until, c.req.param('id'), a.userId).run()
  if (!r.meta.changes) throw notFound('Notification')
  return c.json({ ok: true })
})

// ───────── Preferences ─────────

notifications.get('/preferences', async (c) => {
  const a = c.get('auth')
  const [rows, settings, mandatory] = await Promise.all([
    many<{ kind: string; in_app: number; email: number; push: number }>(c.env.DB, 'SELECT kind, in_app, email, push FROM notification_preferences WHERE user_id = ?', a.userId),
    one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM notification_user_settings WHERE user_id = ?', a.userId),
    many<{ event_key: string; mandatory: number | null }>(c.env.DB, 'SELECT event_key, mandatory FROM notification_rules WHERE mandatory = 1'),
  ])
  const mandatoryEvents = new Set([
    ...Object.entries(NOTIFICATION_EVENTS).filter(([, d]) => (d as { mandatory?: boolean }).mandatory).map(([k]) => k),
    ...mandatory.map((m) => m.event_key),
  ])
  return c.json({
    channels: { email: emailConfigured(c.env), push: pushConfigured(c.env) },
    preferences: Object.entries(PREFERENCE_GROUPS).map(([kind, label]) => {
      const r = rows.find((x) => x.kind === kind)
      const locked = LOCKED_GROUPS.includes(kind as PreferenceGroup)
      const events = Object.entries(NOTIFICATION_EVENTS).filter(([, d]) => d.group === kind).map(([k, d]) => ({ key: k, label: d.label, mandatory: mandatoryEvents.has(k) }))
      return { kind, label, locked, events, inApp: locked || (r?.in_app ?? 1) === 1, email: locked || (r?.email ?? 1) === 1, push: locked || (r?.push ?? 1) === 1 }
    }),
    settings: {
      emailEnabled: (settings?.email_enabled ?? 1) === 1,
      pushEnabled: (settings?.push_enabled ?? 1) === 1,
      quietStart: (settings?.quiet_start as string | null) ?? null,
      quietEnd: (settings?.quiet_end as string | null) ?? null,
      dailyDigest: (settings?.daily_digest ?? 1) === 1,
      weeklyDigest: (settings?.weekly_digest ?? 1) === 1,
      emailSuppressed: settings?.email_suppressed_at ? { at: settings.email_suppressed_at, reason: settings.email_suppressed_reason } : null,
    },
  })
})

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable()
notifications.put('/preferences', async (c) => {
  const a = c.get('auth')
  const input = await body(
    c,
    z.object({
      preferences: z.array(z.object({ kind: z.string().max(40), inApp: z.boolean().optional(), email: z.boolean().optional(), push: z.boolean().optional() })).max(60).default([]),
      settings: z.object({ emailEnabled: z.boolean(), pushEnabled: z.boolean(), quietStart: hhmm, quietEnd: hhmm, dailyDigest: z.boolean(), weeklyDigest: z.boolean() }).partial().optional(),
    }),
  )
  const valid = input.preferences.filter((p) => p.kind in PREFERENCE_GROUPS && !LOCKED_GROUPS.includes(p.kind as PreferenceGroup))
  const existing = new Map((await many<{ kind: string; in_app: number; email: number; push: number }>(c.env.DB, 'SELECT kind, in_app, email, push FROM notification_preferences WHERE user_id = ?', a.userId)).map((r) => [r.kind, r]))
  const stmts = valid.map((p) => {
    const cur = existing.get(p.kind)
    const v = (x: boolean | undefined, d: number | undefined) => (x === undefined ? (d ?? 1) : x ? 1 : 0)
    return c.env.DB.prepare(
      `INSERT INTO notification_preferences (user_id, kind, in_app, email, push) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET in_app = excluded.in_app, email = excluded.email, push = excluded.push`,
    ).bind(a.userId, p.kind, v(p.inApp, cur?.in_app), v(p.email, cur?.email), v(p.push, cur?.push))
  })
  if (input.settings) {
    const s = input.settings
    if ((s.quietStart && !s.quietEnd) || (!s.quietStart && s.quietEnd)) throw badRequest('Set both quiet-hours start and end, or neither')
    const cur = await one<Record<string, unknown>>(c.env.DB, 'SELECT * FROM notification_user_settings WHERE user_id = ?', a.userId)
    const b = (x: boolean | undefined, d: unknown) => (x === undefined ? ((d as number | undefined) ?? 1) : x ? 1 : 0)
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO notification_user_settings (user_id, email_enabled, push_enabled, quiet_start, quiet_end, daily_digest, weekly_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET email_enabled = excluded.email_enabled, push_enabled = excluded.push_enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
           daily_digest = excluded.daily_digest, weekly_digest = excluded.weekly_digest, updated_at = excluded.updated_at`,
      ).bind(
        a.userId, b(s.emailEnabled, cur?.email_enabled), b(s.pushEnabled, cur?.push_enabled),
        s.quietStart !== undefined ? s.quietStart : ((cur?.quiet_start as string | null) ?? null),
        s.quietEnd !== undefined ? s.quietEnd : ((cur?.quiet_end as string | null) ?? null),
        b(s.dailyDigest, cur?.daily_digest), b(s.weeklyDigest, cur?.weekly_digest), nowIso(),
      ),
    )
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({ ok: true })
})

// ───────── Push devices ─────────

notifications.get('/push/config', async (c) => {
  const anySet = Boolean(c.env.VAPID_PUBLIC_KEY || c.env.VAPID_PRIVATE_KEY || c.env.VAPID_SUBJECT)
  const problem = anySet ? await vapidProblem(c.env) : null
  const enabled = anySet && !problem
  return c.json({ enabled, publicKey: enabled ? vapidConfig(c.env).publicKey : null, problem: problem ? 'Push is set up incorrectly on the server. An administrator can see the details in Notification center → Overview.' : null })
})

notifications.get('/push/subscriptions', async (c) => {
  const a = c.get('auth')
  const rows = await many(c.env.DB, `SELECT id, device_label, user_agent, status, created_at, last_success_at, last_failure_at, failure_count, substr(endpoint, 1, 60) AS endpoint_hint FROM push_subscriptions WHERE user_id = ? ORDER BY status = 'active' DESC, created_at DESC`, a.userId)
  return c.json({ subscriptions: rows })
})

notifications.post('/push/subscriptions', async (c) => {
  const a = c.get('auth')
  if (!pushConfigured(c.env)) throw badRequest('Push notifications are not configured on this server yet')
  await rateLimit(c.env.DB, `push-sub:${a.userId}`, 20, 3600)
  const input = await body(
    c,
    z.object({
      endpoint: z.string().url().max(1000),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: z.string().min(80).max(120).regex(/^[A-Za-z0-9_-]+=*$/), auth: z.string().min(16).max(40).regex(/^[A-Za-z0-9_-]+=*$/) }),
      deviceLabel: z.string().trim().max(80).default(''),
    }),
  )
  if (!isAllowedEndpoint(input.endpoint)) throw badRequest('That is not a supported push service')
  const count = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ? AND status = 'active'`, a.userId)
  const existing = await one<{ id: string; user_id: string }>(c.env.DB, 'SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?', input.endpoint)
  if (!existing && (count?.n ?? 0) >= 10) throw badRequest('You can register up to 10 devices. Remove one first.')
  const now = nowIso()
  const ua = (c.req.header('user-agent') ?? '').slice(0, 300)
  const expires = input.expirationTime ? new Date(input.expirationTime).toISOString() : null
  if (existing) {
    // The same browser re-subscribing (or a shared device changing hands): bind it to whoever is signed in now.
    await c.env.DB.prepare(`UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, device_label = ?, user_agent = ?, status = 'active', failure_count = 0, last_error = NULL, expires_at = ?, updated_at = ? WHERE id = ?`)
      .bind(a.userId, input.keys.p256dh, input.keys.auth, input.deviceLabel, ua, expires, now, existing.id)
      .run()
    return c.json({ id: existing.id })
  }
  const id = newId('psb')
  await c.env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label, user_agent, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
    .bind(id, a.userId, input.endpoint, input.keys.p256dh, input.keys.auth, input.deviceLabel, ua, expires, now, now)
    .run()
  return c.json({ id }, 201)
})

notifications.delete('/push/subscriptions/:id', async (c) => {
  const a = c.get('auth')
  const r = await c.env.DB.prepare(`UPDATE push_subscriptions SET status = 'revoked', updated_at = ? WHERE id = ? AND user_id = ?`).bind(nowIso(), c.req.param('id'), a.userId).run()
  if (!r.meta.changes) throw notFound('Device')
  return c.json({ ok: true })
})

/** Unsubscribe by endpoint (the browser knows its endpoint, not our id). */
notifications.post('/push/unsubscribe', async (c) => {
  const a = c.get('auth')
  const { endpoint } = await body(c, z.object({ endpoint: z.string().url().max(1000) }))
  await c.env.DB.prepare(`UPDATE push_subscriptions SET status = 'revoked', updated_at = ? WHERE endpoint = ? AND user_id = ?`).bind(nowIso(), endpoint, a.userId).run()
  return c.json({ ok: true })
})

/** Send a test push to the caller's own devices, synchronously, and report the real outcome. */
notifications.post('/push/test', async (c) => {
  const a = c.get('auth')
  if (!pushConfigured(c.env)) throw badRequest('Push notifications are not configured on this server yet')
  await rateLimit(c.env.DB, `push-test:${a.userId}`, 5, 600)
  const r = await notify(c.env, c.executionCtx, [{ userId: a.userId, event: 'SYSTEM_TEST', title: 'Test notification', body: 'Push notifications are working on this device.', link: '/notifications', channels: ['push'], mandatory: true, dedupeKey: `push-test:${newId('t')}` }], undefined, { deferDispatch: true })
  const rows = await many<{ id: string }>(c.env.DB, `SELECT id FROM notification_deliveries WHERE user_id = ? AND channel = 'push' AND status = 'queued' AND event_key = 'SYSTEM_TEST' ORDER BY created_at DESC LIMIT 1`, a.userId)
  const stats = rows.length ? await processDeliveries(c.env, c.executionCtx, { ids: rows.map((x) => x.id) }) : null
  const d = rows.length ? await one<{ status: string; last_error: string | null; recipient: string | null }>(c.env.DB, 'SELECT status, last_error, recipient FROM notification_deliveries WHERE id = ?', rows[0].id) : null
  return c.json({ queued: r.deliveries, stats, delivery: d })
})

// ───────── Communication timeline ─────────

/**
 * Notification history for a record the caller can read: one line per event (what happened, when, how many people
 * were told, by which channels). Individual recipients are not listed — that stays in each person's own inbox.
 */
notifications.get('/timeline', async (c) => {
  const a = c.get('auth')
  const entityType = query(c, 'entityType')
  const entityId = query(c, 'entityId')
  if (!entityType || !entityId) throw badRequest('entityType and entityId are required')
  let projectFilter: string | null = null
  if (entityType === 'task') {
    await taskAccess(c.env.DB, a, entityId)
  } else if (entityType === 'project') {
    const acc = await projectAccess(c.env.DB, a, entityId)
    if (!acc?.canRead) throw notFound('Project')
    projectFilter = entityId
  } else if (entityType === 'user') {
    if (entityId !== a.userId && !a.permissions.has('notifications.read_all')) throw forbidden()
  } else throw badRequest('Unsupported entity type')
  const rows =
    entityType === 'user'
      ? await many(c.env.DB, `SELECT n.id, n.event_key, n.category, n.priority, n.title, n.created_at, n.read_at, n.acknowledged_at FROM notifications n WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`, entityId)
      : await many(
          c.env.DB,
          `SELECT e.id, e.event_key, e.category, e.priority, e.title, e.recipient_count, e.channels, e.created_at, u.name AS actor_name
             FROM notification_events e LEFT JOIN users u ON u.id = e.actor_id
            WHERE ${projectFilter ? '(e.project_id = ? OR (e.entity_type = ? AND e.entity_id = ?))' : 'e.entity_type = ? AND e.entity_id = ?'}
            ORDER BY e.created_at DESC LIMIT 100`,
          ...(projectFilter ? [projectFilter, 'project', projectFilter] : [entityType, entityId]),
        )
  return c.json({ events: (rows as Record<string, unknown>[]).map((r) => ({ ...r, channels: typeof r.channels === 'string' ? JSON.parse(r.channels) : undefined })) })
})

/** Registry for the UI (labels, categories, channels). */
notifications.get('/registry', (c) =>
  c.json({
    categories: NOTIFICATION_CATEGORIES,
    groups: PREFERENCE_GROUPS,
    channels: CHANNELS,
    events: Object.fromEntries(Object.entries(NOTIFICATION_EVENTS).map(([k, d]) => [k, { label: d.label, category: d.category, group: d.group }])),
  }),
)

export default notifications
