import { describe, expect, it } from 'vitest'
import type { NodeId } from '../../src/shared/net'
import type { StorageUsageEntry, StorageUsageSnapshot, UsageGroup } from '../../src/shared/storage'
import {
  SELF_MACHINE,
  USAGE_STALE_MS,
  formatShare,
  groupMachineUsage,
  machineStatusLabel,
  offlineUsage,
  oldestMeasuredAt,
  openTarget,
  otherMachines,
  readMachineUsage,
  relativeMeasuredAt,
  sortRows,
  stampMachine,
  usageNotes,
  type MachineUsage
} from '../../src/renderer/lib/storageUsage'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const LAPTOP = { node: 'nod_laptop', name: 'Laptop' }
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

const snapshot = (entries: StorageUsageEntry[], patch: Partial<StorageUsageSnapshot> = {}, names: StorageUsageSnapshot['names'] = { projects: { p1: 'Mousse', p2: 'Website' }, threads: {} }): StorageUsageSnapshot => ({
  measuredAt: iso(-5 * 60_000), durationMs: 100, partial: false, entries, names, ...patch
})
const ready = (machine: { node: string; name: string }, value: StorageUsageSnapshot): MachineUsage => ({ machine, status: 'ready', snapshot: value })

describe('stampMachine and grouping', () => {
  const local = snapshot([
    { kind: 'worktrees', projectId: 'p1', threadId: 't1', bytes: 600, files: 6 },
    { kind: 'threads', projectId: 'p1', threadId: 't1', bytes: 100, files: 1 },
    { kind: 'browser', projectId: 'p2', bytes: 200, files: 2 },
    { kind: 'logs', bytes: 100, files: 1 }
  ], {}, { projects: { p1: 'Mousse', p2: 'Website' }, threads: { t1: 'Fix storage' } })

  it('tags every entry with its machine', () => {
    const rows = stampMachine(local, SELF_MACHINE)
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.machine === SELF_MACHINE)).toBe(true)
  })

  it('groups by project with unattributed space as Other, last, and shares that add up', () => {
    const groups = groupMachineUsage([ready(SELF_MACHINE, local)], 'project')
    expect(groups.map((group) => [group.label, group.bytes])).toEqual([['Mousse', 700], ['Website', 200], ['Other', 100]])
    expect(groups.reduce((sum, group) => sum + group.share, 0)).toBeCloseTo(1)
  })

  it('groups by kind and sums across machines', () => {
    const remote = snapshot([{ kind: 'worktrees', projectId: 'p1', bytes: 400, files: 4 }])
    const groups = groupMachineUsage([ready(SELF_MACHINE, local), ready(LAPTOP, remote)], 'kind')
    expect(groups.find((group) => group.kind === 'worktrees')!.bytes).toBe(1000)
    expect(new Set(groups.map((group) => group.machine))).toEqual(new Set([undefined]))
  })

  it('keeps identical project ids on two machines as separate rows', () => {
    const remote = snapshot([{ kind: 'worktrees', projectId: 'p1', bytes: 400, files: 4 }], {}, { projects: { p1: 'Mousse (laptop)' }, threads: {} })
    const groups = groupMachineUsage([ready(SELF_MACHINE, local), ready(LAPTOP, remote)], 'project')
    const mousse = groups.filter((group) => group.id === 'p1')
    expect(mousse.map((group) => [group.machine!.name, group.label, group.bytes]).sort()).toEqual([['Laptop', 'Mousse (laptop)', 400], ['This computer', 'Mousse', 700]])
  })

  it('shows the biggest ten threads and folds the rest into Other', () => {
    const entries = Array.from({ length: 14 }, (_, index): StorageUsageEntry => ({ kind: 'worktrees', projectId: 'p1', threadId: `t${index}`, bytes: 1000 - index, files: 1 }))
    const names = Object.fromEntries(entries.map((entry) => [entry.threadId!, `Thread ${entry.threadId}`]))
    const groups = groupMachineUsage([ready(SELF_MACHINE, snapshot(entries, {}, { projects: {}, threads: names }))], 'thread')
    expect(groups).toHaveLength(11)
    const other = groups.at(-1)!
    expect(other.label).toBe('Other')
    expect(other.bytes).toBe(entries.slice(10).reduce((sum, entry) => sum + entry.bytes, 0))
  })

  it('skips machines that did not answer instead of counting them as zero', () => {
    const groups = groupMachineUsage([ready(SELF_MACHINE, local), offlineUsage(LAPTOP)], 'kind')
    expect(groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(1000)
  })
})

describe('sorting', () => {
  const groups: UsageGroup[] = [
    { key: 'a', label: 'Alpha', bytes: 10, share: 0.1, id: 'a', machine: SELF_MACHINE },
    { key: 'b', label: 'Beta', bytes: 70, share: 0.7, id: 'b', machine: LAPTOP },
    { key: 'c', label: 'Gamma', bytes: 20, share: 0.2, id: 'c', machine: SELF_MACHINE },
    { key: 'o', label: 'Other', bytes: 999, share: 0, machine: SELF_MACHINE }
  ]
  it('sorts by size either way and keeps Other last', () => {
    expect(sortRows(groups, { key: 'size', direction: 'desc' }).map((group) => group.label)).toEqual(['Beta', 'Gamma', 'Alpha', 'Other'])
    expect(sortRows(groups, { key: 'size', direction: 'asc' }).map((group) => group.label)).toEqual(['Alpha', 'Gamma', 'Beta', 'Other'])
  })
  it('keeps equal rows in alphabetical order either way', () => {
    const tied: UsageGroup[] = [
      { key: 'z', label: 'Zeta', bytes: 5, share: 0.5, id: 'z', machine: SELF_MACHINE },
      { key: 'a', label: 'Alpha', bytes: 5, share: 0.5, id: 'a', machine: SELF_MACHINE }
    ]
    expect(sortRows(tied, { key: 'size', direction: 'desc' }).map((group) => group.label)).toEqual(['Alpha', 'Zeta'])
    expect(sortRows(tied, { key: 'size', direction: 'asc' }).map((group) => group.label)).toEqual(['Alpha', 'Zeta'])
  })
  it('sorts by name and by machine, and does not change its input', () => {
    const before = groups.map((group) => group.label)
    expect(sortRows(groups, { key: 'name', direction: 'desc' }).map((group) => group.label)).toEqual(['Gamma', 'Beta', 'Alpha', 'Other'])
    expect(sortRows(groups, { key: 'machine', direction: 'asc' }).map((group) => group.label)).toEqual(['Beta', 'Alpha', 'Gamma', 'Other'])
    expect(groups.map((group) => group.label)).toEqual(before)
  })
})

describe('times, shares and notes', () => {
  it('says how long ago the numbers were measured', () => {
    expect(relativeMeasuredAt(iso(-5 * 60_000), NOW)).toBe('Measured 5m ago')
    expect(relativeMeasuredAt(iso(-10_000), NOW)).toBe('Measured just now')
    expect(relativeMeasuredAt('not a time', NOW)).toBe('')
  })

  it('takes the oldest measurement across machines', () => {
    const results = [ready(SELF_MACHINE, snapshot([], { measuredAt: iso(-60_000) })), ready(LAPTOP, snapshot([], { measuredAt: iso(-3_600_000) })), offlineUsage({ node: 'x', name: 'X' })]
    expect(oldestMeasuredAt(results)).toBe(iso(-3_600_000))
    expect(oldestMeasuredAt([offlineUsage(LAPTOP)])).toBeUndefined()
  })

  it('formats shares', () => {
    expect([0.42, 0.035, 0.0004, 1, 0].map(formatShare)).toEqual(['42%', '3.5%', '<0.1%', '100%', '0%'])
  })

  it('has no notes for complete, exact and recent numbers', () => {
    expect(usageNotes([ready(SELF_MACHINE, snapshot([{ kind: 'logs', bytes: 1, files: 1 }]))], NOW)).toEqual([])
  })

  it('says when numbers are partial, estimated, condensed or old', () => {
    const entry = (patch: Partial<StorageUsageEntry>): StorageUsageEntry => ({ kind: 'logs', bytes: 1, files: 1, ...patch })
    const kinds = (value: StorageUsageSnapshot) => usageNotes([ready(SELF_MACHINE, value)], NOW).map((note) => note.kind)
    expect(kinds(snapshot([entry({})], { partial: true }))).toEqual(['partial'])
    expect(kinds(snapshot([entry({ partial: true })]))).toEqual(['partial'])
    expect(kinds(snapshot([entry({ estimated: true })]))).toEqual(['estimated'])
    expect(kinds(snapshot([entry({})], { condensed: true }))).toEqual(['condensed'])
    const stale = usageNotes([ready(SELF_MACHINE, snapshot([entry({})], { measuredAt: iso(-USAGE_STALE_MS - 3_600_000) }))], NOW)
    expect(stale.map((note) => note.kind)).toEqual(['stale'])
    expect(stale[0]!.text).toContain('measured 1d ago')
  })

  it('judges old numbers from the oldest machine', () => {
    const results = [ready(SELF_MACHINE, snapshot([], { measuredAt: iso(-60_000) })), ready(LAPTOP, snapshot([], { measuredAt: iso(-3 * USAGE_STALE_MS) }))]
    expect(usageNotes(results, NOW).map((note) => note.kind)).toEqual(['stale'])
  })
})

describe('machines', () => {
  const device = (patch: Record<string, unknown>) => ({ node: 'nod_a' as NodeId, name: 'A', self: false, revoked: false, state: 'open', caps: ['read', 'chat'], ...patch })
  it('offers every device that is not this computer, not revoked, and readable', () => {
    const list = otherMachines([device({ self: true }), device({ node: 'nod_b' as NodeId, name: 'B' }), device({ node: 'nod_c' as NodeId, name: 'C', revoked: true }), device({ node: 'nod_d' as NodeId, name: 'D', state: 'closed' })])
    expect(list).toEqual([{ node: 'nod_b', name: 'B', online: true }, { node: 'nod_d', name: 'D', online: false }])
  })

  it('leaves out a device this computer may not read from, or one that does not say', () => {
    expect(otherMachines([device({ node: 'nod_e' as NodeId, caps: ['chat'] }), device({ node: 'nod_f' as NodeId, caps: [] }), device({ node: 'nod_g' as NodeId, caps: undefined })])).toEqual([])
  })

  it('names why a machine is unavailable', () => {
    expect(machineStatusLabel({ code: 'peer_offline' })).toBe('Offline')
    expect(machineStatusLabel({ code: 'route_unreachable' })).toBe('Offline')
    expect(machineStatusLabel({ code: 'method_not_available' })).toBe('Older version or no permission')
    expect(machineStatusLabel({ code: 'forbidden' })).toBe('Older version or no permission')
    expect(machineStatusLabel({ code: 'internal' })).toBe('Unavailable')
    expect(machineStatusLabel(new Error('boom'))).toBe('Unavailable')
    expect(machineStatusLabel(null)).toBe('Unavailable')
  })

  it('reads a machine, and reports a rejected call as unavailable with its reason', async () => {
    const good = await readMachineUsage(LAPTOP, async () => snapshot([{ kind: 'logs', bytes: 5, files: 1 }]))
    expect(good.status).toBe('ready')
    const closed = await readMachineUsage(LAPTOP, async () => { throw Object.assign(new Error('closed'), { code: 'peer_offline' }) })
    expect(closed).toEqual({ machine: LAPTOP, status: 'unavailable', reason: 'Offline' })
    const old = await readMachineUsage(LAPTOP, async () => { throw { code: 'forbidden', message: 'no' } })
    expect(old).toMatchObject({ status: 'unavailable', reason: 'Older version or no permission' })
  })

  it('rejects a malformed reply before anything can be drawn', async () => {
    for (const bad of [null, 'x', { entries: 'many' }, { ...snapshot([]), entries: [{ kind: 'logs', bytes: -4, files: 1 }] }, { ...snapshot([]), measuredAt: 'soon' }]) {
      const result = await readMachineUsage(LAPTOP, async () => bad)
      expect(result).toEqual({ machine: LAPTOP, status: 'unavailable', reason: 'Sent an unreadable reply' })
    }
  })
})

describe('where selecting a row goes', () => {
  const threads = [
    { id: 'old', projectId: 'p1', updatedAt: '2026-10-01T00:00:00Z' },
    { id: 'new', projectId: 'p1', updatedAt: '2026-10-20T00:00:00Z' },
    { id: 'sub', projectId: 'p1', updatedAt: '2026-10-26T00:00:00Z', lineage: { parentThreadId: 'new' } as never },
    { id: 'other', projectId: 'p2', updatedAt: '2026-10-25T00:00:00Z' }
  ]
  const group = (patch: Partial<UsageGroup>): UsageGroup => ({ key: 'k', label: 'L', bytes: 1, share: 1, ...patch })

  it('sends a kind to that kind’s cleanup rule', () => {
    expect(openTarget(group({ kind: 'worktrees' }), 'kind', threads)).toEqual({ type: 'policy', anchor: 'storage-worktrees' })
    expect(openTarget(group({ kind: 'browser' }), 'kind', threads)).toEqual({ type: 'policy', anchor: 'storage-browser' })
    expect(openTarget(group({ kind: 'logs' }), 'kind', threads)).toBeUndefined()
  })

  it('opens a local thread, and a remote one in a viewer', () => {
    expect(openTarget(group({ id: 'new', machine: SELF_MACHINE }), 'thread', threads)).toEqual({ type: 'thread', threadId: 'new' })
    expect(openTarget(group({ id: 't1', machine: LAPTOP }), 'thread', threads)).toEqual({ type: 'remote-thread', node: 'nod_laptop', threadId: 't1' })
  })

  it('leaves a local thread that is not in the thread list (in the trash, or deleted since) as a label', () => {
    expect(openTarget(group({ id: 'deleted-since', machine: SELF_MACHINE }), 'thread', threads)).toBeUndefined()
    expect(openTarget(group({ id: 'deleted-since', machine: LAPTOP }), 'thread', threads)).toEqual({ type: 'remote-thread', node: 'nod_laptop', threadId: 'deleted-since' })
  })

  it('opens the latest thread of a local project, never a subagent, and leaves other projects as labels', () => {
    expect(openTarget(group({ id: 'p1', machine: SELF_MACHINE }), 'project', threads)).toEqual({ type: 'thread', threadId: 'new' })
    expect(openTarget(group({ id: 'p9', machine: SELF_MACHINE }), 'project', threads)).toBeUndefined()
    expect(openTarget(group({ id: 'p1', machine: LAPTOP }), 'project', threads)).toBeUndefined()
    expect(openTarget(group({ machine: SELF_MACHINE }), 'project', threads)).toBeUndefined()
  })
})
