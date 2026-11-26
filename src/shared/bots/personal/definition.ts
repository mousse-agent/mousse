import type { ScheduledMissedRuns, TellMe } from '../../types'
import type { NeutralTool } from '../../harness/tools'
import type { ProviderSelection } from '../../harness/types'
import type { BotMessageSender } from './botMessages'
import type { BotEscalationSummary } from './escalation'
import type { BotLook } from './look'
import type { PermissionMode } from '../../permissionMode'

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
  mcp: Array<{ serverId: string; tool: string; level?: 'asks_first' }>
  /** Skill ids. */
  skills: string[]
  /**
   * No longer grants anything. Older builds wrote file access outside the bot's files folder here ("use files on this
   * computer", removed because a bot that runs commands reached past it anyway). A stored value is kept exactly as it
   * was written, so grants and revisions that hold one keep their digest and stay approved; nothing reads it for what a
   * bot may do, and a new bot's is null.
   */
  workspace: BotWorkspace | null
  budget: BotBudget
  /** Personal bots work for their owner only; bots for other people are not available yet. */
  audience: 'owner'
  /**
   * "Allow everything" (issue #1363), a bot's Full access: every capability a personal bot can be granted
   * (`withFullTrust`), without asking. Only `true` is ever stored, so a grant without it hashes as before. It never
   * passes the owner's switches, Settings and Labs, what each kind of turn may do, a subagent's narrower set, or asks
   * first; limits stay as they are.
   */
  fullTrust?: true
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
  /**
   * Work time per activation, no longer used: work time has no limit. A grant approved before keeps it only so its
   * digest, and the activations made under it, still hold; nothing reads it.
   */
  maxActiveMs?: number
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
 * How hard a piece of work is (#673): the bot gives each job a level (`work_start`), and a level picks its Work model.
 * Light, medium and hard are the depths quick, normal and deep.
 */
export type BotWorkLevel = 'light' | 'medium' | 'hard'
export const BOT_WORK_LEVELS: readonly BotWorkLevel[] = ['light', 'medium', 'hard']
export const LEVEL_DEPTH: Readonly<Record<BotWorkLevel, BotDepth>> = { light: 'quick', medium: 'normal', hard: 'deep' }
export const DEPTH_LEVEL: Readonly<Record<BotDepth, BotWorkLevel>> = { quick: 'light', normal: 'medium', deep: 'hard' }

/**
 * What a bot thread runs on, as format 2 writes it. `auto` is by usage: resolved per activation from the owner's ready
 * providers (bots from before picks only); `named` is a model by name (a catalog id, the instance's model id, or a family
 * word), matched across entries. `depth` is the bot's standing level: work that names no level runs at it. Older builds
 * run every turn on this choice; this build reads `slots` beside it (`slotsOf`).
 */
export type BotModelChoice =
  | { mode: 'auto'; depth: BotDepth }
  | { mode: 'named'; model: string; depth: BotDepth }

/** The longest model name a definition, a pick or a method takes. */
export const MAX_BOT_MODEL_CHARS = 200

/** The kinds of sign-in a pick remembers (`CredentialKind` without `unknown`). */
export type BotPickCredential = 'subscription' | 'api_key' | 'ambient'

/**
 * One activation's own choice (`set_depth` and `use_model` with `now`, an automation's model by hand): a depth, and a
 * named pick that replaces its row for that activation. `auto` changes the depth only.
 */
export type BotModelOverride =
  | { mode: 'auto'; depth: BotDepth }
  | { mode: 'named'; model: string; depth: BotDepth; instanceId?: string; effort?: string; credential?: BotPickCredential; account?: string }

/** The model of a bot made without picks (an app from before them): by usage, at normal depth. */
export const DEFAULT_BOT_MODEL: BotModelChoice = { mode: 'auto', depth: 'normal' }

/**
 * A model the owner picked for a row (#673): a provider entry, its model and a reasoning level. It runs only there: when
 * it can't, nothing runs on another model or entry (a paid API key beside a subscription included).
 */
export interface BotModelPick {
  /** The provider entry. Absent only on a pick by name from an older bot: matched across entries, as before. */
  instanceId?: string
  model: string
  /** One of the model's reasoning levels; absent is the model's default. */
  effort?: string
  /**
   * How the entry was signed in when the pick was saved, and the account it was signed in to (the gateway's salted
   * hash, never a secret). Written by the daemon, never taken from a client. A pick whose entry now signs in another way
   * (a subscription switched to an API key) or to another account (an entry removed and added again under the same
   * name) can't run: the owner picks again.
   */
  credential?: BotPickCredential
  account?: string
}

/**
 * A bot's models (#673): Talk for every chat turn, and one per work level. A bot made with picks has a pick on every
 * row. null is a row a bot from before picks has not been given yet: it runs on another picked row's model
 * (`pickSourceOf`: Medium work's, else Talk's), and only while no row is picked does Mousse choose (by usage). The simple
 * view shows Talk and Work, where Work is all three levels on one pick; Advanced shows the levels apart.
 */
export interface BotModelSlots {
  talk: BotModelPick | null
  light: BotModelPick | null
  medium: BotModelPick | null
  hard: BotModelPick | null
}
export type BotModelSlotKey = keyof BotModelSlots
export const BOT_MODEL_SLOT_KEYS: readonly BotModelSlotKey[] = ['talk', 'light', 'medium', 'hard']

/**
 * The rows as `main.slots` stores them: the four model rows, and the Images row (#1088), the model `make_image` runs on.
 * The Images row is no turn's model and is never chosen by Mousse: absent or null, the bot has no image tool. Older
 * builds ignore it (`modelSlotsProblem` skips a key it does not know) and keep it while the rows are live (`withSlots`).
 */
export type BotStoredSlots = BotModelSlots & { image?: BotModelPick | null; custom?: BotCustomSlot[] }

/**
 * A slot the owner named (`/model iosdev <model> iOS apps, Swift, Xcode`): work whose job matches its name or
 * description runs on its pick; other work runs on its level's row. Stored as `main.slots.custom` beside the rows, which
 * older builds ignore and keep (`modelSlotsProblem`, `withSlots`). `name` is lower case, never a base slot's name.
 */
export interface BotCustomSlot {
  name: string
  pick: BotModelPick
  /** Plain text, one line: what work it is for. */
  description?: string
}

/** The slot names the owner can't give a custom slot: the rows, Work (all three levels) and Images. */
export const BOT_BASE_SLOT_NAMES = ['talk', 'work', 'light', 'medium', 'hard', 'images', 'image'] as const
/** A custom slot's name: a letter, then letters, digits, `-` or `_`; at most 24 characters, lower case. */
export const BOT_CUSTOM_SLOT_NAME = /^[a-z][a-z0-9_-]{0,23}$/
/** The most custom slots a bot keeps: a ceiling no owner reaches, there only to stop a runaway. */
export const MAX_BOT_CUSTOM_SLOTS = 1000
/** The longest custom slot description. */
export const MAX_BOT_CUSTOM_SLOT_DESCRIPTION = 200

/** At most this many images a bot makes in a day (the owner's local day), counted by the service (#1088). */
export const BOT_IMAGES_PER_DAY = 20
/** At most this many images one activation (a chat turn with its continuations, or one piece of work) makes. */
export const BOT_IMAGES_PER_TURN = 4
/** The largest image file a bot saves; a bigger one is refused and nothing is saved. */
export const MAX_BOT_IMAGE_BYTES = 8 * 1024 * 1024
/** The longest description `make_image` sends. */
export const MAX_BOT_IMAGE_PROMPT_CHARS = 4000

/** The thread a bot works in: who it is (an agent definition or plain instructions) and what it runs on. */
export interface BotThreadSpec {
  key: string
  title: string
  agent: { definitionId: string; pinRevision: string } | { instructions: string }
  /** Replaces format 1's fixed `selection`. Mirrors the rows while `slots` is written (`withSlots`, `mirrorOf`). */
  model: BotModelChoice
  /**
   * The rows by hand (#673), written whenever a row holds a pick on an entry. Older builds ignore it and run on `model`;
   * once one rewrites `model`, the rows no longer match it and are dropped (`slotsOf`). Rows this build does not know
   * are kept as they are. `image` is the Images row (#1088).
   */
  slots?: BotStoredSlots
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
  /** The bot's own working instructions; starts as the description, and the owner's prompt edit in About sets both. */
  role: string
  /**
   * The description and role from before the owner first edited the prompt in About: Reset to default puts them back.
   * Absent: never edited, or reset since.
   */
  promptDefault?: { description: string; role: string }
  /** When the owner last edited or reset the prompt in About (ISO): replies written before it may follow older words. */
  promptChangedAt?: string
  main: BotThreadSpec
  /** Context threads it consults (6c-2); at most `MAX_BOT_CONTEXT_THREADS`. */
  context: BotThreadSpec[]
  permissions: BotManifest
  /** Manual activation always. Schedules live in `bots.db` (`bot_schedules`), not on the definition. */
  triggers: { manual: true }
}

/**
 * A format-1 thread: a fixed model selection. Read only to upgrade old files.
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
 * upgrade old files (Bot Phase 1 §5.2).
 */
export interface BotDefinitionV1 {
  id: string
  /** Content hash of the published revision (absent on a draft). */
  revision?: string
  name: string
  role: string
  main: BotThreadSpecV1
  /** Context threads it consults (6c-2); at most `MAX_BOT_CONTEXT_THREADS`. */
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

/** Most schedules one bot may have: a ceiling no owner reaches, there only to stop a bot that adds them in a loop. */
export const MAX_BOT_SCHEDULES = 1000

/**
 * What started an activation: the Bots tab or a schedule occurrence. Activations saved by older
 * builds may carry other kinds (the removed Channels feature); they are read like these, by `input`.
 */
/**
 * Where the owner wrote from in a chat turn ("use your threads"): `limit`, the narrowest permission limit of another
 * device whose message started or continued the turn (a phone or computer held below Full access). What the bot starts
 * or messages in that turn is held to it. Absent: the owner wrote in this computer's own window. Older builds ignore it.
 */
export interface BotOwnerTurn {
  limit?: PermissionMode
  /**
   * The other device the message came from (its Net node id). A chat activation it queued that has not started is not
   * delivered once that device can no longer reach the bot (`docs/bots.md`, Which devices reach a bot). Older builds
   * ignore it.
   */
  node?: string
}

export type BotActivationTrigger =
  /**
   * `fromBot`: the turn was started by a message from another of the owner's bots (`bot_send`), never by the owner: who
   * sent it and which turn in a row without the owner it is. `fast`: a notice that starts without waiting for others to
   * settle (a thread the bot started waits on it, `NOTICE_SETTLE_MS`). `threadsReadOnly`: a held call's result
   * (`action_result`) whose call a turn held that could only read the owner's threads: its own turn reads them only too.
   */
  | { kind: 'manual'; input: string; owner?: BotOwnerTurn; fromBot?: BotMessageSender; fast?: true; threadsReadOnly?: 'not_owner' }
  | { kind: 'schedule'; input: string; scheduleId: string; occurrenceAt: string; missed?: ScheduledMissedRuns; removedTelling?: { tellMe: TellMe }; completed?: { why: string; name: string; tellMe?: TellMe; removed?: true } }
  /**
   * Work the chat handed off (`work_start`) or a reminder started (docs/plans/bot-always-free.md): a run beside the
   * chat, whose report answers `replyTo`, the owner's message that asked for it. `from`: the chat activation or
   * reminder that started it. `level`: how hard the bot judged it (#673); absent, the bot's standing level. `model`: the
   * model the owner asked for this work alone, as the work line names it, when it is not the bot's usual one for that
   * level; the pick itself is the activation's own (`BotActivationRow.modelOverride`). `slot`: the owner's custom slot
   * (`BotCustomSlot.name`) the bot routed this work to; it runs on that slot's pick while the slot exists, else on its
   * level's row.
   */
  | { kind: 'work'; input: string; title: string; replyTo?: string; from: string; level?: BotWorkLevel; model?: BotWorkModelName; slot?: string }

/** The model one piece of work was asked to run on, for the work line: its name, its entry's, and a reasoning level. */
export interface BotWorkModelName {
  name: string
  entry: string
  effort?: string
}

/**
 * The longest one turn of a bot's work runs before it goes on in a fresh turn of the same thread, as at its runtime's
 * step cap (`BotEngine.continueAfterTurnCap`, not counted with those). Not a limit on the work, which goes on for as
 * many windows as it needs: it keeps each turn's timer, supervisor and runtime wall time finite.
 */
export const BOT_TURN_WINDOW_MS = 5 * 60 * 60_000
/** Most context threads one bot may have: a ceiling no owner reaches, there only to stop a runaway. */
export const MAX_BOT_CONTEXT_THREADS = 1000
/**
 * Most activations one lane of a bot keeps waiting: a ceiling no real bot reaches, there only to stop a loop that queues
 * work. What waits is never dropped; a new one beyond it is refused, and its owner told (`BotEngine.refuseOverQueue`).
 */
export const MAX_QUEUED_ACTIVATIONS = 10_000
/** A slice of a turn's window: a steer or a subagent needs at least two of them left in the turn to start. */
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
 * `chat.ts`; this one stays for the engine's v1 functions, which tests use.
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
  previous_run_still_queued: 'skipped: the previous run has not started yet',
  previous_run_still_running: 'skipped: the previous run is still going',
  previous_run_waiting: 'skipped: the previous run waits for its time or event',
  dropped_queue_full: 'dropped: the bot had too much waiting',
  model_unavailable: 'skipped: the model picked for this work can\'t run; pick one in About → Runs on',
  usage_limited: 'skipped: waiting for a usage limit to reset'
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
  kind: 'tool' | 'app_tool' | 'mcp' | 'skill' | 'workspace' | 'budget' | 'full_trust'
  text: string
}

/**
 * MCP calls that run alone return to asking when these rolling limits are reached.
 * Service reads use the same limits and are refused without a held card.
 */
export const BOT_ALONE_HOURLY_CALLS = 20
export const BOT_ALONE_DAILY_CALLS = 100
