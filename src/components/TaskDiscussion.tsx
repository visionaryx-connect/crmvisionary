// Task discussion: one level of threaded replies and @mentions chosen from the project team. Mentions are sent as
// user ids (the server re-checks each person can read the project), so a typo can never notify the wrong person.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { CornerDownRight, Pencil, Reply, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { relative, fmtDateTime } from '@/lib/format'
import { Avatar, Button, Textarea, cx } from '@/components/ui'

export interface DiscussionComment {
  id: string
  body: string
  created_at: string
  edited_at?: string | null
  author_id: string
  author_name: string
  avatar_color: string | null
  parent_id?: string | null
  mentions?: string[]
}
interface Person {
  id: string
  name: string
}

function Composer({ taskId, people, parentId, initial, editId, onDone, autoFocus, me }: { taskId: string; people: Person[]; parentId?: string | null; initial?: string; editId?: string; onDone?: () => void; autoFocus?: boolean; me: { name: string; avatarColor: string | null } }) {
  const [text, setText] = useState(initial ?? '')
  const [mentions, setMentions] = useState<string[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])
  const matches = useMemo(() => (query === null ? [] : people.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)), [people, query])
  const send = useAction(
    () => {
      // Keep only mentions still present in the text.
      const ids = mentions.filter((id) => text.includes(`@${people.find((p) => p.id === id)?.name ?? '\u0000'}`))
      return editId ? api.patch(`/api/tasks/${taskId}/comments/${editId}`, { body: text, mentions: ids }) : api.post(`/api/tasks/${taskId}/comments`, { body: text, parentId: parentId ?? null, mentions: ids })
    },
    { invalidate: [['task', taskId], ['notifications', 'timeline']], onSuccess: () => { setText(''); setMentions([]); onDone?.() } },
  )
  const onChange = (v: string) => {
    setText(v)
    const caret = ref.current?.selectionStart ?? v.length
    const m = /(^|\s)@([\p{L}\p{N} .'-]{0,30})$/u.exec(v.slice(0, caret))
    setQuery(m ? m[2] : null)
    setActive(0)
  }
  const pick = (p: Person) => {
    const el = ref.current
    const caret = el?.selectionStart ?? text.length
    const before = text.slice(0, caret).replace(/@([\p{L}\p{N} .'-]{0,30})$/u, `@${p.name} `)
    const next = before + text.slice(caret)
    setText(next)
    setMentions((m) => [...new Set([...m, p.id])])
    setQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(before.length, before.length)
    })
  }
  return (
    <form className="flex gap-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate() }}>
      {!editId && <Avatar name={me.name} color={me.avatarColor} size={parentId ? 22 : 28} />}
      <div className="relative flex-1 space-y-2">
        <Textarea
          ref={ref}
          rows={parentId || editId ? 2 : 3}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={parentId ? 'Write a reply… (@ to mention)' : 'Write a comment… Type @ to mention a teammate.'}
          aria-label={parentId ? 'Reply' : 'Comment'}
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]!); return }
              if (e.key === 'Escape') { setQuery(null); return }
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate()
          }}
        />
        {matches.length > 0 && (
          <ul role="listbox" className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-line bg-surface shadow-lg">
            {matches.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === active}>
                <button type="button" className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]', i === active ? 'bg-subtle' : 'hover:bg-canvas')} onMouseDown={(e) => { e.preventDefault(); pick(p) }}>
                  <Avatar name={p.name} size={20} />
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-end gap-2">
          {onDone && <Button size="sm" variant="ghost" type="button" onClick={onDone}>Cancel</Button>}
          <Button size="sm" variant="primary" type="submit" loading={send.isPending} disabled={!text.trim()}>{editId ? 'Save' : parentId ? 'Reply' : 'Comment'}</Button>
        </div>
      </div>
    </form>
  )
}

/** Render text with @Name highlighted for the people who were actually mentioned. */
function Body({ text, mentioned }: { text: string; mentioned: Person[] }) {
  if (mentioned.length === 0) return <>{text}</>
  const names = mentioned.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
  const parts = text.split(new RegExp(`(@(?:${names.join('|')}))`, 'g'))
  return <>{parts.map((p, i) => (p.startsWith('@') && mentioned.some((m) => `@${m.name}` === p) ? <span key={i} className="rounded bg-accent-soft px-0.5 font-medium text-ink">{p}</span> : <span key={i}>{p}</span>))}</>
}

export function TaskDiscussion({ taskId, comments, people, canComment, me }: { taskId: string; comments: DiscussionComment[]; people: Person[]; canComment: boolean; me: { id: string; name: string; avatarColor: string | null } }) {
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const del = useAction((cid: string) => api.del(`/api/tasks/${taskId}/comments/${cid}`), { invalidate: [['task', taskId]] })
  const location = useLocation()
  useEffect(() => {
    const m = /#comment-(.+)$/.exec(location.hash)
    if (m) document.getElementById(`comment-${m[1]}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [location.hash, comments.length])
  const roots = comments.filter((c) => !c.parent_id || !comments.some((p) => p.id === c.parent_id))
  const replies = (id: string) => comments.filter((c) => c.parent_id === id)
  const byId = new Map(people.map((p) => [p.id, p]))
  const highlight = /#comment-(.+)$/.exec(location.hash)?.[1]

  const Item = ({ c, nested }: { c: DiscussionComment; nested?: boolean }) => (
    <div id={`comment-${c.id}`} className={cx('flex gap-3 scroll-mt-24', nested && 'ml-9')}>
      {nested && <CornerDownRight className="mt-1 size-3.5 shrink-0 text-faint" aria-hidden />}
      <Avatar name={c.author_name} color={c.avatar_color} size={nested ? 22 : 28} />
      <div className={cx('min-w-0 flex-1 rounded-lg border bg-surface px-3.5 py-2.5', highlight === c.id ? 'border-accent ring-1 ring-accent/40' : 'border-line')}>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-medium text-ink">{c.author_name}</span>
          <span className="text-muted" title={fmtDateTime(c.created_at)}>{relative(c.created_at)}</span>
          {c.edited_at && <span className="text-faint">edited</span>}
          <span className="ml-auto flex items-center gap-2">
            {canComment && !nested && <button className="text-faint hover:text-ink" aria-label="Reply" onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}><Reply className="size-3.5" /></button>}
            {c.author_id === me.id && <button className="text-faint hover:text-ink" aria-label="Edit comment" onClick={() => setEditing(c.id)}><Pencil className="size-3.5" /></button>}
            {c.author_id === me.id && <button className="text-faint hover:text-danger" aria-label="Delete comment" onClick={() => del.mutate(c.id)}><Trash2 className="size-3.5" /></button>}
          </span>
        </div>
        {editing === c.id ? (
          <div className="mt-2"><Composer taskId={taskId} people={people} editId={c.id} initial={c.body} me={me} autoFocus onDone={() => setEditing(null)} /></div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-ink-2"><Body text={c.body} mentioned={(c.mentions ?? []).map((id) => byId.get(id)).filter((x): x is Person => Boolean(x))} /></p>
        )}
      </div>
    </div>
  )

  return (
    <div className="space-y-3">
      {roots.map((c) => (
        <div key={c.id} className="space-y-2">
          <Item c={c} />
          {replies(c.id).map((r) => <Item key={r.id} c={r} nested />)}
          {replyTo === c.id && <div className="ml-9"><Composer taskId={taskId} people={people} parentId={c.id} me={me} autoFocus onDone={() => setReplyTo(null)} /></div>}
        </div>
      ))}
      {canComment && <Composer taskId={taskId} people={people} me={me} />}
    </div>
  )
}
