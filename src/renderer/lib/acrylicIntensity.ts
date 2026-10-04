import { clampAcrylicIntensity, glassTokensFromIntensity } from '../../shared/settings'
import type { AppearanceSettings, MousseSettings } from '../../shared/settings'

/** Update glass opacity immediately; settings persistence can remain debounced. */
export function applyAcrylicIntensity(intensity: number, root = document.documentElement): void {
  const value = clampAcrylicIntensity(intensity)
  const tokens = glassTokensFromIntensity(value)
  root.style.setProperty('--acrylic-intensity', String(value))
  root.style.setProperty('--glass-alpha-base', String(tokens.alphaBase))
  root.style.setProperty('--glass-alpha-strong', String(tokens.alphaStrong))
  root.style.setProperty('--glass-alpha-soft', String(tokens.alphaSoft))
}

/** Read current appearance rather than the settings panel's initial null state. */
export async function persistLinuxAcrylicIntensity(
  intensity: number,
  settings: {
    get(): Promise<MousseSettings>
    set(update: { appearance: AppearanceSettings }): Promise<MousseSettings>
  } = window.mousse.settings
): Promise<MousseSettings> {
  const current = await settings.get()
  return settings.set({
    appearance: { ...current.appearance, acrylicIntensity: clampAcrylicIntensity(intensity) }
  })
}
