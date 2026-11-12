import { randomUUID } from 'node:crypto'
import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { observeRateLimit, RejectedWindows } from './usageLimit'
import type { SpawnedRoot } from '../../stopProcesses'

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
/** How long a task the next turn cleared on a guess (its wake never came) is remembered, in case the wake still comes. */
export const UNSURE_MEMORY_MS = 10 * 60_000
/** A steer waits at most this long for foreground subagents to move to the background. */
export const STEER_BACKGROUND_MOVE_MS = 5_000
/**
 * A steer still unread at its turn's result that Claude Code says a turn took (it could not drop it): how long the run
 * waits for that turn to show itself before it ends with the result it had (`LiveSession.endAtResult`).
 */
export const LATE_STEER_READ_MS = 2_000
/**
 * A late steer handed back after `LATE_STEER_READ_MS` with no read signal: how long a stand-in still owns its id, so a
 * turn Claude Code may run for it after all is dropped, not given to another run (`LiveSession.endTaken`).
 */
export const LATE_STEER_STAND_IN_MS = 10 * 60_000

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
  /** See `LATE_STEER_READ_MS`. */
  lateSteerReadMs: number
  /** See `LATE_STEER_STAND_IN_MS`. */
  lateSteerStandInMs: number
}

export const DEFAULT_LIVE_TIMINGS: LiveTimings = {
  idleCloseMs: LIVE_IDLE_CLOSE_MS,
  idleReleaseMs: LIVE_IDLE_RELEASE_MS,
  maxPinMs: LIVE_MAX_PIN_MS,
  maxSessions: LIVE_MAX_SESSIONS,
  wakeDeadlineMs: WAKE_TURN_START_DEADLINE_MS,
  backgroundMoveMs: STEER_BACKGROUND_MOVE_MS,
  noticeDelayMs: 1_000,
  interruptTimeoutMs: 10_000,
  lateSteerReadMs: LATE_STEER_READ_MS,
  lateSteerStandInMs: LATE_STEER_STAND_IN_MS
}

/** A query's Claude Code as the SDK reported it at spawn: its pid and when Mousse heard of it (`noteClaudeQuerySpawn`). */
const SPAWNED = new WeakMap<object, () => { pid: number; spawnedAt: number } | undefined>()

/** Records where the spawn of `query`'s Claude Code is read from once it has started. */
export function noteClaudeQuerySpawn(query: object, spawned: () => { pid: number; spawnedAt: number } | undefined): void {
  SPAWNED.set(query, spawned)
}

/** A Claude Code process a query runs: its pid, and what Mousse knows of it for a delayed kill. */
export interface ClaudeProcess {
  pid: number
  root: SpawnedRoot
  /** Sends SIGTERM through Mousse's handle; false when it could not be sent. Absent without a handle that can signal. */
  terminate?: () => boolean
}

/** The SDK's process of a query (a `ChildProcess`, or the SDK's wrapper of one, which has no pid). */
type SdkProcess = { pid?: unknown; exitCode?: number | null; signalCode?: string | null; kill?: (signal?: NodeJS.Signals) => boolean }

const validPid = (pid: unknown): number | undefined => (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined)

/**
 * The Claude Code process a query runs, or undefined. The Agent SDK does not publish it. The pid is read from the
 * query's process transport (`transport.process.pid`), or, in SDKs that wrap the process without its pid, from what the
 * SDK reported when it started it (`noteClaudeQuerySpawn`, which also anchors when it was started). Whether it exited,
 * and its kill, come from that same process object (Mousse's handle). Without a pid, Stop has the SDK's own close only.
 */
export function claudeQueryProcess(query: unknown): ClaudeProcess | undefined {
  const handle = (query as { transport?: { process?: SdkProcess } } | undefined)?.transport?.process
  const noted = query && typeof query === 'object' ? SPAWNED.get(query)?.() : undefined
  const pid = validPid(handle?.pid) ?? validPid(noted?.pid)
  if (pid === undefined) return undefined
  const knowsExit = handle !== undefined && 'exitCode' in handle && 'signalCode' in handle
  return {
    pid,
    ...(typeof handle?.kill === 'function' ? { terminate: () => { try { handle.kill!('SIGTERM'); return true } catch { return false } } } : {}),
    root: {
      ...(noted?.pid === pid ? { spawnedAt: noted.spawnedAt } : {}),
      exited: () => (knowsExit ? handle!.exitCode !== null || handle!.signalCode !== null : undefined),
      ...(typeof handle?.kill === 'function' ? { kill: () => { try { handle.kill!('SIGKILL') } catch { /* gone meanwhile */ } } } : {})
    }
  }
}

/** The pid of the Claude Code process a query runs, or undefined (`claudeQueryProcess`). */
export function claudeQueryPid(query: unknown): number | undefined {
  return claudeQueryProcess(query)?.pid
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
  /**
   * `CARRIED` tasks whose wake may never come: a cut-off wake was assigned them, and Claude may have handed
   * the notification to a turn that was still running. They stay carried (a wake that comes opens a
   * continuation) but, like `DISCARDED` ones, the next turn that begins afterwards and commits clears them.
   */
  private readonly unsure = new Set<string>()
  /**
   * What the notifications of listed tasks said: kept while the task is consumed, carried or remembered in
   * `recent`, and handed out once to the wake that opens for it. `commit`, `discard` and the expiry of `recent`
   * end it with the task.
   */
  private readonly summaries = new Map<string, string>()
  /**
   * `unsure` tasks the next committed turn cleared, with the time their memory ends. Claude's wake for one
   * may still come after that clear (it was only a guess that it would not), and it opens a continuation
   * rather than being dropped.
   */
  private readonly recent = new Map<string, number>()

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

  /**
   * The notification of `taskId` is being consumed by `owner`; the obligation stays until `commit(owner)`.
   * Its summary is kept only for a listed task, so one that has no obligation (a task a guess already
   * cleared, or one never listed) leaves nothing behind that no `commit` could remove.
   */
  consume(taskId: string, owner: unknown, summary = ''): void {
    if (this.tasks.has(taskId)) {
      this.consumers.set(taskId, owner)
      if (summary) this.summaries.set(taskId, summary)
    }
    this.unsure.delete(taskId)
  }

  /**
   * The task finished while a wake that was cut off still owed its result: Claude starts its own turn for it
   * later, so it is `CARRIED`, and `unsure` since that turn may never come.
   */
  carry(taskId: string, summary = ''): void {
    if (!this.tasks.has(taskId)) return
    this.consumers.set(taskId, CARRIED)
    this.unsure.add(taskId)
    if (summary) this.summaries.set(taskId, summary)
  }

  /**
   * What the notification of `id` said, for the wake that opens for it; handed out once. A wake that
   * consumes a listed task again stores it again (`consume`), so it is kept while that wake owns the task.
   */
  takeSummary(id: string): string | undefined {
    const summary = this.summaries.get(id)
    this.summaries.delete(id)
    return summary
  }

  /** Tasks an `unsure` clear took, still remembered, oldest first: the wake Claude owed for one of them may yet come. */
  recentlyCleared(): string[] {
    const now = Date.now()
    for (const [id, until] of this.recent)
      if (until <= now) {
        this.recent.delete(id)
        this.summaries.delete(id)
      }
    return [...this.recent.keys()]
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.recent.delete(id)
  }

  consumed(taskId: string): boolean {
    return this.consumers.has(taskId)
  }

  /** What `from` consumed now belongs to `to` (a wake that folded a Mousse prompt in). */
  reassign(from: unknown, to: unknown): string[] {
    const moved: string[] = []
    for (const [id, consumer] of this.consumers)
      if (consumer === from) {
        this.consumers.set(id, to)
        this.unsure.delete(id)
        moved.push(id)
      }
    return moved
  }

  /** `owner` committed: the tasks it consumed are done. Returns whether the set changed. */
  commit(owner: unknown): boolean {
    let changed = false
    for (const [id, consumer] of this.consumers) {
      if (consumer !== owner) continue
      this.consumers.delete(id)
      this.unsure.delete(id)
      this.summaries.delete(id)
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
   * A wake that had started was cut off: the tasks it was opened for (`own`) were read by it and are
   * `DISCARDED`; any other task it was assigned is still queued in Claude and `CARRIED`, though its wake
   * may never come (see `unsure`).
   */
  releaseWake(owner: unknown, own: ReadonlySet<string>): void {
    for (const [id, consumer] of this.consumers)
      if (consumer === owner) {
        this.consumers.set(id, own.has(id) ? DISCARDED : CARRIED)
        if (!own.has(id)) this.unsure.add(id)
      }
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

  /** Tasks a discarded wake left (see `DISCARDED`), and carried ones whose wake may never come (see `unsure`). */
  discardedIds(): string[] {
    return [...this.consumers].filter(([id, consumer]) => this.clearable(id, consumer)).map(([id]) => id)
  }

  private clearable(id: string, consumer: unknown): boolean {
    return consumer === DISCARDED || (consumer === CARRIED && this.unsure.has(id))
  }

  /** A turn that began after `ids` were discarded and committed: Claude has read them, so they are done. */
  clearDiscarded(ids: readonly string[]): boolean {
    let changed = false
    for (const id of ids)
      if (this.clearable(id, this.consumers.get(id))) {
        // Only a remembered task keeps its summary: its wake may still come and is labelled with it.
        if (this.consumers.get(id) === CARRIED) this.recent.set(id, Date.now() + UNSURE_MEMORY_MS)
        else this.summaries.delete(id)
        this.consumers.delete(id)
        this.unsure.delete(id)
        changed = this.tasks.delete(id) || changed
      }
    return changed
  }

  /** How many tasks' results may never arrive (a cancel may have dropped their notifications). */
  lostCount(): number {
    let count = 0
    for (const consumer of this.consumers.values()) if (consumer === LOST) count++
    return count
  }

  /** How many tasks Claude read but no turn showed (a wake that was cut off or could not be run): see `DISCARDED`. */
  unshownCount(): number {
    let count = 0
    for (const consumer of this.consumers.values()) if (consumer === DISCARDED) count++
    return count
  }

  /** A turn whose result came from the wake that folded its message in saw the notifications a cut-off turn left: they are its to commit. */
  adoptCarried(owner: unknown): string[] {
    return this.reassign(CARRIED, owner)
  }

  /** The tasks a cut-off turn left for the wake turn Claude is expected to start. */
  carriedIds(): string[] {
    return [...this.consumers].filter(([, consumer]) => consumer === CARRIED).map(([id]) => id)
  }

  discard(taskId: string): boolean {
    this.consumers.delete(taskId)
    this.unsure.delete(taskId)
    this.summaries.delete(taskId)
    return this.tasks.delete(taskId)
  }

  clear(): boolean {
    const had = this.tasks.size > 0
    this.tasks.clear()
    this.consumers.clear()
    this.unsure.clear()
    this.summaries.clear()
    this.recent.clear()
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

/** How a steer is delivered (`LiveSession.steer`). */
export interface SteerOptions {
  /** Send now: pushed at once with no background move, and the foreground tools are stopped. */
  forced?: boolean
  /**
   * The turn's own subagent calls still in the foreground that Claude Code runs as a task (`task_started`): each is
   * moved to the background before the push. A subagent call with no task yet is not moved: Claude Code drops a call
   * whose input still streams when an immediate message arrives (spike S1).
   */
  subagents?: readonly string[]
  /** A subagent that was moved: it is not moved again for a later steer. */
  moved?: (callId: string) => void
  /** A subagent that could not be moved: the steer is not pushed, and waits for it. */
  notMovable?: (callId: string) => void
  /** The check at dispatch, right before the push; false: the steer is not pushed. */
  mayCut?: () => boolean
  /** Send now: the calls to stop, with the task each runs as when Claude Code reported one. */
  foreground?: () => ReadonlyArray<{ callId: string; taskId?: string; toolName?: string }>
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
  /**
   * Pushed ids Claude Code has taken: its `command_lifecycle` frame said `started` (or `completed`), or a frame or result
   * named the id. Kept after the run is cancelled, since a Stop's interrupt can race a read. Taken is not answered:
   * `started` comes about 200 ms before the request that carries the message goes out (`answered`).
   */
  readonly read = new Set<string>()
  /**
   * Pushed ids the model answered: model output that names the id (a streamed event, or a message that is not one
   * Claude Code made up itself), a `completed` lifecycle, or a successful result that names it. Only these are reads
   * when a Stop, an interrupt, a close or the process's death ends the run; a message only taken (`read`) is handed
   * back then, because the request that would carry it may never have gone out (#928).
   */
  readonly answered = new Set<string>()
  /**
   * Pushed ids Claude Code took for its next request (`started`) that the model has not answered yet. The run's next
   * main-turn model frame answers them (`LiveSession.answerTaken`): Claude Code names a message only when a turn's
   * `user_message_uuid` changes, so a steer folded into a turn the person started is never named by a reply frame.
   */
  readonly awaitingAnswer = new Set<string>()
  /** Pushed ids Claude Code dropped unread (a cancel took them from its queue): it will never run them. */
  readonly dropped = new Set<string>()
  /**
   * Pushed ids still queued in Claude Code after a cancel it did not confirm, on a process background work keeps: it
   * may still run them, though the run was cancelled (and a steer among them was handed back).
   */
  readonly mayRunTwice = new Set<string>()
  /**
   * Pushed ids still unread at the run's result that Claude Code could not drop from its queue (`cancelAsyncMessage`
   * said false), though nothing named them yet. False alone is not a read: Claude Code also answers it for a message
   * its queue gave up a moment before, whose turn then drops it unrun (`LiveSession.endAtResult`). A held run waits for
   * a read signal (`read`); with none, however the run ends (the wait runs out, a Stop, a closed or dead process), they
   * are handed back (`LiveSession.endTaken`, `unreadFate`).
   */
  readonly taken = new Set<string>()
  /**
   * For a stand-in (`LiveSession.endTaken`): the steers it owns were handed back to Mousse with no read signal, and
   * `handedBackBy` is the run that pushed them. Claude Code reading one later means it may run twice.
   */
  handedBackBy: LiveRun | undefined
  /** Ends a stand-in that never heard of its steers again (`LATE_STEER_STAND_IN_MS`). */
  standInTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The run's result arrived while a steer it pushed was still unread (issue #919): Claude Code may take that steer
   * right after and answer it as a turn of its own. The run stays open meanwhile (`LiveSession.endAtResult`) and
   * ends with this result if the steer does not run; once Claude Code reads it, the run goes on to the steer's result.
   * A held run takes only the frames that name its messages.
   */
  atResult: SDKResultMessage | undefined
  /** The steers that were unread at `atResult`, while the run waits to learn whether Claude Code runs them. */
  readonly lateSteers = new Set<string>()
  /** Ends a held run whose late steer Claude Code did not drop but never showed it read (`LATE_STEER_READ_MS`). */
  lateTimer: ReturnType<typeof setTimeout> | undefined
  /** Claude Code is being asked to drop the late steers (`LiveSession.askLateSteers`); `unreadFate` waits for its answer. */
  lateAsk: Promise<void> | undefined
  /** Told, at once, the first time the model answers a pushed id of this run (`answered`). Must not throw. */
  onRead: ((id: string) => void) | undefined
  /** The ids of the steers this run pushed (`LiveSession.steer`). */
  readonly steerIds = new Set<string>()
  /**
   * Steers whose Send now interrupted the turn (`LiveSession.stopForeground`). If Claude Code had already taken one for
   * its next request when the interrupt landed, the aborted result that follows is that steer's own request, not the
   * command's: the run ends there instead of waiting for a result that never comes. The steer is read if the model
   * answered it before the abort, and handed back once if not. Only the first aborted result after the interrupt can be
   * that request's: it clears the set, so a later steer's cut in the same turn is waited past as usual.
   */
  readonly interruptedFor = new Set<string>()
  /**
   * The aborted result the run ended at because Send now's interrupt cut the steer's own request (`interruptedFor`).
   * The person asked for that interrupt, so the turn did not fail: the provider ends it with what the model wrote.
   */
  sendNowAbort: SDKResultMessage | undefined
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
  /** The plan windows Claude Code rejected while this turn was open. */
  readonly rateLimits = new RejectedWindows()
  /** For a wake: the tasks it was opened for, the ones whose notifications it reads. */
  readonly wakeTaskIds = new Set<string>()
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
  continuationStarted(run: LiveRun, info: { id: string; taskIds: string[]; summaries: string[]; tasks: Array<{ taskId: string; description?: string }> }): void
  /**
   * A task Claude started from a tool call (a background agent or shell) reported its end. Sent for every
   * such report, also one whose call's turn has settled: the owner updates that call's row.
   */
  taskEnded?(info: { toolUseId: string; taskId: string; status: string; summary?: string; durationMs?: number }): void
  /** Something the thread's user should know about the process (a helper's result that may be lost). */
  notice?(text: string): void
  /** The process ended or was released. */
  ended(reason: 'closed' | 'idle' | 'idle-cap' | 'died'): void
  /**
   * The session sent the process SIGTERM itself (`terminate`): the owner kills it with everything it started if it is
   * still running after the grace, as after Stop.
   */
  reap?(target: ClaudeProcess): void
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * What Claude Code says about a pushed message (`command_lifecycle`, an internal frame of the stream): `queued` when it
 * enters the command queue, `started` when it drains into a turn (taken for the next request, not yet answered), then one of `completed`,
 * `cancelled`, `discarded` or `refused`.
 */
function lifecycleOf(message: SDKMessage): { id: string; state: string } | undefined {
  const frame = message as { type?: unknown; command_uuid?: unknown; state?: unknown }
  if (frame.type !== 'command_lifecycle' || typeof frame.command_uuid !== 'string' || typeof frame.state !== 'string') return undefined
  return { id: frame.command_uuid, state: frame.state }
}

/**
 * A frame the model wrote: a streamed event, or a message that is not one Claude Code made up itself (`<synthetic>`,
 * such as an API error or "No response requested."). One that names a pushed message shows the model answered it.
 */
function modelOutput(message: SDKMessage): boolean {
  if (message.type === 'stream_event') return true
  if (message.type !== 'assistant') return false
  return (message as { message?: { model?: unknown } }).message?.model !== '<synthetic>'
}

/**
 * Model output of the main turn: not a background agent's (`parent_tool_use_id`), and not a keep-alive `ping`. Claude
 * Code says `started` for a message after the tool round that took it has ended, just before the request that carries
 * it (or as a new turn starts), so the first such frame after `started` is the model answering that request.
 */
function mainTurnModelOutput(message: SDKMessage): boolean {
  if (!modelOutput(message)) return false
  if ((message as { parent_tool_use_id?: unknown }).parent_tool_use_id != null) return false
  if (message.type !== 'stream_event') return true
  const event = (message as { event?: { type?: unknown } }).event
  return event?.type !== 'ping'
}

function echoedIds(message: SDKMessage): string[] {
  const frame = message as { user_message_uuid?: unknown; user_message_uuids?: unknown }
  if (Array.isArray(frame.user_message_uuids)) return frame.user_message_uuids.filter((id): id is string => typeof id === 'string')
  return typeof frame.user_message_uuid === 'string' ? [frame.user_message_uuid] : []
}

/** Tools an immediate message ends by itself (spike S1: WebFetch is cancelled, WebSearch returns empty): Send now needs no interrupt for them. */
const PUSH_ENDS_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch'])

const isTaskOrigin = (message: SDKMessage): boolean => {
  const origin = (message as { origin?: unknown }).origin
  return isRecord(origin) && origin.kind === 'task-notification'
}

/** The run takes frames that name no message: it is live, and not held at its result for a late steer. */
const takesFrames = (run: LiveRun): boolean => !run.settled && !run.abandoned && run.atResult === undefined

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
 * - A run ends at the result that echoes its ids, never at a result of someone else's turn. When one
 *   result names the ids of several runs (Claude read their messages together), the newest live run
 *   takes it and the cancelled ones are finished.
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
  /**
   * The turn in flight answers a message no run owns any more (its first frame named it, and its run is over): what it
   * says until its result names nothing and is no run's, so it is dropped. Cleared at the next result, or when a frame
   * names a message a run owns.
   */
  private strayTurn = false
  /**
   * The newest notification for a task this process never listed that no live turn folded in. Claude may
   * start a wake for it, so the next late root frame is labelled with it rather than with a remembered task.
   * The label is a guess; the frame opens a continuation either way.
   */
  private stray: { id: string; summary: string; until: number } | undefined
  /** Turns about to use the session (see `reserve`). */
  private reserved = 0
  /** Cancel sequences under way (`interruptFor`); pushes wait for them. */
  private cancelling = 0
  /**
   * Whether this Claude Code honors an interrupt's `cancel_queued` (`interrupt_cancel_queued_v1` in the capabilities its
   * `system/init` frame lists). Unknown until an init frame lists capabilities; the interrupt's receipt then decides.
   */
  private cancelQueuedSupported: boolean | undefined
  /** The next close ends the process with SIGTERM rather than by closing its input (`terminate`). */
  private abrupt = false
  /** The session signalled its process and handed it to `hooks.reap`; the owner does not reap it again. */
  reaped = false
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

  /** The pid of the Claude Code process behind the query, while it is known (`claudeQueryPid`). */
  processId(): number | undefined {
    return this.query ? claudeQueryPid(this.query) : undefined
  }

  /** The Claude Code process behind the query, while it is known (`claudeQueryProcess`). */
  process(): ClaudeProcess | undefined {
    return this.query ? claudeQueryProcess(this.query) : undefined
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
    // A wake held at its result for a late steer is not in flight: what Claude Code says next is not its own.
    return this.continuation && takesFrames(this.continuation) ? this.continuation : undefined
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
   * Delivers a steer to the live turn (docs/design/steer-and-interruptions.md §2.4): the text is pushed as an immediate
   * user message the run owns. Returns the pushed message's id, or false when it was not pushed (the run ended first,
   * or the steer must wait): the caller hands it back.
   *
   * - A steer the orchestrator released (no foreground tool): each foreground subagent `options.subagents` names is
   *   moved to the background first, by its own id (a steer aborts the stream, which would end it). Only that subagent
   *   moves: the call with no id also moves a running command, which then never ends for the person (#874). A subagent
   *   that cannot be moved (the call throws, answers false or does not answer in time) is reported
   *   (`options.notMovable`) and the steer is not pushed: it waits for that subagent. Right before the push,
   *   `options.mayCut` is asked again; a tool that started meanwhile keeps the steer waiting.
   * - `options.forced` (Send now): pushed at once, with no move; then the foreground tools are stopped, since an
   *   immediate message waits for a running command on Claude Code (spike S1). Each is stopped as its task
   *   (`stopTask`) when Claude Code reported one for every call (`task_started`, about 3 s after a command starts);
   *   otherwise the turn is interrupted, which ends the command and leaves the pushed steer queued, so it runs once.
   *   With no call left to stop (the command ended as the click came), the push alone is the cut.
   * - A subagent call Claude Code has not started a task for yet is not moved (`options.subagents` leaves it out): the
   *   push alone drops a call whose input still streams (spike S1).
   *
   * Pushed is not read, and taken (`run.read`, a `started` lifecycle) is not read either: `run.answered` and `onRead`
   * say when the model answers it, and `unreadFate` what became of one it had not answered when the turn ended.
   * `pushed` is told the id at the moment of the push, before anything else can run.
   */
  async steer(run: LiveRun, text: string, pushed?: (id: string) => void, options: SteerOptions = {}): Promise<string | false> {
    const query = this.query
    if (!query || run.settled || run.abandoned || this.dead) return false
    run.steerInFlight++
    try {
      if (!options.forced) {
        for (const callId of options.subagents ?? []) {
          if (await this.moveToBackground(query, callId)) {
            options.moved?.(callId)
            continue
          }
          options.notMovable?.(callId)
          return false
        }
      }
      // The turn's result may have arrived while the foreground work moved; settling waited for this
      // steer, but a steer never starts a turn the run no longer owns: it is the next queued turn.
      // A cancel under way could sweep the steer up; it waits, then looks again.
      let id: string
      for (;;) {
        await this.afterCancel()
        if (run.settled || run.resultSeen || run.abandoned || this.dead || this.query !== query) return false
        // The check at dispatch: nothing may run between it and the push.
        if (!options.forced && options.mayCut && !options.mayCut()) return false
        try {
          id = this.push(run, {
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
      run.steerIds.add(id)
      pushed?.(id)
      if (options.forced) this.stopForeground(run, query, id, options.foreground?.() ?? [])
      return id
    } finally {
      run.steerInFlight--
      const deferred = run.deferredResult
      if (deferred && run.steerInFlight === 0 && !run.settled && !run.abandoned) {
        run.deferredResult = undefined
        // Delivered when it arrived.
        this.endAtResult(run, deferred, true)
      }
    }
  }

  /** Moves the foreground subagent `callId` to the background. False: it could not be moved (it stays in the foreground). */
  private async moveToBackground(query: Query, callId: string): Promise<boolean> {
    const move = (query as { backgroundTasks?: (toolUseId?: string) => Promise<boolean> }).backgroundTasks
    if (typeof move !== 'function') return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Background tasks turned off for the session throw at once (spike S1).
      return await Promise.race([
        Promise.resolve(move.call(query, callId)).then((moved) => moved === true, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.timings.backgroundMoveMs)
        })
      ])
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Send now, after the steer `id` is pushed: ends the tools the turn waits for. Each by its task when Claude Code named
   * one for every call; otherwise one interrupt, which ends the command and keeps the pushed steer queued (spike S1).
   * Not awaited: the steer is already in place.
   * - No call left to stop (the command ended on its own meanwhile): nothing more. The push alone cuts the next
   *   request, and an interrupt would also stop the turn's background agents and shells.
   * - Never an interrupt once Claude Code took the steer (`run.read`, a `started` lifecycle): it would end the steer's
   *   own request, whose aborted result the run waits past (a steered run ends at the steer's own result), so the run
   *   would never end.
   */
  private stopForeground(run: LiveRun, query: Query, id: string, calls: ReadonlyArray<{ callId: string; taskId?: string; toolName?: string }>): void {
    // WebFetch and WebSearch end at the push itself (spike S1): an interrupt would only stop background work too.
    const stoppable = calls.filter((call) => !call.toolName || !PUSH_ENDS_TOOLS.has(call.toolName))
    if (stoppable.length === 0) return
    const stopTask = (query as { stopTask?: (taskId: string) => Promise<void> }).stopTask
    // At most one interrupt, whichever task stops failed.
    let interrupted = false
    const interrupt = (): void => {
      if (interrupted || run.read.has(id) || run.settled || run.abandoned || this.dead || this.query !== query) return
      interrupted = true
      // An earlier Send now's interrupt is still landing: it ends the command, and this steer goes in with that one. A
      // second interrupt could abort the request that carries both, after the command's aborted result had cleared them.
      const landing = run.interruptedFor.size > 0
      run.interruptedFor.add(id)
      if (landing) return
      void Promise.resolve(query.interrupt()).catch(() => undefined)
    }
    if (typeof stopTask === 'function' && stoppable.every((call) => call.taskId)) {
      for (const call of stoppable) void Promise.resolve(stopTask.call(query, call.taskId!)).catch(interrupt)
      return
    }
    interrupt()
  }

  /**
   * The turn was cancelled but the query stays open: the turn is interrupted, and the run keeps
   * owning its ids as a tombstone so the result the interrupt produces is not given to anyone else.
   * What the interrupt ends depends on the task: Claude stops background agents (each reports `stopped`,
   * see `routeNotification`), but shells keep running and stay owed; only closing the process (Stop, the
   * idle caps) ends them.
   */
  abandon(run: LiveRun): void {
    if (run.settled || run.abandoned) return
    run.abandoned = true
    run.buffered.length = 0
    run.consumer = undefined
    // A run held at its result for a late steer is cancelled like any other: the steer, unread, is swept below.
    this.releaseHold(run)
    const unclaimed = this.unclaimed.indexOf(run)
    if (unclaimed >= 0) this.unclaimed.splice(unclaimed, 1)
    // What a turn had read stays queued in Claude, which starts a wake turn for it (CARRIED), unless the
    // cancel below also drops it (LOST). A wake that had started already read the notifications it was
    // opened for: no second wake follows for those, so they are cleared by the next turn that commits
    // (DISCARDED). A task that finished while the wake ran is only assigned to it and was not read yet:
    // Claude still starts a wake for it, so it stays carried.
    if (run.kind === 'continuation' && run.started) this.obligations.releaseWake(run, run.wakeTaskIds)
    else this.obligations.release(run, 'carried')
    const query = this.query
    // A turn that pushed nothing has nothing in flight; one that did, or a wake, is interrupted. An
    // interrupt of an idle query is harmless, and one that fails leaves the next turn to find out.
    // A turn whose result already arrived (held back for a steer) is over: an interrupt now would hit whatever
    // Claude runs next, such as the wake for a task that just finished.
    const over = run.resultSeen && run.owned.size === 0
    if (query && !this.dead && !over && (run.ids.size > 0 || run.kind === 'continuation')) {
      // The interrupt is sent: a frame of the wake that arrives later must not send another.
      if (run.kind === 'continuation') run.interruptSent = true
      // A steer Claude Code has not read is handed back to Mousse when the turn ends: Claude Code must not run it too.
      // A plain interrupt leaves it queued, and Claude Code starts it at once as a new turn (spike S1), before a second
      // cancel could land, so the queue is swept in the same round trip.
      // A steer Claude Code took for its next request but the model has not answered counts as unread: the sweep also
      // cancels one taken for a request not yet sent (it then says `cancelled`).
      const unreadSteer = [...run.steerIds].some((id) => run.owned.has(id) && !run.answered.has(id))
      void this.interruptFor(run, query, unreadSteer)
    }
    // A run that was never answered keeps owning its ids until each has its result or was cancelled; a
    // wake that owns a steer keeps its place among the runs for that, whatever started it.
    if (run.owned.size === 0) {
      // A wake that began stays the cursor and the continuation until its own result arrives (like a
      // cut-off prompt it owes that result): the frames it already wrote are dropped, and the wake Claude
      // may owe for a task it had not read opens only after this one is over (`routeResult`).
      // One whose result already arrived (held back for a steer) has nothing left to wait for.
      if (run.kind === 'continuation' && run.started && !run.resultSeen && run === this.continuation) this.clearWake()
      else this.finishCancelled(run)
    } else if (run === this.continuation) {
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
   *
   * The cancel counts as done only when its receipt has a `cancelled` list. A Claude Code that predates
   * `interrupt_cancel_queued_v1` ignores the request and answers like a plain interrupt (`still_queued`, no
   * `cancelled`): nothing was dropped, so no task is lost and nobody is told, and the queued messages still run. As
   * with no receipt, the process is then closed, which drops them (a resumed session does not run a message that was
   * queued when its process ended, spike S1); background work keeps it, and then they may run twice
   * (`LiveRun.mayRunTwice`, and a warning).
   *
   * `sweep`: the run owns a steer Claude Code has not read, which is handed back to Mousse. The queue is cancelled in
   * the interrupt itself, with no plain interrupt first, so Claude Code cannot start the steer in between. A Claude Code
   * whose init said it cannot cancel the queue is ended at once when nothing keeps it, not interrupted first: after an
   * interrupt the steer starts at once as a new turn (spike S1), and its tools would run before the close. It is sent
   * SIGTERM, also when a Stop closes it first: a closed input alone leaves it running for seconds (the SDK signals it
   * only after a delay), so the running turn and its tools would go on, and a turn that ends meanwhile would start the
   * steer. Its tree is killed after the grace, as after Stop (`hooks.reap`).
   */
  private async interruptFor(run: LiveRun, query: Query, sweep = false): Promise<void> {
    this.cancelling++
    try {
      await this.interruptSequence(run, query, sweep)
    } finally {
      this.cancelFinished()
    }
  }

  private async interruptSequence(run: LiveRun, query: Query, sweep: boolean): Promise<void> {
    type Receipt = { still_queued?: string[]; cancelled?: string[] } | undefined
    const target = query as { interrupt(options?: { cancelQueued?: boolean }): Promise<Receipt> }
    if (sweep && this.cancelQueuedSupported === false && this.obligations.size === 0) {
      // Set inside `abandon`, so a Stop that closes the process before the step below also ends it with SIGTERM.
      this.abrupt = true
      // After `abandon` has returned, not inside it. Nothing is sent to Claude Code meanwhile.
      await Promise.resolve()
      if (this.dead) return
      if (this.obligations.size === 0) {
        this.close('closed')
        return
      }
      this.abrupt = false
    }
    if (!sweep) {
      let receipt: Receipt
      try {
        receipt = (await this.bounded(target.interrupt())) ?? undefined
      } catch (error) {
        if (error instanceof CancelTimedOut) this.giveUpCancel()
        return
      }
      if (this.dead) return
      if (!receipt) {
        if (run.kind === 'prompt' && !run.started && !run.settled && run.owned.size > 0 && this.obligations.size === 0) {
          // Ended with SIGTERM: a closed input alone would leave it running for seconds, and the prompt could start.
          this.abrupt = true
          this.close('closed')
        }
        return
      }
      const queued = (receipt.still_queued ?? []).filter((id) => run.owned.has(id))
      if (queued.length === 0) return
    }
    let cancelled: Receipt
    try {
      cancelled = (await this.bounded(target.interrupt({ cancelQueued: true }))) ?? undefined
    } catch (error) {
      if (error instanceof CancelTimedOut) this.giveUpCancel()
      return
    }
    if (this.dead) return
    if (this.cancelQueuedSupported === false || !Array.isArray(cancelled?.cancelled)) {
      // The cancel was ignored, or not confirmed: no receipt, or one with no `cancelled` list (a Claude Code that
      // predates the queue cancel answers it like a plain interrupt). What the run pushed and Claude Code has not read
      // is still queued and would run unseen, beside a steer handed back. Closing the process drops it (a resumed
      // session does not run a message that was queued when its process ended, spike S1).
      if (this.obligations.size === 0) {
        // Ended with SIGTERM: a closed input alone would leave it running for seconds, long enough to start what is queued.
        this.abrupt = true
        this.close('closed')
        return
      }
      this.cancelUnconfirmed(run, cancelled?.still_queued)
      return
    }
    // The cancel was honored, so it swept the whole queue, task notifications included.
    if (this.obligations.loseCarried() > 0)
      this.noticeLater('A background helper finished while a message was being cancelled, and its result may not have been delivered. The thread stays waiting until the four-hour limit; Stop releases it now.')
    // Every cancelled id is reconciled against the run that owns it: the cancel swept the whole queue.
    for (const id of cancelled.cancelled) this.cancelId(id)
    if (run.owned.size === 0 && !run.settled) this.finishCancelled(run)
  }

  /**
   * Claude Code did not confirm the cancel of `run`'s queue, and background work keeps its process: what the run pushed
   * and Claude Code has not read (of what the receipt lists as `stillQueued`, when it has one) may still run there,
   * though the run was cancelled and a steer among it was handed back. The run keeps owning it, so its result reaches
   * nobody; it is marked and a warning says so. Ids and counts only.
   */
  private cancelUnconfirmed(run: LiveRun, stillQueued: readonly string[] | undefined): void {
    const listed = Array.isArray(stillQueued) ? new Set(stillQueued) : undefined
    const atRisk = [...run.owned].filter((id) => !run.answered.has(id) && !run.dropped.has(id) && (!listed || listed.has(id)))
    if (atRisk.length === 0) return
    for (const id of atRisk) run.mayRunTwice.add(id)
    const steers = atRisk.filter((id) => run.steerIds.has(id))
    console.warn('[claude-live] Claude Code did not confirm it cancelled queued messages, and background work keeps its process: they may run twice', {
      threadId: this.threadId,
      runId: run.id,
      messageIds: atRisk,
      messages: atRisk.length,
      steers: steers.length
    })
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
    // Also one Claude Code had taken for a request it had not sent yet: the cancel took it back unanswered.
    if (!owner.answered.has(id)) owner.dropped.add(id)
    owner.awaitingAnswer.delete(id)
    owner.owned.delete(id)
    if (owner.abandoned) {
      if (owner.owned.size === 0) this.finishCancelled(owner)
      return
    }
    // A run held at its result for this steer has its answer: with no late steer left to run, it ends with that result.
    if (owner.atResult) {
      owner.lateSteers.delete(id)
      if (owner.lateSteers.size === 0) this.endHeld(owner)
      return
    }
    // A wake owns only the steers it received: a sweep that took them does not end the wake, which Claude
    // is still running and which ends at its own result.
    if (owner.kind === 'prompt' && owner.owned.size === 0 && owner.steerInFlight === 0 && !owner.settled)
      this.failCancelled(owner, new Error('Claude Code cancelled the message before it started; send it again'))
  }

  /**
   * What became of `id`, a message `run` pushed that the model had not answered when the run ended:
   * - `read`: the model answered it after all (a Stop's interrupt can race the answer): model output that named it, a
   *   `completed` lifecycle, or a successful result that named it. A message Claude Code only took for its next request
   *   (`started`) is read only when the turn ended `normally` (with its result, not cancelled): that request goes out.
   *   After a Stop, an interrupt, a close or the process's death it may never have, so it is not a read then (#928).
   *   Nothing else counts as a read;
   * - `dropped`: Claude Code removed it from its queue unread (a cancel's receipt, `cancelAsyncMessage` here, or a
   *   `cancelled` lifecycle), so it never runs there; or `cancelAsyncMessage` could not drop it (false, `taken`) and
   *   nothing showed it read, however the run ended (the wait ran out, `endTaken`; a Stop; a fresh ask here), so it is
   *   handed back, at least once (`handBackTaken`);
   * - `gone`: the process ended (Stop closes it). A Claude Code killed with a message still queued does not run it
   *   when the session is resumed (spike S1), and neither does a turn that took it: that turn ends with the process;
   * - `cut`: the run was cancelled, and its interrupt sweeps Claude Code's queue (`abandon`), or closes the process when
   *   Claude Code does not confirm the sweep. Not waited for, so a Stop ends the turn at once;
   * - `unknown`: Claude Code could not say (no per-message cancel, or the cancel failed or was ignored on a process that
   *   stays). It may still run it.
   *
   * Only a run that ended with its result asks Claude Code (`cancelAsyncMessage`, which drops a message still queued
   * and leaves one a turn already took). Never throws.
   */
  async unreadFate(run: LiveRun, id: string, normally = false): Promise<'read' | 'dropped' | 'gone' | 'cut' | 'unknown'> {
    // Only a read signal is a read. `taken` (`cancelAsyncMessage` said false) only says no queue held it when Claude Code
    // was asked: it may have dropped it, and says so only when its next turn commits.
    const known = (): 'read' | 'dropped' | undefined =>
      run.answered.has(id) ? 'read' : run.dropped.has(id) ? 'dropped' : run.read.has(id) && normally && !run.abandoned ? 'read' : undefined
    if (known()) return known()!
    // Claude Code is still answering whether it could drop the steer (a Stop came during the ask): wait for its answer.
    if (run.lateAsk) await run.lateAsk
    if (known()) return known()!
    const query = this.query
    // Before `taken`: a turn that took it ended with the process.
    if (this.dead || !query) return 'gone'
    // Not dropped, and nothing showed it read: handed back, as at the end of the wait (`endTaken`).
    if (run.taken.has(id)) return this.handBackTaken(run, id)
    // A cancel already known to have been ignored on a process that stays leaves it queued there (`mayRunTwice`).
    if (run.abandoned) return run.mayRunTwice.has(id) ? 'unknown' : 'cut'
    const cancel = (query as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage
    if (typeof cancel !== 'function') return 'unknown'
    let removed: boolean
    try {
      removed = (await this.bounded(Promise.resolve(cancel.call(query, id)))) === true
    } catch (error) {
      // What Claude Code has queued is unknown: as for a cancel that does not answer, the process is not kept.
      if (error instanceof CancelTimedOut) {
        this.giveUpCancel()
        return known() ?? 'gone'
      }
      return known() ?? (this.dead ? 'gone' : 'unknown')
    }
    if (known()) return known()!
    if (removed) {
      // Removed unread: the run that pushed it no longer waits for its result.
      run.dropped.add(id)
      this.cancelId(id)
      return 'dropped'
    }
    // No longer in the queue, which is not a read: Claude Code may have dropped it. Handed back, as above.
    run.taken.add(id)
    return this.handBackTaken(run, id)
  }

  /**
   * `id`, a steer `run` pushed, was not dropped by `cancelAsyncMessage` (false) and nothing showed it read, and the run
   * ended some way other than the end of its wait (`endTaken`): a Stop or a failure, or a fresh ask (`unreadFate`). It is
   * handed back to Mousse the same way, at least once, never lost. A turn Claude Code may still run for it is owned by a
   * stand-in until its result (or the stand-in's cutoff), so it reaches no other run, and a read then means it may run
   * twice (`readAfterHandBack`). A cancelled run gives the steer up to the stand-in, and ends if it owed nothing else.
   * A warning says it was handed back (ids only).
   */
  private handBackTaken(run: LiveRun, id: string): 'dropped' {
    run.taken.delete(id)
    run.dropped.add(id)
    console.warn('[claude-live] Claude Code did not drop a steer, and nothing showed it read it; it is handed back', {
      threadId: this.threadId,
      runId: run.id,
      messageIds: [id]
    })
    if (this.dead || !run.owned.has(id)) return 'dropped'
    run.owned.delete(id)
    const index = this.runs.indexOf(run)
    if (run.abandoned && !run.settled && run.owned.size === 0) this.finishCancelled(run)
    // Right after the run while it stays among the runs, so a frame that names the steer finds the stand-in (`ownerOf`).
    this.standIn(run, [id], index >= 0 && this.runs.includes(run) ? index + 1 : index)
    return 'dropped'
  }

  /**
   * Claude Code's `command_lifecycle` said `cancelled` for `id`: it dropped the message unrun. Taken from the frame only
   * for a late steer whose `cancelAsyncMessage` answered false (a held run's, or a stand-in's): Claude Code answers false
   * when its queue gave the steer up a moment before the cancel came, and then drops it as the turn starts, with this
   * frame. The steer is handed back, at once rather than after the wait. Other cancels are settled by their receipts.
   */
  private lateSteerCancelled(id: string): void {
    const owner = this.ownerOf([id])
    if (!owner || owner.answered.has(id) || !owner.owned.has(id)) return
    if (!owner.lateSteers.has(id) && !owner.taken.has(id) && !owner.handedBackBy) return
    this.cancelId(id)
  }

  /**
   * Claude Code read `id` after all, a steer handed back to Mousse with no read signal (`endTaken`), which Mousse runs
   * again as a turn of its own: it may run twice. The read turn is not stopped: an interrupt could land on the turn after
   * it, and Mousse may already have sent the steer again behind it. Its frames and result go to the stand-in, which drops
   * them, so it is never shown and never reaches another run; Mousse's model context keeps the steer once, with the
   * answer of the turn Mousse ran. It is marked (`mayRunTwice`) and a warning says so. Ids only.
   */
  private readAfterHandBack(standIn: LiveRun, id: string): void {
    const pusher = standIn.handedBackBy
    standIn.mayRunTwice.add(id)
    pusher?.mayRunTwice.add(id)
    console.warn('[claude-live] Claude Code read a steer after it was handed back with no read signal; it may run twice', {
      threadId: this.threadId,
      ...(pusher ? { runId: pusher.id } : {}),
      messageIds: [id]
    })
  }

  /**
   * What Claude Code said about `ids` of the runs that pushed them. Each signal marks them taken (`read`):
   * - `started`: Claude Code took them for its next request, which has not gone out yet. The run's next main-turn model
   *   frame answers them (`awaitingAnswer`, `answerTaken`);
   * - `answered`: the model answered them (`LiveRun.answered`, which alone tells `onRead`);
   * - `named`: a frame or result named them that says nothing of the model (a tool result, a message Claude Code made
   *   up, an error result: an interrupted turn's names the message that started it, though the model may never have
   *   had it).
   * Only `started` and `answered` show that Claude Code runs a steer it had handed back (`readAfterHandBack`).
   */
  private markRead(ids: readonly string[], signal: 'started' | 'answered' | 'named'): void {
    for (const run of this.ownersOf(ids)) {
      for (const id of ids) {
        if (!run.ids.has(id)) continue
        const taken = !run.read.has(id)
        if (taken) run.read.add(id)
        if (signal !== 'named' && run.handedBackBy && !run.mayRunTwice.has(id)) this.readAfterHandBack(run, id)
        if (signal === 'started' && !run.answered.has(id)) run.awaitingAnswer.add(id)
        if (signal === 'answered') this.answer(run, id)
        // A steer that was unread at the run's result runs now, as a turn of its own: the run goes on to its result.
        if (taken && run.lateSteers.has(id) && !run.settled && !run.abandoned) this.resume(run)
      }
    }
  }

  /** The model answered `id`, a message `run` pushed: told once (`onRead`). */
  private answer(run: LiveRun, id: string): void {
    run.awaitingAnswer.delete(id)
    if (run.answered.has(id)) return
    run.answered.add(id)
    try {
      run.onRead?.(id)
    } catch (error) {
      console.warn('[claude-live] a read message could not be reported', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * `message`, a main-turn model frame, reached `run`: the model answers what Claude Code took for this request. A steer
   * folded into a turn keeps the turn's `user_message_uuid`, so no reply frame names it; this frame is its answer. No
   * frame of the request before can follow `started` (`mainTurnModelOutput`).
   */
  private answerTaken(run: LiveRun, message: SDKMessage): void {
    if (run.awaitingAnswer.size === 0 || !mainTurnModelOutput(message)) return
    for (const id of [...run.awaitingAnswer]) this.answer(run, id)
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
  /**
   * Switches the running process's model and effort (issue #359). Rejects when there is no process to switch, so the
   * owner starts a new one rather than believe the switch was made.
   */
  applyFlagSettings(settings: Parameters<Query['applyFlagSettings']>[0]): Promise<void> {
    if (!this.query || typeof this.query.applyFlagSettings !== 'function') return Promise.reject(new Error('This Claude Code cannot switch settings in place'))
    return this.query.applyFlagSettings(settings)
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
    if (message.type === 'rate_limit_event') {
      // The event names no message of ours: it is the open turn's, and dropped when none is open.
      const open = this.openRun()
      if (open) observeRateLimit(message, open.rateLimits)
      return
    }
    const lifecycle = lifecycleOf(message)
    if (lifecycle) {
      // `started`: Claude Code took the message for its next request, which has not gone out yet; `completed`: answered.
      // Only the read is taken from this frame.
      if (lifecycle.state === 'started' || lifecycle.state === 'completed')
        this.markRead([lifecycle.id], lifecycle.state === 'completed' ? 'answered' : 'started')
      else if (lifecycle.state === 'cancelled') this.lateSteerCancelled(lifecycle.id)
      return
    }
    if (message.type !== 'stream_event' && message.type !== 'assistant' && message.type !== 'user') return
    const echoed = echoedIds(message)
    const owner = echoed.length ? this.ownerOf(echoed) : undefined
    // A frame that names a message of ours belongs to its run, or to no one once that run is over. Then so does the rest
    // of that turn: the frames after it name nothing, and they are dropped up to the turn's result, never given to
    // whatever run is live (`strayTurn`).
    if (echoed.length && !owner) {
      this.strayTurn = true
      return
    }
    // Read before the frame reaches its run, so a steer is in place before what the model says after it.
    if (echoed.length) this.markRead(echoed, modelOutput(message) ? 'answered' : 'named')
    if (owner) {
      this.strayTurn = false
      this.passOver(owner, echoed)
      this.cursor = owner
      for (const id of echoed) if (owner.ids.has(id)) owner.seen.add(id)
    }
    const target = owner ?? this.frameTarget(message)
    if (!target) return
    // Before the frame reaches its run too: a steer folded into this turn is answered by it, though it does not name it.
    this.answerTaken(target, message)
    // A turn Claude started on its own begins at its first root frame: a background agent's frames (they
    // name a parent tool call) and tool results say nothing about whether the wake began.
    const root = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id == null && message.type !== 'user'
    if (!target.started && (root || target.kind !== 'continuation')) {
      target.started = true
      if (target === this.continuation) this.clearWake()
    }
    // A turn nobody will read (its host could not run it) is stopped the moment it shows itself.
    // A frame that does not begin the turn (a background agent's) does not stop a wake that has not begun:
    // that would stop the agents with it.
    if (target.abandoned && target.kind === 'continuation' && target.started) this.interruptDiscarded(target)
    observeRateLimit(message, target.rateLimits)
    target.deliver(message)
  }

  /** The run whose turn is open on this session: the one the frames are in, or the only live run. */
  private openRun(): LiveRun | undefined {
    if (this.strayTurn) return undefined
    if (this.cursor && takesFrames(this.cursor)) return this.cursor
    const open = [...this.runs, ...(this.continuation && !this.runs.includes(this.continuation) ? [this.continuation] : [])].filter(takesFrames)
    return open.length === 1 ? open[0] : undefined
  }

  /** Where a frame that echoes no id of ours goes. */
  private frameTarget(message: SDKMessage): LiveRun | undefined {
    // The turn in flight is one no run owns (`strayTurn`).
    if (this.strayTurn) return undefined
    // A run held at its result is not the turn in flight: its late steer's turn begins with a frame that names it.
    if (this.cursor && !this.cursor.settled && !this.cursor.atResult) return this.cursor
    this.cursor = undefined
    // A cancelled wake stays the target, so what it still says is dropped; a held one is not (as above).
    if (this.continuation && !this.continuation.settled && !this.continuation.atResult) return (this.cursor = this.continuation)
    // A turn cut off after Claude read a task's notification leaves Claude a wake turn to run for it, and
    // that turn must not run unseen: its first root frame opens the continuation, ahead of any waiting
    // run (a typed prompt's own first frame names it, so a waiting run only gets what names no one).
    // A stray frame with nothing carried opens nothing: no task announced it, and nothing would end it.
    const carried = this.obligations.carriedIds()
    const root = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id == null && message.type !== 'user'
    // Until a cut-off turn's result arrives, what Claude writes without naming a message is that turn's
    // leftover: it opens no wake.
    const old = this.owingResult()
    if (carried.length > 0 && root && !old)
      return (this.cursor = this.startContinuation(carried.map((id) => ({ id, summary: this.obligations.takeSummary(id) }))))
    // The wake for a task the last committed turn cleared on a guess may still come: with no turn of ours
    // in flight, no wake and no cut-off turn owing a result, a root frame is that wake. Only the label is
    // a guess; the frame is never dropped.
    if (root && !old && this.runs.every((run) => run.atResult !== undefined)) {
      // A notification for a task that was never listed is the freshest evidence of a wake: it labels this
      // one, and the remembered tasks stay for the wake after it.
      const stray = this.stray
      if (stray && Date.now() < stray.until) {
        this.stray = undefined
        // A repeat notification for a remembered task is that task's wake: forget it, so it opens one wake.
        this.obligations.forget([stray.id])
        this.obligations.takeSummary(stray.id)
        return (this.cursor = this.startContinuation([{ id: stray.id, summary: stray.summary }]))
      }
      // One remembered task per late wake, the oldest first (an assumption: Claude starts one wake per
      // queued notification). A leftover id stays remembered until `UNSURE_MEMORY_MS`; a stray root frame
      // in that window opens a continuation that ends at that turn's result (`armWake` only ends a wake
      // that never started).
      const [first] = this.obligations.recentlyCleared()
      if (first !== undefined) {
        const summary = this.obligations.takeSummary(first)
        this.obligations.forget([first])
        return (this.cursor = this.startContinuation([{ id: first, summary }]))
      }
    }
    const live = this.runs.find(takesFrames)
    return live ?? (old ? (this.cursor = old) : undefined)
  }

  /**
   * A turn that was cut off and still owes its result, so the frames Claude writes for it until then are
   * its leftovers: the abandoned continuation (a wake nobody ran, or one that began), a wake that owns an
   * unanswered steer, or a prompt Claude had started. Its result is not the result of any later turn, and
   * it stops being owed once a later turn names its own message (`passOver`).
   */
  private owingResult(): LiveRun | undefined {
    const candidates = this.continuation ? [this.continuation, ...this.runs] : this.runs
    return candidates.find(
      (run) =>
        run.abandoned &&
        !run.settled &&
        !run.resultSeen &&
        (run === this.continuation || (run.kind === 'continuation' ? run.started : run.seen.size > 0 && run.owned.size > 0))
    )
  }

  /**
   * A frame or result that names `owner`'s message shows Claude has moved on to that message. It answers
   * messages in order, so a cut-off prompt that is older than `owner`, started, and not named by this frame
   * will never get its result: it stops owing it and is finished. A newer run's frame passes an older
   * one over, never the other way (`ownerOf` can return an older cut-off run as a fallback). Wakes are
   * left to `foldWake` and `routeResult`. The open continuation, which is not in `runs`, ranks newest.
   */
  private passOver(owner: LiveRun, echoed: readonly string[]): void {
    const inRuns = this.runs.indexOf(owner)
    const ownerIndex = inRuns >= 0 ? inRuns : Infinity
    // Finishing a run removes it from `runs`: decide first, on a copy.
    const passed = this.runs.filter(
      (run, index) =>
        run !== owner &&
        index < ownerIndex &&
        run.kind === 'prompt' &&
        run.abandoned &&
        !run.settled &&
        !run.resultSeen &&
        run.seen.size > 0 &&
        run.owned.size > 0 &&
        !echoed.some((id) => run.ids.has(id))
    )
    for (const run of passed) this.finishCancelled(run)
  }

  /** Every run that pushed one of `ids`, oldest first. The open continuation is never in `runs` and always comes last, so it ranks newest. */
  private ownersOf(ids: readonly string[]): LiveRun[] {
    const candidates = this.continuation && !this.runs.includes(this.continuation) ? [...this.runs, this.continuation] : this.runs
    return candidates.filter((run) => ids.some((id) => run.ids.has(id)))
  }

  /**
   * The run a frame or result that echoes `ids` belongs to. Claude may read several queued messages
   * together and name all of them: the newest live run then is the one that waits for the answer, and a
   * cancelled run that owned an older one only owes it.
   */
  private ownerOf(ids: readonly string[]): LiveRun | undefined {
    const owners = this.ownersOf(ids)
    return [...owners].reverse().find((run) => !run.abandoned && !run.settled) ?? owners[owners.length - 1]
  }

  private routeSystem(message: SDKMessage & { type: 'system' }): void {
    const frame = message as unknown as Record<string, unknown>
    if (frame.subtype === 'init' && Array.isArray(frame.capabilities)) this.cancelQueuedSupported = frame.capabilities.includes('interrupt_cancel_queued_v1')
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
    if (frame.subtype === 'task_notification' && typeof frame.task_id === 'string') {
      if (typeof frame.tool_use_id === 'string') this.reportTaskEnd(frame.tool_use_id, frame.task_id, frame)
      this.routeNotification(frame.task_id, typeof frame.summary === 'string' ? frame.summary : '', typeof frame.status === 'string' ? frame.status : '')
    }
    // A task's start and end name the call that spawned it: the run that owns the frames shows them on its row.
    // With no owner the frame is dropped (the call's row was closed when its turn settled).
    if ((frame.subtype === 'task_started' || frame.subtype === 'task_notification') && typeof frame.tool_use_id === 'string')
      this.notificationOwner()?.deliver(message)
    // The process being ready (its first frame) is the open turn's, and so is a retry of a failed request, unless
    // background agents run: a retry names no agent, and it may be theirs.
    if (frame.subtype === 'init' || (frame.subtype === 'api_retry' && this.obligations.size === 0)) this.openRun()?.deliver(message)
  }

  /** Tells the owner a tool call's task ended, so a row its settled turn closed as "in the background" learns the outcome. */
  private reportTaskEnd(toolUseId: string, taskId: string, frame: Record<string, unknown>): void {
    if (!this.hooks.taskEnded) return
    const usage = isRecord(frame.usage) ? frame.usage : undefined
    const durationMs = typeof usage?.duration_ms === 'number' && Number.isFinite(usage.duration_ms) ? usage.duration_ms : undefined
    const summary = typeof frame.summary === 'string' && frame.summary.trim() ? frame.summary : undefined
    try {
      this.hooks.taskEnded({
        toolUseId,
        taskId,
        status: typeof frame.status === 'string' ? frame.status : '',
        ...(summary ? { summary } : {}),
        ...(durationMs !== undefined ? { durationMs } : {})
      })
    } catch (error) {
      console.warn('[claude-live] task end could not be reported', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * A task finished. One this process never listed (an opaque task) keeps nothing busy and
   * opens no continuation now. When no live turn folds it in, Claude may start a wake for it: the next
   * late root frame within `wakeDeadlineMs` opens a visible continuation labelled with it (`stray`), also
   * when nothing is remembered. A task that was stopped (an interrupt stops background agents) is reported
   * without a turn following: it is not owed any more, and no continuation opens for it. Otherwise a
   * turn that is already in flight consumes it; if none is, Claude is about to start its own turn for
   * it, which opens as a continuation at this report.
   */
  private routeNotification(taskId: string, summary: string, status: string): void {
    if (!this.obligations.has(taskId)) {
      // A stopped task wakes nothing, and a live turn folds the notification in, so no wake follows it.
      if (status !== 'stopped' && !this.notificationOwner()) this.stray = { id: taskId, summary, until: Date.now() + this.timings.wakeDeadlineMs }
      return
    }
    if (status === 'stopped') {
      this.obligations.discard(taskId)
      this.backgroundChanged()
      return
    }
    if (this.obligations.consumed(taskId)) return
    const owner = this.notificationOwner()
    if (owner) {
      this.obligations.consume(taskId, owner, summary)
      return
    }
    // A turn that was cut off (or a wake nobody could run) still owes its aborted result, and everything
    // Claude writes until then is its own. Its result must not settle the wake this task needs, so that wake
    // is not opened now: the task is owed, and Claude's next turn for it opens the continuation once the old one is over.
    if (this.owingResult()) {
      this.obligations.carry(taskId, summary)
      return
    }
    this.startContinuation([{ id: taskId, summary }])
  }

  /** The run a notification folds into: the frames in flight, a continuation, or the oldest waiting run. */
  private notificationOwner(): LiveRun | undefined {
    if (this.cursor && takesFrames(this.cursor)) return this.cursor
    const continuation = this.openContinuation()
    if (continuation) return continuation
    return this.runs.find(takesFrames)
  }

  /**
   * Opens the continuation for `entries`. Callers take the summaries first and rely on no continuation being
   * open (`frameTarget` returns earlier for an unsettled one, and `routeNotification` gets here only when
   * `notificationOwner()` found none): an open one is returned as is and consumes nothing.
   */
  private startContinuation(entries: ReadonlyArray<{ id: string; summary?: string }>): LiveRun {
    const open = this.openContinuation()
    if (open) return open
    // A wake held at its result for a late steer still owns that steer: it joins the runs, so the steer's frames, a
    // Stop and the process's end still find it.
    const held = this.continuation
    if (held && held.atResult && !held.settled && !this.runs.includes(held)) this.runs.push(held)
    const run = new LiveRun('continuation')
    this.continuation = run
    this.unclaimed.push(run)
    this.cursor = run
    this.clearIdle()
    this.armWake(run)
    // The tasks are the continuation's before the owner hears of it, so it can finish them at once.
    for (const { id, summary } of entries) {
      run.wakeTaskIds.add(id)
      this.obligations.consume(id, run, summary)
    }
    const summaries = entries.flatMap((entry) => (entry.summary ? [entry.summary] : []))
    const tasks = entries.map(({ id }) => {
      const description = this.obligations.describe(id)?.replace(/\s+/g, ' ').trim()
      return { taskId: id, ...(description ? { description } : {}) }
    })
    this.hooks.continuationStarted(run, { id: run.id, taskIds: entries.map((entry) => entry.id), summaries, tasks })
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
    // A result ends the turn in flight. One that names nothing, of a turn no run owns, is that turn's too.
    const stray = this.strayTurn
    this.strayTurn = false
    if (stray && echoed.length === 0) return
    let target: LiveRun | undefined
    if (echoed.length) {
      // A result that names a message took it; a successful one answered it. An interrupted turn's error result names
      // the message that started it too, though the model may never have had it.
      this.markRead(echoed, message.subtype === 'success' && message.is_error !== true ? 'answered' : 'named')
      target = this.ownerOf(echoed)
      if (!target) return
      this.passOver(target, echoed)
      // One result may answer messages of several runs (read together): each has had its result, and the
      // runs that are not the target forget the ids, so a later frame that names them reaches no one.
      for (const owner of this.ownersOf(echoed)) {
        for (const id of echoed) {
          owner.owned.delete(id)
          if (owner !== target) owner.ids.delete(id)
        }
        if (owner !== target && owner.abandoned && owner.owned.size === 0) this.finishCancelled(owner)
      }
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
      target = (this.cursor && !this.cursor.settled && !this.cursor.atResult ? this.cursor : undefined) ?? this.runs.find(takesFrames) ?? this.openContinuation()
    }
    if (!target) return
    if (target.abandoned) {
      // A cancelled turn still owns what it pushed until every message has had its result (or was
      // cancelled), so none of those results reaches another turn.
      if (target.owned.size === 0) this.finishCancelled(target)
      return
    }
    // A live turn ended, so a wake that followed an unlisted task's notification has had its turn.
    // Not cleared above: a cut-off turn's aborted result says nothing about it.
    this.stray = undefined
    // The turn a steer interrupted ends at the steer's own result, not at the abort.
    // Unless Send now's interrupt aborted the steer's own request (Claude Code had taken it): no result of its own will
    // come. The run ends here; the steer is read if the model answered it, and handed back once if not.
    if (isAbortResult(message) && target.steered) {
      const sendNowAbort = this.interruptAbortedSteer(target)
      // Only the first aborted result after the interrupt is the command's or the steer's request; a later one is a
      // later steer's cut, which the run waits past like any other.
      target.interruptedFor.clear()
      if (!sendNowAbort) return void target.deliver(message)
      target.sendNowAbort = message
    }
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
    this.endAtResult(target, message)
  }

  /**
   * `run`'s result arrived. A steer it pushed that Claude Code has not read may still run (issue #919): its message
   * was still on its way when the turn ended (`queued_turn_count` 0), and Claude Code takes it right after, as a turn of
   * its own. Settling now would leave that turn with no run to show it, while the steer counted as read. So the run is
   * held at the result, and Claude Code is asked to drop each such steer (`cancelAsyncMessage`):
   * - dropped: it never runs there, and the run ends with the result; the steer is handed back (`unreadFate`);
   * - taken (a `started` frame, or a frame that names it): the run goes on to the steer's own result (`resume`). Taken
   *   is not read: the steer is accepted once the model answers it (`markRead`), or when that result arrives;
   * - not dropped (false) with no read yet: the run waits up to `lateSteerReadMs` for a read signal. A `cancelled`
   *   lifecycle ends the wait: Claude Code dropped it after all (`lateSteerCancelled`). With no signal the run ends with
   *   the result, and the steer is handed back (`endTaken`).
   * A Claude Code that cannot say (no per-message cancel) is not waited for: the run ends, and the steer is handed back.
   * Stop cancels a held run like any other.
   */
  /**
   * Send now's interrupt landed after Claude Code took the steer for its next request: the aborted result is that
   * request's. (In the normal order the interrupt ends the command first, and its aborted result comes before Claude
   * Code takes the queued steer.) Answered or not, no result of the steer's own will follow: one the model answered
   * is read; one it did not is handed back once by the turn's end (`unreadFate`).
   */
  private interruptAbortedSteer(run: LiveRun): boolean {
    for (const id of run.interruptedFor) if (run.read.has(id)) return true
    return false
  }

  private endAtResult(run: LiveRun, result: SDKResultMessage, delivered = false): void {
    // Already held at its result: Claude Code is asked once, and one wait runs.
    if (run.atResult) return
    const late = [...run.steerIds].filter((id) => run.owned.has(id) && !run.read.has(id))
    const query = this.query
    const cancel = (query as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> } | undefined)?.cancelAsyncMessage
    if (late.length === 0 || !query || typeof cancel !== 'function' || this.dead) return this.settle(run, result, delivered)
    if (!delivered) run.deliver(result)
    run.atResult = result
    for (const id of late) run.lateSteers.add(id)
    if (this.cursor === run) this.cursor = undefined
    const ask = this.askLateSteers(run, query, cancel, late).finally(() => {
      if (run.lateAsk === ask) run.lateAsk = undefined
    })
    run.lateAsk = ask
  }

  private async askLateSteers(run: LiveRun, query: Query, cancel: (uuid: string) => Promise<boolean>, late: readonly string[]): Promise<void> {
    const held = (): boolean => run.atResult !== undefined && !run.settled && !run.abandoned && !this.dead && this.query === query
    for (const id of late) {
      if (!held()) return
      if (!run.lateSteers.has(id)) continue
      let removed: boolean | undefined
      try {
        removed = (await this.bounded(Promise.resolve(cancel.call(query, id)))) === true
      } catch (error) {
        // What Claude Code has queued is unknown: as for a cancel that does not answer, the process is not kept.
        if (error instanceof CancelTimedOut) {
          if (held()) this.giveUpCancel()
          return
        }
      }
      // Claude Code's answer is kept even when the run ended meanwhile (a Stop): `unreadFate` waits for it, so a steer
      // a turn took is not handed back as well, and one it dropped is not left owed.
      if (removed === true && !run.read.has(id)) {
        run.dropped.add(id)
        if (!held()) this.cancelId(id)
      } else if (removed === false) run.taken.add(id)
      if (!held()) return
      if (!run.lateSteers.has(id)) continue
      if (removed === undefined) {
        // Claude Code could not say: the run is not held for it, and the turn's end hands it back (`unreadFate`).
        run.lateSteers.delete(id)
      } else if (removed) {
        run.lateSteers.delete(id)
        run.owned.delete(id)
      }
    }
    if (!held()) return
    if (run.lateSteers.size === 0) return this.endHeld(run)
    // Not dropped: a turn that takes the steer shows itself (`resume`), a `cancelled` lifecycle says it was dropped after
    // all (`lateSteerCancelled`), or the run ends after the wait and the steer is handed back (`endTaken`).
    if (run.lateTimer) clearTimeout(run.lateTimer)
    run.lateTimer = setTimeout(() => {
      run.lateTimer = undefined
      this.endTaken(run)
    }, this.timings.lateSteerReadMs)
    run.lateTimer.unref?.()
  }

  /**
   * A held run whose steer `cancelAsyncMessage` could not drop (it answered false), and which nothing showed taken
   * within `lateSteerReadMs` (a `started` or `completed` lifecycle, or a frame or result that names it: each resumes the
   * run at once; only the model's answer or the turn's result then makes the steer read), ends with its result, and the
   * steer is handed back (`unreadFate` says `dropped`): it runs once, as the next turn. False alone is not a read. Claude Code answers it for a steer its queue gave up a moment before the cancel
   * came, then drops that steer as the turn starts; it says so with a `cancelled` lifecycle (`lateSteerCancelled`), but
   * a steer that ran is never silent for this long. At least once, never lost: a Claude Code that ran the steer and sent
   * neither lifecycle nor frames would run it twice, so a warning says it was handed back (ids only).
   *
   * Its turn may still come: until its result, or `lateSteerStandInMs` with no sign of it, a cancelled stand-in owns the
   * steer, so that turn's frames reach no other run (the next prompt's run among them) and are dropped. Its first frame
   * names the steer and the rest follow it (`frameTarget`); its result names the steer and ends the stand-in. A
   * `started` lifecycle or model output for it then means the steer may run twice (`readAfterHandBack`); an error
   * result that names it does not.
   */
  private endTaken(run: LiveRun): void {
    const unread = [...run.lateSteers].filter((id) => run.taken.has(id) && run.owned.has(id) && !run.read.has(id))
    const index = this.runs.indexOf(run)
    // Before the run settles: the turn's end asks `unreadFate`, which must find them handed back, not taken.
    for (const id of unread) {
      run.taken.delete(id)
      run.dropped.add(id)
    }
    this.endHeld(run)
    if (unread.length === 0) return
    console.warn('[claude-live] Claude Code did not drop a late steer, and nothing showed it read it; it is handed back', {
      threadId: this.threadId,
      runId: run.id,
      messageIds: unread
    })
    if (!run.settled || this.dead) return
    this.standIn(run, unread, index)
  }

  /**
   * A cancelled stand-in that owns `ids`, steers `pusher` pushed and handed back with no read signal, until Claude Code's
   * turn for them ends or `lateSteerStandInMs` passes with no sign of it (`armStandIn`). It goes where `pusher` was among
   * the runs (oldest first), so a newer turn's frames pass it over and an older one's do not.
   */
  private standIn(pusher: LiveRun, ids: readonly string[], index: number): void {
    const standIn = new LiveRun('prompt')
    standIn.abandoned = true
    standIn.handedBackBy = pusher
    for (const id of ids) {
      standIn.ids.add(id)
      standIn.owned.add(id)
    }
    this.runs.splice(index >= 0 ? Math.min(index, this.runs.length) : this.runs.length, 0, standIn)
    this.armStandIn(standIn)
  }

  /**
   * A stand-in whose steer showed no sign of a turn within `lateSteerStandInMs` ends: Claude Code dropped it. One whose
   * turn has begun (a read, or a frame that named it) waits for that turn's result instead, so the rest of the turn
   * still has an owner.
   */
  private armStandIn(standIn: LiveRun): void {
    standIn.standInTimer = setTimeout(() => {
      standIn.standInTimer = undefined
      if (standIn.settled || this.dead) return
      if (standIn.read.size > 0 || standIn.seen.size > 0) return
      this.finishCancelled(standIn)
    }, this.timings.lateSteerStandInMs)
    standIn.standInTimer.unref?.()
  }

  /** A held run's late steer runs: the run is live again until that steer's result. */
  private resume(run: LiveRun): void {
    if (!run.atResult) return
    this.releaseHold(run)
    run.resultSeen = false
  }

  /** A held run whose late steers will not run ends with the result it was held at (already delivered). */
  private endHeld(run: LiveRun): void {
    const result = run.atResult
    if (!result || run.settled || run.abandoned) return
    this.releaseHold(run)
    this.settle(run, result, true)
  }

  private releaseHold(run: LiveRun): void {
    run.atResult = undefined
    run.lateSteers.clear()
    if (run.lateTimer) clearTimeout(run.lateTimer)
    run.lateTimer = undefined
  }

  /** `target`'s result came from a wake turn: it read what that wake read, and the wake's own run is over. */
  private foldWake(target: LiveRun): void {
    // What a wake adopts is read by that wake, so a cut-off wake discards it.
    const adopted = this.obligations.adoptCarried(target)
    if (target.kind === 'continuation') for (const id of adopted) target.wakeTaskIds.add(id)
    const continuation = this.continuation
    if (!continuation || continuation === target) return
    if (continuation.abandoned) this.finishCancelled(continuation)
    else {
      const moved = this.obligations.reassign(continuation, target)
      if (target.kind === 'continuation') for (const id of moved) target.wakeTaskIds.add(id)
      this.endContinuation(continuation, 'folded')
    }
  }

  private settle(run: LiveRun, result: SDKResultMessage, delivered = false): void {
    if (run.settled) return
    if (!delivered) run.deliver(result)
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
    if (run.standInTimer) clearTimeout(run.standInTimer)
    run.standInTimer = undefined
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
    // Before the input closes: the SDK's own close (and the lifetime's abort) only ends it, and signals much later.
    if (this.abrupt) this.terminate()
    this.queue.close()
    this.lifetime.abort()
    try {
      this.query?.close()
    } catch {
      // The process is going away either way.
    }
    for (const run of [...this.runs, ...(this.continuation ? [this.continuation] : [])]) {
      if (run.settled) continue
      // A run held at its result had its answer: it ends with it, and its late steer comes back (`unreadFate`).
      const result = run.atResult
      this.releaseHold(run)
      if (result && !run.abandoned) run.resolve({ result })
      else run.reject(error)
    }
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

  /**
   * Sends the process SIGTERM through Mousse's handle and hands it to `hooks.reap`, which kills its tree if it outlives
   * the grace. One that cannot be reached is left to the SDK's close (its input ends, and the SDK signals it later), with
   * a warning: a queued message may start before it exits. Ids only.
   */
  private terminate(): void {
    const target = this.query ? claudeQueryProcess(this.query) : undefined
    if (target?.terminate?.()) {
      if (this.hooks.reap) {
        this.reaped = true
        this.hooks.reap(target)
      }
      return
    }
    console.warn('[claude-live] could not signal Claude Code; its input is closed instead, and a queued message may start before it exits', {
      threadId: this.threadId,
      ...(target ? { pid: target.pid } : {})
    })
  }
}
