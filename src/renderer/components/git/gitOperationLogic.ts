import type { GitOperationEvent, GitOperationKind } from '../../../shared/types'

/** Lines of a running or failed action kept for "Show output". */
export const MAX_OPERATION_LINES = 200
/** Longest piece of the last output line shown beside the status. */
const MAX_HEADLINE_LINE = 100

export type GitOperationPhaseView = 'starting' | 'running' | 'done' | 'failed' | 'cancelled'

/** One Git action of the folder as the renderer follows it: from the press of the button to its outcome. */
export interface GitOperationState {
  operationId: string
  kind: GitOperationKind
  /** `starting` until the daemon reports the action has begun, which is also when Cancel starts to work. */
  phase: GitOperationPhaseView
  startedAt: number
  /** When it ended, for an outcome that stays on screen. */
  endedAt: number | null
  cancellable: boolean
  /** Cancel was pressed and the daemon has not reported the end yet. */
  cancelling: boolean
  /** The hook Git is running, or the last one that ended. */
  hook: { name: string; exitCode?: number } | null
  lines: string[]
  message: string | null
}

const VERB: Record<GitOperationKind, string> = {
  push: 'Pushing',
  pull: 'Pulling',
  fetch: 'Fetching',
  commit: 'Committing',
  checkout: 'Switching branch'
}

const NOUN: Record<GitOperationKind, string> = {
  push: 'Push',
  pull: 'Pull',
  fetch: 'Fetch',
  commit: 'Commit',
  checkout: 'Switch'
}

export function newOperationState(operationId: string, kind: GitOperationKind, now: number): GitOperationState {
  return { operationId, kind, phase: 'starting', startedAt: now, endedAt: null, cancellable: false, cancelling: false, hook: null, lines: [], message: null }
}

const active = (state: GitOperationState): boolean => state.phase === 'starting' || state.phase === 'running'

/** The state after an event of the daemon. Events of another action, and a phase after the end, change nothing. */
export function applyOperationEvent(state: GitOperationState, event: GitOperationEvent): GitOperationState {
  if (event.operationId !== state.operationId) return state
  switch (event.phase) {
    case 'started':
      return active(state) ? { ...state, phase: 'running', cancellable: event.cancellable === true } : state
    case 'hook':
      return event.hook ? { ...state, hook: event.hook } : state
    case 'output': {
      if (!event.lines?.length) return state
      const lines = [...state.lines, ...event.lines]
      return { ...state, lines: lines.length > MAX_OPERATION_LINES ? lines.slice(lines.length - MAX_OPERATION_LINES) : lines }
    }
    case 'done':
    case 'failed':
    case 'cancelled':
      if (!active(state)) return state
      return { ...state, phase: event.phase, cancelling: false, endedAt: event.at, message: event.message ?? state.message }
  }
}

/** "12s", "1m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function clip(line: string): string {
  return line.length > MAX_HEADLINE_LINE ? `${line.slice(0, MAX_HEADLINE_LINE)}…` : line
}

export interface OperationView {
  /** The status in words, without the elapsed time, which ticks and is shown apart. */
  headline: string
  /** The hook that is running now. */
  hook: string | null
  /** The newest line of output. */
  lastLine: string | null
  /** Only while the action runs. */
  elapsed: string | null
  running: boolean
  /** The Cancel button's label, or null when the action cannot be cancelled now. */
  cancelLabel: string | null
  /** An outcome that stays until the next action or Dismiss. */
  ended: boolean
}

export function describeOperation(state: GitOperationState, now: number): OperationView {
  const running = active(state)
  const hook = running && state.hook && state.hook.exitCode === undefined ? state.hook.name : null
  const lastLine = state.lines.length ? clip(state.lines[state.lines.length - 1]) : null
  const headline = running
    ? `${state.cancelling ? 'Cancelling' : VERB[state.kind]}…`
    : state.phase === 'cancelled' ? `${NOUN[state.kind]} cancelled` : state.phase === 'failed' ? `${NOUN[state.kind]} failed` : `${NOUN[state.kind]} finished`
  const canCancel = running && state.phase === 'running' && state.cancellable && !state.cancelling
  return {
    headline,
    hook,
    lastLine,
    elapsed: running ? formatElapsed(now - state.startedAt) : null,
    running,
    // A pull stopped halfway can leave a merge or rebase to finish or abort.
    cancelLabel: canCancel ? (state.kind === 'pull' ? 'Cancel — may leave a merge in progress' : 'Cancel') : null,
    ended: !running
  }
}
