import { isRunningSubagent, type SubagentSummary } from '../../../shared/subagents'

/** Rows shown before the list asks to be expanded. */
export const LINEAGE_COLLAPSED_COUNT = 5

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

/**
 * Running subagents come first, newest first; finished ones follow, most recently finished first.
 * Needing input is the one running state that sorts ahead of the rest: it is waiting on the user.
 */
export function orderLineageSubagents<T extends LineageSubagent>(subagents: readonly T[]): T[] {
  const running: T[] = []
  const finished: T[] = []
  for (const subagent of subagents) (isRunningSubagent(subagent) ? running : finished).push(subagent)
  running.sort((left, right) => {
    const asking = Number(right.state === 'needs_input') - Number(left.state === 'needs_input')
    return asking || timeOf(right.createdAt) - timeOf(left.createdAt)
  })
  finished.sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt))
  return [...running, ...finished]
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

/** Short relative label such as "just now", "5m ago" or "2d ago"; empty when the time is unknown. */
export function formatAgo(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp)) return ''
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`
}

const RUNNING_LABELS: Record<string, string> = {
  needs_input: 'Needs input',
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working'
}

const FINISHED_LABELS: Record<string, string> = {
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted'
}

/** What a subagent waits on: its own subagents when they are known, else just "subagents". */
function waitingLabel(subagent: Pick<SubagentSummary, 'waitingOn'>): string {
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
