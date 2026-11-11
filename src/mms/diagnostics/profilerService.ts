/**
 * What the profiler's agent tools read in the running service, installation-wide: the memory monitor while the
 * profiler is on, the desktop app's report on request, every profile's threads in memory, and the heap summary.
 * `startMemoryMonitor` sets it when the service starts; a service without one (tests, an embedded host) has no
 * profiler, and the tools say so.
 */
import type { MemoryMonitor } from './MemoryMonitor'
import type { HeapSummary } from './heapSummary'

/** A thread the service holds in memory: a loaded session, a thread database cache entry, or both. */
export interface ThreadMemoryEntry {
  /** Absent for a cache entry no store of this service loaded. Whether it is the caller's profile's is the tool's call. */
  threadId?: string
  loaded: boolean
  cached: boolean
  turnRunning: boolean
  /** The serialized size of the rows and state the cache holds for it, measured; null when it is not cached. */
  cachedBytes: number | null
  idleSeconds: number | null
}

export interface ProfilerService {
  /** The running monitor; null while the profiler is off. */
  monitor(): MemoryMonitor | null
  /**
   * Asks the desktop app for its processes now, with each window's counters when `windows`. Resolves true once the
   * app answered, false when no app answered in time (none is open, or an older one).
   */
  collectApp(windows: boolean, timeoutMs?: number): Promise<boolean>
  /** Every thread in memory, across profiles. */
  threads(): ThreadMemoryEntry[]
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
