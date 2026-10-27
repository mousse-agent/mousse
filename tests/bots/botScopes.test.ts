/**
 * PR 6 §4 "Counters" and "Spend": one counter row and one spend ledger per activation in
 * `bots.db`, shared by every run of it. Two charges at the last slot cannot both pass, the counts
 * survive a restart, a reservation is settled once, and one left open stays charged.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { BotCounterScope, BotSpendScope } from '../../src/mms/bots/store/scopes'
import { TurnBudget } from '../../src/mms/harness/budget'
import type { SpendRequest } from '../../src/shared/harness/spend'

let home: string
const stores: BotStore[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-bot-scopes-'))
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  rmSync(home, { recursive: true, force: true })
})

const open = () => {
  const store = new BotStore({ profileHome: home })
  stores.push(store)
  return store
}

const activation = (store: BotStore, limits: Record<string, number>, id = 'act-1') =>
  store.insertActivation({ id, botId: 'bot', revision: 'r', grantDigest: 'g', trigger: { kind: 'manual', input: 'go' }, idempotencyKey: `manual:${id}`, status: 'running', createdAt: store.now() }, limits)

describe('BotCounterScope', () => {
  it('two connections charging at the last slot: exactly one passes', () => {
    const a = open()
    const b = open()
    activation(a, { maxToolCalls: 2 })
    const first = new BotCounterScope(a, 'act-1')
    const second = new BotCounterScope(b, 'act-1')
    expect(first.charge('tool')).toEqual({ ok: true, count: 1 })
    const results = [second.charge('tool'), first.charge('tool')]
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, count: 2, limit: 2 })
  })

  it('the lower of the binding\'s limit and the activation\'s own refuses', () => {
    const store = open()
    activation(store, { maxTurns: 5 })
    const scope = new BotCounterScope(store, 'act-1')
    expect(scope.charge('request', 1)).toEqual({ ok: true, count: 1 })
    expect(scope.charge('request', 1)).toEqual({ ok: false, count: 1, limit: 1 })
    expect(scope.charge('request')).toEqual({ ok: true, count: 2 })
  })

  it('counts survive a restart, so a new run gets no fresh allowance', () => {
    const store = open()
    activation(store, { maxTurns: 2 })
    new BotCounterScope(store, 'act-1').charge('request')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = open()
    const scope = new BotCounterScope(reopened, 'act-1')
    expect(scope.charge('request')).toEqual({ ok: true, count: 2 })
    expect(scope.charge('request')).toEqual({ ok: false, count: 2, limit: 2 })
  })

  it('runs of one activation share the count through the gateway\'s budget; another activation has its own', () => {
    const store = open()
    activation(store, { maxTurns: 3 })
    activation(store, { maxTurns: 3 }, 'act-2')
    const shared = new BotCounterScope(store, 'act-1')
    const main = new TurnBudget({ maxTurns: 3 }, shared)
    const consult = new TurnBudget({ maxTurns: 3 }, shared)
    expect([main.request(), consult.request(), main.request()].every((decision) => decision.ok)).toBe(true)
    expect(consult.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 3, actual: 3 } })
    expect(new TurnBudget({ maxTurns: 3 }, new BotCounterScope(store, 'act-2')).request()).toEqual({ ok: true })
    expect(store.counters('act-1')).toMatchObject({ requests: 3 })
  })

  it('an unknown activation is never charged', () => {
    const store = open()
    expect(new BotCounterScope(store, 'missing').charge('tool').ok).toBe(false)
  })
})

describe('BotSpendScope', () => {
  const request: SpendRequest = { inputBound: 1_000, wireCap: 4_000, floor: 256, price: { input: 0, output: 0 } }

  it('two connections reserving the last of the allowance: one is granted, one refused', () => {
    const a = open()
    const b = open()
    activation(a, { maxOutputTokens: 5_000 })
    const first = new BotSpendScope(a, 'act-1', 'run-main').reserve(request, {})
    const second = new BotSpendScope(b, 'act-1', 'run-consult').reserve(request, {})
    expect(first).toMatchObject({ ok: true, cap: 4_000 })
    // 1000 output tokens are left: above the floor, so the cap is lowered to fit.
    expect(second).toMatchObject({ ok: true, cap: 1_000 })
    expect(new BotSpendScope(a, 'act-1').reserve(request, {})).toMatchObject({ ok: false, limit: { kind: 'output_tokens' } })
  })

  it('settle applies once and moves usage into the ledger and the counters', () => {
    const store = open()
    activation(store, { maxOutputTokens: 10_000 })
    const scope = new BotSpendScope(store, 'act-1', 'run-1')
    const held = scope.reserve(request, {})
    if (!held.ok) throw new Error('refused')
    expect(scope.settle(held.id, { kind: 'used', input: 800, output: 1_200, usd: 0 })).toEqual({ ok: true })
    expect(scope.settle(held.id, { kind: 'used', input: 800, output: 1_200, usd: 0 })).toEqual({ ok: true })
    expect(scope.used()).toEqual({ input: 800, output: 1_200, usd: 0 })
    expect(store.counters('act-1')).toMatchObject({ inputTokens: 800, outputTokens: 1_200 })
  })

  it('a reservation left open at a crash stays charged at its full amount after a restart', () => {
    const store = open()
    activation(store, { maxOutputTokens: 6_000 })
    expect(new BotSpendScope(store, 'act-1', 'run-1').reserve(request, {})).toMatchObject({ ok: true, cap: 4_000 })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new BotSpendScope(open(), 'act-1', 'run-2')
    expect(reopened.used()).toMatchObject({ input: 1_000, output: 4_000 })
    // Only what the open reservation left is granted.
    expect(reopened.reserve(request, {})).toMatchObject({ ok: true, cap: 2_000 })
  })

  it('a usage above the reservation is an overshoot; a partial usage keeps the reservation charged', () => {
    const store = open()
    activation(store, { maxUsd: 1 })
    const scope = new BotSpendScope(store, 'act-1')
    const priced: SpendRequest = { inputBound: 100, wireCap: 1_000, floor: 256, price: { input: 0.0001, output: 0.0005 } }
    const held = scope.reserve(priced, {})
    if (!held.ok) throw new Error('refused')
    expect(scope.settle(held.id, { kind: 'used', input: 100, output: held.cap + 10, usd: 0.1 })).toMatchObject({ ok: false, limit: { kind: 'output_tokens' }, overshoot: 10 })
    const again = scope.reserve(priced, {})
    if (!again.ok) throw new Error('refused')
    scope.settle(again.id, { kind: 'used', input: 0, output: 0, usd: 0, partial: true })
    expect(scope.used().output).toBe(held.cap + 10 + again.cap)
  })
})
