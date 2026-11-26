# Smart notifications & communication

Every CRM module raises notifications through one engine (`worker/services/notify.ts`). One event produces an in-app notification (live over the existing WebSocket), and depending on rules and preferences a **Brevo transactional email** and a **Web Push** notification to each of the person's devices. Everything is recorded, de-duplicated, retried and visible in **Administration → Notification center**.

Email and push stay **off** until their secrets are set. Without them the CRM works exactly as before, with in-app notifications only.

## 1. How it works

```
CRM write (task, attendance, leave, …) succeeds
        │
        ▼
notify(env, ctx, items, actorId)              worker/services/notify.ts
  1. event definition = registry (shared/notificationEvents.ts) + Super Admin overrides (notification_rules)
  2. drop the actor, inactive accounts and duplicates (dedupe key per recipient)
  3. per channel: recipient preferences (mandatory events bypass), email suppression, quiet hours, devices
  4. write notifications (in-app) + notification_events (timeline) + notification_deliveries (outbox)
  5. realtime "notification.created" → bell, inbox, toast
  6. ctx.waitUntil(processDeliveries)          never inside the caller's DB transaction
        │
        ▼
notification_deliveries (durable outbox)        worker/services/notificationQueue.ts
  claim (queued|retry → sending) ─► Brevo API / Web Push ─► accepted | sent | retry (backoff) | failed
        ▲
        └── every 5 minutes, the cron also: retries due rows, releases stuck locks,
            runs scheduled jobs (worker/services/notificationSchedule.ts)

Brevo webhook ─► /api/webhooks/brevo ─► delivered / opened / bounced / blocked / spam …
```

| Piece | File |
|---|---|
| Event registry (≈100 events, categories, preference groups, defaults) | `shared/notificationEvents.ts` |
| Engine | `worker/services/notify.ts` |
| Recipient routing helpers | `worker/services/notificationRouting.ts` |
| Module integrations | `worker/services/taskNotifications.ts`, `worker/services/moduleNotifications.ts` (called from each route) |
| Brevo client | `worker/services/brevo.ts` |
| Web Push (RFC 8291 encryption + RFC 8292 VAPID on WebCrypto) | `worker/services/push.ts` |
| Email / push templates | `worker/services/notificationTemplates.ts` |
| Outbox worker, retries | `worker/services/notificationQueue.ts` |
| Scheduler (attendance, deadlines, digests, reports, escalation, meetings, announcements) | `worker/services/notificationSchedule.ts`, `worker/services/notificationDigest.ts` |
| Announcements and messages | `worker/services/notificationBroadcast.ts` |
| APIs | `worker/routes/notifications.ts` (own inbox), `worker/routes/notificationAdmin.ts`, `worker/routes/webhooks.ts` |
| UI | `src/pages/Notifications.tsx`, `src/pages/admin/NotificationCenter.tsx`, `src/components/TaskDiscussion.tsx`, bell in `src/layout/AppShell.tsx` |
| Service worker (push display, click → deep link) | `public/sw.js` |
| Schema | `migrations/0007_notification_engine.sql` |

**Why an outbox instead of Cloudflare Queues:** the D1 outbox gives the same guarantees (persistence, per-channel independence, idempotent claim, exponential backoff, dead-letter state, manual retry) with no extra binding or plan requirement. A delivery is sent immediately via `waitUntil`; anything that fails or is deferred by quiet hours is picked up by the 5-minute cron. Up to 300 deliveries are dispatched immediately per event; the rest go at 100 per cron tick.

**Adding a new module:** add its events to `NOTIFICATION_EVENTS`, then call `notify()` with `event: 'YOUR_EVENT'` after the module's write succeeds. Rules, preferences, templates, delivery, retries, analytics and the admin pages pick it up automatically.

### Retry policy

| Outcome | Email (Brevo) | Push |
|---|---|---|
| Success | `accepted` (2xx). **Not proof of delivery.** `delivered` comes only from the webhook | `sent` (2xx from the push service) |
| Temporary failure (network, 429, 5xx) | `retry` after 1 min, 5 min, 15 min, 1 h, 3 h, then `failed` | same |
| Permanent failure (400/422 invalid, 401/403 credentials) | `failed`. Credential problems alert Super Admins in-app (once a day) | 404/410 → subscription `expired`; 401/403 → `failed` plus an alert |
| Bounce / block / spam / unsubscribe (webhook) | `bounced` / `blocked` / `spam` / `unsubscribed`. The address is **suppressed** until an admin clears it | — |

Failed rows can be re-queued from Notification center → Delivery logs, one at a time or all failures from the last 7 days.

## 2. Routing

| Event | Recipients |
|---|---|
| Task assigned / reassigned | the assignees (all channels) + the project managers (in-app heads-up) |
| Task removed from someone | the removed person |
| Deadline / priority / description change | owner + assignees |
| Task blocked / started / unblocked | project managers, reviewers, creator |
| Task completed | managers, reviewers, creator, assignees |
| Submitted for review | project reviewers |
| Approved / revisions requested | submitter + owner (plus managers when completed) |
| Comment | every participant (owner, assignees, creator, project managers, previous commenters), except the author |
| Reply | the parent comment's author + people in that thread |
| @mention | the mentioned person (must be able to read the project; others are ignored) |
| Each person gets **one** notification per comment: mention > reply > comment. Editing a comment never re-notifies; only people *newly* mentioned by the edit get a mention (in-app + push). |
| Overdue | owner daily (up to *max reminders*), project manager weekly, then **HR + Admin** after N days, then **Super Admin** after M days for selected priorities |
| Project update (internal or client-visible) | project team (internal staff only; clients never receive these) |
| Project status / deadline / milestones | project team; new manager gets "Project assigned" |
| Leave request | the employee's reporting manager + leave approvers |
| Leave decision | the employee (all channels) + manager and HR (in-app) |
| Attendance correction | HR (request); the employee (decision) |
| HR edits a profile | the employee; old/new managers for reporting-line changes; department head for department moves |
| New account | HR; Super Admins when an Admin / Super Admin role is granted |
| Meetings | attendees (invited, rescheduled, cancelled, removed, reminder before start) |
| Client feedback / approvals (portal) | project reviewers + the account manager |
| Announcements | the selected audience (all, departments, project teams, roles, individuals) |
| Security events | the affected person (mandatory); Super Admins for admin grants, permission and settings changes |

**Privacy.** HR material goes to people holding `attendance.manage` / `leave.approve`, never to "all admins". Events marked *private* (leave requests, profile updates, birthdays) send a generic line in email and push ("There is an update for you… sign in to view"). The full text stays in the CRM. Email and push links are in-app paths, and the page re-checks permissions when it opens. Company-wide notification visibility (`notifications.read_all`) belongs to Super Admin only by default.

## 3. Permissions

| Permission | Default roles | Allows |
|---|---|---|
| `notifications.read_all` | Super Admin | every notification, event, delivery log, device, analytics, export |
| `notifications.manage` | Super Admin | rules, templates, schedules, escalation, retries, device revocation, test email, manual job runs, mandatory notices |
| `notifications.broadcast` | Super Admin, Admin, HR Manager | announcements and messages (own history; company-wide sends need explicit confirmation) |
| `attendance.manage` | HR Manager, Super Admin | also edit the attendance schedule |

These are editable per role under Users & roles.

## 4. Scheduled automation (company time, Asia/Kolkata)

The Worker has two cron triggers: the existing daily `30 2 * * *` (08:00: due-tomorrow and overdue reminders, delayed projects, housekeeping, month-end snapshots) and the new **`*/5 * * * *`** tick. Each time-of-day job runs **once per day** (unique run key in `notification_jobs`) and only within 60 minutes after its slot, so a late deploy never sends a 09:45 reminder at 15:00. Attendance and digest jobs run only on working days (weekly rule, verified holidays, overrides).

| Default | Job |
|---|---|
| 09:00 | daily task summary (per employee, opt-out), due-today reminders, leave reminders, birthdays / anniversaries |
| 09:45 | check-in reminder (skips approved leave, first-half leave, people not yet joined or exited) |
| 10:00 | check-ins after this count as late (employee + HR in-app at check-in) |
| 10:15 | late detection: not-yet-in employees reminded; HR gets the list |
| 10:30 | overdue-task escalation |
| 11:00 | missing attendance: the employee (email + push) and HR's missing report. **Never written as absent.** |
| 13:00 | exception report → HR, Admin, Super Admin (only if there are exceptions) |
| dayEnd − 2 h / − 30 min | task deadline reminders (deadline = end of working day, `workdays.hours.dayEnd`) |
| 18:00 | checkout reminder; check-outs before this are early departures |
| 18:30 | missing checkout → employee + HR |
| 19:00 | daily reports: Super Admin (company + delivery failures), Admin (operations), HR (attendance, leave, workload). One per person, the most complete one |
| Monday 09:30 | weekly report + workload alerts (to reporting managers) + personal weekly digests |
| 1st 10:00 | monthly report + each employee's own attendance for the previous month |
| every 5 min | meeting reminders (event reminder or default 15 min), scheduled announcements, acknowledgement reminders (24 h) and manager follow-up (48 h), outbox retries |
| 03:00 | retention: delivery events 90 days, deliveries 180 days, events 365 days, archived notifications 180 days |

Change them in Notification center → Schedules & escalation. Use **Jobs & escalations → Run now** to run any job immediately (per-day de-duplication still applies).

The CRM has no shift model. Attendance uses the single working-day window from Settings → Office hours. Per-shift schedules would need a shift table; the snapshot in `notificationDigest.ts` is the place to add it.

## 5. Brevo setup (transactional email)

1. **Account.** Create a Brevo account for the company. Under *Transactional*, check that transactional email is activated. New accounts can need Brevo's review before sending.
2. **Domain.** *Senders, Domains & Dedicated IPs → Domains → Add a domain*: `visionary-x.in`. Brevo shows the DNS records to add at your DNS host (Cloudflare DNS if the zone is there):
   - **Brevo code** (TXT) for ownership,
   - **DKIM** (TXT or CNAME, as shown),
   - **SPF**: add `include:spf.brevo.com` to the **existing** SPF TXT record, keeping one SPF record per domain, e.g. `v=spf1 include:_spf.google.com include:spf.brevo.com ~all`,
   - **DMARC**: `_dmarc.visionary-x.in` TXT, start with `v=DMARC1; p=none; rua=mailto:dmarc@visionary-x.in`, and tighten to `quarantine` once reports look clean.
   Click *Verify* in Brevo. Don't send production mail until Brevo shows the domain as **authenticated**. DNS can take hours.
3. **Sender.** *Senders → Add a sender*: `Visionary X <notifications@visionary-x.in>`. The mailbox should exist (or forward) so replies and bounces reach someone.
4. **API key.** *SMTP & API → API keys → Generate*. Copy it once; it is shown only at creation. Use a separate key per environment.
5. **Store it as Worker secrets** (never in `wrangler.jsonc`, the frontend, GitHub or chat):
   ```bash
   npx wrangler secret put BREVO_API_KEY --name visionaryx-ops-production
   ```
   ```bash
   npx wrangler secret put BREVO_SENDER_EMAIL --name visionaryx-ops-production
   ```
   `BREVO_SENDER_NAME` defaults to "Visionary X" in `wrangler.jsonc`.
6. **Webhook (delivery tracking).** Generate a secret (32+ random characters):
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   ```bash
   npx wrangler secret put BREVO_WEBHOOK_SECRET --name visionaryx-ops-production
   ```
   In Brevo, *Transactional → Settings → Webhooks → Add a new webhook* (or `POST https://api.brevo.com/v3/webhooks`):
   - URL `https://crm.visionary-x.in/api/webhooks/brevo`
   - events: sent, delivered, opened, clicked, soft bounce, hard bounce, invalid, deferred, blocked, spam, unsubscribed, error
   - **authentication**: add the custom header `X-VX-Webhook-Token: <the secret>` (API: `"headers": [{"key": "X-VX-Webhook-Token", "value": "<secret>"}]`). A bearer token (`Authorization: Bearer <secret>`) is also accepted.

   Requests without the secret get 401 and are rate limited. Duplicate events are stored once.
7. **Check it.** Notification center → Overview → **Send me a test email** sends synchronously and shows Brevo's response and message id. Then watch Delivery logs: the row should move from `accepted` to `delivered` when the webhook arrives. If it stays at `accepted`, the webhook is not reaching the Worker.

## 6. Web Push setup (VAPID)

1. Generate one key pair **per environment** and keep it. Rotating it invalidates every browser subscription.
   ```bash
   node scripts/gen-vapid.mjs
   ```
2. Store the keys:
   ```bash
   npx wrangler secret put VAPID_PRIVATE_KEY --name visionaryx-ops-production
   ```
   ```bash
   npx wrangler secret put VAPID_PUBLIC_KEY --name visionaryx-ops-production
   ```
   ```bash
   npx wrangler secret put VAPID_SUBJECT --name visionaryx-ops-production
   ```
   (`VAPID_SUBJECT` is a contact such as `mailto:it@visionary-x.in`. The public key is safe to expose; it is served to browsers by `/api/notifications/push/config`.)
3. Each person enables push from **Notifications → Preferences → Devices → Enable on this device**. The browser permission prompt appears only after that click. If they deny it, the CRM never asks again and explains how to re-allow it in site settings. iPhone / iPad: push works only for the **installed** app (Share → Add to Home Screen, iOS 16.4+), which the page explains.
4. **Send test** on the same panel delivers to the person's own devices and reports the real outcome.

The implementation uses WebCrypto (ECDH P-256, HKDF, AES-128-GCM, ECDSA). The Node `web-push` package depends on Node crypto APIs that Workers do not fully provide. The encryption is verified against the RFC 8291 test vector in `tests/notifications.test.ts`.

## 7. Deploying

Same flow as [DEPLOY_STEP_BY_STEP.md](DEPLOY_STEP_BY_STEP.md). Production shown; for staging use `--env staging`, `CLOUDFLARE_ENV=staging` and `--name visionaryx-ops-staging`.

```bash
npx wrangler d1 migrations apply visionaryx-ops --remote --env production -c wrangler.jsonc
```
```bash
CLOUDFLARE_ENV=production npm run build && npx wrangler deploy
```

Then set the secrets from sections 5 and 6 with `--name visionaryx-ops-production`. Secrets take effect immediately, with no redeploy needed. The new cron trigger (`*/5 * * * *`) deploys with the Worker; check it under *Workers → visionaryx-ops-production → Settings → Triggers*.

## 8. Verification checklist

Automated (`npm test`, `tests/notifications.test.ts`, 26 tests): routing per event, mention > reply > comment de-duplication, edits not re-notifying, invalid mentions ignored, preferences per channel, mandatory security bypass, disabled rules, quiet hours, inbox privacy (no cross-user read / ack / list), admin endpoints closed to employees, department-targeted and scheduled broadcasts, company-wide confirmation, HR vs mandatory permission, Brevo request shape (headers, sender, escaping, X-Mailin-custom), message-id capture, no double send, backoff then permanent failure, admin retry, credential-error alert, webhook auth (missing / wrong / header / bearer), delivered tracking, out-of-order events, duplicate webhooks, hard-bounce suppression, template escaping and unsafe-link replacement, RFC 8291 vector and round-trip decryption, VAPID JWT signature, multi-device push with 410 expiry, attendance expected-employee rules (leave, joining date, already checked in), missing ≠ absent, escalation levels / no repeats / resolution, run-once job slots and windows, failed-job alerts, timeline access control.

Manual, on staging, **before calling email or push operational in production**:

- [ ] Brevo domain shows authenticated (SPF, DKIM, DMARC published)
- [ ] Test email → `accepted` with message id → `delivered` via webhook
- [ ] Send to a non-existent address on your domain → `bounced`, address suppressed, cleared from Delivery logs
- [ ] Webhook with a wrong token → 401 (e.g. `curl -X POST …/api/webhooks/brevo -H 'X-VX-Webhook-Token: wrong'`)
- [ ] Push enabled on Chrome desktop, Android Chrome, installed iOS app: test arrives; clicking opens the right page
- [ ] Remove a device in the browser (clear site data), send again → subscription marked expired
- [ ] Comment with an @mention → mentioned person gets an email in the expected format
- [ ] Jobs & escalations → run *Attendance reminder* → only people without a check-in (and not on leave) are notified
- [ ] Announcement to one department with acknowledgement → counts and acknowledgements show in its detail view
- [ ] An Employee account cannot open Notification center pages or call `/api/notifications/admin/*`

Record the results (date, environment, who ran them) in the deployment notes. Until these pass, treat email and push as **configured but unverified**.
