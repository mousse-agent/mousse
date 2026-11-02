import { piInstanceId } from '../../shared/providerInstances'
import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import { modelChoiceOf, modelLabel } from '../../shared/modelChoice'
import type { ModelPick } from '../../shared/modelSelection'

/** A selection names `instanceId`: by its instance, else (older records) by its pi provider name. */
function names(selection: { llmProvider?: string; instanceId?: string } | undefined, instanceId: string): boolean {
  if (!selection) return false
  return selection.instanceId?.trim() ? selection.instanceId === instanceId : Boolean(selection.llmProvider) && piInstanceId(selection.llmProvider!) === instanceId
}

/**
 * The device defaults a move rewrites (`instances.move`), with a line for each:
 * - the default model follows the entry to the agent, with the agent's model for it;
 * - a title model on the moved entry becomes Automatic, since an agent runtime names no chats.
 */
/** A model as the list of what moved names it, from its id: no listing is on hand here. */
const named = (model: string): string => modelLabel(modelChoiceOf({ provider: '', model }), { effort: false })

export function rewriteMovedDefaults(
  settings: Pick<MousseSettings, 'provider' | 'title'>,
  from: string,
  to: { instanceId: string; llmProvider: string; model(pick: ModelPick): ModelPick }
): { patch?: MousseSettingsUpdate; rewritten: string[] } {
  const patch: MousseSettingsUpdate = {}
  const rewritten: string[] = []
  const provider = settings.provider
  if (names(provider, from)) {
    const { model, effort } = to.model(provider)
    // The name was the old model's; the new one is named again when it is chosen or resolved.
    const { name: _name, effort: _effort, ...rest } = provider
    patch.provider = { ...rest, instanceId: to.instanceId, llmProvider: to.llmProvider, model, ...(effort ? { effort } : {}) }
    rewritten.push(model === provider.model ? 'Default model' : `Default model: ${named(model)} instead of ${named(provider.model)}`)
  }
  if (names(settings.title, from)) {
    patch.title = { llmProvider: '', model: '', instanceId: '' }
    rewritten.push('Chat titles: Automatic')
  }
  return rewritten.length ? { patch, rewritten } : { rewritten }
}
