import type { NeutralTool } from '../../harness/tools'
import type { ProviderSelection } from '../../harness/types'
import type { BotEscalationSummary } from './escalation'

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
  /**
   * The folders the bot may touch, and how; null without file access. `access` holds for every
   * root unless `rootAccess` names that root: an answer to a wall adds or upgrades one folder
   * without changing what the others allow.
   */
  workspace: BotWorkspace | null
  budget: BotBudget
  /** Personal bots work for their owner only; bots for other people are not available yet. */
  audience: 'owner'
}

export interface BotWorkspace {
  roots: string[]
  access: 'read' | 'write'
  /** Per-folder access where it differs from `access` (keys are roots). */
  rootAccess?: Record<string, 'read' | 'write'>
}

/** The access a manifest gives one of its roots. */
export function folderAccess(workspace: BotWorkspace, root: string): 'read' | 'write' {
  return workspace.rootAccess?.[root] ?? workspace.access
}

/**
 * A workspace from per-folder access: `access` is `write` only when every folder is writable, and
 * `rootAccess` names each folder that differs. Null without folders.
 */
export function workspaceOf(entries: ReadonlyArray<readonly [string, 'read' | 'write']>): BotWorkspace | null {
  const folders = new Map<string, 'read' | 'write'>()
  for (const [root, access] of entries) folders.set(root, folders.get(root) === 'write' ? 'write' : access)
  if (!folders.size) return null
  const access = [...folders.values()].every((value) => value === 'write') ? 'write' : 'read'
  const roots = [...folders.keys()].sort()
  const differing = roots.filter((root) => folders.get(root) !== access)
  return differing.length
    ? { roots, access, rootAccess: Object.fromEntries(differing.map((root) => [root, folders.get(root)!])) }
    : { roots, access }
}

/** Each folder of a workspace with its own access. */
export function foldersOf(workspace: BotWorkspace | null): Array<[string, 'read' | 'write']> {
  return workspace ? workspace.roots.map((root) => [root, folderAccess(workspace, root)]) : []
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
  /** Manual activation always; schedules on the bot itself (6d). Channels attach from the chat (`/bot`). */
  triggers: { manual: true; schedules?: BotSchedule[] }
}

/**
 * A schedule of a bot (PR 6 §6): each occurrence is one activation with `prompt` as its input.
 * Occurrences missed while Mousse was closed collapse into one catch-up occurrence.
 */
export interface BotSchedule {
  /** Stable within the bot: `[a-z0-9][a-z0-9-]{0,31}`. */
  id: string
  /** Every `minutes`, or a five-field cron expression in local time. */
  when: { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string }
  prompt: string
}

/** Most schedules one bot may have. */
export const MAX_BOT_SCHEDULES = 8

/** Where a channel activation replies (the chat the owner wrote from). */
export interface BotChannelReplyTo {
  platform: 'telegram' | 'discord' | 'webhook'
  chatId: string
  threadId?: string
  messageId?: string
}

/** What started an activation: the Bots tab, a schedule occurrence, or the owner's channel DM. */
export type BotActivationTrigger =
  | { kind: 'manual'; input: string }
  | { kind: 'schedule'; input: string; scheduleId: string; occurrenceAt: string }
  | { kind: 'channel'; input: string; replyTo: BotChannelReplyTo }

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
  trigger: BotActivationTrigger
  createdAt: string
  endedAt: string | null
  endReason: string | null
  /** The final message of the main dispatch, when it completed. */
  result: string | null
  counters: { requests: number; toolCalls: number; activeMs: number }
  /** Tool calls whose outcome is unknown, which the owner must check before the activation goes on. */
  unknownCalls: Array<{ runId: string; invocationId: string; tool: string; role: 'main' | 'consult'; acknowledged: boolean }>
  /** The wall the activation waits at (`waiting_grant`), if any. */
  openEscalation: BotEscalationSummary | null
  /** Whether "Continue" can be offered now (paused, or blocked once its check passes). */
  canContinue: boolean
  /** A paused activation whose run completed: "Mark done" keeps its draft result. */
  canMarkDone: boolean
  /** The main run being continued is `uncertain`: Continue needs the acknowledgement. */
  uncertain: boolean
  /** That `uncertain` run's id, which an acknowledgement names (`acknowledge.uncertainRunId`). */
  uncertainRunId: string | null
}

/**
 * "I've checked what these calls did": exactly the interrupted calls (by invocation id) and the
 * `uncertain` run the owner was shown. A set that changed since is refused, never acknowledged.
 */
export interface BotAcknowledgement {
  calls: readonly string[]
  uncertainRunId?: string | null
}

/** What the owner is asked to check before an activation goes on, as the Bots tab shows it. */
export function acknowledgementOf(activation: Pick<BotActivationSummary, 'unknownCalls' | 'uncertainRunId'>): BotAcknowledgement | undefined {
  const calls = activation.unknownCalls.filter((call) => !call.acknowledged).map((call) => call.invocationId)
  if (!calls.length && !activation.uncertainRunId) return undefined
  return { calls, uncertainRunId: activation.uncertainRunId }
}

/** One thread's check result, as the approval dialog shows it. */
export interface BotThreadCheck {
  key: string
  instanceId: string
  model: string
  ok: boolean
  reason?: string
}

/** One bot, as the Bots tab lists it. */
export interface BotSummary {
  id: string
  name: string
  role: string
  draftHash: string
  revision: string | null
  grant: { digest: string; approvedAt: string } | null
  /** Permissions the published revision asks for beyond the active grant (empty: it runs without asking). */
  needsApproval: BotPermissionLine[]
  /** Open escalations of the bot's activations (the inbox badge). */
  openEscalations: number
}

/** What approving the published revision means (`bots.definitions.get`'s `approval`). */
export interface BotApprovalView {
  revision: string
  digest: string
  added: BotPermissionLine[]
  threads: BotThreadCheck[]
}

/** A permission of a manifest, as the approval dialog states it. */
export interface BotPermissionLine {
  kind: 'tool' | 'app_tool' | 'mcp' | 'skill' | 'workspace' | 'budget'
  text: string
}
