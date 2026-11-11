import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdaterBackend } from './DesktopUpdater'

// Adapters over electron-updater internals (6.x), kept free of Electron so they can be tested against a fake.

/**
 * electron-updater's `quitAndInstall` returns nothing, and does nothing when an earlier call is still marked as
 * running. This reports whether the call launched the installer, from `install()`, which it calls.
 */
export function reportInstallerLaunch(autoUpdater: object): void {
  const updater = autoUpdater as unknown as {
    install: (isSilent?: boolean, isForceRunAfter?: boolean) => boolean
    quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
  }
  if (typeof updater.install !== 'function') return
  const install = updater.install.bind(autoUpdater)
  const quitAndInstall = updater.quitAndInstall.bind(autoUpdater)
  let launched = false
  updater.install = (isSilent, isForceRunAfter) => (launched = install(isSilent, isForceRunAfter))
  ;(updater as unknown as { quitAndInstall: UpdaterBackend['quitAndInstall'] }).quitAndInstall = (isSilent, isForceRunAfter) => {
    launched = false
    quitAndInstall(isSilent, isForceRunAfter)
    return launched
  }
}

/**
 * Whether electron-updater's download folder still holds the installer of `version` (every installer's name carries
 * its version, such as `Mousse.Setup.<version>.exe`). Downloading it again then only checks its hash.
 */
export async function isDownloadCached(autoUpdater: object, version: string): Promise<boolean> {
  try {
    const helper = await (autoUpdater as unknown as { getOrCreateDownloadHelper(): Promise<{ cacheDirForPendingUpdate: string }> }).getOrCreateDownloadHelper()
    const info = JSON.parse(readFileSync(join(helper.cacheDirForPendingUpdate, 'update-info.json'), 'utf8')) as { fileName?: unknown }
    if (typeof info.fileName !== 'string' || !info.fileName.includes(version)) return false
    return existsSync(join(helper.cacheDirForPendingUpdate, info.fileName))
  } catch {
    return false
  }
}
