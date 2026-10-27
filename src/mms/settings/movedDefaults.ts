import { piInstanceId } from '../../shared/providerInstances'
import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'

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
export function rewriteMovedDefaults(
  settings: Pick<MousseSettings, 'provider' | 'title'>,
  from: string,
  to: { instanceId: string; llmProvider: string; model(model: string): string }
): { patch?: MousseSettingsUpdate; rewritten: string[] } {
  const patch: MousseSettingsUpdate = {}
  const rewritten: string[] = []
  const provider = settings.provider
  if (names(provider, from)) {
    const model = to.model(provider.model)
    patch.provider = { ...provider, instanceId: to.instanceId, llmProvider: to.llmProvider, model }
    rewritten.push(model === provider.model ? 'Default model' : `Default model: ${model} instead of ${provider.model}`)
  }
  if (names(settings.title, from)) {
    patch.title = { llmProvider: '', model: '', instanceId: '' }
    rewritten.push('Chat titles: Automatic')
  }
  return rewritten.length ? { patch, rewritten } : { rewritten }
}
