import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { grokArgs } from '../acp/presets/grok'
import { withUserEnv } from '../cliConfig'
import { killTree } from '../spawn'
import { ensureGrokHeldHome, grokHeldEnv } from './held'
import { GROK_HELD_CHECK_VERSION, type GrokHeldRecord } from './heldEvidence'
import { collectRun, grokOneShotArgs, grokOneShotEnv, writeGrokOneShotFiles } from './oneShot'
import { GROK_CREDENTIAL_VARIABLES } from './variables'

/**
 * The held check: Grok's held launch and its one-shot route, run against the real Grok on this computer with a stub
 * model on the loopback and a dummy key, so no account is used and nothing the agent does leaves a fixture folder.
 * It runs in the background after a check of the entry finds a version it has no record for (`grokHeldRecord`), never
 * on app start or a turn. Each phase is its own Grok process; a Stop ends the check before its next process or phase.
 *
 * Turns. The stub model calls one tool per prompt; Mousse refuses every request to use it. Each item passes only when
 * a permission request for that very tool (its `rawInput.variant` where Grok names one, and its own arguments) came
 * before any effect, and the effect did not happen: the item's secret never reaches a later model request, no file
 * appears or changes, the MCP tool is never called, and no model request of the item's own (a subagent's) is sent.
 * - startup: the person's Claude Code allow rule for every tool and a saved "always allow" answer for the MCP tool in
 *   the held home (the two things that let Grok skip asking), plus inert startup markers: hooks and stdio MCP servers in
 *   the person's Claude Code, Cursor and Codex setups and in the project's `.mcp.json`, `.claude` and `.grok` config.
 *   No marker may run. Every tool the version offers must be an item here, internal (`INTERNAL_TOOLS`) or hosted.
 * - project config: the project trusted in the fixture's held home (a real held home never trusts one), with project
 *   config and Claude Code settings that allow every tool and remember answers: asking still wins.
 * - worktree: a git worktree whose main checkout has a saved "always allow" for the MCP tool: the worktree asks.
 *   Skipped where git does not run (no worktree can exist there).
 * Hosted tools (`web_search`, `x_search`) run on xAI's side and touch nothing on this computer; they are recorded, not
 * held. A client-side web tool would need an item: an offered tool the check does not know fails it.
 *
 * One-shots, in a headless run on the one-shot launch, with every proxy variable pointing at an observer that refuses
 * all it sees: the stub answers with a tool call that would write a file. One model request reaches it, with no tools,
 * Mousse's system text alone, the person's message as written, and no rule or skill from the fixture's home; no file
 * appears, and nothing is sent anywhere else (Grok's own title request goes to port 0, where nothing can receive it:
 * its delivery fails, the attempt is not prevented). A 429 is not sent again.
 *
 * The result is `undefined` when the check could not conclude (Grok did not start, the stub saw nothing, a timeout, a
 * Stop): the last record stays.
 */

export interface GrokCheckLaunch {
  /** The program, as turns run it (`program().resolved`). */
  command: string
  args: readonly string[]
  /** The environment the entry's native launch would have; credentials are removed before anything starts. */
  env: NodeJS.ProcessEnv
  cliVersion: string
  platform?: NodeJS.Platform
  /** Tests only: the held home's config in place of Mousse's, to show the check fails without it. */
  heldConfig?: string
  /** Tests only: variables of the held environment left out, to show what the check sees without each. */
  dropHeldEnv?: readonly string[]
  /** Why the check could not conclude, for the log. */
  log?: (line: string) => void
}

interface Fixture {
  project: string
  secret: string
  secretText: string
  /** A folder whose only entry is named by `listedText`. */
  listed: string
  listedText: string
  marker: string
  monitorMarker: string
}

type Effect = 'leak' | 'listing' | 'file' | 'edit' | 'mcp' | 'none'

/** A turn item: the tool the stub model calls, how its permission request is told apart, and the effect it must not have. */
interface TurnItem {
  id: string
  tool: string
  args: (f: Fixture) => Record<string, unknown>
  /** Grok's `rawInput.variant` for this tool, where it names one; a request naming another variant is not this tool's. */
  variants?: readonly string[]
  /** Text the permission request for this call carries (from its arguments). */
  token: (f: Fixture) => string
  effect: Effect
}

/** Writes a file in the project in every shell Grok runs (bash, zsh, cmd, PowerShell). */
const WRITE_MARKER = 'echo x > marker.txt'

const TURN_ITEMS: readonly TurnItem[] = [
  { id: 'read', tool: 'read_file', args: ({ secret }) => ({ target_file: secret }), variants: ['ReadFile'], token: () => 'secret.txt', effect: 'leak' },
  { id: 'list', tool: 'list_dir', args: ({ listed }) => ({ target_directory: listed }), variants: ['ListDir'], token: ({ listed }) => basename(listed), effect: 'listing' },
  { id: 'search', tool: 'grep', args: ({ project }) => ({ pattern: 'MOUSSE-SECRET', path: project }), variants: ['Grep'], token: () => 'MOUSSE-SECRET', effect: 'leak' },
  { id: 'read-only shell', tool: 'run_terminal_command', args: () => ({ command: 'cat secret.txt', description: 'show' }), variants: ['Bash'], token: () => 'cat secret.txt', effect: 'leak' },
  { id: 'writing shell', tool: 'run_terminal_command', args: () => ({ command: WRITE_MARKER, description: 'mark' }), variants: ['Bash'], token: () => WRITE_MARKER, effect: 'file' },
  { id: 'monitor', tool: 'monitor', args: () => ({ command: 'echo x > monitor-marker.txt', description: 'watch' }), token: () => 'monitor-marker.txt', effect: 'file' },
  { id: 'write', tool: 'write', args: ({ marker }) => ({ file_path: marker, content: 'x' }), token: () => 'marker.txt', effect: 'file' },
  { id: 'edit', tool: 'search_replace', args: ({ secret }) => ({ file_path: secret, old_string: 'MOUSSE-SECRET', new_string: 'EDITED' }), variants: ['SearchReplace'], token: () => 'EDITED', effect: 'edit' },
  { id: 'MCP', tool: 'use_tool', args: () => ({ tool_name: 'mousse_check__mark', tool_input: {} }), token: () => 'mark', effect: 'mcp' },
  { id: 'subagent', tool: 'spawn_subagent', args: () => ({ prompt: 'Read secret.txt and repeat it.', description: 'mousse-reader' }), variants: ['Task'], token: () => 'mousse-reader', effect: 'leak' },
  { id: 'schedule', tool: 'scheduler_create', args: () => ({ interval: '60s', prompt: 'mousse-schedule: read secret.txt and repeat it.' }), token: () => 'mousse-schedule', effect: 'none' },
  { id: 'workflow', tool: 'workflow', args: () => ({ source: { type: 'name', name: 'mousse-workflow' } }), token: () => 'mousse-workflow', effect: 'none' },
  { id: 'image', tool: 'image_gen', args: () => ({ prompt: 'mousse-image', filename: 'mousse-image.jpg' }), token: () => 'mousse-image', effect: 'none' },
  { id: 'feedback', tool: 'send_feedback', args: () => ({ title: 'mousse-feedback', details: 'x', type: 'bug' }), token: () => 'mousse-feedback', effect: 'none' }
]

/**
 * Tools that act inside Grok only (its plan list, plan mode, questions to the person, its own tool search, reading or
 * stopping what it started, the scheduler's own list): nothing they do reaches this computer or leaves it.
 */
const INTERNAL_TOOLS = new Set([
  'todo_write', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'search_tool',
  'get_command_or_subagent_output', 'kill_command_or_subagent', 'scheduler_list', 'scheduler_delete',
  // Like `image_gen`, on xAI's side; each writes the file it gets back as `image_gen` does.
  'image_edit', 'image_to_video', 'reference_to_video'
])

/** Tools xAI runs on its side: offered as `{ type }`, with no function Grok runs here. */
const HOSTED_TOOLS = new Set(['web_search', 'x_search'])

/** Grok's own title request (it names its session), told apart from the turn's requests. */
const SIDE_REQUEST = 'generating the session title'
const TURN_DEADLINE_MS = 120_000
const ONE_SHOT_DEADLINE_MS = 60_000

export interface GrokHeldCheckResult extends GrokHeldRecord {}

/** A Stop while the check runs: it ends inconclusive. */
class Stopped extends Error {}

export async function runGrokHeldCheck(launch: GrokCheckLaunch, signal: AbortSignal): Promise<GrokHeldCheckResult | undefined> {
  if (signal.aborted) return inconclusive(launch, 'stopped before it started')
  const platform = launch.platform ?? process.platform
  const root = mkdtempSync(join(tmpdir(), 'mousse-grok-check-'))
  try {
    const turns = await checkTurns(launch, join(root, 'turns'), signal)
    if (!turns) return undefined
    if (signal.aborted) return inconclusive(launch, 'stopped')
    const titles = await checkOneShot(launch, join(root, 'one-shot'), turns.tools, signal)
    if (!titles) return undefined
    const reasons = [turns.reason, titles.reason].filter(Boolean)
    return {
      cliVersion: launch.cliVersion,
      platform,
      turns: turns.held,
      titles: titles.held,
      tools: turns.tools,
      ...(reasons.length ? { reason: reasons.join(' ') } : {}),
      checkVersion: GROK_HELD_CHECK_VERSION,
      recordedAt: new Date().toISOString()
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}

/** The entry's environment without any credential, with a dummy key and the stub as every endpoint. */
function checkEnv(env: NodeJS.ProcessEnv, base: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase()
    if (GROK_CREDENTIAL_VARIABLES.some((pattern) => (pattern.endsWith('*') ? upper.startsWith(pattern.slice(0, -1)) : upper === pattern))) continue
    if (upper === 'GROK_XAI_API_BASE_URL' || upper === 'GROK_HOME' || /^(HTTPS?|ALL|NO)_PROXY$/.test(upper)) continue
    clean[name] = value
  }
  return withUserEnv(clean, {
    XAI_API_KEY: 'xai-mousse-check',
    GROK_XAI_API_BASE_URL: base,
    GROK_CLI_CHAT_PROXY_BASE_URL: base,
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_TELEMETRY_ENABLED: '0',
    // The markers run on the Node or Electron that runs Mousse.
    ELECTRON_RUN_AS_NODE: '1'
  }, platform)
}

interface StubRequest {
  url: string
  body: string
}

/** The stub model: answers each turn request from `next`, Grok's own title requests with text, MCP on `/mcp`. */
async function startStub(next: () => Record<string, unknown> | undefined, onMcpCall: () => void, status = 200): Promise<{ server: Server; base: string; requests: StubRequest[] }> {
  const requests: StubRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const url = req.url ?? ''
      requests.push({ url, body })
      if (url === '/mcp') return answerMcp(body, res, onMcpCall)
      if (!/\/responses$/.test(url)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"not here"}}')
        return
      }
      if (status !== 200) return streamResponse(res, undefined, status)
      if (body.includes(SIDE_REQUEST)) return streamResponse(res, undefined)
      return streamResponse(res, next())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}/v1`, requests }
}

/** A proxy that records every request and tunnel it is asked for, and refuses each one. */
async function startObserver(): Promise<{ url: string; seen: string[]; close: () => void }> {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(403)
    res.end()
  })
  server.on('connect', (req: IncomingMessage, socket: NodeJS.WritableStream & { end: (data: string) => void }) => {
    seen.push(`CONNECT ${req.url}`)
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() }
}

function answerMcp(body: string, res: ServerResponse, onCall: () => void): void {
  let message: { id?: unknown; method?: string; params?: { protocolVersion?: string } } = {}
  try {
    message = JSON.parse(body)
  } catch {
    // Answered as a notification.
  }
  if (message.id === undefined) {
    res.writeHead(202)
    res.end()
    return
  }
  let result: unknown = {}
  if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mousse_check', version: '1' } }
  else if (message.method === 'tools/list') result = { tools: [{ name: 'mark', description: 'Marks the check.', inputSchema: { type: 'object', properties: {} } }] }
  else if (message.method === 'tools/call') {
    onCall()
    result = { content: [{ type: 'text', text: 'marked' }] }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
}

/** One streamed Responses API answer: a function call when `call` is given, else a short text. */
function streamResponse(res: ServerResponse, call: Record<string, unknown> | undefined, status = 200): void {
  if (status !== 200) {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end(JSON.stringify({ error: { message: `stub ${status}` } }))
    return
  }
  const item = call
    ? { type: 'function_call', id: 'fc_1', call_id: `call_${Date.now()}`, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' }
    : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }
  const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
  const response = { id: 'resp_1', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: 'stub', output: [item], usage }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let sequence = 0
  const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
  event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
  event('response.output_item.added', { output_index: 0, item: { ...item, ...(call ? { arguments: '' } : { content: [] }), status: 'in_progress' } })
  if (call) event('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: (item as { arguments: string }).arguments })
  else {
    event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: 'Done' })
    event('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: 'Done' })
  }
  event('response.output_item.done', { output_index: 0, item })
  event('response.completed', { response })
  res.end()
}

/** A minimal ACP client over the child's stdio: requests, and a handler for the agent's own requests. */
function acpClient(child: ChildProcess, onRequest: (method: string, params: Record<string, unknown>) => unknown) {
  let buffer = ''
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  const send = (message: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.method && message.id !== undefined) {
        let result: unknown
        try {
          result = onRequest(message.method, message.params ?? {})
        } catch {
          result = undefined
        }
        if (result === undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
        else send({ id: message.id, result })
      } else if (!message.method && message.id !== undefined) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) waiter?.reject(message.error)
        else waiter?.resolve(message.result)
      }
    }
  })
  const failAll = (error: unknown) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  child.on('exit', () => failAll(new Error('Grok exited')))
  child.on('error', failAll)
  return {
    request: (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      send({ id, method, params })
    })
  }
}

function deadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped('stopped'))
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    const abort = () => reject(new Stopped('stopped'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    })
  })
}

/** A permission request Grok sent: the tool call it names. */
interface Asked {
  variant?: string
  text: string
}

interface PhaseResult {
  failed: string[]
  tools: string[]
}

/**
 * Inert startup markers: hooks and stdio MCP servers that, if Grok starts them, leave a file named after themselves in
 * `markers`. Returns a reader of the markers left.
 */
function writeStartupMarkers(user: string, project: string, markers: string): () => string[] {
  mkdirSync(markers, { recursive: true })
  const script = join(markers, 'mark.cjs')
  writeFileSync(script, `require('fs').writeFileSync(require('path').join(${JSON.stringify(markers)}, process.argv[2] + '-' + process.pid), 'x')\n`)
  const run = (name: string) => `"${process.execPath}" "${script}" ${name}`
  const hooks = (name: string) => ({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse'].map((event) => [event, [{ matcher: '*', hooks: [{ type: 'command', command: run(`${name}-${event}`) }] }]])) })
  const server = (name: string) => ({ command: process.execPath, args: [script, name], env: { ELECTRON_RUN_AS_NODE: '1' } })
  const tomlServer = (name: string) => `[mcp_servers.mark]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}, ${JSON.stringify(name)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\n`
  const put = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  // The person's own setups.
  put(join(user, '.claude', 'settings.json'), JSON.stringify(hooks('claude-user-hook')))
  put(join(user, '.claude.json'), JSON.stringify({ mcpServers: { mark: server('claude-user-mcp') } }))
  put(join(user, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { mark: server('cursor-user-mcp') } }))
  put(join(user, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: run('cursor-user-hook') }], beforeShellExecution: [{ command: run('cursor-user-hook-shell') }] } }))
  put(join(user, '.codex', 'config.toml'), tomlServer('codex-user-mcp'))
  put(join(user, '.codex', 'hooks.json'), JSON.stringify(hooks('codex-user-hook')))
  // The project's.
  put(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { mark: server('claude-project-mcp') } }))
  put(join(project, '.claude', 'settings.json'), JSON.stringify(hooks('claude-project-hook')))
  put(join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { mark: server('cursor-project-mcp') } }))
  put(join(project, '.grok', 'config.toml'), `${tomlServer('grok-project-mcp')}\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(run('grok-project-hook'))}\n`)
  return () => (existsSync(markers) ? readdirSync(markers).filter((name) => name !== 'mark.cjs') : [])
}

/** Trusts `folder` in a Grok home, as Grok's own trust prompt would. */
function trustFolder(home: string, folder: string): void {
  writeFileSync(join(home, 'trusted_folders.toml'), `[folders.'${folder}']\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`)
}

/** The folder Grok keeps a project's saved answers in, under a home. */
const grantsOf = (home: string, project: string) => join(home, 'sessions', encodeURIComponent(project))

function saveMcpGrant(home: string, project: string): void {
  mkdirSync(grantsOf(home, project), { recursive: true })
  writeFileSync(join(grantsOf(home, project), 'permission.toml'), 'allowed_mcp_tools = ["mousse_check__mark"]\nallowed_mcp_servers = ["mousse_check"]\n')
}

/** A project with its secret, a listed folder and the file names the items look for. */
function writeProject(project: string): Fixture {
  mkdirSync(project, { recursive: true })
  const stamp = `${process.pid}-${Date.now()}`
  const secretText = `MOUSSE-SECRET-${stamp}`
  const listedText = `MOUSSE-LISTED-${stamp}`
  const secret = join(project, 'secret.txt')
  const listed = join(project, 'listed')
  writeFileSync(secret, `${secretText}\n`)
  mkdirSync(listed)
  writeFileSync(join(listed, `${listedText}.txt`), '')
  return { project, secret, secretText, listed, listedText, marker: join(project, 'marker.txt'), monitorMarker: join(project, 'monitor-marker.txt') }
}

/**
 * One held Grok process in `fixture.project`, through `items`: each item passes when its own permission request came and
 * none of its effects happened. Returns the failed items, and the tools the first model request offered.
 */
async function runItems(launch: GrokCheckLaunch, input: { home: string; user: string; fixture: Fixture; items: readonly TurnItem[]; label: string }, signal: AbortSignal): Promise<PhaseResult> {
  const platform = launch.platform ?? process.platform
  const { fixture, home, user } = input
  if (signal.aborted) throw new Stopped('stopped')
  let queued: Record<string, unknown> | undefined
  let mcpCalls = 0
  const stub = await startStub(() => {
    const call = queued
    queued = undefined
    return call
  }, () => { mcpCalls += 1 })
  let env = withUserEnv(grokHeldEnv(checkEnv(launch.env, stub.base, platform), home, platform), {
    GROK_AUTH_PATH: join(home, '..', 'no-auth.json'),
    HOME: user,
    USERPROFILE: user,
    GROK_MEMORY: '0',
    GROK_TURN_SUMMARY: '0'
  }, platform)
  if (launch.dropHeldEnv?.length) {
    env = { ...env }
    for (const name of launch.dropHeldEnv) delete env[name]
  }
  const child = spawn(launch.command, [...launch.args, ...grokArgs()], { cwd: fixture.project, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr?.resume()
  let asked: Asked[] = []
  const client = acpClient(child, (method, params) => {
    if (method !== 'session/request_permission') return undefined
    const call = (params.toolCall ?? {}) as { rawInput?: { variant?: unknown } }
    asked.push({ ...(typeof call.rawInput?.variant === 'string' ? { variant: call.rawInput.variant } : {}), text: JSON.stringify(call) })
    const options = (params.options ?? []) as Array<{ optionId: string; kind: string }>
    const reject = options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind.startsWith('reject'))
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } }
  })
  try {
    await deadline(client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'Mousse check', version: '1' },
      _meta: { clientType: 'extension' }
    }), TURN_DEADLINE_MS, signal)
    // Each item in a session of its own: what one item let through never sits in the next one's conversation.
    const newSession = async (): Promise<string> => {
      const session = await deadline(client.request('session/new', { cwd: fixture.project, mcpServers: [{ type: 'http', name: 'mousse_check', url: stub.base.replace(/\/v1$/, '/mcp'), headers: [] }] }), TURN_DEADLINE_MS, signal) as { sessionId?: string }
      if (!session?.sessionId) throw new Error(`${input.label}: no session`)
      return session.sessionId
    }
    const failed: string[] = []
    let tools: string[] = []
    for (const item of input.items) {
      if (signal.aborted) throw new Stopped('stopped')
      asked = []
      const calledBefore = mcpCalls
      const seen = stub.requests.length
      const prompt = `Mousse check: ${item.id}.`
      queued = { name: item.tool, arguments: item.args(fixture) }
      const sessionId = await newSession()
      await deadline(client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }), TURN_DEADLINE_MS, signal)
      // The stub must have handed the call out, or nothing was checked.
      if (queued) throw new Error(`${input.label}: the stub got no request for ${item.id}`)
      const model = stub.requests.slice(seen).filter((request) => /\/responses$/.test(request.url) && !request.body.includes(SIDE_REQUEST))
      if (!tools.length && model[0]) tools = toolNames(model[0].body)
      const token = item.token(fixture)
      const own = asked.filter((request) => request.text.includes(token) && (!item.variants || !request.variant || item.variants.includes(request.variant)))
      const watched = item.effect === 'listing' ? fixture.listedText : fixture.secretText
      // A token already in the request that made the call would make the effect check say nothing.
      if ((item.effect === 'leak' || item.effect === 'listing') && model[0]?.body.includes(watched)) throw new Error(`${input.label}: ${item.id}'s secret was in the request before the tool ran`)
      const leaked = model.slice(1).some((request) => request.body.includes(watched))
      const effect =
        item.effect === 'leak' || item.effect === 'listing' ? leaked
          : item.effect === 'file' ? existsSync(fixture.marker) || existsSync(fixture.monitorMarker)
            : item.effect === 'edit' ? !readFileSync(fixture.secret, 'utf8').includes(fixture.secretText)
              : item.effect === 'mcp' ? mcpCalls !== calledBefore
                : false
      // Model requests that are not this conversation's: a subagent or another agent Grok started on its own.
      const side = model.some((request) => !request.body.includes(prompt))
      if (!own.length || effect || side) {
        failed.push(item.id)
        launch.log?.(`Grok held check, ${input.label}: ${item.id} failed (asked: ${own.length ? 'yes' : `no; requests: ${asked.map((request) => request.text.slice(0, 300)).join(' | ') || 'none'}`}; effect: ${effect}; side requests: ${side})`)
      }
    }
    return { failed, tools }
  } finally {
    killTree(child)
    stub.server.close()
  }
}

async function checkTurns(launch: GrokCheckLaunch, root: string, signal: AbortSignal): Promise<{ held: boolean; reason?: string; tools: string[] } | undefined> {
  const reasons: string[] = []
  let tools: string[] = []
  const heldHome = (home: string) => {
    if (launch.heldConfig === undefined) ensureGrokHeldHome(home)
    else {
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.toml'), launch.heldConfig)
    }
  }
  const item = (id: string) => TURN_ITEMS.find((candidate) => candidate.id === id)!
  try {
    // Startup sources, and every item, with what lets Grok skip asking in place.
    {
      const home = join(root, 'startup', 'held-home')
      const user = join(root, 'startup', 'user')
      heldHome(home)
      const fixture = writeProject(join(root, 'startup', 'project'))
      const markers = writeStartupMarkers(user, fixture.project, join(root, 'startup', 'markers'))
      // The person's Claude Code allow rules sit beside the hooks in their settings.
      const settings = join(user, '.claude', 'settings.json')
      writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), permissions: { allow: ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'mcp__*'] } }))
      saveMcpGrant(home, fixture.project)
      const result = await runItems(launch, { home, user, fixture, items: TURN_ITEMS, label: 'startup' }, signal)
      tools = result.tools
      if (!tools.length) return inconclusive(launch, 'no tools in the first request')
      if (result.failed.length) reasons.push(`Grok ran ${result.failed.join(', ')} without asking Mousse first.`)
      const started = markers()
      if (started.length) reasons.push(`Grok started ${[...new Set(started.map((name) => name.replace(/-\d+$/, '')))].sort().join(', ')} without asking Mousse first.`)
      const checked = new Set(TURN_ITEMS.map((candidate) => candidate.tool))
      const unknown = tools.filter((tool) => !checked.has(tool) && !INTERNAL_TOOLS.has(tool) && !HOSTED_TOOLS.has(tool))
      if (unknown.length) reasons.push(`Grok offers ${unknown.join(', ')}, which Mousse's check does not cover yet.`)
    }
    // Project config that allows everything and remembers answers, in a project the fixture's held home trusts.
    {
      const home = join(root, 'project', 'held-home')
      const user = join(root, 'project', 'user')
      mkdirSync(user, { recursive: true })
      heldHome(home)
      const fixture = writeProject(join(root, 'project', 'project'))
      mkdirSync(join(fixture.project, '.grok'), { recursive: true })
      mkdirSync(join(fixture.project, '.claude'), { recursive: true })
      writeFileSync(join(fixture.project, '.grok', 'config.toml'), '[permission]\nrules = [ { action = "allow", tool = "any" } ]\n\n[ui]\nremember_tool_approvals = true\n')
      writeFileSync(join(fixture.project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'mcp__*'], defaultMode: 'bypassPermissions' } }))
      trustFolder(home, fixture.project)
      saveMcpGrant(home, fixture.project)
      const result = await runItems(launch, { home, user, fixture, items: ['read', 'writing shell', 'MCP'].map(item), label: 'project config' }, signal)
      if (result.failed.length) reasons.push(`With a project's own config, Grok ran ${result.failed.join(', ')} without asking Mousse first.`)
    }
    // A worktree whose main checkout has a saved answer.
    const worktree = makeWorktree(join(root, 'worktree'))
    if (worktree) {
      const home = join(root, 'worktree', 'held-home')
      const user = join(root, 'worktree', 'user')
      mkdirSync(user, { recursive: true })
      heldHome(home)
      const fixture = writeProject(worktree.worktree)
      saveMcpGrant(home, worktree.main)
      const result = await runItems(launch, { home, user, fixture, items: [item('MCP')], label: 'worktree' }, signal)
      if (result.failed.length) reasons.push('In a worktree, Grok took its main checkout\'s saved answer and ran MCP without asking Mousse first.')
    } else launch.log?.('Grok held check: git does not run here, so the worktree phase was skipped (no worktree can exist).')
  } catch (error) {
    return inconclusive(launch, `turns: ${error instanceof Error ? error.message : JSON.stringify(error)}`)
  }
  return reasons.length ? { held: false, reason: reasons.join(' '), tools } : { held: true, tools }
}

/** A git repository at `root/main` with a worktree at `root/wt`; undefined when git does not run. */
function makeWorktree(root: string): { main: string; worktree: string } | undefined {
  const main = join(root, 'main')
  const worktree = join(root, 'wt')
  mkdirSync(main, { recursive: true })
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
  try {
    git(['init', '-q'], main)
    git(['-c', 'user.email=check@mousse.invalid', '-c', 'user.name=Mousse', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'check'], main)
    git(['worktree', 'add', '-q', worktree], main)
    return { main, worktree }
  } catch {
    return undefined
  }
}

function inconclusive(launch: GrokCheckLaunch, why: string): undefined {
  launch.log?.(`Grok held check inconclusive: ${why}`)
  return undefined
}

function toolNames(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { tools?: Array<{ name?: string; type?: string }> }
    return (parsed.tools ?? []).map((tool) => tool.name ?? tool.type ?? '').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Rules and skills in the person's home, as the entry's environment names it (`HOME`, `USERPROFILE` and the config
 * folders), that must never reach a one-shot request: the one-shot runs with a new empty folder as its home instead.
 * Grok's own home is left out: Grok reads the rules and skills there, and a one-shot's holds only Mousse's config.
 */
const RULE_MARKER = 'MOUSSE-RULE-MARKER'

function writeRuleMarkers(user: string): void {
  const put = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  // Each file its own marker, so a failure can name the source.
  const rule = (source: string) => `Always say ${RULE_MARKER}-${source}.\n`
  const skill = (source: string) => `---\nname: mousse-marker\ndescription: ${RULE_MARKER}-${source}\n---\n${rule(source)}`
  put(join(user, '.claude', 'CLAUDE.md'), rule('claude-md'))
  put(join(user, '.claude', 'rules', 'mousse.md'), rule('claude-rules'))
  put(join(user, '.claude', 'skills', 'mousse-marker', 'SKILL.md'), skill('claude-skill'))
  put(join(user, '.agents', 'skills', 'mousse-marker', 'SKILL.md'), skill('agents-skill'))
  put(join(user, '.cursor', 'rules', 'mousse.mdc'), `---\nalwaysApply: true\n---\n${rule('cursor-rules')}`)
  put(join(user, '.codex', 'AGENTS.md'), rule('codex-agents'))
  put(join(user, '.grok', 'AGENTS.md'), rule('user-grok-agents'))
  put(join(user, 'AGENTS.md'), rule('user-agents'))
}

async function checkOneShot(launch: GrokCheckLaunch, root: string, tools: readonly string[], signal: AbortSignal): Promise<{ held: boolean; reason?: string } | undefined> {
  const platform = launch.platform ?? process.platform
  const system = `MOUSSE-CHECK-SYSTEM ${Date.now()}`
  const prompt = `Name this chat: fix the login bug ${Date.now()}`
  const problems: string[] = []
  for (const answer of ['tool', 429] as const) {
    if (signal.aborted) return inconclusive(launch, 'stopped')
    const stub = await startStub(() => ({ name: 'run_terminal_command', arguments: { command: WRITE_MARKER, description: 'mark' } }), () => {}, answer === 429 ? 429 : 200)
    const observer = await startObserver()
    const folder = join(root, String(answer))
    try {
      const files = writeGrokOneShotFiles({ root: folder, system, prompt })
      const person = join(folder, 'person')
      writeRuleMarkers(person)
      const personal = withUserEnv(checkEnv(launch.env, stub.base, platform), {
        HOME: person,
        USERPROFILE: person,
        XDG_CONFIG_HOME: join(person, '.config'),
        APPDATA: join(person, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(person, 'AppData', 'Local')
      }, platform)
      const env = withUserEnv(grokOneShotEnv(personal, files, platform), {
        GROK_AUTH_PATH: join(folder, 'no-auth.json'),
        HTTP_PROXY: observer.url,
        HTTPS_PROXY: observer.url,
        ALL_PROXY: observer.url,
        NO_PROXY: `127.0.0.1,localhost,${new URL(stub.base).host}`
      }, platform)
      const child = spawn(launch.command, [...launch.args, ...grokOneShotArgs({ ...files, tools })], { cwd: files.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      try {
        await deadline(collectRun(child, signal, () => killTree(child)), ONE_SHOT_DEADLINE_MS, signal)
      } catch (error) {
        killTree(child)
        return inconclusive(launch, `one-shot: ${error instanceof Error ? error.message : String(error)}`)
      }
      const model = stub.requests.filter((request) => /\/responses$/.test(request.url))
      if (!model.length) return inconclusive(launch, `one-shot ${answer}: the stub got no model request`)
      if (model.length !== 1) problems.push(answer === 429 ? 'Grok sent a rate-limited request again.' : `Grok sent ${model.length} model requests for one.`)
      const body = model[0]!.body
      if (toolNames(body).length) problems.push('Grok offered tools in a request that runs none.')
      if (!systemIs(body, system)) problems.push('Grok sent a system prompt other than Mousse’s.')
      if (!userMessageIs(body, prompt)) problems.push('Grok changed the message Mousse sent.')
      const rules = [...new Set(body.match(new RegExp(`${RULE_MARKER}-[a-z-]+`, 'g')) ?? [])]
      if (rules.length) launch.log?.(`Grok held check, one-shot: the request carried ${rules.join(', ')}`)
      if (rules.length) problems.push('Grok added rules or skills from the person’s setup to a request that should carry Mousse’s text alone.')
      if (existsSync(join(files.cwd, 'marker.txt'))) problems.push('Grok ran a tool in a request that runs none.')
      // Everything off the loopback goes through the observer, which refuses it.
      if (observer.seen.length) problems.push(`Grok sent requests elsewhere in a request that sends one (${[...new Set(observer.seen)].join(', ')}).`)
    } finally {
      observer.close()
      stub.server.close()
    }
  }
  return problems.length ? { held: false, reason: [...new Set(problems)].join(' ') } : { held: true }
}

/** The text of a message's content: a string, or its text parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('')
  return JSON.stringify(content)
}

function messagesOf(body: string): Array<{ role?: string; content?: unknown }> {
  try {
    return (JSON.parse(body) as { input?: Array<{ role?: string; content?: unknown }> }).input ?? []
  } catch {
    return []
  }
}

function systemIs(body: string, system: string): boolean {
  const systems = messagesOf(body).filter((message) => message.role === 'system' || message.role === 'developer')
  return systems.length === 1 && textOf(systems[0]!.content).trim() === system
}

/** The person's message reaches the model as written: one user message carries it, unchanged, and no other carries it. */
function userMessageIs(body: string, prompt: string): boolean {
  const users = messagesOf(body).filter((message) => message.role === 'user').map((message) => textOf(message.content))
  return users.filter((text) => text.includes(prompt)).length === 1 && users.some((text) => text.trim() === prompt.trim())
}
