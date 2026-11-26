import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell, BarChart3, Megaphone, Briefcase, CalendarDays, ChevronLeft, ChevronsLeft, ChevronsRight, CircleUserRound, ClipboardCheck, FileStack, FolderKanban, LayoutGrid, LogOut, Menu,
  Compass, Download, Plus, Search, Settings, ShieldCheck, Sparkles, Users, UsersRound, Clock3, X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useRealtimeStatus } from '@/lib/realtime'
import { Avatar, BrandLockup, BrandMark, cx, Kbd } from '@/components/ui'
import { CommandPalette } from './CommandPalette'
import { AiTaskDialog } from '@/components/AiTaskDialog'
import { InstallAppDialog } from '@/components/InstallApp'
import { isStandalone } from '@/lib/pwa'
import { syncPushSubscription } from '@/lib/push'
import { relative } from '@/lib/format'

interface NavItem {
  to: string
  label: string
  icon: typeof LayoutGrid
  perm?: string[]
  end?: boolean
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Work',
    items: [
      { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
      { to: '/tasks', label: 'My work', icon: ClipboardCheck },
      { to: '/today', label: "Today's tasks", icon: CalendarDays },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/clients', label: 'Clients', icon: Briefcase },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/files', label: 'Documents', icon: FileStack },
    ],
  },
  {
    group: 'People',
    items: [
      { to: '/team', label: 'Team', icon: UsersRound, perm: ['team.read'] },
      { to: '/hr/leave', label: 'Leave', icon: CircleUserRound },
      { to: '/hr/attendance', label: 'Attendance', icon: Clock3 },
    ],
  },
  {
    group: 'Insight',
    items: [
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/guide', label: 'Workflow guide', icon: Compass },
    ],
  },
  {
    group: 'Admin',
    items: [
      { to: '/admin/users', label: 'Users & roles', icon: Users, perm: ['users.manage', 'roles.manage', 'security.manage'] },
      { to: '/admin/notifications', label: 'Notification center', icon: Megaphone, perm: ['notifications.read_all', 'notifications.manage', 'notifications.broadcast', 'attendance.manage'] },
      { to: '/admin/audit', label: 'Security & audit', icon: ShieldCheck, perm: ['audit.read', 'security.manage'] },
      { to: '/settings', label: 'Settings', icon: Settings, perm: ['settings.manage', 'holidays.manage', 'departments.manage', 'leave.manage'] },
    ],
  },
]

function useCollapsed() {
  const [collapsed, set] = useState(() => {
    try {
      return localStorage.getItem('vx.nav.collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    set((c) => {
      try {
        localStorage.setItem('vx.nav.collapsed', c ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !c
    })
  return [collapsed, toggle] as const
}

function Sidebar({ collapsed, onToggle, mobile, onNavigate }: { collapsed: boolean; onToggle?: () => void; mobile?: boolean; onNavigate?: () => void }) {
  const { can } = useAuth()
  return (
    <nav aria-label="Main" className={cx('flex h-full flex-col border-r border-line bg-canvas text-ink-2', collapsed ? 'w-[60px]' : 'w-[228px]')}>
      <div className={cx('flex h-14 items-center border-b border-line', collapsed ? 'justify-center' : 'px-4')}>
        {collapsed ? <BrandMark size={28} /> : <BrandLockup size={28} sub="Operations" />}
              </div>
      <div className="flex-1 overflow-y-auto py-3">
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perm || can(...i.perm))
          if (items.length === 0) return null
          return (
            <div key={g.group} className="mb-4">
              {!collapsed && <div className="mb-1 px-4 text-[10px] font-medium uppercase tracking-[0.2em] text-faint">{g.group}</div>}
              <ul className="space-y-px px-2">
            {items.map((i) => (
                  <li key={i.to}>
                    <NavLink
                      to={i.to}
                      end={i.end}
                      onClick={onNavigate}
                      title={collapsed ? i.label : undefined}
                      className={({ isActive }) =>
                        cx(
                          'group relative flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors',
                          collapsed ? 'justify-center' : 'px-2.5',
                          isActive ? 'bg-subtle text-ink' : 'text-ink-2 hover:bg-subtle/70 hover:text-ink',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-ink" aria-hidden />}
                          <i.icon className="size-[15px] shrink-0" strokeWidth={1.7} />
                          {!collapsed && <span>{i.label}</span>}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
      {!mobile && onToggle && (
        <button onClick={onToggle} className="flex h-10 items-center justify-center gap-2 border-t border-line text-[12px] text-muted hover:text-ink" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="size-4" /> : (<><ChevronsLeft className="size-4" /> Collapse</>)}
        </button>
      )}
    </nav>
  )
}

function LiveIndicator() {
  const s = useRealtimeStatus()
  const label = s === 'live' ? 'Live updates on' : s === 'connecting' ? 'Connecting…' : 'Offline — reconnecting'
  return (
    <span className="hidden items-center gap-1.5 text-[11.5px] text-muted md:inline-flex" title={label}>
      <span className={cx('size-1.5 rounded-full', s === 'live' ? 'bg-ok' : s === 'connecting' ? 'bg-highlight animate-pulse' : 'bg-danger')} aria-hidden />
      {s === 'live' ? 'Live' : s === 'connecting' ? 'Connecting' : 'Offline'}
    </span>
  )
}

function UserMenu() {
  const { me } = useAuth()
  const [open, setOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const nav = useNavigate()
  const qc = useQueryClient()
  const logout = async () => {
    try {
      await api.post('/api/auth/logout')
    } finally {
      qc.clear()
      nav('/login', { replace: true })
    }
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 hover:bg-subtle" aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={me.user.name} color={me.user.avatarColor} size={26} />
        <span className="hidden text-left leading-tight lg:block">
          <span className="block text-[12.5px] font-medium text-ink">{me.user.name}</span>
          <span className="block text-[11px] text-muted">{me.roles[0]?.name}</span>
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-40 mt-1 w-56 animate-rise rounded-lg border border-line bg-surface p-1 shadow-pop" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
            <div className="border-b border-line px-3 py-2">
              <p className="text-[13px] font-medium">{me.user.name}</p>
              <p className="truncate text-[12px] text-muted">{me.user.email}</p>
            </div>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-canvas" onClick={() => { setOpen(false); nav(`/team/${me.user.id}`) }}>
              <CircleUserRound className="size-4 text-muted" /> My profile
            </button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-canvas" onClick={() => { setOpen(false); nav('/account') }}>
              <ShieldCheck className="size-4 text-muted" /> Account & security
            </button>
            {!isStandalone() && (
              <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] hover:bg-canvas" onClick={() => { setOpen(false); setInstallOpen(true) }}>
                <Download className="size-4 text-muted" /> Install app
              </button>
            )}
            <button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] text-danger hover:bg-danger-bg" onClick={logout}>
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
      <InstallAppDialog open={installOpen} onClose={() => setInstallOpen(false)} />
    </div>
  )
}

function QuickCreate() {
  const { can } = useAuth()
  const [open, setOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const nav = useNavigate()
  const items = [
    can('projects.create') && { label: 'New project', to: '/projects?new=1' },
    can('clients.manage') && { label: 'New client', to: '/clients?new=1' },
    { label: 'Schedule meeting', to: '/calendar?new=1' },
    can('leave.request') && { label: 'Request leave', to: '/hr/leave?new=1' },
  ].filter(Boolean) as { label: string; to: string }[]
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[11.5px] font-bold uppercase tracking-[0.12em] text-canvas hover:bg-accent-hover" aria-haspopup="menu" aria-expanded={open}>
        <Plus className="size-3.5" /> <span className="hidden sm:inline">Create</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-40 mt-1 w-48 animate-rise rounded-lg border border-line bg-surface p-1 shadow-pop">
            <button role="menuitem" onClick={() => { setOpen(false); setAiOpen(true) }} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13px] font-medium hover:bg-canvas"><Sparkles className="size-4" /> Assign task with AI</button>
            <div className="my-1 border-t border-line" />
            {items.map((i) => (
              <button key={i.to} role="menuitem" onClick={() => { setOpen(false); nav(i.to) }} className="block w-full rounded px-3 py-2 text-left text-[13px] hover:bg-canvas">
                {i.label}
              </button>
            ))}
          </div>
        </>
      )}
      <AiTaskDialog open={aiOpen} onClose={() => setAiOpen(false)} />
    </div>
  )
}

function NotificationBell() {
  const q = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ unread: number; actionRequired: number; urgent: number }>('/api/notifications/count'), refetchInterval: 120_000 })
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const list = useQuery({ queryKey: ['notifications', 'bell'], enabled: open, queryFn: () => api.get<{ notifications: { id: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string; priority: string; requires_ack: boolean; acknowledged_at: string | null }[] }>('/api/notifications?view=all') })
  const qc = useQueryClient()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  useEffect(() => {
    void syncPushSubscription()
  }, [])
  const n = q.data?.unread ?? 0
  const urgent = (q.data?.urgent ?? 0) > 0 || (q.data?.actionRequired ?? 0) > 0
  const openItem = async (item: { id: string; link: string | null; read_at: string | null }) => {
    setOpen(false)
    if (!item.read_at) await api.post('/api/notifications/read', { ids: [item.id] }).catch(() => undefined)
    qc.invalidateQueries({ queryKey: ['notifications'] })
    nav(item.link ?? '/notifications')
  }
  return (
    <div className="sm:relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="relative inline-flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-subtle" aria-haspopup="dialog" aria-expanded={open} aria-label={`Notifications${n ? `, ${n} unread` : ''}${urgent ? ', some need attention' : ''}`}>
        <Bell className="size-[17px]" strokeWidth={1.7} />
        {n > 0 && <span className={cx('absolute right-1 top-1 min-w-[15px] rounded-full px-1 text-center font-mono text-[9.5px] leading-[15px]', urgent ? 'bg-danger text-canvas' : 'bg-ink text-canvas')}>{n > 99 ? '99+' : n}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Recent notifications" className="absolute inset-x-3 top-full z-50 mt-1.5 animate-rise overflow-hidden rounded-lg border border-line bg-surface shadow-pop sm:inset-x-auto sm:right-0 sm:top-10 sm:mt-0 sm:w-[380px]">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[12.5px] font-medium text-ink">Notifications{n ? ` · ${n} unread` : ''}</span>
            <button className="text-[12px] text-muted hover:text-ink" disabled={!n} onClick={async () => { await api.post('/api/notifications/read', { all: true }); qc.invalidateQueries({ queryKey: ['notifications'] }) }}>Mark all read</button>
          </div>
          <ul className="max-h-[min(420px,65dvh)] divide-y divide-line/70 overflow-y-auto overscroll-contain">
            {list.isLoading && <li className="px-3 py-4 text-[13px] text-muted">Loading…</li>}
            {list.data?.notifications.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">You’re all caught up.</li>}
            {list.data?.notifications.slice(0, 8).map((item) => (
              <li key={item.id}>
                <button onClick={() => openItem(item)} className="flex w-full items-start gap-2.5 px-3.5 py-3 text-left hover:bg-canvas/70 sm:px-3 sm:py-2.5">
                  <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', item.read_at ? 'bg-transparent' : item.priority === 'critical' || item.priority === 'high' ? 'bg-danger' : 'bg-highlight')} />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate text-[13px]', item.read_at ? 'text-ink-2' : 'font-medium text-ink')}>{item.title}</span>
                    {item.body && <span className="block truncate text-[12px] text-muted">{item.body}</span>}
                    {item.requires_ack && !item.acknowledged_at && <span className="text-[11px] text-warn">Acknowledgement required</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{relative(item.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => { setOpen(false); nav('/notifications') }} className="block w-full border-t border-line px-3 py-2 text-center text-[12.5px] text-ink-2 hover:bg-canvas/70">View all notifications</button>
        </div>
      )}
    </div>
  )
}

const TAB_ROOTS = new Set(['/', '/tasks', '/today', '/projects'])

/**
 * Phones: back chevron on every screen below the tab roots. Installed iPhone apps have no browser back button and
 * no edge-swipe back, so without this a detail page is a dead end. Falls back to Home when there is no in-app history.
 */
function MobileBack() {
  const loc = useLocation()
  const nav = useNavigate()
  if (TAB_ROOTS.has(loc.pathname)) return <span className="md:hidden"><BrandMark size={26} /></span>
  const canGoBack = ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0
  return (
    <button onClick={() => (canGoBack ? nav(-1) : nav('/'))} aria-label="Back" className="-ml-2 inline-flex h-9 items-center gap-0.5 rounded-md pr-2 text-[14px] text-ink md:hidden">
      <ChevronLeft className="size-6" strokeWidth={1.8} />
      <span className="sr-only">Back</span>
    </button>
  )
}

/** Phone tab bar: the four most-used destinations plus the full menu, like a native app. */
function BottomTabs({ onMenu }: { onMenu: () => void }) {
  const tabs = [
    { to: '/', label: 'Home', icon: LayoutGrid, end: true },
    { to: '/tasks', label: 'My work', icon: ClipboardCheck },
    { to: '/today', label: 'Today', icon: CalendarDays },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
  ]
  return (
    <nav aria-label="Primary" className="no-print relative z-40 shrink-0 border-t border-line bg-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden">
      <div className="grid h-14 grid-cols-5">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cx('flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium', isActive ? 'text-ink' : 'text-muted')}>
            {({ isActive }) => (
              <>
                <t.icon className="size-[21px]" strokeWidth={isActive ? 2 : 1.6} />
                <span>{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button onClick={onMenu} className="flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium text-muted" aria-label="Open menu">
          <Menu className="size-[21px]" strokeWidth={1.6} />
          <span>Menu</span>
        </button>
      </div>
    </nav>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [collapsed, toggle] = useCollapsed()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => setMobileOpen(false), [loc.pathname])
  const mainRef = useRef<HTMLElement>(null)
  // New page → start at the top (the content pane is the scroller, so the browser won't do this for us).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [loc.pathname])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-[var(--app-height,100dvh)] overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <div className="no-print hidden shrink-0 transition-[width] duration-200 md:block">
        <Sidebar collapsed={collapsed} onToggle={toggle} />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" onClick={() => setMobileOpen(false)} />
          <div className="relative flex h-full w-[240px] max-w-[85vw] flex-col bg-canvas animate-rise pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
            <Sidebar collapsed={false} mobile onNavigate={() => setMobileOpen(false)} />
            <button onClick={() => setMobileOpen(false)} className="absolute right-2 top-[calc(env(safe-area-inset-top)+0.75rem)] text-ink/80" aria-label="Close menu">
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print relative z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-3 border-b border-line bg-canvas/85 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur md:pl-6 md:pr-6">
          <MobileBack />
          <button onClick={() => setPaletteOpen(true)} aria-label="Search" className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-line bg-surface px-3 text-left text-[13px] text-muted hover:border-line-strong rounded-full sm:w-full sm:max-w-[420px]">
            <Search className="size-3.5 shrink-0" />
            <span className="hidden flex-1 truncate sm:block">Search projects, tasks, clients, people</span>
            <span className="hidden sm:inline-flex gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LiveIndicator />
            <QuickCreate />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main id="main" ref={mainRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-[1320px] px-[max(1rem,env(safe-area-inset-left))] py-5 pb-8 md:px-8 md:py-8">{children ?? <Outlet />}</div>
        </main>
        <BottomTabs onMenu={() => setMobileOpen(true)} />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
