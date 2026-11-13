/**
 * What the pinned Codex offers a bot's turn, on the real binary (`npm run codex:pin`, or `MOUSSE_CODEX_BINARY`), run as
 * the owner's own Codex with every feature that adds a tool switched on in their config: the worst a bot can meet. A
 * fake Responses endpoint in this process records every model request; nothing leaves the machine, and nothing of the
 * owner's is read.
 *
 * Every tool offered must be one this file accounts for, with what it can reach (`ACCOUNTED`): a tool the next Codex
 * adds fails here until someone has decided what it means for a bot. Each model kind of the binary's catalog is checked
 * (no subagents, `v1`, `v2`), for a bot without "run commands" and one with it, neither with file access. Then a
 * subagent: the models that have them keep `spawn_agent` whatever the config says, so a child must inherit the bot's
 * tools and sandbox, and Mousse must answer nothing a child asks.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodexProviderService, codexEnvironment } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { CodexConnection } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import type { CodexModel } from '../../src/mms/harness/vendors/codex/protocol'
import { CodexInstallation } from '../../src/mms/harness/vendors/codex/installation'
import { CODEX_BOT_FEATURES_OFF } from '../../src/mms/harness/vendors/codex/childPolicy'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { NeutralTool } from '../../src/shared/harness/tools'

const pinned = new CodexInstallation({ installationHome: resolve(__dirname, '..', '..', '.cache', 'codex-pin') }).installed()
const BINARY = process.env.MOUSSE_CODEX_BINARY || (pinned && !pinned.broken ? pinned.path : undefined)
const SKIPPED = BINARY ? '' : ' [skipped: no pinned Codex; run npm run codex:pin]'

/**
 * Every tool a bot's turn may be offered, by the name the model sees (a namespace before a dot), and what it can do.
 * Nested tools are the ones code mode's `exec` calls.
 */
const ACCOUNTED: Record<string, string> = {
  request_user_input: 'asks a person; Mousse answers a bot\'s with an error, nobody is asked',
  'functions.request_user_input': 'the same, in code mode',
  'functions.request_user_input_async': 'the same, without waiting',
  web_search: 'OpenAI\'s hosted web search: reads no file of this computer',
  apply_patch: 'changes files: each change asks, and the bot\'s authority decides by path',
  exec_command: 'a command (only with "run commands"): asks under the bot\'s profile, runs in its sandbox',
  write_stdin: 'input to a command it started (only with "run commands")',
  exec: 'code mode: JavaScript with no file system or network, calling only the tools listed here',
  wait: 'code mode: waits for an exec still running',
  'functions.exec': 'code mode, as above',
  'functions.wait': 'code mode, as above',
  'nested:apply_patch': 'as apply_patch',
  'nested:exec_command': 'as exec_command',
  'nested:write_stdin': 'as write_stdin',
  'nested:list_mcp_resources': 'resources of the MCP servers left on: Mousse\'s own, which has none',
  'nested:list_mcp_resource_templates': 'the same',
  'nested:read_mcp_resource': 'the same',
  'nested:clock__curr_time': 'the time',
  'collaboration.spawn_agent': 'a subagent: inherits the bot\'s tools and sandbox; Mousse answers none of its asks (below)',
  'collaboration.send_message': 'a message to a subagent',
  'collaboration.followup_task': 'more work for a subagent',
  'collaboration.wait_agent': 'waits for a subagent',
  'collaboration.interrupt_agent': 'stops a subagent',
  'collaboration.list_agents': 'lists its subagents'
}
const COMMANDS = /(^|[.:])(exec_command|write_stdin|shell|local_shell)$/

type Body = { model?: string; input?: unknown[]; tools?: unknown[] }

/** Every tool the request offers: top-level, in a namespace, in `additional_tools`, and nested in code mode's `exec`. */
function offered(body: Body | undefined): string[] {
  const names: string[] = []
  const collect = (tool: any, ns = ''): void => {
    if (tool?.type === 'namespace') return (tool.tools ?? []).forEach((inner: unknown) => collect(inner, `${tool.name}.`))
    const name = `${ns}${tool?.name ?? tool?.type}`
    names.push(name === 'functions.web_search' ? 'web_search' : name)
    if (tool?.name === 'exec' && typeof tool.description === 'string')
      for (const [, nested] of tool.description.matchAll(/^### `([A-Za-z0-9_]+)`/gm)) names.push(`nested:${nested}`)
  }
  for (const tool of body?.tools ?? []) collect(tool)
  for (const item of (body?.input ?? []) as any[]) if (item?.type === 'additional_tools') (item.tools ?? []).forEach((tool: unknown) => collect(tool))
  return [...new Set(names)]
}

/** The task a forced subagent is given: the request that carries it, and none of the parent's call, is the child's. */
const CHILD_TASK = 'CHILD TASK: list the folder.'
const isChild = (body: Body) => { const all = JSON.stringify(body.input ?? []); return all.includes(CHILD_TASK) && !all.includes('"call_1"') }

describe.skipIf(!BINARY)(`what the pinned Codex offers a bot's turn, with every tool feature on in the owner's config${SKIPPED}`, () => {
  let root: string
  let server: Server
  let service: CodexProviderService
  let questions: UserQuestionService
  let models: CodexModel[] = []
  let requests: Body[] = []
  /** What the model answers: the parent's first request, a child's first request; anything else gets "done". */
  let first: object | undefined
  let child: object | undefined

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mousse-codex-bot-tools-'))
    server = createServer((req, res) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404); res.end(); return }
        const body = JSON.parse(text) as Body
        requests.push(body)
        const answered = (body.input ?? []).some((item: any) => item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output')
        const item = !answered && isChild(body) && child ? child : !answered && !isChild(body) && first ? first : { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] }
        // The parent's answer after it started a child waits, so the child's own calls run before the turn ends.
        const afterSpawn = !isChild(body) && JSON.stringify(body.input ?? []).includes('task_name')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('response.created', { response: { id: 'r' } })
        setTimeout(() => {
          send('response.output_item.done', { item })
          send('response.completed', { response: { id: 'r', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } })
          res.end()
        }, afterSpawn ? 6_000 : 0)
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const port = (server.address() as { port: number }).port
    const codexHome = join(root, 'codex-home')
    const user = join(root, 'user')
    for (const dir of [codexHome, user]) mkdirSync(dir, { recursive: true })
    // The owner's own Codex: every feature that adds a tool on, and no sandbox at all.
    const features = [...CODEX_BOT_FEATURES_OFF, 'shell_tool', 'unified_exec', 'standalone_web_search', 'worktrees', 'workspace_dependencies', 'artifact', 'agent_message_board']
    writeFileSync(join(codexHome, 'config.toml'), [
      'model_provider = "probe"',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      '[model_providers.probe]', 'name = "probe"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', 'env_key = "PROBE_KEY"',
      '[features]', ...features.map((feature) => `${feature} = true`), ''
    ].join('\n'))
    questions = new UserQuestionService()
    service = new CodexProviderService(root, questions, {}, {
      dir: join(root, 'state'),
      env: () => ({ ...codexEnvironment(), CODEX_HOME: codexHome, PROBE_KEY: 'probe', USERPROFILE: user, HOME: user }),
      modelProvider: 'probe',
      launch: () => ({ binaryPath: BINARY! }),
      account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, label: 'tools check', subject: 'tools-check' }) }
    })
    await service.status()
    const conn = (service as unknown as { app: { conn: CodexConnection } }).app.conn
    models = (await conn.request('model/list', { includeHidden: true })).data
  }, 60_000)

  afterAll(async () => {
    service?.stop()
    await service?.processesExited()
    questions?.shutdown()
    server?.close()
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }, 30_000)

  let threads = 0
  /** A bot holding `tools`, without file access: its files folder and scratch only. */
  async function botTurn(model: string, tools: NeutralTool[]) {
    const files = join(root, `bot-${threads}`, 'files')
    const scratch = join(root, `bot-${threads}`, 'scratch')
    for (const folder of [files, scratch]) mkdirSync(folder, { recursive: true })
    const bot = createBotAuthority({
      activationId: `act-${threads}`, role: 'activation',
      permissions: { tools, appTools: [], mcp: [], skills: [], workspace: { roots: [], access: 'read', writeRoots: [], scratch, files } },
      waiting: () => false, counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    requests = []
    await service.chat({ threadId: `bot-tools-${threads++}`, cwd: scratch, model, prompt: 'Go.', mcp: null, bot, onText: () => undefined })
    return requests
  }
  const modelWith = (version: string | null) => models.find((model) => model.multiAgentVersion === version)

  const kinds: Array<[string, string | null]> = [['no subagents', null], ['v1 subagents', 'v1'], ['v2 subagents', 'v2']]
  it.each(kinds)('a model with %s: every tool offered is accounted for; commands only with "run commands"; nothing opens a file by its path', async (_name, version) => {
    const model = modelWith(version)
    expect(model, `the catalog lists a model with ${String(version)}`).toBeDefined()
    first = undefined
    child = undefined
    const without = offered((await botTurn(model!.id, ['read']))[0])
    const withShell = offered((await botTurn(model!.id, ['read', 'shell']))[0])
    for (const list of [without, withShell]) {
      expect(list.length).toBeGreaterThan(0)
      expect(list.filter((name) => !Object.hasOwn(ACCOUNTED, name)), `tools nobody has accounted for (${model!.id})`).toEqual([])
      expect(list.filter((name) => /view_image|image_gen|spawn_agents_on_csv|browser|computer|memor|goal|sleep|request_permissions|send_message_to_user/.test(name))).toEqual([])
    }
    expect(without.filter((name) => COMMANDS.test(name))).toEqual([])
    expect(withShell.filter((name) => COMMANDS.test(name)).length).toBeGreaterThan(0)
  }, 120_000)

  it.skipIf(process.platform === 'win32')('a subagent of a bot inherits its tools and sandbox, and Mousse answers nothing it asks: no command of a child runs', async () => {
    const model = modelWith('v2')
    expect(model).toBeDefined()
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret-1061.txt'), 'secret\n')
    first = { type: 'function_call', id: 'f1', call_id: 'call_1', namespace: 'collaboration', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'helper', message: CHILD_TASK, fork_turns: 'none' }) }
    const script = (cmd: string) => `text(JSON.stringify(ALL_TOOLS.map((t) => t.name)));\ntry { const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text(JSON.stringify(r)) } catch (e) { text("ERR " + String(e)) }`
    child = { type: 'custom_tool_call', id: 'c1', call_id: 'call_c1', namespace: 'functions', name: 'exec', input: script(`ls ${outside}`) }
    // A bot without "run commands": the child has no command tool either.
    const without = await botTurn(model!.id, ['read'])
    const childOf = (sent: Body[]) => sent.filter(isChild)
    expect(childOf(without).length).toBeGreaterThan(0)
    for (const body of childOf(without)) expect(offered(body).filter((name) => COMMANDS.test(name))).toEqual([])
    expect(JSON.stringify(without)).toContain('tools.exec_command is not a function')
    // A bot with "run commands": the child's command asks, and Mousse answers no child: it never runs.
    const withShell = await botTurn(model!.id, ['read', 'shell'])
    expect(childOf(withShell).length).toBeGreaterThan(0)
    expect(JSON.stringify(withShell)).not.toContain('secret-1061')
    first = undefined
    child = undefined
  }, 120_000)
})

// Without the binary every test above is skipped, and its name says so.
if (!BINARY && existsSync(resolve(__dirname, '..', '..', '.cache'))) console.info(`[codexBotTools]${SKIPPED}`)
