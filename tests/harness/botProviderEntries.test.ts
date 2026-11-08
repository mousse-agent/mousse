/**
 * Bots run on the owner's own provider entries, through the gateway with the real Claude Code and
 * Codex drivers: the owner's signed-in Claude Code holds a bot (its approvals are answered by the
 * bot's authority), nothing is added for bots, and a signed-out entry is what the bot's Sign in
 * opens. A locked Claude Code entry (the locked profile, kept with its evidence) still holds a bot
 * on Linux on a recorded version only.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEUTRAL_TOOLS } from '../../src/shared/harness/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotModelResolver } from '../../src/mms/bots/model/BotModelResolver'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import type { InstanceModel, RunPolicy } from '../../src/shared/harness/types'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
let ownerHome: string
beforeEach(() => {
  // The owner's own Claude Code sign-in.
  ownerHome = tempDir('mousse-owner-claude-')
  writeFileSync(join(ownerHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'owner-token', refreshToken: 'owner-refresh' } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', ownerHome)
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A `claude` whose `--version` prints the version in `version.txt` beside it. */
function fakeClaude(version: string) {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  const versionFile = join(dir, 'version.txt')
  writeFileSync(versionFile, version)
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, `#!/usr/bin/env node\nconsole.log(require('fs').readFileSync(${JSON.stringify(versionFile)}, 'utf8') + ' (Claude Code)')\n`)
  chmodSync(script, 0o755)
  return { binary: script, setVersion: (next: string) => writeFileSync(versionFile, next) }
}

const botPolicy: RunPolicy = { mode: 'default', origin: 'bot', tools: { allow: ['Read'] }, approvals: 'grants', approve: 'host', authority: { kind: 'bot', digest: 'd' } }

function profile(options: { platform?: NodeJS.Platform; version?: string; owner?: 'subscription' | 'api_key' | 'signed_out'; stored?: (binary: string) => Record<string, unknown>; removed?: string[] } = {}) {
  const profileHome = tempDir('mousse-bot-entries-')
  const claude = fakeClaude(options.version ?? '2.1.306')
  const questions = new UserQuestionService()
  const authEnvs: Record<string, string | undefined> = {}
  const owner = options.owner ?? 'subscription'
  const runAuth = (instanceId: string) => async (_binary: string, _args: string[], env: NodeJS.ProcessEnv) => {
    authEnvs[instanceId] = env.CLAUDE_CONFIG_DIR
    if (instanceId !== 'claude') return JSON.stringify({ loggedIn: false })
    if (owner === 'signed_out') return JSON.stringify({ loggedIn: false })
    return JSON.stringify(owner === 'subscription' ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' } : { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' })
  }
  const builtIn = new ClaudeSubscriptionProviderService(profileHome, questions, { findBinary: () => claude.binary, runAuth: runAuth('claude') })
  let stored: unknown = options.stored?.(claude.binary) ?? { claude: { driver: 'claude', enabled: true, config: { binaryPath: claude.binary } } }
  let removed = options.removed
  const instanceMap = new ProviderInstanceService({
    store: {
      read: () => ({ instances: stored, seedVersion: 1, ...(removed ? { removed } : {}) }),
      write: (next) => { stored = next.instances; removed = next.removed }
    }
  })
  const harness = createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap,
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver(),
      claudeCodeDriver({
        builtIn: () => builtIn,
        platform: options.platform ?? 'linux',
        managedPolicy: () => false,
        onLockedProcess: () => undefined,
        pty: { available: () => true },
        createService: (context, serviceOptions) => new ClaudeSubscriptionProviderService(context.profileHome, questions, { ...serviceOptions, runAuth: runAuth(context.instanceId) })
      })
    ]
  })
  return { harness, profileHome, claude, authEnvs, stored: () => stored as Record<string, { driver: string; config?: Record<string, unknown> }> }
}

const LOCKED = 'claude:mine'
const withLocked = (binaryPath: string) => ({ claude: { driver: 'claude', enabled: true, config: { binaryPath } }, [LOCKED]: { driver: 'claude', enabled: true, config: { home: 'private', profile: 'locked', binaryPath } } })

describe('bots run on the owner\'s own provider entries', () => {
  it('the owner\'s signed-in Claude Code holds a bot on every platform, and nothing is added for bots', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const p = profile({ platform })
      expect((await p.harness.instances.recheck('claude')).auth, platform).toMatchObject({ state: 'signed_in', credential: 'subscription' })
      expect(p.harness.canHoldBot('claude', botPolicy), platform).toEqual({ ok: true })
      expect('ensureBotRunner' in p.harness).toBe(false)
      const resolver = createBotModelResolver({
        snapshots: () => p.harness.instances.snapshots({ kind: 'device' }),
        models: (instanceId) => p.harness.catalog.models(instanceId, { kind: 'device' }),
        hold: { canHoldBot: (instanceId, policy, model) => p.harness.canHoldBot(instanceId, policy, model) }
      })
      expect(await resolver.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy }), platform).toMatchObject({ selection: { instanceId: 'claude', model: 'sonnet' } })
      expect(Object.keys(p.stored()), platform).toEqual(['claude'])
    }
  })

  it('a signed-out owner entry is what the bot\'s Sign in opens', async () => {
    const p = profile({ owner: 'signed_out' })
    await p.harness.instances.recheck('claude')
    const resolver = createBotModelResolver({
      snapshots: () => p.harness.instances.snapshots({ kind: 'device' }),
      models: (instanceId) => p.harness.catalog.models(instanceId, { kind: 'device' }),
      hold: { canHoldBot: (instanceId, policy, model) => p.harness.canHoldBot(instanceId, policy, model) }
    })
    expect(await resolver.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy })).toEqual({ problem: 'no_provider', instanceId: 'claude' })
  })

  it('the "Claude for bots" entry an earlier build added is removed; one the owner renamed stays', async () => {
    const runner = (displayName: string) => (binaryPath: string) => ({ claude: { driver: 'claude', enabled: true, config: { binaryPath } }, 'claude:bots': { driver: 'claude', enabled: true, config: { home: 'private', profile: 'locked', displayName, binaryPath } } })
    const old = profile({ stored: runner('Claude for bots') })
    expect(await old.harness.removeRetiredBotRunner()).toBe(true)
    expect(Object.keys(old.stored())).toEqual(['claude'])
    expect(await old.harness.removeRetiredBotRunner()).toBe(false)
    const renamed = profile({ stored: runner('My bot Claude') })
    expect(await renamed.harness.removeRetiredBotRunner()).toBe(false)
    expect(Object.keys(renamed.stored()).sort()).toEqual(['claude', 'claude:bots'])
  })

  it('Codex holds a bot through its approvals, with a name for every neutral tool', () => {
    const codex = codexDriver({ builtIn: () => { throw new Error('unused') } })
    expect(codex.botAuthority?.({})).toBe(true)
    expect(codex.botApprovals?.({})).toBe(true)
    for (const tool of NEUTRAL_TOOLS) expect(codex.nativeToolNames?.(tool, {}).length, tool).toBeGreaterThan(0)
  })
})

describe('canHoldBot on a locked Claude Code entry with the recorded evidence (§5.9 item 5)', () => {
  it('admits a bot policy on Linux on a recorded version, and refuses it on macOS and Windows', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const p = profile({ platform, stored: withLocked })
      await p.harness.instances.recheck(LOCKED)
      const held = p.harness.canHoldBot(LOCKED, botPolicy)
      if (platform === 'linux') expect(held).toEqual({ ok: true })
      else expect(held, platform).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
      // The owner's own entry holds it everywhere.
      expect(p.harness.canHoldBot('claude', botPolicy), platform).toEqual({ ok: true })
    }
  })

  it('a locked Claude Code that updated itself to a version with no record fails closed; the owner\'s entries still run the bot', async () => {
    const p = profile({ version: '2.1.306', stored: withLocked })
    await p.harness.instances.recheck(LOCKED)
    expect(p.harness.canHoldBot(LOCKED, botPolicy)).toEqual({ ok: true })
    p.claude.setVersion('2.1.399')
    expect((await p.harness.instances.recheck(LOCKED)).binary?.version).toBe('2.1.399')
    expect(p.harness.canHoldBot(LOCKED, botPolicy)).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
    // As if the locked entry were signed in: the bot runs on the owner's Pi; without it, no model and
    // no Sign in (signing in would not help), so the bot says "Set up a provider so I can work."
    const real = await p.harness.instances.snapshots({ kind: 'device' })
    const locked = { ...real.find((entry) => entry.instanceId === LOCKED)!, auth: { state: 'signed_in', credential: 'subscription' }, runs: { state: 'yes' } } as InstanceSnapshot
    const pi = { ...locked, instanceId: 'pi:openai', driver: 'pi', auth: { state: 'signed_in', credential: 'api_key' } } as InstanceSnapshot
    const models: Record<string, InstanceModel[]> = {
      [LOCKED]: [{ id: 'sonnet', label: 'Sonnet', source: 'catalog', capabilities: { efforts: [], images: true }, hidden: false, favorite: false } as InstanceModel],
      'pi:openai': [{ id: 'gpt-5.1', label: 'GPT-5.1', source: 'catalog', capabilities: { efforts: [], images: true }, hidden: false, favorite: false } as InstanceModel]
    }
    const hold = { canHoldBot: (instanceId: string, policy: RunPolicy, model?: string) => instanceId === 'pi:openai' ? { ok: true as const } : p.harness.canHoldBot(instanceId, policy, model) }
    const withPi = createBotModelResolver({ snapshots: async () => [locked, pi], models: (id) => models[id] ?? [], hold })
    expect(await withPi.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy })).toMatchObject({ selection: { instanceId: 'pi:openai' } })
    const alone = createBotModelResolver({ snapshots: async () => [locked], models: (id) => models[id] ?? [], hold })
    expect(await alone.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy })).toEqual({ problem: 'no_provider' })
    // Back on a recorded version, it holds the bot again.
    p.claude.setVersion('2.1.291')
    await p.harness.instances.recheck(LOCKED)
    expect(p.harness.canHoldBot(LOCKED, botPolicy)).toEqual({ ok: true })
  })
})
