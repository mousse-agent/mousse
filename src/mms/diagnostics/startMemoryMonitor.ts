/**
 * Wires the memory monitor into the running service (the daemon entry, `service run`, only): the counts come from
 * every live profile, the thread database workers and the protocol server's replay buffers.
 */
import type { MousseMainService } from '../MousseMainService'
import type { MmsProfileServices } from '../MmsProfileServices'
import type { MmsProtocolServer } from '../protocol/server'
import { existingThreadDbClient } from '../data/threadDb/threadDbClient'
import { DEFAULT_MEMORY_THRESHOLDS, MEMORY_THRESHOLDS_ENV, isPackagedRuntime, resolveMemoryThresholds, toMb } from '../../shared/diagnostics/memory'
import { writeHeapSnapshotFile } from './heapSnapshot'
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
      profiles: profiles.length,
      activeTurns
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
  packaged?: boolean
}): { start: () => void; stop: () => void } | null {
  const env = opts.env ?? process.env
  if (env[MEMORY_THRESHOLDS_ENV] === 'off' || !opts.mms.domains) return null
  const profiles = () => opts.mms.getInstallationHost()?.liveServices() ?? [opts.mms]
  const holder: MemoryMonitorHolder = {
    monitor: null,
    activeTurns: () => profiles().reduce((sum, services) => sum + services.orchestrator.activeTurnCount(), 0),
    writeHeapSnapshot: () => writeHeapSnapshotFile(opts.homeDir)
  }
  const offClosed = registerMemoryDiagnosticsMethods(opts.mms.domains, holder)
  const monitor = new MemoryMonitor({
    homeDir: opts.homeDir,
    version: opts.version,
    thresholds: resolveMemoryThresholds(env[MEMORY_THRESHOLDS_ENV], DEFAULT_MEMORY_THRESHOLDS, { packaged: opts.packaged ?? isPackagedRuntime() }),
    readCounts: () => readServiceCounts(profiles(), () => opts.protocolServer.replayEventCount()),
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
