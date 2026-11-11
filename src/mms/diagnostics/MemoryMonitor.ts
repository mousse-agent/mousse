/**
 * The service's memory monitor. About once a minute it reads its own memory and counts (a few microseconds of
 * work plus one small question to each thread database worker), adds the desktop app's last report, appends one
 * line to `diagnostics/memory.jsonl`, and checks the limits. On a breach it logs the full breakdown, offers one
 * notice a day for each kind of breach, and, only when the breach is severe, writes one V8 heap snapshot a day
 * beside the log. Nothing leaves the computer: a report is text the person opens in GitHub and submits themselves.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { arch, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import v8 from 'node:v8'
import { logWarn } from '../log/diag'
import {
  DEFAULT_MEMORY_THRESHOLDS,
  MEMORY_LOG_RELATIVE_PATH,
  detectBreaches,
  memoryIssue,
  memoryTrend,
  noticeDue,
  serviceGrowthMbPerHour,
  toMb,
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

/** One heap snapshot a day, only below this heap size (writing one needs about as much memory again). */
export const HEAP_SNAPSHOT_MAX_HEAP_MB = 1_024
export const HEAP_SNAPSHOT_EVERY_MS = 24 * 3_600_000
export const HEAP_SNAPSHOT_KEEP = 2
/** A snapshot bigger than this is deleted again. */
export const HEAP_SNAPSHOT_MAX_FILE_MB = 1_536

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
  /** Writes a heap snapshot to `file` and returns its path; null turns snapshots off. */
  writeHeapSnapshot?: ((file: string) => string) | null
  log?: MemoryLog
}

interface MonitorState {
  noticeShownAt: Partial<Record<BreachKind, number>>
  heapSnapshotAt?: number
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
  private appReports = new Map<string, { at: number; processes: AppProcessMemory[] }>()
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private running: Promise<void> | null = null
  private lastChildren: ChildMemory[] | undefined
  private lastReplayMb: number | undefined
  private started = false

  constructor(private readonly options: MemoryMonitorOptions) {
    this.thresholds = options.thresholds ?? DEFAULT_MEMORY_THRESHOLDS
    this.log = options.log ?? new MemoryLog(options.homeDir)
    this.now = options.now ?? Date.now
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

  /** The desktop app's processes, sent by its main process about once a minute. */
  acceptAppReport(connectionId: string, processes: AppProcessMemory[]): void {
    this.appReports.set(connectionId, { at: this.now(), processes })
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
      this.log.append({ type: 'sample', ...sample })
      await this.check(sample)
    } catch (error) {
      logWarn('memory', 'memory sample failed', error)
    }
  }

  private async takeSample(withDetail: boolean): Promise<MemorySample> {
    const t = this.now()
    const [service, reading] = await Promise.all([
      (this.options.sampleProcess ?? sampleOwnProcess)(),
      this.options.readCounts()
    ])
    this.detail = (this.options.readDetail ?? readHeapDetail)()
    if (withDetail) {
      this.lastChildren = await (this.options.readChildren ?? (() => readChildMemory(liveChildProcesses())))()
      if (this.options.readReplayBytes) this.lastReplayMb = toMb(this.options.readReplayBytes())
    }
    const app = this.freshAppProcesses(t)
    return {
      t,
      up: Math.round((this.options.uptime ?? process.uptime)()),
      service,
      counts: { ...reading.counts, providerProcesses: (this.options.childCount ?? (() => liveChildProcesses().length))() },
      ...(reading.workerHeaps.length ? { workers: reading.workerHeaps.map(toMb) } : {}),
      ...(withDetail && this.lastChildren?.length ? { children: this.lastChildren } : {}),
      ...(app.length ? { app } : {}),
      ...(withDetail && this.lastReplayMb !== undefined ? { replayMb: this.lastReplayMb } : {})
    }
  }

  private freshAppProcesses(now: number): AppProcessMemory[] {
    const maxAge = this.thresholds.sampleIntervalMs * APP_REPORT_FRESH_INTERVALS
    const out: AppProcessMemory[] = []
    for (const [id, report] of this.appReports) {
      if (now - report.at > maxAge) this.appReports.delete(id)
      else out.push(...report.processes)
    }
    return out
  }

  private async check(sample: MemorySample): Promise<void> {
    const breaches = detectBreaches(this.history, this.thresholds, sample.t)
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
    const due = breaches.find((breach) => noticeDue(this.state.noticeShownAt, breach.kind, sample.t))
    if (due && this.pending?.kind !== due.kind) {
      this.pending = { kind: due.kind, summary: due.summary, at: sample.t }
      try { this.options.onNotice?.(this.pending) } catch { /* a failing listener never stops sampling */ }
    }
    const severe = breaches.find((breach) => breach.severe)
    if (severe) this.maybeHeapSnapshot(severe, sample)
  }

  private maybeHeapSnapshot(breach: MemoryBreach, sample: MemorySample): void {
    const write = this.options.writeHeapSnapshot === undefined ? (file: string) => v8.writeHeapSnapshot(file) : this.options.writeHeapSnapshot
    if (!write) return
    const last = this.state.heapSnapshotAt
    if (last !== undefined && sample.t - last < HEAP_SNAPSHOT_EVERY_MS && sample.t >= last) return
    if ((sample.service.heapTotal ?? 0) > HEAP_SNAPSHOT_MAX_HEAP_MB) return
    this.state.heapSnapshotAt = sample.t
    this.saveState()
    try {
      mkdirSync(this.diagnosticsDir, { recursive: true })
      const stamp = new Date(sample.t).toISOString().replace(/[:.]/g, '-')
      const name = `heap-${stamp}.heapsnapshot`
      const file = write(join(this.diagnosticsDir, name))
      const mb = toMb(statSync(file).size)
      if (mb > HEAP_SNAPSHOT_MAX_FILE_MB) {
        rmSync(file, { force: true })
        return
      }
      this.log.append({ type: 'heap-snapshot', t: sample.t, kind: breach.kind, file: `diagnostics/${name}`, mb })
      this.pruneHeapSnapshots()
    } catch (error) {
      logWarn('memory', 'heap snapshot failed', error)
    }
  }

  private pruneHeapSnapshots(): void {
    const snapshots = readdirSync(this.diagnosticsDir).filter((name) => /^heap-.*\.heapsnapshot$/.test(name)).sort()
    for (const name of snapshots.slice(0, Math.max(0, snapshots.length - HEAP_SNAPSHOT_KEEP))) {
      rmSync(join(this.diagnosticsDir, name), { force: true })
    }
  }

  /** The person saw the notice: none of this kind again for a day. */
  noticeShown(kind: BreachKind): void {
    this.state.noticeShownAt[kind] = this.now()
    if (this.pending?.kind === kind) this.pending = null
    this.saveState()
  }

  /** A notice waiting for a window, unless one of its kind was shown in the last day. */
  pendingNotice(): MemoryNotice | null {
    if (this.pending && !noticeDue(this.state.noticeShownAt, this.pending.kind, this.now())) this.pending = null
    return this.pending
  }

  status(): MemoryStatus {
    const sample = this.history[this.history.length - 1] ?? null
    return {
      sample,
      detail: this.detail,
      trend: memoryTrend(this.history, 15 * 60_000),
      growthMbPerHour: sample ? serviceGrowthMbPerHour(this.history, this.thresholds, sample.t) : null,
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
      thresholds: this.thresholds
    })
  }

  /** Writes what is queued for the log. */
  flush(): Promise<void> {
    return this.log.flush()
  }

  private loadState(): MonitorState {
    try {
      if (!existsSync(this.statePath)) return { noticeShownAt: {} }
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<MonitorState>
      const shown: Partial<Record<BreachKind, number>> = {}
      for (const [kind, at] of Object.entries(raw.noticeShownAt ?? {})) if (typeof at === 'number') shown[kind as BreachKind] = at
      return { noticeShownAt: shown, ...(typeof raw.heapSnapshotAt === 'number' ? { heapSnapshotAt: raw.heapSnapshotAt } : {}) }
    } catch {
      return { noticeShownAt: {} }
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

