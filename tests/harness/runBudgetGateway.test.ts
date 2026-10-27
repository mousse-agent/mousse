import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import type { TurnSpec } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'

// PR 4 4b2 through the real gateway: the run's budget reaches the runtime, attempts share it, a
// later attempt with no record fails closed, settlement drops it, and a definition's authority
// reaches the runtime only from the turn's app context.

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const noop = () => {}
const sink = (): TurnSink => ({ text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop })

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-budget-gw-'))
  homes.push(home)
  const hosts: AdapterHost[] = []
  // Each turn makes one model request through the budget, as the Pi engine's `/pi/request` does.
  const decisions: unknown[] = []
  const adapter: ProviderAdapter = {
    driver: 'claude',
    capabilities: CLAUDE_SUBSCRIPTION_CAPABILITIES,
    configured: () => true,
    startTurn: async (input, _sink, _ctl, adapterHost) => {
      hosts.push(adapterHost)
      decisions.push(adapterHost.budget?.request())
      return { text: 'ok', aborted: false, modelName: input.model, totalResponseTimeMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextSignature: 's', nativeMessages: [], providerRef: { provider: 'p' } }
    },
    interrupt: async () => 'not_active'
  }
  let stored: unknown
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [adapterDriver(adapter, { budgets: 'hard' })], instances, profileHome: home })
  const turn = async (runId: string, patch: Partial<TurnSpec> & { maxTurns?: number } = {}) => {
    const { maxTurns = 1, ...rest } = patch
    const bound = await harness.bind(harness.resolveStored({ instanceId: 'claude', llmProvider: '', model: 'm' }, { purpose: 'turn' }), { mode: 'agent' })
    const binding = { ...bound, policy: { ...bound.policy, budget: { maxTurns } } }
    const input: TurnInput = { runId, attemptId: `${runId}:a`, threadId: 'thread-1', cwd: '/work', instanceId: 'claude', model: 'm', llmProvider: 'claude', modelPinned: true, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal }
    const spec: TurnSpec = {
      binding,
      input,
      sink: sink(),
      control: { drainSteer: () => undefined, heartbeat: noop },
      host: { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } },
      ...rest
    }
    await harness.startTurn(spec).result
    return { host: hosts.at(-1)!, decision: decisions.at(-1) }
  }
  return { harness, turn }
}

const authority = (id: string) => ({ policy: { definitionId: id }, grants: { skills: [], mcpTools: [], builtinTools: [], denied: [] } }) as unknown as DefinitionAuthority
const app = (definition?: DefinitionAuthority): NonNullable<TurnSpec['app']> => ({
  turnToken: 'tt', modeCeiling: 'default', mcpEligible: false, instructions: () => ({ sessionInstructions: '', turnPreamble: '' }), ...(definition ? { definition } : {})
})

describe('count budgets through the gateway', () => {
  it('attempts of one run share its counts; a later attempt with no record fails closed; a settled run is refused', async () => {
    const s = setup()
    expect((await s.turn('run-1')).decision).toEqual({ ok: true })
    // A retry of the same run (attempt 2), even with a looser limit, continues the count.
    expect((await s.turn('run-1', { attemptOrdinal: 2, maxTurns: 2 })).decision).toEqual({ ok: true })
    expect((await s.turn('run-1', { attemptOrdinal: 3, maxTurns: 2 })).decision).toMatchObject({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
    // Recovered after a restart: no record of its first attempt here.
    expect((await s.turn('run-from-before', { attemptOrdinal: 2, maxTurns: 5 })).decision).toMatchObject({ ok: false, limit: { kind: 'turns', limit: 5 } })
    // Settled: a late attempt never gets fresh counts.
    expect((await s.turn('run-2', { maxTurns: 5 })).decision).toEqual({ ok: true })
    s.harness.runSettled('run-2')
    expect((await s.turn('run-2', { maxTurns: 5 })).decision).toMatchObject({ ok: false })
    s.harness.stop()
  })

  it('the runtime gets a definition authority only from the app context, never from the caller’s host', async () => {
    const s = setup()
    const fromApp = authority('from-app')
    expect((await s.turn('run-a', { app: app(fromApp), maxTurns: 9 })).host.definition).toBe(fromApp)
    const smuggled = await s.turn('run-b', { app: app(), maxTurns: 9, host: { tools: {}, definition: authority('from-host'), context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } } })
    expect(smuggled.host.definition).toBeUndefined()
    s.harness.stop()
  })
})
