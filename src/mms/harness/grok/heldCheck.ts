import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * on app start or a turn.
 *
 * Turns, in one held process and session, with a Claude Code allow rule for every tool in the person's settings and a
 * saved "always allow" answer for the MCP tool in the held home (the two things that let Grok skip asking): the stub
 * model calls one tool per prompt, every request to use it is refused, and each must have asked before any effect:
 * the fixture's secret never reaches a later request, no file appears or changes, and the MCP tool is never called.
 *
 * One-shots, in a headless run on the one-shot launch: the stub answers with a tool call that would write a file; one
 * model request reaches it, with no tools and Mousse's system text alone, and no file appears. A 429 is not sent again.
 *
 * The result is `undefined` when the check could not conclude (Grok did not start, the stub saw nothing, a timeout):
 * the last record stays.
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
  /** Why the check could not conclude, for the log. */
  log?: (line: string) => void
}

/** A turn item: the tool the stub model calls, and the effect that must not happen. */
interface TurnItem {
  id: string
  tool: string
  args: (paths: { project: string; secret: string; marker: string }) => Record<string, unknown>
}

const TURN_ITEMS: readonly TurnItem[] = [
  { id: 'read', tool: 'read_file', args: ({ secret }) => ({ target_file: secret }) },
  { id: 'list', tool: 'list_dir', args: ({ project }) => ({ target_directory: project }) },
  { id: 'search', tool: 'grep', args: ({ project }) => ({ pattern: 'MOUSSE-SECRET', path: project }) },
  { id: 'read-only shell', tool: 'run_terminal_command', args: () => ({ command: 'cat secret.txt', description: 'show' }) },
  { id: 'writing shell', tool: 'run_terminal_command', args: () => ({ command: 'touch marker.txt', description: 'mark' }) },
  { id: 'write', tool: 'write', args: ({ marker }) => ({ file_path: marker, content: 'x' }) },
  { id: 'edit', tool: 'search_replace', args: ({ secret }) => ({ file_path: secret, old_string: 'MOUSSE-SECRET', new_string: 'EDITED' }) },
  { id: 'MCP', tool: 'use_tool', args: () => ({ tool_name: 'mousse_check__mark', tool_input: {} }) },
  { id: 'subagent', tool: 'spawn_subagent', args: () => ({ prompt: 'Read secret.txt.', description: 'reader' }) }
]

/** Grok's own title request (it names its session), told apart from the turn's requests. */
const SIDE_REQUEST = 'generating the session title'
const TURN_DEADLINE_MS = 120_000
const ONE_SHOT_DEADLINE_MS = 60_000

export interface GrokHeldCheckResult extends GrokHeldRecord {}

export async function runGrokHeldCheck(launch: GrokCheckLaunch, signal: AbortSignal): Promise<GrokHeldCheckResult | undefined> {
  const platform = launch.platform ?? process.platform
  const root = mkdtempSync(join(tmpdir(), 'mousse-grok-check-'))
  try {
    const turns = await checkTurns(launch, join(root, 'turns'), signal)
    if (!turns) return undefined
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
    if (upper === 'GROK_XAI_API_BASE_URL' || upper === 'GROK_HOME') continue
    clean[name] = value
  }
  return withUserEnv(clean, {
    XAI_API_KEY: 'xai-mousse-check',
    GROK_XAI_API_BASE_URL: base,
    GROK_CLI_CHAT_PROXY_BASE_URL: base,
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_TELEMETRY_ENABLED: '0'
  }, platform)
}

interface StubRequest {
  url: string
  body: string
}

/** The stub model: answers each turn request from `next`, Grok's own title requests with text, MCP on `/mcp`. */
async function startStub(next: () => Record<string, unknown> | undefined, onMcpCall: () => void): Promise<{ server: Server; base: string; requests: StubRequest[] }> {
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
      if (body.includes(SIDE_REQUEST)) return streamResponse(res, undefined)
      return streamResponse(res, next())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}/v1`, requests }
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
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    const abort = () => reject(new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    })
  })
}

async function checkTurns(launch: GrokCheckLaunch, root: string, signal: AbortSignal): Promise<{ held: boolean; reason?: string; tools: string[] } | undefined> {
  const platform = launch.platform ?? process.platform
  const home = join(root, 'held-home')
  const user = join(root, 'user')
  const project = join(root, 'project')
  for (const dir of [home, join(user, '.claude'), project]) mkdirSync(dir, { recursive: true })
  if (launch.heldConfig === undefined) ensureGrokHeldHome(home)
  else writeFileSync(join(home, 'config.toml'), launch.heldConfig)
  const secretText = `MOUSSE-SECRET-${process.pid}-${Date.now()}`
  const secret = join(project, 'secret.txt')
  const marker = join(project, 'marker.txt')
  writeFileSync(secret, `${secretText}\n`)
  // What lets Grok skip asking: the person's Claude Code allow rules, and a saved "always allow" answer.
  writeFileSync(join(user, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'mcp__*'] } }))
  const grants = join(home, 'sessions', encodeURIComponent(project))
  mkdirSync(grants, { recursive: true })
  writeFileSync(join(grants, 'permission.toml'), 'allowed_mcp_tools = ["mousse_check__mark"]\nallowed_mcp_servers = ["mousse_check"]\n')

  let queued: Record<string, unknown> | undefined
  let mcpCalls = 0
  const stub = await startStub(() => {
    const call = queued
    queued = undefined
    return call
  }, () => { mcpCalls += 1 })
  const env = withUserEnv(grokHeldEnv(checkEnv(launch.env, stub.base, platform), home, platform), {
    GROK_AUTH_PATH: join(root, 'no-auth.json'),
    HOME: user,
    USERPROFILE: user,
    GROK_MEMORY: '0',
    GROK_TURN_SUMMARY: '0'
  }, platform)
  const child = spawn(launch.command, [...launch.args, ...grokArgs()], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr?.resume()
  let asked = 0
  const client = acpClient(child, (method, params) => {
    if (method !== 'session/request_permission') return undefined
    asked += 1
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
    const session = await deadline(client.request('session/new', { cwd: project, mcpServers: [{ type: 'http', name: 'mousse_check', url: stub.base.replace(/\/v1$/, '/mcp'), headers: [] }] }), TURN_DEADLINE_MS, signal) as { sessionId?: string }
    if (!session?.sessionId) return inconclusive(launch, 'no session')
    const failed: string[] = []
    let tools: string[] = []
    for (const item of TURN_ITEMS) {
      const before = asked
      const calledBefore = mcpCalls
      const seen = stub.requests.length
      queued = { name: item.tool, arguments: item.args({ project, secret, marker }) }
      await deadline(client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: `Mousse check: ${item.id}.` }] }), TURN_DEADLINE_MS, signal)
      const turnRequests = stub.requests.filter((request) => /\/responses$/.test(request.url) && !request.body.includes(SIDE_REQUEST))
      if (!tools.length && turnRequests[0]) tools = toolNames(turnRequests[0].body)
      // The stub must have handed the call out, or nothing was checked.
      if (queued) return inconclusive(launch, `the stub got no request for ${item.id}`)
      const leaked = stub.requests.slice(seen).some((request) => request.body.includes(secretText))
      const changed = existsSync(marker) || !readFileSync(secret, 'utf8').includes(secretText)
      if (asked === before || leaked || changed || mcpCalls !== calledBefore) failed.push(item.id)
    }
    if (!tools.length) return inconclusive(launch, 'no tools in the first request')
    return failed.length
      ? { held: false, reason: `Grok ran ${failed.join(', ')} without asking Mousse first.`, tools }
      : { held: true, tools }
  } catch (error) {
    return inconclusive(launch, `turns: ${error instanceof Error ? error.message : JSON.stringify(error)} (requests: ${stub.requests.map((request) => request.url).join(', ')})`)
  } finally {
    killTree(child)
    stub.server.close()
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

async function checkOneShot(launch: GrokCheckLaunch, root: string, tools: readonly string[], signal: AbortSignal): Promise<{ held: boolean; reason?: string } | undefined> {
  const platform = launch.platform ?? process.platform
  const system = `MOUSSE-CHECK-SYSTEM ${Date.now()}`
  const problems: string[] = []
  for (const answer of ['tool', 429] as const) {
    let status = 200
    const stub = await startStub(() => ({ name: 'run_terminal_command', arguments: { command: 'echo x > marker.txt', description: 'mark' } }), () => {})
    const folder = join(root, String(answer))
    const files = writeGrokOneShotFiles({ root: folder, system, prompt: 'Name this chat: fix the login bug' })
    const env = withUserEnv(grokOneShotEnv(checkEnv(launch.env, stub.base, platform), files, platform), { GROK_AUTH_PATH: join(folder, 'no-auth.json') }, platform)
    if (answer === 429) {
      status = 429
      stub.server.removeAllListeners('request')
      stub.server.on('request', (req: IncomingMessage, res: ServerResponse) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          stub.requests.push({ url: req.url ?? '', body })
          if (/\/responses$/.test(req.url ?? '')) return streamResponse(res, undefined, status)
          res.writeHead(404)
          res.end()
        })
      })
    }
    const child = spawn(launch.command, [...launch.args, ...grokOneShotArgs({ ...files, tools })], { cwd: files.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    try {
      await deadline(collectRun(child, signal, () => killTree(child)), ONE_SHOT_DEADLINE_MS, signal)
    } catch (error) {
      killTree(child)
      stub.server.close()
      return inconclusive(launch, `one-shot: ${error instanceof Error ? error.message : String(error)}`)
    }
    stub.server.close()
    const model = stub.requests.filter((request) => /\/responses$/.test(request.url))
    if (!model.length) return inconclusive(launch, `one-shot ${answer}: the stub got no model request`)
    if (model.length !== 1) problems.push(answer === 429 ? 'Grok sent a rate-limited request again.' : `Grok sent ${model.length} model requests for one.`)
    const body = model[0]!.body
    if (toolNames(body).length) problems.push('Grok offered tools in a request that runs none.')
    if (!systemIs(body, system)) problems.push('Grok sent a system prompt other than Mousse’s.')
    if (existsSync(join(files.cwd, 'marker.txt'))) problems.push('Grok ran a tool in a request that runs none.')
  }
  return problems.length ? { held: false, reason: [...new Set(problems)].join(' ') } : { held: true }
}

function systemIs(body: string, system: string): boolean {
  try {
    const parsed = JSON.parse(body) as { input?: Array<{ role?: string; content?: unknown }> }
    const systems = (parsed.input ?? []).filter((message) => message.role === 'system' || message.role === 'developer')
    return systems.length === 1 && (typeof systems[0]!.content === 'string' ? systems[0]!.content : JSON.stringify(systems[0]!.content)).trim() === system
  } catch {
    return false
  }
}
