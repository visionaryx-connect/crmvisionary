// Email and push templates.
//
// Every email uses one responsive, table-based layout (renders in Gmail, Outlook and mobile clients): company name +
// logo, greeting, event heading, intro, detail rows, quoted message, optional report sections, a button to the CRM
// page and a footer linking to notification preferences. All dynamic values are HTML-escaped. Administrators can
// override the subject / intro / closing line / button label per event; overrides may use {{placeholders}} which are
// substituted as plain text and then escaped (no HTML injection through templates).

import type { Env } from '../env'
import { NOTIFICATION_EVENTS, type NotificationEventKey } from '@shared/notificationEvents'
import { many } from '../lib/db'
import type { EmailContent } from './notify'
import { getSetting } from './settings'

export interface DeliveryPayload {
  title: string
  body: string
  link: string | null
  recipientName: string
  actorName: string | null
  sensitive: boolean
  email: EmailContent | null
  push: { title?: string; body?: string } | null
  notificationId: string | null
  requiresAck: boolean
}

export interface TemplateOverride {
  subject: string
  intro: string
  outro: string
  action_label: string
}

export const TEMPLATE_PLACEHOLDERS = ['recipientName', 'title', 'body', 'actorName', 'companyName', 'eventName'] as const

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
}

/** Only same-app relative paths become links (defends against open redirects in stored data). */
export function absoluteLink(env: Env, link: string | null): string {
  const origin = env.APP_ORIGIN.replace(/\/$/, '')
  if (!link || !link.startsWith('/') || link.startsWith('//')) return `${origin}/notifications`
  return origin + link
}

export async function templateOverrides(db: D1Database, eventKey: string): Promise<{ email?: TemplateOverride; push?: TemplateOverride }> {
  const rows = await many<TemplateOverride & { channel: 'email' | 'push' }>(db, 'SELECT channel, subject, intro, outro, action_label FROM notification_templates WHERE event_key = ?', eventKey)
  return Object.fromEntries(rows.map((r) => [r.channel, r]))
}

const SENSITIVE_LINE = 'There is an update for you in the Visionary X CRM. Sign in to view the details.'

export async function renderEmail(env: Env, eventKey: NotificationEventKey | string, p: DeliveryPayload, override?: TemplateOverride) {
  const profile = await getSetting(env.DB, 'company.profile')
  const company = profile.name || 'Visionary X'
  const def = (NOTIFICATION_EVENTS as Record<string, { label: string; category: string } | undefined>)[eventKey]
  const vars: Record<string, string> = {
    recipientName: p.recipientName,
    title: p.title,
    body: p.body,
    actorName: p.actorName ?? '',
    companyName: company,
    eventName: def?.label ?? 'Notification',
  }
  const e = p.email ?? {}
  const subject = (override?.subject ? fill(override.subject, vars) : e.subject ?? p.title).replace(/[\r\n]+/g, ' ').slice(0, 200)
  const intro = override?.intro ? fill(override.intro, vars) : p.sensitive ? SENSITIVE_LINE : e.intro ?? (p.body || '')
  const outro = override?.outro ? fill(override.outro, vars) : e.outro ?? 'Open the CRM to see the full details.'
  const action = override?.action_label ? fill(override.action_label, vars) : e.actionLabel ?? 'Open in CRM'
  const details = p.sensitive ? [] : (e.details ?? [])
  const message = p.sensitive ? '' : (e.message ?? '')
  const sections = p.sensitive ? [] : (e.sections ?? [])
  const url = absoluteLink(env, p.link)
  const prefs = absoluteLink(env, '/notifications?prefs=1')
  const origin = env.APP_ORIGIN.replace(/\/$/, '')

  const detailRows = details
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b6f6a;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0;color:#1c1f1d;font-size:14px;vertical-align:top">${escapeHtml(v)}</td></tr>`)
    .join('')
  const sectionHtml = sections
    .map((s) => {
      const rows = (s.rows ?? []).map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;color:#4a4f4b;font-size:13px">${escapeHtml(k)}</td><td align="right" style="padding:5px 0;color:#1c1f1d;font-size:13px;font-weight:600">${escapeHtml(v)}</td></tr>`).join('')
      const items = (s.items ?? []).slice(0, 40).map((i) => `<li style="margin:0 0 4px;color:#1c1f1d;font-size:13px">${escapeHtml(i)}</li>`).join('')
      const more = (s.items?.length ?? 0) > 40 ? `<p style="margin:4px 0 0;color:#6b6f6a;font-size:12px">…and ${s.items!.length - 40} more in the CRM.</p>` : ''
      const empty = !rows && !items ? `<p style="margin:0;color:#6b6f6a;font-size:13px">${escapeHtml(s.empty ?? 'Nothing to report.')}</p>` : ''
      return `<tr><td style="padding:18px 0 0"><p style="margin:0 0 8px;color:#141414;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">${escapeHtml(s.title)}</p>${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : ''}${items ? `<ul style="margin:0;padding-left:18px">${items}</ul>` : ''}${more}${empty}</td></tr>`
    })
    .join('')

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f2ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(intro.slice(0, 140))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f2ee"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e2da;border-radius:10px">
<tr><td style="padding:20px 28px;border-bottom:1px solid #eceae3"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:10px"><img src="${escapeHtml(origin)}/brand/vx-orb-128.png" width="32" height="32" alt="Visionary X" style="display:block"></td>
<td style="font-size:15px;font-weight:700;color:#141414;letter-spacing:.02em">${escapeHtml(company)}</td></tr></table></td></tr>
<tr><td style="padding:24px 28px 8px">
<p style="margin:0 0 6px;color:#6b6f6a;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase">${escapeHtml(def?.label ?? 'Notification')}</p>
<h1 style="margin:0 0 16px;color:#1c1f1d;font-size:20px;line-height:1.35;font-weight:650">${escapeHtml(p.sensitive ? (def?.label ?? 'Update') : p.title)}</h1>
<p style="margin:0 0 12px;color:#1c1f1d;font-size:14px;line-height:1.6">Dear ${escapeHtml(p.recipientName)},</p>
${intro ? `<p style="margin:0 0 14px;color:#1c1f1d;font-size:14px;line-height:1.6">${escapeHtml(intro)}</p>` : ''}
${detailRows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px">${detailRows}</table>` : ''}
${message ? `<div style="margin:0 0 16px;padding:12px 16px;background:#f7f6f2;border-left:3px solid #141414;border-radius:4px;color:#1c1f1d;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(message)}</div>` : ''}
${sectionHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${sectionHtml}</table>` : ''}
<p style="margin:18px 0 18px;color:#4a4f4b;font-size:14px;line-height:1.6">${escapeHtml(outro)}</p>
${p.requiresAck ? `<p style="margin:0 0 14px;color:#8a5a00;font-size:13px;font-weight:600">This message requires your acknowledgement in the CRM.</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:6px;background:#141414"><a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${escapeHtml(action)}</a></td></tr></table>
</td></tr>
<tr><td style="padding:22px 28px;border-top:1px solid #eceae3;color:#8a8d88;font-size:12px;line-height:1.6">
You received this because of your role or work in the ${escapeHtml(company)} operations CRM. Links require you to sign in.<br>
<a href="${escapeHtml(prefs)}" style="color:#4a4f4b">Manage notification preferences</a>${profile.supportEmail ? ` · Questions: ${escapeHtml(profile.supportEmail)}` : ''}
</td></tr></table></td></tr></table></body></html>`

  const text = [
    `${company} — ${def?.label ?? 'Notification'}`,
    '',
    p.sensitive ? (def?.label ?? 'Update') : p.title,
    '',
    `Dear ${p.recipientName},`,
    intro,
    ...details.map(([k, v]) => `${k}: ${v}`),
    ...(message ? ['', `"${message}"`] : []),
    ...sections.flatMap((s) => ['', s.title.toUpperCase(), ...(s.rows ?? []).map(([k, v]) => `  ${k}: ${v}`), ...(s.items ?? []).slice(0, 40).map((i) => `  - ${i}`)]),
    '',
    outro,
    `${action}: ${url}`,
    '',
    `Manage notification preferences: ${prefs}`,
  ]
    .filter((l) => l !== undefined)
    .join('\n')
  return { subject, html, text }
}

export function renderPush(env: Env, eventKey: NotificationEventKey | string, p: DeliveryPayload, override?: TemplateOverride) {
  const def = (NOTIFICATION_EVENTS as Record<string, { label: string } | undefined>)[eventKey]
  const vars: Record<string, string> = { recipientName: p.recipientName, title: p.title, body: p.body, actorName: p.actorName ?? '', companyName: 'Visionary X', eventName: def?.label ?? 'Notification' }
  const title = (override?.subject ? fill(override.subject, vars) : p.sensitive ? (def?.label ?? 'Visionary X') : p.push?.title ?? p.title).slice(0, 120)
  const body = (override?.intro ? fill(override.intro, vars) : p.sensitive ? 'Open the CRM to view this update.' : p.push?.body ?? p.body).slice(0, 240)
  const path = p.link && p.link.startsWith('/') && !p.link.startsWith('//') ? p.link : '/notifications'
  return { title, body, url: path, tag: p.notificationId ?? undefined, notificationId: p.notificationId, origin: env.APP_ORIGIN }
}
