import { modelLabel } from '../../../shared/modelChoice'
import type { AgentModelRef } from '../../../shared/agents/types'
import type { LlmProviderOption } from '../../../shared/settings'
import { resolveModelChoice } from '../../lib/modelChoice'

/** An agent definition's model by name ("Claude Opus 5.5 · High"); the ref may keep its level apart from the id. */
export function agentModelLabel(ref: AgentModelRef, providers?: readonly LlmProviderOption[]): string {
  const choice = resolveModelChoice({ instanceId: ref.instanceId, provider: ref.providerId, model: ref.modelId }, providers)
  return modelLabel({ ...choice, effort: choice.effort ?? ref.effort, context: choice.context ?? ref.context })
}
