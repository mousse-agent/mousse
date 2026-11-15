/**
 * Live check: through a CLIProxyAPI route, with no management key and nothing set in Mousse, the real Claude Code that
 * Mousse starts sends Mousse's client name, and a second turn sends the same system prompt and tools, so the proxy
 * sees a stable prefix. No sign-in or Anthropic call: a stand-in in this process answers CLIProxyAPI's key-free root and
 * the Messages endpoint with synthetic replies. Runs only with MOUSSE_LIVE_CLAUDE=1; MOUSSE_CLAUDE_BINARY may name the
 * executable. This checks the wire, not CLIProxyAPI's own handling or Anthropic's metering.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { resetLocalProxyDetection } from '../../src/mms/harness/vendors/claude/localProxyUsage'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const live = process.env.MOUSSE_LIVE_CLAUDE === '1'
const binary = process.env.MOUSSE_CLAUDE_BINARY || join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
const ROUTE = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_ENTRYPOINT', 'CLIPROXY_MANAGEMENT_KEY', 'CLI_PROXY_API_MANAGEMENT_KEY', 'MANAGEMENT_PASSWORD']

describe.skipIf(!live)('Claude Code through a CLIProxyAPI route', () => {
  let root: string
  let server: Server
  let port = 0
  /** Main-loop Messages requests (the ones with tools), with the headers they came with. */
  const captures: Array<{ headers: IncomingHttpHeaders; body: { system?: unknown; tools?: unknown[]; messages: unknown[] } }> = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-claude-proxy-'))
    for (const name of ROUTE) vi.stubEnv(name, undefined)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'config'))
    mkdirSync(join(root, 'config'))
    resetLocalProxyDetection()
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"message":"CLI Proxy API Server"}'); return }
        if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":1}'); return }
        const body = JSON.parse(raw) as { model: string; system?: unknown; tools?: unknown[]; messages: unknown[] }
        if (body.tools?.length) captures.push({ headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('message_start', { message: { id: `m${captures.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        send('message_stop', {})
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }, 30_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    server?.close()
    // On Windows the processes `stop` ended hold their folder for a while after; a folder still held stays in the temp folder.
    for (let tries = 0; root && tries < 60; tries++) {
      try { rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((done) => setTimeout(done, 500)) }
    }
  }, 60_000)

  it('sends Mousse\'s name with a stable prefix, and the default in Auto', async () => {
    const home = join(root, 'mousse')
    mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }),
      launchConfig: () => ({ binaryPath: binary, env })
    })
    await service.status({ force: true })
    const turn = (threadId: string, permissionMode: PermissionMode, prompt: string) =>
      service.chat({ threadId, cwd: home, model: 'sonnet', prompt, permissionMode, onText: () => {} })
    try {
      await turn('named', 'full', 'Reply ok.')
      await turn('named', 'full', 'Reply ok again.')
      await turn('auto', 'auto', 'Reply ok.')
    } finally {
      service.stop()
    }
    expect(captures).toHaveLength(3)
    const [first, second, auto] = captures as [typeof captures[0], typeof captures[0], typeof captures[0]]
    for (const capture of [first, second]) {
      expect(capture.headers['user-agent']).toMatch(/\bmousse\b/)
      expect(JSON.stringify(capture.body.system)).toContain('cc_entrypoint=mousse')
    }
    expect(second.body.system).toEqual(first.body.system)
    expect(second.body.tools).toEqual(first.body.tools)
    expect(auto.headers['user-agent']).toMatch(/\bsdk-ts\b/)
    expect(JSON.stringify(auto.body.system)).toContain('cc_entrypoint=sdk-ts')
  }, 180_000)
})
