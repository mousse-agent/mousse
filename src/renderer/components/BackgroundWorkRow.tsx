import { useState } from 'react'
import { X } from '../lib/icons'
import { isRunningSubagent, type SubagentSummary } from '../../shared/subagents'
import {
  PROVIDER_BACKGROUND_ID,
  backgroundCounts,
  backgroundHeadline,
  type BackgroundWorkItem,
  type ThreadBackgroundWork
} from '../../shared/backgroundWork'
import './backgroundWorkRow.css'

/** One line of the Details list: what it is, a word for its kind, what hovering tells, and how it is stopped. */
export interface BackgroundLine {
  key: string
  title: string
  kind: string
  tooltip: string
  stop: () => void
}

const KIND_WORDS: Record<BackgroundWorkItem['kind'], string> = {
  command: 'Monitor',
  url: 'Monitor',
  background: 'Command',
  keep_working: 'Waiting'
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The Details list: running subagents first, then the thread's own background work, then the provider's. */
export function backgroundLines(
  subagents: readonly SubagentSummary[],
  work: ThreadBackgroundWork | undefined,
  actions: { stopSubagent: (childThreadId: string) => void; stopItem: (id: string) => void }
): BackgroundLine[] {
  return [
    ...subagents.filter(isRunningSubagent).map((subagent) => ({
      key: `subagent:${subagent.childThreadId}`,
      title: subagent.title,
      kind: 'Subagent',
      tooltip: subagent.title,
      stop: () => actions.stopSubagent(subagent.childThreadId)
    })),
    ...(work?.items ?? []).map((item) => ({
      key: item.id,
      title: item.description,
      kind: KIND_WORDS[item.kind],
      tooltip: [item.command ?? item.url, item.latest, `Ends by ${clock(item.until)} at the latest`].filter(Boolean).join('\n'),
      stop: () => actions.stopItem(item.id)
    })),
    ...(work?.providerWork
      ? [{ key: PROVIDER_BACKGROUND_ID, title: 'Agent background work', kind: 'Command', tooltip: 'Background agents or shells the agent started', stop: () => actions.stopItem(PROVIDER_BACKGROUND_ID) }]
      : [])
  ]
}

interface BackgroundWorkRowViewProps {
  headline: string
  latest?: string
  lines: readonly BackgroundLine[]
  open: boolean
  onToggle: () => void
  onStopAll: () => void
}

/**
 * Top of the composer while the thread waits on background work: one line naming what it waits on and the latest thing
 * any of it reported, Details (the list, each with its own Stop) and Stop (all of it, as the thread's Stop). It changes
 * only when the work does (the daemon sends a new latest line at most every couple of seconds); nothing on it moves.
 */
export function BackgroundWorkRowView({ headline, latest, lines, open, onToggle, onStopAll }: BackgroundWorkRowViewProps) {
  return (
    <div className="composer-banner background-work" role="status" aria-label="Background work">
      <div className="composer-banner-row">
        <span className="composer-banner-text background-work-text" title={latest ? `${headline}\n${latest}` : headline}>
          {headline}
          {latest && <span className="background-work-latest"> · {latest}</span>}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={onToggle}>
          Details
        </button>
        <button type="button" className="btn btn-ghost btn-sm" title="Stop all background work" onClick={onStopAll}>
          Stop
        </button>
      </div>
      {open && (
        <ul className="background-work-list" aria-label="What runs in the background">
          {lines.map((line) => (
            <li key={line.key} className="background-work-line" title={line.tooltip}>
              <span className="background-work-title">{line.title}</span>
              <span className="background-work-kind">{line.kind}</span>
              <button type="button" className="background-work-stop" aria-label={`Stop ${line.title}`} title="Stop" onClick={line.stop}>
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The row for a thread, from its subagents and the background work the daemon pushed; nothing while none runs. */
export function BackgroundWorkRow({ threadId, subagents, work, onStopAll }: {
  threadId: string
  subagents: readonly SubagentSummary[]
  work: ThreadBackgroundWork | undefined
  onStopAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const counts = backgroundCounts(work, subagents.filter(isRunningSubagent).length)
  const headline = backgroundHeadline(counts)
  if (!headline) return null
  const lines = backgroundLines(subagents, work, {
    stopSubagent: (childThreadId) => void window.mousse.orchestrator.abort(childThreadId),
    stopItem: (id) => void window.mousse.threads.stopBackground(threadId, id)
  })
  return (
    <BackgroundWorkRowView
      headline={headline}
      {...(work?.latest ? { latest: work.latest.line } : {})}
      lines={lines}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onStopAll={onStopAll}
    />
  )
}
