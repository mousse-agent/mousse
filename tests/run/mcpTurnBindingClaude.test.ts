/**
 * The Claude Code `per_call` turn binding (PR 2 §2): Mousse's `PreToolUse` hook stamps each Mousse
 * call with the turn token through `updatedInput`. This checks that Claude Code forwards that key to
 * an HTTP MCP server's `tools/call` arguments in every permission path Mousse uses. The real native
 * binary runs against a localhost Messages API mock (fake key, temp config dir and home) and a
 * localhost Streamable HTTP MCP server that records the raw arguments of each call.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type CanUseTool, type HookCallbackMatcher, type HookEvent, type Options } from '@anthropic-ai/claude-agent-sdk'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'

const BINARY = join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const hasBinary = process.platform === 'win32' && existsSync(BINARY)
const TOOL = 'mcp__mousse__thread_read'
const TOKEN = 'tok-123'

type Json = Record<string, unknown>

interface Listening {
  url: string
  close: () => Promise<void>
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Listening & { http: HttpServer }> {
  const sockets = new Set<Socket>()
  const http = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(String(error))
    })
  })
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  return {
    http,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

/** The Messages API, scripted: (ToolSearch if the tool is deferred), then `thread_read {limit: 5}`, then "done". */
async function anthropicMock(): Promise<Listening & { paths: string[]; toolsSeen: string[][]; historyInputs: Json[] }> {
  const paths: string[] = []
  const toolsSeen: string[][] = []
  /** The `thread_read` inputs as Claude Code sends them back to the model in later requests. */
  const historyInputs: Json[] = []
  let ids = 0
  const server = await listen(async (req, res) => {
    paths.push(`${req.method} ${req.url}`)
    const raw = await readBody(req)
    const path = (req.url ?? '').split('?')[0]
    if (path.endsWith('/count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    if (req.method !== 'POST' || path !== '/v1/messages') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock' } }))
      return
    }
    const body = JSON.parse(raw) as { model: string; stream?: boolean; tools?: Array<{ name: string; defer_loading?: boolean }>; messages: Array<{ role: string; content: unknown }> }
    const tools = body.tools ?? []
    toolsSeen.push(tools.filter((tool) => tool.name === TOOL || tool.name === 'ToolSearch').map((tool) => `${tool.name}${tool.defer_loading ? ' (deferred)' : ''}`))
    const called = new Set<string>()
    for (const message of body.messages)
      if (message.role === 'assistant' && Array.isArray(message.content))
        for (const block of message.content as Json[])
          if (block.type === 'tool_use') {
            called.add(String(block.name))
            if (block.name === TOOL) historyInputs.push(block.input as Json)
          }
    const target = tools.find((tool) => tool.name === TOOL)
    let block: Json
    if (!tools.length || called.has(TOOL)) block = { type: 'text', text: 'done' }
    else if (target && !target.defer_loading) block = { type: 'tool_use', id: `toolu_mock_${++ids}`, name: TOOL, input: { limit: 5 } }
    else if (tools.some((tool) => tool.name === 'ToolSearch') && !called.has('ToolSearch'))
      block = { type: 'tool_use', id: `toolu_mock_${++ids}`, name: 'ToolSearch', input: { query: `select:${TOOL}`, max_results: 1 } }
    else if (target) block = { type: 'tool_use', id: `toolu_mock_${++ids}`, name: TOOL, input: { limit: 5 } }
    else block = { type: 'text', text: 'done' }
    const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
    const message = {
      id: `msg_mock_${++ids}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [] as Json[],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 }
    }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
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
  })
  return { ...server, paths, toolsSeen, historyInputs }
}

/** A stateless Streamable HTTP MCP server with one tool, `thread_read`, recording each call's raw arguments. */
async function mcpMock(): Promise<Listening & { calls: Json[] }> {
  const calls: Json[] = []
  const server = await listen(async (req, res) => {
    if (req.headers.authorization !== 'Bearer x') {
      res.writeHead(401).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const body = JSON.parse(await readBody(req)) as unknown
    const mcp = new Server({ name: 'mousse', version: '0.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'thread_read',
          description: 'Reads a thread.',
          inputSchema: { type: 'object' as const, properties: { limit: { type: 'number' } } }
        }
      ]
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push({ name: request.params.name, arguments: request.params.arguments })
      return { content: [{ type: 'text' as const, text: 'thread contents' }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => {
      void transport.close().catch(() => undefined)
      void mcp.close().catch(() => undefined)
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  })
  return { ...server, url: `${server.url}/mcp`, calls }
}

interface Scenario {
  permissionMode: 'bypassPermissions' | 'default'
  /** What the hook returns besides `updatedInput` for the Mousse tool. */
  decision?: 'allow' | 'ask'
  /** Forces Claude Code's ToolSearch deferral of MCP tools (off by default with a non-Anthropic base URL). */
  toolSearch?: boolean
}

interface Outcome {
  mcpCalls: Json[]
  hookInputs: unknown[]
  canUseToolCalls: Array<{ toolName: string; args: Json }>
  paths: string[]
  toolsSeen: string[][]
  historyInputs: Json[]
  result: string | undefined
}

describe('PreToolUse updatedInput reaching an HTTP MCP tool (Claude per_call turn binding)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  })

  const run = async (scenario: Scenario): Promise<Outcome> => {
    const anthropic = await anthropicMock()
    cleanups.push(() => anthropic.close())
    const mcp = await mcpMock()
    cleanups.push(() => mcp.close())
    const root = mkdtempSync(join(tmpdir(), 'mousse-claude-turn-binding-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
    const homeDir = mkdtempSync(join(root, 'home-'))
    const configDir = mkdtempSync(join(root, 'config-'))
    const workDir = mkdtempSync(join(root, 'work-'))

    const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'SystemDrive', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
    const env: Record<string, string> = {}
    for (const name of keep) if (process.env[name]) env[name] = process.env[name] as string
    Object.assign(env, {
      ANTHROPIC_BASE_URL: anthropic.url,
      ANTHROPIC_API_KEY: 'sk-ant-api03-fake-local',
      CLAUDE_CONFIG_DIR: configDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
      ...(scenario.toolSearch ? { ENABLE_TOOL_SEARCH: 'true' } : {})
    })

    const hookInputs: unknown[] = []
    const canUseToolCalls: Outcome['canUseToolCalls'] = []
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreToolUse: [
        {
          hooks: [
            async (event) => {
              if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== TOOL) return {}
              hookInputs.push(event.tool_input)
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  ...(scenario.decision ? { permissionDecision: scenario.decision } : {}),
                  updatedInput: { ...(event.tool_input as Json), _mousse_turn: TOKEN }
                }
              }
            }
          ]
        }
      ]
    }
    const canUseTool: CanUseTool = async (toolName, args) => {
      canUseToolCalls.push({ toolName, args })
      return { behavior: 'allow', updatedInput: args }
    }
    const options: Options = {
      pathToClaudeCodeExecutable: BINARY,
      cwd: workDir,
      env,
      model: 'claude-sonnet-4-5',
      settingSources: [],
      permissionMode: scenario.permissionMode,
      ...(scenario.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : { canUseTool }),
      mcpServers: { mousse: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer x' } } },
      hooks,
      maxTurns: 6
    }
    let result: string | undefined
    for await (const message of query({ prompt: 'Read the thread.', options })) {
      if (message.type === 'result') result = message.subtype === 'success' ? message.result : message.subtype
    }
    return { mcpCalls: mcp.calls, hookInputs, canUseToolCalls, paths: anthropic.paths, toolsSeen: anthropic.toolsSeen, historyInputs: anthropic.historyInputs, result }
  }


  /** Shared findings: the key reaches the MCP server, the hook saw the model's input, only localhost Messages calls were made. */
  const expectDelivered = (outcome: Outcome) => {
    expect(outcome.result).toBe('done')
    expect(outcome.hookInputs).toEqual([{ limit: 5 }])
    expect(outcome.mcpCalls).toEqual([{ name: 'thread_read', arguments: { limit: 5, _mousse_turn: TOKEN } }])
    // The transcript keeps the model's original input: the hook's key is not echoed back to the model.
    expect(outcome.historyInputs.every((input) => !('_mousse_turn' in input))).toBe(true)
    expect(outcome.paths.every((path) => path === 'POST /v1/messages?beta=true')).toBe(true)
  }

  it.skipIf(!hasBinary)('bypassPermissions: updatedInput with permissionDecision allow reaches the server', async () => {
    const outcome = await run({ permissionMode: 'bypassPermissions', decision: 'allow' })
    expectDelivered(outcome)
    expect(outcome.canUseToolCalls).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)('bypassPermissions: updatedInput alone (no decision) reaches the server', async () => {
    const outcome = await run({ permissionMode: 'bypassPermissions' })
    expectDelivered(outcome)
    expect(outcome.canUseToolCalls).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)('default + canUseTool: updatedInput alone reaches canUseTool and the server', async () => {
    const outcome = await run({ permissionMode: 'default' })
    expectDelivered(outcome)
    expect(outcome.canUseToolCalls).toEqual([{ toolName: TOOL, args: { limit: 5, _mousse_turn: TOKEN } }])
  }, 120_000)

  it.skipIf(!hasBinary)('default + canUseTool: updatedInput with ask (Mousse restricted path) reaches canUseTool and the server', async () => {
    const outcome = await run({ permissionMode: 'default', decision: 'ask' })
    expectDelivered(outcome)
    expect(outcome.canUseToolCalls).toEqual([{ toolName: TOOL, args: { limit: 5, _mousse_turn: TOKEN } }])
  }, 120_000)

  it.skipIf(!hasBinary)('default + canUseTool: updatedInput with allow skips canUseTool and reaches the server', async () => {
    const outcome = await run({ permissionMode: 'default', decision: 'allow' })
    expectDelivered(outcome)
    expect(outcome.canUseToolCalls).toEqual([])
  }, 120_000)

  it.skipIf(!hasBinary)('ToolSearch deferral: the key still reaches the server after the tool is loaded', async () => {
    const outcome = await run({ permissionMode: 'default', decision: 'ask', toolSearch: true })
    // The deferred tool is absent from the first request and sent with `defer_loading` once ToolSearch loaded it.
    expect(outcome.toolsSeen).toEqual([['ToolSearch'], ['ToolSearch', `${TOOL} (deferred)`], ['ToolSearch', `${TOOL} (deferred)`]])
    expectDelivered(outcome)
    // ToolSearch itself is auto-allowed here: canUseTool only sees the Mousse tool, with the key.
    expect(outcome.canUseToolCalls).toEqual([{ toolName: TOOL, args: { limit: 5, _mousse_turn: TOKEN } }])
  }, 120_000)
})
