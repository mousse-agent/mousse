/**
 * Live check of title one-shots (`CodexProviderService.oneShot`) against the real `codex app-server`.
 * It needs no sign-in: Codex runs in a throwaway CODEX_HOME whose model provider is a fake Responses
 * endpoint in this process, which records every model request and answers with the tool call each case
 * forces. The user's `~/.codex` is never read or written. Runs only with MOUSSE_LIVE_CODEX=1;
 * MOUSSE_CODEX_BINARY may name the executable.
 *
 * Checked: the tools Codex offers a one-shot (no commands, web search, images or MCP tools); a forced
 * `spawn_agent` on a model a one-shot runs on starts no child thread and no other model request; a model
 * with `v2` subagents is refused before any thread or model request; a forced `apply_patch` writes nothing.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexProviderService, codexEnvironment, findCodexBinary } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { LlmModelOption } from '../../src/shared/settings'

const live = process.env.MOUSSE_LIVE_CODEX === '1'

/** What the fake model answers first: a message, or one forced tool call. */
type Force = 'answer' | 'spawn_agent' | 'apply_patch'
type Body = { input?: unknown[]; tools?: unknown[]; prompt_cache_key?: string }

const MCP_SERVER = `const rl = require('node:readline').createInterface({ input: process.stdin })
const name = process.argv[2]
rl.on('line', (line) => {
  const m = JSON.parse(line); if (m.id === undefined) return
  const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } }
    : m.method === 'tools/list' ? { tools: [{ name: name + '_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }] } : {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
})`

/** Every tool the model was offered: top-level ones, and those in `additional_tools` namespaces. */
function offeredTools(body: Body | undefined): string[] {
  const names: string[] = []
  const collect = (tool: any): void => { if (tool?.type === 'namespace') (tool.tools ?? []).forEach(collect); else names.push(tool?.name ?? tool?.type) }
  for (const tool of body?.tools ?? []) collect(tool)
  for (const item of (body?.input ?? []) as any[]) if (item?.type === 'additional_tools') (item.tools ?? []).forEach(collect)
  return names
}

describe.skipIf(!live)('title one-shots against the real codex app-server', () => {
  let root: string
  let server: Server
  let service: CodexProviderService
  let questions: UserQuestionService
  let force: Force = 'answer'
  let requests: Body[] = []
  let models: LlmModelOption[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-codex-oneshot-'))
    server = createServer((req, res) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return }
        const body = JSON.parse(text) as Body
        requests.push(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('response.created', { response: { id: 'r' } })
        const first = requests.length === 1
        if (first && force === 'spawn_agent')
          send('response.output_item.done', { item: { type: 'function_call', id: 'f1', call_id: 'call_1', namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'helper', message: 'Run ls and report.', fork_turns: 'none' }) } })
        else if (first && force === 'apply_patch')
          send('response.output_item.done', { item: { type: 'custom_tool_call', id: 'c1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: pwned.txt\n+written by the model\n*** End Patch\n' } })
        else send('response.output_item.done', { item: { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'Login redirect fix' }] } })
        send('response.completed', { response: { id: 'r', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } })
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const codexHome = join(root, 'codex-home')
    const user = join(root, 'user')
    for (const dir of [codexHome, user]) mkdirSync(dir, { recursive: true })
    const mcp = join(root, 'mcp.cjs')
    writeFileSync(mcp, MCP_SERVER)
    const script = mcp.replace(/\\/g, '/')
    writeFileSync(join(codexHome, 'config.toml'), [
      'model_provider = "probe"',
      '[model_providers.probe]',
      'name = "probe"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      'env_key = "PROBE_KEY"',
      '[mcp_servers.demo]',
      'command = "node"',
      `args = ["${script}", "demo"]`,
      '[mcp_servers.mousse]',
      'command = "node"',
      `args = ["${script}", "mousse"]`,
      ''
    ].join('\n'))
    questions = new UserQuestionService()
    service = new CodexProviderService(root, questions, {}, {
      dir: join(root, 'state'),
      env: () => ({ ...codexEnvironment(), CODEX_HOME: codexHome, PROBE_KEY: 'probe', USERPROFILE: user, HOME: user }),
      modelProvider: 'probe',
      launch: () => ({ binaryPath: process.env.MOUSSE_CODEX_BINARY || findCodexBinary() }),
      account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, label: 'live check', subject: 'live-check' }) }
    })
    await service.status()
    // The models as this Codex lists them: a one-shot runs on those without `oneShot: false`.
    models = await service.refreshModels()
  }, 60_000)

  afterAll(async () => {
    service?.stop()
    // Codex and its MCP servers hold the folder until they have exited.
    await service?.processesExited()
    questions?.shutdown()
    server?.close()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }, 30_000)

  const run = async (model: string, forced: Force) => {
    force = forced
    requests = []
    const answer = await service.oneShot({ model, system: 'Name the chat.', prompt: 'Fix the login redirect', onActivity: () => {} }, AbortSignal.timeout(60_000)).then((value) => value, (error: unknown) => error)
    // Anything Codex started would still be sending its model requests.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    return { answer, requests: [...requests] }
  }
  const allowed = () => models.find((model) => model.oneShot === undefined)
  const refused = () => models.find((model) => model.oneShot === false)

  it('offers no commands, web search, images or MCP tools, and answers', async () => {
    const model = allowed()
    expect(model, 'a listed model a one-shot runs on').toBeDefined()
    const { answer, requests: sent } = await run(model!.id, 'answer')
    expect(answer).toEqual({ text: 'Login redirect fix' })
    expect(sent).toHaveLength(1)
    const tools = offeredTools(sent[0])
    expect(tools.filter((tool) => /exec_command|write_stdin|shell|view_image|image_gen|web_search|mcp__|goal|spawn_agent|tool_search/.test(tool))).toEqual([])
  }, 90_000)

  it('a forced spawn_agent starts no child thread and no other model request', async () => {
    const model = allowed()!
    const { answer, requests: sent } = await run(model.id, 'spawn_agent')
    expect(answer).toEqual({ text: 'Login redirect fix' })
    // The one-shot's own request, then its follow-up with the refused call's output. A child would add a
    // request of its own session.
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map((body) => body.prompt_cache_key)).size).toBe(1)
  }, 90_000)

  it('a model with v2 subagents is refused before any thread or model request', async () => {
    const model = refused()
    expect(model, 'a listed model with v2 subagents').toBeDefined()
    const { answer, requests: sent } = await run(model!.id, 'spawn_agent')
    expect(answer).toMatchObject({ code: 'unsupported' })
    expect(sent).toEqual([])
  }, 90_000)

  it('a forced apply_patch writes nothing', async () => {
    const model = allowed()!
    const { answer, requests: sent } = await run(model.id, 'apply_patch')
    expect(answer).toEqual({ text: 'Login redirect fix' })
    const workspaces = join(root, 'state', 'workspaces')
    const written = existsSync(workspaces) && readdirSync(workspaces).some((folder) => existsSync(join(workspaces, folder, 'pwned.txt')))
    expect(written).toBe(false)
    expect(JSON.stringify(sent[1] ?? {})).toMatch(/patch rejected|unsupported call/)
  }, 90_000)
})
