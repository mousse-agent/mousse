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
import { testHarness } from '../../src/mms/run/testkit/harness'

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

const HARNESS_METHODS = PROTOCOL_METHODS.filter((method) => method === 'providers.snapshots' || method.startsWith('providers.instances.'))

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
    expect(personal.stored().claude).toBeUndefined()
    const workSnapshots = await dispatchMethod(context(work.services), 'providers.snapshots', { scope: { kind: 'device' } }) as { snapshots: Array<{ instanceId: string; enabled: { device: boolean } }> }
    const personalSnapshots = await dispatchMethod(context(personal.services), 'providers.snapshots', { scope: { kind: 'device' } }) as { snapshots: Array<{ instanceId: string; enabled: { device: boolean } }> }
    expect(workSnapshots.snapshots.find((entry) => entry.instanceId === 'claude')?.enabled.device).toBe(false)
    expect(personalSnapshots.snapshots.find((entry) => entry.instanceId === 'claude')?.enabled.device).toBe(true)
    expect(work.services.harness!.catalog.models('claude', { kind: 'device' })).toEqual([])
    expect(() => work.services.harness!.resolve({ instanceId: 'claude', model: 'opus' }, { kind: 'device' }, 'composer')).toThrow()
    expect(personal.services.harness!.resolve({ instanceId: 'claude', model: 'opus' }, { kind: 'device' }, 'composer').driver).toBe('claude')
  })
})
