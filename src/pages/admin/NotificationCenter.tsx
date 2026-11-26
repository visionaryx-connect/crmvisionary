// Notification center: company-wide notification visibility, delivery monitoring, announcements and configuration.
// Each tab is shown only with the permission its API requires (the API enforces the same rules).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download, Eye, Megaphone, Play, RefreshCw, RotateCcw, Send, Trash2 } from 'lucide-react'
import { CHANNEL_LABEL, NOTIFICATION_CATEGORIES, NOTIFICATION_EVENTS, NOTIFICATION_PRIORITIES, PRIORITY_LABEL, type Channel } from '@shared/notificationEvents'
import { ApiError, api, qs } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAction } from '@/lib/forms'
import { fmtDateTime, relative } from '@/lib/format'
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, KeyValue, PageHeader, Panel, QueryState, Section, Select, StatStrip, Table, Tabs, Td, Textarea, Th, Tr, cx } from '@/components/ui'
import { ChannelIcons, DeliveryStatus, PriorityBadge, categoryLabel, eventLabel } from '@/components/notifications'
import { useToast } from '@/components/toast'

type Tab = 'overview' | 'notifications' | 'broadcasts' | 'deliveries' | 'rules' | 'templates' | 'schedule' | 'devices' | 'jobs' | 'audit'
const chartAxis = { fontSize: 10.5, fill: '#8d8b88' }
const tooltip = { background: '#141414', color: '#fbfaf7', fontSize: 12, borderRadius: 6, border: '1px solid #363636' }

function Filters({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-end gap-2">{children}</div>
}
function Empty({ title, body }: { title: string; body?: string }) {
  return <EmptyState title={title} body={body} />
}

// ───────── Overview ─────────

interface Overview {
  providers: { email: { configured: boolean; sender: { email: string; name: string } | null; senderProblem: string | null; webhook: boolean }; push: { configured: boolean; subject: string | null; problem: string | null } }
  metrics: Record<string, number | string | null>
  byCategory: { category: string; label: string; n: number }[]
  byDepartment: { department: string; n: number }[]
  trend: { day: string; in_app: number; email: number; push: number }[]
  recentFailures: { id: string; channel: string; status: string; event_key: string; last_error: string | null; updated_at: string; user_name: string }[]
}

function OverviewTab({ go }: { go: (t: Tab, p?: Record<string, string>) => void }) {
  const q = useQuery({ queryKey: ['nadmin', 'overview'], queryFn: () => api.get<Overview>('/api/notifications/admin/overview'), refetchInterval: 60_000 })
  const { can } = useAuth()
  const toast = useToast()
  const testEmail = useAction(() => api.post<{ delivery: { status: string; last_error: string | null; recipient: string; provider_message_id: string | null } }>('/api/notifications/admin/test-email'), {
    onSuccess: (r) => toast(r.delivery.status === 'accepted' ? { tone: 'ok', title: `Brevo accepted the test email to ${r.delivery.recipient}`, body: `Message id ${r.delivery.provider_message_id ?? '—'}. Delivery is confirmed only when Brevo's "delivered" webhook arrives.` } : { tone: 'error', title: `Test email ${r.delivery.status}`, body: r.delivery.last_error ?? undefined }),
    invalidate: [['nadmin']],
  })
  return (
    <QueryState q={q}>
      {(d) => {
        const m = d.metrics as Record<string, number>
        return (
          <div className="space-y-6">
            <div className="grid gap-3 md:grid-cols-2">
              <Panel className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Email · Brevo</p>
                    <p className="mt-1 text-[14px] text-ink">{d.providers.email.configured ? `${d.providers.email.sender?.name} <${d.providers.email.sender?.email}>` : 'Not configured'}</p>
                    <p className="mt-1 text-[12px] text-muted">{d.providers.email.configured ? (d.providers.email.webhook ? 'Delivery webhook secret set — delivered / bounced events are tracked.' : 'Webhook secret not set — only acceptance by Brevo is known, not delivery.') : 'Set BREVO_API_KEY and BREVO_SENDER_EMAIL (docs/NOTIFICATIONS.md).'}</p>
                  </div>
                  <Badge tone={d.providers.email.configured && !d.providers.email.senderProblem ? 'ok' : 'warn'} dot>{!d.providers.email.configured ? 'Off' : d.providers.email.senderProblem ? 'Check' : 'On'}</Badge>
                </div>
                {d.providers.email.senderProblem && <p className="mt-2 rounded-md bg-warn-bg px-3 py-2 text-[12.5px] text-warn">{d.providers.email.senderProblem}</p>}
                {d.providers.email.configured && can('notifications.manage') && <Button className="mt-3" size="sm" icon={<Send className="size-3.5" />} loading={testEmail.isPending} onClick={() => testEmail.mutate()}>Send me a test email</Button>}
              </Panel>
              <Panel className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted">Web Push · VAPID</p>
                    <p className="mt-1 text-[14px] text-ink">{d.providers.push.configured ? `${m.activeDevices} active device(s) · ${m.usersWithPush} people` : 'Not configured'}</p>
                    <p className="mt-1 text-[12px] text-muted">{d.providers.push.configured ? `Subject ${d.providers.push.subject}. Test from your own Notifications → Preferences → Devices.` : 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (node scripts/gen-vapid.mjs).'}</p>
                  </div>
                  <Badge tone={d.providers.push.configured && !d.providers.push.problem ? 'ok' : 'warn'} dot>{!d.providers.push.configured ? 'Off' : d.providers.push.problem ? 'Check' : 'On'}</Badge>
                </div>
                {d.providers.push.problem && <p className="mt-2 rounded-md bg-warn-bg px-3 py-2 text-[12.5px] text-warn">{d.providers.push.problem}</p>}
              </Panel>
            </div>
            <StatStrip stats={[
              { label: 'Notifications (30 days)', value: m.total, hint: `${m.last24h} in the last 24 h` },
              { label: 'Unread', value: m.unread },
              { label: 'Emails accepted', value: m.emailAccepted, hint: `${m.emailDelivered} delivered · ${m.emailOpened} opened` },
              { label: 'Email failures', value: Number(m.emailFailed) + Number(m.emailBounced), tone: Number(m.emailFailed) + Number(m.emailBounced) > 0 ? 'danger' : undefined, hint: `${m.emailBounced} bounced / blocked` },
              { label: 'Push sent', value: m.pushSent, hint: `${m.pushFailed} failed · ${m.expiredDevices} expired devices` },
              { label: 'In queue', value: Number(m.queueQueued) + Number(m.queueRetry), tone: Number(m.queueRetry) > 0 ? 'warn' : undefined, hint: `${m.queueRetry} waiting to retry` },
              { label: 'Acknowledged', value: `${m.acknowledged}/${m.ackRequired}` },
            ]} />
            <div className="grid gap-4 lg:grid-cols-3">
              <Section title="Daily activity (14 days)" className="lg:col-span-2">
                <Panel className="px-2 pt-4">
                  <div className="h-[220px]">
                    {d.trend.length === 0 ? <p className="px-3 text-[13px] text-muted">No activity yet.</p> : (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={d.trend}>
                          <CartesianGrid vertical={false} stroke="#262626" />
                          <XAxis dataKey="day" tickFormatter={(v) => String(v).slice(5)} tick={chartAxis} axisLine={false} tickLine={false} />
                          <YAxis allowDecimals={false} width={30} tick={chartAxis} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={tooltip} />
                          <Bar dataKey="in_app" name="In-app" stackId="a" fill="#fbfaf7" />
                          <Bar dataKey="email" name="Email" stackId="a" fill="#8d8b88" />
                          <Bar dataKey="push" name="Push" stackId="a" fill="#5f5d5a" radius={[2, 2, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </Panel>
              </Section>
              <Section title="By category">
                <Panel className="divide-y divide-line/70">
                  {d.byCategory.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No notifications yet.</p>}
                  {d.byCategory.map((c) => (
                    <button key={c.category} className="flex w-full items-center justify-between px-4 py-2 text-left text-[13px] hover:bg-canvas/70" onClick={() => go('notifications', { category: c.category })}>
                      <span>{c.label}</span><span className="font-mono text-[12px] text-ink-2">{c.n}</span>
                    </button>
                  ))}
                </Panel>
              </Section>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="By department">
                <Panel className="divide-y divide-line/70">
                  {d.byDepartment.map((x) => <div key={x.department} className="flex justify-between px-4 py-2 text-[13px]"><span>{x.department}</span><span className="font-mono text-[12px] text-ink-2">{x.n}</span></div>)}
                  {d.byDepartment.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No data.</p>}
                </Panel>
              </Section>
              <Section title="Recent failures" actions={<Button size="sm" variant="ghost" onClick={() => go('deliveries', { status: 'failed_any' })}>View all</Button>}>
                <Panel className="divide-y divide-line/70">
                  {d.recentFailures.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No failed deliveries.</p>}
                  {d.recentFailures.map((f) => (
                    <div key={f.id} className="px-4 py-2 text-[13px]">
                      <div className="flex items-center gap-2"><DeliveryStatus status={f.status} /><span className="text-ink">{f.user_name}</span><span className="text-muted">· {CHANNEL_LABEL[f.channel as Channel]} · {eventLabel(f.event_key)}</span><span className="ml-auto text-[11.5px] text-muted">{relative(f.updated_at)}</span></div>
                      {f.last_error && <p className="mt-0.5 truncate text-[12px] text-muted">{f.last_error}</p>}
                    </div>
                  ))}
                </Panel>
              </Section>
            </div>
          </div>
        )
      }}
    </QueryState>
  )
}

// ───────── All notifications ─────────

function NotificationsTab({ initial }: { initial: Record<string, string> }) {
  const [f, setF] = useState({ category: initial.category ?? '', status: '', priority: '', q: '', from: '', to: '', event: '' })
  const [search, setSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setF((x) => ({ ...x, q: search.trim() })), 300)
    return () => clearTimeout(t)
  }, [search])
  const q = useQuery({ queryKey: ['nadmin', 'notifications', f], queryFn: () => api.get<{ notifications: Record<string, any>[] }>(`/api/notifications/admin/notifications${qs(f)}`) })
  return (
    <div>
      <Filters>
        <Field label="Search" htmlFor="ns"><Input id="ns" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title, body or recipient" className="w-56" /></Field>
        <Field label="Category" htmlFor="nc"><Select id="nc" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{Object.entries(NOTIFICATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="Event" htmlFor="ne"><Select id="ne" value={f.event} onChange={(e) => setF({ ...f, event: e.target.value })}><option value="">All events</option>{Object.entries(NOTIFICATION_EVENTS).filter(([, d]) => !f.category || d.category === f.category).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}</Select></Field>
        <Field label="Status" htmlFor="nst"><Select id="nst" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option><option value="unread">Unread</option><option value="read">Read</option><option value="unacknowledged">Not acknowledged</option></Select></Field>
        <Field label="Priority" htmlFor="np"><Select id="np" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Any</option>{NOTIFICATION_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select></Field>
        <Field label="From" htmlFor="nf"><Input id="nf" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To" htmlFor="nt"><Input id="nt" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <a className="ml-auto" href={`/api/notifications/admin/export${qs({ type: 'notifications', from: f.from, to: f.to })}`}><Button icon={<Download className="size-4" />}>Export CSV</Button></a>
      </Filters>
      <QueryState q={q} empty={(d) => (d.notifications.length === 0 ? <Empty title="No notifications match" /> : null)}>
        {(d) => (
          <Table>
            <thead><tr><Th>When</Th><Th>Recipient</Th><Th>Notification</Th><Th>Category</Th><Th>Delivery</Th><Th>State</Th></tr></thead>
            <tbody>
              {d.notifications.map((n) => (
                <Tr key={n.id}>
                  <Td className="whitespace-nowrap text-muted" ><span title={fmtDateTime(n.created_at)}>{relative(n.created_at)}</span></Td>
                  <Td><span className="text-ink">{n.user_name}</span>{n.department_name && <span className="block text-[11.5px] text-muted">{n.department_name}</span>}</Td>
                  <Td className="max-w-[420px]"><p className="truncate text-ink">{n.title}</p><p className="truncate text-[12px] text-muted">{eventLabel(n.event_key)}{n.actor_name ? ` · by ${n.actor_name}` : ''}</p></Td>
                  <Td><span className="text-[12.5px]">{categoryLabel(n.category)}</span> <PriorityBadge priority={n.priority} /></Td>
                  <Td>{n.deliveries ? <span className="flex flex-wrap gap-1">{String(n.deliveries).split(',').map((x: string) => { const [ch, st] = x.split(':'); return <span key={x} className="text-[11.5px] text-muted">{CHANNEL_LABEL[ch as Channel]}: <DeliveryStatus status={st} /></span> })}</span> : <span className="text-[12px] text-muted">In-app</span>}</Td>
                  <Td>{n.requires_ack ? (n.acknowledged_at ? <Badge tone="ok">Acknowledged</Badge> : <Badge tone="warn">Awaiting ack</Badge>) : n.read_at ? <Badge tone="outline">Read</Badge> : <Badge>Unread</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
    </div>
  )
}

// ───────── Broadcasts ─────────

interface AudienceOptions {
  departments: { id: string; name: string; members: number }[]
  projects: { id: string; reference: string; name: string; members: number }[]
  roles: { key: string; name: string; members: number }[]
  users: { id: string; name: string; department: string | null }[]
  channels: { email: boolean; push: boolean }
}

function MultiPick<T extends { id: string; label: string; hint?: string }>({ items, value, onChange, placeholder }: { items: T[]; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [filter, setFilter] = useState('')
  const shown = items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase())).slice(0, 60)
  return (
    <div className="rounded-md border border-line">
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={placeholder} className="rounded-b-none border-0 border-b" aria-label={placeholder} />
      <div className="max-h-40 overflow-y-auto p-2">
        {shown.map((i) => (
          <label key={i.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-canvas">
            <input type="checkbox" className="size-4 accent-accent" checked={value.includes(i.id)} onChange={(e) => onChange(e.target.checked ? [...value, i.id] : value.filter((x) => x !== i.id))} />
            <span className="min-w-0 flex-1 truncate">{i.label}</span>{i.hint && <span className="shrink-0 text-[11.5px] text-muted">{i.hint}</span>}
          </label>
        ))}
        {shown.length === 0 && <p className="px-1.5 py-1 text-[12.5px] text-muted">No matches.</p>}
      </div>
    </div>
  )
}

function Composer({ onSent }: { onSent: () => void }) {
  const { can } = useAuth()
  const toast = useToast()
  const opts = useQuery({ queryKey: ['nadmin', 'audience'], queryFn: () => api.get<AudienceOptions>('/api/notifications/admin/audience-options') })
  const [form, setForm] = useState({ kind: 'announcement' as 'announcement' | 'message', title: '', body: '', priority: 'normal', link: '', requiresAck: false, mandatory: false, scheduledAt: '', expiresAt: '' })
  const [audience, setAudience] = useState({ all: false, departmentIds: [] as string[], projectIds: [] as string[], roleKeys: [] as string[], userIds: [] as string[] })
  const [channels, setChannels] = useState<Channel[]>(['in_app', 'email'])
  const [confirm, setConfirm] = useState<number | null>(null)
  const hasAudience = audience.all || audience.departmentIds.length + audience.projectIds.length + audience.roleKeys.length + audience.userIds.length > 0
  const preview = useQuery({ queryKey: ['nadmin', 'preview', audience], enabled: hasAudience, queryFn: () => api.post<{ count: number; sample: string[]; label: string; reach: { inApp: number; email: number; push: number } }>('/api/notifications/admin/broadcasts/preview', { audience }) })
  const payload = (confirmed: boolean) => ({
    ...form, link: form.link || null, audience, channels,
    scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
    expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
    confirm: confirmed,
  })
  const send = useAction((confirmed: boolean) => api.post<{ status: string; recipients: number }>('/api/notifications/admin/broadcasts', payload(confirmed)), {
    success: (r) => (r.status === 'sent' ? `Sent to ${r.recipients} people` : `Scheduled for ${r.recipients} people`),
    invalidate: [['nadmin'], ['notifications']],
    onSuccess: () => { setConfirm(null); setForm({ ...form, title: '', body: '', scheduledAt: '', expiresAt: '' }); onSent() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CONFIRMATION_REQUIRED') setConfirm(Number((e.details as { count?: number })?.count ?? 0))
      else toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not send' })
    },
    silentError: true,
  })
  const o = opts.data
  // Untick channels the server cannot deliver on, so the form reflects what will actually be sent.
  useEffect(() => {
    if (o) setChannels((x) => x.filter((c) => c === 'in_app' || (c === 'email' && o.channels.email) || (c === 'push' && o.channels.push)))
  }, [o])
  const toggleCh = (c: Channel, on: boolean) => setChannels((x) => (on ? [...new Set([...x, c])] : x.filter((y) => y !== c)))
  return (
    <Panel className="p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'announcement' | 'message' })} aria-label="Type" className="w-full sm:w-44"><option value="announcement">Announcement</option><option value="message">Direct message</option></Select>
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} aria-label="Priority" className="w-full sm:w-36">{NOTIFICATION_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select>
          </div>
          <Field label="Title" htmlFor="bt" required><Input id="bt" value={form.title} maxLength={150} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Office closed on Friday" /></Field>
          <Field label="Message" htmlFor="bb" required><Textarea id="bb" rows={6} value={form.body} maxLength={5000} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field>
          <Field label="Link (optional)" htmlFor="bl" hint="An in-app page such as /hr/leave or /projects/…"><Input id="bl" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="/…" /></Field>
          <div className="flex flex-wrap gap-4">
            <Checkbox label="In-app" checked={channels.includes('in_app')} onChange={(e) => toggleCh('in_app', e.target.checked)} />
            <Checkbox label="Email" disabled={!o?.channels.email} description={o && !o.channels.email ? 'Not configured' : undefined} checked={channels.includes('email')} onChange={(e) => toggleCh('email', e.target.checked)} />
            <Checkbox label="Push" disabled={!o?.channels.push} description={o && !o.channels.push ? 'Not configured' : undefined} checked={channels.includes('push')} onChange={(e) => toggleCh('push', e.target.checked)} />
          </div>
          <div className="flex flex-wrap gap-4">
            <Checkbox label="Require acknowledgement" description="Recipients confirm they read it; reminders and manager follow-ups are automatic." checked={form.requiresAck} onChange={(e) => setForm({ ...form, requiresAck: e.target.checked })} />
            {can('notifications.manage') && <Checkbox label="Mandatory" description="Delivered even if recipients muted announcements." checked={form.mandatory} onChange={(e) => setForm({ ...form, mandatory: e.target.checked })} />}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap">
            <Field label="Send at (optional)" htmlFor="bs"><Input id="bs" type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></Field>
            <Field label="Expires (optional)" htmlFor="bx"><Input id="bx" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <p className="text-[12.5px] font-medium text-ink-2">Audience</p>
          <Checkbox label="All active employees" checked={audience.all} onChange={(e) => setAudience({ ...audience, all: e.target.checked })} />
          {!audience.all && o && (
            <>
              <MultiPick placeholder="Departments…" items={o.departments.map((d) => ({ id: d.id, label: d.name, hint: `${d.members}` }))} value={audience.departmentIds} onChange={(v) => setAudience({ ...audience, departmentIds: v })} />
              <MultiPick placeholder="Roles (HR, Admin, …)" items={o.roles.map((r) => ({ id: r.key, label: r.name, hint: `${r.members}` }))} value={audience.roleKeys} onChange={(v) => setAudience({ ...audience, roleKeys: v })} />
              <MultiPick placeholder="Project teams…" items={o.projects.map((p) => ({ id: p.id, label: `${p.reference} ${p.name}`, hint: `${p.members}` }))} value={audience.projectIds} onChange={(v) => setAudience({ ...audience, projectIds: v })} />
              <MultiPick placeholder="Individual people…" items={o.users.map((u) => ({ id: u.id, label: u.name, hint: u.department ?? undefined }))} value={audience.userIds} onChange={(v) => setAudience({ ...audience, userIds: v })} />
            </>
          )}
          <div className="rounded-md border border-line bg-canvas/60 px-3 py-2.5 text-[13px]">
            {!hasAudience ? <span className="text-muted">Choose who should receive this.</span> : preview.data ? (
              <>
                <p className="text-ink"><strong>{preview.data.count}</strong> recipient{preview.data.count === 1 ? '' : 's'} · {preview.data.label}</p>
                <p className="mt-0.5 text-[12px] text-muted">Reach: {preview.data.reach.inApp} in-app{channels.includes('email') ? ` · ${preview.data.reach.email} email` : ''}{channels.includes('push') ? ` · ${preview.data.reach.push} with push devices` : ''}</p>
                {preview.data.sample.length > 0 && <p className="mt-1 text-[12px] text-muted">{preview.data.sample.join(', ')}{preview.data.count > preview.data.sample.length ? '…' : ''}</p>}
              </>
            ) : <span className="text-muted">Counting…</span>}
          </div>
          <div className="flex justify-stretch sm:justify-end [&>button]:w-full sm:[&>button]:w-auto">
            <Button variant="primary" icon={<Megaphone className="size-4" />} disabled={!form.title.trim() || !form.body.trim() || !hasAudience || channels.length === 0 || preview.data?.count === 0} loading={send.isPending} onClick={() => send.mutate(false)}>
              {form.scheduledAt ? 'Schedule' : 'Send now'}
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog open={confirm !== null} onClose={() => setConfirm(null)} onConfirm={() => send.mutate(true)} loading={send.isPending} title={`Send to ${confirm} people?`} body={<>This {form.kind} goes to <strong>{preview.data?.label ?? 'the selected audience'}</strong> by {channels.map((c) => CHANNEL_LABEL[c]).join(', ')}. It cannot be unsent once delivered.</>} confirmLabel={form.scheduledAt ? 'Schedule' : 'Send'} />
    </Panel>
  )
}

function BroadcastsTab() {
  const q = useQuery({ queryKey: ['nadmin', 'broadcasts'], queryFn: () => api.get<{ broadcasts: Record<string, any>[] }>('/api/notifications/admin/broadcasts') })
  const [open, setOpen] = useState<string | null>(null)
  const detail = useQuery({ queryKey: ['nadmin', 'broadcast', open], enabled: !!open, queryFn: () => api.get<{ broadcast: Record<string, any>; recipients: Record<string, any>[] }>(`/api/notifications/admin/broadcasts/${open}`) })
  const cancel = useAction((id: string) => api.post(`/api/notifications/admin/broadcasts/${id}/cancel`), { success: 'Cancelled', invalidate: [['nadmin', 'broadcasts']] })
  return (
    <div className="space-y-6">
      <Section title="New announcement or message"><Composer onSent={() => q.refetch()} /></Section>
      <Section title="History">
        <QueryState q={q} empty={(d) => (d.broadcasts.length === 0 ? <Empty title="Nothing sent yet" /> : null)}>
          {(d) => (
            <>
            <ul className="space-y-2 sm:hidden">
              {d.broadcasts.map((b) => (
                <li key={b.id}>
                  <button className="w-full rounded-lg border border-line bg-surface px-3.5 py-3 text-left" onClick={() => setOpen(b.id)}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-[13.5px] font-medium text-ink">{b.title}</span>
                      <Badge tone={b.status === 'sent' ? 'ok' : b.status === 'scheduled' ? 'info' : b.status === 'failed' ? 'danger' : 'outline'}>{b.status}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-muted">{b.audience_label}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
                      <span>{fmtDateTime(b.sent_at ?? b.scheduled_at)}</span>
                      <span>{b.recipient_count} recipient{b.recipient_count === 1 ? '' : 's'}</span>
                      <span>{b.read_count} read</span>
                      {Boolean(b.requires_ack) && <span>{b.ack_count}/{b.recipient_count} acknowledged</span>}
                      <ChannelIcons channels={JSON.parse(b.channels)} />
                    </p>
                  </button>
                  {b.status === 'scheduled' && <Button size="sm" variant="ghost" className="mt-1" onClick={() => cancel.mutate(b.id)}>Cancel scheduled send</Button>}
                </li>
              ))}
            </ul>
            <Table className="hidden sm:block">
              <thead><tr><Th>Sent / scheduled</Th><Th>Title</Th><Th>Audience</Th><Th>Channels</Th><Th align="right">Recipients</Th><Th align="right">Read</Th><Th align="right">Acknowledged</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {d.broadcasts.map((b) => (
                  <Tr key={b.id} onClick={() => setOpen(b.id)}>
                    <Td className="whitespace-nowrap text-muted">{fmtDateTime(b.sent_at ?? b.scheduled_at)}</Td>
                    <Td><span className="text-ink">{b.title}</span><span className="block text-[11.5px] text-muted">{b.kind === 'message' ? 'Message' : 'Announcement'} · {b.sender_name}</span></Td>
                    <Td className="max-w-[240px] truncate text-[12.5px]">{b.audience_label}</Td>
                    <Td><ChannelIcons channels={JSON.parse(b.channels)} /></Td>
                    <Td align="right">{b.recipient_count}</Td>
                    <Td align="right">{b.read_count}</Td>
                    <Td align="right">{b.requires_ack ? `${b.ack_count}/${b.recipient_count}` : '—'}</Td>
                    <Td><Badge tone={b.status === 'sent' ? 'ok' : b.status === 'scheduled' ? 'info' : b.status === 'failed' ? 'danger' : 'outline'}>{b.status}</Badge></Td>
                    <Td>{b.status === 'scheduled' && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); cancel.mutate(b.id) }}>Cancel</Button>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            </>
          )}
        </QueryState>
      </Section>
      {open && (
        <Dialog open onClose={() => setOpen(null)} width={720} title={detail.data?.broadcast.title ?? 'Announcement'} description={detail.data ? `${detail.data.broadcast.audience_label} · by ${detail.data.broadcast.sender_name}` : undefined}>
          <QueryState q={detail}>
            {(x) => (
              <div className="space-y-4">
                <p className="whitespace-pre-wrap rounded-md bg-canvas/60 px-3 py-2 text-[13px] text-ink-2">{x.broadcast.body}</p>
                <Table>
                  <thead><tr><Th>Recipient</Th><Th>Department</Th><Th>Read</Th><Th>Acknowledged</Th><Th>Email / push</Th></tr></thead>
                  <tbody>
                    {x.recipients.map((r) => (
                      <Tr key={r.user_id}>
                        <Td>{r.name}</Td>
                        <Td className="text-muted">{r.department ?? '—'}</Td>
                        <Td>{r.read_at ? relative(r.read_at) : '—'}</Td>
                        <Td>{r.acknowledged_at ? <Badge tone="ok">{relative(r.acknowledged_at)}</Badge> : x.broadcast.requires_ack ? <Badge tone="warn">Pending</Badge> : '—'}</Td>
                        <Td>{r.deliveries ? String(r.deliveries).split(',').map((s: string) => <span key={s} className="mr-1"><DeliveryStatus status={s.split(':')[1]} /></span>) : '—'}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </QueryState>
        </Dialog>
      )}
    </div>
  )
}

// ───────── Delivery logs ─────────

function DeliveriesTab({ initial }: { initial: Record<string, string> }) {
  const { can } = useAuth()
  const [f, setF] = useState({ channel: initial.channel ?? '', status: initial.status ?? '', q: '', from: '', to: '' })
  const [search, setSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setF((x) => ({ ...x, q: search.trim() })), 300)
    return () => clearTimeout(t)
  }, [search])
  const q = useQuery({ queryKey: ['nadmin', 'deliveries', f], queryFn: () => api.get<{ deliveries: Record<string, any>[] }>(`/api/notifications/admin/deliveries${qs(f)}`) })
  const [open, setOpen] = useState<string | null>(null)
  const detail = useQuery({ queryKey: ['nadmin', 'delivery', open], enabled: !!open, queryFn: () => api.get<{ delivery: Record<string, any>; providerEvents: Record<string, any>[] }>(`/api/notifications/admin/deliveries/${open}`) })
  const retry = useAction((v: { ids?: string[]; allFailed?: boolean; channel?: string }) => api.post<{ requeued: number }>('/api/notifications/admin/deliveries/retry', v), { success: (r) => `Re-queued ${r.requeued} delivery(ies)`, invalidate: [['nadmin']] })
  const sup = useQuery({ queryKey: ['nadmin', 'suppressions'], queryFn: () => api.get<{ suppressions: { user_id: string; name: string; email: string; email_suppressed_at: string; email_suppressed_reason: string }[] }>('/api/notifications/admin/suppressions') })
  const clearSup = useAction((uid: string) => api.del(`/api/notifications/admin/suppressions/${uid}`), { success: 'Email re-enabled for this person', invalidate: [['nadmin', 'suppressions']] })
  return (
    <div className="space-y-6">
      <div>
        <Filters>
          <Field label="Search" htmlFor="ds"><Input id="ds" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Recipient, subject or message id" className="w-64" /></Field>
          <Field label="Channel" htmlFor="dc"><Select id="dc" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">Email & push</option><option value="email">Email</option><option value="push">Push</option></Select></Field>
          <Field label="Status" htmlFor="dst"><Select id="dst" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Any</option><option value="pending">Pending (queued / retry)</option><option value="failed_any">Failed (any)</option>{['accepted', 'sent', 'delivered', 'opened', 'clicked', 'deferred', 'failed', 'bounced', 'blocked', 'spam', 'unsubscribed', 'skipped'].map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
          <Field label="From" htmlFor="df"><Input id="df" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="To" htmlFor="dt"><Input id="dt" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <div className="ml-auto flex gap-2">
            {can('notifications.manage') && <Button icon={<RotateCcw className="size-4" />} loading={retry.isPending} onClick={() => retry.mutate({ allFailed: true, channel: f.channel || undefined })}>Retry failed (7 days)</Button>}
            <a href={`/api/notifications/admin/export${qs({ type: 'deliveries', from: f.from, to: f.to })}`}><Button icon={<Download className="size-4" />}>Export CSV</Button></a>
          </div>
        </Filters>
        <QueryState q={q} empty={(d) => (d.deliveries.length === 0 ? <Empty title="No deliveries match" body="Email and push deliveries appear here once the providers are configured." /> : null)}>
          {(d) => (
            <Table>
              <thead><tr><Th>Created</Th><Th>Channel</Th><Th>Recipient</Th><Th>Event / subject</Th><Th>Status</Th><Th align="right">Attempts</Th><Th>Last error</Th><Th /></tr></thead>
              <tbody>
                {d.deliveries.map((x) => (
                  <Tr key={x.id} onClick={() => setOpen(x.id)}>
                    <Td className="whitespace-nowrap text-muted"><span title={fmtDateTime(x.created_at)}>{relative(x.created_at)}</span></Td>
                    <Td>{CHANNEL_LABEL[x.channel as Channel]}</Td>
                    <Td><span className="text-ink">{x.user_name}</span><span className="block text-[11.5px] text-muted">{x.recipient ?? ''}</span></Td>
                    <Td className="max-w-[300px]"><p className="truncate">{x.subject ?? eventLabel(x.event_key)}</p><p className="truncate text-[11.5px] text-muted">{eventLabel(x.event_key)}</p></Td>
                    <Td><DeliveryStatus status={x.status} />{x.status === 'retry' && <span className="block text-[11px] text-muted">next {relative(x.next_attempt_at)}</span>}</Td>
                    <Td align="right">{x.attempts}</Td>
                    <Td className="max-w-[240px] truncate text-[12px] text-muted">{x.last_error ?? ''}</Td>
                    <Td>{can('notifications.manage') && ['failed', 'skipped', 'deferred'].includes(x.status) && <IconButton label="Retry" onClick={(e) => { e.stopPropagation(); retry.mutate({ ids: [x.id] }) }}><RefreshCw className="size-3.5" /></IconButton>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryState>
      </div>
      <Section title="Email suppressions" description="Addresses Brevo reported as bounced, blocked, spam or unsubscribed. No email is sent to them until cleared.">
        <QueryState q={sup} empty={(d) => (d.suppressions.length === 0 ? <p className="text-[13px] text-muted">None.</p> : null)}>
          {(d) => (
            <Table>
              <thead><tr><Th>Person</Th><Th>Reason</Th><Th>Since</Th><Th /></tr></thead>
              <tbody>{d.suppressions.map((s) => <Tr key={s.user_id}><Td>{s.name}<span className="block text-[11.5px] text-muted">{s.email}</span></Td><Td className="text-[12.5px]">{s.email_suppressed_reason}</Td><Td className="text-muted">{relative(s.email_suppressed_at)}</Td><Td>{can('notifications.manage') && <Button size="sm" variant="ghost" onClick={() => clearSup.mutate(s.user_id)}>Clear</Button>}</Td></Tr>)}</tbody>
            </Table>
          )}
        </QueryState>
      </Section>
      {open && (
        <Dialog open onClose={() => setOpen(null)} width={680} title="Delivery details">
          <QueryState q={detail}>
            {(x) => (
              <div className="space-y-4">
                <KeyValue items={[
                  { label: 'Recipient', value: `${x.delivery.user_name} ${x.delivery.recipient ? `(${x.delivery.recipient})` : ''}` },
                  { label: 'Channel', value: CHANNEL_LABEL[x.delivery.channel as Channel] },
                  { label: 'Event', value: eventLabel(x.delivery.event_key) },
                  { label: 'Status', value: <DeliveryStatus status={x.delivery.status} /> },
                  { label: 'Attempts', value: x.delivery.attempts },
                  { label: 'Provider message id', value: x.delivery.provider_message_id ?? '—' },
                  { label: 'Accepted / sent', value: fmtDateTime(x.delivery.sent_at) },
                  { label: 'Delivered', value: fmtDateTime(x.delivery.delivered_at) },
                  { label: 'Opened', value: fmtDateTime(x.delivery.opened_at) },
                  { label: 'Subject', value: x.delivery.subject ?? x.delivery.payload.title },
                ]} />
                {x.delivery.last_error && <p className="rounded-md bg-danger-bg px-3 py-2 text-[12.5px] text-danger">{x.delivery.last_error}</p>}
                <div>
                  <p className="mb-1.5 text-[12.5px] font-medium text-ink-2">Provider events</p>
                  {x.providerEvents.length === 0 ? <p className="text-[13px] text-muted">No webhook events received for this message.</p> : (
                    <ul className="divide-y divide-line/70 rounded-md border border-line text-[13px]">{x.providerEvents.map((e) => <li key={e.id} className="flex justify-between gap-3 px-3 py-1.5"><span>{e.event}{e.reason ? ` · ${e.reason}` : ''}</span><span className="text-muted">{fmtDateTime(e.occurred_at ?? e.received_at)}</span></li>)}</ul>
                  )}
                </div>
                {x.delivery.provider_response && <details><summary className="cursor-pointer text-[12.5px] text-muted">Raw provider response</summary><pre className="mt-2 max-h-48 overflow-auto rounded bg-canvas p-2 text-[11.5px] text-ink-2">{String(x.delivery.provider_response)}</pre></details>}
              </div>
            )}
          </QueryState>
        </Dialog>
      )}
    </div>
  )
}

// ───────── Rules ─────────

interface Rule { key: string; label: string; description: string; category: string; group: string; enabled: boolean; channels: Channel[]; priority: string; mandatory: boolean; sensitive: boolean; overridden: boolean; events30d: number; defaults: { channels: Channel[]; priority: string; mandatory: boolean } }

function RulesTab() {
  const { can } = useAuth()
  const editable = can('notifications.manage')
  const q = useQuery({ queryKey: ['nadmin', 'rules'], queryFn: () => api.get<{ rules: Rule[] }>('/api/notifications/admin/rules') })
  const [cat, setCat] = useState('')
  const save = useAction((r: Rule) => api.put(`/api/notifications/admin/rules/${r.key}`, { enabled: r.enabled, channels: r.channels, priority: r.priority, mandatory: r.mandatory }), { success: 'Rule saved', invalidate: [['nadmin', 'rules']] })
  const reset = useAction((key: string) => api.del(`/api/notifications/admin/rules/${key}`), { success: 'Reset to default', invalidate: [['nadmin', 'rules']] })
  return (
    <div>
      <Filters>
        <Field label="Category" htmlFor="rc"><Select id="rc" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{Object.entries(NOTIFICATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <p className="pb-2 text-[12.5px] text-muted">Mandatory events ignore personal preferences. Security events are always on.</p>
      </Filters>
      <QueryState q={q}>
        {(d) => (
          <Table>
            <thead><tr><Th>Event</Th><Th>Category</Th><Th align="center">On</Th><Th align="center">In-app</Th><Th align="center">Email</Th><Th align="center">Push</Th><Th>Priority</Th><Th align="center">Mandatory</Th><Th align="right">30 days</Th><Th /></tr></thead>
            <tbody>
              {d.rules.filter((r) => !cat || r.category === cat).map((r) => {
                const locked = !editable || r.category === 'security'
                const upd = (patch: Partial<Rule>) => save.mutate({ ...r, ...patch })
                return (
                  <Tr key={r.key}>
                    <Td className="max-w-[340px]"><p className="text-ink">{r.label} {r.overridden && <Badge tone="info">custom</Badge>} {r.sensitive && <Badge tone="outline">private</Badge>}</p><p className="truncate text-[11.5px] text-muted" title={r.description}>{r.description}</p></Td>
                    <Td className="text-[12.5px]">{categoryLabel(r.category)}</Td>
                    <Td align="center"><input type="checkbox" className="size-4 accent-accent" aria-label="Enabled" disabled={locked} checked={r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} /></Td>
                    {(['in_app', 'email', 'push'] as Channel[]).map((c) => <Td key={c} align="center"><input type="checkbox" className="size-4 accent-accent" aria-label={CHANNEL_LABEL[c]} disabled={!editable} checked={r.channels.includes(c)} onChange={(e) => upd({ channels: e.target.checked ? [...r.channels, c] : r.channels.filter((x) => x !== c) })} /></Td>)}
                    <Td><Select aria-label="Priority" value={r.priority} disabled={!editable} onChange={(e) => upd({ priority: e.target.value })} className="h-7 w-28 text-[12.5px]">{NOTIFICATION_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select></Td>
                    <Td align="center"><input type="checkbox" className="size-4 accent-accent" aria-label="Mandatory" disabled={locked} checked={r.mandatory} onChange={(e) => upd({ mandatory: e.target.checked })} /></Td>
                    <Td align="right" className="font-mono text-[12px] text-muted">{r.events30d}</Td>
                    <Td>{editable && r.overridden && <Button size="sm" variant="ghost" onClick={() => reset.mutate(r.key)}>Reset</Button>}</Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </QueryState>
    </div>
  )
}

// ───────── Templates ─────────

interface Tpl { subject: string; intro: string; outro: string; action_label: string }

function TemplatesTab() {
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['nadmin', 'templates'], queryFn: () => api.get<{ placeholders: string[]; templates: { key: string; label: string; category: string; email: Tpl | null; push: Tpl | null }[] }>('/api/notifications/admin/templates') })
  const [edit, setEdit] = useState<string | null>(null)
  const [cat, setCat] = useState('')
  const current = q.data?.templates.find((t) => t.key === edit)
  const [email, setEmail] = useState<Tpl>({ subject: '', intro: '', outro: '', action_label: '' })
  const [push, setPush] = useState<Tpl>({ subject: '', intro: '', outro: '', action_label: '' })
  useEffect(() => {
    if (current) {
      setEmail(current.email ?? { subject: '', intro: '', outro: '', action_label: '' })
      setPush(current.push ?? { subject: '', intro: '', outro: '', action_label: '' })
    }
  }, [current])
  const toBody = (t: Tpl) => ({ subject: t.subject, intro: t.intro, outro: t.outro, actionLabel: t.action_label })
  const preview = useQuery({ queryKey: ['nadmin', 'tpl-preview', edit, email, push], enabled: !!edit, queryFn: () => api.post<{ email: { subject: string; html: string }; push: { title: string; body: string } }>(`/api/notifications/admin/templates/${edit}/preview`, { email: toBody(email), push: toBody(push) }) })
  const save = useAction(async () => {
    for (const [ch, t] of [['email', email], ['push', push]] as const) {
      if (t.subject || t.intro || t.outro || t.action_label) await api.put(`/api/notifications/admin/templates/${edit}/${ch}`, toBody(t))
      else if ((ch === 'email' ? current?.email : current?.push)) await api.del(`/api/notifications/admin/templates/${edit}/${ch}`)
    }
  }, { success: 'Template saved', invalidate: [['nadmin', 'templates']], onSuccess: () => setEdit(null) })
  return (
    <div>
      <Filters>
        <Field label="Category" htmlFor="tc"><Select id="tc" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{Object.entries(NOTIFICATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <p className="pb-2 text-[12.5px] text-muted">Every event has a built-in template. Override the wording here; leave a field empty to keep the default.</p>
      </Filters>
      <QueryState q={q}>
        {(d) => (
          <Table>
            <thead><tr><Th>Event</Th><Th>Category</Th><Th>Email</Th><Th>Push</Th><Th /></tr></thead>
            <tbody>
              {d.templates.filter((t) => !cat || t.category === cat).map((t) => (
                <Tr key={t.key} onClick={() => setEdit(t.key)}>
                  <Td className="text-ink">{t.label}</Td>
                  <Td className="text-[12.5px]">{categoryLabel(t.category)}</Td>
                  <Td>{t.email ? <Badge tone="info">Custom</Badge> : <span className="text-[12px] text-muted">Default</span>}</Td>
                  <Td>{t.push ? <Badge tone="info">Custom</Badge> : <span className="text-[12px] text-muted">Default</span>}</Td>
                  <Td><IconButton label="Edit and preview" onClick={(e) => { e.stopPropagation(); setEdit(t.key) }}><Eye className="size-3.5" /></IconButton></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryState>
      {edit && current && (
        <Dialog open onClose={() => setEdit(null)} width={980} title={`Template · ${current.label}`} description={`Placeholders: ${q.data!.placeholders.map((p) => `{{${p}}}`).join(' ')}. Values are inserted as plain text.`} footer={can('notifications.manage') ? <><Button variant="ghost" onClick={() => setEdit(null)}>Close</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></> : undefined}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="text-[12.5px] font-medium text-ink-2">Email</p>
              <Field label="Subject" htmlFor="te1"><Input id="te1" value={email.subject} onChange={(e) => setEmail({ ...email, subject: e.target.value })} placeholder="Default: the notification title" /></Field>
              <Field label="Opening paragraph" htmlFor="te2"><Textarea id="te2" rows={3} value={email.intro} onChange={(e) => setEmail({ ...email, intro: e.target.value })} placeholder="Default: event-specific text" /></Field>
              <Field label="Closing line" htmlFor="te3"><Input id="te3" value={email.outro} onChange={(e) => setEmail({ ...email, outro: e.target.value })} /></Field>
              <Field label="Button label" htmlFor="te4"><Input id="te4" value={email.action_label} maxLength={40} onChange={(e) => setEmail({ ...email, action_label: e.target.value })} placeholder="Open in CRM" /></Field>
              <p className="pt-2 text-[12.5px] font-medium text-ink-2">Push</p>
              <Field label="Title" htmlFor="tp1"><Input id="tp1" value={push.subject} onChange={(e) => setPush({ ...push, subject: e.target.value })} /></Field>
              <Field label="Body" htmlFor="tp2"><Textarea id="tp2" rows={2} value={push.intro} onChange={(e) => setPush({ ...push, intro: e.target.value })} /></Field>
            </div>
            <div className="space-y-2">
              <p className="text-[12.5px] font-medium text-ink-2">Preview (sample data){preview.data && <span className="ml-2 font-normal text-muted">Subject: {preview.data.email.subject}</span>}</p>
              {preview.data && <iframe title="Email preview" sandbox="" srcDoc={preview.data.email.html} className="h-[460px] w-full rounded-md border border-line bg-white" />}
              {preview.data && <div className="rounded-md border border-line bg-canvas/60 px-3 py-2 text-[13px]"><p className="font-medium text-ink">{preview.data.push.title}</p><p className="text-muted">{preview.data.push.body}</p></div>}
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

// ───────── Schedule & escalation ─────────

type Sched = {
  attendance: Record<'reminder' | 'late' | 'missing' | 'exceptions' | 'checkoutReminder' | 'missingCheckout' | 'summary' | 'lateAfter' | 'earlyBefore', string> & { enabled: boolean }
  tasks: { dailyDigest: boolean; dailyDigestTime: string; remind24h: boolean; remindToday: boolean; remind2h: boolean; remind30m: boolean }
  reports: { daily: boolean; weekly: boolean; weeklyDay: number; weeklyTime: string; monthly: boolean; monthlyTime: string; recipients: Record<'dailyHr' | 'dailyAdmin' | 'dailySuperAdmin' | 'weekly' | 'monthly', string[]> }
  meetings: { defaultReminderMinutes: number }
  hr: { celebrations: boolean; leaveReminders: boolean; time: string }
}
type Esc = { maxOverdueReminders: number; taskOverdueHrAfterDays: number; taskOverdueSuperAdminAfterDays: number; superAdminPriorities: string[]; ackReminderHours: number; ackManagerHours: number; workloadOpenTasks: number; workloadOverdueTasks: number }

function Time({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return <Field label={label}><Input type="time" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="w-32" /></Field>
}
function Num({ label, value, onChange, hint, disabled }: { label: string; value: number; onChange: (v: number) => void; hint?: string; disabled?: boolean }) {
  return <Field label={label} hint={hint}><Input type="number" min={0} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-28" /></Field>
}

function ScheduleTab() {
  const { can } = useAuth()
  const full = can('notifications.manage')
  const hrOnly = !full && can('attendance.manage')
  const q = useQuery({ queryKey: ['nadmin', 'schedule'], queryFn: () => api.get<{ schedule: Sched; escalation: Esc; hours: { dayStart: string; dayEnd: string } }>('/api/notifications/admin/schedule') })
  const [s, setS] = useState<Sched | null>(null)
  const [e, setE] = useState<Esc | null>(null)
  useEffect(() => {
    if (q.data && !s) {
      setS(q.data.schedule)
      setE(q.data.escalation)
    }
  }, [q.data, s])
  const save = useAction(async () => {
    await api.put('/api/notifications/admin/schedule', s)
    if (full) await api.put('/api/notifications/admin/escalation', e)
  }, { success: 'Schedules saved', invalidate: [['nadmin', 'schedule']] })
  if (!s || !e) return <QueryState q={q}>{() => null}</QueryState>
  const att = s.attendance
  const setAtt = (k: keyof Sched['attendance'], v: string | boolean) => setS({ ...s, attendance: { ...att, [k]: v } as Sched['attendance'] })
  const dis = !full
  const roleList = (k: keyof Sched['reports']['recipients']) => (
    <Field label={{ dailyHr: 'Daily HR report', dailyAdmin: 'Daily operations report', dailySuperAdmin: 'Daily company report', weekly: 'Weekly report', monthly: 'Monthly report' }[k]} hint="Role keys, comma separated">
      <Input value={s.reports.recipients[k].join(', ')} disabled={dis} onChange={(ev) => setS({ ...s, reports: { ...s.reports, recipients: { ...s.reports.recipients, [k]: ev.target.value.split(',').map((x) => x.trim()).filter(Boolean) } } })} className="w-64" />
    </Field>
  )
  return (
    <div className="space-y-6">
      <p className="text-[12.5px] text-muted">All times are company time (Asia/Kolkata). Jobs run on working days only (weekly rule, verified holidays and overrides) and skip people on approved leave. Missing attendance is reported, never marked absent automatically. A slot that is missed by more than an hour is skipped rather than sent late. Task deadlines are the end of the working day ({q.data!.hours.dayEnd}).</p>
      <Section title="Attendance" actions={<Checkbox label="Enabled" checked={att.enabled} onChange={(ev) => setAtt('enabled', ev.target.checked)} />}>
        <Panel className="flex flex-wrap gap-4 p-4">
          <Time label="Check-in reminder" value={att.reminder} onChange={(v) => setAtt('reminder', v)} />
          <Time label="Late after" value={att.lateAfter} onChange={(v) => setAtt('lateAfter', v)} />
          <Time label="Late detection" value={att.late} onChange={(v) => setAtt('late', v)} />
          <Time label="Missing attendance report" value={att.missing} onChange={(v) => setAtt('missing', v)} />
          <Time label="Exception report" value={att.exceptions} onChange={(v) => setAtt('exceptions', v)} />
          <Time label="Early departure before" value={att.earlyBefore} onChange={(v) => setAtt('earlyBefore', v)} />
          <Time label="Checkout reminder" value={att.checkoutReminder} onChange={(v) => setAtt('checkoutReminder', v)} />
          <Time label="Missing checkout" value={att.missingCheckout} onChange={(v) => setAtt('missingCheckout', v)} />
          <Time label="Daily summary & reports" value={att.summary} onChange={(v) => setAtt('summary', v)} />
        </Panel>
      </Section>
      {hrOnly && <p className="text-[12.5px] text-muted">You can change the attendance schedule. Other schedules and escalation rules are managed by notification administrators.</p>}
      <Section title="Tasks">
        <Panel className="flex flex-wrap items-end gap-4 p-4">
          <Checkbox label="Daily task summary" disabled={dis} checked={s.tasks.dailyDigest} onChange={(ev) => setS({ ...s, tasks: { ...s.tasks, dailyDigest: ev.target.checked } })} />
          <Time label="Summary / due-today time" disabled={dis} value={s.tasks.dailyDigestTime} onChange={(v) => setS({ ...s, tasks: { ...s.tasks, dailyDigestTime: v } })} />
          <Checkbox label="24 h before" disabled={dis} checked={s.tasks.remind24h} onChange={(ev) => setS({ ...s, tasks: { ...s.tasks, remind24h: ev.target.checked } })} />
          <Checkbox label="On the day" disabled={dis} checked={s.tasks.remindToday} onChange={(ev) => setS({ ...s, tasks: { ...s.tasks, remindToday: ev.target.checked } })} />
          <Checkbox label="2 h before" disabled={dis} checked={s.tasks.remind2h} onChange={(ev) => setS({ ...s, tasks: { ...s.tasks, remind2h: ev.target.checked } })} />
          <Checkbox label="30 min before" disabled={dis} checked={s.tasks.remind30m} onChange={(ev) => setS({ ...s, tasks: { ...s.tasks, remind30m: ev.target.checked } })} />
          <Num label="Meeting reminder (min)" disabled={dis} value={s.meetings.defaultReminderMinutes} onChange={(v) => setS({ ...s, meetings: { defaultReminderMinutes: v } })} hint="When an event sets none" />
        </Panel>
      </Section>
      <Section title="Reports">
        <Panel className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <Checkbox label="Daily reports" disabled={dis} checked={s.reports.daily} onChange={(ev) => setS({ ...s, reports: { ...s.reports, daily: ev.target.checked } })} />
            <Checkbox label="Weekly report" disabled={dis} checked={s.reports.weekly} onChange={(ev) => setS({ ...s, reports: { ...s.reports, weekly: ev.target.checked } })} />
            <Field label="Weekly on"><Select disabled={dis} value={s.reports.weeklyDay} onChange={(ev) => setS({ ...s, reports: { ...s.reports, weeklyDay: Number(ev.target.value) } })} className="w-36">{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</Select></Field>
            <Time label="Weekly time" disabled={dis} value={s.reports.weeklyTime} onChange={(v) => setS({ ...s, reports: { ...s.reports, weeklyTime: v } })} />
            <Checkbox label="Monthly report (1st)" disabled={dis} checked={s.reports.monthly} onChange={(ev) => setS({ ...s, reports: { ...s.reports, monthly: ev.target.checked } })} />
            <Time label="Monthly time" disabled={dis} value={s.reports.monthlyTime} onChange={(v) => setS({ ...s, reports: { ...s.reports, monthlyTime: v } })} />
          </div>
          <div className="flex flex-wrap gap-4">{(['dailyHr', 'dailyAdmin', 'dailySuperAdmin', 'weekly', 'monthly'] as const).map((k) => <div key={k}>{roleList(k)}</div>)}</div>
        </Panel>
      </Section>
      <Section title="HR reminders">
        <Panel className="flex flex-wrap items-end gap-4 p-4">
          <Checkbox label="Upcoming leave & on-leave notices" disabled={dis} checked={s.hr.leaveReminders} onChange={(ev) => setS({ ...s, hr: { ...s.hr, leaveReminders: ev.target.checked } })} />
          <Checkbox label="Birthdays & work anniversaries" disabled={dis} checked={s.hr.celebrations} onChange={(ev) => setS({ ...s, hr: { ...s.hr, celebrations: ev.target.checked } })} />
          <Time label="Time" disabled={dis} value={s.hr.time} onChange={(v) => setS({ ...s, hr: { ...s.hr, time: v } })} />
        </Panel>
      </Section>
      <Section title="Escalation" description="Overdue work: the owner is reminded daily up to the maximum; then HR and Admin, then Super Admin for the selected priorities. Resolved items are never escalated.">
        <Panel className="flex flex-wrap items-end gap-4 p-4">
          <Num label="Max owner reminders" disabled={dis} value={e.maxOverdueReminders} onChange={(v) => setE({ ...e, maxOverdueReminders: v })} />
          <Num label="HR & Admin after (days)" disabled={dis} value={e.taskOverdueHrAfterDays} onChange={(v) => setE({ ...e, taskOverdueHrAfterDays: v })} hint="0 = off" />
          <Num label="Super Admin after (days)" disabled={dis} value={e.taskOverdueSuperAdminAfterDays} onChange={(v) => setE({ ...e, taskOverdueSuperAdminAfterDays: v })} hint="0 = off" />
          <Field label="For priorities"><div className="flex gap-3 pt-1.5">{['urgent', 'high', 'medium', 'low'].map((p) => <Checkbox key={p} label={p} disabled={dis} checked={e.superAdminPriorities.includes(p)} onChange={(ev) => setE({ ...e, superAdminPriorities: ev.target.checked ? [...e.superAdminPriorities, p] : e.superAdminPriorities.filter((x) => x !== p) })} />)}</div></Field>
          <Num label="Ack reminder after (h)" disabled={dis} value={e.ackReminderHours} onChange={(v) => setE({ ...e, ackReminderHours: v })} />
          <Num label="Tell manager after (h)" disabled={dis} value={e.ackManagerHours} onChange={(v) => setE({ ...e, ackManagerHours: v })} />
          <Num label="Workload alert: open tasks ≥" disabled={dis} value={e.workloadOpenTasks} onChange={(v) => setE({ ...e, workloadOpenTasks: v })} />
          <Num label="or overdue ≥" disabled={dis} value={e.workloadOverdueTasks} onChange={(v) => setE({ ...e, workloadOverdueTasks: v })} />
        </Panel>
      </Section>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save schedules</Button></div>
    </div>
  )
}

// ───────── Devices, jobs, audit ─────────

function DevicesTab() {
  const { can } = useAuth()
  const [status, setStatus] = useState('active')
  const q = useQuery({ queryKey: ['nadmin', 'devices', status], queryFn: () => api.get<{ devices: Record<string, any>[] }>(`/api/notifications/admin/devices${qs({ status })}`) })
  const revoke = useAction((id: string) => api.del(`/api/notifications/admin/devices/${id}`), { success: 'Device revoked', invalidate: [['nadmin', 'devices']] })
  return (
    <div>
      <Filters><Field label="Status" htmlFor="dvs"><Select id="dvs" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="expired">Expired</option><option value="revoked">Revoked</option><option value="">All</option></Select></Field></Filters>
      <QueryState q={q} empty={(d) => (d.devices.length === 0 ? <Empty title="No devices" body="Devices appear when people enable push under Notifications → Preferences." /> : null)}>
        {(d) => (
          <Table>
            <thead><tr><Th>Person</Th><Th>Device</Th><Th>Status</Th><Th>Added</Th><Th>Last delivery</Th><Th align="right">Failures</Th><Th /></tr></thead>
            <tbody>{d.devices.map((x) => <Tr key={x.id}><Td>{x.user_name}</Td><Td>{x.device_label || 'Device'}<span className="block max-w-[260px] truncate text-[11px] text-muted">{x.endpoint_hint}…</span></Td><Td><Badge tone={x.status === 'active' ? 'ok' : 'outline'}>{x.status}</Badge></Td><Td className="text-muted">{relative(x.created_at)}</Td><Td className="text-muted">{x.last_success_at ? relative(x.last_success_at) : '—'}</Td><Td align="right">{x.failure_count}</Td><Td>{can('notifications.manage') && x.status === 'active' && <IconButton label="Revoke" onClick={() => revoke.mutate(x.id)}><Trash2 className="size-3.5" /></IconButton>}</Td></Tr>)}</tbody>
          </Table>
        )}
      </QueryState>
    </div>
  )
}

const JOB_LABELS: Record<string, string> = {
  'attendance.reminder': 'Attendance reminder', 'attendance.late': 'Late detection', 'attendance.missing': 'Missing attendance report', 'attendance.exceptions': 'Attendance exception report',
  'attendance.checkout_reminder': 'Checkout reminder', 'attendance.missing_checkout': 'Missing checkout detection', 'reports.daily': 'Daily HR / Admin / Super Admin reports',
  'tasks.daily_digest': 'Daily task summaries', 'tasks.deadline_today': 'Due-today reminders', 'tasks.deadline_2h': '2-hour deadline reminders', 'tasks.deadline_30m': '30-minute deadline reminders',
  'escalation.tasks': 'Overdue task escalation', 'hr.leave_reminders': 'Leave reminders', 'hr.celebrations': 'Birthdays & anniversaries', 'reports.weekly': 'Weekly reports', 'reports.monthly': 'Monthly reports',
  'meetings.reminders': 'Meeting reminders', 'announcements.ack_escalation': 'Acknowledgement follow-ups', 'queue.process': 'Process delivery queue', 'housekeeping.notifications': 'Retention clean-up',
}

function JobsTab() {
  const { can } = useAuth()
  const q = useQuery({ queryKey: ['nadmin', 'jobs'], queryFn: () => api.get<{ jobs: Record<string, any>[] }>('/api/notifications/admin/jobs') })
  const esc = useQuery({ queryKey: ['nadmin', 'escalations'], queryFn: () => api.get<{ escalations: Record<string, any>[] }>('/api/notifications/admin/escalations') })
  const [job, setJob] = useState('attendance.reminder')
  const [confirm, setConfirm] = useState(false)
  const run = useAction(() => api.post<{ result: unknown }>('/api/notifications/admin/jobs/run', { job }), { success: (r) => `Done: ${JSON.stringify(r.result)}`, invalidate: [['nadmin']], onSuccess: () => setConfirm(false) })
  return (
    <div className="space-y-6">
      {can('notifications.manage') && (
        <Panel className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Run a job now" htmlFor="jr" hint="Useful after changing schedules or to verify delivery. Per-day de-duplication still applies, so nobody is notified twice."><Select id="jr" value={job} onChange={(e) => setJob(e.target.value)} className="w-full sm:w-80">{Object.entries(JOB_LABELS).filter(([k]) => k !== 'housekeeping.notifications').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Button icon={<Play className="size-4" />} onClick={() => setConfirm(true)}>Run now</Button>
        </Panel>
      )}
      <Section title="Scheduled job runs">
        <QueryState q={q} empty={(d) => (d.jobs.length === 0 ? <Empty title="No runs yet" body="Jobs run from the 5-minute cron in deployed environments." /> : null)}>
          {(d) => (
            <Table>
              <thead><tr><Th>Started</Th><Th>Job</Th><Th>Status</Th><Th>Result</Th></tr></thead>
              <tbody>{d.jobs.map((j) => <Tr key={j.id}><Td className="whitespace-nowrap text-muted">{fmtDateTime(j.started_at)}</Td><Td>{JOB_LABELS[j.job_key] ?? j.job_key}{String(j.run_key).includes(':manual:') && <Badge tone="outline" className="ml-1.5">manual</Badge>}</Td><Td><Badge tone={j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'danger' : 'info'}>{j.status}</Badge></Td><Td className="max-w-[420px] truncate font-mono text-[11.5px] text-muted">{j.error ?? j.detail}</Td></Tr>)}</tbody>
            </Table>
          )}
        </QueryState>
      </Section>
      <Section title="Escalations">
        <QueryState q={esc} empty={(d) => (d.escalations.length === 0 ? <p className="text-[13px] text-muted">No escalations.</p> : null)}>
          {(d) => (
            <Table>
              <thead><tr><Th>Task</Th><Th>Due</Th><Th align="right">Level</Th><Th>Last notified</Th><Th>State</Th></tr></thead>
              <tbody>{d.escalations.map((x) => <Tr key={x.id}><Td>{x.project_reference ? `${x.project_reference}-${x.task_number} ${x.task_title}` : x.entity_id}</Td><Td>{x.cycle_key}</Td><Td align="right">{x.level}</Td><Td className="text-muted">{x.last_notified_at ? relative(x.last_notified_at) : '—'}</Td><Td>{x.resolved_at ? <Badge tone="ok">Resolved</Badge> : <Badge tone="warn">Open</Badge>}</Td></Tr>)}</tbody>
            </Table>
          )}
        </QueryState>
      </Section>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => run.mutate()} loading={run.isPending} title={`Run “${JOB_LABELS[job]}” now?`} body="This sends real notifications to the people the job selects today." confirmLabel="Run job" />
    </div>
  )
}

function AuditTab() {
  const q = useQuery({ queryKey: ['nadmin', 'audit'], queryFn: () => api.get<{ entries: { id: string; action: string; summary: string; created_at: string; actor_name: string | null }[] }>('/api/notifications/admin/audit') })
  return (
    <QueryState q={q} empty={(d) => (d.entries.length === 0 ? <Empty title="No changes recorded yet" /> : null)}>
      {(d) => (
        <Table>
          <thead><tr><Th>When</Th><Th>By</Th><Th>Action</Th><Th>Summary</Th></tr></thead>
          <tbody>{d.entries.map((e) => <Tr key={e.id}><Td className="whitespace-nowrap text-muted">{fmtDateTime(e.created_at)}</Td><Td>{e.actor_name ?? 'System'}</Td><Td className="font-mono text-[11.5px]">{e.action}</Td><Td>{e.summary}</Td></Tr>)}</tbody>
        </Table>
      )}
    </QueryState>
  )
}

// ───────── Page ─────────

export default function NotificationCenter() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const read = can('notifications.read_all')
  const manage = can('notifications.manage')
  const tabs = useMemo(
    () =>
      [
        (read || manage) && { value: 'overview' as Tab, label: 'Overview' },
        read && { value: 'notifications' as Tab, label: 'All notifications' },
        can('notifications.broadcast') && { value: 'broadcasts' as Tab, label: 'Announcements' },
        read && { value: 'deliveries' as Tab, label: 'Delivery logs' },
        (read || manage) && { value: 'rules' as Tab, label: 'Rules' },
        (read || manage) && { value: 'templates' as Tab, label: 'Templates' },
        (manage || read || can('attendance.manage')) && { value: 'schedule' as Tab, label: 'Schedules & escalation' },
        (read || manage) && { value: 'devices' as Tab, label: 'Devices' },
        (read || manage) && { value: 'jobs' as Tab, label: 'Jobs & escalations' },
        (read || manage) && { value: 'audit' as Tab, label: 'Audit' },
      ].filter(Boolean) as { value: Tab; label: string }[],
    [read, manage, can],
  )
  const requested = (params.get('tab') === 'failed' ? 'deliveries' : params.get('tab')) as Tab | null
  const tab = tabs.find((t) => t.value === requested)?.value ?? tabs[0]?.value
  const extra = Object.fromEntries(params.entries())
  if (params.get('tab') === 'failed') extra.status = 'failed_any'
  const go = (t: Tab, p: Record<string, string> = {}) => setParams({ tab: t, ...p })
  if (!tab) return <EmptyState title="Access restricted" body="Your role does not include the notification center." />
  return (
    <div>
      <PageHeader eyebrow="Administration" title="Notification center" meta={<span>In-app, Brevo email and Web Push across every CRM module</span>} />
      <div className={cx('mb-5 border-b border-line')}>
        <Tabs value={tab} onChange={(t) => go(t)} tabs={tabs} />
      </div>
      {tab === 'overview' && <OverviewTab go={go} />}
      {tab === 'notifications' && <NotificationsTab key={extra.category ?? ''} initial={extra} />}
      {tab === 'broadcasts' && <BroadcastsTab />}
      {tab === 'deliveries' && <DeliveriesTab key={extra.status ?? ''} initial={extra} />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'devices' && <DevicesTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  )
}
