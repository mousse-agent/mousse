import { useMemo } from 'react'
import { findListedModel, modelChoiceOf, type ModelChoice } from '../../shared/modelChoice'
import { parseIdSuffixes } from '../../shared/modelVariants'
import { listingServes } from '../../shared/providerInstances'
import type { LlmProviderOption } from '../../shared/settings'
import { llmProviderOf, pickerIdOf, useProviderSnapshotsStore } from './providerSnapshots'

/** A selection as screens hold it: the instance when known, the provider name, the model, its level and stored name. */
export interface ModelSelectionLike {
  instanceId?: string
  provider: string
  model: string
  effort?: string
  name?: string
}

/**
 * The name an instance gives a model, best source first: the listing a screen shows (`providers`),
 * then the snapshots of any scope on hand (hidden models included), then the names listings gave
 * it before (an empty Codex list, a removed model). Undefined when nothing on hand names it.
 */
function listedLabel(selection: ModelSelectionLike, providers: readonly LlmProviderOption[] | undefined): string | undefined {
  const target = { instanceId: selection.instanceId, llmProvider: selection.provider }
  const listing = providers?.find((entry) => listingServes(entry, target))
  const fromListing = listing && findListedModel(listing.models, selection.model)?.label
  if (fromListing) return fromListing
  const snapshots = Object.values(useProviderSnapshotsStore.getState().scopes).flatMap((scope) => scope.snapshots ?? [])
  // A selection that names neither (a reply's model, a binding without a provider name) takes any instance's name.
  const serving = snapshots.filter((snapshot) =>
    selection.instanceId
      ? snapshot.instanceId === selection.instanceId
      : !selection.provider || pickerIdOf(snapshot) === selection.provider || llmProviderOf(snapshot) === selection.provider
  )
  for (const snapshot of serving) {
    const label = findListedModel(snapshot.models.entries, selection.model)?.label
    if (label) return label
  }
  const { baseId } = parseIdSuffixes(selection.model)
  for (const snapshot of serving) {
    const remembered = snapshot.models.names?.[selection.model] ?? snapshot.models.names?.[baseId]
    if (remembered) return remembered
  }
  return undefined
}

/**
 * The model a stored selection names, with its name. Every screen that shows a model goes through
 * here and `modelLabel`; when nothing on hand names the model, the name is made from its id.
 */
export function resolveModelChoice(selection: ModelSelectionLike, providers?: readonly LlmProviderOption[]): ModelChoice {
  return modelChoiceOf(selection, listedLabel(selection, providers))
}

/** `resolveModelChoice` that names the model again when snapshots arrive. */
export function useModelChoice(selection: ModelSelectionLike, providers?: readonly LlmProviderOption[]): ModelChoice {
  const scopes = useProviderSnapshotsStore((state) => state.scopes)
  const { instanceId, provider, model, effort, name } = selection
  return useMemo(
    () => resolveModelChoice({ instanceId, provider, model, effort, name }, providers),
    // `scopes` is read through the store inside; it is a dependency so new snapshots rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instanceId, provider, model, effort, name, providers, scopes]
  )
}
