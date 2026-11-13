/**
 * The Cursor driver behind the gateway (agent CLIs plan §6): turns replayed at the host protocol
 * through the real driver and session lifecycle, recovery of an active run that is provably the
 * thread's own, a transport failure that ends the turn once, a host crash that ends every live
 * turn once as interrupted, and the uncontrolled-tools rules.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorHostCallError, CursorHostClient } from '../../src/mms/harness/cursor/hostClient'
import { CursorSessions, cursorToolActivity, cursorToolName } from '../../src/mms/harness/cursor/session'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { isCursorAuthFailure, redactCursorText } from '../../src/mms/harness/hosts/cursorProtocol'
import { piDriver } from '../../src/mms/harness/drivers/pi'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { ProviderInstanceService } from '../../src/mms/harness/instanceMap'
import type { TurnInput, TurnResult } from '../../src/mms/harness/adapter'
import type { StreamingLlmToolEvent } from '../../src/mms/harness/turnEvents'
import { replayCursorHost } from '../../src/mms/run/testkit/cursorHostReplay'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { readTranscript, ReplayTransport } from '../../src/mms/run/testkit/ReplayTransport'
import { FakeCursorHost, hostFailure } from './fakeCursorHost'
import { CURSOR_CAPS } from '../../src/mms/harness/drivers/cursor'
import { holdControl, type HoldControl } from '../support/steerHoldControl'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'

const FIXTURES = join(__dirname, '..', 'run', 'fixtures')
const INSTANCE = 'cursor:work'
const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function setup(connect: NonNullable<NonNullable<Parameters<typeof cursorDriver>[0]>['connect']>, initial?: (home: string) => unknown, extra: { loadDeadlineMs?: number; questions?: UserQuestionService } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-cursor-driver-'))
  homes.push(home)
  const stateDir = instanceStateDir(home, INSTANCE)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ apiKey: 'replay-key', apiKeySubject: 'cursor-user:1' }))
  if (initial) writeFileSync(join(stateDir, 'cursor.json'), JSON.stringify(initial(home)))
  let stored: unknown = { [INSTANCE]: { driver: 'cursor', enabled: true, config: { displayName: 'Work' } } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const { questions, ...driverOptions } = extra
  const harness = testHarness({ drivers: [cursorDriver({ connect, cancelDeadlineMs: 200, ...driverOptions })], instances, profileHome: home, ...(questions ? { questions } : {}) })
  const notices: Array<[string, string]> = []
  harness.setLiveHost({ notice: (threadId, text) => notices.push([threadId, text]) })
  harnesses.push(harness)
  const texts = new Map<string, string>()
  const spec = (threadId: string, binding: TurnSpec['binding'], options: { prompt?: string; history?: string; signal?: AbortSignal; mcp?: { url: string; token: string }; tool?: (event: StreamingLlmToolEvent) => void; hold?: HoldControl } = {}): TurnSpec => ({
    binding,
    input: {
      threadId,
      instanceId: binding.instanceId,
      llmProvider: '',
      model: binding.model,
      mode: 'agent',
      prompt: options.prompt ?? 'hi',
      cwd: home,
      nativeHistory: options.history ?? '',
      signal: options.signal ?? new AbortController().signal
    } as unknown as TurnInput,
    sink: (options.hold ? options.hold.wrap.bind(options.hold) : <S>(sink: S) => sink)({
      text: (event: { phase: string; content: string }) => event.phase !== 'start' && texts.set(threadId, event.content),
      thinking: () => {},
      tool: options.tool ?? (() => {}),
      progress: () => {},
      providerRef: () => {},
      steerAccepted: () => {},
      usage: () => {}
    } as unknown as TurnSpec['sink']),
    control: options.hold?.ctl ?? ({ drainSteer: () => undefined, heartbeat: () => {} } as unknown as TurnSpec['control']),
    host: {
      ...(options.mcp ? { bridge: { mcp: options.mcp, turnToken: 't', sessionInstructions: '', turnPreamble: '', userMcp: 'native' } } : {}),
      context: { nativeHistoryAfterTurn: (text: string) => text }
    } as unknown as TurnSpec['host']
  })
  const turn = async (threadId: string, options: Parameters<typeof spec>[2] = {}) => {
    const binding = await harness.bind(harness.resolveStored({ instanceId: INSTANCE, llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent', permissionMode: 'full' })
    return harness.startTurn(spec(threadId, binding, options))
  }
  const state = () => JSON.parse(readFileSync(join(stateDir, 'cursor.json'), 'utf8')) as { sessions: Record<string, { agentId: string; runIds: string[]; historyKey?: string }> }
  return { home, harness, turn, texts, notices, state }
}

function replay(name: string) {
  return new ReplayTransport(readTranscript(join(FIXTURES, name, 'cursor.ndjson')))
}

describe('Cursor turns at the host protocol', () => {
  it('recovers an active run of its own once: cancels the recorded run and sends the current message again', async () => {
    const transport = replay('active-run-conflict')
    const { turn } = setup(replayCursorHost(transport), (home) => ({
      sessions: { thread: { agentId: 'agent-1', cwd: home, historyKey: createHash('sha256').update('').digest('hex'), runIds: ['run-0'] } }
    }))
    const result = await (await turn('thread', { prompt: 'Continue' })).result
    expect(result).toMatchObject({ text: 'Continuing', aborted: false })
    transport.assertDone()
  })

  it('refuses to cancel an active run Mousse did not record for the thread', async () => {
    const host = new FakeCursorHost({
      resume: (params) => ({ agentId: params.agentId }),
      send: () => {
        throw hostFailure('Agent agent-1 already has active run run-x', { activeRun: true })
      },
      listRuns: () => ({ runs: [{ id: 'run-x', status: 'running' }] })
    })
    const { turn } = setup(host.connect, (home) => ({
      sessions: { thread: { agentId: 'agent-1', cwd: home, historyKey: createHash('sha256').update('').digest('hex'), runIds: ['run-0'] } }
    }))
    await expect((await turn('thread')).result).rejects.toThrow(/still running an earlier request/)
    expect(host.calls('cancelRun')).toEqual([])
    expect(host.calls('send')).toHaveLength(1)
  })

  it('ends a turn whose reply is only a transport failure once, after its tool ran, and sends nothing again', async () => {
    const transport = replay('transport-failure-after-tool')
    const { turn } = setup(replayCursorHost(transport))
    await expect((await turn('thread', { prompt: 'Fix the build' })).result).rejects.toThrow(/lost its connection to Cursor/)
    transport.assertDone()
  })

  it('a host crash ends both live turns once as interrupted; the next turn starts a new host and hands the history over', async () => {
    const transport = replay('host-crash-two-threads')
    const { turn, texts, state } = setup(replayCursorHost(transport))
    const first = await turn('a', { prompt: 'Fix the build' })
    await vi.waitFor(() => expect(texts.get('a')).toBe('Looking'))
    const second = await turn('b', { prompt: 'Write docs' })
    const [a, b] = (await Promise.all([first.result, second.result])) as [TurnResult, TurnResult]
    expect(a).toMatchObject({ text: 'Looking', aborted: true })
    expect(b).toMatchObject({ text: 'Drafting', aborted: true })
    // Neither agent may be resumed: their runs ended in an unknown state.
    expect(state().sessions.a?.historyKey).toBeUndefined()
    const next = await (await turn('a', { prompt: 'Try again', history: 'user: Fix the build' })).result
    expect(next).toMatchObject({ text: 'Done', aborted: false })
    transport.assertDone()
  })
})

describe('moving pi:cursor to Cursor', () => {
  it('turns the model API off, gives Cursor its key when asked, and a pinned thread continues on Cursor', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-cursor-move-'))
    homes.push(home)
    const host = new FakeCursorHost({ me: (params) => ({ userId: params.apiKey === 'pi-cursor-key' ? 9 : 1 }), models: () => ({ models: [{ id: 'composer-1', displayName: 'Composer' }] }) })
    let stored: unknown = { 'pi:cursor': { driver: 'pi', enabled: true }, [INSTANCE]: { driver: 'cursor', enabled: true, config: { displayName: 'Work' } } }
    const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
    const harness = testHarness({
      drivers: [
        piDriver({ credentials: () => ({ has: () => true, storedApiKey: (id: string) => (id === 'cursor' ? 'pi-cursor-key' : undefined), getConfiguredProviders: () => [], getConfiguredLlmProviders: () => [] })
        }),
        cursorDriver({ connect: host.connect })
      ],
      instances,
      profileHome: home
    })
    harnesses.push(harness)
    const result = await harness.instances.move('pi:cursor', INSTANCE, { copyKey: true })
    expect(result).toMatchObject({ from: 'pi:cursor', to: INSTANCE })
    expect((stored as Record<string, unknown>)['pi:cursor']).toEqual({ driver: 'pi', enabled: false, config: { movedTo: INSTANCE } })
    expect(host.calls('me')).toContainEqual({ apiKey: 'pi-cursor-key' })
    const resolved = harness.resolveStored({ instanceId: 'pi:cursor', llmProvider: 'cursor', model: 'composer-1' }, { purpose: 'turn' })
    expect(resolved).toMatchObject({ instanceId: INSTANCE, driver: 'cursor', movedFrom: 'pi:cursor' })
  })
})

describe('Cursor behind the gateway', () => {
  it('approves tools itself: interactive purposes only, told once per thread', async () => {
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' }), 5)
        return { runId: 'run-1' }
      }
    })
    const { harness, turn, notices } = setup(host.connect)
    const selection = { instanceId: INSTANCE, llmProvider: '', model: 'default' }
    expect(harness.resolveStored(selection, { purpose: 'composer' })).toMatchObject({ caps: { toolControl: 'uncontrolled', planMode: true, events: 'rich' } })
    expect(() => harness.resolveStored(selection, { purpose: 'delegate_task' })).toThrow(expect.objectContaining({ code: 'policy_unenforceable' }))
    await (await turn('thread')).result
    await (await turn('thread')).result
    expect(notices).toEqual([['thread', 'Work approves tools itself.']])
    // Nothing to find or install: the page shows the bundled SDK and the key's sign-in.
    const [snapshot] = await harness.instances.snapshots({ kind: 'device' })
    expect(snapshot).toMatchObject({ driver: 'cursor', runs: { state: 'yes' }, binary: { source: 'bundled' }, auth: { state: 'signed_in', methodLabel: 'API key', canSignOut: true } })
  })

  it('a run the provider refused shows its status and message, credentials removed; a refused key still asks for a sign-in', async () => {
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'error', error: { message: 'Model gpt-x is not available on your plan (key crsr_abcdefghijklmnopqrstuv)', status: 400 } }), 5)
        return { runId: 'run-1' }
      }
    })
    const { turn } = setup(host.connect)
    await expect((await turn('thread')).result).rejects.toMatchObject({ code: 'provider_api_error', message: '400 · Model gpt-x is not available on your plan (key [redacted])', details: { provider: 'cursor', status: 400 } })
    const refusedKey = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'error', error: { message: 'Invalid API key', code: 'unauthenticated', auth: true } }), 5)
        return { runId: 'run-1' }
      }
    })
    const second = setup(refusedKey.connect)
    await expect((await second.turn('thread')).result).rejects.not.toMatchObject({ code: 'provider_api_error' })
  })

  it('passes the key on every agent call, and a stop cancels a run whose send was still in flight', async () => {
    let releaseSend!: () => void
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: () => new Promise((resolve) => { releaseSend = () => resolve({ runId: 'run-1' }) }),
      cancel: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'cancelled' }), 5)
        return { cancelled: true }
      }
    })
    const { turn } = setup(host.connect)
    const stop = new AbortController()
    const handle = await turn('thread', { signal: stop.signal })
    await vi.waitFor(() => expect(host.calls('send')).toHaveLength(1))
    stop.abort()
    releaseSend()
    expect(await handle.result).toMatchObject({ aborted: true })
    expect(host.calls('cancel')).toEqual([{ runId: 'run-1' }])
    expect(host.calls('create')[0]).toMatchObject({ apiKey: 'replay-key', autoReview: true, settingSources: ['project', 'user', 'team', 'mdm', 'plugins'] })
  })

  it('a stop that misses the deadline ends the host: both live turns end once, interrupted, and the other thread is told why', async () => {
    const host = new FakeCursorHost({
      create: (_params, fake) => ({ agentId: `agent-${fake.calls('create').length}` }),
      send: (params) => ({ runId: `run-${String(params.agentId).slice(-1)}` }),
      // Cursor never confirms the cancel.
      cancel: () => new Promise(() => {})
    })
    const { turn, notices } = setup(host.connect)
    const stuck = await turn('a')
    await vi.waitFor(() => expect(stuck.providerRef()?.sessionId).toBe('agent-1'))
    const other = await turn('b')
    await vi.waitFor(() => expect(host.calls('send')).toHaveLength(2))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const interrupted = stuck.interrupt()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await interrupted).toBe('interrupted')
    } finally {
      vi.useRealTimers()
    }
    expect(await stuck.result).toMatchObject({ aborted: true })
    expect(await other.result).toMatchObject({ aborted: true })
    expect(host.transports).toHaveLength(1)
    expect(notices.filter(([threadId, text]) => threadId === 'b' && text.includes('restarted')).map(([, text]) => text)).toEqual(['Work was restarted to stop another chat, so this reply was cut short.'])
    expect(notices.some(([threadId, text]) => threadId === 'a' && text.includes('restarted'))).toBe(false)
  })
})

describe("the hold: a person's steer waits for a running tool (docs/design/steer-and-interruptions.md §2.7)", () => {
  const STEER = 'Use pnpm, not npm'
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  function held(options: { cancel?: 'ends' | 'never' } = {}) {
    let runs = 0
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: () => ({ runId: `run-${++runs}` }),
      cancel: (params, fake) => {
        if (options.cancel === 'never') return new Promise(() => {})
        setTimeout(() => fake.emit({ event: 'run_end', runId: params.runId as string, status: 'cancelled' }), 5)
        return { cancelled: true }
      }
    })
    const delta = (runId: string, update: Record<string, unknown>) => host.emit({ event: 'delta', runId, update } as never)
    const shell = (callId: string, command = 'npm test') => ({ type: 'shell', args: { command } })
    const toolStart = (runId: string, callId: string) => delta(runId, { type: 'tool-call-started', callId, toolCall: shell(callId) })
    const toolDone = (runId: string, callId: string) => delta(runId, { type: 'tool-call-completed', callId, toolCall: { ...shell(callId), result: { status: 'success', value: { exitCode: 0 } } } })
    const writes = (runId: string, text: string) => delta(runId, { type: 'text-delta', text })
    const end = (runId: string, status = 'finished') => host.emit({ event: 'run_end', runId, status } as never)
    const questions = new UserQuestionService()
    // As in the orchestrator: a question pending in the thread means the turn waits for a person.
    const hold = holdControl(CURSOR_CAPS, { questions: { pending: () => questions.listPendingForThread('thread').length > 0 } })
    const { turn } = setup(host.connect, undefined, { questions })
    const events = () => hold.log.map(([event, detail]) => `${event}:${detail}`)
    /** The run `n` streams (its updates are watched). */
    const running = (n: number) => vi.waitFor(() => expect(events().filter((event) => event === 'providerTurn:')).toHaveLength(n))
    const sent = () => host.calls('send').map((params) => params.text)
    const mcpStart = (runId: string, callId: string, toolName: string) => delta(runId, { type: 'tool-call-started', callId, toolCall: { type: 'mcp', args: { toolName, providerIdentifier: 'mousse', args: {} } } })
    return { host, hold, questions, turn: () => turn('thread', { hold }), events, running, toolStart, toolDone, mcpStart, writes, end, sent }
  }
  const order = (events: string[], ...steps: string[]) => {
    let from = 0
    for (const step of steps) {
      const at = events.indexOf(step, from)
      expect(at, `${step} in ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(from)
      from = at + 1
    }
  }

  it.each([['held for a command before', true], ['sent while it asks', false]] as const)('Mousse\'s ask_user over MCP does not hold a steer (%s): it cancels the run and answers the question', async (_name, heldBefore) => {
    const c = held()
    const handle = await c.turn()
    await c.running(1)
    if (heldBefore) {
      c.toolStart('run-1', 'call-1')
      c.hold.steer(STEER)
      await vi.waitFor(() => expect(c.hold.held()).toBe(true))
      c.toolDone('run-1', 'call-1')
    }
    c.mcpStart('run-1', 'ask-1', 'ask_user')
    await vi.waitFor(() => expect(c.events()).toContain('tool:start:ask-1'))
    const answer = c.questions.requestAnswers([{ id: 'q', prompt: 'Which package manager?', options: [{ id: 'npm', label: 'npm' }, { id: 'skip', label: 'Skip' }] }], 'thread')
    answer.catch(() => undefined)
    if (!heldBefore) c.hold.steer(STEER)
    await vi.waitFor(() => expect(c.host.calls('cancel')).toEqual([{ runId: 'run-1' }]))
    await expect(answer).resolves.toEqual({ q: 'skip' })
    await c.running(2)
    c.end('run-2')
    await handle.result
    expect(c.sent()).toEqual(['hi', STEER])
    expect(c.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
  })

  it('strict boundary drain: a steer held during a tool goes in as the next run when the run ends, and nothing is cancelled', async () => {
    const c = held()
    const handle = await c.turn()
    await c.running(1)
    c.toolStart('run-1', 'call-1')
    c.hold.steer(STEER)
    await vi.waitFor(() => expect(c.hold.held()).toBe(true))
    c.toolDone('run-1', 'call-1')
    c.writes('run-1', 'All 12 passed.')
    // Cursor's gaps were never measured: the steer stays held past the output (strict release).
    await sleep(300)
    expect(c.hold.held()).toBe(true)
    c.end('run-1')
    await c.running(2)
    c.writes('run-2', 'Switching to pnpm')
    c.end('run-2')
    expect(await handle.result).toMatchObject({ aborted: false })
    expect(c.host.calls('cancel')).toEqual([])
    expect(c.sent()).toEqual(['hi', STEER])
    order(c.events(), 'tool:complete:call-1', 'boundary:', `drain:${STEER}`, 'providerTurn:', 'taken:drain-1', `accepted:${STEER}@drain-1`)
    expect(c.events().filter((event) => event.startsWith('mayCut'))).toEqual([])
  })

  it('a steer while Cursor writes cancels the run, and is read only once the next run started', async () => {
    const c = held()
    const handle = await c.turn()
    await c.running(1)
    c.writes('run-1', 'working')
    c.hold.steer(STEER)
    await vi.waitFor(() => expect(c.host.calls('cancel')).toEqual([{ runId: 'run-1' }]))
    await c.running(2)
    c.end('run-2')
    await handle.result
    order(c.events(), `drain:${STEER}`, 'mayCut:true', 'providerTurn:', 'taken:drain-1', `accepted:${STEER}@drain-1`)
    expect(c.sent()).toEqual(['hi', STEER])
  })

  it('a tool that starts between the drain and the cancel keeps the steer: handed back, held, and sent at the run\'s end', async () => {
    const c = held()
    const handle = await c.turn()
    await c.running(1)
    c.writes('run-1', 'working')
    c.hold.beforeMayCut = () => c.toolStart('run-1', 'late')
    c.hold.steer(STEER)
    await vi.waitFor(() => expect(c.events()).toContain(`returned:${STEER}`))
    await vi.waitFor(() => expect(c.hold.held()).toBe(true))
    c.toolDone('run-1', 'late')
    c.end('run-1')
    await c.running(2)
    c.end('run-2')
    await handle.result
    expect(c.host.calls('cancel')).toEqual([])
    order(c.events(), 'mayCut:false', `returned:${STEER}`, 'boundary:', `drain:${STEER}`)
    expect(c.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-2`])
  })

  it('Send now during a tool cancels the run at once, and the steer goes in once', async () => {
    const c = held()
    const handle = await c.turn()
    await c.running(1)
    c.toolStart('run-1', 'call-1')
    c.hold.steer(STEER)
    await vi.waitFor(() => expect(c.hold.held()).toBe(true))
    c.hold.sendNow()
    await vi.waitFor(() => expect(c.host.calls('cancel')).toEqual([{ runId: 'run-1' }]))
    await c.running(2)
    c.end('run-2')
    await handle.result
    expect(c.sent()).toEqual(['hi', STEER])
    expect(c.events().filter((event) => event.startsWith('accepted:'))).toEqual([`accepted:${STEER}@drain-1`])
  })

  it('a host that ends after the cancel and before the next run hands the steer back, never read', async () => {
    const c = held({ cancel: 'never' })
    const handle = await c.turn()
    await c.running(1)
    c.writes('run-1', 'working')
    c.hold.steer(STEER)
    await vi.waitFor(() => expect(c.host.calls('cancel')).toHaveLength(1))
    c.host.crash()
    expect(await handle.result).toMatchObject({ aborted: true })
    expect(c.events().filter((event) => event.startsWith('returned:'))).toEqual([`returned:${STEER}`])
    expect(c.events().filter((event) => event.startsWith('accepted:') || event.startsWith('taken:'))).toEqual([])
  })
})

describe('Stop before the run exists', () => {
  const held = () => {
    let release!: (value: { agentId: string }) => void
    const promise = new Promise<{ agentId: string }>((resolve) => { release = resolve })
    return { promise, release }
  }

  it('a Stop while the agent is still being created ends the turn once, interrupted; the late agent is closed and removed', async () => {
    const creating = held()
    const host = new FakeCursorHost({ create: () => creating.promise, close: () => ({}), prune: () => ({}) })
    const { turn, state } = setup(host.connect)
    const handle = await turn('thread')
    await vi.waitFor(() => expect(host.calls('create')).toHaveLength(1))
    // The ref names the turn before its agent exists.
    expect(handle.providerRef()?.sessionId).toMatch(/^cursor-turn:/)
    expect(await handle.interrupt()).toBe('interrupted')
    expect(await handle.result).toMatchObject({ aborted: true })
    creating.release({ agentId: 'late-agent' })
    await vi.waitFor(() => expect(host.calls('close')).toEqual([{ agentId: 'late-agent' }]))
    await vi.waitFor(() => expect(host.calls('prune')).toEqual([expect.objectContaining({ agentIds: ['late-agent'] })]))
    expect(host.calls('send')).toEqual([])
    expect(() => state()).toThrow()
  })

  it('a Stop while the saved agent is reopening ends the turn once, interrupted; the late agent is closed and kept', async () => {
    const resuming = held()
    const host = new FakeCursorHost({ resume: () => resuming.promise, close: () => ({}) })
    const { turn, state } = setup(host.connect, (home) => ({
      sessions: { thread: { agentId: 'agent-1', cwd: home, historyKey: createHash('sha256').update('').digest('hex'), runIds: [] } }
    }))
    const stop = new AbortController()
    const handle = await turn('thread', { signal: stop.signal })
    await vi.waitFor(() => expect(host.calls('resume')).toHaveLength(1))
    stop.abort()
    expect(await handle.result).toMatchObject({ aborted: true })
    resuming.release({ agentId: 'agent-1' })
    await vi.waitFor(() => expect(host.calls('close')).toEqual([{ agentId: 'agent-1' }]))
    expect(host.calls('create')).toEqual([])
    expect(state().sessions.thread?.agentId).toBe('agent-1')
  })

  it('a late answer to a stopped reopen does not close the agent the next turn reopened', async () => {
    const resumes: Array<(value: { agentId: string }) => void> = []
    const host = new FakeCursorHost({
      resume: () => new Promise((resolve) => resumes.push(resolve)),
      close: () => ({}),
      send: (_params, fake) => {
        const runId = `run-${fake.calls('send').length}`
        setTimeout(() => fake.emit({ event: 'run_end', runId, status: 'finished' }), 1)
        return { runId }
      }
    })
    const { turn } = setup(host.connect, (home) => ({
      sessions: { thread: { agentId: 'agent-1', cwd: home, historyKey: createHash('sha256').update('').digest('hex'), runIds: [] } }
    }))
    const stop = new AbortController()
    const first = await turn('thread', { signal: stop.signal })
    await vi.waitFor(() => expect(resumes).toHaveLength(1))
    stop.abort()
    expect(await first.result).toMatchObject({ aborted: true })
    // The next turn reopens the same agent while the first reopen is still out.
    const second = await turn('thread')
    await vi.waitFor(() => expect(resumes).toHaveLength(2))
    resumes[1]!({ agentId: 'agent-1' })
    await vi.waitFor(() => expect(host.calls('send')).toHaveLength(1))
    resumes[0]!({ agentId: 'agent-1' })
    expect(await second.result).toMatchObject({ aborted: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.calls('close')).toEqual([])
  })

  it('a Stop that comes while a stuck prune runs opens no agent', async () => {
    const host = new FakeCursorHost({ prune: () => new Promise(() => {}), create: () => ({ agentId: 'agent-2' }), resume: () => ({ agentId: 'agent-1' }) })
    const { turn, harness } = setup(host.connect, (home) => ({
      sessions: { old: { agentId: 'agent-0', cwd: home, runIds: [] } }
    }))
    // Forgetting the old thread queues a prune; the host is not running, so the next turn sends it.
    const stop = new AbortController()
    const record = (harness as unknown as { record(id: string): { runtime: { forgetConversation(id: string): void } } }).record(INSTANCE)
    record.runtime.forgetConversation('old')
    const handle = await turn('thread', { signal: stop.signal })
    await vi.waitFor(() => expect(host.calls('prune')).toHaveLength(1))
    stop.abort()
    expect(await handle.result).toMatchObject({ aborted: true })
    expect(host.calls('create')).toEqual([])
    expect(host.calls('resume')).toEqual([])
  })

  it('a saved agent that does not reopen within the load deadline hands the history to a new one', async () => {
    const host = new FakeCursorHost({
      resume: () => new Promise(() => {}),
      create: () => ({ agentId: 'agent-2' }),
      close: () => ({}),
      prune: () => ({}),
      send: (_params, fake) => {
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' }), 1)
        return { runId: 'run-1' }
      }
    })
    const { turn, notices } = setup(host.connect, (home) => ({
      sessions: { thread: { agentId: 'agent-1', cwd: home, historyKey: createHash('sha256').update('').digest('hex'), runIds: [] } }
    }), { loadDeadlineMs: 50 })
    expect(await (await turn('thread')).result).toMatchObject({ aborted: false })
    expect(notices).toContainEqual(['thread', "Work could not reopen this chat's agent, so the chat history was handed to a new one."])
    expect(host.calls('create')).toHaveLength(1)
    await vi.waitFor(() => expect(host.calls('prune')).toEqual([expect.objectContaining({ agentIds: ['agent-1'] })]))
  })
})

describe('The tool name a Cursor call shows as', () => {
  it('maps its call types to tool names, an MCP call to its server and tool, and anything else to a plain name', () => {
    const name = (type: string, args: Record<string, unknown> = {}) => cursorToolName({ type, args })
    expect(['shell', 'read', 'edit', 'write', 'grep', 'glob'].map((type) => name(type))).toEqual(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'])
    // A folder listing is not a file search, and a Cursor task is not a Mousse subagent.
    expect(name('ls', { path: 'src' })).toBe('list_directory')
    expect(name('task')).toBe('cursor_task')
    expect(name('mcp', { providerIdentifier: 'mousse', toolName: 'thread_list' })).toBe('mcp__mousse__thread_list')
    expect(name('mcp', { providerIdentifier: 'my-server', toolName: 'lookup' })).toBe('mcp__my_server__lookup')
    expect(name('mcp', { toolName: 'lookup' })).toBe('lookup')
    expect(name('mcp')).toBeUndefined()
    expect(name('readLints')).toBe('read_lints')
    expect(name('someNewTool')).toBe('cursor_some_new_tool')
    expect(cursorToolName(undefined)).toBeUndefined()
  })

  it('reaches the turn on the tool event', async () => {
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => {
          fake.emit({ event: 'delta', runId: 'run-1', update: { type: 'tool-call-started', callId: 'c1', toolCall: { type: 'ls', args: { path: 'src' } } } })
          fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' })
        }, 1)
        return { runId: 'run-1' }
      }
    })
    const { turn } = setup(host.connect)
    const tools: StreamingLlmToolEvent[] = []
    expect(await (await turn('thread', { tool: (event) => void tools.push(event) })).result).toMatchObject({ aborted: false })
    expect(tools.find((event) => event.phase === 'start')).toMatchObject({ title: 'Ls src', activity: { toolName: 'list_directory' } })
  })

  it('gives a grep its pattern when it starts and how many it found when it ends', async () => {
    const call = { type: 'grep', args: { pattern: 'TODO', path: 'src' } }
    const files = { type: 'files', output: { files: ['src/a.ts', 'src/b.ts'], count: 2 } }
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        setTimeout(() => {
          fake.emit({ event: 'delta', runId: 'run-1', update: { type: 'tool-call-started', callId: 'g1', toolCall: call } })
          fake.emit({ event: 'delta', runId: 'run-1', update: { type: 'tool-call-completed', callId: 'g1', toolCall: { ...call, result: { status: 'success', value: { workspaceResults: { '/repo': files } } } } } })
          fake.emit({ event: 'run_end', runId: 'run-1', status: 'finished' })
        }, 1)
        return { runId: 'run-1' }
      }
    })
    const { turn } = setup(host.connect)
    const tools: StreamingLlmToolEvent[] = []
    expect(await (await turn('thread', { tool: (event) => void tools.push(event) })).result).toMatchObject({ aborted: false })
    expect(tools.find((event) => event.phase === 'start')).toMatchObject({
      title: 'Grep TODO',
      activity: { toolName: 'Grep', kind: 'search', scope: 'code', query: 'TODO', path: 'src' }
    })
    expect(tools.find((event) => event.phase === 'complete')).toMatchObject({
      activity: { kind: 'search', query: 'TODO', resultCount: 2, output: 'src/a.ts\nsrc/b.ts' }
    })
  })

  it('reads every grep output mode and a glob, and marks a failed search', () => {
    const grep = (output: Record<string, unknown>) =>
      cursorToolActivity({ type: 'grep', args: { pattern: 'x' }, result: { status: 'success', value: { workspaceResults: { '/a': output } } } })
    expect(grep({ type: 'count', output: { counts: [{ file: 'a.ts', count: 4 }, { file: 'b.ts', count: 1 }], total: 5 } })).toMatchObject({ resultCount: 5, output: 'a.ts:4\nb.ts:1' })
    expect(grep({ type: 'content', output: { matches: [], totalMatches: 0 } })).toMatchObject({ resultCount: 0, output: '' })
    expect(cursorToolActivity({ type: 'glob', args: { globPattern: '*.md', targetDirectory: 'docs' } })).toEqual({ kind: 'search', scope: 'files', query: '*.md', path: 'docs' })
    expect(cursorToolActivity({ type: 'grep', args: { pattern: 'x' }, result: { status: 'error', error: 'bad regex' } })).toMatchObject({ status: 'failed' })
    expect(cursorToolActivity({ type: 'grep', args: {} })).toBeUndefined()
    expect(cursorToolActivity({ type: 'shell', args: { command: 'ls' } })).toBeUndefined()
  })
})

describe('A host that ends while a send is in flight', () => {
  it('after Cursor accepted the prompt but before it answered: the turn ends once, interrupted, and the next one starts over without resending', async () => {
    const host = new FakeCursorHost({
      create: (_params, fake) => ({ agentId: `agent-${fake.calls('create').length}` }),
      prune: () => ({}),
      send: (params, fake) => {
        if (fake.calls('send').length === 1) {
          // The prompt reached Cursor (a tool already started), then the host died before its reply.
          fake.emit({ event: 'delta', runId: 'run-1', update: { type: 'tool-call-started', callId: 'c1', toolCall: { type: 'shell', args: { command: 'npm test' } } } })
          setTimeout(() => fake.crash(), 1)
          return new Promise(() => {})
        }
        setTimeout(() => fake.emit({ event: 'run_end', runId: 'run-2', status: 'finished' }), 1)
        return { runId: 'run-2' }
      }
    })
    const { turn, state } = setup(host.connect)
    expect(await (await turn('thread', { prompt: 'Fix the build' })).result).toMatchObject({ aborted: true })
    // Its agent may hold a half-run prompt: it is never resumed.
    expect(state().sessions.thread).toBeUndefined()
    expect(await (await turn('thread', { prompt: 'Try again', history: 'user: Fix the build' })).result).toMatchObject({ aborted: false })
    expect(host.calls('send').map((call) => call.text)).toEqual([
      'Fix the build',
      'Previous conversation (context only; do not repeat earlier actions):\nuser: Fix the build\n\nCurrent request:\nTry again'
    ])
    expect(host.calls('prune')).toEqual([expect.objectContaining({ agentIds: ['agent-1'] })])
  })

  it('during active-run recovery: the turn ends once, interrupted', async () => {
    const host = new FakeCursorHost({
      resume: (params) => ({ agentId: params.agentId }),
      send: () => {
        throw hostFailure('Agent agent-1 already has active run run-0', { activeRun: true })
      },
      listRuns: (_params, fake) => {
        setTimeout(() => fake.crash(), 1)
        return new Promise(() => {})
      }
    })
    const { turn } = setup(host.connect, (home) => ({
      sessions: { thread: { agentId: 'agent-1', cwd: home, historyKey: createHash('sha256').update('').digest('hex'), runIds: ['run-0'] } }
    }))
    expect(await (await turn('thread')).result).toMatchObject({ aborted: true })
    expect(host.calls('send')).toHaveLength(1)
  })
})

describe('the Mousse MCP token', () => {
  it('a new token does not reopen the agent: each send carries the current one', async () => {
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: (_params, fake) => {
        const runId = `run-${fake.calls('send').length}`
        setTimeout(() => fake.emit({ event: 'delta', runId, update: { type: 'text-delta', text: 'ok' } }), 1)
        setTimeout(() => fake.emit({ event: 'run_end', runId, status: 'finished' }), 2)
        return { runId }
      }
    })
    const { turn } = setup(host.connect)
    await (await turn('thread', { mcp: { url: 'http://127.0.0.1/mcp', token: 'first' } })).result
    await (await turn('thread', { history: 'ok', mcp: { url: 'http://127.0.0.1/mcp', token: 'second' } })).result
    expect(host.calls('create')).toHaveLength(1)
    expect(host.calls('resume')).toEqual([])
    expect(host.calls('send').map((call) => (call.mcpServers as { mousse: { headers: Record<string, string> } }).mousse.headers.Authorization)).toEqual(['Bearer first', 'Bearer second'])
  })
})

describe('the host client', () => {
  it('drops the updates of a run whose send was never answered when the host exits', () => {
    const fake = new FakeCursorHost()
    const client = new CursorHostClient(fake.connect)
    void client.request('send', { agentId: 'a', text: 'hi' }).catch(() => undefined)
    fake.emit({ event: 'delta', runId: 'orphan', update: { type: 'text-delta', text: 'x' } })
    expect((client as unknown as { early: Map<string, unknown> }).early.size).toBe(1)
    fake.crash()
    expect((client as unknown as { early: Map<string, unknown> }).early.size).toBe(0)
  })

  it('classifies the pinned SDK refusal codes as a sign-out, and redacts keys from host logs', () => {
    expect(new CursorHostCallError({ message: 'Invalid API key', code: 'unauthenticated' }).auth).toBe(true)
    expect(new CursorHostCallError({ message: 'expired', code: 'AUTH_TOKEN_EXPIRED' }).auth).toBe(true)
    expect(new CursorHostCallError({ message: 'busy', code: 'resource_exhausted' }).auth).toBeUndefined()
    // A valid key without enough permission is not a sign-out, thrown or reported by a run.
    expect(isCursorAuthFailure({ name: 'AuthenticationError', code: 'NOT_HIGH_ENOUGH_PERMISSIONS' })).toBe(false)
    expect(new CursorHostCallError({ message: 'no access', code: 'NOT_HIGH_ENOUGH_PERMISSIONS' }).auth).toBeUndefined()
    expect(isCursorAuthFailure({ name: 'AuthenticationError' })).toBe(true)
    const redacted = redactCursorText('Authorization: Bearer abc.def apiKey="key_1234567890abcdef" crsr_abcdefghijkl ConnectError: [unavailable] reset')
    for (const secret of ['abc.def', 'key_1234567890abcdef', 'crsr_abcdefghijkl']) expect(redacted).not.toContain(secret)
    expect(redacted).toContain('ConnectError: [unavailable] reset')
  })
})

describe('ending the host for a stuck stop', () => {
  it('marks the stopping chat only when a host is running to exit', () => {
    let running = false
    const sessions = new CursorSessions({
      label: 'Cursor',
      host: { get running() { return running }, onExit: () => () => undefined, kill: () => undefined, stop: () => undefined, request: () => new Promise(() => {}) } as never,
      storeDir: '/store',
      apiKey: () => 'key',
      settingSources: [],
      store: { saved: () => undefined, setSaved: () => undefined, threads: () => [] },
      markSignedOut: () => undefined,
      signInRequiredMessage: 'sign in'
    })
    let key = ''
    void sessions.chat({ threadId: 'a', cwd: '/w', model: 'default', prompt: 'hi', onText: () => {}, onSession: (id) => { key ||= id } })
    sessions.terminate(key)
    expect((sessions as unknown as { endingFor?: string }).endingFor).toBeUndefined()
    running = true
    sessions.terminate(key)
    expect((sessions as unknown as { endingFor?: string }).endingFor).toBe('a')
  })
})
