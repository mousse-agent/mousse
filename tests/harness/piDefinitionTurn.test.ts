import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { RunCounters, RunSpend, TurnBudget, type BudgetLimits } from '../../src/mms/harness/budget'
import type { PiLaunch } from '../../src/mms/harness/pi/launch'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../../src/shared/agents/types'
import { sessionInstructions, turnPreamble } from '../../src/mms/run/mcp/appTools/assemble'
import { APPLET_GENERATION_GUIDANCE } from '../../src/shared/appletGuidance'
import { harness, script, setup as setupEngine } from './piRpcEngineFixture'
import type { RecordedRequest } from './piRpcFixture'

// PR 4 4d-rpc (evidence item 12): agent definition turns on the Pi RPC engine, against the real
// pinned Pi child, Mousse's extension built from source and an OpenAI-compatible mock on 127.0.0.1.
// Each turn gets a fresh process and an in-memory session, runs on the definition's own system
// prompt, is offered exactly its grants, reports usage with its price, and is held to its turn,
// tool-call, token and cost limits. Fake key only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SYSTEM = 'You are the release-notes agent. Answer in one line. MOUSSE_DEFINITION_PROMPT'
/** USD per million tokens. */
const COST = { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }

function policy(project: string): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 't1', runId: 'r1', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [project] },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}

function grants(...tools: string[]): EffectiveAgentGrants {
  return { skills: [], mcpTools: [], builtinTools: tools.map((id) => ({ id, source: 'definition' as never })), denied: [] }
}

const definition = (project: string, ...tools: string[]): DefinitionAuthority => ({ policy: policy(project), grants: grants(...tools) })
const definitionInput = { session: 'ephemeral' as const, instructions: { text: SYSTEM, placement: 'replace' as const }, model: 'gpt-4.1' }

async function setup(options: Parameters<typeof setupEngine>[1] = {}) {
  const launches: Array<Extract<PiLaunch, { runs: 'yes' }>> = []
  const env = await setupEngine(cleanups, {
    models: (url) => [{ id: 'gpt-4.1', name: 'GPT-4.1', api: 'openai-completions', provider: 'mock', baseUrl: `${url}/v1`, reasoning: false, input: ['text'], cost: COST, contextWindow: 200_000, maxTokens: 64_000, compat: { supportsStore: false, supportsDeveloperRole: false } }],
    adjustLaunch: (launch) => (launches.push(launch), launch),
    ...options
  })
  return { ...env, launches }
}

/** A run's budget whose spend is held by a real ledger. */
function budget(limits: BudgetLimits) {
  return new TurnBudget(limits, new RunCounters(), new RunSpend())
}

const body = (request: RecordedRequest) => JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
const processes = (engine: unknown) => (engine as { threads: Map<string, { alive: boolean }> }).threads

/** A reply calling `ls` that reports `output` output tokens, then plain replies. */
function toolThenText(output: number) {
  let calls = 0
  return (_request: RecordedRequest, res: ServerResponse) => {
    const first = calls++ === 0
    const chunks = first
      ? [{ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{}' } }] } }] },
         { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output } }]
      : [{ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'never' } }] },
         { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
  }
}

describe('agent definition turns on the Pi RPC engine (real pinned Pi child)', () => {
  it('each turn runs in a fresh process with an in-memory session, on the definition’s system prompt, and leaves nothing behind', async () => {
    const { engine, recorder, project, stateDir, launches } = await setup()
    // The thread's own chat turn first: its warm process and session must stay untouched.
    recorder.respond(script([{ text: 'chat reply' }]))
    const chat = harness(project, { model: 'gpt-4.1' })
    await engine.startTurn(chat.input, chat.sink, chat.ctl, chat.host)
    const threadsFile = join(stateDir, 'threads.json')
    const savedBefore = readFileSync(threadsFile, 'utf8')
    const sessionsDir = join(stateDir, 'sessions')
    const sessionFiles = () => (existsSync(sessionsDir) ? readdirSync(sessionsDir, { recursive: true }).length : 0)
    const filesBefore = sessionFiles()

    recorder.respond(script([{ text: 'one line' }]))
    const before = recorder.requests.length
    for (const [index, history] of [['', ''], ['user: earlier question\nassistant: earlier answer', 'earlier answer']].entries()) {
      const turn = harness(project, { ...definitionInput, runId: `d${index}`, attemptId: `d${index}`, nativeHistory: history[0] }, { definition: definition(project, 'read') })
      const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
      expect(result).toMatchObject({ text: 'one line', aborted: false })
      // The turn's process is gone when it ends; the thread's own warm process is still there.
      expect([...processes(engine).keys()]).toEqual(['t1'])
      const sent = body(recorder.requests.at(-1)!)
      // The definition's prompt replaced Pi's whole system prompt.
      expect(sent.messages[0]).toEqual({ role: 'system', content: SYSTEM })
      if (history[1]) expect(JSON.stringify(sent.messages.slice(1))).toContain(history[1])
    }
    expect(recorder.requests.length - before).toBe(2)
    // One launch for the chat, then one per definition turn: never the chat's process.
    expect(launches).toHaveLength(3)
    expect(launches[0].args).toContain('--session-dir')
    for (const launch of launches.slice(1)) {
      expect(launch.args).toContain('--no-session')
      expect(launch.args).not.toContain('--session-dir')
      expect(launch.args).not.toContain('--session')
    }
    expect(processes(engine).get('t1')?.alive).toBe(true)
    // No session file was written and the thread's session mapping is the chat's, unchanged.
    expect(sessionFiles()).toBe(filesBefore)
    expect(readFileSync(threadsFile, 'utf8')).toBe(savedBefore)
  }, 120_000)

  it('is offered exactly its grants, and never a delegation tool even when granted', async () => {
    const { engine, recorder, project } = await setup({
      mousseTools: () => [
        { name: 'create_task', description: 'Create a task', inputSchema: { type: 'object', properties: {} }, class: 'mutation' },
        { name: 'list_tasks', description: 'List tasks', inputSchema: { type: 'object', properties: {} }, class: 'read' },
        { name: 'delegate_task', description: 'Delegate', inputSchema: { type: 'object', properties: {} }, class: 'delegation' }
      ]
    })
    recorder.respond(script([{ text: 'ok' }]))
    const turn = harness(project, definitionInput, {
      definition: definition(project, 'read', 'grep', 'list_tasks', 'delegate_task'),
      bridge: { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused' }, turnToken: 'tt', sessionInstructions: '', turnPreamble: '', userMcp: 'proxy', toolPolicy: { allow: ['delegate_task', 'grep', 'list_tasks', 'read'] } }
    })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    const offered = (body(recorder.requests[0]).tools ?? []).map((tool) => tool.function.name).sort()
    expect(offered).toEqual(['grep', 'list_tasks', 'read'])
  }, 90_000)

  it('reports each request’s usage with its price', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ tool: { name: 'ls', args: {} } }, { text: 'done' }]))
    const turn = harness(project, definitionInput, { definition: definition(project, 'ls') })
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(result.text).toBe('done')
    const usage = turn.events.filter((event) => event.kind === 'usage')
    expect(usage).toHaveLength(2)
    // 10 input tokens at $3/M and 5 output tokens at $15/M, per request.
    for (const event of usage) {
      expect(event).toMatchObject({ input: 10, output: 5 })
      expect(event.costUsd as number).toBeCloseTo((10 * 3 + 5 * 15) / 1e6, 12)
    }
    expect(result.usage).toMatchObject({ input: 20, output: 10 })
  }, 90_000)

  it('the turn limit: the second request never reaches the provider', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ tool: { name: 'ls', args: {} } }, { text: 'never sent' }]))
    const turn = harness(project, definitionInput, { definition: definition(project, 'ls'), budget: budget({ maxTurns: 1 }) })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'turns', limit: 1 } } })
    expect(recorder.requests).toHaveLength(1)
  }, 90_000)

  it('the tool-call limit: the second call never runs, and no request follows it', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ tools: [{ name: 'ls', args: {} }, { name: 'ls', args: { path: '.' } }] }, { text: 'never sent' }]))
    const turn = harness(project, definitionInput, { definition: definition(project, 'ls'), budget: budget({ maxToolCalls: 1 }) })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'tool_calls', limit: 1 } } })
    expect(recorder.requests).toHaveLength(1)
    const completed = turn.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(completed.filter((event) => event.summary !== 'The tool returned an error.')).toHaveLength(1)
  }, 90_000)

  it('the output-token limit: once what is left cannot hold a request, nothing more is sent', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(toolThenText(290))
    const turn = harness(project, definitionInput, { definition: definition(project, 'ls'), budget: budget({ maxOutputTokens: 300 }) })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'output_tokens', limit: 300 } } })
    expect(recorder.requests).toHaveLength(1)
  }, 90_000)

  it('the cost limit: once what is left cannot pay for a request, nothing more is sent', async () => {
    const { engine, recorder, project } = await setup()
    // The first request is reserved at a cap that fits the $0.02 with its input bound (about 670
    // tokens here). 600 output tokens at $15/M use $0.009 of it: what is left cannot pay for the
    // next request's input bound and 256 output tokens.
    recorder.respond(toolThenText(600))
    const turn = harness(project, definitionInput, { definition: definition(project, 'ls'), budget: budget({ maxUsd: 0.02 }) })
    const error = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'cost_usd', limit: 0.02 } } })
    expect(recorder.requests).toHaveLength(1)
  }, 90_000)

  it('a definition turn that does not come whole is refused before any process starts', async () => {
    const { engine, recorder, project, launches } = await setup()
    for (const overrides of [{ session: undefined }, { instructions: undefined }, { instructions: { text: SYSTEM, placement: 'append' as const } }]) {
      const turn = harness(project, { ...definitionInput, ...overrides }, { definition: definition(project, 'read') })
      await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'policy_unenforceable' })
    }
    // Its instructions and own session without the authority are refused too.
    const bare = harness(project, definitionInput)
    await expect(engine.startTurn(bare.input, bare.sink, bare.ctl, bare.host)).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(launches).toHaveLength(0)
    expect(recorder.connections()).toBe(0)
  }, 60_000)

  it('sends the definition’s prompt as written and its message as given, whatever chat instructions the bridge carries', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ text: 'ok' }]))
    // What a chat turn's bridge carries in production: Mousse's orchestration and applet guidance,
    // and a preamble with the applet catalogue and the Mousse tools usable now.
    const bridge = {
      mcp: { url: 'http://127.0.0.1:9/mcp', token: 'unused' }, turnToken: 'tt', userMcp: 'proxy' as const,
      sessionInstructions: sessionInstructions({ mcp: true, appletGuidance: APPLET_GENERATION_GUIDANCE }),
      turnPreamble: turnPreamble({ loadedSkills: [], appletCatalogue: '## Applets - MOUSSE_APPLET_CANARY', usableTools: ['delegate_task', 'thread_send', 'create_task'] }),
      toolPolicy: { allow: ['read'] }
    }
    expect(bridge.sessionInstructions.length).toBeGreaterThan(100)
    expect(bridge.turnPreamble).toContain('delegate_task')
    const turn = harness(project, { ...definitionInput, prompt: 'Summarize the release.' }, { definition: definition(project, 'read'), bridge })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    const sent = body(recorder.requests[0])
    expect(sent.messages[0]).toEqual({ role: 'system', content: SYSTEM })
    expect(sent.messages[1].role).toBe('user')
    const user = JSON.stringify(sent.messages[1].content)
    expect(user).toContain('Summarize the release.')
    for (const leaked of ['delegate_task', 'thread_send', 'create_task', 'MOUSSE_APPLET_CANARY', 'mousse-applet', 'Usable now']) {
      expect(user, leaked).not.toContain(leaked)
      expect(JSON.stringify(sent.messages[0]), leaked).not.toContain(leaked)
    }
    expect(sent.messages[1].content === 'Summarize the release.' || JSON.stringify(sent.messages[1].content) === JSON.stringify([{ type: 'text', text: 'Summarize the release.' }])).toBe(true)
  }, 90_000)

  it('limits are shared across a run’s records: a later attempt whose turn limit the first used up sends nothing', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ text: 'first' }]))
    const shared = budget({ maxTurns: 1 })
    const first = harness(project, { ...definitionInput, runId: 'run', attemptId: 'a1' }, { definition: definition(project, 'read'), budget: shared })
    expect(await engine.startTurn(first.input, first.sink, first.ctl, first.host)).toMatchObject({ text: 'first' })
    const connections = recorder.connections()
    const second = harness(project, { ...definitionInput, runId: 'run', attemptId: 'a2' }, { definition: definition(project, 'read'), budget: shared })
    await expect(engine.startTurn(second.input, second.sink, second.ctl, second.host)).rejects.toMatchObject({ code: 'budget_exhausted', details: { limit: { kind: 'turns', limit: 1 } } })
    expect(recorder.requests).toHaveLength(1)
    expect(recorder.connections()).toBe(connections)
  }, 90_000)
})
