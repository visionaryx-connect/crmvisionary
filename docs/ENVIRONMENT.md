# Environment configuration

Three environments share one codebase. Non-secret values live in `wrangler.jsonc` (`vars`); secrets are set with `wrangler secret put` (or `.dev.vars` locally, which is git-ignored).

| Name | Kind | development (local) | staging | production |
|---|---|---|---|---|
| `APP_ENV` | var | `development` | `staging` | `production` |
| `APP_ORIGIN` | var | `http://localhost:5173` | `https://crm-staging.visionary-x.in` | `https://crm.visionary-x.in` |
| `COMPANY_TIMEZONE` | var | `Asia/Kolkata` | `Asia/Kolkata` | `Asia/Kolkata` |
| `SESSION_SECRET` | **secret** | `.dev.vars` | `wrangler secret put … --env staging` | `wrangler secret put … --env production` |
| `DATA_KEY` | **secret** | `.dev.vars` | `wrangler secret put … --env staging` | `wrangler secret put … --env production` |
| `BREVO_API_KEY` | **secret** (optional) | `.dev.vars` | `wrangler secret put … --env staging` | `wrangler secret put … --env production` |
| `BREVO_SENDER_EMAIL` | var or secret (optional) | `.dev.vars` | verified sender | verified sender |
| `BREVO_SENDER_NAME` | var | `Visionary X` | `Visionary X` | `Visionary X` |
| `BREVO_WEBHOOK_SECRET` | **secret** (optional) | `.dev.vars` | `wrangler secret put …` | `wrangler secret put …` |
| `VAPID_PUBLIC_KEY` | var or secret (optional) | `.dev.vars` | per environment | per environment |
| `VAPID_PRIVATE_KEY` | **secret** (optional) | `.dev.vars` | `wrangler secret put …` | `wrangler secret put …` |
| `VAPID_SUBJECT` | var or secret (optional) | `.dev.vars` | `mailto:…` | `mailto:…` |
| `DB` | D1 binding | local SQLite under `.wrangler/state` | `visionaryx-ops-staging` | `visionaryx-ops` |
| `FILES` | R2 binding (optional) | local emulation | `visionaryx-ops-files-staging` | `visionaryx-ops-files` |
| `REALTIME` | Durable Object | local | `RealtimeHub` | `RealtimeHub` |

## Values

- **`APP_ORIGIN`** — the exact public origin. Mutating API requests and WebSocket upgrades from any other `Origin` are rejected.
- **`APP_ENV`** — `development`/`test` disable the `Secure` cookie flag and the `__Host-` cookie prefix so plain-HTTP localhost works. Staging and production always use `Secure`, `HttpOnly`, `__Host-` cookies.
- **`SESSION_SECRET`** — 32+ random bytes (hex). Reserved for HMAC signatures (session tokens themselves are random and stored hashed, so they don't depend on it).
- **`DATA_KEY`** — exactly 32 random bytes, base64. AES-256-GCM key for TOTP secrets at rest.

Generate values:

```bash
node -e "const c=require('crypto');console.log('SESSION_SECRET='+c.randomBytes(32).toString('hex'));console.log('DATA_KEY='+c.randomBytes(32).toString('base64'))"
```

Notification credentials (Brevo, VAPID) are optional: each channel stays off until set. Setup, DNS records and verification: [NOTIFICATIONS.md](NOTIFICATIONS.md).

Use different secrets per environment. Never put secrets in `wrangler.jsonc`, the frontend bundle, tickets or chat.

## Settings stored in the database

Company-level rules are not environment variables; they are edited in **Settings** and stored in `company_settings` (validated per key): company profile and client support contact, working weekdays and Saturday rule, office hours and half-day threshold, holiday regions applied, portal link validity / session length / re-verification window, and month-end snapshot generation.
