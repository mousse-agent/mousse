/**
 * The MCP relay's path on the Mousse MCP server (SPEC §15.5): `mousse-relay` at `/mcp/relay` on the
 * same listener and bearer, its listing from the catalogue, its calls admitted by the registry and
 * counted for the drained-turn check, and no relay path without a handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpCredentials } from '../../src/mms/run/mcp/McpCredentials'
import { MCP_ERROR_CODES, MousseMcpServer, RELAY_PATH } from '../../src/mms/run/mcp/MousseMcpServer'
import type { RelayCatalog } from '../../src/mms/run/mcp/relay/catalog'
import { RELAY_INSTRUCTIONS, RelayHandler, type RelayHost } from '../../src/mms/run/mcp/relay/handler'
import type { RelayTool } from '../../src/mms/run/mcp/relay/names'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

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

const say: RelayTool = {
  name: 'echo__say',
  description: '[MCP server "echo"] Says it',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  installationId: 'inst-echo',
  serverName: 'echo',
  toolName: 'say',
  providerName: 'mcp__echo__say__abcd1234'
}

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const callSay = (args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: say.name, arguments: args } })

describe('MousseMcpServer relay path', () => {
  let fx: DelegationFixture | undefined
  let server: MousseMcpServer | undefined
  afterEach(async () => {
    await server?.stop()
    server = undefined
    fx?.dispose()
    fx = undefined
  })

  const setup = async (options: { relay?: boolean } = {}) => {
    fx = delegationFixture()
    const run = await fx.runningRun('thread-a')
    const credentials = new McpCredentials(fx.store)
    const { registry, turns } = appToolRegistry(fx.engine, fakeAppToolHost().host)
    const catalog = { listing: vi.fn(() => [say]), resolve: vi.fn((_scope: string | undefined, name: string) => (name === say.name ? say : undefined)) }
    const manager = {
      isToolCallAllowed: vi.fn(async () => ({ allowed: true })),
      callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: `said ${JSON.stringify(args)}` }], isError: false }))
    }
    const relay = new RelayHandler({ catalog: catalog as unknown as RelayCatalog, manager: manager as unknown as RelayHost['manager'], registry, projectPathFor: () => undefined })
    server = new MousseMcpServer({ credentials, registry, ...(options.relay === false ? {} : { relay }) })
    await server.start()
    turns.register(appTurn({ threadId: 'thread-a', runId: run.runId }))
    const attachment = server.bearerForTurn({
      threadId: 'thread-a', instanceId: 'codex', runId: run.runId, modeCeiling: 'default', binding: 'drained_turn', generation: 'codex|default|0|0', relay: { approvals: 'runtime' }
    })!
    return { run, server, attachment, catalog, manager, credentials }
  }

  it('serves mousse-relay on the same listener with its own instructions', async () => {
    const { server, attachment } = await setup()
    expect(attachment.relayUrl).toBe(server.url.replace(/\/mcp$/, RELAY_PATH))
    const init = await rpc(attachment.relayUrl, attachment.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
    })
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo.name).toBe('mousse-relay')
    expect(init.body.result.instructions).toBe(RELAY_INSTRUCTIONS)
  })

  it('lists the catalogue, never a Mousse tool, and connects to no server for it', async () => {
    const { attachment, manager, catalog } = await setup()
    const listed = await rpc(attachment.relayUrl, attachment.token, list)
    expect(listed.body.result.tools).toEqual([{ name: say.name, description: say.description, inputSchema: say.inputSchema }])
    expect(catalog.listing).toHaveBeenCalled()
    expect(manager.callTool).not.toHaveBeenCalled()
    expect(manager.isToolCallAllowed).not.toHaveBeenCalled()
  })

  it('runs a relayed call with its clientRequestId, and a drained turn counts it', async () => {
    const { server, run, attachment, manager } = await setup()
    const called = await rpc(attachment.relayUrl, attachment.token, callSay({ text: 'hi', clientRequestId: 'r-1' }))
    expect(called.body.result).toEqual({ content: [{ type: 'text', text: 'said {"text":"hi","clientRequestId":"r-1"}' }] })
    expect(manager.callTool).toHaveBeenCalledTimes(1)
    // The runtime announced one call to Mousse's servers and Mousse received one: the turn drained.
    expect(server.turnEnded({ threadId: 'thread-a', runId: run.runId, tokenHash: attachment.tokenHash, settlement: { status: 'completed', drain: { mousseCalls: 1, toolsSettled: true } } })).toBe('kept')
  })

  it('a relay call the runtime did not announce leaves the turn undrained', async () => {
    const { server, run, attachment } = await setup()
    await rpc(attachment.relayUrl, attachment.token, callSay({ text: 'hi' }))
    expect(server.turnEnded({ threadId: 'thread-a', runId: run.runId, tokenHash: attachment.tokenHash, settlement: { status: 'completed', drain: { mousseCalls: 0, toolsSettled: true } } })).toBe('rotated')
  })

  it('takes the same bearer: none or a revoked one is 401', async () => {
    const { server, attachment } = await setup()
    expect((await rpc(attachment.relayUrl, null, list)).status).toBe(401)
    expect((await rpc(attachment.relayUrl, 'invalid', list)).body.error.code).toBe(MCP_ERROR_CODES.mousse_unauthorized)
    server.revokeThread('thread-a')
    expect((await rpc(attachment.relayUrl, attachment.token, list)).status).toBe(401)
  })

  it('a name the catalogue does not know is a JSON-RPC error', async () => {
    const { attachment } = await setup()
    const unknown = await rpc(attachment.relayUrl, attachment.token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo__nope', arguments: {} } })
    expect(unknown.body.error).toMatchObject({ code: MCP_ERROR_CODES.mousse_unknown_tool, data: { reason: 'mousse_unknown_tool' } })
  })

  it('without a relay handler the relay path is not found', async () => {
    const { attachment } = await setup({ relay: false })
    expect((await rpc(attachment.relayUrl, attachment.token, list)).status).toBe(404)
    expect((await rpc(attachment.url, attachment.token, list)).status).toBe(200)
  })
})
