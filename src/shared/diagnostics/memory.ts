/**
 * Memory monitor: what the service samples about its own memory, the limits it checks, and the issue text a person
 * may choose to file. Everything here is numbers and fixed names. No path, thread, project or user name ever enters
 * a sample, so nothing personal can reach the log or the report. Pure functions only; the service's sampler is
 * `src/mms/diagnostics/MemoryMonitor.ts`.
 */

/** Where the service keeps its memory log, relative to the Mousse home. */
export const MEMORY_LOG_RELATIVE_PATH = 'diagnostics/memory.jsonl'
export const MEMORY_ISSUE_REPO = 'mousse-agent/mousse'

/** One process's memory, in MB with one decimal. `private` is the OS's private bytes when the OS reports them. */
export interface ProcessMemory {
  rss: number
  private?: number
  heapUsed?: number
  heapTotal?: number
  external?: number
  arrayBuffers?: number
}

export type AppProcessKind = 'main' | 'window' | 'gpu' | 'utility' | 'other'

/** A process of the desktop app, as its main process reports it. */
export interface AppProcessMemory extends ProcessMemory {
  kind: AppProcessKind
}

/** Counts read in the service. `null` when a count could not be read this time. */
export interface ServiceCounts {
  sqliteConnections: number | null
  workerThreads: number
  loadedThreads: number
  threadRuntimes: number
  threadCacheThreads: number
  threadCacheMb: number
  replayEvents: number
  ptys: number
  fileWatchers: number
  providerProcesses: number
  profiles: number
}

export type CountName = Exclude<keyof ServiceCounts, 'threadCacheMb' | 'profiles'>

/** A provider or tool process the service started, by kind (`claude`, `codex`, `mcp`...), and its memory in MB. */
export interface ChildMemory {
  kind: string
  mb: number | null
}

export interface MemorySample {
  /** Epoch ms. */
  t: number
  /** Service uptime in seconds; samples of one service run share `t - up * 1000`. */
  up: number
  service: ProcessMemory
  counts: ServiceCounts
  /** Heap used by each worker thread of the service, MB. */
  workers?: number[]
  /** Measured every few samples, and on a breach. */
  children?: ChildMemory[]
  /** The desktop app's processes, when the app reported in the last few minutes. */
  app?: AppProcessMemory[]
  /** The replay buffer's approximate size, MB; measured every few samples. */
  replayMb?: number
}

/** The full breakdown, kept in memory and written to the log on a breach. */
export interface MemoryDetail {
  heapSpaces: Record<string, number>
  heap: {
    totalHeapSize: number
    usedHeapSize: number
    heapSizeLimit: number
    mallocedMemory: number
    externalMemory: number
    nativeContexts: number
    detachedContexts: number
  }
}

export type BreachKind = 'service-high' | 'service-growth' | 'app-high' | 'counts'

export interface MemoryBreach {
  kind: BreachKind
  /** One short line of numbers, for the notice's tooltip and the report. */
  summary: string
  severe?: boolean
}

export interface MemoryNotice {
  kind: BreachKind
  summary: string
  at: number
}

export interface MemoryTrendPoint {
  t: number
  service: number
  app: number | null
}

/** What `diagnostics.memory.status` returns. */
export interface MemoryStatus {
  sample: MemorySample | null
  detail: MemoryDetail | null
  trend: MemoryTrendPoint[]
  growthMbPerHour: number | null
  breaches: MemoryBreach[]
  notice: MemoryNotice | null
  logFile: string
}

export interface MemoryIssue {
  title: string
  body: string
  url: string
}

export interface MemoryThresholds {
  sampleIntervalMs: number
  /** The service's private memory (RSS where the OS gives none) above this, for `serviceSustainMinutes`. */
  servicePrivateMb: number
  serviceSustainMinutes: number
  /** Sustained above this is severe: one local V8 heap snapshot a day. */
  serviceSevereMb: number
  /** Growth of the service's memory over the last `growthWindowHours`, in one run of the service. */
  growthMbPerHour: number
  growthWindowHours: number
  /** No growth breach while the service is still below this. */
  growthFloorMb: number
  /** The app's processes together, or any one window, above these for `appSustainMinutes`. */
  appPrivateMb: number
  windowPrivateMb: number
  appSustainMinutes: number
  /** A count above its bound for this many samples in a row. */
  countSustainSamples: number
  counts: Record<CountName, number>
}

/**
 * The limits. An empty service measures about 130 MB private and a busy one stays under 300 MB, so these leave room
 * for real use and catch what is clearly wrong. Change them here.
 */
export const DEFAULT_MEMORY_THRESHOLDS: MemoryThresholds = {
  sampleIntervalMs: 60_000,
  servicePrivateMb: 600,
  serviceSustainMinutes: 15,
  serviceSevereMb: 1_200,
  growthMbPerHour: 40,
  growthWindowHours: 3,
  growthFloorMb: 300,
  appPrivateMb: 2_500,
  windowPrivateMb: 1_200,
  appSustainMinutes: 15,
  countSustainSamples: 3,
  counts: {
    // Four thread database workers at most (write, read, index, import), each closing idle connections.
    sqliteConnections: 48,
    workerThreads: 6,
    // Idle threads are released after 10 minutes, and past 8 the oldest goes after a minute (ThreadResidency).
    loadedThreads: 40,
    threadRuntimes: 400,
    threadCacheThreads: 64,
    replayEvents: 4_096,
    ptys: 32,
    fileWatchers: 32,
    providerProcesses: 24
  }
}

/** The environment variable that overrides limits, as JSON, for testing: `{"servicePrivateMb":50,"serviceSustainMinutes":0}`. */
export const MEMORY_THRESHOLDS_ENV = 'MOUSSE_MEMORY_MONITOR'

/** Limits with the numeric fields of `override` (a JSON string or object) put over the defaults; anything else is ignored. */
export function resolveMemoryThresholds(override?: string | Record<string, unknown> | null, base: MemoryThresholds = DEFAULT_MEMORY_THRESHOLDS): MemoryThresholds {
  let raw: unknown = override
  if (typeof override === 'string') {
    try { raw = JSON.parse(override) } catch { raw = null }
  }
  const next: MemoryThresholds = { ...base, counts: { ...base.counts } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return next
  const value = raw as Record<string, unknown>
  for (const key of Object.keys(base) as (keyof MemoryThresholds)[]) {
    if (key === 'counts') continue
    const n = value[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) (next as unknown as Record<string, number>)[key] = n
  }
  if (value.sampleIntervalMs !== undefined) next.sampleIntervalMs = Math.max(1_000, next.sampleIntervalMs)
  const counts = value.counts
  if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
    for (const key of Object.keys(base.counts) as CountName[]) {
      const n = (counts as Record<string, unknown>)[key]
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) next.counts[key] = n
    }
  }
  return next
}

export function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

/** The number the service is judged by: private bytes where the OS reports them, else RSS. */
export function serviceMb(sample: MemorySample): number {
  return sample.service.private ?? sample.service.rss
}

/** The app's processes together, or null when the app has not reported. */
export function appMb(sample: MemorySample): number | null {
  if (!sample.app?.length) return null
  return round1(sample.app.reduce((sum, process) => sum + (process.private ?? process.rss), 0))
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** When this sample's service run started, to the second. */
function runStart(sample: MemorySample): number {
  return Math.round((sample.t - sample.up * 1000) / 1000)
}

/**
 * The samples of the last `minutes`, when they cover the whole span and all pass `test`; otherwise null. A single
 * high sample (a spike) is never enough unless the span is zero. History is oldest first.
 */
function sustained(history: MemorySample[], minutes: number, intervalMs: number, now: number, test: (sample: MemorySample) => boolean): MemorySample[] | null {
  if (!history.length) return null
  const latest = history[history.length - 1]
  if (minutes <= 0) return test(latest) ? [latest] : null
  const start = now - minutes * 60_000
  const slack = Math.max(intervalMs * 1.5, 1_000)
  const window = history.filter((sample) => sample.t >= start - slack && runStart(sample) === runStart(latest))
  if (!window.length || window[0].t > start + slack) return null
  return window.every(test) ? window : null
}

/** MB per hour the service grew over the growth window, in its current run, or null without enough history. */
export function serviceGrowthMbPerHour(history: MemorySample[], thresholds: MemoryThresholds, now: number): number | null {
  if (history.length < 4) return null
  const latest = history[history.length - 1]
  const windowMs = thresholds.growthWindowHours * 3_600_000
  const run = history.filter((sample) => sample.t >= now - windowMs && runStart(sample) === runStart(latest))
  if (run.length < 4) return null
  const span = run[run.length - 1].t - run[0].t
  if (span < windowMs * 0.9) return null
  // The medians of the first and last quarter (at most 15 minutes each), so one spike moves neither end.
  const edge = Math.min(15 * 60_000, windowMs / 4)
  const head = run.filter((sample) => sample.t <= run[0].t + edge)
  const tail = run.filter((sample) => sample.t >= latest.t - edge)
  const hours = (median(tail.map((s) => s.t)) - median(head.map((s) => s.t))) / 3_600_000
  if (hours <= 0) return null
  return round1((median(tail.map(serviceMb)) - median(head.map(serviceMb))) / hours)
}

const COUNT_LABELS: Record<CountName, string> = {
  sqliteConnections: 'SQLite connections',
  workerThreads: 'worker threads',
  loadedThreads: 'loaded threads',
  threadRuntimes: 'thread runtimes',
  threadCacheThreads: 'cached threads',
  replayEvents: 'replay events',
  ptys: 'terminals',
  fileWatchers: 'file watchers',
  providerProcesses: 'provider processes'
}

/** Every limit the history breaks now. History is oldest first; `now` is the latest sample's time or later. */
export function detectBreaches(history: MemorySample[], thresholds: MemoryThresholds, now: number): MemoryBreach[] {
  const breaches: MemoryBreach[] = []
  const latest = history[history.length - 1]
  if (!latest) return breaches
  const interval = thresholds.sampleIntervalMs

  const high = sustained(history, thresholds.serviceSustainMinutes, interval, now, (s) => serviceMb(s) > thresholds.servicePrivateMb)
  if (high) {
    const severe = high.every((s) => serviceMb(s) > thresholds.serviceSevereMb)
    breaches.push({
      kind: 'service-high',
      summary: `Service ${Math.round(serviceMb(latest))} MB, above ${thresholds.servicePrivateMb} MB for ${thresholds.serviceSustainMinutes} min`,
      ...(severe ? { severe: true } : {})
    })
  }

  const growth = serviceGrowthMbPerHour(history, thresholds, now)
  if (growth !== null && growth >= thresholds.growthMbPerHour && serviceMb(latest) >= thresholds.growthFloorMb) {
    breaches.push({
      kind: 'service-growth',
      summary: `Service grew ${Math.round(growth)} MB/h over ${thresholds.growthWindowHours} h, now ${Math.round(serviceMb(latest))} MB`
    })
  }

  const appHigh = sustained(history, thresholds.appSustainMinutes, interval, now, (s) => {
    const total = appMb(s)
    if (total === null) return false
    return total > thresholds.appPrivateMb || Boolean(s.app?.some((p) => p.kind === 'window' && (p.private ?? p.rss) > thresholds.windowPrivateMb))
  })
  if (appHigh) {
    const largestWindow = Math.max(0, ...(latest.app ?? []).filter((p) => p.kind === 'window').map((p) => p.private ?? p.rss))
    breaches.push({
      kind: 'app-high',
      summary: `App ${Math.round(appMb(latest) ?? 0)} MB (largest window ${Math.round(largestWindow)} MB) for ${thresholds.appSustainMinutes} min`
    })
  }

  const over: string[] = []
  const recent = history.slice(-Math.max(1, thresholds.countSustainSamples))
  if (recent.length >= Math.max(1, thresholds.countSustainSamples)) {
    for (const name of Object.keys(thresholds.counts) as CountName[]) {
      const limit = thresholds.counts[name]
      if (recent.every((s) => (s.counts[name] ?? 0) > limit)) over.push(`${COUNT_LABELS[name]} ${latest.counts[name]} (bound ${limit})`)
    }
  }
  if (over.length) breaches.push({ kind: 'counts', summary: `Above bound: ${over.join(', ')}` })
  return breaches
}

export const NOTICE_EVERY_MS = 24 * 3_600_000

/** Whether a notice of `kind` may show now: at most one a day for each kind. */
export function noticeDue(shownAt: Partial<Record<BreachKind, number>>, kind: BreachKind, now: number): boolean {
  const last = shownAt[kind]
  return last === undefined || !Number.isFinite(last) || now - last >= NOTICE_EVERY_MS || now < last
}

/** Service and app memory every `stepMs`, from oldest to newest (the last sample in each step). */
export function memoryTrend(history: MemorySample[], stepMs: number): MemoryTrendPoint[] {
  const points: MemoryTrendPoint[] = []
  let bucket = Number.NaN
  for (const sample of history) {
    const b = Math.floor(sample.t / stepMs)
    const point = { t: sample.t, service: serviceMb(sample), app: appMb(sample) }
    if (b === bucket) points[points.length - 1] = point
    else points.push(point)
    bucket = b
  }
  return points
}

export interface MemoryReportInput {
  version: string
  os: { platform: string; release: string; arch: string; totalMemMb: number }
  sample: MemorySample
  detail?: MemoryDetail | null
  history: MemorySample[]
  breaches: MemoryBreach[]
  thresholds: MemoryThresholds
}

/** Only characters a version or OS release uses; anything else becomes `?`. */
function plain(value: string, max = 40): string {
  return value.replace(/[^0-9A-Za-z.+_ -]/g, '?').slice(0, max)
}

/** A fixed name (`claude`, `old_space`); anything that is not one, such as a path, becomes `other`. */
function kindName(value: string): string {
  return /^[a-z][a-z0-9_-]{0,39}$/.test(value) ? value : 'other'
}

function mb(n: number | undefined | null): string {
  return n === undefined || n === null ? '-' : String(round1(n))
}

const APP_LABELS: Record<AppProcessKind, string> = { main: 'App main', window: 'Window', gpu: 'GPU', utility: 'Utility', other: 'Other' }

/** The issue's title and body: numbers, fixed names, the version and the OS. Nothing a person typed or named. */
export function memoryIssueText(input: MemoryReportInput): { title: string; body: string } {
  const { sample, detail, breaches, thresholds } = input
  const first = breaches[0]
  const title = first ? `Memory: ${first.summary}` : `Memory report: service ${Math.round(serviceMb(sample))} MB`
  const lines: string[] = []
  lines.push(`**Version:** ${plain(input.version) || 'unknown'}`)
  lines.push(`**OS:** ${plain(input.os.platform, 16)} ${plain(input.os.release)} ${plain(input.os.arch, 16)}, ${Math.round(input.os.totalMemMb / 1024)} GB RAM`)
  lines.push(`**Service uptime:** ${round1(sample.up / 3600)} h`)
  if (breaches.length) {
    lines.push('', '**Out of bounds:**')
    for (const breach of breaches) lines.push(`- ${breach.kind}${breach.severe ? ' (severe)' : ''}: ${breach.summary}`)
  }
  lines.push('', '| Process | Private MB | RSS MB | Heap used MB | Heap total MB | External MB |', '|---|---|---|---|---|---|')
  const row = (name: string, p: ProcessMemory) => `| ${name} | ${mb(p.private)} | ${mb(p.rss)} | ${mb(p.heapUsed)} | ${mb(p.heapTotal)} | ${mb(p.external)} |`
  lines.push(row('Service', sample.service))
  const windowCount = new Map<AppProcessKind, number>()
  for (const process of sample.app ?? []) {
    const n = (windowCount.get(process.kind) ?? 0) + 1
    windowCount.set(process.kind, n)
    lines.push(row(`${APP_LABELS[process.kind] ?? 'Other'}${process.kind === 'main' ? '' : ` ${n}`}`, process))
  }
  if (sample.workers?.length) lines.push(`| Service workers (${sample.workers.length}) | - | - | ${sample.workers.map(mb).join(' / ')} | - | - |`)

  const c = sample.counts
  lines.push('', `**Service counts:** SQLite connections ${c.sqliteConnections ?? '-'}, worker threads ${c.workerThreads}, loaded threads ${c.loadedThreads}, thread runtimes ${c.threadRuntimes}, thread cache ${c.threadCacheThreads} (${mb(c.threadCacheMb)} MB), replay buffer ${c.replayEvents} events${sample.replayMb !== undefined ? ` (${mb(sample.replayMb)} MB)` : ''}, terminals ${c.ptys}, file watchers ${c.fileWatchers}, provider processes ${c.providerProcesses}, profiles ${c.profiles}`)
  if (sample.children?.length) {
    lines.push(`**Provider processes (MB):** ${sample.children.map((child) => `${kindName(child.kind)} ${mb(child.mb)}`).join(', ')}`)
  }
  if (detail) {
    const spaces = Object.entries(detail.heapSpaces).filter(([, size]) => size >= 0.1).map(([name, size]) => `${kindName(name)} ${mb(size)}`)
    lines.push(`**Service V8 heap (MB):** used ${mb(detail.heap.usedHeapSize)} of ${mb(detail.heap.totalHeapSize)}, limit ${mb(detail.heap.heapSizeLimit)}, malloced ${mb(detail.heap.mallocedMemory)}, external ${mb(detail.heap.externalMemory)}, contexts ${detail.heap.nativeContexts} (${detail.heap.detachedContexts} detached)`)
    if (spaces.length) lines.push(`**Heap spaces (MB):** ${spaces.join(', ')}`)
  }
  const trend = memoryTrend(input.history, 30 * 60_000).slice(-12)
  if (trend.length > 1) {
    lines.push(`**Service MB every 30 min:** ${trend.map((point) => Math.round(point.service)).join(', ')}`)
  }
  const growth = serviceGrowthMbPerHour(input.history, thresholds, sample.t)
  if (growth !== null) lines.push(`**Growth:** ${growth} MB/h over ${thresholds.growthWindowHours} h`)
  lines.push('', `_Limits: service ${thresholds.servicePrivateMb} MB for ${thresholds.serviceSustainMinutes} min, growth ${thresholds.growthMbPerHour} MB/h. Numbers only: no paths, names or thread content._`)
  return { title: title.slice(0, 200), body: lines.join('\n') }
}

/** GitHub keeps a prefilled issue link working up to about 8 KB. */
const MAX_ISSUE_URL = 7_500

/** The new-issue page with the text filled in. Nothing is sent until the person submits it there. */
export function memoryIssueUrl(title: string, body: string): string {
  const base = `https://github.com/${MEMORY_ISSUE_REPO}/issues/new`
  let text = body
  let url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`
  // Too long: drop the least useful lines from the end until it fits.
  while (url.length > MAX_ISSUE_URL && text.includes('\n')) {
    text = text.slice(0, text.lastIndexOf('\n'))
    url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`
  }
  return url
}

export function memoryIssue(input: MemoryReportInput): MemoryIssue {
  const { title, body } = memoryIssueText(input)
  return { title, body, url: memoryIssueUrl(title, body) }
}
