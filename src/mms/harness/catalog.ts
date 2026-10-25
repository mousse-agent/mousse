import type { CustomModel, InstanceModel, ModelCapabilities, ModelPrefs, ModelPrefsPatch } from '../../shared/harness/types'
import { parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { LlmModelOption, LlmProviderOption } from '../../shared/settings'

/**
 * Model preferences per instance (hidden, order, favorites, custom models), kept in the daemon's
 * profile config (`providers.modelPrefs`). Hidden models leave every picker and are rejected by
 * `resolve()` for every purpose.
 */

export const EMPTY_PREFS: ModelPrefs = Object.freeze({ hidden: [], order: [], favorites: [], custom: [] }) as ModelPrefs

/** Where prefs are persisted (the profile config's providers section). */
export interface ModelPrefsStore {
  read(): Record<string, unknown> | undefined
  write(prefs: Record<string, ModelPrefs>): void
}

const MAX_IDS = 512
const MAX_ID = 512

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID))].slice(0, MAX_IDS)
}

function capabilities(value: unknown): ModelCapabilities {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    efforts: ids(raw.efforts),
    images: raw.images === true,
    ...(typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0 ? { contextWindow: Math.floor(raw.contextWindow) } : {})
  }
}

function customModels(value: unknown): CustomModel[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const models: CustomModel[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > MAX_ID || seen.has(raw.id.trim())) continue
    const id = raw.id.trim()
    seen.add(id)
    models.push({ id, ...(typeof raw.label === 'string' && raw.label.trim() ? { label: raw.label.trim() } : {}), capabilities: capabilities(raw.capabilities) })
  }
  return models.slice(0, MAX_IDS)
}

/** Lenient decoder of one instance's stored prefs. */
export function decodeModelPrefs(raw: unknown): ModelPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_PREFS }
  const value = raw as Record<string, unknown>
  return { hidden: ids(value.hidden), order: ids(value.order), favorites: ids(value.favorites), custom: customModels(value.custom) }
}

export function applyPrefsPatch(prefs: ModelPrefs, patch: ModelPrefsPatch): ModelPrefs {
  return {
    hidden: patch.hidden !== undefined ? ids(patch.hidden) : prefs.hidden,
    order: patch.order !== undefined ? ids(patch.order) : prefs.order,
    favorites: patch.favorites !== undefined ? ids(patch.favorites) : prefs.favorites,
    custom: patch.custom !== undefined ? customModels(patch.custom) : prefs.custom
  }
}

export class ModelPrefsService {
  constructor(private readonly store: ModelPrefsStore) {}

  all(): Record<string, ModelPrefs> {
    const raw = this.store.read() ?? {}
    return Object.fromEntries(Object.entries(raw).map(([instanceId, value]) => [instanceId, decodeModelPrefs(value)]))
  }

  get(instanceId: string): ModelPrefs {
    return decodeModelPrefs((this.store.read() ?? {})[instanceId])
  }

  set(instanceId: string, patch: ModelPrefsPatch): ModelPrefs {
    const next = applyPrefsPatch(this.get(instanceId), patch)
    const all = this.all()
    if (next.hidden.length || next.order.length || next.favorites.length || next.custom.length) all[instanceId] = next
    else delete all[instanceId]
    this.store.write(all)
    return next
  }

  remove(instanceId: string): void {
    const all = this.all()
    if (!(instanceId in all)) return
    delete all[instanceId]
    this.store.write(all)
  }
}

/**
 * Whether prefs hide the model a selection names. A selection carries its effort in the id
 * (`opus:high` is `opus` at high effort), so the canonical model behind it counts, not the string.
 */
export function hidesModel(prefs: ModelPrefs, model: string): boolean {
  if (prefs.hidden.includes(model)) return true
  const { baseId } = parseThinkingSuffixFromModelId(model)
  return baseId !== model && prefs.hidden.includes(baseId)
}

/** Capabilities of a listed model: its efforts; images and window are unknown for listed models. */
function listedCapabilities(model: LlmModelOption): ModelCapabilities {
  return { efforts: model.efforts ?? [], images: false }
}

/**
 * The instance's models with prefs applied: listed models then custom ones (a custom id that the
 * runtime also lists keeps the listed entry), in the stored order, hidden ones flagged.
 */
export function modelsWithPrefs(listed: readonly LlmModelOption[], prefs: ModelPrefs): InstanceModel[] {
  const hidden = new Set(prefs.hidden)
  const favorites = new Set(prefs.favorites)
  const entries: InstanceModel[] = []
  const seen = new Set<string>()
  for (const model of listed) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    entries.push({ id: model.id, label: model.label || model.id, source: 'catalog', capabilities: listedCapabilities(model), hidden: hidden.has(model.id), favorite: favorites.has(model.id) })
  }
  for (const model of prefs.custom) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    entries.push({ id: model.id, label: model.label ?? model.id, source: 'custom', capabilities: model.capabilities, hidden: hidden.has(model.id), favorite: favorites.has(model.id) })
  }
  if (!prefs.order.length) return entries
  const rank = new Map(prefs.order.map((id, index) => [id, index]))
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (rank.get(a.entry.id) ?? prefs.order.length + a.index) - (rank.get(b.entry.id) ?? prefs.order.length + b.index))
    .map(({ entry }) => entry)
}

/** A picker listing without hidden models, custom models added, in display order. */
export function visibleProviderOption(option: LlmProviderOption, prefs: ModelPrefs): LlmProviderOption {
  const byId = new Map(option.models.map((model) => [model.id, model]))
  const models = modelsWithPrefs(option.models, prefs)
    .filter((model) => !model.hidden)
    .map((model) => byId.get(model.id) ?? { id: model.id, label: model.label, ...(model.capabilities.efforts.length ? { efforts: model.capabilities.efforts } : {}) })
  return { ...option, models }
}
