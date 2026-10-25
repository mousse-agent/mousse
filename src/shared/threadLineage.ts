import type { Thread, ThreadActivitySnapshot, ThreadActivityState } from './types'

type LineageThread = Pick<Thread, 'id' | 'lineage'>

/** True for a thread a parent thread started as a subagent. */
export function isSubagentThread(thread: Pick<Thread, 'lineage'>): boolean {
  return thread.lineage?.relationship === 'subagent'
}

function indexById<T extends LineageThread>(threads: readonly T[]): Map<string, T> {
  return new Map(threads.map((thread) => [thread.id, thread]))
}

/**
 * The threads a list shows once subagents are folded under their parents: every thread except a
 * subagent whose parent is in `inventory`. A subagent whose parent is gone (trashed, purged) has
 * nothing to show under, so it stays in the list as a normal thread; the check is per level, so a
 * nested subagent hides under its parent even when that parent is itself shown as an orphan.
 *
 * `inventory` is the complete set of threads the parents are looked up in. Pass it when `threads`
 * is a slice of it (one project, search matches), so a slice never decides a parent is missing.
 */
export function visibleThreads<T extends LineageThread>(threads: readonly T[], inventory: readonly LineageThread[] = threads): T[] {
  const known = new Set(inventory.map((thread) => thread.id))
  return threads.filter((thread) => !isSubagentThread(thread) || !known.has(thread.lineage!.parentThreadId))
}

/**
 * The thread a list shows in place of `threadId`: the thread itself, or for a subagent its nearest
 * ancestor that is not a subagent. A subagent whose parent is not in `threads` (trashed, or not
 * loaded) has nothing above it to show under, so it stands for itself. Undefined for an unknown id.
 */
export function nearestVisibleAncestor(threadId: string, threads: readonly LineageThread[]): string | undefined {
  const byId = indexById(threads)
  let current = byId.get(threadId)
  if (!current) return undefined
  const seen = new Set<string>()
  while (isSubagentThread(current) && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.lineage!.parentThreadId)
    if (!parent) break
    current = parent
  }
  return current.id
}

/**
 * The list row to highlight while `threadId` is open when that thread is a subagent and so has no
 * row of its own: its nearest visible ancestor. Null for a thread that has its own row, and for an
 * unknown thread.
 */
export function openSubagentParentRow(threadId: string, threads: readonly LineageThread[]): string | null {
  const shown = nearestVisibleAncestor(threadId, threads)
  return shown && shown !== threadId ? shown : null
}

function childrenByParent(threads: readonly LineageThread[]): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>()
  for (const thread of threads) {
    if (!isSubagentThread(thread)) continue
    const siblings = childrenOf.get(thread.lineage!.parentThreadId) ?? []
    siblings.push(thread.id)
    childrenOf.set(thread.lineage!.parentThreadId, siblings)
  }
  return childrenOf
}

function descendantsIn(childrenOf: ReadonlyMap<string, readonly string[]>, threadId: string): string[] {
  const found: string[] = []
  const seen = new Set([threadId])
  for (let queue = [threadId]; queue.length;) {
    const next: string[] = []
    for (const id of queue)
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        found.push(child)
        next.push(child)
      }
    queue = next
  }
  return found
}

/** Ids of every subagent thread below `threadId` (children, their children, …), nearest first. */
export function subagentDescendants(threadId: string, threads: readonly LineageThread[]): string[] {
  return descendantsIn(childrenByParent(threads), threadId)
}

function rolledUp(own: ThreadActivityState, below: readonly (ThreadActivityState | undefined)[]): ThreadActivityState {
  if (own === 'awaiting_input') return own
  if (below.includes('awaiting_input')) return 'awaiting_input'
  if (own === 'processing' || below.includes('processing')) return 'processing'
  return own
}

/**
 * The activity a thread row shows once its subagents are counted: needing input anywhere below
 * outranks running anywhere below, and either outranks the thread's own state unless that is already
 * needing input. Finished or idle subagents add nothing, so a quiet parent stays quiet.
 */
export function rollUpActivity(
  threadId: string,
  threads: readonly LineageThread[],
  activity: ThreadActivitySnapshot
): ThreadActivityState {
  return rolledUp(activity[threadId] ?? 'idle', subagentDescendants(threadId, threads).map((id) => activity[id]))
}

/**
 * `rollUpActivity` for every thread that has subagents, in one pass over `threads`. Threads without
 * subagents are left out; their own activity is what a row shows.
 */
export function rollUpActivities(threads: readonly LineageThread[], activity: ThreadActivitySnapshot): ThreadActivitySnapshot {
  const childrenOf = childrenByParent(threads)
  const rows: ThreadActivitySnapshot = {}
  for (const thread of threads) {
    if (!childrenOf.has(thread.id)) continue
    rows[thread.id] = rolledUp(activity[thread.id] ?? 'idle', descendantsIn(childrenOf, thread.id).map((id) => activity[id]))
  }
  return rows
}
