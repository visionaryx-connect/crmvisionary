// Notification center administration (Super Admin by default; permissions are configurable per role).
//   notifications.read_all  — company-wide notifications, events, delivery logs, analytics
//   notifications.manage    — rules, templates, schedules, escalation, retries, devices, test sends, manual job runs
//   notifications.broadcast — announcements and messages (own history unless read_all)
// Every configuration change and broadcast is written to the admin audit log.

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { CHANNELS, EVENT_KEYS, NOTIFICATION_CATEGORIES, NOTIFICATION_EVENTS, NOTIFICATION_PRIORITIES, isEventKey } from '@shared/notificationEvents'
import { activity } from '../lib/audit'
import { newId } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import { ApiError, badRequest, body, clientIp, conflict, forbidden, notFound, query } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'
import { assertCan, requirePermission, requireStaff } from '../lib/session'
import { brevoSender, senderProblem } from '../services/brevo'
import { vapidConfig, vapidProblem } from '../services/push'
import { audienceLabel, audienceSchema, broadcastSchema, resolveAudience, sendBroadcast } from '../services/notificationBroadcast'
import { processDeliveries, requeueDeliveries } from '../services/notificationQueue'
import {
  ackEscalations, attendanceExceptions, attendanceLate, attendanceMissing, attendanceReminder, checkoutReminder, dailyDigest, dailyReports,
  deadlineHours, deadlineToday, escalateOverdueTasks, leaveReminders, celebrations, meetingReminders, missingCheckout, monthlyReports, once, weeklyReports,
} from '../services/notificationSchedule'
import { renderEmail, renderPush, TEMPLATE_PLACEHOLDERS, type DeliveryPayload } from '../services/notificationTemplates'
import { emailConfigured, invalidateRuleCache, notify, pushConfigured, resolveRules } from '../services/notify'
import { getSetting, putSetting, SETTING_SCHEMAS } from '../services/settings'
import { localDate } from '@shared/dates'

const admin = new Hono<AppBindings>()
admin.use('*', requireStaff())

const READ = requirePermission('notifications.read_all', 'notifications.manage')
const MANAGE = requirePermission('notifications.manage')
const BROADCAST = requirePermission('notifications.broadcast')

const audit = (c: Context<AppBindings>, action: string, summary: string, entityId?: string, changes?: unknown) =>
  activity(c.env.DB, { category: 'admin', actorId: c.get('auth').userId, action: `notification.${action}`, entityType: 'notification_config', entityId: entityId ?? null, summary, changes, ip: clientIp(c) }).run()

const range = (c: Context<AppBindings>) => {
  const from = query(c, 'from')
  const to = query(c, 'to')
  return {
    from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? new Date(`${from}T00:00:00+05:30`).toISOString() : null,
    to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400_000).toISOString() : null,
  }
}

// ───────── Overview & analytics ─────────

admin.get('/overview', READ, async (c) => {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const since14 = new Date(Date.now() - 14 * 86400_000).toISOString()
  const [totals, deliveries, byCategory, byDept, trend, acks, devices, recentFailures, queue] = await Promise.all([
    one<{ total: number; unread: number; last24: number }>(c.env.DB, `SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24 FROM notifications WHERE created_at >= ?`, new Date(Date.now() - 86400_000).toISOString(), since),
    many<{ channel: string; status: string; n: number }>(c.env.DB, `SELECT channel, status, COUNT(*) AS n FROM notification_deliveries WHERE created_at >= ? GROUP BY channel, status`, since),
    many<{ category: string; n: number }>(c.env.DB, `SELECT COALESCE(category, 'system') AS category, COUNT(*) AS n FROM notifications WHERE created_at >= ? GROUP BY category ORDER BY n DESC`, since),
    many<{ department: string; n: number }>(
      c.env.DB,
      `SELECT COALESCE(d.name, 'No department') AS department, COUNT(*) AS n FROM notifications n LEFT JOIN employee_profiles ep ON ep.user_id = n.user_id LEFT JOIN departments d ON d.id = ep.department_id
        WHERE n.created_at >= ? GROUP BY d.id ORDER BY n DESC LIMIT 15`,
      since,
    ),
    many<{ day: string; in_app: number; email: number; push: number }>(
      c.env.DB,
      `SELECT day, SUM(in_app) AS in_app, SUM(email) AS email, SUM(push) AS push FROM (
          SELECT substr(datetime(created_at, '+330 minutes'), 1, 10) AS day, 1 AS in_app, 0 AS email, 0 AS push FROM notifications WHERE created_at >= ?
          UNION ALL SELECT substr(datetime(created_at, '+330 minutes'), 1, 10), 0, CASE WHEN channel = 'email' THEN 1 ELSE 0 END, CASE WHEN channel = 'push' THEN 1 ELSE 0 END FROM notification_deliveries WHERE created_at >= ?
        ) GROUP BY day ORDER BY day`,
      since14,
      since14,
    ),
    one<{ required: number; acknowledged: number }>(c.env.DB, `SELECT COUNT(*) AS required, SUM(CASE WHEN acknowledged_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged FROM notifications WHERE requires_ack = 1 AND created_at >= ?`, since),
    one<{ active: number; expired: number; users: number }>(c.env.DB, `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired, COUNT(DISTINCT CASE WHEN status = 'active' THEN user_id END) AS users FROM push_subscriptions`),
    many(c.env.DB, `SELECT d.id, d.channel, d.status, d.event_key, d.last_error, d.updated_at, u.name AS user_name FROM notification_deliveries d JOIN users u ON u.id = d.user_id WHERE d.status IN ('failed','bounced','blocked','spam') ORDER BY d.updated_at DESC LIMIT 8`),
    one<{ queued: number; retry: number; oldest: string | null }>(c.env.DB, `SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry, MIN(CASE WHEN status IN ('queued','retry') THEN next_attempt_at END) AS oldest FROM notification_deliveries`),
  ])
  const ch = (channel: string, ...statuses: string[]) => deliveries.filter((d) => d.channel === channel && (statuses.length === 0 || statuses.includes(d.status))).reduce((n, d) => n + d.n, 0)
  return c.json({
    periodDays: 30,
    providers: {
      email: { configured: emailConfigured(c.env), provider: 'Brevo', sender: emailConfigured(c.env) ? { email: brevoSender(c.env).email, name: brevoSender(c.env).name } : null, senderProblem: emailConfigured(c.env) ? senderProblem(c.env) : null, webhook: Boolean(c.env.BREVO_WEBHOOK_SECRET) },
      push: { configured: Boolean(c.env.VAPID_PUBLIC_KEY || c.env.VAPID_PRIVATE_KEY || c.env.VAPID_SUBJECT), subject: pushConfigured(c.env) ? vapidConfig(c.env).subject : null, problem: c.env.VAPID_PUBLIC_KEY || c.env.VAPID_PRIVATE_KEY || c.env.VAPID_SUBJECT ? await vapidProblem(c.env) : null },
    },
    metrics: {
      total: totals?.total ?? 0,
      inApp: totals?.total ?? 0,
      last24h: totals?.last24 ?? 0,
      unread: totals?.unread ?? 0,
      emailQueued: ch('email', 'queued', 'retry', 'sending'),
      emailAccepted: ch('email', 'accepted', 'sent', 'deferred', 'delivered', 'opened', 'clicked'),
      emailDelivered: ch('email', 'delivered', 'opened', 'clicked'),
      emailOpened: ch('email', 'opened', 'clicked'),
      emailFailed: ch('email', 'failed'),
      emailBounced: ch('email', 'bounced', 'blocked', 'spam'),
      pushSent: ch('push', 'sent'),
      pushFailed: ch('push', 'failed'),
      pushSkipped: ch('push', 'skipped'),
      ackRequired: acks?.required ?? 0,
      acknowledged: acks?.acknowledged ?? 0,
      activeDevices: devices?.active ?? 0,
      expiredDevices: devices?.expired ?? 0,
      usersWithPush: devices?.users ?? 0,
      queueQueued: queue?.queued ?? 0,
      queueRetry: queue?.retry ?? 0,
      queueOldest: queue?.oldest ?? null,
    },
    deliveriesByStatus: deliveries,
    byCategory: byCategory.map((x) => ({ ...x, label: NOTIFICATION_CATEGORIES[x.category as keyof typeof NOTIFICATION_CATEGORIES] ?? x.category })),
    byDepartment: byDept,
    trend,
    recentFailures,
  })
})

// ───────── All notifications / events (company-wide) ─────────

admin.get('/notifications', requirePermission('notifications.read_all'), async (c) => {
  const where: string[] = ['1 = 1']
  const params: unknown[] = []
  const category = query(c, 'category')
  if (category) where.push('n.category = ?'), params.push(category)
  const event = query(c, 'event')
  if (event) where.push('n.event_key = ?'), params.push(event)
  const userId = query(c, 'userId')
  if (userId) where.push('n.user_id = ?'), params.push(userId)
  const dept = query(c, 'departmentId')
  if (dept) where.push('ep.department_id = ?'), params.push(dept)
  const projectId = query(c, 'projectId')
  if (projectId) where.push('n.project_id = ?'), params.push(projectId)
  const status = query(c, 'status')
  if (status === 'unread') where.push('n.read_at IS NULL')
  if (status === 'read') where.push('n.read_at IS NOT NULL')
  if (status === 'unacknowledged') where.push('n.requires_ack = 1 AND n.acknowledged_at IS NULL')
  const priority = query(c, 'priority')
  if (priority) where.push('n.priority = ?'), params.push(priority)
  const q = query(c, 'q')?.slice(0, 100)
  if (q) where.push(`(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`), params.push(...Array(3).fill(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`))
  const { from, to } = range(c)
  if (from) where.push('n.created_at >= ?'), params.push(from)
  if (to) where.push('n.created_at < ?'), params.push(to)
  const before = query(c, 'before')
  if (before) where.push('n.created_at < ?'), params.push(before)
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT n.id, n.user_id, u.name AS user_name, d.name AS department_name, n.event_key, n.category, n.priority, n.title, n.body, n.link, n.read_at, n.requires_ack, n.acknowledged_at,
            n.created_at, n.broadcast_id, act.name AS actor_name,
            (SELECT GROUP_CONCAT(dl.channel || ':' || dl.status) FROM notification_deliveries dl WHERE dl.notification_id = n.id) AS deliveries
       FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN employee_profiles ep ON ep.user_id = n.user_id LEFT JOIN departments d ON d.id = ep.department_id LEFT JOIN users act ON act.id = n.actor_id
      WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT 100`,
    ...params,
  )
  return c.json({ notifications: rows, nextBefore: rows.length === 100 ? rows[99].created_at : null })
})

admin.get('/events', requirePermission('notifications.read_all'), async (c) => {
  const where: string[] = ['1 = 1']
  const params: unknown[] = []
  const category = query(c, 'category')
  if (category) where.push('e.category = ?'), params.push(category)
  const event = query(c, 'event')
  if (event) where.push('e.event_key = ?'), params.push(event)
  const { from, to } = range(c)
  if (from) where.push('e.created_at >= ?'), params.push(from)
  if (to) where.push('e.created_at < ?'), params.push(to)
  const rows = await many(c.env.DB, `SELECT e.*, u.name AS actor_name FROM notification_events e LEFT JOIN users u ON u.id = e.actor_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT 200`, ...params)
  return c.json({ events: rows })
})

// ───────── Delivery logs ─────────

admin.get('/deliveries', requirePermission('notifications.read_all'), async (c) => {
  const where: string[] = ['1 = 1']
  const params: unknown[] = []
  const channel = query(c, 'channel')
  if (channel === 'email' || channel === 'push') where.push('d.channel = ?'), params.push(channel)
  const status = query(c, 'status')
  if (status === 'failed_any') where.push(`d.status IN ('failed','bounced','blocked','spam')`)
  else if (status === 'pending') where.push(`d.status IN ('queued','retry','sending')`)
  else if (status) where.push('d.status = ?'), params.push(status)
  const userId = query(c, 'userId')
  if (userId) where.push('d.user_id = ?'), params.push(userId)
  const event = query(c, 'event')
  if (event) where.push('d.event_key = ?'), params.push(event)
  const q = query(c, 'q')?.slice(0, 100)
  if (q) where.push(`(d.subject LIKE ? ESCAPE '\\' OR d.recipient LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR d.provider_message_id = ?)`), params.push(...Array(3).fill(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`), q)
  const { from, to } = range(c)
  if (from) where.push('d.created_at >= ?'), params.push(from)
  if (to) where.push('d.created_at < ?'), params.push(to)
  const before = query(c, 'before')
  if (before) where.push('d.created_at < ?'), params.push(before)
  const rows = await many<Record<string, unknown>>(
    c.env.DB,
    `SELECT d.id, d.channel, d.status, d.event_key, d.priority, d.recipient, d.subject, d.attempts, d.next_attempt_at, d.provider_message_id, d.last_error,
            d.created_at, d.updated_at, d.sent_at, d.delivered_at, d.opened_at, d.clicked_at, u.name AS user_name, d.user_id
       FROM notification_deliveries d JOIN users u ON u.id = d.user_id WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 100`,
    ...params,
  )
  return c.json({ deliveries: rows, nextBefore: rows.length === 100 ? rows[99].created_at : null })
})

admin.get('/deliveries/:id', requirePermission('notifications.read_all'), async (c) => {
  const d = await one<Record<string, unknown>>(c.env.DB, `SELECT d.*, u.name AS user_name FROM notification_deliveries d JOIN users u ON u.id = d.user_id WHERE d.id = ?`, c.req.param('id'))
  if (!d) throw notFound('Delivery')
  const events = await many(c.env.DB, 'SELECT id, event, message_id, email, reason, occurred_at, received_at FROM notification_delivery_events WHERE delivery_id = ? ORDER BY received_at', d.id)
  const payload = JSON.parse(String(d.payload)) as Record<string, unknown>
  return c.json({ delivery: { ...d, payload: { title: payload.title, body: payload.body, link: payload.link } }, providerEvents: events })
})

admin.post('/deliveries/retry', MANAGE, async (c) => {
  const input = await body(c, z.object({ ids: z.array(z.string().max(40)).max(200).optional(), allFailed: z.boolean().optional(), channel: z.enum(['email', 'push']).optional() }))
  let ids = input.ids ?? []
  if (input.allFailed) {
    ids = (await many<{ id: string }>(c.env.DB, `SELECT id FROM notification_deliveries WHERE status = 'failed' ${input.channel ? 'AND channel = ?' : ''} AND created_at >= ? ORDER BY created_at DESC LIMIT 500`, ...(input.channel ? [input.channel] : []), new Date(Date.now() - 7 * 86400_000).toISOString())).map((r) => r.id)
  }
  if (ids.length === 0) return c.json({ requeued: 0 })
  const n = await requeueDeliveries(c.env, ids)
  await audit(c, 'deliveries_retried', `Re-queued ${n} failed delivery(ies)`, undefined, { ids: ids.slice(0, 50) })
  if (c.env.APP_ENV !== 'test') c.executionCtx.waitUntil(processDeliveries(c.env, c.executionCtx, { ids: ids.slice(0, 90) }).catch(() => undefined))
  return c.json({ requeued: n })
})

admin.post('/test-email', MANAGE, async (c) => {
  const a = c.get('auth')
  if (!emailConfigured(c.env)) throw badRequest('Set BREVO_API_KEY and BREVO_SENDER_EMAIL first (see docs/NOTIFICATIONS.md)')
  const problem = senderProblem(c.env)
  if (problem) throw badRequest(problem)
  await rateLimit(c.env.DB, `test-email:${a.userId}`, 5, 600)
  const key = `test-email:${newId('t')}`
  await notify(c.env, c.executionCtx, [{ userId: a.userId, event: 'SYSTEM_TEST', title: 'Test email from the Visionary X CRM', body: 'If you can read this, Brevo transactional email is working.', channels: ['email'], mandatory: true, dedupeKey: key, email: { details: [['Sent at', new Date().toISOString()], ['Sender', `${brevoSender(c.env).name} <${brevoSender(c.env).email}>`]] } }], undefined, { deferDispatch: true })
  const row = await one<{ id: string }>(c.env.DB, `SELECT id FROM notification_deliveries WHERE user_id = ? AND dedupe_key = ?`, a.userId, `${a.userId}|${key}|email`)
  if (!row) throw conflict('Your account has no deliverable email (suppressed or invalid address)')
  await processDeliveries(c.env, c.executionCtx, { ids: [row.id] })
  const d = await one(c.env.DB, 'SELECT id, status, recipient, provider_message_id, last_error, provider_response FROM notification_deliveries WHERE id = ?', row.id)
  await audit(c, 'test_email', 'Sent a test email to self', row.id)
  return c.json({ delivery: d })
})

admin.get('/suppressions', READ, async (c) =>
  c.json({ suppressions: await many(c.env.DB, `SELECT s.user_id, u.name, u.email, s.email_suppressed_at, s.email_suppressed_reason FROM notification_user_settings s JOIN users u ON u.id = s.user_id WHERE s.email_suppressed_at IS NOT NULL ORDER BY s.email_suppressed_at DESC`) }),
)
admin.delete('/suppressions/:userId', MANAGE, async (c) => {
  await c.env.DB.prepare('UPDATE notification_user_settings SET email_suppressed_at = NULL, email_suppressed_reason = NULL, updated_at = ? WHERE user_id = ?').bind(nowIso(), c.req.param('userId')).run()
  await audit(c, 'suppression_cleared', 'Cleared an email suppression', c.req.param('userId'))
  return c.json({ ok: true })
})

// ───────── Devices ─────────

admin.get('/devices', READ, async (c) => {
  const status = query(c, 'status')
  const rows = await many(
    c.env.DB,
    `SELECT s.id, s.user_id, u.name AS user_name, s.device_label, s.user_agent, s.status, s.created_at, s.last_success_at, s.last_failure_at, s.failure_count, s.last_error, substr(s.endpoint, 1, 48) AS endpoint_hint
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id ${status ? 'WHERE s.status = ?' : ''} ORDER BY s.updated_at DESC LIMIT 300`,
    ...(status ? [status] : []),
  )
  return c.json({ devices: rows })
})
admin.delete('/devices/:id', MANAGE, async (c) => {
  const r = await c.env.DB.prepare(`UPDATE push_subscriptions SET status = 'revoked', updated_at = ? WHERE id = ?`).bind(nowIso(), c.req.param('id')).run()
  if (!r.meta.changes) throw notFound('Device')
  await audit(c, 'device_revoked', 'Revoked a push device', c.req.param('id'))
  return c.json({ ok: true })
})

// ───────── Rules ─────────

admin.get('/rules', READ, async (c) => {
  const rules = await resolveRules(c.env.DB)
  const overrides = new Set((await many<{ event_key: string }>(c.env.DB, 'SELECT event_key FROM notification_rules')).map((r) => r.event_key))
  const counts = new Map((await many<{ event_key: string; n: number }>(c.env.DB, `SELECT event_key, COUNT(*) AS n FROM notification_events WHERE created_at >= ? GROUP BY event_key`, new Date(Date.now() - 30 * 86400_000).toISOString())).map((r) => [r.event_key, r.n]))
  return c.json({
    rules: [...rules.values()].map((r) => {
      const def = NOTIFICATION_EVENTS[r.key]
      return { key: r.key, label: r.label, description: r.description, category: r.category, group: r.group, enabled: r.enabled, channels: r.channels, priority: r.priority, mandatory: r.mandatory, sensitive: Boolean((def as { sensitive?: boolean }).sensitive), defaults: { channels: def.channels, priority: def.priority, mandatory: Boolean((def as { mandatory?: boolean }).mandatory) }, overridden: overrides.has(r.key), events30d: counts.get(r.key) ?? 0 }
    }),
  })
})

admin.put('/rules/:key', MANAGE, async (c) => {
  const key = c.req.param('key')
  if (!isEventKey(key)) throw notFound('Event')
  const input = await body(c, z.object({ enabled: z.boolean(), channels: z.array(z.enum(CHANNELS)).max(3), priority: z.enum(NOTIFICATION_PRIORITIES), mandatory: z.boolean() }))
  if (NOTIFICATION_EVENTS[key].category === 'security' && (!input.enabled || !input.mandatory)) throw badRequest('Security alerts are always on and mandatory')
  if (input.channels.length === 0 && input.enabled) throw badRequest('Choose at least one channel or disable the event')
  const a = c.get('auth')
  await c.env.DB.prepare(
    `INSERT INTO notification_rules (event_key, enabled, channels, priority, mandatory, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_key) DO UPDATE SET enabled = excluded.enabled, channels = excluded.channels, priority = excluded.priority, mandatory = excluded.mandatory, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(key, input.enabled ? 1 : 0, JSON.stringify(input.channels), input.priority, input.mandatory ? 1 : 0, a.userId, nowIso()).run()
  invalidateRuleCache()
  await audit(c, 'rule_updated', `Updated notification rule ${key}`, key, input)
  return c.json({ ok: true })
})

admin.delete('/rules/:key', MANAGE, async (c) => {
  await c.env.DB.prepare('DELETE FROM notification_rules WHERE event_key = ?').bind(c.req.param('key')).run()
  invalidateRuleCache()
  await audit(c, 'rule_reset', `Reset notification rule ${c.req.param('key')} to defaults`, c.req.param('key'))
  return c.json({ ok: true })
})

// ───────── Templates ─────────

admin.get('/templates', READ, async (c) => {
  const rows = await many<{ event_key: string; channel: string; subject: string; intro: string; outro: string; action_label: string; updated_at: string }>(c.env.DB, 'SELECT event_key, channel, subject, intro, outro, action_label, updated_at FROM notification_templates')
  return c.json({
    placeholders: TEMPLATE_PLACEHOLDERS,
    templates: EVENT_KEYS.map((k) => ({ key: k, label: NOTIFICATION_EVENTS[k].label, category: NOTIFICATION_EVENTS[k].category, email: rows.find((r) => r.event_key === k && r.channel === 'email') ?? null, push: rows.find((r) => r.event_key === k && r.channel === 'push') ?? null })),
  })
})

const templateSchema = z.object({ subject: z.string().trim().max(200), intro: z.string().trim().max(2000), outro: z.string().trim().max(500).default(''), actionLabel: z.string().trim().max(40).default('') })

admin.put('/templates/:key/:channel', MANAGE, async (c) => {
  const key = c.req.param('key')
  const channel = c.req.param('channel')
  if (!isEventKey(key) || (channel !== 'email' && channel !== 'push')) throw notFound('Template')
  const input = await body(c, templateSchema)
  await c.env.DB.prepare(
    `INSERT INTO notification_templates (event_key, channel, subject, intro, outro, action_label, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_key, channel) DO UPDATE SET subject = excluded.subject, intro = excluded.intro, outro = excluded.outro, action_label = excluded.action_label, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(key, channel, input.subject, input.intro, input.outro, input.actionLabel, c.get('auth').userId, nowIso()).run()
  await audit(c, 'template_updated', `Updated ${channel} template for ${key}`, key, input)
  return c.json({ ok: true })
})

admin.delete('/templates/:key/:channel', MANAGE, async (c) => {
  await c.env.DB.prepare('DELETE FROM notification_templates WHERE event_key = ? AND channel = ?').bind(c.req.param('key'), c.req.param('channel')).run()
  await audit(c, 'template_reset', `Reset ${c.req.param('channel')} template for ${c.req.param('key')}`, c.req.param('key'))
  return c.json({ ok: true })
})

/** Render a template with sample data so administrators see exactly what recipients get. */
admin.post('/templates/:key/preview', READ, async (c) => {
  const key = c.req.param('key')
  if (!isEventKey(key)) throw notFound('Template')
  const input = await body(c, z.object({ email: templateSchema.partial().optional(), push: templateSchema.partial().optional() }))
  const a = c.get('auth')
  const def = NOTIFICATION_EVENTS[key]
  const sample: DeliveryPayload = {
    title: `${def.label}: Website Development`,
    body: 'Please update the mobile responsive layout and complete the remaining sections before the deadline.',
    link: '/notifications',
    recipientName: a.name,
    actorName: 'Project Manager',
    sensitive: Boolean((def as { sensitive?: boolean }).sensitive),
    email: { details: [['Task', 'Website Development'], ['Project', 'Company Website'], ['Commented by', 'Project Manager'], ['Time', '3:30 PM']], message: 'Please update the mobile responsive layout and complete the remaining sections before the deadline.' },
    push: null,
    notificationId: null,
    requiresAck: false,
  }
  const ov = (t?: Partial<z.infer<typeof templateSchema>>) => (t && (t.subject || t.intro || t.outro || t.actionLabel) ? { subject: t.subject ?? '', intro: t.intro ?? '', outro: t.outro ?? '', action_label: t.actionLabel ?? '' } : undefined)
  const email = await renderEmail(c.env, key, sample, ov(input.email))
  const push = renderPush(c.env, key, sample, ov(input.push))
  return c.json({ email, push })
})

// ───────── Schedules & escalation ─────────

admin.get('/schedule', async (c) => {
  assertCan(c.get('auth'), 'notifications.manage', 'notifications.read_all', 'attendance.manage')
  return c.json({ schedule: await getSetting(c.env.DB, 'notifications.schedule'), escalation: await getSetting(c.env.DB, 'notifications.escalation'), hours: await getSetting(c.env.DB, 'workdays.hours') })
})

admin.put('/schedule', async (c) => {
  const a = c.get('auth')
  assertCan(a, 'notifications.manage', 'attendance.manage')
  const input = await body(c, SETTING_SCHEMAS['notifications.schedule'])
  let value = input
  if (!a.permissions.has('notifications.manage')) {
    // HR may change the attendance schedule only.
    const cur = await getSetting(c.env.DB, 'notifications.schedule')
    value = { ...cur, attendance: input.attendance }
  }
  await putSetting(c.env.DB, 'notifications.schedule', value, a.userId)
  await audit(c, 'schedule_updated', 'Updated notification schedules', 'notifications.schedule', value)
  return c.json({ ok: true })
})

admin.put('/escalation', MANAGE, async (c) => {
  const input = await body(c, SETTING_SCHEMAS['notifications.escalation'])
  await putSetting(c.env.DB, 'notifications.escalation', input, c.get('auth').userId)
  await audit(c, 'escalation_updated', 'Updated escalation rules', 'notifications.escalation', input)
  return c.json({ ok: true })
})

admin.get('/escalations', READ, async (c) => {
  const rows = await many(
    c.env.DB,
    `SELECT e.*, t.title AS task_title, t.number AS task_number, p.reference AS project_reference, t.status AS task_status FROM notification_escalations e
       LEFT JOIN tasks t ON e.entity_type = 'task' AND t.id = e.entity_id LEFT JOIN projects p ON p.id = t.project_id ORDER BY e.resolved_at IS NULL DESC, e.updated_at DESC LIMIT 200`,
  )
  return c.json({ escalations: rows })
})

// ───────── Scheduled jobs ─────────

admin.get('/jobs', READ, async (c) => c.json({ jobs: await many(c.env.DB, 'SELECT * FROM notification_jobs ORDER BY started_at DESC LIMIT 200') }))

const JOBS = [
  'attendance.reminder', 'attendance.late', 'attendance.missing', 'attendance.exceptions', 'attendance.checkout_reminder', 'attendance.missing_checkout',
  'reports.daily', 'tasks.daily_digest', 'tasks.deadline_today', 'tasks.deadline_2h', 'tasks.deadline_30m', 'escalation.tasks', 'hr.leave_reminders', 'hr.celebrations',
  'reports.weekly', 'reports.monthly', 'meetings.reminders', 'announcements.ack_escalation', 'queue.process',
] as const

/** Run a job now (outside its time slot). Dedupe keys inside each job still prevent duplicate notices for the day. */
admin.post('/jobs/run', MANAGE, async (c) => {
  const { job } = await body(c, z.object({ job: z.enum(JOBS) }))
  const env = c.env
  const w = c.executionCtx
  const today = localDate()
  const sched = await getSetting(env.DB, 'notifications.schedule')
  const esc = await getSetting(env.DB, 'notifications.escalation')
  const hours = await getSetting(env.DB, 'workdays.hours')
  const t = { lateAfter: sched.attendance.lateAfter, earlyBefore: sched.attendance.earlyBefore }
  const fns: Record<(typeof JOBS)[number], () => Promise<unknown>> = {
    'attendance.reminder': () => attendanceReminder(env, w, today, t),
    'attendance.late': () => attendanceLate(env, w, today, t),
    'attendance.missing': () => attendanceMissing(env, w, today, t),
    'attendance.exceptions': () => attendanceExceptions(env, w, today, t),
    'attendance.checkout_reminder': () => checkoutReminder(env, w, today, t),
    'attendance.missing_checkout': () => missingCheckout(env, w, today, t),
    'reports.daily': () => dailyReports(env, w, today, t, sched.reports.recipients),
    'tasks.daily_digest': () => dailyDigest(env, w, today),
    'tasks.deadline_today': () => deadlineToday(env, w, today),
    'tasks.deadline_2h': () => deadlineHours(env, w, today, '2h', hours.dayEnd),
    'tasks.deadline_30m': () => deadlineHours(env, w, today, '30m', hours.dayEnd),
    'escalation.tasks': () => escalateOverdueTasks(env, w, today, esc),
    'hr.leave_reminders': () => leaveReminders(env, w, today),
    'hr.celebrations': () => celebrations(env, w, today),
    'reports.weekly': () => weeklyReports(env, w, today, esc, sched.reports.recipients.weekly),
    'reports.monthly': () => monthlyReports(env, w, today, sched.reports.recipients.monthly),
    'meetings.reminders': () => meetingReminders(env, w, new Date(), sched.meetings.defaultReminderMinutes),
    'announcements.ack_escalation': () => ackEscalations(env, w, new Date(), esc),
    'queue.process': () => processDeliveries(env, w, { limit: 100 }),
  }
  const result = await once(env, w, job, `${job}:manual:${newId('r')}`, fns[job])
  await audit(c, 'job_run', `Ran ${job} manually`, job, result)
  if (result === null) throw new ApiError(500, 'JOB_FAILED', 'The job failed. See Scheduled jobs for the error.')
  return c.json({ ok: true, result })
})

// ───────── Broadcasts ─────────

admin.get('/audience-options', BROADCAST, async (c) => {
  const [departments, projects, roles, users] = await Promise.all([
    many(c.env.DB, `SELECT d.id, d.name, (SELECT COUNT(*) FROM employee_profiles ep JOIN users u ON u.id = ep.user_id WHERE ep.department_id = d.id AND u.status = 'active') AS members FROM departments d WHERE d.archived_at IS NULL ORDER BY d.name`),
    many(c.env.DB, `SELECT p.id, p.reference, p.name, (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS members FROM projects p WHERE p.archived_at IS NULL AND p.status NOT IN ('completed','archived') ORDER BY p.reference DESC LIMIT 200`),
    many(c.env.DB, `SELECT r.key, r.name, (SELECT COUNT(*) FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = r.id AND u.status = 'active') AS members FROM roles r ORDER BY r.rank`),
    many(c.env.DB, `SELECT u.id, u.name, d.name AS department FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id WHERE u.status = 'active' ORDER BY u.name`),
  ])
  return c.json({ departments, projects, roles, users, channels: { email: emailConfigured(c.env), push: pushConfigured(c.env) } })
})

admin.post('/broadcasts/preview', BROADCAST, async (c) => {
  const { audience } = await body(c, z.object({ audience: audienceSchema }))
  const ids = await resolveAudience(c.env.DB, audience)
  const sample = ids.length ? await many<{ name: string }>(c.env.DB, `SELECT name FROM users WHERE id IN (${ids.slice(0, 12).map(() => '?').join(', ')}) ORDER BY name`, ...ids.slice(0, 12)) : []
  const withEmail = ids.length && emailConfigured(c.env) ? ids.length : 0
  const pushUsers = pushConfigured(c.env) && ids.length ? (await many<{ user_id: string }>(c.env.DB, `SELECT DISTINCT user_id FROM push_subscriptions WHERE status = 'active'`)).filter((r) => ids.includes(r.user_id)).length : 0
  return c.json({ count: ids.length, sample: sample.map((s) => s.name), label: await audienceLabel(c.env.DB, audience), reach: { inApp: ids.length, email: withEmail, push: pushUsers } })
})

admin.post('/broadcasts', BROADCAST, async (c) => {
  const a = c.get('auth')
  await rateLimit(c.env.DB, `broadcast:${a.userId}`, 30, 3600)
  const input = await body(c, broadcastSchema)
  if (input.mandatory && !a.permissions.has('notifications.manage')) throw forbidden('Only notification administrators can send mandatory notices')
  const recipients = await resolveAudience(c.env.DB, input.audience)
  if (recipients.length === 0) throw badRequest('No active employees match that audience')
  if ((input.audience.all || recipients.length >= 25) && !input.confirm) throw new ApiError(409, 'CONFIRMATION_REQUIRED', `This will notify ${recipients.length} people. Confirm to send.`, { count: recipients.length })
  const now = new Date()
  const scheduledAt = input.scheduledAt && Date.parse(input.scheduledAt) > now.getTime() + 60_000 ? input.scheduledAt : now.toISOString()
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(scheduledAt)) throw badRequest('Expiry must be after the send time')
  const id = newId('bc')
  const label = await audienceLabel(c.env.DB, input.audience)
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO notification_broadcasts (id, kind, title, body, priority, audience, audience_label, channels, requires_ack, mandatory, link, status, scheduled_at, expires_at, recipient_count, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
    ).bind(id, input.kind, input.title, input.body, input.priority, JSON.stringify(input.audience), label, JSON.stringify(input.channels), input.requiresAck ? 1 : 0, input.mandatory ? 1 : 0, input.link ?? null, scheduledAt, input.expiresAt ?? null, recipients.length, a.userId, now.toISOString()),
    activity(c.env.DB, { category: 'admin', actorId: a.userId, action: 'notification.broadcast_created', entityType: 'broadcast', entityId: id, summary: `${scheduledAt > now.toISOString() ? 'Scheduled' : 'Sent'} ${input.kind} “${input.title}” to ${label} (${recipients.length})`, changes: { channels: input.channels, priority: input.priority, requiresAck: input.requiresAck, scheduledAt }, ip: clientIp(c) }),
  ])
  let result = null
  if (scheduledAt <= now.toISOString()) result = await sendBroadcast(c.env, c.executionCtx, id)
  return c.json({ id, status: result ? 'sent' : 'scheduled', recipients: recipients.length, scheduledAt }, 201)
})

admin.get('/broadcasts', BROADCAST, async (c) => {
  const a = c.get('auth')
  const all = a.permissions.has('notifications.read_all')
  const rows = await many(
    c.env.DB,
    `SELECT b.id, b.kind, b.title, b.priority, b.audience_label, b.channels, b.requires_ack, b.mandatory, b.status, b.scheduled_at, b.expires_at, b.recipient_count, b.created_at, b.sent_at, b.error, u.name AS sender_name,
            (SELECT COUNT(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.read_at IS NOT NULL) AS read_count,
            (SELECT COUNT(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.acknowledged_at IS NOT NULL) AS ack_count,
            (SELECT COUNT(*) FROM notification_deliveries d WHERE d.event_id IN (SELECT id FROM notification_events WHERE broadcast_id = b.id) AND d.channel = 'email' AND d.status IN ('accepted','sent','delivered','opened','clicked')) AS email_count,
            (SELECT COUNT(*) FROM notification_deliveries d WHERE d.event_id IN (SELECT id FROM notification_events WHERE broadcast_id = b.id) AND d.channel = 'push' AND d.status = 'sent') AS push_count
       FROM notification_broadcasts b JOIN users u ON u.id = b.created_by ${all ? '' : 'WHERE b.created_by = ?'} ORDER BY b.created_at DESC LIMIT 100`,
    ...(all ? [] : [a.userId]),
  )
  return c.json({ broadcasts: rows })
})

admin.get('/broadcasts/:id', BROADCAST, async (c) => {
  const a = c.get('auth')
  const b = await one<Record<string, unknown>>(c.env.DB, 'SELECT b.*, u.name AS sender_name FROM notification_broadcasts b JOIN users u ON u.id = b.created_by WHERE b.id = ?', c.req.param('id'))
  if (!b || (b.created_by !== a.userId && !a.permissions.has('notifications.read_all'))) throw notFound('Broadcast')
  const recipients = await many(
    c.env.DB,
    `SELECT n.user_id, u.name, d.name AS department, n.read_at, n.acknowledged_at, n.created_at,
            (SELECT GROUP_CONCAT(dl.channel || ':' || dl.status) FROM notification_deliveries dl WHERE dl.user_id = n.user_id AND dl.dedupe_key IN (n.user_id || '|' || n.dedupe_key || '|email', n.user_id || '|' || n.dedupe_key || '|push')) AS deliveries
       FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN employee_profiles ep ON ep.user_id = n.user_id LEFT JOIN departments d ON d.id = ep.department_id
      WHERE n.broadcast_id = ? AND n.dedupe_key = 'bc:' || n.broadcast_id ORDER BY u.name`,
    b.id,
  )
  return c.json({ broadcast: { ...b, audience: JSON.parse(String(b.audience)), channels: JSON.parse(String(b.channels)) }, recipients })
})

admin.post('/broadcasts/:id/cancel', BROADCAST, async (c) => {
  const a = c.get('auth')
  const b = await one<{ created_by: string }>(c.env.DB, 'SELECT created_by FROM notification_broadcasts WHERE id = ?', c.req.param('id'))
  if (!b || (b.created_by !== a.userId && !a.permissions.has('notifications.manage'))) throw notFound('Broadcast')
  const r = await c.env.DB.prepare(`UPDATE notification_broadcasts SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND status = 'scheduled'`).bind(nowIso(), a.userId, c.req.param('id')).run()
  if (!r.meta.changes) throw conflict('Only scheduled broadcasts can be cancelled')
  await audit(c, 'broadcast_cancelled', 'Cancelled a scheduled broadcast', c.req.param('id'))
  return c.json({ ok: true })
})

// ───────── Export & audit ─────────

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s // neutralise spreadsheet formulas
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

admin.get('/export', requirePermission('notifications.read_all'), async (c) => {
  const type = query(c, 'type') ?? 'deliveries'
  const { from, to } = range(c)
  const f = from ?? new Date(Date.now() - 30 * 86400_000).toISOString()
  const t = to ?? new Date(Date.now() + 60_000).toISOString()
  let rows: Record<string, unknown>[]
  if (type === 'notifications') {
    rows = await many(c.env.DB, `SELECT n.created_at, u.name AS recipient, n.event_key, n.category, n.priority, n.title, n.read_at, n.requires_ack, n.acknowledged_at FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.created_at >= ? AND n.created_at < ? ORDER BY n.created_at DESC LIMIT 20000`, f, t)
  } else if (type === 'broadcasts') {
    rows = await many(c.env.DB, `SELECT b.created_at, u.name AS sender, b.kind, b.title, b.audience_label, b.status, b.scheduled_at, b.sent_at, b.recipient_count, (SELECT COUNT(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.acknowledged_at IS NOT NULL) AS acknowledged FROM notification_broadcasts b JOIN users u ON u.id = b.created_by WHERE b.created_at >= ? AND b.created_at < ? ORDER BY b.created_at DESC`, f, t)
  } else if (type === 'deliveries') {
    rows = await many(c.env.DB, `SELECT d.created_at, u.name AS recipient_name, d.channel, d.event_key, d.status, d.recipient, d.subject, d.attempts, d.provider_message_id, d.sent_at, d.delivered_at, d.opened_at, d.last_error FROM notification_deliveries d JOIN users u ON u.id = d.user_id WHERE d.created_at >= ? AND d.created_at < ? ORDER BY d.created_at DESC LIMIT 20000`, f, t)
  } else throw badRequest('Unknown export type')
  const cols = rows[0] ? Object.keys(rows[0]) : ['created_at']
  const csv = [cols.join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\n')
  await audit(c, 'exported', `Exported ${rows.length} ${type} rows`, type)
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${type}-${localDate()}.csv"`, 'cache-control': 'no-store' } })
})

admin.get('/audit', READ, async (c) =>
  c.json({
    entries: await many(
      c.env.DB,
      `SELECT l.id, l.action, l.summary, l.entity_id, l.created_at, u.name AS actor_name FROM activity_logs l LEFT JOIN users u ON u.id = l.actor_id
        WHERE l.action LIKE 'notification.%' OR (l.action = 'settings.updated' AND l.entity_id LIKE 'notifications.%') ORDER BY l.created_at DESC LIMIT 200`,
    ),
  }),
)

export default admin
