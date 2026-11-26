// Brevo transactional email (https://developers.brevo.com/docs/send-a-transactional-email).
// Server-side only: the API key is a Worker secret and never reaches the browser or an API response.
//
// Outcome classification drives the retry policy in notificationQueue.ts:
//   accepted   — 2xx; Brevo queued the message. NOT proof of delivery: the webhook reports delivered/bounced later.
//   retryable  — network errors, 429 and 5xx.
//   permanent  — invalid request / recipient (400, 422) or credentials / account problems (401, 402, 403).

import type { Env } from '../env'

export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email'

export interface BrevoMessage {
  to: { email: string; name?: string }[]
  subject: string
  htmlContent: string
  textContent?: string
  cc?: { email: string; name?: string }[]
  bcc?: { email: string; name?: string }[]
  replyTo?: { email: string; name?: string }
  tags?: string[]
  /** Echoed back in webhook payloads as X-Mailin-custom; we put the delivery id here. */
  custom?: string
  /** Idempotency hint: Brevo de-duplicates nothing for us, so the outbox never sends the same delivery twice. */
  headers?: Record<string, string>
}

export type BrevoResult =
  | { outcome: 'accepted'; messageId: string | null; status: number; response: string }
  | { outcome: 'retryable' | 'permanent'; status: number; error: string; code?: string; response: string; credentialProblem?: boolean }

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/
export const isValidEmail = (e: string | null | undefined): e is string => Boolean(e && e.length <= 254 && EMAIL_RE.test(e))

/**
 * The configured sender, normalised. Secrets pasted by hand often carry quotes, spaces, a trailing newline or the
 * "Name <address>" form; Brevo rejects all of those with "valid sender email required", so accept them here and
 * report anything still invalid clearly instead of calling the API.
 */
export function brevoSender(env: Env): { email: string; name: string; valid: boolean; raw: string } {
  const raw = env.BREVO_SENDER_EMAIL ?? ''
  let value = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  let name = (env.BREVO_SENDER_NAME ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  const angle = /^(.*?)<\s*([^<>\s]+)\s*>\s*$/.exec(value)
  if (angle) {
    value = angle[2]
    if (!name) name = angle[1].trim().replace(/^["']+|["']+$/g, '').trim()
  }
  value = value.replace(/^mailto:/i, '').toLowerCase()
  return { email: value, name: name || 'Visionary X', valid: isValidEmail(value), raw }
}

/** Human-readable reason the sender cannot be used, or null when it is fine. */
export function senderProblem(env: Env): string | null {
  const s = brevoSender(env)
  if (!s.raw.trim()) return 'BREVO_SENDER_EMAIL is not set.'
  if (!s.valid) return `BREVO_SENDER_EMAIL is not a valid email address (received ${JSON.stringify(s.raw.slice(0, 80))}). Set it to the bare verified sender address, e.g. notifications@visionary-x.in.`
  return null
}

/** Strip angle brackets so ids from the send response and from webhooks compare equal. */
export const normaliseMessageId = (id: string | null | undefined) => (id ? id.trim().replace(/^<|>$/g, '') : null)

export async function sendBrevoEmail(env: Env, msg: BrevoMessage, fetcher: typeof fetch = fetch): Promise<BrevoResult> {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return { outcome: 'permanent', status: 0, error: 'Email is not configured (BREVO_API_KEY / BREVO_SENDER_EMAIL)', response: '', credentialProblem: true }
  const sender = brevoSender(env)
  const problem = senderProblem(env)
  if (problem) return { outcome: 'permanent', status: 0, error: problem, code: 'invalid_sender', response: '', credentialProblem: true }
  const bad = msg.to.find((r) => !isValidEmail(r.email))
  if (bad) return { outcome: 'permanent', status: 0, error: `Invalid recipient address`, code: 'invalid_recipient', response: '' }
  const payload: Record<string, unknown> = {
    sender: { email: sender.email, name: sender.name },
    to: msg.to,
    subject: msg.subject.slice(0, 250),
    htmlContent: msg.htmlContent,
    ...(msg.textContent ? { textContent: msg.textContent } : {}),
    ...(msg.cc?.length ? { cc: msg.cc } : {}),
    ...(msg.bcc?.length ? { bcc: msg.bcc } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.tags?.length ? { tags: msg.tags.slice(0, 10) } : {}),
    headers: { ...(msg.headers ?? {}), ...(msg.custom ? { 'X-Mailin-custom': msg.custom } : {}) },
  }
  let res: Response
  try {
    res = await fetcher(BREVO_ENDPOINT, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': env.BREVO_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return { outcome: 'retryable', status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), response: '' }
  }
  const text = (await res.text().catch(() => '')).slice(0, 2000)
  let json: { messageId?: string; code?: string; message?: string } = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    /* non-JSON body */
  }
  if (res.ok) return { outcome: 'accepted', messageId: normaliseMessageId(json.messageId), status: res.status, response: text }
  const code = json.code ?? ''
  const error = `Brevo ${res.status}${code ? ` ${code}` : ''}: ${json.message ?? (text || res.statusText)}`.slice(0, 500)
  if (res.status === 429 || res.status >= 500) return { outcome: 'retryable', status: res.status, error, code, response: text }
  if (/sender/i.test(json.message ?? '')) {
    return {
      outcome: 'permanent', status: res.status, code, response: text, credentialProblem: true,
      error: `${error} — Brevo did not accept ${sender.email} as the sender. Add it under Brevo → Senders, Domains & Dedicated IPs → Senders and make sure it shows as verified (or its domain as authenticated).`.slice(0, 500),
    }
  }
  const credentialProblem = res.status === 401 || res.status === 403 || /unauthori[sz]ed|permission_denied|api-key|authentication|not_enough_credits|insufficient/i.test(code + ' ' + (json.message ?? ''))
  return { outcome: 'permanent', status: res.status, error, code, response: text, credentialProblem }
}
