import { describe, expect, it } from 'vitest'
import { countLimitsOf, RunCounterBook, RunCounters, TurnBudget, type CounterScope } from '../../src/mms/harness/budget'

describe('hard count budgets', () => {
  it('reads only turn and tool-call limits from a policy', () => {
    expect(countLimitsOf({ budget: { maxUsd: 1, maxWallMs: 10 } })).toBeUndefined()
    expect(countLimitsOf({})).toBeUndefined()
    expect(countLimitsOf({ budget: { maxTurns: 2, maxUsd: 1 } })).toEqual({ maxTurns: 2 })
    expect(countLimitsOf({ budget: { maxTurns: 0, maxToolCalls: 3 } })).toEqual({ maxTurns: 0, maxToolCalls: 3 })
  })

  it('refuses the request that would pass maxTurns, and every one after it, with the recorded limit', () => {
    const budget = new TurnBudget({ maxTurns: 2 }, new RunCounters({ maxTurns: 2 }))
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.exhausted).toBeUndefined()
    expect(budget.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
    expect(budget.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
    // Tool calls have no limit here, but the run is over: they are refused too.
    expect(budget.toolCall()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
  })

  it('a tool-call limit, once reached, refuses the next request as well', () => {
    const counters = new RunCounters({ maxToolCalls: 1 })
    const budget = new TurnBudget({ maxToolCalls: 1 }, counters)
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.toolCall()).toEqual({ ok: true })
    expect(budget.toolCall()).toEqual({ ok: false, limit: { kind: 'tool_calls', limit: 1, actual: 1 } })
    expect(budget.request()).toMatchObject({ ok: false, limit: { kind: 'tool_calls' } })
    // The refused steps were not counted.
    expect(counters).toMatchObject({ requests: 1, toolCalls: 1 })
  })

  it('a zero limit refuses the first step', () => {
    expect(new TurnBudget({ maxTurns: 0 }, new RunCounters({ maxTurns: 0 })).request()).toMatchObject({ ok: false, limit: { kind: 'turns', limit: 0 } })
  })

  it('keeps one counter per run across its attempts, and drops the oldest runs past the bound', () => {
    const book = new RunCounterBook(2)
    const first = book.budgetFor('r1', { maxTurns: 1 })
    expect(first.request()).toEqual({ ok: true })
    // A later attempt of the same run continues its counts: no fresh allowance.
    expect(book.budgetFor('r1', { maxTurns: 1 })).toBe(first)
    expect(book.budgetFor('r1', { maxTurns: 1 }).request()).toMatchObject({ ok: false })
    expect(book.budgetFor('r2', { maxTurns: 1 })).not.toBe(first)
    book.budgetFor('r3', { maxTurns: 1 })
    book.budgetFor('r4', { maxTurns: 1 })
    expect(book.budgetFor('r1', { maxTurns: 1 })).not.toBe(first)
  })

  it('charges a caller-given scope instead of the run’s own counters (the shared-allowance seam)', () => {
    const charges: Array<[string, string | undefined]> = []
    let left = 1
    const shared: CounterScope = {
      charge: (kind, limitKey) => {
        charges.push([kind, limitKey])
        if (limitKey && left <= 0) return 'refused'
        if (limitKey) left -= 1
        return 'ok'
      }
    }
    const book = new RunCounterBook()
    const a = book.budgetFor('run-a', { maxTurns: 5 }, shared)
    const b = book.budgetFor('run-b', { maxTurns: 5 }, shared)
    expect(a.request()).toEqual({ ok: true })
    // Another run under the same scope gets no fresh allowance.
    expect(b.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 5, actual: 5 } })
    // Without a tool-call limit the scope still counts the call, with no limit key.
    expect(a.toolCall()).toEqual({ ok: true })
    expect(charges).toEqual([['request', 'maxTurns'], ['request', 'maxTurns'], ['tool', undefined]])
  })
})
