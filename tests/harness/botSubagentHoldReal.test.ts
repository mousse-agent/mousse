/**
 * The hold rule for a bot's subagents on the real binaries (docs/bots.md, "How each runtime holds a subagent"): on Linux,
 * work on Claude Code (in its sandbox) and a subagent on Codex, or the other way round, without file access: the rule
 * keeps the subagent's commands, and the subagent's own runtime holds them as tightly as the work's, so a command reads
 * nothing of the home folder outside the bot's folders. With file access, a subagent on Codex under work on Claude Code
 * runs with no command tool at all (Codex's sandbox would then read Mousse's own data).
 *
 * The subagent's turn is compiled by the real engine (`BotEngine`, on a real `bots.db`) with each runtime's tool names
 * and what its driver says about how it holds a bot here; the turn then runs on the real Codex (`CodexProviderService`)
 * or Claude Code (`ClaudeSubscriptionProviderService` and the Agent SDK) against a local fake model with a fake key.
 * Nothing leaves the machine and nobody signs in.
 *
 * Needs Linux with bubblewrap and socat on PATH, `XDG_RUNTIME_DIR` under `/run`, and `TMPDIR` under the home folder
 * (where Mousse's data is in an install); the Codex binary (`MOUSSE_CODEX_BINARY`, or the pinned one) and the Agent SDK's
 * Claude Code binary. Without them every test is skipped, with the reason in its name.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { systemTempDirs } from '../../src/mms/bots/grants/compile'
import { CLAUDE_NATIVE_TOOLS } from '../../src/mms/harness/claude/locked'
import { CODEX_NATIVE_TOOLS } from '../../src/mms/harness/vendors/codex/botApprovals'
import { CodexProviderService, codexEnvironment } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { CodexConnection } from '../../src/mms/harness/vendors/codex/CodexAppServerClient'
import { CodexInstallation } from '../../src/mms/harness/vendors/codex/installation'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import type { NeutralTool } from '../../src/shared/harness/tools'
import { botFixture, createBot, start, type BotFixture } from '../bots/botFixture'

const onPath = (name: string) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, name)))
const runtimeDir = process.env.XDG_RUNTIME_DIR
const SANDBOX = process.platform === 'linux' && onPath('bwrap') && onPath('socat') && Boolean(runtimeDir?.startsWith('/run/')) && existsSync(runtimeDir!) && tmpdir().startsWith(`${homedir()}/`)
const pinned = new CodexInstallation({ installationHome: resolve(__dirname, '..', '..', '.cache', 'codex-pin') }).installed()
const CODEX = process.env.MOUSSE_CODEX_BINARY || (pinned && !pinned.broken ? pinned.path : undefined)
const CLAUDE = process.env.MOUSSE_CLAUDE_EVIDENCE_BINARY || join(process.cwd(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude')
const READY = SANDBOX && Boolean(CODEX && existsSync(CODEX)) && existsSync(CLAUDE)
const SKIPPED = READY ? '' : ' [skipped: needs Linux with bubblewrap and socat on PATH, XDG_RUNTIME_DIR under /run, TMPDIR under the home folder, and the Codex and Claude Code binaries]'

type Json = Record<string, unknown>
const NAMES: Record<string, Readonly<Partial<Record<NeutralTool, readonly string[]>>>> = { claude: CLAUDE_NATIVE_TOOLS, codex: CODEX_NATIVE_TOOLS }

/** A command that says, for each path, whether it could be read, and nothing of what it holds. */
const reads = (paths: Record<string, string>) => Object.entries(paths).map(([name, path]) => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo "read ${name}"; else echo "denied ${name}"; fi`).join('; ')

describe(`a subagent on the other runtime is held as its work is, on the real binaries${SKIPPED}`, () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  /**
   * The real engine: work on `work`'s entry, allowed commands (and file access) for this work, starts a subagent on the
   * other entry. Returns the subagent's prepared turn, what it was told it lacks, and a file outside the bot's folders.
   */
  async function subagentOf(work: 'claude' | 'codex', options: { files?: boolean; codexModel?: string } = {}) {
    const f: BotFixture = botFixture()
    cleanups.push(() => f.close())
    const selection = { claude: { instanceId: 'claude', model: 'claude-sonnet-4-5' }, codex: { instanceId: 'codex', model: options.codexModel ?? 'gpt-5.5' } }
    const choices: BotModelOption[] = [
      { instanceId: 'claude', entry: 'Claude Code', model: selection.claude.model, label: 'Sonnet', efforts: [] },
      { instanceId: 'codex', entry: 'Codex', model: selection.codex.model, label: 'Codex model', efforts: [] }
    ]
    f.host.platform = 'linux'
    f.host.instructions = (bot) => botInstructions(bot)
    f.host.modelOptions = async () => choices
    f.host.harness.nativeToolNames = (instanceId, tools) => ({ ok: true, names: tools.flatMap((tool) => [...(NAMES[instanceId]![tool] ?? [])]) })
    // What the drivers say here: Claude Code's sandbox runs (bubblewrap and socat on PATH); Codex switches its search off.
    f.host.harness.botHold = (instanceId) => (instanceId === 'claude' ? { runtime: 'claude', sandbox: 'available' } : { runtime: 'codex', hostedSearch: 'off_without_web' })
    f.candidates = [selection[work]]
    await f.bots.reconcileOnStartup()
    const { botId } = await createBot(f, { name: 'Pip', description: 'Check the build.', reply: 'Hello.' })
    const activation = await f.bots.activate({ botId, input: 'Check the build.', clientRequestId: 'w1' })
    f.store.putOverlay(activation.id, 'shell', { tool: 'shell' })
    if (options.files) f.store.putOverlay(activation.id, 'files', { path: f.base, access: 'write' })
    const job = await start(f, activation.id)
    const other = work === 'claude' ? 'codex' : 'claude'
    const started = await job.prepared.authority.subagents!.start({ title: 'Build', brief: 'Run the build.', model: { pick: selection[other], name: { name: choices.find((option) => option.instanceId === other)!.label, entry: choices.find((option) => option.instanceId === other)!.entry } } })
    if ('refused' in started) throw new Error(started.refused)
    const n = f.store.dispatches(activation.id).filter((dispatch) => dispatch.kind === 'subagent').at(-1)!.n
    const child = await start(f, activation.id, n)
    const files = child.prepared.authority.workspace!.files!
    writeFileSync(join(files, 'own.txt'), 'own\n')
    const outside = mkdtempSync(join(tmpdir(), 'mousse-outside-'))
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    return { child, lacks: started.lacks ?? [], files, secret: join(outside, 'secret.txt'), own: join(files, 'own.txt') }
  }

  /** The real Codex with a fake Responses endpoint: the first request of a turn gets `first`, every other "done". */
  async function codex() {
    const root = mkdtempSync(join(tmpdir(), 'mousse-sub-codex-'))
    const requests: Json[] = []
    let first: Json | undefined
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let text = ''
      req.on('data', (chunk) => (text += chunk))
      req.on('end', () => {
        if (!req.url?.includes('/responses')) return void res.writeHead(404).end()
        const body = JSON.parse(text) as { input?: Json[] }
        requests.push(body)
        const answered = (body.input ?? []).some((item) => item.type === 'function_call_output')
        const item = !answered && first ? first : { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (type: string, data: Json) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        send('response.created', { response: { id: 'r' } })
        send('response.output_item.done', { item })
        send('response.completed', { response: { id: 'r', usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } })
        res.end()
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const codexHome = join(root, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'config.toml'), ['model_provider = "probe"', '[model_providers.probe]', 'name = "probe"', `base_url = "http://127.0.0.1:${(server.address() as AddressInfo).port}/v1"`, 'wire_api = "responses"', 'env_key = "PROBE_KEY"', ''].join('\n'))
    const questions = new UserQuestionService()
    const service = new CodexProviderService(root, questions, {}, {
      dir: join(root, 'state'),
      env: () => ({ ...codexEnvironment(), CODEX_HOME: codexHome, PROBE_KEY: 'probe' }),
      modelProvider: 'probe',
      launch: () => ({ binaryPath: CODEX! }),
      account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, label: 'hold check', subject: 'hold-check' }) }
    })
    await service.status()
    const conn = (service as unknown as { app: { conn: CodexConnection } }).app.conn
    const models = (await conn.request('model/list', { includeHidden: true })).data as Array<{ id: string; multiAgentVersion: unknown }>
    cleanups.push(async () => {
      service.stop()
      await service.processesExited()
      questions.shutdown()
      server.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    })
    return {
      model: models.find((model) => model.multiAgentVersion === null)!.id,
      requests,
      /** One turn of `bot`, whose model's first answer is `call`. */
      turn: async (bot: BotAuthority, cwd: string, call: Json | undefined) => {
        first = call
        requests.length = 0
        await service.chat({ threadId: `sub-${Math.random().toString(16).slice(2)}`, cwd, model: models.find((model) => model.multiAgentVersion === null)!.id, prompt: 'Go.', mcp: null, bot, onText: () => undefined })
        return requests
      }
    }
  }

  /** The real Claude Code through the Agent SDK, with a fake Messages API whose first answer runs `command` in Bash. */
  async function claude(command: string) {
    const base = mkdtempSync(join(tmpdir(), 'mousse-sub-claude-'))
    const results: string[] = []
    let calls = 0
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const path = (req.url ?? '').split('?')[0]
        if (path.endsWith('/count_tokens')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }))
        if (req.method !== 'POST' || path !== '/v1/messages') return void res.writeHead(404).end()
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream?: boolean; tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> }
        for (const message of body.messages) if (Array.isArray(message.content)) for (const block of message.content as Json[]) if (block.type === 'tool_result') results.push(JSON.stringify(block.content))
        const asked = body.messages.some((message) => Array.isArray(message.content) && (message.content as Json[]).some((block) => block.type === 'tool_use'))
        const block: Json = body.tools?.some((tool) => tool.name === 'Bash') && !asked ? { type: 'tool_use', id: `toolu_${++calls}`, name: 'Bash', input: { command, description: 'Check what a command reads' } } : { type: 'text', text: 'done' }
        const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
        const message = { id: `msg_${++calls}`, type: 'message', role: 'assistant', model: body.model, content: [] as Json[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
        if (!body.stream) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason }))
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const send = (event: string, data: Json) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
        send('message_start', { message })
        send('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } })
        send('message_stop', {})
        res.end()
      })().catch((error) => res.writeHead(500).end(String(error)))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const dirs = { userHome: join(base, 'user-home'), instanceHome: join(base, 'instance-home'), state: join(base, 'state') }
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
    mkdirSync(join(dirs.state, 'providers', 'claude-subscription'), { recursive: true })
    writeFileSync(join(dirs.state, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', models: [{ id: 'sonnet', label: 'Sonnet' }] }))
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const service = new ClaudeSubscriptionProviderService(dirs.state, new UserQuestionService(), {
      probe: () => ({ kind: 'signed_in', account: { label: 'API key', credential: 'api_key' } }),
      launchConfig: () => ({ binaryPath: CLAUDE }),
      baseEnv: () => ({ PATH: process.env.PATH, HOME: dirs.userHome, CLAUDE_CONFIG_DIR: dirs.instanceHome, ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}) }),
      finalEnv: (env) => ({ ...env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-api03-fake-local', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_MAX_RETRIES: '0' }),
      query: ({ prompt, options }) => sdk.query({ prompt, options })
    })
    cleanups.push(async () => {
      await service.stop()
      server.close()
      rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    })
    const ledger: ToolLedger = { start: () => 'call', commit: () => undefined, failed: () => undefined }
    return {
      results,
      turn: (authority: BotAuthority, cwd: string) => service.chat({
        threadId: `sub-${Math.random().toString(16).slice(2)}`, cwd, model: 'claude-sonnet-4-5', prompt: 'Go.', permissionMode: 'ask', mcp: null, onText: () => undefined,
        locked: { authority, ownerEntry: true, ledger, cwd, shellContained: true, temps: systemTempDirs(), systemPrompt: 'You are a subagent of a test bot.' }
      })
    }
  }

  it.skipIf(!READY)('work on Claude Code, a subagent on Codex: it keeps commands, and on Codex they read nothing of the home folder outside the bot\'s folders', async () => {
    const run = await codex()
    const { child, lacks, files, secret, own } = await subagentOf('claude', { codexModel: run.model })
    expect(lacks).toEqual([])
    expect(child.prepared.authority.tools.has('shell')).toBe(true)
    const sent = await run.turn(child.prepared.authority, files, { type: 'function_call', id: 'f1', call_id: 'call_1', name: 'exec_command', arguments: JSON.stringify({ cmd: reads({ secret, own }) }) })
    const said = JSON.stringify(sent)
    expect(said).toContain('denied secret')
    expect(said).toContain('read own')
  }, 120_000)

  it.skipIf(!READY)('work on Codex, a subagent on Claude Code: commands are withheld because Claude Code opens the shared temporary folder', async () => {
    const { child, lacks, files, secret, own } = await subagentOf('codex')
    expect(lacks).toEqual(['run commands'])
    expect(child.prepared.authority.tools.has('shell')).toBe(false)
    const run = await claude(reads({ secret, own }))
    expect(await run.turn(child.prepared.authority, files)).toContain('done')
    const said = run.results.join('\n')
    expect(said).not.toContain('read own')
    expect(said).not.toContain('read secret')
  }, 120_000)

  it.skipIf(!READY)('with file access, work on Claude Code: a subagent on Codex is offered no command tool at all', async () => {
    const run = await codex()
    const { child, lacks, files } = await subagentOf('claude', { files: true, codexModel: run.model })
    expect(lacks).toEqual(['run commands'])
    const sent = await run.turn(child.prepared.authority, files, undefined)
    const offered = ((sent[0] as { tools?: Array<{ name?: string; type?: string }> }).tools ?? []).map((tool) => tool.name ?? tool.type)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.filter((name) => /exec_command|write_stdin|shell/.test(String(name)))).toEqual([])
  }, 120_000)
})
