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
 *
 * Token and USD limits (PR 4 §5b, `spendLimits: 'reserved'`) are held the same way by a
 * `SpendScope`: before each request the runtime asks for a reservation of its input bound and its
 * final wire cap, the scope grants at most what is left (lowering the cap) or refuses, and the
 * request's usage settles it afterwards. A reservation never settled (the process died mid-request)
 * stays charged in full.
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
export type SpendLimits = Pick<NonNullable<RunPolicy['budget']>, 'maxInputTokens' | 'maxOutputTokens' | 'maxUsd'>
/** The limits a runtime enforces step by step: counts, and token and USD spend. */
export type BudgetLimits = CountLimits & SpendLimits

/** The count limits of a policy, or undefined when it has none. */
export function countLimitsOf(policy: Pick<RunPolicy, 'budget'>): CountLimits | undefined {
  const { maxTurns, maxToolCalls } = policy.budget ?? {}
  if (maxTurns === undefined && maxToolCalls === undefined) return undefined
  return { ...(maxTurns !== undefined ? { maxTurns } : {}), ...(maxToolCalls !== undefined ? { maxToolCalls } : {}) }
}

/** The count and spend limits of a policy, or undefined when it has none. */
export function budgetLimitsOf(policy: Pick<RunPolicy, 'budget'>): BudgetLimits | undefined {
  const budget = policy.budget ?? {}
  const limits: BudgetLimits = {}
  for (const key of ['maxTurns', 'maxToolCalls', 'maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const)
    if (budget[key] !== undefined) limits[key] = budget[key]
  return Object.keys(limits).length ? limits : undefined
}

/** Whether the limits include a token or USD limit (each request then needs a reservation). */
export function hasSpendLimits(limits: SpendLimits | undefined): boolean {
  return limits?.maxInputTokens !== undefined || limits?.maxOutputTokens !== undefined || limits?.maxUsd !== undefined
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

/** One request's reservation ask, as the runtime computed it. */
export interface SpendRequest {
  /** Upper bound of the request's input tokens. */
  inputBound: number
  /** The output cap the request would carry on the wire as the runtime asked for it. */
  wireCap: number
  /** The smallest cap the request may go with (its thinking budget plus answer room, or 256). */
  floor: number
  /** USD per token. */
  price: { input: number; output: number; cacheWrite: number }
}

/** Granted: `cap` is the wire cap the request must carry (reserved in full). */
export type ReserveResult = { ok: true; id: string; cap: number } | { ok: false; limit: AgentExecutionLimit }

/**
 * How a reservation ends: `released` when nothing was sent; `used` with the request's usage
 * (`partial` when it failed or was stopped after it was sent: each amount is then at least the
 * reservation, since what the provider did is not known).
 */
export type SpendOutcome = { kind: 'released' } | { kind: 'used'; input: number; output: number; usd: number; partial?: boolean }

/** `overshoot`: output tokens the provider produced above the cap it was sent. */
export type SettleResult = { ok: true } | { ok: false; limit: AgentExecutionLimit; overshoot: number }

/** Token and USD spend that may be shared across runs. Each call is atomic. */
export interface SpendScope {
  /**
   * Reserves the request's input bound and the largest wire cap that fits what is left under
   * `limits` (the binding's own) and the scope's own allowance, at most `request.wireCap`; refuses
   * when the input alone does not fit or the cap would fall under `request.floor`.
   */
  reserve(request: SpendRequest, limits: SpendLimits): ReserveResult
  /** Ends a reservation; an unknown or settled id is ignored. */
  settle(id: string, outcome: SpendOutcome): SettleResult
}

interface SpendAmounts { input: number; output: number; usd: number }

/** One run's ledger, `committed + reserved`, with no allowance of its own. */
export class RunSpend implements SpendScope {
  readonly committed: SpendAmounts = { input: 0, output: 0, usd: 0 }
  private readonly held = new Map<string, SpendAmounts>()
  private next = 0

  /** Committed plus everything still reserved. */
  used(): SpendAmounts {
    const total = { ...this.committed }
    for (const amounts of this.held.values()) {
      total.input += amounts.input
      total.output += amounts.output
      total.usd += amounts.usd
    }
    return total
  }

  reserve(request: SpendRequest, limits: SpendLimits): ReserveResult {
    const used = this.used()
    if (limits.maxInputTokens !== undefined && request.inputBound > limits.maxInputTokens - used.input)
      return { ok: false, limit: { kind: 'input_tokens', limit: limits.maxInputTokens, actual: used.input } }
    const inputUsd = request.inputBound * Math.max(request.price.input, request.price.cacheWrite)
    let cap = request.wireCap
    let bound: 'output_tokens' | 'cost_usd' = 'output_tokens'
    if (limits.maxUsd !== undefined) {
      const left = limits.maxUsd - used.usd
      if (inputUsd > left) return { ok: false, limit: { kind: 'cost_usd', limit: limits.maxUsd, actual: used.usd } }
      if (request.price.output > 0) {
        let byUsd = Math.floor((left - inputUsd) / request.price.output)
        while (byUsd > 0 && inputUsd + byUsd * request.price.output > left) byUsd -= 1
        if (byUsd < cap) {
          cap = byUsd
          bound = 'cost_usd'
        }
      }
    }
    if (limits.maxOutputTokens !== undefined && limits.maxOutputTokens - used.output < cap) {
      cap = limits.maxOutputTokens - used.output
      bound = 'output_tokens'
    }
    if (cap < request.floor) {
      const limit: AgentExecutionLimit = bound === 'cost_usd'
        ? { kind: 'cost_usd', limit: limits.maxUsd!, actual: used.usd }
        : { kind: 'output_tokens', limit: limits.maxOutputTokens ?? request.floor, actual: used.output }
      return { ok: false, limit }
    }
    const id = `s${++this.next}`
    this.held.set(id, { input: request.inputBound, output: cap, usd: inputUsd + cap * request.price.output })
    return { ok: true, id, cap }
  }

  settle(id: string, outcome: SpendOutcome): SettleResult {
    const held = this.held.get(id)
    if (!held) return { ok: true }
    this.held.delete(id)
    if (outcome.kind === 'released') return { ok: true }
    const at = (actual: number, reserved: number) => (outcome.partial ? Math.max(actual, reserved) : actual)
    this.committed.input += at(outcome.input, held.input)
    this.committed.output += at(outcome.output, held.output)
    this.committed.usd += at(outcome.usd, held.usd)
    const overshoot = outcome.output - held.output
    if (overshoot > 0) return { ok: false, limit: { kind: 'output_tokens', limit: held.output, actual: outcome.output }, overshoot }
    return { ok: true }
  }
}

export type BudgetDecision = { ok: true } | { ok: false; limit: AgentExecutionLimit }

/** The part of a run's budget every attempt shares: its counts, its spend and the limit that refused, once one did. */
interface RunBudgetState {
  scope: CounterScope
  spend: SpendScope
  exhausted?: AgentExecutionLimit
  /** Output tokens a provider produced above its cap, when that ended the run. */
  overshoot?: number
}

/** The first limit of `limits`, as a refusal (a budget whose record was lost). */
function firstLimit(limits: BudgetLimits): AgentExecutionLimit {
  if (limits.maxTurns !== undefined) return { kind: 'turns', limit: limits.maxTurns }
  if (limits.maxToolCalls !== undefined) return { kind: 'tool_calls', limit: limits.maxToolCalls }
  if (limits.maxInputTokens !== undefined) return { kind: 'input_tokens', limit: limits.maxInputTokens }
  if (limits.maxOutputTokens !== undefined) return { kind: 'output_tokens', limit: limits.maxOutputTokens }
  return { kind: 'cost_usd', limit: limits.maxUsd ?? 0 }
}

const REFUSING_SPEND: SpendScope = {
  reserve: (_request, limits) => ({ ok: false, limit: firstLimit(limits) }),
  settle: () => ({ ok: true })
}

/**
 * One run's hard budget, as a runtime sees it: `request()` before each model request (agent
 * requests, compactions, summaries and the runtime's own retries alike), then `reserve()` when the
 * run has token or USD limits and `settle()` once the request ended; `toolCall()` before each
 * allowed tool call. Once any limit refused a step, every later request and tool call of the run
 * is refused with that same limit.
 */
export class TurnBudget {
  private readonly state: RunBudgetState
  /** The run's record was lost (dropped, settled, or from before a restart): every step is refused. */
  lost = false

  /** `spend`: where token and USD spend is kept (default: a ledger of this budget's own). */
  constructor(readonly limits: BudgetLimits, scope: CounterScope | RunBudgetState, spend?: SpendScope) {
    this.state = 'charge' in scope ? { scope, spend: spend ?? new RunSpend() } : scope
  }

  /**
   * A budget that refuses everything: the run's counts and spend are no longer known (its record
   * was dropped), so it never starts again from zero.
   */
  static lost(limits: BudgetLimits): TurnBudget {
    const budget = new TurnBudget(limits, { charge: (_kind, limit) => ({ ok: false, count: limit ?? 0, limit: limit ?? 0 }) }, REFUSING_SPEND)
    budget.lost = true
    budget.state.exhausted = firstLimit(limits)
    return budget
  }

  /** The limit that refused a step of this run, if one did. */
  get exhausted(): AgentExecutionLimit | undefined {
    return this.state.exhausted
  }

  /** Output tokens a provider produced above the cap it was sent, when that ended the run. */
  get overshoot(): number | undefined {
    return this.state.overshoot
  }

  /** Each request needs a reservation (the run has a token or USD limit). */
  get reserves(): boolean {
    return hasSpendLimits(this.limits)
  }

  /** Reserves one request's spend (after `request()` admitted it); refuses once any limit refused. */
  reserve(request: SpendRequest): ReserveResult {
    if (this.state.exhausted) return { ok: false, limit: this.state.exhausted }
    const reserved = this.state.spend.reserve(request, this.limits)
    if (!reserved.ok) this.state.exhausted = reserved.limit
    return reserved
  }

  /** Ends a reservation. A provider that went over its cap ends the run (every later step is refused). */
  settle(id: string, outcome: SpendOutcome): SettleResult {
    const settled = this.state.spend.settle(id, outcome)
    if (!settled.ok && this.state.overshoot === undefined) {
      this.state.exhausted = settled.limit
      this.state.overshoot = settled.overshoot
    }
    return settled
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
   * given, holds the counts instead of the run's own counters, and `options.spend` the token and
   * USD spend instead of the run's own ledger. `release` ends the attempt.
   */
  acquire(runId: string, limits: BudgetLimits, scope?: CounterScope, options: { laterAttempt?: boolean; spend?: SpendScope } = {}): { budget: TurnBudget; release(): void } {
    if (this.dropped.has(runId)) return { budget: TurnBudget.lost(limits), release: () => {} }
    let entry = this.runs.get(runId)
    // A later attempt with no record: its first ran in an earlier process (or before limits). A
    // caller-given scope keeps its own counts (or spend), so only the run's own records are lost.
    const ownCounts = !scope && (limits.maxTurns !== undefined || limits.maxToolCalls !== undefined)
    const ownSpend = !options.spend && hasSpendLimits(limits)
    if (!entry && options.laterAttempt && (ownCounts || ownSpend)) {
      this.remember(runId)
      return { budget: TurnBudget.lost(limits), release: () => {} }
    }
    if (!entry) {
      entry = { state: { scope: scope ?? new RunCounters(), spend: options.spend ?? new RunSpend() }, live: 0 }
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
