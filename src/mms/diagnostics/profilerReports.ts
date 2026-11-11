/**
 * What the profiler's agent tools return, built from the monitor's samples: numbers and fixed names only, as in the
 * memory log. A thread is named by its id only, and only when it is a thread of the caller's own profile; other
 * profiles count only in totals. Pure, so each shape is tested without a service.
 */
import {
  appMb,
  largestOfKind,
  memoryTable,
  serviceMb,
  type AppHints,
  type ChildMemory,
  type MemoryDetail,
  type MemorySample,
  type MemoryStatus,
  type MemoryThresholds,
  type ServiceCounts
} from '../../shared/diagnostics/memory'
import type { AppViewInfo, WindowCounters } from '../../shared/diagnostics/profiler'
import type { AppWindowDetail } from './MemoryMonitor'
import type { ThreadMemory } from './profilerService'

const UNITS = 'MB is private memory where the OS reports it, else the working set. CPU is percent of one core since the previous sample.'

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/** A fixed name (`claude`, `old_space`); anything else, such as a path, becomes `other`. */
function fixedName(value: string): string {
  return /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : 'other'
}

function processRows(sample: MemorySample) {
  return memoryTable(sample).map((row) => ({
    label: row.label,
    group: row.group,
    ...(row.private !== undefined ? { privateMb: row.private } : {}),
    ...(row.rss !== undefined ? { workingSetMb: row.rss } : {}),
    ...(row.cpu !== undefined ? { cpuPercent: row.cpu } : {}),
    ...(row.heapUsed !== undefined ? { heapUsedMb: row.heapUsed } : {}),
    ...(row.heapTotal !== undefined ? { heapTotalMb: row.heapTotal } : {})
  }))
}

/** `profiler_overview`. */
export function overviewReport(status: MemoryStatus, thresholds: MemoryThresholds, now: number) {
  const sample = status.sample
  if (!sample) return { profiler: 'on', sample: null, note: 'No sample yet. Call profiler_sample_now.' }
  const service = serviceMb(sample)
  const trend = status.trend.slice(-24)
  const stepMinutes = trend.length > 1 ? Math.round((trend[trend.length - 1].t - trend[0].t) / (trend.length - 1) / 60_000) : null
  return {
    profiler: 'on',
    sampledSecondsAgo: Math.max(0, Math.round((now - sample.t) / 1000)),
    serviceUptimeMinutes: Math.round(sample.up / 60),
    activeTurns: sample.counts.activeTurns,
    processes: processRows(sample),
    service: {
      mb: service,
      baselineMb: status.baselineMb,
      timesBaseline: status.baselineMb ? r1(service / status.baselineMb) : null,
      growthMbPerHour: status.growthMbPerHour,
      limits: { idleMb: thresholds.servicePrivateMb, severeMb: thresholds.serviceSevereMb, baselineFactor: thresholds.serviceBaselineFactor }
    },
    app: { totalMb: appMb(sample), gpuMb: largestOfKind(sample, 'gpu'), largestWindowMb: largestOfKind(sample, 'renderer') },
    trend: {
      everyMinutes: stepMinutes,
      serviceMb: trend.map((p) => Math.round(p.service)),
      appMb: trend.map((p) => (p.app === null ? null : Math.round(p.app))),
      gpuMb: trend.map((p) => (p.gpu === null ? null : Math.round(p.gpu)))
    },
    breaches: status.breaches.map((b) => ({ kind: b.kind, summary: b.summary, ...(b.severe ? { severe: true } : {}) })),
    units: UNITS
  }
}

const MAX_THREADS = 50

/** `profiler_service_breakdown`. */
export function serviceBreakdownReport(input: {
  sample: MemorySample
  detail: MemoryDetail
  thresholds: MemoryThresholds
  threads: ThreadMemory
  cacheLimits: { threads: number; mb: number }
  replayLimitPerProfile: number
}) {
  const { sample, detail, thresholds } = input
  const c: ServiceCounts = sample.counts
  const others = input.threads.others
  const threads = [...input.threads.own].sort((a, b) => (b.cachedBytes ?? -1) - (a.cachedBytes ?? -1) || Number(b.loaded) - Number(a.loaded))
  return {
    service: { mb: serviceMb(sample), workingSetMb: sample.service.rss, ...(sample.service.cpu !== undefined ? { cpuPercent: sample.service.cpu } : {}) },
    heap: {
      usedMb: detail.heap.usedHeapSize,
      totalMb: detail.heap.totalHeapSize,
      limitMb: detail.heap.heapSizeLimit,
      mallocedMb: detail.heap.mallocedMemory,
      externalMb: detail.heap.externalMemory,
      nativeContexts: detail.heap.nativeContexts,
      detachedContexts: detail.heap.detachedContexts
    },
    heapSpacesMb: Object.fromEntries(Object.entries(detail.heapSpaces).map(([name, size]) => [fixedName(name), size])),
    workerHeapsMb: sample.workers ?? [],
    counts: {
      loadedThreads: c.loadedThreads,
      cachedThreads: c.threadCacheThreads,
      threadRuntimes: c.threadRuntimes,
      workerThreads: c.workerThreads,
      sqliteConnections: c.sqliteConnections,
      replayEvents: c.replayEvents,
      terminals: c.ptys,
      fileWatchers: c.fileWatchers,
      childProcesses: c.providerProcesses,
      profiles: c.profiles,
      activeTurns: c.activeTurns
    },
    bounds: { ...thresholds.counts },
    caches: {
      threadDatabase: { threads: c.threadCacheThreads, mb: c.threadCacheMb, maxThreads: input.cacheLimits.threads, maxMb: input.cacheLimits.mb },
      replayBuffer: { events: c.replayEvents, mb: sample.replayMb ?? null, maxEventsPerProfile: input.replayLimitPerProfile }
    },
    threads: threads.slice(0, MAX_THREADS).map((entry) => ({
      threadId: entry.threadId ?? null,
      loaded: entry.loaded,
      cached: entry.cached,
      turnRunning: entry.turnRunning,
      cachedMb: entry.cachedBytes === null ? null : r1(entry.cachedBytes / 1048576),
      idleMinutes: entry.idleSeconds === null ? null : Math.round(entry.idleSeconds / 60)
    })),
    threadsNotListed: Math.max(0, threads.length - MAX_THREADS),
    otherProfiles: { profiles: others.profiles, loadedThreads: others.loadedThreads, cachedThreads: others.cachedThreads, cachedMb: r1(others.cachedBytes / 1048576) },
    bytes:
      'cachedMb is measured: the serialized size of the rows and state the thread database cache holds for the thread. Its objects on the heap take roughly 2 to 3 times that (an estimate). A loaded thread with no cache entry has no measured size.'
  }
}

function windowEntry(w: WindowCounters, index: number) {
  const { w: width, h, scale, visible, ...counters } = w
  return {
    window: index + 1,
    ...(width !== undefined && h !== undefined ? { size: { w: width, h, scale: scale ?? 1, visible: visible ?? true } } : {}),
    ...counters
  }
}

/** `profiler_window_breakdown`. `detail` is null when no desktop app answered. */
export function windowBreakdownReport(detail: AppWindowDetail | null, sample: MemorySample | null, now: number) {
  if (!detail) return { app: null, note: 'No desktop app answered. Open Mousse and call again.' }
  const windowRows = (sample?.app ?? []).filter((p) => p.role === 'window')
  return {
    reportedSecondsAgo: Math.max(0, Math.round((now - detail.at) / 1000)),
    windows: detail.windows.map(windowEntry),
    windowProcessesMb: windowRows.map((p) => p.private ?? p.rss),
    views: viewSummary(detail.views),
    estimates: 'imagesDecodedMbEstimated and canvasMbEstimated assume 4 bytes a pixel. imageCacheMb and the JS heap are measured.'
  }
}

function viewSummary(views: readonly AppViewInfo[]) {
  const of = (role: AppViewInfo['role']) => views.filter((v) => v.role === role).map(({ w, h, visible }) => ({ w, h, visible }))
  return { applet: of('applet'), browser: of('browser') }
}

/** `profiler_gpu_hints`. */
export function gpuHintsReport(sample: MemorySample, detail: AppWindowDetail | null) {
  const gpu = (sample.app ?? []).find((p) => p.role === 'gpu' || p.kind === 'gpu')
  const hints: AppHints | undefined = sample.hints
  return {
    gpu: gpu ? { privateMb: gpu.private ?? null, workingSetMb: gpu.rss, ...(gpu.cpu !== undefined ? { cpuPercent: gpu.cpu } : {}) } : null,
    hints: hints
      ? {
          windows: hints.windows,
          surfaceMb: hints.surfaceMb,
          acrylic: hints.acrylic,
          webglContexts: hints.webglContexts,
          canvases: hints.canvases,
          views: hints.views,
          ...(hints.imagesMb !== undefined ? { decodedImagesMb: hints.imagesMb } : {})
        }
      : null,
    viewSizes: detail ? viewSummary(detail.views) : null,
    note: 'surfaceMb is the shown windows\' pixels at 4 bytes each: about one frame buffer each. Acrylic, WebGL contexts and large views each add GPU memory.'
  }
}

/** `profiler_children`. */
export function childrenReport(children: readonly ChildMemory[]) {
  const byKind = new Map<string, { count: number; mb: number }>()
  for (const child of children) {
    const kind = fixedName(child.kind)
    const entry = byKind.get(kind) ?? { count: 0, mb: 0 }
    entry.count += 1
    entry.mb += child.mb ?? 0
    byKind.set(kind, entry)
  }
  return {
    processes: children.map((child) => ({ kind: fixedName(child.kind), mb: child.mb })),
    byKind: [...byKind].map(([kind, entry]) => ({ kind, count: entry.count, mb: r1(entry.mb) })).sort((a, b) => b.mb - a.mb),
    totalMb: r1(children.reduce((sum, child) => sum + (child.mb ?? 0), 0)),
    note: 'mb is each process\'s working set as the OS lists it; null when it could not be read.'
  }
}

/** A sample's headline numbers, for `profiler_sample_now` and each point of `profiler_watch`. */
export function samplePoint(sample: MemorySample) {
  const c = sample.counts
  return {
    serviceMb: serviceMb(sample),
    serviceHeapMb: sample.service.heapUsed ?? null,
    ...(sample.service.cpu !== undefined ? { serviceCpuPercent: sample.service.cpu } : {}),
    appMb: appMb(sample),
    gpuMb: largestOfKind(sample, 'gpu'),
    largestWindowMb: largestOfKind(sample, 'renderer'),
    loadedThreads: c.loadedThreads,
    cachedThreads: c.threadCacheThreads,
    threadCacheMb: c.threadCacheMb,
    replayEvents: c.replayEvents,
    terminals: c.ptys,
    childProcesses: c.providerProcesses,
    workerThreads: c.workerThreads,
    activeTurns: c.activeTurns
  }
}

type Point = ReturnType<typeof samplePoint>

/** What changed between two points: each number that moved, as `to - from`. */
export function pointChange(from: Point, to: Point): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(to) as (keyof Point)[]) {
    const a = from[key]
    const b = to[key]
    if (typeof a === 'number' && typeof b === 'number' && a !== b) out[key] = r1(b - a)
  }
  return out
}

/** `profiler_sample_now`. */
export function sampleNowReport(sample: MemorySample, previous: MemorySample | null) {
  const point = samplePoint(sample)
  return {
    now: point,
    processes: processRows(sample),
    ...(previous ? { sincePreviousSample: { seconds: Math.round((sample.t - previous.t) / 1000), change: pointChange(samplePoint(previous), point) } } : {}),
    units: UNITS
  }
}

export const WATCH_LIMITS = { minIntervalSeconds: 5, maxIntervalSeconds: 60, maxMinutes: 10, maxPoints: 120 } as const

/** The watch's interval and point count, held to the limits. */
export function watchPlan(intervalSeconds: unknown, minutes: unknown): { intervalSeconds: number; points: number } {
  const interval = typeof intervalSeconds === 'number' && Number.isFinite(intervalSeconds) ? intervalSeconds : 10
  const span = typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : 2
  const every = Math.min(WATCH_LIMITS.maxIntervalSeconds, Math.max(WATCH_LIMITS.minIntervalSeconds, Math.round(interval)))
  const total = Math.min(WATCH_LIMITS.maxMinutes, Math.max(0.5, span)) * 60
  return { intervalSeconds: every, points: Math.min(WATCH_LIMITS.maxPoints, Math.max(2, Math.floor(total / every) + 1)) }
}

/** `profiler_watch`: the points, what changed from first to last, and the numbers that grew most. */
export function watchReport(plan: { intervalSeconds: number }, points: Array<{ atSeconds: number } & Point>, stopped?: string) {
  const first = points[0]
  const last = points[points.length - 1]
  const change = first && last ? pointChange(first, last) : {}
  const { atSeconds: _a, ...changeWithoutTime } = change as Record<string, number>
  const grew = Object.entries(changeWithoutTime).filter(([, by]) => by > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, by]) => ({ name, by }))
  return {
    intervalSeconds: plan.intervalSeconds,
    points,
    change: changeWithoutTime,
    grew,
    ...(stopped ? { stopped } : {}),
    units: UNITS
  }
}
