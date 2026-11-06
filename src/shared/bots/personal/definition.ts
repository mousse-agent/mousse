import type { NeutralTool } from '../../harness/tools'
import type { ProviderSelection } from '../../harness/types'
import type { BotEscalationSummary } from './escalation'
import type { BotLook } from './look'

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

/**
 * How much time a bot takes (Bot Phase 1 §5.6). Mousse maps it to a model tier and an effort:
 * `quick` the standard tier at low effort, `normal` the standard tier at its default effort, `deep`
 * the frontier tier at high effort.
 */
export type BotDepth = 'quick' | 'normal' | 'deep'
export const BOT_DEPTHS: readonly BotDepth[] = ['quick', 'normal', 'deep']

/**
 * What a bot thread runs on. Never shown: `auto` is resolved per activation from the owner's ready
 * providers; `named` is a model the owner asked for in words (a catalog id, the instance's model
 * id, or a family word), used only while it is available.
 */
export type BotModelChoice =
  | { mode: 'auto'; depth: BotDepth }
  | { mode: 'named'; model: string; depth: BotDepth }

/** A new bot's model: automatic, at normal depth. */
export const DEFAULT_BOT_MODEL: BotModelChoice = { mode: 'auto', depth: 'normal' }

/** The thread a bot works in: who it is (an agent definition or plain instructions) and what it runs on. */
export interface BotThreadSpec {
  key: string
  title: string
  agent: { definitionId: string; pinRevision: string } | { instructions: string }
  /** Replaces format 1's fixed `selection`. */
  model: BotModelChoice
  /** Removes permissions for this thread only; never adds any. */
  narrow?: Partial<Pick<BotManifest, 'tools' | 'mcp' | 'skills' | 'workspace'>>
}

/** The format a definition is written in. Format 1 files are upgraded on read (Bot Phase 1 §5.2). */
export const BOT_DEFINITION_FORMAT = 2
/** Longest bot name, shown everywhere. */
export const MAX_BOT_NAME_CHARS = 60
/** Longest description: the owner's sentence. */
export const MAX_BOT_DESCRIPTION_CHARS = 500

/** A personal bot, format 2 (Bot Phase 1 §5.1.1): made from a look and one sentence. */
export interface BotDefinition {
  format: 2
  id: string
  /** Content hash of the published revision (absent on a draft). */
  revision?: string
  /** At most `MAX_BOT_NAME_CHARS`. */
  name: string
  /** The owner's sentence, at most `MAX_BOT_DESCRIPTION_CHARS`: the header and About. */
  description: string
  look: BotLook
  /** Reserved for Teams; `team` is refused until then. */
  owner: { kind: 'person'; id: 'self' }
  /** Reserved for bot servers (Phase 3). */
  placement: { kind: 'this_computer' }
  /** The bot's own working instructions; starts as the description. */
  role: string
  main: BotThreadSpec
  /** Context threads it consults (6c-2); at most 8. */
  context: BotThreadSpec[]
  permissions: BotManifest
  /** Manual activation always. Schedules live in `bots.db` (`bot_schedules`), not on the definition. */
  triggers: { manual: true }
}

/**
 * A format-1 thread: a fixed model selection. Read only to upgrade old files.
 * TODO(WP2): the engine and the definition store still run on format 1; move them to `BotThreadSpec`.
 */
export interface BotThreadSpecV1 {
  key: string
  title: string
  agent: { definitionId: string; pinRevision: string } | { instructions: string }
  selection: ProviderSelection
  /** Removes permissions for this thread only; never adds any. */
  narrow?: Partial<Pick<BotManifest, 'tools' | 'mcp' | 'skills' | 'workspace'>>
}

/**
 * A format-1 definition (no `format` field), as the Automations → Bots form wrote it. Read only to
 * upgrade old files (Bot Phase 1 §5.2). TODO(WP2): retire with the form editor.
 */
export interface BotDefinitionV1 {
  id: string
  /** Content hash of the published revision (absent on a draft). */
  revision?: string
  name: string
  role: string
  main: BotThreadSpecV1
  /** Context threads it consults (6c-2); at most 8. */
  context: BotThreadSpecV1[]
  permissions: BotManifest
  /** Manual activation always; schedules on the bot itself (6d). */
  triggers: { manual: true; schedules?: BotSchedule[] }
}

/** Which lane an activation runs in: the owner's chat on the home thread, or a run on a child thread. */
export type BotLane = 'chat' | 'run'

/** How long a deleted bot's chat, memory and threads are kept before the purge (Bot Phase 1 §5.3.3). */
export const BOT_DELETE_PURGE_MS = 30 * 24 * 60 * 60_000

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

/**
 * What started an activation: the Bots tab or a schedule occurrence. Activations saved by older
 * builds may carry other kinds (the removed Channels feature); they are read like these, by `input`.
 */
export type BotActivationTrigger =
  | { kind: 'manual'; input: string }
  | { kind: 'schedule'; input: string; scheduleId: string; occurrenceAt: string }

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

/**
 * One bot, as the Automations → Bots form lists it. The Bot UI's summary is `BotSummary` in
 * `chat.ts`. TODO(WP2/WP4): retire with the form editor.
 */
export interface BotSummaryV1 {
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
  /** Each schedule's next time, and the occurrence it last skipped and why (null once one runs). */
  schedules?: Array<{ id: string; nextRunAt: string | null; skipped: { at: string; reason: string } | null }>
}

/** What a skipped schedule occurrence tells the owner. */
export const BOT_SCHEDULE_SKIP_TEXT: Record<string, string> = {
  bot_approval_required: 'skipped: approve the bot\'s permissions first',
  bot_home_trashed: 'skipped: the bot\'s thread is in the trash',
  bot_waiting_for_owner: 'skipped: the bot is waiting for your answer',
  previous_run_still_queued: 'skipped: the previous run has not started yet'
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
