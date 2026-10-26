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
import { CursorSessions } from '../../src/mms/harness/cursor/session'
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
import { isCursorAuthFailure, redactCursorText } from '../../src/mms/harness/hosts/cursorProtocol'
import { piLegacyDriver } from '../../src/mms/harness/drivers/piLegacy'
import type { Harness, TurnSpec } from '../../src/mms/harness/gateway'
import { instanceStateDir } from '../../src/mms/harness/instances'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import type { TurnInput, TurnResult } from '../../src/mms/run/adapters/ProviderAdapter'
import { replayCursorHost } from '../../src/mms/run/testkit/cursorHostReplay'
import { testHarness } from '../../src/mms/run/testkit/harness'
import { readTranscript, ReplayTransport } from '../../src/mms/run/testkit/ReplayTransport'
import { FakeCursorHost, hostFailure } from './fakeCursorHost'

const FIXTURES = join(__dirname, '..', 'run', 'fixtures')
const INSTANCE = 'cursor:work'
const homes: string[] = []
const harnesses: Harness[] = []
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function setup(connect: NonNullable<NonNullable<Parameters<typeof cursorDriver>[0]>['connect']>, initial?: (home: string) => unknown, extra: { loadDeadlineMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-cursor-driver-'))
  homes.push(home)
  const stateDir = instanceStateDir(home, INSTANCE)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ apiKey: 'replay-key', apiKeySubject: 'cursor-user:1' }))
  if (initial) writeFileSync(join(stateDir, 'cursor.json'), JSON.stringify(initial(home)))
  let stored: unknown = { [INSTANCE]: { driver: 'cursor', enabled: true, config: { displayName: 'Work' } } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [cursorDriver({ connect, cancelDeadlineMs: 200, ...extra })], instances, profileHome: home })
  const notices: Array<[string, string]> = []
  harness.setLiveHost({ notice: (threadId, text) => notices.push([threadId, text]) })
  harnesses.push(harness)
  const texts = new Map<string, string>()
  const spec = (threadId: string, binding: TurnSpec['binding'], options: { prompt?: string; history?: string; signal?: AbortSignal; mcp?: { url: string; token: string } } = {}): TurnSpec => ({
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
    sink: {
      text: (event: { phase: string; content: string }) => event.phase !== 'start' && texts.set(threadId, event.content),
      thinking: () => {},
      tool: () => {},
      progress: () => {},
      providerRef: () => {},
      steerAccepted: () => {},
      usage: () => {}
    } as unknown as TurnSpec['sink'],
    control: { drainSteer: () => undefined, heartbeat: () => {} } as unknown as TurnSpec['control'],
    host: { mcp: options.mcp ?? null, context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as TurnSpec['host']
  })
  const turn = async (threadId: string, options: Parameters<typeof spec>[2] = {}) => {
    const binding = await harness.bind(harness.resolveStored({ instanceId: INSTANCE, llmProvider: '', model: 'default' }, { purpose: 'turn' }), { mode: 'agent' })
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
        piLegacyDriver({
          client: () => ({ chat: async () => { throw new Error('unused') } }),
          credentials: () => ({ has: () => true, storedApiKey: (id: string) => (id === 'cursor' ? 'pi-cursor-key' : undefined), getConfiguredProviders: () => [], getConfiguredLlmProviders: () => [] })
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
