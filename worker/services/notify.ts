// Central notification event engine.
//
// Every CRM module raises notifications through notify(). One call:
//   1. resolves each item's event definition (registry + Super Admin rule overrides) and skips disabled events,
//   2. drops the actor, inactive accounts and duplicates (dedupe key per recipient),
//   3. applies recipient preferences per channel (mandatory events bypass them), quiet hours and email suppression,
//   4. writes the in-app rows, the event record (timeline) and one outbox row per email / push delivery,
//   5. publishes a realtime hint to each recipient, and
//   6. hands the outbox rows to the delivery worker asynchronously (never inside the caller's DB transaction).
// The outbox is durable: anything not sent immediately is picked up by the 5-minute cron (retries, quiet hours).

import type { Env } from '../env'
import {
  LEGACY_GROUP_EVENT, NOTIFICATION_EVENTS, PREFERENCE_GROUPS, isEventKey,
  type Channel, type EventDef, type NotificationEventKey, type NotificationPriority, type PreferenceGroup,
} from '@shared/notificationEvents'
import { newId } from '../lib/crypto'
import { many, placeholders } from '../lib/db'
import { publish, rooms, type Waiter } from './realtime'
import { vapidShapeProblem } from './push'

/** Preference groups (legacy name kept: callers and the preferences API use it). */
export const NOTIFICATION_KINDS = PREFERENCE_GROUPS
export type NotificationKind = PreferenceGroup

export interface EmailContent {
  subject?: string
  /** Opening paragraph after the greeting. */
  intro?: string
  /** Label / value rows (Task, Project, Commented by, …). */
  details?: [string, string][]
  /** Quoted message (comment text, update body, announcement). */
  message?: string
  /** Closing line before the button. */
  outro?: string
  actionLabel?: string
  /** Structured report sections (digests and scheduled reports). */
  sections?: { title: string; rows?: [string, string | number][]; items?: string[]; empty?: string }[]
}

export interface NotificationInput {
  userId: string
  /** Registry event. Optional only for legacy callers, which pass `kind`. */
  event?: NotificationEventKey
  kind?: NotificationKind
  title: string
  body?: string
  link?: string
  entityType?: string
  entityId?: string
  projectId?: string
  dedupeKey?: string
  priority?: NotificationPriority
  requiresAck?: boolean
  mandatory?: boolean
  /** Explicit channel selection (broadcasts). Intersected with what is configured and allowed. */
  channels?: Channel[]
  broadcastId?: string
  expiresAt?: string
  email?: EmailContent
  push?: { title?: string; body?: string }
}

export interface NotifyOptions {
  actorName?: string
  /** Skip the immediate async dispatch (tests and bulk jobs let the queue worker pick rows up). */
  deferDispatch?: boolean
}

export interface ResolvedRule extends EventDef {
  key: NotificationEventKey
  enabled: boolean
}

// ───────── Rules (registry + overrides) ─────────

let ruleCache: { at: number; rows: Map<string, { enabled: number; channels: string | null; priority: string | null; mandatory: number | null }> } | null = null
export function invalidateRuleCache() {
  ruleCache = null
}

async function loadOverrides(db: D1Database) {
  if (ruleCache && Date.now() - ruleCache.at < 30_000) return ruleCache.rows
  const rows = await many<{ event_key: string; enabled: number; channels: string | null; priority: string | null; mandatory: number | null }>(db, 'SELECT event_key, enabled, channels, priority, mandatory FROM notification_rules')
  ruleCache = { at: Date.now(), rows: new Map(rows.map((r) => [r.event_key, r])) }
  return ruleCache.rows
}

export async function resolveRules(db: D1Database): Promise<Map<NotificationEventKey, ResolvedRule>> {
  const overrides = await loadOverrides(db)
  const out = new Map<NotificationEventKey, ResolvedRule>()
  for (const [key, def] of Object.entries(NOTIFICATION_EVENTS) as [NotificationEventKey, EventDef][]) {
    const o = overrides.get(key)
    let channels = def.channels
    if (o?.channels) {
      try {
        const parsed = JSON.parse(o.channels) as Channel[]
        channels = parsed.filter((c) => c === 'in_app' || c === 'email' || c === 'push')
      } catch {
        /* keep default */
      }
    }
    out.set(key, {
      ...def,
      key,
      enabled: o ? o.enabled === 1 : true,
      channels,
      priority: (o?.priority as NotificationPriority | null) ?? def.priority,
      mandatory: o?.mandatory == null ? Boolean(def.mandatory) : o.mandatory === 1,
    })
  }
  return out
}

function eventFor(item: NotificationInput): NotificationEventKey {
  if (item.event && isEventKey(item.event)) return item.event
  return (item.kind && LEGACY_GROUP_EVENT[item.kind]) || 'SYSTEM_JOB_FAILED'
}

// ───────── Channel availability ─────────

export const emailConfigured = (env: Env) => Boolean(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL)
/** Push is usable when all three VAPID values are set and well-formed (see push.ts → vapidShapeProblem). */
export const pushConfigured = (env: Env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) && vapidShapeProblem(env) === null

// ───────── Helpers ─────────

/** D1 allows at most 100 bound parameters per statement. */
export function chunk<T>(list: T[], size = 90): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function manyIn<T>(db: D1Database, sqlFor: (ph: string) => string, ids: string[], ...pre: unknown[]): Promise<T[]> {
  const out: T[] = []
  for (const part of chunk(ids, 90 - pre.length)) out.push(...(await many<T>(db, sqlFor(placeholders(part.length)), ...pre, ...part)))
  return out
}

function localMinutes(at: Date, tz = 'Asia/Kolkata'): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** If `at` falls inside the quiet window, return when it ends; otherwise null. Windows may cross midnight. */
export function quietUntil(at: Date, start: string | null, end: string | null, tz = 'Asia/Kolkata'): Date | null {
  if (!start || !end || start === end) return null
  const now = localMinutes(at, tz)
  const s = toMin(start)
  const e = toMin(end)
  const inside = s < e ? now >= s && now < e : now >= s || now < e
  if (!inside) return null
  const wait = (e - now + 1440) % 1440
  return new Date(at.getTime() + wait * 60_000)
}

// ───────── notify() ─────────

export async function notify(env: Env, waiter: Waiter, items: NotificationInput[], actorId?: string, opts: NotifyOptions = {}) {
  const list = items.filter((n) => n.userId && n.userId !== actorId)
  if (list.length === 0) return { created: 0, deliveries: 0 }
  const rules = await resolveRules(env.DB)
  const userIds = [...new Set(list.map((n) => n.userId))]

  const [users, prefs, settings, devices] = await Promise.all([
    manyIn<{ id: string; name: string; email: string; status: string }>(env.DB, (ph) => `SELECT id, name, email, status FROM users WHERE id IN (${ph})`, userIds),
    manyIn<{ user_id: string; kind: string; in_app: number; email: number; push: number }>(env.DB, (ph) => `SELECT user_id, kind, in_app, email, push FROM notification_preferences WHERE user_id IN (${ph})`, userIds),
    manyIn<{ user_id: string; email_enabled: number; push_enabled: number; quiet_start: string | null; quiet_end: string | null; email_suppressed_at: string | null }>(
      env.DB,
      (ph) => `SELECT user_id, email_enabled, push_enabled, quiet_start, quiet_end, email_suppressed_at FROM notification_user_settings WHERE user_id IN (${ph})`,
      userIds,
    ),
    pushConfigured(env)
      ? manyIn<{ user_id: string; n: number }>(env.DB, (ph) => `SELECT user_id, COUNT(*) AS n FROM push_subscriptions WHERE status = 'active' AND user_id IN (${ph}) GROUP BY user_id`, userIds)
      : Promise.resolve([]),
  ])
  const userMap = new Map(users.map((u) => [u.id, u]))
  const prefMap = new Map(prefs.map((p) => [`${p.user_id}|${p.kind}`, p]))
  const settingMap = new Map(settings.map((s) => [s.user_id, s]))
  const deviceMap = new Map(devices.map((d) => [d.user_id, d.n]))
  const canEmail = emailConfigured(env)
  const canPush = pushConfigured(env)
  const now = new Date()
  const nowS = now.toISOString()

  interface Planned {
    item: NotificationInput
    rule: ResolvedRule
    notifId: string | null
    channels: Channel[]
    eventId: string
    sendAt: string
  }
  const planned: Planned[] = []
  const seen = new Set<string>()
  const eventIds = new Map<string, string>()

  for (const item of list) {
    const key = eventFor(item)
    const rule = rules.get(key)!
    const mandatory = item.mandatory ?? rule.mandatory
    if (!rule.enabled && !mandatory) continue
    const user = userMap.get(item.userId)
    if (!user || user.status !== 'active') continue
    const dedupe = item.dedupeKey ?? null
    const seenKey = `${item.userId}|${dedupe ?? newId('x')}`
    if (seen.has(seenKey)) continue
    seen.add(seenKey)
    const group = (item.kind ?? rule.group) as PreferenceGroup
    const pref = prefMap.get(`${item.userId}|${group}`)
    const setting = settingMap.get(item.userId)
    const wanted = item.channels ?? rule.channels
    const channels: Channel[] = []
    for (const ch of wanted) {
      if (ch === 'in_app') {
        if (mandatory || (pref?.in_app ?? 1) === 1) channels.push(ch)
      } else if (ch === 'email') {
        if (!canEmail || !user.email || setting?.email_suppressed_at) continue
        if (mandatory || ((setting?.email_enabled ?? 1) === 1 && (pref?.email ?? 1) === 1)) channels.push(ch)
      } else if (ch === 'push') {
        if (!canPush || !deviceMap.get(item.userId)) continue
        if (mandatory || ((setting?.push_enabled ?? 1) === 1 && (pref?.push ?? 1) === 1)) channels.push(ch)
      }
    }
    // Mandatory notices always leave a record in the inbox, even when the event is configured email-only.
    if (mandatory && !channels.includes('in_app')) channels.unshift('in_app')
    if (channels.length === 0) continue
    const priority = item.priority ?? rule.priority
    const quiet = priority === 'critical' || priority === 'high' ? null : quietUntil(now, setting?.quiet_start ?? null, setting?.quiet_end ?? null, env.COMPANY_TIMEZONE)
    const groupKey = `${key}|${item.entityType ?? ''}|${item.entityId ?? ''}|${item.broadcastId ?? ''}`
    if (!eventIds.has(groupKey)) eventIds.set(groupKey, newId('nev'))
    planned.push({
      item: { ...item, priority, kind: group, mandatory },
      rule,
      notifId: channels.includes('in_app') ? newId('ntf') : null,
      channels,
      eventId: eventIds.get(groupKey)!,
      sendAt: quiet ? quiet.toISOString() : nowS,
    })
  }
  if (planned.length === 0) return { created: 0, deliveries: 0 }

  // 1. In-app rows. INSERT OR IGNORE + RETURNING tells us which were new (dedupe on user + dedupe_key).
  const inserted = new Set<string>()
  const withRow = planned.filter((p) => p.notifId)
  for (const part of chunk(withRow, 50)) {
    const res = await env.DB.batch(
      part.map((p) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO notifications (id, user_id, kind, title, body, link, entity_type, entity_id, dedupe_key, created_at,
             event_key, category, priority, event_id, actor_id, project_id, broadcast_id, requires_ack, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        ).bind(
          p.notifId, p.item.userId, p.item.kind, p.item.title.slice(0, 200), (p.item.body ?? '').slice(0, 1000), p.item.link ?? null,
          p.item.entityType ?? null, p.item.entityId ?? null, p.item.dedupeKey ?? null, nowS,
          p.rule.key, p.rule.category, p.item.priority, p.eventId, actorId ?? null, p.item.projectId ?? null, p.item.broadcastId ?? null,
          p.item.requiresAck ? 1 : 0, p.item.expiresAt ?? null,
        ),
      ),
    )
    res.forEach((r) => {
      const id = (r.results?.[0] as { id?: string } | undefined)?.id
      if (id) inserted.add(id)
    })
  }
  // A dedupe hit on the in-app row means this notification was already sent: skip its other channels too.
  const fresh = planned.filter((p) => !p.notifId || inserted.has(p.notifId))
  if (fresh.length === 0) return { created: 0, deliveries: 0 }

  // 2. Outbox rows + event records.
  const deliveryIds: string[] = []
  const stmts: D1PreparedStatement[] = []
  const eventRows = new Map<string, { p: Planned; recipients: Set<string>; channels: Set<Channel> }>()
  for (const p of fresh) {
    const e = eventRows.get(p.eventId) ?? { p, recipients: new Set<string>(), channels: new Set<Channel>() }
    e.recipients.add(p.item.userId)
    p.channels.forEach((c) => e.channels.add(c))
    eventRows.set(p.eventId, e)
    const user = userMap.get(p.item.userId)!
    for (const ch of p.channels) {
      if (ch === 'in_app') continue
      const id = newId('dlv')
      const base = p.item.dedupeKey ? `${p.item.userId}|${p.item.dedupeKey}` : (p.notifId ?? id)
      const payload = {
        title: p.item.title,
        body: p.item.body ?? '',
        link: p.item.link ?? null,
        recipientName: user.name,
        actorName: opts.actorName ?? null,
        sensitive: Boolean(p.rule.sensitive),
        email: p.item.email ?? null,
        push: p.item.push ?? null,
        notificationId: p.notifId,
        requiresAck: Boolean(p.item.requiresAck),
      }
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO notification_deliveries (id, notification_id, event_id, event_key, user_id, channel, status, priority, dedupe_key, payload, recipient, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?)`,
        ).bind(id, p.notifId, p.eventId, p.rule.key, p.item.userId, ch, p.item.priority, `${base}|${ch}`, JSON.stringify(payload), ch === 'email' ? user.email : null, p.sendAt, nowS, nowS),
      )
      if (p.sendAt <= nowS) deliveryIds.push(id)
    }
  }
  for (const [eventId, e] of eventRows) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO notification_events (id, event_key, category, priority, title, entity_type, entity_id, project_id, actor_id, broadcast_id, recipient_count, channels, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        eventId, e.p.rule.key, e.p.rule.category, e.p.item.priority, e.p.item.title.slice(0, 200), e.p.item.entityType ?? null, e.p.item.entityId ?? null,
        e.p.item.projectId ?? null, actorId ?? null, e.p.item.broadcastId ?? null, e.recipients.size, JSON.stringify([...e.channels]), nowS,
      ),
    )
  }
  for (const part of chunk(stmts, 80)) await env.DB.batch(part)

  // 3. Realtime hint to each recipient's inbox.
  publish(
    env,
    waiter,
    fresh.filter((p) => p.notifId).map((p) => ({
      type: 'notification.created' as const,
      room: rooms.user(p.item.userId),
      data: { id: p.notifId, kind: p.item.kind, event: p.rule.key, priority: p.item.priority, title: p.item.title, link: p.item.link ?? null },
    })),
  )

  // 4. Deliver asynchronously. Failures stay in the outbox for the cron worker to retry.
  if (deliveryIds.length && !opts.deferDispatch && env.APP_ENV !== 'test') {
    const { processDeliveries } = await import('./notificationQueue')
    // Large fan-outs (broadcasts) go out in chunks; anything past the cap is left for the cron worker.
    const run = async () => {
      for (const ids of chunk(deliveryIds.slice(0, 300), 90)) await processDeliveries(env, waiter, { ids, limit: 90 })
    }
    waiter.waitUntil(run().catch((err: unknown) => console.error('notification dispatch failed', err)))
  }
  return { created: fresh.filter((p) => p.notifId).length, deliveries: stmts.length - eventRows.size }
}

// ───────── Recipient helpers (kept here for existing imports) ─────────

/** Users who can review work in a project: PM, project members with review rights, project managers of record. */
export async function projectReviewers(db: D1Database, projectId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT manager_id AS user_id FROM projects WHERE id = ? AND manager_id IS NOT NULL
     UNION SELECT user_id FROM project_members WHERE project_id = ? AND (can_review = 1 OR role = 'manager')`,
    projectId,
    projectId,
  )
  return rows.map((r) => r.user_id)
}

/** Active users holding a permission (for approval routing). */
export async function usersWithPermission(db: D1Database, perm: string): Promise<string[]> {
  const rows = await many<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE rp.permission_key = ? AND u.status = 'active'`,
    perm,
  )
  return rows.map((r) => r.id)
}
