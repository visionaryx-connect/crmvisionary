// Report builders for digests and scheduled reports. Every number comes from live D1 data at send time; nothing is
// estimated. Queries are bulk (one per dataset, grouped in memory) to stay well inside D1's per-invocation query limit.

import { addDays, eachDate, localDate, monthBounds, previousMonth } from '@shared/dates'
import { classifyDay } from '@shared/workdays'
import { many, one } from '../lib/db'
import type { EmailContent } from './notify'
import { getDayOffSource, getSetting, getWorkweek } from './settings'

type Section = NonNullable<EmailContent['sections']>[number]

const OPEN = `('backlog','todo','in_progress','in_review','blocked')`
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—')

// ───────── Attendance ─────────

export interface AttendanceSnapshot {
  date: string
  working: boolean
  dayLabel: string | null
  expected: { id: string; name: string; managerId: string | null; department: string | null }[]
  present: { id: string; name: string; checkIn: string; remote: boolean; late: boolean }[]
  missing: { id: string; name: string; managerId: string | null; department: string | null }[]
  onLeave: { id: string; name: string; type: string; half: string }[]
  missingCheckout: { id: string; name: string; checkIn: string }[]
  late: { id: string; name: string; checkIn: string }[]
  earlyDepartures: { id: string; name: string; checkOut: string }[]
  /** User ids on leave for the whole day or the given half. */
  leaveHalf: Map<string, string>
}

/**
 * Who was expected to work on `date` and what they did. Employees count as expected only on working days (weekly
 * rule, verified holidays, overrides), while employed (joining / exit dates), with an active account that can record
 * attendance. Full-day approved leave excludes them. Missing ≠ absent: no status is ever written here.
 */
export async function attendanceSnapshot(db: D1Database, date: string, opts: { lateAfter: string; earlyBefore: string }): Promise<AttendanceSnapshot> {
  const ww = await getWorkweek(db)
  const day = classifyDay(date, ww, await getDayOffSource(db, date, date))
  const people = await many<{ id: string; name: string; manager_user_id: string | null; department: string | null }>(
    db,
    `SELECT u.id, u.name, ep.manager_user_id, d.name AS department FROM users u
       JOIN employee_profiles ep ON ep.user_id = u.id LEFT JOIN departments d ON d.id = ep.department_id
      WHERE u.status = 'active' AND ep.employment_status <> 'exited'
        AND (ep.joining_date IS NULL OR ep.joining_date <= ?) AND (ep.exit_date IS NULL OR ep.exit_date >= ?)
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = 'attendance.self')
      ORDER BY u.name`,
    date,
    date,
  )
  const [recs, leaves] = await Promise.all([
    many<{ user_id: string; check_in_at: string | null; check_out_at: string | null; status: string }>(db, 'SELECT user_id, check_in_at, check_out_at, status FROM attendance_records WHERE work_date = ?', date),
    many<{ user_id: string; half_day: string; type_name: string }>(
      db,
      `SELECT l.user_id, l.half_day, lt.name AS type_name FROM leave_requests l JOIN leave_types lt ON lt.id = l.leave_type_id WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?`,
      date,
      date,
    ),
  ])
  const recMap = new Map(recs.map((r) => [r.user_id, r]))
  const leaveMap = new Map(leaves.map((l) => [l.user_id, l]))
  const lateCut = opts.lateAfter
  const earlyCut = opts.earlyBefore
  const localHm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const snap: AttendanceSnapshot = { date, working: day.working, dayLabel: day.label ?? null, expected: [], present: [], missing: [], onLeave: [], missingCheckout: [], late: [], earlyDepartures: [], leaveHalf: new Map() }
  for (const p of people) {
    const lv = leaveMap.get(p.id)
    if (lv) {
      snap.onLeave.push({ id: p.id, name: p.name, type: lv.type_name, half: lv.half_day })
      snap.leaveHalf.set(p.id, lv.half_day)
      if (lv.half_day === 'none') continue
    }
    if (!day.working) continue
    const person = { id: p.id, name: p.name, managerId: p.manager_user_id, department: p.department }
    snap.expected.push(person)
    const r = recMap.get(p.id)
    if (r?.check_in_at) {
      const late = localHm(r.check_in_at) > lateCut && lv?.half_day !== 'first_half'
      snap.present.push({ id: p.id, name: p.name, checkIn: r.check_in_at, remote: r.status === 'remote', late })
      if (late) snap.late.push({ id: p.id, name: p.name, checkIn: r.check_in_at })
      if (!r.check_out_at) snap.missingCheckout.push({ id: p.id, name: p.name, checkIn: r.check_in_at })
      else if (localHm(r.check_out_at) < earlyCut && lv?.half_day !== 'second_half') snap.earlyDepartures.push({ id: p.id, name: p.name, checkOut: r.check_out_at })
    } else if (r && ['present', 'remote', 'half_day', 'absent'].includes(r.status)) {
      // A manual / corrected record without a check-in time is still a record (HR decided the day).
      snap.present.push({ id: p.id, name: p.name, checkIn: r.check_out_at ?? '', remote: r.status === 'remote', late: false })
    } else {
      snap.missing.push(person)
    }
  }
  return snap
}

export function attendanceSections(s: AttendanceSnapshot, opts: { includeCheckout?: boolean } = {}): Section[] {
  const out: Section[] = [
    {
      title: `Attendance — ${s.date}`,
      rows: [
        ['Expected today', s.expected.length],
        ['Checked in', s.present.length],
        ['Working remotely', s.present.filter((p) => p.remote).length],
        ['Late arrivals', s.late.length],
        ['No check-in yet', s.missing.length],
        ['On approved leave', s.onLeave.length],
        ...(opts.includeCheckout ? ([['Missing checkout', s.missingCheckout.length], ['Early departures', s.earlyDepartures.length]] as [string, number][]) : []),
      ],
    },
    { title: 'No check-in', items: s.missing.map((m) => `${m.name}${m.department ? ` · ${m.department}` : ''}`), empty: 'Everyone expected has checked in.' },
    { title: 'Late arrivals', items: s.late.map((l) => `${l.name} · ${fmtTime(l.checkIn)}`), empty: 'No late arrivals.' },
  ]
  if (s.onLeave.length) out.push({ title: 'On leave', items: s.onLeave.map((l) => `${l.name} · ${l.type}${l.half !== 'none' ? ` (${l.half.replace('_', ' ')})` : ''}`) })
  if (opts.includeCheckout) {
    out.push({ title: 'Missing checkout', items: s.missingCheckout.map((m) => `${m.name} · in at ${fmtTime(m.checkIn)}`), empty: 'Everyone checked out.' })
    if (s.earlyDepartures.length) out.push({ title: 'Early departures', items: s.earlyDepartures.map((e) => `${e.name} · out at ${fmtTime(e.checkOut)}`) })
  }
  return out
}

// ───────── Daily task digest (per employee) ─────────

export interface TaskDigest {
  userId: string
  sections: Section[]
  counts: { dueToday: number; overdue: number; inProgress: number; pending: number; inReview: number; upcoming: number; toReview: number; newAssignments: number; newComments: number }
}

export async function dailyTaskDigests(db: D1Database, today: string, userIds: string[]): Promise<TaskDigest[]> {
  if (userIds.length === 0) return []
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const soon = addDays(today, 3)
  const tasks = await many<{ id: string; number: number; title: string; status: string; due_date: string | null; reference: string; user_id: string; created_at: string }>(
    db,
    `SELECT t.id, t.number, t.title, t.status, t.due_date, p.reference, x.user_id, t.created_at FROM tasks t JOIN projects p ON p.id = t.project_id
       JOIN (SELECT id AS task_id, responsible_id AS user_id FROM tasks WHERE responsible_id IS NOT NULL AND status IN ${OPEN}
             UNION SELECT ta.task_id, ta.user_id FROM task_assignees ta JOIN tasks t2 ON t2.id = ta.task_id WHERE t2.status IN ${OPEN}) x ON x.task_id = t.id
      WHERE p.archived_at IS NULL AND t.status IN ${OPEN}`,
  )
  const reviews = await many<{ user_id: string; n: number }>(
    db,
    `SELECT r.user_id, COUNT(DISTINCT t.id) AS n FROM tasks t JOIN projects p ON p.id = t.project_id
       JOIN (SELECT id AS project_id, manager_id AS user_id FROM projects WHERE manager_id IS NOT NULL
             UNION SELECT project_id, user_id FROM project_members WHERE can_review = 1 OR role = 'manager') r ON r.project_id = t.project_id
      WHERE t.status = 'in_review' AND p.archived_at IS NULL GROUP BY r.user_id`,
  )
  const comments = await many<{ user_id: string; n: number }>(
    db,
    `SELECT n.user_id, COUNT(*) AS n FROM notifications n WHERE n.created_at >= ? AND n.event_key IN ('TASK_COMMENT_CREATED','TASK_COMMENT_REPLIED','TASK_MENTIONED') GROUP BY n.user_id`,
    since,
  )
  const reviewMap = new Map(reviews.map((r) => [r.user_id, r.n]))
  const commentMap = new Map(comments.map((r) => [r.user_id, r.n]))
  const out: TaskDigest[] = []
  for (const uid of userIds) {
    const mine = tasks.filter((t) => t.user_id === uid)
    const label = (t: (typeof mine)[number]) => `${t.reference}-${t.number} ${t.title}${t.due_date ? ` · due ${t.due_date}` : ''}`
    const dueToday = mine.filter((t) => t.due_date === today && t.status !== 'in_review')
    const overdue = mine.filter((t) => t.due_date && t.due_date < today && t.status !== 'in_review')
    const inProgress = mine.filter((t) => t.status === 'in_progress')
    const pending = mine.filter((t) => ['backlog', 'todo', 'blocked'].includes(t.status))
    const inReview = mine.filter((t) => t.status === 'in_review')
    const upcoming = mine.filter((t) => t.due_date && t.due_date > today && t.due_date <= soon && t.status !== 'in_review')
    const newAssignments = mine.filter((t) => t.created_at >= since)
    const counts = {
      dueToday: dueToday.length, overdue: overdue.length, inProgress: inProgress.length, pending: pending.length, inReview: inReview.length,
      upcoming: upcoming.length, toReview: reviewMap.get(uid) ?? 0, newAssignments: newAssignments.length, newComments: commentMap.get(uid) ?? 0,
    }
    if (Object.values(counts).every((n) => n === 0)) continue
    const sections: Section[] = [
      { title: 'At a glance', rows: [['Due today', counts.dueToday], ['Overdue', counts.overdue], ['In progress', counts.inProgress], ['To do / blocked', counts.pending], ['Submitted, awaiting review', counts.inReview], ['Due in the next 3 days', counts.upcoming], ['Waiting for your review', counts.toReview], ['New comments and replies (24 h)', counts.newComments]] },
    ]
    if (overdue.length) sections.push({ title: 'Overdue', items: overdue.map(label) })
    if (dueToday.length) sections.push({ title: 'Due today', items: dueToday.map(label) })
    if (newAssignments.length) sections.push({ title: 'New assignments', items: newAssignments.map(label) })
    if (inProgress.length) sections.push({ title: 'In progress', items: inProgress.map(label) })
    if (upcoming.length) sections.push({ title: 'Coming up', items: upcoming.map(label) })
    out.push({ userId: uid, sections, counts })
  }
  return out
}

// ───────── Operations snapshots ─────────

export async function operationsSections(db: D1Database, today: string, scope: 'hr' | 'admin' | 'super_admin'): Promise<Section[]> {
  const start = new Date(`${today}T00:00:00+05:30`).toISOString()
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const sections: Section[] = []
  const leave = await one<{ pending: number; corrections: number; starting: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') AS pending,
            (SELECT COUNT(*) FROM attendance_corrections WHERE status = 'pending') AS corrections,
            (SELECT COUNT(*) FROM leave_requests WHERE status = 'approved' AND start_date = ?) AS starting`,
    addDays(today, 1),
  )
  if (scope !== 'admin') {
    sections.push({ title: 'Leave & HR', rows: [['Leave requests awaiting decision', leave?.pending ?? 0], ['Attendance corrections awaiting decision', leave?.corrections ?? 0], ['Approved leave starting tomorrow', leave?.starting ?? 0]] })
  }
  if (scope === 'hr') {
    const load = await many<{ name: string; overdue: number; open: number }>(
      db,
      `SELECT u.name, SUM(CASE WHEN t.due_date < ? THEN 1 ELSE 0 END) AS overdue, COUNT(*) AS open FROM tasks t JOIN users u ON u.id = t.responsible_id
        WHERE t.status IN ${OPEN} AND u.status = 'active' GROUP BY u.id HAVING overdue > 0 ORDER BY overdue DESC LIMIT 8`,
      today,
    )
    sections.push({ title: 'Workload — most overdue', items: load.map((l) => `${l.name}: ${l.overdue} overdue of ${l.open} open`), empty: 'Nobody has overdue tasks.' })
    return sections
  }
  const t = await one<{ assigned: number; completed: number; open: number; overdue: number; review: number; blocked: number; due_today: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM tasks WHERE created_at >= ? AND responsible_id IS NOT NULL) AS assigned,
            (SELECT COUNT(DISTINCT task_id) FROM task_status_history WHERE to_status = 'completed' AND changed_at >= ?) AS completed,
            (SELECT COUNT(*) FROM tasks WHERE status IN ${OPEN}) AS open,
            (SELECT COUNT(*) FROM tasks WHERE status IN ${OPEN} AND due_date < ?) AS overdue,
            (SELECT COUNT(*) FROM tasks WHERE status = 'in_review') AS review,
            (SELECT COUNT(*) FROM tasks WHERE status = 'blocked') AS blocked,
            (SELECT COUNT(*) FROM tasks WHERE status IN ${OPEN} AND due_date = ?) AS due_today`,
    start, start, today, today,
  )
  sections.push({ title: 'Tasks', rows: [['Assigned today', t?.assigned ?? 0], ['Completed today', t?.completed ?? 0], ['Open', t?.open ?? 0], ['Due today', t?.due_today ?? 0], ['Overdue', t?.overdue ?? 0], ['Awaiting review', t?.review ?? 0], ['Blocked', t?.blocked ?? 0]] })
  const p = await one<{ active: number; delayed: number; at_risk: number; updates: number; milestones: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL AND status NOT IN ('completed','archived')) AS active,
            (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL AND status = 'delayed') AS delayed,
            (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL AND status = 'at_risk') AS at_risk,
            (SELECT COUNT(*) FROM project_updates WHERE created_at >= ?) AS updates,
            (SELECT COUNT(*) FROM milestones WHERE achieved_at >= ?) AS milestones`,
    start, start,
  )
  sections.push({ title: 'Projects', rows: [['Active', p?.active ?? 0], ['Delayed', p?.delayed ?? 0], ['At risk', p?.at_risk ?? 0], ['Updates posted today', p?.updates ?? 0], ['Milestones achieved today', p?.milestones ?? 0]] })
  const alerts = await many<{ label: string }>(
    db,
    `SELECT reference || ' ' || name || ' — ' || status AS label FROM projects WHERE archived_at IS NULL AND status IN ('delayed','at_risk') ORDER BY target_date LIMIT 10`,
  )
  const blocked = await many<{ label: string }>(db, `SELECT p.reference || '-' || t.number || ' ' || t.title AS label FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT 10`)
  sections.push({ title: 'Operational alerts', items: [...alerts.map((a) => `Project ${a.label}`), ...blocked.map((b) => `Blocked: ${b.label}`)], empty: 'No delayed projects or blocked tasks.' })
  if (scope === 'super_admin') {
    const d = await many<{ channel: string; status: string; n: number }>(db, `SELECT channel, status, COUNT(*) AS n FROM notification_deliveries WHERE updated_at >= ? AND status IN ('failed','bounced','blocked','spam') GROUP BY channel, status`, since)
    const b = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM notification_broadcasts WHERE sent_at >= ?`, since)
    sections.push({ title: 'Communication (last 24 h)', rows: [['Announcements sent', b?.n ?? 0], ...d.map((x) => [`${x.channel === 'email' ? 'Email' : 'Push'} ${x.status}`, x.n] as [string, number])] })
    const hires = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, start)
    sections.push({ title: 'HR activity', rows: [['New accounts today', hires?.n ?? 0], ['Leave requests awaiting decision', leave?.pending ?? 0]] })
  }
  return sections
}

// ───────── Weekly ─────────

export async function weeklySections(db: D1Database, today: string, opts: { openThreshold: number; overdueThreshold: number }): Promise<{ sections: Section[]; workloadFlags: { userId: string; name: string; open: number; overdue: number }[]; unassigned: number }> {
  const from = addDays(today, -7)
  const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString()
  const load = await many<{ id: string; name: string; open: number; overdue: number }>(
    db,
    `SELECT u.id, u.name, COUNT(t.id) AS open, SUM(CASE WHEN t.due_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM users u LEFT JOIN tasks t ON t.responsible_id = u.id AND t.status IN ${OPEN}
      WHERE u.status = 'active' GROUP BY u.id HAVING open > 0 ORDER BY overdue DESC, open DESC LIMIT 25`,
    today,
  )
  const unassigned = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.responsible_id IS NULL AND t.status IN ${OPEN} AND p.archived_at IS NULL`)
  const completed = await one<{ n: number }>(db, `SELECT COUNT(DISTINCT task_id) AS n FROM task_status_history WHERE to_status = 'completed' AND changed_at >= ?`, fromIso)
  const projects = await many<{ label: string }>(
    db,
    `SELECT reference || ' ' || name || ' — ' || CAST(ROUND(progress) AS INTEGER) || '% · ' || replace(status, '_', ' ') AS label FROM projects WHERE archived_at IS NULL AND status NOT IN ('completed','archived') ORDER BY progress LIMIT 25`,
  )
  const overdue = await many<{ label: string }>(
    db,
    `SELECT p.reference || '-' || t.number || ' ' || t.title || ' · due ' || t.due_date || COALESCE(' · ' || u.name, '') AS label FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.responsible_id
      WHERE t.status IN ${OPEN} AND t.due_date < ? AND p.archived_at IS NULL ORDER BY t.due_date LIMIT 30`,
    today,
  )
  const approvals = await one<{ reviews: number; leave: number; corrections: number; deliverables: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM task_submissions WHERE decision = 'pending') AS reviews, (SELECT COUNT(*) FROM leave_requests WHERE status = 'pending') AS leave,
            (SELECT COUNT(*) FROM attendance_corrections WHERE status = 'pending') AS corrections, (SELECT COUNT(*) FROM deliverables WHERE status = 'in_review') AS deliverables`,
  )
  const att = await one<{ checkins: number; remote: number }>(db, `SELECT COUNT(*) AS checkins, SUM(CASE WHEN status = 'remote' THEN 1 ELSE 0 END) AS remote FROM attendance_records WHERE work_date >= ? AND work_date < ?`, from, today)
  const flags = load.filter((l) => l.open >= opts.openThreshold || l.overdue >= opts.overdueThreshold).map((l) => ({ userId: l.id, name: l.name, open: l.open, overdue: l.overdue }))
  return {
    workloadFlags: flags,
    unassigned: unassigned?.n ?? 0,
    sections: [
      { title: `Week ${from} – ${addDays(today, -1)}`, rows: [['Tasks completed', completed?.n ?? 0], ['Open tasks without an owner', unassigned?.n ?? 0], ['Attendance records', att?.checkins ?? 0], ['Remote days', att?.remote ?? 0]] },
      { title: 'Pending approvals', rows: [['Task reviews', approvals?.reviews ?? 0], ['Deliverable reviews', approvals?.deliverables ?? 0], ['Leave requests', approvals?.leave ?? 0], ['Attendance corrections', approvals?.corrections ?? 0]] },
      { title: 'Employee workload (open · overdue)', items: load.map((l) => `${l.name}: ${l.open} open · ${l.overdue} overdue${flags.some((f) => f.userId === l.id) ? ' ⚠' : ''}`), empty: 'No open tasks.' },
      { title: 'Project progress', items: projects.map((p) => p.label), empty: 'No active projects.' },
      { title: 'Overdue tasks', items: overdue.map((o) => o.label), empty: 'No overdue tasks.' },
    ],
  }
}

export async function weeklyEmployeeDigests(db: D1Database, today: string, userIds: string[]) {
  const from = addDays(today, -7)
  const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString()
  const done = await many<{ user_id: string; n: number }>(
    db,
    `SELECT t.responsible_id AS user_id, COUNT(DISTINCT h.task_id) AS n FROM task_status_history h JOIN tasks t ON t.id = h.task_id WHERE h.to_status = 'completed' AND h.changed_at >= ? AND t.responsible_id IS NOT NULL GROUP BY t.responsible_id`,
    fromIso,
  )
  const open = await many<{ user_id: string; open: number; overdue: number; next_week: number }>(
    db,
    `SELECT responsible_id AS user_id, COUNT(*) AS open, SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) AS overdue, SUM(CASE WHEN due_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS next_week
       FROM tasks WHERE status IN ${OPEN} AND responsible_id IS NOT NULL GROUP BY responsible_id`,
    today, today, addDays(today, 7),
  )
  const doneMap = new Map(done.map((d) => [d.user_id, d.n]))
  const openMap = new Map(open.map((o) => [o.user_id, o]))
  return userIds
    .map((uid) => {
      const o = openMap.get(uid)
      const rows: [string, number][] = [['Completed last week', doneMap.get(uid) ?? 0], ['Open now', o?.open ?? 0], ['Overdue', o?.overdue ?? 0], ['Due in the next 7 days', o?.next_week ?? 0]]
      return { userId: uid, rows, any: rows.some(([, n]) => n > 0) }
    })
    .filter((d) => d.any)
}

// ───────── Monthly ─────────

export async function monthlyAttendance(db: D1Database, today: string) {
  const month = previousMonth(today)
  const { start, end } = monthBounds(month)
  const ww = await getWorkweek(db)
  const src = await getDayOffSource(db, start, end)
  const workingDays = eachDate(start, end).filter((d) => classifyDay(d, ww, src).working)
  const people = await many<{ id: string; name: string; joining_date: string | null; exit_date: string | null }>(
    db,
    `SELECT u.id, u.name, ep.joining_date, ep.exit_date FROM users u JOIN employee_profiles ep ON ep.user_id = u.id
      WHERE u.status = 'active' AND EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = 'attendance.self') ORDER BY u.name`,
  )
  const recs = await many<{ user_id: string; work_date: string; status: string }>(db, 'SELECT user_id, work_date, status FROM attendance_records WHERE work_date BETWEEN ? AND ?', start, end)
  const leaves = await many<{ user_id: string; start_date: string; end_date: string; days: number; type_name: string }>(
    db,
    `SELECT l.user_id, l.start_date, l.end_date, l.days, lt.name AS type_name FROM leave_requests l JOIN leave_types lt ON lt.id = l.leave_type_id WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?`,
    end,
    start,
  )
  const rows = people.map((p) => {
    const days = workingDays.filter((d) => (!p.joining_date || d >= p.joining_date) && (!p.exit_date || d <= p.exit_date))
    const mine = recs.filter((r) => r.user_id === p.id)
    const lv = leaves.filter((l) => l.user_id === p.id)
    const onLeave = days.filter((d) => lv.some((l) => l.start_date <= d && l.end_date >= d))
    const present = mine.filter((r) => r.status === 'present').length
    const remote = mine.filter((r) => r.status === 'remote').length
    const half = mine.filter((r) => r.status === 'half_day').length
    const absent = mine.filter((r) => r.status === 'absent').length
    const recorded = new Set(mine.map((r) => r.work_date))
    const noRecord = days.filter((d) => !recorded.has(d) && !onLeave.includes(d)).length
    return { userId: p.id, name: p.name, working: days.length, present, remote, half, absent, leave: onLeave.length, noRecord }
  })
  const leaveByType = new Map<string, number>()
  for (const l of leaves) leaveByType.set(l.type_name, (leaveByType.get(l.type_name) ?? 0) + l.days)
  return { month, start, end, workingDays: workingDays.length, rows, leaveByType }
}

export async function monthlySections(db: D1Database, today: string): Promise<{ month: string; sections: Section[]; perEmployee: Awaited<ReturnType<typeof monthlyAttendance>>['rows'] }> {
  const att = await monthlyAttendance(db, today)
  const fromIso = new Date(`${att.start}T00:00:00+05:30`).toISOString()
  const toIso = new Date(`${addDays(att.end, 1)}T00:00:00+05:30`).toISOString()
  const tasks = await one<{ completed: number; created: number }>(
    db,
    `SELECT (SELECT COUNT(DISTINCT task_id) FROM task_status_history WHERE to_status = 'completed' AND changed_at >= ? AND changed_at < ?) AS completed,
            (SELECT COUNT(*) FROM tasks WHERE created_at >= ? AND created_at < ?) AS created`,
    fromIso, toIso, fromIso, toIso,
  )
  const projects = await one<{ completed: number; delayed: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM projects WHERE completed_at >= ? AND completed_at < ?) AS completed, (SELECT COUNT(*) FROM projects WHERE status = 'delayed' AND archived_at IS NULL) AS delayed`,
    fromIso, toIso,
  )
  const depts = await many<{ name: string; n: number }>(
    db,
    `SELECT COALESCE(d.name, 'No department') AS name, COUNT(DISTINCT h.task_id) AS n FROM task_status_history h JOIN tasks t ON t.id = h.task_id
       LEFT JOIN employee_profiles ep ON ep.user_id = t.responsible_id LEFT JOIN departments d ON d.id = ep.department_id
      WHERE h.to_status = 'completed' AND h.changed_at >= ? AND h.changed_at < ? GROUP BY d.id ORDER BY n DESC LIMIT 15`,
    fromIso, toIso,
  )
  return {
    month: att.month,
    perEmployee: att.rows,
    sections: [
      { title: `Summary — ${att.month}`, rows: [['Working days', att.workingDays], ['Tasks created', tasks?.created ?? 0], ['Tasks completed', tasks?.completed ?? 0], ['Projects completed', projects?.completed ?? 0], ['Projects currently delayed', projects?.delayed ?? 0]] },
      { title: 'Employee attendance (present+remote / working days · no record)', items: att.rows.map((r) => `${r.name}: ${r.present + r.remote + r.half}/${r.working}${r.leave ? ` · ${r.leave} leave` : ''}${r.noRecord ? ` · ${r.noRecord} no record` : ''}`), empty: 'No employees.' },
      { title: 'Leave taken (days)', rows: [...att.leaveByType.entries()].map(([k, v]) => [k, v] as [string, number]), empty: 'No approved leave in this month.' },
      { title: 'Department activity (tasks completed)', rows: depts.map((d) => [d.name, d.n] as [string, number]), empty: 'No tasks completed.' },
    ],
  }
}

export const todayLocal = () => localDate()
export { getSetting }
