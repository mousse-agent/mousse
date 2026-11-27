import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import type { BugReportService } from '../../../bugReports/BugReportService'
import type { AgentJobLimits } from '../../../../shared/agentJobLimits'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { ModelOverride } from '../../../../shared/providerInstances'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { RemoteComputerReach, RemoteListedThread, RemoteReach, RemoteSearchResult, RemoteTarget, RemoteUncertain, RemoteWaitResult } from '../../../orchestrator/RemoteLaunchedThreads'
import type { MessageRow } from './messageRows'
import type { ThreadEvent } from '../../types'
import type { ChatMessage, ThreadActivityState, CreateScheduledJobInput, PendingUserQuestions, QueuedMessage, ScheduledJob, Thread, ThreadSetupFailure, UserQuestion, UserQuestionAnswers, UserQuestionAttachments } from '../../../../shared/types'
import type { ScheduledJobOptionsInput } from '../../../scheduled/validateJobOptions'
import type { DevGuiTools } from '../../../devgui/DevGuiTools'
import type { MousseIntegrationsSettings } from '../../../../shared/integrations'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import type { ThreadSearchOptions } from '../../../data/ThreadDataStore'
import type { QuickActionTools } from '../../../orchestrator/QuickActionTools'
import type { WebTools } from '../../../orchestrator/WebTools'
import type { TaskQueue } from '../../../tasks/TaskQueue'
import type { ApprovalRefusal } from '../../approvalRights'
import type { SteerStrategy } from '../../CommandPolicy'
import type { RunEngine } from '../../RunEngine'
import type { AnsweredBy } from '../../ThreadApprovals'
import type { AgentActor, AgentNotePayload, ModeCeiling } from '../../types'
import type { HeldMessage } from '../../AgentChains'
import type { AppearanceToolHost } from './appearance'
import type { DelegationToolsHost } from './delegation'
import type { LacksReport, LiveRunGate } from './registry'
import type { AppToolTurn, ToolLedger } from './types'
import type { SecretToolHost } from './secrets'
import type { ThreadMonitors } from '../../../monitors/ThreadMonitors'
import type { TerminalInfo } from '../../../terminals/PtyManager'

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
  /**
   * Keep the thread out of the person's sidebar (`Thread.hidden`): a bot's chat lists it, and the side panel of the
   * thread that launched it. Absent: hidden. false: an independent thread the person follows in the sidebar.
   */
  hidden?: boolean
}

/**
 * `thread_create` with `computer`: a thread on another of the user's computers, in the project of it the caller names,
 * or in its copy of the caller's repository.
 */
export interface AgentRemoteThreadRequest {
  /** A computer's name or id from `computer_list`. */
  computer: string
  /**
   * A project of that computer (plain, or qualified as `thread_list` with computer names it). Alone, the thread starts
   * in it with no Git match; with `fromProjectId` it chooses among that computer's checkouts of the repository.
   */
  projectId?: string
  /**
   * A project of this computer whose repository the thread starts in there (else the caller's own project's). A bot,
   * which has no project of its own, gives this or `projectId`.
   */
  fromProjectId?: string
  title?: string
  workspace: 'project' | 'new_worktree'
  /** Both or neither: a model that computer offers, else its default. */
  instanceId?: string
  model?: string
  effort?: string
  firstMessage?: string
  mode?: 'agent' | 'plan'
  /** As for a thread here: absent or true keeps it out of the sidebar of the computer that runs it; false shows it there. */
  hidden?: boolean
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
  /** `thread_read` view `summary`: the thread record there and its newest runs (newest first), as that computer answers them. */
  summary(target: RemoteTarget): Promise<{ thread: Record<string, unknown>; runs: Array<Record<string, unknown>> }>
  wait(target: RemoteTarget, request: { runId?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RemoteWaitResult>
  send(target: RemoteTarget, input: { content: string; mode: 'agent' | 'plan' }, options: { clientRequestId: string; actor: AgentActor }): Promise<{ status: 'sent'; runId?: string; queued: boolean; replayed: boolean; mode?: string } | RemoteUncertain>
  steer(target: RemoteTarget, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<{ status: 'accepted'; runId: string } | { status: 'ignored'; reason: string; runId?: string } | RemoteUncertain>
  interrupt(target: RemoteTarget, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<{ status: 'stopped' | 'left'; runId?: string; left?: string } | RemoteUncertain>
  /**
   * `thread_archive` of a thread there, under one key per request (`idem`). A refusal (still working, outside the reach,
   * too old, offline) is thrown with its code; an answer the link lost is `uncertain`.
   */
  archive(target: RemoteTarget, archived: boolean, options: { actor: AgentActor; idem: string }): Promise<{ status: 'done'; archived: boolean; changed: boolean } | RemoteUncertain>
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
  firstMessage?: ({ sent: true } & AgentSendResult) | { sent: false; reason: string; held?: HeldMessage }
  /** The same `clientRequestId` created this thread before; nothing new was made. */
  replayed: boolean
}

/** What a Stop or a steer an agent asked for did to the run it named. */
export type AgentRunCommandResult =
  /** `followUp`: a steer that came after the run's answer was complete runs as the thread's next turn instead. */
  | { status: 'accepted'; runId: string; sequence: number; replayed: boolean; followUp?: true }
  /** The run is not the thread's active run (it ended, or never ran): nothing was changed. `runStatus` is the named run's own status. */
  | { status: 'ignored'; reason: string; runId?: string; activeRunId: string | null; runStatus?: string }
  | { status: 'rejected'; reason: string }
  /** A steer joins a run that is already running under a looser permission mode than the caller's own. */
  | { status: 'ceiling_exceeded'; callerMode: PermissionMode; targetMode: PermissionMode }

/**
 * What archiving or unarchiving a thread for a personal bot did (`thread_archive`): `changed` is false when the thread
 * already was so. Refused (`thread_running`) while the thread or a subagent below it has a run working or paused.
 * A subagent that runs on another computer is archived or unarchived there first, and here only once that computer said
 * so: `there` names its thread there. That computer's refusal is thrown (`RemoteThreadRefusal`); an answer the link lost
 * is `uncertain`, with nothing changed here.
 */
export type AgentArchiveResult =
  | { status: 'accepted'; archived: boolean; changed: boolean; there?: { threadId: string; computer: string; changed: boolean; gone?: true } }
  | { status: 'rejected'; reason: 'thread_running' }
  | RemoteUncertain

/**
 * What asking to archive the caller's own thread did (`thread_archive` from a thread's agent): `scheduled` archives it
 * when the running turn ends well, `changed: false` when it already is archived. Refused for a subagent, a bot's thread,
 * a turn no person started, or a run that is not the thread's running turn.
 */
export type AgentArchiveOwnResult =
  | { status: 'scheduled' }
  | { status: 'accepted'; changed: false }
  | { status: 'rejected'; reason: 'subagent' | 'not_started_by_person' | 'not_running' }

/**
 * What `thread_update access` did (docs/plans/tool-api.md §2.4): the subagent's access now and its capability revision
 * (`ToolRegistry.capabilityRevision`); `stoppedRunId` is the running turn `apply: now` stopped. Refused for a thread that
 * is not the caller's own subagent, a revision the caller did not expect, and, for `apply: now`, a subagent that waits on
 * a person or has subagents of its own working (a Stop would end them).
 */
export type AgentAccessResult =
  | { status: 'accepted'; readOnly: boolean; changed: boolean; revision?: string; stoppedRunId?: string }
  | { status: 'rejected'; reason: 'not_parent' | 'revision_changed' | 'waiting_on_request' | 'subagents_working'; revision?: string }

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
  | { ok: true; decision: 'allow' | 'reject'; replayed: boolean; fenced?: true }
  /** A plain question, answered by the bot that started its thread (`supervisorOf`). */
  | { ok: true; answered: 'question'; replayed: boolean }
  /** A plain question that is the user's: the caller is not the bot that started the thread, or the thread's turn is not one it supervises. */
  | { ok: false; reason: 'question_for_user' }
  /** A plain question's answer named no question of the request: `questionIds` are its questions. */
  | { ok: false; reason: 'unknown_question'; questionIds: string[] }
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
   * What a job created or changed by this caller may run in: the permission mode its run is bound to, the narrowest
   * when the run is not a person's turn, which the tools refuse before they ask.
   */
  limits(caller: { threadId: string; runId: string }): { permissionCeiling: PermissionMode }
  create(input: CreateScheduledJobInput): ScheduledJob
  update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null
  pause(id: string, reason?: string): ScheduledJob | null
  /**
   * Deletes the job as Automations' Delete does (`MmsProfileServices.deleteScheduledJob`, the one deletion path): the job
   * and its run history go; a run already started or queued in its thread still runs there. False when it was gone.
   */
  remove(id: string): boolean
  /** Makes the job due now, as Run now does; a job with a run in flight or waiting is returned as it is. */
  trigger(id: string): ScheduledJob | null
  /** The scheduler ticks now instead of at the next minute, so a job that was just made due starts within seconds. */
  wake(): void
}

/** What `terminal_read` reads: a thread's terminals and their kept output, from memory. */
export interface TerminalReadHost {
  list(threadId: string): TerminalInfo[]
  /** `columns`: its width, where its long lines wrap. */
  output(ptyId: string): { scrollback: string; droppedLines: number; columns?: number } | undefined
  /** Masks every secret in the profile's store, and the values the thread had that were removed or changed while it ran. */
  mask(text: string, threadId: string): string
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
  /**
   * `ask_user` with `wait: false`: the question is saved and shown, and its id comes back at once. The answer reaches the
   * thread later, through its inbox. Absent: questions always wait.
   */
  askWithoutWaiting?(threadId: string, questions: PendingUserQuestions['questions'], runId: string | null): string
  /** `withdraw_question`: the thread's agent no longer needs its open question. False when it was not open there. */
  withdrawQuestion?(threadId: string, requestId: string): boolean
  /** Secret requests and commands that use them (`secret_request`, `secret_run`); absent: those tools refuse. */
  secrets?(): SecretToolHost | undefined
  /** Bug reports (`report_bug`); absent: the tool is not offered. */
  bugReports?(): BugReportService | undefined
  /** A thread's name, for the person to see who asked. */
  threadName?(threadId: string): string | undefined
  /** The threads' terminals as `terminal_read` reads them (never writes); absent: the tool is not listed. */
  terminals?(): TerminalReadHost | undefined
  /** The thread's task queue; null when the owner keeps none (no task tools). */
  tasks(threadId: string | undefined): TaskQueue | null
  /** The threads' goals (`/goal`): whether one is working, and the agent's `goal_update` report. Absent: no goal tool. */
  goals?: {
    working(threadId: string): boolean
    /** Records the report of the caller's run; returns what the agent is told. Throws on a report it refuses. */
    report(threadId: string, runId: string, status: unknown, reason: unknown): string
  }
  /** The run engine of the thread tools (`thread_read`, the queue, fork and merge-back); MCP only. */
  engine?: RunEngine
  browserRuntime?(): BrowserRuntimePort | undefined
  skills?(): SkillsRegistry | undefined
  /** The profile's Skills settings, read when a model asks for a skill. */
  skillSettings?(): MousseIntegrationsSettings['skills']
  quickActions?: QuickActionTools
  /** `running_list`: what runs now for the caller's folder (quick actions, background commands, servers), as text. */
  running?(turn: AppToolTurn): Promise<string>
  /**
   * The thread's monitors, background commands and `keep_working` holds (`monitor_start`, `background_run`,
   * `background_stop`, `keep_working`); read at call time.
   */
  monitors?(): ThreadMonitors | undefined
  /** The thread's own wake-ups (`wake`, `reminder_list`, `reminder_cancel`); read at call time. */
  threadWakes?(): import('../../../wakes/ThreadWakes').ThreadWakes | undefined
  web?: WebTools
  devGui?: DevGuiTools
  /**
   * The host serves `git_status` and `git_diff` (they read through `git/scopedRead`); absent: no git
   * app tools (the pi loop runs its own copies, through the same scoped read).
   */
  projectGit?: true
  /**
   * Where a personal bot's `git_status` and `git_diff` read: a thread's checkout (its worktree, else its project folder)
   * or a project's folder. Undefined when there is none.
   */
  gitFolderOf?(target: { threadId: string } | { projectId: string }): string | undefined
  /** SPEC §12.6 tool ledger of the caller's run, for calls over MCP. */
  toolLedger?(runId: string): ToolLedger | undefined
  /** The thread is a read-only (`shared`) delegated child; it may call only `reads` and `readOnlySafe` tools. */
  readOnlyThread?(threadId: string): boolean
  /** The thread's project directory, which scopes the MCP relay's servers; absent: global servers only. */
  projectPathFor?(threadId: string): string | undefined
  /** The ceiling the thread's delegations gave it (the listing ignores the turn's mode). */
  threadCeiling?(threadId: string): ModeCeiling
  /** `plan` while an ancestor of the thread runs a Plan turn: narrowing from above, read at every call. */
  liveCeiling?(threadId: string): ModeCeiling | undefined
  /** The thread is a Mousse subagent, from its lineage. */
  subagentThread?(threadId: string): boolean
  /** The run holds `person`: a person started it and its thread is not a subagent (§1.3 "Provenance"). */
  personHeld?(caller: { threadId: string; runId: string }): boolean
  /** The parent a subagent's lineage names; undefined for a thread that is not a subagent. */
  parentThread?(threadId: string): string | undefined
  /** Tells a subagent's parent, or the root of its tree, what the subagent was refused for lacking (§2.4). */
  reportLacks?(report: LacksReport): void
  /** The thread's role when it is a personal bot's thread (PR 6 §5). */
  botRole?(threadId: string): 'activation' | 'context' | 'subagent' | undefined
  /**
   * The chat thread of the personal bot `threadId` belongs to: what the bot owns as one bot, whichever of its turns made
   * it (its scheduled jobs, the secrets its owner gave it). Undefined for a thread that is no bot's.
   */
  botHomeOf?(threadId: string): string | undefined
  awaitLiveRun?(threadId: string): Promise<LiveRunGate | undefined> | undefined
  /** The permission mode the caller's run enforces, from its attempt's binding (never from the mode ceiling). */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
  // Other threads (SPEC §15.1). Optional like the methods above: a tool whose method is absent answers
  // "not available in this host".
  /** The thread's metadata, or undefined when it does not exist. */
  threadMeta?(threadId: string): Thread | undefined
  /**
   * Waits until the run got past setting up its thread's folder (`ready`), setting up its worktree failed (`failed`,
   * with why), or a short while passed (`pending`). Never waits for the model's reply.
   */
  waitForSetup?(threadId: string, runId: string): Promise<{ status: 'ready' | 'failed' | 'pending'; failure?: ThreadSetupFailure; error?: string }>
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
  searchThreads?(query: string, limit: number, options?: Pick<ThreadSearchOptions, 'allow' | 'titlesOnly' | 'maxMessageThreads' | 'hideSubagents'>): ThreadSearchHit[] | Promise<ThreadSearchHit[]>
  /** The thread's visible transcript. */
  threadMessages?(threadId: string): ChatMessage[]
  /** The questions and approvals the thread's run waits on now (not the open questions it asked without waiting). */
  pendingRequests?(threadId: string): PendingUserQuestions[]
  /** Calls `listener` with the thread each time a question or approval is asked; returns the function that stops it. */
  onRequestPending?(listener: (threadId: string) => void): () => void
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
  sendToThread?(threadId: string, input: { content: string; mode: 'agent' | 'plan' }, options: { clientRequestId: string; actor: AgentActor; notify?: { messageKey: string } }): Promise<AgentSendResult>
  /**
   * Counts a note that asks for attention as one message of `actor`'s chain (issue #1442). Past the chain's budget the
   * note is kept for the person's Continue or Stop and `AgentMessageHeld` is thrown.
   */
  admitAgentNote?(threadId: string, requestKey: string, payload: AgentNotePayload, actor: AgentActor): void
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
  createThread?(input: AgentThreadRequest, options: { clientRequestId: string; actor: AgentActor; notify?: { messageKey: string } }): Promise<AgentCreatedThread>
  /**
   * `thread_create` with `computer` (issue #1160): a top-level thread on another of the user's computers, in its project
   * that is the caller's repository. The launch is recorded before any call (`remote_launches`), every call is marked as
   * the caller's, and a retry with the same `clientRequestId` continues that one launch. Refusals are returned, not thrown.
   */
  createRemoteThread?(input: AgentRemoteThreadRequest, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRemoteThreadResult>
  /** The thread tools on threads launched on other computers; absent without Bridge's run engine. */
  remoteThreads?: RemoteThreadsHost
  /**
   * Adds a note row to the thread's record (the creator's: what it launched, and on which model). `launched` names
   * the thread it started. The chat does not show the note.
   */
  noteOnThread?(threadId: string, text: string, launched?: { threadId: string; summary?: string }): void
  /**
   * A thread's queue with its revision, read from disk after any unfinished agent command was finished. The
   * revision is what `queueCommand` must be given back.
   */
  queueSnapshot?(threadId: string): QueueSnapshot
  /**
   * One agent command on a thread's queue (`queue_enqueue`, or `queue_update` with op edit, remove, move or
   * send_now). `options.clientRequestId` is the full request key: a retry returns the first
   * result. Throws a `QueueConflictError` when the queue is not as the caller expects.
   */
  queueCommand?(threadId: string, command: AgentQueueCommand, options: { clientRequestId: string; actor: AgentActor }): AgentQueueResult
  /** Stops run `runId` of another thread and what is below it, as `actor`'s Stop (`thread_stop`). */
  stopRun?(threadId: string, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /** Archives (`archived`) or unarchives another thread through the app's own Archive, as a personal bot's call (`thread_archive`). */
  setThreadArchived?(threadId: string, archived: boolean, options: { actor: AgentActor; clientRequestId: string }): Promise<AgentArchiveResult>
  /** Archives the caller's own thread once its running turn ends well (`thread_archive` from a thread's agent). */
  archiveOwnThreadAfterTurn?(options: { actor: AgentActor }): AgentArchiveOwnResult
  /**
   * Hides a thread the calling bot started from its owner's sidebar, or shows it there again (`thread_update hidden`).
   * `changed` is false when it already was so.
   */
  setThreadHidden?(threadId: string, hidden: boolean, options: { actor: AgentActor }): { hidden: boolean; changed: boolean }
  /**
   * Lifts the read-only narrowing of the caller's own subagent (`thread_update access {readOnly: false}`). With `apply:
   * now` its running turn is stopped once the change is made, and the result names that run; the caller then continues
   * the subagent on the same thread.
   */
  updateSubagentAccess?(threadId: string, access: { readOnly: false }, options: { actor: AgentActor; apply: 'next_turn' | 'now'; expectedRevision?: string; clientRequestId: string }): Promise<AgentAccessResult>
  /**
   * How text reaches the thread's active run now (`steerStrategy`): `native` steer, `interrupt_restart` (a note waits
   * for the run's next Mousse tool call), or neither; null when the thread's runtime is not known.
   */
  steerStrategyOf?(threadId: string): SteerStrategy | null
  /**
   * Steers run `runId` of another thread with `text` as `actor`'s message: a note that joins it (`thread_send` intent
   * note, once `thread_steer`), and a personal bot's `thread_send` to a working thread.
   */
  steerRun?(threadId: string, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /**
   * A personal bot's note to a thread it started: throws unless its turn may message threads and the thread runs no wider
   * than the device the owner wrote from may run (`device_limit`).
   */
  assertBotMayDirect?(threadId: string, actor: AgentActor): void
  /** The profile's scheduled jobs (`schedule_*`); absent: the host registers no schedule tools. */
  schedules?: AgentScheduleHost
  /** Automation drafts (`automation_*`), read at every call: the Automation manager's and granted bots' tools. */
  automations?(): import('./automations').AutomationToolHost | undefined
  /** Computer use (Settings → Computer use), read at every listing and call; absent: its tools are never listed. */
  computerUse?(): import('./computer').ComputerUseToolHost | undefined
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
