/**
 * The client name (`CLAUDE_CODE_ENTRYPOINT`) Claude Code starts with for Mousse's turns, one-shots and compactions,
 * and a compaction on a cold cache that does not write the history back to the cache.
 * No real Claude Code or account: `claude auth status` and the query are fakes, so this proves Mousse's side
 * (the environment each process gets); what Claude Code sends for it was checked by hand against a capture server.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../src/shared/permissionMode'
import { ClaudeSubscriptionProviderService, MOUSSE_CLAUDE_ENTRYPOINT } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { readLocalProxySeats, resetLocalProxyDetection, type ProxyFetch } from '../src/mms/harness/vendors/claude/localProxyUsage'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Variables of this machine that would decide the route or the name: never read from the test runner's environment. */
const ROUTE = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_ENTRYPOINT', 'DISABLE_PROMPT_CACHING', 'CLIPROXY_MANAGEMENT_KEY', 'CLI_PROXY_API_MANAGEMENT_KEY', 'MANAGEMENT_PASSWORD']
let configDir: string
beforeEach(() => {
  resetLocalProxyDetection()
  for (const name of ROUTE) vi.stubEnv(name, undefined)
  configDir = tempDir('mousse-entrypoint-config-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeQuery(prompt: unknown): Query {
  const boundary = { type: 'system', subtype: 'compact_boundary', session_id: 's-1', compact_metadata: { trigger: 'manual', pre_tokens: 1000 } }
  // With usage, as Claude Code reports it: the saved session then keeps a baseline, which a later failed turn saves from.
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-1', usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { sonnet: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 } } }
  const frames = typeof prompt === 'string' && prompt.startsWith('/compact') ? [boundary, result] : [result]
  return Object.assign((async function* () { yield* frames })(), { close: () => {}, interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query
}

type Setup = { seats?: string[]; authMethod?: string; env?: Record<string, string>; args?: string[]; inherited?: Record<string, string>; paysPerToken?: boolean; userSettings?: Record<string, unknown>; projectSettings?: Record<string, unknown> }

function service(options: Setup = {}) {
  const home = tempDir('mousse-entrypoint-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const started: Array<{ prompt: unknown; options: Options }> = []
  if (options.userSettings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(options.userSettings))
  if (options.projectSettings) {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(options.projectSettings))
  }
  /** The entry's variables; a test changes them to move the route between turns. */
  const launchEnv: Record<string, string> = { ...options.env }
  /** What `claude auth status` answers; a test replaces it to make the check fail. */
  let auth = (): string => JSON.stringify({ loggedIn: true, authMethod: options.authMethod ?? 'claude.ai', apiProvider: 'firstParty' })
  const created = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    proxySeats: (input) => readLocalProxySeats({ ...input, fetch: (async (url) => ({
      status: 200,
      text: async () => JSON.stringify(new URL(url).pathname === '/' ? { message: 'CLI Proxy API Server' } : {
        files: (options.seats ?? []).map((kind, index) => ({ id: `c${index}`, provider: 'claude', account_type: kind, auth_index: `i${index}` }))
      })
    })) as ProxyFetch }),
    runAuth: async () => auth(),
    query: (input: { prompt: unknown; options: Options }) => {
      started.push(input)
      return fakeQuery(input.prompt)
    },
    launchConfig: () => ({ binaryPath: binary, ...(options.env ? { env: launchEnv } : {}), ...(options.args ? { args: options.args } : {}) }),
    ...(options.inherited ? { baseEnv: () => ({ ...process.env, ...options.inherited }) } : {}),
    ...(options.paysPerToken ? { paysPerToken: true } : {})
  })
  let thread = 0
  const turn = async (permissionMode?: PermissionMode, threadId = `t${thread++}`, extra: Partial<Parameters<ClaudeSubscriptionProviderService['chat']>[0]> = {}) => {
    await created.status({ force: true })
    await created.chat({ threadId, cwd: home, model: 'sonnet', prompt: 'hi', onText: () => {}, ...(permissionMode ? { permissionMode } : {}), ...extra })
    return started.at(-1)!.options.env!
  }
  const failAuth = (answer: string) => { auth = () => answer }
  return { service: created, turn, started, home, failAuth, launchEnv }
}

describe('the client name of a turn', () => {
  const proxy = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'proxy-token' }
  // Each row: the sign-in and setup, the thread's mode, and the name Claude Code starts with. Mousse's on every route and
  // in every mode; only a name the user set themselves replaces it.
  const rows: Array<[string, Setup, PermissionMode | undefined, string]> = [
    ['subscription sign-in, Ask', {}, 'ask', MOUSSE_CLAUDE_ENTRYPOINT],
    ['API-key sign-in', { authMethod: 'api_key' }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['ANTHROPIC_API_KEY', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-x' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ["apiKeyHelper in the user's Claude settings", { userSettings: { apiKeyHelper: 'echo key' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['an entry that pays per token', { paysPerToken: true }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['Bedrock', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['a local proxy, nothing set in Mousse', { authMethod: 'oauth_token', env: proxy }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ["a proxy in the user's Claude settings, in Auto", { authMethod: 'oauth_token', userSettings: { env: proxy } }, 'auto', MOUSSE_CLAUDE_ENTRYPOINT],
    ['a proxy whose seats are API keys', { authMethod: 'oauth_token', env: { ...proxy, CLIPROXY_MANAGEMENT_KEY: 'fixture' }, seats: ['api_key'] }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['a gateway', { authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ["a settings file in the entry's launch arguments", { args: ['--settings', '/somewhere/proxy.json'] }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ["a host Claude session's name is not inherited", { inherited: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    // A cloned folder cannot choose the name.
    ["a name in the project's Claude settings is not taken", { projectSettings: { env: { CLAUDE_CODE_ENTRYPOINT: 'my-app' } } }, 'auto', MOUSSE_CLAUDE_ENTRYPOINT],
    // The user's own choice wins.
    ["the entry's own variable", { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }, 'full', 'sdk-ts'],
    ["the entry's own variable in Auto", { env: { CLAUDE_CODE_ENTRYPOINT: 'my-app' } }, 'auto', 'my-app']
  ]
  it.each(rows)('%s', async (_name, setup, mode, expected) => {
    expect((await service(setup).turn(mode)).CLAUDE_CODE_ENTRYPOINT).toBe(expected)
  })

  it("a name in the user's Claude settings `env` is passed to the process, which reads it nowhere else", async () => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }))
    expect((await service().turn('full')).CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts')
  })

  it("a turn never enters Claude Code's own plan mode: its plan-mode tools are off", async () => {
    const fixture = service()
    const optionsOf = () => fixture.started.at(-1)!.options
    expect((await fixture.turn('ask', 'ask-thread')).CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
    expect(optionsOf().permissionMode).toBe('default')
    expect(optionsOf().disallowedTools).toEqual(expect.arrayContaining(['EnterPlanMode', 'ExitPlanMode']))
  })

  it('a chat title or other one-shot carries the name too', async () => {
    const { service: claude, started } = service()
    await claude.status()
    await claude.oneShot({ model: 'sonnet', prompt: 'Name this chat', onActivity: () => {} }, new AbortController().signal)
    expect(started.at(-1)!.options.env!.CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
  })
})

describe('compaction', () => {
  async function compacted(mode: PermissionMode, cacheCold?: boolean) {
    const fixture = service()
    await fixture.turn(mode, 'thread')
    fixture.service.commitConversation('thread', 'history')
    const done = await fixture.service.compactConversation('thread', 'history', undefined, undefined, new AbortController().signal, cacheCold === undefined ? undefined : { cacheCold })
    expect(done).toBe(true)
    const compaction = fixture.started.at(-1)!
    expect(compaction.prompt).toBe('/compact')
    return compaction.options.env!
  }

  it('runs under the name the thread last ran with, so a warm cache still matches', async () => {
    expect((await compacted('full')).CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
    expect((await compacted('auto')).CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
  })

  it('on a cold cache, does not write the history it summarizes back to the cache; on a warm one, keeps caching', async () => {
    expect((await compacted('full', true)).DISABLE_PROMPT_CACHING).toBe('1')
    expect(await compacted('full', false)).not.toHaveProperty('DISABLE_PROMPT_CACHING')
    expect(await compacted('full')).not.toHaveProperty('DISABLE_PROMPT_CACHING')
  })

  it("a session that ran under another name keeps the default, not Mousse's, once that name is removed", async () => {
    const fixture = service({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } })
    await fixture.turn('full', 'thread')
    fixture.service.commitConversation('thread', 'history')
    delete fixture.launchEnv.CLAUDE_CODE_ENTRYPOINT
    await fixture.service.compactConversation('thread', 'history', undefined, undefined, new AbortController().signal)
    expect(fixture.started.at(-1)!.prompt).toBe('/compact')
    expect(fixture.started.at(-1)!.options.env!.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    // A new thread then runs, and compacts, under Mousse's name.
    await fixture.turn('full', 'new-thread')
    fixture.service.commitConversation('new-thread', 'new-history')
    await fixture.service.compactConversation('new-thread', 'new-history', undefined, undefined, new AbortController().signal)
    expect(fixture.started.at(-1)!.options.env!.CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
  })

  it('the next turn after a cold compaction caches as usual', async () => {
    const fixture = service()
    await fixture.turn('full', 'thread')
    fixture.service.commitConversation('thread', 'history')
    await fixture.service.compactConversation('thread', 'history', undefined, undefined, new AbortController().signal, { cacheCold: true })
    expect(await fixture.turn('full', 'thread')).not.toHaveProperty('DISABLE_PROMPT_CACHING')
  })
})
