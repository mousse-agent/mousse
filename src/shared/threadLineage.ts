import { qualifyId } from './threadRef'
import type { Thread, ThreadActivitySnapshot, ThreadActivityState } from './types'

type LineageThread = Pick<Thread, 'id' | 'lineage'>

/**
 * True for a private thread (`Thread.localOnly`) and for any subagent below one. The flag is written on
 * every thread a private thread starts; the lineage root in `inventory` is a second check for a child
 * written before it had the flag.
 */
export function isLocalOnlyThread(
  thread: Pick<Thread, 'localOnly' | 'lineage'>,
  inventory?: readonly Pick<Thread, 'id' | 'localOnly'>[]
): boolean {
  if (thread.localOnly === true) return true
  const rootId = thread.lineage?.rootThreadId
  return Boolean(rootId && inventory?.some((candidate) => candidate.id === rootId && candidate.localOnly === true))
}

/**
 * True for a thread shown under a parent: a subagent the parent started, or a mirror of a helper its runtime started
 * (`isNativeHelperThread`). Lists fold both under the parent, and both take the root's visibility. Delegation rules
 * read the run store's lineage, which never holds a mirror.
 */
export function isSubagentThread(thread: Pick<Thread, 'lineage'>): boolean {
  return thread.lineage?.relationship === 'subagent' || thread.lineage?.relationship === 'native'
}

/** True for a watch-only mirror of a helper a provider runtime started on its own (`Thread.native`). */
export function isNativeHelperThread(thread: Pick<Thread, 'lineage'>): boolean {
  return thread.lineage?.relationship === 'native'
}

/** True for a side chat (`ThreadLineage.relationship: 'side'`): a fork that lives in its parent's side panel only. */
export function isSideChatThread(thread: Pick<Thread, 'lineage'>): boolean {
  return thread.lineage?.relationship === 'side'
}

/** The side chats of `parentThreadId` that are not archived, newest first. */
export function sideChatsOf<T extends Pick<Thread, 'id' | 'lineage' | 'archivedAt' | 'updatedAt'>>(parentThreadId: string | null | undefined, threads: readonly T[]): T[] {
  if (!parentThreadId) return []
  return threads
    .filter((thread) => isSideChatThread(thread) && thread.lineage!.parentThreadId === parentThreadId && !thread.archivedAt)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

function indexById<T extends LineageThread>(threads: readonly T[]): Map<string, T> {
  return new Map(threads.map((thread) => [thread.id, thread]))
}

/**
 * The parent a thread's agent started it below, when `has` knows that thread on another computer: a remote subagent
 * (`startedFrom.agent.subagent`, a `delegate_task` with `computer`). Its record on the computer that runs it has no
 * `lineage`, since its parent is not a thread there. The parent is named by its id on its own computer: qualified on any
 * computer but that one, plain on it, where only the other computer's row of the subagent is seen (`node`).
 */
export function remoteSubagentParentId(thread: Partial<Pick<Thread, 'lineage' | 'node' | 'startedFrom'>>, has: (id: string) => boolean): string | undefined {
  const from = thread.startedFrom
  if (thread.lineage || !from?.agent?.subagent) return undefined
  const qualified = qualifyId(from.node, from.agent.thread)
  if (has(qualified)) return qualified
  return thread.node && thread.node !== from.node && has(from.agent.thread) ? from.agent.thread : undefined
}

/**
 * The thread a list shows `thread` below, when `has` knows it: a subagent's parent, or a remote subagent's
 * (`remoteSubagentParentId`). Undefined for a thread listed on its own, which a subagent whose parent is gone is.
 */
export function listedParentId(thread: LineageThread & Partial<Pick<Thread, 'node' | 'startedFrom'>>, has: (id: string) => boolean): string | undefined {
  if (isSubagentThread(thread)) return has(thread.lineage!.parentThreadId) ? thread.lineage!.parentThreadId : undefined
  return remoteSubagentParentId(thread, has)
}

/**
 * The threads a list shows once subagents are folded under their parents: every thread except a
 * subagent whose parent is in `inventory`, on this computer or another (`listedParentId`). A subagent
 * whose parent is gone (trashed, purged) has nothing to show under, so it stays in the list as a normal
 * thread; the check is per level, so a nested subagent hides under its parent even when that parent is
 * itself shown as an orphan.
 *
 * `inventory` is the complete set of threads the parents are looked up in. Pass it when `threads`
 * is a slice of it (one project, search matches), so a slice never decides a parent is missing.
 */
export function visibleThreads<T extends LineageThread>(threads: readonly T[], inventory: readonly LineageThread[] = threads): T[] {
  const known = new Set(inventory.map((thread) => thread.id))
  const has = (id: string) => known.has(id)
  // The Automation manager's thread is opened from Automations ("Open conversation"), never listed; a side chat is
  // opened from its parent's side panel only, even when that parent is gone.
  return threads.filter((thread) => !(thread as Partial<Pick<Thread, 'automationManager'>>).automationManager && !isSideChatThread(thread) && listedParentId(thread, has) === undefined)
}

/**
 * The thread a list shows in place of `threadId`: the thread itself, or for a subagent (here or on another
 * computer, `listedParentId`) its nearest ancestor that is not a subagent. A subagent whose parent is not in
 * `threads` (trashed, or not loaded) has nothing above it to show under, so it stands for itself. Undefined
 * for an unknown id.
 */
export function nearestVisibleAncestor(threadId: string, threads: readonly LineageThread[]): string | undefined {
  const byId = indexById(threads)
  const has = (id: string) => byId.has(id)
  let current = byId.get(threadId)
  if (!current) return undefined
  const seen = new Set<string>()
  for (let parentId = listedParentId(current, has); parentId !== undefined && !seen.has(current.id); parentId = listedParentId(current, has)) {
    seen.add(current.id)
    current = byId.get(parentId)!
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

/**
 * `subagentDescendants` for many threads of one inventory: indexes `threads` once and returns the lookup, so a list
 * asks for each of its rows without walking the whole inventory every time.
 */
export function subagentDescendantsIn(threads: readonly LineageThread[]): (threadId: string) => string[] {
  const childrenOf = childrenByParent(threads)
  return (threadId) => descendantsIn(childrenOf, threadId)
}

/** Ids of every subagent thread below `threadId` (children, their children, …), nearest first. */
export function subagentDescendants(threadId: string, threads: readonly LineageThread[]): string[] {
  return descendantsIn(childrenByParent(threads), threadId)
}

function rolledUp(own: ThreadActivityState, below: readonly (ThreadActivityState | undefined)[]): ThreadActivityState {
  if (own === 'awaiting_input') return own
  if (below.includes('awaiting_input')) return 'awaiting_input'
  if (own === 'processing' || below.includes('processing')) return 'processing'
  // A run waiting out a usage limit is not working, but the row should not read Waiting or Done either.
  if (own === 'paused' || below.includes('paused')) return 'paused'
  return own
}

/**
 * The activity a thread row shows once its subagents are counted: needing input anywhere below
 * outranks running anywhere below, and either outranks the thread's own state unless that is already
 * needing input. A pause anywhere below comes after running. Finished or idle subagents add nothing,
 * so a quiet parent stays quiet.
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

/**
 * True for a thread kept out of the owner's sidebar by one of their bots (`Thread.hidden` on a thread a bot started),
 * and for any subagent below one: a subagent takes its root's visibility. Such a thread notifies the owner only when
 * they chose `notifications.botThreads`; Show in sidebar clears the mark and it notifies like any thread again. A hidden
 * thread an agent started is not one: its questions and approvals are the person's, so it notifies like any thread.
 */
export function hiddenFromOwner(
  threadId: string,
  threadOf: (id: string) => Pick<Thread, 'id' | 'lineage' | 'hidden' | 'startedByBot'> | undefined
): boolean {
  const quiet = (thread: Pick<Thread, 'hidden' | 'startedByBot'> | undefined) => Boolean(thread?.hidden && thread.startedByBot)
  let current = threadOf(threadId)
  if (current?.lineage?.rootThreadId && quiet(threadOf(current.lineage.rootThreadId))) return true
  for (let depth = 0; current && depth < 64; depth++) {
    if (quiet(current)) return true
    const parentId = current.lineage?.parentThreadId
    current = parentId ? threadOf(parentId) : undefined
  }
  return false
}
