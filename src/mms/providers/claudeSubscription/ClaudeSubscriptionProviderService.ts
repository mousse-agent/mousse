import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeLoginPolicy,
  ClaudeSubscriptionStatus,
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
  /** Login policy (credential scope) the session was created under; absent on older sessions. */
  loginPolicy?: ClaudeLoginPolicy
}
type Settings = {
  /** A profile-private (isolated) sign-in completed; unused under the `cli` policy. */
  signedIn?: boolean
  /** Unset until resolved once; a stored value is never rewritten by migration. */
  loginPolicy?: ClaudeLoginPolicy
  /** Disconnected in Mousse under the `cli` policy; the terminal sign-in stays intact. */
  cliDisconnected?: boolean
  binaryPath?: string
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
  /** Text appended to the (otherwise empty) SDK system prompt. */
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
  startLogin?: (binary: string, env: NodeJS.ProcessEnv) => ChildProcess
}
export type ClaudeSubscriptionServiceOptions = {
  /**
   * The installation's default profile. Without a stored policy it reuses the terminal sign-in
   * unless it already has a profile-private one; other profiles stay isolated until opted in.
   */
  defaultProfile?: boolean
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
 * Each profile authenticates through the unmodified CLI. Mousse never reads its token files.
 * `configDir` selects a profile-private config dir; `undefined` reuses the terminal sign-in and
 * keeps an inherited `CLAUDE_CONFIG_DIR`. API keys, tokens and cloud routing are always removed so
 * a turn can never fall back to API billing.
 */
export function claudeSubscriptionEnvironment(
  configDir: string | undefined,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...source }
  const inheritedConfigDir = source.CLAUDE_CONFIG_DIR
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDE_CODE_API_KEY_HELPER|CLAUDE_CODE_CUSTOM_MODEL|AWS_|AMAZON_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|VERTEX_|BEDROCK_)/.test(
        key
      ) ||
      ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR'].includes(key)
    )
      delete env[key]
  }
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir
  else if (inheritedConfigDir) env.CLAUDE_CONFIG_DIR = inheritedConfigDir
  return env
}

function binaryOnPath(): string | undefined {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude']
  for (const directory of [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin')
  ]) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* continue */
      }
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
 * Whether a saved session may be resumed by a turn on `instanceId` under `loginPolicy`. Sessions
 * saved before instances existed belong to the default `claude` instance, and to the current
 * policy: a policy switch already drops every saved session (`setLoginPolicy`).
 */
function sessionBoundTo(saved: SavedSession, instanceId: string, loginPolicy: ClaudeLoginPolicy | undefined): boolean {
  return (saved.instanceId ?? CLAUDE_INSTANCE_ID) === instanceId && (saved.loginPolicy === undefined || saved.loginPolicy === loginPolicy)
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export class ClaudeSubscriptionProviderService {
  private readonly settingsPath: string
  readonly configDir: string
  private settings: Settings = {}
  /** Set when settings.json exists but cannot be read; blocks migration and every write. */
  private settingsError?: string
  private stopped = false
  private readonly queries = new Map<string, Query>()
  private readonly readyToCommit = new Set<string>()
  private readonly logins = new Set<ChildProcess>()
  private readonly loginSessions = new Set<LoginSession>()
  private readonly controllers = new Set<AbortController>()
  private readonly activeThreads = new Set<string>()
  private readonly defaultProfile: boolean
  /** Last live terminal sign-in check; only meaningful under the `cli` policy. */
  private cliProbe?: { at: number; result: AuthProbe }
  private migrationError?: { at: number; message: string }
  private probing?: Promise<void>
  /** Bumped when the credential scope changes; stale probes and sessions are discarded. */
  private scope = 0
  private modelDiscoveryStarted = false
  private policyStored = false

  constructor(
    private readonly profileHome: string,
    private readonly questions: UserQuestionService,
    private readonly dependencies: Dependencies = {},
    options: ClaudeSubscriptionServiceOptions = {}
  ) {
    this.defaultProfile = options.defaultProfile === true
    this.configDir = join(
      profileHome,
      'providers',
      CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      'claude-config'
    )
    this.settingsPath = join(
      profileHome,
      'providers',
      CLAUDE_SUBSCRIPTION_PROVIDER_ID,
      'settings.json'
    )
    this.loadSettings()
  }
  /**
   * Only a missing file counts as new settings. An unreadable or malformed file could hold a
   * stored policy, so it is never migrated or overwritten until a Recheck reads it.
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
    this.policyStored = this.settings.loginPolicy !== undefined
    // Cases that need no live check resolve immediately; `status()` persists the result.
    if (!this.policyStored && !this.settingsError) this.settings.loginPolicy = this.deducePolicy()
  }
  standaloneWorkspace(threadId: string): string {
    const directory = join(this.profileHome, 'providers', CLAUDE_SUBSCRIPTION_PROVIDER_ID, 'workspaces', historyKey(threadId))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  private save(): void {
    if (this.settingsError) return
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 })
    atomicWriteJsonSync(this.settingsPath, this.settings)
    if (this.settings.loginPolicy) this.policyStored = true
  }
  private binary(): string | undefined {
    const selected = this.settings.binaryPath
    if (!selected) return binaryOnPath()
    try {
      if (!isAbsolute(selected)) return undefined
      accessSync(selected, constants.X_OK)
      return selected
    } catch {
      return undefined
    }
  }
  /** Policy-selected environment; an unresolved policy uses the isolated dir (never active). */
  private environment(): NodeJS.ProcessEnv {
    return claudeSubscriptionEnvironment(
      this.settings.loginPolicy === 'cli' ? undefined : this.configDir
    )
  }
  /**
   * Synchronous view for routing and listings. Under `cli` it reflects the last live
   * `claude auth status` check (see `status()`), never the saved `signedIn` flag.
   */
  configured(): boolean {
    if (this.stopped || !this.binary()) return false
    if (this.settings.loginPolicy === 'isolated') return this.settings.signedIn === true
    if (this.settings.loginPolicy !== 'cli' || this.settings.cliDisconnected) return false
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
    // The terminal sign-in needs no Mousse sign-in step; offer the CLI aliases until discovery runs.
    const models = this.settings.models?.length
      ? this.settings.models
      : this.settings.loginPolicy === 'cli'
        ? FALLBACK_MODELS
        : undefined
    return models
      ? { id: CLAUDE_SUBSCRIPTION_PROVIDER_ID, label: 'Claude Subscription', models }
      : undefined
  }
  private async probe(
    binary: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<AuthProbe> {
    const unreadable: AuthProbe = {
      kind: 'error',
      message: 'Claude Code did not report its sign-in status. Update the Claude Code CLI and recheck.'
    }
    let output: string
    try {
      output = await (this.dependencies.runAuth ?? runAuth)(binary, ['auth', 'status'], env, signal)
    } catch (error) {
      signal?.throwIfAborted()
      const stdout = (error as { stdout?: unknown } | undefined)?.stdout
      if (typeof stdout !== 'string' || !stdout.trim()) return unreadable
      output = stdout
    }
    let status: { loggedIn?: unknown; authMethod?: unknown }
    try {
      status = JSON.parse(output) as typeof status
    } catch {
      return unreadable
    }
    if (typeof status?.loggedIn !== 'boolean') return unreadable
    if (!status.loggedIn) return { kind: 'signed_out', message: 'Claude Code is not signed in.' }
    // API-key, console and cloud sign-ins would bill outside the subscription.
    if (status.authMethod !== 'claude.ai')
      return {
        kind: 'signed_out',
        message: 'Claude Code is signed in without a Claude subscription account.'
      }
    return { kind: 'signed_in' }
  }
  /**
   * Checks the sign-in for one credential scope. The caller passes the environment it captured
   * with that scope; a result from a scope that has since changed is never trusted.
   */
  private async authenticated(
    signal?: AbortSignal,
    scope = this.scope,
    env = this.environment()
  ): Promise<boolean> {
    const binary = this.binary()
    if (!binary) return false
    const cli = this.settings.loginPolicy === 'cli'
    const result = await this.probe(binary, env, signal)
    signal?.throwIfAborted()
    if (scope !== this.scope) return false
    if (cli) this.cliProbe = { at: Date.now(), result }
    return result.kind === 'signed_in'
  }
  /**
   * Migration for profiles without a stored policy. The default profile reuses the terminal
   * sign-in unless it already has a profile-private one; other profiles stay isolated. A failed
   * check leaves the policy unresolved so Mousse never switches accounts silently.
   */
  private async resolvePolicy(binary: string): Promise<ClaudeLoginPolicy | undefined> {
    if (this.settingsError) return undefined
    let policy = this.settings.loginPolicy
    if (!policy) {
      const state = this.isolatedConfigState()
      if (state === 'error') {
        this.migrationError = {
          at: Date.now(),
          message: `Mousse could not read this profile's private Claude config (${this.configDir}). Check its permissions, then recheck.`
        }
        return undefined
      }
      // The isolated dir has content: only a live check can tell whether it holds an account.
      const result = await this.probe(binary, claudeSubscriptionEnvironment(this.configDir))
      if (this.settings.loginPolicy) return this.settings.loginPolicy
      if (result.kind === 'error') {
        this.migrationError = { at: Date.now(), message: result.message }
        return undefined
      }
      policy = result.kind === 'signed_in' ? 'isolated' : 'cli'
      this.settings.loginPolicy = policy
    }
    this.migrationError = undefined
    if (!this.policyStored) this.save()
    return policy
  }
  private deducePolicy(): ClaudeLoginPolicy | undefined {
    if (!this.defaultProfile || this.settings.signedIn === true) return 'isolated'
    return this.isolatedConfigState() === 'absent' ? 'cli' : undefined
  }
  /** Only a missing or empty dir is "no account"; any other error must not pick a policy. */
  private isolatedConfigState(): 'absent' | 'present' | 'error' {
    try {
      return readdirSync(this.configDir).length > 0 ? 'present' : 'absent'
    } catch (error) {
      return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'absent' : 'error'
    }
  }
  /** A live check is due: the policy is unresolved, or the terminal sign-in result is stale. */
  private checkDue(): boolean {
    if (this.stopped || this.settingsError) return false
    const fresh = (at?: number) => at !== undefined && Date.now() - at < CLAUDE_AUTH_STATUS_TTL_MS
    const policy = this.settings.loginPolicy
    if (policy === undefined) return !fresh(this.migrationError?.at)
    return policy === 'cli' && !this.settings.cliDisconnected && !fresh(this.cliProbe?.at)
  }
  private async refreshStatus(): Promise<void> {
    const binary = this.binary()
    if (!binary || this.stopped) return
    const scope = this.scope
    const policy = await this.resolvePolicy(binary)
    if (policy !== 'cli' || this.settings.cliDisconnected || scope !== this.scope) return
    const result = await this.probe(binary, claudeSubscriptionEnvironment(undefined))
    if (scope !== this.scope || this.stopped) return
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
   * Resolves the login policy and, under `cli`, runs a live `claude auth status` when the cached
   * result is missing, older than five minutes, or `force` (Recheck) is set.
   */
  async status(options: { force?: boolean } = {}): Promise<ClaudeSubscriptionStatus> {
    if (options.force) {
      await this.probing
      this.cliProbe = undefined
      this.migrationError = undefined
      if (this.settingsError) this.loadSettings()
    }
    // Persist a policy deduced at load so a later default-profile change cannot flip it.
    if (!this.policyStored && this.settings.loginPolicy && !this.stopped) this.save()
    if (this.checkDue()) {
      this.probing ??= this.refreshStatus()
        .catch(() => {
          if (!this.settings.loginPolicy)
            this.migrationError = { at: Date.now(), message: 'Mousse could not check the Claude sign-in.' }
        })
        .finally(() => {
          this.probing = undefined
        })
      await this.probing
    }
    return this.snapshot()
  }
  private snapshot(): ClaudeSubscriptionStatus {
    const policy = this.settings.loginPolicy ?? null
    const base = {
      loginPolicy: policy,
      defaultProfile: this.defaultProfile,
      isolatedSignIn: this.settings.signedIn === true
    }
    if (this.settingsError) return { ...base, state: 'error', message: this.settingsError }
    if (!this.binary())
      return {
        ...base,
        state: 'missing_binary',
        message: 'Claude Code CLI not found. Install the official Claude Code CLI, then recheck.'
      }
    if (policy === null)
      return {
        ...base,
        state: 'error',
        message: this.migrationError?.message ?? 'Mousse has not checked the Claude sign-in yet.'
      }
    if (policy === 'isolated')
      return this.settings.signedIn
        ? { ...base, state: 'connected' }
        : {
            ...base,
            state: 'signed_out',
            message: 'This profile has no Claude sign-in of its own. Add Claude Subscription to sign in.'
          }
    if (this.settings.cliDisconnected)
      return {
        ...base,
        state: 'disconnected',
        message: 'Disconnected in Mousse. The Claude sign-in in your terminal is unchanged.'
      }
    const probe = this.cliProbe
    if (!probe)
      return { ...base, state: 'error', message: 'Mousse has not checked the Claude sign-in yet.' }
    const checkedAt = new Date(probe.at).toISOString()
    if (probe.result.kind === 'signed_in') return { ...base, state: 'connected', checkedAt }
    return { ...base, state: probe.result.kind, message: probe.result.message, checkedAt }
  }
  /**
   * Switches which Claude sign-in this profile uses. Saved native sessions belong to the old
   * config dir, so they are dropped; the terminal sign-in itself is never changed.
   */
  async setLoginPolicy(policy: ClaudeLoginPolicy): Promise<ClaudeSubscriptionStatus> {
    if (this.stopped) throw new Error('Claude provider is stopped')
    if (this.settingsError) throw new Error(this.settingsError)
    if (this.settings.loginPolicy !== policy) {
      this.scope += 1
      this.cliProbe = undefined
      this.migrationError = undefined
      this.settings.sessions = {}
      this.readyToCommit.clear()
      // Turns and sign-ins in flight belong to the old credential scope.
      this.abortInFlight()
    }
    this.settings.loginPolicy = policy
    delete this.settings.cliDisconnected
    this.save()
    return this.status({ force: true })
  }
  async login(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    let child: ChildProcess | undefined
    const cancel = () => child?.kill()
    const scope = this.scope
    // After every wait: a cancelled sign-in or a login-policy switch must not spawn or prompt.
    const checkpoint = () => {
      session.abort.signal.throwIfAborted()
      if (scope !== this.scope) throw new Error('The Claude login policy changed during sign-in')
    }
    const signedIn = async () => {
      const result = await this.authenticated(session.abort.signal, scope)
      checkpoint()
      return result
    }
    this.loginSessions.add(session)
    session.abort.signal.addEventListener('abort', cancel, { once: true })
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
      this.save()
      await this.status()
      checkpoint()
      const cli = this.settings.loginPolicy === 'cli'
      if (cli) {
        // The terminal sign-in is managed in the terminal; Mousse never runs `auth login` on it.
        delete this.settings.cliDisconnected
        this.save()
        while (!(await signedIn())) {
          // Same synchronous segment as the prompt: nothing can cancel in between.
          checkpoint()
          const answer = await interaction.prompt({
            type: 'select',
            message:
              'This profile uses the Claude sign-in from your terminal, which is not signed in to a Claude subscription. Run `claude auth login` in a terminal, then check sign-in. It shares that account and its usage limits.',
            options: [
              { id: 'check', label: 'Check sign-in' },
              { id: 'cancel', label: 'Cancel' }
            ]
          })
          checkpoint()
          if (answer !== 'check') throw new Error('Claude sign-in cancelled')
        }
      } else if (!(await signedIn())) {
        const binary = this.binary()!
        checkpoint()
        child = (
          this.dependencies.startLogin ??
          ((path, env) => spawn(path, ['auth', 'login', '--claudeai'], { env, stdio: 'ignore' }))
        )(binary, claudeSubscriptionEnvironment(this.configDir))
        if (session.abort.signal.aborted || scope !== this.scope) {
          // The abort listener ran before this child existed; never let it outlive the sign-in.
          child.kill()
          checkpoint()
        }
        this.logins.add(child)
        child.on('error', () => {
          /* terminal fallback below */
        })
        const command =
          process.platform === 'win32'
            ? `$env:CLAUDE_CONFIG_DIR = '${this.configDir.replaceAll("'", "''")}'; & '${binary.replaceAll("'", "''")}' auth login --claudeai`
            : `CLAUDE_CONFIG_DIR=${quote(this.configDir)} ${quote(binary)} auth login --claudeai`
        for (;;) {
          checkpoint()
          const answer = await interaction.prompt({
            type: 'select',
            message: `Claude Code opens its own browser sign-in. Complete it, then check sign-in. If no browser opens, run this command in a terminal:\n${command}\nMousse does not collect Claude credentials. Claude controls subscription and Agent SDK billing.`,
            options: [
              { id: 'check', label: 'Check sign-in' },
              { id: 'cancel', label: 'Cancel' }
            ]
          })
          checkpoint()
          if (answer !== 'check') throw new Error('Claude sign-in cancelled')
          if (await signedIn()) break
          checkpoint()
          interaction.notify({
            type: 'progress',
            message:
              'No Claude subscription sign-in found in this profile. Complete Claude Code sign-in first.'
          })
        }
      }
      checkpoint()
      if (!cli) {
        this.settings.signedIn = true
        // An explicit profile sign-in settles an unresolved policy.
        this.settings.loginPolicy ??= 'isolated'
      }
      this.save()
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
      child?.kill()
      if (child) this.logins.delete(child)
      this.loginSessions.delete(session)
      session.abort.signal.removeEventListener('abort', cancel)
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
  private options(
    cwd: string,
    controller: AbortController,
    env: NodeJS.ProcessEnv = this.environment()
  ): Options {
    return {
      cwd,
      pathToClaudeCodeExecutable: this.binary(),
      env,
      abortController: controller,
      permissionMode: 'default',
      permissionPrompts: 'host',
      settingSources: [],
      mcpServers: {},
      extraArgs: { 'strict-mcp-config': null },
      includePartialMessages: true
    }
  }
  async refreshModels(cwd: string, signal?: AbortSignal): Promise<void> {
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
        this.settings.models = models.map((model) => ({
          id: model.value,
          label: model.displayName,
          efforts: model.supportedEffortLevels
        }))
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
    if (this.settings.loginPolicy !== 'cli' || this.settingsError)
      return 'Connect Claude Subscription in Settings → Providers first.'
    if (this.settings.cliDisconnected)
      return 'Claude Subscription is disconnected. Reconnect it in Settings → Providers.'
    return 'Claude Code in your terminal is not signed in to a Claude subscription. Run `claude auth login` in a terminal, then try again.'
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
    // Sign-in check, environment and resumed session all belong to this one credential scope.
    const scope = this.scope
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
    const loginPolicy = this.settings.loginPolicy
    // A native session belongs to one instance and one credential scope; anything else starts fresh.
    const stored = this.settings.sessions?.[input.threadId]
    const saved = stored && sessionBoundTo(stored, instanceId, loginPolicy) ? stored : undefined
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
      const signedIn = await this.authenticated(controller.signal, scope, env)
      if (scope !== this.scope)
        throw new AppError({ code: 'claude_subscription_scope_changed', message: 'The Claude sign-in for this profile changed during the turn. Send the message again.', errorInfo: { category: 'unavailable', retryable: false } })
      if (!signedIn)
        throw new AppError({ code: 'claude_subscription_sign_in_required', message: this.settings.loginPolicy === 'cli' ? this.signInRequiredMessage() : 'Claude subscription sign-in expired. Reconnect in Settings → Providers.', errorInfo: { category: 'unavailable', retryable: false } })
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
      const options: Options = {
        ...this.options(input.cwd, controller, env),
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
        // Skills reach Claude as a local plugin because the launch reads no setting sources.
        ...(integrations?.pluginPath ? { plugins: [{ type: 'local' as const, path: integrations.pluginPath }] } : {}),
        // The SDK's default system prompt is empty; appending to it is setting it.
        ...(input.systemPromptAppend ? { systemPrompt: input.systemPromptAppend } : {}),
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
          // Claude Code defers MCP tool schemas behind ToolSearch, which only loads them; without it
          // the Mousse tools above are unreachable unless the user approves a prompt every turn.
          // Any query is safe because the launch uses `strict-mcp-config` and `settingSources: []`:
          // only the Mousse server and the servers the user enabled in Mousse can load.
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
      // A login-policy switch mid-turn moves the config dir; this session cannot be resumed there.
      if (scope === this.scope) {
        this.settings.sessions = {
          ...this.settings.sessions,
          [input.threadId]: { sessionId, cwd: resolve(input.cwd), model: selected.baseId, usageBaseline: metrics.snapshot(), instanceId, ...(loginPolicy ? { loginPolicy } : {}) }
        }
        this.save()
        this.readyToCommit.add(input.threadId)
      }
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
        if (baseline && scope === this.scope && this.configured()) {
          const current = this.settings.sessions?.[input.threadId]
          this.settings.sessions = {
            ...this.settings.sessions,
            [input.threadId]: {
              ...(current?.sessionId === baseline.sessionId ? current : {}),
              sessionId: baseline.sessionId,
              cwd: resolve(input.cwd),
              usageBaseline: baseline,
              instanceId,
              ...(loginPolicy ? { loginPolicy } : {})
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
   * Disconnects this profile. Under `cli` only Mousse-side state is cleared: the terminal sign-in
   * is shared with the user's own `claude`, so `claude auth logout` never runs for it.
   */
  async logout(): Promise<void> {
    const cli = this.settings.loginPolicy === 'cli'
    if (cli) this.settings.cliDisconnected = true
    else this.settings.signedIn = false
    this.settings.sessions = {}
    this.save()
    this.abortInFlight()
    // Unreadable settings may hide a `cli` policy or a private sign-in; never log out blind.
    if (cli || this.settingsError) return
    const binary = this.binary()
    if (binary)
      await (this.dependencies.runAuth ?? runAuth)(
        binary,
        ['auth', 'logout'],
        claudeSubscriptionEnvironment(this.configDir)
      )
  }
  stop(): void {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
    for (const session of this.loginSessions) session.abort.abort()
    for (const child of this.logins) child.kill()
    for (const [threadId, query] of this.queries) {
      query.close()
      this.questions.dismissAllForThread(threadId)
    }
    this.queries.clear()
    this.readyToCommit.clear()
  }
}
