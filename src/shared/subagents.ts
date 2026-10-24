/**
 * What the app shows about one thread's subagents. Built by the daemon from delegations, lineage,
 * runs, pending questions and thread names (`src/mms/run/delegation/subagentView.ts`).
 */

/** How a delegated task ended. Fixed once terminal, whether or not anyone has read the result. */
export type SubagentTaskOutcome = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'

/** What the child thread is doing right now, from its runs and pending questions. */
export type SubagentActivity = 'needs_input' | 'queued' | 'starting' | 'working' | 'idle'

/** What a row shows: the child's activity while it has any, else its latest task's outcome. */
export type SubagentState = Exclude<SubagentActivity, 'idle'> | Exclude<SubagentTaskOutcome, 'running'> | 'idle'

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
  /** Every task given to this child, oldest first. */
  tasks: SubagentTaskSummary[]
}

export interface SubagentsUpdatedEvent {
  parentThreadId: string
}
