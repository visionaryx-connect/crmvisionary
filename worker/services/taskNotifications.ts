// Task-module events → central engine. Routes call these after their DB writes succeed; routing follows
// docs/NOTIFICATIONS.md (assignee + project manager for assignment, participants for discussion, etc.).

import type { Env } from '../env'
import { PRIORITY_LABEL, TASK_STATUS_LABEL, type Priority, type TaskStatus } from '@shared/constants'
import { one } from '../lib/db'
import { notify, projectReviewers, type NotificationInput } from './notify'
import { canReadProject, projectManagers, taskParticipants, uniq } from './notificationRouting'
import type { Waiter } from './realtime'

interface Actor {
  userId: string
  name: string
}

export interface TaskCtx {
  id: string
  number: number
  title: string
  priority: Priority
  due_date: string | null
  status: TaskStatus
  project_id: string
  reference: string
  project_name: string
  responsible_id: string | null
  created_by: string | null
}

export async function taskCtx(db: D1Database, taskId: string): Promise<TaskCtx | null> {
  return one<TaskCtx>(
    db,
    `SELECT t.id, t.number, t.title, t.priority, t.due_date, t.status, t.project_id, p.reference, p.name AS project_name, t.responsible_id, t.created_by
       FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
    taskId,
  )
}

const label = (t: TaskCtx) => `${t.reference}-${t.number} ${t.title}`
const base = (t: TaskCtx) => ({ link: `/tasks/${t.id}`, entityType: 'task', entityId: t.id, projectId: t.project_id })
const details = (t: TaskCtx, extra: [string, string][] = []): [string, string][] => [
  ['Task', `#${t.number} ${t.title}`],
  ['Project', `${t.project_name} (${t.reference})`],
  ['Priority', PRIORITY_LABEL[t.priority] ?? t.priority],
  ['Deadline', t.due_date ?? 'No due date'],
  ...extra,
]
const time = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })

/** New assignment (create, reassign, added as assignee). Project managers get a separate heads-up. */
export async function taskAssigned(env: Env, w: Waiter, taskId: string, actor: Actor, assignees: string[], opts: { reassigned?: boolean; isNew?: boolean } = {}) {
  const t = await taskCtx(env.DB, taskId)
  if (!t || assignees.length === 0) return
  const event = opts.reassigned ? ('TASK_REASSIGNED' as const) : ('TASK_ASSIGNED' as const)
  const items: NotificationInput[] = assignees.map((u) => ({
    userId: u, event, ...base(t),
    title: `${opts.reassigned ? 'Reassigned to you' : opts.isNew ? 'New task' : 'Assigned to you'}: ${label(t)}`,
    body: `${t.project_name} · ${PRIORITY_LABEL[t.priority]} priority · ${t.due_date ? `due ${t.due_date}` : 'no due date'}`,
    email: { intro: `${actor.name} assigned a task to you.`, details: details(t, [['Assigned by', actor.name]]), outro: 'Open the task to see the full brief, subtasks and files.', actionLabel: 'Open task' },
  }))
  const managers = (await projectManagers(env.DB, t.project_id)).filter((m) => !assignees.includes(m))
  const names = await Promise.all(assignees.slice(0, 5).map((u) => one<{ name: string }>(env.DB, 'SELECT name FROM users WHERE id = ?', u)))
  items.push(...managers.map((m) => ({
    userId: m, event: 'TASK_ASSIGNED' as const, ...base(t), channels: ['in_app' as const], priority: 'low' as const,
    title: `${actor.name} assigned ${label(t)}`, body: `To ${names.map((n) => n?.name).filter(Boolean).join(', ')}`,
    dedupeKey: `assign-pm:${t.id}:${assignees.slice().sort().join(',')}`,
  })))
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

export async function taskUnassigned(env: Env, w: Waiter, taskId: string, actor: Actor, removed: string[]) {
  const t = await taskCtx(env.DB, taskId)
  if (!t || removed.length === 0) return
  await notify(env, w, removed.map((u) => ({ userId: u, event: 'TASK_UNASSIGNED' as const, ...base(t), title: `You were removed from ${label(t)}`, body: `By ${actor.name}` })), actor.userId)
}

/** Detail changes (priority / description / deadline) → current owner and assignees. */
export async function taskChanged(env: Env, w: Waiter, taskId: string, actor: Actor, changes: Record<string, { from: unknown; to: unknown }>) {
  const t = await taskCtx(env.DB, taskId)
  if (!t) return
  const p = await taskParticipants(env.DB, taskId)
  const workers = uniq([p.responsible, ...p.assignees])
  const items: NotificationInput[] = []
  if (changes.due_date) {
    const from = (changes.due_date.from as string | null) ?? null
    const to = (changes.due_date.to as string | null) ?? null
    const extended = Boolean(from && to && to > from)
    items.push(...workers.map((u) => ({
      userId: u, event: extended ? ('TASK_DEADLINE_EXTENDED' as const) : ('TASK_DEADLINE_CHANGED' as const), ...base(t),
      title: `${extended ? 'Deadline extended' : 'Deadline changed'}: ${label(t)}`, body: `${from ?? 'none'} → ${to ?? 'none'}`,
      email: { intro: `${actor.name} changed the deadline of your task.`, details: details(t, [['Previous deadline', from ?? 'None'], ['New deadline', to ?? 'None']]) },
    })))
  }
  const other: string[] = []
  if (changes.priority) other.push(`priority ${PRIORITY_LABEL[changes.priority.from as Priority] ?? changes.priority.from} → ${PRIORITY_LABEL[changes.priority.to as Priority] ?? changes.priority.to}`)
  if (changes.description) other.push('description updated')
  if (changes.title) other.push('renamed')
  if (other.length) {
    items.push(...workers.map((u) => ({
      userId: u, event: 'TASK_UPDATED' as const, ...base(t), title: `Updated: ${label(t)}`, body: other.join(' · '),
      priority: changes.priority && ['high', 'urgent'].includes(String(changes.priority.to)) ? ('normal' as const) : undefined,
    })))
  }
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

/** Status transitions outside submit/review. */
export async function taskStatusChanged(env: Env, w: Waiter, taskId: string, actor: Actor, from: TaskStatus, to: TaskStatus, note?: string) {
  const t = await taskCtx(env.DB, taskId)
  if (!t || from === to) return
  const p = await taskParticipants(env.DB, taskId)
  const workers = uniq([p.responsible, ...p.assignees])
  const reviewers = await projectReviewers(env.DB, t.project_id)
  const overseers = uniq([...p.managers, ...reviewers, p.creator])
  const s = (x: TaskStatus) => TASK_STATUS_LABEL[x]
  let items: NotificationInput[] = []
  if (to === 'blocked') {
    items = overseers.map((u) => ({ userId: u, event: 'TASK_BLOCKED' as const, ...base(t), title: `Blocked: ${label(t)}`, body: note ?? '', email: { intro: `${actor.name} marked this task as blocked.`, details: details(t), message: note ?? '' } }))
  } else if (from === 'blocked' && to !== 'cancelled' && to !== 'completed') {
    items = overseers.map((u) => ({ userId: u, event: 'TASK_UNBLOCKED' as const, ...base(t), title: `Unblocked: ${label(t)}`, body: `${s(from)} → ${s(to)}` }))
  } else if (to === 'in_progress' && (from === 'todo' || from === 'backlog')) {
    items = overseers.map((u) => ({ userId: u, event: 'TASK_STARTED' as const, ...base(t), title: `Started: ${label(t)}`, body: `by ${actor.name}`, dedupeKey: `started:${t.id}` }))
  } else if (to === 'completed') {
    items = uniq([...overseers, ...workers]).map((u) => ({ userId: u, event: 'TASK_COMPLETED' as const, ...base(t), title: `Completed: ${label(t)}`, body: `by ${actor.name}`, email: { intro: `${actor.name} completed this task.`, details: details(t) } }))
  } else if (to === 'cancelled') {
    items = workers.map((u) => ({ userId: u, event: 'TASK_CANCELLED' as const, ...base(t), title: `Cancelled: ${label(t)}`, body: note ?? '' }))
  } else if (from === 'completed' || from === 'cancelled') {
    items = workers.map((u) => ({ userId: u, event: 'TASK_REOPENED' as const, ...base(t), title: `Reopened: ${label(t)}`, body: note || `${s(from)} → ${s(to)}` }))
  }
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

export async function taskSubmitted(env: Env, w: Waiter, taskId: string, actor: Actor, note: string) {
  const t = await taskCtx(env.DB, taskId)
  if (!t) return
  const reviewers = await projectReviewers(env.DB, t.project_id)
  await notify(env, w, reviewers.map((u) => ({
    userId: u, event: 'TASK_SUBMITTED' as const, ...base(t), title: `Review requested: ${label(t)}`, body: `${actor.name} · ${t.reference}`,
    email: { intro: `${actor.name} submitted this task for your review.`, details: details(t, [['Submitted by', actor.name], ['Submitted at', time()]]), message: note, actionLabel: 'Review task' },
  })), actor.userId, { actorName: actor.name })
}

export async function taskReviewed(env: Env, w: Waiter, taskId: string, actor: Actor, recipients: string[], approved: boolean, title: string, note: string) {
  const t = await taskCtx(env.DB, taskId)
  if (!t) return
  const items: NotificationInput[] = recipients.map((u) => ({
    userId: u, event: approved ? ('TASK_APPROVED' as const) : ('TASK_REVISION_REQUESTED' as const), ...base(t), title, body: note,
    email: { intro: approved ? `${actor.name} approved your work.` : `${actor.name} asked for changes to your work.`, details: details(t, [['Reviewed by', actor.name]]), message: note, actionLabel: approved ? 'Open task' : 'See requested changes' },
  }))
  if (approved && t.status === 'completed') {
    const overseers = uniq([...(await projectManagers(env.DB, t.project_id)), t.created_by]).filter((u) => !recipients.includes(u))
    items.push(...overseers.map((u) => ({ userId: u, event: 'TASK_COMPLETED' as const, ...base(t), title: `Completed: ${label(t)}`, body: `Approved by ${actor.name}` })))
  }
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

/** Extract @mentions the client sent, keeping only people who can read the project. */
export async function validMentions(db: D1Database, projectId: string, ids: string[]): Promise<string[]> {
  const out: string[] = []
  for (const id of uniq(ids).slice(0, 20)) if (await canReadProject(db, id, projectId)) out.push(id)
  return out
}

/**
 * Discussion fan-out. Each person gets exactly one notification for a comment, most specific first:
 * mention > reply to their comment / thread > new comment on a task they participate in.
 */
export async function taskCommented(env: Env, w: Waiter, taskId: string, actor: Actor, comment: { id: string; body: string; parentId: string | null; mentions: string[] }) {
  const t = await taskCtx(env.DB, taskId)
  if (!t) return
  const p = await taskParticipants(env.DB, taskId)
  const sent = new Set<string>([actor.userId])
  const items: NotificationInput[] = []
  const excerpt = comment.body.length > 160 ? comment.body.slice(0, 157) + '…' : comment.body
  const managers = new Set(p.managers)
  const role = managers.has(actor.userId) ? 'Project manager' : p.responsible === actor.userId || p.assignees.includes(actor.userId) ? 'Assignee' : 'Team member'
  const common = (event: 'TASK_MENTIONED' | 'TASK_COMMENT_REPLIED' | 'TASK_COMMENT_CREATED', title: string, intro: string, subject: string) => ({
    event, ...base(t), link: `/tasks/${t.id}#comment-${comment.id}`, title, body: excerpt,
    dedupeKey: `comment:${comment.id}`,
    email: { subject, intro, details: details(t, [['Commented by', `${actor.name} (${role})`], ['Comment time', time()]]), message: comment.body, outro: 'Please open the CRM task discussion to review and reply.', actionLabel: 'Open discussion' },
  })
  for (const u of comment.mentions) {
    if (sent.has(u)) continue
    sent.add(u)
    items.push({ userId: u, ...common('TASK_MENTIONED', `${actor.name} mentioned you on ${label(t)}`, `${actor.name} mentioned you in a task discussion.`, `You were mentioned – ${t.title}`) })
  }
  if (comment.parentId) {
    const parent = await one<{ author_id: string }>(env.DB, `SELECT author_id FROM comments WHERE id = ? AND entity_type = 'task' AND entity_id = ?`, comment.parentId, t.id)
    const thread = await env.DB.prepare(`SELECT DISTINCT author_id FROM comments WHERE parent_id = ? AND deleted_at IS NULL`).bind(comment.parentId).all<{ author_id: string }>()
    const threadPeople = uniq([parent?.author_id, ...(thread.results ?? []).map((r) => r.author_id)]).filter((u) => p.all.includes(u) || u === parent?.author_id)
    for (const u of threadPeople) {
      if (sent.has(u)) continue
      sent.add(u)
      const own = u === parent?.author_id
      const replier = managers.has(actor.userId) ? 'Manager reply' : 'Reply'
      items.push({ userId: u, ...common('TASK_COMMENT_REPLIED', `${actor.name} replied${own ? ' to your comment' : ''} on ${label(t)}`, `${actor.name} replied ${own ? 'to your comment' : 'in a thread you joined'}.`, `${replier} – ${t.title}`) })
    }
  }
  for (const u of p.all) {
    if (sent.has(u)) continue
    sent.add(u)
    items.push({ userId: u, ...common('TASK_COMMENT_CREATED', `${actor.name} commented on ${label(t)}`, 'A new comment has been added to your task.', `New Comment – ${t.title}`) })
  }
  await notify(env, w, items, actor.userId, { actorName: actor.name })
}

/** Edits never re-notify the thread; only people newly @mentioned by the edit hear about it (in-app + push). */
export async function taskCommentEdited(env: Env, w: Waiter, taskId: string, actor: Actor, comment: { id: string; body: string; newMentions: string[] }) {
  const t = await taskCtx(env.DB, taskId)
  if (!t || comment.newMentions.length === 0) return
  await notify(env, w, comment.newMentions.map((u) => ({
    userId: u, event: 'TASK_MENTIONED' as const, ...base(t), link: `/tasks/${t.id}#comment-${comment.id}`, channels: ['in_app' as const, 'push' as const],
    title: `${actor.name} mentioned you on ${label(t)}`, body: comment.body.slice(0, 160), dedupeKey: `comment-mention:${comment.id}`,
  })), actor.userId, { actorName: actor.name })
}

export async function taskAttachmentAdded(env: Env, w: Waiter, taskId: string, actor: Actor, fileName: string) {
  const t = await taskCtx(env.DB, taskId)
  if (!t) return
  const p = await taskParticipants(env.DB, taskId)
  await notify(env, w, p.all.map((u) => ({ userId: u, event: 'TASK_ATTACHMENT_ADDED' as const, ...base(t), title: `${actor.name} attached ${fileName}`, body: label(t) })), actor.userId, { actorName: actor.name })
}
