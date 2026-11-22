import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ProviderIcon } from '../lib/providerIcons'
import { selectThread } from '../lib/threadActions'
import {
  AGENT_COLOR, AGENT_ICON, RANGE_WORDS, bucketLabel, compactMoney, compactNumber, dayLabel, measureValue, money, niceScale, percent, tokenSum,
  type UsageMeasure
} from '../lib/usageHistory'
import { UsageAreaChart } from './UsageAreaChart'
import { USAGE_AGENT_LABELS, type UsageAgentId, type UsageCostBySpeed, type UsageHistoryRange, type UsageHistoryRequest, type UsageHistoryResponse, type UsageTokens } from '../../shared/usageHistory'
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

/**
 * The history chart: tokens as a smooth stacked area, biggest agent at the bottom, and cost as one thin line on
 * top, read on the right-hand scale. Hovering shows that hour or day's tokens and cost in a small card.
 */
function HistoryChart({ history, shown }: { history: UsageHistoryResponse; shown: UsageAgentId[] }) {
  const count = history.buckets.length
  const agents = history.agents
    .map((agent, index) => ({ id: agent.id, label: agent.label, color: colorOf(agent.id, index), values: agent.series.slice(0, count), costs: agent.costSeries.slice(0, count) }))
    .filter((agent) => shown.includes(agent.id))
  const totals = history.buckets.map((_, i) => agents.reduce((sum, agent) => sum + (agent.values[i] ?? 0), 0))
  const costs = history.buckets.map((_, i) => agents.reduce((sum, agent) => sum + (agent.costs[i] ?? 0), 0))
  const who = agents.length === history.agents.length ? 'All agents' : `${agents.length} of ${history.agents.length} agents`
  return <UsageAreaChart
    count={count}
    series={agents}
    stacked
    // Both scales have three steps, so their gridlines fall on the same heights.
    scale={{ ticks: niceScale(Math.max(0, ...totals)), format: compactNumber }}
    line={{ values: costs, scale: { ticks: niceScale(Math.max(0, ...costs)), format: compactMoney } }}
    ariaLabel={`Tokens and cost per ${history.bucket}, ${RANGE_WORDS[history.range]}`}
    xLabel={(index) => bucketLabel(history, index)}
    tipAt={(index) => ({
      head: <><span>{bucketLabel(history, index)}</span><span>{compactNumber(totals[index] ?? 0)}</span><span className="usage-history-tip-cost">{compactMoney(costs[index] ?? 0)}</span></>,
      rows: agents
        .map((agent) => ({ agent, value: agent.values[index] ?? 0, cost: agent.costs[index] ?? 0 }))
        .filter((row) => row.value > 0 || row.cost > 0)
        .sort((a, b) => b.value - a.value)
        .map(({ agent, value, cost }) => ({ key: agent.id, color: agent.color, name: agent.label, cells: <><span>{compactNumber(value)}</span><span className="usage-history-tip-cost">{compactMoney(cost)}</span></> })),
      empty: 'No usage'
    })}
    readout={<>
      <span className="usage-history-readout-key is-area" aria-hidden="true" />Tokens, {who}
      <span className="usage-history-readout-key is-line" aria-hidden="true" />Cost, right scale
      <span className="usage-history-readout-span"> · {count} {history.bucket === 'day' ? 'days' : 'hours'}</span>
    </>}
  />
}

/** One small tinted tile per agent: its name, tokens and cost, and its share. A click takes it in or out of the chart. */
function AgentTile({ agent, index, total, hidden, onToggle }: {
  agent: UsageHistoryResponse['agents'][number]
  index: number
  total: number
  hidden: boolean
  onToggle: () => void
}) {
  const tokens = tokenSum(agent.tokens)
  const sessions = `${agent.sessions.toLocaleString('en-US')} session${agent.sessions === 1 ? '' : 's'}`
  return <button
    type="button"
    className="usage-agent-tile"
    data-testid="usage-agent-tile"
    data-agent={agent.id}
    aria-pressed={!hidden}
    title={`${agent.label}: ${compactNumber(tokens)} tokens · ${money(agent.costUsd)} · ${sessions}\n${hidden ? 'Hidden from the chart. Click to show it.' : 'Click to hide it from the chart.'}`}
    style={{ '--agent': colorOf(agent.id, index) } as CSSProperties}
    onClick={onToggle}
  >
    <span className="usage-agent-tile-head">
      <ProviderIcon providerId={iconOf(agent.id)} size={13} />
      <span className="usage-agent-tile-name">{agent.label}</span>
    </span>
    <span className="usage-agent-tile-figures">
      <span className="usage-agent-tile-value">{compactNumber(tokens)}</span>
      <span className="usage-agent-tile-cost">{compactMoney(agent.costUsd)}</span>
    </span>
    <span className="usage-agent-tile-line">{hidden ? 'hidden from chart' : `${percent(tokens, total)} of tokens`}</span>
  </button>
}

interface KindSlice { key: string; label: string; value: number; color: string; title?: string }

/** The four kinds of token, in plain words, each in its own light tint of the accent. */
const KIND_ROWS: ReadonlyArray<{ key: keyof UsageTokens; label: string; color: string }> = [
  { key: 'cacheRead', label: 'Reused from cache', color: 'color-mix(in srgb, var(--accent) 88%, transparent)' },
  { key: 'cacheWrite', label: 'Saved to cache', color: 'color-mix(in srgb, var(--accent) 58%, transparent)' },
  { key: 'input', label: 'New input', color: 'color-mix(in srgb, var(--accent) 34%, transparent)' },
  { key: 'output', label: 'Written by the model', color: 'color-mix(in srgb, var(--text-secondary) 55%, transparent)' }
]
const UNSPLIT_COLOR = 'color-mix(in srgb, var(--text-secondary) 25%, transparent)'
const SPEED_ROWS: ReadonlyArray<{ key: keyof UsageCostBySpeed; label: string; color: string; title?: string }> = [
  { key: 'fast', label: 'Fast mode', color: 'color-mix(in srgb, var(--accent) 88%, transparent)' },
  { key: 'standard', label: 'Standard', color: 'color-mix(in srgb, var(--accent) 42%, transparent)' },
  { key: 'unknown', label: 'Unknown', color: UNSPLIT_COLOR, title: "The agent's logs don't say which speed it used" }
]

/** The three splits under the chart: tokens by kind, cost by kind and cost by speed. */
function splits(history: UsageHistoryResponse): Array<{ id: string; title: string; measure: UsageMeasure; slices: KindSlice[] }> {
  const costKinds: KindSlice[] = KIND_ROWS.map((row) => ({ key: row.key, label: row.label, value: history.costByKind[row.key], color: row.color }))
  if (history.costUnsplitUsd > 0) costKinds.push({ key: 'unsplit', label: 'Not split by kind', value: history.costUnsplitUsd, color: UNSPLIT_COLOR })
  return [
    { id: 'tokens-kind', title: 'Tokens by kind', measure: 'tokens', slices: KIND_ROWS.map((row) => ({ key: row.key, label: row.label, value: history.totals[row.key], color: row.color })) },
    { id: 'cost-kind', title: 'Cost by kind', measure: 'cost', slices: costKinds },
    { id: 'cost-speed', title: 'Cost by speed', measure: 'cost', slices: SPEED_ROWS.map((row) => ({ ...row, value: history.costBySpeed[row.key] })) }
  ]
}

/** One split as a single compact bar, with a plain-word legend under it: each part's value and share. */
function SplitBar({ id, title, measure, slices }: { id: string; title: string; measure: UsageMeasure; slices: KindSlice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return <div className="usage-history-split" data-testid={`usage-history-${id}`}>
    <div className="usage-history-split-head">
      <h3>{title}</h3>
      <span className="usage-history-split-total">{measureValue(measure, total)}</span>
    </div>
    <div className="usage-history-split-bar" aria-hidden="true">
      {/* A part with any value stays a sliver wide, so a small one is still seen. */}
      {slices.filter((slice) => slice.value > 0).map((slice) => <span key={slice.key}
        style={{ flexGrow: total > 0 ? slice.value / total : 0, flexBasis: 0, minWidth: 4, backgroundColor: slice.color }} />)}
    </div>
    <ul className="usage-history-legend" aria-label={title}>
      {slices.map((slice) => <li key={slice.key} className="usage-history-legend-row" title={slice.title}>
        <span className="usage-history-legend-key" style={{ background: slice.color }} aria-hidden="true" />
        <span className="usage-history-legend-label">{slice.label}</span>
        <span className="usage-history-legend-value">{measureValue(measure, slice.value)}</span>
        <span className="usage-history-legend-share settings-muted">{percent(slice.value, total)}</span>
      </li>)}
    </ul>
  </div>
}

function Breakdown({ history }: { history: UsageHistoryResponse }) {
  const [by, setBy] = useState<'model' | 'day'>('model')
  const [all, setAll] = useState(false)
  const total = tokenSum(history.totals)
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
          <th scope="col" className="is-num" title="Share of tokens">Share</th>
        </tr>
      </thead>
      <tbody>
        {by === 'model'
          ? history.models.slice(0, count).map((row, rank) => {
              const value = row.tokens
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
              const value = row.tokens
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

/** Whose projects and sessions the lists show: this computer's, this one's among others', or none (another computer picked). */
export type UsageLocalScope = 'self' | 'mixed' | 'other'

/** Cost by project, ranked like the breakdown. Worked out on this computer from the agents' folders. */
function ProjectsList({ history, scope }: { history: UsageHistoryResponse; scope: UsageLocalScope }) {
  const [all, setAll] = useState(false)
  const rows = history.projects
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0)
  const count = all ? rows.length : Math.min(rows.length, SHORT_LIST)
  return <section className="usage-history-block" aria-labelledby="usage-projects-title" data-testid="usage-history-projects">
    <div className="usage-history-block-head">
      <h3 id="usage-projects-title">Cost by project</h3>
      {scope === 'mixed' && <span className="usage-history-scope settings-muted" title="Project names stay on each device">This device only</span>}
    </div>
    {scope === 'other'
      ? <p className="settings-muted usage-history-note">Project names stay on each device. Pick this device to see its projects.</p>
      : <table className="usage-history-table">
          <thead>
            <tr>
              <th scope="col" className="usage-history-rank">#</th>
              <th scope="col">Project</th>
              <th scope="col">Sessions</th>
              <th scope="col" className="is-num">Tokens</th>
              <th scope="col" className="is-num">Cost</th>
              <th scope="col" className="is-num" title="Share of cost">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, count).map((row, rank) => <tr key={row.name}>
              <td className="usage-history-rank settings-muted">{rank + 1}</td>
              <td className="usage-history-name">
                <span className="usage-history-model" title={row.name}>{row.name}</span>
                <span className="usage-history-share-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(total > 0 ? (row.costUsd / total) * 100 : 0, row.costUsd > 0 ? 0.8 : 0)}%`, background: 'color-mix(in srgb, var(--accent) 70%, transparent)' }} />
                </span>
              </td>
              <td className="settings-muted">{row.sessions.toLocaleString('en-US')}</td>
              <td className="is-num">{compactNumber(row.tokens)}</td>
              <td className="is-num">{money(row.costUsd)}</td>
              <td className="is-num settings-muted">{percent(row.costUsd, total)}</td>
            </tr>)}
          </tbody>
        </table>}
    {scope !== 'other' && rows.length > SHORT_LIST && <button type="button" className="usage-text-btn usage-history-more" onClick={() => setAll((value) => !value)}>
      {all ? 'Show fewer' : `Show all ${rows.length}`}
    </button>}
    {scope !== 'other' && rows.length === 0 && <p className="settings-muted usage-history-note">Nothing in this range.</p>}
  </section>
}

/** The five priciest sessions, each opening its thread where Mousse ran it. */
function PriciestSessions({ history, scope }: { history: UsageHistoryResponse; scope: UsageLocalScope }) {
  if (scope === 'other' || history.topSessions.length === 0) return null
  return <section className="usage-history-block" aria-labelledby="usage-sessions-title" data-testid="usage-history-sessions">
    <div className="usage-history-block-head">
      <h3 id="usage-sessions-title">Priciest sessions</h3>
      {scope === 'mixed' && <span className="usage-history-scope settings-muted">This device only</span>}
    </div>
    <table className="usage-history-table usage-history-sessions">
      <thead>
        <tr>
          <th scope="col" className="usage-history-rank">#</th>
          <th scope="col">Session</th>
          <th scope="col">Last active</th>
          <th scope="col" className="is-num">Tokens</th>
          <th scope="col" className="is-num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {history.topSessions.map((row, rank) => {
          const name = row.threadId ? row.title || 'Untitled thread' : `${USAGE_AGENT_LABELS[row.agent]} session`
          const last = new Date(row.lastAt)
          return <tr key={`${row.agent}:${row.session}`}>
            <td className="usage-history-rank settings-muted">{rank + 1}</td>
            <td className="usage-history-name">
              <span className="usage-history-model">
                <ProviderIcon providerId={iconOf(row.agent)} size={14} />
                {row.threadId
                  ? <button type="button" className="usage-history-session-link" data-testid="usage-session-link" title="Open this thread" onClick={() => void selectThread(row.threadId!)}>{name}</button>
                  : <span title={`Not run in Mousse · ${row.session}`}>{name}</span>}
              </span>
              <span className="usage-history-session-meta settings-muted">{row.project} · {row.model}</span>
            </td>
            <td className="settings-muted">{dayLabel(`${last.getFullYear()}-${last.getMonth() + 1}-${last.getDate()}`)}</td>
            <td className="is-num">{compactNumber(row.tokens)}</td>
            <td className="is-num">{money(row.costUsd)}</td>
          </tr>
        })}
      </tbody>
    </table>
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
  /** The one agent shown, or every agent. */
  agent: UsageAgentId | null
  hidden: readonly UsageAgentId[]
  /** The computer picker, only when the person has other computers. */
  devices?: UsageDevices
  device?: string
  onDevice?: (device: string) => void
  /** Whose projects and priciest sessions show: they never leave their own computer. */
  localScope?: UsageLocalScope
  /** How many computers the history adds up, which ones are still reading, and which ones couldn't send it. */
  deviceCount?: number
  waiting?: readonly string[]
  gaps?: readonly UsageDeviceGap[]
  onRange: (range: UsageHistoryRange) => void
  onAgent: (agent: UsageAgentId | null) => void
  onToggle: (agent: UsageAgentId) => void
}

const ALL_AGENTS = 'all'

export function UsageHistoryView({ history, loading, failed, range, agent, hidden, devices, device, onDevice, localScope = 'self', deviceCount = 1, waiting = [], gaps = [], onRange, onAgent, onToggle }: UsageHistoryViewProps) {
  const shown = useMemo(() => (history?.agents ?? []).map((row) => row.id).filter((id) => !hidden.includes(id)), [history, hidden])
  const total = history ? tokenSum(history.totals) : 0
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
        <span className="usage-history-figure">
          <span className="usage-history-total" data-testid="usage-history-total">{compactNumber(total)}</span>
          <span className="usage-history-total-unit">tokens</span>
        </span>
        <span className="usage-history-figure">
          <span className="usage-history-total is-cost" data-testid="usage-history-cost">{compactMoney(history.costUsd)}</span>
          <span className="usage-history-total-unit">at list prices</span>
        </span>
        <span className="usage-history-total-sub settings-muted">
          {history.sessions.toLocaleString('en-US')} sessions · {RANGE_WORDS[history.range]}
        </span>
      </div>
      {history.agents.length === 0
        ? <p className="usage-history-note settings-muted">No {agent ? USAGE_AGENT_LABELS[agent] : 'agent'} usage in the {RANGE_WORDS[history.range]}.</p>
        : <>
            <div className="usage-history-top">
              <div className="usage-history-card">
                <HistoryChart history={history} shown={shown} />
              </div>
              <div className="usage-agent-tiles" role="group" aria-label="Agents in the chart">
                {history.agents.map((row, index) => <AgentTile key={row.id} agent={row} index={index} total={total} hidden={hidden.includes(row.id)} onToggle={() => onToggle(row.id)} />)}
              </div>
            </div>
            <section className="usage-history-block usage-history-kinds-block" aria-label="Tokens and cost by kind and speed">
              <div className="usage-history-splits">
                {splits(history).map((split) => <SplitBar key={split.id} {...split} />)}
              </div>
              {history.cacheSavingsUsd > 0 && <p className="usage-history-note settings-muted">
                Reusing cached input saved about {money(history.cacheSavingsUsd)} against paying full input prices.
              </p>}
            </section>
            <Breakdown history={history} />
            <ProjectsList history={history} scope={localScope} />
            <PriciestSessions history={history} scope={localScope} />
          </>}
      <SourcesLine history={history} devices={deviceCount} gaps={gaps} waiting={waiting} />
    </div>}
  </section>
}

/** What a computer's read gave: its history, or why there is none. */
interface DeviceRead { name: string; history?: UsageHistoryResponse; reason?: string }

/** Reads one computer's history; a reply that isn't one is unavailable, never drawn. */
async function readDevice(name: string, read: () => Promise<unknown>, local: boolean): Promise<DeviceRead> {
  try {
    return { name, history: parseUsageHistory(await read(), { local }) }
  } catch (error) {
    return { name, reason: error instanceof UsageHistoryReplyError ? 'Sent an unreadable reply' : machineStatusLabel(error) }
  }
}

export interface UsageHistorySectionProps {
  /** The person's other computers, when there are any, and the one picked (All devices by default). */
  devices?: UsageDevices
  device?: string
  onDevice?: (device: string) => void
}

/**
 * Reads the history for the picked range, provider and computer, and keeps the page's choices between visits.
 * Each computer reads its own logs and sends only the totals; with All devices they are added up as they arrive.
 */
export function UsageHistorySection({ devices, device = ALL_COMPUTERS, onDevice }: UsageHistorySectionProps) {
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
    const targets: Array<{ name: string; read: () => Promise<unknown>; local?: boolean }> = []
    if (picked === ALL_COMPUTERS || picked === THIS_COMPUTER) targets.push({ name: selfName, read: () => window.mousse.providers.usageHistory(request), local: true })
    for (const other of others) {
      if (picked === ALL_COMPUTERS || picked === other.id) {
        targets.push({ name: other.name, read: () => window.mousse.platformRequest.request('bridge.hub.usageHistory', { target: other.id, ...request }) })
      }
    }
    setWaiting(targets.map((target) => target.name))
    // By position, since two computers may share a name.
    const arrived = new Map<number, DeviceRead>()
    targets.forEach((target, index) => {
      void readDevice(target.name, target.read, !!target.local).then((result) => {
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
    agent={view.agent}
    hidden={view.hidden}
    {...(devices ? { devices, device: picked, ...(onDevice ? { onDevice } : {}) } : {})}
    localScope={picked === THIS_COMPUTER ? 'self' : picked === ALL_COMPUTERS ? (devices?.others.length ? 'mixed' : 'self') : 'other'}
    deviceCount={answered}
    waiting={history ? waiting : []}
    gaps={devices ? gaps : []}
    onRange={(range) => update({ range })}
    onAgent={(agent) => update({ agent })}
    onToggle={(agent) => update({ hidden: view.hidden.includes(agent) ? view.hidden.filter((id) => id !== agent) : [...view.hidden, agent] })}
  />
}
