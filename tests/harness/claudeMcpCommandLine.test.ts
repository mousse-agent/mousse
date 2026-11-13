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
 * (`/proc/<pid>/cmdline`, `environ`), macOS (`ps`) and Windows (its command line, `Win32_Process`; Windows has no
 * query for another process's environment). The startup channel of each platform is used by default (the fourth
 * stream on macOS, a named pipe on Linux); on macOS the person's-turn checks also run with the named pipe, so Linux's
 * channel is exercised with the real CLI here too. Windows has no startup channel and registers the user's servers over
 * the input after Mousse's: the tests of that way run there by default and elsewhere through a user's own
 * `--mcp-config`. Windows runs none of the startup-channel checks, nor the ones that need a POSIX shell or `sleep` (the
 * command a bot runs, the error-stream flood, the server that connects late). Without the platform's binary every test
 * is skipped, with the reason in its name. The folder of each test is removed only once every process it started has
 * exited, and a process still running then fails the test.
 *
 * Not here: a start Claude Code refuses for its managed policy (`disableSideloadFlags`, `managed-mcp.json`). This
 * Claude Code reads that policy only from a system folder (`/Library/Application Support/ClaudeCode`, `/etc/claude-code`)
 * no variable moves, and neither the SDK's `managedSettings` nor `serverManagedSettings` makes it refuse (checked), so a
 * test cannot set it without changing the machine; `tests/claudeLiveSessions.test.ts` covers Mousse's handling of the
 * refusal with Claude Code's own words.
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { Options, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { systemTempDirs } from '../../src/mms/bots/grants/compile'
import { botClosedPlaces, CLAUDE_COMMAND_WRITE_LIMIT_TEXT } from '../../src/mms/data/closedPlaces'
import { claudeOwnStorage, type ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { lockedEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { CLAUDE_MCP_START_FOLDER, type ClaudeStartupChannel } from '../../src/mms/harness/vendors/claude/mcpRegistration'
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
const onPath = (name: string) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, name)))
const runtimeDir = process.env.XDG_RUNTIME_DIR
/**
 * Claude Code's sandbox runs (Linux, bubblewrap and socat on PATH) and the user's runtime folder is under `/run`, where a
 * bot's turn keeps its own temporary files: the sandbox's reach can be checked.
 */
const SANDBOX = process.platform === 'linux' && onPath('bwrap') && onPath('socat') && Boolean(runtimeDir?.startsWith('/run/')) && existsSync(runtimeDir!) &&
  tmpdir().startsWith(`${homedir()}/`)
const NO_SANDBOX = SANDBOX ? '' : ' [skipped: needs Linux with bubblewrap and socat on PATH, XDG_RUNTIME_DIR under /run, and TMPDIR under the home folder, where Mousse\'s data is in an install]'
/** Said in the name of a test that needs a POSIX shell (`sleep`, `env`, a `sh` wrapper), skipped on Windows. */
const NO_POSIX = POSIX ? '' : ' [skipped on Windows: needs a POSIX shell]'
/**
 * The startup channel's path on Claude Code's command line: its fourth stream, or a named pipe in a folder of its own;
 * or the user's own config file of a test that sends their servers over the input.
 */
const STARTUP_PATH = /^(\/dev\/fd\/3|.*\/mousse-mcp-[^/]+\/servers|.*\/own-mcp\.json)$/
/** The named-pipe channel runs with the real CLI on macOS too (Linux's default), beside macOS's own. */
const CHANNELS: ClaudeStartupChannel[] = process.platform === 'darwin' ? ['descriptor', 'fifo'] : process.platform === 'win32' ? [] : ['fifo']

const TOKEN = 'fake-mousse-token-358-first-aaaaaaaaaaaa'
const TOKEN_2 = 'fake-mousse-token-358-second-bbbbbbbbbbb'
/** A bearer Mousse's mock server refuses: Claude Code cannot connect to it. */
const TOKEN_REFUSED = 'fake-mousse-token-358-refused-eeeeeeeeee'
/** A bearer Mousse's mock server never answers: Claude Code stays busy connecting to it. */
const TOKEN_UNANSWERED = 'fake-mousse-token-358-unanswered-ffffff'
const USER_HEADER = 'fake-user-header-358-cccccccccccccccc'
const USER_ENV = 'fake-user-env-358-dddddddddddddddddd'
/**
 * Values that still hold `${` after Mousse resolved them: Claude Code must not expand them against its environment, which
 * holds the instance's (fake) API key and the user's home.
 */
const LITERAL = 'a-${ANTHROPIC_API_KEY}-${HOME:-x}-$${HOME}-b'
const LITERAL_QUERY = '${HOME:-x}'
const LITERAL_ARG = 'arg-${HOME:-x}-${ANTHROPIC_API_KEY}'
const LITERAL_ENV = 'env-${ANTHROPIC_API_KEY}-${HOME}'
/** The header of the n-th of many servers: about 2 KB of its own. */
const bulkHeader = (index: number) => `bulk-${index}-`.padEnd(2048, 'b')
/** What must never be on the command line, in the environment, in a file left behind, or in what a command prints. */
const SECRETS = [TOKEN, TOKEN_2, TOKEN_REFUSED, TOKEN_UNANSWERED, USER_HEADER, USER_ENV]
const MARKERS = [...SECRETS, 'MOUSSE_MCP_VALUE', 'Bearer ']
const found = (text: string) => MARKERS.filter((marker) => text.includes(marker))

type Json = Record<string, unknown>
/** A command that prints its environment and the command line of its parent (Claude Code). No loop or variable. */
const PRINT_ENV = { name: 'Bash', input: { command: 'env; echo ---; ps -ww -o args= -p $PPID', description: 'Print the environment' } }

/**
 * Tries to read each path it is given, and every named pipe Mousse may have left in `--fifo-root <dir>`, without ever
 * blocking (a pipe or socket is opened non-blocking), and prints per path the error or the number of bytes read, never
 * the bytes.
 */
const READER = `const fs = require('fs'); const path = require('path')
const args = process.argv.slice(2); const at = args.indexOf('--fifo-root'); const paths = args.filter((_, i) => i !== at && i !== at + 1)
if (at >= 0) for (const dir of fs.readdirSync(args[at + 1]).filter((n) => n.startsWith('mousse-mcp-'))) paths.push(path.join(args[at + 1], dir), path.join(args[at + 1], dir, 'servers'))
for (const p of paths) {
  let said
  try { const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); let n = 0; let servers = false; const b = Buffer.alloc(1 << 20)
    try { for (;;) { const r = fs.readSync(fd, b); if (r === 0) break; n += r; if (b.subarray(0, r).includes('mcpServers')) servers = true } } catch (e) { if (e.code !== 'EAGAIN' && e.code !== 'EISDIR') throw e }
    fs.closeSync(fd); said = n + ' bytes' + (servers ? ' HOLDING SERVERS' : '') } catch (e) { said = e.code || String(e) }
  console.log('READ ' + p + ': ' + said)
}`
/** What a command Claude runs can read of the startup channel: its own fourth stream, Claude Code's (Linux), and the pipe. */
const readsCommand = (reader: string, fifoRoot: string) => ({
  name: 'Bash',
  input: {
    command: `if { true <&3; } 2>/dev/null; then echo "FD3 open, $(head -c 1048576 <&3 | wc -c | tr -d ' ') bytes"; else echo "FD3 not open"; fi; ${JSON.stringify(process.execPath)} ${JSON.stringify(reader)} /proc/$PPID/fd/3 --fifo-root ${JSON.stringify(fifoRoot)}`,
    description: 'Try to read the startup channel'
  }
})

/** The Messages API: a prompt naming `PLAN:<name>` runs that plan's tool calls, one per request, then says "done". */
async function anthropicMock(plans: Record<string, Json[]>) {
  const sockets = new Set<Socket>()
  const requests: Array<{ plan?: string; tools: string[]; offered: string[]; results: string[]; auth: string; system: string }> = []
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
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; tools?: Array<{ name: string }>; system?: unknown; messages: Array<{ role: string; content: unknown }> }
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
      requests.push({ ...(plan ? { plan } : {}), tools, offered, results, auth: String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''), system: textOf(body.system) })
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
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
      const credential = path === '/mcp' || path === '/relay'
        ? auth === `Bearer ${TOKEN}` ? 'first' : auth === `Bearer ${TOKEN_2}` ? 'second' : 'none'
        : path === '/user' ? (req.headers['x-api-key'] === USER_HEADER ? 'user' : 'none')
          // A value holding `${`: the header and the address arrive exactly as sent, or the server says how they differ.
          : path === '/literal' ? (req.headers['x-literal'] === LITERAL && query.get('q') === LITERAL_QUERY ? 'literal' : req.headers['x-literal'] === undefined ? 'none' : 'changed')
            // One of many servers: its own long header, whole.
            : path.startsWith('/bulk/') ? (req.headers['x-bulk'] === bulkHeader(Number(path.slice(6))) ? 'bulk' : 'none') : 'none'
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
      // `/relay` stands for Mousse's relay of the owner's servers; it lists one tool more than a bot was offered.
      if (body.method === 'tools/list') return reply({ tools: path === '/mcp' ? [tool('ping'), tool(credential === 'second' ? 'gained' : 'secret')] : path === '/relay' ? [tool('github__list_issues'), tool('github__delete_repo')] : [tool('ping')] })
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

/**
 * A stdio MCP server whose one tool says whether it was started with the user's secret value (never the value). It
 * writes its pid to the file it is given, so a test can see it end.
 */
const STDIO_SERVER = `if (process.argv[2]) require('fs').writeFileSync(process.argv[2], String(process.pid))
const rl = require('readline').createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' } } })
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'secret_seen', description: 'Says whether the server got its secret.', inputSchema: { type: 'object', properties: {} } }] } })
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'secret seen: ' + (process.env.USER_ENV_SECRET === ${JSON.stringify(USER_ENV)}) }] } })
  send({ jsonrpc: '2.0', id: msg.id, result: {} })
})`
/** A stdio MCP server whose one tool says whether its argument and its variable arrived exactly as sent (never them). */
const LITERAL_SERVER = `const rl = require('readline').createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-literal', version: '1.0.0' } } })
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'literal', description: 'Says whether its values arrived as sent.', inputSchema: { type: 'object', properties: {} } }] } })
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'arg literal: ' + (process.argv[2] === ${JSON.stringify(LITERAL_ARG)}) + ', env literal: ' + (process.env.LITERAL_ENV === ${JSON.stringify(LITERAL_ENV)}) }] } })
  send({ jsonrpc: '2.0', id: msg.id, result: {} })
})`
/** A stdio MCP server that answers only after the delay it is given (ms): one Claude Code starts a turn without. */
const SLOW_SERVER = `const rl = require('readline').createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const ready = new Promise((resolve) => setTimeout(resolve, Number(process.argv[2])))
rl.on('line', async (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  await ready
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-slow', version: '1.0.0' } } })
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'late', description: 'Answers late.', inputSchema: { type: 'object', properties: {} } }] } })
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'late but here' }] } })
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
  // Windows: the command line as any local process reads it. Another process's environment has no such query (it is
  // read at the spawn seam only).
  if (process.platform === 'win32') return { commandLine: windowsCommandLine(pid) }
  return {}
}

/** The command line Windows shows for `pid` (`Win32_Process`); it must exist, or the check proves nothing. */
function windowsCommandLine(pid: number): string {
  const line = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true }).trim()
  if (!line) throw new Error(`Windows shows no command line for process ${pid}`)
  return line
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

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
    // Every cleanup runs; the first that failed (a process the test started still running, say) fails the test.
    let failed: unknown
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failed ??= error
      }
    }
    if (failed !== undefined) throw failed
  })

  /**
   * `channel`: the startup channel (default: the platform's). `viaInput`: the user's servers go over Claude Code's input,
   * as on Windows (a launch argument of the user's names `--mcp-config`). `stderrFlood`: Claude Code is started through a
   * wrapper that first writes 2 MB to the error stream, then becomes Claude Code (same process): a stream nobody reads
   * stops it before it starts.
   */
  async function rig(plans: Record<string, Json[]>, options: { locked?: boolean; oneShot?: boolean; debug?: boolean; channel?: ClaudeStartupChannel; viaInput?: boolean; stderrFlood?: boolean; oauth?: string } = {}) {
    const base = mkdtempSync(join(tmpdir(), 'mousse-claude-mcp-argv-'))
    const started: Started[] = []
    // Runs after the service has stopped (cleanups run in reverse). A live Claude Code exits a moment after its input
    // closes, and Windows does not remove a folder that is still a running process's working folder: the folder goes
    // once every process the test started (Claude Code, and the stdio servers that wrote their pid) has exited.
    cleanups.push(async () => {
      const servers = () => existsSync(dirs.pids) ? readdirSync(dirs.pids).map((name) => Number(readFileSync(join(dirs.pids, name), 'utf8'))).filter((pid) => pid > 0) : []
      const running = () => [...started.flatMap((process) => process.pid === undefined ? [] : [process.pid]), ...servers()].filter(alive)
      await vi.waitFor(() => expect(running(), 'processes the test started, still running after the service stopped').toEqual([]), { timeout: 15_000, interval: 50 })
      rmSync(base, { recursive: true, force: true })
    })
    const dirs = { work: join(base, 'work'), files: join(base, 'files'), root: join(base, 'root'), scratch: join(base, 'scratch'), userHome: join(base, 'user-home'), instanceHome: join(base, 'instance-home'), pids: join(base, 'pids') }
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    mkdirSync(join(dirs.scratch, 'tmp'), { recursive: true })
    if (options.oauth)
      writeFileSync(join(dirs.instanceHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: options.oauth, refreshToken: 'sk-ant-ort01-fake-refresh', expiresAt: Date.now() + 365 * 24 * 3600 * 1000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'pro' } }), { mode: 0o600 })
    const stdioServer = join(base, 'stdio-server.cjs')
    writeFileSync(stdioServer, STDIO_SERVER)
    const hungServer = join(base, 'hung-server.cjs')
    writeFileSync(hungServer, HUNG_SERVER)
    const literalServer = join(base, 'literal-server.cjs')
    writeFileSync(literalServer, LITERAL_SERVER)
    const slowServer = join(base, 'slow-server.cjs')
    writeFileSync(slowServer, SLOW_SERVER)
    const reader = join(base, 'reader.cjs')
    writeFileSync(reader, READER)
    // The user's own (empty) --mcp-config, which sends their Mousse servers over the input.
    const ownConfig = join(base, 'own-mcp.json')
    writeFileSync(ownConfig, JSON.stringify({ mcpServers: {} }))
    /** Bytes each process wrote to its error stream, by pid. */
    const stderrBytes = new Map<number, number>()
    const flood = join(base, 'claude-flood.sh')
    writeFileSync(flood, `#!/bin/sh\nhead -c 2097152 /dev/zero | tr '\\0' x >&2\nexec ${JSON.stringify(BINARY)} "$@"\n`)
    chmodSync(flood, 0o755)
    const debugFile = join(base, 'claude-debug.log')
    const anthropic = await anthropicMock(plans)
    cleanups.push(() => anthropic.close())
    const mcp = await mcpMock()
    cleanups.push(() => mcp.close())
    const state = mkdtempSync(join(base, 'state-'))
    mkdirSync(join(state, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(state, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const service = new ClaudeSubscriptionProviderService(state, new UserQuestionService(), {
      probe: () => ({ kind: 'signed_in', account: { label: 'API key', credential: 'api_key' } }),
      launchConfig: () => ({ binaryPath: options.stderrFlood ? flood : BINARY, ...(options.viaInput ? { args: ['--mcp-config', ownConfig] } : {}) }),
      ...(options.channel ? { startupChannel: options.channel } : {}),
      baseEnv: () => ({ PATH: process.env.PATH, HOME: dirs.userHome, CLAUDE_CONFIG_DIR: dirs.instanceHome }),
      ...(options.locked
        ? { lockedEnv: (cwd: string) => lockedEnv({ platform: process.platform, base: { PATH: process.env.PATH, HOME: dirs.userHome }, driver: 'claude', credential: 'api_key', home: dirs.instanceHome, scratch: cwd }) }
        : {}),
      // Every live slot taken: each turn runs as one query, as a person's turn past the cap does.
      ...(options.oneShot ? { live: { maxSessions: 0 } } : {}),
      finalEnv: (env) => ({
        ...env,
        ANTHROPIC_BASE_URL: anthropic.url,
        ...(options.oauth ? {} : { ANTHROPIC_API_KEY: 'sk-ant-api03-fake-local' }),
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
            // Read here only for a process the SDK's way would start (the rig's spawn): Mousse's own spawn must read its
            // error stream itself, and a second reader here would hide one that does not.
            const stderr = (child as { stderr?: NodeJS.ReadableStream }).stderr
            if (pid !== undefined && !given.spawnClaudeCodeProcess) stderr?.on('data', (chunk: Buffer) => stderrBytes.set(pid, (stderrBytes.get(pid) ?? 0) + chunk.length))
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
    return { dirs, stdioServer, hungServer, literalServer, slowServer, reader, debugFile, anthropic, mcp, service, started, ledger, rows, notices, state, leftBehind, stderrBytes }
  }
  type Rig = Awaited<ReturnType<typeof rig>>

  /** The user's servers of a person's turn: an http one with a secret header, a stdio one with a secret environment value. */
  const userServers = (run: Rig) => ({
    mcpServers: {
      web: { type: 'http' as const, url: `${run.mcp.url}/user`, headers: { 'X-Api-Key': USER_HEADER } },
      files: { type: 'stdio' as const, command: process.execPath, args: [run.stdioServer, join(run.dirs.pids, 'files')], env: { USER_ENV_SECRET: USER_ENV } }
    },
    proxiedServers: {}, toolRules: {}, warnings: []
  })
  const personTurn = (run: Rig, prompt: string, token: string, extra: Partial<ClaudeSubscriptionChatInput> = {}) =>
    run.service.chat({ threadId: 'thread', cwd: run.dirs.work, model: 'claude-sonnet-4-5', prompt, permissionMode: 'full', history: '', mcp: { url: `${run.mcp.url}/mcp`, token }, integrations: userServers(run), onText: () => undefined, ...extra })

  /** Nothing of a credential where another process, or a command Claude runs, can read it. */
  const clean = (process: Started) => {
    expect(found(process.args.join('\n')), 'arguments at the spawn seam').toEqual([])
    // The command line names at most the channel the user's servers come through, never a server.
    const config = process.args.indexOf('--mcp-config')
    if (config >= 0) expect(process.args[config + 1], 'the only --mcp-config is the startup channel').toMatch(STARTUP_PATH)
    expect(process.args.filter((arg) => arg === '--mcp-config').length).toBeLessThanOrEqual(1)
    expect(found(Object.entries(process.env).map(([name, value]) => `${name}=${value}`).join('\n')), 'environment at the spawn seam').toEqual([])
    if (process.commandLine !== undefined) expect(found(process.commandLine), 'command line of the running process').toEqual([])
    if (process.environment !== undefined) expect(found(process.environment), 'environment of the running process').toEqual([])
  }

  it.skipIf(!hasBinary || CHANNELS.length === 0).each(CHANNELS)(`a person's turn (startup channel: %s): the servers work, none is on the command line or in the environment, neither a command nor another process reads one, no file keeps one, and a new token reaches the running process${NO_BINARY}`, async (channel) => {
    // Where the named pipe is made: the entry's own folder in Mousse's data, never the shared temporary folder.
    let fifoRoot = ''
    const plans = {
      first: [
        { name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping,mcp__web__ping,mcp__files__secret_seen', max_results: 5 } },
        { name: 'mcp__mousse__ping', input: {} },
        { name: 'mcp__web__ping', input: {} },
        { name: 'mcp__files__secret_seen', input: {} },
        PRINT_ENV,
        // The reader's path is filled in below, once the rig has written it.
        { name: 'Bash', input: { command: 'READS', description: 'Try to read the startup channel' } }
      ],
      second: [{ name: 'mcp__mousse__ping', input: {} }]
    }
    const run = await rig(plans, { channel })
    fifoRoot = join(run.state, 'providers', 'claude-subscription', CLAUDE_MCP_START_FOLDER)
    // Made before Claude Code starts, so the reader can look in it even when no pipe is left.
    mkdirSync(fifoRoot, { recursive: true, mode: 0o700 })
    plans.first[plans.first.length - 1] = readsCommand(run.reader, fifoRoot)
    const turn = async (prompt: string, token: string) => {
      const text = await personTurn(run, prompt, token)
      run.service.commitConversation('thread', '')
      return text
    }
    // Another process of the same user, while the turn runs and Claude Code has read its servers: it tries Claude Code's
    // fourth stream (Linux: `/proc/<pid>/fd/3`) and any named pipe Mousse made.
    let other = ''
    const watching = (async () => {
      await vi.waitFor(() => expect(run.mcp.calls.some((call) => call.path === '/user')).toBe(true), { timeout: 60_000, interval: 50 })
      other = execFileSync(process.execPath, [run.reader, `/proc/${run.started[0]!.pid}/fd/3`, '--fifo-root', fifoRoot], { encoding: 'utf8' })
    })()
    expect(await turn('PLAN:first', TOKEN)).toContain('done')
    await watching
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    const config = run.started[0]!.args[run.started[0]!.args.indexOf('--mcp-config') + 1]!
    expect(config).toMatch(channel === 'descriptor' ? /^\/dev\/fd\/3$/ : /\/mousse-mcp-[^/]+\/servers$/)
    // The pipe was in Mousse's own data, out of a bot's commands' reach, never in the shared temporary folder.
    if (channel === 'fifo') {
      expect(relative(fifoRoot, config).startsWith('mousse-mcp-')).toBe(true)
      expect(relative(tmpdir(), config).startsWith('mousse-mcp-')).toBe(false)
    }
    // What the command read: nothing of the channel. Its fourth stream, if it has one, holds no byte; Claude Code's own
    // (Linux, `/proc/<pid>/fd/3`) holds no server; and the named pipe and its folder are gone.
    const read = run.anthropic.results('first').join('\n')
    expect(read).toMatch(/FD3 (not open|open, 0 bytes)/)
    expect(read).toMatch(/READ \/proc\/\d+\/fd\/3: /)
    for (const seen of [read, other]) {
      expect(seen).not.toContain('HOLDING SERVERS')
      expect(seen).not.toMatch(/READ .*mousse-mcp-/)
    }
    if (channel === 'fifo') expect(existsSync(config)).toBe(false)
    console.info(`[#358 evidence] channel ${channel}: command: ${read.split('\n').filter((line) => /^(FD3|READ)/.test(line)).join(' | ')}; other process: ${other.trim().split('\n').join(' | ')}`)
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

  it.skipIf(!hasBinary)(`a person's turn with the user's servers over Claude Code's input (Windows' way; elsewhere forced by the user's own --mcp-config): the servers work, none is on the command line or in the environment, the thread is told of no server left out, a new token reaches the running process, and Stop ends Claude Code and its stdio server${NO_BINARY}`, async () => {
    const plans = {
      first: [
        { name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping,mcp__web__ping,mcp__files__secret_seen', max_results: 5 } },
        { name: 'mcp__mousse__ping', input: {} },
        { name: 'mcp__web__ping', input: {} },
        { name: 'mcp__files__secret_seen', input: {} },
        POSIX ? PRINT_ENV : { name: 'Bash', input: { command: 'env', description: 'Print the environment' } }
      ],
      second: [{ name: 'mcp__mousse__ping', input: {} }]
    }
    const run = await rig(plans, { viaInput: POSIX })
    const turn = async (prompt: string, token: string) => {
      const text = await personTurn(run, prompt, token)
      run.service.commitConversation('thread', '')
      return text
    }
    expect(await turn('PLAN:first', TOKEN)).toContain('done')
    expect(run.started).toHaveLength(1)
    const claude = run.started[0]!
    clean(claude)
    // Windows: no --mcp-config at all; elsewhere only the user's own file. The running process's command line was read.
    if (!POSIX) expect(claude.args).not.toContain('--mcp-config')
    expect(claude.commandLine).toBeDefined()
    console.info(`[#358 evidence] over the input: command line of the running process: ${claude.commandLine}; variables at the spawn seam: ${Object.keys(claude.env).sort().join(',')}`)
    // The bounds on how long the user's servers can hold the first prompt (`CLAUDE_INPUT_MCP_ENV`).
    expect(claude.env).toMatchObject({ MCP_TIMEOUT: '10000', MCP_SERVER_CONNECTION_BATCH_SIZE: '16' })
    expect(run.mcp.calls).toEqual(expect.arrayContaining([
      { path: '/mcp', method: 'tools/call', credential: 'first', tool: 'ping' },
      { path: '/user', method: 'tools/call', credential: 'user', tool: 'ping' }
    ]))
    const results = run.anthropic.results('first').join('\n')
    expect(results).toContain('pong from /mcp')
    expect(results).toContain('secret seen: true')
    // The command saw Claude Code's own environment: no credential in it.
    expect(results).toContain('CLAUDE_CONFIG_DIR=')
    expect(found(results)).toEqual([])
    // Every server connected: none is named as left out (the late registration's answer included).
    await later(500)
    expect(run.notices).toEqual([])

    expect(await turn('PLAN:second', TOKEN_2)).toContain('done')
    expect(run.started).toHaveLength(1)
    expect(run.mcp.calls.filter((call) => call.path === '/mcp' && call.method === 'tools/call').map((call) => call.credential)).toEqual(['first', 'second'])
    // The renewal sent the user's servers again unchanged: they stayed connected.
    expect(run.mcp.calls.filter((call) => call.path === '/user' && call.method === 'initialize')).toHaveLength(1)
    expect(run.notices).toEqual([])
    expect(run.leftBehind()).toEqual([])

    // Stop: Claude Code and the stdio server it started both end.
    const server = Number(readFileSync(join(run.dirs.pids, 'files'), 'utf8'))
    expect(alive(server)).toBe(true)
    const stoppedAt = Date.now()
    expect(run.service.stopThread('thread')).toBe('stopped')
    await vi.waitFor(() => {
      expect(alive(claude.pid!), 'Claude Code').toBe(false)
      expect(alive(server), 'its stdio server').toBe(false)
    }, { timeout: 15_000, interval: 50 })
    console.info(`[#358 evidence] over the input: Claude Code and its stdio server ended ${Date.now() - stoppedAt} ms after Stop`)
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

  it.skipIf(!hasBinary || CHANNELS.length === 0).each(CHANNELS)(`a turn with four user stdio servers that hang starts at once with Mousse's tools, and the thread names the servers it started without (%s)${NO_BINARY}`, async (channel) => {
    const run = await rig({ first: [{ name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping', max_results: 5 } }, { name: 'mcp__mousse__ping', input: {} }] }, { channel })
    const hung = Object.fromEntries(['h1', 'h2', 'h3', 'h4'].map((name) => [name, { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, join(run.dirs.pids, name)] }]))
    const startedAt = Date.now()
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations: { mcpServers: hung, proxiedServers: {}, toolRules: {}, warnings: [] } })).toContain('done')
    const took = Date.now() - startedAt
    console.info(`[#358 evidence] four hung servers through the ${channel} channel: the turn took ${took} ms`)
    // Not Claude Code's connect timeout (30 s each, three at a time): the start-up wait of a few seconds at most.
    expect(took).toBeLessThan(20_000)
    expect(run.anthropic.results('first').join('\n')).toContain('pong from /mcp')
    expect(run.notices).toEqual(['Claude started this turn without some MCP servers: h1, h2, h3, h4 (still starting; each is offered once it has connected).'])
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

  it.skipIf(!hasBinary)(`a Mousse server Claude Code cannot connect to fails the turn with that cause, and nothing it started is left running${NO_BINARY}`, async () => {
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
    if (POSIX) {
      // Claude Code and the stdio server it started are ended, as Stop ends them.
      await vi.waitFor(() => expect(existsSync(hungPid)).toBe(true), { timeout: 10_000 })
      const server = Number(readFileSync(hungPid, 'utf8'))
      await vi.waitFor(() => {
        expect(alive(run.started[0]!.pid!), 'Claude Code').toBe(false)
        expect(alive(server), 'its stdio server').toBe(false)
      }, { timeout: 15_000, interval: 200 })
    } else {
      // Windows registers the user's servers only once Mousse's is attached: Claude Code is ended, and never started one.
      await vi.waitFor(() => expect(alive(run.started[0]!.pid!), 'Claude Code').toBe(false), { timeout: 15_000, interval: 200 })
      expect(existsSync(hungPid), 'a stdio server of the user\'s was started').toBe(false)
    }
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)(`a Stop while Claude Code is still connecting to Mousse's server ends it and the stdio servers it started, without waiting for its connect timeout${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }] })
    const hungPid = join(run.dirs.pids, 'stuck')
    const integrations = { mcpServers: { stuck: { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, hungPid] } }, proxiedServers: {}, toolRules: {}, warnings: [] }
    const stop = new AbortController()
    const turn = personTurn(run, 'PLAN:first', TOKEN_UNANSWERED, { integrations, signal: stop.signal })
    // Windows registers the user's servers only once Mousse's is attached: none is started while Claude Code connects it.
    await vi.waitFor(() => {
      if (POSIX) expect(existsSync(hungPid)).toBe(true)
      expect(run.mcp.calls.some((call) => call.path === '/mcp' && call.method === 'initialize')).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    const server = POSIX ? Number(readFileSync(hungPid, 'utf8')) : undefined
    const stoppedAt = Date.now()
    stop.abort()
    await expect(turn).rejects.toThrow()
    // Claude Code does not read its closed input while it connects (its 30 s connect timeout): Mousse ends its tree.
    await vi.waitFor(() => {
      expect(alive(run.started[0]!.pid!), 'Claude Code').toBe(false)
      if (server !== undefined) expect(alive(server), 'its stdio server').toBe(false)
    }, { timeout: 10_000, interval: 200 })
    console.info(`[#358 evidence] Stop while Claude Code connected Mousse's server: it ended ${Date.now() - stoppedAt} ms after Stop`)
    if (!POSIX) expect(existsSync(hungPid), 'a stdio server of the user\'s was started').toBe(false)
    expect(run.anthropic.requests).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)(`a Stop while user stdio servers that hang hold the first prompt (over Claude Code's input, Windows' way) ends Claude Code and every one of them${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'mcp__mousse__ping', input: {} }] }, { viaInput: POSIX })
    const names = ['h1', 'h2']
    const hung = Object.fromEntries(names.map((name) => [name, { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, join(run.dirs.pids, name)] }]))
    const stop = new AbortController()
    const turn = personTurn(run, 'PLAN:first', TOKEN, { integrations: { mcpServers: hung, proxiedServers: {}, toolRules: {}, warnings: [] }, signal: stop.signal })
    // Mousse's server attached, the user's registered after it, their processes running, and Claude Code holding the prompt.
    await vi.waitFor(() => {
      for (const name of names) expect(existsSync(join(run.dirs.pids, name))).toBe(true)
    }, { timeout: 15_000, interval: 100 })
    const servers = names.map((name) => Number(readFileSync(join(run.dirs.pids, name), 'utf8')))
    const stoppedAt = Date.now()
    // A person's Stop: the turn is cancelled and the thread's process is stopped (the turn's cancel alone keeps it).
    stop.abort()
    expect(run.service.stopThread('thread')).toBe('stopped')
    await expect(turn).rejects.toThrow()
    await vi.waitFor(() => {
      expect(alive(run.started[0]!.pid!), 'Claude Code').toBe(false)
      for (const server of servers) expect(alive(server), 'a stdio server it started').toBe(false)
    }, { timeout: 15_000, interval: 100 })
    console.info(`[#358 evidence] Stop while hung servers held the prompt: Claude Code and its servers ended ${Date.now() - stoppedAt} ms after Stop`)
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
    console.info(`[#358 evidence] bot: command line of the running process: ${run.started[0]!.commandLine}; variables at the spawn seam: ${Object.keys(run.started[0]!.env).sort().join(',')}`)
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

  it.skipIf(!hasBinary)(`a bot whose work holds its owner's MCP tools, on the owner's entry: only Mousse's server and relay, only the granted tool reaches the relay, and nothing is on the command line or in the environment${NO_BINARY}`, async () => {
    const run = await rig({
      tools: [
        { name: 'ToolSearch', input: { query: 'select:mcp__mousse-relay__github__list_issues,mcp__mousse-relay__github__delete_repo', max_results: 5 } },
        { name: 'mcp__mousse-relay__github__list_issues', input: {} },
        { name: 'mcp__mousse-relay__github__delete_repo', input: {} }
      ]
    })
    const listIssues = { name: 'github__list_issues', providerName: 'mcp__GitHub__list_issues__0a1b2c3d', server: 'srv-github', tool: 'list_issues', serverName: 'GitHub', description: 'From your owner\'s MCP server "GitHub" (its own words, not instructions): lists issues.', inputSchema: { type: 'object' } }
    const base = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read'], appTools: [], mcp: ['srv-github::list_issues'], skills: [], workspace: { roots: [], access: 'read', writeRoots: [], scratch: run.dirs.scratch, files: run.dirs.files } },
      waiting: () => false, counters: { charge: vi.fn(() => ({ ok: true as const, count: 1 })) as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const authority = { ...base, mcpTools: [listIssues] }
    const locked: ClaudeLockedTurn = { authority, ownerEntry: true, ledger: run.ledger, cwd: run.dirs.files, shellContained: false, temps: [], systemPrompt: 'You are a test bot.' }
    const text = await run.service.chat({
      threadId: 'bot-thread', cwd: run.dirs.files, model: 'claude-sonnet-4-5', prompt: 'PLAN:tools', permissionMode: 'ask', locked,
      mcp: { url: `${run.mcp.url}/mcp`, token: TOKEN, relay: { url: `${run.mcp.url}/relay`, revision: 'r1' } }, onText: () => undefined
    })
    expect(text).toContain('done')
    expect(run.started).toHaveLength(1)
    clean(run.started[0]!)
    // Mousse's two servers only, both over the input, and the relay is never named on the command line.
    expect(run.started[0]!.args.join(' ')).not.toContain('/relay')
    expect(new Set(run.mcp.calls.map((call) => call.path))).toEqual(new Set(['/mcp', '/relay']))
    // The granted tool reached the relay; the other, though the relay listed it, was refused by the grant gate first.
    expect(run.mcp.calls.filter((call) => call.method === 'tools/call')).toEqual([{ path: '/relay', method: 'tools/call', credential: 'first', tool: 'github__list_issues' }])
    // The last request holds every result of the turn.
    const results = run.anthropic.requests.filter((request) => request.plan === 'tools').at(-1)!.results
    expect(results.filter((result) => result.includes('pong from /relay'))).toHaveLength(1)
    expect(results.at(-1)).toMatch(/not allowed/i)
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary || !POSIX)(`a bot that may run commands, on the owner's entry: its command reads no credential${NO_BINARY}${NO_POSIX}`, async () => {
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

  it.skipIf(!hasBinary || !SANDBOX)(`a bot without file access, its commands in Claude Code's sandbox on Linux: they read no removable drive or runtime folder under /run, no other session's command output, nothing of Mousse's start-up pipe or of its folders in the temporary folder, and they still run${NO_BINARY}${NO_SANDBOX}`, async () => {
    const plans: Record<string, Json[]> = { reach: [{ name: 'Bash', input: { command: 'READS', description: 'Try what a bot may not read' } }] }
    const run = await rig(plans)
    const uid = process.getuid!()
    const marker = `reach-${Date.now()}`
    // What the bot must not reach: a file in the user's runtime folder, another session's saved command output in Claude
    // Code's shared temporary folder, the folder where Mousse makes the start-up pipe of the owner's MCP servers, and a
    // folder Mousse keeps in the temporary folder (a pull request's text).
    const runtime = process.env.XDG_RUNTIME_DIR!
    const inRuntime = join(runtime, `${marker}.txt`)
    const otherSession = join('/tmp', `claude-${uid}`, `-${marker}-owner`, 'session', 'tasks')
    const pipeFolder = join(run.state, 'providers', 'claude-subscription', CLAUDE_MCP_START_FOLDER)
    const mousseTemp = mkdtempSync(join('/tmp', 'mousse-pr-'))
    mkdirSync(otherSession, { recursive: true })
    mkdirSync(pipeFolder, { recursive: true, mode: 0o700 })
    writeFileSync(inRuntime, 'secret\n')
    writeFileSync(join(otherSession, 'b1.output'), 'secret\n')
    writeFileSync(join(pipeFolder, 'marker'), 'secret\n')
    writeFileSync(join(mousseTemp, 'body.md'), 'secret\n')
    cleanups.push(() => { rmSync(inRuntime, { force: true }); rmSync(join('/tmp', `claude-${uid}`, `-${marker}-owner`), { recursive: true, force: true }); rmSync(mousseTemp, { recursive: true, force: true }) })
    const tries = [inRuntime, join(otherSession, 'b1.output'), join(pipeFolder, 'marker'), join(mousseTemp, 'body.md'), '/etc/hostname']
    const command = [
      ...tries.map((path) => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo "read ${path}"; else echo "denied ${path}"; fi`),
      `if echo x > ${JSON.stringify(join(otherSession, 'b2.output'))} 2>/dev/null; then echo "wrote other"; else echo "denied write"; fi`,
      'python3 -c "print(6 * 7)"',
      'echo own > own.txt && echo "wrote own"'
    ].join('; ')
    plans.reach[0] = { name: 'Bash', input: { command, description: 'Try what a bot may not read' } }
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read', 'shell'], appTools: [], mcp: [], skills: [], workspace: { roots: [], access: 'read', writeRoots: [run.dirs.files], scratch: run.dirs.scratch, files: run.dirs.files } },
      waiting: () => false, counters: { charge: vi.fn(() => ({ ok: true as const, count: 1 })) as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const locked: ClaudeLockedTurn = { authority, ownerEntry: true, ledger: run.ledger, cwd: run.dirs.files, shellContained: true, temps: systemTempDirs(), systemPrompt: 'You are a test bot.' }
    const text = await run.service.chat({ threadId: 'bot-thread', cwd: run.dirs.files, model: 'claude-sonnet-4-5', prompt: 'PLAN:reach', permissionMode: 'ask', locked, mcp: null, onText: () => undefined })
    expect(text).toContain('done')
    const said = run.anthropic.results('reach').join('\n')
    for (const path of tries.slice(0, 4)) expect(said).toContain(`denied ${path}`)
    expect(said).toContain('read /etc/hostname')
    expect(said).toContain('denied write')
    expect(said).toContain('42')
    expect(said).toContain('wrote own')
    expect(existsSync(join(otherSession, 'b2.output'))).toBe(false)
    expect(run.leftBehind()).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary || !SANDBOX)(`a bot with file access, on the owner's own entry: its commands and its file tool read none of the places closed to bots, directly or through a link, while the files beside them read; its commands write beside them but can't move one away, change a system folder or put a link in Claude Code's own storage, and the bot is told so; and the turn signs in with the entry's own credentials file${NO_BINARY}${NO_SANDBOX}`, async () => {
    const token = `sk-ant-oat01-fake-${Date.now()}`
    const plans: Record<string, Json[]> = { closed: [] }
    const run = await rig(plans, { oauth: token })
    const mark = `closed-${Date.now()}`
    // Mousse's home with another bot's browser profile in it; the app's Electron user data with the in-app browser's
    // cookie store; the owner's Codex sign-in; Claude Code's credentials (the entry's own home: `CLAUDE_CONFIG_DIR`) and
    // global config. Beside them, Claude Code's settings and an ordinary file stay open.
    const mousseHome = join(run.dirs.root, '.mousse')
    const otherBot = join(mousseHome, 'browser', 'user-data', 'p1', 'workspaces', 'botbrowser_other', 'Cookies')
    const electron = join(run.dirs.userHome, '.config', 'mousse')
    const cookies = join(electron, 'Partitions', 'mousse-browser', 'Cookies')
    const codexAuth = join(run.dirs.userHome, '.codex', 'auth.json')
    const credentials = join(run.dirs.instanceHome, '.credentials.json')
    const claudeJson = join(run.dirs.userHome, '.claude.json')
    const settings = join(run.dirs.instanceHome, 'settings.json')
    const ordinary = join(run.dirs.root, 'ordinary.txt')
    for (const file of [otherBot, cookies, codexAuth]) mkdirSync(join(file, '..'), { recursive: true })
    for (const file of [otherBot, cookies, codexAuth, claudeJson]) writeFileSync(file, `secret ${mark}\n`)
    writeFileSync(settings, '{"ordinary": "settings"}\n')
    writeFileSync(ordinary, 'ordinary\n')
    const linkToCookies = join(run.dirs.root, 'cookie-link')
    const linkToHome = join(run.dirs.root, 'claude-link')
    symlinkSync(cookies, linkToCookies)
    symlinkSync(run.dirs.instanceHome, linkToHome)
    const closed = [otherBot, cookies, linkToCookies, codexAuth, credentials, join(linkToHome, '.credentials.json'), claudeJson]
    // Claude Code's own storage for this turn, with a link the test put there (as a command might have) to its credentials.
    const own = claudeOwnStorage(run.dirs.instanceHome, run.dirs.files).folders[0]!
    const ownSession = join(own, 'session-1', 'tool-results')
    mkdirSync(ownSession, { recursive: true })
    const ownLink = join(ownSession, 'saved.txt')
    symlinkSync(credentials, ownLink)
    const codexFolder = join(run.dirs.userHome, '.codex')
    const tryWrite = (label: string, shell: string) => `if ${shell} 2>/dev/null; then echo "wrote ${label}"; else echo "denied ${label}"; fi`
    const commands = [
      ...[...closed, settings, ordinary].map((path) => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo "read ${path}"; else echo "denied ${path}"; fi`),
      `grep -r ${mark} ${JSON.stringify(run.dirs.userHome)} ${JSON.stringify(mousseHome)} || echo "found none"`,
      tryWrite('beside', `echo new > ${JSON.stringify(join(run.dirs.userHome, 'new.txt'))}`),
      tryWrite('codex config', `echo changed >> ${JSON.stringify(join(codexFolder, 'config.toml'))}`),
      tryWrite('moved codex', `mv ${JSON.stringify(codexFolder)} ${JSON.stringify(`${codexFolder}-moved`)}`),
      tryWrite('moved home', `mv ${JSON.stringify(run.dirs.userHome)} ${JSON.stringify(`${run.dirs.userHome}-moved`)}`),
      tryWrite('system', 'echo x > /etc/mousse-bot-test'),
      tryWrite('own link', `ln -s ${JSON.stringify(cookies)} ${JSON.stringify(join(ownSession, 'cookie-link'))}`)
    ]
    plans.closed = [
      ...commands.map((command) => ({ name: 'Bash', input: { command, description: 'Try one file boundary' } })),
      { name: 'Read', input: { file_path: credentials } },
      { name: 'Read', input: { file_path: join(linkToHome, '.credentials.json') } },
      { name: 'Read', input: { file_path: settings } },
      { name: 'Read', input: { file_path: ownLink } }
    ]
    // What compile gives a bot with file access, for this test's homes.
    const outside = botClosedPlaces({ mousseHome, env: { CLAUDE_CONFIG_DIR: run.dirs.instanceHome, MOUSSE_ELECTRON_USER_DATA: electron }, userHome: run.dirs.userHome, temps: systemTempDirs(), entryEnvs: [] })
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read', 'list', 'search', 'edit', 'write', 'shell'], appTools: [], mcp: [], skills: [], workspace: { roots: ['/'], access: 'write', writeRoots: ['/'], scratch: run.dirs.scratch, files: run.dirs.files, computer: { closed: mousseHome, outside } } },
      waiting: () => false, counters: { charge: vi.fn(() => ({ ok: true as const, count: 1 })) as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const locked: ClaudeLockedTurn = { authority, ownerEntry: true, ledger: run.ledger, cwd: run.dirs.files, shellContained: true, temps: systemTempDirs(), systemPrompt: 'You are a test bot.' }
    const text = await run.service.chat({ threadId: 'bot-closed', cwd: run.dirs.files, model: 'claude-sonnet-4-5', prompt: 'PLAN:closed', permissionMode: 'ask', locked, mcp: null, onText: () => undefined })
    expect(text).toContain('done')
    const said = run.anthropic.results('closed').join('\n')
    for (const path of closed) expect(said, path).toContain(`denied ${path}`)
    expect(said).toContain(`read ${settings}`)
    expect(said).toContain(`read ${ordinary}`)
    expect(said).toContain('found none')
    expect(said).not.toContain(`secret ${mark}`)
    // Its commands: a new file beside the closed places, and a change to Codex's config, are written; moving the folder a
    // closed place is in, or one above it, a system folder and a link in Claude Code's own storage are not.
    for (const done of ['wrote beside', 'wrote codex config', 'denied moved codex', 'denied moved home', 'denied system', 'denied own link']) expect(said).toContain(done)
    expect(existsSync(join(run.dirs.userHome, 'new.txt'))).toBe(true)
    expect(existsSync(codexAuth)).toBe(true)
    expect(existsSync(join(ownSession, 'cookie-link'))).toBe(false)
    // The file tool: Claude Code's credentials refused, by name, through the link and through the link in its own
    // storage; its settings beside them read.
    expect(new Set(said.split('\n').filter((line) => line.includes('sign-in, which no bot may use'))).size).toBe(3)
    expect(said).toContain('"ordinary": "settings"')
    // Claude Code itself read its own credentials file for every model request; the bot saw none of it.
    const auths = run.anthropic.requests.filter((request) => request.plan === 'closed').map((request) => request.auth)
    expect(auths.length).toBeGreaterThan(0)
    expect(new Set(auths)).toEqual(new Set([`Bearer ${token}`]))
    expect(said).not.toContain(token)
    // The bot was told, in its instructions, what its commands can't change.
    expect(run.anthropic.requests.find((request) => request.plan === 'closed')!.system).toContain(CLAUDE_COMMAND_WRITE_LIMIT_TEXT)
  }, 120_000)

  it.skipIf(!hasBinary)(`a bot with file access searching a folder that holds places closed to bots: Grep and Glob find the files beside them and nothing inside one, several levels down, in the folder searched, behind a link inside it, or through the link searched${NO_BINARY}`, async () => {
    const plans: Record<string, Json[]> = { search: [] }
    const run = await rig(plans)
    const root = realpathSync(run.dirs.root)
    const mark = `closedsearch${Date.now()}`
    // The Mousse home in the folder searched; the app's Electron user data several levels below it; the owner's home with
    // Codex's sign-in and Claude Code's global config; an ordinary folder with a link into Codex's home; a link to the
    // owner's home beside it. Beside the closed places, ordinary files and Codex's config stay open.
    const mousseHome = join(root, '.mousse')
    const electron = join(root, 'deep', 'a', 'b', 'c', 'mousse-data')
    const home = join(root, 'home')
    const closed = [join(mousseHome, 'profiles', 'p1', 'bots', 'bots.db'), join(electron, 'Partitions', 'mousse-browser', 'Cookies'), join(home, '.codex', 'auth.json'), join(home, '.claude.json')]
    const open = [join(root, 'notes', 'plain.txt'), join(root, 'deep', 'a', 'other.txt'), join(home, '.codex', 'config.toml')]
    for (const file of closed) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `secret ${mark}\n`)
    }
    for (const file of open) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `ordinary ${mark}\n`)
    }
    symlinkSync(join(home, '.codex'), join(root, 'notes', 'codex-link'), 'junction')
    const homeLink = join(root, 'home-link')
    symlinkSync(home, homeLink, 'junction')
    plans.search = [
      { name: 'Grep', input: { pattern: mark, path: root, output_mode: 'content' } },
      { name: 'Grep', input: { pattern: mark, path: home, output_mode: 'files_with_matches' } },
      { name: 'Glob', input: { pattern: '**/*', path: root } },
      { name: 'Grep', input: { pattern: mark, path: join(root, 'notes'), output_mode: 'content' } },
      { name: 'Grep', input: { pattern: mark, path: homeLink, output_mode: 'content' } },
      { name: 'Glob', input: { pattern: '**/*.json', path: homeLink } }
    ]
    const outside = botClosedPlaces({ mousseHome, env: { CLAUDE_CONFIG_DIR: run.dirs.instanceHome, MOUSSE_ELECTRON_USER_DATA: electron }, userHome: home, temps: [], entryEnvs: [] })
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: ['read', 'list', 'search'], appTools: [], mcp: [], skills: [], workspace: { roots: [root], access: 'read', writeRoots: [], scratch: run.dirs.scratch, files: run.dirs.files, computer: { closed: mousseHome, outside } } },
      waiting: () => false, counters: { charge: vi.fn(() => ({ ok: true as const, count: 1 })) as never },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    const locked: ClaudeLockedTurn = { authority, ownerEntry: true, ledger: run.ledger, cwd: run.dirs.files, shellContained: false, temps: [], systemPrompt: 'You are a test bot.' }
    const text = await run.service.chat({ threadId: 'bot-search', cwd: run.dirs.files, model: 'claude-sonnet-4-5', prompt: 'PLAN:search', permissionMode: 'ask', locked, mcp: null, onText: () => undefined })
    expect(text).toContain('done')
    // Each request carries every result since the prompt: the last one holds the six.
    const results = run.anthropic.requests.filter((request) => request.plan === 'search').at(-1)!.results
    expect(results).toHaveLength(6)
    const said = results.join('\n')
    expect(said).not.toContain(`secret ${mark}`)
    for (const file of closed) expect(said, file).not.toContain(basename(file))
    expect(said).not.toContain('codex-link')
    // What the searches found: the ordinary files over the whole folder, Codex's config in the owner's home, and only
    // the ordinary file in the narrower folder.
    expect(results[0]).toContain(`ordinary ${mark}`)
    for (const file of open) expect(`${results[0]}\n${results[2]}`, file).toContain(basename(file))
    expect(results[1]).toContain('config.toml')
    expect(results[3]).toContain(`ordinary ${mark}`)
    expect(results[4]).toContain(`ordinary ${mark}`)
  }, 120_000)

  /** Each way the user's servers reach Claude Code: a startup channel, or its input (Windows). */
  const PATHS = [...CHANNELS.map((channel) => ({ name: channel, options: { channel } })), { name: 'input', options: { viaInput: POSIX } }]

  it.skipIf(!hasBinary).each(PATHS)(`a value that still holds \`\${\` reaches its server as Mousse resolved it, never expanded against Claude Code's environment ($name)${NO_BINARY}`, async ({ options }) => {
    const run = await rig({ first: [{ name: 'ToolSearch', input: { query: 'select:mcp__lit__literal', max_results: 5 } }, { name: 'mcp__lit__literal', input: {} }] }, options)
    const integrations = {
      mcpServers: {
        http: { type: 'http' as const, url: `${run.mcp.url}/literal?q=${LITERAL_QUERY}`, headers: { 'X-Literal': LITERAL } },
        lit: { type: 'stdio' as const, command: process.execPath, args: [run.literalServer, LITERAL_ARG], env: { LITERAL_ENV } }
      },
      proxiedServers: {}, toolRules: {}, warnings: []
    }
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations })).toContain('done')
    // Claude Code's environment has the instance's (fake) key and a home; neither reached a server, and no value changed.
    await vi.waitFor(() => expect(run.mcp.calls.filter((call) => call.path === '/literal').map((call) => call.credential)).toContain('literal'), { timeout: 30_000 })
    expect(run.mcp.calls.filter((call) => call.path === '/literal' && call.credential !== 'literal')).toEqual([])
    expect(run.anthropic.results('first').join('\n')).toContain('arg literal: true, env literal: true')
    clean(run.started[0]!)
  }, 120_000)

  it.skipIf(!hasBinary || CHANNELS.length === 0).each(CHANNELS)(`a config of about 500 KB, far larger than a socket or pipe buffer, reaches Claude Code whole (%s)${NO_BINARY}`, async (channel) => {
    const run = await rig({ first: [] }, { channel })
    const count = 250
    const mcpServers = Object.fromEntries(Array.from({ length: count }, (_, index) => [`bulk${index}`, { type: 'http' as const, url: `${run.mcp.url}/bulk/${index}`, headers: { 'X-Bulk': bulkHeader(index) } }]))
    expect(JSON.stringify(mcpServers).length).toBeGreaterThan(500_000)
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations: { mcpServers, proxiedServers: {}, toolRules: {}, warnings: [] } })).toContain('done')
    // Every server, the last included, was reached with its own whole header.
    await vi.waitFor(() => expect(new Set(run.mcp.calls.filter((call) => call.path.startsWith('/bulk/') && call.method === 'initialize' && call.credential === 'bulk').map((call) => call.path)).size).toBe(count), { timeout: 60_000, interval: 200 })
    clean(run.started[0]!)
  }, 180_000)

  it.skipIf(!hasBinary || !POSIX)(`a Claude Code that writes a lot to its error stream does not stall: Mousse reads it to the end${NO_BINARY}${NO_POSIX}`, async () => {
    const run = await rig({ first: [{ name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping,mcp__web__ping', max_results: 5 } }, { name: 'mcp__mousse__ping', input: {} }, { name: 'mcp__web__ping', input: {} }] }, { stderrFlood: true })
    expect(await personTurn(run, 'PLAN:first', TOKEN)).toContain('done')
    // Mousse's own spawn ran it (the user's servers came through the startup channel), and nothing but Mousse read the
    // 2 MB it wrote before it became Claude Code, which then had its servers.
    expect(run.started[0]!.args).toContain('--mcp-config')
    expect(run.stderrBytes.size).toBe(0)
    expect(run.anthropic.results('first').join('\n')).toContain('pong from /user')
  }, 120_000)

  it.skipIf(!hasBinary || !POSIX)(`a server that connects after the turn started is offered to the model from the next request it makes, in the same turn${NO_BINARY}${NO_POSIX}`, async () => {
    // 6 s: past the 3 s Claude Code's first turn waits for the user's servers.
    const run = await rig({
      first: [{ name: 'Bash', input: { command: 'sleep 8', description: 'Wait' } }, { name: 'Bash', input: { command: 'echo after', description: 'After' } }],
      second: [{ name: 'mcp__slow__late', input: {} }]
    })
    const integrations = { mcpServers: { slow: { type: 'stdio' as const, command: process.execPath, args: [run.slowServer, '6000'] } }, proxiedServers: {}, toolRules: {}, warnings: [] }
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations })).toContain('done')
    run.service.commitConversation('thread', '')
    const first = run.anthropic.requests.filter((request) => request.plan === 'first').map((request) => request.offered.includes('mcp__slow__late'))
    console.info(`[#358 evidence] late server offered per request of the first turn: ${JSON.stringify(first)}; notices: ${JSON.stringify(run.notices)}`)
    expect(run.notices).toEqual(['Claude started this turn without an MCP server: slow (still starting; it is offered once it has connected).'])
    expect(first[0]).toBe(false)
    expect(first.at(-1)).toBe(true)
    expect(await personTurn(run, 'PLAN:second', TOKEN, { integrations })).toContain('done')
    expect(run.anthropic.results('second').join('\n')).toContain('late but here')
  }, 120_000)

  it.skipIf(!hasBinary)(`over Claude Code's input (Windows), four user stdio servers that hang hold the turn about 10 s, not a minute${NO_BINARY}`, async () => {
    const run = await rig({ first: [{ name: 'ToolSearch', input: { query: 'select:mcp__mousse__ping', max_results: 5 } }, { name: 'mcp__mousse__ping', input: {} }] }, { viaInput: POSIX })
    const hung = Object.fromEntries(['h1', 'h2', 'h3', 'h4'].map((name) => [name, { type: 'stdio' as const, command: process.execPath, args: [run.hungServer, join(run.dirs.pids, name)] }]))
    const startedAt = Date.now()
    expect(await personTurn(run, 'PLAN:first', TOKEN, { integrations: { mcpServers: hung, proxiedServers: {}, toolRules: {}, warnings: [] } })).toContain('done')
    const took = Date.now() - startedAt
    console.info(`[#358 evidence] four hung servers over the input held the turn ${took} ms`)
    expect(took).toBeLessThan(20_000)
    expect(run.started[0]!.env).toMatchObject({ MCP_TIMEOUT: '10000', MCP_SERVER_CONNECTION_BATCH_SIZE: '16' })
    expect(run.anthropic.results('first').join('\n')).toContain('pong from /mcp')
    // The hung servers are ended with Claude Code.
    await run.service.stop()
    for (const name of ['h1', 'h2', 'h3', 'h4']) {
      const file = join(run.dirs.pids, name)
      if (existsSync(file)) await vi.waitFor(() => expect(alive(Number(readFileSync(file, 'utf8')))).toBe(false), { timeout: 15_000, interval: 200 })
    }
  }, 120_000)
})
