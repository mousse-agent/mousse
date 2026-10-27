/**
 * Which runs on a subagent's thread are follow-ups a person made (issue #142, D2). Such a run gets
 * a delegation row of its own, so the parent hears its result as a new completion.
 *
 * The `source` of a run, classified:
 * - conversational, tracked: `gui`, `cli`, `channel`, and `internal` (authenticated clients that are
 *   neither the GUI nor the CLI, see `admittedChatSource` in the protocol handlers);
 * - never tracked: `delegation` (it has its row already), `wake` (delivers a result, is not new work),
 *   `provider-continuation`, `integration`, `resume` and `resume_now` (the continue turn after a
 *   usage-limit pause: the task is the paused run's), `steer-late` and `steer-followup` (a steer that
 *   missed its turn), `lease-race`, `queue` (a legacy queue item without a source), `schedule`,
 *   `workflow-observer`, `protocol`, `cli-steer`, `protocol-steer` and local actions (undo, restore).
 */
export const FOLLOW_UP_SOURCES: ReadonlySet<string> = new Set(['gui', 'cli', 'channel', 'internal'])

/** Whether a run with this `source` on a subagent thread is tracked as a follow-up. */
export function isFollowUpSource(source: string): boolean {
  return FOLLOW_UP_SOURCES.has(source)
}

/**
 * Sources of work that starts on behalf of a parent or of the engine, not of a person: a delegated
 * task or follow-up (`delegation`), the wake and the queued steer that deliver a subagent's result
 * (`wake`, `steer-late`), a provider's own continuation turn, an integration, and the continue turn
 * that follows a usage-limit pause (`resume`, `resume_now`). The Stop fence (`stopGeneration.ts`)
 * refuses such work at execution once a Stop came after it was admitted, and while a thread is
 * paused none of it runs beside the pause, except the resume itself (`RESUME_SOURCES`). Every other
 * source (a person's send from the app, the CLI, a channel or the protocol, a plain steer left for
 * a follow-up turn, a schedule) is new intent and is never fenced.
 */
export const FENCED_SOURCES: ReadonlySet<string> = new Set([
  'delegation',
  'wake',
  'steer-late',
  'provider-continuation',
  'integration',
  'resume',
  'resume_now'
])

/** Whether work with this `source` is subject to the Stop fence. */
export function isFencedSource(source: string | null | undefined): boolean {
  return source !== null && source !== undefined && FENCED_SOURCES.has(source)
}

/** The continue turn of a paused run: `resume` at the reset time, `resume_now` when a person asked. */
export const RESUME_SOURCES: ReadonlySet<string> = new Set(['resume', 'resume_now'])

export function isResumeSource(source: string | null | undefined): boolean {
  return source !== null && source !== undefined && RESUME_SOURCES.has(source)
}
