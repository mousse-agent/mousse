/**
 * What the app shows about one thread's subagents. Built by the daemon from delegations, lineage,
 * runs, pending questions and thread names (`src/mms/run/delegation/subagentView.ts`).
 */

/**
 * How a delegated task ended. Fixed once terminal, whether or not anyone has read the result.
 * `waiting_for_subagents` is not terminal: the child's own run ended but the child is still busy
 * (its own subagents are running, or something addressed to it is unconsumed), so no result is
 * published yet.
 */
export type SubagentTaskOutcome = 'running' | 'waiting_for_subagents' | 'done' | 'failed' | 'stopped' | 'interrupted'

/**
 * What the child thread is doing right now, from its runs and pending questions. `waiting` is a
 * child with no live run that is still busy: an outbound delegation is running, or an inbox row
 * addressed to it is not yet acknowledged. `paused` is a run waiting for a usage limit to reset.
 */
export type SubagentActivity = 'needs_input' | 'queued' | 'starting' | 'working' | 'paused' | 'waiting' | 'idle'

/** What a row shows: the child's activity while it has any, else its latest task's outcome. */
export type SubagentState =
  | Exclude<SubagentActivity, 'idle'>
  | Exclude<SubagentTaskOutcome, 'running' | 'waiting_for_subagents'>
  | 'idle'

/** One subagent a waiting subagent is waiting on. */
export interface SubagentWaitingOn {
  title: string
  state: SubagentState
}

/** Most entries `waitingOn` lists; a waiting subagent can have many. */
export const SUBAGENT_WAITING_ON_LIMIT = 8

export interface SubagentTaskSummary {
  delegationId: string
  childRunId: string
  outcome: SubagentTaskOutcome
  /** The result is published and the parent has not taken it yet. */
  unread: boolean
  /** The child has newer work than this task. */
  continued: boolean
  createdAt: string
  completedAt: string | null
  /** Why a `failed`, `stopped` or `interrupted` task ended, when known. */
  error?: string
}

export interface SubagentSummary {
  childThreadId: string
  title: string
  activity: SubagentActivity
  state: SubagentState
  /** The most recent task, oldest-first `tasks` last entry. */
  latestDelegationId: string
  unread: boolean
  /** Provider instance id the child was asked to run on; null when it inherited the parent's. */
  provider: string | null
  model: string | null
  workspace: 'shared' | 'isolated' | null
  role: string | null
  createdAt: string
  /** The latest of the child's task and run timestamps. */
  updatedAt: string
  /**
   * While this subagent is waiting (`state` or its latest task is waiting), the subagents it
   * started that are still unfinished, oldest first, at most `SUBAGENT_WAITING_ON_LIMIT`. Empty
   * otherwise, and when it waits on something that is not a subagent.
   */
  waitingOn: SubagentWaitingOn[]
  /** Every task given to this child, oldest first. */
  tasks: SubagentTaskSummary[]
}

/**
 * One subagent task a delivered notice reports. A notice message carries these, so the app shows
 * outcome cards without reading the notice text.
 */
export interface SubagentNoticeItem {
  delegationId: string
  childThreadId: string
  title: string | null
  /** The status of the run that produced the result (`completed`, `failed`, ...). */
  runStatus: string
  /** The whole result is in the notice; otherwise the rest is read with `task_status`. */
  fullyShown: boolean
}

export interface SubagentsUpdatedEvent {
  parentThreadId: string
}

/** States of a subagent that has not finished: it is working, queued, needs input, or waits on its own subagents. */
const RUNNING_SUBAGENT_STATES: ReadonlySet<SubagentState> = new Set<SubagentState>(['needs_input', 'queued', 'starting', 'working', 'paused', 'waiting'])

/** True while a subagent is still going, so a list can count it as "running". */
export function isRunningSubagent(subagent: Pick<SubagentSummary, 'state'>): boolean {
  return RUNNING_SUBAGENT_STATES.has(subagent.state)
}
