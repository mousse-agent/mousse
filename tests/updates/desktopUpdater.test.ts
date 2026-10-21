import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  DesktopUpdater,
  FIRST_CHECK_DELAY_MS,
  FOCUS_CHECK_MIN_GAP_MS,
  type UpdaterBackend
} from '../../src/main/updates/DesktopUpdater'
import { updaterRecordFile, type UpdaterRecord, type UpdaterRecordStore } from '../../src/main/updates/updaterRecord'
import type { UpdateState } from '../../src/shared/updates'

type Listener = (value: never) => void

class FakeBackend implements UpdaterBackend {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = false
  allowDowngrade = true
  fullChangelog = false
  channel: string | null = null
  checks = 0
  next: Awaited<ReturnType<UpdaterBackend['checkForUpdates']>> | Error = null
  downloadResult: Promise<unknown> = Promise.resolve([])
  installs: Array<[boolean | undefined, boolean | undefined]> = []
  installError: Error | undefined
  /** Reported after quitAndInstall returns, as a failed installer spawn is. */
  lateInstallError: Error | undefined
  private listeners = new Map<string, Listener[]>()

  async checkForUpdates() {
    this.checks += 1
    if (this.next instanceof Error) throw this.next
    return this.next
  }
  downloadUpdate() {
    return this.downloadResult
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter])
    if (this.installError) this.emit('error', this.installError)
    const late = this.lateInstallError
    if (late) queueMicrotask(() => this.emit('error', late))
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never)
  }
  offer(version: string, releaseNotes?: string, releaseName?: string) {
    this.next = { isUpdateAvailable: true, updateInfo: { version, releaseNotes, ...(releaseName ? { releaseName } : {}) } }
  }
}

function memoryStore(initial: UpdaterRecord = {}): UpdaterRecordStore & { record: UpdaterRecord } {
  return {
    record: initial,
    read() { return this.record },
    write(record) { this.record = record }
  }
}

function setup(options: { version?: string; store?: ReturnType<typeof memoryStore>; disabledReason?: string; prepareInstall?: () => Promise<void> } = {}) {
  vi.useFakeTimers()
  const backend = new FakeBackend()
  const store = options.store ?? memoryStore()
  const states: UpdateState[] = []
  const hooks = { prepared: 0, recovered: 0 }
  const updater = new DesktopUpdater({
    currentVersion: options.version ?? '0.1.2-nightly.20261021.2',
    repositoryUrl: 'https://github.com/mousse-agent/mousse',
    ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
    store,
    loadBackend: async () => backend,
    prepareInstall: options.prepareInstall ?? (async () => { hooks.prepared += 1 }),
    recoverInstall: async () => { hooks.recovered += 1 },
    onState: (state) => states.push(state),
    now: () => Date.now(),
    random: () => 0.5
  })
  return { backend, store, states, hooks, updater }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DesktopUpdater', () => {
  it('waits before the first check, follows the build channel and never downloads on its own', async () => {
    const { backend, updater } = setup()
    updater.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(backend.checks).toBe(0)
    backend.offer('0.1.2-nightly.20261022.3', '<ul><li>fix: a</li></ul>')
    await vi.advanceTimersByTimeAsync(1)
    expect(backend.checks).toBe(1)
    expect(backend).toMatchObject({ channel: 'nightly', allowPrerelease: true, fullChangelog: true, allowDowngrade: false, autoDownload: false, autoInstallOnAppQuit: false })
    expect(updater.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '0.1.2-nightly.20261022.3',
      releaseNotes: [{ version: '0.1.2-nightly.20261022.3', items: ['fix: a'], totalItems: 1 }]
    })
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(backend.checks).toBe(2)
    updater.dispose()
  })

  it('keeps background failures quiet and backs off, but reports a failed check the user asked for', async () => {
    const { backend, updater } = setup()
    backend.next = new Error('net::ERR_INTERNET_DISCONNECTED\nstack')
    updater.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(updater.getState().phase).toBe('idle')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(backend.checks).toBe(2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(backend.checks).toBe(2)
    await updater.check(true)
    expect(updater.getState()).toMatchObject({ phase: 'error', error: { message: 'net::ERR_INTERNET_DISCONNECTED', during: 'check' } })
    updater.dispose()
  })

  it('treats a release without update files as up to date', async () => {
    const { backend, updater } = setup({ version: '0.1.2' })
    backend.next = Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
    await updater.check(true)
    expect(backend).toMatchObject({ channel: 'latest', allowPrerelease: false, allowDowngrade: false })
    expect(updater.getState().phase).toBe('up-to-date')
    updater.dispose()
  })

  it('checks on focus only when the last check is old enough', async () => {
    const { backend, updater } = setup()
    updater.noteFocus()
    await vi.advanceTimersByTimeAsync(0)
    expect(backend.checks).toBe(0)
    await updater.check()
    updater.noteFocus()
    await vi.advanceTimersByTimeAsync(0)
    expect(backend.checks).toBe(1)
    vi.setSystemTime(Date.now() + FOCUS_CHECK_MIN_GAP_MS)
    updater.noteFocus()
    await vi.advanceTimersByTimeAsync(0)
    expect(backend.checks).toBe(2)
    updater.dispose()
  })

  it('throttles download progress and keeps a downloaded update instead of checking again', async () => {
    const { backend, states, updater } = setup()
    backend.offer('0.1.2-nightly.20261022.3')
    await updater.check()
    let finish!: () => void
    backend.downloadResult = new Promise<void>((resolve) => { finish = resolve })
    const download = updater.download()
    await vi.advanceTimersByTimeAsync(0)
    const before = states.length
    for (const percent of [1.2, 2.5, 3.9]) backend.emit('download-progress', { percent })
    expect(states.length).toBe(before)
    vi.setSystemTime(Date.now() + 1_000)
    backend.emit('download-progress', { percent: 40.6 })
    expect(states.at(-1)!.downloadPercent).toBe(40)
    finish()
    await download
    expect(updater.getState()).toMatchObject({ phase: 'downloaded', downloadPercent: 100 })
    await updater.check(true)
    expect(backend.checks).toBe(1)
    updater.dispose()
  })

  it('records the install, stops the service, then installs silently and restarts', async () => {
    const { backend, store, hooks, updater } = setup()
    backend.offer('0.1.2-nightly.20261022.3')
    await updater.check()
    await updater.download()
    await updater.install()
    expect(hooks.prepared).toBe(1)
    expect(backend.installs).toEqual([[true, true]])
    expect(store.record.install).toMatchObject({ from: '0.1.2-nightly.20261021.2', to: '0.1.2-nightly.20261022.3' })
    expect(updater.getState().phase).toBe('installing')
    updater.dispose()
  })

  it.each([
    ['the service does not stop', async () => { throw new Error('The background service did not stop') }, undefined],
    ['the installer fails to start', undefined, new Error('spawn EACCES')]
  ])('recovers when %s and keeps the download for a retry', async (_case, prepareInstall, installError) => {
    const { backend, store, hooks, updater } = setup(prepareInstall ? { prepareInstall } : {})
    backend.offer('0.1.2-nightly.20261022.3')
    if (installError) backend.installError = installError
    await updater.check()
    await updater.download()
    await updater.install()
    await vi.advanceTimersByTimeAsync(0)
    expect(hooks.recovered).toBe(1)
    expect(store.record.install).toBeUndefined()
    expect(updater.getState()).toMatchObject({ phase: 'downloaded', error: { during: 'install' } })
    updater.dispose()
  })

  it('keeps the install record when the installer fails while Mousse is already quitting', async () => {
    const { backend, store, hooks, updater } = setup()
    backend.offer('0.1.2-nightly.20261022.3')
    backend.lateInstallError = new Error('spawn ENOENT')
    await updater.check()
    await updater.download()
    await updater.install()
    await vi.advanceTimersByTimeAsync(0)
    expect(hooks.recovered).toBe(0)
    expect(store.record.install).toMatchObject({ to: '0.1.2-nightly.20261022.3' })
    expect(updater.getState().phase).toBe('installing')
    updater.dispose()
  })

  it('keeps an offered update on screen through a failed check the user asked for', async () => {
    const { backend, states, updater } = setup()
    backend.offer('0.1.2-nightly.20261022.3')
    await updater.check()
    backend.next = new Error('getaddrinfo ENOTFOUND github.com')
    const before = states.length
    await updater.check(true)
    expect(states.slice(before).map((state) => state.phase)).not.toContain('checking')
    expect(updater.getState()).toMatchObject({ phase: 'available', availableVersion: '0.1.2-nightly.20261022.3' })
    updater.dispose()
  })

  it('drops stable notes that belong to another release', async () => {
    const { backend, updater } = setup({ version: '0.1.2' })
    backend.offer('0.1.3', '<ul><li>a nightly change</li></ul>', 'Mousse 0.1.4-nightly.20261101.9')
    await updater.check()
    expect(updater.getState().releaseNotes).toEqual([])
    backend.offer('0.1.3', '<ul><li>stable change</li></ul>', 'Mousse v0.1.3')
    await updater.check()
    expect(updater.getState().releaseNotes[0]!.items).toEqual(['stable change'])
    updater.dispose()
  })

  it('counts a failed background check, so focus checks resume after starting offline', async () => {
    const { backend, updater } = setup()
    backend.next = new Error('offline')
    await updater.check()
    expect(updater.getState().lastCheckedAt).toBeDefined()
    backend.offer('0.1.2-nightly.20261022.3')
    vi.setSystemTime(Date.now() + FOCUS_CHECK_MIN_GAP_MS)
    updater.noteFocus()
    await vi.advanceTimersByTimeAsync(0)
    expect(updater.getState().phase).toBe('available')
    updater.dispose()
  })

  it.each([
    ['still on the old version', '0.1.2-nightly.20261021.2', '0.1.2-nightly.20261022.3'],
    ['on the new version', '0.1.2-nightly.20261022.3', undefined]
  ])('after an install, a launch %s reports whether it applied', (_case, version, notApplied) => {
    const store = memoryStore({ channel: 'stable', install: { from: '0.1.2-nightly.20261021.2', to: '0.1.2-nightly.20261022.3', at: 1 } })
    const { updater } = setup({ version, store })
    expect(updater.getState().notAppliedVersion).toBe(notApplied)
    expect(updater.getState().channel).toBe('stable')
    expect(store.record).toEqual({ channel: 'stable' })
  })

  it('switching channel saves the choice and checks the new channel without downgrading', async () => {
    const { backend, store, updater } = setup()
    await updater.check()
    backend.next = { isUpdateAvailable: false, updateInfo: { version: '0.1.1' } }
    await updater.setChannel('stable')
    expect(store.record.channel).toBe('stable')
    expect(backend).toMatchObject({ channel: 'latest', allowPrerelease: false, allowDowngrade: false, fullChangelog: false })
    expect(updater.getState()).toMatchObject({ channel: 'stable', phase: 'up-to-date' })
    updater.dispose()
  })

  it('does nothing when disabled', async () => {
    const { backend, updater } = setup({ disabledReason: 'Updates on macOS need a signed build.' })
    updater.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 2)
    await updater.check(true)
    expect(backend.checks).toBe(0)
    expect(updater.getState()).toMatchObject({ phase: 'disabled', disabledReason: 'Updates on macOS need a signed build.' })
  })
})

describe('updaterRecordFile', () => {
  let directory: string | undefined
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('round-trips the record and reads a missing or damaged file as empty', () => {
    directory = mkdtempSync(join(tmpdir(), 'mousse-updates-'))
    const path = join(directory, 'nested', 'updates.json')
    const store = updaterRecordFile(path)
    expect(store.read()).toEqual({})
    store.write({ channel: 'nightly', install: { from: 'a', to: 'b', at: 2 } })
    expect(store.read()).toEqual({ channel: 'nightly', install: { from: 'a', to: 'b', at: 2 } })
    writeFileSync(path, '{"channel":"beta","install":{"from":1}}')
    expect(store.read()).toEqual({})
    writeFileSync(path, 'not json')
    expect(store.read()).toEqual({})
  })
})
