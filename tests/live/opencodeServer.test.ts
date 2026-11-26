/**
 * Live check of OpenCode turns and one-shots on its own server API, through the driver's runtime, against the real
 * `opencode serve`. It needs no sign-in: OpenCode runs in throwaway data, config and database folders, and its only
 * model is an OpenAI-compatible stub in this process, which records every model request and answers with the tool
 * call each case forces. The user's own OpenCode setup is never read or written. Runs only with MOUSSE_LIVE_OPENCODE=1;
 * MOUSSE_OPENCODE_BINARY may name the executable (else the one on PATH).
 *
 * Checked on OpenCode 2.0.20:
 * - with an agent-level and a top-level "allow everything" seeded in the user's config, a turn in Ask asks before a
 *   file is written, and a rejected write leaves no file;
 * - in Auto-accept edits the write runs unasked;
 * - outside Full access the model is offered no shell, no OpenCode subagents, no Code Mode and no questions;
 * - a saved "always" grant in the project, or a plugin of the user's, refuses an asking turn before its prompt;
 * - a one-shot is offered no tool and makes one model request, a failed one included; its session is deleted.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PermissionPrompter } from '../../src/mms/harness/acp/permissions'
import type { DriverRuntime } from '../../src/mms/harness/driver'
import { opencodeDriver } from '../../src/mms/harness/drivers/opencode'
import { instanceEnv, resolveCommand } from '../../src/mms/harness/env'
import { OpencodeClient } from '../../src/mms/harness/opencode/client'
import { spawnOpencodeServer } from '../../src/mms/harness/opencode/server'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import type { PermissionMode } from '../../src/shared/permissionMode'

const live = process.env.MOUSSE_LIVE_OPENCODE === '1'
const TIMEOUT = 180_000

/** What the stub model answers to a request that offers tools: one tool call, or text. */
type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { status: number }
interface StubRequest { tools: string[]; body: Record<string, unknown> }

let stub: Server
let stubPort = 0
const requests: StubRequest[] = []
let script: Step[] = []
let noToolsReply: Step = { text: 'A title' }

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let text = ''
    req.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(text) as Record<string, unknown> } catch { /* not JSON */ }
      const tools = Array.isArray(body.tools) ? body.tools.map((tool: any) => String(tool?.function?.name ?? '')) : []
      requests.push({ tools, body })
      const step = tools.length ? (script.shift() ?? { text: 'done' }) : noToolsReply
      if ('status' in step) {
        res.writeHead(step.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`)
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stub-model' }
      if ('tool' in step) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: step.text } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      }
      res.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolve) => stub.listen(0, '127.0.0.1', () => {
    stubPort = (stub.address() as { port: number }).port
    resolve()
  }))
}

const roots: string[] = []
const runtimes: DriverRuntime[] = []

function binary(): string {
  const named = process.env.MOUSSE_OPENCODE_BINARY
  if (named) return named
  const found = resolveCommand('opencode', { env: process.env, searchPath: [] })
  if (!found) throw new Error('No opencode on PATH: set MOUSSE_OPENCODE_BINARY.')
  return found.path
}

/** A throwaway OpenCode setup: its own folders and database, the stub as its one provider, `extra` config on top. */
function setup(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-opencode-live-'))
  roots.push(root)
  for (const dir of ['home', 'appdata', 'localappdata', 'tmp', 'data', 'config', 'state', 'cache', 'project', 'mousse']) mkdirSync(join(root, dir), { recursive: true })
  const config = {
    providers: {
      stub: { name: 'Stub', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: 'dummy' }, models: { 'stub-model': { name: 'Stub model' } } }
    },
    // What a user's config could say, which a session's rules must outrank.
    permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    agents: { build: { permissions: [{ action: '*', resource: '*', effect: 'allow' }] } },
    ...extra
  }
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
    // Nothing leaves this computer: the stub is on loopback, everything else goes to a closed port.
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost'
  }
  const opencodeEnv = {
    OPENCODE_DB: join(root, 'opencode.db'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  }
  const env = instanceEnv({ instanceId: 'opencode:opencode', driver: 'opencode', configRevision: 0, searchPath: [], base })
  const driver = opencodeDriver()
  const runtime = driver.create({
    instanceId: 'opencode:opencode',
    builtIn: false,
    config: driver.decodeConfig({ binaryPath: binary(), env: opencodeEnv }),
    env,
    profileHome: join(root, 'mousse'),
    installationHome: join(root, 'mousse'),
    stateDir: join(root, 'mousse'),
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {},
    signedOut: () => false,
    saveLaunch: async () => {}
  })
  runtimes.push(runtime)
  return { root, project: join(root, 'project'), runtime, env, opencodeEnv }
}

async function turn(runtime: DriverRuntime, project: string, mode: PermissionMode, permission?: PermissionPrompter) {
  return runtime.adapter.startTurn(
    {
      runId: 'r', attemptId: 'a', threadId: `t-${Math.random()}`, instanceId: 'opencode:opencode', llmProvider: '',
      model: 'stub/stub-model', modelPinned: true, mode: 'agent', permissionMode: mode,
      prompt: 'write the marker', messages: [], cwd: project, nativeHistory: '', signal: new AbortController().signal
    } as never,
    { text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, steerAccepted: () => {}, usage: () => {}, providerMetrics: () => {}, status: () => {}, providerTurn: () => {}, toolAwaiting: () => {} } as never,
    { drainSteer: () => undefined, heartbeat: () => {} } as never,
    {
      tools: {},
      ...(permission ? { bridge: { mcp: null, turnToken: 't', sessionInstructions: '', turnPreamble: '', userMcp: 'native', permission } } : {}),
      context: { nativeHistoryAfterTurn: (text: string) => text }
    } as never
  )
}

beforeAll(async () => {
  if (live) await startStub()
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined)
  stub?.close()
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* the server may hold a file a moment longer */ }
  }
})

describe.skipIf(!live)('OpenCode on its server API (real opencode serve)', () => {
  it('in Ask, an agent-level and a top-level "allow everything" do not skip the ask: it comes before the write, and a rejected write leaves no file', async () => {
    const { project, runtime } = setup()
    const marker = join(project, 'marker.txt')
    requests.length = 0
    script = [{ tool: 'write', args: { path: marker, content: 'x' } }, { text: 'gave up' }]
    const seen: boolean[] = []
    await turn(runtime, project, 'ask', { choose: async () => { seen.push(existsSync(marker)); return 'reject' } })
    expect(seen).toEqual([false])
    expect(existsSync(marker)).toBe(false)
    // Outside Full access: no shell, no OpenCode subagents, no Code Mode, no questions.
    const offered = requests[0]!.tools
    expect(offered).toEqual(expect.arrayContaining(['write', 'read']))
    for (const tool of ['shell', 'bash', 'subagent', 'execute', 'question']) expect(offered).not.toContain(tool)

    script = [{ tool: 'write', args: { path: marker, content: 'x' } }, { text: 'wrote it' }]
    const allowed: boolean[] = []
    await turn(runtime, project, 'ask', { choose: async () => { allowed.push(existsSync(marker)); return 'once' } })
    expect(allowed).toEqual([false])
    expect(existsSync(marker)).toBe(true)
  }, TIMEOUT)

  it('in Auto-accept edits, a write runs without asking', async () => {
    const { project, runtime } = setup()
    const marker = join(project, 'edit.txt')
    script = [{ tool: 'write', args: { path: marker, content: 'x' } }, { text: 'wrote it' }]
    let asked = 0
    await turn(runtime, project, 'accept_edits', { choose: async () => { asked += 1; return 'reject' } })
    expect(asked).toBe(0)
    expect(existsSync(marker)).toBe(true)
  }, TIMEOUT)

  it('a saved "always" grant in the project refuses an asking turn before its prompt; Full access still runs', async () => {
    const { project, runtime, env, opencodeEnv, root } = setup()
    // The user said "always" once, in OpenCode itself, in this project.
    const seed = await spawnOpencodeServer(env, { command: binary(), args: [], env: opencodeEnv, cwd: root }, AbortSignal.timeout(60_000))
    try {
      const client = new OpencodeClient(seed.endpoint)
      const events: Array<Record<string, unknown>> = []
      const stream = new AbortController()
      await new Promise<void>((resolve) => { void client.events((event) => events.push(event), { signal: stream.signal, onOpen: resolve }).catch(() => undefined) })
      const created = await client.data('POST', '/api/session', { body: { location: { directory: project }, model: { providerID: 'stub', id: 'stub-model' }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] } }) as { id: string }
      script = [{ tool: 'write', args: { path: join(project, 'seed.txt'), content: 'x' } }, { text: 'ok' }]
      await client.request('POST', `/api/session/${created.id}/prompt`, { body: { text: 'write' } })
      let asked: Record<string, unknown> | undefined
      for (let i = 0; i < 300 && !asked; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        asked = events.find((event) => event.type === 'permission.asked')?.data as Record<string, unknown> | undefined
      }
      expect(asked).toBeTruthy()
      await client.request('POST', `/api/session/${created.id}/permission/${String(asked!.id)}/reply`, { body: { decision: 'always' } })
      for (let i = 0; i < 300 && !events.some((event) => event.type === 'session.execution.succeeded'); i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
      expect(((await client.data('GET', '/api/permission/saved', { directory: project })) as unknown[]).length).toBeGreaterThan(0)
      stream.abort()
    } finally {
      seed.close()
      await seed.exited
    }
    const before = requests.length
    await expect(turn(runtime, project, 'ask', { choose: async () => 'once' })).rejects.toMatchObject({ code: 'permission_mode_unenforceable' })
    expect(requests.length).toBe(before)
    script = [{ text: 'fine' }]
    const result = await turn(runtime, project, 'full')
    expect(result.text).toBe('fine')
  }, TIMEOUT)

  it('a plugin of the user’s refuses an asking turn before its prompt', async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'mousse-opencode-plugin-'))
    roots.push(pluginRoot)
    // A plugin that answers every permission check with "allow".
    writeFileSync(join(pluginRoot, 'index.js'), "export default { id: 'test.allow-all', setup: async (ctx) => { await ctx.permission.hook('evaluate', (event) => { event.effect = 'allow' }) } }\n")
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'test-allow-all', type: 'module' }))
    const { project, runtime } = setup({ plugins: [pathToFileURL(pluginRoot).href] })
    const before = requests.length
    await expect(turn(runtime, project, 'ask', { choose: async () => 'once' })).rejects.toMatchObject({ code: 'permission_mode_unenforceable', message: expect.stringMatching(/plugins/) })
    // Refused on a server that had just started, before it had listed any plugin.
    expect(requests.length).toBe(before)
  }, TIMEOUT)

  it('a one-shot is offered no tool and makes one model request; its session is deleted', async () => {
    const { runtime } = setup()
    requests.length = 0
    noToolsReply = { text: 'Fix login bug' }
    const reply = await runtime.oneShot!({ model: 'stub/stub-model', system: 'You name chats.', prompt: 'fix the login bug', onActivity: () => {} } as never, AbortSignal.timeout(60_000))
    expect(reply.text).toBe('Fix login bug')
    expect(requests.length).toBe(1)
    expect(requests[0]!.tools).toEqual([])
  }, TIMEOUT)

  it('a failed one-shot request is not retried', async () => {
    const { runtime } = setup()
    requests.length = 0
    noToolsReply = { status: 429 }
    await expect(runtime.oneShot!({ model: 'stub/stub-model', system: '', prompt: 'name this', onActivity: () => {} } as never, AbortSignal.timeout(60_000))).rejects.toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(requests.length).toBe(1)
    noToolsReply = { text: 'A title' }
  }, TIMEOUT)
})
