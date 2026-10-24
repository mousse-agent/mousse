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

/** Ids of every subagent thread below `threadId` (children, their children, …), nearest first. */
export function subagentDescendants(threadId: string, threads: readonly LineageThread[]): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const thread of threads) {
    if (!isSubagentThread(thread)) continue
    const siblings = childrenOf.get(thread.lineage!.parentThreadId) ?? []
    siblings.push(thread.id)
    childrenOf.set(thread.lineage!.parentThreadId, siblings)
  }
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
  const own = activity[threadId] ?? 'idle'
  if (own === 'awaiting_input') return own
  const below = subagentDescendants(threadId, threads).map((id) => activity[id])
  if (below.includes('awaiting_input')) return 'awaiting_input'
  if (own === 'processing' || below.includes('processing')) return 'processing'
  return own
}
