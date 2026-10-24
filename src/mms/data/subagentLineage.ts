import type { Thread, ThreadLineage } from '../../shared/types'
import type { ThreadDataStore } from './ThreadDataStore'

/** The run store's lineage rows for subagent children: `threadId` is the child. */
export interface SubagentLineageRow {
  threadId: string
  parentThreadId: string
}

/** The lineage a new child of `parent` gets: rooted where the parent is rooted. */
export function lineageForChild(parent: Pick<Thread, 'id' | 'lineage'>): ThreadLineage {
  return { parentThreadId: parent.id, rootThreadId: parent.lineage?.rootThreadId ?? parent.id, relationship: 'subagent' }
}

/** Walks `parentOf` up from `threadId` to the top of its chain; a cycle stops at the thread that closes it. */
function rootOf(threadId: string, parentOf: ReadonlyMap<string, string>): string {
  const seen = new Set<string>()
  let current = threadId
  while (parentOf.has(current) && !seen.has(current)) {
    seen.add(current)
    current = parentOf.get(current)!
  }
  return current
}

/**
 * Boot repair for children created before thread metadata carried lineage: copies each run-store
 * lineage row into its child's metadata. Idempotent (a child that already has the same lineage is
 * left alone) and limited to threads the lifecycle store considers visible, so a trashed child is
 * skipped rather than touched. Only metadata changes: no lifecycle ownership is adopted, and
 * `updatedAt` is kept so the sidebar order does not move. Returns the repaired thread ids.
 */
export function backfillSubagentLineage(threads: ThreadDataStore, rows: readonly SubagentLineageRow[]): string[] {
  const parentOf = new Map(rows.map((row) => [row.threadId, row.parentThreadId]))
  const repaired: string[] = []
  for (const row of rows) {
    try {
      const thread = threads.getThread(row.threadId)
      if (!thread) continue
      const lineage: ThreadLineage = {
        parentThreadId: row.parentThreadId,
        rootThreadId: rootOf(row.parentThreadId, parentOf),
        relationship: 'subagent'
      }
      const current = thread.lineage
      if (current && current.parentThreadId === lineage.parentThreadId && current.rootThreadId === lineage.rootThreadId) continue
      threads.updateThreadMeta(row.threadId, { lineage }, { touch: false })
      repaired.push(row.threadId)
    } catch (error) {
      console.warn('subagent lineage could not be backfilled', { threadId: row.threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return repaired
}
