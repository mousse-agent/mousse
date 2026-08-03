import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { refreshWindowChrome } from './windowsChrome'

const TOP_SNAP_THRESHOLD = 10

let normalBounds: Rectangle | null = null
/** Size locked at drag start — never re-read mid-gesture (avoids Windows DPI growth). */
let dragState: { offsetX: number; offsetY: number; width: number; height: number } | null = null
let rememberBoundsTimer: ReturnType<typeof setTimeout> | null = null

export interface WindowDragPoint {
  screenX: number
  screenY: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function rememberNormalBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
  normalBounds = win.getBounds()
}

function rememberNormalBoundsSoon(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
  if (rememberBoundsTimer) clearTimeout(rememberBoundsTimer)

  rememberBoundsTimer = setTimeout(() => {
    rememberBoundsTimer = null
    rememberNormalBounds(win)
  }, 120)
}

function isTopSnapPoint(point: WindowDragPoint): boolean {
  const cursor = { x: point.screenX, y: point.screenY }
  const display = screen.getDisplayNearestPoint(cursor).workArea

  return cursor.y <= display.y + TOP_SNAP_THRESHOLD
}

function getRestoreBounds(win: BrowserWindow): Rectangle {
  const fallback = win.getNormalBounds()
  const bounds = normalBounds ?? fallback

  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(bounds.width, 900),
    height: Math.max(bounds.height, 600)
  }
}

function getDragRestoreBounds(win: BrowserWindow, point?: WindowDragPoint): Rectangle {
  const restoreBounds = getRestoreBounds(win)
  const cursor = point ? { x: point.screenX, y: point.screenY } : screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor).workArea
  const x = Math.round(cursor.x - restoreBounds.width / 2)
  const y = Math.round(cursor.y - 16)

  return {
    x: clamp(x, display.x, display.x + display.width - restoreBounds.width),
    y: clamp(y, display.y, display.y + display.height - 80),
    width: restoreBounds.width,
    height: restoreBounds.height
  }
}

function restoreForDrag(win: BrowserWindow, settings: SettingsStore, point: WindowDragPoint): void {
  if (win.isDestroyed()) return

  if (win.isFullScreen()) {
    win.setFullScreen(false)
  }
  if (win.isMaximized()) {
    win.unmaximize()
  }

  win.setBounds(getDragRestoreBounds(win, point), false)
  refreshWindowChrome(win, settings)
  notifyWindowZoomChanged(win)
}

export function beginWindowDrag(
  win: BrowserWindow,
  settings: SettingsStore,
  point: WindowDragPoint
): void {
  if (win.isDestroyed()) return

  if (win.isFullScreen() || win.isMaximized()) {
    restoreForDrag(win, settings, point)
  }

  // Prefer main-process cursor coords so offset matches setBounds (same DIP space).
  const cursor = screen.getCursorScreenPoint()
  const bounds = win.getBounds()
  dragState = {
    offsetX: cursor.x - bounds.x,
    offsetY: cursor.y - bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

export function updateWindowDrag(
  win: BrowserWindow,
  settings: SettingsStore,
  _point: WindowDragPoint
): void {
  if (win.isDestroyed() || !dragState) return

  const cursor = screen.getCursorScreenPoint()

  if (isTopSnapPoint({ screenX: cursor.x, screenY: cursor.y })) {
    dragState = null
    win.maximize()
    refreshWindowChrome(win, settings)
    notifyWindowZoomChanged(win)
    return
  }

  // Always pass full bounds with size frozen at drag-start. Partial setBounds /
  // setPosition on Windows + non-100% DPI can grow the window every move.
  win.setBounds(
    {
      x: Math.round(cursor.x - dragState.offsetX),
      y: Math.round(cursor.y - dragState.offsetY),
      width: dragState.width,
      height: dragState.height
    },
    false
  )
}

export function endWindowDrag(win: BrowserWindow, settings: SettingsStore): void {
  if (win.isDestroyed()) return

  dragState = null
  rememberNormalBounds(win)
  refreshWindowChrome(win, settings)
}

export function isWindowZoomed(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  return win.isFullScreen() || win.isMaximized()
}

export function toggleWindowZoom(win: BrowserWindow, settings: SettingsStore): void {
  if (win.isDestroyed()) return

  dragState = null

  if (win.isFullScreen()) {
    win.setFullScreen(false)
  } else if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }

  refreshWindowChrome(win, settings)
  notifyWindowZoomChanged(win)
}

export function notifyWindowZoomChanged(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:maximized-changed', isWindowZoomed(win))
}

export function attachWindowStateListeners(
  getWindow: () => BrowserWindow | null,
  settings: SettingsStore
): void {
  const win = getWindow()
  if (!win) return

  rememberNormalBounds(win)

  // Zoom state is cheap IPC and worth re-sending once the OS has settled; chrome is
  // not — re-running it on the same tick repainted the frame twice per transition.
  const refreshStateSoon = (): void => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return

    notifyWindowZoomChanged(current)
    refreshWindowChrome(current, settings)
    setImmediate(() => {
      const settled = getWindow()
      if (!settled || settled.isDestroyed()) return
      notifyWindowZoomChanged(settled)
    })
  }

  // Do not intercept will-move for top-snap: with titleBarStyle:hidden + thickFrame,
  // Windows Aero snap and double-click maximize must run natively. Intercepting
  // (preventDefault + setBounds workArea) left the window at the wrong size.

  win.on('move', () => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return
    if (!current.isMaximized() && !current.isFullScreen()) rememberNormalBounds(current)
  })

  win.on('resize', () => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return
    if (!current.isMaximized() && !current.isFullScreen()) rememberNormalBoundsSoon(current)
  })

  win.on('maximize', refreshStateSoon)
  win.on('unmaximize', refreshStateSoon)
  win.on('restore', refreshStateSoon)
  win.on('enter-full-screen', refreshStateSoon)
  win.on('leave-full-screen', refreshStateSoon)
}
