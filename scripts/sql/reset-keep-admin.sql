-- ════════════════════════════════════════════════════════════════════════════
-- Visionary X Operations — CLEAR ALL DATA, KEEP SUPER ADMIN LOGIN
--
-- Deletes: clients, contacts, projects, milestones, tasks, time logs, comments,
--          deliverables, files records, portal links, client feedback, calendar,
--          holidays, leave, attendance, notifications, reports, audit/activity
--          log, departments, and every user who is NOT a Super Admin.
-- Keeps:   Super Admin account(s) and their password/2FA, roles & permissions,
--          company settings (working days, automations…), leave types, service
--          categories.
--
-- This cannot be undone. Take a backup first (scripts/backup.sh).
-- ════════════════════════════════════════════════════════════════════════════
PRAGMA defer_foreign_keys = true;

-- Work
DELETE FROM time_entries;
DELETE FROM comments;
DELETE FROM task_submissions;
DELETE FROM task_status_history;
DELETE FROM task_dependencies;
DELETE FROM subtasks;
DELETE FROM task_assignees;
DELETE FROM attachments;
DELETE FROM client_feedback;
DELETE FROM deliverables;
DELETE FROM tasks;
DELETE FROM milestone_dependencies;
DELETE FROM milestones;
DELETE FROM project_updates;
DELETE FROM project_progress_snapshots;
DELETE FROM project_status_history;
DELETE FROM project_members;

-- Calendar
DELETE FROM event_attendees;
DELETE FROM calendar_events;
DELETE FROM holidays;
DELETE FROM working_day_overrides;

-- Clients & portal
DELETE FROM client_interactions;
DELETE FROM portal_sessions;
DELETE FROM client_access_tokens;
DELETE FROM projects;
DELETE FROM client_contacts;
DELETE FROM client_service_categories;
DELETE FROM clients;

-- HR
DELETE FROM leave_requests;
DELETE FROM leave_balances;
DELETE FROM attendance_corrections;
DELETE FROM attendance_records;

-- Platform records
DELETE FROM notifications;
DELETE FROM notification_preferences;
DELETE FROM report_snapshots;
DELETE FROM activity_logs;
DELETE FROM rate_limits;

-- People: keep only Super Admins
UPDATE company_settings SET updated_by = NULL;
UPDATE employee_profiles SET department_id = NULL, manager_user_id = NULL;
DELETE FROM departments;
DELETE FROM users WHERE id NOT IN (
  SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'super_admin'
);
DELETE FROM auth_tokens WHERE used_at IS NOT NULL OR expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Check: everything below should be 0 except users (your Super Admin)
SELECT
  (SELECT COUNT(*) FROM users)    AS users_left,
  (SELECT COUNT(*) FROM clients)  AS clients,
  (SELECT COUNT(*) FROM projects) AS projects,
  (SELECT COUNT(*) FROM tasks)    AS tasks,
  (SELECT COUNT(*) FROM holidays) AS holidays,
  (SELECT COUNT(*) FROM activity_logs) AS activity;
