/**
 * A bot's subagent on another runtime, compiled through the real gateway and the real Claude Code and Codex drivers:
 * their tool names, `checkPolicy` and what each says about how it holds a bot here (`botHold`). The engine is real, on a
 * real `bots.db` and run database; only the model resolver is a stand-in. The hold itself, on the real binaries, is in
 * `tests/harness/codexBotTools.test.ts` and the Linux sandbox runs this PR's Verification names.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botInstructions } from '../../src/mms/bots/instructions'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import { createHarnessGateway, type HarnessGateway } from '../../src/mms/harness/gateway'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { CodexProviderService } from '../../src/mms/harness/vendors/codex/CodexProviderService'
import type { NormalisedCall } from '../../src/shared/bots/personal/authority'
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import { botFixture, createBot, start, type BotFixture } from './botFixture'

const dirs: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A `claude` that only prints its version: nothing here runs a turn. */
function fakeClaude(): string {
  const dir = tempDir('mousse-fakeclaude-')
  mkdirSync(join(dir, 'node_modules', 'claude'), { recursive: true })
  const script = join(dir, 'node_modules', 'claude', 'cli.js')
  writeFileSync(join(dir, 'node_modules', 'claude', 'package.json'), JSON.stringify({ name: 'claude' }))
  writeFileSync(script, '#!/usr/bin/env node\nconsole.log("2.1.306 (Claude Code)")\n')
  chmodSync(script, 0o755)
  return script
}

/** The owner's Claude Code and Codex entries, on macOS (where Claude Code's sandbox always runs), through the gateway. */
function gateway(): HarnessGateway {
  const profileHome = tempDir('mousse-bot-sub-runtimes-')
  const binary = fakeClaude()
  const questions = new UserQuestionService()
  const runAuth = async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
  const builtIn = new ClaudeSubscriptionProviderService(profileHome, questions, { findBinary: () => binary, runAuth })
  let stored: unknown = { claude: { driver: 'claude', enabled: true, config: { binaryPath: binary } }, codex: { driver: 'codex', enabled: true, config: {} } }
  const instanceMap = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  return createHarnessGateway({
    profileHome,
    installationHome: profileHome,
    instanceMap,
    questions,
    shellPath: async () => ({ entries: [], source: 'failed' }),
    drivers: [
      piDriver(),
      claudeCodeDriver({ builtIn: () => builtIn, platform: 'darwin', managedPolicy: () => false, onLockedProcess: () => undefined, pty: { available: () => true } }),
      codexDriver({ builtIn: () => ({ vendorMirror: () => ({ fields: [], read: () => 'unreadable', write: () => {}, exists: () => false }) }) as unknown as CodexProviderService, platform: 'darwin' })
    ]
  })
}

const command: NormalisedCall = { kind: 'builtin', tool: 'shell', nativeName: 'shell', args: { command: 'ls' } }

describe('a subagent on another runtime, through the real drivers', () => {
  let f: BotFixture
  let botId: string
  let harness: HarnessGateway
  const CLAUDE = { instanceId: 'claude', model: 'sonnet' }
  const CODEX = { instanceId: 'codex', model: 'gpt-5.5' }
  const choices: BotModelOption[] = [
    { instanceId: CLAUDE.instanceId, entry: 'Claude Code', model: CLAUDE.model, label: 'Sonnet', efforts: [] },
    { instanceId: CODEX.instanceId, entry: 'Codex', model: CODEX.model, label: 'GPT-5.5', efforts: [] }
  ]
  const on = (selection: { instanceId: string; model: string }, entry: string, name: string) => ({ pick: { ...selection }, name: { name, entry } })

  beforeEach(async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir('mousse-owner-claude-'))
    harness = gateway()
    f = botFixture()
    f.host.platform = 'darwin'
    f.host.instructions = (bot) => botInstructions(bot)
    f.host.modelOptions = async () => choices
    f.host.harness = {
      checkPolicy: (instanceId, policy, model) => harness.checkPolicy(instanceId, policy, model),
      nativeToolNames: (instanceId, tools) => harness.nativeToolNames(instanceId, tools),
      botHold: (instanceId) => harness.botHold(instanceId)
    }
    f.candidates = [CLAUDE]
    await f.bots.reconcileOnStartup()
    botId = (await createBot(f, { name: 'Pip', description: 'Look things up for me.', reply: 'Hello.' })).botId
  })
  afterEach(() => {
    f.close()
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function work(id: string, on: { instanceId: string; model: string }, options: { files?: boolean } = {}) {
    f.candidates = [on]
    const activation = await f.bots.activate({ botId, input: 'Check the build.', clientRequestId: id })
    f.store.putOverlay(activation.id, `once-shell-${id}`, { tool: 'shell' })
    if (options.files) f.store.putOverlay(activation.id, `once-files-${id}`, { path: f.base, access: 'write' })
    return { id: activation.id, ...(await start(f, activation.id)) }
  }
  const lastSubagent = (activationId: string) => f.store.dispatches(activationId).filter((dispatch) => dispatch.kind === 'subagent').at(-1)!.n

  it('the drivers say how they hold a bot here: Claude Code in its sandbox on macOS, Codex with its search off without the web', () => {
    expect(harness.botHold('claude')).toEqual({ runtime: 'claude', sandbox: 'available' })
    expect(harness.botHold('codex')).toEqual({ runtime: 'codex', hostedSearch: 'off_without_web' })
    expect(harness.botHold('claude:unknown')).toBeUndefined()
  })

  it('work on Claude Code, a subagent on Codex: compiled with Codex\'s names, and it keeps commands, which Codex holds as tightly', async () => {
    const job = await work('w1', CLAUDE)
    expect(job.prepared.policy.tools!.allow).toContain('Bash')
    expect(await job.prepared.authority.subagents!.start({ title: 'Build', brief: 'Run the build.', model: on(CODEX, 'Codex', 'GPT-5.5') })).not.toHaveProperty('lacks')
    const child = await start(f, job.id, lastSubagent(job.id))
    expect(child.prepared.selection).toEqual(CODEX)
    expect(child.prepared.policy.tools!.allow).toContain('commandExecution')
    expect(child.prepared.policy.tools!.allow).not.toContain('Bash')
    expect(child.prepared.authority.check(command)).toEqual({ ok: true })
  })

  it('work on Codex, a subagent on Claude Code: compiled with Claude Code\'s names, without Bash, which Claude Code\'s sandbox on macOS holds less tightly', async () => {
    const job = await work('w1', CODEX)
    expect(await job.prepared.authority.subagents!.start({ title: 'Build', brief: 'Run the build.', model: on(CLAUDE, 'Claude Code', 'Sonnet') })).toMatchObject({ lacks: ['run commands'] })
    const child = await start(f, job.id, lastSubagent(job.id))
    expect(child.prepared.selection).toEqual(CLAUDE)
    expect(child.prepared.policy.tools!.allow).toContain('Read')
    expect(child.prepared.policy.tools!.allow).not.toContain('Bash')
    expect(child.prepared.authority.check(command)).toMatchObject({ ok: false })
  })

  it('with file access, work on Claude Code: a subagent on Codex runs without commands (Codex\'s sandbox then reads Mousse\'s own data)', async () => {
    const job = await work('w1', CLAUDE, { files: true })
    expect(await job.prepared.authority.subagents!.start({ title: 'Build', brief: 'Run the build.', model: on(CODEX, 'Codex', 'GPT-5.5') })).toMatchObject({ lacks: ['run commands'] })
    const child = await start(f, job.id, lastSubagent(job.id))
    // Codex names reads `commandExecution` too; what its thread reads is the authority's tools: without `shell` it
    // starts with no command tool at all (`CODEX_COMMAND_FEATURES` off, `codexBotTools.test.ts` on the real binary).
    expect(child.prepared.authority.tools.has('shell')).toBe(false)
    expect(child.prepared.authority.check(command)).toMatchObject({ ok: false })
    expect(child.prepared.policy.tools!.allow).toContain('fileChange')
    // The control: the work's own turn on Claude Code keeps them.
    expect(job.prepared.authority.tools.has('shell')).toBe(true)
  })
})
