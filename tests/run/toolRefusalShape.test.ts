/**
 * One refusal shape for Mousse tools (docs/plans/tool-api.md §1.2 "Results and refusals"): a refused call is an error
 * result whose text is `{ refused: { code, message, retry } }`, the same over the Mousse MCP server and in process,
 * whichever older shape the refusal had (a thrown scope error, a conflict with `data.conflict`, a handler's
 * own error text). Only faults stay JSON-RPC errors. Every tool that changes something declares `clientRequestId`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Thread } from '../../src/shared/types'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer } from '../../src/mms/run/mcp/MousseMcpServer'
import { READ_ONLY_TOOL_NAMES, REFUSAL_CODES, readRefusal, type ToolOutcome } from '../../src/mms/run/mcp/appTools'
import type { SecretToolHost } from '../../src/mms/run/mcp/appTools/secrets'
import type { SecretRunResult } from '../../src/mms/secrets/runWithSecrets'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

async function rpc(url: string, token: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  return (await response.json()) as { result?: { content: Array<{ type: string; text: string }>; isError?: boolean }; error?: { code: number; data?: Record<string, unknown> } }
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

/** The refusal in an error result's text, parsed whole (with `data` when it has one). */
function parsed(text: string): { refused: Record<string, unknown>; data?: Record<string, unknown> } {
  expect(readRefusal(text)).not.toBeNull()
  return JSON.parse(text)
}

describe('a refused Mousse tool call', () => {
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
    await fx.runningRun('thread-b')
    const fake = fakeAppToolHost({ threadMeta: (id) => (id === 'thread-b' ? ({ id, title: 'B' } as Thread) : undefined) })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
    const token = () =>
      server!.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, binding: 'drained_turn', generation: 'g' })!.token
    /** The call over the MCP server: its error result's text, or the JSON-RPC error. */
    const overMcp = async (name: string, args: Record<string, unknown>) => {
      const body = await rpc(server!.url, token(), call(name, args))
      return body.error ? { error: body.error } : { isError: body.result!.isError, text: body.result!.content[0].text }
    }
    /** The same call in process (`ToolRegistry.call`), as the bot and Pi paths make it. */
    const inProcess = (name: string, args: Record<string, unknown>): Promise<ToolOutcome> =>
      registry.call(name, args, request({ threadId: 'thread-a', runId: run.runId }))
    return { registry, overMcp, inProcess }
  }

  // One row per older shape: what the call is, the code it now has, and fields kept beside it.
  const rows: Array<{ shape: string; tool: string; args: Record<string, unknown>; code: string; retry: string; data?: Record<string, unknown> }> = [
    { shape: 'a thrown scope refusal (was JSON-RPC -32003)', tool: 'thread_read', args: { threadId: 'no-such-thread' }, code: 'scope_denied', retry: 'never', data: { reason: 'mousse_scope_denied' } },
    {
      shape: 'a conflict with data.conflict (was JSON-RPC -32006)', tool: 'thread_wait', args: { threadId: 'thread-b', runId: 'run-elsewhere' }, code: 'conflict', retry: 'after_change',
      data: { reason: 'mousse_conflict', conflict: 'run_not_found', expectedRunId: 'run-elsewhere' }
    },
    { shape: "a handler's own error text (was plain text)", tool: 'task_update', args: { id: '' }, code: 'failed', retry: 'after_change' }
  ]

  it.each(rows)('$shape is an error result in the refusal shape, the same over MCP and in process', async (row) => {
    const { overMcp, inProcess } = await setup()
    const wire = await overMcp(row.tool, row.args)
    expect(wire).not.toHaveProperty('error')
    expect(wire.isError).toBe(true)
    const refusal = parsed(wire.text!)
    expect(REFUSAL_CODES).toContain(refusal.refused.code)
    expect(refusal.refused).toMatchObject({ code: row.code, retry: row.retry, message: expect.any(String) })
    expect(refusal.refused.message).not.toMatch(/^mousse_/)
    if (row.data) expect(refusal.data).toMatchObject(row.data)
    else expect(refusal.data).toBeUndefined()

    const local = await inProcess(row.tool, row.args)
    expect(local.isError).toBe(true)
    expect(parsed(local.text)).toEqual(refusal)
  })

  it('keeps JSON-RPC errors for faults: a tool that is not there, and a credential whose turn is over', async () => {
    const { overMcp, inProcess } = await setup()
    expect((await overMcp('no_such_tool', {})).error).toMatchObject({ code: MCP_ERROR_CODES.mousse_unknown_tool, data: { reason: 'mousse_unknown_tool' } })
    await expect(inProcess('no_such_tool', {})).rejects.toMatchObject({ code: 'mousse_unknown_tool' })
  })
})

describe('a tool that ran and failed', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  it('is not a refusal: secret_run with a non-zero exit keeps its exit code and output as plain text, over MCP and in process', async () => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const output = 'Fetching model...\nerror: 401 Unauthorized'
    const secrets: SecretToolHost = {
      request: async () => { throw new Error('not asked') },
      endThread: () => undefined,
      usableIn: () => true,
      run: async () => ({ exitCode: 2, output, timedOut: false, stopped: false }) as SecretRunResult,
      masker: () => undefined
    }
    const fake = fakeAppToolHost({ secrets: () => secrets, permissionModeFor: () => 'full' })
    const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
    server = new MousseMcpServer({ credentials: new McpCredentials(fx.store), registry })
    await server.start()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, projectPath: '/project' }))
    const args = { command: 'download', secrets: [{ name: 'HF_TOKEN' }] }
    const expected = `Exit code 2.\n${output}`

    const token = server.bearerForTurn({ threadId: 'thread-a', instanceId: 'codex', runId: run.runId, binding: 'drained_turn', generation: 'g' })!.token
    const body = await rpc(server.url, token, call('secret_run', args))
    expect(body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: expected }] })

    const local = await registry.call('secret_run', args, request({ threadId: 'thread-a', runId: run.runId }))
    expect(local).toMatchObject({ isError: true, text: expected })
    expect(readRefusal(local.text)).toBeNull()
  })
})

describe('clientRequestId', () => {
  it('is declared by every listed tool that changes something, and by no read-only one', async () => {
    const fx = delegationFixture()
    try {
      const { registry } = appToolRegistry(fx.engine, fakeAppToolHost().host, { bots: () => undefined, botMemory: () => undefined })
      const listed = registry.list().filter((tool) => tool.callable !== 'in_process')
      const declares = (schema: unknown) => Boolean((schema as { properties?: Record<string, unknown> }).properties?.clientRequestId)
      expect(listed.filter((tool) => !READ_ONLY_TOOL_NAMES.has(tool.name) && (!declares(tool.inputSchema) || (tool.botInputSchema && !declares(tool.botInputSchema)))).map((tool) => tool.name)).toEqual([])
      expect(listed.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool.name) && declares(tool.inputSchema)).map((tool) => tool.name)).toEqual([])
      // Both kinds are present, so neither check above is empty by accident.
      expect(listed.some((tool) => tool.name === 'thread_read')).toBe(true)
      expect(listed.some((tool) => tool.name === 'task_create')).toBe(true)
    } finally {
      fx.dispose()
    }
  })
})
