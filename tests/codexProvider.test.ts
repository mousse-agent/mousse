import { EventEmitter, getEventListeners } from 'node:events'
import { createInterface } from 'node:readline'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { userCodexLimitsReader } from '../src/mms/harness/drivers/codex'
import { LoginSession } from '../src/mms/providers/LoginSession'
import { claudeLockedSpawn } from '../src/mms/harness/claude/locked'
import type { WindowsProviderTree } from '../src/mms/harness/windowsProviderProcess'
import { spawnCodexAppServer, type CodexLaunch, type CodexProcess } from '../src/mms/harness/vendors/codex/CodexAppServerClient'
import {
  CODEX_ACCOUNT_TTL_MS,
  CODEX_IDLE_CLOSE_MS,
  CODEX_MAX_LOADED_THREADS,
  CODEX_MODEL_PROVIDER,
  CodexProviderService,
  CodexTurnFailure,
  codexEnvironment,
  codexModelOption,
  type CodexServiceDependencies,
  type CodexServiceOptions
} from '../src/mms/harness/vendors/codex/CodexProviderService'
import { codexMcpConfigOverrides } from '../src/mms/run/mcp/attachment'
import { codexFixtureAccessToken } from '../src/mms/run/testkit/codexAppServerReplay'
import { CODEX_ONE_SHOT_FEATURES_OFF, codexOneShotRunsOn } from '../src/mms/harness/vendors/codex/oneShot'
import type { OneShotSpec } from '../src/mms/harness/driver'
import { CHATGPT_CODEX_BASE_URL, type CodexDirectStream } from '../src/mms/harness/vendors/codex/directOneShot'
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from '@earendil-works/pi-ai'

type Message = { id?: number | string; method?: string; params?: unknown }
type Reply = { result?: unknown; error?: { code: number; message: string } }

/** An app-server stand-in answering each request through `answer`; records launches and messages. */
function scriptedServer(answer: (message: Message, launchIndex: number) => Reply | undefined) {
  const launches: CodexLaunch[] = []
  const messages: Message[] = []
  const processes: Array<EventEmitter & CodexProcess & { stdout: PassThrough }> = []
  const launch = (spec: CodexLaunch): CodexProcess => {
    const launchIndex = launches.push(spec) - 1
    const authHome = spec.env.CODEX_HOME ?? join(home, '.codex')
    let startupAuth: { access_token?: string; account_id?: string } | undefined
    if (authHome.startsWith(home)) {
      try {
        startupAuth = JSON.parse(readFileSync(join(authHome, 'auth.json'), 'utf8')).tokens
      } catch {
        // No file-backed credentials for this process.
      }
    }
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const process = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals = 'SIGTERM') {
        if (process.signalCode) return false
        process.signalCode = signal
        setImmediate(() => process.emit('exit', null, signal))
        return true
      }
    })
    let pending = ''
    stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\n')) !== -1) {
        const message = JSON.parse(pending.slice(0, end)) as Message
        pending = pending.slice(end + 1)
        messages.push(message)
        if (message.id === undefined || !message.method) continue
        let reply = message.method === 'initialize' ? { result: { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' } } : answer(message, launchIndex)
        // The fixture defaults to Codex's file store unless the test supplies a config or an error.
        if (message.method === 'config/read' && !reply?.error &&
            !(reply?.result && typeof reply.result === 'object' && 'config' in reply.result)) reply = { result: { config: {} } }
        if (message.method === 'account/read' && reply?.result && typeof reply.result === 'object' &&
            'account' in reply.result && (reply.result.account as { type?: string } | null)?.type === 'chatgpt' &&
            !('workspaceRouting' in reply.result) && startupAuth?.account_id)
          reply = { result: { ...reply.result, workspaceRouting: { chatgptAccountId: startupAuth.account_id } } }
        if (message.method === 'getAuthStatus' && !reply?.error &&
            !(reply?.result && typeof reply.result === 'object' && 'authMethod' in reply.result))
          reply = { result: { authMethod: 'chatgpt', authToken: startupAuth?.access_token ?? null } }
        if (reply) stdout.write(JSON.stringify({ id: message.id, ...reply }) + '\n')
      }
    })
    processes.push(process as unknown as EventEmitter & CodexProcess & { stdout: PassThrough })
    return process as unknown as CodexProcess
  }
  return { launch, launches, messages, processes, methods: () => messages.map((message) => message.method) }
}

const chatgpt = { result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } }

function writeTerminalAuth(dir: string, workspace: string | undefined, signature?: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: workspace, access_token: codexFixtureAccessToken(workspace, signature) }
  }))
}

let home: string
let binary: string
let questions: UserQuestionService
/** The instance's signed-out flag (the gateway's), as the services read it. */
let signedOut = false
const services: CodexProviderService[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-codex-service-'))
  const terminalHome = join(home, 'terminal')
  writeTerminalAuth(terminalHome, 'workspace-one')
  vi.stubEnv('CODEX_HOME', terminalHome)
  binary = join(home, 'codex')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o755)
  questions = new UserQuestionService()
  signedOut = false
})
afterEach(() => {
  for (const service of services.splice(0)) void service.stop().catch(() => undefined)
  questions.shutdown()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function create(server: Pick<ReturnType<typeof scriptedServer>, 'launch'>, settings: Record<string, unknown> = {}, options: CodexServiceOptions = {}): CodexProviderService {
  mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
  writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, ...settings }))
  // The instance config's launch settings and sign-out flag, as the gateway hands them over.
  const service = new CodexProviderService(home, questions, { launch: server.launch }, {
    launch: () => ({ binaryPath: binary }),
    signedOut: () => signedOut,
    ...options
  })
  services.push(service)
  return service
}

describe('Codex credentials in messages', () => {
  it('keeps a token printed on stderr during the sign-in check out of the public status', async () => {
    const canary = 'canary-secret-token-value-0123456789'
    let exitWith: (() => void) | undefined
    const server = scriptedServer((message) => {
      if (message.method === 'account/read') exitWith?.()
      return undefined
    })
    const service = create(server)
    exitWith = () => {
      const process = server.processes.at(-1)!
      ;(process as unknown as { stderr: PassThrough }).stderr.write(`mcp_servers.mousse: Authorization: Bearer ${canary}\n`)
      setImmediate(() => process.emit('exit', 1, null))
    }
    const status = await service.status({ force: true })
    expect(status.state).toBe('error')
    expect(status.message).toContain('Codex did not report its sign-in')
    expect(status.message).not.toContain(canary)
    expect(JSON.stringify(status)).not.toContain(canary)
  })
})

describe('Windows provider process shutdown', () => {
  it.runIf(process.platform === 'win32')('awaits a real detached descendant after the root exits on EOF', async () => {
    const fixturePath = join(home, 'provider.cjs')
    writeFileSync(fixturePath, [
      "const { spawn } = require('node:child_process')",
      "const readline = require('node:readline')",
      "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true })",
      'helper.unref()',
      'const input = readline.createInterface({ input: process.stdin })',
      "input.on('line', (line) => { const { id } = JSON.parse(line); if (id) console.log(JSON.stringify({ id, result: { userAgent: 'fixture' } })) })",
      "input.once('close', () => process.exit(0))",
      "helper.once('spawn', () => console.error(helper.pid))"
    ].join('\n'))
    let helper: number | undefined
    let ready!: (pid: number) => void
    const spawned = new Promise<number>((resolve) => { ready = resolve })
    const service = create({ launch: (spec) => {
      const proc = spawnCodexAppServer({ ...spec, binary: process.execPath, entryArgs: [fixturePath] })
      const lines = createInterface({ input: proc.stderr! })
      lines.on('line', (line) => { if (/^[0-9]+$/.test(line.trim())) ready(Number(line)) })
      return proc
    } })
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    try {
      await service.userSetup(home)
      helper = await spawned
      expect(alive(helper)).toBe(true)
      await service.stop()
      expect(alive(helper)).toBe(false)
    } finally {
      await service.stop()
      if (helper && alive(helper)) process.kill(helper, 'SIGKILL')
    }
  })

  it.runIf(process.platform === 'win32').each(['Codex', 'locked Claude'])('%s drains the supervisor, provider and detached child with backpressured stdin', async (provider) => {
    const fixturePath = join(home, 'blocked-provider.cjs')
    writeFileSync(fixturePath, [
      "const { spawn } = require('node:child_process')",
      "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true })",
      'helper.unref()',
      "helper.once('spawn', () => console.log(JSON.stringify([process.pid, helper.pid])))",
      'setInterval(() => {}, 1000)'
    ].join('\n'))
    let tree: WindowsProviderTree | undefined
    let codex: CodexProcess | undefined
    const controller = new AbortController()
    const service = provider === 'Codex' ? create({ launch: (spec) => {
      codex = spawnCodexAppServer({ ...spec, binary: process.execPath, entryArgs: [fixturePath], cwd: home })
      return codex
    } }) : undefined
    const setup = service?.userSetup(home)
    const proc = codex ?? claudeLockedSpawn({ onWindowsTree: (job) => { tree = job } })({
      command: process.execPath,
      args: [fixturePath],
      env: process.env,
      cwd: home,
      signal: controller.signal
    }) as unknown as CodexProcess
    const lines = createInterface({ input: proc.stdout! })
    const pids = [proc.pid!]
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    try {
      const line = await new Promise<string>((resolve, reject) => {
        lines.once('line', resolve)
        proc.once('exit', () => reject(new Error('Provider exited before publishing its PIDs')))
      })
      pids.push(...JSON.parse(line) as number[])
      expect(pids.map(alive)).toEqual([true, true, true])
      expect(proc.stdin!.write(Buffer.alloc(16 * 1024 * 1024))).toBe(false)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(proc.stdin!.writableNeedDrain).toBe(true)
      if (provider === 'locked Claude') {
        expect(tree).toBeDefined()
        controller.abort()
        await tree!.exited
      } else {
        await service!.stop()
        await setup
      }
      expect(pids.map(alive)).toEqual([false, false, false])
    } finally {
      lines.close()
      if (pids.some(alive)) {
        const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
        for (const pid of pids) {
          try { if (alive(pid)) process.kill(pid, 'SIGKILL') } catch { /* The job may have ended it. */ }
        }
        if (proc.exitCode === null && proc.signalCode === null) await exited
      }
    }
  }, 15_000)

})

describe('codexEnvironment', () => {
  it('strips API keys and OpenAI routing, keeps the rest, and never sets CODEX_HOME', () => {
    const env = codexEnvironment({
      PATH: '/bin',
      HOME: '/home/me',
      OPENAI_API_KEY: 'sk-1',
      OPENAI_BASE_URL: 'https://proxy',
      OPENAI_ORG_ID: 'org',
      AZURE_OPENAI_API_KEY: 'az',
      CODEX_API_KEY: 'ck',
      CODEX_ACCESS_TOKEN: 'tok',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
      CODEX_THREAD_ID: 'parent',
      ELECTRON_RUN_AS_NODE: '1'
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/me' })
    expect('CODEX_HOME' in env).toBe(false)
    // An inherited CODEX_HOME is what the terminal `codex` uses, so it is kept.
    expect(codexEnvironment({ CODEX_HOME: '/custom' })).toEqual({ CODEX_HOME: '/custom' })
  })
})

describe('CodexProviderService', () => {
  it('launches `app-server` with the stripped environment and no arguments', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-live')
    vi.stubEnv('CODEX_API_KEY', 'ck-live')
    vi.stubEnv('CODEX_HOME', undefined)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    writeTerminalAuth(join(home, '.codex'), 'workspace-one')
    const server = scriptedServer(() => chatgpt)
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    expect(await service.status()).toMatchObject({ state: 'connected', planType: 'plus' })
    expect(server.launches).toHaveLength(1)
    const [launch] = server.launches
    expect(launch.binary).toBe(binary)
    expect(launch.args).toEqual([])
    expect(launch.env.OPENAI_API_KEY).toBeUndefined()
    expect(launch.env.CODEX_API_KEY).toBeUndefined()
    expect('CODEX_HOME' in launch.env).toBe(false)
    expect(launch.env.PATH).toBe(process.env.PATH)
    expect(server.methods()).toEqual(['initialize', 'initialized', 'config/read', 'account/read', 'getAuthStatus'])
  })

  it('caches the account check for five minutes; Recheck and expiry check again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let account: Reply = chatgpt
    const server = scriptedServer((message) => (message.method === 'account/read' ? account : { result: {} }))
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    expect(service.configured()).toBe(false)
    await service.status()
    await service.status()
    expect(service.configured()).toBe(true)
    expect(server.methods().filter((method) => method === 'account/read')).toHaveLength(1)

    account = { result: { account: null, requiresOpenaiAuth: true } }
    expect(await service.status({ force: true })).toMatchObject({ state: 'signed_out', message: expect.stringContaining('codex login') })
    expect(service.configured()).toBe(false)
    expect(server.methods().filter((method) => method === 'account/read')).toHaveLength(2)

    account = chatgpt
    await service.status()
    expect(server.methods().filter((method) => method === 'account/read')).toHaveLength(2)
    vi.setSystemTime(Date.now() + CODEX_ACCOUNT_TTL_MS)
    expect(await service.status()).toMatchObject({ state: 'connected' })
    expect(server.methods().filter((method) => method === 'account/read')).toHaveLength(3)
    expect(server.processes[0].signalCode).toBe('SIGTERM')
    expect(server.launches).toHaveLength(2)
  })

  it('keeps Codex listed while a forced check (a turn\'s account check) waits for its answer', async () => {
    let held: Message | undefined
    let hold = false
    const server = scriptedServer((message) => {
      if (message.method !== 'account/read') return { result: {} }
      if (!hold) return chatgpt
      held = message
      return undefined
    })
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    await service.status()
    hold = true
    const forced = service.status({ force: true })
    await vi.waitFor(() => expect(held).toBeDefined())
    expect(service.configured()).toBe(true)
    expect(service.llmProvider()?.id).toBe('codex')
    server.processes.at(-1)!.stdout.write(JSON.stringify({ id: held!.id, result: { account: null, requiresOpenaiAuth: true } }) + '\n')
    expect(await forced).toMatchObject({ state: 'signed_out' })
    expect(service.configured()).toBe(false)
  })

  it('re-verifies a late startup notification on the same terminal server', async () => {
    const server = scriptedServer(() => chatgpt)
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    const owner = service.account()?.subject
    server.processes[0].stdout.write(JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\n')
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(service.account()?.subject).toBe(owner)
    expect(server.launches).toHaveLength(1)
  })

  it.each(['matching', 'changed'])('waits for a %s startup account recheck before admitting the first Send', async (identity) => {
    const listing = Promise.withResolvers<Message>()
    const recheck = Promise.withResolvers<Message>()
    let checking = false
    const server = scriptedServer((message) => {
      if (message.method === 'account/read') {
        if (!checking) return chatgpt
        recheck.resolve(message)
        return undefined
      }
      if (message.method === 'thread/list') {
        listing.resolve(message)
        return undefined
      }
      if (message.method === 'thread/start') {
        return { result: { thread: { id: 'first-thread' }, model: 'gpt-x', modelProvider: 'openai', cwd: home } }
      }
      if (message.method === 'turn/start') {
        setImmediate(() => write({ method: 'turn/completed', params: { threadId: 'first-thread', turn: { id: 'first-turn', status: 'completed', error: null } } }))
        return { result: { turn: { id: 'first-turn', status: 'inProgress', error: null } } }
      }
      return { result: {} }
    })
    const write = (message: object) => server.processes[0].stdout.write(JSON.stringify(message) + '\n')
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    let settled = false
    const sending = service.chat({ threadId: 't', cwd: home, model: 'gpt-x', prompt: 'first Send', onText: () => {} }).then(
      (result) => { settled = true; return { result } },
      (error: unknown) => { settled = true; return { error } }
    )
    const list = await listing.promise
    checking = true
    write({ method: 'account/updated', params: { authMode: 'chatgpt' } })
    const check = await recheck.promise
    write({ id: list.id, error: { code: -32601, message: 'unknown method' } })
    // Let the thread preparation finish while the account response is still held.
    await new Promise((resolve) => setImmediate(resolve))
    const settledBeforeRecheck = settled
    const openedBeforeRecheck = server.methods().includes('thread/start')
    write({
      id: check.id,
      result: { ...chatgpt.result, workspaceRouting: { chatgptAccountId: identity === 'matching' ? 'workspace-one' : 'workspace-two' } }
    })

    const outcome = await sending
    expect(settledBeforeRecheck).toBe(false)
    expect(openedBeforeRecheck).toBe(false)
    expect(server.launches).toHaveLength(1)
    if (identity === 'matching') {
      expect(outcome).toMatchObject({ result: { codexThreadId: 'first-thread' } })
      expect(server.processes[0].signalCode).toBeNull()
      expect(server.methods()).toContain('turn/start')
    } else {
      expect(outcome).toMatchObject({ error: expect.any(Error) })
      expect(server.processes[0].signalCode).toBe('SIGTERM')
      expect(server.methods()).not.toContain('thread/start')
      expect(server.methods()).not.toContain('turn/start')
    }
  })

  it('refuses an API-key sign-in so turns never bill an API key', async () => {
    const server = scriptedServer(() => ({ result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } }))
    const service = create(server)
    expect(await service.status()).toMatchObject({ state: 'signed_out', message: expect.stringContaining('without a ChatGPT account') })
    expect(service.configured()).toBe(false)
    expect(service.llmProvider()).toBeUndefined()
    await expect(service.chat({ threadId: 't', cwd: home, model: 'gpt-x', prompt: 'hi', onText: () => {} })).rejects.toMatchObject({
      code: 'codex_not_connected'
    })
    expect(server.methods()).not.toContain('thread/start')
  })

  it('re-checks the sign-in when the shared process reports an account change', async () => {
    const server = scriptedServer(() => chatgpt)
    const service = create(server)
    await service.status()
    expect(service.configured()).toBe(true)
    server.processes[0].stdout.write(JSON.stringify({ method: 'account/updated', params: { authMode: 'apikey', planType: null } }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.configured()).toBe(false)
  })

  it('lists models from model/list across pages, and lists none until one has run', async () => {
    const server = scriptedServer((message) => {
      if (message.method === 'account/read') return chatgpt
      if (message.method !== 'model/list') return { result: {} }
      const cursor = (message.params as { cursor?: string }).cursor
      return {
        result: cursor
          ? { data: [{ id: 'gpt-b', model: 'gpt-b', displayName: 'GPT B', description: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false, multiAgentVersion: 'v2' }], nextCursor: null }
          : {
              data: [
                { id: 'gpt-a', model: 'gpt-a', displayName: 'GPT A', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses' }, { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' }, { reasoningEffort: 'turbo-new', description: '' }], defaultReasoningEffort: 'low', isDefault: true, multiAgentVersion: null },
                { id: 'gpt-hidden', model: 'gpt-hidden', displayName: 'Hidden', description: '', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false }
              ],
              nextCursor: 'page-2'
            }
      }
    })
    const service = create(server, { models: [{ id: 'stale', label: 'Stale' }] })
    await service.status()
    const models = await service.refreshModels()
    // Every level Codex reports, its extra `ultra` level included, with its descriptions and default. A
    // model with `v2` subagents runs no one-shot (titles).
    expect(models).toEqual([
      { id: 'gpt-a', label: 'GPT A', efforts: ['low', 'ultra'], thinkingOff: false, defaultEffort: 'low', effortDescriptions: { low: 'Fast responses', ultra: 'Maximum reasoning with automatic task delegation' } },
      { id: 'gpt-b', label: 'GPT B', oneShot: false }
    ])
    // On OpenAI's own provider a one-shot is a direct request with no tools, so the picker offers every model.
    expect(service.llmProvider()).toEqual({ id: 'codex', label: 'Codex', models: [models[0], { id: 'gpt-b', label: 'GPT B' }] })

    const fresh = scriptedServer(() => chatgpt)
    const unlisted = new CodexProviderService(mkdtempSync(join(tmpdir(), 'mousse-codex-empty-')), questions, { launch: fresh.launch, findBinary: () => binary })
    services.push(unlisted)
    await unlisted.status()
    // No invented default: an entry that has not listed shows "Refresh models" until it has.
    expect(unlisted.llmProvider()?.models).toEqual([])
  })

  it('disconnects in Mousse only: never sends account/logout and keeps reporting disconnected', async () => {
    const server = scriptedServer(() => chatgpt)
    const service = create(server, { threads: { t: { codexThreadId: 'thr', cwd: home, historyKey: 'k' } } })
    await service.status()
    // The gateway sets the flag, then the service stops its work; the mirror records the flag.
    signedOut = true
    await service.logout()
    service.vendorMirror(['signedOut']).write({ signedOut: true })
    expect(server.methods()).not.toContain('account/logout')
    expect(server.processes[0].signalCode).toBe('SIGTERM')
    expect(service.configured()).toBe(false)
    expect(await service.status()).toMatchObject({ state: 'disconnected' })
    const saved = JSON.parse(readFileSync(join(home, 'providers', 'codex', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ disconnected: true, threads: {} })
    // No new process was started to log out.
    expect(server.launches).toHaveLength(1)
  })

  it('connects through the terminal sign-in: Recheck until signed in, without running a login', async () => {
    let signedIn = false
    const server = scriptedServer((message) => {
      if (message.method === 'account/read') return signedIn ? chatgpt : { result: { account: null, requiresOpenaiAuth: true } }
      if (message.method === 'model/list') return { error: { code: -32600, message: 'unavailable' } }
      return { result: {} }
    })
    const service = create(server)
    const session = new LoginSession('login-1')
    const prompts: string[] = []
    session.on('event', (event: { type: string; message?: string }) => {
      if (event.type !== 'select') return
      prompts.push(event.message ?? '')
      signedIn = true
      session.respond({ sessionId: session.sessionId, kind: 'select', value: 'check' })
    })
    expect(await service.login(session, home)).toEqual({ success: true, sessionId: 'login-1' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('codex login')
    expect(service.configured()).toBe(true)
    expect(server.methods()).not.toContain('account/logout')
    expect(server.methods().filter((method) => method?.startsWith('account/login'))).toEqual([])
  })

  it('closes the idle process, keeps Codex listed, and starts a new one on the next use', async () => {
    const server = scriptedServer((message) => (message.method === 'account/read' ? chatgpt : { result: { data: [], nextCursor: null } }))
    mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
    writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'gpt-x', label: 'GPT X' }] }))
    const service = new CodexProviderService(home, questions, { launch: server.launch, idleCloseMs: 20 }, { launch: () => ({ binaryPath: binary }) })
    services.push(service)
    await service.status()
    expect(server.processes[0].signalCode).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(server.processes[0].signalCode).toBe('SIGTERM')
    expect(service.configured()).toBe(true)
    expect(service.llmProvider()?.models).toEqual([{ id: 'gpt-x', label: 'GPT X' }])

    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(server.launches).toHaveLength(2)
    expect(server.processes[1].signalCode).toBeNull()
  })

  it('reports a missing binary without starting anything', async () => {
    const server = scriptedServer(() => chatgpt)
    const service = new CodexProviderService(home, questions, { launch: server.launch, findBinary: () => undefined })
    services.push(service)
    expect(await service.status()).toMatchObject({ state: 'missing_binary' })
    expect(service.configured()).toBe(false)
    expect(server.launches).toEqual([])
  })
})

describe('CodexProviderService options (managed Codex)', () => {
  const MANAGED = 'openai_chatgpt_plan'
  type Turn = { status: 'completed' | 'failed'; error?: unknown }

  /** A server that runs turns: threads answer with `provider`, every turn ends as `turn` says. */
  function turnServer(options: { provider?: (method: string) => string; turn?: () => Turn | null; compact?: () => Turn | 'unknown'; resume?: 'missing' | 'another'; beforeOpen?: (message: Message) => boolean; account?: (launchIndex: number) => Reply; authStatus?: (launchIndex: number) => Reply; authStore?: string | ((launch: number) => string) } = {}) {
    let threads = 0
    const server = scriptedServer((message, launchIndex) => {
      const method = message.method!
      if (method === 'account/read') return options.account?.(launchIndex) ?? chatgpt
      if (method === 'getAuthStatus' && options.authStatus) return options.authStatus(launchIndex)
      if (method === 'config/read') {
        const store = typeof options.authStore === 'function' ? options.authStore(launchIndex) : options.authStore
        return { result: { config: { cli_auth_credentials_store: store } } }
      }
      if (method === 'thread/resume' && options.resume === 'missing') return { error: { code: -32600, message: 'no rollout found for thread id' } }
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
        if (options.beforeOpen?.(message) === false) return undefined
        // A resume opens the thread it names, unless the test makes it open another one.
        const resumed = options.resume === 'another' ? 'thr-other' : (message.params as { threadId: string }).threadId
        return { result: { thread: { id: method === 'thread/resume' ? resumed : `thr-${++threads}` }, model: 'gpt-x', modelProvider: options.provider?.(method) ?? 'openai', cwd: home } }
      }
      if (method === 'turn/start') {
        const turn = options.turn ? options.turn() : { status: 'completed' }
        const threadId = (message.params as { threadId: string }).threadId
        if (turn) setImmediate(() => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', error: null, ...turn } } }) + '\n'))
        return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
      }
      if (method === 'thread/compact/start') {
        const turn = options.compact ? options.compact() : { status: 'completed' as const }
        if (turn === 'unknown') return { error: { code: -32601, message: 'unknown method' } }
        const threadId = (message.params as { threadId: string }).threadId
        const write = (name: string, params: unknown) => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: name, params }) + '\n')
        setImmediate(() => {
          write('turn/started', { threadId, turn: { id: 'turn-c', status: 'inProgress', error: null } })
          write('turn/completed', { threadId, turn: { id: 'turn-c', error: null, ...turn } })
        })
        return { result: {} }
      }
      if (method === 'thread/list') return { error: { code: -32601, message: 'unknown method' } }
      return { result: {} }
    })
    return { ...server, requests: (method: string) => server.messages.filter((message) => message.method === method) }
  }

  function managed(server: ReturnType<typeof turnServer>, options: CodexServiceOptions = {}, deps: CodexServiceDependencies = {}): CodexProviderService {
    const dir = join(home, 'harness', 'codex-2')
    mkdirSync(dir, { recursive: true })
    const service = new CodexProviderService(home, questions, { launch: server.launch, findBinary: () => binary, ...deps }, {
      dir,
      modelProvider: MANAGED,
      clientInfo: { name: 'Mousse', title: 'Mousse' },
      account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, label: 'ChatGPT Plus', subject: 'chatgpt:client:sub' }) },
      ...options
    })
    services.push(service)
    return service
  }

  const chat = (service: CodexProviderService, patch: Record<string, unknown> = {}) =>
    service.chat({ threadId: 't', cwd: home, model: 'gpt-x', prompt: 'hi', onText: () => {}, ...patch })

  /** Start, then fork (another MCP token on the loaded thread), then resume (a new process). */
  async function allRoutes(service: CodexProviderService, server: ReturnType<typeof turnServer>): Promise<void> {
    await chat(service, { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok-a' } })
    service.commitConversation('t', 'h')
    await chat(service, { history: 'h', mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok-b' } })
    service.commitConversation('t', 'h2')
    await service.stopAll('test')
    await chat(service, { history: 'h2', mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok-b' } })
    expect(server.requests('thread/start')).toHaveLength(1)
    expect(server.requests('thread/fork')).toHaveLength(1)
    expect(server.requests('thread/resume')).toHaveLength(1)
  }

  const pinned = (server: ReturnType<typeof turnServer>) =>
    ['thread/start', 'thread/fork', 'thread/resume'].map((method) => {
      const params = server.requests(method)[0].params as { modelProvider: string; config: { model_provider: string } }
      return [params.modelProvider, params.config.model_provider]
    })

  it('rejects a terminal logout even when the open server still reports the old sign-in', async () => {
    const server = turnServer({ account: (launch) => launch === 0 ? chatgpt : { result: { account: null, requiresOpenaiAuth: true } } })
    const service = create(server)
    await chat(service)
    rmSync(join(process.env.CODEX_HOME!, 'auth.json'))

    await expect(chat(service, { threadId: 'after-logout' })).rejects.toMatchObject({ code: 'codex_not_connected' })
    expect(server.launches).toHaveLength(2)
    expect(server.processes[0]!.signalCode).toBe('SIGTERM')
    expect(server.requests('turn/start')).toHaveLength(1)
  })

  it('hands over the transcript when the terminal switches workspaces with the same email', async () => {
    const server = turnServer()
    const service = create(server)
    await chat(service)
    service.commitConversation('t', 'first workspace transcript')
    writeTerminalAuth(process.env.CODEX_HOME!, 'workspace-two', 'replacement-token')

    await chat(service, { history: 'first workspace transcript' })
    expect(server.launches).toHaveLength(2)
    expect(server.requests('thread/resume')).toHaveLength(0)
    expect(server.requests('thread/start')).toHaveLength(2)
    expect(JSON.stringify(server.requests('turn/start').at(-1))).toContain('first workspace transcript')
  })

  it('hands over history when the selected workspace differs despite a matching file bearer', async () => {
    const server = turnServer({
      account: (launch) => ({
        result: { ...chatgpt.result, workspaceRouting: { chatgptAccountId: launch === 0 ? 'workspace-one' : 'workspace-two' } }
      })
    })
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    const first = await chat(service)
    const history = 'workspace one transcript'
    service.commitConversation('t', history)
    await service.stopAll('switch selected workspace')

    const second = await chat(service, { history })
    expect(second.codexThreadId).not.toBe(first.codexThreadId)
    expect(server.requests('thread/resume')).toHaveLength(0)
    expect(JSON.stringify(server.requests('turn/start').at(-1))).toContain(history)
    expect(await service.status({ force: true })).toMatchObject({ state: 'connected' })
    expect(service.account()?.subject).toBe('chatgpt:me@example.com')
  })

  it('rebuilds history when Codex only identifies the account by its email', async () => {
    writeTerminalAuth(process.env.CODEX_HOME!, undefined)
    const server = turnServer()
    const service = create(server)
    await chat(service)
    service.commitConversation('t', 'previous conversation')
    await service.stopAll('restart')

    await chat(service, { history: 'previous conversation' })
    expect(server.requests('thread/resume')).toHaveLength(0)
    expect(JSON.stringify(server.requests('turn/start').at(-1))).toContain('previous conversation')
  })

  it('uses a fresh server for each terminal turn when the configured auth store is opaque', async () => {
    writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'cli_auth_credentials_store = "keyring"')
    const server = turnServer({ authStore: 'keyring' })
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    const first = await chat(service)
    service.commitConversation('t', 'previous conversation')
    const second = await chat(service, { history: 'previous conversation' })

    expect(second.codexThreadId).not.toBe(first.codexThreadId)
    expect(server.requests('thread/resume')).toHaveLength(0)
    expect(server.requests('turn/start')).toHaveLength(2)
    expect(server.processes.every((process) => process.signalCode === 'SIGTERM')).toBe(true)
  })

  it('reads the store selected by system config before trusting a leftover terminal auth file', async () => {
    const server = turnServer({ authStore: (launch) => launch === 0 ? 'file' : 'keyring' })
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })
    const first = await chat(service)
    service.commitConversation('t', 'file-backed conversation')
    await service.stopAll('switch to system keyring')

    // The user home has no config.toml, and auth.json still names the original workspace.
    const second = await chat(service, { history: 'file-backed conversation' })
    service.commitConversation('t', 'keyring-backed conversation')
    const third = await chat(service, { history: 'keyring-backed conversation' })

    expect(new Set([first.codexThreadId, second.codexThreadId, third.codexThreadId]).size).toBe(3)
    expect(server.requests('thread/resume')).toHaveLength(0)
    expect(server.requests('config/read')).toHaveLength(server.launches.length)
    expect(JSON.stringify(server.requests('turn/start')[1])).toContain('file-backed conversation')
    expect(JSON.stringify(server.requests('turn/start')[2])).toContain('keyring-backed conversation')
    expect(server.processes.every((process) => process.signalCode === 'SIGTERM')).toBe(true)
  })

  it('rebuilds the transcript when config/read switches to file after Codex opened the keyring', async () => {
    let systemStore = 'file'
    const startedWith: string[] = []
    let startFromKeyring = false
    const server = turnServer({
      authStore: (launch) => {
        if (startedWith[launch] === 'keyring') systemStore = 'file'
        return systemStore
      },
      authStatus: (launch) => ({
        result: { authMethod: 'chatgpt', authToken: codexFixtureAccessToken(startedWith[launch] === 'keyring' ? 'workspace-two' : 'workspace-one') }
      })
    })
    const service = create({ launch: (spec) => {
      if (startFromKeyring) systemStore = 'keyring'
      startedWith.push(systemStore)
      return server.launch(spec)
    } }, { models: [{ id: 'gpt-x', label: 'GPT X' }] })

    const first = await chat(service)
    service.commitConversation('t', 'file workspace transcript')
    await service.stopAll('restart for the new system policy')
    startFromKeyring = true
    // The file stayed on disk, and account/read reports the same email in both workspaces.
    const second = await chat(service, { history: 'file workspace transcript' })

    expect(startedWith).toContain('keyring')
    expect(systemStore).toBe('file')
    expect(second.codexThreadId).not.toBe(first.codexThreadId)
    expect(server.requests('thread/resume')).toHaveLength(0)
    expect(JSON.stringify(server.requests('turn/start').at(-1))).toContain('file workspace transcript')
  })

  it('the existing CLI pins openai on start, fork and resume', async () => {
    const server = turnServer()
    const service = create(server)
    await allRoutes(service, server)
    expect(pinned(server)).toEqual([['openai', 'openai'], ['openai', 'openai'], ['openai', 'openai']])
  })

  it.each([
    ['opens the saved thread', undefined, undefined],
    ['answers that the thread is gone', 'missing', true],
    ['opens another thread', 'another', true]
  ] as const)('a resume that %s: the turn reports the resume as lost only when it was', async (_name, resume, lost) => {
    const server = turnServer({ resume })
    const service = create(server)
    await chat(service)
    service.commitConversation('t', 'h')
    await service.stopAll('test')
    const result = await chat(service, { history: 'h' })
    expect(server.requests('thread/resume')).toHaveLength(1)
    expect(result.resumeLost).toBe(lost)
  })

  it('opens the thread with the compaction threshold, and reopens it when the threshold changes', async () => {
    const server = turnServer()
    const service = create(server)
    await chat(service, { autoCompactTokens: 256000 })
    service.commitConversation('t', 'h')
    await chat(service, { history: 'h', autoCompactTokens: 256000 })
    service.commitConversation('t', 'h2')
    await chat(service, { history: 'h2', autoCompactTokens: 128000 })
    service.commitConversation('t', 'h3')
    await chat(service, { history: 'h3' })
    const limit = (message: { params?: unknown }) => (message.params as { config: Record<string, unknown> }).config.model_auto_compact_token_limit
    expect(server.requests('thread/start').map(limit)).toEqual([256000])
    // The same threshold continues the loaded thread; a changed one, or none, forks it with the new config.
    expect(server.requests('thread/fork').map(limit)).toEqual([128000, undefined])
  })

  it('sends the level Codex lists for the model, and none for a level the model does not list', async () => {
    const server = turnServer()
    const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X', efforts: ['low', 'high', 'ultra'], defaultEffort: 'low' }] })
    await chat(service, { model: 'gpt-x:ultra' })
    service.commitConversation('t', 'h')
    // A level saved for another model runs at this model's default: no effort is sent.
    await chat(service, { model: 'gpt-x:max', history: 'h' })
    expect(server.requests('turn/start').map((message) => (message.params as { effort?: string }).effort)).toEqual(['ultra', undefined])
  })

  describe('/compact', () => {
    const compact = (service: CodexProviderService, history: string) =>
      service.compactConversation('t', history, undefined, new AbortController().signal)

    it('compacts the saved Codex thread, which the next turn resumes', async () => {
      const server = turnServer()
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      expect(await compact(service, 'h')).toBe(true)
      expect(server.requests('thread/compact/start').map((message) => message.params)).toEqual([{ threadId: 'thr-1' }])
      await chat(service, { history: 'h' })
      expect(server.requests('thread/start')).toHaveLength(1)
    })

    it('resumes a thread that is not loaded, compacts it and lets it go', async () => {
      const server = turnServer()
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      await service.stopAll('test')
      expect(await compact(service, 'h')).toBe(true)
      const threadCalls = ['thread/start', 'thread/resume', 'thread/compact/start', 'thread/unsubscribe']
      expect(server.methods().filter((method) => threadCalls.includes(method ?? ''))).toEqual(threadCalls)
    })

    it('leaves it to Mousse when no saved thread holds the history or Codex has no compaction', async () => {
      const server = turnServer({ compact: () => 'unknown' })
      const service = create(server)
      expect(await compact(service, 'h')).toBe(false)
      await chat(service)
      service.commitConversation('t', 'h')
      expect(await compact(service, 'other')).toBe(false)
      expect(server.requests('thread/compact/start')).toHaveLength(0)
      expect(await compact(service, 'h')).toBe(false)
      expect(server.requests('thread/compact/start')).toHaveLength(1)
    })

    it('releases the server when a cold compaction fails and unload is unconfirmed', async () => {
      const server = turnServer({ compact: () => ({ status: 'failed', error: { message: 'context too small' } }) })
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      await service.stopAll('cold compaction')
      await expect(compact(service, 'h')).rejects.toThrow('context too small')
      expect(server.requests('thread/unsubscribe').map((request) => request.params)).toContainEqual({ threadId: 'thr-1' })
      expect(server.processes[1]!.signalCode).toBe('SIGTERM')
      await chat(service, { history: 'h' })
      expect(server.launches).toHaveLength(3)
    })

    it('fails when Codex reports the compaction failed', async () => {
      const server = turnServer({ compact: () => ({ status: 'failed', error: { message: 'context too small' } }) })
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      await expect(compact(service, 'h')).rejects.toThrow('context too small')
    })

    /**
     * A Codex whose compaction runs until the test or a `turn/interrupt` ends it. `onInterrupt` says how the
     * interrupt goes: the turn ends `interrupted`, the compaction completes anyway, or the interrupt fails and no end comes.
     */
    function stoppableServer(onInterrupt: 'interrupted' | 'completed' | 'fails') {
      const write = (method: string, params: unknown) => server.processes.at(-1)!.stdout.write(JSON.stringify({ method, params }) + '\n')
      const server = scriptedServer((message) => {
        const method = message.method!
        const threadId = (message.params as { threadId?: string } | undefined)?.threadId
        if (method === 'account/read') return chatgpt
        if (method === 'thread/start') return { result: { thread: { id: `thr-${server.messages.filter((entry) => entry.method === 'thread/start').length}` }, model: 'gpt-x', modelProvider: 'openai', cwd: home } }
        if (method === 'turn/start') {
          setImmediate(() => write('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed', error: null } }))
          return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
        }
        if (method === 'thread/compact/start') {
          setImmediate(() => write('turn/started', { threadId, turn: { id: 'turn-c', status: 'inProgress', error: null } }))
          return { result: {} }
        }
        if (method === 'turn/interrupt') {
          if (onInterrupt === 'fails') return { error: { code: -32600, message: 'no active turn' } }
          setImmediate(() => write('turn/completed', { threadId, turn: { id: 'turn-c', status: onInterrupt, error: null } }))
          return { result: {} }
        }
        if (method === 'thread/list') return { error: { code: -32601, message: 'unknown method' } }
        return { result: {} }
      })
      return { ...server, requests: (method: string) => server.messages.filter((message) => message.method === method) }
    }

    /** Starts a `/compact`, stops it once Codex runs the compaction turn, and returns how it ended. */
    async function stopWhileCompacting(server: ReturnType<typeof stoppableServer>, service: CodexProviderService) {
      const stop = new AbortController()
      const running = service.compactConversation('t', 'h', undefined, stop.signal)
      const outcome = running.then(() => 'resolved', (error: unknown) => error)
      const startedAt = Date.now()
      while (!server.requests('thread/compact/start').length) {
        if (Date.now() - startedAt > 5_000) throw new Error('the compaction never started')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      // The server answers with `turn/started`; give the service a moment to read it.
      await new Promise((resolve) => setTimeout(resolve, 30))
      stop.abort(new Error('Compaction stopped'))
      return outcome
    }

    it('a Stop interrupts the compaction turn and waits for it to end; the thread keeps the full history', async () => {
      const server = stoppableServer('interrupted')
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      const outcome = await stopWhileCompacting(server, service)
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toBe('Compaction stopped')
      expect(server.requests('turn/interrupt').map((message) => message.params)).toEqual([{ threadId: 'thr-1', turnId: 'turn-c' }])
      // Codex stopped short: the next turn resumes the same thread.
      await chat(service, { history: 'h' })
      expect(server.requests('thread/start')).toHaveLength(1)
    })

    it('drops the saved thread when the compaction completed anyway', async () => {
      const server = stoppableServer('completed')
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      expect(await stopWhileCompacting(server, service)).toBeInstanceOf(Error)
      // The Codex thread was compacted after all: the next turn starts a new one with the full history.
      await chat(service, { history: 'h' })
      expect(server.requests('thread/start')).toHaveLength(2)
    })

    it('holds the thread from the start: a turn sent during a slow sign-in check is refused, not run beside it', async () => {
      const server = turnServer()
      let gate: Promise<void> = Promise.resolve()
      mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
      writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary }))
      const service = new CodexProviderService(home, questions, { launch: server.launch }, {
        launch: () => ({ binaryPath: binary }),
        signedOut: () => signedOut,
        account: { read: async () => { await gate; return { kind: 'signed_in', planType: 'plus', email: null, label: 'ChatGPT Plus', subject: 'chatgpt:sub' } } }
      })
      services.push(service)
      await chat(service)
      service.commitConversation('t', 'h')
      const now = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => now + CODEX_ACCOUNT_TTL_MS + 1)
      let release!: () => void
      gate = new Promise((resolve) => { release = resolve })
      const compaction = compact(service, 'h')
      await new Promise((resolve) => setTimeout(resolve, 20))
      await expect(chat(service, { history: 'h' })).rejects.toThrow('A Codex turn is already running for this thread')
      release()
      expect(await compaction).toBe(true)
      expect(server.requests('turn/start')).toHaveLength(1)
      vi.restoreAllMocks()
    })

    it('starts after a stopped turn has settled, and takes no event of that turn for its own', async () => {
      let hang = false
      const write = (name: string, params: unknown) => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: name, params }) + '\n')
      const server = scriptedServer((message) => {
        const method = message.method!
        const threadId = (message.params as { threadId?: string } | undefined)?.threadId
        if (method === 'account/read') return chatgpt
        if (method === 'thread/start') return { result: { thread: { id: 'thr-1' }, model: 'gpt-x', modelProvider: 'openai', cwd: home } }
        if (method === 'turn/start') {
          if (!hang) setImmediate(() => write('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed', error: null } }))
          else setImmediate(() => write('turn/started', { threadId, turn: { id: 'turn-2', status: 'inProgress', error: null } }))
          return { result: { turn: { id: hang ? 'turn-2' : 'turn-1', status: 'inProgress', error: null } } }
        }
        // The stopped turn ends a moment after its interrupt.
        if (method === 'turn/interrupt') {
          setTimeout(() => write('turn/completed', { threadId, turn: { id: 'turn-2', status: 'interrupted', error: null } }), 50)
          return { result: {} }
        }
        if (method === 'thread/compact/start') {
          setImmediate(() => {
            // A late end of the stopped turn, then the compaction's own turn.
            write('turn/completed', { threadId, turn: { id: 'turn-2', status: 'interrupted', error: null } })
            write('turn/started', { threadId, turn: { id: 'turn-c', status: 'inProgress', error: null } })
            setTimeout(() => write('turn/completed', { threadId, turn: { id: 'turn-c', status: 'completed', error: null } }), 20)
          })
          return { result: {} }
        }
        if (method === 'thread/list') return { error: { code: -32601, message: 'unknown method' } }
        return { result: {} }
      })
      const requests = (method: string) => server.messages.filter((message) => message.method === method)
      const service = new CodexProviderService(home, questions, { launch: server.launch, helperSweepMs: 200 }, { launch: () => ({ binaryPath: binary }), signedOut: () => signedOut })
      services.push(service)
      await chat(service)
      service.commitConversation('t', 'h')
      hang = true
      const stop = new AbortController()
      const stopped = chat(service, { history: 'h', signal: stop.signal }).then(() => 'resolved', (error: unknown) => error)
      for (let tries = 0; requests('turn/start').length < 2 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      await new Promise((resolve) => setTimeout(resolve, 20))
      stop.abort(new Error('stopped'))
      expect(await stopped).toBeInstanceOf(Error)
      service.commitInterrupted('t', 'h2')
      // At once: the stopped turn is still being interrupted.
      expect(await compact(service, 'h2')).toBe(true)
      const order = server.messages.map((message) => message.method)
      expect(order.indexOf('thread/compact/start')).toBeGreaterThan(order.indexOf('turn/interrupt'))
    })

    it('a Stop while a thread loaded only to compact is let go is not taken, and the thread is dropped', async () => {
      let unsubscribed!: () => void
      const server = scriptedServer((message) => {
        const method = message.method!
        const threadId = (message.params as { threadId?: string } | undefined)?.threadId
        const write = (name: string, params: unknown) => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: name, params }) + '\n')
        if (method === 'account/read') return chatgpt
        if (method === 'thread/start' || method === 'thread/resume')
          return { result: { thread: { id: method === 'thread/resume' ? threadId : `thr-${server.messages.filter((entry) => entry.method === 'thread/start').length}` }, model: 'gpt-x', modelProvider: 'openai', cwd: home } }
        if (method === 'turn/start') {
          setImmediate(() => write('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed', error: null } }))
          return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
        }
        if (method === 'thread/compact/start') {
          setImmediate(() => {
            write('turn/started', { threadId, turn: { id: 'turn-c', status: 'inProgress', error: null } })
            write('turn/completed', { threadId, turn: { id: 'turn-c', status: 'completed', error: null } })
          })
          return { result: {} }
        }
        // The answer to the unsubscribe is slow.
        if (method === 'thread/unsubscribe') {
          unsubscribed = () => server.processes.at(-1)!.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n')
          return undefined
        }
        if (method === 'thread/list') return { error: { code: -32601, message: 'unknown method' } }
        return { result: {} }
      })
      const requests = (method: string) => server.messages.filter((message) => message.method === method)
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      await service.stopAll('test')
      const stop = new AbortController()
      const running = service.compactConversation('t', 'h', undefined, stop.signal).then(() => 'resolved', (error: unknown) => error)
      for (let tries = 0; !requests('thread/unsubscribe').length && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(requests('thread/unsubscribe')).toHaveLength(1)
      stop.abort(new Error('Compaction stopped'))
      unsubscribed()
      expect(await running).toMatchObject({ message: 'Compaction stopped' })
      // The compaction completed, but it was not taken: the next turn starts a new thread with the full history.
      await chat(service, { history: 'h' })
      expect(requests('thread/start')).toHaveLength(2)
    })

    it('fails at once when Codex exits during the compaction, and drops the thread it may have compacted', async () => {
      let exitOnCompact = true
      const server = scriptedServer((message) => {
        const method = message.method!
        const threadId = (message.params as { threadId?: string } | undefined)?.threadId
        const process = server.processes.at(-1)!
        const write = (name: string, params: unknown) => process.stdout.write(JSON.stringify({ method: name, params }) + '\n')
        if (method === 'account/read') return chatgpt
        if (method === 'thread/start') return { result: { thread: { id: `thr-${server.messages.filter((entry) => entry.method === 'thread/start').length}` }, model: 'gpt-x', modelProvider: 'openai', cwd: home } }
        if (method === 'turn/start') {
          setImmediate(() => write('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed', error: null } }))
          return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
        }
        // Codex takes the compaction in, starts it, and its process ends.
        if (method === 'thread/compact/start' && exitOnCompact) {
          setImmediate(() => {
            write('turn/started', { threadId, turn: { id: 'turn-c', status: 'inProgress', error: null } })
            setTimeout(() => process.emit('exit', 1, null), 10)
          })
          return { result: {} }
        }
        if (method === 'thread/list') return { error: { code: -32601, message: 'unknown method' } }
        return { result: {} }
      })
      const service = create(server)
      await chat(service)
      service.commitConversation('t', 'h')
      const startedAt = Date.now()
      await expect(compact(service, 'h')).rejects.toThrow('Codex stopped while compacting this thread')
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      exitOnCompact = false
      // The next turn starts a new Codex thread (on a new process) with the full history.
      await chat(service, { history: 'h' })
      expect(server.messages.filter((message) => message.method === 'thread/start')).toHaveLength(2)
    })

    it('drops the saved thread when the interrupt fails and no end comes in time', async () => {
      const server = stoppableServer('fails')
      const service = new CodexProviderService(home, questions, { launch: server.launch, compactSettleMs: 50 }, { launch: () => ({ binaryPath: binary }), signedOut: () => signedOut })
      services.push(service)
      await chat(service)
      service.commitConversation('t', 'h')
      expect(await stopWhileCompacting(server, service)).toBeInstanceOf(Error)
      expect(server.requests('turn/interrupt')).toHaveLength(1)
      await chat(service, { history: 'h' })
      expect(server.requests('thread/start')).toHaveLength(2)
    })
  })

  describe('one-shot', () => {
    type Event = { method: string; params: Record<string, unknown> }
    /**
     * A server whose turn sends `events` of the turn's thread, then the turn's end (none when `end` is null).
     * `config/read` answers with `mcp` (an error when null). A thread runs the model it is asked for; one
     * started without a model runs the user's configured `gpt-configured` (a `v2` model), or always does
     * when `honourModel` is false.
     */
    function oneShotServer(events: Event[], end: Turn | null = { status: 'completed' }, mcp: Record<string, unknown> | null = { github: {}, mousse: {}, 'mousse-relay': {}, off: { enabled: false } }, models: Array<Record<string, unknown>> = LISTED, honourModel = true) {
      const server = scriptedServer((message) => {
        const method = message.method!
        if (method === 'account/read') return chatgpt
        if (method === 'getAuthStatus') return { result: { authMethod: 'chatgpt', authToken: null } }
        if (method === 'model/list') return { result: { data: models, nextCursor: null } }
        if (method === 'config/read') return mcp ? { result: { config: { mcp_servers: mcp }, layers: [] } } : { error: { code: -32603, message: 'config unreadable' } }
        if (method === 'thread/start') {
          const asked = (message.params as { model?: string }).model
          return { result: { thread: { id: 'thr-once' }, model: (honourModel && asked) || 'gpt-configured', modelProvider: 'openai', cwd: home } }
        }
        if (method === 'turn/start') {
          const write = (name: string, params: unknown) => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: name, params }) + '\n')
          setImmediate(() => {
            for (const event of events) write(event.method, { threadId: 'thr-once', turnId: 'turn-1', ...event.params })
            if (end) write('turn/completed', { threadId: 'thr-once', turn: { id: 'turn-1', error: null, ...end } })
          })
          return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
        }
        return { result: {} }
      })
      return { ...server, requests: (method: string) => server.messages.filter((message) => message.method === method) }
    }
    /** `model/list` entries: gpt-x, Codex's catalog default, has no subagent tools (null). */
    const listed = (id: string, multiAgentVersion?: string | null, isDefault = false) => ({
      id, model: id, displayName: id.toUpperCase(), description: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault,
      ...(multiAgentVersion === undefined ? {} : { multiAgentVersion })
    })
    const LISTED = [listed('gpt-x', null, true), listed('gpt-v1', 'v1'), listed('gpt-v2', 'v2'), listed('gpt-old'), listed('gpt-configured', 'v2')]
    const once = (service: CodexProviderService, signal = new AbortController().signal, onActivity: () => void = () => {}) =>
      service.oneShot({ model: 'gpt-x', system: 's', prompt: 'p', onActivity }, signal)
    /** The `abort` listeners on the service's app-server connection. */
    const connectionListeners = (service: CodexProviderService) =>
      getEventListeners((service as unknown as { app: { conn: { signal: AbortSignal } } }).app.conn.signal, 'abort').length

    it('runs one turn on an ephemeral read-only thread with every native tool and MCP server off', async () => {
      const server = oneShotServer([
        { method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Thinking' } },
        { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: 'Thinking about it' } } },
        { method: 'item/started', params: { item: { type: 'reasoning', id: 'r' } } },
        { method: 'item/agentMessage/delta', params: { itemId: 'b', delta: 'Login ' } },
        { method: 'item/agentMessage/delta', params: { itemId: 'b', delta: 'redirect fix' } }
      ])
      const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X', efforts: ['low', 'high'] }] })
      const onActivity = vi.fn()
      const answer = await service.oneShot({ model: 'gpt-x:low', system: 'Name the chat.', prompt: 'Request: fix the login redirect', onActivity }, new AbortController().signal)
      expect(answer).toEqual({ text: 'Login redirect fix' })
      const [start] = server.requests('thread/start').map((message) => message.params as Record<string, unknown>)
      expect(start).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-x', baseInstructions: 'Name the chat.', ephemeral: true })
      // Every feature that adds a native tool is off, web search is off, and every MCP server the user
      // has on is off, Mousse's own server names included.
      expect(start!.config).toEqual({
        ...Object.fromEntries(CODEX_ONE_SHOT_FEATURES_OFF.map((feature) => [`features.${feature}`, false])),
        web_search: 'disabled',
        'mcp_servers.github.enabled': false,
        'mcp_servers.mousse.enabled': false,
        'mcp_servers.mousse-relay.enabled': false,
        model_provider: 'openai'
      })
      expect(CODEX_ONE_SHOT_FEATURES_OFF).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks']))
      expect(server.requests('turn/start').map((message) => message.params)).toEqual([expect.objectContaining({
        threadId: 'thr-once',
        input: [{ type: 'text', text: 'Request: fix the login redirect', text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: 'low'
      })])
      expect(onActivity).toHaveBeenCalled()
      // The thread is let go once answered; nothing is kept for a later turn.
      expect(server.requests('thread/unsubscribe').map((message) => message.params)).toEqual([{ threadId: 'thr-once' }])
      expect(server.requests('turn/interrupt')).toEqual([])
    })

    /** A listed model offering `low`, `medium` and `high`, whose own default is `medium`. */
    const leveled = (id: string, multiAgentVersion?: string | null) => ({
      ...listed(id, multiAgentVersion),
      supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort, description: '' })),
      defaultReasoningEffort: 'medium'
    })

    it('names a thread or branch at low reasoning when no level is chosen; other requests and chosen levels are left alone', async () => {
      const effortOf = async (spec: Partial<OneShotSpec>, models: Array<Record<string, unknown>> = [leveled('gpt-x', null)]) => {
        const server = oneShotServer([{ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: 'Title' } } }], { status: 'completed' }, undefined, models)
        const service = create(server, { models: [{ id: 'gpt-x', label: 'GPT X', efforts: ['low', 'medium', 'high'] }] })
        await service.oneShot({ model: 'gpt-x', system: 's', prompt: 'p', onActivity: () => {}, ...spec }, new AbortController().signal)
        return (server.requests('turn/start')[0]!.params as { effort?: string }).effort
      }
      expect(await effortOf({ task: 'title' })).toBe('low')
      expect(await effortOf({ task: 'branch_name' })).toBe('low')
      expect(await effortOf({ task: 'pull_request' })).toBeUndefined()
      expect(await effortOf({})).toBeUndefined()
      // A chosen level wins, as an effort or the model id's suffix.
      expect(await effortOf({ task: 'title', effort: 'high' })).toBe('high')
      expect(await effortOf({ task: 'title', model: 'gpt-x:high' })).toBe('high')
      // A model that does not offer `low` keeps its own default.
      expect(await effortOf({ task: 'title' }, [listed('gpt-x', null)])).toBeUndefined()
    })

    it('is refused, with no thread started, when the MCP servers cannot be listed or one cannot be turned off', async () => {
      const unreadable = oneShotServer([], { status: 'completed' }, null)
      await expect(once(create(unreadable))).rejects.toMatchObject({ code: 'policy_unenforceable' })
      expect(unreadable.requests('thread/start')).toEqual([])
      const unnamed = oneShotServer([], { status: 'completed' }, { 'my.server': {} })
      await expect(once(create(unnamed))).rejects.toMatchObject({ code: 'policy_unenforceable' })
      expect(unnamed.requests('thread/start')).toEqual([])
    })

    it('runs only on a model whose subagent tools a one-shot turns off, as this Codex lists it', async () => {
      const server = oneShotServer([{ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: 'Title' } } }])
      const service = create(server)
      const run = (model: string) => service.oneShot({ model, system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal)
      // Subagents of any version start a child before Codex reports the call (`v1` through its handler even
      // with the feature off); an unlisted version is refused too.
      await expect(run('gpt-v2')).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('GPT-V2 can start subagents') })
      await expect(run('gpt-v1')).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('GPT-V1 can start subagents') })
      await expect(run('gpt-old')).rejects.toMatchObject({ code: 'unsupported' })
      await expect(run('gpt-missing')).rejects.toMatchObject({ code: 'unsupported' })
      await expect(service.oneShot({ model: 'gpt-v2', system: 's', prompt: 'p', task: 'commit_message', onActivity: () => {} }, new AbortController().signal)).rejects.toThrow('cannot write commit messages')
      expect(server.requests('thread/start')).toEqual([])
      // `model/list` is asked with hidden models included.
      expect(server.requests('model/list').at(-1)!.params).toMatchObject({ includeHidden: true })
      expect(await run('gpt-x')).toEqual({ text: 'Title' })
      expect(server.requests('thread/start')).toHaveLength(1)
    })

    it('pins the checked model, `default` included, so a configured model never runs instead', async () => {
      // The user's config names gpt-configured (`v2`); the catalog's default, gpt-x, has no subagents.
      const server = oneShotServer([{ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a', text: 'Title' } } }])
      const service = create(server)
      const run = (model: string) => service.oneShot({ model, system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal)
      expect(await run('default')).toEqual({ text: 'Title' })
      expect(await run('gpt-x')).toEqual({ text: 'Title' })
      // Both requests name the checked model: none is left to Codex's config.
      expect(server.requests('thread/start').map((message) => (message.params as { model?: string }).model)).toEqual(['gpt-x', 'gpt-x'])
      expect(server.requests('turn/start').map((message) => (message.params as { model?: string }).model)).toEqual(['gpt-x', 'gpt-x'])

      // A Codex that opens the thread on its configured model anyway: no turn runs, and the thread is let go.
      const stubborn = oneShotServer([], { status: 'completed' }, undefined, LISTED, false)
      await expect(create(stubborn).oneShot({ model: 'default', system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('gpt-configured instead of gpt-x') })
      expect(stubborn.requests('turn/start')).toEqual([])
      expect(stubborn.requests('thread/unsubscribe')).toHaveLength(1)
    })

    it('marks listed models whose subagents cannot be turned off as unable to run one-shots', () => {
      expect(codexModelOption(listed('gpt-x', null) as never).oneShot).toBeUndefined()
      expect(codexModelOption(listed('gpt-v1', 'v1') as never).oneShot).toBe(false)
      expect(codexModelOption(listed('gpt-v2', 'v2') as never).oneShot).toBe(false)
      expect(codexModelOption(listed('gpt-old') as never).oneShot).toBe(false)
      expect([null, 'v1', 'v2', 'v3', undefined].map(codexOneShotRunsOn)).toEqual([true, false, false, false, false])
    })

    describe("as a direct request on OpenAI's provider with a ChatGPT sign-in", () => {
      const TOKEN = 'header.eyJ0b2tlbiI6dHJ1ZX0.sig'
      const reply = (text: string): AssistantMessage => ({
        role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'm', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      })
      /** A transport whose answer `script` writes; every request is recorded. */
      function directStream(script: (stream: AssistantMessageEventStream, signal: AbortSignal) => void = (stream) => {
        const message = reply('Login redirect fix')
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Login redirect fix', partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end(message)
      }) {
        const requests: Array<{ model: any; context: any; options: any }> = []
        const send = vi.fn((model: unknown, context: unknown, options: any) => {
          requests.push({ model, context, options })
          const stream = createAssistantMessageEventStream()
          queueMicrotask(() => script(stream, options.signal))
          return stream
        }) as unknown as CodexDirectStream
        return { send, requests }
      }
      /** A server that answers `getAuthStatus` as `auth` says, and lists `models`. */
      function authServer(auth: Record<string, unknown>, models: Array<Record<string, unknown>> = LISTED) {
        const server = scriptedServer((message) => {
          const method = message.method!
          if (method === 'account/read') return chatgpt
          if (method === 'getAuthStatus') return { result: { authMethod: null, ...auth } }
          if (method === 'model/list') return { result: { data: models, nextCursor: null } }
          if (method === 'config/read') return { result: { config: { mcp_servers: {} }, layers: [] } }
          return { result: {} }
        })
        return { ...server, requests: (method: string) => server.messages.filter((message) => message.method === method) }
      }
      const withStream = (server: { launch: NonNullable<CodexServiceDependencies['launch']> }, send: CodexDirectStream, settings: Record<string, unknown> = {}) => {
        mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
        writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, ...settings }))
        const service = new CodexProviderService(home, questions, { launch: server.launch, directStream: send }, { launch: () => ({ binaryPath: binary }), signedOut: () => signedOut })
        services.push(service)
        return service
      }

      it("names a chat on a model with subagents through one request with no tools and Codex's own token", async () => {
        const server = authServer({ authMethod: 'chatgpt', authToken: TOKEN })
        const direct = directStream()
        const service = withStream(server, direct.send, { models: [{ id: 'gpt-v2', label: 'GPT V2', efforts: ['low', 'high'] }] })
        const onActivity = vi.fn()
        const answer = await service.oneShot({ model: 'gpt-v2:low', system: 'Name the chat.', prompt: 'Request: fix the login redirect', onActivity }, new AbortController().signal)
        expect(answer).toEqual({ text: 'Login redirect fix' })
        // Codex's token as it holds it: Mousse never asks Codex to refresh it.
        const authChecks = server.requests('getAuthStatus')
        expect(authChecks.length).toBeGreaterThan(0)
        for (const { params } of authChecks) expect(params).toEqual({ includeToken: true, refreshToken: false })
        // No Codex thread or turn runs.
        expect(server.requests('thread/start')).toEqual([])
        expect(server.requests('turn/start')).toEqual([])
        expect(direct.requests).toHaveLength(1)
        const [request] = direct.requests
        expect(request.model).toMatchObject({ id: 'gpt-v2', api: 'openai-codex-responses', baseUrl: CHATGPT_CODEX_BASE_URL })
        // The system text and one user message, with no tools declared.
        expect(request.context.messages).toEqual([
          { role: 'system', content: 'Name the chat.', timestamp: 0 },
          expect.objectContaining({ role: 'user', content: 'Request: fix the login redirect' })
        ])
        expect(request.options).toMatchObject({ apiKey: TOKEN, transport: 'sse', maxRetries: 0, reasoningEffort: 'low' })
        expect(onActivity).toHaveBeenCalled()
      })

      it('names a thread or branch at low reasoning on this path too, unless a level is chosen', async () => {
        const effortOf = async (spec: Partial<OneShotSpec>) => {
          const direct = directStream()
          const service = withStream(authServer({ authMethod: 'chatgpt', authToken: TOKEN }, [leveled('gpt-v2', 'v2')]), direct.send, { models: [{ id: 'gpt-v2', label: 'GPT V2', efforts: ['low', 'medium', 'high'] }] })
          await service.oneShot({ model: 'gpt-v2', system: 's', prompt: 'p', onActivity: () => {}, ...spec }, new AbortController().signal)
          return direct.requests[0].options.reasoningEffort
        }
        expect(await effortOf({ task: 'title' })).toBe('low')
        expect(await effortOf({ task: 'branch_name' })).toBe('low')
        // Anything else runs at the model's own default.
        expect(await effortOf({})).toBe('medium')
        expect(await effortOf({ task: 'title', effort: 'high' })).toBe('high')
      })

      it("runs the model Codex lists for `default`, with that model's own effort, and refuses an unlisted one", async () => {
        const direct = directStream()
        const service = withStream(authServer({ authMethod: 'chatgpt', authToken: TOKEN }), direct.send)
        await service.oneShot({ model: 'default', system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal)
        expect(direct.requests[0].model.id).toBe('gpt-x')
        expect(direct.requests[0].options.reasoningEffort).toBe('low')
        await expect(service.oneShot({ model: 'gpt-missing', system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'model_unavailable' })
        expect(direct.requests).toHaveLength(1)
      })

      it('aborts the request on Stop', async () => {
        let seen: AbortSignal | undefined
        const direct = directStream((_stream, signal) => { seen = signal })
        const service = withStream(authServer({ authMethod: 'chatgpt', authToken: TOKEN }), direct.send)
        const stop = new AbortController()
        const run = service.oneShot({ model: 'gpt-v2', system: 's', prompt: 'p', onActivity: () => {} }, stop.signal)
        await vi.waitFor(() => expect(seen).toBeDefined())
        stop.abort(new Error('Stopped'))
        await expect(run).rejects.toThrow()
        expect(seen!.aborted).toBe(true)
      })

      it('reports a failed request', async () => {
        const direct = directStream((stream) => {
          const message: AssistantMessage = { ...reply(''), content: [], stopReason: 'error', errorMessage: 'You have hit your ChatGPT usage limit (plus plan).' }
          stream.push({ type: 'error', reason: 'error', error: message })
          stream.end(message)
        })
        const service = withStream(authServer({ authMethod: 'chatgpt', authToken: TOKEN }), direct.send)
        await expect(service.oneShot({ model: 'gpt-v2', system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'provider_usage_limit' })
      })

      it('is not used by a managed entry on its own provider, which keeps the app-server rule and its marks', async () => {
        const server = authServer({ authMethod: 'chatgpt', authToken: TOKEN })
        const direct = directStream()
        const service = managed(server as never, { models: { list: async () => [{ id: 'gpt-v2', label: 'GPT V2', oneShot: false }] } }, { directStream: direct.send })
        await service.refreshModels()
        expect(service.models()).toEqual([{ id: 'gpt-v2', label: 'GPT V2', oneShot: false }])
        await expect(service.oneShot({ model: 'gpt-v2', system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal)).rejects.toMatchObject({ code: 'unsupported' })
        expect(server.requests('getAuthStatus')).toEqual([])
        expect(direct.requests).toEqual([])
      })

      it.each([
        ['an API-key sign-in', { authMethod: 'apikey', authToken: 'sk-test' }],
        ['no token', { authMethod: 'chatgpt', authToken: null }],
        ['a Codex that does not report one', {}]
      ])('keeps the app-server rule with %s', async (_case, auth) => {
        const direct = directStream()
        const service = withStream(authServer(auth), direct.send)
        await expect(service.oneShot({ model: 'gpt-v2', system: 's', prompt: 'p', onActivity: () => {} }, new AbortController().signal))
          .rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('GPT-V2 can start subagents') })
        expect(direct.requests).toEqual([])
      })
    })

    it('ends as refused and interrupts the turn when Codex starts any tool', async () => {
      for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabAgentToolCall', 'dynamicToolCall']) {
        const server = oneShotServer([{ method: 'item/started', params: { item: { type, id: 'tool-1' } } }], null)
        await expect(once(create(server))).rejects.toMatchObject({ code: 'policy_unenforceable', message: expect.stringContaining(type) })
        expect(server.requests('turn/interrupt').map((message) => message.params)).toEqual([{ threadId: 'thr-once', turnId: 'turn-1' }])
        expect(server.requests('thread/unsubscribe')).toHaveLength(1)
      }
    })

    it('reports a failed turn, and a stop interrupts the turn and lets the thread go', async () => {
      const failed = create(oneShotServer([], { status: 'failed', error: { message: 'model not available' } }))
      await expect(once(failed)).rejects.toThrow('model not available')

      const server = oneShotServer([{ method: 'turn/started', params: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }], null)
      const service = create(server)
      const stop = new AbortController()
      // Stopped once the turn runs (its first event), with no end coming.
      let events = 0
      await expect(once(service, stop.signal, () => { if (++events === 2) stop.abort(new Error('Stopped')) })).rejects.toThrow('Stopped')
      expect(server.requests('turn/interrupt').map((message) => message.params)).toEqual([{ threadId: 'thr-once', turnId: 'turn-1' }])
      expect(server.requests('thread/unsubscribe')).toHaveLength(1)
    })

    it('leaves no listener on the connection after an answer, a failure or a stop', async () => {
      let mode: 'answer' | 'fail' | 'hold' = 'answer'
      const server = scriptedServer((message) => {
        const method = message.method!
        if (method === 'getAuthStatus') return { result: { authMethod: 'chatgpt', authToken: null } }
        if (method === 'model/list') return { result: { data: LISTED, nextCursor: null } }
        if (method === 'config/read') return { result: { config: { mcp_servers: {} }, layers: [] } }
        if (method === 'thread/start') return { result: { thread: { id: 'thr-once' }, model: 'gpt-x', modelProvider: 'openai', cwd: home } }
        if (method === 'turn/start') {
          const write = (name: string, params: unknown) => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: name, params }) + '\n')
          setImmediate(() => {
            write('turn/started', { threadId: 'thr-once', turn: { id: 'turn-1', status: 'inProgress', error: null } })
            if (mode === 'answer') write('turn/completed', { threadId: 'thr-once', turn: { id: 'turn-1', status: 'completed', error: null } })
            if (mode === 'fail') write('turn/completed', { threadId: 'thr-once', turn: { id: 'turn-1', status: 'failed', error: { message: 'no' } } })
          })
          return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
        }
        return { result: {} }
      })
      const service = create(server, {}, {
        account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, subject: 'chatgpt:account' }) }
      })
      await service.status()
      const baseline = connectionListeners(service)
      for (let run = 0; run < 3; run += 1) {
        mode = 'answer'
        await once(service)
        expect(connectionListeners(service)).toBe(baseline)
        mode = 'fail'
        await expect(once(service)).rejects.toThrow('no')
        expect(connectionListeners(service)).toBe(baseline)
        mode = 'hold'
        const stop = new AbortController()
        let events = 0
        await expect(once(service, stop.signal, () => { if (++events === 2) stop.abort(new Error('Stopped')) })).rejects.toThrow('Stopped')
        expect(connectionListeners(service)).toBe(baseline)
      }
    })
  })

  it('managed pins its own provider on start, fork and resume, and never reads the account from Codex', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const service = managed(server)
    await allRoutes(service, server)
    expect(pinned(server)).toEqual([[MANAGED, MANAGED], [MANAGED, MANAGED], [MANAGED, MANAGED]])
    expect(server.methods()).not.toContain('account/read')
    expect((server.requests('initialize')[0].params as { clientInfo: { name: string } }).clientInfo.name).toBe('Mousse')
    expect(server.launches[0].cwd).toBe(join(home, 'harness', 'codex-2'))
    await service.status({ force: true })
    expect(service.account()).toEqual({ label: 'ChatGPT Plus', subject: 'chatgpt:client:sub' })
  })

  it.each(['thread/start', 'thread/fork', 'thread/resume'])('refuses a thread whose response names another provider (%s)', async (route) => {
    for (const setup of ['existing', 'managed'] as const) {
      const server = turnServer({ provider: (method) => (method === route) === (setup === 'managed') ? 'openai' : MANAGED })
      const service = setup === 'managed' ? managed(server) : create(server)
      const failure = await allRoutes(service, server).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'codex_provider_not_chatgpt' })
      expect((failure as Error).message).not.toMatch(/openai/)
      void service.stop().catch(() => undefined)
    }
  })

  it('a managed instance does not run a turn while its account source reads signed out', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const service = managed(server, { account: { read: async () => ({ kind: 'signed_out', message: 'Sign in with ChatGPT.' }) } })
    await expect(chat(service)).rejects.toMatchObject({ code: 'codex_not_connected' })
    expect(server.requests('thread/start')).toHaveLength(0)
    expect(server.methods()).not.toContain('account/read')
  })

  it('adds prepared launch args and env to the spawn, and releases them once when the process ends', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const onExit = vi.fn()
    const prepareLaunch = vi.fn(async () => ({ args: ['-c', 'model_provider="openai_chatgpt_plan"'], env: { CODEX_HOME: '/private/home' }, onExit }))
    const service = managed(server, { prepareLaunch, env: () => ({ PATH: '/bin' }) })
    await Promise.all([chat(service), service.userSetup(home)])
    expect(prepareLaunch).toHaveBeenCalledTimes(1)
    expect(server.launches).toHaveLength(1)
    expect(server.launches[0].args).toEqual(['-c', 'model_provider="openai_chatgpt_plan"'])
    expect(server.launches[0].env).toEqual({ PATH: '/bin', CODEX_HOME: '/private/home' })
    expect(onExit).not.toHaveBeenCalled()
    await service.stopAll('account_changed')
    expect(onExit).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('stopAll fails the running turn and resolves only after the process exited', async () => {
    let finish: (() => void) | undefined
    // The turn never completes on its own.
    const server = turnServer({ provider: () => MANAGED, turn: () => null })
    const service = managed(server)
    const running = chat(service)
    running.catch(() => undefined)
    await vi.waitFor(() => expect(server.requests('turn/start')).toHaveLength(1))
    // The process takes its time to exit after SIGTERM.
    const process = server.processes[0]
    process.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      process.signalCode = signal
      finish = () => process.emit('exit', null, signal)
      return true
    }
    let stopped = false
    const stopping = service.stopAll('account_changed').then(() => (stopped = true))
    await expect(running).rejects.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    finish!()
    await stopping
    expect(stopped).toBe(true)
  })

  /** Makes `process` ignore close signals: it exits only through the returned `exit()`. */
  function slowToExit(process: EventEmitter & CodexProcess) {
    const signals: string[] = []
    ;(process as { kill: CodexProcess['kill'] }).kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      signals.push(signal)
      return true
    }
    return {
      signals,
      exit: () => {
        ;(process as { signalCode: NodeJS.Signals | null }).signalCode = 'SIGKILL'
        process.emit('exit', null, 'SIGKILL')
      }
    }
  }

  it('an idle close keeps the leases until the process really exits, and stopAll waits for it', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const onExit = vi.fn()
    let slow: ReturnType<typeof slowToExit> | undefined
    const killTree = vi.fn(() => slow!.exit())
    const launch = (spec: CodexLaunch): CodexProcess => {
      const process = server.launch(spec)
      slow = slowToExit(process as EventEmitter & CodexProcess)
      return process
    }
    const service = managed(server, { prepareLaunch: async () => ({ args: [], onExit }) }, { launch, idleCloseMs: 5, killTree, stopTiming: { killAfterMs: 30, exitDeadlineMs: 500 } })
    await service.userSetup(home)
    // The idle close sends its signal; the process is still running, so its leases stay.
    await vi.waitFor(() => expect(slow!.signals).toContain('SIGTERM'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onExit).not.toHaveBeenCalled()
    // stopAll still knows it: it kills the tree and resolves only after the exit.
    await service.stopAll('account_changed')
    expect(killTree).toHaveBeenCalledWith(server.processes[0])
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('a lost connection keeps the leases while the process runs; stopAll waits for its exit', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const onExit = vi.fn()
    const service = managed(server, { prepareLaunch: async () => ({ args: [], onExit }) }, { killTree: () => {}, stopTiming: { killAfterMs: 10, exitDeadlineMs: 2_000 } })
    await service.userSetup(home)
    const process = server.processes[0]!
    const slow = slowToExit(process)
    // The process closes its output but keeps running.
    process.stdout.end()
    await vi.waitFor(() => expect(slow.signals.length).toBeGreaterThan(0))
    expect(onExit).not.toHaveBeenCalled()
    let stopped = false
    const stopping = service.stopAll('account_changed').then(() => (stopped = true))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(stopped).toBe(false)
    slow.exit()
    await stopping
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('a process whose initialize stalls is closed and killed within the stop deadline', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const onExit = vi.fn()
    let slow: ReturnType<typeof slowToExit> | undefined
    const launch = (spec: CodexLaunch): CodexProcess => {
      const process = server.launch(spec)
      // It never answers anything, `initialize` included.
      ;(process as { stdout: PassThrough }).stdout = new PassThrough()
      slow = slowToExit(process as EventEmitter & CodexProcess)
      return process
    }
    const killTree = vi.fn(() => slow!.exit())
    const service = managed(server, { prepareLaunch: async () => ({ args: [], onExit }) }, { launch, killTree, stopTiming: { killAfterMs: 10, exitDeadlineMs: 200 } })
    void service.userSetup(home).catch(() => undefined)
    await vi.waitFor(() => expect(server.processes).toHaveLength(1))
    const started = Date.now()
    await service.stopAll('account_changed')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('stopAll rejects when the process never exits, and when the kill throws', async () => {
    for (const killTree of [() => {}, () => { throw new Error('access denied') }]) {
      const server = turnServer({ provider: () => MANAGED })
      const onExit = vi.fn()
      const service = managed(server, { prepareLaunch: async () => ({ args: [], onExit }) }, { killTree, stopTiming: { killAfterMs: 10, exitDeadlineMs: 30 } })
      await service.userSetup(home)
      slowToExit(server.processes[0]!)
      const started = Date.now()
      await expect(service.stopAll('account_changed')).rejects.toThrow(/could not be stopped/)
      expect(Date.now() - started).toBeLessThan(1_000)
      // Nothing it holds is released while it may still run.
      expect(onExit).not.toHaveBeenCalled()
      void service.stop().catch(() => undefined)
    }
  })

  it('a launch prepared while stopAll runs never starts and is released', async () => {
    const server = turnServer({ provider: () => MANAGED })
    let release: (() => void) | undefined
    const onExit = vi.fn()
    const service = managed(server, { prepareLaunch: () => new Promise((resolve) => (release = () => resolve({ args: [], onExit }))) })
    const attempt = chat(service)
    attempt.catch(() => undefined)
    await vi.waitFor(() => expect(release).toBeDefined())
    const stopping = service.stopAll('account_changed')
    release!()
    await stopping
    await expect(attempt).rejects.toThrow()
    expect(server.launches).toHaveLength(0)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('a failed turn throws CodexTurnFailure with the error kind and HTTP status', async () => {
    const server = turnServer({
      provider: () => MANAGED,
      turn: () => ({ status: 'failed', error: { message: 'too many requests', additionalDetails: null, codexErrorInfo: { responseStreamFailed: { httpStatusCode: 429 } } } })
    })
    const service = managed(server)
    const failure = await chat(service).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CodexTurnFailure)
    expect(failure).toMatchObject({ message: 'too many requests', httpStatus: 429, codexErrorInfo: { responseStreamFailed: { httpStatusCode: 429 } } })
  })

  it('a models source replaces model/list and no fallback model is listed before it', async () => {
    const server = turnServer({ provider: () => MANAGED })
    const service = managed(server, { models: { list: async () => [{ id: 'gpt-5', label: 'GPT-5' }] } })
    expect(service.models()).toEqual([])
    expect(await service.refreshModels()).toEqual([{ id: 'gpt-5', label: 'GPT-5' }])
    expect(service.models()).toEqual([{ id: 'gpt-5', label: 'GPT-5' }])
    expect(server.methods()).not.toContain('model/list')
  })

  it("reads the user setup through the instance's own process and home", async () => {
    const server = turnServer({ provider: () => MANAGED })
    const service = managed(server, { env: () => ({ PATH: '/bin', CODEX_HOME: join(home, 'harness', 'codex-2', 'home') }) })
    await service.userSetup(home)
    expect(server.launches).toHaveLength(1)
    expect(server.launches[0].env.CODEX_HOME).toBe(join(home, 'harness', 'codex-2', 'home'))
    expect(server.methods()).toContain('config/read')
  })

  describe('the process kept between turns', () => {
    const update = (server: ReturnType<typeof turnServer>, authMode: string | null) =>
      server.processes.at(-1)!.stdout.write(JSON.stringify({ method: 'account/updated', params: { authMode, planType: 'plus' } }) + '\n')

    it('verifies a replacement and rebuilds history after a ChatGPT account switch', async () => {
      const server = turnServer({ provider: () => MANAGED })
      let subject = 'chatgpt:client:first'
      const service = managed(server, { account: { read: async () => ({ kind: 'signed_in', planType: 'plus', email: null, subject }) } })
      const first = await chat(service)
      service.commitConversation('t', 'first history')
      const same = await chat(service, { history: 'first history' })
      expect(same.codexThreadId).toBe(first.codexThreadId)
      expect(server.launches).toHaveLength(1)
      service.commitConversation('t', 'latest history')

      subject = 'chatgpt:client:second'
      update(server, 'chatgpt')
      const second = await chat(service, { history: 'latest history' })
      expect(second.codexThreadId).not.toBe(first.codexThreadId)
      expect(server.requests('thread/resume')).toHaveLength(0)
      expect(JSON.stringify(server.requests('turn/start').at(-1))).toContain('latest history')
      expect(server.launches).toHaveLength(2)
      expect(server.processes[0].signalCode).toBe('SIGTERM')
    })

    it.each(['apiKey', null] as const)('discards the reply to an account check invalidated by %s', async (authMode) => {
      let delay = false
      let started!: () => void
      const began = new Promise<void>((resolve) => { started = resolve })
      const account = { kind: 'signed_in' as const, planType: 'plus', email: null, subject: 'chatgpt:first' }
      let release!: (reading: typeof account) => void
      const blocked = new Promise<typeof account>((resolve) => { release = resolve })
      const server = turnServer({ provider: () => MANAGED })
      const service = managed(server, { account: { read: async () => delay ? (started(), blocked) : account } })
      await chat(service)
      delay = true
      const rejected = chat(service)
      void rejected.catch(() => undefined)
      await began
      update(server, authMode)
      release(account)
      await expect(rejected).rejects.toThrow()
      expect(server.requests('turn/start')).toHaveLength(1)
      expect(service.account()).toBeUndefined()
      expect(server.processes[0].signalCode).toBe('SIGTERM')
      delay = false
      await chat(service)
      expect(server.launches).toHaveLength(2)
      expect(server.requests('turn/start')).toHaveLength(2)
    })

    it('accepts no steer or follow-up after an account update during a turn', async () => {
      const server = turnServer({ provider: () => MANAGED, turn: () => null })
      const service = managed(server)
      let boundary!: () => void
      const started = new Promise<void>((resolve) => { boundary = resolve })
      const running = chat(service, { onProviderTurn: boundary, drainSteer: () => 'queued text' })
      void running.catch(() => undefined)
      await started
      update(server, 'chatgpt')
      await expect(running).rejects.toThrow()
      expect(server.requests('turn/steer')).toHaveLength(0)
      expect(server.requests('turn/start')).toHaveLength(1)
    })

    it('does not send queued text as a follow-up when the account changes at the turn boundary', async () => {
      const server = turnServer({ provider: () => MANAGED })
      const service = managed(server)
      let queued: string | undefined
      const run = chat(service, {
        onBoundary: () => {
          queued = 'held follow-up'
          update(server, 'chatgpt')
        },
        drainSteer: () => {
          const text = queued
          queued = undefined
          return text
        }
      })
      await expect(run).rejects.toThrow()
      expect(server.requests('turn/start')).toHaveLength(1)
      expect(JSON.stringify(server.requests('turn/start'))).not.toContain('held follow-up')
    })

    it('reaps an app-server that may have loaded a cancelled open before admitting another turn', async () => {
      let hold = true
      let opening!: () => void
      const waitingForOpen = new Promise<void>((resolve) => { opening = resolve })
      const server = turnServer({ provider: () => MANAGED, beforeOpen: () => {
        if (!hold) return true
        opening()
        return false
      } })
      const service = managed(server)
      const stop = new AbortController()
      const interrupted = chat(service, { signal: stop.signal })
      void interrupted.catch(() => undefined)
      await waitingForOpen
      stop.abort(new Error('Stopped while opening'))
      await expect(interrupted).rejects.toThrow('Stopped while opening')
      expect(server.processes[0].signalCode).toBe('SIGTERM')
      expect(server.requests('turn/start')).toHaveLength(0)
      hold = false
      await chat(service, { threadId: 'next' })
      expect(server.launches).toHaveLength(2)
    })

    it('reserves the last loaded-thread slot once across parallel sign-in checks while a turn is active', async () => {
      const account = { kind: 'signed_in' as const, planType: 'plus', email: null, subject: 'chatgpt:account' }
      const reads: Array<(result: typeof account) => void> = []
      let holdReads = false
      let holdTurn = false
      const server = turnServer({ provider: () => MANAGED, turn: () => holdTurn ? null : { status: 'completed' } })
      const service = managed(server, { account: { read: async () => holdReads ? new Promise((resolve) => reads.push(resolve)) : account } })
      const lifetime = new AbortController()
      const start = (threadId: string) => chat(service, { threadId, signal: lifetime.signal })
      const pending: Array<Promise<unknown>> = []
      try {
        for (let index = 0; index < CODEX_MAX_LOADED_THREADS - 2; index++) await start('idle' + index)
        holdTurn = true
        pending.push(start('active'))
        await vi.waitFor(() => expect(server.requests('turn/start')).toHaveLength(CODEX_MAX_LOADED_THREADS - 1))

        holdTurn = false
        holdReads = true
        pending.push(start('parallel-a'), start('parallel-b'))
        await vi.waitFor(() => expect(reads).toHaveLength(2))
        holdReads = false
        for (const reply of reads) reply(account)
        await vi.waitFor(() => expect(server.requests('thread/unsubscribe')).toHaveLength(1))
        expect(server.requests('thread/start')).toHaveLength(CODEX_MAX_LOADED_THREADS)
        expect(server.launches).toHaveLength(1)

        const victim = (server.requests('thread/unsubscribe')[0]!.params as { threadId: string }).threadId
        server.processes[0]!.stdout.write(JSON.stringify({ method: 'thread/closed', params: { threadId: victim } }) + '\n')
        await Promise.all(pending.slice(1))
        expect(server.requests('thread/start')).toHaveLength(CODEX_MAX_LOADED_THREADS + 1)
        expect(server.launches).toHaveLength(1)
      } finally {
        lifetime.abort()
        await Promise.allSettled(pending)
        await service.stop()
      }
    })

    it.each([
      ['at capacity', CODEX_MAX_LOADED_THREADS],
      ['with one slot left', CODEX_MAX_LOADED_THREADS - 1]
    ])(
      'reuses a loaded thread %s while other turns stay active',
      async (_capacity, loadedCount) => {
        let holdTurn = false
        const server = turnServer({ provider: () => MANAGED, turn: () => holdTurn ? null : { status: 'completed' } })
        const service = managed(server)
        const lifetime = new AbortController()
        const pending: Array<Promise<unknown>> = []
        const start = (threadId: string, history?: string) => {
          const turn = chat(service, { threadId, history, signal: lifetime.signal })
          void turn.catch(() => undefined)
          pending.push(turn)
        }
        try {
          const warm = await chat(service)
          service.commitConversation('t', 'warm history')
          holdTurn = true
          for (let index = 1; index < loadedCount; index++) start('active-' + index)
          await vi.waitFor(() => expect(server.requests('turn/start')).toHaveLength(loadedCount))

          start('t', 'warm history')
          await vi.waitFor(() => expect(server.requests('turn/start').at(-1)?.params).toMatchObject({ threadId: warm.codexThreadId }))
          expect(server.requests('thread/start')).toHaveLength(loadedCount)
          expect(server.requests('thread/resume')).toHaveLength(0)

          if (loadedCount < CODEX_MAX_LOADED_THREADS) {
            holdTurn = false
            await chat(service, { threadId: 'last-slot', signal: AbortSignal.timeout(2_000) })
            expect(server.requests('thread/start')).toHaveLength(CODEX_MAX_LOADED_THREADS)
          }
          expect(server.requests('thread/unsubscribe')).toHaveLength(0)
          expect(server.launches).toHaveLength(1)
        } finally {
          lifetime.abort()
          await service.stop()
          await Promise.allSettled(pending)
        }
      }
    )

    it('admits a queued ninth Send after a stopped turn finishes settling', async () => {
      let holdTurn = true
      const server = turnServer({ provider: () => MANAGED, turn: () => holdTurn ? null : { status: 'completed' } })
      let reads = 0
      const service = managed(server, { account: { read: async () => {
        reads += 1
        return { kind: 'signed_in', planType: 'plus', email: null, subject: 'chatgpt:account' }
      } } })
      const lifetime = new AbortController()
      const stop = new AbortController()
      const pending: Array<Promise<unknown>> = []
      const start = (threadId: string, signal = lifetime.signal) => {
        const turn = chat(service, { threadId, signal })
        void turn.catch(() => undefined)
        pending.push(turn)
        return turn
      }
      try {
        const stopped = start('stopped', stop.signal)
        await vi.waitFor(() => expect(server.requests('turn/start')).toHaveLength(1))
        const victim = (server.requests('turn/start')[0]!.params as { threadId: string }).threadId
        for (let index = 1; index < CODEX_MAX_LOADED_THREADS; index++) start('active-' + index)
        await vi.waitFor(() => expect(server.requests('turn/start')).toHaveLength(CODEX_MAX_LOADED_THREADS))

        const readsBefore = reads
        const queued = start('ninth')
        await vi.waitFor(() => expect(reads).toBeGreaterThan(readsBefore))
        expect(server.requests('thread/start')).toHaveLength(CODEX_MAX_LOADED_THREADS)

        stop.abort(new Error('Stopped'))
        await expect(stopped).rejects.toThrow('Stopped')
        expect(server.requests('turn/interrupt').map((message) => message.params)).toContainEqual({ threadId: victim, turnId: 'turn-1' })
        expect(server.requests('thread/unsubscribe')).toHaveLength(0)

        const notify = (method: string, params: unknown) => server.processes[0]!.stdout.write(JSON.stringify({ method, params }) + '\n')
        notify('turn/completed', { threadId: victim, turn: { id: 'turn-1', status: 'interrupted', error: null } })
        await vi.waitFor(() => expect(server.requests('thread/unsubscribe').map((message) => message.params)).toEqual([{ threadId: victim }]))
        holdTurn = false
        notify('thread/closed', { threadId: victim })

        expect((await queued).codexThreadId).not.toBe(victim)
        expect(server.requests('turn/start')).toHaveLength(CODEX_MAX_LOADED_THREADS + 1)
        expect(server.launches).toHaveLength(1)
      } finally {
        stop.abort()
        lifetime.abort()
        await service.stop()
        await Promise.allSettled(pending)
      }
    })

    it('recycles when unsubscribe acknowledges without confirming unload', async () => {
      const server = turnServer({ provider: () => MANAGED })
      const service = managed(server)
      // Reuse t0 just before the ninth turn, so thr-2 is the least recently used.
      for (let index = 0; index < CODEX_MAX_LOADED_THREADS; index++) await chat(service, { threadId: 't' + index })
      service.commitConversation('t0', 'h')
      await chat(service, { threadId: 't0', history: 'h' })
      await chat(service, { threadId: 'overflow' })
      expect(server.requests('thread/unsubscribe').map((request) => request.params)).toContainEqual({ threadId: 'thr-2' })
      expect(server.processes[0].signalCode).toBe('SIGTERM')
      await chat(service, { threadId: 'later' })
      expect(server.launches).toHaveLength(2)
    })

    it('one process serves turns on different threads for the whole idle window, and closes once it has passed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const server = turnServer({ provider: () => MANAGED })
      const service = managed(server)
      await chat(service, { threadId: 'a' })
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await chat(service, { threadId: 'b' })
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await chat(service, { threadId: 'a' })
      expect(server.launches).toHaveLength(1)
      expect(server.processes[0].signalCode).toBeNull()
      await vi.advanceTimersByTimeAsync(CODEX_IDLE_CLOSE_MS + 1)
      expect(server.processes[0].signalCode).toBe('SIGTERM')
    })

    it('unloads a completed delegated child thread via thread/unsubscribe after its grace while keeping the shared server warm and saved history resumable', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const server = turnServer({ provider: () => MANAGED })
      const service = managed(server, undefined, { idleCloseMs: 15 * 60_000, delegateUnloadMs: 2 * 60_000 })
      await chat(service, { threadId: 'parent' })
      service.commitConversation('parent', 'hp')
      const child = await chat(service, { threadId: 'child', child: { readOnly: false } })
      service.commitConversation('child', 'hc')
      expect(server.requests('thread/unsubscribe')).toHaveLength(0)

      // After the delegate grace, only the child thread unloads; the shared app-server stays alive for the parent.
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1)
      expect(server.requests('thread/unsubscribe').map((request) => request.params)).toEqual([{ threadId: child.codexThreadId }])
      expect(server.processes[0].signalCode).toBeNull()

      // A follow-up on the unloaded child resumes the saved Codex thread cleanly on the same warm server.
      server.processes[0]!.stdout.write(JSON.stringify({ method: 'thread/closed', params: { threadId: child.codexThreadId } }) + '\n')
      await Promise.resolve()
      await chat(service, { threadId: 'child', child: { readOnly: false }, history: 'hc' })
      expect(server.launches).toHaveLength(1)
      expect(server.requests('thread/resume').map((request) => request.params)).toContainEqual(expect.objectContaining({ threadId: child.codexThreadId }))
    })

    it('evicts an idle delegated thread before an older interactive thread at the loaded-thread cap', async () => {
      const server = turnServer({ provider: () => MANAGED })
      const service = managed(server, undefined, { delegateUnloadMs: 60 * 60_000 })
      // t0 is interactive (oldest); t1 is delegated; t2..t7 are interactive.
      await chat(service, { threadId: 't0' })
      const child = await chat(service, { threadId: 't1', child: { readOnly: false } })
      for (let index = 2; index < CODEX_MAX_LOADED_THREADS; index++) await chat(service, { threadId: 't' + index })
      // Admitting one more thread evicts the delegated thread first, not the older interactive t0.
      await chat(service, { threadId: 'overflow' })
      expect(server.requests('thread/unsubscribe').map((request) => request.params)[0]).toEqual({ threadId: child.codexThreadId })
    })
  })
})

describe('codexMcpConfigOverrides', () => {
  it('attaches the Mousse server over HTTP with the run token, pre-approved', () => {
    expect(codexMcpConfigOverrides(null)).toEqual({})
    expect(codexMcpConfigOverrides({ url: 'http://127.0.0.1:9/mcp', token: 'tok' })).toEqual({
      'mcp_servers.mousse.url': 'http://127.0.0.1:9/mcp',
      'mcp_servers.mousse.http_headers': { Authorization: 'Bearer tok' },
      'mcp_servers.mousse.tool_timeout_sec': 3600,
      'mcp_servers.mousse.default_tools_approval_mode': 'approve'
    })
  })
})

describe('a usage limit on a Codex turn', () => {
  const inHours = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600
  const window = (usedPercent: number, windowDurationMins: number, resetsAt: number | null) => ({ usedPercent, windowDurationMins, resetsAt })
  const exhausted = (resetsAt: number | null) => ({ primary: window(100, 300, resetsAt), secondary: window(20, 10_080, inHours(100)) })
  const limitError = (codexErrorInfo?: unknown, message = "You've hit your usage limit.") => ({ message, ...(codexErrorInfo === undefined ? {} : { codexErrorInfo }) })

  /** A server whose first turn fails with `error`; later turns complete. `rateLimits` answers `account/rateLimits/read`, `snapshot` is sent just before the failure. */
  function failingServer(options: { error: Record<string, unknown>; rateLimits?: Reply; snapshot?: unknown }) {
    let turns = 0
    const server = scriptedServer((message) => {
      switch (message.method) {
        case 'account/read':
          return chatgpt
        case 'config/read':
          return { result: { config: { mcp_servers: {} }, layers: [] } }
        case 'thread/start':
        case 'thread/resume':
          return { result: { thread: { id: 'thr-1' }, model: 'gpt-x', modelProvider: CODEX_MODEL_PROVIDER, cwd: home } }
        case 'turn/start': {
          const failing = turns++ === 0
          setImmediate(() => {
            const out = server.processes.at(-1)!.stdout
            if (failing && options.snapshot) out.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: options.snapshot } }) + '\n')
            out.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: failing ? 'failed' : 'completed', error: failing ? options.error : null } } }) + '\n')
          })
          return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
        }
        case 'account/rateLimits/read':
          return options.rateLimits ?? { error: { code: -32601, message: 'method not found' } }
        default:
          return { result: {} }
      }
    })
    return server
  }
  const chat = (service: CodexProviderService, history = '') =>
    service.chat({ threadId: 't', cwd: home, model: 'gpt-x', prompt: 'hi', history, onText: () => {} })

  it('a usageLimitExceeded failure takes its reset and window from account/rateLimits/read', async () => {
    const reset = inHours(2)
    const server = failingServer({ error: limitError('usageLimitExceeded'), rateLimits: { result: { rateLimits: exhausted(reset) } } })
    const error = await chat(create(server, { models: [{ id: 'gpt-x', label: 'GPT X' }] })).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'provider_usage_limit',
      details: { provider: 'codex', limitKind: 'five_hour', estimated: false, resetsAt: new Date(reset * 1000).toISOString() },
      errorInfo: { retryable: false }
    })
    expect(server.methods().filter((method) => method === 'account/rateLimits/read')).toHaveLength(1)
  })

  it('falls back to the last snapshot the server sent when the read is refused', async () => {
    const reset = inHours(3)
    const server = failingServer({ error: limitError({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }), snapshot: exhausted(reset) })
    const error = await chat(create(server)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { limitKind: 'five_hour', estimated: false, resetsAt: new Date(reset * 1000).toISOString() } })
  })

  it('estimates the reset when neither the read nor a snapshot names one', async () => {
    const before = Date.now()
    const server = failingServer({ error: limitError('rateLimitExceeded'), rateLimits: { result: { rateLimits: exhausted(null) } } })
    const error = await chat(create(server)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { estimated: true } })
    const at = Date.parse((error as { details: { resetsAt: string } }).details.resetsAt)
    expect(at).toBeGreaterThanOrEqual(before + 5 * 3600_000)
    expect(at).toBeLessThan(Date.now() + 5 * 3600_000 + 1)
  })

  it('an old server without a structured kind is read from its message', async () => {
    const server = failingServer({ error: limitError(undefined, "You've hit your usage limit. Try again at 2:01 PM."), rateLimits: { result: { rateLimits: exhausted(inHours(1)) } } })
    const error = await chat(create(server)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { estimated: false } })
  })

  it('a dropped stream whose message names a usage limit is a usage limit, with no guessed reset', async () => {
    // The subscription-sharing limit: Codex sends a transport kind, and the plan windows are not exhausted.
    const message = 'stream disconnected before completion: The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.'
    const server = failingServer({ error: limitError({ responseStreamDisconnected: { httpStatusCode: null } }, message), rateLimits: { result: { rateLimits: { primary: window(40, 300, inHours(2)) } } } })
    const error = await chat(create(server)).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'provider_usage_limit', details: { provider: 'codex', estimated: true }, errorInfo: { retryable: false } })
    expect(server.methods()).toContain('account/rateLimits/read')
  })

  it('a structured kind that is not a limit is believed over the message', async () => {
    const server = failingServer({ error: limitError('contextWindowExceeded', 'The context window is full; the usage limit of the model was exceeded') })
    const error = await chat(create(server)).catch((caught: unknown) => caught)
    expect(error).not.toMatchObject({ code: 'provider_usage_limit' })
    expect((error as Error).message).toContain('context window is full')
    expect(server.methods()).not.toContain('account/rateLimits/read')
  })

  it('the next turn resumes the same Codex thread the limit ended', async () => {
    const server = failingServer({ error: limitError('usageLimitExceeded'), rateLimits: { result: { rateLimits: exhausted(inHours(1)) } } })
    const service = create(server)
    await expect(chat(service, 'H1')).rejects.toMatchObject({ code: 'provider_usage_limit' })
    // The adapter reports the history the failed turn left: H1 and its request.
    service.commitInterrupted('t', 'H1 + request')
    await chat(service, 'H1 + request')
    expect(server.methods().filter((method) => method === 'thread/start')).toHaveLength(1)
    expect(server.messages.filter((message) => message.method === 'turn/start').map((message) => (message.params as { threadId: string }).threadId)).toEqual(['thr-1', 'thr-1'])
  })
})

describe("the managed entry's reader of the user's own Codex CLI", () => {
  const limits = { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_900_100_000 }, rateLimitReachedType: null }

  it('reads the account and its limits live, whatever the built-in entry says, and keeps its settings in the entry state folder', async () => {
    // The built-in entry is signed out (or removed) in Mousse: the reader does not ask it.
    signedOut = true
    const server = scriptedServer((message) => (message.method === 'account/rateLimits/read' ? { result: { rateLimits: limits } } : chatgpt))
    const stateDir = join(home, 'harness', 'codex_managed')
    const reader = userCodexLimitsReader({ profileHome: home, questions, stateDir, instanceId: 'codex:managed' }, () => binary, server.launch)
    services.push(reader)
    expect((await reader.status()).state).toBe('connected')
    expect(reader.account()?.subject).toContain('workspace-one')
    expect(await reader.rateLimits()).toMatchObject({ live: true, snapshot: { primary: limits.primary, secondary: limits.secondary } })
    // It reads; it never starts a thread or a turn.
    expect(server.methods().filter((method) => method.startsWith('thread/') || method.startsWith('turn/'))).toEqual([])
    expect(readFileSync(join(stateDir, 'user-codex-limits', 'settings.json'), 'utf8')).not.toContain('me@example.com')
  })

  it('with no Codex program to run, it reads nothing', async () => {
    const server = scriptedServer(() => chatgpt)
    const reader = userCodexLimitsReader({ profileHome: home, questions, stateDir: join(home, 'state'), instanceId: 'codex:managed' }, () => undefined, server.launch)
    services.push(reader)
    expect((await reader.status()).state).toBe('missing_binary')
    expect(server.launches).toHaveLength(0)
  })
})

describe('plan usage limits for the usage page', () => {
  const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({ usedPercent, windowDurationMins, resetsAt })
  const limits = (used: number) => ({ primary: window(used, 300, 1_900_000_000), secondary: window(used / 2, 10_080, 1_900_100_000), rateLimitReachedType: null })

  it('reads account/rateLimits/read from Codex through its app-server', async () => {
    const server = scriptedServer((message) => (message.method === 'account/rateLimits/read' ? { result: { rateLimits: limits(40) } } : chatgpt))
    const service = create(server)
    const read = await service.rateLimits()
    expect(read).toMatchObject({ live: true, snapshot: limits(40) })
    expect(server.methods()).toContain('account/rateLimits/read')
  })

  it('when a read fails, the last snapshot Codex sent stands in, marked as not live', async () => {
    let failing = false
    const server = scriptedServer((message) => {
      if (message.method !== 'account/rateLimits/read') return chatgpt
      return failing ? { error: { code: -32000, message: 'rate limits are unavailable' } } : { result: { rateLimits: limits(10) } }
    })
    const service = create(server)
    await service.status({ force: true })
    expect(await service.rateLimits()).toMatchObject({ live: true, snapshot: limits(10) })
    // A turn's account update is kept too, and is newer than the read.
    server.processes.at(-1)!.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: limits(55) } }) + '\n')
    await vi.waitFor(async () => {
      failing = true
      const stale = await service.rateLimits()
      expect(stale).toMatchObject({ live: false, snapshot: limits(55) })
    })
  })

  it("never shows another account's limits: after an account switch or a disconnect a failed read throws", async () => {
    let email = 'me@example.com'
    let failing = false
    const server = scriptedServer((message) => {
      if (message.method === 'account/read') return { result: { account: { type: 'chatgpt', email, planType: 'plus' }, requiresOpenaiAuth: true } }
      return failing ? { error: { code: -32000, message: 'rate limits are unavailable' } } : { result: { rateLimits: limits(10) } }
    })
    const service = create(server)
    await service.status({ force: true })
    expect(await service.rateLimits()).toMatchObject({ live: true })
    failing = true
    // The same account: its last snapshot stands in.
    expect(await service.rateLimits()).toMatchObject({ live: false, snapshot: limits(10) })
    // Another account signs in in the terminal: the old account's numbers are not shown.
    email = 'other@example.com'
    writeTerminalAuth(process.env.CODEX_HOME!, 'workspace-two', 'replacement-token')
    await service.status({ force: true })
    await expect(service.rateLimits()).rejects.toThrow(/unavailable/)
    // A read that succeeds for the new account is that account's own snapshot from then on; a disconnect forgets it.
    failing = false
    expect(await service.rateLimits()).toMatchObject({ live: true })
    await service.logout()
    failing = true
    await expect(service.rateLimits()).rejects.toThrow(/unavailable/)
  })

  it('keeps the reset credits of a read with the snapshot, and a later turn update does not lose them', async () => {
    const resetCredits = { availableCount: 2, credits: [{ id: 'rc_secret_id', resetType: 'weekly', status: 'available', grantedAt: 1, expiresAt: 1_900_432_000, title: 'Weekly limit reset', description: 'x' }] }
    const server = scriptedServer((message) => (message.method === 'account/rateLimits/read' ? { result: { rateLimits: limits(40), rateLimitResetCredits: resetCredits } } : chatgpt))
    const service = create(server)
    await service.status({ force: true })
    const read = await service.rateLimits()
    expect(read.snapshot.rateLimitResetCredits).toEqual({ availableCount: 2, credits: [{ id: 'rc_secret_id', resetType: 'weekly', status: 'available', title: 'Weekly limit reset', expiresAt: 1_900_432_000 }] })
    // The description is not kept; the opaque id is, so this credit can be used.
    expect(readFileSync(join(home, 'providers', 'codex', 'settings.json'), 'utf8')).not.toContain('"description"')
    server.processes.at(-1)!.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: limits(55) } }) + '\n')
    await vi.waitFor(() => expect(service.reportedRateLimits()?.snapshot.primary?.usedPercent).toBe(55))
    expect(service.reportedRateLimits()?.snapshot.rateLimitResetCredits?.availableCount).toBe(2)
  })

  it('uses a reset credit with Codex\'s own method, a fresh idempotency key each time, then reads the limits again', async () => {
    const server = scriptedServer((message) => {
      if (message.method === 'account/rateLimitResetCredit/consume') return { result: { outcome: 'reset' } }
      if (message.method === 'account/rateLimits/read') return { result: { rateLimits: limits(0) } }
      return chatgpt
    })
    const service = create(server)
    await service.status({ force: true })
    expect(await service.consumeResetCredit('rc_1')).toEqual({ outcome: 'reset' })
    expect(await service.consumeResetCredit(undefined)).toEqual({ outcome: 'reset' })
    const consumes = server.messages.filter((message) => message.method === 'account/rateLimitResetCredit/consume').map((message) => message.params as { idempotencyKey: string; creditId?: string })
    expect(consumes[0]).toMatchObject({ creditId: 'rc_1', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(consumes[1]!.creditId).toBeUndefined()
    expect(consumes[0]!.idempotencyKey).not.toBe(consumes[1]!.idempotencyKey)
    const methods = server.methods()
    expect(methods.lastIndexOf('account/rateLimits/read')).toBeGreaterThan(methods.lastIndexOf('account/rateLimitResetCredit/consume'))
  })

  it('uses one reset at a time: a second while one is out is refused, and nothing is sent for it', async () => {
    const server = scriptedServer((message) => {
      if (message.method === 'account/rateLimitResetCredit/consume') return undefined
      if (message.method === 'account/rateLimits/read') return { result: { rateLimits: limits(0) } }
      return chatgpt
    })
    const service = create(server)
    await service.status({ force: true })
    const first = service.consumeResetCredit('rc_1')
    await vi.waitFor(() => expect(server.methods()).toContain('account/rateLimitResetCredit/consume'))
    await expect(service.consumeResetCredit('rc_2')).rejects.toThrow('A reset is already being used.')
    const sent = server.messages.filter((message) => message.method === 'account/rateLimitResetCredit/consume')
    expect(sent).toHaveLength(1)
    server.processes[0]!.stdout.write(JSON.stringify({ id: sent[0]!.id, result: { outcome: 'reset' } }) + '\n')
    expect(await first).toEqual({ outcome: 'reset' })
  })

  it('with nothing to fall back on, a failed read is thrown', async () => {
    const server = scriptedServer((message) => (message.method === 'account/rateLimits/read' ? { error: { code: -32601, message: 'method not found' } } : chatgpt))
    await expect(create(server).rateLimits()).rejects.toThrow(/method not found/)
  })

  it('keeps the last reported limits across a restart, saved under a hash of the account only', async () => {
    let used = 40
    // Codex may send more than the windows (credits, a plan name): only the windows' numbers are saved.
    const server = scriptedServer((message) => (message.method === 'account/rateLimits/read' ? { result: { rateLimits: { ...limits(used), credits: { balance: '12' } } } } : chatgpt))
    const service = create(server)
    await service.status({ force: true })
    await service.rateLimits()
    const subject = service.account()?.subject
    expect(subject).toContain('workspace-one')
    expect(service.reportedRateLimits()).toEqual({ snapshot: limits(40), at: expect.any(Number) })
    const saved = () => readFileSync(join(home, 'providers', 'codex', 'settings.json'), 'utf8')
    expect(saved()).not.toContain('me@example.com')
    expect(saved()).not.toContain('credits')
    // A second report within the minute is kept in memory; the file is not written again for it.
    used = 55
    await service.rateLimits()
    expect(service.reportedRateLimits()).toMatchObject({ snapshot: limits(55) })
    expect(JSON.parse(saved()).rateLimits.snapshot).toEqual(limits(40))
    // A new service on the same folder (a daemon restart) has them for that account, and for no other.
    const again = new CodexProviderService(home, questions, { launch: server.launch }, { launch: () => ({ binaryPath: binary }), signedOut: () => signedOut })
    services.push(again)
    expect(again.reportedRateLimits(subject)).toMatchObject({ snapshot: limits(40), at: expect.any(Number) })
    expect(again.reportedRateLimits('chatgpt:other@example.com')).toBeUndefined()
    expect(again.reportedRateLimits(undefined)).toBeUndefined()
  })
})
