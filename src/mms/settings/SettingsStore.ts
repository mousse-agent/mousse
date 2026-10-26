import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import { getDefaultSettings, normalizeAppearance, normalizeContextSettings } from '../../shared/settings'
import { MOUSSE_BUILTIN_TOOL_IDS } from '../../shared/integrations'
import { generateRandomUsername } from '../../shared/randomUsername'
import type { MousseConfigStore } from '../config/MousseConfigStore'

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

/** A stored selection with its instance id kept only when it names one. */
function withInstance<T extends { instanceId?: unknown }>(selection: T): T {
  if (!selection || typeof selection !== 'object') return selection
  const { instanceId, ...rest } = selection
  const id = typeof instanceId === 'string' ? instanceId.trim() : ''
  return (id ? { ...rest, instanceId: id } : rest) as T
}

/** An update that picks a model by provider name alone (no instance). */
function namesProviderOnly(selection: { llmProvider?: unknown; instanceId?: unknown } | undefined): boolean {
  return Boolean(selection) && selection!.llmProvider !== undefined && selection!.instanceId === undefined
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
      typeof settings.appearance?.acrylicIntensity !== 'number'
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
    const normalized = normalizeSettings(merged)
    // The same for the title model and each skill's model. Their section is merged deeply on
    // disk, so the instance is cleared by writing it blank; reading drops a blank instance.
    if (namesProviderOnly(partial.title)) normalized.title = { ...normalized.title, instanceId: '' }
    const skillModels = Object.entries(partial.integrations?.skills?.model ?? {}).filter(([, value]) => namesProviderOnly(value))
    if (skillModels.length) {
      const model = { ...normalized.integrations.skills.model }
      for (const [skillId] of skillModels) model[skillId] = { ...model[skillId]!, instanceId: '' }
      normalized.integrations = { ...normalized.integrations, skills: { ...normalized.integrations.skills, model } }
    }
    this.config.applySettingsPatch(normalized)
    return this.get()
  }
}
