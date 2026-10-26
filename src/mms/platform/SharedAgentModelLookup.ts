import type { AgentCapabilityKind, AgentModelCapabilityProfile, AgentModelLookup, AgentModelRef } from '../../shared/agents/types'
import { getModelEffortLevels } from '../../shared/modelEfforts'
import { findModelFamily, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { HarnessGateway } from '../harness/gateway'
import type { ProviderAuthService } from '../providers/ProviderAuthService'

/**
 * Catalog presence is not an authentication check; the executor acquires credentials at dispatch.
 * With the harness gateway, a ref resolves like any other selection first: the instance it names
 * (a ref without one maps its `providerId` to the built-in instance), with a disabled instance or a
 * hidden model reported unavailable with the gateway's error code.
 */
export class SharedAgentModelLookup implements AgentModelLookup {
  constructor(
    private readonly providers: ProviderAuthService,
    /** Read at each lookup: the profile's gateway is created after its platform. */
    private readonly harness?: () => Pick<HarnessGateway, 'resolveStored'> | undefined
  ) {}

  resolve(ref: AgentModelRef): AgentModelCapabilityProfile | null {
    let providerId = ref.providerId
    const harness = this.harness?.()
    if (harness) {
      try {
        const resolved = harness.resolveStored(
          { instanceId: ref.instanceId, llmProvider: ref.providerId, model: ref.modelId },
          { purpose: 'definition' }
        )
        ref = { ...ref, instanceId: resolved.instanceId, providerId: resolved.llmProvider }
        providerId = resolved.llmProvider
      } catch (error) {
        const code = (error as { code?: unknown }).code
        return {
          ref: { ...ref }, available: false, efforts: [], speeds: [], contexts: [], capabilities: [],
          unavailableReasons: [error instanceof Error ? error.message : String(error)],
          ...(typeof code === 'string' ? { unavailableCode: code } : {})
        }
      }
    }
    const models = this.providers.models.getModels(providerId)
    const baseId = parseThinkingSuffixFromModelId(ref.modelId).baseId
    const model = models.find((entry) => entry.id === ref.modelId) ?? models.find((entry) => entry.id === baseId)
    if (!model) return null
    const options = models.map((entry) => ({ id: entry.id, label: entry.name, efforts: getModelEffortLevels(entry) }))
    const family = findModelFamily(providerId, options, model.id)
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
