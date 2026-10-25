import { AppError, type ErrorCategory } from '../errors'
import type { ProviderDriverKind } from '../providerInstances'

/**
 * Shared contracts of the harness gateway (`src/mms/harness/gateway.ts`). App code reaches agents
 * and providers only through the gateway; these types are what crosses the daemon protocol and
 * reaches the renderer. Browser-safe: no Node or Electron imports.
 */

/** Kind of runtime an instance runs on. PR 1 keeps today's four (`pi` is the in-process pi loop). */
export type HarnessDriverKind = ProviderDriverKind

/**
 * Capabilities of one instance, computed by the gateway from the driver, the installed version and
 * the execution profile (never a static per-vendor table in callers). Every key has a reader
 * outside the drivers (`tests/run/capabilityReaders.test.ts`). The first eight keep the meaning of
 * `ProviderCapabilities` in `run/adapters/ProviderAdapter.ts`.
 */
export interface HarnessCaps {
  /** How steer text reaches a live turn (`CommandPolicy.steerStrategy`). */
  steer: 'native' | 'interrupt_restart' | 'queue_only'
  /** The live turn can be interrupted natively (`CommandPolicy.stopStrategy`). */
  interrupt: boolean
  rollback: 'native' | 'none'
  fork: 'native' | 'portable'
  /** Sparse event streams get a wider heartbeat window. */
  events: 'rich' | 'sparse'
  /** `strong` only with evidence for the whole execution profile; weak never auto-restores. */
  containment: 'strong' | 'weak'
  historyInjection: 'native' | 'prompt'
  /** The Mousse MCP server can be attached to a turn. */
  mcp: boolean
  /** The composer offers Plan mode for this instance. */
  planMode: boolean
  /**
   * Context gauge source: `measured` when Mousse measures the transcript itself (the pi loop),
   * `reported` when the runtime reports its context and window, `none` when it publishes neither
   * (the gauge is hidden rather than fabricated).
   */
  contextUsage: 'measured' | 'reported' | 'none'
}

export const HARNESS_CAP_KEYS = [
  'steer', 'interrupt', 'rollback', 'fork', 'events', 'containment', 'historyInjection', 'mcp', 'planMode', 'contextUsage'
] as const satisfies ReadonlyArray<keyof HarnessCaps>

/** What a caller picks to run an agent. */
export interface ProviderSelection {
  instanceId: string
  model: string
  /** Reasoning effort (`EFFORT_LEVELS` in `modelVariants.ts`); absent = the model's default. */
  effort?: string
}

/** Restrictions a run must honour. `check()` fails closed when an instance cannot enforce them. */
export interface RunPolicy {
  mode: 'default' | 'plan'
  /** Exact tool allowlist (and optional denylist); absent = the instance's normal tools. */
  tools?: { allow: string[]; deny?: string[] }
  approvals: 'ask' | 'grants' | 'never'
  budget?: { maxTurns?: number; maxUsd?: number; maxWallMs?: number }
}

/**
 * The immutable binding one RunEngine attempt runs on, resolved at admission. Retries, steering,
 * interrupt-restart and forks of that attempt reuse it and never reread mutable defaults or config.
 */
export interface ExecutionBinding {
  instanceId: string
  driver: HarnessDriverKind
  /** Bumped when the instance's signed-in account changes. */
  accountGeneration: number
  /** Stable id of the instance home (`default` for the user's own home). */
  homeId: string
  /** Bumped when the instance config changes. */
  configRevision: number
  model: string
  effort?: string
  policy: RunPolicy
}

/** Why the gateway could not serve a request. Typed so callers never parse messages. */
export const HARNESS_ERROR_CODES = [
  'instance_unknown',
  'instance_disabled',
  'not_installed',
  'override_not_found',
  'wont_run',
  'signed_out',
  'auth_expired',
  'rate_limited',
  'context_overflow',
  'model_unavailable',
  'model_hidden',
  'policy_unenforceable',
  'operation_busy',
  'operation_unknown',
  'unsupported',
  'protocol',
  'timeout',
  'cancelled',
  'not_implemented'
] as const
export type HarnessErrorCode = (typeof HARNESS_ERROR_CODES)[number]

export interface HarnessError {
  code: HarnessErrorCode
  message: string
  instanceId?: string
  /** `rate_limited`: when the limit resets (ISO time). */
  resetAt?: string
  /** `policy_unenforceable`: the capabilities the instance lacks. */
  missing?: Array<keyof HarnessCaps>
}

const HARNESS_ERROR_CATEGORY: Record<HarnessErrorCode, ErrorCategory> = {
  instance_unknown: 'invalid',
  instance_disabled: 'unavailable',
  not_installed: 'unavailable',
  override_not_found: 'unavailable',
  wont_run: 'unavailable',
  signed_out: 'denied',
  auth_expired: 'denied',
  rate_limited: 'unavailable',
  context_overflow: 'invalid',
  model_unavailable: 'unavailable',
  model_hidden: 'invalid',
  policy_unenforceable: 'unsupported',
  operation_busy: 'conflict',
  operation_unknown: 'invalid',
  unsupported: 'unsupported',
  protocol: 'internal',
  timeout: 'timeout',
  cancelled: 'cancelled',
  not_implemented: 'unsupported'
}

/** The protocol-safe error for a `HarnessError` (its message is audited text, never vendor output). */
export function harnessAppError(error: HarnessError): AppError {
  const { code, message, ...details } = error
  return new AppError({
    code,
    message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    errorInfo: { category: HARNESS_ERROR_CATEGORY[code], retryable: code === 'rate_limited' || code === 'timeout' }
  })
}

/** `check()` result: the policy is enforceable, or the typed reason it is not. */
export type Enforceability = { ok: true } | { ok: false; error: HarnessError & { code: 'policy_unenforceable' } }

/** Which settings layer a read or write applies to. Device is a ceiling; projects only narrow. */
export type ProviderScope = { kind: 'device' } | { kind: 'project'; projectId: string }

/** `<profileHome>/harness/scopes.json`. */
export interface HarnessScopesFile {
  version: 1
  projects: Record<string, ProjectProviderOverrides>
}

export interface ProjectProviderOverrides {
  instances: Record<string, { enabled?: boolean }>
  defaultSelection?: ProviderSelection
}

/** What a model can do; custom models declare it explicitly. */
export interface ModelCapabilities {
  /** Reasoning efforts the model accepts; empty = no effort control. */
  efforts: string[]
  images: boolean
  /** Context window in tokens, when known. */
  contextWindow?: number
}

/** A model the user added by id, with its capabilities stated rather than guessed. */
export interface CustomModel {
  id: string
  label?: string
  capabilities: ModelCapabilities
}

/**
 * Per-instance model preferences, persisted in daemon settings. Hidden models are rejected by
 * `resolve()` for every purpose (composer, delegation, definitions, `/model`).
 */
export interface ModelPrefs {
  hidden: string[]
  /** Display order; models not listed follow in catalog order. */
  order: string[]
  favorites: string[]
  custom: CustomModel[]
}

/** Each present field replaces the stored one. */
export type ModelPrefsPatch = Partial<ModelPrefs>

/** One model of an instance as the page and picker show it, with the prefs applied. */
export interface InstanceModel {
  id: string
  label: string
  source: 'catalog' | 'custom'
  capabilities: ModelCapabilities
  hidden: boolean
  favorite: boolean
}

/** Instance settings the Add dialog and editor change. `null` clears a field back to its default. */
export interface InstanceConfigPatch {
  displayName?: string | null
  /** `default` = the user's own vendor home; `private` = a Mousse-owned home for this instance. */
  home?: 'default' | 'private'
  /** Explicit executable. When it cannot run, the instance reports "Override not found" (no PATH fallback). */
  binaryPath?: string | null
  args?: string[]
  /** Full replacement. */
  env?: Record<string, string>
  loginMethod?: string | null
}

export interface AddInstanceInput {
  driver: HarnessDriverKind
  config?: InstanceConfigPatch
}

/** Long provider operations; each returns an operation id at once and reports through events. */
export type ProviderOperationKind = 'install' | 'update' | 'sign_in'

export interface ProviderOperationStarted {
  operationId: string
  instanceId: string
  kind: ProviderOperationKind
}

/** A step of a sign-in that needs the user. Answered with `respondSignIn`. */
export type SignInPrompt =
  | { promptId: string; type: 'auth_url'; url: string; instructions?: string; usesCallbackServer: boolean; acceptsRedirectPaste?: boolean }
  | { promptId: string; type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { promptId: string; type: 'input'; secret: boolean; message: string; placeholder?: string }
  | { promptId: string; type: 'select'; message: string; options: Array<{ id: string; label: string; description?: string }> }

export interface SignInResponse {
  /** The prompt being answered; absent for `cancel`. */
  promptId?: string
  kind: 'input' | 'select' | 'redirect_url' | 'cancel'
  value?: string
}

/** Progress and completion of one provider operation (`providers.operation`). */
export type ProviderOperationEvent = ProviderOperationStarted & (
  | { phase: 'progress'; message: string; /** 0..1 when known. */ fraction?: number }
  | { phase: 'prompt'; prompt: SignInPrompt }
  | { phase: 'completed' }
  | { phase: 'failed'; error: HarnessError }
  | { phase: 'cancelled' }
)
