import { describe, expect, it, vi } from 'vitest'
import { AgentExecutionService } from '../../src/mms/agentDefinitions/AgentExecutionService'
import { createDefinitionRuntime, type DefinitionCheck, type DefinitionRefusal, type DefinitionTurnPort, type DefinitionTurnRequest, type DefinitionTurnResult } from '../../src/mms/agentDefinitions/definitionRuntime'
import { harnessAppError } from '../../src/shared/harness/types'
import { AppError } from '../../src/shared/errors'
import { resolvedDefinition } from '../fixtures/agent-platform/agent-runtime-policy/helpers'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { TurnInput } from '../../src/mms/run/adapters/ProviderAdapter'

// PR 4 §6 / §16 `definitionRuntime`: candidates are checked before they run, fallbacks only before
// a tool started, runtime-retried failures are never retried on the same candidate, and the time
// budget is a limit.

const primary = { providerId: 'p', modelId: 'primary', instanceId: 'pi:p' }
const second = { providerId: 'p', modelId: 'second', instanceId: 'pi:p' }
const third = { providerId: 'q', modelId: 'third', instanceId: 'pi:q' }

function definition(fallbacks = [second, third], retryCount = 0) {
  const resolved = resolvedDefinition()
  resolved.settings.primaryModel.ref = primary
  resolved.settings.fallbacks = { enabled: true, models: fallbacks, retryOn: [], allowHigherCost: true }
  resolved.settings.recovery.retryCount = retryCount
  resolved.settings.recovery.backoffMs = 0
  const profile = (ref: typeof primary) => ({ ref, available: true, capabilities: ['tools'], efforts: [], speeds: [], contexts: [], unavailableReasons: [] }) as never
  resolved.model = { primary: profile(primary), fallbacks: fallbacks.map(profile), capabilityOverrides: {} } as never
  return resolved
}

function port(options: { refuse?: (check: DefinitionCheck) => DefinitionRefusal | undefined; turn: (request: DefinitionTurnRequest) => Promise<DefinitionTurnResult> }) {
  const checks: DefinitionCheck[] = []
  const turns: DefinitionTurnRequest[] = []
  const value: DefinitionTurnPort = {
    checkDefinitionTurn: (check) => { checks.push(check); return options.refuse?.(check) },
    executeDefinitionTurn: (request) => { turns.push(request); return options.turn(request) }
  }
  return { value, checks, turns }
}

const ok = (text: string): DefinitionTurnResult => ({ text, history: [], usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 } })
const run = (service: AgentExecutionService, resolved = definition()) =>
  service.run({ profileId: resolved.profileId, resolved, threadId: 'thread-1', input: 'go', projectPath: process.cwd(), host: { workspaceRoots: [process.cwd()] } })

describe('definitionRuntime', () => {
  it('a refused primary fails the run with pointers, and never moves to a fallback', async () => {
    const p = port({
      refuse: (check) => check.ref.modelId === 'primary' ? { code: 'policy_unenforceable', message: 'Claude Code cannot hold it.', missing: ['toolControl'] } : undefined,
      turn: async () => ok('must not run')
    })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }))
    expect(result).toMatchObject({ status: 'failed', error: { code: 'SETTINGS_UNSUPPORTED', message: 'Claude Code cannot hold it.' } })
    expect(result.error!.details).toMatchObject({ code: 'policy_unenforceable', missing: ['toolControl'], pointers: ['/settings/tools/mode', '/settings/workspace/mode'] })
    expect(p.turns).toEqual([])
    expect(p.checks.map((check) => check.ref.modelId)).toEqual(['primary'])
  })

  it('a primary that cannot be reached (its provider turned off) moves to a fallback, as a failed attempt does', async () => {
    const p = port({
      refuse: (check) => check.ref.modelId === 'primary' ? { code: 'instance_disabled', message: 'Provider instance "pi:p" is turned off for this project.' } : undefined,
      turn: async (request) => ok(`ran ${request.ref.modelId}`)
    })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }))
    expect(result).toMatchObject({ status: 'completed', text: 'ran second' })
    expect(result.trace?.some((entry) => entry.includes('turned off'))).toBe(true)
    // Without fallbacks the run fails with that reason.
    const alone = port({ refuse: () => ({ code: 'instance_disabled', message: 'Provider instance "pi:p" is turned off for this project.' }), turn: async () => ok('x') })
    const failed = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(alone.value) }), definition([]))
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'SETTINGS_UNSUPPORTED' } })
    expect(failed.error!.message).toContain('turned off')
    expect(alone.turns).toEqual([])
  })

  it('reports the usage of every record, failed ones included', async () => {
    const p = port({
      turn: async (request) => {
        if (request.ref.modelId === 'primary') {
          request.effects.attemptUsage = { inputTokens: 40, outputTokens: 5, costUsd: 0.02, turns: 1, toolCalls: 0 }
          throw new Error('provider unavailable')
        }
        request.effects.attemptUsage = { inputTokens: 7, outputTokens: 2, costUsd: 0.01, turns: 1, toolCalls: 0 }
        return { text: 'fallback', history: [], usage: { inputTokens: 7, outputTokens: 2, costUsd: 0.01 } }
      }
    })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }))
    expect(result.status).toBe('completed')
    expect(result.usage).toMatchObject({ inputTokens: 47, outputTokens: 7, totalTokens: 54 })
    expect(result.usage.costUsd).toBeCloseTo(0.03)
    // The fallback ran with the turns the primary left.
    expect(p.turns[1]!.remaining.maxTurns).toBe(31)
  })

  it('a limit the earlier records used up ends the run with their usage reported', async () => {
    const resolved = definition([second])
    resolved.settings.limits.maxTurns = 1
    const p = port({
      turn: async (request) => {
        request.effects.attemptUsage = { inputTokens: 40, outputTokens: 5, costUsd: 0, turns: 1, toolCalls: 0 }
        throw new Error('provider unavailable')
      }
    })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), resolved)
    expect(result).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'turns', limit: 1 } } } })
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 5 })
    expect(p.turns).toHaveLength(1)
  })

  it('maps count and spend gaps to the limits they concern', async () => {
    const p = port({ refuse: () => ({ code: 'policy_unenforceable', message: 'no', missing: ['budgets', 'spendLimits'] }), turn: async () => ok('x') })
    const resolved = definition([])
    resolved.settings.limits.maxCostUsd = 1
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), resolved)
    expect(result.error!.details!.pointers).toEqual(['/settings/limits/maxTurns', '/settings/limits/maxToolCalls', '/settings/limits/maxCostUsd'])
  })

  it('skips a refused fallback with a trace entry and runs the next one', async () => {
    const p = port({
      refuse: (check) => check.ref.modelId === 'second' ? { code: 'policy_unenforceable', message: 'second cannot', missing: ['toolControl'] } : undefined,
      turn: async (request) => {
        if (request.ref.modelId === 'primary') throw new Error('provider unavailable')
        return ok(`ran ${request.ref.modelId}`)
      }
    })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }))
    expect(result).toMatchObject({ status: 'completed', text: 'ran third' })
    expect(p.turns.map((turn) => [turn.ref.modelId, turn.attempt])).toEqual([['primary', 1], ['third', 2]])
    expect(result.trace?.some((entry) => entry.includes('second cannot'))).toBe(true)
    // One allowance for the run: every record shares the same counters and ledger.
    expect(p.turns[0]!.counters).toBe(p.turns[1]!.counters)
    expect(p.turns[0]!.spend).toBe(p.turns[1]!.spend)
  })

  it('never falls back or retries after a tool started', async () => {
    const p = port({
      turn: async (request) => {
        request.onDispatched()
        throw new Error('provider unavailable')
      }
    })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), definition([second], 3))
    expect(result).toMatchObject({ status: 'failed', error: { message: 'provider unavailable' } })
    expect(p.turns).toHaveLength(1)
  })

  it('does not retry the same candidate after a failure the runtime already retried, and moves on', async () => {
    // retryCount 2: without the runtime's own retries this would be three requests on `primary`.
    const retried = harnessAppError({ code: 'service_unavailable', message: 'Pi gave up', retriesExhausted: true })
    const p = port({ turn: async (request) => { if (request.ref.modelId === 'primary') throw retried; return ok('second ran') } })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), definition([second], 2))
    expect(result).toMatchObject({ status: 'completed', text: 'second ran' })
    // One record per candidate: with the runtime's own retries, (maxRetries + 1) × candidates requests at most.
    expect(p.turns.map((turn) => turn.ref.modelId)).toEqual(['primary', 'second'])
  })

  it('does not retry a rate limit, timeout or unavailable failure on the same candidate either', async () => {
    for (const message of ['429 too many requests', 'request timed out', 'service unavailable']) {
      const p = port({ turn: async () => { throw new Error(message) } })
      await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), definition([], 2))
      expect(p.turns).toHaveLength(1)
    }
  })

  it('retries the same candidate only for a category the runtime does not retry', async () => {
    const resolved = definition([], 2)
    resolved.settings.fallbacks.retryOn = ['content_filter']
    let calls = 0
    const p = port({ turn: async () => { calls += 1; if (calls < 3) throw new Error('content filter refused'); return ok('third time') } })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), resolved)
    expect(result).toMatchObject({ status: 'completed', text: 'third time' })
    expect(p.turns.map((turn) => turn.attempt)).toEqual([1, 2, 3])
  })

  it('ends with the limit a count or spend refusal reports, not an error', async () => {
    const p = port({ turn: async () => { throw harnessAppError({ code: 'budget_exhausted', message: 'mousse_budget_exhausted', limit: { kind: 'tool_calls', limit: 64, actual: 64 } }) } })
    const result = await run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), definition([second]))
    expect(result).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'tool_calls', limit: 64 } } } })
    expect(p.turns).toHaveLength(1)
  })

  it('the time budget aborts the turn and ends with elapsed_ms, not a cancellation', async () => {
    vi.useFakeTimers()
    try {
      let seen: AbortSignal | undefined
      const p = port({
        turn: (request) => new Promise((_resolve, reject) => {
          seen = request.signal
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      })
      const resolved = definition([])
      resolved.settings.limits.maxElapsedMs = 1_000
      const pending = run(new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }), resolved)
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await pending
      expect(seen?.aborted).toBe(true)
      expect(result).toMatchObject({ status: 'failed', error: { code: 'BUDGET_EXCEEDED', details: { limit: { kind: 'elapsed_ms', limit: 1_000 } } } })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a caller's cancel is a cancellation", async () => {
    const controller = new AbortController()
    const p = port({ turn: (request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new AppError({ code: 'cancelled', message: 'stopped', errorInfo: { category: 'cancelled', retryable: false } })), { once: true })) })
    const resolved = definition([])
    const pending = new AgentExecutionService({ runtime: createDefinitionRuntime(p.value) }).run({ profileId: resolved.profileId, resolved, threadId: 'thread-1', input: 'go', projectPath: process.cwd(), host: { workspaceRoots: [process.cwd()] }, signal: controller.signal })
    await vi.waitFor(() => expect(p.turns).toHaveLength(1))
    controller.abort()
    expect(await pending).toMatchObject({ status: 'cancelled', error: { code: 'ABORTED' } })
  })
})

describe('the legacy loop and definition turns', () => {
  it('refuses a definition turn that lacks its authority, its loop, its instructions or a session of its own, before anything runs', async () => {
    const chat = vi.fn()
    const adapter = new PiLoopAdapter(() => ({ chat }))
    const input = { runId: 'r', attemptId: 'a', threadId: 't', cwd: null, instanceId: 'pi:p', model: 'm', llmProvider: 'p', modelPinned: true, mode: 'agent', prompt: 'go', messages: [], signal: new AbortController().signal } as unknown as TurnInput
    const noop = () => {}
    const sink = { text: noop, thinking: noop, tool: noop, nativeMessages: noop, compaction: noop, retry: noop, progress: noop, usage: noop, providerRef: noop, steerAccepted: noop, providerMetrics: noop, lineEdits: noop }
    const authority = { policy: {}, grants: { skills: [], mcpTools: [], builtinTools: [], denied: [] } } as never
    const loop = { client: () => ({ chat }), budget: {}, effects: {}, actor: { kind: 'agent' }, limitReached: noop } as never
    const host = (extra: object) => ({ tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' }, ...extra }) as never
    const full = { ...input, session: 'ephemeral', instructions: { text: 'SYSTEM', placement: 'replace' } } as TurnInput
    for (const [turn, extra] of [
      [full, { definitionLoop: loop }],
      [full, { definition: authority }],
      [{ ...full, session: undefined }, { definition: authority, definitionLoop: loop }],
      [{ ...full, instructions: undefined }, { definition: authority, definitionLoop: loop }],
      [{ ...full, instructions: { text: 'SYSTEM', placement: 'append' } }, { definition: authority, definitionLoop: loop }],
      [input, { definition: authority }]
    ] as Array<[TurnInput, object]>) {
      await expect(adapter.startTurn(turn, sink, { drainSteer: () => undefined, heartbeat: noop }, host(extra))).rejects.toMatchObject({ code: 'policy_unenforceable' })
    }
    expect(chat).not.toHaveBeenCalled()
  })
})
