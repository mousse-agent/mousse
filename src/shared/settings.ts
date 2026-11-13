import { normalizeProfilerSettings, type ProfilerSettings } from './diagnostics/profiler'
import type { MousseIntegrationsSettings, SkillModelSettings } from './integrations'
import { isExpiryPreset, type ExpiryPreset } from './threadExpiry'
import { MOUSSE_BUILTIN_TOOL_IDS } from './integrations'
import type { ChatMode } from './types'
import type { ModelOverride } from './providerInstances'
import { getSkillIdFromMode } from './chatMode'
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, type PermissionMode } from './permissionMode'
import { generateRandomUsername } from './randomUsername'
import type { ShortcutOverrides } from './commands'
import { DEFAULT_FONT_CHOICE, normalizeFontChoice, type FontChoice } from './fontSettings'

/** Color themes only — acrylic is a separate appearance toggle. */
export type ThemeId =
  | 'system'
  | 'blacksphere-plus'
  | 'dark'
  | 'light'
  | 'solarized-dark'
  | 'github-dark'
  | 'high-contrast'

/** @deprecated Legacy theme ids persisted before acrylic was decoupled. */
export type LegacyThemeId = 'dark-acrylic' | 'light-acrylic' | 'system-acrylic'

/** Removed themes, mapped to the closest one that remains. */
export const REMOVED_THEME_IDS: Readonly<Record<string, ThemeId>> = {
  'dark-modern': 'dark',
  'one-dark': 'github-dark',
  monokai: 'dark'
}

export type ThemeScheme = 'dark' | 'light' | 'system'

export type LlmProviderId = string

export type AgentTypeId = 'mousse' | 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli'

export interface AgentModelOption {
  id: string
  label: string
  /** Optional section header when rendering a grouped model picker. */
  group?: string
}

export interface AppearanceSettings {
  theme: ThemeId
  accentColor: string
  /** Windows acrylic / translucent glass over any theme. */
  acrylic: boolean
  /** 0–100: how strong the glass effect is (opacity + blur). */
  acrylicIntensity: number
  /** Show LaTeX in chat replies and Markdown previews as formatted equations. */
  renderMath: boolean
  /** Show a streaming reply a finished paragraph (list item, heading, line of code) at a time, each fading in. */
  replyPacing: boolean
  /** Font for interface text. */
  interfaceFont: FontChoice
  /** Font for monospace text: code, diffs, the file editor and terminals. */
  codeFont: FontChoice
  /** Tint each thread in the Threads tab with its project's color. */
  threadProjectColors: boolean
  /** The title bar shows back and forward and the open thread's path (project / thread / subagent). */
  threadPathInTitleBar: boolean
  /** How fast UI motion plays. 'off' stops it; the OS reduced-motion setting also stops it. */
  animationSpeed: AnimationSpeed
  /** What a turn that changed files shows at its end. */
  turnChangedFiles: TurnChangedFilesMode
  /** How wide the transcript's text column is: 736px, 1152px, or the whole pane. */
  chatWidth: ChatWidth
  /** The chat shows blurred through a translucent composer. Off by default: the blur costs graphics memory. */
  frostedComposer: boolean
  /** Frosted composer opacity, in percent. */
  frostedComposerOpacity: number
  /** Frosted composer blur radius, in pixels. */
  frostedComposerBlur: number
  /** Frosted composer saturation multiplier (shown as "Color boost"). */
  frostedComposerSaturation: number
  /** The composer shows the context ring (how full the model's context is). Off by default. */
  contextRingInComposer: boolean
}

export type AnimationSpeed = 'off' | 'fast' | 'normal' | 'slow'

export const ANIMATION_SPEEDS: readonly AnimationSpeed[] = ['off', 'fast', 'normal', 'slow']

/** Multiplier on every UI motion duration (`--ui-motion-scale`). */
export const ANIMATION_SPEED_SCALE: Readonly<Record<AnimationSpeed, number>> = {
  off: 0,
  fast: 0.6,
  normal: 1,
  slow: 1.6
}

export function isAnimationSpeed(value: unknown): value is AnimationSpeed {
  return typeof value === 'string' && (ANIMATION_SPEEDS as readonly string[]).includes(value)
}

/** One summary line (file list collapsed), the full list expanded, or nothing. */
export type TurnChangedFilesMode = 'summary' | 'list' | 'off'

export const TURN_CHANGED_FILES_MODES: readonly TurnChangedFilesMode[] = ['summary', 'list', 'off']

export function normalizeTurnChangedFiles(value: unknown): TurnChangedFilesMode {
  return TURN_CHANGED_FILES_MODES.includes(value as TurnChangedFilesMode) ? value as TurnChangedFilesMode : 'summary'
}

/** The transcript's text column: normal (736px), wide (1152px) or the whole pane. */
export type ChatWidth = 'normal' | 'wide' | 'full'

export const CHAT_WIDTHS: readonly ChatWidth[] = ['normal', 'wide', 'full']

export function normalizeChatWidth(value: unknown): ChatWidth {
  return CHAT_WIDTHS.includes(value as ChatWidth) ? value as ChatWidth : 'normal'
}

/**
 * A moment a thread tells the person about: its agent finished, it needs them (a question or an
 * approval), or it stopped without finishing (interrupted, failed, or paused by a usage limit).
 */
export type ThreadNotificationEvent = 'completed' | 'question' | 'idle'

export const THREAD_NOTIFICATION_EVENTS: readonly ThreadNotificationEvent[] = ['completed', 'question', 'idle']

/** How Mousse tells the person: a toast in its window, the operating system's notification, a sound. */
export interface NotificationChannels {
  toast: boolean
  system: boolean
  sound: boolean
}

export interface NotificationSettings {
  /**
   * The sound for every event, from before sounds were chosen per event. Still read for an event
   * whose `sound` has not been chosen.
   */
  threadCompletionSound: boolean
  /**
   * Notify for every thread on the user's other computers. Off: only a thread this computer started or
   * sent in, or that was opened here in the last seven days, notifies.
   */
  allRemoteThreads: boolean
  /** The channels chosen for each event. A channel not chosen yet is on. */
  events?: Partial<Record<ThreadNotificationEvent, Partial<NotificationChannels>>>
  /**
   * The profiler's "High memory use" notice, at most once a day (Settings → Labs). Unset is on, but nothing shows while
   * the profiler itself is off (`experimental.profiler.enabled`).
   */
  memoryNotices?: boolean
}

/** The channels an event uses: what the person chose, and on for anything not chosen yet. */
export function threadNotificationChannels(
  settings: Partial<NotificationSettings> | undefined,
  event: ThreadNotificationEvent
): NotificationChannels {
  const chosen = settings?.events?.[event]
  return {
    toast: chosen?.toast ?? true,
    system: chosen?.system ?? true,
    sound: chosen?.sound ?? settings?.threadCompletionSound ?? true
  }
}

/**
 * A settings patch that sets only one channel of one event. The store merges it, so two quick
 * changes never overwrite each other with a stale copy.
 */
export function threadNotificationChannelPatch(
  event: ThreadNotificationEvent,
  channel: keyof NotificationChannels,
  on: boolean
): MousseSettingsUpdate {
  // DeepPartial stops at interfaces, so the nested patch is typed by hand; the store deep-merges it.
  return { notifications: { events: { [event]: { [channel]: on } } } } as unknown as MousseSettingsUpdate
}

export interface PermissionSettings {
  /** Permission mode a thread starts in and uses until it is changed. */
  defaultMode: PermissionMode
}

export function normalizePermissionSettings(raw?: Partial<PermissionSettings> | null): PermissionSettings {
  // Not chosen yet: the default. Chosen but unreadable: the strictest mode.
  return { defaultMode: raw?.defaultMode === undefined ? DEFAULT_PERMISSION_MODE : normalizePermissionMode(raw.defaultMode) }
}

/** A whole number of tokens from the minimum to the maximum below, or the model's own window. */
export type ContextCompactionTokens = number | 'model-max'

/** When a thread's prompt cache has expired: suggest compacting before the next send, or say nothing. */
export type IdleCompactionSetting = 'suggest' | 'off'

export interface ContextSettings {
  compactionEnabled: boolean
  compactionTokens: ContextCompactionTokens
  /** The composer's Full/Compact chip and the context popover's Compact now, once the cache has expired. */
  idleCompaction: IdleCompactionSetting
}

export const CONTEXT_COMPACTION_MIN_TOKENS = 32_000
export const CONTEXT_COMPACTION_MAX_TOKENS = 2_000_000

/** The sizes the compact-context menu offers; any other size in range can be typed. */
export const CONTEXT_COMPACTION_PRESETS: readonly number[] = [128_000, 256_000, 512_000, 1_000_000]

export function isContextCompactionSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= CONTEXT_COMPACTION_MIN_TOKENS && value <= CONTEXT_COMPACTION_MAX_TOKENS
}

/** A size as people write it: `300k`, `1M`, `1.5M`, or the digits when it is not a round number. */
export function formatContextCompactionSize(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1000 === 0) return `${tokens / 1000}k`
  return tokens.toLocaleString('en-US')
}

/**
 * A typed size: `300k`, `300000`, `300,000`, `0.3m`, `1M`, optionally followed by `tokens`.
 * Undefined when it is not a whole number of tokens in range.
 */
export function parseContextCompactionSize(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([km])?(?:tokens?)?$/.exec(text.toLowerCase().replace(/[\s,_]/g, ''))
  if (!match) return undefined
  const exact = Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1000 : 1)
  const tokens = Math.round(exact)
  // Whole tokens only; the rounding just absorbs float noise such as 0.3 × 1M.
  if (Math.abs(exact - tokens) > 1e-6) return undefined
  return isContextCompactionSize(tokens) ? tokens : undefined
}

/** Compact near the model's own window, as each provider's CLI does; a fixed size is opt-in. */
export const DEFAULT_CONTEXT_COMPACTION_TOKENS: ContextCompactionTokens = 'model-max'

/**
 * Marker on the stored context section: the default above has been applied once. Every install wrote
 * the previous default (128k) to disk, so a stored 128k without this marker is that old default.
 */
export const CONTEXT_COMPACTION_DEFAULT_MARKER = 'modelMaxDefault'

export function normalizeContextSettings(raw?: Partial<ContextSettings> | null): ContextSettings {
  // A size from an older build or a hand-edited file that is out of range or not whole: the default.
  const tokens: unknown = raw?.compactionTokens
  return {
    compactionEnabled: typeof raw?.compactionEnabled === 'boolean' ? raw.compactionEnabled : true,
    compactionTokens: tokens === 'model-max' || isContextCompactionSize(tokens) ? tokens : DEFAULT_CONTEXT_COMPACTION_TOKENS,
    idleCompaction: raw?.idleCompaction === 'off' ? 'off' : 'suggest'
  }
}

export function resolveContextCompactionTokens(selected: ContextCompactionTokens, modelMaxContext: number): number {
  const maximum = Number.isFinite(modelMaxContext) && modelMaxContext > 0 ? modelMaxContext : 128000
  return selected === 'model-max' ? maximum : Math.min(selected, maximum)
}

/** Room kept free under a model's window so the summary request itself fits. */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384
/** Without a smaller size, compaction starts at this share of the window. */
export const EXACT_COMPACTION_USAGE_RATIO = 0.95

/**
 * The active-context size at which a thread compacts, for a model with this window and an optional
 * chosen size. Infinity when the window is unknown. The daemon compacts at this point, and Settings
 * shows it.
 */
export function contextCompactionPoint(
  contextWindow: number,
  configuredThreshold?: number,
  reserveTokens = DEFAULT_COMPACTION_RESERVE_TOKENS
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Infinity
  const requestedReserve = Math.max(0, Math.min(reserveTokens, contextWindow - 1))
  const reserve = contextWindow > requestedReserve * 2 ? requestedReserve : 0
  const watermark = Math.floor(contextWindow * EXACT_COMPACTION_USAGE_RATIO)
  const configured = configuredThreshold && configuredThreshold > 0
    ? Math.min(configuredThreshold, contextWindow)
    : watermark
  return Math.min(watermark, configured, contextWindow - reserve)
}

/**
 * Where a thread compacts under the Compact context setting. A size compacts at `contextCompactionPoint`
 * of the model's window when it is known, else of the size itself; Auto (`model-max`) waits for a known
 * window. Undefined when compaction is off or the point is not known yet. The daemon compacts here and
 * the context popover shows it.
 */
export function settingCompactionPoint(
  context: Pick<ContextSettings, 'compactionEnabled' | 'compactionTokens'>,
  knownWindow?: number
): number | undefined {
  if (!context.compactionEnabled) return undefined
  const size = typeof context.compactionTokens === 'number' ? context.compactionTokens : knownWindow
  if (size === undefined) return undefined
  const point = contextCompactionPoint(knownWindow ?? size, size)
  return Number.isFinite(point) ? point : undefined
}

/**
 * What an agent calling the Mousse MCP server may do on threads other than its own and its
 * delegation lineage (docs/run-engine/SPEC.md §15.1): `lineage` nothing more, `read` list, search and
 * read other threads, `manage` also change them.
 */
export type AgentAccessLevel = 'lineage' | 'read' | 'manage'

export interface AgentAccessSettings {
  level: AgentAccessLevel
  /** Projects the level applies to; empty means every project. */
  projectIds: string[]
  /** `manage` only: an agent may answer a pending approval on another thread. */
  answerApprovals: boolean
  /**
   * "Let agents start subagents on your other devices". Off, the default, refuses every remote subagent
   * whatever `computers` lists; the list is kept, so turning it back on restores the same computers.
   */
  remoteSubagents: boolean
  /**
   * With `remoteSubagents` on, the user's other computers an agent may start subagents on (their Net node
   * ids). Empty means none: a remote subagent runs under that computer's provider accounts, so each one is
   * chosen here.
   */
  computers: string[]
  /**
   * The stored project list was present but could not be read. Ordinary agents fall back to `lineage` (which reaches no
   * other thread); a bot with "use your threads", which the level does not hold, reaches no project at all. Kept on
   * every later write, so a save of something else never turns the empty list into "every project"; cleared (written
   * as false, which reads as absent) when the owner chooses other projects (`SettingsStore.set`). Only true counts.
   */
  projectsUnreadable?: boolean
}

const AGENT_ACCESS_LEVELS: readonly AgentAccessLevel[] = ['lineage', 'read', 'manage']

export function isAgentAccessLevel(value: unknown): value is AgentAccessLevel {
  return AGENT_ACCESS_LEVELS.includes(value as AgentAccessLevel)
}

/** The narrower of two levels; an absent level does not narrow. */
export function narrowAgentAccess(...levels: Array<AgentAccessLevel | null | undefined>): AgentAccessLevel | undefined {
  let narrowest: AgentAccessLevel | undefined
  for (const level of levels) {
    if (!isAgentAccessLevel(level)) continue
    if (!narrowest || AGENT_ACCESS_LEVELS.indexOf(level) < AGENT_ACCESS_LEVELS.indexOf(narrowest)) narrowest = level
  }
  return narrowest
}

/**
 * The setting as the daemon reads it. An absent project list means every project, but a list that is
 * present and malformed (not an array, or an entry that is not a non-empty string) is a narrowing
 * that cannot be read, so it fails closed: the level becomes `lineage`, which reaches no other thread,
 * rather than widening to every project.
 */
export function normalizeAgentAccessSettings(raw?: Partial<AgentAccessSettings> | null): AgentAccessSettings {
  const ids: unknown = raw?.projectIds
  const malformed =
    ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0))
  // A computer list that cannot be read allows none, whatever else the setting says.
  const nodes: unknown = raw?.computers
  const computers = Array.isArray(nodes) && nodes.every((node) => typeof node === 'string' && node.length > 0) ? [...new Set(nodes as string[])] : []
  const remoteSubagents = raw?.remoteSubagents === true
  if (malformed) return { level: 'lineage', projectIds: [], answerApprovals: false, remoteSubagents, computers, projectsUnreadable: true }
  const level = isAgentAccessLevel(raw?.level) ? raw.level : 'lineage'
  return {
    level,
    projectIds: Array.isArray(ids) ? [...new Set(ids as string[])] : [],
    remoteSubagents,
    computers,
    // Once unreadable, still unreadable for bots until the owner chooses the projects again.
    ...(raw?.projectsUnreadable === true ? { projectsUnreadable: true as const } : {}),
    // Answering approvals is part of Manage. Below it the switch reads, and is saved, as off, whoever wrote the
    // level (the Settings screen, a partial update from another client, a hand edit), so raising the level
    // again never brings the permission back by itself.
    answerApprovals: level === 'manage' && raw?.answerApprovals === true
  }
}

/**
 * How runs behave after a provider's usage limit. With `resumeAfterUsageLimit` a paused run continues
 * by itself when the limit resets, at most `usageLimitPauseCap` times in a row on one thread; without
 * it the pause waits for Resume now. Read when a run pauses, never afterwards: turning it on does not
 * arm runs that are already paused. Where a new thread in a project starts (a new worktree or the
 * project's folder) is the project's own remembered choice (`Project.newThread`); `newThreadWorktree` is where a
 * project with no choice starts. It has no control: it carries the removed "Start new threads in a worktree" setting.
 */
export interface RunSettings {
  resumeAfterUsageLimit: boolean
  usageLimitPauseCap: number
  newThreadWorktree: boolean
  /** When a new private thread deletes itself (`Thread.expiresAt`); `never` keeps it. Each new chat can change it. */
  privateThreadExpiry: ExpiryPreset | 'never'
  /**
   * How a held steer is released, per provider instance (docs/design/steer-and-interruptions.md §2.3.2). `strict`: on
   * a provider that reports a tool only when it starts, a steer held for a tool waits for the provider's own turn to
   * end, or Send now. Absent or `best_effort`: it goes in shortly after the tool. No UI sets it.
   */
  steerRelease?: Record<string, SteerRelease>
}

export type SteerRelease = 'best_effort' | 'strict'

export const DEFAULT_USAGE_LIMIT_PAUSE_CAP = 3
export const MAX_USAGE_LIMIT_PAUSE_CAP = 10

export function normalizeRunSettings(raw?: Partial<RunSettings> | null): RunSettings {
  const cap = raw?.usageLimitPauseCap
  const release = raw?.steerRelease && typeof raw.steerRelease === 'object'
    ? Object.entries(raw.steerRelease).filter((entry): entry is [string, SteerRelease] => entry[1] === 'strict' || entry[1] === 'best_effort')
    : []
  return {
    ...(release.length ? { steerRelease: Object.fromEntries(release) } : {}),
    resumeAfterUsageLimit: raw?.resumeAfterUsageLimit === true,
    usageLimitPauseCap:
      typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= MAX_USAGE_LIMIT_PAUSE_CAP
        ? cap
        : DEFAULT_USAGE_LIMIT_PAUSE_CAP,
    newThreadWorktree: raw?.newThreadWorktree !== false,
    privateThreadExpiry: isExpiryPreset(raw?.privateThreadExpiry) ? raw.privateThreadExpiry : 'never'
  }
}

/**
 * Features that are still being tried out, each off until turned on.
 *
 * `subagentWorktrees`: Mousse gives every subagent it starts a worktree of its own, made when the subagent starts from the
 * parent's current HEAD, on a `mousse/` branch, whatever the main agent asked for. Off: the main agent chooses, as it
 * always has (`workspace` isolated or shared). Either way a subagent's work is reported, never merged.
 */
export interface ExperimentalSettings {
  subagentWorktrees: boolean
  /** The profiler (Settings → Labs). */
  profiler: ProfilerSettings
}

export function normalizeExperimentalSettings(raw?: Partial<ExperimentalSettings> | null): ExperimentalSettings {
  return { subagentWorktrees: raw?.subagentWorktrees === true, profiler: normalizeProfilerSettings(raw?.profiler) }
}

/**
 * What bots may do on this computer (Settings → Agents → What bots may do here): a ceiling over every bot's grant, kept
 * once for the whole installation (the top-level `bots` key of the installation's `mousse.conf`), so every profile's
 * bots are held to it and every profile's Settings shows it. It is never sent to or set from another computer
 * (`settings.*` methods are not routed). A switch that is off gives no bot that permission here, whatever its grant
 * holds, and no bot can ask for it.
 */
export interface BotComputerLimit {
  /** "Run commands" (`shell`). */
  shell: boolean
  /** "Use files on this computer": files and folders outside the bot's own files folder and scratch. */
  files: boolean
  /** "Use the browser" (the bot's own browser). */
  browser: boolean
  /**
   * "Use your threads": a bot may read the owner's threads, start threads (which run in Full access) and message them.
   * Off, no bot here holds it whatever its grant says, which is what keeps a computer where bots must not run commands
   * that way: a thread a bot starts runs commands without asking.
   */
  threads: boolean
}

export interface BotSettings {
  here: BotComputerLimit
  /**
   * The stored setting could not be read (the settings file was unreadable and replaced, or the setting is malformed):
   * every switch reads off until the owner sets them again. Settings says so beside the switches.
   */
  unreadable?: true
}

/** Every switch of What bots may do here, in the order Settings shows them: what a stored value must hold, and the only keys a write may name. */
export const BOT_SWITCH_KEYS: ReadonlyArray<keyof BotComputerLimit> = ['shell', 'files', 'browser', 'threads']

/**
 * Switches added after the setting was first saved: a stored value without one of them was written before it existed,
 * so it reads as on (its default), never as unreadable. Present and not a boolean still fails closed.
 */
const BOT_SWITCHES_ADDED_LATER: ReadonlySet<keyof BotComputerLimit> = new Set(['threads'])

/** The Use your threads switch's tooltip: what a bot can do through a thread, whatever the other switches say. */
export const BOTS_THREADS_TIP =
  'A thread a bot starts runs with full access, so it can run commands and change files even with Run commands and Use files off. Switch this off to keep bots from that here.'

/** Settings' one line beside the switches while the stored setting can't be read (`BotSettings.unreadable`). */
export const BOTS_UNREADABLE_LINE = "All off: the saved setting couldn't be read. Switch on what bots may use."

/**
 * The Run commands switch's tooltip: a command is not held to Use files everywhere (docs/bots.md, What bots may do
 * here), so the switch says so.
 */
export const BOTS_SHELL_TIP =
  'Commands can read files on this computer even with Use files off. Only Claude Code’s sandbox on Linux and Codex on Linux and macOS hold them to the bot’s own folders and the system’s (/usr, /etc, and /tmp with Claude Code).'

/** Why a write of What bots may do here was refused: it names one or more of the switches, each on or off. */
export const BOTS_HERE_SHAPE = `What bots may do here takes { here: { … } } naming one or more of ${BOT_SWITCH_KEYS.join(', ')}, each true or false. Nothing was changed.`

/**
 * The switches a settings update changes for What bots may do here: `{ here: { … } }` naming one or more known switches,
 * each a boolean, and nothing else, or undefined (refused). Each window and the CLI send only the switch they change, and
 * the service puts it over the switches it holds (`MousseConfigStore.setBotsHere`), so a window whose copy is older
 * never turns back a switch another one changed. A switch added later is written the same way.
 */
export function botSettingsWrite(value: unknown): Partial<BotComputerLimit> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'here') return undefined
  const here = (value as { here: unknown }).here
  if (!here || typeof here !== 'object' || Array.isArray(here)) return undefined
  const named = Object.entries(here as Record<string, unknown>)
  if (!named.length || !named.every(([key, on]) => (BOT_SWITCH_KEYS as readonly string[]).includes(key) && typeof on === 'boolean')) return undefined
  return Object.fromEntries(named) as Partial<BotComputerLimit>
}

/**
 * The switches, when `value` is an object holding each as a boolean; undefined otherwise. A switch added after the
 * setting was first saved (`threads`) reads as on when it is missing, since the value was written before it existed.
 */
export function botComputerLimitOf(value: unknown): BotComputerLimit | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const here = value as Record<string, unknown>
  const read = (key: keyof BotComputerLimit): boolean | undefined =>
    typeof here[key] === 'boolean' ? here[key] as boolean : here[key] === undefined && BOT_SWITCHES_ADDED_LATER.has(key) ? true : undefined
  const switches = Object.fromEntries(BOT_SWITCH_KEYS.map((key) => [key, read(key)])) as Record<keyof BotComputerLimit, boolean | undefined>
  if (BOT_SWITCH_KEYS.some((key) => switches[key] === undefined)) return undefined
  return switches as BotComputerLimit
}

/**
 * The stored setting (the raw top-level `bots` value) as the daemon reads it. Missing (an install that never set it):
 * every switch on, so existing installs keep what they had. Present but not `{ here: { shell, files, browser, threads } }`
 * with booleans (`threads` may be missing: it was added later), or marked unreadable (written after an unreadable settings
 * file was replaced): every switch off. A ceiling that can't be read fails closed.
 */
export function normalizeBotSettings(raw: unknown): BotSettings {
  if (raw === undefined) return { here: { shell: true, files: true, browser: true, threads: true } }
  const shut: BotSettings = { here: { shell: false, files: false, browser: false, threads: false }, unreadable: true }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return shut
  const stored = raw as Record<string, unknown>
  if (stored.unreadable !== undefined) return shut
  const here = botComputerLimitOf(stored.here)
  return here ? { here } : shut
}

/** A worktree folder the person chose, and the id written in its marker (`.mousse-worktrees.json`) when it was chosen. */
export interface WorktreeFolderEntry {
  path: string
  id: string
}

/**
 * Where new worktrees go (Settings → Storage → Worktree folder). `worktreeFolder` null is Mousse's own folder
 * (`<Mousse home>/repositories/<repository>/worktrees`). `previousWorktreeFolders` are the folders chosen before that may
 * still hold worktrees: their worktrees stay where they are, and stay Mousse's; one is forgotten once nothing of Mousse's
 * is in it and no record names a path in it. Only the daemon's own Storage action writes either
 * (`storage.setWorktreeFolder`), after checking the folder.
 */
export interface StorageSettings {
  worktreeFolder: WorktreeFolderEntry | null
  previousWorktreeFolders: WorktreeFolderEntry[]
}

/** A stored folder entry: a full path and a 32-character id; anything else is dropped. */
function worktreeFolderEntry(value: unknown): WorktreeFolderEntry | undefined {
  const entry = value as Partial<WorktreeFolderEntry> | null | undefined
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.id !== 'string') return undefined
  const path = entry.path
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  if (!absolute || path.includes('\0') || !/^[a-f0-9]{32}$/.test(entry.id)) return undefined
  return { path, id: entry.id }
}

export function normalizeStorageSettings(raw?: Partial<StorageSettings> | null): StorageSettings {
  const current = worktreeFolderEntry(raw?.worktreeFolder) ?? null
  const previous: WorktreeFolderEntry[] = []
  for (const value of Array.isArray(raw?.previousWorktreeFolders) ? raw!.previousWorktreeFolders : []) {
    const entry = worktreeFolderEntry(value)
    if (entry && !(current && current.path === entry.path) && !previous.some((other) => other.path === entry.path)) previous.push(entry)
  }
  return { worktreeFolder: current, previousWorktreeFolders: previous }
}

export interface MousseSettings {
  profile: {
    username: string
  }
  appearance: AppearanceSettings
  notifications: NotificationSettings
  /** Keyboard shortcut overrides by command id; only changes are stored, `null` unbinds. */
  shortcuts: ShortcutOverrides
  permissions: PermissionSettings
  context: ContextSettings
  agentAccess: AgentAccessSettings
  runs: RunSettings
  experimental: ExperimentalSettings
  storage: StorageSettings
  provider: {
    llmProvider: LlmProviderId
    /** The model as its agent lists it; the reasoning level is `effort` (absent = the model's default). */
    model: string
    effort?: string
    /** The model's name when it was chosen, for the CLI and devices that have no listing of it. */
    name?: string
    /**
     * Provider instance of the default selection. Authoritative when set; a later update that names
     * only `llmProvider` clears it (see `SettingsStore.set`).
     */
    instanceId?: string
    /** Provider instances (`providers.instances` in the profile config); owned by the daemon. */
    instances?: Record<string, unknown>
  }
  /** Lightweight model used to name chats. Blank values use the best connected default. */
  title: {
    llmProvider: LlmProviderId
    model: string
    effort?: string
    /** Provider instance of the title model; absent on records from before instances (legacy mapping). */
    instanceId?: string
  }
  /**
   * The model bots run on when a bot's own choice is automatic (Bot Phase 1 §5.6). Blank values are
   * Automatic: each bot picks by its depth. The bot's depth sets the reasoning level, so none is kept.
   */
  botModel: {
    llmProvider: LlmProviderId
    model: string
    instanceId?: string
  }
  /** What bots may do on this computer (`BotComputerLimit`). */
  bots: BotSettings
  agents: {
    enabled: Record<AgentTypeId, boolean>
    /** Default provider for in-app Mousse subagents; blank inherits the main model. */
    llmProvider: Record<AgentTypeId, string>
    model: Record<AgentTypeId, string>
    headless: Record<AgentTypeId, boolean>
  }
  integrations: MousseIntegrationsSettings
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[]
    ? T[K]
    : T[K] extends Record<string, unknown>
      ? DeepPartial<T[K]>
      : T[K]
}

export type MousseSettingsUpdate = DeepPartial<MousseSettings>

export interface ThemeOption {
  id: ThemeId
  label: string
  scheme: ThemeScheme
}

export interface AccentColorOption {
  id: string
  label: string
  value: string
}

export interface LlmModelOption {
  id: string
  label: string
  /** Supported reasoning/effort levels from the provider (excludes "off"). */
  efforts?: string[]
  /** The level a turn runs at when none is chosen, when the agent reports it. */
  defaultEffort?: string
  /** What the agent says each level does, by level. */
  effortDescriptions?: Record<string, string>
  /** `false`: thinking cannot be turned off, so the menu offers no "Off". */
  thinkingOff?: false
  /** Effective endpoint speed, including provider defaults. */
  speed?: 'fast' | 'slow'
  /** `false`: this model cannot run a single request (chat titles) even though its provider can. */
  oneShot?: false
  /** The model takes images, when its catalogue says so. */
  images?: true
  /** Context window in tokens, when its catalogue says so. */
  contextWindow?: number
  /**
   * An older model: one the agent does not list itself, offered because Mousse's model catalog has
   * it and a check showed it runs. The picker folds it behind "Show more".
   */
  older?: true
}

export interface LlmProviderOption {
  id: LlmProviderId
  /** Provider instance serving these models; select with `{ instanceId, model }`. */
  instanceId?: string
  label: string
  models: LlmModelOption[]
  /**
   * The instance runs a single request with no tools (chat titles, pull request drafts, commit
   * messages). Set by the gateway on every listing; runtimes that only run turns are `false`.
   */
  oneShot?: boolean
}

/** The title model choices: instances that run one-shots, without the models that cannot. */
export function oneShotProviderOptions(providers: readonly LlmProviderOption[]): LlmProviderOption[] {
  return providers
    .filter((provider) => provider.oneShot === true)
    .map((provider) => ({ ...provider, models: provider.models.filter((model) => model.oneShot !== false) }))
    .filter((provider) => provider.models.length > 0)
}

export interface AgentTypeOption {
  id: AgentTypeId
  label: string
  models: AgentModelOption[]
}

export interface SettingsOptions {
  themes: ThemeOption[]
  accentColors: AccentColorOption[]
  llmProviders: LlmProviderOption[]
  agentTypes: AgentTypeOption[]
  /**
   * The bot model choices (`botModel`): the listing narrowed to the ready instances and models that
   * can hold a bot. Absent from a daemon without bots.
   */
  botProviders?: LlmProviderOption[]
}

/**
 * The bot model choices: `providers` narrowed to the models `holds` names (instance and model, as the
 * bot candidates list them), without instances left with none. The reasoning level is the bot's
 * depth, so no level is offered.
 */
export function botProviderOptions(providers: readonly LlmProviderOption[], holds: ReadonlyArray<{ instanceId: string; model: string }>): LlmProviderOption[] {
  const held = new Set(holds.map((entry) => `${entry.instanceId}\u0000${entry.model}`))
  return providers
    .filter((provider) => provider.instanceId !== undefined)
    .map((provider) => ({
      ...provider,
      models: provider.models
        .filter((model) => held.has(`${provider.instanceId}\u0000${model.id}`))
        .map(({ efforts: _efforts, defaultEffort: _defaultEffort, effortDescriptions: _descriptions, ...model }) => model)
    }))
    .filter((provider) => provider.models.length > 0)
}

/**
 * A bot's Runs on choices for the app's model picker (#673): `providers` narrowed to the models `picks` names (each
 * entry's models that can hold a bot), with the reasoning levels the bot may pick and no "Off", which a bot never runs at.
 */
export function botPickProviderOptions(providers: readonly LlmProviderOption[], picks: ReadonlyArray<{ instanceId: string; model: string; efforts: readonly string[] }>): LlmProviderOption[] {
  const held = new Map(picks.map((entry) => [`${entry.instanceId}\u0000${entry.model}`, entry.efforts]))
  return providers
    .filter((provider) => provider.instanceId !== undefined)
    .map((provider) => ({
      ...provider,
      models: provider.models.flatMap((model) => {
        const efforts = held.get(`${provider.instanceId}\u0000${model.id}`)
        if (!efforts) return []
        const levels = (model.efforts ?? []).filter((effort) => efforts.includes(effort))
        const { efforts: _efforts, defaultEffort, effortDescriptions: _descriptions, thinkingOff: _off, ...rest } = model
        return [{
          ...rest,
          ...(levels.length ? { efforts: levels } : {}),
          ...(defaultEffort && levels.includes(defaultEffort) ? { defaultEffort } : {}),
          ...(model.effortDescriptions && levels.length ? { effortDescriptions: model.effortDescriptions } : {}),
          thinkingOff: false as const
        }]
      })
    }))
    .filter((provider) => provider.models.length > 0)
}

export const ACRYLIC_INTENSITY_MIN = 0
export const ACRYLIC_INTENSITY_MAX = 100
export const ACRYLIC_INTENSITY_DEFAULT = 55

export type FrostedComposerSlider = 'frostedComposerOpacity' | 'frostedComposerBlur' | 'frostedComposerSaturation'

/** Slider bounds and defaults for the frosted composer. */
export const FROSTED_COMPOSER_RANGES: Readonly<Record<FrostedComposerSlider, { min: number; max: number; step: number; default: number }>> = {
  frostedComposerOpacity: { min: 20, max: 95, step: 1, default: 60 },
  frostedComposerBlur: { min: 0, max: 40, step: 1, default: 16 },
  frostedComposerSaturation: { min: 1, max: 1.6, step: 0.02, default: 1.12 }
}

/** Clamps a frosted composer slider value to its range and step; anything unreadable is the default. */
export function clampFrostedComposer(key: FrostedComposerSlider, value: unknown): number {
  const range = FROSTED_COMPOSER_RANGES[key]
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return range.default
  const stepped = range.min + Math.round((n - range.min) / range.step) * range.step
  return Math.round(Math.max(range.min, Math.min(range.max, stepped)) * 100) / 100
}

export const ACCENT_COLORS: AccentColorOption[] = [
  { id: 'purple', label: 'Purple', value: '#a785c7' },
  { id: 'violet', label: 'Violet', value: '#8a66b6' },
  { id: 'indigo', label: 'Indigo', value: '#6b5b95' },
  { id: 'blue', label: 'Blue', value: '#5b8def' },
  { id: 'cyan', label: 'Cyan', value: '#4ecdc4' },
  { id: 'teal', label: 'Teal', value: '#3d9970' },
  { id: 'green', label: 'Green', value: '#7ec99a' },
  { id: 'amber', label: 'Amber', value: '#d4b06a' },
  { id: 'rose', label: 'Rose', value: '#e07a8a' },
  { id: 'coral', label: 'Coral', value: '#e8927c' },
  { id: 'pink', label: 'Pink', value: '#d486b8' },
  { id: 'slate', label: 'Slate', value: '#8892a6' }
]

/** Offline fallbacks only. Settings and spawn pickers prefer live provider catalogs. */
export const AGENT_MODELS: Record<AgentTypeId, AgentModelOption[]> = {
  mousse: [],
  'claude-code': [
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'haiku', label: 'Claude Haiku' }
  ],
  codex: [
    { id: 'o3', label: 'o3' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }
  ],
  opencode: [{ id: 'opencode/big-pickle', label: 'Big Pickle (free)', group: 'OpenCode Zen' }],
  'cursor-agents-cli': [{ id: 'composer-2.5', label: 'Composer 2.5' }]
}

export const AGENT_TYPES: AgentTypeOption[] = [
  { id: 'mousse', label: 'Mousse', models: AGENT_MODELS.mousse },
  { id: 'claude-code', label: 'Claude Code', models: AGENT_MODELS['claude-code'] },
  { id: 'codex', label: 'Codex', models: AGENT_MODELS.codex },
  { id: 'opencode', label: 'OpenCode', models: AGENT_MODELS.opencode },
  { id: 'cursor-agents-cli', label: 'Cursor Agents CLI', models: AGENT_MODELS['cursor-agents-cli'] }
]

export interface NamedModelOption {
  id: string
  label: string
}

function namedModels(catalogs: LlmProviderOption[], providerId: string): NamedModelOption[] {
  return catalogs.find((provider) => provider.id === providerId)?.models ?? []
}

function withFallback(live: AgentModelOption[], fallback: AgentModelOption[]): AgentModelOption[] {
  return live.length > 0 ? live : fallback
}

/**
 * Agent CLI pickers reuse the same live catalogs as the Models settings page
 * (pi-ai / Cursor / OpenAI-compatible refresh). No separate hardcoded lists.
 */
export function buildAgentTypesFromCatalogs(catalogs: LlmProviderOption[]): AgentTypeOption[] {
  const opencode = buildOpencodeAgentModels(namedModels(catalogs, 'opencode'), namedModels(catalogs, 'opencode-go'))
  const asAgentModels = (providerId: string): AgentModelOption[] =>
    namedModels(catalogs, providerId).map((model) => ({
      id: model.id,
      label: model.label
    }))

  return AGENT_TYPES.map((agent) => {
    switch (agent.id) {
      case 'opencode':
        return { ...agent, models: withFallback(opencode, agent.models) }
      case 'claude-code':
        return { ...agent, models: withFallback(asAgentModels('anthropic'), agent.models) }
      case 'codex':
        return { ...agent, models: withFallback(asAgentModels('openai'), agent.models) }
      case 'cursor-agents-cli':
        return { ...agent, models: withFallback(asAgentModels('cursor'), agent.models) }
      default:
        return agent
    }
  })
}

/**
 * Build the OpenCode agent's model options from the pi connector catalogs.
 * The connector exposes OpenCode Zen (and OpenCode Go) models without the
 * `opencode/` prefix the CLI expects, so ids are re-prefixed and grouped by
 * their gateway provider. Rebuilt on every launch from the live catalogs.
 */
export function buildOpencodeAgentModels(
  opencodeModels: NamedModelOption[],
  opencodeGoModels: NamedModelOption[]
): AgentModelOption[] {
  const entries: AgentModelOption[] = opencodeModels.map((model) => ({
    id: `opencode/${model.id}`,
    label: model.label,
    group: 'OpenCode Zen'
  }))
  for (const model of opencodeGoModels) {
    entries.push({
      id: `opencode-go/${model.id}`,
      label: model.label,
      group: 'OpenCode Go'
    })
  }
  return entries
}

/** Split agent model options into render groups ('' = ungrouped) preserving first-seen order. */
export function groupAgentModelOptions(
  models: AgentModelOption[]
): { group: string; models: AgentModelOption[] }[] {
  const buckets = new Map<string, { group: string; models: AgentModelOption[] }>()
  for (const model of models) {
    const key = model.group ?? ''
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { group: key, models: [] }
      buckets.set(key, bucket)
    }
    bucket.models.push(model)
  }
  return [...buckets.values()]
}

const DEFAULT_AGENT_INTEGRATION_ENABLEMENT: Record<AgentTypeId, boolean> = {
  mousse: true,
  'claude-code': true,
  codex: true,
  opencode: true,
  'cursor-agents-cli': true
}

const DEFAULT_AGENT_HEADLESS: Record<AgentTypeId, boolean> = {
  mousse: false,
  'claude-code': true,
  codex: true,
  opencode: true,
  'cursor-agents-cli': true
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'system', label: 'System', scheme: 'system' },
  { id: 'blacksphere-plus', label: 'Mousse Dark', scheme: 'dark' },
  { id: 'dark', label: 'Dark', scheme: 'dark' },
  { id: 'solarized-dark', label: 'Solarized Dark', scheme: 'dark' },
  { id: 'github-dark', label: 'GitHub Dark', scheme: 'dark' },
  { id: 'high-contrast', label: 'High Contrast', scheme: 'dark' },
  { id: 'light', label: 'Light', scheme: 'light' }
]

const VALID_THEME_IDS = new Set<string>(THEME_OPTIONS.map((t) => t.id))

export function clampAcrylicIntensity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ACRYLIC_INTENSITY_DEFAULT
  return Math.max(ACRYLIC_INTENSITY_MIN, Math.min(ACRYLIC_INTENSITY_MAX, Math.round(n)))
}

/** Map intensity dial (0–100) to glass alphas and blur. Higher = more translucent. */
export function glassTokensFromIntensity(intensity: number): {
  alphaBase: number
  alphaStrong: number
  alphaSoft: number
  blurPx: number
} {
  const t = clampAcrylicIntensity(intensity) / 100
  return {
    alphaBase: roundAlpha(0.92 - t * 0.48),
    alphaStrong: roundAlpha(0.95 - t * 0.42),
    alphaSoft: roundAlpha(0.88 - t * 0.48),
    blurPx: Math.round(8 + t * 32)
  }
}

function roundAlpha(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function getDefaultSettings(): MousseSettings {
  return {
    profile: {
      username: generateRandomUsername()
    },
    appearance: {
      theme: 'blacksphere-plus',
      accentColor: '#a785c7',
      acrylic: false,
      acrylicIntensity: ACRYLIC_INTENSITY_DEFAULT,
      renderMath: true,
      replyPacing: true,
      interfaceFont: { ...DEFAULT_FONT_CHOICE },
      codeFont: { ...DEFAULT_FONT_CHOICE },
      threadProjectColors: true,
      threadPathInTitleBar: true,
      animationSpeed: 'normal',
      turnChangedFiles: 'summary',
      chatWidth: 'normal',
      frostedComposer: false,
      frostedComposerOpacity: FROSTED_COMPOSER_RANGES.frostedComposerOpacity.default,
      frostedComposerBlur: FROSTED_COMPOSER_RANGES.frostedComposerBlur.default,
      frostedComposerSaturation: FROSTED_COMPOSER_RANGES.frostedComposerSaturation.default,
      contextRingInComposer: false
    },
    notifications: {
      threadCompletionSound: true,
      allRemoteThreads: false
    },
    shortcuts: {},
    permissions: normalizePermissionSettings(),
    context: normalizeContextSettings(),
    agentAccess: normalizeAgentAccessSettings(),
    runs: normalizeRunSettings(),
    experimental: normalizeExperimentalSettings(),
    storage: normalizeStorageSettings(),
    provider: {
      llmProvider: '',
      model: ''
    },
    title: {
      llmProvider: '',
      model: ''
    },
    botModel: {
      llmProvider: '',
      model: ''
    },
    bots: normalizeBotSettings(undefined),
    agents: {
      enabled: {
        mousse: true,
        'claude-code': true,
        codex: true,
        opencode: true,
        'cursor-agents-cli': false
      },
      llmProvider: {
        mousse: '',
        'claude-code': '',
        codex: '',
        opencode: '',
        'cursor-agents-cli': ''
      },
      model: {
        mousse: '',
        'claude-code': '',
        codex: '',
        opencode: '',
        'cursor-agents-cli': ''
      },
      headless: { ...DEFAULT_AGENT_HEADLESS }
    },
    integrations: {
      tools: {
        enabled: true,
        enabledTools: [...MOUSSE_BUILTIN_TOOL_IDS]
      },
      mcp: {
        enabled: true,
        enabledServers: [],
        relay: { runtimes: {} },
        enableForMainAgent: true,
        enableForAgents: { ...DEFAULT_AGENT_INTEGRATION_ENABLEMENT }
      },
      skills: {
        enabled: true,
        enabledSkills: [],
        enableForMainAgent: true,
        enableForAgents: { ...DEFAULT_AGENT_INTEGRATION_ENABLEMENT },
        model: {}
      }
    }
  }
}

/**
 * Normalize appearance from disk / partial updates.
 * Migrates legacy theme ids (`*-acrylic`) into theme + acrylic boolean.
 */
export function normalizeAppearance(
  raw: Partial<AppearanceSettings> & { theme?: string } | null | undefined
): AppearanceSettings {
  const defaults = getDefaultSettings().appearance
  if (!raw || typeof raw !== 'object') {
    return { ...defaults }
  }

  let theme: string = typeof raw.theme === 'string' ? raw.theme : defaults.theme
  let acrylic = typeof raw.acrylic === 'boolean' ? raw.acrylic : undefined

  if (theme === 'dark-acrylic') {
    theme = 'dark'
    if (acrylic === undefined) acrylic = true
  } else if (theme === 'light-acrylic') {
    theme = 'light'
    if (acrylic === undefined) acrylic = true
  } else if (theme === 'system-acrylic') {
    theme = 'system'
    if (acrylic === undefined) acrylic = true
  }

  theme = REMOVED_THEME_IDS[theme] ?? theme

  if (!VALID_THEME_IDS.has(theme)) {
    theme = defaults.theme
  }

  if (acrylic === undefined) {
    acrylic = defaults.acrylic
  }

  const accentColor =
    typeof raw.accentColor === 'string' && raw.accentColor.trim()
      ? raw.accentColor.trim()
      : defaults.accentColor

  return {
    theme: theme as ThemeId,
    accentColor,
    acrylic,
    acrylicIntensity: clampAcrylicIntensity(
      raw.acrylicIntensity !== undefined ? raw.acrylicIntensity : defaults.acrylicIntensity
    ),
    renderMath: typeof raw.renderMath === 'boolean' ? raw.renderMath : defaults.renderMath,
    replyPacing: typeof raw.replyPacing === 'boolean' ? raw.replyPacing : defaults.replyPacing,
    interfaceFont: normalizeFontChoice(raw.interfaceFont),
    codeFont: normalizeFontChoice(raw.codeFont),
    threadProjectColors:
      typeof raw.threadProjectColors === 'boolean' ? raw.threadProjectColors : defaults.threadProjectColors,
    threadPathInTitleBar:
      typeof raw.threadPathInTitleBar === 'boolean' ? raw.threadPathInTitleBar : defaults.threadPathInTitleBar,
    animationSpeed: isAnimationSpeed(raw.animationSpeed) ? raw.animationSpeed : defaults.animationSpeed,
    turnChangedFiles: normalizeTurnChangedFiles(raw.turnChangedFiles),
    chatWidth: normalizeChatWidth(raw.chatWidth),
    frostedComposer: typeof raw.frostedComposer === 'boolean' ? raw.frostedComposer : defaults.frostedComposer,
    frostedComposerOpacity: clampFrostedComposer('frostedComposerOpacity', raw.frostedComposerOpacity),
    frostedComposerBlur: clampFrostedComposer('frostedComposerBlur', raw.frostedComposerBlur),
    frostedComposerSaturation: clampFrostedComposer('frostedComposerSaturation', raw.frostedComposerSaturation),
    contextRingInComposer:
      typeof raw.contextRingInComposer === 'boolean' ? raw.contextRingInComposer : defaults.contextRingInComposer
  }
}

export function appearanceUsesAcrylic(appearance: Pick<AppearanceSettings, 'acrylic'>): boolean {
  return Boolean(appearance.acrylic)
}

/** @deprecated Use appearanceUsesAcrylic — kept for any stray imports during transition. */
export function themeUsesAcrylic(theme: string): boolean {
  return theme.endsWith('-acrylic') || theme === 'system-acrylic'
}

export function resolveSkillModelSettings(
  settings: MousseSettings,
  skillId: string
): SkillModelSettings | undefined {
  const skillModel = settings.integrations.skills.model[skillId]
  if (!skillModel?.llmProvider || !skillModel.model) return undefined
  // The skill's own instance, so a second account of one provider runs the skill (legacy records
  // name only `llmProvider` and map to its built-in instance when the turn resolves).
  const instanceId = skillModel.instanceId?.trim()
  return { ...(instanceId ? { instanceId } : {}), llmProvider: skillModel.llmProvider, model: skillModel.model, ...(skillModel.effort ? { effort: skillModel.effort } : {}) }
}

/** Last composer/chat model. Used as the default for newly created threads. */
export function lastUsedChatModel(
  settings: Pick<MousseSettings, 'provider'>
): ModelOverride | undefined {
  const llmProvider = settings.provider.llmProvider?.trim() ?? ''
  const model = settings.provider.model?.trim() ?? ''
  if (!llmProvider || !model) return undefined
  const { instanceId: rawInstance, effort, name } = settings.provider
  const instanceId = rawInstance?.trim()
  return { ...(instanceId ? { instanceId } : {}), llmProvider, model, ...(effort ? { effort } : {}), ...(name ? { name } : {}) }
}

export function resolveModelForMode(
  settings: MousseSettings,
  mode: ChatMode,
  connectedProviderIds: Set<string> | string[] = []
): ModelOverride {
  const connected = connectedProviderIds instanceof Set
    ? connectedProviderIds
    : new Set(connectedProviderIds)

  const skillId = getSkillIdFromMode(mode)
  if (skillId) {
    const skillModel = resolveSkillModelSettings(settings, skillId)
    if (skillModel && connected.has(skillModel.llmProvider)) {
      return skillModel
    }
  }

  // The default keeps its provider instance so a turn resolves the instance that was picked.
  const { llmProvider, model, effort, name } = settings.provider
  const instanceId = settings.provider.instanceId?.trim()
  const selection = { ...(instanceId ? { instanceId } : {}), llmProvider, model, ...(effort ? { effort } : {}), ...(name ? { name } : {}) }
  if (llmProvider && model && connected.has(llmProvider)) {
    return selection
  }

  return selection
}
