import type { NewSessionResponse } from '@agentclientprotocol/sdk'
import type { LlmModelOption } from '../../../shared/settings'

/** The model id that runs the agent's own default: Mousse sets no model. */
export const AGENT_DEFAULT_MODEL = 'default'

/** The models of a `model` select config option, groups flattened. */
export function modelOptions(session: Pick<NewSessionResponse, 'configOptions'>): LlmModelOption[] {
  const selector = session.configOptions?.find((option) => option.id === 'model' && option.type === 'select')
  if (!selector || selector.type !== 'select') return []
  return selector.options.flatMap((item) => 'options' in item
    ? item.options.map((option) => ({ id: option.value, label: option.name }))
    : [{ id: item.value, label: item.name }])
}

/** How a session's model is chosen. */
export type ModelControl =
  | { kind: 'config'; configId: string }
  | { kind: 'set_model' }
  | { kind: 'none' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function selectValues(option: Record<string, unknown>): LlmModelOption[] {
  const items = Array.isArray(option.options) ? option.options : []
  return items.flatMap((item): LlmModelOption[] => {
    if (!isRecord(item)) return []
    if (Array.isArray(item.options)) return selectValues(item)
    return typeof item.value === 'string' ? [{ id: item.value, label: typeof item.name === 'string' && item.name ? item.name : item.value }] : []
  })
}

/**
 * The models a session (or `initialize`) offers, in order of preference: a select config option of
 * category `model` (or id `model`), else the unstable `models.availableModels`, else the
 * `_meta.modelState` some agents send with `initialize`. Decoded leniently; nothing found is
 * `{ models: [], control: none }` and the agent runs its own default.
 */
export function agentModels(session: unknown, initializeMeta?: unknown): { models: LlmModelOption[]; control: ModelControl } {
  const value = isRecord(session) ? session : {}
  const options = Array.isArray(value.configOptions) ? value.configOptions.filter(isRecord) : []
  const selector = options.find((option) => option.type === 'select' && option.category === 'model')
    ?? options.find((option) => option.type === 'select' && option.id === 'model')
  if (selector && typeof selector.id === 'string') {
    const models = selectValues(selector)
    if (models.length) return { models, control: { kind: 'config', configId: selector.id } }
  }
  const state = isRecord(value.models) ? value.models : isRecord(initializeMeta) && isRecord(initializeMeta.modelState) ? initializeMeta.modelState : undefined
  const available = state && Array.isArray(state.availableModels) ? state.availableModels.filter(isRecord) : []
  const models = available.flatMap((model): LlmModelOption[] => {
    const id = typeof model.modelId === 'string' ? model.modelId : typeof model.id === 'string' ? model.id : undefined
    return id ? [{ id, label: typeof model.name === 'string' && model.name ? model.name : id }] : []
  })
  return models.length ? { models, control: { kind: 'set_model' } } : { models: [], control: { kind: 'none' } }
}

/** The modes a session offers and the one it starts in. */
export function agentModes(session: unknown): { current?: string; modes: Array<{ id: string; name: string }> } {
  const state = isRecord(session) && isRecord(session.modes) ? session.modes : undefined
  const modes = (state && Array.isArray(state.availableModes) ? state.availableModes.filter(isRecord) : []).flatMap((mode) =>
    typeof mode.id === 'string' ? [{ id: mode.id, name: typeof mode.name === 'string' ? mode.name : mode.id }] : [])
  return { ...(state && typeof state.currentModeId === 'string' ? { current: state.currentModeId } : {}), modes }
}

/** A mode that plans without acting: named `plan` or `architect`. */
export function planModeId(modes: ReadonlyArray<{ id: string; name: string }>): string | undefined {
  return modes.find((mode) => /^(plan|architect)$/i.test(mode.id) || /^(plan|architect)$/i.test(mode.name))?.id
}
