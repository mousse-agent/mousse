import { app, BrowserWindow, dialog, session, shell, type WebContents } from 'electron'
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
import { normalizeAppearance } from '../shared/settings'
import { buildAccentCssVars, surfaceToWindowBackground } from '../shared/accentPalette'
import { refreshWindowChrome } from './windowsChrome'
import { BrowserViewManager } from './browser/BrowserViewManager'
import {
  browserCompatibleUserAgent,
  isAllowedBrowserPopupUrl,
  MOUSSE_BROWSER_PARTITION
} from './browser/browserPolicy'
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
import { attachDevGuiConsoleCapture, isDevGuiMainEnabled } from './devgui/devGuiMain'
import { startDevGuiPoller } from './devgui/devGuiPoller'

function configureBrowserPopupPolicy(contents: WebContents, parent: BrowserWindow): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedBrowserPopupUrl(url)) return { action: 'deny' }

    // Let Chromium create the requested window itself. This preserves form POST bodies,
    // referrers, opener state, and the shared persistent session used by OAuth flows.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent,
        autoHideMenuBar: true,
        webPreferences: {
          session: contents.session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      }
    }
  })

  contents.on('did-create-window', (child) => {
    child.removeMenu()
    configureBrowserPopupPolicy(child.webContents, parent)
  })
}

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
      // Propagate the packaged version into the long-running daemon and HTTP discovery.
      process.env.MOUSSE_VERSION = app.getVersion()
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
  let startupWindow: BrowserWindow | null = null
  let guiMms: GuiMmsController | null = null
  let settings: SettingsStore | null = null
  let isQuitting = false
  let bootstrapComplete = false
  let bootstrapPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null
  let shutdownComplete = false
  let ipcRegistered = false
  let guiIpc: { syncDaemonTurnSnapshot: (snap: unknown) => void } | null = null
  let windowListenersAttached = false
  let resumeRecoveryAttached = false
  let devGuiPollerStop: (() => void) | null = null

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

  function broadcastToWindows(channel: string, data: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  function createStartupWindow(): void {
    if (startupWindow && !startupWindow.isDestroyed()) return
    startupWindow = new BrowserWindow({
      width: 420,
      height: 180,
      resizable: false,
      frame: false,
      show: true,
      backgroundColor: '#17111f',
      webPreferences: { sandbox: true }
    })
    const html = encodeURIComponent(
      '<!doctype html><meta charset="utf-8"><style>' +
      'html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#17111f;' +
      'color:#eee;font:14px system-ui}.box{text-align:center}.title{font-size:24px;font-weight:650;' +
      'margin-bottom:12px}.status{color:#b9afc4}</style>' +
      '<div class="box"><div class="title">Mousse</div><div class="status">Starting workspace service...</div></div>'
    )
    void startupWindow.loadURL(`data:text/html;charset=utf-8,${html}`)
    startupWindow.on('closed', () => { startupWindow = null })
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
    // Native acrylic forces a permanent full-window compositor surface. Mousse
    // previously stacked dozens of CSS-filter layers on top of it, making GPU
    // memory scale badly with agent/chat DOM size. Use opaque themed surfaces.
    const useAcrylic = false

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
      startupWindow?.close()
      if (settings) refreshWindowChrome(mainWindow, settings)
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
      // Enforce browser isolation regardless of attributes supplied by the renderer.
      delete webPreferences.preload
      webPreferences.partition = MOUSSE_BROWSER_PARTITION
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      params.useragent = session.fromPartition(MOUSSE_BROWSER_PARTITION).getUserAgent()
    })
    mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
      configureBrowserPopupPolicy(guest, mainWindow!)
    })

    attachContextMenu(mainWindow.webContents, () => mainWindow)
    attachZoomShortcuts(mainWindow.webContents)
    // Dev-only: buffer the renderer console so Mousse tools can read it.
    if (isDevGuiMainEnabled()) attachDevGuiConsoleCapture(mainWindow.webContents)

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

      // Local settings for window chrome only — not MMS ownership. Never
      // persist: this conf is loaded once and its channels/scheduled sections go
      // stale; a whole-file write from here would stomp daemon-owned changes.
      const config = MousseConfigStore.load(homeDir, { persist: false })
      settings = new SettingsStore(config)

      // Give Start Menu launches immediate visual feedback while a cold daemon
      // starts. Unsigned packaged binaries may be delayed by antivirus scanning.
      createStartupWindow()

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
        guiIpc = registerGuiIpc(
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

      await bootstrapPresentation(guiMms, presentation, broadcastToWindows, {
        onTurnSnapshot: (snap) => guiIpc?.syncDaemonTurnSnapshot(snap)
      })

      createWindow()
      // Dev-only: serve self-inspection tool requests from the daemon
      // (screenshot / console / reload / devtools / evaluate).
      if (isDevGuiMainEnabled() && !devGuiPollerStop) {
        devGuiPollerStop = startDevGuiPoller(guiMms, () => mainWindow)
      }
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
        if (devGuiPollerStop) {
          devGuiPollerStop()
          devGuiPollerStop = null
        }
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
      const browserSession = session.fromPartition(MOUSSE_BROWSER_PARTITION)
      browserSession.setUserAgent(browserCompatibleUserAgent(browserSession.getUserAgent(), app.name))
      return bootstrap()
    })
    .catch((error) => {
      console.error('Failed to start Mousse:', error)
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('Mousse could not finish starting', message)
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
