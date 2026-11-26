/**
 * A hand-authored stand-in for OpenCode 2.0's server API (`opencode serve`), in this process on loopback: the routes
 * Mousse's OpenCode runtime calls, with their 2.0.20 shapes (`packages/protocol/src/groups/*`), and an event stream the
 * test drives. It proves Mousse's side only; what the real server does is checked in `tests/live/opencodeServer.test.ts`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OpencodeLaunch, StartedServer } from '../../src/mms/harness/opencode/server'

export interface FakeCall {
  method: string
  path: string
  body?: Record<string, unknown>
}

export interface FakeSession {
  id: string
  body: Record<string, unknown>
  permissions: unknown
  deleted?: boolean
}

export interface FakeOpencode {
  /** The test seam `opencodeDriver({ startServer })` takes. */
  start: (launch: OpencodeLaunch, signal: AbortSignal) => Promise<StartedServer>
  launches: OpencodeLaunch[]
  calls: FakeCall[]
  sessions: Map<string, FakeSession>
  /** Sends one event on every open stream. */
  emit(type: string, data: Record<string, unknown>): void
  /** What happens when a prompt arrives (default: the reply `ok`, then success). */
  onPrompt: (session: FakeSession, body: Record<string, unknown>) => void
  /** What happens when a permission request is answered. */
  onReply: (session: FakeSession, requestId: string, body: Record<string, unknown>) => void
  models: Array<Record<string, unknown>>
  saved: Array<Record<string, unknown>>
  plugins: Array<Record<string, unknown>>
  /** How many plugin listings come back empty first, as from a server still loading them. */
  pluginsLoadingFor: number
  integrations: Array<Record<string, unknown>>
  /** A reply of the run of `sessionId`: its text and success. */
  reply(sessionId: string, text: string): void
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) as Record<string, unknown> : undefined) } catch { resolve(undefined) }
    })
  })
}

export async function fakeOpencodeServer(): Promise<FakeOpencode> {
  const streams = new Set<ServerResponse>()
  const sessions = new Map<string, FakeSession>()
  const calls: FakeCall[] = []
  let next = 0
  const located = (data: unknown) => ({ location: { directory: '/fake' }, data })
  const fake: FakeOpencode = {
    start: async () => { throw new Error('not listening') },
    launches: [],
    calls,
    sessions,
    emit: (type, data) => {
      const frame = `data: ${JSON.stringify({ id: `evt_${++next}`, created: Date.now(), type, data })}\n\n`
      for (const stream of streams) stream.write(frame)
    },
    onPrompt: (session) => fake.reply(session.id, 'ok'),
    onReply: () => {},
    models: [
      { providerID: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', enabled: true, variants: [{ id: 'default' }, { id: 'high' }], limit: { context: 200_000, output: 8_000 }, cost: [{ input: 1, output: 5 }] },
      { providerID: 'opencode', id: 'big-pickle', name: 'Big Pickle', enabled: true, variants: [], limit: { context: 100_000, output: 8_000 }, cost: [{ input: 0, output: 0 }] }
    ],
    saved: [],
    plugins: [{ id: 'opencode.config.mcp', source: { type: 'builtin' } }],
    pluginsLoadingFor: 0,
    integrations: [{ id: 'anthropic', name: 'Anthropic', connections: [{ id: 'c1' }] }],
    reply: (sessionId, text) => {
      fake.emit('session.execution.started', { sessionID: sessionId })
      fake.emit('session.text.delta', { sessionID: sessionId, assistantMessageID: 'msg_1', ordinal: 0, delta: text })
      fake.emit('session.text.ended', { sessionID: sessionId, assistantMessageID: 'msg_1', ordinal: 0, text })
      fake.emit('session.step.ended', { sessionID: sessionId, assistantMessageID: 'msg_1', finish: 'stop', cost: 0, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })
      fake.emit('session.execution.succeeded', { sessionID: sessionId })
    },
    close: async () => {}
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const body = req.method === 'GET' ? undefined : await readBody(req)
    calls.push({ method: req.method ?? 'GET', path, ...(body ? { body } : {}) })
    const json = (status: number, value?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(value === undefined ? '' : JSON.stringify(value))
    }
    if (path === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`)
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    if (req.method === 'GET' && path === '/api/model') return json(200, located(fake.models))
    if (req.method === 'GET' && path === '/api/model/default') return json(200, located({ providerID: 'opencode', id: 'big-pickle' }))
    if (req.method === 'GET' && path === '/api/permission/saved') {
      const projectID = url.searchParams.get('projectID')
      return json(200, { data: fake.saved.filter((grant) => !projectID || grant.projectID === projectID) })
    }
    if (req.method === 'GET' && path === '/api/plugin') {
      if (fake.pluginsLoadingFor > 0) {
        fake.pluginsLoadingFor -= 1
        return json(200, located([]))
      }
      return json(200, located(fake.plugins))
    }
    if (req.method === 'GET' && path === '/api/integration') return json(200, located(fake.integrations))
    if (req.method === 'PUT' && path.startsWith('/api/experimental/mcp/')) return json(204)
    if (req.method === 'DELETE' && path.startsWith('/api/experimental/mcp/')) return json(204)
    if (req.method === 'POST' && path === '/api/session') {
      const id = `ses_${++next}`
      const session: FakeSession = { id, body: body ?? {}, permissions: body?.permissions }
      sessions.set(id, session)
      return json(200, { data: { id, projectID: 'prj_fake' } })
    }
    const match = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(path)
    const session = match ? sessions.get(decodeURIComponent(match[1]!)) : undefined
    if (match && (!session || session.deleted)) return json(404, { _tag: 'SessionNotFoundError', message: 'Session not found' })
    if (session) {
      const rest = match![2] ?? ''
      if (req.method === 'GET' && !rest) return json(200, { data: { id: session.id, projectID: 'prj_fake' } })
      if (req.method === 'PATCH' && !rest) {
        if (body?.permissions) session.permissions = body.permissions
        return json(204)
      }
      if (req.method === 'DELETE' && !rest) {
        session.deleted = true
        return json(204)
      }
      if (req.method === 'POST' && rest === 'model') return json(204)
      if (req.method === 'POST' && rest === 'prompt') {
        json(200, { data: { id: 'inbox_1' } })
        setImmediate(() => fake.onPrompt(session, body ?? {}))
        return
      }
      if (req.method === 'POST' && rest === 'interrupt') {
        json(200, { interrupted: true })
        setImmediate(() => fake.emit('session.execution.interrupted', { sessionID: session.id, reason: 'user' }))
        return
      }
      const reply = /^permission\/([^/]+)\/reply$/.exec(rest)
      if (req.method === 'POST' && reply) {
        json(204)
        setImmediate(() => fake.onReply(session, decodeURIComponent(reply[1]!), body ?? {}))
        return
      }
      if (req.method === 'DELETE' && rest.startsWith('form/')) return json(204)
    }
    json(404, { _tag: 'NotFound', message: `no route ${req.method} ${path}` })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  let resolveExit: () => void = () => {}
  fake.start = async (launch) => {
    fake.launches.push(launch)
    const exited = new Promise<void>((resolve) => { resolveExit = resolve })
    return {
      endpoint: { url: `http://127.0.0.1:${port}`, password: 'test' },
      close: () => {
        for (const stream of streams) stream.end()
        streams.clear()
        resolveExit()
      },
      exited
    }
  }
  fake.close = async () => {
    for (const stream of streams) stream.end()
    streams.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return fake
}
