// "How progress is calculated": every task's share of the project, how much of it is approved, and what it adds
// to the overall percentage. Project managers set each task's weightage (%) right here.
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { taskFraction, taskUnit, type ProgressMode } from '@shared/progress'
import { api, ApiError } from '@/lib/api'
import { Button, Panel, Section, cx } from '@/components/ui'
import { TaskStatusBadge } from '@/components/status'
import { useToast } from '@/components/toast'
import type { TaskRow } from './types'

const round1 = (n: number) => Math.round(n * 10) / 10

/** Quantity text for count-based tasks, e.g. "2 / 4 videos". */
export function qtyText(t: { target_qty: number | null; approved_qty: number | null; qty_unit: string | null; status: string }) {
  if (!t.target_qty) return null
  const done = t.status === 'completed' ? t.target_qty : (t.approved_qty ?? 0)
  return `${done} / ${t.target_qty} ${t.qty_unit || 'units'}`
}

function WeightInput({ task, onSaved }: { task: TaskRow; onSaved: () => void }) {
  const [v, setV] = useState(String(task.weight))
  const toast = useToast()
  useEffect(() => setV(String(task.weight)), [task.weight])
  const save = async () => {
    const n = Number(v)
    if (!(n > 0) || n > 100) {
      toast({ tone: 'error', title: 'Weightage must be between 0.1 and 100' })
      setV(String(task.weight))
      return
    }
    if (n === task.weight) return
    try {
      await api.patch(`/api/tasks/${task.id}`, { weight: n })
      onSaved()
    } catch (e) {
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not save' })
      setV(String(task.weight))
    }
  }
  return (
    <label className="inline-flex items-center gap-1">
      <span className="sr-only">Weightage for {task.title}</span>
      <input
        type="number" min={0.1} max={100} step={1} inputMode="decimal" value={v}
        onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="h-8 w-16 rounded-md border border-line bg-canvas px-2 text-right font-mono text-[13px] text-ink focus:border-ink focus:outline-none"
      />
      <span className="text-[12px] text-muted">%</span>
    </label>
  )
}

export function ProgressBreakdown({ projectId, mode, tasks, progress, canEdit }: { projectId: string; mode: ProgressMode; tasks: TaskRow[]; progress: number; canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const rows = tasks.filter((t) => t.status !== 'cancelled')
  if (rows.length === 0) return null
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tasks'] })
    qc.invalidateQueries({ queryKey: ['project', projectId] })
  }
  const weighted = mode === 'effort'
  const totalUnits = rows.reduce((s, t) => s + taskUnit(t, mode), 0)
  const enteredTotal = round1(rows.reduce((s, t) => s + t.weight, 0))
  const share = (t: TaskRow) => (mode === 'milestone' || totalUnits === 0 ? null : (taskUnit(t, mode) / totalUnits) * 100)

  const scaleTo100 = async () => {
    setBusy(true)
    try {
      for (const t of rows) {
        const w = Math.max(0.1, round1((t.weight / enteredTotal) * 100))
        if (w !== t.weight) await api.patch(`/api/tasks/${t.id}`, { weight: w })
      }
      toast({ tone: 'ok', title: 'Weightage now totals 100%' })
    } catch (e) {
      toast({ tone: 'error', title: e instanceof ApiError ? e.message : 'Could not update weightage' })
    } finally {
      setBusy(false)
      refresh()
    }
  }

  return (
    <Section
      title="How progress is calculated"
      description={
        weighted
          ? 'Each task carries a % share of the project. A share only counts once the work is approved; count-based tasks (e.g. 4 videos) add their share as each part is approved.'
          : mode === 'equal'
            ? 'Every task counts the same. Switch the progress method to Weightage in project settings to give tasks different shares.'
            : 'Milestones carry the weight; tasks inside a milestone count equally.'
      }
    >
      <Panel className="overflow-hidden">
        {weighted && (
          <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 text-[13px]', Math.abs(enteredTotal - 100) > 0.5 ? 'bg-warn-bg text-warn' : 'text-ink-2')}>
            <Scale className="size-4" />
            <span className="min-w-0 flex-1">
              Weightage total: <b className="font-mono">{enteredTotal}%</b>
              {Math.abs(enteredTotal - 100) > 0.5 && ` — shares are scaled so the project still adds up to 100%.`}
            </span>
            {canEdit && Math.abs(enteredTotal - 100) > 0.5 && <Button size="sm" loading={busy} onClick={scaleTo100}>Make it 100%</Button>}
          </div>
        )}
        <ul className="divide-y divide-line/70">
          {rows.map((t) => {
            const f = taskFraction(t)
            const s = share(t)
            const q = qtyText(t)
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 basis-[12rem]">
                  <Link to={`/tasks/${t.id}`} className="block truncate text-[13.5px] font-medium text-ink hover:underline">#{t.number} {t.title}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <TaskStatusBadge status={t.status} />
                    {q && <span className="font-mono">{q} approved</span>}
                    {t.responsible_name && <span>{t.responsible_name}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="w-24">
                    <div className="mb-1 text-right font-mono text-[11.5px] text-muted">{Math.round(f * 100)}% done</div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-track"><div className={cx('h-full rounded-full', f >= 1 ? 'bg-ok' : 'bg-accent')} style={{ width: `${f * 100}%` }} /></div>
                  </div>
                  {weighted && canEdit ? <WeightInput task={t} onSaved={refresh} /> : s != null && <span className="w-14 text-right font-mono text-[13px] text-ink-2" title="Share of project">{round1(s)}%</span>}
                  {s != null && (
                    <span className="w-16 text-right font-mono text-[13px] text-ink" title="Adds to project progress">+{round1(s * f)}%</span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="flex items-center justify-between border-t border-line bg-subtle px-4 py-3 text-[13px]">
          <span className="text-ink-2">Overall project progress</span>
          <span className="font-display text-[20px] font-bold tabular text-ink">{Math.round(progress)}%</span>
        </div>
      </Panel>
    </Section>
  )
}
