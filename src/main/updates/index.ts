import { app, BrowserWindow, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { UPDATE_IPC, type UpdateChannel, type UpdateState } from '../../shared/updates'
import { getAppIconPath } from '../appIcon'
import { installAppImage, startAfterExit } from './appImageInstall'
import { DesktopUpdater, type UpdaterBackend } from './DesktopUpdater'
import { syncLinuxLauncher } from './linuxLauncher'
import { updaterRecordFile } from './updaterRecord'

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
  return autoUpdater as unknown as UpdaterBackend
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
      return
    }
    setImmediate(() => app.quit())
  }
}

/** Points the user's Mousse launchers at `appImage` and installs this build's icon. */
function syncLauncher(appImage: string, previousAppImage?: string): void {
  try {
    const iconSource = previousAppImage ? undefined : getAppIconPath()
    syncLinuxLauncher({
      appImage,
      ...(previousAppImage ? { previousAppImage } : {}),
      ...(iconSource ? { iconSource } : {}),
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

/** Creates the updater, registers its IPC and schedules the first check. */
export function startDesktopUpdates(hooks: {
  prepareInstall: () => Promise<void>
  recoverInstall: () => Promise<void>
}): DesktopUpdater {
  // Every start of an installed AppImage keeps its launcher and icon current, updates or not.
  if (process.platform === 'linux' && app.isPackaged && process.env.APPIMAGE) syncLauncher(process.env.APPIMAGE)
  const disabledReason = updatesDisabledReason()
  const updater = new DesktopUpdater({
    currentVersion: app.getVersion(),
    repositoryUrl: REPOSITORY_URL,
    ...(disabledReason ? { disabledReason } : {}),
    store: updaterRecordFile(join(app.getPath('userData'), 'updates.json')),
    loadBackend: loadElectronUpdater,
    prepareInstall: hooks.prepareInstall,
    recoverInstall: hooks.recoverInstall,
    onState: broadcast
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
  return updater
}
