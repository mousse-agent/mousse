import { resolve } from 'node:path'
import { buildWorkspaceIndex, type WorkspaceIndexSnapshot } from './WorkspaceIndex'

export interface WorkspaceIndexRegistryOptions {
  now?: () => number
  /** A root unused for this long is dropped. */
  idleMs?: number
  /** A snapshot older than this is rebuilt in the background when queried. */
  staleMs?: number
  /** At most this many roots stay live; the least recently used go first. */
  maxRoots?: number
  cap?: number
  /** How long the first query on a root waits for a snapshot before answering with what exists. */
  firstWaitMs?: number
  build?: typeof buildWorkspaceIndex
}

export interface WorkspaceIndexLookup {
  /** Complete when ready; a partial snapshot (or `null`) while the first build is running. */
  snapshot: WorkspaceIndexSnapshot | null
  indexing: boolean
}

export interface WorkspaceIndexRootStats {
  root: string
  complete: boolean
  partial: boolean
  building: boolean
  dirty: boolean
  lastUsed: number
}

interface RootEntry {
  root: string
  complete: WorkspaceIndexSnapshot | null
  partial: WorkspaceIndexSnapshot | null
  building: Promise<void> | null
  abort: AbortController | null
  /** Set by `invalidate`; the next lookup starts a background rebuild. */
  dirty: boolean
  lastUsed: number
  lastError: unknown
}

const SWEEP_INTERVAL_MS = 60_000

/** Resolves when `promise` settles or after `ms`, whichever is first; never rejects. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, Math.max(0, ms))
    timer.unref?.()
    const finish = (): void => {
      clearTimeout(timer)
      done()
    }
    promise.then(finish, finish)
  })
}

/**
 * Per-root cache of workspace path indexes.
 *
 * There is no file watcher. A lookup answers from the current snapshot at once
 * and starts one background rebuild when the snapshot is older than `staleMs`
 * or was marked dirty. A complete snapshot is never replaced by a rebuild's
 * partial result and survives a failed or aborted rebuild.
 */
export class WorkspaceIndexRegistry {
  private readonly now: () => number
  private readonly idleMs: number
  private readonly staleMs: number
  private readonly maxRoots: number
  private readonly cap: number
  private readonly firstWaitMs: number
  private readonly build: typeof buildWorkspaceIndex
  private readonly entries = new Map<string, RootEntry>()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(options: WorkspaceIndexRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.idleMs = options.idleMs ?? 10 * 60_000
    this.staleMs = options.staleMs ?? 15_000
    this.maxRoots = options.maxRoots ?? 6
    this.cap = options.cap ?? 200_000
    this.firstWaitMs = options.firstWaitMs ?? 300
    this.build = options.build ?? buildWorkspaceIndex
  }

  /**
   * Snapshot for a query. A root with no snapshot starts a build and waits at
   * most `firstWaitMs` for it, then answers with the latest partial snapshot
   * (or `null`) and `indexing: true`.
   */
  async get(root: string): Promise<WorkspaceIndexLookup> {
    const entry = this.touch(root)
    if (entry.complete) {
      this.refreshIfStale(entry)
      return { snapshot: entry.complete, indexing: false }
    }
    if (!entry.building) this.startBuild(entry)
    await settleWithin(entry.building as Promise<void>, this.firstWaitMs)
    return this.lookup(entry)
  }

  /**
   * Waits for a complete snapshot until the absolute `deadline` (a timestamp on
   * the registry's clock). The caller shares that deadline with its own work, so
   * waiting here never restarts the budget it advertises.
   */
  async getComplete(root: string, options: { deadline: number }): Promise<WorkspaceIndexLookup> {
    const entry = this.touch(root)
    if (entry.complete) {
      this.refreshIfStale(entry)
      return { snapshot: entry.complete, indexing: false }
    }
    if (!entry.building) this.startBuild(entry)
    await settleWithin(entry.building as Promise<void>, options.deadline - this.now())
    return this.lookup(entry)
  }

  /** Marks a root's snapshot as out of date. Never builds and never creates an entry. */
  invalidate(root: string): void {
    const entry = this.entries.get(resolve(root))
    if (entry) entry.dirty = true
  }

  /** Drops idle roots, then the least recently used roots beyond `maxRoots`. */
  evictIdle(keep?: string): void {
    const now = this.now()
    for (const entry of [...this.entries.values()]) {
      if (entry.root !== keep && now - entry.lastUsed > this.idleMs) this.drop(entry)
    }
    while (this.entries.size > this.maxRoots) {
      let oldest: RootEntry | null = null
      for (const entry of this.entries.values()) {
        if (entry.root === keep) continue
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry
      }
      if (!oldest) break
      this.drop(oldest)
    }
  }

  stats(): { roots: WorkspaceIndexRootStats[] } {
    return {
      roots: [...this.entries.values()].map((entry) => ({
        root: entry.root,
        complete: entry.complete !== null,
        partial: entry.partial !== null,
        building: entry.building !== null,
        dirty: entry.dirty,
        lastUsed: entry.lastUsed
      }))
    }
  }

  /** Starts the periodic idle sweep; the timer never keeps the process alive. */
  startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.evictIdle(), SWEEP_INTERVAL_MS)
    this.sweeper.unref?.()
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    for (const entry of [...this.entries.values()]) this.drop(entry)
  }

  private touch(root: string): RootEntry {
    const key = resolve(root)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { root: key, complete: null, partial: null, building: null, abort: null, dirty: false, lastUsed: 0, lastError: undefined }
      this.entries.set(key, entry)
      entry.lastUsed = this.now()
      this.evictIdle(key)
    }
    entry.lastUsed = this.now()
    return entry
  }

  private lookup(entry: RootEntry): WorkspaceIndexLookup {
    if (entry.complete) return { snapshot: entry.complete, indexing: false }
    // A build that failed with nothing to show is an error for the caller, not "indexing" forever.
    if (!entry.building && entry.lastError !== undefined) throw entry.lastError
    return { snapshot: entry.partial, indexing: true }
  }

  private refreshIfStale(entry: RootEntry): void {
    if (entry.building || !entry.complete) return
    if (entry.dirty || this.now() - entry.complete.builtAt > this.staleMs) this.startBuild(entry)
  }

  private startBuild(entry: RootEntry): void {
    const controller = new AbortController()
    entry.abort = controller
    entry.dirty = false
    entry.lastError = undefined
    const running: Promise<void> = Promise.resolve().then(() => this.build(entry.root, {
      cap: this.cap,
      signal: controller.signal,
      onProgress: (partial) => {
        // Partials only matter before a complete snapshot exists.
        if (!controller.signal.aborted && !entry.complete) entry.partial = partial
      }
    })).then(
      (snapshot) => {
        if (controller.signal.aborted) return
        entry.complete = snapshot
        entry.partial = null
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        // The previous complete snapshot, if any, stays in service.
        entry.lastError = error
      }
    ).finally(() => {
      if (entry.building === running) {
        entry.building = null
        entry.abort = null
      }
    })
    entry.building = running
  }

  private drop(entry: RootEntry): void {
    entry.abort?.abort()
    if (this.entries.get(entry.root) === entry) this.entries.delete(entry.root)
  }
}

let shared: WorkspaceIndexRegistry | null = null

/** The daemon-wide registry: two profiles on one project share an index. */
export function getWorkspaceIndexRegistry(): WorkspaceIndexRegistry {
  if (!shared) {
    shared = new WorkspaceIndexRegistry()
    shared.startSweeper()
  }
  return shared
}

/** Lets a test install its own registry (and `null` to reset). The test disposes what it installs. */
export function setWorkspaceIndexRegistryForTests(registry: WorkspaceIndexRegistry | null): void {
  shared = registry
}
