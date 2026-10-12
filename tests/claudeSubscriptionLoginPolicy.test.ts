import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_AUTH_STATUS_TTL_MS,
  ClaudeSubscriptionProviderService,
  claudeSubscriptionEnvironment
} from '../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' })
type AuthReply = string | Error
type AuthCall = { args: string[]; env: NodeJS.ProcessEnv }

/** A profile home with a fake `claude` binary; `runAuth` answers per config dir and never spawns. */
function profile(options: {
  defaultProfile?: boolean
  settings?: Record<string, unknown>
  /** Files already present in the profile-private Claude config dir. */
  isolatedFiles?: boolean
  cli?: AuthReply
  isolated?: AuthReply
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
  const configDir = join(directory, 'claude-config')
  mkdirSync(directory, { recursive: true })
  if (options.isolatedFiles) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), '{}')
  }
  const settingsPath = join(directory, 'settings.json')
  writeFileSync(
    settingsPath,
    JSON.stringify({
      binaryPath: binary,
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      ...options.settings
    })
  )
  const calls: AuthCall[] = []
  const runAuth = vi.fn(async (_binary: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, env })
    if (args[1] === 'logout') return ''
    const reply =
      env.CLAUDE_CONFIG_DIR === configDir ? (options.isolated ?? SIGNED_OUT) : (options.cli ?? SIGNED_IN)
    if (reply instanceof Error) throw reply
    return reply
  })
  const query = vi.fn(options.query ?? (() => fakeQuery()))
  const service = new ClaudeSubscriptionProviderService(
    home,
    new UserQuestionService(),
    { runAuth, query },
    { defaultProfile: options.defaultProfile }
  )
  return {
    home,
    configDir,
    service,
    runAuth,
    query,
    calls,
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

describe('Claude login policy environment', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_BASE_URL: 'router',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_USE_VERTEX: '1',
    AWS_PROFILE: 'other',
    CLAUDECODE: '1'
  }
  it('cli: sets no config dir, keeps HOME and still strips API, token and cloud variables', () => {
    expect(claudeSubscriptionEnvironment(undefined, source)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me'
    })
  })
  it('cli: preserves an inherited CLAUDE_CONFIG_DIR', () => {
    expect(
      claudeSubscriptionEnvironment(undefined, { ...source, CLAUDE_CONFIG_DIR: '/custom/claude' })
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CONFIG_DIR: '/custom/claude' })
  })
  it('isolated: replaces an inherited CLAUDE_CONFIG_DIR with the profile dir', () => {
    expect(
      claudeSubscriptionEnvironment('/profile/claude', { ...source, CLAUDE_CONFIG_DIR: '/custom' })
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CONFIG_DIR: '/profile/claude' })
  })
  it('cli turns run the SDK without an isolated dir or API key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'secret')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/custom/claude')
    let captured: Options | undefined
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hi',
      session_id: 'vendor-session'
    }
    const { service, home, calls } = profile({
      defaultProfile: true,
      query: ({ options }) => {
        captured = options
        return fakeQuery([result])
      }
    })
    await service.chat({ threadId: 't', cwd: home, model: 'sonnet', prompt: 'hi', onText: () => {} })
    expect(captured?.env?.CLAUDE_CONFIG_DIR).toBe('/custom/claude')
    expect(captured?.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(calls.every((call) => call.env.CLAUDE_CONFIG_DIR === '/custom/claude')).toBe(true)
  })
})

describe('Claude login policy migration', () => {
  it.each([
    { name: 'default profile without a profile sign-in', defaultProfile: true, expected: 'cli' },
    {
      name: 'default profile with a saved profile sign-in',
      defaultProfile: true,
      settings: { signedIn: true },
      expected: 'isolated'
    },
    {
      name: 'default profile whose isolated config holds an account',
      defaultProfile: true,
      isolatedFiles: true,
      isolated: SIGNED_IN,
      expected: 'isolated'
    },
    {
      name: 'default profile whose isolated config has no account',
      defaultProfile: true,
      isolatedFiles: true,
      isolated: exitOne(SIGNED_OUT),
      expected: 'cli'
    },
    { name: 'non-default profile', defaultProfile: false, expected: 'isolated' },
    {
      name: 'stored isolated policy on the default profile',
      defaultProfile: true,
      settings: { loginPolicy: 'isolated' },
      expected: 'isolated'
    },
    {
      name: 'stored cli policy on a non-default profile',
      defaultProfile: false,
      settings: { loginPolicy: 'cli', signedIn: true },
      expected: 'cli'
    }
  ] as const)('$name → $expected', async (row) => {
    const { service, stored } = profile(row)
    const status = await service.status()
    expect(status.loginPolicy).toBe(row.expected)
    expect(stored().loginPolicy).toBe(row.expected)
  })

  it('a failed check leaves the policy unresolved and inactive', async () => {
    const { service, stored, calls, configDir } = profile({
      defaultProfile: true,
      isolatedFiles: true,
      isolated: new Error('spawn failed')
    })
    const status = await service.status()
    expect(status).toMatchObject({ loginPolicy: null, state: 'error' })
    expect(stored().loginPolicy).toBeUndefined()
    expect(service.configured()).toBe(false)
    // Never probed the terminal sign-in while unresolved.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.env.CLAUDE_CONFIG_DIR === configDir)).toBe(true)
  })

  it('shows the switch hint data for a default profile that kept its own sign-in', async () => {
    const { service } = profile({ defaultProfile: true, settings: { signedIn: true } })
    expect(await service.status()).toMatchObject({
      loginPolicy: 'isolated',
      defaultProfile: true,
      isolatedSignIn: true,
      state: 'connected'
    })
  })
})

describe('Claude terminal sign-in status', () => {
  it('derives configured() from a cached live probe, not the saved signedIn flag', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { service, runAuth } = profile({
      defaultProfile: true,
      settings: { loginPolicy: 'cli', signedIn: false }
    })
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

  it('reports a signed-out terminal even when the CLI exits non-zero', async () => {
    const { service } = profile({
      defaultProfile: true,
      settings: { loginPolicy: 'cli', signedIn: true },
      cli: exitOne(SIGNED_OUT)
    })
    await expect(service.status()).resolves.toMatchObject({ state: 'signed_out' })
    expect(service.configured()).toBe(false)
  })

  it('does not count an API-key terminal sign-in as a subscription', async () => {
    const { service } = profile({
      defaultProfile: true,
      cli: JSON.stringify({ loggedIn: true, authMethod: 'api_key' })
    })
    await expect(service.status()).resolves.toMatchObject({ state: 'signed_out' })
    expect(service.configured()).toBe(false)
  })

  it('separates missing binary and probe errors', async () => {
    const missing = profile({ defaultProfile: true, binary: false })
    await expect(missing.service.status()).resolves.toMatchObject({ state: 'missing_binary' })
    const broken = profile({ defaultProfile: true, cli: 'not json' })
    await expect(broken.service.status()).resolves.toMatchObject({ state: 'error' })
  })

  it('a policy change invalidates the cached probe and saved sessions', async () => {
    const { service, runAuth, stored } = profile({
      defaultProfile: true,
      settings: { sessions: { t: { sessionId: 's', cwd: '/' } } }
    })
    await service.status()
    expect(runAuth).toHaveBeenCalledTimes(1)
    await expect(service.setLoginPolicy('isolated')).resolves.toMatchObject({
      loginPolicy: 'isolated',
      state: 'signed_out'
    })
    expect(service.configured()).toBe(false)
    expect(stored()).toMatchObject({ loginPolicy: 'isolated', sessions: {} })
    await service.setLoginPolicy('cli')
    expect(runAuth).toHaveBeenCalledTimes(2)
    expect(service.configured()).toBe(true)
  })
})

describe('Claude disconnect', () => {
  it('never runs claude auth logout for the terminal sign-in', async () => {
    const { service, calls, stored } = profile({ defaultProfile: true })
    await service.status()
    expect(service.configured()).toBe(true)
    await service.logout()
    expect(calls.some((call) => call.args.includes('logout'))).toBe(false)
    expect(service.configured()).toBe(false)
    await expect(service.status()).resolves.toMatchObject({ loginPolicy: 'cli', state: 'disconnected' })
    expect(stored()).toMatchObject({ loginPolicy: 'cli', cliDisconnected: true })

    await expect(service.setLoginPolicy('cli')).resolves.toMatchObject({ state: 'connected' })
    expect(calls.some((call) => call.args.includes('logout'))).toBe(false)
  })

  it('still logs out the profile-private sign-in under isolated', async () => {
    const { service, calls, configDir } = profile({
      defaultProfile: false,
      settings: { signedIn: true }
    })
    await service.logout()
    const logout = calls.find((call) => call.args.includes('logout'))
    expect(logout?.env.CLAUDE_CONFIG_DIR).toBe(configDir)
  })
})
