/**
 * Claude Code with an Anthropic API key (PR 2 §6, `claude:api`): the id; the key applied last on
 * every process with every sign-in and route variable dropped, the entry's own home and address
 * set again, and the home's settings not loaded; sign-in by secret prompt (never a terminal
 * command); Recheck through `models.list`; an identity that never contains the key; one key store
 * per instance across config changes; sign-out ending every process that holds the key; and no
 * fallback to the user's own Claude Code. No real Claude Code, key or endpoint: the service's
 * runners are fakes, and `models.list` is a fake checker or a loopback recorder.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkClaudeApiKey, claudeApiKeyEnv, claudeApiKeySubject, claudeKeyTurnSettings, type ClaudeApiKeyChecker } from '../../src/mms/harness/claude/apiKey'
import type { DriverContext, DriverRuntime, HarnessDriver, InstanceConfig } from '../../src/mms/harness/driver'
import { claudeCodeDriver, claudeFamilyAlias, type SettingsResolver } from '../../src/mms/harness/drivers/claudeCode'
import { instanceEnv } from '../../src/mms/harness/env'
import { createHarnessGateway, type HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import { addedInstanceId } from '../../src/mms/harness/instances'
import { InstanceVault } from '../../src/mms/harness/vault'
import { InstanceVault } from '../../src/mms/harness/vault'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { asAddInstanceInput } from '../../src/mms/protocol/validators'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { LoginSession } from '../../src/mms/providers/LoginSession'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { FakeClaudeCli, roster } from '../run/fakeClaudeCli'

const KEY = 'sk-ant-api03-fake-key-for-tests'
const OTHER_KEY = 'sk-ant-api03-another-fake-key'
const SUBSCRIPTION_TOKEN = 'sk-ant-oat01-fake-subscription-token'

const dirs: string[] = []
const runtimes: DriverRuntime[] = []
// The SDK's settings resolver (run before each key-entry turn) reads Claude's config dir: never the real one.
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir('mousse-claude-config-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) runtime.stop()
  // The driver stops an instance's service a microtask after its last runtime.
  await Promise.resolve()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A `claude` whose `--version` prints a version (a node script; an npm-style shim on Windows). */
function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, `#!/usr/bin/env node\nconsole.log('2.1.300 (Claude Code)')\n`)
  if (process.platform === 'win32') {
    const shim = join(dir, 'claude.cmd')
    writeFileSync(shim, `@ECHO off\r\n"%~dp0\\node_modules\\claude\\cli.js" %*\r\n`)
    return shim
  }
  chmodSync(script, 0o755)
  return script
}

/** A session whose secret prompt answers `answer`. */
function session(id: string, answer: string): LoginSession {
  const login = new LoginSession(id)
  vi.spyOn(login, 'createAuthCallbacks').mockReturnValue({ prompt: async () => answer } as never)
  return login
}

/** What a Claude Code process of the entry was started with. */
type Seen = { path: string; env: NodeJS.ProcessEnv; settingSources?: string[]; extraArgs?: Record<string, unknown>; settings?: unknown }

/**
 * A Claude query that records its options. Model discovery lists nothing; a turn ends at once, or
 * with `hold` stays open (a warm process with work in it) until it is closed.
 */
function recordingQuery(seen: Seen[], state: { hold?: boolean; closed?: number } = {}) {
  return (input: { options: { env?: NodeJS.ProcessEnv; tools?: unknown[]; settingSources?: string[]; extraArgs?: Record<string, unknown>; settings?: unknown } }) => {
    const discovery = Array.isArray(input.options.tools) && !input.options.tools.length
    seen.push({
      path: discovery ? 'models' : 'turn',
      env: { ...input.options.env },
      ...(input.options.settingSources ? { settingSources: [...input.options.settingSources] } : {}),
      ...(input.options.extraArgs ? { extraArgs: { ...input.options.extraArgs } } : {}),
      ...(input.options.settings ? { settings: input.options.settings } : {})
    })
    if (discovery) return Object.assign((async function* () {})(), { close: () => {}, interrupt: async () => {}, supportedModels: async () => [] })
    let release = () => {}
    const closed = new Promise<void>((resolve) => (release = resolve))
    return Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's-1' }
      if (state.hold) await closed
      else yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-1' }
    })(), {
      close: () => {
        state.closed = (state.closed ?? 0) + 1
        release()
      },
      interrupt: async () => release()
    })
  }
}

interface FixtureOptions {
  base?: NodeJS.ProcessEnv
  /** The entry's own variables and launch arguments. */
  config?: Partial<InstanceConfig>
  integrationEnv?: Record<string, string>
  check?: ClaudeApiKeyChecker
  builtIn?: boolean
  /** Without a home of its own (a config stored by hand or by an older build). */
  noHome?: boolean
  hold?: boolean
  /** A live fake Claude Code process per query, instead of the recorder. */
  cli?: FakeClaudeCli
  /** The SDK settings resolver (default: the real one). */
  resolveSettings?: SettingsResolver
}

/** One driver (so one service per instance, as in the app) and the runtimes a config change builds. */
function fixture(options: FixtureOptions = {}) {
  const root = tempDir('mousse-claude-api-')
  const stateDir = join(root, 'state')
  const home = join(stateDir, 'home')
  const seen: Seen[] = []
  const authRuns: string[][] = []
  const query = { hold: options.hold ?? false, closed: 0 }
  const checks: Array<{ apiKey: string; baseUrl: string }> = []
  const flags = { signedOut: false }
  const changed = vi.fn()
  const instanceId = options.builtIn ? 'claude' : 'claude:api'
  const services: ClaudeSubscriptionProviderService[] = []
  const driver: HarnessDriver = claudeCodeDriver({
    ...(options.resolveSettings ? { resolveSettings: options.resolveSettings } : {}),
    integrations: () => ({ resolve: async () => ({ mcpServers: {}, proxiedServers: {}, env: { ...options.integrationEnv }, toolRules: {}, warnings: [] }) }),
    checkApiKey: async (input) => {
      checks.push({ apiKey: input.apiKey, baseUrl: input.baseUrl })
      return options.check ? options.check(input) : 'accepted'
    },
    createService: (ctx, serviceOptions) => {
      const created = new ClaudeSubscriptionProviderService(ctx.profileHome, ctx.questions, {
      ...serviceOptions,
      runAuth: async (_binary, args, runEnv) => {
        authRuns.push(args)
        seen.push({ path: 'auth', env: { ...runEnv } })
        return JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
      },
      versions: { version: async () => '2.1.300' } as never,
      query: (options.cli ? options.cli.query : recordingQuery(seen, query)) as never
      })
      services.push(created)
      return created
    }
  })
  const privateHome = !options.builtIn && !options.noHome
  let revision = 0
  /** The runtime of the entry with `patch` applied to its config (a configure builds a new one). */
  const runtimeFor = (patch: Partial<InstanceConfig> = {}): DriverRuntime => {
    const config: InstanceConfig = {
      home: privateHome ? 'private' : 'default',
      loginMethod: 'api_key',
      displayName: 'Claude Code (API key)',
      binaryPath: process.execPath,
      ...options.config,
      ...patch
    }
    const context: DriverContext = {
      instanceId,
      builtIn: options.builtIn ?? false,
      config,
      env: instanceEnv({ instanceId, driver: 'claude', configRevision: revision++, ...(privateHome ? { home } : {}), searchPath: [], base: { PATH: process.env.PATH, ...options.base } }),
      profileHome: root,
      installationHome: root,
      stateDir,
      questions: new UserQuestionService(),
      findBinary: () => process.execPath,
      changed,
      signedOut: () => flags.signedOut,
      saveLaunch: async () => {}
    }
    const runtime = driver.create(context)
    runtimes.push(runtime)
    return runtime
  }
  return { runtime: runtimeFor(), runtimeFor, home, stateDir, seen, authRuns, checks, changed, query, flags, service: () => services.at(-1)! }
}

function turn(runtime: DriverRuntime, cwd: string, threadId = 't') {
  return runtime.adapter.startTurn(
    {
      runId: `r-${threadId}`, attemptId: `a-${threadId}`, threadId, cwd, instanceId: 'claude:api', model: 'sonnet', llmProvider: 'claude-subscription', modelPinned: true,
      mode: 'agent', prompt: 'hello', messages: [], nativeHistory: '', signal: new AbortController().signal
    } as never,
    { text: () => {}, thinking: () => {}, tool: () => {}, nativeMessages: () => {}, compaction: () => {}, retry: () => {}, progress: () => {}, usage: () => {}, providerRef: () => {}, steerAccepted: () => {}, providerMetrics: () => {}, lineEdits: () => {} } as never,
    { drainSteer: () => undefined, heartbeat: () => {} } as never,
    { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: () => '' } } as never
  )
}

const turnEnv = (seen: Seen[]) => seen.filter((entry) => entry.path === 'turn').at(-1)?.env

/**
 * Sign-in and route variables of the shipped Claude Code (`claudeEnv` test), planted with values
 * that must never reach a process of a key entry.
 */
const PLANTED: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-planted',
  ANTHROPIC_AUTH_TOKEN: 'planted-bearer',
  ANTHROPIC_BASE_URL: 'https://third-party.example/anthropic',
  ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer planted',
  ANTHROPIC_UNIX_SOCKET: '/tmp/planted.sock',
  ANTHROPIC_PROFILE: 'planted',
  ANTHROPIC_CONFIG_DIR: '/tmp/planted-config',
  ANTHROPIC_IDENTITY_TOKEN: 'planted',
  ANTHROPIC_IDENTITY_TOKEN_FILE: '/tmp/planted-token',
  ANTHROPIC_FEDERATION_RULE_ID: 'planted',
  ANTHROPIC_ORGANIZATION_ID: 'planted',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-planted',
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'sk-ant-ort01-planted',
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '4',
  CLAUDE_CODE_GATEWAY_TOKEN: 'planted',
  CLAUDE_CODE_USE_GATEWAY: '1',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
  CLAUDE_CODE_USE_MANTLE: '1',
  CLAUDE_CODE_HOST_CREDS_FILE: '/tmp/planted-creds',
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  CLAUDE_CONFIG_DIR: '/tmp/planted-home'
}

describe('the claude:api id', () => {
  it('takes an explicit slug over the display name, then numbers it', () => {
    expect(addedInstanceId('claude', 'Claude Code (API key)', [], 'api')).toBe('claude:api')
    expect(addedInstanceId('claude', 'Claude Code (API key)', ['claude:api'], 'api')).toBe('claude:api-2')
    expect(addedInstanceId('claude', 'Work', ['claude:api'])).toBe('claude:work')
  })

  it('the protocol takes a slug only in id form', () => {
    expect(asAddInstanceInput({ driver: 'claude', slug: 'api', config: { loginMethod: 'api_key' } })).toEqual({ driver: 'claude', slug: 'api', config: { loginMethod: 'api_key' } })
    expect(() => asAddInstanceInput({ driver: 'claude', slug: 'API key' })).toThrow(/slug/)
    expect(() => asAddInstanceInput({ driver: 'claude', slug: '-api' })).toThrow(/slug/)
  })

  it("is added with a home of its own, never as the user's own Claude Code, and keeps its sign-in", async () => {
    const profileHome = tempDir('mousse-claude-api-gw-')
    const binary = fakeClaude()
    const questions = new UserQuestionService()
    let stored: unknown = { claude: { driver: 'claude', enabled: true, config: { binaryPath: binary } } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: instances,
      questions,
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [claudeCodeDriver({
        checkApiKey: async () => 'accepted',
        createService: (context, options) => new ClaudeSubscriptionProviderService(context.profileHome, questions, {
          ...options,
          runAuth: async () => JSON.stringify({ loggedIn: false }),
          query: recordingQuery([]) as never
        })
      })]
    })
    try {
      // The user's own Claude Code never becomes a key entry.
      await expect(harness.instances.configure('claude', { loginMethod: 'api_key' })).rejects.toMatchObject({ code: 'unsupported' })
      const config = { displayName: 'Claude Code (API key)', loginMethod: 'api_key', home: 'default' as const, binaryPath: binary }
      const first = await harness.instances.add({ driver: 'claude', slug: 'api', config })
      const second = await harness.instances.add({ driver: 'claude', slug: 'api', config })
      expect([first.instanceId, second.instanceId]).toEqual(['claude:api', 'claude:api-2'])
      // Asked for the default home, it still gets its own: the user's setup is never the key entry's.
      expect(first.config).toMatchObject({ home: 'private', loginMethod: 'api_key' })
      expect((stored as Record<string, { config?: Record<string, unknown> }>)['claude:api']?.config).toMatchObject({ home: 'private', loginMethod: 'api_key' })
      await expect(harness.instances.configure('claude:api', { loginMethod: null })).rejects.toMatchObject({ code: 'unsupported' })
      await expect(harness.instances.configure('claude:api', { home: 'default' })).rejects.toMatchObject({ code: 'unsupported' })
      // No key yet: signed out with nothing to run in a terminal.
      const snapshot = await harness.instances.recheck('claude:api')
      expect(snapshot.auth).toMatchObject({ state: 'signed_out', methodLabel: 'API key' })
      expect(snapshot.nextStep?.command).toBeUndefined()
    } finally {
      harness.stop()
    }
  }, 30_000)
})

describe('Claude Code on an API key', () => {
  it('is signed out without a key, with a secret prompt and no terminal command', async () => {
    const { runtime, authRuns } = fixture()
    const reading = await runtime.auth({ force: false })
    expect(reading).toMatchObject({ state: 'signed_out', methodLabel: 'API key', canSignIn: true })
    expect(reading.signInCommand).toBeUndefined()
    expect(runtime.configured()).toBe(false)
    expect(await runtime.identity!(new AbortController().signal)).toBeUndefined()
    // Claude Code's own `claude auth` never runs for a key entry.
    expect(authRuns).toEqual([])
  })

  it('signs in with a pasted key kept in its vault, and is signed in as "API key"', async () => {
    const { runtime, stateDir, changed } = fixture()
    expect(await runtime.signIn!(session('l1', `  ${KEY}  `), '/tmp')).toMatchObject({ success: true })
    expect(changed).toHaveBeenCalled()
    const reading = await runtime.auth({ force: false })
    expect(reading).toMatchObject({ state: 'signed_in', methodLabel: 'API key', credential: 'api_key', ownedByMousse: true })
    expect(runtime.configured()).toBe(true)
    // The identity is a keyed hash: stable, never the key, and another key is another account.
    const identity = await runtime.identity!(new AbortController().signal)
    expect(identity).toBe(claudeApiKeySubject(KEY))
    expect(identity).toMatch(/^apikey:[0-9a-f]{64}$/)
    expect(identity).not.toContain(KEY)
    expect(reading.subject).toBe(identity)
    expect(claudeApiKeySubject(OTHER_KEY)).not.toBe(identity)
    // Kept in the entry's vault (secrets.json); never in what the page is told.
    expect(existsSync(join(stateDir, 'secrets.json'))).toBe(true)
    expect(JSON.stringify(reading)).not.toContain(KEY)
  })

  it('refuses a Claude subscription token as a key, by prompt or by a move', async () => {
    const { runtime } = fixture()
    const result = await runtime.signIn!(session('l2', SUBSCRIPTION_TOKEN), '/tmp')
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/subscription token/) })
    await expect(runtime.adoptApiKey!(SUBSCRIPTION_TOKEN)).rejects.toThrow(/subscription token/)
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out' })
  })

  for (const where of ['inherited', 'entry', 'mcp'] as const) {
    it(`drops every sign-in and route variable of Claude Code planted in the ${where} variables, and the key, home and settings win`, async () => {
      const kept = { MY_SETTING: 'kept', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' }
      const planted = { ...PLANTED, ...kept }
      const { runtime, home, seen, authRuns } = fixture({
        ...(where === 'inherited' ? { base: planted } : {}),
        ...(where === 'entry' ? { config: { env: planted, args: ['--settings', '/tmp/planted-settings.json', '--setting-sources', 'user'] } } : {}),
        ...(where === 'mcp' ? { integrationEnv: planted } : {})
      })
      await runtime.adoptApiKey!(KEY)
      await runtime.auth({ force: false })
      await runtime.refreshModels!(tempDir('mousse-cwd-'))
      await turn(runtime, tempDir('mousse-cwd-'))
      expect(seen.map((entry) => entry.path)).toEqual(expect.arrayContaining(['models', 'turn']))
      for (const entry of seen) {
        const names = Object.keys(entry.env).map((name) => name.toUpperCase())
        expect(entry.env.ANTHROPIC_API_KEY, entry.path).toBe(KEY)
        expect(names.filter((name) => name === 'ANTHROPIC_API_KEY'), entry.path).toHaveLength(1)
        for (const name of Object.keys(PLANTED).filter((name) => name !== 'ANTHROPIC_API_KEY' && name !== 'CLAUDE_CONFIG_DIR' && name !== 'ANTHROPIC_BASE_URL'))
          expect(names, `${entry.path} ${name}`).not.toContain(name)
        // Only an address set on the entry itself is honoured.
        expect(entry.env.ANTHROPIC_BASE_URL, entry.path).toBe(where === 'entry' ? PLANTED.ANTHROPIC_BASE_URL : undefined)
        // The home is the entry's own, whatever the variables said; no address from them is used.
        expect(entry.env.CLAUDE_CONFIG_DIR, entry.path).toBe(home)
        expect(names.filter((name) => name === 'CLAUDE_CONFIG_DIR'), entry.path).toHaveLength(1)
        // Settings in the Mousse-owned home are not loaded, and launch arguments cannot load others.
        expect(entry.settingSources, entry.path).toEqual(['project', 'local'])
        expect(Object.keys(entry.extraArgs ?? {}), entry.path).not.toEqual(expect.arrayContaining(['settings']))
        expect(Object.keys(entry.extraArgs ?? {}), entry.path).not.toEqual(expect.arrayContaining(['setting-sources']))
      }
      // The entry's own tuning is kept; an entry with its own home inherits none of Claude Code's from Mousse.
      if (where === 'entry') for (const entry of seen) expect(entry.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, entry.path).toBe('4000')
      expect(turnEnv(seen)?.MY_SETTING).toBe('kept')
      expect(authRuns).toEqual([])
    })
  }

  it('honours only an address set on the entry itself, for turns, Recheck and the identity', async () => {
    const inherited = fixture({ base: { ANTHROPIC_BASE_URL: 'https://third-party.example/anthropic' } })
    await inherited.runtime.adoptApiKey!(KEY)
    await turn(inherited.runtime, tempDir('mousse-cwd-'))
    expect(turnEnv(inherited.seen)?.ANTHROPIC_BASE_URL).toBeUndefined()
    await inherited.runtime.auth({ force: true })
    expect(inherited.checks).toEqual([{ apiKey: KEY, baseUrl: 'https://api.anthropic.com' }])
    expect(await inherited.runtime.identity!(new AbortController().signal)).toBe(claudeApiKeySubject(KEY))

    const own = fixture({ config: { env: { anthropic_base_url: 'http://127.0.0.1:9/proxy' } } })
    await own.runtime.adoptApiKey!(KEY)
    await turn(own.runtime, tempDir('mousse-cwd-'))
    expect(turnEnv(own.seen)?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9/proxy')
    await own.runtime.auth({ force: true })
    expect(own.checks).toEqual([{ apiKey: KEY, baseUrl: 'http://127.0.0.1:9/proxy' }])
    // The same key through another address is another account.
    const identity = await own.runtime.identity!(new AbortController().signal)
    expect(identity).toMatch(/^apikey:[0-9a-f]{64}\|route:[0-9a-f]{64}$/)
    expect(identity).toBe(claudeApiKeySubject(KEY, 'http://127.0.0.1:9/proxy'))
  })

  it('Recheck: a refused key is signed out, an unreachable API leaves it in use', async () => {
    let answer: 'accepted' | 'refused' | 'offline' = 'accepted'
    const { runtime, checks } = fixture({
      check: async () => {
        if (answer === 'offline') throw new Error('connect ECONNREFUSED')
        return answer
      }
    })
    await runtime.adoptApiKey!(KEY)
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_in' })
    expect(checks).toEqual([])
    expect(await runtime.auth({ force: true })).toMatchObject({ state: 'signed_in' })
    answer = 'refused'
    expect(await runtime.auth({ force: true })).toMatchObject({ state: 'signed_out', canSignIn: true, message: expect.stringMatching(/did not accept/) })
    answer = 'offline'
    const offline = await runtime.auth({ force: true })
    expect(offline).toMatchObject({ state: 'signed_in', message: expect.stringMatching(/could not reach/) })
    expect(offline.message).not.toContain(KEY)
  })

  it('keeps one key store across config changes: a new key or a sign-out reaches the next turn', async () => {
    const { runtime, runtimeFor, seen } = fixture()
    await runtime.adoptApiKey!(KEY)
    // A rename and a variable change build new runtimes over the same service.
    const renamed = runtimeFor({ displayName: 'Work key' })
    runtime.stop()
    const edited = runtimeFor({ displayName: 'Work key', env: { MY_SETTING: 'edited' } })
    renamed.stop()
    await edited.adoptApiKey!(OTHER_KEY)
    await turn(edited, tempDir('mousse-cwd-'), 'after-change')
    expect(turnEnv(seen)).toMatchObject({ ANTHROPIC_API_KEY: OTHER_KEY, MY_SETTING: 'edited' })
    expect(await edited.identity!(new AbortController().signal)).toBe(claudeApiKeySubject(OTHER_KEY))
    await edited.signOut!()
    const next = runtimeFor({ displayName: 'Work key again' })
    edited.stop()
    expect(await next.identity!(new AbortController().signal)).toBeUndefined()
    expect(next.configured()).toBe(false)
    await next.adoptApiKey!(KEY)
    await turn(next, tempDir('mousse-cwd-'), 'after-sign-out')
    expect(turnEnv(seen)?.ANTHROPIC_API_KEY).toBe(KEY)
  })

  it('signing out forgets the key, ends the running turn and the warm process holding it, and never signs Claude Code itself out', async () => {
    const { runtime, authRuns, query, seen } = fixture({ hold: true })
    await runtime.adoptApiKey!(KEY)
    const running = turn(runtime, tempDir('mousse-cwd-')).then(() => 'ended', () => 'ended')
    await vi.waitFor(() => expect(seen.some((entry) => entry.path === 'turn')).toBe(true))
    expect(query.closed).toBe(0)
    await runtime.signOut!()
    expect(query.closed).toBeGreaterThan(0)
    expect(await running).toBe('ended')
    expect(await runtime.auth({ force: false })).toMatchObject({ state: 'signed_out' })
    expect(await runtime.identity!(new AbortController().signal)).toBeUndefined()
    expect(authRuns).toEqual([])
  })

  it('a sign-out whose key cannot be deleted still ends the process holding it, then fails', async () => {
    const { runtime, query, seen } = fixture({ hold: true })
    await runtime.adoptApiKey!(KEY)
    const running = turn(runtime, tempDir('mousse-cwd-')).then(() => 'ended', () => 'ended')
    await vi.waitFor(() => expect(seen.some((entry) => entry.path === 'turn')).toBe(true))
    const write = vi.spyOn(InstanceVault.prototype, 'set').mockImplementation(() => {
      throw new Error('Cannot use the saved secrets: the file could not be written.')
    })
    try {
      await expect(runtime.signOut!()).rejects.toThrow(/could not be written/)
    } finally {
      write.mockRestore()
    }
    expect(query.closed).toBeGreaterThan(0)
    expect(await running).toBe('ended')
  })

  it('an api_key entry without a home of its own runs nothing and never falls back to the user\'s Claude Code', async () => {
    for (const options of [{ noHome: true }, { builtIn: true }] as FixtureOptions[]) {
      const { runtime, seen, authRuns, stateDir } = fixture({ ...options, base: { ANTHROPIC_API_KEY: 'sk-ant-api03-users-own', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-users' } })
      const reading = await runtime.auth({ force: true })
      expect(reading).toMatchObject({ state: 'signed_out', message: expect.stringMatching(/home of its own/) })
      expect(runtime.configured()).toBe(false)
      await expect(runtime.adoptApiKey!(KEY)).rejects.toThrow(/home of its own/)
      expect(await runtime.identity!(new AbortController().signal)).toBeUndefined()
      await expect(turn(runtime, tempDir('mousse-cwd-'))).rejects.toThrow(/home of its own/)
      // Nothing ran on the user's sign-in, and no process would see their home or credentials.
      expect(authRuns).toEqual([])
      for (const entry of seen) {
        expect(entry.env.CLAUDE_CONFIG_DIR).toBe(join(stateDir, 'home'))
        expect(entry.env.ANTHROPIC_API_KEY).toBeUndefined()
      }
    }
  })

  it("the user's own Claude Code runs as they set it up", async () => {
    const { runtime, authRuns } = fixture({ builtIn: true, config: { loginMethod: undefined }, base: { ANTHROPIC_API_KEY: 'sk-ant-api03-users-own' } })
    expect(runtime.adoptApiKey).toBeUndefined()
    const reading = await runtime.auth({ force: true })
    // `claude auth status` decides, with the user's own variables untouched.
    expect(authRuns).toEqual([['auth', 'status']])
    expect(reading).toMatchObject({ state: 'signed_in', methodLabel: 'Claude Code sign-in' })
  })

  it("maps full Claude model ids to Claude Code's family aliases", () => {
    expect(claudeFamilyAlias('claude-sonnet-4-5-20250929')).toBe('sonnet')
    expect(claudeFamilyAlias('claude-opus-4-1')).toBe('opus')
    expect(claudeFamilyAlias('claude-3-5-haiku-latest')).toBe('haiku')
    expect(claudeFamilyAlias('gpt-5')).toBeUndefined()
    expect(claudeFamilyAlias('sonnetish')).toBeUndefined()
  })

  it('the environment helper drops sign-ins in any case and sets nothing for an unusable key', () => {
    expect(claudeApiKeyEnv({ anthropic_auth_token: 'x', Claude_Code_OAuth_Token: 'y', claude_config_dir: '/elsewhere', PATH: '/bin' }, { apiKey: SUBSCRIPTION_TOKEN, home: '/home' }))
      .toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/home' })
    expect(claudeApiKeyEnv({ PATH: '/bin' }, { apiKey: KEY, home: '/home' })).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/home', ANTHROPIC_API_KEY: KEY })
  })
})

describe("a key entry's turn over its folder's Claude Code settings", () => {
  /** A disposable project with `.claude/settings.json` and `.claude/settings.local.json`. */
  function project(settings: Record<string, unknown>, local: Record<string, unknown> = {}): string {
    const dir = tempDir('mousse-claude-project-')
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(settings))
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify(local))
    return dir
  }
  const sdk = async () => (await import('@anthropic-ai/claude-agent-sdk')).resolveSettings
  const label = 'Claude Code (API key)'

  it('pins the address and blanks a token, a provider route and apiKeyHelper set by project and local settings', async () => {
    const cwd = project(
      {
        env: { ANTHROPIC_AUTH_TOKEN: 'project-bearer', ANTHROPIC_BASE_URL: 'https://team-proxy.example', KEEP_ME: 'yes' },
        apiKeyHelper: '/usr/local/bin/print-key',
        permissions: { allow: ['Bash(npm test)'] }
      },
      { env: { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-local' } }
    )
    // The SDK's own resolver, offline: what Claude Code would merge in this folder.
    const resolved = await (await sdk())({ cwd, settingSources: ['project', 'local'] })
    const project_ = resolved.sources.find((source) => source.source === 'project')
    expect(project_?.settings).toMatchObject({ apiKeyHelper: '/usr/local/bin/print-key', env: { ANTHROPIC_AUTH_TOKEN: 'project-bearer' } })
    const result = claudeKeyTurnSettings(resolved, { label })
    // The flag tier ranks above project and local settings, so each of these values wins there.
    expect(result).toEqual({
      settings: {
        env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
        apiKeyHelper: ''
      }
    })
    // Nothing else of the project is touched (permissions, hooks, MCP, CLAUDE.md), nor any other variable.
    expect(Object.keys(result.settings!)).toEqual(['env', 'apiKeyHelper'])
    expect(result.settings!.env).not.toHaveProperty('KEEP_ME')
    // The entry's own address is the one pinned when it sets one.
    expect(claudeKeyTurnSettings(resolved, { label, baseUrl: 'http://127.0.0.1:9/own' }).settings?.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:9/own')
  })

  it('refuses a folder whose settings set the key itself or a credential the flag tier cannot blank', async () => {
    for (const [settings, local, named] of [
      [{ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-project' } }, {}, 'ANTHROPIC_API_KEY'],
      [{}, { env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3' } }, 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'],
      [{ env: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer x' } }, {}, 'ANTHROPIC_CUSTOM_HEADERS']
    ] as const) {
      const resolved = await (await sdk())({ cwd: project(settings, local), settingSources: ['project', 'local'] })
      const result = claudeKeyTurnSettings(resolved, { label })
      expect(result.refuse, named).toMatch(new RegExp(`set ${named}, so Claude Code \\(API key\\) cannot run on its API key here`))
      expect(result.settings).toBeUndefined()
    }
  })

  it('refuses a sign-in or route set by managed policy, which outranks the flag tier; policy for claude.ai sign-ins never applies', () => {
    const managed = { sources: [{ source: 'managed' as const, policyOrigin: 'file' as const, settings: { env: { ANTHROPIC_BASE_URL: 'https://corp-gateway.example' } } }] }
    expect(claudeKeyTurnSettings(managed, { label }).refuse).toMatch(/organization's Claude Code policy sets ANTHROPIC_BASE_URL/)
    const helper = { sources: [{ source: 'managed' as const, policyOrigin: 'hklm' as const, settings: { apiKeyHelper: 'corp-helper' } }] }
    expect(claudeKeyTurnSettings(helper, { label }).refuse).toMatch(/policy sets apiKeyHelper/)
    const remote = { sources: [{ source: 'managed' as const, policyOrigin: 'remote' as const, settings: { env: { ANTHROPIC_AUTH_TOKEN: 'x' } } }] }
    expect(claudeKeyTurnSettings(remote, { label })).toEqual({})
    expect(claudeKeyTurnSettings({ sources: [] }, { label })).toEqual({})
  })

  it('refuses a key turn under a managed policy helper, whose settings no offline read can see, before Claude Code starts', async () => {
    const helper = { sources: [{ source: 'managed' as const, policyOrigin: 'file' as const, settings: { policyHelper: { path: '/opt/corp/claude-policy' } } }] }
    expect(claudeKeyTurnSettings(helper, { label }).refuse).toContain('policy runs a policy helper (/opt/corp/claude-policy) that sets its settings when Claude Code starts')
    // The per-platform form, with static defaults or not, is refused the same way.
    const perPlatform = { sources: [{ source: 'managed' as const, policyOrigin: 'hklm' as const, settings: { policyHelpers: { windows: { defaultSettings: { env: { ANTHROPIC_BASE_URL: 'https://corp-gateway.example' } } } } } as never }] }
    expect(claudeKeyTurnSettings(perPlatform, { label }).refuse).toMatch(/policy runs a policy helper that sets its settings/)
    // A helper in project settings is not honoured by Claude Code there, and does not refuse.
    expect(claudeKeyTurnSettings({ sources: [{ source: 'project' as const, settings: { policyHelper: { path: '/x' } } }] }, { label })).toEqual({})
    // Through the entry: the turn is refused, and no Claude Code starts (nothing is sent).
    const { runtime, seen } = fixture({ resolveSettings: async () => helper })
    await runtime.adoptApiKey!(KEY)
    await expect(turn(runtime, tempDir('mousse-cwd-'))).rejects.toThrow(/policy helper/)
    expect(seen.filter((entry) => entry.path === 'turn')).toEqual([])
  })

  it('a turn starts with the pins in the folder, and a refused folder starts no Claude Code', async () => {
    const { runtime, seen } = fixture()
    await runtime.adoptApiKey!(KEY)
    await turn(runtime, project({ env: { ANTHROPIC_AUTH_TOKEN: 'project-bearer' } }))
    const started = seen.filter((entry) => entry.path === 'turn')
    expect(started).toHaveLength(1)
    expect(started[0]!.settings).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: '' } })
    // The key never goes in the flag tier (it is passed on the command line).
    expect(JSON.stringify(started[0]!.settings)).not.toContain(KEY)
    await expect(turn(runtime, project({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-project' } }), 't2')).rejects.toThrow(/cannot run on its API key here/)
    // Zero queries: no Claude Code started, so nothing was sent.
    expect(seen.filter((entry) => entry.path === 'turn')).toHaveLength(1)
    // A folder with no such settings gets no flag tier at all.
    await turn(runtime, tempDir('mousse-cwd-'), 't3')
    expect(seen.filter((entry) => entry.path === 'turn').at(-1)?.settings).toBeUndefined()
  })
})

describe('signing a key entry out when saving fails', () => {
  /** A completed turn whose process keeps a background helper running. */
  async function withHelper() {
    const cli = new FakeClaudeCli()
    cli.reply = (message, claude) => {
      claude.emit(roster({ id: 'bash-1' }))
      claude.answer(String(message.uuid), 'started')
    }
    const entry = fixture({ cli })
    await entry.runtime.adoptApiKey!(KEY)
    await turn(entry.runtime, tempDir('mousse-cwd-'))
    expect(entry.service().hasBackgroundWork('t')).toBe(true)
    expect(cli.last.closed).toBe(false)
    return { ...entry, cli }
  }
  /** A turn still running in its process. */
  async function running() {
    const cli = new FakeClaudeCli()
    cli.reply = null as never
    const entry = fixture({ cli })
    await entry.runtime.adoptApiKey!(KEY)
    const turnDone = turn(entry.runtime, tempDir('mousse-cwd-')).then(() => 'ended', () => 'ended')
    // The turn's own process (model discovery starts one that reads nothing).
    await vi.waitFor(() => expect(cli.processes.some((process) => process.inputs.length > 0)).toBe(true))
    return { ...entry, cli, turnDone, process: cli.processes.find((process) => process.inputs.length > 0)! }
  }
  const failures = {
    'the key cannot be deleted': () => vi.spyOn(InstanceVault.prototype, 'set').mockImplementation(() => {
      throw new Error('Cannot use the saved secrets: the file could not be written.')
    }),
    "the entry's settings cannot be saved": (service: ClaudeSubscriptionProviderService) => vi.spyOn(service as unknown as { save(): void }, 'save').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, rename settings.json')
    })
  }

  for (const [what, fail] of Object.entries(failures)) {
    it(`ends a completed turn's process and its background helper when ${what}, then reports it`, async () => {
      const { runtime, cli, service, flags } = await withHelper()
      // As the gateway signs out: its flag first, then the runtime.
      flags.signedOut = true
      const spy = fail(service())
      try {
        await expect(runtime.signOut!()).rejects.toThrow(/could not be written|EPERM/)
      } finally {
        spy.mockRestore()
      }
      expect(cli.last.closed).toBe(true)
      expect(service().hasBackgroundWork('t')).toBe(false)
      expect(service().liveThreadIds()).toEqual([])
    })

    it(`ends a running turn when ${what}, then reports it`, async () => {
      const { runtime, process, turnDone, service, flags } = await running()
      flags.signedOut = true
      const spy = fail(service())
      try {
        await expect(runtime.signOut!()).rejects.toThrow(/could not be written|EPERM/)
      } finally {
        spy.mockRestore()
      }
      expect(process.closed).toBe(true)
      expect(await turnDone).toBe('ended')
    })
  }
})

describe('a key sign-in across a sign-out, through the gateway', () => {
  async function gateway() {
    const profileHome = tempDir('mousse-claude-api-signin-')
    const binary = fakeClaude()
    const questions = new UserQuestionService()
    let stored: Record<string, { config?: Record<string, unknown> }> = {
      'claude:api': { driver: 'claude', enabled: true, config: { home: 'private', loginMethod: 'api_key', displayName: 'Claude Code (API key)', binaryPath: binary } } as never
    }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances as typeof stored } } })
    let service: ClaudeSubscriptionProviderService | undefined
    const harness = createHarnessGateway({
      profileHome,
      installationHome: profileHome,
      instanceMap: instances,
      questions,
      shellPath: async () => ({ entries: [], source: 'failed' }),
      drivers: [claudeCodeDriver({
        checkApiKey: async () => 'accepted',
        createService: (context, options) => (service = new ClaudeSubscriptionProviderService(context.profileHome, questions, { ...options, query: recordingQuery([]) as never }))
      })]
    })
    const events: HarnessGatewayEvent[] = []
    harness.instances.subscribe((event) => events.push(event))
    const phase = (operationId: string, wanted: string) => events.find((event) => event.type === 'operation' && event.data.operationId === operationId && event.data.phase === wanted)
    /** Starts a key sign-in and waits for its prompt. */
    const start = async () => {
      const started = await harness.instances.signIn('claude:api')
      await vi.waitFor(() => expect(phase(started.operationId, 'prompt')).toBeTruthy())
      const prompt = phase(started.operationId, 'prompt')!
      const promptId = prompt.type === 'operation' && prompt.data.phase === 'prompt' ? prompt.data.prompt.promptId : ''
      return { operationId: started.operationId, answer: (value: string) => harness.instances.respondSignIn(started.operationId, { promptId, kind: 'input', value }) }
    }
    const signedOutFlag = () => stored['claude:api']?.config?.signedOutInMousse === true
    // Signed in with a first key.
    const first = await start()
    expect(await first.answer(KEY)).toBe(true)
    await vi.waitFor(() => expect(phase(first.operationId, 'completed')).toBeTruthy())
    return { harness, phase, start, signedOutFlag, service: () => service!, stop: () => harness.stop() }
  }

  it('a prompt still waiting is cancelled by the sign-out, and a late answer changes nothing', async () => {
    const { harness, phase, start, signedOutFlag, stop } = await gateway()
    try {
      const pending = await start()
      await harness.instances.signOut('claude:api')
      expect(signedOutFlag()).toBe(true)
      await vi.waitFor(() => expect(phase(pending.operationId, 'cancelled')).toBeTruthy())
      expect(await pending.answer(OTHER_KEY)).toBe(false)
      expect(phase(pending.operationId, 'completed')).toBeUndefined()
      expect(signedOutFlag()).toBe(true)
      expect((await harness.instances.recheck('claude:api')).auth).toMatchObject({ state: 'signed_out' })
    } finally {
      stop()
    }
  }, 30_000)

  it('an answer already submitted and still saving when the sign-out lands saves no key and leaves the entry signed out', async () => {
    const { harness, phase, start, signedOutFlag, service, stop } = await gateway()
    try {
      const pending = await start()
      // The sign-in's save waits here, after its key is written, until the sign-out is done.
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const status = service().status.bind(service())
      let held = false
      vi.spyOn(service(), 'status').mockImplementation(async (options) => {
        if (!held && options?.force) {
          held = true
          await gate
        }
        return status(options)
      })
      expect(await pending.answer(OTHER_KEY)).toBe(true)
      await vi.waitFor(() => expect(held).toBe(true))
      await harness.instances.signOut('claude:api')
      release()
      await vi.waitFor(() => expect(phase(pending.operationId, 'cancelled') ?? phase(pending.operationId, 'failed')).toBeTruthy())
      expect(phase(pending.operationId, 'completed')).toBeUndefined()
      // The older sign-in neither kept its key nor cleared the newer sign-out.
      expect(signedOutFlag()).toBe(true)
      expect((await harness.instances.recheck('claude:api')).auth).toMatchObject({ state: 'signed_out' })
    } finally {
      stop()
    }
  }, 30_000)
})

describe('the models.list key check', () => {
  /** A loopback recorder answering each request with the next status. */
  async function recorder(statuses: number[]) {
    const requests: Array<{ url: string; headers: IncomingHttpHeaders }> = []
    const server = createServer((request, response) => {
      requests.push({ url: request.url ?? '', headers: request.headers })
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)]!
      response.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'true' })
      response.end(status === 200 ? JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }) : JSON.stringify({ type: 'error', error: { type: 'error', message: 'recorded' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { requests, baseUrl, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  it('sends the key alone, once, and reads 401/403 as refused and anything else as unknown', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'mousse-process-bearer')
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'Authorization: Bearer from-headers\nx-api-key: from-headers')
    try {
      for (const [status, expected] of [[200, 'accepted'], [401, 'refused'], [403, 'refused'], [500, 'throws'], [503, 'throws'], [429, 'throws']] as const) {
        const server = await recorder([status])
        try {
          const result = checkClaudeApiKey({ apiKey: KEY, baseUrl: server.baseUrl })
          if (expected === 'throws') await expect(result).rejects.toThrow()
          else expect(await result).toBe(expected)
          // One request (no SDK retry), carrying only the key.
          expect(server.requests, String(status)).toHaveLength(1)
          const headers = server.requests[0]!.headers
          expect(headers['x-api-key']).toBe(KEY)
          expect(headers.authorization).toBeUndefined()
          expect(server.requests[0]!.url).toMatch(/^\/v1\/models/)
        } finally {
          await server.close()
        }
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
