import { LiquidGlassOrb } from '../orb/LiquidGlassOrb'
import type { AgentLibraryItem } from './client'
import { AGENT_RUNTIME_LABELS } from './client'
import { publicationState } from './libraryFilter'

export function AgentCard({
  item,
  selected,
  onOpen
}: {
  item: AgentLibraryItem
  selected?: boolean
  onOpen: (id: string) => void
}) {
  const state = publicationState(item)
  const issueCount = item.issues?.length ?? 0
  return (
    <button
      type="button"
      className="agent-card"
      data-agent-card={item.id}
      aria-pressed={selected}
      onClick={() => onOpen(item.id)}
    >
      <LiquidGlassOrb compact appearance={item.visual} />
      <div className="agent-card__body">
        <h3>{item.name}</h3>
        <p>{item.purpose || 'No purpose yet'}</p>
        <div className="agent-card__meta">
          <span className="agent-chip">{AGENT_RUNTIME_LABELS[item.runtimeKind]}</span>
          {item.modelLabel ? <span className="agent-chip">{item.modelLabel}</span> : null}
          <span className="agent-chip">{item.enabled ? 'Enabled' : 'Disabled'}</span>
          <span className="agent-chip">
            {state === 'published' ? 'Published' : state === 'unpublished-changes' ? 'Draft changes' : 'Draft'}
          </span>
          {item.favorite ? <span className="agent-chip">Favorite</span> : null}
          {issueCount > 0 ? (
            <span className="agent-chip agent-chip--warn">
              {issueCount} {issueCount === 1 ? 'issue' : 'issues'}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )
}
