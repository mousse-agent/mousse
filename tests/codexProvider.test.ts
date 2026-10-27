import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../src/mms/providers/LoginSession'
import type { CodexLaunch, CodexProcess } from '../src/mms/providers/codex/CodexAppServerClient'
import {
  CODEX_ACCOUNT_TTL_MS,
  CODEX_FALLBACK_MODELS,
  CODEX_MODEL_PROVIDER,
  CodexProviderService,
  CodexTurnFailure,
  codexEnvironment,
  type CodexServiceDependencies,
  type CodexServiceOptions
} from '../src/mms/providers/codex/CodexProviderService'
import { codexMcpConfigOverrides } from '../src/mms/run/mcp/attachment'

type Message = { id?: number | string; method?: string; params?: unknown }
type Reply = { result?: unknown; error?: { code: number; message: string } }

/** An app-server stand-in answering each request through `answer`; records launches and messages. */
function scriptedServer(answer: (message: Message) => Reply | undefined) {
  const launches: CodexLaunch[] = []
  const messages: Message[] = []
  const processes: Array<EventEmitter & CodexProcess & { stdout: PassThrough }> = []
  const launch = (spec: CodexLaunch): CodexProcess => {
    launches.push(spec)
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
        const reply = message.method === 'initialize' ? { result: { userAgent: 'test', codexHome: '/h/.codex', platformFamily: 'unix', platformOs: 'macos' } } : answer(message)
        if (reply) stdout.write(JSON.stringify({ id: message.id, ...reply }) + '\n')
      }
    })
    processes.push(process as unknown as EventEmitter & CodexProcess & { stdout: PassThrough })
    return process as unknown as CodexProcess
  }
  return { launch, launches, messages, processes, methods: () => messages.map((message) => message.method) }
}

const chatgpt = { result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } }

let home: string
let binary: string
let questions: UserQuestionService
/** The instance's signed-out flag (the gateway's), as the services read it. */
let signedOut = false
const services: CodexProviderService[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-codex-service-'))
  binary = join(home, 'codex')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o755)
  questions = new UserQuestionService()
  signedOut = false
})
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  questions.shutdown()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function create(server: Pick<ReturnType<typeof scriptedServer>, 'launch'>, settings: Record<string, unknown> = {}): CodexProviderService {
  mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
  writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, ...settings }))
  // The instance config's launch settings and sign-out flag, as the gateway hands them over.
  const service = new CodexProviderService(home, questions, { launch: server.launch }, {
    launch: () => ({ binaryPath: binary }),
    signedOut: () => signedOut
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
    vi.stubEnv('CODEX_HOME', undefined as unknown as string)
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
    expect(server.methods()).toEqual(['initialize', 'initialized', 'account/read'])
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
    // One process served every check.
    expect(server.launches).toHaveLength(1)
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

  it('lists models from model/list across pages, falling back to the Codex default model', async () => {
    const server = scriptedServer((message) => {
      if (message.method === 'account/read') return chatgpt
      if (message.method !== 'model/list') return { result: {} }
      const cursor = (message.params as { cursor?: string }).cursor
      return {
        result: cursor
          ? { data: [{ id: 'gpt-b', model: 'gpt-b', displayName: 'GPT B', description: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false }], nextCursor: null }
          : {
              data: [
                { id: 'gpt-a', model: 'gpt-a', displayName: 'GPT A', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'ultra', description: '' }], defaultReasoningEffort: 'low', isDefault: true },
                { id: 'gpt-hidden', model: 'gpt-hidden', displayName: 'Hidden', description: '', hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false }
              ],
              nextCursor: 'page-2'
            }
      }
    })
    const service = create(server, { models: [{ id: 'stale', label: 'Stale' }] })
    await service.status()
    const models = await service.refreshModels()
    expect(models).toEqual([
      { id: 'gpt-a', label: 'GPT A', efforts: ['low'] },
      { id: 'gpt-b', label: 'GPT B' }
    ])
    expect(service.llmProvider()).toEqual({ id: 'codex', label: 'Codex', models })

    const fresh = scriptedServer(() => chatgpt)
    const unlisted = new CodexProviderService(mkdtempSync(join(tmpdir(), 'mousse-codex-empty-')), questions, { launch: fresh.launch, findBinary: () => binary })
    services.push(unlisted)
    await unlisted.status()
    expect(unlisted.llmProvider()?.models).toEqual(CODEX_FALLBACK_MODELS)
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
  function turnServer(options: { provider?: (method: string) => string; turn?: () => Turn | null } = {}) {
    let threads = 0
    const server = scriptedServer((message) => {
      const method = message.method!
      if (method === 'account/read') return chatgpt
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(method))
        return { result: { thread: { id: method === 'thread/resume' ? 'thr-saved' : `thr-${++threads}` }, model: 'gpt-x', modelProvider: options.provider?.(method) ?? 'openai', cwd: home } }
      if (method === 'turn/start') {
        const turn = options.turn ? options.turn() : { status: 'completed' }
        const threadId = (message.params as { threadId: string }).threadId
        if (turn) setImmediate(() => server.processes.at(-1)!.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', error: null, ...turn } } }) + '\n'))
        return { result: { turn: { id: 'turn-1', status: 'inProgress', error: null } } }
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

  it('the existing CLI pins openai on start, fork and resume', async () => {
    const server = turnServer()
    const service = create(server)
    await allRoutes(service, server)
    expect(pinned(server)).toEqual([['openai', 'openai'], ['openai', 'openai'], ['openai', 'openai']])
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
      service.stop()
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
      service.stop()
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
      turn: () => ({ status: 'failed', error: { message: 'usage limit', additionalDetails: null, codexErrorInfo: { responseStreamFailed: { httpStatusCode: 429 } } } })
    })
    const service = managed(server)
    const failure = await chat(service).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CodexTurnFailure)
    expect(failure).toMatchObject({ message: 'usage limit', httpStatus: 429, codexErrorInfo: { responseStreamFailed: { httpStatusCode: 429 } } })
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
    expect(await service.rateLimits()).toMatchObject({ live: true, snapshot: limits(10) })
    // A turn's account update is kept too, and is newer than the read.
    await service.status({ force: true })
    server.processes.at(-1)!.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: limits(55) } }) + '\n')
    await vi.waitFor(async () => {
      failing = true
      const stale = await service.rateLimits()
      expect(stale).toMatchObject({ live: false, snapshot: limits(55) })
    })
  })

  it('with nothing to fall back on, a failed read is thrown', async () => {
    const server = scriptedServer((message) => (message.method === 'account/rateLimits/read' ? { error: { code: -32601, message: 'method not found' } } : chatgpt))
    await expect(create(server).rateLimits()).rejects.toThrow(/method not found/)
  })
})
