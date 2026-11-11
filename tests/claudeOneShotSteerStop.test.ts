/**
 * Issue #920: a steer into a Claude Code turn that runs as one query, as a person's turn does past the live-process cap.
 * The steer interrupts the query and goes in as the prompt of a query that restarts the turn. A Stop must not let that
 * query's process go on to send the steer to the model while Mousse hands it back to be sent again: the process is sent
 * SIGTERM at once, and what it wrote before it died decides whether the steer was read (accepted) or not (handed back).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubscriptionProviderService } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'

const dirs: string[] = []
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', temp('one-shot-steer-user-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SESSION = 'one-shot-session'
const init = { type: 'system', subtype: 'init', session_id: SESSION }
const interrupted = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], session_id: SESSION }
const done = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION }
const started = (uuid: string | undefined) => ({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', session_id: SESSION })
/** The model's first streamed frame for the request that carries the steer. */
const answer = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, parent_tool_use_id: null, uuid: 'event-1', session_id: SESSION }

/** The Claude Code process behind a fake query, as the SDK's transport holds it: Mousse's handle signals it. */
type FakeProcess = { pid: number; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> }
type FakeQuery = { close: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn>; process: FakeProcess }
/** One query's frames: given the prompt it was started with and its own fake. */
type Script = (prompt: AsyncIterable<SDKUserMessage>, query: FakeQuery) => AsyncGenerator<unknown>

async function firstMessage(prompt: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage> {
  for await (const message of prompt) return message
  throw new Error('the query had no prompt')
}

/**
 * A person's turn past the live-process cap (no slot, so one query per run of the turn), each query from `scripts`
 * in order. `beforeStart(n)` runs as query `n` is being started, before the turn has it.
 */
function cappedTurn(scripts: Script[], steersQueued: { text: string; token: string }[], beforeStart?: (index: number) => void) {
  const home = temp('one-shot-steer-home-')
  const binary = join(home, 'claude')
  writeFileSync(binary, 'fixture')
  chmodSync(binary, 0o755)
  const directory = join(home, 'providers', 'claude-subscription')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ loginPolicy: 'cli', binaryPath: binary, models: [{ id: 'sonnet', label: 'Sonnet' }] }))
  const queries: FakeQuery[] = []
  const prompts: SDKUserMessage[] = []
  const events: string[] = []
  const query = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }): Query => {
    const index = queries.length
    const script = scripts[index]
    if (!script) throw new Error('no query left to start')
    const process: FakeProcess = {
      pid: 70_000 + index,
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal?: string) => {
        events.push(`kill ${index} ${signal}`)
        process.signalCode = signal ?? 'SIGTERM'
        return true
      })
    }
    const fake: FakeQuery = { close: vi.fn(() => { events.push(`close ${index}`) }), interrupt: vi.fn(async () => {}), process }
    queries.push(fake)
    const read = firstMessage(prompt).then((message) => {
      prompts.push(message)
      return message
    })
    const replay = (async function* (): AsyncGenerator<SDKUserMessage> {
      yield await read
    })()
    beforeStart?.(index)
    return Object.assign(script(replay, fake), { close: fake.close, interrupt: fake.interrupt, transport: { process } }) as unknown as Query
  }
  const reap = vi.fn(async (pid: number) => {
    events.push(`reap ${pid - 70_000}`)
    return 'ended' as const
  })
  const service = new ClaudeSubscriptionProviderService(home, new UserQuestionService(), {
    query,
    reap,
    // Every live slot is taken: the turn runs as one query, as a person's turn past the cap does.
    live: { maxSessions: 0 },
    runAuth: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
  })
  const cwd = temp('one-shot-steer-cwd-')
  const stop = new AbortController()
  const pending = [...steersQueued]
  const steer = {
    drainSteerEntry: vi.fn(() => pending.shift()),
    steerTaken: vi.fn((token?: string) => { events.push(`taken ${token}`) }),
    onSteer: vi.fn((text: string, token?: string) => { events.push(`accepted ${text} ${token}`) }),
    returnSteer: vi.fn((text: string, token?: string) => { events.push(`returned ${text} ${token}`) })
  }
  const run = () => service.chat({ threadId: 'thread', cwd, model: 'sonnet', prompt: 'go', signal: stop.signal, onText: vi.fn(), ...steer })
  return { run, stop, steer, queries, prompts, events, pending, reap }
}

const ONE = [{ text: 'use the other file', token: 'drain-1' }]
const TWO = [...ONE, { text: 'and keep the tests', token: 'drain-2' }]

/** The first query: it waits for the steer's interrupt and for every queued steer to be taken, then ends interrupted. */
const interruptedByTheSteers = (pending: () => unknown[]): Script => async function* (_prompt, query) {
  yield init
  await vi.waitFor(() => {
    expect(query.interrupt).toHaveBeenCalled()
    expect(pending()).toHaveLength(0)
  }, { timeout: 2_000, interval: 10 })
  yield interrupted
}

/** A restarted query a Stop reaches before Claude Code reads its prompt; one whose process is not killed reads it anyway. */
const stoppedBeforeRead = (stop: () => void): Script => async function* (prompt, query) {
  const { uuid } = await firstMessage(prompt)
  yield init
  stop()
  // The process is still up when Mousse sees the Stop.
  yield init
  // Not killed, Claude Code takes the prompt and sends it to the model: the hands-on failure.
  if (query.process.signalCode === null) {
    yield started(uuid)
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo' }] }, session_id: SESSION }
  }
}

describe('a Stop after a steer into a one-shot Claude Code turn (#920)', () => {
  it('a Stop before the restarted query starts: nothing is started, and the steer is handed back once', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      async function* (prompt, query) {
        yield init
        await vi.waitFor(() => expect(query.interrupt).toHaveBeenCalled(), { timeout: 2_000, interval: 10 })
        turn.stop.abort()
        yield interrupted
      }
    ], ONE)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries).toHaveLength(1)
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a Stop while the restarted query is starting ends its process before it reads the steer, and hands the steer back once', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt, query) {
        const { uuid } = await firstMessage(prompt)
        yield init
        if (query.process.signalCode === null) {
          yield started(uuid)
          yield done
        }
      }
    ], ONE, (index) => {
      // The Stop lands as the process starts, before the turn holds the query.
      if (index === 1) turn.stop.abort()
    })
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries).toHaveLength(2)
    expect(turn.queries[1]!.process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a Stop after the restarted query starts, before it reads the steer: its process is killed and the steer handed back once', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([interruptedByTheSteers(() => turn.pending), stoppedBeforeRead(() => turn.stop.abort())], ONE)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries).toHaveLength(2)
    // SIGTERM through Mousse's handle, before the output is closed, then the tree is reaped.
    expect(turn.queries[1]!.process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(turn.events.indexOf('kill 1 SIGTERM')).toBeLessThan(turn.events.indexOf('close 1'))
    expect(turn.reap).toHaveBeenCalledWith(70_001, expect.anything())
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a Stop after the model answered the steer, with that frame still in flight, counts it read and does not hand it back', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield init
        turn.stop.abort()
        // Written before the SIGTERM landed; Mousse reads them after the Stop.
        yield init
        yield started(uuid)
        yield answer
      }
    ], ONE)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
  })

  it('Claude Code took the steer for its next request, then a Stop came before the model answered: handed back once, never accepted', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield init
        // Taken about 200 ms before the request goes out; the Stop lands in between (hands-on t8).
        yield started(uuid)
        turn.stop.abort()
        yield init
      }
    ], ONE)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.queries[1]!.process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a taken steer whose only answer is a message Claude Code made up itself is handed back once on a Stop', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield init
        yield started(uuid)
        yield { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] }, session_id: SESSION }
        turn.stop.abort()
        yield init
      }
    ], ONE)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
  })

  it('a taken steer the model answered before the Stop is accepted once and not handed back', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield init
        yield started(uuid)
        yield answer
        turn.stop.abort()
        yield init
      }
    ], ONE)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
  })

  it('two steers, then a Stop before the restarted query reads them: its process is killed and each is handed back once, in order', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([interruptedByTheSteers(() => turn.pending), stoppedBeforeRead(() => turn.stop.abort())], TWO)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.prompts[1]!.message.content).toBe('use the other file\nand keep the tests')
    expect(turn.queries[1]!.process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
    expect(turn.steer.returnSteer.mock.calls).toEqual([['use the other file', 'drain-1'], ['and keep the tests', 'drain-2']])
  })

  it('two steers, then a Stop as the model answers them: each is accepted once and none is handed back', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt) {
        const { uuid } = await firstMessage(prompt)
        yield init
        turn.stop.abort()
        // Written before the SIGTERM landed: frames that are not a read, then the model's answer.
        yield init
        yield started(uuid)
        yield answer
      }
    ], TWO)
    await expect(turn.run()).rejects.toThrow()
    expect(turn.steer.onSteer.mock.calls).toEqual([['use the other file', 'drain-1'], ['and keep the tests', 'drain-2']])
    expect(turn.steer.returnSteer).not.toHaveBeenCalled()
  })

  it('a stopped process that never ends its output is read no longer than the drain deadline, and the steer is handed back once', async () => {
    let turn!: ReturnType<typeof cappedTurn>
    turn = cappedTurn([
      interruptedByTheSteers(() => turn.pending),
      async function* (prompt) {
        await firstMessage(prompt)
        yield init
        turn.stop.abort()
        yield init
        // Hangs: neither exits nor writes again.
        await new Promise(() => undefined)
      }
    ], ONE)
    const stoppedAt = Date.now()
    await expect(turn.run()).rejects.toThrow()
    expect(Date.now() - stoppedAt).toBeLessThan(4_000)
    expect(turn.steer.returnSteer).toHaveBeenCalledExactlyOnceWith('use the other file', 'drain-1')
    expect(turn.steer.onSteer).not.toHaveBeenCalled()
  })
})
