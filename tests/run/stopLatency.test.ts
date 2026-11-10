/**
 * Stop latency guarantees, with a real orchestrator, Run Engine and effect worker and a provider that does not let go
 * of a stopped turn until the test releases it (a slow or deaf runtime):
 * - the thread shows stopped as soon as the Stop is recorded, before the provider has let go, and what the provider
 *   sends after it never makes the thread look busy again;
 * - a message the person sends while the stopped turn still ends goes first and runs as soon as it has ended, and what
 *   they queued before the Stop stays queued behind it.
 * No wall-clock thresholds: each step waits for an event, never for a time.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const HOLD = 'Hold this turn'

/** A provider whose "hold" turns stream a little, then run until the test releases them: a Stop alone does not end them. */
class DeafAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  readonly sinks: TurnSink[] = []
  private readonly held = new Set<() => void>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    this.sinks.push(sink)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const hold = input.prompt.includes(HOLD)
    if (hold) {
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: 'Working on it', contentIndex: 0 })
      await new Promise<void>((resolve) => { this.held.add(resolve) })
    }
    const text = hold ? '' : 'Done'
    if (!hold) {
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(text)
    }
    return { text, aborted: hold, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  /** Acknowledges the interrupt but goes on: only `release` ends a held turn. */
  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return this.held.size ? 'interrupted' : 'not_active'
  }

  release(): void {
    const waiting = [...this.held]
    this.held.clear()
    for (const resolve of waiting) resolve()
  }

  get holding(): boolean {
    return this.held.size > 0
  }
}

describe('Stop latency', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-stop-latency-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const adapter = new DeafAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES)
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const thread = d.store.createThread('Stop latency')
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const phases: string[] = []
    d.orch.on('turn-state', (state: { threadId: string; phase: string }) => {
      if (state.threadId === thread.id) phases.push(state.phase)
    })
    const running = () => d.orch.getOrCreateSession(thread.id).isTurnRunning()
    const pending = () => readDurableQueue(d.store, thread.id).filter((item) => item.state === 'pending').map((item) => item.content)
    return { d, adapter, thread, phases, running, pending }
  }

  it('shows the turn stopped before the provider lets go, and nothing the provider sends after makes it busy again', async () => {
    const w = world()
    await w.d.orch.send(HOLD, false, { threadId: w.thread.id, clientRequestId: 'hold', awaitMode: 'ack' })
    await waitFor(() => w.adapter.holding && w.d.orch.getTurnState(w.thread.id).phase === 'streaming', 'the turn to stream')

    await w.d.orch.stopThread(w.thread.id, 'user')
    // The provider still holds the turn, and the thread already shows stopped.
    expect(w.adapter.holding).toBe(true)
    expect(w.running()).toBe(true)
    expect(w.d.orch.getTurnState(w.thread.id).phase).toBe('stopped')

    // What the provider sends before it lets go is not shown as a running turn.
    const sink = w.adapter.sinks[0]!
    sink.text({ phase: 'delta', content: ' still going', contentIndex: 0 })
    sink.tool({ kind: 'build_tool_call', phase: 'start', callId: 'late', title: 'Bash', summary: 'Bash', details: ['Tool: Bash'] })
    expect(w.d.orch.getTurnState(w.thread.id).phase).toBe('stopped')
    const sinceStop = w.phases.slice(w.phases.lastIndexOf('stopped'))
    expect(sinceStop.filter((phase) => phase !== 'stopped')).toEqual([])

    w.adapter.release()
    await waitFor(() => !w.running(), 'the stopped turn to end')
    expect(w.d.orch.getTurnState(w.thread.id).phase).toBe('stopped')
    expect(w.d.engine.listRuns(w.thread.id).map((run) => run.status)).toEqual(['interrupted'])
  })

  it('runs a message sent while the stopped turn ends as soon as it has ended, ahead of what was queued before the Stop', async () => {
    const w = world()
    await w.d.orch.send(HOLD, false, { threadId: w.thread.id, clientRequestId: 'hold', awaitMode: 'ack' })
    await waitFor(() => w.adapter.holding, 'the turn to reach the provider')
    const before = await w.d.orch.send('queued before the Stop', false, { threadId: w.thread.id, clientRequestId: 'before', awaitMode: 'ack' })
    expect(before.queued).toBe(true)

    await w.d.orch.stopThread(w.thread.id, 'user')
    // The thread shows stopped; the person sends their next message while the stopped turn still ends.
    const after = await w.d.orch.send('sent after the Stop', false, { threadId: w.thread.id, clientRequestId: 'after', awaitMode: 'ack' })
    expect(after.queued).toBe(true)
    expect(w.pending()).toEqual(['sent after the Stop', 'queued before the Stop'])

    // It runs as soon as the stopped turn has ended, with nothing else to start it.
    w.adapter.release()
    await waitFor(() => w.adapter.turns.length >= 2, 'the message sent after the Stop to run')
    expect(w.adapter.turns[1]!.prompt).toContain('sent after the Stop')
    // The message queued before the Stop is kept, and goes once that turn has finished, as after any finished turn.
    await waitFor(() => w.adapter.turns.length === 3 && !w.running() && w.pending().length === 0, 'the earlier message to run after it')
    expect(w.adapter.turns[2]!.prompt).toContain('queued before the Stop')
  })

  it('runs several messages sent after the Stop in the order they were sent, all ahead of what was queued before it', async () => {
    const w = world()
    await w.d.orch.send(HOLD, false, { threadId: w.thread.id, clientRequestId: 'hold', awaitMode: 'ack' })
    await waitFor(() => w.adapter.holding, 'the turn to reach the provider')
    await w.d.orch.send('queued before the Stop', false, { threadId: w.thread.id, clientRequestId: 'before', awaitMode: 'ack' })

    await w.d.orch.stopThread(w.thread.id, 'user')
    await w.d.orch.send('A sent after the Stop', false, { threadId: w.thread.id, clientRequestId: 'a', awaitMode: 'ack' })
    await w.d.orch.send('B sent after the Stop', false, { threadId: w.thread.id, clientRequestId: 'b', awaitMode: 'ack' })
    expect(w.pending()).toEqual(['A sent after the Stop', 'B sent after the Stop', 'queued before the Stop'])

    w.adapter.release()
    await waitFor(() => w.adapter.turns.length === 4 && !w.running() && w.pending().length === 0, 'every queued message to run')
    expect(w.adapter.turns.slice(1).map((turn) => turn.prompt.match(/A sent|B sent|queued before/)?.[0])).toEqual(['A sent', 'B sent', 'queued before'])
  })

  it('leaves a message sent with Queue queued behind a stopped turn, as before', async () => {
    const w = world()
    await w.d.orch.send(HOLD, false, { threadId: w.thread.id, clientRequestId: 'hold', awaitMode: 'ack' })
    await waitFor(() => w.adapter.holding, 'the turn to reach the provider')
    await w.d.orch.stopThread(w.thread.id, 'user')
    const queued = await w.d.orch.send('queue this', false, { threadId: w.thread.id, clientRequestId: 'queued', forceQueue: true, awaitMode: 'ack' })
    expect(queued.queued).toBe(true)
    w.adapter.release()
    await waitFor(() => !w.running(), 'the stopped turn to end')
    expect(w.adapter.turns).toHaveLength(1)
    expect(w.pending()).toEqual(['queue this'])
  })
})
