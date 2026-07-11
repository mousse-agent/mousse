import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { refreshWindowChrome } from './windowsChrome'

const TOP_SNAP_THRESHOLD = 10

let isCustomFullScreen = false
let normalBounds: Rectangle | null = null
let convertingNativeZoom = false
let dragState: { offsetX: number; offsetY: number } | null = null
let rememberBoundsTimer: ReturnType<typeof setTimeout> | null = null

export interface WindowDragPoint {
  screenX: number
  screenY: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function rememberNormalBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || isCustomFullScreen || win.isMaximized() || win.isFullScreen()) return
  normalBounds = win.getBounds()
}

function rememberNormalBoundsSoon(win: BrowserWindow): void {
  if (win.isDestroyed() || isCustomFullScreen || win.isMaximized() || win.isFullScreen()) return
  if (rememberBoundsTimer) clearTimeout(rememberBoundsTimer)

  rememberBoundsTimer = setTimeout(() => {
    rememberBoundsTimer = null
    rememberNormalBounds(win)
  }, 120)
}

function getCustomFullScreenBounds(win: BrowserWindow): Rectangle {
  return screen.getDisplayMatching(win.getBounds()).workArea
}

function isTopSnapPoint(point: WindowDragPoint): boolean {
  const cursor = { x: point.screenX, y: point.screenY }
  const display = screen.getDisplayNearestPoint(cursor).workArea

  return cursor.y <= display.y + TOP_SNAP_THRESHOLD
}

function isTopSnapMove(win: BrowserWindow, nextBounds: Rectangle): boolean {
  if (process.platform !== 'win32' || win.isDestroyed()) return false

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor).workArea

  return cursor.y <= display.y + TOP_SNAP_THRESHOLD || nextBounds.y <= display.y
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

function enterCustomFullScreen(win: BrowserWindow, settings: SettingsStore): void {
  if (win.isDestroyed()) return

  if (!isCustomFullScreen) {
    rememberNormalBounds(win)
  }

  if (win.isFullScreen()) {
    win.setFullScreen(false)
  }

  if (win.isMaximized()) {
    win.unmaximize()
  }

  isCustomFullScreen = true
  win.setBounds(getCustomFullScreenBounds(win), false)
  refreshWindowChrome(win, settings)
  notifyWindowZoomChanged(win)
}

function leaveCustomFullScreen(win: BrowserWindow, settings: SettingsStore, bounds = getRestoreBounds(win)): void {
  if (win.isDestroyed()) return

  if (win.isFullScreen()) {
    win.setFullScreen(false)
  }

  if (win.isMaximized()) {
    win.unmaximize()
  }

  isCustomFullScreen = false
  win.setBounds(bounds, false)
  refreshWindowChrome(win, settings)
  notifyWindowZoomChanged(win)
  rememberNormalBounds(win)
}

export function beginWindowDrag(
  win: BrowserWindow,
  settings: SettingsStore,
  point: WindowDragPoint
): void {
  if (win.isDestroyed()) return

  if (isCustomFullScreen || win.isFullScreen() || win.isMaximized()) {
    leaveCustomFullScreen(win, settings, getDragRestoreBounds(win, point))
  }

  const bounds = win.getBounds()
  dragState = {
    offsetX: point.screenX - bounds.x,
    offsetY: point.screenY - bounds.y
  }
}

export function updateWindowDrag(
  win: BrowserWindow,
  settings: SettingsStore,
  point: WindowDragPoint
): void {
  if (win.isDestroyed() || !dragState) return

  if (isTopSnapPoint(point)) {
    dragState = null
    enterCustomFullScreen(win, settings)
    return
  }

  win.setBounds(
    {
      x: Math.round(point.screenX - dragState.offsetX),
      y: Math.round(point.screenY - dragState.offsetY)
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
  return isCustomFullScreen || win.isFullScreen() || win.isMaximized()
}

export function toggleWindowZoom(win: BrowserWindow, settings: SettingsStore): void {
  if (win.isDestroyed()) return

  dragState = null

  if (isCustomFullScreen || win.isFullScreen() || win.isMaximized()) {
    leaveCustomFullScreen(win, settings)
    return
  }

  enterCustomFullScreen(win, settings)
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

  const refreshState = (): void => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return

    notifyWindowZoomChanged(current)
    refreshWindowChrome(current, settings)
  }

  const refreshStateSoon = (): void => {
    refreshState()
    setImmediate(refreshState)
  }

  win.on('will-move', (event, newBounds) => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return

    if (isCustomFullScreen) {
      event.preventDefault()
      leaveCustomFullScreen(current, settings, getDragRestoreBounds(current))
      return
    }

    rememberNormalBounds(current)

    if (isTopSnapMove(current, newBounds)) {
      event.preventDefault()
      enterCustomFullScreen(current, settings)
    }
  })

  win.on('move', () => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return
    if (!isCustomFullScreen) rememberNormalBounds(current)
  })

  win.on('resize', () => {
    const current = getWindow()
    if (!current || current.isDestroyed()) return
    if (!isCustomFullScreen) rememberNormalBoundsSoon(current)
  })

  win.on('maximize', () => {
    const current = getWindow()
    if (!current || current.isDestroyed() || convertingNativeZoom) return

    convertingNativeZoom = true
    current.unmaximize()
    setImmediate(() => {
      convertingNativeZoom = false
      enterCustomFullScreen(current, settings)
    })
  })

  win.on('enter-full-screen', () => {
    const current = getWindow()
    if (!current || current.isDestroyed() || convertingNativeZoom) return

    convertingNativeZoom = true
    current.setFullScreen(false)
    setImmediate(() => {
      convertingNativeZoom = false
      enterCustomFullScreen(current, settings)
    })
  })

  win.on('unmaximize', refreshStateSoon)
  win.on('restore', refreshStateSoon)
  win.on('leave-full-screen', refreshStateSoon)
}
