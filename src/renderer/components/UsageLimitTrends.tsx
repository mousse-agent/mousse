import { useState } from 'react'
import { LIMIT_WINDOW_MS, type LimitTrend, type LimitTrendRange, type LimitTrendWindowId } from '../../shared/limitTrends'
import { TREND_BUCKETS, trendBucketStarts, trendValues } from '../lib/limitTrends'
import { Segmented, type SegmentedOption } from './settings/SettingsRow'
import { UsageAreaChart, type ChartGeometry } from './UsageAreaChart'
import { Select } from './ui/Select'

const RANGES: ReadonlyArray<SegmentedOption<LimitTrendRange>> = [
  { value: '24h', label: '24h', title: 'Last 24 hours' },
  { value: '7d', label: '7d', title: 'Last 7 days' },
  { value: '30d', label: '30d', title: 'Last 30 days' }
]
const COLOR: Record<LimitTrendWindowId, string> = {
  five_hour: 'var(--accent)',
  seven_day: 'var(--hue-5)'
}
const SCALE = { ticks: [25, 50, 75, 100], format: (value: number) => `${value}%` }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (value: number) => String(value).padStart(2, '0')
const clock = (at: Date) => `${two(at.getHours())}:${two(at.getMinutes())}`
const day = (at: Date) => `${MONTHS[at.getMonth()]} ${at.getDate()}`

/** A step's name: its time across a day, its date across a month, both across a week. */
function stepLabel(ms: number, range: LimitTrendRange): string {
  const at = new Date(ms)
  return range === '24h' ? clock(at) : range === '30d' ? day(at) : `${day(at)}, ${clock(at)}`
}

export interface UsageLimitTrendsProps {
  trends: readonly LimitTrend[]
  range: LimitTrendRange
  onRange: (range: LimitTrendRange) => void
  /** Across the person's computers the trends are still this computer's, and say so. */
  localOnly?: boolean
  now?: number
}

/**
 * The 5-hour and weekly limits over time, in the history's chart: one smooth area each, with faint marks where a
 * window reset and where even use would have put it. Hovering shows both at that moment.
 */
export function UsageLimitTrends({ trends, range, onRange, localOnly, now = Date.now() }: UsageLimitTrendsProps) {
  const [picked, setPicked] = useState(trends[0]?.id ?? '')
  const trend = trends.find((entry) => entry.id === picked) ?? trends[0]
  const starts = trendBucketStarts(range, now)
  const from = starts[0]!
  const span = TREND_BUCKETS[range].count * TREND_BUCKETS[range].ms
  // Across a month the 5-hour line is each day's peak: its many windows would be a wall of spikes.
  const windows = (trend?.windows ?? []).map((window) => ({
    ...window,
    label: range === '30d' && window.id === 'five_hour' ? '5-hour, daily peak' : window.label,
    values: trendValues(window, starts, now)
  }))
  // The weekly area underneath, the 5-hour one over it.
  const series = [...windows].sort((a, b) => (a.id === 'seven_day' ? -1 : 0) - (b.id === 'seven_day' ? -1 : 0))
    .map((window) => ({ id: window.id, label: window.label, color: COLOR[window.id], values: window.values }))
  // The 5-hour window's resets and even pace only across a day: across longer ranges they would crowd the chart.
  const marked = windows.filter((window) => window.id === 'seven_day' || range === '24h')

  const overlay = ({ xOfShare, yOf }: ChartGeometry) => {
    const xOf = (ms: number) => xOfShare((ms - from) / span)
    return <g className="usage-limit-marks">
      {marked.flatMap((window) => window.resets.map((ms) => <line key={`r-${window.id}-${ms}`} className="usage-limit-reset" x1={xOf(ms)} x2={xOf(ms)} y1={0} y2={yOf(0)} style={{ stroke: COLOR[window.id] }} />))}
      {/* Even pace: in each window, a straight line from none used at its start to all of it at its reset. */}
      {marked.flatMap((window) => {
        const length = LIMIT_WINDOW_MS[window.id]
        return [...window.resets, ...(window.nextReset ? [window.nextReset] : [])].flatMap((end) => {
          const start = end - length
          const a = Math.max(start, from)
          const b = Math.min(end, now)
          if (b <= a) return []
          const usedAt = (ms: number) => ((ms - start) / length) * 100
          return [<line key={`p-${window.id}-${end}`} className="usage-limit-pace" x1={xOf(a)} y1={yOf(usedAt(a))} x2={xOf(b)} y2={yOf(usedAt(b))} style={{ stroke: COLOR[window.id] }} />]
        })
      })}
    </g>
  }

  return <section className="settings-group usage-limit-trends" aria-labelledby="usage-limit-trends-title" data-testid="usage-limit-trends">
    <div className="settings-group-head">
      <h2 id="usage-limit-trends-title" className="settings-group-title">Trends</h2>
      {localOnly && <span className="usage-history-scope settings-muted" title="Limit readings stay on each device">This device only</span>}
      <div className="settings-group-action">
        {trends.length > 1 && <Select
          className="usage-history-filter"
          variant="menu"
          size="small"
          ariaLabel="Subscription"
          value={trend?.id ?? ''}
          onChange={setPicked}
          options={trends.map((entry) => ({ value: entry.id, label: entry.label }))}
        />}
        <Segmented value={range} options={RANGES} onChange={onRange} ariaLabel="Trend range" />
      </div>
    </div>
    {!trend
      ? <p className="settings-muted usage-empty" data-testid="usage-limit-trends-empty">No limit readings yet</p>
      : <div className="usage-history-card">
      <UsageAreaChart
        count={starts.length}
        series={series}
        stacked={false}
        scale={SCALE}
        ariaLabel={`${trend?.label ?? 'Limits'}: share of the 5-hour and weekly limits used, last ${range}`}
        xLabel={(index) => (index === starts.length - 1 ? 'Now' : range === '24h' ? clock(new Date(starts[index]!)) : day(new Date(starts[index]!)))}
        tipAt={(index) => ({
          head: <span>{stepLabel(starts[index]!, range)}</span>,
          rows: windows.flatMap((window) => {
            const value = window.values[index]
            return value === null || value === undefined ? [] : [{ key: window.id, color: COLOR[window.id], name: window.label, cells: <span>{Math.round(value)}% used</span> }]
          }),
          empty: 'No reading yet'
        })}
        overlay={overlay}
        readout={<span className="usage-limit-trends-legend">
          {windows.map((window) => <span key={window.id} className="usage-limit-legend-item">
            <span className="usage-limit-legend-line" style={{ background: COLOR[window.id] }} aria-hidden="true" />{window.label}
          </span>)}
          {marked.length > 0 && <span className="usage-limit-legend-item"><span className="usage-limit-legend-pace" aria-hidden="true" />Even pace</span>}
          {marked.length > 0 && <span className="usage-limit-legend-item"><span className="usage-limit-legend-reset" aria-hidden="true" />Reset</span>}
        </span>}
      />
    </div>}
  </section>
}
