import { isResumeSource } from './delegation/sources'
import type { RunStore } from './RunStore'

/** Sources of a run that carries on the work of the thread's previous run without a person asking for it. */
const CARRY_ON_SOURCES: ReadonlySet<string> = new Set(['wake', 'provider-continuation'])

/**
 * How many agent messages in a row led to a run that no agent message started (SPEC §15.1): a run that carries on the
 * thread's previous work continues that chain, so the limit on agent messages cannot be reset by a wake that delivers a
 * subagent's result, a provider's own continuation, or the resume after a usage-limit pause. A person's message, and a
 * person's "Continue", start a chain of their own: undefined. Call before the new run is created, so the thread's latest
 * run is still the previous one.
 */
export function inheritedAgentHops(
  store: RunStore,
  threadId: string,
  source: string,
  continuationOf?: string
): number | undefined {
  let earlier
  if (continuationOf && isResumeSource(source)) earlier = store.getRun(continuationOf)
  else if (CARRY_ON_SOURCES.has(source)) earlier = store.listRuns(threadId, { limit: 1 })[0]
  const hops = earlier?.outcome?.agentHops
  return typeof hops === 'number' && hops > 0 ? hops : undefined
}
