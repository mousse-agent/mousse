import { AsyncLocalStorage } from 'async_hooks'
import { EventEmitter } from 'events'
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
  type MousseAgentSessionSnapshot,
  type NativeLlmContext,
  type OrchestratorAction,
  type OrchestratorContextUsageInput,
  type OrchestratorResponse,
  type OrchestratorSendInput,
  type QueuedMessage,
  type SubagentAssignment
} from '../../shared/types'
import { EFFORT_SUFFIXES, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import { isDefaultThreadName } from '../../shared/threadTitle'
import { allowsOrchestrationActions, getChatModeLabel, normalizeChatMode } from '../../shared/chatMode'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import {
  TaskProgressMonitor,
  taskProgressInstructions,
  taskProgressPath,
  type AgentProgressUpdate
} from '../tasks/TaskProgressMonitor'
import { WorktreeManager } from '../worktree/WorktreeManager'
import { PtyManager } from '../terminals/PtyManager'
import { HeadlessAgentRunner } from '../terminals/HeadlessAgentRunner'
import { MacroEngine } from '../macros/MacroEngine'
import { LlmClient, parseActions, stripActionBlocks, type StreamingLlmThinkingEvent, type StreamingLlmToolEvent, filterActionsForChatMode, rejectOrchestrationAction } from './LlmClient'
import { computeContextUsage } from './contextUsage'
import { getToolCallDisplay } from '../../shared/toolCallDisplay'
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
import {
  MousseAgentService,
  type MousseAgentLifecycleEvent
} from '../agents/MousseAgentService'
import { ConnectionRetriesExhaustedError, retryConnectionFailures } from './connectionRetry'
import {
  compactMessagesAtSafeBoundary,
  compactNativeContext,
  createNativeContext,
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  estimateActiveContextTokens,
  getActiveMessages,
  migrateLegacyContext,
  shouldCompactNativeContext,
  userMessage
} from './nativeContext'

interface NormalizedOrchestratorSendRequest {
  content: string
  mode: ChatMode
  images?: ChatImageAttachment[]
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
    mode: normalizeChatMode(request.mode),
    images: request.images?.filter((img) => img.data && img.mimeType)
  }
}

/**
 * Whether complete_task / stopAgent should attempt to finalize this agent.
 * failed is never auto-finalized. completed/cancelled/interrupted only when a
 * mergeable branch still exists (recoverable work).
 */
export function isActionFailureLog(line: string): boolean {
  return /\b(?:failed|skipped|error|conflict|refused|not found|not eligible)\b/i.test(line)
}

export function buildSpawnAgentsFailureWake(logs: string[]): string | undefined {
  const failures = logs.filter(isActionFailureLog)
  if (failures.length === 0) return undefined
  return [
    '[Automatic spawn_agents update] One or more delegated tasks were not started.',
    ...failures,
    'Wake the originating main agent now. Inspect and correct the orchestration/thread binding failure before retrying; do not blindly emit the identical spawn action again.'
  ].join('\n')
}

export function isRecoverableNoDiffReadinessFailure(
  error: string | undefined,
  verificationOnly: boolean,
  attempt: number
): boolean {
  return !verificationOnly && attempt < 1 && error === 'Ready commit contains no implementation diff.'
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

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /context(?:_|\s|-)*(?:length|window|limit)|too many tokens|maximum context/i.test(message)
}

export async function retryContextOverflowOnce<T>(
  run: () => Promise<T>,
  compact: () => boolean
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isContextOverflowError(error) || !compact()) throw error
    return run()
  }
}

export class OrchestratorService extends EventEmitter {
  private llm: LlmClient
  /** Bound GUI/CLI session (active thread). Concurrent turns use ALS-scoped sessions. */
  private boundSession = new ThreadSession('__unbound__')
  private sessions = new Map<string, ThreadSession>()
  private readonly sessionAls = new AsyncLocalStorage<ThreadSession>()
  private persistFn?: (threadId?: string | null) => void
  /** Per-thread delayed persist timers (concurrent turns must not suppress each other). */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private mousseAgents: MousseAgentService
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
    { abort: AbortController; pendingSteer: string[] }
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
    providerAuth: ProviderAuthService,
    private mcpManager?: McpManager,
    private skillsRegistry?: SkillsRegistry,
    private agentConfigManager?: AgentConfigManager,
    fileService?: FileService,
    gitService?: GitService,
    lineEditStats?: LineEditStatsStore,
    private projectManager?: ProjectManager
  ) {
    super()
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
      this.tasks
    )

    this.mousseAgents = new MousseAgentService(this.llm, {
      spawnAgents: (specs) => this.spawnAgents(specs as Array<{ cliType: CliType; task: string }>),
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
      const agent = this.agents.get(agentId)
      if (!agent || agent.executionMode !== 'headless') return
      if (isTerminalAgentStatus(agent.status) || agent.status === 'merging') {
        return
      }
      if (exitCode !== 0 && exitCode !== null) {
        this.handleAgentProgress(agentId, {
          status: 'failed',
          message: `Headless agent exited with code ${exitCode}.`
        })
      }
    })
  }

  setPersistCallback(fn: (threadId?: string | null) => void): void {
    this.persistFn = fn
  }

  /** Optional ThreadDataStore for durable queue + cross-thread persistence. */
  setThreadStore(store: ThreadDataStore | null): void {
    this.threadStore = store
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
        session.activeTurn.abort.abort()
      }
      session.queue = []
    }
    if (this.boundSession.threadId === threadId) {
      this.boundSession.deleted = true
      if (this.boundSession.activeTurn && !this.boundSession.activeTurn.abort.signal.aborted) {
        this.boundSession.activeTurn.pendingSteer = []
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

  private emitThreadMessages(threadId: string, messages: ChatMessage[]): void {
    const visible = messages.filter((message) => !message.hidden)
    this.emit('thread-messages', { threadId, messages: [...visible] })
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
      this.markThreadStartedAndNotify(threadId)
    }
    const request = normalizeSendRequest(input)
    let item: QueuedMessage
    if (this.threadStore) {
      // Cross-process RMW: load disk, enqueue, save under mutation lock.
      const next = mutateDurableQueue(this.threadStore, threadId, (diskItems) => {
        const result = enqueueMessage(diskItems, {
          threadId,
          content: request.content,
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
        removed = result.removed
        return result.items
      })
    } else {
      const result = removeQueuedMessage(session.queue, itemId)
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
   * When accepted, the item is removed from the queue and is not drained as a later turn.
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
      if (this.threadStore) {
        session.queue = mutateDurableQueue(this.threadStore, threadId, (disk) =>
          dropSteerItems(disk, [item!.id])
        )
      } else {
        session.queue = dropSteerItems(session.queue, [item!.id])
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

  generateThreadTitle(messages: ChatMessage[]): Promise<string> {
    const firstUser = messages.find((message) => message.role === 'user' && message.content.trim())
    const firstAssistant = messages.find(
      (message) => message.role === 'assistant' && !message.streaming && message.content.trim()
    )
    if (!firstUser || !firstAssistant) {
      throw new Error('A user message and first response are required to generate a title.')
    }
    return this.llm.generateTitle(firstUser.content, firstAssistant.content)
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

    try {
      const title = await this.llm.generateTitle(userContent)
      if (!title.trim()) return
      const updated = this.threadStore.updateThreadMeta(threadId, { name: title.trim() })
      this.emit('thread-title-updated', { threadId, thread: updated })
    } catch (error) {
      // Auto-titling is optional; do not turn a provider/configuration hiccup into a
      // failed user send. The promise is nevertheless awaited, so it cannot race the
      // first turn when the title provider is available.
      this.emit('thread-title-generation-failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
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

  private commitActiveNativeMessages(activeMessages: import('@earendil-works/pi-ai').Message[]): void {
    const summaryMarker = '[Compacted conversation summary]\n'
    const first = activeMessages[0]
    const inlineSummary =
      first?.role === 'user' &&
      typeof first.content === 'string' &&
      first.content.startsWith(summaryMarker)
        ? first.content.slice(summaryMarker.length)
        : null
    const existingCompaction = this.nativeContext.compaction

    // getActiveMessages synthesizes the stored summary as the first user message.
    // If the live tool loop compacts again, promote its replacement summary back into
    // NativeLlmContext metadata instead of discarding it or stacking two summaries.
    if (existingCompaction && inlineSummary !== null && inlineSummary !== existingCompaction.summary) {
      this.nativeContext.compaction = {
        ...existingCompaction,
        generation: existingCompaction.generation + 1,
        summary: inlineSummary,
        tokensBefore: estimateActiveContextTokens(getActiveMessages(this.nativeContext)),
        createdAt: Date.now()
      }
    }

    const replayed = existingCompaction && inlineSummary !== null
      ? activeMessages.slice(1)
      : activeMessages
    this.nativeContext.messages = [
      ...this.nativeContext.messages.slice(0, this.nativeContext.activeStartIndex),
      ...structuredClone(replayed)
    ]
  }

  async getContextUsage(
    input: OrchestratorContextUsageInput = '',
    threadId?: string
  ): Promise<ContextUsageSnapshot> {
    const run = async (): Promise<ContextUsageSnapshot> => {
      const request = normalizeContextUsageRequest(input)
      const modelOverride = this.session.modelOverride
      const { limit, modelName } = this.llm.getSelectedModelContextLimit(request.mode, modelOverride)
      const contextInputs = await this.llm.getContextInputs(
        request.mode,
        request.draftInput,
        modelOverride
      )
      const measurementMatches = this.lastMeasuredContextSignature === contextInputs.signature
      return computeContextUsage({
        messages: getActiveMessages(this.nativeContext),
        draftInput: request.draftInput,
        contextLimit: limit,
        modelName,
        lastMeasuredInput: measurementMatches ? this.lastMeasuredInput : null,
        lastMeasuredCacheRead: measurementMatches ? this.lastMeasuredCacheRead : null,
        lastMeasuredCacheWrite: measurementMatches ? this.lastMeasuredCacheWrite : null,
        measuredAtMessageLength: this.measuredAtHistoryLength,
        legacyEstimated: this.nativeContext.fidelity === 'legacy-estimated',
        summaryText: this.nativeContext.compaction?.summary,
        systemPromptText: contextInputs.systemPromptText,
        mcpToolsText: contextInputs.mcpToolsText,
        otherToolsText: contextInputs.otherToolsText
      })
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

  private addMessage(
    role: 'user' | 'assistant',
    content: string,
    images?: ChatImageAttachment[],
    responseMetadata?: ChatMessage['responseMetadata'],
    queueItemId?: string
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      responseMetadata,
      queueItemId: role === 'user' && queueItemId ? queueItemId : undefined
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
      const accepted = this.threadStore
        .loadThreadData(threadId)
        .messages.some((message) => message.queueItemId === queueItemId)
      return accepted ? 'accepted' : 'not_accepted'
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
    queueItemId?: string
  ): { claimAccepted: boolean } {
    const messagesBefore = this.messages.length
    const nativeBefore = this.nativeContext.messages.length
    const addedMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      queueItemId: queueItemId || undefined,
      hidden: displayUserMessage ? undefined : true
    }
    // Hidden internal inputs remain in the durable transcript for queue-claim provenance,
    // while presentation APIs and events omit them from the UI.
    this.messages.push(addedMessage)
    this.nativeContext.messages.push(userMessage(userContent, images))

    try {
      this.persist(true)
    } catch (err) {
      const status = queueItemId
        ? this.inspectDurableQueueProvenance(session.threadId, queueItemId)
        : 'not_accepted'
      if (status === 'accepted') {
        // Transcript provenance is durable — keep in-memory state; do not roll back or release.
        if (!addedMessage.hidden) this.emitMessageAdded(addedMessage)
        throw err
      }
      // Roll back speculative mutations. For unavailable provenance, do not mutate durable claim.
      this.messages.splice(messagesBefore)
      this.nativeContext.messages.splice(nativeBefore)
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
      const msg = this.addToolTimelineMessage(timelineKind, {
        title: event.title,
        summary: event.summary,
        details: event.details,
        response: event.response,
        status: 'processing'
      })
      this.activeToolCallMessageIds.set(event.callId, msg.id)
      return
    }

    if (event.phase === 'complete' && event.callId) {
      const messageId = this.activeToolCallMessageIds.get(event.callId)
      if (messageId) {
        this.updateToolTimelineMessage(messageId, {
          title: event.title,
          summary: event.summary,
          details: event.details,
          response: event.response,
          status: 'complete'
        }, true)
        this.activeToolCallMessageIds.delete(event.callId)
        return
      }
    }

    this.addToolTimelineMessage(timelineKind, {
      title: event.title,
      summary: event.summary,
      details: event.details,
      response: event.response,
      status: 'complete'
    })
  }

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
    if (!session?.activeTurn || session.activeTurn.abort.signal.aborted) {
      return false
    }
    session.activeTurn.pendingSteer = []
    session.activeTurn.abort.abort()
    if (opts?.clearQueue && id) {
      if (this.threadStore) {
        try {
          session.queue = mutateDurableQueue(this.threadStore, id, (disk) =>
            clearPendingQueue(disk)
          )
        } catch {
          session.queue = clearPendingQueue(session.queue)
        }
      } else {
        session.queue = clearPendingQueue(session.queue)
      }
      this.emitQueueUpdated(id, session.queue)
    }
    this.emit('turn-aborted', { threadId: id ?? undefined })
    return true
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
        this.addSystemMessage(`[steer] ${trimmed}`)
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
   */
  async send(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: { threadId?: string; source?: string; forceQueue?: boolean }
  ): Promise<OrchestratorResponse> {
    const threadId = opts?.threadId ?? this.getBoundThreadId()
    if (!threadId) {
      // Legacy unbound path (tests / early boot): use bound session directly.
      return this.runTurnOnSession(this.boundSession, input, reuseLastUser, opts?.source !== 'wake')
    }

    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new Error(`Thread deleted: ${threadId}`)
    }

    const externalLease =
      !session.isTurnRunning() &&
      !this.isChannelTurnActive(threadId) &&
      this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)

    if (session.isTurnRunning() || opts?.forceQueue || externalLease) {
      const item = this.enqueueForThread(threadId, input, { source: opts?.source })
      return {
        message: '',
        actions: [],
        queued: true,
        queueItem: item
      }
    }

    return this.runTurnOnSession(session, input, reuseLastUser, opts?.source !== 'wake')
  }

  private async runTurnOnSession(
    session: ThreadSession,
    input: OrchestratorSendInput,
    reuseLastUser: boolean,
    displayUserMessage = true,
    opts?: {
      queueItemId?: string
      claimOwnerToken?: string
      /** When true, executeTurn must not chain ordinary post-turn queue drains. */
      suppressAutoQueueDrain?: boolean
      externalSignal?: AbortSignal
      externalDrainSteer?: () => string | undefined
      modelOverride?: { llmProvider: string; model: string }
      onTurnSettled?: (aborted: boolean) => void
    }
  ): Promise<OrchestratorResponse> {
    return this.sessionAls
      .run(session, () =>
        this.executeTurn(input, reuseLastUser, displayUserMessage, opts)
      )
      .finally(() => this.releaseSessionExecutionLease(session))
  }

  private releaseSessionExecutionLease(session: ThreadSession): void {
    if (!session.executionLease) return
    releaseExecutionLeaseHandle(session.executionLease)
    session.executionLease = null
  }

  private async executeTurn(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    displayUserMessage = true,
    opts?: {
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

    // Resolve project cwd for this thread without process.chdir / global root races.
    if (session.threadId !== '__unbound__' && this.projectManager && this.threadStore) {
      try {
        const projectPath = resolveThreadProjectPath(
          this.projectManager,
          this.threadStore,
          session.threadId
        )
        session.projectCwd = resolveProjectWorkingDirectory(projectPath)
        // Only move worktree root when this is the bound session and no concurrent turn
        // is relying on ALS projectCwd alone (GUI tools that still read WorktreeManager).
        if (this.boundSession.threadId === session.threadId) {
          this.worktrees.setRepoRoot(session.projectCwd)
        }
      } catch {
        // Project path optional for standalone threads.
      }
    }

    // Pull any messages peers enqueued before we started.
    this.refreshSessionQueueFromDisk(session)
    session.drainedExternalSteerIds.clear()

    const request = normalizeSendRequest(input)
    const userContent = request.content
    const mode = request.mode
    const images = request.images

    // Keep user commits visible in the sidebar. Internal orchestration wakes stay hidden.
    if (!reuseLastUser && displayUserMessage) {
      this.markThreadStartedAndNotify(session.threadId)
    }

    // A first visible user message must be titled before it is accepted and before the
    // main assistant turn starts. Internal orchestration input never titles a draft.
    if (!reuseLastUser && displayUserMessage) {
      await this.generateInitialThreadTitle(session, userContent)
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
            queueItemId
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

    const turn = {
      abort: new AbortController(),
      pendingSteer: [] as string[]
    }
    const mirrorExternalAbort = (): void => turn.abort.abort()
    if (opts?.externalSignal?.aborted) {
      mirrorExternalAbort()
    } else {
      opts?.externalSignal?.addEventListener('abort', mirrorExternalAbort, { once: true })
    }
    this.activeTurn = turn
    // Authoritative turn lifecycle boundary (includes queue/background turns).
    this.emit('turn-started', { threadId: session.threadId })

    let assistantText: string
    let aborted = false
    let responseMetadata: ChatMessage['responseMetadata'] | undefined
    let connectionFailed = false
    try {
      const modelOverride = opts?.modelOverride ?? session.modelOverride
      const { limit } = this.llm.getSelectedModelContextLimit(mode, modelOverride)
      const contextInputs = await this.llm.getContextInputs(mode, userContent, modelOverride)
      const activeTokens = estimateActiveContextTokens(getActiveMessages(this.nativeContext)) +
        Math.ceil((contextInputs.systemPromptText.length + contextInputs.mcpToolsText.length + contextInputs.otherToolsText.length) / 4)
      if (shouldCompactNativeContext(activeTokens, limit, DEFAULT_COMPACTION_RESERVE_TOKENS)) {
        this.nativeContext = compactNativeContext(this.nativeContext)
        this.lastMeasuredContextSignature = null
        this.persist(true)
      }
      const result = await retryConnectionFailures(
        async () => {
          const run = () => this.llm.chat(
            getActiveMessages(this.nativeContext),
            (event) => {
              this.handleStreamingToolEvent(event)
            },
            {
              mode,
              llmProvider: modelOverride?.llmProvider,
              model: modelOverride?.model,
              projectPath: session.projectCwd ?? undefined,
              threadId: session.threadId,
              signal: turn.abort.signal,
              drainSteer: () => {
                const parts = [
                  opts?.externalDrainSteer?.()?.trim(),
                  this.drainSteerForSession(session, turn)?.trim()
                ].filter((part): part is string => Boolean(part))
                return parts.length > 0 ? parts.join('\n') : undefined
              },
              onNativeMessages: (nativeMessages) => {
                // A completed-turn measurement becomes stale as soon as the live loop
                // appends or compacts native history. Estimate until the final provider
                // response supplies a new authoritative prompt measurement.
                this.lastMeasuredContextSignature = null
                this.lastMeasuredInput = null
                this.lastMeasuredCacheRead = null
                this.lastMeasuredCacheWrite = null
                this.measuredAtHistoryLength = 0
                this.commitActiveNativeMessages(nativeMessages)
                this.persist(true)
                if (session.executionLease) {
                  heartbeatExecutionLease(session.executionLease)
                }
              },
              toolLoopSafety: {
                compactionThresholdTokens: Math.max(32_000, Math.min(128_000, limit)),
                compactNativeMessages: (nativeMessages) =>
                  compactMessagesAtSafeBoundary(nativeMessages)
              }
            },
            (event) => {
              this.handleStreamingThinkingEvent(event)
            },
            (event) => {
              this.handleStreamingTextEvent(event)
            }
          )
          return retryContextOverflowOnce(run, () => {
            const compacted = compactNativeContext(this.nativeContext)
            if (compacted === this.nativeContext) return false
            this.nativeContext = compacted
            this.lastMeasuredContextSignature = null
            this.persist(true)
            return true
          })
        },
        (attempt) => this.addSystemMessage(`Retrying (${attempt}/5) ....`),
        { signal: turn.abort.signal }
      )
      assistantText = result.text
      aborted = Boolean(result.aborted)
      responseMetadata = {
        modelName: result.modelName,
        totalResponseTimeMs: result.totalResponseTimeMs,
        tokensUsed: result.totalTokensUsed,
        tokensPerSecond: result.tokensPerSecond
      }
      this.lastMeasuredInput = result.usage.input
      this.lastMeasuredCacheRead = result.usage.cacheRead
      this.lastMeasuredCacheWrite = result.usage.cacheWrite
      this.lastMeasuredContextSignature = result.contextInputs.signature
      this.commitActiveNativeMessages(result.nativeMessages)
      // Provider prompt usage excludes the assistant message it produced.
      this.measuredAtHistoryLength = Math.max(0, getActiveMessages(this.nativeContext).length - 1)
    } catch (err) {
      const isAbort =
        turn.abort.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
      if (isAbort) {
        aborted = true
        assistantText = ''
      } else if (err instanceof ConnectionRetriesExhaustedError) {
        connectionFailed = true
        assistantText = ''
      } else {
        const errMsg = err instanceof Error ? err.message : String(err)
        assistantText = `LLM error: ${errMsg}`
      }
    } finally {
      if (turn.abort.signal.aborted) aborted = true
      opts?.externalSignal?.removeEventListener('abort', mirrorExternalAbort)
      this.activeTurn = null
      opts?.onTurnSettled?.(aborted)
      // Authoritative end boundary: interrupted on abort, otherwise completed
      // (including connection-failed and LLM error paths after cleanup).
      if (aborted) {
        this.emit('turn-interrupted', { threadId: session.threadId })
      } else {
        this.emit('turn-completed', { threadId: session.threadId })
      }
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

    if (connectionFailed) {
      this.failedConnectionRequest = input
      this.emit('connection-failed', { threadId: session.threadId })
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) this.scheduleQueueDrain(session)
      return { message: '', actions: [] }
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
      this.persist(true)
      // Cross-channel IPC delivery and an in-flight renderer snapshot can otherwise leave
      // the persisted stopped message invisible until the thread is reopened.
      this.emitThreadMessages(session.threadId, session.messages)
      this.emit('response', response)
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
      this.persist(true)
      this.emit('response', response)
      this.emitThreadMessages(session.threadId, session.messages)
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) this.scheduleQueueDrain(session)
      return response
    }

    const parsedActions = parseActions(assistantText)
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
      this.lastCompletedAssistantContent === displayText
    ) {
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
      const toolCallMessage = this.addToolCallMessage(action)
      try {
        const logs = await this.executeAction(action)
        const failures = logs.filter(isActionFailureLog)
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
          const wakeMessage = buildCompleteTaskFailureWake(action.agentIds, logs)
          if (wakeMessage) this.scheduleOrchestratorWake(wakeMessage)
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
          const wakeMessage = buildSpawnAgentsFailureWake([`[spawn] Failed: ${message}`])
          if (wakeMessage) this.scheduleOrchestratorWake(wakeMessage)
        } else if (action.type === 'complete_task') {
          const wakeMessage = buildCompleteTaskFailureWake(action.agentIds, [
            `[complete] Failed: ${message}`
          ])
          if (wakeMessage) this.scheduleOrchestratorWake(wakeMessage)
        }
      }
    }

    if (!allowsOrchestrationActions(mode) && parsedActions.length > actions.length) {
      const modeLabel = getChatModeLabel(mode).toLowerCase()
      this.addSystemMessage(`[${modeLabel}] Ignored orchestration actions emitted by the model.`)
    }

    const response: OrchestratorResponse = {
      message: displayText || 'Done.',
      actions
    }
    this.persist(true)
    this.emit('response', response)
    this.emitThreadMessages(session.threadId, session.messages)
    this.releaseSessionExecutionLease(session)
    if (!suppressAutoQueueDrain) this.scheduleQueueDrain(session)
    return response
  }

  /**
   * Drain local pendingSteer plus any durable external steer-intent items once.
   * External steers are removed from the durable queue and never replayed as normal messages.
   */
  private drainSteerForSession(
    session: ThreadSession,
    turn: { pendingSteer: string[] }
  ): string | undefined {
    const parts: string[] = []
    if (turn.pendingSteer.length > 0) {
      parts.push(...turn.pendingSteer)
      turn.pendingSteer = []
    }

    // Refresh durable queue so peer CLI/GUI steers are visible mid-turn.
    this.refreshSessionQueueFromDisk(session)
    const externalSteers = listPendingQueue(session.queue).filter(
      (item) =>
        item.intent === 'steer' &&
        (item.state === 'pending' || item.state === 'steering') &&
        !session.drainedExternalSteerIds.has(item.id)
    )
    if (externalSteers.length > 0) {
      const ids = externalSteers.map((item) => item.id)
      for (const item of externalSteers) {
        parts.push(item.content)
        session.drainedExternalSteerIds.add(item.id)
      }
      if (this.threadStore) {
        session.queue = mutateDurableQueue(this.threadStore, session.threadId, (disk) =>
          dropSteerItems(disk, ids)
        )
      } else {
        session.queue = dropSteerItems(session.queue, ids)
      }
      this.emitQueueUpdated(session.threadId, session.queue)
    }

    if (session.executionLease) {
      heartbeatExecutionLease(session.executionLease)
    }

    const text = parts.join('\n').trim()
    return text || undefined
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
    if (session.deleted || session.threadId === '__unbound__') {
      settle('idle')
      return
    }
    if (session.isTurnRunning()) {
      settle('idle')
      return
    }
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
          const acceptedIds = new Set(
            data.messages
              .filter((message) => typeof message.queueItemId === 'string')
              .map((message) => message.queueItemId as string)
          )
          // Opportunistically complete accepted claims whose queue-file complete failed earlier.
          // Does not release unaccepted live-owner claims.
          const cleaned = reclaimAbandonedClaims(disk, {
            isOwnerLive: (claim) => isProcessAlive(claim.ownerPid),
            isAccepted: (item) => acceptedIds.has(item.id)
          }).items
          const demoted = demoteSteerItems(cleaned)
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
        mode: item.mode,
        images: item.images
      },
      false,
      !item.internal,
      {
        queueItemId: item.id,
        claimOwnerToken: claimToken,
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
    while (
      this.startupDrainActive < OrchestratorService.STARTUP_QUEUE_DRAIN_CONCURRENCY &&
      this.startupDrainPending.length > 0
    ) {
      const threadId = this.startupDrainPending.shift()!
      const session = this.getOrCreateSession(threadId)
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
    const session = threadId
      ? this.getOrCreateSession(threadId)
      : this.boundSession
    if (!session.failedConnectionRequest || session.isTurnRunning()) return false
    const request = session.failedConnectionRequest
    session.failedConnectionRequest = null
    void this.runTurnOnSession(session, request, true)
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

  /** Reconcile persisted agent/task records with their worktree progress files. */
  restoreAgentProgress(): void {
    const ownerSession = this.session
    this.progressMonitor.stopAll()
    // Persisted agents never rehydrate live GUI sessions; clear the tracking set so
    // stale "running" GUI records cannot remain active forever after restart/thread load.
    this.liveGuiAgents.clear()

    for (const agent of this.agents.list()) {
      this.agentOwners.set(agent.id, ownerSession)
      const task = this.tasks.findByAgentId(agent.id)
      if (!task) continue

      if (agent.status === 'ready' || agent.status === 'completed') {
        if (task.status !== 'completed') this.tasks.updateStatus(task.id, 'completed')
        continue
      }
      if (agent.status === 'failed') {
        if (task.status !== 'failed') this.tasks.updateStatus(task.id, 'failed')
        continue
      }
      if (agent.status === 'cancelled') {
        if (task.status !== 'cancelled') this.tasks.updateStatus(task.id, 'cancelled')
        continue
      }
      if (agent.status === 'interrupted') {
        if (task.status !== 'interrupted') this.tasks.updateStatus(task.id, 'interrupted')
        continue
      }
      if (agent.status === 'conflict' || agent.status === 'merging') continue

      // A task completion may have been persisted just before its agent update.
      if (task.status === 'completed') {
        this.agents.updateStatus(agent.id, 'ready')
        continue
      }
      if (task.status === 'failed') {
        this.agents.updateStatus(agent.id, 'failed')
        continue
      }
      if (task.status === 'cancelled') {
        this.agents.updateStatus(agent.id, 'cancelled')
        continue
      }
      if (task.status === 'interrupted') {
        this.agents.updateStatus(agent.id, 'interrupted')
        continue
      }

      // GUI agents that claim to be running but have no live session must not stay active.
      if (
        agent.executionMode === 'gui' &&
        (agent.status === 'running' || agent.status === 'starting') &&
        !this.liveGuiAgents.has(agent.id)
      ) {
        const interruptionReason =
          'GUI session was not restored; marked interrupted on startup.'
        if (this.mousseAgents.markInterrupted(agent.id, interruptionReason)) {
          // The lifecycle listener performs registry/task reconciliation and batch wake.
          continue
        }
        this.agents.updateStatus(agent.id, 'interrupted')
        this.tasks.updateStatus(task.id, 'interrupted')
        this.tasks.updateProgress(task.id, {
          message: interruptionReason
        })
        this.addSystemMessage(
          `[Agent ${agent.id.slice(0, 8)} interrupted] GUI session was not restored after load.`
        )
        continue
      }

      this.progressMonitor.resume(agent.id, agent.worktreePath, (update) =>
        this.sessionAls.run(ownerSession, () => this.handleAgentProgress(agent.id, update))
      )
    }
    this.checkDelegationBatches()
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

  async spawnAgents(specs: SubagentAssignment[]): Promise<string[]> {
    const ownerSession = this.session
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

    for (const spec of uniqueSpecs) {
      const validationError = validateSubagentAssignment(spec)
      if (validationError) {
        logs.push(`[agent] Skipped ${spec.cliType}: ${validationError}`)
        continue
      }
      if (!this.macros.listProviders().includes(spec.cliType)) {
        logs.push(`[agent] Skipped ${spec.cliType}: disabled or unavailable`)
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
          logs.push(`[agent] Skipped mousse: ${message}`)
          continue
        }
      }

      const task = this.tasks.create(spec.task)
      this.tasks.updateStatus(task.id, 'in_progress')

      const agentId = uuidv4()
      let worktreePath = ''
      let branch = ''

      try {
        const wt = await this.worktrees.createWorktree(agentId)
        worktreePath = wt.path
        branch = wt.branch
        logs.push(`[worktree] Created ${worktreePath} on branch ${branch}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logs.push(`[worktree] Failed: ${msg}`)
        this.tasks.updateStatus(task.id, 'failed')
        continue
      }

      const progressPath = taskProgressPath(worktreePath)
      const assignmentTask = spec.task + taskProgressInstructions(progressPath)
      const prep = this.agentConfigManager
        ? await this.agentConfigManager.prepare(agentId, spec.cliType, worktreePath, this.worktrees.getRepoRoot())
        : undefined
      prep?.logs.forEach((line) => logs.push(line))
      prep?.warnings.forEach((line) => logs.push(`[integrations] ${line}`))

      if (spec.cliType === 'mousse') {
        const agent = this.agents.create({
          cliType: 'mousse',
          worktreePath,
          branch,
          executionMode: 'gui',
          status: 'running',
          task: spec.task
        }, agentId)

        this.tasks.linkAgent(task.id, agent.id)
        this.tasks.updateStatus(task.id, 'in_progress')
        batch.add(agent.id)
        this.agentOwners.set(agent.id, ownerSession)
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

        const agent = this.agents.create({
          cliType: spec.cliType,
          worktreePath,
          branch,
          executionMode: 'headless',
          processId,
          status: 'running',
          task: spec.task
        }, agentId)

        this.tasks.linkAgent(task.id, agent.id)
        this.tasks.updateStatus(task.id, 'in_progress')
        batch.add(agent.id)
        this.agentOwners.set(agent.id, ownerSession)
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

      const agent = this.agents.create({
        cliType: spec.cliType,
        worktreePath,
        branch,
        executionMode: 'interactive',
        ptyId,
        status: 'starting',
        task: spec.task
      }, agentId)

      this.tasks.linkAgent(task.id, agent.id)
      this.tasks.updateStatus(task.id, 'in_progress')
      batch.add(agent.id)
      this.agentOwners.set(agent.id, ownerSession)

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
        void this.sessionAls.run(spawnSession, async () => {
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
                prompt: assignmentTask,
                windowTitle: spec.cliType
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
        })
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
      const agent = this.agents.resolve(agentId)
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
        ? await this.worktrees.hasMergeCandidate({ path: agent.worktreePath, branch: agent.branch })
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
    if (isTerminalAgentStatus(agent.status) && merge) {
      const hasMergeCandidate = await this.worktrees.hasMergeCandidate({
        path: agent.worktreePath,
        branch: agent.branch
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

  private async finalizeAgent(agent: Agent, merge: boolean): Promise<string[]> {
    const logs: string[] = []

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
        return logs
      }
      logs.push(`[mousse] Stopped agent ${agent.id.slice(0, 8)}`)
    } else if (agent.ptyId) {
      this.ptyManager.kill(agent.ptyId)
      logs.push(`[terminal] Closed agent ${agent.id.slice(0, 8)}`)
    }

    this.progressMonitor.stop(agent.id)
    this.liveGuiAgents.delete(agent.id)
    this.agents.updateStatus(agent.id, 'merging')
    const task = this.tasks.findByAgentId(agent.id)

    if (merge) {
      const result = await this.worktrees.mergeAndRemove(
        { path: agent.worktreePath, branch: agent.branch },
        { commit: agent.readyCommit, diffFiles: agent.readyDiffFiles }
      )
      if (result.success) {
        // Cleanup is intentionally after successful merge/removal. A plain Stop or failed
        // merge must leave the recoverable worktree byte-for-byte intact.
        if (this.agentConfigManager) {
          logs.push(...(await this.agentConfigManager.cleanup(agent.id)))
        }
        logs.push(`[merge] Merged ${agent.branch}`)
        this.agents.updateStatus(agent.id, 'completed')
        task && this.tasks.updateStatus(task.id, 'completed')
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
      this.mousseAgents.remove(agent.id)
      // Session removal can trigger a final renderer refresh that observes no messages.
      // Re-emit the terminal registry state afterwards so a stale GUI tab cannot remain.
      const finalStatus = this.agents.get(agent.id)?.status
      if (finalStatus === 'completed' || finalStatus === 'cancelled') {
        this.agents.updateStatus(agent.id, finalStatus)
      }
      logs.push(`[mousse] Closed GUI agent ${agent.id.slice(0, 8)}`)
    }
    this.checkDelegationBatches()
    return logs
  }

  getMousseAgentMessages(agentId: string): ChatMessage[] {
    return this.mousseAgents.getMessages(agentId)
  }

  getMousseAgentAssignment(agentId: string): MousseAgentAssignment | undefined {
    return this.mousseAgents.getAssignment(agentId)
  }

  abortMousseAgent(agentId: string): boolean {
    return this.mousseAgents.abort(agentId)
  }

  exportMousseAgentSessions(): MousseAgentSessionSnapshot[] {
    return this.mousseAgents.exportSessions()
  }

  restoreMousseAgentSessions(sessions: unknown): MousseAgentLifecycleEvent[] {
    this.mousseAgents.clearSessions()
    return this.mousseAgents.restoreSessions(sessions)
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

  sendMousseAgentMessage(
    agentId: string,
    content: string,
    images?: ChatImageAttachment[]
  ): void {
    if (!this.prepareGuiAgentResume(agentId)) return
    void this.mousseAgents.send(agentId, content, images)
  }

  retryMousseAgent(agentId: string): void {
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
    const existing = this.readinessChecks.get(agentId)
    if (existing) return existing
    const ownerSession = this.session

    const check = (async () => {
      const agent = this.agents.get(agentId)
      const task = this.tasks.findByAgentId(agentId)
      if (!agent || !task || isTerminalAgentStatus(agent.status)) return

      const verificationOnly = /\bverification[- ]only\b/i.test(agent.task)
      const readiness = await this.worktrees.prepareForReady(
        { path: agent.worktreePath, branch: agent.branch },
        { verificationOnly, summary: update.summary || update.message }
      )
      // Re-read state after awaiting Git: cancellation/failure may have won the race.
      const current = this.agents.get(agentId)
      if (!current || isTerminalAgentStatus(current.status) || current.status === 'merging') return

      const correctionAttempt = this.noDiffCorrectionAttempts.get(agentId) ?? 0
      if (
        current.executionMode === 'gui' &&
        isRecoverableNoDiffReadinessFailure(readiness.error, verificationOnly, correctionAttempt)
      ) {
        this.noDiffCorrectionAttempts.set(agentId, correctionAttempt + 1)
        this.tasks.updateProgress(task.id, {
          progress: 95,
          message: 'Completion had no implementation diff; asking the worker to re-check its assignment once.'
        })
        this.addSystemMessage(
          `[Agent ${agentId.slice(0, 8)} correction] Completion had no implementation diff; requesting one bounded retry.`
        )
        const becameIdle = await this.mousseAgents.waitForIdle(agentId, 30_000)
        if (becameIdle) {
          this.progressMonitor.start(agentId, agent.worktreePath, (nextUpdate) => {
            this.sessionAls.run(ownerSession, () => this.handleAgentProgress(agentId, nextUpdate))
          })
          const correction = [
            '[Mousse readiness correction]',
            'Your completion was rejected because your branch contains no implementation diff.',
            `Re-read and complete the original assignment: ${agent.task}`,
            'Do not claim an unrelated pre-existing commit. Implement and test the requested change, then commit it and update the monitored progress file.',
            'If the requested implementation truly already exists, write status "failed" with concrete evidence instead of claiming completion.'
          ].join('\n')
          setTimeout(() => {
            this.sessionAls.run(ownerSession, () => {
              void this.mousseAgents.send(agentId, correction)
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
        this.agents.updateReadyMetadata(agentId, readiness.commit, readiness.diffFiles ?? [])
        this.agents.updateStatus(agentId, 'ready')
        this.tasks.updateProgress(task.id, { progress: 100, summary: update.summary })
        this.tasks.updateStatus(task.id, 'completed')
        this.addSystemMessage(
          `[Agent ${agentId.slice(0, 8)} ready for merge] ${update.summary || update.message || agent.task}`
        )
      }
      this.checkDelegationBatches()
    })().finally(() => {
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
    prompt: string
  ): Promise<{ text: string; silent: boolean; error?: string }> {
    try {
      const result = await this.llm.chat([userMessage(prompt)], () => {}, {
        mode: 'agent'
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
    }
  ): Promise<{ text: string; silent: boolean; error?: string; aborted?: boolean }> {
    const ownedTurn = !opts?.signal
    const channelTurn = ownedTurn
      ? { abort: new AbortController(), pendingSteer: [] as string[] }
      : null
    if (channelTurn) this.channelTurns.set(threadId, channelTurn)

    const signal = opts?.signal ?? channelTurn!.abort.signal
    let lease: ThreadLeaseHandle | null = null

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

      // Transfer lease ownership to the regular turn path so every exit releases it.
      session.executionLease = lease
      lease = null
      let wasAborted = false
      const result = await this.runTurnOnSession(
        session,
        { content, mode: 'agent' },
        false,
        true,
        {
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
    }
  }
}
