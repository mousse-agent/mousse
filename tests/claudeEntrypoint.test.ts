/**
 * The client name (`CLAUDE_CODE_ENTRYPOINT`) Claude Code starts with for Mousse's turns, one-shots and compactions,
 * and a compaction on a cold cache that does not write the history back to the cache.
 * No real Claude Code or account: `claude auth status` and the query are fakes, so this proves Mousse's side
 * (the environment each process gets); what Claude Code sends for it was checked by hand against a capture server.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-1' }
  const frames = typeof prompt === 'string' && prompt.startsWith('/compact') ? [boundary, result] : [result]
  return Object.assign((async function* () { yield* frames })(), { close: () => {}, interrupt: async () => {}, supportedModels: async () => [] }) as unknown as Query
}

function service(options: { authMethod?: string; env?: Record<string, string>; inherited?: Record<string, string> } = {}) {
  const home = tempDir('mousse-entrypoint-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const started: Array<{ prompt: unknown; options: Options }> = []
  const created = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: options.authMethod ?? 'claude.ai', apiProvider: 'firstParty' }),
    query: (input: { prompt: unknown; options: Options }) => {
      started.push(input)
      return fakeQuery(input.prompt)
    },
    launchConfig: () => ({ binaryPath: binary, ...(options.env ? { env: options.env } : {}) }),
    ...(options.inherited ? { baseEnv: () => ({ ...process.env, ...options.inherited }) } : {})
  })
  let thread = 0
  const turn = async (permissionMode?: PermissionMode, threadId = `t${thread++}`) => {
    await created.status()
    await created.chat({ threadId, cwd: home, model: 'sonnet', prompt: 'hi', onText: () => {}, ...(permissionMode ? { permissionMode } : {}) })
    return started.at(-1)!.options.env!
  }
  return { service: created, turn, started, home }
}

describe('the client name of a turn', () => {
  // Each row: the sign-in and setup, the thread's mode, and the name Claude Code starts with (undefined: the Agent SDK's sdk-ts).
  const rows: Array<[string, Parameters<typeof service>[0], PermissionMode | undefined, string | undefined]> = [
    ['subscription sign-in, Ask', {}, 'ask', MOUSSE_CLAUDE_ENTRYPOINT],
    ['subscription sign-in, Auto-accept edits', {}, 'accept_edits', MOUSSE_CLAUDE_ENTRYPOINT],
    ['subscription sign-in, Full access', {}, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    // Auto mode checks each tool call with a billed request of its own under an unknown name.
    ['subscription sign-in, Auto', {}, 'auto', undefined],
    ['a host Claude session\'s name is not inherited', { inherited: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    ['subscription token in the environment (CLAUDE_CODE_OAUTH_TOKEN)', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth' } }, 'full', MOUSSE_CLAUDE_ENTRYPOINT],
    // Credit-only API accounts refuse an unknown name; proxies rewrite requests from one they don't recognise.
    ['API-key sign-in', { authMethod: 'api_key' }, 'full', undefined],
    ['ANTHROPIC_API_KEY', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-x' } }, 'full', undefined],
    ['ANTHROPIC_AUTH_TOKEN', { authMethod: 'oauth_token', env: { ANTHROPIC_AUTH_TOKEN: 'bearer' } }, 'full', undefined],
    ['local proxy', { authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317', ANTHROPIC_AUTH_TOKEN: 'proxy-token' } }, 'full', undefined],
    ['gateway', { authMethod: 'oauth_token', env: { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' } }, 'full', undefined],
    ['Bedrock', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, 'full', undefined],
    // The user's own choice wins, Auto included.
    ['the entry\'s own variable', { env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }, 'full', 'sdk-ts'],
    ['the entry\'s own variable in Auto', { env: { CLAUDE_CODE_ENTRYPOINT: 'my-app' } }, 'auto', 'my-app']
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

  it('the next turn after a cold compaction caches as usual', async () => {
    const fixture = service()
    await fixture.turn('full', 'thread')
    fixture.service.commitConversation('thread', 'history')
    await fixture.service.compactConversation('thread', 'history', undefined, undefined, new AbortController().signal, { cacheCold: true })
    expect(await fixture.turn('full', 'thread')).not.toHaveProperty('DISABLE_PROMPT_CACHING')
  })
})
