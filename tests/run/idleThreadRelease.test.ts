/**
 * Releasing idle threads from the daemon's memory (`docs/design/idle-thread-release.md`), end to end on a real
 * `OrchestratorService`, Run Engine and effect worker, with a provider stand-in whose turns can be held, steered and
 * stopped. The clock of the release is the test's: a sweep runs when the test calls it.
 *
 * A thread is released only when nothing is running, queued or waiting and disk already has everything; a send, Steer
 * or Stop that meets a release runs exactly once; reloads at once share one session; a thread a window shows stays
 * loaded; a failed or interrupted release loses nothing; and the kill switch turns it all off.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { DEFAULT_FEATURE_FLAGS } from '../../src/shared/featureFlags'
import type { ChatMessage } from '../../src/shared/types'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const MODEL = { llmProvider: 'claude-subscription', model: 'vendor-model' }
const MINUTE = 60_000

/** A provider whose turns take steers while they run, and hold until released or interrupted. */
class HoldingAdapter implements ProviderAdapter {
  readonly driver = 'claude' as const
  readonly capabilities = CLAUDE_SUBSCRIPTION_CAPABILITIES
  readonly prompts: string[] = []
  readonly steers: string[] = []
  /** The history each turn was given, by prompt. */
  readonly histories = new Map<string, string[]>()
  holdPrompts = new Set<string>()
  takeSteers = true
  private readonly releases = new Map<string, () => void>()
  private readonly interrupts = new Set<() => void>()

  configured(): boolean {
    return true
  }

  release(prompt: string): void {
    this.holdPrompts.delete(prompt)
    this.releases.get(prompt)?.()
  }

  async startTurn(input: TurnInput, sink: TurnSink, ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.prompts.push(input.prompt)
    this.histories.set(input.prompt, input.messages.map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))))
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

describe('idle threads are released from memory and reload exactly as they were', () => {
  let home: string | undefined
  const previous = { home: process.env.MOUSSE_HOME, sqlite: process.env.MOUSSE_SQLITE_THREAD_STORE }
  const daemons: Phase6Daemon[] = []

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined)
    if (previous.home === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previous.home
    if (previous.sqlite === undefined) delete process.env.MOUSSE_SQLITE_THREAD_STORE
    else process.env.MOUSSE_SQLITE_THREAD_STORE = previous.sqlite
    if (home) {
      try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS cleans up */ }
    }
    home = undefined
  })

  /** A daemon over `home` that saves its sessions the way the profile does (`persistOrchestratorThread`). */
  const daemonAt = (dir: string, adapter: HoldingAdapter): Phase6Daemon => {
    const d = phase6Daemon(dir, [adapter])
    daemons.push(d)
    d.store.setSqliteStoreEnabled(true)
    d.orch.setPersistCallback((threadId) => {
      if (!threadId || !d.store.getThread(threadId) || !d.orch.hasSession(threadId)) return
      d.store.mutateThreadData(threadId, () => ({
        messages: d.orch.liveMessagesForSave(threadId) as ChatMessage[],
        llmContext: d.orch.getNativeContext(threadId)
      }))
    })
    return d
  }

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-idle-release-'))
    process.env.MOUSSE_HOME = home
    process.env.MOUSSE_SQLITE_THREAD_STORE = '1'
    mkdirSync(join(home, 'project'))
    const adapter = new HoldingAdapter()
    const d = daemonAt(home, adapter)
    const project = d.projects.openProject(join(home, 'project'))
    const thread = d.store.createThread('Idle', project.id)
    d.orch.setThreadModelOverride(thread.id, MODEL)
    expect(d.store.usesThreadDb(thread.id)).toBe(true)
    let clock = Date.parse('2026-11-10T12:00:00.000Z')
    d.orch.residency.now = () => clock
    const advance = (ms: number): void => {
      clock += ms
    }
    let sends = 0
    const send = (text: string) => d.orch.send(text, false, { threadId: thread.id, clientRequestId: `send-${++sends}` })
    const queue = () => readDurableQueue(d.store, thread.id)
    const pending = () => d.orch.listQueue(thread.id).map((item) => item.content)
    const loaded = () => d.orch.hasSession(thread.id)
    const hold = () => d.orch.releaseHoldReason(thread.id)
    /** Waits until the thread may be released (its turn, title and queue all done). */
    const settled = async (label: string): Promise<void> => {
      await waitFor(() => !d.orch.isActiveTurnRunning(thread.id) && queue().length === 0 && d.engine.getActiveRun(thread.id) === null, label)
      await waitFor(() => hold() === undefined, `${label}: still held (${hold()})`)
    }
    /** Sweeps after the thread has been idle past the release time. */
    const sweepIdle = (): string[] => {
      advance(11 * MINUTE)
      return d.orch.residency.sweepNow()
    }
    const userMessages = () => d.orch.getOrCreateSession(thread.id).messages.filter((message) => message.role === 'user').map((message) => message.content)
    const onDisk = () => d.store.loadThreadData(thread.id).messages.map((message) => `${message.role}:${message.content}`)
    return { d, adapter, thread, send, queue, pending, loaded, hold, settled, sweepIdle, advance, userMessages, onDisk }
  }

  const expectEachOnce = (adapter: HoldingAdapter, texts: string[]): void => {
    const delivered = [...adapter.prompts, ...adapter.steers]
    for (const text of texts) expect(delivered.filter((seen) => seen === text), text).toHaveLength(1)
    expect([...delivered].sort()).toEqual([...texts].sort())
  }

  it('the kill switch is on by default', () => {
    expect(DEFAULT_FEATURE_FLAGS.releaseIdleThreads).toBe(true)
  })

  it('releases a thread idle past the release time; the next send reloads it and runs once with the full history', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    const before = w.onDisk()
    expect(before).toEqual(['user:first', 'assistant:reply to first'])

    // Not yet idle long enough.
    w.advance(9 * MINUTE)
    expect(w.d.orch.residency.sweepNow()).toEqual([])
    expect(w.loaded()).toBe(true)
    expect(w.sweepIdle()).toEqual([w.thread.id])
    expect(w.loaded()).toBe(false)
    // The thread database cache let go of it too.
    expect(w.d.store.threadDbCacheStats().threads).toBe(0)

    await w.send('second')
    await w.settled('second turn')
    expect(w.adapter.prompts).toEqual(['first', 'second'])
    expect(w.adapter.histories.get('second')!.join('\n')).toContain('reply to first')
    expect(w.onDisk()).toEqual(['user:first', 'assistant:reply to first', 'user:second', 'assistant:reply to second'])
    expect(w.d.orch.residency.counters).toMatchObject({ released: 1, reloads: 1, staleUses: 0, failedReleases: 0 })
  })

  it('release then reload gives the same transcript and context, moves no updatedAt and emits nothing', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    const session = w.d.orch.getOrCreateSession(w.thread.id)
    const messages = JSON.stringify(session.messages)
    const context = JSON.stringify(session.nativeContext)
    const updatedAt = w.d.store.getThread(w.thread.id)!.updatedAt
    const emitted: string[] = []
    const emit = w.d.orch.emit.bind(w.d.orch)
    w.d.orch.emit = ((event: string, ...args: unknown[]) => {
      emitted.push(event)
      return emit(event, ...args)
    }) as typeof w.d.orch.emit
    // Window events come from the orchestrator and the thread store (`threads.touched`, `threads.updated`).
    const touched: string[] = []
    const storeEmit = w.d.store.emit.bind(w.d.store)
    w.d.store.emit = ((event: string, ...args: unknown[]) => {
      touched.push(event)
      return storeEmit(event, ...args)
    }) as typeof w.d.store.emit

    expect(w.sweepIdle()).toEqual([w.thread.id])
    expect(w.d.orch.residency.counters.unsavedAtRelease).toBe(0)
    const reloaded = await w.d.orch.ensureSessionLoaded(w.thread.id)
    expect(reloaded).not.toBe(session)
    expect(JSON.stringify(reloaded.messages)).toBe(messages)
    expect(reloaded.nativeContext).toEqual(JSON.parse(context))
    expect(emitted).toEqual([])
    expect(touched).toEqual([])
    expect(w.d.store.getThread(w.thread.id)!.updatedAt).toBe(updatedAt)
    // The turn state a window reads is kept.
    expect(w.d.orch.getTurnState(w.thread.id).phase).not.toBe('streaming')
  })

  it('a send in the same tick as the sweep runs once, in either order', async () => {
    for (const order of ['microtask', 'immediate'] as const) {
      const w = world()
      await w.send('first')
      await w.settled('first turn')
      w.advance(11 * MINUTE)
      let sent: Promise<unknown>
      if (order === 'microtask') {
        queueMicrotask(() => w.d.orch.residency.sweepNow())
        sent = w.send('second')
      } else {
        sent = w.send('second')
        setImmediate(() => w.d.orch.residency.sweepNow())
      }
      await sent
      await w.settled('second turn')
      expect(w.adapter.prompts, order).toEqual(['first', 'second'])
      expect(w.d.engine.listRuns(w.thread.id)).toHaveLength(2)
      expect(w.onDisk(), order).toEqual(['user:first', 'assistant:reply to first', 'user:second', 'assistant:reply to second'])
      expect(w.d.orch.residency.counters.staleUses).toBe(0)
      await daemons.pop()!.stop()
      try { rmSync(home!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* the OS cleans up */ }
    }
  })

  it('a queue behind a turn holds the thread until it has drained; each message runs once, in order', async () => {
    const w = world()
    w.adapter.holdPrompts.add('first')
    w.adapter.holdPrompts.add('A')
    const first = w.send('first')
    await waitFor(() => w.adapter.prompts.includes('first'), 'first turn')
    expect((await w.send('A')).queued).toBe(true)
    expect((await w.send('B')).queued).toBe(true)
    expect(w.sweepIdle()).toEqual([])
    w.adapter.release('first')
    await first
    // The drain runs A: still held.
    await waitFor(() => w.adapter.prompts.includes('A'), 'A runs')
    expect(w.sweepIdle()).toEqual([])
    expect(w.loaded()).toBe(true)
    w.adapter.release('A')
    await w.settled('queue drained')
    expect(w.adapter.prompts).toEqual(['first', 'A', 'B'])
    expect(w.sweepIdle()).toEqual([w.thread.id])
    expectEachOnce(w.adapter, ['first', 'A', 'B'])
    expect(w.onDisk().filter((row) => row.startsWith('user:'))).toEqual(['user:first', 'user:A', 'user:B'])
  })

  it('a Steer on a queued message holds the thread until it is read and the turn ends', async () => {
    const w = world()
    w.adapter.holdPrompts.add('first')
    w.adapter.takeSteers = false
    const first = w.send('first')
    await waitFor(() => w.adapter.prompts.includes('first'), 'first turn')
    const c = await w.send('C')
    expect(w.d.orch.promoteQueueItem(w.thread.id, c.queueItem!.id)).toEqual({ ok: true })
    // The steered message is not read yet.
    expect(w.sweepIdle()).toEqual([])
    w.adapter.takeSteers = true
    await waitFor(() => w.adapter.steers.length > 0, 'steer taken')
    expect(w.sweepIdle()).toEqual([])
    w.adapter.release('first')
    await first
    await w.settled('turn ended')
    expect(w.sweepIdle()).toEqual([w.thread.id])
    expectEachOnce(w.adapter, ['first', 'C'])
    expect(w.onDisk().filter((row) => row.startsWith('user:'))).toEqual(['user:first', 'user:C'])
  })

  it('a late Steer on a message that already ran, after a release, runs nothing twice', async () => {
    const w = world()
    w.adapter.holdPrompts.add('first')
    const first = w.send('first')
    await waitFor(() => w.adapter.prompts.includes('first'), 'first turn')
    const c = await w.send('C')
    w.adapter.release('first')
    await first
    await w.settled('queue drained')
    expect(w.sweepIdle()).toEqual([w.thread.id])
    // The message already ran; a late Steer click on it changes nothing and loads the thread to answer.
    let late: unknown
    try { late = w.d.orch.promoteQueueItem(w.thread.id, c.queueItem!.id) } catch (error) { late = error }
    expect(late).toBeInstanceOf(Error)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expectEachOnce(w.adapter, ['first', 'C'])
  })

  it('Stop with a message sent during the stop holds the thread until that message has run', async () => {
    const w = world()
    w.adapter.holdPrompts.add('first')
    const first = w.send('first')
    await waitFor(() => w.adapter.prompts.includes('first'), 'first turn')
    const runId = w.d.engine.getActiveRun(w.thread.id)!.runId
    const stopping = w.d.orch.abortRun(runId, 'stop-1', w.thread.id)
    const during = w.send('after stop')
    expect(w.sweepIdle()).toEqual([])
    await stopping
    await first
    await during
    await w.settled('message after stop ran')
    expect(w.adapter.prompts).toEqual(['first', 'after stop'])
    expect(w.sweepIdle()).toEqual([w.thread.id])
    expect(w.onDisk().filter((row) => row.startsWith('user:'))).toEqual(['user:first', 'user:after stop'])
  })

  it('two reloads at once share one session', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    expect(w.sweepIdle()).toEqual([w.thread.id])
    const [a, b] = await Promise.all([w.d.orch.ensureSessionLoaded(w.thread.id), w.d.orch.ensureSessionLoaded(w.thread.id)])
    expect(a).toBe(b)
    expect(w.d.orch.residency.counters.reloads).toBe(1)
    expect(a.messages.map((message) => message.content)).toEqual(['first', 'reply to first'])
  })

  it('a sweep while a reload is reading the thread skips it', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    expect(w.sweepIdle()).toEqual([w.thread.id])
    const reload = w.d.orch.ensureSessionLoaded(w.thread.id)
    // A synchronous caller loads it meanwhile; the reload in the read worker has not finished.
    const sync = w.d.orch.getOrCreateSession(w.thread.id)
    expect(w.d.orch.residency.isWarming(w.thread.id)).toBe(true)
    expect(w.sweepIdle()).toEqual([])
    expect(w.hold()).toBe('reloading')
    expect(await reload).toBe(sync)
    expect(w.sweepIdle()).toEqual([w.thread.id])
  })

  it('a failed save at release leaves the thread loaded and loses nothing', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    // Something only memory has: a message not saved yet.
    w.d.orch.getOrCreateSession(w.thread.id).messages.push({ id: 'unsaved-1', role: 'user', content: 'not saved yet', timestamp: new Date().toISOString() } as ChatMessage)
    const save = w.d.store.mutateThreadData.bind(w.d.store)
    w.d.store.mutateThreadData = (() => { throw new Error('disk full') }) as typeof w.d.store.mutateThreadData
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(w.sweepIdle()).toEqual([])
    warn.mockRestore()
    expect(w.loaded()).toBe(true)
    expect(w.d.orch.residency.counters.failedReleases).toBe(1)
    w.d.store.mutateThreadData = save
    expect(w.sweepIdle()).toEqual([w.thread.id])
    expect(w.d.orch.residency.counters.unsavedAtRelease).toBe(2)
    expect(w.onDisk()).toContain('user:not saved yet')
  })

  it('a crash in the middle of a release loses nothing: the restarted daemon has the transcript and the queue', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    w.d.orch.getOrCreateSession(w.thread.id).messages.push({ id: 'unsaved-1', role: 'user', content: 'owed', timestamp: new Date().toISOString() } as ChatMessage)
    // The process dies inside the release's save, before its transaction commits.
    const client = (w.d.store as unknown as { threadDb(): { client: { callSync: (...args: unknown[]) => unknown } } }).threadDb().client
    const callSync = client.callSync.bind(client)
    client.callSync = (op: unknown, ...args: unknown[]) => {
      if (op === 'save') throw new Error('process killed')
      return callSync(op, ...args)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(w.sweepIdle()).toEqual([])
    warn.mockRestore()
    client.callSync = callSync
    await w.d.crash()
    daemons.splice(daemons.indexOf(w.d), 1)

    // A new daemon on the same home: the transcript is the last one committed, and the thread runs on.
    const adapter = new HoldingAdapter()
    const d = daemonAt(home!, adapter)
    d.orch.recoverAndDrainPendingQueues()
    expect(d.store.loadThreadData(w.thread.id).messages.map((message) => message.content)).toEqual(['first', 'reply to first'])
    expect(readDurableQueue(d.store, w.thread.id)).toEqual([])
    await d.orch.send('after restart', false, { threadId: w.thread.id, clientRequestId: 'after-restart' })
    await waitFor(() => adapter.prompts.includes('after restart') && !d.orch.isActiveTurnRunning(w.thread.id), 'turn after restart')
    expect(adapter.prompts).toEqual(['after restart'])
  })

  it('the queue, Steer items and receipts survive a release', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    expect(w.sweepIdle()).toEqual([w.thread.id])
    // The same request again after the release: its receipt answers, nothing runs twice.
    const repeat = await w.d.orch.send('first', false, { threadId: w.thread.id, clientRequestId: 'send-1' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(w.adapter.prompts).toEqual(['first'])
    expect(repeat).toBeDefined()
    // A queue built after the release drains once, in order, Steer included.
    w.adapter.holdPrompts.add('second')
    w.adapter.takeSteers = false
    const second = w.send('second')
    await waitFor(() => w.adapter.prompts.includes('second'), 'second turn')
    const a = await w.send('A')
    const b = await w.send('B')
    expect(w.pending()).toEqual(['A', 'B'])
    expect(w.sweepIdle()).toEqual([])
    expect(w.d.orch.promoteQueueItem(w.thread.id, b.queueItem!.id)).toEqual({ ok: true })
    expect(w.sweepIdle()).toEqual([])
    w.adapter.takeSteers = true
    await waitFor(() => w.adapter.steers.includes('B'), 'B steered')
    w.adapter.release('second')
    await second
    await w.settled('drained')
    expect(a.queueItem).toBeDefined()
    expectEachOnce(w.adapter, ['first', 'second', 'A', 'B'])
    expect(w.sweepIdle()).toEqual([w.thread.id])
    expect(w.d.orch.residency.counters.staleUses).toBe(0)
  })

  it('a thread a window shows is never released, however long it is idle', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    const lifetime = new AbortController()
    w.d.orch.setThreadViewed('window-1', w.thread.id, true, lifetime.signal)
    for (let i = 0; i < 5; i++) expect(w.sweepIdle()).toEqual([])
    expect(w.hold()).toBe('shown in a window')
    // Two windows: one leaving keeps it for the other.
    w.d.orch.setThreadViewed('window-2', w.thread.id, true)
    w.d.orch.setThreadViewed('window-2', w.thread.id, false)
    expect(w.sweepIdle()).toEqual([])
    // The window closes: the thread is released once idle again.
    lifetime.abort()
    w.advance(5 * MINUTE)
    expect(w.d.orch.residency.sweepNow()).toEqual([])
    expect(w.sweepIdle()).toEqual([w.thread.id])
  })

  it('the kill switch releases nothing; turning it back on does', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    let enabled = false
    w.d.orch.residency.setEnabled(() => enabled)
    expect(w.sweepIdle()).toEqual([])
    expect(w.d.orch.releaseIfIdle(w.thread.id)).toBe(false)
    expect(w.loaded()).toBe(true)
    enabled = true
    expect(w.sweepIdle()).toEqual([w.thread.id])
  })

  it('keeps at most the cap of idle threads, releasing the least recently used first', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    w.d.orch.residency.maxIdleLoaded = 2
    const others = [1, 2, 3].map((i) => {
      const thread = w.d.store.createThread(`Other ${i}`)
      w.d.orch.getOrCreateSession(thread.id)
      w.advance(10_000)
      return thread.id
    })
    // The first thread is the least recently used; all are idle only seconds to a minute.
    w.advance(LRU_WAIT)
    const released = w.d.orch.residency.sweepNow()
    expect(released).toEqual([w.thread.id, others[0]])
    expect(others.slice(1).every((id) => w.d.orch.hasSession(id))).toBe(true)
  })

  it('each condition of the rule holds the thread on its own', async () => {
    const w = world()
    await w.send('first')
    await w.settled('first turn')
    const session = w.d.orch.getOrCreateSession(w.thread.id)
    const orch = w.d.orch as unknown as Record<string, Map<string, unknown> | Set<string>>
    const cases: Array<[string, () => () => void]> = [
      ['turnAdmitted', () => { session.turnAdmitted = true; return () => { session.turnAdmitted = false } }],
      ['drainAfterSettle', () => { session.drainAfterSettle = true; return () => { session.drainAfterSettle = false } }],
      ['abortRequested', () => { session.abortRequested = true; return () => { session.abortRequested = false } }],
      ['stopping', () => { session.stopping = true; return () => { session.stopping = false } }],
      ['sentAfterStop', () => { session.sentAfterStop.push('x'); return () => { session.sentAfterStop.length = 0 } }],
      ['setupStop', () => { session.setupStop = new AbortController(); return () => { session.setupStop = null } }],
      ['executionLease', () => { session.executionLease = {} as never; return () => { session.executionLease = null } }],
      ['failedConnectionRequest', () => { session.failedConnectionRequest = { content: 'retry' } as never; return () => { session.failedConnectionRequest = null } }],
      ['open activity row', () => {
        session.messages.push({ id: 'tool-1', role: 'assistant', content: '', activity: { status: 'running' }, timestamp: new Date().toISOString() } as unknown as ChatMessage)
        return () => { session.messages.pop() }
      }],
      ['queue on disk', () => {
        w.d.store.saveMessageQueue(w.thread.id, [{ id: 'q1', threadId: w.thread.id, content: 'queued', createdAt: new Date().toISOString(), state: 'pending', intent: 'normal' } as never])
        return () => w.d.store.saveMessageQueue(w.thread.id, [])
      }],
      ['compaction', () => { (orch.compactions as Map<string, unknown>).set(w.thread.id, new AbortController()); return () => { (orch.compactions as Map<string, unknown>).delete(w.thread.id) } }],
      ['title work', () => { (orch.titleWork as Map<string, unknown>).set(w.thread.id, Promise.resolve()); return () => { (orch.titleWork as Map<string, unknown>).delete(w.thread.id) } }],
      ['provider background', () => { (orch.providerBackground as Set<string>).add(w.thread.id); return () => { (orch.providerBackground as Set<string>).delete(w.thread.id) } }],
      ['scheduled turn', () => { (orch.scheduledTurnThreads as Set<string>).add(w.thread.id); return () => { (orch.scheduledTurnThreads as Set<string>).delete(w.thread.id) } }],
      ['startup drain', () => { (orch.startupDrainScheduled as Set<string>).add(w.thread.id); return () => { (orch.startupDrainScheduled as Set<string>).delete(w.thread.id) } }],
      ['warming', () => { w.d.orch.residency.beginWarm(w.thread.id); return () => w.d.orch.residency.endWarm(w.thread.id) }],
      ['viewed', () => { w.d.orch.setThreadViewed('window', w.thread.id, true); return () => w.d.orch.setThreadViewed('window', w.thread.id, false) }],
      ['question', () => {
        const asked = w.d.questions.requestAnswers([{ id: 'q', prompt: 'x', options: [{ id: 'a', label: 'A' }] }], w.thread.id).catch(() => undefined)
        void asked
        return () => w.d.questions.dismissAllForThread(w.thread.id)
      }]
    ]
    expect(w.hold()).toBeUndefined()
    for (const [name, apply] of cases) {
      const undo = apply()
      expect(w.hold(), name).toBeDefined()
      expect(w.sweepIdle(), name).toEqual([])
      expect(w.loaded(), name).toBe(true)
      undo()
      expect(w.hold(), `${name} undone`).toBeUndefined()
    }
    expect(w.sweepIdle()).toEqual([w.thread.id])
  })
})

const LRU_WAIT = 2 * MINUTE
