/**
 * Live check of title one-shots (`CodexProviderService.oneShot`) against the real `codex app-server`.
 * It needs no sign-in: Codex runs in a throwaway CODEX_HOME whose model provider is a fake Responses
 * endpoint in this process, which records every model request and answers with the tool call each case
 * forces. The user's `~/.codex` is never read or written. Runs only with MOUSSE_LIVE_CODEX=1;
 * MOUSSE_CODEX_BINARY may name the executable.
 *
 * Checked, with the throwaway config naming a model that has subagents (as a user's might):
 * - the one-shot runs the model it was asked for, offered no commands, web search, images, MCP or
 *   subagent tools;
 * - a forced `spawn_agent`, in the `v2` (`collaboration`) or the `v1` (`multi_agent_v1`) shape, with an
 *   activity callback that blocks 250 ms and a stop 250 ms after the first event, starts no child (no
 *   model request carries its task);
 * - a model with `v1` or `v2` subagents is refused before any thread or model request;
 * - a forced `apply_patch` writes nothing.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexProviderService, codexEnvironment, findCodexBinary } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { CodexConnection } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import type { CodexModel } from '../../src/mms/harness/vendors/codex/protocol'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const live = process.env.MOUSSE_LIVE_CODEX === '1'
/** The model the throwaway config names: one with subagents, which a one-shot must never run. */
const CONFIGURED = process.env.MOUSSE_LIVE_CODEX_CONFIGURED_MODEL || 'gpt-6.1-sol'

/** What the fake model answers first: a message, or one forced tool call. */
type Force = 'answer' | 'spawn_v2' | 'spawn_v1' | 'apply_patch'
type Body = { model?: string; input?: unknown[]; tools?: unknown[] }

/** The task a forced `spawn_agent` gives its child; a request that carries it as a user message is the child's. */
const CHILD_TASK = 'CHILD TASK: run ls and report.'
const childRequests = (sent: Body[]) =>
  sent.filter((body) => (body.input ?? []).some((item: any) => item?.role === 'user' && JSON.stringify(item.content ?? '').includes(CHILD_TASK)))

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

/** The model's first answer for `force`: the tool call it forces, or a plain answer. */
function firstItem(force: Force): object {
  if (force === 'spawn_v2') return { type: 'function_call', id: 'f1', call_id: 'call_1', namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'helper', message: CHILD_TASK, fork_turns: 'none' }) }
  if (force === 'spawn_v1') return { type: 'function_call', id: 'f1', call_id: 'call_1', namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: JSON.stringify({ message: CHILD_TASK }) }
  if (force === 'apply_patch') return { type: 'custom_tool_call', id: 'c1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: pwned.txt\n+written by the model\n*** End Patch\n' }
  return { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'Login redirect fix' }] }
}

describe.skipIf(!live)('title one-shots against the real codex app-server', () => {
  let root: string
  let server: Server
  let service: CodexProviderService
  let questions: UserQuestionService
  let conn: CodexConnection
  let force: Force = 'answer'
  let requests: Body[] = []
  let models: CodexModel[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-live-codex-oneshot-'))
    server = createServer((req, res) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return }
        requests.push(JSON.parse(text) as Body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('response.created', { response: { id: 'r' } })
        send('response.output_item.done', { item: firstItem(requests.length === 1 ? force : 'answer') })
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
      `model = "${CONFIGURED}"`,
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
    conn = (service as unknown as { app: { conn: CodexConnection } }).app.conn
    // The models and their subagent versions, as this Codex lists them.
    models = (await conn.request('model/list', { includeHidden: true })).data
  }, 60_000)

  afterAll(async () => {
    service?.stop()
    // Codex and its MCP servers hold the folder until they have exited.
    await service?.processesExited()
    questions?.shutdown()
    server?.close()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }, 30_000)

  /**
   * One one-shot with `forced` as the model's first answer. With `delayMs`, the activity callback blocks
   * that long on each event, and the one-shot is stopped that long after its first event: a child Codex
   * started meanwhile has time to send its request before Mousse can interrupt the turn.
   */
  const run = async (model: string, forced: Force, delayMs?: number) => {
    force = forced
    requests = []
    const stop = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const onActivity = (): void => {
      if (delayMs === undefined) return
      const until = Date.now() + delayMs
      while (Date.now() < until) { /* a slow callback */ }
      timer ??= setTimeout(() => stop.abort(new Error('Stopped')), delayMs)
    }
    const answer = await service.oneShot({ model, system: 'Name the chat.', prompt: 'Fix the login redirect', onActivity }, AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)]))
      .then((value) => value, (error: unknown) => error)
    // Anything Codex started would still be sending its model requests.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    clearTimeout(timer)
    return { answer, requests: [...requests] }
  }
  const withVersion = (version: string | null) => models.find((model) => model.multiAgentVersion === version && model.id !== CONFIGURED)
  const loadedThreads = async () => ((await conn.request('thread/loaded/list' as never, {} as never)) as { data: string[] }).data.length

  it('runs the model it was asked for, offered no commands, web search, images, MCP or subagent tools', async () => {
    const model = withVersion(null)
    expect(model, 'a listed model with no subagents').toBeDefined()
    const { answer, requests: sent } = await run(model!.id, 'answer')
    expect(answer).toEqual({ text: 'Login redirect fix' })
    expect(sent).toHaveLength(1)
    // Not the configured model: the checked one is pinned.
    expect(sent[0]!.model).toBe(model!.model)
    const tools = offeredTools(sent[0])
    expect(tools.filter((tool) => /exec_command|write_stdin|shell|view_image|image_gen|web_search|mcp__|goal|agent|tool_search/.test(tool))).toEqual([])
  }, 90_000)

  it.each(['spawn_v2', 'spawn_v1'] as const)('a forced %s, with a 250 ms activity callback and stop, starts no child', async (forced) => {
    const model = withVersion(null)!
    const { requests: sent } = await run(model.id, forced, 250)
    expect(childRequests(sent)).toEqual([])
    // The one-shot's own request, and at most its follow-up with the refused call's output.
    expect(sent.length).toBeLessThanOrEqual(2)
  }, 90_000)

  it.each(['v1', 'v2'])('a model with %s subagents is refused before any thread or model request', async (version) => {
    const model = withVersion(version)
    expect(model, `a listed model with ${version} subagents`).toBeDefined()
    const before = await loadedThreads()
    const { answer, requests: sent } = await run(model!.id, version === 'v1' ? 'spawn_v1' : 'spawn_v2', 250)
    expect(answer).toMatchObject({ code: 'unsupported' })
    expect(sent).toEqual([])
    expect(await loadedThreads()).toBe(before)
  }, 90_000)

  it('a forced apply_patch writes nothing', async () => {
    const model = withVersion(null)!
    const { answer, requests: sent } = await run(model.id, 'apply_patch')
    expect(answer).toEqual({ text: 'Login redirect fix' })
    const workspaces = join(root, 'state', 'workspaces')
    const written = existsSync(workspaces) && readdirSync(workspaces).some((folder) => existsSync(join(workspaces, folder, 'pwned.txt')))
    expect(written).toBe(false)
    expect(JSON.stringify(sent[1] ?? {})).toMatch(/patch rejected|unsupported call/)
  }, 90_000)
})
