import { useEffect, useState } from 'react'
import { isRunningSubagent, type SubagentSummary } from '../../../shared/subagents'
import { useSubagents } from '../../hooks/useSubagents'
import { openThread } from '../../lib/openThread'
import { SubagentAvatar, useThreadProviderId } from '../SubagentAvatar'
import { subagentBadgeTone, subagentIconId } from '../subagentStatus'
import {
  countRunningSubagents,
  lineageModelLabel,
  lineageStatusLabel,
  lineageSubagentName,
  lineageTitle,
  orderLineageSubagents,
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

interface LineageListProps {
  subagents: readonly SubagentSummary[]
  now: number
  /** The provider the thread runs on, for subagents that name none. */
  inheritedProvider?: string | null
  expanded: boolean
  onExpand: () => void
  /** Opens a subagent's own thread. */
  onOpen: (childThreadId: string) => void
  /** Stops the work a running subagent is doing. */
  onStop: (childThreadId: string) => void
}

/** Subagents this thread started: running ones first, then finished ones. Renders nothing for an empty list; the section collapses instead. */
export function LineageList({ subagents, now, inheritedProvider, expanded, onExpand, onOpen, onStop }: LineageListProps) {
  if (subagents.length === 0) return null

  const { visible, hiddenCount } = sliceLineage(orderLineageSubagents(subagents), expanded)
  return (
    <ul className="lineage-list">
      {visible.map((subagent) => {
        const name = lineageSubagentName(subagent)
        const running = isRunningSubagent(subagent)
        const model = lineageModelLabel(subagent)
        return (
          <li key={subagent.childThreadId} className="lineage-item">
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
      })}
      {hiddenCount > 0 && (
        <li>
          <button type="button" className="lineage-row lineage-more" aria-expanded={false} onClick={onExpand}>
            Show {hiddenCount} more
          </button>
        </li>
      )}
    </ul>
  )
}

/** Lists the subagents the selected thread started. */
export function LineageSection({ threadId }: SideCardSectionContext) {
  const subagents = useSubagents(threadId)
  const inheritedProvider = useThreadProviderId(threadId)
  // Remembering which thread was expanded resets the list on a thread change
  // without an effect.
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null)
  const expanded = threadId !== null && expandedThreadId === threadId

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
        expanded={expanded}
        onExpand={() => setExpandedThreadId(threadId)}
        onOpen={(childThreadId) => void openThread(childThreadId)}
        onStop={(childThreadId) => void window.mousse.orchestrator.abort(childThreadId)}
      />
    </SideCardSection>
  )
}
