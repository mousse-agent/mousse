import { LiquidGlassOrb } from '../orb/LiquidGlassOrb'
import type { AgentDefinitionRecord } from '../../../shared/agents/types'
import { AGENT_RUNTIME_LABELS } from './client'

/** Compact read-only definition summary for workflow inspectors. */
export function AgentDefinitionReadOnlySummary({
  record,
  issues
}: {
  record: AgentDefinitionRecord
  issues?: string[]
}) {
  const model = record.settings.primaryModel.ref
  return (
    <article className="agent-card" data-agent-summary={record.id}>
      <LiquidGlassOrb compact appearance={record.visual} />
      <div className="agent-card__body">
        <h3>{record.settings.identity.name}</h3>
        <p>{record.settings.identity.purpose || 'No purpose'}</p>
        <div className="agent-card__meta">
          <span className="agent-chip">{AGENT_RUNTIME_LABELS[record.runtimeKind]}</span>
          <span className="agent-chip">
            {model.modelId ? `${model.providerId}/${model.modelId}` : 'No model'}
          </span>
          <span className="agent-chip">{record.published ? 'Published' : 'Draft'}</span>
          <span className="agent-chip">{record.flags.enabled ? 'Enabled' : 'Disabled'}</span>
          {issues?.map((issue) => (
            <span key={issue} className="agent-chip agent-chip--warn">
              {issue}
            </span>
          ))}
        </div>
        <p>
          <small>
            Shared catalog model. Visual appearance is independent of the execution revision{' '}
            {record.published?.revision ?? record.semanticHash.slice(0, 12)}.
          </small>
        </p>
      </div>
    </article>
  )
}
