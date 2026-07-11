import { BrowserWindow, powerMonitor } from 'electron'
import { join } from 'path'
import type { SettingsStore } from '../mms/settings/SettingsStore'
import { applyWindowMaterial } from './windowMaterial'
import { refreshWindowChrome } from './windowsChrome'

export interface WindowLoadTarget {
  devUrl?: string
  prodFile: string
}

let recoverTimer: ReturnType<typeof setTimeout> | null = null

function reloadWindow(win: BrowserWindow, target: WindowLoadTarget): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  if (target.devUrl) {
    void win.webContents.loadURL(target.devUrl)
    return
  }
  void win.webContents.loadFile(target.prodFile)
}

async function isRendererBlank(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false
  if (win.webContents.isCrashed()) return true

  try {
    return await win.webContents.executeJavaScript(
      `(() => {
        const root = document.getElementById('root')
        if (!root) return true
        const hasContent =
          root.childElementCount > 0 || (root.textContent ?? '').trim().length > 0
        return !hasContent
      })()`,
      true
    )
  } catch {
    return true
  }
}

async function recoverWindow(
  win: BrowserWindow,
  settings: SettingsStore,
  target: WindowLoadTarget
): Promise<void> {
  if (win.isDestroyed()) return

  refreshWindowChrome(win, settings)
  applyWindowMaterial(win, settings)

  const wc = win.webContents
  if (wc.isDestroyed()) return

  try {
    wc.invalidate()
  } catch {
    // ignore
  }

  if (wc.isCrashed() || (await isRendererBlank(win))) {
    reloadWindow(win, target)
  }
}

function scheduleRecovery(
  windows: Array<{ win: BrowserWindow; target: WindowLoadTarget }>,
  settings: SettingsStore
): void {
  if (recoverTimer) clearTimeout(recoverTimer)
  recoverTimer = setTimeout(() => {
    recoverTimer = null
    for (const { win, target } of windows) {
      void recoverWindow(win, settings, target)
    }
  }, 400)
}

export function mainWindowLoadTarget(): WindowLoadTarget {
  return {
    devUrl: process.env.ELECTRON_RENDERER_URL,
    prodFile: join(__dirname, '../renderer/index.html')
  }
}

export function agentsTasksLoadTarget(): WindowLoadTarget {
  return {
    devUrl: process.env.ELECTRON_RENDERER_URL
      ? `${process.env.ELECTRON_RENDERER_URL}/agentsTasks.html`
      : undefined,
    prodFile: join(__dirname, '../renderer/agentsTasks.html')
  }
}

export function attachWindowWebContentsRecovery(
  win: BrowserWindow,
  target: WindowLoadTarget
): void {
  win.webContents.on('render-process-gone', () => {
    reloadWindow(win, target)
  })
}

const trackedWindows = new Map<number, { win: BrowserWindow; target: WindowLoadTarget }>()

export function registerWindowForResumeRecovery(
  win: BrowserWindow,
  target: WindowLoadTarget
): void {
  trackedWindows.set(win.id, { win, target })
  win.on('closed', () => {
    trackedWindows.delete(win.id)
  })
}

export function attachWindowResumeRecovery(settings: SettingsStore): void {
  const trigger = (): void => {
    const windows = [...trackedWindows.values()].filter(
      ({ win }) => !win.isDestroyed()
    )
    if (windows.length === 0) return
    scheduleRecovery(windows, settings)
  }

  powerMonitor.on('resume', trigger)
  powerMonitor.on('unlock-screen', trigger)
}
