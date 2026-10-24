import type { Delegations } from '../Delegations'
import type { DelegationRecord, ThreadEvent } from '../types'

/** The parent thread of a subagent thread, or undefined for any other thread. */
export function subagentParentOf(delegations: Delegations, threadId: string): string | undefined {
  const lineage = delegations.getLineage(threadId)
  return lineage?.relationship === 'subagent' ? lineage.parentThreadId : undefined
}

/**
 * The parent whose subagent list a run-store event changes: a delegation moving state (written on the
 * parent's thread) or a run starting or changing status on a subagent's thread. Other events (tool
 * rows, inbox rows, transfers) do not change what the list shows.
 */
export function subagentParentOfEvent(
  delegations: Delegations,
  event: Pick<ThreadEvent, 'threadId' | 'type' | 'payload'>
): string | undefined {
  if (event.type === 'delegation.status') return (event.payload as DelegationRecord).parentThreadId
  if (event.type === 'run.created' || event.type === 'run.status') return subagentParentOf(delegations, event.threadId)
  return undefined
}
