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

type Setup = { authMethod?: string; env?: Record<string, string>; args?: string[]; inherited?: Record<string, string>; paysPerToken?: boolean; userSettings?: Record<string, unknown>; projectSettings?: Record<string, unknown> }

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
  // Each row: the sign-in and setup, the thread's mode, and the name Claude Code starts with (undefined: the Agent SDK's sdk-ts).
  const rows: Array<[string, Setup, PermissionMode | undefined, string | undefined]> = [
    ['subscription sign-in, Ask', {}, 'ask', MOUSSE_CLAUDE_ENTRYPOINT],
    ['subscription sign-in, Auto-accept edits', {}, 'accept_edits', MOUSSE_CLAUDE_ENTRYPOINT],
    ['subscription sign-in, Full access', {}, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    // Auto mode checks each tool call with a billed request of its own under an unknown name.
    ['subscription sign-in, Auto', {}, 'auto', undefined],
    // Settings that turn auto mode off make Auto run as Auto-accept edits: the name is safe there.
    ['Auto turned off by Claude settings', { userSettings: { permissions: { disableAutoMode: 'disable' } } }, 'auto', MOUSSE_CLAUDE_ENTRYPOINT],
    ["Anthropic's own address as the base URL", { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ["a host Claude session's name is not inherited", { inherited: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['subscription token in the environment (CLAUDE_CODE_OAUTH_TOKEN)', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    // Credit-only API accounts refuse an unknown name; proxies rewrite requests from one they don't recognise.
    ['API-key sign-in', { authMethod: 'api_key' }, 'full', undefined],
    ['ANTHROPIC_API_KEY', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-x' } }, 'full', undefined],
    ['ANTHROPIC_AUTH_TOKEN', { authMethod: 'oauth_token', env: { ANTHROPIC_AUTH_TOKEN: 'bearer' } }, 'full', undefined],
    ['local proxy', { authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'proxy-token' } }, 'full', undefined],
    ['gateway', { authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' } }, 'full', undefined],
    ['Bedrock', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, 'full', undefined],
    ['an entry that pays per token', { paysPerToken: true }, 'full', undefined],
    // Settings passed in launch arguments are not read, so they may route anywhere.
    ["a settings file in the entry's launch arguments", { args: ['--settings', '/somewhere/proxy.json'] }, 'full', undefined],
    ["a proxy set in the user's Claude settings", { userSettings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } } }, 'full', undefined],
    ["a proxy set in the project's Claude settings", { projectSettings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } } }, 'full', undefined],
    ["an API key in the project's Claude settings", { projectSettings: { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-x' } } }, 'full', undefined],
    ["apiKeyHelper in the user's Claude settings", { userSettings: { apiKeyHelper: 'echo key' } }, 'full', undefined],
    ["apiKeyHelper in the project's Claude settings", { projectSettings: { apiKeyHelper: 'echo key' } }, 'full', undefined],
    // A cloned folder cannot set the name: it would pass every check above.
    ["a name in the project's Claude settings is not taken", { projectSettings: { env: { CLAUDE_CODE_ENTRYPOINT: 'my-app' } } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ["a name in the project's Claude settings, in Auto", { projectSettings: { env: { CLAUDE_CODE_ENTRYPOINT: 'my-app' } } }, 'auto', undefined],
    // The user's own choice wins, Auto included.
    ["the entry's own variable", { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }, 'full', 'sdk-ts'],
    ["the entry's own variable in Auto", { env: { CLAUDE_CODE_ENTRYPOINT: 'my-app' } }, 'auto', 'my-app']
  ]
  it.each(rows)('%s', async (_name, setup, mode, expected) => {
    const env = await service(setup).turn(mode)
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(expected)
  })

  it("a name in the user's Claude settings `env` is passed to the process, which reads it nowhere else", async () => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }))
    expect((await service().turn('full')).CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts')
  })

  it('a chat title or other one-shot on the subscription carries the name too', async () => {
    const { service: claude, started } = service()
    await claude.status()
    await claude.oneShot({ model: 'sonnet', prompt: 'Name this chat', onActivity: () => {} }, new AbortController().signal)
    expect(started.at(-1)!.options.env!.CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
  })

  it("a plan turn keeps its thread's name, and a named process never takes auto semantics in plan mode", async () => {
    const fixture = service()
    const settingsOf = () => (fixture.started.at(-1)!.options.settings ?? {}) as Record<string, unknown>
    // In an Ask thread: the name, with plan mode's auto semantics off.
    expect((await fixture.turn('ask', 'ask-thread', { mode: 'plan' })).CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
    expect(settingsOf().useAutoModeDuringPlan).toBe(false)
    // In an Auto thread: the default, like the thread's other turns, so its process is not restarted for it.
    expect((await fixture.turn('auto', 'auto-thread', { mode: 'plan' })).CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(settingsOf()).not.toHaveProperty('useAutoModeDuringPlan')
  })

  it('a read-only child of an Auto thread runs in the default mode, so it takes the name', async () => {
    expect((await service().turn('auto', undefined, { child: { readOnly: true } })).CLAUDE_CODE_ENTRYPOINT).toBe(MOUSSE_CLAUDE_ENTRYPOINT)
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
    expect((await compacted('auto')).CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  it('on a cold cache, does not write the history it summarizes back to the cache; on a warm one, keeps caching', async () => {
    expect((await compacted('full', true)).DISABLE_PROMPT_CACHING).toBe('1')
    expect(await compacted('full', false)).not.toHaveProperty('DISABLE_PROMPT_CACHING')
    expect(await compacted('full')).not.toHaveProperty('DISABLE_PROMPT_CACHING')
  })

  it('drops the saved name when the route no longer allows it: a proxy or an API key set since', async () => {
    for (const route of [{ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'proxy-token' }, { ANTHROPIC_API_KEY: 'sk-ant-api03-x' }]) {
      const fixture = service({ env: {} })
      await fixture.turn('full', 'thread')
      fixture.service.commitConversation('thread', 'history')
      Object.assign(fixture.launchEnv, route)
      await fixture.service.compactConversation('thread', 'history', undefined, undefined, new AbortController().signal)
      expect(fixture.started.at(-1)!.prompt).toBe('/compact')
      expect(fixture.started.at(-1)!.options.env!.CLAUDE_CODE_ENTRYPOINT, Object.keys(route).join()).toBeUndefined()
    }
  })

  it('the next turn after a cold compaction caches as usual', async () => {
    const fixture = service()
    await fixture.turn('full', 'thread')
    fixture.service.commitConversation('thread', 'history')
    await fixture.service.compactConversation('thread', 'history', undefined, undefined, new AbortController().signal, { cacheCold: true })
    expect(await fixture.turn('full', 'thread')).not.toHaveProperty('DISABLE_PROMPT_CACHING')
  })
})
