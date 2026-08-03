import koffi from 'koffi'
import type { BrowserWindow } from 'electron'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { applyWindowMaterial } from './windowMaterial'

const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUND = 2
const DWMWCP_DONOTROUND = 1

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

/**
 * Last corner preference written per window. Every DwmSetWindowAttribute call
 * forces a frame change, so re-writing the value already in effect repaints the
 * frame for nothing — visible as flicker when these run in bursts.
 */
const appliedCorner = new WeakMap<BrowserWindow, number>()
const chromeTimers = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>()

export function applyWindowsRoundedCorners(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  const setAttribute = getDwmApi()
  if (!setAttribute) return

  // Forcing ROUND while maximized/snapped leaves rounded gaps at the screen
  // corners, so the window reads as not filling the display. Square it instead.
  const zoomed = win.isMaximized() || win.isFullScreen()
  const preference = zoomed ? DWMWCP_DONOTROUND : DWMWCP_ROUND
  if (appliedCorner.get(win) === preference) return

  try {
    const value = Buffer.alloc(4)
    value.writeUInt32LE(preference, 0)
    setAttribute(win.getNativeWindowHandle(), DWMWA_WINDOW_CORNER_PREFERENCE, value, 4)
    appliedCorner.set(win, preference)
  } catch {
    // DWM API unavailable on older Windows builds.
  }
}

export function reapplyWindowShadow(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return

  // invalidateShadow() repositions the window (SWP_FRAMECHANGED). Doing that to a
  // maximized or snapped window makes Windows drop its stored restore rectangle,
  // which is what breaks Aero-snap and double-click restore-down. The drop shadow
  // is only visible on a floating window anyway, so skip it while zoomed.
  if (!win.isMaximized() && !win.isFullScreen()) {
    try {
      win.setHasShadow(true)
      win.invalidateShadow()
    } catch {
      // ignore
    }
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

  // Windows can reset chrome state shortly after a window-state change, so make one
  // coalesced trailing pass. This used to be three passes at 50/200/500ms, which
  // repainted the frame mid-snap and flickered; the calls below are now no-ops
  // unless something actually changed.
  const pending = chromeTimers.get(win)
  if (pending) clearTimeout(pending)
  chromeTimers.set(
    win,
    setTimeout(() => {
      chromeTimers.delete(win)
      if (win.isDestroyed()) return
      applyWindowMaterial(win, settings)
      reapplyWindowShadow(win)
    }, 200)
  )
}
