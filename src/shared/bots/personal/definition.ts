import type { NeutralTool } from '../../harness/tools'
import type { ProviderSelection } from '../../harness/types'

/**
 * A personal bot (PR 6 §4): a role, the thread it works in on each activation, and the permissions
 * that role needs, which the owner approves once. Types and pure checks only, browser-safe.
 */

/** What a bot may use and how much work one activation may do. The owner approves this once. */
export interface BotManifest {
  /** Built-in tools, by neutral name. */
  tools: NeutralTool[]
  /** Mousse app tools, by their app-tool name. */
  appTools: string[]
  /** The user's MCP tools, server-qualified. */
  mcp: Array<{ serverId: string; tool: string }>
  /** Skill ids. */
  skills: string[]
  /** The folders the bot may touch, and how; null without file access. */
  workspace: { roots: string[]; access: 'read' | 'write' } | null
  budget: BotBudget
  /** Personal bots work for their owner only; bots for other people are not available yet. */
  audience: 'owner'
}

export interface BotBudget {
  /** Active work time per activation (required; enforced on every runtime). */
  maxActiveMs: number
  /** Model requests per run, retries included (only on runtimes with hard budgets). */
  maxTurns?: number
  maxToolCalls?: number
  /** Token and USD limits (only on runtimes that reserve spend). */
  maxInputTokens?: number
  maxOutputTokens?: number
  maxUsd?: number
}

/** The thread a bot works in: who it is (an agent definition or plain instructions) and what it runs on. */
export interface BotThreadSpec {
  key: string
  title: string
  agent: { definitionId: string; pinRevision: string } | { instructions: string }
  selection: ProviderSelection
  /** Removes permissions for this thread only; never adds any. */
  narrow?: Partial<Pick<BotManifest, 'tools' | 'mcp' | 'skills' | 'workspace'>>
}

export interface BotDefinition {
  id: string
  /** Content hash of the published revision (absent on a draft). */
  revision?: string
  name: string
  role: string
  main: BotThreadSpec
  /** Context threads it consults (6c-2); at most 8. */
  context: BotThreadSpec[]
  permissions: BotManifest
  /** Only manual activation in this release. */
  triggers: { manual: true }
}

/** The default active time of one activation: 15 minutes. */
export const DEFAULT_BOT_ACTIVE_MS = 15 * 60_000
/** Most context threads one bot may have. */
export const MAX_BOT_CONTEXT_THREADS = 8
/** Most activations one bot keeps queued; the oldest is dropped beyond this. */
export const MAX_QUEUED_ACTIVATIONS = 20
/** The smallest active-time slice a dispatch starts with; less than this left is a budget wall. */
export const ACTIVE_TIME_CHUNK_MS = 15_000

export type BotActivationStatus = 'queued' | 'running' | 'waiting_grant' | 'paused' | 'blocked' | 'done' | 'failed' | 'cancelled'

export const ENDED_ACTIVATION_STATUSES: ReadonlySet<BotActivationStatus> = new Set(['done', 'failed', 'cancelled'])

/** One activation as the Bots tab lists it. */
export interface BotActivationSummary {
  id: string
  botId: string
  revision: string
  status: BotActivationStatus
  threadId: string | null
  trigger: { kind: 'manual'; input: string }
  createdAt: string
  endedAt: string | null
  endReason: string | null
  /** The final message of the main dispatch, when it completed. */
  result: string | null
  counters: { requests: number; toolCalls: number; activeMs: number }
  /** Tool calls whose outcome is unknown, which the owner must check before the activation goes on. */
  unknownCalls: Array<{ runId: string; invocationId: string; tool: string; role: 'main' | 'consult'; acknowledged: boolean }>
}

/** A permission of a manifest, as the approval dialog states it. */
export interface BotPermissionLine {
  kind: 'tool' | 'app_tool' | 'mcp' | 'skill' | 'workspace' | 'budget'
  text: string
}
