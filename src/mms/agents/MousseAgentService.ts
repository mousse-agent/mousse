import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  ChatImageAttachment,
  ChatMessage,
  MousseAgentRunState,
  MousseAgentSendResult,
  MousseAgentSessionSnapshot,
  MousseAgentSessionUsage,
  SubagentAssignment
} from '../../shared/types'
import type { Message } from '@earendil-works/pi-ai'
import type {
  LlmClient,
  StreamingLlmThinkingEvent,
  StreamingLlmToolEvent
} from '../orchestrator/LlmClient'
import { parseActions, stripActionBlocks } from '../orchestrator/LlmClient'
import {
  compactMessagesAtSafeBoundary,
  userMessage
} from '../orchestrator/nativeContext'
import {
  ConnectionRetriesExhaustedError,
  retryConnectionFailures
} from '../orchestrator/connectionRetry'

export const MOUSSE_AGENT_SESSION_VERSION = 1 as const

const TASK_PROGRESS_PROTOCOL_MARKER = '\n[Mousse task progress protocol]'

export function stripTaskProgressProtocolForDisplay(content: string): string {
  const protocolIndex = content.indexOf(TASK_PROGRESS_PROTOCOL_MARKER)
  return protocolIndex >= 0 ? content.slice(0, protocolIndex).trimEnd() : content
}

const INTERRUPTED_RELOAD_REASON =
  'Session was interrupted by an app or thread reload and was not restarted automatically.'

export interface MousseAgentSessionCallbacks {
  spawnAgents: (specs: Array<{ cliType: string; task: string }>) => Promise<string[]>
  completeAgent: (agentId: string, merge: boolean, summary: string) => Promise<void>
}

export interface MousseAgentLifecycleEvent {
  agentId: string
  state: MousseAgentRunState
  reason?: string
  usage?: MousseAgentSessionUsage
  lastError?: string
}

interface SessionState {
  agentId: string
  worktreePath: string
  task: string
  messages: ChatMessage[]
  history: Message[]
  running: boolean
  runState: MousseAgentRunState
  lastError?: string
  usage?: MousseAgentSessionUsage
  warnings: string[]
  activeAssistantMessageId: string | null
  activeThinkingMessageId: string | null
  activeToolCallMessageIds: Map<string, string>
  assistantStreamBase: string
  assignment: Pick<SubagentAssignment, 'provider' | 'model' | 'effort'>
  updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'string'
  )
}

function isNativeMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false
  return value.role === 'user' || value.role === 'assistant' || value.role === 'toolResult'
}

function isRunState(value: unknown): value is MousseAgentRunState {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'failed' ||
    value === 'interrupted' ||
    value === 'completed'
  )
}

/** Validate one durable session entry; returns null for corrupted or legacy junk. */
export function parseMousseAgentSessionSnapshot(raw: unknown): MousseAgentSessionSnapshot | null {
  if (!isRecord(raw)) return null
  if (raw.version !== MOUSSE_AGENT_SESSION_VERSION && raw.version !== undefined) {
    // Future versions are ignored until an explicit migrator exists.
    if (typeof raw.version === 'number' && raw.version > MOUSSE_AGENT_SESSION_VERSION) return null
  }
  if (typeof raw.agentId !== 'string' || !raw.agentId) return null
  if (typeof raw.worktreePath !== 'string') return null
  if (!Array.isArray(raw.messages) || !raw.messages.every(isChatMessage)) return null
  if (!Array.isArray(raw.history) || !raw.history.every(isNativeMessage)) return null

  const runState = isRunState(raw.runState)
    ? raw.runState
    : raw.running === true
      ? 'running'
      : 'idle'

  const assignment = isRecord(raw.assignment)
    ? {
        provider: typeof raw.assignment.provider === 'string' ? raw.assignment.provider : undefined,
        model: typeof raw.assignment.model === 'string' ? raw.assignment.model : undefined,
        effort: typeof raw.assignment.effort === 'string' ? raw.assignment.effort : undefined
      }
    : {}

  const usage = isRecord(raw.usage)
    ? {
        totalTokens:
          typeof raw.usage.totalTokens === 'number' ? raw.usage.totalTokens : undefined,
        totalResponseTimeMs:
          typeof raw.usage.totalResponseTimeMs === 'number'
            ? raw.usage.totalResponseTimeMs
            : undefined,
        modelName: typeof raw.usage.modelName === 'string' ? raw.usage.modelName : undefined,
        tokensPerSecond:
          typeof raw.usage.tokensPerSecond === 'number' ? raw.usage.tokensPerSecond : undefined
      }
    : undefined

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((entry): entry is string => typeof entry === 'string')
    : undefined

  return {
    version: MOUSSE_AGENT_SESSION_VERSION,
    agentId: raw.agentId,
    worktreePath: raw.worktreePath,
    task: typeof raw.task === 'string' ? raw.task : '',
    assignment,
    messages: raw.messages as ChatMessage[],
    history: raw.history as Message[],
    runState,
    usage,
    warnings,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
  }
}

/** Validate a loaded sessions array; drops invalid entries. */
export function parseMousseAgentSessions(raw: unknown): MousseAgentSessionSnapshot[] {
  if (!Array.isArray(raw)) return []
  const sessions: MousseAgentSessionSnapshot[] = []
  for (const entry of raw) {
    const parsed = parseMousseAgentSessionSnapshot(entry)
    if (parsed) sessions.push(parsed)
  }
  return sessions
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Structural detection for tool-loop / safety-limit failures (typed API may arrive later). */
export function isSafetyLimitError(err: unknown): boolean {
  if (isRecord(err) && (err.name === 'ToolLoopSafetyError' || err.code === 'TOOL_LOOP_SAFETY')) {
    return true
  }
  const message = errorMessage(err)
  return (
    /before producing a final response/i.test(message) ||
    /safety (limit|budget)/i.test(message) ||
    /tool loop/i.test(message)
  )
}

/**
 * Defensively pull partial Pi-native transcript off thrown errors.
 * LlmClient may later attach typed fields; accept several structural shapes today.
 */
export function extractPartialNativeMessages(err: unknown): Message[] | undefined {
  if (!isRecord(err)) return undefined
  const candidates = [
    err.nativeMessages,
    err.partialNativeMessages,
    err.partialMessages,
    isRecord(err.metadata) ? err.metadata.nativeMessages : undefined,
    isRecord(err.cause) ? err.cause.nativeMessages : undefined
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every(isNativeMessage)) {
      return structuredClone(candidate) as Message[]
    }
  }
  return undefined
}

function extractUsageFromError(err: unknown): MousseAgentSessionUsage | undefined {
  if (!isRecord(err)) return undefined
  const source = isRecord(err.usage)
    ? err.usage
    : isRecord(err.accumulatedUsage)
      ? err.accumulatedUsage
    : isRecord(err.metadata) && isRecord(err.metadata.usage)
      ? err.metadata.usage
      : undefined
  if (!source) return undefined
  return {
    totalTokens:
      typeof source.totalTokens === 'number'
        ? source.totalTokens
        : typeof source.processedTokens === 'number'
          ? source.processedTokens
          : undefined,
    totalResponseTimeMs:
      typeof source.totalResponseTimeMs === 'number' ? source.totalResponseTimeMs : undefined,
    modelName: typeof source.modelName === 'string' ? source.modelName : undefined,
    tokensPerSecond:
      typeof source.tokensPerSecond === 'number' ? source.tokensPerSecond : undefined
  }
}

function extractWarningsFromError(err: unknown): string[] {
  if (!isRecord(err)) return []
  const raw = err.warnings ?? (isRecord(err.metadata) ? err.metadata.warnings : undefined)
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

export class MousseAgentService extends EventEmitter {
  private sessions = new Map<string, SessionState>()
  private persistFn?: (immediate?: boolean) => void

  constructor(
    private llm: LlmClient,
    private callbacks: MousseAgentSessionCallbacks
  ) {
    super()
  }

  setPersistCallback(fn: (immediate?: boolean) => void): void {
    this.persistFn = fn
  }

  private persist(immediate = false): void {
    this.persistFn?.(immediate)
  }

  private touch(session: SessionState): void {
    session.updatedAt = new Date().toISOString()
  }

  private setRunState(
    session: SessionState,
    state: MousseAgentRunState,
    reason?: string
  ): void {
    session.runState = state
    session.running = state === 'running'
    if (reason) session.lastError = reason
    this.touch(session)
    const event: MousseAgentLifecycleEvent = {
      agentId: session.agentId,
      state,
      reason: reason ?? session.lastError,
      usage: session.usage,
      lastError: session.lastError
    }
    this.emit('lifecycle', event)
    if (state === 'failed' || state === 'interrupted') {
      this.emit('failed', event)
    }
  }

  start(
    agentId: string,
    task: string,
    worktreePath: string,
    assignment: Pick<SubagentAssignment, 'provider' | 'model' | 'effort'> = {}
  ): void {
    const now = new Date().toISOString()
    const session: SessionState = {
      agentId,
      worktreePath,
      task,
      messages: [],
      history: [],
      running: false,
      runState: 'idle',
      warnings: [],
      activeAssistantMessageId: null,
      activeThinkingMessageId: null,
      activeToolCallMessageIds: new Map(),
      assistantStreamBase: '',
      assignment,
      updatedAt: now
    }
    this.sessions.set(agentId, session)
    this.persist(true)
    void this.send(agentId, task, undefined, true)
  }

  getMessages(agentId: string): ChatMessage[] {
    return [...(this.sessions.get(agentId)?.messages ?? [])]
  }

  getRunState(agentId: string): MousseAgentRunState | undefined {
    return this.sessions.get(agentId)?.runState
  }

  getLastError(agentId: string): string | undefined {
    return this.sessions.get(agentId)?.lastError
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  /** Export durable snapshots for the owning thread's .mousse data. */
  exportSessions(): MousseAgentSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => this.toSnapshot(session))
  }

  private toSnapshot(session: SessionState): MousseAgentSessionSnapshot {
    return {
      version: MOUSSE_AGENT_SESSION_VERSION,
      agentId: session.agentId,
      worktreePath: session.worktreePath,
      task: session.task,
      assignment: { ...session.assignment },
      messages: structuredClone(session.messages),
      history: structuredClone(session.history),
      runState: session.runState === 'running' ? 'running' : session.runState,
      usage: session.usage ? { ...session.usage } : undefined,
      warnings: session.warnings.length > 0 ? [...session.warnings] : undefined,
      lastError: session.lastError,
      updatedAt: session.updatedAt
    }
  }

  /**
   * Restore durable sessions after thread/app load.
   * Never restarts model work: any `running` snapshot becomes interrupted/failed.
   * Returns lifecycle events for registry/task reconciliation.
   */
  restoreSessions(rawSessions: unknown): MousseAgentLifecycleEvent[] {
    const snapshots = parseMousseAgentSessions(rawSessions)
    this.sessions.clear()
    const events: MousseAgentLifecycleEvent[] = []

    for (const snapshot of snapshots) {
      const wasActive = snapshot.runState === 'running'
      const runState: MousseAgentRunState = wasActive
        ? 'interrupted'
        : snapshot.runState === 'completed'
          ? 'completed'
          : snapshot.runState === 'failed' || snapshot.runState === 'interrupted'
            ? snapshot.runState
            : 'idle'

      const lastError =
        wasActive
          ? snapshot.lastError?.trim()
            ? snapshot.lastError
            : INTERRUPTED_RELOAD_REASON
          : snapshot.lastError

      const messages = structuredClone(snapshot.messages).map((message) =>
        message.streaming ? { ...message, streaming: false, incomplete: true } : message
      )

      if (wasActive) {
        const alreadyNoted = messages.some(
          (message) =>
            message.role === 'system' &&
            (message.kind === 'warning' || message.kind === 'progress') &&
            message.content.includes('interrupted')
        )
        if (!alreadyNoted) {
          messages.push({
            id: uuidv4(),
            role: 'system',
            kind: 'warning',
            content: lastError ?? INTERRUPTED_RELOAD_REASON,
            timestamp: new Date().toISOString()
          })
        }
      }

      const session: SessionState = {
        agentId: snapshot.agentId,
        worktreePath: snapshot.worktreePath,
        task: snapshot.task,
        messages,
        history: structuredClone(snapshot.history),
        running: false,
        runState,
        lastError,
        usage: snapshot.usage ? { ...snapshot.usage } : undefined,
        warnings: [...(snapshot.warnings ?? [])],
        activeAssistantMessageId: null,
        activeThinkingMessageId: null,
        activeToolCallMessageIds: new Map(),
        assistantStreamBase: '',
        assignment: { ...snapshot.assignment },
        updatedAt: snapshot.updatedAt
      }
      this.sessions.set(session.agentId, session)

      if (runState === 'interrupted' || runState === 'failed') {
        const event: MousseAgentLifecycleEvent = {
          agentId: session.agentId,
          state: runState,
          reason: lastError,
          usage: session.usage,
          lastError
        }
        events.push(event)
        this.emit('lifecycle', event)
        this.emit('failed', event)
      }

      this.emit('messages-sync', {
        agentId: session.agentId,
        messages: [...session.messages]
      })
    }

    return events
  }

  /** Clear in-memory sessions when leaving a thread (snapshots already persisted). */
  clearSessions(): void {
    this.sessions.clear()
  }

  /** Persist a lost idle/running session as interrupted without restarting model work. */
  markInterrupted(agentId: string, reason = INTERRUPTED_RELOAD_REASON): boolean {
    const session = this.sessions.get(agentId)
    if (!session || session.runState === 'completed') return false
    this.stopStreamingPlaceholders(session)
    this.setRunState(session, 'interrupted', reason)
    this.persist(true)
    return true
  }

  /**
   * Presentation-only progress/warning. Never appended to Pi-native history.
   * Used for budget warnings and similar operator-facing notes.
   */
  pushProgressMessage(
    agentId: string,
    content: string,
    kind: 'progress' | 'warning' = 'progress'
  ): void {
    const session = this.sessions.get(agentId)
    if (!session) return
    const trimmed = content.trim()
    if (!trimmed) return
    if (kind === 'warning' && !session.warnings.includes(trimmed)) {
      session.warnings.push(trimmed)
    }
    this.pushMessage(session, {
      id: uuidv4(),
      role: 'system',
      kind,
      content: trimmed,
      timestamp: new Date().toISOString()
    })
    this.persist(true)
  }

  private pushMessage(session: SessionState, message: ChatMessage): void {
    session.messages.push(message)
    this.touch(session)
    this.emit('message', { agentId: session.agentId, message })
  }

  private updateMessage(session: SessionState, message: ChatMessage): void {
    const index = session.messages.findIndex((entry) => entry.id === message.id)
    if (index === -1) return
    session.messages[index] = message
    this.touch(session)
    this.emit('message-updated', { agentId: session.agentId, message })
  }

  private checkpointNativeHistory(session: SessionState, messages: Message[]): void {
    session.history = structuredClone(messages)
    this.touch(session)
    // Crash-safe: flush after every assistant / tool-result append.
    this.persist(true)
  }

  private stopStreamingPlaceholders(session: SessionState): void {
    if (session.activeAssistantMessageId) {
      const existing = session.messages.find(
        (entry) => entry.id === session.activeAssistantMessageId
      )
      if (existing?.streaming) {
        this.updateMessage(session, {
          ...existing,
          streaming: false,
          incomplete: true
        })
      }
      session.activeAssistantMessageId = null
      session.assistantStreamBase = ''
    }
    if (session.activeThinkingMessageId) {
      const thinking = session.messages.find(
        (message) => message.id === session.activeThinkingMessageId
      )
      if (thinking?.thinking?.status === 'processing') {
        this.updateMessage(session, {
          ...thinking,
          thinking: { ...thinking.thinking, status: 'complete' }
        })
      }
      session.activeThinkingMessageId = null
    }
    for (const messageId of session.activeToolCallMessageIds.values()) {
      const existing = session.messages.find((entry) => entry.id === messageId)
      if (existing?.toolCall?.status === 'processing') {
        this.updateMessage(session, {
          ...existing,
          toolCall: { ...existing.toolCall, status: 'complete' }
        })
      }
    }
    session.activeToolCallMessageIds.clear()
  }

  private addStreamingAssistantMessage(session: SessionState): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true
    }
    this.pushMessage(session, msg)
    return msg
  }

  private handleStreamingTextEvent(session: SessionState, event: { phase: string; content: string }): void {
    if (event.phase === 'start') {
      if (!session.activeAssistantMessageId) {
        const msg = this.addStreamingAssistantMessage(session)
        session.activeAssistantMessageId = msg.id
        session.assistantStreamBase = ''
      }
      return
    }

    if (!session.activeAssistantMessageId) return
    const messageId = session.activeAssistantMessageId
    const existing = session.messages.find((entry) => entry.id === messageId)
    if (!existing) return

    if (event.phase === 'delta') {
      this.updateMessage(session, {
        ...existing,
        content: session.assistantStreamBase + event.content,
        streaming: true
      })
      return
    }

    if (event.phase === 'complete') {
      const combined = session.assistantStreamBase + event.content
      session.assistantStreamBase = combined
      this.updateMessage(session, {
        ...existing,
        content: combined,
        streaming: true
      })
    }
  }

  private handleStreamingThinkingEvent(
    session: SessionState,
    event: StreamingLlmThinkingEvent
  ): void {
    if (event.phase === 'start') {
      if (session.activeAssistantMessageId) {
        const placeholder = session.messages.find(
          (entry) => entry.id === session.activeAssistantMessageId
        )
        if (placeholder?.streaming && !placeholder.content) {
          session.messages = session.messages.filter((entry) => entry.id !== placeholder.id)
          session.activeAssistantMessageId = null
          session.assistantStreamBase = ''
          this.emit('messages-sync', {
            agentId: session.agentId,
            messages: [...session.messages]
          })
        }
      }

      const message: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        kind: 'thinking',
        content: '',
        timestamp: new Date().toISOString(),
        thinking: { content: '', status: 'processing' }
      }
      session.activeThinkingMessageId = message.id
      this.pushMessage(session, message)
      return
    }

    if (!session.activeThinkingMessageId) return
    const existing = session.messages.find(
      (entry) => entry.id === session.activeThinkingMessageId
    )
    if (!existing) return
    this.updateMessage(session, {
      ...existing,
      thinking: {
        content: event.content,
        status: event.phase === 'complete' ? 'complete' : 'processing'
      }
    })
    if (event.phase === 'complete') session.activeThinkingMessageId = null
  }

  private handleStreamingToolEvent(session: SessionState, event: StreamingLlmToolEvent): void {
    const kind =
      event.kind === 'build_tool_call'
        ? 'mcp_tool_call'
        : event.kind === 'build_tool_result'
          ? 'mcp_tool_result'
          : event.kind

    if (event.phase === 'complete' && event.callId) {
      const messageId = session.activeToolCallMessageIds.get(event.callId)
      const existing = messageId
        ? session.messages.find((entry) => entry.id === messageId)
        : undefined
      if (existing) {
        this.updateMessage(session, {
          ...existing,
          toolCall: {
            title: event.title,
            summary: event.summary,
            details: event.details,
            response: event.response,
            status: 'complete'
          }
        })
        session.activeToolCallMessageIds.delete(event.callId)
        return
      }
    }

    const message: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind,
      content: '',
      timestamp: new Date().toISOString(),
      toolCall: {
        title: event.title,
        summary: event.summary,
        details: event.details,
        response: event.response,
        status: event.phase === 'start' ? 'processing' : 'complete'
      }
    }
    this.pushMessage(session, message)
    if (event.phase === 'start' && event.callId) {
      session.activeToolCallMessageIds.set(event.callId, message.id)
    }
  }

  async send(
    agentId: string,
    content: string,
    images?: ChatImageAttachment[],
    isBootstrap = false,
    reuseLastUser = false
  ): Promise<MousseAgentSendResult> {
    const session = this.sessions.get(agentId)
    if (!session) return { accepted: false, reason: 'missing' }
    if (session.running) return { accepted: false, reason: 'busy' }
    if (session.runState === 'completed') return { accepted: false, reason: 'terminal' }

    const trimmed = content.trim()
    const imageList = images?.filter((img) => img.data && img.mimeType) ?? []
    if (!reuseLastUser && !trimmed && imageList.length === 0) {
      return { accepted: false, reason: 'empty' }
    }

    this.setRunState(session, 'running')
    session.lastError = undefined
    session.activeAssistantMessageId = null
    session.activeThinkingMessageId = null
    session.activeToolCallMessageIds.clear()
    session.assistantStreamBase = ''
    if (!reuseLastUser) {
      const displayContent = stripTaskProgressProtocolForDisplay(trimmed)
      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        // Internal task protocol remains in native history below, but is not user-facing chat content.
        content: displayContent || (imageList.length ? '[Image attachment]' : ''),
        timestamp: new Date().toISOString(),
        images: imageList.length ? imageList : undefined
      }
      this.pushMessage(session, userMsg)
      session.history.push(userMessage(trimmed, imageList))
      this.persist(true)
    }

    try {
      // Subagent: coding tools + no spawn_agents (prevents recursive agent storms).
      const result = await retryConnectionFailures(
        () =>
          this.llm.chat(
            session.history,
            (event) => this.handleStreamingToolEvent(session, event),
            {
              mode: 'build',
              subagent: true,
              llmProvider: session.assignment.provider,
              model: session.assignment.model,
              effort: session.assignment.effort,
              projectPath: session.worktreePath,
              // Keep this subagent's cache affinity distinct from its parent and siblings.
              threadId: session.agentId,
              onNativeMessages: (nativeMessages) => {
                this.checkpointNativeHistory(session, nativeMessages)
              },
              toolLoopSafety: {
                // Periodic context maintenance only; this does not cap loop lifetime.
                compactionThresholdTokens: 128_000,
                compactNativeMessages: (nativeMessages) =>
                  compactMessagesAtSafeBoundary(nativeMessages)
              }
            },
            (event) => this.handleStreamingThinkingEvent(session, event),
            (event) => this.handleStreamingTextEvent(session, event)
          ),
        (attempt) =>
          this.pushMessage(session, {
            id: uuidv4(),
            role: 'system',
            kind: 'progress',
            content: `Retrying (${attempt}/5) ....`,
            timestamp: new Date().toISOString()
          })
      )
      const parsedActions = parseActions(result.text)
      const displayText = stripActionBlocks(result.text)
      // A stopped stream is intentionally retained as partial text, but has no completed-response metadata.
      const responseMetadata = result.aborted
        ? undefined
        : {
            modelName: result.modelName,
            totalResponseTimeMs: result.totalResponseTimeMs,
            tokensUsed: result.totalTokensUsed,
            tokensPerSecond: result.tokensPerSecond
          }
      session.history = result.nativeMessages ?? session.history
      session.usage = {
        totalTokens: result.totalTokensUsed,
        totalResponseTimeMs: result.totalResponseTimeMs,
        modelName: result.modelName,
        tokensPerSecond: result.tokensPerSecond
      }
      this.touch(session)

      if (session.activeAssistantMessageId) {
        const existing = session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
        if (existing) {
          this.updateMessage(session, {
            ...existing,
            content: displayText || 'Done.',
            streaming: false,
            ...(responseMetadata ? { responseMetadata } : { incomplete: true })
          })
        }
        session.activeAssistantMessageId = null
        session.assistantStreamBase = ''
      } else {
        const assistantMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: displayText || 'Done.',
          timestamp: new Date().toISOString(),
          ...(responseMetadata ? { responseMetadata } : { incomplete: true })
        }
        this.pushMessage(session, assistantMsg)
      }

      for (const action of parsedActions) {
        if (action.type === 'spawn_agents') {
          // Subagents must never spawn — that caused endless recursive agents.
          const note: ChatMessage = {
            id: uuidv4(),
            role: 'system',
            content:
              '[mousse] Ignored spawn_agents from subagent. This agent implements work directly and cannot spawn further agents.',
            timestamp: new Date().toISOString()
          }
          this.pushMessage(session, note)
          continue
        }
        if (action.type === 'complete_task') {
          const summary = displayText || 'Task completed.'
          await this.callbacks.completeAgent(agentId, action.merge !== false, summary)
          this.setRunState(session, 'completed')
          this.persist(true)
          this.emit('complete', { agentId, summary })
          return { accepted: true }
        }
      }

      this.setRunState(session, 'idle')
      this.persist(true)
    } catch (err) {
      if (err instanceof ConnectionRetriesExhaustedError) {
        this.stopStreamingPlaceholders(session)
        this.setRunState(session, 'failed', errorMessage(err))
        this.persist(true)
        this.emit('connection-failed', { agentId })
        return { accepted: true }
      }

      const message = errorMessage(err)
      const partialNative = extractPartialNativeMessages(err)
      if (partialNative && partialNative.length > 0) {
        session.history = partialNative
      }

      const usage = extractUsageFromError(err)
      if (usage) {
        session.usage = { ...session.usage, ...usage }
      }

      for (const warning of extractWarningsFromError(err)) {
        if (!session.warnings.includes(warning)) session.warnings.push(warning)
        this.pushMessage(session, {
          id: uuidv4(),
          role: 'system',
          kind: 'warning',
          content: warning,
          timestamp: new Date().toISOString()
        })
      }

      if (isSafetyLimitError(err)) {
        this.pushMessage(session, {
          id: uuidv4(),
          role: 'system',
          kind: 'warning',
          content: message,
          timestamp: new Date().toISOString()
        })
      }

      if (session.activeAssistantMessageId) {
        const existing = session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
        if (existing) {
          this.updateMessage(session, {
            ...existing,
            content: existing.content?.trim()
              ? `${existing.content}\n\nError: ${message}`
              : `Error: ${message}`,
            streaming: false,
            incomplete: true
          })
        }
        session.activeAssistantMessageId = null
        session.assistantStreamBase = ''
      } else {
        const errorMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: `Error: ${message}`,
          timestamp: new Date().toISOString(),
          incomplete: true
        }
        this.pushMessage(session, errorMsg)
      }

      this.stopStreamingPlaceholders(session)
      this.setRunState(session, 'failed', message)
      this.persist(true)
    } finally {
      const current = this.sessions.get(agentId)
      if (current) {
        current.running = false
        if (current.runState === 'running') {
          current.runState = 'idle'
        }
        if (current.activeThinkingMessageId) {
          const thinking = current.messages.find(
            (message) => message.id === current.activeThinkingMessageId
          )
          if (thinking?.thinking?.status === 'processing') {
            this.updateMessage(current, {
              ...thinking,
              thinking: { ...thinking.thinking, status: 'complete' }
            })
          }
          current.activeThinkingMessageId = null
        }
        current.activeToolCallMessageIds.clear()
        this.persist(true)
      }
      if (!isBootstrap) {
        this.emit('idle', { agentId })
      } else {
        // Bootstrap start also ends with idle so listeners can clear spinners.
        this.emit('idle', { agentId })
      }
    }
    return { accepted: true }
  }

  /**
   * Resume from the checkpointed Pi-native transcript.
   * Does not re-append the original assignment / last user task.
   */
  retry(agentId: string): void {
    const session = this.sessions.get(agentId)
    if (!session || session.running) return
    if (session.history.length === 0) {
      // No checkpoint — re-send the original assignment once.
      void this.send(agentId, session.task || '', undefined, false, false)
      return
    }
    void this.send(agentId, '', undefined, false, true)
  }

  isTurnActive(agentId: string): boolean {
    return this.sessions.get(agentId)?.running === true
  }

  /** Keep terminal transcripts durable and non-interactive instead of deleting them. */
  archive(agentId: string): void {
    const session = this.sessions.get(agentId)
    if (!session) return
    if (!session.running) this.setRunState(session, 'completed')
    this.persist(true)
  }

  remove(agentId: string): void {
    this.sessions.delete(agentId)
    this.persist(true)
  }
}
