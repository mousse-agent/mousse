import { afterEach, describe, expect, it } from 'vitest'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { runStdioBridge } from '../../src/mms/run/mcp/stdioBridge'
import { createMousseToolRegistry, type MousseToolHost } from '../../src/mms/run/mcp/toolRegistry'
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

  it('reports a call while the thread has no active run as mousse_caller_not_live', async () => {
    const { server, attachment, fx, run } = await setup()
    fx.engine.markTerminal(run.runId, 'completed')
    const result = await rpc(server.url, attachment.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } })
    expect(result.body.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_caller_not_live })
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
})
