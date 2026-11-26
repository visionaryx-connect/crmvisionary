import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { as, call, scaffoldProject } from './helpers'
import { notify, quietUntil } from '../worker/services/notify'
import { processDeliveries } from '../worker/services/notificationQueue'
import { b64urlDecode, b64urlEncode, encryptPayload, vapidConfig, vapidJwt, vapidProblem, vapidShapeProblem } from '../worker/services/push'
import { attendanceMissing, attendanceReminder, escalateOverdueTasks, inSlot, once } from '../worker/services/notificationSchedule'
import { renderEmail } from '../worker/services/notificationTemplates'
import { brevoSender, sendBrevoEmail, senderProblem } from '../worker/services/brevo'
import { newId } from '../worker/lib/crypto'

const waiter = { waitUntil: () => undefined }
const WEBHOOK = 'test-webhook-secret-0123456789'
const db = () => env.DB

const notes = (userId: string, event?: string) =>
  db().prepare(`SELECT * FROM notifications WHERE user_id = ? ${event ? 'AND event_key = ?' : ''} ORDER BY created_at`).bind(userId, ...(event ? [event] : [])).all<Record<string, any>>().then((r) => r.results)
const deliveries = (userId: string, channel?: string) =>
  db().prepare(`SELECT * FROM notification_deliveries WHERE user_id = ? ${channel ? 'AND channel = ?' : ''} ORDER BY created_at`).bind(userId, ...(channel ? [channel] : [])).all<Record<string, any>>().then((r) => r.results)

/** A fake fetch that records calls and answers with the given responses in turn. */
function fakeFetch(...responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  let i = 0
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses[Math.min(i++, responses.length - 1)]
    return r()
  }) as typeof fetch
  return { fn, calls }
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function team() {
  const admin = await as('super_admin')
  const pm = await as('project_manager')
  const dev = await as('employee')
  const dev2 = await as('employee')
  const { projectId } = await scaffoldProject(admin.agent, pm.id, [{ id: dev.id }, { id: dev2.id }])
  const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Website Development', responsibleId: dev.id, dueDate: '2030-01-10' })
  expect(t.status).toBe(201)
  return { admin, pm, dev, dev2, projectId, taskId: t.json.id as string }
}

describe('central event engine', () => {
  it('routes a task assignment to the assignee (all channels) and the project manager (in-app heads-up)', async () => {
    const admin = await as('super_admin')
    const pm = await as('project_manager')
    const dev = await as('employee')
    const { projectId } = await scaffoldProject(admin.agent, pm.id, [{ id: dev.id }])
    const t = await call(admin.agent, 'POST', '/api/tasks', { projectId, title: 'Landing page', responsibleId: dev.id, priority: 'high', dueDate: '2030-02-01' })
    const mine = await notes(dev.id, 'TASK_ASSIGNED')
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ category: 'task', priority: 'normal', link: `/tasks/${t.json.id}`, project_id: projectId, actor_id: admin.id })
    expect((await deliveries(dev.id, 'email')).map((d) => d.event_key)).toContain('TASK_ASSIGNED')
    const pmNote = await notes(pm.id, 'TASK_ASSIGNED')
    expect(pmNote).toHaveLength(1)
    expect((await deliveries(pm.id)).filter((d) => d.event_key === 'TASK_ASSIGNED')).toHaveLength(0) // in-app only
    const ev = await db().prepare(`SELECT * FROM notification_events WHERE entity_id = ? AND event_key = 'TASK_ASSIGNED'`).bind(t.json.id).all()
    expect(ev.results.length).toBeGreaterThanOrEqual(1)
  })

  it('sends each person one notification per comment: mention > reply > comment, never to the author', async () => {
    const { pm, dev, dev2, taskId } = await team()
    const root = await call(dev.agent, 'POST', `/api/tasks/${taskId}/comments`, { body: 'First pass is up.' })
    expect(root.status).toBe(201)
    expect(await notes(pm.id, 'TASK_COMMENT_CREATED')).toHaveLength(1)
    expect(await notes(dev.id, 'TASK_COMMENT_CREATED')).toHaveLength(0)
    // PM replies and mentions dev2 (a project member who is not otherwise on the task).
    const reply = await call(pm.agent, 'POST', `/api/tasks/${taskId}/comments`, { body: '@dev2 please check mobile layout', parentId: root.json.id, mentions: [dev2.id] })
    expect(reply.status).toBe(201)
    const devReply = await notes(dev.id, 'TASK_COMMENT_REPLIED')
    expect(devReply).toHaveLength(1)
    expect(devReply[0].title).toContain('replied to your comment')
    expect(await notes(dev2.id, 'TASK_MENTIONED')).toHaveLength(1)
    expect((await notes(dev2.id)).filter((n) => n.event_key === 'TASK_COMMENT_CREATED')).toHaveLength(0)
    // Email content carries the task, project and the comment text.
    const email = (await deliveries(dev.id, 'email')).find((d) => d.event_key === 'TASK_COMMENT_REPLIED')!
    const payload = JSON.parse(email.payload)
    expect(payload.email.message).toBe('@dev2 please check mobile layout')
    expect(payload.email.details.map((d: string[]) => d[0])).toEqual(expect.arrayContaining(['Task', 'Project', 'Commented by', 'Comment time']))
  })

  it('ignores @mentions of people who cannot see the project, and does not re-notify on edits', async () => {
    const { pm, dev, taskId } = await team()
    const outsider = await as('employee')
    const r = await call(pm.agent, 'POST', `/api/tasks/${taskId}/comments`, { body: 'hello', mentions: [outsider.id] })
    expect(r.status).toBe(201)
    expect(await notes(outsider.id)).toHaveLength(0)
    const before = (await notes(dev.id)).length
    const e = await call(pm.agent, 'PATCH', `/api/tasks/${taskId}/comments/${r.json.id}`, { body: 'hello (edited)' })
    expect(e.status).toBe(200)
    expect((await notes(dev.id)).length).toBe(before)
    expect((await deliveries(dev.id, 'email')).filter((d) => d.event_key === 'TASK_COMMENT_CREATED')).toHaveLength(1)
  })

  it('applies channel preferences, but mandatory security notices bypass them', async () => {
    const { pm, dev, taskId } = await team()
    const p = await call(dev.agent, 'PUT', '/api/notifications/preferences', { preferences: [{ kind: 'task_comment', inApp: true, email: false, push: false }, { kind: 'security', inApp: false, email: false }] })
    expect(p.status).toBe(200)
    await call(pm.agent, 'POST', `/api/tasks/${taskId}/comments`, { body: 'note' })
    expect(await notes(dev.id, 'TASK_COMMENT_CREATED')).toHaveLength(1)
    expect((await deliveries(dev.id, 'email')).filter((d) => d.event_key === 'TASK_COMMENT_CREATED')).toHaveLength(0)
    await notify(env, waiter, [{ userId: dev.id, event: 'SECURITY_PASSWORD_CHANGED', title: 'Password changed' }])
    expect(await notes(dev.id, 'SECURITY_PASSWORD_CHANGED')).toHaveLength(1)
    expect((await deliveries(dev.id, 'email')).filter((d) => d.event_key === 'SECURITY_PASSWORD_CHANGED')).toHaveLength(1)
    const prefs = await call(dev.agent, 'GET', '/api/notifications/preferences')
    expect(prefs.json.preferences.find((x: any) => x.kind === 'security')).toMatchObject({ locked: true, inApp: true })
  })

  it('de-duplicates by key across channels and skips inactive recipients', async () => {
    const dev = await as('employee')
    const ghost = await as('employee')
    await db().prepare(`UPDATE users SET status = 'deactivated' WHERE id = ?`).bind(ghost.id).run()
    const item = { userId: dev.id, event: 'TASK_OVERDUE' as const, title: 'Overdue', dedupeKey: 'dup-test' }
    await notify(env, waiter, [item, { ...item, userId: ghost.id }])
    await notify(env, waiter, [item])
    expect(await notes(dev.id, 'TASK_OVERDUE')).toHaveLength(1)
    expect((await deliveries(dev.id, 'email')).filter((d) => d.event_key === 'TASK_OVERDUE')).toHaveLength(1)
    expect(await notes(ghost.id)).toHaveLength(0)
  })

  it('respects disabled rules and quiet hours', async () => {
    const admin = await as('super_admin')
    const dev = await as('employee')
    const r = await call(admin.agent, 'PUT', '/api/notifications/admin/rules/TASK_UPDATED', { enabled: false, channels: ['in_app'], priority: 'low', mandatory: false })
    expect(r.status).toBe(200)
    await notify(env, waiter, [{ userId: dev.id, event: 'TASK_UPDATED', title: 'x' }])
    expect(await notes(dev.id, 'TASK_UPDATED')).toHaveLength(0)
    await call(admin.agent, 'DELETE', '/api/notifications/admin/rules/TASK_UPDATED')
    // 23:00–07:00 IST quiet window: 02:00 IST is inside, ends at 07:00 IST (01:30 UTC).
    const at = new Date('2030-01-09T20:30:00.000Z') // 02:00 IST
    expect(quietUntil(at, '23:00', '07:00')?.toISOString()).toBe('2030-01-10T01:30:00.000Z')
    expect(quietUntil(new Date('2030-01-09T06:30:00.000Z'), '23:00', '07:00')).toBeNull() // 12:00 IST
  })

  it('refuses to let security alerts be switched off', async () => {
    const admin = await as('super_admin')
    const r = await call(admin.agent, 'PUT', '/api/notifications/admin/rules/SECURITY_NEW_LOGIN', { enabled: false, channels: ['in_app'], priority: 'low', mandatory: false })
    expect(r.status).toBe(400)
  })
})

describe('inbox privacy and actions', () => {
  it('scopes every inbox action to its owner and keeps admin views from ordinary employees', async () => {
    const a = await as('employee')
    const b = await as('employee')
    await notify(env, waiter, [{ userId: a.id, event: 'DIRECT_MESSAGE', title: 'Private to A', requiresAck: true }])
    const [n] = await notes(a.id, 'DIRECT_MESSAGE')
    expect((await call(b.agent, 'POST', `/api/notifications/${n.id}/ack`, {})).status).toBe(404)
    await call(b.agent, 'POST', '/api/notifications/read', { ids: [n.id] })
    expect((await notes(a.id, 'DIRECT_MESSAGE'))[0].read_at).toBeNull()
    const list = await call(b.agent, 'GET', '/api/notifications')
    expect(list.json.notifications.some((x: any) => x.id === n.id)).toBe(false)
    for (const path of ['/api/notifications/admin/notifications', '/api/notifications/admin/deliveries', '/api/notifications/admin/overview', '/api/notifications/admin/broadcasts']) {
      expect((await call(b.agent, 'GET', path)).status).toBe(403)
    }
    expect((await call(b.agent, 'POST', '/api/notifications/admin/broadcasts', { title: 'Hi', body: 'x', audience: { all: true }, channels: ['in_app'], confirm: true })).status).toBe(403)
    // Required notices cannot be archived until acknowledged; acknowledging works for the owner.
    await call(a.agent, 'POST', '/api/notifications/archive', { ids: [n.id] })
    expect((await notes(a.id, 'DIRECT_MESSAGE'))[0].archived_at).toBeNull()
    expect((await call(a.agent, 'GET', '/api/notifications?view=action')).json.notifications).toHaveLength(1)
    expect((await call(a.agent, 'POST', `/api/notifications/${n.id}/ack`, {})).status).toBe(200)
    expect((await call(a.agent, 'GET', '/api/notifications/count')).json.actionRequired).toBe(0)
  })

  it('searches, filters by category and snoozes', async () => {
    const u = await as('employee')
    await notify(env, waiter, [
      { userId: u.id, event: 'MEETING_REMINDER', title: 'Standup in 15 minutes' },
      { userId: u.id, event: 'TASK_OVERDUE', title: 'Invoice task overdue' },
    ])
    expect((await call(u.agent, 'GET', '/api/notifications?q=standup')).json.notifications).toHaveLength(1)
    const cal = await call(u.agent, 'GET', '/api/notifications?category=calendar')
    expect(cal.json.notifications.map((n: any) => n.event_key)).toEqual(['MEETING_REMINDER'])
    const id = cal.json.notifications[0].id
    const until = new Date(Date.now() + 3600_000).toISOString()
    expect((await call(u.agent, 'POST', `/api/notifications/${id}/snooze`, { until })).status).toBe(200)
    expect((await call(u.agent, 'GET', '/api/notifications?category=calendar')).json.notifications).toHaveLength(0)
    expect((await call(u.agent, 'GET', '/api/notifications?view=snoozed')).json.notifications).toHaveLength(1)
  })
})

describe('broadcasts', () => {
  it('reaches exactly the selected department, needs confirmation company-wide and tracks acknowledgement', async () => {
    const admin = await as('super_admin')
    const deptId = newId('dep')
    const now = new Date().toISOString()
    await db().prepare('INSERT INTO departments (id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(deptId, `Design ${deptId}`, deptId.slice(-6), now, now).run()
    const inDept = await as('employee', { departmentId: deptId })
    const outside = await as('employee')
    const audience = { departmentIds: [deptId] }
    const prev = await call(admin.agent, 'POST', '/api/notifications/admin/broadcasts/preview', { audience })
    expect(prev.json.count).toBe(1)
    const r = await call(admin.agent, 'POST', '/api/notifications/admin/broadcasts', { title: 'Design review Friday', body: 'Bring your boards.', audience, channels: ['in_app', 'email'], requiresAck: true })
    expect(r.status).toBe(201)
    expect(r.json.status).toBe('sent')
    expect(await notes(inDept.id, 'ANNOUNCEMENT_CREATED')).toHaveLength(1)
    expect(await notes(outside.id, 'ANNOUNCEMENT_CREATED')).toHaveLength(0)
    expect((await deliveries(inDept.id, 'email')).filter((d) => d.event_key === 'ANNOUNCEMENT_CREATED')).toHaveLength(1)
    const [n] = await notes(inDept.id, 'ANNOUNCEMENT_CREATED')
    await call(inDept.agent, 'POST', `/api/notifications/${n.id}/ack`, {})
    const detail = await call(admin.agent, 'GET', `/api/notifications/admin/broadcasts/${r.json.id}`)
    expect(detail.json.recipients).toHaveLength(1)
    expect(detail.json.recipients[0].acknowledged_at).toBeTruthy()
    // Company-wide sends require explicit confirmation.
    const all = await call(admin.agent, 'POST', '/api/notifications/admin/broadcasts', { title: 'All hands', body: 'x', audience: { all: true }, channels: ['in_app'] })
    expect(all.status).toBe(409)
    expect(all.json.error.code).toBe('CONFIRMATION_REQUIRED')
  })

  it('schedules for later, sends once when due, and can be cancelled before that', async () => {
    const admin = await as('super_admin')
    const u = await as('employee')
    const later = new Date(Date.now() + 2 * 3600_000).toISOString()
    const r = await call(admin.agent, 'POST', '/api/notifications/admin/broadcasts', { kind: 'message', title: 'Reminder', body: 'Timesheets', audience: { userIds: [u.id] }, channels: ['in_app'], scheduledAt: later })
    expect(r.json.status).toBe('scheduled')
    expect(await notes(u.id, 'DIRECT_MESSAGE')).toHaveLength(0)
    const { sendDueBroadcasts } = await import('../worker/services/notificationBroadcast')
    await sendDueBroadcasts(env, waiter, new Date(Date.now() + 3 * 3600_000))
    await sendDueBroadcasts(env, waiter, new Date(Date.now() + 3 * 3600_000))
    expect(await notes(u.id, 'DIRECT_MESSAGE')).toHaveLength(1)
    const r2 = await call(admin.agent, 'POST', '/api/notifications/admin/broadcasts', { kind: 'message', title: 'Later', body: 'x', audience: { userIds: [u.id] }, channels: ['in_app'], scheduledAt: later })
    expect((await call(admin.agent, 'POST', `/api/notifications/admin/broadcasts/${r2.json.id}/cancel`, {})).status).toBe(200)
  })

  it('lets HR and Admin send announcements but only notification administrators send mandatory ones', async () => {
    const hr = await as('hr_manager')
    const u = await as('employee')
    const ok = await call(hr.agent, 'POST', '/api/notifications/admin/broadcasts', { title: 'Policy', body: 'Updated', audience: { userIds: [u.id] }, channels: ['in_app'] })
    expect(ok.status).toBe(201)
    const bad = await call(hr.agent, 'POST', '/api/notifications/admin/broadcasts', { title: 'Policy', body: 'Updated', audience: { userIds: [u.id] }, channels: ['in_app'], mandatory: true })
    expect(bad.status).toBe(403)
  })
})

describe('Brevo email delivery', () => {
  async function queuedEmail() {
    const u = await as('employee')
    await notify(env, waiter, [{ userId: u.id, event: 'TASK_ASSIGNED', title: 'New task: <b>Logo</b>', body: 'Due soon', link: '/tasks/x', email: { details: [['Task', 'Logo & "brand"']] } }])
    const [d] = await deliveries(u.id, 'email')
    return { u, d }
  }

  it('sends through the Brevo API, records the message id, and treats acceptance as accepted (not delivered)', async () => {
    const { u, d } = await queuedEmail()
    const f = fakeFetch(json(201, { messageId: '<201798300811.5787683@relay.domain.com>' }))
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: f.fn })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('https://api.brevo.com/v3/smtp/email')
    const headers = f.calls[0].init.headers as Record<string, string>
    expect(headers['api-key']).toBe('test-brevo-key-not-real')
    const sent = JSON.parse(String(f.calls[0].init.body))
    expect(sent.sender).toEqual({ email: 'notifications@example.com', name: 'Visionary X' })
    expect(sent.to[0].email).toBe(u.email)
    expect(sent.htmlContent).toContain('&lt;b&gt;Logo&lt;/b&gt;') // escaped
    expect(sent.htmlContent).not.toContain('<b>Logo</b>')
    expect(sent.headers['X-Mailin-custom']).toBe(d.id)
    const after = (await deliveries(u.id, 'email'))[0]
    expect(after).toMatchObject({ status: 'accepted', provider_message_id: '201798300811.5787683@relay.domain.com', attempts: 1 })
    // A second run never re-sends.
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: f.fn })
    expect(f.calls).toHaveLength(1)
  })

  it('retries temporary failures with backoff and stops on permanent ones', async () => {
    const { u, d } = await queuedEmail()
    const t0 = new Date()
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: fakeFetch(json(503, { message: 'busy' })).fn, now: t0 })
    let row = (await deliveries(u.id, 'email'))[0]
    expect(row.status).toBe('retry')
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(t0.getTime() + 50_000)
    // Not due yet → untouched.
    const f = fakeFetch(json(400, { code: 'invalid_parameter', message: 'bad' }))
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: f.fn, now: t0 })
    expect(f.calls).toHaveLength(0)
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: f.fn, now: new Date(t0.getTime() + 120_000) })
    row = (await deliveries(u.id, 'email'))[0]
    expect(row).toMatchObject({ status: 'failed', attempts: 2 })
    expect(row.last_error).toContain('invalid_parameter')
    // An administrator can retry it.
    const admin = await as('super_admin')
    const rq = await call(admin.agent, 'POST', '/api/notifications/admin/deliveries/retry', { ids: [d.id] })
    expect(rq.json.requeued).toBe(1)
  })

  it('alerts Super Admins (in-app) when Brevo rejects the credentials', async () => {
    const admin = await as('super_admin')
    const { d } = await queuedEmail()
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: fakeFetch(json(401, { code: 'unauthorized', message: 'Key not found' })).fn })
    expect((await notes(admin.id, 'SYSTEM_EMAIL_PROVIDER_ERROR')).length).toBe(1)
  })

  it('verifies webhooks, tracks delivered / bounced from provider events and ignores duplicates', async () => {
    const { u, d } = await queuedEmail()
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: fakeFetch(json(201, { messageId: '<abc-123@relay.test>' })).fn })
    const ev = (event: string, extra: Record<string, unknown> = {}) => ({ event, email: u.email, 'message-id': '<abc-123@relay.test>', ts_event: 1_900_000_000, ...extra })
    const hook = (body: unknown, token?: string) => call(null, 'POST', '/api/webhooks/brevo', body, token ? { 'x-vx-webhook-token': token } : {})
    expect((await hook(ev('delivered'))).status).toBe(401)
    expect((await hook(ev('delivered'), 'wrong-secret-wrong-secret')).status).toBe(401)
    const ok = await hook(ev('delivered'), WEBHOOK)
    expect(ok.status).toBe(200)
    expect((await deliveries(u.id, 'email'))[0]).toMatchObject({ status: 'delivered' })
    const dup = await hook(ev('delivered'), WEBHOOK)
    expect(dup.json.duplicates).toBe(1)
    // Late "request" (sent) event must not move delivered backwards; bearer auth also accepted.
    await call(null, 'POST', '/api/webhooks/brevo', ev('request', { ts_event: 1_899_999_990 }), { authorization: `Bearer ${WEBHOOK}` })
    expect((await deliveries(u.id, 'email'))[0].status).toBe('delivered')
    await hook([ev('hard_bounce', { ts_event: 1_900_000_100, reason: 'mailbox does not exist' })], WEBHOOK)
    const row = (await deliveries(u.id, 'email'))[0]
    expect(row.status).toBe('bounced')
    const s = await db().prepare('SELECT email_suppressed_at, email_suppressed_reason FROM notification_user_settings WHERE user_id = ?').bind(u.id).first<any>()
    expect(s.email_suppressed_reason).toContain('Hard bounce')
    // Suppressed addresses get no further email deliveries.
    await notify(env, waiter, [{ userId: u.id, event: 'TASK_ASSIGNED', title: 'Another' }])
    expect(await deliveries(u.id, 'email')).toHaveLength(1)
  })

  it('normalises hand-pasted sender addresses and refuses invalid ones before calling Brevo', async () => {
    const withSender = (v: string, name?: string) => ({ ...env, BREVO_SENDER_EMAIL: v, BREVO_SENDER_NAME: name }) as typeof env
    expect(brevoSender(withSender(' notifications@visionary-x.in\n'))).toMatchObject({ email: 'notifications@visionary-x.in', valid: true })
    expect(brevoSender(withSender('"notifications@visionary-x.in"'))).toMatchObject({ email: 'notifications@visionary-x.in', valid: true })
    expect(brevoSender(withSender('Visionary X <Notifications@Visionary-X.in>', ''))).toMatchObject({ email: 'notifications@visionary-x.in', name: 'Visionary X', valid: true })
    expect(senderProblem(withSender('notifications@'))).toContain('not a valid email address')
    const f = fakeFetch(json(201, { messageId: '<x@y>' }))
    const r = await sendBrevoEmail(withSender('Visionary X'), { to: [{ email: 'a@example.com' }], subject: 's', htmlContent: 'h' }, f.fn)
    expect(r).toMatchObject({ outcome: 'permanent', code: 'invalid_sender' })
    expect(f.calls).toHaveLength(0)
    // The normalised address is what Brevo receives.
    await sendBrevoEmail(withSender(' "Visionary X <notifications@visionary-x.in>" '), { to: [{ email: 'a@example.com' }], subject: 's', htmlContent: 'h' }, f.fn)
    expect(JSON.parse(String(f.calls[0].init.body)).sender).toEqual({ email: 'notifications@visionary-x.in', name: 'Visionary X' })
  })

  it('explains Brevo sender rejections with the fix', async () => {
    const r = await sendBrevoEmail(env, { to: [{ email: 'a@example.com' }], subject: 's', htmlContent: 'h' }, fakeFetch(json(400, { code: 'invalid_parameter', message: 'valid sender email required' })).fn)
    expect(r.outcome).toBe('permanent')
    expect('error' in r && r.error).toContain('Senders')
  })

  it('renders a responsive branded template with a secure absolute link and hides sensitive details', async () => {
    const r = await renderEmail(env, 'LEAVE_REQUESTED', { title: 'Asha requested leave', body: 'Medical', link: '//evil.example/x', recipientName: 'Riyaz', actorName: null, sensitive: true, email: { details: [['Reason', 'Medical']] }, push: null, notificationId: null, requiresAck: false })
    expect(r.html).toContain('Dear Riyaz')
    expect(r.html).toContain('http://example.com/notifications') // unsafe link replaced with the inbox
    expect(r.html).not.toContain('Medical')
    expect(r.html).toContain('max-width:600px')
  })
})

describe('Web Push', () => {
  it('encrypts payloads per RFC 8291 (aes128gcm) and the browser key can decrypt them', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const uaPublic = new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer)
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const message = JSON.stringify({ title: 'Hello', body: 'World' })
    const body = await encryptPayload(new TextEncoder().encode(message), b64urlEncode(uaPublic), b64urlEncode(auth))
    // Independent decryption (receiver side of RFC 8291 §3.4 / RFC 8188).
    const salt = body.slice(0, 16)
    const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)
    expect(rs).toBe(4096)
    const idlen = body[20]
    const asPublic = body.slice(21, 21 + idlen)
    const cipher = body.slice(21 + idlen)
    const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as any, ua.privateKey, 256))
    const h = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
      new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8))
    const te = new TextEncoder()
    const ikm = await h(auth, shared, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32)
    const cek = await h(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
    const nonce = await h(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher))
    expect(plain[plain.length - 1]).toBe(2)
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(message)
  })

  it('matches the RFC 8291 Appendix A test vector', async () => {
    const vector = {
      plaintext: 'When I grow up, I want to be a watermelon',
      asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      salt: 'DGv6ra1nlYgDCS1FRnbzlw',
      result: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    }
    const out = await encryptPayload(new TextEncoder().encode(vector.plaintext), vector.uaPublic, vector.auth, { salt: b64urlDecode(vector.salt), senderPrivate: b64urlDecode(vector.asPrivate), senderPublic: b64urlDecode(vector.asPublic) })
    expect(b64urlEncode(out)).toBe(vector.result)
  })

  it('accepts hand-pasted VAPID values and rejects unusable or mismatched keys', async () => {
    const pub = env.VAPID_PUBLIC_KEY!
    const priv = env.VAPID_PRIVATE_KEY!
    const withKeys = (p: string, k: string, subj = 'mailto:test@example.com') => ({ ...env, VAPID_PUBLIC_KEY: p, VAPID_PRIVATE_KEY: k, VAPID_SUBJECT: subj }) as typeof env
    // Whole line from gen-vapid.mjs, quotes, newline, standard base64 alphabet — all normalised.
    const messy = withKeys(`VAPID_PUBLIC_KEY=${pub}\n`, ` "${priv.replace(/-/g, '+').replace(/_/g, '/')}=" `, 'VAPID_SUBJECT=mailto:test@example.com   # comment')
    expect(vapidConfig(messy)).toEqual({ publicKey: pub, privateKey: priv, subject: 'mailto:test@example.com' })
    expect(await vapidProblem(messy)).toBeNull()
    expect(vapidShapeProblem(withKeys(pub.slice(0, 40), priv))).toContain('VAPID_PUBLIC_KEY is not a valid public key')
    expect(vapidShapeProblem(withKeys(pub, priv, 'it@example.com'))).toContain('VAPID_SUBJECT')
    // A private key from a different pair is caught before any push is attempted.
    const other = (await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair).privateKey)) as JsonWebKey
    expect(await vapidProblem(withKeys(pub, other.d!))).toMatch(/(not from the same|do not form a valid) key pair/)
  })

  it('signs a verifiable ES256 VAPID JWT', async () => {
    const jwt = await vapidJwt('https://fcm.googleapis.com', 'mailto:test@example.com', env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!)
    const [h, p, s] = jwt.split('.')
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)))
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:test@example.com' })
    const raw = b64urlDecode(env.VAPID_PUBLIC_KEY!)
    const key = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true)
  })

  it('registers devices, delivers to each, and expires subscriptions the push service reports gone', async () => {
    const u = await as('employee')
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    const p256dh = b64urlEncode(new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer))
    const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)))
    const cfg = await call(u.agent, 'GET', '/api/notifications/push/config')
    expect(cfg.json).toMatchObject({ enabled: true, publicKey: env.VAPID_PUBLIC_KEY })
    expect((await call(u.agent, 'POST', '/api/notifications/push/subscriptions', { endpoint: 'http://127.0.0.1/x', keys: { p256dh, auth } })).status).toBe(400)
    const a = await call(u.agent, 'POST', '/api/notifications/push/subscriptions', { endpoint: `https://fcm.googleapis.com/fcm/send/${newId('a')}`, keys: { p256dh, auth }, deviceLabel: 'Phone' })
    const b = await call(u.agent, 'POST', '/api/notifications/push/subscriptions', { endpoint: `https://updates.push.services.mozilla.com/wpush/v2/${newId('b')}`, keys: { p256dh, auth }, deviceLabel: 'Laptop' })
    expect([a.status, b.status]).toEqual([201, 201])
    await notify(env, waiter, [{ userId: u.id, event: 'TASK_ASSIGNED', title: 'Push me', link: '/tasks/1' }])
    const [d] = await deliveries(u.id, 'push')
    expect(d).toBeTruthy()
    const f = fakeFetch(() => new Response(null, { status: 201 }), () => new Response('gone', { status: 410 }))
    await processDeliveries(env, waiter, { ids: [d.id], fetcher: f.fn })
    expect(f.calls).toHaveLength(2)
    const hdr = f.calls[0].init.headers as Record<string, string>
    expect(hdr['content-encoding']).toBe('aes128gcm')
    expect(hdr.authorization).toMatch(/^vapid t=.+, k=/)
    expect((await deliveries(u.id, 'push'))[0]).toMatchObject({ status: 'sent', recipient: '1/2 device(s)' })
    const subs = await call(u.agent, 'GET', '/api/notifications/push/subscriptions')
    expect(subs.json.subscriptions.map((s: any) => s.status).sort()).toEqual(['active', 'expired'])
  })
})

describe('scheduled automation', () => {
  const DAY = '2030-01-09' // a Wednesday with no holidays in the test database
  const T = { lateAfter: '10:00', earlyBefore: '18:00' }

  it('reminds only expected employees: not those on approved leave, already checked in, or not yet joined', async () => {
    const present = await as('employee')
    const missing = await as('employee')
    const onLeave = await as('employee')
    const notJoined = await as('employee')
    const now = new Date().toISOString()
    await db().batch([
      db().prepare(`INSERT INTO attendance_records (id, user_id, work_date, check_in_at, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'present', 'self', ?, ?)`).bind(newId('att'), present.id, DAY, `${DAY}T03:40:00.000Z`, now, now),
      db().prepare(`INSERT INTO leave_requests (id, user_id, leave_type_id, start_date, end_date, days, status, created_at, updated_at) VALUES (?, ?, 'lt_casual', ?, ?, 1, 'approved', ?, ?)`).bind(newId('lv'), onLeave.id, DAY, DAY, now, now),
      db().prepare(`UPDATE employee_profiles SET joining_date = '2030-02-01' WHERE user_id = ?`).bind(notJoined.id),
    ])
    await attendanceReminder(env, waiter, DAY, T)
    await attendanceReminder(env, waiter, DAY, T) // idempotent
    expect(await notes(missing.id, 'ATTENDANCE_REMINDER')).toHaveLength(1)
    for (const u of [present, onLeave, notJoined]) expect(await notes(u.id, 'ATTENDANCE_REMINDER')).toHaveLength(0)
    const hr = await as('hr_manager')
    await attendanceMissing(env, waiter, DAY, T)
    expect(await notes(missing.id, 'ATTENDANCE_MISSING')).toHaveLength(1)
    const report = await notes(hr.id, 'ATTENDANCE_MISSING_REPORT')
    expect(report).toHaveLength(1)
    // Missing attendance is never written as an absence.
    expect(await db().prepare('SELECT COUNT(*) AS n FROM attendance_records WHERE user_id = ? AND work_date = ?').bind(missing.id, DAY).first<any>()).toMatchObject({ n: 0 })
  })

  it('escalates long-overdue tasks to HR/Admin, then Super Admin for urgent work, once per cycle, and closes when resolved', async () => {
    const { admin, pm, dev, projectId } = await team()
    const hr = await as('hr_manager')
    const t = await call(pm.agent, 'POST', '/api/tasks', { projectId, title: 'Urgent fix', responsibleId: dev.id, priority: 'urgent', dueDate: '2030-01-01', requiresApproval: false })
    const esc = { taskOverdueHrAfterDays: 2, taskOverdueSuperAdminAfterDays: 5, superAdminPriorities: ['urgent', 'high'] }
    await escalateOverdueTasks(env, waiter, '2030-01-04', esc) // 3 days → level 2
    expect((await notes(hr.id, 'TASK_OVERDUE_ESCALATED')).filter((n) => n.entity_id === t.json.id)).toHaveLength(1)
    // Super Admin holds HR permissions, so it sees level 2 too (high), but not yet the critical level-3 notice.
    expect((await notes(admin.id, 'TASK_OVERDUE_ESCALATED')).filter((n) => n.entity_id === t.json.id).map((n) => n.priority)).toEqual(['high'])
    await escalateOverdueTasks(env, waiter, '2030-01-05', esc) // still level 2: no repeat
    expect((await notes(hr.id, 'TASK_OVERDUE_ESCALATED')).filter((n) => n.entity_id === t.json.id)).toHaveLength(1)
    await escalateOverdueTasks(env, waiter, '2030-01-07', esc) // 6 days, urgent → Super Admin
    const saNotes = (await notes(admin.id, 'TASK_OVERDUE_ESCALATED')).filter((n) => n.entity_id === t.json.id)
    expect(saNotes.map((n) => n.priority)).toEqual(['high', 'critical'])
    expect((await notes(hr.id, 'TASK_OVERDUE_ESCALATED')).filter((n) => n.entity_id === t.json.id)).toHaveLength(1)
    await call(dev.agent, 'POST', `/api/tasks/${t.json.id}/status`, { status: 'completed' })
    await escalateOverdueTasks(env, waiter, '2030-01-08', esc)
    const row = await db().prepare(`SELECT resolved_at FROM notification_escalations WHERE entity_id = ?`).bind(t.json.id).first<any>()
    expect(row.resolved_at).toBeTruthy()
  })

  it('runs each job slot at most once and only inside its window', async () => {
    let runs = 0
    const key = `test.job:${newId('k')}`
    await once(env, waiter, 'test.job', key, async () => ++runs)
    await once(env, waiter, 'test.job', key, async () => ++runs)
    expect(runs).toBe(1)
    expect(inSlot('09:45', '09:45')).toBe(true)
    expect(inSlot('10:44', '09:45')).toBe(true)
    expect(inSlot('10:45', '09:45')).toBe(false)
    expect(inSlot('09:44', '09:45')).toBe(false)
  })

  it('records failing jobs and alerts Super Admins', async () => {
    const admin = await as('super_admin')
    const key = `fail.job:${newId('k')}`
    const r = await once(env, waiter, 'fail.job', key, async () => {
      throw new Error('boom')
    })
    expect(r).toBeNull()
    const job = await db().prepare('SELECT status, error FROM notification_jobs WHERE run_key = ?').bind(key).first<any>()
    expect(job).toMatchObject({ status: 'failed', error: 'boom' })
    expect((await notes(admin.id, 'SYSTEM_JOB_FAILED')).some((n) => n.title.includes('fail.job'))).toBe(true)
  })
})

describe('communication timeline', () => {
  it('shows a task’s notification history to people who can read the task, and nobody else', async () => {
    const { dev, taskId } = await team()
    const outsider = await as('employee')
    const ok = await call(dev.agent, 'GET', `/api/notifications/timeline?entityType=task&entityId=${taskId}`)
    expect(ok.status).toBe(200)
    expect(ok.json.events.some((e: any) => e.event_key === 'TASK_ASSIGNED')).toBe(true)
    expect((await call(outsider.agent, 'GET', `/api/notifications/timeline?entityType=task&entityId=${taskId}`)).status).toBe(404)
  })
})
