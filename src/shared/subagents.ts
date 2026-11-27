import type { MonitorEnd, MonitorKind } from './backgroundWork'
import type { AnsweredQuestion } from './types'

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
  /** The start of the task's result, on a removed subagent's tasks only (its thread, which holds the reply, is gone). */
  summary?: string
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
  /** Set on a remote subagent (issue #469): the computer that runs it. */
  computer?: SubagentComputer
  /**
   * The subagent's thread is gone (deleted), so it has no name and nothing to open: only what its tasks left. Such
   * rows come in `subagents.list`'s separate `removed` list, never in `subagents`, so a client that does not know
   * them lists only live subagents.
   */
  removed?: true
}

/** The computer a remote subagent runs on, as its row shows it. */
export interface SubagentComputer {
  /** Its Net node id. */
  node: string
  name: string
  /** Connected now. An offline computer's subagent may still be working there: this is not an outcome. */
  online: boolean
  /** Its thread there, as a qualified id this computer opens; absent until that computer created it. */
  ref?: string
  /** Why the latest call to that computer failed, while its task is still open. */
  lastError?: string
  /** A Stop has not reached that computer yet; it is sent when that computer answers. */
  stopRequested?: true
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
  /**
   * What the notice says when it is not a task's result: its subagent waits for an answer (`question`), or the task
   * was stopped before it finished (`stopped`). Such an item has nothing to read with `task_status`.
   * `answer` is not about a subagent: the person answered (or dismissed) a question this thread's own agent asked
   * without waiting. Its `childThreadId` is the thread itself. The transcript shows nothing for it: the answers row was
   * recorded when the person answered. A queued copy that waits for its turn shows `answers`.
   */
  event?: 'question' | 'stopped' | 'answer' | 'note' | 'monitor' | 'wake'
  /** With `event: 'question'`: the question the subagent waits on. With `event: 'answer'`: the question answered. */
  requestId?: string
  /** With `event: 'answer'`: the answers as the transcript shows them. */
  answers?: AnsweredQuestion[]
  /**
   * With `event: 'note'`: another agent's note (`thread_send` intent `note`). `childThreadId` and `title` are its
   * sender's; `from` says where the sender stands to this thread. The transcript shows its words, not the notice text.
   */
  note?: { from: 'parent' | 'ancestor' | 'subagent' | 'sibling' | 'bot' | 'person' | 'relay'; text: string }
  /**
   * With `event: 'monitor'`: what this thread's monitor, background command or hold reported (`delegationId` is its id,
   * `title` its description, `childThreadId` the thread itself), and on its last notice how it ended.
   */
  monitor?: { kind: MonitorKind; lines: string[]; dropped?: number; end?: MonitorEnd; tail?: string }
  /**
   * With `event: 'wake'`: this thread's own wake-up (`wake`) is due or what it waited on happened (`delegationId` is its
   * id, `title` what happened in a few words, `childThreadId` the thread itself); `brief` is what the agent wrote for itself.
   */
  wake?: { brief: string }
}

/**
 * One provider background task (a Claude Code background agent or shell) a continuation message reports:
 * the message Claude's own turn opens with when such a task finished. The app shows it as a notice row,
 * or on the task's subagent card, and never reads the message text.
 */
export interface BackgroundTaskNoticeItem {
  /** The provider's task id: a background agent's row carries it as `nativeId`. */
  taskId: string
  /** What the provider calls the task ("Map design language", "Install dependencies"), when it named it. */
  description?: string
}

export interface SubagentsUpdatedEvent {
  parentThreadId: string
}

/** States of a subagent that has not finished: it is working, queued, needs input, or waits on its own subagents. */
const RUNNING_SUBAGENT_STATES: ReadonlySet<SubagentState> = new Set<SubagentState>(['needs_input', 'queued', 'starting', 'working', 'paused', 'waiting'])

/** States of a subagent doing work now: its run is queued, starting or working. */
const WORKING_SUBAGENT_STATES: ReadonlySet<SubagentState> = new Set<SubagentState>(['queued', 'starting', 'working'])

/**
 * True while a subagent is doing work now, unlike `isRunningSubagent`: one paused on a usage limit or waiting for a
 * person's answer is not, however long that lasts. One waiting on subagents of its own is while one of those works
 * (or while it waits on something that is not a subagent).
 */
export function isWorkingSubagent(subagent: Pick<SubagentSummary, 'state' | 'waitingOn'>): boolean {
  if (WORKING_SUBAGENT_STATES.has(subagent.state)) return true
  if (subagent.state !== 'waiting') return false
  return subagent.waitingOn.length === 0 || subagent.waitingOn.some((entry) => entry.state === 'waiting' || WORKING_SUBAGENT_STATES.has(entry.state))
}

/** True while a subagent is still going, so a list can count it as "running". */
export function isRunningSubagent(subagent: Pick<SubagentSummary, 'state'>): boolean {
  return RUNNING_SUBAGENT_STATES.has(subagent.state)
}
