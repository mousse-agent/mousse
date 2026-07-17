import { app, BrowserWindow, Menu, Tray, shell } from 'electron'
import { homedir } from 'os'
import { join } from 'path'

import { detectCliMode, stripCliModeArgs } from '../cli/cliLaunch'
import { MousseMainService } from '../mms/MousseMainService'
import { ThreadContext } from './data/ThreadContext'
import { registerIpc, attachWindowListeners } from './ipc/registerIpc'
import { themeUsesAcrylic } from '../shared/settings'
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

function startGuiApp(): void {
  let mainWindow: BrowserWindow | null = null
  let threadContext: ThreadContext | null = null
  let mms: MousseMainService | null = null
  let tray: Tray | null = null
  let isQuitting = false

  const browserView = new BrowserViewManager()

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
          isQuitting = true
          app.quit()
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

  function bridgeMmsEvents(): void {
    if (!mms) return

    const bridge = (channel: string, data: unknown): void => {
      broadcastToWindows(channel, data)
    }

    mms.events.on('projects:updated', (data) => bridge('projects:updated', data))
    mms.events.on('threads:updated', (data) => bridge('threads:updated', data))
    mms.events.on('scheduled:updated', (data) => bridge('scheduled:updated', data))
    mms.events.on('scheduled:status', (data) => bridge('scheduled:status', data))
    mms.events.on('channels:updated', (data) => bridge('channels:updated', data))
    mms.events.on('agents:updated', (data) => bridge('agents:updated', data))
    mms.events.on('tasks:updated', (data) => bridge('tasks:updated', data))
  }

  function createWindow(): void {
    if (!mms) return

    const isWindows = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    const theme = mms.settings.get().appearance.theme
    const useAcrylic = isWindows && themeUsesAcrylic(theme)

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
        buildAccentCssVars(mms.settings.get().appearance.accentColor)['--surface-base'] ?? '#1a1228',
        useAcrylic ? 0 : 1
      ),
      ...(isWindows ? { backgroundMaterial: useAcrylic ? ('acrylic' as const) : ('none' as const) } : {}),
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
      refreshWindowChrome(mainWindow, mms!.settings)
    })

    mainWindow.on('close', (event) => {
      const hasActiveJobs = (mms?.scheduled.listJobs().length ?? 0) > 0
      if (!isQuitting && hasActiveJobs) {
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
  }

  async function bootstrap(): Promise<void> {
    const repoRoot = process.env.MOUSSE_REPO_ROOT || (app.isPackaged ? homedir() : process.cwd())

    mms = await MousseMainService.create({
      repoRoot,
      openExternal: (url) => shell.openExternal(url),
      onTerminalEvent: (channel, data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, data)
        }
      }
    })

    bridgeMmsEvents()

    mms.ptyManager.setFocusWindow(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    })

    threadContext = new ThreadContext(
      mms.threads,
      mms.projects,
      mms.orchestrator,
      mms.agents,
      mms.tasks,
      mms.ptyManager,
      mms.worktrees,
      broadcastToWindows
    )

    registerIpc(
      {
        agents: mms.agents,
        tasks: mms.tasks,
        worktrees: mms.worktrees,
        ptyManager: mms.ptyManager,
        macros: mms.macros,
        orchestrator: mms.orchestrator,
        settings: mms.settings,
        providerAuth: mms.providerAuth,
        projectManager: mms.projects,
        threadStore: mms.threads,
        threadContext,
        mcpRegistry: mms.mcpRegistry,
        mcpManager: mms.mcpManager,
        skillsRegistry: mms.skillsRegistry,
        fileService: mms.fileService,
        gitService: mms.gitService,
        browserView,
        scheduledJobs: mms.scheduled,
        lineEditStats: mms.lineEditStats,
        channels: mms.channels
      },
      () => mainWindow
    )

    await threadContext.initialize()
    await mms.start()

    createWindow()
    createTray()

    attachWindowListeners(() => mainWindow, mms.settings)
    attachWindowResumeRecovery(mms.settings)

    const mainTarget = mainWindowLoadTarget()
    registerWindowForResumeRecovery(mainWindow!, mainTarget)
    attachWindowWebContentsRecovery(mainWindow!, mainTarget)
  }

  app.whenReady().then(() => {
    setupApplicationMenu()
    applyAppIcon()
    return bootstrap()
  }).catch((error) => {
    console.error('Failed to start Mousse:', error)
  })

  app.on('window-all-closed', () => {
    const hasActiveJobs = (mms?.scheduled.listJobs().length ?? 0) > 0
    if (process.platform !== 'darwin' && !hasActiveJobs) {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void bootstrap()
    } else {
      mainWindow?.show()
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    threadContext?.saveCurrent()
    void mms?.stop()
    browserView.destroy()
    tray?.destroy()
    tray = null
  })
}
