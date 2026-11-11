/**
 * The service's memory monitor. About once a minute it reads its own memory and counts (a few microseconds of work,
 * with no request to any worker), adds the desktop app's last report, appends one line to
 * `diagnostics/memory.jsonl`, and checks the limits. On a breach it logs the full breakdown and offers one notice a
 * day. It never writes a heap snapshot by itself: that freezes the service and holds what threads contain, so only a
 * person asks for one (`mousse-cli diagnostics memory snapshot`). Nothing leaves the computer: a report is text the
 * person opens in GitHub and submits themselves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { logWarn } from '../log/diag'
import {
  DEFAULT_MEMORY_THRESHOLDS,
  MEMORY_LOG_RELATIVE_PATH,
  detectBreaches,
  memoryIssue,
  memoryTrend,
  noticeDue,
  BASELINE_TO_S,
  serviceBaselineMb,
  serviceGrowthMbPerHour,
  toMb,
  type AppHints,
  type AppProcessMemory,
  type BreachKind,
  type ChildMemory,
  type MemoryBreach,
  type MemoryDetail,
  type MemoryIssue,
  type MemoryNotice,
  type MemorySample,
  type MemoryStatus,
  type MemoryThresholds,
  type ProcessMemory,
  type ServiceCounts
} from '../../shared/diagnostics/memory'
import type { AppViewInfo, WindowCounters } from '../../shared/diagnostics/profiler'
import { MemoryLog } from './memoryLog'
import { readChildMemory, readHeapDetail, sampleOwnProcess } from './processMemory'
import { liveChildProcesses } from './liveCounts'

/** Child memory and the replay buffer's bytes are read on every Nth sample. */
const DETAIL_EVERY = 5
/** History kept in memory for the trend and the growth check. */
const HISTORY_MS = 6 * 3_600_000
/** A breach still going is logged again at most this often. */
const BREACH_RELOG_MS = 3_600_000
/** The app's report counts while it is this many sample intervals old or newer. */
const APP_REPORT_FRESH_INTERVALS = 3
/** The windows' hints change rarely: logged when they change, and at least this often. */
const HINTS_RELOG_MS = 3_600_000

export interface ServiceCountsReading {
  counts: Omit<ServiceCounts, 'providerProcesses'>
  /** Heap used by each service worker, bytes. */
  workerHeaps: number[]
}

export interface MemoryMonitorOptions {
  homeDir: string
  version: string
  thresholds?: MemoryThresholds
  /** Counts from the running services. */
  readCounts: () => Promise<ServiceCountsReading>
  /** The replay buffer's size in bytes; read every few samples. */
  readReplayBytes?: () => number
  /** Called when a notice is due. */
  onNotice?: (notice: MemoryNotice) => void
  now?: () => number
  uptime?: () => number
  sampleProcess?: () => Promise<ProcessMemory>
  readDetail?: () => MemoryDetail
  readChildren?: () => Promise<ChildMemory[]>
  childCount?: () => number
  /** This service run's id; by default its pid and start time. */
  runId?: string
  log?: MemoryLog
  /** The service's CPU time so far (`process.cpuUsage`), for its CPU use between samples. */
  cpuUsage?: () => NodeJS.CpuUsage
}

/** The windows' counters and the app's views from the app's latest report: kept for the profiler's tools, never logged. */
export interface AppWindowDetail {
  at: number
  windows: WindowCounters[]
  views: AppViewInfo[]
}

interface MonitorState {
  /** When a memory notice last showed, of any kind. */
  noticeShownAt?: number
}

const STATE_RELATIVE_PATH = 'diagnostics/memory-state.json'

export class MemoryMonitor {
  readonly thresholds: MemoryThresholds
  private readonly log: MemoryLog
  private readonly now: () => number
  private readonly statePath: string
  private readonly diagnosticsDir: string
  private state: MonitorState
  private history: MemorySample[] = []
  private detail: MemoryDetail | null = null
  private active = new Map<BreachKind, { breach: MemoryBreach; loggedAt: number }>()
  private pending: MemoryNotice | null = null
  private appReports = new Map<string, { at: number; processes: AppProcessMemory[]; hints?: AppHints }>()
  private windowDetail: AppWindowDetail | null = null
  private lastCpu: { usage: NodeJS.CpuUsage; at: number } | null = null
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private running: Promise<void> | null = null
  private lastChildren: ChildMemory[] | undefined
  private lastReplayMb: number | undefined
  private started = false
  private readonly uptime: () => number
  private readonly runId: string
  private loggedHints: { json: string; at: number } | null = null
  /** This run's baseline, kept once minutes 5 to 15 are over: the 6 hours of history do not reach back that far for long. */
  private baseline: { run: string; mb: number | null } | null = null

  constructor(private readonly options: MemoryMonitorOptions) {
    this.thresholds = options.thresholds ?? DEFAULT_MEMORY_THRESHOLDS
    this.log = options.log ?? new MemoryLog(options.homeDir)
    this.now = options.now ?? Date.now
    this.uptime = options.uptime ?? process.uptime
    // Once, so every sample of this run carries the same id however long a sample's awaits take.
    this.runId = options.runId ?? `${process.pid}-${Math.round(this.now() - this.uptime() * 1000)}`
    this.diagnosticsDir = join(options.homeDir, 'diagnostics')
    this.statePath = join(options.homeDir, STATE_RELATIVE_PATH)
    this.state = this.loadState()
  }

  /** Starts sampling: the first sample a few seconds after start, then every interval. The timer never holds the process. */
  start(firstDelayMs = 10_000): void {
    if (this.timer) return
    this.log.prune(this.now())
    const first = setTimeout(() => {
      void this.tick()
      this.timer = setInterval(() => void this.tick(), this.thresholds.sampleIntervalMs)
      this.timer.unref?.()
    }, Math.min(firstDelayMs, this.thresholds.sampleIntervalMs))
    first.unref?.()
    this.timer = first
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
    }
    this.timer = null
    this.log.flushSync()
  }

  /** The desktop app's processes, sent by its main process about once a minute, or when a profiler tool asks. */
  acceptAppReport(connectionId: string, processes: AppProcessMemory[], hints?: AppHints, detail?: { windows: WindowCounters[]; views: AppViewInfo[] }): void {
    this.appReports.set(connectionId, { at: this.now(), processes, ...(hints ? { hints } : {}) })
    if (detail) this.windowDetail = { at: this.now(), ...detail }
  }

  /** The windows' counters from the app's latest report that had them. */
  appWindowDetail(): AppWindowDetail | null {
    return this.windowDetail
  }

  forgetConnection(connectionId: string): void {
    this.appReports.delete(connectionId)
  }

  /** One sample, the limit check and what a breach needs. Never runs twice at once. */
  tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.runTick().finally(() => { this.running = null })
    return this.running
  }

  private async runTick(): Promise<void> {
    try {
      this.ticks += 1
      if (!this.started) {
        this.started = true
        this.log.append({ type: 'start', t: this.now(), version: this.options.version, pid: process.pid })
      }
      const sample = await this.takeSample((this.ticks - 1) % DETAIL_EVERY === 0)
      this.history.push(sample)
      const cutoff = sample.t - HISTORY_MS
      while (this.history.length && this.history[0].t < cutoff) this.history.shift()
      this.log.append({ type: 'sample', ...this.compact(sample) })
      await this.check(sample)
    } catch (error) {
      logWarn('memory', 'memory sample failed', error)
    }
  }

  /** The log line: the windows' hints only when they changed or an hour passed. */
  private compact(sample: MemorySample): MemorySample {
    if (!sample.hints) return sample
    const json = JSON.stringify(sample.hints)
    if (this.loggedHints && this.loggedHints.json === json && sample.t - this.loggedHints.at < HINTS_RELOG_MS) {
      const { hints: _same, ...rest } = sample
      return rest
    }
    this.loggedHints = { json, at: sample.t }
    return sample
  }

  /**
   * A sample now, for a profiler tool: not kept in the history or written to the log. With `children`, the child
   * processes' memory is read again too.
   */
  async measure(options: { children?: boolean } = {}): Promise<MemorySample> {
    return this.takeSample(options.children === true)
  }

  /** The samples held, oldest first (6 hours at most). */
  samples(): readonly MemorySample[] {
    return this.history
  }

  /** The service's V8 heap statistics and heap spaces, read now. */
  readDetailNow(): MemoryDetail {
    this.detail = (this.options.readDetail ?? readHeapDetail)()
    return this.detail
  }

  /** The children's memory, read now (one OS listing). */
  readChildrenNow(): Promise<ChildMemory[]> {
    return (this.options.readChildren ?? (() => readChildMemory(liveChildProcesses())))()
  }

  /** CPU use since the previous reading, percent of one core; undefined the first time. */
  private cpuPercent(t: number): number | undefined {
    const usage = (this.options.cpuUsage ?? process.cpuUsage)()
    const last = this.lastCpu
    this.lastCpu = { usage, at: t }
    if (!last || t <= last.at) return undefined
    const micros = usage.user - last.usage.user + (usage.system - last.usage.system)
    return Math.max(0, Math.round((micros / 1000 / (t - last.at)) * 1000) / 10)
  }

  private async takeSample(withDetail: boolean): Promise<MemorySample> {
    // The time and the uptime are read together, before any await.
    const t = this.now()
    const up = Math.round(this.uptime())
    const cpu = this.cpuPercent(t)
    const [service, reading] = await Promise.all([
      (this.options.sampleProcess ?? sampleOwnProcess)(),
      this.options.readCounts()
    ])
    this.detail = (this.options.readDetail ?? readHeapDetail)()
    if (withDetail) {
      this.lastChildren = await (this.options.readChildren ?? (() => readChildMemory(liveChildProcesses())))()
      if (this.options.readReplayBytes) this.lastReplayMb = toMb(this.options.readReplayBytes())
    }
    const { processes: app, hints } = this.freshAppReport(t)
    return {
      t,
      up,
      run: this.runId,
      service: cpu !== undefined ? { ...service, cpu } : service,
      counts: { ...reading.counts, providerProcesses: (this.options.childCount ?? (() => liveChildProcesses().length))() },
      ...(reading.workerHeaps.length ? { workers: reading.workerHeaps.map(toMb) } : {}),
      ...(withDetail && this.lastChildren?.length ? { children: this.lastChildren } : {}),
      ...(app.length ? { app } : {}),
      ...(hints ? { hints } : {}),
      ...(withDetail && this.lastReplayMb !== undefined ? { replayMb: this.lastReplayMb } : {})
    }
  }

  private freshAppReport(now: number): { processes: AppProcessMemory[]; hints?: AppHints } {
    // The app reports once a minute whatever the service's interval is.
    const maxAge = Math.max(this.thresholds.sampleIntervalMs, 60_000) * APP_REPORT_FRESH_INTERVALS
    const processes: AppProcessMemory[] = []
    let hints: AppHints | undefined
    for (const [id, report] of this.appReports) {
      if (now - report.at > maxAge) {
        this.appReports.delete(id)
        continue
      }
      processes.push(...report.processes)
      hints ??= report.hints
    }
    return { processes, ...(hints ? { hints } : {}) }
  }

  /** The run's baseline: read from the history until minute 15 is over, then kept. */
  private baselineMb(sample: MemorySample): number | null {
    if (this.baseline?.run === this.runId) return this.baseline.mb
    const mb = serviceBaselineMb(this.history, this.thresholds)
    if (sample.up > BASELINE_TO_S) this.baseline = { run: this.runId, mb }
    return mb
  }

  private async check(sample: MemorySample): Promise<void> {
    const breaches = detectBreaches(this.history, this.thresholds, sample.t, { baselineMb: this.baselineMb(sample) })
    const kinds = new Set(breaches.map((breach) => breach.kind))
    for (const kind of [...this.active.keys()]) if (!kinds.has(kind)) this.active.delete(kind)
    if (!breaches.length) return
    const toLog = breaches.filter((breach) => {
      const known = this.active.get(breach.kind)
      return !known || sample.t - known.loggedAt >= BREACH_RELOG_MS
    })
    for (const breach of breaches) {
      const known = this.active.get(breach.kind)
      this.active.set(breach.kind, { breach, loggedAt: toLog.includes(breach) ? sample.t : known?.loggedAt ?? sample.t })
    }
    if (toLog.length) {
      // The full breakdown, with the children's memory read now.
      const children = await (this.options.readChildren ?? (() => readChildMemory(liveChildProcesses())))().catch(() => undefined)
      const full: MemorySample = { ...sample, ...(children?.length ? { children } : {}) }
      this.history[this.history.length - 1] = full
      this.log.append({ type: 'breach', t: sample.t, breaches: toLog, sample: full, detail: this.detail ?? readHeapDetail() })
      logWarn('memory', `out of bounds: ${toLog.map((breach) => breach.summary).join('; ')}`)
    }
    // One notice a day, whatever its kind.
    if (!this.pending && noticeDue(this.state.noticeShownAt, sample.t)) {
      const first = breaches[0]
      this.pending = { kind: first.kind, summary: first.summary, at: sample.t }
      try { this.options.onNotice?.(this.pending) } catch { /* a failing listener never stops sampling */ }
    }
  }

  /** Notes a heap snapshot a person asked for: its size and home-relative file, nothing from inside it. */
  noteHeapSnapshot(file: string, mb: number): void {
    this.log.append({ type: 'heap-snapshot', t: this.now(), file, mb })
  }

  /** A window showed the notice: none again for a day, of any kind. */
  noticeShown(_kind: BreachKind): void {
    this.state.noticeShownAt = this.now()
    this.pending = null
    this.saveState()
  }

  /** A notice waiting for a window, unless one was shown in the last day. */
  pendingNotice(): MemoryNotice | null {
    if (this.pending && !noticeDue(this.state.noticeShownAt, this.now())) this.pending = null
    return this.pending
  }

  status(): MemoryStatus {
    const sample = this.history[this.history.length - 1] ?? null
    return {
      sample,
      detail: this.detail,
      trend: memoryTrend(this.history, trendStep(this.history, this.thresholds.sampleIntervalMs)),
      growthMbPerHour: sample ? serviceGrowthMbPerHour(this.history, this.thresholds, sample.t) : null,
      baselineMb: this.baseline?.run === this.runId ? this.baseline.mb : serviceBaselineMb(this.history, this.thresholds),
      breaches: [...this.active.values()].map((entry) => entry.breach),
      notice: this.pendingNotice(),
      logFile: MEMORY_LOG_RELATIVE_PATH
    }
  }

  /** The issue text and link for the latest sample, sampling first when there is none yet. */
  async issue(): Promise<MemoryIssue> {
    if (!this.history.length) await this.tick()
    const sample = this.history[this.history.length - 1]
    if (!sample) throw new Error('No memory sample yet')
    return memoryIssue({
      version: this.options.version,
      os: { platform: platform(), release: release(), arch: arch(), totalMemMb: toMb(totalmem()) },
      sample,
      detail: this.detail,
      history: this.history,
      breaches: [...this.active.values()].map((entry) => entry.breach),
      thresholds: this.thresholds,
      ...(this.baseline?.run === this.runId ? { baselineMb: this.baseline.mb } : {})
    })
  }

  /** Writes what is queued for the log. */
  flush(): Promise<void> {
    return this.log.flush()
  }

  private loadState(): MonitorState {
    try {
      if (!existsSync(this.statePath)) return {}
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as { noticeShownAt?: unknown }
      if (typeof raw.noticeShownAt === 'number') return { noticeShownAt: raw.noticeShownAt }
      // An earlier build kept one time per kind: the latest of them counts.
      if (raw.noticeShownAt && typeof raw.noticeShownAt === 'object') {
        const times = Object.values(raw.noticeShownAt).filter((at): at is number => typeof at === 'number')
        if (times.length) return { noticeShownAt: Math.max(...times) }
      }
      return {}
    } catch {
      return {}
    }
  }

  private saveState(): void {
    try {
      mkdirSync(this.diagnosticsDir, { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(this.state))
    } catch (error) {
      logWarn('memory', 'could not save the memory monitor state', error)
    }
  }
}

/** About 40 trend points over the history held: never finer than one sample, nor coarser than 15 minutes. */
export function trendStep(history: readonly MemorySample[], intervalMs: number): number {
  const span = history.length > 1 ? history[history.length - 1].t - history[0].t : 0
  return Math.min(15 * 60_000, Math.max(intervalMs, Math.ceil(span / 40)))
}
