/**
 * SPEC §16.2 thread fork: forkable source statuses, receipt replay, the lazy `fork` transfer, and the
 * fork's first message resolving it — portable `full_summary` with the fork's own worktree seeded
 * from the source's checkpoint, and a native-capable adapter whose `forkSession` stub falls back.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '@earendil-works/pi-ai'
import { PI_LOOP_CAPABILITIES } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/run/adapters/ProviderAdapter'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine, type ForkPointSeed, type RunTerminalStatus } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { gitFoundationFixture } from '../fixtures/gitFoundation'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

/**
 * A pi-shaped adapter whose turns follow a script of modes: `reply` answers at once; `commit` hands
 * the transcript it was given back through `sink.nativeMessages` and then runs until stopped;
 * `wait` runs until stopped without committing anything.
 */
class StoppableAdapter implements ProviderAdapter {
  readonly id = 'pi'
  readonly capabilities = PI_LOOP_CAPABILITIES
  readonly turns: Array<Array<{ role: string; content: unknown }>> = []
  waiting = false

  constructor(private readonly modes: Array<'reply' | 'commit' | 'wait'>) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input.messages.map((message) => ({ role: message.role, content: message.content })))
    sink.providerRef({ provider: input.llmProvider, model: input.model })
    const mode = this.modes.shift() ?? 'reply'
    if (mode !== 'reply') {
      if (mode === 'commit') sink.nativeMessages([...input.messages])
      this.waiting = true
      await new Promise<never>((_resolve, reject) =>
        input.signal.addEventListener('abort', () => reject(input.signal.reason as Error), { once: true }))
    }
    const text = `reply to ${input.prompt}`
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    const reply = {
      role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: input.llmProvider,
      model: input.model, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    } as Message
    return {
      text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted', nativeMessages: [...input.messages, reply], providerRef: { provider: input.llmProvider, model: input.model }
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

const HEADER = '[Context handoff:'
const headers = (messages: Array<{ content: unknown }>) =>
  messages.filter((message) => JSON.stringify(message.content).includes(HEADER)).length

describe('thread fork (SPEC §16.2)', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  let foundation: ReturnType<typeof gitFoundationFixture> | undefined

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    foundation?.dispose()
    foundation = undefined
    if (home) {
      if (previousHome === undefined) delete process.env.MOUSSE_HOME
      else process.env.MOUSSE_HOME = previousHome
      rmSync(home, { recursive: true, force: true })
    }
    home = undefined
  })

  const plainHome = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-fork-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    return home
  }

  /** A run on `threadId` left in `status` without a provider turn. */
  const runIn = async (d: Phase6Daemon, threadId: string, status: RunTerminalStatus | 'running') => {
    const sent = await d.engine.dispatch({ kind: 'send', threadId, clientRequestId: `seed:${Math.random()}`, source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    d.engine.markStarting(sent.runId)
    d.engine.markRunning(sent.runId)
    return status === 'running' ? d.engine.getRun(sent.runId)! : d.engine.markTerminal(sent.runId, status)
  }

  const reason = (error: unknown) => (error instanceof CommandRejection ? error.reason : error)

  it('forks after completed, failed, interrupted or cancelled runs, never running or uncertain, and replays by clientRequestId', async () => {
    const d = (daemon = phase6Daemon(plainHome(), [piAdapter(() => 'unused')]))
    const source = d.store.createThread('Source')
    for (const status of ['completed', 'failed', 'interrupted', 'cancelled', 'uncertain'] as const) await runIn(d, source.id, status)
    await runIn(d, source.id, 'running')

    for (const ordinal of [1, 2, 3, 4]) {
      const forked = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: ordinal, clientRequestId: `fork-${ordinal}` })
      expect(d.engine.delegations.getLineage(forked.threadId)).toMatchObject({ parentThreadId: source.id, relationship: 'fork', parentRunId: forked.sourceRunId })
    }
    expect(reason(await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 5, clientRequestId: 'fork-5' }).catch((e) => e))).toBe('run_not_forkable')
    expect(reason(await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 6, clientRequestId: 'fork-6' }).catch((e) => e))).toBe('run_not_forkable')
    expect(reason(await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 9, clientRequestId: 'fork-9' }).catch((e) => e))).toBe('run_not_found')

    // latest_stable skips the running and uncertain runs.
    const latest = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 'latest_stable', title: 'Try B', clientRequestId: 'fork-latest' })
    expect(d.engine.getRun(latest.sourceRunId)!.ordinal).toBe(4)
    expect(d.store.getThread(latest.threadId)?.name).toBe('Try B')
    const again = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 'latest_stable', title: 'Try B', clientRequestId: 'fork-latest' })
    expect(again).toEqual({ ...latest, replayed: true })

    const empty = d.store.createThread('Empty')
    expect(reason(await d.engine.forkThread({ sourceThreadId: empty.id, clientRequestId: 'fork-empty' }).catch((e) => e))).toBe('no_forkable_run')
  })

  it('is lazy: the fork transfer waits pending and nothing reaches a provider', async () => {
    const pi = piAdapter((input) => `reply to ${input.prompt}`)
    const d = (daemon = phase6Daemon(plainHome(), [pi]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Plan the feature', false, { threadId: source.id, clientRequestId: 's-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'lazy' })
    expect(pi.turns).toHaveLength(1)
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({
      type: 'fork', status: 'pending', sourceThreadId: source.id, targetThreadId: forked.threadId, sourceRunOrdinal: 1, payload: { sourceRunOrdinal: 1 }
    })
    expect(d.engine.listRuns(forked.threadId)).toEqual([])
    expect(d.orch.getThreadModelOverride(forked.threadId)).toEqual(PI)
  })

  it('resolves portably on the first message, in the fork\'s own worktree seeded from the source checkpoint', async () => {
    foundation = gitFoundationFixture()
    const f = foundation
    const pi = piAdapter((input) => {
      if (input.cwd && input.prompt.startsWith('Write ')) writeFileSync(join(input.cwd, 'value.txt'), `${input.prompt.slice(6)}\n`)
      return `done: ${input.prompt}`
    })
    const d = (daemon = phase6Daemon(f.home, [pi]))
    const project = d.projects.openProject(f.repo)
    const source = d.store.createThread('Source', project.id)
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send({ content: 'Write one', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'w-1' })
    await d.orch.send({ content: 'Write two', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'w-2' })
    const sourceWorktree = new ThreadWorkspaceManager(d.store.getThreadDir(source.id)).load()!.worktreePath
    expect(f.read(sourceWorktree)).toBe('two\n')

    const forked = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 1, clientRequestId: 'fork-at-1' })
    const response = await d.orch.send({ content: 'What is in value.txt?', mode: 'agent' }, false, { threadId: forked.threadId, clientRequestId: 'fork-first' })
    expect(response.message).toBe('done: What is in value.txt?')

    const turn = pi.turns.at(-1)!
    expect(turn.threadId).toBe(forked.threadId)
    expect(turn.messages).toHaveLength(3)
    expect(String(turn.messages[0].content)).toContain('[Context handoff: strategy=full_summary, covered=1.]')
    expect(String(turn.messages[0].content)).toContain('Write one')
    expect(turn.messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'done: Write one' }] })
    expect(turn.messages[2]).toMatchObject({ role: 'user', content: 'What is in value.txt?' })
    expect(JSON.stringify(turn.messages)).not.toContain('Write two')

    const forkWorkspace = new ThreadWorkspaceManager(d.store.getThreadDir(forked.threadId)).load()!
    expect(forkWorkspace.worktreePath).not.toBe(sourceWorktree)
    expect(turn.cwd?.startsWith(forkWorkspace.worktreePath)).toBe(true)
    expect(readFileSync(join(forkWorkspace.worktreePath, 'value.txt'), 'utf8')).toBe('one\n')
    expect(f.read(sourceWorktree)).toBe('two\n')

    const transfer = d.engine.transfers.get(forked.transferId)!
    expect(transfer).toMatchObject({ status: 'consumed', payload: { forkStrategy: 'portable', strategy: 'full_summary', seed: { kind: 'checkpoint' } } })
    expect(d.engine.handoffs.listForThread(forked.threadId)).toMatchObject([{ strategy: 'full_summary', status: 'delivered', coveredFromOrdinal: 1, coveredToOrdinal: 1 }])
    // The seeded context stays in the fork's own transcript for its next turns.
    expect(d.orch.getNativeContext(forked.threadId).messages).toHaveLength(4)
    expect(d.orch.getMessages(forked.threadId).find((message) => message.kind === 'context_handoff')?.contextHandoff).toMatchObject({ transfer: 'fork', strategy: 'full_summary' })
  }, 60_000)

  it('a native-fork-capable adapter whose forkSession returns null falls back to the portable handoff', async () => {
    const pi = piAdapter((input) => `reply to ${input.prompt}`, { fork: 'native' }, 'session-1')
    const d = (daemon = phase6Daemon(plainHome(), [pi]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Start', false, { threadId: source.id, clientRequestId: 'n-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'native-fork' })
    await d.orch.send('Continue in the fork', false, { threadId: forked.threadId, clientRequestId: 'n-2' })
    expect(pi.forkCalls).toEqual([{ ref: { provider: 'openai', model: 'gpt-replay', sessionId: 'session-1' }, atTurnOrdinal: 1 }])
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({ status: 'consumed', payload: { forkStrategy: 'portable', strategy: 'full_summary' } })
    expect(String(pi.turns.at(-1)!.messages[0].content)).toContain('Start')
  })

  /** A fork whose first turn is stopped after `mode`, then a second turn that completes. */
  const stoppedFirstTurn = async (mode: 'commit' | 'wait') => {
    const adapter = new StoppableAdapter(['reply', mode, 'reply'])
    const d = (daemon = phase6Daemon(plainHome(), [adapter]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Plan the parser', false, { threadId: source.id, clientRequestId: 'src-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: `fork-${mode}` })
    const first = await d.orch.send('First in the fork', false, { threadId: forked.threadId, clientRequestId: 'fork-1', awaitMode: 'ack' })
    await waitFor(() => adapter.waiting, 'the first fork turn')
    await d.orch.abortRun(first.runId!, 'stop-fork-1', forked.threadId)
    const turnStart = () => d.engine.outbox.listForRun(first.runId!).find((effect) => effect.kind === 'turn.start')
    await waitFor(() => turnStart()?.status === 'succeeded', 'the stopped turn to settle')
    expect(d.engine.getRun(first.runId!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'user' } })
    const transferAfterStop = d.engine.transfers.get(forked.transferId)!
    const second = await d.orch.send('Second in the fork', false, { threadId: forked.threadId, clientRequestId: 'fork-2' })
    return { d, adapter, forked, first, second, transferAfterStop }
  }

  it('a fork turn stopped after its first commit consumes the transfer; the next turn does not inject it again', async () => {
    const { d, adapter, forked, first, transferAfterStop } = await stoppedFirstTurn('commit')
    expect(transferAfterStop).toMatchObject({ status: 'consumed', payload: { consumedBy: first.runId, strategy: 'full_summary' } })
    expect(headers(adapter.turns[1])).toBe(1)
    // The second turn sees the history once: from the transcript, not injected again.
    expect(headers(adapter.turns[2])).toBe(1)
    expect(headers(d.orch.getNativeContext(forked.threadId).messages)).toBe(1)
  })

  it('a fork turn stopped before any commit leaves the transfer pending; the next turn injects it once', async () => {
    const { d, adapter, forked, second, transferAfterStop } = await stoppedFirstTurn('wait')
    expect(transferAfterStop.status).toBe('pending')
    expect(headers(adapter.turns[2])).toBe(1)
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({ status: 'consumed', payload: { consumedBy: second.runId } })
    expect(headers(d.orch.getNativeContext(forked.threadId).messages)).toBe(1)
  })

  it('a pending transfer whose marked history is already in the transcript is consumed, not injected again', async () => {
    const adapter = new StoppableAdapter(['reply', 'commit', 'reply'])
    const d = (daemon = phase6Daemon(plainHome(), [adapter]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Plan the parser', false, { threadId: source.id, clientRequestId: 'src-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'fork-lost' })
    // The consume write is lost: the transfer stays pending although the history was committed.
    const setStatus = d.engine.transfers.setStatus.bind(d.engine.transfers)
    let dropped = false
    d.engine.transfers.setStatus = (input) => {
      if (!dropped && input.to === 'consumed') {
        dropped = true
        throw new Error('lost write')
      }
      return setStatus(input)
    }
    const first = await d.orch.send('First in the fork', false, { threadId: forked.threadId, clientRequestId: 'fork-1', awaitMode: 'ack' })
    await waitFor(() => adapter.waiting, 'the first fork turn')
    await d.orch.abortRun(first.runId!, 'stop-fork-1', forked.threadId)
    await waitFor(() => d.engine.outbox.listForRun(first.runId!).find((effect) => effect.kind === 'turn.start')?.status === 'succeeded', 'the stopped turn')
    expect(dropped).toBe(true)
    expect(d.engine.transfers.get(forked.transferId)!.status).toBe('pending')

    const second = await d.orch.send('Second in the fork', false, { threadId: forked.threadId, clientRequestId: 'fork-2' })
    expect(headers(adapter.turns[2])).toBe(1)
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({ status: 'consumed', payload: { consumedBy: first.runId, repairedBy: second.runId } })
  })
})

describe('fork point seeding (M5)', () => {
  let profileHome: string | undefined
  afterEach(() => {
    if (profileHome) rmSync(profileHome, { recursive: true, force: true })
    profileHome = undefined
  })

  const engineWith = (seed: ForkPointSeed) => {
    profileHome = mkdtempSync(join(tmpdir(), 'mousse-fork-seed-'))
    const engine = new RunEngine({ store: new RunStore(new ProfileDatabase({ profileHome })) })
    let forks = 0
    const created: string[] = []
    engine.setDelegationHost({
      createThread: () => {
        forks += 1
        created.push(`fork-${forks}`)
        return { threadId: `fork-${forks}` }
      },
      deleteThread: () => undefined,
      buildChildTurnPayload: () => null,
      forkPointSeed: () => seed
    })
    return { engine, created }
  }

  const completedRun = async (engine: RunEngine) => {
    const sent = await engine.dispatch({ kind: 'send', threadId: 'source', clientRequestId: 'source-1', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    engine.markStarting(sent.runId)
    engine.markRunning(sent.runId)
    engine.markTerminal(sent.runId, 'completed')
  }

  it('refuses fork_point_unavailable without a checkpoint; seedFrom current_head forks and records it', async () => {
    const { engine, created } = engineWith('missing')
    await completedRun(engine)
    const refused = await engine.forkThread({ sourceThreadId: 'source', clientRequestId: 'fork-a' }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CommandRejection)
    expect((refused as CommandRejection).reason).toBe('fork_point_unavailable')
    expect(created).toEqual([])
    const forked = await engine.forkThread({ sourceThreadId: 'source', clientRequestId: 'fork-b', seedFrom: 'current_head' })
    expect(engine.transfers.get(forked.transferId)!.payload).toMatchObject({ seedFrom: 'current_head' })
    engine.store.db.close()
  })

  it('records the checkpoint (or no code at all) as the seed when the fork point has one', async () => {
    const { engine } = engineWith('checkpoint')
    await completedRun(engine)
    const forked = await engine.forkThread({ sourceThreadId: 'source', clientRequestId: 'fork-c' })
    expect(engine.transfers.get(forked.transferId)!.payload).toMatchObject({ seedFrom: 'checkpoint' })
    engine.store.db.close()
  })
})
