import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBytes, type UsageGroup, type UsageGroupBy, type UsageMachine } from '../../../shared/storage'
import { ArrowDown, ArrowUp, RefreshCw, Server } from '../../lib/icons'
import { readDevices } from '../../lib/netDevices'
import {
  SELF_MACHINE,
  formatShare,
  groupMachineUsage,
  oldestMeasuredAt,
  offlineUsage,
  openTarget,
  otherMachines,
  readMachineUsage,
  relativeMeasuredAt,
  sortRows,
  usageNotes,
  type MachineChoice,
  type MachineUsage,
  type Sort,
  type SortKey
} from '../../lib/storageUsage'
import { openThread } from '../../lib/openThread'
import { useAppStore } from '../../stores/appStore'
import { SettingsGroup } from '../settings/SettingsRow'
import { DelayedLoader } from '../ui/DelayedLoader'
import { Select } from '../ui/Select'
import { StorageDonut, sliceColor } from './StorageDonut'

const GROUP_OPTIONS: ReadonlyArray<{ value: UsageGroupBy; label: string }> = [
  { value: 'project', label: 'By project' },
  { value: 'kind', label: 'By kind' },
  { value: 'thread', label: 'Top 10 threads' }
]
const NAME_HEADER: Record<UsageGroupBy, string> = { project: 'Project', kind: 'Kind', thread: 'Thread' }
const MEASURED_TOOLTIP = 'From the last measurement. Opening this page does not scan the disk.'

export interface StorageUsageViewProps {
  machines: readonly MachineChoice[]
  /** `self`, a node id, or `all`. */
  machine: string
  by: UsageGroupBy
  /** Undefined until the first answer arrives. */
  results: readonly MachineUsage[] | undefined
  loading: boolean
  sort: Sort
  now: number
  canOpen: (group: UsageGroup) => boolean
  onMachine: (machine: string) => void
  onBy: (by: UsageGroupBy) => void
  onRefresh: () => void
  onSort: (key: SortKey) => void
  onOpen: (group: UsageGroup) => void
}

/**
 * The Disk usage group: a donut beside the total and a compact toolbar (grouping, and the computer
 * when there is a choice), then one sortable table whose row swatches match the donut's slices.
 */
export function StorageUsageView(props: StorageUsageViewProps) {
  const { machines, machine, by, results, loading, sort, now } = props
  const groups = results ? groupMachineUsage(results, by) : []
  const total = groups.reduce((sum, group) => sum + group.bytes, 0)
  const unavailable = (results ?? []).flatMap((result) => result.status === 'unavailable' ? [result] : [])
  const answered = (results ?? []).some((result) => result.status === 'ready')
  const notes = results ? usageNotes(results, now) : []
  const oldest = results ? oldestMeasuredAt(results) : undefined
  const showMachine = (results?.length ?? 0) > 1
  const rows = sortRows(groups, sort)
  // Colours follow the chart's order, not the table's sort, so a row keeps its slice's colour.
  const colors = new Map(groups.map((group, index) => [group.key, sliceColor(group, index)]))
  // This computer, each other computer, and all of them: shown only when another computer exists.
  const machineOptions = [
    { value: 'self', label: SELF_MACHINE.name },
    ...machines.map((choice) => ({ value: choice.node as string, label: choice.online ? choice.name : `${choice.name} · Offline` })),
    { value: 'all', label: 'All computers' }
  ]
  const partialTotal = notes.some((note) => note.kind === 'partial')
  const sortHeader = (key: SortKey, label: string) => {
    const active = sort.key === key
    return <th scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={key === 'size' || key === 'share' ? 'storage-num' : undefined}>
      <button type="button" className="storage-sort" onClick={() => props.onSort(key)} data-testid={`storage-sort-${key}`}>
        {label}{active && (sort.direction === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>
  }
  return <SettingsGroup
    title="Disk usage"
    icon={Server}
    id="storage-usage"
    action={<span className="storage-usage-actions">
      {oldest && <span className="settings-muted" data-testid="storage-measured-at" title={MEASURED_TOOLTIP}>{relativeMeasuredAt(oldest, now)}</span>}
      <button
        type="button"
        className="settings-icon-btn"
        data-testid="storage-usage-refresh"
        title={loading ? 'Measuring…' : 'Measure again'}
        aria-label={loading ? 'Measuring disk usage' : 'Measure disk usage again'}
        disabled={loading}
        aria-busy={loading || undefined}
        onClick={props.onRefresh}
      >
        <RefreshCw size={14} aria-hidden="true" className={loading ? 'icon-spin' : undefined} />
      </button>
    </span>}
  >
    <div className="storage-usage-toolbar">
      {answered && <StorageDonut groups={groups} />}
      <div className="storage-usage-head">
        <div className="storage-usage-summary">
          {!results && <DelayedLoader size="small" label="Measuring disk usage" data-testid="storage-usage-loading" />}
          {results && !answered && <span className="settings-muted" data-testid="storage-usage-none">No usage to show.</span>}
          {answered && <p className="storage-usage-total" data-testid="storage-usage-total">
            {partialTotal ? 'At least ' : ''}<strong>{formatBytes(total)}</strong><span className="settings-muted"> in total</span>
          </p>}
        </div>
        <div className="storage-usage-filters">
          {machines.length > 0 && <Select ariaLabel="Computer" size="small" data-testid="storage-machine-select" value={machine} onChange={props.onMachine} options={machineOptions} />}
          <Select ariaLabel="Group by" size="small" data-testid="storage-groupby-select" value={by} onChange={(value) => props.onBy(value as UsageGroupBy)} options={GROUP_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
        </div>
      </div>
    </div>
    {answered && <table className="storage-table" data-testid="storage-usage-table">
      <caption className="sr-only">Disk usage by {NAME_HEADER[by].toLowerCase()}</caption>
      <thead>
        <tr>
          {sortHeader('name', NAME_HEADER[by])}
          {showMachine && by !== 'kind' && sortHeader('machine', 'Computer')}
          {sortHeader('size', 'Size')}
          {sortHeader('share', 'Share')}
        </tr>
      </thead>
      <tbody>
        {rows.map((group) => <tr key={group.key} data-testid="storage-usage-row" data-key={group.key} data-bytes={group.bytes}>
          <th scope="row">
            <span className="storage-row-name">
              <span className="storage-swatch" data-testid="storage-usage-swatch" style={{ background: colors.get(group.key) }} aria-hidden="true" />
              {props.canOpen(group)
                ? <button type="button" className="storage-row-link" onClick={() => props.onOpen(group)}>{group.label}</button>
                : <span>{group.label}</span>}
            </span>
          </th>
          {showMachine && by !== 'kind' && <td>{group.machine?.name ?? ''}</td>}
          <td className="storage-num">{formatBytes(group.bytes)}</td>
          <td className="storage-num">{formatShare(group.share)}</td>
        </tr>)}
      </tbody>
    </table>}
    {notes.length > 0 && <ul className="storage-notes" data-testid="storage-usage-notes">
      {notes.map((note) => <li key={note.kind} className="settings-muted" data-note={note.kind}>{note.text}</li>)}
    </ul>}
    {unavailable.length > 0 && <ul className="storage-unavailable" data-testid="storage-usage-unavailable">
      {unavailable.map((result) => <li key={result.machine.node} className="settings-muted">
        <strong>{result.machine.name}</strong>: Unavailable · {result.reason}
      </li>)}
    </ul>}
  </SettingsGroup>
}

/** Loads usage for the chosen machine or machines and opens a row's target. */
export function StorageUsageSection({ refreshKey = 0 }: { refreshKey?: number }) {
  const [machines, setMachines] = useState<MachineChoice[]>([])
  const [machine, setMachine] = useState('self')
  const [by, setBy] = useState<UsageGroupBy>('project')
  const [results, setResults] = useState<MachineUsage[]>()
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'size', direction: 'desc' })
  const [now, setNow] = useState(() => Date.now())
  const token = useRef(0)
  const mounted = useRef(true)
  const machinesRef = useRef<MachineChoice[]>([])
  const threads = useAppStore((state) => state.threads)

  const load = useCallback(async (selection: string, refresh: boolean) => {
    const mine = ++token.current
    setLoading(true)
    const choices = machinesRef.current
    const targets: Array<MachineChoice | undefined> = selection === 'self' ? [undefined]
      : selection === 'all' ? [undefined, ...choices]
      : [choices.find((choice) => choice.node === selection)]
    const reads = targets.map((target): Promise<MachineUsage> => {
      if (!target) {
        if (selection !== 'self' && selection !== 'all') return Promise.resolve(offlineUsage({ node: selection, name: selection }))
        return readMachineUsage(SELF_MACHINE, () => window.mousse.storage.usage(refresh ? { refresh: true } : undefined))
      }
      const label: UsageMachine = { node: target.node, name: target.name }
      if (!target.online) return Promise.resolve(offlineUsage(label))
      return readMachineUsage(label, () => window.mousse.platformRequest.request('bridge.hub.storage', { target: target.node }))
    })
    const answers = await Promise.all(reads)
    if (!mounted.current || mine !== token.current) return
    setResults(answers)
    setNow(Date.now())
    setLoading(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // Machines come from the same list the Devices page reads; with networking off there are none.
  const refreshMachines = useCallback(async () => {
    try {
      const { nodes } = await readDevices(false)
      if (!mounted.current) return
      machinesRef.current = otherMachines(nodes)
      setMachines(machinesRef.current)
    } catch { /* Without the list this computer is still shown. */ }
  }, [])
  useEffect(() => { void refreshMachines() }, [refreshMachines])
  useEffect(() => { void load(machine, false) }, [load, machine, refreshKey])

  const canOpen = useCallback((group: UsageGroup) => openTarget(group, by, threads) !== undefined, [by, threads])
  const open = (group: UsageGroup) => {
    const target = openTarget(group, by, useAppStore.getState().threads)
    if (!target) return
    if (target.type === 'policy') {
      document.getElementById(target.anchor)?.scrollIntoView({ block: 'start' })
    } else {
      void openThread(target.threadId).then(() => { if (useAppStore.getState().activeThreadId === target.threadId) useAppStore.getState().setSettingsOpen(false) })
    }
  }
  const onSort = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: key === 'name' || key === 'machine' ? 'asc' : 'desc' })

  return <>
    <StorageUsageView
      machines={machines}
      machine={machine}
      by={by}
      results={results}
      loading={loading}
      sort={sort}
      now={now}
      canOpen={canOpen}
      onMachine={setMachine}
      onBy={setBy}
      onRefresh={() => void refreshMachines().then(() => load(machine, true))}
      onSort={onSort}
      onOpen={open}
    />
  </>
}
