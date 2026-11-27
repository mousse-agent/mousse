import type { NewSessionResponse } from '@agentclientprotocol/sdk'
import { REASONING_LEVELS } from '../../../shared/modelVariants'
import type { LlmModelOption } from '../../../shared/settings'

/** The model id that runs the agent's own default: Mousse sets no model. */
export const AGENT_DEFAULT_MODEL = 'default'

const REASONING_ORDER = new Map<string, number>(REASONING_LEVELS.map((level, index) => [level, index]))

function sortEfforts(values: Iterable<string>): string[] {
  return [...new Set(values)]
    .filter((value) => REASONING_ORDER.has(value))
    .sort((a, b) => (REASONING_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) - (REASONING_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

interface RawSelectEntry {
  value: string
  name: string
  description?: string
}

function rawSelectEntries(option: Record<string, unknown>): RawSelectEntry[] {
  const items = Array.isArray(option.options) ? option.options : []
  return items.flatMap((item): RawSelectEntry[] => {
    if (!isRecord(item)) return []
    if (Array.isArray(item.options)) return rawSelectEntries(item)
    if (typeof item.value !== 'string') return []
    const description = typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined
    return [{
      value: item.value,
      name: typeof item.name === 'string' && item.name ? item.name : item.value,
      ...(description ? { description } : {})
    }]
  })
}

function selectValues(option: Record<string, unknown>): LlmModelOption[] {
  return rawSelectEntries(option).map((entry) => ({ id: entry.value, label: entry.name }))
}

function findModelSelect(configOptions: unknown): Record<string, unknown> | undefined {
  const options = Array.isArray(configOptions) ? configOptions.filter(isRecord) : []
  return options.find((option) => option.type === 'select' && option.category === 'model')
    ?? options.find((option) => option.type === 'select' && option.id === 'model')
}

/** A session's reasoning-level select (`category: 'thought_level'` or `id: 'thought_level'`). */
export interface ThoughtConfig {
  configId: string
  /** Currently active level reported by the agent. */
  currentValue?: string
  /** Supported reasoning levels, lowest first (excludes `off`). */
  efforts: string[]
  /** `false` when thinking cannot be turned off. */
  thinkingOff?: false
  /** Agent-provided descriptions per level, when present. */
  descriptions?: Record<string, string>
  /** Every raw value accepted by `session/set_config_option` for `configId`. */
  values: string[]
}

/** Reads the `thought_level` select config option from a session or `config_option_update`. */
export function thoughtConfigOption(session: unknown): ThoughtConfig | undefined {
  const value = isRecord(session) ? session : {}
  const options = Array.isArray(value.configOptions) ? value.configOptions.filter(isRecord) : []
  const selector = options.find((option) => option.type === 'select' && option.category === 'thought_level')
    ?? options.find((option) => option.type === 'select' && option.id === 'thought_level')
  if (!selector || typeof selector.id !== 'string') return undefined
  const entries = rawSelectEntries(selector)
  const values = [...new Set(entries.map((entry) => entry.value))]
  if (!values.length) return undefined
  const efforts = sortEfforts(values)
  const descriptions = Object.fromEntries(
    entries
      .filter((entry) => entry.description && REASONING_ORDER.has(entry.value))
      .map((entry) => [entry.value, entry.description!])
  )
  const currentValue = typeof selector.currentValue === 'string' && values.includes(selector.currentValue)
    ? selector.currentValue
    : undefined
  return {
    configId: selector.id,
    ...(currentValue ? { currentValue } : {}),
    efforts,
    ...(efforts.length && !values.includes('off') ? { thinkingOff: false as const } : {}),
    ...(Object.keys(descriptions).length ? { descriptions } : {}),
    values
  }
}

/**
 * Per-model reasoning levels derived from `models.availableModels` when an ACP agent (such as native
 * `agy`) lists base models in `configOptions[model]` and every `<baseId>-<level>` combination in
 * `models.availableModels`.
 */
function availableModelEfforts(
  session: unknown,
  baseIds: ReadonlySet<string>,
  initializeMeta?: unknown
): Map<string, { efforts: string[]; thinkingOff?: false }> {
  const value = isRecord(session) ? session : {}
  const state = isRecord(value.models)
    ? value.models
    : isRecord(initializeMeta) && isRecord(initializeMeta.modelState)
      ? initializeMeta.modelState
      : undefined
  const available = state && Array.isArray(state.availableModels) ? state.availableModels.filter(isRecord) : []
  if (!available.length) return new Map()
  // Longest base id first so a shared prefix never shadows a more specific model id.
  const orderedBases = [...baseIds].sort((a, b) => b.length - a.length)
  const levelsByBase = new Map<string, { levels: Set<string>; hasOff: boolean }>()
  for (const entry of available) {
    const id = typeof entry.modelId === 'string' ? entry.modelId : typeof entry.id === 'string' ? entry.id : undefined
    if (!id || baseIds.has(id)) continue
    for (const baseId of orderedBases) {
      if (!id.startsWith(`${baseId}-`) && !id.startsWith(`${baseId}:`)) continue
      const suffix = id.slice(baseId.length + 1)
      if (suffix === 'off' || REASONING_ORDER.has(suffix)) {
        const bucket = levelsByBase.get(baseId) ?? { levels: new Set<string>(), hasOff: false }
        if (suffix === 'off') bucket.hasOff = true
        else bucket.levels.add(suffix)
        levelsByBase.set(baseId, bucket)
        break
      }
    }
  }
  const result = new Map<string, { efforts: string[]; thinkingOff?: false }>()
  for (const [baseId, bucket] of levelsByBase) {
    const efforts = sortEfforts(bucket.levels)
    if (efforts.length) result.set(baseId, { efforts, ...(bucket.hasOff ? {} : { thinkingOff: false as const }) })
  }
  return result
}

/** Clamps a session's active `thought_level` to what `efforts` offers, matching how `agy` clamps on switch. */
function defaultEffortFor(sessionDefault: string | undefined, efforts: readonly string[]): string | undefined {
  if (!sessionDefault || !efforts.length) return undefined
  if (efforts.includes(sessionDefault)) return sessionDefault
  const target = REASONING_ORDER.get(sessionDefault)
  if (target === undefined) return undefined
  let best: string | undefined
  for (const effort of efforts) {
    const rank = REASONING_ORDER.get(effort)
    if (rank !== undefined && rank < target) best = effort
  }
  return best ?? efforts[0]
}

function withThoughtConfig(
  model: LlmModelOption,
  thought: ThoughtConfig | undefined,
  preserveDefault?: string
): LlmModelOption {
  const { efforts: _e, defaultEffort: _d, effortDescriptions: _desc, thinkingOff: _off, ...base } = model
  if (!thought?.efforts.length) return base
  const defaultEffort = preserveDefault && thought.efforts.includes(preserveDefault)
    ? preserveDefault
    : defaultEffortFor(thought.currentValue, thought.efforts)
  return {
    ...base,
    efforts: thought.efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(thought.descriptions ? { effortDescriptions: thought.descriptions } : {}),
    ...(thought.thinkingOff === false ? { thinkingOff: false as const } : {})
  }
}

function applyThoughtMetadata(
  models: LlmModelOption[],
  session: unknown,
  currentModelId: string | undefined,
  initializeMeta?: unknown
): LlmModelOption[] {
  if (!models.length) return models
  const thought = thoughtConfigOption(session)
  const baseIds = new Set(models.map((model) => model.id))
  const fromAvailable = availableModelEfforts(session, baseIds, initializeMeta)
  if (!thought && !fromAvailable.size) return models
  const sessionDefault = thought?.currentValue && REASONING_ORDER.has(thought.currentValue)
    ? thought.currentValue
    : undefined
  return models.map((model) => {
    if (currentModelId !== undefined && model.id === currentModelId && thought?.efforts.length) {
      return withThoughtConfig(model, thought)
    }
    const available = fromAvailable.get(model.id)
    if (!available) return model
    const defaultEffort = defaultEffortFor(sessionDefault, available.efforts)
    return {
      ...model,
      efforts: available.efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(available.thinkingOff === false ? { thinkingOff: false as const } : {})
    }
  })
}

/**
 * Merges a `config_option_update`'s model list with previously known model metadata. Because an
 * update only carries `thought_level` for the currently active model (and omits `availableModels`),
 * other models keep their previously discovered reasoning levels, and the active model keeps its
 * default level instead of turning the newly selected level into its default.
 */
export function mergeModelOptions(
  existing: readonly LlmModelOption[],
  updated: readonly LlmModelOption[],
  configOptions: unknown
): LlmModelOption[] {
  if (!updated.length) return []
  const modelSelect = findModelSelect(configOptions)
  const currentModelId = typeof modelSelect?.currentValue === 'string' ? modelSelect.currentValue : undefined
  const thought = thoughtConfigOption({ configOptions })
  const byId = new Map(existing.map((model) => [model.id, model]))
  return updated.map((model) => {
    const prev = byId.get(model.id)
    if (currentModelId !== undefined && model.id === currentModelId) {
      return withThoughtConfig(model, thought, prev?.defaultEffort)
    }
    if (model.efforts?.length || !prev?.efforts?.length) return model
    return {
      ...model,
      efforts: prev.efforts,
      ...(prev.defaultEffort ? { defaultEffort: prev.defaultEffort } : {}),
      ...(prev.effortDescriptions ? { effortDescriptions: prev.effortDescriptions } : {}),
      ...(prev.thinkingOff === false ? { thinkingOff: false as const } : {})
    }
  })
}

/** Whether `session` carries `models.availableModels` (used to skip per-model probing). */
export function hasAvailableModelList(session: unknown): boolean {
  const models = isRecord(session) && isRecord(session.models) ? session.models : undefined
  return Boolean(models && Array.isArray(models.availableModels) && models.availableModels.length > 0)
}

/** The models of a `model` select config option, groups flattened, with reasoning levels when advertised. */
export function modelOptions(session: Pick<NewSessionResponse, 'configOptions'> & Record<string, unknown>): LlmModelOption[] {
  const selector = session.configOptions?.find((option) => option.id === 'model' && option.type === 'select')
  if (!selector || selector.type !== 'select') return []
  const models: LlmModelOption[] = selector.options.flatMap((item) => 'options' in item
    ? item.options.map((option) => ({ id: option.value, label: option.name }))
    : [{ id: item.value, label: item.name }])
  const currentModelId = typeof selector.currentValue === 'string' ? selector.currentValue : undefined
  return applyThoughtMetadata(models, session, currentModelId)
}

/** How a session's model is chosen. */
export type ModelControl =
  | { kind: 'config'; configId: string }
  | { kind: 'set_model' }
  | { kind: 'none' }

/**
 * The models a session (or `initialize`) offers, in order of preference: a select config option of
 * category `model` (or id `model`), else the unstable `models.availableModels`, else the
 * `_meta.modelState` some agents send with `initialize`. Decoded leniently; nothing found is
 * `{ models: [], control: none }` and the agent runs its own default.
 */
export function agentModels(session: unknown, initializeMeta?: unknown): { models: LlmModelOption[]; control: ModelControl } {
  const value = isRecord(session) ? session : {}
  const selector = findModelSelect(value.configOptions)
  if (selector && typeof selector.id === 'string') {
    const currentModelId = typeof selector.currentValue === 'string' ? selector.currentValue : undefined
    const models = applyThoughtMetadata(selectValues(selector), session, currentModelId, initializeMeta)
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

