/**
 * Bots on the owner's own Claude Code and Codex entries: every approval those runtimes raise in a
 * bot turn is answered by the bot's authority, the one `BotEngine` builds for Pi too. Allowed calls
 * run; in the chat lane a missing permission is a wall the owner answers; in a run it is refused
 * with an ask, and the run carries on; anything that can't be asked for is just refused. Nobody is
 * shown a normal approval prompt.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_ASK_REFUSED_TEXT } from '../../src/mms/bots/activation/BotEngine'
import { CLAUDE_TOPS_UNLISTED, claudeBotTemp, claudeCommandsRefusal, ClaudeLockedGate, claudeLockedOptions, claudeLockedSandbox, claudeLockedTools, claudeOwnStorage, claudeProjectName, type ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { filesAsk } from '../../src/shared/bots/personal/escalation'
import { CODEX_BOT_UNSANDBOXED_REFUSAL, codexBotCommand, codexBotFileChange } from '../../src/mms/harness/vendors/codex/botApprovals'
import { CODEX_BOT_PROFILE, codexBotSandbox, codexBotSandboxConfig, codexTurnPolicy } from '../../src/mms/harness/vendors/codex/childPolicy'
import { BOT_COMPUTER_OPEN, type BotComputerLimit } from '../../src/shared/bots/personal/computerLimit'
import type { BotAuthority } from '../../src/shared/bots/personal/authority'
import type { ToolLedger } from '../../src/mms/run/mcp/appTools/types'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
let invoices: string

beforeEach(async () => {
  f = botFixture()
  invoices = join(f.base, 'Invoices')
  mkdirSync(invoices)
  botId = (await createBot(f, { name: 'Penny', reply: 'Hello.' })).botId
})

afterEach(() => f.close())

const ledger: ToolLedger = { start: (call) => `row-${call.id}`, commit: () => {}, failed: () => {} }

/** Claude Code's grant gate on the owner's entry, over the dispatch's authority. */
function claudeGate(authority: BotAuthority): ClaudeLockedGate {
  const turn: ClaudeLockedTurn = { authority, ownerEntry: true, ledger, cwd: authority.workspace!.files!, shellContained: false, shellOpen: true, temps: [], systemPrompt: '' }
  return new ClaudeLockedGate(turn, true)
}

async function chat(text: string, id: string) {
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

async function run(id: string) {
  const activation = await f.bots.activate({ botId, input: 'Sort the invoices', clientRequestId: id })
  return { activation, ...(await start(f, activation.id)) }
}

describe('Claude Code\'s own storage never asks (bot-architecture.md §3.7)', () => {
  /** The gate of a turn whose Claude home is `home`: its project folder for the bot's files folder. */
  function gateWithOwn(authority: BotAuthority, home: string): ClaudeLockedGate {
    const cwd = authority.workspace!.files!
    const turn: ClaudeLockedTurn = { authority, ownerEntry: true, ledger, cwd, shellContained: false, shellOpen: true, temps: [], systemPrompt: '', own: claudeOwnStorage(home, cwd) }
    return new ClaudeLockedGate(turn, true)
  }

  it('reading back its saved tool output needs no file access, in a run and in the chat, and writes no ask', async () => {
    const home = join(f.base, 'claude-home')
    for (const [lane, started] of [['run', () => run('r1')], ['chat', () => chat('Search the web', 'm1')]] as const) {
      const { activation, prepared, payload } = await started()
      const gate = gateWithOwn(prepared.authority, home)
      // As Claude Code names it: `<home>/projects/<files folder as a name>/<session>/tool-results/<id>.txt`.
      const saved = join(home, 'projects', claudeProjectName(prepared.authority.workspace!.files!), '7ec7e746-78f2-47fb-b3f6-58781eecebc3', 'tool-results', 'toolu_1.txt')
      expect(gate.canUse('Read', { file_path: saved }, `tu-${lane}-1`)).toEqual({ ok: true })
      expect(gate.canUse('Grep', { pattern: 'price', path: join(saved, '..') }, `tu-${lane}-2`)).toEqual({ ok: true })
      // Another bot's sessions, or Claude Code's other folders, are not its own storage.
      const another = join(home, 'projects', claudeProjectName(join(f.base, 'other-bot')), 's', 'tool-results', 'x.txt')
      expect(gate.canUse('Read', { file_path: another }, `tu-${lane}-3`)).toMatchObject({ ok: false })
      expect(f.store.openAsks(botId).map((ask) => ask.permission)).toEqual([filesAsk()])
      expect(f.store.activation(activation.id)!.status).toBe(lane === 'run' ? 'running' : 'waiting_grant')
      await finish(f, payload, lane === 'run' ? 'completed' : 'interrupted', { text: 'Done.', ...(lane === 'chat' ? { outcome: { interruptedBy: 'bot_wall' } } : {}) })
      for (const ask of f.store.openAsks(botId)) f.store.answerEscalation(ask.id, 'withdrawn')
    }
  })

  it('names project folders as Claude Code does, and matches a cut name by its cut part', () => {
    expect(claudeProjectName('/home/aeon/.mousse/profiles/ea94983f-8da5-449f-af74-d5e9d338c430/bots/files/bot-14007dd649d7'))
      .toBe('-home-aeon--mousse-profiles-ea94983f-8da5-449f-af74-d5e9d338c430-bots-files-bot-14007dd649d7')
    const home = join(f.base, 'claude-home')
    const long = join(f.base, 'x'.repeat(240))
    const own = claudeOwnStorage(home, long)
    const cut = `${claudeProjectName(long).slice(0, 200)}-1a2b3c`
    expect(own.holds(join(home, 'projects', cut, 's', 'tool-results', 'a.txt'))).toBe(true)
    expect(own.holds(join(home, 'projects', claudeProjectName(long).slice(0, 200), 's', 'a.txt'))).toBe(false)
    // The project folder itself, and anything beside it, is not a session's storage.
    const short = claudeOwnStorage(home, join(f.base, 'files'))
    expect(short.holds(join(home, 'projects', claudeProjectName(join(f.base, 'files'))))).toBe(false)
    expect(short.holds(join(home, 'settings.json'))).toBe(false)
    expect(short.folders).toEqual([join(home, 'projects', claudeProjectName(join(f.base, 'files')))])
  })
})

describe('approvals on the owner\'s entries are answered by the bot\'s authority', () => {
  it('allows what the grant holds: a change in its files folder, a read there', async () => {
    const { prepared, payload } = await chat('Write a note', 'm1')
    const files = prepared.authority.workspace!.files!
    expect(codexBotFileChange(prepared.authority, { changes: [{ path: 'note.md', kind: 'add' }], cwd: files })).toEqual({ decision: 'accept' })
    expect(claudeGate(prepared.authority).canUse('Write', { file_path: join(files, 'note.md'), content: 'x' }, 'tu-1')).toEqual({ ok: true })
    expect(claudeGate(prepared.authority).canUse('Read', { file_path: 'note.md' }, 'tu-2')).toEqual({ ok: true })
    expect(f.store.openAsks(botId)).toEqual([])
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('in the chat lane a missing permission is a wall: the call is declined and the activation waits for the owner', async () => {
    const codex = await chat('Sort my invoices', 'm1')
    const declined = codexBotFileChange(codex.prepared.authority, { changes: [{ path: join(invoices, 'a.pdf'), kind: 'update' }], cwd: codex.prepared.authority.workspace!.files! })
    expect(declined).toMatchObject({ decision: 'decline', reason: expect.stringContaining('Paused: waiting for the owner') })
    expect(f.store.activation(codex.activation.id)!.status).toBe('waiting_grant')
    expect(f.store.openAsks(botId)).toMatchObject([{ mode: 'wall' }])
    await finish(f, codex.payload, 'interrupted', { text: 'I need your invoices.', outcome: { interruptedBy: 'bot_wall' } })
  })

  it('on Claude Code the same: a wall in the chat lane', async () => {
    const { activation, prepared, payload } = await chat('Read my invoices', 'm1')
    const denied = claudeGate(prepared.authority).canUse('Read', { file_path: join(invoices, 'a.pdf') }, 'tu-1')
    expect(denied).toMatchObject({ ok: false, reason: expect.stringContaining('Paused: waiting for the owner') })
    expect(f.store.activation(activation.id)!.status).toBe('waiting_grant')
    await finish(f, payload, 'interrupted', { text: 'I need your invoices.', outcome: { interruptedBy: 'bot_wall' } })
  })

  it('in a run a missing permission is refused with an ask, and the run carries on', async () => {
    const { activation, prepared, payload } = await run('r1')
    const files = prepared.authority.workspace!.files!
    expect(codexBotFileChange(prepared.authority, { changes: [{ path: join(invoices, 'a.pdf'), kind: 'update' }], cwd: files })).toEqual({ decision: 'decline', reason: BOT_ASK_REFUSED_TEXT })
    expect(claudeGate(prepared.authority).canUse('Read', { file_path: join(invoices, 'b.pdf') }, 'tu-1')).toEqual({ ok: false, reason: BOT_ASK_REFUSED_TEXT })
    expect(f.store.activation(activation.id)!.status).toBe('running')
    // Codex's change and Claude Code's read need the same permission: one ask for file access.
    expect(f.store.openAsks(botId).map((ask) => ask.mode)).toEqual(['ask'])
    // Still allowed afterwards: the run goes on.
    expect(codexBotFileChange(prepared.authority, { changes: [{ path: 'report.md', kind: 'add' }], cwd: files })).toEqual({ decision: 'accept' })
    await finish(f, payload, 'completed', { text: 'Report: I skipped the invoices.' })
    expect(f.store.activation(activation.id)).toMatchObject({ status: 'done' })
  })

  it('what can never be granted is refused, with no ask: Claude Code\'s own tools, a user MCP tool, a change Codex did not describe', async () => {
    const { activation, prepared, payload } = await run('r1')
    expect(claudeGate(prepared.authority).canUse('TodoWrite', { todos: [] }, 'tu-1')).toMatchObject({ ok: false })
    expect(claudeGate(prepared.authority).preToolUse('mcp__github__create_issue', {})).toMatchObject({ ok: false })
    expect(codexBotFileChange(prepared.authority, { changes: [], cwd: prepared.authority.workspace!.files! })).toMatchObject({ decision: 'decline' })
    expect(f.store.openAsks(botId)).toEqual([])
    expect(f.store.activation(activation.id)!.status).toBe('running')
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('a command without "run commands" is declined with an ask; once allowed, Codex\'s commands are accepted by the grant, never outside its sandbox', async () => {
    const first = await run('r1')
    const files = first.prepared.authority.workspace!.files!
    expect(codexBotCommand(first.prepared.authority, { command: 'ls', cwd: files })).toEqual({ decision: 'decline', reason: BOT_ASK_REFUSED_TEXT })
    await finish(f, first.payload, 'completed', { text: 'Report: I could not run commands.' })
    const ask = f.store.openAsks(botId)[0]!
    expect(ask).toMatchObject({ title: 'run commands' })
    await f.bots.service.answer(botId, ask.id, 'allow')
    const second = await run('r2')
    for (const command of ['ls', 'rm -rf build', 'npm test']) expect(codexBotCommand(second.prepared.authority, { command, cwd: files }), command).toEqual({ decision: 'accept' })
    expect(codexBotCommand(second.prepared.authority, { command: 'ls', cwd: files, reason: 'command failed; retry without sandbox?' })).toEqual({ decision: 'decline', reason: CODEX_BOT_UNSANDBOXED_REFUSAL })
    // Claude Code's Bash on the owner's entry goes through the same grant.
    expect(claudeGate(second.prepared.authority).preToolUse('Bash', { command: 'make' })).toEqual({ ok: true })
    expect(f.store.openAsks(botId)).toEqual([])
    await finish(f, second.payload, 'completed', { text: 'Done.' })
  })
})

describe('What bots may do here, at each runtime\'s own gate (the owner\'s Claude Code and Codex entries)', () => {
  const NOT_HERE = /^Not on this computer: "(run commands|use files on this computer)" is switched off here/
  let limit: BotComputerLimit

  /** The owner allows commands and file access while every switch is on. */
  beforeEach(async () => {
    limit = { ...BOT_COMPUTER_OPEN }
    f.host.computerLimit = () => limit
    const work = await run('grant')
    for (const permission of [{ tool: 'shell' }, { path: invoices, access: 'write' as const }])
      work.prepared.authority.escalate!({ permission, reason: 'The owner asked.' })
    await finish(f, work.payload, 'completed', { text: 'Asked.' })
    for (const ask of f.store.openAsks(botId)) await f.bots.service.answer(botId, ask.id, 'allow')
    expect(f.store.openAsks(botId)).toEqual([])
  })

  it('Run commands off in a turn already running: the next command is refused by Claude Code\'s gate and Codex\'s approval, with no ask', async () => {
    const { prepared, payload } = await run('r1')
    const files = prepared.authority.workspace!.files!
    expect(claudeGate(prepared.authority).preToolUse('Bash', { command: 'ls' })).toEqual({ ok: true })
    expect(codexBotCommand(prepared.authority, { command: 'ls', cwd: files })).toEqual({ decision: 'accept' })
    limit = { ...limit, shell: false }
    expect(claudeGate(prepared.authority).preToolUse('Bash', { command: 'ls' })).toMatchObject({ ok: false, reason: expect.stringMatching(NOT_HERE) })
    expect(codexBotCommand(prepared.authority, { command: 'ls', cwd: files })).toMatchObject({ decision: 'decline', reason: expect.stringMatching(NOT_HERE) })
    expect(f.store.openAsks(botId)).toEqual([])
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('Run commands off from the start: Claude Code is offered no Bash, and Codex starts with no command tool', async () => {
    limit = { ...limit, shell: false }
    const { prepared, payload } = await run('r1')
    expect(claudeLockedTools({ authority: prepared.authority, shellContained: true }, false).tools).not.toContain('Bash')
    // Nor a tool that opens a file by its path without asking (what else Codex offers: codexBotTools.test.ts).
    expect(codexBotSandboxConfig(codexBotSandbox(prepared.authority))).toMatchObject({ 'features.shell_tool': false, 'features.unified_exec': false, 'features.view_image': false })
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('Use files off in a turn already running: a read or change outside the bot\'s folders is refused by both runtimes\' gates; its own folder still works', async () => {
    const { prepared, payload } = await run('r1')
    const files = prepared.authority.workspace!.files!
    const outside = join(invoices, 'a.pdf')
    expect(claudeGate(prepared.authority).canUse('Read', { file_path: outside }, 'tu-1')).toEqual({ ok: true })
    limit = { ...limit, files: false }
    expect(claudeGate(prepared.authority).canUse('Read', { file_path: outside }, 'tu-2')).toMatchObject({ ok: false, reason: expect.stringMatching(NOT_HERE) })
    expect(codexBotFileChange(prepared.authority, { changes: [{ path: outside, kind: 'update' }], cwd: files })).toMatchObject({ decision: 'decline', reason: expect.stringMatching(NOT_HERE) })
    expect(codexBotFileChange(prepared.authority, { changes: [{ path: 'notes.md', kind: 'add' }], cwd: files })).toEqual({ decision: 'accept' })
    // Its commands were set up over every folder: they wait for a turn that starts without file access.
    expect(codexBotCommand(prepared.authority, { command: 'ls', cwd: files })).toMatchObject({ decision: 'decline', reason: expect.stringMatching(NOT_HERE) })
    expect(f.store.openAsks(botId)).toEqual([])
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('Use files off from the start: commands run, in a sandbox that reads only the system\'s programs and the bot\'s own folders', async () => {
    limit = { ...limit, files: false }
    const { prepared, payload } = await run('r1')
    const workspace = prepared.authority.workspace!
    const mine = [workspace.files!, workspace.scratch]
    expect(workspace.computer).toBeUndefined()
    // Codex on Linux and macOS: Mousse's permission profile, reading `:minimal`, writing only the bot's folders.
    const codex = codexBotSandbox(prepared.authority, '/opt/codex', 'linux')
    expect(codexTurnPolicy('default', undefined, 'ask', codex)).toEqual({ approvalPolicy: 'untrusted', permissions: CODEX_BOT_PROFILE })
    expect(codexBotSandboxConfig(codex)).toMatchObject({
      [`permissions.${CODEX_BOT_PROFILE}`]: { filesystem: { ':minimal': 'read', '/opt/codex': 'read', ...Object.fromEntries(mine.map((root) => [root, 'write'])) }, network: { enabled: false } }
    })
    // On Windows Codex keeps its workspace-write sandbox, which reads every file.
    expect(codexBotSandbox(prepared.authority, '/opt/codex', 'win32').confined).toBeUndefined()
    // Claude Code on Linux: every top folder but the system's own is unreadable (`/run`, with removable drives and the
    // user's runtime folder, included), and the home folder; the bot's folders are not. Claude Code's shared temporary
    // folders, when the turn keeps its own elsewhere, are closed read and write.
    const tops = ['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'snap', 'srv', 'sys', 'tmp', 'usr', 'var']
    const linux = claudeLockedSandbox({ workspace, temps: ['/tmp'], home: '/home/owner', platform: 'linux', tops: () => tops, sharedTemp: ['/tmp/claude-1000'] }).filesystem!
    expect([...linux.denyRead!].sort()).toEqual(['/boot', '/home', '/home/owner', '/media', '/mnt', '/opt', '/root', '/run', '/snap', '/srv', '/tmp/claude-1000', '/var'])
    expect(linux.denyWrite).toEqual(expect.arrayContaining(['/tmp', '/tmp/claude-1000']))
    expect(linux.allowRead).toEqual(expect.arrayContaining(mine))
    expect(linux.allowWrite).toEqual(expect.arrayContaining(mine))
    // `/` can't be listed: no sandbox is built with fewer folders closed; it throws instead (and the gate refuses, below).
    expect(() => claudeLockedSandbox({ workspace, temps: ['/tmp'], home: '/home/owner', platform: 'linux', tops: () => { throw new Error('EACCES') } })).toThrow()
    // On macOS, the home folder only.
    expect(claudeLockedSandbox({ workspace, temps: [], home: '/Users/owner', platform: 'darwin', tops: () => tops }).filesystem!.denyRead).toEqual(['/Users/owner'])
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('Claude Code on Linux when `/` can\'t be listed: every command is refused with a plain reason, and none runs with only the home folder closed', async () => {
    limit = { ...limit, files: false }
    const { prepared, payload } = await run('r1')
    const unlisted = () => { throw new Error('EACCES') }
    const reason = claudeCommandsRefusal(prepared.authority, 'linux', unlisted)
    expect(reason).toBe(CLAUDE_TOPS_UNLISTED)
    const turn: ClaudeLockedTurn = { authority: prepared.authority, ledger, cwd: prepared.authority.workspace!.files!, shellContained: true, temps: [], systemPrompt: '', commandsRefused: reason }
    const gate = new ClaudeLockedGate(turn, true)
    expect(gate.preToolUse('Bash', { command: 'ls' })).toEqual({ ok: false, reason: CLAUDE_TOPS_UNLISTED })
    expect(gate.canUse('Bash', { command: 'ls' }, 'tu-1')).toEqual({ ok: false, reason: CLAUDE_TOPS_UNLISTED })
    // The turn is still offered Bash, so the bot hears why; no sandbox is built for it.
    const options = claudeLockedOptions(turn, { env: {}, mousseTools: false })
    expect(options.tools).toContain('Bash')
    expect(options.sandbox).toBeUndefined()
    // Not refused where it doesn't apply: listable, another platform, or file access (whose sandbox closes Mousse's data only).
    expect(claudeCommandsRefusal(prepared.authority, 'linux', () => ['usr'])).toBeUndefined()
    expect(claudeCommandsRefusal(prepared.authority, 'darwin', unlisted)).toBeUndefined()
    await finish(f, payload, 'completed', { text: 'Done.' })
  })

  it('Claude Code on Linux keeps a bot\'s own temporary files private only in a runtime folder under /run, which its sandbox closes; elsewhere the turn keeps Claude Code\'s shared one', async () => {
    limit = { ...limit, files: false }
    const { prepared, payload } = await run('r1')
    const cwd = prepared.authority.workspace!.files!
    // A runtime folder in the shared temporary folder is open to every bot: no private folder there.
    expect(claudeBotTemp(prepared.authority, {}, cwd, 'linux', '/tmp/runtime-1000')).toBeUndefined()
    expect(claudeBotTemp(prepared.authority, {}, cwd, 'linux', '')).toBeUndefined()
    expect(claudeBotTemp(prepared.authority, {}, cwd, 'darwin', '/run/user/1000')).toBeUndefined()
    // Where it is real (Linux with one), the folder is its own, short enough for Claude Code to give its commands, and
    // the shared folders are the ones the sandbox closes (the real program: claudeMcpCommandLine.test.ts).
    const runtime = process.platform === 'linux' ? process.env.XDG_RUNTIME_DIR : undefined
    if (runtime?.startsWith('/run/')) {
      const temp = claudeBotTemp(prepared.authority, { TMPDIR: '/var/tmp/x' }, cwd, 'linux', runtime)
      if (temp) {
        expect(temp.dir.startsWith(`${runtime}/mb`)).toBe(true)
        expect(Buffer.byteLength(temp.dir)).toBeLessThanOrEqual(30)
        expect(temp.shared).toEqual([`/tmp/claude-${process.getuid!()}`, `/var/tmp/x/claude-${process.getuid!()}`])
      }
    }
    await finish(f, payload, 'completed', { text: 'Done.' })
  })
})
