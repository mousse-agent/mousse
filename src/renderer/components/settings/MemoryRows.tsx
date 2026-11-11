import { useEffect, useState } from 'react'
import { appMb, serviceMb, type AppProcessMemory, type MemoryStatus, type ProcessMemory } from '../../../shared/diagnostics/memory'
import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { ExternalLink } from '../../lib/icons'
import { memoryNoticesEnabled } from '../../hooks/useMemoryNotices'
import { SettingsRow, Switch } from './SettingsRow'

const REFRESH_MS = 60_000

function mb(n: number | undefined): string {
  return n === undefined ? '-' : `${Math.round(n)} MB`
}

function processLine(name: string, p: ProcessMemory): string {
  const heap = p.heapUsed !== undefined ? `, heap ${Math.round(p.heapUsed)}/${Math.round(p.heapTotal ?? 0)}` : ''
  return `${name}: ${mb(p.private ?? p.rss)}${heap}`
}

const KIND_NAMES: Record<AppProcessMemory['kind'], string> = { main: 'App main', window: 'Window', gpu: 'GPU', utility: 'Utility', other: 'Other' }

/** The tooltip: every process and the service's counts, one per line. */
export function memoryBreakdown(status: MemoryStatus): string {
  const sample = status.sample
  if (!sample) return 'No sample yet'
  const lines = [processLine('Service', sample.service)]
  const seen = new Map<string, number>()
  for (const p of sample.app ?? []) {
    const n = (seen.get(p.kind) ?? 0) + 1
    seen.set(p.kind, n)
    lines.push(processLine(p.kind === 'main' ? KIND_NAMES.main : `${KIND_NAMES[p.kind]} ${n}`, p))
  }
  const c = sample.counts
  lines.push(`Loaded threads ${c.loadedThreads}, runtimes ${c.threadRuntimes}, SQLite ${c.sqliteConnections ?? '-'}, workers ${c.workerThreads}, terminals ${c.ptys}, providers ${c.providerProcesses}`)
  if (status.growthMbPerHour !== null) lines.push(`Growth ${status.growthMbPerHour} MB/h`)
  for (const breach of status.breaches) lines.push(`Out of bounds: ${breach.summary}`)
  lines.push(`Log: <Mousse home>/${status.logFile}`)
  return lines.join('\n')
}

/** The service's memory over the last hours, as a small line. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = Math.max(1, max - min)
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 60},${16 - ((value - min) / span) * 14}`).join(' ')
  return (
    <svg className="memory-sparkline" width="60" height="18" viewBox="0 0 60 18" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Settings > General > About: memory now, its trend, Report, and the notice switch. */
export function MemoryRows({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    const api = window.mousse?.diagnostics
    if (!api) return
    let live = true
    const read = () => api.memoryStatus().then((next) => { if (live) { setStatus(next); setUnavailable(false) } }, () => { if (live) setUnavailable(true) })
    void read()
    const timer = setInterval(read, REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [])

  const sample = status?.sample
  const app = sample ? appMb(sample) : null
  const summary = sample
    ? `Service ${mb(serviceMb(sample))}${app !== null ? `, app ${mb(app)}` : ''}${status!.breaches.length ? ', above expected' : ''}`
    : unavailable ? 'Not measured by this service' : 'Measuring...'
  const enabled = memoryNoticesEnabled(settings)
  return (
    <>
      <SettingsRow
        title="Memory"
        anchor="general-memory"
        description={<span title={status ? memoryBreakdown(status) : undefined} className={status?.breaches.length ? 'settings-status-warn' : undefined}>{summary}</span>}
        control={
          <span className="memory-row-controls">
            {status && <Sparkline values={status.trend.map((point) => point.service)} />}
            <button
              type="button"
              className="settings-btn"
              disabled={!sample}
              title="Open a prefilled GitHub issue with these numbers. You review it; nothing is sent until you submit."
              onClick={() => void window.mousse.diagnostics.memoryReport()}
            >
              <ExternalLink size={14} />Report
            </button>
          </span>
        }
      />
      <SettingsRow
        title="Memory notices"
        anchor="general-memory-notices"
        description={<span title="At most once a day for each kind. The numbers are logged either way.">When memory goes out of bounds.</span>}
        control={
          <Switch
            label="Show a notice when memory goes out of bounds"
            checked={enabled}
            onChange={(memoryNotices) => void onUpdate({ notifications: { ...settings.notifications, memoryNotices } })}
          />
        }
      />
    </>
  )
}
