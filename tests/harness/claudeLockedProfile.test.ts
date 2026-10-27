/**
 * PR 6 §3: the locked Claude Code profile, with a fake SDK `query` spy (evidence items 1, 4, 5, 7,
 * 14 and 15 as far as options and the gate decide them; the real-CLI items run in the process lane).
 * A bot turn on a locked entry loads nothing of the user's Claude Code setup, runs in its scratch
 * folder with exactly its granted built-ins, and Mousse's `PreToolUse` gate and `canUseTool` decide
 * every call. Interactive entries are untouched, and no locked entry holds a bot without evidence.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import type { HookCallback, Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import {
  CLAUDE_BUILTIN_TOOLS,
  claudeLockedCaps,
  claudeLockedHoldsBots,
  claudeManagedPolicyIn,
  ClaudeLockedGate,
  CLAUDE_MANAGED_POLICY_REFUSAL,
  claudeLockedSandbox,
  claudeLockedSpawn,
  claudeLockedTools,
  claudeSandboxFact,
  type ClaudeLockedTurn
} from '../../src/mms/harness/claude/locked'
import { CONTAINMENT_EVIDENCE, hasContainmentEvidence, type ContainmentEvidence } from '../../src/mms/harness/compatibility'
import { readClaudeManagedPolicy, remoteSettingsHoldPolicy, type PolicyCommandRunner } from '../../src/mms/harness/claude/managedPolicy'
import { checkPolicy } from '../../src/mms/harness/policy'
import type { DriverContext, InstanceConfig } from '../../src/mms/harness/driver'
import type { RunPolicy } from '../../src/shared/harness/types'
import { decodeInstanceConfig } from '../../src/mms/harness/driver'
import { CLAUDE_CODE_CAPS, CLAUDE_POLICY_REREAD_MS, CLAUDE_POLICY_TRUST_MS, claudeCodeDriver, claudeLocked } from '../../src/mms/harness/drivers/claudeCode'
import { instanceEnv, lockedEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/providers/claudeSubscription/ClaudeSubscriptionProviderService'
import { ClaudeSubscriptionAdapter } from '../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'
import type { NeutralTool } from '../../src/shared/harness/tools'

const repoRoot = resolve(__dirname, '..', '..')
const dirs: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  // Nothing of the user's own Claude Code reaches a test.
  vi.stubEnv('CLAUDE_CONFIG_DIR', temp('claude-locked-user-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function authorityFor(tools: NeutralTool[], workspace: { root: string; scratch: string; access?: 'read' | 'write' }, appTools: string[] = ['thread_read']) {
  return createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: { tools, appTools, mcp: [], skills: [], workspace: { roots: [workspace.root], access: workspace.access ?? 'write', scratch: workspace.scratch } },
    waiting: () => false,
    counters: { charge: () => ({ ok: true, count: 1 }) },
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
    spend: null
  })
}

type Probe = (options: Options) => Promise<void>

/** A locked entry's service with a fake `query` that runs `probe` on the options before its result. */
function lockedService(probe: Probe) {
  const home = temp('claude-locked-profile-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const instanceHome = join(home, 'instance-home')
  const captured: Options[] = []
  const query = ({ options }: { options: Options }): Query => {
    captured.push(options)
    const generator = (async function* () {
      await probe(options)
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'locked-session' }
    })()
    return Object.assign(generator, { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
  }
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    query,
    live: false,
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
    // The user's launch settings: ignored by a locked turn.
    launchConfig: () => ({ binaryPath: binary, args: ['--debug'], env: { USER_VARIABLE: 'from-settings' } }),
    lockedEnv: (scratch) => lockedEnv({ platform: process.platform, base: process.env, driver: 'claude', credential: 'subscription', home: instanceHome, scratch })
  })
  return { service, captured, instanceHome }
}

function fakeLedger() {
  const rows: Array<{ id: string; name: string; status: string }> = []
  const ledger: ToolLedger = {
    start: (call) => {
      rows.push({ id: `row-${rows.length}`, name: call.name, status: 'started' })
      return `row-${rows.length - 1}`
    },
    commit: (id) => { rows.find((row) => row.id === id)!.status = 'committed' },
    failed: (id) => { rows.find((row) => row.id === id)!.status = 'failed' }
  }
  return { rows, ledger }
}

const preToolUse = (options: Options): HookCallback => options.hooks!.PreToolUse![0].hooks[0]
const pre = (options: Options, tool: string, input: Record<string, unknown>, id = 'tu') =>
  preToolUse(options)({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '' } as never, id, { signal: new AbortController().signal })
const canUse = (options: Options, tool: string, input: Record<string, unknown>, id = 'tu') =>
  options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: id, requestId: 'r' } as never)

describe('locked Claude Code: launch options (item 1, 4, 7)', () => {
  it('loads nothing of the user\'s setup, runs in scratch, and offers exactly the granted built-ins', async () => {
    vi.stubEnv('SOME_USER_TOKEN', 'secret-from-parent')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-inherited')
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const { service, captured, instanceHome } = lockedService(async () => {})
    const authority = authorityFor(['read', 'search'], { root, scratch })
    const locked: ClaudeLockedTurn = { authority, cwd: scratch, shellContained: false, temps: [], systemPrompt: 'You are a bot.', ledger: fakeLedger().ledger }
    await service.chat({ threadId: 'bot-thread', cwd: scratch, model: 'sonnet', prompt: 'go', permissionMode: 'full', mcp: { url: 'http://127.0.0.1:1/mcp', token: 'bearer' }, mcpTurnToken: 'tok', locked, onText: vi.fn() })
    const options = captured[0]
    expect(options).toMatchObject({
      cwd: scratch,
      settingSources: [],
      strictMcpConfig: true,
      plugins: [],
      extraArgs: {},
      permissionMode: 'default',
      systemPrompt: 'You are a bot.',
      maxTurns: 100,
      tools: ['Glob', 'Grep', 'Read', 'ToolSearch']
    })
    for (const name of ['allowDangerouslySkipPermissions', 'additionalDirectories', 'allowedTools', 'sandbox', 'resume']) expect(options, name).not.toHaveProperty(name)
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['mousse'])
    expect(typeof options.spawnClaudeCodeProcess).toBe('function')
    // Every other built-in is turned off as well (item 4).
    expect(options.disallowedTools).toEqual(CLAUDE_BUILTIN_TOOLS.filter((name) => !['Glob', 'Grep', 'Read', 'ToolSearch'].includes(name)))
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Bash', 'Edit', 'Write', 'TodoWrite', 'Skill', 'CronCreate', 'Workflow', 'Monitor']))
    // The environment is built from nothing: no inherited credential or the user's variables (item 7).
    const env = options.env ?? {}
    expect(env.SOME_USER_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.USER_VARIABLE).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe(instanceHome)
    if (process.platform !== 'win32') expect(env.TMPDIR).toBe(join(scratch, 'tmp'))
  })

  it('a bot without a folder runs in an empty folder of Mousse\'s own, never the thread\'s project', async () => {
    const project = temp('claude-locked-project-')
    const service = { standaloneWorkspace: vi.fn(() => '/mousse/standalone/bot-thread'), chat: vi.fn(async () => 'done'), commitConversation: vi.fn(), configured: () => true }
    const adapter = new ClaudeSubscriptionAdapter(() => service as never, () => null, { admit: async () => ({ ok: true as const, shellContained: false }) })
    const authority = createBotAuthority({
      activationId: 'act-1', role: 'activation',
      permissions: { tools: [], appTools: [], mcp: [], skills: [], workspace: null },
      waiting: () => false, counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => 0, signal: new AbortController().signal }, spend: null
    })
    await adapter.startTurn(turnInput(project), sink(), control(), host({ bot: authority })).catch(() => undefined)
    const input = (service.chat.mock.calls[0] as unknown as [{ cwd: string; locked: ClaudeLockedTurn; integrations?: unknown; systemPromptAppend?: string }])[0]
    expect(input.cwd).toBe('/mousse/standalone/bot-thread')
    expect(input.locked.cwd).toBe('/mousse/standalone/bot-thread')
    expect(input.integrations).toBeUndefined()
    expect(input.systemPromptAppend).toBeUndefined()
    expect(input.locked.systemPrompt).toBe('Mousse instructions')
  })
})

describe('locked Claude Code: the grant gate (items 5, 7)', () => {
  it('PreToolUse denies what the grant does not hold and asks for the rest; canUseTool decides again', async () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const outside = temp('claude-locked-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const { rows, ledger } = fakeLedger()
    const decisions: Record<string, unknown> = {}
    const { service } = lockedService(async (options) => {
      decisions.readOutside = await pre(options, 'Read', { file_path: join(outside, 'secret.txt') })
      decisions.readInside = await pre(options, 'Read', { file_path: join(root, 'a.txt') })
      decisions.grepOutside = await pre(options, 'Grep', { pattern: 'secret', path: outside })
      decisions.globOutside = await pre(options, 'Glob', { pattern: '**/*', path: outside })
      decisions.globEscape = await pre(options, 'Glob', { pattern: `${outside}/**` })
      decisions.globUp = await pre(options, 'Glob', { pattern: '../**/secret.txt' })
      decisions.unknown = await pre(options, 'Agent', { prompt: 'x' })
      decisions.notGranted = await pre(options, 'Edit', { file_path: join(root, 'a.txt'), old_string: 'a', new_string: 'b' })
      decisions.shell = await pre(options, 'Bash', { command: 'ls' })
      decisions.mousse = await pre(options, 'mcp__mousse__thread_read', { limit: 5 })
      decisions.mousseRefused = await pre(options, 'mcp__mousse__thread_send', { text: 'x' })
      decisions.userMcp = await pre(options, 'mcp__github__create_issue', {})
      decisions.canReadOutside = await canUse(options, 'Read', { file_path: join(outside, 'secret.txt') }, 'tu-1')
      decisions.canReadInside = await canUse(options, 'Read', { file_path: join(root, 'a.txt') }, 'tu-2')
      decisions.canUnknown = await canUse(options, 'TodoWrite', { todos: [] }, 'tu-3')
    })
    const locked: ClaudeLockedTurn = { authority: authorityFor(['read', 'search'], { root, scratch }), ledger, cwd: scratch, shellContained: false, temps: [], systemPrompt: '' }
    await service.chat({ threadId: 'bot-thread', cwd: scratch, model: 'sonnet', prompt: 'go', mcp: { url: 'http://127.0.0.1:1/mcp', token: 'bearer' }, mcpTurnToken: 'tok', locked, onText: vi.fn() })
    const denied = (value: unknown) => (value as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'deny'
    const asked = (value: unknown) => (value as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision === 'ask'
    for (const key of ['readOutside', 'grepOutside', 'globOutside', 'globEscape', 'globUp', 'unknown', 'notGranted', 'shell', 'mousseRefused', 'userMcp']) expect(denied(decisions[key]), key).toBe(true)
    for (const key of ['readInside', 'mousse']) expect(asked(decisions[key]), key).toBe(true)
    // The gate never allows by itself, and stamps the turn token on Mousse's own calls.
    expect(decisions.mousse).toMatchObject({ hookSpecificOutput: { updatedInput: { limit: 5, _mousse_turn: 'tok' } } })
    expect(decisions.canReadOutside).toMatchObject({ behavior: 'deny' })
    expect(decisions.canReadInside).toMatchObject({ behavior: 'allow' })
    expect(decisions.canUnknown).toMatchObject({ behavior: 'deny' })
    // Only the allowed read has a row.
    expect(rows.map((row) => row.name)).toEqual(['Read'])
  })

  it('a bot never reaches the person: a call outside the grant is denied, never asked', async () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const questions = vi.spyOn(UserQuestionService.prototype, 'requestAnswers')
    const { service } = lockedService(async (options) => {
      await canUse(options, 'Bash', { command: 'rm -rf /' })
      await canUse(options, 'AskUserQuestion', { questions: [{ question: 'ok?' }] })
    })
    await service.chat({ threadId: 'bot-thread', cwd: scratch, model: 'sonnet', prompt: 'go', locked: { authority: authorityFor(['read'], { root, scratch }), cwd: scratch, shellContained: false, temps: [], systemPrompt: '' }, onText: vi.fn() })
    expect(questions).not.toHaveBeenCalled()
  })

  it('an entry that is not locked refuses a locked turn, and an interactive turn keeps the user\'s setup', async () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const home = temp('claude-interactive-')
    const binary = join(home, 'claude')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    const captured: Options[] = []
    const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
      live: false,
      runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      launchConfig: () => ({ binaryPath: binary }),
      query: ({ options }) => {
        captured.push(options)
        return Object.assign((async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' } })(), { close: vi.fn(), interrupt: vi.fn(async () => {}) }) as unknown as Query
      }
    })
    const locked: ClaudeLockedTurn = { authority: authorityFor(['read'], { root, scratch }), cwd: scratch, shellContained: false, temps: [], systemPrompt: '' }
    await expect(service.chat({ threadId: 't', cwd: scratch, model: 'sonnet', prompt: 'go', locked, onText: vi.fn() })).rejects.toMatchObject({ code: 'policy_unenforceable' })
    // Turn queries carry Mousse's hooks; a model listing does not.
    const turns = () => captured.filter((options) => options.hooks)
    expect(turns().length).toBe(0)
    await service.chat({ threadId: 't', cwd: root, model: 'sonnet', prompt: 'go', onText: vi.fn() })
    expect(turns().length).toBe(1)
    expect('settingSources' in turns()[0]).toBe(false)
    expect('tools' in turns()[0]).toBe(false)
    expect(turns()[0].systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
  })
})

describe('locked Claude Code: who runs bots', () => {
  it('a bot on an interactive entry, and a plain turn on a locked one, are refused before anything starts', async () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const service = { standaloneWorkspace: () => scratch, chat: vi.fn(async () => 'done'), commitConversation: vi.fn(), configured: () => true }
    const interactive = new ClaudeSubscriptionAdapter(() => service as never)
    await expect(interactive.startTurn(turnInput(root), sink(), control(), host({ bot: authorityFor(['read'], { root, scratch }) }))).rejects.toMatchObject({ code: 'policy_unenforceable' })
    const locked = new ClaudeSubscriptionAdapter(() => service as never, () => null, { admit: async () => ({ ok: true as const, shellContained: false }) })
    await expect(locked.startTurn(turnInput(root), sink(), control(), host({}))).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(service.chat).not.toHaveBeenCalled()
  })

  it('a locked turn is admitted again when it starts: a policy or a CLI version without evidence refuses it', async () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const service = { standaloneWorkspace: () => scratch, chat: vi.fn(async () => 'done'), commitConversation: vi.fn(), configured: () => true }
    const refusing = new ClaudeSubscriptionAdapter(() => service as never, () => null, { admit: async () => ({ ok: false as const, reason: 'No evidence for Claude Code 9.9.9 here.' }) })
    await expect(refusing.startTurn(turnInput(root), sink(), control(), host({ bot: authorityFor(['read'], { root, scratch }) }))).rejects.toMatchObject({ code: 'policy_unenforceable', message: 'No evidence for Claude Code 9.9.9 here.' })
    expect(service.chat).not.toHaveBeenCalled()
  })

  it('the user\'s own built-in entry is never locked', () => {
    const driver = claudeCodeDriver({ platform: 'linux', managedPolicy: () => false })
    expect(driver.decodeConfig({ home: 'private', profile: 'locked' }, 'claude')).not.toHaveProperty('profile')
    expect(driver.decodeConfig({ home: 'private', profile: 'locked' }, 'claude-bots')).toMatchObject({ profile: 'locked' })
    // So its caps (Plan mode included) stay the user's.
    expect(driver.caps(driver.decodeConfig({ home: 'private', profile: 'locked' }, 'claude'), '2.1.0')).toBe(CLAUDE_CODE_CAPS)
  })

  it('the locked profile is an entry setting, kept only with a home of its own', () => {
    expect(decodeInstanceConfig({ home: 'private', profile: 'locked' }, { privateHome: true })).toMatchObject({ home: 'private', profile: 'locked' })
    expect(decodeInstanceConfig({ home: 'default', profile: 'locked' }, { privateHome: true })).not.toHaveProperty('profile')
    expect(decodeInstanceConfig({ home: 'private', profile: 'other' }, { privateHome: true })).not.toHaveProperty('profile')
    expect(claudeLocked({ home: 'private', profile: 'locked' })).toBe(true)
    expect(claudeLocked({ home: 'default' })).toBe(false)
    const driver = claudeCodeDriver({ platform: 'linux', managedPolicy: () => false })
    expect(driver.privateHomeFor!({ home: 'default', profile: 'locked' })).toBe('required')
    expect(driver.privateHomeFor!({ home: 'default' })).toBe('allowed')
  })

  it('no locked entry holds a bot, or gets exact tool control, without recorded evidence (item 14)', () => {
    expect(CONTAINMENT_EVIDENCE).toEqual([])
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const driver = claudeCodeDriver({ platform, managedPolicy: () => false })
      expect(driver.botAuthority!({ home: 'private', profile: 'locked' }), platform).toBe(false)
      expect(driver.botAuthority!({ home: 'private' }), platform).toBe(false)
      expect(driver.caps({ home: 'private', profile: 'locked' }, '2.1.0')).toMatchObject({ toolControl: 'approval_only', containment: 'weak', budgets: 'unsupported', spendLimits: 'unsupported', childPolicy: 'enforced' })
      // The user's own entry is unchanged.
      expect(driver.caps({ home: 'default' }, '2.1.0')).toBe(CLAUDE_CODE_CAPS)
    }
    const evidence: ContainmentEvidence[] = [
      { driver: 'claude', kind: 'tools', cliVersion: '2.1.0', platform: 'linux', items: [1, 2, 3, 4, 5, 6, 7], recordedAt: '2026-10-27T00:00:00Z' },
      { driver: 'claude', kind: 'sandbox', cliVersion: '2.1.0', platform: 'linux', items: [8, 9, 10, 11, 12, 13, 14, 16, 17], recordedAt: '2026-10-27T00:00:00Z' }
    ]
    expect(claudeLockedCaps(CLAUDE_CODE_CAPS, { platform: 'linux', cliVersion: '2.1.0', managedPolicy: false, evidence })).toMatchObject({ toolControl: 'exact', containment: 'strong' })
    // Another version, an unknown version, or another platform proves nothing.
    expect(claudeLockedCaps(CLAUDE_CODE_CAPS, { platform: 'linux', cliVersion: '2.1.1', managedPolicy: false, evidence }).toolControl).toBe('approval_only')
    expect(claudeLockedCaps(CLAUDE_CODE_CAPS, { platform: 'linux', managedPolicy: false, evidence }).toolControl).toBe('approval_only')
    expect(claudeLockedCaps(CLAUDE_CODE_CAPS, { platform: 'darwin', cliVersion: '2.1.0', managedPolicy: false, evidence }).toolControl).toBe('approval_only')
    // An organisation's managed Claude Code policy downgrades the caps and refuses bots.
    expect(claudeLockedCaps(CLAUDE_CODE_CAPS, { platform: 'linux', cliVersion: '2.1.0', managedPolicy: true, evidence })).toMatchObject({ toolControl: 'approval_only', containment: 'weak' })
    // Gate-and-ledger evidence alone lets a locked entry hold a bot; the sandbox's is needed only
    // for shell (and `strong` containment), never for the authority.
    const toolsOnly = evidence.slice(0, 1)
    expect(claudeLockedHoldsBots('linux', false, toolsOnly)).toBe(true)
    expect(claudeLockedHoldsBots('linux', false, evidence)).toBe(true)
    expect(claudeLockedHoldsBots('linux', true, evidence)).toBe(false)
    expect(claudeLockedHoldsBots('win32', false, toolsOnly)).toBe(false)
    expect(claudeLockedHoldsBots('linux', false, evidence.slice(1))).toBe(false)
    expect(claudeLockedCaps(CLAUDE_CODE_CAPS, { platform: 'linux', cliVersion: '2.1.0', managedPolicy: false, evidence: toolsOnly })).toMatchObject({ toolControl: 'exact', containment: 'weak' })
    expect(hasContainmentEvidence({ driver: 'claude', kind: 'sandbox', platform: 'linux', cliVersion: undefined }, evidence)).toBe(false)
  })

  it('an organisation\'s policy from any source counts, as the SDK\'s resolver reports it (item 14)', async () => {
    const managed = (policyOrigin?: string, path?: string) => ({ sources: [{ source: 'managed' as const, settings: {}, ...(path ? { path } : {}), ...(policyOrigin ? { policyOrigin: policyOrigin as never } : {}) }] })
    for (const origin of ['remote', 'plist', 'hklm', 'hkcu', 'helper', 'file', 'parent'])
      expect(claudeManagedPolicyIn(managed(origin)), origin).toBe(true)
    // A `managed-settings.d` drop-in with no main file.
    expect(claudeManagedPolicyIn(managed('file', '/etc/claude-code/managed-settings.d/company.json'))).toBe(true)
    expect(claudeManagedPolicyIn({ sources: [{ source: 'userSettings' as never, settings: {} }] })).toBe(false)
    expect(claudeManagedPolicyIn({ sources: [] })).toBe(false)
  })

  it('reads the policy fresh every time, in a new process, and anything it cannot read counts (review r2)', async () => {
    const noFiles = () => false
    const missing = { size: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }) }, read: () => '' }
    // `reg query` listings, by key; `SOFTWARE` always lists `Policies` on a normal profile.
    const clean: Record<string, { code: number | null; stdout: string }> = {
      'HKLM\\SOFTWARE': { code: 0, stdout: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\r\n' },
      'HKLM\\SOFTWARE\\Policies': { code: 0, stdout: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\r\n' },
      'HKCU\\SOFTWARE': { code: 0, stdout: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\r\nHKEY_CURRENT_USER\\SOFTWARE\\Policies\r\n' },
      'HKCU\\SOFTWARE\\Policies': { code: 0, stdout: 'HKEY_CURRENT_USER\\SOFTWARE\\Policies\\Microsoft\r\n' },
      resolve: { code: 0, stdout: JSON.stringify({ sources: [] }) }
    }
    const runner = (answers: typeof clean) => {
      const calls: string[] = []
      const run: PolicyCommandRunner = async (command, args, options) => {
        const key = /reg\.exe$/i.test(command) ? args[1] : 'resolve'
        if (key !== 'resolve') expect(command).toMatch(/System32[\\/]reg\.exe$/)
        calls.push(key)
        if (key === 'resolve') {
          expect(args.slice(-2)).toEqual(['/sdk.mjs', '/w'])
          expect(options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: '/h' })
        }
        return answers[key]
      }
      return { run, calls }
    }
    const read = (answers: typeof clean, platform: NodeJS.Platform = 'win32', exists: (path: string) => boolean = noFiles) => {
      const { run, calls } = runner(answers)
      return readClaudeManagedPolicy({ cwd: '/w', home: '/h', platform, run, exists, files: missing, sdk: () => '/sdk.mjs', env: { SystemRoot: 'C:\\Windows' } }).then((managed) => ({ managed, calls }))
    }
    expect(await read(clean)).toEqual({ managed: false, calls: ['HKLM\\SOFTWARE', 'HKLM\\SOFTWARE\\Policies', 'HKCU\\SOFTWARE', 'HKCU\\SOFTWARE\\Policies', 'resolve'] })
    // Nothing is kept between readings: a policy that appears after a clean reading is seen by the next one.
    expect((await read({ ...clean, 'HKCU\\SOFTWARE\\Policies': { code: 0, stdout: 'HKEY_CURRENT_USER\\SOFTWARE\\Policies\\ClaudeCode\r\n' } })).managed).toBe(true)
    expect((await read({ ...clean, resolve: { code: 0, stdout: JSON.stringify({ sources: [{ source: 'managed', policyOrigin: 'plist' }] }) } })).managed).toBe(true)
    // A profile with no `Policies` key at all (its parent's listing does not name it): no policy there.
    const noUserPolicies = { ...clean, 'HKCU\\SOFTWARE': { code: 0, stdout: 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\r\n' } }
    expect(await read(noUserPolicies)).toEqual({ managed: false, calls: ['HKLM\\SOFTWARE', 'HKLM\\SOFTWARE\\Policies', 'HKCU\\SOFTWARE', 'resolve'] })
    // Any listing that fails (access denied looks like "not found" from `reg`'s exit code): a policy.
    expect((await read({ ...clean, 'HKLM\\SOFTWARE\\Policies': { code: 1, stdout: '' } })).managed).toBe(true)
    expect((await read({ ...clean, 'HKCU\\SOFTWARE': { code: 1, stdout: '' } })).managed).toBe(true)
    expect((await read({ ...noUserPolicies, 'HKCU\\SOFTWARE': { code: null, stdout: '' } })).managed).toBe(true)
    // A resolver that fails or prints nonsense: a policy.
    expect((await read({ ...clean, resolve: { code: 2, stdout: '' } })).managed).toBe(true)
    expect((await read({ ...clean, resolve: { code: null, stdout: '' } })).managed).toBe(true)
    expect((await read({ ...clean, resolve: { code: 0, stdout: 'not json' } })).managed).toBe(true)
    // Files: a drop-in folder with no main file, macOS MDM.
    const only = (suffix: string) => (path: string) => path.replace(/\\/g, '/').endsWith(suffix)
    expect((await read(clean, 'linux', only('/etc/claude-code/managed-settings.d'))).managed).toBe(true)
    expect((await read(clean, 'darwin', only('/Library/Managed Preferences/com.anthropic.claudecode.plist'))).managed).toBe(true)
    expect(await read(clean, 'linux')).toEqual({ managed: false, calls: ['resolve'] })
  })

  it('reads the entry\'s server-managed cache: Claude Code\'s empty sentinel is no policy, anything else is (review r3)', () => {
    const home = temp('claude-locked-remote-')
    const write = (text: string) => writeFileSync(join(home, 'remote-settings.json'), text)
    expect(remoteSettingsHoldPolicy(home)).toBe(false)
    write('{}')
    expect(remoteSettingsHoldPolicy(home)).toBe(false)
    write('{ "$schema": "https://json.schemastore.org/claude-code-settings.json", "$comment": "x" }\n')
    expect(remoteSettingsHoldPolicy(home)).toBe(false)
    for (const text of ['{"env":{"X":"1"}}', '{"$schema":"s","hooks":{}}', '{"permissions":{"allow":["Read"]}}', '[]', 'null', '"x"', '{', 'not json', ''])
      expect([text, remoteSettingsHoldPolicy(home, { size: () => text.length, read: () => text })]).toEqual([text, true])
    // Unreadable, or over Claude Code's size limit: a policy. Missing: none.
    const failing = (code: string) => ({ size: () => 10, read: () => { throw Object.assign(new Error(code), { code }) } })
    expect(remoteSettingsHoldPolicy(home, failing('EACCES'))).toBe(true)
    expect(remoteSettingsHoldPolicy(home, failing('EISDIR'))).toBe(true)
    expect(remoteSettingsHoldPolicy(home, failing('ENOENT'))).toBe(false)
    expect(remoteSettingsHoldPolicy(home, { size: () => 9 * 1024 * 1024, read: () => '{}' })).toBe(true)
    // The reader uses the same rule.
    const reader = (text?: string) => readClaudeManagedPolicy({ cwd: '/w', home, platform: 'linux', exists: () => false, sdk: () => '/sdk.mjs',
      files: text === undefined ? { size: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, read: () => '' } : { size: () => text.length, read: () => text },
      run: async () => ({ code: 0, stdout: JSON.stringify({ sources: [] }) }) })
    return Promise.all([reader('{}'), reader('{"$schema":"s"}'), reader('{"env":{}}'), reader('{oops'), reader()]).then((results) => expect(results).toEqual([false, false, true, true, false]))
  })

  it.skipIf(process.platform !== 'win32')('the real resolver runs in its own process and reads no policy on a clean machine', async () => {
    const home = temp('claude-locked-policy-home-')
    expect(await readClaudeManagedPolicy({ cwd: home, home })).toBe(false)
  }, 60_000)
})

describe('locked Claude Code: its policy reading outside a turn (review r2)', () => {
  const lockedConfig: InstanceConfig = { home: 'private', profile: 'locked' }
  const botPolicy: RunPolicy = { mode: 'default', origin: 'bot', tools: { allow: ['Read'] }, approvals: 'grants', approve: 'host', authority: { kind: 'bot', digest: 'd' } }
  const evidence = (): ContainmentEvidence[] => [{ driver: 'claude', kind: 'tools', cliVersion: '2.1.0', platform: process.platform, items: [1, 2, 3, 4, 5, 6, 7], recordedAt: '2026-10-27T00:00:00Z' }]

  function boundEntry(driver: ReturnType<typeof claudeCodeDriver>, instanceId: string) {
    const root = temp('claude-locked-entry-')
    const home = join(root, 'home')
    const context: DriverContext = {
      instanceId,
      builtIn: false,
      config: lockedConfig,
      env: instanceEnv({ instanceId, driver: 'claude', configRevision: 1, home, searchPath: [], base: { PATH: process.env.PATH } }),
      profileHome: root,
      installationHome: root,
      stateDir: join(root, 'state'),
      questions: new UserQuestionService(),
      findBinary: () => process.execPath,
      changed: vi.fn(),
      signedOut: () => false,
      saveLaunch: async () => {}
    }
    const runtime = driver.create(context)
    return { context, runtime, home }
  }
  /** What the gateway decides at approval and dispatch (`Harness.checkPolicy`), for this entry. */
  const gatewayCheck = (driver: ReturnType<typeof claudeCodeDriver>, instanceId: string) =>
    checkPolicy(driver.caps(lockedConfig, '2.1.0', undefined, instanceId), botPolicy, instanceId, undefined, { hostApprovals: driver.botAuthority!(lockedConfig, instanceId) === true, botRuntimeGaps: [] })

  it('a locked entry with no policy and tools evidence holds a bot at approval and dispatch, without the managedPolicy seam', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const reads: Array<string | undefined> = []
      const driver = claudeCodeDriver({ evidence: evidence(), readPolicy: async (input) => { reads.push(input.home); return false } })
      // Nothing read yet: nothing claimed.
      expect(gatewayCheck(driver, 'claude-bots').ok).toBe(false)
      const { context, runtime, home } = boundEntry(driver, 'claude-bots')
      // Binding the runtime reads its policy and tells the gateway.
      await vi.waitFor(() => expect(context.changed).toHaveBeenCalled())
      expect(reads).toEqual([home])
      expect(driver.caps(lockedConfig, '2.1.0', undefined, 'claude-bots').toolControl).toBe('exact')
      expect(driver.botAuthority!(lockedConfig, 'claude-bots')).toBe(true)
      // Approval: read again first (`readPolicyFacts`), then the check passes.
      vi.setSystemTime(Date.now() + CLAUDE_POLICY_REREAD_MS + 1)
      await driver.readPolicyFacts!(lockedConfig, 'claude-bots')
      expect(gatewayCheck(driver, 'claude-bots')).toEqual({ ok: true })
      expect(reads.length).toBe(2)
      // Dispatch, later: read again, then the gateway's admission moments after uses that same
      // reading (one reading per bot turn), and the check passes each time.
      vi.setSystemTime(Date.now() + 10_000)
      await driver.readPolicyFacts!(lockedConfig, 'claude-bots')
      expect(gatewayCheck(driver, 'claude-bots')).toEqual({ ok: true })
      await driver.readPolicyFacts!(lockedConfig, 'claude-bots')
      expect(gatewayCheck(driver, 'claude-bots')).toEqual({ ok: true })
      expect(reads.length).toBe(3)
      runtime.stop?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('check points that come while a reading runs wait for it: one reading', async () => {
    let release: (value: boolean) => void = () => {}
    let reads = 0
    const driver = claudeCodeDriver({ evidence: evidence(), readPolicy: () => { reads += 1; return new Promise<boolean>((resolve) => { release = resolve }) } })
    boundEntry(driver, 'claude-c')
    const waiting = [driver.readPolicyFacts!(lockedConfig, 'claude-c'), driver.readPolicyFacts!(lockedConfig, 'claude-c')]
    release(false)
    await Promise.all(waiting)
    expect(reads).toBe(1)
    expect(driver.botAuthority!(lockedConfig, 'claude-c')).toBe(true)
  })

  it('one entry\'s reading never answers for another, and a stale or policy reading claims nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let policy = false
      const driver = claudeCodeDriver({ evidence: evidence(), readPolicy: async () => policy })
      boundEntry(driver, 'claude-a')
      await driver.readPolicyFacts!(lockedConfig, 'claude-a')
      expect(driver.botAuthority!(lockedConfig, 'claude-a')).toBe(true)
      // Another entry, never bound or read: nothing.
      expect(driver.botAuthority!(lockedConfig, 'claude-b')).toBe(false)
      expect(driver.botAuthority!(lockedConfig)).toBe(false)
      // A "no policy" reading is trusted for a short while only.
      vi.setSystemTime(Date.now() + CLAUDE_POLICY_TRUST_MS + 1)
      expect(driver.botAuthority!(lockedConfig, 'claude-a')).toBe(false)
      // A policy that appeared is seen by the next reading (past the re-read window).
      policy = true
      await driver.readPolicyFacts!(lockedConfig, 'claude-a')
      expect(driver.botAuthority!(lockedConfig, 'claude-a')).toBe(false)
      expect(driver.caps(lockedConfig, '2.1.0', undefined, 'claude-a').toolControl).toBe('approval_only')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a server-managed policy that lands during a turn denies its every later call; Claude Code\'s empty sentinel does not (review r3)', () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const home = temp('claude-locked-home-')
    // As the driver wires it: the entry's own cache, read by the same rule.
    const gate = new ClaudeLockedGate({ authority: authorityFor(['read'], { root, scratch }), cwd: scratch, shellContained: false, temps: [], systemPrompt: '', policyAppeared: () => remoteSettingsHoldPolicy(home) }, false)
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') }).ok).toBe(true)
    // The CLI saves its sentinel mid-turn: the organisation has no settings, and the turn goes on.
    writeFileSync(join(home, 'remote-settings.json'), '{}')
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') }).ok).toBe(true)
    expect(gate.canUse('Read', { file_path: join(root, 'a') }, 'tu-1').ok).toBe(false) // no ledger here: refused for that reason only
    writeFileSync(join(home, 'remote-settings.json'), '{"$schema":"s"}')
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') }).ok).toBe(true)
    // A real policy lands: every later call is denied.
    writeFileSync(join(home, 'remote-settings.json'), '{"hooks":{"SessionStart":[]}}')
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') })).toEqual({ ok: false, reason: CLAUDE_MANAGED_POLICY_REFUSAL })
    writeFileSync(join(home, 'remote-settings.json'), '{"env":')
    expect(gate.preToolUse('Read', { file_path: join(root, 'a') })).toEqual({ ok: false, reason: CLAUDE_MANAGED_POLICY_REFUSAL })
  })
})

describe('locked Claude Code: shell (item 15)', () => {
  it('the sandbox is a fact of the platform: unsupported on Windows, missing without bwrap and socat', () => {
    expect(claudeSandboxFact('win32', () => true)).toBe('unsupported')
    expect(claudeSandboxFact('darwin', () => false)).toBe('available')
    expect(claudeSandboxFact('linux', (name) => name === 'bwrap')).toBe('missing')
    expect(claudeSandboxFact('linux', () => true)).toBe('available')
  })

  it('a shell grant without a proven sandbox is neither offered nor allowed', () => {
    const root = temp('claude-locked-root-')
    const scratch = temp('claude-locked-scratch-')
    const authority = authorityFor(['read', 'shell'], { root, scratch })
    expect(claudeLockedTools({ authority, shellContained: false }, false).tools).toEqual(['Read'])
    expect(claudeLockedTools({ authority, shellContained: true }, false).tools).toEqual(['Bash', 'Read'])
  })

  it('compiles the sandbox: explicit denials, scratch as the only extra write for a read-only grant, no network, no key', () => {
    const sandbox = claudeLockedSandbox({ workspace: { roots: ['/home/me/site'], access: 'read', scratch: '/p/bots/scratch/a' }, temps: ['/tmp', '/var/tmp'], home: '/home/me' })
    expect(sandbox).toMatchObject({
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, excludedCommands: [], enableWeakerNestedSandbox: false,
      filesystem: { allowWrite: ['/p/bots/scratch/a'], denyWrite: ['/home/me/site', '/tmp', '/var/tmp'], denyRead: ['/home/me'], allowRead: ['/home/me/site', '/p/bots/scratch/a'] },
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false }
    })
    expect(sandbox.credentials?.envVars).toEqual(expect.arrayContaining([{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }]))
    const write = claudeLockedSandbox({ workspace: { roots: ['/home/me/site'], access: 'write', scratch: '/s' }, temps: ['/tmp'], home: '/home/me' })
    expect(write.filesystem).toMatchObject({ allowWrite: ['/home/me/site', '/s'], denyWrite: ['/tmp'] })
  })
})

describe('locked Claude Code: its own spawn (item 1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  function fakeChild(pid = 4242) {
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    return Object.assign(new EventEmitter(), { pid, stdin: { destroy: vi.fn() }, stdout: { destroy: vi.fn() }, stderr, killed: false, exitCode: null })
  }
  const signal = () => new AbortController().signal

  it('passes the SDK\'s command, arguments, folder and environment through unchanged, in its own group on POSIX', () => {
    const spawn = vi.fn(() => fakeChild())
    const onProcess = vi.fn()
    const options = { command: '/usr/bin/claude', args: ['--output-format', 'stream-json'], cwd: '/scratch', env: { PATH: '/bin', TMPDIR: '/scratch/tmp' }, signal: signal() }
    claudeLockedSpawn({ platform: 'linux', spawn: spawn as never, onProcess, signalGroup: vi.fn() })(options)
    // stdio as the SDK's own spawn: the CLI's error output is kept.
    expect(spawn).toHaveBeenCalledWith('/usr/bin/claude', ['--output-format', 'stream-json'], expect.objectContaining({ cwd: '/scratch', env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }))
    expect(onProcess).toHaveBeenCalledWith(4242)
    claudeLockedSpawn({ platform: 'win32', spawn: spawn as never, killTree: vi.fn() })(options)
    expect(spawn.mock.calls[1]).toEqual(['/usr/bin/claude', options.args, expect.objectContaining({ detached: false })])
  })

  it('on POSIX, ends the group at the forwarded abort and at the exit: SIGTERM, then SIGKILL after the grace if anyone is left', () => {
    vi.useFakeTimers()
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    let alive = true
    const signalGroup = (pid: number, sig: NodeJS.Signals | 0) => {
      sent.push([pid, sig])
      if (sig === 'SIGKILL') alive = false
      if (!alive && sig === 0) throw new Error('ESRCH')
    }
    const child = fakeChild()
    const controller = new AbortController()
    claudeLockedSpawn({ platform: 'linux', spawn: (() => child) as never, signalGroup, graceMs: 2_000 })({ command: 'c', args: [], env: {}, signal: controller.signal })
    child.emit('exit', 0, null)
    expect(sent).toEqual([[4242, 'SIGTERM']])
    vi.advanceTimersByTime(2_000)
    expect(sent).toEqual([[4242, 'SIGTERM'], [4242, 0], [4242, 'SIGKILL']])
    // Ended once: a later abort sends nothing.
    controller.abort()
    expect(sent.length).toBe(3)

    // A group that went at SIGTERM is not killed again.
    const quiet: Array<NodeJS.Signals | 0> = []
    const aborted = new AbortController()
    claudeLockedSpawn({ platform: 'linux', spawn: (() => fakeChild(5151)) as never, signalGroup: (_pid, sig) => { quiet.push(sig); if (sig === 0) throw new Error('ESRCH') }, graceMs: 2_000 })({ command: 'c', args: [], env: {}, signal: aborted.signal })
    aborted.abort()
    vi.advanceTimersByTime(2_000)
    expect(quiet).toEqual(['SIGTERM', 0])
  })

  it('on Windows, ends the tree at the abort while the CLI runs, and never after its exit', () => {
    const killTree = vi.fn()
    const running = new AbortController()
    claudeLockedSpawn({ platform: 'win32', spawn: (() => fakeChild(6161)) as never, killTree })({ command: 'c', args: [], env: {}, signal: running.signal })
    running.abort()
    expect(killTree).toHaveBeenCalledWith(6161)
    const exited = fakeChild(7171)
    const later = new AbortController()
    claudeLockedSpawn({ platform: 'win32', spawn: (() => exited) as never, killTree })({ command: 'c', args: [], env: {}, signal: later.signal })
    exited.emit('exit', 0, null)
    later.abort()
    expect(killTree).toHaveBeenCalledTimes(1)
  })

  it('a process whose registration fails is killed at once, and the spawn fails (review: no unsupervised child)', () => {
    const sent: Array<NodeJS.Signals | 0> = []
    const child = fakeChild()
    const spawn = claudeLockedSpawn({ platform: 'linux', spawn: (() => child) as never, signalGroup: (_pid, sig) => { sent.push(sig) }, onProcess: () => { throw new Error('supervisor unavailable') } })
    expect(() => spawn({ command: 'c', args: [], env: {}, signal: signal() })).toThrow('supervisor unavailable')
    expect(sent).toEqual(['SIGKILL'])
    expect(child.stdin.destroy).toHaveBeenCalled()
    expect(child.stdout.destroy).toHaveBeenCalled()
    const killTree = vi.fn()
    expect(() => claudeLockedSpawn({ platform: 'win32', spawn: (() => fakeChild(8181)) as never, killTree, onProcess: () => { throw new Error('x') } })({ command: 'c', args: [], env: {}, signal: signal() })).toThrow('x')
    expect(killTree).toHaveBeenCalledWith(8181)
  })

  it('keeps the tail of the CLI\'s error output for a failed turn', () => {
    const onStderr = vi.fn()
    const child = fakeChild()
    claudeLockedSpawn({ platform: 'linux', spawn: (() => child) as never, signalGroup: () => { throw new Error('ESRCH') }, onStderr })({ command: 'c', args: [], env: {}, signal: signal() })
    child.stderr.emit('data', 'x'.repeat(5_000))
    child.stderr.emit('data', 'Error: the model refused')
    child.emit('exit', 1, null)
    expect(onStderr).toHaveBeenCalledTimes(1)
    const [tail, code] = onStderr.mock.calls[0] as [string, number]
    expect(code).toBe(1)
    expect(tail.endsWith('Error: the model refused')).toBe(true)
    expect(tail.length).toBeLessThanOrEqual(4_000)
  })

  it.skipIf(process.platform === 'win32')('a real child in its own group is gone after the abort (POSIX)', async () => {
    const controller = new AbortController()
    const child = claudeLockedSpawn({ graceMs: 200 })({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: { ...process.env }, signal: controller.signal }) as unknown as { pid: number }
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(() => process.kill(-child.pid, 0)).toThrow()
  })
})

describe('locked Claude Code: the pinned SDK', () => {
  it('every built-in in ToolInputSchemas is listed, so a locked turn can turn it off', () => {
    const source = readFileSync(join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts'), 'utf8')
    const union = /export type ToolInputSchemas =([^;]*);/.exec(source)?.[1]
    expect(union).toBeDefined()
    const schemas = [...union!.matchAll(/\|\s*(\w+)/g)].map((match) => match[1]).filter((name) => name.endsWith('Input'))
    const renamed: Record<string, string | null> = {
      FileReadInput: 'Read', FileEditInput: 'Edit', FileWriteInput: 'Write',
      ListMcpResourcesInput: 'ListMcpResourcesTool', ReadMcpResourceInput: 'ReadMcpResourceTool',
      // The schema of every MCP tool call, not a built-in.
      McpInput: null
    }
    const names = schemas.map((schema) => (schema in renamed ? renamed[schema] : schema.replace(/Input$/, ''))).filter((name): name is string => name !== null)
    expect(names.length).toBeGreaterThan(30)
    expect(names.filter((name) => !CLAUDE_BUILTIN_TOOLS.includes(name))).toEqual([])
  })
})

function turnInput(cwd: string) {
  return { runId: 'run-1', threadId: 'bot-thread', instanceId: 'claude-bot', llmProvider: 'claude-subscription', model: 'sonnet', prompt: 'go', cwd, signal: new AbortController().signal, permissionMode: 'full' } as never
}
function sink() {
  return new Proxy({}, { get: () => () => undefined }) as never
}
function control() {
  return { heartbeat: () => undefined, drainSteer: () => undefined } as never
}
function host(extra: Record<string, unknown>) {
  return {
    tools: {},
    bridge: { mcp: null, turnToken: 't', sessionInstructions: 'Mousse instructions', turnPreamble: '', userMcp: 'native' },
    context: { prepareNativeContext: () => undefined, recoverOverflow: () => null, nativeHistoryAfterTurn: () => '' },
    ...extra
  } as never
}
