/**
 * The MCP relay's catalogue (SPEC §15.5, plan §4.7): last good tools per installation and project
 * scope, a synchronous revision of eligible servers and the listing's names and schemas, a bounded
 * warm-up of a cold scope, background refresh of a stale one, deduped refreshes, and names that
 * resolve for one generation after they change.
 */
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig, McpToolDescriptor } from '../../src/shared/integrations'
import { getDefaultSettings } from '../../src/shared/settings'
import { RELAY_LISTING_TTL_MS, RelayCatalog, mcpServerIdentity, relayTurnContext } from '../../src/mms/run/mcp/relay/catalog'
import type { RelayServerTools } from '../../src/mms/run/mcp/relay/types'
import { testServerConfig } from '../fixtures/agent-platform/integrations/helpers'

function tool(server: McpServerConfig, toolName: string, overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    id: `${server.installationId}:${toolName}`,
    serverId: server.id,
    serverName: server.name,
    toolName,
    providerName: `mcp__${server.name}__${toolName}__abcd1234`,
    description: `${toolName} on ${server.name}`,
    inputSchema: { type: 'object' },
    installationId: server.installationId,
    configRevision: server.configRevision,
    ...overrides
  }
}

const echo = testServerConfig()
const two = testServerConfig({ id: 'mousse:two', installationId: 'inst-two', name: 'two', configRevision: 'rev2' })

function setup(options: { servers?: McpServerConfig[] } = {}) {
  const settings = getDefaultSettings().integrations.mcp
  settings.enabled = true
  settings.enableForMainAgent = true
  settings.enabledServers = ['inst-echo', 'inst-two']
  const state = {
    servers: options.servers ?? [echo],
    tools: new Map<string, McpToolDescriptor[]>([['inst-echo', [tool(echo, 'say')]], ['inst-two', [tool(two, 'add')]]]),
    failing: new Set<string>(),
    discoveryFails: false,
    /** Holds every listing until released. */
    gate: undefined as Promise<void> | undefined
  }
  const listeners = new Set<() => void>()
  let clock = 1_000
  const manager = {
    listConfiguredServers: vi.fn(async () => {
      if (state.discoveryFails) throw new Error('discovery failed')
      return state.servers
    }),
    getEnabledToolsByServer: vi.fn(async (): Promise<RelayServerTools[]> => {
      await state.gate
      return state.servers.map((server) => ({
        installationId: server.installationId!,
        serverName: server.name,
        configRevision: server.configRevision,
        tools: state.failing.has(server.installationId!) ? [] : state.tools.get(server.installationId!) ?? [],
        ...(state.failing.has(server.installationId!) ? { error: 'unreachable' } : {})
      }))
    }),
    onDiscoveryInvalidated: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const catalog = new RelayCatalog({ manager, settings: () => settings, now: () => clock })
  return {
    catalog, manager, settings, state, listeners,
    advance: (ms: number) => { clock += ms },
    invalidate: () => { for (const listener of listeners) listener() }
  }
}

const names = (catalog: RelayCatalog, projectPath?: string) => catalog.listing(projectPath).map((entry) => entry.name)

describe('one slow and one fast server', () => {
  it('each server is published as it answers: the fast one\'s tools at once, the slow one as starting until it answers', async () => {
    const { catalog, manager, state } = setup({ servers: [echo, two] })
    let release!: () => void
    const slow = new Promise<void>((resolve) => { release = resolve })
    // As the real manager does: each server's entry is heard as soon as it answers.
    manager.getEnabledToolsByServer.mockImplementation(async (_project?: string, _actor?: unknown, options?: { onServer?: (entry: RelayServerTools) => void }) => {
      const entryOf = (server: McpServerConfig): RelayServerTools => ({ installationId: server.installationId!, serverName: server.name, tools: state.tools.get(server.installationId!) ?? [] })
      return Promise.all(state.servers.map(async (server) => {
        if (server === two) await slow
        const entry = entryOf(server)
        options?.onServer?.(entry)
        return entry
      }))
    })
    const heard: Array<string | undefined> = []
    catalog.onPublished((projectPath) => heard.push(projectPath))
    const refreshing = catalog.refresh(undefined)
    await vi.waitFor(() => expect(names(catalog)).toEqual(['echo__say']))
    expect(catalog.listed()).toBe(true)
    expect(catalog.servers().map((entry) => [entry.serverName, entry.starting, entry.failing, entry.tools.length])).toEqual([['echo', false, false, 1], ['two', true, false, 0]])
    const partial = catalog.revision()
    expect(partial).toMatch(/^[0-9a-f]{12}$/)
    release()
    await refreshing
    expect(names(catalog)).toEqual(['echo__say', 'two__add'])
    expect(catalog.servers().map((entry) => [entry.serverName, entry.starting])).toEqual([['echo', false], ['two', false]])
    expect(catalog.revision()).not.toBe(partial)
    expect(heard.length).toBeGreaterThanOrEqual(3)
  })

  it('a server that never answers ends the refresh as failing, not starting', async () => {
    const { catalog, state } = setup({ servers: [echo, two] })
    state.failing.add('inst-two')
    await catalog.refresh(undefined)
    expect(catalog.servers().find((entry) => entry.serverName === 'two')).toMatchObject({ starting: false, failing: true, tools: [] })
  })
})

describe('a server\'s identity', () => {
  it('follows its URL\'s origin and path, or its command and arguments, never a query or a secret', () => {
    const http = (url: string) => mcpServerIdentity({ transport: 'http', url })
    expect(http('https://mcp.example.test/v1')).toMatch(/^[0-9a-f]{10}$/)
    expect(http('https://mcp.example.test/v1?token=abc')).toBe(http('https://mcp.example.test/v1?token=xyz'))
    expect(http('https://mcp.example.test/v1')).not.toBe(http('https://other.example.test/v1'))
    expect(http('https://mcp.example.test/v1')).not.toBe(http('https://mcp.example.test/v2'))
    const stdio = (command: string, args: string[]) => mcpServerIdentity({ transport: 'stdio', command, args })
    expect(stdio('node', ['server.js'])).not.toBe(stdio('node', ['other.js']))
    // A key, after a flag that names it or on its own, and one in a URL's path, never changes the identity.
    expect(stdio('node', ['server.js', '--api-key', 'abc'])).toBe(stdio('node', ['server.js', '--api-key', 'xyz']))
    expect(stdio('npx', ['-y', 'gh-mcp', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'])).toBe(stdio('npx', ['-y', 'gh-mcp', 'ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2']))
    expect(http('https://mcp.example.test/k/a1B2c3D4e5F6g7H8i9J0k1L2m3/sse')).toBe(http('https://mcp.example.test/k/Z9y8X7w6V5u4T3s2R1q0P9o8N7/sse'))
    expect(stdio('node', ['C:\\servers\\notes-server-for-my-team-2026.js'])).not.toBe(stdio('node', ['C:\\servers\\other-server-for-my-team-2026.js']))
  })

  it('is listed with each enabled server, and every configured one (on or off) is known', async () => {
    const off = testServerConfig({ id: 'mousse:off', installationId: 'inst-off', name: 'off', url: 'https://off.example.test/mcp' })
    const { catalog } = setup({ servers: [echo, two, off] })
    await catalog.refresh(undefined)
    expect(catalog.servers().find((entry) => entry.serverName === 'echo')!.identity).toBe(mcpServerIdentity(echo))
    expect(catalog.servers().find((entry) => entry.serverName === 'two')!.identity).toBe(mcpServerIdentity(two))
    expect(catalog.configured().map((entry) => entry.installationId)).toEqual(['inst-echo', 'inst-two', 'inst-off'])
  })
})

describe('RelayCatalog', () => {
  it('is cold and empty until refreshed, then lists the enabled servers\' tools with a revision', async () => {
    const { catalog } = setup({ servers: [echo, two] })
    expect(catalog.listing()).toEqual([])
    expect(catalog.revision()).toBe('')
    await catalog.refresh()
    expect(names(catalog)).toEqual(['echo__say', 'two__add'])
    expect(catalog.revision()).toMatch(/^[0-9a-f]{12}$/)
    expect(catalog.resolve(undefined, 'two__add')).toMatchObject({ installationId: 'inst-two', toolName: 'add', providerName: 'mcp__two__add__abcd1234' })
  })

  it('keeps each project scope apart', async () => {
    const { catalog, state } = setup()
    await catalog.refresh('/p1')
    state.servers = [two]
    await catalog.refresh('/p2')
    expect(names(catalog, '/p1')).toEqual(['echo__say'])
    expect(names(catalog, '/p2')).toEqual(['two__add'])
    expect(catalog.listing()).toEqual([])
    expect(catalog.revision('/p1')).not.toBe(catalog.revision('/p2'))
  })

  it('a server whose listing fails keeps its last good tools, and the revision holds', async () => {
    const { catalog, state } = setup({ servers: [echo, two] })
    await catalog.refresh()
    const revision = catalog.revision()
    state.failing.add('inst-two')
    await catalog.refresh()
    expect(names(catalog)).toEqual(['echo__say', 'two__add'])
    expect(catalog.revision()).toBe(revision)
  })

  it('a refresh that fails outright changes nothing', async () => {
    const { catalog, state } = setup()
    await catalog.refresh()
    const revision = catalog.revision()
    state.discoveryFails = true
    await expect(catalog.refresh()).resolves.toBeUndefined()
    expect(names(catalog)).toEqual(['echo__say'])
    expect(catalog.revision()).toBe(revision)
  })

  it('the revision follows names, schemas and server settings, never descriptions', async () => {
    const { catalog, state } = setup()
    await catalog.refresh()
    const base = catalog.revision()
    state.tools.set('inst-echo', [tool(echo, 'say', { description: 'reworded' })])
    await catalog.refresh()
    expect(catalog.revision()).toBe(base)
    state.tools.set('inst-echo', [tool(echo, 'say', { inputSchema: { type: 'object', properties: { x: { type: 'string' } } } })])
    await catalog.refresh()
    const schema = catalog.revision()
    expect(schema).not.toBe(base)
    state.servers = [{ ...echo, deniedTools: ['other'] }]
    await catalog.refresh()
    const denied = catalog.revision()
    expect(denied).not.toBe(schema)
    state.servers = [{ ...echo, deniedTools: ['other'], configRevision: 'rev9' }]
    await catalog.refresh()
    expect(catalog.revision()).not.toBe(denied)
  })

  it('the revision is empty when no runtime has the relay or no server is eligible', async () => {
    const { catalog, settings, state } = setup()
    await catalog.refresh()
    expect(catalog.revision()).not.toBe('')
    settings.relay = { runtimes: { claude: false, codex: false, cursor: false, acp: false, antigravity: false, grok: false } }
    expect(catalog.revision()).toBe('')
    settings.relay = { runtimes: {} }
    state.servers = [{ ...echo, status: 'missing-env' }]
    await catalog.refresh()
    expect(catalog.revision()).toBe('')
    expect(catalog.listing()).toEqual([])
  })

  it('a renamed tool still resolves by its old name for one generation', async () => {
    const { catalog, state } = setup()
    await catalog.refresh()
    state.tools.set('inst-echo', [tool(echo, 'speak')])
    await catalog.refresh()
    expect(names(catalog)).toEqual(['echo__speak'])
    expect(catalog.resolve(undefined, 'echo__say')?.toolName).toBe('say')
    // An unchanged refresh keeps the previous generation.
    await catalog.refresh()
    expect(catalog.resolve(undefined, 'echo__say')?.toolName).toBe('say')
    state.tools.set('inst-echo', [tool(echo, 'shout')])
    await catalog.refresh()
    expect(catalog.resolve(undefined, 'echo__say')).toBeUndefined()
    expect(catalog.resolve(undefined, 'echo__speak')?.toolName).toBe('speak')
  })

  it('concurrent refreshes of a scope share one read', async () => {
    const { catalog, manager, state } = setup()
    let release!: () => void
    state.gate = new Promise((resolve) => { release = resolve })
    const a = catalog.refresh()
    const b = catalog.refresh()
    release()
    await Promise.all([a, b])
    expect(manager.getEnabledToolsByServer).toHaveBeenCalledTimes(1)
  })

  it('ensure waits at most the budget for a cold scope; the listing lands when it finishes', async () => {
    const { catalog, state } = setup()
    let release!: () => void
    state.gate = new Promise((resolve) => { release = resolve })
    const started = Date.now()
    await catalog.ensure(undefined, 30)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(catalog.listing()).toEqual([])
    release()
    await vi.waitFor(() => expect(names(catalog)).toEqual(['echo__say']))
  })

  it('ensure on a warm scope returns at once, and refreshes in the background once stale', async () => {
    const { catalog, manager, state, advance, invalidate } = setup()
    await catalog.ensure()
    expect(manager.getEnabledToolsByServer).toHaveBeenCalledTimes(1)
    await catalog.ensure()
    expect(manager.getEnabledToolsByServer).toHaveBeenCalledTimes(1)

    // Stale by age: served as is, refreshed behind it.
    advance(RELAY_LISTING_TTL_MS)
    let release!: () => void
    state.gate = new Promise((resolve) => { release = resolve })
    state.tools.set('inst-echo', [tool(echo, 'speak')])
    await catalog.ensure()
    expect(names(catalog)).toEqual(['echo__say'])
    expect(manager.getEnabledToolsByServer).toHaveBeenCalledTimes(2)
    release()
    await vi.waitFor(() => expect(names(catalog)).toEqual(['echo__speak']))

    // Stale by the manager's invalidation.
    state.gate = undefined
    invalidate()
    await catalog.ensure()
    await vi.waitFor(() => expect(manager.getEnabledToolsByServer).toHaveBeenCalledTimes(3))
  })

  it('a change of settings makes the scope stale', async () => {
    const { catalog, manager, settings } = setup()
    await catalog.ensure()
    settings.enabledServers = ['inst-echo']
    await catalog.ensure()
    await vi.waitFor(() => expect(manager.getEnabledToolsByServer).toHaveBeenCalledTimes(2))
  })

  it('starts no server when no runtime has the relay', async () => {
    const { catalog, manager, settings } = setup()
    settings.relay = { runtimes: { claude: false, codex: false, cursor: false, acp: false, antigravity: false, grok: false } }
    await catalog.refresh()
    expect(manager.listConfiguredServers).not.toHaveBeenCalled()
    expect(manager.getEnabledToolsByServer).not.toHaveBeenCalled()
    expect(catalog.listing()).toEqual([])
  })

  it('dispose unsubscribes from the manager', () => {
    const { catalog, listeners } = setup()
    expect(listeners.size).toBe(1)
    catalog.dispose()
    expect(listeners.size).toBe(0)
  })
})

describe('relayTurnContext (completeAppTurn)', () => {
  it('warms the scope and returns the revision with every runtime explicit', async () => {
    const { catalog, settings } = setup()
    settings.relay = { runtimes: { cursor: false } }
    const relay = await relayTurnContext(catalog, settings, { projectPath: '/p' })
    expect(relay).toEqual({
      revision: catalog.revision('/p'),
      runtimes: { claude: true, codex: true, cursor: false, acp: true, antigravity: true, grok: true }
    })
    expect(relay!.revision).not.toBe('')
  })

  it('is absent for a bot or definition turn, without a catalogue, or with the relay off everywhere', async () => {
    const { catalog, settings, manager } = setup()
    expect(await relayTurnContext(catalog, settings, { bot: {} as never })).toBeUndefined()
    expect(await relayTurnContext(catalog, settings, { definition: {} as never })).toBeUndefined()
    expect(await relayTurnContext(undefined, settings, {})).toBeUndefined()
    settings.enabled = false
    expect(await relayTurnContext(catalog, settings, {})).toBeUndefined()
    expect(manager.getEnabledToolsByServer).not.toHaveBeenCalled()
  })
})
