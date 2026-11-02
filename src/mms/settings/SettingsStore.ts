import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import { getDefaultSettings, normalizeAgentAccessSettings, normalizeAppearance, normalizeContextSettings, normalizePermissionSettings, normalizeRunSettings } from '../../shared/settings'
import { MOUSSE_BUILTIN_TOOL_IDS } from '../../shared/integrations'
import { generateRandomUsername } from '../../shared/randomUsername'
import { normalizeShortcuts } from '../../shared/commands'
import type { MousseConfigStore } from '../config/MousseConfigStore'
import { upgradeSelection } from '../../shared/modelSelection'

function deepMerge<T extends Record<string, unknown>>(base: T, partial: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(partial) as Array<keyof T>) {
    const value = partial[key]
    if (value === undefined) continue
    const existing = base[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      ) as T[keyof T]
    } else {
      result[key] = value as T[keyof T]
    }
  }
  return result
}

/**
 * A stored selection with its instance id, reasoning level and name kept only when set (a blank one
 * is how a deeply merged section clears it), and a level packed into the model (written before
 * #490) moved into its own field.
 */
function withInstance<T extends { instanceId?: unknown; model?: unknown; effort?: unknown; name?: unknown }>(selection: T): T {
  if (!selection || typeof selection !== 'object') return selection
  const { instanceId, effort, name, ...rest } = selection
  const kept = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const id = kept(instanceId)
  const stored = { ...rest, ...(id ? { instanceId: id } : {}), ...(kept(effort) ? { effort: kept(effort) } : {}), ...(kept(name) ? { name: kept(name) } : {}) }
  return (typeof rest.model === 'string' ? upgradeSelection(stored as typeof stored & { model: string }) : stored) as T
}

/** An update that names a model: its reasoning level and name are the update's, or none. */
function namesModel(selection: { model?: unknown } | undefined): boolean {
  return selection?.model !== undefined
}

/** An update that picks a model by provider name alone (no instance, or one cleared to blank). */
function namesProviderOnly(selection: { llmProvider?: unknown; instanceId?: unknown } | undefined): boolean {
  return Boolean(selection) && selection!.llmProvider !== undefined && (selection!.instanceId === undefined || selection!.instanceId === '')
}

function normalizeSettings(settings: MousseSettings): MousseSettings {
  const defaults = getDefaultSettings()
  const integrations = settings.integrations as MousseSettings['integrations'] & {
    tools?: { enabled?: unknown; enabledTools?: unknown; knownTools?: unknown }
  }
  const rawTools = integrations?.tools
  const validIds = new Set(MOUSSE_BUILTIN_TOOL_IDS)
  const filterToolIds = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && validIds.has(id))
      : undefined
  const storedTools = filterToolIds(rawTools?.enabledTools) ?? [...MOUSSE_BUILTIN_TOOL_IDS]
  const knownTools = filterToolIds(rawTools?.knownTools)
  // A stored enabledTools list predates this catalog marker. Treat the current
  // catalog as its default once, then use knownTools to distinguish future new
  // built-ins from tools the user explicitly switched off.
  const newlyAvailable = knownTools
    ? MOUSSE_BUILTIN_TOOL_IDS.filter((id) => !knownTools.includes(id))
    : [...MOUSSE_BUILTIN_TOOL_IDS]
  const enabledSet = new Set([...storedTools, ...newlyAvailable])
  const enabledTools = MOUSSE_BUILTIN_TOOL_IDS.filter((id) => enabledSet.has(id))
  const skills = settings.integrations?.skills
  return {
    ...settings,
    appearance: normalizeAppearance(settings.appearance),
    context: normalizeContextSettings(settings.context),
    // The daemon and the desktop run on one machine, so its platform resolves the defaults.
    shortcuts: normalizeShortcuts(settings.shortcuts, process.platform),
    permissions: normalizePermissionSettings(settings.permissions),
    agentAccess: normalizeAgentAccessSettings(settings.agentAccess),
    runs: normalizeRunSettings(settings.runs),
    ...(typeof settings.provider?.model === 'string' ? { provider: upgradeSelection(settings.provider) } : {}),
    ...(settings.title ? { title: withInstance(settings.title) } : {}),
    integrations: {
      ...settings.integrations,
      ...(skills?.model ? {
        skills: {
          ...skills,
          model: Object.fromEntries(Object.entries(skills.model).map(([skillId, value]) => [skillId, withInstance(value)]))
        }
      } : {}),
      tools: {
        enabled: typeof rawTools?.enabled === 'boolean' ? rawTools.enabled : defaults.integrations.tools.enabled,
        enabledTools,
        knownTools: [...MOUSSE_BUILTIN_TOOL_IDS]
      }
    }
  }
}

export class SettingsStore {
  private shouldPersistUsername = false

  constructor(private readonly config: MousseConfigStore) {
    const settings = this.config.assembleSettings()
    if (!settings.profile?.username?.trim()) {
      this.config.applySettingsPatch({
        profile: { username: generateRandomUsername() }
      })
      this.shouldPersistUsername = true
    }
    // Migrate legacy acrylic theme ids into theme + acrylic fields.
    const normalized = normalizeSettings(this.config.assembleSettings())
    const rawTheme = settings.appearance?.theme as string | undefined
    const needsAppearanceMigrate =
      rawTheme === 'dark-acrylic' ||
      rawTheme === 'light-acrylic' ||
      rawTheme === 'system-acrylic' ||
      typeof settings.appearance?.acrylic !== 'boolean' ||
      typeof settings.appearance?.acrylicIntensity !== 'number' ||
      typeof settings.appearance?.renderMath !== 'boolean'
    if (needsAppearanceMigrate) {
      this.config.applySettingsPatch({ appearance: normalized.appearance })
      this.shouldPersistUsername = true
    }
    if (this.shouldPersistUsername) {
      this.config.persist()
    }
  }

  getDefaults(): MousseSettings {
    return getDefaultSettings()
  }

  get(): MousseSettings {
    return normalizeSettings(structuredClone(this.config.assembleSettings()))
  }

  set(partial: MousseSettingsUpdate): MousseSettings {
    const current = this.get()
    const merged = deepMerge(
      current as unknown as Record<string, unknown>,
      partial as Partial<Record<string, unknown>>
    ) as unknown as MousseSettings
    // A default chosen by provider name alone must not keep the instance of an earlier choice.
    if (partial.provider?.llmProvider !== undefined && partial.provider.instanceId === undefined)
      merged.provider = { ...merged.provider, instanceId: undefined }
    // Nor the reasoning level or name of an earlier model.
    if (namesModel(partial.provider))
      merged.provider = { ...merged.provider, effort: partial.provider!.effort || undefined, name: partial.provider!.name || undefined }
    const normalized = normalizeSettings(merged)
    // The providers section is replaced key by key on disk: a cleared level or name is written as
    // an absent key, so it must be there to overwrite the stored one.
    if (namesModel(partial.provider)) normalized.provider = { ...normalized.provider, effort: normalized.provider.effort, name: normalized.provider.name }
    // The same for the title model and each skill's model. Their section is merged deeply on
    // disk, so the instance, level and name are cleared by writing them blank; reading drops them.
    const cleared = <T extends { instanceId?: string; effort?: string }>(selection: T, update: { llmProvider?: unknown; instanceId?: unknown; model?: unknown; effort?: string }): T => ({
      ...selection,
      ...(namesProviderOnly(update) ? { instanceId: '' } : {}),
      ...(namesModel(update) && !update.effort ? { effort: '' } : {})
    })
    if (partial.title) normalized.title = cleared(normalized.title, partial.title)
    const skillModels = Object.entries(partial.integrations?.skills?.model ?? {})
    if (skillModels.length) {
      const model = { ...normalized.integrations.skills.model }
      for (const [skillId, update] of skillModels) if (model[skillId] && update) model[skillId] = cleared(model[skillId]!, update)
      normalized.integrations = { ...normalized.integrations, skills: { ...normalized.integrations.skills, model } }
    }
    this.config.applySettingsPatch(normalized)
    return this.get()
  }
}
