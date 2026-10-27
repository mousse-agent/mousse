import { existsSync, readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { createServer, type Http2Server } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunCounters, RunSpend, TurnBudget, type BudgetLimits, type SpendScope } from '../../src/mms/harness/budget'
import { grantFloor, hookCap, hookThinkingBudget, thinkingBudgetFor } from '../../src/mms/harness/pi/reservation'
import { harness, setup as setupEngine, type SetupOptions } from './piRpcEngineFixture'
import type { RecordedRequest } from './piRpcFixture'

// PR 4 4b3: spend reservation in the real pinned Pi child, against local recorders for every API
// whose cap Mousse can bound. The hook path (what Mousse's final check reads, logged by a test-only
// observer chained after it) and the HTTP body path (what the recorder received) are asserted
// separately. Fake keys only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const COST = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

/** Always answers 503, as Bedrock does, over cleartext HTTP/2; records every body. */
async function bedrockRecorder(): Promise<{ url: string; bodies: unknown[] }> {
  const bodies: unknown[] = []
  const server: Http2Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      res.writeHead(503, { 'content-type': 'application/json', 'x-amzn-errortype': 'ServiceUnavailableException' })
      res.end(JSON.stringify({ message: 'Service unavailable' }))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }
}

/** One model per listed API on the mock provider (Bedrock at its own HTTP/2 recorder). */
function models(url: string, bedrockUrl: string, patch: Record<string, unknown> = {}) {
  const base = { provider: 'mock', input: ['text'], cost: COST, contextWindow: 200_000, maxTokens: 64_000, ...patch }
  return [
    { ...base, id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', api: 'anthropic-messages', baseUrl: url, reasoning: true },
    { ...base, id: 'gpt-4.1', name: 'GPT-4.1', api: 'openai-completions', baseUrl: `${url}/v1`, reasoning: false, compat: { supportsStore: false, supportsDeveloperRole: false } },
    { ...base, id: 'gpt-5', name: 'GPT-5', api: 'openai-responses', baseUrl: `${url}/v1`, reasoning: true },
    { ...base, id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', api: 'google-generative-ai', baseUrl: `${url}/v1beta`, reasoning: true },
    { ...base, id: 'anthropic.claude-sonnet-4-5-v1:0', name: 'Claude Sonnet 4.5', api: 'bedrock-converse-stream', baseUrl: bedrockUrl, reasoning: true }
  ]
}

function sse(res: ServerResponse, events: unknown[], named = false): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map((event) => `${named ? `event: ${(event as { type: string }).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''))
}

/** A short streamed reply in each API's format, reporting `output` output tokens. */
function reply(output = 5) {
  return (request: RecordedRequest, res: ServerResponse) => {
    if (request.url.includes('/chat/completions'))
      return sse(res, [
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output } }
      ])
    if (request.url.includes('/responses')) {
      const item = { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }
      return sse(res, [
        { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: 'm1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'hi' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: output, total_tokens: 10 + output, input_tokens_details: { cached_tokens: 0 } } } }
      ], true)
    }
    if (request.url.includes('/messages'))
      return sse(res, [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
        { type: 'message_stop' }
      ], true)
    if (request.url.includes('streamGenerateContent'))
      return sse(res, [{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: output, totalTokenCount: 10 + output } }])
    res.writeHead(404).end()
  }
}

/** The cap and thinking budget at each API's HTTP body path (Google's are under `generationConfig`). */
function bodyCaps(api: string, body: Record<string, any>): { cap?: number; thinking?: number } {
  switch (api) {
    case 'anthropic-messages':
      return { cap: body.max_tokens, thinking: body.thinking?.budget_tokens }
    case 'openai-completions':
      return { cap: body.max_completion_tokens ?? body.max_tokens }
    case 'openai-responses':
      return { cap: body.max_output_tokens }
    case 'google-generative-ai':
      return { cap: body.generationConfig?.maxOutputTokens, thinking: body.generationConfig?.thinkingConfig?.thinkingBudget }
    default:
      return { cap: body.inferenceConfig?.maxTokens, thinking: body.additionalModelRequestFields?.thinking?.budget_tokens }
  }
}

/** A run's budget whose spend is recorded: every grant and every settlement. */
function spending(limits: BudgetLimits) {
  const ledger = new RunSpend()
  const grants: number[] = []
  const settled: string[] = []
  const scope: SpendScope = {
    reserve: (request, binding) => {
      const result = ledger.reserve(request, binding)
      grants.push(result.ok ? result.cap : -1)
      return result
    },
    settle: (id, outcome) => {
      settled.push(outcome.kind)
      return ledger.settle(id, outcome)
    }
  }
  return { budget: new TurnBudget(limits, new RunCounters(), scope), grants, settled, ledger }
}

interface HookEntry { api: string; id: string; cap: number; thinkingBudget: number; params: unknown }

async function setup(options: SetupOptions & { modelPatch?: Record<string, unknown> } = {}) {
  const bedrock = await bedrockRecorder()
  const env = await setupEngine(cleanups, {
    models: (url) => models(url, bedrock.url, options.modelPatch),
    extraEnv: { AWS_REGION: 'us-east-1' },
    ...options,
    testEnv: { ...(options.testEnv ?? {}) }
  })
  return { ...env, bedrock }
}

/** The payload log's entries (one per reserved request whose final check passed). */
function hookLog(path: string): HookEntry[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as HookEntry) : []
}

const EFFORTS = [undefined, 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const APIS = [
  ['anthropic-messages', 'claude-sonnet-4-5'],
  ['openai-completions', 'gpt-4.1'],
  ['openai-responses', 'gpt-5'],
  ['google-generative-ai', 'gemini-2.5-flash'],
  ['bedrock-converse-stream', 'anthropic.claude-sonnet-4-5-v1:0']
] as const

describe('spend reservation in the real Pi child (Pi RPC engine)', () => {
  it.each(APIS)('%s: every effort’s request carries a wire cap at or under its reservation, in the hook and in the body, and a fitting one succeeds', async (api, id) => {
    const log = join((await import('node:os')).tmpdir(), `mousse-spend-${process.pid}-${api}-${Date.now()}.log`)
    cleanups.push(async () => (await import('node:fs')).rmSync(log, { force: true }))
    const { engine, recorder, project, bedrock } = await setup({ testEnv: { MOUSSE_PI_TEST_PAYLOAD_LOG: log } })
    recorder.respond(reply())
    const runs = EFFORTS.map((effort) => ({ effort, ...spending({ maxOutputTokens: 40_000 }) }))
    const outcomes = await Promise.all(runs.map(({ effort, budget }) => {
      const turn = harness(project, { runId: `r-${effort}`, threadId: `t-${effort}`, attemptId: `a-${effort}`, model: effort ? `${id}:${effort}` : id }, { budget })
      return engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).then((result) => ({ ok: true as const, text: result.text }), (error: Error) => ({ ok: false as const, error }))
    }))
    const hooks = hookLog(log)
    expect(hooks).toHaveLength(EFFORTS.length)
    for (const entry of hooks) {
      expect(entry.api).toBe(api)
      // (i) Hook path: what Mousse's check read; at or under the reservation, equal to the grant.
      expect(hookCap(api, entry.params)).toBe(entry.cap)
      if (entry.thinkingBudget) expect(hookThinkingBudget(api, entry.params)).toBe(entry.thinkingBudget)
    }
    for (const run of runs) {
      expect(run.grants).toHaveLength(1)
      // The thinking budget is never cut to make room: the grant leaves the answer room above it.
      expect(run.grants[0]).toBeGreaterThanOrEqual(grantFloor(api === 'anthropic-messages' || api === 'bedrock-converse-stream' ? (run.effort ? thinkingBudgetFor(run.effort) : 0) : 0))
      expect(run.grants[0]).toBeLessThanOrEqual(40_000)
    }
    // (ii) Body path: what reached the recorder.
    const bodies = api === 'bedrock-converse-stream' ? bedrock.bodies as Array<Record<string, unknown>> : recorder.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>)
    expect(bodies).toHaveLength(EFFORTS.length)
    const grants = runs.map((run) => run.grants[0]).sort((a, b) => a - b)
    const sent = bodies.map((body) => bodyCaps(api, body))
    expect(sent.map((caps) => caps.cap).sort((a, b) => a! - b!)).toEqual(grants)
    for (const caps of sent) if (caps.thinking !== undefined && api !== 'google-generative-ai') expect([1024, 2048, 8192, 16384]).toContain(caps.thinking)
    if (api === 'bedrock-converse-stream') {
      // Bedrock answers 503 here: each reservation is released, none kept.
      for (const run of runs) expect(run.settled).toEqual(['released'])
      for (const outcome of outcomes) expect(outcome.ok).toBe(false)
      return
    }
    for (const outcome of outcomes) expect(outcome).toMatchObject({ ok: true, text: 'hi' })
    for (const run of runs) {
      expect(run.settled).toEqual(['used'])
      expect(run.ledger.committed.output).toBe(5)
    }
  }, 180_000)

  it('a grant that fits is sized so the wire cap equals it, with the effort’s full thinking budget', async () => {
    const log = join((await import('node:os')).tmpdir(), `mousse-spend-${process.pid}-fit-${Date.now()}.log`)
    cleanups.push(async () => (await import('node:fs')).rmSync(log, { force: true }))
    const { engine, recorder, project } = await setup({ testEnv: { MOUSSE_PI_TEST_PAYLOAD_LOG: log } })
    recorder.respond(reply())
    const run = spending({ maxOutputTokens: 20_000 })
    const turn = harness(project, { model: 'claude-sonnet-4-5:high' }, { budget: run.budget })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(run.grants).toEqual([20_000])
    expect(JSON.parse(recorder.requests[0].body)).toMatchObject({ max_tokens: 20_000, thinking: { type: 'enabled', budget_tokens: 16_384 } })
  }, 90_000)

  it('Sol’s case: 256 output tokens left at high effort on a budget-thinking model is refused with nothing sent, never sent as 16,640', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(reply())
    const run = spending({ maxOutputTokens: 256 })
    const turn = harness(project, { model: 'claude-sonnet-4-5:high' }, { budget: run.budget })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'output_tokens', limit: 256 } } })
    expect(recorder.connections()).toBe(0)
    expect(run.grants).toEqual([-1])
  }, 60_000)

  it('a first request whose input bound passes the input limit sends nothing', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(reply())
    const run = spending({ maxInputTokens: 100 })
    const turn = harness(project, { model: 'gpt-4.1' }, { budget: run.budget })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught) as Error
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'input_tokens', limit: 100 } } })
    expect(error.message).toContain('100 input tokens')
    expect(recorder.connections()).toBe(0)
  }, 60_000)

  it('a before_provider_request that raises the cap trips the final check: mousse_spend_cap_mismatch, nothing sent, reservation released', async () => {
    const { engine, recorder, project } = await setup({ testEnv: { MOUSSE_PI_TEST_RAISE_CAP: '1' } })
    recorder.respond(reply())
    const run = spending({ maxOutputTokens: 4_000 })
    const turn = harness(project, { model: 'gpt-4.1' }, { budget: run.budget })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught) as Error
    expect(error).toMatchObject({ code: 'protocol' })
    expect(error.message).toContain('did not match its reservation')
    expect(recorder.connections()).toBe(0)
    expect(run.settled).toEqual(['released'])
    expect(run.ledger.used()).toEqual({ input: 0, output: 0, usd: 0 })
  }, 60_000)

  it('a provider that goes over its cap ends the run, and the result names the overshoot', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(reply(5_300))
    const run = spending({ maxOutputTokens: 5_000 })
    const turn = harness(project, { model: 'gpt-4.1' }, { budget: run.budget })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught) as Error
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'output_tokens', limit: 5_000, actual: 5_300 } } })
    expect(error.message).toContain('exceeded its output cap by 300 tokens')
    expect(recorder.requests).toHaveLength(1)
  }, 60_000)

  it('a compaction is reserved like any request, and refused at the limit with nothing sent', async () => {
    const log = join((await import('node:os')).tmpdir(), `mousse-spend-${process.pid}-compact-${Date.now()}.log`)
    cleanups.push(async () => (await import('node:fs')).rmSync(log, { force: true }))
    const { engine, recorder, project } = await setup({ testEnv: { MOUSSE_PI_TEST_PAYLOAD_LOG: log }, modelPatch: { contextWindow: 128_000 } })
    // Usage near the window: Pi compacts after the reply, a second (summary) request.
    let calls = 0
    recorder.respond((request, res) => {
      calls += 1
      if (calls > 1) return reply()(request, res)
      sse(res, [
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'large answer '.repeat(10_000) } }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120_000, completion_tokens: 3_000, total_tokens: 123_000 } }
      ])
    })
    const roomy = spending({ maxOutputTokens: 100_000 })
    const turn = harness(project, { model: 'gpt-4.1' }, { budget: roomy.budget })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(recorder.requests).toHaveLength(2)
    const hooks = hookLog(log)
    expect(hooks).toHaveLength(2)
    for (const entry of hooks) expect(hookCap(entry.api, entry.params)).toBeLessThanOrEqual(entry.cap)
    const summary = JSON.parse(recorder.requests[1].body) as Record<string, number>
    expect(summary.max_completion_tokens ?? summary.max_tokens).toBe(roomy.grants[1])

    // The same turn with only the first reply's output left: the summary request is refused.
    calls = 0
    const before = recorder.requests.length
    const tight = spending({ maxOutputTokens: 3_200 })
    const again = harness(project, { model: 'gpt-4.1', runId: 'r2', threadId: 't2' }, { budget: tight.budget })
    await expect(engine.startTurn(again.input, again.sink, again.ctl, again.host)).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'output_tokens' } } })
    expect(recorder.requests.length - before).toBe(1)
    expect(tight.grants).toEqual([3_200, -1])
  }, 120_000)

  it('Bedrock always 503 with Pi’s retry: one reservation per HTTP request, each released', async () => {
    const { engine, project, bedrock } = await setup({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } } })
    const run = spending({ maxOutputTokens: 40_000 })
    const turn = harness(project, { model: 'anthropic.claude-sonnet-4-5-v1:0' }, { budget: run.budget })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toBeTruthy()
    expect(bedrock.bodies).toHaveLength(3)
    expect(run.grants).toHaveLength(3)
    expect(run.settled).toEqual(['released', 'released', 'released'])
    expect(run.ledger.used()).toEqual({ input: 0, output: 0, usd: 0 })
  }, 90_000)
})
