import type { InstanceSnapshot, ProviderSnapshotsEvent } from '../../shared/harness/status'
import type {
  AddInstanceInput,
  BinaryFingerprint,
  CustomModel,
  ExecutionBinding,
  HarnessCaps,
  HarnessDriverKind,
  InstanceConfigPatch,
  InstanceModel,
  ModelPrefsPatch,
  ProviderOperationEvent,
  ProviderOperationStarted,
  ProviderScope,
  ProviderSelection,
  RunPolicy,
  RuntimeFacts,
  SignInResponse,
  TurnOrigin
} from '../../shared/harness/types'
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
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceConfigView, NextStep } from '../../shared/harness/status'
import { foldedInto, type MoveResult } from '../../shared/harness/move'
import { harnessAppError, type HarnessErrorCode, type ModelPrefs, type SignInPrompt } from '../../shared/harness/types'
import type { ProviderLoginEvent } from '../../shared/providerAuth'
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
import type { AuthReading, DriverRuntime, HarnessDriver, InstanceConfig, LiveProcessHost } from './driver'
import { DEFAULT_HOME_ID, findOnPath, instanceEnv, type InstanceEnv } from './env'
import { addedInstanceId, defaultInstanceId, InstanceCounterStore, instanceStateDir, isBuiltInInstance } from './instances'
import { RuntimeFactsStore } from './facts'
import { questionsPrompter } from './acp/permissions'
import { checkPolicy, purposeAllowed, toolControlLevel } from './policy'
import { HarnessScopeStore } from './scope'
import { sharedShellPath, type ShellPathResult } from './shellPath'
import { compatibilityOf, fingerprintOf, PROBE_TIMEOUTS, probeInstance, sameBinary, type ProbeResult } from './status'
import { interruptWithDeadline } from './supervise'

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
 * gateway owns retries, timeouts, capability fallbacks, scope and model prefs. Failures are thrown
 * as `harnessAppError(...)` (`shared/harness/types.ts`) so callers and the protocol see typed codes.
 */
export interface HarnessGateway {
  readonly instances: HarnessInstances
  readonly catalog: HarnessCatalog
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
   */
  bind(resolved: ResolvedTurnSelection, input: { mode: ChatMode; effort?: string; origin?: TurnOrigin }): Promise<ExecutionBinding>
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
  forkSession(ref: ProviderRef, atTurnOrdinal: number): Promise<ProviderRef | null>
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
  add(input: AddInstanceInput): Promise<InstanceSnapshot>
  /** Deletes any instance, built-in ones too; a vendor agent is not seeded again. */
  remove(instanceId: string): Promise<void>
  configure(instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot>
  /** `null` clears a project override; the device scope takes a boolean only. */
  setEnabled(instanceId: string, scope: ProviderScope, enabled: boolean | null): Promise<InstanceSnapshot>
  install(instanceId: string): Promise<ProviderOperationStarted>
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
  setModelPrefs(instanceId: string, patch: ModelPrefsPatch): Promise<InstanceSnapshot>
  /**
   * Moves a model API entry to the agent that now serves it (`FOLDED_INTO_AGENT`): the old entry is
   * turned off (never deleted) and records `movedTo`, the defaults that named it are rewritten and
   * listed, and threads pinned to it continue on the agent with their history handed over.
   */
  move(fromInstanceId: string, toInstanceId: string): Promise<MoveResult>
  /** Snapshot changes (`snapshots$`) and operation progress; returns the unsubscribe. */
  subscribe(listener: (event: HarnessGatewayEvent) => void): () => void
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
   * vision): a custom model's stated capability, else the driver's `mcpImageResults`.
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
  /** Test seam: the turn-admission account check deadline (`TURN_ACCOUNT_CHECK_MS`). */
  accountCheckMs?: number
  /**
   * The profile's own default selections (Settings), rewritten when an entry moves; returns what
   * changed, for the Move dialog. Project defaults are the gateway's own.
   */
  defaults?: { rewrite(from: string, to: { instanceId: string; llmProvider: string; model(model: string): string }): string[] }
  /** Test seam: the agent a model API moves to (`FOLDED_INTO_AGENT`). */
  foldedInto?: (providerId: string | undefined) => HarnessDriverKind | undefined
}

interface InstanceRecord {
  instanceId: string
  entry: ProviderInstanceConfig
  driver: HarnessDriver
  config: InstanceConfig
  builtIn: boolean
  /** Driver, revision and home: a change builds a new runtime. */
  key: string
  env: InstanceEnv
  runtime: DriverRuntime
  /** Turns running on this runtime; a replaced runtime stops once they end. */
  active: number
  retired?: boolean
}

interface ProbeState {
  result?: ProbeResult
  lastGood?: ProbeResult
  checkedAtMs?: number
  probing?: Promise<void>
  models?: { refreshedAt?: string; error?: string; live?: boolean }
  /** The account read running for a turn admission (resolves undefined = unknown). */
  accountCheck?: Promise<string | undefined>
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
  progress?: { message: string; fraction?: number }
  cancel(): boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The policy mode a chat mode runs under: plan, else the instance's normal permissions. */
function policyMode(mode: ChatMode): RunPolicy['mode'] {
  return mode === 'plan' ? 'plan' : 'default'
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
  readonly legacy: LegacyProviders
  readonly instanceMap: ProviderInstanceService
  private readonly drivers = new Map<HarnessDriverKind, HarnessDriver>()
  private readonly records = new Map<string, InstanceRecord>()
  private liveHost: LiveProcessHost | null = null
  private mcp: McpAttachmentProvider | null = null
  private readonly retired = new Set<InstanceRecord>()
  private readonly removals = new Map<string, Removal>()
  /** The account reading `bind` took, for the `startTurn` of that binding (once). */
  private readonly boundAccounts = new WeakMap<ExecutionBinding, { accountId?: string }>()
  private readonly probes = new Map<string, ProbeState>()
  private readonly facts: RuntimeFactsStore
  /** Executable stats taken when no probe recorded one, reused for the probe TTL. */
  private readonly stats = new Map<string, { fingerprint?: BinaryFingerprint; atMs: number }>()
  /** Threads already told that an instance approves tools itself (`thread|instance`). */
  private readonly toolNotices = new Set<string>()
  /** Bindings made for a selection that named a moved entry: their thread is told once. */
  private readonly boundMoves = new WeakMap<ExecutionBinding, string>()
  private readonly operations = new Map<string, Operation>()
  private readonly listeners = new Set<(event: HarnessGatewayEvent) => void>()
  private readonly scopes: HarnessScopeStore
  private readonly counters: InstanceCounterStore
  private readonly prefs: ModelPrefsService
  private searchPath: string[] = []
  private readonly shellPath: Promise<void>
  private stopped = false

  constructor(private readonly options: HarnessGatewayOptions) {
    this.instanceMap = options.instanceMap
    for (const driver of options.drivers) {
      if (this.drivers.has(driver.kind)) throw new Error(`A driver for ${driver.kind} is already registered.`)
      this.drivers.set(driver.kind, driver)
    }
    this.scopes = new HarnessScopeStore(options.profileHome)
    this.counters = new InstanceCounterStore(options.profileHome)
    this.facts = new RuntimeFactsStore(options.profileHome)
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
        if (!record) return undefined
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
      add: (input) => this.add(input),
      remove: (instanceId) => this.remove(instanceId),
      configure: (instanceId, patch) => this.configure(instanceId, patch),
      setEnabled: (instanceId, scope, enabled) => this.setEnabled(instanceId, scope, enabled),
      install: (instanceId) => this.install(instanceId, 'install'),
      cancelInstall: async (operationId) => this.operations.get(operationId)?.cancel() ?? false,
      update: (instanceId) => this.update(instanceId),
      signIn: (instanceId, method) => this.signIn(instanceId, method),
      respondSignIn: async (operationId, response) => this.respondSignIn(operationId, response),
      signOut: (instanceId) => this.signOut(instanceId),
      recheck: async (instanceId) => {
        await this.probe(instanceId, true, { handshake: true })
        return this.snapshot(instanceId, { kind: 'device' })
      },
      refreshModels: (instanceId) => this.refreshModels(instanceId),
      move: (fromInstanceId, toInstanceId) => this.move(fromInstanceId, toInstanceId),
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
        return custom ? custom.capabilities.images : record.driver.mcpImageResults === true
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
        return record.runtime.signIn(session, cwd).finally(() => void this.probe(record.instanceId, true))
      },
      credentialsChanged: async (providerId) => {
        let instanceId: string
        try {
          instanceId = this.instanceMap.instanceIdForLegacyProvider(providerId)
        } catch {
          return
        }
        if (this.instanceMap.get(instanceId)?.driver !== 'pi') return
        // A check already running read the old credentials: wait for it, then check again.
        await this.probes.get(instanceId)?.probing
        await this.probe(instanceId, true)
      }
    }
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
    if (options.purpose === 'title' && driver.kind !== 'pi')
      harnessFail('unsupported', `${driver.label} cannot name chats. Choose an API provider's model for chat titles, or Automatic.`, resolved.instanceId)
    if (!options.allowDisabled) {
      if (options.scope?.kind === 'project' && !this.scopes.enabled(resolved.instanceId, true, options.scope).effective)
        harnessFail('instance_disabled', `Provider instance "${resolved.instanceId}" is turned off for this project. Turn it on or choose another model.`, resolved.instanceId)
      if (selection.model && hidesModel(this.prefs.get(resolved.instanceId), selection.model))
        harnessFail('model_hidden', `${this.modelName(resolved.instanceId, selection.model)} is hidden. Show it in Settings → Providers or choose another model.`, resolved.instanceId)
    }
    const config = driver.decodeConfig(resolved.entry.config)
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

  async bind(resolved: ResolvedTurnSelection, input: { mode: ChatMode; effort?: string; origin?: TurnOrigin }): Promise<ExecutionBinding> {
    const record = resolved.instanceId === PI_DRIVER_ID ? undefined : this.recordOrUndefined(resolved.instanceId)
    const accountId = record ? await this.currentAccount(record) : undefined
    const counters = this.counters.get(resolved.instanceId)
    // The attempt runs on the caps of this moment, whatever the runtime reports meanwhile.
    const caps = record ? this.recordCaps(record) : resolved.caps
    const binary = record ? this.probes.get(record.instanceId)?.lastGood?.fingerprint : undefined
    const binding: ExecutionBinding = {
      instanceId: resolved.instanceId,
      driver: resolved.driver,
      accountGeneration: counters.accountGeneration,
      homeId: record?.env.homeId ?? DEFAULT_HOME_ID,
      configRevision: counters.configRevision,
      ...(accountId ? { accountId } : {}),
      model: resolved.model,
      ...(input.effort ? { effort: input.effort } : {}),
      policy: { mode: policyMode(input.mode), approvals: 'ask', origin: input.origin ?? 'interactive' },
      caps: { ...caps },
      factsRevision: record ? this.facts.revision(record.instanceId) : 0,
      ...(binary ? { binary: { ...binary } } : {})
    }
    this.boundAccounts.set(binding, accountId ? { accountId } : {})
    if (resolved.movedFrom) this.boundMoves.set(binding, resolved.movedFrom)
    return binding
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
    return reading.state === 'signed_in' ? this.noteSubject(record, reading.subject) : undefined
  }

  /** Records the account `subject` names; a different one than last time moves the generation on. */
  private noteSubject(record: InstanceRecord, subject: string | undefined): string | undefined {
    if (!subject) return undefined
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
        if (llmProvider && record.runtime.configured() && !ids.includes(llmProvider)) ids.push(llmProvider)
      } catch {
        // An instance whose driver is missing offers nothing.
      }
    }
    return ids
  }

  // -- Turns ------------------------------------------------------------------------------------

  startTurn(spec: TurnSpec): TurnHandle {
    const record = this.turnRecord(spec.binding)
    let ref: ProviderRef | undefined
    let ended = false
    const sink: TurnSink = { ...spec.sink, providerRef: (next) => { ref = next; spec.sink.providerRef(next) } }
    record.active += 1
    const result = (async () => {
      let minted: ReturnType<Harness['mintBridge']>
      try {
        await this.admitTurn(record, spec)
        minted = this.mintBridge(record, spec)
        const host: AdapterHost = minted ? { ...spec.host, bridge: minted.bridge } : spec.host
        const output = await record.runtime.adapter.startTurn(spec.input, sink, spec.control, host)
        minted?.settle({ status: output.aborted || spec.input.signal.aborted ? 'aborted' : 'completed', ...(output.drain ? { drain: output.drain } : {}) })
        return output
      } catch (error) {
        minted?.settle({ status: spec.input.signal.aborted ? 'aborted' : 'failed' })
        throw error
      } finally {
        ended = true
        record.active -= 1
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

  /**
   * Runs a turn on its binding or not at all: the input names the binding's instance, model and
   * policy mode, the instance can enforce that policy, and its config, home and account are still
   * the ones the binding recorded (a retry or recovery after a change fails with `binding_stale`).
   * Then decides whether the thread's native session may be resumed.
   */
  private async admitTurn(record: InstanceRecord, spec: TurnSpec): Promise<void> {
    const { binding, previous, input } = spec
    if (input.instanceId !== binding.instanceId || input.model !== binding.model)
      harnessFail('protocol', `The turn names ${input.instanceId ?? 'no instance'}/${input.model} but its binding is ${binding.instanceId}/${binding.model}.`, binding.instanceId)
    // The runtime takes its permissions from the input's mode: it must be the binding's policy.
    if (policyMode(input.mode) !== binding.policy.mode)
      harnessFail('protocol', `The turn runs in ${policyMode(input.mode)} mode but its binding is ${binding.policy.mode} mode.`, binding.instanceId)
    // The caps the binding froze (bindings from before snapshots: the live ones).
    const caps = binding.caps ?? this.recordCaps(record)
    const enforceable = checkPolicy(caps, binding.policy, binding.instanceId)
    if (!enforceable.ok) throw harnessAppError(enforceable.error)
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

  async childPreflight(instanceId: string, context: ChildPreflightContext): Promise<SubagentRefusal | null> {
    const record = instanceId === PI_DRIVER_ID ? this.piRecord() : this.record(instanceId, { allowDisabled: true })
    return (await record.runtime.adapter.childPreflight?.(context)) ?? null
  }

  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    return this.interruptOn(this.refRecord(ref), ref)
  }

  async forkSession(ref: ProviderRef, atTurnOrdinal: number): Promise<ProviderRef | null> {
    const adapter = this.refRecord(ref).runtime.adapter
    return adapter.forkSession ? adapter.forkSession(ref, atTurnOrdinal) : null
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
          // A new runtime, a new epoch: driver, home, signed-in account and settings.
          generation: [binding.driver, binding.homeId, binding.accountGeneration, binding.configRevision].join('|')
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
        permission: questionsPrompter(this.options.questions)
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
    const config = driver.decodeConfig(resolved.entry.config)
    const key = `${driver.kind}|${this.counters.get(instanceId).configRevision}|${config.home}`
    if (current && current.key === key) {
      current.entry = resolved.entry
      current.config = config
      return current
    }
    if (current) this.retire(current)
    return this.build(instanceId, resolved.entry)
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
    const config = driver.decodeConfig(entry.config)
    const builtIn = isBuiltInInstance(instanceId, entry.driver)
    const stateDir = instanceStateDir(this.options.profileHome, instanceId)
    const revision = this.counters.get(instanceId).configRevision
    const env = instanceEnv({
      instanceId,
      driver: entry.driver,
      configRevision: revision,
      ...(driver.alwaysPrivateHome || (config.home === 'private' && !builtIn) ? { home: join(stateDir, 'home') } : {}),
      searchPath: this.searchPath
    })
    const record: InstanceRecord = {
      instanceId,
      entry,
      driver,
      config,
      builtIn,
      key: `${driver.kind}|${revision}|${config.home}`,
      env,
      active: 0,
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
      changed: () => this.changed(instanceId)
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
    if (!record.driver.binaryNames.length) return undefined
    return findOnPath(record.driver.binaryNames, { env: record.env.env, searchPath: this.searchPath })
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
      try {
        record.runtime.stop()
      } catch (error) {
        console.warn('[harness] runtime stop failed', { instanceId: record.instanceId, error: errorText(error) })
      }
    }
    this.deleteRemoved()
  }

  /**
   * Deletes the state directory of a removed instance once nothing uses it: no runtime of the
   * instance (the last one or one a reconfiguration replaced) runs a turn, and no check or
   * operation of it is still running.
   */
  private deleteRemoved(): void {
    for (const [instanceId, removal] of this.removals) {
      if (removal.pending > 0) continue
      if ([...this.retired].some((record) => record.instanceId === instanceId)) continue
      if ([...this.operations.values()].some((operation) => operation.started.instanceId === instanceId)) continue
      this.removals.delete(instanceId)
      try {
        rmSync(removal.dir, { recursive: true, force: true })
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
    await Promise.all(firstChecks)
    return ids.flatMap((instanceId) => {
      try {
        return [this.snapshot(instanceId, scope)]
      } catch {
        return []
      }
    })
  }

  /**
   * Single-flight probe of one instance; a timeout keeps the last good values (stale). `handshake`
   * (Add, Recheck, after install) also runs the runtime's start-up check, which records its facts.
   */
  private probe(instanceId: string, force: boolean, options: { handshake?: boolean } = {}): Promise<void> {
    const state = this.probes.get(instanceId) ?? {}
    this.probes.set(instanceId, state)
    if (state.probing) return state.probing
    const run = async () => {
      await Promise.race([this.shellPath, new Promise((resolve) => setTimeout(resolve, SHELL_PATH_WAIT_MS).unref?.())])
      const record = this.record(instanceId, { allowDisabled: true })
      const override = record.builtIn ? record.runtime.launch?.().binaryPath : record.config.binaryPath
      let result = await probeInstance({
        driver: record.driver,
        runtime: record.runtime,
        env: { ...record.env, searchPath: this.searchPath },
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
      state.result = result
      state.checkedAtMs = this.now()
      if (!result.timedOut) state.lastGood = result
      // A different account than the last check: sessions made on the old one are not resumed.
      this.noteAuth(record, result.auth)
      if (options.handshake) this.captureFacts(record)
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
    const auth = shown?.auth ?? { state: 'unknown' as const }
    const prefs = this.prefs.get(instanceId)
    const listed = runtime.models()
    const models = state?.models
    const signInStep: NextStep | undefined = auth.state === 'signed_out' || auth.state === 'expired'
      ? { action: 'sign_in', label: auth.state === 'expired' ? 'Sign in again' : 'Sign in', ...(auth.signInCommand ? { command: auth.signInCommand } : {}) }
      : undefined
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
        canInstall: driver.canInstall && Boolean(runtime.install)
      },
      runs: shown?.runs ?? { state: 'unknown' },
      auth: {
        state: auth.state,
        // Keyed by its salted hash: the vendor's account id never leaves the gateway.
        ...(auth.account?.label ? { account: { id: auth.subject ? this.counters.accountIdentity(record.env.homeId, auth.subject) : 'unknown', label: auth.account.label } } : {}),
        ...(auth.methodLabel ?? driver.methodLabel ? { methodLabel: auth.methodLabel ?? driver.methodLabel } : {}),
        ...(auth.message ? { message: auth.message } : {}),
        canSignOut: Boolean(runtime.signOut) && (auth.state === 'signed_in' || auth.state === 'expired') && (this.ownsSignIn(record) || auth.ownedByMousse === true),
        ...(runtime.signIn && auth.canSignIn ? { canSignIn: true } : {})
      },
      compatibility: shown?.compatibility ?? compatibilityOf(driver, undefined),
      ...(shown?.update ? { update: shown.update } : {}),
      ...(shown?.binary ? { binary: shown.binary } : {}),
      caps: driver.caps(config, shown?.binary?.version, this.currentFacts(instanceId)),
      config: this.configView(record),
      models: {
        entries: modelsWithPrefs(listed, prefs),
        source: listed.length ? (models?.live ? 'live' : 'cached') : prefs.custom.length ? 'manifest' : 'none',
        canAddCustom: driver.customModels,
        ...(models?.refreshedAt ? { refreshedAt: models.refreshedAt } : {}),
        ...(models?.error ? { error: models.error } : {})
      },
      ...(latest ? { checkedAt: latest.checkedAt } : {}),
      stale,
      ...(state?.lastGood ? { lastGoodAt: state.lastGood.checkedAt } : {}),
      ...(signInStep ? { nextStep: signInStep } : {})
    }
  }

  /**
   * Whether Mousse owns the instance's sign-in: a private home, a Mousse-managed agent, or a pi
   * provider key Mousse stores. The built-in CLIs use the user's own terminal login.
   */
  private ownsSignIn(record: InstanceRecord): boolean {
    if (record.entry.driver === 'pi') return true
    if (record.env.home) return true
    return Boolean(record.runtime.managed?.()) && !record.runtime.launch?.().binaryPath
  }

  /** The settings the editor shows: built-in instances read launch settings from `settings.json`. */
  private configView(record: InstanceRecord): InstanceConfigView {
    const launch = record.builtIn ? record.runtime.launch?.() : undefined
    const source = launch ?? record.config
    return {
      ...(record.config.displayName ? { displayName: record.config.displayName } : {}),
      home: record.env.home ? 'private' : 'default',
      ...(source.binaryPath ? { binaryPath: source.binaryPath } : {}),
      args: [...(source.args ?? [])],
      env: { ...(source.env ?? {}) },
      ...(record.config.loginMethod ? { loginMethod: record.config.loginMethod } : {}),
      ...(record.config.movedTo ? { movedTo: record.config.movedTo } : {})
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
    const entries = this.instanceMap.list()
    const hasOne = Object.values(entries).some((entry) => entry.driver === driver.kind)
    if (hasOne && !driver.multiInstance) return harnessFail('unsupported', `${driver.label} supports one instance in this version.`)
    // The first instance of an agent runs on the user's own setup (their CLI and its sign-in), under
    // the driver's usual id; further ones are other accounts with private homes.
    const ownSetup = defaultInstanceId(driver.kind)
    const useOwnSetup = ownSetup !== undefined && !hasOne && !Object.prototype.hasOwnProperty.call(entries, ownSetup)
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
      ? this.applyConfigPatch({}, { ...(patch.displayName ? { displayName: patch.displayName } : {}) }, driver)
      : this.applyConfigPatch({ home: driver.privateHome ? 'private' : 'default' }, patch, driver)
    this.instanceMap.setEntry(instanceId, { driver: driver.kind, enabled: true, config })
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
    this.records.delete(instanceId)
    this.instanceMap.removeEntry(instanceId)
    this.prefs.remove(instanceId)
    this.scopes.forgetInstance(instanceId)
    this.counters.forget(instanceId)
    this.facts.forget(instanceId)
    this.probes.delete(instanceId)
    // The state directory is Mousse's own (its private home, the sign-in in it, saved sessions):
    // it goes with the instance, once every runtime, check and operation still using it ends.
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
    this.retire(record)
    this.emitSnapshots({ kind: 'device' })
    this.options.onProvidersChanged?.()
    // Checks end within their deadlines; turns may run on, and the directory waits for them.
    await Promise.all(checks)
  }

  private async configure(instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (record.builtIn && patch.home === 'private')
      harnessFail('unsupported', `The built-in ${record.driver.label} runs as you set it up. Add another instance for a separate home.`, instanceId)
    if (patch.home === 'private' && !record.driver.privateHome)
      harnessFail('unsupported', `${record.driver.label} cannot use a separate home.`, instanceId)
    const stored = record.entry.config ?? {}
    if (record.builtIn) {
      // Built-in vendor instances keep their launch settings in their own settings.json.
      const launch: CliProviderConfigPatch = {
        ...(patch.binaryPath !== undefined ? { binaryPath: patch.binaryPath } : {}),
        ...(patch.args !== undefined ? { args: patch.args } : {}),
        ...(patch.env !== undefined ? { env: patch.env } : {})
      }
      if (Object.keys(launch).length) {
        if (!record.runtime.setLaunch) harnessFail('unsupported', 'This provider has no launch settings.', instanceId)
        try {
          await record.runtime.setLaunch(launch)
        } catch (error) {
          harnessFail('override_not_found', errorText(error), instanceId)
        }
      }
      const config = { ...stored }
      if (patch.displayName !== undefined) setOrDelete(config, 'displayName', patch.displayName?.trim() || undefined)
      if (patch.loginMethod !== undefined) setOrDelete(config, 'loginMethod', patch.loginMethod || undefined)
      this.instanceMap.setEntry(instanceId, { ...record.entry, config })
    } else {
      const config = this.applyConfigPatch(stored, patch, record.driver)
      this.instanceMap.setEntry(instanceId, { ...record.entry, config })
    }
    // A new name changes nothing a turn runs with: the runtime and its sessions stay.
    if (Object.keys(patch).some((key) => key !== 'displayName')) {
      this.counters.bumpConfig(instanceId)
      void this.probe(instanceId, true)
    }
    this.changed(instanceId)
    return this.snapshot(instanceId, { kind: 'device' })
  }

  /** The stored `config` of an added instance after a patch (unknown fields kept). */
  private applyConfigPatch(stored: Record<string, unknown>, patch: InstanceConfigPatch, driver: HarnessDriver): Record<string, unknown> {
    const config: Record<string, unknown> = { ...stored }
    if (patch.displayName !== undefined) setOrDelete(config, 'displayName', patch.displayName?.trim() || undefined)
    if (patch.home !== undefined) config.home = driver.privateHome ? patch.home : 'default'
    if (patch.binaryPath !== undefined) setOrDelete(config, 'binaryPath', patch.binaryPath?.trim() || undefined)
    if (patch.args !== undefined) setOrDelete(config, 'args', patch.args.length ? [...patch.args] : undefined)
    if (patch.env !== undefined) setOrDelete(config, 'env', Object.keys(patch.env).length ? { ...patch.env } : undefined)
    if (patch.loginMethod !== undefined) setOrDelete(config, 'loginMethod', patch.loginMethod || undefined)
    return config
  }

  private async move(fromId: string, toId: string): Promise<MoveResult> {
    const from = this.record(fromId, { allowDisabled: true })
    const to = this.record(toId, { allowDisabled: true })
    const agent = (this.options.foldedInto ?? foldedInto)(piProviderIdOf(fromId))
    if (fromId === toId || !agent || to.driver.kind !== agent)
      harnessFail('unsupported', `${this.displayName(from)} cannot move to ${this.displayName(to)}.`, fromId)
    if (from.config.movedTo) harnessFail('unsupported', `${this.displayName(from)} has already moved.`, fromId)
    // Turned off, never deleted: an older build can still turn it back on.
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
    this.changed(fromId)
    return { from: fromId, to: toId, rewritten }
  }

  private async setEnabled(instanceId: string, scope: ProviderScope, enabled: boolean | null): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (scope.kind === 'device') {
      if (enabled === null) harnessFail('unsupported', 'The device setting takes on or off.', instanceId)
      this.instanceMap.setEntry(instanceId, { ...record.entry, enabled })
      if (enabled) void this.probe(instanceId, false)
    } else this.scopes.setEnabled(scope.projectId, instanceId, enabled)
    this.changed(instanceId, { scope })
    return this.snapshot(instanceId, scope)
  }

  private async signOut(instanceId: string): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (!record.runtime.signOut) harnessFail('unsupported', 'This provider has no sign-out.', instanceId)
    await record.runtime.signOut()
    this.counters.bumpAccount(instanceId)
    await this.probe(instanceId, true)
    this.options.onProvidersChanged?.()
    return this.snapshot(instanceId, { kind: 'device' })
  }

  private async refreshModels(instanceId: string): Promise<InstanceSnapshot> {
    const record = this.record(instanceId, { allowDisabled: true })
    const state = this.probes.get(instanceId) ?? {}
    this.probes.set(instanceId, state)
    try {
      await record.runtime.refreshModels?.(this.cwd())
      state.models = { live: true, refreshedAt: new Date(this.now()).toISOString() }
      this.captureFacts(record)
    } catch (error) {
      state.models = { ...state.models, error: errorText(error) }
    }
    this.changed(instanceId)
    return this.snapshot(instanceId, { kind: 'device' })
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
      void runtime.install!((message, fraction) => {
        operation.progress = { message, ...(fraction !== undefined ? { fraction } : {}) }
        this.emit({ type: 'operation', data: { ...started, phase: 'progress', message, ...(fraction !== undefined ? { fraction } : {}) } })
        this.emitSnapshots({ kind: 'device' })
      })
        .then(() => this.emit({ type: 'operation', data: { ...started, phase: 'completed' } }))
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

  private async update(instanceId: string): Promise<ProviderOperationStarted> {
    const update = this.probes.get(instanceId)?.lastGood?.update
    if (update?.kind === 'one_click') return this.install(instanceId, 'update')
    if (update?.kind === 'advisory')
      return harnessFail('unsupported', `Mousse cannot prove who installed this CLI. Update it with: ${update.command}`, instanceId)
    return harnessFail('unsupported', 'No update is available.', instanceId)
  }

  private async signIn(instanceId: string, method?: string): Promise<ProviderOperationStarted> {
    const record = this.record(instanceId, { allowDisabled: true })
    const runtime = record.runtime
    if (!runtime.signIn) return harnessFail('unsupported', 'This provider has no sign-in.', instanceId)
    if ([...this.operations.values()].some((entry) => entry.started.instanceId === instanceId && entry.started.kind === 'sign_in'))
      return harnessFail('operation_busy', 'A sign-in is already running for this provider.', instanceId)
    const started: ProviderOperationStarted = { operationId: randomUUID(), instanceId, kind: 'sign_in' }
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
            // A completed sign-in may be another account: sessions made before it are not resumed.
            this.counters.bumpAccount(instanceId)
            // Its verification (a `session/new`) may have listed the account's models and modes.
            this.captureFacts(record)
            this.emit({ type: 'operation', data: { ...started, phase: 'completed' } })
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
    for (const operation of this.operations.values()) operation.cancel()
    this.operations.clear()
    for (const record of [...this.records.values(), ...this.retired]) {
      try {
        record.runtime.stop()
      } catch {
        /* stopping is best effort */
      }
    }
    this.records.clear()
    this.retired.clear()
    this.listeners.clear()
  }
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/** The gateway of a profile (or of a test) over its instance map and drivers. */
export function createHarnessGateway(options: HarnessGatewayOptions): Harness {
  return new Harness(options)
}
