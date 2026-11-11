/**
 * Wires the memory monitor into the running service (the daemon entry, `service run`, only): the counts come from
 * every live profile, the thread database workers and the protocol server's replay buffers.
 */
import type { MousseMainService } from '../MousseMainService'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { MmsProtocolServer } from '../protocol/server'
import { existingThreadDbClient } from '../data/threadDb/threadDbClient'
import { MEMORY_THRESHOLDS_ENV, resolveMemoryThresholds, toMb } from '../../shared/diagnostics/memory'
import { MemoryMonitor, type ServiceCountsReading } from './MemoryMonitor'
import { liveFileWatchers } from './liveCounts'
import { MEMORY_NOTICE_EVENT, registerMemoryDiagnosticsMethods, type MemoryMonitorHolder } from './memoryDomain'

/** Counts summed over `profiles`. Each read is a map size or a short list; nothing is loaded. */
export async function readServiceCounts(profiles: MmsProfileServices[], replayEvents: () => number): Promise<ServiceCountsReading> {
  let loadedThreads = 0
  let threadRuntimes = 0
  let threadCacheThreads = 0
  let threadCacheBytes = 0
  let ptys = 0
  for (const services of profiles) {
    loadedThreads += services.orchestrator.loadedSessionCount()
    threadRuntimes += services.threadRuntimes.runtimeCount()
    const cache = services.threads.threadDbCacheStats()
    threadCacheThreads += cache.threads
    threadCacheBytes += cache.bytes
    ptys += services.ptyManager.list().length
  }
  const db = (await existingThreadDbClient()?.diagnostics()) ?? { workers: 0, connections: 0, workerHeaps: [] }
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
      profiles: profiles.length
    },
    workerHeaps: db.workerHeaps
  }
}

/** Registers the methods (before the protocol server starts) and returns a starter for after it has. */
export function prepareMemoryMonitor(opts: {
  mms: MousseMainService
  protocolServer: MmsProtocolServer
  homeDir: string
  version: string
  env?: NodeJS.ProcessEnv
}): { start: () => void; stop: () => void } | null {
  const env = opts.env ?? process.env
  if (env[MEMORY_THRESHOLDS_ENV] === 'off' || !opts.mms.domains) return null
  const holder: MemoryMonitorHolder = { monitor: null }
  const offClosed = registerMemoryDiagnosticsMethods(opts.mms.domains, holder)
  const monitor = new MemoryMonitor({
    homeDir: opts.homeDir,
    version: opts.version,
    thresholds: resolveMemoryThresholds(env[MEMORY_THRESHOLDS_ENV]),
    readCounts: () => readServiceCounts(opts.mms.getInstallationHost()?.liveServices() ?? [opts.mms], () => opts.protocolServer.replayEventCount()),
    readReplayBytes: () => opts.protocolServer.replayBytes(),
    onNotice: (notice) => opts.protocolServer.emitInstallationEvent(MEMORY_NOTICE_EVENT, notice)
  })
  holder.monitor = monitor
  return {
    start: () => monitor.start(),
    stop: () => {
      offClosed()
      monitor.stop()
      holder.monitor = null
    }
  }
}
