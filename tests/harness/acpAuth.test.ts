/**
 * Sign-in of a generic ACP agent (agent CLIs plan §3): the methods the agent advertises (`agent`,
 * `env_var`, `terminal` in a fake pseudo-terminal), terminal methods only where a PTY runs, cancel
 * kills the terminal, and a sign-in counts only once a later `session/new` succeeds.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import type { DriverRuntime } from '../../src/mms/harness/driver'
import { instanceEnv } from '../../src/mms/harness/env'
import type { PtyProcess, PtySpawn } from '../../src/mms/harness/pty'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { ProviderLoginEvent } from '../../src/shared/providerAuth'

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface AgentOptions {
  authMethods: unknown[]
  /** `session/new` refuses until this is true. */
  signedIn: () => boolean
  onAuthenticate?: (methodId: string, client: { request: (method: string, params: unknown) => Promise<unknown> }) => Promise<void>
}

function setup(agentOptions: AgentOptions, pty?: { available: () => boolean; spawn?: PtySpawn }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'mousse-acp-auth-'))
  dirs.push(stateDir)
  const agent = inProcessAgent((app) => {
    app
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: agentOptions.authMethods as never }))
      .onRequest(methods.agent.authenticate, async (c) => {
        await agentOptions.onAuthenticate?.(c.params.methodId, c.client as never)
        return {}
      })
      .onRequest(methods.agent.session.new, () => {
        if (!agentOptions.signedIn()) throw RequestError.authRequired()
        return { sessionId: 'verify', configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'M' }] }] }
      })
  })
  const driver = acpDriver({ connect: (_context, request) => agent.connect(request), ...(pty ? { pty } : {}) })
  const config = driver.decodeConfig({ binaryPath: process.execPath, args: ['agent.js'] })
  const runtime = driver.create({
    instanceId: 'acp:fake',
    builtIn: false,
    config,
    env: instanceEnv({ instanceId: 'acp:fake', driver: 'acp', configRevision: 0, searchPath: [] }),
    profileHome: stateDir,
    installationHome: stateDir,
    stateDir,
    questions: new UserQuestionService(),
    findBinary: () => undefined,
    changed: vi.fn()
  })
  runtimes.push(runtime)
  const session = new LoginSession('op')
  const events: ProviderLoginEvent[] = []
  session.on('event', (event: ProviderLoginEvent) => events.push(event))
  return { runtime, session, events, agent, stateDir }
}

describe('ACP agent sign-in', () => {
  it('reads "not required" for an agent without methods, and "unknown" before its first check', async () => {
    const { runtime } = setup({ authMethods: [], signedIn: () => true })
    expect((await runtime.auth({ force: true })).state).toBe('unknown')
    await runtime.handshake!(new AbortController().signal)
    expect((await runtime.auth({ force: true })).state).toBe('not_required')
    expect(runtime.runtimeFacts?.()).toMatchObject({ source: 'handshake', authMethods: [] })
  })

  it('agent method: authenticates, forwards the link it sends, and counts only after session/new works', async () => {
    let signedIn = false
    const { runtime, session, events } = setup({
      authMethods: [{ id: 'browser', name: 'Sign in with your account' }],
      signedIn: () => signedIn,
      onAuthenticate: async (_id, client) => {
        await client.request('elicitation/create', { mode: 'url', elicitationId: 'e1', url: 'https://example.test/device?code=1', message: 'Open', sessionId: 'x' })
        signedIn = true
      }
    })
    await runtime.handshake!(new AbortController().signal)
    expect(await runtime.signIn!(session, process.cwd())).toEqual({ success: true, sessionId: 'op' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'auth_url', url: 'https://example.test/device?code=1' }))
    expect(await runtime.auth({ force: true })).toMatchObject({ state: 'signed_in', methodLabel: 'Sign in with your account' })
    expect(runtime.models().map((model) => model.id)).toEqual(['default', 'm'])
  })

  it('agent method: a sign-in the verification refuses is a failure', async () => {
    const { runtime, session } = setup({ authMethods: [{ id: 'browser', name: 'Browser' }], signedIn: () => false })
    const result = await runtime.signIn!(session, process.cwd())
    expect(result.success).toBe(false)
    expect((await runtime.auth({ force: true })).state).not.toBe('signed_in')
  })

  it('env_var method: asks for the variables, keeps them in the instance vault, and identifies the account by their hash', async () => {
    const { runtime, session, events, stateDir } = setup({
      authMethods: [{ id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'FAKE_API_KEY', label: 'Fake API key' }] }],
      signedIn: () => true
    })
    session.on('event', (event: ProviderLoginEvent) => {
      if (event.type === 'prompt') queueMicrotask(() => session.respond({ sessionId: 'op', kind: 'prompt', value: 'sk-secret' }))
    })
    expect(await runtime.signIn!(session, process.cwd())).toEqual({ success: true, sessionId: 'op' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'prompt', promptType: 'secret', message: 'Fake API key' }))
    expect(JSON.parse(readFileSync(join(stateDir, 'vault.json'), 'utf8'))).toEqual({ FAKE_API_KEY: 'sk-secret' })
    const subject = await runtime.identity!(new AbortController().signal)
    expect(subject).toMatch(/^apikey:[0-9a-f]{64}$/)
    expect(subject).not.toContain('sk-secret')
  })

  it('terminal method: runs the command in a PTY, shows its device code, and succeeds on exit 0', async () => {
    let exit: ((code: number) => void) | undefined
    let output: ((data: string) => void) | undefined
    const spawned: string[][] = []
    const spawn: PtySpawn = (command, args) => {
      spawned.push([command, ...args])
      const terminal: PtyProcess = {
        pid: 0,
        onData: (listener) => { output = listener; return { dispose: () => {} } },
        onExit: (listener) => { exit = (code) => listener({ exitCode: code }); return { dispose: () => {} } },
        kill: () => {}
      }
      return terminal
    }
    const { runtime, session, events } = setup({ authMethods: [{ id: 'login', name: 'Terminal sign-in', type: 'terminal', args: ['login', '--device'] }], signedIn: () => true }, { available: () => true, spawn })
    const result = runtime.signIn!(session, process.cwd())
    await vi.waitFor(() => expect(output).toBeDefined())
    output!('\x1b[1mOpen https://accounts.example.test/device and enter code ABCD-EFGH\x1b[0m\r\n')
    exit!(0)
    expect(await result).toEqual({ success: true, sessionId: 'op' })
    expect(spawned[0]).toEqual([process.execPath, 'agent.js', 'login', '--device'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://accounts.example.test/device' }))
  })

  it('terminal method: cancelling kills the terminal and never counts a late success', async () => {
    let exit: ((code: number) => void) | undefined
    const kill = vi.fn()
    const spawn: PtySpawn = () => ({
      pid: 0,
      onData: () => ({ dispose: () => {} }),
      onExit: (listener) => { exit = (code) => listener({ exitCode: code }); return { dispose: () => {} } },
      kill
    })
    const { runtime, session } = setup({ authMethods: [{ id: 'login', name: 'Terminal', type: 'terminal' }], signedIn: () => true }, { available: () => true, spawn })
    const result = runtime.signIn!(session, process.cwd())
    await vi.waitFor(() => expect(exit).toBeDefined())
    session.respond({ sessionId: 'op', kind: 'cancel' })
    exit!(0)
    expect(await result).toEqual({ success: false, sessionId: 'op', error: 'Login cancelled' })
    expect(kill).toHaveBeenCalled()
    expect((await runtime.auth({ force: true })).state).not.toBe('signed_in')
  })

  it('offers no terminal method where no PTY runs, and asks which of the rest to use', async () => {
    const { runtime, session, events } = setup({
      authMethods: [
        { id: 'login', name: 'Terminal', type: 'terminal' },
        { id: 'browser', name: 'Browser' },
        { id: 'key', name: 'API key', type: 'env_var', vars: [{ name: 'FAKE_API_KEY' }] }
      ],
      signedIn: () => true
    }, { available: () => false })
    session.on('event', (event: ProviderLoginEvent) => {
      if (event.type === 'select') queueMicrotask(() => session.respond({ sessionId: 'op', kind: 'select', value: 'browser' }))
    })
    expect(await runtime.signIn!(session, process.cwd())).toEqual({ success: true, sessionId: 'op' })
    const select = events.find((event) => event.type === 'select') as Extract<ProviderLoginEvent, { type: 'select' }>
    expect(select.options.map((option) => option.id)).toEqual(['browser', 'key'])
  })
})
