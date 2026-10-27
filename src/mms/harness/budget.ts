import type { AgentExecutionLimit } from '../../shared/agents/execution'
import type { RunPolicy } from '../../shared/harness/types'

/**
 * Hard count budgets (PR 4 §5a, `budgets: 'hard'`): a runtime asks before each model request and
 * each tool call, and the next one is refused before it starts once a limit is reached.
 *
 * The counts live in a `CounterScope`. By default it is the run's own (`RunCounters`); a caller
 * that shares one allowance across several runs (PR 6's bot activations) hands its own scope to
 * the turn instead (`TurnSpec.counters`). Which limit refused, and when, is recorded per run in
 * `TurnBudget.exhausted`, the record a turn's error reads, never a runtime's text.
 */

export type CountKind = 'request' | 'tool'
export type CountLimitKey = 'maxTurns' | 'maxToolCalls'

/** Counts that may be shared across runs. One call is one atomic compare-and-increment. */
export interface CounterScope {
  /**
   * Counts one `kind`, unless the count already reached the scope's `limitKey` limit: then nothing
   * is counted and the step is refused. Without a limit key it always counts.
   */
  charge(kind: CountKind, limitKey?: CountLimitKey): 'ok' | 'refused'
}

export type CountLimits = Pick<NonNullable<RunPolicy['budget']>, 'maxTurns' | 'maxToolCalls'>

/** The count limits of a policy, or undefined when it has none. */
export function countLimitsOf(policy: Pick<RunPolicy, 'budget'>): CountLimits | undefined {
  const { maxTurns, maxToolCalls } = policy.budget ?? {}
  if (maxTurns === undefined && maxToolCalls === undefined) return undefined
  return { ...(maxTurns !== undefined ? { maxTurns } : {}), ...(maxToolCalls !== undefined ? { maxToolCalls } : {}) }
}

/** A run's own counts, held to its policy's limits. */
export class RunCounters implements CounterScope {
  requests = 0
  toolCalls = 0

  constructor(private readonly limits: CountLimits) {}

  charge(kind: CountKind, limitKey?: CountLimitKey): 'ok' | 'refused' {
    const limit = limitKey ? this.limits[limitKey] : undefined
    const count = kind === 'request' ? this.requests : this.toolCalls
    if (limit !== undefined && count >= limit) return 'refused'
    if (kind === 'request') this.requests += 1
    else this.toolCalls += 1
    return 'ok'
  }
}

export type BudgetDecision = { ok: true } | { ok: false; limit: AgentExecutionLimit }

/**
 * One run's hard count budget, as a runtime sees it: `request()` before each model request (agent
 * requests, compactions, summaries and the runtime's own retries alike), `toolCall()` before each
 * allowed tool call. Once any limit refused a step, every later request and tool call of the run
 * is refused with that same limit.
 */
export class TurnBudget {
  private recorded: AgentExecutionLimit | undefined

  constructor(readonly limits: CountLimits, private readonly scope: CounterScope) {}

  /** The limit that refused a step of this run, if one did. */
  get exhausted(): AgentExecutionLimit | undefined {
    return this.recorded
  }

  request(): BudgetDecision {
    return this.step('request', 'maxTurns', 'turns')
  }

  toolCall(): BudgetDecision {
    return this.step('tool', 'maxToolCalls', 'tool_calls')
  }

  private step(kind: CountKind, key: CountLimitKey, limitKind: AgentExecutionLimit['kind']): BudgetDecision {
    if (this.recorded) return { ok: false, limit: this.recorded }
    const limit = this.limits[key]
    if (this.scope.charge(kind, limit !== undefined ? key : undefined) === 'ok') return { ok: true }
    // Only a limit that exists can refuse; a shared scope that refuses without one is held to the
    // policy's own number as well (0 when the policy has none).
    this.recorded = { kind: limitKind, limit: limit ?? 0, actual: limit ?? 0 }
    return { ok: false, limit: this.recorded }
  }
}

/** How many finished runs keep their own counters (a later attempt of the same run continues them). */
const KEPT_RUNS = 256

/**
 * The runs' own counters, by run id: every attempt of a run (a retry, a recovery) shares one, so a
 * new attempt never gets a fresh allowance. Bounded: the oldest runs are dropped first.
 */
export class RunCounterBook {
  private readonly runs = new Map<string, { limits: string; budget: TurnBudget }>()

  constructor(private readonly kept = KEPT_RUNS) {}

  /** The run's budget under `limits`; a scope given by the caller replaces the run's own counters. */
  budgetFor(runId: string, limits: CountLimits, scope?: CounterScope): TurnBudget {
    if (scope) return new TurnBudget(limits, scope)
    const key = JSON.stringify([limits.maxTurns ?? null, limits.maxToolCalls ?? null])
    const existing = this.runs.get(runId)
    if (existing && existing.limits === key) {
      // Most recently used last.
      this.runs.delete(runId)
      this.runs.set(runId, existing)
      return existing.budget
    }
    const budget = new TurnBudget(limits, new RunCounters(limits))
    this.runs.set(runId, { limits: key, budget })
    while (this.runs.size > this.kept) this.runs.delete(this.runs.keys().next().value as string)
    return budget
  }
}
