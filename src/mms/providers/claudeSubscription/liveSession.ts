import { randomUUID } from 'node:crypto'
import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Claude threads run on a long-lived query (issue #142): the prompt is a queue-backed iterable that
 * never ends on its own, so the Claude Code process, and the background agents and shells it
 * started, outlive the turn that started them. This module is that query's side of the contract:
 *
 * - `PromptQueue`: the input stream. Every Mousse turn, steer and later turn is pushed into it.
 * - `BackgroundObligations`: the tasks Claude started that still owe the thread a notification.
 * - `LiveRun`: one Mousse turn (or one turn Claude started on its own) on the shared stream.
 * - `LiveSession`: the query, the router that gives every frame and result to the run that owns it,
 *   and the idle release.
 *
 * Nothing here knows about settings, permissions or the orchestrator; the provider service builds
 * the query and drives the runs.
 */

/** How long a thread with no background work keeps its idle process before it is closed. */
export const LIVE_IDLE_CLOSE_MS = 3 * 60_000
/** With background work pending: how long the thread may be silent before the release is reconsidered. */
export const LIVE_IDLE_RELEASE_MS = 30 * 60_000
/** With background work pending: the longest the release is deferred without any provider activity. */
export const LIVE_MAX_PIN_MS = 4 * 60 * 60_000
/** Live Claude processes across threads. Beyond it a turn runs as a one-shot query, as before. */
export const LIVE_MAX_SESSIONS = 4
/** A task finished and Claude never started its own turn: the wake ends after this long. */
export const WAKE_TURN_START_DEADLINE_MS = 2 * 60_000
/** A steer waits at most this long for foreground subagents to move to the background. */
export const STEER_BACKGROUND_MOVE_MS = 5_000

export interface LiveTimings {
  idleCloseMs: number
  idleReleaseMs: number
  maxPinMs: number
  maxSessions: number
  wakeDeadlineMs: number
  backgroundMoveMs: number
}

export const DEFAULT_LIVE_TIMINGS: LiveTimings = {
  idleCloseMs: LIVE_IDLE_CLOSE_MS,
  idleReleaseMs: LIVE_IDLE_RELEASE_MS,
  maxPinMs: LIVE_MAX_PIN_MS,
  maxSessions: LIVE_MAX_SESSIONS,
  wakeDeadlineMs: WAKE_TURN_START_DEADLINE_MS,
  backgroundMoveMs: STEER_BACKGROUND_MOVE_MS
}

/** The input stream of a live query. It ends only when closed. */
export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined
  private closed = false

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: message, done: false })
    } else this.items.push(message)
    return true
  }

  close(): void {
    this.closed = true
    this.items.length = 0
    const resolve = this.waiting
    this.waiting = undefined
    resolve?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      }
    }
  }
}

/** A task Claude started in the background, as the roster names it. */
interface BackgroundTask {
  description?: string
  type?: string
}

/**
 * The background tasks of one Claude process that still owe the thread something (issue #142, plan
 * v8). Every task seen in the roster is an obligation. It ends only when a conversational run that
 * consumed the task's notification commits (`commit`), when the notification turns out to be opaque
 * (`discard`), or when the process ends or the idle cap expires (`clear`). An empty roster alone
 * clears nothing: the notification may still be on its way. The set belongs to one process.
 */
/**
 * Marks the notifications of a turn that was cut off after Claude read them. Claude has them in its
 * context, so they are not delivered again: the next turn on the process takes them over (`adopt`)
 * and they end when it commits.
 */
const CARRIED = Symbol('carried')

export class BackgroundObligations {
  private readonly tasks = new Map<string, BackgroundTask>()
  private readonly consumers = new Map<string, unknown>()

  get size(): number {
    return this.tasks.size
  }

  ids(): string[] {
    return [...this.tasks.keys()]
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId)
  }

  describe(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.description
  }

  /** The roster after a change. Adds the tasks it names; never removes one. Returns whether the set grew. */
  observeRoster(tasks: ReadonlyArray<{ task_id: string; task_type?: string; description?: string; ambient?: boolean }>): boolean {
    let grew = false
    for (const task of tasks) {
      if (task.ambient || this.tasks.has(task.task_id)) continue
      this.tasks.set(task.task_id, { description: task.description, type: task.task_type })
      grew = true
    }
    return grew
  }

  /** The notification of `taskId` is being consumed by `owner`; the obligation stays until `commit(owner)`. */
  consume(taskId: string, owner: unknown): void {
    if (this.tasks.has(taskId)) this.consumers.set(taskId, owner)
  }

  consumed(taskId: string): boolean {
    return this.consumers.has(taskId)
  }

  /** What `from` consumed now belongs to `to` (a wake that folded a Mousse prompt in). */
  reassign(from: unknown, to: unknown): void {
    for (const [id, consumer] of this.consumers) if (consumer === from) this.consumers.set(id, to)
  }

  /** `owner` committed: the tasks it consumed are done. Returns whether the set changed. */
  commit(owner: unknown): boolean {
    let changed = false
    for (const [id, consumer] of this.consumers) {
      if (consumer !== owner) continue
      this.consumers.delete(id)
      changed = this.tasks.delete(id) || changed
    }
    return changed
  }

  /** `owner` was cut off without committing: Claude already read what it consumed, so the next turn on the process takes it over. */
  release(owner: unknown): void {
    for (const [id, consumer] of this.consumers) if (consumer === owner) this.consumers.set(id, CARRIED)
  }

  /** `owner` is the next turn on the process: it takes over what a cut-off turn had read. */
  adopt(owner: unknown): void {
    this.reassign(CARRIED, owner)
  }

  discard(taskId: string): boolean {
    this.consumers.delete(taskId)
    return this.tasks.delete(taskId)
  }

  clear(): boolean {
    const had = this.tasks.size > 0
    this.tasks.clear()
    this.consumers.clear()
    return had
  }
}

export interface RunOutcome {
  /** The turn's result frame; null when the run ended without one (`reason`). */
  result: SDKResultMessage | null
  reason?: 'deadline' | 'folded'
}

export type FrameConsumer = (message: SDKMessage) => void

/**
 * One turn on the shared stream. A Mousse turn owns the ids of the messages it pushed (its prompt
 * and its steers) and ends at the result that echoes them. A continuation is a turn Claude started
 * itself, after a background task finished; it ends at the next result that echoes none of ours.
 */
export class LiveRun {
  /** Gates this turn's permission prompts, hooks and cancellation; the query itself never sees it. */
  readonly controller = new AbortController()
  /** Every message id this run pushed; a frame or result that echoes one belongs to the run. */
  readonly ids = new Set<string>()
  /** Pushed message ids no result has echoed yet. */
  readonly owned = new Set<string>()
  steered = false
  settled = false
  /** The turn was cancelled but the stream still owes its result; frames are dropped until then. */
  abandoned = false
  /** A steer is waiting for foreground work to move to the background; the run cannot end meanwhile. */
  steerInFlight = 0
  /**
   * The turn's own result arrived. Settling waits while a steer is in flight, so this is the fact a
   * steer checks: once it is true the steer is not pushed, it becomes the next turn.
   */
  resultSeen = false
  /** The result that arrived while a steer was in flight; it settles the run if that steer is not pushed. */
  deferredResult: SDKResultMessage | undefined
  /** The turn produced its first frame. */
  started = false
  /** A discarded turn was interrupted. */
  interruptSent = false
  readonly buffered: SDKMessage[] = []
  consumer: FrameConsumer | undefined
  readonly done: Promise<RunOutcome>
  private finish!: (outcome: RunOutcome) => void
  private fail!: (error: Error) => void

  constructor(readonly kind: 'prompt' | 'continuation', consumer?: FrameConsumer) {
    this.consumer = consumer
    this.done = new Promise<RunOutcome>((resolve, reject) => {
      this.finish = resolve
      this.fail = reject
    })
    // The caller that cancelled the run no longer reads it.
    this.done.catch(() => undefined)
  }

  deliver(message: SDKMessage): void {
    if (this.abandoned) return
    if (this.consumer) this.consumer(message)
    else this.buffered.push(message)
  }

  /** Hands the frames a continuation collected before its run existed to `consumer`, then follows live. */
  attach(consumer: FrameConsumer): void {
    this.consumer = consumer
    for (const message of this.buffered.splice(0)) consumer(message)
  }

  resolve(outcome: RunOutcome): void {
    this.settled = true
    this.finish(outcome)
  }

  reject(error: Error): void {
    this.settled = true
    this.fail(error)
  }
}

/** What the session tells its owner. Every callback is synchronous and must not throw. */
export interface LiveSessionHooks {
  /** The thread's set of obligations became non-empty (`true`) or empty. */
  backgroundWork(active: boolean): void
  /** Claude started a turn of its own: `taskIds` finished and nobody was waiting for them. */
  continuationStarted(run: LiveRun, info: { taskIds: string[]; summaries: string[] }): void
  /** The process ended or was released. */
  ended(reason: 'closed' | 'idle' | 'idle-cap' | 'died'): void
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function echoedIds(message: SDKMessage): string[] {
  const frame = message as { user_message_uuid?: unknown; user_message_uuids?: unknown }
  if (Array.isArray(frame.user_message_uuids)) return frame.user_message_uuids.filter((id): id is string => typeof id === 'string')
  return typeof frame.user_message_uuid === 'string' ? [frame.user_message_uuid] : []
}

const isTaskOrigin = (message: SDKMessage): boolean => {
  const origin = (message as { origin?: unknown }).origin
  return isRecord(origin) && origin.kind === 'task-notification'
}

/** A result an interrupt produced for a turn that was steered, not the turn's own end. */
function isAbortResult(message: SDKResultMessage): boolean {
  const reason = (message as { terminal_reason?: unknown }).terminal_reason
  return reason === 'aborted_streaming' || reason === 'aborted_tools'
}

/**
 * A live Claude query and the router over its stream (plan v9 to v11). One pump reads the query for
 * its whole life and gives each frame to the run that owns it:
 *
 * - A frame or result that echoes the id of a message a run pushed belongs to that run.
 * - Otherwise it belongs to the run whose frames are in flight (the cursor), then to the oldest run
 *   still waiting, then to a continuation, which opens when Claude starts a turn nobody asked for.
 * - A run ends at the result that echoes its ids, never at a result of someone else's turn.
 */
export class LiveSession<Turn = unknown> {
  readonly obligations = new BackgroundObligations()
  /** The turn the owner is running now; the query's permission hooks read it. */
  current: Turn | undefined
  readonly queue = new PromptQueue()
  /** The query's own lifetime: aborted only by Stop, idle release or replacement. */
  readonly lifetime = new AbortController()
  sessionId: string | undefined
  dead = false
  /** What the owner keyed this query on (model, folder, instructions...); the service compares it. */
  meta: Record<string, unknown> = {}
  private query: Query | undefined
  private readonly runs: LiveRun[] = []
  private continuation: LiveRun | undefined
  /** Continuations nobody has taken yet, oldest first. */
  private readonly unclaimed: LiveRun[] = []
  private cursor: LiveRun | undefined
  /** Turns about to use the session (see `reserve`). */
  private reserved = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private pinnedSince: number | undefined
  private reportedBackground = false
  lastUsed = Date.now()

  constructor(
    readonly threadId: string,
    private readonly hooks: LiveSessionHooks,
    private readonly timings: LiveTimings = DEFAULT_LIVE_TIMINGS
  ) {}

  /** Starts reading the query. Called once, right after it is created. */
  attach(query: Query): void {
    this.query = query
    void this.pump(query)
    this.armIdle()
  }

  /** A run is live: pushed and not yet ended (an abandoned one still owes its result). */
  get busy(): boolean {
    return this.runs.some((run) => !run.abandoned) || (this.continuation !== undefined && !this.continuation.abandoned)
  }

  /** Runs that are still waiting for their result (cancelled turns that owe one do not count). */
  get pendingRuns(): number {
    return this.runs.filter((run) => !run.abandoned).length
  }

  /** Cancelled turns that still own a message Claude has not answered. */
  get owedResults(): number {
    return this.runs.filter((run) => run.abandoned).length
  }

  beginRun(consumer: FrameConsumer): LiveRun {
    const run = new LiveRun('prompt', consumer)
    this.runs.push(run)
    this.clearIdle()
    this.obligations.adopt(run)
    return run
  }

  /**
   * The owner is about to use this session for a turn (it is between acquiring it and beginning the
   * run): the idle release must not close it meanwhile. The returned function ends the hold.
   */
  reserve(): () => void {
    this.reserved++
    this.clearIdle()
    let held = true
    return () => {
      if (!held) return
      held = false
      this.reserved--
      if (!this.busy) this.armIdle()
    }
  }

  /** The turn Claude started on its own, if one is in flight. */
  openContinuation(): LiveRun | undefined {
    return this.continuation && !this.continuation.settled && !this.continuation.abandoned ? this.continuation : undefined
  }

  /**
   * The oldest turn Claude started on its own that no run has taken yet, whether it is still in flight
   * or already over (its frames and result wait for the run). The run that takes it reads them.
   */
  claimContinuation(): LiveRun | undefined {
    const run = this.unclaimed.shift()
    if (run) this.obligations.adopt(run)
    return run
  }

  hasUnclaimedContinuation(): boolean {
    return this.unclaimed.length > 0
  }

  /**
   * The host did not run the turn Claude started on its own: what it read is done, and a turn still
   * in flight is interrupted, since nobody would see it.
   */
  discardContinuation(run: LiveRun): void {
    const index = this.unclaimed.indexOf(run)
    if (index >= 0) this.unclaimed.splice(index, 1)
    this.obligations.adopt(run)
    this.obligations.commit(run)
    this.backgroundChanged()
    if (run.settled || run.abandoned) return
    // The turn may not have begun yet (the notification comes first): it stays the frames' target, so
    // everything it says is dropped, and it is interrupted as soon as its first frame shows it started.
    run.abandoned = true
    run.consumer = undefined
    run.buffered.length = 0
    if (run.started) this.interruptDiscarded(run)
  }

  private interruptDiscarded(run: LiveRun): void {
    if (run.interruptSent || this.dead || !this.query) return
    run.interruptSent = true
    void Promise.resolve(this.query.interrupt()).catch(() => undefined)
  }

  /** Pushes a message a run owns. Returns the id it will be echoed under. */
  push(run: LiveRun, message: SDKUserMessage): string {
    const uuid = randomUUID()
    if (run.settled || this.dead) throw new Error('Claude Code ended before completing the turn')
    run.owned.add(uuid)
    run.ids.add(uuid)
    if (!this.queue.push({ ...message, uuid })) {
      run.owned.delete(uuid)
      run.ids.delete(uuid)
      throw new Error('Claude Code ended before completing the turn')
    }
    this.clearIdle()
    return uuid
  }

  /**
   * Delivers a steer to the live turn without interrupting it: foreground subagents move to the
   * background first (a steer aborts the stream, which would end them), then the text is pushed as an
   * immediate user message the run owns. Returns false when the run ended first.
   */
  async steer(run: LiveRun, text: string): Promise<boolean> {
    const query = this.query
    if (!query || run.settled || run.abandoned || this.dead) return false
    run.steerInFlight++
    try {
      const moved = (query as { backgroundTasks?: () => Promise<boolean> }).backgroundTasks?.()
      if (moved) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          moved.catch(() => false),
          new Promise((resolve) => {
            timer = setTimeout(resolve, this.timings.backgroundMoveMs)
          })
        ])
        if (timer) clearTimeout(timer)
      }
      // The turn's result may have arrived while the foreground work moved; settling waited for this
      // steer, but a steer never starts a turn the run no longer owns: it is the next queued turn.
      if (run.settled || run.resultSeen || run.abandoned || this.dead || this.query !== query) return false
      this.push(run, {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        priority: 'now',
        session_id: this.sessionId ?? ''
      })
      run.steered = true
      run.deferredResult = undefined
      return true
    } finally {
      run.steerInFlight--
      const deferred = run.deferredResult
      if (deferred && run.steerInFlight === 0 && !run.settled && !run.abandoned) {
        run.deferredResult = undefined
        this.settle(run, deferred)
      }
    }
  }

  /**
   * The turn was cancelled but the query stays open: the turn is interrupted, and the run keeps
   * owning its ids as a tombstone so the result the interrupt produces is not given to anyone else.
   */
  abandon(run: LiveRun): void {
    if (run.settled || run.abandoned) return
    run.abandoned = true
    run.buffered.length = 0
    run.consumer = undefined
    this.obligations.release(run)
    const unclaimed = this.unclaimed.indexOf(run)
    if (unclaimed >= 0) this.unclaimed.splice(unclaimed, 1)
    const query = this.query
    // A turn that pushed nothing has nothing in flight; one that did, or a wake, is interrupted. An
    // interrupt of an idle query is harmless, and one that fails leaves the next turn to find out.
    if (query && !this.dead && (run.ids.size > 0 || run.kind === 'continuation')) void this.interruptFor(run, query)
    // A run that was never answered keeps owning its ids until the result the interrupt produces.
    if (run.owned.size === 0 || run.kind === 'continuation') this.finishCancelled(run)
  }

  /**
   * Interrupts the turn and cancels the messages the run pushed that Claude has not started: a prompt
   * or steer left in Claude's input queue would otherwise run later with nobody owning it. What the
   * receipt names as cancelled is released; what it says will still run stays owned by the cancelled
   * run, so its result is not given to anyone else. A Claude Code that sends no receipt cannot cancel
   * a prompt it never started; only closing the process drops it, which is not done while the process
   * has background work (the prompt then runs and its result is dropped).
   */
  private async interruptFor(run: LiveRun, query: Query): Promise<void> {
    let receipt: { cancelled?: string[] } | undefined
    try {
      receipt = (await (query as { interrupt(options?: { cancelQueued?: boolean }): Promise<{ cancelled?: string[] } | undefined> }).interrupt({ cancelQueued: true })) ?? undefined
    } catch {
      return
    }
    if (this.dead) return
    if (receipt?.cancelled) {
      for (const id of receipt.cancelled) run.owned.delete(id)
      if (run.owned.size === 0 && !run.settled) this.finishCancelled(run)
      return
    }
    if (run.kind === 'prompt' && !run.started && !run.settled && run.owned.size > 0 && this.obligations.size === 0) this.close('closed')
  }

  private finishCancelled(run: LiveRun): void {
    if (run.settled) return
    this.remove(run)
    run.resolve({ result: null })
    this.afterRunEnded()
  }

  /** A Mousse run's consumption of its notifications committed: its obligations are done. */
  commit(owner: unknown): void {
    if (this.obligations.commit(owner)) this.backgroundChanged()
  }

  release(owner: unknown): void {
    this.obligations.release(owner)
  }

  /** The process is released or closed on purpose (Stop, idle, replacement): everything it owed ends with it. */
  close(reason: 'closed' | 'idle' | 'idle-cap' = 'closed'): void {
    if (this.dead) return
    this.shutdown(new Error('Claude Code session closed'), reason)
  }

  setPermissionMode(mode: Parameters<Query['setPermissionMode']>[0]): Promise<void> {
    return this.query ? this.query.setPermissionMode(mode) : Promise.resolve()
  }

  interrupt(): Promise<void> {
    return this.query ? Promise.resolve(this.query.interrupt()).then(() => undefined) : Promise.resolve()
  }

  // ---- stream ----

  private async pump(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.dead) return
        this.route(message)
      }
      this.shutdown(new Error('Claude Code ended before completing the turn'), 'died')
    } catch (error) {
      this.shutdown(error instanceof Error ? error : new Error(String(error)), 'died')
    }
  }

  private route(message: SDKMessage): void {
    this.touch()
    const sessionId = (message as { session_id?: unknown }).session_id
    if (typeof sessionId === 'string' && sessionId) this.sessionId = sessionId
    if (message.type === 'system') {
      this.routeSystem(message)
      return
    }
    if (message.type === 'result') {
      this.routeResult(message)
      return
    }
    if (message.type !== 'stream_event' && message.type !== 'assistant' && message.type !== 'user') return
    const echoed = echoedIds(message)
    const owner = echoed.length ? this.ownerOf(echoed) : undefined
    // A frame that names a message of ours belongs to its run, or to no one once that run is over.
    if (echoed.length && !owner) return
    if (owner) this.cursor = owner
    const target = owner ?? this.frameTarget()
    if (!target) return
    if (!target.started) {
      target.started = true
      if (target === this.continuation) this.clearWake()
    }
    // A turn nobody will read (its host could not run it) is stopped the moment it shows itself.
    if (target.abandoned && target.kind === 'continuation') this.interruptDiscarded(target)
    target.deliver(message)
  }

  /** Where a frame that echoes no id of ours goes. */
  private frameTarget(): LiveRun | undefined {
    if (this.cursor && !this.cursor.settled) return this.cursor
    this.cursor = undefined
    if (this.continuation && !this.continuation.settled) return (this.cursor = this.continuation)
    // Frames with no run waiting for them are dropped. A turn Claude starts itself opens a
    // continuation only at the task notification that precedes it: a stray frame, which no task
    // announced, would open one that nothing ends.
    return this.runs.find((run) => !run.abandoned && !run.settled)
  }

  private ownerOf(ids: readonly string[]): LiveRun | undefined {
    return this.runs.find((run) => ids.some((id) => run.ids.has(id)))
  }

  private routeSystem(message: SDKMessage & { type: 'system' }): void {
    const frame = message as unknown as Record<string, unknown>
    if (frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks)) {
      const tasks = (frame.tasks as unknown[]).filter(isRecord).filter((task) => typeof task.task_id === 'string') as Array<{
        task_id: string
        task_type?: string
        description?: string
        ambient?: boolean
      }>
      if (this.obligations.observeRoster(tasks)) this.backgroundChanged()
      return
    }
    if (frame.subtype === 'task_notification' && typeof frame.task_id === 'string') this.routeNotification(frame.task_id, typeof frame.summary === 'string' ? frame.summary : '')
  }

  /**
   * A task finished. One this process never listed (an opaque task, T3's rule) wakes nothing and
   * keeps nothing busy. Otherwise a turn that is already in flight consumes it; if none is, Claude is
   * about to start its own turn for it, which opens as a continuation at this report.
   */
  private routeNotification(taskId: string, summary: string): void {
    if (!this.obligations.has(taskId) || this.obligations.consumed(taskId)) return
    const owner = this.notificationOwner()
    if (owner) {
      this.obligations.consume(taskId, owner)
      return
    }
    this.startContinuation([taskId], summary ? [summary] : [])
  }

  /** The run a notification folds into: the frames in flight, a continuation, or the oldest waiting run. */
  private notificationOwner(): LiveRun | undefined {
    if (this.cursor && !this.cursor.settled && !this.cursor.abandoned) return this.cursor
    const continuation = this.openContinuation()
    if (continuation) return continuation
    return this.runs.find((run) => !run.abandoned && !run.settled)
  }

  private startContinuation(taskIds: string[], summaries: string[] = []): LiveRun {
    const open = this.openContinuation()
    if (open) return open
    const run = new LiveRun('continuation')
    this.continuation = run
    this.unclaimed.push(run)
    this.cursor = run
    this.clearIdle()
    this.armWake(run)
    // The tasks are the continuation's before the owner hears of it, so it can finish them at once.
    for (const id of taskIds) this.obligations.consume(id, run)
    this.hooks.continuationStarted(run, { taskIds: [...taskIds], summaries })
    return run
  }

  /**
   * A result belongs to the run that pushed a message it echoes. One that echoes ids but none of a
   * live run's (the run is over, or the id is unknown) belongs to no one: it is dropped, never given to
   * the run that happens to be waiting. Only a result that echoes nothing falls back to the origin and
   * then to the turn in flight.
   */
  private routeResult(message: SDKResultMessage): void {
    const echoed = echoedIds(message)
    let target: LiveRun | undefined
    if (echoed.length) {
      target = this.ownerOf(echoed)
      if (!target) return
      for (const id of echoed) target.owned.delete(id)
    } else if (isTaskOrigin(message)) {
      // A wake with no model turn ends here too (num_turns is 0). With no continuation open and a run
      // live, the result is dropped: that run consumed the notification.
      const continuation = this.openContinuation()
      if (continuation) this.settle(continuation, message)
      else if (this.continuation?.abandoned) this.finishCancelled(this.continuation)
      return
    } else {
      target = (this.cursor && !this.cursor.settled ? this.cursor : undefined) ?? this.runs.find((run) => !run.settled && !run.abandoned) ?? this.openContinuation()
    }
    if (!target) return
    if (target.abandoned) {
      // A cancelled turn still owns what it pushed until every message has had its result (or was
      // cancelled), so none of those results reaches another turn.
      if (target.owned.size === 0) this.finishCancelled(target)
      return
    }
    // The turn a steer interrupted ends at the steer's own result, not at the abort.
    if (isAbortResult(message) && target.steered) return void target.deliver(message)
    // A steer that has not been echoed yet starts a turn this run owns.
    const queued = (message as { queued_turn_count?: number }).queued_turn_count ?? 0
    if (target.owned.size > 0 && queued > 0) return void target.deliver(message)
    target.resultSeen = true
    // A steer still waiting for foreground work to move cannot be pushed any more; the run settles
    // when that steer has been turned away.
    if (target.steerInFlight > 0) {
      target.deferredResult = message
      return void target.deliver(message)
    }
    // A wake that folded this run's prompt in consumed the task notifications too, and the
    // continuation it opened for them has nothing left to say.
    const continuation = this.openContinuation()
    if (continuation && continuation !== target && echoed.length && isTaskOrigin(message)) {
      this.obligations.reassign(continuation, target)
      this.endContinuation(continuation, 'folded')
    }
    this.settle(target, message)
  }

  private settle(run: LiveRun, result: SDKResultMessage): void {
    if (run.settled) return
    run.deliver(result)
    this.remove(run)
    run.resolve({ result })
    this.afterRunEnded()
  }

  private endContinuation(run: LiveRun, reason: 'deadline' | 'folded'): void {
    if (run.settled) return
    this.remove(run)
    run.resolve({ result: null, reason })
    this.afterRunEnded()
  }

  /** The run no longer receives frames and no longer owns results. */
  private remove(run: LiveRun): void {
    const index = this.runs.indexOf(run)
    if (index >= 0) this.runs.splice(index, 1)
    if (run === this.continuation) {
      this.continuation = undefined
      this.clearWake()
    }
    if (this.cursor === run) this.cursor = undefined
  }

  /** Claude never started the turn a finished task promised: the wake ends with a note, not a result. */
  private armWake(run: LiveRun): void {
    this.clearWake()
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      if (this.continuation !== run || run.started || run.settled || this.dead) return
      this.endContinuation(run, 'deadline')
    }, this.timings.wakeDeadlineMs)
    this.wakeTimer.unref?.()
  }

  private clearWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
  }

  // ---- background work and idle ----

  /** The owner of the continuation's consumption reports it ended without a Mousse run to commit it. */
  private backgroundChanged(): void {
    const active = this.obligations.size > 0
    if (active !== this.reportedBackground) {
      this.reportedBackground = active
      this.hooks.backgroundWork(active)
    }
    if (!this.busy) this.armIdle()
  }

  private afterRunEnded(): void {
    if (!this.busy && !this.dead) this.armIdle()
  }

  /** Provider activity: the idle clock and the pin budget start over. */
  private touch(): void {
    this.lastUsed = Date.now()
    this.pinnedSince = undefined
    if (!this.busy) this.armIdle()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private armIdle(): void {
    if (this.dead) return
    this.clearIdle()
    const wait = this.obligations.size > 0 ? this.timings.idleReleaseMs : this.timings.idleCloseMs
    this.idleTimer = setTimeout(() => this.onIdle(), wait)
    this.idleTimer.unref?.()
  }

  private onIdle(): void {
    this.idleTimer = undefined
    if (this.dead || this.busy || this.reserved > 0) return
    if (this.obligations.size === 0) {
      this.close('idle')
      return
    }
    // Background work is pending: keep the process, up to the pin cap without any provider activity.
    const now = Date.now()
    this.pinnedSince ??= now
    if (now - this.pinnedSince < this.timings.maxPinMs) {
      this.armIdle()
      return
    }
    this.close('idle-cap')
  }

  // ---- end ----

  private shutdown(error: Error, reason: 'closed' | 'idle' | 'idle-cap' | 'died'): void {
    if (this.dead) return
    this.dead = true
    this.clearIdle()
    this.clearWake()
    this.queue.close()
    this.lifetime.abort()
    try {
      this.query?.close()
    } catch {
      // The process is going away either way.
    }
    for (const run of [...this.runs, ...(this.continuation ? [this.continuation] : [])]) if (!run.settled) run.reject(error)
    this.runs.length = 0
    this.continuation = undefined
    this.unclaimed.length = 0
    this.cursor = undefined
    // The obligations belonged to this process: they end with it, and the thread is evaluated again.
    const had = this.obligations.clear()
    if (had || this.reportedBackground) {
      this.reportedBackground = false
      this.hooks.backgroundWork(false)
    }
    this.hooks.ended(reason)
  }
}
