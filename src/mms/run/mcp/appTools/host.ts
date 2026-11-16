import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import type { AgentJobLimits } from '../../../../shared/agentJobLimits'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { ModelOverride } from '../../../../shared/providerInstances'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { RemoteComputerReach, RemoteListedThread, RemoteReach, RemoteSearchResult, RemoteTarget, RemoteUncertain, RemoteWaitResult } from '../../../orchestrator/RemoteLaunchedThreads'
import type { MessageRow } from './messageRows'
import type { ThreadEvent } from '../../types'
import type { ChatMessage, ThreadActivityState, CreateScheduledJobInput, PendingUserQuestions, QueuedMessage, ScheduledJob, Thread, UserQuestion, UserQuestionAnswers, UserQuestionAttachments } from '../../../../shared/types'
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
import type { AppearanceToolHost } from './appearance'
import type { DelegationToolsHost } from './delegation'
import type { LiveRunGate } from './registry'
import type { AppToolTurn, ToolLedger } from './types'
import type { SecretToolHost } from './secrets'

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
  /** The model's reasoning level; needs `model`. Absent: its default. */
  effort?: string
  firstMessage?: string
  /** Mode of the first message; defaults to agent. */
  mode?: 'agent' | 'plan'
  /** A personal bot's thread kept out of the owner's sidebar (`Thread.hidden`). */
  hidden?: boolean
}

/** `thread_create` with `computer`: a thread on another of the user's computers, in its copy of the caller's repository. */
export interface AgentRemoteThreadRequest {
  /** A computer's name or id from `list_computers`. */
  computer: string
  /** A project of that computer, to choose among several checkouts of the repository there. */
  projectId?: string
  title?: string
  workspace: 'project' | 'new_worktree'
  /** Both or neither: a model that computer offers, else its default. */
  instanceId?: string
  model?: string
  effort?: string
  firstMessage?: string
  mode?: 'agent' | 'plan'
}

/** A project of another computer that may be the caller's repository, offered when the launch cannot choose one. */
export interface RemoteProjectCandidate {
  projectId: string
  name?: string
  /** Only the first commit matched: it may be a fork or a copy, not this repository. */
  weak?: boolean
}

/** What `thread_create` with `computer` did. */
export type AgentRemoteThreadResult =
  | {
      status: 'launched'
      /** The thread, qualified: `<node>:<id>`. */
      threadId: string
      computer: string
      title: string
      /** The mode it was set to there; null until that computer confirmed it. */
      permissionMode: PermissionMode | null
      model: { instanceId: string; model: string } | null
      /** The run the first message started there. */
      runId?: string
      /** What became of the first message; absent when none was asked for. */
      firstMessage?: 'sent' | 'failed' | 'uncertain'
      /** Why the first message failed, or is not confirmed. */
      firstMessageReason?: string
      /** The same `clientRequestId` launched this thread before; nothing new was made. */
      replayed: boolean
    }
  /** That computer did not confirm whether it made the thread; Mousse keeps trying under the same key. */
  | { status: 'uncertain'; computer: string; message: string }
  | { status: 'refused'; code: string; message: string; computer?: string; candidates?: RemoteProjectCandidate[]; computers?: Array<{ id: string; name: string }> }

/**
 * The thread tools on a thread this computer's agents launched on another computer (issue #1160), named by its qualified
 * id. `reach` decides which threads a caller may reach; every other call takes what it returned. Refusals are thrown with
 * their code (`RemoteThreadRefusal`); a write that computer did not confirm comes back `uncertain`.
 */
export interface RemoteThreadsHost {
  reach(callerThreadId: string, threadId: string): RemoteReach
  /** `thread_list` and `thread_search` with `computer`: the computer it names, as the caller may list it now, or why not. */
  computerFor(callerThreadId: string, computer: string): RemoteComputerReach
  /** The threads that computer shares with this one; a refusal is thrown with its code. */
  list(callerThreadId: string, target: { node: string; computer: string }, filter: { projectId?: string }): Promise<{ threads: RemoteListedThread[]; projects: Array<{ id: string; name: string }>; activity: Record<string, ThreadActivityState> }>
  /** That computer's search, or why it was not searched. */
  search(target: { node: string; computer: string; online: boolean }, query: string, limit: number): Promise<RemoteSearchResult>
  events(target: RemoteTarget, page: { afterSeq: number; limit: number }): Promise<{ events: ThreadEvent[]; maxSeq: number }>
  messages(target: RemoteTarget, page: { afterIndex: number; limit: number; textOffset: number; textMax: number }): Promise<{ messages: MessageRow[]; total: number }>
  wait(target: RemoteTarget, request: { runId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RemoteWaitResult>
  send(target: RemoteTarget, input: { content: string; mode: 'agent' | 'plan' }, options: { clientRequestId: string; actor: AgentActor }): Promise<{ status: 'sent'; runId?: string; queued: boolean; replayed: boolean; mode?: string } | RemoteUncertain>
  steer(target: RemoteTarget, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<{ status: 'accepted'; runId: string } | { status: 'ignored'; reason: string; runId?: string } | RemoteUncertain>
  interrupt(target: RemoteTarget, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<{ status: 'stopped' | 'left'; runId?: string; left?: string } | RemoteUncertain>
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
  model: { instanceId: string; model: string; effort?: string } | null
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

/**
 * What archiving or unarchiving a thread for a personal bot did (`thread_archive`): `changed` is false when the thread
 * already was so. Refused (`thread_running`) while the thread or a subagent below it has a run working or paused.
 */
export type AgentArchiveResult =
  | { status: 'accepted'; archived: boolean; changed: boolean }
  | { status: 'rejected'; reason: 'thread_running' }

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
  /**
   * Whether the person allowed this thread's agent to add automations: they answered Allow to its first ask. Read at
   * every call. A thread not allowed yet asks first (`askFirst`).
   */
  threadAllowed(threadId: string): boolean
  /**
   * Records the first-creation ask instead of making the automation: the person sees "<thread> wants to …" in Needs you
   * and answers Allow or Not now. A retried call (the same request key) returns the ask it already made.
   */
  askFirst(input: { threadId: string; requestKey: string; job: Omit<CreateScheduledJobInput, 'expiresAt'> }): { id: string }
  /**
   * The limits on jobs agents create as they are now (`scheduled.agentJobMaxActive`, `agentJobMinIntervalMinutes`,
   * `agentJobLifetimeDays`), read at every call. Read only: a person sets them on the Scheduled page, and no tool does.
   */
  jobLimits(): AgentJobLimits
  list(): ScheduledJob[]
  get(id: string): ScheduledJob | undefined
  /**
   * Checks the model, mode and workspace of the job as it would be after the change, as the protocol does. Throws a
   * message the agent can act on; returns the model as the profile stores it and the thread a worktree names.
   */
  validate(job: ScheduledJobOptionsInput): { selection?: ModelOverride; threadId?: string }
  /**
   * Whether a person started the caller's run (`startedByPerson`: an interactive turn from the app or the CLI). Fails
   * closed: a scheduled or webhook run, an agent's message, a subagent, a wake, a continuation, a bot, a remote send, a run with
   * no recorded binding or one that cannot be read is not a person's turn. Only a person's turn may create or start jobs.
   */
  startedByPerson(caller: { threadId: string; runId: string }): boolean
  /**
   * What a job created or changed by this caller may run in: the permission mode its run is bound to, the narrowest
   * when the run is not a person's turn, which the tools refuse before they ask.
   */
  limits(caller: { threadId: string; runId: string }): { permissionCeiling: PermissionMode }
  create(input: CreateScheduledJobInput): ScheduledJob
  update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null
  pause(id: string, reason?: string): ScheduledJob | null
  /** Makes the job due now, as Run now does; a job with a run in flight or waiting is returned as it is. */
  trigger(id: string): ScheduledJob | null
  /** The scheduler ticks now instead of at the next minute, so a job that was just made due starts within seconds. */
  wake(): void
}

/**
 * What the app tools need from their owner: the profile's thread owner (the orchestrator), which
 * serves the Mousse MCP server's registry.
 */
export interface AppToolHost extends DelegationToolsHost {
  askUser(
    threadId: string,
    questions: PendingUserQuestions['questions'],
    options: { signal?: AbortSignal; timeoutMs?: number; onAttachments?: (attachments: UserQuestionAttachments) => void }
  ): Promise<UserQuestionAnswers>
  /** Dismisses the thread's open questions (an in-process `ask_user` whose turn stopped). */
  dismissQuestions?(threadId: string): void
  /** Secret requests and commands that use them (`secret_request`, `secret_run`); absent: those tools refuse. */
  secrets?(): SecretToolHost | undefined
  /** The thread's task queue; null when the owner keeps none (no task tools). */
  tasks(threadId: string | undefined): TaskQueue | null
  /** The threads' goals (`/goal`): whether one is working, and the agent's `goal_status` report. Absent: no goal tool. */
  goals?: {
    working(threadId: string): boolean
    /** Records the report of the caller's run; returns what the agent is told. Throws on a report it refuses. */
    report(threadId: string, runId: string, status: unknown, reason: unknown): string
  }
  /** The run engine of the thread tools (`thread_read`, the queue, fork and merge-back); MCP only. */
  engine?: RunEngine
  browserRuntime?(): BrowserRuntimePort | undefined
  skills?(): SkillsRegistry | undefined
  quickActions?: QuickActionTools
  /** `running_list`: what runs now for the caller's folder (quick actions, background commands, servers), as text. */
  running?(turn: AppToolTurn): Promise<string>
  web?: WebTools
  devGui?: DevGuiTools
  /**
   * The host serves `git_status` and `git_diff` (they read through `git/scopedRead`); absent: no git
   * app tools (the pi loop runs its own copies, through the same scoped read).
   */
  projectGit?: true
  /** SPEC §12.6 tool ledger of the caller's run, for calls over MCP. */
  toolLedger?(runId: string): ToolLedger | undefined
  /** The thread is a read-only (`shared`) delegated child; it may call only `reads` and `readOnlySafe` tools. */
  readOnlyThread?(threadId: string): boolean
  /** The thread's project directory, which scopes the MCP relay's servers; absent: global servers only. */
  projectPathFor?(threadId: string): string | undefined
  /** The ceiling the thread's delegations gave it (the listing ignores the turn's mode). */
  threadCeiling?(threadId: string): ModeCeiling
  /** The thread's role when it is a personal bot's thread (PR 6 §5). */
  botRole?(threadId: string): 'activation' | 'context' | 'subagent' | undefined
  awaitLiveRun?(threadId: string): Promise<LiveRunGate | undefined> | undefined
  /** The permission mode the caller's run enforces, from its attempt's binding (never from the mode ceiling). */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
  // Other threads (SPEC §15.1). Optional like the methods above: a tool whose method is absent answers
  // "not available in this host".
  /** The thread's metadata, or undefined when it does not exist. */
  threadMeta?(threadId: string): Thread | undefined
  /** Every thread of the profile, subagents included, unfiltered. */
  listThreads?(): Thread[]
  /** The profile's projects. */
  listProjects?(): Array<{ id: string; name: string }>
  /**
   * The models a thread can run on now, by provider entry (what the composer's picker lists for this computer), for a
   * bot that starts a thread ("use your threads"): it names one with `instanceId` and `model`.
   */
  threadModels?(): Array<{ instanceId: string; entry: string; model: string; name: string }>
  /**
   * Matches over thread names, project names and messages; subagent threads are not searched. `allow`
   * (which threads the caller may see) and `titlesOnly` are applied before the limit and before any
   * transcript is read.
   */
  searchThreads?(query: string, limit: number, options?: Pick<ThreadSearchOptions, 'allow' | 'titlesOnly' | 'maxMessageThreads'>): ThreadSearchHit[] | Promise<ThreadSearchHit[]>
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
  showAgentAction?(target: { threadId: string }, actor: AgentActor, summary: string, options?: { notice?: boolean }): void
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
   * Watches the message `messageKey` sent to `targetThreadId` (`notify` on `thread_send` and `thread_create`): Mousse
   * tells the sending thread when the work it started waits on a person (once) and when it ends (SPEC §15.1). Once per
   * message: a retry keeps its watch. With `targetNode`, `targetThreadId` is a thread this caller launched on that
   * computer (its id there), followed there through routed reads.
   */
  watchSettle?(input: { messageKey: string; watcherThreadId: string; watcherRunId: string; targetThreadId: string; runId: string; targetNode?: string }): { watchId: string }
  /**
   * Creates a thread for `actor` (`thread_create`): in the project's folder or its own worktree, on the model
   * asked for or the caller's, with a permission mode no wider than the caller's, recorded as launched by the
   * caller's thread (never nested under it), and optionally with a first message sent as the caller's. The
   * creation is decided and recorded before anything exists, so a retry with the same `clientRequestId` finishes
   * or returns that one thread, whatever the caller's run or the settings look like by then.
   */
  createThread?(input: AgentThreadRequest, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentCreatedThread>
  /**
   * The key has a stored creation already: a retry finishes that one thread (or its first message) and does not use up a place
   * under the caller's cap on new threads.
   */
  creationStarted?(clientRequestId: string): boolean
  /**
   * `thread_create` with `computer` (issue #1160): a top-level thread on another of the user's computers, in its project
   * that is the caller's repository. The launch is recorded before any call (`remote_launches`), every call is marked as
   * the caller's, and a retry with the same `clientRequestId` continues that one launch. Refusals are returned, not thrown.
   */
  createRemoteThread?(input: AgentRemoteThreadRequest, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRemoteThreadResult>
  /** The thread tools on threads launched on other computers; absent without Bridge's run engine. */
  remoteThreads?: RemoteThreadsHost
  /**
   * Adds a note row to the thread's transcript (the creator's: what it launched, and on which model). `launched` names
   * the thread it started, which the transcript draws as a chip.
   */
  noteOnThread?(threadId: string, text: string, launched?: { threadId: string; summary?: string }): void
  /**
   * A thread's queue with its revision, read from disk after any unfinished agent command was finished. The
   * revision is what `queueCommand` must be given back.
   */
  queueSnapshot?(threadId: string): QueueSnapshot
  /**
   * One agent command on a thread's queue (`queue_enqueue`, `queue_edit`, `queue_remove`, `queue_reorder`,
   * `queue_promote_to_steer`). `options.clientRequestId` is the full request key: a retry returns the first
   * result. Throws a `QueueConflictError` when the queue is not as the caller expects.
   */
  queueCommand?(threadId: string, command: AgentQueueCommand, options: { clientRequestId: string; actor: AgentActor }): AgentQueueResult
  /** Stops run `runId` of another thread and what is below it, as `actor`'s Stop (`thread_interrupt`). */
  stopRun?(threadId: string, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /** Archives (`archived`) or unarchives another thread through the app's own Archive, as a personal bot's call (`thread_archive`). */
  setThreadArchived?(threadId: string, archived: boolean, options: { actor: AgentActor }): Promise<AgentArchiveResult>
  /**
   * Hides a thread the calling bot started from its owner's sidebar, or shows it there again (`thread_hide`). `changed`
   * is false when it already was so.
   */
  setThreadHidden?(threadId: string, hidden: boolean, options: { actor: AgentActor }): { hidden: boolean; changed: boolean }
  /** Steers run `runId` of another thread with `text` as `actor`'s message (`thread_steer`). */
  steerRun?(threadId: string, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /** The profile's scheduled jobs (`schedule_*`); absent: the host registers no schedule tools. */
  schedules?: AgentScheduleHost
  /** Automation drafts (`automation_*`), read at every call: the Automation manager's and granted bots' tools. */
  automations?(): import('./automations').AutomationToolHost | undefined
  /** The profiler's tools (Settings → Labs), read at every call; absent: they are never listed. */
  profiler?(): import('./profiler').ProfilerToolHost | undefined
  /** The profile's appearance settings (`theme_read`, `theme_set`), read at every call; absent: the tools say themes are unavailable. */
  appearance?(): AppearanceToolHost | undefined
  /** The request `requestId` in any state, or undefined when nobody asked it. */
  approvalRequest?(requestId: string): ApprovalRequestInfo | undefined
  /**
   * Answers an approval of another thread as `actor` (`approval_respond`) through the one settlement the app,
   * the CLI and `answer_subagent` use: the rule `canAnswerApproval` decides, one answer wins and the loser learns
   * who did. The host reads the profile's switch "Agents may answer approvals on other threads" as it is now.
   * The call is recorded as a receipt under `clientRequestId` before it answers, so a retry is told from another
   * caller's answer. A winning answer is shown in the target thread's transcript ("Approved by an agent in thread …").
   */
  answerApproval?(
    threadId: string,
    requestId: string,
    answers: UserQuestionAnswers,
    options: { clientRequestId: string; actor: AgentActor }
  ): AgentApprovalResult
}
