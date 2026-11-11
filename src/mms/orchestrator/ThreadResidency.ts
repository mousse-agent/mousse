/**
 * Which threads stay loaded in the daemon's memory (`docs/design/idle-thread-release.md`).
 *
 * A thread is loaded once something needs its session (a turn, a send, a model change) and stays loaded while it is
 * used. This keeps, per loaded thread, when it was last used, and releases a thread that has been idle for
 * `IDLE_RELEASE_MS`, or, past `MAX_IDLE_LOADED` idle threads, the least recently used one idle for `LRU_MIN_IDLE_MS`.
 * Whether a thread may be released at all is the host's rule (`releaseIfIdle`), checked and acted on in one
 * synchronous step. A thread a window shows stays loaded however long it is idle.
 *
 * A released thread reloads from its thread database through the path every thread takes after a restart, so a
 * release changes nothing on disk and nothing a window sees.
 */

/** A loaded thread idle this long is released. */
export const IDLE_RELEASE_MS = 10 * 60_000
/** At most this many idle threads stay loaded; the least recently used of the others are released. */
export const MAX_IDLE_LOADED = 8
/** A thread is released for the cap above only once it has been idle this long. */
export const LRU_MIN_IDLE_MS = 60_000
/** How often idle threads are looked for. */
export const IDLE_SWEEP_MS = 60_000

export interface ResidencyHost {
  /** Threads with a session now (the bound one excluded). */
  loadedThreadIds(): Iterable<string>
  /** Why the thread must stay loaded, or undefined when it may be released now. Cheap, synchronous, no side effects. */
  holdReason(threadId: string): string | undefined
  /** Checks the rule again, saves what is owed and drops the session, in one synchronous step. True when released. */
  releaseIfIdle(threadId: string): boolean
  /** After each sweep: drops what is cached of threads no session holds and nothing used for `idleMs` before `now`. */
  releaseIdleData?(idleMs: number, now: number): void
}

export interface ResidencyOptions {
  now?: () => number
  idleReleaseMs?: number
  maxIdleLoaded?: number
  lruMinIdleMs?: number
  sweepMs?: number
}

export interface ResidencyCounters {
  /** Threads released. */
  released: number
  /** Released threads loaded again. */
  reloads: number
  /** Releases that had to save first (a save was owed). */
  unsavedAtRelease: number
  /** Uses of a released session that had to be re-resolved by id; should stay 0. */
  staleUses: number
  /** Releases refused because the save failed or left something unsaved. */
  failedReleases: number
}

export class ThreadResidency {
  private readonly lastUse = new Map<string, number>()
  private readonly warming = new Map<string, number>()
  private readonly released = new Set<string>()
  /** Threads a window shows, by the window connections that show them. */
  private readonly viewers = new Map<string, Set<string>>()
  private readonly viewed = new Map<string, Set<string>>()
  private readonly watchedLifetimes = new WeakSet<AbortSignal>()
  private timer: ReturnType<typeof setInterval> | null = null
  private enabled: () => boolean = () => true
  now: () => number
  idleReleaseMs: number
  maxIdleLoaded: number
  lruMinIdleMs: number
  readonly sweepMs: number
  readonly counters: ResidencyCounters = { released: 0, reloads: 0, unsavedAtRelease: 0, staleUses: 0, failedReleases: 0 }
  private warnedStale = false

  constructor(private readonly host: ResidencyHost, options: ResidencyOptions = {}) {
    this.now = options.now ?? Date.now
    this.idleReleaseMs = options.idleReleaseMs ?? IDLE_RELEASE_MS
    this.maxIdleLoaded = options.maxIdleLoaded ?? MAX_IDLE_LOADED
    this.lruMinIdleMs = options.lruMinIdleMs ?? LRU_MIN_IDLE_MS
    this.sweepMs = options.sweepMs ?? IDLE_SWEEP_MS
  }

  /** The kill switch: when it returns false, nothing is released. Read at every sweep. */
  setEnabled(enabled: () => boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    try {
      return this.enabled()
    } catch {
      return false
    }
  }

  /** Starts the sweep (an unref'd timer). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.sweepNow(), this.sweepMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The thread was used now: a session read, a send, a page of a loaded thread. */
  touch(threadId: string): void {
    this.lastUse.set(threadId, this.now())
  }

  /** A session was created for the thread; counts a reload when it had been released. */
  loaded(threadId: string): void {
    this.touch(threadId)
    if (this.released.delete(threadId)) this.counters.reloads += 1
  }

  /** A reload is reading the thread off the event loop; the thread is not released meanwhile. */
  beginWarm(threadId: string): void {
    this.warming.set(threadId, (this.warming.get(threadId) ?? 0) + 1)
  }

  endWarm(threadId: string): void {
    const count = (this.warming.get(threadId) ?? 0) - 1
    if (count > 0) this.warming.set(threadId, count)
    else this.warming.delete(threadId)
    this.touch(threadId)
  }

  isWarming(threadId: string): boolean {
    return (this.warming.get(threadId) ?? 0) > 0
  }

  /**
   * A window shows the thread (`focused`), or stopped showing it. A window's views end with its connection
   * (`lifetime` aborts when it closes or switches profile).
   */
  setViewed(connectionId: string, threadId: string, focused: boolean, lifetime?: AbortSignal): void {
    if (focused) {
      if (lifetime?.aborted) return
      let viewers = this.viewers.get(threadId)
      if (!viewers) this.viewers.set(threadId, (viewers = new Set()))
      viewers.add(connectionId)
      let threads = this.viewed.get(connectionId)
      if (!threads) this.viewed.set(connectionId, (threads = new Set()))
      threads.add(threadId)
      if (lifetime && !this.watchedLifetimes.has(lifetime)) {
        this.watchedLifetimes.add(lifetime)
        lifetime.addEventListener('abort', () => this.connectionClosed(connectionId), { once: true })
      }
    } else {
      this.viewers.get(threadId)?.delete(connectionId)
      if (this.viewers.get(threadId)?.size === 0) this.viewers.delete(threadId)
      this.viewed.get(connectionId)?.delete(threadId)
    }
    // Showing or leaving a thread is a use: it stays for the full idle time after a window leaves it.
    this.touch(threadId)
  }

  connectionClosed(connectionId: string): void {
    for (const threadId of this.viewed.get(connectionId) ?? []) {
      this.viewers.get(threadId)?.delete(connectionId)
      if (this.viewers.get(threadId)?.size === 0) this.viewers.delete(threadId)
      this.touch(threadId)
    }
    this.viewed.delete(connectionId)
  }

  isViewed(threadId: string): boolean {
    return (this.viewers.get(threadId)?.size ?? 0) > 0
  }

  /** The session was dropped. */
  noteReleased(threadId: string): void {
    this.lastUse.delete(threadId)
    this.released.add(threadId)
    this.counters.released += 1
  }

  /** A thread that is gone (deleted, restored) is forgotten. */
  forget(threadId: string): void {
    this.lastUse.delete(threadId)
    this.released.delete(threadId)
  }

  /** Code used a released session; it is re-resolved by id. Should never happen. */
  noteStaleUse(threadId: string): void {
    this.counters.staleUses += 1
    if (this.warnedStale) return
    this.warnedStale = true
    console.warn('a released thread\'s session was used after its release; it was loaded again', { threadId })
  }

  /** Releases what is due now; returns the threads released. Tests call it directly. */
  sweepNow(): string[] {
    if (!this.isEnabled()) return []
    const now = this.now()
    const out: string[] = []
    const idle: Array<{ threadId: string; since: number }> = []
    for (const threadId of [...this.host.loadedThreadIds()]) {
      if (this.isWarming(threadId) || this.isViewed(threadId)) continue
      if (this.host.holdReason(threadId) !== undefined) continue
      let since = this.lastUse.get(threadId)
      if (since === undefined) {
        // Loaded before this knew of it: its idle time starts now.
        this.lastUse.set(threadId, now)
        since = now
      }
      if (now - since >= this.idleReleaseMs) {
        if (this.host.releaseIfIdle(threadId)) out.push(threadId)
        continue
      }
      idle.push({ threadId, since })
    }
    // Past the cap of idle threads kept, the least recently used ones go once idle a while.
    idle.sort((a, b) => a.since - b.since)
    let over = idle.length - this.maxIdleLoaded
    for (const { threadId, since } of idle) {
      if (over <= 0) break
      if (now - since < this.lruMinIdleMs) break
      if (this.host.releaseIfIdle(threadId)) {
        out.push(threadId)
        over -= 1
      }
    }
    try {
      this.host.releaseIdleData?.(this.idleReleaseMs, now)
    } catch (error) {
      console.warn('idle thread data could not be dropped', error instanceof Error ? error.message : String(error))
    }
    return out
  }
}
