import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'

import type { SettingsStore } from '../mms/settings/SettingsStore'
import { buildAccentCssVars, surfaceToWindowBackground } from '../shared/accentPalette'
import { applyWindowsRoundedCorners } from './windowsChrome'
import { getAppIconPath } from './appIcon'
import {
  agentsTasksLoadTarget,
  attachWindowWebContentsRecovery,
  registerWindowForResumeRecovery
} from './windowResume'
import { attachZoomShortcuts } from './zoomShortcuts'

const WINDOW_WIDTH = 640
const WINDOW_HEIGHT = 520
const ANCHOR_GAP = 6

export interface AgentsTasksAnchor {
  x: number
  y: number
}

let agentsTasksWindow: BrowserWindow | null = null

export function getAgentsTasksWindow(): BrowserWindow | null {
  return agentsTasksWindow && !agentsTasksWindow.isDestroyed() ? agentsTasksWindow : null
}

function resolveBounds(anchor: AgentsTasksAnchor | undefined): { x: number; y: number } {
  const workArea = screen.getDisplayNearestPoint(
    anchor ? { x: anchor.x, y: anchor.y } : screen.getCursorScreenPoint()
  ).workArea

  if (!anchor) {
    return {
      x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
      y: Math.round(workArea.y + (workArea.height - WINDOW_HEIGHT) / 2)
    }
  }

  let x = Math.round(anchor.x)
  let y = Math.round(anchor.y + ANCHOR_GAP)

  if (x + WINDOW_WIDTH > workArea.x + workArea.width) {
    x = Math.round(workArea.x + workArea.width - WINDOW_WIDTH)
  }
  if (x < workArea.x) x = workArea.x

  if (y + WINDOW_HEIGHT > workArea.y + workArea.height) {
    y = Math.round(workArea.y + workArea.height - WINDOW_HEIGHT)
  }
  if (y < workArea.y) y = workArea.y

  return { x, y }
}

export function closeAgentsTasksWindow(): void {
  const win = getAgentsTasksWindow()
  if (win && !win.isDestroyed()) {
    win.close()
  }
}

export function openAgentsTasksWindow(
  settings: SettingsStore,
  parent?: BrowserWindow,
  anchor?: AgentsTasksAnchor
): void {
  const parentWindow = parent && !parent.isDestroyed() ? parent : undefined
  const existing = getAgentsTasksWindow()
  if (existing) {
    if (parentWindow && existing.getParentWindow() !== parentWindow) {
      existing.setParentWindow(parentWindow)
    }
    if (anchor) {
      const { x, y } = resolveBounds(anchor)
      existing.setPosition(x, y, false)
    }
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }

  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const { x, y } = resolveBounds(anchor)

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    minWidth: 480,
    minHeight: 360,
    title: 'Agents & Tasks',
    icon: getAppIconPath(),
    parent: parentWindow,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    ...(isWindows
      ? { titleBarStyle: 'hidden' as const, thickFrame: true, autoHideMenuBar: true }
      : isMac
        ? { titleBarStyle: 'hiddenInset' as const }
        : { frame: false }),
    backgroundColor: surfaceToWindowBackground(
      buildAccentCssVars(settings.get().appearance.accentColor)['--surface-base'] ?? '#1a1228'
    ),
    ...(isWindows ? { backgroundMaterial: 'none' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  agentsTasksWindow = win

  win.on('closed', () => {
    if (agentsTasksWindow === win) agentsTasksWindow = null
  })

  win.on('ready-to-show', () => {
    win.show()
    applyWindowsRoundedCorners(win)
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  attachZoomShortcuts(win.webContents)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/agentsTasks.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/agentsTasks.html'))
  }

  const target = agentsTasksLoadTarget()
  registerWindowForResumeRecovery(win, target)
  attachWindowWebContentsRecovery(win, target)
}
