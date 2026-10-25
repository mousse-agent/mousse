import { THREAD_STATUS_TYPES, notificationParams, type CodexNotification, type ThreadStatusType } from './protocol'

/**
 * Codex's own helpers (subagents, separate Codex threads, nested ones included) read back from the
 * app-server. Membership and liveness are read when a decision is made (`thread/list` with
 * `ancestorThreadId`, `thread/read`); notifications are only wake-ups and a safety net. The module is
 * pure: the service injects the requests, the interrupt and the clock.
 *
 * A run is quiescent when two snapshots at least `CODEX_PAIR_GAP_MS` apart agree and nothing
 * woke the tree between them. Why that is enough: a thread that ran a turn between the two reads
 * had its "active" notification queued before the server marked it idle, and the connection delivers
 * messages in order, so that notification reaches `noteWake` before the second response can
 * complete the pair. The one assumption left is timing: a helper spawned during a turn that was
 * already active at the first read is seen only if it is listed or has been active by the second
 * read (its first turn starts from the spawner's message in-process, faster than the spawner's next
 * model round trip). A helper missed that way shows up as a leftover to the next run on the thread.
 * The ordering argument covers threads whose event listener is attached; before that the server lists a
 * status from the core agent status instead, and the newborn window (`CODEX_NEWBORN_MS`) covers that gap.
 */

/** A listed helper that has not been seen active yet counts as busy for this long after it was created. */
export const CODEX_NEWBORN_MS = 2_000
/** At least this long between two scans (the pair of a quiescence check excepted). */
export const CODEX_SCAN_MIN_MS = 1_000
/** The two snapshots of a quiescence pair are at least this far apart. */
export const CODEX_PAIR_GAP_MS = 250
/** A scan runs at least this often while something is busy, whatever the notifications said. */
export const CODEX_SAFETY_TICK_MS = 15_000
/** Gap between sweep rounds when no notification wakes the next one earlier. */
export const CODEX_SWEEP_ROUND_MS = 500
/** Backoff after a transport failure of a snapshot. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000]

/** The waits above; tests shorten them. */
export interface TreeTiming {
  newbornMs: number
  scanMinMs: number
  pairGapMs: number
  safetyTickMs: number
  sweepRoundMs: number
}
export const DEFAULT_TREE_TIMING: TreeTiming = {
  newbornMs: CODEX_NEWBORN_MS,
  scanMinMs: CODEX_SCAN_MIN_MS,
  pairGapMs: CODEX_PAIR_GAP_MS,
  safetyTickMs: CODEX_SAFETY_TICK_MS,
  sweepRoundMs: CODEX_SWEEP_ROUND_MS
}
/** How many parent links placement follows from an unknown thread. */
const MAX_HOPS = 8

/** The server answered a request with an error response; unlike a transport failure, it will not change. */
export class RpcRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcRefused'
  }
}

/** A snapshot that was still running when its sweep gave up; its answers are dropped. */
class Abandoned extends Error {}

/** The server is not answering like one that filters by ancestor; the tree mode ends for the process. */
export class TreeOff extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TreeOff'
  }
}

export interface TreePorts {
  /** `thread/read`: the `thread` object as the server sent it. An error response throws `RpcRefused`. */
  read(threadId: string): Promise<unknown>
  /** Every page of `thread/list` with `ancestorThreadId`, merged. An error response throws `RpcRefused`. */
  list(ancestorThreadId: string): Promise<unknown[]>
  /** Fire and forget `turn/interrupt`; `''` stops whatever turn the thread runs. */
  interrupt(threadId: string, turnId: string): void
  now(): number
}

/** Direct helpers seen through the thread's items (master's tracking): the floor under the tree. */
export interface TreeFloor {
  running(): string[]
}

const isStatus = (value: unknown): value is ThreadStatusType => typeof value === 'string' && THREAD_STATUS_TYPES.includes(value)

const WAKE_METHODS = new Set(['thread/status/changed', 'turn/started', 'turn/completed'])
const WAKE_ITEMS = new Set(['subAgentActivity', 'collabAgentToolCall'])

/** Notifications that can change who is busy: status and turn changes, and spawn items. */
export function isWakeUp(notification: CodexNotification): boolean {
  if (WAKE_METHODS.has(notification.method)) return true
  if (notification.method !== 'item/started' && notification.method !== 'item/completed') return false
  const item = (notification.params as { item?: { type?: unknown } } | undefined)?.item
  return typeof item?.type === 'string' && WAKE_ITEMS.has(item.type)
}

/**
 * What the process last said about every thread, from `thread/status/changed` (a broadcast to every
 * connection), `turn/started` and `turn/completed`, whichever thread they name.
 */
export class ThreadStatuses {
  private readonly status = new Map<string, ThreadStatusType>()
  private readonly active = new Set<string>()
  private readonly open = new Set<string>()

  note(notification: CodexNotification): void {
    const closed = notificationParams(notification, 'thread/closed')
    if (closed) {
      this.status.delete(closed.threadId)
      this.active.delete(closed.threadId)
      this.open.delete(closed.threadId)
      return
    }
    const changed = notificationParams(notification, 'thread/status/changed')
    if (changed && typeof changed.threadId === 'string') {
      const type = changed.status?.type
      if (!isStatus(type)) return
      this.status.set(changed.threadId, type)
      if (type === 'active') this.active.add(changed.threadId)
      return
    }
    const started = notificationParams(notification, 'turn/started')
    if (started && typeof started.threadId === 'string') {
      this.status.set(started.threadId, 'active')
      this.active.add(started.threadId)
      this.open.add(started.threadId)
      return
    }
    const completed = notificationParams(notification, 'turn/completed')
    if (completed && typeof completed.threadId === 'string') {
      this.status.set(completed.threadId, 'idle')
      this.open.delete(completed.threadId)
    }
  }

  get(threadId: string): ThreadStatusType | undefined {
    return this.status.get(threadId)
  }

  /** The thread has been active at some point since this process started. */
  seenActive(threadId: string): boolean {
    return this.active.has(threadId)
  }

  /** A `turn/started` without its `turn/completed`. */
  turnOpen(threadId: string): boolean {
    return this.open.has(threadId)
  }

  /** Threads that are busy by the server's last word: active, or flagged `systemError` with a turn still open. */
  busyIds(): string[] {
    return [...this.status]
      .filter(([threadId, status]) => status === 'active' || (status === 'systemError' && this.open.has(threadId)))
      .map(([threadId]) => threadId)
  }
}

export interface Snapshot {
  startedAt: number
  /** `voidSeq` when the snapshot began and when it ended. */
  startSeq: number
  endSeq: number
  rootStatus: ThreadStatusType
  rootBusy: boolean
  /** Sorted ids of every member: listed or placed. */
  members: string[]
  /** Members that are busy. */
  busy: string[]
  /** When the first busy newborn stops counting, if one does. */
  newbornAt?: number
  unknownActive: boolean
  floorRunning: boolean
  /** Nothing is busy: the root is idle, no member, no unknown thread, no floor helper. */
  calm: boolean
}

export interface Check {
  snapshot: Snapshot
  /** This snapshot and the one before it form a quiescence pair. */
  quiescent: boolean
}

type ListedRow = { status: ThreadStatusType; createdAt?: number }

export interface SweepOptions {
  /** `Date.now()`-based moment the sweep gives up (the caller's deadline). */
  deadlineAt: number
  signal?: AbortSignal
  /** The root's own turn is active: interrupt it (by id when known). `round` counts the sweep's rounds from 0. */
  interruptRoot(round: number): void
  /** Interrupt the direct helpers master tracks. */
  interruptFloor(): void
  /** The process is gone; nothing more can be done. */
  dead(): boolean
}

/** The helpers of one Codex thread (the root) as the server knows them. */
export class HelperTree {
  private readonly listed = new Map<string, ListedRow>()
  private readonly placed = new Map<string, ThreadStatusType>()
  private readonly unknown = new Set<string>()
  private readonly ruledOut = new Set<string>()
  private readonly seenActive = new Set<string>()
  /** Bumped by every wake-up that can change the outcome of a pair. */
  private voidSeq = 0
  private woke = false
  private wakers: Array<() => void> = []
  private previous: Snapshot | undefined
  private inflight: Promise<Check> | undefined
  /** Bumped when a sweep gives up on a snapshot in flight; that snapshot then changes nothing. */
  private epoch = 0
  /** The last snapshot that completed. */
  last: Snapshot | undefined
  /** When the root or a member last reported anything (the idle cap reads this). */
  lastActivityAt: number

  constructor(
    readonly rootId: string,
    private readonly ports: TreePorts,
    private readonly statuses: ThreadStatuses,
    private readonly floor: TreeFloor,
    private readonly timing: TreeTiming = DEFAULT_TREE_TIMING
  ) {
    this.lastActivityAt = ports.now()
  }

  private isMember(threadId: string): boolean {
    return this.listed.has(threadId) || this.placed.has(threadId)
  }

  /** Threads this tree has a verdict on, besides the root: members and threads ruled out. */
  knows(threadId: string): boolean {
    return threadId === this.rootId || this.isMember(threadId) || this.ruledOut.has(threadId)
  }

  // -------------------------------------------------------------------------------------------
  // Wake-ups

  /**
   * A notification, recorded synchronously when it arrives. One that concerns the root, a member, a
   * thread still being placed or a thread not seen yet voids the current pair; one from a thread ruled
   * out does not. Only the root and members count as activity.
   */
  noteWake(notification: CodexNotification): void {
    if (!isWakeUp(notification)) return
    const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId
    if (typeof threadId !== 'string') return
    if (threadId === this.rootId || this.isMember(threadId)) {
      this.lastActivityAt = this.ports.now()
    } else if (this.ruledOut.has(threadId)) return
    else this.unknown.add(threadId)
    this.voidSeq += 1
    this.poke()
  }

  /** Threads the process reports active that no verdict covers yet go to placement. */
  collectUnknown(): void {
    for (const id of this.statuses.busyIds()) if (!this.knows(id)) this.unknown.add(id)
  }

  private poke(): void {
    this.woke = true
    for (const wake of this.wakers.splice(0)) wake()
  }

  /** Resolves after `ms`, on the next wake-up when `wakeable`, or when `signal` aborts. */
  private pause(ms: number, signal: AbortSignal | undefined, wakeable: boolean): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    if (wakeable && this.woke) {
      this.woke = false
      return Promise.resolve()
    }
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        const index = this.wakers.indexOf(finish)
        if (index !== -1) this.wakers.splice(index, 1)
        if (wakeable) this.woke = false
        done()
      }
      const timer = setTimeout(finish, Math.max(0, ms))
      timer.unref?.()
      signal?.addEventListener('abort', finish, { once: true })
      if (wakeable) this.wakers.push(finish)
    })
  }

  // -------------------------------------------------------------------------------------------
  // Snapshot

  /** One snapshot, compared with the one before it. Concurrent calls share the snapshot in flight. */
  check(): Promise<Check> {
    if (!this.inflight) {
      const taken: Promise<Check> = this.takeCheck().finally(() => {
        if (this.inflight === taken) this.inflight = undefined
      })
      this.inflight = taken
    }
    return this.inflight
  }

  private abandon(): void {
    this.epoch += 1
    this.inflight = undefined
    this.previous = undefined
  }

  private async takeCheck(): Promise<Check> {
    const epoch = this.epoch
    const snapshot = await this.snapshot(epoch)
    const before = this.previous
    const quiescent =
      before !== undefined &&
      before.calm &&
      snapshot.calm &&
      snapshot.endSeq === before.startSeq &&
      snapshot.members.join('\n') === before.members.join('\n') &&
      snapshot.startedAt - before.startedAt >= this.timing.pairGapMs
    this.previous = snapshot
    this.last = snapshot
    return { snapshot, quiescent }
  }

  private async snapshot(epoch: number): Promise<Snapshot> {
    const live = (): void => {
      if (epoch !== this.epoch) throw new Abandoned()
    }
    const startedAt = this.ports.now()
    const startSeq = this.voidSeq
    // Cleared now: a wake-up during the reads asks for another scan.
    this.woke = false

    const root = await this.readRoot()
    live()
    const { rows, parents } = await this.readRows()
    live()
    this.listed.clear()
    for (const [id, row] of rows) {
      this.listed.set(id, row)
      this.placed.delete(id)
      if (row.status === 'active') this.seenActive.add(id)
    }
    // A row whose parent the listing lacks (a helper whose own row is not written yet, or one archived) is
    // fine when the parent leads back to the root; only one that provably belongs to another thread is not.
    for (const parent of new Set(parents.values())) {
      if (parent === this.rootId || this.listed.has(parent)) continue
      const walked = await this.walk(parent)
      live()
      if (walked.verdict === 'out') throw new TreeOff('a listed thread descends from another thread')
      if (walked.verdict === 'in') this.rule(walked.chain, 'in')
    }
    for (const id of [...this.placed.keys()]) {
      this.placed.set(id, await this.refresh(id))
      live()
    }
    this.collectUnknown()
    for (const id of [...this.unknown]) {
      await this.place(id)
      live()
    }

    const now = this.ports.now()
    const busy: string[] = []
    let newbornAt: number | undefined
    for (const [id, row] of this.listed) {
      if (this.busyStatus(id, row.status)) busy.push(id)
      else if (row.status === 'idle' && row.createdAt !== undefined && !this.hasBeenActive(id)) {
        const expires = row.createdAt * 1000 + this.timing.newbornMs
        if (now < expires) {
          busy.push(id)
          newbornAt = Math.min(newbornAt ?? expires, expires)
        }
      }
    }
    for (const [id, status] of this.placed) if (this.busyStatus(id, status)) busy.push(id)

    const rootBusy = this.busyStatus(this.rootId, root)
    const unknownActive = [...this.unknown].some((id) => {
      const status = this.statuses.get(id)
      return status !== undefined && this.busyStatus(id, status)
    })
    const floorRunning = this.floor.running().length > 0
    return {
      startedAt,
      startSeq,
      endSeq: this.voidSeq,
      rootStatus: root,
      rootBusy,
      members: [...this.listed.keys(), ...this.placed.keys()].sort(),
      busy,
      ...(newbornAt !== undefined ? { newbornAt } : {}),
      unknownActive,
      floorRunning,
      calm: !rootBusy && busy.length === 0 && !unknownActive && !floorRunning
    }
  }

  private hasBeenActive(threadId: string): boolean {
    return this.seenActive.has(threadId) || this.statuses.seenActive(threadId)
  }

  /**
   * Active is busy. So is a thread the server marked `systemError` while a turn of it is still open
   * (the server flags every error, also ones that do not end the turn). `notLoaded` and a
   * `systemError` after the turn ended are settled.
   */
  private busyStatus(threadId: string, status: ThreadStatusType): boolean {
    return status === 'active' || (status === 'systemError' && this.statuses.turnOpen(threadId))
  }

  private async readRoot(): Promise<ThreadStatusType> {
    let raw: unknown
    try {
      raw = await this.ports.read(this.rootId)
    } catch (error) {
      if (error instanceof RpcRefused) throw new TreeOff(`thread/read of the run's thread was refused: ${error.message}`)
      throw error
    }
    const status = parseThread(raw).status
    if (!status) throw new TreeOff("thread/read of the run's thread has no known status")
    return status
  }

  /** The descendants the server lists, checked for shape; `snapshot` checks that their parents lead to the root. */
  private async readRows(): Promise<{ rows: Map<string, ListedRow>; parents: Map<string, string> }> {
    let rows: unknown[]
    try {
      rows = await this.ports.list(this.rootId)
    } catch (error) {
      if (error instanceof RpcRefused) throw new TreeOff(`thread/list was refused: ${error.message}`)
      throw error
    }
    const parents = new Map<string, string>()
    const result = new Map<string, ListedRow>()
    for (const raw of rows) {
      const row = raw as { id?: unknown; parentThreadId?: unknown; createdAt?: unknown; status?: { type?: unknown } } | null
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') throw new TreeOff('a listed thread has no id')
      if (typeof row.parentThreadId !== 'string') throw new TreeOff('a listed thread has no parent')
      const type = row.status?.type
      if (!isStatus(type)) throw new TreeOff('a listed thread has no known status')
      if (row.id === this.rootId) throw new TreeOff('the listing contains the thread itself')
      parents.set(row.id, row.parentThreadId)
      result.set(row.id, { status: type, ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}) })
    }
    return { rows: result, parents }
  }

  /** A placed member's status. An error response means the thread is gone from the server: use what it last announced. */
  private async refresh(threadId: string): Promise<ThreadStatusType> {
    try {
      return parseThread(await this.ports.read(threadId)).status ?? this.statuses.get(threadId) ?? 'notLoaded'
    } catch (error) {
      if (error instanceof RpcRefused) return this.statuses.get(threadId) ?? 'notLoaded'
      throw error
    }
  }

  /**
   * Follows `parentThreadId` from `start`. Reaching the root or a member is `in` (with the threads on the
   * way); reaching a root thread of its own, or a thread ruled out, is `out`. Anything else (a refused
   * read, a read without a parent, too many hops) is `inconclusive`: nothing is concluded from a failure.
   */
  private async walk(start: string): Promise<{ verdict: 'in' | 'out' | 'inconclusive'; chain: Array<{ id: string; status: ThreadStatusType }> }> {
    const chain: Array<{ id: string; status: ThreadStatusType }> = []
    if (start === this.rootId || this.isMember(start)) return { verdict: 'in', chain }
    if (this.ruledOut.has(start)) return { verdict: 'out', chain }
    let current = start
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      let thread: ReturnType<typeof parseThread>
      try {
        thread = parseThread(await this.ports.read(current))
      } catch (error) {
        if (error instanceof RpcRefused) return { verdict: 'inconclusive', chain }
        throw error
      }
      chain.push({ id: current, status: thread.status ?? this.statuses.get(current) ?? 'notLoaded' })
      if (thread.parent === null) return { verdict: 'out', chain }
      if (typeof thread.parent !== 'string') return { verdict: 'inconclusive', chain }
      if (thread.parent === this.rootId || this.isMember(thread.parent)) return { verdict: 'in', chain }
      if (this.ruledOut.has(thread.parent)) return { verdict: 'out', chain }
      current = thread.parent
    }
    return { verdict: 'inconclusive', chain }
  }

  /**
   * Places an unknown thread. `in`: it and the threads on the way become placed members. `out`: they are
   * ruled out. Otherwise it stays unknown and is tried again at the next snapshot.
   */
  private async place(start: string): Promise<void> {
    if (this.knows(start)) {
      this.unknown.delete(start)
      return
    }
    const walked = await this.walk(start)
    if (walked.verdict !== 'inconclusive') this.rule(walked.chain, walked.verdict)
  }

  private rule(chain: Array<{ id: string; status: ThreadStatusType }>, verdict: 'in' | 'out'): void {
    for (const { id, status } of chain) {
      this.unknown.delete(id)
      if (verdict === 'in') this.placed.set(id, status)
      else this.ruledOut.add(id)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Waiting and sweeping

  /**
   * Resolves once the tree is quiescent. Rejects with `TreeOff` when the server turns out not to
   * filter by ancestor, and with the signal's reason when aborted. A transport failure is retried
   * with backoff, so nothing is concluded from it.
   */
  async untilQuiescent(signal: AbortSignal): Promise<void> {
    this.previous = undefined
    this.collectUnknown()
    let failures = 0
    for (;;) {
      signal.throwIfAborted()
      const scanStart = this.ports.now()
      let snapshot: Snapshot
      try {
        const check = await this.check()
        if (check.quiescent) return
        snapshot = check.snapshot
        failures = 0
      } catch (error) {
        if (error instanceof TreeOff) throw error
        signal.throwIfAborted()
        failures += 1
        await this.pause(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1], signal, false)
        continue
      }
      if (snapshot.calm) {
        // The second snapshot of a pair.
        await this.pause(this.timing.pairGapMs - (this.ports.now() - snapshot.startedAt), signal, false)
        continue
      }
      // Busy: the next scan waits for a wake-up (or the newborn's expiry, or the safety tick) ...
      const untilNewborn = snapshot.newbornAt === undefined ? Infinity : snapshot.newbornAt - this.ports.now()
      await this.pause(Math.min(this.timing.safetyTickMs, untilNewborn), signal, true)
      // ... but never sooner than the minimum gap after the previous scan began.
      await this.pause(this.timing.scanMinMs - (this.ports.now() - scanStart), signal, false)
    }
  }

  /** The members to interrupt: busy ones. Never `notLoaded`, a settled `systemError`, or an unknown or ruled-out thread. */
  private targets(snapshot: Snapshot | undefined): string[] {
    return snapshot?.busy ?? []
  }

  /**
   * Stops the tree: each round reads it, interrupts the root and every busy member (and the floor)
   * and goes on until a quiescence pair, `deadlineAt`, or the process is gone. The parent's interrupt
   * does not cascade and a stopped turn can start a queued one at once, so one interrupt proves
   * nothing: the last word is a pair of snapshots.
   */
  async sweep(options: SweepOptions): Promise<'quiescent' | 'deadline' | 'closed'> {
    this.previous = undefined
    this.collectUnknown()
    for (let round = 0; ; round += 1) {
      if (options.dead() || options.signal?.aborted) return 'closed'
      const roundStart = this.ports.now()
      let snapshot = this.last
      let quiescent = false
      // A snapshot never holds the sweep past its deadline: a read that hangs is given up on, and what it
      // eventually answers is dropped.
      const outcome = await this.within(this.check(), options.deadlineAt - roundStart, options.signal)
      if (outcome.kind === 'done') {
        snapshot = outcome.value.snapshot
        quiescent = outcome.value.quiescent
      } else if (outcome.kind === 'error') {
        // Transport failure: act on the last snapshot that completed and the floor, and try again.
        if (outcome.error instanceof TreeOff) throw outcome.error
      } else this.abandon()
      if (options.dead() || outcome.kind === 'aborted') return 'closed'
      if (snapshot?.rootBusy) options.interruptRoot(round)
      for (const id of this.targets(snapshot)) this.ports.interrupt(id, '')
      options.interruptFloor()
      if (quiescent) return 'quiescent'
      const now = this.ports.now()
      if (outcome.kind === 'timeout' || now >= options.deadlineAt) return 'deadline'
      await this.pause(Math.min(this.timing.sweepRoundMs, options.deadlineAt - now), options.signal, true)
      await this.pause(this.timing.pairGapMs - (this.ports.now() - roundStart), options.signal, false)
    }
  }

  /** `promise`'s outcome, or `timeout` after `ms`, or `aborted` when `signal` aborts first. */
  private within<T>(
    promise: Promise<T>,
    ms: number,
    signal: AbortSignal | undefined
  ): Promise<{ kind: 'done'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'aborted' }> {
    return new Promise((resolve) => {
      const finish = (result: Parameters<typeof resolve>[0]): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => finish({ kind: 'aborted' })
      const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, ms))
      timer.unref?.()
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => finish({ kind: 'done', value }),
        (error: unknown) => finish({ kind: 'error', error })
      )
    })
  }
}

/** The fields of a `thread` object the tree reads; a missing or unknown one is `undefined`. */
function parseThread(raw: unknown): { status?: ThreadStatusType; parent?: string | null } {
  const thread = raw as { status?: { type?: unknown }; parentThreadId?: unknown } | null
  if (!thread || typeof thread !== 'object') return {}
  const type = thread.status?.type
  return {
    ...(isStatus(type) ? { status: type } : {}),
    ...(thread.parentThreadId === null || typeof thread.parentThreadId === 'string' ? { parent: thread.parentThreadId } : {})
  }
}
