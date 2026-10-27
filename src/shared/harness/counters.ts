/**
 * Request and tool-call counts a runtime charges before each step (PR 4 §5a, `budgets: 'hard'`).
 * The gateway's per-run counters (`harness/budget.ts`) and a bot activation's shared counters
 * (PR 6) implement the same scope. Browser-safe: types only.
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
