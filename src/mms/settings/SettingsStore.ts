import type { MousseSettings, MousseSettingsUpdate } from '../../shared/settings'
import { getDefaultSettings, normalizeAppearance } from '../../shared/settings'
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
  return {
    ...settings,
    appearance: normalizeAppearance(settings.appearance)
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
