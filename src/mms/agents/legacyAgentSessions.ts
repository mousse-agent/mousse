import type {
  ChatMessage,
  MousseAgentRunState,
  MousseAgentSessionSnapshot,
  NativeLlmContext
} from '../../shared/types'
import type { Message } from '@earendil-works/pi-ai'
import { getActiveMessages, normalizeNativeContext } from '../orchestrator/nativeContext'

/**
 * Reads the durable `mousse-agent-sessions.json` that earlier builds left in a thread's data.
 * Nothing runs or restores these sessions any more; the data is validated on load and kept until
 * the thread is retired or purged.
 */

export const MOUSSE_AGENT_SESSION_VERSION = 2 as const

type DurableMousseAgentSessionSnapshot = MousseAgentSessionSnapshot & { nativeContext?: NativeLlmContext }

function parseNativeContext(value: unknown): NativeLlmContext | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.messages)) return undefined
  if (!value.messages.every(isNativeMessage)) return undefined
  if (!Number.isInteger(value.activeStartIndex) || Number(value.activeStartIndex) < 0 || Number(value.activeStartIndex) > value.messages.length) {
    return undefined
  }
  if (value.fidelity !== 'native' && value.fidelity !== 'legacy-estimated') return undefined
  return normalizeNativeContext(structuredClone(value) as unknown as NativeLlmContext)
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
