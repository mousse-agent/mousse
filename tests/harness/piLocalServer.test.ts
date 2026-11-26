import { afterEach, describe, expect, it } from 'vitest'
import type { LocalModelFacts } from '../../src/shared/localServers'
import { LOCAL_PLACEHOLDER_KEY } from '../../src/mms/providers/local/LocalConnections'
import { harness, script, setup as setupEngine, type SetupOptions } from './piRpcEngineFixture'
import { startRecorder } from './piRpcFixture'

// A local model server (`pi:local-<slug>`) on the real pinned Pi child, Mousse's extension built from source, against
// a recorder on 127.0.0.1 standing in for the server: the bytes each request carries, where it may go, and which
// turns run tool-free or are refused before anything starts. Fake keys only; nothing leaves the machine.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const setup = (options: SetupOptions = {}) => setupEngine(cleanups, options)

/** One Ollama-style model whose id ends like an effort level. */
const models = (url: string) => [{
  id: 'phi3:medium', name: 'phi3:medium', api: 'openai-completions', provider: 'mock', baseUrl: `${url}/v1`, reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192,
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictMode: false, maxTokensField: 'max_tokens' }
}]

const facts = (patch: Partial<LocalModelFacts> = {}): LocalModelFacts => ({ tools: 'reported', images: false, loadedWindow: 32768, loaded: true, ...patch })

const chats = (requests: Array<{ url: string; body: string; headers: Record<string, unknown> }>) => requests.filter((request) => request.url.endsWith('/chat/completions'))

describe('a local model server in the real Pi child', () => {
  it('a keyless server gets no Authorization (never the placeholder), and the served id with its colon', async () => {
    const { engine, recorder, project } = await setup({ models, apiKey: LOCAL_PLACEHOLDER_KEY, pin: (url) => ({ origin: url, keyless: true }), localModel: () => facts() })
    recorder.respond(script([{ text: 'hello' }]))
    const turn = harness(project, { model: 'phi3:medium' })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    const [request] = chats(recorder.requests)
    expect(request).toBeDefined()
    expect(request!.headers.authorization).toBeUndefined()
    expect(request!.body).not.toContain(LOCAL_PLACEHOLDER_KEY)
    expect(JSON.parse(request!.body).model).toBe('phi3:medium')
  }, 90_000)

  it("a keyed server gets exactly its own key, and Unsloth Studio's server-side tools are turned off", async () => {
    const { engine, recorder, project } = await setup({ models, apiKey: 'sk-local-123', pin: (url) => ({ origin: url, keyless: false, extraBody: { enable_tools: false } }), localModel: () => facts() })
    recorder.respond(script([{ text: 'hello' }]))
    const turn = harness(project, { model: 'phi3:medium' })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    const [request] = chats(recorder.requests)
    expect(request!.headers.authorization).toBe('Bearer sk-local-123')
    expect(JSON.parse(request!.body).enable_tools).toBe(false)
  }, 90_000)

  it('never follows a redirect: the address it points to gets no connection', async () => {
    const elsewhere = await startRecorder()
    cleanups.push(() => elsewhere.close())
    elsewhere.respond(script([{ text: 'stolen' }]))
    const { engine, recorder, project } = await setup({ models, apiKey: LOCAL_PLACEHOLDER_KEY, pin: (url) => ({ origin: url, keyless: true }), localModel: () => facts() })
    recorder.respond((_request, res) => {
      res.writeHead(307, { location: `${elsewhere.url}/v1/chat/completions` })
      res.end()
    })
    const turn = harness(project, { model: 'phi3:medium' })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host).catch(() => undefined)
    expect(chats(recorder.requests).length).toBeGreaterThan(0)
    expect(elsewhere.connections()).toBe(0)
  }, 90_000)

  it('a Chat only model runs a person’s thread with no tool at all, and is refused for a bot before anything starts', async () => {
    const { engine, recorder, project, spawned } = await setup({ models, apiKey: LOCAL_PLACEHOLDER_KEY, pin: (url) => ({ origin: url, keyless: true }), localModel: () => facts({ tools: 'none' }) })
    recorder.respond(script([{ text: 'just text' }]))
    const turn = harness(project, { model: 'phi3:medium' })
    await engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    const body = JSON.parse(chats(recorder.requests)[0]!.body) as { tools?: unknown[] }
    expect(body.tools ?? []).toEqual([])
    const before = spawned.length
    const sent = recorder.requests.length
    const bot = harness(project, { model: 'phi3:medium', threadId: 'bot-thread' }, { bot: { activationId: 'a1' } as never })
    await expect(engine.startTurn(bot.input, bot.sink, bot.ctl, bot.host)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/Chat only/) })
    expect([spawned.length, recorder.requests.length]).toEqual([before, sent])
  }, 90_000)

  it('refuses an agent turn on an unknown or too small window, and delegated work on tools the server only reported', async () => {
    let current = facts({ loadedWindow: undefined })
    const { engine, recorder, project, spawned } = await setup({ models, apiKey: LOCAL_PLACEHOLDER_KEY, pin: (url) => ({ origin: url, keyless: true }), localModel: () => current })
    const turn = harness(project, { model: 'phi3:medium' })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ message: expect.stringMatching(/window is unknown/) })
    current = facts({ loadedWindow: 4096 })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ message: expect.stringMatching(/4K window/) })
    current = facts()
    const child = harness(project, { model: 'phi3:medium', child: {} as never })
    await expect(engine.startTurn(child.input, child.sink, child.ctl, child.host)).rejects.toMatchObject({ message: expect.stringMatching(/Check tools/) })
    expect([spawned.length, recorder.connections()]).toEqual([0, 0])
  }, 90_000)

  it('a Stop while the server’s list is read again reaches the turn: it ends aborted and nothing starts', async () => {
    let listed!: () => void
    let reading!: () => void
    const read = new Promise<void>((done) => { reading = done })
    const refreshLocal = () => { reading(); return new Promise<void>((done) => { listed = done }) }
    const { engine, recorder, project, spawned } = await setup({ models, apiKey: LOCAL_PLACEHOLDER_KEY, pin: (url) => ({ origin: url, keyless: true }), localModel: () => facts(), refreshLocal })
    const turn = harness(project, { model: 'phi3:medium' })
    const pending = engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)
    await read
    await expect(engine.stopThread(turn.input.threadId)).resolves.toBe('stopped')
    listed()
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect([spawned.length, recorder.connections()]).toEqual([0, 0])
  }, 90_000)

  it('refuses a model the server does not list (a custom id) before anything starts', async () => {
    const { engine, recorder, project, spawned } = await setup({ models, apiKey: LOCAL_PLACEHOLDER_KEY, pin: (url) => ({ origin: url, keyless: true }), localModel: (id) => (id === 'phi3:medium' ? facts() : undefined) })
    const turn = harness(project, { model: 'my-custom-model' })
    await expect(engine.startTurn(turn.input, turn.sink, turn.ctl, turn.host)).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/does not list my-custom-model/) })
    expect([spawned.length, recorder.connections()]).toEqual([0, 0])
  }, 90_000)
})
