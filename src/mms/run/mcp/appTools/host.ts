import type { BrowserRuntimePort } from '../../../../shared/browser/runtime'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { DocumentOpenPayload, PendingUserQuestions, UserQuestionAnswers } from '../../../../shared/types'
import type { DevGuiTools } from '../../../devgui/DevGuiTools'
import type { SkillsRegistry } from '../../../integrations/skills/SkillsRegistry'
import type { QuickActionTools } from '../../../orchestrator/QuickActionTools'
import type { WebTools } from '../../../orchestrator/WebTools'
import type { TaskQueue } from '../../../tasks/TaskQueue'
import type { RunEngine } from '../../RunEngine'
import type { ModeCeiling } from '../../types'
import type { DelegationToolsHost } from './delegation'
import type { LiveRunGate } from './registry'
import type { ToolLedger } from './types'

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
  awaitLiveRun?(threadId: string): Promise<LiveRunGate | undefined> | undefined
  /** The permission mode the caller's run enforces, from its attempt's binding (never from the mode ceiling). */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
}
