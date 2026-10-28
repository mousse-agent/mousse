import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ModelInfo, Options, PermissionMode, Query, SDKResultMessage, SDKUserMessage, SettingSource, Settings as SdkSettings } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeSubscriptionStatus,
  CliProviderConfig,
  CliProviderConfigPatch,
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult,
  ProviderUsage
} from '../../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../../shared/settings'
import type { CredentialKind } from '../../../../shared/harness/status'
import type { ChatImageAttachment } from '../../../../shared/types'
import { normalizePermissionMode, permissionModeAllows, type PermissionLimits, type PermissionMode as ThreadPermissionMode } from '../../../../shared/permissionMode'
import { parseThinkingSuffixFromModelId } from '../../../../shared/modelVariants'
import { AppError } from '../../../../shared/errors'
import type { ProviderToolEvent } from '../../../../shared/agentActivity'
import { CLAUDE_INSTANCE_ID } from '../../../../shared/providerInstances'
import { atomicWriteJsonSync } from '../../../data/AtomicFs'
import type { UserQuestionService } from '../../../orchestrator/UserQuestionService'
import { exactDirectory } from '../../../run/approvalFingerprint'
import { APPROVALS_REFUSED_MESSAGE, QUESTIONS_REFUSED_MESSAGE } from '../../acp/permissions'
import { CLAUDE_MOUSSE_TOOL_PREFIX, claudeMcpServers } from '../../../run/mcp/attachment'
import { TURN_TOKEN_KEY } from '../../../run/mcp/appTools/registry'
import type { LoginSession } from '../../../providers/LoginSession'
import { settingsMirror, type MirrorField, type VendorMirror } from '../../vendorMirror'
import { withEnforced } from '../../env'
import { CLAUDE_LOCKED_REMOVED_OPTIONS, ClaudeLockedGate, claudeLockedOptions, claudeLockedSpawn, type ClaudeLockedTurn } from '../../claude/locked'
import {
  claudeExtraArgs,
  cliLaunch,
  requireExecutable,
  sharedCliVersions,
  storedCliArgs,
  storedCliEnv,
  withUserEnv,
  type CliLaunch,
  type CliVersionCache,
  type StoredCliConfig
} from '../../cliConfig'
import { resolveWindowsShim } from '../../resolveWindowsShim'
import { claudeAccountSubject, claudeBypassDisabled } from './accountSubject'
import {
  ClaudeMetricsCollector,
  ClaudeNativeEditCounter,
  type ClaudeSubscriptionMetrics,
  type ClaudeUsageBaseline
} from './metrics'
import { parseClaudeSubscriptionUsage } from './usage'
import { claudeMcpToolBlocked, claudeProxiedMcpServer, type ClaudeTurnIntegrations } from './integrations'
import { claudeActionOf, claudeChildToolDenial, claudePermissionKey } from './childPolicy'
import { CancelInProgress, DEFAULT_LIVE_TIMINGS, LiveSession, type LiveRun, type LiveTimings } from './liveSession'
import { TurnFrames } from './turnFrames'
import { readUsageLimit } from '../../../orchestrator/providerErrors'
import { USAGE_LIMIT_HOLD_MS, usageLimitFromResult, usageLimitFromWindows, type RejectedWindows } from './usageLimit'
import type { ChildTurnPolicy } from '../../adapter'

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'claude-subscription'
/** What a live process is started for, in the order of the key `chat` builds; a change needs a new process. */
const HARD_PARTS = ['instance', 'folder', 'model', 'reasoning effort', 'instructions', 'Mousse credential', 'read-only policy']
type SavedSession = {
  sessionId: string
  cwd: string
  model?: string
  historyKey?: string
  usageBaseline?: ClaudeUsageBaseline
  /** Provider instance that owns the session; absent on sessions saved before instances existed. */
  instanceId?: string
}
type Settings = {
  /**
   * Always `cli` once loaded: Claude Code uses the sign-in from your terminal. Older versions
   * could store `isolated` (a profile-private sign-in) or nothing; both are migrated on load.
   */
  loginPolicy?: 'cli' | 'isolated'
  /** Older versions: a profile-private sign-in completed. Dropped by the migration. */
  signedIn?: boolean
  /**
   * The launch settings and the sign-out flag as an older Mousse reads them: a mirror of the
   * instance config, written only through `vendorMirror()` and never read for a launch.
   */
  cliDisconnected?: boolean
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
  models?: LlmModelOption[]
  /** ISO time `models` was last listed by Claude Code (absent for the fallback aliases). */
  modelsRefreshedAt?: string
  sessions?: Record<string, SavedSession>
}
export type ClaudeSubscriptionChatInput = {
  threadId: string
  /** Provider instance running the turn; a saved session resumes only on the same instance. */
  instanceId?: string
  cwd: string
  model: string
  prompt: string
  /** Prefixed to the prompt: the turn's skills, mode, applet catalogue and usable Mousse tools. */
  turnPreamble?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mode?: 'plan' | 'default'
  /**
   * The thread's permission mode for this turn (`ask`, `accept_edits`, `full`); absent reads as the
   * default (`accept_edits`). Enforced through Claude Code's own permission mode, the PreToolUse
   * hook and `canUseTool`; a live query follows it turn by turn.
   */
  permissionMode?: ThreadPermissionMode
  /** Set for a delegated child's turns (first and resumed); see `claudeChildToolDenial`. */
  child?: ChildTurnPolicy
  /** The Mousse MCP server for this run (SPEC §15.2); null attaches no server. */
  mcp?: { url: string; token: string } | null
  /**
   * The turn's token, stamped into every Mousse call's input (`_mousse_turn`) by Mousse's own
   * `PreToolUse` hook, so a call Claude made for an earlier turn is refused (`per_call` turn binding).
   */
  mcpTurnToken?: string
  /** Mousse's own instructions, appended to Claude Code's system prompt. */
  systemPromptAppend?: string
  /**
   * `never`: a tool call that needs the user's approval, and `AskUserQuestion`, are denied without
   * asking (`RunPolicy.approvals`): nobody answers this run.
   */
  approvals?: 'never'
  /** The MCP servers and skills the user enabled in Mousse; absent attaches none. */
  integrations?: ClaudeTurnIntegrations
  /**
   * A bot's turn on a locked instance (PR 6 §3): it runs under the locked profile
   * (`claudeLockedOptions`) with Mousse's grant gate on every call, and nothing of the user's own
   * Claude Code setup. Integrations, live processes and the permission mode do not apply.
   */
  locked?: ClaudeLockedTurn
  /**
   * The turn is one Claude started itself, because a background task finished: it joins that turn on
   * the thread's live query and pushes no prompt.
   */
  continuation?: boolean
  /** Which of the thread's turns Claude started itself this is (`ClaudeLiveHost.continuationStarted`); absent takes the oldest. */
  continuationId?: string
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onMetrics?: (report: ClaudeSubscriptionMetrics) => void
  onLineEdits?: (lines: number) => void
  drainSteer?: () => string | undefined
  /** A drained steer was pushed to Claude. */
  onSteer?: (text: string) => void
  /** A drained steer could not be pushed because the turn's result had already arrived: it is the next turn. */
  returnSteer?: (text: string, token?: string) => void
  /** A drained steer was pushed to Claude: its token is spent. */
  steerTaken?: (token?: string) => void
  /** `drainSteer` with a token that `returnSteer` gets back, so several steers in flight are returned each with its own rows. */
  drainSteerEntry?: () => { text: string; token: string } | undefined
  onTool?: (event: ProviderToolEvent) => void
}
/**
 * What the service tells the host that runs its turns (issue #142). Both calls are synchronous and a
 * throw is logged, never propagated.
 */
export interface ClaudeLiveHost {
  /** The thread's background work (agents, shells) started or ended, including an idle-cap expiry. */
  backgroundWork?(threadId: string, active: boolean): void
  /**
   * Claude started a turn of its own because background tasks finished. The host runs it as a run of
   * the thread, which calls `chat({ continuation: true, continuationId: info.id })`.
   */
  continuationStarted?(threadId: string, info: { id: string; taskIds: string[]; summaries: string[] }): void
  /** Something the thread's user should know: a helper's result may not have been delivered. */
  notice?(threadId: string, text: string): void
}
/** What a turn's permission hooks and callback read: the turn running now, not the one that created the query. */
type TurnContext = {
  input: ClaudeSubscriptionChatInput
  controller: AbortController
  integrations: ClaudeTurnIntegrations | undefined
  editCounter: ClaudeNativeEditCounter
  planTurn: boolean
  restricted: boolean
  /** The thread's permission mode this turn runs in (already lowered when Claude Code refuses to bypass). */
  permissionMode: ThreadPermissionMode
  /** A locked turn's grant gate: it decides every call, and nobody is asked. */
  locked?: ClaudeLockedGate
}
type Dependencies = {
  /**
   * Live queries (the default) or `false` for one query per turn. Timings and the cap can be tuned
   * for tests.
   */
  live?: false | Partial<LiveTimings>
  /** How long a turn Claude Code holds after a rejected plan window runs before Mousse ends it (tests). */
  usageLimitHoldMs?: number
  query?: (input: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Query
  runAuth?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ) => Promise<string>
  /** `claude --version` lookups (tests). */
  versions?: CliVersionCache
  /**
   * Where this instance keeps its settings, saved sessions and standalone workspaces. Default:
   * `<profileHome>/providers/claude-subscription` (the `claude` instance).
   */
  stateDir?: string
  /** Finds `claude` when no executable is set; default: PATH and `~/.local/bin`. */
  findBinary?: () => string | undefined
  /**
   * The environment Claude Code starts from, before the user's variables; default `process.env`.
   * An instance with its own Claude home sets `CLAUDE_CONFIG_DIR` here.
   */
  baseEnv?: () => NodeJS.ProcessEnv
  /**
   * The executable, launch args and variables: the instance config's (the gateway's). Without it
   * Claude Code runs as found, with no extra args or variables.
   */
  launchConfig?: () => StoredCliConfig
  /** Signed out in Mousse (the instance config's flag, the gateway's); default false. */
  signedOut?: () => boolean
  /** Saves an executable path entered at sign-in to the instance config (the gateway's `configure`). */
  saveLaunch?: (patch: CliProviderConfigPatch) => Promise<void>
  /** The terminal command that signs this instance in; default `claude auth login`. */
  signInCommand?: string
  /**
   * Applied last to every environment Claude Code starts with, after the user's variables and a
   * turn's integration variables: an API-key instance sets its key here and drops other sign-ins.
   */
  finalEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  /**
   * The entry's telemetry switch (Settings → Providers): variables set after everything else,
   * `finalEnv` included, on every process. Read at each start.
   */
  telemetryEnv?: () => Readonly<Record<string, string>> | undefined
  /**
   * Replaces `claude auth status` for an instance whose sign-in Mousse holds itself (an API key):
   * what the instance runs on, read without starting Claude Code.
   */
  probe?: (env: NodeJS.ProcessEnv) => AuthProbe
  /** What a turn says when the instance is not signed in (default: run the sign-in command). */
  signedOutMessage?: () => string
  /**
   * The settings files Claude Code loads (default: all, as in a terminal). An API-key entry leaves out
   * `user`, its Mousse-owned home, so nothing there can replace the key or its address.
   */
  settingSources?: SettingSource[]
  /** Launch arguments never passed on (an API-key entry: `--settings`, `--setting-sources`). */
  droppedArgs?: readonly string[]
  /**
   * Read before a turn starts, with its folder: flag-tier settings the turn's query starts with (an
   * API-key entry keeps its key and address over the folder's settings), or why it cannot start
   * there. A refused turn starts no Claude Code.
   */
  turnSettings?: (cwd: string) => Promise<{ settings?: SdkSettings; refuse?: string }>
  /**
   * A locked instance's environment for a turn in `scratch` (`lockedEnv`, PR 6 §2): built from
   * nothing, with the instance's home; `finalEnv` still applies its key after. Absent: the instance
   * is not locked, and a locked turn is refused.
   */
  lockedEnv?: (scratch: string) => NodeJS.ProcessEnv
}
/** How `claude auth status` names its sign-in methods, for display. */
const CLAUDE_AUTH_METHOD_LABELS: Record<string, string> = {
  'claude.ai': 'Claude account',
  oauth_token: 'OAuth token',
  api_key: 'API key',
  console: 'Anthropic Console'
}
/**
 * The signed-in account: a display label (plan or sign-in method) and `subject`, a stable id of
 * the account or credential (`claudeAccountSubject`), never shown.
 */
export type ClaudeAccount = { label?: string; subject?: string; credential?: CredentialKind }
/** Claude Code's cloud routes that sign in with the environment's AWS or Google credentials. */
const CLAUDE_AMBIENT_PROVIDERS: ReadonlySet<string> = new Set(['bedrock', 'vertex', 'anthropicAws', 'anthropicGoogleCloud'])
/**
 * What a signed-in Claude Code runs on, from its own `claude auth status`: a claude.ai sign-in or
 * its OAuth token is the subscription, an API key or Console sign-in is a key, Bedrock and Vertex
 * run on the environment's cloud credentials. Anything else (another provider, a gateway, a method
 * this version does not name) is `unknown`.
 */
export function claudeCredentialKind(status: { authMethod?: string; apiProvider?: string }): CredentialKind {
  if (status.apiProvider && status.apiProvider !== 'firstParty') return CLAUDE_AMBIENT_PROVIDERS.has(status.apiProvider) ? 'ambient' : 'unknown'
  switch (status.authMethod) {
    case 'claude.ai':
    case 'oauth_token':
      return 'subscription'
    case 'api_key':
    case 'console':
      return 'api_key'
    default:
      return 'unknown'
  }
}
export type AuthProbe =
  | { kind: 'signed_in'; account?: ClaudeAccount }
  | { kind: 'signed_out'; message: string }
  | { kind: 'error'; message: string }

/** How long a live `claude auth status` result stands before it is checked again. */
export const CLAUDE_AUTH_STATUS_TTL_MS = 5 * 60_000
const FALLBACK_MODELS: LlmModelOption[] = ['sonnet', 'opus', 'haiku'].map((id) => ({
  id,
  label: `Claude ${id[0].toUpperCase()}${id.slice(1)}`
}))

/**
 * Claude Code names models by family ("Sonnet") and puts the version in the description
 * ("Sonnet 5.5 · …"). Its "default" alias repeats another listed model, so it is dropped;
 * when it points elsewhere it is named after that model instead.
 */
export function claudeModelOptions(models: ModelInfo[]): LlmModelOption[] {
  const listed = new Set(models.filter((model) => model.value !== 'default').map((model) => model.resolvedModel))
  return models
    .filter((model) => model.value !== 'default' || !model.resolvedModel || !listed.has(model.resolvedModel))
    .map((model) => {
      const version =
        model.value === 'default'
          ? /\(currently ([^)]+)\)/.exec(model.description)?.[1]
          : /^([A-Za-z]+ \d+(?:\.\d+)*)\s*(?:·|$)/.exec(model.description)?.[1]
      return {
        id: model.value,
        label: version?.trim() || model.displayName,
        efforts: model.supportedEffortLevels
      }
    })
}

/** Variables a running Claude Code session sets for the commands it starts. */
const CLAUDE_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION'
]

/**
 * The environment Claude Code starts with: the one Mousse inherited from the user, as a terminal
 * would pass it. The user's own configuration (API keys, tokens, proxies, cloud routing,
 * `CLAUDE_CONFIG_DIR`) is kept; Claude Code then applies its own `settings.json` on top. Only
 * markers that describe Mousse's own process, not the user's setup, are removed:
 * - `ELECTRON_RUN_AS_NODE`: set when Mousse runs as Electron-as-Node. Left in place, any Electron
 *   app the agent starts from its shell would run as plain Node instead.
 * - The variables a running Claude Code session gives the commands it starts, present when Mousse
 *   itself was started from one (`CLAUDECODE`, its session id, PID, messaging socket and so on).
 *   They describe that other session; left in place, Claude Code would treat itself as a child
 *   of it. Settings never set these.
 */
export function claudeSubscriptionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of ['ELECTRON_RUN_AS_NODE', ...CLAUDE_SESSION_MARKERS]) delete env[key]
  return env
}

/** Claude Code's launch args that add text to its system prompt. */
const APPEND_SYSTEM_PROMPT_ARGS = ['append-system-prompt', 'append-system-prompt-file'] as const

/**
 * The text the user's `--append-system-prompt-file` and `--append-system-prompt` launch args add,
 * in the order Claude Code uses (file text first, one trailing newline trimmed, then the inline
 * text). Claude Code replaces its own append text with the SDK's `systemPrompt.append`, so this
 * text has to travel there or it is lost. A relative file resolves against the turn's folder,
 * where Claude Code runs. Values the CLI would reject are rejected here too.
 */
export function claudeLaunchAppendSystemPrompt(extraArgs: Record<string, string | null>, cwd: string): string[] {
  const inline = extraArgs['append-system-prompt']
  const file = extraArgs['append-system-prompt-file']
  if (inline === null)
    throw new Error('The --append-system-prompt launch argument has no text. Add it after the flag in the Claude Code launch arguments, then send the message again.')
  if (file === null || file === '')
    throw new Error('The --append-system-prompt-file launch argument has no file path. Add it after the flag in the Claude Code launch arguments, then send the message again.')
  let fileText: string | undefined
  if (file !== undefined) {
    const path = resolve(cwd, file)
    try {
      fileText = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    } catch {
      throw new Error(`Claude Code could not read the --append-system-prompt-file launch argument at ${path}. Fix the path in the Claude Code launch arguments, then send the message again.`)
    }
  }
  return [fileText, inline].filter((text): text is string => typeof text === 'string' && text.length > 0)
}

/** `claude` on PATH or in `~/.local/bin`; an npm `claude.cmd` shim counts once it resolves. */
function binaryOnPath(): string | undefined {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude']
  for (const directory of [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin')
  ]) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
      } catch {
        continue
      }
      if (resolveWindowsShim(candidate)) return candidate
    }
  }
  return undefined
}
function runAuth(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolveResult, reject) =>
    execFile(
      binary,
      args,
      { env, signal, timeout: 15_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error)
          reject(
            // `claude auth status` exits non-zero when signed out but still prints its JSON.
            Object.assign(
              new Error(
                signal?.aborted
                  ? 'Claude sign-in cancelled'
                  : 'Claude Code authentication command failed. Install or update the official Claude Code CLI.'
              ),
              { stdout: typeof stdout === 'string' ? stdout : undefined }
            )
          )
        else resolveResult(stdout)
      }
    )
  )
}
const historyKey = (history: string) => createHash('sha256').update(history).digest('hex')
/**
 * Whether a saved session may be resumed by a turn on `instanceId`. Sessions saved before
 * instances existed belong to the default `claude` instance.
 */
function sessionBoundTo(saved: SavedSession, instanceId: string): boolean {
  return (saved.instanceId ?? CLAUDE_INSTANCE_ID) === instanceId
}

export class ClaudeSubscriptionProviderService {
  private readonly dir: string
  private readonly settingsPath: string
  private settings: Settings = {}
  /** Set when settings.json exists but cannot be read; blocks migration and every write. */
  private settingsError?: string
  /** Another service of the instance writes its settings now (`freezeSettings`). */
  private settingsFrozen = false
  private stopped = false
  private readonly queries = new Map<string, Query>()
  /** Live queries by thread: the Claude processes that outlive a turn. Null disables them (one query per turn). */
  private readonly live = new Map<string, LiveSession<TurnContext>>()
  private readonly liveConfig: LiveTimings | null
  private liveHost: ClaudeLiveHost | null = null
  /** The run whose notifications commit with the conversation, by thread. */
  private readonly liveCommits = new Map<string, { live: LiveSession<TurnContext>; run: LiveRun }>()
  private readonly readyToCommit = new Set<string>()
  /** Threads whose last turn was stopped after the SDK had a session, by that session id (`commitInterrupted`). */
  private readonly interruptedSessions = new Map<string, string>()
  private readonly loginSessions = new Set<LoginSession>()
  private readonly controllers = new Set<AbortController>()
  private readonly activeThreads = new Set<string>()
  /** Last live `claude auth status` check. */
  private cliProbe?: { at: number; result: AuthProbe }
  private probing?: Promise<void>
  private modelDiscoveryStarted = false
  /** The loaded settings already record the terminal sign-in; otherwise `status()` saves the migration. */
  private policyStored = false

  constructor(
    profileHome: string,
    private readonly questions: UserQuestionService,
    private readonly dependencies: Dependencies = {}
  ) {
    this.dir = dependencies.stateDir ?? join(profileHome, 'providers', CLAUDE_SUBSCRIPTION_PROVIDER_ID)
    this.settingsPath = join(this.dir, 'settings.json')
    this.liveConfig = dependencies.live === false ? null : { ...DEFAULT_LIVE_TIMINGS, ...dependencies.live }
    this.loadSettings()
  }
  /**
   * Only a missing file counts as new settings. An unreadable or malformed file is never migrated
   * or overwritten until a Recheck reads it.
   */
  private loadSettings(): void {
    this.settings = {}
    this.settingsError = undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('not an object')
      const policy = (parsed as Settings).loginPolicy
      if (policy !== undefined && policy !== 'cli' && policy !== 'isolated')
        throw new Error('unknown login policy')
      this.settings = parsed as Settings
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
        this.settingsError = `Mousse could not read this profile's Claude settings (${this.settingsPath}). Fix or remove the file, then recheck.`
    }
    this.policyStored = this.settings.loginPolicy === 'cli'
    if (this.policyStored || this.settingsError) return
    // Claude Code always uses the terminal sign-in. Sessions saved by older versions may belong to
    // a profile-private config dir, so they are not resumed; that dir stays on disk untouched.
    this.settings.loginPolicy = 'cli'
    this.settings.sessions = {}
    delete this.settings.signedIn
  }
  standaloneWorkspace(threadId: string): string {
    const directory = join(this.dir, 'workspaces', historyKey(threadId))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  private save(): void {
    if (this.settingsError || this.settingsFrozen) return
    mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(this.settingsPath, this.settings)
    this.policyStored = true
  }
  /** How to start Claude Code: the chosen or detected executable, with an npm shim resolved. */
  private launchTarget(): CliLaunch | undefined {
    return cliLaunch(this.launchSettings().binaryPath || (this.dependencies.findBinary?.() ?? binaryOnPath()))
  }
  /** The program that runs (reported as `resolvedBinaryPath`). */
  private binary(): string | undefined {
    return this.launchTarget()?.path
  }
  /** `claude <args>` as Mousse starts it, for auth commands. */
  private runClaude(args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
    const launch = this.launchTarget()
    if (!launch) return Promise.reject(new Error('Claude Code CLI not found. Install the official Claude Code CLI, then recheck.'))
    return (this.dependencies.runAuth ?? runAuth)(launch.command, [...launch.args, ...args], env, signal)
  }
  private environment(): NodeJS.ProcessEnv {
    return this.finalEnv(withUserEnv(claudeSubscriptionEnvironment(this.dependencies.baseEnv?.()), storedCliEnv(this.launchSettings())))
  }
  /** The instance's own last word on a process environment (`Dependencies.finalEnv`), then its telemetry switch. */
  private finalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return withEnforced(this.dependencies.finalEnv?.(env) ?? env, this.dependencies.telemetryEnv?.())
  }
  /** The stored executable, args and variables: the instance config's, never `settings.json`. */
  private launchSettings(): StoredCliConfig {
    return this.dependencies.launchConfig?.() ?? {}
  }
  /** Signed out in Mousse: the instance's flag; the terminal sign-in stays intact. */
  private signedOut(): boolean {
    return this.dependencies.signedOut?.() === true
  }
  /**
   * The copy of `fields` in this service's `settings.json` for an older Mousse. It reads and writes
   * the settings object loaded now (Recheck replaces it) and saves through `save()`, the file's one writer.
   */
  vendorMirror(fields: readonly MirrorField[]): VendorMirror {
    return settingsMirror(fields, {
      settings: () => this.settings as Record<string, unknown>,
      settingsError: () => this.settingsError ?? (this.settingsFrozen ? 'Another Claude service writes these settings now.' : undefined),
      save: () => this.save(),
      exists: () => existsSync(this.settingsPath),
      signedOutKey: 'cliDisconnected'
    })
  }
  /**
   * `claude` as Mousse starts it, with the environment of its own commands (status, turns): what the
   * sign-in and sign-out of an instance with its own home run with. Undefined when no executable is found.
   */
  authLaunch(): { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
    const launch = this.launchTarget()
    return launch ? { command: launch.command, args: [...launch.args], env: this.environment() } : undefined
  }
  /**
   * What `claude auth status` says in this instance's environment now, whatever Mousse recorded (a
   * disconnect included) and without touching the recorded state. `unknown`: it did not answer.
   */
  async authState(): Promise<'signed_in' | 'signed_out' | 'unknown'> {
    if (!this.binary()) return 'unknown'
    const result = await this.probe(this.environment())
    return result.kind === 'signed_in' ? 'signed_in' : result.kind === 'signed_out' ? 'signed_out' : 'unknown'
  }
  /** The terminal command that signs this instance in. */
  private signInCommand(): string {
    return this.dependencies.signInCommand ?? 'claude auth login'
  }
  /**
   * Drops the saved session of `threadId`, so its next turn starts a new Claude session with the
   * history in the prompt (the account or home it was saved under changed).
   */
  forgetConversation(threadId: string): void {
    if (!this.settings.sessions?.[threadId]) return
    const { [threadId]: _dropped, ...rest } = this.settings.sessions
    this.settings.sessions = rest
    this.save()
  }
  /** The executable path, launch args and environment set in Settings → Providers. */
  async cliConfig(): Promise<CliProviderConfig> {
    const launch = this.launchTarget()
    return {
      instanceId: CLAUDE_INSTANCE_ID,
      ...(this.launchSettings().binaryPath ? { binaryPath: this.launchSettings().binaryPath } : {}),
      ...(launch ? { resolvedBinaryPath: launch.path } : {}),
      version: await (this.dependencies.versions ?? sharedCliVersions).version(launch, this.environment()),
      args: storedCliArgs(this.launchSettings()),
      env: storedCliEnv(this.launchSettings())
    }
  }
  /**
   * Checks launch settings before the gateway saves them: an executable that cannot run, or args
   * the SDK cannot pass. Each turn starts its own Claude Code process, so the next turn uses them.
   */
  validateLaunch(patch: CliProviderConfigPatch): void {
    if (typeof patch.binaryPath === 'string') requireExecutable(patch.binaryPath, 'Claude Code')
    if (patch.args) claudeExtraArgs(patch.args)
  }
  /**
   * Synchronous view for routing and listings. It reflects the last live `claude auth status`
   * check (see `status()`).
   */
  configured(): boolean {
    if (this.stopped || this.settingsError || this.signedOut() || !this.binary()) return false
    // Refresh a stale result in the background; the first check comes from `status()`.
    if (this.cliProbe && this.checkDue()) void this.status()
    return this.cliProbe?.result.kind === 'signed_in'
  }
  configuredProvider(): ConfiguredProvider | undefined {
    return this.configured()
      ? {
          id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
          label: 'Claude Subscription',
          authType: 'oauth',
          source: 'Official Claude Code · Claude-managed billing'
        }
      : undefined
  }
  loginOption(): ProviderLoginOption {
    return {
      id: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      label: 'Claude Subscription',
      authType: 'oauth',
      configured: this.configured(),
      guidedLogin: true,
      description: 'Official Claude Code · personal account'
    }
  }
  /** The discovered models, or the CLI aliases until discovery runs. */
  models(): LlmModelOption[] {
    return this.settings.models?.length ? this.settings.models : FALLBACK_MODELS
  }
  /** When Claude Code last listed the models, kept with them across restarts. */
  modelsRefreshedAt(): string | undefined {
    return this.settings.models?.length ? this.settings.modelsRefreshedAt : undefined
  }
  llmProvider(): LlmProviderOption | undefined {
    if (!this.configured()) return undefined
    // Offer the CLI aliases until model discovery runs.
    const models = this.settings.models?.length ? this.settings.models : FALLBACK_MODELS
    return { id: CLAUDE_SUBSCRIPTION_PROVIDER_ID, label: 'Claude Subscription', models }
  }
  /**
   * Any sign-in Claude Code reports counts, whatever its method (Claude account, OAuth token, API
   * key, cloud provider): the CLI is configured however its owner likes.
   */
  private async probe(
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<AuthProbe> {
    if (this.dependencies.probe) return this.dependencies.probe(env)
    const unreadable: AuthProbe = {
      kind: 'error',
      message: 'Claude Code did not report its sign-in status. Update the Claude Code CLI and recheck.'
    }
    let output: string
    try {
      output = await this.runClaude(['auth', 'status'], env, signal)
    } catch (error) {
      signal?.throwIfAborted()
      const stdout = (error as { stdout?: unknown } | undefined)?.stdout
      if (typeof stdout !== 'string' || !stdout.trim()) return unreadable
      output = stdout
    }
    let status: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown; subscriptionType?: unknown }
    try {
      status = JSON.parse(output) as typeof status
    } catch {
      return unreadable
    }
    if (typeof status?.loggedIn !== 'boolean') return unreadable
    if (!status.loggedIn)
      return {
        kind: 'signed_out',
        message: `Claude Code isn't signed in. Run \`${this.signInCommand()}\` in a terminal, then check again.`
      }
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    const method = text(status.authMethod)
    const plan = text(status.subscriptionType)
    const label = plan ? `Claude ${plan[0].toUpperCase()}${plan.slice(1)}` : method && (CLAUDE_AUTH_METHOD_LABELS[method] ?? method)
    const subject = claudeAccountSubject(env)
    const apiProvider = text(status.apiProvider)
    const credential = claudeCredentialKind({ ...(method ? { authMethod: method } : {}), ...(apiProvider ? { apiProvider } : {}) })
    return { kind: 'signed_in', account: { ...(label ? { label } : {}), ...(subject ? { subject } : {}), credential } }
  }
  /** The account of the last live sign-in check, when it was signed in and named one. */
  account(): ClaudeAccount | undefined {
    const result = this.cliProbe?.result
    return result?.kind === 'signed_in' ? result.account : undefined
  }
  /** The account this instance runs as (`claudeAccountSubject`), read without starting Claude Code. */
  accountSubject(): string | undefined {
    return claudeAccountSubject(this.environment())
  }
  /**
   * Whether the user's Claude settings forbid `bypassPermissions` for a turn in `cwd`
   * (`claudeBypassDisabled`), read again every time: nothing is cached, and nothing edits the settings.
   */
  permissionLimits(cwd?: string): PermissionLimits | undefined {
    return claudeBypassDisabled(this.environment(), cwd ? { cwd } : {}) ? { bypassDisabled: true } : undefined
  }
  /** Checks the sign-in with the environment the caller captured for its turn. */
  private async authenticated(signal?: AbortSignal, env = this.environment()): Promise<boolean> {
    if (!this.binary()) return false
    const result = await this.probe(env, signal)
    signal?.throwIfAborted()
    this.cliProbe = { at: Date.now(), result }
    return result.kind === 'signed_in'
  }
  /** A live check is due: the last terminal sign-in result is missing or stale. */
  private checkDue(): boolean {
    if (this.stopped || this.settingsError || this.signedOut()) return false
    const at = this.cliProbe?.at
    return at === undefined || Date.now() - at >= CLAUDE_AUTH_STATUS_TTL_MS
  }
  private async refreshStatus(): Promise<void> {
    if (!this.binary() || this.stopped) return
    const result = await this.probe(this.environment())
    if (this.stopped) return
    this.cliProbe = { at: Date.now(), result }
    if (result.kind === 'signed_in' && !this.settings.models?.length && !this.modelDiscoveryStarted) {
      this.modelDiscoveryStarted = true
      void this.refreshModels(this.dir).catch(
        () => {
          /* the CLI aliases stay available */
        }
      )
    }
  }
  /**
   * Runs a live `claude auth status` when the cached result is missing, older than five minutes,
   * or `force` (Recheck) is set.
   */
  async status(options: { force?: boolean } = {}): Promise<ClaudeSubscriptionStatus> {
    if (options.force) {
      await this.probing
      this.cliProbe = undefined
      if (this.settingsError) this.loadSettings()
    }
    // Persist the migration to the terminal sign-in.
    if (!this.policyStored && !this.stopped) this.save()
    if (this.checkDue()) {
      this.probing ??= this.refreshStatus()
        .catch(() => {
          /* reported as not checked yet */
        })
        .finally(() => {
          this.probing = undefined
        })
      await this.probing
    }
    return this.snapshot()
  }
  private snapshot(): ClaudeSubscriptionStatus {
    if (this.settingsError) return { state: 'error', message: this.settingsError }
    if (!this.binary())
      return {
        state: 'missing_binary',
        message: 'Claude Code CLI not found. Install the official Claude Code CLI, then recheck.'
      }
    if (this.signedOut())
      return {
        state: 'disconnected',
        message: 'Disconnected in Mousse. The Claude sign-in in your terminal is unchanged.'
      }
    const probe = this.cliProbe
    if (!probe) return { state: 'error', message: 'Mousse has not checked the Claude sign-in yet.' }
    const checkedAt = new Date(probe.at).toISOString()
    if (probe.result.kind === 'signed_in') return { state: 'connected', checkedAt }
    return { state: probe.result.kind, message: probe.result.message, checkedAt }
  }
  /**
   * Connects Claude Code. The sign-in is managed in the terminal; Mousse never runs
   * `claude auth login` itself, it waits for the user to sign in there.
   */
  async login(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    // After every wait: a cancelled sign-in must not prompt again.
    const checkpoint = () => session.abort.signal.throwIfAborted()
    const signedIn = async () => {
      const result = await this.authenticated(session.abort.signal)
      checkpoint()
      return result
    }
    this.loginSessions.add(session)
    try {
      if (this.stopped) throw new Error('Claude provider is stopped')
      if (this.settingsError) throw new Error(this.settingsError)
      const interaction = session.createAuthCallbacks()
      if (!this.binary()) {
        checkpoint()
        const binary = await interaction.prompt({
          type: 'text',
          message: 'Install the official Claude Code CLI, then enter its absolute executable path',
          placeholder: '/home/me/.local/bin/claude'
        })
        if (!isAbsolute(binary)) throw new Error('Claude Code binary path must be absolute')
        // Saved to the instance config through the gateway, like any other launch setting.
        if (!this.dependencies.saveLaunch) throw new Error('Claude Code executable is unavailable')
        await this.dependencies.saveLaunch({ binaryPath: binary })
        if (!this.binary()) throw new Error('Claude Code executable is unavailable')
      }
      checkpoint()
      while (!(await signedIn())) {
        // Same synchronous segment as the prompt: nothing can cancel in between.
        checkpoint()
        const answer = await interaction.prompt({
          type: 'select',
          message:
            `Claude Code isn't signed in. Run \`${this.signInCommand()}\` in a terminal, then check again. Mousse uses the same sign-in as your terminal.`,
          options: [
            { id: 'check', label: 'Check sign-in' },
            { id: 'cancel', label: 'Cancel' }
          ]
        })
        checkpoint()
        if (answer !== 'check') throw new Error('Claude sign-in cancelled')
      }
      checkpoint()
      try {
        await this.refreshModels(cwd, session.abort.signal)
      } catch {
        session.abort.signal.throwIfAborted()
        if (this.stopped) throw new Error('Claude provider is stopped')
        if (!this.settings.models?.length) this.settings.models = FALLBACK_MODELS
        this.save()
        interaction.notify({
          type: 'progress',
          message:
            'Signed in. Model discovery is unavailable; Claude Code model aliases are available.'
        })
      }
      session.abort.signal.throwIfAborted()
      if (this.stopped) throw new Error('Claude provider is stopped')
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      return {
        success: false,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.loginSessions.delete(session)
    }
  }
  private async createQuery(
    prompt: string | AsyncIterable<SDKUserMessage>,
    options: Options
  ): Promise<Query> {
    if (this.stopped) throw new Error('Claude provider is stopped')
    if (this.dependencies.query) return this.dependencies.query({ prompt, options })
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    options.abortController?.signal.throwIfAborted()
    if (this.stopped) throw new Error('Claude provider is stopped')
    return sdk.query({ prompt, options })
  }
  /**
   * How Mousse starts Claude Code. It runs as the user set it up: `settingSources` is left out, so
   * the user, project and local settings load as in a terminal (their `env`, MCP servers, hooks,
   * plugins, permission rules, CLAUDE.md and so on). Mousse adds its own MCP servers and
   * instructions per turn on top, and sets the permission mode for each turn.
   */
  private options(
    cwd: string,
    controller: AbortController,
    env: NodeJS.ProcessEnv = this.environment(),
    append: string[] = [],
    settings?: SdkSettings
  ): Options {
    const launch = this.launchTarget()
    // The append flags travel in `systemPrompt.append` (see claudeLaunchAppendSystemPrompt).
    const extraArgs = claudeExtraArgs(storedCliArgs(this.launchSettings()))
    for (const name of [...APPEND_SYSTEM_PROMPT_ARGS, ...(this.dependencies.droppedArgs ?? [])]) delete extraArgs[name]
    const appendText = append.filter(Boolean).join('\n\n')
    return {
      cwd,
      pathToClaudeCodeExecutable: launch?.path,
      // A JavaScript entry script (npm's Claude Code before native builds) runs under the node the
      // shim names. The SDK passes `executable` to spawn as the command, so a full path works.
      ...(launch && launch.command !== launch.path ? { executable: launch.command as Options['executable'] } : {}),
      env,
      abortController: controller,
      permissionMode: 'default',
      permissionPrompts: 'host',
      // Claude Code's own system prompt, as in a terminal; Mousse only appends to it.
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(appendText ? { append: appendText } : {}) },
      mcpServers: {},
      ...(this.dependencies.settingSources ? { settingSources: [...this.dependencies.settingSources] } : {}),
      ...(settings ? { settings } : {}),
      ...(Object.keys(extraArgs).length ? { extraArgs } : {}),
      includePartialMessages: true
    }
  }
  /**
   * The options of a query that runs no turn (model discovery, usage). A locked entry's run as its
   * turns do: in a folder of Mousse's own, with no settings files, plugins, launch arguments or MCP
   * servers, and the locked environment; every other entry's run as the user set Claude Code up.
   */
  private housekeepingOptions(cwd: string, controller: AbortController): Options {
    const lockedEnv = this.dependencies.lockedEnv
    if (!lockedEnv) return this.options(cwd, controller)
    const folder = join(this.dir, 'locked')
    mkdirSync(join(folder, 'tmp'), { recursive: true, mode: 0o700 })
    return {
      ...this.options(folder, controller, this.finalEnv(lockedEnv(folder))),
      settingSources: [],
      strictMcpConfig: true,
      plugins: [],
      extraArgs: {},
      mcpServers: {}
    }
  }
  async refreshModels(cwd: string, signal?: AbortSignal): Promise<void> {
    // A refresh before the first sign-in check (or after it went stale) checks first.
    if (this.checkDue()) await this.status()
    if (!this.configured()) return
    const controller = new AbortController()
    this.controllers.add(controller)
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, 15_000)
    let query: Query | undefined
    try {
      signal?.throwIfAborted()
      // Streaming input stays empty: initialize/discover only, never submit a billable prompt.
      const idle = async function* (): AsyncGenerator<SDKUserMessage> {
        if (controller.signal.aborted) return
        await new Promise<void>((resolveIdle) =>
          controller.signal.addEventListener('abort', () => resolveIdle(), { once: true })
        )
      }
      query = await this.createQuery(idle(), {
        ...this.housekeepingOptions(cwd, controller),
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'Model discovery cannot run tools' })
      })
      const models = await query.supportedModels()
      controller.signal.throwIfAborted()
      if (models.length) {
        this.settings.models = claudeModelOptions(models)
        this.settings.modelsRefreshedAt = new Date().toISOString()
        this.save()
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
      query?.close()
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', cancel)
    }
  }
  async getUsage(cwd: string, signal?: AbortSignal): Promise<ProviderUsage> {
    const unavailable = parseClaudeSubscriptionUsage(undefined)
    if (this.checkDue()) await this.status()
    if (!this.configured()) return unavailable
    const controller = new AbortController()
    this.controllers.add(controller)
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    let query: Query | undefined
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15_000)
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error(timedOut ? 'Usage check timed out' : 'Usage check canceled'))
      controller.signal.addEventListener('abort', fail, { once: true })
      if (controller.signal.aborted) fail()
    })
    // Pre-aborted callers may leave before reaching either race.
    void aborted.catch(() => {})
    try {
      controller.signal.throwIfAborted()
      const idle = async function* (): AsyncGenerator<SDKUserMessage> {
        if (controller.signal.aborted) return
        await new Promise<void>((resolveIdle) =>
          controller.signal.addEventListener('abort', () => resolveIdle(), { once: true })
        )
      }
      const pending = this.createQuery(idle(), {
        ...this.housekeepingOptions(cwd, controller),
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'Usage checks cannot run tools' })
      }).then((created) => {
        // Initialization may ignore abort: dispose a late query after this request has settled.
        if (controller.signal.aborted) created.close()
        else query = created
        return created
      })
      query = await Promise.race([pending, aborted])
      controller.signal.throwIfAborted()
      const usageQuery = query as Query & {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (
          opts: { skipBehaviors: boolean }
        ) => Promise<unknown>
      }
      const readUsage = usageQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
      if (typeof readUsage !== 'function') return unavailable
      const response = await Promise.race([
        readUsage.call(query, { skipBehaviors: true }),
        aborted
      ])
      controller.signal.throwIfAborted()
      return parseClaudeSubscriptionUsage(response)
    } catch {
      return {
        ...unavailable,
        status: 'error',
        // SDK errors may contain URLs or account details; do not forward their raw text.
        message: timedOut
          ? 'Claude usage check timed out. Try refreshing.'
          : controller.signal.aborted
            ? 'Claude usage check was canceled.'
            : 'Unable to retrieve Claude account usage limits. Try refreshing.'
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
      query?.close()
      this.controllers.delete(controller)
      signal?.removeEventListener('abort', cancel)
    }
  }
  private signInRequiredMessage(): string {
    if (this.settingsError) return 'Connect Claude Subscription in Settings → Providers first.'
    if (this.signedOut())
      return 'Claude Subscription is disconnected. Reconnect it in Settings → Providers.'
    return this.dependencies.signedOutMessage?.() ?? `Claude Code isn't signed in. Run \`${this.signInCommand()}\` in a terminal, then try again.`
  }
  private abortInFlight(): void {
    for (const controller of this.controllers) controller.abort()
    for (const threadId of this.activeThreads) this.questions.dismissAllForThread(threadId)
    for (const session of this.loginSessions) session.abort.abort()
    for (const query of this.queries.values()) query.close()
    this.queries.clear()
    this.closeLive()
    this.readyToCommit.clear()
  }
  commitConversation(threadId: string, history: string): void {
    // The turn committed, so the background-task notifications it consumed are done.
    this.commitObligations(threadId)
    if (!this.readyToCommit.delete(threadId)) return
    const saved = this.settings.sessions?.[threadId]
    if (saved) {
      saved.historyKey = historyKey(history)
      this.save()
    }
  }
  /**
   * A stopped turn leaves its session resumable. `history` is the canonical history exactly as the
   * stopped turn left it (its request included, no reply), which is what the next turn will send
   * as its history; saving its fingerprint with the session lets that turn resume the native
   * session instead of replaying the conversation. A stop before the SDK had a session saves nothing.
   * A thread whose live query is still open reuses it on the next turn instead of resuming.
   */
  commitInterrupted(threadId: string, history: string): void {
    this.liveCommits.delete(threadId)
    this.recordBoundary(threadId, history)
    this.fingerprintInterruptedSession(threadId, history)
  }
  private fingerprintInterruptedSession(threadId: string, history: string): void {
    const sessionId = this.interruptedSessions.get(threadId)
    this.interruptedSessions.delete(threadId)
    const saved = this.settings.sessions?.[threadId]
    if (!sessionId || !saved || saved.sessionId !== sessionId) return
    saved.historyKey = historyKey(history)
    this.save()
  }
  /**
   * A turn failed (not a stop) after its message reached Claude. `history` is the canonical history as
   * the failed turn left it, which is what the next request will carry unless something is undone first.
   * A turn a usage limit ended also leaves its session resumable, like a stopped one.
   */
  commitFailed(threadId: string, history: string): void {
    this.recordBoundary(threadId, history)
    this.fingerprintInterruptedSession(threadId, history)
  }
  private recordBoundary(threadId: string, history: string): void {
    const live = this.live.get(threadId)
    if (live && !live.dead && live.meta.pushedFailed === true) live.meta.expectedKey = historyKey(history)
  }
  private commitObligations(threadId: string): void {
    const pending = this.liveCommits.get(threadId)
    this.liveCommits.delete(threadId)
    pending?.live.commit(pending.run)
  }
  /**
   * The host that runs the turns Claude starts on its own and reads a thread's background work; null
   * removes it. Without one, a turn Claude starts after a background task finished is read and
   * dropped, and its task is done.
   */
  setLiveHost(host: ClaudeLiveHost | null): void {
    this.liveHost = host
  }
  /** Whether Claude still has background agents or shells for the thread that owe it a notification. Synchronous, never throws. */
  hasBackgroundWork(threadId: string): boolean {
    const live = this.live.get(threadId)
    return Boolean(live && !live.dead && live.obligations.size > 0)
  }
  /**
   * Stop reaches Claude's process: the live query is closed, which ends its background agents and
   * shells, and the thread's obligations end with it. Works on a thread whose turn already ended.
   */
  stopThread(threadId: string): 'stopped' | 'not_active' {
    this.liveCommits.delete(threadId)
    const live = this.live.get(threadId)
    if (!live || live.dead) return 'not_active'
    this.questions.dismissAllForThread(threadId)
    live.close('closed')
    this.live.delete(threadId)
    return 'stopped'
  }
  /** Threads that hold a live Claude process (diagnostics and tests). */
  liveThreadIds(): string[] {
    return [...this.live].filter(([, live]) => !live.dead).map(([threadId]) => threadId)
  }
  private closeLive(reason: 'closed' | 'idle' | 'idle-cap' = 'closed'): void {
    for (const live of [...this.live.values()]) live.close(reason)
    this.live.clear()
    this.liveCommits.clear()
  }
  /** Closes the least recently used idle process with no background work; false when every one is needed. */
  private evictIdleLive(): boolean {
    let victim: LiveSession<TurnContext> | undefined
    for (const live of this.live.values()) {
      if (live.dead || live.busy || live.pendingRuns > 0 || live.obligations.size > 0 || this.activeThreads.has(live.threadId)) continue
      if (!victim || live.lastUsed < victim.lastUsed) victim = live
    }
    if (!victim) return false
    victim.close('idle')
    this.live.delete(victim.threadId)
    return true
  }
  /**
   * The thread's live process when this turn can use it: it was started for the same instance, folder,
   * model, effort, instructions, credential and read-only policy, and its conversation is the one this
   * turn continues. That is so when the saved history fingerprint matches (`resume` is its session),
   * or when the last turn on the process ended without saving one (a failure, a stop) and this
   * request's history is the boundary that turn left: the process holds exactly that, nothing was undone.
   */
  private reusableLive(threadId: string, hard: readonly unknown[], resume: string | undefined, historyNow: string): LiveSession<TurnContext> | undefined {
    const live = this.live.get(threadId)
    if (!live || live.dead || live.sessionId === undefined) return undefined
    if (JSON.stringify(hard) !== JSON.stringify(live.meta.hardParts)) return undefined
    // The history this request carries must be the one the process holds: the saved fingerprint says
    // so, or, after a turn that did not finish, the boundary that turn left (`expectedKey`). A history
    // that differs (an undo, an edit) is not what the process remembers.
    return resume === live.sessionId || (live.meta.expectedKey !== undefined && live.meta.expectedKey === historyNow) ? live : undefined
  }
  /**
   * The thread's live query for this turn: the open one when it is still the right one, a new one
   * otherwise, or undefined when the turn has to run as a one-shot query (live queries are at their
   * cap). A query that has background work is never replaced silently: a change that needs a new
   * process is refused, naming the change, because it would end that work.
   */
  private async acquireLive(
    threadId: string,
    key: { hard: readonly unknown[]; soft: string; mode: PermissionMode; historyNow: string },
    resume: string | undefined,
    create: (live: LiveSession<TurnContext>) => Options
  ): Promise<LiveSession<TurnContext> | undefined> {
    const timings = this.liveConfig
    if (!timings) return undefined
    let live = this.live.get(threadId)
    if (live?.dead) {
      this.live.delete(threadId)
      live = undefined
    }
    if (live) {
      const working = live.obligations.size
      const reusable = this.reusableLive(threadId, key.hard, resume, key.historyNow)
      // Launch settings and integrations apply the next time the process starts; pending work keeps this one.
      if (reusable && (live.meta.softKey === key.soft || working > 0)) return live
      if (working > 0) {
        const previous = (live.meta.hardParts as readonly unknown[] | undefined) ?? []
        const changed = HARD_PARTS.filter((_, index) => JSON.stringify(previous[index]) !== JSON.stringify(key.hard[index]))
        const cause = changed.length
          ? `The ${changed.join(' and ')} changed, which needs a new Claude process`
          : 'The conversation changed outside that process (an undo, an edit or a fork), so it cannot continue it'
        const tasks = working === 1 ? 'a background task' : `${working} background tasks`
        // Tasks Claude read whose reply was cut off (or could not be shown) are not running: the next message
        // clears them. They are told apart from the ones still running, which a change would end.
        const unshown = live.obligations.unshownCount()
        const unshownTasks = unshown === 1 ? 'a background task' : `${unshown} background tasks`
        const running = working - unshown
        const runningTasks = running === 1 ? 'a background task' : `${running} background tasks`
        const lost = live.obligations.lostCount()
        const others = working - lost
        const message = lost > 0
          ? `Claude is still holding ${lost === 1 ? 'a background task' : `${lost} background tasks`} for this thread whose ${lost === 1 ? 'result' : 'results'} may not arrive${others > 0 ? `, along with ${others === 1 ? 'another background task' : `${others} other background tasks`}` : ''}. ${cause} and would end that work. Press Stop to release ${working === 1 ? 'it' : 'them'} now, then send again.`
          : unshown > 0 && running === 0
            ? `Claude read the result of ${unshownTasks} for this thread, but ${unshown === 1 ? 'its reply was' : 'their replies were'} cut off or could not be shown. ${cause}. Send a message without the change to clear ${unshown === 1 ? 'it' : 'them'}, or press Stop, then send again.`
            : unshown > 0
              ? `Claude is still running ${runningTasks} for this thread, and read the result of ${unshown === 1 ? 'another background task' : `${unshown} other background tasks`}, whose ${unshown === 1 ? 'reply was' : 'replies were'} cut off or could not be shown. ${cause} and would end the running work (Stop ends it too). Wait for it to finish or press Stop, then send again.`
              : `Claude is still running ${tasks} for this thread. ${cause} and would end that work. Wait for it to finish or press Stop, then send again.`
        throw new AppError({
          code: 'claude_background_work_blocks_change',
          message,
          errorInfo: { category: 'unavailable', retryable: false }
        })
      }
      live.close('closed')
      this.live.delete(threadId)
    }
    if (this.live.size >= timings.maxSessions && !this.evictIdleLive()) return undefined
    const created = new LiveSession<TurnContext>(
      threadId,
      {
        backgroundWork: (active) => this.notifyHost(() => this.liveHost?.backgroundWork?.(threadId, active)),
        continuationStarted: (run, info) => this.continuationStarted(created, run, info),
        notice: (text) => this.notifyHost(() => this.liveHost?.notice?.(threadId, text)),
        ended: () => {
          if (this.live.get(threadId) === created) this.live.delete(threadId)
        }
      },
      timings
    )
    created.meta = { hardParts: key.hard, softKey: key.soft, permissionMode: key.mode }
    this.live.set(threadId, created)
    try {
      const query = await this.createQuery(created.queue, create(created))
      if (this.stopped || created.dead) {
        query.close()
        throw new Error('Claude provider is stopped')
      }
      created.attach(query)
    } catch (error) {
      created.close('closed')
      if (this.live.get(threadId) === created) this.live.delete(threadId)
      throw error
    }
    return created
  }
  private notifyHost(call: () => void): void {
    try {
      call()
    } catch (error) {
      console.warn('[claude-subscription] live host callback failed', error instanceof Error ? error.message : String(error))
    }
  }
  /**
   * Claude started a turn of its own: a background task finished. The host runs it as a run of the
   * thread; without a host it is stopped, and its tasks stay owed until the next committed turn on the
   * process clears them (Claude has read them by then) or Stop or the cap ends the process.
   */
  private continuationStarted(live: LiveSession<TurnContext>, run: LiveRun, info: { id: string; taskIds: string[]; summaries: string[] }): void {
    const host = this.liveHost
    if (host?.continuationStarted) {
      try {
        host.continuationStarted(live.threadId, info)
        return
      } catch (error) {
        console.warn('[claude-subscription] live host callback failed', error instanceof Error ? error.message : String(error))
      }
    }
    // Nothing can run the turn, so nobody would see it: it is stopped (Claude would otherwise run it
    // unattended, in bypass mode). Its tasks are discharged by the next turn that commits.
    live.discardContinuation(run)
  }
  /** The turn Claude started on its own that is running now on the thread (see `LiveSession.inFlightContinuation`). */
  inFlightContinuation(threadId: string): { id: string; discarded: boolean } | undefined {
    const live = this.live.get(threadId)
    return live && !live.dead ? live.inFlightContinuation() : undefined
  }
  /** Whether Claude started a turn of its own on the thread that no run has taken yet. */
  hasContinuation(threadId: string, id?: string): boolean {
    const live = this.live.get(threadId)
    return Boolean(live && !live.dead && live.hasUnclaimedContinuation(id))
  }
  /** The host could not run the turn Claude started on its own: it is stopped and dropped. */
  discardContinuations(threadId: string, id?: string): void {
    const live = this.live.get(threadId)
    if (!live) return
    // Only the turn the failing run belongs to: another waiting turn is another run's to take.
    if (id !== undefined) {
      const run = live.claimContinuation(id)
      if (run) live.discardContinuation(run)
      return
    }
    for (let run = live.claimContinuation(); run; run = live.claimContinuation()) live.discardContinuation(run)
  }
  /** Mousse's side of one turn's permission decisions; a live query reads the current turn's, not the first's. */
  private permissionCallbacks(turnOf: () => TurnContext): Pick<Options, 'hooks' | 'canUseTool'> {
    return {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (event) => {
                const turn = turnOf()
                // A locked turn: the grant gate decides, and a call it passes still goes to canUseTool.
                if (turn.locked && event.hook_event_name === 'PreToolUse') {
                  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } })
                  // Fails closed: Claude Code reads a hook that throws as no decision, and would go on.
                  try {
                    const args = (event.tool_input ?? {}) as Record<string, unknown>
                    const decided = turn.locked.preToolUse(event.tool_name, args)
                    if (!decided.ok) return deny(decided.reason)
                    await turn.editCounter.start(event.tool_use_id, event.tool_name, event.tool_input)
                    const stamped = turn.input.mcp && turn.input.mcpTurnToken && event.tool_name.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX)
                      ? { updatedInput: { ...args, [TURN_TOKEN_KEY]: turn.input.mcpTurnToken } }
                      : undefined
                    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', ...stamped } }
                  } catch {
                    return deny('This call could not be checked against the bot\'s permissions, so it does not run.')
                  }
                }
                // Hooks run in every permission mode, so the user's per-server tool limits hold
                // on unattended turns too.
                if (event.hook_event_name === 'PreToolUse' && claudeMcpToolBlocked(turn.integrations?.toolRules, event.tool_name))
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'This tool is turned off for this MCP server in Mousse.'
                    }
                  }
                // A delegated child's policy (no native subagents; read-only for a shared child).
                const childDenial = event.hook_event_name === 'PreToolUse' ? claudeChildToolDenial(turn.input.child, event.tool_name) : undefined
                if (childDenial)
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: childDenial
                    }
                  }
                if (event.hook_event_name === 'PreToolUse')
                  await turn.editCounter.start(event.tool_use_id, event.tool_name, event.tool_input)
                // Each Mousse call carries the token of the turn it is made in; the server refuses one made
                // for an earlier turn. Claude forwards the changed input to the server unchanged, and the
                // model never sees the key.
                const stamp = event.hook_event_name === 'PreToolUse' && turn.input.mcp && turn.input.mcpTurnToken &&
                  event.tool_name.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX)
                  ? { updatedInput: { ...(event.tool_input as Record<string, unknown>), [TURN_TOKEN_KEY]: turn.input.mcpTurnToken } }
                  : undefined
                // Restricted turns route every call through canUseTool so its read-only allowlist holds.
                // So does every command (and, under Ask, every edit) the thread's permission mode
                // does not allow without asking: the user's own allow rules must not skip Mousse's
                // check. Other tools (MCP tools, reads) follow Claude Code's own rules.
                const action = event.hook_event_name === 'PreToolUse' ? claudeActionOf(event.tool_name) : 'read'
                const modeAsks = (action === 'command' || action === 'edit') && !permissionModeAllows(turn.permissionMode, action)
                if (turn.restricted || modeAsks)
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', ...stamp } }
                return stamp ? { hookSpecificOutput: { hookEventName: 'PreToolUse', ...stamp } } : {}
              }
            ]
          }
        ],
        PostToolUse: [
          {
            hooks: [
              async (event) => {
                if (event.hook_event_name === 'PostToolUse') {
                  turnOf().locked?.committed(event.tool_use_id)
                  await turnOf().editCounter.success(event.tool_use_id, event.tool_response)
                }
                return {}
              }
            ]
          }
        ],
        PostToolUseFailure: [
          {
            hooks: [
              async (event) => {
                if (event.hook_event_name === 'PostToolUseFailure') {
                  turnOf().locked?.failed(event.tool_use_id)
                  turnOf().editCounter.failure(event.tool_use_id)
                }
                return {}
              }
            ]
          }
        ]
      },
      canUseTool: async (toolName, args, context) => {
        const turn = turnOf()
        const { input, controller } = turn
        if (controller.signal.aborted || context.signal.aborted)
          return { behavior: 'deny', message: 'Turn cancelled' }
        // A locked turn: the second, default-deny check, which writes a granted built-in's ledger row.
        if (turn.locked) {
          try {
            const decided = turn.locked.canUse(toolName, args, context.toolUseID)
            return decided.ok ? { behavior: 'allow', updatedInput: args } : { behavior: 'deny', message: decided.reason }
          } catch {
            return { behavior: 'deny', message: 'This call could not be checked against the bot\'s permissions, so it does not run.' }
          }
        }
        const childDenial = claudeChildToolDenial(input.child, toolName)
        if (childDenial) return { behavior: 'deny', message: childDenial }
        // Mousse's own tools are scoped by the run's credential (mode ceiling, caller thread);
        // the server refuses what the run may not do, so they need no extra prompt.
        if (input.mcp && toolName.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX))
          return { behavior: 'allow', updatedInput: args }
        // Claude Code defers MCP tool schemas behind ToolSearch; without it the Mousse tools above
        // are unreachable unless the user approves a prompt every turn. Any query is safe, even
        // with the user's own MCP servers loaded: ToolSearch only loads tool definitions, and each
        // tool it reveals is still checked here (or by the user's rules) when it is called.
        if (input.mcp && toolName === 'ToolSearch')
          return { behavior: 'allow', updatedInput: args }
        // (A read-only child's own allowlist is `claudeChildToolDenial`, above.)
        if (
          turn.planTurn &&
          !['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'].includes(toolName)
        )
          return {
            behavior: 'deny',
            message: 'This turn is planning only; edits and shell commands are disabled.'
          }
        try {
          if (toolName === 'AskUserQuestion') {
            if (input.approvals === 'never') return { behavior: 'deny', message: QUESTIONS_REFUSED_MESSAGE }
            const native = args.questions as
              | Array<{
                  question: string
                  options?: Array<{ label: string; description?: string }>
                  multiSelect?: boolean
                }>
              | undefined
            if (
              !Array.isArray(native) ||
              !native.length ||
              native.length > 4 ||
              native.some((item) => typeof item.question !== 'string')
            )
              return { behavior: 'deny', message: 'Invalid Claude question' }
            const answers = await this.questions.requestAnswers(
              native.map((item, index) => ({
                id: String(index),
                prompt: item.question,
                allowMultiple: item.multiSelect,
                options: (item.options ?? []).map((option) => ({
                  id: option.label,
                  label: option.label,
                  description: option.description
                }))
              })),
              input.threadId
            )
            if (controller.signal.aborted || context.signal.aborted)
              return { behavior: 'deny', message: 'Turn cancelled' }
            return {
              behavior: 'allow',
              updatedInput: {
                ...args,
                answers: Object.fromEntries(
                  native.map((item, index) => [
                    item.question,
                    Array.isArray(answers[String(index)])
                      ? (answers[String(index)] as string[]).join(', ')
                      : answers[String(index)]
                  ])
                )
              }
            }
          }
          if (turn.restricted) return { behavior: 'allow', updatedInput: args }
          // Only calls Claude Code refuses to auto-approve even in bypass mode arrive here.
          if (input.approvals === 'never') return { behavior: 'deny', message: APPROVALS_REFUSED_MESSAGE }
          const action = claudeActionOf(toolName)
          // Reading never asks under Ask or Auto-accept edits: Claude Code reaches here only for what
          // it does not allow itself, and a read-only built-in changes nothing.
          if (action === 'read' && turn.permissionMode !== 'full') return { behavior: 'allow', updatedInput: args }
          // Under Full access a call that reaches here is Claude Code's own refusal to auto-approve
          // (its safety check), which Mousse cannot skip; the prompt says so. The full command text is
          // kept up to the cap: the card wraps and scrolls.
          const what = action === 'command' ? `run a command (${toolName})` : action === 'edit' ? `edit files (${toolName})` : `use ${toolName}`
          const own = turn.permissionMode === 'full' ? 'Claude Code asks even in Full access: its own safety check.\n' : ''
          // Claude Code says when an ask must not be remembered (a safety check, a path outside the allowed folders, a
          // rule that forces a person's answer): that holds in every mode, so there is no "always" and no rule for it.
          const unskippable = context.suppressAlwaysAllowRule === true || Boolean(context.blockedPath) || Boolean(context.decisionReason) || context.matchedAskRule !== undefined
          const reason = own
            ? 'Claude Code asks even in Full access: its own safety check.'
            : unskippable
              ? `Claude Code asks for this itself and does not allow it to be remembered${context.decisionReason ? `: ${context.decisionReason.slice(0, 300)}` : '.'}`
              : ''
          const answer = await this.questions.requestAnswers(
            [
              {
                id: 'permission',
                prompt: `${own}Allow Claude Code to ${what}?\n${JSON.stringify(args).slice(0, 4000)}`,
                options: [
                  { id: 'allow', label: 'Allow once' },
                  { id: 'reject', label: 'Reject' }
                ]
              }
            ],
            input.threadId,
            {
              approval: {
                action: action === 'read' ? 'tool' : action,
                permissionKey: claudePermissionKey(toolName),
                options: [
                  { id: 'allow', decision: 'allow', scope: 'once' },
                  { id: 'reject', decision: 'reject' }
                ],
                // The folder is the turn's own, as given: a path with dot segments names no exact place.
                tool: { name: toolName, input: args, ...(exactDirectory(undefined, input.cwd) ? { cwd: exactDirectory(undefined, input.cwd)! } : {}) },
                ...(reason ? { reason } : {})
              }
            }
          )
          if (
            controller.signal.aborted ||
            context.signal.aborted ||
            answer.permission !== 'allow'
          ) {
            // The user's reason (a denial with a message, or a message that denied the request) goes to the agent.
            const why = typeof answer.feedback === 'string' ? answer.feedback.trim().slice(0, 1000) : ''
            return { behavior: 'deny', message: why ? `Permission rejected: ${why}` : 'Permission rejected' }
          }
          return { behavior: 'allow', updatedInput: args }
        } catch {
          return { behavior: 'deny', message: 'Permission dismissed' }
        }
      }
    }
  }
  async chat(input: ClaudeSubscriptionChatInput): Promise<string> {
    input.signal?.throwIfAborted()
    if (this.checkDue()) {
      // Reserve the thread while the sign-in check runs so a second turn cannot slip in.
      if (this.activeThreads.has(input.threadId))
        throw new Error('A Claude turn is already running for this thread')
      this.activeThreads.add(input.threadId)
      try {
        await this.status()
      } finally {
        this.activeThreads.delete(input.threadId)
      }
      input.signal?.throwIfAborted()
    }
    // The folder's settings are read before anything starts; whether the instance may run is checked
    // after, so a sign-out while they are read stops the turn here.
    let turnSettings: SdkSettings | undefined
    // A locked turn loads no folder settings, so there is nothing to pin over them (and its scratch
    // folder, which the bot writes, must not be able to refuse its later turns).
    if (this.dependencies.turnSettings && !input.locked) {
      const policy = await this.dependencies.turnSettings(input.cwd)
      input.signal?.throwIfAborted()
      if (policy.refuse) throw new AppError({ code: 'claude_settings_conflict', message: policy.refuse, errorInfo: { category: 'unavailable', retryable: false } })
      turnSettings = policy.settings
    }
    if (!this.configured()) throw new AppError({ code: 'claude_subscription_not_connected', message: this.signInRequiredMessage(), errorInfo: { category: 'unavailable', retryable: false } })
    if (this.activeThreads.has(input.threadId))
      throw new Error('A Claude turn is already running for this thread')
    const locked = input.locked
    if (locked && (!this.dependencies.lockedEnv || input.continuation))
      throw new AppError({
        code: 'policy_unenforceable',
        message: input.continuation ? 'A bot turn never continues work Claude Code started itself.' : 'This Claude Code entry is not locked, so it cannot run a bot.',
        errorInfo: { category: 'unavailable', retryable: false }
      })
    this.activeThreads.add(input.threadId)
    // A locked turn takes none of the user's MCP servers or skills.
    const integrations = locked ? undefined : input.integrations
    // User MCP servers reference their secrets as `${VAR}`; the values ride in Claude's environment.
    // A locked turn's environment is built from nothing (`lockedEnv`), with the instance's key last.
    const env = locked ? this.finalEnv(this.dependencies.lockedEnv!(locked.cwd)) : this.finalEnv({ ...this.environment(), ...integrations?.env })
    // This turn's own controller: it gates the turn's permission prompts and hooks and carries its
    // cancellation. A one-shot query also hands it to the SDK; a live query has a lifetime of its own.
    const controller = new AbortController()
    this.controllers.add(controller)
    let query: Query | undefined
    let live: LiveSession<TurnContext> | undefined
    let liveRun: LiveRun | undefined
    /** The turn failed with a usage limit: its request is in the session, whatever evidence classified it. */
    let usageLimited = false
    const cancel = () => {
      controller.abort()
      // A live query outlives the turn: the turn is interrupted, and only Stop, an idle release or a
      // replacement closes the query.
      if (live && liveRun) live.abandon(liveRun)
      else query?.close()
      this.questions.dismissAllForThread(input.threadId)
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    this.readyToCommit.delete(input.threadId)
    this.interruptedSessions.delete(input.threadId)
    // A turn that finished but was never committed still consumed its notifications.
    this.commitObligations(input.threadId)
    // What this turn leaves behind is its own: a turn that fails before pushing leaves nothing to continue from.
    const previous = this.live.get(input.threadId)
    if (previous && !input.continuation) previous.meta.pushedFailed = false
    const instanceId = input.instanceId ?? CLAUDE_INSTANCE_ID
    // A native session belongs to one instance; another instance starts fresh.
    const stored = this.settings.sessions?.[input.threadId]
    const saved = stored && sessionBoundTo(stored, instanceId) ? stored : undefined
    const resume =
      saved?.cwd === resolve(input.cwd) && saved.model === parseThinkingSuffixFromModelId(input.model).baseId && saved.historyKey === historyKey(input.history ?? '')
        ? saved.sessionId
        : undefined
    const metrics = new ClaudeMetricsCollector(resume, saved?.usageBaseline)
    const editCounter = new ClaudeNativeEditCounter(input.cwd, input.onLineEdits)
    const savedHistoryKey = stored?.historyKey
    if (stored) {
      delete stored.historyKey
      this.save()
    }
    const frames = new TurnFrames(input, metrics)
    let success = false
    const steers: string[] = []
    let steerTimer: ReturnType<typeof setInterval> | undefined
    let interruptRequested = false
    const collectSteer = () => {
      if (controller.signal.aborted) return
      if (liveRun && (liveRun.settled || liveRun.abandoned || liveRun.resultSeen)) return
      const drained = input.drainSteerEntry ? input.drainSteerEntry() : undefined
      const steer = (drained ? drained.text : input.drainSteer?.())?.trim()
      if (!steer) return
      if (live && liveRun) {
        // A live turn is steered without interrupting it: the text joins the stream as an immediate
        // message, and background helpers keep running.
        this.questions.autoRejectPendingForThread(input.threadId)
        void live.steer(liveRun, steer).then((pushed) => {
          if (pushed) {
            input.steerTaken?.(drained?.token)
            input.onSteer?.(steer)
            frames.breakParagraph()
          } else input.returnSteer?.(steer, drained?.token)
        }, () => cancel())
        return
      }
      steers.push(steer)
      input.onSteer?.(steer)
      if (query && !interruptRequested) {
        interruptRequested = true
        this.questions.autoRejectPendingForThread(input.threadId)
        void query.interrupt().catch(() => cancel())
      }
    }
    // Claude Code holds a turn after a rejected plan window and may never answer it: past the hold
    // time Mousse interrupts the turn itself. The turn's own controller stays untouched, so a user
    // Stop remains distinct, and the result that follows is read as the usage limit.
    const endHeldTurn = () => {
      const seen = liveRun ? liveRun.rateLimits : frames.rateLimits
      if (seen.hold || controller.signal.aborted || (liveRun && (liveRun.settled || liveRun.abandoned || liveRun.resultSeen))) return
      if (!seen.held(Date.now(), this.dependencies.usageLimitHoldMs ?? USAGE_LIMIT_HOLD_MS)) return
      seen.hold = true
      if (live && liveRun) void live.interrupt().catch(() => undefined)
      else if (query) void query.interrupt().catch(() => cancel())
    }
    const planTurn = input.mode === 'plan'
    const readOnlyChild = input.child?.readOnly === true
    // Plan turns and read-only children route every call through the hook and canUseTool's
    // read-only allowlist. A read-only child keeps the default permission mode: plan mode would
    // inject its planning and ExitPlanMode flow into a research or review task.
    const restricted = planTurn || readOnlyChild
    // Full access needs Claude Code to allow bypassing permissions. The gateway already lowers the
    // mode when the user's settings forbid it; reading them again here keeps a settings edit made
    // since then from ever starting a bypass Claude Code would refuse.
    const bypassDisabled = claudeBypassDisabled(this.environment(), { cwd: input.cwd })
    const requestedMode = normalizePermissionMode(input.permissionMode)
    const threadMode: ThreadPermissionMode = requestedMode === 'full' && bypassDisabled ? 'accept_edits' : requestedMode
    const turn: TurnContext = { input, controller, integrations, editCounter, planTurn, restricted, permissionMode: threadMode, ...(locked ? { locked: new ClaudeLockedGate(locked, Boolean(input.mcp)) } : {}) }
    try {
      const signedIn = await this.authenticated(controller.signal, env)
      if (!signedIn)
        throw new AppError({ code: 'claude_subscription_sign_in_required', message: this.signInRequiredMessage(), errorInfo: { category: 'unavailable', retryable: false } })
      controller.signal.throwIfAborted()
      input.signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      const selected = parseThinkingSuffixFromModelId(input.model)
      const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(selected.effort ?? '')
        ? selected.effort as Options['effort'] : undefined
      // The thread's permission mode, in Claude Code's own terms: Ask asks about everything it would
      // not allow itself, Auto-accept edits lets edits through, Full access bypasses its checks.
      const permissionMode: PermissionMode = planTurn
        ? 'plan'
        : readOnlyChild
          ? 'default'
          : { ask: 'default', accept_edits: 'acceptEdits', full: 'bypassPermissions' }[threadMode] as PermissionMode
      const launchAppend = locked ? [] : claudeLaunchAppendSystemPrompt(claudeExtraArgs(storedCliArgs(this.launchSettings())), input.cwd)
      const appendTexts = [input.systemPromptAppend ?? '', ...launchAppend]
      // What a live process is started for (`HARD_PARTS`); a process the turn can reuse already holds the conversation.
      const hard = [
        instanceId,
        resolve(input.cwd),
        selected.baseId,
        effort ?? null,
        appendTexts.filter(Boolean).join('\n\n'),
        input.mcp ? [input.mcp.url, input.mcp.token] : null,
        readOnlyChild
      ]
      const historyNow = historyKey(input.history ?? '')
      const reuse = !input.continuation && this.reusableLive(input.threadId, hard, resume, historyNow) !== undefined
      const prompt = (input.turnPreamble ? input.turnPreamble + '\n\nCurrent request:\n' : '') +
        (!resume && !reuse && input.history
          ? `Previous conversation (context only; do not repeat earlier actions):\n${input.history}\n\nCurrent request:\n`
          : '') + input.prompt
      const content: SDKUserMessage['message']['content'] = [
        { type: 'text', text: prompt || '(image attachment)' }
      ]
      for (const image of input.images ?? []) {
        if (
          !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType) ||
          Buffer.byteLength(image.data, 'base64') > 10 * 1024 * 1024
        )
          throw new Error(`Unsupported Claude image: ${image.name}`)
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType as 'image/png', data: image.data }
        })
      }
      const userMessage = (sessionId: string): SDKUserMessage => ({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: sessionId
      })
      const messages = async function* (): AsyncGenerator<SDKUserMessage> {
        yield userMessage(resume ?? '')
      }
      const buildOptions = (sdkController: AbortController, turnOf: () => TurnContext, isLive: boolean): Options => ({
        // Mousse's instructions first, then the user's own append text.
        ...this.options(input.cwd, sdkController, env, appendTexts, turnSettings),
        model: selected.baseId,
        effort,
        resume,
        permissionMode,
        // A live query can switch to bypass on a later turn even when it starts in plan or ask mode,
        // unless Claude Code's settings forbid bypassing permissions at all.
        ...(permissionMode === 'bypassPermissions' || (isLive && !readOnlyChild && !bypassDisabled) ? { allowDangerouslySkipPermissions: true } : {}),
        // The Mousse server keeps its name: user servers are spread first.
        mcpServers: {
          ...integrations?.mcpServers,
          // Servers that sign in with OAuth run in this process and call Mousse's own connection.
          ...Object.fromEntries(Object.entries(integrations?.proxiedServers ?? {}).map(([name, proxied]) => [name, claudeProxiedMcpServer(name, proxied)])),
          ...claudeMcpServers(input.mcp)
        },
        // The skills enabled in Mousse reach Claude as a local plugin, next to the user's own.
        ...(integrations?.pluginPath ? { plugins: [{ type: 'local' as const, path: integrations.pluginPath }] } : {}),
        ...this.permissionCallbacks(turnOf)
      })
      // A locked turn: the locked profile over everything above, and nothing that would widen it.
      const lockedOptions = (sdkController: AbortController, turnOf: () => TurnContext): Options => {
        const options: Options = {
          ...buildOptions(sdkController, turnOf, false),
          ...claudeLockedOptions(locked!, {
            env,
            mcpServers: claudeMcpServers(input.mcp),
            mousseTools: Boolean(input.mcp),
            spawn: claudeLockedSpawn(locked!.onProcess ? { onProcess: locked!.onProcess } : {})
          })
        }
        for (const name of CLAUDE_LOCKED_REMOVED_OPTIONS) delete options[name]
        // The same thread's own session resumes; nothing else is carried over.
        if (resume) options.resume = resume
        return options
      }
      // A steer collected before the live run exists would have nowhere to go, so a live turn starts
      // polling only once its message is pushed.
      const startSteering = (): void => {
        if (steerTimer) return
        steerTimer = setInterval(() => {
          try {
            collectSteer()
            endHeldTurn()
          } catch {
            cancel()
          }
        }, 100)
      }
      if (input.continuation) {
        // Claude started this turn itself: it joins the one already in flight and pushes no prompt.
        live = this.live.get(input.threadId)
        const wake = live && !live.dead ? live.claimContinuation(input.continuationId) : undefined
        if (!live || !wake) throw new Error('Claude has no turn of its own to continue for this thread')
        liveRun = wake
        live.current = turn
        // The user may have changed the thread's mode since the turn that left this work running: the
        // process must not carry on in the wider one. If it cannot be switched, the turn fails.
        if (live.meta.permissionMode !== permissionMode) {
          await live.setPermissionMode(permissionMode)
          live.meta.permissionMode = permissionMode
        }
        metrics.beginQuery(live.sessionId, saved?.usageBaseline)
        liveRun.attach((message) => frames.observe(message))
      } else {
        const key = { hard, soft: this.launchKey(env, integrations, turnSettings), mode: permissionMode, historyNow }
        try {
          // A bot's process is never kept warm: a locked turn is one query.
          live = locked ? undefined : await this.acquireLive(input.threadId, key, resume, (created) => {
            created.current = turn
            return buildOptions(created.lifetime, () => created.current ?? turn, true)
          })
        } catch (error) {
          // A refused change started nothing: the conversation is as it was, so the next request can resume it.
          // Mousse keeps the refused message in the transcript, so the history the next request carries has
          // it; the adapter reports that boundary (`commitFailed`), and the process, which never saw the
          // message, continues from there without replaying it.
          if (error instanceof AppError && error.code === 'claude_background_work_blocks_change') {
            if (stored && savedHistoryKey) {
              stored.historyKey = savedHistoryKey
              this.save()
            }
            const refusing = this.live.get(input.threadId)
            // Only when the history before the refused request is what the process holds (only the new message
            // differs) may the next request continue from the boundary the refusal leaves. An undo or an edit
            // changed what the process remembers: that stays refused until the helpers finish or Stop.
            const historyHeld =
              (savedHistoryKey !== undefined && savedHistoryKey === historyKey(input.history ?? '') && stored?.sessionId === refusing?.sessionId) ||
              (refusing?.meta.expectedKey !== undefined && refusing.meta.expectedKey === historyKey(input.history ?? ''))
            if (refusing && !refusing.dead && historyHeld) refusing.meta.pushedFailed = true
          }
          throw error
        }
        // Held until the run exists, so the idle release cannot close the process in between.
        const hold = live?.reserve()
        try {
          controller.signal.throwIfAborted()
          if (live) {
            live.current = turn
            // The permission mode follows the composer: a live query switches it for this turn.
            if (live.meta.permissionMode !== permissionMode) {
              await live.setPermissionMode(permissionMode)
              live.meta.permissionMode = permissionMode
              controller.signal.throwIfAborted()
            }
            liveRun = live.beginRun((message) => frames.observe(message))
            // A cancel under way (another turn was cut off) would sweep this prompt up; wait for it.
            for (;;) {
              try {
                live.push(liveRun, userMessage(live.sessionId ?? resume ?? ''))
                break
              } catch (error) {
                if (!(error instanceof CancelInProgress)) throw error
                // The wait ends with this turn's own cancellation too, not only with the cancel it waits for.
                await Promise.race([
                  live.afterCancel(),
                  new Promise<never>((_, reject) => {
                    if (controller.signal.aborted) reject(controller.signal.reason ?? new Error('Turn cancelled'))
                    else controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('Turn cancelled')), { once: true })
                  })
                ])
                controller.signal.throwIfAborted()
              }
            }
          }
        } finally {
          hold?.()
        }
      }
      if (live && liveRun) {
        startSteering()
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(controller.signal.reason ?? new Error('Turn cancelled'))
          if (controller.signal.aborted) fail()
          else controller.signal.addEventListener('abort', fail, { once: true })
        })
        aborted.catch(() => undefined)
        let outcome: Awaited<typeof liveRun.done>
        try {
          outcome = await Promise.race([liveRun.done, aborted])
        } catch (error) {
          // The interrupt that ended a held turn may end the query with an error instead of a result.
          if (liveRun.rateLimits.hold && !controller.signal.aborted && !(error instanceof AppError && error.code === 'provider_usage_limit')) throw usageLimitFromWindows(liveRun.rateLimits)
          throw error
        }
        controller.signal.throwIfAborted()
        const result = outcome.result
        if (result) {
          const failure = claudeResultFailure(result, liveRun.rateLimits)
          if (failure) throw failure
          if (frames.segmentEmpty && 'result' in result) {
            frames.text += result.result
            input.onText(frames.text)
          }
        } else if (liveRun.rateLimits.hold) {
          // The interrupt that ended a held turn left no result.
          throw usageLimitFromWindows(liveRun.rateLimits)
        } else if (outcome.reason === 'folded') {
          // A wake Claude folded a message of ours into has no turn of its own; the message got the answer.
          throw new AppError({
            code: 'claude_continuation_folded',
            message: 'Claude answered this wake together with a message of yours; it has no turn of its own.',
            errorInfo: { category: 'cancelled', retryable: false }
          })
        } else if (outcome.reason === 'deadline') {
          frames.text = 'A background task finished, but Claude did not respond to it.'
          input.onText(frames.text)
        }
        frames.sessionId ??= live.sessionId
        success = true
        live.meta.expectedKey = undefined
        live.meta.pushedFailed = false
      } else {
        // A one-shot query: the prompt ends with the turn, which ends the process.
        startSteering()
        let nextPrompt: AsyncIterable<SDKUserMessage> = messages()
        const options = locked ? lockedOptions(controller, () => turn) : buildOptions(controller, () => turn, false)
        for (;;) {
          const turnTextLength = frames.text.length
          query = await this.createQuery(nextPrompt, options)
          this.queries.set(input.threadId, query)
          try {
            for await (const message of query) {
              if (controller.signal.aborted) metrics.observe(message)
              controller.signal.throwIfAborted()
              frames.observe(message)
              if (message.type === 'result') {
                if (
                  (message.subtype !== 'success' || message.is_error || frames.rateLimits.hold) &&
                  !(interruptRequested && steers.length)
                )
                  throw claudeResultFailure(message, frames.rateLimits)
                if (frames.text.length === turnTextLength && 'result' in message) {
                  frames.text += message.result
                  input.onText(frames.text)
                }
                success = true
              }
            }
          } catch (error) {
            // The query may end with an error of its own after the interrupt that ended a held turn.
            if (frames.rateLimits.hold && !controller.signal.aborted && !(error instanceof AppError && error.code === 'provider_usage_limit')) throw usageLimitFromWindows(frames.rateLimits)
            // The SDK throws after the error result an interrupt produces; a steer resumes from here.
            if (!(interruptRequested && steers.length) || controller.signal.aborted) throw error
          }
          // The interrupt that ended a held turn may end the stream without a result.
          if (frames.rateLimits.hold && !success && !controller.signal.aborted) throw usageLimitFromWindows(frames.rateLimits)
          const completed = query
          query = undefined
          collectSteer()
          completed.close()
          if (!steers.length) break
          controller.signal.throwIfAborted()
          const sessionId = frames.sessionId
          if (!sessionId) throw new Error('Claude steering could not identify the active session')
          options.resume = sessionId
          metrics.beginQuery(sessionId)
          const guidance = steers.splice(0).join('\n')
          nextPrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
            yield {
              type: 'user',
              message: { role: 'user', content: guidance },
              parent_tool_use_id: null,
              session_id: sessionId
            }
          })()
          interruptRequested = false
          success = false
          if (frames.text) frames.text += '\n\n'
        }
      }
      input.signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      const sessionId = frames.sessionId
      if (!success || !sessionId) throw new Error('Claude Code ended before completing the turn')
      this.settings.sessions = {
        ...this.settings.sessions,
        [input.threadId]: { sessionId, cwd: resolve(input.cwd), model: selected.baseId, usageBaseline: metrics.snapshot(), instanceId }
      }
      this.save()
      this.readyToCommit.add(input.threadId)
      if (live && liveRun) this.liveCommits.set(input.threadId, { live, run: liveRun })
      return frames.text
    } catch (error) {
      if (readUsageLimit(error)) usageLimited = true
      throw error
    } finally {
      // Only this turn's controller: a live query is not the turn's to abort.
      controller.abort()
      // Background helpers keep calling tools after the turn ended, or was cancelled: they are checked by
      // this turn's policy under a controller of their own, until the next turn replaces it.
      if (live && live.current === turn) live.current = { ...turn, controller: new AbortController() }
      if (live && liveRun) {
        // A turn that ended without finishing still read what its result carried; a cancelled one did not.
        if (!liveRun.settled) live.abandon(liveRun)
        else if (!success) live.commit(liveRun)
        // No history fingerprint was saved for a turn that did not finish. If its message reached the
        // process, the adapter reports the history boundary it left (`commitFailed`, `commitInterrupted`),
        // and only a request that starts from it continues on this process (see `reusableLive`).
        if (!success && liveRun.ids.size > 0) live.meta.pushedFailed = true
      } else query?.close()
      this.queries.delete(input.threadId)
      this.controllers.delete(controller)
      this.activeThreads.delete(input.threadId)
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', cancel)
      const report = metrics.report()
      try {
        const baseline = metrics.snapshot()
        const sessionId = frames.sessionId
        // A turn the user stopped, or that a usage limit ended, once the SDK had a session: its request is in
        // that session, and the adapter may fingerprint it (`commitInterrupted`, `commitFailed`).
        const stopped = !success && sessionId !== undefined && (input.signal?.aborted === true || usageLimited)
        const savedSessionId = baseline?.sessionId ?? (stopped ? sessionId : undefined)
        if (savedSessionId && this.configured()) {
          const current = this.settings.sessions?.[input.threadId]
          this.settings.sessions = {
            ...this.settings.sessions,
            [input.threadId]: {
              ...(current?.sessionId === savedSessionId ? current : {}),
              sessionId: savedSessionId,
              cwd: resolve(input.cwd),
              // A stopped turn saves no model of its own, and the next turn resumes only on the same one.
              model: parseThinkingSuffixFromModelId(input.model).baseId,
              ...(baseline ? { usageBaseline: baseline } : {}),
              instanceId
            }
          }
          this.save()
          if (stopped) this.interruptedSessions.set(input.threadId, savedSessionId)
        }
      } finally {
        input.onMetrics?.(report)
      }
      // A turn that was stopped or failed stopped its open calls; one that settled never got their results.
      frames.closeTools(success && input.signal?.aborted !== true ? 'no_result' : 'stop')
    }
  }
  /** What a new process would start with besides the turn's model and folder: launch settings and integrations. */
  private launchKey(env: NodeJS.ProcessEnv, integrations: ClaudeTurnIntegrations | undefined, settings?: SdkSettings): string {
    const launch = this.launchTarget()
    return createHash('sha256')
      .update(
        JSON.stringify([
          launch?.path,
          launch?.command,
          launch?.args,
          claudeExtraArgs(storedCliArgs(this.launchSettings())),
          Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)),
          integrations?.mcpServers,
          Object.entries(integrations?.proxiedServers ?? {}).map(([name, proxied]) => [name, proxied.tools]),
          integrations?.pluginPath,
          settings ?? null
        ])
      )
      .digest('hex')
  }
  /**
   * Disconnects this profile. Only Mousse-side state is cleared: the terminal sign-in is shared
   * with the user's own `claude`, so `claude auth logout` never runs here. (An instance with its own
   * home signs out in that home first: `claudeCodeDriver`.) The gateway keeps the signed-out flag in
   * the instance config (and mirrors it to `settings.json`).
   */
  async logout(): Promise<void> {
    this.settings.sessions = {}
    // Everything running stops first, whatever saving does next: a turn, a warm process and its
    // helpers, a sign-in. A failed save is reported after.
    this.abortInFlight()
    this.save()
  }
  /**
   * Another service of this instance writes its settings from now on (its home changed): this one
   * finishes its turns but never writes the file again, so one file never has two writers.
   */
  freezeSettings(): void {
    this.settingsFrozen = true
  }
  /**
   * Takes the sign-in the CLI now holds as this instance's: ends every turn and live query that
   * started under the old one, and asks `claude auth status` again with no cached result, whatever
   * Mousse has flagged (the gateway clears a sign-out flag once the sign-in succeeded). True when
   * the home reads signed in.
   */
  async reconnect(): Promise<boolean> {
    this.abortInFlight()
    this.cliProbe = undefined
    return this.authenticated()
  }
  stop(): void {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
    for (const session of this.loginSessions) session.abort.abort()
    for (const [threadId, query] of this.queries) {
      query.close()
      this.questions.dismissAllForThread(threadId)
    }
    this.queries.clear()
    for (const threadId of this.live.keys()) this.questions.dismissAllForThread(threadId)
    this.closeLive()
    this.readyToCommit.clear()
  }
}

/** `resultFailure`, except that a plan usage limit (or a turn Mousse ended because Claude Code held it) is a `provider_usage_limit`. */
function claudeResultFailure(message: SDKResultMessage, seen: RejectedWindows): Error | undefined {
  return usageLimitFromResult(message, seen) ?? resultFailure(message)
}

/** The error a result frame stands for, or undefined when the turn succeeded. */
function resultFailure(message: SDKResultMessage): Error | undefined {
  if (message.subtype === 'success' && !message.is_error) return undefined
  const failure = 'errors' in message ? message.errors.join('\n') : 'Claude Code turn failed'
  if (/Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh/i.test(failure)) {
    return new AppError({
      code: 'claude_subscription_auth_refresh_busy',
      message: 'Claude is refreshing your subscription sign-in. Your conversation is saved. Wait a minute and send your message again; if this continues, reconnect Claude Subscription in Settings → Providers.',
      errorInfo: { category: 'unavailable', retryable: true }
    })
  }
  return new Error(failure)
}
