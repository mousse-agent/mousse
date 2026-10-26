import type { AuthState, InstallOwner } from '../../shared/harness/status'
import type { HarnessCaps, HarnessDriverKind, RuntimeFacts } from '../../shared/harness/types'
import type { CliProviderConfigPatch, ConfiguredProvider, ProviderLoginResult } from '../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../shared/settings'
import type { UserQuestionService } from '../orchestrator/UserQuestionService'
import type { StoredCliConfig } from '../providers/cliConfig'
import type { LoginSession } from '../providers/LoginSession'
import type { ProviderAdapter } from '../run/adapters/ProviderAdapter'
import type { ProviderRef } from '../run/types'
import type { InstanceEnv } from './env'

/**
 * A driver is a kind of runtime (Claude Code, Codex, Antigravity, the pi loop). The gateway asks
 * it for one `DriverRuntime` per instance revision and owns everything around it: probes,
 * timeouts, scope, model prefs and the edge cases callers never see. Drivers do no retries,
 * timeouts or capability fallbacks.
 *
 * PR 1 drivers wrap today's provider services and run adapters; each instance gets its own adapter
 * built by the driver's factory.
 */

/** Instance settings kept in the instance's `config` object, decoded leniently. */
export interface InstanceConfig {
  displayName?: string
  /** `private`: a Mousse-owned home under `<profileHome>/harness/<instanceId>/home`. */
  home: 'default' | 'private'
  loginMethod?: string
  /** Launch settings of an added instance (built-in instances keep theirs in `settings.json`). */
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
}

/** Runtime facts as a runtime reports them; the gateway stamps the instance and its counters. */
export type RuntimeFactsReport = Omit<RuntimeFacts, 'instanceId' | 'configRevision' | 'accountGeneration'>

/** What the driver's sign-in check says, before the gateway adds timing and staleness. */
export interface AuthReading {
  state: AuthState
  /** What the page shows about the account (plan, organization); never identifies it. */
  account?: { label?: string }
  /**
   * The vendor's stable id of the signed-in account (or of the credential it runs with). The
   * gateway only hashes it with a per-profile salt and the home; it is never shown or stored.
   * Absent when the driver cannot establish it: native sessions are then not resumed.
   */
  subject?: string
  methodLabel?: string
  message?: string
  /** The terminal command that signs the instance in, when sign-in happens outside Mousse. */
  signInCommand?: string
}

export interface DriverContext {
  instanceId: string
  builtIn: boolean
  config: InstanceConfig
  env: InstanceEnv
  profileHome: string
  installationHome: string
  /** `<profileHome>/harness/<instanceId>`: state of an added instance. */
  stateDir: string
  questions: UserQuestionService
  /** The binary the gateway resolved for the instance (override, managed or PATH). */
  findBinary(): string | undefined
  /** Clients learn about a change the runtime noticed on its own (sign-in refused, install done). */
  changed(): void
}

/**
 * What a runtime that keeps one live process per thread reports to the host: background work (a
 * helper agent, a shell) starting or ending, a turn the runtime started on its own when that work
 * finished, and a line for the thread's user.
 */
export interface LiveProcessHost {
  backgroundWork?(threadId: string, active: boolean): void
  /** The host runs it as a run of the thread, whose turn names `info.id` as its continuation. */
  continuationStarted?(threadId: string, info: { id: string; taskIds: string[]; summaries: string[] }): void
  notice?(threadId: string, text: string): void
}

export interface DriverRuntime {
  /** The turn runtime of this instance. */
  readonly adapter: ProviderAdapter
  /** Signed in and installed, so its models can be the default. */
  configured(): boolean
  /** The Settings listings of a vendor instance (`providers.listConfigured`, model pickers). */
  configuredProvider?(): ConfiguredProvider | undefined
  llmProvider?(): LlmProviderOption | undefined
  /** Models as the runtime last listed them (or its fallback aliases). */
  models(): LlmModelOption[]
  /** The stored launch settings (built-in vendor instances: their `settings.json`). */
  launch?(): StoredCliConfig
  /** Saves launch settings of a built-in instance; added instances are configured by the gateway. */
  setLaunch?(patch: CliProviderConfigPatch): Promise<void>
  /** `force` skips the runtime's own cache (Recheck; turn admission without `identity`). */
  auth(options: { force: boolean; signal?: AbortSignal }): Promise<AuthReading>
  /**
   * The account the runtime would run as now (`AuthReading.subject`), read cheaply at every turn
   * admission: no model call, no runtime start. Without it the gateway uses `auth({ force: true })`.
   */
  identity?(signal: AbortSignal): Promise<string | undefined>
  refreshModels?(cwd: string): Promise<void>
  signIn?(session: LoginSession, cwd: string, method?: string): Promise<ProviderLoginResult>
  signOut?(): Promise<void>
  install?(onProgress: (message: string, fraction?: number) => void): Promise<void>
  cancelInstall?(): boolean
  installState?(): { installing: boolean; progress?: string }
  /** A Mousse-managed install and its known version. */
  managed?(): { path: string; version?: string } | undefined
  /** Validates an override path beyond "exists and runs" (throws when invalid). */
  validateOverride?(path: string): void
  /** Forget the native session of a thread so its next turn hands history over instead. */
  forgetConversation?(threadId: string): void
  /**
   * Kills the processes serving `ref` (the whole tree). The gateway calls it when a native cancel
   * misses its deadline (`supervise.interruptWithDeadline`); the live turn then ends as interrupted.
   */
  terminate?(ref: ProviderRef): void
  /**
   * What the runtime last learned about itself for this instance (an ACP `initialize`, a
   * `session/new`). The gateway stores it per instance and passes it to `HarnessDriver.caps`.
   */
  runtimeFacts?(): RuntimeFactsReport | undefined
  /**
   * A short start-up check that records fresh facts without opening a model session (ACP:
   * `initialize` only, in a temporary folder, the process tree killed afterwards). Run on Add,
   * Recheck and after install, never on the periodic probe. Throws when the runtime cannot start.
   */
  handshake?(signal: AbortSignal): Promise<void>
  /** A runtime with live processes per thread reports to `host` (null detaches it). */
  setLiveHost?(host: LiveProcessHost | null): void
  /** The turn the thread's live process started itself and is running now, if any. */
  inFlightContinuation?(threadId: string): { id: string; discarded: boolean } | undefined
  /** The thread's live process still holds that turn of its own (any, without `id`). */
  hasContinuation?(threadId: string, id?: string): boolean
  /** Drops the turns of its own the thread's live process holds (only `id`, when given). */
  discardContinuations?(threadId: string, id?: string): void
  stop(): void
}

export interface HarnessDriver {
  readonly kind: HarnessDriverKind
  readonly label: string
  /** Executable names searched on PATH; empty for runtimes Mousse hosts itself. */
  readonly binaryNames: readonly string[]
  /** Versions Mousse was tested with; a newer one is reported, never blocked. */
  readonly testedVersions?: { min: string; max: string }
  /** The driver can run several instances (Add dialog); others have only their built-in one. */
  readonly multiInstance: boolean
  /** Supports a Mousse-owned home (`InstanceConfig.home = private`). */
  readonly privateHome: boolean
  readonly canInstall: boolean
  /** Runs a model the user adds by id (custom models); otherwise only the models it lists. */
  readonly customModels: boolean
  /** How the driver's instances sign in, for display. */
  readonly methodLabel?: string
  /** Lenient decoder of an instance's stored `config`: unknown or malformed fields fall back. */
  decodeConfig(raw: Record<string, unknown> | undefined): InstanceConfig
  /**
   * Capabilities for an instance at an installed version. `facts` (when the runtime reported them)
   * refine what a preset cannot know statically: fork, plan mode, models.
   */
  caps(config: InstanceConfig, installedVersion?: string, facts?: RuntimeFacts): HarnessCaps
  /**
   * Arguments that make the executable print its version; `null` when it has no such flag (the
   * probe then skips the version check and the handshake decides whether it runs). Default
   * `['--version']`.
   */
  versionArgs?(config: InstanceConfig): string[] | null
  create(context: DriverContext): DriverRuntime
  /** The command that updates a binary installed by `owner`, when there is one. */
  updateCommand?(owner: InstallOwner): string | undefined
}

/** Shared lenient decoder for the fields every driver understands. */
export function decodeInstanceConfig(raw: Record<string, unknown> | undefined, options: { privateHome: boolean }): InstanceConfig {
  const config: InstanceConfig = { home: 'default' }
  if (!raw) return config
  if (typeof raw.displayName === 'string' && raw.displayName.trim()) config.displayName = raw.displayName.trim().slice(0, 80)
  if (options.privateHome && raw.home === 'private') config.home = 'private'
  if (typeof raw.loginMethod === 'string' && raw.loginMethod) config.loginMethod = raw.loginMethod
  if (typeof raw.binaryPath === 'string' && raw.binaryPath.trim()) config.binaryPath = raw.binaryPath.trim()
  if (Array.isArray(raw.args)) config.args = raw.args.filter((arg): arg is string => typeof arg === 'string')
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env = Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    if (Object.keys(env).length) config.env = env
  }
  return config
}

/** Compares dotted versions numerically (`1.10.0` > `1.9.3`); a pre-release counts as its release. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The install owner a binary path proves, from where package managers put their executables. */
export function installOwner(path: string | undefined, source: 'path' | 'managed' | 'override' | 'bundled'): InstallOwner {
  if (source === 'managed') return 'managed'
  if (!path) return 'unknown'
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.includes('/homebrew/') || normalized.includes('/cellar/') || normalized.includes('/linuxbrew/')) return 'brew'
  if (normalized.includes('/pnpm/')) return 'pnpm'
  if (normalized.includes('/.bun/')) return 'bun'
  if (normalized.includes('/node_modules/') || normalized.includes('/npm/') || normalized.endsWith('.cmd')) return 'npm'
  if (normalized.includes('/winget/')) return 'winget'
  if (normalized.includes('/.local/bin/') || normalized.includes('/.local/share/')) return 'standalone'
  return 'unknown'
}
