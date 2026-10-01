import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { ProviderAuthService } from '../src/mms/providers/ProviderAuthService'
import { LocalMmsClient, MmsProtocolServer } from '../src/mms/protocol'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { ScheduledJobService } from '../src/mms/scheduled/ScheduledJobService'
import { ScheduledJobStore } from '../src/mms/scheduled/ScheduledJobStore'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { WorkerHandle } from '../src/mms/terminals/WorkerHandle'
import type { ChannelAdapterFactory } from '../src/mms/channels/ChannelService'
import { FixtureAdapter } from './fixtures/agent-platform/channel-control-lifecycle/helpers'
import {
  heartbeatCommand,
  heartbeatPath,
  pidPath,
  readOwnedPidFile,
  waitForHeartbeat,
  waitUntilPidGone
} from './fixtures/agent-platform/process-lifecycle/ownedTemp'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const roots: string[] = []
const previousHome = process.env.MOUSSE_HOME
function ownedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-profile-drain-'))
  roots.push(root)
  process.env.MOUSSE_HOME = root
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) {
    const path = relative(realpathSync(tmpdir()), realpathSync(root))
    if (isAbsolute(path) || !path.startsWith('mousse-profile-drain-') || path.includes('..')) throw new Error('Unexpected fixture root')
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('profile drain and durable scheduler ownership', () => {
  it('retains a composed failed channel close and removes the profile only after retry succeeds', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), home = join(root, 'home')
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, profile = host.manager.create({ displayName: 'Close retry', slug: 'close-retry' })
    const services = await host.getProfileServices(profile.id)
    const adapter = new FixtureAdapter('webhook')
    vi.spyOn(services.channels as unknown as { createAdapter: ChannelAdapterFactory }, 'createAdapter').mockReturnValue(adapter)
    services.channels.updateConfig({ platforms: { webhook: { enabled: true, allowAllUsers: true } } })
    await services.channels.connect('webhook')
    const close = vi.spyOn(adapter, 'disconnect').mockRejectedValueOnce(new Error('owned close failed'))
    try {
      await expect(host.remove(profile.id, profile.revision)).rejects.toThrow(/Failed to drain profile services/)
      expect(host.getLive(profile.id)).toBe(services)
      expect(existsSync(services.getProfileHomeDir())).toBe(true)
      expect(services.getOwnedActivity().channelWork).toBeGreaterThan(0)

      await host.remove(profile.id, profile.revision)
      expect(close).toHaveBeenCalledTimes(2)
      expect(adapter.connected).toBe(false)
      expect(host.getLive(profile.id)).toBeUndefined()
    } finally {
      await main.stop()
    }
  }, 20_000)

  it('fences and retains actual MCP discovery, channel close and control RPC owners before profile removal', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), home = join(root, 'home')
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, profile = host.manager.create({ displayName: 'Owned integration', slug: 'owned-integration' })
    const services = await host.getProfileServices(profile.id), profileRoot = services.getProfileHomeDir()
    const discoveryEntered = deferred(), releaseDiscovery = deferred(), controlEntered = deferred(), releaseControl = deferred(), releaseChannel = deferred()
    vi.spyOn(services.mcpRegistry, 'discover').mockImplementation(async () => {
      discoveryEntered.resolve(); await releaseDiscovery.promise
      writeFileSync(join(profileRoot, 'mcp-final.txt'), 'discovery settled')
      return { servers: [], sources: [], diagnostics: [] }
    })
    const adapter = new FixtureAdapter('webhook')
    adapter.disconnectHold = releaseChannel.promise
    vi.spyOn(services.channels as unknown as { createAdapter: ChannelAdapterFactory }, 'createAdapter').mockReturnValue(adapter)
    services.channels.updateConfig({ platforms: { webhook: { enabled: true, allowAllUsers: true } } })
    await services.channels.connect('webhook')
    // The existing internal control executor has no GUI binding. This fixture
    // domain needs none, while dispatchMethod still owns its personal RPC lifetime.
    main.domains.register({ method: 'fixture.controlWrite', scope: 'installation', validate: () => ({}), handle: async () => {
      controlEntered.resolve(); await releaseControl.promise
      writeFileSync(join(profileRoot, 'control-final.txt'), 'control settled')
      return { ok: true }
    } })
    const discovery = services.mcpManager.listConfiguredServers()
    const control = services.control.getAdmittedExecutor().execute('fixture.controlWrite', {})
    const originalStop = services.stop.bind(services)
    const stop = vi.spyOn(services, 'stop').mockImplementation(() => originalStop({ timeoutMs: 15 }))
    try {
      await Promise.all([discoveryEntered.promise, controlEntered.promise])
      await expect(host.remove(profile.id, profile.revision)).rejects.toMatchObject({ code: 'profile_busy' })
      expect(host.getLive(profile.id)).toBe(services)
      expect(services.getOwnedActivity()).toMatchObject({ 'rpc:fixture.controlWrite': 1 })
      for (const owner of ['mcpWork', 'channelWork', 'controlWork']) expect(services.getOwnedActivity()[owner]).toBeGreaterThan(0)
      await expect(services.mcpManager.listConfiguredServers()).rejects.toMatchObject({ code: 'profile_draining' })
      await expect(services.channels.connect()).rejects.toMatchObject({ code: 'profile_draining' })
      await expect(Promise.resolve().then(() => services.control.getAdmittedExecutor().execute('health', {}))).rejects.toMatchObject({ code: 'profile_draining' })
      await expect(main.runOwnedRequest('fixture-peer', () => 'other profile remains live')).resolves.toBe('other profile remains live')
      releaseDiscovery.resolve(); await discovery
      releaseControl.resolve(); await control
      expect(existsSync(profileRoot)).toBe(true)
      expect(services.getOwnedActivity().channelWork).toBeGreaterThan(0)
      expect(adapter.connected).toBe(true)
      releaseChannel.resolve(); stop.mockRestore()
      await host.remove(profile.id, profile.revision)
      expect(adapter.connected).toBe(false)
      expect(existsSync(profileRoot)).toBe(false)
      const moved = readdirSync(join(home, 'trash', 'profiles')).find((name) => name.startsWith(`${profile.id}-`))!
      expect(readFileSync(join(home, 'trash', 'profiles', moved, 'mcp-final.txt'), 'utf8')).toBe('discovery settled')
      expect(readFileSync(join(home, 'trash', 'profiles', moved, 'control-final.txt'), 'utf8')).toBe('control settled')
    } finally {
      releaseDiscovery.resolve(); releaseControl.resolve(); releaseChannel.resolve(); stop.mockRestore()
      await Promise.allSettled([discovery, control]); await main.stop()
    }
  }, 20_000)

  it('refuses profile completion when a shutdown callback excludes its still-active caller', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, profile = host.manager.create({ displayName: 'Residual owner', slug: 'residual-owner' })
    const services = await host.getProfileServices(profile.id)
    // Model the documented recursive-control exclusion: shutdown may settle
    // before the calling owner. The profile boundary must recheck inventory.
    const count = vi.spyOn(services.control, 'getActiveCount').mockReturnValue(1)
    try {
      await expect(host.remove(profile.id, profile.revision)).rejects.toMatchObject({ code: 'profile_busy', details: { activity: { controlWork: 1 } } })
      expect(host.getLive(profile.id)).toBe(services)
      expect(existsSync(services.getProfileHomeDir())).toBe(true)
      count.mockRestore()
      await host.remove(profile.id, profile.revision)
      expect(host.getLive(profile.id)).toBeUndefined()
    } finally { count.mockRestore(); await main.stop() }
  }, 20_000)

  it('awaits a cancelled scheduler tick, suppresses late output and interrupts every claimed job without spending repeat counts', async () => {
    const root = ownedRoot(), store = new ScheduledJobStore(MousseConfigStore.load(root))
    const projects = new ProjectManager(root), threads = new ThreadDataStore(projects, root)
    const target = threads.createThread('Owned scheduled target')
    const jobs = [0, 1].map((index) => store.createJob({ name: `Owned ${index}`, prompt: 'fixture', threadId: target.id,
      schedule: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() }, repeat: { times: 2, completed: 0 } }))
    for (const job of jobs) store.updateJob(job.id, { nextRunAt: '2000-01-01T00:00:00.000Z', state: 'scheduled' })
    const entered = deferred(), release = deferred()
    const runner = vi.fn(async () => { entered.resolve(); await release.promise; return { text: 'Must not append after shutdown', silent: false } })
    const service = new ScheduledJobService({ runIsolated: runner }, store, threads, projects)
    try {
      service.start(); await entered.promise
      const first = service.shutdown({ timeoutMs: 10 })
      expect(service.shutdown()).toBe(first)
      await expect(first).rejects.toMatchObject({ code: 'profile_busy' })
      expect(service.getActiveCount()).toBe(1)
      expect(() => service.start()).toThrow('shutting down')
      expect(store.getJob(jobs[0].id)?.runClaim).toBeDefined()
      release.resolve(); await service.shutdown()
      expect(runner).toHaveBeenCalledTimes(1)
      expect(threads.loadThreadData(target.id).messages).toHaveLength(0)
      for (const job of jobs) {
        expect(store.getJob(job.id)).toMatchObject({ state: 'error', enabled: false, lastStatus: 'interrupted', repeat: { completed: 0 }, nextRunAt: null })
        expect(store.getJob(job.id)?.runClaim).toBeUndefined()
      }
      expect(service.getActiveCount()).toBe(0)
      expect(existsSync(join(root, 'scheduled', '.tick.lock'))).toBe(false)
    } finally { release.resolve(); await service.shutdown() }
  })

  it('does not let an interrupted stale claim overwrite a replacement owner', () => {
    const root = ownedRoot(), store = new ScheduledJobStore(MousseConfigStore.load(root))
    const job = store.createJob({ name: 'Owned recurring job', prompt: 'fixture', schedule: { kind: 'interval', minutes: 5 } })
    store.updateJob(job.id, { nextRunAt: '2000-01-01T00:00:00.000Z', state: 'scheduled' })
    const [claimed] = store.claimDueJobs()
    store.updateJob(job.id, { runClaim: { ...claimed.runClaim!, token: 'replacement-token' } })
    expect(store.interruptRun(job.id, claimed.runClaim!.token, 'stale shutdown')).toBeNull()
    expect(store.getJob(job.id)?.runClaim?.token).toBe('replacement-token')
    expect(store.interruptRun(job.id, 'replacement-token', 'owned shutdown')).toMatchObject({ lastStatus: 'interrupted', state: 'scheduled' })
  })

  it('retains exact scheduler claim ownership when interruption persistence fails and retries it', async () => {
    const root = ownedRoot(), store = new ScheduledJobStore(MousseConfigStore.load(root))
    const job = store.createJob({ name: 'Retry interruption', prompt: 'fixture', schedule: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() } })
    store.updateJob(job.id, { nextRunAt: '2000-01-01T00:00:00.000Z', state: 'scheduled' })
    const entered = deferred(), release = deferred()
    const service = new ScheduledJobService({ runIsolated: async () => {
      entered.resolve(); await release.promise
      return { text: 'late', silent: false }
    } }, store)
    const interruptRun = store.interruptRun.bind(store)
    let failPersistence = true
    vi.spyOn(store, 'interruptRun').mockImplementation((...args) => {
      if (failPersistence) throw new Error('fixture interruption write failed')
      return interruptRun(...args)
    })

    service.start(); await entered.promise
    const firstShutdown = service.shutdown()
    release.resolve()
    await expect(firstShutdown).rejects.toThrow('fixture interruption write failed')
    expect(store.getJob(job.id)).toMatchObject({ state: 'running' })
    expect(store.getJob(job.id)?.runClaim).toBeDefined()

    failPersistence = false
    await service.shutdown()
    expect(store.getJob(job.id)).toMatchObject({ state: 'error', lastStatus: 'interrupted', nextRunAt: null })
    expect(store.getJob(job.id)?.runClaim).toBeUndefined()
  })

  it('waits for an admitted framed RPC final write before moving its profile and rejects new personal requests', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), home = join(root, 'home')
    const main = await MousseMainService.create({ homeDir: home, repoRoot: root, requireOwnership: false, headless: true })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const services = await main.getProfileServices(bob.id), profileRoot = services.getProfileHomeDir()
    const entered = deferred(), release = deferred()
    main.domains.register({ method: 'fixture.ownedWrite', scope: 'profile', validate: () => ({}), handle: async (ctx) => {
      entered.resolve(); await release.promise
      writeFileSync(join(ctx.mms.getProfileHomeDir(), 'final-write.txt'), 'Owned request settled')
      return { profileId: ctx.mms.profileId }
    } })
    const server = new MmsProtocolServer({ mms: main, ownerToken: 'owned-fixture-token' }), endpoint = await server.start()
    const client = () => new LocalMmsClient({ homeDir: home, endpoint, ownerToken: 'owned-fixture-token', requestedCapabilities: ['profiles-v1'] })
    const bobClient = client(), adminClient = client(), peerClient = client()
    let pending: Promise<unknown> | undefined, removal: Promise<unknown> | undefined
    try {
      await Promise.all([bobClient.connect(), adminClient.connect(), peerClient.connect()])
      await bobClient.request('profiles.bind', { profile: bob.id })
      await peerClient.request('profiles.bind', { profile: host.getDefaultProfileId() })
      pending = bobClient.request('fixture.ownedWrite'); await entered.promise
      removal = adminClient.request('profiles.remove', { profileId: bob.id, expectedRevision: bob.revision })
      await vi.waitFor(async () => { await expect(host.getProfileServices(bob.id)).rejects.toMatchObject({ code: 'profile_draining' }) })
      await expect(bobClient.request('projects.list')).rejects.toMatchObject({ code: 'profile_draining' })
      await expect(peerClient.request('projects.list')).resolves.toMatchObject({ projects: [] })
      expect(existsSync(profileRoot)).toBe(true)
      expect(existsSync(join(profileRoot, 'final-write.txt'))).toBe(false)
      release.resolve(); await Promise.all([pending, removal])
      expect(existsSync(profileRoot)).toBe(false)
      const moved = readdirSync(join(home, 'trash', 'profiles')).find((name) => name.startsWith(`${bob.id}-`))!
      expect(readFileSync(join(home, 'trash', 'profiles', moved, 'final-write.txt'), 'utf8')).toBe('Owned request settled')
      expect(() => host.manager.get(bob.id)).toThrow()
    } finally {
      release.resolve(); await Promise.allSettled([pending, removal])
      await Promise.all([bobClient.close(), adminClient.close(), peerClient.close()]); await server.stop(); await main.stop()
    }
  }, 20_000)

  it('retains the original runtime after a drain deadline and a later removal retry awaits that same work', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const services = await main.getProfileServices(bob.id), release = deferred()
    const work = services.runOwnedRequest('fixture-held', () => release.promise)
    const originalStop = services.stop.bind(services)
    const stop = vi.spyOn(services, 'stop').mockImplementation(() => originalStop({ timeoutMs: 10 }))
    try {
      await expect(host.remove(bob.id, bob.revision)).rejects.toMatchObject({ code: 'profile_busy' })
      expect(host.getLive(bob.id)).toBe(services)
      expect(host.manager.get(bob.id).status).toBe('active')
      expect(existsSync(services.getProfileHomeDir())).toBe(true)
      await expect(host.getProfileServices(bob.id)).rejects.toMatchObject({ code: 'profile_draining' })
      expect(services.getOwnedActivity()['rpc:fixture-held']).toBe(1)
      release.resolve(); await work
      stop.mockRestore()
      await host.remove(bob.id, bob.revision)
      expect(host.getLive(bob.id)).toBeUndefined()
    } finally { release.resolve(); await work; stop.mockRestore(); await main.stop() }
  }, 20_000)

  it('preserves profile_busy when a nested drain owner reaches its deadline', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const services = await host.getProfileServices(bob.id)
    const dispose = vi.spyOn(services.platform, 'dispose').mockRejectedValue(
      Object.assign(new Error('nested drain timeout'), { code: 'profile_busy' })
    )
    try {
      await expect(services.stop()).rejects.toMatchObject({ code: 'profile_busy' })
      dispose.mockRestore()
      await services.stop()
    } finally {
      dispose.mockRestore(); await main.stop()
    }
  }, 20_000)

  it('awaits a composing runtime and fences the original caller before archive', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const entered = deferred(), release = deferred(), initialize = MmsProfileServices.prototype.initialize
    vi.spyOn(MmsProfileServices.prototype, 'initialize').mockImplementation(async function (this: MmsProfileServices) {
      await initialize.call(this)
      if (this.profileId === bob.id) { entered.resolve(); await release.promise }
    })
    const composing = host.getProfileServices(bob.id).catch((error: unknown) => error)
    let archive: Promise<unknown> | undefined
    try {
      await entered.promise
      archive = host.archive(bob.id, bob.revision)
      expect(host.manager.get(bob.id).status).toBe('active')
      await expect(host.getProfileServices(bob.id)).rejects.toMatchObject({ code: 'profile_draining' })
      release.resolve()
      expect(await composing).toMatchObject({ code: 'profile_draining' })
      await archive
      expect(host.manager.get(bob.id).status).toBe('archived')
      expect(host.getLive(bob.id)).toBeUndefined()
    } finally { release.resolve(); await Promise.allSettled([composing, archive]); await main.stop() }
  }, 20_000)

  it('restores a fresh runtime when a metadata revision wins during archive drain', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const original = await host.getProfileServices(bob.id), release = deferred()
    const work = original.runOwnedRequest('fixture-held', () => release.promise)
    const archive = host.archive(bob.id, bob.revision).catch((error: unknown) => error)
    try {
      host.manager.update(bob.id, { displayName: 'Updated during drain' }, bob.revision)
      release.resolve(); await work
      expect(await archive).toMatchObject({ code: 'PROFILE_REVISION_CONFLICT' })
      const restored = await host.getProfileServices(bob.id)
      expect(restored).not.toBe(original)
      expect(host.manager.get(bob.id)).toMatchObject({ status: 'active', displayName: 'Updated during drain' })
      await expect(restored.runOwnedRequest('fixture-read', () => restored.projects.listProjects())).resolves.toEqual([])
      await expect(original.runOwnedRequest('fixture-stale', () => undefined)).rejects.toMatchObject({ code: 'profile_draining' })
    } finally { release.resolve(); await Promise.allSettled([work, archive]); await main.stop() }
  }, 20_000)

  it('retains the actual installation lease and retries a failed platform disposer before reporting stopped', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: true })
    const lease = main.getOwnerLease()
    expect(lease).not.toBeNull()
    let attempts = 0
    main.platform.onDispose(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('Owned fixture disposal failure')
      writeFileSync(join(main.getProfileHomeDir(), 'disposer-finished.txt'), 'Complete before lease release')
    })
    try {
      await expect(main.stop()).rejects.toThrow('Failed to stop installation services')
      expect(main.getOwnerLease()).toBe(lease)
      expect(attempts).toBe(1)
      await main.stop()
      expect(attempts).toBe(2)
      expect(main.getOwnerLease()).toBeNull()
      expect(readFileSync(join(main.getProfileHomeDir(), 'disposer-finished.txt'), 'utf8')).toBe('Complete before lease release')
    } finally { await main.stop() }
  }, 20_000)

  it('retains the installation lease through an already-admitted profile lifecycle action', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: true })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    await host.getProfileServices(bob.id)
    const entered = deferred(), release = deferred(), marker = join(root, 'lifecycle-action-finished.txt')
    const lifecycleAction = (host as any).withDrainedProfile(bob.id, async () => {
      entered.resolve(); await release.promise
      writeFileSync(marker, 'finished while installation-owned')
    }) as Promise<void>
    await entered.promise
    let stopSettled = false
    const stop = main.stop().finally(() => { stopSettled = true })
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(stopSettled).toBe(false)
      expect(main.getOwnerLease()).not.toBeNull()
      expect(existsSync(marker)).toBe(false)
      release.resolve()
      await Promise.all([lifecycleAction, stop])
      expect(readFileSync(marker, 'utf8')).toBe('finished while installation-owned')
      expect(main.getOwnerLease()).toBeNull()
    } finally {
      release.resolve(); await Promise.allSettled([lifecycleAction, stop]); await main.stop()
    }
  }, 20_000)

  it('awaits real owned child and grandchild trees through profile removal and installation stop', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const bobServices = await host.getProfileServices(bob.id)
    const spawnTree = async (services: MmsProfileServices, label: string) => {
      const beats = join(services.getProfileHomeDir(), `${label}-beats`)
      services.headlessRunner.spawn(label, services.getProfileHomeDir(), heartbeatCommand(), {
        env: {
          LIFECYCLE_HEARTBEAT_DIR: beats,
          LIFECYCLE_ROLE: 'child',
          LIFECYCLE_HEARTBEAT_MS: '80',
          LIFECYCLE_SPAWN_GRANDCHILD: '1'
        }
      })
      await waitForHeartbeat(heartbeatPath(beats, 'child'))
      await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
      return {
        child: readOwnedPidFile(pidPath(beats, 'child')),
        grandchild: readOwnedPidFile(pidPath(beats, 'grandchild'))
      }
    }

    const bobTree = await spawnTree(bobServices, 'profile-tree')
    expect(bobServices.getOwnedActivity().headlessProcesses).toBe(1)
    await host.remove(bob.id, bob.revision)
    await waitUntilPidGone(bobTree.child, 'removed profile child')
    await waitUntilPidGone(bobTree.grandchild, 'removed profile grandchild')

    const defaultTree = await spawnTree(main, 'installation-tree')
    expect(main.getOwnedActivity().headlessProcesses).toBe(1)
    await main.stop()
    await waitUntilPidGone(defaultTree.child, 'installation child')
    await waitUntilPidGone(defaultTree.grandchild, 'installation grandchild')
    expect(main.getOwnedActivity().headlessProcesses).toBe(0)
  }, 60_000)

  it('retains native-agent and PTY owners with their profile runtime across a drain deadline', async () => {
    vi.spyOn(ProviderAuthService.prototype, 'init').mockResolvedValue(undefined)
    const root = ownedRoot(), main = await MousseMainService.create({ homeDir: join(root, 'home'), repoRoot: root, requireOwnership: false })
    const host = main.getInstallationHost()!, bob = host.manager.create({ displayName: 'Bob', slug: 'bob' })
    const services = await host.getProfileServices(bob.id), release = deferred()
    const ownedRun = (services.platform.agentRuns as any).lifecycle.run(
      'fixture-native-agent-run',
      () => release.promise
    ) as Promise<void>
    const ptyHandle = new WorkerHandle('fixture-profile-pty', 'fixture-agent', 'pty')
    services.ptyManager.adoptTransportForTests({ handle: ptyHandle, signal: () => undefined })
    try {
      expect(services.getOwnedActivity().agentRuns).toBe(1)
      expect(services.getOwnedActivity().ptyProcesses).toBe(1)
      await expect(services.stop({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'profile_busy' })
      expect(host.getLive(bob.id)).toBe(services)
      expect(services.getOwnedActivity().agentRuns).toBe(1)
      expect(services.getOwnedActivity().ptyProcesses).toBe(1)
      expect(() => services.platform.agentRuns.tryRun({} as never)).toThrow('shutting down')
      ptyHandle.recordExit(null, 'SIGTERM'); ptyHandle.recordClose()
      release.resolve(); await ownedRun
      await services.stop()
      expect(services.getOwnedActivity().agentRuns).toBe(0)
      expect(services.getOwnedActivity().ptyProcesses).toBe(0)
    } finally {
      ptyHandle.recordExit(null, 'SIGTERM'); ptyHandle.recordClose()
      release.resolve(); await Promise.allSettled([ownedRun]); await main.stop()
    }
  }, 20_000)
})
