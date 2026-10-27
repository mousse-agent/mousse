/**
 * PR 5a-2 review r1 follow-ups on the gateway side of Add provider:
 * - cloud credentials are checked before a model API is added (`signIn: 'ambient'`): a failed check
 *   writes no entry, a good one adds it signed in;
 * - a sign-in that finishes while a check that read the old credentials is still running is checked
 *   again afterwards, so the entry does not read signed out for the check's lifetime;
 * - a pi sign-in refreshes the models it may unlock;
 * - a vendor service's own change and a model catalogue refresh reach clients as snapshots events;
 * - a driver that offers Add options must give them fixed ids.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import type { HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { ProviderInstanceService, type StoredProviderInstances } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { PiInstallationCredentials } from './fixtures/piInstallationCredentials'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})
const device = { kind: 'device' } as const

function profile(credentials: PiInstallationCredentials) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-add-signin-'))
  let state: StoredProviderInstances = { instances: {}, seedVersion: 1 }
  let writes = 0
  const instances = new ProviderInstanceService({ store: { read: () => ({ ...state }), write: (next) => { state = { ...next }; writes += 1 } }, providerAuth: credentials })
  const harness = testHarness({
    profileHome: home,
    instances,
    drivers: [piDriver({ client: () => ({ chat: async () => { throw new Error('no model call in this test') } }) as never, credentials: () => credentials as never })]
  })
  const events: HarnessGatewayEvent[] = []
  harness.instances.subscribe((event) => events.push(event))
  cleanups.push(() => harness.stop(), () => rmSync(home, { recursive: true, force: true }))
  return { instances, harness, events, state: () => state, writes: () => writes }
}

const codeOf = async (run: () => Promise<unknown>) => run().then(() => undefined, (error: { code?: string; message?: string }) => error)

describe('adding cloud credentials', () => {
  it('without credentials in the environment adds nothing and says why', async () => {
    const credentials = new PiInstallationCredentials()
    credentials.verifyAmbientProvider.mockResolvedValueOnce({ success: false, error: 'Amazon Bedrock credentials were not detected in the environment.' } as never)
    const a = profile(credentials)
    const failure = await codeOf(() => a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'amazon-bedrock' }, signIn: 'ambient' }))
    expect(failure).toMatchObject({ code: 'signed_out', message: 'Amazon Bedrock credentials were not detected in the environment.' })
    expect(a.instances.list()).toEqual({})
    expect(a.writes()).toBe(0)
    expect(credentials.keys.has('amazon-bedrock')).toBe(false)
  })

  it('with credentials adds the entry signed in, and adding again keeps it', async () => {
    const credentials = new PiInstallationCredentials()
    const a = profile(credentials)
    const added = await a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'amazon-bedrock' }, signIn: 'ambient' })
    expect(added).toMatchObject({ existed: false, snapshot: { instanceId: 'pi:amazon-bedrock', auth: { state: 'signed_in' } } })
    expect(credentials.verifyAmbientProvider).toHaveBeenCalledWith('amazon-bedrock')
    expect(await a.harness.instances.addInstance({ driver: 'pi', config: { provider: 'amazon-bedrock' }, signIn: 'ambient' })).toMatchObject({ existed: true })
  })
})

describe('a sign-in that finishes during an older check', () => {
  it('is checked again once that check ends, so the entry reads signed in', async () => {
    let signedIn = false
    const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
    let releaseCheck!: () => void
    let checks = 0
    const driver = adapterDriver(pi, {
      runtime: {
        configured: () => signedIn,
        // The first check reads the store before the sign-in saved it, and ends after the sign-in.
        auth: async () => {
          checks += 1
          const read = signedIn
          if (checks === 2) await new Promise<void>((resolve) => { releaseCheck = resolve })
          return read ? { state: 'signed_in' } : { state: 'signed_out' }
        },
        signIn: async (session) => {
          signedIn = true
          return { success: true, sessionId: session.sessionId }
        }
      }
    })
    let value: unknown = { 'pi:openrouter': { driver: 'pi', enabled: true } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: value, seedVersion: 1 }), write: (next) => { value = next.instances } } })
    const home = mkdtempSync(join(tmpdir(), 'mousse-signin-race-'))
    const harness = testHarness({ drivers: [driver], instances, profileHome: home })
    cleanups.push(() => harness.stop(), () => rmSync(home, { recursive: true, force: true }))
    expect((await harness.instances.snapshots(device))[0]!.auth.state).toBe('signed_out')
    // A forced check starts and holds (it read "signed out"); the sign-in runs and finishes meanwhile.
    const held = harness.instances.recheck('pi:openrouter')
    await vi.waitFor(() => expect(checks).toBe(2))
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    await harness.instances.signIn('pi:openrouter', 'oauth')
    await vi.waitFor(() => expect(events.some((event) => event.type === 'operation' && event.data.phase === 'completed')).toBe(true))
    releaseCheck()
    await held
    await vi.waitFor(async () => expect((await harness.instances.snapshots(device))[0]!.auth.state).toBe('signed_in'))
    expect(checks).toBeGreaterThanOrEqual(3)
  })
})

describe('events that only a snapshots event now carries', () => {
  it('a pi sign-in refreshes the models it may unlock', async () => {
    const credentials = new PiInstallationCredentials()
    const runOAuthLogin = vi.fn(async () => ({ success: true }))
    Object.assign(credentials, { runOAuthLogin, runApiKeyLogin: vi.fn(async () => ({ success: false, error: 'unused' })) })
    const a = profile(credentials)
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'openai' } })
    credentials.refreshDynamicModels.mockClear()
    await a.harness.instances.signIn('pi:openai', 'oauth')
    await vi.waitFor(() => expect(runOAuthLogin).toHaveBeenCalled())
    await vi.waitFor(() => expect(credentials.refreshDynamicModels).toHaveBeenCalled())
  })

  it('a vendor service changing on its own and a catalogue refresh each publish the snapshots', async () => {
    const a = profile(new PiInstallationCredentials())
    await a.harness.instances.add({ driver: 'pi', config: { provider: 'openrouter' } })
    await a.harness.instances.snapshots(device)
    const count = () => a.events.filter((event) => event.type === 'snapshots').length
    const before = count()
    a.harness.catalogChanged()
    expect(count()).toBe(before + 1)
    a.harness.vendorStateChanged('pi:openrouter')
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before + 1))
    // An id that is no entry publishes nothing.
    const settled = count()
    a.harness.vendorStateChanged('antigravity')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(count()).toBe(settled)
  })
})

describe('a driver with Add options', () => {
  it('must give them fixed ids', () => {
    const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
    const driver = { ...adapterDriver(pi), addOptions: () => [] }
    expect(() => testHarness({ drivers: [driver], instances: new ProviderInstanceService(), profileHome: tmpdir() })).toThrow('offers Add options but no fixed instance ids')
  })
})
