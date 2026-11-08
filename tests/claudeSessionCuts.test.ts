/**
 * Issue #360: an undo, an edit or a fork continues Claude's own session, cut at the right turn,
 * instead of replaying the conversation as text. The service is driven against `FakeClaudeCli`; the
 * session files Claude Code would write are written by the test, the way Claude Code lays them out.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import { ClaudeSubscriptionProviderService, type ClaudeSubscriptionChatInput } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { cutBefore, sessionEnd } from '../src/mms/harness/vendors/claude/sessionCuts'
import { ClaudeSubscriptionAdapter, CLAUDE_SUBSCRIPTION_CAPABILITIES, type ClaudeSubscriptionClient } from '../src/mms/harness/drivers/claudeCode/adapter'
import { FakeClaudeCli, type FakeClaudeProcess, resultFrame, SESSION, textDelta } from './run/fakeClaudeCli'

const dirs: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
let claudeHome = ''
beforeEach(() => {
  claudeHome = temp('claude-config-test-')
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Appends one turn to a session file as Claude Code writes it: the prompt under Mousse's id, an
 * attachment, the reply, and an attachment Claude Code never streams. Returns the turn's last entry.
 */
function writeTurn(home: string, sessionId: string, prompt: string, parent: string | null, folder = 'project'): string {
  const dir = join(home, 'projects', folder)
  mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'queue-operation' },
    { type: 'user', uuid: prompt, parentUuid: parent, isSidechain: false, message: { role: 'user', content: 'prompt' } },
    { type: 'attachment', uuid: `${prompt}-reminder`, parentUuid: prompt, isSidechain: false },
    { type: 'user', uuid: `${prompt}-side`, parentUuid: null, isSidechain: true },
    { type: 'assistant', uuid: `${prompt}-reply`, parentUuid: `${prompt}-reminder`, isSidechain: false },
    { type: 'attachment', uuid: `${prompt}-snapshot`, parentUuid: `${prompt}-reply`, isSidechain: false },
    { type: 'cost-state' }
  ]
  appendFileSync(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return `${prompt}-snapshot`
}

/** An answer whose result carries usage, as Claude Code's do: the saved session gets a usage baseline. */
function measuredAnswer(process: FakeClaudeProcess, uuid: string, text = 'ok'): void {
  process.emit(textDelta(text, uuid), {
    ...resultFrame({ uuids: [uuid], text }),
    total_cost_usd: 0.1,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1, contextWindow: 200000 } }
  })
}

function fixture(extra: Partial<ConstructorParameters<typeof ClaudeSubscriptionProviderService>[2]> = {}) {
  const home = temp('claude-cut-test-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const settingsPath = join(home, 'providers', 'claude-subscription', 'settings.json')
  mkdirSync(join(home, 'providers', 'claude-subscription'), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const cli = new FakeClaudeCli()
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    launchConfig: () => ({ binaryPath: binary }),
    query: cli.query,
    live: { noticeDelayMs: 10 },
    runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })),
    ...extra
  })
  const chat = (extra: Partial<ClaudeSubscriptionChatInput> = {}) =>
    service.chat({ threadId: 'thread', cwd: home, model: 'sonnet', prompt: 'hello', permissionMode: 'full', onText: vi.fn(), ...extra })
  /** Every prompt Mousse pushed, across processes, in order. */
  const prompts = () => cli.processes.flatMap((process) => process.inputs.map((message) => String(message.uuid)))
  /** A finished turn that starts from `before` and leaves `after`, committed as the adapter commits it. */
  const turn = async (before: string, after: string, extra: Partial<ClaudeSubscriptionChatInput> = {}) => {
    const text = await chat({ history: before, ...extra })
    service.commitConversation(extra.threadId ?? 'thread', after)
    return text
  }
  const saved = (threadId = 'thread') =>
    (JSON.parse(readFileSync(settingsPath, 'utf8')) as { sessions: Record<string, { sessionId: string; turns?: Array<{ prompt?: string; key?: string }>; fork?: { from: string; at: string } }> }).sessions[threadId]
  return { home, cli, service, chat, turn, prompts, saved }
}

/** Three turns on one session, with the file Claude Code would have written for them. */
async function threeTurns(f: ReturnType<typeof fixture>, home = claudeHome) {
  await f.turn('', 'h1')
  await f.turn('h1', 'h2')
  await f.turn('h2', 'h3')
  const [p1, p2, p3] = f.prompts()
  const end1 = writeTurn(home, SESSION, p1, null)
  const end2 = writeTurn(home, SESSION, p2, end1)
  const end3 = writeTurn(home, SESSION, p3, end2)
  return { p1, p2, p3, end1, end2, end3 }
}

describe('reading a cut from a Claude Code session file', () => {
  it('cuts before a prompt at the entry it follows, and finds the end of the main chain', () => {
    const end1 = writeTurn(claudeHome, 'session', 'p1', null)
    writeTurn(claudeHome, 'session', 'p2', end1)
    appendFileSync(join(claudeHome, 'projects', 'project', 'session.jsonl'), '{"type":"user","uuid":"cut sh')
    expect(cutBefore(claudeHome, 'session', 'p2')).toBe('p1-snapshot')
    // The first prompt follows nothing: there is no cut before it.
    expect(cutBefore(claudeHome, 'session', 'p1')).toBeUndefined()
    expect(cutBefore(claudeHome, 'session', 'unknown')).toBeUndefined()
    expect(cutBefore(claudeHome, 'missing', 'p2')).toBeUndefined()
    expect(sessionEnd(claudeHome, 'session')).toBe('p2-snapshot')
    expect(sessionEnd(claudeHome, 'missing')).toBeUndefined()
  })

  it('ends the main chain at its last entry, past metadata that has an id of its own', () => {
    writeTurn(claudeHome, 'session', 'p1', null)
    const file = join(claudeHome, 'projects', 'project', 'session.jsonl')
    appendFileSync(file, [JSON.stringify({ type: 'custom-title', uuid: 'title', customTitle: 'Renamed' }), 'null', '42'].join('\n') + '\n')
    expect(sessionEnd(claudeHome, 'session')).toBe('p1-snapshot')
    expect(cutBefore(claudeHome, 'session', 'p1')).toBeUndefined()
  })
})

describe('an undo or an edit on a Claude thread', () => {
  it.each([
    ['an undo of the last turn', 'h2', 'p3' as const, 'end2' as const],
    ['an edit of the second message', 'h1', 'p2' as const, 'end1' as const]
  ])('%s resumes the session cut before the first left-out prompt, into a new session', async (_name, history, leftOut, cut) => {
    const f = fixture()
    const turns = await threeTurns(f)
    expect(f.saved().turns).toEqual([
      { prompt: turns.p1, key: expect.any(String) },
      { prompt: turns.p2, key: expect.any(String) },
      { prompt: turns.p3, key: expect.any(String) }
    ])
    await f.turn(history, 'after')
    expect(f.cli.processes).toHaveLength(2)
    expect(f.cli.processes[0].closed).toBe(true)
    const options = f.cli.last.options
    expect(options).toMatchObject({ resume: SESSION, resumeSessionAt: turns[cut], forkSession: true })
    expect(options.sessionId).toEqual(expect.any(String))
    expect(options.sessionId).not.toBe(SESSION)
    expect(f.cli.last.text(0)).not.toContain('Previous conversation')
    // The thread continues on the branch, which keeps the turns before the cut and gains this one.
    const saved = f.saved()
    expect(saved.sessionId).toBe(options.sessionId)
    expect(saved.turns?.map((turn) => turn.prompt)).toEqual([...f.prompts().slice(0, leftOut === 'p3' ? 2 : 1), f.cli.last.uuid(0)])
    // The next turn continues the branch's process without another cut.
    await f.turn('after', 'later')
    expect(f.cli.processes).toHaveLength(2)
  })

  it('a stopped turn is a turn of the session: undoing it cuts before its prompt', async () => {
    const f = fixture()
    await f.turn('', 'h1')
    f.cli.reply = undefined
    const abort = new AbortController()
    const stopped = f.chat({ history: 'h1', signal: abort.signal })
    await vi.waitFor(() => expect(f.cli.last.inputs).toHaveLength(2))
    // Claude started on the prompt, so it is in the session.
    f.cli.last.emit(textDelta('partial', f.cli.last.uuid(1)))
    await vi.waitFor(() => expect(f.cli.last.queued).toEqual([]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    abort.abort()
    await expect(stopped).rejects.toThrow()
    f.service.commitInterrupted('thread', 'h1+stopped')
    const [p1, p2] = f.prompts()
    expect(f.saved().turns?.map((turn) => turn.prompt)).toEqual([p1, p2])
    const end1 = writeTurn(claudeHome, SESSION, p1, null)
    writeTurn(claudeHome, SESSION, p2, end1)
    f.cli.reply = (message, process) => process.answer(String(message.uuid), 'again')
    // Stop leaves the process open; an undo of the stopped message cuts the session before it.
    await f.turn('h1', 'h1+again')
    expect(f.cli.last.options).toMatchObject({ resume: SESSION, resumeSessionAt: end1, forkSession: true })
  })

  it('a thread with no remembered turns, or whose session file is gone, gets the history as text', async () => {
    const f = fixture()
    await threeTurns(f)
    rmSync(join(claudeHome, 'projects'), { recursive: true })
    await f.turn('h1', 'after')
    expect(f.cli.last.options.resume).toBeUndefined()
    expect(f.cli.last.options.resumeSessionAt).toBeUndefined()
    expect(f.cli.last.text(0)).toContain('Previous conversation (context only; do not repeat earlier actions):\\nh1')

    // A session saved before turns were remembered.
    const older = fixture()
    await older.turn('', 'h1')
    await older.turn('h1', 'h2')
    const settingsPath = join(older.home, 'providers', 'claude-subscription', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    delete settings.sessions.thread.turns
    writeFileSync(settingsPath, JSON.stringify(settings))
    const reloaded = fixture()
    const service = new ClaudeSubscriptionProviderService(older.home, new UserQuestionService(), {
      launchConfig: () => ({ binaryPath: join(older.home, 'claude') }),
      query: reloaded.cli.query,
      live: false,
      runAuth: vi.fn(async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))
    })
    await service.chat({ threadId: 'thread', cwd: older.home, model: 'sonnet', prompt: 'hello', permissionMode: 'full', onText: vi.fn(), history: 'h1' })
    expect(reloaded.cli.last.options.resumeSessionAt).toBeUndefined()
    expect(reloaded.cli.last.text(0)).toContain('Previous conversation')
  })

  it('a session file Mousse cannot read gives the history as text, and the thread can send again', async () => {
    const f = fixture()
    await threeTurns(f)
    const file = join(claudeHome, 'projects', 'project', `${SESSION}.jsonl`)
    rmSync(file)
    // Found, but reading it fails.
    mkdirSync(file)
    await f.turn('h2', 'after')
    expect(f.cli.last.options.resumeSessionAt).toBeUndefined()
    expect(f.cli.last.text(0)).toContain('Previous conversation')
    expect(await f.chat({ history: 'after' })).toEqual(expect.stringContaining('reply to'))
  })

  it('a cut turn that ends before Claude Code made the new session keeps the session\'s turns, so the resend cuts again', async () => {
    const f = fixture()
    f.cli.reply = (message, process) => measuredAnswer(process, String(message.uuid))
    const turns = await threeTurns(f)
    let ended = false
    f.cli.reply = (message, process) => {
      if (process.options.resumeSessionAt && !ended) {
        ended = true
        process.end()
      } else measuredAnswer(process, String(message.uuid))
    }
    await expect(f.chat({ history: 'h2' })).rejects.toThrow()
    expect(ended).toBe(true)
    expect(f.saved().sessionId).toBe(SESSION)
    expect(f.saved().turns?.map((turn) => turn.prompt)).toEqual([turns.p1, turns.p2, turns.p3])
    await f.turn('h2', 'after')
    expect(f.cli.last.options).toMatchObject({ resume: SESSION, resumeSessionAt: turns.end2, forkSession: true })
    expect(f.cli.last.text(0)).not.toContain('Previous conversation')
  })

  it('when Claude Code cannot open the cut, the turn runs again once with the history as text', async () => {
    const f = fixture()
    await threeTurns(f)
    f.cli.reply = (message, process) => {
      if (process.options.resumeSessionAt) process.emit(resultFrame({ error: 'No message found with message.uuid of: gone' }))
      else process.answer(String(message.uuid), 'from text')
    }
    expect(await f.chat({ history: 'h2' })).toBe('from text')
    expect(f.cli.processes).toHaveLength(3)
    expect(f.cli.processes[1].options.resumeSessionAt).toBeDefined()
    expect(f.cli.last.options.resume).toBeUndefined()
    expect(f.cli.last.text(0)).toContain('Previous conversation')
  })

  it('runs one-shot turns cut the same way, with the prompt under Mousse\'s id', async () => {
    const f = fixture({ live: false })
    const turns = await threeTurns(f)
    expect(f.cli.processes.every((process) => process.inputs[0].uuid)).toBe(true)
    await f.turn('h2', 'after')
    expect(f.cli.last.options).toMatchObject({ resume: SESSION, resumeSessionAt: turns.end2, forkSession: true })
    expect(f.cli.last.text(0)).not.toContain('Previous conversation')
  })

  it('reads the session files of the home the entry runs with', async () => {
    const own = temp('claude-own-home-')
    const f = fixture({ baseEnv: () => ({ ...process.env, CLAUDE_CONFIG_DIR: own }) })
    const turns = await threeTurns(f, own)
    await f.turn('h2', 'after')
    expect(f.cli.last.options.env?.CLAUDE_CONFIG_DIR).toBe(own)
    expect(f.cli.last.options).toMatchObject({ resumeSessionAt: turns.end2, forkSession: true })
  })
})

describe('a fork of a Claude thread', () => {
  it('branches the session after the forked turn; the fork\'s first turn makes the branch and the source is untouched', async () => {
    const f = fixture()
    const turns = await threeTurns(f)
    const branch = f.service.forkConversation({ prompt: turns.p2 }, 'fork')
    expect(branch).toEqual(expect.any(String))
    expect(f.saved('fork')).toMatchObject({ sessionId: branch, fork: { from: SESSION, at: turns.end2 } })
    // Whatever history the fork's thread carries, its first turn runs on the branch.
    await f.turn('parent history', 'fork h1', { threadId: 'fork' })
    expect(f.cli.last.options).toMatchObject({ resume: SESSION, resumeSessionAt: turns.end2, forkSession: true, sessionId: branch })
    expect(f.cli.last.text(0)).not.toContain('Previous conversation')
    expect(f.saved('fork').fork).toBeUndefined()
    expect(f.saved('fork').sessionId).toBe(branch)
    // The source thread continues its own session.
    await f.turn('h3', 'h4')
    expect(f.saved().sessionId).toBe(SESSION)
    expect(f.cli.processes[0].closed).toBe(false)
  })

  it('a fork of the latest turn keeps the session as it is now, so later turns of the source stay out', async () => {
    const f = fixture()
    const turns = await threeTurns(f)
    expect(f.service.forkConversation({ prompt: turns.p3 }, 'fork')).toEqual(expect.any(String))
    expect(f.saved('fork').fork).toEqual({ from: SESSION, at: turns.end3 })
  })

  it('a fork whose turn is gone, or whose session file is, uses the portable handoff; one whose history was handed over drops the branch', async () => {
    const f = fixture()
    const turns = await threeTurns(f)
    expect(f.service.forkConversation({ prompt: 'not a turn' }, 'fork')).toBeNull()
    expect(f.service.forkConversation({ prompt: turns.p1, instanceId: 'another' }, 'fork')).toBeNull()
    expect(f.service.forkConversation({ prompt: turns.p2 }, 'fork')).toEqual(expect.any(String))
    await f.turn('handed over', 'fork h1', { threadId: 'fork', historyHandedOver: true })
    expect(f.cli.last.options.resume).toBeUndefined()
    expect(f.cli.last.text(0)).toContain('Previous conversation')
    rmSync(join(claudeHome, 'projects'), { recursive: true })
    expect(f.service.forkConversation({ prompt: turns.p2 }, 'fork 2')).toBeNull()
  })

  it('a fork whose branch Claude Code cannot open fails so the resend forks again', async () => {
    const f = fixture()
    const turns = await threeTurns(f)
    f.service.forkConversation({ prompt: turns.p2 }, 'fork')
    f.cli.reply = (message, process) => process.emit(resultFrame({ error: `No conversation found with session ID: ${SESSION}` }))
    await expect(f.chat({ threadId: 'fork', history: '' })).rejects.toMatchObject({ code: 'binding_stale' })
    expect(f.saved('fork')).toBeUndefined()
  })
})

describe('the Claude adapter', () => {
  it('forks natively, by the turn\'s prompt', async () => {
    expect(CLAUDE_SUBSCRIPTION_CAPABILITIES.fork).toBe('native')
    const forkConversation = vi.fn(() => 'branch')
    const service = { forkConversation } as unknown as ClaudeSubscriptionClient
    const adapter = new ClaudeSubscriptionAdapter(() => service)
    const ref = { provider: 'claude-subscription', instanceId: 'claude', model: 'sonnet', sessionId: 'source', nativeTurnId: 'prompt-2' }
    expect(await adapter.forkSession(ref, 2, { threadId: 'fork' })).toEqual({ provider: 'claude-subscription', instanceId: 'claude', model: 'sonnet', sessionId: 'branch' })
    expect(forkConversation).toHaveBeenCalledWith({ prompt: 'prompt-2', instanceId: 'claude' }, 'fork')
    // A turn Claude started, one recorded before, or no thread to bind the branch to: a portable handoff.
    expect(await adapter.forkSession({ ...ref, nativeTurnId: undefined }, 2, { threadId: 'fork' })).toBeNull()
    expect(await adapter.forkSession(ref, 2)).toBeNull()
    expect(await new ClaudeSubscriptionAdapter(() => service, () => null, { admit: async () => ({ ok: true, shellContained: false }) }).forkSession(ref, 2, { threadId: 'fork' })).toBeNull()
  })
})
