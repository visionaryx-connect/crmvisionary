// Project, HR, client, calendar, file and security events → central engine. Routes call these after their writes.
// Keeping recipient logic here (not in route handlers) means every module follows the same routing rules.

import type { Env } from '../env'
import { PROJECT_STATUS_LABEL, type ProjectStatus } from '@shared/constants'
import { many, one } from '../lib/db'
import { notify, type NotificationInput } from './notify'
import { adminUsers, hrUsers, managerOf, projectTeam, superAdmins, uniq } from './notificationRouting'
import type { Waiter } from './realtime'

export interface Actor {
  userId: string
  name: string
}
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })

async function project(db: D1Database, id: string) {
  return one<{ id: string; reference: string; name: string; manager_id: string | null; status: string; progress: number; target_date: string | null; client_name: string }>(
    db,
    `SELECT p.id, p.reference, p.name, p.manager_id, p.status, p.progress, p.target_date, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?`,
    id,
  )
}
const pBase = (p: { id: string }, tab?: string) => ({ link: `/projects/${p.id}${tab ? `?tab=${tab}` : ''}`, entityType: 'project', entityId: p.id, projectId: p.id })
const pDetails = (p: { name: string; reference: string; client_name: string; progress: number; status: string }, extra: [string, string][] = []): [string, string][] => [
  ['Project', `${p.name} (${p.reference})`],
  ['Client', p.client_name],
  ['Progress', `${Math.round(p.progress)}%`],
  ['Status', PROJECT_STATUS_LABEL[p.status as ProjectStatus] ?? p.status],
  ...extra,
]

// ───────── Projects ─────────

export async function projectAssigned(env: Env, w: Waiter, projectId: string, actor: Actor, managerId: string) {
  const p = await project(env.DB, projectId)
  if (!p) return
  await notify(env, w, [{ userId: managerId, event: 'PROJECT_ASSIGNED', ...pBase(p), title: `You are managing ${p.reference} ${p.name}`, body: `Client: ${p.client_name}${p.target_date ? ` · target ${p.target_date}` : ''}`, email: { intro: `${actor.name} made you project manager.`, details: pDetails(p, [['Target date', p.target_date ?? 'Not set']]) } }], actor.userId, { actorName: actor.name })
}

export async function projectMemberChanged(env: Env, w: Waiter, projectId: string, actor: Actor, userId: string, added: boolean, role?: string, responsibility?: string) {
  const p = await project(env.DB, projectId)
  if (!p) return
  await notify(env, w, [{
    userId, event: added ? 'PROJECT_MEMBER_ADDED' : 'PROJECT_MEMBER_REMOVED', ...pBase(p),
    title: added ? `You were added to ${p.reference} ${p.name}` : `You were removed from ${p.reference} ${p.name}`,
    body: added ? `Role: ${role ?? 'member'}${responsibility ? ` · ${responsibility}` : ''}` : `By ${actor.name}`,
    email: added ? { intro: `${actor.name} added you to the project team.`, details: pDetails(p, [['Your role', role ?? 'member'], ...(responsibility ? ([['Responsibility', responsibility]] as [string, string][]) : [])]) } : undefined,
  }], actor.userId, { actorName: actor.name })
}

export async function projectChanged(env: Env, w: Waiter, projectId: string, actor: Actor, changes: Record<string, { from: unknown; to: unknown }>) {
  const p = await project(env.DB, projectId)
  if (!p) return
  const team = await projectTeam(env.DB, projectId)
  const items: NotificationInput[] = []
  if (changes.status) {
    const to = String(changes.status.to)
    const label = (s: unknown) => PROJECT_STATUS_LABEL[s as ProjectStatus] ?? String(s)
    const event = to === 'completed' || to === 'archived' ? ('PROJECT_COMPLETED' as const) : ('PROJECT_STATUS_CHANGED' as const)
    items.push(...team.map((u) => ({ userId: u, event, ...pBase(p), title: `${p.reference} ${p.name}: ${label(changes.status.from)} → ${label(to)}`, body: `By ${actor.name}`, email: { intro: `${actor.name} changed the project status.`, details: pDetails(p) } })))
  }
  if (changes.target_date) {
    items.push(...team.map((u) => ({ userId: u, event: 'PROJECT_DEADLINE_CHANGED' as const, ...pBase(p), title: `Project deadline changed: ${p.reference} ${p.name}`, body: `${changes.target_date.from ?? 'none'} → ${changes.target_date.to ?? 'none'}`, email: { intro: `${actor.name} changed the project's target date.`, details: pDetails(p, [['Previous target', String(changes.target_date.from ?? 'None')], ['New target', String(changes.target_date.to ?? 'None')]]) } })))
  }
  await notify(env, w, items, actor.userId, { actorName: actor.name })
  if (changes.manager_id?.to) await projectAssigned(env, w, projectId, actor, String(changes.manager_id.to))
}

/** Project update posted. Internal and client-visible updates both go to the internal team only — never to clients. */
export async function projectUpdatePosted(env: Env, w: Waiter, projectId: string, actor: Actor, update: { id: string; title: string; body: string; clientVisible: boolean }) {
  const p = await project(env.DB, projectId)
  if (!p) return
  const team = await projectTeam(env.DB, projectId)
  await notify(env, w, team.map((u) => ({
    userId: u, event: 'PROJECT_UPDATE_POSTED' as const, ...pBase(p, 'updates'), title: `${update.clientVisible ? 'Client update' : 'Project update'} – ${p.name}: ${update.title}`, body: update.body.slice(0, 200), dedupeKey: `pupdate:${update.id}`,
    email: { subject: `Project Update – ${p.name}`, intro: `${actor.name} posted ${update.clientVisible ? 'an update that is also visible to the client' : 'an internal update'}.`, details: pDetails(p, [['Updated by', actor.name], ['Visibility', update.clientVisible ? 'Client-visible' : 'Internal only']]), message: `${update.title}\n\n${update.body}`, outro: 'Please review the latest update in the CRM.', actionLabel: 'Open project' },
  })), actor.userId, { actorName: actor.name })
}

export async function projectUpdatePublished(env: Env, w: Waiter, projectId: string, actor: Actor, title: string) {
  const p = await project(env.DB, projectId)
  if (!p) return
  await notify(env, w, (await projectTeam(env.DB, projectId)).map((u) => ({ userId: u, event: 'PROJECT_UPDATE_PUBLISHED' as const, ...pBase(p, 'updates'), title: `Shared with the client: ${title}`, body: `${p.reference} · by ${actor.name}` })), actor.userId)
}

export async function milestoneChanged(env: Env, w: Waiter, projectId: string, actor: Actor | null, m: { id: string; title: string; status: string; created?: boolean; due?: string | null }) {
  const p = await project(env.DB, projectId)
  if (!p) return
  const team = await projectTeam(env.DB, projectId)
  const event = m.created ? ('MILESTONE_CREATED' as const) : m.status === 'achieved' ? ('MILESTONE_COMPLETED' as const) : ('MILESTONE_UPDATED' as const)
  const title = m.created ? `New milestone: ${m.title}` : m.status === 'achieved' ? `Milestone achieved: ${m.title}` : `Milestone ${m.status.replace('_', ' ')}: ${m.title}`
  await notify(env, w, team.map((u) => ({
    userId: u, event, ...pBase(p, 'milestones'), title, body: `${p.reference} ${p.name}${m.due ? ` · due ${m.due}` : ''}`, dedupeKey: `ms:${m.id}:${m.created ? 'created' : m.status}`,
    email: { intro: m.status === 'achieved' ? 'A project milestone has been completed.' : `A milestone changed${actor ? ` (by ${actor.name})` : ''}.`, details: pDetails(p, [['Milestone', m.title], ['Milestone status', m.status.replace('_', ' ')]]) },
  })), actor?.userId, { actorName: actor?.name })
}

// ───────── HR & employees ─────────

/** Profile changes by HR → the employee (and old / new managers for reporting-line changes). */
export async function employeeChanged(env: Env, w: Waiter, userId: string, actor: Actor, changes: Record<string, { from: unknown; to: unknown }>) {
  const person = await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', userId)
  if (!person || Object.keys(changes).length === 0) return
  const items: NotificationInput[] = []
  const link = `/team/${userId}`
  if (changes.department_id) {
    const dep = changes.department_id.to ? await one<{ name: string }>(env.DB, 'SELECT name FROM departments WHERE id = ?', changes.department_id.to) : null
    items.push({ userId, event: 'EMPLOYEE_DEPARTMENT_CHANGED', link, title: `Your department is now ${dep?.name ?? 'unassigned'}`, body: `Updated by ${actor.name}`, dedupeKey: `dept:${userId}:${changes.department_id.to ?? 'none'}` })
    const head = changes.department_id.to ? await one<{ head_user_id: string | null }>(env.DB, 'SELECT head_user_id FROM departments WHERE id = ?', changes.department_id.to) : null
    if (head?.head_user_id && head.head_user_id !== userId) items.push({ userId: head.head_user_id, event: 'EMPLOYEE_DEPARTMENT_CHANGED', link, title: `${person.name} joined ${dep?.name ?? 'your department'}`, dedupeKey: `dept-head:${userId}:${changes.department_id.to}` })
  }
  if (changes.designation) items.push({ userId, event: 'EMPLOYEE_DESIGNATION_CHANGED', link, title: `Your designation is now ${changes.designation.to || '—'}`, body: `Previously ${changes.designation.from || '—'}`, dedupeKey: `desig:${userId}:${changes.designation.to}` })
  if (changes.manager_user_id) {
    const mgr = changes.manager_user_id.to ? await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', changes.manager_user_id.to) : null
    items.push({ userId, event: 'EMPLOYEE_MANAGER_CHANGED', link, title: `Your reporting manager is now ${mgr?.name ?? 'not set'}`, dedupeKey: `mgr:${userId}:${changes.manager_user_id.to ?? 'none'}` })
    if (changes.manager_user_id.to) items.push({ userId: String(changes.manager_user_id.to), event: 'EMPLOYEE_MANAGER_CHANGED', link, title: `${person.name} now reports to you`, dedupeKey: `mgr-new:${userId}:${changes.manager_user_id.to}` })
    if (changes.manager_user_id.from) items.push({ userId: String(changes.manager_user_id.from), event: 'EMPLOYEE_MANAGER_CHANGED', link, title: `${person.name} no longer reports to you`, dedupeKey: `mgr-old:${userId}:${changes.manager_user_id.from}` })
  }
  const other = Object.keys(changes).filter((k) => !['department_id', 'designation', 'manager_user_id'].includes(k))
  if (other.length) items.push({ userId, event: 'EMPLOYEE_PROFILE_UPDATED', link, title: 'Your employee profile was updated', body: `By ${actor.name}` })
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

export async function employeeCreated(env: Env, w: Waiter, userId: string, actor: Actor) {
  const u = await one<{ name: string; email: string }>(env.DB, 'SELECT name, email FROM users WHERE id = ?', userId)
  if (!u) return
  const hr = await hrUsers(env.DB)
  await notify(env, w, hr.map((h) => ({ userId: h, event: 'EMPLOYEE_CREATED' as const, link: `/team/${userId}`, entityType: 'user', entityId: userId, title: `New employee account: ${u.name}`, body: `Created by ${actor.name}. Complete the employee profile.` })), actor.userId)
}

export async function accountStatusChanged(env: Env, w: Waiter, userId: string, actor: Actor, status: string) {
  const u = await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', userId)
  if (!u) return
  const recipients = uniq([...(await hrUsers(env.DB)), ...(await superAdmins(env.DB))])
  await notify(env, w, recipients.map((r) => ({ userId: r, event: 'EMPLOYEE_ACCOUNT_STATUS' as const, link: `/admin/users?focus=${userId}`, entityType: 'user', entityId: userId, title: `${u.name}'s account was ${status === 'deactivated' ? 'deactivated' : 'reactivated'}`, body: `By ${actor.name}` })), actor.userId)
}

// ───────── Leave & attendance ─────────

export async function leaveRequested(env: Env, w: Waiter, leaveId: string, actor: Actor, approvers: string[], summary: string) {
  await notify(env, w, approvers.map((u) => ({
    userId: u, event: 'LEAVE_REQUESTED' as const, title: `${actor.name} requested leave`, body: summary, link: '/hr/leave?tab=approvals', entityType: 'leave_request', entityId: leaveId,
    email: { intro: `${actor.name} has requested leave and is waiting for a decision.`, details: [['Employee', actor.name], ['Request', summary]], actionLabel: 'Review request' },
  })), actor.userId, { actorName: actor.name })
}

export async function leaveDecided(env: Env, w: Waiter, leaveId: string, actor: Actor, employeeId: string, decision: 'approved' | 'rejected', range: string, typeName: string, note: string) {
  const items: NotificationInput[] = [{
    userId: employeeId, event: decision === 'approved' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED', title: `Leave ${decision}: ${range}`, body: note, link: '/hr/leave', entityType: 'leave_request', entityId: leaveId,
    email: { intro: `Your ${typeName} request was ${decision} by ${actor.name}.`, details: [['Dates', range], ['Type', typeName], ['Decision', decision]], message: note },
  }]
  // Keep the other approvers in the loop so nobody acts on a decided request.
  const mgr = await managerOf(env.DB, employeeId)
  const hr = await hrUsers(env.DB)
  const emp = await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', employeeId)
  items.push(...uniq([mgr, ...hr]).filter((u) => u !== employeeId).map((u) => ({ userId: u, event: decision === 'approved' ? ('LEAVE_APPROVED' as const) : ('LEAVE_REJECTED' as const), channels: ['in_app' as const], title: `${emp?.name ?? 'Leave'}: ${typeName} ${range} ${decision}`, body: `By ${actor.name}`, link: '/hr/leave?tab=approvals', entityType: 'leave_request', entityId: leaveId })))
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

export async function leaveCancelled(env: Env, w: Waiter, leaveId: string, actor: Actor, employeeId: string, range: string, wasApproved: boolean) {
  const emp = await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', employeeId)
  const recipients = uniq([await managerOf(env.DB, employeeId), ...(await hrUsers(env.DB)), ...(actor.userId !== employeeId ? [employeeId] : [])])
  await notify(env, w, recipients.map((u) => ({ userId: u, event: 'LEAVE_CANCELLED' as const, title: `${u === employeeId ? 'Your' : `${emp?.name ?? 'An employee'}'s`} ${wasApproved ? 'approved ' : ''}leave ${range} was cancelled`, body: `By ${actor.name}`, link: '/hr/leave', entityType: 'leave_request', entityId: leaveId })), actor.userId)
}

// ───────── Clients ─────────

export async function clientChanged(env: Env, w: Waiter, clientId: string, actor: Actor, opts: { created?: boolean; changes?: Record<string, { from: unknown; to: unknown }> }) {
  const cl = await one<{ name: string; reference: string; account_manager_id: string | null; status: string }>(env.DB, 'SELECT name, reference, account_manager_id, status FROM clients WHERE id = ?', clientId)
  if (!cl) return
  const link = `/clients/${clientId}`
  const items: NotificationInput[] = []
  if (opts.created) items.push(...(await adminUsers(env.DB)).map((u) => ({ userId: u, event: 'CLIENT_CREATED' as const, link, entityType: 'client', entityId: clientId, title: `New ${cl.status === 'lead' ? 'enquiry / lead' : 'client'}: ${cl.name}`, body: `${cl.reference} · added by ${actor.name}` })))
  const newManager = opts.created ? cl.account_manager_id : opts.changes?.account_manager_id?.to
  if (newManager) items.push({ userId: String(newManager), event: 'CLIENT_ASSIGNED', link, entityType: 'client', entityId: clientId, title: `You are account manager for ${cl.name}`, body: `${cl.reference} · assigned by ${actor.name}`, email: { intro: `${actor.name} assigned a client to you.`, details: [['Client', cl.name], ['Reference', cl.reference], ['Status', cl.status]] } })
  if (opts.changes?.status && cl.account_manager_id) items.push({ userId: cl.account_manager_id, event: 'CLIENT_STATUS_CHANGED', link, entityType: 'client', entityId: clientId, title: `${cl.name}: ${opts.changes.status.from} → ${opts.changes.status.to}`, body: `By ${actor.name}` })
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

export async function clientInteraction(env: Env, w: Waiter, clientId: string, actor: Actor, kind: string, subject: string) {
  const cl = await one<{ name: string; account_manager_id: string | null }>(env.DB, 'SELECT name, account_manager_id FROM clients WHERE id = ?', clientId)
  if (!cl?.account_manager_id) return
  await notify(env, w, [{ userId: cl.account_manager_id, event: 'CLIENT_INTERACTION_LOGGED', link: `/clients/${clientId}`, entityType: 'client', entityId: clientId, title: `${actor.name} logged a ${kind} with ${cl.name}`, body: subject }], actor.userId)
}

// ───────── Calendar ─────────

export async function meetingNotice(env: Env, w: Waiter, eventId: string, actor: Actor, kind: 'invited' | 'updated' | 'cancelled' | 'removed', userIds: string[], ev: { title: string; startAt: string; location?: string | null; changed?: string[] }) {
  const map = { invited: 'MEETING_INVITATION', updated: 'MEETING_UPDATED', cancelled: 'MEETING_CANCELLED', removed: 'MEETING_ATTENDEE_REMOVED' } as const
  const title = { invited: `Invitation: ${ev.title}`, updated: `${ev.changed?.includes('time') ? 'Rescheduled' : 'Updated'}: ${ev.title}`, cancelled: `Cancelled: ${ev.title}`, removed: `Removed from: ${ev.title}` }[kind]
  await notify(env, w, userIds.map((u) => ({
    userId: u, event: map[kind], title, body: fmtWhen(ev.startAt) + (ev.location ? ` · ${ev.location}` : ''), link: kind === 'cancelled' || kind === 'removed' ? '/calendar' : `/calendar?event=${eventId}`, entityType: 'calendar_event', entityId: eventId,
    dedupeKey: kind === 'invited' ? `meet-invite:${eventId}` : undefined,
    email: { intro: { invited: `${actor.name} invited you.`, updated: `${actor.name} changed this meeting.`, cancelled: `${actor.name} cancelled this meeting.`, removed: `${actor.name} removed you from this meeting.` }[kind], details: [['Meeting', ev.title], ['When', fmtWhen(ev.startAt)], ...(ev.location ? ([['Where', ev.location]] as [string, string][]) : []), ['Organiser', actor.name]] },
  })), actor.userId, { actorName: actor.name })
}

// ───────── Files & deliverables ─────────

export async function deliverableNotice(env: Env, w: Waiter, deliverableId: string, actor: Actor, kind: 'submitted' | 'approved' | 'returned' | 'shared', recipients: string[], note?: string) {
  const d = await one<{ title: string; project_id: string; reference: string; name: string }>(env.DB, 'SELECT d.title, d.project_id, p.reference, p.name FROM deliverables d JOIN projects p ON p.id = d.project_id WHERE d.id = ?', deliverableId)
  if (!d) return
  const event = { submitted: 'DELIVERABLE_SUBMITTED', approved: 'DELIVERABLE_APPROVED', returned: 'DELIVERABLE_RETURNED', shared: 'DELIVERABLE_SHARED' } as const
  const title = { submitted: `Deliverable ready for review: ${d.title}`, approved: `Approved: ${d.title}`, returned: `Returned to draft: ${d.title}`, shared: `Shared with the client: ${d.title}` }[kind]
  await notify(env, w, recipients.map((u) => ({ userId: u, event: event[kind], title, body: note || `${d.reference} ${d.name}`, link: `/projects/${d.project_id}?tab=deliverables`, entityType: 'deliverable', entityId: deliverableId, projectId: d.project_id, email: { details: [['Deliverable', d.title], ['Project', `${d.name} (${d.reference})`], ['By', actor.name]], message: note ?? '' } })), actor.userId, { actorName: actor.name })
}

// ───────── Security ─────────

export async function securityNotice(env: Env, w: Waiter, userId: string, event: 'SECURITY_PASSWORD_CHANGED' | 'SECURITY_NEW_LOGIN' | 'SECURITY_MFA_CHANGED' | 'SECURITY_ROLE_CHANGED', title: string, body: string, details: [string, string][] = []) {
  await notify(env, w, [{ userId, event, title, body, link: '/account', email: { intro: body, details, outro: 'If this was not you, contact an administrator immediately and change your password.', actionLabel: 'Review account security' } }])
}

export async function notifySuperAdmins(env: Env, w: Waiter, actor: Actor | null, event: 'SECURITY_ADMIN_ADDED' | 'SECURITY_ROLE_PERMISSIONS_CHANGED' | 'SECURITY_SETTINGS_CHANGED', title: string, body: string, link: string, dedupeKey?: string) {
  const sa = await superAdmins(env.DB)
  await notify(env, w, sa.map((u) => ({ userId: u, event, title, body, link, dedupeKey })), actor?.userId)
}

/** Has this user signed in from this browser before (same user agent on a previous session)? */
export async function isNewDevice(db: D1Database, userId: string, userAgent: string | null, exceptSessionId?: string): Promise<boolean> {
  if (!userAgent) return false
  const prior = await many<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND user_agent = ? AND id <> ?', userId, userAgent, exceptSessionId ?? '')
  const any = await many<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId ?? '')
  // The very first sign-in is not "new device" noise.
  return (any[0]?.n ?? 0) > 0 && (prior[0]?.n ?? 0) === 0
}
