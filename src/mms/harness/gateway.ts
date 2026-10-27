import type { InstanceSnapshot, ModelRefreshResult, ProviderSnapshotsEvent } from '../../shared/harness/status'
import type {
  AddInstanceInput,
  BinaryFingerprint,
  BindPolicy,
  CustomModel,
  ExecutionBinding,
  HarnessCaps,
  HarnessDriverKind,
  HarnessError,
  InstanceConfigPatch,
  InstanceModel,
  ModelPrefsPatch,
  ProviderOperationEvent,
  ProviderOperationStarted,
  ProviderScope,
  ProviderSelection,
  RegistryAgentView,
  RemoveInstallResult,
  RunPolicy,
  RuntimeFacts,
  SignInResponse,
  TurnOrigin
} from '../../shared/harness/types'
import type { NeutralTool } from '../../shared/harness/tools'
import type { CliProviderConfigPatch, ConfiguredProvider, ProviderLoginResult } from '../../shared/providerAuth'
import type { ModelOverride } from '../../shared/providerInstances'
import type { LlmProviderOption } from '../../shared/settings'
import type { ChatMode } from '../../shared/types'
import { parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { LoginSession } from '../providers/LoginSession'
import type { ProviderInstanceService } from '../providers/ProviderInstanceService'
import type { AdapterHost, TurnBridge, TurnControl, TurnInput, TurnResult, TurnSink } from '../run/adapters/ProviderAdapter'
import { mcpAttachable, type ChildPreflightContext, type SubagentRefusal } from '../run/policy/featureGates'
import type { McpAttachmentProvider } from '../run/mcp/MousseMcpServer'
import type { TurnSettlement } from '../run/mcp/McpCredentials'
import type { ModeCeiling, ProviderRef } from '../run/types'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceConfigView, InstanceEngine, NextStep, UpdateAffordance } from '../../shared/harness/status'
import { foldedInto, movePromptOf, type MoveResult } from '../../shared/harness/move'
import { harnessAppError, type HarnessErrorCode, type ModelPrefs, type SignInPrompt } from '../../shared/harness/types'
import type { ProviderLoginEvent, ProviderUsage } from '../../shared/providerAuth'
import {
  legacyProviderForInstance,
  piProviderIdOf,
  PROVIDER_INSTANCE_ERROR_CODES,
  type ProviderInstanceConfig
} from '../../shared/providerInstances'
import type { UserQuestionService } from '../orchestrator/UserQuestionService'
import { LoginSession as LoginSessionImpl } from '../providers/LoginSession'
import { fail } from '../run/db/RunStoreError'
import { hidesModel, modelsWithPrefs, ModelPrefsService, visibleProviderOption, type ModelPrefsStore } from './catalog'
import { privateHomeRule, type AuthReading, type DriverRuntime, type HarnessDriver, type InstallProgress, type InstanceConfig, type LiveProcessHost } from './driver'
import { DEFAULT_HOME_ID, findOnPath, instanceEnv, reservedEnvName, type InstanceEnv } from './env'
import { addedInstanceId, defaultInstanceId, InstanceCounterStore, instanceStateDir, isBuiltInInstance } from './instances'
import { LatestVersionCache } from './latest'
import { RuntimeFactsStore } from './facts'
import { questionsPrompter, refusingPrompter } from './acp/permissions'
import { checkPermissionMode, checkPolicy, freezePolicy, hasSpendLimit, mapNeutralTools, permissionModeRefusal, policyDigest, purposeAllowed, toolControlLevel } from './policy'
import { budgetLimitsOf, RunCounterBook, type CounterScope, type SpendScope } from './budget'
import type { DefinitionAuthority } from '../agentDefinitions/definitionGate'
import {
  effectivePermissionMode,
  normalizePermissionMode,
  supportedPermissionModes,
  type EffectivePermissionMode,
  type PermissionLimits,
  type PermissionMode
} from '../../shared/permissionMode'
import { HarnessScopeStore } from './scope'
import { sharedShellPath, type ShellPathResult } from './shellPath'
import { compatibilityOf, fingerprintOf, PROBE_TIMEOUTS, probeInstance, sameBinary, updateAffordance, type ProbeResult } from './status'
import { interruptWithDeadline } from './supervise'
import {
  changedFields,
  fieldLabels,
  instanceTuple,
  MIRROR_MARKER_KEY,
  mirrorHash,
  reconcileRow,
  storedMarker,
  tupleConfig,
  unsetFields,
  type MirrorTuple
} from './vendorMirror'
import type { StoredCliConfig } from '../providers/cliConfig'

/** Instance id of a turn that ran on the unselected default: the bare pi loop. */
export const PI_DRIVER_ID = 'pi'

// The turn contract callers build (`TurnSpec`): app code imports these from the gateway, never
// from the adapters behind it.
export type {
  AdapterHost,
  ChildTurnPolicy,
  ProviderMetrics,
  RecoveredContext,
  TurnBridge,
  TurnControl,
  TurnInput,
  TurnResult,
  TurnSink
} from '../run/adapters/ProviderAdapter'

/**
 * The only way app code reaches agents and providers. Drivers (`./drivers/*`) sit behind it; the
 * gateway owns timeouts, capability fallbacks, scope and model prefs. Drivers never retry; runtimes
 * retry their own requests as Mousse configures them, and the gateway's own retry is the turn retry
 * when no side effect is possible. Failures are thrown
 * as `harnessAppError(...)` (`shared/harness/types.ts`) so callers and the protocol see typed codes.
 */
export interface HarnessGateway {
  readonly instances: HarnessInstances
  readonly catalog: HarnessCatalog
  /** The ACP agent registry ("More ACP agents"). */
  readonly registry: HarnessRegistry
  /**
   * The selection a caller may run, after scope (device ceiling, project narrowing) and model
   * prefs. Throws `instance_unknown`, `instance_disabled`, `model_hidden` or `model_unavailable`;
   * hidden models and disabled instances are rejected for every purpose.
   */
  resolve(selection: ProviderSelection, scope: ProviderScope, purpose: ResolvePurpose): ResolvedSelection
  /**
   * Called only by the RunEngine `turn.start` executor. Admission fails closed with
   * `policy_unenforceable` when the instance cannot enforce the binding's policy.
   */
  startTurn(spec: TurnSpec): TurnHandle
  /**
   * The run reached its final state (the `turn.start` executor marked it terminal): its count
   * record is dropped, and an attempt of it that still arrives is refused every step.
   */
  runSettled?(runId: string): void
  /**
   * One model request with no tools (a chat title), on an instance whose driver runs one-shots
   * (`HarnessDriver.oneShot`). Resolves the selection like a turn for `purpose` (scope, hidden models,
   * disabled instances); agent runtimes are refused with `unsupported`. Ends with `timeout` after
   * `ONE_SHOT_INACTIVITY_MS` without a provider event, and is never retried: the caller falls back.
   */
  oneShot(request: OneShotRequest): Promise<{ text: string }>

  // -- Run engine -------------------------------------------------------------------------------

  /** The profile's instance map: legacy `llmProvider` mapping and stored selections. */
  readonly instanceMap: ProviderInstanceService
  /**
   * `resolve` for a stored selection (`ModelOverride`, possibly naming only a legacy
   * `llmProvider`). Throws the instance errors (`provider_instance_unknown`/`_disabled`) the run
   * engine has always reported, `instance_disabled` for a project that turned the instance off,
   * and `model_hidden`. `allowDisabled` serves stopping or reading work already running;
   * `unselectedDefault` lets a turn without any configured model run on the pi loop, which
   * reports the missing default itself.
   */
  resolveStored(selection: Pick<ModelOverride, 'instanceId' | 'llmProvider' | 'model'>, options: ResolveStoredOptions): ResolvedTurnSelection
  /**
   * The immutable binding of one attempt, from a resolved selection and the current counters. A
   * runtime with native sessions has its account read first (bounded; concurrent reads share one),
   * so a sign-in changed in a terminal since the last turn moves the account generation on before
   * the binding records it. That reading serves the `startTurn` of this binding once; any other
   * dispatch (a stored binding: retry, recovery) reads the account again.
   *
   * `policy` is the caller's part of the binding's policy (tools, approvals, budget, authority);
   * `approvals` alone is its shorthand, and `policy.approvals` wins. The binding freezes the policy
   * and, when the caller gave one, records its digest (`ExecutionBinding.policyDigest`). Retries and
   * steers reuse the binding; a continuation binds anew.
   */
  bind(resolved: ResolvedTurnSelection, input: BindInput): Promise<ExecutionBinding>
  /**
   * The instance's own names for neutral built-in tools (PR 6 §2), for an exact allowlist; refused
   * with `policy_unenforceable` when the runtime has no tool for one of them.
   */
  nativeToolNames(instanceId: string, tools: readonly NeutralTool[]): { ok: true; names: string[] } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }
  /**
   * The permission mode `bind` would record for a thread asking for `requested` (the mode itself, a
   * stricter fallback with the reason, or a refusal). Reads, binds nothing; used to tell the agent
   * about a change before the turn is admitted.
   */
  previewPermissionMode(resolved: ResolvedTurnSelection, requested: PermissionMode, cwd?: string | null): EffectivePermissionMode
  /** The selection a binding runs: a retry or recovery of a run executes its binding, never the current selection. */
  selectionOf(binding: ExecutionBinding): Pick<ModelOverride, 'instanceId' | 'llmProvider' | 'model'>
  /**
   * Issue #142: the instance's look at the user's own setup before a delegated child runs on it
   * (`ProviderAdapter.childPreflight`); null when nothing stands in the way. Reads, never changes.
   */
  childPreflight(instanceId: string, context: ChildPreflightContext): Promise<SubagentRefusal | null>
  /** Stops a native session by its ref (an instance disabled since can still be stopped). */
  interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'>
  /** A native fork of `ref` after `atTurnOrdinal`, or null when the instance cannot branch it. */
  forkSession(ref: ProviderRef, atTurnOrdinal: number, target?: { threadId: string }): Promise<ProviderRef | null>
  /**
   * Ends what a thread's process still runs in the background (`ProviderAdapter.stopThread`), on
   * whichever instance holds it: the thread may have switched instances since. 'stopped' when one did.
   */
  stopThread(threadId: string): Promise<'stopped' | 'not_active'>
  /** Where runtimes with live processes per thread report (every instance's, now and later). */
  setLiveHost(host: LiveProcessHost | null): void
  /** The profile's Mousse MCP server, which turn bridges attach (null: none). */
  setMcpAttachment(provider: McpAttachmentProvider | null): void
  /** The turn a thread's live process started itself and is running now, from whichever instance holds it. */
  inFlightContinuation(threadId: string): { id: string; discarded: boolean } | undefined
  /** A thread's live process still holds that turn of its own. */
  hasContinuation(threadId: string, id?: string): boolean
  /** Drops the turns of its own a thread's live process holds (only `id`, when given). */
  discardContinuations(threadId: string, id?: string): void
  /** `llmProvider` names of enabled vendor instances that are signed in (default-model fallback). */
  configuredProviderIds(): string[]
  /** Old provider methods (`providers.listConfigured`, `loginOAuth`, ...) forward here. */
  readonly legacy: LegacyProviders
  /** Stops the instances' runtimes and running operations. */
  stop(): void
}

/** `HarnessGateway.bind`: the turn's mode, effort and origin, and the caller's part of its policy. */
export interface BindInput {
  mode: ChatMode
  effort?: string
  origin?: TurnOrigin
  /** Shorthand for `policy.approvals`. */
  approvals?: RunPolicy['approvals']
  /**
   * The permission mode the thread asks for (its own, narrowed by its lineage's ceiling). The
   * binding records the mode the instance can enforce: this one, the nearest stricter one, or the
   * bind is refused with `permission_mode_unenforceable`. Absent reads as the profile default.
   */
  permissionMode?: PermissionMode
  /** The turn's working directory, where project settings that limit the modes are read from. */
  cwd?: string | null
  policy?: BindPolicy
}

export interface ResolveStoredOptions {
  purpose: ResolvePurpose
  scope?: ProviderScope
  allowDisabled?: boolean
  unselectedDefault?: boolean
}

export interface ResolvedTurnSelection {
  instanceId: string
  /** The legacy provider name turns on the instance report (`TurnInput.llmProvider`). */
  llmProvider: string
  driver: HarnessDriverKind
  model: string
  caps: HarnessCaps
  /** The selection named an entry that moved to this instance (`config.movedTo`). */
  movedFrom?: string
}

/** The old provider RPCs, served through the instances that replace the vendor branches. */
export interface LegacyProviders {
  configuredProviders(): ConfiguredProvider[]
  /** Picker listings: one per enabled instance, hidden models removed, custom models added. */
  llmProviders(): LlmProviderOption[]
  /** False when `providerId` is not a vendor instance (the caller then asks the pi credentials). */
  refreshModels(providerId: string, cwd: string): Promise<boolean>
  logout(providerId: string): Promise<boolean>
  /** Undefined when `providerId` is not a vendor instance. */
  login(providerId: string, session: LoginSession, cwd: string): Promise<ProviderLoginResult> | undefined
  /**
   * A pi provider's credentials changed through the old methods (API key, OAuth, logout): its
   * instance is checked again now and its snapshot published, whatever the probe cache held.
   */
  credentialsChanged(providerId: string): Promise<void>
}

/**
 * Who is resolving. The same rules apply to all, except that an instance whose runtime approves
 * tools itself (`toolControl: 'uncontrolled'`) resolves only for the interactive purposes
 * (`INTERACTIVE_PURPOSES` in `policy.ts`); any other purpose, including one added later, is refused.
 */
export type ResolvePurpose =
  | 'composer'
  | 'default'
  | 'turn'
  | 'delegate_task'
  | 'definition'
  | 'workflow'
  | 'channel_model'
  | 'cli_model'
  | 'title'
  | 'schedule'

/** `HarnessGateway.oneShot`. */
export interface OneShotRequest {
  /** A stored selection (the title setting); a `:effort` suffix on the model is kept. */
  selection: Pick<ModelOverride, 'instanceId' | 'llmProvider' | 'model'>
  scope?: ProviderScope
  purpose: 'title'
  system: string
  prompt: string
  /** The text is cut to this length. */
  maxChars: number
  /** Prompt-cache affinity (a thread id), hashed before it reaches the provider. */
  sessionKey?: string
  signal?: AbortSignal
}

export interface ResolvedSelection {
  selection: ProviderSelection
  driver: HarnessDriverKind
  caps: HarnessCaps
}

/**
 * Instance management behind `providers.snapshots` and `providers.instances.*`. Mutations return
 * the instance's snapshot in the scope they apply to (device unless stated) and also announce the
 * change through `subscribe`. Long operations return an operation id at once.
 */
export interface HarnessInstances {
  snapshots(scope: ProviderScope): Promise<InstanceSnapshot[]>
  /**
   * The plan usage of every enabled, signed-in instance whose runtime reports any (`DriverRuntime.usage`),
   * for the usage page: keyed by the instance and named like it. An instance that cannot be read
   * says so in its own entry; one failing never fails the others.
   */
  usage(scope: ProviderScope): Promise<ProviderUsage[]>
  add(input: AddInstanceInput): Promise<InstanceSnapshot>
  /** Deletes any instance, built-in ones too; a vendor agent is not seeded again. */
  remove(instanceId: string): Promise<void>
  configure(instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot>
  /** `null` clears a project override; the device scope takes a boolean only. */
  setEnabled(instanceId: string, scope: ProviderScope, enabled: boolean | null): Promise<InstanceSnapshot>
  install(instanceId: string): Promise<ProviderOperationStarted>
  /**
   * Deletes the files Mousse downloaded for the instance. Other entries using them (in this or
   * another profile) block it with the list of who uses them, unless `force`.
   */
  removeInstall(instanceId: string, options: { force: boolean }): Promise<RemoveInstallResult>
  /** Cancels a running install or update; false when it is not running. */
  cancelInstall(operationId: string): Promise<boolean>
  update(instanceId: string): Promise<ProviderOperationStarted>
  /** `method` picks one of the driver's sign-in methods; absent = its default. */
  signIn(instanceId: string, method?: string): Promise<ProviderOperationStarted>
  /** False when the operation or prompt is no longer waiting. */
  respondSignIn(operationId: string, response: SignInResponse): Promise<boolean>
  signOut(instanceId: string): Promise<InstanceSnapshot>
  /** Bypasses the probe cache. */
  recheck(instanceId: string): Promise<InstanceSnapshot>
  refreshModels(instanceId: string): Promise<InstanceSnapshot>
  /**
   * Refreshes the model list of every enabled instance (Settings → Providers → "Refresh models"),
   * at most two at a time. An instance that is not signed in or has a chat running is skipped; one
   * whose refresh fails is reported, never thrown. Results come in the order of the instances.
   */
  refreshAllModels(): Promise<ModelRefreshResult[]>
  setModelPrefs(instanceId: string, patch: ModelPrefsPatch): Promise<InstanceSnapshot>
  /**
   * Moves a model API entry to the agent that now serves it (`FOLDED_INTO_AGENT`): the old entry is
   * turned off (never deleted) and records `movedTo`, the defaults that named it are rewritten and
   * listed, and threads pinned to it continue on the agent with their history handed over.
   * `copyKey` saves the old entry's API key as the agent's own first (only when the user ticks it).
   */
  move(fromInstanceId: string, toInstanceId: string, options?: { copyKey?: boolean }): Promise<MoveResult>
  /** Snapshot changes (`snapshots$`) and operation progress; returns the unsubscribe. */
  subscribe(listener: (event: HarnessGatewayEvent) => void): () => void
}

export interface HarnessRegistry {
  /** Agents of the ACP registry that fit this computer, best match first. */
  search(query: string): Promise<RegistryAgentView[]>
}

export type HarnessGatewayEvent =
  | { type: 'snapshots'; data: ProviderSnapshotsEvent }
  | { type: 'operation'; data: ProviderOperationEvent }

export interface HarnessCatalog {
  /** Models of an instance with prefs applied, in display order (hidden ones included and flagged). */
  models(instanceId: string, scope: ProviderScope): InstanceModel[]
  /** A custom model the user added to the instance and has not hidden; runtimes run it by this definition. */
  customModel(instanceId: string, modelId: string): CustomModel | undefined
  /**
   * Images in a Mousse tool's result reach the model a runtime with its own loop runs (the browser's
   * vision): a custom model's stated capability, else the driver's `mcpImageResults`, else an ACP
   * agent's own word in `initialize` (`promptCapabilities.image`). Unknown is no.
   */
  toolImages(instanceId: string, modelId: string): boolean
}

/**
 * One turn. PR 1 drivers wrap today's adapters, so a turn carries the adapter turn contract with
 * the attempt's immutable binding; `HarnessEvent` streaming replaces the sink when drivers stop
 * wrapping adapters.
 */
export interface TurnSpec {
  binding: ExecutionBinding
  /**
   * The binding of the thread's previous run on the same instance. Its native session is resumed
   * only when that binding has the same home, account (generation and identity) and config
   * revision; otherwise the turn hands the history over instead.
   */
  previous?: ExecutionBinding
  input: TurnInput
  sink: TurnSink
  control: TurnControl
  /** The adapter host; the gateway adds the turn's `bridge` from `app`. */
  host: AdapterHost
  /** The turn's app-tool context, from which the gateway mints its `TurnBridge`. */
  app?: TurnAppContext
  /**
   * Instructions of the turn's own (an agent definition's system prompt): they replace the
   * runtime's default instructions or are appended to them. Not policy.
   */
  instructions?: { text: string; placement: 'replace' | 'append' }
  /** `ephemeral`: the turn runs in a session of its own that is not kept for the thread. Default `thread`. */
  session?: 'thread' | 'ephemeral'
  /**
   * The attempt's ordinal in its run (1 for the first; a retry, recovery or steer restart is later).
   * Absent: a first attempt. A later attempt of a run with a count limit and no count record in
   * this process fails closed.
   */
  attemptOrdinal?: number
  /**
   * Where the run's request and tool-call counts are kept, for a caller that shares one allowance
   * across runs (PR 6's activations). Default: the run's own counters, shared by its attempts. The
   * limits are always the binding's policy.
   */
  counters?: CounterScope
  /**
   * Where the run's token and USD spend is reserved and settled, for a caller that shares one
   * allowance across runs (PR 6). Default: the run's own ledger, shared by its attempts. The limits
   * are always the binding's policy.
   */
  spend?: SpendScope
}

/** What the `turn.start` executor knows of a turn's app tools, for its bridge (PR 2 §2). */
export interface TurnAppContext {
  /** The token of the turn's registered app-tool context (`AppToolTurns`). */
  turnToken: string
  /** The credential ceiling of the run. */
  modeCeiling: ModeCeiling
  /** The turn may attach the Mousse MCP server (a run engine run). */
  mcpEligible: boolean
  /** The session text and turn preamble, given whether the server was attached. */
  instructions(mcpAttached: boolean): { sessionInstructions: string; turnPreamble: string }
  /**
   * The definition authority of the turn's registered app tools (`AppToolTurn.definition`): its one
   * source. The gateway hands the same object to the runtime (`AdapterHost.definition`), so Pi's
   * built-ins and the app and MCP tools are held to one authority.
   */
  definition?: DefinitionAuthority
}

export interface TurnHandle {
  readonly result: Promise<TurnResult>
  /** Never "unsupported": delivered live, by restart, or queued; `not_active` once the turn ended. */
  steer(text: string): Promise<{ delivery: 'live' | 'restarted' | 'queued' } | 'not_active'>
  interrupt(): Promise<'interrupted' | 'not_active'>
  /** The provider session reference once known (`TurnSink.providerRef`). */
  providerRef(): ProviderRef | undefined
}

// -------------------------------------------------------------------------------------------------
// Implementation

/** Probes refresh at most this often, and only when a client asks (page open, recheck, turn). */
export const PROBE_TTL_MS = 10 * 60_000
/** How long a probe waits for the login-shell PATH before searching the inherited PATH only. */
const SHELL_PATH_WAIT_MS = 3_000
/** Every enabled, signed-in instance's model list is refreshed this often (`startModelRefreshSchedule`). */
export const MODEL_REFRESH_INTERVAL_MS = 3 * 60 * 60_000
/** The first scheduled pass runs this long after start-up, once the app is up and quiet. */
export const MODEL_REFRESH_STARTUP_DELAY_MS = 2 * 60_000
/** Model refreshes running at once (Claude Code and Codex start a CLI each). */
const MODEL_REFRESH_CONCURRENCY = 2
/** Test-only: replaces `MODEL_REFRESH_INTERVAL_MS`, in milliseconds. */
const MODEL_REFRESH_INTERVAL_ENV = 'MOUSSE_MODEL_REFRESH_INTERVAL_MS'
/** A one-shot request ends with `timeout` after this long without a provider event. */
export const ONE_SHOT_INACTIVITY_MS = 60_000
/** A usage read gives up after this long (the usage page shows the instance as unreadable). */
export const USAGE_READ_MS = 15_000
/** How long turn admission waits for the account check; past it the account counts as unknown. */
export const TURN_ACCOUNT_CHECK_MS = 10_000

export interface HarnessGatewayOptions {
  profileHome: string
  installationHome: string
  instanceMap: ProviderInstanceService
  drivers: readonly HarnessDriver[]
  questions: UserQuestionService
  /** Model prefs persistence; in memory when absent. */
  prefs?: ModelPrefsStore
  /** The folder sign-in and model listing run in (the profile's repo root). */
  cwd?: () => string
  /** Display names of pi providers (`ProviderAuthService.getProviderDisplayName`). */
  piDisplayName?: (providerId: string) => string
  shellPath?: () => Promise<ShellPathResult>
  probeTimeouts?: Partial<typeof PROBE_TIMEOUTS>
  /** Old clients refresh their provider lists on this (the `providers:changed` event). */
  onProvidersChanged?: () => void
  now?: () => number
  /** Newest published CLI versions; looked up in the npm registry at most daily by default. */
  latest?: LatestVersionCache
  /** Test seam: the turn-admission account check deadline (`TURN_ACCOUNT_CHECK_MS`). */
  accountCheckMs?: number
  /**
   * The profile's own default selections (Settings), rewritten when an entry moves; returns what
   * changed, for the Move dialog. Project defaults are the gateway's own.
   */
  defaults?: { rewrite(from: string, to: { instanceId: string; llmProvider: string; model(model: string): string }): string[] }
  /**
   * Whether another profile of this device still has an unmoved entry `instanceId` (or cannot be
   * read), so a sign-in the profiles share is kept when this profile moves. Absent: none does.
   */
  otherProfilesUse?: (instanceId: string) => boolean
  /** Test seam: the agent a model API moves to (`FOLDED_INTO_AGENT`). */
  foldedInto?: (providerId: string | undefined) => HarnessDriverKind | undefined
  /** The ACP agent registry; without it the search finds nothing. */
  registry?: HarnessRegistry
}

interface InstanceRecord {
  instanceId: string
  entry: ProviderInstanceConfig
  driver: HarnessDriver
  config: InstanceConfig
  builtIn: boolean
  /** Driver, revision, home and engine: a change builds a new runtime. */
  key: string
  env: InstanceEnv
  runtime: DriverRuntime
  /** Turns running on this runtime; a replaced runtime stops once they end. */
  active: number
  retired?: boolean
  /** The turns running or being admitted on this runtime, one per attempt, so a removal or disable can stop them. */
  turns: Map<string, TurnEntry>
  /** Set when the instance was removed or turned off on the device: no turn is admitted or dispatched until lifted. */
  stopped?: { reason: StopReason }
}

type StopReason = 'removed' | 'disabled'

/** One attempt on a runtime. */
interface TurnEntry {
  threadId: string
  /** The provider session, once the adapter published it. */
  ref?: ProviderRef
  /** Aborted (with the typed instance error) when the instance is removed or turned off. */
  cancel: AbortController
  /** Why this attempt was stopped, when it was. */
  stoppedFor?: StopReason
  /** The attempt's thread was told it was stopped. */
  noticed?: boolean
  /** The attempt ended with a complete result in spite of the stop: nothing is left to tell its thread. */
  completed?: boolean
  /** A native interrupt for the session already went out. */
  interrupted?: boolean
  /** Settles when the attempt's result has settled. */
  done: Promise<void>
  finish(): void
}

interface ProbeState {
  result?: ProbeResult
  lastGood?: ProbeResult
  checkedAtMs?: number
  probing?: Promise<void>
  /** What this run's refreshes found; the age of a list kept on disk comes from the runtime (`modelsRefreshedAt`). */
  models?: { refreshedAt?: string; error?: string; live?: boolean }
  /** The account read running for a turn admission (resolves undefined = unknown). */
  accountCheck?: Promise<string | undefined>
  /** The signed-in account without its home (`accountFingerprint`), to tell two instances on one account. In memory only. */
  fingerprint?: string
  /** The last start-up check: what it found, for which executable and config revision. */
  handshake?: { runs: ProbeResult['runs']; fingerprint?: BinaryFingerprint; revision: number }
}

/** A removed instance's state directory, deleted once nothing uses it any more. */
interface Removal {
  dir: string
  /** Checks of the instance still running when it was removed. */
  pending: number
}

interface Operation {
  started: ProviderOperationStarted
  session?: LoginSession
  /** The prompt or choice the sign-in waits on. */
  prompt?: { promptId: string; kind: 'prompt' | 'select' }
  /**
   * The pasted-code fallback the sign-in waits on alongside (a redirect URL or code). It may be
   * answered from its own prompt or from any browser-link prompt of the operation, which is where
   * the page offers "paste the redirect URL", whichever came first.
   */
  manualCode?: string
  urlPrompts: string[]
  prompts: number
  progress?: InstallProgress
  cancel(): boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The policy mode a chat mode runs under: plan, else the instance's normal permissions. */
function policyMode(mode: ChatMode): RunPolicy['mode'] {
  return mode === 'plan' ? 'plan' : 'default'
}

/**
 * Deletes a removed instance's state directory except its private home: sign-in files are never
 * deleted by Mousse, only by signing out. Only a home that is missing or listed as empty goes with
 * the rest; a home that cannot be inspected is kept like any other (fail closed). Throws the first
 * failure after trying every other entry, so the caller reports what was left behind.
 */
function removeStateDir(dir: string): void {
  const home = join(dir, 'home')
  let keepHome = false
  let failure: unknown
  try {
    keepHome = readdirSync(home).length > 0
  } catch (error) {
    // Only "no such directory" proves there is no home; any other error leaves the home alone.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      keepHome = true
      failure = error
    }
  }
  if (!keepHome) {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  for (const name of readdirSync(dir)) {
    if (name === 'home') continue
    try {
      rmSync(join(dir, name), { recursive: true, force: true })
    } catch (error) {
      failure ??= error
    }
  }
  if (failure) throw failure
}

function harnessFail(code: HarnessErrorCode, message: string, instanceId?: string): never {
  throw harnessAppError({ code, message, ...(instanceId ? { instanceId } : {}) })
}

/** The provider-instance error codes the run engine reports, as harness codes for `resolve()`. */
function asHarnessError(error: unknown, instanceId: string): unknown {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === PROVIDER_INSTANCE_ERROR_CODES.unknown) return harnessAppError({ code: 'instance_unknown', message: errorText(error), instanceId })
  if (code === PROVIDER_INSTANCE_ERROR_CODES.disabled) return harnessAppError({ code: 'instance_disabled', message: errorText(error), instanceId })
  return error
}

/** In-memory prefs (tests, single-process tools). */
function memoryPrefs(): ModelPrefsStore {
  let value: Record<string, ModelPrefs> = {}
  return { read: () => value, write: (next) => { value = next } }
}

export class Harness implements HarnessGateway {
  readonly instances: HarnessInstances
  readonly catalog: HarnessCatalog
  readonly registry: HarnessRegistry
  readonly legacy: LegacyProviders
  readonly instanceMap: ProviderInstanceService
  private readonly drivers = new Map<HarnessDriverKind, HarnessDriver>()
  private readonly records = new Map<string, InstanceRecord>()
  private liveHost: LiveProcessHost | null = null
  private mcp: McpAttachmentProvider | null = null
  private readonly retired = new Set<InstanceRecord>()
  /**
   * The stops of a removal or disable still running, per instance (each settles, never rejects). They
   * belong to the instance, not to a runtime, so a reconfiguration or a runtime that finished its
   * turns cannot drop them: a turn admitted later waits for every one.
   */
  private readonly stopBarriers = new Map<string, Set<Promise<void>>>()
  private readonly removals = new Map<string, Removal>()
  /** The account reading `bind` took, for the `startTurn` of that binding (once). */
  private readonly boundAccounts = new WeakMap<ExecutionBinding, { accountId?: string }>()
  private readonly probes = new Map<string, ProbeState>()
  /** Entries being moved now (`move`): one move at a time per entry. */
  private readonly moving = new Set<string>()
  private readonly facts: RuntimeFactsStore
  /** Executable stats taken when no probe recorded one, reused for the probe TTL. */
  private readonly stats = new Map<string, { fingerprint?: BinaryFingerprint; atMs: number }>()
  /** Threads already told that an instance approves tools itself (`thread|instance`). */
  private readonly toolNotices = new Set<string>()
  /** Each run's own request and tool-call counts (`budgets: 'hard'`), shared by its attempts. */
  private readonly runCounters = new RunCounterBook()
  /** Bindings made for a selection that named a moved entry: their thread is told once. */
  private readonly boundMoves = new WeakMap<ExecutionBinding, string>()
  private readonly operations = new Map<string, Operation>()
  /** What this start's reconcile found about a vendor file an older Mousse changed, per instance. */
  private readonly settingsNotices = new Map<string, NonNullable<InstanceSnapshot['settingsNotice']>>()
  private readonly listeners = new Set<(event: HarnessGatewayEvent) => void>()
  private readonly scopes: HarnessScopeStore
  private readonly counters: InstanceCounterStore
  private readonly latest: LatestVersionCache
  private readonly prefs: ModelPrefsService
  private searchPath: string[] = []
  private readonly shellPath: Promise<void>
  private stopped = false
  /**
   * Model refreshes queued or running, one per instance: a second ask for the same instance (the
   * schedule, a probe that saw a new program, a click) joins it instead of starting another.
   */
  private readonly modelRefreshes = new Map<string, Promise<void>>()
  private modelSlots = 0
  private readonly modelWaiting: Array<() => void> = []
  private modelSchedule?: { interval: ReturnType<typeof setInterval>; startup: ReturnType<typeof setTimeout>; intervalMs: number }

  constructor(private readonly options: HarnessGatewayOptions) {
    this.instanceMap = options.instanceMap
    for (const driver of options.drivers) {
      if (this.drivers.has(driver.kind)) throw new Error(`A driver for ${driver.kind} is already registered.`)
      this.drivers.set(driver.kind, driver)
    }
    this.scopes = new HarnessScopeStore(options.profileHome)
    this.counters = new InstanceCounterStore(options.profileHome)
    this.facts = new RuntimeFactsStore(options.profileHome)
    this.latest = options.latest ?? new LatestVersionCache(options.profileHome, options.now ? { now: options.now } : {})
    this.prefs = new ModelPrefsService(options.prefs ?? memoryPrefs())
    // Captured once at boot; probes that ran before it arrived and found nothing run again.
    this.shellPath = (options.shellPath ?? sharedShellPath)()
      .then((result) => {
        if (!result.entries.length) return
        this.searchPath = result.entries
        for (const state of this.probes.values())
          if (state.result?.install === 'not_installed') state.checkedAtMs = undefined
      })
      .catch(() => {})
    this.instanceMap.setListings(
      (instanceId) => {
        const record = this.recordOrUndefined(instanceId)
        // An instance signed out in Mousse lists nothing, whatever its runtime says.
        if (!record || this.isSignedOut(record)) return undefined
        // An added instance is named after itself, so two Claude instances read apart.
        const named = <T extends { label: string }>(value: T | undefined): T | undefined =>
          value && !record.builtIn ? { ...value, label: this.displayName(record) } : value
        return {
          configuredProvider: () => named(record.runtime.configuredProvider?.()),
          llmProvider: () => named(record.runtime.llmProvider?.())
        }
      },
      (option) => ({ ...visibleProviderOption(option, this.prefs.get(option.instanceId)), instanceId: option.instanceId })
    )
    this.instances = {
      snapshots: (scope) => this.snapshots(scope),
      usage: (scope) => this.usage(scope),
      add: (input) => this.add(input),
      remove: (instanceId) => this.remove(instanceId),
      configure: (instanceId, patch) => this.configure(instanceId, patch),
      setEnabled: (instanceId, scope, enabled) => this.setEnabled(instanceId, scope, enabled),
      install: (instanceId) => this.install(instanceId, 'install'),
      removeInstall: (instanceId, options) => this.removeInstall(instanceId, options),
      cancelInstall: async (operationId) => this.operations.get(operationId)?.cancel() ?? false,
      update: (instanceId) => this.update(instanceId),
      signIn: (instanceId, method) => this.signIn(instanceId, method),
      respondSignIn: async (operationId, response) => this.respondSignIn(operationId, response),
      signOut: (instanceId) => this.signOut(instanceId),
      recheck: async (instanceId) => {
        this.refreshLatest([instanceId])
        await this.probe(instanceId, true, { handshake: true })
        return this.snapshot(instanceId, { kind: 'device' })
      },
      refreshModels: (instanceId) => this.refreshModels(instanceId),
      refreshAllModels: () => this.refreshAllModels(),
      move: (fromInstanceId, toInstanceId, options) => this.move(fromInstanceId, toInstanceId, options),
      setModelPrefs: async (instanceId, patch) => {
        const record = this.record(instanceId, { allowDisabled: true })
        // A runtime that cannot run a model by id does not offer adding one.
        if (patch.custom?.length && !record.driver.customModels)
          harnessFail('unsupported', `${record.driver.label} runs only the models it lists; custom models cannot be added.`, instanceId)
        this.prefs.set(instanceId, patch)
        this.changed(instanceId)
        return this.snapshot(instanceId, { kind: 'device' })
      },
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }
    }
    this.registry = { search: (query) => options.registry?.search(query) ?? Promise.resolve([]) }
    this.catalog = {
      models: (instanceId) => modelsWithPrefs(this.record(instanceId, { allowDisabled: true }).runtime.models(), this.prefs.get(instanceId)),
      customModel: (instanceId, modelId) => {
        const prefs = this.prefs.get(instanceId)
        return hidesModel(prefs, modelId) ? undefined : prefs.custom.find((model) => model.id === modelId)
      },
      toolImages: (instanceId, modelId) => {
        const record = this.recordOrUndefined(instanceId)
        if (!record) return false
        const baseId = parseThinkingSuffixFromModelId(modelId).baseId
        const custom = this.prefs.get(instanceId).custom.find((model) => model.id === modelId || model.id === baseId)
        if (custom) return custom.capabilities.images
        if (record.driver.mcpImageResults === true) return true
        const prompt = this.currentFacts(instanceId)?.agentCapabilities?.promptCapabilities
        return typeof prompt === 'object' && prompt !== null && (prompt as { image?: unknown }).image === true
      }
    }
    this.legacy = {
      configuredProviders: () => this.instanceMap.configuredProviders(),
      llmProviders: () => this.instanceMap.llmProviders(),
      refreshModels: async (providerId, cwd) => {
        const record = this.legacyRecord(providerId)
        if (!record) return false
        await record.runtime.refreshModels?.(cwd)
        this.changed(record.instanceId)
        return true
      },
      logout: async (providerId) => {
        const record = this.legacyRecord(providerId)
        if (!record) return false
        await this.signOut(record.instanceId)
        return true
      },
      login: (providerId, session, cwd) => {
        const record = this.legacyRecord(providerId)
        if (!record?.runtime.signIn) return undefined
        // Reconnecting an instance signed out in Mousse: on the user's own sign-in, only the flag clears.
        if (this.isSignedOut(record) && !this.ownsSignIn(record))
          return this.reconnect(record)
            .then((): ProviderLoginResult => ({ success: true, sessionId: session.sessionId }))
            .catch((error): ProviderLoginResult => ({ success: false, sessionId: session.sessionId, error: errorText(error) }))
            .finally(() => void this.probe(record.instanceId, true))
        return record.runtime.signIn(session, cwd)
          .then(async (result) => {
            // Through the record serving the instance now (the sign-in may have changed its config).
            const current = this.recordOrUndefined(record.instanceId) ?? record
            if (result.success && this.isSignedOut(current)) await this.reconnect(current)
            return result
          })
          .finally(() => void this.probe(record.instanceId, true))
      },
      credentialsChanged: async (providerId) => {
        let instanceId: string
        try {
          instanceId = this.instanceMap.instanceIdForLegacyProvider(providerId)
        } catch {
          return
        }
        if (this.instanceMap.get(instanceId)?.driver !== 'pi') return
        // Processes started with the old credential stop holding it (Pi's agent: its auth.json too).
        const record = this.records.get(instanceId)
        await record?.runtime.credentialsChanged?.().catch((error) => console.warn('[harness] could not retire old credentials', { instanceId, error: errorText(error) }))
        // A key saved for an instance signed out in Mousse signs it in again; a call that saved
        // nothing (a removed key, a failed check) leaves it signed out.
        const flagged = this.recordOrUndefined(instanceId)
        if (flagged && this.isSignedOut(flagged) && flagged.runtime.configured()) await this.reconnect(flagged).catch((error) => console.warn('[harness] could not clear a sign-out', { instanceId, error: errorText(error) }))
        // A check already running read the old credentials: wait for it, then check again.
        await this.probes.get(instanceId)?.probing
        await this.probe(instanceId, true)
      }
    }
    // Before the first probe: launch settings and sign-outs an older Mousse left in vendor files.
    this.reconcileVendorMirrors()
  }

  // -- Resolution -------------------------------------------------------------------------------

  resolve(selection: ProviderSelection, scope: ProviderScope, purpose: ResolvePurpose): ResolvedSelection {
    let resolved: ResolvedTurnSelection
    try {
      resolved = this.resolveStored({ instanceId: selection.instanceId, llmProvider: '', model: selection.model }, { purpose, scope })
    } catch (error) {
      throw asHarnessError(error, selection.instanceId)
    }
    return { selection: { ...selection, instanceId: resolved.instanceId }, driver: resolved.driver, caps: resolved.caps }
  }

  resolveStored(selection: Pick<ModelOverride, 'instanceId' | 'llmProvider' | 'model'>, options: ResolveStoredOptions): ResolvedTurnSelection {
    const blank = !selection.instanceId?.trim() && !selection.llmProvider?.trim()
    if (options.unselectedDefault && (blank || selection.instanceId === PI_DRIVER_ID)) {
      const driver = this.drivers.get('pi')
      if (!driver) fail('bad_request', 'No model is selected and no pi loop adapter is registered.')
      return { instanceId: PI_DRIVER_ID, llmProvider: '', driver: 'pi', model: selection.model, caps: driver.caps({ home: 'default' }) }
    }
    const named = this.instanceMap.instanceIdOf(selection)
    const target = this.movedTarget(named)
    const resolved = this.instanceMap.resolve(target ?? named, { allowDisabled: options.allowDisabled })
    const driver = this.drivers.get(resolved.entry.driver)
    if (!driver) fail('bad_request', `No provider adapter for driver ${resolved.entry.driver} (instance ${resolved.instanceId}).`)
    // Chat titles are a one-shot completion of an API provider's model; agent runtimes run turns only.
    if (options.purpose === 'title' && !driver.oneShot)
      harnessFail('unsupported', `${driver.label} cannot name chats. Choose an API provider's model for chat titles, or Automatic.`, resolved.instanceId)
    if (!options.allowDisabled) {
      if (options.scope?.kind === 'project' && !this.scopes.enabled(resolved.instanceId, true, options.scope).effective)
        harnessFail('instance_disabled', `Provider instance "${resolved.instanceId}" is turned off for this project. Turn it on or choose another model.`, resolved.instanceId)
      if (selection.model && hidesModel(this.prefs.get(resolved.instanceId), selection.model))
        harnessFail('model_hidden', `${this.modelName(resolved.instanceId, selection.model)} is hidden. Show it in Settings → Providers or choose another model.`, resolved.instanceId)
    }
    const config = driver.decodeConfig(resolved.entry.config, resolved.instanceId)
    const version = this.probes.get(resolved.instanceId)?.lastGood?.binary?.version
    const caps = driver.caps(config, version, this.currentFacts(resolved.instanceId))
    // An instance that approves tools itself runs only turns a person drives; reading or stopping
    // work already running (`allowDisabled`) is never refused.
    if (!options.allowDisabled && !purposeAllowed(caps, options.purpose))
      throw harnessAppError({
        code: 'policy_unenforceable',
        message: `${this.labelOf(resolved.instanceId, driver)} approves tools itself, so it runs only chats you drive. Choose another provider for this.`,
        missing: ['toolControl'],
        instanceId: resolved.instanceId
      })
    // A moved entry's model runs on the agent when it lists it; otherwise the agent's first model.
    let model = selection.model
    if (target) {
      const listed = this.recordOrUndefined(target)?.runtime.models() ?? []
      if (listed.length && !listed.some((entry) => entry.id === model)) model = listed[0]!.id
    }
    return { instanceId: resolved.instanceId, llmProvider: resolved.llmProvider, driver: driver.kind, model, caps, ...(target ? { movedFrom: named } : {}) }
  }

  /** The entry an instance moved to (one hop), when that entry still exists. */
  private movedTarget(instanceId: string): string | undefined {
    const entries = this.instanceMap.list()
    const movedTo = entries[instanceId]?.config?.movedTo
    return typeof movedTo === 'string' && movedTo !== instanceId && Object.prototype.hasOwnProperty.call(entries, movedTo) ? movedTo : undefined
  }

  /** The instance's name for messages, without building its runtime when it is not built yet. */
  private labelOf(instanceId: string, driver: HarnessDriver): string {
    const record = this.records.get(instanceId)
    return record ? this.displayName(record) : driver.label
  }

  /**
   * The instance's runtime facts while they still apply: recorded at its current config revision
   * and account generation, for the executable that is there now. Facts for another executable (a
   * self-update in place) are dropped, caps fall back to the driver's static preset, and a
   * start-up check is queued to record fresh ones. Bindings keep the caps they were made with.
   */
  private currentFacts(instanceId: string): RuntimeFacts | undefined {
    const facts = this.facts.get(instanceId)
    if (!facts) return undefined
    const counters = this.counters.get(instanceId)
    if (facts.configRevision !== counters.configRevision || facts.accountGeneration !== counters.accountGeneration) {
      this.facts.drop(instanceId)
      return undefined
    }
    const current = this.binaryFingerprint(instanceId, facts.binary.path)
    if (!sameBinary(current, facts.binary)) {
      this.facts.drop(instanceId)
      if (!this.stopped) queueMicrotask(() => void this.probe(instanceId, true, { handshake: true }))
      return undefined
    }
    return facts
  }

  /**
   * The executable's fingerprint: the last probe's, else a stat of `path` reused for the probe TTL
   * (never a stat on every resolve).
   */
  private binaryFingerprint(instanceId: string, path?: string): BinaryFingerprint | undefined {
    const probed = this.probes.get(instanceId)?.lastGood?.fingerprint
    if (probed) return probed
    if (!path) return undefined
    const cached = this.stats.get(path)
    if (cached && this.now() - cached.atMs < PROBE_TTL_MS) return cached.fingerprint
    const fingerprint = fingerprintOf(path)
    this.stats.set(path, { ...(fingerprint ? { fingerprint } : {}), atMs: this.now() })
    return fingerprint
  }

  /** Stores what the runtime reported about itself for the instance's current revision and account. */
  private captureFacts(record: InstanceRecord): void {
    let report
    try {
      report = record.runtime.runtimeFacts?.()
    } catch (error) {
      console.warn('[harness] could not read runtime facts', { instanceId: record.instanceId, error: errorText(error) })
      return
    }
    if (!report) return
    // Facts about another executable than the one there now (a report left from before an update,
    // or a start-up check that failed) are never stored: storing them would drop them again at the
    // next read and queue another check, without end.
    const current = this.probes.get(record.instanceId)?.lastGood?.fingerprint ?? fingerprintOf(report.binary.path)
    if (!sameBinary(current, report.binary)) return
    const counters = this.counters.get(record.instanceId)
    const facts: RuntimeFacts = { ...report, instanceId: record.instanceId, configRevision: counters.configRevision, accountGeneration: counters.accountGeneration }
    this.stats.delete(facts.binary.path)
    if (this.facts.set(record.instanceId, facts) && !this.stopped) this.changed(record.instanceId, { legacy: false })
  }

  async bind(resolved: ResolvedTurnSelection, input: BindInput): Promise<ExecutionBinding> {
    const record = resolved.instanceId === PI_DRIVER_ID ? undefined : this.recordOrUndefined(resolved.instanceId)
    // Nothing is admitted on an instance signed out in Mousse: no account check, no runtime start.
    if (record) this.refuseSignedOut(record)
    const accountId = record ? await this.currentAccount(record) : undefined
    const counters = this.counters.get(resolved.instanceId)
    // The attempt runs on the caps of this moment, whatever the runtime reports meanwhile.
    const caps = record ? this.recordCaps(record) : resolved.caps
    const requested = normalizePermissionMode(input.permissionMode)
    const { effective, supported } = this.resolvePermissionMode(record, caps, requested, input.cwd ?? undefined)
    if (effective.refused) throw harnessAppError(permissionModeRefusal(effective.reason, supported, resolved.instanceId))
    const binary = record ? this.probes.get(record.instanceId)?.lastGood?.fingerprint : undefined
    // The model is fixed here: a runtime that resolves `default` itself runs the bound model on
    // dispatch, retry and recovery, whatever its listing says by then.
    let model = resolved.model
    if (record?.runtime.concreteModel) {
      const concrete = record.runtime.concreteModel(model)
      if (!concrete) harnessFail('model_unavailable', `${this.displayName(record)} has no models listed. Refresh models, then try again.`, record.instanceId)
      model = concrete
    }
    const policy = freezePolicy({
      ...input.policy,
      mode: policyMode(input.mode),
      // A caller's own approvals policy (a definition's, a bot's) wins; otherwise Full access is the
      // agent approving its own tools and every other mode asks.
      approvals: input.policy?.approvals ?? input.approvals ?? (effective.mode === 'full' ? 'grants' : 'ask'),
      permissionMode: effective.mode,
      ...(effective.mode !== requested ? { requestedPermissionMode: requested } : {}),
      origin: input.origin ?? 'interactive'
    })
    const binding: ExecutionBinding = {
      instanceId: resolved.instanceId,
      driver: resolved.driver,
      accountGeneration: counters.accountGeneration,
      homeId: record?.env.homeId ?? DEFAULT_HOME_ID,
      configRevision: counters.configRevision,
      ...(accountId ? { accountId } : {}),
      model,
      ...(input.effort ? { effort: input.effort } : {}),
      policy,
      ...(input.policy ? { policyDigest: policyDigest(policy) } : {}),
      caps: { ...caps },
      factsRevision: record ? this.facts.revision(record.instanceId) : 0,
      ...(binary ? { binary: { ...binary } } : {})
    }
    this.boundAccounts.set(binding, accountId ? { accountId } : {})
    if (resolved.movedFrom) this.boundMoves.set(binding, resolved.movedFrom)
    return binding
  }

  nativeToolNames(instanceId: string, tools: readonly NeutralTool[]): { ok: true; names: string[] } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } } {
    const record = this.record(instanceId)
    const driver = record.driver
    const mapped = mapNeutralTools(driver.nativeToolNames ? (neutral) => driver.nativeToolNames!(neutral, record.config) : undefined, tools)
    if (mapped.ok) return mapped
    const reason = `${this.displayName(record)} has no tool for ${mapped.unmapped.join(', ')}.`
    return { ok: false, error: { code: 'policy_unenforceable', message: `This provider cannot enforce the requested restrictions (toolControl). ${reason}`, missing: ['toolControl'], reason, instanceId } }
  }

  selectionOf(binding: ExecutionBinding): Pick<ModelOverride, 'instanceId' | 'llmProvider' | 'model'> {
    if (binding.instanceId === PI_DRIVER_ID) return { instanceId: PI_DRIVER_ID, llmProvider: '', model: binding.model }
    const entry = this.instanceMap.list()[binding.instanceId]
    return { instanceId: binding.instanceId, llmProvider: (entry && legacyProviderForInstance(binding.instanceId, entry)) || '', model: binding.model }
  }

  /**
   * The instance's signed-in account right now, as `accountIdentity` hashes it; undefined when it
   * cannot be established in time. Every call reads it again, except that callers arriving while a
   * read runs share that read. Runtimes with native sessions or an identity of their own are
   * checked: the account decides whether a session may be resumed (Codex and Antigravity fence
   * through `auth({ force: true })`, others through `identity`).
   */
  private currentAccount(record: InstanceRecord): Promise<string | undefined> {
    if (!record.runtime.forgetConversation && !record.runtime.identity) return Promise.resolve(undefined)
    const state = this.probeState(record.instanceId)
    if (state.accountCheck) return state.accountCheck
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(undefined)
      }, this.options.accountCheckMs ?? TURN_ACCOUNT_CHECK_MS)
      timer.unref?.()
    })
    const runtime = record.runtime
    const check = runtime.identity
      ? runtime.identity(controller.signal).then((subject) => this.noteSubject(record, subject))
      : runtime.auth({ force: true, signal: controller.signal }).then((reading) => this.noteAuth(record, reading))
    const checking = Promise.race([check, deadline])
      .catch((error) => {
        console.warn('[harness] account check failed', { instanceId: record.instanceId, error: errorText(error) })
        return undefined
      })
      .then((accountId) => {
        clearTimeout(timer)
        if (state.accountCheck === checking) state.accountCheck = undefined
        return accountId
      })
    state.accountCheck = checking
    return checking
  }

  /**
   * Feeds a sign-in reading into the instance's account state: a different account than the last
   * one moves the account generation on. Returns the reading's account identity, if it has one.
   */
  private noteAuth(record: InstanceRecord, reading: AuthReading): string | undefined {
    // The page shows what a turn's check found without waiting for the next probe.
    const state = this.probeState(record.instanceId)
    if (state.result && (state.result.auth.state !== reading.state || state.result.auth.subject !== reading.subject)) {
      state.result = { ...state.result, auth: reading }
      if (!state.result.timedOut) state.lastGood = state.result
      if (!this.stopped && !state.probing) this.changed(record.instanceId, { legacy: false })
    }
    // Signed out: no account to share with another instance any more.
    if (reading.state === 'signed_out' || reading.state === 'expired') delete state.fingerprint
    return reading.state === 'signed_in' ? this.noteSubject(record, reading.subject) : undefined
  }

  /** Records the account `subject` names; a different one than last time moves the generation on. */
  private noteSubject(record: InstanceRecord, subject: string | undefined): string | undefined {
    if (!subject) return undefined
    this.probeState(record.instanceId).fingerprint = this.counters.accountFingerprint(subject)
    const accountId = this.counters.accountIdentity(record.env.homeId, subject)
    this.counters.noteAccount(record.instanceId, accountId)
    return accountId
  }

  private probeState(instanceId: string): ProbeState {
    const state = this.probes.get(instanceId) ?? {}
    this.probes.set(instanceId, state)
    return state
  }

  configuredProviderIds(): string[] {
    const ids: string[] = []
    for (const [instanceId, entry] of Object.entries(this.instanceMap.list())) {
      if (entry.driver === 'pi' || !entry.enabled) continue
      try {
        const record = this.record(instanceId)
        const llmProvider = legacyProviderForInstance(instanceId, entry)
        if (llmProvider && !this.isSignedOut(record) && record.runtime.configured() && !ids.includes(llmProvider)) ids.push(llmProvider)
      } catch {
        // An instance whose driver is missing offers nothing.
      }
    }
    return ids
  }

  // -- Turns ------------------------------------------------------------------------------------

  runSettled(runId: string): void {
    this.runCounters.settle(runId)
  }

  startTurn(spec: TurnSpec): TurnHandle {
    const record = this.turnRecord(spec.binding)
    let ref: ProviderRef | undefined
    let ended = false
    // One entry per attempt (the attempt id is unique; a duplicate never replaces a live entry).
    let key = spec.input.attemptId
    while (record.turns.has(key)) key = `${key}#${randomUUID()}`
    let finish: () => void = () => {}
    const entry: TurnEntry = {
      threadId: spec.input.threadId,
      cancel: new AbortController(),
      done: new Promise<void>((resolve) => { finish = resolve }),
      finish: () => finish()
    }
    record.turns.set(key, entry)
    const sink: TurnSink = {
      ...spec.sink,
      providerRef: (next) => {
        ref = next
        entry.ref = next
        spec.sink.providerRef(next)
        // A session that appears after the attempt was stopped is interrupted as soon as it is known.
        if (entry.cancel.signal.aborted && !entry.interrupted) {
          entry.interrupted = true
          void this.interruptOn(record, next, entry.threadId).catch((error) => this.warnStop(record, error))
        }
      }
    }
    record.active += 1
    const result = (async () => {
      let outcome: 'ok' | 'aborted' | 'failed' = 'failed'
      let minted: ReturnType<Harness['mintBridge']>
      // Count and spend limits travel as the run's budget; only a `hard` (and, for spend, `reserved`)
      // runtime passes admission with them. The record is taken before admission, so a first attempt
      // that is refused still leaves one.
      const limits = budgetLimitsOf(spec.binding.policy)
      const counted = limits ? this.runCounters.acquire(spec.input.runId, limits, spec.counters, { laterAttempt: (spec.attemptOrdinal ?? 1) > 1, ...(spec.spend ? { spend: spec.spend } : {}) }) : undefined
      let signal = spec.input.signal
      try {
        await this.admitTurn(record, spec, entry)
        // Admission awaits; the fence is checked again right before the runtime is reached.
        this.refuseStopped(record, entry)
        signal = AbortSignal.any([spec.input.signal, entry.cancel.signal])
        const input: TurnInput = { ...spec.input, signal }
        minted = this.mintBridge(record, spec)
        // Approvals other than `ask` are answered by the turn's bridge: a turn without one would
        // ask the user after all, so it does not run.
        if (!minted && spec.binding.policy.approvals !== 'ask')
          throw harnessAppError({
            code: 'policy_unenforceable',
            message: `This turn cannot refuse or pre-grant tool approvals on ${this.displayName(record)}: it has no turn bridge.`,
            reason: 'The turn has no app context, so nothing answers its permission requests.',
            instanceId: spec.binding.instanceId
          })
        // The definition authority comes only from the app context (one source for every tool).
        const base: AdapterHost = { ...spec.host }
        delete base.definition
        const host: AdapterHost = {
          ...base,
          ...(minted ? { bridge: minted.bridge } : {}),
          ...(spec.app?.definition ? { definition: spec.app.definition } : {}),
          ...(counted ? { budget: counted.budget } : {})
        }
        const turn = await record.runtime.adapter.startTurn(input, sink, spec.control, host)
        minted?.settle({ status: turn.aborted || signal.aborted ? 'aborted' : 'completed', ...(turn.drain ? { drain: turn.drain } : {}) })
        minted = undefined
        // The adapter ended because the instance was removed or turned off: the thread sees why.
        if (turn.aborted && this.cancelledByStop(spec, entry)) throw entry.cancel.signal.reason
        outcome = turn.aborted ? 'aborted' : 'ok'
        return turn
      } catch (error) {
        minted?.settle({ status: signal.aborted ? 'aborted' : 'failed' })
        if (this.cancelledByStop(spec, entry)) throw entry.cancel.signal.reason
        throw error
      } finally {
        counted?.release()
        ended = true
        record.turns.delete(key)
        record.active -= 1
        entry.completed = outcome === 'ok'
        this.stopNotice(record, entry)
        entry.finish()
        // A turn's `session/new` may have taught the runtime something; the next admission sees it.
        if (!record.retired) this.captureFacts(record)
        this.releaseRetired()
      }
    })()
    return {
      result,
      providerRef: () => ref,
      interrupt: async () => (ended || !ref ? 'not_active' : this.interruptOn(record, ref, spec.input.threadId)),
      steer: async (text) => {
        if (ended) return 'not_active'
        if (ref && record.runtime.adapter.steer && (await record.runtime.adapter.steer(ref, text)) === 'delivered') return { delivery: 'live' }
        return { delivery: 'queued' }
      }
    }
  }

  async oneShot(request: OneShotRequest): Promise<{ text: string }> {
    let resolved: ResolvedTurnSelection
    try {
      resolved = this.resolveStored(request.selection, { purpose: request.purpose, ...(request.scope ? { scope: request.scope } : {}) })
    } catch (error) {
      throw asHarnessError(error, request.selection.instanceId ?? '')
    }
    const record = this.record(resolved.instanceId)
    const runtime = record.runtime
    if (!runtime.oneShot) harnessFail('unsupported', `${this.displayName(record)} cannot run a single request.`, record.instanceId)
    if (record.stopped) throw this.stopError(record, record.stopped.reason)
    this.refuseSignedOut(record)
    // The gateway's inactivity bound: every provider event restarts it; past it the request is aborted.
    const idle = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const restart = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), ONE_SHOT_INACTIVITY_MS)
    }
    const signal = request.signal ? AbortSignal.any([request.signal, idle.signal]) : idle.signal
    const { baseId } = parseThinkingSuffixFromModelId(resolved.model)
    const customModel = this.catalog.customModel(record.instanceId, baseId)
    restart()
    try {
      const { text } = await runtime.oneShot({
        model: resolved.model,
        ...(customModel ? { customModel } : {}),
        system: request.system,
        prompt: request.prompt,
        ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
        onActivity: restart
      }, signal)
      return { text: text.slice(0, Math.max(0, request.maxChars)) }
    } catch (error) {
      if (idle.signal.aborted && !request.signal?.aborted)
        harnessFail('timeout', `${this.displayName(record)} sent nothing for ${ONE_SHOT_INACTIVITY_MS / 1000} seconds.`, record.instanceId)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Runs a turn on its binding or not at all: the input names the binding's instance, model and
   * policy mode, the instance can enforce that policy, and its config, home and account are still
   * the ones the binding recorded (a retry or recovery after a change fails with `binding_stale`).
   * Then decides whether the thread's native session may be resumed.
   */
  private async admitTurn(record: InstanceRecord, spec: TurnSpec, entry: TurnEntry): Promise<void> {
    const { binding, previous, input } = spec
    // An attempt stopped before it got here never runs, and a turn admitted after the instance was
    // turned on again waits until the stops of the turn off before it (on any runtime of the
    // instance, replaced or not) have drained, so they cannot reach it.
    this.refuseStopped(record, entry)
    const draining = this.stopBarriers.get(record.instanceId)
    if (draining?.size) await Promise.all([...draining])
    this.refuseStopped(record, entry)
    // Every attempt (first, retry, recovery, continuation) of an instance signed out in Mousse is refused.
    this.refuseSignedOut(record)
    if (input.instanceId !== binding.instanceId || input.model !== binding.model)
      harnessFail('protocol', `The turn names ${input.instanceId ?? 'no instance'}/${input.model} but its binding is ${binding.instanceId}/${binding.model}.`, binding.instanceId)
    // The runtime takes its permissions from the input's mode: it must be the binding's policy.
    if (policyMode(input.mode) !== binding.policy.mode)
      harnessFail('protocol', `The turn runs in ${policyMode(input.mode)} mode but its binding is ${binding.policy.mode} mode.`, binding.instanceId)
    // A stored binding runs on the policy it was made with, or not at all.
    if (binding.policyDigest !== undefined && binding.policyDigest !== policyDigest(binding.policy))
      harnessFail('protocol', 'The policy of this turn is not the one its binding was made with.', binding.instanceId)
    // The caps the binding froze (bindings from before snapshots: the live ones).
    const caps = binding.caps ?? this.recordCaps(record)
    // Token and spend limits also need the model's own facts (an output cap, a price).
    const spendModel = hasSpendLimit(binding.policy) ? record.runtime.spendModel?.(binding.model) : undefined
    const enforceable = checkPolicy(caps, binding.policy, binding.instanceId, spendModel)
    if (!enforceable.ok) throw harnessAppError(enforceable.error)
    // The runtime takes its permission mode from the input: it must be the binding's.
    if (binding.policy.permissionMode !== undefined && input.permissionMode !== undefined && input.permissionMode !== binding.policy.permissionMode)
      harnessFail('protocol', `The turn runs in ${input.permissionMode} permission mode but its binding is ${binding.policy.permissionMode}.`, binding.instanceId)
    // An instance that approves tools itself runs only in Full access, on every dispatch of a run.
    const modeCheck = checkPermissionMode(caps, binding.policy, this.displayName(record), binding.instanceId)
    if (!modeCheck.ok) throw harnessAppError(modeCheck.error)
    const stale = (what: string) => harnessFail('binding_stale', `This run started before ${what} of this provider changed, so it cannot continue on it. Send the message again.`, binding.instanceId)
    if (record.env.homeId !== binding.homeId) stale('the home')
    if (this.counters.get(binding.instanceId).configRevision !== binding.configRevision) stale('the settings')
    const binary = this.probes.get(binding.instanceId)?.lastGood?.fingerprint
    if (binding.binary && binary && !sameBinary(binding.binary, binary)) stale('the installed program')
    // The reading `bind` took for this binding serves its first dispatch; anything else reads again.
    const bound = this.boundAccounts.get(binding)
    this.boundAccounts.delete(binding)
    const accountId = bound ? bound.accountId : await this.currentAccount(record)
    if (this.counters.get(binding.instanceId).accountGeneration !== binding.accountGeneration ||
        (binding.accountId && accountId && accountId !== binding.accountId)) stale('the signed-in account')
    // A native session belongs to the home, account and config it was made with, and resumes only
    // when the account read now is the binding's: an account that cannot be read now may be another
    // one. Sessions from before bindings existed resume only in the user's own home.
    const verified = binding.accountId === undefined || accountId === binding.accountId
    const resumable = previous !== undefined && previous.instanceId === binding.instanceId &&
      previous.homeId === binding.homeId && previous.configRevision === binding.configRevision &&
      previous.accountGeneration === binding.accountGeneration &&
      binding.accountId !== undefined && previous.accountId === binding.accountId && accountId === binding.accountId
    if (toolControlLevel(caps) === 'uncontrolled') this.toolControlNotice(record, input.threadId, previous)
    const movedFrom = this.boundMoves.get(binding)
    if (movedFrom) this.moveNotice(movedFrom, record, input.threadId)
    if (resumable || (!previous && binding.homeId === DEFAULT_HOME_ID && verified)) return
    try {
      record.runtime.forgetConversation?.(input.threadId)
    } catch (error) {
      console.warn('[harness] could not drop a native session', { instanceId: binding.instanceId, error: errorText(error) })
    }
  }

  /** The first turn of a thread on an instance that approves tools itself says so, once. */
  private toolControlNotice(record: InstanceRecord, threadId: string, previous: ExecutionBinding | undefined): void {
    const key = `${threadId}|${record.instanceId}`
    if (previous?.instanceId === record.instanceId || this.toolNotices.has(key)) return
    this.toolNotices.add(key)
    try {
      this.liveHost?.notice?.(threadId, `${this.displayName(record)} approves tools itself.`)
    } catch (error) {
      console.warn('[harness] notice failed', errorText(error))
    }
  }

  /**
   * A thread pinned to a moved entry continues on the agent; its history is handed over
   * (`history_injected`), and the thread is told once.
   */
  private moveNotice(movedFrom: string, record: InstanceRecord, threadId: string): void {
    const key = `moved|${threadId}|${movedFrom}`
    if (this.toolNotices.has(key)) return
    this.toolNotices.add(key)
    const from = this.recordOrUndefined(movedFrom)
    try {
      this.liveHost?.notice?.(threadId, `${from ? this.displayName(from) : movedFrom} moved to ${this.displayName(record)}. This chat continues there with its history handed over.`)
    } catch (error) {
      console.warn('[harness] notice failed', errorText(error))
    }
  }

  /**
   * The mode a turn asking for `requested` runs in on this instance: the modes it supports come from
   * its tool control and from what limits them right now (read at this moment, never cached with the
   * runtime facts, so an edit to the user's Claude settings applies to the next turn).
   */
  private resolvePermissionMode(record: InstanceRecord | undefined, caps: HarnessCaps, requested: PermissionMode, cwd?: string): { effective: EffectivePermissionMode; supported: PermissionMode[] } {
    const limits = record ? this.permissionLimitsOf(record, cwd) : undefined
    const supported = supportedPermissionModes(caps, limits)
    const agent = record ? this.displayName(record) : 'This provider'
    return { effective: effectivePermissionMode(requested, supported, { agent, ...(limits ? { limits } : {}) }), supported }
  }

  previewPermissionMode(resolved: ResolvedTurnSelection, requested: PermissionMode, cwd?: string | null): EffectivePermissionMode {
    const record = resolved.instanceId === PI_DRIVER_ID ? undefined : this.recordOrUndefined(resolved.instanceId)
    return this.resolvePermissionMode(record, record ? this.recordCaps(record) : resolved.caps, requested, cwd ?? undefined).effective
  }

  /** What limits the instance's permission modes right now; a runtime that reports nothing is unlimited. */
  private permissionLimitsOf(record: InstanceRecord, cwd?: string): PermissionLimits | undefined {
    try {
      return record.runtime.permissionLimits?.(cwd)
    } catch (error) {
      console.warn('[harness] could not read permission limits', { instanceId: record.instanceId, error: errorText(error) })
      return undefined
    }
  }

  /** Capabilities of a record's instance at its last known version and current runtime facts. */
  private recordCaps(record: InstanceRecord): HarnessCaps {
    return record.driver.caps(record.config, this.probes.get(record.instanceId)?.lastGood?.binary?.version, this.currentFacts(record.instanceId))
  }

  /** A native cancel with the gateway's deadline: past it the runtime's processes are killed. */
  private interruptOn(record: InstanceRecord, ref: ProviderRef, threadId?: string): Promise<'interrupted' | 'not_active'> {
    const runtime = record.runtime
    return interruptWithDeadline({
      interrupt: (target) => runtime.adapter.interrupt(target),
      ...(runtime.terminate ? { terminate: (target: ProviderRef) => runtime.terminate!(target) } : {}),
      ...(runtime.forgetConversation ? { forgetConversation: (id: string) => runtime.forgetConversation!(id) } : {})
    }, ref, { ...(threadId ? { threadId } : {}) })
  }

  /** The typed error a thread sees when its instance was removed or turned off. */
  private stopError(record: InstanceRecord, reason: StopReason): unknown {
    return reason === 'removed'
      ? harnessAppError({ code: 'instance_unknown', message: `${this.displayName(record)} was removed from Mousse.`, instanceId: record.instanceId })
      : harnessAppError({ code: 'instance_disabled', message: `${this.displayName(record)} was turned off on this device.`, instanceId: record.instanceId })
  }

  /** Throws when the attempt was stopped, or when the instance is removed or off and nothing has lifted that. */
  private refuseStopped(record: InstanceRecord, entry: TurnEntry): void {
    if (entry.cancel.signal.aborted) throw entry.cancel.signal.reason
    if (record.stopped) throw this.stopError(record, record.stopped.reason)
  }

  /** The attempt ended because the instance was stopped, not because its own caller stopped it. */
  private cancelledByStop(spec: TurnSpec, entry: TurnEntry): boolean {
    return entry.cancel.signal.aborted && !spec.input.signal.aborted
  }

  private warnStop(record: InstanceRecord, error: unknown): void {
    console.warn('[harness] could not stop a turn', { instanceId: record.instanceId, error: errorText(error) })
  }

  /** Tells the attempt's thread why it stopped, once. */
  private stopNotice(record: InstanceRecord, entry: TurnEntry): void {
    if (entry.noticed || entry.completed || !entry.stoppedFor) return
    entry.noticed = true
    const name = this.displayName(record)
    const text = entry.stoppedFor === 'removed'
      ? `${name} was removed from Mousse; this chat was stopped. Choose another model to continue.`
      : `${name} was turned off on this device; this chat was stopped. Choose another model to continue.`
    try {
      this.liveHost?.notice?.(entry.threadId, text)
    } catch (error) {
      console.warn('[harness] notice failed', errorText(error))
    }
  }

  /**
   * Stops what runs on an instance that was removed or turned off, on its current runtime and on
   * every older one still finishing turns. Phase 1 is synchronous: the fence goes up and every
   * attempt is cancelled before anything is awaited, so no attempt can pass admission or reach the
   * runtime however long the stops take, nor be revived by turning the instance on again. Phase 2
   * awaits the runtime's own stops; `stopBarriers` holds them per instance, and a turn admitted later
   * waits for them whatever became of the runtime that was stopped.
   */
  private stopTurns(instanceId: string, current: InstanceRecord | undefined, reason: StopReason): Promise<void> {
    const records = [...new Set([...(current ? [current] : []), ...[...this.retired].filter((record) => record.instanceId === instanceId)])]
    const stops: Array<{ record: InstanceRecord; entry: TurnEntry }> = []
    for (const record of records) {
      record.stopped = { reason }
      for (const entry of record.turns.values()) {
        // An attempt a disable already stopped is being drained by that disable.
        if (entry.cancel.signal.aborted) continue
        entry.stoppedFor = reason
        entry.cancel.abort(this.stopError(record, reason))
        stops.push({ record, entry })
      }
    }
    const drain = (async () => {
      await Promise.all(stops.map(async ({ record, entry }) => {
        let stopped = false
        let interrupted = false
        try {
          stopped = (await record.runtime.adapter.stopThread?.(entry.threadId)) === 'stopped'
        } catch (error) {
          this.warnStop(record, error)
        }
        const ref = entry.ref
        if (ref && !entry.interrupted) {
          entry.interrupted = true
          try {
            interrupted = (await this.interruptOn(record, ref, entry.threadId)) === 'interrupted'
          } catch (error) {
            this.warnStop(record, error)
          }
        }
        // The notice follows the result, and only when the runtime really stopped or the attempt ended with the stop.
        if (stopped || interrupted) void entry.done.then(() => this.stopNotice(record, entry))
      }))
    })()
    // Registered in the same turn of the event loop as phase 1, before any attempt can be admitted.
    let barriers = this.stopBarriers.get(instanceId)
    if (!barriers) this.stopBarriers.set(instanceId, (barriers = new Set()))
    const held = barriers
    held.add(drain)
    void drain.finally(() => {
      held.delete(drain)
      if (!held.size && this.stopBarriers.get(instanceId) === held) this.stopBarriers.delete(instanceId)
    })
    return drain
  }

  async childPreflight(instanceId: string, context: ChildPreflightContext): Promise<SubagentRefusal | null> {
    const record = instanceId === PI_DRIVER_ID ? this.piRecord() : this.record(instanceId, { allowDisabled: true })
    return (await record.runtime.adapter.childPreflight?.(context)) ?? null
  }

  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return this.interruptOn(this.refRecord(ref), ref)
  }

  async forkSession(ref: ProviderRef, atTurnOrdinal: number, target?: { threadId: string }): Promise<ProviderRef | null> {
    const adapter = this.refRecord(ref).runtime.adapter
    return adapter.forkSession ? adapter.forkSession(ref, atTurnOrdinal, target) : null
  }

  async stopThread(threadId: string): Promise<'stopped' | 'not_active'> {
    const results = await Promise.allSettled([...this.records.values()].map((record) => record.runtime.adapter.stopThread?.(threadId)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (results.some((result) => result.status === 'fulfilled' && result.value === 'stopped')) return 'stopped'
    if (failed) throw failed.reason
    return 'not_active'
  }

  setLiveHost(host: LiveProcessHost | null): void {
    this.liveHost = host
    for (const record of this.records.values()) record.runtime.setLiveHost?.(host)
  }

  setMcpAttachment(provider: McpAttachmentProvider | null): void {
    this.mcp = provider
  }

  /**
   * The turn's bridge (PR 2 §2 `TurnBridge`, the orchestrator's former `mcpFor`): a bearer under the
   * driver's turn binding when the instance can attach the Mousse MCP server, the instruction texts,
   * and the settle that ends the turn for the bearer (the drained-turn check, then in-flight calls
   * abort). A bearer that cannot be minted leaves the turn without Mousse tools, never failed.
   */
  private mintBridge(record: InstanceRecord, spec: TurnSpec): { bridge: TurnBridge; settle(settlement: TurnSettlement): void } | undefined {
    const app = spec.app
    if (!app) return undefined
    const { binding, input } = spec
    const caps = this.recordCaps(record)
    let attachment: { url: string; token: string; tokenHash: string } | null = null
    if (app.mcpEligible && this.mcp && mcpAttachable(caps)) {
      try {
        attachment = this.mcp.bearerForTurn({
          threadId: input.threadId,
          instanceId: binding.instanceId,
          runId: input.runId,
          modeCeiling: app.modeCeiling,
          binding: record.driver.mcpTurnBinding ?? 'rotate',
          // A new runtime, a new epoch: driver, home, signed-in account and settings, and a caller's
          // policy (a narrower grant must not keep the tool list of the last one).
          generation: [binding.driver, binding.homeId, binding.accountGeneration, binding.configRevision, ...(binding.policyDigest ? [binding.policyDigest] : [])].join('|')
        })
      } catch (error) {
        console.warn('Mousse MCP credential could not be minted; the turn runs without Mousse tools', {
          runId: input.runId,
          error: errorText(error)
        })
      }
    }
    const mcp = this.mcp
    const texts = app.instructions(attachment !== null)
    return {
      bridge: {
        mcp: attachment ? { url: attachment.url, token: attachment.token } : null,
        turnToken: app.turnToken,
        sessionInstructions: texts.sessionInstructions,
        turnPreamble: texts.turnPreamble,
        ...(binding.policy.tools ? { toolPolicy: binding.policy.tools } : {}),
        userMcp: record.driver.userMcp ?? 'native',
        // `never`: nobody answers, so every permission request is denied without asking.
        permission: binding.policy.approvals === 'never' ? refusingPrompter() : questionsPrompter(this.options.questions)
      },
      settle: (settlement) => {
        if (!attachment || !mcp) return
        try {
          mcp.turnEnded({ threadId: input.threadId, runId: input.runId, tokenHash: attachment.tokenHash, settlement })
        } catch (error) {
          console.warn('Mousse MCP turn end failed', { threadId: input.threadId, error: errorText(error) })
        }
      }
    }
  }

  inFlightContinuation(threadId: string): { id: string; discarded: boolean } | undefined {
    for (const record of this.records.values()) {
      const flight = record.runtime.inFlightContinuation?.(threadId)
      if (flight) return flight
    }
    return undefined
  }

  hasContinuation(threadId: string, id?: string): boolean {
    for (const record of this.records.values()) if (record.runtime.hasContinuation?.(threadId, id)) return true
    return false
  }

  discardContinuations(threadId: string, id?: string): void {
    for (const record of this.records.values()) record.runtime.discardContinuations?.(threadId, id)
  }

  /** The runtime of a turn's binding; the bare pi driver serves unselected-default turns. */
  private turnRecord(binding: ExecutionBinding): InstanceRecord {
    if (binding.instanceId === PI_DRIVER_ID) return this.piRecord()
    return this.record(binding.instanceId, { allowDisabled: true })
  }

  private refRecord(ref: ProviderRef): InstanceRecord {
    const resolved = this.resolveStored({ instanceId: ref.instanceId, llmProvider: ref.provider, model: ref.model ?? '' }, { purpose: 'turn', allowDisabled: true, unselectedDefault: true })
    return resolved.instanceId === PI_DRIVER_ID ? this.piRecord() : this.record(resolved.instanceId, { allowDisabled: true })
  }

  private piRecord(): InstanceRecord {
    const existing = this.records.get(PI_DRIVER_ID)
    if (existing) return existing
    return this.build(PI_DRIVER_ID, { driver: 'pi', enabled: true })
  }

  // -- Records ----------------------------------------------------------------------------------

  /** The instance's record, (re)built when its driver, revision or home changed. */
  private record(instanceId: string, options: { allowDisabled?: boolean } = {}): InstanceRecord {
    let resolved
    try {
      resolved = this.instanceMap.resolve(instanceId, { allowDisabled: true })
    } catch (error) {
      throw asHarnessError(error, instanceId)
    }
    if (!resolved.entry.enabled && !options.allowDisabled)
      harnessFail('instance_disabled', `Provider instance "${instanceId}" is disabled. Enable it or choose another model.`, instanceId)
    const current = this.records.get(instanceId)
    const driver = this.drivers.get(resolved.entry.driver)
    if (!driver) return harnessFail('unsupported', `No driver for ${resolved.entry.driver} (instance ${instanceId}).`, instanceId)
    const config = driver.decodeConfig(resolved.entry.config, instanceId)
    const key = recordKey(driver, this.counters.get(instanceId).configRevision, config)
    if (current && current.key === key) {
      current.entry = resolved.entry
      current.config = config
      return current
    }
    if (current) this.retire(current)
    const next = this.build(instanceId, resolved.entry)
    // A new runtime of an instance that is turned off stays fenced until it is turned on.
    if (current?.stopped) next.stopped = current.stopped
    return next
  }

  /** The name the instance lists a model under (hidden models included), else its id without the effort. */
  private modelName(instanceId: string, model: string): string {
    const { baseId } = parseThinkingSuffixFromModelId(model)
    const listed = this.recordOrUndefined(instanceId)?.runtime.models() ?? []
    return (listed.find((entry) => entry.id === model) ?? listed.find((entry) => entry.id === baseId))?.label?.trim()
      || this.prefs.get(instanceId).custom.find((entry) => entry.id === baseId)?.label
      || baseId
  }

  private recordOrUndefined(instanceId: string): InstanceRecord | undefined {
    try {
      return this.record(instanceId, { allowDisabled: true })
    } catch {
      return undefined
    }
  }

  private build(instanceId: string, entry: ProviderInstanceConfig): InstanceRecord {
    const driver = this.drivers.get(entry.driver)
    if (!driver) return harnessFail('unsupported', `No driver for ${entry.driver} (instance ${instanceId}).`, instanceId)
    const config = driver.decodeConfig(entry.config, instanceId)
    const builtIn = isBuiltInInstance(instanceId, entry.driver)
    const stateDir = instanceStateDir(this.options.profileHome, instanceId)
    const revision = this.counters.get(instanceId).configRevision
    const env = instanceEnv({
      instanceId,
      driver: entry.driver,
      configRevision: revision,
      ...(alwaysPrivate(driver, config) || (config.home === 'private' && !builtIn) ? { home: join(stateDir, 'home') } : {}),
      searchPath: this.searchPath
    })
    const record: InstanceRecord = {
      instanceId,
      entry,
      driver,
      config,
      builtIn,
      key: recordKey(driver, revision, config),
      env,
      active: 0,
      turns: new Map(),
      runtime: undefined as unknown as DriverRuntime
    }
    record.runtime = driver.create({
      instanceId,
      builtIn,
      config,
      env,
      profileHome: this.options.profileHome,
      installationHome: this.options.installationHome,
      stateDir,
      questions: this.options.questions,
      findBinary: () => this.findBinary(record),
      changed: () => this.changed(instanceId),
      signedOut: () => this.signedOutInMousse(instanceId),
      saveLaunch: async (patch) => void (await this.configure(instanceId, patch))
    })
    record.runtime.setLiveHost?.(this.liveHost)
    this.records.set(instanceId, record)
    return record
  }

  /** The CLI an instance would find without an override; the vendor services use it for their lookup. */
  findBinaryFor(instanceId: string): string | undefined {
    const record = this.recordOrUndefined(instanceId)
    return record ? this.findBinary(record) : undefined
  }

  /** The CLI an instance would find on PATH (inherited, `~/.local/bin`, then the login shell's). */
  private findBinary(record: InstanceRecord): string | undefined {
    if (record.runtime?.pinned) return record.runtime.managed?.()?.path
    if (!record.driver.binaryNames.length) return undefined
    return findOnPath(record.driver.binaryNames, { env: record.env.env, searchPath: [...this.searchPath, ...(record.env.driverSearchPath ?? [])] })
  }

  /** A replaced runtime stops once the turns running on it end; their work is never rebound. */
  private retire(record: InstanceRecord): void {
    record.retired = true
    this.retired.add(record)
    this.releaseRetired()
  }

  private releaseRetired(): void {
    for (const record of this.retired) {
      if (record.active > 0) continue
      this.retired.delete(record)
      let stopped: void | Promise<void> = undefined
      try {
        stopped = record.runtime.stop()
      } catch (error) {
        console.warn('[harness] runtime stop failed', { instanceId: record.instanceId, error: errorText(error) })
      }
      // A removed instance's files wait for its processes to exit.
      const removal = this.removals.get(record.instanceId)
      if (stopped && removal) {
        removal.pending += 1
        void stopped.catch((error) => console.warn('[harness] runtime stop failed', { instanceId: record.instanceId, error: errorText(error) })).finally(() => {
          removal.pending -= 1
          this.deleteRemoved()
        })
      } else if (stopped) {
        void stopped.catch(() => {})
      }
    }
    this.deleteRemoved()
  }

  /**
   * Deletes Mousse's own state of a removed instance once nothing uses it: no runtime of the
   * instance (the last one or one a reconfiguration replaced) runs a turn, and no check or
   * operation of it is still running. A private home, and the sign-in in it, is kept (`removeStateDir`).
   */
  private deleteRemoved(): void {
    for (const [instanceId, removal] of this.removals) {
      if (removal.pending > 0) continue
      if ([...this.retired].some((record) => record.instanceId === instanceId)) continue
      if ([...this.operations.values()].some((operation) => operation.started.instanceId === instanceId)) continue
      this.removals.delete(instanceId)
      try {
        removeStateDir(removal.dir)
      } catch (error) {
        // A re-added instance never reuses a directory left behind (`add`).
        console.warn('[harness] could not delete the files of a removed instance', { instanceId, error: errorText(error) })
      }
    }
  }

  private legacyRecord(providerId: string): InstanceRecord | undefined {
    let instanceId: string
    try {
      instanceId = this.instanceMap.instanceIdForLegacyProvider(providerId)
    } catch {
      return undefined
    }
    const record = this.recordOrUndefined(instanceId)
    return record && record.entry.driver !== 'pi' ? record : undefined
  }

  // -- Snapshots and probes ---------------------------------------------------------------------

  async snapshots(scope: ProviderScope): Promise<InstanceSnapshot[]> {
    const ids = Object.keys(this.instanceMap.list())
    const firstChecks: Array<Promise<void>> = []
    for (const instanceId of ids) {
      const state = this.probes.get(instanceId)
      const due = !state?.checkedAtMs || this.now() - state.checkedAtMs >= PROBE_TTL_MS
      if (!due || !this.instanceMap.list()[instanceId]?.enabled) continue
      const probing = this.probe(instanceId, false)
      // The first check of an instance is awaited (each phase has a hard deadline); later
      // refreshes run in the background and arrive as `providers.snapshots` events.
      if (!state?.result) firstChecks.push(probing)
    }
    this.refreshLatest(ids)
    await Promise.all(firstChecks)
    return ids.flatMap((instanceId) => {
      try {
        return [this.snapshot(instanceId, scope)]
      } catch {
        return []
      }
    })
  }

  private async usage(scope: ProviderScope): Promise<ProviderUsage[]> {
    const entries = this.instanceMap.list()
    const ids = Object.keys(entries).filter((instanceId) => {
      const record = this.recordOrUndefined(instanceId)
      return record?.runtime.usage && !record.stopped && this.scopes.enabled(instanceId, entries[instanceId]!.enabled, scope).effective && record.runtime.configured()
    })
    return Promise.all(ids.map(async (instanceId): Promise<ProviderUsage> => {
      const record = this.record(instanceId, { allowDisabled: true })
      const named = { id: instanceId, label: this.displayName(record) }
      const controller = new AbortController()
      // A runtime that ignores the signal still cannot hold the page up past the deadline.
      const late = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('The usage did not arrive in time.')), { once: true }))
      const timer = setTimeout(() => controller.abort(), USAGE_READ_MS)
      try {
        return { ...named, ...(await Promise.race([record.runtime.usage!(controller.signal), late])) }
      } catch (error) {
        return { ...named, status: 'error', windows: [], message: controller.signal.aborted ? 'The usage did not arrive in time.' : errorText(error) }
      } finally {
        clearTimeout(timer)
      }
    }))
  }

  /**
   * Single-flight probe of one instance; a timeout keeps the last good values (stale). `handshake`
   * (Add, Recheck, after install) also runs the runtime's start-up check, which records its facts.
   */
  private probe(instanceId: string, force: boolean, options: { handshake?: boolean } = {}): Promise<void> {
    const state = this.probes.get(instanceId) ?? {}
    this.probes.set(instanceId, state)
    if (state.probing) return state.probing
    let upgraded = false
    const run = async () => {
      await Promise.race([this.shellPath, new Promise((resolve) => setTimeout(resolve, SHELL_PATH_WAIT_MS).unref?.())])
      const record = this.record(instanceId, { allowDisabled: true })
      const override = record.config.binaryPath
      // Signed out in Mousse: reported as such without asking the runtime (no CLI status check).
      const signedOut = this.isSignedOut(record)
      let result = await probeInstance({
        driver: record.driver,
        runtime: record.runtime,
        ...(signedOut ? { auth: async () => this.signedOutReading(record) } : {}),
        env: { ...record.env, searchPath: [...this.searchPath, ...(record.env.driverSearchPath ?? [])] },
        ...(override ? { override } : {}),
        config: record.config,
        force,
        ...(options.handshake ? { handshake: true } : {}),
        ...(this.options.probeTimeouts ? { timeouts: this.options.probeTimeouts } : {})
      })
      // An executable without a version flag shows only through its start-up check: a periodic check
      // keeps what the last one found until the program or its settings change.
      const revision = this.counters.get(instanceId).configRevision
      if (result.handshakeRan) state.handshake = { runs: result.runs, ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}), revision }
      else if (state.handshake && record.driver.versionArgs?.(record.config) === null && result.runs.state === 'yes' &&
          state.handshake.revision === revision && sameBinary(state.handshake.fingerprint, result.fingerprint))
        result = { ...result, runs: state.handshake.runs }
      const before = state.lastGood?.fingerprint
      state.result = result
      state.checkedAtMs = this.now()
      if (!result.timedOut) state.lastGood = result
      // A different account than the last check: sessions made on the old one are not resumed.
      this.noteAuth(record, result.auth)
      if (options.handshake) this.captureFacts(record)
      // A different program than the last check saw (a CLI upgrade): its models come right away.
      upgraded = !result.timedOut && Boolean(before && result.fingerprint && !sameBinary(before, result.fingerprint))
    }
    state.probing = run()
      .catch((error) => {
        console.warn('[harness] provider check failed', { instanceId, error: errorText(error) })
        state.checkedAtMs = this.now()
        // Recorded like a check that did not finish: the last good values stay (stale), or the
        // page says what failed and offers Check again, never "Checking" until the TTL ends.
        const message = `The check failed: ${errorText(error)}`
        const last = state.lastGood
        state.result = {
          checkedAt: new Date(this.now()).toISOString(),
          install: last?.install ?? 'unknown',
          runs: { state: 'unknown', message },
          auth: { state: 'unknown', message },
          compatibility: last?.compatibility ?? { state: 'unknown' },
          timedOut: Boolean(last)
        }
      })
      .finally(() => {
        state.probing = undefined
        if (!this.stopped) this.changed(instanceId, { legacy: false })
        // After the check ends, so what the refresh publishes cannot be taken for part of it.
        if (upgraded) this.refreshAfterUpgrade(instanceId)
      })
    return state.probing
  }

  private snapshot(instanceId: string, scope: ProviderScope): InstanceSnapshot {
    const record = this.record(instanceId, { allowDisabled: true })
    const { driver, config, runtime } = record
    const state = this.probes.get(instanceId)
    const latest = state?.result
    const stale = Boolean(latest?.timedOut)
    const shown = stale ? state?.lastGood : latest
    const operation = [...this.operations.values()].find((entry) => entry.started.instanceId === instanceId && entry.started.kind !== 'sign_in')
    const installing = Boolean(operation) || runtime.installState?.().installing === true
    const installProgress = operation?.progress ?? (runtime.installState?.().progress ? { message: runtime.installState!().progress! } : undefined)
    const managed = runtime.managed?.()
    // Signed out in Mousse wins over a check that started before the sign-out.
    const auth = this.isSignedOut(record) ? this.signedOutReading(record) : shown?.auth ?? { state: 'unknown' as const }
    const update = this.updateFor(record)
    const settingsNotice = this.settingsNotices.get(instanceId)
    const sameAccount = auth.state === 'signed_in' ? this.sameAccountNote(record) : undefined
    const dropped = this.droppedEnvNote(record)
    const prefs = this.prefs.get(instanceId)
    const listed = runtime.models()
    const models = state?.models
    // The runtime keeps the age of the list it stores; a runtime without that knows this run's refreshes.
    const refreshedAt = runtime.modelsRefreshedAt ? runtime.modelsRefreshedAt() : models?.refreshedAt
    // Recomputed on every snapshot: the user may edit their Claude settings at any time.
    const limits = this.permissionLimitsOf(record)
    const signInStep: NextStep | undefined = auth.state === 'signed_out' || auth.state === 'expired'
      ? { action: 'sign_in', label: auth.state === 'expired' ? 'Sign in again' : 'Sign in', ...(auth.signInCommand ? { command: auth.signInCommand } : {}) }
      : undefined
    // An entry whose old route is going away keeps asking to move (and offers no sign-in) until it moved.
    const prompt = record.entry.driver === 'pi' && !record.config.movedTo ? movePromptOf(piProviderIdOf(instanceId)) : undefined
    const nextStep: NextStep | undefined = prompt ? { action: 'move', label: 'Move', title: prompt.title, detail: prompt.detail } : signInStep
    return {
      instanceId,
      driver: driver.kind,
      displayName: this.displayName(record),
      builtIn: record.builtIn,
      scope,
      enabled: this.scopes.enabled(instanceId, record.entry.enabled, scope),
      install: {
        state: installing ? 'installing' : shown?.install ?? 'unknown',
        ...(operation ? { operationId: operation.started.operationId } : {}),
        ...(installing && installProgress ? { progress: installProgress } : {}),
        canInstall: driver.canInstall && Boolean(runtime.install),
        ...(managed?.bytes !== undefined && runtime.removeInstall ? { downloaded: { bytes: managed.bytes } } : {}),
        ...(managed?.checksum ? { checksum: managed.checksum } : {}),
        ...(managed?.advisory ? { advisory: managed.advisory } : {})
      },
      runs: shown?.runs ?? { state: 'unknown' },
      auth: {
        state: auth.state,
        // Keyed by its salted hash: the vendor's account id never leaves the gateway.
        ...(auth.account?.label ? { account: { id: auth.subject ? this.counters.accountIdentity(record.env.homeId, auth.subject) : 'unknown', label: auth.account.label } } : {}),
        ...(auth.methodLabel ?? driver.methodLabel ? { methodLabel: auth.methodLabel ?? driver.methodLabel } : {}),
        ...(sameAccount || dropped || auth.message ? { message: [auth.message, sameAccount, dropped].filter(Boolean).join(' ') } : {}),
        canSignOut: Boolean(runtime.signOut) && (auth.state === 'signed_in' || auth.state === 'expired') && (this.ownsSignIn(record) || auth.ownedByMousse === true),
        ...(runtime.signIn && auth.canSignIn ? { canSignIn: true } : {}),
        ...(auth.credential ? { credential: auth.credential } : {})
      },
      compatibility: shown?.compatibility ?? compatibilityOf(driver, undefined),
      ...(update ? { update } : {}),
      ...(shown?.binary ? { binary: shown.binary } : {}),
      caps: driver.caps(config, shown?.binary?.version, this.currentFacts(instanceId)),
      ...(limits ? { permissionLimits: limits } : {}),
      config: this.configView(record),
      ...this.engineView(record),
      models: {
        entries: modelsWithPrefs(listed, prefs),
        source: listed.length ? (models?.live || (runtime.modelsRefreshedAt && refreshedAt) ? 'live' : 'cached') : prefs.custom.length ? 'manifest' : 'none',
        canAddCustom: driver.customModels,
        ...(refreshedAt ? { refreshedAt } : {}),
        ...(models?.error ? { error: models.error } : {})
      },
      ...(latest ? { checkedAt: latest.checkedAt } : {}),
      stale,
      ...(state?.lastGood ? { lastGoodAt: state.lastGood.checkedAt } : {}),
      ...(nextStep ? { nextStep } : {}),
      ...(settingsNotice ? { settingsNotice } : {})
    }
  }

  /**
   * Variables stored on an instance with its own home that its processes no longer get (they say
   * where the sign-in lives or pick a credential), so the editor's list does not mislead.
   */
  private droppedEnvNote(record: InstanceRecord): string | undefined {
    if (!record.env.home || !record.config.env) return undefined
    const names = Object.keys(record.config.env).filter((name) => reservedEnvName(record.driver.kind, name))
    return names.length
      ? `Not used: ${names.join(', ')}. This entry signs in to its own account, so Mousse does not pass these variables to it; remove them, or add an entry on your own setup to run with a key.`
      : undefined
  }

  /**
   * "Same account as <name>." when another enabled instance of the driver is signed in to the same
   * account (a second sign-in that picked the account the first one has). Undefined otherwise.
   */
  private sameAccountNote(record: InstanceRecord): string | undefined {
    const mine = this.probes.get(record.instanceId)?.fingerprint
    if (!mine) return undefined
    const names: string[] = []
    for (const [otherId, entry] of Object.entries(this.instanceMap.list())) {
      if (otherId === record.instanceId || entry.driver !== record.driver.kind || !entry.enabled) continue
      const other = this.records.get(otherId)
      if (other && this.probes.get(otherId)?.fingerprint === mine) names.push(this.displayName(other))
    }
    return names.length ? `Same account as ${names.join(' and ')}.` : undefined
  }

  /**
   * The update on offer for an instance: from the last good check and the newest version known
   * now, so a version learned later shows without another probe.
   */
  private updateFor(record: InstanceRecord): UpdateAffordance | undefined {
    const good = this.probes.get(record.instanceId)?.lastGood
    if (!good) return undefined
    const latest = record.runtime.pinned ? record.runtime.pinned().version : this.latest.get(record.driver.latestVersion)
    return updateAffordance(record.driver, good.binary, good.compatibility, latest)
  }

  /**
   * Looks up the newest published version of the CLIs the enabled instances run. Never awaited, never
   * on a probe or a turn; a lookup that learns something new publishes the snapshots again.
   */
  private refreshLatest(instanceIds: readonly string[]): void {
    if (this.stopped) return
    const entries = this.instanceMap.list()
    // Instances of one driver share a package: one lookup, one publish.
    const packages = new Set<string>()
    for (const instanceId of instanceIds) {
      const entry = entries[instanceId]
      const source = entry?.enabled ? this.drivers.get(entry.driver)?.latestVersion : undefined
      if (source?.kind !== 'npm' || packages.has(source.package)) continue
      packages.add(source.package)
      void this.latest.refresh(source).then((changed) => {
        if (changed && !this.stopped) this.changed(instanceId, { legacy: false })
      })
    }
  }

  /**
   * Whether Mousse owns the instance's sign-in: a private home, a Mousse-managed agent, or a pi
   * provider key Mousse stores, or a driver whose sign-in is always Mousse's (Antigravity's Google
   * session, whichever executable runs). The built-in CLIs use the user's own terminal login.
   */
  private ownsSignIn(record: InstanceRecord): boolean {
    if (record.entry.driver === 'pi' || record.driver.ownsSignIn) return true
    if (record.env.home) return true
    return Boolean(record.runtime.managed?.()) && !record.config.binaryPath
  }

  /** The engine of a driver with several (`pi`): the user's stored choice and the one in effect. */
  private engineView(record: InstanceRecord): { engine?: InstanceEngine } {
    const stored = record.entry.config
    const engine = record.driver.engine?.(record.instanceId, stored)
    if (!engine) return {}
    const setting = stored?.engine === 'rpc' || stored?.engine === 'legacy' ? stored.engine : undefined
    return { engine: { ...(setting ? { setting } : {}), effective: engine.effective, switchable: engine.switchable } }
  }

  /** The settings the editor shows, all from the instance config. */
  private configView(record: InstanceRecord): InstanceConfigView {
    const source = record.config
    return {
      ...(record.config.displayName ? { displayName: record.config.displayName } : {}),
      home: record.env.home ? 'private' : 'default',
      ...(record.env.home ? { homePath: record.env.home } : {}),
      ...(source.binaryPath ? { binaryPath: source.binaryPath } : {}),
      args: [...(source.args ?? [])],
      env: { ...(source.env ?? {}) },
      ...(record.config.loginMethod ? { loginMethod: record.config.loginMethod } : {}),
      ...(record.config.movedTo ? { movedTo: record.config.movedTo } : {}),
      ...(record.config.setup ? { setup: record.config.setup } : {}),
      ...(record.config.source?.kind === 'registry'
        ? { source: { kind: 'registry' as const, agentId: record.config.source.agentId, version: record.config.source.version, distribution: record.config.source.distribution } }
        : {})
    }
  }

  private displayName(record: InstanceRecord): string {
    if (record.config.displayName) return record.config.displayName
    if (record.entry.driver === 'pi') {
      const providerId = piProviderIdOf(record.instanceId) ?? record.instanceId
      return this.options.piDisplayName?.(providerId) ?? providerId
    }
    if (record.builtIn) return record.driver.label
    return `${record.driver.label} (${record.instanceId.slice(record.instanceId.indexOf(':') + 1)})`
  }

  // -- Mutations --------------------------------------------------------------------------------

  private async add(input: AddInstanceInput): Promise<InstanceSnapshot> {
    const driver = this.drivers.get(input.driver)
    if (!driver) return harnessFail('unsupported', `Mousse cannot add a ${input.driver} instance.`)
    const patch = input.config ?? {}
    if (patch.engine !== undefined) return harnessFail('unsupported', `${driver.label} takes its engine under Advanced once added.`)
    const entries = this.instanceMap.list()
    const hasOne = Object.values(entries).some((entry) => entry.driver === driver.kind)
    if (hasOne && !driver.multiInstance) return harnessFail('unsupported', `${driver.label} supports one instance in this version.`)
    // The first instance of an agent runs on the user's own setup (their CLI and its sign-in), under
    // the driver's usual id; further ones are other accounts with private homes.
    const ownSetup = defaultInstanceId(driver.kind)
    // An entry that must have a home of its own (a managed Codex) is never the user's own setup,
    // and does not count as one.
    const rule = privateHomeRule(driver, driver.decodeConfig(patch as Record<string, unknown>))
    const hasOwnSetup = Object.values(entries).some((entry) => entry.driver === driver.kind && privateHomeRule(driver, driver.decodeConfig(entry.config)) !== 'required')
    // A driver whose home depends on the setup has one entry on the user's own setup at most.
    if (driver.privateHomeFor && rule === 'forbidden' && hasOwnSetup)
      return harnessFail('unsupported', `${driver.label} on your own setup is already added. Add one Mousse manages for another account.`)
    const useOwnSetup = rule !== 'required' && ownSetup !== undefined && !hasOwnSetup && !Object.prototype.hasOwnProperty.call(entries, ownSetup)
    let instanceId = useOwnSetup ? ownSetup : ''
    if (!useOwnSetup) {
      // An id whose state directory is still on disk (a removal that could not delete it) is taken.
      const taken = new Set(Object.keys(entries))
      instanceId = addedInstanceId(driver.kind, patch.displayName ?? undefined, taken)
      while (existsSync(instanceStateDir(this.options.profileHome, instanceId))) {
        taken.add(instanceId)
        instanceId = addedInstanceId(driver.kind, patch.displayName ?? undefined, taken)
      }
    }
    const config = useOwnSetup
      ? this.applyConfigPatch({}, {
          ...(patch.displayName ? { displayName: patch.displayName } : {}),
          ...(patch.setup ? { setup: patch.setup } : {}),
          ...(patch.binaryPath ? { binaryPath: patch.binaryPath } : {}),
          ...(patch.args?.length ? { args: patch.args } : {}),
          ...(patch.env && Object.keys(patch.env).length ? { env: patch.env } : {})
        }, driver)
      : this.applyConfigPatch({ home: driver.privateHome && rule !== 'forbidden' ? 'private' : 'default' }, patch, driver)
    const entry: ProviderInstanceConfig = { driver: driver.kind, enabled: true, config }
    // An instance with a vendor mirror starts signed in, takes the launch settings its vendor file
    // still holds (a re-added built-in keeps them, as the seed does) unless the add set them, and
    // records the vendor tuple it found in the same write (the marker). When the file cannot be read
    // now, no marker is written, and the first start that reads it copies the same values.
    const record = driver.mirrorsVendorFile ? this.build(instanceId, entry) : undefined
    const mirror = record?.runtime.vendorMirror
    const vendor = mirror?.read()
    if (mirror) {
      if (vendor && vendor !== 'unreadable') {
        const copied = tupleConfig(vendor, mirror.fields)
        for (const field of unsetFields(config, mirror.fields)) if (field !== 'signedOut') config[field] = copied[field]
        config[MIRROR_MARKER_KEY] = mirrorHash(vendor)
      }
      config.signedOutInMousse = false
    }
    try {
      this.instanceMap.setEntry(instanceId, entry)
    } catch (error) {
      if (record) {
        this.records.delete(instanceId)
        void Promise.resolve(record.runtime.stop()).catch(() => {})
      }
      throw error
    }
    if (record) this.noteStored(record, config)
    // The vendor file holds other values than the new entry's (its sign-out, or launch settings the add set): mirror them.
    if (record && mirror && vendor && vendor !== 'unreadable' && mirrorHash(instanceTuple(config, mirror.fields)) !== mirrorHash(vendor)) {
      const failure = this.mirrorWrite(record, config)
      if (failure) console.warn('[harness] could not mirror a new instance to its settings file', { instanceId, error: errorText(failure) })
    }
    mkdirSync(instanceStateDir(this.options.profileHome, instanceId), { recursive: true, mode: 0o700 })
    this.changed(instanceId)
    void this.probe(instanceId, true, { handshake: true })
    return this.snapshot(instanceId, { kind: 'device' })
  }

  private async remove(instanceId: string): Promise<void> {
    // Every provider is an entry like any other: removing deletes it. The user's own CLI and its
    // sign-in are never touched, and Add provider adds it back.
    const record = this.record(instanceId, { allowDisabled: true })
    const state = this.probes.get(instanceId)
    // Sign-ins Mousse keeps in the instance's folder go first, with what used them stopped and
    // their tokens revoked; the folder is deleted only after that. When it fails the entry stays,
    // so removing it again retries.
    if (record.runtime.deleteCredentials) {
      try {
        await record.runtime.deleteCredentials()
      } catch (error) {
        harnessFail('operation_busy', `${this.displayName(record)} could not be removed: ${errorText(error)} Try removing it again.`, instanceId)
      }
    }
    // Shared installs stop counting this entry as a user; their files stay unless deleted.
    try {
      await record.runtime.release?.()
    } catch (error) {
      console.warn('[harness] could not release an install', { instanceId, error: errorText(error) })
    }
    this.records.delete(instanceId)
    this.instanceMap.removeEntry(instanceId)
    this.prefs.remove(instanceId)
    this.scopes.forgetInstance(instanceId)
    this.counters.forget(instanceId)
    this.facts.forget(instanceId)
    this.probes.delete(instanceId)
    // The state directory is Mousse's own (its settings and saved sessions) and goes with the
    // instance, once every runtime, check and operation still using it ends. A private home and
    // the sign-in in it stay (`removeStateDir`): signing out is what removes them.
    const removal: Removal = { dir: instanceStateDir(this.options.profileHome, instanceId), pending: 0 }
    this.removals.set(instanceId, removal)
    for (const operation of this.operations.values())
      if (operation.started.instanceId === instanceId) operation.cancel()
    const checks = [state?.probing, state?.accountCheck].flatMap((running) => {
      if (!running) return []
      removal.pending += 1
      return [running.catch(() => {}).finally(() => {
        removal.pending -= 1
        this.deleteRemoved()
      })]
    })
    // Chats running on it stop (on this runtime and on any older one still finishing turns); the
    // directory waits for them to end.
    void this.stopTurns(instanceId, record, 'removed').catch((error) => this.warnStop(record, error))
    this.retire(record)
    this.emitSnapshots({ kind: 'device' })
    this.options.onProvidersChanged?.()
    // Checks end within their deadlines; stopped turns end as their runtime stops.
    await Promise.all(checks)
  }

  private async configure(instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    // An install in progress binds the entry to the source it installs when it ends.
    if (patch.source !== undefined && [...this.operations.values()].some((entry) => entry.started.instanceId === instanceId && entry.started.kind !== 'sign_in'))
      harnessFail('operation_busy', `${this.displayName(record)} is being installed. Wait for it to finish, then change its version.`, instanceId)
    if (record.builtIn && patch.home === 'private')
      harnessFail('unsupported', `The built-in ${record.driver.label} runs as you set it up. Add another instance for a separate home.`, instanceId)
    if (patch.setup !== undefined && (!record.driver.privateHomeFor || patch.setup !== (record.config.setup ?? 'existing')))
      harnessFail('unsupported', `${this.displayName(record)} keeps the setup it was added with. Add another entry for the other one.`, instanceId)
    // A runtime pinned to Mousse's own install runs exactly that: no executable, arguments or variables of the user's.
    if (record.runtime.pinned && (patch.binaryPath !== undefined || patch.args !== undefined || patch.env !== undefined))
      harnessFail('unsupported', `${this.displayName(record)} runs the Codex Mousse installed for it, with its own settings.`, instanceId)
    const homeRule = privateHomeRule(record.driver, record.config)
    if (patch.home === 'private' && homeRule === 'forbidden')
      harnessFail('unsupported', `${this.displayName(record)} cannot use a separate home.`, instanceId)
    if (patch.home === 'default' && homeRule === 'required')
      harnessFail('unsupported', `${this.displayName(record)} always runs in a home of its own.`, instanceId)
    // Only a provider that can run on Pi's agent switches engines (Advanced → Engine).
    if (patch.engine !== undefined && !record.driver.engine?.(instanceId, record.entry.config ?? {}).switchable)
      harnessFail('unsupported', `${this.displayName(record)} runs on one engine only.`, instanceId)
    if (patch.useOlderSettings) return this.useOlderSettings(record)
    const launch: CliProviderConfigPatch = {
      ...(patch.binaryPath !== undefined ? { binaryPath: patch.binaryPath } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {})
    }
    // An executable that cannot run, or args the runtime cannot pass: nothing is saved.
    if (Object.keys(launch).length && record.runtime.validateLaunch) {
      try {
        record.runtime.validateLaunch(launch)
      } catch (error) {
        harnessFail('override_not_found', errorText(error), instanceId)
      }
    }
    // The three-step write: the instance first, then its vendor mirror, then the marker. A write
    // that stops between them is finished at the next start (`reconcileRow`).
    const config = this.applyConfigPatch(record.entry.config ?? {}, patch, record.driver)
    // A change that leaves the mirrored values as they were, on an instance in step with its vendor
    // file (a new name, a sign-in method), has nothing to mirror, whatever state that file is in.
    const fields = record.runtime.vendorMirror?.fields ?? []
    const mirrored = mirrorHash(instanceTuple(config, fields))
    const unchanged = mirrored === mirrorHash(instanceTuple(record.entry.config, fields)) && storedMarker(config) === mirrored
    this.storeConfig(record, config)
    this.settingsNotices.delete(instanceId)
    // A new name changes nothing a turn runs with: the runtime and its sessions stay.
    const runChanged = Object.keys(patch).some((key) => key !== 'displayName')
    if (runChanged) {
      this.counters.bumpConfig(instanceId)
      if (Object.keys(launch).length) record.runtime.launchChanged?.()
    }
    const failure = unchanged ? undefined : this.mirrorWrite(record, config)
    if (runChanged) void this.probe(instanceId, true)
    this.changed(instanceId)
    if (failure)
      harnessFail('protocol', `Saved, but ${this.displayName(record)}'s own settings file was not updated: ${errorText(failure)} Older Mousse versions keep the previous settings until it is.`, instanceId)
    return this.snapshot(instanceId, { kind: 'device' })
  }

  /**
   * "Use the older settings": the vendor file's values (an older Mousse changed them) replace the
   * instance's, and the marker records them. The vendor file is not written.
   */
  private useOlderSettings(record: InstanceRecord): InstanceSnapshot {
    const { instanceId } = record
    const mirror = record.runtime.vendorMirror
    if (!mirror) return harnessFail('unsupported', `${this.displayName(record)} has no older settings to use.`, instanceId)
    const vendor = mirror.read()
    if (vendor === 'unreadable') return harnessFail('protocol', `${this.displayName(record)}'s own settings file cannot be read.`, instanceId)
    const stored = record.entry.config ?? {}
    const before = instanceTuple(stored, mirror.fields)
    this.storeConfig(record, { ...stored, ...tupleConfig(vendor, mirror.fields), [MIRROR_MARKER_KEY]: mirrorHash(vendor) })
    this.settingsNotices.delete(instanceId)
    this.appliedVendorTuple(record, before, vendor)
    void this.probe(instanceId, true)
    this.changed(instanceId)
    return this.snapshot(instanceId, { kind: 'device' })
  }

  /** The instance took the vendor file's tuple: what runs and, when the sign-out moved, the account move on. */
  private appliedVendorTuple(record: InstanceRecord, before: MirrorTuple, vendor: MirrorTuple): void {
    const fields = record.runtime.vendorMirror?.fields ?? []
    const changed = changedFields(before, vendor, fields)
    if (!changed.length) return
    this.counters.bumpConfig(record.instanceId)
    if (changed.some((field) => field !== 'signedOut')) record.runtime.launchChanged?.()
    if (changed.includes('signedOut')) this.counters.bumpAccount(record.instanceId)
  }

  // -- Instance config and its vendor mirror ------------------------------------------------------

  /** Whether the instance is signed out in Mousse (its config's flag). */
  signedOutInMousse(instanceId: string): boolean {
    const record = this.records.get(instanceId) ?? this.recordOrUndefined(instanceId)
    return record ? this.isSignedOut(record) : false
  }

  /** The instance's launch settings, from its config: what its vendor service starts with. */
  launchFor(instanceId: string): StoredCliConfig {
    const config = (this.records.get(instanceId) ?? this.recordOrUndefined(instanceId))?.config
    if (!config) return {}
    return {
      ...(config.binaryPath ? { binaryPath: config.binaryPath } : {}),
      ...(config.args?.length ? { args: [...config.args] } : {}),
      ...(config.env && Object.keys(config.env).length ? { env: { ...config.env } } : {})
    }
  }

  private isSignedOut(record: InstanceRecord): boolean {
    return record.config.signedOutInMousse === true
  }

  /** What the card shows for an instance signed out in Mousse. */
  private signedOutReading(record: InstanceRecord): AuthReading {
    const methodLabel = record.driver.methodLabel
    return {
      state: 'signed_out',
      ...(methodLabel ? { methodLabel } : {}),
      message: this.ownsSignIn(record) ? 'Signed out in Mousse.' : `Signed out in Mousse. Your ${record.driver.label} sign-in on this computer is unchanged.`
    }
  }

  /** Dispatch on an instance signed out in Mousse is refused before anything starts. */
  private refuseSignedOut(record: InstanceRecord): void {
    if (this.isSignedOut(record))
      harnessFail('signed_out', `${this.displayName(record)} is signed out in Mousse. Sign in again in Settings → Providers.`, record.instanceId)
  }

  /** Stores the instance's config (one write) and keeps the record's copy in step with it. */
  private storeConfig(record: InstanceRecord, config: Record<string, unknown>): void {
    const entry = { ...(this.instanceMap.list()[record.instanceId] ?? record.entry), config }
    this.instanceMap.setEntry(record.instanceId, entry)
    this.noteStored(record, config, entry.enabled)
  }

  private noteStored(record: InstanceRecord, config: Record<string, unknown>, enabled = record.entry.enabled): void {
    record.entry = { ...record.entry, enabled, config }
    record.config = record.driver.decodeConfig(config, record.instanceId)
    // A newer runtime of the instance reads the same config.
    const current = this.records.get(record.instanceId)
    if (current && current !== record) {
      current.entry = { ...current.entry, enabled, config }
      current.config = current.driver.decodeConfig(config, current.instanceId)
    }
  }

  /** The instance's stored config now (a sign-in may have saved a launch setting meanwhile). */
  private storedConfig(record: InstanceRecord): Record<string, unknown> {
    return { ...(this.instanceMap.list()[record.instanceId]?.config ?? record.entry.config ?? {}) }
  }

  /**
   * Steps 2 and 3 of a change: the vendor mirror gets the instance's tuple, then the marker records
   * it. Returns the failure of step 2 (the vendor file cannot be saved): the marker then stays, and
   * the next start finishes the write. Nothing to do for an instance without a mirror, or when both
   * sides already hold the tuple.
   */
  private mirrorWrite(record: InstanceRecord, config: Record<string, unknown>): unknown {
    const mirror = record.runtime.vendorMirror
    if (!mirror) return undefined
    const tuple = instanceTuple(config, mirror.fields)
    const hash = mirrorHash(tuple)
    const vendor = mirror.read()
    if (storedMarker(config) === hash && vendor !== 'unreadable' && mirrorHash(vendor) === hash) return undefined
    try {
      mirror.write(tuple)
    } catch (error) {
      return error
    }
    try {
      this.storeConfig(record, { ...config, [MIRROR_MARKER_KEY]: hash })
    } catch (error) {
      // Both sides hold the tuple; the next start records the marker (in sync).
      console.warn('[harness] could not record a mirrored write', { instanceId: record.instanceId, error: errorText(error) })
    }
    return undefined
  }

  /**
   * Steps 2 and 3 for a sign-out or reconnect. While a conflict with an older version's settings
   * is open, only the flag goes to the vendor file and the marker stays: the older values survive
   * for "Use the older settings", and the next start still reports the conflict.
   */
  private mirrorSignOut(record: InstanceRecord, config: Record<string, unknown>): unknown {
    const mirror = record.runtime.vendorMirror
    if (!mirror || this.settingsNotices.get(record.instanceId)?.kind !== 'older_conflict') return this.mirrorWrite(record, config)
    if (!mirror.fields.includes('signedOut')) return undefined
    const vendor = mirror.read()
    if (vendor === 'unreadable') return new Error("The provider's own settings file cannot be read.")
    const { signedOut: _previous, ...launch } = vendor
    try {
      mirror.write({ ...launch, ...(config.signedOutInMousse === true ? { signedOut: true as const } : {}) })
    } catch (error) {
      return error
    }
    return undefined
  }

  /** Sets or clears the instance's sign-out flag with the three-step write. */
  private setSignedOut(record: InstanceRecord, signedOut: boolean): unknown {
    const config = { ...this.storedConfig(record), signedOutInMousse: signedOut }
    this.storeConfig(record, config)
    return this.mirrorSignOut(record, config)
  }

  /**
   * Signs an instance signed out in Mousse in again: the flag clears (and its mirror), and its
   * account moves on so nothing bound before the sign-out resumes.
   */
  private async reconnect(record: InstanceRecord): Promise<void> {
    const failure = this.setSignedOut(record, false)
    this.counters.bumpAccount(record.instanceId)
    if (failure) console.warn('[harness] could not mirror a sign-in to the settings file', { instanceId: record.instanceId, error: errorText(failure) })
    this.options.onProvidersChanged?.()
  }

  /**
   * At start, before any probe: every instance with a vendor mirror is brought in step with it
   * (`reconcileRow`). An unreadable vendor file is left alone (its card shows the error); an
   * unreadable instance map skips everything until the next start.
   */
  private reconcileVendorMirrors(): void {
    let entries: Record<string, ProviderInstanceConfig>
    try {
      entries = this.instanceMap.list()
    } catch {
      return
    }
    if (this.instanceMap.storeError()) return
    for (const [instanceId, entry] of Object.entries(entries)) {
      if (!this.drivers.get(entry.driver)?.mirrorsVendorFile) continue
      try {
        this.reconcile(this.record(instanceId, { allowDisabled: true }))
      } catch (error) {
        console.warn('[harness] could not reconcile an instance with its settings file', { instanceId, error: errorText(error) })
      }
    }
  }

  private reconcile(record: InstanceRecord): void {
    const mirror = record.runtime.vendorMirror
    if (!mirror) return
    const vendor = mirror.read()
    if (vendor === 'unreadable') return
    const { fields } = mirror
    const vendorHash = mirrorHash(vendor)
    let stored = { ...(record.entry.config ?? {}) }
    const marker = storedMarker(stored)
    let instance = instanceTuple(stored, fields)
    let row = reconcileRow(mirrorHash(instance), vendorHash, marker)
    // A vendor file deleted since the last write (the settings error says "fix or remove the file")
    // is no older version's change: the instance's values are written back, with no notice.
    if (marker !== undefined && mirror.exists?.() === false) row = mirrorHash(instance) === vendorHash ? 'in_sync' : 'finish_write'
    if (row === 'first_copy') {
      // Only what the instance never set comes over; the vendor file is not changed by the copy.
      const copied = tupleConfig(vendor, fields)
      for (const field of unsetFields(stored, fields)) {
        const key = field === 'signedOut' ? 'signedOutInMousse' : field
        stored[key] = copied[key]
      }
      stored = { ...stored, [MIRROR_MARKER_KEY]: vendorHash }
      this.storeConfig(record, stored)
      instance = instanceTuple(stored, fields)
      row = mirrorHash(instance) === vendorHash ? 'in_sync' : 'finish_write'
    }
    switch (row) {
      case 'in_sync':
        if (storedMarker(stored) !== vendorHash) this.storeConfig(record, { ...stored, [MIRROR_MARKER_KEY]: vendorHash })
        return
      case 'finish_write': {
        const failure = this.mirrorWrite(record, stored)
        if (failure) console.warn('[harness] could not finish writing a settings file', { instanceId: record.instanceId, error: errorText(failure) })
        return
      }
      case 'older_changed': {
        const changed = changedFields(instance, vendor, fields)
        this.storeConfig(record, { ...stored, ...tupleConfig(vendor, fields), [MIRROR_MARKER_KEY]: vendorHash })
        this.appliedVendorTuple(record, instance, vendor)
        this.settingsNotices.set(record.instanceId, {
          kind: 'older_applied',
          message: `Settings changed in an older Mousse version were applied: ${fieldLabels(changed)}.`
        })
        return
      }
      case 'conflict':
        this.settingsNotices.set(record.instanceId, {
          kind: 'older_conflict',
          message: "An older Mousse version changed this provider's settings. Mousse is using this version's."
        })
        return
    }
  }

  /** The stored `config` of an added instance after a patch (unknown fields kept). */
  private applyConfigPatch(stored: Record<string, unknown>, patch: InstanceConfigPatch, driver: HarnessDriver): Record<string, unknown> {
    const config: Record<string, unknown> = { ...stored }
    if (patch.displayName !== undefined) setOrDelete(config, 'displayName', patch.displayName?.trim() || undefined)
    if (patch.home !== undefined) config.home = patch.home
    if (patch.setup !== undefined) config.setup = patch.setup
    // A cleared launch setting is stored as `null` ("set to the default"), never deleted, so it is
    // told apart from one never set (`harness/vendorMirror`).
    if (patch.binaryPath !== undefined) config.binaryPath = patch.binaryPath?.trim() || null
    if (patch.args !== undefined) config.args = patch.args.length ? [...patch.args] : null
    if (patch.env !== undefined) config.env = Object.keys(patch.env).length ? { ...patch.env } : null
    if (patch.loginMethod !== undefined) setOrDelete(config, 'loginMethod', patch.loginMethod || undefined)
    if (patch.engine !== undefined) setOrDelete(config, 'engine', patch.engine ?? undefined)
    if (patch.source !== undefined) {
      // Only a driver that reads registry sources takes one (it validates every value itself).
      if (driver.decodeConfig({ source: patch.source }).source?.kind !== 'registry')
        harnessFail('unsupported', `${driver.label} cannot install agents from the ACP registry.`)
      config.source = { ...patch.source }
      delete config.binaryPath
    }
    // The home follows the driver's rule for the patched config: required, allowed or forbidden.
    const rule = privateHomeRule(driver, driver.decodeConfig({ ...config, home: undefined }))
    if (rule === 'required') config.home = 'private'
    else if (rule === 'forbidden' && config.home !== undefined) config.home = 'default'
    // An instance with its own home runs as the account signed in there: its configured variables
    // cannot point it at another home or hand it another credential (`ownedLaunchEnv`).
    if (config.home === 'private' && (patch.env !== undefined || patch.home !== undefined)) {
      for (const name of Object.keys((config.env ?? {}) as Record<string, unknown>)) {
        const reserved = reservedEnvName(driver.kind, name)
        if (reserved?.kind === 'home')
          harnessFail('unsupported', `Mousse sets ${reserved.variable} for this ${driver.label} instance, so it cannot be set here. Remove it from the variables.`)
        if (reserved)
          harnessFail('unsupported', `${reserved.variable} is not passed to a ${driver.label} instance with its own home: it signs in to its own account. Remove it from the variables.`)
      }
    }
    return config
  }

  private async move(fromId: string, toId: string, options: { copyKey?: boolean } = {}): Promise<MoveResult> {
    const from = this.record(fromId, { allowDisabled: true })
    const to = this.record(toId, { allowDisabled: true })
    const agent = (this.options.foldedInto ?? foldedInto)(piProviderIdOf(fromId))
    if (fromId === toId || !agent || to.driver.kind !== agent)
      harnessFail('unsupported', `${this.displayName(from)} cannot move to ${this.displayName(to)}.`, fromId)
    if (from.config.movedTo) harnessFail('unsupported', `${this.displayName(from)} has already moved.`, fromId)
    // Two moves of one entry (the card's dialog and a chat's, or two windows) never run together:
    // the second would split the defaults and the pinned chats across two targets.
    if (this.moving.has(fromId)) harnessFail('unsupported', `${this.displayName(from)} is already being moved.`, fromId)
    this.moving.add(fromId)
    try {
      return await this.moveEntry(from, to, options)
    } finally {
      this.moving.delete(fromId)
    }
  }

  private async moveEntry(from: InstanceRecord, to: InstanceRecord, options: { copyKey?: boolean }): Promise<MoveResult> {
    const fromId = from.instanceId
    const toId = to.instanceId
    // An entry whose old route is going away moves only onto a route that works now (nothing is
    // copied: the new route has its own sign-in), and its old sign-in goes last, after the move is saved.
    const retiring = movePromptOf(piProviderIdOf(fromId)) !== undefined
    if (retiring) {
      if (!to.entry.enabled) harnessFail('unsupported', `Turn on ${this.displayName(to)} first, then move ${this.displayName(from)} to it. Nothing moved.`, toId)
      await this.probe(toId, true)
      // Installed and signed in: a chat on it can run now.
      if (!to.runtime.configured())
        harnessFail('signed_out', `Install and sign in to ${this.displayName(to)} first, then move ${this.displayName(from)} to it. Nothing moved.`, toId)
    }
    // The key goes over first: when it cannot, nothing has moved yet.
    if (options.copyKey) {
      const key = await from.runtime.exportApiKey?.()
      if (!key) harnessFail('unsupported', `${this.displayName(from)} has no saved API key to copy.`, fromId)
      if (!to.runtime.adoptApiKey) harnessFail('unsupported', `${this.displayName(to)} cannot take an API key.`, toId)
      await to.runtime.adoptApiKey(key)
      this.counters.bumpAccount(toId)
      void this.probe(toId, true)
    }
    // Turned off, never deleted: an older build can still turn it back on. A save that fails throws
    // here, before anything else changed: the old sign-in is still there and the entry still works.
    this.instanceMap.setEntry(fromId, { ...from.entry, enabled: false, config: { ...(from.entry.config ?? {}), movedTo: toId } })
    const llmProvider = legacyProviderForInstance(toId, to.entry) ?? ''
    // A model the agent lists keeps its id; any other becomes the agent's default (its first model).
    const listed = to.runtime.models()
    const model = (id: string) => (!listed.length || listed.some((entry) => entry.id === id) ? id : listed[0]!.id)
    const rewritten = [
      ...this.options.defaults?.rewrite(fromId, { instanceId: toId, llmProvider, model }) ?? [],
      ...this.scopes.moveDefaults(fromId, toId, model).map(({ projectId, from: before, to: after }) =>
        `Project default (${projectId})${before !== after ? `: ${this.modelName(toId, after)} instead of ${before}` : ''}`)
    ]
    const oldSignIn = retiring ? await this.dropOldSignIn(from) : undefined
    this.changed(fromId)
    return { from: fromId, to: toId, rewritten, ...(oldSignIn ? { oldSignIn } : {}) }
  }

  /**
   * Deletes the old sign-in of a moved entry, after the move is saved. The sign-in belongs to the
   * whole device, so it stays while another profile still has an unmoved entry using it. A deletion
   * that fails leaves the move standing and a stale credential nobody uses.
   */
  private async dropOldSignIn(from: InstanceRecord): Promise<NonNullable<MoveResult['oldSignIn']>> {
    if (this.options.otherProfilesUse?.(from.instanceId)) return 'kept_shared'
    try {
      if (!from.runtime.signOut) return 'remains'
      await from.runtime.signOut()
      this.counters.bumpAccount(from.instanceId)
      this.options.onProvidersChanged?.()
      return 'removed'
    } catch (error) {
      console.warn('[harness] the old sign-in of a moved entry could not be deleted', { instanceId: from.instanceId, message: errorText(error) })
      return 'remains'
    }
  }

  private async setEnabled(instanceId: string, scope: ProviderScope, enabled: boolean | null): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (scope.kind === 'device') {
      if (enabled === null) harnessFail('unsupported', 'The device setting takes on or off.', instanceId)
      this.instanceMap.setEntry(instanceId, { ...record.entry, enabled })
      if (enabled) {
        // Attempts a turn off cancelled stay cancelled; new ones wait for its stops to drain (`admitTurn`).
        delete record.stopped
        void this.probe(instanceId, false)
      } else void this.stopTurns(instanceId, record, 'disabled').catch((error) => this.warnStop(record, error))
    } else this.scopes.setEnabled(scope.projectId, instanceId, enabled)
    this.changed(instanceId, { scope })
    return this.snapshot(instanceId, scope)
  }

  private async signOut(instanceId: string): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (!record.runtime.signOut) harnessFail('unsupported', 'This provider has no sign-out.', instanceId)
    // 1. The flag first: from here on nothing is admitted on the instance (fail closed).
    const config = { ...this.storedConfig(record), signedOutInMousse: true }
    this.storeConfig(record, config)
    // 2. The runtime's own sign-out (stop turns, drop sessions, revoke what Mousse holds), then the
    // vendor mirror, even when the runtime's sign-out failed: the flag stays and is mirrored.
    let failure: unknown
    try {
      await record.runtime.signOut()
    } catch (error) {
      failure = error
    }
    // Read again: a change saved while the runtime signed out (a configure, an install dropping a
    // manual path) is kept, and goes to the runtime that serves the instance now.
    const current = this.recordOrUndefined(instanceId)
    const mirrorFailure = current ? this.mirrorSignOut(current, { ...this.storedConfig(current), signedOutInMousse: true }) : undefined
    if (mirrorFailure) console.warn('[harness] could not mirror a sign-out to the settings file', { instanceId, error: errorText(mirrorFailure) })
    // 3. Nothing bound before the sign-out resumes, and the card reads signed out.
    this.counters.bumpAccount(instanceId)
    await this.probe(instanceId, true)
    this.options.onProvidersChanged?.()
    if (failure) throw failure
    return this.snapshot(instanceId, { kind: 'device' })
  }

  private async refreshModels(instanceId: string): Promise<InstanceSnapshot> {
    this.record(instanceId, { allowDisabled: true })
    await this.refreshModelsOf(instanceId)
    return this.snapshot(instanceId, { kind: 'device' })
  }

  /**
   * Refreshes every enabled instance's models, two at a time. Pi providers share one catalog
   * refresh, so it runs once and its outcome counts for each of them.
   */
  private async refreshAllModels(): Promise<ModelRefreshResult[]> {
    const entries = Object.entries(this.instanceMap.list()).filter(([, entry]) => entry.enabled)
    let pi: Promise<void> | undefined
    return Promise.all(entries.map(async ([instanceId, entry]): Promise<ModelRefreshResult> => {
      const result = (outcome: ModelRefreshResult['outcome'], message?: string): ModelRefreshResult =>
        ({ instanceId, outcome, ...(message ? { message } : {}), snapshot: this.snapshot(instanceId, { kind: 'device' }) })
      try {
        if (entry.driver === 'pi') {
          pi ??= this.refreshModelsOf(instanceId)
          await pi
        } else {
          if (!this.probes.get(instanceId)?.result) await this.probe(instanceId, false)
          const reason = this.modelRefreshSkip(instanceId)
          if (reason) return result('skipped', reason)
          await this.refreshModelsOf(instanceId)
        }
        const error = this.probes.get(instanceId)?.models?.error
        return error ? result('failed', error) : result('refreshed')
      } catch (error) {
        return result('failed', errorText(error))
      }
    }))
  }

  /**
   * Why an instance's models are left alone now, or undefined when they may be refreshed. Used by
   * the schedule and by "Refresh models" for all: a refresh starts a short-lived CLI or agent
   * session, which must not meet a running chat, an install, or a sign-in that is not there.
   */
  private modelRefreshSkip(instanceId: string): string | undefined {
    const entry = this.instanceMap.list()[instanceId]
    if (!entry?.enabled) return 'Turned off'
    const record = this.recordOrUndefined(instanceId)
    if (!record || record.stopped) return 'Turned off'
    const auth = this.probes.get(instanceId)?.lastGood?.auth.state
    if (auth !== 'signed_in' && auth !== 'not_required') return 'Not signed in'
    if (record.active > 0) return 'A chat is running'
    const installing = record.runtime.installState?.().installing === true || [...this.operations.values()].some((operation) => operation.started.instanceId === instanceId && operation.started.kind !== 'sign_in')
    if (installing) return 'Being installed'
    return undefined
  }

  /**
   * One refresh of an instance's list, queued behind the others (`MODEL_REFRESH_CONCURRENCY` run
   * at once). A refresh that fails is recorded on the instance, never thrown. When `when` is set,
   * the instance is checked again once its turn comes and is left alone if it no longer qualifies.
   */
  private refreshModelsOf(instanceId: string, when?: { minAgeMs: number; reason: 'schedule' | 'upgrade' }): Promise<void> {
    const running = this.modelRefreshes.get(instanceId)
    if (running) return running
    const job = this.withModelSlot(async () => {
      if (this.stopped) return
      const record = this.recordOrUndefined(instanceId)
      if (!record) return
      if (when) {
        if (!this.probes.get(instanceId)?.result) await this.probe(instanceId, false)
        if (this.stopped || this.modelRefreshSkip(instanceId) || this.modelsAgeMs(record) < when.minAgeMs) return
      }
      const state = this.probeState(instanceId)
      try {
        await record.runtime.refreshModels?.(this.cwd())
        const stamped = record.runtime.modelsRefreshedAt?.()
        // A runtime that keeps its own stamp says when it listed (nothing listed, nothing stamped).
        state.models = record.runtime.modelsRefreshedAt
          ? { ...(stamped ? { live: true, refreshedAt: stamped } : {}) }
          : { live: true, refreshedAt: new Date(this.now()).toISOString() }
        this.captureFacts(record)
      } catch (error) {
        state.models = { ...state.models, error: errorText(error) }
      }
      if (when) console.info('[harness] model refresh', { instanceId, reason: when.reason, ...(state.models?.error ? { error: state.models.error } : { refreshedAt: state.models?.refreshedAt }) })
      if (!this.stopped) this.changed(instanceId)
    }).finally(() => {
      this.modelRefreshes.delete(instanceId)
    })
    this.modelRefreshes.set(instanceId, job)
    return job
  }

  /** How long ago the instance's list was updated; infinite when it never was (a fallback list). */
  private modelsAgeMs(record: InstanceRecord): number {
    const stamp = record.runtime.modelsRefreshedAt ? record.runtime.modelsRefreshedAt() : this.probes.get(record.instanceId)?.models?.refreshedAt
    const at = stamp ? Date.parse(stamp) : NaN
    return Number.isFinite(at) ? Math.max(0, this.now() - at) : Infinity
  }

  private async withModelSlot<T>(job: () => Promise<T>): Promise<T> {
    // A finished job hands its slot to the next one waiting, so the count stays at the limit.
    if (this.modelSlots >= MODEL_REFRESH_CONCURRENCY) await new Promise<void>((resolve) => this.modelWaiting.push(resolve))
    else this.modelSlots += 1
    try {
      return await job()
    } finally {
      const next = this.modelWaiting.shift()
      if (next) next()
      else this.modelSlots -= 1
    }
  }

  /**
   * Keeps every provider's model list fresh without anyone clicking: a pass shortly after start-up
   * for lists older than the interval, then one every `MODEL_REFRESH_INTERVAL_MS` (3 hours). A pass
   * queues each enabled, signed-in instance that has no chat running and was not refreshed in the
   * last half interval; the rest wait for the next pass. Pi providers have their own 5-minute cycle
   * (`ProviderAuthService`) and are not part of this one. The timers are unref'd and stop with the
   * gateway.
   *
   * Antigravity is part of the schedule on purpose. Its `refreshModels` starts a whole agent
   * session, which is why background health checks must never call it; the schedule is not a
   * health check, runs rarely, and only when the instance is signed in and idle, and it shares the
   * two-at-a-time limit with the others.
   */
  startModelRefreshSchedule(): void {
    if (this.stopped || this.modelSchedule) return
    const override = Number(process.env[MODEL_REFRESH_INTERVAL_ENV])
    const intervalMs = Number.isFinite(override) && override > 0 ? override : MODEL_REFRESH_INTERVAL_MS
    const pass = (minAgeMs: number) => {
      if (this.stopped) return
      for (const [instanceId, entry] of Object.entries(this.instanceMap.list())) {
        if (!entry.enabled || entry.driver === 'pi') continue
        // The first pass leaves a list younger than the interval alone; later ones also take lists
        // the previous pass refreshed just under an interval ago.
        void this.refreshModelsOf(instanceId, { minAgeMs, reason: 'schedule' }).catch((error) => console.warn('[harness] scheduled model refresh failed', { instanceId, error: errorText(error) }))
      }
    }
    const interval = setInterval(() => pass(intervalMs / 2), intervalMs)
    const startup = setTimeout(() => pass(intervalMs), Math.min(MODEL_REFRESH_STARTUP_DELAY_MS, intervalMs))
    interval.unref?.()
    startup.unref?.()
    this.modelSchedule = { interval, startup, intervalMs }
  }

  /** A probe found another program than before: list its models now, when the instance qualifies. */
  private refreshAfterUpgrade(instanceId: string): void {
    if (this.stopped || this.instanceMap.list()[instanceId]?.driver === 'pi') return
    void this.refreshModelsOf(instanceId, { minAgeMs: 0, reason: 'upgrade' }).catch((error) => console.warn('[harness] model refresh after an upgrade failed', { instanceId, error: errorText(error) }))
  }

  // -- Operations -------------------------------------------------------------------------------

  private async install(instanceId: string, kind: 'install' | 'update'): Promise<ProviderOperationStarted> {
    const record = this.record(instanceId, { allowDisabled: true })
    const runtime = record.runtime
    if (!runtime.install) return harnessFail('unsupported', `Mousse cannot install ${record.driver.label}. Install it yourself, then check again.`, instanceId)
    if ([...this.operations.values()].some((entry) => entry.started.instanceId === instanceId && entry.started.kind !== 'sign_in'))
      return harnessFail('operation_busy', `${record.driver.label} is already being installed.`, instanceId)
    const started: ProviderOperationStarted = { operationId: randomUUID(), instanceId, kind }
    const operation: Operation = { started, prompts: 0, urlPrompts: [], cancel: () => runtime.cancelInstall?.() ?? false }
    this.operations.set(started.operationId, operation)
    queueMicrotask(() => {
      void runtime.install!((progress) => {
        const fraction = progress.fraction ?? (progress.receivedBytes !== undefined && progress.totalBytes ? Math.min(1, progress.receivedBytes / progress.totalBytes) : undefined)
        operation.progress = { ...progress, ...(fraction !== undefined ? { fraction } : {}) }
        this.emit({ type: 'operation', data: { ...started, phase: 'progress', ...operation.progress } })
        this.emitSnapshots({ kind: 'device' })
      })
        .then((result) => {
          // The install binds the entry (a registry agent's install record): a new revision.
          if (result?.config && Object.prototype.hasOwnProperty.call(this.instanceMap.list(), instanceId)) {
            const entry = this.instanceMap.list()[instanceId]!
            this.instanceMap.setEntry(instanceId, { ...entry, config: { ...(entry.config ?? {}), ...result.config } })
            this.counters.bumpConfig(instanceId)
          }
          this.emit({ type: 'operation', data: { ...started, phase: 'completed' } })
        })
        .catch((error) => {
          const cancelled = /cancel/i.test(errorText(error))
          this.emit({ type: 'operation', data: cancelled ? { ...started, phase: 'cancelled' } : { ...started, phase: 'failed', error: { code: 'protocol', message: errorText(error), instanceId } } })
        })
        .finally(() => {
          this.operations.delete(started.operationId)
          this.deleteRemoved()
          void this.probe(instanceId, true, { handshake: true })
          this.options.onProvidersChanged?.()
        })
    })
    this.emitSnapshots({ kind: 'device' })
    return started
  }

  private async removeInstall(instanceId: string, options: { force: boolean }): Promise<RemoveInstallResult> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (!record.runtime.removeInstall) return harnessFail('unsupported', `${this.displayName(record)} has no files Mousse downloaded.`, instanceId)
    if ([...this.operations.values()].some((entry) => entry.started.instanceId === instanceId && entry.started.kind !== 'sign_in'))
      return harnessFail('operation_busy', `${this.displayName(record)} is being installed.`, instanceId)
    let result: RemoveInstallResult
    try {
      result = await record.runtime.removeInstall(options)
    } catch (error) {
      return harnessFail('operation_busy', errorText(error), instanceId)
    }
    if (result.removed) await this.probe(instanceId, true)
    this.changed(instanceId)
    return result
  }

  private async update(instanceId: string): Promise<ProviderOperationStarted> {
    const update = this.updateFor(this.record(instanceId, { allowDisabled: true }))
    if (update?.kind === 'one_click') return this.install(instanceId, 'update')
    if (update?.kind === 'notice')
      return harnessFail('unsupported', `Mousse cannot tell how this CLI was installed, so it cannot update it. Version ${update.latestVersion} is available.`, instanceId)
    if (update?.kind === 'advisory')
      return harnessFail('unsupported', `Mousse cannot prove who installed this CLI. Update it with: ${update.command}`, instanceId)
    return harnessFail('unsupported', 'No update is available.', instanceId)
  }

  private async signIn(instanceId: string, method?: string): Promise<ProviderOperationStarted> {
    const record = this.record(instanceId, { allowDisabled: true })
    const runtime = record.runtime
    // Signed out in Mousse on the user's own sign-in (their CLI's home): reconnecting only clears the
    // flag. No sign-in runs; when the agent itself is signed out, the card shows its command.
    const reconnecting = this.isSignedOut(record) && !this.ownsSignIn(record)
    if (!reconnecting && !runtime.signIn) return harnessFail('unsupported', 'This provider has no sign-in.', instanceId)
    if ([...this.operations.values()].some((entry) => entry.started.instanceId === instanceId && entry.started.kind === 'sign_in'))
      return harnessFail('operation_busy', 'A sign-in is already running for this provider.', instanceId)
    const started: ProviderOperationStarted = { operationId: randomUUID(), instanceId, kind: 'sign_in' }
    if (reconnecting) {
      let failure: unknown
      try {
        await this.reconnect(record)
      } catch (error) {
        failure = error
      }
      // Reported after the caller has the operation id, like any sign-in.
      queueMicrotask(() => {
        this.emit({ type: 'operation', data: failure ? { ...started, phase: 'failed', error: { code: 'protocol', message: errorText(failure), instanceId } } : { ...started, phase: 'completed' } })
        void this.probe(instanceId, true)
      })
      return started
    }
    const session = new LoginSessionImpl(started.operationId)
    const operation: Operation = {
      started,
      session,
      prompts: 0,
      urlPrompts: [],
      cancel: () => {
        session.abort.abort()
        return true
      }
    }
    this.operations.set(started.operationId, operation)
    session.on('event', (event: ProviderLoginEvent) => this.forwardLoginEvent(operation, event))
    queueMicrotask(() => {
      void runtime.signIn!(session, this.cwd(), method)
        .then((result) => {
          if (session.abort.signal.aborted) this.emit({ type: 'operation', data: { ...started, phase: 'cancelled' } })
          else if (result.success) {
            // A sign-in Mousse owns clears a sign-out only once it succeeded.
            // Through the record serving the instance now: a config change during the sign-in (a
            // new home, an executable path) built another runtime, whose mirror is the live one.
            const current = this.recordOrUndefined(instanceId) ?? record
            if (this.isSignedOut(current)) {
              const failure = this.setSignedOut(current, false)
              if (failure) console.warn('[harness] could not mirror a sign-in to the settings file', { instanceId, error: errorText(failure) })
            }
            // A completed sign-in may be another account: sessions made before it are not resumed.
            this.counters.bumpAccount(instanceId)
            // Its verification (a `session/new`) may have listed the account's models and modes.
            this.captureFacts(record)
            this.emit({ type: 'operation', data: { ...started, phase: 'completed', ...(result.warning ? { warning: result.warning } : {}) } })
          }
          else this.emit({ type: 'operation', data: { ...started, phase: 'failed', error: { code: 'signed_out', message: result.error ?? 'Sign-in failed.', instanceId } } })
        })
        .catch((error) => this.emit({ type: 'operation', data: { ...started, phase: 'failed', error: { code: 'protocol', message: errorText(error), instanceId } } }))
        .finally(() => {
          this.operations.delete(started.operationId)
          this.deleteRemoved()
          void this.probe(instanceId, true)
          this.options.onProvidersChanged?.()
        })
    })
    return started
  }

  private forwardLoginEvent(operation: Operation, event: ProviderLoginEvent): void {
    const { started } = operation
    const promptId = () => `${started.operationId}:${++operation.prompts}`
    let prompt: SignInPrompt | undefined
    switch (event.type) {
      case 'auth_url':
        prompt = {
          promptId: promptId(),
          type: 'auth_url',
          url: event.url,
          ...(event.instructions ? { instructions: event.instructions } : {}),
          usesCallbackServer: event.usesCallbackServer,
          ...(operation.manualCode ? { acceptsRedirectPaste: true } : {})
        }
        operation.urlPrompts.push(prompt.promptId)
        break
      case 'device_code':
        prompt = { promptId: promptId(), type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri, ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}) }
        break
      case 'prompt':
        prompt = { promptId: promptId(), type: 'input', secret: event.promptType === 'secret', message: event.message, ...(event.placeholder ? { placeholder: event.placeholder } : {}) }
        operation.prompt = { promptId: prompt.promptId, kind: 'prompt' }
        break
      case 'manual_code':
        prompt = { promptId: promptId(), type: 'input', secret: false, message: event.message }
        operation.manualCode = prompt.promptId
        break
      case 'select':
        prompt = { promptId: promptId(), type: 'select', message: event.message, options: event.options.map((option) => ({ id: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })) }
        operation.prompt = { promptId: prompt.promptId, kind: 'select' }
        break
      case 'progress':
        this.emit({ type: 'operation', data: { ...started, phase: 'progress', message: event.message } })
        return
      default:
        return
    }
    this.emit({ type: 'operation', data: { ...started, phase: 'prompt', prompt } })
  }

  private respondSignIn(operationId: string, response: SignInResponse): boolean {
    const operation = this.operations.get(operationId)
    const session = operation?.session
    if (!operation || !session) return false
    if (response.kind === 'cancel') {
      session.respond({ sessionId: operationId, kind: 'cancel' })
      return true
    }
    const value = response.value !== undefined ? { value: response.value } : {}
    // The pasted redirect URL or code: from its own prompt or from a browser-link prompt.
    if (response.kind === 'redirect_url' || (response.promptId !== undefined && response.promptId === operation.manualCode)) {
      const target = operation.manualCode
      if (!target || (response.promptId && response.promptId !== target && !operation.urlPrompts.includes(response.promptId))) return false
      operation.manualCode = undefined
      session.respond({ sessionId: operationId, kind: 'manual_code', ...value })
      return true
    }
    const waiting = operation.prompt
    if (!waiting || (response.promptId && response.promptId !== waiting.promptId)) return false
    operation.prompt = undefined
    session.respond({ sessionId: operationId, kind: response.kind === 'select' ? 'select' : waiting.kind, ...value })
    return true
  }

  // -- Events -----------------------------------------------------------------------------------

  private changed(instanceId: string, options: { scope?: ProviderScope; legacy?: boolean } = {}): void {
    void instanceId
    this.emitSnapshots({ kind: 'device' })
    if (options.scope?.kind === 'project') this.emitSnapshots(options.scope)
    if (options.legacy !== false) this.options.onProvidersChanged?.()
  }

  private emitSnapshots(scope: ProviderScope): void {
    if (!this.listeners.size || this.stopped) return
    const snapshots = Object.keys(this.instanceMap.list()).flatMap((instanceId) => {
      try {
        return [this.snapshot(instanceId, scope)]
      } catch {
        return []
      }
    })
    this.emit({ type: 'snapshots', data: { scope, snapshots } })
  }

  private emit(event: HarnessGatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[harness] listener failed', errorText(error))
      }
    }
  }

  private cwd(): string {
    return this.options.cwd?.() ?? this.options.profileHome
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  stop(): void {
    this.stopped = true
    if (this.modelSchedule) {
      clearInterval(this.modelSchedule.interval)
      clearTimeout(this.modelSchedule.startup)
      this.modelSchedule = undefined
    }
    for (const operation of this.operations.values()) operation.cancel()
    this.operations.clear()
    for (const record of [...this.records.values(), ...this.retired]) {
      try {
        void Promise.resolve(record.runtime.stop()).catch(() => {})
      } catch {
        /* stopping is best effort */
      }
    }
    this.records.clear()
    this.retired.clear()
    this.listeners.clear()
  }
}

/** The driver keeps every instance in a Mousse-owned home (for some configs, e.g. Pi's RPC engine). */
function alwaysPrivate(driver: HarnessDriver, config: InstanceConfig): boolean {
  return typeof driver.alwaysPrivateHome === 'function' ? driver.alwaysPrivateHome(config) : driver.alwaysPrivateHome === true
}

/** Driver, revision, home and engine: a change in any builds a new runtime (and a new epoch). */
function recordKey(driver: HarnessDriver, revision: number, config: InstanceConfig): string {
  return `${driver.kind}|${revision}|${config.home}|${config.engine ?? ''}`
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/** The gateway of a profile (or of a test) over its instance map and drivers. */
export function createHarnessGateway(options: HarnessGatewayOptions): Harness {
  return new Harness(options)
}
