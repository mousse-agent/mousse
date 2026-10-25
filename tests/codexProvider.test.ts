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
  CodexProviderService,
  codexEnvironment
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
const services: CodexProviderService[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mousse-codex-service-'))
  binary = join(home, 'codex')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n')
  chmodSync(binary, 0o755)
  questions = new UserQuestionService()
})
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  questions.shutdown()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function create(server: ReturnType<typeof scriptedServer>, settings: Record<string, unknown> = {}): CodexProviderService {
  mkdirSync(join(home, 'providers', 'codex'), { recursive: true })
  writeFileSync(join(home, 'providers', 'codex', 'settings.json'), JSON.stringify({ binaryPath: binary, ...settings }))
  const service = new CodexProviderService(home, questions, { launch: server.launch })
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
    await service.logout()
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
    const service = create(server, { disconnected: true })
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
    const service = new CodexProviderService(home, questions, { launch: server.launch, idleCloseMs: 20 })
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
