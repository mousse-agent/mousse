import { useCallback, useEffect, useId, useRef, useState } from 'react'
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
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { Select } from '../ui/Select'
import { StorageDonut, sliceColor } from './StorageDonut'

const GROUP_OPTIONS: ReadonlyArray<{ value: UsageGroupBy; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'kind', label: 'Kind' },
  { value: 'thread', label: 'Thread (top 10)' }
]
const NAME_HEADER: Record<UsageGroupBy, string> = { project: 'Project', kind: 'Kind', thread: 'Thread' }

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

/** The Disk usage group: dropdowns, donut with legend, and a sortable table that carries the same numbers. */
export function StorageUsageView(props: StorageUsageViewProps) {
  const { machines, machine, by, results, loading, sort, now } = props
  const id = useId()
  const groups = results ? groupMachineUsage(results, by) : []
  const total = groups.reduce((sum, group) => sum + group.bytes, 0)
  const unavailable = (results ?? []).flatMap((result) => result.status === 'unavailable' ? [result] : [])
  const answered = (results ?? []).some((result) => result.status === 'ready')
  const notes = results ? usageNotes(results, now) : []
  const oldest = results ? oldestMeasuredAt(results) : undefined
  const showMachine = (results?.length ?? 0) > 1
  const rows = sortRows(groups, sort)
  const colors = new Map(groups.map((group, index) => [group.key, sliceColor(group, index)]))
  const machineOptions = [
    { value: 'self', label: SELF_MACHINE.name },
    ...machines.map((choice) => ({ value: choice.node as string, label: choice.online ? choice.name : `${choice.name} · Offline` })),
    { value: 'all', label: 'All machines' }
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
    description="How much space Mousse uses. Numbers come from a saved measurement, so opening this page does not scan your disk."
    action={<span className="storage-usage-actions">
      {oldest && <span className="settings-muted" data-testid="storage-measured-at">{relativeMeasuredAt(oldest, now)}</span>}
      <button type="button" className="settings-btn" data-testid="storage-usage-refresh" disabled={loading} aria-busy={loading || undefined} onClick={props.onRefresh}>
        <RefreshCw size={13} aria-hidden="true" />{loading ? 'Measuring…' : 'Refresh'}
      </button>
    </span>}
  >
    {machines.length > 0 && <SettingsRow
      title="Machine"
      htmlFor={`${id}-machine`}
      control={<Select id={`${id}-machine`} data-testid="storage-machine-select" value={machine} onChange={props.onMachine} options={machineOptions} />}
    />}
    <SettingsRow
      title="Group by"
      htmlFor={`${id}-by`}
      control={<Select id={`${id}-by`} data-testid="storage-groupby-select" value={by} onChange={(value) => props.onBy(value as UsageGroupBy)} options={GROUP_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />}
    />
    {!results && <p className="settings-muted storage-empty" role="status" data-testid="storage-usage-loading">Measuring…</p>}
    {results && !answered && <p className="settings-muted storage-empty" data-testid="storage-usage-none">No usage to show.</p>}
    {answered && <div className="storage-usage" data-testid="storage-usage">
      <div className="storage-usage-chart">
        <StorageDonut groups={groups} />
        <p className="storage-usage-total" data-testid="storage-usage-total">{partialTotal ? 'At least ' : ''}{formatBytes(total)}<span className="settings-muted"> in total</span></p>
        <ul className="storage-legend" aria-label="Legend">
          {groups.map((group) => <li key={group.key} data-testid="storage-legend-item">
            <span className="storage-swatch" style={{ background: colors.get(group.key) }} aria-hidden="true" />
            <span className="storage-legend-label">{group.label}{showMachine && group.machine ? ` · ${group.machine.name}` : ''}</span>
            <span className="settings-muted">{formatShare(group.share)}</span>
          </li>)}
        </ul>
      </div>
      <table className="storage-table" data-testid="storage-usage-table">
        <caption className="sr-only">Disk usage by {NAME_HEADER[by].toLowerCase()}</caption>
        <thead>
          <tr>
            {sortHeader('name', NAME_HEADER[by])}
            {showMachine && by !== 'kind' && sortHeader('machine', 'Machine')}
            {sortHeader('size', 'Size')}
            {sortHeader('share', 'Share')}
          </tr>
        </thead>
        <tbody>
          {rows.map((group) => <tr key={group.key} data-testid="storage-usage-row" data-key={group.key} data-bytes={group.bytes}>
            <th scope="row">
              {props.canOpen(group)
                ? <button type="button" className="storage-row-link" onClick={() => props.onOpen(group)}>{group.label}</button>
                : <span>{group.label}</span>}
            </th>
            {showMachine && by !== 'kind' && <td>{group.machine?.name ?? ''}</td>}
            <td className="storage-num">{formatBytes(group.bytes)}</td>
            <td className="storage-num">{formatShare(group.share)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
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
