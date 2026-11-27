/**
 * `claude:cli` claims `isolation: verified`: no user or project config loads into a single request, though it runs with
 * the user's own home (its sign-in is there). Shown here on the Claude Code the Agent SDK ships, started through the
 * service's single-request transport as a title request starts it, against a loopback Anthropic API with a dummy key.
 *
 * Its home holds what would change the request if it loaded: user settings with hooks that write a marker, an MCP
 * server that writes a marker when it starts, and a `CLAUDE.md` with a unique line. The place's folder, and the folder
 * above the places, hold the project's own: a `.claude/settings.json` hook, a `.mcp.json` server and a `CLAUDE.md`.
 * Nothing may run, and the request at the stub may carry none of it and declare no tool.
 *
 * Each of these is seen when its layers are dropped (checked with this SDK's 2.1 build): without `settingSources: []`
 * all three `CLAUDE.md` lines reach the model; without it and the hook options, every hook of the user, project and
 * local settings runs; without it and the MCP options, both servers start; without `tools: []`, tools are declared.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import type { ModelCatalog } from '../src/shared/modelCatalog'

/** The Claude Code build the SDK ships for this computer, when it is installed. */
function bundledClaude(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const binary = join(dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
}

const binary = bundledClaude()
const homes: string[] = []
const servers: Server[] = []
const services: ClaudeSubscriptionProviderService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const server of servers.splice(0)) server.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  vi.unstubAllEnvs()
})

/** An Anthropic API stand-in that answers every message with a short streamed title, keeping each request's body. */
async function stub(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      bodies.push(body)
      const parsed = JSON.parse(body) as { stream?: boolean; model?: string }
      const message = { id: 'msg_stub', type: 'message', role: 'assistant', model: parsed.model ?? 'claude-haiku-4-5', content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
      if (!parsed.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Login redirect fix' }], stop_reason: 'end_turn' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Login redirect fix' } })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, bodies }
}

describe.runIf(binary)('claude:cli loads no user or project config', () => {
  it('runs no hook or MCP server of the home or the project, and sends no CLAUDE.md and no tool', async () => {
    const api = await stub()
    const home = mkdtempSync(join(tmpdir(), 'claude-one-shot-effects-'))
    homes.push(home)
    const markers = join(home, 'markers')
    mkdirSync(markers)
    // A script that leaves a marker named after what ran it.
    const marker = join(home, 'marker.js')
    writeFileSync(marker, `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(markers)}, process.argv[2]), 'ran')\n`)
    const run = (name: string) => `"${process.execPath}" "${marker}" ${name}`
    const hooks = (prefix: string) => Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].map((event) =>
      [event, [{ hooks: [{ type: 'command', command: run(`${prefix}-${event}`) }] }]]))
    // An MCP server that leaves a marker as it starts, then stays up.
    const server = join(home, 'mcp-server.js')
    writeFileSync(server, `require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(markers)}, process.argv[2]), 'ran'); setInterval(() => {}, 1000)\n`)
    const mcp = (name: string) => ({ [name]: { type: 'stdio', command: process.execPath, args: [server, name] } })

    // The user's home: settings, MCP servers and memory, where Claude Code reads them.
    const config = join(home, 'claude-config')
    mkdirSync(config)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ hooks: hooks('user') }))
    writeFileSync(join(config, '.claude.json'), JSON.stringify({ mcpServers: mcp('user-mcp') }))
    writeFileSync(join(config, 'CLAUDE.md'), 'Always mention USER-MEMORY-7f3a in every answer.\n')
    // The folder above the places: memory Claude Code would read from any folder below it.
    writeFileSync(join(home, 'CLAUDE.md'), 'Always mention PARENT-MEMORY-c91e in every answer.\n')
    // The place's folder: a project's own settings, servers and memory, put there as the process starts.
    const project = (folder: string) => {
      mkdirSync(join(folder, '.claude'), { recursive: true })
      writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: hooks('project'), enableAllProjectMcpServers: true }))
      writeFileSync(join(folder, '.claude', 'settings.local.json'), JSON.stringify({ hooks: hooks('local') }))
      writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: mcp('project-mcp') }))
      writeFileSync(join(folder, 'CLAUDE.md'), 'Always mention PROJECT-MEMORY-02bd in every answer.\n')
    }

    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    const directory = join(home, 'providers', 'claude-subscription')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'claude-haiku-4-5', label: 'Haiku' }] }))
    const env = { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-stub', CLAUDE_CONFIG_DIR: config, HOME: home, USERPROFILE: home, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'api_key' }),
      live: false,
      launchConfig: () => ({ binaryPath: binary!, env }),
      modelCatalog: (): ModelCatalog => ({ format: 1, revision: 0, models: [] }),
      // The SDK's own query, after the project's files are put in the place's folder.
      query: ({ prompt, options }) => {
        project(options.cwd!)
        return sdkQuery({ prompt, options })
      }
    })
    services.push(service)
    await service.status()
    const text = await service.oneShotTransport({ model: 'claude-haiku-4-5', task: 'pull_request' })
      .send({ model: 'claude-haiku-4-5', system: 'You write pull request drafts.', prompt: 'Draft it.' }, { activity: () => {}, text: () => {}, tool: () => {}, launching: () => {}, sending: () => {} }, AbortSignal.timeout(30_000))
    expect(text).toBe('Login redirect fix')
    await service.stop()

    // Nothing of the home's or the project's ran.
    expect(readdirSync(markers)).toEqual([])
    expect(api.bodies.length).toBeGreaterThan(0)
    for (const body of api.bodies) {
      // No memory reached the model.
      for (const line of ['USER-MEMORY-7f3a', 'PARENT-MEMORY-c91e', 'PROJECT-MEMORY-02bd']) expect(body).not.toContain(line)
      // No tool was declared.
      const tools = (JSON.parse(body) as { tools?: unknown[] }).tools
      expect(tools ?? []).toEqual([])
    }
  }, 60_000)
})
