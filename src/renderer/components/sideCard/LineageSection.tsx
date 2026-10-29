import { useEffect, useId, useState } from 'react'
import { isRunningSubagent, type SubagentSummary } from '../../../shared/subagents'
import { useSubagents } from '../../hooks/useSubagents'
import { ChevronRight } from '../../lib/icons'
import { openThread } from '../../lib/openThread'
import { SubagentAvatar, useThreadProviderId } from '../SubagentAvatar'
import { subagentBadgeTone, subagentIconId } from '../subagentStatus'
import {
  countRunningSubagents,
  finishedGroupLabel,
  groupLineageSubagents,
  LINEAGE_RUNNING_COUNT,
  lineageModelLabel,
  lineageStatusLabel,
  lineageSubagentName,
  lineageTitle,
  sliceLineage,
  stopAllSubagents
} from './lineageLogic'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './lineage.css'

/** Relative labels are minutes-coarse, so a slow tick keeps them fresh without churn. */
const LINEAGE_TICK_MS = 30_000

function useLineageNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), LINEAGE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [enabled])
  return now
}

/** Which parts of the list the user opened: more running rows, the finished group, and more finished rows. */
export interface LineageOpenParts {
  running: boolean
  finished: boolean
  finishedAll: boolean
}

export const LINEAGE_CLOSED: LineageOpenParts = { running: false, finished: false, finishedAll: false }

interface LineageListProps {
  subagents: readonly SubagentSummary[]
  now: number
  /** The provider the thread runs on, for subagents that name none. */
  inheritedProvider?: string | null
  open: LineageOpenParts
  onOpenPart: (part: keyof LineageOpenParts, value: boolean) => void
  /** Opens a subagent's own thread. */
  onOpen: (childThreadId: string) => void
  /** Stops the work a running subagent is doing. */
  onStop: (childThreadId: string) => void
}

interface LineageRowProps {
  subagent: SubagentSummary
  now: number
  inheritedProvider?: string | null
  onOpen: (childThreadId: string) => void
  onStop: (childThreadId: string) => void
}

function LineageRow({ subagent, now, inheritedProvider, onOpen, onStop }: LineageRowProps) {
  const name = lineageSubagentName(subagent)
  const running = isRunningSubagent(subagent)
  const model = lineageModelLabel(subagent)
  return (
    <li className="lineage-item">
      <button
        type="button"
        className={`lineage-row${running ? ' is-working' : ''}`}
        title={name}
        onClick={() => onOpen(subagent.childThreadId)}
      >
        <SubagentAvatar providerId={subagentIconId(subagent.provider, inheritedProvider)} tone={subagentBadgeTone(subagent)} />
        <span className="lineage-text">
          <span className="lineage-name">{name}</span>
          {model && <span className="lineage-model">{model}</span>}
        </span>
        <span className="lineage-status">{lineageStatusLabel(subagent, now)}</span>
      </button>
      {running && (
        <button
          type="button"
          className="lineage-stop"
          aria-label={`Stop ${name}`}
          onClick={() => onStop(subagent.childThreadId)}
        >
          Stop
        </button>
      )}
    </li>
  )
}

function ShowMoreRow({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <li>
      <button type="button" className="lineage-row lineage-more" aria-expanded={false} onClick={onExpand}>
        Show {count} more
      </button>
    </li>
  )
}

/**
 * Subagents this thread started. A few running ones show first; finished ones fold into one
 * "N finished" row that opens to list them. Renders nothing for an empty list; the section collapses instead.
 */
export function LineageList({ subagents, now, inheritedProvider, open, onOpenPart, onOpen, onStop }: LineageListProps) {
  const finishedId = useId()
  if (subagents.length === 0) return null

  const { running, finished } = groupLineageSubagents(subagents)
  const runningSlice = sliceLineage(running, open.running, LINEAGE_RUNNING_COUNT)
  const finishedSlice = sliceLineage(finished, open.finishedAll)
  const rowProps = { now, inheritedProvider, onOpen, onStop }
  return (
    <ul className="lineage-list">
      {runningSlice.visible.map((subagent) => <LineageRow key={subagent.childThreadId} subagent={subagent} {...rowProps} />)}
      {runningSlice.hiddenCount > 0 && <ShowMoreRow count={runningSlice.hiddenCount} onExpand={() => onOpenPart('running', true)} />}
      {finished.length > 0 && (
        <li className="lineage-group" data-open={open.finished}>
          <button
            type="button"
            className="lineage-row lineage-group-toggle"
            aria-expanded={open.finished}
            aria-controls={open.finished ? finishedId : undefined}
            onClick={() => onOpenPart('finished', !open.finished)}
          >
            <span className="lineage-group-icon" aria-hidden="true">
              <ChevronRight className="lineage-group-chevron" size={12} strokeWidth={2} />
            </span>
            <span className="lineage-text">
              <span className="lineage-name">{finishedGroupLabel(finished)}</span>
            </span>
            {!open.finished && <span className="lineage-status">{lineageStatusLabel(finished[0], now)}</span>}
          </button>
          {open.finished && (
            <ul id={finishedId} className="lineage-list lineage-sublist">
              {finishedSlice.visible.map((subagent) => <LineageRow key={subagent.childThreadId} subagent={subagent} {...rowProps} />)}
              {finishedSlice.hiddenCount > 0 && <ShowMoreRow count={finishedSlice.hiddenCount} onExpand={() => onOpenPart('finishedAll', true)} />}
            </ul>
          )}
        </li>
      )}
    </ul>
  )
}

/** Lists the subagents the selected thread started. */
export function LineageSection({ threadId }: SideCardSectionContext) {
  const subagents = useSubagents(threadId)
  const inheritedProvider = useThreadProviderId(threadId)
  // Remembering which thread the choices belong to resets the list on a thread change
  // without an effect.
  const [openState, setOpenState] = useState<{ threadId: string | null; parts: LineageOpenParts }>({ threadId: null, parts: LINEAGE_CLOSED })
  const open = threadId !== null && openState.threadId === threadId ? openState.parts : LINEAGE_CLOSED

  const now = useLineageNow(subagents.length > 0)

  // With nothing to list the section is one quiet line without a heading, like Git without a repository.
  if (subagents.length === 0) {
    return (
      <div className="side-card-section lineage-collapsed" data-thread-id={threadId ?? undefined}>
        <p className="lineage-empty">No subagents started yet</p>
      </div>
    )
  }

  return (
    <SideCardSection
      title={lineageTitle(subagents)}
      collapseKey="Lineage"
      threadId={threadId}
      action={
        // Stop all stops each subagent that is working, with everything below it, and leaves this thread's own turn running.
        threadId !== null && countRunningSubagents(subagents) > 0 ? (
          <button
            type="button"
            className="lineage-stop-all"
            aria-label="Stop all subagents"
            onClick={() =>
              void stopAllSubagents({ stopAll: window.mousse.subagents.stopAll, abort: window.mousse.orchestrator.abort }, threadId, subagents)
            }
          >
            Stop all
          </button>
        ) : undefined
      }
    >
      <LineageList
        subagents={subagents}
        now={now}
        inheritedProvider={inheritedProvider}
        open={open}
        onOpenPart={(part, value) => setOpenState({ threadId, parts: { ...open, [part]: value } })}
        onOpen={(childThreadId) => void openThread(childThreadId)}
        onStop={(childThreadId) => void window.mousse.orchestrator.abort(childThreadId)}
      />
    </SideCardSection>
  )
}
