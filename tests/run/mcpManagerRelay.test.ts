import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../src/shared/integrations'
import { McpManager, type InjectedMcpClient, type McpClientFactory } from '../../src/mms/integrations/mcp/McpManager'
import { settingsStore, testServerConfig } from '../fixtures/agent-platform/integrations/helpers'
import { RelayHandler } from '../../src/mms/run/mcp/relay/handler'
import type { RelayCatalog } from '../../src/mms/run/mcp/relay/catalog'
import type { RelayTool } from '../../src/mms/run/mcp/relay/names'
import type { McpCallRequest } from '../../src/mms/run/mcp/appTools/registry'
import type { AppToolTurn } from '../../src/mms/run/mcp/appTools/types'
import type { ModeCeiling } from '../../src/mms/run/types'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { appTurn } from './appToolsFixture'

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

  it('a timed-out call restarts its stdio server only when it no longer answers a ping, and no other call runs on it', async () => {
    const { factory, clients } = clientFactory({ callTool: async () => new Promise(() => {}) })
    const mcp = manager(factory)
    const [tool] = await mcp.getEnabledTools()
    // The injected client stands in for a stdio server Mousse owns, and it no longer answers a ping.
    for (const connection of (mcp as unknown as { connections: Map<string, { ownedStdio: boolean }> }).connections.values()) connection.ownedStdio = true
    const close = vi.spyOn(clients[0]!, 'close')
    const short = mcp.callTool(tool!.providerName, {}, undefined, undefined, undefined, undefined, { timeoutMs: 20 })
    const long = mcp.callTool(tool!.providerName, {}, undefined, undefined, undefined, undefined, { timeoutMs: 120 })
    await expect(short).rejects.toThrow(/Timed out/)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(close).not.toHaveBeenCalled()
    await expect(long).rejects.toThrow(/Timed out/)
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  })

  it('a timed-out call leaves a stdio server that still answers a ping running', async () => {
    const { factory, clients } = clientFactory({ callTool: async () => new Promise(() => {}) })
    const mcp = manager(factory)
    const [tool] = await mcp.getEnabledTools()
    for (const connection of (mcp as unknown as { connections: Map<string, { ownedStdio: boolean }> }).connections.values()) connection.ownedStdio = true
    const ping = vi.fn(async () => ({}))
    clients[0]!.ping = ping
    const close = vi.spyOn(clients[0]!, 'close')
    await expect(mcp.callTool(tool!.providerName, {}, undefined, undefined, undefined, undefined, { timeoutMs: 20 })).rejects.toThrow(/Timed out/)
    await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mcp.snapshotOwnedWork()['mcp-ping'] ?? 0).toBe(0))
    expect(close).not.toHaveBeenCalled()
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

it('refuses a pinned schema that changed before dispatch', async () => {
  const callTool = vi.fn(async () => ({ content: [] }))
  const { factory } = clientFactory({ callTool })
  const mcp = manager(factory)
  const tool = (await mcp.getEnabledTools())[0]!
  await expect(mcp.callTool(tool.providerName, {}, undefined, undefined, undefined, {
    installationId: tool.installationId!, configRevision: tool.configRevision!, toolName: tool.toolName,
    schemaDigest: 'a-different-schema'
  })).rejects.toMatchObject({ code: 'stale_revision' })
  expect(callTool).not.toHaveBeenCalled()
  await mcp.shutdown()
})

it('checks the bot binding synchronously after the last asynchronous authorization read', async () => {
  const callTool = vi.fn(async () => ({ content: [] }))
  const { factory } = clientFactory({ callTool })
  const mcp = manager(factory)
  const tool = (await mcp.getEnabledTools())[0]!
  let stillGranted = true
  const original = mcp.isToolCallAllowed.bind(mcp)
  let reads = 0
  vi.spyOn(mcp, 'isToolCallAllowed').mockImplementation(async (...args) => {
    const allowed = await original(...args)
    if (++reads === 2) stillGranted = false
    return allowed
  })
  await expect(mcp.callTool(tool.providerName, {}, undefined, undefined, undefined, {
    installationId: tool.installationId!, configRevision: tool.configRevision!, toolName: tool.toolName,
    assertDispatchActive: () => { if (!stillGranted) throw new Error('grant changed') }
  })).rejects.toThrow('grant changed')
  expect(callTool).not.toHaveBeenCalled()
  await mcp.shutdown()
})

it.each([false, true])('tracks certainty at the actual transport boundary, dispatched=%s', async dispatched => {
  const callTool = vi.fn(async () => { throw new Error('connection dropped') })
  const { factory } = clientFactory({ callTool })
  const mcp = manager(factory)
  const tool = (await mcp.getEnabledTools())[0]!
  const error = await mcp.callTool(tool.providerName, {}, undefined, undefined, undefined, {
    installationId: tool.installationId!, configRevision: tool.configRevision!, toolName: tool.toolName,
    assertDispatchActive: () => { if (!dispatched) throw new Error('binding changed') }
  }, { trackDispatch: true }).catch(error => error as { mcpNotDispatched?: boolean })
  expect(error.mcpNotDispatched).toBe(dispatched ? undefined : true)
  expect(callTool).toHaveBeenCalledTimes(dispatched ? 1 : 0)
  await mcp.shutdown()
})

it('re-lists hints on tools/list_changed before publishing discovery changes', async () => {
  let changed: (() => Promise<void>) | undefined
  let readOnlyHint: boolean | undefined = true
  const mcp = manager({ connect: async () => ({
    listTools: async () => ({ tools: [{ name: 'get_items', inputSchema: { type: 'object' }, annotations: { readOnlyHint } }] }),
    callTool: async () => ({}), close: async () => {},
    onToolsChanged: (listener: () => Promise<void>) => { changed = listener }
  }) })
  try {
    const [tool] = await mcp.getEnabledTools()
    expect(tool!.readOnlyHint).toBe(true)
    readOnlyHint = undefined
    await changed?.()
    expect(mcp.lookupTool(tool!.providerName)?.readOnlyHint).toBeUndefined()
  } finally { await mcp.shutdown() }
})
it('re-lists tools after restarting a server', async () => {
  let tools: Tools = [{ name: 'before' }]
  const { factory } = clientFactory({ tools: () => tools })
  const mcp = manager(factory)
  try {
    const [before] = await mcp.getEnabledTools()
    tools = [{ name: 'after' }]
    await mcp.restartServer(before!.installationId!)
    await mcp.refreshEnabledServer(before!.installationId!)
    expect(mcp.lookupTool(before!.providerName)).toBeUndefined()
    expect((await mcp.getEnabledTools()).map(t => t.toolName)).toEqual(['after'])
  } finally { await mcp.shutdown() }
})

it('a targeted server listing leaves other servers alone', async () => {
  const seen: string[] = []
  const { factory } = clientFactory({ tools: server => { seen.push(server.installationId!); return [{ name: 'echo' }] } })
  const mcp = manager(factory, [testServerConfig(), two])
  try {
    await mcp.getEnabledToolsByServer(undefined, undefined, { installationId: 'inst-two' })
    expect(seen).toEqual(['inst-two'])
  } finally { await mcp.shutdown() }
})

it('re-lists again when a hint changes during an in-flight notification listing', async () => {
  let notify: (() => Promise<void>) | undefined, release!: () => void
  let hint: boolean | undefined = true, reads = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const mcp = manager({ connect: async () => ({
    onToolsChanged: listener => { notify = listener },
    listTools: async () => { const readOnlyHint = hint; if (++reads === 2) await gate; return { tools: [{ name: 'send', inputSchema: {}, annotations: { readOnlyHint } }] } },
    callTool: async () => ({}), close: async () => {}
  }) })
  try {
    const [tool] = await mcp.getEnabledTools()
    const first = notify!()
    await vi.waitFor(() => expect(reads).toBe(2))
    hint = undefined
    const second = notify!()
    release(); await Promise.all([first, second])
    expect(mcp.lookupTool(tool!.providerName)?.readOnlyHint).toBeUndefined()
  } finally { release(); await mcp.shutdown() }
})

// Config changes close the old connection; only an explicit Restart may re-list.
it.each(['disable', 'delete', 'edit', 'unauthorized', 'unreachable'])('restart stays close-only after %s', async change => {
  const servers = [testServerConfig()]
  let broken = false
  const { factory, clients } = clientFactory({ tools: () => {
    if (broken) throw new Error(change)
    return [{ name: 'echo' }]
  } })
  const mcp = manager(factory, servers)
  try {
    await mcp.getEnabledTools()
    if (change === 'disable') servers[0]!.enabled = false
    if (change === 'delete') servers.splice(0)
    if (change === 'edit') servers[0] = { ...servers[0]!, url: 'http://example.test/new', configRevision: 'rev2' }
    broken = change === 'unauthorized' || change === 'unreachable'
    await expect(mcp.restartServer('inst-echo')).resolves.toBeUndefined()
    expect(clients).toHaveLength(1)
    expect(mcp.getActiveCount()).toBe(0)
  } finally { await mcp.shutdown() }
})

it.each(['enabled', 'disable', 'delete', 'edit', 'unauthorized', 'unreachable'])('explicit Restart re-lists current enabled config: %s', async change => {
  const servers = [testServerConfig()]
  const seen: string[] = []
  let broken = false
  const { factory, clients } = clientFactory({ tools: server => {
    seen.push(server.configRevision!)
    if (broken) throw new Error(change)
    return [{ name: 'echo' }]
  } })
  const mcp = manager(factory, servers)
  try {
    await mcp.getEnabledTools()
    if (change === 'disable') servers[0]!.enabled = false
    if (change === 'delete') servers.splice(0)
    if (change === 'edit') servers[0] = { ...servers[0]!, configRevision: 'rev2', url: 'http://example.test/current' }
    broken = change === 'unauthorized' || change === 'unreachable'
    await mcp.restartServer('inst-echo')
    await expect(mcp.refreshEnabledServer('inst-echo')).resolves.toBeUndefined()
    expect(clients).toHaveLength(['disable', 'delete'].includes(change) ? 1 : 2)
    expect(seen).toEqual(['disable', 'delete'].includes(change) ? ['rev1'] : ['rev1', change === 'edit' ? 'rev2' : 'rev1'])
  } finally { await mcp.shutdown() }
})

it('a delete stops a queued list_changed pass from reconnecting', async () => {
  let notify!: () => Promise<void>, release!: () => void, reads = 0, connects = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const servers = [testServerConfig()]
  const mcp = manager({ connect: async () => {
    connects++
    return { onToolsChanged: listener => { notify = listener }, listTools: async () => {
      if (++reads === 2) await gate
      return { tools: [{ name: 'echo', inputSchema: {} }] }
    }, callTool: async () => ({}), close: async () => {} }
  } }, servers)
  try {
    await mcp.getEnabledTools()
    const first = notify(); await vi.waitFor(() => expect(reads).toBe(2))
    const second = notify(); servers.splice(0)
    await mcp.restartServer('inst-echo'); release(); await Promise.all([first, second])
    expect(connects).toBe(1); expect(mcp.getActiveCount()).toBe(0)
  } finally { release(); await mcp.shutdown() }
})

describe('a relayed call through the real manager, held to the ceiling when it is sent', () => {
  // The server's connection went away after it was listed, so the call connects again; a thread above switches to Plan
  // while it does (`planDuringConnect`), after any approval came back.
  it.each([
    ['approved after asking, then Plan lands while it connects: refused, and the server never gets it', 'accept_edits', true],
    ['unasked (Full access), then Plan lands while it connects: refused, and the server never gets it', 'full', true],
    ['unasked, and nothing changes above: it reaches the server', 'full', false]
  ] as const)('%s', async (_name, mode: PermissionMode, planDuringConnect) => {
    let above: ModeCeiling | undefined
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'said' }] }))
    const { factory, clients } = clientFactory({ callTool })
    const mcp = manager(factory)
    const [tool] = await mcp.getEnabledTools()
    await clients[0]!.close()
    await vi.waitFor(() => expect(mcp.getActiveCount()).toBe(0))
    const connect = factory.connect.bind(factory)
    factory.connect = async (...args) => {
      if (planDuringConnect) above = 'plan'
      return connect(...args)
    }
    const relayed: RelayTool = { name: 'echo__say', description: 'echo', inputSchema: { type: 'object' }, installationId: tool!.installationId!, serverName: 'echo', toolName: tool!.toolName, providerName: tool!.providerName, configRevision: tool!.configRevision ?? '' }
    const turn = { ...appTurn({ threadId: 't1', runId: 'r1' }), turnToken: 'tt' } as AppToolTurn
    const askApproval = vi.fn(async () => ({ permission: 'allow' }))
    const handler = new RelayHandler({
      catalog: { listing: () => [relayed], resolve: () => relayed } as unknown as RelayCatalog,
      manager: mcp,
      registry: {
        admit: async () => ({ threadId: 't1', active: 'r1', turn, args: {}, caller: { threadId: 't1', runId: 'r1', provider: 'codex', modeCeiling: 'default' as const, accessLevel: 'lineage' as const }, boundToken: 'tt' }),
        ceilingNow: (_threadId, ceiling) => above ?? ceiling
      },
      projectPathFor: () => undefined,
      permissionModeFor: () => mode,
      askApproval: askApproval as never
    })
    const request: McpCallRequest = {
      credential: { threadId: 't1', runId: 'r1', provider: 'codex', modeCeiling: 'default', accessLevel: 'lineage', binding: 'per_call', relay: { approvals: 'mousse' }, current: () => true },
      toolCallId: 'mcp:c1',
      signal: new AbortController().signal
    }
    const call = handler.call(relayed.name, { _mousse_turn: 'tt' }, request)
    if (planDuringConnect) await expect(call).rejects.toMatchObject({ code: 'mousse_ceiling_exceeded' })
    else expect(await call).toEqual({ text: 'said' })
    expect(clients).toHaveLength(2)
    expect(askApproval).toHaveBeenCalledTimes(mode === 'full' ? 0 : 1)
    expect(callTool).toHaveBeenCalledTimes(planDuringConnect ? 0 : 1)
    await mcp.shutdown()
  })
})
