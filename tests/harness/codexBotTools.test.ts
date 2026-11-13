/**
 * What a Codex offers a bot's turn, on the real binary, run as the owner's own Codex with every feature the binary lists
 * switched on in their config (`codex features list`): the worst a bot can meet. A fake Responses endpoint in this
 * process records every model request; nothing leaves the machine, nothing of the owner's is read, and nobody signs in.
 *
 * Which binaries: the pinned one (`npm run codex:pin`), or each of `MOUSSE_CODEX_BINARIES` (paths separated by `:`, `;`
 * on Windows; `MOUSSE_CODEX_BINARY` names one). Every tool offered must be accounted for, with what it can reach
 * (`CODEX_BOT_ACCOUNTED_TOOLS`), and the binary's version must be in `CODEX_BOT_CHECKED`: a tool a new Codex adds fails
 * here until someone has decided what it means for a bot, and only then is the version added. Each model kind of the
 * binary's catalog is checked (no subagents, `v1`, `v2`), for a bot without "run commands" and one with it, neither with
 * file access. Then a subagent: the models that have them keep `spawn_agent` whatever the config says, so a child must
 * inherit the bot's tools and sandbox, and Mousse must answer nothing a child asks.
 */
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CodexProviderService, codexEnvironment } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { CodexConnection } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import type { CodexModel } from '../../src/mms/harness/vendors/codex/protocol'
import { CodexInstallation } from '../../src/mms/harness/vendors/codex/installation'
import { CODEX_BOT_ACCOUNTED_TOOLS, CODEX_BOT_CHECKED_VERSIONS, CODEX_BOT_FEATURES_OFF } from '../../src/mms/harness/vendors/codex/childPolicy'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { NeutralTool } from '../../src/shared/harness/tools'

const pinned = new CodexInstallation({ installationHome: resolve(__dirname, '..', '..', '.cache', 'codex-pin') }).installed()
const listed = (process.env.MOUSSE_CODEX_BINARIES || process.env.MOUSSE_CODEX_BINARY || '').split(delimiter).filter(Boolean)
const BINARIES: Array<string | undefined> = listed.length ? listed : [pinned && !pinned.broken ? pinned.path : undefined]
const SKIPPED = ' [skipped: no pinned Codex; run npm run codex:pin]'
/** What `codex --version` says (`codex-cli 0.167.0`): the version alone. */
const versionOf = (binary: string): string => execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).at(-1)!

const COMMANDS = /(^|[.:])(exec_command|write_stdin|shell|local_shell)$/
/** Whether a `sleep <seconds>` runs anywhere on this computer (POSIX). */
const sleeping = (seconds: string): boolean => {
  try {
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').some((line) => line.trim() === `sleep ${seconds}`)
  } catch {
    return false
  }
}

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

for (const BINARY of BINARIES) describe.skipIf(!BINARY)(`what Codex ${BINARY ? versionOf(BINARY) : ''} offers a bot's turn, with every feature on in the owner's config${BINARY ? '' : SKIPPED}`, () => {
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
    // The owner's own Codex: every feature this binary lists on (`codex features list`), and no sandbox at all.
    const named = execFileSync(BINARY!, ['features', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } })
      .split('\n').map((line) => line.trim().split(/\s+/)[0]!).filter((name) => /^[a-z0-9_]+$/.test(name))
    expect(named.length).toBeGreaterThan(50)
    // `rollout_budget` won't load without settings whose form isn't documented; it is switched off for bots instead.
    const features = [...new Set([...named, ...CODEX_BOT_FEATURES_OFF])].filter((name) => name !== 'rollout_budget')
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
  function botOf(tools: NeutralTool[]) {
    const files = join(root, `bot-${threads}`, 'files')
    const scratch = join(root, `bot-${threads}`, 'scratch')
    for (const folder of [files, scratch]) mkdirSync(folder, { recursive: true })
    const bot = createBotAuthority({
      activationId: `act-${threads}`, role: 'activation',
      permissions: { tools, appTools: [], mcp: [], skills: [], workspace: { roots: [], access: 'read', writeRoots: [], scratch, files } },
      waiting: () => false, counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal }, spend: null
    })
    return { bot, files, scratch, threadId: `bot-tools-${threads++}` }
  }
  async function botTurn(model: string, tools: NeutralTool[]) {
    const { bot, scratch, threadId } = botOf(tools)
    requests = []
    await service.chat({ threadId, cwd: scratch, model, prompt: 'Go.', mcp: null, bot, onText: () => undefined })
    return requests
  }
  const modelWith = (version: string | null) => models.find((model) => model.multiAgentVersion === version)

  // A bot turn runs only on a Codex this file has checked: Mousse reads the version from what the binary says when it
  // starts. A binary given by `MOUSSE_CODEX_BINARY` fails here until its tools are accounted for and its version added.
  it('the version Mousse reads from this binary is one a bot may run on', () => {
    const app = (service as unknown as { app: { conn: CodexConnection }; versions: WeakMap<CodexConnection, string | undefined> })
    expect(app.versions.get(app.app.conn)).toBe(versionOf(BINARY!))
    expect(CODEX_BOT_CHECKED_VERSIONS).toContain(versionOf(BINARY!))
  })

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
      expect(list.filter((name) => !Object.hasOwn(CODEX_BOT_ACCOUNTED_TOOLS, name)), `tools nobody has accounted for (${model!.id})`).toEqual([])
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

  it.skipIf(process.platform === 'win32')('a bot turn stopped while its command runs ends at once, and so does the command (how Mousse stops a turn when a switch goes off)', async () => {
    const model = modelWith(null)!
    const { bot, scratch, threadId } = botOf(['read', 'shell'])
    // A duration nothing else on the computer sleeps for, so the command is found by it, whatever its sandbox's pids.
    const seconds = `300.${process.pid}`
    first = { type: 'function_call', id: 'f1', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: `exec sleep ${seconds}`, yield_time_ms: 30_000 }) }
    requests = []
    const stop = new AbortController()
    const turn = service.chat({ threadId, cwd: scratch, model: model.id, prompt: 'Go.', mcp: null, bot, signal: stop.signal, onText: () => undefined }).then(() => 'completed', () => 'stopped')
    const running = () => sleeping(seconds)
    await vi.waitFor(() => expect(running()).toBe(true), { timeout: 30_000, interval: 100 })
    const stoppedAt = Date.now()
    stop.abort(new Error('stopped'))
    expect(await turn).toBe('stopped')
    await vi.waitFor(() => expect(running()).toBe(false), { timeout: 15_000, interval: 100 })
    expect(Date.now() - stoppedAt).toBeLessThan(15_000)
    first = undefined
  }, 120_000)
})

// Without the binary every test above is skipped, and its name says so.
if (!BINARIES[0] && existsSync(resolve(__dirname, '..', '..', '.cache'))) console.info(`[codexBotTools]${SKIPPED}`)
