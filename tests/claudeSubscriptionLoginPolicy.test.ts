import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_AUTH_STATUS_TTL_MS,
  ClaudeSubscriptionProviderService,
  claudeSubscriptionEnvironment
} from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { LoginSession } from '../src/mms/providers/LoginSession'

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' })
type AuthReply = string | Error | (() => Promise<string>)
type AuthCall = { args: string[]; env: NodeJS.ProcessEnv }

/** A profile home with a fake `claude` binary; `runAuth` answers `claude auth status` and never spawns. */
function profile(options: {
  settings?: Record<string, unknown>
  /** Written verbatim instead of the generated settings JSON. */
  rawSettings?: string
  cli?: AuthReply
  binary?: boolean
  query?: (input: { options: Options; prompt: unknown }) => Query
}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-login-policy-'))
  homes.push(home)
  const binary = join(home, 'claude')
  if (options.binary !== false) {
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
  }
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  const settingsPath = join(directory, 'settings.json')
  writeFileSync(
    settingsPath,
    options.rawSettings ??
      JSON.stringify({
        binaryPath: binary,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        ...options.settings
      })
  )
  const calls: AuthCall[] = []
  const runAuth = vi.fn(async (_binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, env })
    const reply = options.cli ?? SIGNED_IN
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply() : reply
  })
  const query = vi.fn(options.query ?? (() => fakeQuery()))
  // The instance config's launch settings and sign-out flag, as the gateway hands them over.
  let signedOut = false
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    runAuth,
    query,
    launchConfig: () => ({ binaryPath: binary }),
    signedOut: () => signedOut
  })
  return {
    home,
    service,
    setSignedOut: (value: boolean) => {
      signedOut = value
    },
    runAuth,
    query,
    calls,
    settingsPath,
    stored: () => JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
  }
}
function fakeQuery(events: unknown[] = []) {
  const generator = (async function* () {
    for (const event of events) yield event
  })()
  return Object.assign(generator, {
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    supportedModels: vi.fn(async () => [])
  }) as unknown as Query
}
/** `claude auth status` exits 1 when signed out but still prints JSON. */
const exitOne = (stdout: string) =>
  Object.assign(new Error('Claude Code authentication command failed.'), { stdout })

describe('Claude Code launch environment', () => {
  const user = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
    ANTHROPIC_BASE_URL: 'router',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    AWS_PROFILE: 'other',
    GOOGLE_APPLICATION_CREDENTIALS: 'other',
    HTTPS_PROXY: 'http://proxy',
    CLAUDE_CONFIG_DIR: '/custom/claude'
  }
  it("keeps the user's configuration and removes only the markers of Mousse's own process", () => {
    // Mousse running as Electron-as-Node, or started from inside another Claude Code session.
    const mousseProcess = {
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
      CLAUDE_PID: '42'
    }
    expect(claudeSubscriptionEnvironment({ ...user, ...mousseProcess })).toEqual(user)
  })
  it('the sign-in check, model discovery and turns all start Claude Code with that environment', async () => {
    for (const [key, value] of Object.entries(user)) vi.stubEnv(key, value)
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const captured: Options[] = []
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hi',
      session_id: 'vendor-session'
    }
    const { service, home, calls } = profile({
      settings: { models: [] },
      query: ({ options }) => {
        captured.push(options)
        return fakeQuery([result])
      }
    })
    await service.status()
    await service.refreshModels(home)
    await service.chat({ threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: () => {} })
    expect(captured.length).toBeGreaterThanOrEqual(2)
    for (const env of [...calls.map((call) => call.env), ...captured.map((options) => options.env!)]) {
      expect(env).toMatchObject(user)
      expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    }
  })
})

describe('Claude terminal sign-in migration', () => {
  const session = { sessionId: 's', cwd: '/' }
  it.each([
    { name: 'no stored sign-in choice', settings: { sessions: { t: session } } },
    { name: 'an older profile-private sign-in', settings: { signedIn: true, sessions: { t: session } } },
    {
      name: 'a stored separate sign-in',
      settings: { loginPolicy: 'isolated', signedIn: true, sessions: { t: session } }
    }
  ])('$name switches to the terminal sign-in and drops its sessions', async ({ settings }) => {
    const { service, stored, calls } = profile({ settings })
    await expect(service.status()).resolves.toMatchObject({ state: 'connected' })
    expect(service.configured()).toBe(true)
    expect(stored()).toMatchObject({ loginPolicy: 'cli', sessions: {} })
    expect(stored()).not.toHaveProperty('signedIn')
    // The check ran against the terminal config, never a profile-private one.
    expect(calls.every((call) => call.env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR)).toBe(true)
  })

  it('keeps the sessions of a profile already on the terminal sign-in', async () => {
    const { service, stored } = profile({ settings: { loginPolicy: 'cli', sessions: { t: session } } })
    await service.status()
    expect(stored().sessions).toEqual({ t: session })
  })
})

describe('Claude terminal sign-in status', () => {
  it('derives configured() from a cached live probe, not the saved settings', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { service, runAuth } = profile({ settings: { loginPolicy: 'cli' } })
    expect(service.configured()).toBe(false)
    await expect(service.status()).resolves.toMatchObject({ state: 'connected' })
    expect(service.configured()).toBe(true)
    expect(runAuth).toHaveBeenCalledTimes(1)

    await service.status()
    now += CLAUDE_AUTH_STATUS_TTL_MS - 1
    await service.status()
    expect(runAuth).toHaveBeenCalledTimes(1)

    now += 1
    await service.status()
    expect(runAuth).toHaveBeenCalledTimes(2)

    await service.status({ force: true })
    expect(runAuth).toHaveBeenCalledTimes(3)
  })

  it('reports a signed-out terminal even when the CLI exits non-zero, and says how to sign in', async () => {
    const { service } = profile({ settings: { loginPolicy: 'cli' }, cli: exitOne(SIGNED_OUT) })
    const status = await service.status()
    expect(status).toMatchObject({ state: 'signed_out' })
    expect(status.message).toMatch(/claude auth login/)
    expect(service.configured()).toBe(false)
  })

  // The CLI is the user's own: a proxy token in its settings.json, an API key or a cloud
  // provider all count, not only a Claude account.
  it.each(['oauth_token', 'api_key', 'claude.ai', 'third_party'])(
    'counts a Claude Code sign-in through %s as signed in and lists models',
    async (authMethod) => {
      const { service } = profile({
        cli: JSON.stringify({ loggedIn: true, authMethod, apiProvider: 'firstParty' }),
        settings: { models: [] }
      })
      await expect(service.status()).resolves.toMatchObject({ state: 'connected' })
      expect(service.configured()).toBe(true)
      expect(service.llmProvider()?.models.map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku'])
    }
  )

  it('runs model discovery after the first sign-in check', async () => {
    const supportedModels = vi.fn(async () => [{ value: 'opus', displayName: 'Opus', description: '' }])
    const { service, home } = profile({
      cli: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }),
      settings: { models: [] },
      query: () => Object.assign(fakeQuery(), { supportedModels }) as unknown as Query
    })
    // A refresh before any status check checks the sign-in first instead of doing nothing.
    await service.refreshModels(home)
    expect(supportedModels).toHaveBeenCalled()
    expect(service.llmProvider()?.models).toEqual([{ id: 'opus', label: 'Opus', efforts: undefined }])
  })

  it('tells listeners when a listing started by a sign-in check saves the models', async () => {
    const supportedModels = vi.fn(async () => [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient' }])
    const { service } = profile({
      cli: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      settings: { models: [] },
      query: () => Object.assign(fakeQuery(), { supportedModels }) as unknown as Query
    })
    const changed = vi.fn()
    const unsubscribe = service.onModelsChanged(changed)
    // Open pickers show the aliases until the listing that this check starts in the background is saved.
    await service.status()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    expect(service.llmProvider()?.models.map((model) => model.label)).toEqual(['Sonnet 5.5'])
    unsubscribe()
    await service.refreshModels(process.cwd())
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('separates missing binary and probe errors', async () => {
    const missing = profile({ binary: false })
    await expect(missing.service.status()).resolves.toMatchObject({ state: 'missing_binary' })
    const broken = profile({ cli: 'not json' })
    await expect(broken.service.status()).resolves.toMatchObject({ state: 'error' })
  })
})

describe('Claude disconnect', () => {
  it('never runs claude auth logout, and signing in again reconnects', async () => {
    const { service, calls, stored, home, setSignedOut } = profile({})
    await service.status()
    expect(service.configured()).toBe(true)
    // The gateway sets the flag, then the service drops its sessions; the mirror records the flag.
    setSignedOut(true)
    await service.logout()
    service.vendorMirror(['signedOut']).write({ signedOut: true })
    expect(calls.some((call) => call.args.includes('logout'))).toBe(false)
    expect(service.configured()).toBe(false)
    await expect(service.status()).resolves.toMatchObject({ state: 'disconnected' })
    expect(stored()).toMatchObject({ loginPolicy: 'cli', cliDisconnected: true })

    setSignedOut(false)
    await expect(service.login(new LoginSession('login'), home)).resolves.toMatchObject({ success: true })
    await expect(service.status()).resolves.toMatchObject({ state: 'connected' })
    expect(calls.some((call) => call.args.includes('logout') || call.args.includes('login'))).toBe(false)
  })
})

describe('Claude sign-in', () => {
  it('asks a signed-out terminal user to run claude auth login and never runs it', async () => {
    const { service, home, calls } = profile({ cli: exitOne(SIGNED_OUT) })
    const session = new LoginSession('login')
    const prompts: string[] = []
    session.on('event', (event: { type: string; message?: string }) => {
      if (event.type !== 'select') return
      prompts.push(event.message ?? '')
      session.respond({ sessionId: session.sessionId, kind: 'select', value: 'cancel' })
    })
    await expect(service.login(session, home)).resolves.toMatchObject({ success: false })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/isn't signed in\. Run `claude auth login` in a terminal/)
    expect(calls.every((call) => call.args.join(' ') === 'auth status')).toBe(true)
  })

  it('does not ask for the Claude binary on an already cancelled sign-in', async () => {
    const f = profile({ binary: false })
    const session = new LoginSession('login')
    const events: unknown[] = []
    session.on('event', (event) => events.push(event))
    session.abort.abort()
    await expect(f.service.login(session, f.home)).resolves.toMatchObject({ success: false })
    expect(events).toEqual([])
  })

  it('tells a signed-out terminal user to run claude auth login when a turn starts', async () => {
    const { service, home } = profile({ cli: exitOne(SIGNED_OUT) })
    await expect(
      service.chat({ threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: () => {} })
    ).rejects.toThrow(/claude auth login/)
  })
})

describe('Claude settings safety', () => {
  it.each([
    { name: 'malformed', raw: '{"loginPolicy":"isolated"', unreadable: false },
    { name: 'unreadable', raw: JSON.stringify({ loginPolicy: 'isolated' }), unreadable: true }
  ])('$name settings are never migrated or overwritten', async ({ raw, unreadable }) => {
    const f = profile({ rawSettings: raw })
    if (unreadable) chmodSync(f.settingsPath, 0o000)
    try {
      const fresh = new ClaudeSubscriptionProviderService(
        f.home,
        new UserQuestionService(),
        { runAuth: f.runAuth, query: f.query }
      )
      await expect(fresh.status()).resolves.toMatchObject({ state: 'error' })
      // The mirror refuses before it assigns anything: nothing is written over the file.
      expect(fresh.vendorMirror(['binaryPath', 'args', 'env', 'signedOut']).read()).toBe('unreadable')
      expect(() => fresh.vendorMirror(['args']).write({ args: ['--verbose'] })).toThrow(/could not read/)
      await fresh.logout()
      expect(fresh.configured()).toBe(false)
      expect(f.runAuth).not.toHaveBeenCalled()
      chmodSync(f.settingsPath, 0o600)
      expect(readFileSync(f.settingsPath, 'utf8')).toBe(raw)
    } finally {
      chmodSync(f.settingsPath, 0o600)
    }
  })
})
