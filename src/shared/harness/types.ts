import { AppError, type ErrorCategory } from '../errors'
import type { AgentExecutionLimit } from '../agents/execution'
import type { PermissionMode } from '../permissionMode'
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
 * outside the drivers (`tests/run/capabilityReaders.test.ts`). All but `planMode` and
 * `contextUsage` keep the meaning of `ProviderCapabilities` in `run/adapters/ProviderAdapter.ts`.
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
  /**
   * `enforced`: the instance holds a delegated child to its policy (read-only for a `shared`
   * child). `isolated_only`: it cannot, so it is refused as the target of a `shared` child.
   */
  childPolicy: 'enforced' | 'isolated_only'
  /** The composer offers Plan mode for this instance. */
  planMode: boolean
  /**
   * Context gauge source: `reported` when the runtime reports its context and window, `none` when
   * it publishes neither (the gauge is hidden rather than fabricated).
   */
  contextUsage: 'reported' | 'none'
  /**
   * How far Mousse controls which tools the runtime runs: `exact` (Mousse runs the tools: an exact
   * allowlist holds), `approval_only` (the runtime asks Mousse before each tool, with its permission
   * mode pinned), `uncontrolled` (the runtime approves tools itself). An uncontrolled instance runs
   * interactive turns only.
   */
  toolControl: 'exact' | 'approval_only' | 'uncontrolled'
  /**
   * Count budgets (`RunPolicy.budget.maxTurns|maxToolCalls`). `hard` = Mousse refuses the next model
   * request (compaction, summaries, retries included) or tool call before it starts. A limit checked
   * after a response is `observed`. `unsupported`: neither. A wall-clock budget is the gateway's own
   * and applies everywhere.
   */
  budgets: 'hard' | 'observed' | 'unsupported'
  /**
   * Token and spend limits (`RunPolicy.budget.maxInputTokens|maxOutputTokens|maxUsd`): `reserved` =
   * before each model request Mousse reserves a conservative cost and lowers the output cap to fit
   * what is left. They also need `budgets: 'hard'`.
   */
  spendLimits: 'reserved' | 'unsupported'
}

/**
 * The capability keys the run engine reads (`CommandPolicy`, `policy/featureGates`, handoffs): the
 * keys of `HarnessCaps` an adapter's `ProviderCapabilities` also has.
 */
export type RunCapabilities = Pick<
  HarnessCaps,
  'steer' | 'interrupt' | 'rollback' | 'fork' | 'events' | 'containment' | 'historyInjection' | 'mcp' | 'childPolicy'
>

export const HARNESS_CAP_KEYS = [
  'steer', 'interrupt', 'rollback', 'fork', 'events', 'containment', 'historyInjection', 'mcp', 'childPolicy', 'planMode', 'contextUsage', 'toolControl', 'budgets', 'spendLimits'
] as const satisfies ReadonlyArray<keyof HarnessCaps>

/** What a caller picks to run an agent. */
export interface ProviderSelection {
  instanceId: string
  model: string
  /** Reasoning effort (`EFFORT_LEVELS` in `modelVariants.ts`); absent = the model's default. */
  effort?: string
}

/**
 * Who started the turn: a person in a chat (`interactive`), a delegated child, a workflow step, an
 * agent definition, a bot or a scheduled job (`schedule`). Retries, continuations and steers of a
 * turn keep its origin.
 */
export type TurnOrigin = 'interactive' | 'delegated' | 'workflow' | 'definition' | 'bot' | 'schedule'

/** Restrictions a run must honour. Turn admission fails closed when an instance cannot enforce them. */
export interface RunPolicy {
  mode: 'default' | 'plan'
  /** Absent on bindings recorded before origins existed: they read as `interactive`. */
  origin?: TurnOrigin
  /** Exact tool allowlist (and optional denylist); absent = the instance's normal tools. */
  tools?: { allow: string[]; deny?: string[] }
  /**
   * Tools that need the user's approval: ask the user, allow them as granted, or refuse them all
   * without asking (`never`: the turn bridge denies every permission request).
   */
  approvals: 'ask' | 'grants' | 'never'
  /**
   * Who answers a call that needs approval under `grants`: the host's own authority for the turn
   * (an agent definition's or a bot's, registered with the turn's app tools), never a person.
   * `checkPolicy` refuses it until the runtimes answer approvals that way.
   */
  approve?: 'host'
  /**
   * The permission mode the run enforces: the thread's mode, or the nearest stricter one the
   * instance supports. Absent on bindings recorded before permission modes: they read as Ask.
   */
  permissionMode?: PermissionMode
  /** The mode the thread asked for, when `permissionMode` is a stricter fallback. */
  requestedPermissionMode?: PermissionMode
  budget?: { maxTurns?: number; maxToolCalls?: number; maxInputTokens?: number; maxOutputTokens?: number; maxUsd?: number; maxWallMs?: number }
  /**
   * The turn runs under a host authority (an agent definition's or a bot's grants, roots and rules),
   * named by kind and the digest of what was approved. The authority itself is registered with the
   * turn's app tools, never carried in the policy. It needs `toolControl: exact`.
   */
  authority?: PolicyAuthority
}

/** `RunPolicy.authority`. */
export interface PolicyAuthority {
  kind: 'definition' | 'bot'
  digest: string
}

/** The caller's part of a binding's policy (`HarnessGateway.bind`): mode and origin are bound separately. */
export type BindPolicy = Pick<RunPolicy, 'tools' | 'approvals' | 'approve' | 'budget' | 'authority'>

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
  /**
   * The signed-in account when the binding was made: a salted one-way hash of the vendor's stable
   * account id and the home, never the id or email itself. Absent when the account could not be
   * established; a native session is then never resumed (the history is handed over instead).
   */
  accountId?: string
  model: string
  effort?: string
  /** Frozen when the binding is made: every attempt, retry and steer of the run holds to it. */
  policy: RunPolicy
  /**
   * SHA-256 of the policy's canonical JSON, when the caller gave a policy (definitions, workflows,
   * bots; `bind(…, {policy})`). A thread whose next binding has another digest gets a new Mousse MCP
   * epoch, so a runtime never keeps a tool list from an earlier grant. A stored binding whose policy
   * no longer matches its digest is refused.
   */
  policyDigest?: string
  /**
   * The instance's capabilities when the binding was made: an attempt runs on them even when the
   * runtime's facts change meanwhile. Absent on bindings from before snapshots (live caps apply).
   */
  caps?: HarnessCaps
  /** Revision of the runtime facts the snapshot came from (0: none yet). */
  factsRevision?: number
  /** The executable the binding was made with; a retry after it changed is `binding_stale`. */
  binary?: BinaryFingerprint
}

/** Identifies one executable file: a self-update in place changes its size or modification time. */
export interface BinaryFingerprint {
  path: string
  size: number
  mtimeMs: number
}

/**
 * What a runtime told Mousse about itself for one instance (ACP `initialize`, `session/new`).
 * Kept per instance, because launch arguments, environment and sign-in change it; dropped when the
 * instance's config revision, account generation or executable changes.
 */
export interface RuntimeFacts {
  instanceId: string
  configRevision: number
  accountGeneration: number
  binary: BinaryFingerprint
  protocolVersion?: number
  /** The agent's own name and version, when it announced them. */
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: Record<string, unknown>
  authMethods?: Array<{ id: string; name: string; type?: string; description?: string; vars?: string[] }>
  configOptions?: unknown[]
  modes?: Array<{ id: string; name: string }>
  models?: Array<{ id: string; label: string }>
  capturedAt: string
  source: 'handshake' | 'session'
}

/** What a runtime or Mousse tool tells the model when a run refuses tools that need approval (`approvals: 'never'`). */
export const APPROVALS_REFUSED_MESSAGE = 'Tools that need approval are refused here.'

/** What the model is told when it asks the user a question in a run nobody answers (`approvals: 'never'`). */
export const QUESTIONS_REFUSED_MESSAGE = 'Nobody can answer questions here. Continue without asking.'

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
  /** The account may not use the provider through this route (a plan or client that is not eligible). */
  'not_eligible',
  /** The provider's service is down or overloaded; the credentials are kept. */
  'service_unavailable',
  'context_overflow',
  'model_unavailable',
  'model_hidden',
  'policy_unenforceable',
  /** The thread's permission mode needs more control than the instance has (it approves tools itself). */
  'permission_mode_unenforceable',
  'operation_busy',
  'operation_unknown',
  'unsupported',
  'protocol',
  'timeout',
  'cancelled',
  'not_implemented',
  /** A retry or recovery cannot run on its run's binding: the instance's config, home or account changed. */
  'binding_stale',
  /** No model is selected and the profile has no default model. */
  'no_model_selected',
  /** A turn, tool-call, token or cost limit refused the next step (`HarnessError.limit`). */
  'budget_exhausted',
  /** The connection was retired by a Mousse update and must be moved before it runs again. */
  'provider_retired'
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
  /**
   * `policy_unenforceable`: why, when the gap is not a missing capability of the instance but a
   * fact of the model (it has no price, or its output cannot be capped).
   */
  reason?: string
  /** `budget_exhausted`: the limit that refused the next step, and what was used when known. */
  limit?: AgentExecutionLimit
  /**
   * The runtime's own retries of a provider request ran out (Pi's, as Mousse configured them). The
   * turn shows the connection-failed retry affordance, and no turn-level retry runs again.
   */
  retriesExhausted?: true
  /** `permission_mode_unenforceable`: the modes the instance can enforce. */
  supportedModes?: PermissionMode[]
}

/** A turn error whose details say the runtime's own request retries ran out (`HarnessError.retriesExhausted`). */
export function isRetriesExhausted(error: unknown): boolean {
  return error instanceof AppError && (error.details as { retriesExhausted?: unknown } | undefined)?.retriesExhausted === true
}

/**
 * The instance id that runs and provider refs carried when a turn with no selection ran on the bare
 * pi loop. That route is gone: such a record never resolves again (a binding is `binding_stale`, a
 * ref is not active), and the thread's next turn resolves the default model.
 */
const RETIRED_BARE_ROUTE_ID = 'pi'

/** Whether a stored binding or ref was made on the retired bare pi route. */
export function onRetiredBareRoute(instanceId: string | undefined): boolean {
  return instanceId === RETIRED_BARE_ROUTE_ID
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
  not_eligible: 'denied',
  service_unavailable: 'unavailable',
  context_overflow: 'invalid',
  model_unavailable: 'unavailable',
  model_hidden: 'invalid',
  policy_unenforceable: 'unsupported',
  permission_mode_unenforceable: 'unsupported',
  operation_busy: 'conflict',
  operation_unknown: 'invalid',
  unsupported: 'unsupported',
  protocol: 'internal',
  timeout: 'timeout',
  cancelled: 'cancelled',
  not_implemented: 'unsupported',
  binding_stale: 'conflict',
  no_model_selected: 'invalid',
  budget_exhausted: 'denied',
  provider_retired: 'unsupported'
}

/** The protocol-safe error for a `HarnessError` (its message is audited text, never vendor output). */
export function harnessAppError(error: HarnessError): AppError {
  const { code, message, ...details } = error
  return new AppError({
    code,
    message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    errorInfo: { category: HARNESS_ERROR_CATEGORY[code], retryable: code === 'rate_limited' || code === 'timeout' || code === 'service_unavailable' }
  })
}

/** `checkPolicy()` result: the policy is enforceable, or the typed reason it is not. */
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

/**
 * Each present list field replaces the stored one. `star`/`unstar` and `hide`/`unhide` add or
 * remove ids against the stored lists instead, so overlapping saves (a reorder and a star, two
 * stars) never write back a stale copy of another field or of each other.
 */
export interface ModelPrefsPatch extends Partial<ModelPrefs> {
  star?: string[]
  unstar?: string[]
  hide?: string[]
  unhide?: string[]
}

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
  /** An ACP agent from the registry (`acp` instances): a new version or agent replaces the old one. */
  source?: RegistrySourcePatch
  /**
   * Codex: `managed` (Mousse downloads Codex and signs in with ChatGPT itself, in a home of its
   * own) or `existing` (the user's Codex CLI). Set when the entry is added; it cannot change.
   */
  setup?: 'managed' | 'existing'
  /**
   * Takes the settings an older Mousse version left in the provider's own settings file
   * (`InstanceSnapshot.settingsNotice` `older_conflict`); every other field is ignored.
   */
  useOlderSettings?: true
  /**
   * A model API's provider (`pi`), at add only: the entry's id carries it (`pi:<provider>`), so it is
   * never stored and never changes.
   */
  provider?: string
}

/**
 * Registry agent ids Mousse keeps for its own managed runtimes: such a registry agent can never be
 * added or installed, so its files and entries never mix with Mousse's own (a managed Codex).
 */
export const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(['codex'])

export function reservedAgentMessage(agentId: string): string {
  return `The registry agent "${agentId}" cannot be added: Mousse runs it as its own entry. Add the ChatGPT subscription provider instead.`
}

/**
 * An agent the ACP registry lists, installed by Mousse. `consent` records that the user accepted
 * an artifact without a registry checksum; it covers that version and download only.
 */
export interface RegistrySourcePatch {
  kind: 'registry'
  agentId: string
  version: string
  distribution: 'binary' | 'npx'
  consent?: { version: string; artifactUrl: string }
}

/** How a registry agent is fetched: a checked download, an unchecked one, or an npm package. */
export type RegistryChecksum = 'registry' | 'none'

/** One agent of the ACP registry as the "More ACP agents" step shows it, for this computer. */
export interface RegistryAgentView {
  id: string
  name: string
  version: string
  description: string
  authors: string[]
  license?: string
  website?: string
  repository?: string
  /** What Mousse would install here; `uvx` and unsupported archives are listed but cannot be added. */
  distribution: 'binary' | 'npx' | 'uvx'
  checksum: RegistryChecksum
  /** The download, for binary agents (shown in the confirm step and recorded with consent). */
  artifactUrl?: string
  /** The npm package, for npx agents (`name@version`). */
  package?: string
  /** What the agent starts with, after Mousse drops variables it never passes on. */
  args: string[]
  env: Record<string, string>
  /** Why it cannot be added here; absent when it can. */
  unsupported?: string
}

/** `instances.removeInstall`: deleted, or still used by other entries (`force` deletes anyway). */
export type RemoveInstallResult =
  | { removed: true; bytes: number }
  | { removed: false; usedBy: Array<{ profileId: string; profileName?: string; entries: number }> }

export interface AddInstanceInput {
  driver: HarnessDriverKind
  config?: InstanceConfigPatch
  /** The id's slug (`claude:api`), when it should not come from the display name. */
  slug?: string
  /**
   * `ambient`: add only once the environment's cloud credentials check out, and save them as the
   * entry's credential. A failed check adds nothing.
   */
  signIn?: 'ambient'
}

/** How an Add option signs in once added: a pasted key, a browser sign-in, or the environment's credentials. */
export type AddOptionMethod = 'api_key' | 'oauth' | 'ambient'

/**
 * One provider the Add dialog and the CLI offer (`providers.catalog.addOptions`). `add` is the exact
 * input for `providers.instances.add`, so no client builds an id or branches on a name.
 */
export interface ProviderAddOption {
  id: string
  label: string
  description?: string
  methods: AddOptionMethod[]
  /** `api_key` runs the provider's guided sign-in (`instances.signIn`) instead of a pasted key. */
  guidedKey?: true
  /** Where the environment's credentials come from (`ambient`). */
  ambientInfo?: { label: string; instructions: string[] }
  add: AddInstanceInput
  /** The id `add` gives the entry, so a client finds the option of an entry without building ids. */
  instanceId: string
  /** Already an entry of this profile (removed entries are not). */
  added: boolean
  /** A key for it is saved on this device already (shared by the profiles), so no key needs typing. */
  hasSavedKey: boolean
  /** Mousse runs this provider as that agent (Anthropic → Claude Code): it is added as the agent, not as a model API. */
  runsAs?: HarnessDriverKind
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
  | {
      promptId: string
      type: 'auth_url'
      url: string
      instructions?: string
      usesCallbackServer: boolean
      acceptsRedirectPaste?: boolean
      /** What the paste field asks for, when the sign-in said (a code or the redirect address). */
      pasteMessage?: string
    }
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
  | { phase: 'progress'; message: string; /** 0..1 when known. */ fraction?: number; receivedBytes?: number; totalBytes?: number }
  | { phase: 'prompt'; prompt: SignInPrompt }
  | { phase: 'completed'; /** Done, with something the user should know (a sign-in saved while its old one waits). */ warning?: string }
  | { phase: 'failed'; error: HarnessError }
  | { phase: 'cancelled' }
)
