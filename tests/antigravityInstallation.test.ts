import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import {
  antigravityInstallState, cancelAntigravityInstall, runSharedAntigravityInstall
} from '../src/mms/harness/acp/presets/antigravity/installation'
import { installNativeAntigravity } from '../src/mms/harness/acp/presets/antigravity/nativeInstall'
import { NATIVE_AGENT_NAME, type NativeRelease } from '../src/mms/harness/acp/presets/antigravity/nativeRelease'

// The real install path, with a fake download: nothing here reaches the network.
const payload = Buffer.from('agy executable bytes'.repeat(8))
const assetUrl = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-1/windows-x64/cli_windows_x64.exe'
const release: NativeRelease = { version: '1.5.13', url: assetUrl, format: 'exe', sha512: createHash('sha512').update(payload).digest('hex') }
const homes: string[] = []
const services: AntigravityProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const newHome = () => { const home = mkdtempSync(join(tmpdir(), 'mousse-agy-installation-')); homes.push(home); return home }
/** A download that never produces data until aborted. */
const stalledDownload = (): typeof fetch => (_url, init) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
})
/** Google's feed entry for this computer, then a download that stalls. */
const feedThenStalled = (): typeof fetch => (url, init) => String(url).endsWith('.json')
  ? Promise.resolve(Response.json({ version: release.version, url: release.url, sha512: release.sha512 }))
  : stalledDownload()(url, init)
/** An install that runs until it is cancelled. */
const pending = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('Antigravity install cancelled', 'AbortError')), { once: true })
})

describe('the install shared by an installation', () => {
  it('allows one install per installation and several installations at once, each cancelled through its installation', async () => {
    const home = newHome()
    const first = runSharedAntigravityInstall(home, undefined, undefined, (signal) => pending(signal))
    const firstRejected = expect(first).rejects.toThrow('cancelled')
    await expect(runSharedAntigravityInstall(home, undefined, undefined, (signal) => pending(signal))).rejects.toThrow('already being installed')
    const other = newHome()
    const second = runSharedAntigravityInstall(other, undefined, undefined, (signal) => pending(signal))
    const secondRejected = expect(second).rejects.toThrow('cancelled')
    expect(antigravityInstallState(other).installing).toBe(true)
    expect(cancelAntigravityInstall(home)).toBe(true)
    expect(cancelAntigravityInstall(other)).toBe(true)
    await Promise.all([firstRejected, secondRejected])
    expect(cancelAntigravityInstall(home)).toBe(false)
    expect(antigravityInstallState(home)).toEqual({ installing: false })
  })

  it('reports byte progress of Google\'s download with its fraction, at most once per whole percent', async () => {
    const home = newHome()
    // Four chunks: 25, 50, 75 and 100 percent, the second split in two within the same percent.
    const quarter = payload.length / 4
    const chunks = [payload.subarray(0, quarter), payload.subarray(quarter, quarter + 1), payload.subarray(quarter + 1, 2 * quarter), payload.subarray(2 * quarter, 3 * quarter), payload.subarray(3 * quarter)]
    const chunked: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close() } }), { headers: { 'content-length': String(payload.length) } })
    const reported: Array<[string, number | undefined]> = []
    await installNativeAntigravity(home, {
      release, target: 'windows_amd64', fetch: chunked, freeBytes: () => undefined,
      verify: async () => ({ name: NATIVE_AGENT_NAME, version: '1.5.13' }),
      progress: (message, fraction) => reported.push([message, fraction])
    })
    const bytes = reported.filter(([, fraction]) => fraction !== undefined)
    expect(bytes.map(([, fraction]) => fraction)).toEqual([0.25, 0.5, 0.75, 1])
    expect(bytes[0]![0]).toBe('Downloading 0 MB of 0 MB')
  })
})

describe('Antigravity install events', () => {
  it('allows any number of profiles to listen without a warning', () => {
    const warn = vi.spyOn(process, 'emitWarning')
    const installation = newHome()
    for (let index = 0; index < 20; index++) services.push(new AntigravityProviderService(newHome(), installation, new UserQuestionService()))
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('Antigravity install shared by two profiles', () => {
  function profiles() {
    const installation = newHome()
    const make = () => {
      const service = new AntigravityProviderService(newHome(), installation, new UserQuestionService(), undefined, { native: { target: 'windows_amd64', fetch: feedThenStalled() } })
      services.push(service)
      const progress: string[] = []
      const changed = vi.fn()
      service.hooks.installProgress = (message) => progress.push(message)
      service.hooks.changed = changed
      return { service, progress, changed }
    }
    return { installation, a: make(), b: make(), make }
  }

  it('rejects the second profile and shows both the running install', async () => {
    const { a, b } = profiles()
    const running = a.service.install()
    const rejected = expect(running).rejects.toThrow('Antigravity install cancelled')
    // The feed is read first: the download starts a moment later.
    await vi.waitFor(() => expect(a.progress).toEqual(['Downloading Google Antigravity…']))
    await expect(b.service.install()).rejects.toThrow('Antigravity is already being installed')
    // Every profile sees the download, and the installing flag survives a closed page.
    for (const { service } of [a, b]) {
      expect(await service.cliConfig()).toMatchObject({ installing: true, installProgress: 'Downloading Google Antigravity…' })
    }
    expect(b.service.cancelInstall()).toBe(true)
    await rejected
    expect((await a.service.cliConfig()).installing).toBeUndefined()
  })

  it('says nothing more after the profile that owns the download stops', async () => {
    const { a, b } = profiles()
    const running = a.service.install()
    const rejected = expect(running).rejects.toThrow('Antigravity install cancelled')
    // The feed is read first: the download starts a moment later.
    await vi.waitFor(() => expect(a.progress).toEqual(['Downloading Google Antigravity…']))
    const told = a.changed.mock.calls.length
    expect(told).toBeGreaterThan(0)
    a.service.stop() // aborts its own download
    await rejected
    expect(a.changed).toHaveBeenCalledTimes(told)
    expect(a.progress).toEqual(['Downloading Google Antigravity…'])
    expect(b.changed).toHaveBeenCalledTimes(2) // the other profile still hears the install end
  })

  it('tells every profile when the shared install starts, progresses and ends, and does not tell a stopped one', async () => {
    const { a, b, make } = profiles()
    const stopped = make()
    stopped.service.stop()
    const running = a.service.install()
    const rejected = expect(running).rejects.toThrow('cancelled')
    // The feed is read first: the download starts a moment later.
    await vi.waitFor(() => expect(a.progress).toEqual(['Downloading Google Antigravity…']))
    const told = a.changed.mock.calls.length
    for (const profile of [a, b]) {
      expect(profile.changed).toHaveBeenCalled()
      expect(profile.progress).toEqual(['Downloading Google Antigravity…'])
    }
    expect(b.changed).toHaveBeenCalledTimes(1)
    a.service.cancelInstall()
    await rejected
    // Finished for everyone; the installing profile reports once more, after its own settings changed.
    expect(b.changed).toHaveBeenCalledTimes(2)
    expect(a.changed).toHaveBeenCalledTimes(told + 1)
    expect(stopped.changed).not.toHaveBeenCalled()
  })
})
