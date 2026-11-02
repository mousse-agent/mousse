import { modelLabel } from '../../../shared/modelChoice'
import type { AgentModelRef } from '../../../shared/agents/types'
import type { LlmProviderOption } from '../../../shared/settings'
import { resolveModelChoice } from '../../lib/modelChoice'

/** An agent definition's model by name ("Claude Opus 5.5 · High"). */
export function agentModelLabel(ref: AgentModelRef, providers?: readonly LlmProviderOption[]): string {
  const choice = resolveModelChoice({ instanceId: ref.instanceId, provider: ref.providerId, model: ref.modelId, ...(ref.effort ? { effort: ref.effort } : {}) }, providers)
  return modelLabel({ ...choice, context: choice.context ?? ref.context })
}
