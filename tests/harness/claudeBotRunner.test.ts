/**
 * Bot Phase 1 §5.9 items 5 and 7, through the gateway with the real Claude Code driver and its
 * recorded evidence: "Claude for bots" (`claude:bots`) is added at a bot's creation when the owner's
 * Claude subscription is signed in and no locked entry exists, in a home of its own and signed out;
 * it holds a bot on Linux on a recorded Claude Code version only. A Claude Code that updated itself
 * to a version with no record holds no bot, so the bot runs on Pi, or says plainly that it can't.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotModelResolver } from '../../src/mms/bots/model/BotModelResolver'
import { CLAUDE_BOT_RUNNER_ID } from '../../src/mms/harness/claude/locked'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { instanceStateDir } from '../../src/mms/harness/instances'
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
  // The owner's own Claude Code sign-in: nothing of it may reach the bot runner's home.
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

function profile(options: { platform?: NodeJS.Platform; version?: string; owner?: 'subscription' | 'api_key' | 'signed_out'; stored?: Record<string, unknown>; removed?: string[] } = {}) {
  const profileHome = tempDir('mousse-bot-runner-')
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
  let stored: unknown = options.stored ?? { claude: { driver: 'claude', enabled: true, config: { binaryPath: claude.binary } } }
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
        // A sign-in terminal runs here, so a signed-out runner offers Sign in.
        pty: { available: () => true },
        createService: (context, serviceOptions) => new ClaudeSubscriptionProviderService(context.profileHome, questions, { ...serviceOptions, runAuth: runAuth(context.instanceId) })
      })
    ]
  })
  return { harness, profileHome, claude, authEnvs, stored: () => stored as Record<string, { driver: string; config?: Record<string, unknown> }> }
}

describe('the bot runner entry, "Claude for bots" (§5.9 item 7)', () => {
  it('is added once, locked, in a home of its own and signed out, running the owner\'s program; nothing of the owner\'s sign-in is copied', async () => {
    const p = profile()
    expect((await p.harness.instances.recheck('claude')).auth).toMatchObject({ state: 'signed_in', credential: 'subscription' })
    const [first, second] = await Promise.all([p.harness.ensureBotRunner(), p.harness.ensureBotRunner()])
    expect(first).toBe(CLAUDE_BOT_RUNNER_ID)
    expect(second).toBe(CLAUDE_BOT_RUNNER_ID)
    expect(Object.keys(p.stored()).sort()).toEqual(['claude', CLAUDE_BOT_RUNNER_ID])
    expect(p.stored()[CLAUDE_BOT_RUNNER_ID]).toMatchObject({ driver: 'claude', config: { home: 'private', profile: 'locked', displayName: 'Claude for bots', binaryPath: p.claude.binary } })
    // A later bot adds nothing: a locked entry exists.
    expect(await p.harness.ensureBotRunner()).toBeUndefined()
    const runner = await p.harness.instances.recheck(CLAUDE_BOT_RUNNER_ID)
    expect(runner).toMatchObject({ displayName: 'Claude for bots', auth: { state: 'signed_out', canSignIn: true }, config: { profile: 'locked' } })
    // It runs bot turns only: no thread model picker lists it.
    expect(p.harness.listedLlmProviders({ kind: 'device' }).map((option) => option.instanceId)).not.toContain(CLAUDE_BOT_RUNNER_ID)
    // Its own home: the status check ran there, and the owner's credentials file is not in it.
    const home = join(instanceStateDir(p.profileHome, CLAUDE_BOT_RUNNER_ID), 'home')
    expect(p.authEnvs[CLAUDE_BOT_RUNNER_ID]).toBe(home)
    expect(p.authEnvs.claude).not.toBe(home)
    expect(existsSync(join(home, '.credentials.json'))).toBe(false)
    if (existsSync(home)) expect(readdirSync(home, { recursive: true }).map(String).filter((name) => name.includes('credentials'))).toEqual([])
    // Signed out, it can hold a bot once signed in: Sign in opens its card.
    expect(p.harness.canHoldBot(CLAUDE_BOT_RUNNER_ID, botPolicy)).toEqual({ ok: true })
    const resolver = createBotModelResolver({
      snapshots: () => p.harness.instances.snapshots({ kind: 'device' }),
      models: (instanceId) => p.harness.catalog.models(instanceId, { kind: 'device' }),
      hold: { canHoldBot: (instanceId, policy, model) => p.harness.canHoldBot(instanceId, policy, model) }
    })
    expect(await resolver.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy })).toEqual({ problem: 'no_provider', instanceId: CLAUDE_BOT_RUNNER_ID })
    // The owner's own entry never holds a bot.
    expect(p.harness.canHoldBot('claude', botPolicy).ok).toBe(false)
  })

  it('is not added without a signed-in Claude subscription, next to a locked entry, or after the owner removed it', async () => {
    for (const owner of ['api_key', 'signed_out'] as const) {
      const p = profile({ owner })
      await p.harness.instances.recheck('claude')
      expect(await p.harness.ensureBotRunner(), owner).toBeUndefined()
      expect(Object.keys(p.stored()), owner).toEqual(['claude'])
    }
    const withLocked = profile({ stored: { claude: { driver: 'claude', enabled: true }, 'claude:mine': { driver: 'claude', enabled: true, config: { home: 'private', profile: 'locked' } } } })
    await withLocked.harness.instances.recheck('claude')
    expect(await withLocked.harness.ensureBotRunner()).toBeUndefined()
    const removed = profile({ removed: [CLAUDE_BOT_RUNNER_ID] })
    await removed.harness.instances.recheck('claude')
    expect(await removed.harness.ensureBotRunner()).toBeUndefined()
    expect(Object.keys(removed.stored())).toEqual(['claude'])
  })
})

describe('canHoldBot on locked Claude Code with the recorded evidence (§5.9 item 5)', () => {
  it('admits a bot policy on Linux on a recorded version, and refuses it on macOS and Windows', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const p = profile({ platform })
      await p.harness.instances.recheck('claude')
      await p.harness.ensureBotRunner()
      await p.harness.instances.recheck(CLAUDE_BOT_RUNNER_ID)
      const held = p.harness.canHoldBot(CLAUDE_BOT_RUNNER_ID, botPolicy)
      if (platform === 'linux') expect(held).toEqual({ ok: true })
      else expect(held, platform).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
    }
    // Codex has no bot gate at all.
    expect(codexDriver({ builtIn: () => { throw new Error('unused') } }).botAuthority).toBeUndefined()
  })

  it('a Claude Code that updated itself to a version with no record fails closed: Pi runs the bot, or it says it can\'t', async () => {
    const p = profile({ version: '2.1.306' })
    await p.harness.instances.recheck('claude')
    await p.harness.ensureBotRunner()
    await p.harness.instances.recheck(CLAUDE_BOT_RUNNER_ID)
    expect(p.harness.canHoldBot(CLAUDE_BOT_RUNNER_ID, botPolicy)).toEqual({ ok: true })
    p.claude.setVersion('2.1.399')
    expect((await p.harness.instances.recheck(CLAUDE_BOT_RUNNER_ID)).binary?.version).toBe('2.1.399')
    expect(p.harness.canHoldBot(CLAUDE_BOT_RUNNER_ID, botPolicy)).toMatchObject({ ok: false, error: { code: 'policy_unenforceable', missing: ['toolControl'] } })
    // As if the runner were signed in: with Pi there, the bot runs on Pi; without it, no model and
    // no Sign in (signing in would not help), so the bot says "Set up a provider so I can work."
    const real = await p.harness.instances.snapshots({ kind: 'device' })
    const runner = { ...real.find((entry) => entry.instanceId === CLAUDE_BOT_RUNNER_ID)!, auth: { state: 'signed_in', credential: 'subscription' }, runs: { state: 'yes' } } as InstanceSnapshot
    const pi = { ...runner, instanceId: 'pi:openai', driver: 'pi', auth: { state: 'signed_in', credential: 'api_key' } } as InstanceSnapshot
    const models: Record<string, InstanceModel[]> = {
      [CLAUDE_BOT_RUNNER_ID]: [{ id: 'sonnet', label: 'Sonnet', source: 'catalog', capabilities: { efforts: [], images: true }, hidden: false, favorite: false } as InstanceModel],
      'pi:openai': [{ id: 'gpt-5.1', label: 'GPT-5.1', source: 'catalog', capabilities: { efforts: [], images: true }, hidden: false, favorite: false } as InstanceModel]
    }
    const hold = { canHoldBot: (instanceId: string, policy: RunPolicy, model?: string) => instanceId === 'pi:openai' ? { ok: true as const } : p.harness.canHoldBot(instanceId, policy, model) }
    const withPi = createBotModelResolver({ snapshots: async () => [runner, pi], models: (id) => models[id] ?? [], hold })
    expect(await withPi.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy })).toMatchObject({ selection: { instanceId: 'pi:openai' } })
    const alone = createBotModelResolver({ snapshots: async () => [runner], models: (id) => models[id] ?? [], hold })
    expect(await alone.resolve({ botId: 'b', choice: { mode: 'auto', depth: 'normal' }, policy: botPolicy })).toEqual({ problem: 'no_provider' })
    // Back on a recorded version, it holds the bot again.
    p.claude.setVersion('2.1.291')
    await p.harness.instances.recheck(CLAUDE_BOT_RUNNER_ID)
    expect(p.harness.canHoldBot(CLAUDE_BOT_RUNNER_ID, botPolicy)).toEqual({ ok: true })
  })
})
