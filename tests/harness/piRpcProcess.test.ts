import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentToolAccess } from '../../src/mms/agents/WorkspaceAccessPolicy'
import { instanceEnv } from '../../src/mms/harness/env'
import { PI_RPC_CAPS } from '../../src/mms/harness/drivers/pi'
import { PiRpcEngine, type PiRpcEngineOptions } from '../../src/mms/harness/pi/engine'
import type { AdapterHost, TurnControl, TurnInput, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { isRetriesExhausted } from '../../src/shared/harness/types'
import { cleanBase, piPackage, scratchDir, startRecorder, testExtension, type RecordedRequest, type Recorder } from './piRpcFixture'

// The Pi RPC engine with the real pinned Pi child, Mousse's extension built from source and an
// OpenAI-compatible mock on 127.0.0.1. Fake key only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Step = { text?: string; tool?: { name: string; args: Record<string, unknown> }; status?: number }

/** Answers each request with the next step as an OpenAI chat-completions stream. */
function script(steps: Step[]) {
  let index = 0
  return (_request: RecordedRequest, res: ServerResponse) => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (step.status) {
      const body = JSON.stringify({ error: { message: 'Service unavailable', type: 'server_error' } })
      res.writeHead(step.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      return res.end(body)
    }
    const chunks: unknown[] = []
    if (step.text) chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: step.text } }] })
    if (step.tool) chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${index}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] } }] })
    chunks.push({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
  }
}

interface SetupOptions {
  retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number; provider: { maxRetries: number } }
  testEnv?: Record<`MOUSSE_PI_TEST_${string}`, string>
  adjustLaunch?: PiRpcEngineOptions['adjustLaunch']
  holdTurn?: PiRpcEngineOptions['holdTurn']
}

async function setup(options: SetupOptions = {}) {
  const scratch = scratchDir()
  cleanups.push(() => scratch.cleanup())
  const recorder: Recorder = await startRecorder()
  cleanups.push(() => recorder.close())
  const extension = await testExtension(scratch.dir)
  const stateDir = join(scratch.dir, 'state')
  const home = join(stateDir, 'home')
  const userHome = join(scratch.dir, 'user')
  mkdirSync(userHome, { recursive: true })
  const env = instanceEnv({ instanceId: 'pi:mock', driver: 'pi', configRevision: 0, home, searchPath: [], base: cleanBase(userHome) })
  const commands: string[] = []
  const catalogRevision = { value: 1 }
  const spawned: number[] = []
  const engine = new PiRpcEngine({
    instanceId: 'pi:mock',
    provider: 'mock',
    label: 'Mock',
    capabilities: PI_RPC_CAPS,
    env: () => env,
    stateDir,
    runtime: () => ({ root: piPackage, entry: join(piPackage, 'dist/bundle/rpc-entry.js'), extension }),
    catalog: () => ({
      revision: catalogRevision.value,
      provider: {
        id: 'mock', builtin: false, name: 'Mock',
        models: [{ id: 'mock-model', name: 'Mock model', api: 'openai-completions', provider: 'mock', baseUrl: `${recorder.url}/v1`, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096, compat: { supportsStore: false, supportsDeveloperRole: false } }] as never
      }
    }),
    apiKey: () => 'fake-mock-key',
    onCommand: (type) => commands.push(type),
    onSpawn: (pid) => void spawned.push(pid),
    readyDeadlineMs: 15_000,
    ...(options.testEnv ? { testEnv: options.testEnv } : {}),
    ...(options.adjustLaunch ? { adjustLaunch: options.adjustLaunch } : {}),
    ...(options.holdTurn ? { holdTurn: options.holdTurn } : {}),
    ...(options.retry ? { settings: { retry: options.retry } } : { settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 10, provider: { maxRetries: 0 } } } })
  })
  cleanups.push(() => engine.stop())
  const project = join(scratch.dir, 'project')
  mkdirSync(project)
  return { engine, recorder, commands, project, home, stateDir, catalogRevision, userHome, spawned }
}

function harness(project: string, overrides: Partial<TurnInput> = {}) {
  const events: Array<{ kind: string; [key: string]: unknown }> = []
  const controller = new AbortController()
  const input: TurnInput = {
    runId: 'r1', attemptId: 'a1', threadId: 't1', cwd: project, instanceId: 'pi:mock', model: 'mock-model', llmProvider: 'mock',
    modelPinned: true, mode: 'agent' as TurnInput['mode'], prompt: 'Say hello', messages: [], signal: controller.signal, ...overrides
  }
  const sink: TurnSink = {
    text: (event) => events.push({ ...event, kind: 'text' }),
    thinking: () => {},
    tool: (event) => events.push({ ...event, toolKind: event.kind, kind: 'tool' }),
    nativeMessages: () => {},
    compaction: () => {},
    retry: (attempt) => events.push({ kind: 'retry', attempt }),
    progress: () => {},
    usage: (usage) => events.push({ kind: 'usage', ...usage }),
    providerRef: () => {},
    steerAccepted: (text) => events.push({ kind: 'steer', text }),
    providerMetrics: () => {},
    lineEdits: () => {}
  }
  const ctl: TurnControl = { drainSteer: () => undefined, heartbeat: () => {} }
  const committed: string[] = []
  const host: AdapterHost = {
    tools: {},
    context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (text) => (committed.push(text), `user: Say hello\nassistant: ${text}`) }
  }
  return { input, sink, ctl, host, events, controller, committed }
}

describe('Pi RPC engine with the real Pi child', () => {
  it('runs a turn: the guarded request reaches the mock once, the reply and usage reach the sink', async () => {
    const { engine, recorder, commands, project } = await setup()
    recorder.respond(script([{ text: 'Hello from Pi' }]))
    const turn = harness(project)
    const result = await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(result).toMatchObject({ text: 'Hello from Pi', aborted: false, usage: { input: 10, output: 5 } })
    expect(turn.committed).toEqual(['Hello from Pi'])
    expect(recorder.requests).toHaveLength(1)
    expect(recorder.requests[0].headers.authorization).toBe('Bearer fake-mock-key')
    expect(turn.events.filter((event) => event.kind === 'text').at(-1)).toMatchObject({ phase: 'complete', content: 'Hello from Pi' })
    // Mousse never sends Pi's `bash` command.
    expect(commands).not.toContain('bash')
  }, 60_000)

  it('plan mode offers no write tool, and the gate refuses a read-only child’s read outside its workspace', async () => {
    const { engine, recorder, project } = await setup()
    recorder.respond(script([{ tool: { name: 'write', args: { path: 'denied.txt', content: 'x' } } }, { text: 'done' }]))
    // Plan mode: read-only built-ins only; Pi has no `write` this turn.
    const plan = harness(project, { mode: 'plan' as TurnInput['mode'] })
    expect((await engine.startTurn(plan.input, plan.sink, plan.ctl, plan.host)).text).toBe('done')
    expect(existsSync(join(project, 'denied.txt'))).toBe(false)

    // A shared (read-only) child: its workspace capability checks paths at the gate.
    const outside = join(project, '..', 'outside.txt')
    writeFileSync(outside, 'secret')
    recorder.respond(script([{ tool: { name: 'read', args: { path: outside } } }, { text: 'refused' }]))
    const child = harness(project, { threadId: 'child', child: { readOnly: true } })
    child.host.tools.toolAccess = createAgentToolAccess({ version: 1, workspace: 'shared', access: 'read-only' }, project)
    expect((await engine.startTurn(child.input, child.sink, child.ctl, child.host)).text).toBe('refused')
    const completed = child.events.find((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(completed).toMatchObject({ summary: 'The tool returned an error.' })
    expect(String(completed?.response)).not.toContain('secret')
  }, 60_000)

  it('a read-only child’s reads are checked on the path Pi opens: @, ~, file://, Git Bash and links cannot escape', async () => {
    const { engine, recorder, project, userHome } = await setup()
    const outside = join(project, '..', 'outside.txt')
    writeFileSync(outside, 'outside-secret')
    mkdirSync(join(userHome, '.aws'), { recursive: true })
    writeFileSync(join(userHome, '.aws', 'credentials'), 'aws-secret')
    writeFileSync(join(project, 'inside.txt'), 'inside-content')
    // A link inside the workspace that points outside it.
    symlinkSync(join(project, '..'), join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const forms = [
      `@${outside}`,
      '~/.aws/credentials',
      pathToFileURL(outside).href,
      join('escape', 'outside.txt'),
      ...(process.platform === 'win32' ? [`/${outside[0].toLowerCase()}/${outside.slice(3).split('\\').join('/')}`] : []),
      join('..', 'outside.txt'),
      '@inside.txt'
    ]
    recorder.respond(script([...forms.map((path) => ({ tool: { name: 'read', args: { path } } })), { text: 'checked' }]))
    const child = harness(project, { threadId: 'child', child: { readOnly: true } })
    child.host.tools.toolAccess = createAgentToolAccess({ version: 1, workspace: 'shared', access: 'read-only' }, project)
    expect((await engine.startTurn(child.input, child.sink, child.ctl, child.host)).text).toBe('checked')
    const completed = child.events.filter((event) => event.kind === 'tool' && event.phase === 'complete')
    expect(completed).toHaveLength(forms.length)
    for (const [index, event] of completed.slice(0, -1).entries()) {
      expect(event.summary, forms[index]).toBe('The tool returned an error.')
      expect(String(event.response), forms[index]).not.toMatch(/secret/)
    }
    // Inside the workspace, Pi reads the path the gate checked (`@` resolved the way Pi resolves it).
    expect(completed.at(-1)).toMatchObject({ summary: 'The tool returned successfully.' })
    expect(String(completed.at(-1)?.response)).toContain('inside-content')
  }, 90_000)

  it('an allowed write runs once, and the thread’s next turn reuses the warm process', async () => {
    const { engine, recorder, project, spawned } = await setup()
    recorder.respond(script([{ tool: { name: 'write', args: { path: 'ok.txt', content: 'hi' } } }, { text: 'written' }, { text: 'again' }]))
    const first = harness(project)
    expect((await engine.startTurn(first.input, first.sink, first.ctl, first.host)).text).toBe('written')
    expect(existsSync(join(project, 'ok.txt'))).toBe(true)
    const second = harness(project, { nativeHistory: 'user: Say hello\nassistant: written', runId: 'r2' })
    expect((await engine.startTurn(second.input, second.sink, second.ctl, second.host)).text).toBe('again')
    // The same process served both turns.
    expect(spawned).toHaveLength(1)
  }, 60_000)

  it('Pi’s own retry: a 503 then a reply shows the retry status; always 503 ends retriesExhausted', async () => {
    const retry = { enabled: true, maxRetries: 2, baseDelayMs: 10, provider: { maxRetries: 0 } }
    const { engine, recorder, project } = await setup({ retry })
    recorder.respond(script([{ status: 503 }, { text: 'recovered' }]))
    const turn = harness(project)
    expect((await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).text).toBe('recovered')
    expect(turn.events.filter((event) => event.kind === 'retry')).toEqual([{ kind: 'retry', attempt: 1 }])
    expect(recorder.requests).toHaveLength(2)

    recorder.respond(script([{ status: 503 }]))
    const before = recorder.requests.length
    const failing = harness(project, { runId: 'r2', threadId: 't2' })
    const error = await engine.startTurn(failing.input, failing.sink, failing.ctl, failing.host).catch((caught: unknown) => caught)
    expect(isRetriesExhausted(error), JSON.stringify({ error: String(error), details: (error as { details?: unknown }).details, events: failing.events.map((event) => event.kind) })).toBe(true)
    // One plus two retries, each one HTTP request (no SDK retry below the guard).
    expect(recorder.requests.length - before).toBe(3)
  }, 60_000)

  it('Stop ends the turn as aborted and sends no further request', async () => {
    const { engine, recorder, project } = await setup()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const reply = script([{ text: 'late' }])
    recorder.respond((request, res) => void held.then(() => reply(request, res)))
    const turn = harness(project)
    const running = engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    await expect.poll(() => recorder.requests.length, { timeout: 30_000 }).toBe(1)
    turn.controller.abort()
    const result = await running
    release()
    expect(result.aborted).toBe(true)
    expect(recorder.requests).toHaveLength(1)
  }, 60_000)

  it('Stop while Pi is still in its prompt preflight: the stopped prompt never reaches the provider', async () => {
    let release!: () => void
    let held = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { engine, recorder, project, spawned } = await setup({ holdTurn: async () => { held = true; await gate } })
    recorder.respond(script([{ text: 'should never be asked' }]))
    const turn = harness(project)
    const pending = engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    // The extension's `before_agent_start` waits on `/pi/turn`: Pi has not answered the prompt yet.
    await expect.poll(() => held, { timeout: 30_000 }).toBe(true)
    turn.controller.abort()
    await expect(pending).resolves.toMatchObject({ aborted: true })
    release()
    await new Promise((done) => setTimeout(done, 2000))
    expect(recorder.requests).toHaveLength(0)
    expect(recorder.connections()).toBe(0)
    // The tree goes within the kill's own deadline (slower under load).
    await expect.poll(() => spawned.every((pid) => { try { process.kill(pid, 0); return false } catch { return true } }), { timeout: 10_000 }).toBe(true)
  }, 60_000)

  it('a provider registration that fails in the factory ends the start as protocol: no prompt, no request', async () => {
    const { engine, recorder, commands, project } = await setup({ testEnv: { MOUSSE_PI_TEST_FAIL_REGISTRATION: 'factory' } })
    recorder.respond(script([{ text: 'never' }]))
    const turn = harness(project)
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'protocol' })
    expect(commands).not.toContain('prompt')
    expect(recorder.connections()).toBe(0)
  }, 60_000)

  it('a re-registration on a new catalogue revision that fails kills the process: protocol, no request', async () => {
    const { engine, recorder, project, catalogRevision } = await setup({ testEnv: { MOUSSE_PI_TEST_FAIL_REGISTRATION: 'revision' } })
    recorder.respond(script([{ text: 'first' }, { text: 'never' }]))
    const first = harness(project)
    expect((await engine.startTurn(first.input, first.sink, first.ctl, first.host)).text).toBe('first')
    catalogRevision.value = 2
    const second = harness(project, { runId: 'r2', nativeHistory: 'user: Say hello\nassistant: first' })
    await expect(engine.startTurn(second.input, second.sink, second.ctl, second.host)).rejects.toMatchObject({ code: 'protocol' })
    expect(recorder.requests).toHaveLength(1)
  }, 60_000)

  it('refuses a child whose AWS SDK is not pinned to one attempt (protocol at ready, no prompt)', async () => {
    const { engine, recorder, commands, project } = await setup({
      adjustLaunch: (launch) => ({ ...launch, env: { ...launch.env, AWS_MAX_ATTEMPTS: '3' } })
    })
    const turn = harness(project)
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'protocol' })
    expect(commands).not.toContain('prompt')
    expect(recorder.connections()).toBe(0)
  }, 60_000)

  it('stop() kills a warm process and settles only after it exited (the state dir can then be deleted)', async () => {
    const { engine, recorder, project, stateDir } = await setup()
    recorder.respond(script([{ text: 'warm' }]))
    const turn = harness(project)
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    expect(existsSync(join(stateDir, 'threads.json'))).toBe(true)
    await engine.stop()
    // Nothing holds files under the state dir any more (Windows locks open files).
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    expect(existsSync(stateDir)).toBe(false)
  }, 60_000)
})
