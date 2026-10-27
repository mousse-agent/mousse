/**
 * `settings.getOptions` lists models through `gateway.llmProviders`, which waits for each
 * instance's first check (a CLI's sign-in is known only once checked), and afterwards answers
 * from the cached result while a due check runs in the background and arrives as a snapshot event.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AuthReading } from '../../src/mms/harness/driver'
import { PROBE_TTL_MS, type HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { ProviderAdapter } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
const claude: ProviderAdapter = { driver: 'claude', capabilities: pi.capabilities, configured: () => true, startTurn: async () => { throw new Error('unused') }, interrupt: async () => 'not_active' }
const signedIn: AuthReading = { state: 'signed_in' }

function setup(probe: { authMs?: number } = {}) {
  let nowMs = 1_000_000
  const auth = vi.fn(async (): Promise<AuthReading> => signedIn)
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: { claude: { driver: 'claude', enabled: true } }, seedVersion: 1 }), write: () => {} } })
  const harness = testHarness({
    instances,
    now: () => nowMs,
    ...(probe.authMs ? { probeTimeouts: { authMs: probe.authMs } } : {}),
    drivers: [adapterDriver(claude, { runtime: { auth, llmProvider: () => ({ id: 'claude-subscription', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet' }] }) } })]
  })
  const events: HarnessGatewayEvent[] = []
  harness.instances.subscribe((event) => events.push(event))
  const context = {
    mms: { harness, providerAuth: { init: async () => {}, getCatalogLlmProviders: () => [] } },
    globalSequence: () => 0
  } as unknown as HandlerContext
  const options = async () => ((await dispatchMethod(context, 'settings.getOptions', {})) as { options: { llmProviders: Array<{ instanceId?: string }> } }).options.llmProviders
  return { harness, auth, events, options, advance: (ms: number) => { nowMs += ms } }
}

describe('the first-check wait on settings.getOptions', () => {
  it('keeps waiting while a sign-in has never been checked', async () => {
    const { auth, options } = setup()
    const first = deferred<AuthReading>()
    auth.mockImplementationOnce(() => first.promise)
    let settled = false
    const pending = options().then((listed) => {
      settled = true
      return listed
    })
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    first.resolve(signedIn)
    expect((await pending).map((option) => option.instanceId)).toEqual(['claude'])
  })

  it('a first check that timed out is waited for again on the next read, not after the probe TTL', async () => {
    const { auth, options } = setup({ authMs: 300 })
    // The first sign-in check never answers: the read ends at the check's deadline.
    auth.mockImplementationOnce(() => new Promise<AuthReading>(() => {}))
    await options()
    expect(auth).toHaveBeenCalledTimes(1)
    // The next read checks again at once and waits for that answer.
    const second = deferred<AuthReading>()
    auth.mockImplementationOnce(() => second.promise)
    let settled = false
    const pending = options().then(() => { settled = true })
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(2), { interval: 1 })
    expect(settled).toBe(false)
    second.resolve(signedIn)
    await pending
    // Answered now: a third read within the TTL checks nothing.
    await options()
    expect(auth).toHaveBeenCalledTimes(2)
  })

  it('a later read uses the cache and a refresh arrives as a snapshot event', async () => {
    const { auth, events, options, advance } = setup()
    await options()
    expect(auth).toHaveBeenCalledTimes(1)
    // Within the check's lifetime nothing runs again.
    await options()
    expect(auth).toHaveBeenCalledTimes(1)

    advance(PROBE_TTL_MS + 1)
    const slow = deferred<AuthReading>()
    auth.mockImplementationOnce(() => slow.promise)
    events.length = 0
    // The due check runs in the background: the read answers from the cached result at once.
    expect((await options()).map((option) => option.instanceId)).toEqual(['claude'])
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(2))
    expect(events.filter((event) => event.type === 'snapshots')).toEqual([])
    slow.resolve({ state: 'signed_out' })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'snapshots' && event.data.snapshots.some((snapshot) => snapshot.instanceId === 'claude' && snapshot.auth.state === 'signed_out'))).toBe(true))
  })
})
