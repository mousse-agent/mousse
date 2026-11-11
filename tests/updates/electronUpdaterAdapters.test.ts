import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isDownloadCached, reportInstallerLaunch } from '../../src/main/updates/electronUpdaterAdapters'
import type { UpdaterBackend } from '../../src/main/updates/DesktopUpdater'

/** electron-updater's BaseUpdater install path, as in 6.x: a second call is ignored until the first one clears. */
class FakeBaseUpdater {
  quitAndInstallCalled = false
  spawned = 0
  install(_isSilent?: boolean, _isForceRunAfter?: boolean): boolean {
    if (this.quitAndInstallCalled) return false
    this.quitAndInstallCalled = true
    this.spawned += 1
    return true
  }
  quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    const installed = this.install(isSilent, isForceRunAfter)
    if (!installed) this.quitAndInstallCalled = false
  }
}

describe('electron-updater adapters', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reports whether quitAndInstall launched the installer', () => {
    const updater = new FakeBaseUpdater()
    reportInstallerLaunch(updater)
    const backend = updater as unknown as Pick<UpdaterBackend, 'quitAndInstall'>
    expect(backend.quitAndInstall(true, true)).toBe(true)
    // The installer failed late and Mousse carried on: electron-updater still marks the first call as running.
    expect(backend.quitAndInstall(true, true)).toBe(false)
    // That ignored call cleared the mark, so the next try launches again.
    expect(backend.quitAndInstall(true, true)).toBe(true)
    expect(updater.spawned).toBe(2)
  })

  it('knows whether the installer of a version is still in the download folder', async () => {
    const pending = mkdtempSync(join(tmpdir(), 'mousse-updater-pending-'))
    dirs.push(pending)
    const updater = { getOrCreateDownloadHelper: async () => ({ cacheDirForPendingUpdate: pending }) }
    expect(await isDownloadCached(updater, '0.1.3-nightly.20261111.64')).toBe(false)
    writeFileSync(join(pending, 'update-info.json'), JSON.stringify({ fileName: 'Mousse.Setup.0.1.3-nightly.20261111.64.exe', sha512: 'x' }))
    expect(await isDownloadCached(updater, '0.1.3-nightly.20261111.64')).toBe(false)
    writeFileSync(join(pending, 'Mousse.Setup.0.1.3-nightly.20261111.64.exe'), 'installer')
    expect(await isDownloadCached(updater, '0.1.3-nightly.20261111.64')).toBe(true)
    expect(await isDownloadCached(updater, '0.1.3-nightly.20261112.65')).toBe(false)
    expect(await isDownloadCached({}, '0.1.3-nightly.20261111.64')).toBe(false)
  })
})
