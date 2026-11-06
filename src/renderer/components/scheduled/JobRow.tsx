import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { MessageSquare, Play } from '../../lib/icons'
import type { ScheduledJob } from '../../../shared/types'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import type { StatusGlyphKind, TaskStatus } from './scheduledLabels'

const RING = <circle cx="12" cy="12" r="8" />
const GLYPH_PATHS: Record<StatusGlyphKind, ReactNode> = {
  scheduled: RING,
  ok: <>{RING}<path d="M8.5 12.2l2.3 2.3 4.7-4.8" /></>,
  bad: <>{RING}<path d="M9.3 9.3l5.4 5.4M14.7 9.3l-5.4 5.4" /></>,
  needs: <>{RING}<path d="M9.8 10a2.2 2.2 0 1 1 3.3 1.9c-.7.4-1.1.9-1.1 1.6" /><circle cx="12" cy="16.2" r=".7" fill="currentColor" /></>,
  running: <path d="M20 12a8 8 0 1 1-2.4-5.7" />,
  paused: <>{RING}<path d="M10 9.5v5M14 9.5v5" /></>
}

/** The one bit of colour on a row: a ring that says scheduled, done, failed, needs an answer, running or paused. */
export function StatusGlyph({ kind, title }: { kind: StatusGlyphKind; title: string }) {
  return (
    <span className={`scheduled-glyph ${kind}`} data-glyph={kind} title={title} role="img" aria-label={title}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {GLYPH_PATHS[kind]}
      </svg>
    </span>
  )
}

export type PrimaryControl = { kind: 'run' | 'resume' | 'thread'; onPress: () => void }

/**
 * A task as a to-do row: glyph, the task's name, one line of `project · schedule · status [· Open thread] [· Next …]
 * [· Added by an agent, ends …]`, the one primary control and "…". The open row shows its editor under the head, on the
 * same surface.
 */
export function JobRow({
  job,
  open,
  detailsId,
  status,
  segments,
  threadId,
  primary,
  menu,
  onToggle,
  onOpenThread,
  onRowKeyDown,
  children
}: {
  job: ScheduledJob
  open: boolean
  detailsId: string
  status: TaskStatus
  /** The quiet parts of the second line, in order; the status and "Open thread" are placed by the row. */
  segments: { before: Array<{ key: string; text: string; title?: string }>; after: Array<{ key: string; text: string; title?: string }> }
  threadId?: string
  primary: PrimaryControl
  menu: RowMenuItem[]
  onToggle: () => void
  onOpenThread: (threadId: string) => void
  onRowKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  children?: ReactNode
}) {
  const parts: ReactNode[] = [
    ...segments.before.map((item) => <span key={item.key} data-meta={item.key} title={item.title}>{item.text}</span>),
    status.text ? <span key="status" data-meta="status" className={`scheduled-tone-${status.tone}`} title={status.title}>{status.text}</span> : null,
    threadId ? (
      <button key="thread" type="button" className="scheduled-line-link" onClick={() => onOpenThread(threadId)}>Open thread</button>
    ) : null,
    ...segments.after.map((item) => <span key={item.key} data-meta={item.key} title={item.title}>{item.text}</span>)
  ].filter(Boolean)

  // Clicking anywhere on the head opens the row, except on its own buttons.
  const onHeadClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button, a, input, [role="menu"]')) return
    onToggle()
  }

  const primaryLabel = primary.kind === 'run' ? `Run ${job.name} now` : primary.kind === 'resume' ? `Resume ${job.name}` : `Open the thread of ${job.name}'s run`
  const primaryTitle = primary.kind === 'run' ? 'Run now' : primary.kind === 'resume' ? 'Resume' : 'Open thread'

  return (
    <div className="scheduled-row" data-job-id={job.id} data-open={open ? 'true' : undefined} data-paused={job.state === 'paused' ? 'true' : undefined}>
      <div className="scheduled-row-head" onClick={onHeadClick}>
        <StatusGlyph kind={status.glyph} title={status.title} />
        <div className="scheduled-row-main">
          <button
            type="button"
            className="scheduled-row-title"
            data-row-button=""
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            onClick={onToggle}
            onKeyDown={onRowKeyDown}
          >
            {job.name}
          </button>
          <div className="scheduled-row-line">
            {parts.map((part, index) => (
              <span key={index} className="scheduled-row-seg">{part}</span>
            ))}
          </div>
        </div>
        <div className="scheduled-row-actions">
          <button
            type="button"
            className="settings-icon-btn primary"
            data-primary={primary.kind}
            title={primaryTitle}
            aria-label={primaryLabel}
            onClick={primary.onPress}
          >
            {primary.kind === 'thread' ? <MessageSquare size={14} /> : <Play size={14} />}
          </button>
          <RowMenu label={`More actions for ${job.name}`} items={menu} />
        </div>
      </div>
      {open ? <div className="scheduled-row-body" id={detailsId}>{children}</div> : null}
    </div>
  )
}
