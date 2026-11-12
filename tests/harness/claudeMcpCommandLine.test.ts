/**
 * Issue #358, real CLI: no MCP credential is on Claude Code's command line, in its environment, in what a command it
 * runs can read, in its debug log or in the files it leaves in its home and the working folder, for a person's turn
 * (live, one-shot, restarted by a steer, resumed) and for a bot's. Mousse's own server is registered over Claude Code's
 * input and waited for; the user's servers go through a pipe it reads at its start, so a turn never waits for a slow
 * one. Turns go through Mousse's own service and the Agent SDK to this platform's binary of the pinned SDK (or
 * `MOUSSE_CLAUDE_EVIDENCE_BINARY`), against a localhost Messages API mock with a fake key and a localhost MCP server;
 * every value is fake and nothing leaves the machine.
 *
 * Where each check runs: everything runs on Linux and macOS. What Claude Code is started with is read at the SDK's
 * spawn seam on every platform, and from the running process as another local process reads it on Linux
 * (`/proc/<pid>/cmdline`, `environ`) and macOS (`ps`). Windows runs none of the startup-pipe checks (Windows registers
 * the user's servers over the input instead) and not the command a bot runs. Without the platform's binary every test
 * is skipped, with the reason in its name.
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Options, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { lockedEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'

const PACKAGE = join(process.cwd(), 'node_modules', '@anthropic-ai')
const EXECUTABLE = process.platform === 'win32' ? 'claude.exe' : 'claude'
const BINARY = process.env.MOUSSE_CLAUDE_EVIDENCE_BINARY
  || [`claude-agent-sdk-${process.platform}-${process.arch}`, `claude-agent-sdk-${process.platform}-${process.arch}-musl`]
    .map((name) => join(PACKAGE, name, EXECUTABLE)).find((path) => existsSync(path))
  || join(PACKAGE, `claude-agent-sdk-${process.platform}-${process.arch}`, EXECUTABLE)
const hasBinary = existsSync(BINARY)
/** Said in every test's name when it is skipped, so a missing binary never passes as a run. */
const NO_BINARY = hasBinary ? '' : ` [skipped: no Claude Code binary at ${BINARY}; install the SDK's platform package or set MOUSSE_CLAUDE_EVIDENCE_BINARY]`
const POSIX = process.platform !== 'win32'

const TOKEN = 'fake-mousse-token-358-first-aaaaaaaaaaaa'
const TOKEN_2 = 'fake-mousse-token-358-second-bbbbbbbbbbb'
/** A bearer Mousse's mock server refuses: Claude Code cannot connect to it. */
const TOKEN_REFUSED = 'fake-mousse-token-358-refused-eeeeeeeeee'
/** A bearer Mousse's mock server never answers: Claude Code stays busy connecting to it. */
const TOKEN_UNANSWERED = 'fake-mousse-token-358-unanswered-ffffff'
const USER_HEADER = 'fake-user-header-358-cccccccccccccccc'
const USER_ENV = 'fake-user-env-358-dddddddddddddddddd'
/** What must never be on the command line, in the environment, in a file left behind, or in what a command prints. */
const SECRETS = [TOKEN, TOKEN_2, TOKEN_REFUSED, TOKEN_UNANSWERED, USER_HEADER, USER_ENV]
const MARKERS = [...SECRETS, 'MOUSSE_MCP_VALUE', 'Bearer ']
const found = (text: string) => MARKERS.filter((marker) => text.includes(marker))

type Json = Record<string, unknown>
/** A command that prints its environment and the command line of its parent (Claude Code). No loop or variable. */
const PRINT_ENV = { name: 'Bash', input: { command: 'env; echo ---; ps -ww -o args= -p $PPID', description: 'Print the environment' } }

/** The Messages API: a prompt naming `PLAN:<name>` runs that plan's tool calls, one per request, then says "done". */
async function anthropicMock(plans: Record<string, Json[]>) {
  const sockets = new Set<Socket>()
  const requests: Array<{ plan?: string; tools: string[]; offered: string[]; results: string[] }> = []
  let ids = 0
  const textOf = (content: unknown): string => typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((block: Json) => block.type === 'text' ? String(block.text) : block.type === 'tool_result' ? textOf(block.content) : '').join('\n') : ''
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const path = (req.url ?? '').split('?')[0]
      if (path.endsWith('/count_tokens')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
      if (req.method !== 'POST' || path !== '/v1/messages') return void res.writeHead(404).end()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> }
      // The plan of the last prompt that names one, and the calls made since it.
      let at = -1
      let plan: string | undefined
      body.messages.forEach((message, index) => {
        const named = message.role === 'user' && Array.isArray(message.content) && (message.content as Json[]).some((block) => block.type === 'tool_result') ? undefined : /PLAN:([a-z]+)/.exec(textOf(message.content))?.[1]
        if (named) {
          at = index
          plan = named
        }
      })
      let calls = 0
      const results: string[] = []
      for (const message of body.messages.slice(at + 1))
        if (Array.isArray(message.content))
          for (const block of message.content as Json[]) {
            if (block.type === 'tool_use') calls += 1
            if (block.type === 'tool_result') results.push(textOf(block.content))
          }
      const tools = (body.tools ?? []).map((tool) => tool.name)
      // The MCP tools the model is offered in this request: in the tool list, or named to it as tools it can load
      // (Claude Code's tool search lists them in the turn's own prompt).
      const offered = [...new Set([...tools, ...JSON.stringify(body.messages.slice(at)).match(/mcp__[A-Za-z0-9_-]+/g) ?? []].filter((name) => name.startsWith('mcp__')))].sort()
      requests.push({ ...(plan ? { plan } : {}), tools, offered, results })
      const steps = plan ? plans[plan] ?? [] : []
      const block: Json = body.tools?.length && calls < steps.length ? { type: 'tool_use', id: `toolu_${++ids}`, ...steps[calls] } : { type: 'text', text: 'done' }
      const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
      const message = { id: `msg_${++ids}`, type: 'message', role: 'assistant', model: body.model, content: [] as Json[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
      if (!body.stream) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason }))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (event: string, data: Json) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      send('message_start', { message })
      if (block.type === 'tool_use') {
        send('content_block_start', { index: 0, content_block: { ...block, input: {} } })
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } })
      }
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } })
      send('message_stop', {})
      res.end()
    })().catch((error) => res.writeHead(500).end(String(error)))
  })
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    /** Every tool result Claude Code sent back, for the plan `name`. */
    results: (name: string) => requests.filter((request) => request.plan === name).flatMap((request) => request.results),
    close: async () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    }
  }
}

/**
 * MCP servers over Streamable HTTP (plain JSON answers): `/mcp` stands for Mousse's (a bearer of `TOKEN` or `TOKEN_2`;
 * `TOKEN_REFUSED` and any other is refused), `/user` for a user's (an `X-Api-Key` header). Mousse's lists the tools of the
 * access level its bearer stands for: `TOKEN`'s has `secret`, `TOKEN_2`'s has `gained` instead. Each call is recorded
 * with which credential it carried, never its value.
 */
async function mcpMock() {
  const sockets = new Set<Socket>()
  const calls: Array<{ path: string; method: string; credential: string; tool?: string }> = []
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const path = (req.url ?? '').split('?')[0]!
      const auth = String(req.headers.authorization ?? '')
      const credential = path === '/mcp'
        ? auth === `Bearer ${TOKEN}` ? 'first' : auth === `Bearer ${TOKEN_2}` ? 'second' : 'none'
        : path === '/user' ? (req.headers['x-api-key'] === USER_HEADER ? 'user' : 'none') : 'none'
      if (req.method !== 'POST') return void res.writeHead(405).end()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { name?: string; protocolVersion?: string } }
      calls.push({ path, method: body.method, credential, ...(body.params?.name ? { tool: body.params.name } : {}) })
      // The refused bearer is refused late, so what Claude Code starts meanwhile (the user's stdio servers) is running.
      if (auth === `Bearer ${TOKEN_REFUSED}`) await new Promise((resolve) => setTimeout(resolve, 2_000))
      // This one is never answered: Claude Code waits for it until its own connect timeout.
      if (auth === `Bearer ${TOKEN_UNANSWERED}`) return void await new Promise(() => undefined)
      if (credential === 'none') return void res.writeHead(401).end()
      if (body.id === undefined) return void res.writeHead(202).end()
      const reply = (result: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      const tool = (name: string) => ({ name, description: `${name} on ${path}`, inputSchema: { type: 'object', properties: {} } })
      if (body.method === 'initialize') return reply({ protocolVersion: body.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `fake${path.replace('/', '-')}`, version: '1.0.0' } })
      if (body.method === 'tools/list') return reply({ tools: path === '/mcp' ? [tool('ping'), tool(credential === 'second' ? 'gained' : 'secret')] : [tool('ping')] })
      if (body.method === 'tools/call') return reply({ content: [{ type: 'text', text: `pong from ${path}` }] })
      return reply({})
    })().catch((error) => res.writeHead(500).end(String(error)))
  })
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    calls,
    close: async () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    }
  }
}

/** A stdio MCP server whose one tool says whether it was started with the user's secret value (never the value). */
const STDIO_SERVER = `const rl = require('readline').createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' } } })
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'secret_seen', description: 'Says whether the server got its secret.', inputSchema: { type: 'object', properties: {} } }] } })
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'secret seen: ' + (process.env.USER_ENV_SECRET === ${JSON.stringify(USER_ENV)}) }] } })
  send({ jsonrpc: '2.0', id: msg.id, result: {} })
})`
/** A stdio MCP server that never answers and outlives its input: it writes its pid to the file it is given. */
const HUNG_SERVER = `require('fs').writeFileSync(process.argv[2], String(process.pid)); process.stdin.resume(); process.stdin.on('end', () => undefined); setInterval(() => undefined, 1000)`

/** What a Claude Code process was started with, at the SDK's spawn seam and as the running process shows it. */
interface Started {
  args: string[]
  env: Record<string, string | undefined>
  pid?: number
  /** The running process's command line and environment, as another local process reads them; none on Windows. */
  commandLine?: string
  environment?: string
}

function seenByOthers(pid: number | undefined): Pick<Started, 'commandLine' | 'environment'> {
  if (pid === undefined) return {}
  if (process.platform === 'linux')
    return { commandLine: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '), environment: readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n') }
  if (process.platform === 'darwin')
    return { commandLine: execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }), environment: execFileSync('ps', ['-Eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }) }
  return {}
}

/** Files under `dir` (followed into folders, at most 20 MB each) whose bytes hold a fake secret, by path. */
function secretsUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const hits: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && statSync(path).size <= 20 * 1024 * 1024) {
        const text = readFileSync(path, 'latin1')
        if (SECRETS.some((secret) => text.includes(secret))) hits.push(relative(dir, path))
      }
    }
  }
  walk(dir)
  return hits
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('MCP credentials are never on Claude Code\'s command line or in its environment (#358, real CLI)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  })

  async function rig(plans: Record<string, Json[]>, options: { locked?: boolean; oneShot?: boolean; debug?: boolean } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'mousse-claude-mcp-argv-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const dirs = { work: join(base, 'work'), files: join(base, 'files'), root: join(base, 'root'), scratch: join(base, 'scratch'), userHome: join(base, 'user-home'), instanceHome: join(base, 'instance-home'), pids: join(base, 'pids') }
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    mkdirSync(join(dirs.scratch, 'tmp'), { recursive: true })
    const stdioServer = join(base, 'stdio-server.cjs')
    writeFileSync(stdioServer, STDIO_SERVER)
    const hungServer = join(base, 'hung-server.cjs')
    writeFileSync(hungServer, HUNG_SERVER)
    const debugFile = join(base, 'claude-debug.log')
    const anthropic = await anthropicMock(plans)
    cleanups.push(() => anthropic.close())
    const mcp = await mcpMock()
    cleanups.push(() => mcp.close())
    const state = mkdtempSync(join(base, 'state-'))
    mkdirSync(join(state, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(state, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const started: Started[] = []
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const service = new ClaudeSubscriptionProviderService(state, new UserQuestionService(), {
      probe: () => ({ kind: 'signed_in', account: { label: 'API key', credential: 'api_key' } }),
      launchConfig: () => ({ binaryPath: BINARY }),
      baseEnv: () => ({ PATH: process.env.PATH, HOME: dirs.userHome, CLAUDE_CONFIG_DIR: dirs.instanceHome }),
      ...(options.locked
        ? { lockedEnv: (cwd: string) => lockedEnv({ platform: process.platform, base: { PATH: process.env.PATH, HOME: dirs.userHome }, driver: 'claude', credential: 'api_key', home: dirs.instanceHome, scratch: cwd }) }
        : {}),
      // Every live slot taken: each turn runs as one query, as a person's turn past the cap does.
      ...(options.oneShot ? { live: { maxSessions: 0 } } : {}),
      finalEnv: (env) => ({
        ...env,
        ANTHROPIC_BASE_URL: anthropic.url,
        ANTHROPIC_API_KEY: 'sk-ant-api03-fake-local',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_MAX_RETRIES: '0'
      }),
      // The real SDK, with the spawn seam read: Mousse's own spawn when it sets one (a locked entry, the startup pipe),
      // the SDK's way otherwise. With `debug`, Claude Code writes its debug log (`--debug-file`).
      query: ({ prompt, options: given }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => sdk.query({
        prompt,
        options: {
          ...given,
          ...(options.debug ? { debugFile } : {}),
          spawnClaudeCodeProcess: (spawned: SpawnOptions): SpawnedProcess => {
            const child = given.spawnClaudeCodeProcess
              ? given.spawnClaudeCodeProcess(spawned)
              : nodeSpawn(spawned.command, spawned.args, { cwd: spawned.cwd, env: spawned.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: spawned.signal, windowsHide: true }) as unknown as SpawnedProcess
            const pid = (child as { pid?: number }).pid
            started.push({ args: [...spawned.args], env: { ...spawned.env }, ...(pid !== undefined ? { pid } : {}), ...seenByOthers(pid) })
            return child
          }
        }
      })
    })
    cleanups.push(() => service.stop())
    const notices: string[] = []
    service.setLiveHost({ notice: (_threadId, text) => notices.push(text) })
    const rows: Array<{ name: string; status: string }> = []
    const ledger: ToolLedger = {
      start: (call) => {
        rows.push({ name: call.name, status: 'started' })
        return String(rows.length - 1)
      },
      commit: (id) => { rows[Number(id)]!.status = 'committed' },
      failed: (id) => { rows[Number(id)]!.status = 'failed' }
    }
    /** Every file Claude Code or the turn left where it could be read later: Claude's homes, the folders, the debug log. */
    const leftBehind = () => [dirs.instanceHome, dirs.userHome, dirs.work, dirs.files, dirs.scratch, state].flatMap(secretsUnder)
      .concat(existsSync(debugFile) && SECRETS.some((secret) => readFileSync(debugFile, 'utf8').includes(secret)) ? ['claude-debug.log'] : [])
    return { dirs, stdioServer, hungServer, debugFile, anthropic, mcp, service, started, ledger, rows, notices, state, leftBehind }
  }
  type Rig = Awaited<ReturnType<typeof rig>>

  /** The user's servers of a person's turn: an http one with a secret header, a stdio one with a secret environment value. */
  const userServers = (run: Rig) => ({
    mcpServers: {
      web: { type: 'http' as const, url: `${run.mcp.url}/user`, headers: { 'X-Api-Key': USER_HEADER } },
      files: { type: 'stdio' as const, command: process.execPath, args: [run.stdioServer], env: { USER_ENV_SECRET: USER_ENV } }
    },
    proxiedServers: {}, toolRules: {}, warnings: []
  })
  const personTurn = (run: Rig, prompt: string, token: string, extra: Partial<ClaudeSubscriptionChatInput> = {}) =>
    run.service.chat({ threadId: 'thread', cwd: run.dirs.work, model: 'claude-sonnet-4-5', prompt, permissionMode: 'full', history: '', mcp: { url: `${run.mcp.url}/mcp`, token }, integrations: userServers(run), onText: () => undefined, ...extra })

  /** Nothing of a credential where another process, or a command Claude runs, can read it. */
  const clean = (process: Started) => {
    expect(found(process.args.join('\n')), 'arguments at the spawn seam').toEqual([])
    // The command line names at most the pipe the user's servers come through, never a server.
    const config = process.args.indexOf('--mcp-config')
    if (config >= 0) expect(process.args[config + 1], 'the only --mcp-config is the startup pipe').toBe('/dev/fd/3')
    expect(process.args.filter((arg) => arg === '--mcp-config').length).toBeLessThanOrEqual(1)
    expect(found(Object.entries(process.env).map(([name, value]) => `${name}=${value}`).join('\n')), 'environment at the spawn seam').toEqual([])
    if (process.commandLine !== undefined) expect(found(process.commandLine), 'command line of the running process').toEqual([])
    if (process.environment !== undefined) expect(found(process.environment), 'environment of the running process').toEqual([])
  }

  it.skipIf(!hasBinary)(`a person's turn: the servers work, none is on the command line or in the environment, a command reads none, no file keeps one, and a new token reaches the running process${NO_BINARY}`, async () => {
    const plans = {
      first: [
        { name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping,mcp__web__ping,mcp__files__secret_seen', max_results: 5 } },
        { name: 'mcp__mousse__ping', input: {} },
        { name: 'mcp__web__ping', input: {} },
        { name: 'mcp__files__secret_seen', input: {} },
        PRINT_ENV
      ],
      second: [{ name: 'mcp__mousse__ping', input: {} }]
    }
    const run = await rig(plans)
    const turn = async (prompt: string, token: string) => {
      const text = await personTurn(run, prompt, token)
      run.service.commitConversation('thread', '')
      return text
    }
    expect(await turn('PLAN:first', TOKEN)).toContain('done')
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    // Each server was reached with its own credential: Claude Code had them, over its input or through the pipe.
    expect(run.mcp.calls).toEqual(expect.arrayContaining([
      { path: '/mcp', method: 'tools/call', credential: 'first', tool: 'ping' },
      { path: '/user', method: 'tools/call', credential: 'user', tool: 'ping' }
    ]))
    const results = run.anthropic.results('first').join('\n')
    expect(results).toContain('pong from /mcp')
    expect(results).toContain('secret seen: true')
    // The command saw Claude Code's own environment and command line: no credential in either.
    expect(results).toContain('CLAUDE_CONFIG_DIR=')
    expect(found(results)).toEqual([])

    // A new credential for the same tools (a failed turn's new epoch) goes to the same process, which uses it from then on.
    expect(await turn('PLAN:second', TOKEN_2)).toContain('done')
    expect(run.started).toHaveLength(1)
    expect(run.mcp.calls.filter((call) => call.path === '/mcp' && call.method === 'tools/call').map((call) => call.credential)).toEqual(['first', 'second'])
    // The user's server stayed connected: it was not started again for the new token.
    expect(run.mcp.calls.filter((call) => call.path === '/user' && call.method === 'initialize')).toHaveLength(1)
    expect(run.leftBehind()).toEqual([])
    expect(found(run.notices.join('\n'))).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)(`a token renewed on a running process: Claude Code reconnects with it, and the server's new tools are added but a tool it dropped is still offered${NO_BINARY}`, async () => {
    // Why a change of access level or policy needs a new process (the next test): on the same process, Mousse's server
    // listing other tools under the new token leaves the model offered one it no longer lists.
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }], second: [{ name: 'mcp__mousse__ping', input: {} }] })
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations: undefined })).toContain('done')
    run.service.commitConversation('thread', '')
    expect(await personTurn(run, 'PLAN:second', TOKEN_2, { integrations: undefined })).toContain('done')
    expect(run.started).toHaveLength(1)
    expect(run.mcp.calls.filter((call) => call.path === '/mcp' && call.method === 'tools/call').map((call) => call.credential)).toEqual(['first', 'second'])
    const second = run.anthropic.requests.filter((request) => request.plan === 'second')[0]!
    expect(second.offered).toEqual(expect.arrayContaining(['mcp__mousse__gained', 'mcp__mousse__secret']))
  }, 120_000)

  it.skipIf(!hasBinary)(`an access-level change starts a new process, so the model is offered exactly the new level's tools${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }], second: [{ name: 'mcp__mousse__ping', input: {} }] })
    const level = (prompt: string, token: string, tools: string) => personTurn(run, prompt, token, { integrations: undefined, mcp: { url: `${run.mcp.url}/mcp`, token, tools } })
    expect(await level('PLAN:first', TOKEN, 'access:read')).toContain('done')
    run.service.commitConversation('thread', '')
    expect(run.anthropic.requests.find((request) => request.plan === 'first')!.offered).toEqual(['mcp__mousse__ping', 'mcp__mousse__secret'])
    expect(await level('PLAN:second', TOKEN_2, 'access:manage')).toContain('done')
    expect(run.started).toHaveLength(2)
    for (const request of run.anthropic.requests.filter((request) => request.plan === 'second'))
      expect(request.offered).toEqual(['mcp__mousse__gained', 'mcp__mousse__ping'])
    clean(run.started[1]!)
  }, 120_000)

  it.skipIf(!hasBinary || !POSIX)(`a turn with four user stdio servers that hang starts at once with Mousse's tools, and the thread names the servers it started without${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping', max_results: 5 } }, { name: 'mcp__mousse__ping', input: {} }] })
    const hung = Object.fromEntries(['h1', 'h2', 'h3', 'h4'].map((name) => [name, { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, join(run.dirs.pids, name)] }]))
    const startedAt = Date.now()
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations: { mcpServers: hung, proxiedServers: {}, toolRules: {}, warnings: [] } })).toContain('done')
    // Not Claude Code's connect timeout (30 s each, three at a time): the start-up wait of a few seconds at most.
    expect(Date.now() - startedAt).toBeLessThan(20_000)
    expect(run.anthropic.results('first').join('\n')).toContain('pong from /mcp')
    expect(run.notices).toEqual(['Claude started this turn without some MCP servers: h1, h2, h3, h4 (still starting; their tools come in a later turn).'])
    clean(run.started[0]!)
  }, 120_000)

  it.skipIf(!hasBinary)(`a one-shot turn, and one a steer restarts: each process gets the servers, and none holds a credential where it can be read${NO_BINARY}`, async () => {
    const plans = {
      first: [{ name: 'mcp__mousse__ping', input: {} }, { name: 'Bash', input: { command: 'sleep 3', description: 'Wait' } }],
      steer: [{ name: 'mcp__mousse__ping', input: {} }, { name: 'mcp__web__ping', input: {} }]
    }
    const run = await rig(plans, { oneShot: true })
    expect(await personTurn(run, 'PLAN:first', TOKEN)).toContain('done')
    run.service.commitConversation('thread', '')
    expect(run.started).toHaveLength(1)
    // A steer interrupts the one-shot query and restarts the turn in a new process with the steer as its prompt.
    const pending = [{ text: 'PLAN:steer', token: 'drain-1' }]
    const accepted: string[] = []
    const text = await personTurn(run, 'PLAN:first', TOKEN, {
      drainSteerEntry: () => run.started.length >= 2 || run.anthropic.requests.filter((request) => request.plan === 'first').length >= 4 ? pending.shift() : undefined,
      steerTaken: () => undefined,
      onSteer: (steer) => accepted.push(steer),
      returnSteer: () => undefined
    })
    expect(text).toContain('done')
    expect(accepted).toEqual(['PLAN:steer'])
    expect(run.started.length).toBeGreaterThanOrEqual(3)
    for (const process of run.started) clean(process)
    const pinged = run.mcp.calls.filter((call) => call.method === 'tools/call').map((call) => `${call.path}:${call.credential}`)
    expect(pinged).toEqual(expect.arrayContaining(['/mcp:first', '/user:user']))
    expect(run.anthropic.results('steer').join('\n')).toContain('pong from /mcp')
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)(`a resumed session: the new process resumes it with the servers, none on its command line or in its environment, and Claude Code's debug log holds none${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }, { name: 'mcp__web__ping', input: {} }], second: [{ name: 'mcp__mousse__ping', input: {} }] }, { debug: true })
    expect(await personTurn(run, 'PLAN:first', TOKEN)).toContain('done')
    run.service.commitConversation('thread', '')
    // Stop ends the live process; the next turn resumes Claude Code's session in a new one.
    expect(run.service.stopThread('thread')).toBe('stopped')
    expect(await personTurn(run, 'PLAN:second', TOKEN_2)).toContain('done')
    expect(run.started).toHaveLength(2)
    expect(run.started[1]!.args.some((arg) => arg.startsWith('--resume'))).toBe(true)
    for (const process of run.started) clean(process)
    expect(run.mcp.calls.filter((call) => call.path === '/mcp' && call.method === 'tools/call').map((call) => call.credential)).toEqual(['first', 'second'])
    // The debug log was written, and names the servers, never a credential.
    expect(existsSync(run.debugFile)).toBe(true)
    expect(readFileSync(run.debugFile, 'utf8')).toMatch(/MCP|mcp/)
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary || !POSIX)(`a Mousse server Claude Code cannot connect to fails the turn with that cause, and nothing it started is left running${NO_BINARY}`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    cleanups.push(() => vi.restoreAllMocks())
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }] })
    const hungPid = join(run.dirs.pids, 'stuck')
    const integrations = { mcpServers: { stuck: { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, hungPid] } }, proxiedServers: {}, toolRules: {}, warnings: [] }
    await expect(personTurn(run, 'PLAN:first', TOKEN_REFUSED, { integrations })).rejects.toMatchObject({
      code: 'claude_mcp_unavailable',
      message: 'Mousse\'s tools could not be attached to Claude Code, so this turn did not start. Claude Code could not connect to Mousse\'s MCP server; try again.'
    })
    // The model was never asked anything.
    expect(run.anthropic.requests).toEqual([])
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    // Claude Code and the stdio server it started are ended, as Stop ends them.
    await vi.waitFor(() => expect(existsSync(hungPid)).toBe(true), { timeout: 10_000 })
    const server = Number(readFileSync(hungPid, 'utf8'))
    await vi.waitFor(() => {
      expect(alive(run.started[0]!.pid!), 'Claude Code').toBe(false)
      expect(alive(server), 'its stdio server').toBe(false)
    }, { timeout: 15_000, interval: 200 })
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary || !POSIX)(`a Stop while Claude Code is still connecting to Mousse's server ends it and the stdio servers it started, without waiting for its connect timeout${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }] })
    const hungPid = join(run.dirs.pids, 'stuck')
    const integrations = { mcpServers: { stuck: { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, hungPid] } }, proxiedServers: {}, toolRules: {}, warnings: [] }
    const stop = new AbortController()
    const turn = personTurn(run, 'PLAN:first', TOKEN_UNANSWERED, { integrations, signal: stop.signal })
    await vi.waitFor(() => {
      expect(existsSync(hungPid)).toBe(true)
      expect(run.mcp.calls.some((call) => call.path === '/mcp' && call.method === 'initialize')).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    const server = Number(readFileSync(hungPid, 'utf8'))
    stop.abort()
    await expect(turn).rejects.toThrow()
    // Claude Code does not read its closed input while it connects (its 30 s connect timeout): Mousse ends its tree.
    await vi.waitFor(() => {
      expect(alive(run.started[0]!.pid!), 'Claude Code').toBe(false)
      expect(alive(server), 'its stdio server').toBe(false)
    }, { timeout: 10_000, interval: 200 })
    expect(run.anthropic.requests).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)(`a bot on a locked entry: only Mousse's own server, the grant gate sees its calls, and nothing is on the command line or in the environment${NO_BINARY}`, async () => {
    const run = await rig({
      bot: [
        { name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping,mcp__mousse__secret', max_results: 5 } },
        { name: 'mcp__mousse__ping', input: {} },
        { name: 'mcp__mousse__secret', input: {} }
      ]
    }, { locked: true })
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read'], appTools: ['ping'], mcp: [], skills: [], workspace: { roots: [run.dirs.root], access: 'read', scratch: run.dirs.scratch } },
      waiting: () => false, counters: { charge: vi.fn(() => ({ ok: true as const, count: 1 })) as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const pids: number[] = []
    const locked: ClaudeLockedTurn = { authority, ledger: run.ledger, cwd: run.dirs.scratch, shellContained: false, temps: [], systemPrompt: 'You are a test bot.', onProcess: (pid) => pids.push(pid) }
    // The bridge offered the MCP relay too: a bot's turn never attaches it.
    const text = await run.service.chat({
      threadId: 'bot-thread', cwd: run.dirs.scratch, model: 'claude-sonnet-4-5', prompt: 'PLAN:bot', permissionMode: 'full', locked,
      mcp: { url: `${run.mcp.url}/mcp`, token: TOKEN, relay: { url: `${run.mcp.url}/relay`, revision: 'r1' } }, onText: () => undefined
    })
    expect(text).toContain('done')
    // Mousse's own spawn ran it, and what it was started with holds no credential.
    expect(pids).toHaveLength(1)
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    // Only Mousse's server was attached, and only the call the grant holds reached it.
    for (const request of run.anthropic.requests) expect(request.tools.filter((tool) => tool.startsWith('mcp__')).sort()).toEqual(request.tools.some((tool) => tool.startsWith('mcp__')) ? ['mcp__mousse__ping', 'mcp__mousse__secret'] : [])
    expect(new Set(run.mcp.calls.map((call) => call.path))).toEqual(new Set(['/mcp']))
    expect(run.mcp.calls.filter((call) => call.method === 'tools/call')).toEqual([{ path: '/mcp', method: 'tools/call', credential: 'first', tool: 'ping' }])
    // The last request holds every result of the turn: the granted call ran, and the model was told the other did not.
    const results = run.anthropic.requests.filter((request) => request.plan === 'bot').at(-1)!.results
    expect(results.filter((result) => result.includes('pong from /mcp'))).toHaveLength(1)
    expect(results.at(-1)).toMatch(/not allowed|permission|grant/i)
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary || !POSIX)(`a bot that may run commands, on the owner's entry: its command reads no credential${NO_BINARY}`, async () => {
    const run = await rig({
      shell: [
        { name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping', max_results: 5 } },
        { name: 'mcp__mousse__ping', input: {} },
        PRINT_ENV
      ]
    })
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read', 'shell'], appTools: ['ping'], mcp: [], skills: [], workspace: { roots: [run.dirs.root], access: 'read', writeRoots: [], scratch: run.dirs.scratch, files: run.dirs.files } },
      waiting: () => false, counters: { charge: vi.fn(() => ({ ok: true as const, count: 1 })) as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    // The owner's entry where no sandbox is proven: the command runs outside any sandbox, as the owner allowed.
    const locked: ClaudeLockedTurn = { authority, ownerEntry: true, shellOpen: true, ledger: run.ledger, cwd: run.dirs.files, shellContained: false, temps: [], systemPrompt: 'You are a test bot.' }
    const text = await run.service.chat({ threadId: 'bot-thread', cwd: run.dirs.files, model: 'claude-sonnet-4-5', prompt: 'PLAN:shell', permissionMode: 'ask', locked, mcp: { url: `${run.mcp.url}/mcp`, token: TOKEN }, onText: () => undefined })
    expect(text).toContain('done')
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    expect(run.rows).toEqual(expect.arrayContaining([{ name: 'Bash', status: 'committed' }]))
    const results = run.anthropic.results('shell').join('\n')
    expect(results).toContain('pong from /mcp')
    expect(results).toContain('CLAUDE_CONFIG_DIR=')
    expect(found(results)).toEqual([])
    expect(run.leftBehind()).toEqual([])
  }, 120_000)
})
