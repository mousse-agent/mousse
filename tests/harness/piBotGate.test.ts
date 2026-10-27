import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { RunCounters, TurnBudget } from '../../src/mms/harness/budget'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { NeutralTool } from '../../src/shared/harness/tools'
import { harness, script, setup } from './piRpcEngineFixture'

// PR 6 6c-1: a bot's authority over Pi's built-in tools at the gate (`/pi/gate`), on the real pinned
// Pi child: the tool must be granted, and every path must sit in a granted root (write access for a
// write) or in the activation's scratch folder. Nobody is asked. Fake key, local mock only.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function bot(root: string, scratch: string, tools: NeutralTool[], access: 'read' | 'write' = 'read'): BotAuthority {
  return createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: { tools, appTools: [], mcp: [], skills: [], workspace: { roots: [root], access, scratch } },
    waiting: () => false,
    counters: new RunCounters(),
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
    spend: null
  })
}

const refused = (event: { summary?: unknown }) => event.summary === 'The tool returned an error.'

describe('a bot’s authority over Pi’s built-in tools (Pi RPC engine, real child)', () => {
  it('reads inside the root, writes only to scratch, and is walled outside', async () => {
    const { engine, recorder, project } = await setup(cleanups)
    const root = realpathSync(project)
    const scratch = join(root, '..', 'scratch')
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(root, 'inside.txt'), 'inside-content')
    writeFileSync(join(root, '..', 'outside.txt'), 'outside-secret')
    recorder.respond(script([
      { tool: { name: 'read', args: { path: 'inside.txt' } } },
      { tool: { name: 'read', args: { path: '../outside.txt' } } },
      { tool: { name: 'write', args: { path: 'blocked.txt', content: 'x' } } },
      { tool: { name: 'write', args: { path: join(scratch, 'notes.md'), content: 'draft' } } },
      { tool: { name: 'edit', args: { path: 'inside.txt', oldText: 'inside', newText: 'changed' } } },
      { text: 'done' }
    ]))
    const counts = new RunCounters()
    const budget = new TurnBudget({ maxToolCalls: 10 }, counts)
    const turn = harness(root, {}, { bot: bot(root, scratch, ['read', 'write']), budget })
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(result.text).toBe('done')
    const results = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(results.map(refused)).toEqual([false, true, true, false, true])
    expect(String(results[0].response)).toContain('inside-content')
    for (const event of results) expect(String(event.response)).not.toContain('outside-secret')
    expect(String(results[1].response)).toContain('This bot is not allowed to read')
    expect(String(results[2].response)).toContain('This bot is not allowed to change')
    // `edit` was never granted.
    expect(String(results[4].response)).toContain('This bot is not allowed to use edit')
    expect(existsSync(join(root, 'blocked.txt'))).toBe(false)
    expect(readFileSync(join(scratch, 'notes.md'), 'utf8')).toBe('draft')
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('inside-content')
    // A refused call costs no tool call: only the two that ran were counted.
    expect(counts.toolCalls).toBe(2)
  }, 120_000)
})
