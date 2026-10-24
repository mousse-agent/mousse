import { isTerminalAgentStatus, type Agent } from '../../../shared/types'

/** Rows shown before the list asks to be expanded. */
export const LINEAGE_COLLAPSED_COUNT = 5

type LineageAgent = Pick<Agent, 'status' | 'createdAt' | 'idleAt' | 'exitedAt'>

/** Agent is doing work right now, as opposed to waiting on a merge or finished. */
export function isWorkingLineageAgent(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'starting' || agent.status === 'running'
}

function timeOf(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** When the agent finished, falling back to when it last went idle, then to when it started. */
export function lineageFinishedAt(agent: LineageAgent): number {
  return timeOf(agent.exitedAt) ?? timeOf(agent.idleAt) ?? timeOf(agent.createdAt) ?? 0
}

/**
 * Working agents come first, then agents waiting on a merge, each newest first;
 * finished agents follow, most recently finished first.
 */
export function orderLineageAgents<T extends LineageAgent>(agents: readonly T[]): T[] {
  const active: T[] = []
  const finished: T[] = []
  for (const agent of agents) (isTerminalAgentStatus(agent.status) ? finished : active).push(agent)
  active.sort((left, right) => {
    const working = Number(isWorkingLineageAgent(right)) - Number(isWorkingLineageAgent(left))
    return working || (timeOf(right.createdAt) ?? 0) - (timeOf(left.createdAt) ?? 0)
  })
  finished.sort((left, right) => lineageFinishedAt(right) - lineageFinishedAt(left))
  return [...active, ...finished]
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

const ACTIVE_LABELS: Record<string, string> = {
  starting: 'Starting',
  running: 'Running',
  ready: 'Ready',
  merging: 'Merging',
  conflict: 'Conflict'
}

const FINISHED_PREFIX: Record<string, string> = {
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted'
}

/** Muted text on the right of a row: the status while active, otherwise how long ago it finished. */
export function lineageStatusLabel(agent: LineageAgent & Pick<Agent, 'status'>, now: number): string {
  if (!isTerminalAgentStatus(agent.status)) return ACTIVE_LABELS[agent.status] ?? agent.status
  const ago = formatAgo(lineageFinishedAt(agent), now)
  const prefix = FINISHED_PREFIX[agent.status]
  if (!prefix) return ago
  return ago ? `${prefix} ${ago}` : prefix
}

/** One-line name for a row: the task with whitespace collapsed, or the agent type when there is none. */
export function lineageAgentName(agent: Pick<Agent, 'task' | 'cliType'>): string {
  return agent.task.replace(/\s+/g, ' ').trim() || agent.cliType
}
