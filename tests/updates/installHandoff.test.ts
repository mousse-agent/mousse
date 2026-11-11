import { afterEach, describe, expect, it } from 'vitest'
import { DesktopUpdater, type UpdaterBackend } from '../../src/main/updates/DesktopUpdater'
import { isUpdateInstalling, setUpdateInstalling } from '../../src/main/updates/installGate'
import { prepareUpdateInstall, recoverUpdateInstall, type ServiceStopOutcome } from '../../src/main/updates/installHandoff'
import type { UpdaterRecord } from '../../src/main/updates/updaterRecord'

/** One quit-and-install, with the service, the install folder and the installer faked; `log` records the order. */
function handoff(options: { stopOutcome?: ServiceStopOutcome; folderError?: Error } = {}) {
  const log: string[] = []
  const controller = {
    stopForInstall: async () => { log.push('controller stopped for install') },
    resumeAfterInstall: () => { log.push('controller resumed') },
    start: async () => { log.push('controller started') }
  }
  const listeners: Array<(error: Error) => void> = []
  const backend: UpdaterBackend = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    fullChangelog: false,
    channel: null,
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.1.3-nightly.20261111.64' } }),
    downloadUpdate: async () => [],
    quitAndInstall: () => { log.push(`quitAndInstall (installing: ${isUpdateInstalling()})`) },
    on: (event: string, listener: (value: never) => void) => {
      if (event === 'error') listeners.push(listener as (error: Error) => void)
      return backend
    }
  }
  let record: UpdaterRecord = {}
  const updater = new DesktopUpdater({
    currentVersion: '0.1.3-nightly.20261110.57',
    repositoryUrl: 'https://github.com/mousse-agent/mousse',
    store: { read: () => record, write: (next) => { record = next } },
    loadBackend: async () => backend,
    prepareInstall: () => prepareUpdateInstall({
      controller,
      stopService: async () => {
        log.push('service asked to stop')
        await new Promise((resolve) => setTimeout(resolve, 20))
        log.push('service exited')
        return options.stopOutcome ?? { kind: 'stopped' }
      },
      freeInstallFolder: async () => {
        log.push('install folder checked')
        if (options.folderError) throw options.folderError
      }
    }),
    recoverInstall: () => recoverUpdateInstall({ controller }),
    onState: () => undefined
  })
  return { log, updater }
}

afterEach(() => setUpdateInstalling(false))

describe('quit and install', () => {
  it('stops the window client, waits for the service to exit and frees the install folder before the installer runs', async () => {
    const { log, updater } = handoff()
    await updater.check()
    await updater.download()
    await updater.install()
    expect(log).toEqual([
      'controller stopped for install',
      'service asked to stop',
      'service exited',
      'install folder checked',
      'quitAndInstall (installing: true)'
    ])
    // Mousse is quitting for the installer: nothing may start the service again.
    expect(isUpdateInstalling()).toBe(true)
    expect(updater.getState().phase).toBe('installing')
    updater.dispose()
  })

  it('refuses to start the installer while processes still run from the install folder, and carries on', async () => {
    const { log, updater } = handoff({ folderError: new Error('Mousse processes are still running from the install folder (300), so the update was not installed.') })
    await updater.check()
    await updater.download()
    await updater.install()
    expect(log.some((line) => line.startsWith('quitAndInstall'))).toBe(false)
    expect(log.slice(-2)).toEqual(['controller resumed', 'controller started'])
    expect(isUpdateInstalling()).toBe(false)
    expect(updater.getState()).toMatchObject({ phase: 'downloaded', error: { during: 'install', message: expect.stringContaining('still running from the install folder') } })
    updater.dispose()
  })

  it('does not go on to the install folder or the installer when the service does not exit in time', async () => {
    const { log, updater } = handoff({ stopOutcome: { kind: 'timeout' } })
    await updater.check()
    await updater.download()
    await updater.install()
    expect(log).not.toContain('install folder checked')
    expect(log.some((line) => line.startsWith('quitAndInstall'))).toBe(false)
    expect(isUpdateInstalling()).toBe(false)
    updater.dispose()
  })
})
