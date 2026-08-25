import { useMemo, useState } from 'react'
import {
  buildHeatmapGrid,
  getCountForDay,
  toDateKey,
  type LineEditFilter,
  type LineEditStatsSnapshot,
  type UsageStatsSnapshot,
  buildUsageStatsSnapshot,
  buildLineEditSnapshot
} from '../../shared/lineEditStats'
import '../styles/profile-heatmap.css'

function formatTotal(value: number): string {
  return value.toLocaleString()
}

function totalForFilter(stats: LineEditStatsSnapshot, filter: LineEditFilter): number {
  if (filter === 'tab') return stats.totalTab
  if (filter === 'agent') return stats.totalAgent
  return stats.total
}

function maxDayCount(stats: LineEditStatsSnapshot, filter: LineEditFilter): number {
  let max = 0
  for (const record of Object.values(stats.days)) {
    max = Math.max(max, getCountForDay(record, filter))
  }
  return max
}

function mostActiveMonth(stats: LineEditStatsSnapshot, filter: LineEditFilter): string | null {
  const monthTotals = new Map<string, number>()
  for (const [date, record] of Object.entries(stats.days)) {
    const count = getCountForDay(record, filter)
    if (count <= 0) continue
    const monthKey = date.slice(0, 7)
    monthTotals.set(monthKey, (monthTotals.get(monthKey) ?? 0) + count)
  }
  let bestMonth: string | null = null
  let bestTotal = 0
  for (const [monthKey, count] of monthTotals.entries()) {
    if (count > bestTotal) {
      bestTotal = count
      const [year, month] = monthKey.split('-').map(Number)
      bestMonth = new Date(year!, month! - 1, 1).toLocaleDateString(undefined, { month: 'long' })
    }
  }
  return bestMonth
}

function mostActiveDay(stats: LineEditStatsSnapshot, filter: LineEditFilter): string | null {
  let best: { date: string; count: number } | null = null
  for (const [date, record] of Object.entries(stats.days)) {
    const count = getCountForDay(record, filter)
    if (count <= 0) continue
    if (!best || count > best.count) best = { date, count }
  }
  if (!best) return null
  const [year, month, day] = best.date.split('-').map(Number)
  return new Date(year!, month! - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function computeStreaks(stats: LineEditStatsSnapshot, filter: LineEditFilter): {
  longest: number
  current: number
} {
  const activeDates = Object.entries(stats.days)
    .filter(([, record]) => getCountForDay(record, filter) > 0)
    .map(([date]) => date)
    .sort()

  if (activeDates.length === 0) return { longest: 0, current: 0 }

  let longest = 1
  let run = 1
  for (let i = 1; i < activeDates.length; i++) {
    const prev = new Date(activeDates[i - 1]!)
    const curr = new Date(activeDates[i]!)
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86_400_000)
    if (diffDays === 1) {
      run++
      longest = Math.max(longest, run)
    } else if (diffDays > 1) {
      run = 1
    }
  }

  let current = 0
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  const activeSet = new Set(activeDates)
  while (activeSet.has(toDateKey(cursor))) {
    current++
    cursor.setDate(cursor.getDate() - 1)
  }

  return { longest, current }
}

interface LineEditHeatmapProps {
  stats: LineEditStatsSnapshot
  usage?: UsageStatsSnapshot | null
}

export function LineEditHeatmap({ stats, usage }: LineEditHeatmapProps) {
  const filter: LineEditFilter = 'all'
  const [metric, setMetric] = useState<'lines' | 'tokens'>('lines')
  const [provider, setProvider] = useState('all')
  const [model, setModel] = useState('all')
  const filteredUsage = useMemo(() => buildUsageStatsSnapshot((usage?.turns ?? []).filter((turn) =>
    (provider === 'all' || turn.provider === provider) && (model === 'all' || turn.model === model)
  )), [usage, provider, model])
  const tokenDays = useMemo(() => Object.fromEntries(Object.entries(filteredUsage.days).map(([date, day]) =>
    [date, { orchestrator: day.tokens, manual: 0 }]
  )), [filteredUsage.days])
  const displayedStats = useMemo(() => metric === 'tokens' ? buildLineEditSnapshot(tokenDays) : stats, [metric, stats, tokenDays])

  const total = metric === 'tokens' ? filteredUsage.totals.tokens : totalForFilter(stats, filter)
  const { weeks } = useMemo(
    () => buildHeatmapGrid(metric === 'tokens' ? tokenDays : stats.days, filter),
    [stats.days, filter, metric, tokenDays]
  )
  const streaks = useMemo(() => computeStreaks(displayedStats, filter), [displayedStats, filter])
  const activeMonth = useMemo(() => mostActiveMonth(displayedStats, filter), [displayedStats, filter])
  const activeDay = useMemo(() => mostActiveDay(displayedStats, filter), [displayedStats, filter])
  const peakDay = metric === 'tokens'
    ? Math.max(0, ...Object.values(filteredUsage.days).map((day) => day.tokens))
    : maxDayCount(stats, filter)

  return (
    <div className="line-edit-card">
      <div className="line-edit-card-header">
        <div className="line-edit-card-title">
          <span className="line-edit-label">{metric === 'lines' ? 'Lines Edited' : 'Tokens Used'}</span>
          <span className="line-edit-total">{formatTotal(total)}</span>
        </div>
        <div className="usage-controls">
          <select aria-label="Heatmap metric" value={metric} onChange={(e) => setMetric(e.target.value as 'lines' | 'tokens')}>
            <option value="lines">Lines of code</option><option value="tokens">Tokens used</option>
          </select>
          <select aria-label="Provider filter" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="all">All providers</option>{usage?.providers.map((item) => <option key={item}>{item}</option>)}
          </select>
          <select aria-label="Model filter" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="all">All models</option>{usage?.models.map((item) => <option key={item}>{item}</option>)}
          </select>
        </div>
      </div>

      <div className="usage-summary-grid">
        <UsageCard label="Tokens in" value={filteredUsage.totals.input} tone="input" total={filteredUsage.totals.tokens} />
        <UsageCard label="Tokens out" value={filteredUsage.totals.output} tone="output" total={filteredUsage.totals.tokens} />
        <UsageCard label="Cached" value={filteredUsage.totals.cacheRead + filteredUsage.totals.cacheWrite} tone="cached" total={filteredUsage.totals.tokens} />
        <UsageCard label="Cache ratio" value={filteredUsage.totals.cacheRatio * 100} tone="ratio" total={100} suffix="%" />
      </div>

      <div className="line-edit-heatmap-wrap">
        <div className="line-edit-months" aria-hidden="true">
          {weeks.map((week, index) => (
            <span key={`month-${index}`} className="line-edit-month-label">
              {week.monthLabel ?? ''}
            </span>
          ))}
        </div>
        <div className="line-edit-heatmap-body">
          <div className="line-edit-weekdays" aria-hidden="true">
            <span>M</span>
            <span />
            <span>W</span>
            <span />
            <span>F</span>
            <span />
            <span />
          </div>
          <div className="line-edit-grid">
            {weeks.map((week, weekIndex) => (
              <div key={`week-${weekIndex}`} className="line-edit-week">
                {week.days.map((cell, dayIndex) =>
                  cell ? (
                    <span
                      key={cell.date}
                      className={`line-edit-cell level-${cell.level}`}
                      title={`${cell.count.toLocaleString()} ${metric === 'tokens' ? 'tokens' : 'lines'} on ${cell.date}`}
                    />
                  ) : (
                    <span key={`empty-${weekIndex}-${dayIndex}`} className="line-edit-cell empty" />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="line-edit-stats-row">
        <div className="line-edit-stat">
          <span className="line-edit-stat-label">Most Active Month</span>
          <span className="line-edit-stat-value">{activeMonth ?? '—'}</span>
        </div>
        <div className="line-edit-stat">
          <span className="line-edit-stat-label">Most Active Day</span>
          <span className="line-edit-stat-value">{activeDay ?? '—'}</span>
        </div>
        <div className="line-edit-stat">
          <span className="line-edit-stat-label">Longest Streak</span>
          <span className="line-edit-stat-value">{streaks.longest > 0 ? `${streaks.longest}d` : '—'}</span>
        </div>
        <div className="line-edit-stat">
          <span className="line-edit-stat-label">Current Streak</span>
          <span className="line-edit-stat-value">{streaks.current > 0 ? `${streaks.current}d` : '—'}</span>
        </div>
      </div>

      <div className="line-edit-legend">
        <span className="line-edit-legend-label">Fewer</span>
        <span className="line-edit-cell level-0" />
        <span className="line-edit-cell level-1" />
        <span className="line-edit-cell level-2" />
        <span className="line-edit-cell level-3" />
        <span className="line-edit-cell level-4" />
        <span className="line-edit-legend-label">More</span>
        {peakDay > 0 && (
          <span className="line-edit-legend-peak">Peak day: {peakDay.toLocaleString()} {metric === 'tokens' ? 'tokens' : 'lines'}</span>
        )}
      </div>
    </div>
  )
}

function UsageCard({ label, value, total, tone, suffix = '' }: { label: string; value: number; total: number; tone: string; suffix?: string }) {
  const width = total > 0 ? Math.min(100, value / total * 100) : 0
  return <div className="usage-stat-card">
    <span>{label}</span><strong>{value.toLocaleString(undefined, { maximumFractionDigits: 1 })}{suffix}</strong>
    <div className="usage-stat-track"><i className={`usage-stat-fill ${tone}`} style={{ width: `${width}%` }} /></div>
  </div>
}
