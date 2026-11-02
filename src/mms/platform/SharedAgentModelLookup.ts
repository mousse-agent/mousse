import type { AgentCapabilityKind, AgentModelCapabilityProfile, AgentModelLookup, AgentModelRef } from '../../shared/agents/types'
import { findModelFamily } from '../../shared/modelVariants'
import { findListedModel } from '../../shared/modelChoice'
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
        { instanceId: ref.instanceId, llmProvider: ref.providerId, model: ref.modelId, ...(ref.effort ? { effort: ref.effort } : {}) },
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
    // An entry that moved runs the agent's own model for the ref: the ref the run sends names that
    // model on the instance it moved to, so the run never sends the old id there.
    const { effort: _effort, ...rest } = ref
    const resolvedRef: AgentModelRef = resolved.movedFrom
      ? { ...rest, instanceId: resolved.instanceId, providerId: resolved.llmProvider, modelId: resolved.model, ...(resolved.effort ? { effort: resolved.effort } : {}) }
      : { ...ref, instanceId: resolved.instanceId, providerId: resolved.llmProvider }
    const listed = harness.catalog.models(resolved.instanceId, { kind: 'device' })
    // An instance that lists nothing is signed out (or not set up yet): say so, not "not in the catalog".
    if (!listed.length) {
      return {
        ref: resolvedRef, available: false, efforts: [], speeds: [], contexts: [], capabilities: [],
        unavailableReasons: [`${resolved.instanceId} is signed out or lists no models. Sign in again in Settings → Providers.`],
        unavailableCode: 'signed_out'
      }
    }
    const models = listed.filter((entry) => !entry.hidden)
    const model = findListedModel(models, resolved.model || ref.modelId)
    if (!model) return null
    const options = models.map((entry) => ({ id: entry.id, label: entry.label, efforts: entry.capabilities.efforts }))
    const family = findModelFamily(resolved.llmProvider, options, model.id)
    const capabilities: AgentCapabilityKind[] = []
    if (model.capabilities.efforts.length > 0) capabilities.push('reasoning')
    if (model.capabilities.images) capabilities.push('vision')
    // Mousse's tools reach the model over MCP.
    if (resolved.caps.mcp) capabilities.push('tools')
    if ((model.capabilities.contextWindow ?? 0) >= LONG_CONTEXT_TOKENS) capabilities.push('long_context')
    return {
      ref: resolvedRef, label: model.label, available: true,
      efforts: model.capabilities.efforts.length ? [...model.capabilities.efforts] : family?.efforts ?? [],
      speeds: family?.speeds ?? [], contexts: family?.contexts ?? [],
      capabilities, unavailableReasons: []
    }
  }
}
