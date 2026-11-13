/**
 * A server's shared connection lives as long as the profile's MCP work, never as long as the call that opened it: a call
 * that is stopped (a bot's turn ending, its response closing) ends only its own wait, so the owner's later calls and the
 * bot's still reach the server. And a stdio server whose call timed out keeps its process while it still answers a ping;
 * only one that no longer answers is restarted.
 */
import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpManager } from '../src/mms/integrations/mcp/McpManager'
import type { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { supportsOwnedMcpTree } from '../src/mms/integrations/mcp/ownedProcessTree'
import type { McpServerConfig } from '../src/shared/integrations'
import { makeTempProfile, settingsStore, testServerConfig } from './fixtures/agent-platform/integrations/helpers'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const enabled = () => settingsStore((settings) => {
  settings.integrations.mcp.enabled = true
  settings.integrations.mcp.enableForMainAgent = true
  settings.integrations.mcp.enabledServers = ['inst-echo']
}) as never

const registryOf = (server: McpServerConfig) => ({ discover: async () => ({ servers: [server], sources: [], diagnostics: [] }) }) as unknown as McpRegistry

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

/** A remote MCP server on 127.0.0.1 (streamable HTTP, stateless) with one `echo` tool; `calls` counts what reached it. */
async function remoteServer() {
  const calls: string[] = []
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const body = JSON.parse(await readBody(req)) as unknown
    const mcp = new Server({ name: 'remote', version: '0.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } } }] }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(String(request.params.arguments?.text ?? ''))
      return { content: [{ type: 'text' as const, text: `echo ${String(request.params.arguments?.text ?? '')}` }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.once('close', () => {
      void transport.close().catch(() => undefined)
      void mcp.close().catch(() => undefined)
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  })
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
  cleanups.push(() => new Promise<void>((done) => http.close(() => done())))
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, calls }
}

describe('a connection opened by a call that then ends', () => {
  it('a remote server: later calls, with or without a signal, still reach it', async () => {
    const remote = await remoteServer()
    const manager = new McpManager(registryOf(testServerConfig({ url: remote.url })), enabled(), async () => {})
    cleanups.push(() => manager.shutdown())
    const [echo] = await manager.listTools('inst-echo')
    // The connection drops (the server restarted, say); a bot's call opens it again, and its turn then ends.
    await manager.restartServer('inst-echo')
    const bot = new AbortController()
    expect((await manager.callTool(echo!.providerName, { text: 'from the bot' }, undefined, bot.signal)).text).toContain('echo from the bot')
    bot.abort(new Error('dispatch_ended'))
    // The owner's thread, and the bot's next call, use the same connection.
    expect((await manager.callTool(echo!.providerName, { text: 'from the owner' })).text).toContain('echo from the owner')
    expect((await manager.callTool(echo!.providerName, { text: 'again' }, undefined, new AbortController().signal)).text).toContain('echo again')
    expect(remote.calls).toEqual(['from the bot', 'from the owner', 'again'])
  })

  it('a stop while the connection opens ends only that caller\'s wait: another caller gets the connection', async () => {
    let opened = 0
    const manager = new McpManager(registryOf(testServerConfig()), enabled(), async () => {}, {
      clientFactory: {
        async connect(_server, _key, signal) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 200)
            signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
          })
          opened += 1
          return { listTools: async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }), callTool: async () => ({ content: [] }), close: async () => undefined }
        }
      }
    })
    cleanups.push(() => manager.shutdown())
    const bot = new AbortController()
    const botList = manager.listTools('inst-echo', undefined, bot.signal)
    const ownerList = manager.listTools('inst-echo')
    setTimeout(() => bot.abort(new Error('dispatch_ended')), 20)
    await expect(botList).rejects.toThrow('dispatch_ended')
    expect((await ownerList).map((tool) => tool.toolName)).toEqual(['echo'])
    expect(opened).toBe(1)
  })
})

describe.runIf(supportsOwnedMcpTree())('a stdio server whose call timed out', () => {
  const fixture = fileURLToPath(new URL('./fixtures/agent-platform/integrations/mcp-fixture-server.mjs', import.meta.url))

  async function stdio() {
    const { root, context } = await makeTempProfile()
    const logs = await mkdtemp(join(tmpdir(), 'mousse-mcp-starts-'))
    const starts = join(logs, 'starts.jsonl')
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    cleanups.push(() => rmSync(logs, { recursive: true, force: true }))
    const server = testServerConfig({ transport: 'stdio', command: process.execPath, args: [fixture], url: undefined, env: { MCP_FIXTURE_START_LOG: starts, MCP_FIXTURE_WEDGE: '1' } })
    const manager = new McpManager(registryOf(server), enabled(), async () => {}, { context, pingTimeoutMs: 500 })
    cleanups.push(() => manager.shutdown())
    const tools = await manager.listTools('inst-echo')
    const named = (name: string) => tools.find((tool) => tool.toolName === name)!.providerName
    const started = () => readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean).length
    const pinged = () => vi.waitFor(() => expect(manager.snapshotOwnedWork()['mcp-ping'] ?? 0).toBe(0), { timeout: 10_000 })
    return { manager, named, started, pinged }
  }

  it('keeps its process (and its own state) while it still answers a ping', { timeout: 30_000 }, async () => {
    const { manager, named, started, pinged } = await stdio()
    await expect(manager.callTool(named('hang'), { ms: 20_000 }, undefined, undefined, undefined, undefined, { timeoutMs: 300 })).rejects.toThrow(/Timed out/)
    await pinged()
    expect((await manager.callTool(named('echo'), { text: 'still here' })).text).toContain('still here')
    expect(started()).toBe(1)
  })

  it('is restarted when it no longer answers a ping', { timeout: 30_000 }, async () => {
    const { manager, named, started, pinged } = await stdio()
    await expect(manager.callTool(named('wedge'), { ms: 3_000 }, undefined, undefined, undefined, undefined, { timeoutMs: 300 })).rejects.toThrow(/Timed out/)
    await pinged()
    expect((await manager.callTool(named('echo'), { text: 'new process' })).text).toContain('new process')
    expect(started()).toBe(2)
  })
})
