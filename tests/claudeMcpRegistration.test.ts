/**
 * Issue #358: Claude Code gets a turn's MCP servers over its input (`setMcpServers`) or through a pipe it reads at its
 * start, never on its command line or in its environment. `registerClaudeMcpServers` decides what a failure means:
 * Mousse's own server must connect or the turn fails with an error that names the cause; a user server that does not
 * is left out and named; only server names are ever logged.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpSetServersResult, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_MCP_POLICY_CODE, CLAUDE_MCP_STARTUP_WAIT_MS, claudeInputMcpEnv, claudeLiteralServers, claudeMcpLeftOut, claudeMcpLeftOutText, claudeMcpPolicyForbidsAdded, claudeMcpPolicyText,
  claudeMcpRegistrationMs, claudeMcpStrings, claudeStartupChannel, claudeStartupMcpOptions, ClaudeStderrTail, dropMousseServers, promptAfter, redactClaudeOutput,
  registerClaudeMcpServers, registerUserServersLater, withoutLiteralDollar, type ClaudeMcpServers
} from '../src/mms/harness/vendors/claude/mcpRegistration'

const POSIX = globalThis.process.platform !== 'win32'
/** Where Mousse makes named pipes: a POSIX system with `mkfifo`. */
const FIFO = POSIX && !spawnSync('mkfifo', [], { stdio: 'ignore' }).error
const NO_FIFO = FIFO ? '' : ' [skipped: no mkfifo on this system, so no named pipe is made]'

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
    await expect(registerClaudeMcpServers(ended, servers, { timeoutMs: 1_000 })).rejects.toMatchObject({ message: 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start. Claude Code ended before Mousse\'s MCP server was attached, without saying why; try again.' })
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

  /** Runs a real process through `options`' spawn that prints what it reads at `path`, and returns that and its pid. */
  async function readThrough(options: Options, path: string, extra = ''): Promise<{ text: string; pid: number }> {
    const child = options.spawnClaudeCodeProcess!({ command: globalThis.process.execPath, args: ['-e', `${extra}process.stdout.write(require("fs").readFileSync(${JSON.stringify(path)}))`], env: { PATH: globalThis.process.env.PATH }, signal: new AbortController().signal }) as unknown as { stdout: NodeJS.ReadableStream; pid: number }
    let text = ''
    for await (const chunk of child.stdout) text += String(chunk)
    return { text, pid: child.pid }
  }

  it.skipIf(POSIX === false)('gives the user\'s servers through a channel Claude Code reads at its start, never on its command line or in its environment', async () => {
    const options = { env: { PATH: '/bin' }, extraArgs: { 'thinking-display': 'summarized' } }
    const user: ClaudeMcpServers = { web: servers.web!, files: { type: 'stdio', command: 'files-mcp', env: { KEY: 'user-env-secret-358' } } }
    const onSpawned = vi.fn()
    // macOS: the process's fourth stream, a socket it opens by `/dev/fd/3`.
    const piped = (await claudeStartupMcpOptions(options, user, onSpawned, { platform: 'darwin' }))!
    expect(piped.extraArgs).toEqual({ 'thinking-display': 'summarized', 'mcp-config': '/dev/fd/3' })
    expect(piped.env).toEqual({ PATH: '/bin', CLAUDE_CODE_MCP_STARTUP_WAIT_MS: String(CLAUDE_MCP_STARTUP_WAIT_MS) })
    // The user's own wait is kept.
    expect((await claudeStartupMcpOptions({ env: { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0' } }, user, onSpawned, { platform: 'darwin' }))!.env).toEqual({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0' })
    if (globalThis.process.platform === 'darwin') {
      const { text, pid } = await readThrough(piped, '/dev/fd/3')
      expect(JSON.parse(text)).toEqual({ mcpServers: user })
      expect(onSpawned).toHaveBeenCalledWith(pid)
    }
    expect(JSON.stringify({ args: piped.extraArgs, env: piped.env })).not.toMatch(/user-secret-358|user-env-secret-358/)
    // Elsewhere: a named pipe in a folder of its own, gone once read.
    const root = mkdtempSync(join(tmpdir(), 'mousse-fifo-test-'))
    try {
      const fifo = (await claudeStartupMcpOptions(options, user, onSpawned, { platform: 'linux', fifoRoot: root }))!
      const path = String(fifo.extraArgs!['mcp-config'])
      expect(path.startsWith(root)).toBe(true)
      // Made as the process is spawned, not before; the process sees it before it reads it.
      expect(readdirSync(root)).toEqual([])
      const seen = `const s = require("fs").statSync, p = ${JSON.stringify(path)}; process.stdout.write(JSON.stringify({ fifo: s(p).isFIFO(), mode: s(p).mode & 0o777, dir: s(require("path").dirname(p)).mode & 0o777 }) + "\\n");`
      const { text } = await readThrough(fifo, path, seen)
      const line = text.indexOf('\n')
      expect(JSON.parse(text.slice(0, line))).toEqual({ fifo: true, mode: 0o600, dir: 0o700 })
      expect(JSON.parse(text.slice(line + 1))).toEqual({ mcpServers: user })
      expect(existsSync(path)).toBe(false)
      expect(readdirSync(root)).toEqual([])
      expect(JSON.stringify({ args: fifo.extraArgs, env: fifo.env })).not.toMatch(/user-secret-358|user-env-secret-358/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    // Not where no channel can be used.
    expect(await claudeStartupMcpOptions(options, user, onSpawned, { platform: 'win32' })).toBeUndefined()
    expect(await claudeStartupMcpOptions({ extraArgs: { 'mcp-config': 'mine.json' } }, user, onSpawned, { platform: 'linux' })).toBeUndefined()
    expect(claudeStartupChannel('linux')).toBe('fifo')
    expect(claudeStartupChannel('darwin')).toBe('descriptor')
  })

  it.skipIf(POSIX === false)('a config far larger than a socket or pipe buffer arrives whole, on either channel', async () => {
    // About 600 KB: 300 servers with a 2 KB header each.
    const many: ClaudeMcpServers = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`s${index}`, { type: 'http', url: `http://127.0.0.1:9/${index}`, headers: { 'X-Api-Key': `${index}-`.padEnd(2048, 'k') } }]))
    expect(JSON.stringify(many).length).toBeGreaterThan(600_000)
    const root = mkdtempSync(join(tmpdir(), 'mousse-fifo-test-'))
    try {
      const fifo = (await claudeStartupMcpOptions({}, many, () => undefined, { channel: 'fifo', fifoRoot: root }))!
      // A slow reader: it starts reading a moment after it opened the pipe.
      expect(JSON.parse((await readThrough(fifo, String(fifo.extraArgs!['mcp-config']))).text)).toEqual({ mcpServers: many })
      if (globalThis.process.platform === 'darwin') {
        const socket = (await claudeStartupMcpOptions({}, many, () => undefined, { channel: 'descriptor' }))!
        expect(JSON.parse((await readThrough(socket, '/dev/fd/3')).text)).toEqual({ mcpServers: many })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(POSIX === false)('a named pipe nobody opens is removed when the process ends, and one opened by another reader first is gone for everyone after', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-fifo-test-'))
    try {
      const fifo = (await claudeStartupMcpOptions({}, { web: servers.web! }, () => undefined, { channel: 'fifo', fifoRoot: root }))!
      const path = String(fifo.extraArgs!['mcp-config'])
      // A process that exits without reading: the pipe and its folder go with it.
      const child = fifo.spawnClaudeCodeProcess!({ command: globalThis.process.execPath, args: ['-e', ''], env: { PATH: globalThis.process.env.PATH }, signal: new AbortController().signal }) as unknown as { once(event: string, listener: () => void): void }
      await new Promise<void>((resolve) => child.once('exit', resolve))
      expect(existsSync(path)).toBe(false)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!FIFO)(`a start prepared but never spawned, or whose spawn fails, leaves nothing in the temporary folder${NO_FIFO}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-fifo-test-'))
    try {
      // Abandoned before Claude Code is spawned.
      const prepared = (await claudeStartupMcpOptions({}, { web: servers.web! }, () => undefined, { channel: 'fifo', fifoRoot: root }))!
      expect(String(prepared.extraArgs!['mcp-config'])).toMatch(/\/mousse-mcp-[^/]+\/servers$/)
      expect(readdirSync(root)).toEqual([])
      // A spawn that throws: the pipe made for it goes too.
      const failing = (await claudeStartupMcpOptions({}, { web: servers.web! }, () => undefined, { channel: 'fifo', fifoRoot: root, spawn: (() => { throw new Error('spawn failed') }) as never }))!
      expect(() => failing.spawnClaudeCodeProcess!({ command: 'claude', args: [], env: {}, signal: new AbortController().signal })).toThrow('spawn failed')
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(POSIX === false)('reads the process\'s error stream to the end, so one that writes a lot of it does not stall, and keeps its redacted end', async () => {
    const tail = new ClaudeStderrTail(() => ['user-secret-358'])
    const started = (await claudeStartupMcpOptions({}, { web: servers.web! }, () => undefined, { channel: globalThis.process.platform === 'darwin' ? 'descriptor' : 'fifo', onStderr: tail }))!
    // 4 MB to its error stream (an unread pipe holds 64 KB), then the secret, then what it read.
    const path = String(started.extraArgs!['mcp-config'])
    const { text } = await readThrough(started, path, 'const b = Buffer.alloc(65536, 120); for (let i = 0; i < 64; i++) require("fs").writeSync(2, b); require("fs").writeSync(2, "\\nfailed for X-Api-Key: user-secret-358 and Authorization: Bearer abc\\n");')
    expect(JSON.parse(text)).toEqual({ mcpServers: { web: servers.web } })
    const said = await tail.said()
    expect(said).toMatch(/failed for X-Api-Key\S* ?\[redacted\] and Authorization: \[redacted\]$/)
    expect(said).not.toMatch(/user-secret-358|abc/)
    expect(said.length).toBeLessThanOrEqual(601)
  })

  it('names why a start failed from what Claude Code wrote: its policy, servers it could not read, or what it said', async () => {
    warned()
    const ended = () => process(async () => { throw new Error('ProcessTransport is not ready for writing') })
    const explain = (said: string) => ({ timeoutMs: 1_000, explain: async () => said })
    await expect(registerClaudeMcpServers(ended(), servers, explain('Error: --mcp-config is not allowed on this machine. Ask your administrator to remove disableSideloadFlags from managed settings'))).rejects.toMatchObject({ code: CLAUDE_MCP_POLICY_CODE })
    await expect(registerClaudeMcpServers(ended(), servers, explain('You cannot dynamically configure MCP servers when an enterprise MCP config is present'))).rejects.toMatchObject({ code: CLAUDE_MCP_POLICY_CODE })
    await expect(registerClaudeMcpServers(ended(), servers, explain('Error: Invalid MCP configuration: MCP config file not found: /tmp/x'))).rejects.toMatchObject({
      code: 'claude_mcp_unavailable',
      message: 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start. Claude Code could not read the MCP servers Mousse gave it at its start, and ended. Claude Code said: Error: Invalid MCP configuration: MCP config file not found: /tmp/x'
    })
    await expect(registerClaudeMcpServers(ended(), servers, explain('out of memory'))).rejects.toMatchObject({ message: expect.stringContaining('Claude Code ended before Mousse\'s MCP server was attached. Claude Code said: out of memory') })
    expect(claudeMcpPolicyText(['web', 'files'])).toBe('This computer\'s Claude Code policy does not allow added MCP servers, so Claude started without your servers: web, files. Mousse\'s own tools are attached.')
  })

  it('removes every known value, and anything that looks like a credential or a header value, from what Claude Code wrote', () => {
    const text = 'connect failed {"headers":{"X-Api-Key":"user-secret-358"}} env KEY=user-env-358 Authorization: Bearer sk-abc token=t0k3n sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const out = redactClaudeOutput(text, ['user-env-358', 'user-secret-358', ...claudeMcpStrings(servers)])
    expect(out).not.toMatch(/user-secret-358|user-env-358|sk-abc|t0k3n|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/)
    expect(out).toContain('connect failed')
    expect(claudeMcpStrings(servers)).toEqual(expect.arrayContaining(['user-secret-358', `Bearer ${SECRET}`, 'https://example.test/mcp']))
  })

  it('sends `${` so Claude Code\'s expansions give it back as it is: once for each time Claude Code expands that field on that path', () => {
    const user: ClaudeMcpServers = {
      web: { type: 'http', url: 'https://x.test/${A}', headers: { 'X-Key': 'k-${ANTHROPIC_API_KEY}-${HOME:-x}', Plain: 'no-dollar' } },
      files: { type: 'stdio', command: '/bin/${B}', args: ['${C}', 'plain'], env: { V: '$${D}' } },
      inproc: { type: 'sdk', name: 'inproc' } as unknown as ClaudeMcpServers[string]
    }
    const E = '${MOUSSE_LITERAL_DOLLAR:-$}{'
    // Claude Code's own expansion: `${NAME}` and `${NAME:-default}`, once over the text, against an environment
    // without the variable (`withoutLiteralDollar`).
    const expand = (text: string) => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, _name: string, fallback?: string) => fallback ?? '')
    const startup = claudeLiteralServers(user, 'startup') as Record<string, Record<string, unknown>>
    expect(startup.web!.url).toBe(`https://x.test/${E}A}`)
    expect(expand(String(startup.web!.url))).toBe('https://x.test/${A}')
    const header = (startup.web!.headers as Record<string, string>)['X-Key']!
    expect(expand(expand(header))).toBe('k-${ANTHROPIC_API_KEY}-${HOME:-x}')
    expect((startup.web!.headers as Record<string, string>).Plain).toBe('no-dollar')
    expect(expand(String(startup.files!.command))).toBe('/bin/${B}')
    expect((startup.files!.args as string[]).map(expand)).toEqual(['${C}', 'plain'])
    expect(expand((startup.files!.env as Record<string, string>).V!)).toBe('$${D}')
    expect(startup.inproc).toBe(user.inproc)
    const input = claudeLiteralServers(user, 'input') as Record<string, Record<string, unknown>>
    expect(input.web!.url).toBe('https://x.test/${A}')
    expect(expand((input.web!.headers as Record<string, string>)['X-Key']!)).toBe('k-${ANTHROPIC_API_KEY}-${HOME:-x}')
    expect(input.files).toEqual(user.files)
    expect(withoutLiteralDollar({ A: '1', MOUSSE_LITERAL_DOLLAR: 'x' })).toEqual({ A: '1' })
  })

  it('sees a policy that forbids added servers in the managed settings, their drop-in folder, managed-mcp.json or the cached server settings', () => {
    const managedDir = mkdtempSync(join(tmpdir(), 'mousse-managed-test-'))
    const home = mkdtempSync(join(tmpdir(), 'mousse-claude-home-test-'))
    try {
      expect(claudeMcpPolicyForbidsAdded(home, { managedDir })).toBe(false)
      writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify({ disableSideloadFlags: false }))
      expect(claudeMcpPolicyForbidsAdded(home, { managedDir })).toBe(false)
      mkdirSync(join(managedDir, 'managed-settings.d'))
      writeFileSync(join(managedDir, 'managed-settings.d', '10-lock.json'), JSON.stringify({ disableSideloadFlags: true }))
      expect(claudeMcpPolicyForbidsAdded(home, { managedDir })).toBe(true)
      rmSync(join(managedDir, 'managed-settings.d'), { recursive: true })
      writeFileSync(join(home, 'remote-settings.json'), JSON.stringify({ disableSideloadFlags: true }))
      expect(claudeMcpPolicyForbidsAdded(home, { managedDir })).toBe(true)
      rmSync(join(home, 'remote-settings.json'))
      writeFileSync(join(managedDir, 'managed-mcp.json'), JSON.stringify({ mcpServers: {} }))
      expect(claudeMcpPolicyForbidsAdded(undefined, { managedDir })).toBe(true)
    } finally {
      rmSync(managedDir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('bounds how long the user\'s servers given over Claude Code\'s input can hold its first prompt, unless the user set it', () => {
    expect(claudeInputMcpEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', MCP_TIMEOUT: '10000', MCP_SERVER_CONNECTION_BATCH_SIZE: '16' })
    expect(claudeInputMcpEnv({ MCP_TIMEOUT: '60000' })).toEqual({ MCP_TIMEOUT: '60000', MCP_SERVER_CONNECTION_BATCH_SIZE: '16' })
  })

  it('reads the user\'s servers a turn started without from Claude Code\'s init frame, and says them by name', () => {
    const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'web', status: 'pending' }, { name: 'files', status: 'failed' }, { name: 'gh', status: 'needs-auth' }, { name: 'ok', status: 'connected' }, { name: 'mousse', status: 'failed' }] } as unknown as SDKMessage
    const left = claudeMcpLeftOut(init, new Set(['web', 'files', 'gh', 'ok']))
    expect(left).toEqual([{ name: 'web', state: 'starting' }, { name: 'files', state: 'failed' }, { name: 'gh', state: 'needs-auth' }])
    expect(claudeMcpLeftOutText(left!)).toBe('Claude started this turn without some MCP servers: web (still starting; it is offered once it has connected); files (could not connect); gh (needs you to sign in).')
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
