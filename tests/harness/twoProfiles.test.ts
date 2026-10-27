import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MmsProfileServices } from '../../src/mms/MmsProfileServices'
import { resolveBoundServices } from '../../src/mms/profiles/admission'
import { PROFILES_V1_CAPABILITY } from '../../src/shared/profiles/types'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { PROTOCOL_METHODS } from '../../src/mms/protocol/types'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }

/** A profile with its own home, instance map and gateway. */
function profile(): { services: MmsProfileServices; stored: () => Record<string, unknown> } {
  const home = mkdtempSync(join(tmpdir(), 'mousse-profile-'))
  homes.push(home)
  let stored: unknown
  let seedVersion: number | undefined
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion }), write: (next) => { stored = next.instances; seedVersion = next.seedVersion } } })
  const harness = testHarness({ adapters: [pi, claude], instances, profileHome: home })
  return { services: { harness, providerInstances: instances } as unknown as MmsProfileServices, stored: () => (stored ?? {}) as Record<string, unknown> }
}

const HARNESS_METHODS = PROTOCOL_METHODS.filter((method) => method === 'providers.snapshots' || method.startsWith('providers.instances.') || method === 'providers.getUsage' || method === 'providers.getSubscriptionUsage')

/** A profile with one Codex entry whose plan usage is `remaining` percent left, and the shared pi-ai usage (one provider). */
function profileWithCodexUsage(remaining: number): MmsProfileServices {
  const home = mkdtempSync(join(tmpdir(), 'mousse-profile-usage-'))
  homes.push(home)
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: { codex: { driver: 'codex', enabled: true } }, seedVersion: 1 }), write: () => {} } })
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
    // The pi-ai credential service is shared by every profile.
    providerAuth: { getUsage: async () => ({ providers: [{ id: 'xai', label: 'xAI', status: 'unavailable', windows: [] }], fetchedAt: '' }), getSubscriptionUsage: async (id: string) => (id === 'xai' ? 'xAI usage' : undefined) },
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
})
