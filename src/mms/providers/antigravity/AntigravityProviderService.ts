import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { methods } from '@agentclientprotocol/sdk'
import type { CliProviderConfig, CliProviderConfigPatch, ConfiguredProvider, ProviderLoginOption, ProviderLoginResult } from '../../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../../shared/settings'
import { ANTIGRAVITY_INSTANCE_ID } from '../../../shared/providerInstances'
import type { UserQuestionService } from '../../orchestrator/UserQuestionService'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import type { AcpConnectionFactory } from '../../harness/acp/connection'
import { modelOptions } from '../../harness/acp/models'
import { ANTIGRAVITY_AUTH_METHOD, ANTIGRAVITY_LABEL, ANTIGRAVITY_QUIRKS, antigravityConnectionFactory, forwardAntigravityCallback } from '../../harness/acp/presets/antigravity'
import { keepOption } from '../../harness/acp/permissions'
import { AcpSessions, type AcpChatInput, type SavedAcpSession } from '../../harness/acp/session'
import type { LoginSession } from '../LoginSession'
import { settingsMirror, type MirrorField, type VendorMirror } from '../../harness/vendorMirror'
import { requireExecutable, sharedCliVersions, storedCliArgs, storedCliEnv, withUserEnv, type CliVersionCache, type StoredCliConfig } from '../cliConfig'
import { directLaunch } from '../resolveWindowsShim'
import { ANTIGRAVITY_RELEASE, antigravityInstallState, cancelAntigravityInstall, installAntigravity, installedAntigravityBinary, onAntigravityInstallEvent, validateManualAntigravityBinary, type AntigravityInstallProgress } from './installation'

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
  signedIn?: boolean
  sessions?: Record<string, SavedAcpSession>
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
        binary: () => this.binary(),
        args: () => storedCliArgs(this.launchSettings()),
        env: (base) => withUserEnv(base, storedCliEnv(this.launchSettings()))
      }),
      store: {
        saved: (threadId) => this.settings.sessions?.[threadId],
        setSaved: (threadId, saved) => {
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

  private binary(): string | undefined {
    const manual = this.launchSettings().binaryPath
    if (manual) {
      try { return validateManualAntigravityBinary(manual) } catch { return undefined }
    }
    return installedAntigravityBinary(this.installationHome)
  }

  configured(): boolean { return Boolean(this.settings.signedIn && this.binary()) }
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
      this.loginSessions.delete(session)
      // Withdraw the fallback callback prompt and release profile-owned login work.
      session.abort.abort()
    }
  }

  /** Sign-in is separate from install: with no agent there is nothing to sign in to. */
  private async runLogin(session: LoginSession, cwd: string): Promise<ProviderLoginResult> {
    if (!this.binary()) throw new Error(NOT_INSTALLED_MESSAGE)
    session.abort.signal.throwIfAborted()
    let authUrl: string | undefined
    const process = this.acp.launch('sign_in', (url) => {
      authUrl = url
      session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url, usesCallbackServer: true,
        instructions: 'Sign in through Google. If the browser is on another machine, paste its final redirect URL here.' })
    })
    session.abort.signal.addEventListener('abort', () => this.acp.close(process), { once: true })
    try {
      void (async () => {
        while (!session.abort.signal.aborted) {
          const callback = await session.waitForCallbackUrl()
          try {
            if (!authUrl) throw new Error('Wait for Google to start sign-in before forwarding a redirect')
            await forwardAntigravityCallback(authUrl, callback)
            return
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (authUrl) session.emitEvent({ sessionId: session.sessionId, type: 'auth_url', url: authUrl, usesCallbackServer: true, instructions: message })
            else session.emitEvent({ sessionId: session.sessionId, type: 'progress', message })
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
      this.settings = { ...this.settings, signedIn: true, models, modelsRefreshedAt: new Date().toISOString() }
      this.save()
      return { success: true, sessionId: session.sessionId }
    } catch (error) {
      const cancelled = session.abort.signal.aborted
      return { success: false, sessionId: session.sessionId, error: cancelled ? 'Login cancelled' : error instanceof Error ? error.message : String(error) }
    } finally { this.acp.close(process) }
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
    return antigravityInstallState(this.installationHome)
  }

  /** The verified install this installation holds, when present. */
  managedBinary(): string | undefined {
    return installedAntigravityBinary(this.installationHome)
  }

  /** Whether the profile completed a sign-in that the agent has not since refused. */
  signedIn(): boolean {
    return Boolean(this.settings.signedIn)
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
      this.settings.models = []
      delete this.settings.modelsRefreshedAt
      this.settings.sessions = {}
      this.save()
      this.notifyChanged()
    }
  }
  /** The executable path, launch args and environment set in Settings → Providers. */
  async cliConfig(): Promise<CliProviderConfig> {
    const install = antigravityInstallState(this.installationHome)
    const resolvedBinaryPath = this.binary()
    const stored = this.launchSettings()
    // The pinned install is verified by hash, so its version is known without starting it.
    const version = resolvedBinaryPath && resolvedBinaryPath === installedAntigravityBinary(this.installationHome)
      ? ANTIGRAVITY_RELEASE.replace(/^agy_acp_server_/, '')
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
    if (!this.settings.signedIn && !this.settings.models?.length) return
    this.settings.signedIn = false
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
      await installAntigravity(this.installationHome, abort.signal, onProgress)
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
    return cancelAntigravityInstall(this.installationHome)
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
