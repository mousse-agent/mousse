import { attachLinuxWindowShape } from './linuxWindowShape'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell, type WebContents } from 'electron'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { WarmStartCache } from './warmStartCache'

import { detectCliMode, stripCliModeArgs } from '../cli/cliLaunch'
import { configureElectronContext, configureWindowlessElectron, finishElectronCli } from '../cli/electronContext'
import { isChatgptTokenArgv } from '../cli/fastpath/chatgptToken'
import { isSshProxyArgv } from '../cli/fastpath/sshProxy'
import { resolveMousseHome } from '../cli/paths'
import { stopRunningDaemon } from '../cli/daemonShutdown'
import { canonicalizeHome, SERVICE_STOP_TIMEOUT_MS } from '../cli/mmsRuntime'
import { MousseConfigStore } from '../mms/config/MousseConfigStore'
import { SettingsStore } from '../mms/settings/SettingsStore'
import { GuiMmsController } from './mms/GuiMmsController'
import { stopServiceForQuit } from './mms/stopServiceForQuit'
import { createTrayQuit } from './trayQuit'
import { GuiConnectionLog, logErrorReferences } from './mms/guiConnectionLog'
import { registerRendererErrorIpc, RendererErrorLog } from './diagnostics/rendererErrorLog'
import { PresentationState } from './mms/PresentationState'
import {
  attachWindowListeners,
  getWindowShortcuts,
  registerGuiIpc
} from './ipc/registerGuiIpc'
import { isAppletWebviewSource } from './applets/AppletRuntimeManager'
import { adoptAppletWebview, attachAppletWebview } from './applets/registerAppletIpc'
import { MOUSSE_MEDIA_SCHEME_PRIVILEGES } from './ipc/mediaStream'
import { registerFontIpc } from './fonts/registerFontIpc'
import { appearanceUsesAcrylic, normalizeAppearance } from '../shared/settings'
import { surfaceToWindowBackground } from '../shared/accentPalette'
import { appearanceSurfaceBase } from '../shared/themeSurfaces'
import { startupAppearanceArgument } from '../shared/startupAppearance'
import { homeFolderArgument } from '../shared/homeFolderArgument'
import { REMOTE_UPDATE_APP_METHODS } from '../shared/remoteUpdates'
import { readStartupAppearance } from './startupAppearance'
import { refreshWindowChrome } from './windowsChrome'
import { MAC_VIBRANCY } from './windowMaterial'
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
import { startDesktopUpdates, startRemoteUpdateAgent } from './updates'
import type { RemoteUpdateAgent } from './updates/remoteUpdateAgent'
import { freeInstallFolder, listInstallFolderProcesses } from './updates/installFolder'
import { INSTALL_QUIT_DEADLINE_MS } from './updates/installGate'
import { prepareUpdateInstall, recoverUpdateInstall } from './updates/installHandoff'
import type { DesktopUpdater } from './updates/DesktopUpdater'
import { setupApplicationMenu } from './applicationMenu'
import { attachZoomShortcuts } from './zoomShortcuts'
import { attachMenuShortcutGate } from './menu/menuShortcutGate'
import { attachGuestShortcuts, clearGuestShortcuts } from './menu/guestShortcutForward'
import { openExternalSafely } from './safeExternalUrl'
import { attachDevGuiConsoleCapture, isDevGuiMainEnabled } from './devgui/devGuiMain'
import { startDevGuiPoller } from './devgui/devGuiPoller'
import { configureLinuxGraphics, configureLinuxVsync, configureLinuxWindowing, linuxTransparencyOptions } from './linuxRendering'
import { addToSwitchList, KEEP_GPU_PROGRAMS_FEATURE } from '../shared/chromiumSwitches'
import { watchKeepAwake } from './keepAwake'
import { createServiceTray, usesServiceTray } from './serviceTray'
import { attachPairLinks, PAIR_LINK_IPC } from './pairLink'

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
// Codex runs the ChatGPT token command for every token it needs: it answers before Electron is
// ready, without the CLI's module graph, a vault context or a dock icon.
const isChatgptTokenCommand = isCliMode && isChatgptTokenArgv(electronCliArgv())
// The editor proxy (`net ssh-proxy`) is started by an editor's `ssh` on every reconnect, and answers the same way.
// The launchers run it as a script of its own when they can (`out/cli/ssh-proxy.js`); this is the way in when
// they cannot.
const isSshProxyCommand = isCliMode && isSshProxyArgv(electronCliArgv())
if (!isChatgptTokenCommand && !isSshProxyCommand) configureElectronContext(app, isCliMode ? electronCliArgv() : [])
// A CLI command or the daemon opens no window: no GPU or network service process for it.
if (isCliMode) configureWindowlessElectron(app)

if (isChatgptTokenCommand) {
  app.dock?.hide()
  void import('../cli/fastpath/chatgptToken')
    .then(({ runChatgptToken }) => runChatgptToken(electronCliArgv()))
    .then((code) => app.exit(code), () => app.exit(1))
} else if (isSshProxyCommand) {
  app.dock?.hide()
  void import('../cli/fastpath/sshProxy')
    .then(({ runSshProxy }) => runSshProxy(electronCliArgv()))
    .then((code) => app.exit(code), () => app.exit(1))
} else if (isCliMode) {
  // Packaged / dual-mode headless CLI — no GUI, no single-instance lock (GUI may already be open).
  void app.whenReady().then(async () => {
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
/** The longest a quit waits for the warm start file to be written. */
const WARM_START_QUIT_WAIT_MS = 500

function startGuiApp(): void {
  if (configureLinuxWindowing(app, process.platform, process.env)) return
  configureLinuxGraphics(app, process.platform, process.env)
  configureLinuxVsync(app, process.platform, process.env)
  // Keeps compiled WebGL programs (the bot face shader) on disk between launches; see the constant.
  addToSwitchList(app.commandLine, 'enable-features', KEEP_GPU_PROGRAMS_FEATURE)
  // Allows streamed byte-range video playback over `mousse-media://` without buffering files whole in RAM.
  protocol.registerSchemesAsPrivileged([MOUSSE_MEDIA_SCHEME_PRIVILEGES])
  let mainWindow: BrowserWindow | null = null
  let guiMms: GuiMmsController | null = null
  let connectionLog: GuiConnectionLog | undefined
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
  let desktopUpdater: DesktopUpdater | null = null
  let remoteUpdateAgent: RemoteUpdateAgent | null = null
  let serviceTray: import('electron').Tray | null = null
  let mousseHome: string | null = null
  /** What each profile's window last showed; read once here, written in the background (see WarmStartCache). */
  let warmStart: WarmStartCache | null = null
  /** Set by the tray's Quit: this quit also stops the background service. */
  let stopServiceOnQuit = false

  const browserView = new BrowserViewManager()
  const presentation = new PresentationState()

  const gotSingleInstanceLock = app.requestSingleInstanceLock()

  if (!gotSingleInstanceLock) {
    app.quit()
    return
  }

  // `mousse://pair` links (design 1b §5.2): the launch argv, a second instance's argv, and macOS `open-url`.
  const pairLinks = attachPairLinks({
    app,
    ipc: ipcMain,
    argv: process.argv,
    env: process.env,
    notify: () => {
      if (isQuitting || quitAndStopService.closing) return
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.webContents.send(PAIR_LINK_IPC.arrived)
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      } else if (app.isReady()) openWindowFromBackground()
    }
  })

  app.on('second-instance', (_event, argv) => {
    // Quitting: nothing comes back on screen.
    if (isQuitting || quitAndStopService.closing) return
    if (pairLinks.fromArgv(argv)) return
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      openWindowFromBackground()
    }
  })

  function openWindowFromBackground(): void {
    if (isQuitting) return
    if (bootstrapComplete && guiMms) {
      void createWindow().catch((error) => console.error('Failed to create Mousse window:', error))
    } else {
      void bootstrap()
    }
  }

  /** The tray's way to end everything: Mousse goes at once and its background service stops itself. */
  const quitAndStopService = createTrayQuit({
    windows: () => BrowserWindow.getAllWindows(),
    isQuitting: () => isQuitting,
    destroyTray: () => {
      serviceTray?.destroy()
      serviceTray = null
    },
    quit: () => {
      stopServiceOnQuit = true
      void beginQuit()
    }
  })

  /**
   * An update install does not start once the tray's quit began: the installer would start Mousse
   * again after the person stopped it. While the tray's quit is still closing windows, the installer
   * waits for it and starts only if a window kept Mousse open.
   */
  async function installUnlessQuitting(prepare: () => Promise<void>): Promise<void> {
    if (stopServiceOnQuit) throw new Error('Mousse is quitting.')
    await prepare()
    if (stopServiceOnQuit || await quitAndStopService.decided()) throw new Error('Mousse is quitting.')
  }

  function ensureServiceTray(): void {
    if (serviceTray || !usesServiceTray()) return
    const iconPath = getAppIconPath()
    if (!iconPath) return
    try {
      serviceTray = createServiceTray(iconPath, {
        open: openWindowFromBackground,
        quitAndStop: quitAndStopService
      })
    } catch (error) {
      console.error('Tray icon could not start:', error instanceof Error ? error.message : String(error))
    }
  }

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
    // The native material (Windows acrylic, macOS vibrancy, KDE blur behind) supplies
    // the blur; renderer surfaces only tint the glass.
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
            trafficLightPosition: { x: 14, y: 13 },
            ...(useAcrylic ? { vibrancy: MAC_VIBRANCY } : {})
          }
        : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        // Lets the local speech models run ONNX Runtime on several threads. The window is not
        // cross-origin isolated (it loads from file:// and embeds webviews), so this enables
        // SharedArrayBuffer for this window and its workers only: webview guests and other
        // windows do not inherit it, unlike the app-wide `enable-features` switch.
        enableBlinkFeatures: 'SharedArrayBuffer',
        additionalArguments: [startupAppearanceArgument(appearance), homeFolderArgument(homedir())]
      }
    })

    mainWindow.on('close', () => console.info('[window] Main window close event'))
    attachLinuxWindowShape(mainWindow)

    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
      if (settings) refreshWindowChrome(mainWindow, settings)
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
      void openExternalSafely((url) => shell.openExternal(url), details.url, 'windowOpen')
      return { action: 'deny' }
    })

    mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      // An applet page goes to its applet's own session, or nowhere; never the browser's path.
      if (isAppletWebviewSource(params.src)) {
        if (!mainWindow || !attachAppletWebview(mainWindow.webContents, webPreferences, params)) event.preventDefault()
        return
      }
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
      delete webPreferences.enableBlinkFeatures
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      params.useragent = session.fromPartition(webPreferences.partition).getUserAgent()
    })
    const browserOwner = mainWindow
    browserOwner.webContents.on('did-attach-webview', (_event, guest) => {
      if (adoptAppletWebview(browserOwner.webContents, guest)) return
      configureBrowserPopupPolicy(guest, browserOwner)
      attachedBrowserHost?.observeGuest(browserOwner.webContents, guest)
      attachGuestShortcuts(guest, browserOwner.webContents)
    })
    const browserOwnerId = browserOwner.webContents.id
    browserOwner.webContents.once('destroyed', () => clearGuestShortcuts(browserOwnerId))

    attachContextMenu(mainWindow.webContents, () => mainWindow)
    attachZoomShortcuts(mainWindow.webContents)
    attachMenuShortcutGate(mainWindow.webContents, () => getWindowShortcuts(browserOwnerId))
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
      mousseHome = homeDir
      const repoRoot =
        process.env.MOUSSE_REPO_ROOT || (app.isPackaged ? homedir() : process.cwd())

      // Local settings for window chrome only — not MMS ownership. Never
      // persist: this conf is loaded once and its scheduled section goes
      // stale; a whole-file write from here would stomp daemon-owned changes.
      // A retry after a failed first window reuses these: IPC is registered once
      // with them, so new ones would leave IPC on a controller nothing starts.
      if (!settings) {
        const config = MousseConfigStore.load(homeDir, { persist: false })
        settings = new SettingsStore(config)
        settings.set({ appearance: readStartupAppearance(homeDir, settings.get().appearance) })
      }

      connectionLog ??= new GuiConnectionLog(homeDir)
      if (!guiMms || !attachedBrowserHost) {
        const controller = new GuiMmsController({ homeDir })
        controller.setConnectionLog(connectionLog)
        // A start after an update shows as a new version here; the restart itself has no other trace in main.
        connectionLog.write('app.start', { version: app.getVersion(), packaged: app.isPackaged, pid: process.pid })
        // Each "Something went wrong … Reference: <id>" main shows can be found here, with its redacted causes.
        logErrorReferences(connectionLog)
        const startedLog = connectionLog
        app.once('will-quit', () => startedLog.flushSync())
        controller.on('error', (error: Error) => {
          console.error('MMS connection failed:', error.message)
        })
        attachedBrowserHost = new AttachedBrowserHost({
          binding: (senderId) => controller.getWindowBindingForSender(senderId),
          request: (sender, method, params) => controller.requestAttachedBrowser(sender, method, params)
        })
        controller.setAttachedBrowserHost(attachedBrowserHost)
        // While the service reports working runs, the computer does not sleep (Settings → General → Threads).
        watchKeepAwake(controller)
        guiMms = controller
      }
      const browserMms = guiMms

      if (!warmStart) {
        warmStart = new WarmStartCache(join(app.getPath('userData'), 'warm-start.json'))
        // Read while the window loads; the window asks for it once its page runs.
        void warmStart.load()
      }

      if (!ipcRegistered) {
        registerFontIpc()
        registerRendererErrorIpc(new RendererErrorLog(homeDir, { connectionLog }))
        registerGuiIpc(
          {
            guiMms,
            presentation,
            settings,
            browserView,
            attachedBrowserHost,
            repoRoot,
            requestAppRestart: () => coordinatedRestart(),
            connectionLog,
            // Development only: see `createDevTurnEndDropper`. An installed build never reads the variable.
            devDropTurnEnd: !app.isPackaged && process.env.MOUSSE_DEV_DROP_TURN_END === '1',
            warmStart
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

      // Before the window, so its first request for update state has a handler. Updates are
      // optional: a failure here must not stop Mousse from opening.
      try {
        desktopUpdater ??= startDesktopUpdates({
          home: homeDir,
          // The installer replaces Mousse.exe, which also hosts the background service.
          prepareInstall: () => installUnlessQuitting(() => prepareUpdateInstall({
            controller: guiMms,
            stopService: () => stopRunningDaemon(canonicalizeHome(homeDir), { reason: 'update', timeoutMs: SERVICE_STOP_TIMEOUT_MS }),
            // Services of other clients or earlier sessions, `mousse-cli` commands and the voice engine run the same
            // files; the installer cannot replace them while they run. A development build's executable is the
            // shared Electron runtime, which other checkouts run too: only an installed build checks its folder.
            freeInstallFolder: async () => {
              if (!app.isPackaged) return
              await freeInstallFolder({
                selfPid: process.pid,
                list: () => listInstallFolderProcesses(dirname(process.execPath)),
                stopService: async (otherHome, timeoutMs) => {
                  await stopRunningDaemon(canonicalizeHome(otherHome), { reason: 'update', timeoutMs })
                },
                kill: (pid) => process.kill(pid)
              })
            }
          })),
          // The installer is running: quit even when a window would hold the quit back.
          onInstallStarted: () => {
            setTimeout(() => app.exit(0), INSTALL_QUIT_DEADLINE_MS).unref()
          },
          runningTurns: async () => {
            if (!guiMms) throw new Error('No service')
            const answer = await guiMms.request<{ runningTurns?: unknown }>(REMOTE_UPDATE_APP_METHODS.turns, {}, 5_000)
            if (!Number.isSafeInteger(answer?.runningTurns) || (answer.runningTurns as number) < 0) throw new Error('No count')
            return answer.runningTurns as number
          },
          recoverInstall: async () => {
            // The tray's quit began: nothing starts again.
            if (stopServiceOnQuit) return
            await recoverUpdateInstall({ controller: guiMms })
            for (const window of BrowserWindow.getAllWindows()) {
              if (!window.isDestroyed()) window.webContents.reload()
            }
          }
        })
        // Update requests from the user's other computers: only while this app runs and can install them.
        if (desktopUpdater && guiMms && !remoteUpdateAgent) remoteUpdateAgent = startRemoteUpdateAgent(guiMms, desktopUpdater)
      } catch (error) {
        console.error('In-app updates could not start:', error instanceof Error ? error.message : String(error))
      }
      // All chrome/IPC handlers must exist before the renderer's first frame.
      // Start the service concurrently; failures reach the profile bootstrap
      // requests and their in-window Retry action rather than a splash/modal.
      // Restore the exact window's chats only after its renderer subscribes.
      await createWindow()
      ensureServiceTray()
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
      // What the windows showed is written while the connection closes; a slow disk never holds the quit.
      const warmStartWritten = Promise.race([
        warmStart?.flush().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, WARM_START_QUIT_WAIT_MS).unref())
      ])
      try {
        if (devGuiPollerStop) {
          devGuiPollerStop()
          devGuiPollerStop = null
        }
        desktopUpdater?.dispose()
        if (stopServiceOnQuit) await stopServiceForQuit(guiMms, mousseHome)
        else if (guiMms) await guiMms.stop()
      } catch (err) {
        console.error('guiMms.stop failed during shutdown:', err)
      }
      guiMms = null
      await warmStartWritten
      serviceTray?.destroy()
      serviceTray = null
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
    // The tray icon keeps the app reachable while the background service runs.
    if (serviceTray && !isQuitting) return
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
