/**
 * A Claude Code turn that runs as one query (a bot's turn, or any turn with live queries off) is done at its result:
 * the turn returns then, and the process exits behind it. The next turn on the same chat starts once it has, so two
 * processes never write one session. A process asked to resume a session that starts another one says so in the
 * turn's report (resumeLost). Bot dispatch waits for the turn's own sign-in check. The service is driven against FakeClaudeCli.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../src/mms/bots/authority/botAuthority'
import type { ClaudeLockedTurn } from '../src/mms/harness/claude/locked'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import type { ClaudeSubscriptionMetrics } from '../src/mms/harness/vendors/claude/metrics'
import { FakeClaudeCli, resultFrame, SESSION, textDelta } from './run/fakeClaudeCli'

const dirs: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', temp('claude-one-shot-exit-config-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(runAuth: () => Promise<string> = async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })) {
  const home = temp('claude-one-shot-exit-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(join(home, 'providers', 'claude-subscription', 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const cli = new FakeClaudeCli()
  // Like the real process: it goes on for a moment after its result, until it exits or is signalled.
  cli.lingersAfterClose = true
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    launchConfig: () => ({ binaryPath: binary }),
    query: cli.query,
    live: false,
    runAuth: vi.fn(runAuth)
  })
  const reports: ClaudeSubscriptionMetrics[] = []
  const chat = (extra: Partial<ClaudeSubscriptionChatInput> = {}) =>
    service.chat({ threadId: 'thread', cwd: home, model: 'sonnet', prompt: 'hi', permissionMode: 'full', onText: vi.fn(), onMetrics: (report) => reports.push(report), ...extra })
  return { home, cli, service, chat, reports }
}

it('a one-shot turn returns at its result while its process still runs, and the next turn starts once that process exited', async () => {
  const f = fixture()
  await expect(f.chat()).resolves.toBe('reply to 1')
  const first = f.cli.processes[0]
  // The turn is done; the process has not exited yet (a real one takes about half a second).
  expect(f.cli.processes).toHaveLength(1)
  expect(first.signals).toEqual([])

  let started = false
  const next = f.chat({ prompt: 'again' }).then((text) => {
    started = true
    return text
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(f.cli.processes).toHaveLength(1)
  expect(started).toBe(false)

  first.end()
  await expect(next).resolves.toBe('reply to 1')
  expect(f.cli.processes).toHaveLength(2)
  f.service.stop()
})

it('a process asked to resume a session that writes under another one reports the resume as lost', async () => {
  const f = fixture()
  await f.chat({ history: '' })
  f.service.commitConversation('thread', 'h1')
  f.cli.processes[0].end()
  expect(f.reports.at(-1)?.resumeLost).toBeUndefined()

  // The next turn resumes the saved session; the process starts a new one instead.
  f.cli.reply = (message, process) => {
    const other = { session_id: 'another-session' }
    process.emit({ ...textDelta('fresh', String(message.uuid)), ...other }, { ...resultFrame({ uuids: [String(message.uuid)], text: 'fresh' }), ...other })
  }
  await expect(f.chat({ history: 'h1', prompt: 'again' })).resolves.toBe('fresh')
  expect(f.cli.processes[1].options.resume).toBe(SESSION)
  expect(f.reports.at(-1)?.resumeLost).toBe(true)
  f.service.stop()
})

/** A bot's turn: locked to its scratch folder, with only `read` granted. */
function lockedTurn(): ClaudeLockedTurn {
  const scratch = temp('claude-one-shot-exit-scratch-')
  const authority = createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: { tools: ['read'], appTools: [], mcp: [], skills: [], workspace: { roots: [scratch], access: 'write', scratch } },
    waiting: () => false,
    counters: { charge: () => ({ ok: true, count: 1 }) },
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
    spend: null
  })
  return { authority, ownerEntry: true, cwd: scratch, shellContained: false, temps: [], systemPrompt: 'You are a test bot.', ledger: { start: () => 'row', commit: () => undefined, failed: () => undefined } }
}

const SIGNED_IN = { loggedIn: true, authMethod: 'claude.ai' }
const SIGNED_OUT = { loggedIn: false }
// The turn needs its own successful reading even if the status check last saw a sign-in.
it.each([
  { last: SIGNED_IN, now: SIGNED_IN, outcome: 'reply' },
  { last: SIGNED_IN, now: SIGNED_OUT, outcome: 'sign in' },
  { last: SIGNED_OUT, now: SIGNED_IN, outcome: 'refused before start' }
])('a bot waits for its sign-in check: last $last.loggedIn, now $now.loggedIn: $outcome', async ({ last, now, outcome }) => {
  let read!: (text: string) => void
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  const deferred = new Promise<string>((resolve) => { read = resolve })
  let reading = false
  const f = fixture(() => {
    if (!reading) return Promise.resolve(JSON.stringify(last))
    began()
    return deferred
  })
  await f.service.status()
  reading = true
  f.cli.lingersAfterClose = false
  const turn = f.chat({ threadId: 'bot-thread', locked: lockedTurn() })
  void turn.catch(() => undefined)
  if (outcome === 'refused before start') {
    await expect(turn).rejects.toThrow(/isn't signed in/)
    expect(f.cli.processes).toHaveLength(0)
  } else {
    await started
    expect(f.cli.processes).toHaveLength(0)
    read(JSON.stringify(now))
    if (outcome === 'reply') {
      await expect(turn).resolves.toBe('reply to 1')
      expect(f.cli.processes[0]!.inputs).toHaveLength(1)
      f.cli.processes[0]!.end()
    } else {
      await expect(turn).rejects.toMatchObject({ code: 'claude_subscription_sign_in_required' })
      expect(f.cli.processes).toHaveLength(0)
    }
  }
  await f.service.stop()
})
