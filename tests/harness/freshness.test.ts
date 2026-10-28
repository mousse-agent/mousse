/**
 * Snapshot freshness: credential changes made through the provider instance methods (a saved key,
 * a guided key sign-in, a sign-out) are checked again at once, inside the probe cache's TTL (S9); a check that throws is
 * recorded with its error instead of leaving the instance "Checking" (F7).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import type { HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { PiStubAdapter } from '../support/piStub'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { describeStatus } from '../../src/shared/harness/status'

const homes: string[] = []
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-fresh-'))
  homes.push(dir)
  return dir
}

const device = { kind: 'device' } as const

describe('credential changes through the provider instance methods', () => {
  it('connect, replace the key, log out and reconnect each show at once, within the probe TTL', async () => {
    const keys = new Map<string, string>([['openai', 'sk-one']])
    const auth = {
      has: (id: string) => keys.has(id),
      credentials: { listProviderIds: () => [...keys.keys()] },
      getConfiguredProviders: () => [...keys.keys()].map((id) => ({ id, label: id, authType: 'api_key' as const })),
      getConfiguredLlmProviders: () => [],
      getLoginOptions: () => ['openai', 'anthropic'].map((id) => ({ id, label: id, authType: 'api_key' as const })),
      getAmbientProviderInfo: () => undefined,
      setApiKey: async (id: string, key: string) => void keys.set(id, key),
      logout: async (id: string) => void keys.delete(id),
      refreshDynamicModels: async () => {},
      runApiKeyLogin: async (_session: unknown, id: string) => {
        keys.set(id, 'sk-login')
        return { success: true }
      },
      runOAuthLogin: async () => ({ success: false, error: 'unused' }),
      createSession: () => ({ sessionId: 's', on: () => {}, off: () => {} }),
      endSession: () => {}
    }
    const instances = new ProviderInstanceService({ providerAuth: auth as never })
    const now = Date.now()
    const harness = testHarness({
      drivers: [piDriver({ credentials: () => auth as never })],
      instances,
      profileHome: home(),
      now: () => now
    })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    const ctx = { mms: { harness, providerAuth: auth, providerInstances: instances }, globalSequence: () => 0, emitEvent: () => {} } as unknown as HandlerContext
    const state = async (instanceId = 'pi:openai') => (await harness.instances.snapshots(device)).find((snapshot) => snapshot.instanceId === instanceId)?.auth.state

    expect(await state()).toBe('signed_in')
    await dispatchMethod(ctx, 'providers.instances.signOut', { instanceId: 'pi:openai' })
    expect(await state()).toBe('signed_out')
    await dispatchMethod(ctx, 'providers.instances.setSecret', { instanceId: 'pi:openai', value: 'sk-two' })
    expect(await state()).toBe('signed_in')
    // Replacing the key checks again (and publishes) even though nothing else changed.
    const published = events.length
    await dispatchMethod(ctx, 'providers.instances.setSecret', { instanceId: 'pi:openai', value: 'sk-three' })
    expect(events.length).toBeGreaterThan(published)
    await dispatchMethod(ctx, 'providers.instances.signOut', { instanceId: 'pi:openai' })
    expect(await state()).toBe('signed_out')
    // The guided key sign-in is an operation; the instance reads signed in once it completes.
    await dispatchMethod(ctx, 'providers.instances.signIn', { instanceId: 'pi:openai', method: 'api_key' })
    await vi.waitFor(async () => expect(await state()).toBe('signed_in'))
    // A provider added and given its first key shows signed in at once.
    await dispatchMethod(ctx, 'providers.instances.add', { driver: 'pi', config: { provider: 'anthropic' } })
    await dispatchMethod(ctx, 'providers.instances.setSecret', { instanceId: 'pi:anthropic', value: 'sk-ant' })
    expect(await state('pi:anthropic')).toBe('signed_in')
    harness.stop()
  })
})

describe('a check that throws', () => {
  const pi = () => new PiStubAdapter()

  it('is recorded with its error and offers Check again, never "Checking"', async () => {
    const adapter = pi()
    const driver = adapterDriver({ ...adapter, driver: 'claude', startTurn: adapter.startTurn.bind(adapter), interrupt: adapter.interrupt.bind(adapter) }, {
      runtime: { auth: async () => { throw new Error('keychain locked') } }
    })
    const harness = testHarness({ drivers: [adapterDriver(pi()), driver], instances: new ProviderInstanceService(), profileHome: home() })
    const snapshot = await harness.instances.recheck('claude')
    expect(snapshot.checkedAt).toBeDefined()
    expect(snapshot.runs).toMatchObject({ state: 'unknown', message: expect.stringContaining('keychain locked') })
    const status = describeStatus(snapshot)
    expect(status.headline).not.toMatch(/Checking/)
    expect(status.detail).toContain('keychain locked')
    expect(status.nextStep?.action).toBe('recheck')
    harness.stop()
  })

  it('after a good check keeps the last good values, marked stale', async () => {
    let fail = false
    const adapter = pi()
    const driver = adapterDriver({ ...adapter, driver: 'claude', startTurn: adapter.startTurn.bind(adapter), interrupt: adapter.interrupt.bind(adapter) }, {
      runtime: {
        auth: async () => {
          if (fail) throw new Error('keychain locked')
          return { state: 'signed_in' }
        }
      }
    })
    const harness = testHarness({ drivers: [adapterDriver(pi()), driver], instances: new ProviderInstanceService(), profileHome: home() })
    expect((await harness.instances.recheck('claude')).auth.state).toBe('signed_in')
    fail = true
    const snapshot = await harness.instances.recheck('claude')
    expect(snapshot).toMatchObject({ stale: true, auth: { state: 'signed_in' } })
    expect(snapshot.lastGoodAt).toBeDefined()
    expect(describeStatus(snapshot).nextStep?.action).toBe('recheck')
    harness.stop()
  })
})
