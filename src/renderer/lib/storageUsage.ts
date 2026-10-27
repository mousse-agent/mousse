import type { NodeId } from '../../shared/net'
import type { Thread } from '../../shared/types'
import { KIND_POLICY_GROUP } from './storageCopy'
import {
  groupUsage,
  type MachineUsageEntry,
  type StorageUsageSnapshot,
  type UsageGroup,
  type UsageGroupBy,
  type UsageMachine,
  type UsageNames
} from '../../shared/storage'
import { parseUsageSnapshot } from '../../shared/storageReply'
import { formatAgo } from './formatAgo'

/** The machine whose usage is the local computer's. */
export const SELF_MACHINE: UsageMachine = { node: 'self', name: 'This computer' }

/** Numbers older than this are called out as old, not just timestamped. */
export const USAGE_STALE_MS = 24 * 60 * 60 * 1000

/** What the page knows about one machine's usage. An unavailable machine is never a zero. */
export type MachineUsage =
  | { machine: UsageMachine; status: 'ready'; snapshot: StorageUsageSnapshot }
  | { machine: UsageMachine; status: 'unavailable'; reason: string }

/** Tags every entry of a snapshot with the machine it came from. */
export function stampMachine(snapshot: StorageUsageSnapshot, machine: UsageMachine): MachineUsageEntry[] {
  return snapshot.entries.map((entry) => ({ ...entry, machine }))
}

/** Ready machines only: the rows and display names for `groupUsage`. */
export function groupMachineUsage(results: readonly MachineUsage[], by: UsageGroupBy): UsageGroup[] {
  const rows: MachineUsageEntry[] = []
  const names: Record<string, UsageNames> = {}
  for (const result of results) {
    if (result.status !== 'ready') continue
    rows.push(...stampMachine(result.snapshot, result.machine))
    names[result.machine.node] = result.snapshot.names
  }
  return groupUsage(rows, by, names)
}

export type SortKey = 'name' | 'machine' | 'size' | 'share'
export interface Sort { key: SortKey; direction: 'asc' | 'desc' }

/** Table order. "Other" rows stay last whatever the order, as in the chart. */
export function sortRows(groups: readonly UsageGroup[], sort: Sort): UsageGroup[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const isOther = (group: UsageGroup): boolean => group.kind === 'other' || (group.kind === undefined && !group.id)
  const compare = (a: UsageGroup, b: UsageGroup): number => {
    switch (sort.key) {
      case 'name': return a.label.localeCompare(b.label)
      case 'machine': return (a.machine?.name ?? '').localeCompare(b.machine?.name ?? '')
      case 'size':
      case 'share': return a.bytes - b.bytes
    }
  }
  // Equal rows keep alphabetical order whichever way the column is sorted, as the chart orders them.
  return [...groups].sort((a, b) => Number(isOther(a)) - Number(isOther(b)) || sign * compare(a, b) || a.label.localeCompare(b.label))
}

/** Words for a machine that could not report. The call's error code decides; nothing here is a guess at a number. */
export function machineStatusLabel(error: unknown): string {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : ''
  switch (code) {
    case 'peer_offline':
    case 'route_unreachable':
    case 'deadline_exceeded':
      return 'Offline'
    case 'method_not_available':
    case 'method_not_found':
    case 'unknown_method':
    case 'forbidden':
    case 'bad_request':
    case 'not_member':
    case 'unsupported_version':
    case 'incompatible_peer':
    case 'upgrade_required':
    case 'downgrade_unsupported':
    case 'profile_unsupported':
      return 'Older version or no permission'
    case 'storage_reply_invalid':
      return 'Sent an unreadable reply'
    default:
      return 'Unavailable'
  }
}

/** Reads one machine's usage. A reply that fails validation is unavailable, never drawn. */
export async function readMachineUsage(
  machine: UsageMachine,
  read: () => Promise<unknown>
): Promise<MachineUsage> {
  try {
    return { machine, status: 'ready', snapshot: parseUsageSnapshot(await read()) }
  } catch (error) {
    const invalid = (error as Error | null)?.name === 'StorageReplyError'
    return { machine, status: 'unavailable', reason: invalid ? machineStatusLabel({ code: 'storage_reply_invalid' }) : machineStatusLabel(error) }
  }
}

/** A machine that is not connected is reported as offline without asking it. */
export function offlineUsage(machine: UsageMachine): MachineUsage {
  return { machine, status: 'unavailable', reason: machineStatusLabel({ code: 'peer_offline' }) }
}

/** "42%", "3.5%", "<0.1%": the share a row holds of the chart. */
export function formatShare(share: number): string {
  const percent = share * 100
  if (percent > 0 && percent < 0.1) return '<0.1%'
  return `${percent >= 10 ? Math.round(percent) : Math.round(percent * 10) / 10}%`
}

/** "Measured 5m ago"; the oldest figure behind the machines shown. */
export function relativeMeasuredAt(measuredAt: string, now: number): string {
  const time = Date.parse(measuredAt)
  const ago = formatAgo(time, now)
  return ago ? `Measured ${ago}` : ''
}

export interface UsageNote { kind: 'partial' | 'estimated' | 'condensed' | 'stale'; text: string }

/** The caveats behind the numbers, in plain words. Empty when the figures are complete, exact and recent. */
export function usageNotes(results: readonly MachineUsage[], now: number): UsageNote[] {
  const ready = results.flatMap((result) => result.status === 'ready' ? [result.snapshot] : [])
  const notes: UsageNote[] = []
  if (ready.some((snapshot) => snapshot.partial || snapshot.entries.some((entry) => entry.partial))) {
    notes.push({ kind: 'partial', text: 'Partial: some folders are not measured yet, so sizes are at least what is shown. Refresh to continue.' })
  }
  if (ready.some((snapshot) => snapshot.entries.some((entry) => entry.estimated))) {
    notes.push({ kind: 'estimated', text: 'Estimated: sizes are file sizes, which can differ from the space used on disk.' })
  }
  if (ready.some((snapshot) => snapshot.condensed)) {
    notes.push({ kind: 'condensed', text: 'Condensed: small threads are counted with their project or kind to keep this list short.' })
  }
  const oldest = Math.min(...ready.map((snapshot) => Date.parse(snapshot.measuredAt)))
  if (ready.length && Number.isFinite(oldest) && now - oldest > USAGE_STALE_MS) {
    notes.push({ kind: 'stale', text: `Old numbers: ${relativeMeasuredAt(new Date(oldest).toISOString(), now).replace('Measured ', 'measured ')}. Refresh to measure again.` })
  }
  return notes
}

/** The oldest measurement time across ready machines, or undefined when none answered. */
export function oldestMeasuredAt(results: readonly MachineUsage[]): string | undefined {
  let oldest: string | undefined
  for (const result of results) {
    if (result.status !== 'ready') continue
    if (oldest === undefined || Date.parse(result.snapshot.measuredAt) < Date.parse(oldest)) oldest = result.snapshot.measuredAt
  }
  return oldest
}

export type OpenTarget =
  | { type: 'policy'; anchor: string }
  | { type: 'thread'; threadId: string }
  | { type: 'remote-thread'; node: NodeId; threadId: string }

/**
 * Where selecting a row goes. A kind scrolls to that kind's cleanup rule; a local thread opens; a local
 * project opens its most recently updated thread; a thread on another machine opens in a viewer. A row
 * with nowhere to go (Other, a remote project, a project with no thread) is a label.
 */
export function openTarget(
  group: UsageGroup,
  by: UsageGroupBy,
  threads: ReadonlyArray<Pick<Thread, 'id' | 'projectId' | 'updatedAt' | 'lineage'>>
): OpenTarget | undefined {
  if (by === 'kind') {
    const anchor = group.kind ? KIND_POLICY_GROUP[group.kind] : undefined
    return anchor ? { type: 'policy', anchor } : undefined
  }
  if (!group.id || !group.machine) return undefined
  if (by === 'thread') {
    // A thread that is not in this computer's list (in the trash, or deleted since the measurement) has nothing to open.
    if (group.machine.node === 'self') return threads.some((thread) => thread.id === group.id) ? { type: 'thread', threadId: group.id } : undefined
    return { type: 'remote-thread', node: group.machine.node as NodeId, threadId: group.id }
  }
  if (group.machine.node !== 'self') return undefined
  const latest = threads
    .filter((thread) => thread.projectId === group.id && !thread.lineage)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  return latest ? { type: 'thread', threadId: latest.id } : undefined
}

export interface MachineChoice { node: NodeId; name: string; online: boolean }

/** Machines the dropdown offers besides this computer: each device that is not this one, not revoked, and readable. */
export function otherMachines(devices: ReadonlyArray<{ node: NodeId; name: string; self: boolean; revoked: boolean; state: string; caps?: readonly string[] }>): MachineChoice[] {
  // A device that this computer may not read from cannot report usage; offering it would only show a refusal.
  return devices.filter((device) => !device.self && !device.revoked && device.caps?.includes('read') === true).map((device) => ({ node: device.node, name: device.name, online: device.state === 'open' }))
}
