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
import { Segmented, SettingsGroup, type SegmentedOption } from './settings/SettingsRow'
import { Activity, Coins } from '../lib/icons'
import { Select } from './ui/Select'
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

type Metric = 'lines' | 'tokens'

const METRIC_OPTIONS: ReadonlyArray<SegmentedOption<Metric>> = [
  { value: 'lines', label: 'Lines edited' },
  { value: 'tokens', label: 'Tokens' }
]

/**
 * Activity on the Account page: the yearly heatmap and token usage, laid flat on the page in two
 * settings groups (no cards, no nested panels).
 */
export function LineEditHeatmap({ stats, usage }: LineEditHeatmapProps) {
  const filter: LineEditFilter = 'all'
  const [metric, setMetric] = useState<Metric>('lines')
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
  const unit = metric === 'tokens' ? 'tokens' : 'lines'
  const hasUsage = filteredUsage.turns.length > 0
  // Cache ratio = cache reads / (uncached input + cache reads); undefined when nothing was read or sent.
  const cacheEligible = filteredUsage.totals.input + filteredUsage.totals.cacheRead

  return (
    <>
      <SettingsGroup
        title="Activity"
        icon={Activity}
        className="activity-group"
        action={<Segmented value={metric} options={METRIC_OPTIONS} onChange={setMetric} ariaLabel="Heatmap metric" />}
      >
        <p className="activity-total">
          <span className="activity-total-value">{formatTotal(total)}</span>
          <span className="settings-muted">{metric === 'lines' ? 'lines edited' : 'tokens used'}</span>
        </p>

        <div className="activity-heatmap">
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
                        title={`${cell.count.toLocaleString()} ${unit} on ${cell.date}`}
                      />
                    ) : (
                      <span key={`empty-${weekIndex}-${dayIndex}`} className="line-edit-cell empty" />
                    )
                  )}
                </div>
              ))}
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
              <span className="line-edit-legend-peak">Peak day: {peakDay.toLocaleString()} {unit}</span>
            )}
          </div>
        </div>

        <dl className="activity-stats">
          <Stat label="Most active month" value={activeMonth ?? '—'} />
          <Stat label="Most active day" value={activeDay ?? '—'} />
          <Stat label="Longest streak" value={streaks.longest > 0 ? `${streaks.longest}d` : '—'} />
          <Stat label="Current streak" value={streaks.current > 0 ? `${streaks.current}d` : '—'} />
        </dl>
      </SettingsGroup>

      <SettingsGroup
        title="Token usage"
        icon={Coins}
        className="activity-group"
        action={
          <span className="activity-filters">
            <Select
              ariaLabel="Provider filter"
              value={provider}
              onChange={setProvider}
              options={[{ value: 'all', label: 'All providers' }, ...(usage?.providers ?? []).map((item) => ({ value: item, label: item }))]}
            />
            <Select
              ariaLabel="Model filter"
              value={model}
              onChange={setModel}
              options={[{ value: 'all', label: 'All models' }, ...(usage?.models ?? []).map((item) => ({ value: item, label: item }))]}
            />
          </span>
        }
      >
        <dl className="activity-stats usage-stats">
          <UsageCount label="Tokens in" value={hasUsage ? filteredUsage.totals.input : null} />
          <UsageCount label="Tokens out" value={hasUsage ? filteredUsage.totals.output : null} />
          <UsageCount label="Cached" value={hasUsage ? filteredUsage.totals.cacheRead + filteredUsage.totals.cacheWrite : null} />
          <UsageRatio label="Cache ratio" ratio={cacheEligible > 0 ? filteredUsage.totals.cacheRatio : null} />
        </dl>
      </SettingsGroup>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="activity-stat"><dt>{label}</dt><dd>{value}</dd></div>
}

const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/** Exact below 10,000 (1,284), compact above (12.9K, 1.2M); the exact count stays in the tooltip. */
function formatCount(value: number): string {
  return value < 10_000 ? value.toLocaleString() : compactFormat.format(value)
}

/** Token counts have no maximum, so they get a plain figure: number on top, label under it, no bar. */
function UsageCount({ label, value }: { label: string; value: number | null }) {
  return <div className="activity-stat usage-stat">
    <dt>{label}</dt>
    <dd title={value === null ? undefined : `${value.toLocaleString()} tokens`}>{value === null ? '—' : formatCount(value)}</dd>
  </div>
}

const GAUGE_SIZE = 30
const GAUGE_STROKE = 3
const GAUGE_RADIUS = (GAUGE_SIZE - GAUGE_STROKE) / 2
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS

/** A true 0–1 ratio: small ring gauge beside the figure. No ring at 0 or without data. */
function UsageRatio({ label, ratio }: { label: string; ratio: number | null }) {
  const percent = ratio === null ? null : Math.min(100, Math.max(0, ratio * 100))
  const text = percent === null ? '—' : `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
  return <div className="activity-stat usage-stat usage-stat-ratio">
    <dt>{label}</dt>
    <dd>
      {percent !== null && percent > 0 && (
        <svg className="usage-gauge" width={GAUGE_SIZE} height={GAUGE_SIZE} viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`} aria-hidden="true">
          <circle className="usage-gauge-track" cx={GAUGE_SIZE / 2} cy={GAUGE_SIZE / 2} r={GAUGE_RADIUS} strokeWidth={GAUGE_STROKE} />
          <circle
            className="usage-gauge-value"
            cx={GAUGE_SIZE / 2}
            cy={GAUGE_SIZE / 2}
            r={GAUGE_RADIUS}
            strokeWidth={GAUGE_STROKE}
            strokeDasharray={GAUGE_CIRCUMFERENCE}
            strokeDashoffset={GAUGE_CIRCUMFERENCE * (1 - percent / 100)}
            transform={`rotate(-90 ${GAUGE_SIZE / 2} ${GAUGE_SIZE / 2})`}
          />
        </svg>
      )}
      <span className="usage-stat-value">{text}</span>
    </dd>
  </div>
}
