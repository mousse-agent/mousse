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
import type { AdapterHost, TurnControl, TurnInput, TurnResult, TurnSink } from '../run/adapters/ProviderAdapter'
import type { ProviderRef } from '../run/types'

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
