// Announcements and messages. A broadcast resolves its audience at send time (so a scheduled announcement reaches
// the people in the department when it goes out), then fans out through notify() with dedupe key "bc:<id>" — a
// broadcast can never be delivered twice to the same person, even if the send is retried.

import { z } from 'zod'
import type { Env } from '../env'
import { CHANNELS, NOTIFICATION_PRIORITIES } from '@shared/notificationEvents'
import { activity } from '../lib/audit'
import { many, nowIso, one } from '../lib/db'
import { chunk, notify } from './notify'
import type { Waiter } from './realtime'

export const audienceSchema = z
  .object({
    all: z.boolean().default(false),
    departmentIds: z.array(z.string().max(40)).max(50).default([]),
    projectIds: z.array(z.string().max(40)).max(50).default([]),
    roleKeys: z.array(z.string().max(40)).max(20).default([]),
    userIds: z.array(z.string().max(40)).max(500).default([]),
  })
  .refine((a) => a.all || a.departmentIds.length + a.projectIds.length + a.roleKeys.length + a.userIds.length > 0, { message: 'Choose at least one recipient group' })
export type Audience = z.infer<typeof audienceSchema>

export const broadcastSchema = z.object({
  kind: z.enum(['announcement', 'message']).default('announcement'),
  title: z.string().trim().min(2, 'Add a title').max(150),
  body: z.string().trim().min(1, 'Write the message').max(5000),
  priority: z.enum(NOTIFICATION_PRIORITIES).default('normal'),
  audience: audienceSchema,
  channels: z.array(z.enum(CHANNELS)).min(1, 'Choose at least one channel').max(3),
  requiresAck: z.boolean().default(false),
  mandatory: z.boolean().default(false),
  link: z.string().trim().max(300).regex(/^\/(?!\/)/, 'Use an in-app path such as /projects').nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  /** Required for company-wide sends: the sender saw the recipient count and confirmed. */
  confirm: z.boolean().optional(),
})
export type BroadcastInput = z.infer<typeof broadcastSchema>

export async function resolveAudience(db: D1Database, a: Audience): Promise<string[]> {
  if (a.all) return (await many<{ id: string }>(db, `SELECT id FROM users WHERE status = 'active'`)).map((r) => r.id)
  const ids = new Set<string>()
  const add = (rows: { id: string }[]) => rows.forEach((r) => ids.add(r.id))
  for (const part of chunk(a.departmentIds)) {
    add(await many(db, `SELECT u.id FROM users u JOIN employee_profiles ep ON ep.user_id = u.id WHERE u.status = 'active' AND ep.department_id IN (${part.map(() => '?').join(', ')})`, ...part))
  }
  for (const part of chunk(a.projectIds, 45)) {
    const ph = part.map(() => '?').join(', ')
    add(await many(db, `SELECT u.id FROM users u WHERE u.status = 'active' AND (u.id IN (SELECT manager_id FROM projects WHERE id IN (${ph})) OR u.id IN (SELECT user_id FROM project_members WHERE project_id IN (${ph})))`, ...part, ...part))
  }
  for (const part of chunk(a.roleKeys)) {
    add(await many(db, `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.status = 'active' AND r.key IN (${part.map(() => '?').join(', ')})`, ...part))
  }
  for (const part of chunk(a.userIds)) {
    add(await many(db, `SELECT id FROM users WHERE status = 'active' AND id IN (${part.map(() => '?').join(', ')})`, ...part))
  }
  return [...ids]
}

export async function audienceLabel(db: D1Database, a: Audience): Promise<string> {
  if (a.all) return 'All active employees'
  const parts: string[] = []
  if (a.departmentIds.length) {
    const d = await many<{ name: string }>(db, `SELECT name FROM departments WHERE id IN (${a.departmentIds.slice(0, 50).map(() => '?').join(', ')})`, ...a.departmentIds.slice(0, 50))
    parts.push(`Departments: ${d.map((x) => x.name).join(', ')}`)
  }
  if (a.projectIds.length) {
    const p = await many<{ reference: string }>(db, `SELECT reference FROM projects WHERE id IN (${a.projectIds.slice(0, 50).map(() => '?').join(', ')})`, ...a.projectIds.slice(0, 50))
    parts.push(`Project teams: ${p.map((x) => x.reference).join(', ')}`)
  }
  if (a.roleKeys.length) {
    const r = await many<{ name: string }>(db, `SELECT name FROM roles WHERE key IN (${a.roleKeys.map(() => '?').join(', ')})`, ...a.roleKeys)
    parts.push(`Roles: ${r.map((x) => x.name).join(', ')}`)
  }
  if (a.userIds.length) parts.push(`${a.userIds.length} selected ${a.userIds.length === 1 ? 'person' : 'people'}`)
  return parts.join(' · ').slice(0, 500)
}

/** Send a scheduled or immediate broadcast. Idempotent: only one caller can move it to "sending". */
export async function sendBroadcast(env: Env, waiter: Waiter, id: string) {
  const b = await one<{ id: string; kind: string; title: string; body: string; priority: string; audience: string; channels: string; requires_ack: number; mandatory: number; link: string | null; expires_at: string | null; created_by: string }>(
    env.DB,
    `UPDATE notification_broadcasts SET status = 'sending' WHERE id = ? AND status = 'scheduled' RETURNING id, kind, title, body, priority, audience, channels, requires_ack, mandatory, link, expires_at, created_by`,
    id,
  )
  if (!b) return null
  try {
    const sender = await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', b.created_by)
    const recipients = await resolveAudience(env.DB, audienceSchema.parse(JSON.parse(b.audience)))
    const event = b.kind === 'message' ? ('DIRECT_MESSAGE' as const) : ('ANNOUNCEMENT_CREATED' as const)
    const channels = JSON.parse(b.channels) as ('in_app' | 'email' | 'push')[]
    // The sender keeps their own copy of announcements (it shows in their inbox like everyone else's).
    const result = await notify(
      env,
      waiter,
      recipients.map((u) => ({
        userId: u,
        event,
        title: b.title,
        body: b.body.slice(0, 1000),
        link: b.link ?? `/notifications?broadcast=${b.id}`,
        entityType: 'broadcast',
        entityId: b.id,
        broadcastId: b.id,
        priority: b.priority as 'critical' | 'high' | 'normal' | 'low',
        requiresAck: Boolean(b.requires_ack),
        mandatory: Boolean(b.mandatory),
        channels: channels.includes('in_app') ? channels : ['in_app', ...channels],
        expiresAt: b.expires_at ?? undefined,
        dedupeKey: `bc:${b.id}`,
        email: { subject: b.title, intro: `${sender?.name ?? 'Visionary X'} sent ${b.kind === 'message' ? 'you a message' : 'an announcement'}.`, message: b.body, actionLabel: b.requires_ack ? 'Open and acknowledge' : 'Open in CRM' },
        push: { title: b.title, body: b.body.slice(0, 200) },
      })),
      undefined,
      { actorName: sender?.name },
    )
    const now = nowIso()
    await env.DB.batch([
      env.DB.prepare(`UPDATE notification_broadcasts SET status = 'sent', sent_at = ?, recipient_count = ? WHERE id = ?`).bind(now, recipients.length, b.id),
      activity(env.DB, { category: 'admin', actorType: 'system', action: 'notification.broadcast_sent', entityType: 'broadcast', entityId: b.id, summary: `Sent ${b.kind} “${b.title}” to ${recipients.length} recipient(s)` }),
    ])
    return { recipients: recipients.length, ...result }
  } catch (err) {
    await env.DB.prepare(`UPDATE notification_broadcasts SET status = 'failed', error = ? WHERE id = ?`).bind(String(err instanceof Error ? err.message : err).slice(0, 500), b.id).run()
    throw err
  }
}

export async function sendDueBroadcasts(env: Env, waiter: Waiter, now = new Date()) {
  const due = await many<{ id: string }>(env.DB, `SELECT id FROM notification_broadcasts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10`, now.toISOString())
  let sent = 0
  for (const b of due) if (await sendBroadcast(env, waiter, b.id)) sent++
  return sent
}
