/**
 * Issue #920: a steer into a Claude Code turn that runs as one query with no live session, driven here through a bot's
 * locked turn (the app does not steer bot threads; a person's turn past the live-process cap takes the same path, see
 * `tests/claudeOneShotSteerStop.test.ts`). A steer interrupts the query and goes in as the prompt of a query that
 * restarts the turn. The steer is accepted only once that query reads it; a Stop before then hands it back, once, by
 * its drain's token.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import { CLAUDE_CUT_REFUSAL, type ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
import { ClaudeSubscriptionProviderService } from '../../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const dirs: string[] = []
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', temp('bot-steer-user-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SESSION = 'bot-session'
const init = { type: 'system', subtype: 'init', session_id: SESSION }
const interrupted = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], session_id: SESSION }
const done = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION }

type FakeQuery = { close: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> }
/** One query's frames: given the prompt it was started with and its own fake. */
type Script = (prompt: AsyncIterable<SDKUserMessage>, query: FakeQuery) => AsyncGenerator<unknown>

/** The prompt a query was started with: its first message. */
async function firstMessage(prompt: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage> {
  for await (const message of prompt) return message
  throw new Error('the query had no prompt')
}

/** A bot's turn on the owner's own Claude Code entry: one query per run of the turn, each from `scripts` in order. */
function botTurn(scripts: Script[]) {
  const home = temp('bot-steer-home-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const queries: FakeQuery[] = []
  const prompts: SDKUserMessage[] = []
  const options: Array<Record<string, unknown>> = []
  const query = ({ prompt, options: started }: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }): Query => {
    const script = scripts[queries.length]
    if (!script) throw new Error('no query left to start')
    const fake: FakeQuery = { close: vi.fn(), interrupt: vi.fn(async () => {}) }
    queries.push(fake)
    options.push({ ...started })
    // The prompt is read once, here; the script gets it again as a one-message stream.
    const read = firstMessage(prompt).then((message) => {
      prompts.push(message)
      return message
    })
    const replay = (async function* (): AsyncGenerator<SDKUserMessage> {
      yield await read
    })()
    return Object.assign(script(replay, fake), fake) as unknown as Query
  }
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    // The fixture binary, not whatever `claude` is on PATH: a machine without Claude Code must run this too.
    launchConfig: () => ({ binaryPath: binary }),
    query,
    // A live process would be kept warm for a person's thread: a bot's turn never takes one.
    live: true,
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
  })
  const root = temp('bot-steer-root-')
  const scratch = temp('bot-steer-scratch-')
  const authority = createBotAuthority({
    activationId: 'act-1',
    role: 'activation',
    permissions: { tools: ['read'], appTools: [], mcp: [], skills: [], workspace: { roots: [root], access: 'write', scratch } },
    waiting: () => false,
    counters: { charge: () => ({ ok: true, count: 1 }) },
    time: { deadline: () => Number.MAX_SAFE_INTEGER, signal: new AbortController().signal },
    spend: null
  })
  const locked: ClaudeLockedTurn = {
    authority,
    ownerEntry: true,
    cwd: root,
    shellContained: false,
    temps: [],
    systemPrompt: 'Your name is Pip. You keep my day in order.',
    ledger: { start: () => 'row', commit: () => undefined, failed: () => undefined }
  }
  const onCompaction = vi.fn()
  const stop = new AbortController()
  const events: string[] = []
  // Steers waiting to be drained, oldest first: one at the start, and a test may queue more while the turn runs.
  const pending: { text: string; token: string }[] = [{ text: 'use the other file', token: 'drain-1' }]
  const steer = {
    drainSteerEntry: vi.fn(() => {
      const next = pending.shift()
      if (next) events.push('drained')
      return next
    }),
    steerTaken: vi.fn((token?: string) => { events.push(`taken ${token}`) }),
    onSteer: vi.fn((text: string, token?: string) => { events.push(`accepted ${text} ${token}`) }),
    returnSteer: vi.fn((text: string, token?: string) => { events.push(`returned ${text} ${token}`) })
  }
  const run = () => service.chat({
    threadId: 'bot-thread',
    cwd: root,
    model: 'sonnet',
    prompt: 'go',
    locked,
    signal: stop.signal,
    onText: vi.fn(),
    onCompaction,
    ...steer
  })
  return { run, stop, steer, queries, prompts, events, pending, options, onCompaction, root }
}

type CanUseTool = (name: string, input: Record<string, unknown>, context: { signal: AbortSignal; toolUseID: string }) => Promise<{ behavior: string; message?: string }>
type Hook = (event: Record<string, unknown>, toolUseId: string, context: { signal: AbortSignal }) => Promise<Record<string, unknown>>
/** The query's own permission callbacks, as Claude Code calls them for a call the model makes. */
function gateOf(options: Record<string, unknown>) {
  const hooks = options.hooks as Record<'PreToolUse' | 'PostToolUse', Array<{ hooks: Hook[] }>>
  const signal = new AbortController().signal
  return {
    canUse: (toolUseID: string, path: string) => (options.canUseTool as CanUseTool)('Read', { file_path: path }, { signal, toolUseID }),
    pre: (toolUseID: string, path: string) => hooks.PreToolUse[0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path }, tool_use_id: toolUseID }, toolUseID, { signal }),
    post: (toolUseID: string) => hooks.PostToolUse[0]!.hooks[0]!({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: 'ok', tool_use_id: toolUseID }, toolUseID, { signal })
  }
}

/** The first query: it waits for the steer's interrupt, then ends as an interrupted query does. */
const interruptedByTheSteer: Script = async function* (_prompt, query) {
  yield init
  await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalled(), { timeout: 2_000, interval: 10 })
  yield interrupted
}

describe('a steer into a bot\'s Claude Code turn (#920)', () => {
  it('a Stop between the interrupt and the restarted query hands the steer back once, and it is never accepted', async () => {
    const turn = botTurn([
      async function* (prompt, query) {
        // The Stop lands as the interrupted query is closed, before the query that would carry the steer starts.
        query.close.mockImplementation(() => turn.stop.abort())
        yield* interruptedByTheSteer(prompt, query)
      }
    ])
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries).toHaveLength(1)
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.events).toEqual(['drained', 'taken drain-1', 'returned use the other file drain-1'])
  })

  it('a Stop after the restarted query starts, before Claude Code reads the steer, hands it back once', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* () {
        yield init
        turn.stop.abort()
        yield init
      }
    ])
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries).toHaveLength(2)
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a steer Claude Code took for its next request just before the Stop, with no answer from the model, is handed back once', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        // Taken is not read: the request that would carry it has not gone out when the Stop lands.
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        turn.stop.abort()
        yield init
      }
    ])
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a steer the model answered just before the Stop is accepted once and not handed back', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        yield { type: 'assistant', message: { role: 'assistant', model: 'sonnet', content: [{ type: 'text', text: 'on it' }] }, parent_tool_use_id: null, session_id: SESSION }
        turn.stop.abort()
        yield init
      }
    ])
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
  })

  it('a steer is accepted once, when the restarted query reads it, not when it is collected', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        turn.events.push('restarted')
        // Queued is not read.
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'queued', session_id: SESSION }
        turn.events.push('queued')
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        yield done
      }
    ])
    expect(await turn.run()).toBe('done')
    expect(turn.queries).toHaveLength(2)
    expect(turn.prompts[1]!.message.content).toBe('use the other file')
    expect(turn.prompts[1]!.uuid).toEqual(expect.any(String))
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
    expect(turn.events).toEqual(['drained', 'taken drain-1', 'restarted', 'queued', 'accepted use the other file drain-1'])
  })

  it('a second steer before the first is read goes in after it, and each is accepted once', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* (prompt, query) {
        await firstMessage(prompt)
        yield init
        // The restarted query has not read its prompt when the second steer comes in and interrupts it.
        turn.pending.push({ text: 'and keep the tests', token: 'drain-2' })
        yield* interruptedByTheSteer(prompt, query)
      },
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        yield done
      }
    ])
    expect(await turn.run()).toBe('done')
    expect(turn.queries).toHaveLength(3)
    expect(turn.prompts[2]!.message.content).toBe('use the other file\nand keep the tests')
    expect(turn.steer.onSteer.mock.calls).toEqual([['use the other file', 'drain-1'], ['and keep the tests', 'drain-2']])
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
  })

  it('model output with no lifecycle frame counts as reading the steer', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* () {
        yield init
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          parent_tool_use_id: null,
          uuid: 'event-1',
          session_id: SESSION
        }
        turn.stop.abort()
        yield init
      }
    ])
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
  })

  it("a note into a bot's turn resumes the same session under the same lock and system text (it widens nothing)", async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        yield done
      }
    ])
    expect(await turn.run()).toBe('done')
    const [first, restarted] = turn.options
    expect(restarted).toMatchObject({ resume: SESSION, permissionMode: 'default', settingSources: [], strictMcpConfig: true, plugins: [] })
    for (const key of ['tools', 'disallowedTools', 'systemPrompt', 'maxTurns', 'canUseTool', 'hooks', 'cwd']) expect(restarted![key]).toEqual(first![key])
    // The bot's own system text, rendered fresh on each request of the session: the same on both.
    expect(first!.systemPrompt).toEqual({ type: 'custom', prompt: 'Your name is Pip. You keep my day in order.', snapshot: false })
  })

  it("a compaction inside a bot's turn is reported: Claude Code's compacting status, then its boundary", async () => {
    const turn = botTurn([
      async function* () {
        yield init
        yield { type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION }
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180_000 }, session_id: SESSION }
        yield done
      }
    ])
    turn.pending.splice(0)
    expect(await turn.run()).toBe('done')
    expect(turn.onCompaction.mock.calls).toEqual([['start'], ['complete']])
  })

  it('a call the model makes once the cut is decided is refused before it runs: nothing is cut mid-run', async () => {
    // Checked after the turn: an error thrown inside the interrupted query is read as the interrupt's own.
    const decided: Record<string, unknown> = {}
    const turn = botTurn([
      async function* (_prompt, query) {
        yield init
        await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalled(), { timeout: 2_000, interval: 10 })
        // Announced after the check, before the interrupt lands: both of the gate's checks refuse it, so it never starts.
        const gate = gateOf(turn.options[0]!)
        const path = join(turn.root, 'notes.md')
        decided.pre = await gate.pre('late-1', path)
        decided.canUse = await gate.canUse('late-1', path)
        yield interrupted
      },
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        // The query that carries the note runs calls again.
        decided.next = await gateOf(turn.options[1]!).canUse('next-1', join(turn.root, 'notes.md'))
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        yield done
      }
    ])
    expect(await turn.run()).toBe('done')
    expect(CLAUDE_CUT_REFUSAL).toContain('did not run')
    expect(decided.pre).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: CLAUDE_CUT_REFUSAL } })
    expect(decided.canUse).toEqual({ behavior: 'deny', message: CLAUDE_CUT_REFUSAL })
    expect(decided.next).toMatchObject({ behavior: 'allow' })
    expect(turn.prompts[1]!.message.content).toBe('use the other file')
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a call the gate let start holds the cut until it ends, even before Mousse has read the frame that announces it', async () => {
    let interruptsWhileRunning = -1
    const turn = botTurn([
      async function* (_prompt, query) {
        // Claude Code asks about the call (and runs it) before its frame reaches Mousse.
        const gate = gateOf(turn.options[0]!)
        expect(await gate.canUse('early-1', join(turn.root, 'notes.md'))).toMatchObject({ behavior: 'allow' })
        yield init
        // Polls come and go while it runs: the note goes back to wait each time, and nothing is interrupted.
        await vi.waitFor(() => expect(turn.steer.returnSteer).toHaveBeenCalled(), { timeout: 2_000, interval: 10 })
        await new Promise((resolve) => setTimeout(resolve, 300))
        interruptsWhileRunning = query.interrupt.mock.calls.length
        await gate.post('early-1')
        await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalled(), { timeout: 2_000, interval: 10 })
        yield interrupted
      },
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
        yield done
      }
    ])
    // A note handed back waits to be taken again.
    turn.steer.returnSteer.mockImplementation((text: string, token?: string) => { turn.pending.unshift({ text, token: token ?? 'drain-x' }) })
    expect(await turn.run()).toBe('done')
    expect(interruptsWhileRunning).toBe(0)
    expect(turn.prompts[1]!.message.content).toBe('use the other file')
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a failed result from the restarted query is not a read, and the steer is handed back', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* () {
        yield init
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['failed'], session_id: SESSION }
      }
    ])
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries).toHaveLength(2)
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })
})
