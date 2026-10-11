import type { BrowserWindow } from 'electron'
import { nativeTheme } from 'electron'
import { surfaceToWindowBackground } from '../shared/accentPalette'
import { appearanceSurfaceBase } from '../shared/themeSurfaces'
import { appearanceUsesAcrylic, normalizeAppearance } from '../shared/settings'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import type { MousseSettings } from '../shared/settings'
import { reapplyWindowShadow } from './windowsChrome'

/**
 * Last background color + material written per window. setBackgroundMaterial()
 * re-composites the whole frame, so re-applying an unchanged value flickers when
 * these calls arrive in bursts (window-state changes, focus churn).
 */
const appliedMaterial = new WeakMap<BrowserWindow, string>()
const windowProfileSettings = new WeakMap<BrowserWindow, MousseSettings>()

/** Keep focus/resume chrome refreshes on the window's bound profile. */
export function setWindowProfileSettings(win: BrowserWindow, settings: MousseSettings): void {
  windowProfileSettings.set(win, settings)
}

export function applyWindowMaterial(
  win: BrowserWindow | null | undefined,
  settings: SettingsStore
): boolean {
  if (!win || win.isDestroyed() || !['win32', 'linux'].includes(process.platform)) return false

  const appearance = normalizeAppearance((windowProfileSettings.get(win) ?? settings.get()).appearance)
  const usesAcrylic = appearanceUsesAcrylic(appearance)
  const material = usesAcrylic ? 'acrylic' : 'none'
  const surface = appearanceSurfaceBase(appearance, nativeTheme?.shouldUseDarkColors ?? true)
  const alpha = usesAcrylic || process.platform === 'linux' ? 0 : 1
  const background = surfaceToWindowBackground(surface, alpha)

  const key = `${material}|${background}`
  if (appliedMaterial.get(win) === key) return true

  try {
    win.setBackgroundColor(background)
    if (process.platform === 'win32') win.setBackgroundMaterial(material)
    appliedMaterial.set(win, key)
    if (material === 'acrylic' && process.platform === 'win32') {
      reapplyWindowShadow(win)
    }
    return true
  } catch {
    return false
  }
}

export function attachWindowFocusListeners(
  getWindow: () => BrowserWindow | null,
  settings: SettingsStore
): void {
  const win = getWindow()
  if (!win) return

  const sync = (focused: boolean) => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return

    // Re-apply Electron material on activation changes; Windows may reset chrome state.
    applyWindowMaterial(current, settings)
    current.webContents.send('window:focus-changed', focused)
  }

  win.on('focus', () => sync(true))
  win.on('blur', () => sync(false))
  sync(win.isFocused())
}
