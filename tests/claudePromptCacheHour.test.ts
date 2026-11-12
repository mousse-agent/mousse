/**
 * Claude Code keeps the prompt cache for an hour (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h`) on a confirmed
 * subscription: its own sign-in, or a local proxy whose listing shows only subscription seats. An
 * unconfirmed route is off until the user turns it on; anything paid per token never gets it; a
 * lifetime the user's own settings or environment choose is left alone; subagents are untouched.
 * No real Claude Code, account or proxy: `claude auth status`, the query and the proxy are fakes.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promptCacheHourOn } from '../src/shared/harness/status'
import { decodeInstanceConfig } from '../src/mms/harness/driver'
import { asInstanceConfigPatch } from '../src/mms/protocol/validators'
import { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { claudeProxyAccounts, proxySeats, readLocalProxySeats, resetLocalProxyDetection, type ProxyFetch } from '../src/mms/harness/vendors/claude/localProxyUsage'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Variables of this machine that would decide the route: never read from the test runner's environment. */
const ROUTE = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_PROMPT_CACHE_TTL', 'ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'CLIPROXY_MANAGEMENT_KEY', 'CLI_PROXY_API_MANAGEMENT_KEY', 'MANAGEMENT_PASSWORD']
let configDir: string
beforeEach(() => {
  for (const name of ROUTE) vi.stubEnv(name, undefined)
  configDir = tempDir('mousse-cache-config-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
  resetLocalProxyDetection()
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeQuery(): Query {
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-1' }
  return Object.assign((async function* () { yield result })(), { close: () => {}, interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query
}

/** A listing a local CLIProxyAPI gives, by `account_type` of each Claude seat. */
function proxyFetch(kinds: string[] | 'no-key' = []): { fetch: ProxyFetch; calls: string[] } {
  const calls: string[] = []
  const fetch: ProxyFetch = async (url) => {
    calls.push(url)
    const path = new URL(url).pathname
    const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) })
    if (path === '/') return reply(200, { message: 'CLI Proxy API Server' })
    if (path === '/v8/management/credentials')
      return reply(200, { files: Array.isArray(kinds) ? kinds.map((kind, index) => ({ id: `c${index}`, provider: 'claude', account_type: kind, auth_index: `i${index}` })) : [] })
    return reply(404, {})
  }
  return { fetch, calls }
}

function service(options: { authMethod?: string; env?: Record<string, string>; proxy?: ProxyFetch; paysPerToken?: boolean } = {}) {
  const home = tempDir('mousse-cache-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const turns: Options[] = []
  const created = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: options.authMethod ?? 'claude.ai', apiProvider: 'firstParty' }),
    query: ({ options: started }: { options: Options }) => {
      turns.push(started)
      return fakeQuery()
    },
    launchConfig: () => ({ binaryPath: binary, ...(options.env ? { env: options.env } : {}) }),
    ...(options.proxy ? { proxySeats: (proxyOptions) => readLocalProxySeats({ ...proxyOptions, fetch: options.proxy! }) } : {}),
    ...(options.paysPerToken ? { paysPerToken: true } : {})
  })
  let thread = 0
  const turn = async (choice?: boolean, cwd = home) => {
    await created.chat({ threadId: `t${thread++}`, cwd, model: 'sonnet', prompt: 'hi', onText: () => {}, ...(choice !== undefined ? { promptCacheHour: choice } : {}) })
    return turns.at(-1)!.env!
  }
  return { service: created, turn, home }
}

const PROXY = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'proxy-token', CLIPROXY_MANAGEMENT_KEY: 'management' }

describe('a confirmed subscription keeps the cache for an hour', () => {
  it("Claude Code's own subscription sign-in: on, and the subagent lifetime is left alone", async () => {
    const { service: claude, turn } = service()
    await claude.status()
    expect(claude.promptCacheHour()).toEqual({ basis: 'subscription', on: true })
    const env = await turn()
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
    expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')
    expect(env).not.toHaveProperty('ENABLE_PROMPT_CACHING_1H')
  })

  it('a local proxy whose listing shows only OAuth seats: on (one listing, read before the turn)', async () => {
    const { fetch, calls } = proxyFetch(['oauth', 'oauth'])
    const { service: claude, turn } = service({ authMethod: 'oauth_token', env: PROXY, proxy: fetch })
    expect((await turn()).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
    expect(claude.promptCacheHour().basis).toBe('subscription')
    // The listing stands for half an hour: the next turn asks nothing.
    await turn()
    expect(calls.filter((url) => url.includes('/credentials'))).toHaveLength(1)
  })

  it('the user turning it off wins', async () => {
    const { service: claude, turn } = service()
    await claude.status()
    expect(claude.promptCacheHour(undefined, undefined, false)).toEqual({ basis: 'subscription', choice: false, on: false })
    expect(await turn(false)).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
  })
})

describe('anything unconfirmed is off until the user turns it on', () => {
  it('a proxy that lists no seats (no management key): off; the user can turn it on', async () => {
    const { fetch, calls } = proxyFetch(['oauth'])
    const { service: claude, turn } = service({ authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: PROXY.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: 'proxy-token' }, proxy: fetch })
    expect(await turn()).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect(claude.promptCacheHour()).toEqual({ basis: 'unconfirmed', on: false })
    expect(calls.some((url) => url.includes('/credentials'))).toBe(false)
    expect((await turn(true)).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
  })

  it('a proxy listing mixed or unnamed seats, and a gateway Mousse cannot list: off', async () => {
    for (const kinds of [['oauth', 'api_key'], ['oauth', '']]) {
      resetLocalProxyDetection()
      const { turn, service: claude } = service({ authMethod: 'oauth_token', env: PROXY, proxy: proxyFetch(kinds).fetch })
      expect(await turn(), kinds.join()).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
      expect(claude.promptCacheHour().basis).toBe('unconfirmed')
    }
    const gateway = service({ authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic', ANTHROPIC_AUTH_TOKEN: 't' } })
    expect(await gateway.turn()).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect(gateway.service.promptCacheHour().basis).toBe('unconfirmed')
  })

  it('an ANTHROPIC_AUTH_TOKEN Claude Code reports as an OAuth token is not proof of a subscription', async () => {
    const { service: claude, turn } = service({ authMethod: 'oauth_token', env: { ANTHROPIC_AUTH_TOKEN: 'bearer' } })
    expect(await turn()).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect(claude.promptCacheHour().basis).toBe('unconfirmed')
  })
})

describe('what pays per token never keeps it for an hour', () => {
  it('a proxy listing only API keys, an API-key sign-in, a cloud route, an API-key entry: never, even when chosen', async () => {
    const cases = [
      service({ authMethod: 'oauth_token', env: PROXY, proxy: proxyFetch(['api_key', 'api_key']).fetch }),
      service({ authMethod: 'api_key' }),
      service({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-x' } }),
      service({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }),
      service({ paysPerToken: true })
    ]
    for (const [index, entry] of cases.entries()) {
      await entry.service.status()
      expect(await entry.turn(true), `case ${index}`).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
      expect(entry.service.promptCacheHour(undefined, undefined, true), `case ${index}`).toEqual({ basis: 'per_token', choice: true, on: false })
    }
  })
})

describe("the user's own choice of lifetime is left alone", () => {
  it('their environment, their Claude settings, or the project settings: Mousse sets nothing', async () => {
    const fromEnv = service({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
    await fromEnv.service.status()
    expect(fromEnv.service.promptCacheHour()).toEqual({ basis: 'subscription', userSetting: true, on: false })
    expect((await fromEnv.turn(true)).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('5m')

    const flag = service({ env: { ENABLE_PROMPT_CACHING_1H: '0' } })
    expect(await flag.turn()).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')

    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ promptCacheTtl: '5m' }))
    const fromSettings = service()
    expect(await fromSettings.turn()).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
    rmSync(join(configDir, 'settings.json'))

    const project = tempDir('mousse-cache-project-')
    mkdirSync(join(project, '.claude'))
    writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } }))
    const inProject = service()
    expect(await inProject.turn(undefined, project)).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL')
    expect((await inProject.turn()).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
  })
})

describe('the parts', () => {
  it('reads seats from a listing: disabled ones serve nothing', () => {
    const accounts = claudeProxyAccounts({ files: [
      { id: 'a', provider: 'claude', account_type: 'oauth', auth_index: '1' },
      { id: 'b', provider: 'claude', account_type: 'api_key', auth_index: '2', disabled: true }
    ] })
    expect(accounts.map((account) => account.oauth)).toEqual([true, undefined])
    expect(proxySeats(accounts)).toBe('subscription')
    expect(proxySeats(claudeProxyAccounts({ files: [{ id: 'k', provider: 'claude', account_type: 'api_key', auth_index: '1' }] }))).toBe('api_key')
    expect(proxySeats([])).toBeUndefined()
  })

  it('the automatic default and the choice', () => {
    expect(promptCacheHourOn({ basis: 'subscription' }, undefined)).toBe(true)
    expect(promptCacheHourOn({ basis: 'unconfirmed' }, undefined)).toBe(false)
    expect(promptCacheHourOn({ basis: 'unconfirmed' }, true)).toBe(true)
    expect(promptCacheHourOn({ basis: 'per_token' }, true)).toBe(false)
    expect(promptCacheHourOn({ basis: 'subscription', userSetting: true }, true)).toBe(false)
  })

  it('the choice is stored per entry and checked at the protocol', () => {
    expect(decodeInstanceConfig({ promptCacheHour: false }, { privateHome: false }).promptCacheHour).toBe(false)
    expect(decodeInstanceConfig({ promptCacheHour: 'yes' }, { privateHome: false }).promptCacheHour).toBeUndefined()
    expect(asInstanceConfigPatch({ promptCacheHour: true })).toEqual({ promptCacheHour: true })
    expect(asInstanceConfigPatch({ promptCacheHour: null })).toEqual({ promptCacheHour: null })
    expect(() => asInstanceConfigPatch({ promptCacheHour: 'on' })).toThrow(/promptCacheHour/)
  })
})
