import type { BotBudgetTransfer, BudgetLedger } from '../contracts'
import type { BotId, ExecutionId, SpaceId } from '../../../shared/net'
import { isId } from '../../../shared/net'
import { NetDatabase, fail, integer, json, same } from './database'

const dayOf = (now: number): number => Math.floor(integer(now) / 86_400_000)
function sum(values: number[]): number {
  return values.reduce((total, value) => integer(total + integer(value)), 0)
}

export class SqliteBudgetLedger implements BudgetLedger {
  constructor(private readonly db: NetDatabase) {}
  setDailyBudget(bot: BotId, space: SpaceId, units: number): void {
    this.ids(bot, space)
    integer(units, 1)
    this.db.transaction(() => {
      const day = dayOf(this.db.clock.now())
      const daily = this.daily(bot, space, day)
      if (daily && this.charged(bot, space, day, daily.spent) > units)
        fail('budget_exhausted', 'New budget is below committed spend and reservations.')
      this.db.charge(daily ? 2 : 1)
      this.db.database
        .prepare(
          'INSERT INTO net_budget_config VALUES(?,?,?) ON CONFLICT(bot,space) DO UPDATE SET units=excluded.units'
        )
        .run(bot, space, units)
      if (daily)
        this.db.database
          .prepare('UPDATE net_budget_daily SET units=? WHERE bot=? AND space=? AND day=?')
          .run(units, bot, space, day)
    })
  }
  reserve(bot: BotId, space: SpaceId, execution: ExecutionId, units: number, now: number): void {
    this.ids(bot, space)
    integer(units, 1)
    const day = dayOf(now)
    this.db.transaction(() => {
      const previous = this.reservation(execution)
      if (previous) {
        if (previous.bot !== bot || previous.space !== space || previous.ceiling !== units)
          fail('conflict', 'Execution reservation changed.')
        return
      }
      const record = this.db.database
        .prepare('SELECT scope,target,state FROM net_executions WHERE id=?')
        .get(execution)
      if (!record || record.scope !== space || record.target !== bot || record.state !== 'accepted')
        fail('bad_request', 'Reservation requires its admitted bot execution.')
      const configured = this.db.database
        .prepare('SELECT units FROM net_budget_config WHERE bot=? AND space=?')
        .get(bot, space)
      if (!configured) fail('budget_exhausted', 'Bot has no configured budget.')
      let daily = this.daily(bot, space, day)
      if (!daily) {
        this.db.charge(1)
        this.db.database
          .prepare('INSERT INTO net_budget_daily VALUES(?,?,?,?,0)')
          .run(bot, space, day, configured.units)
        daily = { units: configured.units as number, spent: 0 }
      }
      if (sum([this.charged(bot, space, day, daily.spent), units]) > daily.units)
        fail('budget_exhausted', 'Daily funds are already spent or reserved.')
      this.db.charge(1)
      this.db.database
        .prepare('INSERT INTO net_budget_reservations VALUES(?,?,?,?,?,NULL)')
        .run(execution, bot, space, day, units)
      this.db.checkpoint('budgets.reserve.beforeCommit')
    })
  }
  settle(execution: ExecutionId, spentUnits: number): void {
    integer(spentUnits)
    this.db.transaction(() => {
      const r = this.required(execution)
      if (r.settled !== null) {
        if (r.settled !== spentUnits) fail('conflict', 'Execution settlement changed.')
        return
      }
      const calls = this.db.database
        .prepare('SELECT maximum,spent FROM net_budget_calls WHERE execution=?')
        .all(execution)
      if (calls.some((call) => call.spent === null))
        fail('outcome_uncertain', 'Unknown provider usage remains reserved.')
      const accounted = sum(calls.map((call) => call.spent as number))
      if (spentUnits < accounted || spentUnits > r.ceiling)
        fail('budget_exhausted', 'Settlement cannot discard known charges or exceed its ceiling.')
      const daily =
        this.daily(r.bot, r.space, r.day) ??
        fail('storage_corrupt', 'Reservation lost its admission-day bucket.')
      const spent = sum([daily.spent, spentUnits])
      this.db.charge(2)
      this.db.database
        .prepare('UPDATE net_budget_daily SET spent=? WHERE bot=? AND space=? AND day=?')
        .run(spent, r.bot, r.space, r.day)
      this.db.database
        .prepare('UPDATE net_budget_reservations SET settled=? WHERE execution=?')
        .run(spentUnits, execution)
      this.db.checkpoint('budgets.settle.beforeCommit')
    })
  }
  remaining(bot: BotId, space: SpaceId, now: number): number {
    this.ids(bot, space)
    const day = dayOf(now)
    const daily = this.daily(bot, space, day)
    if (!daily)
      return (
        (this.db.database
          .prepare('SELECT units FROM net_budget_config WHERE bot=? AND space=?')
          .get(bot, space)?.units as number | undefined) ?? 0
      )
    return integer(daily.units - this.charged(bot, space, day, daily.spent))
  }
  authorizeCall(execution: ExecutionId, callId: string, maximumUnits: number): void {
    integer(maximumUnits)
    this.callId(callId)
    this.db.transaction(() => {
      const r = this.required(execution)
      if (r.settled !== null) fail('conflict', 'Cannot authorize against a settled execution.')
      const existing = this.db.database
        .prepare('SELECT maximum FROM net_budget_calls WHERE execution=? AND id=?')
        .get(execution, callId)
      if (existing) {
        if (existing.maximum !== maximumUnits) fail('conflict', 'Provider call maximum changed.')
        return
      }
      const state = this.db.database
        .prepare('SELECT state FROM net_executions WHERE id=?')
        .get(execution)?.state
      if (state !== 'running') fail('forbidden', 'Provider calls require a running execution.')
      const rows = this.db.database
        .prepare('SELECT maximum,spent FROM net_budget_calls WHERE execution=?')
        .all(execution)
      const charged = sum(rows.map((call) => (call.spent ?? call.maximum) as number))
      if (sum([charged, maximumUnits]) > r.ceiling)
        fail('budget_exhausted', 'Provider call exceeds remaining execution allowance.')
      this.db.charge(1)
      this.db.database
        .prepare('INSERT INTO net_budget_calls VALUES(?,?,?,NULL)')
        .run(execution, callId, maximumUnits)
    })
  }
  settleCall(execution: ExecutionId, callId: string, spentUnits: number): void {
    integer(spentUnits)
    this.callId(callId)
    this.db.transaction(() => {
      const r = this.required(execution)
      const call = this.db.database
        .prepare('SELECT maximum,spent FROM net_budget_calls WHERE execution=? AND id=?')
        .get(execution, callId)
      if (!call) fail('bad_request', 'Unknown provider call.')
      if (call.spent !== null) {
        if (call.spent !== spentUnits) fail('conflict', 'Provider-call settlement changed.')
        return
      }
      if (r.settled !== null) fail('conflict', 'Execution was settled before this call.')
      if (spentUnits > Number(call.maximum))
        fail('budget_exhausted', 'Provider exceeded its verified call maximum.')
      this.db.charge(1)
      this.db.database
        .prepare('UPDATE net_budget_calls SET spent=? WHERE execution=? AND id=?')
        .run(spentUnits, execution, callId)
    })
  }
  exportFor(bot: BotId): BotBudgetTransfer {
    const daily = this.db.database
      .prepare('SELECT * FROM net_budget_daily WHERE bot=? ORDER BY space,day')
      .all(bot)
      .map((r) => ({
        space: r.space as SpaceId,
        day: r.day as number,
        budgetUnits: r.units as number,
        spentUnits: r.spent as number
      }))
    const reservations = this.db.database
      .prepare('SELECT * FROM net_budget_reservations WHERE bot=? ORDER BY execution')
      .all(bot)
      .map((r) => ({
        execution: r.execution as ExecutionId,
        space: r.space as SpaceId,
        day: r.day as number,
        ceilingUnits: r.ceiling as number,
        ...(r.settled === null ? {} : { settledUnits: r.settled as number }),
        calls: this.db.database
          .prepare('SELECT * FROM net_budget_calls WHERE execution=? ORDER BY id')
          .all(r.execution!)
          .map((call) => ({
            id: call.id as string,
            maximumUnits: call.maximum as number,
            ...(call.spent === null ? {} : { spentUnits: call.spent as number })
          }))
      }))
    return { bot, daily, reservations }
  }
  importFor(bot: BotId, state: BotBudgetTransfer): void {
    if (bot !== state.bot || !isId('bot', bot))
      fail('bad_request', 'Accounting manifest belongs to another bot.')
    const count =
      state.daily.length + state.reservations.reduce((n, r) => n + 1 + r.calls.length, 0)
    if (count > 500 || Buffer.byteLength(json(state)) > 1024 * 1024)
      fail('too_large', 'Accounting transfer requires bounded staging before activation.')
    // The frozen one-shot interface cannot activate a manifest in batches. Fail
    // oversized transfers rather than resetting or importing partial budgets.
    this.db.transaction(() => {
      const current = this.exportFor(bot)
      if (current.daily.length || current.reservations.length) {
        if (!same(current, state))
          fail('conflict', 'Imported accounting differs from installed state.')
        return
      }
      const bucketKeys = new Set<string>()
      const executionIds = new Set<string>()
      for (const bucket of state.daily) {
        this.ids(bot, bucket.space)
        integer(bucket.day)
        integer(bucket.budgetUnits, 1)
        integer(bucket.spentUnits)
        const key = `${bucket.space}/${bucket.day}`
        if (bucketKeys.has(key) || bucket.spentUnits > bucket.budgetUnits)
          fail('bad_request', 'Accounting day bucket is duplicate or overdrawn.')
        bucketKeys.add(key)
      }
      for (const r of state.reservations) {
        integer(r.day)
        integer(r.ceilingUnits, 1)
        if (r.settledUnits !== undefined) integer(r.settledUnits)
        const execution = this.db.database
          .prepare('SELECT scope,target,state FROM net_executions WHERE id=?')
          .get(r.execution)
        if (
          !execution ||
          execution.scope !== r.space ||
          execution.target !== bot ||
          !['completed', 'failed', 'cancelled', 'uncertain', 'expired'].includes(
            execution.state as string
          )
        )
          fail('conflict', 'Transferred reservation lacks its stopped execution ledger.')
        if (
          executionIds.has(r.execution) ||
          !bucketKeys.has(`${r.space}/${r.day}`) ||
          (r.settledUnits !== undefined && r.settledUnits > r.ceilingUnits)
        )
          fail('bad_request', 'Accounting coverage is missing or duplicate.')
        executionIds.add(r.execution)
        const callIds = new Set<string>()
        let charged = 0
        for (const call of r.calls) {
          this.callId(call.id)
          integer(call.maximumUnits)
          if (callIds.has(call.id)) fail('bad_request', 'Duplicate transferred provider call.')
          callIds.add(call.id)
          if (call.spentUnits !== undefined) integer(call.spentUnits)
          if (call.spentUnits !== undefined && call.spentUnits > call.maximumUnits)
            fail('bad_request', 'Provider-call spend exceeds its ceiling.')
          if (r.settledUnits !== undefined && call.spentUnits === undefined)
            fail('bad_request', 'Settled execution contains unknown provider usage.')
          charged = sum([charged, call.spentUnits ?? call.maximumUnits])
        }
        if (charged > r.ceilingUnits || (r.settledUnits !== undefined && charged > r.settledUnits))
          fail('bad_request', 'Transferred call accounting exceeds execution coverage.')
      }
      for (const bucket of state.daily) {
        const matching = state.reservations.filter(
          (r) => r.space === bucket.space && r.day === bucket.day
        )
        const settled = sum(
          matching.filter((r) => r.settledUnits !== undefined).map((r) => r.settledUnits!)
        )
        if (
          settled !== bucket.spentUnits ||
          sum([
            bucket.spentUnits,
            ...matching.filter((r) => r.settledUnits === undefined).map((r) => r.ceilingUnits)
          ]) > bucket.budgetUnits
        )
          fail('conflict', 'Transfer omits settlement evidence or overdraws a day bucket.')
        this.db.charge(1)
        this.db.database
          .prepare('INSERT INTO net_budget_daily VALUES(?,?,?,?,?)')
          .run(bot, bucket.space, bucket.day, bucket.budgetUnits, bucket.spentUnits)
      }
      for (const r of state.reservations) {
        this.db.charge(1)
        this.db.database
          .prepare('INSERT INTO net_budget_reservations VALUES(?,?,?,?,?,?)')
          .run(r.execution, bot, r.space, r.day, r.ceilingUnits, r.settledUnits ?? null)
        for (const call of r.calls) {
          this.db.charge(1)
          this.db.database
            .prepare('INSERT INTO net_budget_calls VALUES(?,?,?,?)')
            .run(r.execution, call.id, call.maximumUnits, call.spentUnits ?? null)
        }
      }
    })
  }
  private ids(bot: BotId, space: SpaceId): void {
    if (!isId('bot', bot) || !isId('space', space)) fail('bad_request', 'Invalid bot budget scope.')
  }
  private callId(id: string): void {
    if (!id || id.length > 128) fail('bad_request', 'Invalid provider-call identity.')
  }
  private daily(
    bot: BotId,
    space: SpaceId,
    day: number
  ): { units: number; spent: number } | undefined {
    return this.db.database
      .prepare('SELECT units,spent FROM net_budget_daily WHERE bot=? AND space=? AND day=?')
      .get(bot, space, day) as { units: number; spent: number } | undefined
  }
  private reservation(execution: ExecutionId): Record<string, any> | undefined {
    return this.db.database
      .prepare('SELECT * FROM net_budget_reservations WHERE execution=?')
      .get(execution)
  }
  private required(execution: ExecutionId): Record<string, any> {
    return this.reservation(execution) ?? fail('bad_request', 'Execution has no reservation.')
  }
  private charged(bot: BotId, space: SpaceId, day: number, spent: number): number {
    return sum([
      spent,
      ...this.db.database
        .prepare(
          'SELECT ceiling FROM net_budget_reservations WHERE bot=? AND space=? AND day=? AND settled IS NULL'
        )
        .all(bot, space, day)
        .map((r) => r.ceiling as number)
    ])
  }
}
