import type { ModelOverride } from '../../shared/providerInstances'
import { isPermissionMode, type PermissionMode } from '../../shared/permissionMode'
import { isAgentAccessLevel, type AgentAccessLevel } from '../../shared/settings'
import type { AgentThreadRequest } from '../run/mcp/appTools'
import type { AgentActor, ReceiptRecord } from '../run/types'

/** The command kind of the receipt a `thread_create` writes, and the `agent.action` that marks the thread complete. */
export const AGENT_THREAD_COMMAND = 'thread_create'
export const AGENT_THREAD_CREATED_ACTION = 'created_thread'

/** The most a launched thread's own agents are granted whatever the profile says: they read and wait, and never launch or message threads. */
export const LAUNCHED_THREAD_ACCESS_CEILING: AgentAccessLevel = 'read'

/** Boot repair looks at creations of the last week; an older one that never finished is left to its creator's retry. */
export const AGENT_THREAD_REPAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Everything a `thread_create` decided before it made anything: the thread's id, where and how it runs, and
 * the first message. It is written into the command's receipt first, so a retry or a restart finishes this
 * thread from what is stored here and never from what the settings, the caller's run or its arguments say by
 * then (SPEC §15.1).
 */
export interface AgentThreadIntent {
  threadId: string
  projectPath: string
  title: string
  worktreeEnabled: boolean
  /** The project is a Git repository: a turn that edits gets a worktree of its own, else it works in the project folder. */
  gitBacked: boolean
  /** The model stored on the thread; null: the profile's default. */
  modelOverride: ModelOverride | null
  /** The mode stored on the thread: the creator's, or the profile default when that was stricter. Never absent, so a later looser default cannot widen it. */
  permissionMode: PermissionMode
  /** The most the thread's agents may be granted whatever the profile says. */
  accessCeiling: AgentAccessLevel
  createdByThreadId: string
  actor: AgentActor
  request: AgentThreadRequest
  firstMessage: { content: string; mode: 'agent' | 'plan' } | null
}

/** The arguments of a call in one stable form: two calls with the same key must carry the same one. */
export function agentThreadFingerprint(request: AgentThreadRequest): string {
  return JSON.stringify([
    request.projectId,
    request.title ?? null,
    request.workspace,
    request.instanceId ?? null,
    request.model ?? null,
    request.firstMessage ?? null,
    request.firstMessage === undefined ? null : request.mode ?? 'agent'
  ])
}

/**
 * The stored creation of a `thread_create` receipt, or undefined when the receipt is another command's or cannot be
 * trusted: a creation whose limits (level ceiling, mode) are missing or unknown would make a thread with no limit, so it
 * is refused rather than defaulted.
 */
export function readAgentThreadReceipt(receipt: ReceiptRecord | null): { fingerprint: string; intent: AgentThreadIntent } | undefined {
  if (!receipt || receipt.commandKind !== AGENT_THREAD_COMMAND) return undefined
  const result = receipt.result as { fingerprint?: unknown; intent?: Partial<AgentThreadIntent> } | null
  const intent = result?.intent
  if (typeof result?.fingerprint !== 'string' || !intent) return undefined
  if (typeof intent.threadId !== 'string' || typeof intent.projectPath !== 'string' || typeof intent.title !== 'string' || typeof intent.createdByThreadId !== 'string') return undefined
  if (!intent.actor || !intent.request) return undefined
  if (!isAgentAccessLevel(intent.accessCeiling) || !isPermissionMode(intent.permissionMode)) return undefined
  if (typeof intent.worktreeEnabled !== 'boolean' || typeof intent.gitBacked !== 'boolean') return undefined
  if (intent.modelOverride !== null && (typeof intent.modelOverride?.model !== 'string' || !intent.modelOverride.model)) return undefined
  return { fingerprint: result.fingerprint, intent: intent as AgentThreadIntent }
}
