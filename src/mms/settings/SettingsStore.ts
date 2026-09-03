import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import { getDefaultSettings, normalizeAppearance } from '../../shared/settings'
import { MOUSSE_BUILTIN_TOOL_IDS } from '../../shared/integrations'

/** Tool ids that existed before interaction/task/action/skill helpers were toggleable. */
const LEGACY_MOUSSE_TOOL_IDS = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'git_status',
  'git_diff'
])
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

function normalizeSettings(settings: MousseSettings): MousseSettings {
  const defaults = getDefaultSettings()
  const integrations = settings.integrations as MousseSettings['integrations'] & {
    tools?: { enabled?: unknown; enabledTools?: unknown }
  }
  const rawTools = integrations?.tools
  const validIds = new Set(MOUSSE_BUILTIN_TOOL_IDS)
  const rawList: unknown[] | undefined = Array.isArray(rawTools?.enabledTools)
    ? (rawTools.enabledTools as unknown[])
    : undefined
  const storedTools = rawList
    ? rawList.filter((id): id is string => typeof id === 'string' && validIds.has(id))
    : [...MOUSSE_BUILTIN_TOOL_IDS]
  // Tools added after a config was stored default to enabled — but only when the
  // stored list shows no sign of the new era yet. Once any new-era id appears in
  // the stored list, the user's selection is respected exactly (so explicit
  // opt-outs are never resurrected on restart).
  const seenNewEra = storedTools.some((id) => !LEGACY_MOUSSE_TOOL_IDS.has(id))
  const enabledTools =
    rawList && !seenNewEra
      ? [...new Set([...storedTools, ...MOUSSE_BUILTIN_TOOL_IDS.filter((id) => !LEGACY_MOUSSE_TOOL_IDS.has(id))])]
      : storedTools
  return {
    ...settings,
    appearance: normalizeAppearance(settings.appearance),
    integrations: {
      ...settings.integrations,
      tools: {
        enabled: typeof rawTools?.enabled === 'boolean' ? rawTools.enabled : defaults.integrations.tools.enabled,
        enabledTools
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
    const normalized = normalizeSettings(merged)
    this.config.applySettingsPatch(normalized)
    return this.get()
  }
}
