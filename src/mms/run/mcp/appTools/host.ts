import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { AgentAccessSettings } from '../../../../shared/settings'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { ChatMessage, DocumentOpenPayload, PendingUserQuestions, Thread, UserQuestionAnswers } from '../../../../shared/types'
import type { DevGuiTools } from '../../../devgui/DevGuiTools'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import type { ThreadSearchOptions } from '../../../data/ThreadDataStore'
import type { QuickActionTools } from '../../../orchestrator/QuickActionTools'
import type { WebTools } from '../../../orchestrator/WebTools'
import type { TaskQueue } from '../../../tasks/TaskQueue'
import type { RunEngine } from '../../RunEngine'
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

/** What a Stop or a steer an agent asked for did to the run it named. */
export type AgentRunCommandResult =
  | { status: 'accepted'; runId: string; sequence: number; replayed: boolean }
  /** The run is not the thread's active run (it ended, or never ran): nothing was changed. `runStatus` is the named run's own status. */
  | { status: 'ignored'; reason: string; runId?: string; activeRunId: string | null; runStatus?: string }
  | { status: 'rejected'; reason: string }
  /** A steer joins a run that is already running under a looser permission mode than the caller's own. */
  | { status: 'ceiling_exceeded'; callerMode: PermissionMode; targetMode: PermissionMode }

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
  listQueue?(threadId: string): unknown[]
  /** `permissionMode`: the mode the caller's run is bound to; the queued turn never runs looser than it (nor than the thread's own). */
  enqueue?(threadId: string, input: { content: string; mode: 'agent' | 'plan' }, options?: { permissionMode?: PermissionMode }): unknown
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
  /** Stops run `runId` of another thread and what is below it, as `actor`'s Stop (`thread_interrupt`). */
  stopRun?(threadId: string, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
  /** Steers run `runId` of another thread with `text` as `actor`'s message (`thread_steer`). */
  steerRun?(threadId: string, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult>
}
