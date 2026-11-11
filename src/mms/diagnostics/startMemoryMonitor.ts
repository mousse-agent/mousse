/**
 * Wires the profiler's memory monitor into the running service (the daemon entry, `service run`, only). It runs only
 * while a live profile has the profiler on (Settings → Labs): off, there is no timer, no sample and no log line. The
 * counts come from every live profile, the thread database workers and the protocol server's replay buffers.
 */
import { randomUUID } from 'node:crypto'
import type { MousseMainService } from '../MousseMainService'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { MmsProtocolServer } from '../protocol/server'
import { existingThreadDbClient } from '../data/threadDb/threadDbClient'
import { onSettingsSaved } from '../settings/SettingsStore'
import { DEFAULT_MEMORY_THRESHOLDS, MEMORY_THRESHOLDS_ENV, isPackagedRuntime, resolveMemoryThresholds, toMb, type MemoryThresholds } from '../../shared/diagnostics/memory'
import { writeHeapSnapshotFile } from './heapSnapshot'
import { removeLeftoverSummaryFiles, takeHeapSummary } from './heapSummary'
import { MemoryMonitor, type ServiceCountsReading } from './MemoryMonitor'
import { liveFileWatchers } from './liveCounts'
import { MEMORY_NOTICE_EVENT, PROFILER_COLLECT_EVENT, PROFILER_STATE_EVENT, registerMemoryDiagnosticsMethods, type MemoryMonitorHolder } from './memoryDomain'
import { setProfilerService, type OtherProfilesMemory, type ProfilerService, type ThreadMemory, type ThreadMemoryEntry } from './profilerService'

/** Counts summed over `profiles`. Each read is a map size or a short list; nothing is loaded. */
export async function readServiceCounts(profiles: MmsProfileServices[], replayEvents: () => number): Promise<ServiceCountsReading> {
  let loadedThreads = 0
  let threadRuntimes = 0
  let threadCacheThreads = 0
  let threadCacheBytes = 0
  let ptys = 0
  let activeTurns = 0
  for (const services of profiles) {
    activeTurns += services.orchestrator.activeTurnCount()
    loadedThreads += services.orchestrator.loadedSessionCount()
    threadRuntimes += services.threadRuntimes.runtimeCount()
    const cache = services.threads.threadDbCacheStats()
    threadCacheThreads += cache.threads
    threadCacheBytes += cache.bytes
    ptys += services.ptyManager.list().length
  }
  const db = (await existingThreadDbClient()?.diagnostics()) ?? { workers: 0, connections: 0, workerHeaps: [], workerCrashes: 0 }
  return {
    counts: {
      sqliteConnections: db.connections,
      workerThreads: db.workers,
      loadedThreads,
      threadRuntimes,
      threadCacheThreads,
      threadCacheMb: toMb(threadCacheBytes),
      replayEvents: replayEvents(),
      ptys,
      fileWatchers: liveFileWatchers(),
      profiles: profiles.length,
      activeTurns,
      workerCrashes: db.workerCrashes
    },
    workerHeaps: db.workerHeaps
  }
}

type ProfileLike = Pick<MmsProfileServices, 'orchestrator' | 'threads'>

/**
 * The threads in memory: loaded sessions and thread database cache entries. Only the profile whose orchestrator is
 * `owner` (the caller's) is listed thread by thread; every other profile belongs to another person and counts only in
 * totals, with no ids, turn states or idle times.
 */
export function readThreadMemory(profiles: readonly ProfileLike[], owner: object, now = Date.now()): ThreadMemory {
  const own: ThreadMemoryEntry[] = []
  const others: OtherProfilesMemory = { profiles: 0, loadedThreads: 0, cachedThreads: 0, cachedBytes: 0 }
  for (const services of profiles) {
    if (services.orchestrator !== owner) {
      others.profiles += 1
      others.loadedThreads += services.orchestrator.loadedThreadIds().length
      for (const entry of services.threads.threadDbCacheEntries(now)) {
        others.cachedThreads += 1
        others.cachedBytes += entry.bytes
      }
      continue
    }
    const byId = new Map<string, ThreadMemoryEntry>()
    for (const threadId of services.orchestrator.loadedThreadIds()) {
      byId.set(threadId, { threadId, loaded: true, cached: false, turnRunning: services.orchestrator.isTurnActive(threadId), cachedBytes: null, idleSeconds: null })
    }
    for (const entry of services.threads.threadDbCacheEntries(now)) {
      const known = entry.threadId ? byId.get(entry.threadId) : undefined
      const idleSeconds = Math.round(entry.idleMs / 1000)
      if (known) Object.assign(known, { cached: true, cachedBytes: entry.bytes, idleSeconds })
      else own.push({ ...(entry.threadId ? { threadId: entry.threadId } : {}), loaded: false, cached: true, turnRunning: false, cachedBytes: entry.bytes, idleSeconds })
    }
    own.push(...byId.values())
  }
  return { own, others }
}

/** Whether any of `profiles` has the profiler on. */
export function profilerWanted(profiles: readonly Pick<MmsProfileServices, 'settings'>[]): boolean {
  return profiles.some((services) => {
    try {
      return services.settings.get().experimental.profiler.enabled
    } catch {
      return false
    }
  })
}

/** Registers the methods (before the protocol server starts) and returns a starter for after it has. */
export function prepareMemoryMonitor(opts: {
  mms: MousseMainService
  protocolServer: MmsProtocolServer
  homeDir: string
  version: string
  env?: NodeJS.ProcessEnv
  packaged?: boolean
  /** Tests: the monitor to run when the profiler turns on. */
  createMonitor?: (thresholds: MemoryThresholds) => MemoryMonitor
}): { start: () => void; stop: () => void; refresh: () => void } | null {
  const env = opts.env ?? process.env
  // A heap summary file a crash left behind holds what the service had in memory: gone at every start.
  removeLeftoverSummaryFiles(opts.homeDir)
  if (env[MEMORY_THRESHOLDS_ENV] === 'off' || !opts.mms.domains) return null
  const profiles = () => opts.mms.getInstallationHost()?.liveServices() ?? [opts.mms]
  const activeTurns = () => profiles().reduce((sum, services) => sum + services.orchestrator.activeTurnCount(), 0)
  const thresholds = resolveMemoryThresholds(env[MEMORY_THRESHOLDS_ENV], DEFAULT_MEMORY_THRESHOLDS, { packaged: opts.packaged ?? isPackagedRuntime() })
  const waiting = new Map<string, (answered: boolean) => void>()
  const holder: MemoryMonitorHolder = {
    monitor: null,
    activeTurns,
    writeHeapSnapshot: () => writeHeapSnapshotFile(opts.homeDir),
    state: () => ({ enabled: holder.monitor !== null }),
    collected: (requestId) => {
      waiting.get(requestId)?.(true)
      waiting.delete(requestId)
    }
  }
  const offClosed = registerMemoryDiagnosticsMethods(opts.mms.domains, holder)
  const create = opts.createMonitor ?? ((limits: MemoryThresholds) => new MemoryMonitor({
    homeDir: opts.homeDir,
    version: opts.version,
    thresholds: limits,
    readCounts: () => readServiceCounts(profiles(), () => opts.protocolServer.replayEventCount()),
    readReplayBytes: () => opts.protocolServer.replayBytes(),
    onNotice: (notice) => opts.protocolServer.emitInstallationEvent(MEMORY_NOTICE_EVENT, notice)
  }))

  let started = false
  let stopped = false
  const turnOff = (announce: boolean): void => {
    const monitor = holder.monitor
    if (!monitor) return
    monitor.stop()
    holder.monitor = null
    if (announce) opts.protocolServer.emitInstallationEvent(PROFILER_STATE_EVENT, { enabled: false })
  }
  const refresh = (firstDelayMs = 2_000): void => {
    if (!started || stopped) return
    const wanted = profilerWanted(profiles())
    if (wanted && !holder.monitor) {
      const monitor = create(thresholds)
      holder.monitor = monitor
      monitor.start(firstDelayMs)
      opts.protocolServer.emitInstallationEvent(PROFILER_STATE_EVENT, { enabled: true })
    } else if (!wanted) {
      turnOff(true)
    }
  }
  const offSettings = onSettingsSaved(() => refresh())
  // A profile archived or removed is gone from the live list: if it was the last with the profiler on, it stops.
  const offDisposed = opts.mms.domains.onProfileDisposed(() => refresh())

  const service: ProfilerService = {
    monitor: () => holder.monitor,
    collectApp: (windows, timeoutMs = 3_000) => {
      if (!holder.monitor) return Promise.resolve(false)
      const requestId = randomUUID()
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId)
          resolve(false)
        }, timeoutMs)
        timer.unref?.()
        waiting.set(requestId, (answered) => {
          clearTimeout(timer)
          resolve(answered)
        })
        opts.protocolServer.emitInstallationEvent(PROFILER_COLLECT_EVENT, { requestId, windows })
      })
    },
    threads: (owner) => readThreadMemory(profiles(), owner),
    activeTurns,
    heapSummary: (top) => takeHeapSummary(opts.homeDir, top),
    refresh: () => refresh()
  }
  setProfilerService(service)
  return {
    // The first sample comes 10 s after the service starts, as before; 2 s after a person turns the profiler on.
    start: () => {
      started = true
      refresh(10_000)
    },
    stop: () => {
      stopped = true
      offSettings()
      offDisposed()
      offClosed()
      turnOff(false)
      for (const done of waiting.values()) done(false)
      waiting.clear()
      setProfilerService(null)
    },
    refresh: () => refresh()
  }
}
