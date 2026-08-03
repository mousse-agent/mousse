import { app, BrowserWindow, Menu, Tray, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

import { detectCliMode, stripCliModeArgs } from '../cli/cliLaunch'
import { resolveMousseHome } from '../cli/paths'
import { MousseConfigStore } from '../mms/config/MousseConfigStore'
import { SettingsStore } from '../mms/settings/SettingsStore'
import { FileService } from '../mms/files/FileService'
import { GitService } from '../mms/git/GitService'
import { LineEditStatsStore } from '../mms/stats/LineEditStatsStore'
import { GuiMmsController } from './mms/GuiMmsController'
import { PresentationState } from './mms/PresentationState'
import {
  attachWindowListeners,
  bootstrapPresentation,
  registerGuiIpc
} from './ipc/registerGuiIpc'
import { appearanceUsesAcrylic, normalizeAppearance } from '../shared/settings'
import { buildAccentCssVars, surfaceToWindowBackground } from '../shared/accentPalette'
import { refreshWindowChrome } from './windowsChrome'
import { BrowserViewManager } from './browser/BrowserViewManager'
import { applyAppIcon, getAppIconPath } from './appIcon'
import {
  attachWindowResumeRecovery,
  attachWindowWebContentsRecovery,
  mainWindowLoadTarget,
  registerWindowForResumeRecovery
} from './windowResume'
import { attachContextMenu } from './contextMenu'
import { setupApplicationMenu } from './applicationMenu'
import { attachZoomShortcuts } from './zoomShortcuts'

/** User args for dual-mode CLI (`Mousse.exe --cli …` or dev `electron . --cli …`). */
function electronCliArgv(): string[] {
  const raw =
    process.defaultApp || /[\\/]electron(.\w+)?$/i.test(process.execPath)
      ? process.argv.slice(2)
      : process.argv.slice(1)
  return stripCliModeArgs(raw)
}

const isCliMode = detectCliMode(process.argv)

// Packaged / dual-mode headless CLI — no GUI, no single-instance lock (GUI may already be open).
if (isCliMode) {
  app.whenReady().then(async () => {
    try {
      const { runCliMain } = await import('../cli/runCliMain')
      await runCliMain(electronCliArgv())
      app.exit(0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      app.exit(1)
    }
  })
} else {
  startGuiApp()
}

/**
 * Phase 3 GUI: connect to standalone MMS daemon via local protocol.
 * Electron never acquires the MMS owner lease and never stops the daemon on quit.
 */
function startGuiApp(): void {
  let mainWindow: BrowserWindow | null = null
  let guiMms: GuiMmsController | null = null
  let settings: SettingsStore | null = null
  let tray: Tray | null = null
  let isQuitting = false
  let bootstrapComplete = false
  let bootstrapPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null
  let shutdownComplete = false
  let ipcRegistered = false
  let windowListenersAttached = false
  let resumeRecoveryAttached = false

  const browserView = new BrowserViewManager()
  const presentation = new PresentationState()

  const gotSingleInstanceLock = app.requestSingleInstanceLock()

  if (!gotSingleInstanceLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  function createTray(): void {
    if (tray) return

    const iconPath = getAppIconPath()
    if (!iconPath) return

    try {
      tray = new Tray(iconPath)
    } catch (error) {
      console.warn('Failed to create system tray:', error)
      return
    }
    tray.setToolTip('Mousse')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Mousse',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          void beginQuit()
        }
      }
    ])

    tray.setContextMenu(contextMenu)
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  }

  function broadcastToWindows(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  function createWindow(): void {
    if (!settings) return
    // Do not create a second main window if one exists.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
      return
    }

    const isWindows = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    const appearance = normalizeAppearance(settings.get().appearance)
    const useAcrylic = isWindows && appearanceUsesAcrylic(appearance)

    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Mousse',
      icon: getAppIconPath(),
      fullscreenable: false,
      ...(isWindows
        ? {
            titleBarStyle: 'hidden' as const,
            thickFrame: true,
            autoHideMenuBar: true
          }
        : {
            frame: false
          }),
      backgroundColor: surfaceToWindowBackground(
        buildAccentCssVars(appearance.accentColor)['--surface-base'] ?? '#1a1228',
        useAcrylic ? 0 : 1
      ),
      ...(isWindows
        ? { backgroundMaterial: useAcrylic ? ('acrylic' as const) : ('none' as const) }
        : {}),
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 14, y: 13 }
          }
        : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true
      }
    })

    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
      if (settings) refreshWindowChrome(mainWindow, settings)
    })

    // Phase 3: closing the window never stops the daemon. Hide when not quitting.
    mainWindow.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault()
        mainWindow?.hide()
      }
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    attachContextMenu(mainWindow.webContents, () => mainWindow)
    attachZoomShortcuts(mainWindow.webContents)

    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    const mainTarget = mainWindowLoadTarget()
    registerWindowForResumeRecovery(mainWindow, mainTarget)
    attachWindowWebContentsRecovery(mainWindow, mainTarget)
  }

  /**
   * Singleton bootstrap: connect to daemon as client (start if absent).
   * Never constructs MousseMainService / never takes ownership.
   */
  async function bootstrap(): Promise<void> {
    if (bootstrapComplete) return
    if (bootstrapPromise) {
      await bootstrapPromise
      return
    }

    bootstrapPromise = (async () => {
      const homeDir = resolveMousseHome(process.env.MOUSSE_HOME)
      process.env.MOUSSE_HOME = homeDir
      const repoRoot =
        process.env.MOUSSE_REPO_ROOT || (app.isPackaged ? homedir() : process.cwd())

      // Local settings for window chrome only — not MMS ownership.
      const config = MousseConfigStore.load(homeDir)
      settings = new SettingsStore(config)

      guiMms = new GuiMmsController({ homeDir })
      try {
        await guiMms.start()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('Failed to connect to MMS daemon:', message)
        // Prefer a clear startup error over split-brain embedded MMS.
        throw new Error(
          `Mousse GUI requires the MMS daemon.\n${message}\n` +
            'Start it with `mousse-cli service start` or fix ownership conflicts.'
        )
      }

      // SettingsStore is a chrome presentation mirror only — execution settings are daemon-owned.
      try {
        const snap = await guiMms.request<{ settings: import('../shared/settings').MousseSettings }>(
          'settings.get'
        )
        settings.set(snap.settings)
      } catch {
        /* chrome defaults until protocol settings available */
      }

      const fileService = new FileService()
      const gitService = new GitService()
      const lineEditStats = new LineEditStatsStore()

      if (!ipcRegistered) {
        registerGuiIpc(
          {
            guiMms,
            presentation,
            settings,
            fileService,
            gitService,
            lineEditStats,
            browserView,
            repoRoot,
            requestAppRestart: () => coordinatedRestart()
          },
          () => mainWindow
        )
        ipcRegistered = true
      }

      await bootstrapPresentation(guiMms, presentation, broadcastToWindows)

      createWindow()
      createTray()

      if (!windowListenersAttached && settings) {
        attachWindowListeners(() => mainWindow, settings)
        windowListenersAttached = true
      }
      if (!resumeRecoveryAttached && settings) {
        attachWindowResumeRecovery(settings)
        resumeRecoveryAttached = true
      }

      bootstrapComplete = true
    })()

    try {
      await bootstrapPromise
    } finally {
      bootstrapPromise = null
    }
  }

  /**
   * Disconnect GUI client only — daemon keeps running.
   */
  async function coordinatedShutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    isQuitting = true
    shutdownPromise = (async () => {
      try {
        if (guiMms) await guiMms.stop()
      } catch (err) {
        console.error('guiMms.stop failed during shutdown:', err)
      }
      guiMms = null
      try {
        browserView.destroy()
      } catch {
        /* ignore */
      }
      try {
        tray?.destroy()
      } catch {
        /* ignore */
      }
      tray = null
      shutdownComplete = true
    })()
    await shutdownPromise
  }

  async function beginQuit(): Promise<void> {
    await coordinatedShutdown()
    app.quit()
  }

  async function coordinatedRestart(): Promise<void> {
    // App restart disconnects UI client only; daemon is not stopped.
    await coordinatedShutdown()
    app.relaunch()
    app.quit()
  }

  app
    .whenReady()
    .then(() => {
      setupApplicationMenu()
      applyAppIcon()
      return bootstrap()
    })
    .catch((error) => {
      console.error('Failed to start Mousse:', error)
      // Surface a visible failure when daemon is unavailable.
      const message = error instanceof Error ? error.message : String(error)
      if (process.platform === 'win32') {
        // Avoid silent exit on Windows packaged builds.
        process.stderr.write(`${message}\n`)
      }
      app.exit(1)
    })

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    // No embedded MMS work to retain — quit disconnects client only.
    void beginQuit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (bootstrapComplete && guiMms) {
        createWindow()
      } else {
        void bootstrap()
      }
    } else {
      mainWindow?.show()
    }
  })

  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    void coordinatedShutdown().then(() => {
      app.quit()
    })
  })
}
