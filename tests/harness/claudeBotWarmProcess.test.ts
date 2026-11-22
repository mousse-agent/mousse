/**
 * A bot's chat keeps one Claude Code process warm between its turns on the owner's entry (docs/bots.md, Warm chat
 * process): reused only while its launch stays the same, refusing every call between turns, closed when a turn fails,
 * runs a command, or the bot's launch changes. Work turns stay one process per turn.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { turnTimingBegin, turnTimingBind, turnTimingForget } from '../../src/mms/diagnostics/turnTiming'
import type { ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { NeutralTool } from '../../src/shared/harness/tools'
import { FakeClaudeCli, resultFrame } from '../run/fakeClaudeCli'

const dirs: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  const home = temp('claude-warm-user-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', home)
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'test-account' } }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(runAuth: () => Promise<string> = async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })) {
  const home = temp('claude-warm-home-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }] }))
  const cli = new FakeClaudeCli()
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    launchConfig: () => ({ binaryPath: binary }),
    query: cli.query,
    live: { noticeDelayMs: 10 },
    runAuth: vi.fn(runAuth)
  })
  const root = temp('claude-warm-files-')
  const scratch = temp('claude-warm-scratch-')
  /** A chat turn of the bot: `warm` is what `BotEngine.authorityFor` sets for the chat's own turns. */
  const lockedTurn = (options: { warm?: string; tools?: NeutralTool[]; systemPrompt?: string; commandsRefused?: string } = {}): ClaudeLockedTurn => {
    const controller = new AbortController()
    const authority = createBotAuthority({
      activationId: 'act-1',
      role: 'activation',
      permissions: { tools: options.tools ?? ['read'], appTools: [], mcp: [], skills: [], workspace: { roots: [root], access: 'write', scratch } },
      waiting: () => false,
      counters: { charge: () => ({ ok: true, count: 1 }) },
      time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: controller.signal },
      spend: null
    })
    const warm = 'warm' in options ? options.warm : 'chat:activation:grant-1'
    return {
      authority: { ...authority, ...(warm ? { warm } : {}) },
      ownerEntry: true,
      cwd: root,
      shellContained: false,
      shellOpen: true,
      temps: [],
      systemPrompt: options.systemPrompt ?? 'You are a bot.',
      ...(options.commandsRefused ? { commandsRefused: options.commandsRefused } : {}),
      ledger: { start: () => 'row', commit: () => undefined, failed: () => undefined }
    }
  }
  const turn = async (locked: ClaudeLockedTurn, model = 'sonnet') => {
    const text = await service.chat({ threadId: 'bot-home', cwd: root, model, prompt: 'hi', locked, onText: vi.fn() })
    service.commitConversation('bot-home', '')
    return text
  }
  return { service, cli, lockedTurn, turn }
}

const preToolUse = (options: Options) => options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback
const decision = (output: unknown) => (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
const canUse = (options: Options) =>
  options.canUseTool!('Read', { file_path: 'notes.md' }, { signal: new AbortController().signal, toolUseID: 'tu-late', requestId: 'r' } as never)

describe("a bot's warm chat process", () => {
  it('runs every chat turn on one process while the launch stays the same', async () => {
    const { cli, lockedTurn, turn } = fixture()
    expect(await turn(lockedTurn())).toBe('reply to 1')
    expect(await turn(lockedTurn())).toBe('reply to 2')
    expect(cli.processes).toHaveLength(1)
    expect(cli.last.inputs).toHaveLength(2)
    expect(cli.last.closed).toBe(false)
  })

  it('refuses every call between turns, through the hook and canUseTool', async () => {
    const { cli, lockedTurn, turn } = fixture()
    await turn(lockedTurn())
    const options = cli.last.options
    const hook = await preToolUse(options)({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'notes.md' }, tool_use_id: 'tu-late' } as never, 'tu-late', { signal: new AbortController().signal })
    expect(decision(hook)).toBe('deny')
    expect(await canUse(options)).toMatchObject({ behavior: 'deny' })
  })

  it.each([
    ['grant', { warm: 'chat:activation:grant-2' }, 'sonnet'],
    ['system prompt', { systemPrompt: 'You are a changed bot.' }, 'sonnet'],
    ['model', {}, 'opus']
  ] as const)('starts a fresh process when its %s changes, and closes the old one', async (_name, change, model) => {
    const { cli, lockedTurn, turn } = fixture()
    await turn(lockedTurn())
    await turn(lockedTurn(change), model)
    expect(cli.processes).toHaveLength(2)
    expect(cli.processes[0]!.closed).toBe(true)
  })

  it('closes the process when a turn fails; the next turn starts a fresh one', async () => {
    const { cli, lockedTurn, turn } = fixture()
    await turn(lockedTurn())
    cli.last.onInput = (message, process) => process.emit(resultFrame({ uuids: [String(message.uuid)], error: 'boom' }))
    await expect(turn(lockedTurn())).rejects.toThrow()
    expect(cli.processes[0]!.closed).toBe(true)
    await turn(lockedTurn())
    expect(cli.processes).toHaveLength(2)
  })

  it('closes an idle process when the bot asks (pause, delete, a permission change)', async () => {
    const { service, cli, lockedTurn, turn } = fixture()
    await turn(lockedTurn())
    expect(service.releaseBotProcess('bot-home')).toBe(true)
    expect(cli.last.closed).toBe(true)
    expect(service.releaseBotProcess('bot-home')).toBe(false)
  })

  it('keeps a work turn to one process per turn', async () => {
    const { cli, lockedTurn, turn } = fixture()
    await turn(lockedTurn({ warm: undefined }))
    await turn(lockedTurn({ warm: undefined }))
    expect(cli.processes).toHaveLength(2)
  })

  it('an older bot probe cannot use a process after status observes another account', async () => {
    const signedIn = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
    let holdNext = false
    let began!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    const oldReading = new Promise<string>((resolve) => { finish = () => resolve(signedIn) })
    const { service, cli, lockedTurn, turn } = fixture(() => {
      if (!holdNext) return Promise.resolve(signedIn)
      holdNext = false
      began()
      return oldReading
    })
    await turn(lockedTurn())
    const old = cli.last
    holdNext = true
    const pending = turn(lockedTurn())
    void pending.catch(() => undefined)
    await started
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'other' } }))
    await expect(service.status({ force: true })).resolves.toMatchObject({ state: 'connected' })
    expect(old.closed).toBe(true)
    finish()
    await expect(pending).rejects.toThrow()
    expect(old.inputs).toHaveLength(1)
    await expect(turn(lockedTurn())).resolves.toBe('reply to 1')
  })

  it.each(['credential change', 'unknown subject', 'sign-out'] as const)('the warm bot waits for its own probe (%s)', async (change) => {
    const signedIn = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
    let nextProbe: Promise<string> | undefined
    let probing!: () => void
    const started = new Promise<void>((resolve) => { probing = resolve })
    const { cli, lockedTurn, turn } = fixture(() => {
      if (!nextProbe) return Promise.resolve(signedIn)
      probing()
      return nextProbe
    })
    await turn(lockedTurn())
    const old = cli.last
    let finish!: (result: string) => void
    nextProbe = new Promise<string>((resolve) => { finish = resolve })
    if (change === 'unknown subject') rmSync(join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json'))
    const replying = turn(lockedTurn())
    void replying.catch(() => undefined)
    await started
    expect(old.inputs).toHaveLength(1)
    expect(cli.processes).toHaveLength(1)
    if (change === 'sign-out') {
      finish(JSON.stringify({ loggedIn: false }))
      await expect(replying).rejects.toThrow()
      expect(cli.processes).toHaveLength(1)
    } else {
      finish(change === 'credential change' ? JSON.stringify({ loggedIn: true, authMethod: 'api_key' }) : signedIn)
      await expect(replying).resolves.toBe('reply to 1')
      expect(cli.processes).toHaveLength(2)
      if (change === 'unknown subject') {
        await expect(turn(lockedTurn())).resolves.toBe('reply to 1')
        expect(cli.processes).toHaveLength(3)
      }
    }
    expect(old.inputs).toHaveLength(1)
    expect(old.closed).toBe(true)
  })
})

// A chat turn offered commands keeps its process for the next turn unless it ran one. A command is noted before the
// call is let through, by the hook or by canUseTool, whichever comes first: it may outlive its call, so the process
// that ran it closes at the turn's end with everything it started.
type Call = { tool: string; input: Record<string, unknown>; through: 'hook' | 'canUseTool' | 'both' }
const BASH = { command: 'echo hi' }
describe('a warm chat turn offered commands', () => {
  it.each<{ case: string; calls: Call[]; commandsRefused?: string; kept: boolean }>([
    { case: 'runs none', calls: [], kept: true },
    { case: 'reads a file', calls: [{ tool: 'Read', input: { file_path: 'notes.md' }, through: 'both' }], kept: true },
    { case: 'runs a command', calls: [{ tool: 'Bash', input: BASH, through: 'both' }], kept: false },
    { case: 'runs a command only the hook saw', calls: [{ tool: 'Bash', input: BASH, through: 'hook' }], kept: false },
    { case: 'runs a command only canUseTool saw', calls: [{ tool: 'Bash', input: BASH, through: 'canUseTool' }], kept: false },
    { case: 'asks for a command that is refused', calls: [{ tool: 'Bash', input: BASH, through: 'both' }], commandsRefused: 'Commands are off for this bot.', kept: true }
  ])('$case: process kept $kept', async ({ calls, commandsRefused, kept }) => {
    const { cli, lockedTurn, turn } = fixture()
    const decisions: string[] = []
    let first = true
    cli.reply = async (message, process) => {
      if (first) {
        first = false
        for (const [index, call] of calls.entries()) {
          const id = `tu-${index}`
          if (call.through !== 'canUseTool') {
            const hooked = await preToolUse(process.options)({ hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input, tool_use_id: id } as never, id, { signal: new AbortController().signal })
            decisions.push(`hook:${decision(hooked) ?? 'ask'}`)
          }
          if (call.through !== 'hook') {
            const allowed = await process.options.canUseTool!(call.tool, call.input, { signal: new AbortController().signal, toolUseID: id, requestId: 'r' } as never)
            decisions.push(`canUse:${allowed.behavior}`)
          }
        }
      }
      process.answer(String(message.uuid), `reply to ${process.inputs.length}`)
    }
    const offered = { tools: ['read', 'shell'] as NeutralTool[], ...(commandsRefused ? { commandsRefused } : {}) }
    expect(await turn(lockedTurn(offered))).toBe('reply to 1')
    // Calls the gate refused ran nothing; the rest were let through.
    expect(decisions.every((made) => commandsRefused ? made.endsWith('deny') : !made.endsWith('deny'))).toBe(true)
    await turn(lockedTurn(offered))
    expect(cli.processes).toHaveLength(kept ? 1 : 2)
    expect(cli.processes[0]!.closed).toBe(!kept)
  })
})

// Where a chat reply's time went: one line per turn, from the owner's message to the reply's first word, in order.
describe("a bot chat turn's timing line", () => {
  const timed = async (prepare: () => void) => {
    const { lockedTurn, turn } = fixture()
    const lines: string[] = []
    const info = vi.spyOn(console, 'info').mockImplementation((line: unknown) => { if (String(line).startsWith('[turn-timing]')) lines.push(String(line)) })
    try {
      for (let i = 0; i < 2; i++) {
        prepare()
        await turn(lockedTurn())
      }
    } finally { info.mockRestore() }
    return lines.map((line) => JSON.parse(line.slice('[turn-timing] '.length)) as { threadId: string; ms: Record<string, number> })
  }

  it('is logged once per turn, with the steps in the order they happened and the warm process named', async () => {
    const turns = await timed(() => { turnTimingBegin('bot-1'); turnTimingBind('bot-1', 'bot-home') })
    expect(turns.map((logged) => logged.threadId)).toEqual(['bot-home', 'bot-home'])
    expect(turns.map((logged) => Object.keys(logged.ms))).toEqual([
      ['dispatch', 'provider', 'signIn', 'processNew', 'prompt', 'firstFrame', 'firstText'],
      ['dispatch', 'provider', 'signIn', 'processWarm', 'prompt', 'firstFrame', 'firstText']
    ])
    for (const { ms } of turns) expect(Object.values(ms)).toEqual([...Object.values(ms)].sort((a, b) => a - b))
  })

  it('is not logged for a turn no dispatch bound, nor for a message that joined a turn under way', async () => {
    expect(await timed(() => { turnTimingBegin('bot-1'); turnTimingForget('bot-1') })).toEqual([])
  })
})
