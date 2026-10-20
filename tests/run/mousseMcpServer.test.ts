import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { runStdioBridge } from '../../src/mms/run/mcp/stdioBridge'
import { createMousseToolRegistry, ToolRegistry, type MousseToolHost } from '../../src/mms/run/mcp/toolRegistry'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { PassThrough } from 'node:stream'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

const host = (): MousseToolHost => {
  const tasks = new TaskQueue()
  return {
    delegation: () => { throw new Error('no delegation in this test') },
    askUser: async () => ({}),
    presentPlan: () => undefined,
    tasks: () => tasks,
    listQueue: () => [],
    enqueue: () => ({})
  }
}

async function rpc(url: string, token: string | null, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` })
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

describe('MousseMcpServer (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  const setup = async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const credentials = new McpCredentials(fx.store)
    server = new MousseMcpServer({ credentials, registry: createMousseToolRegistry({ engine: fx.engine, host: host() }) })
    await server.start()
    const attachment = server.attach({ threadId: 'thread-a', runId: run.runId, provider: 'claude-subscription', modeCeiling: 'default' })!
    return { fx, run, credentials, server, attachment }
  }

  it('binds 127.0.0.1 on a random port and answers initialize, tools/list and tools/call', async () => {
    const { server, attachment, fx } = await setup()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(attachment.url).toBe(server.url)

    const init = await rpc(server.url, attachment.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo.name).toBe('mousse')
    expect(init.body.result.capabilities.tools).toBeTruthy()
    expect(init.body.result.instructions).toMatch(/delegate_task/)

    const initialized = await rpc(server.url, attachment.token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(initialized.status).toBe(202)
    const ping = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(ping.body.result).toEqual({})

    const list = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    const names = list.body.result.tools.map((tool: { name: string }) => tool.name).sort()
    expect(names).toEqual(['ask_user', 'create_task', 'delegate_task', 'integrate_delegation', 'list_delegations', 'list_tasks',
      'present_plan', 'queue_enqueue', 'queue_list', 'task_cancel', 'task_status', 'thread_fork',
      'thread_merge_back', 'thread_read', 'update_task'])

    const read = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'thread_read', arguments: {} } })
    expect(read.body.result.isError).toBeUndefined()
    const payload = JSON.parse(read.body.result.content[0].text)
    expect(payload.threadId).toBe('thread-a')
    expect(payload.events.map((event: { seq: number }) => event.seq)).toEqual(fx.engine.listEvents('thread-a').map((event) => event.seq))

    const scope = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'queue_enqueue', arguments: { content: 'x', threadId: 'thread-b' } } })
    expect(scope.body.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_scope_denied, data: { reason: 'mousse_scope_denied' } })
    expect(scope.body.error.message).toMatch(/^mousse_scope_denied/)

    const get = await fetch(server.url, { headers: { Authorization: `Bearer ${attachment.token}`, Accept: 'text/event-stream' } })
    expect(get.status).toBe(405)
  })

  it('rejects a missing, invalid or revoked token with 401, and every call after revokeThread', async () => {
    const { server, attachment, credentials, run } = await setup()
    // The same thread and provider reuse the token across turns.
    expect(server.attach({ threadId: 'thread-a', runId: run.runId, provider: 'claude-subscription', modeCeiling: 'default' })!.token).toBe(attachment.token)
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    const missing = await rpc(server.url, null, call)
    expect(missing.status).toBe(401)
    expect(missing.body.error.code).toBe(MCP_ERROR_CODES.mousse_unauthorized)
    expect((await rpc(server.url, 'invalid', call)).status).toBe(401)
    expect((await rpc(server.url, attachment.token, call)).status).toBe(200)

    credentials.revokeForRun(run.runId)
    expect((await rpc(server.url, attachment.token, call)).status).toBe(401)

    const second = server.attach({ threadId: 'thread-a', runId: run.runId, provider: 'p', modeCeiling: 'default' })!
    expect(second.token).not.toBe(attachment.token)
    expect((await rpc(server.url, second.token, call)).status).toBe(200)
    server.turnEnded('thread-a')
    expect((await rpc(server.url, second.token, call)).status).toBe(200)
    server.revokeThread('thread-a')
    expect((await rpc(server.url, second.token, call)).status).toBe(401)
  })

  it('relays stdio JSON-RPC lines through the stdio bridge', async () => {
    const { server, attachment } = await setup()
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.on('data', (chunk) => lines.push(...String(chunk).split('\n').filter(Boolean)))
    const done = runStdioBridge({ url: server.url, token: attachment.token, input, output })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    input.end()
    await done
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }])

    const denied = new PassThrough()
    const deniedOut: string[] = []
    const out = new PassThrough()
    out.on('data', (chunk) => deniedOut.push(...String(chunk).split('\n').filter(Boolean)))
    const relay = runStdioBridge({ url: server.url, token: 'wrong', input: denied, output: out })
    denied.end(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' })}\n`)
    await relay
    expect(JSON.parse(deniedOut[0])).toMatchObject({ id: 8, error: { code: MCP_ERROR_CODES.mousse_unauthorized } })
  })

  it('attaches nothing while stopped', async () => {
    const { server, run } = await setup()
    await server.stop()
    expect(server.attach({ threadId: 'thread-a', runId: run.runId, provider: 'p', modeCeiling: 'default' })).toBeNull()
  })

  it('maps transport failures to HTTP statuses and a refused tool to its JSON-RPC code', async () => {
    const { server, attachment } = await setup()
    const post = (body: string, path = '/mcp') => fetch(`${server.url.replace(/\/mcp$/, '')}${path}`, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${attachment.token}` }
    })
    expect((await post('{}', '/elsewhere')).status).toBe(404)
    const malformed = await post('{not json')
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error.code).toBe(-32700)
    const oversized = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', padding: 'x'.repeat(4 * 1024 * 1024 + 1) }))
    expect(oversized.status).toBe(400)
    expect((await oversized.json()).error.message).toMatch(/request body too large/)

    const unknown = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
    // The codes are the wire contract provider runtimes see, so they are pinned literally (-32601 is JSON-RPC's method-not-found).
    expect(unknown.body.error).toMatchObject({ code: -32601, data: { reason: 'mousse_unknown_tool' } })
    // A tool that fails on its own input is a tool result the model can read, not a protocol error.
    const invalid = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_task', arguments: { id: '' } } })
    expect(invalid.body.error).toBeUndefined()
    expect(invalid.body.result.isError).toBe(true)

    server.revokeThread('thread-a')
    const plan = server.attach({ threadId: 'thread-a', runId: fx!.store.getActiveRun('thread-a')!.runId, provider: 'p', modeCeiling: 'plan' })!
    const ceiling = await rpc(server.url, plan.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'thread_fork', arguments: {} } })
    expect(ceiling.body.error).toMatchObject({ code: -32004, data: { reason: 'mousse_ceiling_exceeded' } })
  })

  describe('in-flight tool calls', () => {
    /** Threads a and b each hold a live run and a `hang` tool that waits for its abort signal. */
    const hanging = async () => {
      fx = delegationFixture()
      await fx.runningRun('thread-a'); await fx.runningRun('thread-b')
      const started: string[] = [], reasons = new Map<string, string>()
      const registry = new ToolRegistry({ activeRunId: (threadId) => fx!.store.getActiveRun(threadId)?.runId ?? null })
      registry.register({
        name: 'hang', description: 'waits for its abort signal', inputSchema: { type: 'object' }, access: 'actsAsCaller',
        handler: (_args, ctx) => new Promise((resolve) => {
          started.push(ctx.caller.threadId)
          ctx.signal.addEventListener('abort', () => { reasons.set(ctx.caller.threadId, String((ctx.signal.reason as Error)?.message)); resolve({ text: 'aborted' }) }, { once: true })
        })
      })
      server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
      await server.start()
      const attach = (threadId: string) => server!.attach({ threadId, runId: fx!.store.getActiveRun(threadId)!.runId, provider: 'p', modeCeiling: 'default' })!
      const callHang = (token: string, signal?: AbortSignal) => fetch(server!.url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hang', arguments: {} } })
      })
      return { a: attach('thread-a'), b: attach('thread-b'), started, reasons, callHang }
    }

    it.each([
      ['turnEnded', (s: MousseMcpServer) => s.turnEnded('thread-a'), 'The turn of thread thread-a ended'],
      ['revokeThread', (s: MousseMcpServer) => s.revokeThread('thread-a'), 'Thread thread-a credentials were revoked']
    ])('%s aborts that thread\'s in-flight call and no other thread\'s', async (_name, end, reason) => {
      const { a, b, started, reasons, callHang } = await hanging()
      const first = callHang(a.token), other = callHang(b.token)
      await vi.waitFor(() => expect(started.sort()).toEqual(['thread-a', 'thread-b']))
      end(server!)
      await first.then((response) => response.text())
      expect(reasons.get('thread-a')).toBe(reason)
      expect(reasons.has('thread-b')).toBe(false)
      server!.turnEnded('thread-b')
      await other.then((response) => response.text())
      expect(reasons.get('thread-b')).toBe('The turn of thread thread-b ended')
    })

    it('turnEnded keeps the credential for the next turn', async () => {
      const { a, started, callHang } = await hanging()
      const pending = callHang(a.token)
      await vi.waitFor(() => expect(started).toEqual(['thread-a']))
      server!.turnEnded('thread-a')
      await pending.then((response) => response.text())
      const list = await rpc(server!.url, a.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      expect(list.status).toBe(200)
    })

    it('stop aborts every in-flight call, and a closed client connection aborts its own call', async () => {
      const { a, b, started, reasons, callHang } = await hanging()
      const closing = new AbortController()
      const dropped = callHang(a.token, closing.signal).catch(() => undefined)
      await vi.waitFor(() => expect(started).toEqual(['thread-a']))
      closing.abort()
      await dropped
      await vi.waitFor(() => expect(reasons.has('thread-a')).toBe(true))
      const surviving = callHang(b.token).catch(() => undefined)
      await vi.waitFor(() => expect(started).toEqual(['thread-a', 'thread-b']))
      await server!.stop()
      await surviving
      expect(reasons.get('thread-b')).toBe('The Mousse MCP server stopped')
    })
  })
})
