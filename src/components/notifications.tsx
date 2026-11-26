import { useQuery } from '@tanstack/react-query'
import { Bell, Mail, Smartphone } from 'lucide-react'
import { CHANNEL_LABEL, NOTIFICATION_CATEGORIES, NOTIFICATION_EVENTS, PRIORITY_LABEL, type Channel, type NotificationPriority } from '@shared/notificationEvents'
import { api } from '@/lib/api'
import { fmtDateTime, relative } from '@/lib/format'
import { Badge, type Tone } from '@/components/ui'

export const categoryLabel = (c?: string | null) => (c && c in NOTIFICATION_CATEGORIES ? NOTIFICATION_CATEGORIES[c as keyof typeof NOTIFICATION_CATEGORIES] : 'Other')
export const eventLabel = (k?: string | null) => (k && k in NOTIFICATION_EVENTS ? NOTIFICATION_EVENTS[k as keyof typeof NOTIFICATION_EVENTS].label : k ?? '—')

const PRIORITY_TONE: Record<NotificationPriority, Tone> = { critical: 'danger', high: 'warn', normal: 'neutral', low: 'outline' }
export function PriorityBadge({ priority, hideNormal = true }: { priority?: string | null; hideNormal?: boolean }) {
  const p = (priority ?? 'normal') as NotificationPriority
  if (hideNormal && (p === 'normal' || p === 'low')) return null
  return <Badge tone={PRIORITY_TONE[p] ?? 'neutral'}>{PRIORITY_LABEL[p] ?? p}</Badge>
}

const STATUS_TONE: Record<string, Tone> = {
  queued: 'neutral', sending: 'info', retry: 'warn', accepted: 'info', sent: 'info', deferred: 'warn', delivered: 'ok', opened: 'ok', clicked: 'ok',
  failed: 'danger', bounced: 'danger', blocked: 'danger', spam: 'danger', unsubscribed: 'warn', skipped: 'outline',
}
export function DeliveryStatus({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>{status}</Badge>
}

const CHANNEL_ICON: Record<Channel, typeof Bell> = { in_app: Bell, email: Mail, push: Smartphone }
export function ChannelIcons({ channels }: { channels: string[] }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted">
      {(channels as Channel[]).filter((c) => c in CHANNEL_ICON).map((c) => {
        const I = CHANNEL_ICON[c]
        return <I key={c} className="size-3.5" aria-label={CHANNEL_LABEL[c]} />
      })}
    </span>
  )
}

/** Communication history of a task or project: what was announced, when, to how many people, on which channels. */
export function NotificationTimeline({ entityType, entityId }: { entityType: 'task' | 'project'; entityId: string }) {
  const q = useQuery({
    queryKey: ['notifications', 'timeline', entityType, entityId],
    queryFn: () => api.get<{ events: { id: string; event_key: string; title: string; created_at: string; recipient_count: number; channels: string[]; actor_name: string | null; priority: string }[] }>(`/api/notifications/timeline?entityType=${entityType}&entityId=${entityId}`),
  })
  if (q.isLoading) return <p className="px-4 py-3 text-[13px] text-muted">Loading…</p>
  const events = q.data?.events ?? []
  if (events.length === 0) return <p className="px-4 py-3 text-[13px] text-muted">No notifications have been sent about this yet.</p>
  return (
    <ol className="divide-y divide-line/70">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-3 px-4 py-2.5">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{e.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
              <span>{eventLabel(e.event_key)}</span>
              <span>·</span>
              <span>{e.recipient_count} recipient{e.recipient_count === 1 ? '' : 's'}</span>
              <ChannelIcons channels={e.channels ?? []} />
              {e.actor_name && <span>· by {e.actor_name}</span>}
              <PriorityBadge priority={e.priority} />
            </p>
          </div>
          <time className="shrink-0 text-[11.5px] text-muted" title={fmtDateTime(e.created_at)}>{relative(e.created_at)}</time>
        </li>
      ))}
    </ol>
  )
}
