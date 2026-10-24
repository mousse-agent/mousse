import { app, BrowserWindow, ipcMain } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPDATE_IPC, type UpdateChannel, type UpdateState } from '../../shared/updates'
import { DesktopUpdater, type UpdaterBackend } from './DesktopUpdater'
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
  return autoUpdater as unknown as UpdaterBackend
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
