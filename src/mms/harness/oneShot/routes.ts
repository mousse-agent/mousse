import type { OneShotRouteDecision, RouteFacts } from './route'

/**
 * The routes this slice runs on the runner, with their facts, and the legacy route every other provider keeps until
 * its own slice. See the providers table in docs/plans/one-shots-every-provider.md.
 */

/** Pi: one pi-ai request in Mousse's process, with no tool offered. */
export const PI_DIRECT_FACTS: RouteFacts = Object.freeze({ tools: 'none_offered', attempts: 'one', isolation: 'verified', launch: 'in_process', audience: 'any' })

/** A local server's model on Pi: the same request, for the threads that run on it only. */
export const PI_LOCAL_FACTS: RouteFacts = Object.freeze({ ...PI_DIRECT_FACTS, audience: 'own_threads' })

/**
 * Any ACP agent known only by its command (`acpOneShot`): its own tools can't be removed, so Mousse refuses what passes
 * through it and ends the request at the first one it reports; it may retry below Mousse; only its environment is
 * sealed. Best-effort.
 */
export const GENERIC_ACP_FACTS: RouteFacts = Object.freeze({ tools: 'detected_on_report', attempts: 'unenforced', isolation: 'env_only', launch: 'sealed_child', audience: 'any' })

/** A provider still on its own one-shot code (`DriverRuntime.oneShot`), admitted with no facts claimed. */
export function legacyOneShotRoute(driver: string): () => OneShotRouteDecision {
  const decision: OneShotRouteDecision = Object.freeze({ route: Object.freeze({ id: `legacy:${driver}` as const }) })
  return () => decision
}
