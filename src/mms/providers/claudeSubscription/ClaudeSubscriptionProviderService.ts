import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ModelInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeSubscriptionStatus,
  CliProviderConfig,
  CliProviderConfigPatch,
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult,
  ProviderUsage
} from '../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../shared/settings'
import type { ChatImageAttachment } from '../../../shared/types'
import { parseThinkingSuffixFromModelId } from '../../../shared/modelVariants'
import { AppError } from '../../../shared/errors'
import { CLAUDE_INSTANCE_ID } from '../../../shared/providerInstances'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { CLAUDE_MOUSSE_TOOL_PREFIX, claudeMcpServers } from '../../run/mcp/attachment'
import type { LoginSession } from '../LoginSession'
import {
  applyCliConfigPatch,
  claudeExtraArgs,
  cliLaunch,
  requireExecutable,
  sharedCliVersions,
  storedCliArgs,
  storedCliEnv,
  withUserEnv,
  type CliLaunch,
  type CliVersionCache
} from '../cliConfig'
import { resolveWindowsShim } from '../resolveWindowsShim'
import {
  ClaudeMetricsCollector,
  ClaudeNativeEditCounter,
  type ClaudeSubscriptionMetrics,
  type ClaudeUsageBaseline
} from './metrics'
import { parseClaudeSubscriptionUsage } from './usage'
import { claudeMcpToolBlocked, claudeProxiedMcpServer, type ClaudeTurnIntegrations } from './integrations'

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = 'claude-subscription'
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
  /** Disconnected in Mousse; the terminal sign-in stays intact. */
  cliDisconnected?: boolean
  binaryPath?: string
  /** Extra Claude Code launch args (long options only; passed as the SDK's `extraArgs`). */
  args?: string[]
  /** Extra environment variables, applied over the subscription environment. */
  env?: Record<string, string>
  models?: LlmModelOption[]
  sessions?: Record<string, SavedSession>
}
export type ClaudeSubscriptionChatInput = {
  threadId: string
  /** Provider instance running the turn; a saved session resumes only on the same instance. */
  instanceId?: string
  cwd: string
  model: string
  prompt: string
  appletInstructions?: string
  history?: string
  images?: ChatImageAttachment[]
  signal?: AbortSignal
  mode?: 'plan' | 'default'
  /** The Mousse MCP server for this run (SPEC §15.2); null attaches no server. */
  mcp?: { url: string; token: string } | null
  /** Mousse's own instructions, appended to Claude Code's system prompt. */
  systemPromptAppend?: string
  /** The MCP servers and skills the user enabled in Mousse; absent attaches none. */
  integrations?: ClaudeTurnIntegrations
  onText: (text: string) => void
  onThinking?: (text: string) => void
  onMetrics?: (report: ClaudeSubscriptionMetrics) => void
  onLineEdits?: (lines: number) => void
  drainSteer?: () => string | undefined
  onSteer?: (text: string) => void
  onTool?: (event: {
    phase: 'start' | 'complete'
    callId: string
    title: string
    toolName?: string
  }) => void
}
type Dependencies = {
  query?: (input: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => Query
  runAuth?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ) => Promise<string>
  /** `claude --version` lookups (tests). */
  versions?: CliVersionCache
}
type AuthProbe =
  | { kind: 'signed_in' }
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
  private readonly settingsPath: string
  private settings: Settings = {}
  /** Set when settings.json exists but cannot be read; blocks migration and every write. */
  private settingsError?: string
  private stopped = false
  private readonly queries = new Map<string, Query>()
  private readonly readyToCommit = new Set<string>()
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
    private readonly profileHome: string,
    private readonly questions: UserQuestionService,
    private readonly dependencies: Dependencies = {}
  ) {
    this.settingsPath = join(
      profileHome,
      'providers',
      CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      'settings.json'
    )
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
    const directory = join(this.profileHome, 'providers', CLAUDE_SUBSCRIPTION_PROVIDER_ID, 'workspaces', historyKey(threadId))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  private save(): void {
    if (this.settingsError) return
    mkdirSync(dirname(this.settingsPath), { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(this.settingsPath, this.settings)
    this.policyStored = true
  }
  /** How to start Claude Code: the chosen or detected executable, with an npm shim resolved. */
  private launchTarget(): CliLaunch | undefined {
    return cliLaunch(this.settings.binaryPath || binaryOnPath())
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
    return withUserEnv(claudeSubscriptionEnvironment(), storedCliEnv(this.settings))
  }
  /** The executable path, launch args and environment set in Settings → Providers. */
  async cliConfig(): Promise<CliProviderConfig> {
    const launch = this.launchTarget()
    return {
      instanceId: CLAUDE_INSTANCE_ID,
      ...(this.settings.binaryPath ? { binaryPath: this.settings.binaryPath } : {}),
      ...(launch ? { resolvedBinaryPath: launch.path } : {}),
      version: await (this.dependencies.versions ?? sharedCliVersions).version(launch, this.environment()),
      args: storedCliArgs(this.settings),
      env: storedCliEnv(this.settings)
    }
  }
  /**
   * Saves the launch settings. Each turn starts its own Claude Code process, so the next turn uses
   * them; a changed executable re-checks the sign-in.
   */
  async setCliConfig(patch: CliProviderConfigPatch): Promise<CliProviderConfig> {
    if (this.stopped) throw new Error('Claude provider is stopped')
    if (this.settingsError) throw new Error(this.settingsError)
    const before = this.binary()
    applyCliConfigPatch(
      this.settings,
      patch,
      (path) => requireExecutable(path, 'Claude Code'),
      (args) => void claudeExtraArgs(args)
    )
    this.save()
    if (this.binary() !== before) await this.status({ force: true })
    return this.cliConfig()
  }
  /**
   * Synchronous view for routing and listings. It reflects the last live `claude auth status`
   * check (see `status()`).
   */
  configured(): boolean {
    if (this.stopped || this.settingsError || this.settings.cliDisconnected || !this.binary()) return false
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
    let status: { loggedIn?: unknown }
    try {
      status = JSON.parse(output) as typeof status
    } catch {
      return unreadable
    }
    if (typeof status?.loggedIn !== 'boolean') return unreadable
    if (!status.loggedIn)
      return {
        kind: 'signed_out',
        message: "Claude Code isn't signed in. Run `claude auth login` in a terminal, then check again."
      }
    return { kind: 'signed_in' }
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
    if (this.stopped || this.settingsError || this.settings.cliDisconnected) return false
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
      void this.refreshModels(join(this.profileHome, 'providers', CLAUDE_SUBSCRIPTION_PROVIDER_ID)).catch(
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
    if (this.settings.cliDisconnected)
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
        this.settings.binaryPath = binary
        if (!this.binary()) throw new Error('Claude Code executable is unavailable')
      }
      checkpoint()
      delete this.settings.cliDisconnected
      this.save()
      while (!(await signedIn())) {
        // Same synchronous segment as the prompt: nothing can cancel in between.
        checkpoint()
        const answer = await interaction.prompt({
          type: 'select',
          message:
            "Claude Code isn't signed in. Run `claude auth login` in a terminal, then check again. Mousse uses the same sign-in as your terminal.",
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
    append: string[] = []
  ): Options {
    const launch = this.launchTarget()
    // The append flags travel in `systemPrompt.append` (see claudeLaunchAppendSystemPrompt).
    const extraArgs = claudeExtraArgs(storedCliArgs(this.settings))
    for (const name of APPEND_SYSTEM_PROMPT_ARGS) delete extraArgs[name]
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
      ...(Object.keys(extraArgs).length ? { extraArgs } : {}),
      includePartialMessages: true
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
        ...this.options(cwd, controller),
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'Model discovery cannot run tools' })
      })
      const models = await query.supportedModels()
      controller.signal.throwIfAborted()
      if (models.length) {
        this.settings.models = claudeModelOptions(models)
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
        ...this.options(cwd, controller),
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
    if (this.settings.cliDisconnected)
      return 'Claude Subscription is disconnected. Reconnect it in Settings → Providers.'
    return "Claude Code isn't signed in. Run `claude auth login` in a terminal, then try again."
  }
  private abortInFlight(): void {
    for (const controller of this.controllers) controller.abort()
    for (const threadId of this.activeThreads) this.questions.dismissAllForThread(threadId)
    for (const session of this.loginSessions) session.abort.abort()
    for (const query of this.queries.values()) query.close()
    this.queries.clear()
    this.readyToCommit.clear()
  }
  commitConversation(threadId: string, history: string): void {
    if (!this.readyToCommit.delete(threadId)) return
    const saved = this.settings.sessions?.[threadId]
    if (saved) {
      saved.historyKey = historyKey(history)
      this.save()
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
    if (!this.configured()) throw new AppError({ code: 'claude_subscription_not_connected', message: this.signInRequiredMessage(), errorInfo: { category: 'unavailable', retryable: false } })
    if (this.activeThreads.has(input.threadId))
      throw new Error('A Claude turn is already running for this thread')
    this.activeThreads.add(input.threadId)
    const integrations = input.integrations
    // User MCP servers reference their secrets as `${VAR}`; the values ride in Claude's environment.
    const env = { ...this.environment(), ...integrations?.env }
    const controller = new AbortController()
    this.controllers.add(controller)
    let query: Query | undefined
    const cancel = () => {
      controller.abort()
      query?.close()
      this.questions.dismissAllForThread(input.threadId)
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    this.readyToCommit.delete(input.threadId)
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
    if (stored) {
      delete stored.historyKey
      this.save()
    }
    let text = '',
      thinking = '',
      success = false,
      sessionId: string | undefined
    const tools = new Map<string, string>()
    const steers: string[] = []
    let steerTimer: ReturnType<typeof setInterval> | undefined
    let interruptRequested = false
    const collectSteer = () => {
      if (controller.signal.aborted) return
      const steer = input.drainSteer?.()?.trim()
      if (!steer) return
      steers.push(steer)
      input.onSteer?.(steer)
      if (query && !interruptRequested) {
        interruptRequested = true
        this.questions.autoRejectPendingForThread(input.threadId)
        void query.interrupt().catch(() => cancel())
      }
    }
    try {
      const signedIn = await this.authenticated(controller.signal, env)
      if (!signedIn)
        throw new AppError({ code: 'claude_subscription_sign_in_required', message: this.signInRequiredMessage(), errorInfo: { category: 'unavailable', retryable: false } })
      controller.signal.throwIfAborted()
      input.signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      const prompt = (input.appletInstructions ? input.appletInstructions + '\n\nCurrent request:\n' : '') +
        (!resume && input.history
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
      const messages = async function* (): AsyncGenerator<SDKUserMessage> {
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          session_id: resume ?? ''
        }
      }
      const selected = parseThinkingSuffixFromModelId(input.model)
      const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(selected.effort ?? '')
        ? selected.effort as Options['effort'] : undefined
      const planTurn = input.mode === 'plan'
      const launchAppend = claudeLaunchAppendSystemPrompt(claudeExtraArgs(storedCliArgs(this.settings)), input.cwd)
      const options: Options = {
        // Mousse's instructions first, then the user's own append text.
        ...this.options(input.cwd, controller, env, [input.systemPromptAppend ?? '', ...launchAppend]),
        model: selected.baseId,
        effort,
        resume,
        // Agent turns run unattended in the thread workspace, like Mousse's other agents.
        ...(planTurn
          ? { permissionMode: 'plan' as const }
          : { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }),
        // The Mousse server keeps its name: user servers are spread first.
        mcpServers: {
          ...integrations?.mcpServers,
          // Servers that sign in with OAuth run in this process and call Mousse's own connection.
          ...Object.fromEntries(Object.entries(integrations?.proxiedServers ?? {}).map(([name, proxied]) => [name, claudeProxiedMcpServer(name, proxied)])),
          ...claudeMcpServers(input.mcp)
        },
        // The skills enabled in Mousse reach Claude as a local plugin, next to the user's own.
        ...(integrations?.pluginPath ? { plugins: [{ type: 'local' as const, path: integrations.pluginPath }] } : {}),
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (event) => {
                  // Hooks run in every permission mode, so the user's per-server tool limits hold
                  // on unattended turns too.
                  if (event.hook_event_name === 'PreToolUse' && claudeMcpToolBlocked(integrations?.toolRules, event.tool_name))
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'This tool is turned off for this MCP server in Mousse.'
                      }
                    }
                  if (event.hook_event_name === 'PreToolUse')
                    await editCounter.start(event.tool_use_id, event.tool_name, event.tool_input)
                  // Plan turns route every call through canUseTool so its read-only allowlist holds.
                  return planTurn
                    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }
                    : {}
                }
              ]
            }
          ],
          PostToolUse: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PostToolUse')
                    await editCounter.success(event.tool_use_id, event.tool_response)
                  return {}
                }
              ]
            }
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PostToolUseFailure')
                    editCounter.failure(event.tool_use_id)
                  return {}
                }
              ]
            }
          ]
        },
        canUseTool: async (toolName, args, context) => {
          if (controller.signal.aborted || context.signal.aborted)
            return { behavior: 'deny', message: 'Turn cancelled' }
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
          if (
            planTurn &&
            !['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'].includes(toolName)
          )
            return {
              behavior: 'deny',
              message: 'This turn is planning only; edits and shell commands are disabled.'
            }
          try {
            if (toolName === 'AskUserQuestion') {
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
            if (planTurn) return { behavior: 'allow', updatedInput: args }
            // Only calls Claude Code refuses to auto-approve even in bypass mode arrive here.
            const answer = await this.questions.requestAnswers(
              [
                {
                  id: 'permission',
                  prompt: `Allow Claude Code to use ${toolName}?\n${JSON.stringify(args).slice(0, 4000)}`,
                  options: [
                    { id: 'allow', label: 'Allow once' },
                    { id: 'reject', label: 'Reject' }
                  ]
                }
              ],
              input.threadId
            )
            if (
              controller.signal.aborted ||
              context.signal.aborted ||
              answer.permission !== 'allow'
            )
              return { behavior: 'deny', message: 'Permission rejected' }
            return { behavior: 'allow', updatedInput: args }
          } catch {
            return { behavior: 'deny', message: 'Permission dismissed' }
          }
        }
      }
      let nextPrompt: AsyncIterable<SDKUserMessage> = messages()
      if (input.drainSteer)
        steerTimer = setInterval(() => {
          try {
            collectSteer()
          } catch {
            cancel()
          }
        }, 100)
      for (;;) {
        const turnTextLength = text.length
        query = await this.createQuery(nextPrompt, options)
        this.queries.set(input.threadId, query)
        try {
          for await (const message of query) {
            metrics.observe(message)
            controller.signal.throwIfAborted()
            sessionId = message.session_id || sessionId
            if (message.type === 'stream_event') {
              const event = message.event
              if (event.type === 'content_block_delta' && !message.parent_tool_use_id) {
                if (event.delta.type === 'text_delta') {
                  text += event.delta.text
                  input.onText(text)
                }
                if (event.delta.type === 'thinking_delta') {
                  thinking += event.delta.thinking
                  input.onThinking?.(thinking)
                }
              }
              if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
                tools.set(event.content_block.id, event.content_block.name)
                input.onTool?.({
                  phase: 'start',
                  callId: event.content_block.id,
                  title: event.content_block.name,
                  toolName: event.content_block.name
                })
              }
            }
            if (message.type === 'user' && Array.isArray(message.message.content))
              for (const block of message.message.content) {
                if (block.type === 'tool_result' && tools.has(block.tool_use_id)) {
                  input.onTool?.({
                    phase: 'complete',
                    callId: block.tool_use_id,
                    title: tools.get(block.tool_use_id)!
                  })
                  tools.delete(block.tool_use_id)
                }
              }
            if (message.type === 'result') {
              if (
                (message.subtype !== 'success' || message.is_error) &&
                !(interruptRequested && steers.length)
              ) {
                const failure = 'errors' in message ? message.errors.join('\n') : 'Claude Code turn failed'
                if (/Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh/i.test(failure)) {
                  throw new AppError({
                    code: 'claude_subscription_auth_refresh_busy',
                    message: 'Claude is refreshing your subscription sign-in. Your conversation is saved. Wait a minute and send your message again; if this continues, reconnect Claude Subscription in Settings → Providers.',
                    errorInfo: { category: 'unavailable', retryable: true }
                  })
                }
                throw new Error(failure)
              }
              if (text.length === turnTextLength && 'result' in message) {
                text += message.result
                input.onText(text)
              }
              success = true
            }
          }
        } catch (error) {
          // The SDK throws after the error result an interrupt produces; a steer resumes from here.
          if (!(interruptRequested && steers.length) || controller.signal.aborted) throw error
        }
        const completed = query
        query = undefined
        collectSteer()
        completed.close()
        if (!steers.length) break
        controller.signal.throwIfAborted()
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
        if (text) text += '\n\n'
      }
      input.signal?.throwIfAborted()
      controller.signal.throwIfAborted()
      if (!success || !sessionId) throw new Error('Claude Code ended before completing the turn')
      this.settings.sessions = {
        ...this.settings.sessions,
        [input.threadId]: { sessionId, cwd: resolve(input.cwd), model: selected.baseId, usageBaseline: metrics.snapshot(), instanceId }
      }
      this.save()
      this.readyToCommit.add(input.threadId)
      return text
    } finally {
      controller.abort()
      query?.close()
      this.queries.delete(input.threadId)
      this.controllers.delete(controller)
      this.activeThreads.delete(input.threadId)
      if (steerTimer) clearInterval(steerTimer)
      input.signal?.removeEventListener('abort', cancel)
      const report = metrics.report()
      try {
        const baseline = metrics.snapshot()
        if (baseline && this.configured()) {
          const current = this.settings.sessions?.[input.threadId]
          this.settings.sessions = {
            ...this.settings.sessions,
            [input.threadId]: {
              ...(current?.sessionId === baseline.sessionId ? current : {}),
              sessionId: baseline.sessionId,
              cwd: resolve(input.cwd),
              usageBaseline: baseline,
              instanceId
            }
          }
          this.save()
        }
      } finally {
        input.onMetrics?.(report)
      }
      for (const [callId, title] of tools) input.onTool?.({ phase: 'complete', callId, title })
    }
  }
  /**
   * Disconnects this profile. Only Mousse-side state is cleared: the terminal sign-in is shared
   * with the user's own `claude`, so `claude auth logout` never runs.
   */
  async logout(): Promise<void> {
    this.settings.cliDisconnected = true
    this.settings.sessions = {}
    this.save()
    this.abortInFlight()
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
    this.readyToCommit.clear()
  }
}
