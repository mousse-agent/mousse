import { arch, platform, release, totalmem } from 'node:os'
import type { ParsedArgs } from '../parseArgs'
import { exitWithError, writeOutput } from '../output'
import { DIAGNOSTICS_HELP } from '../help'
import { resolveMousseHome } from '../paths'
import { memoryLogPath, readMemoryLog, samplesOf, type MemoryLogLine } from '../../mms/diagnostics/memoryLog'
import {
  MEMORY_THRESHOLDS_ENV,
  appMb,
  detectBreaches,
  memoryIssue,
  memoryTrend,
  resolveMemoryThresholds,
  serviceGrowthMbPerHour,
  serviceMb,
  toMb,
  type MemoryBreach,
  type MemoryDetail,
  type MemorySample,
  type ProcessMemory
} from '../../shared/diagnostics/memory'

/**
 * `mousse-cli diagnostics memory [report]`: reads the service's memory log from the Mousse home (the service need
 * not be running). `report` prints the issue text and the link that opens it prefilled; nothing is sent.
 */
export async function runDiagnostics(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional } = args
  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(DIAGNOSTICS_HELP)
    return
  }
  if (subcommand !== 'memory') exitWithError(`Unknown diagnostics subcommand: ${subcommand}`, globals.mode)
  const action = positional[0]
  if (action !== undefined && action !== 'report') exitWithError(`Unknown diagnostics memory action: ${action}`, globals.mode)
  const path = memoryLogPath(resolveMousseHome(globals.homeDir))
  const lines = readMemoryLog(path)
  const summary = summarizeMemoryLog(lines, Date.now())
  if (!summary.sample) {
    writeOutput(globals.mode, { log: path, samples: 0 }, () => `No memory samples yet in ${path}. The service writes one a minute while it runs.`)
    return
  }
  if (action === 'report') {
    const issue = memoryIssue({
      version: summary.version,
      os: { platform: platform(), release: release(), arch: arch(), totalMemMb: toMb(totalmem()) },
      sample: summary.sample,
      detail: summary.detail,
      history: summary.run,
      breaches: summary.breaches,
      thresholds: summary.thresholds
    })
    writeOutput(globals.mode, issue, () => `${issue.title}\n\n${issue.body}\n\nOpen this link to review and submit it yourself (nothing is sent until you do):\n${issue.url}\n`)
    return
  }
  writeOutput(globals.mode, {
    log: path,
    samples: summary.samples,
    since: summary.since,
    version: summary.version,
    latest: summary.sample,
    detail: summary.detail,
    hourly: summary.hourly,
    growthMbPerHour: summary.growth,
    breaches: summary.breaches,
    recentBreaches: summary.recentBreaches
  }, () => formatMemorySummary(summary, path))
}

export interface MemoryLogSummary {
  samples: number
  since: number | null
  version: string
  sample: MemorySample | null
  detail: MemoryDetail | null
  /** The latest service run's samples. */
  run: MemorySample[]
  hourly: Array<{ t: number; service: number; app: number | null }>
  growth: number | null
  breaches: MemoryBreach[]
  recentBreaches: Array<{ t: number; breaches: MemoryBreach[] }>
  thresholds: ReturnType<typeof resolveMemoryThresholds>
}

export function summarizeMemoryLog(lines: MemoryLogLine[], now: number, env: NodeJS.ProcessEnv = process.env): MemoryLogSummary {
  const thresholds = resolveMemoryThresholds(env[MEMORY_THRESHOLDS_ENV] === 'off' ? undefined : env[MEMORY_THRESHOLDS_ENV])
  const samples = samplesOf(lines)
  const sample = samples[samples.length - 1] ?? null
  const start = sample ? Math.round((sample.t - sample.up * 1000) / 1000) : 0
  const run = sample ? samples.filter((s) => Math.round((s.t - s.up * 1000) / 1000) === start) : []
  const breachLines = lines.filter((line): line is Extract<MemoryLogLine, { type: 'breach' }> => line.type === 'breach')
  const lastStart = [...lines].reverse().find((line): line is Extract<MemoryLogLine, { type: 'start' }> => line.type === 'start')
  return {
    samples: samples.length,
    since: samples[0]?.t ?? null,
    version: lastStart?.version ?? 'unknown',
    sample,
    detail: breachLines[breachLines.length - 1]?.detail ?? null,
    run,
    hourly: memoryTrend(samples.filter((s) => s.t >= now - 24 * 3_600_000), 3_600_000),
    growth: sample ? serviceGrowthMbPerHour(run, thresholds, sample.t) : null,
    breaches: sample ? detectBreaches(run, thresholds, sample.t) : [],
    recentBreaches: breachLines.slice(-5).map((line) => ({ t: line.t, breaches: line.breaches })),
    thresholds
  }
}

function mb(n: number | undefined): string {
  return n === undefined ? '-' : n.toFixed(1)
}

function row(name: string, p: ProcessMemory): string {
  return `  ${name.padEnd(12)} private ${mb(p.private).padStart(7)}  rss ${mb(p.rss).padStart(7)}  heap ${mb(p.heapUsed)}/${mb(p.heapTotal)}  external ${mb(p.external)}`
}

function formatMemorySummary(summary: MemoryLogSummary, path: string): string {
  const sample = summary.sample!
  const out: string[] = []
  out.push(`Memory at ${new Date(sample.t).toLocaleString()} (service up ${(sample.up / 3600).toFixed(1)} h, ${summary.version}), MB`)
  out.push(row('Service', sample.service))
  let windows = 0
  for (const p of sample.app ?? []) {
    const label = p.kind === 'main' ? 'App main' : p.kind === 'window' ? `Window ${++windows}` : p.kind === 'gpu' ? 'GPU' : p.kind === 'utility' ? 'Utility' : 'Other'
    out.push(row(label, p))
  }
  if (sample.app?.length) out.push(`  ${'App total'.padEnd(12)} ${mb(appMb(sample) ?? undefined)}`)
  const c = sample.counts
  out.push(`  Counts: SQLite connections ${c.sqliteConnections ?? '-'}, workers ${c.workerThreads}, loaded threads ${c.loadedThreads}, runtimes ${c.threadRuntimes}, thread cache ${c.threadCacheThreads} (${mb(c.threadCacheMb)} MB), replay ${c.replayEvents} events, terminals ${c.ptys}, file watchers ${c.fileWatchers}, provider processes ${c.providerProcesses}`)
  if (sample.children?.length) out.push(`  Providers: ${sample.children.map((child) => `${child.kind} ${child.mb === null ? '-' : child.mb.toFixed(1)}`).join(', ')}`)
  if (summary.hourly.length > 1) out.push(`Service MB, hourly over the last day: ${summary.hourly.map((point) => Math.round(point.service)).join(' ')}`)
  if (summary.growth !== null) out.push(`Growth: ${summary.growth} MB/h over ${summary.thresholds.growthWindowHours} h`)
  out.push(summary.breaches.length ? `Out of bounds now: ${summary.breaches.map((breach) => breach.summary).join('; ')}` : `Within bounds (service limit ${summary.thresholds.servicePrivateMb} MB, ${Math.round(serviceMb(sample))} MB now)`)
  for (const entry of summary.recentBreaches) out.push(`  ${new Date(entry.t).toLocaleString()}: ${entry.breaches.map((breach) => breach.summary).join('; ')}`)
  out.push(`Log: ${path} (${summary.samples} samples since ${summary.since ? new Date(summary.since).toLocaleString() : '-'})`)
  out.push('Report: mousse-cli diagnostics memory report')
  return out.join('\n')
}
