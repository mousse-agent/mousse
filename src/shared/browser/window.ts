/**
 * A browser without a window, shown as a real window on the person's own screen ("Open in a window"). Chromium
 * decides whether it has windows when it starts, so the browser starts again with a window on the same profile,
 * and again without one when the window closes. Its tabs come back at their addresses (each page loads again) and
 * its session-only cookies are carried across both restarts. Browser-safe.
 */

/** How a window ended: the person closed it, it stopped unexpectedly, or it was closed for them (Close window, Give back). */
export type BrowserWindowEnd = 'closed' | 'crashed' | 'given-back'

export interface BrowserWindowState {
  /** The browser has a window now. */
  open: boolean
  /** Counts each change, for a caller that waits for the next one (`window.wait`). */
  serial: number
  /** How the last window ended, once one did. */
  ended?: BrowserWindowEnd
}

/**
 * The screen a window opens on, as the app's main process names its own (Linux only: on Windows and macOS the
 * window opens on the desktop the service runs in). Never from a page or the renderer.
 */
export interface BrowserWindowDisplay {
  DISPLAY?: string
  XAUTHORITY?: string
  WAYLAND_DISPLAY?: string
  XDG_RUNTIME_DIR?: string
}

const DISPLAY_NAME = /^[A-Za-z0-9._-]{0,253}:\d{1,4}(\.\d{1,3})?$/
const WAYLAND_NAME = /^[A-Za-z0-9._-]{1,64}$/

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 1024 && !value.includes('\0') && !value.includes('\n')
}

/**
 * The display as given, checked: an X display name (`:0`, `host:10.0`), an X authority file, a Wayland socket name
 * and its runtime folder (absolute paths). Anything else is refused; undefined when it names no display at all.
 */
export function browserWindowDisplay(value: unknown): BrowserWindowDisplay | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The display is not one Mousse can open a window on.')
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'].includes(key)) throw new Error('The display is not one Mousse can open a window on.')
  const display: BrowserWindowDisplay = {}
  if (raw.DISPLAY !== undefined) {
    if (typeof raw.DISPLAY !== 'string' || !DISPLAY_NAME.test(raw.DISPLAY)) throw new Error('The display is not one Mousse can open a window on.')
    display.DISPLAY = raw.DISPLAY
  }
  if (raw.XAUTHORITY !== undefined) {
    if (!absolutePath(raw.XAUTHORITY)) throw new Error('The display is not one Mousse can open a window on.')
    display.XAUTHORITY = raw.XAUTHORITY
  }
  if (raw.WAYLAND_DISPLAY !== undefined) {
    if (typeof raw.WAYLAND_DISPLAY !== 'string' || !(WAYLAND_NAME.test(raw.WAYLAND_DISPLAY) || absolutePath(raw.WAYLAND_DISPLAY))) throw new Error('The display is not one Mousse can open a window on.')
    display.WAYLAND_DISPLAY = raw.WAYLAND_DISPLAY
  }
  if (raw.XDG_RUNTIME_DIR !== undefined) {
    if (!absolutePath(raw.XDG_RUNTIME_DIR)) throw new Error('The display is not one Mousse can open a window on.')
    display.XDG_RUNTIME_DIR = raw.XDG_RUNTIME_DIR
  }
  return display.DISPLAY || display.WAYLAND_DISPLAY ? display : undefined
}

/** The control's tooltip: what a person should know before they open it. */
export const BROWSER_WINDOW_TOOLTIP = 'Pages reload when the window opens and when it closes.'
/** The one line the view shows while the browser is in a window. */
export const BROWSER_WINDOW_LINE = 'Open in a window on this computer.'
