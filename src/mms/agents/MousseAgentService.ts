import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type {
  ChatMessage,
  MousseAgentRunState,
  MousseAgentSessionSnapshot,
  MousseAgentSessionUsage,
  NativeLlmContext,
  SubagentAssignment
} from '../../shared/types'
import type { Message } from '@earendil-works/pi-ai'
import {
  createNativeContext,
  estimateActiveContextTokens,
  getActiveMessages,
  getCompactionSummary,
  normalizeNativeContext
} from '../orchestrator/nativeContext'

export const MOUSSE_AGENT_SESSION_VERSION = 2 as const

const INTERRUPTED_RELOAD_REASON =
  'Session was interrupted by an app or thread reload and was not restarted automatically.'

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
  nativeContext: NativeLlmContext
  runState: MousseAgentRunState
  lastError?: string
  usage?: MousseAgentSessionUsage
  warnings: string[]
  assignment: Pick<SubagentAssignment, 'provider' | 'model' | 'effort'>
  updatedAt: string
  managedBinding?: MousseAgentSessionSnapshot['managedBinding']
}

type DurableMousseAgentSessionSnapshot = MousseAgentSessionSnapshot & { nativeContext?: NativeLlmContext }

const COMPACTION_SUMMARY_MARKER = '[Compacted conversation summary]\n'

function parseNativeContext(value: unknown): NativeLlmContext | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.messages)) return undefined
  if (!value.messages.every(isNativeMessage)) return undefined
  if (!Number.isInteger(value.activeStartIndex) || Number(value.activeStartIndex) < 0 || Number(value.activeStartIndex) > value.messages.length) {
    return undefined
  }
  if (value.fidelity !== 'native' && value.fidelity !== 'legacy-estimated') return undefined
  return normalizeNativeContext(structuredClone(value) as unknown as NativeLlmContext)
}

function migrateFlatHistory(history: Message[]): NativeLlmContext {
  const context = createNativeContext(history)
  const first = history[0]
  if (first?.role !== 'user' || typeof first.content !== 'string' || !first.content.startsWith(COMPACTION_SUMMARY_MARKER)) {
    return context
  }

  // A v1 subagent snapshot may already have discarded its prefix. Preserve every
  // surviving message, but mark the archive as incomplete rather than claiming the
  // missing provider-native state was reconstructed.
  return {
    ...context,
    fidelity: 'legacy-estimated',
    activeStartIndex: 1,
    compaction: {
      generation: 1,
      summary: first.content.slice(COMPACTION_SUMMARY_MARKER.length),
      tokensBefore: estimateActiveContextTokens(history),
      createdAt: first.timestamp
    }
  }
}

function projectLegacyHistory(context: NativeLlmContext): Message[] {
  const active = getActiveMessages(context)
  const summary = getCompactionSummary(context)
  if (!summary) return active
  return [
    { role: 'user', content: `${COMPACTION_SUMMARY_MARKER}${summary}`, timestamp: context.compaction?.createdAt ?? Date.now() },
    ...active
  ]
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
export function parseMousseAgentSessionSnapshot(raw: unknown): DurableMousseAgentSessionSnapshot | null {
  if (!isRecord(raw)) return null
  // Missing versions are legacy v1; explicit v1 and current v2 are both supported.
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== MOUSSE_AGENT_SESSION_VERSION) return null
  if (typeof raw.agentId !== 'string' || !raw.agentId) return null
  if (typeof raw.worktreePath !== 'string') return null
  if (!Array.isArray(raw.messages) || !raw.messages.every(isChatMessage)) return null
  const nativeContext = parseNativeContext(raw.nativeContext)
  const history = Array.isArray(raw.history) && raw.history.every(isNativeMessage)
    ? structuredClone(raw.history) as Message[]
    : nativeContext
      ? getActiveMessages(nativeContext)
      : undefined
  if (!history) return null

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
    managedBinding: isRecord(raw.managedBinding) && typeof raw.managedBinding.workspaceRoot === 'string' && typeof raw.managedBinding.episodeId === 'string' ? { workspaceRoot: raw.managedBinding.workspaceRoot, episodeId: raw.managedBinding.episodeId } : undefined,
    task: typeof raw.task === 'string' ? raw.task : '',
    assignment,
    messages: raw.messages as ChatMessage[],
    history,
    ...(nativeContext ? { nativeContext } : {}),
    runState,
    usage,
    warnings,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()
  }
}

/** Validate a loaded sessions array; drops invalid entries. */
export function parseMousseAgentSessions(raw: unknown): DurableMousseAgentSessionSnapshot[] {
  if (!Array.isArray(raw)) return []
  const sessions: DurableMousseAgentSessionSnapshot[] = []
  for (const entry of raw) {
    const parsed = parseMousseAgentSessionSnapshot(entry)
    if (parsed) sessions.push(parsed)
  }
  return sessions
}

export class MousseAgentService extends EventEmitter {
  private sessions = new Map<string, SessionState>()
  private persistFn?: (immediate?: boolean, agentId?: string) => void

  setPersistCallback(fn: (immediate?: boolean, agentId?: string) => void): void {
    this.persistFn = fn
  }

  private persist(immediate = false, agentId?: string): void {
    this.persistFn?.(immediate, agentId)
  }

  listSessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  /** Export durable snapshots for the owning thread's .mousse data. */
  exportSessions(): MousseAgentSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => this.toSnapshot(session))
  }

  private toSnapshot(session: SessionState): DurableMousseAgentSessionSnapshot {
    return {
      version: MOUSSE_AGENT_SESSION_VERSION,
      agentId: session.agentId,
      worktreePath: session.worktreePath,
      managedBinding: session.managedBinding,
      task: session.task,
      assignment: { ...session.assignment },
      messages: structuredClone(session.messages),
      // Keep the v1 active view for rollback/read compatibility while persisting
      // the lossless archive in the additive nativeContext field.
      history: projectLegacyHistory(session.nativeContext),
      nativeContext: structuredClone(session.nativeContext),
      runState: session.runState,
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
  restoreSessions(rawSessions: unknown, replaceAll = true): MousseAgentLifecycleEvent[] {
    const snapshots = parseMousseAgentSessions(rawSessions)
    if (replaceAll) this.sessions.clear()
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
        managedBinding: snapshot.managedBinding,
        task: snapshot.task,
        messages,
        nativeContext: snapshot.nativeContext
          ? structuredClone(snapshot.nativeContext)
          : migrateFlatHistory(structuredClone(snapshot.history ?? [])),
        runState,
        lastError,
        usage: snapshot.usage ? { ...snapshot.usage } : undefined,
        warnings: [...(snapshot.warnings ?? [])],
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

    }

    return events
  }

  remove(agentId: string): void {
    this.sessions.delete(agentId)
    this.persist(true, agentId)
  }
}
