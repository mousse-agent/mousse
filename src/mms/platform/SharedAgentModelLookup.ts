import type { AgentCapabilityKind, AgentModelCapabilityProfile, AgentModelLookup, AgentModelRef } from '../../shared/agents/types'
import { findModelFamily, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { HarnessGateway } from '../harness/gateway'

/** Context window from which a model counts as `long_context`. */
const LONG_CONTEXT_TOKENS = 128_000

/**
 * A definition's model ref, read through the harness gateway (PR 4 §6). The ref resolves like any
 * other selection first: the instance it names (a ref without one maps its `providerId` to the
 * built-in instance), with a disabled instance or a hidden model reported unavailable with the
 * gateway's error code. The model's facts come from the gateway's catalogue for that instance:
 * - its label, efforts and context window;
 * - `reasoning` when it has efforts, `vision` when it takes images, `long_context` from 128k tokens;
 * - `tools` when Mousse's tools reach the model there (`caps.mcp`, or the legacy loop).
 *
 * Catalogue presence is not an authentication check; the run acquires credentials when it starts.
 */
export class SharedAgentModelLookup implements AgentModelLookup {
  constructor(
    /** Read at each lookup: the profile's gateway is created after its platform. */
    private readonly harness: () => Pick<HarnessGateway, 'resolveStored' | 'catalog'> | undefined
  ) {}

  resolve(ref: AgentModelRef): AgentModelCapabilityProfile | null {
    const harness = this.harness()
    if (!harness) return null
    let resolved: ReturnType<HarnessGateway['resolveStored']>
    try {
      resolved = harness.resolveStored(
        { instanceId: ref.instanceId, llmProvider: ref.providerId, model: ref.modelId },
        { purpose: 'definition' }
      )
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return {
        ref: { ...ref }, available: false, efforts: [], speeds: [], contexts: [], capabilities: [],
        unavailableReasons: [error instanceof Error ? error.message : String(error)],
        ...(typeof code === 'string' ? { unavailableCode: code } : {})
      }
    }
    const resolvedRef: AgentModelRef = { ...ref, instanceId: resolved.instanceId, providerId: resolved.llmProvider }
    const models = harness.catalog.models(resolved.instanceId, { kind: 'device' }).filter((entry) => !entry.hidden)
    // The model the instance runs for the ref (an entry that moved names the agent's own model).
    const wanted = resolved.model || ref.modelId
    const baseId = parseThinkingSuffixFromModelId(wanted).baseId
    const model = models.find((entry) => entry.id === wanted) ?? models.find((entry) => entry.id === baseId)
    if (!model) return null
    const options = models.map((entry) => ({ id: entry.id, label: entry.label, efforts: entry.capabilities.efforts }))
    const family = findModelFamily(resolved.llmProvider, options, model.id)
    const capabilities: AgentCapabilityKind[] = []
    if (model.capabilities.efforts.length > 0) capabilities.push('reasoning')
    if (model.capabilities.images) capabilities.push('vision')
    // Mousse's tools reach the model over MCP, or inside the legacy loop that runs definitions
    // until 4d-rpc (`definitionLimits: 'in_loop'`, deleted with the loop in 4h).
    if (resolved.caps.mcp || resolved.caps.definitionLimits === 'in_loop') capabilities.push('tools')
    if ((model.capabilities.contextWindow ?? 0) >= LONG_CONTEXT_TOKENS) capabilities.push('long_context')
    return {
      ref: resolvedRef, label: model.label, available: true,
      efforts: model.capabilities.efforts.length ? [...model.capabilities.efforts] : family?.efforts ?? [],
      speeds: family?.speeds ?? [], contexts: family?.contexts ?? [],
      ...(model.capabilities.contextWindow !== undefined ? { contextWindow: model.capabilities.contextWindow } : {}),
      capabilities, unavailableReasons: []
    }
  }
}
