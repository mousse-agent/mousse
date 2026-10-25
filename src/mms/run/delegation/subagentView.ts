import {
  SUBAGENT_WAITING_ON_LIMIT,
  type SubagentActivity,
  type SubagentState,
  type SubagentSummary,
  type SubagentTaskOutcome,
  type SubagentTaskSummary
} from '../../../shared/subagents'
import type { Delegations } from '../Delegations'
import type { Inbox } from '../Inbox'
import type { RunStore } from '../RunStore'
import { TERMINAL_RUN_STATUSES, type DelegationRecord, type RunRecord, type RunStatus } from '../types'

/** What the view reads besides the run store. */
export interface SubagentViewSources {
  delegations: Delegations
  inbox: Inbox
  store: RunStore
  /** The child's thread, or undefined when it is gone (trashed or purged): such a child is not listed. */
  thread: (threadId: string) => { name: string } | undefined
  hasPendingQuestion: (threadId: string) => boolean
}

/**
 * Runs that deliver something to a thread already working on a task, not new work on it. A live
 * run of one of these sources does not make an earlier task "continued".
 */
const NON_CONTINUATION_SOURCES: ReadonlySet<string> = new Set(['wake', 'provider-continuation'])

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
 * `stopped` even when it had published. A task that has not published yet follows its child run,
 * except that a child whose run ended while it is still `busy` is `waiting_for_subagents`, never
 * `done`.
 */
export function taskOutcome(delegation: DelegationRecord, childRun: RunRecord | null, busy = false): SubagentTaskOutcome {
  if (delegation.status === 'cancelled') return 'stopped'
  const interruptedBy = childRun?.outcome?.interruptedBy
  if (delegation.result) return outcomeOfRun(delegation.result.runStatus, interruptedBy)
  if (delegation.status === 'running') {
    if (!childRun) return 'interrupted'
    const outcome = outcomeOfRun(childRun.status, interruptedBy)
    return outcome !== 'running' && busy ? 'waiting_for_subagents' : outcome
  }
  // Published (`result_available`, `acknowledged`) tasks carry a result and returned above, so what
  // is left is a task that failed without one.
  return delegation.status === 'failed' ? 'failed' : 'done'
}

/** What keeps a child busy after its own runs ended. */
export interface ChildBusyInputs {
  /** The child has a delegation of its own that is still `running`. */
  runningOutboundDelegation: boolean
  /** The child has an inbox row (any kind) that is not `acknowledged`. */
  unconsumedInbox: boolean
}

/** A child is busy while a run is live, or any `ChildBusyInputs` holds. */
export function isChildBusy(runs: readonly RunRecord[], inputs: ChildBusyInputs): boolean {
  return runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) || inputs.runningOutboundDelegation || inputs.unconsumedInbox
}

/**
 * The child's own state from its runs, pending questions and busy inputs, whatever its tasks say.
 * A child with no live run that is still busy is `waiting`.
 */
export function childActivity(runs: readonly RunRecord[], pendingQuestion: boolean, inputs?: ChildBusyInputs): SubagentActivity {
  if (pendingQuestion) return 'needs_input'
  const live = runs.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
  if (live.some((run) => run.status === 'running' || run.status === 'finalizing')) return 'working'
  if (live.some((run) => run.status === 'starting')) return 'starting'
  if (live.some((run) => run.status === 'queued')) return 'queued'
  return inputs && isChildBusy(runs, inputs) ? 'waiting' : 'idle'
}

/** One row per subagent of `parentThreadId`, oldest first. */
export function buildSubagentView(sources: SubagentViewSources, parentThreadId: string): SubagentSummary[] {
  return buildView(sources, parentThreadId, new Set([parentThreadId]))
}

/** `visited` holds the threads on the path from the requested parent, so a lineage cycle ends. */
function buildView(sources: SubagentViewSources, parentThreadId: string, visited: Set<string>): SubagentSummary[] {
  const summaries: SubagentSummary[] = []
  for (const lineage of sources.delegations.listChildThreads(parentThreadId)) {
    if (lineage.relationship !== 'subagent') continue
    const thread = sources.thread(lineage.threadId)
    if (!thread) continue
    const tasks = sources.delegations.listForChildThread(lineage.threadId).filter((task) => task.parentThreadId === parentThreadId)
    if (tasks.length === 0) continue
    summaries.push(summarize(sources, lineage.threadId, thread.name, tasks, visited))
  }
  return summaries
}

function summarize(
  sources: SubagentViewSources,
  childThreadId: string,
  title: string,
  delegations: DelegationRecord[],
  visited: Set<string>
): SubagentSummary {
  const runs = sources.store.listRuns(childThreadId)
  const runById = new Map(runs.map((run) => [run.runId, run]))
  const busyInputs: ChildBusyInputs = {
    runningOutboundDelegation: sources.delegations.listForParentThread(childThreadId).some((task) => task.status === 'running'),
    unconsumedInbox:
      sources.inbox.listByStatus(childThreadId, 'pending').length > 0 || sources.inbox.listByStatus(childThreadId, 'delivered').length > 0
  }
  const busy = isChildBusy(runs, busyInputs)
  const activity = childActivity(runs, sources.hasPendingQuestion(childThreadId), busyInputs)
  const continuingOrdinals = runs
    .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status) && !NON_CONTINUATION_SOURCES.has(run.source))
    .map((run) => run.ordinal)
  const tasks: SubagentTaskSummary[] = delegations.map((delegation, index) => {
    const outcome = taskOutcome(delegation, runById.get(delegation.childRunId) ?? null, busy)
    const error = outcome === 'done' || outcome === 'running' || outcome === 'waiting_for_subagents' ? undefined : delegation.result?.error
    return {
      delegationId: delegation.delegationId,
      childRunId: delegation.childRunId,
      outcome,
      unread: delegation.status === 'result_available' || delegation.status === 'failed',
      // Newer work: a later task, or a live run ordered after this task's own run that is not a
      // delivery. A run before it (task A running while B is queued) is older work, not a follow-up.
      continued:
        index < delegations.length - 1 ||
        continuingOrdinals.some((ordinal) => ordinal > (runById.get(delegation.childRunId)?.ordinal ?? Number.NEGATIVE_INFINITY)),
      createdAt: delegation.createdAt,
      completedAt: delegation.completedAt,
      ...(error ? { error } : {})
    }
  })
  const first = delegations[0]
  const latest = delegations[delegations.length - 1]
  const latestTask = tasks[tasks.length - 1]
  const state: SubagentState =
    activity !== 'idle'
      ? activity
      : latestTask.outcome === 'running'
        ? 'working'
        : latestTask.outcome === 'waiting_for_subagents'
          ? 'waiting'
          : latestTask.outcome
  const waiting = state === 'waiting' || tasks.some((task) => task.outcome === 'waiting_for_subagents')
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
    waitingOn: waiting ? waitingOn(sources, childThreadId, visited) : [],
    tasks
  }
}

/** The unfinished subagents `childThreadId` started, bounded. */
function waitingOn(sources: SubagentViewSources, childThreadId: string, visited: Set<string>): SubagentSummary['waitingOn'] {
  if (visited.has(childThreadId)) return []
  const below = buildView(sources, childThreadId, new Set([...visited, childThreadId]))
  return below
    .filter((row) => row.tasks.some((task) => task.outcome === 'running' || task.outcome === 'waiting_for_subagents'))
    .slice(0, SUBAGENT_WAITING_ON_LIMIT)
    .map((row) => ({ title: row.title, state: row.state }))
}
