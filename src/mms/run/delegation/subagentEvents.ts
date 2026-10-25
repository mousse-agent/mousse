import type { Delegations } from '../Delegations'
import type { DelegationRecord, ThreadEvent } from '../types'

/**
 * The threads above `threadId` along subagent lineage, nearest first (empty for any other thread).
 * Each of them lists a subagent row that `threadId` changes: its parent shows `threadId` itself, and
 * every higher ancestor shows the thread below it, whose activity and `waitingOn` follow `threadId`.
 * A lineage cycle ends the walk.
 */
export function subagentAncestorsOf(delegations: Delegations, threadId: string): string[] {
  const ancestors: string[] = []
  const seen = new Set([threadId])
  let current = threadId
  for (;;) {
    const lineage = delegations.getLineage(current)
    if (lineage?.relationship !== 'subagent' || seen.has(lineage.parentThreadId)) return ancestors
    ancestors.push(lineage.parentThreadId)
    seen.add(lineage.parentThreadId)
    current = lineage.parentThreadId
  }
}

/**
 * The parents whose subagent list a run-store event changes: a delegation moving state (written on
 * the parent's thread), or a run or inbox row changing on a subagent's thread. Inbox rows count
 * because an unconsumed one keeps an idle child `waiting`. Other events (tool rows, transfers) do
 * not change what the list shows. Every ancestor is named, nearest first, without repeats.
 */
export function subagentParentsOfEvent(
  delegations: Delegations,
  event: Pick<ThreadEvent, 'threadId' | 'type' | 'payload'>
): string[] {
  if (event.type === 'delegation.status') {
    const parentThreadId = (event.payload as DelegationRecord).parentThreadId
    return [parentThreadId, ...subagentAncestorsOf(delegations, parentThreadId)].filter((id, index, all) => all.indexOf(id) === index)
  }
  if (event.type === 'run.created' || event.type === 'run.status' || event.type === 'inbox.status')
    return subagentAncestorsOf(delegations, event.threadId)
  return []
}
