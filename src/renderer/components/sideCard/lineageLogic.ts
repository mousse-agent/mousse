import { isRunningSubagent, type SubagentSummary } from '../../../shared/subagents'
import { formatAgo } from '../../lib/formatAgo'

/** Finished rows shown, once their group is open, before the list asks to be expanded. */
export const LINEAGE_COLLAPSED_COUNT = 5

/** Running rows shown before the list asks to be expanded; a few keep the card short while many work at once. */
export const LINEAGE_RUNNING_COUNT = 3

type LineageSubagent = Pick<SubagentSummary, 'childThreadId' | 'state' | 'createdAt' | 'updatedAt'>

function timeOf(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Subagents still going: working, queued, asking something, or waiting on their own subagents. */
export function countRunningSubagents(subagents: readonly Pick<SubagentSummary, 'state'>[]): number {
  return subagents.filter(isRunningSubagent).length
}

/** Heading of the section: "Lineage · 2 running" while any subagent is going, otherwise "Lineage". */
export function lineageTitle(subagents: readonly Pick<SubagentSummary, 'state'>[]): string {
  const running = countRunningSubagents(subagents)
  return running > 0 ? `Lineage · ${running} running` : 'Lineage'
}

export interface LineageGroups<T> {
  running: T[]
  finished: T[]
}

/**
 * Running subagents newest first, with those needing input ahead of the rest: they wait on the user.
 * Finished subagents most recently finished first.
 */
export function groupLineageSubagents<T extends LineageSubagent>(subagents: readonly T[]): LineageGroups<T> {
  const running: T[] = []
  const finished: T[] = []
  for (const subagent of subagents) (isRunningSubagent(subagent) ? running : finished).push(subagent)
  running.sort((left, right) => {
    const asking = Number(right.state === 'needs_input') - Number(left.state === 'needs_input')
    return asking || timeOf(right.createdAt) - timeOf(left.createdAt)
  })
  finished.sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt))
  return { running, finished }
}

/** Running subagents first, then finished ones, each in their group's order. */
export function orderLineageSubagents<T extends LineageSubagent>(subagents: readonly T[]): T[] {
  const { running, finished } = groupLineageSubagents(subagents)
  return [...running, ...finished]
}

/** Label of the folded group of finished subagents: "3 finished", or "3 finished · 1 failed". */
export function finishedGroupLabel(finished: readonly Pick<SubagentSummary, 'state'>[]): string {
  const failed = finished.filter((subagent) => subagent.state === 'failed').length
  return failed > 0 ? `${finished.length} finished · ${failed} failed` : `${finished.length} finished`
}

export interface LineageSlice<T> {
  visible: T[]
  /** Rows behind the "Show N more" row; zero once expanded or when everything fits. */
  hiddenCount: number
}

export function sliceLineage<T>(ordered: readonly T[], expanded: boolean, limit = LINEAGE_COLLAPSED_COUNT): LineageSlice<T> {
  if (expanded || ordered.length <= limit) return { visible: [...ordered], hiddenCount: 0 }
  return { visible: ordered.slice(0, limit), hiddenCount: ordered.length - limit }
}

export { formatAgo }

const RUNNING_LABELS: Record<string, string> = {
  needs_input: 'Needs input',
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working',
  paused: 'Paused'
}

const FINISHED_LABELS: Record<string, string> = {
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted'
}

/** What a subagent waits on: its own subagents when they are known, else just "subagents". */
export function waitingLabel(subagent: Pick<SubagentSummary, 'waitingOn'>): string {
  const count = subagent.waitingOn.length
  return count > 0 ? `Waiting on ${count} ${count === 1 ? 'subagent' : 'subagents'}` : 'Waiting on subagents'
}

/** Muted text on the right of a row: the state while running, otherwise how long ago it finished. */
export function lineageStatusLabel(subagent: Pick<SubagentSummary, 'state' | 'updatedAt' | 'waitingOn'>, now: number): string {
  if (subagent.state === 'waiting') return waitingLabel(subagent)
  const running = RUNNING_LABELS[subagent.state]
  if (running) return running
  const updated = Date.parse(subagent.updatedAt)
  const ago = Number.isFinite(updated) ? formatAgo(updated, now) : ''
  const prefix = FINISHED_LABELS[subagent.state]
  if (!prefix) return ago || 'Idle'
  return ago ? `${prefix} ${ago}` : prefix
}

/** One-line name for a row: the title with whitespace collapsed. */
export function lineageSubagentName(subagent: Pick<SubagentSummary, 'title'>): string {
  return subagent.title.replace(/\s+/g, ' ').trim() || 'Subagent'
}

/** Provider and model a subagent was asked to run on, or null when it inherited its parent's. */
export function lineageModelLabel(subagent: Pick<SubagentSummary, 'provider' | 'model'>): string | null {
  const label = [subagent.provider, subagent.model].filter(Boolean).join(' · ')
  return label || null
}

/** The error of a daemon that does not know the method (the code survives the socket; over IPC only the message does). */
function isUnknownMethod(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === 'method_not_allowed' || code === 'method_not_found' || code === 'method_not_available' || code === 'unknown_method') return true
  // The daemon's own rejection is `Method not allowed: <method>`; over IPC it arrives inside a longer message.
  return /(?:method[ _]not[ _](?:allowed|found|available)|unknown[ _]method)\W+subagents\.stopAll\b/i.test(error instanceof Error ? error.message : String(error))
}

/**
 * Lineage's Stop all: one call to the daemon (`subagents.stopAll`) that stops every working subagent, each
 * with its own subagents, and never the thread's own turn. Only a daemon that does not have the method (an
 * older one) falls back to stopping each working subagent on its own, which is the same Stop for those
 * subagents but, unlike the call, can wake an idle parent with a notice; that is acceptable there. Any other
 * failure (a timeout, where the call may already have run on the daemon) is not retried from this list.
 */
export async function stopAllSubagents(
  api: { stopAll(threadId: string): Promise<unknown>; abort(threadId: string): Promise<unknown> },
  threadId: string,
  subagents: readonly Pick<SubagentSummary, 'childThreadId' | 'state'>[]
): Promise<void> {
  try {
    await api.stopAll(threadId)
  } catch (error) {
    if (!isUnknownMethod(error)) {
      console.warn('Stop all failed', error)
      return
    }
    await Promise.allSettled(subagents.filter(isRunningSubagent).map((row) => api.abort(row.childThreadId)))
  }
}
