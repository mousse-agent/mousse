/**
 * SPEC §16.2 thread fork: forkable source statuses, receipt replay, the lazy `fork` transfer, and the
 * fork's first message resolving it — portable `full_summary` with the fork's own worktree seeded
 * from the source's checkpoint, and a native-capable adapter whose `forkSession` stub falls back.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PI_TEST_CAPABILITIES } from '../support/piStub'
import type { AdapterHost, ProviderAdapter, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import { CommandRejection } from '../../src/mms/run/db/RunStoreError'
import { ProfileDatabase } from '../../src/mms/run/db/ProfileDatabase'
import { RunEngine, type ForkPointSeed, type RunTerminalStatus } from '../../src/mms/run/RunEngine'
import { RunStore } from '../../src/mms/run/RunStore'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { acquireRepositoryLease } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { ChangeReceiptService } from '../../src/mms/actions/ChangeReceiptService'
import { ReceiptRefReleaseService } from '../../src/mms/actions/ReceiptRefReleaseService'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { UndoRetentionService } from '../../src/mms/actions/UndoRetentionService'
import { git, gitFoundationFixture } from '../fixtures/gitFoundation'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

/**
 * A pi-shaped adapter whose turns follow a script of modes: `reply` answers at once; `wait` runs
 * until stopped without committing anything.
 */
class StoppableAdapter implements ProviderAdapter {
  readonly driver = 'pi' as const
  readonly capabilities = PI_TEST_CAPABILITIES
  /** The prompt of each turn (a prompt runtime gets handed-over history there). */
  readonly turns: string[] = []
  waiting = false

  constructor(private readonly modes: Array<'reply' | 'wait'>) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, _host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input.prompt)
    sink.providerRef({ provider: input.llmProvider, model: input.model })
    const mode = this.modes.shift() ?? 'reply'
    if (mode !== 'reply') {
      this.waiting = true
      await new Promise<never>((_resolve, reject) =>
        input.signal.addEventListener('abort', () => reject(input.signal.reason as Error), { once: true }))
    }
    const text = `reply to ${input.prompt}`
    sink.text({ phase: 'complete', content: text, contentIndex: 0 })
    return {
      text, aborted: false, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextSignature: 'scripted', nativeMessages: [], providerRef: { provider: input.llmProvider, model: input.model }
    }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

/** How many `<handoff>` blocks a prompt carries. */
const headers = (prompt: string) => prompt.split('<handoff ').length - 1

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

  it('a fork keeps the source thread\'s permission mode, and a source without one stays on the profile default', async () => {
    const d = (daemon = phase6Daemon(plainHome(), [piAdapter(() => 'unused')]))
    const source = d.store.createThread('Source')
    const plain = d.store.createThread('Plain')
    await runIn(d, source.id, 'completed')
    await runIn(d, plain.id, 'completed')
    d.orch.setThreadPermissionMode(source.id, 'ask')
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'fork-mode' })
    expect(d.store.getThread(forked.threadId)?.permissionMode).toBe('ask')
    // A fork is the user's thread: it can be loosened again, which a subagent could not be.
    expect(d.orch.setThreadPermissionMode(forked.threadId, 'full').permissionMode).toBe('full')
    expect(d.store.getThread(source.id)?.permissionMode).toBe('ask')

    const unset = await d.engine.forkThread({ sourceThreadId: plain.id, clientRequestId: 'fork-plain' })
    expect(d.store.getThread(unset.threadId)?.permissionMode).toBeUndefined()
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
    // The fork keeps the source's selection, stored in the instance shape.
    expect(d.orch.getThreadModelOverride(forked.threadId)).toEqual({ ...PI, instanceId: 'pi:openai', name: 'GPT-Replay' })
  })

  it('resolves portably on the first message, from the accepted checkpoint even after its source receipt is released', async () => {
    foundation = gitFoundationFixture()
    const f = foundation
    const pi = piAdapter((input) => {
      if (input.cwd && input.prompt.startsWith('Write ')) writeFileSync(join(input.cwd, 'value.txt'), `${input.prompt.slice(6)}\n`)
      return `done: ${String(input.messages.at(-1)!.content)}`
    })
    const d = (daemon = phase6Daemon(f.home, [pi]))
    const project = d.projects.openProject(f.repo)
    const source = d.store.createThread('Source', project.id)
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send({ content: 'Write one', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'w-1' })
    await d.orch.send({ content: 'Write two', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'w-2' })
    const sourceWorktree = new ThreadWorkspaceManager(d.store.getThreadDir(source.id)).load()!.worktreePath
    expect(f.read(sourceWorktree)).toBe('two\n')

    const beforeFork = git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/')
    const checkpoint = d.engine.store.db.checkpoint.bind(d.engine.store.db)
    const fault = vi.spyOn(d.engine.store.db, 'checkpoint').mockImplementation((point) => {
      if (point === 'fork.beforeCommit') {
        expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/')).toContain('/fork-checkpoint')
        throw new Error('Fork transaction interrupted')
      }
      checkpoint(point)
    })
    try {
      await expect(d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 1, clientRequestId: 'fork-cancelled' })).rejects.toThrow('Fork transaction interrupted')
    } finally { fault.mockRestore() }
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/')).toBe(beforeFork)
    const checkoutLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
    const created = Promise.withResolvers<string>()
    const createThread = d.store.createThread.bind(d.store)
    const capture = vi.spyOn(d.store, 'createThread').mockImplementation((...args) => {
      const thread = createThread(...args)
      created.resolve(thread.id)
      return thread
    })
    const accepting = d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 1, clientRequestId: 'fork-at-1' })
    try {
      const id = await created.promise
      const earlySend = d.orch.send('Send before acceptance', false, { threadId: id, clientRequestId: 'too-early' }).catch((error: unknown) => error)
      expect(d.store.listAllThreads().some((thread) => thread.id === id)).toBe(false)
      expect(await earlySend).toMatchObject({ message: `Thread not found: ${id}` })
      expect(d.engine.listRuns(id)).toEqual([])
    } finally {
      checkoutLease.release()
      capture.mockRestore()
      // Wait for acceptance to finish even if an assertion failed.
      await accepting.catch(() => undefined)
    }
    const forked = await accepting
    const sourceDir = d.store.getThreadDir(source.id)
    const sourceAction = new ThreadActionService(sourceDir).list().find((action) => action.turnId === forked.sourceRunId)!
    const receipt = new ChangeReceiptService(sourceDir).list().find((candidate) => candidate.id === sourceAction.receiptId)!
    const pin = 'refs/mousse/threads/' + forked.threadId + '/fork-checkpoint'
    expect(git(f.repo, 'rev-parse', pin)).toBe(receipt.afterSha)
    let now = Date.now()
    const retention = new UndoRetentionService(sourceDir, () => now)
    await retention.configure(sourceWorktree, { windowMs: 1, migrationGraceMs: 1, maxForwardStepMs: 60_000 }, true)
    now += 10_000
    await retention.sweep(sourceWorktree)
    const released = await new ReceiptRefReleaseService(d.store.lifecycleStore, source.id, () => now).release(sourceWorktree)
    expect(released.releasedRefs).toEqual(expect.arrayContaining(receipt.retainedRefs))
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', receipt.retainedRefs[1]!)).toBe('')
    expect(git(f.repo, 'rev-parse', pin)).toBe(receipt.afterSha)
    const response = await d.orch.send({ content: 'What is in value.txt?', mode: 'agent' }, false, { threadId: forked.threadId, clientRequestId: 'fork-first' })
    expect(response.message).toBe('done: What is in value.txt?')

    const turn = pi.turns.at(-1)!
    expect(turn.threadId).toBe(forked.threadId)
    // A prompt runtime gets the source's history as a `<handoff>` block before the message.
    expect(headers(turn.prompt)).toBe(1)
    expect(turn.prompt).toContain('<handoff strategy="full_summary" covered="1"')
    expect(turn.prompt).toContain('[user] Write one')
    expect(turn.prompt).toContain('[assistant] done: Write one')
    expect(turn.prompt.endsWith('What is in value.txt?')).toBe(true)
    expect(JSON.stringify(turn)).not.toContain('Write two')

    const forkWorkspace = new ThreadWorkspaceManager(d.store.getThreadDir(forked.threadId)).load()!
    expect(forkWorkspace.worktreePath).not.toBe(sourceWorktree)
    expect(turn.cwd?.startsWith(forkWorkspace.worktreePath)).toBe(true)
    expect(readFileSync(join(forkWorkspace.worktreePath, 'value.txt'), 'utf8')).toBe('one\n')
    expect(f.read(sourceWorktree)).toBe('two\n')
    expect(git(f.repo, 'for-each-ref', '--format=%(refname)', pin)).toBe('')

    const transfer = d.engine.transfers.get(forked.transferId)!
    expect(transfer).toMatchObject({ status: 'consumed', payload: { forkStrategy: 'portable', strategy: 'full_summary', seed: { kind: 'checkpoint' } } })
    expect(d.engine.handoffs.listForThread(forked.threadId)).toMatchObject([{ strategy: 'full_summary', status: 'delivered', coveredFromOrdinal: 1, coveredToOrdinal: 1 }])
    expect(d.orch.getMessages(forked.threadId).find((message) => message.kind === 'context_handoff')?.contextHandoff).toMatchObject({ transfer: 'fork', strategy: 'full_summary' })
  }, 150_000)

  it('on restart discards an unaccepted fork and retires pins left by rollback or provisioning', async () => {
    foundation = gitFoundationFixture()
    const f = foundation
    const pi = piAdapter((input) => {
      writeFileSync(join(input.cwd!, 'value.txt'), 'selected checkpoint\n')
      return 'done'
    })
    let pin: string | undefined
    let lock: string | undefined
    const d = (daemon = phase6Daemon(f.home, [pi], { fault: (point) => {
      if (point !== 'fork.beforeCommit') return
      pin = git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/').split(/\r?\n/).find((ref) => ref.endsWith('/fork-checkpoint'))
      if (pin) {
        lock = join(f.repo, '.git', ...pin.split('/')) + '.lock'
        writeFileSync(lock, '')
      }
      throw new Error('Fork interrupted before acceptance')
    } }))
    const project = d.projects.openProject(f.repo)
    const source = d.store.createThread('Source', project.id)
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send({ content: 'Make a checkpoint', mode: 'agent' }, false, { threadId: source.id, clientRequestId: 'restart-source' })
    const request = { sourceThreadId: source.id, clientRequestId: 'restart-fork' }
    try {
      await expect(d.engine.forkThread(request)).rejects.toThrow('Fork interrupted before acceptance')
      expect(pin).toBeDefined()
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', pin!)).toBe(pin)
      const pendingId = pin!.split('/')[3]!
      const pending = d.store.lifecycleStore.require(pendingId)
      expect(d.store.getThread(pendingId)).toBeUndefined()
      expect(existsSync(pending.location)).toBe(true)
      expect(d.engine.store.getReceipt(request.clientRequestId)).toBeNull()

      // The lock forced rollback to leave the same durable pin and thread records a process exit leaves.
      unlinkSync(lock!)
      lock = undefined
      await d.crash()
      d.store.closeThreadStorage()
      const restarted = (daemon = phase6Daemon(f.home, [pi], { orchestratorBoot: true }))
      await restarted.orch.recoverForkCreations()
      expect(restarted.store.lifecycleStore.get(pendingId)).toBeUndefined()
      expect(existsSync(pending.location)).toBe(false)
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', pin!)).toBe('')

      const accepted = await restarted.engine.forkThread(request)
      expect(accepted.replayed).toBe(false)
      const acceptedPin = `refs/mousse/threads/${accepted.threadId}/fork-checkpoint`
      const acceptedSha = git(f.repo, 'rev-parse', acceptedPin)
      lock = join(f.repo, '.git', ...acceptedPin.split('/')) + '.lock'
      writeFileSync(lock, '')
      await restarted.orch.send('Use the checkpoint', false, { threadId: accepted.threadId, clientRequestId: 'restart-fork-first-send' })
      expect(restarted.engine.transfers.get(accepted.transferId)?.payload.seed).toMatchObject({ kind: 'checkpoint', sha: acceptedSha })
      expect(git(f.repo, 'rev-parse', acceptedPin)).toBe(acceptedSha)

      unlinkSync(lock)
      lock = undefined
      await restarted.crash()
      restarted.store.closeThreadStorage()
      const resumed = (daemon = phase6Daemon(f.home, [pi], { orchestratorBoot: true }))
      await resumed.orch.recoverForkCreations()
      const workspace = new ThreadWorkspaceManager(resumed.store.getThreadDir(accepted.threadId)).load()!
      expect(readFileSync(join(workspace.worktreePath, 'value.txt'), 'utf8')).toBe('selected checkpoint\n')
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', acceptedPin)).toBe('')
    } finally {
      if (lock) unlinkSync(lock)
    }
  }, 150_000)

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
    expect(pi.turns.at(-1)!.prompt).toContain('[user] Start')
  })

  it('shows the conversation it carries and where it starts before its first message, and the model gets that history once', async () => {
    const pi = piAdapter((input) => `reply to ${String(input.messages.at(-1)!.content)}`)
    const d = (daemon = phase6Daemon(plainHome(), [pi]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('One', false, { threadId: source.id, clientRequestId: 'c-1' })
    await d.orch.send('Two', false, { threadId: source.id, clientRequestId: 'c-2' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, atRunOrdinal: 1, clientRequestId: 'carry' })

    const before = d.orch.getMessages(forked.threadId)
    expect(before.map((message) => [message.role, message.kind ?? '', message.content])).toEqual([
      ['user', '', 'One'], ['assistant', '', 'reply to One'], ['assistant', 'context_handoff', 'Forked from Source']
    ])
    const sourceIds = new Set(d.orch.getMessages(source.id).map((message) => message.id))
    for (const copy of before.slice(0, 2)) {
      expect(copy.inherited?.threadId).toBe(source.id)
      expect(copy.turnId).toBeUndefined()
      expect(sourceIds.has(copy.id)).toBe(false)
    }
    expect(d.orch.getNativeContext(forked.threadId).messages).toEqual([])
    // The marker takes the time of the reply it follows, so that turn keeps the time it took.
    expect(before[2].timestamp).toBe(before[1].timestamp)

    await d.orch.send('Three', false, { threadId: forked.threadId, clientRequestId: 'c-3' })
    expect(headers(pi.turns.at(-1)!.prompt)).toBe(1)
    expect(pi.turns.at(-1)!.prompt).toContain('[user] One')
    expect(pi.turns.at(-1)!.prompt).not.toContain('Two')
    const after = d.orch.getMessages(forked.threadId)
    expect(after.map((message) => message.kind === 'context_handoff' ? 'marker' : message.content)).toEqual(['One', 'reply to One', 'marker', 'Three', 'reply to Three'])
    expect(after[2]).toMatchObject({ content: 'Forked from Source', contextHandoff: { transfer: 'fork', strategy: 'full_summary' } })
  })

  it('a native fork names the source thread in its marker, not the fork', async () => {
    const pi = piAdapter((input) => `reply to ${input.prompt}`, { fork: 'native' }, 'session-1')
    pi.forkSession = async (ref) => ({ ...ref, sessionId: 'forked-session' })
    const d = (daemon = phase6Daemon(plainHome(), [pi]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Start', false, { threadId: source.id, clientRequestId: 'nm-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'native-marker' })
    await d.orch.send('Continue in the fork', false, { threadId: forked.threadId, clientRequestId: 'nm-2' })
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({ status: 'consumed', payload: { forkStrategy: 'native' } })
    const markers = d.orch.getMessages(forked.threadId).filter((message) => message.kind === 'context_handoff')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ content: 'Forked from Source', contextHandoff: { transfer: 'fork', strategy: 'native_resume' } })
  })

  /** A fork whose first turn is stopped before it commits anything, then a second turn that completes. */
  const stoppedFirstTurn = async () => {
    const adapter = new StoppableAdapter(['reply', 'wait', 'reply'])
    const d = (daemon = phase6Daemon(plainHome(), [adapter]))
    const source = d.store.createThread('Source')
    d.orch.setThreadModelOverride(source.id, PI)
    await d.orch.send('Plan the parser', false, { threadId: source.id, clientRequestId: 'src-1' })
    const forked = await d.engine.forkThread({ sourceThreadId: source.id, clientRequestId: 'fork-wait' })
    const first = await d.orch.send('First in the fork', false, { threadId: forked.threadId, clientRequestId: 'fork-1', awaitMode: 'ack' })
    await waitFor(() => adapter.waiting, 'the first fork turn')
    await d.orch.abortRun(first.runId!, 'stop-fork-1', forked.threadId)
    const turnStart = () => d.engine.outbox.listForRun(first.runId!).find((effect) => effect.kind === 'turn.start')
    await waitFor(() => turnStart()?.status === 'succeeded', 'the stopped turn to settle')
    expect(d.engine.getRun(first.runId!)).toMatchObject({ status: 'interrupted', outcome: { interruptedBy: 'user' } })
    const transferAfterStop = d.engine.transfers.get(forked.transferId)!
    const second = await d.orch.send('Second in the fork', false, { threadId: forked.threadId, clientRequestId: 'fork-2' })
    return { d, adapter, forked, second, transferAfterStop }
  }

  it('a fork turn stopped before any commit leaves the transfer pending; the next turn injects it once', async () => {
    const { d, adapter, forked, second, transferAfterStop } = await stoppedFirstTurn()
    expect(transferAfterStop.status).toBe('pending')
    expect(headers(adapter.turns[1])).toBe(1)
    expect(headers(adapter.turns[2])).toBe(1)
    expect(d.engine.transfers.get(forked.transferId)).toMatchObject({ status: 'consumed', payload: { consumedBy: second.runId } })
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
