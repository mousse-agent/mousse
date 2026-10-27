import { afterEach, describe, expect, it } from 'vitest'
import { RunCounters, TurnBudget, type CounterScope, type CountLimits } from '../../src/mms/harness/budget'
import { PiBridge } from '../../src/mms/harness/pi/bridge'
import type { PiCatalogResponse, PiRequestResponse } from '../../src/mms/harness/pi/extension/protocol'
import { harness, script, setup as setupEngine, type SetupOptions } from './piRpcEngineFixture'
import { launchPi, scratchDir, startRecorder, testExtension, testSettings } from './piRpcFixture'

// PR 4 4b2: the `/pi/request` step of the guarded provider wrapper, on the real pinned Pi child
// against local recorders. A refused request never reaches the recorder: the proof is the
// recorder's own request and connection counts. Fake keys only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const setup = (options: SetupOptions = {}) => setupEngine(cleanups, options)

/** A run's own counters, with every charge recorded (one per `/pi/request` or allowed tool call). */
function counted(limits: CountLimits) {
  const counters = new RunCounters()
  const charges: string[] = []
  const scope: CounterScope = {
    charge: (kind, limit) => {
      const result = counters.charge(kind, limit)
      charges.push(`${kind}:${result.ok ? 'ok' : 'refused'}`)
      return result
    }
  }
  return { budget: new TurnBudget(limits, scope), charges, requests: () => charges.filter((entry) => entry.startsWith('request:')).length }
}

const RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } }

describe('the request gate in the real Pi child (Pi RPC engine)', () => {
  it('maxTurns 1: the second model request never reaches the provider, the turn ends budget_exhausted, and a later attempt of the run sends nothing', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ tool: { name: 'ls', args: {} } }, { text: 'never sent' }]))
    const { budget, requests } = counted({ maxTurns: 1 })
    const turn = harness(project, {}, { budget })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'turns', limit: 1 } } })
    // The first request went and its tool ran; the second was refused before any I/O.
    expect(recorder.requests).toHaveLength(1)
    expect(turn.events.some((event) => event.kind === 'tool' && event.phase === 'complete')).toBe(true)
    expect(requests()).toBe(2)
    const connections = recorder.connections()

    // Another attempt of the same run shares the counter: refused at its first request.
    const again = harness(project, { attemptId: 'a2' }, { budget })
    await expect(engine.startTurn(again.input, again.sink, again.ctl, again.host)).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(recorder.requests).toHaveLength(1)
    expect(recorder.connections()).toBe(connections)
  }, 90_000)

  it('maxTurns 1 with a reply large enough for an automatic compaction: the summary request is refused, and the turn ends budget_exhausted with Mousse’s numbers', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond((_request, res) => {
      // Usage near the model's window: Pi compacts after the reply, which needs a second request.
      const chunks = [
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'large answer '.repeat(10_000) } }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120_000, completion_tokens: 30_000, total_tokens: 150_000 } }
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}

`).join('')}data: [DONE]

`)
    })
    const { budget, requests } = counted({ maxTurns: 1 })
    const turn = harness(project, {}, { budget })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'turns', limit: 1, actual: 1 } } })
    expect(recorder.requests).toHaveLength(1)
    expect(requests()).toBe(2)
  }, 90_000)

  it('maxTurns 0: nothing is sent, and the refusal is not retried even with Pi’s retry on', async () => {
    const { engine, recorder, project } = await setup({ retry: RETRY })
    recorder.respond(script([{ text: 'never sent' }]))
    const { budget, requests } = counted({ maxTurns: 0 })
    const turn = harness(project, {}, { budget })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'turns', limit: 0 } } })
    expect(recorder.connections()).toBe(0)
    expect(requests()).toBe(1)
    expect(turn.events.filter((event) => event.kind === 'retry')).toEqual([])
  }, 60_000)

  it('Pi’s own retry is a request: a 503 then a reply is charged twice; at the limit the retry is refused with nothing more sent', async () => {
    const { engine, recorder, project } = await setup({ retry: RETRY })
    recorder.respond(script([{ status: 503 }, { text: 'recovered' }]))
    const fits = counted({ maxTurns: 2 })
    const first = harness(project, {}, { budget: fits.budget })
    expect((await engine.startTurn(first.input, first.sink, first.ctl, first.host)).text).toBe('recovered')
    expect(recorder.requests).toHaveLength(2)
    expect(fits.requests()).toBe(2)

    recorder.respond(script([{ status: 503 }, { text: 'never sent' }]))
    const tight = counted({ maxTurns: 1 })
    const second = harness(project, { runId: 'r2', threadId: 't2' }, { budget: tight.budget })
    await expect(engine.startTurn(second.input, second.sink, second.ctl, second.host)).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'turns', limit: 1 } } })
    // The 503 was retried once; the retry was refused before it was sent, and not retried itself.
    expect(recorder.requests).toHaveLength(3)
    expect(tight.requests()).toBe(2)
    expect(second.events.filter((event) => event.kind === 'retry')).toEqual([{ kind: 'retry', attempt: 1 }])
  }, 90_000)

  it('Stop during Pi’s retry backoff: no further request is charged or sent', async () => {
    const { engine, recorder, project } = await setup({ retry: { ...RETRY, baseDelayMs: 5_000 } })
    recorder.respond(script([{ status: 503 }]))
    const { budget, requests } = counted({ maxTurns: 5 })
    const turn = harness(project, {}, { budget })
    const running = engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    await expect.poll(() => turn.events.some((event) => event.kind === 'retry'), { timeout: 30_000 }).toBe(true)
    turn.controller.abort()
    expect((await running).aborted).toBe(true)
    await new Promise((done) => setTimeout(done, 6_000))
    expect(recorder.requests).toHaveLength(1)
    expect(requests()).toBe(1)
  }, 60_000)

  it('a provider registration that fails in the factory, with a budgeted turn: protocol, nothing charged, no request', async () => {
    const { engine, recorder, commands, project } = await setup({ testEnv: { MOUSSE_PI_TEST_FAIL_REGISTRATION: 'factory' } })
    recorder.respond(script([{ text: 'never' }]))
    const { budget, requests } = counted({ maxTurns: 3 })
    const turn = harness(project, {}, { budget })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'protocol' })
    expect(commands).not.toContain('prompt')
    expect(recorder.connections()).toBe(0)
    expect(requests()).toBe(0)
  }, 60_000)

  it('a failed re-registration on a new catalogue, with a budgeted turn: protocol, no further request', async () => {
    const { engine, recorder, project, catalogRevision } = await setup({ testEnv: { MOUSSE_PI_TEST_FAIL_REGISTRATION: 'revision' } })
    recorder.respond(script([{ text: 'first' }, { text: 'never' }]))
    const first = harness(project, {}, { budget: counted({ maxTurns: 3 }).budget })
    expect((await engine.startTurn(first.input, first.sink, first.ctl, first.host)).text).toBe('first')
    catalogRevision.value = 2
    const { budget, requests } = counted({ maxTurns: 3 })
    const second = harness(project, { runId: 'r2', nativeHistory: 'user: Say hello\nassistant: first' }, { budget })
    await expect(engine.startTurn(second.input, second.sink, second.ctl, second.host)).rejects.toMatchObject({ code: 'protocol' })
    expect(recorder.requests).toHaveLength(1)
    expect(requests()).toBe(0)
  }, 60_000)
})

describe('the request gate in a bare Pi child (every API of a mixed provider)', () => {
  const APIS = ['anthropic-messages', 'openai-completions', 'openai-responses']

  async function child(answer: () => Promise<PiRequestResponse>) {
    const scratch = scratchDir()
    cleanups.push(() => scratch.cleanup())
    const recorder = await startRecorder()
    cleanups.push(() => recorder.close())
    const bridge = new PiBridge()
    await bridge.start()
    cleanups.push(() => bridge.stop())
    const provider = {
      id: 'mousse-mixed', builtin: false,
      models: APIS.map((api) => ({
        id: `mixed-${api}`, name: api, api, provider: 'mousse-mixed', baseUrl: `${recorder.url}/${api}`,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096
      })) as never
    }
    const catalog: PiCatalogResponse = { provider, apiKey: 'fake-plain-key', catalogRevision: 1 }
    let asked = 0
    const registration = bridge.register({
      catalog: async (first) => (first ? catalog : { ...catalog, apiKey: undefined }),
      ready: () => {},
      turn: async () => ({ attemptToken: 'a1', sessionInstructions: '', tools: [], activeBuiltins: [], mcp: null, catalogRevision: 1 }),
      gate: async () => ({ allow: false, reason: 'test' }),
      request: async () => {
        asked += 1
        return answer()
      },
      quiesce: async () => ({ ok: false, reason: 'test' }),
      fatal: () => {}
    })
    const extension = await testExtension(scratch.dir)
    const pi = launchPi({
      dir: scratch.dir, provider: provider.id, model: `mixed-${APIS[0]}`, extension, bridge: registration.address,
      // Pi's own retry on: a refusal must still not be retried.
      homeFiles: { 'settings.json': testSettings({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } } }) },
      env: { AWS_REGION: 'us-east-1' }
    })
    cleanups.push(() => pi.kill())
    await pi.process.client.send({ type: 'get_state' }).catch((error) => { throw new Error(`${error.message}\n${pi.process.stderr()}`) })
    const prompt = async (api: string) => {
      await pi.process.client.send({ type: 'set_model', provider: provider.id, modelId: `mixed-${api}` })
      const from = pi.events.length
      await pi.process.client.send({ type: 'prompt', message: 'hello' })
      await pi.next((event) => event.type === 'agent_settled', from)
      const events = pi.events.slice(from)
      const end = events.filter((event) => event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant').at(-1)
      return { error: (end?.message as { errorMessage?: string } | undefined)?.errorMessage, retried: events.some((event) => event.type === 'auto_retry_start') }
    }
    return { recorder, prompt, asked: () => asked }
  }

  it('every API passes the wrapper: one charge per request that reaches the recorder', async () => {
    const { recorder, prompt, asked } = await child(async () => ({ ok: true }))
    for (const api of APIS) {
      const before = { requests: recorder.requests.length, asked: asked() }
      await prompt(api)
      const sent = recorder.requests.length - before.requests
      expect(sent, api).toBeGreaterThan(0)
      expect(asked() - before.asked, api).toBe(sent)
    }
  }, 120_000)

  it('a refusal on every API sends nothing and is not retried', async () => {
    const { recorder, prompt } = await child(async () => ({ ok: false, reason: 'mousse_budget_exhausted' }))
    for (const api of APIS) expect(await prompt(api), api).toEqual({ error: 'mousse_budget_exhausted', retried: false })
    expect(recorder.connections()).toBe(0)
  }, 120_000)

  it('an unreachable or failing /pi/request sends nothing, with a fixed text Pi does not retry', async () => {
    const { recorder, prompt } = await child(async () => {
      throw new Error('fetch failed: ECONNREFUSED 503')
    })
    for (const api of APIS) expect(await prompt(api), api).toEqual({ error: 'mousse_gate_unavailable', retried: false })
    expect(recorder.connections()).toBe(0)
  }, 120_000)
})
