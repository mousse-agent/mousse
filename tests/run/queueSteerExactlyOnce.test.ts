/**
 * Steer (Send now) on a queued message, end to end: a real `OrchestratorService`, Run Engine and effect worker, with a
 * provider stand-in that takes steers while its turn runs, the way Claude's live turn and Pi do (drain, then
 * acknowledge). Messages A, B and C are queued behind a running turn and C is steered: exactly C joins the turn, A
 * and B run after it in order, every message reaches the provider exactly once, and nothing that was not sent
 * appears. Also when Steer is clicked twice, when the turn ends as Steer lands, after Stop, and while the queue
 * drains.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const NL = String.fromCharCode(10)
const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }

/** A provider whose turns take steers while they run, and hold until released or interrupted. */
class SteeringAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  /** Every prompt a turn started with, in order. */
  readonly prompts: string[] = []
  /** Every steer text a turn took, in order. */
  readonly steers: string[] = []
  /** Whether a turn whose prompt is this text is held until `release`. */
  holdPrompts = new Set<string>()
  /** Whether turns take steers at all (a turn that never reads one leaves it to the orchestrator). */
  takeSteers = true
  private readonly releases = new Map<string, () => void>()
  private readonly interrupts = new Set<() => void>()
  /** The runs started, by prompt. */
  readonly runs = new Map<string, string>()

  configured(): boolean {
    return true
  }

  release(prompt: string): void {
    this.holdPrompts.delete(prompt)
    this.releases.get(prompt)?.()
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.prompts.push(input.prompt)
    this.runs.set(input.prompt, input.runId)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    let aborted = false
    const take = (): void => {
      if (!this.takeSteers || aborted) return
      const entry = ctl.drainSteerEntry ? ctl.drainSteerEntry() : undefined
      const text = entry ? entry.text : ctl.drainSteer()
      if (!text) return
      this.steers.push(text)
      ctl.steerTaken?.(entry?.token)
      sink.steerAccepted(text)
    }
    if (this.holdPrompts.has(input.prompt)) {
      await new Promise<void>((resolve) => {
        const timer = setInterval(take, 5)
        const done = (): void => {
          clearInterval(timer)
          this.releases.delete(input.prompt)
          this.interrupts.delete(onInterrupt)
          resolve()
        }
        const onInterrupt = (): void => {
          aborted = true
          done()
        }
        this.releases.set(input.prompt, done)
        this.interrupts.add(onInterrupt)
        if (input.signal.aborted) onInterrupt()
        else input.signal.addEventListener('abort', onInterrupt, { once: true })
      })
    }
    take()
    const text = aborted ? '' : `reply to ${input.prompt}`
    if (!aborted) {
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(text)
    }
    return {
      text,
      aborted,
      modelName: 'Scripted',
      totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted',
      nativeMessages: [],
      providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    const listeners = [...this.interrupts]
    for (const listener of listeners) listener()
    return listeners.length ? 'interrupted' : 'not_active'
  }
}

describe('Steer on a queued message runs exactly that message, exactly once', () => {
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
    home = mkdtempSync(join(tmpdir(), 'mousse-steer-once-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    const adapter = new SteeringAdapter()
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(join(home, 'project'))
    const thread = d.store.createThread('Steer', project.id)
    d.orch.setThreadModelOverride(thread.id, MODEL)
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    const queue = () => readDurableQueue(d.store, thread.id)
    const pending = () => d.orch.listQueue(thread.id).map((item) => item.content)
    const userMessages = () => d.orch.getOrCreateSession(thread.id).messages.filter((message) => message.role === 'user').map((message) => message.content)
    /** The person's messages as the transcript shows them (hidden copies left out). */
    const shownUserMessages = () => d.orch.getOrCreateSession(thread.id).messages.filter((message) => message.role === 'user' && !message.hidden).map((message) => message.content)
    const idle = async (label: string): Promise<void> => {
      await waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && queue().length === 0 && d.engine.getActiveRun(thread.id) === null, label)
      // Nothing more starts once the queue is empty.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    /** A running first turn with A, B and C queued behind it. */
    const queuedBehindTurn = async () => {
      adapter.holdPrompts.add('first')
      const first = send('first')
      await waitFor(() => adapter.prompts.includes('first'), 'first turn')
      const a = await send('A')
      const b = await send('B')
      const c = await send('C')
      for (const queued of [a, b, c]) expect(queued.queued).toBe(true)
      expect(pending()).toEqual(['A', 'B', 'C'])
      return { first, a: a.queueItem!, b: b.queueItem!, c: c.queueItem! }
    }
    return { d, adapter, thread, send, queue, pending, userMessages, shownUserMessages, idle, queuedBehindTurn }
  }

  /** Each text reached the provider once: as a turn's prompt or as a steer, never both, never twice. */
  const expectEachOnce = (adapter: SteeringAdapter, texts: string[]): void => {
    const delivered = [...adapter.prompts, ...adapter.steers]
    for (const text of texts) expect(delivered.filter((seen) => seen === text), text).toHaveLength(1)
    expect([...delivered].sort()).toEqual([...texts].sort())
  }

  it('steers exactly C into the running turn; A and B stay queued in order and each runs once', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.steers.length > 0, 'steer taken')
    expect(w.adapter.steers).toEqual(['C'])
    expect(w.pending()).toEqual(['A', 'B'])

    w.adapter.release('first')
    await first
    await w.idle('queue drained')

    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expect(w.adapter.steers).toEqual(['C'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    expect(w.userMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('the steered message reaches the model while the turn still runs, not when it ends', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()

    const clicked = Date.now()
    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    // The transcript shows it as sent at once, inside the running turn.
    expect(w.shownUserMessages()).toEqual(['first', 'C'])
    await waitFor(() => w.adapter.steers.length > 0, 'steer taken')
    // Read within a moment of the click, while the first turn is still held open.
    expect(Date.now() - clicked).toBeLessThan(2_000)
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.d.orch.isActiveTurnRunning(w.thread.id)).toBe(true)

    w.adapter.release('first')
    await first
    await w.idle('queue drained')
    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('messages steered one after another reach the model together, in order, as one input', async () => {
    const w = world()
    const { first, a, b, c } = await w.queuedBehindTurn()

    for (const item of [c, a, b]) expect(w.d.orch.promoteQueueItem(w.thread.id, item.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.steers.length > 0, 'steers taken')
    expect(w.adapter.steers).toEqual(['C' + NL + 'A' + NL + 'B'])
    expect(w.pending()).toEqual([])

    w.adapter.release('first')
    await first
    await w.idle('queue drained')
    expect(w.adapter.prompts).toEqual(['first'])
    expectEachOnce(w.adapter, ['first', 'C' + NL + 'A' + NL + 'B'])
    // One after another in the transcript, inside the first turn: one group.
    const shown = w.d.orch.getOrCreateSession(w.thread.id).messages.filter((message) => message.role === 'user' && !message.hidden)
    expect(shown.map((message) => [message.content, Boolean(message.steered)])).toEqual([['first', false], ['C', true], ['A', true], ['B', true]])
  })

  it('a second Steer click on the same message changes nothing', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    // Before and after the turn took it.
    let second: unknown
    try { second = w.d.orch.promoteQueueItem(w.thread.id, c.id) } catch (error) { second = error }
    await waitFor(() => w.adapter.steers.length > 0, 'steer taken')
    let third: unknown
    try { third = w.d.orch.promoteQueueItem(w.thread.id, c.id) } catch (error) { third = error }
    // The second click finds the message already on its way; after the turn read it, it is gone from the queue.
    expect(second).toEqual({ ok: true })
    expect(third).toBeInstanceOf(Error)
    expect(w.pending()).toEqual(['A', 'B'])

    w.adapter.release('first')
    await first
    await w.idle('queue drained')

    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expect(w.adapter.steers).toEqual(['C'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
  })

  it('a steer the turn never reads before it ends runs once as its own turn, first, and A and B follow in order', async () => {
    const w = world()
    w.adapter.takeSteers = false
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    // The turn ends as the steer lands, without reading it.
    w.adapter.release('first')
    await first
    w.adapter.takeSteers = true
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    // A message sent now goes first: C runs before A and B, which keep their order.
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    // C shows once: as the prompt of its own turn, not also inside the turn that never read it.
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('Steer after Stop sends C first, as the next turn, and A and B follow once each', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()

    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    await w.d.orch.abortRun(runId, 'stop-1', w.thread.id)
    let outcome: unknown
    try { outcome = w.d.orch.promoteQueueItem(w.thread.id, c.id) } catch (error) { outcome = error }
    await first
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    if (outcome instanceof Error) expect(w.adapter.prompts).toEqual(['first', 'A', 'B', 'C'])
    else expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expect(w.shownUserMessages().filter((text) => text === 'C')).toHaveLength(1)
  })


  it('a steer typed in the composer that the turn never reads runs once, first, and shows once', async () => {
    const w = world()
    const { first } = await w.queuedBehindTurn()
    w.adapter.takeSteers = false
    expect(w.d.orch.steerThreadOrEnqueueExternal(w.thread.id, 'Z', { source: 'gui-steer' })).toMatchObject({ steered: true })
    expect(w.shownUserMessages()).toEqual(['first', 'Z'])
    // The turn ends as the steer lands, without reading it.
    w.adapter.release('first')
    await first
    w.adapter.takeSteers = true
    await w.idle('queue drained')
    expect(w.adapter.prompts).toEqual(['first', 'Z', 'A', 'B', 'C'])
    expectEachOnce(w.adapter, ['first', 'Z', 'A', 'B', 'C'])
    expect(w.shownUserMessages()).toEqual(['first', 'Z', 'A', 'B', 'C'])
  })

  it('a steer typed in the composer is not lost by a Stop: it waits first in the queue, shown there, not in the stopped turn', async () => {
    const w = world()
    const { first } = await w.queuedBehindTurn()
    w.adapter.takeSteers = false
    expect(w.d.orch.steerThreadOrEnqueueExternal(w.thread.id, 'Z', { source: 'gui-steer' })).toMatchObject({ steered: true })
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    await w.d.orch.abortRun(runId, 'stop-1', w.thread.id)
    await first
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped turn ended')
    expect(w.shownUserMessages()).toEqual(['first'])
    expect(w.d.orch.listQueue(w.thread.id).map((item) => [item.content, item.state])).toEqual([['Z', 'pending'], ['A', 'pending'], ['B', 'pending'], ['C', 'pending']])
    expect(w.adapter.steers).toEqual([])
    expect(w.adapter.prompts).toEqual(['first'])
  })

  it('a queued message sent now that a Stop left unread is back first in the queue at once, shown there', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()
    w.adapter.takeSteers = false
    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    await w.d.orch.abortRun(runId, 'stop-1', w.thread.id)
    await first
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped turn ended')
    expect(w.d.orch.listQueue(w.thread.id).map((item) => [item.content, item.state])).toEqual([['C', 'pending'], ['A', 'pending'], ['B', 'pending']])
    expect(w.shownUserMessages()).toEqual(['first'])
  })

  it('Stop while the turn is still being set up stops a message sent now too: it waits first in the queue, nothing runs', async () => {
    const w = world()
    // The turn is held in its setup (the wait for its folders) until released.
    let release!: () => void
    const held = new Promise<'ready'>((resolve) => { release = () => resolve('ready') })
    const folders = vi.spyOn(w.d.orch as unknown as { waitForThreadFolders: () => Promise<string> }, 'waitForThreadFolders').mockReturnValueOnce(held)
    const first = w.send('first')
    await waitFor(() => w.d.orch.getOrCreateSession(w.thread.id).turnAdmitted, 'turn admitted')
    const a = (await w.send('A')).queueItem!
    const c = (await w.send('C')).queueItem!
    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    expect(w.pending()).toEqual(['C', 'A'])
    // Stop lands while the turn is set up, then the setup ends.
    await w.d.orch.stopThread(w.thread.id, 'user')
    release()
    await first.catch(() => undefined)
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped turn ended')
    await new Promise((resolve) => setTimeout(resolve, 300))
    // As after a Stop of a running turn: the message sent now waits first, and nothing runs until the person acts.
    expect(w.adapter.prompts).toEqual([])
    expect(w.adapter.steers).toEqual([])
    expect(w.d.orch.listQueue(w.thread.id).map((item) => [item.content, item.state])).toEqual([['C', 'pending'], ['A', 'pending']])
    expect(w.shownUserMessages().filter((text) => text === 'C')).toEqual([])
    folders.mockRestore()
    void a
  })

  it('Steer once a stopped turn has ended sends the message now: it runs first, then the rest in order', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()

    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    await w.d.orch.abortRun(runId, 'stop-1', w.thread.id)
    await first
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped turn ended')
    // The queue waits after a Stop.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(w.adapter.prompts).toEqual(['first'])

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await w.idle('queue drained')
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('Steer on C while the queue drains A runs every message once', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()
    w.adapter.holdPrompts.add('A')

    // The first turn ends: the queue starts draining A.
    w.adapter.release('first')
    await first
    await waitFor(() => w.adapter.prompts.includes('A'), 'A runs')
    expect(w.pending()).toEqual(['B', 'C'])

    // C is steered into A's turn.
    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.steers.length > 0, 'steer taken')
    expect(w.adapter.steers).toEqual(['C'])
    expect(w.pending()).toEqual(['B'])
    w.adapter.release('A')
    await w.idle('queue drained')

    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
  })
})
