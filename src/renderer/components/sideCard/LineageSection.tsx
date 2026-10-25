import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import type { Agent } from '../../../shared/types'
import {
  isWorkingLineageAgent,
  lineageAgentName,
  lineageStatusLabel,
  orderLineageAgents,
  sliceLineage
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
  agents: readonly Agent[]
  now: number
  expanded: boolean
  onExpand: () => void
}

/** Agents this thread started: active ones first, then finished ones. Renders nothing for an empty list; the section collapses instead. */
export function LineageList({ agents, now, expanded, onExpand }: LineageListProps) {
  if (agents.length === 0) return null

  const { visible, hiddenCount } = sliceLineage(orderLineageAgents(agents), expanded)
  return (
    <ul className="lineage-list">
      {visible.map((agent) => {
        const name = lineageAgentName(agent)
        const working = isWorkingLineageAgent(agent)
        const status = lineageStatusLabel(agent, now)
        return (
          <li key={agent.id}>
            <div className={`lineage-row${working ? ' is-working' : ''}`} title={name}>
              {working && <span className="lineage-live" role="img" aria-label="Running" />}
              <span className="lineage-name">{name}</span>
              <span className="lineage-status">{status}</span>
            </div>
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

/** Lists the agents the selected thread started. */
export function LineageSection({ threadId }: SideCardSectionContext) {
  const agents = useAppStore((s) => s.agents)
  // Remembering which thread was expanded resets the list on a thread change
  // without an effect.
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null)
  const expanded = threadId !== null && expandedThreadId === threadId

  const now = useLineageNow(agents.length > 0)

  // With nothing to list the section is one quiet line without a heading, like Git without a repository.
  if (agents.length === 0) {
    return (
      <div className="side-card-section lineage-collapsed" data-thread-id={threadId ?? undefined}>
        <p className="lineage-empty">No agents started yet</p>
      </div>
    )
  }

  return (
    <SideCardSection title="Lineage" threadId={threadId}>
      <LineageList
        agents={agents}
        now={now}
        expanded={expanded}
        onExpand={() => setExpandedThreadId(threadId)}
      />
    </SideCardSection>
  )
}
