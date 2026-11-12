/**
 * Issue #358: Claude Code gets a turn's MCP servers over its input (`setMcpServers`), never on its command line.
 * `registerClaudeMcpServers` decides what a failure means: Mousse's own server must connect or the turn fails with a
 * clear error; a user server that does not is left out with a warning; only server names are ever logged.
 */
import type { McpSetServersResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeMcpRegistrationMs, dropMousseServers, promptAfter, registerClaudeMcpServers, type ClaudeMcpServers } from '../src/mms/harness/vendors/claude/mcpRegistration'

const SECRET = 'mousse-token-358'
const servers: ClaudeMcpServers = {
  web: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Api-Key': 'user-secret-358' } },
  mousse: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
  'mousse-relay': { type: 'http', url: 'http://127.0.0.1:9/mcp/relay', headers: { Authorization: `Bearer ${SECRET}` } }
}
/** A process whose `setMcpServers` answers `answer` (or what `answer` returns for the servers). */
const process = (answer: McpSetServersResult | ((sent: ClaudeMcpServers) => Promise<McpSetServersResult>)) => {
  const sent: ClaudeMcpServers[] = []
  return {
    sent,
    setMcpServers: vi.fn(async (servers: ClaudeMcpServers) => {
      sent.push(servers)
      return typeof answer === 'function' ? answer(servers) : answer
    })
  }
}
const added = (names: string[], errors: Record<string, string> = {}): McpSetServersResult => ({ added: names, removed: [], errors })
const warned = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('registering a turn\'s MCP servers over Claude Code\'s input (#358)', () => {
  it('sends the whole set at once and is done when every server connected', async () => {
    const warn = warned()
    const target = process(added(Object.keys(servers)))
    await registerClaudeMcpServers(target, servers, { timeoutMs: 1_000, threadId: 't' })
    expect(target.sent).toEqual([servers])
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails the turn with a clear error when Mousse\'s server does not connect, and logs server names only', async () => {
    const warn = warned()
    const failing = process(added(Object.keys(servers), { mousse: `401 for Authorization: Bearer ${SECRET}` }))
    await expect(registerClaudeMcpServers(failing, servers, { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'claude_mcp_unavailable',
      message: 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start. Claude Code could not connect to Mousse\'s MCP server; try again.'
    })
    // Left out without an error (a policy that denies it): missing all the same.
    await expect(registerClaudeMcpServers(process(added(['web'])), servers, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'claude_mcp_unavailable' })
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('MCP server \\"mousse\\" could not be attached')
    expect(logged).not.toMatch(/mousse-token-358|user-secret-358|401/)
  })

  it('leaves a user server that does not connect out with a warning by name, and the turn goes on', async () => {
    const warn = warned()
    await registerClaudeMcpServers(process(added(Object.keys(servers), { web: 'refused: X-Api-Key user-secret-358', 'mousse-relay': 'down' })), servers, { timeoutMs: 1_000 })
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('MCP server \\"web\\" could not be attached')
    expect(logged).toContain('MCP server \\"mousse-relay\\" could not be attached')
    expect(logged).not.toMatch(/user-secret-358|refused|down/)
  })

  it('a Claude Code that cannot take servers, or does not answer in time: the turn fails when Mousse\'s server was among them', async () => {
    const warn = warned()
    const old = process(async () => { throw new Error(`unknown control request mcp_set_servers with Bearer ${SECRET}`) })
    await expect(registerClaudeMcpServers(old, servers, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'claude_mcp_unavailable', message: expect.stringContaining('update Claude Code') })
    // Only the user's: they are left out, and the turn runs.
    await registerClaudeMcpServers(old, { web: servers.web! }, { timeoutMs: 1_000 })
    vi.useFakeTimers()
    const silent = process(() => new Promise<never>(() => undefined))
    const waiting = registerClaudeMcpServers(silent, servers, { timeoutMs: 5_000 })
    const settled = expect(waiting).rejects.toMatchObject({ code: 'claude_mcp_unavailable' })
    await vi.advanceTimersByTimeAsync(5_000)
    await settled
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('took none of the turn\'s MCP servers')
    expect(logged).not.toMatch(/mousse-token-358|unknown control request/)
  })

  it('a Stop ends the wait with the turn\'s own reason, and nothing is logged', async () => {
    const warn = warned()
    const stop = new AbortController()
    const waiting = registerClaudeMcpServers(process(() => new Promise<never>(() => undefined)), servers, { timeoutMs: 60_000, signal: stop.signal })
    const reason = new Error('stopped by the user')
    stop.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    await expect(registerClaudeMcpServers(process(added([])), servers, { timeoutMs: 1_000, signal: stop.signal })).rejects.toBe(reason)
    expect(warn).not.toHaveBeenCalled()
  })

  it('takes Mousse\'s servers off and keeps the others, so a retry connects them anew', async () => {
    const target = process(added([]))
    await dropMousseServers(target, servers, { timeoutMs: 1_000 })
    expect(target.sent).toEqual([{ web: servers.web }])
    await dropMousseServers(target, { mousse: servers.mousse! }, { timeoutMs: 1_000 })
    expect(target.sent[1]).toEqual({})
  })

  it('waits as long as Claude Code\'s own connect timeout allows, and a margin', () => {
    expect(claudeMcpRegistrationMs({})).toBe(60_000)
    expect(claudeMcpRegistrationMs({ MCP_TIMEOUT: '120000' })).toBe(150_000)
    expect(claudeMcpRegistrationMs({ MCP_TIMEOUT: 'soon' })).toBe(60_000)
  })

  it('holds a prompt until its servers are registered, and ends it with nothing sent when they were not', async () => {
    const message = { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage
    const source = async function* () { yield message }
    let open!: () => void
    const read: SDKUserMessage[] = []
    const reading = (async () => { for await (const item of promptAfter(new Promise<void>((resolve) => { open = resolve }), source())) read.push(item) })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(read).toEqual([])
    open()
    await reading
    expect(read).toEqual([message])
    const refused = Promise.reject(new Error('no'))
    refused.catch(() => undefined)
    const none: SDKUserMessage[] = []
    for await (const item of promptAfter(refused, source())) none.push(item)
    expect(none).toEqual([])
  })
})
