import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainHandlerRegistry, DomainRpcError } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import type { ProtocolClientType } from '../src/mms/protocol/types'
import { LocalMmsClient, MmsProtocolError } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { MousseMainService } from '../src/mms/MousseMainService'
import {
  BrowserSetupAdmissionError,
  BrowserSetupService,
  BrowserSetupShutdownError
} from '../src/mms/browser/BrowserSetupService'
import { registerBrowserSetupMethods } from '../src/mms/browser/registerBrowserSetupMethods'
import type {
  ManagedBrowserAvailability,
  ManagedBrowserInstallOptions,
  ManagedBrowserInstallResult,
  ManagedBrowserInstaller,
  ManagedBrowserPlatformInfo
} from '../src/shared/browser/install'
import {
  BROWSER_SETUP_CAPABILITY,
  BROWSER_SETUP_IN_APP_NOTE,
  BROWSER_SETUP_METHODS,
  BrowserSetupStatusPoller,
  type BrowserSetupStatus
} from '../src/shared/browser/setup'
import { BROWSER_AUTOMATION_TOOLS } from '../src/shared/browser/automation'
import { PROFILES_V1_CAPABILITY } from '../src/shared/profiles/types'

const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME

afterEach(() => {
  vi.useRealTimers()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-browser-setup-') || path.includes('..')) {
      throw new Error('Unsafe fixture cleanup')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-browser-setup-'))
  roots.push(root)
  return root
}

const PLATFORM: ManagedBrowserPlatformInfo = {
  platform: 'linux64',
  nodePlatform: 'linux',
  arch: 'x64',
  supported: true,
  executableRelativePath: 'chrome-linux64/chrome'
}

function delay(ms: number, signal?: AbortSignal, settleAfterAbortMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const succeed = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const fail = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const abort = () => reject(new DOMException('Browser installation was cancelled.', 'AbortError'))
      if (settleAfterAbortMs) setTimeout(abort, settleAfterAbortMs)
      else abort()
    }
    const onAbort = () => fail()
    const timer = setTimeout(succeed, ms)
    if (signal?.aborted) {
      fail()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

class FakeInstaller implements ManagedBrowserInstaller {
  ready = false
  version?: string
  installCalls = 0
  lastOptions?: ManagedBrowserInstallOptions
  delayMs = 80
  settleAfterAbortMs = 25
  fail?: Error
  installing = false
  unsupported = false
  private readonly secretPath = '/secret/managed/chrome'
  private readonly secretUrl = 'https://storage.googleapis.com/secret/chrome.zip'

  platform(): ManagedBrowserPlatformInfo {
    if (this.unsupported) {
      return { ...PLATFORM, supported: false, reason: 'unsupported fixture architecture' }
    }
    return { ...PLATFORM }
  }

  async availability(_root: string, activeSessions = 0): Promise<ManagedBrowserAvailability> {
    const platform = this.platform()
    if (!platform.supported) {
      return { status: 'unsupported', message: platform.reason!, platform, activeSessions, canInstall: false }
    }
    if (this.installing) {
      return { status: 'installing', message: 'Managed browser installation is in progress.', platform, activeSessions, canInstall: false }
    }
    if (this.ready) {
      return {
        status: 'ready',
        message: `Managed Chrome for Testing ${this.version} (${platform.platform}).`,
        platform,
        version: this.version,
        executablePath: this.secretPath,
        metadata: {
          channel: 'Stable',
          version: this.version!,
          platform: platform.platform,
          url: this.secretUrl,
          source: 'injected-fixture',
          installedAt: new Date().toISOString(),
          sha256: 'a'.repeat(64),
          hashVerified: false,
          executableRelativePath: platform.executableRelativePath,
          archiveBytes: 12,
          extractedBytes: 24
        },
        activeSessions,
        canInstall: true
      }
    }
    return { status: 'setup-required', message: 'No managed Chrome version is active.', platform, activeSessions, canInstall: true }
  }

  async resolveDownload(): Promise<never> {
    throw new Error('setup must not resolve arbitrary downloads')
  }

  async install(options: ManagedBrowserInstallOptions): Promise<ManagedBrowserInstallResult> {
    this.installCalls += 1
    this.lastOptions = options
    this.installing = true
    try {
      options.onProgress?.({ phase: 'resolving', receivedBytes: 0 })
      await delay(Math.max(1, Math.floor(this.delayMs / 3)), options.signal, this.settleAfterAbortMs)
      options.onProgress?.({ phase: 'downloading', receivedBytes: 10, totalBytes: 100, fraction: 0.1, version: '123.0.0.1' })
      await delay(Math.max(1, Math.floor(this.delayMs * 2 / 3)), options.signal, this.settleAfterAbortMs)
      if (this.fail) throw this.fail
      this.ready = true
      this.version = '123.0.0.1'
      options.onProgress?.({ phase: 'complete', receivedBytes: 100, totalBytes: 100, fraction: 1, version: this.version })
      return {
        metadata: {
          channel: options.channel ?? 'Stable',
          version: this.version,
          platform: PLATFORM.platform,
          url: this.secretUrl,
          source: 'injected-fixture',
          installedAt: new Date().toISOString(),
          sha256: 'a'.repeat(64),
          hashVerified: false,
          executableRelativePath: PLATFORM.executableRelativePath,
          archiveBytes: 100,
          extractedBytes: 200
        },
        executablePath: this.secretPath
      }
    } finally {
      this.installing = false
    }
  }

  async rollback(): Promise<ManagedBrowserAvailability> {
    throw new Error('setup must not roll back from the GUI/CLI install path')
  }

  async cleanup(): Promise<string[]> {
    return []
  }

  async resolveExecutable(): Promise<string | undefined> {
    return this.ready ? this.secretPath : undefined
  }
}

function setupService(installer: FakeInstaller, activity = 0, extra: Partial<ConstructorParameters<typeof BrowserSetupService>[0]> = {}) {
  const root = newRoot()
  const service = new BrowserSetupService({
    root,
    installer,
    activity: { activeManagedSessions: () => activity },
    ...extra
  })
  return { root, installer, service }
}

function handlerContext(clientType: ProtocolClientType, capabilities: string[] = [BROWSER_SETUP_CAPABILITY]): HandlerContext {
  return {
    mms: {} as HandlerContext['mms'],
    globalSequence: () => 0,
    connection: {
      id: `conn-${clientType}-${randomUUID()}`,
      clientType,
      capabilities: new Set(capabilities)
    }
  }
}

function assertPublic(status: BrowserSetupStatus, root: string): void {
  const encoded = JSON.stringify(status)
  expect(encoded).not.toContain('/secret/')
  expect(encoded).not.toContain('storage.googleapis.com')
  expect(encoded).not.toContain(root)
  expect(encoded).not.toMatch(/[\\/]chrome-linux64[\\/]chrome/)
  expect(status).not.toHaveProperty('executablePath')
  expect(status).not.toHaveProperty('metadata')
  expect(status.inAppNote).toBe(BROWSER_SETUP_IN_APP_NOTE)
  expect(status.channel).toBe('Stable')
}

describe('managed browser setup service', () => {
  it('shares one install across callers and never replaces a ready version', async () => {
    const installer = new FakeInstaller()
    installer.delayMs = 120
    const { root, service } = setupService(installer)
    const first = service.install()
    const second = service.install()
    const [a, b] = await Promise.all([first, second])
    expect(a.operationId).toBe(b.operationId)
    expect(a.status.availability).toBe('installing')
    assertPublic(a.status, root)
    expect(installer.installCalls).toBe(1)
    expect(installer.lastOptions?.channel).toBe('Stable')
    expect(installer.lastOptions).not.toHaveProperty('version')
    expect(installer.lastOptions).not.toHaveProperty('expectedSha256')
    while ((await service.status()).availability === 'installing') await delay(15)
    const ready = await service.status()
    expect(ready.availability).toBe('ready')
    expect(ready.canInstall).toBe(false)
    expect(ready.version).toBe('123.0.0.1')
    assertPublic(ready, root)
    const again = await service.install()
    expect(installer.installCalls).toBe(1)
    expect(again.status.availability).toBe('ready')
    expect(again.status.operation?.state).toBe('succeeded')
  })

  it('blocks install while a launch is admitted and blocks launch while installing', async () => {
    const installer = new FakeInstaller()
    installer.delayMs = 150
    const { service } = setupService(installer)
    const admission = service.admitManagedLaunch()
    await expect(service.install()).rejects.toMatchObject({ code: 'replace_blocked' })
    admission.release()
    const started = await service.install()
    expect(() => service.admitManagedLaunch()).toThrow(BrowserSetupAdmissionError)
    expect(() => service.admitManagedLaunch()).toThrow(/install is in progress/)
    await service.cancel(started.operationId)
    while (service.getActiveCount() > 0) await delay(10)
  })

  it('keeps raw install ownership through cancel and shutdown', async () => {
    const installer = new FakeInstaller()
    installer.delayMs = 400
    installer.settleAfterAbortMs = 80
    const { service } = setupService(installer)
    const started = await service.install()
    expect(service.getActiveCount()).toBe(1)
    const cancelled = await service.cancel(started.operationId)
    expect(cancelled.status.operation?.state).toBe('cancelling')
    expect(service.getActiveCount()).toBe(1)
    while (service.getActiveCount() > 0) await delay(10)
    const done = await service.status()
    expect(done.operation?.state).toBe('cancelled')
    expect(done.availability).toBe('setup-required')
    expect(installer.ready).toBe(false)

    installer.delayMs = 400
    const second = await service.install()
    service.beginShutdown()
    expect(() => service.admitManagedLaunch()).toThrow(/admission_closed|shutting-down/)
    await service.shutdown({ timeoutMs: 2_000 })
    expect(service.getActiveCount()).toBe(0)
    expect((await service.status()).operation?.state).toBe('cancelled')
    await expect(service.install()).rejects.toMatchObject({ code: 'admission_closed' })
    expect(second.operationId).toBeTruthy()
  })

  it('retains ownership when shutdown times out before raw install settlement', async () => {
    const installer = new FakeInstaller()
    installer.delayMs = 800
    installer.settleAfterAbortMs = 400
    const { service } = setupService(installer)
    await service.install()
    await expect(service.shutdown({ timeoutMs: 30 })).rejects.toBeInstanceOf(BrowserSetupShutdownError)
    expect(service.getActiveCount()).toBe(1)
    while (service.getActiveCount() > 0) await delay(20)
    await service.shutdown({ timeoutMs: 1_000 })
    expect(service.getActiveCount()).toBe(0)
  })

  it('enforces a maximum install duration without leaking private paths', async () => {
    const installer = new FakeInstaller()
    installer.delayMs = 400
    installer.settleAfterAbortMs = 10
    const { root, service } = setupService(installer, 0, { maxDurationMs: 40 })
    const started = await service.install()
    while ((await service.status()).operation?.state === 'running' || (await service.status()).operation?.state === 'cancelling') {
      await delay(15)
    }
    const failed = await service.status()
    expect(failed.operation?.state).toBe('failed')
    expect(failed.operation?.error?.code).toBe('deadline_exceeded')
    assertPublic(failed, root)
    expect(started.operationId).toBeTruthy()
  })
})

describe('managed browser setup methods', () => {
  it('admits only capability-guarded GUI/CLI clients and rejects private params', async () => {
    const installer = new FakeInstaller()
    const { service } = setupService(installer)
    const domains = new DomainHandlerRegistry()
    registerBrowserSetupMethods(domains, service)
    const gui = handlerContext('gui')
    const status = await domains.dispatch(gui, 'browser.setup.status', {}) as BrowserSetupStatus
    expect(status.availability).toBe('setup-required')
    await expect(domains.dispatch(gui, 'browser.setup.install', { channel: 'Beta' })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(domains.dispatch(gui, 'browser.setup.install', { url: 'https://example.invalid' })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(domains.dispatch(gui, 'browser.setup.install', { path: '/tmp/chrome' })).rejects.toMatchObject({ code: 'unknown_field' })
    await expect(domains.dispatch({ ...gui, connection: { ...gui.connection!, capabilities: new Set() } }, 'browser.setup.status', {})).rejects.toMatchObject({ code: 'capability_required' })
    await expect(domains.dispatch({ ...gui, connection: undefined }, 'browser.setup.status', {})).rejects.toMatchObject({ code: 'capability_required' })
    await expect(domains.dispatch(handlerContext('unknown'), 'browser.setup.status', {})).rejects.toMatchObject({ code: 'capability_required' })
    const cli = handlerContext('cli')
    const started = await domains.dispatch(cli, 'browser.setup.install', {}) as { operationId: string }
    expect(started.operationId).toMatch(/^[0-9a-f-]{36}$/i)
    domains.notifyConnectionClosed(cli.connection!.id)
    expect(service.getActiveCount()).toBe(1)
    await expect(domains.dispatch(cli, 'browser.setup.cancel', { operationId: randomUUID() })).rejects.toMatchObject({ code: 'operation_not_found' })
    await domains.dispatch(cli, 'browser.setup.cancel', { operationId: started.operationId })
    while (service.getActiveCount() > 0) await delay(10)
    expect(BROWSER_AUTOMATION_TOOLS.join()).not.toContain('browser.setup')
    expect([...BROWSER_SETUP_METHODS]).toEqual(['browser.setup.status', 'browser.setup.install', 'browser.setup.cancel'])
  })

  it('shares one framed operation across profiles and strips private paths', async () => {
    const root = newRoot()
    const home = join(root, 'home')
    const installer = new FakeInstaller()
    installer.delayMs = 180
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    const setup = new BrowserSetupService({
      root: join(root, 'browser'),
      installer,
      activity: { activeManagedSessions: () => 0 }
    })
    const registration = registerBrowserSetupMethods(main.domains, setup)
    const host = main.getInstallationHost()!
    const alice = host.manager.create({ displayName: 'Alice', slug: 'alice' })
    const bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const server = new MmsProtocolServer({ mms: main, ownerToken: 'fixture-owner-token' })
    const endpoint = await server.start()
    const clients: LocalMmsClient[] = []
    const connect = async (profileId: string) => {
      const client = new LocalMmsClient({
        homeDir: home,
        endpoint,
        ownerToken: 'fixture-owner-token',
        clientType: 'cli',
        requestedCapabilities: [PROFILES_V1_CAPABILITY, BROWSER_SETUP_CAPABILITY]
      })
      clients.push(client)
      await client.connect()
      await client.request('profiles.bind', { profile: profileId })
      return client
    }
    try {
      const a = await connect(alice.id)
      const b = await connect(bob.id)
      const first = await a.request<{ operationId: string; status: BrowserSetupStatus }>('browser.setup.install', {})
      const second = await b.request<{ operationId: string; status: BrowserSetupStatus }>('browser.setup.install', {})
      expect(first.operationId).toBe(second.operationId)
      expect(installer.installCalls).toBe(1)
      assertPublic(first.status, join(root, 'browser'))
      await expect(a.request('browser.setup.install', { hash: 'abc' })).rejects.toBeInstanceOf(MmsProtocolError)
      const status = await b.request<BrowserSetupStatus>('browser.setup.status', {})
      expect(status.operation?.id).toBe(first.operationId)
      await b.request('browser.setup.cancel', { operationId: first.operationId })
      while (setup.getActiveCount() > 0) await delay(15)
    } finally {
      registration.dispose()
      await Promise.allSettled(clients.map((client) => client.close()))
      await server.stop()
      await main.stop()
    }
  }, 30_000)
})

describe('managed browser setup poller and panel copy', () => {
  it('does not overlap status requests and ignores results after dispose', async () => {
    let inflight = 0
    let max = 0
    let resolveStatus: ((status: BrowserSetupStatus) => void) | undefined
    const request = vi.fn((method: string) => {
      expect(method).toBe('browser.setup.status')
      inflight += 1
      max = Math.max(max, inflight)
      return new Promise<BrowserSetupStatus>((resolve) => {
        resolveStatus = (status) => {
          inflight -= 1
          resolve(status)
        }
      })
    })
    const seen: BrowserSetupStatus[] = []
    const poller = new BrowserSetupStatusPoller(request as never, 20)
    poller.start({ onStatus: (status) => seen.push(status) })
    await delay(60)
    expect(request).toHaveBeenCalledTimes(1)
    expect(max).toBe(1)
    const late: BrowserSetupStatus = {
      availability: 'setup-required',
      message: 'late',
      channel: 'Stable',
      platform: { id: 'linux64', supported: true },
      canInstall: true,
      activeManagedSessions: 0,
      admittedLaunches: 0,
      inAppNote: BROWSER_SETUP_IN_APP_NOTE
    }
    poller.dispose()
    resolveStatus?.(late)
    await delay(10)
    expect(seen).toEqual([])
  })

  it('exposes install and cancel actions and the in-app independence note', () => {
    const source = readFileSync(resolve('src/renderer/components/browserAutomation/BrowserSetupPanel.tsx'), 'utf8')
    expect(source).toContain('Install managed browser')
    expect(source).toContain('Cancel')
    expect(source).toContain('BROWSER_SETUP_IN_APP_NOTE')
    expect(source).toContain('browser.setup.install')
    expect(source).toContain('browser.setup.cancel')
    expect(source).toContain('BrowserSetupStatusPoller')
  })
})

describe('domain error mapping', () => {
  it('maps missing operation ids as invalid_params', async () => {
    const { service } = setupService(new FakeInstaller())
    const domains = new DomainHandlerRegistry()
    registerBrowserSetupMethods(domains, service)
    const gui = handlerContext('gui')
    await expect(domains.dispatch(gui, 'browser.setup.cancel', {})).rejects.toBeInstanceOf(DomainRpcError)
    await expect(domains.dispatch(gui, 'browser.setup.cancel', { operationId: 'not-a-uuid' })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})
