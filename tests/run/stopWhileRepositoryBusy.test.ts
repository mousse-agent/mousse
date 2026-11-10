/**
 * A Stop ends a thread's turn even while another operation holds the thread's repository, and a thread whose start
 * waits on that repository can be stopped too. Runs a real orchestrator, Run Engine and effect worker over a Git
 * project, with a scripted provider whose "Sync" turns are held until a Stop interrupts them. The test holds the
 * repository's lease, as a long or stuck operation of another thread would.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { readDurableQueue } from '../../src/mms/queue/durableQueue'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

const SYNC = 'Sync the local repository with the remote'

/** A provider stand-in: a turn whose prompt asks to sync is held until a Stop interrupts it; others answer at once. */
class HeldAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  private readonly interrupts = new Set<() => void>()
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}

  configured(): boolean {
    return true
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const held = input.prompt.includes(SYNC)
    if (held) await new Promise<void>((resolve) => { this.interrupts.add(resolve) })
    const text = held ? '' : 'Done'
    if (!held) {
      sink.text({ phase: 'complete', content: text, contentIndex: 0 })
      host.context.nativeHistoryAfterTurn(text)
    }
    return { text, aborted: held, modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    const waiting = [...this.interrupts]
    this.interrupts.clear()
    for (const resolve of waiting) resolve()
    return waiting.length ? 'interrupted' : 'not_active'
  }
}

describe('Stop while the thread\'s repository is busy', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  let held: RepositoryLeaseHandle | undefined

  afterEach(async () => {
    held?.release()
    held = undefined
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-stop-busy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    writeFileSync(join(projectDir, 'README.md'), 'hello\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    const adapter = new HeldAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES)
    const d = phase6Daemon(home, [adapter])
    daemon = d
    ;(d.orch as unknown as { stoppedTurnCheckpointWaitMs: number }).stoppedTurnCheckpointWaitMs = 1_000
    const project = d.projects.openProject(projectDir)
    const thread = (name: string) => {
      const made = d.store.createThread(name, project.id)
      d.orch.setThreadModelOverride(made.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
      return made
    }
    const holdRepository = async () => { held = await acquireRepositoryLease(resolveRepositoryIdentity(projectDir)) }
    const freeRepository = () => { held?.release(); held = undefined }
    const running = (threadId: string) => d.orch.getOrCreateSession(threadId).isTurnRunning()
    const queue = (threadId: string) => readDurableQueue(d.store, threadId).filter((item) => item.state === 'pending')
    return { d, adapter, thread, holdRepository, freeRepository, running, queue }
  }

  it('ends a stopped turn whose checkpoint cannot get the repository, and the queued messages go as the next turns', async () => {
    const w = world()
    const thread = w.thread('Sync')
    await w.d.orch.send(SYNC, false, { threadId: thread.id, clientRequestId: 'go', awaitMode: 'ack' })
    await waitFor(() => w.adapter.turns.length === 1, 'the first turn to reach the provider')

    // Another operation holds the repository; messages sent meanwhile are queued behind the running turn.
    await w.holdRepository()
    const first = await w.d.orch.send('resume', false, { threadId: thread.id, clientRequestId: 'q1', awaitMode: 'ack' })
    const second = await w.d.orch.send('carry on', false, { threadId: thread.id, clientRequestId: 'q2', awaitMode: 'ack' })
    expect(first.queued && second.queued).toBe(true)

    await w.d.orch.stopThread(thread.id, 'user')
    await waitFor(() => w.d.orch.getOrCreateSession(thread.id).activeTurn?.abort.signal.aborted === true, 'the turn to be aborted')
    // The stopped turn is still ending (its checkpoint waits for the repository). Send now puts the message first
    // instead of failing with "No active turn to steer".
    expect(w.running(thread.id)).toBe(true)
    expect(w.d.orch.promoteQueueItem(thread.id, second.queueItem!.id)).toEqual({ ok: true })
    expect(w.queue(thread.id).map((item) => item.content)).toEqual(['carry on', 'resume'])

    // It ends after a bounded wait, with the repository still held: the message sent now is taken from the queue as
    // the next turn (which then waits for the repository itself, as any turn's start does).
    await waitFor(() => w.queue(thread.id).map((item) => item.content).join() === 'resume', 'the stopped turn to end while the repository is still held')
    expect(w.d.engine.listRuns(thread.id).some((run) => run.status === 'interrupted')).toBe(true)

    // Once the repository is free, the queued messages go, one turn each, the one sent now first.
    w.freeRepository()
    await waitFor(() => w.adapter.turns.length === 3, 'the queued messages to run', 20_000)
    expect(w.adapter.turns[1]!.prompt).toContain('carry on')
    expect(w.adapter.turns[2]!.prompt).toContain('resume')
    await waitFor(() => !w.running(thread.id) && w.queue(thread.id).length === 0, 'the queue to empty')
  })

  it('lets a Stop end a new thread whose start waits for the repository, and leaves the project free', async () => {
    const w = world()
    await w.holdRepository()
    const thread = w.thread('Blocked start')
    const sent = await w.d.orch.send(SYNC, false, { threadId: thread.id, clientRequestId: 'blocked', awaitMode: 'ack' })
    await waitFor(() => w.running(thread.id), 'the turn to be admitted')
    // Its start needs the repository: nothing reaches the provider while it is held.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(w.adapter.turns).toHaveLength(0)
    expect(w.running(thread.id)).toBe(true)

    await w.d.orch.stopThread(thread.id, 'user')
    await waitFor(() => !w.running(thread.id), 'the stopped start to end while the repository is still held')
    expect(w.adapter.turns).toHaveLength(0)
    expect(['cancelled', 'interrupted']).toContain(w.d.engine.listRuns(thread.id).find((run) => run.runId === sent.runId)?.status)

    // Nothing of the stopped start holds the project: another thread starts, and so does this one on its next message.
    w.freeRepository()
    const other = w.thread('Other')
    await w.d.orch.send('Hello', false, { threadId: other.id, clientRequestId: 'other', awaitMode: 'ack' })
    await waitFor(() => w.adapter.turns.some((turn) => turn.threadId === other.id), 'the other thread to start', 20_000)
    await w.d.orch.send('Try again', false, { threadId: thread.id, clientRequestId: 'again', awaitMode: 'ack' })
    await waitFor(() => w.adapter.turns.some((turn) => turn.threadId === thread.id), 'the stopped thread to start again', 20_000)
  })
})
