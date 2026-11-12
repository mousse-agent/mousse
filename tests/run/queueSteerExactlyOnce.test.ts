/**
 * Steer (Send now) on a queued message, end to end: a real `OrchestratorService`, Run Engine and effect worker, with a
 * provider stand-in that takes steers while its turn runs, the way Claude's live turn and Pi do (drain, then
 * acknowledge). Messages A, B and C are queued behind a running turn and C is steered: exactly C joins the turn, A
 * and B run after it in order, every message reaches the provider exactly once, and nothing that was not sent
 * appears. Also when Steer is clicked twice, when the turn ends as Steer lands, after Stop, and while the queue
 * drains.
 */
import { AsyncResource } from 'node:async_hooks'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { ProjectManager } from '../../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../../src/mms/data/ThreadDataStore'
import { mutateDurableQueue, readDurableQueue, repairQueueJournal } from '../../src/mms/queue/durableQueue'
import { markSteerNow, promoteQueuedMessageToSteer } from '../../src/mms/queue/ThreadMessageQueue'
import { STEER_SETTLE_MS, type SteerDelivery } from '../../src/mms/run/CommandPolicy'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { QueueCommands } from '../../src/mms/run/QueueCommands'
import { RunEngine, steerNowCommandKey } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import type { ActivityPatch } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { dispatchMethod, type HandlerContext } from '../../src/mms/protocol/handlers'

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
  /**
   * Whether a taken steer is also reported read. When false the turn takes the text (`steerTaken`) and never reports
   * it read (`steerAccepted`), as a provider whose turn ends before the steered message reached its model.
   */
  acceptSteers = true
  /** Every steer text a turn took without reporting it read, in order. */
  readonly takenUnread: string[] = []
  /**
   * What a turn does with the next steer it drains, once: `drop` keeps it and never takes it or hands it back (Pi
   * when its native steer arrives after its last step); `taken` takes it and hands it back; `accepted` takes it,
   * reports it read, and then hands it back anyway (a provider bug); `returnFails` never takes it and hands it back,
   * and when the hand-back throws the turn ends all the same (Pi at a normal turn end). Turns take no more steers
   * after it.
   */
  oneDrain: 'drop' | 'taken' | 'accepted' | 'returnFails' | undefined
  /** Every error a hand-back threw under `oneDrain: 'returnFails'`. */
  readonly returnErrors: unknown[] = []
  /** Every steer text drained under `oneDrain`. */
  readonly drainedOnce: string[] = []
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
      if (this.oneDrain) {
        const mode = this.oneDrain
        this.oneDrain = undefined
        this.takeSteers = false
        this.drainedOnce.push(text)
        if (mode === 'drop') return
        if (mode === 'returnFails') {
          try {
            ctl.returnSteer?.(text, entry?.token)
          } catch (error) {
            this.returnErrors.push(error)
          }
          return
        }
        ctl.steerTaken?.(entry?.token)
        if (mode === 'accepted') {
          this.steers.push(text)
          sink.steerAccepted(text)
        }
        ctl.returnSteer?.(text, entry?.token)
        return
      }
      if (!this.acceptSteers) {
        this.takenUnread.push(text)
        ctl.steerTaken?.(entry?.token)
        return
      }
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
    // The open thread as the app keeps it: a message added is merged by id, an update merges by id, and only a full
    // replacement removes rows.
    const app = new Map<string, ChatMessage>()
    d.orch.on('thread-message', (event: { threadId: string; message: ChatMessage }) => {
      if (event.threadId === thread.id) app.set(event.message.id, event.message)
    })
    d.orch.on('thread-messages', (event: { threadId: string; messages: ChatMessage[]; replace?: boolean }) => {
      if (event.threadId !== thread.id) return
      if (event.replace) app.clear()
      for (const message of event.messages) app.set(message.id, message)
    })
    /** The person's messages the open thread shows. */
    const appUserMessages = () => [...app.values()].filter((message) => message.role === 'user' && !message.hidden).map((message) => message.content)
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
    return { d, adapter, thread, send, queue, pending, userMessages, shownUserMessages, appUserMessages, idle, queuedBehindTurn }
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

  it('a steer the provider took but never reported read is not lost when the turn ends: it runs once, as the next turn', async () => {
    const w = world()
    w.adapter.acceptSteers = false
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.takenUnread.length > 0, 'steer taken')
    expect(w.adapter.takenUnread).toEqual(['C'])
    // The turn ends with C taken and never reported read.
    w.adapter.acceptSteers = true
    w.adapter.release('first')
    await first
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    // C shows once: as the prompt of its own turn, not also inside the turn that never reported it read.
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
    // And so does the open thread, without reopening it.
    expect(w.appUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('a steer drained and never taken or handed back (Pi, when it arrives after the last step) runs once, as the next turn', async () => {
    const w = world()
    w.adapter.oneDrain = 'drop'
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.drainedOnce.length > 0, 'steer drained')
    expect(w.adapter.drainedOnce).toEqual(['C'])
    w.adapter.release('first')
    await first
    w.adapter.takeSteers = true
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
    // The open thread drops the copy inside the first turn at once.
    expect(w.appUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('a steer the provider took and then handed back runs once, as the next turn, not also as its text', async () => {
    const w = world()
    w.adapter.oneDrain = 'taken'
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.drainedOnce.length > 0, 'steer taken and handed back')
    w.adapter.release('first')
    await first
    w.adapter.takeSteers = true
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
    expect(w.appUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('a steer whose hand-back throws at the turn’s end runs once, as the next turn, and the turn still ends', async () => {
    const w = world()
    w.adapter.oneDrain = 'returnFails'
    const { first, c } = await w.queuedBehindTurn()
    // The hand-back fails partway, as a failed save would: the drain is forgotten, its row stays `steering`.
    const ids = w.d.orch.getOrCreateSession(w.thread.id).drainedExternalSteerIds
    const remove = ids.delete.bind(ids)
    let failed = false
    vi.spyOn(ids, 'delete').mockImplementation((id: string) => {
      if (id !== c.id || failed) return remove(id)
      failed = true
      throw new Error('database is locked')
    })

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.drainedOnce.length > 0, 'steer drained and its hand-back failed')
    expect(w.adapter.returnErrors).toHaveLength(1)
    w.adapter.release('first')
    await first
    w.adapter.takeSteers = true
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('a steer handed back after the turn accepted it is not run again', async () => {
    const w = world()
    w.adapter.oneDrain = 'accepted'
    const { first, c } = await w.queuedBehindTurn()

    expect(w.d.orch.promoteQueueItem(w.thread.id, c.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.drainedOnce.length > 0, 'steer accepted and handed back')
    w.adapter.release('first')
    await first
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual(['C'])
    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
    expect(w.shownUserMessages()).toEqual(['first', 'C', 'A', 'B'])
  })

  it('a steer another process accepted and saved, then died before dropping, is dropped here, not run again', async () => {
    const w = world()
    w.adapter.takeSteers = false
    const { first, c } = await w.queuedBehindTurn()
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    mutateDurableQueue(w.d.store, w.thread.id, (items) => promoteQueuedMessageToSteer(items, c.id, { steerRunId: runId }).items)
    // On disk, C's id is saved as accepted (the other process's write); this process's memory never saw it.
    const load = w.d.store.loadThreadData.bind(w.d.store)
    vi.spyOn(w.d.store, 'loadThreadData').mockImplementation((threadId: string) => {
      const data = load(threadId)
      if (threadId !== w.thread.id) return data
      const llmContext = data.llmContext ?? { messages: [] }
      return { ...data, llmContext: { ...llmContext, acceptedSteerItemIds: [...(llmContext.acceptedSteerItemIds ?? []), c.id] } } as typeof data
    })
    expect(w.d.orch.getOrCreateSession(w.thread.id).nativeContext.acceptedSteerItemIds ?? []).not.toContain(c.id)

    w.adapter.release('first')
    await first
    await w.idle('queue drained')

    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expect(w.adapter.steers).toEqual([])
    expect(w.shownUserMessages()).toEqual(['first', 'A', 'B'])
    // Nothing from disk is copied into this process's memory.
    expect(w.d.orch.getOrCreateSession(w.thread.id).nativeContext.acceptedSteerItemIds ?? []).not.toContain(c.id)
  })

  it('hides only the returned steer’s own copy, never an earlier message with the same words', async () => {
    const w = world()
    w.adapter.holdPrompts.add('first')
    const first = w.send('first')
    await waitFor(() => w.adapter.prompts.includes('first'), 'first turn')
    const y1 = (await w.send('yes')).queueItem!
    const y2 = (await w.send('yes')).queueItem!
    await w.send('B')
    // The first "yes" is steered and read.
    expect(w.d.orch.promoteQueueItem(w.thread.id, y1.id)).toEqual({ ok: true })
    await waitFor(() => w.adapter.steers.length > 0, 'steer read')
    // The second is promoted by another process after the turn's last read: it has no copy here.
    w.adapter.takeSteers = false
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    mutateDurableQueue(w.d.store, w.thread.id, (items) => promoteQueuedMessageToSteer(items, y2.id, { steerRunId: runId }).items)

    w.adapter.release('first')
    await first
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual(['yes'])
    expect(w.adapter.prompts).toEqual(['first', 'yes', 'B'])
    // The "yes" the model read stays where it entered the turn; the second shows as its own turn's prompt.
    expect(w.shownUserMessages()).toEqual(['first', 'yes', 'yes', 'B'])
    expect(w.appUserMessages()).toEqual(['first', 'yes', 'yes', 'B'])
  })

  it('a failure while returning leftover steers ends the drain as failed and claims nothing; the next drain runs them', async () => {
    const w = world()
    w.adapter.takeSteers = false
    const { first, c } = await w.queuedBehindTurn()
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    mutateDurableQueue(w.d.store, w.thread.id, (items) => promoteQueuedMessageToSteer(items, c.id, { steerRunId: runId }).items)
    const failures: Array<{ threadId: string; error: string }> = []
    w.d.orch.on('queue-drain-failed', (event: { threadId: string; error: string }) => void failures.push(event))
    // The queue lock times out, a read fails, or a save throws.
    const orch = w.d.orch as unknown as { returnOrphanedSteers: (session: unknown) => void; scheduleQueueDrain: (session: unknown, opts?: { onSettled?: (result: string) => void }) => void }
    const failing = vi.spyOn(orch, 'returnOrphanedSteers').mockImplementation(() => { throw new Error('queue lock timed out') })

    w.adapter.release('first')
    await first
    await waitFor(() => failures.length > 0, 'drain failed')
    expect(failures[0]).toMatchObject({ threadId: w.thread.id, error: 'queue lock timed out' })
    // The caller hears the failure (the startup pump frees its slot on it).
    const settled: string[] = []
    orch.scheduleQueueDrain(w.d.orch.getOrCreateSession(w.thread.id), { onSettled: (result) => void settled.push(result) })
    expect(settled).toEqual(['failed'])
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.queue().map((item) => item.content)).toEqual(['A', 'B', 'C'])

    failing.mockRestore()
    w.adapter.takeSteers = true
    orch.scheduleQueueDrain(w.d.orch.getOrCreateSession(w.thread.id))
    await w.idle('queue drained')
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
  })

  it('a steer another process promotes after the turn last read steers is not lost: it runs once, as the next turn', async () => {
    const w = world()
    const { first, c } = await w.queuedBehindTurn()
    // The turn reads no more steers; then another process marks C as a steer into this run, on disk only.
    w.adapter.takeSteers = false
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    mutateDurableQueue(w.d.store, w.thread.id, (items) => promoteQueuedMessageToSteer(items, c.id, { steerRunId: runId }).items)
    expect(w.queue().find((item) => item.id === c.id)?.state).toBe('steering')

    w.adapter.release('first')
    await first
    w.adapter.takeSteers = true
    await w.idle('queue drained')

    expect(w.adapter.steers).toEqual([])
    expect(w.adapter.prompts).toEqual(['first', 'C', 'A', 'B'])
    expectEachOnce(w.adapter, ['first', 'A', 'B', 'C'])
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

type Drain = { text: string; token: string }

/**
 * A provider whose held turn leaves every drain, take, hand-back and acceptance to the test, the way Claude, Codex and
 * Pi take steers asynchronously and can have several drains outstanding. However its turn ends (a reply, a Stop, a
 * failure or a crash of its process), it hands back each drain it has not taken, as their `returnSteer`, `handBack` and
 * `died` paths do.
 */
class ManualSteerAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly prompts: string[] = []
  /** Every steer text the provider accepted, in order. */
  readonly accepted: string[] = []
  holdPrompts = new Set<string>()
  /** The turn's end hands back drains it took and did not accept too, as Claude Code's does for a steer it never read. */
  handBackTaken = false
  turn: {
    prompt: string; ctl: TurnControl; sink: TurnSink; drains: Drain[]; taken: Set<string>; end: (how: 'reply' | 'fail' | 'crash') => void
    /** Runs `fn` in the turn's own async context, as the provider's callbacks run. */
    run: <T>(fn: () => T) => T
  } | undefined

  configured(): boolean {
    return true
  }

  drain(): Drain {
    const turn = this.turn!
    const entry = turn.run(() => turn.ctl.drainSteerEntry!())
    if (!entry) throw new Error('nothing to drain')
    turn.drains.push(entry)
    return entry
  }

  take(entry: Drain): void {
    const turn = this.turn!
    turn.taken.add(entry.token)
    turn.run(() => turn.ctl.steerTaken!(entry.token))
  }

  /** Hands `entry` back by its token. */
  giveBack(entry: Drain): void {
    const turn = this.turn!
    turn.drains = turn.drains.filter((drain) => drain !== entry)
    turn.run(() => turn.ctl.returnSteer!(entry.text, entry.token))
  }

  /** Reports `text` accepted under `token`, as an adapter does. */
  report(text: string, token: string): void {
    const turn = this.turn!
    turn.run(() => turn.sink.steerAccepted(text, token))
  }

  /** The model read `entry`: taken, then accepted under `token` (its own unless the test passes another). */
  accept(entry: Drain, token = entry.token): void {
    const turn = this.turn!
    if (!turn.taken.has(entry.token)) this.take(entry)
    turn.drains = turn.drains.filter((drain) => drain !== entry)
    this.accepted.push(entry.text)
    this.report(entry.text, token)
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.prompts.push(input.prompt)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    let how: 'reply' | 'fail' | 'crash' | 'stop' = 'reply'
    if (this.holdPrompts.has(input.prompt)) {
      const inTurn = AsyncResource.bind((fn: () => unknown) => fn())
      const turn = {
        prompt: input.prompt, ctl, sink, drains: [] as Drain[], taken: new Set<string>(), end: (_how: 'reply' | 'fail' | 'crash') => {},
        run: <T>(fn: () => T): T => inTurn(fn) as T
      }
      how = await new Promise((resolve) => {
        turn.end = resolve
        if (input.signal.aborted) resolve('stop')
        else input.signal.addEventListener('abort', () => resolve('stop'), { once: true })
        this.turn = turn
      })
      if (this.turn === turn) this.turn = undefined
      for (const entry of turn.drains.splice(0)) if (!turn.taken.has(entry.token) || this.handBackTaken) ctl.returnSteer!(entry.text, entry.token)
      if (how === 'fail' || how === 'crash') throw new Error(`provider ${how}`)
    }
    const aborted = how === 'stop'
    const text = aborted ? '' : `reply to ${input.prompt}`
    if (!aborted) {
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(text)
    }
    return {
      text, aborted, modelName: 'Scripted', totalResponseTimeMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

/**
 * Acceptance per token (docs/design/steer-and-interruptions.md §2.6): each drain is accepted by its own token, with its
 * text, so accepting one drain never acknowledges another that is still outstanding.
 */
describe('A steer is accepted by its own drain token', () => {
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
    home = mkdtempSync(join(tmpdir(), 'mousse-steer-token-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    const adapter = new ManualSteerAdapter()
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(join(home, 'project'))
    const thread = d.store.createThread('Steer', project.id)
    d.orch.setThreadModelOverride(thread.id, MODEL)
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    /** The durable queue as `[content, state]`. */
    const queue = () => readDurableQueue(d.store, thread.id).map((item) => [item.content, item.state])
    const shownUserMessages = () => d.orch.getOrCreateSession(thread.id).messages.filter((message) => message.role === 'user' && !message.hidden).map((message) => message.content)
    /** How many times `text` is a user message of the model's context. */
    const inContext = (text: string) => d.orch.getNativeContext(thread.id).messages.filter((message) => message.role === 'user' && JSON.stringify(message).includes(JSON.stringify(text))).length
    const acceptedIds = () => d.orch.getNativeContext(thread.id).acceptedSteerItemIds ?? []
    const idle = async (label: string): Promise<void> => {
      await waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && readDurableQueue(d.store, thread.id).length === 0 && d.engine.getActiveRun(thread.id) === null, label)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    /** A held turn `prompt` with `texts` queued behind it. */
    const heldTurn = async (prompt: string, texts: string[]) => {
      adapter.holdPrompts.add(prompt)
      const running = send(prompt)
      await waitFor(() => adapter.turn?.prompt === prompt, `turn ${prompt}`)
      const items: Record<string, string> = {}
      for (const text of texts) {
        const queued = await send(text)
        expect(queued.queued).toBe(true)
        items[text] = queued.queueItem!.id
      }
      return { running, items }
    }
    /** Steers `text` and drains it alone, under its own token. */
    const steerAndDrain = (items: Record<string, string>, text: string): Drain => {
      expect(d.orch.promoteQueueItem(thread.id, items[text])).toEqual({ ok: true })
      const entry = adapter.drain()
      expect(entry.text).toBe(text)
      return entry
    }
    /** Two drains outstanding, then only A accepted. */
    const twoDrainsOneAccepted = async () => {
      const { running, items } = await heldTurn('first', ['A', 'B'])
      const a = steerAndDrain(items, 'A')
      const b = steerAndDrain(items, 'B')
      expect(a.token).not.toBe(b.token)
      adapter.accept(a)
      return { running, items, a, b }
    }
    return { d, adapter, thread, send, queue, shownUserMessages, inContext, acceptedIds, idle, heldTurn, steerAndDrain, twoDrainsOneAccepted }
  }

  /** Right after A's acceptance: A is saved and gone from the queue; B is still the queue's `steering` item, unaccepted. */
  const expectOnlyAAccepted = (w: ReturnType<typeof world>, items: Record<string, string>): void => {
    expect(w.queue()).toEqual([['B', 'steering']])
    expect(w.acceptedIds()).not.toContain(items.B)
    expect(w.inContext('A')).toBe(1)
    expect(w.inContext('B')).toBe(0)
  }

  it('A and B drained separately, A accepted, then Stop: B is back first in the queue, once, and A stays read', async () => {
    const w = world()
    const { running, items } = await w.twoDrainsOneAccepted()
    expectOnlyAAccepted(w, items)

    await w.d.orch.abortRun(w.d.engine.getActiveRun(w.thread.id)!.runId, 'stop-1', w.thread.id)
    await running
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped turn ended')
    expect(w.queue()).toEqual([['B', 'pending']])
    expect(w.shownUserMessages()).toEqual(['first', 'A'])

    // The person sends again: B runs once, as its own turn, and A never runs again.
    expect(w.d.orch.promoteQueueItem(w.thread.id, items.B)).toEqual({ ok: true })
    await w.idle('B ran')
    expect(w.adapter.prompts).toEqual(['first', 'B'])
    expect(w.adapter.accepted).toEqual(['A'])
    expect(w.inContext('A')).toBe(1)
  })

  it('A and B drained separately, A accepted, then a failed continuation: B runs once after the turn', async () => {
    const w = world()
    const { running, items } = await w.twoDrainsOneAccepted()
    expectOnlyAAccepted(w, items)

    w.adapter.turn!.end('fail')
    await running.catch(() => undefined)
    await waitFor(() => w.adapter.prompts.includes('B'), 'B runs')
    await w.idle('B ran')
    expect(w.adapter.prompts).toEqual(['first', 'B'])
    expect(w.adapter.accepted).toEqual(['A'])
    expect(w.inContext('A')).toBe(1)
    expect(w.shownUserMessages().filter((text) => text === 'B')).toHaveLength(1)
  })

  it('A and B drained separately, A accepted, then the provider crashes: B runs once after the turn', async () => {
    const w = world()
    const { running, items } = await w.twoDrainsOneAccepted()
    expectOnlyAAccepted(w, items)

    // The provider's process died; its `died` path hands B back, and the turn fails.
    w.adapter.turn!.end('crash')
    await running.catch(() => undefined)
    await waitFor(() => w.adapter.prompts.includes('B'), 'B runs')
    await w.idle('B ran')
    expect(w.adapter.prompts).toEqual(['first', 'B'])
    expect(w.adapter.accepted).toEqual(['A'])
    expect(w.inContext('A')).toBe(1)
    expect(w.shownUserMessages().filter((text) => text === 'B')).toHaveLength(1)
  })

  it('A and B drained separately, both accepted: each is saved and dropped by its own token, once', async () => {
    const w = world()
    const { running, items, b } = await w.twoDrainsOneAccepted()
    expectOnlyAAccepted(w, items)
    w.adapter.accept(b)
    expect(w.queue()).toEqual([])
    expect(w.acceptedIds()).toEqual([])
    expect([w.inContext('A'), w.inContext('B')]).toEqual([1, 1])

    w.adapter.turn!.end('reply')
    await running
    await w.idle('turn done')
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.shownUserMessages()).toEqual(['first', 'A', 'B'])
  })

  it('several steers under one token are accepted together, once', async () => {
    const w = world()
    const { running, items } = await w.heldTurn('first', ['A', 'B', 'C'])
    for (const text of ['A', 'B', 'C']) expect(w.d.orch.promoteQueueItem(w.thread.id, items[text])).toEqual({ ok: true })
    const all = w.adapter.drain()
    expect(all.text).toBe(['A', 'B', 'C'].join(NL))
    w.adapter.accept(all)
    expect(w.queue()).toEqual([])
    expect(w.acceptedIds()).toEqual([])

    w.adapter.turn!.end('reply')
    await running
    await w.idle('turn done')
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.inContext(['A', 'B', 'C'].join(NL))).toBe(1)
    expect(w.shownUserMessages()).toEqual(['first', 'A', 'B', 'C'])
  })

  it('a second promotion of an item whose drain is outstanding changes nothing, after another drain was accepted', async () => {
    const w = world()
    const { running, items, b } = await w.twoDrainsOneAccepted()
    // B is drained and not accepted: Steer on it again is a no-op, and nothing new is pending.
    expect(w.d.orch.promoteQueueItem(w.thread.id, items.B)).toEqual({ ok: true })
    expect(w.d.orch.getOrCreateSession(w.thread.id).activeTurn?.pendingSteer ?? []).toEqual([])
    expect(w.queue()).toEqual([['B', 'steering']])
    w.adapter.accept(b)

    w.adapter.turn!.end('reply')
    await running
    await w.idle('turn done')
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.adapter.accepted).toEqual(['A', 'B'])
    expect([w.inContext('A'), w.inContext('B')]).toEqual([1, 1])
    expect(w.shownUserMessages()).toEqual(['first', 'A', 'B'])
  })

  it('an acceptance with a token already accepted, or another turn\'s token, changes nothing', async () => {
    const w = world()
    const { running, items, a } = await w.twoDrainsOneAccepted()
    // A second acceptance of A: the text is not saved twice, and B is not acknowledged with it.
    w.adapter.report(a.text, a.token)
    expectOnlyAAccepted(w, items)
    const firstTurnToken = a.token
    w.adapter.turn!.end('reply')
    await running
    // The unread B runs as its own turn after the first; a new turn then gets C.
    await waitFor(() => w.adapter.prompts.includes('B'), 'B runs')
    await w.idle('B ran')
    expect(w.adapter.prompts).toEqual(['first', 'B'])

    const second = await w.heldTurn('second', ['C'])
    const c = w.steerAndDrain(second.items, 'C')
    // The first turn's token names nothing in this turn: C stays unread.
    w.adapter.accept(c, firstTurnToken)
    expect(w.queue()).toEqual([['C', 'steering']])
    expect(w.acceptedIds()).not.toContain(second.items.C)
    expect(w.inContext('C')).toBe(0)
    // Its own token accepts it.
    w.adapter.report(c.text, c.token)
    expect(w.queue()).toEqual([])
    expect(w.inContext('C')).toBe(1)

    w.adapter.turn!.end('reply')
    await second.running
    await w.idle('second done')
    expect(w.adapter.prompts).toEqual(['first', 'B', 'second'])
    expect(w.inContext('A')).toBe(1)
  })

  it('a drain handed back restores only its own items, and a later drain of them is accepted once', async () => {
    const w = world()
    const { running, b } = await w.twoDrainsOneAccepted()
    // B could not be used: handed back by its token, it is pending in the turn again and drained anew.
    w.adapter.giveBack(b)
    const again = w.adapter.drain()
    expect(again.text).toBe('B')
    expect(again.token).not.toBe(b.token)
    // The old token is spent.
    w.adapter.report(b.text, b.token)
    expect(w.queue()).toEqual([['B', 'steering']])
    w.adapter.accept(again)
    expect(w.queue()).toEqual([])

    w.adapter.turn!.end('reply')
    await running
    await w.idle('turn done')
    expect(w.adapter.prompts).toEqual(['first'])
    expect([w.inContext('A'), w.inContext('B')]).toEqual([1, 1])
  })

  it('a drain the provider took, then accepted by its token, runs once and its row is dropped; a later hand-back is ignored', async () => {
    const w = world()
    const { running, items } = await w.heldTurn('first', ['A'])
    const a = w.steerAndDrain(items, 'A')
    // Taken first, as Pi, Claude Code and Codex report it, and only then read.
    w.adapter.take(a)
    expect(w.queue()).toEqual([['A', 'steering']])
    expect(w.inContext('A')).toBe(0)
    w.adapter.accept(a)
    expect(w.queue()).toEqual([])
    expect(w.acceptedIds()).toEqual([])
    expect(w.inContext('A')).toBe(1)
    // A provider bug: the accepted drain handed back. The model has it, so nothing comes back.
    w.adapter.giveBack(a)
    expect(w.d.orch.getOrCreateSession(w.thread.id).activeTurn?.pendingSteer ?? []).toEqual([])

    w.adapter.turn!.end('reply')
    await running
    await w.idle('turn done')
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.adapter.accepted).toEqual(['A'])
    expect(w.inContext('A')).toBe(1)
    expect(w.shownUserMessages()).toEqual(['first', 'A'])
  })

  it('a drain the provider took and handed back, while another was accepted by its token, is restored whole and runs once', async () => {
    const w = world()
    const { running, items, b } = await w.twoDrainsOneAccepted()
    w.adapter.take(b)
    expectOnlyAAccepted(w, items)
    // B was taken and never read: handed back by its token, it is restored whole (its row, its identity), never as
    // text alone, which would run beside the row the step before the next claim finds still `steering`.
    w.adapter.giveBack(b)
    const pending = w.d.orch.getOrCreateSession(w.thread.id).activeTurn?.pendingSteer ?? []
    expect(pending.map((steer) => [steer.text, steer.itemId])).toEqual([['B', items.B]])

    w.adapter.turn!.end('reply')
    await running
    await waitFor(() => w.adapter.prompts.includes('B'), 'B runs')
    await w.idle('B ran')
    expect(w.adapter.prompts).toEqual(['first', 'B'])
    expect(w.adapter.accepted).toEqual(['A'])
    expect(w.inContext('A')).toBe(1)
    // B shows once, as its own turn's prompt; its copy inside the first turn is hidden.
    expect(w.shownUserMessages()).toEqual(['first', 'A', 'B'])
  })

  it('a drain the provider took and had not read when Stop came, handed back as the turn ends, waits queued once and runs once', async () => {
    const w = world()
    const { running, items, b } = await w.twoDrainsOneAccepted()
    // B was pushed to the provider (taken) and the model has not read it, as Claude Code with a steer it has not started.
    w.adapter.take(b)
    w.adapter.handBackTaken = true
    expectOnlyAAccepted(w, items)

    await w.d.orch.abortRun(w.d.engine.getActiveRun(w.thread.id)!.runId, 'stop-1', w.thread.id)
    await running
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped turn ended')
    expect(w.queue()).toEqual([['B', 'pending']])
    expect(w.acceptedIds()).not.toContain(items.B)
    expect(w.inContext('B')).toBe(0)
    expect(w.shownUserMessages()).toEqual(['first', 'A'])
    // Nothing runs it until the person sends it.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(w.adapter.prompts).toEqual(['first'])

    expect(w.d.orch.promoteQueueItem(w.thread.id, items.B)).toEqual({ ok: true })
    await w.idle('B ran')
    expect(w.adapter.prompts).toEqual(['first', 'B'])
    expect(w.adapter.accepted).toEqual(['A'])
    expect(w.inContext('A')).toBe(1)
  })
})

// ------------------------------------------------------------------------------------------------------------------
// The hold (docs/design/steer-and-interruptions.md §2): a person's steer waits for a foreground tool's result.
// ------------------------------------------------------------------------------------------------------------------

/**
 * A provider on the hold: it reports its tool calls, and on each poll it drains only when the orchestrator says the
 * steer goes in now (`peekSteer`, `drainSteerEntry({ expect })`), checking `mayCut` right before its cut. The log says
 * what happened, in order, so a test can assert that a cut came after (or before) a tool's result.
 */
class HoldingAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities: ProviderCapabilities
  readonly prompts: string[] = []
  readonly log: string[] = []
  /** Runs once, between the drain and `mayCut`: something that happens while the cut is on its way. */
  beforeCut: (() => void) | undefined
  /** The deliveries the poll drains. */
  expect: SteerDelivery[] = ['cut']
  private turn: { sink: TurnSink; ctl: TurnControl; run: (fn: () => unknown) => unknown; end: () => void; runId: string } | undefined

  constructor(boundary: 'announce' | 'start', settleMs: number | null = boundary === 'start' ? STEER_SETTLE_MS : null) {
    // A `start` provider with a measured window: best effort unless the instance asks for strict. With no measured
    // window (`settleMs: null`, as Cursor and most ACP agents), always strict.
    this.capabilities = { ...CLAUDE_SUBSCRIPTION_CAPABILITIES, steerBoundary: boundary, steerSettleMs: settleMs }
  }

  configured(): boolean {
    return true
  }

  get runId(): string | undefined {
    return this.turn?.runId
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.prompts.push(input.prompt)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    let aborted = false
    const inTurn = AsyncResource.bind((fn: () => unknown) => fn())
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => this.poll(), 5)
      const done = (): void => {
        clearInterval(timer)
        if (this.turn?.end === done) this.turn = undefined
        resolve()
      }
      this.turn = { sink, ctl, run: inTurn, end: done, runId: input.runId }
      if (input.signal.aborted) {
        aborted = true
        done()
      } else input.signal.addEventListener('abort', () => { aborted = true; done() }, { once: true })
    })
    const text = aborted ? '' : `reply to ${input.prompt}`
    if (!aborted) {
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(text)
    }
    return { text, aborted, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    if (!this.turn) return 'not_active'
    this.turn.end()
    return 'interrupted'
  }

  private poll(): void {
    const turn = this.turn
    if (!turn) return
    const peek = turn.ctl.peekSteer?.()
    if (!peek || !this.expect.includes(peek.delivery)) return
    const entry = turn.ctl.drainSteerEntry!({ expect: this.expect })
    if (!entry) return
    const before = this.beforeCut
    this.beforeCut = undefined
    before?.()
    if (!turn.ctl.mayCut!(entry.token)) {
      this.log.push(`held again:${entry.text}`)
      turn.ctl.returnSteer!(entry.text, entry.token)
      return
    }
    this.log.push(`${entry.forced ? 'forced' : peek.delivery}:${entry.text}`)
    turn.ctl.steerTaken!(entry.token)
    turn.sink.steerAccepted(entry.text, entry.token)
  }

  /** In the running turn's context, as the provider's own events arrive. */
  private emit(fn: (sink: TurnSink) => void): void {
    const turn = this.turn!
    turn.run(() => fn(turn.sink))
  }

  toolStart(callId: string, name = 'Bash', activity?: ActivityPatch, parentCallId?: string): void {
    this.log.push(`start:${callId}`)
    this.emit((sink) => sink.tool({
      kind: 'mcp_tool_call', phase: 'start', callId, title: name, summary: '', details: [],
      activity: activity ?? ({ toolName: name, kind: 'command', command: `sleep 30 # ${callId}` } as ActivityPatch),
      ...(parentCallId ? { parentCallId } : {})
    }))
  }

  toolDone(callId: string, name = 'Bash'): void {
    this.log.push(`result:${callId}`)
    this.emit((sink) => sink.tool({ kind: 'mcp_tool_result', phase: 'complete', callId, title: name, summary: '', details: [], response: 'ok' }))
  }

  /** Several events in one go, as one read of the provider's output delivers them. */
  together(...steps: Array<() => void>): void {
    this.emit(() => steps.forEach((step) => step()))
  }

  /** A running call's own output: never model output. */
  toolOutput(callId: string, name = 'Bash'): void {
    this.emit((sink) => sink.tool({ kind: 'mcp_tool_call', phase: 'update', callId, title: name, summary: '', details: [], activity: { output: 'tick\n' } }))
  }

  /** The model starts a new response and writes. */
  writes(text: string): void {
    this.emit((sink) => {
      sink.text({ phase: 'start', content: '', contentIndex: 0 })
      sink.text({ phase: 'delta', content: text, contentIndex: 0 })
    })
  }

  awaiting(callId: string, waiting: boolean): void {
    this.emit((sink) => sink.toolAwaiting?.(callId, waiting))
  }

  boundary(): void {
    this.emit((sink) => sink.boundary?.())
  }

  end(): void {
    this.turn?.end()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a person\'s steer waits for a running tool, then goes in once (the hold)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  const daemons: Phase6Daemon[] = []
  const extra: Array<() => void> = []

  afterEach(async () => {
    for (const close of extra.splice(0)) close()
    for (const daemon of daemons.splice(0).reverse()) await daemon.stop().catch(() => undefined)
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const world = async (boundary: 'announce' | 'start' = 'announce', options: { strict?: boolean; settleMs?: number | null; release?: (instanceId: string, d: Phase6Daemon) => Promise<void> } = {}) => {
    home = mkdtempSync(join(tmpdir(), 'mousse-steer-hold-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    mkdirSync(join(home, 'project'))
    const adapter = new HoldingAdapter(boundary, options.settleMs === undefined ? undefined : options.settleMs)
    const d = phase6Daemon(home, [adapter])
    daemons.push(d)
    const project = d.projects.openProject(join(home, 'project'))
    const thread = d.store.createThread('Hold', project.id)
    d.orch.setThreadModelOverride(thread.id, MODEL)
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    if (options.strict || options.release) {
      // Strict release is set per instance and read when a turn starts: a first turn names the instance.
      const warmup = send('warmup')
      await waitFor(() => adapter.runId !== undefined, 'warmup running')
      const instanceId = d.engine.bindingForRun(adapter.runId!)!.instanceId
      adapter.end()
      await warmup
      await waitFor(() => d.engine.getActiveRun(thread.id) === null, 'warmup ended')
      if (options.release) await options.release(instanceId, d)
      else d.settings.runs.steerRelease = { [instanceId]: 'strict' }
    }
    const first = send('first')
    await waitFor(() => adapter.runId !== undefined, 'first turn running')
    const runId = adapter.runId!
    /** A person's message sent into the running turn (queued, then Steer): its queue item id. */
    const steer = async (text: string): Promise<string> => {
      const queued = await send(text)
      expect(queued.queued).toBe(true)
      expect(d.orch.promoteQueueItem(thread.id, queued.queueItem!.id)).toEqual({ ok: true })
      return queued.queueItem!.id
    }
    const held = () => d.orch.getTurnState(thread.id).heldSteer
    const delivered = () => adapter.log.filter((entry) => /^(cut|forced|native):/.test(entry))
    const inContext = (text: string) => d.orch.getOrCreateSession(thread.id).nativeContext.messages.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes(text)).length
    const events = (type: string) => d.engine.listEvents(thread.id).filter((event) => event.type === type)
    const finish = async () => {
      adapter.end()
      await first
      await waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && d.engine.getActiveRun(thread.id) === null && readDurableQueue(d.store, thread.id).length === 0, 'idle')
      await sleep(80)
    }
    return { d, adapter, thread, runId, first, send, steer, held, delivered, inContext, events, finish }
  }

  // -------- Hold and release --------

  it('a steer during a running command is not drained; it goes in once, right after the command\'s result', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const item = await w.steer('use pnpm')
    await waitFor(() => w.held() !== undefined, 'held')
    expect(w.held()).toMatchObject({ waitsFor: 'Bash', detail: 'sleep 30 # b1', tools: 1, itemIds: [item], runId: w.runId })
    await sleep(200)
    expect(w.delivered()).toEqual([])
    expect(w.inContext('use pnpm')).toBe(0)

    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.adapter.log).toEqual(['start:b1', 'result:b1', 'cut:use pnpm'])
    expect(w.held()).toBeUndefined()
    await w.finish()
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.inContext('use pnpm')).toBe(1)
  })

  it('while the model writes and no tool runs, a steer cuts in at once', async () => {
    const w = await world()
    w.adapter.writes('thinking out loud')
    await w.steer('stop and listen')
    await waitFor(() => w.delivered().length > 0, 'cut')
    expect(w.delivered()).toEqual(['cut:stop and listen'])
    expect(w.held()).toBeUndefined()
    await w.finish()
  })

  it('announce: two calls of one response hold the steer until the second has its result too', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    w.adapter.toolStart('b2')
    await w.steer('later')
    await waitFor(() => w.held()?.tools === 2, 'held for two')
    // The oldest names the hold; the tooltip lists both.
    expect(w.held()?.waitsFor).toBe('Bash')
    expect(w.held()?.toolList?.map((tool) => tool.detail)).toEqual(['sleep 30 # b1', 'sleep 30 # b2'])
    w.adapter.toolDone('b1')
    await sleep(150)
    expect(w.delivered()).toEqual([])
    expect(w.held()?.tools).toBe(1)
    w.adapter.toolDone('b2')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.adapter.log).toEqual(['start:b1', 'start:b2', 'result:b1', 'result:b2', 'cut:later'])
    await w.finish()
  })

  it('a tool that starts between the drain and the cut keeps the steer held, in the same hold', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('wait for it')
    await waitFor(() => w.held() !== undefined, 'held')
    const generation = w.held()!.holdGeneration
    // b1 ends; the drain is made, and b2 starts before the cut is sent.
    w.adapter.beforeCut = () => w.adapter.toolStart('b2')
    w.adapter.toolDone('b1')
    await waitFor(() => w.adapter.log.includes('held again:wait for it'), 'handed back')
    await waitFor(() => w.held()?.detail === 'sleep 30 # b2', 'held for b2')
    expect(w.held()!.holdGeneration).toBe(generation)
    expect(w.delivered()).toEqual([])
    w.adapter.toolDone('b2')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.delivered()).toEqual(['cut:wait for it'])
    await w.finish()
    expect(w.inContext('wait for it')).toBe(1)
  })

  it('start: the steer is held through the release window after the result, then goes in', async () => {
    const w = await world('start')
    w.adapter.toolStart('b1')
    await w.steer('after the window')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    const done = Date.now()
    await waitFor(() => w.delivered().length > 0, 'released after the window')
    // Not before the window closed: a second command of the same response would start inside it.
    expect(Date.now() - done).toBeGreaterThanOrEqual(STEER_SETTLE_MS - 20)
    expect(w.adapter.log).toEqual(['start:b1', 'result:b1', 'cut:after the window'])
    await w.finish()
  })

  it('start: a tool\'s own output never closes the window, and any tool event starts it again', async () => {
    const w = await world('start')
    w.adapter.toolStart('b1')
    w.adapter.toolStart('b2')
    await w.steer('patience')
    w.adapter.toolDone('b1')
    // b2 runs on and writes output for longer than the window: still held.
    for (let i = 0; i < 6; i++) {
      w.adapter.toolOutput('b2')
      await sleep(STEER_SETTLE_MS / 2)
    }
    expect(w.delivered()).toEqual([])
    w.adapter.toolDone('b2')
    // A later tool event inside the window starts it again.
    await sleep(STEER_SETTLE_MS / 2)
    w.adapter.toolOutput('b2')
    const restarted = Date.now()
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(Date.now() - restarted).toBeGreaterThanOrEqual(STEER_SETTLE_MS - 20)
    await w.finish()
  })

  it('start: only the turn\'s own calls restart the window; a subagent\'s calls working on do not keep the steer held', async () => {
    const w = await world('start')
    w.adapter.toolStart('agent', 'Agent', { toolName: 'Agent', kind: 'subagent', description: 'research' } as ActivityPatch)
    w.adapter.toolStart('child', 'Bash', undefined, 'agent')
    w.adapter.toolStart('b1')
    await w.steer('not for the subagent')
    await waitFor(() => w.held() !== undefined, 'held for b1')
    w.adapter.toolDone('b1')
    const done = Date.now()
    // The subagent's command writes output more often than the window lasts, for as long as the steer waits.
    let ticking = true
    const ticks = (async () => {
      while (ticking) {
        w.adapter.toolOutput('child')
        await sleep(STEER_SETTLE_MS / 3)
      }
    })()
    await waitFor(() => w.delivered().length > 0, 'released while the subagent works on')
    ticking = false
    await ticks
    expect(Date.now() - done).toBeLessThan(STEER_SETTLE_MS * 4)
    expect(w.delivered()).toEqual(['cut:not for the subagent'])
    w.adapter.toolDone('child')
    w.adapter.toolDone('agent', 'Agent')
    await w.finish()
  })

  it('start: text between two commands closes the window and the steer cuts (the documented best-effort window)', async () => {
    const w = await world('start')
    // A long window, so only the model's output can close it within the test.
    ;(w.d.orch as unknown as { steerSettleMs: number }).steerSettleMs = 3_000
    w.adapter.end()
    await w.first
    const second = w.send('second')
    await waitFor(() => w.adapter.prompts.includes('second') && w.adapter.runId !== undefined, 'a turn with the long window')
    w.adapter.toolStart('b1')
    await w.steer('cut after text')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    await sleep(300)
    // The window is open: still held.
    expect(w.delivered()).toEqual([])
    const wrote = Date.now()
    w.adapter.writes('Now the second command:')
    await waitFor(() => w.delivered().length > 0, 'cut by model output')
    // Long before the window would have closed on its own.
    expect(Date.now() - wrote).toBeLessThan(1_500)
    expect(w.adapter.log).toEqual(['start:b1', 'result:b1', 'cut:cut after text'])
    w.adapter.end()
    await second
    await w.finish()
  })

  it('start, strict release: a held steer waits past the window and the model\'s text, until the provider\'s turn ends', async () => {
    const w = await world('start', { strict: true })
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('b1')
    await w.steer('strictly after')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    w.adapter.writes('More text')
    // A delayed start: the next command runs before Mousse hears of it. Strict never releases early.
    await sleep(STEER_SETTLE_MS * 2)
    expect(w.delivered()).toEqual([])
    expect(w.held()).toBeDefined()
    w.adapter.boundary()
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    expect(w.delivered()).toEqual(['native:strictly after'])
    await w.finish()
    expect(w.inContext('strictly after')).toBe(1)
  })

  it('a subagent working while the steer waits sends no transcript rebuild: its rows are nested, and a real move sends the one row, in place', async () => {
    const w = await world()
    w.adapter.toolStart('agent', 'Agent', { toolName: 'Agent', kind: 'subagent', description: 'research' } as ActivityPatch)
    w.adapter.toolStart('b1')
    const item = await w.steer('after the command')
    await waitFor(() => w.held() !== undefined, 'held for b1')
    const session = w.d.orch.getOrCreateSession(w.thread.id)
    const echo = () => session.messages.find((message) => message.steered && message.steerItemId === item)!
    const replaces: unknown[] = []
    const echoUpdates: string[] = []
    const onMessages = (event: { threadId: string; replace?: boolean }) => {
      if (event.threadId === w.thread.id && event.replace) replaces.push(event)
    }
    const onUpdated = (event: { threadId: string; message: ChatMessage }) => {
      if (event.threadId === w.thread.id && event.message.id === echo().id) echoUpdates.push(event.message.timestamp)
    }
    w.d.orch.on('thread-messages', onMessages)
    w.d.orch.on('thread-message-updated', onUpdated)
    try {
      // Twenty calls of the subagent while the steer waits, with polls between them.
      for (let i = 0; i < 20; i++) {
        w.adapter.toolStart(`child-${i}`, 'Bash', undefined, 'agent')
        w.adapter.toolDone(`child-${i}`)
        if (i % 4 === 3) await sleep(120)
      }
      await sleep(200)
      expect(w.held()).toBeDefined()
      expect(replaces).toEqual([])
      expect(echoUpdates).toEqual([])
      // A row at the turn's top level after the Steer row: the row moves once, by its time, and stays in its place in
      // the list (the thread database writes it in place), with no rebuild.
      const index = session.messages.indexOf(echo())
      w.adapter.writes('A note while the command runs.')
      await waitFor(() => echoUpdates.length > 0, 'the Steer row moved after the note')
      await sleep(250)
      expect(echoUpdates).toHaveLength(1)
      expect(replaces).toEqual([])
      expect(session.messages.indexOf(echo())).toBe(index)
      const note = session.messages.find((message) => message.role === 'assistant' && message.content.includes('A note while the command runs.'))!
      expect(echo().timestamp > note.timestamp).toBe(true)
    } finally {
      w.d.orch.off('thread-messages', onMessages)
      w.d.orch.off('thread-message-updated', onUpdated)
    }
    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released')
    w.adapter.toolDone('agent', 'Agent')
    await w.finish()
  })

  it('start, strict release: the reply the agent writes while the steer waits reads above the Steer block, and stays there once the steer goes in', async () => {
    const w = await world('start', { strict: true })
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('b1')
    const item = await w.steer('after your reply')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    w.adapter.writes('Here is what I found.')
    // In the order a window shows them: by timestamp, the service's own order for ties (a stable sort, as the app
    // store's `sortMessagesDeterministic` does).
    const shown = () => [...w.d.orch.getOrCreateSession(w.thread.id).messages.filter((message) => !message.hidden)]
      .sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? -1 : 1))
    const order = () => {
      const messages = shown()
      return {
        steer: messages.findIndex((message) => message.steered && message.steerItemId === item),
        reply: messages.findIndex((message) => message.role === 'assistant' && message.content.includes('Here is what I found.')),
        last: messages.length - 1
      }
    }
    // While held: the Steer block stays after the newest row.
    await waitFor(() => order().reply >= 0 && order().steer === order().last, 'the Steer block after the reply while held')
    expect(w.held()).toBeDefined()
    w.adapter.boundary()
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    // Where it went in: below the reply written before it.
    expect(order().steer).toBeGreaterThan(order().reply)
    await w.finish()
    expect(order().steer).toBeGreaterThan(order().reply)
  })

  it('start, best effort: with no output after the command, the steer goes in after the window (a late start can still be cut)', async () => {
    const w = await world('start')
    w.adapter.toolStart('b1')
    await w.steer('best effort')
    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released')
    // The next command started at the provider before its start reached Mousse: it is cut. Stated, not prevented.
    w.adapter.toolStart('b2-late')
    expect(w.adapter.log).toEqual(['start:b1', 'result:b1', 'cut:best effort', 'start:b2-late'])
    w.adapter.toolDone('b2-late')
    await w.finish()
  })

  // -------- Ownership and who is asked --------

  it('a subagent\'s own command never holds; the turn\'s own command does, and the steer goes in when it ends', async () => {
    const w = await world()
    w.adapter.toolStart('agent', 'Agent', { toolName: 'Agent', kind: 'subagent', description: 'research' } as ActivityPatch)
    w.adapter.toolStart('child', 'Bash', undefined, 'agent')
    w.adapter.toolStart('root')
    await w.steer('only the root')
    await waitFor(() => w.held()?.tools === 1, 'held for the root command only')
    expect(w.held()?.detail).toBe('sleep 30 # root')
    w.adapter.toolDone('root')
    await waitFor(() => w.delivered().length > 0, 'released while the subagent runs on')
    expect(w.adapter.log).toEqual(['start:agent', 'start:child', 'start:root', 'result:root', 'cut:only the root'])
    w.adapter.toolDone('child')
    w.adapter.toolDone('agent', 'Agent')
    await w.finish()
  })

  it('a call a person is asked about does not hold; a pending approval for one call never releases another that runs', async () => {
    const w = await world()
    w.adapter.toolStart('asks')
    w.adapter.awaiting('asks', true)
    w.adapter.toolStart('runs')
    await w.steer('answer it')
    await waitFor(() => w.held() !== undefined, 'held for the running call')
    expect(w.held()).toMatchObject({ tools: 1, detail: 'sleep 30 # runs' })
    w.adapter.toolDone('runs')
    await waitFor(() => w.delivered().length > 0, 'cut while only the asking call is open')
    expect(w.delivered()).toEqual(['cut:answer it'])
    w.adapter.toolDone('asks')
    await w.finish()
  })

  it('start, strict release: a held steer does not wait for a person\'s answer when nothing else runs; it cuts and answers it', async () => {
    const w = await world('start', { strict: true })
    w.adapter.toolStart('b1')
    await w.steer('answer it')
    await waitFor(() => w.held() !== undefined, 'held for the command')
    w.adapter.toolDone('b1')
    // The next call asks a person: the provider cannot go on (or end its turn) until they answer.
    w.adapter.toolStart('asks')
    w.adapter.awaiting('asks', true)
    await waitFor(() => w.delivered().length > 0, 'cut while only the asking call is open')
    expect(w.delivered()).toEqual(['cut:answer it'])
    w.adapter.toolDone('asks')
    await w.finish()
  })

  it('an approval granted while the steer is on its way makes the call run: the steer is held again', async () => {
    const w = await world()
    w.adapter.toolStart('asks')
    w.adapter.awaiting('asks', true)
    w.adapter.beforeCut = () => w.adapter.awaiting('asks', false)
    await w.steer('not now')
    await waitFor(() => w.adapter.log.includes('held again:not now'), 'handed back')
    await waitFor(() => w.held() !== undefined, 'held')
    expect(w.delivered()).toEqual([])
    w.adapter.toolDone('asks')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.delivered()).toEqual(['cut:not now'])
    await w.finish()
  })

  // -------- Peek coverage --------

  it('a steer another process promoted during a command is held, listed, and released once', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const queued = await w.send('from the CLI')
    // Another process marks it a steer into this run, on disk only.
    mutateDurableQueue(w.d.store, w.thread.id, (items) => promoteQueuedMessageToSteer(items, queued.queueItem!.id, { steerRunId: w.runId }).items)
    await waitFor(() => w.held()?.itemIds.includes(queued.queueItem!.id) === true, 'held, from disk')
    await sleep(100)
    expect(w.delivered()).toEqual([])
    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.delivered()).toEqual(['cut:from the CLI'])
    await w.finish()
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.inContext('from the CLI')).toBe(1)
  })

  // -------- Ends --------

  it('three steers during a command join one hold: one line, one input', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const ids = [await w.steer('one'), await w.steer('two'), await w.steer('three')]
    await waitFor(() => w.held()?.itemIds.length === 3, 'one hold of three')
    expect(w.held()!.itemIds).toEqual(ids)
    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.delivered()).toEqual(['cut:one' + NL + 'two' + NL + 'three'])
    await w.finish()
    expect(w.adapter.prompts).toEqual(['first'])
  })

  it('a steer joining the hold raises its generation; the tool changing does not', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('one')
    await waitFor(() => w.held() !== undefined, 'held')
    const g1 = w.held()!.holdGeneration
    w.adapter.toolStart('b2')
    w.adapter.toolDone('b1')
    await waitFor(() => w.held()?.detail === 'sleep 30 # b2', 'waits for b2')
    expect(w.held()!.holdGeneration).toBe(g1)
    await w.steer('two')
    await waitFor(() => w.held()?.itemIds.length === 2, 'joined')
    expect(w.held()!.holdGeneration).toBeGreaterThan(g1)
    w.adapter.toolDone('b2')
    await waitFor(() => w.delivered().length > 0, 'released')
    expect(w.delivered()).toEqual(['cut:one' + NL + 'two'])
    await w.finish()
  })

  it('Stop while a steer is held: it comes back first in the queue, once, and nothing runs it', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const later = await w.send('queued later')
    const item = await w.steer('held then stopped')
    await waitFor(() => w.held() !== undefined, 'held')
    await w.d.orch.abortRun(w.runId, 'stop-held', w.thread.id)
    await w.first
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped')
    expect(w.d.orch.listQueue(w.thread.id).map((entry) => [entry.id, entry.content, entry.state])).toEqual([
      [item, 'held then stopped', 'pending'],
      [later.queueItem!.id, 'queued later', 'pending']
    ])
    expect(w.d.orch.getTurnState(w.thread.id).heldSteer).toBeUndefined()
    await sleep(150)
    expect(w.adapter.prompts).toEqual(['first'])
    expect(w.delivered()).toEqual([])
    expect(w.inContext('held then stopped')).toBe(0)
  })

  it('the turn ends while a steer is held: it runs once, as the next turn', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('after the end')
    await waitFor(() => w.held() !== undefined, 'held')
    // The provider's turn ends without the call's result (it ended the turn itself).
    w.adapter.end()
    await w.first
    await waitFor(() => w.adapter.prompts.length === 2, 'the steer runs as a turn')
    expect(w.adapter.prompts).toEqual(['first', 'after the end'])
    w.adapter.end()
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id) && w.d.engine.getActiveRun(w.thread.id) === null, 'idle')
    expect(w.delivered()).toEqual([])
    expect(w.inContext('after the end')).toBe(1)
  })

  // -------- Send now --------

  const sendNow = (w: Awaited<ReturnType<typeof world>>, request: Partial<{ holdGeneration: number; itemIds: string[]; clientRequestId: string; runId: string }> = {}) => {
    const held = w.held()!
    return w.d.orch.steerNow({
      threadId: w.thread.id,
      runId: request.runId ?? held.runId!,
      holdGeneration: request.holdGeneration ?? held.holdGeneration,
      itemIds: request.itemIds ?? held.itemIds,
      clientRequestId: request.clientRequestId ?? 'now-1'
    })
  }

  it('Send now forces the hold: the steer goes in at once, before the command\'s result', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('right now')
    await waitFor(() => w.held() !== undefined, 'held')
    const generation = w.held()!.holdGeneration
    expect(await sendNow(w)).toMatchObject({ status: 'accepted' })
    await waitFor(() => w.delivered().length > 0, 'forced')
    expect(w.adapter.log).toEqual(['start:b1', 'forced:right now'])
    expect(w.events('steer.now_requested')).toHaveLength(1)
    expect(w.events('steer.now_applied').map((event) => event.payload)).toEqual([{ runId: w.runId, holdGeneration: generation, requestId: 'now-1' }])
    expect(w.events('steer.now_stale')).toHaveLength(0)
    // The field is honoured once and gone.
    expect(readDurableQueue(w.d.store, w.thread.id).some((entry) => entry.steerNow)).toBe(false)
    w.adapter.toolDone('b1')
    await w.finish()
    expect(w.inContext('right now')).toBe(1)
  })

  it('Send now whose command cannot be recorded (the run database throws) forces nothing: no command is stopped without a record', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('not recorded')
    await waitFor(() => w.held() !== undefined, 'held')
    const dispatch = vi.spyOn(w.d.engine, 'dispatch').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
    await expect(sendNow(w)).rejects.toThrow('SQLITE_BUSY')
    dispatch.mockRestore()
    // Several polls: still held, nothing forced, no record of a Send now.
    await sleep(350)
    expect(w.delivered()).toEqual([])
    expect(w.held()).toBeDefined()
    expect(w.events('steer.now_requested')).toHaveLength(0)
    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released at the result')
    expect(w.delivered()).toEqual(['cut:not recorded'])
    await w.finish()
  })

  it('Send now is not applied before its command is recorded: a poll while the run database is busy forces nothing yet', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('after the record')
    await waitFor(() => w.held() !== undefined, 'held')
    const real = w.d.engine.dispatch.bind(w.d.engine)
    let release!: () => void
    const busy = new Promise<void>((resolve) => { release = resolve })
    const dispatch = vi.spyOn(w.d.engine, 'dispatch').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await busy
      return real(...args)
    })
    const click = sendNow(w)
    // Polls run while the command waits for the database: the force is known here, but not recorded.
    await sleep(350)
    expect(w.delivered()).toEqual([])
    release()
    expect(await click).toMatchObject({ status: 'accepted' })
    dispatch.mockRestore()
    await waitFor(() => w.delivered().length > 0, 'forced once recorded')
    expect(w.delivered()).toEqual(['forced:after the record'])
    expect(w.events('steer.now_requested')).toHaveLength(1)
    w.adapter.toolDone('b1')
    await w.finish()
  })

  it('a Send now click for an older hold is stale: nothing is forced', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('one')
    await waitFor(() => w.held() !== undefined, 'held')
    const old = w.held()!.holdGeneration
    await w.steer('two')
    await waitFor(() => w.held()?.itemIds.length === 2, 'joined: a new hold')
    const stale = new Promise<{ outcome: string }>((resolve) => w.d.orch.on('steer-now', resolve))
    expect(await sendNow(w, { holdGeneration: old })).toMatchObject({ status: 'accepted' })
    expect(await stale).toMatchObject({ outcome: 'stale', requestId: 'now-1' })
    await sleep(150)
    expect(w.delivered()).toEqual([])
    expect(w.events('steer.now_stale')).toHaveLength(1)
    expect(w.held()).toBeDefined()
    w.adapter.toolDone('b1')
    await waitFor(() => w.delivered().length > 0, 'released normally')
    expect(w.delivered()).toEqual(['cut:one' + NL + 'two'])
    await w.finish()
  })

  it('two Send now clicks with different ids force once; the same id again replays its receipt', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    await w.steer('once')
    await waitFor(() => w.held() !== undefined, 'held')
    const request = { holdGeneration: w.held()!.holdGeneration, itemIds: w.held()!.itemIds }
    const [a, b] = await Promise.all([sendNow(w, { ...request, clientRequestId: 'a' }), sendNow(w, { ...request, clientRequestId: 'b' })])
    expect([a.status, b.status]).toEqual(['accepted', 'accepted'])
    await waitFor(() => w.delivered().length > 0, 'forced')
    expect(await sendNow(w, { ...request, clientRequestId: 'a', runId: w.runId })).toMatchObject({ status: 'accepted', replayed: true })
    await sleep(100)
    expect(w.delivered()).toEqual(['forced:once'])
    expect(w.events('steer.now_requested')).toHaveLength(2)
    expect(w.events('steer.now_stale')).toHaveLength(0)
    w.adapter.toolDone('b1')
    await w.finish()
    expect(w.inContext('once')).toBe(1)
  })

  it('Send now from another process: the command never ends, and the cut reaches the provider before any result', async () => {
    const w = await world()
    w.adapter.toolStart('forever')
    const item = await w.steer('from elsewhere')
    await waitFor(() => w.held() !== undefined, 'held')
    // Another process: its own run engine on the same profile database and its own view of the queue files.
    const otherEngine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home! })), pid: 2 })
    extra.push(() => otherEngine.store.db.close())
    const otherStore = new ThreadDataStore(new ProjectManager())
    otherStore.setQueueJournal({
      commands: new QueueCommands(otherEngine.store.db),
      effects: { activeRunId: (threadId) => otherEngine.getActiveRun(threadId)?.runId ?? null, applyEffects: () => undefined, abandonWorkflow: () => undefined, audit: () => undefined, scheduleRepair: () => undefined }
    })
    const result = await otherEngine.dispatch({ kind: 'steer_now', threadId: w.thread.id, clientRequestId: 'elsewhere', runId: w.runId, holdGeneration: w.held()!.holdGeneration, itemIds: [item] })
    expect(result.status).toBe('accepted')
    repairQueueJournal(otherStore, w.thread.id)
    await waitFor(() => w.delivered().length > 0, 'forced across processes')
    expect(w.adapter.log).toEqual(['start:forever', 'forced:from elsewhere'])
    expect(w.adapter.log.some((entry) => entry.startsWith('result:'))).toBe(false)
    expect(w.events('steer.now_applied')).toHaveLength(1)
    w.adapter.toolDone('forever')
    await w.finish()
    expect(w.inContext('from elsewhere')).toBe(1)
  })

  it('a crash between the database commit and the queue file write: the owner\'s poll finishes it', async () => {
    const w = await world()
    w.adapter.toolStart('forever')
    const item = await w.steer('recovered')
    await waitFor(() => w.held() !== undefined, 'held')
    // The other process committed its intent and died before it touched the queue file.
    const otherEngine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home! })), pid: 2 })
    extra.push(() => otherEngine.store.db.close())
    await otherEngine.dispatch({ kind: 'steer_now', threadId: w.thread.id, clientRequestId: 'crashed', runId: w.runId, holdGeneration: w.held()!.holdGeneration, itemIds: [item] })
    expect(readDurableQueue(w.d.store, w.thread.id).some((entry) => entry.steerNow)).toBe(false)
    await waitFor(() => w.delivered().length > 0, 'forced by the owner\'s poll')
    expect(w.delivered()).toEqual(['forced:recovered'])
    expect(new QueueCommands(w.d.engine.store.db).get(steerNowCommandKey(w.thread.id, 'crashed'))?.status).toBe('applied')
    w.adapter.toolDone('forever')
    await w.finish()
  })

  it('a crash after the queue file write and before the applied mark: finished once, never written twice', async () => {
    const w = await world()
    w.adapter.toolStart('forever')
    const item = await w.steer('half done')
    await waitFor(() => w.held() !== undefined, 'held')
    const generation = w.held()!.holdGeneration
    const otherEngine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home! })), pid: 2 })
    extra.push(() => otherEngine.store.db.close())
    // The other process wrote the field and died before marking the entry applied. The owner may not have polled yet.
    const pause = vi.spyOn(w.d.store, 'getQueueJournal').mockReturnValue(undefined)
    await otherEngine.dispatch({ kind: 'steer_now', threadId: w.thread.id, clientRequestId: 'half', runId: w.runId, holdGeneration: generation, itemIds: [item] })
    mutateDurableQueue(w.d.store, w.thread.id, (items) => markSteerNow(items, { runId: w.runId, holdGeneration: generation, requestId: 'half', itemIds: [item] }, w.runId).items)
    pause.mockRestore()
    await waitFor(() => w.delivered().length > 0, 'forced')
    expect(w.delivered()).toEqual(['forced:half done'])
    await waitFor(() => new QueueCommands(w.d.engine.store.db).get(steerNowCommandKey(w.thread.id, 'half'))?.status === 'applied', 'entry finished')
    await sleep(100)
    expect(w.events('steer.now_applied')).toHaveLength(1)
    w.adapter.toolDone('forever')
    await w.finish()
    expect(w.inContext('half done')).toBe(1)
  })

  it('a steering item with no run of its own, held in the active run, can be sent now', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const queued = await w.send('unbound')
    // Promoted with no run named (the composer's steer while the run was starting).
    mutateDurableQueue(w.d.store, w.thread.id, (items) => promoteQueuedMessageToSteer(items, queued.queueItem!.id, {}).items)
    await waitFor(() => w.held()?.itemIds.includes(queued.queueItem!.id) === true, 'held')
    expect(await sendNow(w)).toMatchObject({ status: 'accepted' })
    await waitFor(() => w.delivered().length > 0, 'forced')
    expect(w.delivered()).toEqual(['forced:unbound'])
    w.adapter.toolDone('b1')
    await w.finish()
  })

  it('Send now for a run that already ended is ignored, and a recovered request for it is stale: nothing is forced', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const item = await w.steer('too late')
    await waitFor(() => w.held() !== undefined, 'held')
    const generation = w.held()!.holdGeneration
    const oldRun = w.runId
    // The other process committed a request, then the run ended before anyone applied it.
    const otherEngine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome: home! })), pid: 2 })
    extra.push(() => otherEngine.store.db.close())
    const pause = vi.spyOn(w.d.store, 'getQueueJournal').mockReturnValue(undefined)
    await otherEngine.dispatch({ kind: 'steer_now', threadId: w.thread.id, clientRequestId: 'late', runId: oldRun, holdGeneration: generation, itemIds: [item] })
    w.adapter.end()
    await w.first
    pause.mockRestore()
    await waitFor(() => w.adapter.prompts.length === 2, 'the steer runs as its own turn')
    // Recovered now: its item is no longer held for that run.
    repairQueueJournal(w.d.store, w.thread.id)
    expect(w.events('steer.now_stale').map((event) => event.payload)).toEqual([{ runId: oldRun, holdGeneration: generation, requestId: 'late' }])
    expect(await w.d.orch.steerNow({ threadId: w.thread.id, runId: oldRun, holdGeneration: generation, itemIds: [item], clientRequestId: 'after' })).toMatchObject({ status: 'ignored', reason: 'run_not_active' })
    w.adapter.end()
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id) && w.d.engine.getActiveRun(w.thread.id) === null, 'idle')
    expect(w.delivered()).toEqual([])
    expect(w.adapter.prompts).toEqual(['first', 'too late'])
  })

  it('Send now, then Stop before the owner\'s poll, then the item steered into a new run with a held tool: nothing is forced and the field is gone', async () => {
    const w = await world()
    w.adapter.toolStart('b1')
    const item = await w.steer('re-steered')
    await waitFor(() => w.held() !== undefined, 'held')
    const generation = w.held()!.holdGeneration
    // The field lands on the item, and the Stop comes before the owner reads it.
    mutateDurableQueue(w.d.store, w.thread.id, (items) => markSteerNow(items, { runId: w.runId, holdGeneration: generation, requestId: 'old', itemIds: [item] }, w.runId).items)
    await w.d.orch.abortRun(w.runId, 'stop-1', w.thread.id)
    await w.first
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id), 'stopped')
    expect(readDurableQueue(w.d.store, w.thread.id).find((entry) => entry.id === item)?.steerNow).toBeUndefined()
    // A new run, with a held tool, and the same item steered into it.
    const second = w.send('second')
    await waitFor(() => w.adapter.prompts.includes('second') && w.adapter.runId !== undefined && w.adapter.runId !== w.runId, 'second run')
    w.adapter.toolStart('b2')
    expect(w.d.orch.promoteQueueItem(w.thread.id, item)).toEqual({ ok: true })
    await waitFor(() => w.held() !== undefined, 'held in the new run')
    await sleep(150)
    expect(w.delivered()).toEqual([])
    w.adapter.toolDone('b2')
    await waitFor(() => w.delivered().length > 0, 'released normally')
    expect(w.delivered()).toEqual(['cut:re-steered'])
    w.adapter.end()
    await second
  })

  // -------- Review findings on Codex, ACP agents and Cursor --------

  it('Grok: a subagent call reporting progress does not restart the window after the turn\'s own command', async () => {
    const w = await world('start', { settleMs: 100 })
    w.adapter.toolStart('sub', 'Grok subagent: research', { toolName: 'start_subagent', kind: 'subagent', description: 'research' } as ActivityPatch)
    w.adapter.toolStart('b1')
    await w.steer('not for the subagent')
    await waitFor(() => w.held() !== undefined, 'held for b1')
    w.adapter.toolDone('b1')
    const done = Date.now()
    let ticking = true
    const ticks = (async () => {
      // The subagent's own row gets an update every 40 ms, for as long as the steer waits.
      while (ticking) {
        w.adapter.toolOutput('sub', 'Grok subagent: research')
        await sleep(40)
      }
    })()
    await waitFor(() => w.delivered().length > 0, 'released while the subagent reports progress')
    ticking = false
    await ticks
    expect(Date.now() - done).toBeLessThan(500)
    w.adapter.toolDone('sub', 'Grok subagent: research')
    await w.finish()
  })

  it('start, strict release: a helper\'s event right after the provider\'s turn end does not hide the boundary from the steer', async () => {
    const w = await world('start', { strict: true })
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('helper', 'Agent', { toolName: 'Agent', kind: 'subagent', description: 'look around' } as ActivityPatch)
    w.adapter.toolStart('helper:cmd', 'Bash', undefined, 'helper')
    w.adapter.toolStart('b1')
    await w.steer('at the boundary')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    await sleep(STEER_SETTLE_MS * 2)
    // The turn ends, and in the same read the helper's command writes output.
    w.adapter.together(() => w.adapter.boundary(), () => w.adapter.toolOutput('helper:cmd'))
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    expect(w.delivered()).toEqual(['native:at the boundary'])
    w.adapter.toolDone('helper:cmd')
    w.adapter.toolDone('helper', 'Agent')
    await w.finish()
  })

  it('strict release: once no call runs, the wait line says the steer waits for the turn to end, not for a finished tool', async () => {
    const w = await world('start', { strict: true })
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('b1')
    await w.steer('later')
    await waitFor(() => w.held() !== undefined, 'held')
    expect(w.held()).toMatchObject({ waitsFor: 'Bash', detail: 'sleep 30 # b1' })
    w.adapter.toolDone('b1')
    await waitFor(() => w.held()?.untilTurnEnd === true, 'the line names the turn\'s end')
    expect(w.held()).toMatchObject({ waitsFor: 'turn', tools: 0 })
    expect(w.held()!.detail).toBeUndefined()
    // Another command: the line names it again.
    w.adapter.toolStart('b2')
    await waitFor(() => w.held()?.detail === 'sleep 30 # b2', 'the second command')
    expect(w.held()!.untilTurnEnd).toBeUndefined()
    w.adapter.toolDone('b2')
    w.adapter.boundary()
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    await w.finish()
  })

  describe.each([
    ['Codex (best effort, a long window)', { settleMs: 5_000 }],
    ['Cursor or an ACP agent (no measured window: strict)', { settleMs: null }]
  ] as const)("Mousse's ask_user on %s: the turn waits for a person, so the steer goes in at once", (_name, options) => {
    const ask = (w: Awaited<ReturnType<typeof world>>) => {
      const answer = w.d.questions.requestAnswers([{ id: 'q', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] }], w.thread.id)
      answer.catch(() => undefined)
      return waitFor(() => w.d.questions.listPendingForThread(w.thread.id).length === 1, 'the question pending')
    }
    it('a steer held for a command goes in once Mousse asks the person', async () => {
      const w = await world('start', { settleMs: options.settleMs === null ? null : undefined })
      if (options.settleMs !== null) (w.d.orch as unknown as { steerSettleMs: number }).steerSettleMs = options.settleMs
      w.adapter.end()
      await w.first
      const turn = w.send('again')
      await waitFor(() => w.adapter.prompts.includes('again') && w.adapter.runId !== undefined, 'a turn with the window under test')
      w.adapter.toolStart('b1')
      await w.steer('use pnpm')
      await waitFor(() => w.held() !== undefined, 'held for the command')
      w.adapter.toolDone('b1')
      w.adapter.toolStart('ask', 'mcp__mousse__ask_user', { toolName: 'mcp__mousse__ask_user', kind: 'generic' } as ActivityPatch)
      await ask(w)
      const asked = Date.now()
      await waitFor(() => w.delivered().length > 0, 'cut while Mousse asks')
      expect(Date.now() - asked).toBeLessThan(800)
      expect(w.delivered()).toEqual(['cut:use pnpm'])
      w.adapter.end()
      await turn
      await w.finish()
    })

    it('a steer sent while Mousse asks goes in at once', async () => {
      const w = await world('start', { settleMs: options.settleMs === null ? null : undefined })
      if (options.settleMs !== null) (w.d.orch as unknown as { steerSettleMs: number }).steerSettleMs = options.settleMs
      w.adapter.end()
      await w.first
      const turn = w.send('again')
      await waitFor(() => w.adapter.prompts.includes('again') && w.adapter.runId !== undefined, 'a turn with the window under test')
      w.adapter.toolStart('ask', 'mcp__mousse__ask_user', { toolName: 'mcp__mousse__ask_user', kind: 'generic' } as ActivityPatch)
      await ask(w)
      const sent = Date.now()
      // The Steer button's path (`orchestrator.steer`): a send would answer the question and start over instead.
      expect(w.d.orch.steerThreadOrEnqueueExternal(w.thread.id, 'use pnpm')).toMatchObject({ steered: true })
      await waitFor(() => w.delivered().length > 0, 'cut at once')
      expect(Date.now() - sent).toBeLessThan(800)
      expect(w.held()).toBeUndefined()
      w.adapter.end()
      await turn
      await w.finish()
    })
  })

  it('start, strict release: a question a subagent\'s call asks does not release the held steer, and the steer never answers it', async () => {
    const w = await world('start', { strict: true })
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('agent', 'Agent', { toolName: 'Agent', kind: 'subagent', description: 'research' } as ActivityPatch)
    w.adapter.toolStart('b1')
    await w.steer('after the turn')
    await waitFor(() => w.held() !== undefined, 'held for b1')
    w.adapter.toolDone('b1')
    // The subagent asks the person through Mousse's ask_user.
    w.adapter.toolStart('sub-ask', 'mcp__mousse__ask_user', { toolName: 'mcp__mousse__ask_user', kind: 'generic' } as ActivityPatch, 'agent')
    const answer = w.d.questions.requestAnswers([{ id: 'q', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }] }], w.thread.id)
    answer.catch(() => undefined)
    await waitFor(() => w.d.questions.listPendingForThread(w.thread.id).length === 1, 'the subagent\'s question pending')
    await sleep(STEER_SETTLE_MS * 2)
    expect(w.delivered()).toEqual([])
    expect(w.held()).toMatchObject({ untilTurnEnd: true })
    expect(w.d.questions.listPendingForThread(w.thread.id)).toHaveLength(1)
    // The turn's end: the steer goes in then, and the subagent's question is still the person's to answer.
    w.adapter.boundary()
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    expect(w.delivered()).toEqual(['native:after the turn'])
    expect(w.d.questions.listPendingForThread(w.thread.id)).toHaveLength(1)
    w.d.questions.dismissAllForThread(w.thread.id)
    w.adapter.toolDone('sub-ask', 'mcp__mousse__ask_user')
    w.adapter.toolDone('agent', 'Agent')
    await w.finish()
  })

  it('runs.steerRelease set over the protocol reaches the next turn: strict holds past the window', async () => {
    const configHome = mkdtempSync(join(tmpdir(), 'mousse-steer-release-'))
    extra.push(() => rmSync(configHome, { recursive: true, force: true }))
    const settings = new SettingsStore(MousseConfigStore.load(configHome))
    const w = await world('start', {
      release: async (instanceId, d) => {
        await dispatchMethod({ mms: { settings }, globalSequence: () => 0, connection: { id: 'gui-1', clientType: 'gui' } } as unknown as HandlerContext, 'settings.set', { partial: { runs: { steerRelease: { [instanceId]: 'strict' } } } })
        expect(settings.get().runs.steerRelease).toEqual({ [instanceId]: 'strict' })
        // The daemon reads the settings the protocol saved, from the next turn on.
        d.settings.runs = settings.get().runs
      }
    })
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('b1')
    await w.steer('strict over the protocol')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    w.adapter.writes('More text')
    await sleep(STEER_SETTLE_MS * 2)
    expect(w.delivered()).toEqual([])
    w.adapter.boundary()
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    expect(w.delivered()).toEqual(['native:strict over the protocol'])
    await w.finish()
  })

  it('a provider with no measured window stays strict when the instance asks for best effort', async () => {
    const w = await world('start', {
      settleMs: null,
      release: async (instanceId) => { w0.instance = instanceId }
    })
    w.d.settings.runs.steerRelease = { [w0.instance!]: 'best_effort' }
    w.adapter.end()
    await w.first
    const turn = w.send('again')
    await waitFor(() => w.adapter.prompts.includes('again') && w.adapter.runId !== undefined, 'a turn that read the setting')
    w.adapter.expect = ['cut', 'native']
    w.adapter.toolStart('b1')
    await w.steer('still strict')
    await waitFor(() => w.held() !== undefined, 'held')
    w.adapter.toolDone('b1')
    // Past the 1 s cap and the model's text: best effort would have released it.
    w.adapter.writes('More text')
    await sleep(1_300)
    expect(w.delivered()).toEqual([])
    w.adapter.boundary()
    await waitFor(() => w.delivered().length > 0, 'delivered at the boundary')
    expect(w.delivered()).toEqual(['native:still strict'])
    w.adapter.end()
    await turn
    await w.finish()
  })

  it('strict release with a tool the provider never reports complete: the steer runs once, as the follow-up turn', async () => {
    const w = await world('start', { settleMs: null })
    w.adapter.toolStart('b1')
    await w.steer('follow up')
    await waitFor(() => w.held() !== undefined, 'held')
    // The turn ends with b1 still open (no completion was ever reported).
    w.adapter.end()
    await w.first
    await waitFor(() => w.adapter.prompts.includes('follow up'), 'the follow-up turn')
    w.adapter.end()
    await waitFor(() => !w.d.orch.isActiveTurnRunning(w.thread.id) && w.d.engine.getActiveRun(w.thread.id) === null && readDurableQueue(w.d.store, w.thread.id).length === 0, 'idle')
    expect(w.adapter.prompts.filter((prompt) => prompt === 'follow up')).toHaveLength(1)
    expect(w.delivered()).toEqual([])
    expect(w.inContext('follow up')).toBe(1)
  })
})

/** The instance a warmup named, handed back by a test's `release` hook. */
const w0: { instance?: string } = {}
