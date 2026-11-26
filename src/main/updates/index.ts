import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { channelForVersion, UPDATE_IPC, type UpdateChannel, type UpdateState } from '../../shared/updates'
import { REMOTE_UPDATE_IPC, remoteUpdateLimits, type RemoteUpdateToast } from '../../shared/remoteUpdates'
import { takeInstallFolderLock } from './installFolderLock'
import { RemoteUpdateAgent, type AgentService } from './remoteUpdateAgent'
import { getAppIconPath } from '../appIcon'
import { installAppImage, startAfterExit } from './appImageInstall'
import { DesktopUpdater, type UpdaterBackend } from './DesktopUpdater'
import { isDownloadCached, reportInstallerLaunch } from './electronUpdaterAdapters'
import { LAUNCHER_ICON_SIZES, launcherIconName, syncLinuxLauncher, type LauncherIcon } from './linuxLauncher'
import { updaterRecordFile } from './updaterRecord'
import { selfUpdateReporter } from '../../mms/updates/selfUpdateReport'

const REPOSITORY_URL = 'https://github.com/mousse-agent/mousse'

/** Why this build cannot update itself, or undefined when it can. */
export function updatesDisabledReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.MOUSSE_DISABLE_UPDATES === '1') return 'Updates are turned off by MOUSSE_DISABLE_UPDATES.'
  if (process.platform === 'darwin') return 'Updates on macOS need a signed build.'
  // MOUSSE_UPDATE_FEED_URL points a development build at a local feed (docs/releases.md).
  if (!app.isPackaged && !env.MOUSSE_UPDATE_FEED_URL) return 'Updates run in installed builds only.'
  if (process.platform === 'linux' && app.isPackaged && !env.APPIMAGE) {
    return 'On Linux, updates work when Mousse runs from its AppImage.'
  }
  return undefined
}

async function loadElectronUpdater(): Promise<UpdaterBackend> {
  const module = (await import('electron-updater')) as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } }
  const autoUpdater = (module.autoUpdater ?? module.default?.autoUpdater) as import('electron-updater').AppUpdater
  autoUpdater.logger = { info: () => undefined, warn: console.warn, error: console.error, debug: () => undefined }
  const feed = process.env.MOUSSE_UPDATE_FEED_URL
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    if (!app.isPackaged) {
      // Installed builds carry resources/app-update.yml; a development build needs one to name
      // its download cache.
      const configPath = join(app.getPath('userData'), 'dev-app-update.yml')
      writeFileSync(configPath, `provider: generic\nurl: ${JSON.stringify(feed)}\nupdaterCacheDirName: mousse-updater-dev\n`)
      autoUpdater.updateConfigPath = configPath
      autoUpdater.forceDevUpdateConfig = true
    }
  }
  if (process.platform === 'linux' && process.env.APPIMAGE) replaceAppImageInstall(autoUpdater)
  else reportInstallerLaunch(autoUpdater)
  const backend = autoUpdater as unknown as UpdaterBackend
  backend.isDownloadCached = (version) => isDownloadCached(autoUpdater, version)
  return backend
}

/**
 * electron-updater's AppImage install removes the running file before the new one is in place,
 * leaves launchers naming the old file, and starts the new copy while this one still holds the
 * single-instance lock, so it quits at once. This install avoids all three.
 */
function replaceAppImageInstall(autoUpdater: import('electron-updater').AppUpdater): void {
  const updater = autoUpdater as unknown as { installerPath: string | null; quitAndInstall: UpdaterBackend['quitAndInstall'] }
  updater.quitAndInstall = (_isSilent, isForceRunAfter) => {
    try {
      const current = process.env.APPIMAGE!
      const downloaded = updater.installerPath
      if (!downloaded) throw new Error('The downloaded update file is missing; download it again.')
      const destination = installAppImage({
        current,
        downloaded,
        onReplaced: (next, previous) => syncLauncher(next, previous)
      })
      if (isForceRunAfter) startAfterExit(process.pid, destination, process.argv.slice(1), process.env)
    } catch (error) {
      autoUpdater.emit('error', error instanceof Error ? error : new Error(String(error)))
      return false
    }
    setImmediate(() => app.quit())
    return true
  }
}

/** This build's icon at every size the launcher installs. */
function launcherIcons(): LauncherIcon[] | undefined {
  const path = getAppIconPath()
  if (!path) return undefined
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return undefined
  const width = image.getSize().width
  return LAUNCHER_ICON_SIZES.map((size) => ({
    size,
    png: size === width ? readFileSync(path) : image.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
}

/** Points the user's Mousse launchers at `appImage` and installs this build's icon. */
function syncLauncher(appImage: string, previousAppImage?: string): void {
  try {
    // During an install the running build is the old one, so its icon waits for the next start.
    const icons = previousAppImage ? undefined : launcherIcons()
    syncLinuxLauncher({
      appImage,
      ...(previousAppImage ? { previousAppImage } : {}),
      iconName: launcherIconName(channelForVersion(app.getVersion())),
      ...(icons ? { icons } : {}),
      env: process.env,
      home: homedir()
    })
  } catch (error) {
    console.warn('The Mousse launcher could not be updated:', error instanceof Error ? error.message : String(error))
  }
}

function broadcast(state: UpdateState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(UPDATE_IPC.state, state)
  }
}

function isChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'nightly'
}

/** How long the update report waits for a window to show before it is written anyway (a start with no window). */
const REPORT_WITHOUT_WINDOW_MS = 30_000

/** Resolves once the app's first window shows, or after `REPORT_WITHOUT_WINDOW_MS` when none does. */
function firstWindowShown(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      app.removeListener('browser-window-created', created)
      resolve()
    }
    const created = (_event: unknown, window: BrowserWindow): void => {
      window.once('show', done)
    }
    const timer = setTimeout(done, REPORT_WITHOUT_WINDOW_MS)
    timer.unref?.()
    if (BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible())) return done()
    app.on('browser-window-created', created)
  })
}

/** Creates the updater, registers its IPC and schedules the first check. */
export function startDesktopUpdates(hooks: {
  /** The Mousse home: the background service there tells other computers whether this app updates itself. */
  home?: string
  prepareInstall: () => Promise<void>
  recoverInstall: () => Promise<void>
  onInstallStarted?: () => void
}): DesktopUpdater {
  // Every start of an installed AppImage keeps its launcher and icon current, updates or not.
  if (process.platform === 'linux' && app.isPackaged && process.env.APPIMAGE) syncLauncher(process.env.APPIMAGE)
  const disabledReason = updatesDisabledReason()
  const report = hooks.home ? selfUpdateReporter(hooks.home, { after: firstWindowShown() }) : undefined
  const updater = new DesktopUpdater({
    currentVersion: app.getVersion(),
    repositoryUrl: REPOSITORY_URL,
    ...(disabledReason ? { disabledReason } : {}),
    store: updaterRecordFile(join(app.getPath('userData'), 'updates.json')),
    loadBackend: loadElectronUpdater,
    prepareInstall: hooks.prepareInstall,
    recoverInstall: hooks.recoverInstall,
    ...(hooks.onInstallStarted ? { onInstallStarted: hooks.onInstallStarted } : {}),
    // One update at a time per install folder, across every home sharing it. A development build's executable is the
    // shared Electron runtime: only an installed build locks its folder.
    ...(app.isPackaged
      ? {
          lock: (purpose: 'download' | 'install') =>
            takeInstallFolderLock(
              { folder: dirname(process.execPath), directory: app.getPath('temp'), staleMs: remoteUpdateLimits().lockStaleMs },
              purpose
            )
        }
      : {}),
    onState: (state) => {
      broadcast(state)
      report?.(state)
    }
  })
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, ...args) => handler(...args))
  }
  handle(UPDATE_IPC.getState, () => updater.getState())
  handle(UPDATE_IPC.check, () => updater.check(true))
  handle(UPDATE_IPC.download, () => updater.download())
  handle(UPDATE_IPC.install, () => updater.install())
  handle(UPDATE_IPC.setChannel, (channel) => {
    if (!isChannel(channel)) throw new Error(`Unknown update channel: ${String(channel)}`)
    return updater.setChannel(channel)
  })
  app.on('browser-window-focus', () => updater.noteFocus())
  updater.start()
  report?.(updater.getState())
  return updater
}

/**
 * Why this app does not take update requests from the user's other computers, or undefined when it does: only an
 * installed build that updates itself from the release feed takes them (never a development feed).
 */
export function remoteUpdatesRefusal(updater: Pick<DesktopUpdater, 'getState'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const state = updater.getState()
  if (state.phase === 'disabled') return state.disabledReason ?? 'Updates are off.'
  if (!app.isPackaged || env.MOUSSE_UPDATE_FEED_URL) return 'Only an installed build takes update requests.'
  return undefined
}

/**
 * Takes update requests from the user's other computers while the service is connected, and shows their countdown
 * in every window (`REMOTE_UPDATE_IPC`), from when its first window shows. Returns null when this app does not take them.
 */
export function startRemoteUpdateAgent(
  service: AgentService & { connectionState: string },
  updater: DesktopUpdater
): RemoteUpdateAgent | null {
  if (remoteUpdatesRefusal(updater)) return null
  let current: RemoteUpdateToast | null = null
  const agent = new RemoteUpdateAgent({
    service,
    updater,
    toast: (toast) => {
      current = toast
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(REMOTE_UPDATE_IPC.toast, toast)
      }
    }
  })
  ipcMain.removeHandler(REMOTE_UPDATE_IPC.get)
  ipcMain.handle(REMOTE_UPDATE_IPC.get, () => current)
  ipcMain.removeHandler(REMOTE_UPDATE_IPC.cancel)
  ipcMain.handle(REMOTE_UPDATE_IPC.cancel, (_event, job: unknown) => {
    if (typeof job === 'string' && job === current?.job) return agent.cancel(job)
    return undefined
  })
  // Registered once the first window shows, so opening the app does no work for it.
  void firstWindowShown().then(() => agent.start(service.connectionState === 'ready'))
  return agent
}
