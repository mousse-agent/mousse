/**
 * PR 5a-1 review round 1: a removed agent is used for nothing, and removing an entry and adding it
 * back keeps the new entry's state folder.
 * - A removed built-in Claude Code or Codex counts as signed out to its own service: no sign-in
 *   check, no usage query, no listing (`providers.getUsage`, `providers.listConfigured`).
 * - A removal still waiting for a check to end does not delete the folder of the entry added back
 *   under the same fixed id (an agent's own setup, a model API).
 * No CLI runs: the vendor services find a fake file and their checks and queries are fakes.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthReading } from '../../src/mms/harness/driver'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { createProviderAccess } from '../../src/mms/providers/providerAccess'
import { ProviderInstanceService, type StoredProviderInstances } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './fixtures/piInstallationCredentials'
import { executable, removeHome, startProfile, tempHome, type ProfileStore, type StartedProfile } from './vendorProfile'

const homes: string[] = []
const running: StartedProfile[] = []
const cleanups: Array<() => unknown> = []

beforeEach(() => {
  // No CLI on PATH or in a home: nothing the user installed is ever found or started.
  const empty = tempHome('mousse-empty-home-')
  homes.push(empty)
  vi.stubEnv('PATH', '')
  vi.stubEnv('Path', '')
  vi.stubEnv('HOME', empty)
  vi.stubEnv('USERPROFILE', empty)
})

afterEach(async () => {
  for (const profile of running.splice(0)) profile.stop()
  for (const clean of cleanups.splice(0).reverse()) await clean()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) removeHome(home)
})

function home(): string {
  const dir = tempHome()
  homes.push(dir)
  return dir
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('a removed built-in agent', () => {
  function profileWithClis() {
    const dir = home()
    const store: ProfileStore = {
      instances: { claude: { driver: 'claude', enabled: true }, codex: { driver: 'codex', enabled: true } },
      seedVersion: 1,
      writes: []
    }
    const profile = startProfile(dir, store, { claude: executable(join(dir, 'bin'), 'claude'), codex: executable(join(dir, 'bin'), 'codex') })
    running.push(profile)
    const auth = { getUsage: vi.fn(async () => ({ providers: [], fetchedAt: '' })), getSubscriptionUsage: vi.fn(async () => undefined), getProviderDisplayName: (id: string) => id }
    const context = {
      mms: {
        harness: profile.harness,
        providerInstances: profile.instanceMap,
        providerAccess: createProviderAccess(auth as never, profile.instanceMap),
        claudeSubscription: profile.claude,
        codex: profile.codex,
        worktrees: { getRepoRoot: () => dir }
      },
      globalSequence: () => 0
    } as unknown as HandlerContext
    return { profile, store, context }
  }

  it('is not checked and not asked for usage, while an entry that is there is', async () => {
    const { profile, store, context } = profileWithClis()
    // The control: with the entry there, the service checks its sign-in.
    await profile.claude.status({ force: true })
    expect(profile.claudeAuth).toHaveBeenCalled()

    await profile.harness.instances.remove('claude')
    await profile.harness.instances.remove('codex')
    expect(store.removed).toEqual(['claude', 'codex'])
    profile.claudeAuth.mockClear()
    profile.claudeQuery.mockClear()
    profile.codexAccount.mockClear()

    expect(profile.harness.signedOutInMousse('claude')).toBe(true)
    expect(profile.claude.configured()).toBe(false)
    expect(profile.codex.configured()).toBe(false)
    const usage = await dispatchMethod(context, 'providers.getUsage', {}) as { providers: Array<{ id: string }> }
    expect(usage.providers).toEqual([])
    const listed = await dispatchMethod(context, 'providers.listConfigured', {}) as { providers: unknown[] }
    expect(listed.providers).toEqual([])
    expect(profile.claudeAuth).not.toHaveBeenCalled()
    expect(profile.claudeQuery).not.toHaveBeenCalled()
    expect(profile.codexAccount).not.toHaveBeenCalled()
  })

  it('is not offered as a model API sign-in by the old Add dialog, while one that is there and signed out is', async () => {
    const { profile, context } = profileWithClis()
    const mms = (context as unknown as { mms: Record<string, unknown> }).mms
    mms.providerAuth = { getLoginOptions: () => [] }
    mms.antigravity = profile.antigravity
    const loginIds = async () => ((await dispatchMethod(context, 'providers.getLoginOptions', { authType: 'oauth' })) as { options: Array<{ id: string }> }).options.map((option) => option.id)
    // Codex signed out in Mousse but still an entry: its sign-in is offered, as before.
    await profile.harness.instances.signOut('codex')
    expect(await loginIds()).toContain('codex')
    await profile.harness.instances.remove('claude')
    await profile.harness.instances.remove('codex')
    const ids = await loginIds()
    expect(ids).not.toContain('claude-subscription')
    expect(ids).not.toContain('codex')
  })
})

describe('removing an entry and adding it back keeps the new entry\'s state folder', () => {
  const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
  const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

  it('an agent\'s own-setup id, re-added while the removal waits for a check', async () => {
    const dir = home()
    const auth = vi.fn(async (): Promise<AuthReading> => ({ state: 'signed_in' }))
    let state: StoredProviderInstances = { instances: { claude: { driver: 'claude', enabled: true } }, seedVersion: 1 }
    const instances = new ProviderInstanceService({ store: { read: () => ({ ...state }), write: (next) => { state = { ...next } } } })
    const harness = testHarness({ profileHome: dir, instances, drivers: [adapterDriver(claude, { runtime: { auth } })] })
    cleanups.push(() => harness.stop())
    await harness.instances.snapshots({ kind: 'device' })

    // A check is running when the entry is removed: the removal waits for it to delete the folder.
    const slow = deferred<AuthReading>()
    auth.mockImplementationOnce(() => slow.promise)
    const recheck = harness.instances.recheck('claude').catch(() => undefined)
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(2))
    const removal = harness.instances.remove('claude')
    await vi.waitFor(() => expect(instances.isRemoved('claude')).toBe(true))

    // Added back under the same id before the check ends.
    expect((await harness.instances.add({ driver: 'claude' })).instanceId).toBe('claude')
    slow.resolve({ state: 'signed_in' })
    await removal
    await recheck
    expect(existsSync(instanceStateDir(dir, 'claude'))).toBe(true)
  })

  it('a model API\'s fixed id, re-added while the removal waits for a check', async () => {
    const dir = home()
    const credentials = new PiInstallationCredentials()
    let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
    const instances = new ProviderInstanceService({ store: { read: () => ({ ...state }), write: (next) => { state = { ...next } } }, providerAuth: credentials })
    const harness = testHarness({ profileHome: dir, instances, drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) as never, credentials: () => credentials as never })] })
    cleanups.push(() => harness.stop())
    await harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    await harness.instances.snapshots({ kind: 'device' })

    // The key's deletion is slow, so the removal is still running when the entry is added back:
    // the add waits for it, and the folder is the new entry's.
    const slow = deferred<void>()
    credentials.logout.mockImplementationOnce(async (providerId: string) => {
      await slow.promise
      credentials.keys.delete(providerId)
    })
    const removal = harness.instances.remove('pi:openrouter')
    await vi.waitFor(() => expect(instances.isRemoved('pi:openrouter')).toBe(true))
    const added = harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    slow.resolve()
    await removal
    await added
    expect(existsSync(instanceStateDir(dir, 'pi:openrouter'))).toBe(true)
  })
})

describe('a key saved for an entry added back while its removal deletes the old key', () => {
  function piProfile() {
    const dir = home()
    const credentials = new PiInstallationCredentials()
    credentials.keys.set('openrouter', 'fixture-old-key')
    let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
    const instances = new ProviderInstanceService({ store: { read: () => ({ ...state }), write: (next) => { state = { ...next } } }, providerAuth: credentials })
    const harness = testHarness({ profileHome: dir, instances, drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('unused') } }) as never, credentials: () => credentials as never })] })
    cleanups.push(() => harness.stop())
    // The old key's deletion is slow: whatever is saved meanwhile must survive it.
    const slow = deferred<void>()
    credentials.logout.mockImplementationOnce(async (providerId: string) => {
      await slow.promise
      credentials.keys.delete(providerId)
    })
    return { dir, credentials, instances, harness, slow }
  }

  it('Add waits for the removal, so setSecret on the entry added back keeps its key', async () => {
    const { credentials, instances, harness, slow } = piProfile()
    expect(Object.keys(instances.list())).toEqual(['pi:openrouter'])
    const removal = harness.instances.remove('pi:openrouter')
    await vi.waitFor(() => expect(credentials.logout).toHaveBeenCalled())
    let addSettled = false
    const added = harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } }).then((snapshot) => {
      addSettled = true
      return snapshot
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(addSettled).toBe(false)
    slow.resolve()
    await removal
    await added
    await harness.instances.setSecret('pi:openrouter', 'fixture-new-key')
    expect(credentials.keys.get('openrouter')).toBe('fixture-new-key')
    expect(Object.keys(instances.list())).toEqual(['pi:openrouter'])
  })

  it('the old Add dialog\'s key waits for the removal too, and brings the entry back with that key', async () => {
    const { credentials, instances, harness, slow } = piProfile()
    const context = { mms: { harness, providerInstances: instances, providerAuth: credentials }, globalSequence: () => 0 } as unknown as HandlerContext
    const removal = harness.instances.remove('pi:openrouter')
    await vi.waitFor(() => expect(credentials.logout).toHaveBeenCalled())
    const saved = dispatchMethod(context, 'providers.setApiKey', { providerId: 'openrouter', apiKey: 'fixture-new-key' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(credentials.setApiKey).not.toHaveBeenCalled()
    slow.resolve()
    await removal
    await saved
    expect(credentials.keys.get('openrouter')).toBe('fixture-new-key')
    expect(instances.isRemoved('pi:openrouter')).toBe(false)
  })
})
