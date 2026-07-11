import type { BrowserWindow } from 'electron'
import { buildAccentCssVars, surfaceToWindowBackground } from '../shared/accentPalette'
import { themeUsesAcrylic } from '../shared/settings'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { reapplyWindowShadow } from './windowsChrome'

export function applyWindowMaterial(
  win: BrowserWindow | null | undefined,
  settings: SettingsStore
): boolean {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return false

  const theme = settings.get().appearance.theme
  const usesAcrylic = themeUsesAcrylic(theme)
  const material = usesAcrylic ? 'acrylic' : 'none'
  const surface =
    buildAccentCssVars(settings.get().appearance.accentColor)['--surface-base'] ?? '#1a1228'
  const alpha = usesAcrylic ? 0 : 1

  try {
    win.setBackgroundColor(surfaceToWindowBackground(surface, alpha))
    win.setBackgroundMaterial(material)
    if (material === 'acrylic') {
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
