import type { RunStore } from '../RunStore'

/**
 * The fence (docs/plans/tool-api.md §2.5): an approval asked before a person's correction reached its thread can never
 * release the action. The child reads the correction first and asks again if the action still applies. Nothing is
 * stored for it: the fence is the thread's tree revisions (`treeCorrection.ts`) and the time the request was asked.
 */

/** What the asking agent is told instead of an approval: why the action did not run, and what to do. */
export const FENCED_FEEDBACK =
  'Not run: the person sent a correction after you asked for this. Read the correction, and ask again only if this action still applies.'

/**
 * The first correction that reached `threadId` at or after `since` (a request's `createdAt`), or null. A correction
 * reached the thread when its relayed row is in the thread's inbox, or its delivery record names the thread and was
 * sent (a subagent on another computer, `not_sent`, never got it). The same millisecond counts as after: a request can
 * not have read a correction posted in the instant it was asked.
 */
export function correctionSince(store: RunStore, threadId: string, since: string): string | null {
  const row = store.db
    .statement(
      `SELECT r.revision_id FROM tree_revisions r
       WHERE r.created_at >= ? AND (
         EXISTS (SELECT 1 FROM inbox i WHERE i.thread_id = ? AND i.kind = 'reconcile_notice'
           AND json_extract(i.payload, '$.kind') = 'agent_note' AND json_extract(i.payload, '$.from') = 'person'
           AND json_extract(i.payload, '$.revisionId') = r.revision_id)
         OR EXISTS (SELECT 1 FROM json_each(r.deliveries) d
           WHERE json_extract(d.value, '$.threadId') = ? AND json_extract(d.value, '$.state') != 'not_sent'))
       ORDER BY r.created_at, r.rowid LIMIT 1`
    )
    .get(since, threadId, threadId)
  return typeof row?.revision_id === 'string' ? row.revision_id : null
}
