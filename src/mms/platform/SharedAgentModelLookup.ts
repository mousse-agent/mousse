import type { AgentCapabilityKind, AgentModelCapabilityProfile, AgentModelLookup, AgentModelRef } from '../../shared/agents/types'
import { getModelEffortLevels } from '../../shared/modelEfforts'
import { findModelFamily, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { ProviderAuthService } from '../providers/ProviderAuthService'

/** Catalog presence is not an authentication check; the executor acquires credentials at dispatch. */
export class SharedAgentModelLookup implements AgentModelLookup {
  constructor(private readonly providers: ProviderAuthService) {}

  resolve(ref: AgentModelRef): AgentModelCapabilityProfile | null {
    const models = this.providers.models.getModels(ref.providerId)
    const baseId = parseThinkingSuffixFromModelId(ref.modelId).baseId
    const model = models.find((entry) => entry.id === ref.modelId) ?? models.find((entry) => entry.id === baseId)
    if (!model) return null
    const options = models.map((entry) => ({ id: entry.id, label: entry.name, efforts: getModelEffortLevels(entry) }))
    const family = findModelFamily(ref.providerId, options, model.id)
    const capabilities: AgentCapabilityKind[] = []
    if (model.reasoning) capabilities.push('reasoning')
    if (model.input.includes('image')) capabilities.push('vision')
    // These are the existing pi-ai structured tool transports. Browser/native and
    // JSON-schema output support require separate adapter qualification.
    if (new Set(['anthropic-messages', 'openai-completions', 'openai-responses', 'openai-codex-responses', 'google-generative-ai', 'google-vertex', 'google-gemini-cli', 'bedrock-converse-stream']).has(model.api)) capabilities.push('tools')
    if (model.contextWindow >= 128_000) capabilities.push('long_context')
    return {
      ref: { ...ref }, label: model.name, available: true,
      efforts: getModelEffortLevels(model) ?? family?.efforts ?? [],
      speeds: family?.speeds ?? [], contexts: family?.contexts ?? [],
      capabilities, unavailableReasons: []
    }
  }
}
