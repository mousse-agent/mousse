import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { resolveBoundServices } from '../../src/mms/profiles/admission'
import { ProfileHost } from '../../src/mms/profiles/ProfileHost'
import { PROFILES_V1_CAPABILITY } from '../../src/shared/profiles/types'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { PROTOCOL_METHODS } from '../../src/mms/protocol/types'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createProviderAccess } from '../../src/mms/providers/providerAccess'
import { ProviderInstanceService, type StoredProviderInstances } from '../../src/mms/harness/instanceMap'
import { PiStubAdapter } from '../support/piStub'
import type { ProviderAdapter } from '../../src/mms/harness/adapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './fixtures/piInstallationCredentials'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const pi = new PiStubAdapter()
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

/** A profile with its own home, instance map and gateway. */
function profile(): { services: MmsProfileServices; stored: () => Record<string, unknown> } {
  const home = mkdtempSync(join(tmpdir(), 'mousse-profile-'))
  homes.push(home)
  let stored: unknown
  let seedVersion: number | undefined
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion }), write: (next) => { stored = next.instances; seedVersion = next.seedVersion } } })
  // Claude Code takes further entries (an API-key one among them), as the real driver does.
  const harness = testHarness({ adapters: [pi], drivers: [{ ...adapterDriver(claude), multiInstance: true, privateHome: true }], instances, profileHome: home })
  return { services: { harness, providerInstances: instances } as unknown as MmsProfileServices, stored: () => (stored ?? {}) as Record<string, unknown> }
}

const HARNESS_METHODS = PROTOCOL_METHODS.filter((method) => method === 'providers.snapshots' || method.startsWith('providers.instances.') || method === 'providers.getUsage' || method === 'providers.getSubscriptionUsage')

/** A profile with one Codex entry whose plan usage is `remaining` percent left, and the shared pi-ai usage (one provider). */
function profileWithCodexUsage(remaining: number): MmsProfileServices {
  const home = mkdtempSync(join(tmpdir(), 'mousse-profile-usage-'))
  homes.push(home)
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: { codex: { driver: 'codex', enabled: true } }, seedVersion: 1 }), write: () => {} } })
  // The pi-ai credential service is shared by every profile.
  const providerAuth = {
    getUsage: async () => ({ providers: [{ id: 'xai', label: 'xAI', status: 'unavailable', windows: [] }], fetchedAt: '' }),
    getSubscriptionUsage: async (id: string) => (id === 'xai' ? 'xAI usage' : undefined),
    getProviderDisplayName: (id: string) => id
  }
  const codex: ProviderAdapter = { driver: 'codex', capabilities: pi.capabilities, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }
  const harness = testHarness({
    drivers: [adapterDriver(codex, { runtime: { configured: () => true, usage: async () => ({ status: 'available', windows: [{ id: 'five_hour', label: '5-hour limit', remainingPercent: remaining }] }) } })],
    instances,
    profileHome: home
  })
  return {
    harness,
    providerInstances: instances,
    claudeSubscription: { status: async () => undefined, configured: () => false },
    providerAuth,
    providerAccess: createProviderAccess(providerAuth as never, { isRemoved: (id) => instances.isRemoved(id), instanceIdForLegacyProvider: (id) => `pi:${id}` }),
    worktrees: { getRepoRoot: () => home }
  } as unknown as MmsProfileServices
}

describe('provider methods on two profiles', () => {
  it('admission binds every provider method to the connection\'s profile', async () => {
    const work = profile()
    const host = { activeProfileCount: () => 2, manager: { get: () => ({ id: 'work', status: 'active' }) }, getProfileServices: vi.fn(async () => work.services) }
    const installation = { getInstallationHost: () => host } as unknown as MmsProfileServices
    for (const method of HARNESS_METHODS) {
      const bound = await resolveBoundServices({ installation, method, binding: { profileId: 'work', epoch: 1 }, capabilities: new Set([PROFILES_V1_CAPABILITY]) })
      expect(bound.services, method).toBe(work.services)
    }
    await expect(resolveBoundServices({ installation, method: 'providers.instances.setEnabled', capabilities: new Set([PROFILES_V1_CAPABILITY]) }))
      .rejects.toMatchObject({ code: 'profile_binding_required' })
  })

  it('snapshots and mutations reach only the bound profile', async () => {
    const personal = profile()
    const work = profile()
    const context = (services: MmsProfileServices) => ({ mms: services, globalSequence: () => 0 }) as unknown as HandlerContext

    await dispatchMethod(context(work.services), 'providers.instances.setEnabled', { instanceId: 'claude', scope: { kind: 'device' }, enabled: false })
    await dispatchMethod(context(work.services), 'providers.instances.setModelPrefs', { instanceId: 'claude', patch: { hidden: ['opus'] } })

    expect(work.stored().claude).toMatchObject({ enabled: false })
    // The other profile only has the built-in entry it was seeded with, still on: nothing leaked into it.
    expect(personal.stored().claude).toEqual({ driver: 'claude', enabled: true })
    const workSnapshots = await dispatchMethod(context(work.services), 'providers.snapshots', { scope: { kind: 'device' } }) as { snapshots: Array<{ instanceId: string; enabled: { device: boolean } }> }
    const personalSnapshots = await dispatchMethod(context(personal.services), 'providers.snapshots', { scope: { kind: 'device' } }) as { snapshots: Array<{ instanceId: string; enabled: { device: boolean } }> }
    expect(workSnapshots.snapshots.find((entry) => entry.instanceId === 'claude')?.enabled.device).toBe(false)
    expect(personalSnapshots.snapshots.find((entry) => entry.instanceId === 'claude')?.enabled.device).toBe(true)
    expect(work.services.harness!.catalog.models('claude', { kind: 'device' })).toEqual([])
    expect(() => work.services.harness!.resolve({ instanceId: 'claude', model: 'opus' }, { kind: 'device' }, 'composer')).toThrow()
    expect(personal.services.harness!.resolve({ instanceId: 'claude', model: 'opus' }, { kind: 'device' }, 'composer').driver).toBe('claude')
  })

  it('the profile host says whether another profile still uses a provider entry: unmoved counts, moved does not, a profile it cannot read does', () => {
    const entries = (movedTo?: string) => ({ services: { providerInstances: { list: () => ({ 'pi:openai-codex': { driver: 'pi', enabled: true, ...(movedTo ? { config: { movedTo } } : {}) } }) } } })
    const host = (live: Record<string, ReturnType<typeof entries> | undefined>) => {
      const instance = Object.create(ProfileHost.prototype) as ProfileHost & Record<string, unknown>
      instance.manager = { list: () => Object.keys(live).map((id) => ({ id })) }
      instance.live = new Map(Object.entries(live).flatMap(([id, value]) => (value ? [[id, value.services]] : [])))
      return instance
    }
    expect(host({ me: entries(), other: entries() }).otherProfilesUse('me', 'pi:openai-codex')).toBe(true)
    expect(host({ me: entries(), other: entries('codex') }).otherProfilesUse('me', 'pi:openai-codex')).toBe(false)
    expect(host({ me: entries() }).otherProfilesUse('me', 'pi:openai-codex')).toBe(false)
    expect(host({ me: entries(), other: undefined }).otherProfilesUse('me', 'pi:openai-codex')).toBe(true)
    // A profile without the entry at all does not use it.
    const bare = { services: { providerInstances: { list: () => ({}) } } }
    expect(host({ me: entries(), other: bare as never }).otherProfilesUse('me', 'pi:openai-codex')).toBe(false)
  })

  it('usage shows each profile only its own Codex, next to the shared pi-ai providers', async () => {
    const personal = profileWithCodexUsage(80)
    const work = profileWithCodexUsage(15)
    const context = (services: MmsProfileServices) => ({ mms: services, globalSequence: () => 0 }) as unknown as HandlerContext
    const usageOf = async (services: MmsProfileServices) =>
      ((await dispatchMethod(context(services), 'providers.getUsage', {})) as { providers: Array<{ id: string; windows: Array<{ remainingPercent: number }> }> }).providers
    expect((await usageOf(personal)).map((entry) => [entry.id, entry.windows[0]?.remainingPercent])).toEqual([['xai', undefined], ['codex', 80]])
    expect((await usageOf(work)).map((entry) => [entry.id, entry.windows[0]?.remainingPercent])).toEqual([['xai', undefined], ['codex', 15]])
    // The text form reads the same: a shared pi-ai provider through the credentials, an agent through the profile.
    const textOf = async (services: MmsProfileServices, providerId: string) => ((await dispatchMethod(context(services), 'providers.getSubscriptionUsage', { providerId })) as { usage?: string }).usage
    expect(await textOf(personal, 'xai')).toBe('xAI usage')
    expect(await textOf(personal, 'codex')).toContain('20% used')
    expect(await textOf(work, 'codex')).toContain('85% used')
    expect(await textOf(work, 'nobody')).toBeUndefined()
  })

  it('model APIs: add, setSecret, addOptions and remove-stays-removed act on the bound profile only', async () => {
    const credentials = new PiInstallationCredentials()
    const piProfile = () => {
      const home = mkdtempSync(join(tmpdir(), 'mousse-profile-pi-'))
      homes.push(home)
      let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
      const instances = new ProviderInstanceService({ store: { read: () => ({ ...state }), write: (next) => { state = { ...next } } }, providerAuth: credentials })
      const harness = testHarness({ drivers: [piDriver({ credentials: () => credentials as never })], instances, profileHome: home })
      return { services: { harness, providerInstances: instances } as unknown as MmsProfileServices, state: () => state }
    }
    const personal = piProfile()
    const work = piProfile()
    const context = (services: MmsProfileServices) => ({ mms: services, globalSequence: () => 0 }) as unknown as HandlerContext
    for (const method of ['providers.instances.setSecret', 'providers.catalog.addOptions'])
      expect((await resolveBoundServices({ installation: { getInstallationHost: () => ({ activeProfileCount: () => 2, manager: { get: () => ({ id: 'work', status: 'active' }) }, getProfileServices: async () => work.services }) } as never, method, binding: { profileId: 'work', epoch: 1 }, capabilities: new Set([PROFILES_V1_CAPABILITY]) })).services, method).toBe(work.services)

    const add = { driver: 'pi', config: { provider: 'openrouter' } }
    for (const profile of [personal, work]) {
      expect(await dispatchMethod(context(profile.services), 'providers.instances.add', add)).toMatchObject({ snapshot: { instanceId: 'pi:openrouter' } })
      expect(await dispatchMethod(context(profile.services), 'providers.instances.add', add)).toMatchObject({ existed: true })
    }
    await dispatchMethod(context(work.services), 'providers.instances.setSecret', { instanceId: 'pi:openrouter', value: 'fixture-key' })
    expect(credentials.keys.get('openrouter')).toBe('fixture-key')
    await dispatchMethod(context(work.services), 'providers.instances.remove', { instanceId: 'pi:openrouter' })
    // The shared key is saved again by the other profile: work keeps it removed, personal keeps it.
    await dispatchMethod(context(personal.services), 'providers.instances.setSecret', { instanceId: 'pi:openrouter', value: 'fixture-key-2' })
    expect(work.state().removed).toEqual(['pi:openrouter'])
    expect(personal.state().removed).toEqual([])
    const optionOf = async (profile: ReturnType<typeof piProfile>) =>
      ((await dispatchMethod(context(profile.services), 'providers.catalog.addOptions', {})) as { options: Array<{ id: string; added: boolean; hasSavedKey: boolean }> }).options.find((option) => option.id === 'openrouter')
    expect(await optionOf(work)).toMatchObject({ added: false, hasSavedKey: true })
    expect(await optionOf(personal)).toMatchObject({ added: true, hasSavedKey: true })
    const idsOf = async (profile: ReturnType<typeof piProfile>) =>
      ((await dispatchMethod(context(profile.services), 'providers.snapshots', { scope: { kind: 'device' } })) as { snapshots: Array<{ instanceId: string }> }).snapshots.map((snapshot) => snapshot.instanceId)
    expect(await idsOf(work)).toEqual([])
    expect(await idsOf(personal)).toEqual(['pi:openrouter'])
  })

  it('adds Claude Code on an API key as claude:api in the bound profile only', async () => {
    const personal = profile()
    const work = profile()
    const context = (services: MmsProfileServices) => ({ mms: services, globalSequence: () => 0 }) as unknown as HandlerContext
    const added = await dispatchMethod(context(work.services), 'providers.instances.add', {
      driver: 'claude',
      slug: 'api',
      config: { displayName: 'Claude Code (API key)', home: 'private', loginMethod: 'api_key' }
    }) as { snapshot: { instanceId: string } }
    expect(added.snapshot.instanceId).toBe('claude:api')
    expect(work.stored()['claude:api']).toMatchObject({ driver: 'claude', config: { home: 'private', loginMethod: 'api_key' } })
    expect(personal.stored()['claude:api']).toBeUndefined()
  })
})
