/**
 * Issue #358: Claude Code gets a turn's MCP servers over its input (`setMcpServers`) or through a pipe it reads at its
 * start, never on its command line or in its environment. `registerClaudeMcpServers` decides what a failure means:
 * Mousse's own server must connect or the turn fails with an error that names the cause; a user server that does not
 * is left out and named; only server names are ever logged.
 */
import type { McpSetServersResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_MCP_STARTUP_WAIT_MS, claudeMcpLeftOut, claudeMcpLeftOutText, claudeMcpRegistrationMs, claudeStartupMcpOptions, dropMousseServers, promptAfter,
  registerClaudeMcpServers, registerUserServersLater, type ClaudeMcpServers
} from '../src/mms/harness/vendors/claude/mcpRegistration'

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

  it('a request that fails names its cause: "update Claude Code" only when Claude Code lacks the request', async () => {
    const warn = warned()
    const old = process(async () => { throw new Error('Unsupported control request subtype: mcp_set_servers') })
    await expect(registerClaudeMcpServers(old, servers, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'claude_mcp_unavailable', message: expect.stringContaining('update Claude Code') })
    await expect(registerClaudeMcpServers({}, servers, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'claude_mcp_unavailable', message: expect.stringContaining('update Claude Code') })
    const ended = process(async () => { throw new Error(`write after end, Bearer ${SECRET}`) })
    await expect(registerClaudeMcpServers(ended, servers, { timeoutMs: 1_000 })).rejects.toMatchObject({ message: 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start. Claude Code ended before Mousse\'s MCP server was attached; try again.' })
    vi.useFakeTimers()
    const silent = process(() => new Promise<never>(() => undefined))
    const waiting = registerClaudeMcpServers(silent, servers, { timeoutMs: 60_000 })
    const settled = expect(waiting).rejects.toMatchObject({ message: 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start. Claude Code did not answer within 60 s while it connected to Mousse\'s MCP server; try again.' })
    await vi.advanceTimersByTimeAsync(60_000)
    await settled
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('took none of these MCP servers')
    expect(logged).not.toMatch(/mousse-token-358|write after end/)
  })

  it('without Mousse\'s server in the set, a failed request leaves the user\'s servers out by name, and the turn goes on', async () => {
    const warn = warned()
    const old = process(async () => { throw new Error('Unsupported control request subtype: mcp_set_servers') })
    await expect(registerClaudeMcpServers(old, { web: servers.web! }, { timeoutMs: 1_000 })).resolves.toEqual({ failed: ['web'] })
    expect(JSON.stringify(warn.mock.calls)).toContain('"servers":["web"]')
    // A user server that failed is returned for the thread's warning; Mousse's own are not the user's.
    await expect(registerClaudeMcpServers(process(added(Object.keys(servers), { web: 'down', 'mousse-relay': 'down' })), servers, { timeoutMs: 1_000 })).resolves.toEqual({ failed: ['web'] })
  })

  it('registers the user\'s servers later without waiting, Mousse\'s sent again unchanged, and reports the ones that failed', async () => {
    warned()
    let answer!: (result: McpSetServersResult) => void
    const target = process(() => new Promise((resolve) => { answer = resolve }))
    const done = vi.fn()
    const mousse = { mousse: servers.mousse! }
    const sent = registerUserServersLater(target, mousse, { web: servers.web! }, 't', done)
    expect(sent).toEqual({ web: servers.web, mousse: servers.mousse })
    expect(target.sent).toEqual([sent])
    expect(done).not.toHaveBeenCalled()
    answer(added(['web'], { web: 'timed out' }))
    await vi.waitFor(() => expect(done).toHaveBeenCalledExactlyOnceWith(['web']))
  })

  it('gives the user\'s servers through a pipe Claude Code reads at its start, never on its command line or in its environment', async () => {
    const options = { env: { PATH: '/bin' }, extraArgs: { 'thinking-display': 'summarized' } }
    const user: ClaudeMcpServers = { web: servers.web!, files: { type: 'stdio', command: 'files-mcp', env: { KEY: 'user-env-secret-358' } } }
    const onSpawned = vi.fn()
    const piped = claudeStartupMcpOptions(options, user, onSpawned, { platform: 'linux' })!
    expect(piped.extraArgs).toEqual({ 'thinking-display': 'summarized', 'mcp-config': '/dev/fd/3' })
    expect(piped.env).toEqual({ PATH: '/bin', CLAUDE_CODE_MCP_STARTUP_WAIT_MS: String(CLAUDE_MCP_STARTUP_WAIT_MS) })
    // The user's own wait is kept.
    expect(claudeStartupMcpOptions({ env: { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0' } }, user, onSpawned, { platform: 'linux' })!.env).toEqual({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0' })
    // A real process reads the pipe; its command line and environment hold nothing of the servers.
    const child = piped.spawnClaudeCodeProcess!({ command: globalThis.process.execPath, args: ['-e', 'process.stdout.write(require("fs").readFileSync("/dev/fd/3"))'], env: { PATH: globalThis.process.env.PATH }, signal: new AbortController().signal }) as unknown as { stdout: NodeJS.ReadableStream; pid: number }
    let text = ''
    for await (const chunk of child.stdout) text += String(chunk)
    expect(JSON.parse(text)).toEqual({ mcpServers: user })
    expect(onSpawned).toHaveBeenCalledExactlyOnceWith(child.pid)
    expect(JSON.stringify({ args: piped.extraArgs, env: piped.env })).not.toMatch(/user-secret-358|user-env-secret-358/)
    // Not where the pipe cannot be used.
    expect(claudeStartupMcpOptions(options, user, onSpawned, { platform: 'win32' })).toBeUndefined()
    expect(claudeStartupMcpOptions({ extraArgs: { 'mcp-config': 'mine.json' } }, user, onSpawned, { platform: 'linux' })).toBeUndefined()
  })

  it('reads the user\'s servers a turn started without from Claude Code\'s init frame, and says them by name', () => {
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'web', status: 'pending' }, { name: 'files', status: 'failed' }, { name: 'gh', status: 'needs-auth' }, { name: 'ok', status: 'connected' }, { name: 'mousse', status: 'failed' }] } as unknown as SDKMessage
    const left = claudeMcpLeftOut(init, new Set(['web', 'files', 'gh', 'ok']))
    expect(left).toEqual([{ name: 'web', state: 'starting' }, { name: 'files', state: 'failed' }, { name: 'gh', state: 'needs-auth' }])
    expect(claudeMcpLeftOutText(left!)).toBe('Claude started this turn without some MCP servers: web (still starting; its tools come in a later turn); files (could not connect); gh (needs you to sign in).')
    expect(claudeMcpLeftOut({ type: 'assistant' } as unknown as SDKMessage, new Set(['web']))).toBeUndefined()
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
