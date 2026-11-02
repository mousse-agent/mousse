import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../src/shared/integrations'
import { McpManager, type InjectedMcpClient, type McpClientFactory } from '../../src/mms/integrations/mcp/McpManager'
import { settingsStore, testServerConfig } from '../fixtures/agent-platform/integrations/helpers'

// The McpManager hardening the MCP relay relies on (plan §4.9): stable tool names, reconnecting a
// closed client, per-call timeouts, a restart only when no other call runs, per-server listing.

type Tools = Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>

const two = testServerConfig({ id: 'mousse:two', installationId: 'inst-two', name: 'two' })

/** A factory whose clients list `tools[server]` and call through `callTool`, remembering every client. */
function clientFactory(options: {
  tools?: (server: McpServerConfig) => Promise<Tools> | Tools
  callTool?: InjectedMcpClient['callTool']
} = {}) {
  const clients: InjectedMcpClient[] = []
  const factory: McpClientFactory = {
    async connect(server) {
      const client: InjectedMcpClient = {
        listTools: async () => ({ tools: await (options.tools?.(server) ?? [{ name: 'echo', inputSchema: { type: 'object' } }]) }),
        callTool: options.callTool ?? (async () => ({ content: [{ type: 'text', text: 'ok' }] })),
        close: async () => {}
      }
      clients.push(client)
      return client
    }
  }
  return { factory, clients }
}

function manager(factory: McpClientFactory, servers: McpServerConfig[] = [testServerConfig()]) {
  const store = settingsStore((settings) => {
    settings.integrations.mcp.enabled = true
    settings.integrations.mcp.enableForMainAgent = true
    settings.integrations.mcp.enabledServers = servers.map((server) => server.installationId!)
  })
  return new McpManager({ discover: async () => ({ servers, sources: [], diagnostics: [] }) } as never, store as never, async () => {}, { clientFactory: factory })
}

describe('McpManager for the MCP relay', () => {
  it('keeps a tool\'s provider name across listings, and drops a tool the server stopped listing', async () => {
    let tools: Tools = [{ name: 'echo' }, { name: 'gone' }]
    const { factory } = clientFactory({ tools: () => tools })
    const mcp = manager(factory)
    const first = await mcp.getEnabledTools()
    const echo = first.find((tool) => tool.toolName === 'echo')!.providerName
    const gone = first.find((tool) => tool.toolName === 'gone')!.providerName
    for (let i = 0; i < 3; i++) await mcp.getEnabledTools()
    tools = [{ name: 'echo' }]
    const again = await mcp.getEnabledTools()
    expect(again.map((tool) => tool.providerName)).toEqual([echo])
    expect(echo).not.toMatch(/_\d+$/)
    expect(mcp.lookupTool(echo)?.toolName).toBe('echo')
    expect(mcp.lookupTool(gone)).toBeUndefined()
  })

  it('two tools of one server whose names sanitize alike keep distinct, stable names', async () => {
    const { factory } = clientFactory({ tools: () => [{ name: 'a-b' }, { name: 'a_b' }] })
    const mcp = manager(factory)
    const names = (await mcp.getEnabledTools()).map((tool) => tool.providerName)
    expect(new Set(names).size).toBe(2)
    expect((await mcp.getEnabledTools()).map((tool) => tool.providerName)).toEqual(names)
  })

  it('callTool timeoutMs drives both the SDK request timeout and Mousse\'s own timer', async () => {
    const seen: Array<number | undefined> = []
    const { factory } = clientFactory({
      callTool: async (_args, options) => {
        seen.push(options?.timeout)
        return new Promise(() => {})
      }
    })
    const mcp = manager(factory)
    const [tool] = await mcp.getEnabledTools()
    await expect(mcp.callTool(tool!.providerName, {}, undefined, undefined, undefined, undefined, { timeoutMs: 40 })).rejects.toThrow(/Timed out calling MCP tool echo/)
    expect(seen).toEqual([40])
  })

  it('a client that closed on its own is dropped, and the next call connects again', async () => {
    const { factory, clients } = clientFactory()
    const mcp = manager(factory)
    const [tool] = await mcp.getEnabledTools()
    expect(clients).toHaveLength(1)
    await mcp.callTool(tool!.providerName, {})
    expect(clients).toHaveLength(1)
    // The server went away: its client closed without Mousse asking.
    await clients[0]!.close()
    await vi.waitFor(() => expect(mcp.getActiveCount()).toBe(0))
    const result = await mcp.callTool(tool!.providerName, {})
    expect(result.isError).toBeFalsy()
    expect(clients).toHaveLength(2)
  })

  it('a timed-out call restarts its stdio server only when no other call is running on it', async () => {
    const { factory } = clientFactory({ callTool: async () => new Promise(() => {}) })
    const mcp = manager(factory)
    const [tool] = await mcp.getEnabledTools()
    // The injected client stands in for a stdio server Mousse owns.
    for (const connection of (mcp as unknown as { connections: Map<string, { ownedStdio: boolean }> }).connections.values()) connection.ownedStdio = true
    const restart = vi.spyOn(mcp, 'restartServer')
    const short = mcp.callTool(tool!.providerName, {}, undefined, undefined, undefined, undefined, { timeoutMs: 20 })
    const long = mcp.callTool(tool!.providerName, {}, undefined, undefined, undefined, undefined, { timeoutMs: 120 })
    await expect(short).rejects.toThrow(/Timed out/)
    expect(restart).not.toHaveBeenCalled()
    await expect(long).rejects.toThrow(/Timed out/)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('getEnabledToolsByServer lists each server on its own and reports a failing one', async () => {
    const { factory } = clientFactory({
      tools: (server) => {
        if (server.name === 'two') throw new Error('boom token=sk-ant-secret1234567890')
        return [{ name: 'echo' }, { name: 'bad', inputSchema: { type: 'string' } }]
      }
    })
    const mcp = manager(factory, [testServerConfig(), two])
    const byServer = await mcp.getEnabledToolsByServer()
    expect(byServer.map((entry) => entry.installationId)).toEqual(['inst-echo', 'inst-two'])
    const [echo, failing] = byServer
    expect(echo).toMatchObject({ serverName: 'echo', configRevision: 'rev1' })
    expect(echo!.error).toBeUndefined()
    // A tool with a schema error is left out, as getEnabledTools does.
    expect(echo!.tools.map((tool) => tool.toolName)).toEqual(['echo'])
    expect(failing!.tools).toEqual([])
    expect(failing!.error).toMatch(/boom/)
  })

  it('onDiscoveryInvalidated hears every invalidation until unsubscribed', async () => {
    const mcp = manager(clientFactory().factory)
    const listener = vi.fn()
    const unsubscribe = mcp.onDiscoveryInvalidated(listener)
    mcp.invalidateDiscoveryCache()
    await mcp.refresh()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    mcp.invalidateDiscoveryCache()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
