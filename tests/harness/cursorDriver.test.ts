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
import { cursorDriver } from '../../src/mms/harness/drivers/cursor'
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

function setup(connect: NonNullable<NonNullable<Parameters<typeof cursorDriver>[0]>['connect']>, initial?: (home: string) => unknown) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-cursor-driver-'))
  homes.push(home)
  const stateDir = instanceStateDir(home, INSTANCE)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ apiKey: 'replay-key', apiKeySubject: 'cursor-user:1' }))
  if (initial) writeFileSync(join(stateDir, 'cursor.json'), JSON.stringify(initial(home)))
  let stored: unknown = { [INSTANCE]: { driver: 'cursor', enabled: true, config: { displayName: 'Work' } } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (next) => { stored = next.instances } } })
  const harness = testHarness({ drivers: [cursorDriver({ connect, cancelDeadlineMs: 200 })], instances, profileHome: home })
  const notices: Array<[string, string]> = []
  harness.setLiveHost({ notice: (threadId, text) => notices.push([threadId, text]) })
  harnesses.push(harness)
  const texts = new Map<string, string>()
  const spec = (threadId: string, binding: TurnSpec['binding'], options: { prompt?: string; history?: string; signal?: AbortSignal } = {}): TurnSpec => ({
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
    host: { mcp: null, context: { nativeHistoryAfterTurn: (text: string) => text } } as unknown as TurnSpec['host']
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

  it('a stop that misses the deadline ends the host; the turn ends once, interrupted', async () => {
    const host = new FakeCursorHost({
      create: () => ({ agentId: 'agent-1' }),
      send: () => ({ runId: 'run-1' }),
      // Cursor never confirms the cancel.
      cancel: () => new Promise(() => {})
    })
    const { turn } = setup(host.connect)
    const handle = await turn('thread')
    await vi.waitFor(() => expect(host.calls('send')).toHaveLength(1))
    await vi.waitFor(() => expect(handle.providerRef()?.sessionId).toBe('agent-1'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const interrupted = handle.interrupt()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await interrupted).toBe('interrupted')
    } finally {
      vi.useRealTimers()
    }
    expect(await handle.result).toMatchObject({ aborted: true })
    expect(host.transports).toHaveLength(1)
  })
})
