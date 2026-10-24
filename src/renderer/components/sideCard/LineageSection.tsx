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
  centerAgentId: string | null
  expanded: boolean
  onExpand: () => void
  onOpen: (agentId: string) => void
}

/** Agents this thread started: active ones first, then finished ones. */
export function LineageList({ agents, now, centerAgentId, expanded, onExpand, onOpen }: LineageListProps) {
  if (agents.length === 0) return <p className="side-card-placeholder lineage-empty">No agents started yet</p>

  const { visible, hiddenCount } = sliceLineage(orderLineageAgents(agents), expanded)
  return (
    <ul className="lineage-list">
      {visible.map((agent) => {
        const name = lineageAgentName(agent)
        const working = isWorkingLineageAgent(agent)
        const current = centerAgentId === agent.id
        const status = lineageStatusLabel(agent, now)
        return (
          <li key={agent.id}>
            <button
              type="button"
              className={`lineage-row${current ? ' is-current' : ''}${working ? ' is-working' : ''}`}
              aria-current={current ? 'true' : undefined}
              title={name}
              onClick={() => onOpen(agent.id)}
            >
              {working && <span className="lineage-live" role="img" aria-label="Running" />}
              <span className="lineage-name">{name}</span>
              <span className="lineage-status">{status}</span>
            </button>
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

/** Lists the agents the selected thread started and opens one on click. */
export function LineageSection({ threadId }: SideCardSectionContext) {
  const agents = useAppStore((s) => s.agents)
  const centerAgentId = useAppStore((s) => s.centerAgentId)
  const setCenterAgentId = useAppStore((s) => s.setCenterAgentId)
  // Remembering which thread was expanded resets the list on a thread change
  // without an effect.
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null)
  const expanded = threadId !== null && expandedThreadId === threadId

  const now = useLineageNow(agents.length > 0)

  return (
    <SideCardSection title="Lineage" threadId={threadId}>
      <LineageList
        agents={agents}
        now={now}
        centerAgentId={centerAgentId}
        expanded={expanded}
        onExpand={() => setExpandedThreadId(threadId)}
        onOpen={setCenterAgentId}
      />
    </SideCardSection>
  )
}
