import { arch, platform, release, totalmem } from 'node:os'
import type { ParsedArgs } from '../parseArgs'
import { flagBool } from '../parseArgs'
import { closeMmsContext, openMms } from '../mmsContext'
import { HEAP_SNAPSHOT_WARNING } from '../../mms/diagnostics/heapSnapshot'
import { exitWithError, writeOutput } from '../output'
import { DIAGNOSTICS_HELP } from '../help'
import { resolveMousseHome } from '../paths'
import { memoryLogPath, readMemoryLog, samplesOf, type MemoryLogLine } from '../../mms/diagnostics/memoryLog'
import {
  MEMORY_THRESHOLDS_ENV,
  isPackagedRuntime,
  runOf,
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
  type MemoryTrendPoint,
  appHintsLine,
  memoryTable
} from '../../shared/diagnostics/memory'

/**
 * `mousse-cli diagnostics memory [report|snapshot]`: reads the service's memory log from the Mousse home (the
 * service need not be running). `report` prints the issue text and the link that opens it prefilled; nothing is
 * sent. `snapshot --yes` asks the running service for a V8 heap snapshot, which holds what threads contain.
 */
export async function runDiagnostics(args: ParsedArgs): Promise<void> {
  const { globals, subcommand, positional } = args
  if (!subcommand || subcommand === 'help' || globals.help) {
    process.stdout.write(DIAGNOSTICS_HELP)
    return
  }
  if (subcommand !== 'memory') exitWithError(`Unknown diagnostics subcommand: ${subcommand}`, globals.mode)
  const action = positional[0]
  if (action !== undefined && action !== 'report' && action !== 'snapshot') exitWithError(`Unknown diagnostics memory action: ${action}`, globals.mode)
  if (action === 'snapshot') {
    await runHeapSnapshot(args)
    return
  }
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
    const how = issue.complete
      ? 'Open this link to review and submit it yourself (nothing is sent until you do):'
      : 'The text is too long for a link. Open this link, paste the text above into it, review it and submit it yourself:'
    writeOutput(globals.mode, issue, () => `${issue.title}\n\n${issue.body}\n\n${how}\n${issue.url}\n`)
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
  hourly: MemoryTrendPoint[]
  growth: number | null
  breaches: MemoryBreach[]
  recentBreaches: Array<{ t: number; breaches: MemoryBreach[] }>
  thresholds: ReturnType<typeof resolveMemoryThresholds>
}

export function summarizeMemoryLog(lines: MemoryLogLine[], now: number, env: NodeJS.ProcessEnv = process.env, packaged = isPackagedRuntime()): MemoryLogSummary {
  const thresholds = resolveMemoryThresholds(env[MEMORY_THRESHOLDS_ENV] === 'off' ? undefined : env[MEMORY_THRESHOLDS_ENV], undefined, { packaged })
  const samples = samplesOf(lines)
  const last = samples[samples.length - 1] ?? null
  const run = last ? samples.filter((s) => runOf(s) === runOf(last)) : []
  // The log keeps the windows' hints only when they change: the latest sample shows the last ones known.
  const hints = [...run].reverse().find((s) => s.hints)?.hints
  const sample = last && !last.hints && hints ? { ...last, hints } : last
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

/** The per-process table, like Task Manager with roles. */
export function formatMemoryTable(sample: MemorySample): string[] {
  const rows = memoryTable(sample)
  const width = Math.max(16, ...rows.map((r) => r.label.length + 2))
  const head = `  ${'Process'.padEnd(width)}${'Private'.padStart(9)}${'Working set'.padStart(13)}${'CPU %'.padStart(8)}${'Heap used/total'.padStart(18)}`
  return [head, ...rows.map((r) => `  ${r.label.padEnd(width)}${mb(r.private).padStart(9)}${mb(r.rss).padStart(13)}${mb(r.cpu).padStart(8)}${(r.heapUsed === undefined ? '-' : `${mb(r.heapUsed)}/${mb(r.heapTotal)}`).padStart(18)}`)]
}

function formatMemorySummary(summary: MemoryLogSummary, path: string): string {
  const sample = summary.sample!
  const out: string[] = []
  const up = sample.up < 3600 ? `${Math.round(sample.up / 60)} min` : `${(sample.up / 3600).toFixed(1)} h`
  out.push(`Memory at ${new Date(sample.t).toLocaleString()} (service up ${up}, ${summary.version}), MB`)
  out.push(...formatMemoryTable(sample))
  if (sample.hints) out.push(`  Windows: ${appHintsLine(sample.hints)}`)
  const c = sample.counts
  out.push(`  Counts: SQLite connections ${c.sqliteConnections ?? '-'}, workers ${c.workerThreads}, loaded threads ${c.loadedThreads}, runtimes ${c.threadRuntimes}, thread cache ${c.threadCacheThreads} (${mb(c.threadCacheMb)} MB), replay ${c.replayEvents} events, terminals ${c.ptys}, file watchers ${c.fileWatchers}, provider processes ${c.providerProcesses}${c.workerCrashes ? `, worker crashes ${c.workerCrashes}` : ''}`)
  if (summary.hourly.length > 1) {
    const series = (pick: (point: (typeof summary.hourly)[number]) => number | null) => summary.hourly.map((point) => { const v = pick(point); return v === null ? '-' : String(Math.round(v)) }).join(' ')
    out.push(`Hourly over the last day, MB: service ${series((point) => point.service)}`)
    if (summary.hourly.some((point) => point.gpu !== null)) out.push(`  GPU ${series((point) => point.gpu)}`)
    if (summary.hourly.some((point) => point.app !== null)) out.push(`  App ${series((point) => point.app)}`)
  }
  if (summary.growth !== null) out.push(`Growth: ${summary.growth} MB/h over ${summary.thresholds.growthWindowHours} h`)
  out.push(summary.breaches.length ? `Out of bounds now: ${summary.breaches.map((breach) => breach.summary).join('; ')}` : `Within bounds (service limit ${summary.thresholds.servicePrivateMb} MB, ${Math.round(serviceMb(sample))} MB now)`)
  for (const entry of summary.recentBreaches) out.push(`  ${new Date(entry.t).toLocaleString()}: ${entry.breaches.map((breach) => breach.summary).join('; ')}`)
  out.push(`Log: ${path} (${summary.samples} samples since ${summary.since ? new Date(summary.since).toLocaleString() : '-'})`)
  out.push('Report: mousse-cli diagnostics memory report')
  return out.join('\n')
}

/** `diagnostics memory snapshot`: warns what the file holds, and writes it only with `--yes`, while no turn runs. */
async function runHeapSnapshot(args: ParsedArgs): Promise<void> {
  const { globals } = args
  process.stderr.write(`${HEAP_SNAPSHOT_WARNING}\n`)
  if (!flagBool(args.flags, 'yes')) {
    exitWithError('Not written. Run `mousse-cli diagnostics memory snapshot --yes` to write it.', globals.mode)
  }
  const ctx = await openMms(globals)
  try {
    const written = await ctx.client.request<{ file: string; mb: number }>('diagnostics.memory.heapSnapshot', { confirm: true })
    const home = resolveMousseHome(globals.homeDir)
    writeOutput(globals.mode, { ...written, path: `${home}/${written.file}` }, () => `Heap snapshot written: ${home}/${written.file} (${written.mb} MB).\nIt holds what the service had in memory. Keep it on this computer.`)
  } finally {
    await closeMmsContext(ctx)
  }
}
