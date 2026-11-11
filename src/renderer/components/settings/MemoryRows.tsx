import { useEffect, useState } from 'react'
import { appHintsLine, appMb, memoryTable, serviceMb, type MemoryStatus, type MemoryTrendPoint } from '../../../shared/diagnostics/memory'
import type { MousseSettings, MousseSettingsUpdate } from '../../../shared/settings'
import { ExternalLink } from '../../lib/icons'
import { memoryNoticesEnabled } from '../../hooks/useMemoryNotices'
import { SettingsRow, Switch } from './SettingsRow'

const REFRESH_MS = 60_000

function mb(n: number | undefined): string {
  return n === undefined ? '-' : `${Math.round(n)} MB`
}

function cell(n: number | undefined): string {
  return n === undefined ? '-' : String(Math.round(n))
}

/** The tooltip on the summary: the service's counts, growth and anything out of bounds. */
export function memoryBreakdown(status: MemoryStatus): string {
  const sample = status.sample
  if (!sample) return 'No sample yet'
  const c = sample.counts
  const lines = [`Loaded threads ${c.loadedThreads}, runtimes ${c.threadRuntimes}, SQLite ${c.sqliteConnections ?? '-'}, workers ${c.workerThreads}, terminals ${c.ptys}, providers ${c.providerProcesses}`]
  if (status.growthMbPerHour !== null) lines.push(`Growth ${status.growthMbPerHour} MB/h`)
  for (const breach of status.breaches) lines.push(`Out of bounds: ${breach.summary}`)
  lines.push(`Log: <Mousse home>/${status.logFile}`)
  return lines.join('\n')
}

/** One series over the last hours, as a small line. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = Math.max(1, max - min)
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 60},${16 - ((value - min) / span) * 14}`).join(' ')
  return (
    <span className="memory-trend" title={`${label}: ${Math.round(min)} to ${Math.round(max)} MB over the last hours`}>
      <span className="memory-trend-label">{label}</span>
      <svg className="memory-sparkline" width="60" height="18" viewBox="0 0 60 18" aria-hidden="true">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  )
}

function series(trend: MemoryTrendPoint[], pick: (point: MemoryTrendPoint) => number | null): number[] {
  return trend.map(pick).filter((value): value is number => value !== null)
}

/** Settings > General > About: every process's memory like Task Manager, the trend, Report, and the notice switch. */
export function MemoryRows({ settings, onUpdate }: { settings: MousseSettings; onUpdate: (partial: MousseSettingsUpdate) => Promise<void> }) {
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    const api = window.mousse?.diagnostics
    if (!api) return
    let live = true
    const read = () => api.memoryStatus().then((next) => { if (live) { setStatus(next); setUnavailable(false) } }, () => { if (live) setUnavailable(true) })
    void read()
    const timer = setInterval(() => void read(), REFRESH_MS)
    return () => { live = false; clearInterval(timer) }
  }, [])

  const sample = status?.sample
  const app = sample ? appMb(sample) : null
  const summary = sample
    ? `Service ${mb(serviceMb(sample))}${app !== null ? `, app ${mb(app)}` : ''}${status!.breaches.length ? ', above expected' : ''}`
    : unavailable ? 'Not measured by this service' : 'Measuring...'
  const enabled = memoryNoticesEnabled(settings)
  const trend = status?.trend ?? []
  return (
    <>
      <SettingsRow
        title="Memory"
        anchor="general-memory"
        description={<span title={status ? memoryBreakdown(status) : undefined} className={status?.breaches.length ? 'settings-status-warn' : undefined}>{summary}</span>}
        control={
          <span className="memory-row-controls">
            <Sparkline label="Service" values={series(trend, (point) => point.service)} />
            <Sparkline label="GPU" values={series(trend, (point) => point.gpu)} />
            <Sparkline label="App" values={series(trend, (point) => point.app)} />
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
      >
        {sample && (
          <table className="memory-table">
            <thead>
              <tr><th scope="col">Process</th><th scope="col" title="Private memory">Private MB</th><th scope="col">Working set MB</th><th scope="col">CPU %</th><th scope="col" title="JavaScript heap used of total">Heap MB</th></tr>
            </thead>
            <tbody>
              {memoryTable(sample).map((row, index) => (
                <tr key={`${row.label}-${index}`} className={row.group === 'total' ? 'memory-table-total' : undefined}>
                  <th scope="row">{row.label}</th>
                  <td>{cell(row.private)}</td>
                  <td>{cell(row.rss)}</td>
                  <td>{row.cpu === undefined ? '-' : row.cpu.toFixed(1)}</td>
                  <td>{row.heapUsed === undefined ? '-' : `${cell(row.heapUsed)}${row.heapTotal !== undefined ? ` / ${cell(row.heapTotal)}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sample?.hints && <p className="memory-hints">{appHintsLine(sample.hints)}</p>}
      </SettingsRow>
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
