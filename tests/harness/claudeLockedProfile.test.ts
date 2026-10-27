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
  claudeLockedSandbox,
  claudeLockedSpawn,
  claudeLockedTools,
  claudeSandboxFact,
  type ClaudeLockedTurn
} from '../../src/mms/harness/claude/locked'
import { CONTAINMENT_EVIDENCE, hasContainmentEvidence, type ContainmentEvidence } from '../../src/mms/harness/compatibility'
import { decodeInstanceConfig } from '../../src/mms/harness/driver'
import { CLAUDE_CODE_CAPS, claudeCodeDriver, claudeLocked } from '../../src/mms/harness/drivers/claudeCode'
import { lockedEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { claudeManagedPolicyPresent } from '../../src/mms/providers/claudeSubscription/accountSubject'
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
    const adapter = new ClaudeSubscriptionAdapter(() => service as never, () => null, { shellContained: async () => false })
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
    const locked = new ClaudeSubscriptionAdapter(() => service as never, () => null, { shellContained: async () => false })
    await expect(locked.startTurn(turnInput(root), sink(), control(), host({}))).rejects.toMatchObject({ code: 'policy_unenforceable' })
    expect(service.chat).not.toHaveBeenCalled()
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
    expect(claudeLockedHoldsBots('linux', false, evidence)).toBe(true)
    expect(claudeLockedHoldsBots('linux', true, evidence)).toBe(false)
    // Gate and ledger evidence alone is not enough: the sandbox's is needed too.
    expect(claudeLockedHoldsBots('linux', false, evidence.slice(0, 1))).toBe(false)
    expect(hasContainmentEvidence({ driver: 'claude', kind: 'sandbox', platform: 'linux', cliVersion: undefined }, evidence)).toBe(false)
  })

  it('reads the managed-settings files Claude Code reads', () => {
    expect(claudeManagedPolicyPresent('linux', (path) => path === '/etc/claude-code/managed-settings.json')).toBe(true)
    expect(claudeManagedPolicyPresent('darwin', () => false)).toBe(false)
    expect(claudeManagedPolicyPresent('win32', (path) => path.startsWith('C:\\ProgramData'))).toBe(true)
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
  function fakeChild(pid = 4242) {
    return Object.assign(new EventEmitter(), { pid, stdin: {}, stdout: {}, killed: false, exitCode: null })
  }

  it('passes the SDK\'s command, arguments, folder and environment through unchanged, in its own group on POSIX', () => {
    const spawn = vi.fn(() => fakeChild())
    const onProcess = vi.fn()
    const options = { command: '/usr/bin/claude', args: ['--output-format', 'stream-json'], cwd: '/scratch', env: { PATH: '/bin', TMPDIR: '/scratch/tmp' }, signal: new AbortController().signal }
    claudeLockedSpawn({ platform: 'linux', spawn: spawn as never, onProcess, killTree: vi.fn() })(options)
    expect(spawn).toHaveBeenCalledWith('/usr/bin/claude', ['--output-format', 'stream-json'], expect.objectContaining({ cwd: '/scratch', env: options.env, detached: true }))
    expect(onProcess).toHaveBeenCalledWith(4242)
    claudeLockedSpawn({ platform: 'win32', spawn: spawn as never, killTree: vi.fn() })(options)
    expect(spawn.mock.calls[1]).toEqual(['/usr/bin/claude', options.args, expect.objectContaining({ detached: false })])
  })

  it('ends the whole group at the SDK\'s forwarded abort and at every exit on POSIX; never after a Windows exit', () => {
    const killTree = vi.fn()
    const child = fakeChild()
    const controller = new AbortController()
    claudeLockedSpawn({ platform: 'linux', spawn: (() => child) as never, killTree })({ command: 'c', args: [], env: {}, signal: controller.signal })
    child.emit('exit', 0, null)
    expect(killTree).toHaveBeenCalledWith(4242)
    controller.abort()
    expect(killTree).toHaveBeenCalledTimes(1)

    const aborted = new AbortController()
    const second = fakeChild(5151)
    claudeLockedSpawn({ platform: 'linux', spawn: (() => second) as never, killTree })({ command: 'c', args: [], env: {}, signal: aborted.signal })
    aborted.abort()
    expect(killTree).toHaveBeenLastCalledWith(5151)

    const windowsKill = vi.fn()
    const third = fakeChild(6161)
    claudeLockedSpawn({ platform: 'win32', spawn: (() => third) as never, killTree: windowsKill })({ command: 'c', args: [], env: {}, signal: new AbortController().signal })
    third.emit('exit', 0, null)
    expect(windowsKill).not.toHaveBeenCalled()
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
