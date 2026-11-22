import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { methods, type NewSessionResponse } from '@agentclientprotocol/sdk'
import type { CliProviderConfig, CliProviderConfigPatch, ConfiguredProvider, ProviderLoginOption, ProviderLoginResult } from '../../../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../../../shared/settings'
import { ANTIGRAVITY_INSTANCE_ID } from '../../../../../shared/providerInstances'
import type { UserQuestionService } from '../../../../orchestrator/UserQuestionService'
import { atomicWriteJsonSync } from '../../../../data/AtomicFs'
import { harnessAppError } from '../../../../../shared/harness/types'
import { compareVersions, type OneShotSpec, type RuntimeUsage } from '../../../driver'
import { agyStandalonePaths, cliNames, findOnPath } from '../../../env'
import { isAuthRequired } from '../../auth'
import type { AcpConnectionFactory } from '../../connection'
import { modelOptions } from '../../models'
import { ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_AUTH_METHOD, ANTIGRAVITY_LABEL, ANTIGRAVITY_QUIRKS, antigravityConnectionFactory, forwardAntigravityCallback, scrubbedAntigravityEnv, type AntigravityRuntimeChoice } from '../antigravity'
import { keepOption } from '../../permissions'
import { AcpSessions, type AcpChatInput, type AcpProcess, type SavedAcpSession } from '../../session'
import type { LoginSession } from '../../../../providers/LoginSession'
import { settingsMirror, type MirrorField, type VendorMirror } from '../../../vendorMirror'
import { requireExecutable, sharedCliVersions, storedCliArgs, storedCliEnv, withUserEnv, type CliVersionCache, type StoredCliConfig } from '../../../cliConfig'
import { directLaunch } from '../../../resolveWindowsShim'
import { ANTIGRAVITY_RELEASE, antigravityInstallState, cancelAntigravityInstall, installedAntigravityBinary, manualAntigravityRuntime, onAntigravityInstallEvent, runSharedAntigravityInstall, type AntigravityInstallProgress } from './installation'
import { activeNativeRuntime, installNativeAntigravity, readVendorFeed, type NativeRuntime, type NativeVerifier } from './nativeInstall'
import { NATIVE_FEED_BASE, NATIVE_MIN_VERSION, WITHDRAWN_NATIVE_VERSIONS, nativeReleaseRefusal, nativeTarget, parseVendorFeed, type NativeRelease, type NativeTarget } from './nativeRelease'
import { AgyUsageTurnError, agyUsageRefusal, parseAgyUsage, runAgy, type AgyRunner } from './usage'

/** The 1.1.1 ACP server's version, as Mousse reports it. */
const LEGACY_VERSION = ANTIGRAVITY_RELEASE.replace(/^agy_acp_server_/, '')
/** Google's update feed is read at most this often (the pace of other agents' version checks). */
const FEED_TTL_MS = 6 * 60 * 60_000
/** How long a lookup of the user's own `agy` is reused: it is asked for on every status read. */
const USER_AGY_TTL_MS = 15_000

/**
 * Under test, nothing outside the test is reached: no `agy` of this computer and no feed. A test
 * runner started through vitest's Node API leaves `NODE_ENV` unset, so its worker flag counts too.
 */
const underTest = (): boolean => process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity'
type ProfileSettings = {
  /**
   * The launch settings as an older Mousse reads them: a mirror of the instance config, written
   * only through `vendorMirror()` and never read for a launch.
   */
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
  models?: LlmModelOption[]
  /** ISO time `models` was last listed by the agent. */
  modelsRefreshedAt?: string
  /** Signed in on the 1.1.1 ACP server (its file-stored Google session). */
  signedIn?: boolean
  /**
   * Signed in on `agy`, whose Google sign-in is the one this computer's `agy` keeps. Kept apart from
   * `signedIn`: the 1.1.1 server keeps its own, so a switch reads the sign-in again.
   */
  nativeSignedIn?: boolean
  sessions?: Record<string, SavedAcpSession>
  /** The runtime `sessions` were opened on (absent: the 1.1.1 server). Another runtime starts them anew. */
  sessionsRuntime?: AntigravityRuntimeChoice['kind']
  /** The `agy` whose limits reply reported a turn: its limits are not read again. */
  usageStopped?: { binary: string; version: string }
}
/** The notice `agy` sends as its reply when the model's quota is used up (seen on agy 1.5.13). */
const AGY_QUOTA_NOTICE = /^\s*(⚠\s*)?Individual quota reached(\s|\.|$)/i
const NOT_INSTALLED_MESSAGE = 'Install Antigravity first, then sign in'
const SIGN_IN_REQUIRED_MESSAGE = 'Sign in to Antigravity in Settings before chatting'

export interface AntigravityServiceOptions {
  /** Test seam: opens agent connections instead of starting the agent (the ACP process boundary). */
  connect?: AcpConnectionFactory
  /**
   * The manual agent path, extra args and variables: the instance config's (the gateway's).
   * Without it the verified install runs with none.
   */
  launch?: () => StoredCliConfig
  /** Saves launch settings through the gateway's `configure` (an install drops a manual path). */
  saveLaunch?: (patch: CliProviderConfigPatch) => Promise<void>
  /**
   * Finds the user's own `agy` (PATH, then Google's install folder). The driver hands in the
   * gateway's lookup; tests pass their own, and without either none is found under test.
   */
  findUserAgy?: () => string | undefined
  /** Test seam: use the gateway's lookup (`useAgyFinder`) under test too, as it is used in production. */
  gatewayLookupUnderTest?: boolean
  /** Test seam: runs `agy -p /usage` (the process boundary of the limits read). */
  runAgy?: AgyRunner
  /** Test seams for Mousse's own `agy`: the target, the network, the start-up check and the clock. */
  native?: {
    target?: NativeTarget
    fetch?: typeof fetch
    verify?: NativeVerifier
    withdrawn?: readonly string[]
    now?: () => number
  }
}

/**
 * The profile's Antigravity: its settings, the agent that runs and its Google sign-in. Turns run
 * on the ACP core (`harness/acp`) with the Antigravity preset.
 */
export class AntigravityProviderService {
  private readonly settingsPath: string
  private readonly profileDir: string
  private settings: ProfileSettings
  /** Set when settings.json exists but cannot be read; blocks every write until the next start. */
  private settingsError?: string
  private stopped = false
  private readonly loginSessions = new Set<LoginSession>()
  /** Bumped when the launch settings change. */
  private launchGeneration = 0
  /** Aborts this service's own install when it stops. The installation allows one install at a time. */
  private installing?: AbortController
  private readonly unsubscribeInstall: () => void
  /** Bumped when a sign-in succeeds, so an older process's late sign-in request is ignored. */
  private signInGeneration = 0
  private readonly acp: AcpSessions
  /** Google's update feed as last read, and when: the release it names, undefined when unreadable. */
  private feed?: { value: NativeRelease | undefined; at: number }
  private feedReading?: Promise<NativeRelease | undefined>
  /** The user's own `agy` as last looked up, and when. */
  private userAgyFound?: { path: string | undefined; at: number }
  /** Versions of the user's `agy`, by executable fingerprint: one too old is passed over. */
  private readonly userAgyVersions = new Map<string, string | null>()
  /** The gateway's lookup of the user's `agy` (its login-shell PATH too), set by the driver. */
  private agyFinder?: () => string | undefined
  /** A running check of whether `agy` is already signed in. */
  private signInCheck?: Promise<boolean>
  /** A running limits read: page reads that arrive meanwhile share it. */
  private usageReading?: Promise<RuntimeUsage>
  /** Clients are told through these hooks, set by the profile services. */
  readonly hooks: { changed?: () => void; installProgress?: (message: string) => void } = {}

  constructor(private readonly profileHome: string, private readonly installationHome: string, questions: UserQuestionService,
    private readonly versions: CliVersionCache = sharedCliVersions, private readonly options: AntigravityServiceOptions = {}) {
    this.profileDir = join(profileHome, 'providers', 'antigravity')
    this.settingsPath = join(this.profileDir, 'settings.json')
    this.settings = {}
    // Only a missing file counts as new settings: an unreadable one is never overwritten.
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      this.settings = parsed as ProfileSettings
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
        this.settingsError = `Mousse could not read this profile's Antigravity settings (${this.settingsPath}). Fix or remove the file, then restart Mousse.`
    }
    this.acp = new AcpSessions({
      label: ANTIGRAVITY_LABEL,
      usageLimitProvider: ANTIGRAVITY_PROVIDER_ID,
      defaultInstanceId: ANTIGRAVITY_INSTANCE_ID,
      questions,
      quirks: ANTIGRAVITY_QUIRKS,
      // Antigravity's own option labels; it asks for every tool.
      classifyOption: keepOption,
      // Advertise ACP form elicitation so `agy` routes `ask_question` through Mousse's question widget instead of dumping markdown choices in chat.
      formElicitation: true,
      clientCapabilities: () => ({ elicitation: { form: {} } }),
      connect: options.connect ?? antigravityConnectionFactory({
        profileDir: this.profileDir,
        profileHome,
        runtime: () => this.runtime(),
        args: () => storedCliArgs(this.launchSettings()),
        env: (base) => withUserEnv(base, storedCliEnv(this.launchSettings()))
      }),
      store: {
        // A session opened on the other runtime is not resumed: the thread hands its history over instead.
        saved: (threadId) => this.sessionsRuntime() === this.runtimeKind() ? this.settings.sessions?.[threadId] : undefined,
        setSaved: (threadId, saved) => {
          if (this.sessionsRuntime() !== this.runtimeKind()) {
            this.settings.sessions = {}
            this.settings.sessionsRuntime = this.runtimeKind()
          }
          if (saved) this.settings.sessions = { ...this.settings.sessions, [threadId]: saved }
          else if (this.settings.sessions) {
            const { [threadId]: _dropped, ...rest } = this.settings.sessions
            this.settings.sessions = rest
          }
          this.save()
        },
        models: () => this.settings.models ?? [],
        setModels: (models) => {
          this.settings.models = models
          this.settings.modelsRefreshedAt = new Date().toISOString()
          this.save()
        }
      },
      launchGeneration: () => this.launchGeneration,
      signInGeneration: () => this.signInGeneration,
      markSignedOut: () => this.markSignedOut(),
      signInRequiredMessage: SIGN_IN_REQUIRED_MESSAGE
    })
    // An install is shared by every profile of the installation; each tells its own clients.
    this.unsubscribeInstall = onAntigravityInstallEvent(installationHome, (event) => {
      if (this.stopped) return
      if (event.type === 'progress') {
        try { this.hooks.installProgress?.(event.message) } catch { /* progress is best effort */ }
      } else if (event.type === 'finished' && this.installing) {
        // This service's own install reports once its settings have changed (see `install`).
      } else this.notifyChanged()
    })
  }

  private save(): void {
    if (this.settingsError) return
    mkdirSync(this.profileDir, { recursive: true })
    atomicWriteJsonSync(this.settingsPath, this.settings)
  }

  /** The stored agent path, args and variables: the instance config's, never `settings.json`. */
  private launchSettings(): StoredCliConfig {
    return this.options.launch?.() ?? {}
  }

  /**
   * The copy of the launch settings in this service's `settings.json` for an older Mousse, read from
   * and written to the settings loaded now (a sign-in replaces them) and saved through `save()`.
   */
  vendorMirror(fields: readonly MirrorField[]): VendorMirror {
    return settingsMirror(fields, {
      settings: () => this.settings as Record<string, unknown>,
      settingsError: () => this.settingsError,
      save: () => this.save(),
      exists: () => existsSync(this.settingsPath)
    })
  }

  /**
   * The agent that runs, in this order: a manual path in Settings (`agy`, or the 1.1.1 server); the
   * user's own `agy`, which updates itself; Mousse's own `agy`. An earlier 1.1.1 install runs only
   * until Mousse's `agy` is installed (Update, or on its own once idle).
   */
  private runtime(): AntigravityRuntimeChoice | undefined {
    const manual = this.launchSettings().binaryPath
    if (manual) {
      try { return { ...manualAntigravityRuntime(manual), source: 'manual' } } catch { return undefined }
    }
    const own = this.userAgy()
    if (own) return { kind: 'native', binary: own, source: 'user' }
    const native = this.nativeRuntime()
    if (native) return { kind: 'native', binary: native.binary, source: 'managed' }
    const legacy = installedAntigravityBinary(this.installationHome)
    return legacy ? { kind: 'legacy', binary: legacy, source: 'managed' } : undefined
  }

  private binary(): string | undefined { return this.runtime()?.binary }

  /** The kind that runs now; with nothing installed, `agy`, which an install adds. */
  private runtimeKind(): AntigravityRuntimeChoice['kind'] {
    return this.runtime()?.kind ?? 'native'
  }

  private sessionsRuntime(): AntigravityRuntimeChoice['kind'] { return this.settings.sessionsRuntime ?? 'legacy' }

  /**
   * The user's own `agy`, unless its version is known to be older than `NATIVE_MIN_VERSION`. Looked
   * up at most every `USER_AGY_TTL_MS`; its version is read once per executable, in the background.
   */
  private userAgy(): string | undefined {
    const now = Date.now()
    if (!this.userAgyFound || now - this.userAgyFound.at > USER_AGY_TTL_MS) {
      // Under test only a lookup the test hands in runs: never this computer's own agy.
      const lookup = underTest() && !this.options.gatewayLookupUnderTest ? undefined
        : this.agyFinder ?? (() => findOnPath(cliNames('agy'), { env: process.env, searchPath: agyStandalonePaths() }))
      const find = this.options.findUserAgy ?? lookup ?? (() => undefined)
      let path: string | undefined
      try { path = find() } catch { path = undefined }
      const before = this.userAgyFound?.path
      this.userAgyFound = { path, at: now }
      if (before !== undefined && before !== path) this.runtimeChanged()
    }
    const path = this.userAgyFound.path
    if (!path) return undefined
    let key = path
    try {
      const info = statSync(path)
      key = `${path}|${info.size}|${info.mtimeMs}`
    } catch { /* looked up again on the next read */ }
    if (!this.userAgyVersions.has(key)) {
      this.userAgyVersions.set(key, null)
      void this.versions.version(directLaunch(path), process.env).then((version) => {
        if (!version) return
        this.userAgyVersions.set(key, version)
        if (compareVersions(version, NATIVE_MIN_VERSION) < 0) this.runtimeChanged()
      })
    }
    const version = this.userAgyVersions.get(key)
    return version && compareVersions(version, NATIVE_MIN_VERSION) < 0 ? undefined : path
  }

  /** Looks the user's `agy` up the way the gateway does, so both name the same executable. */
  useAgyFinder(find: () => string | undefined): void {
    this.agyFinder = find
    this.userAgyFound = undefined
  }

  /** The agent to run changed on its own (an `agy` appeared or went): idle processes restart on it. */
  private runtimeChanged(): void {
    if (this.stopped) return
    this.relaunchAfterSettingsChange()
    this.notifyChanged()
  }

  /** This computer's target, found once (Linux checks for musl on disk). */
  private target?: { value: NativeTarget | undefined }
  private nativeTarget(): NativeTarget | undefined {
    this.target ??= { value: this.options.native?.target ?? nativeTarget() }
    return this.target.value
  }

  /**
   * Withdrawn releases: Mousse's own list, and the installed one when Google's feed went back to an
   * older version (the last good one then runs, and the feed's release installs on the next update).
   */
  private withdrawn(): readonly string[] {
    const base = this.options.native?.withdrawn ?? WITHDRAWN_NATIVE_VERSIONS
    const feed = this.feed?.value
    if (!feed) return base
    const installed = activeNativeRuntime(this.installationHome, this.nativeTarget(), base)
    return installed && compareVersions(feed.version, installed.version) < 0 ? [...base, installed.version] : base
  }

  /** Mousse's own verified `agy`. */
  private nativeRuntime(): NativeRuntime | undefined {
    return activeNativeRuntime(this.installationHome, this.nativeTarget(), this.withdrawn())
  }

  configured(): boolean { return Boolean(this.signedIn() && this.binary()) }
  configuredProvider(): ConfiguredProvider | undefined {
    return this.configured() ? { id: ANTIGRAVITY_PROVIDER_ID, label: 'Google Antigravity', authType: 'oauth', source: 'Google ACP agent' } : undefined
  }
  loginOption(): ProviderLoginOption {
    return { id: ANTIGRAVITY_PROVIDER_ID, label: 'Google Antigravity', authType: 'oauth', configured: this.configured(), description: 'Google ACP agent · personal sign-in' }
  }
  llmProvider(): LlmProviderOption | undefined {
    return this.configured() && this.settings.models?.length
      ? { id: ANTIGRAVITY_PROVIDER_ID, label: 'Google Antigravity', models: this.settings.models }
      : undefined
  }

  async login(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    this.loginSessions.add(session)
    try {
      if (this.stopped) throw new Error('Antigravity provider is stopped')
      // A sign-in recorded in settings that cannot be saved would be lost at the next start.
      if (this.settingsError) throw new Error(this.settingsError)
      session.abort.signal.throwIfAborted()
      return await this.runLogin(session, cwd)
    } catch (error) {
      return { success: false, sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      // The session is not aborted here: the gateway reads an aborted session as a cancelled sign-in.
      this.loginSessions.delete(session)
    }
  }

  /**
   * Sign-in is separate from install: with no agent there is nothing to sign in to. `agy` shares the
   * Google sign-in of this computer's `agy`: when it already has one, opening a session succeeds and
   * no Google flow starts. Otherwise (and always on the 1.1.1 server) Google's sign-in runs.
   */
  private async runLogin(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    if (!this.binary()) throw new Error(NOT_INSTALLED_MESSAGE)
    session.abort.signal.throwIfAborted()
    const native = this.runtimeKind() === 'native'
    session.emitEvent({ sessionId: session.sessionId, type: 'progress', message: native ? 'Starting Antigravity…' : 'Starting Google sign-in…' })
    // Ends with this sign-in however it ends (cancelled, failed or signed in): withdraws the paste field.
    const ended = new AbortController()
    const live = AbortSignal.any([session.abort.signal, ended.signal])
    let authUrl: string | undefined
    let linkShown!: () => void
    const firstLink = new Promise<void>((resolve) => { linkShown = resolve })
    const process = this.acp.launch('sign_in', (url) => {
      // The same link printed twice (stdout and the browser helper) is shown once.
      if (url === authUrl || live.aborted) return
      authUrl = url
      session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url, usesCallbackServer: true,
        instructions: 'Sign in through Google. If the browser is on another machine, paste its final redirect URL here.' })
      linkShown()
    })
    live.addEventListener('abort', () => { linkShown(); this.acp.close(process) }, { once: true })
    try {
      // The pasted-redirect fallback is offered only under Google's link, never before it: a redirect
      // is checked against the latest link's own loopback callback and state.
      void (async () => {
        await firstLink
        while (!live.aborted) {
          const callback = await session.waitForCallbackUrl(live)
          try {
            await forwardAntigravityCallback(authUrl!, callback)
            return
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!live.aborted) session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url: authUrl!, usesCallbackServer: true, instructions: message })
          }
        }
      })().catch(() => undefined)
      await this.acp.initialize(process)
      let newSession = native ? await this.openSignedIn(process, cwd) : undefined
      if (!newSession) {
        if (native) session.emitEvent({ sessionId: session.sessionId, type: 'progress', message: 'Starting Google sign-in…' })
        await process.connection.agent.request(methods.agent.authenticate, { methodId: ANTIGRAVITY_AUTH_METHOD })
        newSession = await process.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      }
      session.abort.signal.throwIfAborted()
      if (!this.recordSignIn(modelOptions(newSession))) throw new Error('Google agent did not confirm account model access')
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      const cancelled = session.abort.signal.aborted
      return { success: false, sessionId: session.sessionId, error: cancelled ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
    } finally { ended.abort() }
  }

  /** A session opened without signing in: the existing sign-in works. Undefined when `agy` asks for one. */
  private async openSignedIn(process: AcpProcess, cwd: string): Promise<NewSessionResponse | undefined> {
    try {
      return await process.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
    } catch (error) {
      if (isAuthRequired(error)) return undefined
      throw error
    }
  }

  /** Records a sign-in the agent confirmed with the account's models; false when it listed none. */
  private recordSignIn(models: LlmModelOption[]): boolean {
    if (!models.length) return false
    this.signInGeneration += 1
    const signedInFlag = this.runtimeKind() === 'native' ? { nativeSignedIn: true } : { signedIn: true }
    this.settings = { ...this.settings, ...signedInFlag, models, modelsRefreshedAt: new Date().toISOString() }
    this.save()
    return true
  }

  /**
   * Whether `agy` already has a Google sign-in on this computer: one session opened without signing
   * in (the agent decides; Mousse never reads its credentials). Run on an explicit check (Add,
   * Check again, after install), never at start-up. True once recorded.
   */
  checkSignedIn(cwd: string = this.profileDir): Promise<boolean> {
    if (this.signedIn()) return Promise.resolve(true)
    if (this.stopped || this.settingsError || this.runtimeKind() !== 'native' || !this.binary()) return Promise.resolve(false)
    this.signInCheck ??= (async () => {
      const active = this.acp.launch('models')
      try {
        await this.acp.initialize(active)
        const opened = await this.openSignedIn(active, cwd)
        if (!opened || !this.recordSignIn(modelOptions(opened))) return false
        this.notifyChanged()
        return true
      } catch {
        return false
      } finally {
        this.acp.close(active)
        this.signInCheck = undefined
      }
    })()
    return this.signInCheck
  }

  /** Record only the canonical history that the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    this.acp.commitConversation(threadId, history)
  }

  /** The history a turn that did not finish left: its session may be resumed from it (`AcpSessions.commitInterrupted`). */
  commitInterrupted(threadId: string, history: string): void {
    this.acp.commitInterrupted(threadId, history)
  }

  /** A turn on the thread's agent session (see `AcpSessions.chat`). */
  async chat(input: AcpChatInput): Promise<string> {
    input.signal?.throwIfAborted()
    if (!this.configured()) throw new Error('Antigravity is not signed in')
    return this.acp.chat(input)
  }

  /**
   * One request with no tools (`DriverRuntime.oneShot`): a chat title, a pull request draft or a commit message. Its
   * own agent process and session in a new empty folder, removed afterwards (`AcpSessions.oneShot`).
   */
  async oneShot(spec: OneShotSpec, signal: AbortSignal): Promise<{ text: string }> {
    signal.throwIfAborted()
    if (!this.configured()) throw harnessAppError({ code: 'signed_out', message: SIGN_IN_REQUIRED_MESSAGE })
    const cwd = join(this.profileDir, 'one-shot', randomUUID())
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    try {
      const text = await this.acp.oneShot({ cwd, model: spec.model, system: spec.system, prompt: spec.prompt, signal, onActivity: () => spec.onActivity() })
      // `agy` answers a model whose quota is used up with a notice as the reply ("⚠ Individual quota reached. …"): never an answer.
      if (AGY_QUOTA_NOTICE.test(text)) throw harnessAppError({ code: 'rate_limited', message: `Antigravity's quota for this model is used up: ${text.trim().replace(/^⚠\s*/, '')}` })
      return { text }
    } finally {
      // The ended process may hold the folder a moment longer on Windows: a leftover empty folder is harmless.
      try { rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* kept */ }
    }
  }

  /** Explicit model-picker refresh; never run this from background health checks. */
  async refreshModels(cwd: string): Promise<LlmModelOption[]> {
    if (!this.configured()) throw new Error('Antigravity is not signed in')
    const active = this.acp.launch('models')
    try {
      await this.acp.initialize(active)
      const session = await active.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      const models = modelOptions(session)
      if (!models.length) throw new Error('Google agent did not return account models')
      this.settings.models = models
      this.settings.modelsRefreshedAt = new Date().toISOString()
      this.save()
      return models
    } catch (error) {
      throw this.acp.authRequiredError(active, error) ?? error
    } finally { this.acp.close(active) }
  }

  /** Drops the saved ACP session of `threadId`; its next turn starts a new one with the history in the prompt. */
  forgetConversation(threadId: string): void {
    this.acp.forgetConversation(threadId)
  }

  /** The installation's install, whichever profile started it: running, and its latest progress line. */
  installState(): { installing: boolean; progress?: string } {
    return antigravityInstallState(this.installationHome)
  }

  /** Whether the profile completed a sign-in on the runtime that runs now, which the agent has not since refused. */
  signedIn(): boolean {
    return Boolean(this.runtimeKind() === 'native' ? this.settings.nativeSignedIn : this.settings.signedIn)
  }

  /** Models of the last sign-in or refresh. */
  models(): LlmModelOption[] {
    return this.settings.models ?? []
  }

  /** When the agent last listed the models, kept with them across restarts. */
  modelsRefreshedAt(): string | undefined {
    return this.settings.models?.length ? this.settings.modelsRefreshedAt : undefined
  }

  /** Signs the agent out. On `agy` that is this computer's `agy` sign-in, which every profile shares. */
  async logout(): Promise<void> {
    for (const session of this.loginSessions) session.abort.abort()
    this.closeAll()
    try {
      if (this.binary()) {
        const active = this.acp.launch('sign_out')
        try {
          await this.acp.initialize(active)
          await active.connection.agent.request(methods.agent.logout, {})
        } finally { this.acp.close(active) }
      }
    } catch {
      // A revoked or expired Google session makes the agent refuse (or ask for sign-in again); the local reset below is what counts.
    } finally {
      this.settings.signedIn = false
      this.settings.nativeSignedIn = false
      this.settings.models = []
      delete this.settings.modelsRefreshedAt
      this.settings.sessions = {}
      this.save()
      this.notifyChanged()
    }
  }
  /**
   * The account's plan limits, as `agy -p /usage --output-format json` reports them: the same `agy`
   * and the same folders as Mousse's runs, so it answers for the same sign-in on every system (on
   * Linux without D-Bus, `agy` keeps the sign-in in a file under those folders). Only when the usage
   * page asks; `agy` itself asks Google. Refused below `AGY_USAGE_MIN_VERSION`, where `/usage` would
   * run a turn, and never again for an `agy` whose reply reported one.
   */
  usage(signal: AbortSignal): Promise<RuntimeUsage> {
    this.usageReading ??= this.readUsage(signal).finally(() => { this.usageReading = undefined })
    return this.usageReading
  }

  private async readUsage(signal: AbortSignal): Promise<RuntimeUsage> {
    const runtime = this.runtime()
    if (!runtime) throw new Error(NOT_INSTALLED_MESSAGE)
    if (runtime.kind !== 'native') return { status: 'unavailable', windows: [], message: 'Google\'s 1.1.1 ACP server reports no limits. Run agy to see them.' }
    const env = withUserEnv(scrubbedAntigravityEnv(process.env), storedCliEnv(this.launchSettings()))
    const managed = this.managedRuntime()
    const version = managed?.path === runtime.binary ? managed.version : await this.versions.version(directLaunch(runtime.binary), env)
    const refusal = agyUsageRefusal(version)
    if (refusal) throw new Error(refusal)
    const stopped = this.settings.usageStopped
    if (stopped && stopped.binary === runtime.binary && stopped.version === version) throw new AgyUsageTurnError()
    const geminiHome = join(this.profileDir, 'gemini-home')
    const cwd = join(this.profileDir, 'usage')
    const temp = join(this.profileHome, 'antigravity-tmp', randomUUID())
    for (const dir of [geminiHome, cwd, temp]) mkdirSync(dir, { recursive: true, mode: 0o700 })
    env.GEMINI_HOME = geminiHome
    if (process.platform === 'win32') { env.TEMP = temp; env.TMP = temp } else env.TMPDIR = temp
    try {
      // Root flags take underscores under `-p`; `agy acp` takes the same folders with hyphens.
      const stdout = await (this.options.runAgy ?? runAgy)(runtime.binary,
        ['--gemini_dir', geminiHome, '--app_data_dir', ANTIGRAVITY_APP_DATA_DIR, '-p', '/usage', '--output-format', 'json'], { env, cwd, signal })
      return parseAgyUsage(stdout)
    } catch (error) {
      if (error instanceof AgyUsageTurnError && version) {
        this.settings.usageStopped = { binary: runtime.binary, version }
        this.save()
      }
      throw error
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }

  /** The executable path, launch args and environment set in Settings → Providers. */
  async cliConfig(): Promise<CliProviderConfig> {
    const install = this.installState()
    const resolvedBinaryPath = this.binary()
    const stored = this.launchSettings()
    // A Mousse install is verified by hash, so its version is known without starting it.
    const managed = this.managedRuntime()
    const version = resolvedBinaryPath && resolvedBinaryPath === managed?.path
      ? managed.version
      : await this.versions.version(resolvedBinaryPath ? directLaunch(resolvedBinaryPath) : undefined, withUserEnv(process.env, storedCliEnv(stored)))
    return {
      instanceId: ANTIGRAVITY_INSTANCE_ID,
      ...(stored.binaryPath ? { binaryPath: stored.binaryPath } : {}),
      ...(resolvedBinaryPath ? { resolvedBinaryPath } : {}),
      ...(version ? { version } : {}),
      args: storedCliArgs(stored),
      env: storedCliEnv(stored),
      // Independent of whether the instance is enabled, which `listConfigured` is not.
      signedIn: this.configured(),
      ...(install.installing ? { installing: true, ...(install.progress ? { installProgress: install.progress } : {}) } : {})
    }
  }

  /** Checks launch settings before the gateway saves them: `agy`, or the 1.1.1 server beside its helper. */
  validateLaunch(patch: CliProviderConfigPatch): void {
    if (typeof patch.binaryPath === 'string') manualAntigravityRuntime(requireExecutable(patch.binaryPath, 'Antigravity'))
  }

  /** Why the settings file cannot be used, while that lasts (it is never overwritten then). */
  settingsProblem(): string | undefined {
    return this.settingsError
  }

  /**
   * The launch settings changed. A thread's agent process is kept between turns, so idle ones close
   * now and a busy one is replaced on that thread's next turn (resuming its ACP session).
   */
  launchChanged(): void {
    this.userAgyFound = undefined
    this.relaunchAfterSettingsChange()
  }

  /** Idle agent processes close now; a busy one is replaced on that thread's next turn. */
  private relaunchAfterSettingsChange(): void {
    this.launchGeneration += 1
    this.acp.closeIdle()
  }

  /** The saved sign-in no longer works; the row shows Signed out with a Sign in button. */
  private markSignedOut(): void {
    if (!this.signedIn() && !this.settings.models?.length) return
    if (this.runtimeKind() === 'native') this.settings.nativeSignedIn = false
    else this.settings.signedIn = false
    this.settings.models = []
    delete this.settings.modelsRefreshedAt
    this.save()
    this.notifyChanged()
  }

  private notifyChanged(): void {
    if (this.stopped) return
    try { this.hooks.changed?.() } catch { /* a listener must not break provider work */ }
  }

  /**
   * Installs the `agy` release Google's update feed names now into the installation. Install and
   * sign-in are separate: this never starts a sign-in. A manual executable path is dropped so the
   * installed `agy` is used.
   */
  async install(onProgress?: AntigravityInstallProgress): Promise<CliProviderConfig> {
    if (this.stopped) throw new Error('Antigravity provider is stopped')
    if (this.installing) throw new Error('Antigravity is already being installed')
    const abort = new AbortController()
    this.installing = abort
    try {
      await runSharedAntigravityInstall(this.installationHome, abort.signal, onProgress, (signal, progress) => this.installNative(signal, progress))
      // A cancel that lands after the download leaves the settings alone.
      abort.signal.throwIfAborted()
      // The manual path is dropped from the instance config (and its mirror) through the gateway.
      if (this.launchSettings().binaryPath && this.options.saveLaunch) await this.options.saveLaunch({ binaryPath: null })
      this.relaunchAfterSettingsChange()
      return await this.cliConfig()
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new Error('Antigravity install cancelled')
      throw error
    } finally {
      if (this.installing === abort) this.installing = undefined
      // The install is over for every profile, but this one's settings changed just now.
      this.notifyChanged()
    }
  }

  /** Stops the install running in this installation, whichever profile started it; false when none is running. */
  cancelInstall(): boolean {
    return cancelAntigravityInstall(this.installationHome)
  }

  /** Installs the release Google's feed names now; the feed must answer. */
  private async installNative(signal: AbortSignal, progress: AntigravityInstallProgress): Promise<void> {
    const target = this.nativeTarget()
    if (!target) throw new Error('Google publishes no Antigravity CLI for this computer.')
    const release = await this.readFeed(true)
    if (!release) throw new Error('Google\'s Antigravity update feed could not be read. Try again later.')
    const { fetch: fetchFile, verify } = this.options.native ?? {}
    await installNativeAntigravity(this.installationHome, {
      release, target, signal, progress, withdrawn: this.withdrawn(),
      ...(fetchFile ? { fetch: fetchFile } : {}), ...(verify ? { verify } : {})
    })
  }

  /** Whether Mousse's own install is what runs (or would, once installed): Mousse keeps it current. */
  private managesRuntime(): boolean {
    const runtime = this.runtime()
    return runtime ? runtime.source === 'managed' : !this.launchSettings().binaryPath
  }

  /**
   * The release Google's feed names for this computer, read at most every `FEED_TTL_MS` unless
   * `now`. Undefined when it could not be read or names no usable release. Read only while Mousse's
   * own install is what runs. When it names a newer release than the one that runs and no turn is
   * running, the update installs on its own.
   */
  private readFeed(now = false): Promise<NativeRelease | undefined> {
    const target = this.nativeTarget()
    if (!target || (!now && !this.managesRuntime())) return Promise.resolve(this.feed?.value)
    const clock = this.options.native?.now ?? Date.now
    if (!now && this.feed && clock() - this.feed.at < FEED_TTL_MS) return Promise.resolve(this.feed.value)
    if (this.feedReading) return this.feedReading
    const fetchFile = this.options.native?.fetch ?? (underTest() ? undefined : fetch)
    if (!fetchFile) return Promise.resolve(undefined)
    const before = this.feed?.value?.version
    this.feedReading = readVendorFeed(`${NATIVE_FEED_BASE}/${target}.json`, fetchFile)
      .then((raw) => {
        const value = raw === undefined ? undefined : parseVendorFeed(raw, target)
        this.feed = { value, at: clock() }
        if (value?.version !== before) this.notifyChanged()
        if (!now) this.updateWhenIdle()
        return value
      })
      .finally(() => { this.feedReading = undefined })
    return this.feedReading
  }

  /** Installs the feed's release on its own when Mousse's install runs, is older, and nothing is running. */
  private updateWhenIdle(): void {
    if (this.stopped || this.installing || this.acp.busy() || !this.updateAvailable()) return
    void this.install().catch(() => undefined)
  }

  /** The feed names a release that is not the one Mousse's own install runs now. */
  private updateAvailable(): boolean {
    const release = this.feed?.value
    const runtime = this.runtime()
    if (!release || runtime?.source !== 'managed' || nativeReleaseRefusal(release, this.withdrawn())) return false
    const running = this.managedRuntime()?.version
    return running !== release.version
  }

  /**
   * The version Update installs, while Mousse's own install is what runs: the feed's release. The
   * user's own `agy` updates itself and a manual path is the user's, so neither gets one. Reading it
   * starts a feed check when one is due.
   */
  latestVersion(): string | undefined {
    if (!this.managesRuntime()) return undefined
    void this.readFeed()
    const release = this.feed?.value
    if (!release || nativeReleaseRefusal(release, this.withdrawn())) return undefined
    return release.version
  }

  /**
   * Mousse's own install, with its version, when it is what runs: `agy`, else an earlier 1.1.1
   * install. Undefined when the user's own `agy` or a manual path runs.
   */
  managedRuntime(): { path: string; version: string } | undefined {
    if (this.launchSettings().binaryPath || this.userAgy()) return undefined
    const native = this.nativeRuntime()
    if (native) return { path: native.binary, version: native.version }
    const legacy = installedAntigravityBinary(this.installationHome)
    return legacy ? { path: legacy, version: LEGACY_VERSION } : undefined
  }

  closeAll(): void { this.acp.closeAll() }
  stop(): void {
    this.stopped = true
    this.installing?.abort()
    this.unsubscribeInstall()
    for (const session of this.loginSessions) session.abort.abort()
    this.acp.stop()
  }
}
