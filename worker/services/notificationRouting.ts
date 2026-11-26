// Recipient routing: who should hear about an event. Every helper returns ACTIVE user ids only. Callers combine
// them per the routing rules (docs/NOTIFICATIONS.md → Routing) and notify() still drops the actor and applies
// preferences. Keep privacy in mind: HR-only material goes to HR holders, never to "all admins".

import { many } from '../lib/db'
import { usersWithPermission } from './notify'

const uniq = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => Boolean(x)))]

export async function usersWithRoles(db: D1Database, roleKeys: string[]): Promise<string[]> {
  if (roleKeys.length === 0) return []
  const rows = await many<{ id: string }>(
    db,
    `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.status = 'active' AND r.key IN (${roleKeys.map(() => '?').join(', ')})`,
    ...roleKeys.slice(0, 20),
  )
  return rows.map((r) => r.id)
}

/** HR staff: anyone who manages attendance (HR Manager, Super Admin, or custom roles granted it). */
export const hrUsers = (db: D1Database) => usersWithPermission(db, 'attendance.manage')
export const adminUsers = (db: D1Database) => usersWithRoles(db, ['admin'])
export const superAdmins = (db: D1Database) => usersWithRoles(db, ['super_admin'])

export async function activeOnly(db: D1Database, ids: string[]): Promise<string[]> {
  const list = uniq(ids)
  if (list.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90)
    const rows = await many<{ id: string }>(db, `SELECT id FROM users WHERE status = 'active' AND id IN (${part.map(() => '?').join(', ')})`, ...part)
    out.push(...rows.map((r) => r.id))
  }
  return out
}

export async function managerOf(db: D1Database, userId: string): Promise<string | null> {
  const r = await many<{ manager_user_id: string | null }>(db, `SELECT ep.manager_user_id FROM employee_profiles ep JOIN users u ON u.id = ep.manager_user_id WHERE ep.user_id = ? AND u.status = 'active'`, userId)
  return r[0]?.manager_user_id ?? null
}

/** Project manager of record + every team member (viewers included: they follow the project). */
export async function projectTeam(db: D1Database, projectId: string, opts: { excludeViewers?: boolean } = {}): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT p.manager_id AS user_id FROM projects p WHERE p.id = ? AND p.manager_id IS NOT NULL
     UNION SELECT pm.user_id FROM project_members pm WHERE pm.project_id = ? ${opts.excludeViewers ? `AND pm.role <> 'viewer'` : ''}`,
    projectId,
    projectId,
  )
  return activeOnly(db, rows.map((r) => r.user_id))
}

/** Project managers of record and member-managers. */
export async function projectManagers(db: D1Database, projectId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT manager_id AS user_id FROM projects WHERE id = ? AND manager_id IS NOT NULL UNION SELECT user_id FROM project_members WHERE project_id = ? AND role = 'manager'`,
    projectId,
    projectId,
  )
  return activeOnly(db, rows.map((r) => r.user_id))
}

export interface TaskParticipants {
  responsible: string | null
  assignees: string[]
  creator: string | null
  managers: string[]
  commenters: string[]
  /** Everyone above, de-duplicated. */
  all: string[]
}

/** People involved in a task's discussion: owner, assignees, creator, project managers, previous commenters. */
export async function taskParticipants(db: D1Database, taskId: string): Promise<TaskParticipants> {
  const t = (await many<{ responsible_id: string | null; created_by: string | null; project_id: string }>(db, 'SELECT responsible_id, created_by, project_id FROM tasks WHERE id = ?', taskId))[0]
  if (!t) return { responsible: null, assignees: [], creator: null, managers: [], commenters: [], all: [] }
  const [assignees, commenters, managers] = await Promise.all([
    many<{ user_id: string }>(db, 'SELECT user_id FROM task_assignees WHERE task_id = ?', taskId),
    many<{ author_id: string }>(db, `SELECT DISTINCT author_id FROM comments WHERE entity_type = 'task' AND entity_id = ? AND deleted_at IS NULL`, taskId),
    projectManagers(db, t.project_id),
  ])
  const a = assignees.map((r) => r.user_id)
  const cm = commenters.map((r) => r.author_id)
  const all = await activeOnly(db, uniq([t.responsible_id, ...a, t.created_by, ...managers, ...cm]))
  const ok = new Set(all)
  return {
    responsible: t.responsible_id && ok.has(t.responsible_id) ? t.responsible_id : null,
    assignees: a.filter((x) => ok.has(x)),
    creator: t.created_by && ok.has(t.created_by) ? t.created_by : null,
    managers,
    commenters: cm.filter((x) => ok.has(x)),
    all,
  }
}

/** Can `userId` read this project (manager, member or projects.read_all)? Used to validate @mentions. */
export async function canReadProject(db: D1Database, userId: string, projectId: string): Promise<boolean> {
  const r = await many<{ x: number }>(
    db,
    `SELECT 1 AS x FROM users u WHERE u.id = ? AND u.status = 'active' AND (
        EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.manager_id = u.id)
     OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ? AND pm.user_id = u.id)
     OR EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = 'projects.read_all'))`,
    userId,
    projectId,
    projectId,
  )
  return r.length > 0
}

/** Leave approvers for an employee: their reporting manager plus leave.approve holders. */
export async function leaveApprovers(db: D1Database, userId: string): Promise<string[]> {
  const [mgr, approvers] = await Promise.all([managerOf(db, userId), usersWithPermission(db, 'leave.approve')])
  return uniq([...(mgr ? [mgr] : []), ...approvers])
}

export { uniq }
