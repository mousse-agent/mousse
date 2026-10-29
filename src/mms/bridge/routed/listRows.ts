import { normalizePermissionMode } from '../../../shared/permissionMode'
import type { Project, Thread, ThreadActivityState } from '../../../shared/types'
import type { ListsStatus } from '../remote/MmsListsSource'

/**
 * Pure parts of the merged lists: how another computer's snapshot becomes rows, where a new row sits
 * among the rows of its group, and when a status change may notify. The state that holds them over time
 * is `RemoteLists`.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The activity a sidebar row shows for a status of the lists stream; a failed turn leaves the row idle. */
export function activityOfStatus(status: ListsStatus | undefined): ThreadActivityState | undefined {
  switch (status?.state) {
    case 'processing':
    case 'awaiting_input':
    case 'completed':
    case 'waiting':
    case 'paused':
      return status.state
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------------------- positions

export interface Placed {
  id: string
  order: number
  updatedAt: string
}

const byOrder = (a: Placed, b: Placed): number => a.order - b.order || a.id.localeCompare(b.id)
const newestFirst = (
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string }
): number => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)

/**
 * Orders for `count` rows that sit between `before` and `after` (either may be missing), evenly spread, so
 * that a batch of new rows does not crowd one gap.
 */
function spread(before: number | undefined, after: number | undefined, count: number): number[] {
  const out: number[] = []
  for (let k = 1; k <= count; k += 1) {
    if (before !== undefined && after !== undefined)
      out.push(before + (k * (after - before)) / (count + 1))
    else if (after !== undefined) out.push(after - count + k - 1)
    else if (before !== undefined) out.push(before + k)
    else out.push(k - 1)
  }
  return out
}

/**
 * Where rows that have no place yet go: each takes the position its `updatedAt` gives among the rows
 * that already have one (the local rows of its group and the rows of other computers placed before),
 * that is before the first of them that was updated earlier. Rows that land in the same gap keep their
 * own order, newest first.
 */
export function placeNewRows(
  fixed: readonly Placed[],
  fresh: ReadonlyArray<{ id: string; updatedAt: string }>
): Map<string, number> {
  const sorted = [...fixed].sort(byOrder)
  const buckets = new Map<number, Array<{ id: string; updatedAt: string }>>()
  for (const row of [...fresh].sort(newestFirst)) {
    const at = sorted.findIndex((other) => other.updatedAt.localeCompare(row.updatedAt) < 0)
    const index = at < 0 ? sorted.length : at
    const bucket = buckets.get(index)
    if (bucket) bucket.push(row)
    else buckets.set(index, [row])
  }
  const out = new Map<string, number>()
  for (const [index, rows] of buckets) {
    const orders = spread(sorted[index - 1]?.order, sorted[index]?.order, rows.length)
    rows.forEach((row, at) => out.set(row.id, orders[at]!))
  }
  return out
}

/** The order that puts a row before every row of its group. */
export function frontOrder(orders: readonly number[]): number {
  return orders.length ? Math.min(...orders) - 1 : 0
}

/**
 * Orders for the rows in `sequence` that have none, so that the whole sequence is in the order given. The
 * rows that have an order keep it and must already be in ascending order.
 */
export function interleave(
  sequence: ReadonlyArray<{ id: string; order?: number }>
): Map<string, number> {
  const out = new Map<string, number>()
  let at = 0
  while (at < sequence.length) {
    if (sequence[at]!.order !== undefined) {
      at += 1
      continue
    }
    let end = at
    while (end < sequence.length && sequence[end]!.order === undefined) end += 1
    const orders = spread(sequence[at - 1]?.order, sequence[end]?.order, end - at)
    for (let k = at; k < end; k += 1) out.set(sequence[k]!.id, orders[k - at]!)
    at = end
  }
  return out
}

/** Whether a row moved to the front of its group on its own computer between two snapshots. */
export function movedToFront(
  before: number | undefined,
  now: number,
  others: readonly number[]
): boolean {
  return before !== undefined && now < before && others.every((order) => now < order)
}

// ---------------------------------------------------------------------------------------- rows

export interface RowContext {
  node: string
  /** Whether the computer is out of reach: its rows are what it last said. */
  offline: boolean
  /** Whether the computer has stopped sharing its threads with this one; its rows are what it last said. */
  notShared?: boolean
}

export { isListedComputer } from '../../../shared/net/listedComputer'

/** One thread row of a (qualified) lists snapshot as a row of the merged lists, with its place. */
export function threadRow(
  raw: Record<string, unknown>,
  order: number,
  context: RowContext
): Thread {
  const row: Thread = {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    order,
    node: context.node
  }
  if (typeof raw.projectId === 'string') row.projectId = raw.projectId
  if (typeof raw.pinnedAt === 'string') row.pinnedAt = raw.pinnedAt
  if (typeof raw.settledAt === 'string') row.settledAt = raw.settledAt
  if (typeof raw.startedAt === 'string') row.startedAt = raw.startedAt
  if (raw.worktreeEnabled === true) row.worktreeEnabled = true
  if (isRecord(raw.lineage)) row.lineage = raw.lineage as unknown as Thread['lineage']
  // A mode a newer computer added and this one does not know reads as the strictest, never a looser one.
  if (typeof raw.permissionMode === 'string')
    row.permissionMode = normalizePermissionMode(raw.permissionMode)
  if (isRecord(raw.modelOverride))
    row.modelOverride = raw.modelOverride as unknown as Thread['modelOverride']
  if (isRecord(raw.startedFrom))
    row.startedFrom = raw.startedFrom as unknown as Thread['startedFrom']
  if (isRecord(raw.sentFrom)) row.sentFrom = raw.sentFrom as unknown as Thread['sentFrom']
  if (context.notShared) row.notShared = true
  else if (context.offline) row.offline = true
  return row
}

/** One project row of a (qualified) lists snapshot. `order` puts it after this computer's own projects. */
export function projectRow(
  raw: Record<string, unknown>,
  order: number,
  context: RowContext,
  sameAs?: string,
  similarTo?: string
): Project {
  const row: Project = {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    // The owner's path is only for showing; the interface never parses it with this computer's rules.
    path: typeof raw.path === 'string' ? raw.path : '',
    createdAt: '',
    order,
    node: context.node
  }
  if (typeof raw.pinnedAt === 'string') row.pinnedAt = raw.pinnedAt
  if (sameAs) row.sameAs = sameAs
  else if (similarTo) row.similarTo = similarTo
  if (context.notShared) row.notShared = true
  else if (context.offline) row.offline = true
  return row
}

/** Rows are the same row when everything they say is the same; an unchanged row keeps its object. */
export function sameRow(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---------------------------------------------------------------------------------------- the cache

interface CacheThread {
  id: string
  settledAt?: string
  updatedAt?: string
  lineage?: { parentThreadId?: string }
}

/**
 * A computer's lists cut to at most `maxBytes` as JSON, for the copy kept on disk. Threads archived longest
 * ago go first, then the ones updated longest ago; a thread takes the subagents under it with it. The
 * threads that are kept are not changed.
 */
export function fitSnapshot<T extends { threads: CacheThread[]; status?: Record<string, unknown> }>(
  snapshot: T,
  maxBytes: number
): T {
  const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
  if (size(snapshot) <= maxBytes) return snapshot
  const roots = snapshot.threads
    .filter((thread) => !thread.lineage)
    .sort(
      (a, b) =>
        Number(!a.settledAt) - Number(!b.settledAt) ||
        (a.settledAt ?? a.updatedAt ?? '').localeCompare(b.settledAt ?? b.updatedAt ?? '') ||
        a.id.localeCompare(b.id)
    )
  const step = Math.max(1, Math.ceil(roots.length / 20))
  for (let dropped = step; ; dropped += step) {
    const gone = new Set(roots.slice(0, dropped).map((thread) => thread.id))
    for (let grew = true; grew;) {
      grew = false
      for (const thread of snapshot.threads) {
        const parent = thread.lineage?.parentThreadId
        if (parent && gone.has(parent) && !gone.has(thread.id)) {
          gone.add(thread.id)
          grew = true
        }
      }
    }
    const fitted = {
      ...snapshot,
      threads: snapshot.threads.filter((thread) => !gone.has(thread.id)),
      ...(snapshot.status
        ? {
            status: Object.fromEntries(
              Object.entries(snapshot.status).filter(([id]) => !gone.has(id))
            )
          }
        : {})
    }
    if (size(fitted) <= maxBytes || dropped >= roots.length) return fitted
  }
}
