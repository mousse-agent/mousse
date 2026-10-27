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
  enqueue?(threadId: string, input: { content: string; mode: 'agent' | 'plan' }): unknown
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
}
