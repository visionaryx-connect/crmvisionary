-- ════════════════════════════════════════════════════════════════════════════
-- Visionary X Operations — FULL RESET (fresh install, including all users)
--
-- Deletes everything in reset-keep-admin.sql AND every user, including Super
-- Admins. Afterwards nobody can sign in until you create a new Super Admin with
-- scripts/bootstrap-admin.mjs (see docs/DEPLOY_STEP_BY_STEP.md, Step 10).
-- Keeps: roles & permissions, company settings, leave types, service categories.
--
-- This cannot be undone. Take a backup first (scripts/backup.sh).
-- ════════════════════════════════════════════════════════════════════════════
PRAGMA defer_foreign_keys = true;

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
DELETE FROM event_attendees;
DELETE FROM calendar_events;
DELETE FROM holidays;
DELETE FROM working_day_overrides;
DELETE FROM client_interactions;
DELETE FROM portal_sessions;
DELETE FROM client_access_tokens;
DELETE FROM projects;
DELETE FROM client_contacts;
DELETE FROM client_service_categories;
DELETE FROM clients;
DELETE FROM leave_requests;
DELETE FROM leave_balances;
DELETE FROM attendance_corrections;
DELETE FROM attendance_records;
DELETE FROM notifications;
DELETE FROM notification_preferences;
DELETE FROM report_snapshots;
DELETE FROM activity_logs;
DELETE FROM rate_limits;

UPDATE company_settings SET updated_by = NULL;
DELETE FROM mfa_recovery_codes;
DELETE FROM auth_tokens;
DELETE FROM sessions;
DELETE FROM employee_skills;
DELETE FROM employee_profiles;
DELETE FROM departments;
DELETE FROM user_roles;
DELETE FROM users;

SELECT
  (SELECT COUNT(*) FROM users)    AS users,
  (SELECT COUNT(*) FROM clients)  AS clients,
  (SELECT COUNT(*) FROM projects) AS projects,
  (SELECT COUNT(*) FROM roles)    AS roles_kept,
  (SELECT COUNT(*) FROM company_settings) AS settings_kept;
