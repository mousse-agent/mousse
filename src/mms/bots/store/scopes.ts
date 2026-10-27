import { randomUUID } from 'node:crypto'
import type { AgentExecutionLimit } from '../../../shared/agents/execution'
import type { ChargeResult, CountKind, CounterScope } from '../../../shared/harness/counters'
import type { ReserveResult, SettleResult, SpendLimits, SpendOutcome, SpendRequest, SpendScope } from '../../../shared/harness/spend'
import { RunSpend } from '../../harness/budget'
import type { BotStore } from './BotStore'

/**
 * An activation's counts and spend on `bots.db` (PR 6 §4): one row each, shared by the main run,
 * its continuations and every consult, so none gets a fresh allowance, and the counts survive a
 * restart. The gateway hands them to a bot turn as `TurnSpec.counters` and `TurnSpec.spend`; the
 * binding's own limits still come with every call, so these scopes only narrow them.
 */

const USD_MICROS = 1_000_000

/** The activation's own allowance, from its grant's budget. */
export interface ActivationLimits {
  maxTurns?: number
  maxToolCalls?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  maxUsd?: number
}

const lower = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b)

/**
 * `CounterScope` over `bot_counters`: one compare-and-increment statement in a `bots.db`
 * transaction, so two concurrent charges at the last slot cannot both pass.
 */
export class BotCounterScope implements CounterScope {
  constructor(private readonly store: BotStore, readonly activationId: string) {}

  charge(kind: CountKind, limit?: number): ChargeResult {
    const column = kind === 'request' ? 'requests' : 'tool_calls'
    return this.store.db.transaction((): ChargeResult => {
      const own = this.limits()[kind === 'request' ? 'maxTurns' : 'maxToolCalls']
      const bound = lower(limit, own)
      const changed = this.store.run(
        `UPDATE bot_counters SET ${column} = ${column} + 1 WHERE activation_id = ? AND (? IS NULL OR ${column} < ?)`,
        this.activationId, bound ?? null, bound ?? null
      )
      const count = Number(this.store.get(`SELECT ${column} AS count FROM bot_counters WHERE activation_id = ?`, this.activationId)?.count ?? 0)
      // No row: the activation is gone, so nothing may be charged to it.
      if (changed === 0) return { ok: false, count, limit: bound ?? count }
      return { ok: true, count }
    })
  }

  private limits(): ActivationLimits {
    const row = this.store.get('SELECT limits_json FROM bot_counters WHERE activation_id = ?', this.activationId)
    return row ? (JSON.parse(row.limits_json as string) as ActivationLimits) : {}
  }
}

/**
 * `SpendScope` over `bot_spend` and `bot_spend_reservations`: `committed + reserved` for the whole
 * activation. A reservation is one `BEGIN IMMEDIATE` transaction that reads what is left and
 * inserts the reservation, so two consults cannot both take the last of it. A reservation that is
 * never settled (a process died mid-request) stays counted at its full amount.
 */
export class BotSpendScope implements SpendScope {
  constructor(private readonly store: BotStore, readonly activationId: string, private readonly runId?: string) {}

  /** The same ledger, with reservations recorded against `runId`. */
  forRun(runId: string): BotSpendScope {
    return new BotSpendScope(this.store, this.activationId, runId)
  }

  reserve(request: SpendRequest, limits: SpendLimits): ReserveResult {
    return this.store.db.transaction((): ReserveResult => {
      const row = this.store.get('SELECT * FROM bot_spend WHERE activation_id = ?', this.activationId)
      const own = this.ownLimits()
      const effective: SpendLimits = {}
      for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxUsd'] as const) {
        const value = lower(limits[key], own[key])
        if (value !== undefined) effective[key] = value
      }
      if (!row) return { ok: false, limit: refusalOf(effective) }
      const open = this.store.get(
        'SELECT COALESCE(SUM(input_bound), 0) AS input, COALESCE(SUM(wire_cap), 0) AS output, COALESCE(SUM(usd_micros), 0) AS usd FROM bot_spend_reservations WHERE activation_id = ? AND settled_at IS NULL',
        this.activationId
      )!
      // The run ledger's own rule, applied to what the activation has used and holds.
      const ledger = new RunSpend()
      Object.assign(ledger.committed, {
        input: Number(row.committed_input) + Number(open.input),
        output: Number(row.committed_output) + Number(open.output),
        usd: (Number(row.committed_usd_micros) + Number(open.usd)) / USD_MICROS
      })
      const granted = ledger.reserve(request, effective)
      if (!granted.ok) return granted
      const id = `bs_${randomUUID()}`
      const usd = request.inputBound * request.price.input + granted.cap * request.price.output
      this.store.run(
        'INSERT INTO bot_spend_reservations(id, activation_id, run_id, input_bound, wire_cap, usd_micros, cost_limited, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
        id, this.activationId, this.runId ?? null, request.inputBound, granted.cap, Math.ceil(usd * USD_MICROS), effective.maxUsd !== undefined ? 1 : 0, this.store.now()
      )
      return { ok: true, id, cap: granted.cap }
    })
  }

  settle(id: string, outcome: SpendOutcome): SettleResult {
    return this.store.db.transaction((): SettleResult => {
      const held = this.store.get('SELECT * FROM bot_spend_reservations WHERE id = ? AND activation_id = ? AND settled_at IS NULL', id, this.activationId)
      if (!held) return { ok: true }
      this.store.run('UPDATE bot_spend_reservations SET settled_at = ? WHERE id = ? AND settled_at IS NULL', this.store.now(), id)
      if (outcome.kind === 'released') return { ok: true }
      const reserved = { input: Number(held.input_bound), output: Number(held.wire_cap), usd: Number(held.usd_micros) / USD_MICROS }
      const at = (actual: number, bound: number) => (outcome.partial ? Math.max(actual, bound) : actual)
      const input = at(outcome.input, reserved.input)
      const output = at(outcome.output, reserved.output)
      const usd = at(outcome.usd, reserved.usd)
      this.store.run(
        'UPDATE bot_spend SET committed_input = committed_input + ?, committed_output = committed_output + ?, committed_usd_micros = committed_usd_micros + ? WHERE activation_id = ?',
        Math.ceil(input), Math.ceil(output), Math.ceil(usd * USD_MICROS), this.activationId
      )
      this.store.run('UPDATE bot_counters SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE activation_id = ?', Math.ceil(input), Math.ceil(output), this.activationId)
      if (outcome.output > reserved.output) return { ok: false, limit: { kind: 'output_tokens', limit: reserved.output, actual: outcome.output }, overshoot: outcome.output - reserved.output }
      if (outcome.input > reserved.input) return { ok: false, limit: { kind: 'input_tokens', limit: reserved.input, actual: outcome.input }, overshoot: outcome.input - reserved.input }
      // Micro-USD rounding aside: a USD allowance was held at the highest rates.
      if (Number(held.cost_limited) === 1 && outcome.usd > reserved.usd + 1 / USD_MICROS)
        return { ok: false, limit: { kind: 'cost_usd', limit: reserved.usd, actual: outcome.usd }, overshoot: outcome.usd - reserved.usd }
      return { ok: true }
    })
  }

  /** Committed plus everything still reserved. */
  used(): { input: number; output: number; usd: number } {
    const row = this.store.get('SELECT * FROM bot_spend WHERE activation_id = ?', this.activationId)
    const open = this.store.get(
      'SELECT COALESCE(SUM(input_bound), 0) AS input, COALESCE(SUM(wire_cap), 0) AS output, COALESCE(SUM(usd_micros), 0) AS usd FROM bot_spend_reservations WHERE activation_id = ? AND settled_at IS NULL',
      this.activationId
    )!
    return {
      input: Number(row?.committed_input ?? 0) + Number(open.input),
      output: Number(row?.committed_output ?? 0) + Number(open.output),
      usd: (Number(row?.committed_usd_micros ?? 0) + Number(open.usd)) / USD_MICROS
    }
  }

  private ownLimits(): ActivationLimits {
    const row = this.store.get('SELECT limits_json FROM bot_counters WHERE activation_id = ?', this.activationId)
    return row ? (JSON.parse(row.limits_json as string) as ActivationLimits) : {}
  }
}

function refusalOf(limits: SpendLimits): AgentExecutionLimit {
  if (limits.maxInputTokens !== undefined) return { kind: 'input_tokens', limit: limits.maxInputTokens }
  if (limits.maxOutputTokens !== undefined) return { kind: 'output_tokens', limit: limits.maxOutputTokens }
  return { kind: 'cost_usd', limit: limits.maxUsd ?? 0 }
}
