import { logDebug } from '../log/diag'
import { ConversationActionService, assertConversationBoundary } from '../actions/ConversationActionService'
import { WorktreeRetirementService } from '../lifecycle/WorktreeRetirementService'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { existsSync } from 'node:fs'
import { canonicalJson, sha256Hex } from '../../shared/agents/hashes'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { TaskWriterAuthority, type EpisodeWriterToken } from '../agents/TaskWriterAuthority'
import { createAgentToolAccess, resolveAgentWorkspacePolicy } from '../agents/WorkspaceAccessPolicy'
import type { AgentWorkspacePolicy, AgentEpisode } from '../../shared/agentEpisodes'
import { AsyncLocalStorage } from 'async_hooks'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { normalizeContextSettings, resolveContextCompactionTokens, resolveModelForMode } from '../../shared/settings'
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
import { antigravityAssistantMessage, antigravityHistory } from '../providers/antigravity/history'
import type { AntigravityProviderService } from '../providers/antigravity/AntigravityProviderService'
import { v4 as uuidv4 } from 'uuid'
import {
  isDelegationSettledStatus,
  isTerminalAgentStatus,
  type Agent,
  type AgentStatus,
  type ChatImageAttachment,
  type ChatMode,
  type ChatMessage,
  type CliType,
  type ContextUsageSnapshot,
  type MousseAgentAssignment,
  type MousseAgentSendResult,
  type MousseAgentSessionSnapshot,
  type NativeLlmContext,
  type OrchestratorAction,
  type OrchestratorContextUsageInput,
  type OrchestratorResponse,
  type OrchestratorSendInput,
  type QueuedMessage,
  type SubagentAssignment,
  type TurnPhase,
  type TurnState,
  type TurnStateSnapshot,
  type ThreadActivityState,
  type UserQuestion,
  type UserQuestionAnswers
} from '../../shared/types'
import { EFFORT_SUFFIXES, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { allowsOrchestrationActions, buildModeChangeNotice, chatModeEquals, getChatModeLabel, getLastUserChatMode, normalizeChatMode } from '../../shared/chatMode'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import {
  TaskProgressMonitor,
  taskProgressInstructions,
  taskProgressPath,
  readFinalAgentProgress,
  type AgentProgressUpdate
} from '../tasks/TaskProgressMonitor'
import { WorktreeManager } from '../worktree/WorktreeManager'
import { PtyManager } from '../terminals/PtyManager'
import { HeadlessAgentRunner } from '../terminals/HeadlessAgentRunner'
import { MacroEngine } from '../macros/MacroEngine'
import { LlmClient, parseActions, stripActionBlocks, type StreamingLlmThinkingEvent, type StreamingLlmToolEvent, filterActionsForChatMode, rejectOrchestrationAction } from './LlmClient'
import type { BrowserRuntimePort } from '../../shared/browser/runtime'
import {
  type BrowserExecutionBinding,
  createDefinitionBrowserBinding,
  readHostBrowserRuntime
} from './browser'
import { computeContextUsage } from './contextUsage'
import { getToolCallDisplay, parseProviderToolCall } from '../../shared/toolCallDisplay'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProviderAuthService } from '../providers/ProviderAuthService'
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
import { withGitMutationLocks } from '../actions/GitOperationCoordinator'
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
import { ThreadSession } from './ThreadSession'
import { userQuestionService as defaultUserQuestionService, UserQuestionService } from './UserQuestionService'
import { modeRegistry as defaultModeRegistry, type ModeRegistry } from '../modes/ModeRegistry'
import {
  MousseAgentService,
  type MousseAgentLifecycleEvent
} from '../agents/MousseAgentService'
import { ConnectionRetriesExhaustedError } from './connectionRetry'
import { createErrorProvider, errorDiagnostic, normalizeAppError, serializeAppError, type AppErrorShape } from '../../shared/errors'
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

const SPAWN_FAILURE_PREFIX = '[spawn-failure '

/**
 * Spawn acknowledgement failures are explicitly tagged at the point where a reserved
 * agent/task is failed. Do not infer them from free-form discovery rationales or setup logs:
 * those commonly describe the bug being fixed using words such as "failed" or "error".
 */
export function isSpawnAgentsFailureLog(line: string): boolean {
  return line.startsWith(SPAWN_FAILURE_PREFIX)
}

export function buildSpawnAgentsFailureWake(logs: string[]): string | undefined {
  const failures = logs.filter(isSpawnAgentsFailureLog)
  if (failures.length === 0) return undefined
  return [
    `[Automatic spawn_agents update] ${failures.length} delegated task${failures.length === 1 ? ' was' : 's were'} not started.`,
    ...failures,
    'Wake the originating main agent now. Retry only the failed task(s) after addressing the reported cause; do not respawn agents that started successfully.'
  ].join('\n')
}

export function isRecoverableNoDiffReadinessFailure(
  error: string | undefined,
  verificationOnly: boolean,
  attempt: number
): boolean {
  return isRecoverableReadinessFailure(error, verificationOnly, attempt)
}

/** One bounded GUI readiness correction for common "almost done" failures. */
export function isRecoverableReadinessFailure(
  error: string | undefined,
  verificationOnly: boolean,
  attempt: number
): boolean {
  if (verificationOnly || attempt >= 1 || !error) return false
  if (/left uncommitted changes/i.test(error)) return true
  if (/changed files outside its discovery declaration/i.test(error)) return true
  if (
    /without creating a worker-authored commit|empty commits|no implementation diff|Ready commit contains no implementation diff/i.test(
      error
    )
  ) {
    return true
  }
  return false
}

export function isUncommittedReadinessFailure(error: string | undefined): boolean {
  return !!error && /left uncommitted changes/i.test(error)
}

export function isOutsideDeclarationReadinessFailure(error: string | undefined): boolean {
  return !!error && /changed files outside its discovery declaration/i.test(error)
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

const PLAN_REFERENCE_RE =
  /\b(?:the\s+plan|implementation\s+plan|design\s+(?:doc|document)|the\s+spec(?:ification)?|follow(?:ing)?\s+the\s+plan|according\s+to\s+the\s+plan|as\s+planned)\b/i
const PLAN_PATH_RE =
  /(?:^|[\s`"'(])((?:(?:[a-z]:)?[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:md|txt|rst|markdown))\b/i
const PLAN_BODY_HINT_RE =
  /(?:^|\n)\s{0,3}#{1,6}\s+\S+|acceptance\s+criteria|numbered\s+steps|\bstep\s+\d+\b|```/i

/** Extract likely owned file paths from a task description for overlap checks. */
export function extractAssignmentFilePaths(task: string): string[] {
  const paths = new Set<string>()
  const re =
    /(?:^|[\s`"'(])((?:src|tests?|docs?|macros|scripts?|resources)\/[\w./-]+\.[\w]+)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(task)) !== null) {
    paths.add(match[1].replace(/\\/g, '/'))
  }
  return [...paths]
}

/** Extract repository files an agent must be able to read, independently of edit ownership. */
export function extractAssignmentInputFilePaths(task: string): string[] {
  const paths = new Set<string>()
  const re =
    /(?:^|[\s`"'(])((?:src|tests?|docs?|macros|scripts?|resources|reference|public|audio)[\\/][\w.@()+\/-]+\.[\w-]+)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(task)) !== null) {
    paths.add(match[1].replace(/\\/g, '/').trim())
  }
  return [...paths]
}

function taskReferencesPlanWithoutBodyOrPath(task: string): boolean {
  if (!PLAN_REFERENCE_RE.test(task)) return false
  if (PLAN_PATH_RE.test(task)) return false
  if (PLAN_BODY_HINT_RE.test(task) && task.trim().length >= 120) return false
  // Long tasks that embed substantial plan text without a path are acceptable.
  if (task.trim().length >= 400 && /\b(?:should|must|implement|add|create|update)\b/i.test(task)) {
    return false
  }
  return true
}

function taskLooksUnbounded(task: string): boolean {
  const trimmed = task.trim()
  if (trimmed.length < 12) return true
  // Whole-repo / full-suite style assignments without a tighter scope.
  if (
    /\b(?:entire|whole)\s+(?:codebase|repository|repo|project)\b/i.test(trimmed) &&
    !/\b(?:only|focused|limited to|except)\b/i.test(trimmed)
  ) {
    return true
  }
  if (
    /\b(?:run|execute)\s+(?:the\s+)?(?:full|entire)\s+(?:test\s+)?suite\b/i.test(trimmed) &&
    !/\bafter\b|\bonly\b|\bfocused\b|\bthen\b/i.test(trimmed)
  ) {
    return true
  }
  return false
}

interface NamedDelegationParent {
  alreadyDelegated?: boolean
  policy: AgentWorkspacePolicy
  episodeId: string
  authority?: TaskWriterAuthority
  token?: EpisodeWriterToken
  signal: AbortSignal
  binding: { workspaceRoot: string; cwd: string; branch: string; workspaceId: string; generation: number }
}

export function validateSubagentAssignment(spec: SubagentAssignment): string | undefined {
  if (typeof spec.task !== 'string' || !spec.task.trim()) return 'Agent task is required.'

  for (const [name, value] of Object.entries({
    provider: spec.provider,
    model: spec.model,
    effort: spec.effort
  })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value !== value.trim())) {
      return `Subagent ${name} must be a non-empty, trimmed string.`
    }
  }

  if (Boolean(spec.provider) !== Boolean(spec.model)) {
    return 'Subagent provider and model overrides must be supplied together.'
  }
  if (spec.effort && !EFFORT_SUFFIXES.has(spec.effort)) {
    return `Unknown subagent reasoning effort "${spec.effort}".`
  }
  if (spec.cliType !== 'mousse' && (spec.provider || spec.model || spec.effort)) {
    return 'Provider, model, and effort overrides are only supported by Mousse subagents.'
  }
  if (taskReferencesPlanWithoutBodyOrPath(spec.task)) {
    return 'Task refers to a plan/spec but includes neither the plan body nor a readable path to it.'
  }
  if (taskLooksUnbounded(spec.task)) {
    return 'Task is unbounded or requests a full-suite run without a focused scope; narrow the assignment.'
  }
  return undefined
}

/**
 * Batch-level validation: overlapping primary file ownership across agents.
 * Returns an error string when two assignments claim the same path.
 */
export function validateDelegationBatch(specs: SubagentAssignment[]): string | undefined {
  const owner = new Map<string, number>()
  for (let i = 0; i < specs.length; i++) {
    const paths = extractAssignmentFilePaths(specs[i]?.task ?? '')
    for (const filePath of paths) {
      const previous = owner.get(filePath)
      if (previous !== undefined) {
        return `Overlapping file ownership for "${filePath}" between agent tasks ${previous + 1} and ${i + 1}.`
      }
      owner.set(filePath, i)
    }
  }
  return undefined
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

const namedContextErrors = createErrorProvider({
  agent_name_exists: { category: 'conflict', retryable: false, message: 'Agent name already exists; recall it explicitly' },
  agent_generation_changed: { category: 'conflict', retryable: false, message: 'Named agent context generation changed or identity unavailable' },
  agent_recall_required: { category: 'invalid', retryable: false, message: 'Named agents require a new recall episode' },
  agent_context_stale: { category: 'conflict', retryable: false, message: 'Saved agent context diverged from the selected conversation. Recall with fresh context to retain history without reusing undone instructions.' },
  agent_context_model_changed: { category: 'conflict', retryable: false, message: 'Saved native context uses a different provider or model. Request fresh context explicitly.' }
})

export function isContextOverflowError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) return error.code === 'provider_context_overflow'
  const message = error instanceof Error ? error.message : String(error)
  return /context(?:_|\s|-)*(?:length|window|limit)|too many tokens|maximum context/i.test(message)
}

export async function retryContextOverflowOnce<T>(
  run: () => Promise<T>,
  compact: () => boolean,
  canRetry: () => boolean = () => true
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!canRetry() || !isContextOverflowError(error) || !compact()) throw error
    return run()
  }
}

export class OrchestratorService extends EventEmitter {
  private antigravity?: AntigravityProviderService
  setAntigravityProvider(provider: AntigravityProviderService): void { this.antigravity = provider }
  private readonly lifecycle = new OwnedWorkBarrier()

  getOwnedActivity(): Record<string, number> {
    return { ...this.lifecycle.snapshot(), nativeAgents: this.mousseAgents.getActiveCount(), readinessChecks: this.readinessChecks.size }
  }

  beginShutdown(): void {
    this.lifecycle.beginShutdown()
    this.startupDrainPending = []
    this.startupDrainScheduled.clear()
    this.progressMonitor.stopAll()
    for (const timer of this.wakeTimers.values()) clearTimeout(timer)
    this.wakeTimers.clear()
    this.wakeQueues.clear()
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) session.activeTurn?.abort.abort()
    for (const turn of this.channelTurns.values()) turn.abort.abort()
    this.mousseAgents.beginShutdown()
    this.questions.shutdown()
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.beginShutdown()
    await Promise.all([this.lifecycle.waitForIdle(timeoutMs), this.mousseAgents.shutdown(timeoutMs)])
    // These callbacks were included in the barrier; include their final bookkeeping too.
    await Promise.allSettled([...this.readinessChecks.values()])
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
  private readonly questions: UserQuestionService
  private readonly modeRegistry: ModeRegistry
  /** Bound GUI/CLI session (active thread). Concurrent turns use ALS-scoped sessions. */
  private boundSession = new ThreadSession('__unbound__')
  private sessions = new Map<string, ThreadSession>()
  private readonly sessionAls = new AsyncLocalStorage<ThreadSession>()
  private persistFn?: (threadId?: string | null) => void
  /** Per-thread delayed persist timers (concurrent turns must not suppress each other). */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private mousseAgents: MousseAgentService
  private readonly namedSettlements = new Map<string, Promise<unknown>>()
  private readonly namedCancellations = new Map<string, () => void>()
  private progressMonitor = new TaskProgressMonitor()
  private delegationBatches = new Set<Set<string>>()
  /** Durable in-process ownership prevents selected-thread changes from rerouting agent events. */
  private delegationBatchOwners = new WeakMap<Set<string>, ThreadSession>()
  private agentOwners = new Map<string, ThreadSession>()
  /** Automatic parent turns are queued per originating thread, not the selected thread. */
  private wakeQueues = new Map<string, string[]>()
  private wakeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * GUI agents with a live in-process Mousse session. Persisted "running" agents that
   * are absent from this set after load are treated as interrupted.
   */
  private liveGuiAgents = new Set<string>()
  /** Serializes duplicate completion signals from the progress file and GUI action stream. */
  private readinessChecks = new Map<string, Promise<void>>()
  /** One bounded correction when an implementation worker falsely completes with no diff. */
  private noDiffCorrectionAttempts = new Map<string, number>()
  /** In-flight channel turns keyed by mousse thread id. */
  private channelTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: string[]; promotedSteerIds: string[] }
  >()
  /** Optional thread store for durable queue persistence. */
  private threadStore: ThreadDataStore | null = null
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

  private phaseToActivity(phase: TurnPhase): ThreadActivityState {
    if (phase === 'awaiting_input') return 'awaiting_input'
    if (phase === 'queued' || phase === 'thinking' || phase === 'streaming' || phase === 'tool_running' || phase === 'finalizing') return 'processing'
    // A finished turn rests at completed (not idle) so background threads keep
    // their unread glow until visited. selectThread acknowledges it to idle.
    if (phase === 'completed') return 'completed'
    return 'idle'
  }

  private setTurnPhase(threadId: string, phase: TurnPhase, patch?: Partial<Pick<TurnState, 'turnId' | 'activeMessageId' | 'error' | 'errorDescriptor'>>): void {
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
    this.emit('turn-state', state)
    this.runtimeManager?.setActivity(threadId, this.phaseToActivity(phase))
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

  private get activeToolCallMessageIds(): Map<string, string> {
    return this.session.activeToolCallMessageIds
  }

  private get activeThinkingMessageId(): string | null {
    return this.session.activeThinkingMessageId
  }
  private set activeThinkingMessageId(value: string | null) {
    this.session.activeThinkingMessageId = value
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
  private set lastCompletedAssistantMessageId(value: string | null) {
    this.session.lastCompletedAssistantMessageId = value
  }

  private get lastCompletedAssistantContent(): string {
    return this.session.lastCompletedAssistantContent
  }
  private set lastCompletedAssistantContent(value: string) {
    this.session.lastCompletedAssistantContent = value
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

    this.mousseAgents = new MousseAgentService(this.llm, {
      completeAgent: (agentId, merge, summary) => this.completeMousseAgent(agentId, merge, summary)
    })

    this.mousseAgents.on('message', ({ agentId, message }) => {
      this.emit('mousse-agent-message', { agentId, message })
    })
    this.mousseAgents.on('message-updated', ({ agentId, message }) => {
      this.emit('mousse-agent-message-updated', { agentId, message })
    })
    this.mousseAgents.on('messages-sync', ({ agentId, messages }) => {
      this.emit('mousse-agent-messages-sync', { agentId, messages })
    })
    this.mousseAgents.on('complete', ({ agentId, summary }) => {
      this.emit('mousse-agent-complete', { agentId, summary })
    })
    this.mousseAgents.on('connection-failed', ({ agentId }) => {
      this.emit('mousse-agent-connection-failed', { agentId })
    })
    this.mousseAgents.on('lifecycle', (event: MousseAgentLifecycleEvent) => {
      if (event.state === 'failed') {
        this.reportGuiAgentFailure(
          event.agentId,
          event.reason ?? event.lastError ?? 'GUI subagent failed.'
        )
      } else if (event.state === 'interrupted') {
        this.reportGuiAgentInterrupted(
          event.agentId,
          event.reason ?? event.lastError ?? 'GUI subagent session was interrupted.'
        )
      }
    })

    this.headlessRunner.on('exit', ({ agentId, exitCode }) => {
      const owner = this.agentOwners.get(agentId)
      if (owner && owner !== this.session) {
        this.sessionAls.run(owner, () => this.handleHeadlessExit(agentId, exitCode))
        return
      }
      this.handleHeadlessExit(agentId, exitCode)
    })
  }

  private handleHeadlessExit(agentId: string, exitCode: number | null): void {
    const agent = this.agents.get(agentId)
    if (!agent || agent.executionMode !== 'headless') return
    if (agent.status !== 'starting' && agent.status !== 'running') return
    // Completion already reported and awaiting readiness validation.
    if (this.readinessChecks.has(agentId)) return
    if (exitCode === null) return
    if (exitCode !== 0) {
      this.handleAgentProgress(agentId, {
        status: 'failed',
        message: `Headless agent exited with code ${exitCode}.`
      })
      return
    }
    // Exit 0 without a terminal report: the poll interval may simply not have observed the
    // final progress write yet, so read it one last time before declaring the agent lost.
    const reported = readFinalAgentProgress(agent.worktreePath)
    if (reported) {
      this.handleAgentProgress(agentId, reported)
      return
    }
    this.handleAgentProgress(agentId, {
      status: 'failed',
      message: 'Headless agent exited without reporting completion.'
    })
  }

  setPersistCallback(fn: (threadId?: string | null) => void): void {
    this.persistFn = fn
    this.mousseAgents.setPersistCallback((_immediate, agentId) => {
      const threadId = agentId ? this.agentOwners.get(agentId)?.threadId : this.getBoundThreadId()
      if (threadId) this.persistFn?.(threadId)
    })
  }

  /** Optional ThreadDataStore for durable queue + cross-thread persistence. */
  setThreadStore(store: ThreadDataStore | null): void {
    this.threadStore = store
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
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        this.threadStore.getThread(threadId)?.modelOverride
      )
      if (this.projectManager) {
        const projectPath = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
        session.projectCwd = resolveProjectWorkingDirectory(projectPath)
      }
    }
    // Hydrate runtime after session is registered to avoid re-entrant create.
    this.sessions.set(threadId, session)
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
    session.modelOverride = override ? structuredClone(override) : undefined
    if (this.threadStore) {
      this.threadStore.updateThreadMeta(threadId, { modelOverride: session.modelOverride })
    }
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
        this.threadStore?.getThread(threadId)?.modelOverride
      )
    }

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

  /** Mark thread deleted so pending work will not execute. */
  markThreadDeleted(threadId: string): void {
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

  enqueueForThread(
    threadId: string,
    input: OrchestratorSendInput,
    opts?: { source?: string; intent?: 'normal' | 'steer'; internal?: boolean }
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
          internal: opts?.internal
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
      internal: opts?.internal
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
        return result.items
      })
    } else {
      const result = removeQueuedMessage(session.queue, itemId)
      if (result.removed?.workflowInvocationId) this.workflowChat?.abandon(result.removed.workflowInvocationId, threadId)
      session.queue = result.items
      removed = result.removed
    }
    this.emitQueueUpdated(threadId, session.queue)
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
    const localActive = session.isTurnActive() || this.isChannelTurnActive(threadId)
    const externalActive = this.isThreadLeaseHeldExternally(
      threadId,
      session.executionLease?.owner.token
    )
    if (!localActive && !externalActive) {
      throw new QueueValidationError('No active turn to steer on this thread.')
    }
    let item: QueuedMessage
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, (disk) => {
        const result = promoteQueuedMessageToSteer(disk, itemId)
        item = result.item
        return result.items
      })
    } else {
      const result = promoteQueuedMessageToSteer(session.queue, itemId)
      session.queue = result.items
      item = result.item
    }
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
        ...(this.antigravity?.configured() ? ['antigravity'] : [])
      ])
      if (selectedModel.llmProvider === 'antigravity') {
        // ACP owns its context and does not publish a token window in its model
        // selector. Do not display a fabricated Mousse context measurement.
        return { percent: 0, used: 0, limit: 0, modelName: selectedModel.model, source: 'estimated', categories: [] }
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

  private addMessage(
    role: 'user' | 'assistant',
    content: string,
    images?: ChatImageAttachment[],
    responseMetadata?: ChatMessage['responseMetadata'],
    queueItemId?: string,
    mode?: ChatMode
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      responseMetadata,
      queueItemId: role === 'user' && queueItemId ? queueItemId : undefined,
      ...(role === 'user' && mode !== undefined ? { mode: normalizeChatMode(mode) } : {})
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
    workflowRun?: WorkflowChatRun
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

  private addToolTimelineMessage(
    kind: NonNullable<ChatMessage['kind']>,
    toolCall: NonNullable<ChatMessage['toolCall']>
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind,
      content: '',
      timestamp: new Date().toISOString(),
      toolCall
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

  private updateThinkingMessage(
    messageId: string,
    content: string,
    status: NonNullable<ChatMessage['thinking']>['status']
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      thinking: { content, status }
    }
    this.messages[index] = updated
    this.emitMessageUpdated(updated)
    this.persist(status === 'complete')
  }

  private addStreamingAssistantMessage(): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
    this.setTurnPhase(this.session.threadId, 'streaming', { activeMessageId: msg.id })
    return msg
  }

  private updateStreamingAssistantMessage(
    messageId: string,
    content: string,
    streaming: boolean,
    responseMetadata?: ChatMessage['responseMetadata'],
    incomplete?: boolean
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      content,
      streaming,
      ...(responseMetadata ? { responseMetadata } : {}),
      ...(incomplete ? { incomplete: true } : {})
    }
    this.messages[index] = updated
    this.emitMessageUpdated(updated)
    this.persist(!streaming)
  }

  private removeMessage(messageId: string): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return
    this.messages.splice(index, 1)
    this.emitThreadMessages(this.session.threadId, this.session.messages)
    this.persist(true)
  }

  private handleStreamingTextEvent(event: import('./LlmClient').StreamingLlmTextEvent): void {
    if (event.phase === 'start') {
      if (!this.activeAssistantMessageId) {
        const msg = this.addStreamingAssistantMessage()
        this.activeAssistantMessageId = msg.id
      }
      return
    }

    if (!this.activeAssistantMessageId) return

    if (event.phase === 'delta') {
      this.updateStreamingAssistantMessage(
        this.activeAssistantMessageId,
        event.content,
        true
      )
      return
    }

    if (event.phase === 'complete') {
      const messageId = this.activeAssistantMessageId
      this.updateStreamingAssistantMessage(messageId, event.content, false)
      this.lastCompletedAssistantMessageId = messageId
      this.lastCompletedAssistantContent = event.content
      this.activeAssistantMessageId = null
    }
  }

  private handleStreamingThinkingEvent(event: StreamingLlmThinkingEvent): void {
    if (event.phase === 'start') {
      const msg = this.addThinkingMessage('', 'processing')
      this.activeThinkingMessageId = msg.id
      this.setTurnPhase(this.session.threadId, 'thinking')
      return
    }

    if (!this.activeThinkingMessageId) return

    if (event.phase === 'delta') {
      this.updateThinkingMessage(this.activeThinkingMessageId, event.content, 'processing')
      return
    }

    if (event.phase === 'complete') {
      this.updateThinkingMessage(this.activeThinkingMessageId, event.content, 'complete')
      this.activeThinkingMessageId = null
    }
  }

  private addThinkingMessage(
    content: string,
    status: NonNullable<ChatMessage['thinking']>['status']
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind: 'thinking',
      content: '',
      timestamp: new Date().toISOString(),
      thinking: { content, status }
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
    return msg
  }

  private handleStreamingToolEvent(event: StreamingLlmToolEvent): void {
    const timelineKind =
      event.kind === 'build_tool_call'
        ? 'mcp_tool_call'
        : event.kind === 'build_tool_result'
          ? 'mcp_tool_result'
          : event.kind

    if (event.phase === 'start' && event.callId) {
      const parsed = parseProviderToolCall(event)
      const msg = this.addToolTimelineMessage(timelineKind, {
        title: event.title,
        summary: event.summary,
        details: event.details,
        response: event.response,
        status: 'processing',
        ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
        ...(parsed.input ? { input: parsed.input } : {}),
      })
      this.activeToolCallMessageIds.set(event.callId, msg.id)
      this.setTurnPhase(this.session.threadId, 'tool_running')
      return
    }

    if (event.phase === 'complete' && event.callId) {
      const messageId = this.activeToolCallMessageIds.get(event.callId)
      if (messageId) {
        const existing = this.messages.find((message) => message.id === messageId)
        const parsed = parseProviderToolCall(event)
        this.updateToolTimelineMessage(messageId, {
          title: event.title,
          summary: event.summary,
          details: event.details,
          response: event.response,
          status: 'complete',
          // Preserve start-phase args: complete events carry result text, not args JSON.
          toolName: parsed.toolName ?? existing?.toolCall?.toolName,
          input: existing?.toolCall?.input ?? parsed.input,
        }, true)
        this.activeToolCallMessageIds.delete(event.callId)
        if (this.activeToolCallMessageIds.size === 0) {
          const fallback = this.activeAssistantMessageId ? 'streaming' as TurnPhase : 'thinking' as TurnPhase
          this.setTurnPhase(this.session.threadId, fallback)
        }
        return
      }
    }

    const parsedFallback = parseProviderToolCall(event)
    this.addToolTimelineMessage(timelineKind, {
      title: event.title,
      summary: event.summary,
      details: event.details,
      response: event.response,
      status: 'complete',
      ...(parsedFallback.toolName ? { toolName: parsedFallback.toolName } : {}),
      ...(parsedFallback.input ? { input: parsedFallback.input } : {}),
    })
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
   * Does not clear the durable normal message queue unless clearQueue is true.
   */
  abortActiveTurn(threadId?: string, opts?: { clearQueue?: boolean }): boolean {
    const id = threadId ?? this.getBoundThreadId()
    const session = id
      ? this.boundSession.threadId === id
        ? this.boundSession
        : this.sessions.get(id)
      : this.boundSession
    if (!session) return false
    const active = session.activeTurn
    if (!active && session.turnAdmitted && !session.abortRequested) {
      // Admitted but still in recovery/workspace setup: abort as soon as the turn starts.
      session.abortRequested = true
    } else if (!active || active.abort.signal.aborted) {
      return false
    } else {
      active.pendingSteer = []
      active.promotedSteerIds = []
      active.abort.abort()
    }
    if (opts?.clearQueue && id) {
      const clear = (items: QueuedMessage[]): QueuedMessage[] => {
        const retained = clearPendingQueue(items)
        const retainedIds = new Set(retained.map((item) => item.id))
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
    }
    this.emit('turn-aborted', { threadId: id ?? undefined })
    return true
  }

  isConversationHistoryBusy(threadId: string): boolean {
    const session = this.getOrCreateSession(threadId)
    this.refreshSessionQueueFromDisk(session)
    return session.isTurnRunning() || listPendingQueue(session.queue).length > 0
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

  steerThread(threadId: string | undefined, text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed || !threadId) return false
    const session =
      this.boundSession.threadId === threadId
        ? this.boundSession
        : this.sessions.get(threadId) ?? null
    if (session?.activeTurn && !session.activeTurn.abort.signal.aborted) {
      session.activeTurn.pendingSteer.push(trimmed)
      // Prefer ALS when already inside the turn; otherwise annotate bound if matching.
      const run = (): void => {
        // Mid-turn steers share the turn's mode — preserve tracking so the next
        // real turn does not mistake this UI echo for a legacy agent turn.
        const currentMode = getLastUserChatMode(this.messages)
        this.addMessage('user', trimmed, undefined, undefined, undefined, currentMode)
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
    // Local channel turn for this thread.
    if (this.steerChannelTurn(threadId, trimmed)) {
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
   * Abort an in-flight channel turn for a Mousse thread (Telegram/Discord).
   */
  abortChannelTurn(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    if (!turn || turn.abort.signal.aborted) return false
    turn.pendingSteer = []
    turn.promotedSteerIds = []
    turn.abort.abort()
    return true
  }

  /**
   * Steer an in-flight channel turn for a Mousse thread.
   */
  steerChannelTurn(threadId: string, text: string): boolean {
    const trimmed = text.trim()
    const turn = this.channelTurns.get(threadId)
    if (!trimmed || !turn || turn.abort.signal.aborted) return false
    turn.pendingSteer.push(trimmed)
    return true
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
    opts?: { threadId?: string; source?: string; forceQueue?: boolean }
  ): Promise<OrchestratorResponse> {
    return this.lifecycle.run('send', () => this.sendOwned(input, reuseLastUser, opts))
  }

  private async sendOwned(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: { threadId?: string; source?: string; forceQueue?: boolean }
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

    if (!opts?.forceQueue) {
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
      const item = this.enqueueForThread(threadId, input, { source: opts?.source })
      return {
        message: '',
        actions: [],
        queued: true,
        queueItem: item
      }
    }

    return this.runTurnOnSession(session, input, reuseLastUser, opts?.source !== 'wake', { source: opts?.source })
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
      modelOverride?: { llmProvider: string; model: string }
      onTurnSettled?: (aborted: boolean) => void
      /** The caller already admitted this session (see ThreadSession.turnAdmitted) and hands ownership to this turn. */
      admissionHeld?: boolean
    }
  ): Promise<OrchestratorResponse> {
    // Admission is synchronous, before any await, so a concurrent send always observes it.
    if (!opts?.admissionHeld) {
      if (session.turnAdmitted) {
        if (opts?.queueItemId) this.releaseSessionClaim(session, opts.queueItemId, opts.claimOwnerToken)
        throw new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
      }
      session.turnAdmitted = true
    }
    try {
      return await this.lifecycle.run('turn', () => this.sessionAls
        .run(session, () =>
          this.executeTurn(input, reuseLastUser, displayUserMessage, { ...opts, externalSignal: opts?.externalSignal ? AbortSignal.any([opts.externalSignal, this.lifecycle.signal]) : this.lifecycle.signal })
        ))
    } finally {
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
    opts?: { queueItemId?: string; claimOwnerToken?: string; suppressAutoQueueDrain?: boolean; externalSignal?: AbortSignal; onTurnSettled?: (aborted: boolean) => void }
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
      modelOverride?: { llmProvider: string; model: string }
      onTurnSettled?: (aborted: boolean) => void
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
          const item = this.enqueueForThread(session.threadId, input, { source: 'lease-race' })
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
    if (session.threadId !== '__unbound__' && this.projectManager && this.threadStore) {
        const projectPath = resolveThreadProjectPath(
          this.projectManager,
          this.threadStore,
          session.threadId
        )
        const threadDir = this.resolveThreadDir(session.threadId)
        if (projectPath && threadDir) {
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
            mode
          )
          claimAccepted = true
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
    this.activeToolCallMessageIds.clear()
    this.activeThinkingMessageId = null
    this.activeAssistantMessageId = null
    this.lastCompletedAssistantMessageId = null
    this.lastCompletedAssistantContent = ''

    const turnId = uuidv4()
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
      promotedSteerIds: [] as string[]
    }
    const turnAuthority = session.executionLease ? new TaskWriterAuthority(session.executionLease) : undefined
    const turnWriter = turnAuthority?.issue(turnId, { version: 1, workspace: 'shared', access: 'write' })
    const namedParent: NamedDelegationParent | undefined = turnAuthority && turnWriter && session.workspace ? {
      authority: turnAuthority, token: turnWriter, episodeId: turnId,
      policy: { version: 1, workspace: 'shared', access: mode === 'plan' ? 'read-only' : 'write' }, signal: turn.abort.signal,
      binding: { workspaceRoot: session.workspace.workspacePath, cwd: session.workspace.projectPath,
        branch: session.workspace.branch ?? '', workspaceId: session.workspace.workspaceId ?? session.threadId, generation: session.workspace.generation ?? 0 }
    } : undefined
    const mirrorExternalAbort = (): void => turn.abort.abort()
    if (opts?.externalSignal?.aborted) {
      mirrorExternalAbort()
    } else {
      opts?.externalSignal?.addEventListener('abort', mirrorExternalAbort, { once: true })
    }
    this.setTurnPhase(session.threadId, 'queued', { turnId })
    this.setTurnPhase(session.threadId, 'thinking', { turnId })
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

    let assistantText: string
    let aborted = false
    let responseMetadata: ChatMessage['responseMetadata'] | undefined
    let connectionFailed = false
    let executionFailed = false
    let providerError: AppErrorShape | undefined
    let failureDiagnostic: Record<string, unknown> | undefined
    let compactionNote: ChatMessage | undefined
    const selectedModel = opts?.modelOverride ?? session.modelOverride ?? resolveModelForMode(this.settingsStore.get(), mode, [
      ...(this.providerAuth.credentials?.listProviderIds() ?? []),
      ...(this.antigravity?.configured() ? ['antigravity'] : [])
    ])
    const antigravityTurn = selectedModel.llmProvider === 'antigravity'
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
    try {
      if (antigravityTurn) {
        if (mode === 'plan') throw new Error('Use Antigravity’s /plan command in a chat turn')
        const model = selectedModel.model
        if (!this.antigravity || !session.projectCwd) throw new Error('Antigravity requires a project workspace')
        let started = false
        assistantText = await this.antigravity.chat({
          threadId: session.threadId, cwd: session.projectCwd, model,
          prompt: userContent, images, signal: turn.abort.signal,
          history: antigravityHistory(this.nativeContext, turnNativeStartBoundary.messageIndex),
          drainSteer: () => {
            const parts = [opts?.externalDrainSteer?.()?.trim(), this.drainSteerForSession(session, turn)?.trim()]
              .filter((part): part is string => Boolean(part))
            return parts.length ? parts.join('\n') : undefined
          },
          onSteer: (content) => {
            this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(content))
            this.nativeContext.acceptedSteerItemIds = Array.from(new Set([
              ...(this.nativeContext.acceptedSteerItemIds ?? []), ...session.drainedExternalSteerIds
            ]))
            this.persist(true)
            this.acknowledgeDrainedSteers(session)
          },
          onText: (content) => {
            if (!started) { this.handleStreamingTextEvent({ phase: 'start', content: '', contentIndex: 0 }); started = true }
            this.handleStreamingTextEvent({ phase: 'delta', content, contentIndex: 0 })
          },
          onTool: (event) => {
            conversationToolsUsed = true
            this.handleStreamingToolEvent({
              kind: 'mcp_tool_call', phase: event.phase, callId: event.callId,
              title: event.title, summary: event.toolName ?? event.title, details: []
            })
          }
        })
        this.nativeContext = appendNativeMessage(this.nativeContext, antigravityAssistantMessage(assistantText, model))
        this.persist(true)
        this.antigravity.commitConversation(session.threadId, antigravityHistory(this.nativeContext))
        if (started) this.handleStreamingTextEvent({ phase: 'complete', content: assistantText, contentIndex: 0 })
        responseMetadata = { modelName: model }
      } else {
      const browserExecution = this.mainBrowserFactory
        ? this.mainBrowserFactory({ threadId: session.threadId, turnId, source: opts?.source, mode })
        : this.mainAgentBrowser?.execution.threadId === session.threadId && this.mainAgentBrowser.execution.turnId === turnId ? this.mainAgentBrowser : undefined
      const modelOverride = opts?.modelOverride ?? session.modelOverride
      const { limit } = this.llm.getSelectedModelContextLimit(mode, modelOverride)
      const contextSettings = normalizeContextSettings(this.settingsStore.get().context)
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
      const configuredThreshold = resolveContextCompactionTokens(contextSettings.compactionTokens, limit)
      if (contextSettings.compactionEnabled && shouldCompactNativeContext(
        activeTokens,
        limit,
        DEFAULT_COMPACTION_RESERVE_TOKENS,
        configuredThreshold
      )) {
        onCompaction('start')
        await new Promise<void>((resolve) => setTimeout(resolve, 30))
        const compacted = compactNativeContext(this.nativeContext)
        if (compacted !== this.nativeContext) {
          this.nativeContext = compacted
          this.clearLastTurnUsage()
          this.persist(true)
          onCompaction('complete')
        } else {
          onCompaction('unchanged')
        }
      }
      const result = await (async () => {
          const run = () => this.llm.chat(
            getActiveMessages(this.nativeContext),
            (event) => {
              if (event.kind !== 'skill_loaded') conversationToolsUsed = true
              this.handleStreamingToolEvent(event)
            },
            {
              mode,
              llmProvider: modelOverride?.llmProvider,
              model: modelOverride?.model,
              projectPath: session.projectCwd ?? undefined,
              threadId: session.threadId,
              browser: browserExecution,
              delegation: namedParent ? this.namedDelegation(session.threadId, namedParent) : undefined,
              toolAccess: turnAuthority && turnWriter ? { allows: () => true, execute: (_name, _args, run) => { conversationToolsUsed = true; return turnAuthority.runWriter(turnWriter, run) } } : undefined,
              signal: turn.abort.signal,
              onRetry: (attempt) => this.addSystemMessage(`Retrying provider request (${attempt}/5)…`),
              onProviderProgress: () => { providerProgress = true },
              drainSteer: () => {
                const parts = [
                  opts?.externalDrainSteer?.()?.trim(),
                  this.drainSteerForSession(session, turn)?.trim()
                ].filter((part): part is string => Boolean(part))
                return parts.length > 0 ? parts.join('\n') : undefined
              },
              contextSummary: getCompactionSummary(this.nativeContext),
              onNativeMessages: (nativeMessages, checkpoint) => {
                // A completed-turn measurement becomes stale as soon as the live loop
                // appends or compacts native history. Estimate until the final provider
                // response supplies a new authoritative prompt measurement.
                this.clearLastTurnUsage()
                this.commitActiveNativeMessages(nativeMessages, checkpoint)
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
                this.acknowledgeDrainedSteers(session)
                if (session.executionLease) {
                  heartbeatExecutionLease(session.executionLease)
                }
              },
              onCompaction,
              toolLoopSafety: contextSettings.compactionEnabled
                ? {
                    compactionThresholdTokens: configuredThreshold,
                    compactNativeMessages: (nativeMessages) =>
                      compactMessagesAtSafeBoundary(nativeMessages, undefined, this.nativeContext.compaction)
                  }
                : undefined
            },
            (event) => {
              this.handleStreamingThinkingEvent(event)
            },
            (event) => {
              this.handleStreamingTextEvent(event)
            }
          )
          return retryContextOverflowOnce(run, () => {
            if (!contextSettings.compactionEnabled) return false
            onCompaction('start')
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
          }, () => !conversationToolsUsed && !providerProgress)
      })()
      assistantText = result.text
      aborted = Boolean(result.aborted)
      responseMetadata = {
        modelName: result.modelName,
        totalResponseTimeMs: result.totalResponseTimeMs,
        tokensUsed: result.totalTokensUsed,
        tokensPerSecond: result.tokensPerSecond
      }
      this.commitActiveNativeMessages(result.nativeMessages)
      // Provider prompt usage excludes the assistant message it produced.
      this.recordLastTurnUsage({
        input: result.usage.input,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        signature: result.contextInputs.signature,
        measuredAtHistoryLength: Math.max(0, getActiveMessages(this.nativeContext).length - 1),
        contextRevision: this.nativeContext.revision ?? 0,
        modelKey: result.contextInputs.modelKey
      })
      }
    } catch (err) {
      const normalized = normalizeAppError(err, 'orchestrator_turn_failed')
      const isAbort = turn.abort.signal.aborted || normalized.errorInfo.category === 'cancelled'
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
      this.activeTurn = null
    }

    if (this.activeThinkingMessageId) {
      const thinkingMessage = this.messages.find((message) => message.id === this.activeThinkingMessageId)
      if (thinkingMessage?.thinking?.status === 'processing') {
        this.updateThinkingMessage(
          this.activeThinkingMessageId,
          thinkingMessage.thinking.content,
          'complete'
        )
      }
      this.activeThinkingMessageId = null
    }

    if (providerError) {
      console.error('Orchestrator turn failed', failureDiagnostic ?? errorDiagnostic(providerError, 'orchestrator.chat'))
      if (this.activeAssistantMessageId) {
        const partial = this.messages.find((message) => message.id === this.activeAssistantMessageId)?.content ?? ''
        this.updateStreamingAssistantMessage(this.activeAssistantMessageId, partial, false, undefined, true)
        this.activeAssistantMessageId = null
      }
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
      await checkpointTurn('failed')
      this.persist(true)
      const response: OrchestratorResponse = { message, actions: [], error: providerError }
      this.emit('response', response)
      opts?.onTurnSettled?.(false)
      this.emit('turn-failed', { threadId: session.threadId })
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return response
    }

    if (aborted) {
      const streamedPartial = this.activeAssistantMessageId
        ? this.messages.find((message) => message.id === this.activeAssistantMessageId)?.content
        : undefined
      const partial =
        stripActionBlocks(assistantText).trim() ||
        streamedPartial?.trim() ||
        '(Stopped)'
      if (this.activeAssistantMessageId) {
        this.updateStreamingAssistantMessage(this.activeAssistantMessageId, partial, false, undefined, true)
        this.activeAssistantMessageId = null
      } else {
        const stopped = this.addMessage('assistant', partial)
        const index = this.messages.findIndex((message) => message.id === stopped.id)
        if (index !== -1) {
          const updated = { ...this.messages[index], incomplete: true }
          this.messages[index] = updated
          this.emitMessageUpdated(updated)
        }
      }
      this.addSystemMessage('Turn stopped.')
      const response: OrchestratorResponse = { message: partial, actions: [] }
      this.setTurnPhase(session.threadId, 'stopped')
      await checkpointTurn('stopped')
      this.persist(true)
      // Cross-channel IPC delivery and an in-flight renderer snapshot can otherwise leave
      // the persisted stopped message invisible until the thread is reopened.
      this.emitThreadMessages(session.threadId, session.messages)
      this.emit('response', response)
      opts?.onTurnSettled?.(true)
      this.emit('turn-interrupted', { threadId: session.threadId })
      // Stop aborts the active turn but retains normal queued messages.
      return response
    }

    if (mode === 'plan') {
      const planMarkdown = stripActionBlocks(assistantText) || assistantText.trim() || 'No plan generated.'
      if (this.activeAssistantMessageId) {
        const streamingId = this.activeAssistantMessageId
        this.activeAssistantMessageId = null
        this.removeMessage(streamingId)
      }
      const planMsg = this.addPlanCardMessage(userContent, planMarkdown, responseMetadata)
      const response: OrchestratorResponse = {
        message: planMsg.content,
        actions: []
      }
      this.setTurnPhase(session.threadId, 'finalizing')
      await checkpointTurn('completed')
      this.persist(true)
      this.setTurnPhase(session.threadId, 'completed')
      this.emit('response', response)
      this.emitThreadMessages(session.threadId, session.messages)
      opts?.onTurnSettled?.(false)
      this.emit('turn-completed', { threadId: session.threadId })
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return response
    }

    const parsedActions = antigravityTurn ? [] : parseActions(assistantText)
    const actions = filterActionsForChatMode(parsedActions, mode)
    const displayText = stripActionBlocks(assistantText)

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

    for (const action of actions) {
      if (rejectOrchestrationAction(action, mode)) {
        const modeLabel = getChatModeLabel(mode)
        this.addSystemMessage(
          `[${modeLabel.toLowerCase()}] Blocked orchestration action "${action.type}" — ${modeLabel} mode cannot spawn agents or complete tasks.`
        )
        continue
      }
      conversationToolsUsed = true
      const toolCallMessage = this.addToolCallMessage(action)
      try {
        const logs = await this.executeAction(action)
        const failures = logs.filter(
          action.type === 'spawn_agents' ? isSpawnAgentsFailureLog : isActionFailureLog
        )
        this.updateToolTimelineMessage(
          toolCallMessage.id,
          {
            title:
              action.type === 'spawn_agents'
                ? failures.length > 0
                  ? 'Agent spawn finished with errors'
                  : `${action.agents.length === 1 ? 'Agent' : 'Agents'} spawned`
                : action.type === 'complete_task'
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
          const failureWake = buildCompleteTaskFailureWake(action.agentIds, logs)
          if (failureWake) {
            this.scheduleOrchestratorWake(failureWake)
          } else {
            const successWake = buildCompleteTaskSuccessWake(action.agentIds, logs)
            if (successWake) this.scheduleOrchestratorWake(successWake)
          }
        } else if (action.type === 'spawn_agents') {
          const wakeMessage = buildSpawnAgentsFailureWake(logs)
          if (wakeMessage) this.scheduleOrchestratorWake(wakeMessage)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.updateToolTimelineMessage(
          toolCallMessage.id,
          {
            title: action.type === 'spawn_agents' ? 'Agent spawn failed' : 'Action failed',
            summary: message,
            details: [message],
            status: 'complete'
          },
          true
        )
        this.addSystemMessage(`[action failed] ${message}`)
        if (action.type === 'spawn_agents') {
          const wakeMessage = buildSpawnAgentsFailureWake([
            `[spawn-failure agent=unreserved task=unregistered] ${message}`
          ])
          if (wakeMessage) this.scheduleOrchestratorWake(wakeMessage)
        } else if (action.type === 'complete_task') {
          const wakeMessage = buildCompleteTaskFailureWake(action.agentIds, [
            `[complete] Failed: ${message}`
          ])
          if (wakeMessage) this.scheduleOrchestratorWake(wakeMessage)
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
    } else {
      this.setTurnPhase(session.threadId, 'finalizing')
    }
    await checkpointTurn(executionFailed ? 'failed' : 'completed')
    this.persist(true)
    if (!executionFailed) this.setTurnPhase(session.threadId, 'completed')
    this.emit('response', response)
    this.emitThreadMessages(session.threadId, session.messages)
    opts?.onTurnSettled?.(false)
    this.emit(executionFailed ? 'turn-failed' : 'turn-completed', { threadId: session.threadId })
    this.releaseSessionExecutionLease(session)
    if (!suppressAutoQueueDrain) session.drainAfterSettle = true
    return response
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
    turn: { pendingSteer: string[]; promotedSteerIds: string[] }
  ): string | undefined {
    const parts: string[] = []
    if (turn.pendingSteer.length > 0) {
      parts.push(...turn.pendingSteer)
      turn.pendingSteer = []
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
    const item = claimed as QueuedMessage
    const managedByStartup = opts?.managedByStartup === true
    void this.runTurnOnSession(
      session,
      {
        content: item.content,
        workflowInvocationId: item.workflowInvocationId,
        mode: item.mode,
        images: item.images
      },
      false,
      !item.internal,
      {
        queueItemId: item.id,
        claimOwnerToken: claimToken,
        source: item.source,
        suppressAutoQueueDrain: managedByStartup
      }
    )
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
      case 'spawn_agents':
        return this.spawnAgents(action.agents)
      case 'complete_task':
        return this.completeTask(action.agentIds, action.merge !== false)
      case 'message':
        return [action.content]
      default:
        return []
    }
  }

  /**
   * Orchestrator-facing API for GUI subagent terminal failures.
   * Marks agent + task failed with the exact reason, stops progress monitoring,
   * wakes the parent batch when appropriate, and never removes the worktree.
   */
  reportGuiAgentFailure(agentId: string, reason: string): void {
    this.reportGuiAgentTerminalState(agentId, reason, 'failed')
  }

  /** Mark a lost GUI session as interrupted while retaining its recoverable worktree/history. */
  reportGuiAgentInterrupted(agentId: string, reason: string): void {
    this.reportGuiAgentTerminalState(agentId, reason, 'interrupted')
  }

  private reportGuiAgentTerminalState(
    agentId: string,
    reason: string,
    status: 'failed' | 'interrupted'
  ): void {
    const owner = this.agentOwners.get(agentId)
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
    this.progressMonitor.stop(agentId)
    this.liveGuiAgents.delete(agentId)
    this.agents.updateStatus(agentId, status)

    const task = this.tasks.findByAgentId(agentId)
    if (task) {
      this.tasks.updateProgress(task.id, { message })
      this.tasks.updateStatus(task.id, status)
    }

    this.addSystemMessage(`[Agent ${agentId.slice(0, 8)} ${status}] ${message}`)
    this.checkDelegationBatches()
  }

  private handleAgentProgress(agentId: string, update: AgentProgressUpdate): void {
    const owner = this.agentOwners.get(agentId)
    if (owner && owner !== this.session) {
      this.sessionAls.run(owner, () => this.handleAgentProgress(agentId, update))
      return
    }
    const agent = this.agents.get(agentId)
    const task = this.tasks.findByAgentId(agentId)
    if (!agent || !task || isTerminalAgentStatus(agent.status)) return

    this.tasks.updateProgress(task.id, {
      progress: update.progress,
      message: update.message,
      summary: update.summary
    })
    if (update.status === 'working') return

    if (update.status === 'completed') {
      void this.validateAndMarkAgentReady(agentId, update)
    } else {
      this.progressMonitor.stop(agentId)
      this.liveGuiAgents.delete(agentId)
      this.agents.updateStatus(agentId, 'failed')
      this.tasks.updateStatus(task.id, 'failed')
      this.addSystemMessage(
        `[Agent ${agentId.slice(0, 8)} failed] ${update.message || 'No failure reason supplied.'}`
      )
    }
    this.checkDelegationBatches()
  }

  private checkDelegationBatches(): void {
    for (const batch of [...this.delegationBatches]) {
      const owner = this.delegationBatchOwners.get(batch) ?? this.session
      const agents = [...batch]
        .map((id) => owner.agents.get(id))
        .filter((agent): agent is Agent => Boolean(agent))
      if (agents.length !== batch.size) continue
      if (!agents.every((agent) => isDelegationSettledStatus(agent.status))) continue
      this.delegationBatches.delete(batch)
      const report = agents.map((agent) => {
        const task = owner.tasks.findByAgentId(agent.id)
        // complete_task requires exact registry ids. Reporting only the display prefix
        // makes the model emit an id that cannot be resolved and silently skips merging.
        return `- ${agent.id} (${agent.status}): ${task?.summary || task?.progressMessage || agent.task}`
      }).join('\n')
      this.sessionAls.run(owner, () => {
        this.scheduleOrchestratorWake(
          `[Automatic task update] All agents in the delegation batch have finished.\n${report}\nInspect the results. If the ready branches should be integrated, emit complete_task with merge true. Do not merge failed, cancelled, or interrupted agents unless their work is intentionally recovered.`
        )
      })
    }
  }

  private scheduleOrchestratorWake(message: string): void {
    if (this.lifecycle.stopping) return
    const wakeSession = this.session
    const threadId = wakeSession.threadId
    const queue = this.wakeQueues.get(threadId) ?? []
    queue.push(message)
    this.wakeQueues.set(threadId, queue)
    if (this.wakeTimers.has(threadId)) return

    const wake = (): void => {
      this.wakeTimers.delete(threadId)
      const content = this.wakeQueues.get(threadId)?.splice(0).join('\n\n') ?? ''
      this.wakeQueues.delete(threadId)
      if (!content) return

      // Automatic subagent reports use the same durable FIFO as user sends. They are
      // intentionally hidden from queue/transcript presentation, but are still claimed,
      // persisted, and delivered to the main agent as model context.
      if (threadId !== '__unbound__') {
        try {
          this.enqueueForThread(threadId, { content, mode: 'agent' }, {
            source: 'wake',
            internal: true
          })
          this.scheduleQueueDrain(wakeSession)
          return
        } catch (err) {
          this.sessionAls.run(wakeSession, () => {
            this.addSystemMessage(
              `[automatic wake failed] ${err instanceof Error ? err.message : String(err)}`
            )
          })
          return
        }
      }

      void this.send({ content, mode: 'agent' }, false, { source: 'wake' }).catch((err) => {
        this.sessionAls.run(wakeSession, () => {
          this.addSystemMessage(
            `[automatic wake failed] ${err instanceof Error ? err.message : String(err)}`
          )
        })
      })
    }
    this.wakeTimers.set(threadId, setTimeout(wake, 100))
  }

  listNamedAgents(threadId: string) {
    if (!this.threadStore?.getThread(threadId)) throw new Error('Task unavailable')
    return new AgentEpisodeStore(this.resolveThreadDir(threadId)!).read()
  }

  async createNamedAgent(threadId: string, input: {
    name: string; task: string; operationId: string; policy?: Partial<AgentWorkspacePolicy>
    provider?: string; model?: string; effort?: string; expectedAgentGeneration?: number; contextMode?: 'continue' | 'fresh'; resumeResult?: boolean
  }) {
    let admitted!: (result: Awaited<ReturnType<OrchestratorService['runNamedAgent']>>) => void
    let rejectAdmission!: (error: unknown) => void
    const admission = new Promise<Awaited<ReturnType<OrchestratorService['runNamedAgent']>>>((resolve, reject) => { admitted = resolve; rejectAdmission = reject })
    const running = this.lifecycle.run('named-agent', () => this.runNamedAgent(threadId, input, admitted))
    void running.then(admitted, rejectAdmission)
    return admission
  }

  private async runNamedAgent(threadId: string, input: {
    name: string; task: string; operationId: string; policy?: Partial<AgentWorkspacePolicy>
    provider?: string; model?: string; effort?: string; expectedAgentGeneration?: number; contextMode?: 'continue' | 'fresh'; resumeResult?: boolean
  }, onAdmitted?: (result: { agent: import('../../shared/agentEpisodes').NamedAgentIdentity | undefined; episode: AgentEpisode }) => void, parent?: NamedDelegationParent) {
    const owner = this.getOrCreateSession(threadId)
    const directory = this.resolveThreadDir(threadId)
    if (!directory || !this.threadStore?.getThread(threadId) || !this.projectManager) throw new Error('Task unavailable')
    const project = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
    if (!project) throw new Error('Named agents require a task project')
    const policy = resolveAgentWorkspacePolicy(input.policy, { adapter: 'mousse', inherited: parent?.policy })
    const store = new AgentEpisodeStore(directory)
    if (!/^[a-z0-9][a-z0-9_-]{2,127}$/i.test(input.operationId)) throw new Error('Invalid episode operation identity')
    const request = { name: input.name, provider: input.provider, model: input.model, effort: input.effort, expectedAgentGeneration: input.expectedAgentGeneration, contextMode: input.contextMode, resumeResult: input.resumeResult }
    const previous = store.read().episodes.find((episode) => episode.id === input.operationId)
    if (previous) {
      if (previous.task !== input.task || JSON.stringify(previous.policy) !== JSON.stringify(policy) || JSON.stringify(previous.request) !== JSON.stringify(request) || store.resolve(input.name)?.id !== previous.agentId) throw new Error('Episode idempotency key reused with different input')
      return { agent: store.resolve(previous.agentId), episode: previous }
    }
    const recalled = store.resolve(input.name)
    if (input.expectedAgentGeneration === undefined && recalled) throw namedContextErrors.create('agent_name_exists')
    if (input.expectedAgentGeneration !== undefined && (!recalled || recalled.contextGeneration !== input.expectedAgentGeneration)) throw namedContextErrors.create('agent_generation_changed')
    if (recalled && this.namedSettlements.has(recalled.id)) throw new Error('Named agent is still draining its previous episode')
    if (recalled?.activeEpisodeId) throw new Error(`Named agent already owns episode ${recalled.activeEpisodeId}`)
    const priorEpisode = recalled ? store.read().episodes.find((entry) => entry.id === recalled.lastEpisodeId) : undefined
    const priorContext = recalled ? store.contextSource(recalled.id) : undefined
    const assignment = this.llm.resolveSubagentAssignment({ llmProvider: input.provider, model: input.model, effort: input.effort })
    if (priorContext && input.contextMode !== 'fresh' && (priorContext.snapshot.assignment.provider !== assignment.provider || priorContext.snapshot.assignment.model !== assignment.model)) throw namedContextErrors.create('agent_context_model_changed')
    let lease: ThreadLeaseHandle | undefined = parent?.authority?.lease
    let ownsLease = false
    let episode: AgentEpisode | undefined
    let authority: TaskWriterAuthority | undefined
    try {
      const manager = new ThreadWorkspaceManager(directory)
      // Provisioning and snapshot creation are short writer operations. Shared readers
      // subsequently observe the live owned tree without acquiring writer permission.
      if (!lease && (!manager.load() || !existsSync(manager.load()!.worktreePath) || policy.access === 'write' || policy.workspace === 'isolated')) {
        lease = await waitAcquireExecutionLease(directory, { source: 'named-agent', signal: parent?.signal ?? this.lifecycle.signal, maxAttempts: 36_000 })
        ownsLease = true
      }
      if (!manager.load()) await manager.provision(threadId, 'main', project, this.lifecycle.signal, lease)
      if (manager.load() && !existsSync(manager.load()!.worktreePath) && manager.hasReconstructionManifest()) await manager.restore(project, this.lifecycle.signal, lease)
      const metadata = manager.load()!
      if (metadata.lifecycle !== 'ready') throw new Error('Task workspace is not ready')
      let path = parent?.binding.cwd ?? manager.executionContext(project, metadata).projectPath
      let workspaceRoot = parent?.binding.workspaceRoot ?? metadata.worktreePath, branch = parent?.binding.branch ?? metadata.branch
      let base = actionGit(workspaceRoot, ['rev-parse', 'HEAD'])
      if (lease && !parent && manager.verify(metadata).lifecycle !== 'ready') throw new Error('Task workspace revision changed; recovery required')
      if (lease && (policy.access === 'write' || parent?.policy.access === 'write') && actionGit(workspaceRoot, ['status', '--porcelain', '--untracked-files=all'])) {
        const captured = await new ThreadActionService(lease.threadDir).checkpointExistingTurn({
          threadId, turnId: `named-input:${input.operationId}`, conversationBranchId: metadata.conversationBranchId,
          workspacePath: workspaceRoot, heldThreadLease: lease, actor: { kind: 'agent', id: parent?.episodeId ?? input.operationId },
          presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
        }, base, 'completed')
        base = captured.endSha
      }
      if (input.resumeResult) {
        if (!priorEpisode || priorEpisode.policy.workspace !== 'isolated' || policy.workspace !== 'isolated' || !priorEpisode.result?.resultSha || store.read().integrations?.some((entry) => entry.episodeId === priorEpisode.id)) throw new Error('Resume-result requires an explicit isolated request for an unintegrated retained result')
        actionGit(workspaceRoot, ['cat-file', '-e', `${priorEpisode.result.resultSha}^{commit}`])
        base = priorEpisode.result.resultSha
      }
      const agent = recalled ?? { id: uuidv4(), name: input.name, contextGeneration: 0 }
      if (priorContext && input.contextMode !== 'fresh') {
        const consumed = priorContext.episode.parentConversation
        if (consumed.branchId !== metadata.conversationBranchId || consumed.boundary > owner.nativeContext.messages.length ||
          !consumed.prefixHash || consumed.prefixHash !== sha256Hex(canonicalJson(owner.nativeContext.messages.slice(0, consumed.boundary)))) {
          throw namedContextErrors.create('agent_context_stale')
        }
      }
      const recordEpisode = () => {
        episode = store.admit(agent.name, { id: input.operationId, agentId: agent.id, task: input.task, policy, assignment, request,
          contextGeneration: agent.contextGeneration, parentEpisodeId: parent?.episodeId,
          binding: { workspaceId: policy.workspace === 'shared' ? parent?.binding.workspaceId ?? metadata.workspaceId ?? threadId : input.operationId,
            generation: parent?.binding.generation ?? metadata.generation ?? 0, worktreePath: workspaceRoot, branch, baseSha: base,
            integrationBaseSha: input.resumeResult ? priorEpisode?.binding.integrationBaseSha ?? priorEpisode?.binding.baseSha : undefined,
            consistency: policy.workspace === 'shared' ? 'moving' : 'snapshot' },
          parentConversation: { branchId: metadata.conversationBranchId, boundary: owner.nativeContext.messages.length, prefixHash: sha256Hex(canonicalJson(owner.nativeContext.messages)) } })
      }
      if (policy.workspace === 'isolated') {
        if (actionGit(workspaceRoot, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Checkpoint task changes before requesting an isolated snapshot')
        const child = await withGitMutationLocks(lease!.threadDir, workspaceRoot, 'named-agent-snapshot',
          () => this.worktrees.createWorktree(input.operationId, workspaceRoot, base, (planned) => {
            workspaceRoot = planned.path; branch = planned.branch; recordEpisode()
          }), this.lifecycle.signal, lease)
        workspaceRoot = child.path; branch = child.branch
        path = metadata.projectRelativeSubdirectory ? join(child.path, metadata.projectRelativeSubdirectory) : child.path
      } else recordEpisode()
      this.agentOwners.set(agent.id, owner)
      const agentProjection = { cliType: 'mousse' as const, executionMode: 'gui' as const, task: input.task,
        worktreePath: workspaceRoot, branch, repositoryRoot: metadata.worktreePath,
        namedIdentityId: agent.id, episodeId: episode!.id, workspacePolicy: policy }
      if (owner.agents.get(agent.id)) { owner.agents.update(agent.id, agentProjection); owner.agents.updateStatus(agent.id, 'running') }
      else owner.agents.create({ ...agentProjection, status: 'running' }, agent.id)
      // An isolated worker owns a different checkout and metadata lock. Parent writers
      // may resume immediately after the immutable snapshot has been established.
      if (lease && (policy.access === 'read-only' || policy.workspace === 'isolated')) {
        if (ownsLease) releaseExecutionLeaseHandle(lease)
        lease = undefined; ownsLease = false
      }
      if (policy.access === 'write' && !lease) {
        lease = await waitAcquireExecutionLease(join(directory, 'agent-changes', agent.id), { source: 'named-agent-isolated', signal: parent?.signal ?? this.lifecycle.signal }); ownsLease = true
      }
      authority = lease ? (!ownsLease && parent?.authority ? parent.authority : new TaskWriterAuthority(lease)) : undefined
      const token = authority?.issue(episode!.id, policy, authority === parent?.authority ? parent?.token : undefined)
      const access = createAgentToolAccess(policy, path, authority && token ? (run) => authority!.runWriter(token, run) : undefined)
      const childParent: NamedDelegationParent = { policy, episodeId: episode!.id, authority, token, signal: token?.signal ?? parent?.signal ?? this.lifecycle.signal,
        binding: { workspaceRoot, cwd: path, branch, workspaceId: episode!.binding.workspaceId, generation: episode!.binding.generation } }
      const savedContext = recalled && input.contextMode !== 'fresh' ? priorContext?.snapshot : undefined
      if (savedContext) this.mousseAgents.restoreSessions([savedContext], false)
      this.mousseAgents.prepareManagedEpisode(agent.id, input.task, path, assignment, access, Boolean(savedContext), this.namedDelegation(threadId, childParent),
        { workspaceRoot, episodeId: episode!.id })
      const executionTask = recalled ? `[Mousse recall notice: continuing named identity ${agent.name}. Previous result ${priorEpisode?.result?.resultSha ?? 'unavailable'}; current workspace ${base}; policy ${policy.workspace}/${policy.access}. ${savedContext ? 'Historical context is retained; filesystem observations must be checked again.' : 'Active context was rebuilt; historical episodes remain retained but their instructions are not replayed.'} No prior commands or approvals are replayed.]\n${input.task}` : input.task
      onAdmitted?.({ agent: store.resolve(agent.id), episode: structuredClone(episode!) })
      const execute = async () => {
        if (parent?.signal.aborted || token?.signal.aborted || this.lifecycle.signal.aborted) throw new Error('Agent episode cancelled before execution')
        if (policy.access === 'write') new ThreadActionService(lease!.threadDir).beginTurn({
          threadId, turnId: episode!.id, conversationBranchId: metadata.conversationBranchId, workspacePath: workspaceRoot,
          actor: { kind: 'agent', id: agent.id }, heldThreadLease: lease,
          presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
        }, base)
        store.running(episode!.id)
        await this.mousseAgents.send(agent.id, executionTask, undefined, !savedContext)
      const interrupted = this.mousseAgents.getRunState(agent.id) === 'interrupted'
      const failed = interrupted || this.mousseAgents.getRunState(agent.id) === 'failed'
      let receiptId: string | undefined, resultSha = base
      if (policy.access === 'write') {
        const action = await new ThreadActionService(lease!.threadDir).checkpointExistingTurn({
          threadId, turnId: episode!.id, conversationBranchId: metadata.conversationBranchId, workspacePath: workspaceRoot,
          actor: { kind: 'agent', id: agent.id }, heldThreadLease: lease,
          presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
        }, base, interrupted ? 'stopped' : failed ? 'failed' : 'completed')
        receiptId = action.receiptId; resultSha = action.endSha
      }
      const snapshot = this.mousseAgents.exportSessions().find((entry) => entry.agentId === agent.id)
      const completed = store.complete(episode!.id, episode!.contextGeneration, { receiptId, resultSha,
        nativeContextRevision: (snapshot as { nativeContext?: { revision?: number } })?.nativeContext?.revision }, interrupted ? 'interrupted' : failed ? 'failed' : 'completed', snapshot)
      owner.agents.updateStatus(agent.id, interrupted ? 'interrupted' : failed ? 'failed' : 'ready')
      this.emit('agent-spawned', { agent: owner.agents.get(agent.id), threadId })
      return { agent: store.resolve(agent.id), episode: completed }
      }
      const heartbeat = ownsLease && lease ? setInterval(() => heartbeatExecutionLease(lease!), 10_000) : undefined
      heartbeat?.unref()
      const abortChild = () => {
        this.mousseAgents.abort(agent.id)
        if (authority && token) void authority.revokeAndDrain(token).catch(() => undefined)
      }
      const abortNative = () => { this.mousseAgents.abort(agent.id) }
      token?.signal.addEventListener('abort', abortNative, { once: true })
      this.namedCancellations.set(agent.id, abortChild)
      parent?.signal.addEventListener('abort', abortChild, { once: true })
      try {
        const run = () => authority && token ? authority.runWriter(token, execute) : execute()
        const execution = parent?.authority && parent.token && !parent.alreadyDelegated ? parent.authority.delegate(parent.token, run) : run()
        const settling = (async () => {
          const settled = await execution
          if (policy.workspace === 'isolated' && settled.episode.state === 'completed') {
            if (authority && ownsLease) await authority.drain()
            if (lease && ownsLease) { releaseExecutionLeaseHandle(lease); lease = undefined; ownsLease = false }
            try {
              const heldRoot = parent?.authority?.lease.threadDir === directory ? parent.authority.lease : undefined
              await this.withNamedRetirement(threadId, workspaceRoot, heldRoot, (retirement) => {
                retirement.prepare({ taskId: threadId, worktreePath: workspaceRoot, branch, sourcePath: store.path, baseSha: base, resultSha: settled.episode.result?.resultSha })
                retirement.retire(retirement.pathFor(threadId, workspaceRoot))
              })
            } catch (error) { this.emit('agent-output', { agentId: agent.id, threadId, data: `Workspace retained: ${error instanceof Error ? error.message : String(error)}` }) }
          }
          this.mousseAgents.remove(agent.id)
          if (authority && ownsLease) await authority.drain()
          if (lease && ownsLease) { releaseExecutionLeaseHandle(lease); lease = undefined; ownsLease = false }
          return settled
        })()
        this.namedSettlements.set(agent.id, settling)
        try { return await settling } finally { if (this.namedSettlements.get(agent.id) === settling) this.namedSettlements.delete(agent.id) }
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        parent?.signal.removeEventListener('abort', abortChild)
        token?.signal.removeEventListener('abort', abortNative)
        if (this.namedCancellations.get(agent.id) === abortChild) this.namedCancellations.delete(agent.id)
      }
    } catch (error) {
      if (episode && !['completed', 'failed', 'interrupted'].includes(store.read().episodes.find((entry) => entry.id === episode!.id)?.state ?? '')) {
        store.complete(episode.id, episode.contextGeneration, { reason: error instanceof Error ? error.message : String(error) }, 'interrupted')
        owner.agents.updateStatus(episode.agentId, 'interrupted')
      }
      throw error
    } finally {
      try { if (authority && ownsLease) await authority.drain() }
      finally { if (lease && ownsLease) releaseExecutionLeaseHandle(lease) }
    }
  }

  private async withNamedRetirement<T>(threadId: string, repositoryPath: string, held: ThreadLeaseHandle | undefined,
    work: (service: WorktreeRetirementService) => T): Promise<T> {
    const directory = this.resolveThreadDir(threadId)!
    const taskLease = held ?? await waitAcquireExecutionLease(directory, { source: 'named-workspace-lifecycle', signal: this.lifecycle.signal })
    try {
      const repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repositoryPath, { requireMutationCapability: true }), { signal: this.lifecycle.signal })
      try { return work(new WorktreeRetirementService(this.threadStore!.lifecycleStore, { taskLease, repositoryLease })) }
      finally { repositoryLease.release() }
    } finally { if (!held) releaseExecutionLeaseHandle(taskLease) }
  }

  async integrateNamedAgent(threadId: string, input: { agent: string; episodeId: string; operationId: string; expectedResultSha: string; expectedDestinationSha: string }, parent?: NamedDelegationParent) {
    return this.lifecycle.run('named-integration', async () => {
      const directory = this.resolveThreadDir(threadId)
      if (!directory || !this.threadStore?.getThread(threadId)) throw new Error('Task unavailable')
      const store = new AgentEpisodeStore(directory), agent = store.resolve(input.agent)
      const episode = store.read().episodes.find((entry) => entry.id === input.episodeId && entry.agentId === agent?.id)
      if (!agent || !episode || agent.activeEpisodeId || episode.policy.workspace !== 'isolated' || episode.policy.access !== 'write' || !['completed', 'failed', 'interrupted'].includes(episode.state) || !episode.result?.resultSha || episode.result.resultSha !== input.expectedResultSha) throw new Error('Only a settled pinned isolated write result can integrate')
      const prior = store.read().integrations?.find((entry) => entry.episodeId === episode.id)
      if (prior && prior.operationId !== input.operationId) throw new Error('Episode is already integrated')
      if (parent && parent.binding.workspaceRoot !== new ThreadWorkspaceManager(directory).load()?.worktreePath) throw new Error('Only the task owner can integrate an isolated result')
      const held = parent?.authority?.lease
      const lease = held ?? await waitAcquireExecutionLease(directory, { source: 'named-integration', signal: this.lifecycle.signal })
      try {
        const manager = new ThreadWorkspaceManager(directory)
        const project = resolveThreadProjectPath(this.projectManager!, this.threadStore, threadId)!
        if (!existsSync(manager.load()!.worktreePath)) await manager.restore(project, this.lifecycle.signal, lease)
        const metadata = manager.load()!
        if (!existsSync(episode.binding.worktreePath)) await this.withNamedRetirement(threadId, metadata.worktreePath, lease,
          (retirement) => retirement.reconstruct(retirement.pathFor(threadId, episode.binding.worktreePath)))
        const result = await new ChildAgentIntegrationService(directory).integrate({
          agentId: agent.id, retainedResultId: `${episode.id}/result`, operationId: input.operationId, actor: { kind: 'agent', id: agent.id },
          workerWorktree: episode.binding.worktreePath, workerBranch: episode.binding.branch!, spawnBaseSha: episode.binding.integrationBaseSha ?? episode.binding.baseSha!,
          expectedWorkerHead: input.expectedResultSha, expectedDestinationHead: input.expectedDestinationSha,
          threadWorkspace: metadata.worktreePath, heldThreadLease: lease, signal: this.lifecycle.signal,
          externalEffects: [{ kind: 'unknown', reversible: false, description: 'Native isolated episode may have performed external effects; integration reverses repository changes only.' }]
        })
        store.recordIntegration({ episodeId: episode.id, operationId: input.operationId, receiptId: result.receiptId!, integrationSha: result.integrationSha, resultSha: input.expectedResultSha })
        try {
          await this.withNamedRetirement(threadId, metadata.worktreePath, lease, (retirement) => {
            retirement.prepare({ taskId: threadId, worktreePath: episode.binding.worktreePath, branch: episode.binding.branch!, sourcePath: store.path, baseSha: episode.binding.baseSha, resultSha: episode.result!.resultSha })
            retirement.retire(retirement.pathFor(threadId, episode.binding.worktreePath))
          })
        } catch (error) { this.emit('agent-output', { agentId: agent.id, threadId, data: `Integrated workspace retained: ${error instanceof Error ? error.message : String(error)}` }) }
        return result
      } finally { if (!held) releaseExecutionLeaseHandle(lease) }
    })
  }

  private namedDelegation(threadId: string, parent: NamedDelegationParent): import('./LlmClient').LlmChatOptions['delegation'] {
    return {
      create: (request) => this.runNamedAgent(threadId, { name: request.name, task: request.task, operationId: uuidv4(),
        policy: { version: 1, workspace: request.workspace, access: request.access } }, undefined, parent),
      createBatch: async (requests) => {
        if (!requests.length || requests.length > 8 || requests.some((request) => request.workspace !== 'isolated')) throw new Error('Parallel named assignments require 1–8 explicitly isolated workspaces')
        if (actionGit(parent.binding.workspaceRoot, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Checkpoint parent changes before launching a parallel isolated batch')
        const run = () => Promise.allSettled(requests.map((request) => this.runNamedAgent(threadId, { name: request.name, task: request.task, operationId: uuidv4(),
          policy: { version: 1, workspace: request.workspace, access: request.access } }, undefined, { ...parent, alreadyDelegated: true })))
        return parent.authority && parent.token ? parent.authority.delegate(parent.token, run) : run()
      },
      integrate: (request) => this.integrateNamedAgent(threadId, { ...request, operationId: uuidv4() }, parent),
      recall: (request) => this.runNamedAgent(threadId, { name: request.agent, task: request.task, operationId: uuidv4(),
        expectedAgentGeneration: request.expectedAgentGeneration, contextMode: request.contextMode, resumeResult: request.resumeResult,
        policy: { version: 1, workspace: request.workspace, access: request.access } }, undefined, parent),
      list: () => this.listNamedAgents(threadId)
    }
  }

  async spawnAgentsForThread(threadId: string, specs: SubagentAssignment[]): Promise<string[]> {
    const session = this.getOrCreateSession(threadId)
    return this.sessionAls.run(session, () => this.spawnAgents(specs))
  }

  async spawnAgents(specs: SubagentAssignment[]): Promise<string[]> {
    return this.lifecycle.run('spawn', () => this.withTaskWriter(this.session, () => this.spawnAgentsOwned(specs)))
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

  private async spawnAgentsOwned(specs: SubagentAssignment[]): Promise<string[]> {
    const ownerSession = this.session
    // WorktreeManager is process-scoped and its fallback root can reflect the daemon's
    // launch directory (notably the packaged app install directory on Windows).  A spawn,
    // however, belongs to one thread, so always prefer that thread's resolved project cwd.
    // Keeping this value local also avoids another thread changing the manager root while
    // this asynchronous batch is being created.
    const repositoryPath = ownerSession.workspace!.workspacePath
    const spawnBaseSha = await this.snapshotOwnedParent(ownerSession, 'child-base')
    const logs: string[] = []
    const batch = new Set<string>()
    // Dedupe identical assignments within a single spawn request.
    const seen = new Set<string>()
    const uniqueSpecs = specs.filter((spec) => {
      const taskKey = typeof spec.task === 'string' ? spec.task.trim() : String(spec.task)
      const key = [spec.cliType, taskKey, spec.provider, spec.model, spec.effort].join('::')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Reserve every requested agent before starting network-backed discovery. Discovery is
    // deliberately sequential, so creating records inside that loop made a multi-agent batch
    // invisible (or only partially visible) for minutes. Persisting placeholders first also
    // leaves an honest failed record when connectivity drops during discovery.
    const reservations = new Map<SubagentAssignment, { agentId: string; taskId: string }>()
    for (const spec of uniqueSpecs) {
      const taskText = typeof spec.task === 'string' && spec.task.trim()
        ? spec.task
        : `Invalid ${spec.cliType} assignment`
      const task = this.tasks.create(taskText)
      this.tasks.updateStatus(task.id, 'in_progress')
      const agentId = uuidv4()
      const executionMode = spec.cliType === 'mousse'
        ? 'gui'
        : this.macros.isHeadlessEnabled(spec.cliType) ? 'headless' : 'interactive'
      const agent = this.agents.create({
        cliType: spec.cliType,
        worktreePath: '',
        branch: '',
        repositoryRoot: repositoryPath,
        declaredFiles: [],
        includedFiles: [],
        executionMode,
        status: 'starting',
        startupPhase: 'discovery',
        task: spec.task
      }, agentId)
      this.tasks.linkAgent(task.id, agent.id)
      this.agentOwners.set(agent.id, ownerSession)
      reservations.set(spec, { agentId, taskId: task.id })
      batch.add(agent.id)
      this.emit('agent-spawned', { agent, threadId: ownerSession.threadId })
    }

    for (const spec of uniqueSpecs) {
      const reservation = reservations.get(spec)!
      const failReservation = (stage: string, message: string): void => {
        this.agents.updateStatus(reservation.agentId, 'failed')
        this.tasks.updateStatus(reservation.taskId, 'failed')
        logs.push(
          `[spawn-failure agent=${reservation.agentId} task=${reservation.taskId} stage=${stage}] ${message}`
        )
      }
      const validationError = validateSubagentAssignment(spec)
      if (validationError) {
        failReservation('validation', `${spec.cliType}: ${validationError}`)
        continue
      }
      if (!this.macros.listProviders().includes(spec.cliType)) {
        failReservation('provider', `${spec.cliType}: disabled or unavailable`)
        continue
      }
      const mousseDefaults = this.settingsStore.get().agents
      const defaultProvider = mousseDefaults.llmProvider.mousse
      const defaultModel = mousseDefaults.model.mousse
      const useMousseDefault =
        spec.cliType === 'mousse' && !spec.provider && !spec.model && defaultProvider && defaultModel
      const selectedMousseModel = spec.model ?? (useMousseDefault ? defaultModel : undefined)
      const parsedMousseModel = selectedMousseModel
        ? parseThinkingSuffixFromModelId(selectedMousseModel)
        : undefined
      // Settings encode effort as a model-id suffix. Normalize it into the explicit launch
      // option so the durable subagent session and provider request retain the configured effort.
      const mousseLaunch = {
        provider: spec.provider ?? (useMousseDefault ? defaultProvider : undefined),
        model: parsedMousseModel?.baseId,
        effort: spec.effort ?? parsedMousseModel?.effort
      }
      if (
        spec.cliType === 'mousse' &&
        (mousseLaunch.provider || mousseLaunch.model || mousseLaunch.effort)
      ) {
        try {
          this.llm.validateSubagentLaunch({
            llmProvider: mousseLaunch.provider,
            model: mousseLaunch.model,
            effort: mousseLaunch.effort
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          failReservation('launch-validation', `mousse: ${message}`)
          continue
        }
      }

      let declaredFiles: string[] = []
      let declarationRationale = ''
      try {
        await this.llm.chat(
          [userMessage(`Read the repository and identify the exact tracked files you need to edit for this delegated task:\n\n${spec.task}`)],
          undefined,
          {
            mode: 'agent',
            ...(spec.cliType === 'mousse' ? {
              llmProvider: mousseLaunch.provider,
              model: mousseLaunch.model,
              effort: mousseLaunch.effort
            } : {}),
            projectPath: repositoryPath,
            threadId: `${ownerSession.threadId}:discovery`,
            subagentDiscovery: {
              onDeclareFiles: (files, rationale) => {
                declaredFiles = files
                declarationRationale = rationale ?? ''
              }
            }
          }
        )
        if (declaredFiles.length === 0) {
          throw new Error('Discovery subagent finished without calling declare_files.')
        }
        logs.push(`[discovery] Declared ${declaredFiles.length} edit file(s)${declarationRationale ? `: ${declarationRationale}` : ''}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failReservation('discovery', `${spec.cliType}: ${message}`)
        continue
      }
      // A user can stop the visible placeholder while discovery is in flight. Do not
      // resurrect it by allocating a worktree after the discovery request returns.
      if (this.agents.get(reservation.agentId)?.status !== 'starting') continue
      const task = this.tasks.get(reservation.taskId)!
      const agentId = reservation.agentId
      let worktreePath = ''
      let branch = ''
      let includedFiles: string[] = []

      this.agents.update(agentId, { declaredFiles, startupPhase: 'worktree' })

      try {
        const referencedInputs = extractAssignmentInputFilePaths(spec.task)
        const worktreeFiles = [...new Set([...declaredFiles, ...referencedInputs])]
        const wt = await withGitMutationLocks(this.resolveThreadDir(ownerSession.threadId)!, repositoryPath, 'child-worktree',
          () => this.worktrees.createSelectiveWorktree(agentId, worktreeFiles, repositoryPath, spawnBaseSha),
          this.lifecycle.signal, ownerSession.executionLease ?? undefined)
        worktreePath = wt.path
        branch = wt.branch
        includedFiles = wt.selection.includedFiles
        logs.push(`[worktree] Created sparse ${worktreePath} on branch ${branch} with ${includedFiles.length} blast-radius file(s)`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failReservation('worktree', `${spec.cliType}: ${msg}`)
        continue
      }

      this.agents.update(agentId, {
        worktreePath,
        branch,
        includedFiles,
        startupPhase: 'launching'
      })

      const progressPath = taskProgressPath(worktreePath)
      const assignmentTask = spec.task + taskProgressInstructions(progressPath)
      const prep = this.agentConfigManager
        ? await this.agentConfigManager.prepare(agentId, spec.cliType, worktreePath, repositoryPath)
        : undefined
      prep?.logs.forEach((line) => logs.push(line))
      prep?.warnings.forEach((line) => logs.push(`[integrations] ${line}`))

      if (spec.cliType === 'mousse') {
        this.agents.update(agentId, { startupPhase: undefined })
        const agent = this.agents.updateStatus(agentId, 'running')!

        this.tasks.updateStatus(task.id, 'in_progress')
        this.liveGuiAgents.add(agent.id)
        {
          const spawnSession = ownerSession
          const aid = agent.id
          this.progressMonitor.start(aid, worktreePath, (update) => {
            this.sessionAls.run(spawnSession, () => this.handleAgentProgress(aid, update))
          })
          this.mousseAgents.start(aid, assignmentTask, worktreePath, mousseLaunch)
          this.emit('agent-spawned', { agent, threadId: spawnSession.threadId })
          this.emit('agent-activated', { agentId: aid, threadId: spawnSession.threadId })
        }
        logs.push(`[agent] Spawned Mousse GUI agent ${agent.id.slice(0, 8)}`)
        continue
      }

      const useHeadless = this.macros.isHeadlessEnabled(spec.cliType)

      if (useHeadless) {
        const shellCommand = this.macros.getHeadlessShellCommand(spec.cliType, assignmentTask)
        const processId = this.headlessRunner.spawn(agentId, worktreePath, shellCommand, {
          env: prep?.env
        })

        this.agents.update(agentId, { processId })
        this.agents.update(agentId, { startupPhase: undefined })
        const agent = this.agents.updateStatus(agentId, 'running')!

        this.tasks.updateStatus(task.id, 'in_progress')
        {
          const spawnSession = ownerSession
          const aid = agent.id
          this.progressMonitor.start(aid, worktreePath, (update) => {
            this.sessionAls.run(spawnSession, () => this.handleAgentProgress(aid, update))
          })
          this.emit('agent-spawned', { agent, threadId: spawnSession.threadId })
        }
        logs.push(`[agent] Spawned headless ${spec.cliType} agent ${agent.id.slice(0, 8)}`)
        continue
      }

      const cliCommand = this.macros.getCliCommand(spec.cliType)
      const ptyId = this.ptyManager.create(agentId, worktreePath, cliCommand, { env: prep?.env })

      const agent = this.agents.update(agentId, { ptyId })!

      this.tasks.updateStatus(task.id, 'in_progress')

      // Capture session for deferred callbacks — ALS is lost across setTimeout/progress ticks.
      const spawnSession = ownerSession
      const agentRefId = agent.id
      const taskRefId = task.id
      const ptyRefId = agent.ptyId!

      this.progressMonitor.start(agentRefId, worktreePath, (update) => {
        this.sessionAls.run(spawnSession, () => this.handleAgentProgress(agentRefId, update))
      })

      this.emit('agent-spawned', {
        agent,
        threadId: spawnSession.threadId
      })

      setTimeout(() => {
        if (this.lifecycle.stopping) return
        void this.lifecycle.run('agent-bootstrap', () => this.sessionAls.run(spawnSession, async () => {
          const agents = spawnSession.agents
          const tasks = spawnSession.tasks
          try {
            // The agent may have been stopped during the launch delay. Never let this
            // deferred callback resurrect a cancelled/terminal agent as running.
            const currentAgent = agents.get(agentRefId)
            if (!currentAgent || currentAgent.status !== 'starting') return

            if (!this.ptyManager.has(ptyRefId)) {
              logs.push(
                `[terminal] Cannot prompt ${agentRefId.slice(0, 8)}: terminal is not available`
              )
              agents.updateStatus(agentRefId, 'failed')
              tasks.updateStatus(taskRefId, 'failed')
              return
            }

            agents.updateStatus(agentRefId, 'running')
            agents.update(agentRefId, { startupPhase: undefined })
            this.ptyManager.focusWindow()
            this.emit('terminal-activated', {
              ptyId: ptyRefId,
              threadId: spawnSession.threadId
            })
            this.emit('agent-activated', {
              agentId: agentRefId,
              threadId: spawnSession.threadId
            })

            const macroResult = await this.macros.runPtyMacro(
              spec.cliType,
              {
                prompt: assignmentTask
              },
              (data) => this.ptyManager.write(ptyRefId, data)
            )
            macroResult.log.forEach((l) => logs.push(l))
            if (!macroResult.success) {
              agents.updateStatus(agentRefId, 'failed')
              tasks.updateStatus(taskRefId, 'failed')
            }
          } catch (err) {
            logs.push(
              `[agent] Interactive start failed for ${agentRefId.slice(0, 8)}: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            agents.updateStatus(agentRefId, 'failed')
            tasks.updateStatus(taskRefId, 'failed')
          }
        })).catch((error) => this.emit('queue-drain-failed', { threadId: spawnSession.threadId, error: error instanceof Error ? error.message : String(error) }))
      }, 2000)

      logs.push(`[agent] Spawned ${spec.cliType} agent ${agent.id.slice(0, 8)}`)
    }

    if (batch.size > 0) {
      this.delegationBatches.add(batch)
      this.delegationBatchOwners.set(batch, ownerSession)
      this.checkDelegationBatches()
    }
    return logs
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
      this.checkDelegationBatches()
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
    const owner = this.agentOwners.get(agent.id) ?? this.session
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

  private async finalizeAgent(agent: Agent, merge: boolean): Promise<string[]> {
    const logs: string[] = []
    if (agent.namedIdentityId) {
      if (merge) throw new Error('Named episode results require explicit revision-specific integration; shared and read-only episodes cannot be merged')
      this.namedCancellations.get(agent.id)?.()
      const stopped = await this.mousseAgents.abortAndWait(agent.id)
      if (!stopped) throw new Error('Named episode still owns active callbacks; cancellation is not drained')
      await this.namedSettlements.get(agent.id)
      return [`[agent] Named episode ${agent.episodeId} drained; context and result retained`]
    }

    // Enter merging before aborting writers so a programmatic abort during finalize
    // is not mis-reported as a user interrupt on a still-ready agent.
    this.progressMonitor.stop(agent.id)
    this.liveGuiAgents.delete(agent.id)
    this.agents.updateStatus(agent.id, 'merging')
    const task = this.tasks.findByAgentId(agent.id)

    // Stop all writers before cleanup or Git operations. Previously GUI work could keep
    // running while its worktree was cleaned/merged, creating a destructive race.
    if (agent.executionMode === 'headless' && agent.processId) {
      this.headlessRunner.kill(agent.processId)
      logs.push(`[headless] Stopped agent ${agent.id.slice(0, 8)}`)
    } else if (agent.executionMode === 'gui') {
      const stopped = await this.mousseAgents.abortAndWait(agent.id)
      if (!stopped) {
        logs.push(
          `[mousse] Refused to finalize ${agent.id.slice(0, 8)} because its active turn did not stop.`
        )
        // Leave the agent in merging so the user can retry; do not pretend it is ready.
        return logs
      }
      logs.push(`[mousse] Stopped agent ${agent.id.slice(0, 8)}`)
    } else if (agent.ptyId) {
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

    if (agent.executionMode === 'gui') {
      const finalStatus = this.agents.get(agent.id)?.status
      // A failed merge leaves the agent ready for retry, so its durable transcript must
      // remain available in the still-open tab. Removing it here produced a blank agent
      // view and also discarded the only persisted GUI-session history.
      if (finalStatus === 'completed' || finalStatus === 'cancelled') {
        this.mousseAgents.remove(agent.id)
        // Session removal can trigger a final renderer refresh that observes no messages.
        // Re-emit the terminal registry state afterwards so a stale GUI tab cannot remain.
        this.agents.updateStatus(agent.id, finalStatus)
        logs.push(`[mousse] Closed GUI agent ${agent.id.slice(0, 8)}`)
      }
    }
    this.checkDelegationBatches()
    return logs
  }

  getMousseAgentMessages(agentId: string): ChatMessage[] {
    const messages = this.mousseAgents.getMessages(agentId)
    return messages.length ? messages : this.namedContextForAgent(agentId)?.messages ?? []
  }

  getMousseAgentAssignment(agentId: string): MousseAgentAssignment | undefined {
    return this.mousseAgents.getAssignment(agentId) ?? this.namedContextForAgent(agentId)?.assignment
  }

  private namedContextForAgent(agentId: string): MousseAgentSessionSnapshot | undefined {
    const owner = this.agentOwners.get(agentId)
    const directory = owner ? this.resolveThreadDir(owner.threadId) : undefined
    return directory && new AgentEpisodeStore(directory).resolve(agentId) ? new AgentEpisodeStore(directory).context(agentId) : undefined
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

  async getMousseAgentContextUsage(agentId: string, draftInput = '') {
    return await this.mousseAgents.getContextUsage(agentId, draftInput)
  }

  abortMousseAgent(agentId: string): boolean {
    this.namedCancellations.get(agentId)?.()
    return this.mousseAgents.abort(agentId)
  }

  exportMousseAgentSessions(threadId?: string): MousseAgentSessionSnapshot[] {
    const snapshots = this.mousseAgents.exportSessions()
    if (!threadId) return snapshots
    const ids = new Set(this.getAgentsForThread(threadId).list().map((agent) => agent.id))
    const owned = snapshots.filter((snapshot) => ids.has(snapshot.agentId))
    const directory = this.resolveThreadDir(threadId)
    if (directory) {
      const store = new AgentEpisodeStore(directory)
      for (const identity of store.read().identities) {
        if (!ids.has(identity.id) || owned.some((snapshot) => snapshot.agentId === identity.id)) continue
        const context = store.context(identity.id)
        if (context) owned.push(context)
      }
    }
    return owned
  }

  restoreMousseAgentSessions(sessions: unknown): MousseAgentLifecycleEvent[] {
    // Managed contexts hydrate only at explicit recall; compatibility snapshots are retained on disk.
    return this.mousseAgents.restoreSessions(Array.isArray(sessions) ? sessions.filter((snapshot) => !snapshot?.managedBinding) : sessions, false)
  }

  listMousseAgentSessionIds(): string[] {
    return this.mousseAgents.listSessionIds()
  }

  hasRunningMousseAgentSessions(): boolean {
    // Thread switching only needs to block for an actual in-process model turn. Persisted
    // lifecycle labels can briefly remain "running" after completion/restoration and must
    // not strand the user on the current thread.
    return this.mousseAgents
      .listSessionIds()
      .some((agentId) => this.mousseAgents.isTurnActive(agentId))
  }

  setMousseAgentPersistCallback(fn: (immediate?: boolean) => void): void {
    this.mousseAgents.setPersistCallback(fn)
  }

  async sendMousseAgentMessage(
    agentId: string,
    content: string,
    images?: ChatImageAttachment[]
  ): Promise<MousseAgentSendResult> {
    this.lifecycle.assertAccepting()
    if ((this.agentOwners.get(agentId) ?? this.session).agents.get(agentId)?.namedIdentityId) throw namedContextErrors.create('agent_recall_required')
    if (!this.prepareGuiAgentResume(agentId)) return { accepted: false, reason: 'missing' }
    return this.mousseAgents.send(agentId, content, images)
  }

  retryMousseAgent(agentId: string): void {
    this.lifecycle.assertAccepting()
    if ((this.agentOwners.get(agentId) ?? this.session).agents.get(agentId)?.namedIdentityId) throw namedContextErrors.create('agent_recall_required')
    if (!this.prepareGuiAgentResume(agentId)) return
    this.mousseAgents.retry(agentId)
  }

  private prepareGuiAgentResume(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent || this.mousseAgents.getRunState(agentId) === undefined) return false
    if (
      agent.executionMode !== 'gui' ||
      (agent.status !== 'failed' && agent.status !== 'interrupted')
    ) {
      return true
    }
    this.agents.updateStatus(agentId, 'running')
    const task = this.tasks.findByAgentId(agentId)
    if (task) {
      this.tasks.updateStatus(task.id, 'in_progress')
      this.tasks.updateProgress(task.id, {
        message: 'Resuming from the last durable Mousse checkpoint.'
      })
    }
    this.liveGuiAgents.add(agentId)
    const ownerSession = this.session
    this.progressMonitor.start(agentId, agent.worktreePath, (update) =>
      this.sessionAls.run(ownerSession, () => this.handleAgentProgress(agentId, update))
    )
    return true
  }

  private validateAndMarkAgentReady(
    agentId: string,
    update: AgentProgressUpdate
  ): Promise<void> {
    if (this.lifecycle.stopping) return Promise.resolve()
    const existing = this.readinessChecks.get(agentId)
    if (existing) return existing
    const ownerSession = this.session

    const check = this.lifecycle.run('readiness', async () => {
      const agent = this.agents.get(agentId)
      const task = this.tasks.findByAgentId(agentId)
      if (!agent || !task || isTerminalAgentStatus(agent.status)) return

      const verificationOnly = /\bverification[- ]only\b/i.test(agent.task)
      const worktreeInfo = {
        path: agent.worktreePath,
        branch: agent.branch,
        repositoryRoot: agent.repositoryRoot
      }
      let inspected = await this.worktrees.validateAgentReadiness(worktreeInfo)

      // Agents often flip task-progress to completed a few seconds before `git commit`
      // returns. Give a short grace window so an in-flight commit can land.
      if (!inspected.ready && isUncommittedReadinessFailure(inspected.reason)) {
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const latest = this.agents.get(agentId)
          if (!latest || isTerminalAgentStatus(latest.status) || latest.status === 'merging') return
          inspected = await this.worktrees.validateAgentReadiness(worktreeInfo)
          if (inspected.ready || !isUncommittedReadinessFailure(inspected.reason)) break
        }
      }

      // Check ownership even while dirty. Otherwise the first retry tells the worker to
      // commit every temporary artifact, and only the subsequent validation discovers
      // those committed files were outside its declaration.
      if (inspected.changedFiles?.length && agent.declaredFiles?.length) {
        const unauthorized = filesOutsideDeclaration(inspected.changedFiles ?? [], agent.declaredFiles)
        if (unauthorized.length > 0) {
          inspected = {
            ready: false,
            reason: `Agent changed files outside its discovery declaration: ${unauthorized.join(', ')}. Declared edit files: ${agent.declaredFiles.join(', ')}.`,
            changedFiles: inspected.changedFiles
          }
        }
      }

      const readiness = {
        success: inspected.ready,
        error: inspected.reason,
        commit: inspected.ready ? inspected.commit : undefined,
        diffFiles: inspected.changedFiles
      }
      // Re-read state after awaiting Git: cancellation/failure may have won the race.
      const current = this.agents.get(agentId)
      if (!current || isTerminalAgentStatus(current.status) || current.status === 'merging') return

      const correctionAttempt = this.noDiffCorrectionAttempts.get(agentId) ?? 0
      if (
        current.executionMode === 'gui' &&
        isRecoverableReadinessFailure(readiness.error, verificationOnly, correctionAttempt)
      ) {
        this.noDiffCorrectionAttempts.set(agentId, correctionAttempt + 1)
        const uncommitted = isUncommittedReadinessFailure(readiness.error)
        const outsideDeclaration = isOutsideDeclarationReadinessFailure(readiness.error)
        this.tasks.updateProgress(task.id, {
          progress: 95,
          message: outsideDeclaration
            ? 'Completion included undeclared files; asking the worker to remove them once.'
            : uncommitted
            ? 'Completion left uncommitted changes; asking the worker to commit once.'
            : 'Completion had no implementation diff; asking the worker to re-check its assignment once.'
        })
        this.addSystemMessage(
          outsideDeclaration
            ? `[Agent ${agentId.slice(0, 8)} correction] Completion included files outside its declaration; requesting one bounded cleanup retry.`
            : uncommitted
            ? `[Agent ${agentId.slice(0, 8)} correction] Completion left uncommitted changes; requesting one bounded commit retry.`
            : `[Agent ${agentId.slice(0, 8)} correction] Completion had no implementation diff; requesting one bounded retry.`
        )
        const becameIdle = await this.mousseAgents.waitForIdle(agentId, 30_000)
        if (becameIdle) {
          this.progressMonitor.start(agentId, agent.worktreePath, (nextUpdate) => {
            this.sessionAls.run(ownerSession, () => this.handleAgentProgress(agentId, nextUpdate))
          })
          const correction = outsideDeclaration
            ? [
                '[Mousse readiness correction]',
                `Your completion was rejected because these paths are outside your edit declaration: ${filesOutsideDeclaration(readiness.diffFiles ?? [], current.declaredFiles ?? []).join(', ')}.`,
                `The only files you may leave changed are: ${(current.declaredFiles ?? []).join(', ')}.`,
                'Remove generated analysis artifacts and restore undeclared tracked files (including ignore files) to their original state. If they were already committed, repair the branch with a new commit; do not rewrite or delete the declared deliverable.',
                'Verify the final branch diff contains only declared files and `git status` is clean, then update the monitored progress file to status "completed".',
                `Original assignment: ${agent.task}`
              ].join('\n')
            : uncommitted
            ? [
                '[Mousse readiness correction]',
                'Your completion was rejected because the worktree still had uncommitted changes.',
                'Stage and commit all intended implementation files now (exact required commit message if the task specified one).',
                'Do not mark task-progress completed again until `git status` is clean and the commit exists.',
                'Then update the monitored progress file to status "completed".',
                `Original assignment: ${agent.task}`
              ].join('\n')
            : [
                '[Mousse readiness correction]',
                'Your completion was rejected because your branch contains no implementation diff.',
                `Re-read and complete the original assignment: ${agent.task}`,
                'Do not claim an unrelated pre-existing commit. Implement and test the requested change, then commit it and update the monitored progress file.',
                'If the requested implementation truly already exists, write status "failed" with concrete evidence instead of claiming completion.'
              ].join('\n')
          setTimeout(() => {
            if (this.lifecycle.stopping) return
            this.sessionAls.run(ownerSession, () => {
              void this.mousseAgents.send(agentId, correction).catch((error) => this.emit('queue-drain-failed', { threadId: ownerSession.threadId, error: error instanceof Error ? error.message : String(error) }))
            })
          }, 0)
          return
        }
      }

      this.progressMonitor.stop(agentId)
      this.liveGuiAgents.delete(agentId)
      this.noDiffCorrectionAttempts.delete(agentId)
      if (!readiness.success || !readiness.commit) {
        const reason = readiness.error || 'Agent branch failed readiness validation.'
        this.agents.updateStatus(agentId, 'failed')
        this.tasks.updateProgress(task.id, { message: reason })
        this.tasks.updateStatus(task.id, 'failed')
        this.addSystemMessage(`[Agent ${agentId.slice(0, 8)} failed] ${reason}`)
      } else {
        this.agents.updateStatus(agentId, 'ready')
        this.tasks.updateProgress(task.id, { progress: 100, summary: update.summary })
        this.tasks.updateStatus(task.id, 'completed')
        this.addSystemMessage(
          `[Agent ${agentId.slice(0, 8)} ready for merge] ${update.summary || update.message || agent.task}`
        )
      }
      this.checkDelegationBatches()
    }).finally(() => {
      this.readinessChecks.delete(agentId)
    })
    this.readinessChecks.set(agentId, check)
    return check
  }

  private async completeMousseAgent(
    agentId: string,
    _merge: boolean,
    summary: string
  ): Promise<void> {
    // GUI actions and progress-file updates share one serialized readiness gate.
    await this.validateAndMarkAgentReady(agentId, {
      status: 'completed', progress: 100, summary
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
      modelOverride?: { llmProvider: string; model: string }
      signal?: AbortSignal
      drainSteer?: () => string | undefined
      hostIngress?: ChannelWorkflowHostIngress
    }
  ): Promise<BackgroundWorkflowTurnResult> {
    return this.lifecycle.run('channel-turn', () => this.runChannelTurnOwned(threadId, content, threadStore, opts))
  }

  private async runChannelTurnOwned(
    threadId: string,
    content: string,
    threadStore: ThreadDataStore,
    opts?: {
      modelOverride?: { llmProvider: string; model: string }
      signal?: AbortSignal
      drainSteer?: () => string | undefined
      hostIngress?: ChannelWorkflowHostIngress
    }
  ): Promise<BackgroundWorkflowTurnResult> {
    const ownedTurn = !opts?.signal
    const channelTurn = ownedTurn
      ? { abort: new AbortController(), pendingSteer: [] as string[], promotedSteerIds: [] as string[] }
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
        onAdmissionHandedOff: () => { admittedSession = null }
      })
      if (workflow) {
        this.releaseSessionExecutionLease(session)
        return workflow
      }
      let wasAborted = false
      admittedSession = null
      const result = await this.runTurnOnSession(
        session,
        { content, mode: 'agent' },
        false,
        true,
        {
          admissionHeld: true,
          suppressAutoQueueDrain: true,
          externalSignal: signal,
          externalDrainSteer: opts?.drainSteer ?? (channelTurn
            ? () => {
                if (channelTurn.pendingSteer.length === 0) return undefined
                const steer = channelTurn.pendingSteer.join('\n')
                channelTurn.pendingSteer = []
                return steer
              }
            : undefined),
          modelOverride: opts?.modelOverride,
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
        { suppressAutoQueueDrain: true, externalSignal: input.signal, admissionHeld: input.admissionHeld }
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

/** Select the repository owned by the spawning thread, never the daemon cwd when known. */
export function resolveSpawnRepositoryPath(
  threadProjectCwd: string | null | undefined,
  managerFallbackRoot: string
): string {
  return threadProjectCwd ?? managerFallbackRoot
}

export function filesOutsideDeclaration(changedFiles: string[], declaredFiles: string[]): string[] {
  const allowed = new Set(declaredFiles.map((file) => file.replace(/\\/g, '/')))
  return changedFiles.filter((file) => !allowed.has(file.replace(/\\/g, '/')))
}
