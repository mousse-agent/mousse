import { afterEach, describe, expect, it } from 'vitest'
import { harness, script, setup as setupEngine } from './piRpcEngineFixture'

// The pi loop's reply text on the real pinned Pi child against a local OpenAI-compatible mock: a
// tool call closes the reply row, so a note before a call and the answer after it are rows of their
// own. Fake key only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('pi reply rows', () => {
  it('closes the note before a tool call, and gives the answer after it a row of its own', async () => {
    const { engine, recorder, project } = await setupEngine(cleanups)
    recorder.respond(script([{ text: 'Listing the files.', tool: { name: 'ls', args: {} } }, { text: 'There are two files.' }]))
    const turn = harness(project)
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    const text = turn.events.filter((event) => event.kind === 'text' && event.phase !== 'delta')
    expect(text.map((event) => [event.phase, event.content])).toEqual([
      ['start', ''],
      ['complete', 'Listing the files.'],
      ['start', ''],
      ['complete', 'There are two files.']
    ])
    // The note closed before the call started.
    const callStart = turn.events.findIndex((event) => event.kind === 'tool' && event.phase === 'start')
    expect(turn.events.findIndex((event) => event.kind === 'text' && event.phase === 'complete')).toBeLessThan(callStart)
    // The run's reply is still every step's text.
    expect(result.text).toBe('Listing the files.\n\nThere are two files.')
  }, 90_000)
})
