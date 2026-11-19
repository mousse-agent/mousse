import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { methods } from '@agentclientprotocol/sdk'
import type { CliProviderConfig, CliProviderConfigPatch, ConfiguredProvider, ProviderLoginOption, ProviderLoginResult } from '../../../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../../../shared/settings'
import { ANTIGRAVITY_INSTANCE_ID } from '../../../../../shared/providerInstances'
import type { UserQuestionService } from '../../../../orchestrator/UserQuestionService'
import { atomicWriteJsonSync } from '../../../../data/AtomicFs'
import type { AcpConnectionFactory } from '../../connection'
import { modelOptions } from '../../models'
import { ANTIGRAVITY_AUTH_METHOD, ANTIGRAVITY_LABEL, ANTIGRAVITY_QUIRKS, antigravityConnectionFactory, forwardAntigravityCallback, type AntigravityRuntimeChoice } from '../antigravity'
import { keepOption } from '../../permissions'
import { AcpSessions, type AcpChatInput, type SavedAcpSession } from '../../session'
import type { LoginSession } from '../../../../providers/LoginSession'
import { settingsMirror, type MirrorField, type VendorMirror } from '../../../vendorMirror'
import { requireExecutable, sharedCliVersions, storedCliArgs, storedCliEnv, withUserEnv, type CliVersionCache, type StoredCliConfig } from '../../../cliConfig'
import { directLaunch } from '../../../resolveWindowsShim'
import { ANTIGRAVITY_RELEASE, antigravityInstallState, cancelAntigravityInstall, installAntigravity, installedAntigravityBinary, onAntigravityInstallEvent, validateManualAntigravityBinary, type AntigravityInstallProgress } from './installation'
import { activeNativeRuntime, installNativeAntigravity, readVendorFeed, type NativeRuntime, type NativeVerifier } from './nativeInstall'
import { NATIVE_FEED_BASE, NATIVE_RELEASES, WITHDRAWN_NATIVE_VERSIONS, classifyVendorFeed, nativeQualified, nativeReleaseRefusal, nativeTarget, type NativeRelease, type NativeTarget, type VendorFeed } from './nativeRelease'

/** The 1.1.1 ACP server's version, as Mousse reports it. */
const LEGACY_VERSION = ANTIGRAVITY_RELEASE.replace(/^agy_acp_server_/, '')
/** Google's update feed is read at most this often (the pace of other agents' version checks). */
const FEED_TTL_MS = 6 * 60 * 60_000

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
   * Signed in on the native CLI. Kept apart from `signedIn`: the two runtimes keep the Google session
   * in different places and Mousse never moves one into the other, so a switch asks for a new sign-in.
   */
  nativeSignedIn?: boolean
  sessions?: Record<string, SavedAcpSession>
  /** The runtime `sessions` were opened on (absent: the 1.1.1 server). Another runtime starts them anew. */
  sessionsRuntime?: AntigravityRuntimeChoice['kind']
}
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
  /** Test seams for the native CLI: where it qualifies, the target, the reviewed release and the network. */
  native?: {
    qualified?: (platform: NodeJS.Platform) => boolean
    target?: NativeTarget
    release?: NativeRelease
    fetch?: typeof fetch
    verify?: NativeVerifier
    withdrawn?: readonly string[]
    now?: () => number
  }
}

/**
 * The profile's Antigravity: its settings, the pinned install and the Google sign-in. Turns run
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
  /** Google's update feed as last read, and when; read only where the native CLI qualifies. */
  private feed?: { value: VendorFeed | undefined; at: number }
  private feedReading?: Promise<VendorFeed | undefined>
  /** The latest progress line of this service's native install. */
  private nativeProgress?: string
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
      defaultInstanceId: ANTIGRAVITY_INSTANCE_ID,
      questions,
      quirks: ANTIGRAVITY_QUIRKS,
      // Antigravity's own option labels; it asks for every tool.
      classifyOption: keepOption,
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
    // The download is shared by every profile of the installation; each tells its own clients.
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
   * The agent that runs. A manual path is always the user's own 1.1.1 server. Otherwise the native
   * CLI runs where it qualifies and a verified copy is installed; else the 1.1.1 install, which
   * stays as the fallback.
   */
  private runtime(): AntigravityRuntimeChoice | undefined {
    const manual = this.launchSettings().binaryPath
    if (manual) {
      try { return { kind: 'legacy', binary: validateManualAntigravityBinary(manual) } } catch { return undefined }
    }
    const native = this.nativeRuntime()
    if (native) return { kind: 'native', binary: native.binary }
    const legacy = installedAntigravityBinary(this.installationHome)
    return legacy ? { kind: 'legacy', binary: legacy } : undefined
  }

  private binary(): string | undefined { return this.runtime()?.binary }

  /** The kind that runs now; with nothing installed, the kind an install would add. */
  private runtimeKind(): AntigravityRuntimeChoice['kind'] {
    return this.runtime()?.kind ?? (this.nativeAllowed() && !this.launchSettings().binaryPath ? 'native' : 'legacy')
  }

  private sessionsRuntime(): AntigravityRuntimeChoice['kind'] { return this.settings.sessionsRuntime ?? 'legacy' }

  private nativeAllowed(): boolean {
    return (this.options.native?.qualified ?? nativeQualified)(process.platform) && this.nativeTarget() !== undefined
  }

  /** This computer's target, found once (Linux checks for musl on disk). */
  private target?: { value: NativeTarget | undefined }
  private nativeTarget(): NativeTarget | undefined {
    this.target ??= { value: this.options.native?.target ?? nativeTarget() }
    return this.target.value
  }
  private nativeRelease(): NativeRelease | undefined {
    const target = this.nativeTarget()
    return this.options.native?.release ?? (target ? NATIVE_RELEASES[target] : undefined)
  }
  private withdrawn(): readonly string[] { return this.options.native?.withdrawn ?? WITHDRAWN_NATIVE_VERSIONS }

  /** The verified native install, only where the native CLI qualifies. */
  private nativeRuntime(): NativeRuntime | undefined {
    return this.nativeAllowed() ? activeNativeRuntime(this.installationHome, this.nativeTarget(), this.withdrawn()) : undefined
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

  /** Sign-in is separate from install: with no agent there is nothing to sign in to. */
  private async runLogin(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    if (!this.binary()) throw new Error(NOT_INSTALLED_MESSAGE)
    session.abort.signal.throwIfAborted()
    // The agent prints Google's link a moment after it starts; until then the sign-in shows as starting.
    session.emitEvent({ sessionId: session.sessionId, type: 'progress', message: 'Starting Google sign-in…' })
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
      await process.connection.agent.request(methods.agent.authenticate, { methodId: ANTIGRAVITY_AUTH_METHOD })
      const newSession = await process.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
      session.abort.signal.throwIfAborted()
      const models = modelOptions(newSession)
      if (!models.length) throw new Error('Google agent did not confirm account model access')
      this.signInGeneration += 1
      const signedInFlag = this.runtimeKind() === 'native' ? { nativeSignedIn: true } : { signedIn: true }
      this.settings = { ...this.settings, ...signedInFlag, models, modelsRefreshedAt: new Date().toISOString() }
      this.save()
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      const cancelled = session.abort.signal.aborted
      return { success: false, sessionId: session.sessionId, error: cancelled ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
    } finally { ended.abort() }
  }

  /** Record only the canonical history that the owning turn durably committed. */
  commitConversation(threadId: string, history: string): void {
    this.acp.commitConversation(threadId, history)
  }

  /** A turn on the thread's agent session (see `AcpSessions.chat`). */
  async chat(input: AcpChatInput): Promise<string> {
    input.signal?.throwIfAborted()
    if (!this.configured()) throw new Error('Antigravity is not signed in')
    return this.acp.chat(input)
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

  /** The agent's launch state for status: installing, and the executable it would run. */
  installState(): { installing: boolean; progress?: string } {
    if (this.installing && this.nativeAllowed()) return { installing: true, ...(this.nativeProgress ? { progress: this.nativeProgress } : {}) }
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

  /** Checks launch settings before the gateway saves them: a manual agent without its helper. */
  validateLaunch(patch: CliProviderConfigPatch): void {
    if (typeof patch.binaryPath === 'string') validateManualAntigravityBinary(requireExecutable(patch.binaryPath, 'Antigravity'))
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
   * Downloads Google's pinned agent into the installation. Install and sign-in are separate:
   * this never starts a sign-in. A manual executable path is dropped so the verified install is used.
   */
  async install(onProgress?: AntigravityInstallProgress): Promise<CliProviderConfig> {
    if (this.stopped) throw new Error('Antigravity provider is stopped')
    if (this.installing) throw new Error('Antigravity is already being installed')
    const abort = new AbortController()
    this.installing = abort
    try {
      if (this.nativeAllowed()) await this.installNative(abort.signal, onProgress)
      else await installAntigravity(this.installationHome, abort.signal, onProgress)
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

  /** Stops the install running in this installation; false when none is running. */
  cancelInstall(): boolean {
    if (this.installing && this.nativeAllowed()) {
      this.installing.abort()
      return true
    }
    return cancelAntigravityInstall(this.installationHome)
  }

  /**
   * Installs the reviewed native release (never one the feed names), after asking the feed whether
   * Google withdrew it. An unreadable feed does not block: the release is checked on its own.
   */
  private async installNative(signal: AbortSignal, onProgress?: AntigravityInstallProgress): Promise<void> {
    const release = this.nativeRelease()
    const target = this.nativeTarget()
    if (!release || !target) throw new Error('Google publishes no Antigravity CLI for this computer.')
    const feed = await this.readFeed(true)
    const { fetch: fetchFile, verify } = this.options.native ?? {}
    try {
      await installNativeAntigravity(this.installationHome, {
        release, target, signal, withdrawn: this.withdrawn(),
        ...(feed ? { feed } : {}), ...(fetchFile ? { fetch: fetchFile } : {}), ...(verify ? { verify } : {}),
        progress: (message, fraction, bytes) => {
          this.nativeProgress = message
          try { this.hooks.installProgress?.(message) } catch { /* progress is best effort */ }
          onProgress?.(message, fraction, bytes)
        }
      })
    } finally { this.nativeProgress = undefined }
  }

  /**
   * Google's feed entry for this computer, at most every `FEED_TTL_MS` unless `now`. Undefined when
   * it could not be read. It tells only whether the reviewed release was withdrawn or a newer one exists.
   */
  private readFeed(now = false): Promise<VendorFeed | undefined> {
    const target = this.nativeTarget()
    const release = this.nativeRelease()
    if (!target || !release || !this.nativeAllowed()) return Promise.resolve(undefined)
    const clock = this.options.native?.now ?? Date.now
    if (!now && this.feed && clock() - this.feed.at < FEED_TTL_MS) return Promise.resolve(this.feed.value)
    if (this.feedReading) return this.feedReading
    const fetchFile = this.options.native?.fetch ?? (process.env.NODE_ENV === 'test' ? undefined : fetch)
    if (!fetchFile) return Promise.resolve(undefined)
    const before = this.feed?.value?.kind
    this.feedReading = readVendorFeed(`${NATIVE_FEED_BASE}/${target}.json`, fetchFile)
      .then((raw) => {
        const value = raw === undefined ? undefined : classifyVendorFeed(raw, target, release)
        this.feed = { value, at: clock() }
        if (value?.kind !== before) this.notifyChanged()
        return value
      })
      .finally(() => { this.feedReading = undefined })
    return this.feedReading
  }

  /**
   * The version Update installs: the reviewed native release where it qualifies and is not
   * withdrawn, else the 1.1.1 server. Reading it starts a feed check when one is due.
   */
  pinnedVersion(): string {
    if (!this.nativeAllowed()) return LEGACY_VERSION
    void this.readFeed()
    const release = this.nativeRelease()
    if (!release || nativeReleaseRefusal(release, this.feed?.value, this.withdrawn())) return this.managedRuntime()?.version ?? LEGACY_VERSION
    return release.version
  }

  /** Mousse's own verified install, with its version: the native CLI where it qualifies, else the 1.1.1 server. */
  managedRuntime(): { path: string; version: string } | undefined {
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
