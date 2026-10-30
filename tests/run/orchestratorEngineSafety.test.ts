/**
 * Review round 2 (docs/run-engine/SPEC.md §5, §12-§16) through a real `OrchestratorService`, Run
 * Engine and effect worker: a cancelled child never reaches its provider (C2), the pi path enforces
 * the caller's mode ceiling like the MCP server (C3), remote turns are engine runs and a busy thread
 * defers its wake instead of looping (C4), Stop follows `CommandPolicy.stopStrategy` (S2) and a
 * replayed stop re-enqueues its interrupt (M4), and thread deletion cancels the thread's work (H7).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import type { DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { McpToolError } from '../../src/mms/run/mcp/appTools'
import { Reconciler } from '../../src/mms/run/Reconciler'
import type { EffectRecord, ProviderRef } from '../../src/mms/run/types'
import { PI, phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

type HostScript = (input: TurnInput, delegation: DelegationToolHost | undefined) => Promise<string> | string

/** A pi-shaped adapter whose script sees the turn's delegation tools; counts interrupts. */
class HostAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly turns: TurnInput[] = []
  interrupts = 0
  constructor(
    private readonly script: HostScript,
    readonly capabilities: ProviderCapabilities = PI_TEST_CAPABILITIES
  ) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef: ProviderRef = { provider: input.llmProvider, model: input.model }
    sink.providerRef(providerRef)
    const text = await this.script(input, host.tools.delegation)
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const reply = {
      role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: input.llmProvider,
      model: input.model, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } as Message
    return {
      text, aborted: input.signal.aborted, modelName: 'Scripted', totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted',
      nativeMessages: [...input.messages, reply], providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    this.interrupts++
    return 'not_active'
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Resolves when `gate` opens or `signal` aborts (a turn that honours Stop and shutdown). */
const until = (gate: Promise<void>, signal: AbortSignal): Promise<void> =>
  Promise.race([gate, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))])

describe('orchestrator and engine safety (review round 2)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  const releases: Array<() => void> = []

  afterEach(async () => {
    for (const release of releases.splice(0)) release()
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const start = (adapter: ProviderAdapter): Phase6Daemon => {
    home = mkdtempSync(join(tmpdir(), 'mousse-engine-safety-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    daemon = phase6Daemon(home, [adapter])
    return daemon
  }

  const thread = (d: Phase6Daemon, name: string): string => {
    const created = d.store.createThread(name)
    d.orch.setThreadModelOverride(created.id, PI)
    return created.id
  }

  it('C2: a child cancelled while its claimed turn.start is still provisioning never calls its provider', async () => {
    let parentId = ''
    let delegationId = ''
    const adapter = new HostAdapter(async (input, delegation) => {
      if (input.threadId !== parentId) return 'child answered'
      const started = await delegation!.delegateTask({ prompt: 'Child work', workspace: 'isolated' }, { toolCallId: 'call-1' }) as { delegationId: string }
      delegationId = started.delegationId
      return 'delegated'
    })
    const d = start(adapter)
    parentId = thread(d, 'Parent')
    // Hold the child's executor after its claim, before the run is marked starting (workspace setup).
    const provisioning = deferred()
    const reached = deferred()
    releases.push(provisioning.resolve)
    const orch = d.orch as any
    const original = orch.runTurnOnSession.bind(orch)
    let childError: Error | undefined
    orch.runTurnOnSession = async (session: { threadId: string }, ...rest: unknown[]) => {
      if (session.threadId === parentId) return original(session, ...rest)
      reached.resolve()
      await provisioning.promise
      try {
        return await original(session, ...rest)
      } catch (error) {
        childError = error as Error
        throw error
      }
    }
    await d.orch.send('Delegate it', false, { threadId: parentId, clientRequestId: 'parent' })
    await reached.promise
    const delegation = d.engine.delegations.get(delegationId)!
    const childStart = d.engine.outbox.listForRun(delegation.childRunId).find((effect) => effect.kind === 'turn.start')!
    expect(childStart.status).toBe('running')
    expect(d.engine.getRun(delegation.childRunId)!.status).toBe('queued')

    await d.orch.cancelDelegation(parentId, delegationId)
    expect(d.engine.getRun(delegation.childRunId)).toMatchObject({ status: 'cancelled', outcome: { interruptedBy: 'user' } })
    expect(d.engine.outbox.get(childStart.effectId)!.status).toBe('cancelled')
    provisioning.resolve()
    await waitFor(() => childError !== undefined, 'the child turn to refuse to start')
    expect(childError!.message).toMatch(/cannot start \(cancelled\)/)
    expect(adapter.turns.filter((turn) => turn.threadId === delegation.childThreadId)).toEqual([])
    expect(d.engine.getRun(delegation.childRunId)!.status).toBe('cancelled')
    expect(d.engine.delegations.get(delegationId)!.status).toBe('cancelled')
  }, 30_000)

  it('C2: a turn.start claimed for a run that is no longer queued returns before the provider', async () => {
    const adapter = new HostAdapter(() => 'should not run')
    const d = start(adapter)
    const threadId = thread(d, 'Cancelled')
    const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: 'gone', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    d.engine.markTerminal(sent.runId, 'cancelled', { interruptedBy: 'user' })
    const payload = { runId: sent.runId, threadId, input: { content: 'x', mode: 'agent' }, reuseLastUser: false, displayUserMessage: true }
    const effect = d.engine.outbox.enqueue({ threadId, runId: sent.runId, kind: 'turn.start', payload })
    await waitFor(() => d.engine.outbox.get(effect.effectId)!.status === 'succeeded', 'the executor to skip the run')
    expect(adapter.turns).toEqual([])
    expect(d.orch.getMessages(threadId)).toEqual([])
  }, 30_000)

  it('C3: a plan-mode pi turn cannot start a default child or integrate; the MCP host refuses the same way', async () => {
    let parentId = ''
    const outcomes: Record<string, unknown> = {}
    const adapter = new HostAdapter(async (input, delegation) => {
      if (input.threadId !== parentId) return 'child'
      outcomes.broader = await delegation!.delegateTask({ prompt: 'Write code', workspace: 'isolated', modeCeiling: 'default' }, { toolCallId: 'broader' }).catch((error: unknown) => error)
      outcomes.integrate = await delegation!.integrateDelegation({ delegationId: 'delegation:any' }, { toolCallId: 'integrate' }).catch((error: unknown) => error)
      outcomes.inherited = await delegation!.delegateTask({ prompt: 'Plan it', workspace: 'isolated' }, { toolCallId: 'inherited' })
      return 'planned'
    })
    const d = start(adapter)
    parentId = thread(d, 'Planner')
    const response = await d.orch.send({ content: 'Plan the work', mode: 'plan' }, false, { threadId: parentId, clientRequestId: 'plan' })
    for (const key of ['broader', 'integrate']) {
      expect(outcomes[key]).toBeInstanceOf(McpToolError)
      expect((outcomes[key] as McpToolError).code).toBe('mousse_ceiling_exceeded')
    }
    const inherited = d.engine.delegations.get((outcomes.inherited as { delegationId: string }).delegationId)!
    expect(inherited.modeCeiling).toBe('plan')
    expect(d.engine.delegations.listForParentThread(parentId)).toHaveLength(1)

    // The MCP server's host for a plan-ceiling caller is the same dispatch.
    const mcp = d.orch.mcpToolHost().delegation({ threadId: parentId, runId: response.runId!, provider: 'claude-subscription', modeCeiling: 'plan' })
    const viaMcp = await mcp.integrateDelegation({ delegationId: inherited.delegationId }, { toolCallId: 'mcp-integrate' }).catch((error: unknown) => error)
    expect(viaMcp).toMatchObject({ code: 'mousse_ceiling_exceeded' })
    const broaderViaMcp = await mcp.delegateTask({ prompt: 'x', workspace: 'isolated', modeCeiling: 'default' }, { toolCallId: 'mcp-broader' }).catch((error: unknown) => error)
    expect(broaderViaMcp).toMatchObject({ code: 'mousse_ceiling_exceeded' })
  }, 30_000)

  it('C4: a remote turn is an engine run of its own source', async () => {
    const gate = deferred()
    releases.push(gate.resolve)
    const adapter = new HostAdapter(async (input) => {
      await until(gate.promise, input.signal)
      return `remote reply to ${input.prompt}`
    })
    const d = start(adapter)
    const threadId = thread(d, 'Remote')
    const turn = d.orch.runRemoteTurn(threadId, 'From a phone', d.store)
    await waitFor(() => adapter.turns.length === 1, 'the remote turn')
    const run = d.engine.listRuns(threadId)[0]
    expect(run).toMatchObject({ source: 'remote', status: 'running' })
    gate.resolve()
    expect(await turn).toMatchObject({ text: 'remote reply to From a phone' })
    expect(d.engine.getRun(run.runId)!.status).toBe('completed')
  }, 30_000)

  it('C4: a wake on a thread busy with a turn the engine does not schedule stays queued (one wake run) and runs once after', async () => {
    const gate = deferred()
    releases.push(gate.resolve)
    const adapter = new HostAdapter(async (input) => {
      if (input.prompt === 'busy legacy turn') await until(gate.promise, input.signal)
      return `reply to ${input.prompt}`
    })
    const d = start(adapter)
    ;(d.orch as any).wakeBusyDeferMs = 150
    const threadId = thread(d, 'Busy')
    // A turn without a run (a workflow or legacy turn): the engine sees no active run.
    const session = d.orch.getOrCreateSession(threadId)
    const busy = (d.orch as any).runTurnOnSession(session, { content: 'busy legacy turn', mode: 'agent' }, false, true, {}) as Promise<unknown>
    await waitFor(() => adapter.turns.length === 1, 'the busy turn')
    d.engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { type: 'note', text: 'Something finished.' } })
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })
    for (let pass = 0; pass < 3; pass++) {
      reconciler.runOnce()
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    const wakes = () => d.engine.listRuns(threadId).filter((run) => run.source === 'wake')
    expect(wakes()).toHaveLength(1)
    expect(wakes()[0].status).toBe('queued')
    const wakeEffect = d.engine.outbox.listForRun(wakes()[0].runId)[0] as EffectRecord
    expect(d.engine.outbox.listForRun(wakes()[0].runId)).toHaveLength(1)
    expect(['pending', 'running']).toContain(wakeEffect.status)
    expect(d.engine.listEvents(threadId).some((event) => event.type === 'effect.status' && (event.payload as EffectRecord).lastError === 'thread_busy')).toBe(true)
    expect(adapter.turns).toHaveLength(1)

    gate.resolve()
    await busy
    await waitFor(() => wakes()[0].status === 'completed', 'the deferred wake to run')
    reconciler.runOnce()
    expect(wakes()).toHaveLength(1)
    expect(adapter.turns.map((turn) => turn.prompt).filter((prompt) => prompt.includes('Something finished.'))).toHaveLength(1)
  }, 30_000)

  it('S2/M4: Stop with nothing live settles the run locally; a replayed stop re-enqueues its interrupt', async () => {
    const adapter = new HostAdapter(() => 'unused')
    const d = start(adapter)
    const threadId = thread(d, 'Orphan')
    // An active run with no turn in this process (its executor is gone).
    const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: 'orphan', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    d.engine.markStarting(sent.runId)
    d.engine.markRunning(sent.runId)
    d.engine.recordProviderRef(sent.runId, { provider: PI.llmProvider, model: PI.model })
    const result = await d.orch.abortRun(sent.runId, 'stop-1', threadId)
    expect(result.status).toBe('accepted')
    await waitFor(() => d.engine.getRun(sent.runId)!.status === 'interrupted', 'the local settlement')
    expect(d.engine.getRun(sent.runId)!.outcome).toMatchObject({ interruptedBy: 'user', stopStrategy: 'interrupt', stopRequested: true })
    expect(adapter.interrupts).toBe(1)

    // A live turn that ignores the first interrupt: the replayed stop enqueues a second one.
    const gate = deferred()
    releases.push(gate.resolve)
    const stubborn = d.engine
    const live = await stubborn.dispatch({ kind: 'send', threadId, clientRequestId: 'live', source: 'gui' })
    if (live.status !== 'accepted') throw new Error('send rejected')
    stubborn.markStarting(live.runId)
    stubborn.markRunning(live.runId)
    ;(d.orch as any).getOrCreateSession(threadId).turnAdmitted = true
    await d.orch.abortRun(live.runId, 'stop-2', threadId)
    const interrupts = () => d.engine.outbox.listForRun(live.runId).filter((effect) => effect.kind === 'turn.interrupt')
    await waitFor(() => interrupts()[0]?.status === 'succeeded', 'the first interrupt')
    expect(d.engine.getRun(live.runId)!.status).toBe('running')
    const replay = await d.orch.abortRun(live.runId, 'stop-2', threadId)
    expect(replay).toMatchObject({ status: 'accepted', replayed: true })
    expect(interrupts()).toHaveLength(2)
    ;(d.orch as any).getOrCreateSession(threadId).turnAdmitted = false
  }, 30_000)

  it('H7: deleting a thread cancels its delegations depth-first, its queued runs and its inbox', async () => {
    let parentId = ''
    let delegationId = ''
    const childGate = deferred()
    releases.push(childGate.resolve)
    const adapter = new HostAdapter(async (input, delegation) => {
      if (input.threadId === parentId) {
        const started = await delegation!.delegateTask({ prompt: 'Long child work', workspace: 'isolated' }, { toolCallId: 'call-1' }) as { delegationId: string }
        delegationId = started.delegationId
        return 'delegated'
      }
      await until(childGate.promise, input.signal)
      return 'child done'
    })
    const d = start(adapter)
    parentId = thread(d, 'Doomed')
    await d.orch.send('Delegate it', false, { threadId: parentId, clientRequestId: 'doomed' })
    const delegation = d.engine.delegations.get(delegationId)!
    await waitFor(() => d.engine.getRun(delegation.childRunId)!.status === 'running', 'the child turn')
    const queued = await d.engine.dispatch({ kind: 'send', threadId: parentId, clientRequestId: 'queued-later', source: 'gui' })
    if (queued.status !== 'accepted') throw new Error('send rejected')
    d.engine.inbox.append({ threadId: parentId, kind: 'reconcile_notice', payload: { type: 'note', text: 'pending' } })

    d.orch.markThreadDeleted(parentId)
    await waitFor(() => d.engine.getRun(delegation.childRunId)!.status === 'interrupted', 'the child to stop')
    expect(d.engine.delegations.get(delegationId)!.status).toBe('cancelled')
    expect(d.engine.getRun(delegation.childRunId)!.outcome?.stopRequested).toBe(true)
    await waitFor(() => d.engine.getRun(queued.runId)!.status === 'cancelled', 'the queued run')
    expect(d.engine.inbox.listForThread(parentId).map((row) => row.status)).toEqual(['acknowledged'])
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools })
    expect(reconciler.runOnce().wakes.wakes).toEqual([])
  }, 30_000)
})
