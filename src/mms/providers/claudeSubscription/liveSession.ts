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
/**
 * With background work pending: the longest it may stay owed. The count starts when work first became owed
 * and activity never moves it; at the cap the process is closed (ending every helper), waiting only for a
 * turn that is in flight.
 */
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
  /** How long one step of a cancel (an interrupt and its receipt) may take before the process is given up. */
  interruptTimeoutMs: number
  /** How long a "result may not have arrived" note waits, so a Stop that follows the cancel can drop it. */
  noticeDelayMs: number
}

export const DEFAULT_LIVE_TIMINGS: LiveTimings = {
  idleCloseMs: LIVE_IDLE_CLOSE_MS,
  idleReleaseMs: LIVE_IDLE_RELEASE_MS,
  maxPinMs: LIVE_MAX_PIN_MS,
  maxSessions: LIVE_MAX_SESSIONS,
  wakeDeadlineMs: WAKE_TURN_START_DEADLINE_MS,
  backgroundMoveMs: STEER_BACKGROUND_MOVE_MS,
  noticeDelayMs: 1_000,
  interruptTimeoutMs: 10_000
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
 * A turn that was cut off after Claude read a task's notification leaves the task in one of two
 * states, and no later turn ever commits it, since none of them saw the notification:
 * - `CARRIED`: a plain interrupt keeps the notification queued, so Claude starts a wake turn for it;
 *   that turn opens a continuation, which takes the task over.
 * - `LOST`: the cancel that went with the interrupt also dequeues notifications, so the task's result
 *   may never come. It stays an obligation until the idle caps end it.
 */
const CARRIED = Symbol('carried')
const LOST = Symbol('lost')
/**
 * A wake nobody could run (no host) was stopped: Claude read those tasks' reports, but no turn of Mousse
 * showed them to anyone. The next turn that begins afterwards and commits clears them, since Claude has
 * them in its context by then.
 */
const DISCARDED = Symbol('discarded')

/**
 * The background tasks of one Claude process that still owe the thread something (issue #142, plan
 * v8). Every task seen in the roster is an obligation. It ends only when a conversational run that
 * consumed the task's notification commits (`commit`), when the notification turns out to be opaque
 * (`discard`), or when the process ends or the idle cap expires (`clear`). An empty roster alone
 * clears nothing: the notification may still be on its way. The set belongs to one process.
 */
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

  /**
   * `owner` was cut off without committing, so what it consumed is committed by no turn (see
   * `CARRIED` and `LOST`). Returns the tasks that left.
   */
  release(owner: unknown, mode: 'carried' | 'lost' | 'discarded'): string[] {
    const state = mode === 'carried' ? CARRIED : mode === 'lost' ? LOST : DISCARDED
    const ids: string[] = []
    for (const [id, consumer] of this.consumers)
      if (consumer === owner) {
        this.consumers.set(id, state)
        ids.push(id)
      }
    return ids
  }

  /**
   * The cancel that went with an interrupt swept the whole queue, so every notification still queued for a
   * wake may be gone, not only those the cancelled run had read: every `CARRIED` task becomes `LOST`.
   */
  loseCarried(): number {
    let count = 0
    for (const [id, consumer] of this.consumers)
      if (consumer === CARRIED) {
        this.consumers.set(id, LOST)
        count++
      }
    return count
  }

  /** Tasks a discarded wake left (see `DISCARDED`). */
  discardedIds(): string[] {
    return [...this.consumers].filter(([, consumer]) => consumer === DISCARDED).map(([id]) => id)
  }

  /** A turn that began after `ids` were discarded and committed: Claude has read them, so they are done. */
  clearDiscarded(ids: readonly string[]): boolean {
    let changed = false
    for (const id of ids)
      if (this.consumers.get(id) === DISCARDED) {
        this.consumers.delete(id)
        changed = this.tasks.delete(id) || changed
      }
    return changed
  }

  /** Some task's result may never arrive. */
  hasLost(): boolean {
    for (const consumer of this.consumers.values()) if (consumer === LOST || consumer === DISCARDED) return true
    return false
  }

  /** A turn whose result came from the wake that folded its message in saw the notifications a cut-off turn left: they are its to commit. */
  adoptCarried(owner: unknown): void {
    this.reassign(CARRIED, owner)
  }

  /** The tasks a cut-off turn left for the wake turn Claude is expected to start. */
  carriedIds(): string[] {
    return [...this.consumers].filter(([, consumer]) => consumer === CARRIED).map(([id]) => id)
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
/** A step of a cancel did not answer within its bound. */
class CancelTimedOut extends Error {
  constructor() {
    super('The cancel did not answer in time')
  }
}

/** A push met a cancel in progress; the caller waits for `afterCancel()` and pushes again. */
export class CancelInProgress extends Error {
  constructor() {
    super('A cancel is in progress')
  }
}

export class LiveRun {
  /** Names this turn to the host that is asked to run it. */
  readonly id = randomUUID()
  /** Gates this turn's permission prompts, hooks and cancellation; the query itself never sees it. */
  readonly controller = new AbortController()
  /** Every message id this run pushed; a frame or result that echoes one belongs to the run. */
  readonly ids = new Set<string>()
  /** The ids a frame or result has already named: Claude has started those messages. */
  readonly seen = new Set<string>()
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
  /** What a discarded wake had left when this turn began; it clears them when it commits. */
  discardedAtStart: string[] = []
  /** The host could not run this wake and it was discarded; its frames still arrive until its result. */
  discarded = false
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
  continuationStarted(run: LiveRun, info: { id: string; taskIds: string[]; summaries: string[] }): void
  /** Something the thread's user should know about the process (a helper's result that may be lost). */
  notice?(text: string): void
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
  /** Cancel sequences under way (`interruptFor`); pushes wait for them. */
  private cancelling = 0
  private cancelWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  private readonly noticeTimers = new Set<ReturnType<typeof setTimeout>>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  /** When the process first had background work to wait for; the cap counts from here and activity does not move it. */
  private capTimer: ReturnType<typeof setTimeout> | undefined
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
    run.discardedAtStart = this.obligations.discardedIds()
    this.runs.push(run)
    this.clearIdle()
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
  claimContinuation(id?: string): LiveRun | undefined {
    if (id === undefined) return this.unclaimed.shift()
    const index = this.unclaimed.findIndex((run) => run.id === id)
    return index >= 0 ? this.unclaimed.splice(index, 1)[0] : undefined
  }

  /**
   * The turn Claude started on its own whose frames are in flight right now, if that is the turn it is
   * running: a Mousse tool call made now comes from it. When Claude runs a message of ours, nothing is
   * returned, whatever wakes wait to be run.
   */
  inFlightContinuation(): { id: string; discarded: boolean } | undefined {
    const run = this.cursor
    // A wake that was discarded but is not interrupted yet (another run is live) still runs tools.
    return run && run.kind === 'continuation' && !run.settled && (!run.abandoned || run.discarded) ? { id: run.id, discarded: run.discarded } : undefined
  }

  /** A turn Claude started on its own waits for a run (the one `id` names, when given). */
  hasUnclaimedContinuation(id?: string): boolean {
    return id === undefined ? this.unclaimed.length > 0 : this.unclaimed.some((run) => run.id === id)
  }

  /**
   * The host did not run the turn Claude started on its own, and a turn still in flight is interrupted,
   * since nobody would see it. Nothing it was to read is discharged: no one saw the report, so the tasks
   * (those it announced and any a cut-off turn had left it) stay owed under the idle caps, and the
   * thread is told. A discarded wake never commits anything.
   */
  discardContinuation(run: LiveRun): void {
    const index = this.unclaimed.indexOf(run)
    if (index >= 0) this.unclaimed.splice(index, 1)
    // The tasks are not shown to anyone, but Claude read them: the next turn that commits clears them.
    if (this.obligations.release(run, 'discarded').length > 0)
      this.hooks.notice?.('A background helper finished, but nothing could show its result. The next message clears it; Stop releases it now.')
    if (run.settled || run.abandoned) return
    run.discarded = true
    // The turn may not have begun yet (the notification comes first): it stays the frames' target, so
    // everything it says is dropped, and it is interrupted as soon as its first frame shows it started.
    run.abandoned = true
    run.consumer = undefined
    run.buffered.length = 0
    if (run.started) this.interruptDiscarded(run)
  }

  private interruptDiscarded(run: LiveRun): void {
    if (run.interruptSent || this.dead || !this.query) return
    // A message of ours may be folded into this turn; interrupting would abort it too. Its frames and
    // result are routed to it by id as soon as they name it.
    if (this.runs.some((other) => !other.abandoned && !other.settled)) return
    run.interruptSent = true
    void Promise.resolve(this.query.interrupt()).catch(() => undefined)
  }

  /** Resolves once no cancel sequence is under way; pushes (and steers) wait here instead of racing the cancel. */
  afterCancel(): Promise<void> {
    if (this.cancelling === 0) return Promise.resolve()
    return new Promise((resolve, reject) => this.cancelWaiters.push({ resolve, reject }))
  }

  private cancelFinished(): void {
    this.cancelling = Math.max(0, this.cancelling - 1)
    if (this.cancelling > 0) return
    const waiters = this.cancelWaiters
    this.cancelWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  /** Pushes a message a run owns. Returns the id it will be echoed under. */
  push(run: LiveRun, message: SDKUserMessage): string {
    const uuid = randomUUID()
    if (run.settled || this.dead) throw new Error('Claude Code ended before completing the turn')
    // While a cancel is under way every queued message is at risk: a push now could be swept up by it.
    // The caller retries once the cancel is over (`afterCancel`).
    if (this.cancelling > 0) throw new CancelInProgress()
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
      // A cancel under way could sweep the steer up; it waits, then looks again.
      for (;;) {
        await this.afterCancel()
        if (run.settled || run.resultSeen || run.abandoned || this.dead || this.query !== query) return false
        try {
          this.push(run, {
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            priority: 'now',
            session_id: this.sessionId ?? ''
          })
          break
        } catch (error) {
          if (!(error instanceof CancelInProgress)) throw error
        }
      }
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
    const unclaimed = this.unclaimed.indexOf(run)
    if (unclaimed >= 0) this.unclaimed.splice(unclaimed, 1)
    // What the run had read stays queued in Claude, which starts a wake turn for it (CARRIED), unless the
    // cancel below also drops it (LOST).
    this.obligations.release(run, 'carried')
    const query = this.query
    // A turn that pushed nothing has nothing in flight; one that did, or a wake, is interrupted. An
    // interrupt of an idle query is harmless, and one that fails leaves the next turn to find out.
    if (query && !this.dead && (run.ids.size > 0 || run.kind === 'continuation')) void this.interruptFor(run, query)
    // A run that was never answered keeps owning its ids until each has its result or was cancelled; a
    // wake that owns a steer keeps its place among the runs for that, whatever started it.
    if (run.owned.size === 0) this.finishCancelled(run)
    else if (run === this.continuation) {
      this.continuation = undefined
      this.clearWake()
      if (!this.runs.includes(run)) this.runs.push(run)
    }
  }

  /**
   * Interrupts the turn, with a plain interrupt first: it keeps queued task notifications, so the wake
   * turns they cause still happen. Its receipt names the messages that will still run
   * (`still_queued`); only when one of them is a message this run pushed (a prompt or steer Claude has
   * not started, which would otherwise run later with nobody owning it) is a second interrupt sent that
   * cancels the queue. That cancel also drops notifications, so the tasks the run had read become
   * `LOST` and the thread is told. What the receipt names as cancelled is released; what is left stays
   * owned by the cancelled run, so its result is not given to anyone else. A Claude Code that sends no
   * receipt cannot cancel a prompt it never started; only closing the process drops it, which is not done
   * while the process has background work (the prompt then runs and its result is dropped).
   */
  private async interruptFor(run: LiveRun, query: Query): Promise<void> {
    this.cancelling++
    try {
      await this.interruptSequence(run, query)
    } finally {
      this.cancelFinished()
    }
  }

  private async interruptSequence(run: LiveRun, query: Query): Promise<void> {
    type Receipt = { still_queued?: string[]; cancelled?: string[] } | undefined
    const target = query as { interrupt(options?: { cancelQueued?: boolean }): Promise<Receipt> }
    let receipt: Receipt
    try {
      receipt = (await this.bounded(target.interrupt())) ?? undefined
    } catch (error) {
      if (error instanceof CancelTimedOut) this.giveUpCancel()
      return
    }
    if (this.dead) return
    if (!receipt) {
      if (run.kind === 'prompt' && !run.started && !run.settled && run.owned.size > 0 && this.obligations.size === 0) this.close('closed')
      return
    }
    const queued = (receipt.still_queued ?? []).filter((id) => run.owned.has(id))
    if (queued.length === 0) return
    let cancelled: Receipt
    try {
      cancelled = (await this.bounded(target.interrupt({ cancelQueued: true }))) ?? undefined
    } catch (error) {
      if (error instanceof CancelTimedOut) this.giveUpCancel()
      return
    }
    if (this.dead) return
    if (this.obligations.loseCarried() > 0)
      this.noticeLater('A background helper finished while a message was being cancelled, and its result may not have been delivered. The thread stays waiting until the four-hour limit; Stop releases it now.')
    // Every cancelled id is reconciled against the run that owns it: the cancel swept the whole queue.
    for (const id of cancelled?.cancelled ?? []) this.cancelId(id)
    if (run.owned.size === 0 && !run.settled) this.finishCancelled(run)
  }

  /** One step of a cancel, held to `interruptTimeoutMs`: the SDK's control requests have no deadline of their own. */
  private bounded<T>(step: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CancelTimedOut()), this.timings.interruptTimeoutMs)
      timer.unref?.()
    })
    return Promise.race([step, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  /**
   * Claude did not answer the cancel in time, so what is queued in it is unknown: the process is not
   * reused. It is closed, which ends its helpers, and every run and push that waited on the cancel fails
   * with a message that says so; the next turn starts a fresh process.
   */
  private giveUpCancel(): void {
    // Said now, not later: closing the process clears the delayed notes, and no caller may be left to see the error.
    if (this.obligations.size > 0)
      this.hooks.notice?.('Claude did not answer a cancel in time, so its process was closed and the background helpers it was running ended.')
    this.close('closed', new Error('Claude Code did not answer a cancel in time, so its process was closed (its background helpers ended with it). Send the message again.'))
  }

  /**
   * Claude cancelled the queued message `id`: its owner will never get a result for it. A cancelled run is
   * finished; a live run whose only outstanding message it was fails clearly instead of waiting for ever.
   */
  private cancelId(id: string): void {
    const owner = this.ownerOf([id])
    if (!owner) return
    owner.owned.delete(id)
    if (owner.abandoned) {
      if (owner.owned.size === 0) this.finishCancelled(owner)
      return
    }
    // A wake owns only the steers it received: a sweep that took them does not end the wake, which Claude
    // is still running and which ends at its own result.
    if (owner.kind === 'prompt' && owner.owned.size === 0 && owner.steerInFlight === 0 && !owner.settled)
      this.failCancelled(owner, new Error('Claude Code cancelled the message before it started; send it again'))
  }

  private failCancelled(run: LiveRun, error: Error): void {
    this.remove(run)
    run.reject(error)
    this.afterRunEnded()
  }

  /**
   * The note waits a moment: a Stop closes the process right after the cancel it causes, and a helper
   * that Stop ended has no result to miss. If the process is gone by then, nothing is said.
   */
  private noticeLater(text: string): void {
    const timer = setTimeout(() => {
      this.noticeTimers.delete(timer)
      if (!this.dead) this.hooks.notice?.(text)
    }, this.timings.noticeDelayMs)
    timer.unref?.()
    this.noticeTimers.add(timer)
  }

  private finishCancelled(run: LiveRun): void {
    if (run.settled) return
    this.remove(run)
    run.resolve({ result: null })
    this.afterRunEnded()
  }

  /** A Mousse run's consumption of its notifications committed: its obligations are done. */
  commit(owner: unknown): void {
    let changed = this.obligations.commit(owner)
    if (owner instanceof LiveRun && owner.discardedAtStart.length > 0) {
      changed = this.obligations.clearDiscarded(owner.discardedAtStart) || changed
      owner.discardedAtStart = []
    }
    if (changed) this.backgroundChanged()
  }

  /** The process is released or closed on purpose (Stop, idle, replacement): everything it owed ends with it. */
  close(reason: 'closed' | 'idle' | 'idle-cap' = 'closed', error?: Error): void {
    if (this.dead) return
    this.shutdown(error ?? new Error('Claude Code session closed'), reason)
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
    if (owner) {
      this.cursor = owner
      for (const id of echoed) if (owner.ids.has(id)) owner.seen.add(id)
    }
    const target = owner ?? this.frameTarget(message)
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
  private frameTarget(message: SDKMessage): LiveRun | undefined {
    if (this.cursor && !this.cursor.settled) return this.cursor
    this.cursor = undefined
    if (this.continuation && !this.continuation.settled) return (this.cursor = this.continuation)
    // A turn cut off after Claude read a task's notification leaves Claude a wake turn to run for it, and
    // that turn must not run unseen: its first root frame opens the continuation, ahead of any waiting
    // run (a typed prompt's own first frame names it, so a waiting run only gets what names no one).
    // A stray frame with nothing carried opens nothing: no task announced it, and nothing would end it.
    const carried = this.obligations.carriedIds()
    const root = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id == null && message.type !== 'user'
    if (carried.length > 0 && root) return (this.cursor = this.startContinuation(carried))
    return this.runs.find((run) => !run.abandoned && !run.settled)
  }

  private ownerOf(ids: readonly string[]): LiveRun | undefined {
    const candidates = this.continuation ? [...this.runs, this.continuation] : this.runs
    return candidates.find((run) => ids.some((id) => run.ids.has(id)))
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
    this.hooks.continuationStarted(run, { id: run.id, taskIds: [...taskIds], summaries })
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
      // The same guards apply to it as to any turn, so a steered wake ignores an abort result too.
      target = this.openContinuation()
      if (!target) {
        if (this.continuation?.abandoned) this.finishCancelled(this.continuation)
        return
      }
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
    // A wake that folded this run's prompt in consumed the task notifications too, and the
    // continuation it opened for them has nothing left to say. This run read the notifications a
    // cut-off turn had left, so it commits those as well. This is done when the result arrives, so a
    // result held back for a steer (below) has already done it.
    if (echoed.length && isTaskOrigin(message)) this.foldWake(target)
    // A steer still waiting for foreground work to move cannot be pushed any more; the run settles
    // when that steer has been turned away.
    if (target.steerInFlight > 0) {
      target.deferredResult = message
      return void target.deliver(message)
    }
    this.settle(target, message)
  }

  /** `target`'s result came from a wake turn: it read what that wake read, and the wake's own run is over. */
  private foldWake(target: LiveRun): void {
    this.obligations.adoptCarried(target)
    const continuation = this.continuation
    if (!continuation || continuation === target) return
    if (continuation.abandoned) this.finishCancelled(continuation)
    else {
      this.obligations.reassign(continuation, target)
      this.endContinuation(continuation, 'folded')
    }
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
    // A wake that folded a message of ours in has no turn of its own to run: no run may claim it. One that
    // never started keeps its place, so the run that was opened for it ends with the note.
    if (reason === 'folded') {
      const unclaimed = this.unclaimed.indexOf(run)
      if (unclaimed >= 0) this.unclaimed.splice(unclaimed, 1)
    }
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
    if (active && !this.capTimer) {
      this.capTimer = setTimeout(() => this.onCap(), this.timings.maxPinMs)
      this.capTimer.unref?.()
    } else if (!active && this.capTimer) {
      clearTimeout(this.capTimer)
      this.capTimer = undefined
    }
    if (!this.busy) this.armIdle()
  }

  private afterRunEnded(): void {
    if (!this.busy && !this.dead) this.armIdle()
  }

  /** Provider activity restarts the idle clock. It does not move the cap on how long work may stay owed. */
  private touch(): void {
    this.lastUsed = Date.now()
    if (!this.busy) this.armIdle()
  }

  /** The longest background work may stay owed has passed, however active the process was: it is released. */
  private onCap(): void {
    this.capTimer = undefined
    if (this.dead || this.obligations.size === 0) return
    // A turn in flight is not cut off for it; the check comes again soon.
    if (this.busy || this.reserved > 0) {
      this.capTimer = setTimeout(() => this.onCap(), Math.min(60_000, this.timings.maxPinMs))
      this.capTimer.unref?.()
      return
    }
    this.close('idle-cap')
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
    // Background work is pending: the process stays; the cap on how long it may stay owed is `onCap`.
    this.armIdle()
  }

  // ---- end ----

  private shutdown(error: Error, reason: 'closed' | 'idle' | 'idle-cap' | 'died'): void {
    if (this.dead) return
    this.dead = true
    this.clearIdle()
    this.clearWake()
    if (this.capTimer) clearTimeout(this.capTimer)
    this.capTimer = undefined
    for (const timer of this.noticeTimers) clearTimeout(timer)
    this.noticeTimers.clear()
    // Pushes waiting on a cancel are released with the error: nothing will answer it now.
    const waiters = this.cancelWaiters
    this.cancelWaiters = []
    this.cancelling = 0
    for (const waiter of waiters) waiter.reject(error)
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
