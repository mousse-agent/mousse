/**
 * Issue #358, real CLI: no MCP credential is on Claude Code's command line or in its environment, for a person's turn
 * and for a bot's, and a command Claude runs cannot read one. Turns go through Mousse's own service and the Agent SDK
 * to this platform's binary of the pinned SDK (or `MOUSSE_CLAUDE_EVIDENCE_BINARY`), against a localhost Messages API
 * mock with a fake key and a localhost MCP server; every value is fake and nothing leaves the machine.
 *
 * What Claude Code is started with is read at the SDK's spawn seam (`spawnClaudeCodeProcess`: its arguments and
 * environment) and from the running process itself, as any local process could read it (`/proc/<pid>/cmdline` and
 * `environ` on Linux, `ps` on macOS).
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { lockedEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'

const BINARY = process.env.MOUSSE_CLAUDE_EVIDENCE_BINARY
  || join(process.cwd(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude')
const hasBinary = existsSync(BINARY)

const TOKEN = 'fake-mousse-token-358-first-aaaaaaaaaaaa'
const TOKEN_2 = 'fake-mousse-token-358-second-bbbbbbbbbbb'
const USER_HEADER = 'fake-user-header-358-cccccccccccccccc'
const USER_ENV = 'fake-user-env-358-dddddddddddddddddd'
/** What must never be on the command line, in the environment, or in what a command Claude runs prints. */
const SECRETS = [TOKEN, TOKEN_2, USER_HEADER, USER_ENV]
const MARKERS = [...SECRETS, '--mcp-config', 'MOUSSE_MCP_VALUE', 'Bearer ']
const found = (text: string) => MARKERS.filter((marker) => text.includes(marker))

type Json = Record<string, unknown>
/** A command that prints its environment and the command line of its parent (Claude Code). No loop or variable. */
const PRINT_ENV = { name: 'Bash', input: { command: 'env; echo ---; ps -ww -o args= -p $PPID', description: 'Print the environment' } }

/** The Messages API: a prompt naming `PLAN:<name>` runs that plan's tool calls, one per request, then says "done". */
async function anthropicMock(plans: Record<string, Json[]>) {
  const sockets = new Set<Socket>()
  const requests: Array<{ plan?: string; tools: string[]; results: string[] }> = []
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
      requests.push({ ...(plan ? { plan } : {}), tools: (body.tools ?? []).map((tool) => tool.name), results })
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
 * MCP servers over Streamable HTTP (plain JSON answers): `/mcp` stands for Mousse's (a bearer of `TOKEN` or `TOKEN_2`),
 * `/user` for a user's (an `X-Api-Key` header). Each call is recorded with which credential it carried, never its value.
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
      if (credential === 'none') return void res.writeHead(401).end()
      if (body.id === undefined) return void res.writeHead(202).end()
      const reply = (result: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      const tool = (name: string) => ({ name, description: `${name} on ${path}`, inputSchema: { type: 'object', properties: {} } })
      if (body.method === 'initialize') return reply({ protocolVersion: body.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `fake${path.replace('/', '-')}`, version: '1.0.0' } })
      if (body.method === 'tools/list') return reply({ tools: path === '/mcp' ? [tool('ping'), tool('secret')] : [tool('ping')] })
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

/** What a Claude Code process was started with, at the SDK's spawn seam and as the running process shows it. */
interface Started {
  args: string[]
  env: Record<string, string | undefined>
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

describe('MCP credentials are never on Claude Code\'s command line or in its environment (#358, real CLI)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  })

  async function rig(plans: Record<string, Json[]>, options: { locked?: boolean } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'mousse-claude-mcp-argv-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const dirs = { work: join(base, 'work'), files: join(base, 'files'), root: join(base, 'root'), scratch: join(base, 'scratch'), userHome: join(base, 'user-home'), instanceHome: join(base, 'instance-home') }
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    mkdirSync(join(dirs.scratch, 'tmp'), { recursive: true })
    const stdioServer = join(base, 'stdio-server.cjs')
    writeFileSync(stdioServer, STDIO_SERVER)
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
      // The real SDK, with the spawn seam read: Mousse's own spawn for a locked entry, the SDK's way otherwise.
      query: ({ prompt, options: given }: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => sdk.query({
        prompt,
        options: {
          ...given,
          spawnClaudeCodeProcess: (spawned: SpawnOptions): SpawnedProcess => {
            const child = given.spawnClaudeCodeProcess
              ? given.spawnClaudeCodeProcess(spawned)
              : nodeSpawn(spawned.command, spawned.args, { cwd: spawned.cwd, env: spawned.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: spawned.signal, windowsHide: true }) as unknown as SpawnedProcess
            started.push({ args: [...spawned.args], env: { ...spawned.env }, ...seenByOthers((child as { pid?: number }).pid) })
            return child
          }
        }
      })
    })
    cleanups.push(() => service.stop())
    const rows: Array<{ name: string; status: string }> = []
    const ledger: ToolLedger = {
      start: (call) => {
        rows.push({ name: call.name, status: 'started' })
        return String(rows.length - 1)
      },
      commit: (id) => { rows[Number(id)]!.status = 'committed' },
      failed: (id) => { rows[Number(id)]!.status = 'failed' }
    }
    return { dirs, stdioServer, anthropic, mcp, service, started, ledger, rows }
  }

  /** Nothing of a credential where another process, or a command Claude runs, can read it. */
  const clean = (process: Started) => {
    expect(found(process.args.join('\n')), 'arguments at the spawn seam').toEqual([])
    expect(found(Object.entries(process.env).map(([name, value]) => `${name}=${value}`).join('\n')), 'environment at the spawn seam').toEqual([])
    if (process.commandLine !== undefined) expect(found(process.commandLine), 'command line of the running process').toEqual([])
    if (process.environment !== undefined) expect(found(process.environment), 'environment of the running process').toEqual([])
  }

  it.skipIf(!hasBinary)('a person\'s turn: the servers work, none is on the command line or in the environment, a command reads none, and a new token reaches the running process', async () => {
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
    const integrations = {
      mcpServers: {
        web: { type: 'http' as const, url: `${run.mcp.url}/user`, headers: { 'X-Api-Key': USER_HEADER } },
        files: { type: 'stdio' as const, command: process.execPath, args: [run.stdioServer], env: { USER_ENV_SECRET: USER_ENV } }
      },
      proxiedServers: {}, toolRules: {}, warnings: []
    }
    const turn = async (prompt: string, token: string) => {
      const text = await run.service.chat({ threadId: 'thread', cwd: run.dirs.work, model: 'claude-sonnet-4-5', prompt, permissionMode: 'full', history: '', mcp: { url: `${run.mcp.url}/mcp`, token }, integrations, onText: () => undefined })
      run.service.commitConversation('thread', '')
      return text
    }
    expect(await turn('PLAN:first', TOKEN)).toContain('done')
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    // Each server was reached with its own credential: Claude Code had them, over its input.
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

    // A new credential (a new epoch) goes to the same process, which uses it from then on.
    expect(await turn('PLAN:second', TOKEN_2)).toContain('done')
    expect(run.started).toHaveLength(1)
    expect(run.mcp.calls.filter((call) => call.path === '/mcp' && call.method === 'tools/call').map((call) => call.credential)).toEqual(['first', 'second'])
    // The user's server stayed connected: it was not started again for the new token.
    expect(run.mcp.calls.filter((call) => call.path === '/user' && call.method === 'initialize')).toHaveLength(1)
  }, 120_000)

  it.skipIf(!hasBinary)('a bot on a locked entry: only Mousse\'s own server, the grant gate sees its calls, and nothing is on the command line or in the environment', async () => {
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
  }, 120_000)

  it.skipIf(!hasBinary || process.platform === 'win32')('a bot that may run commands, on the owner\'s entry: its command reads no credential', async () => {
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
  }, 120_000)
})
