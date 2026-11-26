import type { RealtimeHub } from './do/RealtimeHub'

export interface Env {
  DB: D1Database
  AI?: Ai
  /** Optional: R2 bucket for attachments. When unbound, uploads are disabled with a clear error. */
  FILES?: R2Bucket
  REALTIME: DurableObjectNamespace<RealtimeHub>
  ASSETS?: Fetcher
  APP_ENV: 'development' | 'staging' | 'production' | 'test'
  APP_ORIGIN: string
  COMPANY_TIMEZONE: string
  SESSION_SECRET: string
  DATA_KEY: string
  // ── Notifications (all optional: a channel stays off until its secrets are set) ──
  /** Brevo transactional email API key (Worker secret). */
  BREVO_API_KEY?: string
  /** Verified sender address in Brevo, e.g. notifications@visionary-x.in (var). */
  BREVO_SENDER_EMAIL?: string
  BREVO_SENDER_NAME?: string
  /** Shared secret Brevo sends in the X-VX-Webhook-Token header (or as a bearer token) on webhook calls (secret). */
  BREVO_WEBHOOK_SECRET?: string
  /** Web Push VAPID keys: public key is served to browsers, private key never leaves the Worker (secret). */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  /** mailto: or https: contact for push services, e.g. mailto:it@visionary-x.in (var). */
  VAPID_SUBJECT?: string
}

export interface StaffAuth {
  kind: 'staff'
  userId: string
  name: string
  email: string
  sessionId: string
  sessionHash: string
  csrfToken: string
  expiresAt: string
  roles: { key: string; name: string; rank: number; requiresMfa: boolean }[]
  permissions: Set<string>
  mfaState: 'none' | 'pending' | 'verified' | 'enrol_required'
  mfaEnabled: boolean
}

export interface PortalAuth {
  kind: 'portal'
  portalSessionId: string
  sessionHash: string
  accessTokenId: string
  clientId: string
  /** Projects this session may see. Computed from the token scope on every request. */
  projectIds: string[]
  verifiedAt: string
  verifiedEmail: string | null
  expiresAt: string
}

export type AppBindings = {
  Bindings: Env
  Variables: {
    auth: StaffAuth
    portal: PortalAuth
    requestId: string
  }
}
