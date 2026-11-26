import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Bell, BellRing, CheckCheck, Clock, Mail, MailOpen, Search, Settings2, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { NOTIFICATION_CATEGORIES } from '@shared/notificationEvents'
import { api, qs } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { fmtDateTime, relative } from '@/lib/format'
import { usePush } from '@/lib/push'
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, IconButton, Input, PageHeader, QueryState, Section, Select, SkeletonRows, Tabs, cx } from '@/components/ui'
import { PriorityBadge, categoryLabel } from '@/components/notifications'
import { useToast } from '@/components/toast'

interface N {
  id: string; kind: string; event_key: string | null; category: string | null; priority: string; title: string; body: string; link: string | null
  read_at: string | null; created_at: string; requires_ack: boolean; acknowledged_at: string | null; archived_at: string | null; snoozed_until: string | null; actor_name: string | null; broadcast_id: string | null
}
interface Page { notifications: N[]; unread: number; actionRequired: number; nextBefore: string | null }
type View = 'all' | 'unread' | 'action' | 'snoozed' | 'archived'

// ───────── Preferences ─────────

interface Prefs {
  channels: { email: boolean; push: boolean }
  preferences: { kind: string; label: string; locked: boolean; inApp: boolean; email: boolean; push: boolean; events: { key: string; label: string; mandatory: boolean }[] }[]
  settings: { emailEnabled: boolean; pushEnabled: boolean; quietStart: string | null; quietEnd: string | null; dailyDigest: boolean; weeklyDigest: boolean; emailSuppressed: { at: string; reason: string } | null }
}

function Devices() {
  const push = usePush()
  const toast = useToast()
  const q = useQuery({ queryKey: ['notifications', 'devices'], queryFn: () => api.get<{ subscriptions: { id: string; device_label: string; status: string; created_at: string; last_success_at: string | null; failure_count: number }[] }>('/api/notifications/push/subscriptions') })
  const remove = useAction((id: string) => api.del(`/api/notifications/push/subscriptions/${id}`), { success: 'Device removed', invalidate: [['notifications', 'devices']] })
  const test = useAction(() => api.post<{ delivery: { status: string; last_error: string | null; recipient: string | null } | null }>('/api/notifications/push/test'), {
    onSuccess: (r) => toast(r.delivery?.status === 'sent' ? { tone: 'ok', title: `Test sent to ${r.delivery.recipient}` } : { tone: 'error', title: 'Test push was not delivered', body: r.delivery?.last_error ?? 'No active device' }),
  })
  const msg: Record<string, string> = {
    unsupported: 'This browser does not support push notifications.',
    'ios-install': 'On iPhone and iPad, add the CRM to your Home Screen first (Share → Add to Home Screen), then open it from there to enable notifications.',
    'disabled-server': push.serverProblem ?? 'Push notifications have not been configured on the server yet.',
    denied: 'Notifications are blocked for this site. Allow them in your browser’s site settings, then reload this page.',
    subscribed: 'This device receives push notifications.',
    available: 'Get alerts on this device even when the CRM is closed.',
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-canvas/60 px-3 py-2.5">
        <p className="text-[13px] text-ink-2"><Smartphone className="mr-1.5 inline size-4 align-[-3px]" />{msg[push.state]}</p>
        <div className="flex gap-2">
          {push.state === 'available' && <Button size="sm" variant="primary" loading={push.busy} onClick={() => push.enable().then((ok) => { if (ok) q.refetch() }).catch((e: Error) => toast({ tone: 'error', title: e.message }))}>Enable on this device</Button>}
          {push.state === 'subscribed' && <><Button size="sm" loading={test.isPending} onClick={() => test.mutate()}>Send test</Button><Button size="sm" variant="ghost" loading={push.busy} onClick={() => push.disable().then(() => q.refetch())}>Turn off here</Button></>}
        </div>
      </div>
      {(q.data?.subscriptions.length ?? 0) > 0 && (
        <ul className="divide-y divide-line/70 rounded-md border border-line">
          {q.data!.subscriptions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <span className="flex-1">{s.device_label || 'Device'} <span className="text-muted">· added {relative(s.created_at)}{s.last_success_at ? ` · last delivered ${relative(s.last_success_at)}` : ''}</span></span>
              <Badge tone={s.status === 'active' ? 'ok' : 'outline'}>{s.status}</Badge>
              {s.status === 'active' && <IconButton label="Remove device" onClick={() => remove.mutate(s.id)}><Trash2 className="size-3.5" /></IconButton>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Preferences({ onClose }: { onClose: () => void }) {
  const q = useQuery({ queryKey: ['notifications', 'prefs'], queryFn: () => api.get<Prefs>('/api/notifications/preferences') })
  const [rows, setRows] = useState<Prefs['preferences'] | null>(null)
  const [settings, setSettings] = useState<Prefs['settings'] | null>(null)
  useEffect(() => {
    if (q.data && !rows) {
      setRows(q.data.preferences)
      setSettings(q.data.settings)
    }
  }, [q.data, rows])
  const save = useAction(
    () => api.put('/api/notifications/preferences', { preferences: rows!.filter((r) => !r.locked).map((r) => ({ kind: r.kind, inApp: r.inApp, email: r.email, push: r.push })), settings: { emailEnabled: settings!.emailEnabled, pushEnabled: settings!.pushEnabled, quietStart: settings!.quietStart || null, quietEnd: settings!.quietEnd || null, dailyDigest: settings!.dailyDigest, weeklyDigest: settings!.weeklyDigest } }),
    { success: 'Preferences saved', invalidate: [['notifications']], onSuccess: onClose },
  )
  const set = (kind: string, ch: 'inApp' | 'email' | 'push', v: boolean) => setRows((r) => r!.map((x) => (x.kind === kind ? { ...x, [ch]: v } : x)))
  const ch = q.data?.channels
  return (
    <Dialog open onClose={onClose} width={760} title="Notification preferences" description="Choose how you hear about each kind of activity. Security notices and notices marked mandatory by your administrators are always delivered." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!rows} onClick={() => save.mutate()}>Save preferences</Button></>}>
      <QueryState q={q}>
        {() =>
          rows && settings ? (
            <div className="space-y-6">
              <Section title="Channels">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Checkbox label="Email notifications" description={ch?.email ? 'Sent from the company address via Brevo.' : 'Email is not configured on the server yet.'} disabled={!ch?.email} checked={Boolean(ch?.email) && settings.emailEnabled} onChange={(e) => setSettings({ ...settings, emailEnabled: e.target.checked })} />
                  <Checkbox label="Push notifications" description={ch?.push ? 'On devices you enable below.' : 'Push is not configured on the server yet.'} disabled={!ch?.push} checked={Boolean(ch?.push) && settings.pushEnabled} onChange={(e) => setSettings({ ...settings, pushEnabled: e.target.checked })} />
                  <Checkbox label="Daily task summary" description="A morning email of your tasks for the day." checked={settings.dailyDigest} onChange={(e) => setSettings({ ...settings, dailyDigest: e.target.checked })} />
                  <Checkbox label="Weekly digest" description="Your week in review every Monday." checked={settings.weeklyDigest} onChange={(e) => setSettings({ ...settings, weeklyDigest: e.target.checked })} />
                </div>
                {settings.emailSuppressed && <p className="mt-3 rounded-md bg-warn-bg px-3 py-2 text-[12.5px] text-warn">Email to your address is paused: {settings.emailSuppressed.reason}. Ask an administrator to clear it once the address works again.</p>}
              </Section>
              <Section title="Quiet hours" description="Normal and low priority email and push wait until quiet hours end. High-priority and critical notices are never held.">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="From" htmlFor="qs"><Input id="qs" type="time" value={settings.quietStart ?? ''} onChange={(e) => setSettings({ ...settings, quietStart: e.target.value || null })} className="w-32" /></Field>
                  <Field label="Until" htmlFor="qe"><Input id="qe" type="time" value={settings.quietEnd ?? ''} onChange={(e) => setSettings({ ...settings, quietEnd: e.target.value || null })} className="w-32" /></Field>
                  {(settings.quietStart || settings.quietEnd) && <Button size="sm" variant="ghost" onClick={() => setSettings({ ...settings, quietStart: null, quietEnd: null })}>Clear</Button>}
                </div>
              </Section>
              <Section title="Devices"><Devices /></Section>
              <Section title="By activity">
                <div className="rounded-md border border-line">
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 z-10 bg-surface"><tr className="text-left text-[10.5px] uppercase tracking-[0.12em] text-muted"><th className="px-3 py-2 font-medium">Activity</th><th className="px-2 py-2 text-center font-medium">In-app</th><th className="px-2 py-2 text-center font-medium">Email</th><th className="px-2 py-2 text-center font-medium">Push</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.kind} className="border-t border-line/70">
                          <td className="px-3 py-2">
                            <span className="text-ink">{r.label}</span>
                            {r.locked && <ShieldCheck className="ml-1.5 inline size-3.5 text-muted" aria-label="Always on" />}
                            {r.events.some((e) => e.mandatory) && !r.locked && <span className="ml-1.5 text-[11px] text-muted">some notices mandatory</span>}
                          </td>
                          {(['inApp', 'email', 'push'] as const).map((c) => (
                            <td key={c} className="px-2 py-2 text-center">
                              <input type="checkbox" className="size-4 accent-accent" aria-label={`${r.label}: ${c}`} disabled={r.locked || (c === 'email' && !ch?.email) || (c === 'push' && !ch?.push)} checked={r[c] && !(c === 'email' && !ch?.email) && !(c === 'push' && !ch?.push)} onChange={(e) => set(r.kind, c, e.target.checked)} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </div>
          ) : (
            <SkeletonRows rows={6} />
          )
        }
      </QueryState>
    </Dialog>
  )
}

// ───────── Inbox ─────────

function dayGroup(iso: string): string {
  const d = new Date(iso)
  const key = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400_000)
  if (key(d) === key(today)) return 'Today'
  if (key(d) === key(yesterday)) return 'Yesterday'
  if (Date.now() - d.getTime() < 7 * 86400_000) return 'This week'
  return 'Earlier'
}

function tomorrowNine(): string {
  const ist = new Date(Date.now() + 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  return new Date(`${ist}T09:00:00+05:30`).toISOString()
}

export default function Notifications() {
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState<View>((params.get('view') as View) || 'all')
  const [category, setCategory] = useState(params.get('category') ?? '')
  const [priority, setPriority] = useState('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const broadcast = params.get('broadcast') ?? undefined
  const prefs = params.get('prefs') === '1'
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  const filters = { view, category: category || undefined, priority: priority || undefined, q: q || undefined, broadcast }
  const list = useInfiniteQuery({
    queryKey: ['notifications', 'list', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<Page>(`/api/notifications${qs({ ...filters, before: pageParam ?? undefined })}`),
    getNextPageParam: (p) => p.nextBefore,
  })
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.notifications) ?? [], [list.data])
  const first = list.data?.pages[0]
  const inv = [['notifications']]
  const markAll = useAction(() => api.post('/api/notifications/read', { all: true }), { invalidate: inv })
  const read = useAction((v: { ids: string[]; unread?: boolean }) => api.post(v.unread ? '/api/notifications/unread' : '/api/notifications/read', { ids: v.ids }), { invalidate: inv, silentError: true })
  const ack = useAction((id: string) => api.post(`/api/notifications/${id}/ack`), { success: 'Acknowledged', invalidate: inv })
  const archive = useAction((v: { ids: string[]; restore?: boolean }) => api.post('/api/notifications/archive', v), { invalidate: inv })
  const snooze = useAction((v: { id: string; until: string | null }) => api.post(`/api/notifications/${v.id}/snooze`, { until: v.until }), { success: 'Updated', invalidate: inv })

  const groups = useMemo(() => {
    const out: { label: string; items: N[] }[] = []
    for (const n of items) {
      const g = dayGroup(n.created_at)
      const last = out[out.length - 1]
      if (last?.label === g) last.items.push(n)
      else out.push({ label: g, items: [n] })
    }
    return out
  }, [items])

  const changeView = (v: View) => {
    setView(v)
    const p = new URLSearchParams(params)
    p.set('view', v)
    p.delete('broadcast')
    setParams(p, { replace: true })
  }

  return (
    <div>
      <PageHeader
        eyebrow="Inbox"
        title="Notifications"
        meta={first && <span>{first.unread} unread{first.actionRequired ? ` · ${first.actionRequired} need acknowledgement` : ''}</span>}
        actions={<><Button variant="ghost" icon={<Settings2 className="size-4" />} onClick={() => setParams({ ...Object.fromEntries(params), prefs: '1' })}>Preferences</Button><Button icon={<CheckCheck className="size-4" />} onClick={() => markAll.mutate()} disabled={!first?.unread}>Mark all read</Button></>}
      />
      <div className="mb-3 border-b border-line">
        <Tabs value={view} onChange={changeView} tabs={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread', count: first?.unread }, { value: 'action', label: <><span className="sm:hidden">To acknowledge</span><span className="hidden sm:inline">Needs acknowledgement</span></>, count: first?.actionRequired }, { value: 'snoozed', label: 'Snoozed' }, { value: 'archived', label: 'Archived' }]} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <div className="relative col-span-2 sm:min-w-[220px] sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notifications" aria-label="Search notifications" className="pl-8" />
        </div>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="w-full sm:w-auto">
          <option value="">All categories</option>
          {Object.entries(NOTIFICATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority" className="w-full sm:w-auto">
          <option value="">Any priority</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </Select>
        {broadcast && <Badge tone="info" className="col-span-2 w-fit">Showing one announcement <button className="ml-1 underline" onClick={() => { const p = new URLSearchParams(params); p.delete('broadcast'); setParams(p) }}>clear</button></Badge>}
      </div>

      <QueryState
        q={{ data: list.data, isLoading: list.isLoading, error: list.error, refetch: list.refetch }}
        empty={() => (items.length === 0 ? <EmptyState icon={<Bell className="size-7" strokeWidth={1.4} />} title={view === 'unread' ? 'No unread notifications' : view === 'action' ? 'Nothing waiting for acknowledgement' : q || category || priority ? 'No notifications match these filters' : 'No notifications yet'} /> : null)}
      >
        {() => (
          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{g.label}</h2>
                <ul className="divide-y divide-line/70 rounded-lg border border-line bg-surface">
                  {g.items.map((n) => {
                    const needsAck = n.requires_ack && !n.acknowledged_at
                    const body = (
                      <div className="min-w-0 flex-1">
                        <p className={cx('text-[13.5px]', n.read_at ? 'text-ink-2' : 'font-medium text-ink')}>{n.title}</p>
                        {n.body && <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-[12.5px] text-muted">{n.body}</p>}
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
                          <span>{categoryLabel(n.category)}</span>
                          {n.actor_name && <span>· {n.actor_name}</span>}
                          <PriorityBadge priority={n.priority} />
                          {needsAck && <Badge tone="warn">Acknowledgement required</Badge>}
                          {n.acknowledged_at && <Badge tone="ok">Acknowledged</Badge>}
                          {n.snoozed_until && view === 'snoozed' && <span>· until {fmtDateTime(n.snoozed_until)}</span>}
                        </p>
                      </div>
                    )
                    return (
                      <li key={n.id} className={cx('group relative flex items-start gap-3 px-4 py-3', !n.read_at && 'bg-accent-soft/20', (n.priority === 'critical' || n.priority === 'high') && !n.read_at && 'border-l-2 border-l-warn')}>
                        <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-highlight')} aria-label={n.read_at ? undefined : 'Unread'} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-3">
                            {n.link ? <Link to={n.link} className="min-w-0 flex-1" onClick={() => !n.read_at && read.mutate({ ids: [n.id] })}>{body}</Link> : <button className="min-w-0 flex-1 text-left" onClick={() => !n.read_at && read.mutate({ ids: [n.id] })}>{body}</button>}
                            <time className="shrink-0 pt-0.5 text-[11.5px] text-muted" title={fmtDateTime(n.created_at)}>{relative(n.created_at)}</time>
                          </div>
                          {needsAck && <Button size="sm" variant="primary" className="mt-2" onClick={() => ack.mutate(n.id)} loading={ack.isPending && ack.variables === n.id}>Acknowledge</Button>}
                          {/* Phones: always-visible action row under the text. Larger screens: compact toolbar on hover / focus. */}
                          <div className="-ml-1.5 mt-1.5 flex flex-wrap items-center gap-0.5 sm:absolute sm:bottom-2 sm:right-3 sm:ml-0 sm:mt-0 sm:rounded-md sm:border sm:border-line sm:bg-surface sm:p-0.5 sm:opacity-0 sm:shadow-pop sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                            <IconButton label={n.read_at ? 'Mark unread' : 'Mark read'} onClick={() => read.mutate({ ids: [n.id], unread: Boolean(n.read_at) })}>{n.read_at ? <Mail className="size-4 sm:size-3.5" /> : <MailOpen className="size-4 sm:size-3.5" />}</IconButton>
                            {view !== 'archived' && !needsAck && (
                              <>
                                <IconButton label="Snooze 1 hour" onClick={() => snooze.mutate({ id: n.id, until: new Date(Date.now() + 3600_000).toISOString() })}><Clock className="size-4 sm:size-3.5" /></IconButton>
                                <IconButton label="Snooze until tomorrow 9:00" onClick={() => snooze.mutate({ id: n.id, until: tomorrowNine() })}><BellRing className="size-4 sm:size-3.5" /></IconButton>
                                <IconButton label="Archive" onClick={() => archive.mutate({ ids: [n.id] })}><Archive className="size-4 sm:size-3.5" /></IconButton>
                              </>
                            )}
                            {view === 'snoozed' && <Button size="sm" variant="ghost" onClick={() => snooze.mutate({ id: n.id, until: null })}>Unsnooze</Button>}
                            {view === 'archived' && <IconButton label="Restore" onClick={() => archive.mutate({ ids: [n.id], restore: true })}><ArchiveRestore className="size-4 sm:size-3.5" /></IconButton>}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
            {list.hasNextPage && <div className="flex justify-center"><Button onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>Load older</Button></div>}
          </div>
        )}
      </QueryState>
      {prefs && <Preferences onClose={() => { const p = new URLSearchParams(params); p.delete('prefs'); setParams(p, { replace: true }) }} />}
    </div>
  )
}
