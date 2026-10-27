import type { AgentExecutionLimit } from '../agents/execution'
import type { RunPolicy } from './types'

/**
 * Token and USD spend a runtime reserves before each request (PR 4 §5b, `spendLimits: 'reserved'`).
 * The gateway's per-run ledger (`harness/budget.ts` `RunSpend`) and a bot activation's shared
 * ledger (PR 6) implement the same scope. Browser-safe: types only.
 */

export type SpendLimits = Pick<NonNullable<RunPolicy['budget']>, 'maxInputTokens' | 'maxOutputTokens' | 'maxUsd'>

/** One request's reservation ask, as the runtime computed it. */
export interface SpendRequest {
  /** Upper bound of the request's input tokens. */
  inputBound: number
  /** The output cap the request would carry on the wire as the runtime asked for it. */
  wireCap: number
  /** The smallest cap the request may go with (its thinking budget plus answer room, or 256). */
  floor: number
  /**
   * USD per token, at the highest rate any token of the request can be billed (`input`: input,
   * cache read or cache write, over every tier; `output`: likewise).
   */
  price: { input: number; output: number }
}

/** Granted: `cap` is the wire cap the request must carry (reserved in full). */
export type ReserveResult = { ok: true; id: string; cap: number } | { ok: false; limit: AgentExecutionLimit }

/**
 * How a reservation ends: `released` when nothing was sent; `used` with the request's usage
 * (`partial` when it failed or was stopped after it was sent: each amount is then at least the
 * reservation, since what the provider did is not known).
 */
export type SpendOutcome = { kind: 'released' } | { kind: 'used'; input: number; output: number; usd: number; partial?: boolean }

/**
 * `overshoot`: how far the request went over what was reserved for it, in the limit's units
 * (output tokens above the cap it was sent, input tokens above its bound, or USD).
 */
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
