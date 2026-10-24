import type {
  SubagentActivity,
  SubagentState,
  SubagentSummary,
  SubagentTaskOutcome,
  SubagentTaskSummary
} from '../../../shared/subagents'
import type { Delegations } from '../Delegations'
import type { RunStore } from '../RunStore'
import { TERMINAL_RUN_STATUSES, type DelegationRecord, type RunRecord, type RunStatus } from '../types'

/** What the view reads besides the run store. */
export interface SubagentViewSources {
  delegations: Delegations
  store: RunStore
  /** The child's thread, or undefined when it is gone (trashed or purged): such a child is not listed. */
  thread: (threadId: string) => { name: string } | undefined
  hasPendingQuestion: (threadId: string) => boolean
}

/** How a terminal child run ended, as a task outcome. A user's Stop is `stopped`; a restart is `interrupted`. */
export function outcomeOfRun(status: RunStatus, interruptedBy?: string): SubagentTaskOutcome {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
    case 'uncertain':
      return 'failed'
    case 'cancelled':
      return 'stopped'
    case 'interrupted':
      return interruptedBy === 'user' ? 'stopped' : 'interrupted'
    default:
      return 'running'
  }
}

/**
 * The outcome of one task, from what it published (`result.runStatus`), never from whether its
 * result was acknowledged: reading a failure does not turn it into a success. A cancelled task is
 * `stopped` even when it had published. A task that has not published yet follows its child run.
 */
export function taskOutcome(delegation: DelegationRecord, childRun: RunRecord | null): SubagentTaskOutcome {
  if (delegation.status === 'cancelled') return 'stopped'
  const interruptedBy = childRun?.outcome?.interruptedBy
  if (delegation.result) return outcomeOfRun(delegation.result.runStatus, interruptedBy)
  if (delegation.status === 'running') {
    if (!childRun) return 'interrupted'
    return outcomeOfRun(childRun.status, interruptedBy)
  }
  return 'done'
}

/** The child's own state from its runs and pending questions, whatever its tasks say. */
export function childActivity(runs: readonly RunRecord[], pendingQuestion: boolean): SubagentActivity {
  if (pendingQuestion) return 'needs_input'
  const live = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
  if (live.some((run) => run.status === 'running' || run.status === 'finalizing')) return 'working'
  if (live.some((run) => run.status === 'starting')) return 'starting'
  if (live.some((run) => run.status === 'queued')) return 'queued'
  return 'idle'
}

/** One row per subagent of `parentThreadId`, oldest first. */
export function buildSubagentView(sources: SubagentViewSources, parentThreadId: string): SubagentSummary[] {
  const summaries: SubagentSummary[] = []
  for (const lineage of sources.delegations.listChildThreads(parentThreadId)) {
    if (lineage.relationship !== 'subagent') continue
    const thread = sources.thread(lineage.threadId)
    if (!thread) continue
    const tasks = sources.delegations.listForChildThread(lineage.threadId).filter((task) => task.parentThreadId === parentThreadId)
    if (tasks.length === 0) continue
    summaries.push(summarize(sources, lineage.threadId, thread.name, tasks))
  }
  return summaries
}

function summarize(sources: SubagentViewSources, childThreadId: string, title: string, delegations: DelegationRecord[]): SubagentSummary {
  const runs = sources.store.listRuns(childThreadId)
  const runById = new Map(runs.map((run) => [run.runId, run]))
  const activity = childActivity(runs, sources.hasPendingQuestion(childThreadId))
  const liveRunIds = new Set(runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).map((run) => run.runId))
  const tasks: SubagentTaskSummary[] = delegations.map((delegation, index) => {
    const outcome = taskOutcome(delegation, runById.get(delegation.childRunId) ?? null)
    const error = outcome === 'done' || outcome === 'running' ? undefined : delegation.result?.error
    return {
      delegationId: delegation.delegationId,
      childRunId: delegation.childRunId,
      outcome,
      unread: delegation.status === 'result_available' || delegation.status === 'failed',
      // Newer work: a later task, or a live run that is not this task's own.
      continued: index < delegations.length - 1 || [...liveRunIds].some((runId) => runId !== delegation.childRunId),
      createdAt: delegation.createdAt,
      completedAt: delegation.completedAt,
      ...(error ? { error } : {})
    }
  })
  const first = delegations[0]
  const latest = delegations[delegations.length - 1]
  const latestTask = tasks[tasks.length - 1]
  const state: SubagentState = activity !== 'idle' ? activity : latestTask.outcome === 'running' ? 'working' : latestTask.outcome
  const stamps = [latest.completedAt ?? latest.createdAt, ...runs.slice(0, 1).map((run) => run.completedAt ?? run.startedAt ?? run.requestedAt)]
  return {
    childThreadId,
    title,
    activity,
    state,
    latestDelegationId: latest.delegationId,
    unread: tasks.some((task) => task.unread),
    provider: first.provider,
    model: first.model,
    workspace: first.workspace,
    role: first.role,
    createdAt: first.createdAt,
    updatedAt: stamps.reduce((a, b) => (a > b ? a : b)),
    tasks
  }
}
