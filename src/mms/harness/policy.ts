import type { Enforceability, HarnessCaps, RunPolicy, TurnOrigin } from '../../shared/harness/types'

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
 * Purposes a person drives turn by turn. Only these may resolve an `uncontrolled` instance: every
 * other purpose (delegation, definitions, workflows, titles, and any purpose added later) runs
 * without a person watching each tool.
 */
export const INTERACTIVE_PURPOSES: ReadonlySet<string> = new Set(['composer', 'default', 'turn', 'channel_model', 'cli_model'])

/** Whether a purpose may run on an instance with these caps. */
export function purposeAllowed(caps: Partial<Pick<HarnessCaps, 'toolControl'>>, purpose: string): boolean {
  return toolControlLevel(caps) !== 'uncontrolled' || INTERACTIVE_PURPOSES.has(purpose)
}

/** The origin of a policy; bindings recorded before origins existed are interactive. */
export function policyOrigin(policy: Pick<RunPolicy, 'origin'>): TurnOrigin {
  return policy.origin ?? 'interactive'
}

/**
 * Whether an instance with `caps` can honour `policy`. Fails closed: a restriction the instance
 * cannot enforce is `policy_unenforceable`, naming the capabilities it lacks.
 * - an exact tool allowlist needs `exact` tool control;
 * - a turn or tool-call count needs `hard` budgets: Mousse refuses the next model request
 *   (compaction, summaries, retries included) or tool call before it starts; a limit checked after
 *   a response is only `observed`;
 * - a token or USD limit needs `hard` budgets and `reserved` spend limits (a conservative reservation
 *   before each request, with the output cap lowered to fit);
 * - a wall-clock budget needs nothing: the gateway enforces it everywhere;
 * - pre-granted or no approvals need at least `approval_only`;
 * - a turn nobody watches (delegated, workflow, definition, bot) needs more than `uncontrolled`,
 *   for its first dispatch and every retry, continuation and steer.
 */
export function checkPolicy(caps: HarnessCaps, policy: RunPolicy, instanceId?: string): Enforceability {
  const missing: Array<keyof HarnessCaps> = []
  const control = toolControlLevel(caps)
  if (policy.mode === 'plan' && !planModeAvailable(caps)) missing.push('planMode')
  const needsExact = Boolean(policy.tools)
  const budget = policy.budget ?? {}
  const needsSpend = budget.maxInputTokens !== undefined || budget.maxOutputTokens !== undefined || budget.maxUsd !== undefined
  const needsHardBudget = needsSpend || budget.maxTurns !== undefined || budget.maxToolCalls !== undefined
  const needsApprovals = policy.approvals === 'grants' || policy.approvals === 'never'
  const unattended = policyOrigin(policy) !== 'interactive'
  if ((needsExact && control !== 'exact') || (needsApprovals && control === 'uncontrolled') || (unattended && control === 'uncontrolled'))
    missing.push('toolControl')
  if (needsHardBudget && budgetsLevel(caps) !== 'hard') missing.push('budgets')
  if (needsSpend && spendLimitLevel(caps) !== 'reserved') missing.push('spendLimits')
  if (!missing.length) return { ok: true }
  return {
    ok: false,
    error: {
      code: 'policy_unenforceable',
      message: `This provider cannot enforce the requested restrictions (${missing.join(', ')}).`,
      missing,
      ...(instanceId ? { instanceId } : {})
    }
  }
}
