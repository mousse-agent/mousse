/**
 * Signed out in Mousse (plan PR 5 §4): the flag is the gateway's, written before the runtime's own
 * sign-out, and refuses every attempt until a reconnect. On the user's own CLI sign-in a reconnect
 * only clears the flag; a sign-in Mousse owns clears it only when it succeeds.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeInstanceConfig, type DriverRuntime, type HarnessDriver } from '../../src/mms/harness/driver'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiStubAdapter } from '../support/piStub'
import type { ProviderAdapter, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'

const dirs: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const noop = () => {}
const capabilities = new PiStubAdapter().capabilities

function turnSpec(binding: TurnSpec['binding'], attemptId: string, previous?: TurnSpec['binding']): TurnSpec {
  return {
    binding,
    ...(previous ? { previous } : {}),
    input: {
      runId: `run-${attemptId}`, attemptId, threadId: 'thread', cwd: null, instanceId: binding.instanceId,
      model: binding.model, llmProvider: 'claude-subscription', modelPinned: true, mode: 'agent', prompt: 'hello',
      messages: [], nativeHistory: '', signal: new AbortController().signal
    },
    sink: {
      text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop,
      usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop
    },
    control: { drainSteer: () => undefined, heartbeat: noop },
    host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } }
  }
}

/** A Claude-like agent: a turn runs until released or until the runtime's sign-out aborts it. */
function agent(options: { privateHome?: boolean; signOut?: () => Promise<void>; signIn?: DriverRuntime['signIn'] } = {}) {
  const running = new Set<AbortController>()
  const started: string[] = []
  const forgotten: string[] = []
  let release: () => void = noop
  const adapter: ProviderAdapter = {
    driver: 'claude',
    capabilities,
    configured: () => true,
    startTurn: async (input): Promise<TurnResult> => {
      started.push(input.attemptId)
      const controller = new AbortController()
      running.add(controller)
      await new Promise<void>((resolve) => {
        release = resolve
        controller.signal.addEventListener('abort', () => resolve(), { once: true })
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      running.delete(controller)
      return {
        text: 'ok', aborted: controller.signal.aborted || input.signal.aborted, modelName: input.model, totalResponseTimeMs: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [],
        providerRef: { provider: 'claude-subscription', instanceId: input.instanceId, model: input.model }
      }
    }
  }
  const runtimeSignOut = vi.fn(options.signOut ?? (async () => {
    // As Claude and Codex do: in-flight turns abort, the native sessions go.
    for (const controller of running) controller.abort()
  }))
  const runtimeSignIn = vi.fn(options.signIn ?? (async (session) => ({ success: true, sessionId: session.sessionId })))
  const base = adapterDriver(adapter, {
    runtime: {
      auth: async () => ({ state: 'signed_in', subject: 'account-a' }),
      forgetConversation: (threadId) => forgotten.push(threadId),
      signOut: runtimeSignOut,
      signIn: runtimeSignIn
    }
  })
  const driver: HarnessDriver = {
    ...base,
    privateHome: Boolean(options.privateHome),
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: Boolean(options.privateHome) })
  }
  return { driver, started, forgotten, runtimeSignOut, runtimeSignIn, release: () => release() }
}

function gateway(driver: HarnessDriver, instances: Record<string, unknown>) {
  const profileHome = mkdtempSync(join(tmpdir(), 'mousse-sign-out-'))
  dirs.push(profileHome)
  let stored: unknown = instances
  const map = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [driver], instances: map, profileHome })
  harnesses.push(harness)
  return { harness, stored: () => stored as Record<string, { config?: Record<string, unknown> }> }
}

async function bind(harness: Harness, instanceId: string) {
  const resolved = harness.resolveStored({ instanceId, llmProvider: 'claude-subscription', model: 'sonnet' }, { purpose: 'turn' })
  return harness.bind(resolved, { mode: 'agent' })
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code)

describe('sign-out in Mousse', () => {
  it('mid-turn: the turn ends interrupted, attempts are refused, and after a reconnect the next turn runs on a new session', async () => {
    const fake = agent()
    const { harness, stored } = gateway(fake.driver, { claude: { driver: 'claude', enabled: true } })
    const first = await bind(harness, 'claude')
    const turn = harness.startTurn(turnSpec(first, 'a1'))
    await vi.waitFor(() => expect(fake.started).toEqual(['a1']))

    await harness.instances.signOut('claude')
    expect(await turn.result).toMatchObject({ aborted: true })
    expect(stored().claude!.config).toMatchObject({ signedOutInMousse: true })
    // Every attempt is refused while signed out: a retry of the bound run and a new binding alike.
    expect(await codeOf(harness.startTurn(turnSpec(first, 'a2')).result)).toBe('signed_out')
    expect(await codeOf(bind(harness, 'claude'))).toBe('signed_out')
    expect(fake.started).toEqual(['a1'])

    // The user's own CLI sign-in: a reconnect clears the flag and starts no sign-in.
    await harness.instances.signIn('claude')
    expect(fake.runtimeSignIn).not.toHaveBeenCalled()
    expect(harness.signedOutInMousse('claude')).toBe(false)
    expect(stored().claude!.config).toMatchObject({ signedOutInMousse: false })
    // A retry bound before the sign-out never runs on the new account generation.
    expect(await codeOf(harness.startTurn(turnSpec(first, 'a3')).result)).toBe('binding_stale')

    const next = await bind(harness, 'claude')
    expect(next.accountGeneration).toBe(first.accountGeneration + 2)
    const resumed = harness.startTurn(turnSpec(next, 'a4', first))
    await vi.waitFor(() => expect(fake.started).toEqual(['a1', 'a4']))
    fake.release()
    expect(await resumed.result).toMatchObject({ aborted: false })
    // The native session from before is not resumed: history goes over to a new one.
    expect(fake.forgotten).toEqual(['thread'])
  })

  it('writes the flag before the runtime signs out, so nothing is admitted meanwhile', async () => {
    let flaggedDuring: boolean | undefined
    let refusedDuring: string | undefined
    let harnessRef: Harness | undefined
    const fake = agent({
      signOut: async () => {
        flaggedDuring = harnessRef!.signedOutInMousse('claude')
        refusedDuring = await codeOf(bind(harnessRef!, 'claude'))
      }
    })
    const { harness } = gateway(fake.driver, { claude: { driver: 'claude', enabled: true } })
    harnessRef = harness
    await harness.instances.signOut('claude')
    expect(flaggedDuring).toBe(true)
    expect(refusedDuring).toBe('signed_out')
  })

  it('a failed runtime sign-out leaves the flag set (fail closed) and can be retried', async () => {
    const fake = agent({ signOut: async () => { throw new Error('revoke failed') } })
    const { harness, stored } = gateway(fake.driver, { claude: { driver: 'claude', enabled: true } })
    await expect(harness.instances.signOut('claude')).rejects.toThrow('revoke failed')
    expect(harness.signedOutInMousse('claude')).toBe(true)
    expect(stored().claude!.config).toMatchObject({ signedOutInMousse: true })
    expect(await codeOf(bind(harness, 'claude'))).toBe('signed_out')
    const snapshot = (await harness.instances.snapshots({ kind: 'device' }))[0]!
    expect(snapshot.auth).toMatchObject({ state: 'signed_out', message: expect.stringContaining('Signed out in Mousse') })
    await expect(harness.instances.signOut('claude')).rejects.toThrow('revoke failed')
    expect(fake.runtimeSignOut).toHaveBeenCalledTimes(2)
  })

  it('a sign-in Mousse owns clears the flag only when it succeeds', async () => {
    let succeed = false
    const fake = agent({
      privateHome: true,
      signIn: async (session) => (succeed ? { success: true, sessionId: session.sessionId } : { success: false, sessionId: session.sessionId, error: 'cancelled' })
    })
    const { harness } = gateway(fake.driver, { 'claude:work': { driver: 'claude', enabled: true, config: { home: 'private' } } })
    await harness.instances.signOut('claude:work')
    const settled = () => new Promise<void>((resolve) => {
      const off = harness.instances.subscribe((event) => {
        if (event.type === 'operation' && (event.data.phase === 'completed' || event.data.phase === 'failed')) {
          off()
          resolve()
        }
      })
    })
    let done = settled()
    await harness.instances.signIn('claude:work')
    await done
    expect(fake.runtimeSignIn).toHaveBeenCalledTimes(1)
    // The operation ends right after it reports.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.signedOutInMousse('claude:work')).toBe(true)
    succeed = true
    done = settled()
    await harness.instances.signIn('claude:work')
    await done
    expect(harness.signedOutInMousse('claude:work')).toBe(false)
  })
})

describe('a pi provider signed out in Mousse', () => {
  it('a saved key signs it in again; a call that saved none leaves it signed out', async () => {
    let hasKey = true
    let accepts = false
    const pi = adapterDriver(new PiStubAdapter(), {
      runtime: { configured: () => hasKey, signOut: async () => { hasKey = false }, setSecret: async () => { if (accepts) hasKey = true } }
    })
    const { harness } = gateway(pi, { 'pi:openrouter': { driver: 'pi', enabled: true } })
    await harness.instances.signOut('pi:openrouter')
    expect(harness.signedOutInMousse('pi:openrouter')).toBe(true)
    // A key the credential store did not take leaves it signed out.
    await harness.instances.setSecret('pi:openrouter', 'fixture-refused')
    expect(harness.signedOutInMousse('pi:openrouter')).toBe(true)
    accepts = true
    await harness.instances.setSecret('pi:openrouter', 'fixture-key')
    expect(harness.signedOutInMousse('pi:openrouter')).toBe(false)
  })
})
