import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { AntigravityProviderService } from '../src/mms/providers/antigravity/AntigravityProviderService'
import {
  antigravityInstallState, cancelAntigravityInstall, installAntigravity, installedAntigravityBinary, releaseDirectory, type Release
} from '../src/mms/providers/antigravity/installation'

// The real install path, with a fake download: nothing here reaches the network.
const payload = Buffer.from('not-really-a-zip'.repeat(8))
const release: Release = {
  url: 'https://dl.google.com/fixture.zip', archiveSize: payload.length, agentSize: 1, helperSize: 1,
  sha256: createHash('sha256').update(payload).digest('hex')
}
const homes: string[] = []
const services: AntigravityProviderService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const newHome = () => { const home = mkdtempSync(join(tmpdir(), 'mousse-agy-installation-')); homes.push(home); return home }
const completeDownload = (): typeof fetch => async () => new Response(payload)
/** A download that never produces data until aborted. */
const stalledDownload = (): typeof fetch => (_url, init) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
})
const leftovers = (home: string) => { const root = dirname(releaseDirectory(home)); return existsSync(root) ? readdirSync(root) : [] }

describe('Antigravity release install', () => {
  it('publishes nothing when cancelled after the download completed', async () => {
    const home = newHome()
    const abort = new AbortController()
    await expect(installAntigravity(home, abort.signal, (message) => {
      // The archive has been downloaded and verified when this line is reported.
      if (message.startsWith('Verifying')) abort.abort()
    }, { release, fetch: completeDownload() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(installedAntigravityBinary(home)).toBeUndefined()
    expect(existsSync(releaseDirectory(home))).toBe(false)
    expect(leftovers(home)).toEqual([])
    expect(antigravityInstallState(home)).toEqual({ installing: false })
  })

  it('reports byte progress with its fraction, at most once per whole percent', async () => {
    const home = newHome()
    const abort = new AbortController()
    // Four chunks: 25, 50, 75 and 100 percent, the second split in two within the same percent.
    const quarter = payload.length / 4
    const chunks = [payload.subarray(0, quarter), payload.subarray(quarter, quarter + 1), payload.subarray(quarter + 1, 2 * quarter), payload.subarray(2 * quarter, 3 * quarter), payload.subarray(3 * quarter)]
    const chunked: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close() } }))
    const reported: Array<[string, number | undefined]> = []
    await expect(installAntigravity(home, abort.signal, (message, fraction) => {
      reported.push([message, fraction])
      if (message.startsWith('Verifying')) abort.abort()
    }, { release, fetch: chunked })).rejects.toMatchObject({ name: 'AbortError' })
    const bytes = reported.filter(([, fraction]) => fraction !== undefined)
    expect(bytes.map(([, fraction]) => fraction)).toEqual([0.25, 0.5, 0.75, 1])
    expect(bytes[0]![0]).toBe('Downloading 0 MB of 0 MB')
  })

  it('stops a download in flight when cancelled through the installation', async () => {
    const home = newHome()
    const running = installAntigravity(home, undefined, undefined, { release, fetch: stalledDownload() })
    const rejected = expect(running).rejects.toThrow('Antigravity install cancelled')
    expect(antigravityInstallState(home)).toEqual({ installing: true, progress: 'Downloading Google Antigravity ACP agent…' })
    expect(cancelAntigravityInstall(home)).toBe(true)
    await rejected
    expect(cancelAntigravityInstall(home)).toBe(false)
    expect(leftovers(home)).toEqual([])
  })

  it('allows one install per installation and several installations at once', async () => {
    const home = newHome()
    const first = installAntigravity(home, undefined, undefined, { release, fetch: stalledDownload() })
    const firstRejected = expect(first).rejects.toThrow('cancelled')
    await expect(installAntigravity(home, undefined, undefined, { release, fetch: stalledDownload() })).rejects.toThrow('already being installed')
    const other = newHome()
    const second = installAntigravity(other, undefined, undefined, { release, fetch: stalledDownload() })
    const secondRejected = expect(second).rejects.toThrow('cancelled')
    expect(antigravityInstallState(other).installing).toBe(true)
    cancelAntigravityInstall(home)
    cancelAntigravityInstall(other)
    await Promise.all([firstRejected, secondRejected])
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
      const service = new AntigravityProviderService(newHome(), installation, new UserQuestionService())
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(stalledDownload())
    const running = a.service.install()
    const rejected = expect(running).rejects.toThrow('Antigravity install cancelled')
    await expect(b.service.install()).rejects.toThrow('Antigravity is already being installed')
    expect(a.progress).toEqual(['Downloading Google Antigravity ACP agent…'])
    // Every profile sees the download, and the installing flag survives a closed page.
    for (const { service } of [a, b]) {
      expect(await service.cliConfig()).toMatchObject({ installing: true, installProgress: 'Downloading Google Antigravity ACP agent…' })
    }
    expect(b.service.cancelInstall()).toBe(true)
    await rejected
    expect((await a.service.cliConfig()).installing).toBeUndefined()
  })

  it('says nothing more after the profile that owns the download stops', async () => {
    const { a, b } = profiles()
    vi.spyOn(globalThis, 'fetch').mockImplementation(stalledDownload())
    const running = a.service.install()
    const rejected = expect(running).rejects.toThrow('Antigravity install cancelled')
    expect(a.changed).toHaveBeenCalledTimes(1)
    a.service.stop() // aborts its own download
    await rejected
    expect(a.changed).toHaveBeenCalledTimes(1)
    expect(a.progress).toEqual(['Downloading Google Antigravity ACP agent…'])
    expect(b.changed).toHaveBeenCalledTimes(2) // the other profile still hears the install end
  })

  it('tells every profile when the shared install starts, progresses and ends, and does not tell a stopped one', async () => {
    const { a, b, make } = profiles()
    const stopped = make()
    stopped.service.stop()
    vi.spyOn(globalThis, 'fetch').mockImplementation(stalledDownload())
    const running = a.service.install()
    const rejected = expect(running).rejects.toThrow('cancelled')
    for (const profile of [a, b]) {
      expect(profile.changed).toHaveBeenCalledTimes(1)
      expect(profile.progress).toEqual(['Downloading Google Antigravity ACP agent…'])
    }
    a.service.cancelInstall()
    await rejected
    // Finished for everyone; the installing profile reports once, after its own settings changed.
    expect(b.changed).toHaveBeenCalledTimes(2)
    expect(a.changed).toHaveBeenCalledTimes(2)
    expect(stopped.changed).not.toHaveBeenCalled()
  })
})
