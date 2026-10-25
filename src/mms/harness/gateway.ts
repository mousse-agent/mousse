import type { InstanceSnapshot, ProviderSnapshotsEvent } from '../../shared/harness/status'
import type {
  AddInstanceInput,
  Enforceability,
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
  SignInResponse
} from '../../shared/harness/types'
import type { CliProviderConfig, CliProviderConfigPatch, CliProviderInstanceId, ConfiguredProvider, ProviderLoginResult } from '../../shared/providerAuth'
import type { ModelOverride } from '../../shared/providerInstances'
import type { LlmProviderOption } from '../../shared/settings'
import type { ChatMode } from '../../shared/types'
import type { LoginSession } from '../providers/LoginSession'
import type { ProviderInstanceService } from '../providers/ProviderInstanceService'
import type { AdapterHost, TurnControl, TurnInput, TurnResult, TurnSink } from '../run/adapters/ProviderAdapter'
import type { ChildPreflightContext, SubagentRefusal } from '../run/policy/featureGates'
import type { ProviderRef } from '../run/types'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InstanceConfigView, NextStep } from '../../shared/harness/status'
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
import { modelsWithPrefs, ModelPrefsService, visibleProviderOption, type ModelPrefsStore } from './catalog'
import type { DriverRuntime, HarnessDriver, InstanceConfig, LiveProcessHost } from './driver'
import { DEFAULT_HOME_ID, findOnPath, instanceEnv, type InstanceEnv } from './env'
import { addedInstanceId, InstanceCounterStore, instanceStateDir, isBuiltInInstance } from './instances'
import { checkPolicy } from './policy'
import { HarnessScopeStore } from './scope'
import { sharedShellPath, type ShellPathResult } from './shellPath'
import { compatibilityOf, PROBE_TIMEOUTS, probeInstance, type ProbeResult } from './status'

/** Instance id of a turn that ran on the unselected default: the bare pi loop. */
export const PI_DRIVER_ID = 'pi'

// The turn contract callers build (`TurnSpec`): app code imports these from the gateway, never
// from the adapters behind it.
export type {
  AdapterHost,
  ChildTurnPolicy,
  ProviderMetrics,
  RecoveredContext,
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
  /** Fails closed with `policy_unenforceable` when the instance cannot enforce `policy`. */
  check(selection: ProviderSelection, policy: RunPolicy): Enforceability
  /** Called only by the RunEngine `turn.start` executor. */
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
  /** The immutable binding of one attempt, from a resolved selection and the current counters. */
  bind(resolved: ResolvedTurnSelection, input: { mode: ChatMode; effort?: string }): ExecutionBinding
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
  cliConfig(instanceId: CliProviderInstanceId): Promise<CliProviderConfig>
  setCliConfig(instanceId: CliProviderInstanceId, patch: CliProviderConfigPatch): Promise<CliProviderConfig>
}

/** Who is resolving; recorded for diagnostics, and the same rules apply to all. */
export type ResolvePurpose =
  | 'composer'
  | 'default'
  | 'turn'
  | 'delegate_task'
  | 'definition'
  | 'workflow'
  | 'channel_model'
  | 'cli_model'

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
  /** Rejects built-in instances with `unsupported`. */
  remove(instanceId: string): Promise<void>
  configure(instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot>
  /** `null` clears a project override; the device scope takes a boolean only. */
  setEnabled(instanceId: string, scope: ProviderScope, enabled: boolean | null): Promise<InstanceSnapshot>
  install(instanceId: string): Promise<ProviderOperationStarted>
  /** Cancels a running install or update; false when it is not running. */
  cancelInstall(operationId: string): Promise<boolean>
  update(instanceId: string): Promise<ProviderOperationStarted>
  uninstall(instanceId: string): Promise<InstanceSnapshot>
  /** `method` picks one of the driver's sign-in methods; absent = its default. */
  signIn(instanceId: string, method?: string): Promise<ProviderOperationStarted>
  /** False when the operation or prompt is no longer waiting. */
  respondSignIn(operationId: string, response: SignInResponse): Promise<boolean>
  signOut(instanceId: string): Promise<InstanceSnapshot>
  /** Bypasses the probe cache. */
  recheck(instanceId: string): Promise<InstanceSnapshot>
  refreshModels(instanceId: string): Promise<InstanceSnapshot>
  setModelPrefs(instanceId: string, patch: ModelPrefsPatch): Promise<InstanceSnapshot>
  /** Snapshot changes (`snapshots$`) and operation progress; returns the unsubscribe. */
  subscribe(listener: (event: HarnessGatewayEvent) => void): () => void
}

export type HarnessGatewayEvent =
  | { type: 'snapshots'; data: ProviderSnapshotsEvent }
  | { type: 'operation'; data: ProviderOperationEvent }

export interface HarnessCatalog {
  /** Models of an instance with prefs applied, in display order (hidden ones included and flagged). */
  models(instanceId: string, scope: ProviderScope): InstanceModel[]
}

/**
 * One turn. PR 1 drivers wrap today's adapters, so a turn carries the adapter turn contract with
 * the attempt's immutable binding; `HarnessEvent` streaming replaces the sink when drivers stop
 * wrapping adapters.
 */
export interface TurnSpec {
  binding: ExecutionBinding
  /**
   * The binding of the thread's previous attempt. A native session made on another account or
   * home of the same instance is never resumed: the turn hands the history over instead.
   */
  previous?: ExecutionBinding
  input: TurnInput
  sink: TurnSink
  control: TurnControl
  host: AdapterHost
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
}

interface Operation {
  started: ProviderOperationStarted
  session?: LoginSession
  prompt?: { promptId: string; kind: 'prompt' | 'select' | 'manual_code' }
  prompts: number
  progress?: { message: string; fraction?: number }
  cancel(): boolean
}

const BUILT_IN_LEGACY_IDS: Record<CliProviderInstanceId, true> = { claude: true, codex: true, antigravity: true }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  private readonly retired = new Set<InstanceRecord>()
  private readonly probes = new Map<string, ProbeState>()
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
      uninstall: async (instanceId) => {
        this.record(instanceId, { allowDisabled: true })
        return harnessFail('unsupported', 'Mousse does not uninstall CLIs it did not install. Remove it with the tool that installed it.', instanceId)
      },
      signIn: (instanceId, method) => this.signIn(instanceId, method),
      respondSignIn: async (operationId, response) => this.respondSignIn(operationId, response),
      signOut: (instanceId) => this.signOut(instanceId),
      recheck: async (instanceId) => {
        await this.probe(instanceId, true)
        return this.snapshot(instanceId, { kind: 'device' })
      },
      refreshModels: (instanceId) => this.refreshModels(instanceId),
      setModelPrefs: async (instanceId, patch) => {
        this.record(instanceId, { allowDisabled: true })
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
      models: (instanceId) => modelsWithPrefs(this.record(instanceId, { allowDisabled: true }).runtime.models(), this.prefs.get(instanceId))
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
      cliConfig: async (instanceId) => {
        const runtime = this.record(this.builtInCli(instanceId), { allowDisabled: true }).runtime
        if (!runtime.cliConfig) return harnessFail('unsupported', 'This provider has no launch settings.', instanceId)
        return runtime.cliConfig()
      },
      setCliConfig: async (instanceId, patch) => {
        const id = this.builtInCli(instanceId)
        const runtime = this.record(id, { allowDisabled: true }).runtime
        if (!runtime.setLaunch || !runtime.cliConfig) return harnessFail('unsupported', 'This provider has no launch settings.', instanceId)
        await runtime.setLaunch(patch)
        this.counters.bumpConfig(id)
        void this.probe(id, true)
        return runtime.cliConfig()
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
    const resolved = this.instanceMap.resolve(this.instanceMap.instanceIdOf(selection), { allowDisabled: options.allowDisabled })
    const driver = this.drivers.get(resolved.entry.driver)
    if (!driver) fail('bad_request', `No provider adapter for driver ${resolved.entry.driver} (instance ${resolved.instanceId}).`)
    if (!options.allowDisabled) {
      if (options.scope?.kind === 'project' && !this.scopes.enabled(resolved.instanceId, true, options.scope).effective)
        harnessFail('instance_disabled', `Provider instance "${resolved.instanceId}" is turned off for this project. Turn it on or choose another model.`, resolved.instanceId)
      if (selection.model && this.prefs.get(resolved.instanceId).hidden.includes(selection.model))
        harnessFail('model_hidden', `The model "${selection.model}" is hidden. Show it in Settings → Providers or choose another model.`, resolved.instanceId)
    }
    const config = driver.decodeConfig(resolved.entry.config)
    const version = this.probes.get(resolved.instanceId)?.lastGood?.binary?.version
    return { instanceId: resolved.instanceId, llmProvider: resolved.llmProvider, driver: driver.kind, model: selection.model, caps: driver.caps(config, version) }
  }

  check(selection: ProviderSelection, policy: RunPolicy): Enforceability {
    return checkPolicy(this.resolve(selection, { kind: 'device' }, 'turn').caps, policy, selection.instanceId)
  }

  bind(resolved: ResolvedTurnSelection, input: { mode: ChatMode; effort?: string }): ExecutionBinding {
    const record = resolved.driver === 'pi' ? undefined : this.recordOrUndefined(resolved.instanceId)
    const counters = this.counters.get(resolved.instanceId)
    return {
      instanceId: resolved.instanceId,
      driver: resolved.driver,
      accountGeneration: counters.accountGeneration,
      homeId: record?.env.homeId ?? DEFAULT_HOME_ID,
      configRevision: counters.configRevision,
      model: resolved.model,
      ...(input.effort ? { effort: input.effort } : {}),
      policy: { mode: input.mode === 'plan' ? 'plan' : 'default', approvals: 'ask' }
    }
  }

  configuredProviderIds(): string[] {
    const ids: string[] = []
    for (const [instanceId, entry] of Object.entries(this.instanceMap.list())) {
      if (entry.driver === 'pi' || !entry.enabled) continue
      try {
        const record = this.record(instanceId)
        const llmProvider = legacyProviderForInstance(instanceId, entry)
        if (llmProvider && record.runtime.configured()) ids.push(llmProvider)
      } catch {
        // An instance whose driver is missing offers nothing.
      }
    }
    return ids
  }

  // -- Turns ------------------------------------------------------------------------------------

  startTurn(spec: TurnSpec): TurnHandle {
    const { binding, previous } = spec
    const record = this.turnRecord(binding)
    // A native session belongs to the account and home it was made on; another one never resumes it.
    if (previous && previous.instanceId === binding.instanceId &&
        (previous.accountGeneration !== binding.accountGeneration || previous.homeId !== binding.homeId)) {
      try {
        record.runtime.forgetConversation?.(spec.input.threadId)
      } catch (error) {
        console.warn('[harness] could not drop a native session from another account', { instanceId: binding.instanceId, error: errorText(error) })
      }
    }
    let ref: ProviderRef | undefined
    let ended = false
    const sink: TurnSink = { ...spec.sink, providerRef: (next) => { ref = next; spec.sink.providerRef(next) } }
    record.active += 1
    const result = (async () => {
      try {
        return await record.runtime.adapter.startTurn(spec.input, sink, spec.control, spec.host)
      } finally {
        ended = true
        record.active -= 1
        this.releaseRetired()
      }
    })()
    return {
      result,
      providerRef: () => ref,
      interrupt: async () => (ended || !ref ? 'not_active' : record.runtime.adapter.interrupt(ref)),
      steer: async (text) => {
        if (ended) return 'not_active'
        if (ref && record.runtime.adapter.steer && (await record.runtime.adapter.steer(ref, text)) === 'delivered') return { delivery: 'live' }
        return { delivery: 'queued' }
      }
    }
  }

  async childPreflight(instanceId: string, context: ChildPreflightContext): Promise<SubagentRefusal | null> {
    const record = instanceId === PI_DRIVER_ID ? this.piRecord() : this.record(instanceId, { allowDisabled: true })
    return (await record.runtime.adapter.childPreflight?.(context)) ?? null
  }

  async interrupt(ref: ProviderRef): Promise<'interrupted' | 'not_active'> {
    const record = this.refRecord(ref)
    return record.runtime.adapter.interrupt(ref)
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
      ...(config.home === 'private' && !builtIn ? { home: join(stateDir, 'home') } : {}),
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

  private builtInCli(instanceId: CliProviderInstanceId): string {
    if (!BUILT_IN_LEGACY_IDS[instanceId]) harnessFail('instance_unknown', `Unknown provider instance "${instanceId}".`, instanceId)
    return instanceId
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

  /** Single-flight probe of one instance; a timeout keeps the last good values (stale). */
  private probe(instanceId: string, force: boolean): Promise<void> {
    const state = this.probes.get(instanceId) ?? {}
    this.probes.set(instanceId, state)
    if (state.probing) return state.probing
    const run = async () => {
      await Promise.race([this.shellPath, new Promise((resolve) => setTimeout(resolve, SHELL_PATH_WAIT_MS).unref?.())])
      const record = this.record(instanceId, { allowDisabled: true })
      const override = record.builtIn ? record.runtime.launch?.().binaryPath : record.config.binaryPath
      const result = await probeInstance({
        driver: record.driver,
        runtime: record.runtime,
        env: { ...record.env, searchPath: this.searchPath },
        ...(override ? { override } : {}),
        force,
        ...(this.options.probeTimeouts ? { timeouts: this.options.probeTimeouts } : {})
      })
      state.result = result
      state.checkedAtMs = this.now()
      if (!result.timedOut) state.lastGood = result
      // A different account than the last check: sessions made on the old one are not resumed.
      if (result.auth.state === 'signed_in' && result.auth.account?.id) this.counters.noteAccount(instanceId, result.auth.account.id)
    }
    state.probing = run()
      .catch((error) => {
        console.warn('[harness] provider check failed', { instanceId, error: errorText(error) })
        state.checkedAtMs = this.now()
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
        ...(auth.account ? { account: auth.account } : {}),
        ...(auth.methodLabel ?? driver.methodLabel ? { methodLabel: auth.methodLabel ?? driver.methodLabel } : {}),
        ...(auth.message ? { message: auth.message } : {}),
        canSignOut: Boolean(runtime.signOut) && (auth.state === 'signed_in' || auth.state === 'expired') && this.ownsSignIn(record)
      },
      compatibility: shown?.compatibility ?? compatibilityOf(driver, undefined),
      ...(shown?.update ? { update: shown.update } : {}),
      ...(shown?.binary ? { binary: shown.binary } : {}),
      caps: driver.caps(config, shown?.binary?.version),
      config: this.configView(record),
      models: {
        entries: modelsWithPrefs(listed, prefs),
        source: listed.length ? (models?.live ? 'live' : 'cached') : prefs.custom.length ? 'manifest' : 'none',
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
      ...(record.config.loginMethod ? { loginMethod: record.config.loginMethod } : {})
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
    if (!driver.multiInstance) return harnessFail('unsupported', `${driver.label} supports one instance in this version.`)
    const patch = input.config ?? {}
    const instanceId = addedInstanceId(driver.kind, patch.displayName ?? undefined, Object.keys(this.instanceMap.list()))
    const config = this.applyConfigPatch({ home: driver.privateHome ? 'private' : 'default' }, patch, driver)
    this.instanceMap.setEntry(instanceId, { driver: driver.kind, enabled: true, config })
    mkdirSync(instanceStateDir(this.options.profileHome, instanceId), { recursive: true, mode: 0o700 })
    this.changed(instanceId)
    void this.probe(instanceId, true)
    return this.snapshot(instanceId, { kind: 'device' })
  }

  private async remove(instanceId: string): Promise<void> {
    const record = this.record(instanceId, { allowDisabled: true })
    if (record.builtIn) harnessFail('unsupported', 'Built-in providers cannot be removed. Turn them off instead.', instanceId)
    this.records.delete(instanceId)
    this.retire(record)
    this.instanceMap.removeEntry(instanceId)
    this.prefs.remove(instanceId)
    this.scopes.forgetInstance(instanceId)
    this.counters.forget(instanceId)
    this.probes.delete(instanceId)
    // The instance's home (and any sign-in in it) stays on disk; Mousse never deletes credentials.
    this.emitSnapshots({ kind: 'device' })
    this.options.onProvidersChanged?.()
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
    this.counters.bumpConfig(instanceId)
    this.changed(instanceId)
    void this.probe(instanceId, true)
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
    const operation: Operation = { started, prompts: 0, cancel: () => runtime.cancelInstall?.() ?? false }
    this.operations.set(started.operationId, operation)
    queueMicrotask(() => {
      void runtime.install!((message) => {
        operation.progress = { message }
        this.emit({ type: 'operation', data: { ...started, phase: 'progress', message } })
        this.emitSnapshots({ kind: 'device' })
      })
        .then(() => this.emit({ type: 'operation', data: { ...started, phase: 'completed' } }))
        .catch((error) => {
          const cancelled = /cancel/i.test(errorText(error))
          this.emit({ type: 'operation', data: cancelled ? { ...started, phase: 'cancelled' } : { ...started, phase: 'failed', error: { code: 'protocol', message: errorText(error), instanceId } } })
        })
        .finally(() => {
          this.operations.delete(started.operationId)
          void this.probe(instanceId, true)
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
          else if (result.success) this.emit({ type: 'operation', data: { ...started, phase: 'completed' } })
          else this.emit({ type: 'operation', data: { ...started, phase: 'failed', error: { code: 'signed_out', message: result.error ?? 'Sign-in failed.', instanceId } } })
        })
        .catch((error) => this.emit({ type: 'operation', data: { ...started, phase: 'failed', error: { code: 'protocol', message: errorText(error), instanceId } } }))
        .finally(() => {
          this.operations.delete(started.operationId)
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
        prompt = { promptId: promptId(), type: 'auth_url', url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}), usesCallbackServer: event.usesCallbackServer }
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
        operation.prompt = { promptId: prompt.promptId, kind: 'manual_code' }
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
    const waiting = operation.prompt
    if (!waiting || (response.promptId && response.promptId !== waiting.promptId)) return false
    const kind = response.kind === 'redirect_url' ? 'manual_code' : response.kind === 'select' ? 'select' : waiting.kind
    operation.prompt = undefined
    session.respond({ sessionId: operationId, kind, ...(response.value !== undefined ? { value: response.value } : {}) })
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
