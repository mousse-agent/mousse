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
    const budget = new TurnBudget({ maxTurns: 2 }, new RunCounters())
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.exhausted).toBeUndefined()
    expect(budget.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
    expect(budget.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
    // Tool calls have no limit here, but the run is over: they are refused too.
    expect(budget.toolCall()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
  })

  it('a tool-call limit, once reached, refuses the next request as well', () => {
    const counters = new RunCounters()
    const budget = new TurnBudget({ maxToolCalls: 1 }, counters)
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.toolCall()).toEqual({ ok: true })
    expect(budget.toolCall()).toEqual({ ok: false, limit: { kind: 'tool_calls', limit: 1, actual: 1 } })
    expect(budget.request()).toMatchObject({ ok: false, limit: { kind: 'tool_calls' } })
    // The refused steps were not counted.
    expect(counters).toMatchObject({ requests: 1, toolCalls: 1 })
  })

  it('a zero limit refuses the first step', () => {
    expect(new TurnBudget({ maxTurns: 0 }, new RunCounters()).request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 0, actual: 0 } })
  })
})

describe('a shared counter scope (the PR 6 seam)', () => {
  /** A shared count with an allowance of its own, as an activation's row would hold it. */
  function shared(allowance: number) {
    const counts = { request: 0, tool: 0 }
    const scope: CounterScope = {
      charge: (kind, limit) => {
        const threshold = Math.min(limit ?? Infinity, allowance)
        if (counts[kind] >= threshold) return { ok: false, count: counts[kind], limit: threshold }
        counts[kind] += 1
        return { ok: true, count: counts[kind] }
      }
    }
    return { scope, counts }
  }

  it('each binding’s own limit holds against the shared count, with the shared count in the refusal', () => {
    const { scope } = shared(10)
    const book = new RunCounterBook()
    const wide = book.acquire('run-wide', { maxTurns: 3 }, scope).budget
    const narrow = book.acquire('run-narrow', { maxTurns: 1 }, scope).budget
    expect(wide.request()).toEqual({ ok: true })
    expect(wide.request()).toEqual({ ok: true })
    // The narrow binding's limit is 1 and the shared count is already 2: refused, never widened.
    expect(narrow.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 1, actual: 2 } })
    expect(wide.request()).toEqual({ ok: true })
    expect(wide.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 3, actual: 3 } })
  })

  it('a binding can never use more than the shared allowance, and a larger binding limit does not widen it', () => {
    const { scope, counts } = shared(2)
    const budget = new RunCounterBook().acquire('run', { maxTurns: 5, maxToolCalls: 9 }, scope).budget
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
    expect(counts.request).toBe(2)
  })

  it('the binding’s number reaches the run’s own counters too: a looser scope never replaces it', () => {
    const budget = new TurnBudget({ maxTurns: 1 }, new RunCounters())
    expect(budget.request()).toEqual({ ok: true })
    expect(budget.request()).toMatchObject({ ok: false, limit: { kind: 'turns', limit: 1, actual: 1 } })
  })
})

describe('the runs’ count records', () => {
  it('every attempt of a run shares its counts', () => {
    const book = new RunCounterBook()
    const first = book.acquire('r1', { maxTurns: 1 })
    expect(first.budget.request()).toEqual({ ok: true })
    first.release()
    // A later attempt of the same run continues its counts: no fresh allowance.
    expect(book.acquire('r1', { maxTurns: 1 }).budget.request()).toMatchObject({ ok: false })
    expect(book.acquire('r2', { maxTurns: 1 }).budget.request()).toEqual({ ok: true })
  })

  it('a live run keeps its counts however many other runs come and go', () => {
    const book = new RunCounterBook()
    const live = book.acquire('live', { maxTurns: 1 })
    expect(live.budget.request()).toEqual({ ok: true })
    for (let i = 0; i < 3000; i++) {
      const other = book.acquire(`other-${i}`, { maxTurns: 1 })
      other.budget.request()
      other.release()
      if (i % 2) book.settle(`other-${i}`)
    }
    // Over 1024 unsettled runs went idle, so the oldest of those were dropped; the live run never is.
    expect(book.acquire('live', { maxTurns: 1 }).budget.request()).toMatchObject({ ok: false, limit: { kind: 'turns', actual: 1 } })
  })

  it('a run between attempts is kept until it settles; past the bound, a dropped run fails closed instead of starting from zero', () => {
    const book = new RunCounterBook(2)
    const waiting = book.acquire('waiting', { maxTurns: 5 })
    expect(waiting.budget.request()).toEqual({ ok: true })
    waiting.release()
    // 256 other runs that settle do not push it out.
    for (let i = 0; i < 300; i++) {
      book.acquire(`settled-${i}`, { maxTurns: 5 }).release()
      book.settle(`settled-${i}`)
    }
    expect(book.acquire('waiting', { maxTurns: 1 }).budget.request()).toMatchObject({ ok: false, limit: { actual: 1 } })
    // More idle, unsettled runs than the bound: the oldest is dropped, and it never starts again from zero.
    for (const id of ['idle-1', 'idle-2', 'idle-3', 'idle-4']) book.acquire(id, { maxTurns: 5 }).release()
    const back = book.acquire('idle-1', { maxTurns: 5 }).budget
    expect(back.request()).toMatchObject({ ok: false, limit: { kind: 'turns', limit: 5 } })
    expect(back.toolCall()).toMatchObject({ ok: false })
  })

  it('records are keyed on the run alone: an attempt with other limits continues the counts', () => {
    const book = new RunCounterBook()
    const first = book.acquire('r1', { maxTurns: 1 })
    expect(first.budget.request()).toEqual({ ok: true })
    first.release()
    const looser = book.acquire('r1', { maxTurns: 2 }).budget
    expect(looser.request()).toEqual({ ok: true })
    expect(looser.request()).toEqual({ ok: false, limit: { kind: 'turns', limit: 2, actual: 2 } })
  })

  it('a later attempt with no record in this process (after a restart) fails closed; a first attempt starts fresh', () => {
    const book = new RunCounterBook()
    const recovered = book.acquire('from-before-restart', { maxTurns: 5 }, undefined, { laterAttempt: true }).budget
    expect(recovered.request()).toMatchObject({ ok: false, limit: { kind: 'turns', limit: 5 } })
    expect(recovered.exhausted).not.toHaveProperty('actual')
    // It stays refused for any further attempt.
    expect(book.acquire('from-before-restart', { maxTurns: 5 }).budget.request()).toMatchObject({ ok: false })
    expect(book.acquire('fresh', { maxTurns: 5 }).budget.request()).toEqual({ ok: true })
    // A later attempt whose record exists continues it.
    book.acquire('kept', { maxTurns: 5 }).release()
    expect(book.acquire('kept', { maxTurns: 5 }, undefined, { laterAttempt: true }).budget.request()).toEqual({ ok: true })
    // A caller's scope keeps its own counts across a restart: nothing is lost.
    const scope = new RunCounters()
    expect(book.acquire('scoped', { maxTurns: 5 }, scope, { laterAttempt: true }).budget.request()).toEqual({ ok: true })
  })

  it('a settled run that comes back is refused every step', () => {
    const book = new RunCounterBook()
    book.acquire('done', { maxTurns: 3, maxToolCalls: 3 }).release()
    book.settle('done')
    const late = book.acquire('done', { maxTurns: 3, maxToolCalls: 3 }).budget
    expect(late.request()).toMatchObject({ ok: false })
    expect(late.toolCall()).toMatchObject({ ok: false })
  })
})
