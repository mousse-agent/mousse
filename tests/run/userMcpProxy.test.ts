import { describe, expect, it } from 'vitest'
import { McpManager } from '../../src/mms/integrations/mcp/McpManager'
import { TURN_TOKEN_KEY, ToolRegistry, userMcpProxy } from '../../src/mms/run/mcp/appTools/registry'
import { AppToolTurns } from '../../src/mms/run/mcp/appTools/turns'
import { injectedFactory, settingsStore, testServerConfig } from '../fixtures/agent-platform/integrations/helpers'
import { appTurn } from './appToolsFixture'

// PR 4 unit 4h: a turn of a runtime Mousse sends the user's MCP tools (Pi's agent) calls them by the
// name it was offered. The real `McpManager` keeps a tool's name across listings, but a call still
// resolves from what the turn was offered, never from a new listing (a server may drop the tool).

function setup() {
  const store = settingsStore((settings) => {
    settings.integrations.mcp.enabled = true
    settings.integrations.mcp.enableForMainAgent = true
    settings.integrations.mcp.enabledServers = ['inst-echo']
  })
  const manager = new McpManager({ discover: async () => ({ servers: [testServerConfig()], sources: [], diagnostics: [] }) } as never, store as never, async () => {}, { clientFactory: injectedFactory() })
  const turns = new AppToolTurns()
  const registry = new ToolRegistry({ activeRunId: () => 'r1', turns, userMcp: userMcpProxy(manager) })
  turns.register(appTurn({ threadId: 't1', runId: 'r1', turnToken: 'tt' }))
  const call = (name: string) => registry.call(name, { text: 'hi', [TURN_TOKEN_KEY]: 'tt' }, {
    credential: { threadId: 't1', runId: 'r1', provider: 'pi', modeCeiling: 'default', binding: 'per_call', current: () => true },
    toolCallId: 'mcp:c1',
    signal: new AbortController().signal
  })
  return { registry, call }
}

describe('user MCP tools through the registry (real McpManager)', () => {
  it('a chat turn calls the tool by the name it was offered, also after the tools were listed again', async () => {
    const { registry, call } = setup()
    const offered = await registry.userMcpListingForTurn('t1', 'r1')
    expect(offered).toHaveLength(1)
    // Another listing (another runtime's, or the same turn's) must not move the offered name.
    await registry.userMcpListingForTurn('t1', 'r1')
    const outcome = await call(offered[0]!.name)
    expect(outcome.isError).toBeFalsy()
    expect(outcome.text).toBe('ok')
  })

  it('a name the turn was never offered is unknown', async () => {
    const { registry, call } = setup()
    await registry.userMcpListingForTurn('t1', 'r1')
    await expect(call('mcp__echo__other')).rejects.toMatchObject({ code: 'mousse_unknown_tool' })
  })
})
