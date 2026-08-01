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
  type MousseAgentSessionSnapshot,
  type NativeLlmContext,
  type OrchestratorAction,
  type OrchestratorContextUsageInput,
  type OrchestratorResponse,
  type OrchestratorSendInput,
  type QueuedMessage,
  type SubagentAssignment
} from '../../shared/types'
import { EFFORT_SUFFIXES } from '../../shared/modelVariants'
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
  drainNextNormal,
  dropSteerItems,
  enqueueMessage,
  listPendingQueue,
  promoteQueuedMessageToSteer,
  QueueValidationError,
  removeQueuedMessage,
  reorderQueuedMessages
} from '../queue/ThreadMessageQueue'
import { ThreadSession } from './ThreadSession'
import {
  MousseAgentService,
  type MousseAgentLifecycleEvent
} from '../agents/MousseAgentService'
import { ConnectionRetriesExhaustedError, retryConnectionFailures } from './connectionRetry'
import {
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
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private mousseAgents: MousseAgentService
  private progressMonitor = new TaskProgressMonitor()
  private delegationBatches = new Set<Set<string>>()
  private wakeQueue: string[] = []
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * GUI agents with a live in-process Mousse session. Persisted "running" agents that
   * are absent from this set after load are treated as interrupted.
   */
  private liveGuiAgents = new Set<string>()
  /** In-flight channel turns keyed by mousse thread id. */
  private channelTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: string[] }
  >()
  /** Optional thread store for durable queue persistence. */
  private threadStore: ThreadDataStore | null = null

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

  constructor(
    private agents: AgentRegistry,
    private tasks: TaskQueue,
    private worktrees: WorktreeManager,
    private ptyManager: PtyManager,
    private headlessRunner: HeadlessAgentRunner,
    private macros: MacroEngine,
    settingsStore: SettingsStore,
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
    this.llm = new LlmClient(
      settingsStore,
      providerAuth,
      mcpManager,
      skillsRegistry,
      () => this.worktrees.getRepoRoot(),
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

  private persist(immediate = false): void {
    const threadId = this.session.threadId === '__unbound__' ? null : this.session.threadId
    if (immediate) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer)
        this.persistTimer = null
      }
      this.persistFn?.(threadId)
      this.persistQueue(threadId)
      return
    }

    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistFn?.(threadId)
      this.persistQueue(threadId)
    }, 500)
  }

  private persistQueue(threadId: string | null): void {
    if (!threadId || !this.threadStore) return
    try {
      if (!this.threadStore.getThread(threadId)) return
      this.threadStore.saveMessageQueue(threadId, this.getOrCreateSession(threadId).queue)
    } catch {
      // Thread may have been deleted mid-turn.
    }
  }

  /**
   * Ensure a session exists for threadId (loaded from disk if needed).
   * Does not change the bound GUI session unless threadId matches bound.
   */
  getOrCreateSession(threadId: string): ThreadSession {
    if (this.boundSession.threadId === threadId) return this.boundSession
    let session = this.sessions.get(threadId)
    if (session) return session
    session = new ThreadSession(threadId)
    if (this.threadStore?.getThread(threadId)) {
      const data = this.threadStore.loadThreadData(threadId)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue
      )
      if (this.projectManager) {
        const projectPath = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
        session.projectCwd = resolveProjectWorkingDirectory(projectPath)
      }
    }
    this.sessions.set(threadId, session)
    return session
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
        queue ?? (this.threadStore ? this.threadStore.loadMessageQueue(threadId) : [])
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
    if (!threadId || threadId === this.boundSession.threadId) {
      return [...this.boundSession.messages]
    }
    return [...this.getOrCreateSession(threadId).messages]
  }

  getMessageQueue(threadId?: string): QueuedMessage[] {
    const id = threadId ?? this.getBoundThreadId()
    if (!id) return []
    return listPendingQueue(this.getOrCreateSession(id).queue)
  }

  listQueue(threadId: string): QueuedMessage[] {
    return this.getMessageQueue(threadId)
  }

  private emitQueueUpdated(threadId: string, items: QueuedMessage[]): void {
    const pending = listPendingQueue(items)
    this.emit('queue-updated', { threadId, items: pending })
  }

  private emitThreadMessages(threadId: string, messages: ChatMessage[]): void {
    this.emit('thread-messages', { threadId, messages: [...messages] })
    // Legacy unscoped mirror only for the GUI-bound (selected) thread.
    if (threadId === this.boundSession.threadId) {
      this.emit('messages-sync', [...messages])
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
    opts?: { source?: string; intent?: 'normal' | 'steer' }
  ): QueuedMessage {
    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new QueueValidationError(`Thread not found: ${threadId}`)
    }
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new QueueValidationError(`Thread deleted: ${threadId}`)
    }
    const request = normalizeSendRequest(input)
    const { items, item } = enqueueMessage(session.queue, {
      threadId,
      content: request.content,
      mode: request.mode,
      images: request.images,
      intent: opts?.intent ?? 'normal',
      source: opts?.source
    })
    session.queue = items
    this.persistQueue(threadId)
    this.emitQueueUpdated(threadId, session.queue)
    return item
  }

  removeQueuedItem(threadId: string, itemId: string): QueuedMessage | null {
    const session = this.getOrCreateSession(threadId)
    const { items, removed } = removeQueuedMessage(session.queue, itemId)
    session.queue = items
    this.persistQueue(threadId)
    this.emitQueueUpdated(threadId, session.queue)
    return removed
  }

  reorderQueue(threadId: string, orderedIds: string[]): QueuedMessage[] {
    const session = this.getOrCreateSession(threadId)
    session.queue = reorderQueuedMessages(session.queue, orderedIds)
    this.persistQueue(threadId)
    this.emitQueueUpdated(threadId, session.queue)
    return listPendingQueue(session.queue)
  }

  /**
   * Promote a queued item to steer the active turn on this thread.
   * When accepted, the item is removed from the queue and is not drained as a later turn.
   */
  promoteQueueItemToSteer(threadId: string, itemId: string): boolean {
    const session = this.getOrCreateSession(threadId)
    if (!session.isTurnActive()) {
      throw new QueueValidationError('No active turn to steer on this thread.')
    }
    const { items, item } = promoteQueuedMessageToSteer(session.queue, itemId)
    session.queue = items
    const steered = this.steerThread(threadId, item.content)
    if (steered) {
      session.queue = dropSteerItems(session.queue, [item.id])
      this.persistQueue(threadId)
      this.emitQueueUpdated(threadId, session.queue)
      return true
    }
    // Revert promotion if steer was rejected.
    session.queue = session.queue.map((entry) =>
      entry.id === item.id ? { ...entry, intent: 'normal', state: 'pending' } : entry
    )
    this.persistQueue(threadId)
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

  getNativeContext(threadId?: string): NativeLlmContext {
    if (!threadId || threadId === this.boundSession.threadId) {
      return structuredClone(this.boundSession.nativeContext)
    }
    return structuredClone(this.getOrCreateSession(threadId).nativeContext)
  }

  private commitActiveNativeMessages(activeMessages: import('@earendil-works/pi-ai').Message[]): void {
    const hasSyntheticSummary = Boolean(this.nativeContext.compaction?.summary)
    const replayed = hasSyntheticSummary && activeMessages[0]?.role === 'user'
      ? activeMessages.slice(1)
      : activeMessages
    this.nativeContext.messages = [
      ...this.nativeContext.messages.slice(0, this.nativeContext.activeStartIndex),
      ...structuredClone(replayed)
    ]
  }

  async getContextUsage(input: OrchestratorContextUsageInput = ''): Promise<ContextUsageSnapshot> {
    const request = normalizeContextUsageRequest(input)
    const { limit, modelName } = this.llm.getSelectedModelContextLimit(request.mode)
    const contextInputs = await this.llm.getContextInputs(request.mode, request.draftInput)
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
    responseMetadata?: ChatMessage['responseMetadata']
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      responseMetadata
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist(true)
    return msg
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
      session.queue = []
      this.persistQueue(id)
      this.emitQueueUpdated(id, [])
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
    if (!session?.activeTurn || session.activeTurn.abort.signal.aborted) {
      return false
    }
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
   */
  async send(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: { threadId?: string; source?: string; forceQueue?: boolean }
  ): Promise<OrchestratorResponse> {
    const threadId = opts?.threadId ?? this.getBoundThreadId()
    if (!threadId) {
      // Legacy unbound path (tests / early boot): use bound session directly.
      return this.runTurnOnSession(this.boundSession, input, reuseLastUser)
    }

    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new Error(`Thread deleted: ${threadId}`)
    }

    if (session.isTurnRunning() || opts?.forceQueue) {
      const item = this.enqueueForThread(threadId, input, { source: opts?.source })
      return {
        message: '',
        actions: [],
        queued: true,
        queueItem: item
      }
    }

    return this.runTurnOnSession(session, input, reuseLastUser)
  }

  private async runTurnOnSession(
    session: ThreadSession,
    input: OrchestratorSendInput,
    reuseLastUser: boolean
  ): Promise<OrchestratorResponse> {
    return this.sessionAls.run(session, () => this.executeTurn(input, reuseLastUser))
  }

  private async executeTurn(
    input: OrchestratorSendInput,
    reuseLastUser = false
  ): Promise<OrchestratorResponse> {
    const session = this.session
    if (session.deleted) {
      throw new Error(`Thread deleted: ${session.threadId}`)
    }
    if (this.activeTurn) {
      // Same-session re-entry should not happen; callers queue first.
      throw new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
    }

    // Resolve project cwd for this thread without process.chdir.
    if (session.threadId !== '__unbound__' && this.projectManager && this.threadStore) {
      try {
        const projectPath = resolveThreadProjectPath(
          this.projectManager,
          this.threadStore,
          session.threadId
        )
        session.projectCwd = resolveProjectWorkingDirectory(projectPath)
        // Only move worktree root when this is the bound session (GUI tools).
        if (this.boundSession.threadId === session.threadId) {
          this.worktrees.setRepoRoot(session.projectCwd)
        }
      } catch {
        // Project path optional for standalone threads.
      }
    }

    const request = normalizeSendRequest(input)
    const userContent = request.content
    const mode = request.mode
    const images = request.images
    if (!reuseLastUser) {
      this.addMessage('user', userContent, images)
      this.nativeContext.messages.push(userMessage(userContent, images))
      this.persist(true)
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
    this.activeTurn = turn

    let assistantText: string
    let aborted = false
    let responseMetadata: ChatMessage['responseMetadata'] | undefined
    let connectionFailed = false
    try {
      const { limit } = this.llm.getSelectedModelContextLimit(mode)
      const contextInputs = await this.llm.getContextInputs(mode, userContent)
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
              signal: turn.abort.signal,
              drainSteer: () => {
                if (turn.pendingSteer.length === 0) return undefined
                const text = turn.pendingSteer.join('\n')
                turn.pendingSteer = []
                return text
              },
              onNativeMessages: (nativeMessages) => {
                this.commitActiveNativeMessages(nativeMessages)
                this.persist(true)
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

    if (connectionFailed) {
      this.failedConnectionRequest = input
      this.emit('connection-failed', { threadId: session.threadId })
      this.scheduleQueueDrain(session)
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
      this.scheduleQueueDrain(session)
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
        const failures = logs.filter((line) => /\b(?:failed|skipped|error)\b/i.test(line))
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
    this.scheduleQueueDrain(session)
    return response
  }

  /**
   * After a turn settles, FIFO-drain the next normal queued message for the thread.
   * Steer-intent items are never drained as normal turns.
   */
  private scheduleQueueDrain(session: ThreadSession): void {
    if (session.deleted || session.threadId === '__unbound__') return
    if (session.isTurnRunning()) return
    const { items, next } = drainNextNormal(session.queue)
    session.queue = items
    this.persistQueue(session.threadId)
    this.emitQueueUpdated(session.threadId, session.queue)
    if (!next) return
    if (this.threadStore && !this.threadStore.getThread(session.threadId)) {
      session.deleted = true
      session.queue = []
      return
    }
    void this.runTurnOnSession(session, {
      content: next.content,
      mode: next.mode,
      images: next.images
    }, false).catch((err) => {
      this.sessionAls.run(session, () => {
        this.addSystemMessage(
          `[queue drain failed] ${err instanceof Error ? err.message : String(err)}`
        )
      })
    })
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
        return this.completeTask(action.merge !== false)
      case 'message':
        return [action.content]
      default:
        return []
    }
  }

  /** Reconcile persisted agent/task records with their worktree progress files. */
  restoreAgentProgress(): void {
    this.progressMonitor.stopAll()
    // Persisted agents never rehydrate live GUI sessions; clear the tracking set so
    // stale "running" GUI records cannot remain active forever after restart/thread load.
    this.liveGuiAgents.clear()

    for (const agent of this.agents.list()) {
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
        this.handleAgentProgress(agent.id, update)
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
    const agent = this.agents.get(agentId)
    const task = this.tasks.findByAgentId(agentId)
    if (!agent || !task || isTerminalAgentStatus(agent.status)) return

    this.tasks.updateProgress(task.id, {
      progress: update.progress,
      message: update.message,
      summary: update.summary
    })
    if (update.status === 'working') return

    this.progressMonitor.stop(agentId)
    if (update.status === 'completed') {
      this.liveGuiAgents.delete(agentId)
      this.agents.updateStatus(agentId, 'ready')
      this.tasks.updateProgress(task.id, { progress: 100, summary: update.summary })
      this.tasks.updateStatus(task.id, 'completed')
      this.addSystemMessage(
        `[Agent ${agentId.slice(0, 8)} ready for merge] ${update.summary || update.message || agent.task}`
      )
    } else {
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
      const agents = [...batch].map((id) => this.agents.get(id)).filter((agent): agent is Agent => Boolean(agent))
      if (agents.length !== batch.size) continue
      if (!agents.every((agent) => isDelegationSettledStatus(agent.status))) continue
      this.delegationBatches.delete(batch)
      const report = agents.map((agent) => {
        const task = this.tasks.findByAgentId(agent.id)
        return `- ${agent.id.slice(0, 8)} (${agent.status}): ${task?.summary || task?.progressMessage || agent.task}`
      }).join('\n')
      this.scheduleOrchestratorWake(
        `[Automatic task update] All agents in the delegation batch have finished.\n${report}\nInspect the results. If the ready branches should be integrated, emit complete_task with merge true. Do not merge failed, cancelled, or interrupted agents unless their work is intentionally recovered.`
      )
    }
  }

  private scheduleOrchestratorWake(message: string): void {
    this.wakeQueue.push(message)
    if (this.wakeTimer) return
    const wake = (): void => {
      const boundId = this.getBoundThreadId()
      if (boundId ? this.isTurnActive(boundId) : this.boundSession.isTurnRunning()) {
        this.wakeTimer = setTimeout(wake, 250)
        return
      }
      this.wakeTimer = null
      const content = this.wakeQueue.splice(0).join('\n\n')
      if (!content) return
      void this.send({ content, mode: 'agent' }, false, {
        threadId: boundId ?? undefined,
        source: 'wake'
      }).catch((err) => {
        this.sessionAls.run(this.boundSession, () => {
          this.addSystemMessage(
            `[automatic wake failed] ${err instanceof Error ? err.message : String(err)}`
          )
        })
      })
    }
    this.wakeTimer = setTimeout(wake, 100)
  }

  async spawnAgents(specs: SubagentAssignment[]): Promise<string[]> {
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

    const batchError = validateDelegationBatch(uniqueSpecs)
    if (batchError) {
      logs.push(`[agent] Delegation batch rejected: ${batchError}`)
      return logs
    }

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
      if (spec.cliType === 'mousse' && (spec.provider || spec.model || spec.effort)) {
        try {
          this.llm.validateSubagentLaunch({
            llmProvider: spec.provider,
            model: spec.model,
            effort: spec.effort
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
        this.liveGuiAgents.add(agent.id)
        this.progressMonitor.start(agent.id, worktreePath, (update) =>
          this.handleAgentProgress(agent.id, update)
        )
        this.mousseAgents.start(agent.id, assignmentTask, worktreePath, {
          provider: spec.provider,
          model: spec.model,
          effort: spec.effort
        })
        this.emit('agent-spawned', agent)
        this.emit('agent-activated', { agentId: agent.id })
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
        this.progressMonitor.start(agent.id, worktreePath, (update) =>
          this.handleAgentProgress(agent.id, update)
        )
        this.emit('agent-spawned', agent)
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
      this.progressMonitor.start(agent.id, worktreePath, (update) =>
        this.handleAgentProgress(agent.id, update)
      )

      this.emit('agent-spawned', agent)

      setTimeout(async () => {
        this.agents.updateStatus(agent.id, 'running')

        this.ptyManager.focusWindow()
        this.emit('terminal-activated', { ptyId: agent.ptyId! })
        this.emit('agent-activated', { agentId: agent.id })

        if (!this.ptyManager.has(agent.ptyId!)) {
          logs.push(`[terminal] Cannot prompt ${agent.id.slice(0, 8)}: terminal is not available`)
          this.agents.updateStatus(agent.id, 'failed')
          this.tasks.updateStatus(task.id, 'failed')
          return
        }

        const macroResult = await this.macros.runPtyMacro(spec.cliType, {
          prompt: assignmentTask,
          windowTitle: spec.cliType
        }, (data) => this.ptyManager.write(agent.ptyId!, data))
        macroResult.log.forEach((l) => logs.push(l))
      }, 2000)

      logs.push(`[agent] Spawned ${spec.cliType} agent ${agent.id.slice(0, 8)}`)
    }

    if (batch.size > 0) {
      this.delegationBatches.add(batch)
      this.checkDelegationBatches()
    }
    return logs
  }

  private async completeTask(merge: boolean): Promise<string[]> {
    const logs: string[] = []
    const agentList: Agent[] = []
    for (const agent of this.agents.list()) {
      const hasMergeCandidate = requiresMergeCandidateToFinalize(agent.status)
        ? await this.worktrees.hasMergeCandidate({ path: agent.worktreePath, branch: agent.branch })
        : false
      if (shouldFinalizeAgent(agent.status, hasMergeCandidate)) agentList.push(agent)
    }

    if (agentList.length === 0) {
      logs.push('[complete] No active agents to complete')
      return logs
    }

    for (const agent of agentList) {
      logs.push(...(await this.finalizeAgent(agent, merge)))
      if (this.agents.get(agent.id)?.status === 'conflict') {
        const conflictLogs = logs.filter((line) => line.startsWith('[merge] Conflict'))
        this.scheduleOrchestratorWake(
          `[Automatic merge update] A merge conflict needs main-agent resolution.\n${conflictLogs.join('\n')}\nResolve the listed files in the main working tree, git add them, then emit complete_task with merge true again. Do not abort or delete the agent worktree.`
        )
        break
      }
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
    this.progressMonitor.stop(agent.id)
    this.liveGuiAgents.delete(agent.id)
    this.agents.updateStatus(agent.id, 'merging')
    const task = this.tasks.findByAgentId(agent.id)

    if (this.agentConfigManager) {
      logs.push(...(await this.agentConfigManager.cleanup(agent.id)))
    }

    if (merge) {
      const result = await this.worktrees.mergeAndRemove({
        path: agent.worktreePath,
        branch: agent.branch
      })
      if (result.success) {
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
        // Keep the process/worktree available and preserve Git's merge state for resolution.
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

    if (agent.executionMode === 'headless' && agent.processId) {
      this.headlessRunner.kill(agent.processId)
      logs.push(`[headless] Stopped agent ${agent.id.slice(0, 8)}`)
    } else if (agent.executionMode === 'gui') {
      this.mousseAgents.remove(agent.id)
      logs.push(`[mousse] Closed GUI agent ${agent.id.slice(0, 8)}`)
    } else if (agent.ptyId) {
      this.ptyManager.kill(agent.ptyId)
      logs.push(`[terminal] Closed agent ${agent.id.slice(0, 8)}`)
    }
    this.checkDelegationBatches()
    return logs
  }

  getMousseAgentMessages(agentId: string): ChatMessage[] {
    return this.mousseAgents.getMessages(agentId)
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
    return this.mousseAgents
      .listSessionIds()
      .some((agentId) => this.mousseAgents.getRunState(agentId) === 'running')
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
    this.progressMonitor.start(agentId, agent.worktreePath, (update) =>
      this.handleAgentProgress(agentId, update)
    )
    return true
  }

  private async completeMousseAgent(
    agentId: string,
    _merge: boolean,
    summary: string
  ): Promise<void> {
    // Subagents report readiness only. The parent orchestrator owns integration so it can
    // merge the whole batch in a deterministic order and handle conflicts with full context.
    this.handleAgentProgress(agentId, { status: 'completed', progress: 100, summary })
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
    const previousRoot = this.worktrees.getRepoRoot()
    const projectPath = this.projectManager
      ? resolveThreadProjectPath(this.projectManager, threadStore, threadId)
      : undefined
    // Resolve cwd for the turn without process.chdir (concurrent-safe).
    const resolvedCwd = projectPath ? resolveProjectWorkingDirectory(projectPath) : previousRoot
    if (projectPath) {
      this.worktrees.setRepoRoot(resolvedCwd)
    }

    const ownedTurn = !opts?.signal
    const turn = ownedTurn
      ? { abort: new AbortController(), pendingSteer: [] as string[] }
      : null
    if (turn) {
      this.channelTurns.set(threadId, turn)
    }

    try {
      if (!threadStore.getThread(threadId)) {
        return { text: '', silent: false, error: `Thread not found: ${threadId}` }
      }
      const data = threadStore.loadThreadData(threadId)
      let channelContext = data.llmContext ?? migrateLegacyContext(data.messages)
      let history = getActiveMessages(channelContext)

      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        content,
        timestamp: new Date().toISOString()
      }
      channelContext.messages.push(userMessage(content))
      history = getActiveMessages(channelContext)

      // Persist the user message immediately so /stop mid-turn keeps history.
      threadStore.saveThreadData(threadId, {
        messages: [...data.messages, userMsg],
        agents: data.agents,
        tasks: data.tasks,
        llmContext: channelContext
      })

      const signal = opts?.signal ?? turn!.abort.signal
      const drainSteer =
        opts?.drainSteer ??
        (() => {
          if (!turn || turn.pendingSteer.length === 0) return undefined
          const text = turn.pendingSteer.join('\n')
          turn.pendingSteer = []
          return text
        })

      const result = await this.llm.chat(history, () => {}, {
        mode: 'agent',
        llmProvider: opts?.modelOverride?.llmProvider,
        model: opts?.modelOverride?.model,
        signal,
        drainSteer,
        onNativeMessages: (nativeMessages) => {
          const current = threadStore.loadThreadData(threadId)
          channelContext.messages = [
            ...channelContext.messages.slice(0, channelContext.activeStartIndex),
            ...structuredClone(channelContext.compaction ? nativeMessages.slice(1) : nativeMessages)
          ]
          threadStore.saveThreadData(threadId, { ...current, llmContext: channelContext })
        }
      })
      channelContext.messages = [
        ...channelContext.messages.slice(0, channelContext.activeStartIndex),
        ...structuredClone(channelContext.compaction ? result.nativeMessages.slice(1) : result.nativeMessages)
      ]

      const latest = threadStore.loadThreadData(threadId)

      if (result.aborted || signal.aborted) {
        const stoppedMsg: ChatMessage = {
          id: uuidv4(),
          role: 'system',
          content: 'Turn stopped.',
          timestamp: new Date().toISOString()
        }
        threadStore.saveThreadData(threadId, {
          messages: [...latest.messages, stoppedMsg],
          agents: latest.agents,
          tasks: latest.tasks,
          llmContext: channelContext
        })
        return { text: '', silent: true, aborted: true }
      }

      const rawText = result.text
      const displayText = stripActionBlocks(rawText) || rawText.trim() || 'Done.'
      const silent =
        displayText.trim() === '[SILENT]' || displayText.trimStart().startsWith('[SILENT]')

      const assistantMsg: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: displayText,
        timestamp: new Date().toISOString()
      }

      const parsedActions = parseActions(rawText)
      const systemNotes: ChatMessage[] = []
      if (parsedActions.length > 0) {
        systemNotes.push({
          id: uuidv4(),
          role: 'system',
          content:
            `[channels] Model emitted ${parsedActions.length} orchestration action(s) — ` +
            'not executed from remote channel. Open this thread in Mousse to run agents.',
          timestamp: new Date().toISOString()
        })
      }

      threadStore.saveThreadData(threadId, {
        messages: [...latest.messages, assistantMsg, ...systemNotes],
        agents: latest.agents,
        tasks: latest.tasks,
        llmContext: channelContext
      })

      return { text: displayText, silent }
    } catch (err) {
      const isAbort =
        (opts?.signal?.aborted ?? turn?.abort.signal.aborted) ||
        (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
      if (isAbort) {
        try {
          const latest = threadStore.loadThreadData(threadId)
          const stoppedMsg: ChatMessage = {
            id: uuidv4(),
            role: 'system',
            content: 'Turn stopped.',
            timestamp: new Date().toISOString()
          }
          threadStore.saveThreadData(threadId, {
            messages: [...latest.messages, stoppedMsg],
            agents: latest.agents,
            tasks: latest.tasks
          })
        } catch {
          // best-effort
        }
        return { text: '', silent: true, aborted: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { text: '', silent: false, error: message }
    } finally {
      if (turn) {
        this.channelTurns.delete(threadId)
      }
      if (projectPath) {
        // Restore worktree root only; never chdir for per-turn state.
        this.worktrees.setRepoRoot(previousRoot)
      }
    }
  }
}
