import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { SteerHold } from '../../src/mms/orchestrator/steerHold'
import type { RecordedRequest } from './piRpcFixture'
import { harness, setup } from './piRpcEngineFixture'

// A person's steer cuts in on the real pinned Pi child (docs/design/steer-and-interruptions.md §3), against an
// OpenAI-compatible mock on 127.0.0.1 that streams slowly. Fake key only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const chunk = (delta: Record<string, unknown>, finish?: string) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`

/** The first request streams a word every 50 ms until the client goes away; later ones answer at once. */
function slowThenQuick(answer: string) {
  let index = 0
  return (_request: RecordedRequest, res: ServerResponse) => {
    index += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (index > 1) return res.end(`${chunk({ role: 'assistant', content: answer })}${chunk({}, 'stop')}data: [DONE]\n\n`)
    let word = 0
    const timer = setInterval(() => res.write(chunk({ ...(word === 0 ? { role: 'assistant' } : {}), content: `${word ? ' ' : ''}word${word++}` })), 50)
    res.on('close', () => clearInterval(timer))
  }
}

/** The chat messages of a recorded request, as `role: text`. */
function sent(request: RecordedRequest | undefined): string[] {
  const body = JSON.parse(request?.body ?? '{}') as { messages?: Array<{ role: string; content: unknown }> }
  return (body.messages ?? []).filter((message) => message.role !== 'system' && message.role !== 'developer').map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content) ? message.content.map((part: { text?: string }) => part.text ?? '').join('') : ''
    return `${message.role}: ${content}`
  })
}

describe('Pi RPC engine with the real Pi child: a steer cuts in', () => {
  it('a person’s steer while Pi writes aborts the reply, keeps the shown words, and continues the same session with it, once', async () => {
    const { engine, recorder, project } = await setup(cleanups)
    recorder.respond(slowThenQuick('Using pnpm.'))
    const turn = harness(project)
    // The orchestrator's hold, on the tool events the engine reports.
    const open = new Set<string>()
    const hold = new SteerHold({ caps: PI_RPC_CAPS, strict: false, foreground: () => [...open].map((callId) => ({ callId, toolName: 'tool' })) })
    const pending: string[] = []
    const accepted: string[] = []
    const returned: string[] = []
    const shown: string[] = []
    const facts = () => (pending.length ? { person: true, keys: [...pending], itemIds: [] } : undefined)
    turn.sink.tool = (event) => {
      if (event.phase === 'start' && event.callId) open.add(event.callId)
      if (event.phase === 'complete' && event.callId) open.delete(event.callId)
      hold.toolEvent()
    }
    turn.sink.text = (event) => {
      hold.modelOutput(event.phase)
      if (event.phase === 'delta') shown.push(event.content)
    }
    turn.sink.boundary = (at) => hold.boundary(at)
    turn.ctl.peekSteer = () => {
      const decision = hold.decide(facts())
      return decision && { delivery: decision.delivery }
    }
    turn.ctl.drainSteerEntry = (opts) => {
      const decision = hold.decide(facts())
      const expected = opts?.expect === undefined ? undefined : [opts.expect].flat()
      if (!decision || (expected && !expected.includes(decision.delivery))) return undefined
      const text = pending.splice(0).join('\n')
      hold.drained('drain-1', false)
      return { text, token: 'drain-1', cut: true }
    }
    turn.ctl.mayCut = (token) => hold.mayCut(token)
    turn.ctl.returnSteer = (text) => void returned.push(text)
    turn.sink.steerAccepted = (text) => void accepted.push(text)
    const running = engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    await vi.waitFor(() => expect(shown.at(-1) ?? '').toMatch(/word3/), { timeout: 20_000, interval: 20 })
    pending.push('use pnpm')
    const result = await running
    expect(result.aborted).toBeFalsy()
    expect(accepted).toEqual(['use pnpm'])
    expect(returned).toEqual([])
    // The words shown stay; the answer follows them.
    expect(result.text).toMatch(/^word0 word1 word2 word3[\s\S]*\n\nUsing pnpm\.$/)
    // Two requests in one session: the second carries the steer as the person's latest message.
    expect(recorder.requests).toHaveLength(2)
    expect(sent(recorder.requests[1]).at(-1)).toBe('user: use pnpm')
    expect(sent(recorder.requests[1])[0]).toBe('user: Say hello')
  }, 60_000)
})
