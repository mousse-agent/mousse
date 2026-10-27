import type { AuthState, CredentialKind, InstallOwner } from '../../shared/harness/status'
import type { CustomModel, HarnessCaps, HarnessDriverKind, RemoveInstallResult, RuntimeFacts } from '../../shared/harness/types'
import type { NeutralTool } from '../../shared/harness/tools'
import type { PermissionLimits } from '../../shared/permissionMode'
import type { CliProviderConfigPatch, ConfiguredProvider, ProviderLoginResult, ProviderUsage } from '../../shared/providerAuth'
import type { LlmModelOption, LlmProviderOption } from '../../shared/settings'
import type { UserQuestionService } from '../orchestrator/UserQuestionService'
import type { AcpSource } from './acp/preset'
import type { LoginSession } from '../providers/LoginSession'
import type { ProviderAdapter } from '../run/adapters/ProviderAdapter'
import type { McpTurnBinding } from '../run/mcp/appTools/registry'
import type { ProviderRef } from '../run/types'
import type { InstanceEnv } from './env'
import type { LatestVersionSource } from './latest'
import type { SpendModelFacts } from './policy'
import type { VendorMirror } from './vendorMirror'

/**
 * A driver is a kind of runtime (Claude Code, Codex, Antigravity, the pi loop). The gateway asks
 * it for one `DriverRuntime` per instance revision and owns everything around it: probes,
 * timeouts, scope, model prefs and the edge cases callers never see. Drivers never retry, and set
 * no timeouts or capability fallbacks of their own. A runtime retries its own provider requests as
 * Mousse configures it (Claude Code's, Codex's and Pi's own retries); the gateway's only retry is
 * the turn retry when no side effect is possible.
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
  /**
   * Launch settings, kept by every instance (a cleared one is stored as `null` and decodes as
   * absent). Built-in vendor instances also mirror them to their `settings.json` (`vendorMirror`).
   */
  binaryPath?: string
  args?: string[]
  env?: Record<string, string>
  /** Where an ACP agent comes from (the `acp` driver); derived from the fields above when absent. */
  source?: AcpSource
  /** The entry this one moved to (`instances.move`): turned off, and its threads continue there. */
  movedTo?: string
  /**
   * How a driver with several setups runs this entry (Codex: `managed`, Mousse's own download and
   * sign-in, or `existing`, the user's Codex CLI). Chosen when the entry is added; fixed after.
   */
  setup?: 'managed' | 'existing'
  /**
   * Which engine runs a `pi` instance: Pi's agent as its own process (`rpc`) or the in-process pi
   * loop (`legacy`). Stored only as the user's choice; decoded with the instance id it is the
   * engine in effect (`drivers/pi/engines.ts`). Part of the record key: a switch builds a new runtime.
   */
  engine?: 'rpc' | 'legacy'
  /**
   * Signed out in Mousse (Sign out on the page): the gateway refuses its turns and reports it signed
   * out without asking the runtime, whatever the agent's own sign-in says.
   */
  signedOutInMousse?: boolean
  /**
   * `locked`: the entry runs bots only, in a home of its own, under the locked profile of its driver
   * (Claude Code, PR 6 §3): no user settings, plugins or launch settings, the exact granted tools,
   * Mousse's grant gate on every call. Chosen when the entry is added; absent for every other entry.
   */
  profile?: 'locked'
}

/** Whether an entry runs in a Mousse-owned home: it must, it may, or it must not. */
export type PrivateHomeRule = 'required' | 'allowed' | 'forbidden'

/** Progress of an install: a line to show, and bytes when a download knows them. */
export interface InstallProgress {
  message: string
  fraction?: number
  receivedBytes?: number
  totalBytes?: number
}

export interface InstallResult {
  config?: Record<string, unknown>
}

export interface ManagedInstall {
  path: string
  version?: string
  /** What the download takes on disk. */
  bytes?: number
  /** Whether the registry gave a checksum for the download. */
  checksum?: 'registry' | 'none'
  /** Why the installed files may not run (they changed since install). */
  broken?: string
  /** Something to tell the user about the install. */
  advisory?: string
}

/** What a runtime says of the account's usage; the gateway adds the instance's id and name. */
export type RuntimeUsage = Pick<ProviderUsage, 'status' | 'windows' | 'message' | 'manageUrl'>

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
  /** A sign-in can start in Mousse now, whatever `state` says (an agent that offers its methods). */
  canSignIn?: boolean
  /** The sign-in is one Mousse made and keeps (it may sign out), beyond the gateway's own rules. */
  ownedByMousse?: boolean
  /** What the instance runs on (`InstanceSnapshot.auth.credential`), from what the driver already knows: never another check. */
  credential?: CredentialKind
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
  /** Whether the instance is signed out in Mousse (`InstanceConfig.signedOutInMousse`), read live. */
  signedOut(): boolean
  /**
   * Saves launch settings the runtime learned itself (a path entered at sign-in, a manual path an
   * install replaces) through the gateway's `configure`, so they land in the instance config.
   */
  saveLaunch(patch: CliProviderConfigPatch): Promise<void>
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

/**
 * One model request with no tools and no session (a chat title), run by the gateway's `oneShot`.
 * The gateway resolved and admitted the selection and owns the timeout; the driver makes exactly one
 * request and never retries.
 */
export interface OneShotSpec {
  /** The model as selected (a `:effort` suffix included, when the selection had one). */
  model: string
  effort?: string
  /** The user's custom model of that id on this instance, when it is one. */
  customModel?: CustomModel
  system: string
  prompt: string
  /** Prompt-cache affinity, hashed before it reaches the provider (a thread id). */
  sessionKey?: string
  /** Called on every event the provider sends; the gateway's inactivity timeout restarts. */
  onActivity(): void
}

export interface DriverRuntime {
  /** The turn runtime of this instance. */
  readonly adapter: ProviderAdapter
  /** Runs agent definitions' turns, when they do not run on `adapter` (`HarnessDriver.definitionCaps`). */
  readonly definitionAdapter?: ProviderAdapter
  /**
   * One request with no tools (`HarnessDriver.oneShot`). Throws the provider's failure; `signal`
   * aborts it (the caller stopped, or the gateway's inactivity timeout).
   */
  oneShot?(spec: OneShotSpec, signal: AbortSignal): Promise<{ text: string }>
  /**
   * What token and spend limits need from `model` (`SpendModelFacts`), read at turn admission only
   * when the policy has such a limit and the caps reserve spend. Absent or undefined refuses them.
   */
  spendModel?(model: string): SpendModelFacts | undefined
  /** Signed in and installed, so its models can be the default. */
  configured(): boolean
  /** The Settings listings of a vendor instance (`providers.listConfigured`, model pickers). */
  configuredProvider?(): ConfiguredProvider | undefined
  llmProvider?(): LlmProviderOption | undefined
  /** Models as the runtime last listed them (or its fallback aliases). */
  models(): LlmModelOption[]
  /**
   * The model a turn on `model` runs, fixed when the turn is bound (a `default` becomes the first
   * listed model), so a retry or recovery runs the same one whatever the listing says later.
   * Undefined when no model is listed. Without it, the binding keeps `model` as selected.
   */
  concreteModel?(model: string): string | undefined
  /**
   * The copy of the instance's launch settings and sign-out flag in the vendor's own `settings.json`
   * (`harness/vendorMirror`), kept so an older Mousse reads what the user set. Only the gateway uses it.
   */
  vendorMirror?: VendorMirror
  /** Checks a launch-settings patch before anything is saved (an executable that cannot run, unsupported args). */
  validateLaunch?(patch: CliProviderConfigPatch): void
  /** The instance's launch settings changed: processes started with the old ones are replaced. */
  launchChanged?(): void
  /**
   * The plan usage of the signed-in account, for the usage page (`HarnessInstances.usage`): the
   * windows the provider reports, or `unavailable` with a link when only its own site has them.
   * Throws when it cannot be read; the gateway reports that as an error entry. Absent: no usage.
   */
  usage?(signal: AbortSignal): Promise<RuntimeUsage>
  /** `force` skips the runtime's own cache (Recheck; turn admission without `identity`). */
  auth(options: { force: boolean; signal?: AbortSignal }): Promise<AuthReading>
  /**
   * The account the runtime would run as now (`AuthReading.subject`), read cheaply at every turn
   * admission: no model call, no runtime start. Without it the gateway uses `auth({ force: true })`.
   */
  identity?(signal: AbortSignal): Promise<string | undefined>
  /**
   * What limits the permission modes the runtime can enforce for a turn in `cwd` (Claude Code: the
   * user's settings forbid bypassing permissions). Read at every turn admission and snapshot, never
   * cached: the user may edit their settings at any time. Synchronous, no runtime start.
   */
  permissionLimits?(cwd?: string): PermissionLimits | undefined
  refreshModels?(cwd: string): Promise<void>
  /**
   * When the stored model list was last updated from the vendor (ISO time), kept with the list so
   * its age survives a restart; undefined for a fallback list. Without it the gateway knows only
   * the refreshes of this run.
   */
  modelsRefreshedAt?(): string | undefined
  signIn?(session: LoginSession, cwd: string, method?: string): Promise<ProviderLoginResult>
  signOut?(): Promise<void>
  /**
   * The instance's credential changed outside its own sign-in and sign-out (another surface set a
   * key or signed in): a runtime holding credentials in its processes retires them.
   */
  credentialsChanged?(): Promise<void>
  /** The API key this entry runs with, for a move that copies it (model APIs with a saved key). */
  exportApiKey?(): Promise<string | undefined>
  /** Saves `apiKey` as this entry's own credential (a move that copies the old entry's key). */
  adoptApiKey?(apiKey: string): Promise<void>
  /**
   * This runtime's name for a model of a model API that moved here and that it does not list under
   * the same id (Claude Code: `claude-sonnet-4-5` → `sonnet`). Undefined: the agent's default.
   */
  movedModel?(model: string): string | undefined
  /**
   * Installs (or updates) the runtime. A result's `config` is merged into the instance's stored
   * config, which moves its revision on (a registry agent records the install it was made with).
   */
  install?(onProgress: (progress: InstallProgress) => void): Promise<void | InstallResult>
  cancelInstall?(): boolean
  installState?(): { installing: boolean; progress?: string }
  /** A Mousse-managed install and its known version. */
  managed?(): ManagedInstall | undefined
  /**
   * The runtime runs only Mousse's own install, at the version Mousse ships: no binary on PATH is
   * ever used, and an update is a newer version Mousse ships, not the vendor's latest.
   */
  pinned?(): { version: string }
  /**
   * Checks every installed file against its install record (Recheck, Add, after install); a
   * mismatch shows through `managed().broken`.
   */
  verifyInstall?(signal: AbortSignal): Promise<void>
  /** Deletes the instance's downloaded files; other entries using them block it unless `force`. */
  removeInstall?(options: { force: boolean }): Promise<RemoveInstallResult>
  /** The instance is being removed: it lets go of shared installs (its files stay unless deleted). */
  release?(): Promise<void>
  /**
   * The instance is being removed: deletes the sign-ins Mousse keeps for it, after stopping
   * everything that used them, and revokes them. It resolves only once nothing in the instance's
   * folder is needed any more; when it throws, the instance is kept so removing it again retries.
   */
  deleteCredentials?(): Promise<void>
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
  /**
   * Ends the runtime (its instance was replaced or removed). A runtime with processes returns a
   * promise that settles once they exited; the gateway deletes a removed instance's files only then
   * (Windows keeps open files locked).
   */
  stop(): void | Promise<void>
}

/** The Move prompt of a retired instance (its card and chats), and the target its errors name. */
export interface RetiredPrompt {
  title: string
  detail: string
  target: string
}

export interface HarnessDriver {
  readonly kind: HarnessDriverKind
  readonly label: string
  /** Executable names searched on PATH; empty for runtimes Mousse hosts itself. */
  readonly binaryNames: readonly string[]
  /** Versions Mousse was tested with; a newer one is reported, never blocked. */
  readonly testedVersions?: { min: string; max: string }
  /** Where the newest published version is known from; none for an agent whose releases Mousse cannot see. */
  readonly latestVersion?: LatestVersionSource
  /** The driver can run several instances (Add dialog); others have only their built-in one. */
  readonly multiInstance: boolean
  /** Supports a Mousse-owned home (`InstanceConfig.home = private`). */
  readonly privateHome: boolean
  /**
   * Whether an entry with `config` runs in a Mousse-owned home, when that depends on the config
   * (Codex: a managed entry always does, the user's own Codex never). Without it, `privateHome`
   * decides: `allowed` or `forbidden`.
   */
  privateHomeFor?(config: InstanceConfig): PrivateHomeRule
  /**
   * Every instance, built-in ones included, runs with a Mousse-owned home under its state dir,
   * whatever its config says (a runtime Mousse hosts itself and never points at the user's home).
   */
  readonly alwaysPrivateHome?: boolean | ((config: InstanceConfig) => boolean)
  readonly canInstall: boolean
  /** Runs a model the user adds by id (custom models); otherwise only the models it lists. */
  readonly customModels: boolean
  /**
   * Its runtimes run a single request with no tools (`DriverRuntime.oneShot`), so its models can name
   * chats. Agent runtimes run turns only (absent = false).
   */
  readonly oneShot?: boolean
  /** How the driver's instances sign in, for display. */
  readonly methodLabel?: string
  /**
   * How the runtime's Mousse MCP calls are tied to the turn that made them (PR 2 §2): `per_call`
   * (every call carries the turn's token), `drained_turn` (the bearer is reused only after a turn
   * proven drained) or `rotate` (a new bearer every turn). A static fact, not a capability: nothing
   * in policy reads it. Every driver whose caps have `mcp: true` declares one (conformance test).
   */
  readonly mcpTurnBinding?: McpTurnBinding
  /** The user's own MCP servers: attached by the runtime itself, or proxied by Mousse (default `native`). */
  readonly userMcp?: 'native' | 'proxy'
  /**
   * The runtime hands a Mousse MCP tool result's images to its model, and the models it lists read
   * images (a browser screenshot reaches the model). A custom model's own capabilities win. An ACP
   * agent without it reads images when its `initialize` says so (`promptCapabilities.image`).
   */
  readonly mcpImageResults?: boolean
  /**
   * Its runtimes may keep a copy of their settings in a vendor file (`DriverRuntime.vendorMirror`),
   * reconciled when the gateway starts.
   */
  readonly mirrorsVendorFile?: boolean
  /**
   * Mousse holds the sign-in of every instance (its own sign-in flow and saved session), whatever
   * executable runs: a sign-out revokes it, and only a sign-in in Mousse restores it.
   */
  readonly ownsSignIn?: boolean
  /**
   * Lenient decoder of an instance's stored `config`: unknown or malformed fields fall back. With
   * `instanceId`, fields that default per instance are resolved (the `pi` driver's engine).
   */
  decodeConfig(raw: Record<string, unknown> | undefined, instanceId?: string): InstanceConfig
  /**
   * The engine an instance of a driver with several runs on (`pi`): the one in effect for its
   * stored config, and whether the user may switch it (Providers → Advanced → Engine).
   */
  engine?(instanceId: string, stored: Record<string, unknown> | undefined): { effective: 'rpc' | 'legacy'; switchable: boolean }
  /**
   * The Move prompt of an instance a Mousse update retired (`pi`: `drivers/pi/retired.ts`), else
   * undefined. A retired instance keeps its record and sign-in, runs nothing, and moves on.
   */
  retired?(instanceId: string): RetiredPrompt | undefined
  /**
   * Capabilities for an instance at an installed version. `facts` (when the runtime reported them)
   * refine what a preset cannot know statically: fork, plan mode, models.
   */
  caps(config: InstanceConfig, installedVersion?: string, facts?: RuntimeFacts): HarnessCaps
  /**
   * The caps an agent definition's turn runs on, when the instance runs definitions on another
   * runtime than its chats (`DriverRuntime.definitionAdapter`): a Pi connection on the RPC engine
   * runs definitions on Mousse's loop until Pi RPC can hold them (PR 4 unit 4d-rpc). Absent: `caps`.
   */
  definitionCaps?(config: InstanceConfig): HarnessCaps
  /**
   * Arguments that make the executable print its version; `null` when it has no such flag (the
   * probe then skips the version check and the handshake decides whether it runs). Default
   * `['--version']`.
   */
  versionArgs?(config: InstanceConfig): string[] | null
  /**
   * The runtime's own names for a neutral built-in tool (PR 6 §2), for an exact allowlist: several
   * when the runtime splits it (`search` is Claude Code's `Glob` and `Grep`). Empty, or absent on
   * the driver, when the runtime has no such tool: a policy that names it is refused.
   */
  nativeToolNames?(neutral: NeutralTool, config: InstanceConfig): readonly string[]
  /**
   * The runtime holds every built-in call of a bot turn to the turn's bot authority
   * (`AdapterHost.bot`) before it runs, so a bot policy's approvals are answered by the host
   * (`approve: 'host'`) and never reach a person. Absent: such a policy is refused.
   */
  botAuthority?(config: InstanceConfig): boolean
  create(context: DriverContext): DriverRuntime
  /** The command that updates a binary installed by `owner`, when there is one. */
  updateCommand?(owner: InstallOwner): string | undefined
}

/** The private-home rule of an entry with `config` (see `HarnessDriver.privateHomeFor`). */
export function privateHomeRule(driver: Pick<HarnessDriver, 'privateHome' | 'privateHomeFor'>, config: InstanceConfig): PrivateHomeRule {
  return driver.privateHomeFor?.(config) ?? (driver.privateHome ? 'allowed' : 'forbidden')
}

/** Shared lenient decoder for the fields every driver understands. */
export function decodeInstanceConfig(raw: Record<string, unknown> | undefined, options: { privateHome: boolean }): InstanceConfig {
  const config: InstanceConfig = { home: 'default' }
  if (!raw) return config
  if (typeof raw.displayName === 'string' && raw.displayName.trim()) config.displayName = raw.displayName.trim().slice(0, 80)
  if (options.privateHome && raw.home === 'private') config.home = 'private'
  if (typeof raw.loginMethod === 'string' && raw.loginMethod) config.loginMethod = raw.loginMethod
  if (typeof raw.movedTo === 'string' && raw.movedTo) config.movedTo = raw.movedTo
  if (typeof raw.binaryPath === 'string' && raw.binaryPath.trim()) config.binaryPath = raw.binaryPath.trim()
  if (Array.isArray(raw.args)) config.args = raw.args.filter((arg): arg is string => typeof arg === 'string')
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env = Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    if (Object.keys(env).length) config.env = env
  }
  if (raw.signedOutInMousse === true) config.signedOutInMousse = true
  // Only an entry with a home of its own can be locked: the user's own setup is never.
  if (raw.profile === 'locked' && config.home === 'private') config.profile = 'locked'
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
  if (normalized.includes('/.local/bin/') || normalized.includes('/.local/share/') || normalized.includes('/.grok/bin/')) return 'standalone'
  return 'unknown'
}
