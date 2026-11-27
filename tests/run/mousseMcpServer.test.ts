import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { AppToolTurns, McpToolError, ToolRegistry, TURN_TOKEN_KEY, type McpTurnBinding } from '../../src/mms/run/mcp/appTools'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import type { Socket } from 'node:net'
import { BOUNDARY_NOTICE_HEADER, MCP_ERROR_CODES, MousseMcpServer, type McpToolBoundary } from '../../src/mms/run/mcp/MousseMcpServer'
import { runStdioBridge } from '../../src/mms/run/mcp/stdioBridge'
import { PassThrough } from 'node:stream'
import { appToolRegistry, appTurn, fakeAppToolHost, refusalOfResponse } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'
import type { CallAttribution } from '../../src/mms/run/nativeHelpers'

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

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

describe('MousseMcpServer (SPEC §15.1)', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  const setup = async (hostOverrides: Parameters<typeof fakeAppToolHost>[0] = {}, options: { boundary?: McpToolBoundary; attribute?: (threadId: string, meta: unknown) => Promise<CallAttribution> } = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const credentials = new McpCredentials(fx.store)
    const fake = fakeAppToolHost(hostOverrides)
    const { registry, turns } = appToolRegistry(fx.engine, fake.host)
    server = new MousseMcpServer({ credentials, registry, ...(options.boundary ? { boundary: options.boundary } : {}), ...(options.attribute ? { attribute: options.attribute } : {}) })
    await server.start()
    const registered = turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
    const bearer = (input: { runId?: string; instanceId?: string; binding?: McpTurnBinding; generation?: string } = {}) =>
      server!.bearerForTurn({
        threadId: 'thread-a', instanceId: input.instanceId ?? 'codex', runId: input.runId ?? run.runId,
        binding: input.binding ?? 'drained_turn', generation: input.generation ?? 'codex|default|0|0'
      })!
    const attachment = bearer()
    return { fx, run, credentials, server, attachment, bearer, turns, registered, ...fake }
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
    // The fake host offers no browser, skills, quick actions, web or dev GUI: only the tools it can serve are listed.
    expect(names).toEqual(['computer_list', 'delegate_task', 'model_list', 'publish_applet', 'question_ask', 'question_withdraw', 'queue_enqueue',
      'queue_list', 'queue_update', 'read_applet', 'request_answer', 'task_create', 'task_list', 'task_update', 'thread_archive', 'thread_create', 'thread_fork',
      'thread_list', 'thread_read', 'thread_return', 'thread_search', 'thread_send', 'thread_stop', 'thread_update', 'thread_wait'])

    const read = await rpc(server.url, attachment.token, call(4, 'thread_read'))
    expect(read.body.result.isError).toBeUndefined()
    const payload = JSON.parse(read.body.result.content[0].text)
    expect(payload.threadId).toBe('thread-a')
    expect(payload.events.map((event: { seq: number }) => event.seq)).toEqual(fx.engine.listEvents('thread-a').map((event) => event.seq))

    const scope = await rpc(server.url, attachment.token, call(5, 'queue_enqueue', { content: 'x', threadId: 'thread-b', expectedRevision: 'rev-0' }))
    expect(scope.body.error).toBeUndefined()
    expect(refusalOfResponse(scope.body)).toMatchObject({ code: 'mousse_scope_denied', refused: { code: 'scope_denied', retry: 'never' } })
    expect(refusalOfResponse(scope.body)!.message).not.toMatch(/^mousse_/)

    const get = await fetch(server.url, { headers: { Authorization: `Bearer ${attachment.token}`, Accept: 'text/event-stream' } })
    expect(get.status).toBe(405)
  })

  describe('notices handed over with a tool result (McpToolBoundary)', () => {
    const stubBoundary = (onDeliver: () => void = () => undefined) => {
      const release = vi.fn()
      const boundary: McpToolBoundary = { deliver: vi.fn(() => (onDeliver(), { text: 'a subagent finished', release })) }
      return { boundary, release }
    }

    it('come as their own block after the tool\'s result, and stay delivered once the response is written', async () => {
      const { boundary, release } = stubBoundary()
      const { server, attachment } = await setup({}, { boundary })
      const read = await rpc(server.url, attachment.token, call(1, 'thread_read'))
      expect(JSON.parse(read.body.result.content[0].text).threadId).toBe('thread-a')
      expect(read.body.result.content[1]).toEqual({ type: 'text', text: `${BOUNDARY_NOTICE_HEADER}\n\na subagent finished` })
      expect(boundary.deliver).toHaveBeenCalledWith({ threadId: 'thread-a', runId: expect.any(String) })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(release).not.toHaveBeenCalled()
    })

    it('are released when the connection closes after they were handed over and before the response is written', async () => {
      // The connection drops at the one point that matters: inside `deliver`, before the server writes anything.
      let sockets: Set<Socket> = new Set()
      const { boundary, release } = stubBoundary(() => {
        for (const socket of sockets) socket.destroy()
      })
      const { server, attachment } = await setup({}, { boundary })
      sockets = (server as unknown as { sockets: Set<Socket> }).sockets
      await expect(rpc(server.url, attachment.token, call(1, 'thread_read'))).rejects.toThrow()
      expect(boundary.deliver).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    })
  })

  describe("a native helper's call under its hosting run's credential", () => {
    const withMeta = (id: number, name: string, meta: Record<string, unknown>, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } })
    const attribution = (byToolUse: Record<string, CallAttribution>) => vi.fn(async (_threadId: string, meta: unknown) => byToolUse[String((meta as Record<string, unknown> | undefined)?.['claudecode/toolUseId'])] ?? { kind: 'host' as const })

    it('holds delegable authority only and takes none of the run\'s notices; the run\'s own call keeps both', async () => {
      const boundary: McpToolBoundary = { deliver: vi.fn(() => ({ text: 'a subagent finished', release: () => undefined })) }
      const attribute = attribution({ toolu_h: { kind: 'helper', agentId: 'toolu_A' }, toolu_u: { kind: 'unattributed' } })
      const { server, attachment } = await setup({}, { boundary, attribute })
      for (const [id, toolUseId] of [[1, 'toolu_h'], [2, 'toolu_u']] as const) {
        // Reading the hosting thread is delegable: it works, with no notice handed over.
        const read = await rpc(server.url, attachment.token, withMeta(id, 'thread_read', { 'claudecode/toolUseId': toolUseId }))
        expect(JSON.parse(read.body.result.content[0].text).threadId).toBe('thread-a')
        expect(read.body.result.content).toHaveLength(1)
        // Asking the person is the run's own: refused to a helper as to a subagent.
        const ask = await rpc(server.url, attachment.token, withMeta(id + 10, 'question_ask', { 'claudecode/toolUseId': toolUseId }, { questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], wait: false }))
        expect(refusalOfResponse(ask.body)).toMatchObject({ refused: { code: 'unavailable', message: expect.stringContaining('a helper cannot use it') } })
      }
      expect(boundary.deliver).not.toHaveBeenCalled()
      expect(attribute).toHaveBeenCalledWith('thread-a', { 'claudecode/toolUseId': 'toolu_h' })
      const own = await rpc(server.url, attachment.token, withMeta(3, 'thread_read', { 'claudecode/toolUseId': 'toolu_own' }))
      expect(own.body.result.content[1]).toEqual({ type: 'text', text: `${BOUNDARY_NOTICE_HEADER}\n\na subagent finished` })
    })

    it('never holds person, in a run a person started; the run\'s own call does', async () => {
      const archiveOwnThreadAfterTurn = vi.fn(() => ({ status: 'scheduled' as const }))
      const attribute = attribution({ toolu_h: { kind: 'helper', agentId: 'toolu_A' } })
      const { server, attachment } = await setup({ personHeld: () => true, archiveOwnThreadAfterTurn }, { attribute })
      const helper = await rpc(server.url, attachment.token, withMeta(1, 'thread_archive', { 'claudecode/toolUseId': 'toolu_h' }, { threadId: 'thread-a' }))
      expect(refusalOfResponse(helper.body)).toMatchObject({ refused: { code: 'lacks_capability', lacks: 'person' } })
      expect(archiveOwnThreadAfterTurn).not.toHaveBeenCalled()
      const own = await rpc(server.url, attachment.token, withMeta(2, 'thread_archive', { 'claudecode/toolUseId': 'toolu_own' }, { threadId: 'thread-a' }))
      expect(JSON.parse(own.body.result.content[0].text)).toMatchObject({ threadId: 'thread-a', archived: 'after_this_turn' })
      expect(archiveOwnThreadAfterTurn).toHaveBeenCalledTimes(1)
    })

    it('an attribution that fails holds delegable authority only', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { server, attachment } = await setup({}, { attribute: async () => { throw new Error('lost') } })
      const ask = await rpc(server.url, attachment.token, call(1, 'question_ask', { questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }], wait: false }))
      expect(refusalOfResponse(ask.body)).toMatchObject({ refused: { code: 'unavailable', message: expect.stringContaining('a helper cannot use it') } })
      warn.mockRestore()
    })
  })

  it('rejects a missing, invalid or revoked token with 401, and every call after revokeThread', async () => {
    const { server, attachment, credentials, run, bearer } = await setup()
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    const missing = await rpc(server.url, null, list)
    expect(missing.status).toBe(401)
    expect(missing.body.error.code).toBe(MCP_ERROR_CODES.mousse_unauthorized)
    expect((await rpc(server.url, 'invalid', list)).status).toBe(401)
    expect((await rpc(server.url, attachment.token, list)).status).toBe(200)

    credentials.revokeForRun(run.runId)
    expect((await rpc(server.url, attachment.token, list)).status).toBe(401)

    const second = bearer({ instanceId: 'p' })
    expect(second.token).not.toBe(attachment.token)
    expect((await rpc(server.url, second.token, list)).status).toBe(200)
    server.revokeThread('thread-a')
    expect((await rpc(server.url, second.token, list)).status).toBe(401)
  })

  it('an old-epoch bearer reaches no handler during a newer run, nor after an engine or account switch', async () => {
    const { server, fx, run, bearer, turns, enqueued } = await setup()
    const old = bearer()
    // Turn N ended undrained (Stop): its bearer is rotated.
    server.turnEnded({ threadId: 'thread-a', runId: run.runId, tokenHash: old.tokenHash, settlement: { status: 'aborted' } })
    fx.engine.markTerminal(run.runId, 'interrupted')
    const next = await fx.runningRun('thread-a')
    turns.register(appTurn({ threadId: 'thread-a', runId: next.runId }))
    const fresh = bearer({ runId: next.runId })
    expect(fresh.token).not.toBe(old.token)
    expect((await rpc(server.url, old.token, call(1, 'queue_enqueue', { content: 'late' }))).status).toBe(401)
    expect(enqueued).toEqual([])
    expect((await rpc(server.url, fresh.token, call(2, 'queue_enqueue', { content: 'now' }))).body.result.isError).toBeUndefined()
    // A new runtime for the instance (an engine or account switch) is a new epoch: the bearer of the old one is closed.
    const switched = bearer({ runId: next.runId, generation: 'codex|default|1|0' })
    expect(switched.token).not.toBe(fresh.token)
    expect((await rpc(server.url, fresh.token, call(3, 'queue_enqueue', { content: 'stale' }))).status).toBe(401)
    expect(enqueued.map((item) => (item.input as { content: string }).content)).toEqual(['now'])
  })

  it('a drained Codex turn keeps its bearer: the calls Mousse received match what the runtime announced', async () => {
    const { server, fx, run, bearer, turns } = await setup()
    const first = bearer()
    await rpc(server.url, first.token, call(1, 'task_list'))
    expect(server.turnEnded({ threadId: 'thread-a', runId: run.runId, tokenHash: first.tokenHash, settlement: { status: 'completed', drain: { mousseCalls: 1, toolsSettled: true } } })).toBe('kept')
    fx.engine.markTerminal(run.runId, 'completed')
    const next = await fx.runningRun('thread-a')
    turns.register(appTurn({ threadId: 'thread-a', runId: next.runId }))
    expect(bearer({ runId: next.runId }).token).toBe(first.token)
    expect((await rpc(server.url, first.token, call(2, 'task_list'))).body.result.isError).toBeUndefined()
  })

  it('a completed Codex turn whose Mousse call Codex never completed rotates, and the old bearer is refused next turn', async () => {
    const { server, fx, run, bearer, turns, enqueued } = await setup()
    const first = bearer()
    await rpc(server.url, first.token, call(1, 'task_list'))
    // Codex announced the call, Mousse answered it, but Codex sent no completion of its own (the
    // service closed the row when the turn ended): the turn is not proven drained.
    expect(server.turnEnded({ threadId: 'thread-a', runId: run.runId, tokenHash: first.tokenHash, settlement: { status: 'completed', drain: { mousseCalls: 1, toolsSettled: false } } })).toBe('rotated')
    fx.engine.markTerminal(run.runId, 'completed')
    const next = await fx.runningRun('thread-a')
    turns.register(appTurn({ threadId: 'thread-a', runId: next.runId }))
    const fresh = bearer({ runId: next.runId })
    expect(fresh.token).not.toBe(first.token)
    // A late call of turn N on its old bearer reaches nothing in turn N+1.
    expect((await rpc(server.url, first.token, call(2, 'queue_enqueue', { content: 'late' }))).status).toBe(401)
    expect(enqueued).toEqual([])
  })

  it('a Claude call is accepted only with the active turn\'s token in its input', async () => {
    const { server, bearer, registered, tasks } = await setup()
    const claude = bearer({ instanceId: 'claude', binding: 'per_call', generation: 'claude|default|0|0' })
    const task = { description: 'P' }
    const unstamped = await rpc(server.url, claude.token, call(1, 'task_create', task))
    expect(unstamped.body.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_caller_not_live })
    expect(tasks.list()).toHaveLength(0)
    const stamped = await rpc(server.url, claude.token, call(2, 'task_create', { ...task, [TURN_TOKEN_KEY]: registered.turn.turnToken }))
    expect(stamped.body.result.isError).toBeUndefined()
    expect(tasks.list()).toHaveLength(1)
  })

  it('sends a tool\'s images as MCP image content', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const turns = new AppToolTurns()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
    const registry = new ToolRegistry({ activeRunId: (threadId) => fx!.store.getActiveRun(threadId)?.runId ?? null, turns })
    registry.register({ name: 'look', description: '', inputSchema: { type: 'object' }, access: 'reads', class: 'read', handler: () => ({ text: 'see', images: [{ data: 'AAAA', mimeType: 'image/png' }] }) })
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    const { token } = server.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, binding: 'drained_turn', generation: 'g' })!
    const result = await rpc(server.url, token, call(1, 'look'))
    expect(result.body.result.content).toEqual([{ type: 'text', text: 'see' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }])
  })

  it('a credential that recorded the default level reads another thread over the wire', async () => {
    const other = { id: 'thread-b', name: 'Other', createdAt: 'x', updatedAt: 'x' } as Thread
    const { server, attachment } = await setup({ threadMeta: (id) => (id === 'thread-b' ? other : undefined) })
    const read = await rpc(server.url, attachment.token, call(1, 'thread_read', { threadId: 'thread-b' }))
    expect(read.body.error).toBeUndefined()
    expect(JSON.parse(read.body.result.content[0].text)).toMatchObject({ threadId: 'thread-b', scope: 'manage' })
  })

  it('reports a conflict as a refusal result with its details beside it', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const turns = new AppToolTurns()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
    const registry = new ToolRegistry({ activeRunId: (threadId) => fx!.store.getActiveRun(threadId)?.runId ?? null, turns })
    registry.register({
      name: 'stale', description: '', inputSchema: { type: 'object' }, access: 'actsAsCaller', class: 'mutation',
      handler: () => { throw new McpToolError('mousse_conflict', 'run 1 is no longer the active run', { expectedRunId: 'run-1', activeRunId: 'run-2' }) }
    })
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    const { token } = server.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, binding: 'drained_turn', generation: 'g' })!
    const result = await rpc(server.url, token, call(1, 'stale'))
    expect(result.body.error).toBeUndefined()
    expect(JSON.parse(result.body.result.content[0].text)).toEqual({
      refused: { code: 'conflict', message: 'run 1 is no longer the active run', retry: 'after_change' },
      data: { reason: 'mousse_conflict', expectedRunId: 'run-1', activeRunId: 'run-2' }
    })
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
    const { server, bearer } = await setup()
    await server.stop()
    expect(bearer()).toBeNull()
  })

  it('maps transport failures to HTTP statuses, an unknown tool to its JSON-RPC code, and a refused tool to a refusal result', async () => {
    const { server, attachment, bearer } = await setup()
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

    const unknown = await rpc(server.url, attachment.token, call(2, 'no_such_tool'))
    // The codes are the wire contract provider runtimes see, so they are pinned literally (-32601 is JSON-RPC's method-not-found).
    expect(unknown.body.error).toMatchObject({ code: -32601, data: { reason: 'mousse_unknown_tool' } })
    // A hidden (in-process only) tool is unknown over MCP.
    expect((await rpc(server.url, attachment.token, call(3, 'create_subagent', { name: 'a', task: 'b' }))).body.error).toMatchObject({ code: -32601 })
    // A tool that fails on its own input is a tool result the model can read, not a protocol error.
    const invalid = await rpc(server.url, attachment.token, call(4, 'task_update', { id: '' }))
    expect(invalid.body.error).toBeUndefined()
    expect(invalid.body.result.isError).toBe(true)

  })

  describe('in-flight tool calls', () => {
    /** Threads a and b each hold a live run and a `hang` tool that waits for its abort signal. */
    const hanging = async () => {
      fx = delegationFixture()
      await fx.runningRun('thread-a'); await fx.runningRun('thread-b')
      const started: string[] = [], reasons = new Map<string, string>()
      const turns = new AppToolTurns()
      const registry = new ToolRegistry({ activeRunId: (threadId) => fx!.store.getActiveRun(threadId)?.runId ?? null, turns })
      registry.register({
        name: 'hang', description: 'waits for its abort signal', inputSchema: { type: 'object' }, access: 'actsAsCaller', class: 'read',
        handler: (_args, ctx) => new Promise((resolve) => {
          started.push(ctx.caller.threadId)
          ctx.signal.addEventListener('abort', () => { reasons.set(ctx.caller.threadId, String((ctx.signal.reason as Error)?.message)); resolve({ text: 'aborted' }) }, { once: true })
        })
      })
      const credentials = new McpCredentials(fx.store)
      server = new MousseMcpServer({ credentials, registry })
      await server.start()
      const attach = (threadId: string) => {
        const runId = fx!.store.getActiveRun(threadId)!.runId
        turns.register(appTurn({ threadId, runId }))
        return { runId, ...server!.bearerForTurn({ threadId, instanceId: 'p', runId, binding: 'drained_turn', generation: 'g' })! }
      }
      const callHang = (token: string, signal?: AbortSignal) => fetch(server!.url, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
        body: JSON.stringify(call(1, 'hang'))
      })
      return { a: attach('thread-a'), b: attach('thread-b'), started, reasons, callHang, credentials }
    }

    it.each([
      ['turnEnded', (s: MousseMcpServer, runId: string) => s.turnEnded({ threadId: 'thread-a', runId, settlement: { status: 'completed' } }), 'The turn of thread thread-a ended'],
      ['revokeThread', (s: MousseMcpServer) => s.revokeThread('thread-a'), 'Thread thread-a credentials were revoked']
    ])('%s aborts that thread\'s in-flight call and no other thread\'s', async (_name, end, reason) => {
      const { a, b, started, reasons, callHang } = await hanging()
      const first = callHang(a.token), other = callHang(b.token)
      await vi.waitFor(() => expect(started.sort()).toEqual(['thread-a', 'thread-b']))
      end(server!, a.runId)
      await first.then((response) => response.text())
      expect(reasons.get('thread-a')).toBe(reason)
      expect(reasons.has('thread-b')).toBe(false)
      server!.turnEnded({ threadId: 'thread-b', runId: b.runId, settlement: { status: 'completed' } })
      await other.then((response) => response.text())
      expect(reasons.get('thread-b')).toBe('The turn of thread thread-b ended')
    })

    it('a call still running when its turn ends counts against the drained proof, so the bearer rotates', async () => {
      const { a, started, callHang } = await hanging()
      const pending = callHang(a.token)
      await vi.waitFor(() => expect(started).toEqual(['thread-a']))
      expect(server!.turnEnded({ threadId: 'thread-a', runId: a.runId, tokenHash: a.tokenHash, settlement: { status: 'completed', drain: { mousseCalls: 1, toolsSettled: true } } })).toBe('rotated')
      await pending.then((response) => response.text())
      const list = await rpc(server!.url, a.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      expect(list.status).toBe(401)
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
    it('compacts tools/list schemas for Antigravity bearers so delegate_task stays well inside its eager tool budget, while keeping full schemas for other providers', async () => {
      const { server, bearer } = await setup()
      const codex = bearer({ instanceId: 'codex', generation: 'codex|default|0|0' })
      const codexList = await rpc(server.url, codex.token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      expect(codexList.status).toBe(200)

      const agy = bearer({ instanceId: 'antigravity', generation: 'antigravity|default|0|0' })
      const agyList = await rpc(server.url, agy.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      expect(agyList.status).toBe(200)
      const codexTools = codexList.body.result.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
      const agyTools = agyList.body.result.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
      expect(agyTools.map((t) => t.name)).toEqual(codexTools.map((t) => t.name))

      const codexDelegate = codexTools.find((t) => t.name === 'delegate_task')!
      const agyDelegate = agyTools.find((t) => t.name === 'delegate_task')!
      // Full schema stays untouched on non-Antigravity providers.
      expect(codexDelegate.description.length).toBeGreaterThan(1000)
      // Antigravity gets a compact schema that keeps every parameter, enum and required field intact.
      expect(agyDelegate.description.length).toBeLessThanOrEqual(120)
      expect(JSON.stringify(agyDelegate).length).toBeLessThan(1000)
      expect(JSON.stringify(agyTools).length).toBeLessThan(JSON.stringify(codexTools).length * 0.5)
      const agyProps = (agyDelegate.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] }).properties
      const codexProps = (codexDelegate.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] }).properties
      expect(Object.keys(agyProps).sort()).toEqual(Object.keys(codexProps).sort())
      expect((agyDelegate.inputSchema as { required: string[] }).required).toEqual((codexDelegate.inputSchema as { required: string[] }).required)
      expect(agyProps.workspace).toEqual({ type: 'string', enum: ['isolated', 'shared'] })
      expect(agyProps.wake).toEqual({ type: 'string', enum: ['always', 'settled_only'] })
    })
  })
})
