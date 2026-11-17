/**
 * A bot's chat keeps one Claude Code process warm between its turns on the owner's entry (docs/bots.md, Warm chat
 * process): reused only while its launch stays the same, refusing every call between turns, closed when a turn fails
 * or the bot's launch changes. Work turns and turns that offer Bash stay one process per turn.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
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
  vi.stubEnv('CLAUDE_CONFIG_DIR', temp('claude-warm-user-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
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
    runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
  })
  const root = temp('claude-warm-files-')
  const scratch = temp('claude-warm-scratch-')
  /** A chat turn of the bot: `warm` is what `BotEngine.authorityFor` sets for the chat's own turns. */
  const lockedTurn = (options: { warm?: string; tools?: NeutralTool[]; systemPrompt?: string } = {}): ClaudeLockedTurn => {
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

  it.each([
    ['a work turn', { warm: undefined }],
    ['a turn that offers Bash', { tools: ['read', 'shell'] as NeutralTool[] }]
  ] as const)('keeps %s to one process per turn', async (_name, options) => {
    const { cli, lockedTurn, turn } = fixture()
    await turn(lockedTurn(options))
    await turn(lockedTurn(options))
    expect(cli.processes).toHaveLength(2)
  })
})
