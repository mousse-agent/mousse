import type { Enforceability, HarnessCaps, RunPolicy } from '../../shared/harness/types'

/**
 * Capability readers for the two keys the gateway adds to the run engine's eight (SPEC §13.2: every
 * capability key has a reader, and every reader has a caller), and `check()`'s policy rules.
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
 * Whether an instance with `caps` can honour `policy`. Fails closed: a restriction the instance
 * cannot enforce is `policy_unenforceable`, naming the capabilities it lacks. PR 1 instances run
 * their own tools (except the pi loop), so an exact tool allowlist needs strong containment.
 */
export function checkPolicy(caps: HarnessCaps, policy: RunPolicy, instanceId?: string): Enforceability {
  const missing: Array<keyof HarnessCaps> = []
  if (policy.mode === 'plan' && !planModeAvailable(caps)) missing.push('planMode')
  if (policy.tools && caps.containment !== 'strong') missing.push('containment')
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
