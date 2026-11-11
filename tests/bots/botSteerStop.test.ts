/**
 * Issue #920: a steer into a bot's Claude Code turn. A bot's turn is one query with no live session, so a steer
 * interrupts it and goes in as the prompt of a query that restarts the turn. The steer is accepted only once that
 * query reads it; a Stop before then hands it back, once, by its drain's token.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBotAuthority } from '../../src/mms/bots/authority/botAuthority'
import type { ClaudeLockedTurn } from '../../src/mms/harness/claude/locked'
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
  const query = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }): Query => {
    const script = scripts[queries.length]
    if (!script) throw new Error('no query left to start')
    const fake: FakeQuery = { close: vi.fn(), interrupt: vi.fn(async () => {}) }
    queries.push(fake)
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
    systemPrompt: '',
    ledger: { start: () => 'row', commit: () => undefined, failed: () => undefined }
  }
  const stop = new AbortController()
  const events: string[] = []
  let drained = false
  const steer = {
    // One steer, drained once by the turn's first poll.
    drainSteerEntry: vi.fn(() => {
      if (drained) return undefined
      drained = true
      events.push('drained')
      return { text: 'use the other file', token: 'drain-1' }
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
    ...steer
  })
  return { run, stop, steer, queries, prompts, events }
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

  it('a steer Claude Code read just before the Stop is accepted once and not handed back', async () => {
    const turn = botTurn([
      interruptedByTheSteer,
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield { type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION }
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
})
