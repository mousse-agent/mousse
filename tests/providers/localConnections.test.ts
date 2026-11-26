import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderAuthService } from '../../src/mms/providers/ProviderAuthService'
import { runPiOneShot } from '../../src/mms/harness/drivers/pi/oneShot'
import { LOCAL_PLACEHOLDER_KEY } from '../../src/mms/providers/local/LocalConnections'
import { rankTitleModels } from '../../src/mms/orchestrator/TitleModelIndex'

// Local model servers against fake servers on 127.0.0.1 only. Every request each server receives is recorded, so a
// test can say exactly what was sent where (headers and body bytes), and that nothing was sent at all.

interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
}

type Route = (request: Seen, res: ServerResponse) => void

interface Fake {
  root: string
  seen: Seen[]
  /** Raw TCP connections: zero means nothing reached this server. */
  connections(): number
  route(path: string, handler: Route): void
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** An OpenAI chat-completions stream answering `text`. */
function chatStream(res: ServerResponse, text: string): void {
  const chunks = [
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`)
}

async function fake(routes: Record<string, Route> = {}): Promise<Fake> {
  const table = new Map(Object.entries(routes))
  const seen: Seen[] = []
  let connections = 0
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const request: Seen = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(request)
      const handler = table.get(url.pathname)
      if (handler) handler(request, res)
      else json(res, 404, { error: 'not found' })
    })
  })
  server.on('connection', (socket: Socket) => {
    connections += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    root: `http://127.0.0.1:${port}`,
    seen,
    connections: () => connections,
    route: (path, handler) => void table.set(path, handler),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    })
  }
}

/** An Ollama: `/api/version`, two models on disk (one served from its cloud), one in memory at 8K. */
function ollamaRoutes(): Record<string, Route> {
  return {
    '/api/version': (_r, res) => json(res, 200, { version: '0.13.0' }),
    '/api/tags': (_r, res) => json(res, 200, { models: [{ name: 'phi3:medium', model: 'phi3:medium' }, { name: 'gpt-oss:120b-cloud', model: 'gpt-oss:120b-cloud', remote_host: 'https://ollama.com:443', remote_model: 'gpt-oss:120b' }] }),
    '/api/ps': (_r, res) => json(res, 200, { models: [{ name: 'phi3:medium', model: 'phi3:medium', context_length: 8192 }] }),
    '/api/show': (r, res) => {
      const model = (JSON.parse(r.body) as { model: string }).model
      json(res, 200, model === 'phi3:medium' ? { capabilities: ['completion', 'tools'] } : { capabilities: ['completion', 'tools'], remote_host: 'https://ollama.com:443' })
    },
    '/v1/chat/completions': (_r, res) => chatStream(res, 'hello from ollama')
  }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function server(routes: Record<string, Route>): Promise<Fake> {
  const created = await fake(routes)
  cleanups.push(() => created.close())
  return created
}

/** A profile's provider credentials in a scratch home, with the background catalog refresh off (no network). */
async function auth(home = mkdtempSync(join(tmpdir(), 'mousse-local-'))): Promise<{ service: ProviderAuthService; home: string }> {
  const service = new ProviderAuthService(join(home, 'auth.json'))
  service.stop()
  await service.init()
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  return { service, home }
}

const signal = () => AbortSignal.timeout(10_000)
const oneShot = (model: string) => ({ model, system: 'Name the chat.', prompt: 'hello', onActivity: () => {} }) as never

function chats(server: Fake): Seen[] {
  return server.seen.filter((request) => request.path === '/v1/chat/completions')
}

describe('local model servers', () => {
  it('detects servers by their endpoints on the ports asked, and an always-keyed Unsloth Studio as needing its key', async () => {
    const ollama = await server(ollamaRoutes())
    const unsloth = await server({
      '/api/health': (_r, res) => json(res, 200, { status: 'healthy', service: 'Unsloth UI Backend' }),
      '/v1/models': (r, res) => (r.headers.authorization ? json(res, 200, { data: [] }) : json(res, 401, { detail: 'unauthorized' }))
    })
    const llama = await server({ '/v1/models': (_r, res) => json(res, 200, { object: 'list', data: [{ id: 'qwen3-8b', object: 'model', owned_by: 'llamacpp' }] }) })
    const { service } = await auth()
    const port = (fake: Fake) => Number(new URL(fake.root).port)
    const rows = await service.local.detect({ hosts: ['127.0.0.1'], ports: [port(ollama), port(unsloth), port(llama)], installed: () => ['lmstudio'] })
    expect(rows.map((row) => [row.kind, row.state, row.count])).toEqual([
      ['ollama', 'running', 2],
      ['unsloth', 'needs_key', undefined],
      ['llamacpp', 'running', 1],
      ['lmstudio', 'not_running', undefined]
    ])
  })

  it('restores saved connections at start without a request, and lists their models with what the server said', async () => {
    const ollama = await server(ollamaRoutes())
    const first = await auth()
    expect((await first.service.local.connect({ address: ollama.root })).ok).toBe(true)
    const before = ollama.connections()
    // A new start of the same installation: the record is read from disk, the server is not asked.
    const second = await auth(first.home)
    const listed = second.service.getConfiguredLlmProviders().find((provider) => provider.id === 'local-ollama')
    expect(ollama.connections()).toBe(before)
    expect(listed?.models.map((model) => [model.id, model.contextWindow, model.local?.tools, model.local?.cloud])).toEqual([
      ['phi3:medium', 8192, 'reported', undefined],
      ['gpt-oss:120b-cloud', undefined, 'reported', true]
    ])
    // Not offered as an API key in Add provider.
    expect(second.service.getLoginOptions().some((option) => option.id === 'local-ollama')).toBe(false)
  })

  it('keeps two servers with the same model ids apart: each request goes to its own server', async () => {
    const a = await server(ollamaRoutes())
    const b = await server(ollamaRoutes())
    const { service } = await auth()
    const first = await service.local.connect({ address: a.root })
    const second = await service.local.connect({ address: b.root })
    expect([first.ok && first.providerId, second.ok && second.providerId]).toEqual(['local-ollama', 'local-ollama-2'])
    await runPiOneShot(service.models, 'local-ollama-2', oneShot('phi3:medium'), signal())
    expect([chats(a).length, chats(b).length]).toEqual([0, 1])
    await runPiOneShot(service.models, 'local-ollama', oneShot('phi3:medium'), signal())
    expect([chats(a).length, chats(b).length]).toEqual([1, 1])
  })

  it("gives two connects at once their own ids, and never gives a removed connection's id to another server", async () => {
    const a = await server(ollamaRoutes())
    const b = await server(ollamaRoutes())
    const c = await server(ollamaRoutes())
    const { service, home } = await auth()
    const [first, second] = await Promise.all([service.local.connect({ address: a.root }), service.local.connect({ address: b.root })])
    const ids = [first.ok && first.providerId, second.ok && second.providerId]
    expect(new Set(ids).size).toBe(2)
    await service.local.remove('local-ollama')
    const third = await service.local.connect({ address: c.root })
    expect(third.ok && third.providerId).not.toBe('local-ollama')
    // Still true after a restart: the removed id is recorded.
    const again = await auth(home)
    const fourth = await again.service.local.connect({ address: a.root })
    expect([third.ok && third.providerId, second.ok && second.providerId, first.ok && first.providerId]).not.toContain(fourth.ok && fourth.providerId)
    expect(fourth.ok && fourth.providerId).not.toBe('local-ollama')
  })

  it('keeps the saved facts when a refresh is stopped part-way', async () => {
    const ollama = await server(ollamaRoutes())
    const { service } = await auth()
    await service.local.connect({ address: ollama.root })
    ollama.route('/api/show', () => undefined)
    expect(await service.local.refresh('local-ollama', { signal: AbortSignal.timeout(200) })).toBe(false)
    expect(service.local.facts('local-ollama', 'phi3:medium')?.tools).toBe('reported')
  })

  it('sends a model id with a colon as it is, never as a model at an effort', async () => {
    const ollama = await server(ollamaRoutes())
    const { service } = await auth()
    await service.local.connect({ address: ollama.root })
    const { text } = await runPiOneShot(service.models, 'local-ollama', oneShot('phi3:medium'), signal())
    expect(text).toBe('hello from ollama')
    expect(JSON.parse(chats(ollama)[0]!.body).model).toBe('phi3:medium')
  })

  it('sends no Authorization to a keyless server, and exactly its own key to a keyed one; the key is in the credential store only', async () => {
    const keyless = await server(ollamaRoutes())
    const keyed = await server({
      '/v1/models': (r, res) => (r.headers.authorization === 'Bearer sk-local-123' ? json(res, 200, { object: 'list', data: [{ id: 'served', object: 'model', owned_by: 'vllm', max_model_len: 32768 }] }) : json(res, 401, {})),
      '/v1/chat/completions': (_r, res) => chatStream(res, 'ok')
    })
    const { service, home } = await auth()
    await service.local.connect({ address: keyless.root })
    expect(await service.local.connect({ address: keyed.root })).toMatchObject({ ok: false, problem: 'needs_key' })
    expect(await service.local.connect({ address: keyed.root, apiKey: 'sk-local-123' })).toMatchObject({ ok: true, providerId: 'local-vllm' })
    await runPiOneShot(service.models, 'local-ollama', oneShot('phi3:medium'), signal())
    await runPiOneShot(service.models, 'local-vllm', oneShot('served'), signal())
    expect(chats(keyless)[0]!.headers.authorization).toBeUndefined()
    expect(chats(keyed)[0]!.headers.authorization).toBe('Bearer sk-local-123')
    // Neither the placeholder nor the real key is written beside the connections.
    const records = readFileSync(join(home, 'local-connections.json'), 'utf8')
    expect(records).not.toContain('sk-local-123')
    expect(records).not.toContain(LOCAL_PLACEHOLDER_KEY)
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).not.toContain(LOCAL_PLACEHOLDER_KEY)
  })

  it('never follows a redirect: the request it points to is never made', async () => {
    const elsewhere = await server({ '/v1/chat/completions': (_r, res) => chatStream(res, 'stolen') })
    const ollama = await server(ollamaRoutes())
    const { service } = await auth()
    await service.local.connect({ address: ollama.root })
    ollama.route('/v1/chat/completions', (_r, res) => {
      res.writeHead(307, { location: `${elsewhere.root}/v1/chat/completions` })
      res.end()
    })
    await expect(runPiOneShot(service.models, 'local-ollama', oneShot('phi3:medium'), signal())).rejects.toThrow()
    expect(elsewhere.connections()).toBe(0)
  })

  it('answers 404 and an unreachable address with the problem the dialog shows, and asks before plain http to another machine', async () => {
    const notModels = await server({})
    const { service } = await auth()
    expect(await service.local.connect({ address: notModels.root })).toMatchObject({ ok: false, problem: 'not_a_model_server' })
    const gone = await fake({})
    await gone.close()
    expect(await service.local.connect({ address: gone.root })).toMatchObject({ ok: false, problem: 'unreachable' })
    // 192.0.2.0/24 is reserved for documentation: nothing is asked before consent.
    expect(await service.local.connect({ address: '192.0.2.10:11434' })).toMatchObject({ ok: false, problem: 'cleartext_consent' })
    expect(await service.local.connect({ address: 'http://user:pw@127.0.0.1:1' })).toMatchObject({ ok: false, problem: 'invalid_address' })
  })

  it('stops a request when its signal aborts', async () => {
    const ollama = await server(ollamaRoutes())
    const { service } = await auth()
    await service.local.connect({ address: ollama.root })
    let closed = false
    const controller = new AbortController()
    // The server starts answering and never finishes; Stop comes once the request is on the wire.
    ollama.route('/v1/chat/completions', (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'par' } }] })}\n\n`)
      res.on('close', () => void (closed = true))
      setTimeout(() => controller.abort(), 50)
    })
    const call = runPiOneShot(service.models, 'local-ollama', oneShot('phi3:medium'), controller.signal)
    await expect(call).rejects.toThrow()
    await expect.poll(() => closed).toBe(true)
  })

  it("turns Unsloth Studio's own server-side tools off in every chat request", async () => {
    const unsloth = await server({
      '/api/health': (_r, res) => json(res, 200, { status: 'healthy', service: 'Unsloth UI Backend' }),
      '/v1/models': (r, res) => (r.headers.authorization ? json(res, 200, { object: 'list', data: [{ id: 'gemma-4', object: 'model', loaded: true, context_length: 16384 }] }) : json(res, 401, {})),
      '/v1/chat/completions': (_r, res) => chatStream(res, 'ok')
    })
    const { service } = await auth()
    expect(await service.local.connect({ address: unsloth.root, apiKey: 'sk-unsloth-abc' })).toMatchObject({ ok: true, kind: 'unsloth' })
    await runPiOneShot(service.models, 'local-unsloth', oneShot('gemma-4'), signal())
    expect(JSON.parse(chats(unsloth)[0]!.body).enable_tools).toBe(false)
  })

  it('checks tools only on a model already in memory, and records a passed round trip', async () => {
    const ollama = await server(ollamaRoutes())
    const { service } = await auth()
    await service.local.connect({ address: ollama.root })
    // gpt-oss:120b-cloud is not in /api/ps: the check never loads it.
    expect(await service.local.checkTools('local-ollama', 'gpt-oss:120b-cloud')).toMatchObject({ ok: false, problem: 'cold' })
    expect(chats(ollama)).toHaveLength(0)
    // A server that cannot say what is in memory may load the model to answer: no check either.
    ollama.route('/api/ps', (_r, res) => json(res, 500, {}))
    expect(await service.local.checkTools('local-ollama', 'phi3:medium')).toMatchObject({ ok: false, problem: 'cold' })
    expect(chats(ollama)).toHaveLength(0)
    ollama.route('/api/ps', ollamaRoutes()['/api/ps']!)
    let step = 0
    ollama.route('/v1/chat/completions', (r, res) => {
      step += 1
      const body = JSON.parse(r.body) as { tools?: Array<{ function: { name: string } }> }
      const word = /ok\d{4}/.exec(r.body)![0]
      if (step === 1) {
        const name = body.tools![0]!.function.name
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify({ word }) } }] } }] })}\n\ndata: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      chatStream(res, word)
    })
    expect(await service.local.checkTools('local-ollama', 'phi3:medium')).toEqual({ ok: true, tools: 'passed' })
    expect(service.local.facts('local-ollama', 'phi3:medium')?.tools).toBe('passed')
  })

  it('leaves local models out of Automatic naming for every thread', () => {
    const snapshot = { instanceId: 'pi:local-ollama', driver: 'pi', enabled: { effective: true }, checkedAt: 1, auth: { state: 'signed_in' }, runs: { state: 'yes' } } as never
    const ranked = rankTitleModels({
      snapshots: [snapshot],
      models: () => [{ id: 'phi3:medium', label: 'phi3:medium', source: 'catalog', capabilities: { efforts: [], images: false }, hidden: false, favorite: false, local: { tools: 'reported', images: false, loaded: true } }],
      canOneShot: () => true
    })
    expect(ranked).toEqual([])
  })

  it('reads a model list saved by an older build without failing (no models key)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-local-'))
    writeFileSync(join(home, 'local-connections.json'), JSON.stringify({ version: 1, connections: [{ id: 'local-ollama', kind: 'ollama', label: 'Ollama', root: 'http://127.0.0.1:1', keyed: false }] }))
    const { service } = await auth(home)
    expect(service.has('local-ollama')).toBe(true)
    expect(service.local.views('local-ollama')).toEqual([])
  })
})
