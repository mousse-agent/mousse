import { contextHandoff, previousTurnModel } from './contextHandoff'
import { AppletStore } from '../applets/AppletStore'
import { publishAppletPresentation, recoverAppletPresentation } from '../applets/publishPresentation'
import { validateAppletSubmission, type AppletSubmission } from '../../shared/applets'
import { logDebug } from '../log/diag'
import { ConversationActionService, assertConversationBoundary } from '../actions/ConversationActionService'
import { existsSync } from 'node:fs'
import { sha256Hex } from '../../shared/agents/hashes'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { TaskWriterAuthority } from '../agents/TaskWriterAuthority'
import { createAgentToolAccess } from '../agents/WorkspaceAccessPolicy'
import type { AgentWorkspacePolicy } from '../../shared/agentEpisodes'
import { AsyncLocalStorage } from 'async_hooks'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { normalizeContextSettings, resolveContextCompactionTokens, resolveModelForMode } from '../../shared/settings'
import type { ModelOverride } from '../../shared/providerInstances'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import type { WorkflowChatExecutor } from '../platform/MmsWorkflowChatBridge'
import type { WorkflowChatRun } from '../../shared/workflowChat'
import {
  channelWorkflowInvocationId,
  formatBackgroundWorkflowDelivery,
  isBackgroundWorkflowWaiting,
  scheduleWorkflowInvocationId,
  type BackgroundWorkflowTurnResult,
  type ChannelWorkflowHostIngress,
  type ScheduledJobIngress
} from '../platform/MmsWorkflowChat'
import { DomainRpcError } from '../protocol/domainRegistry'
import { AgentExecutionService } from '../agentDefinitions/AgentExecutionService'
import { createNativeAgentRuntime } from '../agentDefinitions/nativeRuntime'
import type { AgentExecutionRequest, AgentExecutionResult } from '../../shared/agents/execution'
import { EventEmitter } from 'events'
import { nativeAgentAssistantMessage, nativeAgentHistory } from '../providers/nativeAgentHistory'
import type { ClaudeSubscriptionProviderService } from '../providers/claudeSubscription/ClaudeSubscriptionProviderService'
import type { ClaudeIntegrationSource } from '../providers/claudeSubscription/integrations'
import type { AntigravityProviderService } from '../providers/antigravity/AntigravityProviderService'
import { v4 as uuidv4 } from 'uuid'
import { TitleTakenRejection, type CommandResult, type RunEngine, type SendDelegation, type StopResult } from '../run/RunEngine'
import { isFencedSource } from '../run/delegation/sources'
import { currentStopGeneration, runStopGeneration } from '../run/stopGeneration'
import { buildSubagentView } from '../run/delegation/subagentView'
import { resolveSubagent, subagentsTitled, type SubagentAddressSources } from '../run/delegation/subagentAddress'
import { delegationRequestKey, followUpRequestKey, narrowCeiling } from '../run/delegation/policy'
import { CommandRejection, RunStoreError } from '../run/db/RunStoreError'
import { EffectDeferredError, WorkerStoppedError, type EffectExecutor, type EffectWorker } from '../run/EffectWorker'
import { stopStrategy } from '../run/CommandPolicy'
import { McpToolError } from '../run/mcp/toolRegistry'
import { stableStringify } from '../run/json'
import { formatRestartNote } from '../run/restartNote'
import { AdapterRegistry } from '../run/adapters/AdapterRegistry'
import { PiLoopAdapter } from '../run/adapters/pi/PiLoopAdapter'
import { ClaudeSubscriptionAdapter } from '../run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import { AntigravityAdapter } from '../run/adapters/antigravity/AntigravityAdapter'
import { CodexAdapter, type CodexClient } from '../run/adapters/codex'
import type { AdapterHost, ChildTurnPolicy, ProviderAdapter, ProviderCapabilities, ProviderMetrics, RecoveredContext, TurnControl, TurnInput, TurnSink } from '../run/adapters/ProviderAdapter'
import type { McpAttachmentProvider } from '../run/mcp/MousseMcpServer'
import type { McpCaller, MousseToolHost } from '../run/mcp/toolRegistry'
import { planWakeNotice, type NoticeContext } from '../run/delegation/notice'
import { acknowledgeRows } from '../run/terminal'
import { taskCheckpoint } from '../run/delegation/checkpoint'
import { subagentPreamble } from '../run/delegation/guidance'
import { isRunningSubagent, type SubagentNoticeItem } from '../../shared/subagents'
import type { DelegationRequest, ForkPointSeed, ThreadCreation } from '../run/RunEngine'
import type { HandoffItem } from '../run/handoff/budget'
import { committedTransfers, TurnHandoffs, type PlannedHandoff } from './turnHandoffs'
import { TranscriptAssembler } from '../run/adapters/shared/TranscriptAssembler'
import { forkStrategy, handoffDelivery, mcpAttachable, subagentTargetRefusal, type SubagentRefusal } from '../run/policy/featureGates'
import { isContextOverflowError, retryContextOverflowOnce } from '../run/adapters/shared/retryContextOverflow'
import {
  TERMINAL_RUN_STATUSES,
  isChildQuestionRow,
  isWakeTurnPayload,
  type ChildQuestionPayload,
  type DelegationRecord,
  type EffectKind,
  type InboxRecord,
  type EffectRecord,
  type ModeCeiling,
  type ProviderRef,
  type RunRecord,
  type ThreadEvent,
  type TransferRecord,
  type WakeTurnPayload
} from '../run/types'
import {
  isTerminalAgentStatus,
  turnPhaseActivity,
  type Agent,
  type AgentStatus,
  type ChatImageAttachment,
  type ChatMode,
  type ChatMessage,
  type CliType,
  type ContextUsageSnapshot,
  type NativeLlmContext,
  type OrchestratorAction,
  type OrchestratorContextUsageInput,
  type OrchestratorResponse,
  type OrchestratorSendInput,
  type QueuedMessage,
  type TurnPhase,
  type TurnState,
  type TurnStateSnapshot,
  type UserQuestion,
  type UserQuestionAnswers
} from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { allowsOrchestrationActions, buildModeChangeNotice, chatModeEquals, getChatModeLabel, getLastUserChatMode, normalizeChatMode } from '../../shared/chatMode'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import { WorktreeManager } from '../worktree/WorktreeManager'
import { PtyManager } from '../terminals/PtyManager'
import { HeadlessAgentRunner } from '../terminals/HeadlessAgentRunner'
import { MacroEngine } from '../macros/MacroEngine'
import { LlmClient, parseActions, stripActionBlocks, type StreamingLlmThinkingEvent, type StreamingLlmToolEvent, type LlmChatOptions, filterActionsForChatMode, rejectOrchestrationAction, type DelegateTaskInput, type DelegationToolCall, type DelegationToolHost, type NamedAgentToolRequest, type SubagentRef } from './LlmClient'
import type { BrowserRuntimePort } from '../../shared/browser/runtime'
import {
  type BrowserExecutionBinding,
  createDefinitionBrowserBinding,
  readHostBrowserRuntime
} from './browser'
import { computeContextUsage } from './contextUsage'
import { getToolCallDisplay } from '../../shared/toolCallDisplay'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProviderAuthService } from '../providers/ProviderAuthService'
import { ProviderInstanceService } from '../providers/ProviderInstanceService'
import type { McpManager } from '../integrations/mcp/McpManager'
import type { SkillsRegistry } from '../integrations/skills/SkillsRegistry'
import type { AgentConfigManager } from '../integrations/agents/AgentConfigManager'
import type { FileService } from '../files/FileService'
import type { GitService } from '../git/GitService'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { resolveProjectWorkingDirectory } from '../data/projectWorkingDirectory'
import { lineageForChild } from '../data/subagentLineage'
import { WorkspaceResolver } from '../workspace/WorkspaceResolver'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { UndoService } from '../actions/UndoService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { PublishService } from '../actions/PublishService'
import { ConversationBranchService } from '../actions/ConversationBranchService'
import type { MousseFeatureFlags } from '../../shared/featureFlags'
import { DEFAULT_FEATURE_FLAGS } from '../../shared/featureFlags'
import { ThreadActionService } from '../actions/ThreadActionService'
import { ChildAgentIntegrationService } from '../agents/ChildAgentIntegrationService'
import type { NativeContextBoundary } from '../../shared/threadActions'
import { git as actionGit, requireClean as requireCleanWorkspace } from '../actions/git'
import {
  claimNextNormal,
  clearPendingQueue,
  completeClaim,
  demoteSteerItems,
  dropSteerItems,
  enqueueMessage,
  listPendingQueue,
  promoteQueuedMessageToSteer,
  QueueValidationError,
  reclaimAbandonedClaims,
  releaseClaim,
  removeQueuedMessage,
  reorderQueuedMessages
} from '../queue/ThreadMessageQueue'
import {
  createLeaseToken,
  heartbeatExecutionLease,
  isLeaseHeldByLivePeer,
  releaseExecutionLeaseHandle,
  tryAcquireExecutionLease,
  tryReclaimStaleLease,
  waitAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../queue/ThreadExecutionLease'
import { isProcessAlive } from '../queue/processLiveness'
import {
  completeClaimDurable,
  mutateDurableQueue,
  readDurableQueue,
  reclaimAbandonedClaimsDurable,
  releaseClaimDurable
} from '../queue/durableQueue'
import { ThreadSession, type ActiveTurnControl } from './ThreadSession'
import { userQuestionService as defaultUserQuestionService, UserQuestionService } from './UserQuestionService'
import { modeRegistry as defaultModeRegistry, type ModeRegistry } from '../modes/ModeRegistry'
import { ConnectionRetriesExhaustedError } from './connectionRetry'
import { AppError, errorDiagnostic, normalizeAppError, serializeAppError, type AppErrorShape } from '../../shared/errors'
import {
  compactMessagesAtSafeBoundary,
  commitNativeMessages,
  compactNativeContext,
  createNativeContext,
  appendNativeMessage,
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  estimateActiveContextTokens,
  getActiveMessages,
  getCompactionSummary,
  migrateLegacyContext,
  normalizeNativeContext,
  shouldCompactNativeContext,
  userMessage,
  type NativeMessageCheckpoint
} from './nativeContext'

interface NormalizedOrchestratorSendRequest {
  content: string
  mode: ChatMode
  images?: ChatImageAttachment[]
  workflowInvocationId?: string
}

interface NormalizedContextUsageRequest {
  draftInput: string
  mode: ChatMode
}

function normalizeSendRequest(request: OrchestratorSendInput): NormalizedOrchestratorSendRequest {
  if (typeof request === 'string') {
    return { content: request, mode: normalizeChatMode(), images: undefined }
  }

  return {
    content: request.content,
    workflowInvocationId: request.workflowInvocationId,
    mode: normalizeChatMode(request.mode),
    images: request.images?.filter((img) => img.data && img.mimeType)
  }
}

/** Render one answered value with option labels where they resolve, raw text otherwise. */
function formatQuestionAnswerValue(question: UserQuestion, value: string | string[]): string {
  const values = (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim())
  const labels = values
    .map((entry) => question.options.find((option) => option.id === entry)?.label ?? entry)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return labels.join(', ') || '(no answer)'
}

/**
 * Render submitted question answers as transcript text (`Q:`/`A:` per question).
 * Option ids resolve to their labels; custom-typed answers pass through verbatim.
 */
export function formatQuestionAnswersMessage(
  questions: UserQuestion[],
  answers: UserQuestionAnswers
): string {
  return questions
    .map((question) => {
      const value = answers[question.id]
      const rendered =
        value === undefined ? '(no answer)' : formatQuestionAnswerValue(question, value)
      return `Q: ${question.prompt}\nA: ${rendered}`
    })
    .join('\n\n')
}

/** Render an explicit dismissal as transcript text. */
export function formatQuestionDismissMessage(questions: UserQuestion[]): string {
  const first = questions[0]
  return first ? `Dismissed question: ${first.prompt}` : 'Dismissed the question.'
}

/**
 * Whether complete_task / stopAgent should attempt to finalize this agent.
 * failed is never auto-finalized. completed/cancelled/interrupted only when a
 * mergeable branch still exists (recoverable work).
 */
export function isActionFailureLog(line: string): boolean {
  return /\b(?:failed|skipped|error|conflict|refused|not found|not eligible)\b/i.test(line)
}

export function buildCompleteTaskFailureWake(agentIds: string[], logs: string[]): string | undefined {
  const failures = logs.filter(isActionFailureLog)
  if (failures.length === 0) return undefined

  const conflict = failures.some((line) => /\bconflict\b/i.test(line))
  const finalizeInstruction =
    'Rerunning complete_task after resolution is required to mark the task done, clean up its preserved worktree/branch, and close the agent GUI subtab.'
  const instruction = conflict
    ? `Inspect and resolve the listed conflicts in the main working tree, git add the resolutions, then retry complete_task with merge true. Do not abort the merge or delete the preserved agent worktree. ${finalizeInstruction}`
    : `Inspect the failure in the main working tree, preserve existing local changes, correct the blocker, then retry complete_task with merge true for the ready agent branch. ${finalizeInstruction}`

  return [
    '[Automatic complete_task update] The requested agent work was not merged.',
    `Target agents: ${agentIds.join(', ')}`,
    ...failures,
    instruction
  ].join('\n')
}

/**
 * After successful merges the parent turn ends. Wake it so multi-wave plans
 * (verification/integration agents, final reports) can continue without a manual nudge.
 */
export function buildCompleteTaskSuccessWake(agentIds: string[], logs: string[]): string | undefined {
  if (logs.some(isActionFailureLog)) return undefined
  const merged = logs.filter((line) => /\[merge\]\s+Merged\b/i.test(line))
  if (merged.length === 0) return undefined

  return [
    '[Automatic complete_task update] Integration finished.',
    `Target agents: ${agentIds.join(', ')}`,
    ...merged,
    'Continue the user plan now: spawn any remaining follow-up agents (for example a verification/integration wave), emit further complete_task actions as needed, or write a final status report if the requested work is fully done.'
  ].join('\n')
}

export function shouldFinalizeAgent(status: Agent['status'], hasMergeCandidate = false): boolean {
  if (status === 'failed') return false
  if (status === 'completed' || status === 'cancelled' || status === 'interrupted') {
    // Surviving branch means recoverable work must not be silently skipped.
    return hasMergeCandidate
  }
  return true
}

/** Statuses that only finalize when a merge candidate branch still exists. */
export function requiresMergeCandidateToFinalize(status: AgentStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'interrupted'
}

function normalizeContextUsageRequest(
  request: OrchestratorContextUsageInput
): NormalizedContextUsageRequest {
  if (typeof request === 'string') {
    return { draftInput: request, mode: normalizeChatMode() }
  }

  return {
    draftInput: request.draftInput ?? '',
    mode: normalizeChatMode(request.mode)
  }
}

// Owned by the provider adapters (SPEC §13.4); re-exported for existing callers.
export { isContextOverflowError, retryContextOverflowOnce }

export interface OrchestratorSendOptions {
  threadId?: string
  source?: string
  forceQueue?: boolean
  clientRequestId?: string
  /**
   * `turn` (default) resolves with the turn's result; `ack` resolves once the send is committed
   * and its `turn.start` effect recorded (SPEC §12.7). Only the engine path honours `ack`.
   */
  awaitMode?: 'turn' | 'ack'
  /** SPEC §16.4: the interrupted run this send continues (the restart note's "Continue"). */
  continuationOfRunId?: string
  /** Required when `continuationOfRunId` names an `uncertain` run. */
  acknowledgeUncertain?: boolean
  /** A follow-up on a subagent (`continue_subagent`): the run and its delegation row are written together. */
  delegation?: SendDelegation
}

/** What `OrchestratorService.stopThread` did: `ok` is true when anything was running or waiting. */
export interface StopThreadOutcome extends Partial<StopResult> {
  ok: boolean
  status: StopResult['status']
  replayed: boolean
  threadId: string
  threads: string[]
  activeRuns: StopResult['activeRuns']
  cancelledRuns: StopResult['cancelledRuns']
  delegations: string[]
}

/**
 * How long a wake waits when its thread is busy with a turn the engine does not schedule (a
 * workflow or legacy turn) before it looks again (C4: the wake stays queued instead of looping).
 */
export const WAKE_BUSY_DEFER_MS = 5_000

/** Send refusals reported with their reason as the error code (SPEC §16.4). */
const CONTINUATION_REFUSALS: ReadonlySet<string> = new Set([
  'continuation_not_found',
  'continuation_source_active',
  'uncertain_not_acknowledged'
])

/** A turn handed to `startTurn`; `runId` is absent when the engine could not record a run. */
interface TurnStartRequest {
  runId?: string
  threadId: string
  input: OrchestratorSendInput
  reuseLastUser: boolean
  displayUserMessage: boolean
  source?: string
  queueItemId?: string
  claimOwnerToken?: string
  suppressAutoQueueDrain?: boolean
  /** The caller already set `session.turnAdmitted`; the turn inherits it. */
  admissionHeld?: boolean
  /** A delegated `shared` child runs in its parent's workspace (SPEC §14.2). */
  sharedWorkspace?: ThreadSession['sharedWorkspace']
  /** Inbox rows whose notice this turn delivers (a queued steer); they follow this run's outcome. */
  inboxIds?: string[]
  /** The subagent results the turn's message delivers. */
  subagentNotice?: SubagentNoticeItem[]
}

/** Payload of a `turn.start` effect (SPEC §12.2). */
export interface TurnStartPayload extends TurnStartRequest {
  runId: string
}

/** `turn.start` payload of an `integration` run (SPEC §14.4): merges one delegated result. */
interface IntegrationTurnPayload {
  kind: 'integration'
  threadId: string
  runId: string
  delegationId: string
}

function isIntegrationTurnPayload(payload: unknown): payload is IntegrationTurnPayload {
  return Boolean(payload) && typeof payload === 'object' && (payload as { kind?: unknown }).kind === 'integration'
}

/** Who delivers inbox rows while a queue item carries them (no effect: the reconciler leaves them alone). */
const queueOwner = (itemId: string): string => `queue:${itemId}`

/** A queue item's rows that could not be given back when it was removed: tries and the wait between them. */
const QUEUED_ROW_RELEASE_ATTEMPTS = 4
const QUEUED_ROW_RELEASE_RETRY_MS = 2_000

/** Tool access of a delegated child in its parent's workspace: read-only roles only. */
const SHARED_READER_POLICY: AgentWorkspacePolicy = { version: 1, workspace: 'shared', access: 'read-only' }
/** Roles allowed `workspace: 'shared'` (SPEC §14.2: read-only roles). */
const SHARED_WORKSPACE_ROLES: ReadonlySet<string> = new Set(['research', 'review'])
/** Most named assignments one `create_subagents` call may start. */
const NAMED_BATCH_LIMIT = 8

/** In-process result of a `turn.start` effect, settled by its executor. */
interface TurnResult {
  promise: Promise<OrchestratorResponse>
  resolve: (response: OrchestratorResponse) => void
  reject: (error: unknown) => void
  /** Full payload, including image data the durable payload omits. */
  payload: TurnStartPayload
  effectId: string | null
  /** The executor picked the effect up; shutdown no longer abandons it. */
  started: boolean
  abandoned: boolean
}

/** Phases of a live turn that refresh its run heartbeat. */
const HEARTBEAT_TURN_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  'queued', 'thinking', 'streaming', 'tool_running', 'awaiting_input', 'finalizing'
])
const RUN_HEARTBEAT_THROTTLE_MS = 5_000

/**
 * The durable copy of a send input. Image data stays in memory: `turn.start` is process-bound,
 * so the executor always has the in-memory input, and every `effect.status` event repeats the
 * payload.
 */
function durableSendInput(input: OrchestratorSendInput): OrchestratorSendInput {
  if (typeof input === 'string' || !input.images?.length) return input
  const { images, ...rest } = input
  return { ...rest, images: images.map((image) => ({ ...image, data: '' })) }
}

/** Ledger digest of tool arguments: sha256 of their stable JSON. */
function toolArgsDigest(args: unknown): string {
  return sha256Hex(stableStringify(args ?? {}))
}

export class OrchestratorService extends EventEmitter {
  private appletStore?: AppletStore
  setAppletStore(store: AppletStore): void { this.appletStore = store }
  private claudeSubscription?: ClaudeSubscriptionProviderService
  private claudeIntegrations?: ClaudeIntegrationSource
  setClaudeSubscriptionProvider(provider: ClaudeSubscriptionProviderService, integrations?: ClaudeIntegrationSource): void {
    this.claudeSubscription = provider
    this.claudeIntegrations = integrations
  }
  private codex?: CodexClient
  /** The profile's Codex service (`codex` driver); read by the Codex adapter on every turn. */
  setCodexProvider(provider: CodexClient | null): void { this.codex = provider ?? undefined }
  private antigravity?: AntigravityProviderService
  setAntigravityProvider(provider: AntigravityProviderService): void { this.antigravity = provider }
  private readonly lifecycle = new OwnedWorkBarrier()

  getOwnedActivity(): Record<string, number> {
    return this.lifecycle.snapshot()
  }

  beginShutdown(): void {
    this.lifecycle.beginShutdown()
    for (const retry of this.releaseRetries) clearTimeout(retry)
    this.releaseRetries.clear()
    for (const [runId, entry] of [...this.turnResults]) {
      if (!entry.started) this.abandonTurnStart(runId, entry)
    }
    this.startupDrainPending = []
    this.startupDrainScheduled.clear()
    // The shutdown reason marks these turns as cut off by a restart, not stopped by a user.
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) session.activeTurn?.abort.abort(this.lifecycle.signal.reason)
    for (const turn of this.channelTurns.values()) turn.abort.abort()
    this.questions.shutdown()
  }

  /** A turn abort caused by the profile shutting down (worker stop or lifecycle), not by a user. */
  private isShutdownAbort(reason: unknown): boolean {
    return reason instanceof WorkerStoppedError || (this.lifecycle.stopping && reason === this.lifecycle.signal.reason)
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.beginShutdown()
    await this.lifecycle.waitForIdle(timeoutMs)
    for (const timer of this.persistTimers.values()) clearTimeout(timer)
    this.persistTimers.clear()
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) {
      if (session.threadId !== '__unbound__') this.persistFn?.(session.threadId)
    }
  }

  private workflowChat?: WorkflowChatExecutor

  setWorkflowChatExecutor(executor: WorkflowChatExecutor): void { this.workflowChat = executor }

  private browserRuntime?: BrowserRuntimePort
  private mainAgentBrowser?: BrowserExecutionBinding
  private mainBrowserFactory?: (turn: { threadId: string; turnId: string; source?: string; mode: ChatMode }) => BrowserExecutionBinding | undefined

  setMainAgentBrowserFactory(factory: (turn: { threadId: string; turnId: string; source?: string; mode: ChatMode }) => BrowserExecutionBinding | undefined): void {
    this.mainBrowserFactory = factory
  }

  /** Host-injected dispatcher. Root adapts platform.browser to BrowserRuntimePort. */
  setBrowserRuntime(port: BrowserRuntimePort | undefined): void {
    this.browserRuntime = port
    this.llm.setBrowserRuntime(port)
  }

  /**
   * Trusted GUI/main-agent browser context. Root supplies source/profile/thread/turn
   * and resolved grants; this runtime never infers a tab owner from model text.
   * Not applied to scheduled/channel turns.
   */
  setMainAgentBrowserExecution(binding: BrowserExecutionBinding | undefined): void {
    this.mainAgentBrowser = binding
  }

  /** Definition runs share the existing provider/tool loop and profile shutdown owner. */
  runAgentDefinition(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.lifecycle.run('definition-agent', () => {
      if (!this.threadStore?.getThread(request.threadId)) throw new Error('Agent execution thread is unavailable')
      const session = this.getOrCreateSession(request.threadId)
      if (session.deleted) throw new Error('Agent execution thread was deleted')
      return this.sessionAls.run(session, () => {
        // LlmClient binds TaskControlTools at construction. Definition runs use a
        // newly admitted thread, so reusing the GUI client's instance would let
        // the run observe or mutate the constructor's original task queue.
        const runId = request.runId ?? uuidv4()
        const browserRuntime = readHostBrowserRuntime(request.host) ?? this.browserRuntime
        const llm = new LlmClient(
          this.settingsStore,
          this.providerAuth,
          this.mcpManager,
          this.skillsRegistry,
          () => request.projectPath ?? session.projectCwd ?? this.worktrees.getRepoRoot(),
          this.fileService,
          this.gitService,
          this.lineEditStats,
          (payload) => this.emit('document-opened', payload),
          session.tasks,
          (action) => this.emit('quick-action-created', action),
          (payload, threadId) => this.presentPlanCard(payload, threadId),
          { questions: this.questions, modeRegistry: this.modeRegistry, browserRuntime }
        )
        const browser = createDefinitionBrowserBinding({
          request: { ...request, runId },
          runId,
          resolved: request.resolved
        })
        llm.bindBrowserExecution(browser)
        return new AgentExecutionService({ native: createNativeAgentRuntime(llm) }).run({
          ...request,
          runId,
          signal: request.signal ? AbortSignal.any([request.signal, this.lifecycle.signal]) : this.lifecycle.signal
        })
      })
    })
  }

  /** Called by the admitted definition-run owner, including during final shutdown persistence. */
  recordAgentDefinitionMessages(threadId: string, messages: ChatMessage[]): void {
    if (!this.threadStore?.getThread(threadId)) throw new Error('Agent execution thread is unavailable')
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) throw new Error('Agent execution thread was deleted')
    this.sessionAls.run(session, () => {
      for (const message of messages) {
        if (session.messages.some((entry) => entry.id === message.id)) continue
        session.messages.push(structuredClone(message))
        this.emitMessageAdded(message)
      }
      this.markThreadStartedAndNotify(threadId)
      this.persistFn?.(threadId)
    })
  }
  private llm: LlmClient
  /**
   * Provider adapters for `executeTurn` (SPEC §13), one per driver kind, resolved by provider
   * instance id (§13.8). The pi loop reads `this.llm` per turn. The constructor gives the registry
   * an in-memory instance map; the profile installs its stored one with `setProviderInstances`.
   */
  private adapters = new AdapterRegistry()
    .register(new PiLoopAdapter(() => this.llm))
    .register(new ClaudeSubscriptionAdapter(() => this.claudeSubscription ?? null, () => this.claudeIntegrations ?? null))
    .register(new AntigravityAdapter(() => this.antigravity ?? null))
    .register(new CodexAdapter(() => this.codex ?? null))
  /** Test seam: replaces the provider adapters (and with them the instance map they resolve against). */
  setAdapterRegistry(registry: AdapterRegistry): void { this.adapters = registry }
  /** The profile's provider instances (stored map, seeds, legacy mapping). */
  setProviderInstances(instances: ProviderInstanceService): void { this.adapters.setInstances(instances) }
  /**
   * Migrate-on-read for a stored model selection: adds the instance id an older `llmProvider`
   * maps to. Never throws; an unmappable selection fails when a turn resolves it.
   */
  migrateModelOverride<T extends ModelOverride>(override: T | undefined): T | undefined {
    return this.adapters.instances.migrate(override)
  }
  private readonly questions: UserQuestionService
  private readonly modeRegistry: ModeRegistry
  /** Bound GUI/CLI session (active thread). Concurrent turns use ALS-scoped sessions. */
  private boundSession = new ThreadSession('__unbound__')
  private sessions = new Map<string, ThreadSession>()
  private readonly transcripts = new WeakMap<ThreadSession, TranscriptAssembler>()
  private readonly sessionAls = new AsyncLocalStorage<ThreadSession>()
  private persistFn?: (threadId?: string | null) => void
  /** Per-thread delayed persist timers (concurrent turns must not suppress each other). */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** In-flight channel turns keyed by mousse thread id; `runId` once the turn is an engine run. */
  private channelTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: string[]; promotedSteerIds: string[]; runId?: string }
  >()
  /** Optional thread store for durable queue persistence. */
  private threadStore: ThreadDataStore | null = null
  /** Optional Run Engine (Phase 1 dual-write bridge). */
  private runEngine: RunEngine | null = null
  private runEngineUnsubscribe: (() => void) | null = null
  /** Runs whose bridge write hit a stale epoch; later marks for that turn are skipped. */
  private readonly staleRuns = new Set<string>()
  /** `WAKE_BUSY_DEFER_MS`; tests shorten it. */
  private readonly wakeBusyDeferMs = WAKE_BUSY_DEFER_MS
  /** Phase 2b: the worker that executes `turn.*` effects. Null keeps direct turn starts. */
  private effectWorker: EffectWorker | null = null
  /** Phase 5: mints a Mousse MCP credential per MCP-capable turn. Null attaches nothing. */
  private mcpAttachment: McpAttachmentProvider | null = null
  /** Pending results of `turn.start` effects, keyed by runId (SPEC §12.7). */
  private readonly turnResults = new Map<string, TurnResult>()
  /**
   * Threads whose provider reports background work that outlives their runs (input 4 of the hold
   * predicate). No adapter reports any yet: a Codex turn stays open while its helpers run, and the
   * Claude and Antigravity adapters report nothing, so this stays empty until one does.
   */
  private readonly providerBackground = new Set<string>()
  /** Removes the listeners that route a subagent's questions to its parent (`routeSubagentQuestions`). */
  private questionRouterOff: (() => void) | null = null
  /** Pending retries of a queue item's row release (`releaseQueuedRows`); a shutdown clears them. */
  private readonly releaseRetries = new Set<ReturnType<typeof setTimeout>>()
  /** Last run heartbeat (ms) per run; throttles `RunEngine.heartbeat` writes. */
  private readonly runHeartbeats = new Map<string, number>()
  /** Optional multi-tenant runtime manager (Phase 4). */
  private runtimeManager: import('../runtime/ThreadRuntimeManager').ThreadRuntimeManager | null =
    null
  /**
   * Max concurrent turns started by startup queue recovery.
   * Keeps recoverAndDrainPendingQueues bounded while still considering every eligible thread.
   */
  private static readonly STARTUP_QUEUE_DRAIN_CONCURRENCY = 2
  private startupDrainActive = 0
  private startupDrainPending: string[] = []
  private startupDrainScheduled = new Set<string>()
  private featureFlags: MousseFeatureFlags = { ...DEFAULT_FEATURE_FLAGS }
  private turnStates = new Map<string, TurnState>()

  /** `blockedOnWait`: every running tool call only waits, so the thread shows Waiting. */
  private setTurnPhase(threadId: string, phase: TurnPhase, patch?: Partial<Pick<TurnState, 'turnId' | 'activeMessageId' | 'error' | 'errorDescriptor'>> & { blockedOnWait?: boolean }): void {
    const now = new Date().toISOString()
    const existing = this.turnStates.get(threadId)
    const state: TurnState = {
      threadId,
      turnId: patch?.turnId !== undefined ? patch.turnId : (existing?.turnId ?? null),
      phase,
      updatedAt: now,
      ...(existing?.startedAt ? { startedAt: existing.startedAt } : phase !== 'idle' ? { startedAt: now } : {}),
      ...(patch?.activeMessageId !== undefined ? { activeMessageId: patch.activeMessageId } : existing?.activeMessageId ? { activeMessageId: existing.activeMessageId } : {}),
      ...(patch?.error ? { error: patch.error } : existing?.error && phase === 'failed' ? { error: existing.error } : {}),
    } as TurnState
    if (patch?.turnId !== undefined && patch.turnId !== existing?.turnId) (state as any).startedAt = now
    if (phase !== 'streaming' && phase !== 'tool_running') delete (state as any).activeMessageId
    if (phase === 'idle') { state.turnId = null; delete (state as any).startedAt }
    if (phase !== 'failed') { delete (state as any).error; delete state.errorDescriptor }
    if ((phase === 'queued' || phase === 'thinking') && !existing?.startedAt) (state as any).startedAt = now
    if (phase !== 'idle' && !(state as any).startedAt) (state as any).startedAt = existing?.startedAt ?? now
    this.turnStates.set(threadId, state)
    if (HEARTBEAT_TURN_PHASES.has(phase)) this.heartbeatRun(state.turnId)
    else if (existing?.turnId) this.runHeartbeats.delete(existing.turnId)
    this.emit('turn-state', state)
    this.runtimeManager?.setActivity(threadId, turnPhaseActivity(phase, patch?.blockedOnWait))
  }

  /** Liveness touch for an engine run (SPEC §12.4 rule 2), at most once per throttle window. */
  private heartbeatRun(runId: string | null | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId || !runId.startsWith('run:')) return
    const now = Date.now()
    const last = this.runHeartbeats.get(runId)
    if (last !== undefined && now - last < RUN_HEARTBEAT_THROTTLE_MS) return
    this.runHeartbeats.set(runId, now)
    try {
      engine.heartbeat(runId)
    } catch (error) {
      console.warn('run engine heartbeat failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  getTurnState(threadId: string): TurnState {
    return this.turnStates.get(threadId) ?? { threadId, turnId: null, phase: 'idle', updatedAt: new Date().toISOString() }
  }

  getTurnSnapshot(): TurnStateSnapshot {
    const out: TurnStateSnapshot = {}
    for (const [k, v] of this.turnStates) out[k] = v
    return out
  }

  setAwaitingInput(threadId: string): void {
    this.setTurnPhase(threadId, 'awaiting_input')
  }

  private get session(): ThreadSession {
    return this.sessionAls.getStore() ?? this.boundSession
  }

  private get messages(): ChatMessage[] {
    return this.session.messages
  }
  private set messages(value: ChatMessage[]) {
    this.session.messages = value
  }

  private get nativeContext(): NativeLlmContext {
    return this.session.nativeContext
  }
  private set nativeContext(value: NativeLlmContext) {
    this.session.nativeContext = value
  }

  private get activeTurn(): ThreadSession['activeTurn'] {
    return this.session.activeTurn
  }
  private set activeTurn(value: ThreadSession['activeTurn']) {
    this.session.activeTurn = value
  }

  private get activeAssistantMessageId(): string | null {
    return this.session.activeAssistantMessageId
  }
  private set activeAssistantMessageId(value: string | null) {
    this.session.activeAssistantMessageId = value
  }

  private get lastCompletedAssistantMessageId(): string | null {
    return this.session.lastCompletedAssistantMessageId
  }

  private get lastCompletedAssistantContent(): string {
    return this.session.lastCompletedAssistantContent
  }

  private get lastMeasuredInput(): number | null {
    return this.session.lastMeasuredInput
  }
  private set lastMeasuredInput(value: number | null) {
    this.session.lastMeasuredInput = value
  }

  private get lastMeasuredCacheRead(): number | null {
    return this.session.lastMeasuredCacheRead
  }
  private set lastMeasuredCacheRead(value: number | null) {
    this.session.lastMeasuredCacheRead = value
  }

  private get lastMeasuredCacheWrite(): number | null {
    return this.session.lastMeasuredCacheWrite
  }
  private set lastMeasuredCacheWrite(value: number | null) {
    this.session.lastMeasuredCacheWrite = value
  }

  private get lastMeasuredContextSignature(): string | null {
    return this.session.lastMeasuredContextSignature
  }
  private set lastMeasuredContextSignature(value: string | null) {
    this.session.lastMeasuredContextSignature = value
  }

  private get measuredAtHistoryLength(): number {
    return this.session.measuredAtHistoryLength
  }
  private set measuredAtHistoryLength(value: number) {
    this.session.measuredAtHistoryLength = value
  }

  private get failedConnectionRequest(): OrchestratorSendInput | null {
    return this.session.failedConnectionRequest
  }
  private set failedConnectionRequest(value: OrchestratorSendInput | null) {
    this.session.failedConnectionRequest = value
  }

  /** Session-scoped agents (ALS when inside a turn; else bound session). */
  private get agents(): AgentRegistry {
    return this.session.agents
  }

  /** Session-scoped tasks. */
  private get tasks(): TaskQueue {
    return this.session.tasks
  }

  constructor(
    agents: AgentRegistry,
    tasks: TaskQueue,
    private worktrees: WorktreeManager,
    private ptyManager: PtyManager,
    private headlessRunner: HeadlessAgentRunner,
    private macros: MacroEngine,
    private settingsStore: SettingsStore,
    private providerAuth: ProviderAuthService,
    private mcpManager?: McpManager,
    private skillsRegistry?: SkillsRegistry,
    private agentConfigManager?: AgentConfigManager,
    private fileService?: FileService,
    private gitService?: GitService,
    private lineEditStats?: LineEditStatsStore,
    private projectManager?: ProjectManager,
    runtime?: { questions?: UserQuestionService; modeRegistry?: ModeRegistry }
  ) {
    super()
    this.adapters.setInstances(new ProviderInstanceService({ providerAuth }))
    this.questions = runtime?.questions ?? defaultUserQuestionService
    this.modeRegistry = runtime?.modeRegistry ?? defaultModeRegistry
    // Seed unbound session registries (tests / legacy inject shared instances).
    this.boundSession.agents = agents
    this.boundSession.tasks = tasks
    this.llm = new LlmClient(
      settingsStore,
      providerAuth,
      mcpManager,
      skillsRegistry,
      // Prefer ALS-scoped thread project cwd so concurrent turns never share WorktreeManager.repoRoot.
      () => this.session.projectCwd ?? this.worktrees.getRepoRoot(),
      fileService,
      gitService,
      lineEditStats,
      (payload) => this.emit('document-opened', payload),
      this.tasks,
      (action) => this.emit('quick-action-created', action),
      (payload, threadId) => this.presentPlanCard(payload, threadId),
      { questions: this.questions, modeRegistry: this.modeRegistry }
    )

    this.headlessRunner.on('exit', ({ agentId, exitCode }) => {
      const owner = this.agentOwner(agentId)
      if (owner && owner !== this.session) {
        this.sessionAls.run(owner, () => this.handleHeadlessExit(agentId, exitCode))
        return
      }
      this.handleHeadlessExit(agentId, exitCode)
    })
  }

  /**
   * The session whose agent registry holds `agentId` (named-agent projections and agents restored
   * from earlier versions), searched instead of a separate ownership map.
   */
  private agentOwner(agentId: string): ThreadSession | undefined {
    for (const session of new Set([this.boundSession, ...this.sessions.values()]))
      if (session.agents.get(agentId)) return session
    return undefined
  }

  /**
   * A legacy headless agent's process ended. Completion used to be read from a progress file;
   * that protocol is retired (SPEC §14.5), so an exit is terminal: a non-zero code fails the agent,
   * a clean exit leaves it interrupted with its worktree retained for inspection.
   */
  private handleHeadlessExit(agentId: string, exitCode: number | null): void {
    const agent = this.agents.get(agentId)
    if (!agent || agent.executionMode !== 'headless') return
    if (agent.status !== 'starting' && agent.status !== 'running') return
    if (exitCode === null) return
    if (exitCode !== 0) this.reportGuiAgentTerminalState(agentId, `Headless agent exited with code ${exitCode}.`, 'failed')
    else this.reportGuiAgentTerminalState(agentId, 'Headless agent exited; its worktree is retained for inspection.', 'interrupted')
  }

  setPersistCallback(fn: (threadId?: string | null) => void): void {
    this.persistFn = fn
  }

  /** Optional ThreadDataStore for durable queue + cross-thread persistence. */
  setThreadStore(store: ThreadDataStore | null): void {
    this.threadStore = store
    this.installTitleGuard()
  }

  /**
   * Phase 1 Run Engine bridge (docs/run-engine/SPEC.md §5). When set, every send is a durable run
   * and executeTurn reports its lifecycle through the engine's CAS hooks. Null keeps legacy only.
   */
  setRunEngine(engine: RunEngine | null): void {
    this.runEngineUnsubscribe?.()
    this.runEngineUnsubscribe = null
    this.runEngine?.setDelegationHost(null)
    this.runEngine?.setInFlightCanceller(null)
    this.runEngine?.store.setProviderBackgroundWork(null)
    this.runEngine?.store.setUnreadSteers(null)
    this.questionRouterOff?.()
    this.questionRouterOff = null
    this.runEngine?.handoffs.setTranscriptSource(null)
    this.runEngine = engine
    if (!engine) return
    this.installTitleGuard()
    this.attachInFlightCanceller()
    // Input (4) of the hold predicate: synchronous, in memory, never throws (it is read inside transactions).
    engine.store.setProviderBackgroundWork((threadId) => this.providerBackground.has(threadId))
    // Input (5): steers a live turn has not read yet become a follow-up turn only after its terminal write.
    engine.store.setUnreadSteers((threadId) => this.hasUnreadSteers(threadId))
    this.questionRouterOff = this.routeSubagentQuestions(engine)
    engine.handoffs.setTranscriptSource((threadId) => this.handoffTranscript(threadId))
    engine.setDelegationHost({
      createThread: (creation) =>
        creation.kind === 'delegation' ? this.createChildThread(creation.request) : this.createForkThread(creation),
      deleteThread: (threadId) => this.discardCreatedThread(threadId),
      forkPointSeed: (sourceThreadId, sourceRunId) => this.forkPointSeed(sourceThreadId, sourceRunId),
      titleConflicts: (parentThreadId, title) => this.subagentTitleConflicts(parentThreadId, title),
      threadLive: (threadId) => this.titleOf(threadId) !== undefined,
      buildChildTurnPayload: ({ childThreadId, childRunId, prompt, request }): TurnStartPayload => ({
        runId: childRunId,
        threadId: childThreadId,
        // A plan-ceiling child plans only (SPEC §15.1). The subagent is told where its result goes, then its task.
        input: { content: `${subagentPreamble(this.titleOf(request.parentThreadId))}\n\n${prompt}`, mode: request.modeCeiling === 'plan' ? 'plan' : 'agent' },
        reuseLastUser: false,
        displayUserMessage: true,
        source: 'delegation',
        // The path recorded when the child was created, not the parent's workspace as it is now.
        ...(request.workspace === 'shared' ? { sharedWorkspace: this.getOrCreateSession(childThreadId).sharedWorkspace ?? null } : {})
      })
    })
    const onEvent = (event: ThreadEvent): void => {
      // Running delegated tasks wake the parent when they finish; until then its thread is Waiting.
      if (event.type === 'delegation.status')
        this.runtimeManager?.setPendingDelegations(event.threadId,
          engine.delegations.listForParentThread(event.threadId).some((delegation) => delegation.status === 'running'))
      if (event.type === 'reconcile.delivery_failed') this.noteUndeliveredResult(event)
      this.emit('run-event', event)
    }
    const onStop = (payload: { threadId: string; runId: string }): void => { this.emit('stop-requested', payload) }
    const onSteer = (payload: { threadId: string; runId: string }): void => { this.emit('steer-accepted', payload) }
    engine.on('event', onEvent)
    engine.on('stop-requested', onStop)
    engine.on('steer-accepted', onSteer)
    this.runEngineUnsubscribe = () => {
      engine.off('event', onEvent)
      engine.off('stop-requested', onStop)
      engine.off('steer-accepted', onSteer)
    }
  }

  /**
   * A provider's background work for `threadId` started (`active`) or finished (including an idle-cap
   * expiry). While it runs, the tasks waiting on the thread stay `running`; when it ends they are
   * evaluated again. Called by the adapter that owns the work; nothing calls it yet.
   */
  setProviderBackgroundWork(threadId: string, active: boolean): void {
    if (active === this.providerBackground.has(threadId)) return
    if (active) this.providerBackground.add(threadId)
    else this.providerBackground.delete(threadId)
    if (!active) this.runEngine?.store.settleHold(threadId)
  }

  /**
   * A subagent's question reaches its parent (issue #142). Every question the daemon asks on a
   * subagent's thread (the model's own `ask_user`, a plan question, a provider's approval such as
   * Codex's command approval; they all go through `UserQuestionService`) writes a `child_question`
   * row (a `reconcile_notice`) into the parent's inbox, and rule 4 wakes or steers the parent with
   * it: it answers with `answer_subagent` or asks the user. The user still sees the question under
   * the top-level thread. When the question is answered, dismissed or times out, its row is
   * acknowledged on the `cleared` event; one left from a previous process is acknowledged at boot.
   * Returns the function that removes the listeners.
   */
  private routeSubagentQuestions(engine: RunEngine): () => void {
    const onPending = (event: { requestId: string; threadId: string }): void => {
      try {
        const lineage = engine.delegations.getLineage(event.threadId)
        if (!lineage || lineage.relationship !== 'subagent' || this.titleOf(lineage.parentThreadId) === undefined) return
        const task = engine.delegations.listForChildThread(event.threadId).filter((entry) => entry.parentThreadId === lineage.parentThreadId && entry.status === 'running').at(-1)
        const payload: ChildQuestionPayload = {
          kind: 'child_question',
          childThreadId: event.threadId,
          childRunId: engine.getActiveRun(event.threadId)?.runId ?? null,
          requestId: event.requestId,
          ...(task ? { delegationId: task.delegationId } : {})
        }
        engine.inbox.append({ threadId: lineage.parentThreadId, runId: task?.parentRunId ?? null, kind: 'reconcile_notice', payload })
      } catch (error) {
        console.warn('a subagent\'s question could not be routed to its parent', { threadId: event.threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const onCleared = (event: { requestId: string; threadId: string }): void => {
      try {
        const open = engine.inbox
          .listForChildThread(event.threadId, 'child_question')
          .filter((row) => row.status !== 'acknowledged' && (row.payload as ChildQuestionPayload).requestId === event.requestId)
        if (open.length) engine.store.db.transaction(() => engine.inbox.markAcknowledged(open.map((row) => row.inboxId)))
      } catch (error) {
        console.warn('a cleared question\'s notice could not be acknowledged', { threadId: event.threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.questions.on('pending', onPending)
    this.questions.on('cleared', onCleared)
    return () => {
      this.questions.off('pending', onPending)
      this.questions.off('cleared', onCleared)
    }
  }

  /**
   * Before a delivery: a row about a question that is not pending any more (answered, dismissed, timed
   * out, or lost with a restart) is acknowledged instead of delivered, so the parent is never told to
   * answer what nobody can. Returns the rows that are still worth delivering.
   */
  private dropStaleQuestionRows(rows: InboxRecord[]): InboxRecord[] {
    const engine = this.runEngine
    if (!engine) return rows
    const stale = rows.filter((row) => isChildQuestionRow(row) && !this.questions.getPending((row.payload as ChildQuestionPayload).requestId))
    if (stale.length === 0) return rows
    engine.store.db.transaction(() => engine.inbox.markAcknowledged(stale.map((row) => row.inboxId)))
    return rows.filter((row) => !stale.includes(row))
  }

  /**
   * Whether the thread's live turn holds steers nobody has read yet, so its tasks must not publish: a
   * person's plain-text steer lives only in the turn's memory until the turn settles and queues it as a
   * follow-up run (`RunStore.setUnreadSteers`). Once queued, the follow-up is a run of the engine, which
   * holds the thread on its own and survives a restart.
   */
  private hasUnreadSteers(threadId: string): boolean {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    const turn = session?.activeTurn
    return Boolean(turn && !turn.abort.signal.aborted && turn.pendingSteer.length > 0)
  }

  /**
   * A subagent result could not be delivered after every attempt (`restoreUndeliveredRows`): the
   * thread gets a visible notice, so the result is never silently lost. The result itself is intact
   * and readable with `task_status`.
   */
  private noteUndeliveredResult(event: ThreadEvent): void {
    try {
      const { delegationId, attempts } = event.payload as { delegationId?: string | null; attempts?: number }
      const delegation = delegationId ? this.runEngine?.delegations.get(delegationId) : null
      const title = delegation ? this.titleOf(delegation.childThreadId) : undefined
      const session = this.getOrCreateSession(event.threadId)
      this.sessionAls.run(session, () => this.addSystemMessage(
        `The result of ${title ? `subagent "${title}"` : 'a subagent'} could not be delivered after ${attempts ?? 'several'} attempts. Read it with task_status${delegationId ? ` (${delegationId})` : ''}.`
      ))
    } catch (error) {
      console.warn('undelivered result notice could not be written', { threadId: event.threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Boot reconciliation: runs the previous daemon left active become interrupted. */
  recoverRunEngineOnBoot(): string[] {
    const engine = this.runEngine
    if (!engine) return []
    const { interrupted } = engine.reconcileOnBoot()
    for (const runId of interrupted) {
      this.emit('run-interrupted-on-boot', { threadId: engine.getRun(runId)?.threadId, runId })
    }
    this.recoverQueuedRows()
    return interrupted
  }

  /**
   * Boot: a row a queue item carries (`queue:<id>`) whose item is gone (removed or cleared, then a
   * crash) has no delivery left; it goes back to pending for rule 4. A row whose item exists stays with it.
   */
  private recoverQueuedRows(): void {
    const engine = this.runEngine
    const store = this.threadStore
    if (!engine || !store) return
    const items = new Map<string, Set<string>>()
    for (const row of engine.inbox.listDeliveredByQueue()) {
      let ids = items.get(row.threadId)
      if (!ids) {
        try {
          ids = new Set(readDurableQueue(store, row.threadId).map((item) => item.id))
        } catch {
          continue
        }
        items.set(row.threadId, ids)
      }
      if (!ids.has(row.deliveredBy!.slice('queue:'.length))) engine.inbox.release([row.inboxId], row.deliveredBy!)
    }
  }

  /**
   * Stop a specific run. Only the thread's active run is the target; any other run is ignored without
   * cascading. A live target stops like any Stop (`stopThread`): the thread and every subagent below
   * it. The interrupt follows `CommandPolicy.stopStrategy` (`interruptRun`). A replay of an accepted
   * stop (same `clientRequestId`) enqueues the interrupt again when the run is still active and none
   * is pending or running (M4).
   */
  async abortRun(runId: string, clientRequestId: string, threadId?: string): Promise<CommandResult> {
    const engine = this.requireRunEngine()
    const target = threadId ?? engine.getRun(runId)?.threadId
    if (!target) return { status: 'ignored', reason: 'run_not_found', runId, sequence: 0 }
    const result = await this.stopThread(target, 'user', { runId, clientRequestId })
    const sequence = engine.maxSeq(target)
    if (result.status === 'rejected') return { status: 'rejected', reason: result.reason ?? 'rejected', sequence, replayed: result.replayed }
    if (result.status === 'ignored')
      return {
        status: 'ignored',
        reason: result.reason ?? 'run_not_active',
        runId,
        activeRunId: engine.getActiveRun(target)?.runId ?? null,
        sequence,
        ...(result.replayed ? { replayed: true } : {})
      }
    return { status: 'accepted', runId, sequence, replayed: result.replayed }
  }

  /**
   * The one Stop (issue #142): every public Stop (the protocol's `orchestrator.abort`, with or without
   * a `runId`, `abortRun`, the CLI, a channel's `/stop`, the remote hub, Lineage's Stop and Stop all,
   * `task_cancel`, deleting or settling a thread) comes here, and so does nothing else. An internal
   * abort (a steer that restarts the turn, a question that preempts it, a shutdown) stays local, on
   * `abortActiveTurn`, which this wraps and which never calls back.
   *
   * Everything the Stop cancels is decided in one run-store transaction before any await
   * (`RunEngine.stopSubtree`): the subtree of subagents, a higher stop generation for each thread in
   * it, its running delegations, queued runs, active runs and inbox rows. After that, by id: the
   * active runs are aborted locally (only those runs, so a message sent to a subagent after the
   * transaction survives), the queue entries of the subtree are removed, and the providers are told to
   * end what they still run for each thread, whether or not a turn is live. `ok` is true when
   * anything was running or waiting. A stale `runId` returns its outcome and does not cascade; a
   * repeated `clientRequestId` returns the first result.
   */
  async stopThread(
    threadId: string,
    reason: string,
    opts: { runId?: string; clientRequestId?: string; clearQueue?: boolean; requesterThreadId?: string } = {}
  ): Promise<StopThreadOutcome> {
    const engine = this.runEngine
    if (!engine) {
      // Without a run engine there is only the local turn and its queue.
      const turnAborted = this.abortActiveTurn(threadId, { clearQueue: opts.clearQueue })
      const channelAborted = this.abortChannelTurn(threadId)
      const aborted = turnAborted || channelAborted
      return { ok: aborted, status: 'stopped', replayed: false, threadId, threads: [threadId], activeRuns: [], cancelledRuns: [], delegations: [] }
    }
    const result = engine.stopSubtree({ threadId, reason, ...opts })
    if (result.status !== 'stopped') return { ok: false, ...result }
    let aborted = false
    if (result.replayed) {
      // The first Stop's interrupt may have ended without stopping the run (M4).
      for (const run of engine.reinterruptStopped(result)) aborted = this.interruptNow(run.runId, run.threadId) || aborted
    } else {
      for (const run of result.activeRuns) {
        aborted = this.abortActiveTurn(run.threadId, { runId: run.runId }) || aborted
        // The worker runs the interrupt effect `stopSubtree` queued; without one, the interrupt runs now.
        if (!this.effectsEnabled()) void this.interruptRun(run.runId, run.threadId)
      }
      // A live turn that is not an engine run (a legacy turn, a channel turn) is still the Stop's to end,
      // for the thread the Stop was aimed at; nothing can have started since the transaction.
      if (!result.activeRuns.some((run) => run.threadId === threadId)) aborted = this.abortActiveTurn(threadId) || aborted
      for (const id of result.threads) aborted = this.abortChannelTurn(id) || aborted
      this.removeStoppedQueueEntries(result, opts.clearQueue === true)
    }
    const worked = await Promise.all(result.threads.map((id) => this.stopProviderWork(id)))
    const stoppedAnything = aborted || worked.some(Boolean) || result.activeRuns.length + result.cancelledRuns.length + result.delegations.length > 0
    return { ok: stoppedAnything, ...result }
  }

  /** A replayed Stop's interrupt, now: through the worker when there is one, else directly. True when a live turn was aborted. */
  private interruptNow(runId: string, threadId: string): boolean {
    const aborted = this.abortActiveTurn(threadId, { runId })
    if (!this.effectsEnabled()) void this.interruptRun(runId, threadId)
    return aborted
  }

  /**
   * After a Stop's transaction: the queue entries that belong to the work it stopped leave the
   * durable queues of the subtree, under each thread's queue lock and after the generation was
   * raised. In a subagent everything queued goes; in the thread the Stop was aimed at only what
   * delivers a subagent's result (a steer that missed its turn, whose notice rows the Stop
   * acknowledged) and the entries of runs it cancelled; what a person queued there stays unless
   * `clearQueue` (as a Stop always did).
   */
  private removeStoppedQueueEntries(result: StopResult, clearQueue: boolean): void {
    const cancelled = new Set(result.cancelledRuns.map((run) => run.runId))
    for (const id of result.threads) {
      const isRoot = id === result.threadId
      const generation = this.runEngine ? currentStopGeneration(this.runEngine.store, id) : 0
      // What a Stop removes: entries of the runs it cancelled, notices that missed their turn, work started on
      // behalf of a parent before the Stop (a stale `stopGeneration`), and, below the thread it was aimed at,
      // entries that name no run. A message a person queued stays, at any level, unless asked to clear.
      const removable = (item: QueuedMessage): boolean => {
        if (item.state === 'claimed') return false
        if (item.runId && cancelled.has(item.runId)) return true
        if (item.inboxIds?.length) return true
        if (isFencedSource(item.source) && (item.stopGeneration === undefined || item.stopGeneration < generation)) return true
        if (!isRoot && !item.runId) return true
        return clearQueue && !item.internal
      }
      try {
        this.mutateQueue(id, (items) => {
          const gone = items.filter(removable)
          if (gone.length === 0) return items
          // Their rows were acknowledged by the Stop; any a Stop did not reach go back to pending.
          this.releaseQueuedRows(gone)
          for (const item of gone) if (item.workflowInvocationId) this.workflowChat?.abandon(item.workflowInvocationId, id)
          this.cancelQueuedRuns(gone.map((item) => item.runId))
          return items.filter((item) => !gone.includes(item))
        })
      } catch (error) {
        console.warn('a stopped thread\'s queue could not be cleared', { threadId: id, error: error instanceof Error ? error.message : String(error) })
      }
      // A queued follow-up that left held the thread's tasks (`hasUnreadSteers`).
      this.reevaluateHold(id)
    }
  }

  /** A claimed entry the Stop fence refuses: the notice rows it carried are acknowledged, its claim completes and its run ends. */
  private refuseFencedQueueItem(session: ThreadSession, item: QueuedMessage, claimToken: string | undefined): void {
    const engine = this.runEngine
    try {
      if (engine && item.inboxIds?.length) {
        const own = engine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === queueOwner(item.id))
        engine.store.db.transaction(() => engine.inbox.markAcknowledged(own.map((row) => row.inboxId)))
      }
    } catch (error) {
      console.warn('fenced queue entry rows could not be acknowledged', { itemId: item.id, error: error instanceof Error ? error.message : String(error) })
    }
    this.completeSessionClaim(session, item.id, claimToken)
    this.cancelQueuedRuns([item.runId])
  }

  /** Rewrites a thread's queue (durable under its lock when there is a store) and tells listeners when it changed. */
  private mutateQueue(threadId: string, mutate: (items: QueuedMessage[]) => QueuedMessage[]): void {
    const loaded = threadId === this.boundSession.threadId ? this.boundSession : this.sessions.get(threadId)
    let before = 0
    let after: QueuedMessage[]
    if (this.threadStore) {
      after = mutateDurableQueue(this.threadStore, threadId, (items) => {
        before = items.length
        return mutate(items)
      })
    } else {
      if (!loaded) return
      before = loaded.queue.length
      after = mutate(loaded.queue)
    }
    if (after.length === before) return
    if (loaded) loaded.queue = after
    this.emitQueueUpdated(threadId, after)
  }

  /**
   * SPEC §13.3 Stop by `CommandPolicy.stopStrategy`: `interrupt` aborts the live turn and asks the
   * adapter to interrupt its session; `settle_locally` (a provider that cannot be interrupted)
   * aborts the live turn only. When nothing was live — no in-process turn to abort and the adapter
   * reports `not_active` — the run is settled here, `interrupted` by the user, instead of waiting
   * for reconciler rule 3. The strategy is recorded on the run outcome.
   */
  private async interruptRun(runId: string, threadId: string): Promise<void> {
    const engine = this.runEngine
    const run = engine?.getRun(runId) ?? null
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) return
    const caps = this.capabilitiesForThread(threadId)
    const strategy = caps ? stopStrategy(caps, run) : run ? 'interrupt' : 'noop'
    // Only this run's turn: a later turn of the thread (a message sent after the Stop) is not its to abort.
    const abortedLocally = this.abortActiveTurn(threadId, { runId })
    if (strategy === 'noop' || !engine || !run) return
    // A turn of this process (live, admitted or unwinding) writes the run's terminal state itself.
    let live = abortedLocally || this.hasLocalTurn(threadId)
    if (strategy === 'interrupt') {
      const ref = run.activeAttemptId ? engine.store.getAttempt(run.activeAttemptId)?.providerRef ?? null : null
      if (ref) {
        try {
          // A session already running on an instance can still be stopped after it was disabled.
          // A ref of a turn that ran on the unselected default names the bare pi driver.
          const { adapter } = this.adapters.resolveSelection({ instanceId: ref.instanceId, llmProvider: ref.provider }, { allowDisabled: true, unselectedDefault: true })
          if ((await adapter.interrupt(ref)) === 'interrupted') live = true
        } catch (error) {
          console.warn('adapter interrupt failed', { runId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    if (live) return
    console.warn('stop settled locally: nothing live for the run', { runId, strategy })
    this.markRun(runId, (runs, id) => {
      const current = runs.getRun(id)
      if (current && !TERMINAL_RUN_STATUSES.has(current.status))
        runs.markTerminal(id, 'interrupted', { interruptedBy: 'user', stopStrategy: strategy })
    })
  }

  /**
   * Stop reaches the provider's process for the thread (`ProviderAdapter.stopThread`): what it still
   * runs in the background ends, whether or not a turn is live. True when there was a process to end.
   * Never throws.
   */
  async stopProviderWork(threadId: string): Promise<boolean> {
    try {
      return (await this.adapterForThread(threadId).adapter.stopThread?.(threadId)) === 'stopped'
    } catch (error) {
      console.warn('provider stop failed', { threadId, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Steer a specific run. Only the thread's active run receives the text; anything else is ignored. */
  async steerRun(runId: string, text: string, clientRequestId: string, threadId?: string): Promise<CommandResult> {
    const engine = this.requireRunEngine()
    const target = threadId ?? engine.getRun(runId)?.threadId
    if (!target) return { status: 'ignored', reason: 'run_not_found', runId, sequence: 0 }
    const result = await engine.dispatch({ kind: 'steer', threadId: target, clientRequestId, runId })
    if (result.status === 'accepted' && !result.replayed) {
      this.enqueueControlEffect('turn.steer', target, runId, { runId, threadId: target, text }, () => {
        if (!this.steerThread(target, text)) {
          console.warn('run engine steer accepted but the legacy turn did not take it', { runId })
        }
      })
    }
    return result
  }

  /**
   * Phase 2b (SPEC §12.2-§12.3): with a worker attached, turns, interrupts and steers run as
   * durable effects. The profile attaches the worker after boot recovery and detaches it on stop.
   */
  attachEffectWorker(worker: EffectWorker | null): void {
    this.effectWorker = worker
    this.attachInFlightCanceller()
  }

  /** C2: the engine aborts a claimed `turn.start` (a cancelled child still provisioning) through the worker. */
  private attachInFlightCanceller(): void {
    const worker = this.effectWorker
    this.runEngine?.setInFlightCanceller(worker ? (effectId) => worker.cancelInFlight(effectId) : null)
  }

  private effectsEnabled(): boolean {
    return Boolean(this.runEngine && this.effectWorker)
  }

  /**
   * Phase 5 (SPEC §15.2): the profile's Mousse MCP server. Each turn of an MCP-capable adapter gets
   * its thread's credential for that provider (`AdapterHost.mcp`), stable across turns so the
   * runtime's session and MCP configuration stay the same; deleting the thread or switching its
   * provider revokes it.
   */
  setMcpAttachment(provider: McpAttachmentProvider | null): void {
    this.mcpAttachment = provider
  }

  /**
   * The credential ceiling of a run on `threadId`: `plan` for a plan-mode turn, and never above the
   * ceiling its delegations gave it (a delegated child inherits its parent's). A subagent's own
   * policy is that of its first task: a later follow-up may narrow it, never widen it.
   */
  private modeCeilingFor(threadId: string, mode: ChatMode): ModeCeiling {
    if (mode === 'plan') return 'plan'
    try {
      const tasks = this.runEngine?.delegations.listForChildThread(threadId) ?? []
      return narrowCeiling(tasks.at(0)?.modeCeiling, tasks.at(-1)?.modeCeiling) === 'plan' ? 'plan' : 'default'
    } catch {
      return 'plan'
    }
  }

  /**
   * The thread's MCP credential for the adapter (reused, re-pointed at this run and ceiling) when
   * the adapter can attach the server; null otherwise.
   */
  private mcpFor(adapter: ProviderAdapter, instanceId: string, threadId: string, runId: string | undefined, mode: ChatMode): AdapterHost['mcp'] {
    if (!runId || !this.mcpAttachment || !this.runEngine || !mcpAttachable(adapter.capabilities)) return null
    try {
      // One credential per thread and provider instance (SPEC §15.1).
      return this.mcpAttachment.attach({ threadId, runId, provider: instanceId, modeCeiling: this.modeCeilingFor(threadId, mode) })
    } catch (error) {
      console.warn('Mousse MCP credential could not be minted; the turn runs without Mousse tools', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  /** The thread's turn ended: its in-flight Mousse tool calls abort; the credential stays. */
  private endMcpTurn(threadId: string): void {
    try {
      this.mcpAttachment?.turnEnded(threadId)
    } catch (error) {
      console.warn('Mousse MCP turn end failed', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Revokes the thread's Mousse MCP credentials (thread deleted, provider switched). */
  private revokeMcp(threadId: string): void {
    try {
      this.mcpAttachment?.revokeThread(threadId)
    } catch (error) {
      console.warn('Mousse MCP credentials could not be revoked', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * What the Mousse MCP server's tools need from the thread owner (SPEC §15.1). Every call acts as
   * the credential's caller: its thread's session, run and mode ceiling.
   */
  mcpToolHost(): MousseToolHost {
    return {
      delegation: (caller: McpCaller) =>
        this.delegationTools(this.getOrCreateSession(caller.threadId), caller.runId, caller.modeCeiling),
      askUser: (threadId, questions, options) => this.questions.requestAnswers(questions, threadId, options),
      presentPlan: (threadId, payload) => {
        const session = this.getOrCreateSession(threadId)
        this.sessionAls.run(session, () => this.presentPlanCard(payload, threadId))
      },
      tasks: (threadId) => this.getTasksForThread(threadId),
      listQueue: (threadId) => this.listQueue(threadId),
      enqueue: (threadId, input) => this.enqueueAndDrain(threadId, input, 'mcp'),
      toolLedger: (runId) => this.toolLedgerFor(runId),
      readOnlyThread: (threadId) => this.isReadOnlyChild(threadId)
    }
  }

  /** Executors for the `turn.*` effects; the profile hands them to its `EffectWorker`. */
  effectExecutors(): Partial<Record<EffectKind, EffectExecutor>> {
    return {
      'turn.start': (effect, ctx) => this.executeTurnStartEffect(effect, ctx.signal),
      'turn.interrupt': (effect) => this.executeTurnInterruptEffect(effect),
      'turn.steer': async (effect) => this.executeTurnSteerEffect(effect)
    }
  }

  /**
   * Starts an admitted turn. With effects enabled and a run, the turn becomes a `turn.start`
   * effect whose result the returned promise carries; otherwise it runs directly. The caller
   * may hold admission (`admissionHeld`); the effect path always holds it until the executor runs
   * so a concurrent send still queues.
   */
  private startTurn(session: ThreadSession, payload: TurnStartRequest): Promise<OrchestratorResponse> {
    const direct = (admissionHeld: boolean | undefined): Promise<OrchestratorResponse> => this.settleCarriedRows(payload, this.runTurnOnSession(
      session,
      payload.input,
      payload.reuseLastUser,
      payload.displayUserMessage,
      {
        source: payload.source,
        queueItemId: payload.queueItemId,
        claimOwnerToken: payload.claimOwnerToken,
        suppressAutoQueueDrain: payload.suppressAutoQueueDrain,
        runId: payload.runId,
        admissionHeld,
        subagentNotice: payload.subagentNotice
      }
    ))
    const runId = payload.runId
    if (!runId || !this.effectsEnabled()) return direct(payload.admissionHeld)
    if (!payload.admissionHeld) {
      // Let the direct path produce its usual "already running" rejection.
      if (session.turnAdmitted) return direct(false)
      session.turnAdmitted = true
    }
    try {
      return this.enqueueTurnStart({ ...payload, runId, admissionHeld: true })
    } catch (error) {
      console.warn('turn.start effect could not be recorded; running the turn directly', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
      return direct(true)
    }
  }

  /**
   * A queued turn that runs without a `turn.start` effect (effects are off, or recording the effect
   * failed) has no effect for its rows to follow, so they follow the turn's run. Only its outcome
   * counts, never the shape of the response:
   * - `completed`: the turn consumed the notice; the rows are acknowledged;
   * - not terminal (a lease race put the item back in the queue, or no run was recorded): the rows
   *   stay with the item, which delivers them when it drains again;
   * - interrupted by the user: the rows stay `delivered` and belong to nothing, as a stopped delivery
   *   always has (no redelivery behind a Stop);
   * - anything else (failed, cancelled, cut off by a restart or shutdown): given back, so rule 4 delivers them.
   */
  private settleCarriedRows(payload: TurnStartRequest, turn: Promise<OrchestratorResponse>): Promise<OrchestratorResponse> {
    const engine = this.runEngine
    if (!engine || !payload.inboxIds?.length || !payload.queueItemId) return turn
    const owner = queueOwner(payload.queueItemId)
    const own = (): InboxRecord[] => engine.inbox.getMany(payload.inboxIds!).filter((row) => row.status === 'delivered' && row.deliveredBy === owner)
    const give = (): void => { engine.inbox.release(own().map((row) => row.inboxId), owner) }
    return turn.then((response) => {
      try {
        const run = payload.runId ? engine.getRun(payload.runId) : null
        if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return response
        if (run.status === 'completed') engine.store.db.transaction(() => acknowledgeRows(engine.store, own()))
        else if (run.status === 'interrupted' && run.outcome?.interruptedBy === 'user') engine.inbox.detachDelivery(own().map((row) => row.inboxId), owner)
        else give()
      } catch (error) {
        console.warn('queued notice rows could not be settled', { error: error instanceof Error ? error.message : String(error) })
      }
      return response
    }, (error: unknown) => {
      try { give() } catch { /* the rows stay with the item; boot releases them if it is gone */ }
      throw error
    })
  }

  /**
   * Records a `turn.start` effect and the in-memory deferred its executor settles. The run's send
   * already committed; the effect is its own transaction (Phase 2b).
   */
  private enqueueTurnStart(payload: TurnStartPayload): Promise<OrchestratorResponse> {
    const engine = this.requireRunEngine()
    let resolve!: (response: OrchestratorResponse) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<OrchestratorResponse>((done, failed) => {
      resolve = done
      reject = failed
    })
    // Ack-mode sends never await the result; a rejection must not surface as unhandled.
    promise.catch(() => undefined)
    const entry: TurnResult = { promise, resolve, reject, payload, effectId: null, started: false, abandoned: false }
    this.turnResults.set(payload.runId, entry)
    try {
      entry.effectId = engine.outbox.enqueue({
        threadId: payload.threadId,
        runId: payload.runId,
        kind: 'turn.start',
        payload: { ...payload, input: durableSendInput(payload.input) }
      }).effectId
      // The notices this turn carries now follow its outcome: read when it completes, redelivered when it fails.
      if (payload.inboxIds?.length && payload.queueItemId) engine.inbox.redirectDelivery(payload.inboxIds, entry.effectId, queueOwner(payload.queueItemId))
    } catch (error) {
      this.turnResults.delete(payload.runId)
      throw error
    }
    return promise
  }

  private async executeTurnStartEffect(effect: EffectRecord, signal: AbortSignal): Promise<void> {
    if (isWakeTurnPayload(effect.payload)) return this.executeWakeEffect(effect, effect.payload, signal)
    if (isIntegrationTurnPayload(effect.payload)) return this.executeIntegrationEffect(effect.payload, signal)
    const stored = effect.payload as TurnStartPayload
    const entry = this.turnResults.get(stored.runId)
    if (entry?.abandoned) return
    // C2: only a queued run starts. One that was cancelled (a delegation cancel, a deleted thread)
    // or is already being executed never reaches workspace provisioning or the provider.
    const run = this.runEngine?.getRun(stored.runId)
    if (run && run.status !== 'queued') {
      this.skipUnstartableTurn(entry?.payload ?? stored, entry, run)
      return
    }
    // The Stop fence at execution: work that starts on behalf of a parent and was admitted before a Stop of its thread is refused.
    if (run && this.runEngine?.isFenced(run.runId)) {
      this.markRun(run.runId, (engine, id) => {
        if (engine.getRun(id)?.status === 'queued') engine.markTerminal(id, 'cancelled', { interruptedBy: 'user' })
      })
      this.skipUnstartableTurn(entry?.payload ?? stored, entry, this.runEngine.getRun(run.runId) ?? run)
      return
    }
    if (entry) entry.started = true
    // The in-memory payload keeps image data the durable payload omits. Without it the sender is
    // gone (another orchestrator instance), so this executor does not inherit its admission.
    const payload = entry?.payload ?? { ...stored, admissionHeld: false }
    try {
      const session = this.getOrCreateSession(payload.threadId)
      if (payload.sharedWorkspace && !session.sharedWorkspace) session.sharedWorkspace = payload.sharedWorkspace
      const response = await this.runTurnOnSession(
        session,
        payload.input,
        payload.reuseLastUser,
        payload.displayUserMessage,
        {
          source: payload.source,
          queueItemId: payload.queueItemId,
          claimOwnerToken: payload.claimOwnerToken,
          suppressAutoQueueDrain: payload.suppressAutoQueueDrain,
          runId: payload.runId,
          admissionHeld: payload.admissionHeld,
          externalSignal: signal,
          subagentNotice: payload.subagentNotice
        }
      )
      entry?.resolve(response)
    } catch (error) {
      entry?.reject(error)
      // An ordinary turn failure is already recorded on the run by the bridge; the effect itself
      // succeeded. Only a run the bridge could not settle is an infrastructure failure.
      const run = this.runEngine?.getRun(payload.runId)
      if (!run || (!TERMINAL_RUN_STATUSES.has(run.status) && run.status !== 'queued')) throw error
    } finally {
      if (this.turnResults.get(payload.runId) === entry) this.turnResults.delete(payload.runId)
    }
  }

  /**
   * A claimed `turn.start` whose run is no longer queued: the sender learns it did not start, the
   * admission its send held is released, and a queue item whose run already ended leaves the queue.
   */
  private skipUnstartableTurn(payload: TurnStartPayload, entry: TurnResult | undefined, run: RunRecord): void {
    if (entry && this.turnResults.get(payload.runId) === entry) this.turnResults.delete(payload.runId)
    const session = this.boundSession.threadId === payload.threadId ? this.boundSession : this.sessions.get(payload.threadId)
    if (session && entry?.payload.admissionHeld && !session.activeTurn) {
      session.turnAdmitted = false
      session.abortRequested = false
      if (session.drainAfterSettle) {
        session.drainAfterSettle = false
        this.scheduleQueueDrain(session)
      }
    }
    if (session && payload.queueItemId && TERMINAL_RUN_STATUSES.has(run.status))
      this.completeSessionClaim(session, payload.queueItemId, payload.claimOwnerToken)
    entry?.reject(new Error(`Run ${payload.runId} is ${run.status}; its turn did not start.`))
  }

  /**
   * A `turn.start` the worker never claimed before shutdown: cancel the effect, release the
   * admission it held and fail the sender. A queue item keeps its claim settlement to the drain's
   * failure path (its run stays queued with the item); a direct send's run is interrupted.
   */
  private abandonTurnStart(runId: string, entry: TurnResult): void {
    entry.abandoned = true
    this.turnResults.delete(runId)
    const { payload } = entry
    try {
      if (entry.effectId) this.runEngine?.outbox.cancel(entry.effectId, new Date().toISOString(), 'shutdown')
    } catch (error) {
      console.warn('turn.start effect could not be cancelled', { runId, error: error instanceof Error ? error.message : String(error) })
    }
    const session = this.boundSession.threadId === payload.threadId ? this.boundSession : this.sessions.get(payload.threadId)
    if (session && !session.activeTurn) session.turnAdmitted = false
    if (!payload.queueItemId) {
      this.markRun(runId, (engine, id) => {
        if (engine.getRun(id)?.status === 'queued') engine.markTerminal(id, 'interrupted', { interruptedBy: 'daemon_restart' })
      })
    }
    entry.reject(Object.assign(new Error('Profile work is shutting down'), { code: 'profile_draining' }))
  }

  /** `turn.interrupt`: stops the run's live turn (`interruptRun`). A run that is no longer live counts as done. */
  private async executeTurnInterruptEffect(effect: EffectRecord): Promise<void> {
    const { runId, threadId } = effect.payload as { runId: string; threadId: string }
    await this.interruptRun(runId, threadId)
  }

  /** The thread has a turn in this process: running, admitted (setting up) or a channel turn. */
  private hasLocalTurn(threadId: string): boolean {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    return Boolean(session?.activeTurn || session?.turnAdmitted || this.channelTurns.has(threadId))
  }

  /**
   * `turn.steer`: delivers to the live turn; a steer that missed it becomes a new turn (SPEC §5).
   * A steer that carries notices owns only the rows it still delivers: it is rebuilt now from those
   * (a row read since, or taken over by another delivery, is dropped), and with none left nothing is
   * delivered. A live turn that takes it marks the rows delivered to that run; one that does not
   * hands the rows to the queued turn it becomes.
   */
  private executeTurnSteerEffect(effect: EffectRecord): void {
    const { runId, threadId, text, inboxIds } = effect.payload as { runId: string; threadId: string; text: string; inboxIds?: string[] }
    const engine = this.requireRunEngine()
    // A steer of a run that a Stop came after belongs to the work that was stopped: it delivers nothing and
    // makes no work (its rows were acknowledged by the Stop).
    if (engine.isStale(runId)) return
    let content = text
    let notice: SubagentNoticeItem[] | undefined
    let carried: { inboxIds: string[]; effectId: string } | undefined
    if (inboxIds?.length) {
      const rows = this.dropStaleQuestionRows(engine.inbox.getMany(inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === effect.effectId))
      if (rows.length === 0) return
      const planned = planWakeNotice(rows, this.noticeContext())
      engine.inbox.recordNoticeVisibility(rows, planned.items)
      content = planned.text
      notice = planned.items
      carried = { inboxIds: rows.map((row) => row.inboxId), effectId: effect.effectId }
    }
    // The rows stay the steer's until the model reads the text (`drainSteerForSession`) or the turn ends
    // without reading it, when the follow-up turn it leaves takes them.
    const run = engine.getRun(runId)
    if (run && !TERMINAL_RUN_STATUSES.has(run.status) && this.steerThread(threadId, content, notice, carried)) return
    this.enqueueLateSteer(threadId, content, carried, notice, runId)
  }

  /** Titles for the notices this orchestrator writes. */
  private noticeContext(): NoticeContext {
    return {
      titleOf: (threadId) => this.titleOf(threadId),
      questionPrompts: (requestId) => this.questions.getPending(requestId)?.questions.map((question) => question.prompt) ?? null
    }
  }

  /**
   * A steer that missed its turn runs as the next turn. The inbox rows it carries move to the queue
   * item (`queue:<id>`), so exactly one delivery owns them at a time: the reconciler does not hand
   * them to a wake, and the item rebuilds its text from the rows that are still its own when it runs.
   */
  private enqueueLateSteer(threadId: string, text: string, carried?: { inboxIds: string[]; effectId: string }, subagentNotice?: SubagentNoticeItem[], runId?: string): void {
    const content = text.trim()
    const session = this.getOrCreateSession(threadId)
    if (!content || session.deleted) return
    // Stamped with the generation of the run it was meant for, never the current one: the Stop fence must
    // still see a steer of an older run as older.
    const stopGeneration = runId && this.runEngine ? runStopGeneration(this.runEngine.store, runId) : undefined
    this.enqueueCarrying(threadId, { content, mode: getLastUserChatMode(session.messages) ?? 'agent' }, { source: 'steer-late', ...(stopGeneration !== undefined ? { stopGeneration } : {}) }, carried ? [carried] : [], subagentNotice)
    if (session.isTurnRunning()) session.drainAfterSettle = true
    else this.scheduleQueueDrain(session)
  }

  /** Queues a turn that delivers notices: the rows it carries are its own until it runs or is removed. */
  private enqueueCarrying(
    threadId: string,
    input: OrchestratorSendInput,
    opts: { source: string; internal?: boolean; stopGeneration?: number },
    carried: ReadonlyArray<{ inboxIds: string[]; effectId: string }>,
    subagentNotice: SubagentNoticeItem[] | undefined
  ): QueuedMessage {
    const inboxIds = carried.flatMap((entry) => entry.inboxIds)
    const item = this.enqueueForThread(threadId, input, { ...opts, ...(inboxIds.length ? { inboxIds, subagentNotice } : {}) })
    // Only rows the carrying steer still delivers move: one a wake took over in the meantime stays that wake's.
    for (const entry of carried) this.requireRunEngine().inbox.redirectDelivery(entry.inboxIds, queueOwner(item.id), entry.effectId)
    return item
  }

  /** A queue item that carried notices is gone without running: its rows are pending again, for rule 4. */
  private releaseQueuedRows(items: ReadonlyArray<QueuedMessage | null | undefined>, attempt = 1): void {
    const engine = this.runEngine
    if (!engine) return
    for (const item of items) {
      if (!item?.inboxIds?.length) continue
      try {
        const own = engine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === queueOwner(item.id))
        if (own.length) engine.inbox.release(own.map((row) => row.inboxId), queueOwner(item.id))
      } catch (error) {
        console.warn('queued notice rows could not be released', { itemId: item.id, attempt, error: error instanceof Error ? error.message : String(error) })
        // The item is gone and its rows belong to nothing that will ever run: they hold the tasks
        // waiting on this thread until they are given back, so the release is tried again. Only this
        // item's own rows move, so it cannot touch the rows of a turn that is running.
        if (attempt < QUEUED_ROW_RELEASE_ATTEMPTS && !this.lifecycle.stopping) {
          const retry = setTimeout(() => {
            this.releaseRetries.delete(retry)
            // A shutdown that began since owns the rows: boot gives back what is left.
            if (this.lifecycle.stopping) return
            this.releaseQueuedRows([item], attempt + 1)
          }, QUEUED_ROW_RELEASE_RETRY_MS)
          retry.unref?.()
          this.releaseRetries.add(retry)
        }
      }
    }
  }

  /** Enqueues a control effect, or runs `fallback` directly without effects or when the write fails. */
  private enqueueControlEffect(
    kind: 'turn.interrupt' | 'turn.steer',
    threadId: string,
    runId: string,
    payload: Record<string, unknown>,
    fallback: () => void
  ): void {
    if (this.effectsEnabled()) {
      try {
        this.requireRunEngine().outbox.enqueue({ threadId, runId, kind, payload })
        return
      } catch (error) {
        console.warn(`${kind} effect could not be recorded; applying it directly`, {
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    fallback()
  }

  // ---------------------------------------------------------------------------------------------
  // Delegation (docs/run-engine/SPEC.md §14): children are threads with lineage, delegation is a
  // row, a child's completion is an inbox row written with its terminal run, and reconciler rule 4
  // wakes the parent. Every caller goes through `delegate_task`.

  /** Capabilities of the adapter serving the thread's selected model (reconciler rule 4). */
  capabilitiesForThread(threadId: string): ProviderCapabilities | null {
    try {
      return this.adapterForThread(threadId).adapter.capabilities
    } catch {
      return null
    }
  }

  private adapterForThread(threadId: string) {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    const explicit = session?.modelOverride ?? this.threadStore?.getThread(threadId)?.modelOverride
    return this.adapters.resolveSelection(explicit ?? this.defaultAgentModel(), { allowDisabled: true, unselectedDefault: !explicit })
  }

  private defaultAgentModel(): ModelOverride {
    return this.adapters.instances.migrate(resolveModelForMode(this.settingsStore.get(), 'agent', [
      ...(this.providerAuth.credentials?.listProviderIds() ?? []),
      ...this.adapters.configuredProviderIds()
    ]))
  }

  /** The parent's workspace path a `shared` child observes, or null when the parent has none. */
  private sharedWorkspaceOf(parentThreadId: string): ThreadSession['sharedWorkspace'] {
    const parent = this.getOrCreateSession(parentThreadId)
    const path = parent.sharedWorkspace?.path ?? parent.workspace?.projectPath ?? parent.projectCwd
    return path ? { path, parentThreadId } : null
  }

  /**
   * Engine host callback (before the delegation transaction; synchronous): the child thread gets the
   * parent's project and model selection, or the requested provider/model.
   */
  private createChildThread(request: DelegationRequest): { threadId: string } {
    if (!this.threadStore) throw new Error('Delegation requires the thread store')
    const parentThread = this.threadStore.getThread(request.parentThreadId)
    if (!parentThread) throw new Error(`Thread not found: ${request.parentThreadId}`)
    const parent = this.getOrCreateSession(request.parentThreadId)
    const title = request.title?.trim() || `Delegated: ${request.prompt.trim().split('\n')[0].slice(0, 60)}`
    const inherited = this.adapters.instances.migrate(parent.modelOverride ?? undefined)
    const base = (): ModelOverride => inherited ?? this.defaultAgentModel()
    // The requested instance (already resolved by `delegateTask`) or the parent's. Resolved before the
    // thread exists, so an unknown instance fails loudly without leaving an orphaned thread.
    const override = request.instanceId || request.model
      ? this.adapters.instances.overrideFor({
          ...(request.instanceId ? { instanceId: request.instanceId } : { instanceId: base().instanceId, llmProvider: base().llmProvider }),
          model: request.model ?? base().model
        })
      : inherited
    // What the child runs on is fixed now: with no explicit selection it would otherwise follow the
    // global default (or the parent's session) at every later turn.
    const effective = override ?? this.defaultAgentModel()
    const model = effective.model?.trim() && (effective.instanceId?.trim() || effective.llmProvider?.trim()) ? structuredClone(effective) : undefined
    const shared = request.workspace === 'shared' ? this.sharedWorkspaceOf(request.parentThreadId) : null
    const child = this.threadStore.createThread(title, parentThread.projectId, undefined, {
      lineage: lineageForChild(parentThread),
      ownerThreadId: parentThread.id,
      workspaceBinding: { policy: request.workspace === 'shared' ? 'shared' : 'isolated', ...(shared ? { sharedPath: shared.path } : {}) },
      ...(model ? { modelOverride: model } : {})
    })
    const session = this.getOrCreateSession(child.id)
    session.modelOverride = model ? structuredClone(model) : undefined
    if (shared) session.sharedWorkspace = shared
    return { threadId: child.id }
  }

  /**
   * Engine host callback: the delegation or fork transaction that would have owned `threadId`
   * failed, so the thread `createThread` just made is removed with its in-memory session.
   */
  private discardCreatedThread(threadId: string): void {
    this.sessions.delete(threadId)
    this.threadStore?.discardUnusedThread(threadId)
  }

  /**
   * Issue #142: the policy every turn of a delegated child carries (first or resumed); undefined
   * for a thread that is not a subagent. A `shared` child is read-only.
   */
  private childTurnPolicy(session: ThreadSession): ChildTurnPolicy | undefined {
    if (session.sharedWorkspace) return { readOnly: true }
    try {
      return this.runEngine?.delegations.getLineage(session.threadId)?.relationship === 'subagent' ? { readOnly: false } : undefined
    } catch {
      return undefined
    }
  }

  /** Whether `threadId` is a read-only (`shared`) delegated child; its Mousse tools may not write threads. */
  private isReadOnlyChild(threadId: string): boolean {
    return Boolean(this.getOrCreateSession(threadId).sharedWorkspace)
  }

  /**
   * Issue #142 preflight, before any thread is created: a target whose provider cannot hold a
   * child to its policy gets a structured refusal instead of a child it could not keep read-only.
   * `instanceId` is the requested instance; without one the child runs on the parent's selection.
   */
  private async delegationRefusal(parentThreadId: string, instanceId: string | undefined, workspace: 'shared' | 'isolated') {
    let target: ReturnType<OrchestratorService['adapterForThread']>
    try {
      target = instanceId ? this.adapters.resolve(instanceId) : this.adapterForThread(parentThreadId)
    } catch {
      // An unresolvable target fails loudly when the child is created, as before.
      return null
    }
    const refusal = await this.targetRefusal(target, workspace, this.sharedWorkspaceOf(parentThreadId)?.path ?? null)
    return refusal ? { started: false as const, ...refusal } : null
  }

  /** The static check of the adapter's capabilities, then the adapter's look at the user's setup. */
  private async targetRefusal(
    target: ReturnType<OrchestratorService['adapterForThread']>,
    workspace: 'shared' | 'isolated',
    cwd: string | null
  ): Promise<SubagentRefusal | null> {
    return subagentTargetRefusal(target.adapter.capabilities, target.entry.driver, workspace)
      ?? await target.adapter.childPreflight?.({ workspace, cwd }) ?? null
  }

  /**
   * SPEC §14.2: a delegated child keeps the workspace policy its delegation recorded. A session
   * built from storage (after a restart, or once evicted) reads it back, so a `shared` read-only
   * child still observes its parent's workspace under `SHARED_READER_POLICY`.
   */
  private restoreDelegatedWorkspace(session: ThreadSession): void {
    const engine = this.runEngine
    if (!engine || session.sharedWorkspace) return
    try {
      const lineage = engine.delegations.getLineage(session.threadId)
      if (lineage?.relationship !== 'subagent') return
      // A child created with a recorded binding keeps exactly that; older children fall back to the
      // delegation row and the parent's current workspace.
      const binding = this.threadStore?.getThread(session.threadId)?.workspaceBinding
      if (binding) {
        if (binding.policy === 'shared' && binding.sharedPath) session.sharedWorkspace = { path: binding.sharedPath, parentThreadId: lineage.parentThreadId }
        return
      }
      const policy = engine.delegations.listForChildThread(session.threadId).filter((delegation) => delegation.workspace).at(-1)
      if (policy?.workspace === 'shared') session.sharedWorkspace = this.sharedWorkspaceOf(lineage.parentThreadId)
    } catch (error) {
      console.warn('delegated workspace policy could not be restored', {
        threadId: session.threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Engine host callback for `thread.fork` (SPEC §16.2; before the fork transaction): the fork gets
   * the source's project, worktree mode and model selection. Its context arrives lazily, with its
   * first message.
   */
  private createForkThread(creation: Extract<ThreadCreation, { kind: 'fork' }>): { threadId: string } {
    if (!this.threadStore) throw new Error('Thread forks require the thread store')
    const sourceThread = this.threadStore.getThread(creation.sourceThreadId)
    if (!sourceThread) throw new Error(`Thread not found: ${creation.sourceThreadId}`)
    const source = this.getOrCreateSession(creation.sourceThreadId)
    const title = creation.title?.trim() || `Fork of ${sourceThread.name}`.slice(0, 120)
    const fork = this.threadStore.createThread(title, sourceThread.projectId, undefined,
      sourceThread.worktreeEnabled === undefined ? undefined : { worktreeEnabled: sourceThread.worktreeEnabled })
    const override = this.adapters.instances.migrate(source.modelOverride ?? sourceThread.modelOverride)
    if (override) this.threadStore.updateThreadMeta(fork.id, { modelOverride: structuredClone(override) })
    const session = this.getOrCreateSession(fork.id)
    session.modelOverride = override ? structuredClone(override) : undefined
    return { threadId: fork.id }
  }

  /**
   * The thread's visible conversation as handoff items (SPEC §16.1), oldest first. Each item carries
   * the ordinal of the run it belongs to (from the message's `turnId`); messages before the first
   * known run have none. Markers, notes and hidden inputs are not conversation.
   */
  private handoffTranscript(threadId: string): HandoffItem[] {
    const engine = this.runEngine
    const items: HandoffItem[] = []
    let ordinal: number | null = null
    for (const message of this.getMessagesForPersistence(threadId)) {
      if (message.turnId) {
        const run = engine?.getRun(message.turnId)
        if (run && run.threadId === threadId) ordinal = run.ordinal
      }
      if (message.hidden || message.kind || (message.role !== 'user' && message.role !== 'assistant')) continue
      const text = message.content.trim()
      if (!text) continue
      items.push({
        runOrdinal: ordinal,
        role: message.role,
        text,
        ...(message.images?.length ? { attachments: { images: message.images.length } } : {})
      })
    }
    return items
  }

  /** The provider reference of the latest run before `runId` on the thread, when one was recorded. */
  private previousProviderRef(threadId: string, runId: string): ProviderRef | null {
    const engine = this.runEngine
    const current = engine?.getRun(runId)
    if (!engine || !current) return null
    for (const run of engine.listRuns(threadId)) {
      if (run.ordinal >= current.ordinal || !run.activeAttemptId) continue
      const ref = engine.store.getAttempt(run.activeAttemptId)?.providerRef
      if (ref) return ref
    }
    return null
  }

  /**
   * SPEC §16.1-§16.2: the handoffs this turn delivers. A pending fork transfer (the fork's first
   * message) resolves natively when the adapter can branch the source session, otherwise as a
   * `full_summary` of the source up to the fork point; otherwise a provider change since the
   * previous turn plans a switch handoff. A pending merge-back adds the fork's delta. Planning
   * failures are logged and the turn runs with its raw history.
   */
  private async planTurnHandoffs(input: {
    session: ThreadSession
    runId: string | undefined
    adapter: ProviderAdapter
    selection: { llmProvider: string; model: string }
    previousModel: { provider: string; model: string } | undefined
    promptRuntime: boolean
    content: string
    images: ChatImageAttachment[] | undefined
    mode: ChatMode
    modelOverride: ThreadSession['modelOverride']
  }): Promise<TurnHandoffs | null> {
    const engine = this.runEngine
    const runId = input.runId
    if (!engine || !runId) return null
    const threadId = input.session.threadId
    const to: ProviderRef = { provider: input.selection.llmProvider, model: input.selection.model }
    const caps = input.adapter.capabilities
    const current = { text: input.content, ...(input.images?.length ? { attachments: { images: input.images.length } } : {}) }
    const planned: PlannedHandoff[] = []
    try {
      const capacity = this.nativeContext.nativeProviderModel
      const modelWindow = input.promptRuntime
        ? capacity?.selectedModel === to.model ? capacity?.contextWindow : undefined
        : this.llm.getSelectedModelContextLimit(input.mode, input.modelOverride).limit
      // A transfer whose history an earlier (aborted) turn already committed is consumed, not resent.
      const inTranscript = committedTransfers(this.nativeContext.messages)
      const pendingTransfer = (transfer: TransferRecord | undefined | null): TransferRecord | null =>
        transfer && !this.consumeCommittedTransfer(transfer, inTranscript, runId) ? transfer : null
      const fork = pendingTransfer(engine.transfers.listPending(threadId, 'fork')[0])
      if (fork) {
        const sourceRun = engine.getRun(String(fork.payload.sourceRunId ?? ''))
        const sourceRef = sourceRun?.activeAttemptId ? engine.store.getAttempt(sourceRun.activeAttemptId)?.providerRef ?? null : null
        let branched: ProviderRef | null = null
        if (forkStrategy(caps) === 'native' && sourceRef?.sessionId && sourceRef.provider === to.provider && input.adapter.forkSession) {
          try {
            branched = await input.adapter.forkSession(sourceRef, fork.sourceRunOrdinal)
          } catch (error) {
            console.warn('native fork failed; using a portable handoff', { runId, error: error instanceof Error ? error.message : String(error) })
          }
        }
        planned.push(branched?.sessionId
          ? { kind: 'fork', transfer: fork, forkStrategy: 'native', plan: engine.handoffs.plan({ threadId, targetRunId: runId, from: branched, to: { ...to, sessionId: branched.sessionId }, caps }) }
          : {
              kind: 'fork',
              transfer: fork,
              forkStrategy: 'portable',
              plan: engine.handoffs.plan({
                threadId, targetRunId: runId, from: sourceRef, to, caps, current, modelWindow,
                sourceThreadId: fork.sourceThreadId, strategy: 'full_summary', throughOrdinal: fork.sourceRunOrdinal
              })
            })
      } else if (input.previousModel && input.previousModel.provider !== to.provider) {
        const from = this.previousProviderRef(threadId, runId) ?? { provider: input.previousModel.provider, model: input.previousModel.model }
        planned.push({ kind: 'switch', plan: engine.handoffs.plan({ threadId, targetRunId: runId, from, to, caps, current, modelWindow }) })
      }
      const merge = pendingTransfer(engine.pendingMergeBack(threadId))
      if (merge) {
        planned.push({
          kind: 'merge_back',
          transfer: merge,
          plan: engine.handoffs.plan({
            threadId, targetRunId: runId, from: null, to, caps, current, modelWindow,
            sourceThreadId: merge.sourceThreadId,
            strategy: 'fork_delta_summary',
            afterOrdinal: Number(merge.payload.fromOrdinal ?? 1) - 1,
            throughOrdinal: Number(merge.payload.toOrdinal ?? merge.sourceRunOrdinal),
            nativeTokens: input.promptRuntime ? 0 : estimateActiveContextTokens(getActiveMessages(this.nativeContext), getCompactionSummary(this.nativeContext))
          })
        })
      }
    } catch (error) {
      console.warn('run engine handoff planning failed; the turn keeps its raw history', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return planned.length ? new TurnHandoffs(engine, planned, !input.promptRuntime) : null
  }

  /**
   * Idempotent transfer delivery (SPEC §16.2): when the canonical transcript already holds a pending
   * transfer's marked history (a turn committed it, then the consume write was lost), the transfer
   * is consumed now instead of injected twice. True when it was.
   */
  private consumeCommittedTransfer(transfer: TransferRecord, inTranscript: ReadonlyMap<string, { handoffId: string }>, runId: string): boolean {
    const marker = inTranscript.get(transfer.transferId)
    if (!marker) return false
    const engine = this.requireRunEngine()
    try {
      const handoff = engine.handoffs.get(marker.handoffId)
      engine.transfers.setStatus({
        transferId: transfer.transferId,
        from: 'pending',
        to: 'consumed',
        payloadPatch: { handoffId: marker.handoffId, consumedBy: handoff?.targetRunId ?? runId, repairedBy: runId }
      })
    } catch (error) {
      console.warn('run engine transfer repair failed', { transferId: transfer.transferId, error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  /**
   * SPEC §16.2: a fork's first turn provisions the fork's own worktree at the source's code
   * checkpoint for the fork run, or at the source worktree's current HEAD when that run has none.
   * The seed is recorded on the fork transfer; failures are recorded and the fork provisions as usual.
   */
  /** The code checkpoint a source run left: its finished, non-conversation thread action. */
  private forkCheckpoint(sourceDir: string, sourceRunId: string) {
    return new ThreadActionService(sourceDir).list().find((action) => action.turnId === sourceRunId && action.scope !== 'conversation' && action.state !== 'running' && action.endSha)
  }

  /** SPEC §16.2 fork point (engine host): a source with a ready workspace needs a checkpoint at the run. */
  private forkPointSeed(sourceThreadId: string, sourceRunId: string): ForkPointSeed {
    const sourceDir = this.resolveThreadDir(sourceThreadId)
    if (!sourceDir) return 'none'
    if (new ThreadWorkspaceManager(sourceDir).load()?.lifecycle !== 'ready') return 'none'
    return this.forkCheckpoint(sourceDir, sourceRunId) ? 'checkpoint' : 'missing'
  }

  private async seedForkWorkspace(threadId: string, projectPath: string, threadDir: string, signal?: AbortSignal, lease?: ThreadSession['executionLease']): Promise<void> {
    const engine = this.runEngine
    const fork = engine?.transfers.listPending(threadId, 'fork')[0]
    if (!engine || !fork || fork.payload.seed) return
    const manager = new ThreadWorkspaceManager(threadDir)
    let seed: Record<string, unknown>
    try {
      if (manager.load()) seed = { kind: 'existing_workspace' }
      else if (!manager.resolveRepository(projectPath).capability.gitBacked) seed = { kind: 'not_git_backed' }
      else {
        const sourceDir = this.resolveThreadDir(fork.sourceThreadId)
        const sourceRunId = String(fork.payload.sourceRunId ?? '')
        const checkpoint = sourceDir ? this.forkCheckpoint(sourceDir, sourceRunId) : undefined
        const sourceWorkspace = sourceDir ? new ThreadWorkspaceManager(sourceDir).load() : undefined
        // M5: the source's current HEAD stands in for a missing checkpoint only when the fork
        // request accepted it (`seedFrom: 'current_head'`).
        const headAccepted = fork.payload.seedFrom === 'current_head'
        if (!checkpoint && sourceWorkspace?.lifecycle === 'ready' && !headAccepted)
          throw new Error('fork_point_unavailable: the fork point has no code checkpoint and the fork did not accept the current head')
        seed = checkpoint
          ? { kind: 'checkpoint', sha: checkpoint.endSha, actionId: checkpoint.id }
          : sourceWorkspace?.lifecycle === 'ready'
            ? { kind: 'source_head', sha: actionGit(sourceWorkspace.worktreePath, ['rev-parse', 'HEAD']) }
            : { kind: 'primary_head' }
        await manager.provision(threadId, 'main', projectPath, signal, lease ?? undefined, typeof seed.sha === 'string' ? seed.sha : undefined)
      }
    } catch (error) {
      seed = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      console.warn('fork workspace seed failed; the fork provisions from the primary checkout', { threadId, error: seed.error })
    }
    try {
      engine.transfers.patchPayload(fork.transferId, { seed })
    } catch (error) {
      console.warn('fork seed could not be recorded', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The transcript markers of this turn's handoffs (SPEC §16.1: "context rebuilt (N of M items)"):
   * the provider-switch marker gains the handoff artifact; a fork's first message and a merge-back
   * each get their own marker.
   */
  private recordHandoffMarkers(
    session: ThreadSession,
    handoffs: TurnHandoffs,
    switchMarker: ChatMessage | undefined,
    turnId: string,
    selection: { llmProvider: string; model: string }
  ): void {
    const to = { provider: selection.llmProvider, model: selection.model }
    for (const entry of handoffs.planned) {
      const { plan } = entry
      const artifact = {
        handoffId: plan.handoffId,
        strategy: plan.strategy,
        selectedItems: plan.record.selectedItems,
        omittedItems: plan.record.omittedItems
      }
      if (entry.kind === 'switch') {
        if (!switchMarker?.contextHandoff) continue
        switchMarker.contextHandoff = { ...switchMarker.contextHandoff, ...artifact }
        this.emitMessageUpdated(switchMarker)
        continue
      }
      const from = plan.record.fromRef
      const sourceName = this.threadStore?.getThread(plan.sourceThreadId)?.name ?? plan.sourceThreadId
      const marker: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        kind: 'context_handoff',
        content: entry.kind === 'fork' ? `Forked from ${sourceName}` : `Merged back from ${sourceName}`,
        contextHandoff: {
          from: { provider: from?.provider ?? to.provider, model: from?.model ?? to.model },
          to,
          ...artifact,
          transfer: entry.kind
        },
        timestamp: new Date().toISOString(),
        turnId
      }
      session.messages.push(marker)
      this.emitMessageAdded(marker)
    }
    this.persist(true)
  }

  /**
   * Working directories of other threads' live turns (SPEC §16.3 restore safety): a turn running in
   * a path a restore would rewrite makes that restore unsafe.
   */
  liveWorkspaceClaims(excludeThreadId?: string): Array<{ threadId: string; path: string; kind: 'live_cwd' }> {
    const claims: Array<{ threadId: string; path: string; kind: 'live_cwd' }> = []
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) {
      if (session.threadId === excludeThreadId || session.threadId === '__unbound__' || !session.isTurnRunning()) continue
      const path = session.sharedWorkspace?.path ?? session.projectCwd
      if (path) claims.push({ threadId: session.threadId, path, kind: 'live_cwd' })
    }
    return claims
  }

  /** SPEC §16.2: queueing on a thread waiting for a merge-back is refused until its next turn consumes it. */
  assertQueueOpen(threadId: string): void {
    const pending = this.runEngine?.pendingMergeBack(threadId)
    if (pending)
      throw new DomainRpcError('merge_back_pending', `A merge-back from fork ${pending.sourceThreadId} waits for this thread's next turn; send directly to deliver it.`, { transferId: pending.transferId })
  }

  /**
   * The delegation tools of one parent run (SPEC §14.2 `ToolHost`), shared by the in-process pi
   * loop and the Mousse MCP server so both enforce the caller's ceiling the same way (SPEC §15.1):
   * a `plan` caller cannot start a `default` child or integrate (integration writes the workspace).
   */
  private delegationTools(session: ThreadSession, parentRunId: string, callerCeiling?: ModeCeiling): DelegationToolHost {
    const parentThreadId = session.threadId
    const delegateTask = (input: DelegateTaskInput, call: DelegationToolCall) =>
      this.delegateTask(parentThreadId, parentRunId, input, call, callerCeiling)
    const continueSubagent = (input: { subagent: string; prompt: string }, call: DelegationToolCall) =>
      this.continueSubagent(parentThreadId, parentRunId, input, call, callerCeiling)
    const integrateDelegation = async (ref: SubagentRef, call: DelegationToolCall) => {
      if (this.isReadOnlyChild(parentThreadId))
        throw new McpToolError('mousse_read_only', 'Integration writes the workspace; a read-only subagent cannot integrate.')
      if (callerCeiling === 'plan')
        throw new McpToolError('mousse_ceiling_exceeded', 'Integration writes the workspace; a plan ceiling cannot integrate.')
      const task = this.resolveTask(parentThreadId, ref, 'finished')
      if (!task.ok) return task.refusal
      return this.integrateDelegation(parentThreadId, parentRunId, task.delegation.delegationId, call)
    }
    const listDelegations = () => this.listDelegations(parentThreadId)
    const named = (request: NamedAgentToolRequest): DelegateTaskInput => {
      const write = request.access === 'write'
      return {
        prompt: request.task,
        title: request.name,
        workspace: write ? 'isolated' : request.workspace ?? 'shared',
        role: write ? 'implement' : 'research',
        wake: 'always'
      }
    }
    return {
      delegateTask,
      continueSubagent,
      answerSubagent: (input) => this.answerSubagent(parentThreadId, input),
      taskStatus: (ref) => this.taskStatus(parentThreadId, ref),
      taskCancel: (ref) => this.taskCancel(parentThreadId, ref),
      listDelegations,
      listSubagents: () => this.listSubagents(parentThreadId),
      integrateDelegation,
      named: {
        create: async (request, call) => ({ name: request.name, ...(await delegateTask(named(request), call)) }),
        createBatch: async (requests, call) => {
          if (requests.length === 0 || requests.length > NAMED_BATCH_LIMIT)
            throw new Error(`Named batches start 1–${NAMED_BATCH_LIMIT} assignments`)
          const results: unknown[] = []
          for (const [index, request] of requests.entries()) {
            try {
              results.push({ name: request.name, ...(await delegateTask(named(request), { toolCallId: `${call.toolCallId}:${index}` })) })
            } catch (error) {
              results.push({ name: request.name, error: error instanceof Error ? error.message : String(error) })
            }
          }
          return { results }
        },
        // The older name for `continue_subagent`.
        recall: async (request, call) => ({ name: request.agent, ...(await continueSubagent({ subagent: request.agent, prompt: request.task }, call) as object) }),
        integrate: ({ agent }, call) => integrateDelegation({ subagent: agent }, call)
      }
    }
  }

  private async delegateTask(parentThreadId: string, parentRunId: string, input: DelegateTaskInput, call: DelegationToolCall, callerCeiling?: ModeCeiling) {
    const engine = this.requireRunEngine()
    if (!this.effectsEnabled()) throw new Error('Delegation needs the run engine worker')
    // SPEC §15.1: a child inherits its caller's ceiling and can never exceed it.
    if (callerCeiling === 'plan' && input.modeCeiling === 'default')
      throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot start a child with the default ceiling.')
    const modeCeiling = narrowCeiling(callerCeiling, input.modeCeiling)
    const role = input.role?.trim() || undefined
    if (input.workspace === 'shared' && !(role && SHARED_WORKSPACE_ROLES.has(role)))
      throw new Error('workspace "shared" is allowed only for read-only roles (role "research" or "review"); use workspace "isolated" for work that edits, builds or tests.')
    // SPEC §13.8: the child names an instance; an older `provider` name is mapped to one. An unknown
    // or disabled instance fails the tool call here, before any thread is created.
    const requested = input.instanceId?.trim() || input.provider?.trim()
    const instanceId = requested
      ? this.adapters.resolve(input.instanceId?.trim() || this.adapters.instances.instanceIdForLegacyProvider(requested)).instanceId
      : undefined
    // A read-only subagent may start subagents, but only read-only ones: authority only narrows down the tree.
    if (input.workspace !== 'shared' && this.isReadOnlyChild(parentThreadId))
      return { started: false as const, code: 'read_only_caller_requires_shared' as const, message: 'You are a read-only subagent, so your own subagents must be read-only too: start them with workspace "shared" and role "research" or "review".' }
    const refusal = await this.delegationRefusal(parentThreadId, instanceId, input.workspace)
    if (refusal) return refusal
    const title = input.title?.trim() || undefined
    let accepted: Awaited<ReturnType<RunEngine['requestDelegation']>>
    try {
      accepted = await engine.requestDelegation({
        parentThreadId,
        parentRunId,
        clientRequestId: delegationRequestKey(parentThreadId, parentRunId, call.toolCallId),
        prompt: input.prompt,
        instanceId,
        model: input.model?.trim() || undefined,
        role,
        workspace: input.workspace,
        wake: input.wake ?? 'always',
        title,
        ...(modeCeiling ? { modeCeiling } : {})
      })
    } catch (error) {
      // A retry already replayed its receipt; what is left is a title that belongs to another subagent.
      if (error instanceof TitleTakenRejection) return this.titleTakenValue(parentThreadId, error)
      if (error instanceof CommandRejection && error.reason === 'parent_stopping')
        return { started: false as const, code: 'parent_stopping' as const, message: error.message }
      throw error
    }
    return {
      delegationId: accepted.delegationId,
      childThreadId: accepted.childThreadId,
      childRunId: accepted.childRunId,
      title: this.titleOf(accepted.childThreadId) ?? title ?? null,
      ...(accepted.replayed ? { replayed: true } : {}),
      note: 'Started. Mousse sends you the result when it finishes; end your turn.'
    }
  }

  /** The value `delegate_task` returns when its title belongs to another of the caller's subagents. */
  private titleTakenValue(parentThreadId: string, taken: TitleTakenRejection) {
    const existing = taken.childThreadIds.map((childThreadId) => {
      const row = this.subagentView(parentThreadId).find((subagent) => subagent.childThreadId === childThreadId)
      return { childThreadId, title: this.titleOf(childThreadId) ?? taken.title, state: row?.state ?? 'unknown', latestDelegationId: row?.latestDelegationId ?? null }
    })
    return {
      started: false as const,
      code: 'title_taken' as const,
      title: taken.title,
      existing,
      message: `You already have a subagent titled "${taken.title}" (${existing[0]?.state ?? 'unknown'}). Use continue_subagent with that title to give it more work, or start a new subagent under a different title.`
    }
  }

  /** The rows of `subagents.list` for one thread: what each subagent is doing and how its tasks ended. */
  private subagentView(parentThreadId: string) {
    const engine = this.requireRunEngine()
    return buildSubagentView({
      delegations: engine.delegations,
      inbox: engine.inbox,
      store: engine.store,
      thread: (threadId) => this.threadStore?.getThread(threadId),
      hasPendingQuestion: (threadId) => this.questions.listPendingForThread(threadId).length > 0
    }, parentThreadId)
  }

  private titleOf(threadId: string): string | undefined {
    return this.threadStore?.getThread(threadId)?.name
  }

  private addressSources(): SubagentAddressSources {
    return { delegations: this.requireRunEngine().delegations, titleOf: (threadId) => this.titleOf(threadId) }
  }

  /** The caller's subagents holding `title`, normalized (engine host callback and the rename guard). */
  private subagentTitleConflicts(parentThreadId: string, title: string): string[] {
    return subagentsTitled(this.addressSources(), parentThreadId, title)
  }

  /**
   * Titles are the address of a subagent, so a rename may not give one subagent another's title.
   * Installed on the thread store; every rename path goes through it.
   */
  private installTitleGuard(): void {
    this.threadStore?.setNameGuard((thread, name) => {
      let lineage: ReturnType<RunEngine['delegations']['getLineage']> = null
      try {
        lineage = this.runEngine?.delegations.getLineage(thread.id) ?? null
      } catch {
        return
      }
      if (lineage?.relationship !== 'subagent') return
      const taken = this.subagentTitleConflicts(lineage.parentThreadId, name).filter((threadId) => threadId !== thread.id)
      if (taken.length)
        throw new DomainRpcError('title_taken', `Another subagent of the same thread is already titled "${name}".`, { title: name, threadIds: taken })
    })
  }

  /** `continue_subagent` and `answer_subagent` act only on the caller's own direct subagent. */
  private resolveSubagentTarget(parentThreadId: string, ref: string) {
    const resolved = resolveSubagent(this.addressSources(), parentThreadId, ref)
    return resolved.ok ? resolved : { ok: false as const, refusal: { started: false as const, code: resolved.code, message: resolved.message, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) } }
  }

  /**
   * `continue_subagent`: a follow-up on the subagent's own thread. It runs in the subagent's native
   * session (the thread, provider, model and workspace never change), so what it read stays warm.
   * The run and its delegation row are one transaction. A busy subagent runs the follow-up after its
   * current task; one waiting for an answer is never auto-rejected, the caller gets the question.
   */
  private async continueSubagent(
    parentThreadId: string,
    parentRunId: string,
    input: { subagent: string; prompt: string },
    call: DelegationToolCall,
    callerCeiling?: ModeCeiling
  ) {
    const engine = this.requireRunEngine()
    if (!this.effectsEnabled()) throw new Error('Delegation needs the run engine worker')
    const target = this.resolveSubagentTarget(parentThreadId, input.subagent)
    if (!target.ok) return target.refusal
    const childThreadId = target.childThreadId
    const requestId = followUpRequestKey(parentThreadId, parentRunId, call.toolCallId)
    // A retry of an accepted follow-up returns that task, whatever the subagent is doing now.
    const prior = engine.store.getReceipt(requestId)
    if (prior?.status === 'accepted' && prior.threadId === childThreadId) {
      const runId = String((prior.result as { runId?: unknown } | null)?.runId ?? '')
      const task = engine.delegations.getByChildRun(runId)
      if (task) return this.followUpValue(task, target.title, { replayed: true })
    }
    const pending = this.questions.listPendingForThread(childThreadId)
    if (pending.length)
      return {
        started: false as const,
        code: 'needs_answer' as const,
        subagent: target.title,
        childThreadId,
        questions: pending.map(({ requestId: id, questions }) => ({ requestId: id, questions })),
        message: `"${target.title}" is waiting for an answer, so it cannot take new work. Answer it with answer_subagent (or ask the user), then continue it.`
      }
    if (engine.getRun(parentRunId)?.outcome?.stopRequested)
      return { started: false as const, code: 'parent_stopping' as const, message: 'The calling run is being stopped; it cannot continue subagents.' }
    // The follow-up is bound by the subagent's own policy and the caller's authority, whichever is narrower.
    const first = engine.delegations.listForChildThread(childThreadId).find((task) => task.parentThreadId === parentThreadId)
    const modeCeiling = narrowCeiling(callerCeiling, first?.modeCeiling)
    let response: OrchestratorResponse
    try {
      response = await this.send({ content: input.prompt, mode: modeCeiling === 'plan' ? 'plan' : 'agent' }, false, {
        threadId: childThreadId,
        source: 'delegation',
        clientRequestId: requestId,
        awaitMode: 'ack',
        delegation: {
          parentThreadId,
          parentRunId,
          prompt: input.prompt,
          wake: 'always',
          ...(modeCeiling ? { modeCeiling } : {}),
          workspace: first?.workspace,
          role: first?.role,
          provider: first?.provider,
          model: first?.model
        }
      })
    } catch (error) {
      if (error instanceof CommandRejection && error.reason === 'parent_stopping')
        return { started: false as const, code: 'parent_stopping' as const, message: error.message }
      throw error
    }
    const task = response.runId ? engine.delegations.getByChildRun(response.runId) : null
    if (!task) throw new Error('The follow-up was not recorded as a task')
    return this.followUpValue(task, target.title, response.queued ? { queued: true } : {})
  }

  private followUpValue(task: DelegationRecord, title: string, extra: { queued?: boolean; replayed?: boolean }) {
    return {
      delegationId: task.delegationId,
      childThreadId: task.childThreadId,
      childRunId: task.childRunId,
      title,
      status: extra.queued ? 'queued' : 'started',
      ...(extra.replayed ? { replayed: true } : {}),
      note: extra.queued
        ? `"${title}" is busy; the follow-up runs after its current task. Mousse sends you the result; end your turn.`
        : 'Started. Mousse sends you the result when it finishes; end your turn.'
    }
  }

  /**
   * `answer_subagent`: the answer of a question one of the caller's subagents asked, in the shape the
   * GUI answers with. The request must be pending on that subagent's thread.
   */
  private answerSubagent(parentThreadId: string, input: { subagent: string; requestId: string; answers: Record<string, string | string[]> }) {
    const target = this.resolveSubagentTarget(parentThreadId, input.subagent)
    if (!target.ok) return { answered: false as const, ...target.refusal }
    const pending = this.questions.getPending(input.requestId)
    if (!pending || pending.threadId !== target.childThreadId)
      return {
        answered: false as const,
        code: 'no_such_question' as const,
        message: `"${target.title}" has no pending question ${input.requestId}; it may have been answered or dismissed already.`
      }
    if (!this.questions.submitAnswers(input.requestId, input.answers))
      return { answered: false as const, code: 'no_such_question' as const, message: `Question ${input.requestId} was answered or dismissed first.` }
    // As in the GUI: the model gets the answers as the tool result; the transcript shows what was said.
    this.recordQuestionResponseMessage(target.childThreadId, formatQuestionAnswersMessage(pending.questions, input.answers))
    return { answered: true as const, subagent: target.title, childThreadId: target.childThreadId, requestId: input.requestId }
  }

  private ownedDelegation(parentThreadId: string, delegationId: string): DelegationRecord {
    const delegation = this.requireRunEngine().delegations.get(delegationId)
    if (!delegation || delegation.parentThreadId !== parentThreadId)
      throw new Error(`Unknown delegation ${delegationId} for this thread`)
    return delegation
  }

  /**
   * The task a tool call names. A `delegationId` must be the caller's; a `subagent` is resolved to the
   * caller's direct subagent and its latest task (`finished`: its latest task that completed). A name that
   * resolves to nothing is a refusal value, not an error.
   */
  private resolveTask(parentThreadId: string, ref: SubagentRef, which: 'latest' | 'finished' = 'latest') {
    if (ref.delegationId) return { ok: true as const, delegation: this.ownedDelegation(parentThreadId, ref.delegationId) }
    const target = this.resolveSubagentTarget(parentThreadId, ref.subagent ?? '')
    if (!target.ok) return { ok: false as const, refusal: target.refusal }
    const tasks = this.requireRunEngine().delegations.listForChildThread(target.childThreadId).filter((task) => task.parentThreadId === parentThreadId)
    const pick = which === 'finished'
      ? tasks.filter((task) => (task.status === 'result_available' || task.status === 'acknowledged') && task.result?.runStatus === 'completed').at(-1)
      : tasks.at(-1)
    if (!pick)
      return { ok: false as const, refusal: { started: false as const, code: 'no_task' as const, message: which === 'finished' ? `"${target.title}" has no completed task to integrate yet.` : `"${target.title}" has no task.` } }
    return { ok: true as const, delegation: pick }
  }

  private taskStatus(parentThreadId: string, ref: SubagentRef) {
    const engine = this.requireRunEngine()
    const task = this.resolveTask(parentThreadId, ref)
    if (!task.ok) return task.refusal
    const delegationId = task.delegation.delegationId
    let delegation = task.delegation
    if (delegation.status === 'result_available' || delegation.status === 'failed') delegation = engine.acknowledgeDelegation(delegationId)
    const row = this.subagentView(parentThreadId).find((subagent) => subagent.childThreadId === delegation.childThreadId)
    const pending = this.questions.listPendingForThread(delegation.childThreadId)
    return {
      delegationId,
      childThreadId: delegation.childThreadId,
      title: this.titleOf(delegation.childThreadId) ?? null,
      status: delegation.status,
      childRunStatus: engine.getRun(delegation.childRunId)?.status ?? null,
      ...(row ? { state: row.state } : {}),
      // A task whose subagent is waiting on its own subagents is still `running`; it has no result yet.
      ...(row?.tasks.find((entry) => entry.delegationId === delegationId)?.outcome === 'waiting_for_subagents'
        ? { workState: 'waiting_for_subagents' as const, waitingOn: row.waitingOn }
        : {}),
      ...(pending.length ? { pendingQuestion: pending.map(({ requestId, questions }) => ({ requestId, questions })) } : {}),
      ...(delegation.result ? { result: delegation.result } : {})
    }
  }

  /**
   * `task_cancel` is a Stop of the subagent (`stopThread`): it ends the subagent's work and everything
   * the subagent started. The caller asked, so it gets no notice row for it. A task whose result the
   * caller has not read yet is the exception: naming it explicitly drops that result, as before.
   */
  private async taskCancel(parentThreadId: string, ref: SubagentRef) {
    const engine = this.requireRunEngine()
    if (ref.delegationId) {
      const task = this.ownedDelegation(parentThreadId, ref.delegationId)
      // A task that is still running stops its subagent. A cancelled one stops it again only while the run
      // that task started is still live (a repeat after a partial failure): once that run ended, whatever the
      // subagent does now is newer work (a follow-up) that a repeated cancel must not touch.
      if (task.status === 'running' || (task.status === 'cancelled' && this.isRunLive(task.childRunId))) {
        const stopped = await this.stopThread(task.childThreadId, 'task_cancel', { requesterThreadId: parentThreadId })
        return { delegationId: task.delegationId, status: engine.delegations.get(task.delegationId)?.status, cancelled: stopped.delegations }
      }
      if (task.status === 'cancelled') return { delegationId: task.delegationId, status: task.status, cancelled: [] }
      const cancelled = await engine.cancelDelegation(task.delegationId)
      return { delegationId: task.delegationId, status: engine.delegations.get(task.delegationId)?.status, cancelled }
    }
    // A subagent title cancels everything that subagent still has open.
    const target = this.resolveSubagentTarget(parentThreadId, ref.subagent ?? '')
    if (!target.ok) return target.refusal
    const tasks = engine.delegations.listForChildThread(target.childThreadId).filter((task) => task.parentThreadId === parentThreadId)
    const open = tasks.filter((task) => task.status === 'running')
    // Nothing is stopped when no task is open (a cancelled one whose run is still live is a repeat to finish).
    if (open.length === 0 && !tasks.some((task) => task.status === 'cancelled' && this.isRunLive(task.childRunId)))
      return { subagent: target.title, childThreadId: target.childThreadId, cancelled: [], note: `"${target.title}" has no open task.` }
    const stopped = await this.stopThread(target.childThreadId, 'task_cancel', { requesterThreadId: parentThreadId })
    return { subagent: target.title, childThreadId: target.childThreadId, cancelled: stopped.delegations }
  }

  private isRunLive(runId: string): boolean {
    const run = this.runEngine?.getRun(runId)
    return Boolean(run && !TERMINAL_RUN_STATUSES.has(run.status))
  }

  /**
   * Lineage's Stop all: a Stop of each subagent of `parentThreadId` that is still working, in one call. Each
   * one cascades to its own subagents; the parent's own turn keeps running (it is told, as for a row's Stop).
   */
  async stopSubagents(parentThreadId: string, reason = 'user'): Promise<{ ok: boolean; stopped: string[] }> {
    const running = this.subagentView(parentThreadId).filter(isRunningSubagent).map((row) => row.childThreadId)
    const outcomes = await Promise.all(running.map((childThreadId) => this.stopThread(childThreadId, reason)))
    return { ok: outcomes.some((outcome) => outcome.ok), stopped: running }
  }

  /** Cancels one of `parentThreadId`'s delegations and everything below it (host API and tests). */
  cancelDelegation(parentThreadId: string, delegationId: string) {
    return this.taskCancel(parentThreadId, { delegationId })
  }

  /** The delegations a thread made, oldest first. */
  listDelegations(parentThreadId: string) {
    const engine = this.requireRunEngine()
    return engine.delegations.listForParentThread(parentThreadId).map((delegation) => ({
      delegationId: delegation.delegationId,
      childThreadId: delegation.childThreadId,
      title: this.threadStore?.getThread(delegation.childThreadId)?.name ?? null,
      status: delegation.status,
      wake: delegation.wake,
      childRunStatus: engine.getRun(delegation.childRunId)?.status ?? null,
      createdAt: delegation.createdAt
    }))
  }

  /** `list_subagents`: one row per subagent, from the same read model the app shows. */
  private listSubagents(parentThreadId: string) {
    return this.subagentView(parentThreadId).map((row) => ({
      title: row.title,
      childThreadId: row.childThreadId,
      state: row.state,
      latestDelegationId: row.latestDelegationId,
      unread: row.unread,
      workspace: row.workspace,
      role: row.role,
      provider: row.provider,
      model: row.model
    }))
  }

  /**
   * `integrate_delegation` (SPEC §14.4): an `integration` run on the parent thread. It is queued
   * behind the calling turn (one active run per thread) and runs as its own `turn.start` effect;
   * its outcome is posted to the parent's inbox.
   */
  private async integrateDelegation(parentThreadId: string, parentRunId: string, delegationId: string, call: DelegationToolCall) {
    const engine = this.requireRunEngine()
    if (!this.effectsEnabled()) throw new Error('Integration needs the run engine worker')
    const delegation = this.ownedDelegation(parentThreadId, delegationId)
    if (delegation.status !== 'result_available' && delegation.status !== 'acknowledged')
      throw new Error(`Delegated task ${delegationId} is ${delegation.status}; only a finished task can integrate`)
    if (delegation.result?.runStatus !== 'completed')
      throw new Error(`Delegated task ${delegationId} ended ${delegation.result?.runStatus ?? 'without a result'}; only a completed task can integrate`)
    const result = await engine.dispatch({
      kind: 'send',
      threadId: parentThreadId,
      clientRequestId: `integration:${parentRunId}:${call.toolCallId}`,
      source: 'integration'
    })
    if (result.status !== 'accepted') throw new Error(result.reason)
    const payload: IntegrationTurnPayload = { kind: 'integration', threadId: parentThreadId, runId: result.runId, delegationId }
    engine.outbox.enqueue({ effectId: `effect:${result.runId}:turn.start:1`, threadId: parentThreadId, runId: result.runId, kind: 'turn.start', payload })
    return { delegationId, integrationRunId: result.runId, status: 'queued', note: 'The integration runs after this turn; Mousse notifies you of the outcome.' }
  }

  /**
   * An `integration` run (SPEC §14.4). Every step after the queued check, the run's own status
   * marks included, is inside the `try`: any failure ends the run `failed` and the parent learns of
   * it through an `integration_failed` notice in its inbox, never through a thrown effect.
   */
  private async executeIntegrationEffect(payload: IntegrationTurnPayload, signal: AbortSignal): Promise<void> {
    const engine = this.requireRunEngine()
    if (engine.getRun(payload.runId)?.status !== 'queued') return
    // The outcome is a row for this thread, written with the run's terminal state: the thread stays
    // busy until its model reads it, so a task waiting on this thread (it may be a subagent that
    // integrates its own subagent's work) never publishes an answer that predates the outcome.
    const outcomeRow = (text: string, type: 'integration_completed' | 'integration_failed') => ({
      kind: 'reconcile_notice' as const,
      payload: { type, delegationId: payload.delegationId, text }
    })
    // Success is the merge, not the run's terminal write: a run something else ended while the merge
    // was committing (a stop, the reconciler) cannot be marked completed, and the merge still happened.
    let merged: Awaited<ReturnType<OrchestratorService['integrateDelegationResult']>> | undefined
    let notice: string
    try {
      engine.markStarting(payload.runId)
      engine.markRunning(payload.runId)
      merged = await this.lifecycle.run('delegation-integration', () =>
        this.integrateDelegationResult(payload.threadId, payload.delegationId, payload.runId, AbortSignal.any([signal, this.lifecycle.signal])))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notice = `Integration of delegated task ${payload.delegationId} failed: ${message}`
      this.markRun(payload.runId, (runs, id) => {
        const run = runs.getRun(id)
        if (run && !TERMINAL_RUN_STATUSES.has(run.status)) runs.markTerminal(id, 'failed', { error: message }, { notice: outcomeRow(notice, 'integration_failed') })
      })
    }
    if (merged) {
      notice = `Integration of delegated task ${payload.delegationId} finished: merged ${merged.workerHeadSha.slice(0, 12)} as ${merged.integrationSha.slice(0, 12)} (${merged.changedPaths.length} path(s)).`
      try {
        engine.markTerminal(payload.runId, 'completed', undefined, { resultText: notice, notice: outcomeRow(notice, 'integration_completed') })
      } catch (error) {
        console.warn('integration run could not be marked completed; its merge stands', { runId: payload.runId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    try {
      const session = this.getOrCreateSession(payload.threadId)
      this.sessionAls.run(session, () => this.addSystemMessage(notice))
    } catch (error) {
      console.warn('integration notice could not reach the transcript', { runId: payload.runId, error: error instanceof Error ? error.message : String(error) })
    }
    this.settleIntegrationOutcome(payload, notice!, merged !== undefined)
  }

  /**
   * Makes sure the thread has exactly one right outcome row for an integration run. Normally the
   * terminal write has written it. A run something else ended while the merge was still going
   * (reconciler rule 2, boot) has an "interrupted before its outcome was known" row instead
   * (`writeTerminalRun`), and the merge may then have finished:
   * - the row is still `pending`: it is rewritten in place to the `integration_completed` outcome, in
   *   one write, so the thread never has two rows for one run and never reads the wrong one;
   * - it has been delivered or read already: its text cannot be taken back, so a short correction row
   *   follows, which is actionable and so keeps the thread busy until it has been read.
   * Residual: the thread may have read the interrupted row and the task waiting on it published
   * before the merge returned. That needs a reconciler interrupt in the middle of a live merge.
   * With no row at all (the terminal write failed for another reason) the outcome row is appended.
   */
  private settleIntegrationOutcome(payload: IntegrationTurnPayload, notice: string, merged: boolean): void {
    const engine = this.requireRunEngine()
    const outcomeRow = (text: string, type: 'integration_completed' | 'integration_failed') => ({
      kind: 'reconcile_notice' as const,
      payload: { type, delegationId: payload.delegationId, text }
    })
    engine.store.db.transaction(() => {
      const rows = engine.inbox.listForThread(payload.threadId).filter((row) => row.runId === payload.runId && row.kind === 'reconcile_notice')
      const typeOf = (row: InboxRecord): string => String((row.payload as { type?: unknown } | null)?.type)
      if (!merged) {
        if (!rows.some((row) => typeOf(row).startsWith('integration_')))
          engine.inbox.append({ threadId: payload.threadId, runId: payload.runId, ...outcomeRow(notice, 'integration_failed') })
        return
      }
      if (rows.some((row) => typeOf(row) === 'integration_completed')) return
      const interrupted = rows.find((row) => typeOf(row) === 'integration_failed' && (row.payload as { interrupted?: unknown }).interrupted === true)
      if (!interrupted) {
        engine.inbox.append({ threadId: payload.threadId, runId: payload.runId, ...outcomeRow(notice, 'integration_completed') })
      } else if (interrupted.status === 'pending') {
        engine.inbox.patchPayload(interrupted.inboxId, { type: 'integration_completed', text: notice, interrupted: null })
      } else {
        engine.inbox.append({
          threadId: payload.threadId,
          runId: payload.runId,
          ...outcomeRow(`The integration did finish, after the notice that it was interrupted: ${notice.replace(/^Integration of delegated task \S+ finished: /, '')}`, 'integration_completed')
        })
      }
    })
  }

  private async integrateDelegationResult(parentThreadId: string, delegationId: string, runId: string, signal: AbortSignal) {
    const delegation = this.requireRunEngine().delegations.get(delegationId)
    if (!delegation) throw new Error(`Unknown delegation ${delegationId}`)
    const parentDirectory = this.resolveThreadDir(parentThreadId)
    const childDirectory = this.resolveThreadDir(delegation.childThreadId)
    if (!parentDirectory || !childDirectory || !this.projectManager || !this.threadStore) throw new Error('Integration requires task workspaces')
    const child = new ThreadWorkspaceManager(childDirectory).load()
    if (!child || !existsSync(child.worktreePath)) throw new Error('The delegated task has no isolated workspace to integrate; shared and read-only tasks change nothing.')
    const project = resolveThreadProjectPath(this.projectManager, this.threadStore, parentThreadId)
    if (!project) throw new Error('Integration requires a task project')
    const lease = await waitAcquireExecutionLease(parentDirectory, { source: 'delegation-integration', signal })
    try {
      const target = await new WorkspaceResolver(parentDirectory, parentThreadId, project).resolve('agent', 'main', signal, lease)
      if (!target.capability.checkpointable) throw new Error('Integration requires an owned Git workspace')
      // The task's own checkpoint, not the worktree as it is now: the subagent may have worked on since.
      // The run whose text the task published (it can be a later run than the task's own, once the
      // subagent had waited on its own subagents), and the task's own run for a result that predates `runId`.
      const pinned = taskCheckpoint(new ThreadActionService(childDirectory).list(), delegation.result?.runId ?? delegation.childRunId)
      if (!pinned) throw new Error('The delegated task left no code checkpoint to integrate.')
      return await new ChildAgentIntegrationService(parentDirectory).integrate({
        agentId: delegation.childThreadId,
        operationId: `delegation-integration:${delegationId}:${pinned}`,
        actor: { kind: 'agent', id: delegation.childThreadId },
        workerWorktree: child.worktreePath,
        workerBranch: child.branch,
        spawnBaseSha: child.baseSha,
        expectedWorkerHead: pinned,
        pinnedWorkerSha: pinned,
        threadWorkspace: target.workspacePath,
        heldThreadLease: lease,
        signal,
        runId,
        externalEffects: [{ kind: 'unknown', reversible: false, description: 'The delegated thread may have performed external effects; integration reverses repository changes only.' }]
      })
    } finally {
      releaseExecutionLeaseHandle(lease)
    }
  }

  /**
   * A wake turn (reconciler rule 4): an ordinary visible turn whose prompt is the server-authored
   * notice for the thread's inbox rows. Rows already acknowledged are skipped; when none remain (or
   * the thread was deleted) the wake run ends `cancelled`. On a busy thread:
   * - another engine turn of the thread is waiting to start (its `turn.start` pending or claimed):
   *   the wake ends `cancelled` with its rows pending again, so that turn goes first and rule 4
   *   queues a new wake behind it;
   * - otherwise (a turn the engine does not schedule holds the thread) the wake stays `queued` and
   *   its effect is deferred `WAKE_BUSY_DEFER_MS` (C4: no cancel-and-recreate loop with rule 4,
   *   which skips threads that already have a queued wake).
   */
  private async executeWakeEffect(effect: EffectRecord, payload: WakeTurnPayload, signal: AbortSignal): Promise<void> {
    const engine = this.requireRunEngine()
    if (engine.getRun(payload.runId)?.status !== 'queued') return
    const rows = this.dropStaleQuestionRows(engine.inbox.getMany(payload.inboxIds).filter((row) => row.status !== 'acknowledged'))
    const session = this.getOrCreateSession(payload.threadId)
    const cancelWake = (restore: boolean): void => {
      engine.store.db.transaction(() => {
        engine.markTerminal(payload.runId, 'cancelled')
        if (restore && rows.length) engine.inbox.markPendingAgain(rows.map((row) => row.inboxId))
      })
    }
    if (engine.isFenced(payload.runId)) {
      // A Stop of this thread came after the wake was admitted: its notices belong to the work that was stopped.
      engine.store.db.transaction(() => {
        engine.markTerminal(payload.runId, 'cancelled', { interruptedBy: 'user' })
        engine.inbox.markAcknowledged(rows.map((row) => row.inboxId))
      })
      return
    }
    if (rows.length === 0 || session.deleted) {
      cancelWake(!session.deleted)
      return
    }
    if (session.turnAdmitted || session.isTurnRunning() || engine.getActiveRun(payload.threadId)) {
      const waiting = engine.outbox
        .listForThread(payload.threadId)
        .some((other) => other.kind === 'turn.start' && other.effectId !== effect.effectId && (other.status === 'pending' || other.status === 'running'))
      if (waiting) {
        cancelWake(true)
        return
      }
      throw new EffectDeferredError(this.wakeBusyDeferMs, 'thread_busy')
    }
    const notice = planWakeNotice(rows, this.noticeContext())
    engine.inbox.recordNoticeVisibility(rows, notice.items)
    try {
      await this.runTurnOnSession(
        session,
        { content: notice.text, mode: getLastUserChatMode(session.messages) ?? 'agent' },
        false,
        true,
        { source: 'wake', runId: payload.runId, externalSignal: signal, subagentNotice: notice.items }
      )
    } catch (error) {
      const run = engine.getRun(payload.runId)
      if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) throw error
    }
  }

  private requireRunEngine(): RunEngine {
    if (!this.runEngine) throw new Error('Run engine is unavailable')
    return this.runEngine
  }

  /**
   * queued -> starting for the turn about to call its provider. Unlike other bridge writes a
   * failure of any kind throws: the run was cancelled (a delegation cancel, a deleted thread),
   * already ended or is held elsewhere, so the turn must not run. The run keeps whatever state it
   * has; the caller's settlement records nothing over a terminal run.
   */
  private markRunStarting(runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    try {
      engine.markStarting(runId)
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'stale_write') this.staleRuns.add(runId)
      const status = engine.getRun(runId)?.status ?? 'missing'
      throw new Error(`Run ${runId} cannot start (${status}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Bridge writes never fail a user's turn. A stale epoch stops further writes for that run. */
  private markRun(runId: string | undefined, write: (engine: RunEngine, runId: string) => void): void {
    const engine = this.runEngine
    if (!engine || !runId || this.staleRuns.has(runId)) return
    try {
      write(engine, runId)
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'stale_write') {
        this.staleRuns.add(runId)
        console.warn('run engine stale write', { runId, error: error.message })
        return
      }
      console.warn('run engine write failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** SPEC §16.4: a continuation run opens with the run it continues. */
  private deliverContinuationNote(runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    try {
      const continued = engine.getRun(runId)?.outcome?.continuationOf
      const source = continued ? engine.getRun(continued) : null
      if (source) this.addSystemMessage(`Continuing run ${source.ordinal} after a restart.`)
    } catch (error) {
      console.warn('run engine continuation note failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** SPEC §12.5 step 5: the first turn after a daemon restart shows what was cut off, once. */
  private deliverRestartNote(threadId: string, runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    try {
      const note = engine.takeRestartNote(threadId, runId)
      if (note) this.addSystemMessage(formatRestartNote(note))
    } catch (error) {
      console.warn('run engine restart note failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * SPEC §12.6 tool ledger for an engine run: `started` before a tool runs, `committed|failed`
   * after. A ledger failure is logged and never breaks the tool.
   */
  private toolLedgerFor(runId: string | undefined): LlmChatOptions['toolLedger'] {
    const engine = this.runEngine
    if (!engine || !runId) return undefined
    const now = (): string => new Date().toISOString()
    const warn = (step: string, error: unknown): void => {
      console.warn(`run engine tool ledger ${step} failed`, { runId, error: error instanceof Error ? error.message : String(error) })
    }
    return {
      start: (call) => {
        try {
          const attemptId = engine.getRun(runId)?.activeAttemptId
          if (!attemptId) return undefined
          return engine.tools.start({
            invocationId: uuidv4(),
            runId,
            attemptId,
            tool: call.name,
            argsDigest: toolArgsDigest(call.arguments),
            now: now()
          }).invocationId
        } catch (error) {
          warn('start', error)
          return undefined
        }
      },
      commit: (id) => {
        try { engine.tools.commit(id, now()) } catch (error) { warn('commit', error) }
      },
      failed: (id) => {
        try { engine.tools.failed(id, now()) } catch (error) { warn('failed', error) }
      }
    }
  }

  /**
   * Safety net after a legacy turn returns or throws: a run handed to the turn must end terminal
   * unless the turn put it back on the queue (lease race / released claim keep the runId).
   */
  private settleRunAfterTurn(runId: string | undefined, requeued: boolean, failure: unknown): void {
    if (!runId) return
    this.markRun(runId, (engine, id) => {
      const run = engine.getRun(id)
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return
      if (run.status === 'queued' && requeued) return
      if (failure !== undefined) {
        engine.markTerminal(id, 'failed', { error: failure instanceof Error ? failure.message : String(failure) })
      } else {
        engine.markTerminal(id, 'completed')
      }
    })
    this.staleRuns.delete(runId)
  }

  /**
   * Queue items that leave the queue without running (removed, cleared, promoted to steer) end
   * their run `cancelled`. Only still-queued runs: a claimed item's run may already be starting.
   */
  private cancelQueuedRuns(runIds: Array<string | undefined>): void {
    for (const runId of runIds) {
      this.markRun(runId, (engine, id) => {
        if (engine.getRun(id)?.status !== 'queued') return
        engine.markTerminal(id, 'cancelled', { interruptedBy: 'user' })
      })
    }
  }

  /** Pre-upgrade queue items carry no runId; give them one before they run. */
  private async ensureQueueItemRun(item: QueuedMessage): Promise<string | undefined> {
    if (item.runId || !this.runEngine) return item.runId
    try {
      const result = await this.runEngine.dispatch({
        kind: 'send',
        threadId: item.threadId,
        clientRequestId: `queue:${item.id}`,
        source: item.source ?? 'queue'
      })
      return result.status === 'accepted' ? result.runId : undefined
    } catch (error) {
      console.warn('run engine could not record a queued item', { queueItemId: item.id, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  setFeatureFlags(flags: MousseFeatureFlags): void {
    this.featureFlags = { ...DEFAULT_FEATURE_FLAGS, ...flags }
  }

  setRuntimeManager(
    manager: import('../runtime/ThreadRuntimeManager').ThreadRuntimeManager | null
  ): void {
    this.runtimeManager = manager
  }

  /** Public access to session agents for a thread (hydrates via runtime manager when present). */
  getAgentsForThread(threadId: string): AgentRegistry {
    if (this.runtimeManager) {
      return this.runtimeManager.getOrHydrate(threadId).agents
    }
    return this.getOrCreateSession(threadId).agents
  }

  getTasksForThread(threadId: string): TaskQueue {
    if (this.runtimeManager) {
      return this.runtimeManager.getOrHydrate(threadId).tasks
    }
    return this.getOrCreateSession(threadId).tasks
  }

  private persist(immediate = false): void {
    const threadId = this.session.threadId === '__unbound__' ? null : this.session.threadId
    const timerKey = threadId ?? '__unbound__'
    if (immediate) {
      const existing = this.persistTimers.get(timerKey)
      if (existing) {
        clearTimeout(existing)
        this.persistTimers.delete(timerKey)
      }
      this.persistFn?.(threadId)
      return
    }

    if (this.persistTimers.has(timerKey)) return
    const timer = setTimeout(() => {
      this.persistTimers.delete(timerKey)
      this.persistFn?.(threadId)
    }, 500)
    this.persistTimers.set(timerKey, timer)
  }

  /** Reload durable queue into the session under the mutation lock. */
  private refreshSessionQueueFromDisk(session: ThreadSession): void {
    if (!this.threadStore || session.threadId === '__unbound__') return
    try {
      if (!this.threadStore.getThread(session.threadId)) return
      session.queue = readDurableQueue(this.threadStore, session.threadId)
    } catch {
      // ignore
    }
  }

  private resolveThreadDir(threadId: string): string | null {
    if (!this.threadStore) return null
    try {
      return this.threadStore.getThreadDir(threadId)
    } catch {
      return null
    }
  }

  /**
   * True when a live peer process owns this thread's execution lease.
   * Used to enqueue instead of starting a second concurrent turn.
   */
  isThreadLeaseHeldExternally(threadId: string, selfToken?: string): boolean {
    const threadDir = this.resolveThreadDir(threadId)
    if (!threadDir) return false
    return isLeaseHeldByLivePeer(threadDir, selfToken).held
  }

  /**
   * Best-effort safe reclaim of a dead owner's execution lease before
   * queue/held decisions. Never touches a live owner (ownership-checked).
   * Without this, a daemon restart that left an execution.lease behind makes
   * every new prompt enqueue behind a ghost owner with nothing draining it.
   */
  private reclaimStaleThreadLease(threadId: string): void {
    const threadDir = this.resolveThreadDir(threadId)
    if (!threadDir) return
    try {
      tryReclaimStaleLease(threadDir)
    } catch {
      // best-effort only; held-check below decides queue vs run
    }
  }

  /**
   * Persist a steer-intent item for the active external owner to drain once.
   * Does not run as a later normal message.
   */
  enqueueExternalSteer(
    threadId: string,
    text: string,
    opts?: { source?: string }
  ): QueuedMessage | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (this.threadStore && !this.threadStore.getThread(threadId)) return null
    return this.enqueueForThread(
      threadId,
      { content: trimmed },
      { source: opts?.source ?? 'cli-steer', intent: 'steer' }
    )
  }

  /**
   * Ensure a session exists for threadId (loaded from disk if needed).
   * Does not change the bound GUI session unless threadId matches bound.
   */
  /**
   * Attach multi-tenant registries to an existing session (no create).
   * Used by ThreadRuntimeManager to avoid getOrCreateSession recursion.
   */
  bindRuntimeRegistries(
    threadId: string,
    agents: AgentRegistry,
    tasks: TaskQueue
  ): void {
    if (this.boundSession.threadId === threadId) {
      this.boundSession.agents = agents
      this.boundSession.tasks = tasks
      return
    }
    const session = this.sessions.get(threadId)
    if (session) {
      session.agents = agents
      session.tasks = tasks
    }
  }

  getOrCreateSession(threadId: string): ThreadSession {
    if (this.threadStore?.lifecycleStore?.get(threadId)) this.threadStore.assertThreadAdmission(threadId)
    if (this.boundSession.threadId === threadId) {
      if (this.runtimeManager && this.boundSession.threadId !== '__unbound__') {
        const rt = this.runtimeManager.getOrHydrate(threadId)
        this.boundSession.agents = rt.agents
        this.boundSession.tasks = rt.tasks
      }
      return this.boundSession
    }
    let session = this.sessions.get(threadId)
    if (session) {
      if (this.runtimeManager) {
        const rt = this.runtimeManager.getOrHydrate(threadId)
        session.agents = rt.agents
        session.tasks = rt.tasks
      }
      return session
    }
    session = new ThreadSession(threadId)
    if (this.threadStore?.getThread(threadId)) {
      const data = this.threadStore.loadThreadData(threadId)
      this.recoverApplets(threadId, data.messages)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        this.adapters.instances.migrate(this.threadStore.getThread(threadId)?.modelOverride)
      )
      if (this.projectManager) {
        const projectPath = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
        session.projectCwd = resolveProjectWorkingDirectory(projectPath)
      }
    }
    // Hydrate runtime after session is registered to avoid re-entrant create.
    this.sessions.set(threadId, session)
    this.restoreDelegatedWorkspace(session)
    if (this.runtimeManager) {
      const rt = this.runtimeManager.getOrHydrate(threadId)
      session.agents = rt.agents
      session.tasks = rt.tasks
    }
    return session
  }

  /** Return the durable model override for one thread, if configured. */
  getThreadModelOverride(threadId: string): ThreadSession['modelOverride'] {
    return this.getOrCreateSession(threadId).modelOverride
  }

  /** Set one thread's model without mutating global provider settings. */
  setThreadModelOverride(
    threadId: string,
    override: ThreadSession['modelOverride'] | undefined
  ): ThreadSession['modelOverride'] {
    const session = this.getOrCreateSession(threadId)
    // Stored in the instance shape (SPEC §13.8); callers that still pass an `llmProvider` are mapped.
    const next = this.adapters.instances.migrate(override)
    const instanceKey = (selection: ModelOverride | undefined) => {
      const migrated = this.adapters.instances.migrate(selection)
      return migrated?.instanceId ?? migrated?.llmProvider
    }
    const switched = instanceKey(session.modelOverride) !== instanceKey(next)
    // SPEC §16.1: one provider switch at a time; a pending handoff must be delivered or fail first.
    const pending = switched ? this.runEngine?.handoffs.pendingForThread(threadId) : null
    if (pending)
      throw new DomainRpcError('handoff_pending', `Thread ${threadId} is still handing its context to ${pending.toRef.provider}; switch providers after that turn.`, { handoffId: pending.handoffId })
    session.modelOverride = next ? structuredClone(next) : undefined
    if (this.threadStore) {
      this.threadStore.updateThreadMeta(threadId, { modelOverride: session.modelOverride })
    }
    // SPEC §15.1: a credential belongs to a thread and provider instance; a switch revokes it.
    if (switched) this.revokeMcp(threadId)
    return session.modelOverride
  }

  /** Bind the GUI/CLI active session to a thread (call on thread switch). */
  bindThread(
    threadId: string,
    messages: ChatMessage[],
    nativeContext?: NativeLlmContext,
    queue?: QueuedMessage[]
  ): void {
    // Preserve an in-flight background session for the previous bound thread.
    if (
      this.boundSession.threadId !== '__unbound__' &&
      this.boundSession.threadId !== threadId &&
      this.boundSession.isTurnRunning()
    ) {
      this.sessions.set(this.boundSession.threadId, this.boundSession)
    }

    const existing = this.sessions.get(threadId)
    if (existing) {
      this.boundSession = existing
      this.sessions.delete(threadId)
    } else {
      this.boundSession = new ThreadSession(threadId)
      this.boundSession.load(
        messages,
        nativeContext ?? migrateLegacyContext(messages),
        queue ?? (this.threadStore ? this.threadStore.loadMessageQueue(threadId) : []),
        undefined,
        undefined,
        this.adapters.instances.migrate(this.threadStore?.getThread(threadId)?.modelOverride)
      )
    }

    this.recoverApplets(threadId, this.boundSession.messages)

    if (this.projectManager && this.threadStore) {
      try {
        const projectPath = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
        this.boundSession.projectCwd = resolveProjectWorkingDirectory(projectPath)
        this.worktrees.setRepoRoot(this.boundSession.projectCwd)
      } catch {
        // Project may be unavailable.
      }
    }
  }

  /** Snapshot bound session messages/context/queue for the given thread id. */
  getBoundThreadId(): string | null {
    return this.boundSession.threadId === '__unbound__' ? null : this.boundSession.threadId
  }

  /**
   * Mark thread deleted so pending work will not execute. Deleting is a Stop of the thread and every
   * subagent below it (`stopThread`, H7), queue included; the live turn is aborted here and its MCP
   * credentials revoked.
   */
  markThreadDeleted(threadId: string): void {
    this.revokeMcp(threadId)
    if (this.runEngine)
      void this.stopThread(threadId, 'thread_deleted', { clearQueue: true }).catch((error: unknown) => {
        console.warn('a deleted thread\'s work could not be stopped', { threadId, error: error instanceof Error ? error.message : String(error) })
      })
    const session = this.sessions.get(threadId)
    if (session) {
      session.deleted = true
      if (session.activeTurn && !session.activeTurn.abort.signal.aborted) {
        session.activeTurn.pendingSteer = []
        session.activeTurn.promotedSteerIds = []
        session.activeTurn.abort.abort()
      }
      session.queue = []
    }
    if (this.boundSession.threadId === threadId) {
      this.boundSession.deleted = true
      if (this.boundSession.activeTurn && !this.boundSession.activeTurn.abort.signal.aborted) {
        this.boundSession.activeTurn.pendingSteer = []
        this.boundSession.activeTurn.promotedSteerIds = []
        this.boundSession.activeTurn.abort.abort()
      }
      this.boundSession.queue = []
    }
    try {
      this.threadStore?.saveMessageQueue(threadId, [])
    } catch {
      // deleted on disk already
    }
    this.emitQueueUpdated(threadId, [])
    this.setTurnPhase(threadId, 'idle')
    this.turnStates.delete(threadId)
  }

  /** A restored task starts from durable conversation state without replaying old work. */
  markThreadRestored(threadId: string): void {
    this.sessions.delete(threadId)
    if (this.boundSession.threadId === threadId) this.boundSession = new ThreadSession('__unbound__')
    this.turnStates.delete(threadId)
  }

  loadMessages(messages: ChatMessage[], nativeContext?: NativeLlmContext, queue?: QueuedMessage[]): void {
    this.boundSession.load(
      messages,
      nativeContext ?? migrateLegacyContext(messages),
      queue
    )
  }

  /** Reattach only bundles already durably published by this exact completed turn. */
  private recoverApplets(threadId: string, messages: ChatMessage[]): void {
    if (!this.appletStore || !this.threadStore) return
    const recovered = new Map<string, NonNullable<ChatMessage['presentationParts']>>()
    for (const message of messages) {
      if (message.role !== 'assistant' || message.presentationParts || !message.turnId || message.incomplete || message.streaming) continue
      const parts = recoverAppletPresentation(this.appletStore, {threadId,messageId:message.id,turnId:message.turnId,content:message.content})
      if (parts) { message.presentationParts = parts; recovered.set(message.id, parts) }
    }
    if (recovered.size) this.threadStore.mutateThreadData(threadId, current => ({messages: current.messages.map(message => {
      const parts = recovered.get(message.id)
      const original = messages.find(candidate => candidate.id === message.id)
      return parts && !message.presentationParts && message.content === original?.content && message.turnId === original?.turnId ? {...message, presentationParts: parts} : message
    })}))
  }

  getMessages(threadId?: string): ChatMessage[] {
    return this.getMessagesForPersistence(threadId).filter((message) => !message.hidden)
  }

  /** Full durable transcript, including hidden internal queue inputs used for claim provenance. */
  getMessagesForPersistence(threadId?: string): ChatMessage[] {
    const messages =
      !threadId || threadId === this.boundSession.threadId
        ? this.boundSession.messages
        : this.getOrCreateSession(threadId).messages
    return [...messages]
  }

  getMessageQueue(threadId?: string): QueuedMessage[] {
    const id = threadId ?? this.getBoundThreadId()
    if (!id) return []
    return listPendingQueue(this.getOrCreateSession(id).queue).filter((item) => !item.internal)
  }

  listQueue(threadId: string): QueuedMessage[] {
    return this.getMessageQueue(threadId)
  }

  private emitQueueUpdated(threadId: string, items: QueuedMessage[]): void {
    const pending = listPendingQueue(items).filter((item) => !item.internal)
    this.emit('queue-updated', { threadId, items: pending })
  }

  private emitThreadMessages(threadId: string, messages: ChatMessage[], replace = false): void {
    const visible = messages.filter((message) => !message.hidden)
    this.emit('thread-messages', { threadId, messages: [...visible], ...(replace ? { replace: true } : {}) })
    // Legacy unscoped mirror only for the GUI-bound (selected) thread.
    if (threadId === this.boundSession.threadId) {
      this.emit('messages-sync', [...visible])
    }
  }

  /** Always emit thread-scoped add; legacy `message` only for the bound session. */
  private emitMessageAdded(message: ChatMessage): void {
    const threadId = this.session.threadId
    this.emit('thread-message', { threadId, message })
    if (threadId === this.boundSession.threadId) {
      this.emit('message', message)
    }
  }

  /** Always emit thread-scoped update; legacy `message-updated` only for the bound session. */
  private emitMessageUpdated(message: ChatMessage): void {
    const threadId = this.session.threadId
    this.emit('thread-message-updated', { threadId, message })
    if (threadId === this.boundSession.threadId) {
      this.emit('message-updated', message)
    }
  }

  /**
   * Queues a message and makes sure it runs: after the current turn settles (whoever owns it,
   * including a channel or remote turn that suppresses its own drain), or now when the thread is idle.
   */
  enqueueAndDrain(threadId: string, input: OrchestratorSendInput, source: string): QueuedMessage {
    this.assertQueueOpen(threadId)
    const item = this.enqueueForThread(threadId, input, { source })
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning() || session.turnAdmitted) session.drainAfterSettle = true
    else this.scheduleQueueDrain(session)
    return item
  }

  enqueueForThread(
    threadId: string,
    input: OrchestratorSendInput,
    opts?: { source?: string; intent?: 'normal' | 'steer'; internal?: boolean; runId?: string; inboxIds?: string[]; subagentNotice?: SubagentNoticeItem[]; stopGeneration?: number }
  ): QueuedMessage {
    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new QueueValidationError(`Thread not found: ${threadId}`)
    }
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new QueueValidationError(`Thread deleted: ${threadId}`)
    }
    // User-queued first messages leave drafts so the sidebar keeps them. Internal wakes do not.
    if ((opts?.intent ?? 'normal') === 'normal' && !opts?.internal) {
      this.touchUserActivityAndNotify(threadId)
    }
    const request = normalizeSendRequest(input)
    // Work that starts on behalf of a parent remembers the Stop generation it was queued at (the Stop fence).
    const stopGeneration = opts?.stopGeneration ?? (this.runEngine && isFencedSource(opts?.source) ? currentStopGeneration(this.runEngine.store, threadId) : undefined)
    let item: QueuedMessage
    if (this.threadStore) {
      // Cross-process RMW: load disk, enqueue, save under mutation lock.
      const next = mutateDurableQueue(this.threadStore, threadId, (diskItems) => {
        const result = enqueueMessage(diskItems, {
          threadId,
          content: request.content,
          workflowInvocationId: request.workflowInvocationId,
          mode: request.mode,
          images: request.images,
          intent: opts?.intent ?? 'normal',
          source: opts?.source,
          internal: opts?.internal,
          runId: opts?.runId,
          inboxIds: opts?.inboxIds,
          subagentNotice: opts?.subagentNotice,
          stopGeneration
        })
        item = result.item
        return result.items
      })
      session.queue = next
      this.emitQueueUpdated(threadId, session.queue)
      return item!
    }
    const result = enqueueMessage(session.queue, {
      threadId,
      content: request.content,
      workflowInvocationId: request.workflowInvocationId,
      mode: request.mode,
      images: request.images,
      intent: opts?.intent ?? 'normal',
      source: opts?.source,
      internal: opts?.internal,
      runId: opts?.runId,
      inboxIds: opts?.inboxIds,
      subagentNotice: opts?.subagentNotice,
      stopGeneration
    })
    session.queue = result.items
    item = result.item
    this.emitQueueUpdated(threadId, session.queue)
    return item
  }

  removeQueuedItem(threadId: string, itemId: string): QueuedMessage | null {
    const session = this.getOrCreateSession(threadId)
    let removed: QueuedMessage | null = null
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, (diskItems) => {
        const result = removeQueuedMessage(diskItems, itemId)
        if (result.removed?.workflowInvocationId) this.workflowChat?.abandon(result.removed.workflowInvocationId, threadId)
        removed = result.removed
        // Before the removal is saved: a crash in between leaves an item that finds it owns no rows and is skipped.
        this.releaseQueuedRows([result.removed])
        return result.items
      })
    } else {
      const result = removeQueuedMessage(session.queue, itemId)
      if (result.removed?.workflowInvocationId) this.workflowChat?.abandon(result.removed.workflowInvocationId, threadId)
      this.releaseQueuedRows([result.removed])
      session.queue = result.items
      removed = result.removed
    }
    this.emitQueueUpdated(threadId, session.queue)
    this.cancelQueuedRuns([(removed as QueuedMessage | null)?.runId])
    return removed
  }

  reorderQueue(threadId: string, orderedIds: string[]): QueuedMessage[] {
    const session = this.getOrCreateSession(threadId)
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, (diskItems) =>
        reorderQueuedMessages(diskItems, orderedIds)
      )
    } else {
      session.queue = reorderQueuedMessages(session.queue, orderedIds)
    }
    this.emitQueueUpdated(threadId, session.queue)
    return listPendingQueue(session.queue)
  }

  /**
   * Promote a queued item to steer the active turn on this thread.
   * When accepted, the item stays in the queue as steering until the turn's
   * steer drain consumes its content exactly once; it is never drained as a
   * later normal turn. If the turn ends without draining, the item is
   * demoted back to normal pending instead of being dropped.
   */
  promoteQueueItemToSteer(threadId: string, itemId: string): boolean {
    const session = this.getOrCreateSession(threadId)
    if (session.queue.find((entry) => entry.id === itemId)?.inboxIds?.length)
      throw new QueueValidationError('A queued subagent result is delivered as its own turn; it cannot be sent as a steer.')
    const localActive = session.isTurnActive() || this.isChannelTurnActive(threadId)
    const externalActive = this.isThreadLeaseHeldExternally(
      threadId,
      session.executionLease?.owner.token
    )
    if (!localActive && !externalActive) {
      throw new QueueValidationError('No active turn to steer on this thread.')
    }
    let item: QueuedMessage
    let promotedRunId: string | undefined
    // A steer joins the active run, so the promoted item no longer owns a run of its own.
    const promote = (items: QueuedMessage[]): QueuedMessage[] => {
      // A queued result notice is rebuilt when it runs and owns its rows; its stale text must not be sent as a steer.
      if (items.find((entry) => entry.id === itemId)?.inboxIds?.length)
        throw new QueueValidationError('A queued subagent result is delivered as its own turn; it cannot be sent as a steer.')
      const result = promoteQueuedMessageToSteer(items, itemId)
      promotedRunId = result.item.runId
      if (!promotedRunId) {
        item = result.item
        return result.items
      }
      const { runId: _runId, ...steer } = result.item
      item = steer
      return result.items.map((entry) => (entry.id === steer.id ? steer : entry))
    }
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, promote)
    } else {
      session.queue = promote(session.queue)
    }
    this.cancelQueuedRuns([promotedRunId])
    if (
      !localActive &&
      externalActive &&
      this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)
    ) {
      this.emitQueueUpdated(threadId, session.queue)
      return true
    }

    const steered = this.steerThread(threadId, item!.content)
    if (steered) {
      // Keep the item queued as steering until the turn's steer drain consumes
      // its content. Dropping here would lose the message when the turn is
      // aborted (which discards pendingSteer) before the next drain.
      const localTurn =
        session.activeTurn && !session.activeTurn.abort.signal.aborted
          ? session.activeTurn
          : null
      const channelTurn = localTurn ? null : this.channelTurns.get(threadId) ?? null
      const tracker = localTurn ?? (channelTurn && !channelTurn.abort.signal.aborted ? channelTurn : null)
      if (tracker) {
        tracker.promotedSteerIds ??= []
        if (!tracker.promotedSteerIds.includes(item!.id)) {
          tracker.promotedSteerIds.push(item!.id)
        }
      }
      this.emitQueueUpdated(threadId, session.queue)
      return true
    }
    // Revert promotion if steer was rejected.
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, (disk) =>
        disk.map((entry) =>
          entry.id === item!.id
            ? { ...entry, intent: 'normal' as const, state: 'pending' as const }
            : entry
        )
      )
    } else {
      session.queue = session.queue.map((entry) =>
        entry.id === item!.id ? { ...entry, intent: 'normal', state: 'pending' } : entry
      )
    }
    this.emitQueueUpdated(threadId, session.queue)
    return false
  }

  async generateThreadTitle(messages: ChatMessage[], threadId?: string): Promise<string> {
    const firstUser = messages.find((message) => message.role === 'user' && message.content.trim())
    const firstAssistant = messages.find(
      (message) => message.role === 'assistant' && !message.streaming && message.content.trim()
    )
    if (!firstUser) {
      throw new Error('A user message is required to generate a title.')
    }
    const heuristic =
      firstUser.content.trim().split('\n')[0]?.trim().slice(0, 60).slice(0, 80) || 'New Chat'
    const titleSettings = this.settingsStore.get().title
    const hasExplicitTitleModel = Boolean(titleSettings.llmProvider?.trim() && titleSettings.model?.trim())
    if (!hasExplicitTitleModel) {
      return heuristic
    }
    try {
      return await this.llm.generateTitle(firstUser.content, firstAssistant?.content, threadId)
    } catch {
      return heuristic
    }
  }

  /**
   * Promote a draft into a sidebar-visible thread as soon as the user commits
   * the first send. Title generation is often slow; without this, switching away
   * mid-title leaves the thread filtered out until a rename arrives.
   */
  private markThreadStartedAndNotify(threadId: string): void {
    if (!this.threadStore || threadId === '__unbound__') return
    try {
      const result = this.threadStore.markThreadStarted(threadId)
      if (result?.newlyStarted) {
        this.emit('thread-started', { threadId, thread: result.thread })
      }
    } catch {
      // Best-effort: message persistence still sets startedAt later.
    }
  }

  /**
   * User send/enqueue: reveal the draft and move it to the top of its group.
   * Agent streaming and internal wakes must not call this.
   */
  private touchUserActivityAndNotify(threadId: string): void {
    if (!this.threadStore || threadId === '__unbound__') return
    try {
      const result = this.threadStore.touchThreadUserActivity(threadId)
      if (result?.newlyStarted) {
        this.emit('thread-started', { threadId, thread: result.thread })
      }
    } catch {
      // Best-effort: message persistence still sets startedAt later.
    }
  }

  /**
   * Name a newly-created thread before its first turn starts. This is deliberately
   * awaited by executeTurn: title generation must not race the first response (or
   * leave the sidebar showing "New Chat" after the turn has already begun).
   *
   * Title generation is best-effort. A missing/unconfigured title provider must not
   * prevent the user's actual message from being sent; the awaited call still makes
   * successful title generation deterministic and visible before the turn runs.
   */
  private async generateInitialThreadTitleForThread(
    threadId: string,
    userContent: string
  ): Promise<void> {
    if (!this.threadStore || threadId === '__unbound__') return

    const thread = this.threadStore.getThread(threadId)
    // Keep retrying while the auto-created label remains. This recovers from a
    // transient title-provider failure on the next send without renaming user titles.
    if (!thread || !isDefaultThreadName(thread.name)) return

    const titleSettings = this.settingsStore.get().title
    const hasExplicitTitleModel = Boolean(titleSettings.llmProvider?.trim() && titleSettings.model?.trim())
    const heuristic = (userContent.trim().split('\n')[0]?.trim().slice(0, 60) || 'New Chat').slice(0, 80)
    if (!hasExplicitTitleModel) {
      if (!heuristic || isDefaultThreadName(heuristic)) return
      const updated = this.threadStore.updateThreadMeta(threadId, { name: heuristic })
      this.emit('thread-title-updated', { threadId, thread: updated })
      return
    }
    let title: string | null = null
    try {
      title = await this.llm.generateTitle(userContent, undefined, threadId)
    } catch (error) {
      this.emit('thread-title-generation-failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    const finalTitle = (title?.trim() ? title.trim() : heuristic).slice(0, 80)
    if (!finalTitle || isDefaultThreadName(finalTitle)) return
    const updated = this.threadStore.updateThreadMeta(threadId, { name: finalTitle })
    this.emit('thread-title-updated', { threadId, thread: updated })
  }

  private async generateInitialThreadTitle(
    session: ThreadSession,
    userContent: string
  ): Promise<void> {
    await this.generateInitialThreadTitleForThread(session.threadId, userContent)
  }

  getNativeContext(threadId?: string): NativeLlmContext {
    if (!threadId || threadId === this.boundSession.threadId) {
      return structuredClone(this.boundSession.nativeContext)
    }
    return structuredClone(this.getOrCreateSession(threadId).nativeContext)
  }

  private clearLastTurnUsage(): void {
    this.lastMeasuredInput = null
    this.lastMeasuredCacheRead = null
    this.lastMeasuredCacheWrite = null
    this.lastMeasuredContextSignature = null
    this.measuredAtHistoryLength = 0
    if (this.nativeContext.lastTurnUsage) {
      const { lastTurnUsage: _stale, ...rest } = this.nativeContext
      this.nativeContext = rest
    }
  }

  private recordLastTurnUsage(usage: NonNullable<NativeLlmContext['lastTurnUsage']>): void {
    this.lastMeasuredInput = usage.input
    this.lastMeasuredCacheRead = usage.cacheRead
    this.lastMeasuredCacheWrite = usage.cacheWrite
    this.lastMeasuredContextSignature = usage.signature
    this.measuredAtHistoryLength = usage.measuredAtHistoryLength
    this.nativeContext = {
      ...this.nativeContext,
      lastTurnUsage: { ...usage }
    }
  }

  private commitActiveNativeMessages(
    activeMessages: import('@earendil-works/pi-ai').Message[],
    checkpoint?: NativeMessageCheckpoint
  ): void {
    this.nativeContext = commitNativeMessages(this.nativeContext, activeMessages, checkpoint)
  }

  async getContextUsage(
    input: OrchestratorContextUsageInput = '',
    threadId?: string
  ): Promise<ContextUsageSnapshot> {
    const run = async (): Promise<ContextUsageSnapshot> => {
      const request = normalizeContextUsageRequest(input)
      const modelOverride = this.session.modelOverride
      const selectedModel = modelOverride ?? resolveModelForMode(this.settingsStore.get(), request.mode, [
        ...(this.providerAuth.credentials?.listProviderIds() ?? []),
        ...this.adapters.configuredProviderIds()
      ])
      // The gauge never fails: a selection that cannot be resolved is measured like the pi loop's.
      let adapter: ProviderAdapter | undefined
      try {
        adapter = this.adapters.resolveSelection(selectedModel, { allowDisabled: true, unselectedDefault: !modelOverride }).adapter
      } catch {
        adapter = undefined
      }
      if (adapter && handoffDelivery(adapter.capabilities) === 'prompt_preamble') {
        // Prompt-injected runtimes own their context. Without a reported window, do not display
        // a fabricated Mousse context measurement.
        if (adapter.describe?.(selectedModel.model).contextUsage !== 'reported') {
          return { percent: 0, used: 0, limit: 0, modelName: selectedModel.model, source: 'estimated', categories: [] }
        }
        const key = `${selectedModel.llmProvider}:${selectedModel.model}`
        const stored = this.nativeContext.lastTurnUsage
        const capacity = this.nativeContext.nativeProviderModel
        const matches = stored?.modelKey === key && stored.contextRevision === (this.nativeContext.revision ?? 0)
        const limit = capacity?.selectedModel === selectedModel.model ? capacity.contextWindow ?? 0 : 0
        const usage = computeContextUsage({
          messages: getActiveMessages(this.nativeContext), draftInput: request.draftInput,
          contextLimit: limit, modelName: capacity?.selectedModel === selectedModel.model ? capacity.modelName : selectedModel.model,
          lastMeasuredInput: matches ? stored.input : null,
          lastMeasuredCacheRead: matches ? stored.cacheRead : null,
          lastMeasuredCacheWrite: matches ? stored.cacheWrite : null,
          measuredAtMessageLength: matches ? stored.measuredAtHistoryLength : 0,
          summaryText: getCompactionSummary(this.nativeContext),
          systemPromptText: '', legacyEstimated: this.nativeContext.fidelity === 'legacy-estimated'
        })
        const latestResponse = [...this.session.messages].reverse().find((message) => message.responseMetadata?.tokensUsed !== undefined)
        return { ...usage, limit, modelLimit: limit, percent: limit > 0 ? usage.percent : 0, processedTokens: latestResponse?.responseMetadata?.tokensUsed }
      }
      const { limit, modelName } = this.llm.getSelectedModelContextLimit(request.mode, modelOverride)
      const contextInputs = await this.llm.getContextInputs(
        request.mode,
        request.draftInput,
        {
          ...modelOverride,
          projectPath: this.session.projectCwd ?? undefined,
          contextSummary: getCompactionSummary(this.nativeContext)
        }
      )
      const contextRevision = this.nativeContext.revision ?? 0
      const storedUsage = this.nativeContext.lastTurnUsage
      const measurementMatches =
        this.lastMeasuredContextSignature === contextInputs.signature &&
        (!storedUsage?.modelKey || storedUsage.modelKey === contextInputs.modelKey) &&
        (storedUsage?.contextRevision === undefined || storedUsage.contextRevision === contextRevision)
      const usage = computeContextUsage({
        messages: getActiveMessages(this.nativeContext),
        draftInput: request.draftInput,
        contextLimit: limit,
        modelName,
        lastMeasuredInput: measurementMatches ? this.lastMeasuredInput : null,
        lastMeasuredCacheRead: measurementMatches ? this.lastMeasuredCacheRead : null,
        lastMeasuredCacheWrite: measurementMatches ? this.lastMeasuredCacheWrite : null,
        measuredAtMessageLength: this.measuredAtHistoryLength,
        legacyEstimated: this.nativeContext.fidelity === 'legacy-estimated' && !measurementMatches,
        summaryText: this.nativeContext.compaction?.summary,
        systemPromptText: contextInputs.baseSystemPromptText ?? contextInputs.systemPromptText,
        mcpToolsText: contextInputs.mcpToolsText,
        otherToolsText: contextInputs.otherToolsText
      })
      const latestResponse = [...this.session.messages].reverse().find((message) => message.responseMetadata?.tokensUsed !== undefined)
      return { ...usage, modelLimit: limit, processedTokens: latestResponse?.responseMetadata?.tokensUsed }
    }
    if (threadId && threadId !== this.session.threadId) {
      const session = this.getOrCreateSession(threadId)
      return this.sessionAls.run(session, () => run())
    }
    return run()
  }

  private addSystemMessage(content: string): void {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      content,
      timestamp: new Date().toISOString()
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
  }

  private addPlanCardMessage(
    originalRequest: string,
    planMarkdown: string,
    responseMetadata?: ChatMessage['responseMetadata']
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      kind: 'plan_card',
      content: planMarkdown,
      planCard: { originalRequest, planMarkdown },
      responseMetadata,
      timestamp: new Date().toISOString()
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
    return msg
  }

  /** present_plan tool target: emit an inline approval card from any mode
   * (notably Agent mode). The model decides when planning beats answering,
   * editing, or delegating. */
  private presentPlanCard(
    payload: { title: string; markdown: string },
    threadId?: string
  ): void {
    const markdown = payload.markdown?.trim()
    if (!markdown) return
    const title = payload.title?.trim()
    const lastUser = [...this.messages].reverse().find((message) => message.role === 'user')
    const originalRequest = title || lastUser?.content?.trim() || 'Implementation plan'
    this.addPlanCardMessage(originalRequest, markdown)
    if (threadId) this.emitThreadMessages(threadId, this.messages)
  }

  private appletCatalogue(): string {
    const references = this.messages.filter(message => !message.hidden).flatMap(message => message.presentationParts ?? []).filter(part => part.type === 'applet').map(part => part.reference)
    return references.length ? '\nExisting applets in this conversation (use appletId and expectedRevision to revise; latest visible revision per applet):\n' + JSON.stringify([...new Map(references.map(ref => [ref.appletId, ref])).values()].slice(-20)) : ''
  }

  private addMessage(
    role: 'user' | 'assistant',
    content: string,
    images?: ChatImageAttachment[],
    responseMetadata?: ChatMessage['responseMetadata'],
    queueItemId?: string,
    mode?: ChatMode,
    subagentNotice?: SubagentNoticeItem[],
    steered?: boolean
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      responseMetadata,
      queueItemId: role === 'user' && queueItemId ? queueItemId : undefined,
      ...(role === 'user' && mode !== undefined ? { mode: normalizeChatMode(mode) } : {}),
      ...(role === 'user' && subagentNotice?.length ? { subagentNotice } : {}),
      ...(role === 'user' && steered ? { steered: true } : {})
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist(true)
    return msg
  }

  /**
   * Fail-closed transcript provenance for a queue claim.
   * - `accepted` — queueItemId is durably present; may complete, never release/re-execute
   * - `not_accepted` — readable transcript without the id; may release a pre-accept claim
   * - `unavailable` — transcript unreadable; leave claim claimed, never release or re-execute
   */
  private inspectDurableQueueProvenance(
    threadId: string,
    queueItemId: string
  ): 'accepted' | 'not_accepted' | 'unavailable' {
    if (!this.threadStore || threadId === '__unbound__') return 'not_accepted'
    try {
      if (!this.threadStore.getThread(threadId)) return 'not_accepted'
      const data = this.threadStore.loadThreadData(threadId)
      const transcriptAccepted = data.messages.some((message) => message.queueItemId === queueItemId)
      const contextAccepted = data.llmContext?.acceptedQueueItemIds?.includes(queueItemId) === true
      if (transcriptAccepted && contextAccepted) return 'accepted'
      if (!transcriptAccepted && !contextAccepted) return 'not_accepted'
      // A torn/legacy admission is not proof that execution may safely repeat.
      return 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  /**
   * After a turn/accept failure: only a definite `not_accepted` may release.
   * `accepted` completes; `unavailable` leaves the durable claim untouched.
   */
  private settleClaimAfterFailure(
    session: ThreadSession,
    itemId: string,
    ownerToken: string | undefined,
    context: string
  ): void {
    const status = this.inspectDurableQueueProvenance(session.threadId, itemId)
    if (status === 'accepted') {
      this.completeSessionClaim(session, itemId, ownerToken)
      return
    }
    if (status === 'not_accepted') {
      this.releaseSessionClaim(session, itemId, ownerToken)
      return
    }
    this.emit('queue-drain-failed', {
      threadId: session.threadId,
      queueItemId: itemId,
      error: `transcript provenance unreadable (${context}); durable claim left claimed`
    })
  }

  /**
   * Coherently accept user input into messages + native context with a single persist.
   * On failure without durable provenance: roll back in-memory mutations and resync observers.
   * If transcript provenance is already durable, keep memory state and treat as accepted
   * (do not release/reappend) even when a later part of the write failed.
   * If provenance is unreadable: roll back speculative memory, leave durable claim claimed.
   */
  private acceptTurnUserInput(
    session: ThreadSession,
    userContent: string,
    images: ChatImageAttachment[] | undefined,
    displayUserMessage: boolean,
    queueItemId?: string,
    mode?: ChatMode,
    workflowRun?: WorkflowChatRun,
    subagentNotice?: SubagentNoticeItem[]
  ): { claimAccepted: boolean } {
    const messagesBefore = this.messages.length
    const nativeBefore = structuredClone(this.nativeContext)
    // A mid-chat mode switch must reach the model even though the transcript UI
    // shows no marker: inject a hidden notice into both durable stores before
    // the visible user message. Internal wakes (hidden) never advance the
    // tracked mode, so they neither emit nor consume notices.
    let modeNotice: ChatMessage | null = null
    if (displayUserMessage && mode !== undefined) {
      const currentMode = normalizeChatMode(mode)
      const previousMode = getLastUserChatMode(this.messages)
      if (previousMode !== undefined && !chatModeEquals(previousMode, currentMode)) {
        modeNotice = {
          id: uuidv4(),
          role: 'user',
          content: buildModeChangeNotice(previousMode, currentMode),
          timestamp: new Date().toISOString(),
          hidden: true,
          mode: currentMode
        }
      }
    }
    const addedMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      queueItemId: queueItemId || undefined,
      workflowInvocationId: workflowRun?.invocationId,
      ...(subagentNotice?.length ? { subagentNotice } : {}),
      hidden: displayUserMessage ? undefined : true,
      ...(displayUserMessage && mode !== undefined
        ? { mode: normalizeChatMode(mode) }
        : {})
    }
    // Hidden internal inputs remain in the durable transcript for queue-claim provenance,
    // while presentation APIs and events omit them from the UI.
    if (modeNotice) {
      this.messages.push(modeNotice)
      this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(modeNotice.content))
    }
    this.messages.push(addedMessage)
    this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(userContent, images))
    if (queueItemId) {
      this.nativeContext = {
        ...this.nativeContext,
        acceptedQueueItemIds: Array.from(new Set([
          ...(this.nativeContext.acceptedQueueItemIds ?? []),
          queueItemId
        ]))
      }
    }
    // Queue provenance and the durable run link must become visible together.
    const workflowMessage: ChatMessage | undefined = workflowRun ? {
      id: uuidv4(), role: 'assistant', timestamp: new Date().toISOString(), workflowRun,
      content: `Workflow: ${workflowRun.title}\nRun: ${workflowRun.runId}\nRevision: ${workflowRun.revisionId}\nState at admission: ${workflowRun.state}`
    } : undefined
    if (workflowMessage) {
      this.messages.push(workflowMessage)
      this.nativeContext = appendNativeMessage(
        this.nativeContext,
        userMessage('[Mousse workflow admission]\n' + workflowMessage.content)
      )
    }

    try {
      this.persist(true)
    } catch (err) {
      const status = queueItemId
        ? this.inspectDurableQueueProvenance(session.threadId, queueItemId)
        : 'not_accepted'
      if (status === 'accepted') {
        // Transcript provenance is durable — keep in-memory state; do not roll back or release.
        if (!addedMessage.hidden) this.emitMessageAdded(addedMessage)
        if (workflowMessage) this.emitMessageAdded(workflowMessage)
        throw err
      }
      // Roll back speculative mutations. For unavailable provenance, do not mutate durable claim.
      this.messages.splice(messagesBefore)
      this.nativeContext = nativeBefore
      this.emitThreadMessages(session.threadId, session.messages)
      if (status === 'unavailable' && queueItemId) {
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId,
          error:
            'transcript provenance unreadable after accept failure; durable claim left claimed'
        })
      }
      throw err
    }

    if (!addedMessage.hidden) this.emitMessageAdded(addedMessage)
    if (workflowMessage) this.emitMessageAdded(workflowMessage)
    return { claimAccepted: true }
  }

  private addToolCallMessage(action: OrchestratorAction): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind: 'tool_call',
      content: '',
      timestamp: new Date().toISOString(),
      toolCall: getToolCallDisplay(action)
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
    return msg
  }

  private updateToolTimelineMessage(
    messageId: string,
    toolCall: NonNullable<ChatMessage['toolCall']>,
    immediate = false
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      toolCall
    }
    this.messages[index] = updated
    this.emitMessageUpdated(updated)
    this.persist(immediate)
  }

  /** The current session's streaming transcript assembler (SPEC §13.4 shared builders). */
  private get transcript(): TranscriptAssembler {
    const session = this.session
    let assembler = this.transcripts.get(session)
    if (!assembler) {
      assembler = new TranscriptAssembler(
        {
          getMessage: (id) => session.messages.find((message) => message.id === id),
          addMessage: (message) => {
            session.messages.push(message)
          },
          updateMessage: (message) => {
            const index = session.messages.findIndex((entry) => entry.id === message.id)
            if (index !== -1) session.messages[index] = message
          },
          removeMessage: (id) => this.removeMessage(id),
          emitAdded: (message) => this.emitMessageAdded(message),
          emitUpdated: (message) => this.emitMessageUpdated(message),
          persist: (force) => this.persist(force),
          setPhase: (phase, patch) => this.setTurnPhase(session.threadId, phase, patch)
        },
        session
      )
      this.transcripts.set(session, assembler)
    }
    return assembler
  }

  private addStreamingAssistantMessage(): ChatMessage {
    return this.transcript.startAssistant()
  }

  private updateStreamingAssistantMessage(
    messageId: string,
    content: string,
    streaming: boolean,
    responseMetadata?: ChatMessage['responseMetadata'],
    incomplete?: boolean
  ): void {
    this.transcript.updateAssistant(messageId, content, streaming, responseMetadata, incomplete)
  }

  private removeMessage(messageId: string): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return
    this.messages.splice(index, 1)
    this.emitThreadMessages(this.session.threadId, this.session.messages)
    this.persist(true)
  }

  private handleStreamingTextEvent(event: import('./LlmClient').StreamingLlmTextEvent): void {
    this.transcript.text(event)
  }

  private handleStreamingThinkingEvent(event: StreamingLlmThinkingEvent): void {
    this.transcript.thinking(event)
  }

  private handleStreamingToolEvent(event: StreamingLlmToolEvent): void {
    this.transcript.tool(event)
  }

  // retained for non-GUI callers (CLI/channels)
  isTurnActive(threadId?: string): boolean {
    if (threadId) {
      const session =
        this.boundSession.threadId === threadId
          ? this.boundSession
          : this.sessions.get(threadId)
      return Boolean(session?.isTurnActive())
    }
    return this.boundSession.isTurnActive()
  }

  /**
   * Abort the active GUI/CLI orchestrator turn for a thread (defaults to bound thread).
   * Does not clear the durable normal message queue unless clearQueue is true. With `runId` only that
   * run's turn is aborted: a Stop of a run must not reach a later turn of the thread (a fresh message
   * sent after the Stop). This is the internal primitive; a public Stop is `stopThread`, which wraps it.
   */
  abortActiveTurn(threadId?: string, opts?: { clearQueue?: boolean; runId?: string }): boolean {
    const id = threadId ?? this.getBoundThreadId()
    const session = id
      ? this.boundSession.threadId === id
        ? this.boundSession
        : this.sessions.get(id)
      : this.boundSession
    if (!session) return false
    const active = session.activeTurn
    if (!active && session.turnAdmitted && !session.abortRequested) {
      // Admitted but still in recovery/workspace setup: abort as soon as the turn starts. A turn that has
      // not marked its run starting yet is a queued run, which a Stop cancels by id instead.
      if (opts?.runId && id && this.runEngine?.getActiveRun(id)?.runId !== opts.runId) return false
      session.abortRequested = true
    } else if (!active || active.abort.signal.aborted) {
      return false
    } else {
      if (opts?.runId && active.runId && active.runId !== opts.runId) return false
      active.pendingSteer = []
      active.promotedSteerIds = []
      active.abort.abort()
    }
    if (opts?.clearQueue && id) {
      let clearedRunIds: Array<string | undefined> = []
      let clearedItems: QueuedMessage[] = []
      const clear = (items: QueuedMessage[]): QueuedMessage[] => {
        const retained = clearPendingQueue(items)
        const retainedIds = new Set(retained.map((item) => item.id))
        clearedItems = items.filter((item) => !retainedIds.has(item.id))
        clearedRunIds = clearedItems.map((item) => item.runId)
        // Before the clear is saved (see removeQueuedItem).
        this.releaseQueuedRows(clearedItems)
        for (const item of items) {
          if (item.workflowInvocationId && !retainedIds.has(item.id)) {
            if (!this.workflowChat) throw new Error('Workflow queue cancellation is unavailable')
            this.workflowChat.abandon(item.workflowInvocationId, id)
          }
        }
        return retained
      }
      if (this.threadStore) {
        // A failed durable clear must not pretend that pending work disappeared.
        session.queue = mutateDurableQueue(this.threadStore, id, clear)
      } else {
        session.queue = clear(session.queue)
      }
      this.emitQueueUpdated(id, session.queue)
      this.cancelQueuedRuns(clearedRunIds)
    }
    this.emit('turn-aborted', { threadId: id ?? undefined })
    return true
  }

  isConversationHistoryBusy(threadId: string): boolean {
    const session = this.getOrCreateSession(threadId)
    this.refreshSessionQueueFromDisk(session)
    return session.isTurnRunning() || listPendingQueue(session.queue).length > 0
  }

  /**
   * Close a turn only after final response persistence and action execution.
   * During that finalizing window, sends must queue and steers must remain
   * attached to the active turn instead of racing a concurrent turn.
   */
  private settleActiveTurn(
    session: ThreadSession,
    turn: NonNullable<ThreadSession['activeTurn']>,
    aborted: boolean,
    opts?: { onTurnSettled?: (aborted: boolean) => void },
    failed = false
  ): void {
    const wasAborted = aborted || turn.abort.signal.aborted
    const hadUnreadSteers = !wasAborted && turn.pendingSteer.length > 0
    if (hadUnreadSteers) {
      const pending = turn.pendingSteer
      const carried = turn.carriedSteers ?? []
      turn.pendingSteer = []
      turn.promotedSteerIds = []
      turn.carriedSteers = []
      if (session.threadId !== '__unbound__' && !session.deleted) {
        const mode = getLastUserChatMode(session.messages) ?? 'agent'
        // What the turn never read goes on as turns of their own. A steer that carried subagent
        // results is one turn per steer (it owns its rows and is rebuilt when it runs); the user's
        // own text is a plain follow-up that nothing rebuilds.
        // They are queued in the order they arrived.
        const remaining = [...carried]
        let plain: string[] = []
        const flush = (): void => {
          const leftover = plain.join('\n').trim()
          plain = []
          if (!leftover) return
          // The follow-up is a queued run from the start, so the thread stays held without memory (a restart included).
          let runId: string | undefined
          try {
            runId = this.runEngine?.store.createRun({ threadId: session.threadId, source: 'steer-followup' }).runId
            this.enqueueForThread(session.threadId, { content: leftover, mode }, { source: 'steer-followup', internal: true, runId })
          } catch {
            // Best-effort: settlement must not fail if the follow-up cannot queue.
            this.cancelQueuedRuns([runId])
          }
        }
        for (const text of pending) {
          const at = remaining.findIndex((entry) => entry.text === text)
          if (at < 0) {
            plain.push(text)
            continue
          }
          flush()
          const [entry] = remaining.splice(at, 1)
          try {
            this.enqueueCarrying(session.threadId, { content: entry.text, mode }, { source: 'steer-followup', internal: true }, [entry], entry.subagentNotice)
          } catch {
            // Settlement must not fail; the rows go back to pending so rule 4 delivers them instead.
            this.runEngine?.inbox.release(entry.inboxIds, entry.effectId)
          }
        }
        flush()
        for (const entry of remaining) this.runEngine?.inbox.release(entry.inboxIds, entry.effectId)
      }
    }
    if (session.activeTurn === turn) session.activeTurn = null
    // The turn's terminal write saw its unread steers and held the thread's tasks. They are queued as a
    // follow-up turn now (which keeps holding them), or were dropped (which releases them).
    if (hadUnreadSteers) this.reevaluateHold(session.threadId)
    opts?.onTurnSettled?.(wasAborted)
    this.emit(wasAborted ? 'turn-interrupted' : failed ? 'turn-failed' : 'turn-completed', {
      threadId: session.threadId
    })
  }

  /** The thread's inputs to the hold predicate changed outside the run store: publish the tasks that are no longer held. */
  private reevaluateHold(threadId: string): void {
    try {
      this.runEngine?.store.settleHold(threadId)
    } catch (error) {
      console.warn('held tasks could not be re-evaluated', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  isActiveTurnRunning(threadId?: string): boolean {
    if (threadId) {
      const session =
        this.boundSession.threadId === threadId
          ? this.boundSession
          : this.sessions.get(threadId)
      return Boolean(session?.isTurnRunning())
    }
    // Any thread has a main turn (used carefully — prefer thread-scoped checks).
    if (this.boundSession.isTurnRunning()) return true
    for (const session of this.sessions.values()) {
      if (session.isTurnRunning()) return true
    }
    return false
  }

  /**
   * Inject mid-turn guidance into the active turn for a thread (bound by default).
   * Accepted steers are not enqueued as later normal turns.
   */
  steerActiveTurn(text: string, threadId?: string): boolean {
    return this.steerThread(threadId ?? this.getBoundThreadId() ?? undefined, text)
  }

  steerThread(threadId: string | undefined, text: string, subagentNotice?: SubagentNoticeItem[], carried?: { inboxIds: string[]; effectId: string }): boolean {
    const trimmed = text.trim()
    if (!trimmed || !threadId) return false
    const session =
      this.boundSession.threadId === threadId
        ? this.boundSession
        : this.sessions.get(threadId) ?? null
    if (session?.activeTurn && !session.activeTurn.abort.signal.aborted) {
      session.activeTurn.pendingSteer.push(trimmed)
      if (carried) {
        (session.activeTurn.carriedSteers ??= []).push({ ...carried, text: trimmed, subagentNotice })
        // Marked before the turn can end: from here an unread steer is recoverable (`deliveryFailure`).
        this.runEngine?.inbox.markSteerHeld(carried.inboxIds, carried.effectId)
      }
      // Prefer ALS when already inside the turn; otherwise annotate bound if matching.
      const run = (): void => {
        // Mid-turn steers share the turn's mode — preserve tracking so the next
        // real turn does not mistake this UI echo for a legacy agent turn.
        const currentMode = getLastUserChatMode(this.messages)
        this.addMessage('user', trimmed, undefined, undefined, undefined, currentMode, subagentNotice, true)
      }
      if (this.sessionAls.getStore()?.threadId === threadId) {
        run()
      } else if (this.boundSession.threadId === threadId) {
        run()
      } else {
        this.sessionAls.run(session, run)
      }
      this.emit('turn-steered', { threadId, text: trimmed })
      return true
    }
    // Local channel turn for this thread. A steer that carries notices is not given to it: the turn
    // would take the text without the rows' identity, so it is queued as a turn of its own instead.
    if (!carried && this.steerChannelTurn(threadId, trimmed)) {
      this.emit('turn-steered', { threadId, text: trimmed })
      return true
    }
    return false
  }

  /**
   * Steer locally when possible; otherwise persist a one-time steer-intent for the
   * external lease owner (cross-process CLI/GUI peers sharing MOUSSE_HOME).
   */
  steerThreadOrEnqueueExternal(
    threadId: string,
    text: string,
    opts?: { source?: string }
  ): { steered: boolean; queued: boolean; item?: QueuedMessage } {
    if (this.steerThread(threadId, text)) {
      return { steered: true, queued: false }
    }
    if (this.isThreadLeaseHeldExternally(threadId) || this.isChannelTurnActive(threadId)) {
      const item = this.enqueueExternalSteer(threadId, text, opts)
      if (item) return { steered: false, queued: true, item }
    }
    return { steered: false, queued: false }
  }

  /**
   * Abort an in-flight channel turn for a Mousse thread (Telegram/Discord). The abort is immediate;
   * a channel turn that is an engine run also gets its `stop` recorded against that run.
   */
  abortChannelTurn(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    if (!turn || turn.abort.signal.aborted) return false
    turn.pendingSteer = []
    turn.promotedSteerIds = []
    turn.abort.abort()
    this.recordChannelControl('stop', threadId, turn.runId)
    return true
  }

  /**
   * Steer an in-flight channel turn for a Mousse thread. The text reaches the turn through its own
   * steer queue; an engine-run channel turn also records the `steer` against its run.
   */
  steerChannelTurn(threadId: string, text: string): boolean {
    const trimmed = text.trim()
    const turn = this.channelTurns.get(threadId)
    if (!trimmed || !turn || turn.abort.signal.aborted) return false
    turn.pendingSteer.push(trimmed)
    this.recordChannelControl('steer', threadId, turn.runId)
    return true
  }

  /** Records a channel turn's stop or steer as a command on its run (delivery already happened). */
  private recordChannelControl(kind: 'stop' | 'steer', threadId: string, runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    void engine.dispatch({ kind, threadId, clientRequestId: `channel-${kind}:${uuidv4()}`, runId }).catch((error: unknown) => {
      console.warn(`channel ${kind} could not be recorded`, { runId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /**
   * C4: a channel turn is an engine run, created through the same `send` command as any other
   * (`source: 'channel'`), so rule 4 and the rest of the engine see the thread busy. A run that
   * cannot be recorded leaves the turn to run without one, like any other bridge write.
   */
  private async recordChannelRun(threadId: string): Promise<string | undefined> {
    const engine = this.runEngine
    if (!engine) return undefined
    try {
      const result = await engine.dispatch({ kind: 'send', threadId, clientRequestId: `channel:${uuidv4()}`, source: 'channel' })
      return result.status === 'accepted' ? result.runId : undefined
    } catch (error) {
      console.warn('run engine could not record a channel turn', { threadId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  isChannelTurnActive(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    return Boolean(turn && !turn.abort.signal.aborted)
  }

  /**
   * Send a message to a thread. Same-thread busy turns enqueue FIFO instead of throwing.
   * Distinct threads may run concurrently without sharing transcript/cwd/active control.
   * Cross-process: if a live peer holds the execution lease, atomically enqueue into the
   * durable MMS queue rather than starting a second turn.
   *
   * A turn blocked on ask_user / plan ask / quick-action approval never strands a
   * fresh message behind the unanswered prompt: the pending question is
   * default-rejected, the blocked turn is stopped, and the new message runs as
   * a fresh turn instead of queueing. The fresh message is always delivered as
   * a visible user prompt (fresh turn or visible queued item) — never steered
   * invisibly into the old turn.
   */
  async send(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: OrchestratorSendOptions
  ): Promise<OrchestratorResponse> {
    return this.lifecycle.run('send', () => this.sendOwned(input, reuseLastUser, opts))
  }

  private async sendOwned(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: OrchestratorSendOptions
  ): Promise<OrchestratorResponse> {
    const threadId = opts?.threadId ?? this.getBoundThreadId()
    if (!threadId) {
      // Legacy unbound path (tests / early boot): use bound session directly.
      return this.runTurnOnSession(this.boundSession, input, reuseLastUser, opts?.source !== 'wake', { source: opts?.source })
    }

    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new Error(`Thread deleted: ${threadId}`)
    }

    // SPEC §16.2: a send that would queue behind a pending merge-back is refused before it is a run.
    if (opts?.forceQueue || session.isTurnRunning()) this.assertQueueOpen(threadId)

    // The run is durable before any queue/run decision or provider I/O (SPEC §2.1).
    let run: { runId: string; sequence: number } | undefined
    if (this.runEngine) {
      const result = await this.runEngine.dispatch({
        kind: 'send',
        threadId,
        clientRequestId: opts?.clientRequestId ?? uuidv4(),
        source: opts?.source ?? 'protocol',
        prompt: normalizeSendRequest(input).content,
        ...(opts?.delegation ? { delegation: opts.delegation } : {}),
        ...(opts?.continuationOfRunId ? { continuationOfRunId: opts.continuationOfRunId, acknowledgeUncertain: opts.acknowledgeUncertain === true } : {})
      })
      if (result.status === 'rejected' && CONTINUATION_REFUSALS.has(result.reason))
        throw new DomainRpcError(result.reason, `Cannot continue run ${opts?.continuationOfRunId}: ${result.reason}.`)
      // Every refusal surfaces with its reason as the error code (S3), e.g. client_request_id_conflict.
      if (result.status !== 'accepted') throw new DomainRpcError(result.reason, `Send refused: ${result.reason}.`)
      if (result.replayed) {
        const replayed = { runId: result.runId, sequence: result.sequence, replayed: true }
        // A replay of a send whose turn is still live waits for the same result (SPEC §12.7).
        const live = this.turnResults.get(result.runId)
        const run = live ? this.runEngine.getRun(result.runId) : null
        if (live && opts?.awaitMode !== 'ack' && run && !TERMINAL_RUN_STATUSES.has(run.status)) {
          return { ...(await live.promise), ...replayed }
        }
        return { message: '', actions: [], ...replayed }
      }
      run = { runId: result.runId, sequence: result.sequence }
    }

    // A follow-up from a parent (`continue_subagent`) never answers the subagent's question for it.
    if (!opts?.forceQueue && !opts?.delegation) {
      const preempted = this.questions.autoRejectPendingForThread(threadId)
      if (preempted.answered + preempted.dismissed > 0 && session.isTurnRunning()) {
        this.abortActiveTurn(threadId)
        await this.waitForTurnToSettle(session)
      }
      // If the blocked turn still has not settled, fall through to the normal
      // queue path below: the message stays a visible queued prompt and drains
      // as a fresh turn. Never steer it invisibly into the dying turn.
    }

    const externalLease =
      !session.isTurnRunning() &&
      !this.isChannelTurnActive(threadId) &&
      (() => {
        // Drop a dead owner's lease first so a restarted daemon does not
        // enqueue behind a ghost instead of running the turn directly.
        this.reclaimStaleThreadLease(threadId)
        return this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)
      })()

    if (session.isTurnRunning() || opts?.forceQueue || externalLease) {
      const item = this.enqueueForThread(threadId, input, { source: opts?.source, runId: run?.runId })
      return {
        message: '',
        actions: [],
        queued: true,
        queueItem: item,
        ...run
      }
    }

    if (run && this.effectsEnabled()) {
      // startTurn admits synchronously, right after the busy check, and hands it to the effect.
      const pending = this.startTurn(session, {
        runId: run.runId,
        threadId,
        input,
        reuseLastUser,
        displayUserMessage: opts?.source !== 'wake',
        source: opts?.source
      })
      if (opts?.awaitMode === 'ack') {
        pending.catch(() => undefined)
        return { message: '', actions: [], ...run, accepted: true }
      }
      return { ...(await pending), ...run }
    }

    const response = await this.runTurnOnSession(session, input, reuseLastUser, opts?.source !== 'wake', { source: opts?.source, runId: run?.runId })
    return run ? { ...response, ...run } : response
  }

  /**
   * Wait for an aborted blocked turn to release the session (its tool loop
   * unblocks as soon as the pending question resolves, then exits on the
   * abort flag without further model calls). Bounded so a stuck turn still
   * falls back to the visible queue instead of hanging the send.
   */
  private async waitForTurnToSettle(
    session: ThreadSession,
    timeoutMs = 10_000,
    pollMs = 25
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (session.isTurnRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  /**
   * Record a user's question response (submitted answers or an explicit
   * dismissal) as a visible presentation-only user message, as if they had
   * sent it in chat. The answers already reach the model through the tool
   * result, so this deliberately bypasses native/model context — appending
   * there mid-turn would corrupt the in-flight tool loop. Best-effort:
   * returns null when the thread is gone.
   */
  recordQuestionResponseMessage(threadId: string, content: string): ChatMessage | null {
    const text = content.trim()
    if (!text || threadId === '__unbound__') return null
    if (this.threadStore && !this.threadStore.getThread(threadId)) return null
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) return null
    return this.sessionAls.run(session, () => {
      const msg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        // Presentation-only echo: preserve the tracked mode so the next real
        // turn does not mistake this answer for a legacy agent turn.
        ...((() => {
          const currentMode = getLastUserChatMode(this.messages)
          return currentMode !== undefined ? { mode: currentMode } : {}
        })())
      }
      this.messages.push(msg)
      this.emitMessageAdded(msg)
      this.persist(true)
      return msg
    })
  }

  private async runTurnOnSession(
    session: ThreadSession,
    input: OrchestratorSendInput,
    reuseLastUser: boolean,
    displayUserMessage = true,
    opts?: {
      source?: string
      queueItemId?: string
      claimOwnerToken?: string
      /** When true, executeTurn must not chain ordinary post-turn queue drains. */
      suppressAutoQueueDrain?: boolean
      externalSignal?: AbortSignal
      externalDrainSteer?: () => string | undefined
      modelOverride?: ModelOverride
      onTurnSettled?: (aborted: boolean) => void
      onUserInputAccepted?: () => void
      /** The caller already admitted this session (see ThreadSession.turnAdmitted) and hands ownership to this turn. */
      admissionHeld?: boolean
      /** Run Engine run this turn executes; also used as the turn id. */
      runId?: string
      /** The subagent results this turn's message delivers (a wake, a queued steer). */
      subagentNotice?: SubagentNoticeItem[]
    }
  ): Promise<OrchestratorResponse> {
    // Admission is synchronous, before any await, so a concurrent send always observes it.
    if (!opts?.admissionHeld) {
      if (session.turnAdmitted) {
        if (opts?.queueItemId) this.releaseSessionClaim(session, opts.queueItemId, opts.claimOwnerToken)
        const error = new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
        // A released claim keeps its runId on the queue item; a direct send's run ends here.
        if (!opts?.queueItemId) this.settleRunAfterTurn(opts?.runId, false, error)
        throw error
      }
      session.turnAdmitted = true
    }
    let turnResponse: OrchestratorResponse | undefined
    let turnFailure: unknown
    try {
      turnResponse = await this.lifecycle.run('turn', () => this.sessionAls
        .run(session, () =>
          this.executeTurn(input, reuseLastUser, displayUserMessage, { ...opts, externalSignal: opts?.externalSignal ? AbortSignal.any([opts.externalSignal, this.lifecycle.signal]) : this.lifecycle.signal })
        ))
      return turnResponse
    } catch (error) {
      turnFailure = error ?? new Error('Turn failed')
      throw error
    } finally {
      // A queue item that was never accepted stays on the queue and keeps its run queued.
      const requeued = turnResponse?.queued === true ||
        (opts?.queueItemId !== undefined && session.queue.some((item) => item.id === opts.queueItemId))
      this.settleRunAfterTurn(opts?.runId, requeued, turnFailure)
      this.releaseSessionExecutionLease(session)
      session.turnAdmitted = false
      session.abortRequested = false
      // Post-turn drains are deferred to here: while admission is held the drain would see a
      // running turn and skip, stranding queued messages.
      if (session.drainAfterSettle) {
        session.drainAfterSettle = false
        try {
          this.scheduleQueueDrain(session)
        } catch (error) {
          logDebug('OrchestratorService', 'post-turn queue drain failed to schedule', error, { threadId: session.threadId })
        }
      }
    }
  }

  /** Tells an observer the user's input is stored; a throwing observer is logged and never aborts the accepted turn. */
  private notifyUserInputAccepted(threadId: string, observer: (() => void) | undefined): void {
    if (!observer) return
    try {
      observer()
    } catch (error) {
      logDebug('OrchestratorService', 'user input accepted observer failed', error, { threadId })
    }
  }

  /** Honor a stop that arrived while the turn was admitted but not yet running. */
  private applyRequestedAbort(session: ThreadSession, turn: { abort: AbortController }): void {
    if (!session.abortRequested) return
    session.abortRequested = false
    turn.abort.abort()
  }

  private releaseSessionExecutionLease(session: ThreadSession): void {
    if (!session.executionLease) return
    releaseExecutionLeaseHandle(session.executionLease)
    session.executionLease = null
  }

  private async executeWorkflowChatTurn(
    session: ThreadSession,
    request: NormalizedOrchestratorSendRequest,
    opts?: { queueItemId?: string; claimOwnerToken?: string; suppressAutoQueueDrain?: boolean; externalSignal?: AbortSignal; onTurnSettled?: (aborted: boolean) => void; onUserInputAccepted?: () => void }
  ): Promise<OrchestratorResponse> {
    if (!this.workflowChat) throw new Error('Workflow command execution is unavailable')
    const turn = { abort: new AbortController(), pendingSteer: [] as string[], promotedSteerIds: [] as string[] }
    const abort = () => turn.abort.abort()
    if (opts?.externalSignal?.aborted) abort()
    else opts?.externalSignal?.addEventListener('abort', abort, { once: true })
    this.activeTurn = turn
    this.applyRequestedAbort(session, turn)
    this.setTurnPhase(session.threadId, 'queued', { turnId: uuidv4() })
    let accepted = false
    let outcome: 'completed' | 'stopped' | 'failed' = 'failed'
    try {
      // Admit durably before transcript provenance completes a queue claim.
      // Replaying after a crash returns the same engine run, never a new dispatch.
      const run = await this.workflowChat.execute(request.workflowInvocationId!, session.threadId, request.content, turn.abort.signal)
      if (!session.messages.some((message) => message.role === 'user' && message.workflowInvocationId === run.invocationId)) {
        this.touchUserActivityAndNotify(session.threadId)
        this.acceptTurnUserInput(session, request.content, undefined, true, opts?.queueItemId, request.mode, run)
      }
      this.notifyUserInputAccepted(session.threadId, opts?.onUserInputAccepted)
      if (!session.messages.some((message) => message.workflowRun?.runId === run.runId)) {
        const content = `Workflow: ${run.title}\nRun: ${run.runId}\nRevision: ${run.revisionId}\nState at admission: ${run.state}`
        const message: ChatMessage = { id: uuidv4(), role: 'assistant', content, workflowRun: run, timestamp: new Date().toISOString() }
        this.messages.push(message)
        this.nativeContext = appendNativeMessage(
          this.nativeContext,
          userMessage('[Mousse workflow admission]\n' + content)
        )
        this.persist(true)
        this.emitMessageAdded(message)
      }
      if (opts?.queueItemId) this.completeSessionClaim(session, opts.queueItemId, opts.claimOwnerToken)
      accepted = true
      const response: OrchestratorResponse = { message: `Workflow ${run.title} admitted as ${run.runId}.`, actions: [], workflowRun: run }
      this.setTurnPhase(session.threadId, turn.abort.signal.aborted ? 'stopped' : 'completed')
      outcome = turn.abort.signal.aborted ? 'stopped' : 'completed'
      this.emit('response', response)
      return response
    } catch (error) {
      this.setTurnPhase(session.threadId, 'failed', { error: error instanceof Error ? error.message : 'Workflow command failed' })
      throw error
    } finally {
      opts?.externalSignal?.removeEventListener('abort', abort)
      this.activeTurn = null
      opts?.onTurnSettled?.(outcome === 'stopped')
      this.emit(
        outcome === 'stopped' ? 'turn-interrupted' : outcome === 'completed' ? 'turn-completed' : 'turn-failed',
        { threadId: session.threadId }
      )
      this.releaseSessionExecutionLease(session)
      if (accepted && !opts?.suppressAutoQueueDrain) session.drainAfterSettle = true
    }
  }

  private async executeTurn(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    displayUserMessage = true,
    opts?: {
      source?: string
      queueItemId?: string
      claimOwnerToken?: string
      suppressAutoQueueDrain?: boolean
      externalSignal?: AbortSignal
      externalDrainSteer?: () => string | undefined
      modelOverride?: ModelOverride
      onTurnSettled?: (aborted: boolean) => void
      onUserInputAccepted?: () => void
      runId?: string
      subagentNotice?: SubagentNoticeItem[]
    }
  ): Promise<OrchestratorResponse> {
    const session = this.session
    const queueItemId = opts?.queueItemId
    const claimOwnerToken = opts?.claimOwnerToken
    const suppressAutoQueueDrain = opts?.suppressAutoQueueDrain === true
    let claimAccepted = false
    if (session.deleted) {
      throw new Error(`Thread deleted: ${session.threadId}`)
    }
    if (this.activeTurn) {
      // Same-session re-entry should not happen; callers queue first.
      if (queueItemId) {
        this.releaseSessionClaim(session, queueItemId, claimOwnerToken)
      }
      throw new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
    }

    // Load recovery identity before acquiring the writer. Reconcile interrupted
    // operations below under that lease, before workspace verification/dispatch.
    const recoveryDirectory = session.threadId !== '__unbound__' ? this.resolveThreadDir(session.threadId) : undefined
    const recoveryManager = recoveryDirectory ? new ThreadWorkspaceManager(recoveryDirectory) : undefined
    const recoveryWorkspace = recoveryManager?.load()
    // Acquire cross-process execution lease before mutating thread state.
    let lease: ThreadLeaseHandle | null = session.executionLease
    if (session.threadId !== '__unbound__') {
      const threadDir = this.resolveThreadDir(session.threadId)
      if (threadDir && !lease) {
        lease = tryAcquireExecutionLease(threadDir, {
          source: 'orchestrator',
          token: claimOwnerToken
        })
        if (!lease) {
          // Peer won the race. For an existing claim, release at original order —
          // never enqueue a replacement UUID at the tail.
          if (queueItemId) {
            const released = this.releaseSessionClaim(session, queueItemId, claimOwnerToken)
            return {
              message: '',
              actions: [],
              queued: true,
              queueItem: released ?? undefined
            }
          }
          const item = this.enqueueForThread(session.threadId, input, { source: 'lease-race', runId: opts?.runId })
          return {
            message: '',
            actions: [],
            queued: true,
            queueItem: item
          }
        }
        session.executionLease = lease
      }
    }

    if (recoveryDirectory && session.executionLease) {
      new ConversationActionService(recoveryDirectory).recover(session.executionLease, (action, kind) => {
        this.validateConversationActionRestore(session.threadId, action, kind)
        if (kind === 'redo') this.restoreConversationActionEnd(session.threadId, action.presentationMessageStart, action.presentationMessageEnd, action.nativeContextBoundary)
        else this.restoreConversationBoundary(session.threadId, action.presentationMessageStart, action.nativeContextStartBoundary!)
      })
    }

    if (recoveryDirectory && recoveryWorkspace && session.executionLease) {
      const heldLease = session.executionLease
      await new ChildAgentIntegrationService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, heldLease)
      const primary = this.projectManager && this.threadStore
        ? resolveThreadProjectPath(this.projectManager, this.threadStore, session.threadId) : undefined
      if (primary) await new PublishService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, primary, heldLease)
      await new ThreadActionService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, heldLease)
      await new CodeRevertService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, heldLease)
      await new UndoService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, (action, kind) => {
        if (!action.nativeContextStartBoundary) return
        if (kind === 'redo') this.restoreConversationActionEnd(session.threadId, action.presentationMessageStart, action.presentationMessageEnd, action.nativeContextBoundary)
        else this.restoreConversationBoundary(session.threadId, action.presentationMessageStart, action.nativeContextStartBoundary)
      }, heldLease)
      await new ConversationBranchService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, (branch) => {
        const path = join(recoveryDirectory, 'conversation-contexts', `${encodeURIComponent(branch.id)}.json`)
        const saved = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number; messages: ChatMessage[]; nativeContext: NativeLlmContext }
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.messages) || !saved.nativeContext) throw new Error('Conversation recovery snapshot is invalid')
        this.replaceConversationState(session.threadId, saved.messages, saved.nativeContext)
      }, heldLease)
    }
    const request = normalizeSendRequest(input)
    // Resolve the task binding before dispatch. Provisioning failures must not
    // turn an isolated code request into a write to the registered checkout.
    if (session.sharedWorkspace) {
      // A read-only delegated child observes its parent's workspace (SPEC §14.2 `shared`).
      session.workspace = null
      session.projectCwd = session.sharedWorkspace.path
    } else if (session.threadId !== '__unbound__' && this.projectManager && this.threadStore) {
        const projectPath = resolveThreadProjectPath(
          this.projectManager,
          this.threadStore,
          session.threadId
        )
        const threadDir = this.resolveThreadDir(session.threadId)
        if (projectPath && threadDir) {
          await this.seedForkWorkspace(session.threadId, projectPath, threadDir, opts?.externalSignal, session.executionLease)
          session.workspace = await new WorkspaceResolver(threadDir, session.threadId, projectPath)
            .resolve(request.mode, 'main', opts?.externalSignal, session.executionLease ?? undefined)
          session.projectCwd = session.workspace.projectPath
        } else {
          session.workspace = null
          session.projectCwd = projectPath ? resolveProjectWorkingDirectory(projectPath) : null
        }
        // Only move worktree root when this is the bound session and no concurrent turn
        // is relying on ALS projectCwd alone (GUI tools that still read WorktreeManager).
        if (session.projectCwd && this.boundSession.threadId === session.threadId) {
          this.worktrees.setRepoRoot(session.projectCwd)
        }
    }

    // Pull any messages peers enqueued before we started.
    this.refreshSessionQueueFromDisk(session)
    session.drainedExternalSteerIds.clear()

    const userContent = request.content
    const mode = request.mode
    const images = request.images

    if (request.workflowInvocationId) {
      return await this.executeWorkflowChatTurn(session, request, opts)
    }

    const checkpointEnabled = Boolean(session.workspace?.capability.checkpointable)
    const conversationBranchId = recoveryManager?.load()?.conversationBranchId ?? 'main'
    const externalEffects = mode === 'agent' || mode === 'build' || typeof mode === 'object'
      ? [{ kind: 'unknown' as const, description: 'Agent tools may affect processes, ignored files, or external services; code undo only restores tracked workspace changes.', reversible: false as const }]
      : []
    const previousModel = previousTurnModel(session.messages, this.nativeContext)
    const turnPresentationStart = session.messages.length
    const turnNativeStartBoundary = {
      messageIndex: this.nativeContext.messages.length,
      activeStartIndex: this.nativeContext.activeStartIndex,
      compactionGeneration: this.nativeContext.compaction?.generation ?? 0,
      compaction: this.nativeContext.compaction ? structuredClone(this.nativeContext.compaction) : undefined,
      acceptedQueueItemIds: structuredClone(this.nativeContext.acceptedQueueItemIds ?? []),
      acceptedSteerItemIds: structuredClone(this.nativeContext.acceptedSteerItemIds ?? []),
      fidelity: this.nativeContext.fidelity === 'legacy-estimated'
        ? 'legacy' as const
        : this.nativeContext.compaction ? 'compacted' as const : 'exact' as const,
      safeBoundaryProof: 'captured before admitting the turn user message'
    }
    let turnStartSha: string | undefined
    if (checkpointEnabled && session.projectCwd) {
      requireCleanWorkspace(session.projectCwd, 'Thread workspace')
      turnStartSha = actionGit(session.projectCwd, ['rev-parse', 'HEAD'])
    }
    // Keep user commits visible in the sidebar. Internal orchestration wakes stay hidden.
    if (!reuseLastUser && displayUserMessage) {
      this.touchUserActivityAndNotify(session.threadId)
    }

    if (!reuseLastUser && displayUserMessage) {
      void this.generateInitialThreadTitle(session, userContent).catch(() => {})
    }

    try {
      if (!reuseLastUser) {
        // Automatic orchestration wakes belong in model context, not the user-facing timeline.
        // Queued and direct acceptance both mutate messages + native context then persist once.
        try {
          this.acceptTurnUserInput(
            session,
            userContent,
            images,
            displayUserMessage,
            queueItemId,
            mode,
            undefined,
            opts?.subagentNotice
          )
          claimAccepted = true
          this.notifyUserInputAccepted(session.threadId, opts?.onUserInputAccepted)
        } catch (err) {
          if (queueItemId) {
            const status = this.inspectDurableQueueProvenance(
              session.threadId,
              queueItemId
            )
            if (status === 'accepted') {
              // Partial write left durable provenance — never release/reappend.
              claimAccepted = true
              this.completeSessionClaim(session, queueItemId, claimOwnerToken)
            }
            // unavailable / not_accepted: outer catch settles claim fail-closed
          }
          throw err
        }
        // Complete the claim so restart will not re-append or re-execute it.
        if (queueItemId) {
          this.completeSessionClaim(session, queueItemId, claimOwnerToken)
        }
      }
    } catch (err) {
      if (queueItemId && !claimAccepted) {
        // Only definite not_accepted may release; accepted completes; unavailable leaves claim.
        this.settleClaimAfterFailure(
          session,
          queueItemId,
          claimOwnerToken,
          'pre-accept failure'
        )
      }
      throw err
    }
    this.transcript.reset()

    const turnId = opts?.runId ?? uuidv4()
    // Run Engine bridge (SPEC §5): the run id is the turn id; each mark is one CAS write.
    const engineRunId = this.runEngine ? opts?.runId : undefined
    let runTerminalMarked = false
    // `resultText` is the turn's final reply; a delegated child run publishes it (SPEC §14.1).
    const markRunTerminal = (status: 'completed' | 'interrupted' | 'failed', outcome?: { error?: string; interruptedBy?: 'user' | 'daemon_restart' }, resultText?: string): void => {
      if (runTerminalMarked) return
      runTerminalMarked = true
      this.markRun(engineRunId, (engine, id) => engine.markTerminal(id, status, outcome, { resultText }))
    }
    // C2: a run that cannot be marked starting (cancelled meanwhile, or held by another turn) is
    // not this turn's to run; it ends here, before any provider I/O.
    this.markRunStarting(engineRunId)
    this.deliverRestartNote(session.threadId, engineRunId)
    this.deliverContinuationNote(engineRunId)
    let conversationToolsUsed = false
    let providerProgress = false
    const conversationDirectory = !checkpointEnabled && !reuseLastUser && displayUserMessage && session.threadId !== '__unbound__' ? this.resolveThreadDir(session.threadId) : undefined
    if (conversationDirectory && session.executionLease) {
      new ConversationActionService(conversationDirectory).begin(turnId, conversationBranchId, turnPresentationStart, turnNativeStartBoundary, session.executionLease)
    }
    if (checkpointEnabled && turnStartSha && session.projectCwd) {
      const directory = this.resolveThreadDir(session.threadId)!
      new ThreadActionService(directory).beginTurn({
        threadId: session.threadId, turnId, conversationBranchId,
        workspacePath: session.projectCwd, heldThreadLease: session.executionLease ?? undefined, externalEffects,
        presentationMessageStart: turnPresentationStart, presentationMessageEnd: session.messages.length,
        nativeContextStartBoundary: turnNativeStartBoundary, nativeContextBoundary: turnNativeStartBoundary
      }, turnStartSha)
    }
    const turn = {
      abort: new AbortController(),
      pendingSteer: [] as string[],
      promotedSteerIds: [] as string[],
      ...(engineRunId ? { runId: engineRunId } : {})
    }
    const turnAuthority = session.executionLease ? new TaskWriterAuthority(session.executionLease) : undefined
    const turnWriter = turnAuthority?.issue(turnId, { version: 1, workspace: 'shared', access: 'write' })
    // The external signal's reason (a profile shutdown) travels with the abort.
    const mirrorExternalAbort = (): void => turn.abort.abort(opts?.externalSignal?.reason)
    if (opts?.externalSignal?.aborted) {
      mirrorExternalAbort()
    } else {
      opts?.externalSignal?.addEventListener('abort', mirrorExternalAbort, { once: true })
    }
    this.setTurnPhase(session.threadId, 'queued', { turnId })
    this.setTurnPhase(session.threadId, 'thinking', { turnId })
    this.markRun(engineRunId, (engine, id) => engine.markRunning(id))
    const checkpointTurn = async (state: 'completed' | 'stopped' | 'failed'): Promise<void> => {
      if ((!checkpointEnabled || !turnStartSha || !session.projectCwd) && !conversationDirectory || session.threadId === '__unbound__') return
      const threadDir = this.resolveThreadDir(session.threadId)
      if (!threadDir) return
      const checkpointOptions = {
        threadId: session.threadId,
        turnId,
        heldThreadLease: session.executionLease ?? undefined,
        externalEffects,
        conversationBranchId,
        workspacePath: session.projectCwd!,
        presentationMessageStart: turnPresentationStart,
        presentationMessageEnd: session.messages.length,
        nativeContextStartBoundary: turnNativeStartBoundary,
        nativeContextBoundary: {
          messageIndex: this.nativeContext.messages.length,
          activeStartIndex: this.nativeContext.activeStartIndex,
          compactionGeneration: this.nativeContext.compaction?.generation ?? 0,
          compaction: this.nativeContext.compaction ? structuredClone(this.nativeContext.compaction) : undefined,
          acceptedQueueItemIds: structuredClone(this.nativeContext.acceptedQueueItemIds ?? []),
          acceptedSteerItemIds: structuredClone(this.nativeContext.acceptedSteerItemIds ?? []),
          fidelity: this.nativeContext.fidelity === 'legacy-estimated'
            ? 'legacy' as const
            : this.nativeContext.compaction ? 'compacted' as const : 'exact' as const,
          safeBoundaryProof: state === 'completed'
            ? 'turn completed outside a partial tool call/result boundary'
            : undefined
        }
      }
      const action = conversationDirectory
        ? new ConversationActionService(conversationDirectory).settle(turnId, session.messages.length, checkpointOptions.nativeContextBoundary, state, conversationToolsUsed, session.executionLease!)
        : await new ThreadActionService(threadDir).checkpointExistingTurn(checkpointOptions, turnStartSha!, state)
      for (let index = turnPresentationStart; index < session.messages.length; index += 1) {
        session.messages[index] = {
          ...session.messages[index],
          turnId,
          actionId: action.id,
          conversationBranchId
        }
      }
    }
    this.activeTurn = turn
    this.applyRequestedAbort(session, turn)
    // Authoritative turn lifecycle boundary (includes queue/background turns).
    this.emit('turn-started', { threadId: session.threadId })

    const stagedApplets: AppletSubmission[] = []
    let assistantText: string
    let aborted = false
    let responseMetadata: ChatMessage['responseMetadata'] | undefined
    let connectionFailed = false
    let executionFailed = false
    let providerError: AppErrorShape | undefined
    let failureDiagnostic: Record<string, unknown> | undefined
    let compactionNote: ChatMessage | undefined
    let switchMarker: ChatMessage | undefined
    // Migrated to the instance shape (SPEC §13.8): `llmProvider` is re-derived from a known instance.
    const selectedModel = this.adapters.instances.migrate(opts?.modelOverride ?? session.modelOverride ?? resolveModelForMode(this.settingsStore.get(), mode, [
      ...(this.providerAuth.credentials?.listProviderIds() ?? []),
      ...this.adapters.configuredProviderIds()
    ]))
    if (displayUserMessage && !reuseLastUser) {
      const selection = { provider: selectedModel.llmProvider, model: selectedModel.model }
      const admittedUser = session.messages.slice(turnPresentationStart).find(message => message.role === 'user' && !message.hidden)
      if (admittedUser) {
        admittedUser.modelSelection = selection
        // The run this message opened; handoff transcripts group messages by run (SPEC §16.1).
        if (engineRunId) admittedUser.turnId = turnId
        this.emitMessageUpdated(admittedUser)
        const handoff = contextHandoff(previousModel, selection)
        if (handoff) {
          const marker: ChatMessage = { id: uuidv4(), role: 'assistant', kind: 'context_handoff',
            content: `${handoff.from.model} → ${handoff.to.model}`, contextHandoff: handoff,
            timestamp: new Date().toISOString(), turnId }
          session.messages.push(marker)
          this.emitMessageAdded(marker)
          switchMarker = marker
        }
        this.persist(true)
      }
    }
    // Set once the adapter is resolved; read by the post-turn action parsing below.
    let promptRuntime = false
    // SPEC §16.1-§16.2: context handed over this turn (provider switch, fork, merge-back).
    let handoffs: TurnHandoffs | null = null
    const onCompaction = (phase: 'start' | 'complete' | 'unchanged'): void => {
      if (phase === 'start') {
        compactionNote = { id: uuidv4(), role: 'assistant', kind: 'context_compaction',
          content: 'Compacting context…', streaming: true, timestamp: new Date().toISOString() }
        session.messages.push(compactionNote)
        this.emitMessageAdded(compactionNote)
      } else if (compactionNote) {
        compactionNote.content = phase === 'complete' ? 'Context compacted' : 'Context checked — no older messages to compact'
        compactionNote.streaming = false
        this.emitMessageUpdated(compactionNote)
        compactionNote = undefined
      }
      this.persist(true)
    }
    /** Finishes a compaction opened with `onCompaction('start')`; true when the transcript changed. */
    const compactTranscript = (): boolean => {
      const compacted = compactNativeContext(this.nativeContext)
      if (compacted === this.nativeContext) {
        onCompaction('unchanged')
        return false
      }
      this.nativeContext = compacted
      this.clearLastTurnUsage()
      this.persist(true)
      onCompaction('complete')
      return true
    }
    const compactedContext = (): RecoveredContext => ({
      messages: getActiveMessages(this.nativeContext),
      contextSummary: getCompactionSummary(this.nativeContext),
      nativeHistory: nativeAgentHistory(this.nativeContext, turnNativeStartBoundary.messageIndex)
    })
    // Prompt-injected runtimes keep their own transcript; their reply and reported metrics reach
    // the canonical transcript once, through `commitPromptTurn`.
    let promptMetrics: ProviderMetrics | undefined
    let promptTurnCommitted = false
    const promptContextKey = `${selectedModel.llmProvider}:${selectedModel.model}`
    const commitPromptTurn = (text: string): void => {
      if (promptTurnCommitted) return
      promptTurnCommitted = true
      const { llmProvider: provider, model } = selectedModel
      this.nativeContext = appendNativeMessage(this.nativeContext, nativeAgentAssistantMessage(text, promptMetrics?.realModelName ?? model, provider, promptMetrics?.usage))
      const context = promptMetrics?.context
      if (context) {
        const previousCapacity = this.nativeContext.nativeProviderModel
        this.nativeContext.nativeProviderModel = { provider, selectedModel: model, modelName: context.modelName ?? promptMetrics?.realModelName ?? model, contextWindow: context.contextWindow ?? (previousCapacity?.selectedModel === model ? previousCapacity.contextWindow : undefined) }
        this.recordLastTurnUsage({
          input: context.input, cacheRead: context.cacheRead, cacheWrite: context.cacheWrite,
          signature: promptContextKey, modelKey: promptContextKey,
          contextRevision: this.nativeContext.revision ?? 0,
          measuredAtHistoryLength: Math.max(0, getActiveMessages(this.nativeContext).length - 1)
        })
      }
      this.persist(true)
    }
    try {
      // Instance id → driver → adapter; an unknown or disabled instance, or a blank explicit
      // override, fails the turn here.
      const instance = this.adapters.resolveSelection(selectedModel, { unselectedDefault: !(opts?.modelOverride ?? session.modelOverride) })
      const adapter = instance.adapter
      // Issue #142: a read-only child is checked on every turn, not only when it was created. Its
      // provider may have been switched, or the user's setup changed, since then.
      if (session.sharedWorkspace) {
        const refusal = await this.targetRefusal(instance, 'shared', session.sharedWorkspace.path)
        // A known error keeps its message; an unknown one would reach the thread as a generic failure.
        if (refusal) throw new AppError({ code: refusal.code, message: refusal.message, errorInfo: { category: 'unavailable', retryable: false } })
      }
      // A transcript-native runtime (the pi loop) is sent Mousse's transcript and tools, so Mousse
      // keeps that transcript within the window before the turn. A prompt-injected runtime owns its
      // loop, context and tools and receives prior turns as a prompt preamble.
      promptRuntime = handoffDelivery(adapter.capabilities) === 'prompt_preamble'
      const modelOverride = opts?.modelOverride ?? session.modelOverride
      const contextSettings = normalizeContextSettings(this.settingsStore.get().context)
      const browserExecution = promptRuntime
        ? undefined
        : this.mainBrowserFactory
          ? this.mainBrowserFactory({ threadId: session.threadId, turnId, source: opts?.source, mode })
          : this.mainAgentBrowser?.execution.threadId === session.threadId && this.mainAgentBrowser.execution.turnId === turnId ? this.mainAgentBrowser : undefined
      let configuredThreshold: number | undefined
      if (!promptRuntime) {
        const { limit } = this.llm.getSelectedModelContextLimit(mode, modelOverride)
        let activeTokens = estimateActiveContextTokens(
          getActiveMessages(this.nativeContext),
          getCompactionSummary(this.nativeContext)
        )
        try {
          const contextInputs = await this.llm.getContextInputs(mode, userContent, {
            ...modelOverride,
            projectPath: session.projectCwd ?? undefined,
            browser: browserExecution,
            contextSummary: getCompactionSummary(this.nativeContext)
          })
          activeTokens += Math.ceil(((contextInputs.baseSystemPromptText ?? contextInputs.systemPromptText).length + contextInputs.mcpToolsText.length + contextInputs.otherToolsText.length) / 4)
        } catch {
          // Prompt preflight is advisory. The actual chat path owns provider/model
          // validation and produces the authoritative connection error.
        }
        configuredThreshold = resolveContextCompactionTokens(contextSettings.compactionTokens, limit)
        if (contextSettings.compactionEnabled && shouldCompactNativeContext(
          activeTokens,
          limit,
          DEFAULT_COMPACTION_RESERVE_TOKENS,
          configuredThreshold
        )) {
          onCompaction('start')
          await new Promise<void>((resolve) => setTimeout(resolve, 30))
          compactTranscript()
        }
      }
      handoffs = await this.planTurnHandoffs({
        session, runId: engineRunId, adapter, selection: selectedModel, previousModel, promptRuntime,
        content: userContent, images, mode, modelOverride
      })
      if (handoffs) this.recordHandoffMarkers(session, handoffs, switchMarker, turnId, selectedModel)
      const activeMessages = getActiveMessages(this.nativeContext)
      const turnInput: TurnInput = {
        runId: engineRunId ?? turnId,
        attemptId: (engineRunId ? this.runEngine?.getRun(engineRunId)?.activeAttemptId : undefined) ?? turnId,
        threadId: session.threadId,
        cwd: session.projectCwd ?? null,
        model: selectedModel.model,
        instanceId: instance.instanceId,
        llmProvider: instance.llmProvider,
        modelPinned: Boolean(modelOverride),
        mode,
        child: this.childTurnPolicy(session),
        prompt: handoffs ? handoffs.prompt(userContent) : userContent,
        messages: handoffs ? handoffs.messages(activeMessages) : activeMessages,
        // A switch handoff stands in for the transcript, including its compaction memory.
        contextSummary: handoffs?.replaceHistory ? undefined : getCompactionSummary(this.nativeContext),
        images,
        appletInstructions: this.appletStore ? this.appletCatalogue() : undefined,
        nativeHistory: promptRuntime
          ? handoffs?.replaceHistory ? '' : nativeAgentHistory(this.nativeContext, turnNativeStartBoundary.messageIndex)
          : undefined,
        signal: turn.abort.signal
      }
      const turnSink: TurnSink = {
        text: (event) => this.handleStreamingTextEvent(event),
        thinking: (event) => this.handleStreamingThinkingEvent(event),
        tool: (event) => {
          if (event.kind !== 'skill_loaded') conversationToolsUsed = true
          this.handleStreamingToolEvent(event)
        },
        nativeMessages: (nativeMessages, checkpoint) => {
          // A completed-turn measurement becomes stale as soon as the live loop
          // appends or compacts native history. Estimate until the final provider
          // response supplies a new authoritative prompt measurement.
          this.clearLastTurnUsage()
          this.commitActiveNativeMessages(handoffs && !checkpoint ? handoffs.canonical(nativeMessages) : nativeMessages, checkpoint)
          if (session.drainedExternalSteerIds.size > 0) {
            this.nativeContext = {
              ...this.nativeContext,
              acceptedSteerItemIds: Array.from(new Set([
                ...(this.nativeContext.acceptedSteerItemIds ?? []),
                ...session.drainedExternalSteerIds
              ]))
            }
          }
          this.persist(true)
          // The fork or merge-back history this turn was handed is canonical now (SPEC §16.2).
          handoffs?.committed()
          this.acknowledgeDrainedSteers(session)
          if (session.executionLease) {
            heartbeatExecutionLease(session.executionLease)
          }
        },
        compaction: onCompaction,
        retry: (attempt) => this.addSystemMessage(`Retrying provider request (${attempt}/5)…`),
        progress: () => { providerProgress = true },
        // Runtimes that do not record usage themselves; LlmClient records pi usage, and
        // recordLastTurnUsage consumes the TurnResult below.
        usage: (usage) => this.lineEditStats?.recordUsage({
          timestamp: new Date().toISOString(), provider: selectedModel.llmProvider,
          model: promptMetrics?.realModelName ?? selectedModel.model, input: usage.input, output: usage.output,
          cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite
        }),
        providerRef: (ref) => this.markRun(engineRunId, (engine, id) => { engine.recordProviderRef(id, ref) }),
        steerAccepted: (text) => {
          this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(text))
          this.nativeContext.acceptedSteerItemIds = Array.from(new Set([
            ...(this.nativeContext.acceptedSteerItemIds ?? []), ...session.drainedExternalSteerIds
          ]))
          this.persist(true)
          this.acknowledgeDrainedSteers(session)
        },
        providerMetrics: (metrics) => { promptMetrics = metrics },
        lineEdits: (lines) => this.lineEditStats?.record('orchestrator', lines)
      }
      const turnControl: TurnControl = {
        drainSteer: () => {
          const parts = [
            opts?.externalDrainSteer?.()?.trim(),
            this.drainSteerForSession(session, turn)?.trim()
          ].filter((part): part is string => Boolean(part))
          return parts.length > 0 ? parts.join('\n') : undefined
        },
        heartbeat: () => this.heartbeatRun(engineRunId)
      }
      const mcp = this.mcpFor(adapter, instance.instanceId, session.threadId, engineRunId, mode)
      const adapterHost: AdapterHost = {
        mcp,
        tools: {
          onPublishApplet: this.appletStore ? (value) => {
            if (stagedApplets.length >= 3) throw new Error('Only three applets may be published per response.')
            stagedApplets.push(validateAppletSubmission(value))
            return { queued: true, title: stagedApplets[stagedApplets.length - 1].title }
          } : undefined,
          browser: browserExecution,
          delegation: engineRunId && this.effectsEnabled() ? this.delegationTools(session, engineRunId, this.modeCeilingFor(session.threadId, mode)) : undefined,
          toolAccess: session.sharedWorkspace
            ? createAgentToolAccess(SHARED_READER_POLICY, session.sharedWorkspace.path)
            : turnAuthority && turnWriter ? { allows: () => true, execute: (_name, _args, run) => { conversationToolsUsed = true; return turnAuthority.runWriter(turnWriter, run) } } : undefined,
          toolLedger: this.toolLedgerFor(engineRunId)
        },
        context: {
          // In-loop compaction checkpoints index the sent transcript; a switch handoff is not canonical.
          toolLoopSafety: contextSettings.compactionEnabled && configuredThreshold !== undefined && !handoffs?.replaceHistory
            ? {
                compactionThresholdTokens: configuredThreshold,
                compactNativeMessages: (nativeMessages) =>
                  compactMessagesAtSafeBoundary(nativeMessages, undefined, this.nativeContext.compaction)
              }
            : undefined,
          recoverOverflow: () => {
            if (conversationToolsUsed || providerProgress || !contextSettings.compactionEnabled) return null
            onCompaction('start')
            return compactTranscript() ? compactedContext() : null
          },
          prepareNativeContext: (provider, model) => {
            const capacity = this.nativeContext.nativeProviderModel
            const knownLimit = capacity?.selectedModel === model ? capacity.contextWindow : undefined
            const threshold = typeof contextSettings.compactionTokens === 'number'
              ? contextSettings.compactionTokens : knownLimit
            const previous = session.lastMeasuredContextSignature === `${provider}:${model}`
              ? (session.lastMeasuredInput ?? 0) + (session.lastMeasuredCacheRead ?? 0) + (session.lastMeasuredCacheWrite ?? 0)
              : 0
            const activeTokens = Math.max(previous, estimateActiveContextTokens(getActiveMessages(this.nativeContext), getCompactionSummary(this.nativeContext)))
            // When the runtime has not reported capacity yet, a numeric Mousse threshold
            // still applies; model-max waits for an actual provider window.
            if (!contextSettings.compactionEnabled || threshold === undefined ||
                !shouldCompactNativeContext(activeTokens, knownLimit ?? threshold, DEFAULT_COMPACTION_RESERVE_TOKENS, threshold)) return null
            onCompaction('start')
            const recovered = compactTranscript() ? compactedContext() : null
            return recovered && handoffs?.replaceHistory ? { ...recovered, nativeHistory: '' } : recovered
          },
          nativeHistoryAfterTurn: (text) => {
            commitPromptTurn(text)
            return nativeAgentHistory(this.nativeContext)
          },
          nativeHistoryNow: () => nativeAgentHistory(this.nativeContext)
        }
      }
      const result = await adapter.startTurn(turnInput, turnSink, turnControl, adapterHost)
        .finally(() => { if (mcp) this.endMcpTurn(session.threadId) })
      handoffs?.settle(result.aborted || turn.abort.signal.aborted ? 'aborted' : 'completed')
      assistantText = result.text
      aborted = Boolean(result.aborted)
      responseMetadata = {
        modelName: result.modelName,
        totalResponseTimeMs: result.totalResponseTimeMs,
        tokensUsed: result.totalTokensUsed,
        tokensPerSecond: result.tokensPerSecond
      }
      if (promptRuntime) {
        // No-op when the adapter already committed through `nativeHistoryAfterTurn`.
        commitPromptTurn(result.text)
      } else {
        this.commitActiveNativeMessages(handoffs ? handoffs.canonical(result.nativeMessages) : result.nativeMessages)
        if (handoffs) {
          this.persist(true)
          handoffs.committed()
        }
        // Provider prompt usage excludes the assistant message it produced.
        this.recordLastTurnUsage({
          input: result.usage.input,
          cacheRead: result.usage.cacheRead,
          cacheWrite: result.usage.cacheWrite,
          signature: result.contextSignature,
          measuredAtHistoryLength: Math.max(0, getActiveMessages(this.nativeContext).length - 1),
          contextRevision: this.nativeContext.revision ?? 0,
          modelKey: result.contextModelKey
        })
      }
    } catch (err) {
      const normalized = normalizeAppError(err, 'orchestrator_turn_failed')
      const isAbort = turn.abort.signal.aborted || normalized.errorInfo.category === 'cancelled'
      handoffs?.settle('failed', err instanceof Error ? err.message : String(err))
      if (!isAbort) failureDiagnostic = errorDiagnostic(normalized, 'orchestrator.chat')
      if (isAbort) {
        aborted = true
        assistantText = ''
      } else if (err instanceof ConnectionRetriesExhaustedError) {
        connectionFailed = true
        providerError = serializeAppError(normalized)
        assistantText = ''
      } else {
        executionFailed = true
        providerError = serializeAppError(normalized)
        assistantText = `[${providerError.code}] ${providerError.message}`
      }
    } finally {
      if (compactionNote) onCompaction('unchanged')
      if (turn.abort.signal.aborted) aborted = true
      opts?.externalSignal?.removeEventListener('abort', mirrorExternalAbort)
      // The turn remains active until post-stream persistence/actions finish.
    }

    let turnSettled = false
    const settleOnce = (wasAborted: boolean, failed = false): void => {
      if (turnSettled) return
      turnSettled = true
      this.settleActiveTurn(session, turn, wasAborted, opts, failed)
    }
    try {

    this.transcript.closeThinking()

    if (providerError) {
      console.error('Orchestrator turn failed', failureDiagnostic ?? errorDiagnostic(providerError, 'orchestrator.chat'))
      this.transcript.abandonAssistant(this.transcript.openAssistantContent() ?? '', false)
      const message = `[${providerError.code}] ${providerError.message}`
      this.addSystemMessage(message)
      const failure = this.messages.at(-1)!
      failure.error = providerError
      this.emitMessageUpdated(failure)
      if (connectionFailed) {
        this.failedConnectionRequest = input
        this.emit('connection-failed', { threadId: session.threadId, error: providerError })
      }
      this.setTurnPhase(session.threadId, 'failed', { error: message, errorDescriptor: providerError })
      markRunTerminal('failed', { error: message })
      await checkpointTurn('failed')
      this.persist(true)
      const response: OrchestratorResponse = { message, actions: [], error: providerError }
      this.emit('response', response)
      settleOnce(false, true)
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return response
    }

    if (aborted) {
      const partial =
        stripActionBlocks(assistantText).trim() ||
        this.transcript.openAssistantContent()?.trim() ||
        ''
      if (!this.transcript.abandonAssistant(partial, true) && partial) {
        const stopped = this.addMessage('assistant', partial)
        const index = this.messages.findIndex((message) => message.id === stopped.id)
        if (index !== -1) {
          const updated = { ...this.messages[index], incomplete: true }
          this.messages[index] = updated
          this.emitMessageUpdated(updated)
        }
      }
      // SPEC §12.5: a profile shutdown is a restart, not a user's Stop; the next boot notes it.
      const restart = this.isShutdownAbort(turn.abort.signal.reason)
      this.addSystemMessage(restart ? 'Turn interrupted by a Mousse restart.' : 'Turn stopped.')
      const response: OrchestratorResponse = { message: partial, actions: [] }
      this.setTurnPhase(session.threadId, 'stopped')
      markRunTerminal('interrupted', { interruptedBy: restart ? 'daemon_restart' : 'user' }, partial)
      await checkpointTurn('stopped')
      this.persist(true)
      // Cross-channel IPC delivery and an in-flight renderer snapshot can otherwise leave
      // the persisted stopped message invisible until the thread is reopened.
      this.emitThreadMessages(session.threadId, session.messages)
      this.emit('response', response)
      settleOnce(true)
      // Stop aborts the active turn but retains normal queued messages.
      return response
    }

    if (mode === 'plan') {
      const planMarkdown = (stripActionBlocks(assistantText) || assistantText.trim() || 'No plan generated.') + stagedApplets.map(source => '\n\n```mousse-applet\n' + JSON.stringify(source) + '\n```').join('')
      if (this.activeAssistantMessageId) {
        const streamingId = this.activeAssistantMessageId
        this.activeAssistantMessageId = null
        this.removeMessage(streamingId)
      }
      const planMsg = this.addPlanCardMessage(userContent, planMarkdown, responseMetadata)
      if (this.appletStore && !executionFailed) {
        planMsg.turnId = turnId
        this.persist(true)
        planMsg.presentationParts = publishAppletPresentation(this.appletStore, {threadId:session.threadId,messageId:planMsg.id,turnId,content:planMsg.content})
        this.persist(true)
        this.emitMessageUpdated(planMsg)
      }
      const response: OrchestratorResponse = {
        message: planMsg.content,
        actions: []
      }
      this.setTurnPhase(session.threadId, 'finalizing')
      this.markRun(engineRunId, (engine, id) => engine.markFinalizing(id))
      await checkpointTurn('completed')
      this.persist(true)
      this.setTurnPhase(session.threadId, 'completed')
      markRunTerminal('completed', undefined, planMsg.content)
      this.emit('response', response)
      this.emitThreadMessages(session.threadId, session.messages)
      settleOnce(false)
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return response
    }

    // Vendor runtimes act through their own tools; `mousse-actions` blocks are a pi-loop protocol.
    const parsedActions = promptRuntime ? [] : parseActions(assistantText)
    const actions = filterActionsForChatMode(parsedActions, mode)
    const displayText = stripActionBlocks(assistantText) + stagedApplets.map(source => '\n\n```mousse-applet\n' + JSON.stringify(source) + '\n```').join('')

    if (this.activeAssistantMessageId) {
      this.updateStreamingAssistantMessage(
        this.activeAssistantMessageId,
        displayText || 'Done.',
        false,
        responseMetadata
      )
      this.activeAssistantMessageId = null
    } else if (
      this.lastCompletedAssistantMessageId &&
      stripActionBlocks(this.lastCompletedAssistantContent) === displayText
    ) {
      // Compare stripped-to-stripped: the streamed snapshot is raw (often
      // trailing whitespace / action fences) while displayText is stripped.
      // A raw === stripped comparison fails on whitespace alone and appends
      // a visually identical twin message.
      this.updateStreamingAssistantMessage(
        this.lastCompletedAssistantMessageId,
        displayText,
        false,
        responseMetadata
      )
    } else {
      this.addMessage('assistant', displayText || 'Done.', undefined, responseMetadata)
    }

    if (this.appletStore && !executionFailed) {
      const finalMessage = [...session.messages].reverse().find(message => message.role === 'assistant' && !message.kind && message.content === (displayText || 'Done.'))
      if (finalMessage) {
        finalMessage.turnId = turnId
        this.persist(true)
        finalMessage.presentationParts = publishAppletPresentation(this.appletStore, { threadId: session.threadId, messageId: finalMessage.id, turnId, content: finalMessage.content })
        this.persist(true)
        this.emitMessageUpdated(finalMessage)
      }
    }

    for (const action of actions) {
      if (rejectOrchestrationAction(action, mode)) {
        const modeLabel = getChatModeLabel(mode)
        this.addSystemMessage(
          `[${modeLabel.toLowerCase()}] Blocked orchestration action "${action.type}" — ${modeLabel} mode cannot complete tasks.`
        )
        continue
      }
      conversationToolsUsed = true
      const toolCallMessage = this.addToolCallMessage(action)
      try {
        const logs = await this.executeAction(action)
        const failures = logs.filter(isActionFailureLog)
        this.updateToolTimelineMessage(
          toolCallMessage.id,
          {
            title:
              action.type === 'complete_task'
                ? failures.length > 0
                  ? 'Task completion finished with errors'
                  : 'Task completed'
                : toolCallMessage.toolCall?.title ?? 'Action completed',
            summary:
              failures.at(-1) ??
              logs.at(-1) ??
              (action.type === 'message' ? action.content : 'Action completed successfully.'),
            details: logs.length > 0 ? logs : ['Action completed without additional output.'],
            status: 'complete'
          },
          true
        )
        if (action.type === 'complete_task') {
          const wake = buildCompleteTaskFailureWake(action.agentIds, logs) ?? buildCompleteTaskSuccessWake(action.agentIds, logs)
          if (wake) this.postThreadNotice(wake)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.updateToolTimelineMessage(
          toolCallMessage.id,
          {
            title: 'Action failed',
            summary: message,
            details: [message],
            status: 'complete'
          },
          true
        )
        this.addSystemMessage(`[action failed] ${message}`)
        if (action.type === 'complete_task') {
          const wakeMessage = buildCompleteTaskFailureWake(action.agentIds, [
            `[complete] Failed: ${message}`
          ])
          if (wakeMessage) this.postThreadNotice(wakeMessage)
        }
      }
    }

    const modeOrchestrates = (() => {
      if (typeof mode === 'string') {
        try {
          const desc = this.modeRegistry.getModeSync(mode, {})
          if (desc) return desc.permission?.['task'] !== 'deny'
        } catch (error) {
          logDebug('OrchestratorService', 'mode lookup failed; falling back to default orchestration rules', error, { mode })
        }
      }
      return allowsOrchestrationActions(mode)
    })()
    if (!modeOrchestrates && parsedActions.length > actions.length) {
      const modeLabel = getChatModeLabel(mode).toLowerCase()
      this.addSystemMessage(`[${modeLabel}] Ignored orchestration actions emitted by the model.`)
    }

    const response: OrchestratorResponse = {
      message: displayText || 'Done.',
      actions
    }
    if (executionFailed) {
      this.setTurnPhase(session.threadId, 'failed', { error: 'LLM error' })
      markRunTerminal('failed', { error: 'LLM error' }, displayText)
    } else {
      this.setTurnPhase(session.threadId, 'finalizing')
      this.markRun(engineRunId, (engine, id) => engine.markFinalizing(id))
    }
    await checkpointTurn(executionFailed ? 'failed' : 'completed')
    this.persist(true)
    if (!executionFailed) {
      this.setTurnPhase(session.threadId, 'completed')
      markRunTerminal('completed', undefined, displayText || 'Done.')
    }
    this.emit('response', response)
    this.emitThreadMessages(session.threadId, session.messages)
    settleOnce(aborted, executionFailed)
    this.releaseSessionExecutionLease(session)
    if (!suppressAutoQueueDrain) session.drainAfterSettle = true
    return response
    } finally {
      settleOnce(aborted, connectionFailed || executionFailed)
    }
  }

  /**
   * Drain local pendingSteer plus any durable external steer-intent items once.
   * External steers remain durable until the resulting native context checkpoint commits.
   * Locally-promoted items (tracked on the turn) were already injected via
   * pendingSteer, so they are excluded from the external scan and acknowledged
   * exactly once their content has been durably added to native history.
   */
  private drainSteerForSession(
    session: ThreadSession,
    turn: { pendingSteer: string[]; promotedSteerIds: string[]; carriedSteers?: ActiveTurnControl['carriedSteers'] }
  ): string | undefined {
    const parts: string[] = []
    if (turn.pendingSteer.length > 0) {
      parts.push(...turn.pendingSteer)
      turn.pendingSteer = []
      // The model reads them now: the rows their steers carried are delivered to this run.
      for (const entry of turn.carriedSteers ?? []) this.runEngine?.inbox.markSteerTaken(entry.inboxIds, entry.effectId)
      turn.carriedSteers = []
    }

    const localPromoted = new Set<string>(turn.promotedSteerIds ?? [])
    const channelTurn = this.channelTurns.get(session.threadId)
    if (channelTurn) {
      for (const id of channelTurn.promotedSteerIds ?? []) localPromoted.add(id)
    }
    for (const id of localPromoted) session.drainedExternalSteerIds.add(id)

    // Refresh durable queue so peer CLI/GUI steers are visible mid-turn.
    this.refreshSessionQueueFromDisk(session)
    const externalSteers = listPendingQueue(session.queue).filter(
      (item) =>
        item.intent === 'steer' &&
        (item.state === 'pending' || item.state === 'steering') &&
        !session.drainedExternalSteerIds.has(item.id)
    )
    if (externalSteers.length > 0) {
      for (const item of externalSteers) {
        parts.push(item.content)
        session.drainedExternalSteerIds.add(item.id)
      }
    }
    turn.promotedSteerIds = []
    if (channelTurn && (channelTurn.promotedSteerIds ?? []).length > 0) {
      channelTurn.promotedSteerIds = []
    }

    if (session.executionLease) {
      heartbeatExecutionLease(session.executionLease)
    }

    const text = parts.join('\n').trim()
    return text || undefined
  }

  /** Remove steer queue entries only after their content and IDs are durable. */
  private acknowledgeDrainedSteers(session: ThreadSession): void {
    const ids = [...session.drainedExternalSteerIds]
    if (ids.length === 0) return
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, session.threadId, (disk) =>
        dropSteerItems(disk, ids)
      )
    } else {
      session.queue = dropSteerItems(session.queue, ids)
    }
    session.drainedExternalSteerIds.clear()
    this.emitQueueUpdated(session.threadId, session.queue)
    const accepted = new Set(this.nativeContext.acceptedSteerItemIds ?? [])
    for (const id of ids) accepted.delete(id)
    this.nativeContext = {
      ...this.nativeContext,
      acceptedSteerItemIds: accepted.size > 0 ? [...accepted] : undefined
    }
    this.persist(true)
  }

  /**
   * After a turn settles, FIFO-claim the next normal queued message for the thread.
   * Steer-intent items are never drained as normal turns.
   * Re-reads durable queue so peer enqueues during the turn are not missed.
   *
   * When `managedByStartup` is true, the started turn suppresses ordinary internal
   * auto-drain so the startup pump retains exclusive control of chaining under the
   * concurrency bound.
   *
   * Accepted provenance is loaded **inside** the queue mutation critical section
   * (loadThreadData does not take the queue lock). Read failures abort the mutation
   * without saving — never reclaim/claim from an empty fallback.
   *
   * `onSettled` receives:
   * - `idle` — nothing claimed
   * - `ran` — turn finished without rejection
   * - `failed` — turn rejected (startup must not infinite-retry the same failure)
   */
  private scheduleQueueDrain(
    session: ThreadSession,
    opts?: {
      onSettled?: (result: 'idle' | 'ran' | 'failed') => void
      managedByStartup?: boolean
    }
  ): void {
    const settle = (result: 'idle' | 'ran' | 'failed'): void => {
      opts?.onSettled?.(result)
    }
    if (this.lifecycle.stopping) { settle('idle'); return }
    if (session.deleted || session.threadId === '__unbound__') {
      settle('idle')
      return
    }
    if (session.isTurnRunning()) {
      settle('idle')
      return
    }
    this.reclaimStaleThreadLease(session.threadId)
    if (this.isThreadLeaseHeldExternally(session.threadId, session.executionLease?.owner.token)) {
      settle('idle')
      return
    }
    // Active owner re-reads durable queue before claim.
    this.refreshSessionQueueFromDisk(session)
    const claimToken = createLeaseToken()
    const claimOwner = {
      ownerPid: process.pid,
      ownerToken: claimToken,
      claimedAt: new Date().toISOString(),
      source: 'orchestrator'
    }
    let claimed: QueuedMessage | null = null
    try {
      if (this.threadStore) {
        const store = this.threadStore
        const threadId = session.threadId
        session.queue = mutateDurableQueue(store, threadId, (disk) => {
          // Provenance inside the same critical section as reclaim/claim (fail closed).
          const data = store.loadThreadData(threadId)
          const nativeAcceptedQueueIds = new Set(data.llmContext?.acceptedQueueItemIds ?? [])
          const transcriptAcceptedQueueIds = new Set(
            data.messages
              .filter((message) => typeof message.queueItemId === 'string')
              .map((message) => message.queueItemId as string)
          )
          const ambiguous = disk.find((item) =>
            transcriptAcceptedQueueIds.has(item.id) !== nativeAcceptedQueueIds.has(item.id)
          )
          if (ambiguous) {
            throw new Error(`QUEUE_PROVENANCE_UNAVAILABLE:${ambiguous.id}`)
          }
          const acceptedIds = new Set(
            data.messages
              .filter((message) =>
                typeof message.queueItemId === 'string' &&
                nativeAcceptedQueueIds.has(message.queueItemId)
              )
              .map((message) => message.queueItemId as string)
          )
          const acceptedSteerIds = new Set(data.llmContext?.acceptedSteerItemIds ?? [])
          // Opportunistically complete accepted claims whose queue-file complete failed earlier.
          // Does not release unaccepted live-owner claims.
          const cleaned = reclaimAbandonedClaims(disk, {
            isOwnerLive: (claim) => isProcessAlive(claim.ownerPid),
            isAccepted: (item) => acceptedIds.has(item.id)
          }).items
          const demoted = demoteSteerItems(dropSteerItems(cleaned, [...acceptedSteerIds]))
          const result = claimNextNormal(demoted, claimOwner)
          claimed = result.claimed
          return result.items
        })
      } else {
        const demoted = demoteSteerItems(session.queue)
        const result = claimNextNormal(demoted, claimOwner)
        session.queue = result.items
        claimed = result.claimed
      }
    } catch (err) {
      this.emit('queue-drain-failed', {
        threadId: session.threadId,
        error: err instanceof Error ? err.message : String(err)
      })
      settle('failed')
      return
    }
    this.emitQueueUpdated(session.threadId, session.queue)
    if (!claimed) {
      settle('idle')
      return
    }
    if (this.threadStore && !this.threadStore.getThread(session.threadId)) {
      session.deleted = true
      session.queue = []
      settle('idle')
      return
    }
    let item = claimed as QueuedMessage
    const managedByStartup = opts?.managedByStartup === true
    // The Stop fence at promotion: an entry that starts work on behalf of a parent and was queued before a
    // Stop of its thread is refused (a Stop removes such entries itself; this catches one that outlived it).
    if (item.stopGeneration !== undefined && this.runEngine && item.stopGeneration < currentStopGeneration(this.runEngine.store, session.threadId)) {
      this.refuseFencedQueueItem(session, item, claimToken)
      this.scheduleQueueDrain(session, opts)
      return
    }
    if (item.inboxIds?.length && this.runEngine) {
      // A queued steer that carries notices is rebuilt now: a row acknowledged since it was queued
      // (a `task_status` read) is dropped, and with none left there is nothing to deliver.
      const rows = this.dropStaleQuestionRows(this.runEngine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === queueOwner(item.id)))
      if (rows.length === 0) {
        this.completeSessionClaim(session, item.id, claimToken)
        this.scheduleQueueDrain(session, opts)
        return
      }
      const planned = planWakeNotice(rows, this.noticeContext())
      this.runEngine.inbox.recordNoticeVisibility(rows, planned.items)
      item = { ...item, content: planned.text, inboxIds: rows.map((row) => row.inboxId), subagentNotice: planned.items }
    }
    const queued = item
    const startClaimed = (runId: string | undefined, admissionHeld: boolean): Promise<OrchestratorResponse> => this.startTurn(session, {
      runId,
      threadId: session.threadId,
      input: {
        content: queued.content,
        workflowInvocationId: queued.workflowInvocationId,
        mode: queued.mode,
        images: queued.images
      },
      reuseLastUser: false,
      displayUserMessage: !queued.internal,
      queueItemId: queued.id,
      claimOwnerToken: claimToken,
      source: queued.source,
      suppressAutoQueueDrain: managedByStartup,
      admissionHeld,
      ...(queued.inboxIds?.length ? { inboxIds: queued.inboxIds, subagentNotice: queued.subagentNotice } : {})
    })
    let started: Promise<OrchestratorResponse>
    if (!item.runId && this.runEngine) {
      // Hold admission across the run-record await so no concurrent send can start a turn.
      session.turnAdmitted = true
      started = this.ensureQueueItemRun(item).then((runId) => startClaimed(runId, true))
    } else {
      // With effects, startTurn admits the claim now and keeps it admitted until the executor runs.
      started = startClaimed(item.runId, false)
    }
    void started
      .then(() => {
        settle('ran')
      })
      .catch((err) => {
        // Fail-closed: only definite not_accepted may release.
        this.settleClaimAfterFailure(
          session,
          item.id,
          claimToken,
          err instanceof Error ? err.message : String(err)
        )
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId: item.id,
          error: err instanceof Error ? err.message : String(err)
        })
        settle('failed')
      })
  }

  /**
   * Startup / headless recovery: reclaim abandoned claims then drain pending normal work
   * without requiring the GUI. Bounded and non-blocking — does not steal live ownership.
   */
  scheduleStartupQueueRecovery(): void {
    if (this.lifecycle.stopping) return
    if (!this.threadStore) return
    setImmediate(() => {
      try {
        this.recoverAndDrainPendingQueues()
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: null,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  }

  /**
   * Reclaim abandoned claims, then drain pending work with a small concurrency bound.
   * Every eligible thread is considered in deterministic list order; completion/failure
   * advances the startup queue. Does not block the caller.
   */
  recoverAndDrainPendingQueues(): void {
    if (this.lifecycle.stopping) return
    if (!this.threadStore) return
    const threads = this.threadStore.listAllThreads()
    // Deterministic order for scheduling.
    const ordered = [...threads].sort((a, b) => a.id.localeCompare(b.id))

    for (const thread of ordered) {
      if (thread.settledAt) continue
      try {
        this.reclaimAbandonedClaimsForThread(thread.id)
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    for (const thread of ordered) {
      if (thread.settledAt) continue
      if (this.startupDrainScheduled.has(thread.id)) continue
      try {
        const session = this.getOrCreateSession(thread.id)
        if (session.deleted || session.isTurnRunning()) continue
        this.reclaimStaleThreadLease(thread.id)
        if (this.isThreadLeaseHeldExternally(thread.id, session.executionLease?.owner.token)) {
          continue
        }
        // Only enqueue threads that still have pending normal work after reclaim.
        this.refreshSessionQueueFromDisk(session)
        const hasPendingNormal = listPendingQueue(session.queue).some(
          (item) => item.intent === 'normal' && item.state === 'pending'
        )
        if (!hasPendingNormal) continue
        this.startupDrainScheduled.add(thread.id)
        this.startupDrainPending.push(thread.id)
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    this.pumpStartupDrainQueue()
  }

  private pumpStartupDrainQueue(): void {
    if (this.lifecycle.stopping) return
    while (
      this.startupDrainActive < OrchestratorService.STARTUP_QUEUE_DRAIN_CONCURRENCY &&
      this.startupDrainPending.length > 0
    ) {
      const threadId = this.startupDrainPending.shift()!
      const session = this.getOrCreateSession(threadId)
      this.reclaimStaleThreadLease(threadId)
      if (
        session.deleted ||
        session.isTurnRunning() ||
        this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)
      ) {
        this.startupDrainScheduled.delete(threadId)
        continue
      }
      this.startupDrainActive += 1
      // Startup-managed: one turn per slot. Internal auto-drain is suppressed so chaining
      // stays under this pump and concurrency never exceeds STARTUP_QUEUE_DRAIN_CONCURRENCY.
      this.scheduleQueueDrain(session, {
        managedByStartup: true,
        onSettled: (result) => {
          this.startupDrainActive = Math.max(0, this.startupDrainActive - 1)
          this.startupDrainScheduled.delete(threadId)
          // Only chain further items after a successful run. Failures advance the
          // startup queue without infinite-retrying the same pre-accept error.
          if (result === 'ran') {
            try {
              if (!session.deleted && !session.isTurnRunning()) {
                this.refreshSessionQueueFromDisk(session)
                const more = listPendingQueue(session.queue).some(
                  (item) => item.intent === 'normal' && item.state === 'pending'
                )
                if (
                  more &&
                  !this.isThreadLeaseHeldExternally(
                    threadId,
                    session.executionLease?.owner.token
                  ) &&
                  !this.startupDrainScheduled.has(threadId)
                ) {
                  this.startupDrainScheduled.add(threadId)
                  this.startupDrainPending.push(threadId)
                }
              }
            } catch {
              // best-effort requeue
            }
          }
          this.pumpStartupDrainQueue()
        }
      })
    }
  }

  /**
   * Reclaim abandoned claims for a thread.
   * Accepted claims (transcript provenance) complete even while the owner process is live.
   * Unaccepted claims are released only when ownership is demonstrably stale/dead.
   * Provenance is loaded inside the queue mutation lock (fail closed on read errors).
   */
  reclaimAbandonedClaimsForThread(threadId: string): QueuedMessage[] {
    if (!this.threadStore) return []
    if (!this.threadStore.getThread(threadId)) return []

    // Default durable reclaim loads accepted ids inside the mutation critical section.
    const result = reclaimAbandonedClaimsDurable(this.threadStore, threadId, {
      isOwnerLive: (claim) => isProcessAlive(claim.ownerPid)
    })

    const session =
      this.boundSession.threadId === threadId
        ? this.boundSession
        : this.sessions.get(threadId)
    if (session) {
      session.queue = result.items
    }
    this.emitQueueUpdated(threadId, result.items)
    return result.items
  }

  /**
   * Release a claim on the durable store. Durable errors are not masked by session-only
   * mutation — the claim stays for recovery and diagnostics are emitted.
   */
  private releaseSessionClaim(
    session: ThreadSession,
    itemId: string,
    ownerToken?: string
  ): QueuedMessage | null {
    if (this.threadStore && session.threadId !== '__unbound__') {
      try {
        const released = releaseClaimDurable(this.threadStore, session.threadId, itemId, {
          ownerToken
        })
        session.queue = readDurableQueue(this.threadStore, session.threadId)
        this.emitQueueUpdated(session.threadId, session.queue)
        return released
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId: itemId,
          error: `release claim failed: ${err instanceof Error ? err.message : String(err)}`
        })
        try {
          session.queue = readDurableQueue(this.threadStore, session.threadId)
          this.emitQueueUpdated(session.threadId, session.queue)
        } catch {
          // leave session queue untouched rather than lying about disk state
        }
        return null
      }
    }
    const result = releaseClaim(session.queue, itemId, { ownerToken })
    session.queue = result.items
    this.emitQueueUpdated(session.threadId, session.queue)
    return result.released
  }

  /**
   * Complete a claim on the durable store after transcript acceptance.
   * Durable errors keep the claim for provenance-based recovery (no session-only lie).
   */
  private completeSessionClaim(
    session: ThreadSession,
    itemId: string,
    ownerToken?: string
  ): QueuedMessage | null {
    if (this.threadStore && session.threadId !== '__unbound__') {
      try {
        const completed = completeClaimDurable(this.threadStore, session.threadId, itemId, {
          ownerToken
        })
        session.queue = readDurableQueue(this.threadStore, session.threadId)
        this.emitQueueUpdated(session.threadId, session.queue)
        if (completed && session.nativeContext.acceptedQueueItemIds?.includes(itemId)) {
          const remaining = session.nativeContext.acceptedQueueItemIds.filter((id) => id !== itemId)
          session.nativeContext = {
            ...session.nativeContext,
            acceptedQueueItemIds: remaining.length > 0 ? remaining : undefined
          }
          this.persist(true)
        }
        return completed
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId: itemId,
          error: `complete claim failed: ${err instanceof Error ? err.message : String(err)}`
        })
        try {
          session.queue = readDurableQueue(this.threadStore, session.threadId)
          this.emitQueueUpdated(session.threadId, session.queue)
        } catch {
          // leave session queue untouched rather than lying about disk state
        }
        return null
      }
    }
    const result = completeClaim(session.queue, itemId, { ownerToken })
    session.queue = result.items
    this.emitQueueUpdated(session.threadId, session.queue)
    return result.completed
  }

  retryLastConnection(threadId?: string): boolean {
    if (this.lifecycle.stopping) return false
    const session = threadId
      ? this.getOrCreateSession(threadId)
      : this.boundSession
    if (!session.failedConnectionRequest || session.isTurnRunning()) return false
    const request = session.failedConnectionRequest
    session.failedConnectionRequest = null
    void this.runTurnOnSession(session, request, true).catch((err) => {
      this.emit('queue-drain-failed', {
        threadId: session.threadId === '__unbound__' ? null : session.threadId,
        error: err instanceof Error ? err.message : String(err)
      })
    })
    return true
  }

  private async executeAction(action: OrchestratorAction): Promise<string[]> {
    switch (action.type) {
      case 'complete_task':
        return this.completeTask(action.agentIds, action.merge !== false)
      case 'message':
        return [action.content]
      default:
        return []
    }
  }

  private reportGuiAgentTerminalState(
    agentId: string,
    reason: string,
    status: 'failed' | 'interrupted'
  ): void {
    const owner = this.agentOwner(agentId)
    if (owner && owner !== this.session) {
      this.sessionAls.run(owner, () => this.reportGuiAgentTerminalState(agentId, reason, status))
      return
    }
    const agent = this.agents.get(agentId)
    if (!agent) return
    if (isTerminalAgentStatus(agent.status) || agent.status === 'merging') return

    const message =
      reason.trim() ||
      (status === 'failed'
        ? 'GUI subagent failed with no reason supplied.'
        : 'GUI subagent session was interrupted.')
    this.agents.updateStatus(agentId, status)

    const task = this.tasks.findByAgentId(agentId)
    if (task) {
      this.tasks.updateProgress(task.id, { message })
      this.tasks.updateStatus(task.id, status)
    }

    this.addSystemMessage(`[Agent ${agentId.slice(0, 8)} ${status}] ${message}`)
  }

  /**
   * An automatic follow-up for this thread (e.g. a `complete_task` outcome) is a stored
   * `reconcile_notice` inbox row; reconciler rule 4 wakes the thread for it (SPEC §14.3). Without
   * the run engine the notice is shown as a system message only.
   */
  private postThreadNotice(text: string): void {
    const threadId = this.session.threadId
    if (this.lifecycle.stopping) return
    const engine = this.runEngine
    if (!engine || threadId === '__unbound__') {
      this.addSystemMessage(text)
      return
    }
    try {
      engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text } })
    } catch (error) {
      this.addSystemMessage(`[automatic wake failed] ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async withTaskWriter<T>(session: ThreadSession, work: () => Promise<T>): Promise<T> {
    const directory = this.resolveThreadDir(session.threadId)
    if (!directory || !this.threadStore || !this.projectManager) throw new Error('Isolated agents require an owned task workspace')
    const held = session.executionLease
    const lease = held ?? await waitAcquireExecutionLease(directory, { source: 'agent-workspace', signal: this.lifecycle.signal })
    const heartbeat = setInterval(() => heartbeatExecutionLease(lease), 10_000)
    heartbeat.unref()
    try {
      session.executionLease = lease
      const project = resolveThreadProjectPath(this.projectManager, this.threadStore, session.threadId)
      if (!project) throw new Error('Isolated agents require a project')
      if (!held || !session.workspace) {
        session.workspace = await new WorkspaceResolver(directory, session.threadId, project).resolve('agent', 'main', this.lifecycle.signal, lease)
      }
      if (!session.workspace.capability.checkpointable) throw new Error('Isolated agents require an owned Git workspace')
      session.projectCwd = session.workspace.projectPath
      return await work()
    } finally {
      clearInterval(heartbeat)
      if (!held) { releaseExecutionLeaseHandle(lease); session.executionLease = null }
    }
  }

  private async snapshotOwnedParent(session: ThreadSession, label: string): Promise<string> {
    const path = session.workspace?.workspacePath
    const directory = this.resolveThreadDir(session.threadId)
    if (!path || !directory || !session.executionLease) throw new Error('No owned task writer for child operation')
    const head = actionGit(path, ['rev-parse', 'HEAD'])
    if (!actionGit(path, ['status', '--porcelain', '--untracked-files=all'])) return head
    const action = await new ThreadActionService(directory).checkpointExistingTurn({
      threadId: session.threadId, turnId: `${label}:${uuidv4()}`,
      conversationBranchId: new ThreadWorkspaceManager(directory).load()?.conversationBranchId ?? 'main',
      workspacePath: path, heldThreadLease: session.executionLease,
      presentationMessageStart: session.messages.length, presentationMessageEnd: session.messages.length,
      nativeContextBoundary: { messageIndex: session.nativeContext.messages.length, compactionGeneration: 0, fidelity: 'exact' }
    }, head, 'completed')
    return action.endSha
  }

  private async completeTask(agentIds: string[], merge: boolean): Promise<string[]> {
    const logs: string[] = []
    const agentList: Agent[] = []
    for (const agentId of new Set(agentIds)) {
      // Accept the 8-character ids used throughout the UI when they identify one
      // agent unambiguously, while retaining exact-id behavior for full UUIDs.
      const matches = this.agents.list().filter((candidate) => candidate.id === agentId || candidate.id.startsWith(agentId))
      const agent = matches.length === 1 ? matches[0] : undefined
      if (!agent) {
        logs.push(`[complete] Agent not found or prefix is ambiguous: ${agentId}`)
        continue
      }
      // Normal completion is never a cancellation mechanism. Running agents must
      // finish (or be explicitly stopped through stopAgent) before they are eligible.
      if (agent.status === 'starting' || agent.status === 'running') {
        logs.push(`[complete] Refused active agent ${agent.id.slice(0, 8)} (${agent.status})`)
        continue
      }
      const hasMergeCandidate = requiresMergeCandidateToFinalize(agent.status)
        ? await this.worktrees.hasMergeCandidate({
            path: agent.worktreePath,
            branch: agent.branch,
            repositoryRoot: agent.repositoryRoot
          })
        : false
      if (shouldFinalizeAgent(agent.status, hasMergeCandidate)) agentList.push(agent)
      else logs.push(`[complete] Agent ${agent.id.slice(0, 8)} is not eligible (${agent.status})`)
    }

    if (agentList.length === 0) {
      if (logs.length === 0) logs.push('[complete] No agents selected')
      return logs
    }

    for (const agent of agentList) {
      logs.push(...(await this.finalizeAgent(agent, merge)))
      // The action executor queues one follow-up main-agent turn containing all failure
      // details after the tool timeline has been updated. Stop here so later branches do
      // not mutate a main worktree that is already in a conflicted merge state.
      if (this.agents.get(agent.id)?.status === 'conflict') break
    }

    this.emit('task-completed')
    return logs
  }

  async stopAgentForThread(threadId: string, agentId: string, merge = false): Promise<string[]> {
    const session = this.getOrCreateSession(threadId)
    return this.sessionAls.run(session, () => this.stopAgent(agentId, merge))
  }

  async stopAgent(agentId: string, merge = false): Promise<string[]> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      return [`[agent] Not found: ${agentId}`]
    }
    if (isTerminalAgentStatus(agent.status) && !merge) {
      return [`[agent] Already ${agent.status}: ${agentId.slice(0, 8)}`]
    }
    if (agent.status === 'failed') {
      return [`[agent] Already failed: ${agentId.slice(0, 8)}`]
    }
    if (agent.status === 'starting' && !agent.worktreePath) {
      this.agents.updateStatus(agent.id, 'cancelled')
      const task = this.tasks.findByAgentId(agent.id)
      if (task) this.tasks.updateStatus(task.id, 'cancelled')
      return [`[agent] Cancelled discovery for ${agent.id.slice(0, 8)}`]
    }
    if (isTerminalAgentStatus(agent.status) && merge) {
      const hasMergeCandidate = await this.worktrees.hasMergeCandidate({
        path: agent.worktreePath,
        branch: agent.branch,
        repositoryRoot: agent.repositoryRoot
      })
      if (!shouldFinalizeAgent(agent.status, hasMergeCandidate)) {
        return [`[agent] Already ${agent.status}: ${agentId.slice(0, 8)}`]
      }
    }
    const logs = await this.finalizeAgent(agent, merge)
    this.emit('task-completed')
    return logs
  }

  /**
   * Read-only orphan/ghost scan for `.mousse-worktrees`. Does not delete anything.
   */
  async scanOrphanWorktrees() {
    const known = this.agents.list().map((agent) => ({
      path: agent.worktreePath,
      branch: agent.branch
    }))
    return this.worktrees.scanOrphanWorktrees(known)
  }

  /**
   * Explicit cleanup of validated agent worktrees only. Ghost directories are never deleted.
   * Cancelled/failed/ready worktrees are kept unless their agent ids are listed.
   */
  async cleanupAgentWorktrees(
    agentIds: string[],
    options: { deleteBranch?: boolean } = {}
  ): Promise<string[]> {
    const logs: string[] = []
    const targets = agentIds
      .map((id) => this.agents.get(id))
      .filter((agent): agent is Agent => Boolean(agent))
      .map((agent) => ({ path: agent.worktreePath, branch: agent.branch, id: agent.id }))

    for (const target of targets) {
      const result = await this.worktrees.cleanupValidatedAgentWorktree(
        { path: target.path, branch: target.branch },
        options
      )
      if (result.success) {
        logs.push(`[worktree] Removed validated worktree for ${target.id.slice(0, 8)}`)
      } else {
        logs.push(`[worktree] Cleanup refused/failed for ${target.id.slice(0, 8)}: ${result.error}`)
      }
    }
    return logs
  }

  private async integrateAgentResult(agent: Agent): Promise<{ success: boolean; conflict?: boolean; conflicts?: string[]; error?: string }> {
    const owner = this.agentOwner(agent.id) ?? this.session
    try {
      return await this.withTaskWriter(owner, async () => {
        const directory = this.resolveThreadDir(owner.threadId)!
        const parent = owner.workspace!.workspacePath
        if (agent.repositoryRoot && actionGit(agent.repositoryRoot, ['rev-parse', '--show-toplevel']) !== actionGit(parent, ['rev-parse', '--show-toplevel'])) {
          throw new Error('Child integration target no longer matches its owned task workspace')
        }
        const base = actionGit(agent.worktreePath, ['rev-parse', `refs/mousse/agents/${agent.id}/base`])
        const workerHead = actionGit(agent.worktreePath, ['rev-parse', 'HEAD'])
        if (agent.readyCommit && agent.readyCommit !== workerHead) throw new Error('Worker HEAD changed after readiness validation')
        if (agent.readyCommit) requireCleanWorkspace(agent.worktreePath, 'Ready worker')
        const workerAction = await new ThreadActionService(join(directory, 'agent-changes', agent.id)).checkpointExistingTurn({
          threadId: agent.id, turnId: `worker-result:${agent.id}`, conversationBranchId: 'main',
          actor: { kind: 'agent', id: agent.id }, workspacePath: agent.worktreePath,
          externalEffects: [{ kind: 'unknown', reversible: false, description: 'Child tools may affect ignored files or external services; integrating or undoing code does not reverse those effects.' }],
          presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
        }, base, 'completed')
        const expectedDestinationHead = await this.snapshotOwnedParent(owner, 'child-integration-base')
        await new ChildAgentIntegrationService(directory).integrate({
          agentId: agent.id, operationId: `chat-integration:${agent.id}:${workerAction.endSha}`,
          workerWorktree: agent.worktreePath, workerBranch: agent.branch,
          spawnBaseSha: base, expectedWorkerHead: workerAction.endSha,
          threadWorkspace: parent, expectedDestinationHead, heldThreadLease: owner.executionLease ?? undefined,
          externalEffects: workerAction.externalEffects,
          actor: { kind: 'agent', id: agent.id }
        })
        // Retain the worker and pinned result for undo/recovery. GC owns retirement.
        return { success: true }
      })
    } catch (error) {
      let conflicts: string[] = []
      try { conflicts = actionGit(owner.workspace!.workspacePath, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean) } catch { /* preserve original error */ }
      return { success: false, conflict: conflicts.length > 0, conflicts, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Named agents are retired, but old task data still holds their identities in agent-episodes.json. */
  private isLegacyNamedAgent(agent: Agent): boolean {
    const owner = this.agentOwner(agent.id)
    const directory = owner ? this.resolveThreadDir(owner.threadId) : undefined
    try { return Boolean(directory && new AgentEpisodeStore(directory).resolve(agent.id)) }
    catch { return false }
  }

  private async finalizeAgent(agent: Agent, merge: boolean): Promise<string[]> {
    if (this.isLegacyNamedAgent(agent)) {
      const retired = `${agent.id.slice(0, 8)} is a retired named agent; its result stays on its retained branch and can be merged by hand.`
      if (merge) throw new Error(`Cannot merge ${retired}`)
      return [`[agent] ${retired} Nothing was stopped or changed.`]
    }
    const logs: string[] = []
    // Enter merging before aborting writers so a programmatic abort during finalize
    // is not mis-reported as a user interrupt on a still-ready agent.
    this.agents.updateStatus(agent.id, 'merging')
    const task = this.tasks.findByAgentId(agent.id)

    // Stop all writers before cleanup or Git operations. A legacy GUI session has no live turn
    // to stop; only headless processes and terminals can still be writing.
    if (agent.executionMode === 'headless' && agent.processId) {
      this.headlessRunner.kill(agent.processId)
      logs.push(`[headless] Stopped agent ${agent.id.slice(0, 8)}`)
    } else if (agent.executionMode !== 'gui' && agent.ptyId) {
      this.ptyManager.kill(agent.ptyId)
      logs.push(`[terminal] Closed agent ${agent.id.slice(0, 8)}`)
    }

    if (merge) {
      const result = await this.integrateAgentResult(agent)
      if (result.success) {
        // Cleanup is intentionally after successful merge/removal. A plain Stop or failed
        // merge must leave the recoverable worktree byte-for-byte intact.
        if (this.agentConfigManager) {
          logs.push(...(await this.agentConfigManager.cleanup(agent.id)))
        }
        logs.push(`[merge] Merged ${agent.branch}`)
        this.agents.updateStatus(agent.id, 'completed')
        if (task) {
          this.tasks.updateProgress(task.id, {
            progress: 100,
            message: `Merged ${agent.branch}`
          })
          this.tasks.updateStatus(task.id, 'completed')
        }
      } else if (result.conflict) {
        const files = result.conflicts?.join(', ') || 'unknown files'
        logs.push(`[merge] Conflict for ${agent.branch}: ${files}`)
        logs.push(`[merge] Details: ${result.error}`)
        this.agents.updateStatus(agent.id, 'conflict')
        task && this.tasks.updateProgress(task.id, {
          message: `Merge conflict: ${files}`
        })
        // Preserve the worktree, branch, and Git merge state for resolution.
        return logs
      } else {
        logs.push(`[merge] Failed for ${agent.branch}: ${result.error}`)
        // A non-conflict Git failure can be transient (locked index, hook failure, etc.).
        // Keep the branch eligible for complete_task retry instead of classifying the
        // worker as failed and silently excluding its surviving commit.
        this.agents.updateStatus(agent.id, 'ready')
        task && this.tasks.updateProgress(task.id, {
          message: `Merge failed; branch preserved for retry: ${result.error}`
        })
      }
    } else {
      // Stop without merge is cancellation — not success. Keep worktree/branch recoverable.
      this.agents.updateStatus(agent.id, 'cancelled')
      if (task) {
        this.tasks.updateStatus(task.id, 'cancelled')
        this.tasks.updateProgress(task.id, {
          message: 'Stopped without merge; worktree and branch retained.'
        })
      }
      logs.push(
        `[cancel] Marked ${agent.id.slice(0, 8)} cancelled; worktree retained at ${agent.worktreePath}`
      )
    }

    return logs
  }

  validateConversationActionRestore(threadId: string, action: import('../../shared/threadActions').ThreadAction, kind: 'undo' | 'redo'): void {
    assertConversationBoundary(action)
    const directory = this.resolveThreadDir(threadId)
    if (directory && (new ThreadWorkspaceManager(directory).load()?.conversationBranchId ?? 'main') !== action.conversationBranchId) throw new Error('Conversation recovery requires the active branch.')
    const session = this.getOrCreateSession(threadId)
    const start = action.nativeContextStartBoundary!, end = action.nativeContextBoundary
    const count = session.nativeContext.messages.length
    const desired = kind === 'undo' ? start.messageIndex : end.messageIndex
    const source = kind === 'undo' ? end.messageIndex : start.messageIndex
    if (count !== desired && count !== source || (session.nativeContext.compaction?.generation ?? 0) !== start.compactionGeneration || session.messages.length !== action.presentationMessageEnd || session.messages.slice(action.presentationMessageStart, action.presentationMessageEnd).some((message) => message.turnId !== action.turnId)) throw new Error('Conversation context no longer matches the recorded turn boundary.')
    if (kind === 'redo' && end.messageIndex - count > (session.nativeContext.retiredMessages?.length ?? 0)) throw new Error('Conversation redo context archive is incomplete.')
  }

  /** Rewind the visible/model lineage after conversation undo without erasing audit events. */
  restoreConversationBoundary(
    threadId: string,
    presentationMessageStart: number,
    boundary: NativeContextBoundary
  ): void {
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning()) throw new Error('Cannot restore conversation context while a turn is running.')
    this.sessionAls.run(session, () => {
      for (let index = Math.max(0, presentationMessageStart); index < session.messages.length; index += 1) {
        session.messages[index] = {
          ...session.messages[index],
          hiddenBeforeUndo: session.messages[index].hiddenBeforeUndo ?? session.messages[index].hidden === true,
          hidden: true
        }
      }
      const cut = Math.max(0, Math.min(boundary.messageIndex, session.nativeContext.messages.length))
      const removed = session.nativeContext.messages.slice(cut)
      session.nativeContext = {
        ...session.nativeContext,
        version: 2,
        messages: session.nativeContext.messages.slice(0, cut),
        retiredMessages: [
          ...(session.nativeContext.retiredMessages ?? []),
          ...removed
        ],
        activeStartIndex: Math.max(0, Math.min(boundary.activeStartIndex ?? 0, cut)),
        revision: (session.nativeContext.revision ?? 0) + 1,
        compaction: boundary.compaction ? structuredClone(boundary.compaction) : undefined,
        acceptedQueueItemIds: structuredClone(boundary.acceptedQueueItemIds ?? []),
        acceptedSteerItemIds: structuredClone(boundary.acceptedSteerItemIds ?? []),
        lastTurnUsage: undefined
      }
      this.persist(true)
      this.emitThreadMessages(threadId, session.messages, true)
    })
  }

  restoreConversationActionEnd(
    threadId: string,
    presentationMessageStart: number,
    presentationMessageEnd: number,
    boundary: NativeContextBoundary
  ): void {
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning()) throw new Error('Cannot redo conversation context while a turn is running.')
    const needed = Math.max(0, boundary.messageIndex - session.nativeContext.messages.length)
    const retired = session.nativeContext.retiredMessages ?? []
    if (needed > retired.length) throw new Error('Conversation redo context archive is incomplete.')
    this.sessionAls.run(session, () => {
      for (
        let index = Math.max(0, presentationMessageStart);
        index < Math.min(presentationMessageEnd, session.messages.length);
        index += 1
      ) {
        if (!('hiddenBeforeUndo' in session.messages[index])) continue
        const { hiddenBeforeUndo, ...message } = session.messages[index]
        session.messages[index] = {
          ...message,
          hidden: hiddenBeforeUndo ? true : undefined
        }
      }
      const restored = needed > 0 ? retired.slice(-needed) : []
      session.nativeContext = {
        ...session.nativeContext,
        messages: [...session.nativeContext.messages, ...structuredClone(restored)],
        retiredMessages: needed > 0 ? retired.slice(0, -needed) : retired,
        activeStartIndex: Math.max(0, Math.min(boundary.activeStartIndex ?? 0, boundary.messageIndex)),
        revision: (session.nativeContext.revision ?? 0) + 1,
        compaction: boundary.compaction ? structuredClone(boundary.compaction) : undefined,
        acceptedQueueItemIds: structuredClone(boundary.acceptedQueueItemIds ?? []),
        acceptedSteerItemIds: structuredClone(boundary.acceptedSteerItemIds ?? []),
        lastTurnUsage: undefined
      }
      this.persist(true)
      this.emitThreadMessages(threadId, session.messages, true)
    })
  }

  replaceConversationState(
    threadId: string,
    messages: ChatMessage[],
    nativeContext: NativeLlmContext
  ): void {
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning()) throw new Error('Cannot activate a conversation branch while a turn is running.')
    this.sessionAls.run(session, () => {
      session.messages = structuredClone(messages)
      session.nativeContext = normalizeNativeContext(nativeContext)
      this.persist(true)
      this.emitThreadMessages(threadId, session.messages, true)
    })
  }

  getActiveAgents(): Agent[] {
    return this.agents.list().filter((a) => a.status === 'running' || a.status === 'starting')
  }

  async runIsolatedScheduledJob(
    prompt: string,
    ingress?: ScheduledJobIngress
  ): Promise<BackgroundWorkflowTurnResult> {
    return this.lifecycle.run('scheduled-turn', () => this.runIsolatedScheduledJobOwned(prompt, ingress))
  }

  private async runIsolatedScheduledJobOwned(prompt: string, ingress?: ScheduledJobIngress): Promise<BackgroundWorkflowTurnResult> {
    try {
      const workflow = prompt.startsWith('/') && ingress
        ? await this.admitBackgroundWorkflowTurn({
            content: prompt,
            source: 'schedule',
            requestId: scheduleWorkflowInvocationId(ingress),
            threadId: this.resolveScheduledWorkflowThread(ingress),
            signal: this.lifecycle.signal,
            terminalOnly: ingress.resumeWaiting === true,
            onWorkflowPrepared: ingress.onWorkflowPrepared
          })
        : null
      if (workflow) return workflow
      const result = await this.llm.chat([userMessage(prompt)], () => {}, {
        mode: 'agent', signal: this.lifecycle.signal
      })
      const text = stripActionBlocks(result.text) || result.text.trim() || 'Done.'
      const silent = text.trim() === '[SILENT]' || text.trimStart().startsWith('[SILENT]')
      return { text, silent }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: '', silent: false, error: message }
    }
  }

  async runChannelTurn(
    threadId: string,
    content: string,
    threadStore: ThreadDataStore,
    opts?: {
      modelOverride?: ModelOverride
      signal?: AbortSignal
      drainSteer?: () => string | undefined
      hostIngress?: ChannelWorkflowHostIngress
      /** Remote sends choose a mode and attach images; channel turns run in agent mode without images. */
      mode?: ChatMode
      images?: ChatImageAttachment[]
      /** Called once the user's message is stored on the thread; not called if the turn never starts. */
      onUserInputAccepted?: () => void
    }
  ): Promise<BackgroundWorkflowTurnResult> {
    return this.lifecycle.run('channel-turn', () => this.runChannelTurnOwned(threadId, content, threadStore, opts))
  }

  private async runChannelTurnOwned(
    threadId: string,
    content: string,
    threadStore: ThreadDataStore,
    opts?: {
      modelOverride?: ModelOverride
      signal?: AbortSignal
      drainSteer?: () => string | undefined
      hostIngress?: ChannelWorkflowHostIngress
      /** Remote sends choose a mode and attach images; channel turns run in agent mode without images. */
      mode?: ChatMode
      images?: ChatImageAttachment[]
      /** Called once the user's message is stored on the thread; not called if the turn never starts. */
      onUserInputAccepted?: () => void
    }
  ): Promise<BackgroundWorkflowTurnResult> {
    const ownedTurn = !opts?.signal
    const channelTurn: { abort: AbortController; pendingSteer: string[]; promotedSteerIds: string[]; runId?: string } | null = ownedTurn
      ? { abort: new AbortController(), pendingSteer: [], promotedSteerIds: [] }
      : null
    if (channelTurn) this.channelTurns.set(threadId, channelTurn)

    const signal = AbortSignal.any([opts?.signal ?? channelTurn!.abort.signal, this.lifecycle.signal])
    let lease: ThreadLeaseHandle | null = null
    // Session admitted by this channel turn until it hands admission to runTurnOnSession.
    let admittedSession: ThreadSession | null = null

    try {
      if (!threadStore.getThread(threadId)) {
        return { text: '', silent: false, error: `Thread not found: ${threadId}` }
      }

      try {
        lease = await waitAcquireExecutionLease(threadStore.getThreadDir(threadId), {
          source: 'channel',
          signal,
          maxAttempts: 240,
          retryDelayMs: 50
        })
      } catch (err) {
        if (signal.aborted || (err instanceof Error && /abort/i.test(err.message))) {
          return { text: '', silent: true, aborted: true }
        }
        return {
          text: '',
          silent: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }

      // Hydrate the canonical live session after acquiring the cross-process lease.
      // This refreshes a GUI session that may have been opened before a channel/CLI write.
      const data = threadStore.loadThreadData(threadId)
      const session = this.getOrCreateSession(threadId)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        opts?.modelOverride ?? threadStore.getThread(threadId)?.modelOverride
      )
      try {
        const projectPath = this.projectManager
          ? resolveThreadProjectPath(this.projectManager, threadStore, threadId)
          : undefined
        session.projectCwd = projectPath ? resolveProjectWorkingDirectory(projectPath) : null
      } catch {
        session.projectCwd = null
      }
      this.emitThreadMessages(threadId, session.messages)

      // Admit before the workflow/admission awaits below so a concurrent send queues instead of
      // starting a second turn on this session (its own lease token is excluded from the external-lease check).
      if (session.turnAdmitted) {
        return { text: '', silent: false, error: `Thread already has a running turn: ${threadId}` }
      }
      session.turnAdmitted = true
      admittedSession = session
      // Transfer lease ownership to the regular turn path so every exit releases it.
      session.executionLease = lease
      lease = null
      const hostRequestId = opts?.hostIngress ? channelWorkflowInvocationId(opts.hostIngress) : undefined
      const workflow = await this.admitBackgroundWorkflowTurn({
        content,
        source: 'channel',
        requestId: hostRequestId,
        threadId,
        signal,
        session,
        admissionHeld: true,
        onAdmissionHandedOff: () => { admittedSession = null },
        onUserInputAccepted: opts?.onUserInputAccepted
      })
      if (workflow) {
        this.releaseSessionExecutionLease(session)
        return workflow
      }
      let wasAborted = false
      const runId = await this.recordChannelRun(threadId)
      if (channelTurn) channelTurn.runId = runId
      admittedSession = null
      const result = await this.runTurnOnSession(
        session,
        { content, mode: opts?.mode ?? 'agent', ...(opts?.images?.length ? { images: opts.images } : {}) },
        false,
        true,
        {
          admissionHeld: true,
          suppressAutoQueueDrain: true,
          externalSignal: signal,
          runId,
          externalDrainSteer: opts?.drainSteer ?? (channelTurn
            ? () => {
                if (channelTurn.pendingSteer.length === 0) return undefined
                const steer = channelTurn.pendingSteer.join('\n')
                channelTurn.pendingSteer = []
                return steer
              }
            : undefined),
          modelOverride: opts?.modelOverride,
          onUserInputAccepted: opts?.onUserInputAccepted,
          onTurnSettled: (aborted) => {
            wasAborted = aborted
            try {
              mutateDurableQueue(threadStore, threadId, (disk) => demoteSteerItems(disk))
            } catch {
              // Best-effort while this turn still owns the execution lease.
            }
          }
        }
      )

      if (wasAborted || signal.aborted) {
        return { text: '', silent: true, aborted: true }
      }

      const text = result.message
      const silent = text.trim() === '[SILENT]' || text.trimStart().startsWith('[SILENT]')
      return { text, silent }
    } catch (err) {
      const isAbort =
        signal.aborted ||
        channelTurn?.abort.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
      if (isAbort) return { text: '', silent: true, aborted: true }
      return { text: '', silent: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (channelTurn) this.channelTurns.delete(threadId)
      if (lease) releaseExecutionLeaseHandle(lease)
      if (admittedSession) {
        this.releaseSessionExecutionLease(admittedSession)
        admittedSession.turnAdmitted = false
        admittedSession.abortRequested = false
      }
    }
  }

  private resolveScheduledWorkflowThread(ingress: ScheduledJobIngress): string {
    if (!this.threadStore) throw new Error('Scheduled workflow thread store is unavailable')
    if (ingress.threadId) {
      const thread = this.threadStore.getThread(ingress.threadId)
      if (!thread || thread.settledAt) throw new Error('Scheduled workflow thread is unavailable')
      return thread.id
    }
    return this.threadStore.ensureExecutionThread(
      'schedule:' + ingress.jobId + ':' + ingress.occurrenceAt,
      ('Scheduled: ' + (ingress.jobName ?? 'workflow')).slice(0, 120),
      ingress.projectId
    ).id
  }

  /**
   * Pin and admit a slash workflow through the same durable chat receipt as GUI/CLI.
   * Observation happens after the thread execution lease is released.
   */
  private async admitBackgroundWorkflowTurn(input: {
    content: string
    source: 'channel' | 'schedule'
    requestId?: string
    threadId?: string
    signal: AbortSignal
    session?: ThreadSession
    terminalOnly?: boolean
    onWorkflowPrepared?: (invocationId: string) => void
    /** The caller already admitted `session`; ownership passes to the workflow turn via onAdmissionHandedOff. */
    admissionHeld?: boolean
    onAdmissionHandedOff?: () => void
    /** Called once the workflow command is stored on the thread. */
    onUserInputAccepted?: () => void
  }): Promise<BackgroundWorkflowTurnResult | null> {
    if (!this.workflowChat || !input.content.startsWith('/') || !input.threadId) return null
    let prepared
    try {
      prepared = await this.workflowChat.prepare(input.threadId, { content: input.content, requestId: input.requestId }, input.source)
    } catch (error) {
      if (error instanceof DomainRpcError) return { text: '', silent: false, error: error.message }
      throw error
    }
    if (!prepared.workflowInvocationId) return null
    input.onWorkflowPrepared?.(prepared.workflowInvocationId)
    if (!this.threadStore) return { text: '', silent: false, error: 'Workflow thread store is unavailable' }
    const session = input.session ?? this.getOrCreateSession(input.threadId)
    let observed: ReturnType<WorkflowChatExecutor['observe']> | undefined
    try {
      input.onAdmissionHandedOff?.()
      const response = await this.runTurnOnSession(
        session,
        { content: prepared.content, workflowInvocationId: prepared.workflowInvocationId },
        false,
        true,
        {
          suppressAutoQueueDrain: true,
          externalSignal: input.signal,
          admissionHeld: input.admissionHeld,
          onUserInputAccepted: input.onUserInputAccepted
        }
      )
      if (!response.workflowRun) return { text: response.message, silent: false, transcriptWritten: true }
      this.releaseSessionExecutionLease(session)
      observed = this.workflowChat.observe(response.workflowRun, input.signal, input.terminalOnly)
      const { snapshot, aborted } = await observed
      const run = { ...response.workflowRun, state: snapshot.manifest.state }
      const text = formatBackgroundWorkflowDelivery(run, snapshot)
      await this.persistBackgroundWorkflowObservation(session, run, text)
      if (aborted || input.signal.aborted) {
        return { text, silent: true, aborted: true, waiting: isBackgroundWorkflowWaiting(run.state), transcriptWritten: true }
      }
      return {
        text,
        silent: false,
        waiting: isBackgroundWorkflowWaiting(run.state),
        transcriptWritten: true
      }
    } catch (error) {
      const aborted = input.signal.aborted || (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)))
      if (aborted) return { text: '', silent: true, aborted: true, transcriptWritten: true }
      if (error instanceof DomainRpcError) return { text: '', silent: false, error: error.message }
      throw error
    } finally {
      if (observed) await observed.catch(() => undefined)
    }
  }

  private async persistBackgroundWorkflowObservation(
    session: ThreadSession,
    run: WorkflowChatRun,
    text: string
  ): Promise<void> {
    if (!this.threadStore || session.threadId === '__unbound__') return
    const thread = this.threadStore.getThread(session.threadId)
    if (!thread) return
    const lease = await waitAcquireExecutionLease(this.threadStore.getThreadDir(session.threadId), {
      source: 'workflow-observer',
      signal: this.lifecycle.signal,
      maxAttempts: 240,
      retryDelayMs: 50
    })
    try {
      const data = this.threadStore.loadThreadData(session.threadId)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        thread.modelOverride
      )
      const message = [...session.messages].reverse().find(
        (entry) => entry.role === 'assistant' && entry.workflowRun?.runId === run.runId
      )
      if (!message) return
      message.content = text
      message.workflowRun = run
      this.sessionAls.run(session, () => this.persist(true))
    } finally {
      releaseExecutionLeaseHandle(lease)
    }
  }
}
