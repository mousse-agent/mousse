import type { AgentExecutionLimit } from '../../shared/agents/execution'
import type { RunPolicy } from '../../shared/harness/types'

/**
 * Hard count budgets (PR 4 §5a, `budgets: 'hard'`): a runtime asks before each model request and
 * each tool call, and the next one is refused before it starts once a limit is reached.
 *
 * The counts live in a `CounterScope`. By default it is the run's own (`RunCounters`); a caller
 * that shares one allowance across several runs (PR 6's bot activations) hands its own scope to
 * the turn instead (`TurnSpec.counters`). Either way the binding's own limit is passed to every
 * charge, so a shared scope can only narrow it, never widen it. Which limit refused, and when, is
 * recorded per run (`TurnBudget.exhausted`), the record a turn's error reads, never a runtime's
 * text.
 */

export type CountKind = 'request' | 'tool'
export type CountLimitKey = 'maxTurns' | 'maxToolCalls'

/** One charge: counted (`count` is the count now), or refused at `limit` with `count` already used. */
export type ChargeResult = { ok: true; count: number } | { ok: false; count: number; limit: number }

/** Counts that may be shared across runs. One call is one atomic compare-and-increment. */
export interface CounterScope {
  /**
   * Counts one `kind` unless its count already reached `limit` (the binding's own number) or the
   * scope's own allowance for it, whichever is lower: then nothing is counted and the step is
   * refused, with the count and the threshold that refused. Without `limit` only the scope's own
   * allowance applies.
   */
  charge(kind: CountKind, limit?: number): ChargeResult
}

export type CountLimits = Pick<NonNullable<RunPolicy['budget']>, 'maxTurns' | 'maxToolCalls'>

/** The count limits of a policy, or undefined when it has none. */
export function countLimitsOf(policy: Pick<RunPolicy, 'budget'>): CountLimits | undefined {
  const { maxTurns, maxToolCalls } = policy.budget ?? {}
  if (maxTurns === undefined && maxToolCalls === undefined) return undefined
  return { ...(maxTurns !== undefined ? { maxTurns } : {}), ...(maxToolCalls !== undefined ? { maxToolCalls } : {}) }
}

/** Plain counts with no allowance of their own: only the limit given with each charge refuses. */
export class RunCounters implements CounterScope {
  requests = 0
  toolCalls = 0

  charge(kind: CountKind, limit?: number): ChargeResult {
    const count = kind === 'request' ? this.requests : this.toolCalls
    if (limit !== undefined && count >= limit) return { ok: false, count, limit }
    if (kind === 'request') this.requests += 1
    else this.toolCalls += 1
    return { ok: true, count: count + 1 }
  }
}

export type BudgetDecision = { ok: true } | { ok: false; limit: AgentExecutionLimit }

/** The part of a run's budget every attempt shares: its counts and the limit that refused, once one did. */
interface RunBudgetState {
  scope: CounterScope
  exhausted?: AgentExecutionLimit
}

/**
 * One run's hard count budget, as a runtime sees it: `request()` before each model request (agent
 * requests, compactions, summaries and the runtime's own retries alike), `toolCall()` before each
 * allowed tool call. Once any limit refused a step, every later request and tool call of the run
 * is refused with that same limit.
 */
export class TurnBudget {
  private readonly state: RunBudgetState
  /** The run's record was lost (dropped, settled, or from before a restart): every step is refused. */
  lost = false

  constructor(readonly limits: CountLimits, scope: CounterScope | RunBudgetState) {
    this.state = 'charge' in scope ? { scope } : scope
  }

  /**
   * A budget that refuses everything: the run's counts are no longer known (its record was dropped),
   * so it never starts again from zero.
   */
  static lost(limits: CountLimits): TurnBudget {
    const budget = new TurnBudget(limits, { charge: (_kind, limit) => ({ ok: false, count: limit ?? 0, limit: limit ?? 0 }) })
    budget.lost = true
    budget.state.exhausted = limits.maxTurns !== undefined ? { kind: 'turns', limit: limits.maxTurns } : { kind: 'tool_calls', limit: limits.maxToolCalls ?? 0 }
    return budget
  }

  /** The limit that refused a step of this run, if one did. */
  get exhausted(): AgentExecutionLimit | undefined {
    return this.state.exhausted
  }

  request(): BudgetDecision {
    return this.step('request', 'maxTurns', 'turns')
  }

  toolCall(): BudgetDecision {
    return this.step('tool', 'maxToolCalls', 'tool_calls')
  }

  private step(kind: CountKind, key: CountLimitKey, limitKind: AgentExecutionLimit['kind']): BudgetDecision {
    if (this.state.exhausted) return { ok: false, limit: this.state.exhausted }
    const limit = this.limits[key]
    const charged = this.state.scope.charge(kind, limit)
    // Narrow, never widen: a scope that counted past the binding's limit is refused all the same.
    if (charged.ok && limit !== undefined && charged.count > limit) {
      this.state.exhausted = { kind: limitKind, limit, actual: charged.count - 1 }
      return { ok: false, limit: this.state.exhausted }
    }
    if (charged.ok) return { ok: true }
    // The scope's own numbers: the threshold that refused and the count already used.
    this.state.exhausted = { kind: limitKind, limit: charged.limit, actual: charged.count }
    return { ok: false, limit: this.state.exhausted }
  }
}

/** How many runs with no attempt in flight and no final settlement keep their counts. */
const KEPT_IDLE_RUNS = 1024
/** How many dropped run ids are remembered, so a run that comes back fails closed. */
const KEPT_TOMBSTONES = 16_384

interface RunEntry {
  state: RunBudgetState
  /** Attempts of the run in flight. */
  live: number
}

/**
 * The runs' count records, by run id only: every attempt of a run (a retry, a recovery, one with
 * other limits) shares one, so a new attempt never gets a fresh allowance.
 *
 * The records are in memory. A later attempt of a run whose record is missing (the app restarted
 * since its first attempt) cannot know what the run used, so it fails closed like a dropped run.
 *
 * A run is pinned while an attempt is in flight and until its final settlement (`settle`). A run
 * that settled is dropped and remembered as dropped. Only if more than `keptIdle` runs sit between
 * attempts without settling are the oldest of those dropped. A dropped run that comes back gets a
 * budget that refuses everything, never fresh counts.
 */
export class RunCounterBook {
  private readonly runs = new Map<string, RunEntry>()
  private readonly dropped = new Set<string>()

  constructor(private readonly keptIdle = KEPT_IDLE_RUNS, private readonly keptTombstones = KEPT_TOMBSTONES) {}

  /**
   * The budget of one attempt of `runId` under `limits` (the attempt's binding). `scope`, when
   * given, holds the counts instead of the run's own counters. `release` ends the attempt.
   */
  acquire(runId: string, limits: CountLimits, scope?: CounterScope, options: { laterAttempt?: boolean } = {}): { budget: TurnBudget; release(): void } {
    if (this.dropped.has(runId)) return { budget: TurnBudget.lost(limits), release: () => {} }
    let entry = this.runs.get(runId)
    // A later attempt with no record: its first ran in an earlier process (or before limits). A
    // caller-given scope keeps its own counts, so only the run's own counters are lost.
    if (!entry && options.laterAttempt && !scope) {
      this.remember(runId)
      return { budget: TurnBudget.lost(limits), release: () => {} }
    }
    if (!entry) {
      entry = { state: { scope: scope ?? new RunCounters() }, live: 0 }
      this.runs.set(runId, entry)
    } else {
      // Most recently used last.
      this.runs.delete(runId)
      this.runs.set(runId, entry)
    }
    entry.live += 1
    const held = entry
    let released = false
    this.trim()
    return {
      budget: new TurnBudget(limits, held.state),
      release: () => {
        if (released) return
        released = true
        held.live -= 1
        this.trim()
      }
    }
  }

  /** The run reached its final state: no attempt of it may run again. */
  settle(runId: string): void {
    if (!this.runs.delete(runId)) return
    this.remember(runId)
  }

  private trim(): void {
    let idle = 0
    for (const entry of this.runs.values()) if (entry.live === 0) idle += 1
    if (idle <= this.keptIdle) return
    for (const [runId, entry] of this.runs) {
      if (idle <= this.keptIdle) break
      if (entry.live > 0) continue
      this.runs.delete(runId)
      this.remember(runId)
      idle -= 1
    }
  }

  private remember(runId: string): void {
    this.dropped.add(runId)
    while (this.dropped.size > this.keptTombstones) this.dropped.delete(this.dropped.values().next().value as string)
  }
}
