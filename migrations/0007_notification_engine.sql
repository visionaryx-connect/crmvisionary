-- Smart notification & communication engine.
--
-- Extends the existing notifications / notification_preferences tables (no duplicates) and adds:
--   notification_events            one row per CRM event that produced notifications (communication timeline)
--   notification_deliveries        durable outbox + delivery log for email and push (queue, retries, provider ids)
--   notification_delivery_events   provider webhook events (Brevo), de-duplicated
--   push_subscriptions             Web Push subscriptions, several devices per user
--   notification_user_settings     per-user channel switches, quiet hours, digests, email suppression
--   notification_rules             Super Admin overrides of the event registry (enabled / channels / priority / mandatory)
--   notification_templates         admin-edited email and push wording per event
--   notification_broadcasts        announcements and messages (recipients are notifications rows with broadcast_id)
--   notification_escalations       escalation state per rule + record (prevents repeats, closes when resolved)
--   notification_jobs              scheduled job runs (idempotency key per slot + audit of each run)

-- ───────── Extend in-app notifications ─────────
ALTER TABLE notifications ADD COLUMN event_key TEXT;
ALTER TABLE notifications ADD COLUMN category TEXT;
ALTER TABLE notifications ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical','high','normal','low'));
ALTER TABLE notifications ADD COLUMN event_id TEXT;
ALTER TABLE notifications ADD COLUMN actor_id TEXT;
ALTER TABLE notifications ADD COLUMN project_id TEXT;
ALTER TABLE notifications ADD COLUMN broadcast_id TEXT;
ALTER TABLE notifications ADD COLUMN requires_ack INTEGER NOT NULL DEFAULT 0 CHECK (requires_ack IN (0,1));
ALTER TABLE notifications ADD COLUMN acknowledged_at TEXT;
ALTER TABLE notifications ADD COLUMN archived_at TEXT;
ALTER TABLE notifications ADD COLUMN snoozed_until TEXT;
ALTER TABLE notifications ADD COLUMN expires_at TEXT;
CREATE INDEX idx_notifications_category ON notifications(category, created_at);
CREATE INDEX idx_notifications_event ON notifications(event_id);
CREATE INDEX idx_notifications_broadcast ON notifications(broadcast_id);
CREATE INDEX idx_notifications_entity ON notifications(entity_type, entity_id);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Backfill categories for rows written before the engine existed.
UPDATE notifications SET category = CASE
  WHEN kind IN ('task_assigned','review_requested','revision_requested','task_approved') THEN 'task'
  WHEN kind IN ('task_due_soon','task_overdue') THEN 'deadline'
  WHEN kind = 'mention' THEN 'task_comment'
  WHEN kind = 'milestone_updated' THEN 'project'
  WHEN kind = 'client_feedback' THEN 'client'
  WHEN kind IN ('leave_decision','leave_requested') THEN 'leave'
  WHEN kind = 'calendar_changed' THEN 'calendar'
  WHEN kind = 'security' THEN 'security'
  ELSE 'system' END
WHERE category IS NULL;

-- ───────── Preferences: per group × channel ─────────
-- The email column existed but was never exposed, so stored 0s are defaults, not choices: reset to opted in.
ALTER TABLE notification_preferences ADD COLUMN push INTEGER NOT NULL DEFAULT 1;
UPDATE notification_preferences SET email = 1;

CREATE TABLE notification_user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0,1)),
  push_enabled       INTEGER NOT NULL DEFAULT 1 CHECK (push_enabled IN (0,1)),
  quiet_start        TEXT CHECK (quiet_start IS NULL OR quiet_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  quiet_end          TEXT CHECK (quiet_end IS NULL OR quiet_end GLOB '[0-2][0-9]:[0-5][0-9]'),
  daily_digest       INTEGER NOT NULL DEFAULT 1 CHECK (daily_digest IN (0,1)),
  weekly_digest      INTEGER NOT NULL DEFAULT 1 CHECK (weekly_digest IN (0,1)),
  email_suppressed_at     TEXT,                 -- set by hard bounce / block / spam / unsubscribe webhooks
  email_suppressed_reason TEXT,
  updated_at         TEXT NOT NULL
);

-- ───────── Events (communication timeline) ─────────
CREATE TABLE notification_events (
  id              TEXT PRIMARY KEY,
  event_key       TEXT NOT NULL,
  category        TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal',
  title           TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  project_id      TEXT,
  actor_id        TEXT,
  broadcast_id    TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  channels        TEXT NOT NULL DEFAULT '[]',     -- JSON array of channels actually used
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_notification_events_entity ON notification_events(entity_type, entity_id, created_at);
CREATE INDEX idx_notification_events_project ON notification_events(project_id, created_at);
CREATE INDEX idx_notification_events_created ON notification_events(created_at);
CREATE INDEX idx_notification_events_key ON notification_events(event_key, created_at);

-- ───────── Outbox + delivery log ─────────
CREATE TABLE notification_deliveries (
  id                  TEXT PRIMARY KEY,
  notification_id     TEXT REFERENCES notifications(id) ON DELETE SET NULL,
  event_id            TEXT,
  event_key           TEXT NOT NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('email','push')),
  status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','retry','accepted','sent','deferred','delivered','opened','clicked','failed','bounced','blocked','spam','unsubscribed','skipped')),
  priority            TEXT NOT NULL DEFAULT 'normal',
  dedupe_key          TEXT NOT NULL UNIQUE,         -- one delivery per recipient × channel × logical notification
  payload             TEXT NOT NULL,                -- JSON render data (title, body, link, email content); rendered at send time
  recipient           TEXT,                         -- email address used, or number of devices for push
  subject             TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT NOT NULL,
  locked_at           TEXT,
  provider            TEXT,                         -- 'brevo' | 'webpush'
  provider_message_id TEXT,
  provider_response   TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  sent_at             TEXT,
  delivered_at        TEXT,
  opened_at           TEXT,
  clicked_at          TEXT
);
CREATE INDEX idx_deliveries_due ON notification_deliveries(status, next_attempt_at);
CREATE INDEX idx_deliveries_user ON notification_deliveries(user_id, created_at);
CREATE INDEX idx_deliveries_channel ON notification_deliveries(channel, status, created_at);
CREATE INDEX idx_deliveries_created ON notification_deliveries(created_at);
CREATE INDEX idx_deliveries_message ON notification_deliveries(provider_message_id);

CREATE TABLE notification_delivery_events (
  id           TEXT PRIMARY KEY,
  delivery_id  TEXT REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  event        TEXT NOT NULL,
  message_id   TEXT,
  email        TEXT,
  reason       TEXT,
  occurred_at  TEXT,
  dedupe_key   TEXT NOT NULL UNIQUE,
  raw          TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX idx_delivery_events_delivery ON notification_delivery_events(delivery_id, received_at);
CREATE INDEX idx_delivery_events_received ON notification_delivery_events(received_at);

-- ───────── Web Push devices ─────────
CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  device_label    TEXT NOT NULL DEFAULT '',
  user_agent      TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','revoked')),
  expires_at      TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, status);

-- ───────── Configuration ─────────
CREATE TABLE notification_rules (
  event_key  TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  channels   TEXT,                                   -- JSON array; NULL = registry default
  priority   TEXT CHECK (priority IS NULL OR priority IN ('critical','high','normal','low')),
  mandatory  INTEGER CHECK (mandatory IS NULL OR mandatory IN (0,1)),
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_templates (
  event_key   TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('email','push')),
  subject     TEXT NOT NULL DEFAULT '',            -- email subject / push title, with {{placeholders}}
  intro       TEXT NOT NULL DEFAULT '',            -- email opening paragraph / push body
  outro       TEXT NOT NULL DEFAULT '',            -- email closing line
  action_label TEXT NOT NULL DEFAULT '',
  updated_by  TEXT REFERENCES users(id),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (event_key, channel)
);

-- ───────── Announcements & messages ─────────
CREATE TABLE notification_broadcasts (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL DEFAULT 'announcement' CHECK (kind IN ('announcement','message')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical','high','normal','low')),
  audience        TEXT NOT NULL,                   -- JSON {all, departmentIds, projectIds, roleKeys, userIds}
  audience_label  TEXT NOT NULL DEFAULT '',
  channels        TEXT NOT NULL,                   -- JSON array
  requires_ack    INTEGER NOT NULL DEFAULT 0 CHECK (requires_ack IN (0,1)),
  mandatory       INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0,1)),
  link            TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','cancelled','failed')),
  scheduled_at    TEXT NOT NULL,
  expires_at      TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  cancelled_at    TEXT,
  cancelled_by    TEXT REFERENCES users(id),
  error           TEXT
);
CREATE INDEX idx_broadcasts_status ON notification_broadcasts(status, scheduled_at);
CREATE INDEX idx_broadcasts_created ON notification_broadcasts(created_at);

-- ───────── Escalations & scheduled jobs ─────────
CREATE TABLE notification_escalations (
  id              TEXT PRIMARY KEY,
  rule_key        TEXT NOT NULL,                   -- e.g. task_overdue
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  cycle_key       TEXT NOT NULL,                   -- e.g. the due date; a new cycle starts when it changes
  level           INTEGER NOT NULL DEFAULT 0,
  reminders       INTEGER NOT NULL DEFAULT 0,
  last_notified_at TEXT,
  resolved_at     TEXT,
  history         TEXT NOT NULL DEFAULT '[]',      -- JSON [{level, at, recipients}]
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (rule_key, entity_id, cycle_key)
);
CREATE INDEX idx_escalations_open ON notification_escalations(rule_key, resolved_at);

CREATE TABLE notification_jobs (
  id          TEXT PRIMARY KEY,
  job_key     TEXT NOT NULL,
  run_key     TEXT NOT NULL UNIQUE,                -- job_key + local date/slot; guarantees one run per slot
  status      TEXT NOT NULL CHECK (status IN ('running','completed','failed','skipped')),
  detail      TEXT NOT NULL DEFAULT '',
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_notification_jobs ON notification_jobs(job_key, started_at);

-- ───────── Task discussion: replies and mentions ─────────
ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id) ON DELETE SET NULL;
ALTER TABLE comments ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';   -- JSON array of user ids
CREATE INDEX idx_comments_parent ON comments(parent_id);

-- ───────── Permissions ─────────
INSERT INTO permissions (key, label, category) VALUES ('notifications.read_all', 'View every notification and delivery log', 'Notifications');
INSERT INTO permissions (key, label, category) VALUES ('notifications.manage', 'Configure notification rules, templates and schedules', 'Notifications');
INSERT INTO permissions (key, label, category) VALUES ('notifications.broadcast', 'Send announcements and messages', 'Notifications');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('role_super_admin', 'notifications.read_all');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('role_super_admin', 'notifications.manage');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('role_super_admin', 'notifications.broadcast');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('role_admin', 'notifications.broadcast');
INSERT INTO role_permissions (role_id, permission_key) VALUES ('role_hr_manager', 'notifications.broadcast');
