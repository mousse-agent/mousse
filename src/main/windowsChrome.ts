import type { BrowserWindow } from 'electron'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { applyWindowMaterial } from './windowMaterial'

/**
 * Last corner preference written per window. Every DwmSetWindowAttribute call
 * forces a frame change, so re-writing the value already in effect repaints the
 * frame for nothing — visible as flicker when these run in bursts.
 */
const chromeTimers = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout>>()

export function applyWindowsRoundedCorners(win: BrowserWindow): void {
  // Thick-frame windows receive the native Windows corner policy. Avoid an FFI
  // addon here: a mismatched native binary crashes before errors can be caught.
  void win
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
