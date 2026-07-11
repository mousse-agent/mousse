import koffi from 'koffi'
import type { BrowserWindow } from 'electron'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { applyWindowMaterial } from './windowMaterial'

const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUND = 2

type DwmSetWindowAttribute = (
  hwnd: Buffer,
  attribute: number,
  value: Buffer,
  size: number
) => number

let dwmSetWindowAttribute: DwmSetWindowAttribute | undefined

function getDwmApi(): DwmSetWindowAttribute | undefined {
  if (dwmSetWindowAttribute !== undefined) return dwmSetWindowAttribute

  try {
    const dwmapi = koffi.load('dwmapi.dll')
    dwmSetWindowAttribute = dwmapi.func(
      'HRESULT __stdcall DwmSetWindowAttribute(void* hwnd, DWORD attribute, void* value, DWORD size)'
    ) as DwmSetWindowAttribute
  } catch {
    dwmSetWindowAttribute = undefined
  }

  return dwmSetWindowAttribute
}

export function applyWindowsRoundedCorners(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  const setAttribute = getDwmApi()
  if (!setAttribute) return

  try {
    const preference = Buffer.alloc(4)
    preference.writeUInt32LE(DWMWCP_ROUND, 0)
    setAttribute(win.getNativeWindowHandle(), DWMWA_WINDOW_CORNER_PREFERENCE, preference, 4)
  } catch {
    // DWM API unavailable on older Windows builds.
  }
}

export function reapplyWindowShadow(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  try {
    win.setHasShadow(true)
    win.invalidateShadow()
  } catch {
    // ignore
  }

  applyWindowsRoundedCorners(win)
}

export function refreshWindowChrome(
  win: BrowserWindow | null | undefined,
  settings: SettingsStore
): void {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return

  applyWindowMaterial(win, settings)

  reapplyWindowShadow(win)
  for (const delay of [50, 200, 500]) {
    setTimeout(() => reapplyWindowShadow(win), delay)
  }
}
