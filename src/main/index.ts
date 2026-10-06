import { app, BrowserWindow, dialog, nativeTheme, session, shell, type WebContents } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

import { detectCliMode, stripCliModeArgs } from '../cli/cliLaunch'
import { configureElectronContext, finishElectronCli } from '../cli/electronContext'
import { resolveMousseHome } from '../cli/paths'
import { MousseConfigStore } from '../mms/config/MousseConfigStore'
import { SettingsStore } from '../mms/settings/SettingsStore'
import { FileService } from '../mms/files/FileService'
import { GitService } from '../mms/git/GitService'
import { GuiMmsController } from './mms/GuiMmsController'
import { PresentationState } from './mms/PresentationState'
import {
  attachWindowListeners,
  registerGuiIpc
} from './ipc/registerGuiIpc'
import { appearanceUsesAcrylic, normalizeAppearance } from '../shared/settings'
import { surfaceToWindowBackground } from '../shared/accentPalette'
import { appearanceSurfaceBase } from '../shared/themeSurfaces'
import { startupAppearanceArgument } from '../shared/startupAppearance'
import { readStartupAppearance } from './startupAppearance'
import { refreshWindowChrome } from './windowsChrome'
import { BrowserViewManager } from './browser/BrowserViewManager'
import { AttachedBrowserHost } from './browser/AttachedBrowserHost'
import {
  browserCompatibleUserAgent,
  isAllowedBrowserPopupUrl,
  MOUSSE_BROWSER_PARTITION,
  profileBrowserPartition
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
import { openExternalSafely } from './safeExternalUrl'
import { attachDevGuiConsoleCapture, isDevGuiMainEnabled } from './devgui/devGuiMain'
import { startDevGuiPoller } from './devgui/devGuiPoller'
import { configureLinuxWindowing, linuxTransparencyOptions } from './linuxRendering'

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
configureElectronContext(app, isCliMode ? electronCliArgv() : [])

// Packaged / dual-mode headless CLI — no GUI, no single-instance lock (GUI may already be open).
if (isCliMode) {
  app.whenReady().then(async () => {
    try {
      // Propagate the packaged version into the long-running daemon and HTTP discovery.
      process.env.MOUSSE_VERSION = app.getVersion()
      const { runCliMain } = await import('../cli/runCliMain')
      await runCliMain(electronCliArgv())
      finishElectronCli(app)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      finishElectronCli(app, 1)
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
  if (configureLinuxWindowing(app, process.platform, process.env)) return
  let mainWindow: BrowserWindow | null = null
  let guiMms: GuiMmsController | null = null
  let attachedBrowserHost: AttachedBrowserHost | undefined
  let settings: SettingsStore | null = null
  let isQuitting = false
  let bootstrapComplete = false
  let bootstrapPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null
  let shutdownComplete = false
  let ipcRegistered = false
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

  async function createWindow(): Promise<void> {
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
    // Native acrylic supplies the blur; renderer surfaces only tint the glass.
    const useAcrylic = appearanceUsesAcrylic(appearance)

    mainWindow = new BrowserWindow({
      show: false,
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Mousse',
      icon: getAppIconPath(),
      fullscreenable: false,
      ...linuxTransparencyOptions(process.platform),
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
        appearanceSurfaceBase(appearance, nativeTheme?.shouldUseDarkColors ?? true),
        useAcrylic || process.platform === 'linux' ? 0 : 1
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
        webviewTag: true,
        additionalArguments: [startupAppearanceArgument(appearance)]
      }
    })

    mainWindow.on('close', () => console.info('[window] Main window close event'))
    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
      if (settings) refreshWindowChrome(mainWindow, settings)
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      void openExternalSafely((url) => shell.openExternal(url), details.url, 'windowOpen')
      return { action: 'deny' }
    })

    mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      // Enforce browser isolation regardless of attributes supplied by the renderer.
      delete webPreferences.preload
      const boundProfile = mainWindow
        ? guiMms?.getWindowBindingForSender(mainWindow.webContents.id)?.profileId
        : undefined
      if (!boundProfile) {
        event.preventDefault()
        return
      }
      webPreferences.partition = profileBrowserPartition(boundProfile)
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      params.useragent = session.fromPartition(webPreferences.partition).getUserAgent()
    })
    const browserOwner = mainWindow
    browserOwner.webContents.on('did-attach-webview', (_event, guest) => {
      configureBrowserPopupPolicy(guest, browserOwner)
      attachedBrowserHost?.observeGuest(browserOwner.webContents, guest)
    })

    attachContextMenu(mainWindow.webContents, () => mainWindow)
    attachZoomShortcuts(mainWindow.webContents)
    // Dev-only: buffer the renderer console so Mousse tools can read it.
    if (isDevGuiMainEnabled()) attachDevGuiConsoleCapture(mainWindow.webContents)

    // Paint the actual shell before daemon discovery or profile binding. The
    // trusted IPC wrapper opens this window's session on its initial profile
    // requests; profileReady keeps domain panels and guest creation gated.
    if (process.env.ELECTRON_RENDERER_URL) {
      await browserOwner.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      await browserOwner.loadFile(join(__dirname, '../renderer/index.html'))
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
      settings.set({ appearance: readStartupAppearance(homeDir, settings.get().appearance) })

      guiMms = new GuiMmsController({ homeDir })
      const browserMms = guiMms
      browserMms.on('error', (error: Error) => {
        console.error('MMS connection failed:', error.message)
      })
      attachedBrowserHost = new AttachedBrowserHost({
        binding: (senderId) => browserMms.getWindowBindingForSender(senderId),
        request: (sender, method, params) => browserMms.requestAttachedBrowser(sender, method, params)
      })
      browserMms.setAttachedBrowserHost(attachedBrowserHost)
      const fileService = new FileService()
      const gitService = new GitService()

      if (!ipcRegistered) {
        registerGuiIpc(
          {
            guiMms,
            presentation,
            settings,
            fileService,
            gitService,
            browserView,
            attachedBrowserHost,
            repoRoot,
            requestAppRestart: () => coordinatedRestart()
          },
          () => mainWindow
        )
        ipcRegistered = true
      }

      if (!windowListenersAttached && settings) {
        attachWindowListeners(() => mainWindow, settings)
        windowListenersAttached = true
      }
      if (!resumeRecoveryAttached && settings) {
        attachWindowResumeRecovery(settings)
        resumeRecoveryAttached = true
      }

      // All chrome/IPC handlers must exist before the renderer's first frame.
      // Start the service concurrently; failures reach the profile bootstrap
      // requests and their in-window Retry action rather than a splash/modal.
      // Restore the exact window's chats only after its renderer subscribes.
      await createWindow()
      const chromeSettings = settings
      void browserMms.start().then(async () => {
        if (isQuitting) return
        if (isDevGuiMainEnabled() && !devGuiPollerStop) {
          devGuiPollerStop = startDevGuiPoller(browserMms, () => mainWindow)
        }
        const snap = await browserMms.request<{ settings: import('../shared/settings').MousseSettings }>('settings.get')
        if (isQuitting) return
        chromeSettings.set(snap.settings)
        if (mainWindow && !mainWindow.isDestroyed()) refreshWindowChrome(mainWindow, chromeSettings)
      }).catch((error: unknown) => {
        console.error('Workspace service startup failed:', error instanceof Error ? error.message : String(error))
      })
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
        void createWindow().catch((error) => {
          console.error('Failed to create Mousse window:', error)
        })
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
