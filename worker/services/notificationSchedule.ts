// The notification scheduler. Runs every 5 minutes (Cron Trigger "*/5 * * * *").
//
// Time-of-day jobs (attendance slots, digests, reports) run once per local day per slot: each run claims a row in
// notification_jobs with a unique run key, so overlapping or repeated cron invocations can never double-send. A slot
// only fires within SLOT_WINDOW_MIN after its configured time — after a deploy or outage we do not send a 09:45
// reminder at 15:00. Every run is recorded (completed / failed / skipped) and failures alert Super Admins.

import type { Env } from '../env'
import { addDays, diffDays, localDate, localDateTimeToUtc } from '@shared/dates'
import { expandOccurrences } from '@shared/recurrence'
import { classifyDay } from '@shared/workdays'
import { newId } from '../lib/crypto'
import { many, nowIso, one } from '../lib/db'
import {
  attendanceSections, attendanceSnapshot, dailyTaskDigests, monthlySections, operationsSections, weeklyEmployeeDigests, weeklySections,
} from './notificationDigest'
import { sendDueBroadcasts } from './notificationBroadcast'
import { processDeliveries } from './notificationQueue'
import { hrUsers, superAdmins, uniq, usersWithRoles, adminUsers } from './notificationRouting'
import { notify, type NotificationInput } from './notify'
import type { Waiter } from './realtime'
import { getDayOffSource, getSetting, getWorkweek } from './settings'

export const SLOT_WINDOW_MIN = 60

function localHm(at: Date, tz: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}
const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5))
/** Is `now` (HH:MM) inside [slot, slot + window)? */
export const inSlot = (now: string, slot: string, window = SLOT_WINDOW_MIN) => minutes(now) >= minutes(slot) && minutes(now) < minutes(slot) + window

/** Run `fn` at most once for `runKey`. Returns null when it already ran (or is running). */
export async function once<T>(env: Env, waiter: Waiter, jobKey: string, runKey: string, fn: () => Promise<T>): Promise<T | null> {
  const id = newId('njb')
  const claimed = await one<{ id: string }>(env.DB, `INSERT INTO notification_jobs (id, job_key, run_key, status, started_at) VALUES (?, ?, ?, 'running', ?) ON CONFLICT(run_key) DO NOTHING RETURNING id`, id, jobKey, runKey, nowIso())
  if (!claimed) return null
  try {
    const result = await fn()
    await env.DB.prepare(`UPDATE notification_jobs SET status = 'completed', detail = ?, finished_at = ? WHERE id = ?`).bind(JSON.stringify(result ?? null).slice(0, 2000), nowIso(), id).run()
    return result
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}` : String(err)
    console.error(`notification job ${jobKey} failed`, err)
    await env.DB.prepare(`UPDATE notification_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).bind(msg.slice(0, 1000), nowIso(), id).run()
    const admins = await superAdmins(env.DB)
    await notify(env, waiter, admins.map((u) => ({ userId: u, event: 'SYSTEM_JOB_FAILED' as const, title: `Scheduled job failed: ${jobKey}`, body: msg.slice(0, 300), link: '/admin/notifications?tab=jobs', dedupeKey: `job-failed:${runKey}` })))
    return null
  }
}

export interface TickResult {
  jobs: string[]
  deliveries?: unknown
}

export async function runNotificationTick(env: Env, waiter: Waiter, at: Date = new Date()): Promise<TickResult> {
  const tz = env.COMPANY_TIMEZONE || 'Asia/Kolkata'
  const today = localDate(at, tz)
  const hm = localHm(at, tz)
  const sched = await getSetting(env.DB, 'notifications.schedule')
  const esc = await getSetting(env.DB, 'notifications.escalation')
  const hours = await getSetting(env.DB, 'workdays.hours')
  const ww = await getWorkweek(env.DB)
  const day = classifyDay(today, ww, await getDayOffSource(env.DB, today, today))
  const ran: string[] = []
  const job = async (key: string, slot: string, fn: () => Promise<unknown>, cond = true) => {
    if (!cond || !inSlot(hm, slot)) return
    const r = await once(env, waiter, key, `${key}:${today}`, fn)
    if (r !== null) ran.push(key)
  }
  const att = sched.attendance
  const thresholds = { lateAfter: att.lateAfter, earlyBefore: att.earlyBefore }

  // ── Attendance (working days only)
  if (att.enabled && day.working) {
    await job('attendance.reminder', att.reminder, () => attendanceReminder(env, waiter, today, thresholds))
    await job('attendance.late', att.late, () => attendanceLate(env, waiter, today, thresholds))
    await job('attendance.missing', att.missing, () => attendanceMissing(env, waiter, today, thresholds))
    await job('attendance.exceptions', att.exceptions, () => attendanceExceptions(env, waiter, today, thresholds))
    await job('attendance.checkout_reminder', att.checkoutReminder, () => checkoutReminder(env, waiter, today, thresholds))
    await job('attendance.missing_checkout', att.missingCheckout, () => missingCheckout(env, waiter, today, thresholds))
  }
  // ── Daily reports (HR / Admin / Super Admin), including the attendance summary
  await job('reports.daily', att.summary, () => dailyReports(env, waiter, today, thresholds, sched.reports.recipients), sched.reports.daily && day.working)

  // ── Tasks
  await job('tasks.daily_digest', sched.tasks.dailyDigestTime, () => dailyDigest(env, waiter, today), sched.tasks.dailyDigest && day.working)
  await job('tasks.deadline_today', sched.tasks.dailyDigestTime, () => deadlineToday(env, waiter, today), sched.tasks.remindToday)
  const dayEnd = hours.dayEnd
  const minus = (hhmm: string, m: number) => {
    const t = Math.max(0, minutes(hhmm) - m)
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  }
  await job('tasks.deadline_2h', minus(dayEnd, 120), () => deadlineHours(env, waiter, today, '2h', dayEnd), sched.tasks.remind2h)
  await job('tasks.deadline_30m', minus(dayEnd, 30), () => deadlineHours(env, waiter, today, '30m', dayEnd), sched.tasks.remind30m)
  await job('escalation.tasks', '10:30', () => escalateOverdueTasks(env, waiter, today, esc))

  // ── HR
  await job('hr.leave_reminders', sched.hr.time, () => leaveReminders(env, waiter, today), sched.hr.leaveReminders)
  await job('hr.celebrations', sched.hr.time, () => celebrations(env, waiter, today), sched.hr.celebrations)

  // ── Weekly / monthly
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  await job('reports.weekly', sched.reports.weeklyTime, () => weeklyReports(env, waiter, today, esc, sched.reports.recipients.weekly), sched.reports.weekly && weekday === sched.reports.weeklyDay)
  await job('reports.monthly', sched.reports.monthlyTime, () => monthlyReports(env, waiter, today, sched.reports.recipients.monthly), sched.reports.monthly && today.endsWith('-01'))

  // ── Retention (once a day, early morning)
  await job('housekeeping.notifications', '03:00', () => notificationRetention(env, at))

  // ── Every tick
  const meetings = await meetingReminders(env, waiter, at, sched.meetings.defaultReminderMinutes)
  const broadcasts = await sendDueBroadcasts(env, waiter, at)
  const acks = await ackEscalations(env, waiter, at, esc)
  if (meetings) ran.push(`meetings:${meetings}`)
  if (broadcasts) ran.push(`broadcasts:${broadcasts}`)
  if (acks) ran.push(`ack:${acks}`)
  const deliveries = await processDeliveries(env, waiter, { now: at, limit: 100 })
  return { jobs: ran, deliveries }
}

// ───────── Attendance jobs ─────────

type Thresholds = { lateAfter: string; earlyBefore: string }
const names = (list: { name: string }[], max = 12) => list.slice(0, max).map((x) => x.name).join(', ') + (list.length > max ? ` and ${list.length - max} more` : '')

export async function attendanceReminder(env: Env, waiter: Waiter, date: string, t: Thresholds) {
  const s = await attendanceSnapshot(env.DB, date, t)
  const targets = s.missing.filter((m) => s.leaveHalf.get(m.id) !== 'first_half')
  await notify(env, waiter, targets.map((m) => ({ userId: m.id, event: 'ATTENDANCE_REMINDER' as const, title: 'Please check in for today', body: `Record your attendance for ${date}. Check-ins after ${t.lateAfter} count as late.`, link: '/hr/attendance', dedupeKey: `att-reminder:${date}` })))
  return { reminded: targets.length }
}

export async function attendanceLate(env: Env, waiter: Waiter, date: string, t: Thresholds) {
  const s = await attendanceSnapshot(env.DB, date, t)
  const notIn = s.missing.filter((m) => s.leaveHalf.get(m.id) !== 'first_half')
  const hr = await hrUsers(env.DB)
  const items: NotificationInput[] = notIn.map((m) => ({ userId: m.id, event: 'ATTENDANCE_LATE', title: 'You have not checked in yet', body: `It is past ${t.lateAfter}. Check in now, or ask HR for a correction if you are on duty elsewhere.`, link: '/hr/attendance', dedupeKey: `att-late:${date}` }))
  if (s.late.length || notIn.length) {
    items.push(...hr.map((u) => ({
      userId: u, event: 'ATTENDANCE_LATE' as const, title: `Late detection ${date}: ${s.late.length} late, ${notIn.length} not checked in`,
      body: [s.late.length ? `Late: ${names(s.late)}` : '', notIn.length ? `Not in: ${names(notIn)}` : ''].filter(Boolean).join(' · '),
      link: `/hr/attendance?month=${date.slice(0, 7)}`, dedupeKey: `att-late-hr:${date}`,
    })))
  }
  await notify(env, waiter, items)
  return { late: s.late.length, notIn: notIn.length }
}

export async function attendanceMissing(env: Env, waiter: Waiter, date: string, t: Thresholds) {
  const s = await attendanceSnapshot(env.DB, date, t)
  const missing = s.missing.filter((m) => s.leaveHalf.get(m.id) !== 'first_half')
  const hr = await hrUsers(env.DB)
  const items: NotificationInput[] = missing.map((m) => ({
    userId: m.id, event: 'ATTENDANCE_MISSING', title: `No attendance recorded for ${date}`,
    body: 'Check in now. If you were working, request an attendance correction so HR can update your record.', link: '/hr/attendance', dedupeKey: `att-missing:${date}`,
    email: { intro: `We have no check-in from you for ${date}. This is not recorded as an absence; HR applies the attendance rules.`, details: [['Date', date], ['Late after', t.lateAfter]], actionLabel: 'Open attendance' },
  }))
  if (missing.length) {
    items.push(...hr.map((u) => ({
      userId: u, event: 'ATTENDANCE_MISSING_REPORT' as const, title: `Missing attendance ${date}: ${missing.length} employee(s)`, body: names(missing),
      link: `/hr/attendance?month=${date.slice(0, 7)}`, dedupeKey: `att-missing-report:${date}`,
      email: { intro: `${missing.length} employee(s) expected today have no check-in. Approved leave, holidays and weekends are already excluded.`, sections: [{ title: 'No check-in', items: missing.map((m) => `${m.name}${m.department ? ` · ${m.department}` : ''}`) }] },
    })))
  }
  await notify(env, waiter, items)
  return { missing: missing.length }
}

export async function attendanceExceptions(env: Env, waiter: Waiter, date: string, t: Thresholds) {
  const s = await attendanceSnapshot(env.DB, date, t)
  if (s.missing.length === 0 && s.late.length === 0) return { exceptions: 0 }
  const recipients = uniq([...(await hrUsers(env.DB)), ...(await adminUsers(env.DB)), ...(await superAdmins(env.DB))])
  await notify(env, waiter, recipients.map((u) => ({
    userId: u, event: 'ATTENDANCE_EXCEPTION_REPORT' as const, title: `Attendance exceptions ${date}: ${s.missing.length} missing, ${s.late.length} late`,
    body: [s.missing.length ? `Missing: ${names(s.missing)}` : '', s.late.length ? `Late: ${names(s.late)}` : ''].filter(Boolean).join(' · '),
    link: `/hr/attendance?month=${date.slice(0, 7)}`, dedupeKey: `att-exceptions:${date}`,
    email: { intro: 'Midday attendance exceptions.', sections: attendanceSections(s) },
  })))
  return { exceptions: s.missing.length + s.late.length }
}

export async function checkoutReminder(env: Env, waiter: Waiter, date: string, t: Thresholds) {
  const s = await attendanceSnapshot(env.DB, date, t)
  const targets = s.missingCheckout.filter((m) => s.leaveHalf.get(m.id) !== 'second_half')
  await notify(env, waiter, targets.map((m) => ({ userId: m.id, event: 'ATTENDANCE_CHECKOUT_REMINDER' as const, title: 'Remember to check out', body: 'Record your checkout before you leave so your working hours are complete.', link: '/hr/attendance', dedupeKey: `att-checkout-rem:${date}` })))
  return { reminded: targets.length }
}

export async function missingCheckout(env: Env, waiter: Waiter, date: string, t: Thresholds) {
  const s = await attendanceSnapshot(env.DB, date, t)
  const targets = s.missingCheckout.filter((m) => s.leaveHalf.get(m.id) !== 'second_half')
  const hr = await hrUsers(env.DB)
  const items: NotificationInput[] = targets.map((m) => ({ userId: m.id, event: 'ATTENDANCE_MISSING_CHECKOUT', title: `No checkout recorded for ${date}`, body: 'Check out now, or request a correction with your actual time.', link: '/hr/attendance', dedupeKey: `att-missing-checkout:${date}` }))
  if (targets.length) items.push(...hr.map((u) => ({ userId: u, event: 'ATTENDANCE_MISSING_CHECKOUT' as const, title: `Missing checkout ${date}: ${targets.length} employee(s)`, body: names(targets), link: `/hr/attendance?month=${date.slice(0, 7)}`, dedupeKey: `att-missing-checkout-hr:${date}` })))
  await notify(env, waiter, items)
  return { missingCheckout: targets.length }
}

// ───────── Daily reports & digests ─────────

export async function dailyReports(env: Env, waiter: Waiter, date: string, t: Thresholds, recipients: { dailyHr: string[]; dailyAdmin: string[]; dailySuperAdmin: string[] }) {
  const s = await attendanceSnapshot(env.DB, date, t)
  const att = attendanceSections(s, { includeCheckout: true })
  // One report per person: someone holding several roles gets the most complete one (super admin > admin > HR).
  const sends: [string[], 'DAILY_HR_REPORT' | 'DAILY_ADMIN_REPORT' | 'DAILY_SUPER_ADMIN_REPORT', 'hr' | 'admin' | 'super_admin', string][] = [
    [recipients.dailySuperAdmin, 'DAILY_SUPER_ADMIN_REPORT', 'super_admin', 'Daily company report'],
    [recipients.dailyAdmin, 'DAILY_ADMIN_REPORT', 'admin', 'Daily operations report'],
    [recipients.dailyHr, 'DAILY_HR_REPORT', 'hr', 'Daily HR report'],
  ]
  const counts: Record<string, number> = {}
  const already = new Set<string>()
  for (const [roles, event, scope, label] of sends) {
    const users = (await usersWithRoles(env.DB, roles)).filter((u) => !already.has(u))
    users.forEach((u) => already.add(u))
    if (users.length === 0) continue
    const ops = await operationsSections(env.DB, date, scope)
    const sections = scope === 'admin' ? [att[0], ...ops] : [...att, ...ops]
    await notify(env, waiter, users.map((u) => ({
      userId: u, event, title: `${label} — ${date}`,
      body: `${s.present.length}/${s.expected.length} checked in · ${s.missing.length} missing · ${s.late.length} late · ${s.missingCheckout.length} missing checkout`,
      link: scope === 'hr' ? `/hr/attendance?month=${date.slice(0, 7)}` : '/reports', dedupeKey: `${event}:${date}`,
      email: { subject: `${label} — ${date}`, intro: `Here is the summary for ${date}.`, sections, actionLabel: 'Open reports' },
    })))
    counts[event] = users.length
  }
  return counts
}

export async function dailyDigest(env: Env, waiter: Waiter, date: string) {
  const users = await many<{ id: string }>(
    env.DB,
    `SELECT u.id FROM users u LEFT JOIN notification_user_settings s ON s.user_id = u.id WHERE u.status = 'active' AND COALESCE(s.daily_digest, 1) = 1`,
  )
  const digests = await dailyTaskDigests(env.DB, date, users.map((u) => u.id))
  await notify(env, waiter, digests.map((d) => ({
    userId: d.userId, event: 'DAILY_TASK_DIGEST' as const, title: `Your tasks today: ${d.counts.dueToday} due, ${d.counts.overdue} overdue, ${d.counts.inProgress} in progress`,
    body: `${d.counts.pending} to do · ${d.counts.inReview} awaiting review · ${d.counts.upcoming} due soon${d.counts.toReview ? ` · ${d.counts.toReview} waiting for your review` : ''}`,
    link: '/today', dedupeKey: `digest:${date}`,
    email: { subject: `Your tasks for ${date}`, intro: 'Here is your daily task summary.', sections: d.sections, actionLabel: "Open today's tasks" },
  })))
  return { digests: digests.length }
}

// ───────── Task deadlines & escalation ─────────

interface DueTask { id: string; number: number; title: string; reference: string; project_id: string; responsible_id: string; priority: string; due_date: string; manager_id: string | null }

async function openTasksDue(db: D1Database, where: string, ...params: unknown[]) {
  return many<DueTask>(
    db,
    `SELECT t.id, t.number, t.title, p.reference, t.project_id, t.responsible_id, t.priority, t.due_date, p.manager_id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.responsible_id IS NOT NULL AND t.status IN ('backlog','todo','in_progress','blocked') AND p.archived_at IS NULL AND ${where}`,
    ...params,
  )
}

export async function deadlineToday(env: Env, waiter: Waiter, today: string) {
  const due = await openTasksDue(env.DB, 't.due_date = ?', today)
  await notify(env, waiter, due.map((t) => ({
    userId: t.responsible_id, event: 'TASK_DEADLINE_TODAY' as const, title: `Due today: ${t.reference}-${t.number} ${t.title}`, link: `/tasks/${t.id}`,
    entityType: 'task', entityId: t.id, projectId: t.project_id, dedupeKey: `due-today:${t.id}:${today}`,
    email: { details: [['Task', `#${t.number} ${t.title}`], ['Project', t.reference], ['Priority', t.priority], ['Due', today]] },
  })))
  return { due: due.length }
}

export async function deadlineHours(env: Env, waiter: Waiter, today: string, which: '2h' | '30m', dayEnd: string) {
  const due = await openTasksDue(env.DB, 't.due_date = ?', today)
  const label = which === '2h' ? '2 hours' : '30 minutes'
  await notify(env, waiter, due.map((t) => ({
    userId: t.responsible_id, event: which === '2h' ? ('TASK_DEADLINE_2H' as const) : ('TASK_DEADLINE_30M' as const),
    title: `Due in ${label}: ${t.reference}-${t.number} ${t.title}`, body: `Deadline is the end of today's working day (${dayEnd}).`, link: `/tasks/${t.id}`,
    entityType: 'task', entityId: t.id, projectId: t.project_id, dedupeKey: `due-${which}:${t.id}:${today}`,
  })))
  return { due: due.length, deadline: localDateTimeToUtc(today, dayEnd) }
}

/**
 * Overdue escalation, once a day. Level 1 (employee + project manager) is the daily overdue notice; this adds:
 *   level 2 → HR and Admin after `taskOverdueHrAfterDays` days overdue,
 *   level 3 → Super Admin after `taskOverdueSuperAdminAfterDays` for the configured priorities.
 * State lives in notification_escalations keyed by task + due date, so moving the deadline starts a new cycle and a
 * resolved task (completed, cancelled, re-dated) is closed and never escalated again.
 */
export async function escalateOverdueTasks(env: Env, waiter: Waiter, today: string, esc: { taskOverdueHrAfterDays: number; taskOverdueSuperAdminAfterDays: number; superAdminPriorities: string[] }) {
  const overdue = await openTasksDue(env.DB, 't.due_date < ?', today)
  const nowS = nowIso()
  const open = await many<{ id: string; entity_id: string; cycle_key: string; level: number; history: string }>(env.DB, `SELECT id, entity_id, cycle_key, level, history FROM notification_escalations WHERE rule_key = 'task_overdue' AND resolved_at IS NULL`)
  const still = new Set(overdue.map((t) => `${t.id}|${t.due_date}`))
  const resolved = open.filter((e) => !still.has(`${e.entity_id}|${e.cycle_key}`))
  for (const e of resolved) await env.DB.prepare('UPDATE notification_escalations SET resolved_at = ?, updated_at = ? WHERE id = ?').bind(nowS, nowS, e.id).run()
  const hrAdmin = esc.taskOverdueHrAfterDays > 0 ? uniq([...(await hrUsers(env.DB)), ...(await adminUsers(env.DB))]) : []
  const sa = esc.taskOverdueSuperAdminAfterDays > 0 ? await superAdmins(env.DB) : []
  const openMap = new Map(open.map((e) => [`${e.entity_id}|${e.cycle_key}`, e]))
  let escalated = 0
  for (const t of overdue) {
    const days = diffDays(t.due_date, today)
    let target = 0
    if (esc.taskOverdueHrAfterDays > 0 && days >= esc.taskOverdueHrAfterDays) target = 2
    if (esc.taskOverdueSuperAdminAfterDays > 0 && days >= esc.taskOverdueSuperAdminAfterDays && esc.superAdminPriorities.includes(t.priority)) target = 3
    const cur = openMap.get(`${t.id}|${t.due_date}`)
    if (target === 0 || (cur && cur.level >= target)) continue
    const recipients = target === 3 ? sa : hrAdmin
    const owner = await one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', t.responsible_id)
    await notify(env, waiter, recipients.map((u) => ({
      userId: u, event: 'TASK_OVERDUE_ESCALATED' as const, title: `Escalated (${days} days overdue): ${t.reference}-${t.number} ${t.title}`,
      body: `Owner: ${owner?.name ?? '—'} · priority ${t.priority} · due ${t.due_date}`, link: `/tasks/${t.id}`, entityType: 'task', entityId: t.id, projectId: t.project_id,
      priority: target === 3 ? ('critical' as const) : ('high' as const), dedupeKey: `esc${target}:${t.id}:${t.due_date}`,
      email: { intro: `This task has been overdue for ${days} days and has been escalated to you.`, details: [['Task', `#${t.number} ${t.title}`], ['Project', t.reference], ['Owner', owner?.name ?? '—'], ['Priority', t.priority], ['Due date', t.due_date], ['Days overdue', String(days)]] },
    })))
    const history = JSON.stringify([...(cur ? (JSON.parse(cur.history) as unknown[]) : []), { level: target, at: nowS, recipients: recipients.length }])
    await env.DB.prepare(
      `INSERT INTO notification_escalations (id, rule_key, entity_type, entity_id, cycle_key, level, reminders, last_notified_at, history, created_at, updated_at)
       VALUES (?, 'task_overdue', 'task', ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(rule_key, entity_id, cycle_key) DO UPDATE SET level = excluded.level, reminders = reminders + 1, last_notified_at = excluded.last_notified_at, history = excluded.history, updated_at = excluded.updated_at`,
    ).bind(newId('esc'), t.id, t.due_date, target, nowS, history, nowS, nowS).run()
    escalated++
  }
  return { overdue: overdue.length, escalated, resolved: resolved.length }
}

// ───────── HR ─────────

export async function leaveReminders(env: Env, waiter: Waiter, today: string) {
  const tomorrow = addDays(today, 1)
  const upcoming = await many<{ id: string; user_id: string; name: string; start_date: string; end_date: string; type_name: string; manager_user_id: string | null }>(
    env.DB,
    `SELECT l.id, l.user_id, u.name, l.start_date, l.end_date, lt.name AS type_name, ep.manager_user_id FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN employee_profiles ep ON ep.user_id = l.user_id WHERE l.status = 'approved' AND l.start_date = ?`,
    tomorrow,
  )
  const todayLeave = await many<{ id: string; user_id: string; name: string; end_date: string; type_name: string; manager_user_id: string | null }>(
    env.DB,
    `SELECT l.id, l.user_id, u.name, l.end_date, lt.name AS type_name, ep.manager_user_id FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN employee_profiles ep ON ep.user_id = l.user_id WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? AND ep.manager_user_id IS NOT NULL`,
    today,
    today,
  )
  const items: NotificationInput[] = []
  for (const l of upcoming) {
    items.push({ userId: l.user_id, event: 'LEAVE_UPCOMING', title: `Your leave starts tomorrow (${l.start_date} – ${l.end_date})`, body: `${l.type_name}. Hand over open tasks before you go.`, link: '/hr/leave', entityType: 'leave_request', entityId: l.id, dedupeKey: `leave-upcoming:${l.id}` })
    if (l.manager_user_id) items.push({ userId: l.manager_user_id, event: 'LEAVE_UPCOMING', title: `${l.name} is on leave from tomorrow`, body: `${l.start_date} – ${l.end_date}`, link: '/hr/leave', entityType: 'leave_request', entityId: l.id, dedupeKey: `leave-upcoming-mgr:${l.id}` })
  }
  for (const l of todayLeave) items.push({ userId: l.manager_user_id!, event: 'LEAVE_TODAY', title: `${l.name} is on approved leave today`, body: `Until ${l.end_date}`, link: '/calendar', entityType: 'leave_request', entityId: l.id, dedupeKey: `leave-today:${l.id}:${today}` })
  await notify(env, waiter, items)
  return { upcoming: upcoming.length, today: todayLeave.length }
}

export async function celebrations(env: Env, waiter: Waiter, today: string) {
  const md = today.slice(5)
  const people = await many<{ id: string; name: string; date_of_birth: string | null; joining_date: string | null }>(
    env.DB,
    `SELECT u.id, u.name, ep.date_of_birth, ep.joining_date FROM users u JOIN employee_profiles ep ON ep.user_id = u.id
      WHERE u.status = 'active' AND (substr(ep.date_of_birth, 6, 5) = ? OR (substr(ep.joining_date, 6, 5) = ? AND ep.joining_date < ?))`,
    md, md, today,
  )
  const hr = await hrUsers(env.DB)
  const items: NotificationInput[] = []
  for (const p of people) {
    if (p.date_of_birth?.slice(5) === md) {
      items.push({ userId: p.id, event: 'EMPLOYEE_BIRTHDAY', title: 'Happy birthday from the Visionary X team!', dedupeKey: `bday:${today}` })
      items.push(...hr.filter((u) => u !== p.id).map((u) => ({ userId: u, event: 'EMPLOYEE_BIRTHDAY' as const, title: `${p.name}'s birthday is today`, link: `/team/${p.id}`, dedupeKey: `bday:${p.id}:${today}` })))
    }
    if (p.joining_date?.slice(5) === md && p.joining_date < today) {
      const years = Number(today.slice(0, 4)) - Number(p.joining_date.slice(0, 4))
      if (years < 1) continue
      items.push({ userId: p.id, event: 'EMPLOYEE_ANNIVERSARY', title: `Happy ${years}-year work anniversary!`, dedupeKey: `anniv:${today}` })
      items.push(...hr.filter((u) => u !== p.id).map((u) => ({ userId: u, event: 'EMPLOYEE_ANNIVERSARY' as const, title: `${p.name} completes ${years} year(s) today`, link: `/team/${p.id}`, dedupeKey: `anniv:${p.id}:${today}` })))
    }
  }
  await notify(env, waiter, items)
  return { people: people.length }
}

// ───────── Weekly & monthly ─────────

export async function weeklyReports(env: Env, waiter: Waiter, today: string, esc: { workloadOpenTasks: number; workloadOverdueTasks: number }, roles: string[]) {
  const w = await weeklySections(env.DB, today, { openThreshold: esc.workloadOpenTasks, overdueThreshold: esc.workloadOverdueTasks })
  const recipients = await usersWithRoles(env.DB, roles)
  const items: NotificationInput[] = recipients.map((u) => ({
    userId: u, event: 'WEEKLY_REPORT', title: `Weekly report — week ending ${addDays(today, -1)}`, body: `${w.workloadFlags.length} workload alert(s) · ${w.unassigned} unassigned task(s)`,
    link: '/reports', dedupeKey: `weekly:${today}`, email: { subject: `Weekly report — week ending ${addDays(today, -1)}`, intro: 'Workload, project progress, overdue work, pending approvals and attendance for the past week.', sections: w.sections, actionLabel: 'Open reports' },
  }))
  // Workload intelligence: each flagged person's reporting manager hears about it (HR already sees it in the report).
  if (w.workloadFlags.length) {
    const managers = await many<{ user_id: string; manager_user_id: string }>(env.DB, `SELECT user_id, manager_user_id FROM employee_profiles WHERE manager_user_id IS NOT NULL AND user_id IN (${w.workloadFlags.map(() => '?').join(', ')})`, ...w.workloadFlags.map((f) => f.userId))
    for (const m of managers) {
      const f = w.workloadFlags.find((x) => x.userId === m.user_id)!
      items.push({ userId: m.manager_user_id, event: 'WORKLOAD_ALERT', title: `Workload alert: ${f.name} has ${f.open} open, ${f.overdue} overdue task(s)`, body: 'Consider rebalancing or extending deadlines.', link: `/team/${f.userId}`, dedupeKey: `workload:${f.userId}:${today}` })
    }
  }
  const optedIn = await many<{ id: string }>(env.DB, `SELECT u.id FROM users u LEFT JOIN notification_user_settings s ON s.user_id = u.id WHERE u.status = 'active' AND COALESCE(s.weekly_digest, 1) = 1`)
  const personal = await weeklyEmployeeDigests(env.DB, today, optedIn.map((u) => u.id))
  items.push(...personal.map((d) => ({
    userId: d.userId, event: 'WEEKLY_EMPLOYEE_DIGEST' as const, title: 'Your week in review', body: d.rows.map(([k, v]) => `${k}: ${v}`).join(' · '), link: '/tasks', dedupeKey: `weekly-digest:${today}`,
    email: { intro: 'A summary of your tasks over the past week.', sections: [{ title: 'Your week', rows: d.rows }] },
  })))
  await notify(env, waiter, items)
  return { recipients: recipients.length, workloadAlerts: w.workloadFlags.length, digests: personal.length }
}

export async function monthlyReports(env: Env, waiter: Waiter, today: string, roles: string[]) {
  const m = await monthlySections(env.DB, today)
  const recipients = await usersWithRoles(env.DB, roles)
  const items: NotificationInput[] = recipients.map((u) => ({
    userId: u, event: 'MONTHLY_REPORT', title: `Monthly report — ${m.month}`, link: '/reports', dedupeKey: `monthly:${m.month}`,
    email: { subject: `Monthly report — ${m.month}`, intro: `Attendance, leave, task completion and project performance for ${m.month}.`, sections: m.sections, actionLabel: 'Open reports' },
  }))
  items.push(...m.perEmployee.map((r) => ({
    userId: r.userId, event: 'ATTENDANCE_MONTHLY_REPORT' as const, title: `Your attendance for ${m.month}: ${r.present + r.remote + r.half}/${r.working} days`,
    body: `${r.present} present · ${r.remote} remote · ${r.half} half days · ${r.leave} leave · ${r.noRecord} without a record`, link: `/hr/attendance?month=${m.month}`, dedupeKey: `att-monthly:${m.month}`,
    email: { sections: [{ title: m.month, rows: ([['Working days', r.working], ['Present', r.present], ['Remote', r.remote], ['Half days', r.half], ['Approved leave', r.leave], ['Days without a record', r.noRecord]] as [string, number][]) }], outro: 'If a day is wrong, request an attendance correction in the CRM.' },
  })))
  await notify(env, waiter, items)
  return { recipients: recipients.length, employees: m.perEmployee.length }
}

// ───────── Every tick ─────────

export async function meetingReminders(env: Env, waiter: Waiter, at: Date, defaultLead: number) {
  const horizon = new Date(at.getTime() + 245 * 60_000).toISOString()
  const events = await many<{ id: string; title: string; start_at: string; end_at: string; recurrence_rule: string | null; reminder_minutes: number | null; organizer_id: string | null; location: string | null }>(
    env.DB,
    `SELECT id, title, start_at, end_at, recurrence_rule, reminder_minutes, organizer_id, location FROM calendar_events
      WHERE cancelled_at IS NULL AND kind IN ('internal_meeting','client_meeting','company_event','reminder','other') AND (start_at <= ? OR recurrence_rule IS NOT NULL) AND (end_at >= ? OR recurrence_rule IS NOT NULL)
      LIMIT 300`,
    horizon,
    at.toISOString(),
  )
  let sent = 0
  for (const e of events) {
    const lead = e.reminder_minutes ?? defaultLead
    if (!lead) continue
    const occ = expandOccurrences(e.start_at, e.end_at, e.recurrence_rule, at.toISOString(), new Date(at.getTime() + (lead + 6) * 60_000).toISOString(), env.COMPANY_TIMEZONE, 5)
    for (const o of occ) {
      const startMs = new Date(o.startAt).getTime()
      const remindAt = startMs - lead * 60_000
      // Fire on the first tick at or after the reminder time, while the meeting has not started yet.
      if (at.getTime() < remindAt || at.getTime() >= startMs) continue
      const attendees = await many<{ user_id: string }>(env.DB, `SELECT user_id FROM event_attendees WHERE event_id = ? AND response <> 'declined'`, e.id)
      const who = uniq([e.organizer_id, ...attendees.map((a) => a.user_id)])
      const when = new Date(o.startAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
      await notify(env, waiter, who.map((u) => ({
        userId: u, event: 'MEETING_REMINDER' as const, title: `Starting at ${when}: ${e.title}`, body: e.location ? `Location: ${e.location}` : `In ${Math.round((startMs - at.getTime()) / 60000)} minutes`,
        link: `/calendar?event=${e.id}`, entityType: 'calendar_event', entityId: e.id, dedupeKey: `meeting-rem:${e.id}:${o.startAt}`,
      })))
      sent++
    }
  }
  return sent
}

/** Announcements that require acknowledgement: remind recipients, then tell their reporting manager. */
export async function ackEscalations(env: Env, waiter: Waiter, at: Date, esc: { ackReminderHours: number; ackManagerHours: number }) {
  if (!esc.ackReminderHours && !esc.ackManagerHours) return 0
  const horizon = new Date(at.getTime() - Math.min(esc.ackReminderHours || 9999, esc.ackManagerHours || 9999) * 3600_000).toISOString()
  const bcs = await many<{ id: string; title: string; sent_at: string; expires_at: string | null }>(
    env.DB,
    `SELECT id, title, sent_at, expires_at FROM notification_broadcasts WHERE status = 'sent' AND requires_ack = 1 AND sent_at <= ? AND sent_at >= ? AND (expires_at IS NULL OR expires_at > ?)`,
    horizon,
    new Date(at.getTime() - 30 * 86400_000).toISOString(),
    at.toISOString(),
  )
  let n = 0
  for (const b of bcs) {
    const age = (at.getTime() - Date.parse(b.sent_at)) / 3600_000
    const pending = await many<{ user_id: string; name: string; manager_user_id: string | null }>(
      env.DB,
      `SELECT n.user_id, u.name, ep.manager_user_id FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN employee_profiles ep ON ep.user_id = n.user_id
        WHERE n.broadcast_id = ? AND n.requires_ack = 1 AND n.acknowledged_at IS NULL AND u.status = 'active'`,
      b.id,
    )
    if (pending.length === 0) continue
    const items: NotificationInput[] = []
    if (esc.ackReminderHours && age >= esc.ackReminderHours) {
      items.push(...pending.map((p) => ({ userId: p.user_id, event: 'ANNOUNCEMENT_ACK_REMINDER' as const, title: `Please acknowledge: ${b.title}`, link: `/notifications?broadcast=${b.id}`, entityType: 'broadcast', entityId: b.id, broadcastId: b.id, dedupeKey: `bc-ack-rem:${b.id}` })))
    }
    if (esc.ackManagerHours && age >= esc.ackManagerHours) {
      items.push(...pending.filter((p) => p.manager_user_id).map((p) => ({ userId: p.manager_user_id!, event: 'ANNOUNCEMENT_ACK_OVERDUE' as const, title: `${p.name} has not acknowledged “${b.title}”`, body: `Sent ${b.sent_at.slice(0, 10)}`, entityType: 'broadcast', entityId: b.id, dedupeKey: `bc-ack-mgr:${b.id}:${p.user_id}` })))
    }
    const r = await notify(env, waiter, items)
    n += r.created
  }
  return n
}

export async function notificationRetention(env: Env, at: Date) {
  const days = (d: number) => new Date(at.getTime() - d * 86400_000).toISOString()
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM notification_delivery_events WHERE received_at < ?`).bind(days(90)),
    env.DB.prepare(`DELETE FROM notification_deliveries WHERE created_at < ? AND status NOT IN ('queued','retry','sending')`).bind(days(180)),
    env.DB.prepare(`DELETE FROM notification_events WHERE created_at < ?`).bind(days(365)),
    env.DB.prepare(`DELETE FROM notification_jobs WHERE started_at < ?`).bind(days(60)),
    env.DB.prepare(`DELETE FROM notifications WHERE archived_at IS NOT NULL AND archived_at < ?`).bind(days(180)),
    env.DB.prepare(`UPDATE push_subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`).bind(at.toISOString(), at.toISOString()),
    env.DB.prepare(`DELETE FROM push_subscriptions WHERE status <> 'active' AND updated_at < ?`).bind(days(90)),
  ])
  return { ok: true }
}

export { localDate }
