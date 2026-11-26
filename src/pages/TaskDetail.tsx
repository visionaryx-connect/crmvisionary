import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Ban, Check, CheckCircle2, Clock, Download, Link2, Pencil, Play, RotateCcw, Send, ShieldAlert, Trash2, Undo2 } from 'lucide-react'
import { TASK_STATUS_LABEL, type TaskStatus } from '@shared/constants'
import { api } from '@/lib/api'
import { useAction } from '@/lib/forms'
import { useAuth } from '@/lib/auth'
import { bytes, fmtDate, fmtDateTime, hours, relative, todayIST } from '@/lib/format'
import { Avatar, Badge, Button, Dialog, ErrorState, Field, IconButton, Input, KeyValue, PageHeader, Panel, Section, SkeletonRows, Tabs, Textarea, cx } from '@/components/ui'
import { DueText, PriorityMark, TaskStatusBadge } from '@/components/status'
import { TaskDialog } from '@/components/TaskDialog'
import { GuideLink, NextStep, Stepper, TASK_STEPS, taskGuidance } from '@/components/Workflow'
import { UploadButton } from './project/Panels'
import { TaskDiscussion, type DiscussionComment } from '@/components/TaskDiscussion'
import { NotificationTimeline } from '@/components/notifications'
import type { ProjectData } from './project/types'

interface TaskDetailData {
  task: Record<string, any> & { id: string; project_id: string; project_reference: string; project_name: string; number: number; title: string; description: string; status: TaskStatus; priority: string; requires_approval: boolean; blocked_reason: string | null }
  assignees: { user_id: string; name: string; avatar_color: string | null }[]
  subtasks: { id: string; title: string; done: boolean; done_by_name: string | null }[]
  dependsOn: { id: string; number: number; title: string; status: string }[]
  blocking: { id: string; number: number; title: string; status: string }[]
  comments: DiscussionComment[]
  mentionable?: { id: string; name: string }[]
  timeEntries: { id: string; user_id: string; user_name: string; work_date: string; minutes: number; note: string }[]
  attachments: { id: string; file_name: string; size_bytes: number; created_at: string; uploaded_by_name: string | null }[]
  submissions: { id: string; submitted_by_name: string; note: string; qty: number | null; submitted_at: string; decision: string; decided_by_name: string | null; decided_at: string | null; decision_note: string }[]
  statusHistory: { from_status: string | null; to_status: string; note: string; changed_at: string; changed_by_name: string | null }[]
  changeLog: { summary: string; created_at: string; actor_name: string | null; changes: Record<string, { from: unknown; to: unknown }> | null }[]
  access: { isAssignee: boolean; canEdit: boolean; canReview: boolean; canContribute: boolean; canUpdateStatus: boolean }
  progressMode: 'equal' | 'effort' | 'milestone'
  /** % of the whole project this task is worth (null in milestone mode or when cancelled). */
  projectShare: number | null
}

export default function TaskDetail() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { me } = useAuth()
  const q = useQuery({ queryKey: ['task', id], queryFn: () => api.get<TaskDetailData>(`/api/tasks/${id}`) })
  const projectQ = useQuery({ queryKey: ['project', q.data?.task.project_id], queryFn: () => api.get<ProjectData>(`/api/projects/${q.data!.task.project_id}`), enabled: !!q.data && q.data.access.canEdit })
  const [editing, setEditing] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState<null | 'approved' | 'revision_requested'>(null)
  const [blockOpen, setBlockOpen] = useState(false)
  const [note, setNote] = useState('')
  const [qty, setQty] = useState('')
  const [subtask, setSubtask] = useState('')
  const [time, setTime] = useState({ workDate: todayIST(), hours: '1', note: '' })
  const [histTab, setHistTab] = useState<'submissions' | 'status' | 'changes'>('submissions')
  useEffect(() => {
    if (params.get('submit') === '1' && q.data) {
      const tq = q.data.task
      setQty(tq.target_qty ? String(Math.max(0, tq.target_qty - Number(tq.approved_qty ?? 0))) : '')
      setSubmitOpen(true)
      setParams({}, { replace: true })
    }
  }, [params, q.data, setParams])

  const inv = [['task', id], ['tasks'], ['project', q.data?.task.project_id ?? ''], ['dashboard']]
  const status = useAction((v: { status: TaskStatus; blockedReason?: string; note?: string }) => api.post(`/api/tasks/${id}/status`, v), { success: 'Status updated', invalidate: inv, onSuccess: () => { setBlockOpen(false); setNote('') } })
  const submit = useAction(() => api.post(`/api/tasks/${id}/submit`, { note, ...(q.data?.task.target_qty && qty ? { qty: Math.round(Number(qty)) } : {}) }), { success: 'Submitted for review — reviewers notified', invalidate: inv, onSuccess: () => { setSubmitOpen(false); setNote('') } })
  const review = useAction((decision: 'approved' | 'revision_requested') => api.post(`/api/tasks/${id}/review`, { decision, note, ...(decision === 'approved' && q.data?.task.target_qty && qty ? { qty: Math.round(Number(qty)) } : {}) }), { success: () => (reviewOpen === 'approved' ? 'Approved — progress updated' : 'Revisions requested'), invalidate: inv, onSuccess: () => { setReviewOpen(null); setNote('') } })
  const addSub = useAction(() => api.post(`/api/tasks/${id}/subtasks`, { title: subtask }), { invalidate: [['task', id], ['tasks']], onSuccess: () => setSubtask('') })
  const toggleSub = useAction((v: { sid: string; done: boolean }) => api.patch(`/api/tasks/${id}/subtasks/${v.sid}`, { done: v.done }), { invalidate: [['task', id], ['tasks']] })
  const delSub = useAction((sid: string) => api.del(`/api/tasks/${id}/subtasks/${sid}`), { invalidate: [['task', id], ['tasks']] })
  const logTime = useAction(() => api.post(`/api/tasks/${id}/time`, { workDate: time.workDate, minutes: Math.round(Number(time.hours) * 60), note: time.note }), { success: 'Time logged', invalidate: [['task', id], ['tasks']], onSuccess: () => setTime({ ...time, note: '' }) })
  const delTime = useAction((eid: string) => api.del(`/api/tasks/${id}/time/${eid}`), { invalidate: [['task', id], ['tasks']] })

  if (q.isLoading) return <SkeletonRows rows={10} />
  if (q.error || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data
  const t = d.task
  const a = d.access
  const open = !['completed', 'cancelled'].includes(t.status)
  const depsOpen = d.dependsOn.filter((x) => !['completed', 'cancelled'].includes(x.status))
  const pendingSub = d.submissions.find((s) => s.decision === 'pending')
  const loggedMinutes = d.timeEntries.reduce((s, e) => s + e.minutes, 0)
  const target: number | null = t.target_qty ?? null
  const unit: string = t.qty_unit || 'units'
  const approvedQty: number = t.status === 'completed' && target ? target : Number(t.approved_qty ?? 0)
  const remainingQty = target ? Math.max(0, target - approvedQty) : 0
  const taskDone = t.status === 'completed' ? 1 : target ? approvedQty / target : 0
  const openSubmit = () => { setNote(''); setQty(target ? String(remainingQty) : ''); setSubmitOpen(true) }
  const openReview = (decision: 'approved' | 'revision_requested') => { setNote(''); setQty(String(pendingSub?.qty ?? remainingQty)); setReviewOpen(decision) }

  return (
    <div>
      <PageHeader
        eyebrow={<span className="inline"><Link to={`/projects/${t.project_id}?tab=board`} className="hover:underline">{t.project_reference} · {t.project_name}</Link><span className="mx-1.5">/</span><span className="whitespace-nowrap">#{t.number}</span></span>}
        title={t.title}
        meta={<><TaskStatusBadge status={t.status} /><PriorityMark priority={t.priority} withLabel /><span>Due <DueText date={t.due_date} open={open} /></span>{t.requires_approval && <span className="inline-flex items-center gap-1"><ShieldAlert className="size-3.5" />Review required</span>}</>}
        actions={
          <>
            {a.canUpdateStatus && ['backlog', 'todo'].includes(t.status) && <Button icon={<Play className="size-4" />} disabled={depsOpen.length > 0} title={depsOpen.length ? 'Waiting on dependencies' : undefined} onClick={() => status.mutate({ status: 'in_progress' })}>Start work</Button>}
            {a.canUpdateStatus && ['todo', 'in_progress'].includes(t.status) && <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setBlockOpen(true)}>Blocked</Button>}
            {a.canUpdateStatus && t.status === 'blocked' && <Button icon={<Play className="size-4" />} onClick={() => status.mutate({ status: 'in_progress', note: 'Unblocked' })}>Unblock</Button>}
            {a.canUpdateStatus && t.requires_approval && ['todo', 'in_progress', 'blocked'].includes(t.status) && <Button variant="primary" icon={<Send className="size-4" />} disabled={depsOpen.length > 0} onClick={openSubmit}>{target && approvedQty > 0 ? 'Submit next part' : 'Submit for review'}</Button>}
            {a.canUpdateStatus && !t.requires_approval && ['todo', 'in_progress'].includes(t.status) && <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => status.mutate({ status: 'completed' })}>Mark complete</Button>}
            {a.canReview && t.status === 'in_review' && pendingSub && (
              <>
                <Button icon={<Undo2 className="size-4" />} onClick={() => openReview('revision_requested')}>Request revisions</Button>
                <Button variant="primary" icon={<Check className="size-4" />} onClick={() => openReview('approved')}>Approve</Button>
              </>
            )}
            {a.canEdit && (t.status === 'completed' || t.status === 'cancelled') && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => status.mutate({ status: 'todo', note: 'Reopened' })}>Reopen</Button>}
            {a.canEdit && open && <Button variant="ghost" onClick={() => status.mutate({ status: 'cancelled' })}>Cancel task</Button>}
            {a.canEdit && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          </>
        }
      />

      {(() => {
        const g = taskGuidance({ status: t.status, requiresApproval: t.requires_approval, isAssignee: a.isAssignee, canReview: a.canReview, canEdit: a.canEdit, openDependencies: depsOpen.length, blockedReason: t.blocked_reason, hasPendingSubmission: Boolean(pendingSub), qty: target ? { approved: approvedQty, target, unit } : null })
        return (
          <section className="mb-8" aria-label="Where this task is">
            {g.current >= 0 && <Stepper steps={TASK_STEPS} current={g.current} warning={g.warning} />}
            <NextStep title={g.title} body={g.body} auto={g.auto} action={<GuideLink />} />
          </section>
        )
      })()}
      {depsOpen.length > 0 && open && <div className="mb-6 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn-bg px-4 py-3 text-[13px] text-warn"><Link2 className="size-4" />Waiting on {depsOpen.map((x) => <Link key={x.id} to={`/tasks/${x.id}`} className="underline">#{x.number} {x.title}</Link>)}</div>}
      {t.status === 'in_review' && pendingSub && <div className="mb-6 rounded-lg border border-info/25 bg-info-bg px-4 py-3 text-[13px] text-info"><span className="font-medium">Awaiting review</span> — submitted by {pendingSub.submitted_by_name} {relative(pendingSub.submitted_at)}{pendingSub.qty ? <> · <b>{pendingSub.qty} {unit}</b></> : null}{pendingSub.note && <>: “{pendingSub.note}”</>}</div>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {(d.projectShare != null || target) && (
            <Section title="Progress contribution">
              <Panel className="grid gap-4 p-4 sm:grid-cols-3">
                {d.projectShare != null && (
                  <div>
                    <div className="eyebrow">Share of project</div>
                    <div className="mt-1 font-display text-[28px] font-bold leading-none tabular text-ink">{d.projectShare}%</div>
                    <p className="mt-1 text-[12px] text-muted">{d.progressMode === 'effort' ? 'Weightage set by the project manager.' : 'Every task counts the same.'}</p>
                  </div>
                )}
                <div className={cx(d.projectShare == null && 'sm:col-span-2')}>
                  <div className="eyebrow">{target ? 'Approved so far' : 'Done'}</div>
                  <div className="mt-1 font-display text-[28px] font-bold leading-none tabular text-ink">{target ? `${approvedQty} / ${target}` : `${Math.round(taskDone * 100)}%`}</div>
                  <p className="mt-1 text-[12px] text-muted">{target ? `${unit} · ${remainingQty ? `${remainingQty} still to deliver` : 'all delivered'}` : t.requires_approval ? 'Counts once a reviewer approves it.' : 'Counts when marked complete.'}</p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-track"><div className={cx('h-full rounded-full', taskDone >= 1 ? 'bg-ok' : 'bg-accent')} style={{ width: `${taskDone * 100}%` }} /></div>
                </div>
                {d.projectShare != null && (
                  <div>
                    <div className="eyebrow">Adds to project</div>
                    <div className="mt-1 font-display text-[28px] font-bold leading-none tabular text-ink">+{Math.round(d.projectShare * taskDone * 10) / 10}%</div>
                    <p className="mt-1 text-[12px] text-muted">of {d.projectShare}% possible</p>
                  </div>
                )}
              </Panel>
            </Section>
          )}

          <Section title="Description">
            <Panel className="p-4 text-[13.5px] leading-relaxed text-ink-2"><p className="whitespace-pre-wrap">{t.description || <span className="text-faint">No description.</span>}</p></Panel>
          </Section>

          <Section title={`Checklist ${d.subtasks.length ? `· ${d.subtasks.filter((s) => s.done).length}/${d.subtasks.length}` : ''}`}>
            <Panel className="divide-y divide-line/70">
              {d.subtasks.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2">
                  <input type="checkbox" className="size-4 accent-accent" checked={s.done} disabled={!a.canUpdateStatus} onChange={(e) => toggleSub.mutate({ sid: s.id, done: e.target.checked })} aria-label={s.title} />
                  <span className={cx('flex-1 text-[13px]', s.done ? 'text-muted line-through' : 'text-ink')}>{s.title}</span>
                  {s.done && s.done_by_name && <span className="text-[11px] text-faint">{s.done_by_name}</span>}
                  {a.canUpdateStatus && <IconButton label="Remove item" onClick={() => delSub.mutate(s.id)}><Trash2 className="size-3.5" /></IconButton>}
                </div>
              ))}
              {a.canUpdateStatus && (
                <form className="flex gap-2 px-4 py-2" onSubmit={(e) => { e.preventDefault(); if (subtask.trim()) addSub.mutate() }}>
                  <Input value={subtask} onChange={(e) => setSubtask(e.target.value)} placeholder="Add a checklist item" className="!h-8" aria-label="New checklist item" />
                  <Button size="sm" type="submit" disabled={!subtask.trim()}>Add</Button>
                </form>
              )}
              {d.subtasks.length === 0 && !a.canUpdateStatus && <p className="px-4 py-3 text-[13px] text-muted">No checklist.</p>}
            </Panel>
          </Section>

          <Section title={`Discussion · ${d.comments.length}`} description="Internal only — never visible to clients. Participants are notified; @mentioned people get a direct alert.">
            <TaskDiscussion taskId={id} comments={d.comments} people={d.mentionable ?? []} canComment={a.canContribute} me={{ id: me.user.id, name: me.user.name, avatarColor: me.user.avatarColor }} />
          </Section>

          <Section title="Notifications sent" description="Who was told about this task, when, and how.">
            <Panel><NotificationTimeline entityType="task" entityId={id} /></Panel>
          </Section>

          <Section title="History">
            <div className="border-b border-line"><Tabs value={histTab} onChange={setHistTab} tabs={[{ value: 'submissions', label: 'Submissions & reviews', count: d.submissions.length }, { value: 'status', label: 'Status changes' }, { value: 'changes', label: 'Field changes' }]} /></div>
            <div className="pt-3">
              {histTab === 'submissions' && (d.submissions.length === 0 ? <p className="text-[13px] text-muted">Not submitted yet.</p> : (
                <ol className="space-y-2">{d.submissions.map((s) => (
                  <li key={s.id} className="rounded-md border border-line bg-surface px-3.5 py-2.5 text-[13px]">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.submitted_by_name}</span><span className="text-muted">submitted {fmtDateTime(s.submitted_at)}</span>
                      <Badge tone={s.decision === 'approved' ? 'ok' : s.decision === 'revision_requested' ? 'warn' : s.decision === 'withdrawn' ? 'outline' : 'info'} className="ml-auto">{s.decision.replace('_', ' ')}</Badge></div>
                    {s.note && <p className="mt-1 text-ink-2">{s.note}</p>}
                    {s.decided_by_name && <p className="mt-1.5 border-t border-line pt-1.5 text-ink-2"><span className="text-muted">{s.decided_by_name} · {fmtDateTime(s.decided_at)}:</span> {s.decision_note || '—'}</p>}
                  </li>
                ))}</ol>
              ))}
              {histTab === 'status' && (
                <ol className="space-y-1.5">{d.statusHistory.map((h, i) => (
                  <li key={i} className="flex flex-wrap gap-2 text-[13px]"><span className="w-32 font-mono text-[11px] leading-5 text-muted">{fmtDateTime(h.changed_at)}</span><span className="text-ink-2">{h.from_status ? `${TASK_STATUS_LABEL[h.from_status as TaskStatus]} → ` : ''}<span className="font-medium text-ink">{TASK_STATUS_LABEL[h.to_status as TaskStatus]}</span> · {h.changed_by_name ?? 'System'}{h.note && ` — ${h.note}`}</span></li>
                ))}</ol>
              )}
              {histTab === 'changes' && (d.changeLog.length === 0 ? <p className="text-[13px] text-muted">No changes recorded.</p> : (
                <ol className="space-y-1.5">{d.changeLog.map((l, i) => (
                  <li key={i} className="text-[13px]"><span className="mr-2 font-mono text-[11px] text-muted">{fmtDateTime(l.created_at)}</span><span className="text-ink-2">{l.actor_name ?? 'System'} — {l.summary}</span></li>
                ))}</ol>
              ))}
            </div>
          </Section>
        </div>

        <aside className="space-y-6">
          <Panel className="p-4">
            <KeyValue cols={1} items={[
              { label: 'Responsible', value: t.responsible_name ? <span className="inline-flex items-center gap-2"><Avatar name={t.responsible_name} color={t.responsible_color} size={22} />{t.responsible_name}</span> : 'Unassigned' },
              { label: 'Also assigned', value: d.assignees.length ? d.assignees.map((x) => x.name).join(', ') : null },
              { label: 'Milestone', value: t.milestone_title },
              { label: 'Dates', value: <>{fmtDate(t.start_date)} → {fmtDate(t.due_date)}</> },
              { label: 'Estimate / logged', value: <>{t.estimate_hours != null ? `${t.estimate_hours} h` : 'No estimate'} / {hours(loggedMinutes)}</> },
              { label: d.progressMode === 'effort' ? 'Weightage' : 'Weight', value: d.progressMode === 'effort' ? `${t.weight}%` : t.weight },
              { label: 'Created', value: <>{fmtDateTime(t.created_at)} by {t.created_by_name ?? '—'}</> },
              ...(t.completed_at ? [{ label: 'Completed', value: <>{fmtDateTime(t.completed_at)}{t.approved_by_name && ` · approved by ${t.approved_by_name}`}</> }] : []),
            ]} />
          </Panel>

          {(d.dependsOn.length > 0 || d.blocking.length > 0) && (
            <Panel className="space-y-3 p-4 text-[13px]">
              {d.dependsOn.length > 0 && <div><div className="eyebrow mb-1">Depends on</div>{d.dependsOn.map((x) => <Link key={x.id} to={`/tasks/${x.id}`} className="flex items-center justify-between py-0.5 hover:underline"><span>#{x.number} {x.title}</span><TaskStatusBadge status={x.status} /></Link>)}</div>}
              {d.blocking.length > 0 && <div><div className="eyebrow mb-1">Blocks</div>{d.blocking.map((x) => <Link key={x.id} to={`/tasks/${x.id}`} className="flex items-center justify-between py-0.5 hover:underline"><span>#{x.number} {x.title}</span><TaskStatusBadge status={x.status} /></Link>)}</div>}
            </Panel>
          )}

          <Panel className="p-4">
            <div className="mb-2 flex items-center justify-between"><span className="eyebrow">Attachments</span>{a.canContribute && <UploadButton projectId={t.project_id} taskId={t.id} label="Attach" onDone={() => q.refetch()} />}</div>
            {d.attachments.length === 0 ? <p className="text-[13px] text-muted">No files.</p> : (
              <ul className="space-y-1.5">{d.attachments.map((f) => (
                <li key={f.id} className="flex items-center gap-2 text-[12.5px]"><a href={`/api/files/${f.id}/download`} className="min-w-0 flex-1 truncate text-ink hover:underline">{f.file_name}</a><span className="text-muted">{bytes(f.size_bytes)}</span><a href={`/api/files/${f.id}/download`} aria-label={`Download ${f.file_name}`}><Download className="size-3.5 text-accent" /></a></li>
              ))}</ul>
            )}
          </Panel>

          <Panel className="p-4">
            <div className="eyebrow mb-2 flex items-center gap-1.5"><Clock className="size-3.5" /> Time log · {hours(loggedMinutes)}</div>
            {a.canContribute && (
              <form className="mb-3 grid grid-cols-[1fr_72px] gap-2" onSubmit={(e) => { e.preventDefault(); logTime.mutate() }}>
                <Input type="date" value={time.workDate} max={todayIST()} onChange={(e) => setTime({ ...time, workDate: e.target.value })} className="!h-8" aria-label="Work date" />
                <Input type="number" min={0.25} step={0.25} value={time.hours} onChange={(e) => setTime({ ...time, hours: e.target.value })} className="!h-8" aria-label="Hours" />
                <Input value={time.note} onChange={(e) => setTime({ ...time, note: e.target.value })} placeholder="What did you work on?" className="col-span-2 !h-8" aria-label="Note" />
                <Button size="sm" type="submit" className="col-span-2" loading={logTime.isPending} disabled={!(Number(time.hours) > 0)}>Log time</Button>
              </form>
            )}
            {d.timeEntries.length === 0 ? <p className="text-[13px] text-muted">No time logged.</p> : (
              <ul className="max-h-60 space-y-1 overflow-y-auto">{d.timeEntries.map((e) => (
                <li key={e.id} className="flex items-center gap-2 text-[12.5px]"><span className="w-16 font-mono text-[11px] text-muted">{fmtDate(e.work_date).replace(/ \d{4}$/, '')}</span><span className="min-w-0 flex-1 truncate text-ink-2">{e.user_name}{e.note && ` · ${e.note}`}</span><span className="font-mono">{hours(e.minutes)}</span>{e.user_id === me.user.id && <button aria-label="Delete entry" onClick={() => delTime.mutate(e.id)} className="text-faint hover:text-danger"><Trash2 className="size-3" /></button>}</li>
              ))}</ul>
            )}
          </Panel>
        </aside>
      </div>

      {editing && projectQ.data && (
        <TaskDialog
          open
          onClose={() => setEditing(false)}
          taskId={t.id}
          ctx={{ projectId: t.project_id, members: projectQ.data.members, milestones: projectQ.data.milestones, progressMode: projectQ.data.project.progress_mode }}
          initial={{ title: t.title, description: t.description, milestoneId: t.milestone_id ?? '', priority: t.priority, responsibleId: t.responsible_id ?? '', assigneeIds: d.assignees.map((x) => x.user_id), startDate: t.start_date ?? '', dueDate: t.due_date ?? '', estimateHours: t.estimate_hours?.toString() ?? '', weight: String(t.weight), countBased: t.target_qty != null, targetQty: t.target_qty?.toString() ?? '', qtyUnit: t.qty_unit ?? '', requiresApproval: t.requires_approval, dependsOn: d.dependsOn.map((x) => x.id) }}
        />
      )}
      <Dialog open={submitOpen} onClose={() => setSubmitOpen(false)} title="Submit for review" description="Reviewers on this project will be notified. Progress updates once the work is approved." footer={<><Button variant="ghost" onClick={() => setSubmitOpen(false)}>Cancel</Button><Button variant="primary" loading={submit.isPending} disabled={!!target && !(Number(qty) >= 1 && Number(qty) <= remainingQty)} onClick={() => submit.mutate()}>Submit</Button></>}>
        <div className="space-y-4">
          {target ? (
            <Field label={`How many ${unit} are in this submission?`} hint={`${approvedQty} of ${target} already approved · up to ${remainingQty} can be submitted. You can deliver the rest in later submissions.`}>
              <Input type="number" min={1} max={remainingQty} step="1" value={qty} onChange={(e) => setQty(e.target.value)} data-autofocus />
            </Field>
          ) : null}
          <Field label="Notes for the reviewer" hint="What was done, where to look, anything still open."><Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={!target} /></Field>
        </div>
      </Dialog>
      <Dialog open={!!reviewOpen} onClose={() => setReviewOpen(null)} title={reviewOpen === 'approved' ? 'Approve this work' : 'Request revisions'} footer={<><Button variant="ghost" onClick={() => setReviewOpen(null)}>Cancel</Button><Button variant={reviewOpen === 'approved' ? 'primary' : 'secondary'} loading={review.isPending} disabled={(reviewOpen === 'revision_requested' && !note.trim()) || (reviewOpen === 'approved' && !!target && !(Number(qty) >= 1 && Number(qty) <= remainingQty))} onClick={() => reviewOpen && review.mutate(reviewOpen)}>{reviewOpen === 'approved' ? 'Approve' : 'Send back'}</Button></>}>
        {reviewOpen === 'approved' && target ? (
          <Field label={`How many ${unit} do you approve?`} className="mb-4" hint={`Submitted: ${pendingSub?.qty ?? remainingQty}. Approved so far: ${approvedQty} of ${target}. The task completes when all ${target} are approved.`}>
            <Input type="number" min={1} max={remainingQty} step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
        ) : null}
        <Field label={reviewOpen === 'approved' ? 'Feedback (optional)' : 'What needs to change?'} hint={reviewOpen === 'approved' ? 'Recorded in the member’s report as manager feedback.' : 'Required — the assignee sees this.'}><Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
      </Dialog>
      <Dialog open={blockOpen} onClose={() => setBlockOpen(false)} title="Mark as blocked" footer={<><Button variant="ghost" onClick={() => setBlockOpen(false)}>Cancel</Button><Button variant="primary" disabled={!note.trim()} loading={status.isPending} onClick={() => status.mutate({ status: 'blocked', blockedReason: note.trim() })}>Mark blocked</Button></>}>
        <Field label="What is blocking this task?" hint="The project reviewers are notified."><Input value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
      </Dialog>
      {editing && !projectQ.data && projectQ.error && <ErrorState error={projectQ.error} />}
    </div>
  )
}
