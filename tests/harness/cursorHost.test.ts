/**
 * The real Cursor host entry (`harness/hosts/cursorHost.ts`, bundled as the app bundles it) run as
 * a child process by the real driver, with a fake `@cursor/sdk` module: start-up, event
 * translation, the instance's key and the SDK's retries off on every call, no ambient key, and the
 * guards that keep one SDK failure from taking the host down (or end the turns when it does).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CursorHostClient, spawnCursorHost } from '../../src/mms/harness/cursor/hostClient'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import type { DriverContext, DriverRuntime } from '../../src/mms/harness/driver'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import type { TurnResult } from '../../src/mms/harness/adapter'
import { crashChild } from '../support/build'

const FAKE_SDK = join(__dirname, 'fakeCursorSdk.cjs')
let hostScript: string
beforeAll(async () => {
  // Bundled like `out/main/cursorHost.js`: an ES module with the SDK left external.
  hostScript = await crashChild('src/mms/harness/hosts/cursorHost.ts', { format: 'esm', external: ['@cursor/sdk'], name: 'cursor-host' })
}, 60_000)

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'mousse-cursor-host-'))
  dirs.push(stateDir)
  const log = join(stateDir, 'sdk-calls.ndjson')
  const context: DriverContext = {
    instanceId: 'cursor:work',
    builtIn: false,
    config: { home: 'default', displayName: 'Work' },
    // The daemon's own environment has a key; the host must never see it.
    env: instanceEnv({ instanceId: 'cursor:work', driver: 'cursor', configRevision: 0, searchPath: [], base: { ...process.env, CURSOR_API_KEY: 'ambient-key' } }),
    profileHome: stateDir,
    installationHome: stateDir,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: () => {}
  }
  const runtime = cursorDriver({ hostScript, hostEnv: { MOUSSE_CURSOR_SDK_MODULE: FAKE_SDK, MOUSSE_FAKE_CURSOR_LOG: log } }).create(context)
  runtimes.push(runtime)
  const calls = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }
  const tools: Array<{ phase: string; title: string }> = []
  const thinking: string[] = []
  const turn = (prompt: string): Promise<TurnResult> => runtime.adapter.startTurn(
    { threadId: 't', instanceId: 'cursor:work', llmProvider: '', model: 'gpt-5', mode: 'agent', prompt, cwd: stateDir, nativeHistory: '', signal: new AbortController().signal } as never,
    {
      text: () => {},
      thinking: (event: { phase: string; content: string }) => event.phase === 'delta' && thinking.push(event.content),
      tool: (event: { phase: string; title: string }) => tools.push({ phase: event.phase, title: event.title }),
      progress: () => {},
      providerRef: () => {},
      steerAccepted: () => {},
      usage: () => {}
    } as never,
    { drainSteer: () => undefined, heartbeat: () => {} } as never,
    { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as never
  )
  return { runtime, calls, turn, tools, thinking, stateDir }
}

describe('the Cursor host process', () => {
  it('signs in with an in-memory store and no browser, and passes the instance key to me and models', async () => {
    const { runtime, calls } = setup()
    const session = new LoginSession('login')
    const urls: string[] = []
    session.on('event', (event: { type: string; url?: string }) => event.type === 'auth_url' && urls.push(event.url!))
    expect(await runtime.signIn!(session, '/tmp', 'account')).toMatchObject({ success: true })
    expect(urls).toEqual(['https://cursor.com/loginDeepControl?challenge=fake'])
    await runtime.refreshModels!('/tmp')
    expect(runtime.models().map((model) => model.id)).toEqual(['default', 'gpt-5'])
    expect(calls().filter((call) => call.call !== 'models' || call.apiKey)).toEqual(expect.arrayContaining([
      { call: 'login', openBrowser: false, store: 'memory', signal: true },
      { call: 'me', apiKey: 'minted-key' },
      { call: 'models', apiKey: 'minted-key' }
    ]))
    expect(calls().some((call) => call.call === 'FileCredentialStore')).toBe(false)
  })

  it('translates a run into text, thinking and tool events, with the key, its store and the SDK retries off', async () => {
    const { runtime, calls, turn, tools, thinking, stateDir } = setup()
    await runtime.adoptApiKey!('user-key')
    const result = await turn('hello')
    expect(result).toMatchObject({ text: 'Hello', aborted: false, usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 } })
    expect(tools).toEqual([{ phase: 'start', title: 'Shell: npm test' }, { phase: 'complete', title: 'Shell: npm test' }])
    expect(thinking.at(-1)).toBe('Plan')
    const create = calls().find((call) => call.call === 'create')
    expect(create).toEqual({
      call: 'create',
      ambientKey: null,
      options: {
        apiKey: 'user-key',
        model: { id: 'gpt-5' },
        mode: 'agent',
        local: { store: 'jsonl', storeDir: join(stateDir, 'cursor-store'), settingSources: ['project', 'user', 'team', 'mdm', 'plugins'], enableAgentRetries: false, autoReview: true, customTools: false }
      }
    })
    // Sends inherit the agent's key and retries setting; they pass the model and mode, and no custom tools.
    expect(calls().find((call) => call.call === 'send')).toMatchObject({ text: 'hello', model: { id: 'gpt-5' }, mode: 'agent', keys: ['mode', 'model', 'onDelta'] })
  })

  it.each(['revoked', 'expired'])('signs the entry out when a run fails with an auth code the SDK reduced to a RunError (%s)', async (prompt) => {
    const { runtime, turn } = setup()
    await runtime.adoptApiKey!('user-key')
    await expect(turn(prompt)).rejects.toThrow(/Sign in to Work/)
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out', message: expect.stringMatching(/refused/) })
    expect(runtime.configured()).toBe(false)
  })

  it('removes the agents of a replaced key from the store, through the host', async () => {
    const { runtime, calls, turn, stateDir } = setup()
    await runtime.adoptApiKey!('user-key')
    await turn('hello')
    await runtime.adoptApiKey!('other-key')
    const storeDir = join(stateDir, 'cursor-store')
    await expect.poll(() => calls().filter((call) => String(call.call).startsWith('store.'))).toEqual([
      { call: 'store.runs.delete', storeDir, filter: { agentIds: ['agent-1'] } },
      { call: 'store.agents.delete', storeDir, filter: { agentIds: ['agent-1'] } }
    ])
  })

  it('closes the handle a second reopen of the same agent replaces', async () => {
    const { calls, stateDir } = setup()
    const client = new CursorHostClient(() => spawnCursorHost(instanceEnv({ instanceId: 'cursor:work', driver: 'cursor', configRevision: 0, searchPath: [], base: process.env }), hostScript, { MOUSSE_CURSOR_SDK_MODULE: FAKE_SDK, MOUSSE_FAKE_CURSOR_LOG: join(stateDir, 'sdk-calls.ndjson') }))
    try {
      const reopen = { apiKey: 'user-key', agentId: 'agent-1', cwd: stateDir, storeDir: join(stateDir, 'cursor-store'), settingSources: [], autoReview: true }
      await client.request('resume', reopen)
      await client.request('resume', reopen)
      expect(calls().filter((call) => call.call === 'close')).toEqual([{ call: 'close', agentId: 'agent-1', handle: 1 }])
    } finally {
      client.stop()
    }
  })

  it('fails a turn whose reply is only a transport error', async () => {
    const { runtime, turn } = setup()
    await runtime.adoptApiKey!('user-key')
    await expect(turn('transport')).rejects.toThrow(/lost its connection to Cursor \(Error: ConnectError: \[unavailable\] connection reset\)/)
  })

  it('keeps running after the SDK writes to a closed exec stream, and ends the turn once when another rejection kills it', async () => {
    const { runtime, turn } = setup()
    await runtime.adoptApiKey!('user-key')
    expect(await turn('closed-stream')).toMatchObject({ text: 'still here', aborted: false })
    expect(await turn('crash')).toMatchObject({ aborted: true })
    // The next turn starts a new host.
    expect(await turn('again')).toMatchObject({ text: 'ok', aborted: false })
  })
})
