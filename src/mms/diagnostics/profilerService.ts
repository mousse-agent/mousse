/**
 * What the profiler's agent tools read in the running service, installation-wide: the memory monitor while the
 * profiler is on, the desktop app's report on request, the threads in memory (the caller's profile's one by one, the
 * rest as totals), and the heap summary.
 * `startMemoryMonitor` sets it when the service starts; a service without one (tests, an embedded host) has no
 * profiler, and the tools say so.
 */
import type { MemoryMonitor } from './MemoryMonitor'
import type { HeapSummary } from './heapSummary'

/** A thread of the caller's profile the service holds in memory: a loaded session, a thread database cache entry, or both. */
export interface ThreadMemoryEntry {
  /** Absent for a cache entry no store of this profile loaded. */
  threadId?: string
  loaded: boolean
  cached: boolean
  turnRunning: boolean
  /** The serialized size of the rows and state the cache holds for it, measured; null when it is not cached. */
  cachedBytes: number | null
  idleSeconds: number | null
}

/** The other profiles' threads in memory, as totals: another profile belongs to another person, so no ids or states. */
export interface OtherProfilesMemory {
  profiles: number
  loadedThreads: number
  cachedThreads: number
  cachedBytes: number
}

/** The threads in memory as the caller may see them: its own profile's one by one, the rest as totals. */
export interface ThreadMemory {
  own: ThreadMemoryEntry[]
  others: OtherProfilesMemory
}

export interface ProfilerService {
  /** The running monitor; null while the profiler is off. */
  monitor(): MemoryMonitor | null
  /**
   * Asks the desktop app for its processes now, with each window's counters when `windows`. Resolves true once the
   * app answered, false when no app answered in time (none is open, or an older one).
   */
  collectApp(windows: boolean, timeoutMs?: number): Promise<boolean>
  /**
   * The threads in memory: those of the profile whose orchestrator is `owner` (the caller's) one by one, every
   * other profile's only as totals.
   */
  threads(owner: object): ThreadMemory
  /** Turns running now, across profiles. */
  activeTurns(): number
  /** A service heap snapshot, summarized in a worker and deleted. */
  heapSummary(top: number): Promise<HeapSummary>
  /** Settings changed: start or stop the monitor to match. */
  refresh(): void
}

let current: ProfilerService | null = null

export function setProfilerService(service: ProfilerService | null): void {
  current = service
}

export function profilerService(): ProfilerService | null {
  return current
}
