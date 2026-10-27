import { createHash } from 'node:crypto'
import type { BotThreadRole } from '../../shared/bots/personal/authority'
import type { CredentialKind, InstanceSnapshot } from '../../shared/harness/status'
import type { NeutralTool } from '../../shared/harness/tools'
import type { Enforceability, HarnessCaps, HarnessError, RunPolicy, TurnOrigin } from '../../shared/harness/types'
import { stableStringify } from '../run/json'
import { supportedPermissionModes, type PermissionMode } from '../../shared/permissionMode'

/**
 * Capability readers for the keys the gateway adds to the run engine's eight (SPEC §13.2: every
 * capability key has a reader, and every reader has a caller), and the policy rules turn admission
 * applies.
 */

/** Whether the composer offers Plan mode, and a plan-mode policy can be enforced. */
export function planModeAvailable(caps: Pick<HarnessCaps, 'planMode'>): boolean {
  return caps.planMode
}

/**
 * Where the context gauge comes from: Mousse's own measurement, the runtime's report, or nowhere
 * (the gauge is hidden rather than fabricated).
 */
export function contextGauge(caps: Pick<HarnessCaps, 'contextUsage'>): HarnessCaps['contextUsage'] {
  return caps.contextUsage
}

/**
 * How far Mousse controls the instance's tools. Caps from before the key existed read as
 * `uncontrolled`: Mousse never assumes control it cannot show.
 */
export function toolControlLevel(caps: Partial<Pick<HarnessCaps, 'toolControl'>>): HarnessCaps['toolControl'] {
  return caps.toolControl ?? 'uncontrolled'
}

/** Whether turn and cost budgets hold on the instance. Caps without the key read as `unsupported`. */
export function budgetsLevel(caps: Partial<Pick<HarnessCaps, 'budgets'>>): HarnessCaps['budgets'] {
  return caps.budgets ?? 'unsupported'
}

/** Whether token and spend limits are reserved before each request. Caps without the key read as `unsupported`. */
export function spendLimitLevel(caps: Partial<Pick<HarnessCaps, 'spendLimits'>>): HarnessCaps['spendLimits'] {
  return caps.spendLimits ?? 'unsupported'
}

/**
 * Whether the instance runs an agent definition's loop itself under the definition's own limits
 * (the legacy engine). Caps without the key read as `none`.
 */
export function definitionLimitsLevel(caps: Partial<Pick<HarnessCaps, 'definitionLimits'>>): HarnessCaps['definitionLimits'] {
  return caps.definitionLimits ?? 'none'
}

/**
 * Purposes a person drives turn by turn. Only these may resolve an `uncontrolled` instance: every
 * other purpose (delegation, definitions, workflows, scheduled jobs, titles, and any purpose added
 * later) runs without a person watching each tool.
 */
export const INTERACTIVE_PURPOSES: ReadonlySet<string> = new Set(['composer', 'default', 'turn', 'channel_model', 'cli_model'])

/** Whether a purpose may run on an instance with these caps. */
export function purposeAllowed(caps: Partial<Pick<HarnessCaps, 'toolControl'>>, purpose: string): boolean {
  return toolControlLevel(caps) !== 'uncontrolled' || INTERACTIVE_PURPOSES.has(purpose)
}

/**
 * Who a thread's turn runs for (PR 6 §2): any bot thread is `bot`, ahead of its lineage, so a
 * consult of a context thread never binds as `delegated`; then a workflow step; then a delegated
 * child (`subagent` lineage); else the person.
 */
export function threadTurnOrigin(thread: { botRole?: BotThreadRole; workflow?: boolean; lineage?: string }): TurnOrigin {
  if (thread.botRole) return 'bot'
  if (thread.workflow) return 'workflow'
  if (thread.lineage === 'subagent') return 'delegated'
  return 'interactive'
}

/** The origin of a policy; bindings recorded before origins existed are interactive. */
export function policyOrigin(policy: Pick<RunPolicy, 'origin'>): TurnOrigin {
  return policy.origin ?? 'interactive'
}

/**
 * What token and spend limits need from the model itself, beyond the instance's `spendLimits`
 * (`DriverRuntime.spendModel`): the driver can bound the output cap the request carries on the wire,
 * and the model has a price.
 */
export interface SpendModelFacts {
  /** The model's name, for the refusal. */
  label: string
  /** The driver can bound the output cap of every request on this model. */
  outputCap: boolean
  /** The model has a non-zero price (a USD limit needs one). */
  priced: boolean
  /** The turn's effort, as the refusal names it. */
  effort?: string
  /**
   * The smallest output cap one request at this effort can be sent with (the thinking budget plus
   * the answer room, on models that add one); a smaller output or USD limit can never fit.
   */
  smallestCap?: number
  /** USD per output token, for the smallest cap against a USD limit. */
  outputUsdPerToken?: number
}

/** The policy has a token or USD limit (`spendLimits`). */
export function hasSpendLimit(policy: Pick<RunPolicy, 'budget'>): boolean {
  const budget = policy.budget ?? {}
  return budget.maxInputTokens !== undefined || budget.maxOutputTokens !== undefined || budget.maxUsd !== undefined
}

/**
 * Why a model cannot hold the policy's token or USD limits, on an instance whose `spendLimits` are
 * `reserved`; undefined when it can. Unknown facts refuse: Mousse never assumes a cap it cannot show.
 */
function spendModelGap(budget: NonNullable<RunPolicy['budget']>, model: SpendModelFacts | undefined): string | undefined {
  if (!model) return 'Mousse cannot tell whether this model caps its output, so token and cost limits cannot be held.'
  if (!model.outputCap) return `${model.label} cannot cap its output, so token and cost limits cannot be held.`
  if (budget.maxUsd !== undefined && !model.priced) return `${model.label} has no price, so a cost limit cannot be held.`
  const smallest = model.smallestCap
  const effort = model.effort && model.effort !== 'off' ? `${model.effort} effort` : 'no thinking'
  if (smallest !== undefined && budget.maxOutputTokens !== undefined && budget.maxOutputTokens < smallest)
    return `${model.label} at ${effort} needs at least ${smallest} output tokens per request, above the limit of ${budget.maxOutputTokens}. Lower the effort or raise the limit.`
  if (smallest !== undefined && budget.maxUsd !== undefined && model.outputUsdPerToken !== undefined && smallest * model.outputUsdPerToken > budget.maxUsd)
    return `${model.label} at ${effort} needs at least ${smallest} output tokens per request, which costs more than the limit of $${budget.maxUsd}. Lower the effort or raise the limit.`
  return undefined
}

/**
 * Whether an instance with `caps` can honour `policy`. Fails closed: a restriction the instance
 * cannot enforce is `policy_unenforceable`, naming the capabilities it lacks.
 * - an exact tool allowlist needs `exact` tool control;
 * - a turn or tool-call count needs `hard` budgets: Mousse refuses the next model request
 *   (compaction, summaries, retries included) or tool call before it starts; a limit checked after
 *   a response is only `observed`;
 * - a token or USD limit needs `hard` budgets and `reserved` spend limits (a conservative reservation
 *   before each request, with the output cap lowered to fit), and a model whose output cap the
 *   driver can bound (`model`); a USD limit also needs a priced model. A model gap is
 *   `spendLimits` with a `reason`;
 * - a wall-clock budget needs nothing: the gateway enforces it everywhere;
 * - a definition authority's counts and token and USD limits are also admitted on an instance
 *   that runs the definition's loop under them (`definitionLimits: 'in_loop'`, the legacy engine);
 * - a host authority (a definition's or a bot's grants, roots and rules) needs `exact` tool
 *   control: only a runtime whose every tool call Mousse decides can be held to it;
 * - pre-granted or no approvals need at least `approval_only` (pre-granted under Full access is what
 *   an uncontrolled instance does anyway);
 * - approvals answered by the host (`approve: 'host'`) need a bot authority and a runtime that
 *   holds every call of the turn to it (`options.hostApprovals`, `HarnessDriver.botAuthority`);
 *   anywhere else nothing would answer them, and the turn would ask the person;
 * - a turn nobody watches (delegated, workflow, definition, bot) needs more than `uncontrolled`,
 *   for its first dispatch and every retry, continuation and steer.
 */
/** Why a policy with `approve: 'host'` is refused where the host cannot answer its approvals. */
export const HOST_APPROVALS_UNAVAILABLE = 'This runtime cannot hold a bot to its permissions, so nothing would answer its approvals.'

export interface CheckPolicyOptions {
  /** The runtime holds every call of a bot turn to its bot authority (`HarnessDriver.botAuthority`). */
  hostApprovals?: boolean
  /** What bot runtimes still lack (default `BOT_RUNTIME_GAPS`); only tests pass another list. */
  botRuntimeGaps?: readonly string[]
}

/**
 * What every runtime still lacks before a bot may run on it (PR 6 §4). While this list is not
 * empty, every bot policy is refused, at approval, at dispatch and at turn admission, whatever the
 * runtime's caps say: a runtime promoted to `exact` tool control does not turn bots on by itself.
 * Each item is removed by the change that builds it.
 */
export const BOT_RUNTIME_GAPS: readonly string[] = Object.freeze([
  'an active-time supervisor that stops a bot at its deadline and its prepaid time outside the daemon loop, with confirmed process exits',
  'bot processes that are never kept warm, launched in their own process group',
  'the locked environment for bot processes'
])

/** Why bots cannot run yet, in plain words. */
export function botRuntimeGapReason(gaps: readonly string[]): string {
  return `Bots can't run yet: Mousse still needs ${gaps.join('; ')}.`
}

export function checkPolicy(caps: HarnessCaps, policy: RunPolicy, instanceId?: string, model?: SpendModelFacts, options: CheckPolicyOptions = {}): Enforceability {
  const missing: Array<keyof HarnessCaps> = []
  const control = toolControlLevel(caps)
  if (policy.mode === 'plan' && !planModeAvailable(caps)) missing.push('planMode')
  const needsExact = Boolean(policy.tools) || Boolean(policy.authority)
  const budget = policy.budget ?? {}
  const needsSpend = hasSpendLimit(policy)
  const needsHardBudget = needsSpend || budget.maxTurns !== undefined || budget.maxToolCalls !== undefined
  // `grants` under Full access is literally "the agent approves its own tools", which an
  // uncontrolled instance does; any other pre-granted or absent approval needs control.
  const needsApprovals = (policy.approvals === 'grants' && policy.permissionMode !== 'full') || policy.approvals === 'never'
  // Only a bot authority answers approvals for the host, and only on a runtime that holds every
  // call to it; anywhere else such a policy is refused rather than left to ask the person.
  const hostApprovals = policy.approve === 'host' && !(policy.authority?.kind === 'bot' && options.hostApprovals === true)
  const unattended = policyOrigin(policy) !== 'interactive'
  if ((needsExact && control !== 'exact') || (needsApprovals && control === 'uncontrolled') || (unattended && control === 'uncontrolled'))
    missing.push('toolControl')
  // A definition on a runtime that runs its loop under the definition's own limits (the legacy
  // engine) is held to them there, as definitions always were (`HarnessCaps.definitionLimits`).
  const inLoop = policy.authority?.kind === 'definition' && definitionLimitsLevel(caps) === 'in_loop'
  if (needsHardBudget && budgetsLevel(caps) !== 'hard' && !inLoop) missing.push('budgets')
  let reason: string | undefined
  if (needsSpend && !inLoop) {
    if (spendLimitLevel(caps) !== 'reserved') missing.push('spendLimits')
    else if ((reason = spendModelGap(budget, model))) missing.push('spendLimits')
  }
  if (hostApprovals) {
    reason = [reason, HOST_APPROVALS_UNAVAILABLE].filter(Boolean).join(' ')
    if (!missing.includes('toolControl')) missing.push('toolControl')
  }
  // Fail closed: no runtime runs a bot until every piece bots rely on exists.
  const gaps = options.botRuntimeGaps ?? BOT_RUNTIME_GAPS
  if (policy.authority?.kind === 'bot' && gaps.length) {
    reason = [reason, botRuntimeGapReason(gaps)].filter(Boolean).join(' ')
    if (!missing.includes('containment')) missing.push('containment')
  }
  if (!missing.length) return { ok: true }
  return {
    ok: false,
    error: {
      code: 'policy_unenforceable',
      message: `This provider cannot enforce the requested restrictions (${missing.join(', ')}).${reason ? ` ${reason}` : ''}`,
      missing,
      ...(reason ? { reason } : {}),
      ...(instanceId ? { instanceId } : {})
    }
  }
}

/**
 * A binding's policy, deep-frozen (PR 6 §2): the attempt and its retries and steers run on exactly
 * this, whatever the caller does with its own object afterwards.
 */
export function freezePolicy(policy: RunPolicy): RunPolicy {
  return deepFreeze(structuredClone(policy))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** SHA-256 (hex) of a policy's canonical JSON (keys sorted, absent members dropped). */
export function policyDigest(policy: RunPolicy): string {
  return createHash('sha256').update(stableStringify(policy)).digest('hex')
}

/**
 * What an instance runs on, for the approval dialog's "Runs on" line and, later, the API-key rule
 * for bots that serve other people. Only a signed-in instance has a kind; the driver tells it from
 * what it already knows (`AuthReading.credential`), never from another check.
 */
export function credentialKind(snapshot: Pick<InstanceSnapshot, 'auth'>): CredentialKind {
  return snapshot.auth.state === 'signed_in' ? snapshot.auth.credential ?? 'unknown' : 'unknown'
}

/**
 * The native names of `tools` on a driver (`HarnessDriver.nativeToolNames`), or the neutral tools it
 * has no name for. Fails closed: a runtime without a mapping maps nothing.
 */
export function mapNeutralTools(
  nativeToolNames: ((neutral: NeutralTool) => readonly string[]) | undefined,
  tools: readonly NeutralTool[]
): { ok: true; names: string[] } | { ok: false; unmapped: NeutralTool[] } {
  const names: string[] = []
  const unmapped: NeutralTool[] = []
  for (const tool of tools) {
    const native = nativeToolNames?.(tool) ?? []
    if (!native.length) unmapped.push(tool)
    for (const name of native) if (!names.includes(name)) names.push(name)
  }
  return unmapped.length ? { ok: false, unmapped } : { ok: true, names }
}

/** The typed refusal of a turn whose permission mode the instance cannot enforce. */
export function permissionModeRefusal(message: string, supported: readonly PermissionMode[], instanceId?: string): HarnessError & { code: 'permission_mode_unenforceable' } {
  return { code: 'permission_mode_unenforceable', message, supportedModes: [...supported], ...(instanceId ? { instanceId } : {}) }
}

/**
 * Whether an instance with `caps` can enforce the permission mode a binding recorded. Fails
 * closed, for the first dispatch and every retry, continuation and steer: an instance that approves
 * tools itself runs only in Full access. Bindings recorded before permission modes carry none and
 * are not checked (they ran as they did then).
 */
export function checkPermissionMode(caps: Partial<Pick<HarnessCaps, 'toolControl'>>, policy: Pick<RunPolicy, 'permissionMode'>, agent: string, instanceId?: string): { ok: true } | { ok: false; error: HarnessError & { code: 'permission_mode_unenforceable' } } {
  const mode = policy.permissionMode
  if (mode === undefined) return { ok: true }
  const supported = supportedPermissionModes(caps)
  if (supported.includes(mode)) return { ok: true }
  return { ok: false, error: permissionModeRefusal(`${agent} approves tools itself; set this thread to Full access or pick another agent.`, supported, instanceId) }
}
