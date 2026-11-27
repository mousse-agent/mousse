import { isResumeSource } from './delegation/sources'
import type { RunStore } from './RunStore'
import type { RunRecord } from './types'

/** Sources of a run that carries on the work of the thread's previous run without a person asking for it. */
const CARRY_ON_SOURCES: ReadonlySet<string> = new Set(['wake', 'provider-continuation'])

/** The run a new run carries on: the paused run it resumes, or the thread's latest for a carry-on source. */
function carriedOn(store: RunStore, threadId: string, source: string, continuationOf?: string): RunRecord | null | undefined {
  if (continuationOf && isResumeSource(source)) return store.getRun(continuationOf)
  if (CARRY_ON_SOURCES.has(source)) return store.listRuns(threadId, { limit: 1 })[0]
  return undefined
}

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
  const hops = carriedOn(store, threadId, source, continuationOf)?.outcome?.agentHops
  return typeof hops === 'number' && hops > 0 ? hops : undefined
}

/**
 * The chain (`AgentChains`) a run no agent message started stays in, by the same rule as `inheritedAgentHops`: a wake, a
 * provider's continuation or a resume never starts a fresh one. Call before the new run is created.
 */
export function inheritedAgentChain(store: RunStore, threadId: string, source: string, continuationOf?: string): string | undefined {
  const earlier = carriedOn(store, threadId, source, continuationOf)
  return earlier ? earlier.outcome?.agentChain ?? `chain:${earlier.runId}` : undefined
}
