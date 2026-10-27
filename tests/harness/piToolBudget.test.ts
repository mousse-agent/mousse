import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunCounters, TurnBudget } from '../../src/mms/harness/budget'
import { harness, script, setup } from './piRpcEngineFixture'

// PR 4 4b2: the run's tool-call limit at the gate (`/pi/gate`), on the real pinned Pi child. The
// proof that a refused call never ran is the file it would have written. Fake key, local mock only.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('the tool-call limit in the real Pi child (Pi RPC engine)', () => {
  it('maxToolCalls 1: the second tool never runs, no request follows it, and the run ends with limit tool_calls', async () => {
    const { engine, recorder, project } = await setup(cleanups)
    recorder.respond(script([
      { tool: { name: 'write', args: { path: 'first.txt', content: 'one' } } },
      { tool: { name: 'write', args: { path: 'second.txt', content: 'two' } } },
      { text: 'never sent' }
    ]))
    const counters = new RunCounters({ maxToolCalls: 1 })
    const turn = harness(project, {}, { budget: new TurnBudget({ maxToolCalls: 1 }, counters) })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'tool_calls', limit: 1 } } })
    expect(readFileSync(join(project, 'first.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(project, 'second.txt'))).toBe(false)
    // The request after the refused call was refused too: the model never saw the refusal.
    expect(recorder.requests).toHaveLength(2)
    expect(counters).toMatchObject({ requests: 2, toolCalls: 1 })
  }, 90_000)

  it('a batch past the limit: only the calls within it run', async () => {
    const { engine, recorder, project } = await setup(cleanups)
    recorder.respond(script([
      { tools: [1, 2, 3].map((n) => ({ name: 'write', args: { path: `batch-${n}.txt`, content: String(n) } })) },
      { text: 'never sent' }
    ]))
    const turn = harness(project, {}, { budget: new TurnBudget({ maxToolCalls: 2 }, new RunCounters({ maxToolCalls: 2 })) })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'tool_calls', limit: 2 } } })
    const written = [1, 2, 3].filter((n) => existsSync(join(project, `batch-${n}.txt`)))
    expect(written).toHaveLength(2)
    expect(recorder.requests).toHaveLength(1)
  }, 90_000)
})
