/**
 * Runtime facts (agent CLIs plan §2): what a runtime reports about itself is kept per instance,
 * feeds `caps`, is dropped when the instance's executable changes in place, and never changes the
 * caps a binding already froze.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeInstanceConfig, type DriverRuntime, type HarnessDriver, type RuntimeFactsReport } from '../../src/mms/harness/driver'
import { CLAUDE_CODE_CAPS } from '../../src/mms/harness/drivers/claudeCode'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { fingerprintOf } from '../../src/mms/harness/status'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { ProviderAdapter, TurnInput, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { testHarness } from '../../src/mms/run/testkit/harness'

class Finishing implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = { ...CLAUDE_CODE_CAPS }
  async startTurn(input: TurnInput, sink: Parameters<ProviderAdapter['startTurn']>[1]): Promise<TurnResult> {
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

/**
 * An agent whose `initialize` answer depends on its launch arguments: `--plan` advertises a Plan
 * mode. A sign-in teaches it the account's modes. Each handshake is counted.
 */
function factsDriver(handshakes: string[]): HarnessDriver {
  return {
    kind: 'claude',
    label: 'Facts agent',
    binaryNames: ['mousse-facts-agent-never-on-path'],
    multiInstance: true,
    privateHome: false,
    canInstall: false,
    customModels: true,
    decodeConfig: (raw) => decodeInstanceConfig(raw, { privateHome: false }),
    versionArgs: () => null,
    caps: (_config, _version, facts) => ({
      ...CLAUDE_CODE_CAPS,
      planMode: Boolean(facts?.modes?.some((mode) => mode.id === 'plan')),
      fork: facts?.agentCapabilities?.fork ? 'native' : 'portable'
    }),
    create(context) {
      let report: RuntimeFactsReport | undefined
      const runtime: DriverRuntime = {
        adapter: new Finishing(),
        configured: () => true,
        models: () => [],
        auth: async () => ({ state: 'signed_in' }),
        handshake: async () => {
          handshakes.push(context.instanceId)
          // A program that no longer starts: the check fails and, like a careless runtime, the old
          // report stays.
          if (readFileSync(context.config.binaryPath!, 'utf8').includes('broken')) throw new Error('exited with code 1')
          report = {
            binary: fingerprintOf(context.config.binaryPath)!,
            agentCapabilities: { fork: context.config.args?.includes('--fork') === true },
            modes: context.config.args?.includes('--plan') ? [{ id: 'plan', name: 'Plan' }] : [],
            capturedAt: new Date().toISOString(),
            source: 'handshake'
          }
        },
        runtimeFacts: () => report,
        signIn: async (session) => {
          report = { ...report!, modes: [{ id: 'plan', name: 'Plan' }], source: 'session' }
          return { success: true, sessionId: session.sessionId }
        },
        refreshModels: async () => {
          report = { ...report!, modes: [], source: 'session' }
        },
        stop: () => {}
      }
      return runtime
    }
  }
}

describe('runtime facts', () => {
  const homes: string[] = []
  const harnesses: Harness[] = []
  afterEach(() => {
    vi.useRealTimers()
    for (const harness of harnesses.splice(0)) harness.stop()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function fixture(entries: Record<string, string[]>, reuse?: string) {
    const home = reuse ?? mkdtempSync(join(tmpdir(), 'mousse-facts-'))
    if (!reuse) homes.push(home)
    const binary = join(home, 'agent.exe')
    if (!reuse) writeFileSync(binary, 'agent v1', { mode: 0o755 })
    let stored: unknown = Object.fromEntries(Object.entries(entries).map(([id, args]) => [id, { driver: 'claude', enabled: true, config: { binaryPath: binary, args } }]))
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const handshakes: string[] = []
    let clock = Date.now()
    const harness = testHarness({ drivers: [factsDriver(handshakes)], instances, profileHome: home, now: () => clock })
    harnesses.push(harness)
    const caps = (instanceId: string) => harness.resolveStored({ instanceId, llmProvider: '', model: 'm' }, { purpose: 'turn' }).caps
    const spec = (binding: TurnSpec['binding']): TurnSpec => ({
      binding,
      input: { threadId: 't', instanceId: binding.instanceId, llmProvider: 'claude-subscription', model: 'm', mode: binding.policy.mode === 'plan' ? 'plan' : 'agent', prompt: 'hi', signal: new AbortController().signal } as unknown as TurnInput,
      sink: { providerRef: () => {} } as unknown as TurnSpec['sink'],
      control: {} as TurnSpec['control'],
      host: {} as TurnSpec['host']
    })
    return { home, harness, binary, handshakes, caps, spec, tick: (ms: number) => { clock += ms } }
  }

  it('checks a changed executable that no longer starts once, and not again after a restart', async () => {
    const { home, harness, binary, handshakes, caps, tick } = fixture({ 'claude:one': ['--plan'] })
    // The app always listens: every change publishes snapshots, which read the facts again.
    harness.instances.subscribe(() => {})
    await harness.instances.recheck('claude:one')
    expect(caps('claude:one').planMode).toBe(true)
    writeFileSync(binary, 'agent v2, broken')
    tick(11 * 60_000)
    await harness.instances.snapshots({ kind: 'device' })
    await vi.waitFor(() => expect(caps('claude:one').planMode).toBe(false))
    await vi.waitFor(() => expect(handshakes).toHaveLength(2))
    for (let round = 0; round < 5; round += 1) {
      await harness.instances.snapshots({ kind: 'device' })
      caps('claude:one')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(handshakes).toHaveLength(2)
    // The failed check's leftover report (about the old program) was never stored: the facts were
    // dropped once and stayed dropped.
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'claude:one', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    expect(binding.factsRevision).toBe(2)
    harness.stop()
    const restarted = fixture({ 'claude:one': ['--plan'] }, home)
    restarted.harness.instances.subscribe(() => {})
    await restarted.harness.instances.snapshots({ kind: 'device' })
    for (let round = 0; round < 5; round += 1) {
      restarted.caps('claude:one')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(restarted.handshakes).toEqual([])
    expect(restarted.caps('claude:one').planMode).toBe(false)
  })

  it('keeps facts per instance: one executable with different options gives different caps', async () => {
    const { harness, caps } = fixture({ 'claude:plain': [], 'claude:planner': ['--plan', '--fork'] })
    // Before any handshake the static preset applies.
    expect(caps('claude:planner')).toMatchObject({ planMode: false, fork: 'portable' })
    await harness.instances.recheck('claude:plain')
    await harness.instances.recheck('claude:planner')
    expect(caps('claude:plain')).toMatchObject({ planMode: false, fork: 'portable' })
    expect(caps('claude:planner')).toMatchObject({ planMode: true, fork: 'native' })
    expect((await harness.instances.snapshots({ kind: 'device' })).find((entry) => entry.instanceId === 'claude:planner')?.caps.planMode).toBe(true)
  })

  it('takes the facts a sign-in verification learned', async () => {
    const { harness, caps } = fixture({ 'claude:one': [] })
    await harness.instances.recheck('claude:one')
    expect(caps('claude:one').planMode).toBe(false)
    const started = await harness.instances.signIn('claude:one')
    await vi.waitFor(() => expect(caps('claude:one').planMode).toBe(true))
    expect(started.kind).toBe('sign_in')
  })

  it('keeps the caps a binding froze when the facts change', async () => {
    const { harness, caps, spec } = fixture({ 'claude:one': ['--plan'] })
    await harness.instances.recheck('claude:one')
    const resolved = harness.resolveStored({ instanceId: 'claude:one', llmProvider: '', model: 'm' }, { purpose: 'turn' })
    const binding = await harness.bind(resolved, { mode: 'plan' })
    expect(binding.caps?.planMode).toBe(true)
    expect(binding.factsRevision).toBe(1)
    // "Refresh models" learns the account has no Plan mode: new turns lose it, this attempt keeps it.
    await harness.instances.refreshModels('claude:one')
    expect(caps('claude:one').planMode).toBe(false)
    await expect(harness.startTurn(spec(binding)).result).resolves.toMatchObject({ text: 'ok' })
    const fresh = await harness.bind(harness.resolveStored({ instanceId: 'claude:one', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'plan' })
    await expect(harness.startTurn(spec(fresh)).result).rejects.toMatchObject({ code: 'policy_unenforceable' })
  })

  it('drops the facts of an executable replaced in place and refuses a retry on the old binding', async () => {
    const { harness, binary, handshakes, caps, spec, tick } = fixture({ 'claude:one': ['--plan'] })
    await harness.instances.recheck('claude:one')
    const binding = await harness.bind(harness.resolveStored({ instanceId: 'claude:one', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    expect(binding.binary?.path).toBe(binary)
    // A self-update writes a new program at the same path; the next periodic check sees it.
    writeFileSync(binary, 'agent v2, a little longer')
    tick(11 * 60_000)
    await harness.instances.snapshots({ kind: 'device' })
    // Once the check recorded the new program, its old facts no longer apply: the static preset does.
    await vi.waitFor(() => expect(caps('claude:one').planMode).toBe(false))
    // A start-up check was queued; it records the new program's facts.
    await vi.waitFor(() => expect(caps('claude:one').planMode).toBe(true))
    expect(handshakes).toEqual(['claude:one', 'claude:one'])
    await expect(harness.startTurn(spec(binding)).result).rejects.toMatchObject({ code: 'binding_stale' })
  })
})
