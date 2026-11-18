import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react'
import { ProviderIcon } from '../lib/providerIcons'
import {
  AGENT_COLOR, AGENT_ICON, RANGE_WORDS, bucketLabel, compactNumber, dayLabel, measureValue, money, niceScale, percent, tokenSum,
  type UsageMeasure
} from '../lib/usageHistory'
import { USAGE_AGENT_LABELS, type UsageAgentId, type UsageHistoryRange, type UsageHistoryRequest, type UsageHistoryResponse, type UsageTokens } from '../../shared/usageHistory'
import { ALL_COMPUTERS, THIS_COMPUTER } from '../lib/subscriptionUsage'
import { machineStatusLabel } from '../lib/storageUsage'
import { mergeHistories, parseUsageHistory, UsageHistoryReplyError } from '../lib/usageHistoryDevices'
import { Segmented, type SegmentedOption } from './settings/SettingsRow'
import { DelayedLoader } from './ui/DelayedLoader'
import { Select, type SelectOption } from './ui/Select'

const RANGE_OPTIONS: ReadonlyArray<SegmentedOption<UsageHistoryRange>> = [
  { value: '24h', label: '24h', title: 'Last 24 hours' },
  { value: '7d', label: '7d', title: 'Last 7 days' },
  { value: '30d', label: '30d', title: 'Last 30 days' },
  { value: '90d', label: '90d', title: 'Last 90 days' }
]
const BREAKDOWN_OPTIONS: ReadonlyArray<SegmentedOption<'model' | 'day'>> = [
  { value: 'model', label: 'Model' },
  { value: 'day', label: 'Day' }
]
const STORE_KEY = 'mousse.usageHistory.view'
const SHORT_LIST = 8

interface View { range: UsageHistoryRange; agent: UsageAgentId | null; hidden: UsageAgentId[] }

function readView(): View {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<View>
    return {
      range: RANGE_OPTIONS.some((option) => option.value === stored.range) ? stored.range! : '30d',
      agent: typeof stored.agent === 'string' && Object.hasOwn(USAGE_AGENT_LABELS, stored.agent) ? stored.agent : null,
      hidden: Array.isArray(stored.hidden) ? stored.hidden : []
    }
  } catch {
    return { range: '30d', agent: null, hidden: [] }
  }
}

/** An agent the page has no colour or icon for yet still draws, in a spare hue and its own icon id. */
const SPARE_HUES = ['var(--hue-3)', 'var(--hue-6)', 'color-mix(in srgb, var(--hue-5) 50%, var(--hue-2))', 'color-mix(in srgb, var(--hue-1) 50%, var(--hue-6))']
const colorOf = (id: string, index: number) => AGENT_COLOR[id as UsageAgentId] ?? SPARE_HUES[index % SPARE_HUES.length]
const iconOf = (id: string) => AGENT_ICON[id as UsageAgentId] ?? id

const PLOT_H = 236
/** The thinnest a non-empty band or segment is drawn, so an agent with a sliver of the total stays visible. */
const MIN_BAND = 2

function useWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/** A smooth curve through the points that never overshoots them (monotone cubic). */
function smoothPath(points: ReadonlyArray<readonly [number, number]>, move = true): string {
  const n = points.length
  if (n === 0) return ''
  const fmt = (value: number) => Math.round(value * 10) / 10
  let path = `${move ? 'M' : 'L'}${fmt(points[0][0])},${fmt(points[0][1])}`
  if (n === 1) return path
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0]
    slope[i] = (points[i + 1][1] - points[i][1]) / dx[i]
  }
  const tangent: number[] = [slope[0]]
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0
      ? 0
      : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i])
  }
  tangent[n - 1] = slope[n - 2]
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const h = dx[i] / 3
    path += ` C${fmt(x0 + h)},${fmt(y0 + tangent[i] * h)} ${fmt(x1 - h)},${fmt(y1 - tangent[i + 1] * h)} ${fmt(x1)},${fmt(y1)}`
  }
  return path
}

interface ChartAgent { id: UsageAgentId; label: string; color: string; values: number[] }

/**
 * The history chart: a smooth stacked area, biggest agent at the bottom. Every agent with usage stays at
 * least a hairline thick. Hovering shows that hour or day's numbers in a small card.
 */
function HistoryChart({ history, measure, shown }: { history: UsageHistoryResponse; measure: UsageMeasure; shown: UsageAgentId[] }) {
  const gradientId = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const width = useWidth(plotRef)
  const count = history.buckets.length
  const agents: ChartAgent[] = history.agents
    .map((agent, index) => ({ id: agent.id, label: agent.label, color: colorOf(agent.id, index), values: (measure === 'cost' ? agent.costSeries : agent.series).slice(0, count) }))
    .filter((agent) => shown.includes(agent.id))
  const totals = history.buckets.map((_, i) => agents.reduce((sum, agent) => sum + (agent.values[i] ?? 0), 0))
  const ticks = niceScale(Math.max(0, ...totals))
  const top = ticks[ticks.length - 1] || 1
  const slot = width / Math.max(count, 1)
  const xAt = (i: number) => (i + 0.5) * slot
  const yOf = (pixels: number) => PLOT_H - pixels
  const labelAt = [0, Math.floor((count - 1) / 2), count - 1]
  const onMove = (event: MouseEvent) => {
    const box = plotRef.current?.getBoundingClientRect()
    if (!box) return
    const index = Math.floor(((event.clientX - box.left) / box.width) * count)
    setHover(index >= 0 && index < count ? index : null)
  }

  // Stacked heights in pixels, each band at least MIN_BAND where it has usage; the stack is fitted back into the plot.
  const stacks = history.buckets.map((_, i) => {
    let base = 0
    return agents.map((agent) => {
      const value = agent.values[i] ?? 0
      const height = value > 0 ? Math.max((value / top) * PLOT_H, MIN_BAND) : 0
      const band = { from: base, to: base + height }
      base += height
      return band
    })
  })
  const stackTop = Math.max(PLOT_H, ...stacks.map((bands) => bands[bands.length - 1]?.to ?? 0))
  const fit = stackTop > PLOT_H ? PLOT_H / stackTop : 1
  // Fills first, then each band's top edge, so a small agent reads as a thin coloured rim.
  const layers = width > 0 ? agents.map((agent, a) => ({
    agent,
    upper: stacks.map((bands, i) => [xAt(i), yOf(bands[a]!.to * fit)] as const),
    lower: stacks.map((bands, i) => [xAt(i), yOf(bands[a]!.from * fit)] as const).reverse()
  })) : []

  // The card sits beside the hovered hour or day, on the side with more room.
  const tip = hover === null ? null : {
    side: xAt(hover) > width / 2 ? 'left' as const : 'right' as const,
    x: xAt(hover),
    rows: agents.map((agent) => ({ agent, value: agent.values[hover] ?? 0 })).filter((row) => row.value > 0).sort((a, b) => b.value - a.value)
  }
  const tickY = (tick: number) => `${(1 - tick / top) * 100}%`
  const caption = `${agents.length === history.agents.length ? 'All agents' : `${agents.length} of ${history.agents.length} agents`} · ${count} ${history.bucket === 'day' ? 'days' : 'hours'}`

  return <div className="usage-history-chart">
    <div className="usage-history-plot-row">
      <div className="usage-history-axis" aria-hidden="true">
        {[...ticks].reverse().map((tick) => <span key={tick} style={{ top: tickY(tick) }}>{measureValue(measure, tick)}</span>)}
      </div>
      <div className="usage-history-plot" ref={plotRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img" aria-label={`${measure === 'cost' ? 'Cost' : 'Tokens'} per ${history.bucket}, ${RANGE_WORDS[history.range]}`}>
        {ticks.map((tick) => <span key={tick} className="usage-history-grid" style={{ top: tickY(tick) }} />)}
        {width > 0 && <svg width={width} height={PLOT_H} viewBox={`0 0 ${width} ${PLOT_H}`}>
          <defs>
            {agents.map((agent) => <linearGradient key={agent.id} id={`${gradientId}-${agent.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: agent.color, stopOpacity: 0.5 }} />
              <stop offset="100%" style={{ stopColor: agent.color, stopOpacity: 0.14 }} />
            </linearGradient>)}
          </defs>
          {hover !== null && <line className="usage-history-guide" x1={xAt(hover)} x2={xAt(hover)} y1={0} y2={PLOT_H} />}
          {layers.map(({ agent, upper, lower }) => <path key={`f-${agent.id}`} d={`${smoothPath(upper)} ${smoothPath(lower, false)} Z`} fill={`url(#${gradientId}-${agent.id})`} />)}
          {[...layers].reverse().map(({ agent, upper }, n) => <path key={`s-${agent.id}`} d={smoothPath(upper)} fill="none" stroke={agent.color}
            strokeWidth={n === layers.length - 1 ? 1.5 : 2} strokeLinejoin="round" />)}
        </svg>}
        {tip && <div className="usage-history-tip" data-side={tip.side} style={{ left: tip.x }} aria-hidden="true">
          <div className="usage-history-tip-head">
            <span>{bucketLabel(history, hover!)}</span>
            <span>{measureValue(measure, totals[hover!] ?? 0)}</span>
          </div>
          {tip.rows.length === 0 && <div className="usage-history-tip-row settings-muted">No usage</div>}
          {tip.rows.map(({ agent, value }) => <div key={agent.id} className="usage-history-tip-row">
            <span className="usage-history-tip-key" style={{ background: agent.color }} />
            <span className="usage-history-tip-name">{agent.label}</span>
            <span>{measureValue(measure, value)}</span>
          </div>)}
        </div>}
      </div>
    </div>
    <div className="usage-history-x" aria-hidden="true">
      {labelAt.map((index, n) => <span key={n} style={{ left: `${((index + 0.5) / count) * 100}%` }}>{bucketLabel(history, index)}</span>)}
    </div>
    <p className="usage-history-readout">{caption}</p>
  </div>
}

/** One small tinted tile per agent: its name, figure and share. A click takes it in or out of the chart. */
function AgentTile({ agent, index, measure, total, hidden, onToggle }: {
  agent: UsageHistoryResponse['agents'][number]
  index: number
  measure: UsageMeasure
  total: number
  hidden: boolean
  onToggle: () => void
}) {
  const tokens = tokenSum(agent.tokens)
  const value = measure === 'cost' ? agent.costUsd : tokens
  const detail = [
    `${agent.sessions.toLocaleString('en-US')} session${agent.sessions === 1 ? '' : 's'}`,
    measure === 'cost' ? `${compactNumber(tokens)} tokens` : money(agent.costUsd)
  ].join(' · ')
  return <button
    type="button"
    className="usage-agent-tile"
    data-testid="usage-agent-tile"
    data-agent={agent.id}
    aria-pressed={!hidden}
    title={`${agent.label}: ${detail}\n${hidden ? 'Hidden from the chart. Click to show it.' : 'Click to hide it from the chart.'}`}
    style={{ '--agent': colorOf(agent.id, index) } as CSSProperties}
    onClick={onToggle}
  >
    <span className="usage-agent-tile-head">
      <ProviderIcon providerId={iconOf(agent.id)} size={13} />
      <span className="usage-agent-tile-name">{agent.label}</span>
    </span>
    <span className="usage-agent-tile-value">{measureValue(measure, value)}</span>
    <span className="usage-agent-tile-line">{hidden ? 'hidden from chart' : `${percent(value, total)} of ${measure === 'cost' ? 'cost' : 'tokens'}`}</span>
  </button>
}

interface KindSlice { key: string; label: string; value: number; color: string }

/** The four kinds of token, in plain words, each in its own tint of the accent. */
const KIND_ROWS: ReadonlyArray<{ key: keyof UsageTokens; label: string; color: string }> = [
  { key: 'cacheRead', label: 'Reused from cache', color: 'color-mix(in srgb, var(--accent) 88%, transparent)' },
  { key: 'cacheWrite', label: 'Saved to cache', color: 'color-mix(in srgb, var(--accent) 58%, transparent)' },
  { key: 'input', label: 'New input', color: 'color-mix(in srgb, var(--accent) 34%, transparent)' },
  { key: 'output', label: 'Written by the model', color: 'color-mix(in srgb, var(--text-secondary) 55%, transparent)' }
]
const DONUT = 132
const RING = 14

/** A soft ring of the token kinds (or their cost), the total in its middle and a legend beside it. */
function KindsDonut({ history, measure }: { history: UsageHistoryResponse; measure: UsageMeasure }) {
  const by = measure === 'cost' ? history.costByKind : history.totals
  const slices: KindSlice[] = KIND_ROWS.map((row) => ({ key: row.key, label: row.label, value: by[row.key], color: row.color }))
  if (measure === 'cost' && history.costUnsplitUsd > 0) {
    slices.push({ key: 'unsplit', label: 'Not split by kind', value: history.costUnsplitUsd, color: 'color-mix(in srgb, var(--text-secondary) 25%, transparent)' })
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const radius = (DONUT - RING) / 2
  const circumference = 2 * Math.PI * radius
  const drawn = slices.filter((slice) => slice.value > 0)
  // A small gap between slices; a slice too thin for its gap still shows as a dot.
  const gap = drawn.length > 1 ? 3 : 0
  let offset = 0
  const arcs = drawn.map((slice) => {
    const length = (slice.value / total) * circumference
    const arc = { slice, dash: Math.max(length - gap, 0.5), start: offset }
    offset += length
    return arc
  })
  return <div className="usage-history-kinds" data-testid="usage-history-kinds">
    <div className="usage-history-donut">
      <svg width={DONUT} height={DONUT} viewBox={`0 0 ${DONUT} ${DONUT}`} aria-hidden="true">
        <circle cx={DONUT / 2} cy={DONUT / 2} r={radius} fill="none" stroke="color-mix(in srgb, var(--ui-line) 60%, transparent)" strokeWidth={RING} />
        {arcs.map(({ slice, dash, start }) => <circle key={slice.key} cx={DONUT / 2} cy={DONUT / 2} r={radius} fill="none"
          stroke={slice.color} strokeWidth={RING}
          strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-start}
          transform={`rotate(-90 ${DONUT / 2} ${DONUT / 2})`} />)}
      </svg>
      <div className="usage-history-donut-centre">
        <span className="usage-history-donut-value">{measureValue(measure, total)}</span>
        <span className="usage-history-donut-unit settings-muted">{measure === 'cost' ? 'cost' : 'tokens'}</span>
      </div>
    </div>
    <ul className="usage-history-legend" aria-label={measure === 'cost' ? 'Cost by kind of token' : 'Tokens by kind'}>
      {slices.map((slice) => <li key={slice.key} className="usage-history-legend-row">
        <span className="usage-history-legend-key" style={{ background: slice.color }} aria-hidden="true" />
        <span className="usage-history-legend-label">{slice.label}</span>
        <span className="usage-history-legend-value">{measureValue(measure, slice.value)}</span>
        <span className="usage-history-legend-share settings-muted">{percent(slice.value, total)}</span>
      </li>)}
    </ul>
  </div>
}

function Breakdown({ history, measure }: { history: UsageHistoryResponse; measure: UsageMeasure }) {
  const [by, setBy] = useState<'model' | 'day'>('model')
  const [all, setAll] = useState(false)
  const total = measure === 'cost' ? history.costUsd : tokenSum(history.totals)
  const rows = by === 'model' ? history.models : history.days
  const count = all ? rows.length : Math.min(rows.length, SHORT_LIST)
  const agentIndex = (id: UsageAgentId) => Math.max(0, history.agents.findIndex((agent) => agent.id === id))
  const shareBar = (value: number, color: string) => <span className="usage-history-share-bar" aria-hidden="true">
    <span style={{ width: `${Math.max(total > 0 ? (value / total) * 100 : 0, value > 0 ? 0.8 : 0)}%`, background: color }} />
  </span>
  return <section className="usage-history-block usage-history-breakdown" aria-labelledby="usage-breakdown-title">
    <div className="usage-history-block-head">
      <h3 id="usage-breakdown-title">Breakdown</h3>
      <Segmented value={by} options={BREAKDOWN_OPTIONS} onChange={(value) => { setBy(value); setAll(false) }} ariaLabel="Break down by" />
    </div>
    <table className="usage-history-table" data-testid="usage-history-table">
      <thead>
        <tr>
          {by === 'model' && <th scope="col" className="usage-history-rank">#</th>}
          <th scope="col">{by === 'model' ? 'Model' : 'Day'}</th>
          <th scope="col">{by === 'model' ? 'Agent' : 'Sessions'}</th>
          <th scope="col" className="is-num">Tokens</th>
          <th scope="col" className="is-num">Cost</th>
          <th scope="col" className="is-num">Share</th>
        </tr>
      </thead>
      <tbody>
        {by === 'model'
          ? history.models.slice(0, count).map((row, rank) => {
              const value = measure === 'cost' ? row.costUsd : row.tokens
              return <tr key={`${row.agent}:${row.model}`}>
                <td className="usage-history-rank settings-muted">{rank + 1}</td>
                <td className="usage-history-name">
                  <span className="usage-history-model"><ProviderIcon providerId={iconOf(row.agent)} size={14} />{row.model}</span>
                  {shareBar(value, colorOf(row.agent, agentIndex(row.agent)))}
                </td>
                <td className="settings-muted">{USAGE_AGENT_LABELS[row.agent] ?? row.agent}</td>
                <td className="is-num">{compactNumber(row.tokens)}</td>
                <td className="is-num">{row.priced ? money(row.costUsd) : <span className="settings-muted" title="No list price for this model">no price</span>}</td>
                <td className="is-num settings-muted">{percent(value, total)}</td>
              </tr>
            })
          : history.days.slice(0, count).map((row) => {
              const value = measure === 'cost' ? row.costUsd : row.tokens
              return <tr key={row.day}>
                <td className="usage-history-name">
                  <span className="usage-history-model">{dayLabel(row.day)}</span>
                  {shareBar(value, 'color-mix(in srgb, var(--accent) 70%, transparent)')}
                </td>
                <td className="settings-muted">{row.sessions.toLocaleString('en-US')}</td>
                <td className="is-num">{compactNumber(row.tokens)}</td>
                <td className="is-num">{money(row.costUsd)}</td>
                <td className="is-num settings-muted">{percent(value, total)}</td>
              </tr>
            })}
      </tbody>
    </table>
    {rows.length > SHORT_LIST && <button type="button" className="usage-text-btn usage-history-more" onClick={() => setAll((value) => !value)}>
      {all ? 'Show fewer' : `Show all ${rows.length}`}
    </button>}
    {count === 0 && <p className="settings-muted usage-history-note">Nothing in this range.</p>}
  </section>
}

/** A computer that didn't send its history: its name and why, in a few words. */
export interface UsageDeviceGap { name: string; reason: string }

function SourcesLine({ history, devices, gaps, waiting }: { history: UsageHistoryResponse; devices: number; gaps: readonly UsageDeviceGap[]; waiting: readonly string[] }) {
  const read = history.sources.filter((source) => source.status !== 'missing')
  // An agent counts as missing only when no computer read any of its logs.
  const missing = [...new Set(history.sources.map((source) => source.agent))]
    .filter((agent) => !read.some((source) => source.agent === agent)).map((agent) => USAGE_AGENT_LABELS[agent])
  const files = read.reduce((sum, source) => sum + source.files, 0)
  const detail = history.sources.filter((source) => source.path)
    .map((source) => `${USAGE_AGENT_LABELS[source.agent]}: ${source.status === 'missing' ? 'no logs at' : `${source.files} files in`} ${source.path}`).join('\n')
  const at = new Date(history.readAt)
  return <p className="usage-history-sources settings-muted" title={detail || undefined} data-testid="usage-history-sources">
    Read from each agent&apos;s own logs on {devices > 1 ? `${devices} computers` : 'this computer'} · {files.toLocaleString('en-US')} files · {(history.scanMs / 1000).toFixed(1)} s · {String(at.getHours()).padStart(2, '0')}:{String(at.getMinutes()).padStart(2, '0')}
    {missing.length > 0 && <> · no logs for {missing.join(', ')}</>}
    {read.some((source) => source.status === 'partial') && <> · some files couldn&apos;t be read</>}
    {waiting.length > 0 && <> · still reading {waiting.join(', ')}</>}
    {gaps.map((gap) => <span key={gap.name}> · {gap.name}: {gap.reason.toLowerCase()}</span>)}
  </p>
}

export interface UsageDevices { selfName: string; others: ReadonlyArray<{ id: string; name: string }> }

export interface UsageHistoryViewProps {
  history: UsageHistoryResponse | null
  loading: boolean
  failed: boolean
  range: UsageHistoryRange
  measure: UsageMeasure
  /** The one agent shown, or every agent. */
  agent: UsageAgentId | null
  hidden: readonly UsageAgentId[]
  /** The computer picker, only when the person has other computers. */
  devices?: UsageDevices
  device?: string
  onDevice?: (device: string) => void
  /** How many computers the history adds up, which ones are still reading, and which ones couldn't send it. */
  deviceCount?: number
  waiting?: readonly string[]
  gaps?: readonly UsageDeviceGap[]
  onRange: (range: UsageHistoryRange) => void
  onAgent: (agent: UsageAgentId | null) => void
  onToggle: (agent: UsageAgentId) => void
}

const ALL_AGENTS = 'all'

export function UsageHistoryView({ history, loading, failed, range, measure, agent, hidden, devices, device, onDevice, deviceCount = 1, waiting = [], gaps = [], onRange, onAgent, onToggle }: UsageHistoryViewProps) {
  const shown = useMemo(() => (history?.agents ?? []).map((row) => row.id).filter((id) => !hidden.includes(id)), [history, hidden])
  const total = history ? (measure === 'cost' ? history.costUsd : tokenSum(history.totals)) : 0
  const agentIds = [...new Set([...(history?.agentIds ?? []), ...(agent ? [agent] : [])])]
  const agentOptions: ReadonlyArray<SelectOption<string>> = [
    { value: ALL_AGENTS, label: 'All providers' },
    ...agentIds.map((id) => ({ value: id, textValue: USAGE_AGENT_LABELS[id], label: <span className="usage-history-option"><ProviderIcon providerId={iconOf(id)} size={13} />{USAGE_AGENT_LABELS[id]}</span> }))
  ]
  return <section className="settings-group usage-history" aria-labelledby="usage-history-title" data-testid="usage-history">
    <div className="settings-group-head">
      <h2 id="usage-history-title" className="settings-group-title">History</h2>
      <div className="settings-group-action">
        {devices && <Select
          className="usage-history-filter"
          variant="menu"
          size="small"
          ariaLabel="Computer"
          data-testid="usage-history-device"
          value={device ?? ALL_COMPUTERS}
          onChange={(value) => onDevice?.(value)}
          options={[
            { value: ALL_COMPUTERS, label: 'All devices' },
            { value: THIS_COMPUTER, label: `${devices.selfName} · this device` },
            ...devices.others.map((other) => ({ value: other.id, label: other.name }))
          ]}
        />}
        <Select
          className="usage-history-filter"
          variant="menu"
          size="small"
          ariaLabel="Provider"
          data-testid="usage-history-agent"
          value={agent ?? ALL_AGENTS}
          onChange={(value) => onAgent(value === ALL_AGENTS ? null : value as UsageAgentId)}
          options={agentOptions}
        />
        <Segmented value={range} options={RANGE_OPTIONS} onChange={onRange} ariaLabel="Range" />
      </div>
    </div>
    {!history && loading && <div className="usage-history-loading">
      <DelayedLoader label="Reading agent logs" className="usage-loader" />
      <p className="settings-muted">Reading the coding agents&apos; logs. The first read takes longest.</p>
    </div>}
    {!history && !loading && failed && <p className="usage-history-note settings-status-bad">
      Couldn&apos;t read usage history.{gaps.map((gap) => <span key={gap.name} className="settings-muted"> {gap.name}: {gap.reason.toLowerCase()}.</span>)}
    </p>}
    {history && <div className={`usage-history-body${loading ? ' is-refreshing' : ''}`}>
      <div className="usage-history-headline">
        <span className="usage-history-total" data-testid="usage-history-total">{measureValue(measure, total)}</span>
        <span className="usage-history-total-unit">{measure === 'cost' ? 'at list prices' : 'tokens'}</span>
        <span className="usage-history-total-sub settings-muted">
          {history.sessions.toLocaleString('en-US')} sessions · {measure === 'cost' ? `${compactNumber(tokenSum(history.totals))} tokens` : money(history.costUsd)} · {RANGE_WORDS[history.range]}
        </span>
      </div>
      {history.agents.length === 0
        ? <p className="usage-history-note settings-muted">No {agent ? USAGE_AGENT_LABELS[agent] : 'agent'} usage in the {RANGE_WORDS[history.range]}.</p>
        : <>
            <div className="usage-history-top">
              <div className="usage-history-card">
                <HistoryChart history={history} measure={measure} shown={shown} />
              </div>
              <div className="usage-agent-tiles" role="group" aria-label="Agents in the chart">
                {history.agents.map((row, index) => <AgentTile key={row.id} agent={row} index={index} measure={measure} total={total} hidden={hidden.includes(row.id)} onToggle={() => onToggle(row.id)} />)}
              </div>
            </div>
            <section className="usage-history-block usage-history-kinds-block" aria-labelledby="usage-kinds-title">
              <div className="usage-history-block-head"><h3 id="usage-kinds-title">{measure === 'cost' ? 'Cost by kind' : 'Tokens by kind'}</h3></div>
              <KindsDonut history={history} measure={measure} />
              {history.cacheSavingsUsd > 0 && <p className="usage-history-note settings-muted">
                Reusing cached input saved about {money(history.cacheSavingsUsd)} against paying full input prices.
              </p>}
            </section>
            <Breakdown history={history} measure={measure} />
          </>}
      <SourcesLine history={history} devices={deviceCount} gaps={gaps} waiting={waiting} />
    </div>}
  </section>
}

/** What a computer's read gave: its history, or why there is none. */
interface DeviceRead { name: string; history?: UsageHistoryResponse; reason?: string }

/** Reads one computer's history; a reply that isn't one is unavailable, never drawn. */
async function readDevice(name: string, read: () => Promise<unknown>): Promise<DeviceRead> {
  try {
    return { name, history: parseUsageHistory(await read()) }
  } catch (error) {
    return { name, reason: error instanceof UsageHistoryReplyError ? 'Sent an unreadable reply' : machineStatusLabel(error) }
  }
}

export interface UsageHistorySectionProps {
  measure: UsageMeasure
  /** The person's other computers, when there are any, and the one picked (All devices by default). */
  devices?: UsageDevices
  device?: string
  onDevice?: (device: string) => void
}

/**
 * Reads the history for the picked range, provider and computer, and keeps the page's choices between visits.
 * Each computer reads its own logs and sends only the totals; with All devices they are added up as they arrive.
 */
export function UsageHistorySection({ measure, devices, device = ALL_COMPUTERS, onDevice }: UsageHistorySectionProps) {
  const [view, setView] = useState<View>(readView)
  const [reads, setReads] = useState<DeviceRead[]>([])
  const [waiting, setWaiting] = useState<string[]>([])
  const generation = useRef(0)
  const update = useCallback((change: Partial<View>) => {
    setView((current) => {
      const next = { ...current, ...change }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)) } catch { /* private storage off */ }
      return next
    })
  }, [])
  const picked = devices ? device : THIS_COMPUTER
  const selfName = devices?.selfName ?? 'This computer'
  const othersKey = JSON.stringify(devices?.others ?? [])
  useEffect(() => {
    const run = ++generation.current
    const others = JSON.parse(othersKey) as UsageDevices['others']
    const request: UsageHistoryRequest = { range: view.range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(view.agent ? { agent: view.agent } : {}) }
    const targets: Array<{ name: string; read: () => Promise<unknown> }> = []
    if (picked === ALL_COMPUTERS || picked === THIS_COMPUTER) targets.push({ name: selfName, read: () => window.mousse.providers.usageHistory(request) })
    for (const other of others) {
      if (picked === ALL_COMPUTERS || picked === other.id) {
        targets.push({ name: other.name, read: () => window.mousse.platformRequest.request('bridge.hub.usageHistory', { target: other.id, ...request }) })
      }
    }
    setWaiting(targets.map((target) => target.name))
    // By position, since two computers may share a name.
    const arrived = new Map<number, DeviceRead>()
    targets.forEach((target, index) => {
      void readDevice(target.name, target.read).then((result) => {
        if (generation.current !== run) return
        arrived.set(index, result)
        // In the computers' own order, so the merged chart doesn't depend on which answered first.
        setReads(targets.flatMap((_, at) => arrived.get(at) ?? []))
        setWaiting(targets.flatMap((entry, at) => (arrived.has(at) ? [] : [entry.name])))
      })
    })
  }, [view.range, view.agent, picked, othersKey, selfName])
  const history = useMemo(() => {
    const histories = reads.flatMap((read) => read.history ?? [])
    return histories.length ? mergeHistories(histories) : null
  }, [reads])
  const gaps = reads.flatMap((read) => (read.reason ? [{ name: read.name, reason: read.reason }] : []))
  const answered = reads.length - gaps.length
  return <UsageHistoryView
    history={history}
    loading={waiting.length > 0}
    failed={waiting.length === 0 && !history}
    range={view.range}
    measure={measure}
    agent={view.agent}
    hidden={view.hidden}
    {...(devices ? { devices, device: picked, ...(onDevice ? { onDevice } : {}) } : {})}
    deviceCount={answered}
    waiting={history ? waiting : []}
    gaps={devices ? gaps : []}
    onRange={(range) => update({ range })}
    onAgent={(agent) => update({ agent })}
    onToggle={(agent) => update({ hidden: view.hidden.includes(agent) ? view.hidden.filter((id) => id !== agent) : [...view.hidden, agent] })}
  />
}
