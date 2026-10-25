/**
 * Which runs on a subagent's thread are follow-ups a person made (issue #142, D2). Such a run gets
 * a delegation row of its own, so the parent hears its result as a new completion.
 *
 * The `source` of a run, classified:
 * - conversational, tracked: `gui`, `cli`, `channel`, and `internal` (authenticated clients that are
 *   neither the GUI nor the CLI, see `admittedChatSource` in the protocol handlers);
 * - never tracked: `delegation` (it has its row already), `wake` (delivers a result, is not new work),
 *   `provider-continuation`, `integration`, `steer-late` and `steer-followup` (a steer that missed its
 *   turn), `lease-race`, `queue` (a legacy queue item without a source), `schedule`,
 *   `workflow-observer`, `protocol`, `cli-steer`, `protocol-steer` and local actions (undo, restore).
 */
export const FOLLOW_UP_SOURCES: ReadonlySet<string> = new Set(['gui', 'cli', 'channel', 'internal'])

/** Whether a run with this `source` on a subagent thread is tracked as a follow-up. */
export function isFollowUpSource(source: string): boolean {
  return FOLLOW_UP_SOURCES.has(source)
}
