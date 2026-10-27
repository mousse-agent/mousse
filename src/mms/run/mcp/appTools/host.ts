import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { ModelOverride } from '../../../../shared/providerInstances'
import type { AgentAccessLevel, AgentAccessSettings } from '../../../../shared/settings'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { ChatMessage, CreateScheduledJobInput, DocumentOpenPayload, PendingUserQuestions, QueuedMessage, ScheduledJob, Thread, UserQuestion, UserQuestionAnswers } from '../../../../shared/types'
import type { ScheduledJobOptionsInput } from '../../../scheduled/validateJobOptions'
import type { DevGuiTools } from '../../../devgui/DevGuiTools'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import type { ThreadSearchOptions } from '../../../data/ThreadDataStore'
import type { QuickActionTools } from '../../../orchestrator/QuickActionTools'
import type { WebTools } from '../../../orchestrator/WebTools'
import type { TaskQueue } from '../../../tasks/TaskQueue'
import type { ApprovalRefusal } from '../../approvalRights'
import type { RunEngine } from '../../RunEngine'
import type { AnsweredBy } from '../../ThreadApprovals'
import type { AgentActor, ModeCeiling } from '../../types'
import type { DelegationToolsHost } from './delegation'
import type { LiveRunGate } from './registry'
import type { ToolLedger } from './types'

/** One match of `thread_search`. */
export interface ThreadSearchHit {
  threadId: string
  threadName: string
  projectId?: string
  projectName?: string
  matchType: 'thread' | 'project' | 'message'
  snippet?: string
  messageId?: string
}

/** Ids, counts and lengths of an agent's action on another thread; never message content. `summary` is the transcript row's text. */
export type AgentActionDetails = Record<string, string | number | boolean | null>

/** What an agent's message to another thread became: a run that started now, or one that waits in the thread's queue. */
export interface AgentSendResult {
  runId: string
  sequence: number
  queued: boolean
  /** The same `clientRequestId` was sent before: this is the first result, nothing new was started. */
  replayed: boolean
  /** The mode the message was sent in: Plan when the thread is kept in Plan, whatever the sender asked for. */
  mode?: 'agent' | 'plan'
}

/** What `thread_create` asks for, checked for shape by the tool. */
export interface AgentThreadRequest {
  projectId: string
  title?: string
  /** `project`: the project's own folder. `new_worktree`: a worktree of its own, made when the thread first runs. */
  workspace: 'project' | 'new_worktree'
  /** Both together name the thread's model; neither: the caller's own selection. */
  instanceId?: string
  model?: string
  firstMessage?: string
  /** Mode of the first message; defaults to agent. */
  mode?: 'agent' | 'plan'
}

/** A thread an agent created, as the creation decided it (never as the retry's arguments say). */
export interface AgentCreatedThread {
  threadId: string
  projectId: string
  title: string
  /** What was asked for and recorded on the thread. */
  workspace: 'project' | 'new_worktree'
  /**
   * Where the thread really works: on a Git project a turn that edits gets a worktree of its own, whichever workspace was
   * asked for; on any other project it works in the project folder.
   */
  runsIn: 'own_worktree' | 'project_folder'
  /** The model the thread runs; null: the profile's default. */
  model: { instanceId: string; model: string } | null
  /** The mode the thread's turns run in: no wider than the creator's. */
  permissionMode: PermissionMode
  /** The first message: what became of it. Absent when none was asked for. */
  firstMessage?: ({ sent: true } & AgentSendResult) | { sent: false; reason: string }
  /** The same `clientRequestId` created this thread before; nothing new was made. */
  replayed: boolean
}

/** What a Stop or a steer an agent asked for did to the run it named. */
export type AgentRunCommandResult =
  | { status: 'accepted'; runId: string; sequence: number; replayed: boolean }
  /** The run is not the thread's active run (it ended, or never ran): nothing was changed. `runStatus` is the named run's own status. */
  | { status: 'ignored'; reason: string; runId?: string; activeRunId: string | null; runStatus?: string }
  | { status: 'rejected'; reason: string }
  /** A steer joins a run that is already running under a looser permission mode than the caller's own. */
  | { status: 'ceiling_exceeded'; callerMode: PermissionMode; targetMode: PermissionMode }

/** A thread's queue as a reader sees it: what is waiting, what a turn has claimed, and the revision a change must name. */
export interface QueueSnapshot {
  /** Pending and steering items, in order; internal items are left out. */
  items: QueuedMessage[]
  claimed: QueuedMessage[]
  /** Changes with every change to `items` and `claimed`; a command that names an older one is refused. */
  revision: string
  /** False while the queue takes no new messages (a merge-back waits for the thread's next turn). */
  open: boolean
  blockedReason?: 'merge_back_pending'
}

/** One change an agent asks of a thread's queue. `expectedRevision` is the revision the agent last read. */
export type AgentQueueCommand =
  | { op: 'enqueue'; content: string; mode: 'agent' | 'plan'; expectedRevision?: string }
  | { op: 'edit'; itemId: string; content?: string; mode?: 'agent' | 'plan'; expectedRevision: string }
  | { op: 'remove'; itemId: string; expectedRevision: string }
  | { op: 'reorder'; orderedIds: string[]; expectedRevision: string }
  | { op: 'promote'; itemId: string; expectedRevision: string; expectedRunId: string }

/** What a queue command did. The same for a retry of the same request (`replayed`), whatever the queue looks like by then. */
export interface AgentQueueResult {
  outcome: 'enqueued' | 'edited' | 'removed' | 'reordered' | 'promoted' | 'requeued'
  itemId: string
  /** The queue's revision right after the change. */
  revision: string
  /** The queued item, for an enqueue. */
  item?: QueuedMessage
  /** The text of the message a removal took out of the queue, on the call that removed it (the `agent.action` event keeps it too). */
  removedText?: string
  /** An `agent.action` event on the thread records the change (a change to another thread's queue, or to a message the agent did not write). */
  recorded?: boolean
  /** The change had been made before: nothing new happened. */
  replayed: boolean
  /** The side effects (ending the queued run the item owned, giving its notice rows back) are committed. False for a result returned while they are still being retried. */
  effectsSettled: boolean
}

/** A request that waits for an answer (or was answered), as `approval_respond` reads it before answering. */
export interface ApprovalRequestInfo {
  requestId: string
  /** The thread that asked. */
  threadId: string
  status: 'pending' | 'answered' | 'cancelled'
  /** A saved approval (a command, a file change, a tool), whose answers the rule `canAnswerApproval` governs; false for a plain question for the user (`ask_user`). */
  approval: boolean
  questions: UserQuestion[]
}

/** What an agent's answer to an approval did. Everything but a conflicting key is a value the caller can act on. */
export type AgentApprovalResult =
  /** Settled by this call (`replayed: false`), or by an earlier call with the same `clientRequestId` (`replayed: true`). */
  | { ok: true; decision: 'allow' | 'reject'; replayed: boolean }
  /** Someone else (a person at a client, or another agent) answered first; the request is theirs. */
  | { ok: false; reason: 'already_answered'; answeredBy?: AnsweredBy; decision?: 'allow' | 'reject' }
  /** The request was closed before anyone answered (its run ended, its thread was stopped or deleted). */
  | { ok: false; reason: 'cancelled'; cancelReason?: string }
  | { ok: false; reason: 'unknown' }
  /** The same `clientRequestId` was already used for another approval. */
  | { ok: false; reason: 'client_request_id_conflict' }
  /** The rule refused this agent (`canAnswerApproval`); the request stays pending. */
  | { ok: false; reason: ApprovalRefusal }

/**
 * What the scheduled-job tools need from the profile (`schedule_*`). Every method acts as the daemon, so the tools
 * decide what the caller may do first; none of this is reachable from model input except through them.
 */
export interface AgentScheduleHost {
  /** `scheduled.agentJobs` as it is now: off until a person turns it on, read at every call. */
  enabled(): boolean
  list(): ScheduledJob[]
  get(id: string): ScheduledJob | undefined
  /**
   * Checks the model, mode and workspace of the job as it would be after the change, as the protocol does. Throws a
   * message the agent can act on; returns the model as the profile stores it and the thread a worktree names.
   */
  validate(job: ScheduledJobOptionsInput): { selection?: ModelOverride; threadId?: string }
  /**
   * Whether a person started the caller's run (`startedByPerson`: an interactive turn from the app or the CLI). Fails
   * closed: a scheduled or webhook run, an agent's message, a subagent, a wake, a continuation, a bot, a channel, a run with
   * no recorded binding or one that cannot be read is not a person's turn. Only a person's turn may create or start jobs.
   */
  startedByPerson(caller: { threadId: string; runId: string }): boolean
  /**
   * What a job created or changed by this caller may be granted: the access level its run holds (narrowed by the profile
   * now) and the permission mode its run is bound to. The narrowest of both when the run is not a person's turn, which
   * the tools refuse before they ask.
   */
  limits(caller: { threadId: string; runId: string; accessLevel: AgentAccessLevel }): { accessCap: AgentAccessLevel; permissionCeiling: PermissionMode }
  create(input: CreateScheduledJobInput): ScheduledJob
  update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null
  pause(id: string, reason?: string): ScheduledJob | null
  /** Makes the job due now, as Run now does; a job with a run in flight or waiting is returned as it is. */
  trigger(id: string): ScheduledJob | null
  /** The scheduler ticks now instead of at the next minute, so a job that was just made due starts within seconds. */
  wake(): void
}

/**
 * What the app tools need from their owner. The profile's thread owner (the orchestrator) serves
 * the Mousse MCP server's registry; an in-process loop (`LlmClient`) serves its own registry built
 * from the same modules, so both offer identical schemas and run identical handlers.
 */
export interface AppToolHost extends DelegationToolsHost {
  askUser(
    threadId: string,
    questions: PendingUserQuestions['questions'],
    options: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<UserQuestionAnswers>
  /** Dismisses the thread's open questions (an in-process `ask_user` whose turn stopped). */
  dismissQuestions?(threadId: string): void
  presentPlan(threadId: string | undefined, payload: { title: string; markdown: string }): void
  /** The deprecated `show_document`, in process only. */
  openDocument?(payload: DocumentOpenPayload): void
  /** The thread's task queue; null when the owner keeps none (no task tools). */
  tasks(threadId: string | undefined): TaskQueue | null
  /** The run engine of the thread tools (`thread_read`, the queue, fork and merge-back); MCP only. */
  engine?: RunEngine
  browserRuntime?(): BrowserRuntimePort | undefined
  skills?(): SkillsRegistry | undefined
  quickActions?: QuickActionTools
  web?: WebTools
  devGui?: DevGuiTools
  /** SPEC §12.6 tool ledger of the caller's run, for calls over MCP. */
  toolLedger?(runId: string): ToolLedger | undefined
  /** The thread is a read-only (`shared`) delegated child; it may call only `reads` and `readOnlySafe` tools. */
  readOnlyThread?(threadId: string): boolean
  /** The ceiling the thread's delegations gave it (the listing ignores the turn's mode). */
  threadCeiling?(threadId: string): ModeCeiling
  /** The thread's role when it is a personal bot's thread (PR 6 §5). */
  botRole?(threadId: string): 'activation' | 'context' | undefined
  awaitLiveRun?(threadId: string): Promise<LiveRunGate | undefined> | undefined
  /** The permission mode the caller's run enforces, from its attempt's binding (never from the mode ceiling). */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
  // Agent access (SPEC §15.1). Optional like the methods above: a tool whose method is absent answers
  // "not available in this host", and a host without `agentAccess` grants no one more than `lineage`.
  /** The profile's agent access setting as it is now. */
  agentAccess?(): AgentAccessSettings
  /** The thread's metadata, or undefined when it does not exist. */
  threadMeta?(threadId: string): Thread | undefined
  /** Every thread of the profile, subagents included, unfiltered. */
  listThreads?(): Thread[]
  /** The profile's projects. */
  listProjects?(): Array<{ id: string; name: string }>
  /**
   * Matches over thread names, project names and messages; subagent threads are not searched. `allow`
   * (which threads the caller may see) and `titlesOnly` are applied before the limit and before any
   * transcript is read.
   */
  searchThreads?(query: string, limit: number, options?: Pick<ThreadSearchOptions, 'allow' | 'titlesOnly' | 'maxMessageThreads'>): ThreadSearchHit[]
  /** The thread's visible transcript. */
  threadMessages?(threadId: string): ChatMessage[]
  /** What waits on a thread: its queued messages and unanswered questions. */
  threadActivity?(threadId: string): { queuedCount: number; pendingQuestions: PendingUserQuestions[] }
  /** Records a change an agent made to another thread: an `agent.action` event and a transcript row. */
  recordAgentAction?(target: { threadId: string; runId?: string }, actor: AgentActor, action: string, details?: AgentActionDetails): void
  /**
   * The transcript row that shows an `agent.action` event the engine already wrote in its own transaction
   * ("Changed by an agent in thread …"). Never writes the event; only the call that made the change adds it.
   */
  showAgentAction?(target: { threadId: string }, actor: AgentActor, summary: string): void
  /**
   * Sends `content` to another thread as `actor`'s message (`thread_send`): labelled as an agent's, run under
   * the caller's permission mode when that is stricter than the thread's, queued behind a running turn, never
   * a steer, and refused while the thread waits on a question or approval or is paused. A retry with the same
   * `clientRequestId` returns the first result.
   */
  sendToThread?(threadId: string, input: { content: string; mode: 'agent' | 'plan' }, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentSendResult>
  /**
   * The first result of a send that `clientRequestId` already made to the thread, found without admitting anything; undefined
   * when the key made none. A retry past the send cap is answered with it.
   */
  earlierSend?(threadId: string, clientRequestId: string): AgentSendResult | undefined
  /**
   * Creates a thread for `actor` (`thread_create`): in the project's folder or its own worktree, on the model
   * asked for or the caller's, with a permission mode no wider than the caller's, recorded as launched by the
   * caller's thread (never nested under it), and optionally with a first message sent as the caller's. The
   * creation is decided and recorded before anything exists, so a retry with the same `clientRequestId` finishes
   * or returns that one thread, whatever the caller's run or the settings look like by then. `accessLevel` is
   * the level the caller's credential was granted.
   */
  createThread?(input: AgentThreadRequest, options: { clientRequestId: string; actor: AgentActor; accessLevel: AgentAccessLevel }): Promise<AgentCreatedThread>
  /**
   * The key has a stored creation already: a retry finishes that one thread (or its first message) and does not use up a place
   * under the caller's cap on new threads.
   */
  creationStarted?(clientRequestId: string): boolean
  /** Adds a note row to the thread's transcript (the creator's: what it launched, and on which model). */
  noteOnThread?(threadId: string, text: string): void
  /**
   * A thread's queue with its revision, read from disk after any unfinished agent command was finished. The
   * revision is what `queueCommand` must be given back.
   */
  queueSnapshot?(threadId: string): QueueSnapshot
  /**
   * One agent command on a thread's queue (`queue_enqueue`, `queue_edit`, `queue_remove`, `queue_reorder`,
   * `queue_promote_to_steer`). `options.clientRequestId` is the full request key: a retry returns the first
   * result. `options.level` is the caller's effective agent access level (it decides who may edit a message a
   * person queued). Throws a `QueueConflictError` when the queue is not as the caller expects.
   */
  queueCommand?(threadId: string, command: AgentQueueCommand, options: { clientRequestId: string; actor: AgentActor; level: AgentAccessLevel }): AgentQueueResult
  /** Stops run `runId` of another thread and what is below it, as `actor`'s Stop (`thread_interrupt`). */
  stopRun?(threadId: string, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /** Steers run `runId` of another thread with `text` as `actor`'s message (`thread_steer`). */
  steerRun?(threadId: string, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /** The profile's scheduled jobs (`schedule_*`); absent: the host registers no schedule tools. */
  schedules?: AgentScheduleHost
  /** The request `requestId` in any state, or undefined when nobody asked it. */
  approvalRequest?(requestId: string): ApprovalRequestInfo | undefined
  /**
   * Answers an approval of another thread as `actor` (`approval_respond`) through the one settlement the app,
   * the CLI and `answer_subagent` use: the rule `canAnswerApproval` decides, one answer wins and the loser learns
   * who did. `accessLevel` is the level the caller's credential was granted; the host narrows it by the profile's
   * setting and the thread's own cap as they are now and reads the profile's switch and project list there too.
   * The call is recorded as a receipt under `clientRequestId` before it answers, so a retry is told from another
   * caller's answer. A winning answer is shown in the target thread's transcript ("Approved by an agent in thread …").
   */
  answerApproval?(
    threadId: string,
    requestId: string,
    answers: UserQuestionAnswers,
    options: { clientRequestId: string; actor: AgentActor; accessLevel: AgentAccessLevel }
  ): AgentApprovalResult
}
