/**
 * A turn whose answer is complete shows as finished while its end-of-turn checkpoint still waits for the repository's
 * lease (another thread's checkpoint holds it), and the checkpoint it then records is this turn's alone. Runs a real
 * orchestrator, Run Engine and effect worker over a Git project, with a scripted provider that writes a file and is
 * held until the test has taken the repository's lease, as a slow checkpoint of another thread would hold it.
 *
 * The "turn finished" notices follow the thread's activity (`ThreadRuntimeManager`): a window notifies (system
 * notification, toast, sound) when a thread's activity leaves working for `completed`, the thread is marked Done
 * (unseen), and the lists of other computers and phones show it finished. Those are checked here while the checkpoint
 * still waits, with the same notice rule the windows apply (`registerGuiIpc`, `isThreadActivityActive`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { isThreadActivityActive, isTurnStoppable, turnPhaseActivity, type ThreadActivityState } from '../../src/shared/types'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { ThreadRuntimeManager } from '../../src/mms/runtime/ThreadRuntimeManager'
import { UnseenDoneStore } from '../../src/mms/runtime/UnseenDoneStore'
import { PtyManager } from '../../src/mms/terminals/PtyManager'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

/** A provider stand-in: each turn writes `<prompt>.txt` in its folder, then waits for the test's go before answering. */
class WritingAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  private gate: (() => void) | undefined
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly held: Set<string>) {}

  configured(): boolean {
    return true
  }

  answer(): void {
    this.gate?.()
    this.gate = undefined
  }

  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const name = input.prompt.match(/write (\w+)/)?.[1]
    if (name && input.cwd) writeFileSync(join(input.cwd, `${name}.txt`), `${name}\n`)
    if (name && this.held.has(name)) await new Promise<void>((resolve) => { this.gate = resolve })
    sink.text({ phase: 'complete', content: 'Done', contentIndex: 0 })
    host.context.nativeHistoryAfterTurn('Done')
    return { text: 'Done', modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

/** A Git project with one commit, in `home`. */
function gitProject(home: string): string {
  const projectDir = join(home, 'project')
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, 'README.md'), 'hello\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '-qm', 'init')
  return projectDir
}

/**
 * The daemon's thread activity, Done marks and what the windows would announce for `threadId`: a notice each time its
 * activity leaves working (as `registerGuiIpc` notifies), and whether the turn's reply had reached the windows by then.
 */
function watchNotices(d: Phase6Daemon, home: string, threadId: string) {
  const manager = new ThreadRuntimeManager()
  const unseen = new UnseenDoneStore(home)
  manager.attach({ threadStore: d.store, orchestrator: d.orch, ptyManager: new PtyManager(), questions: d.questions, unseenDone: unseen })
  const notices: Array<{ state: ThreadActivityState; replyShown: boolean }> = []
  let replyShown = false
  let previous: ThreadActivityState | undefined
  manager.on('activity', (event: { threadId: string; state: ThreadActivityState }) => {
    if (event.threadId !== threadId) return
    if (isThreadActivityActive(previous) && !isThreadActivityActive(event.state)) notices.push({ state: event.state, replyShown })
    previous = event.state
  })
  d.orch.on('thread-message', (event: { threadId?: string; message?: { role?: string; content?: string; streaming?: boolean } }) => {
    if (event.threadId === threadId && event.message?.role === 'assistant' && event.message.content === 'Done' && !event.message.streaming) replyShown = true
  })
  return { notices, done: () => unseen.has(threadId), activity: () => manager.getActivity(threadId) }
}

describe('a finished turn while its repository is busy', () => {
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

  it('shows the turn finished before its checkpoint gets the repository, and records only its own files', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-finish-busy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = gitProject(home)
    const adapter = new WritingAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, new Set(['first']))
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Busy repository', project.id)
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const running = () => d.orch.getOrCreateSession(thread.id).isTurnRunning()

    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider')
    // Another thread's checkpoint holds the repository from before this turn answers until after.
    held = await acquireRepositoryLease(resolveRepositoryIdentity(projectDir))
    adapter.answer()

    // The answer is complete: the turn shows finished, nothing offers to stop it, and the thread does not read as working.
    await waitFor(() => d.orch.getTurnState(thread.id).phase === 'completed', 'the finished turn to show as finished while its checkpoint waits')
    expect(isTurnStoppable(d.orch.getTurnState(thread.id))).toBe(false)
    expect(turnPhaseActivity(d.orch.getTurnState(thread.id).phase)).toBe('completed')
    // Its checkpoint has not been recorded: the run is still finalizing and holds the thread, so a message sent now
    // waits for it instead of starting a turn whose start snapshot would take this turn's files.
    expect(d.engine.getRun(first.runId!)?.status).toBe('finalizing')
    expect(running()).toBe(true)
    const second = await d.orch.send('write second', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    expect(second.queued).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(adapter.turns).toHaveLength(1)

    // The repository is free: the checkpoint is recorded, the run completes, and the queued message runs.
    held.release()
    held = undefined
    await waitFor(() => d.engine.getRun(first.runId!)?.status === 'completed', 'the first run to complete once its checkpoint is recorded', 20_000)
    await waitFor(() => adapter.turns.length === 2 && !running(), 'the queued message to run', 20_000)

    const actions = new ThreadActionService(d.store.getThreadDir(thread.id)).list()
    const files = (runId: string | undefined) => actions.find((action) => action.turnId === runId)?.changedPaths.map((change) => change.path)
    expect(files(first.runId)).toEqual(['first.txt'])
    const secondRun = d.engine.listRuns(thread.id).find((run) => run.runId !== first.runId && run.status === 'completed')
    expect(files(secondRun?.runId)).toEqual(['second.txt'])
  })

  it('announces the finished turn once, with its reply, before its checkpoint gets the repository', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-finish-busy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = gitProject(home)
    const adapter = new WritingAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, new Set(['first']))
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Busy repository', project.id)
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const watch = watchNotices(d, home, thread.id)

    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the turn to reach the provider')
    held = await acquireRepositoryLease(resolveRepositoryIdentity(projectDir))
    adapter.answer()

    // The checkpoint still waits for the repository, and the person is already told: one "finished" notice, the thread
    // marked Done, and the reply already in the windows when the notice comes.
    await waitFor(() => watch.notices.length > 0, 'the finished notice while the checkpoint waits')
    expect(d.engine.getRun(first.runId!)?.status).toBe('finalizing')
    expect(watch.notices).toEqual([{ state: 'completed', replyShown: true }])
    expect(watch.activity()).toBe('completed')
    expect(watch.done()).toBe(true)

    // The checkpoint ends: the run completes, and nothing announces the turn a second time.
    held.release()
    held = undefined
    await waitFor(() => d.engine.getRun(first.runId!)?.status === 'completed', 'the run to complete once its checkpoint is recorded', 20_000)
    await waitFor(() => !d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the turn to settle', 20_000)
    expect(watch.notices).toEqual([{ state: 'completed', replyShown: true }])
    expect(watch.done()).toBe(true)
  })

  it('says so in the thread when the checkpoint of an announced turn fails', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-finish-busy-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = gitProject(home)
    const adapter = new WritingAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, new Set(['first']))
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Busy repository', project.id)
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const watch = watchNotices(d, home, thread.id)
    // The checkpoint waits for the repository as a real one does, then fails.
    let repositoryFree!: () => void
    const free = new Promise<void>((resolve) => { repositoryFree = resolve })
    const checkpoint = vi.spyOn(ThreadActionService.prototype, 'checkpointExistingTurn').mockImplementationOnce(async () => {
      await free
      throw new Error('Unable to create index.lock: File exists')
    })

    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the turn to reach the provider')
    adapter.answer()
    await waitFor(() => watch.notices.length > 0, 'the finished notice while the checkpoint waits')
    expect(d.engine.getRun(first.runId!)?.status).toBe('finalizing')

    repositoryFree()
    await waitFor(() => d.engine.getRun(first.runId!)?.status === 'failed', 'the run to fail with its checkpoint', 20_000)
    checkpoint.mockRestore()
    const warning = d.orch.getOrCreateSession(thread.id).messages.find((message) => message.role === 'system' && message.content.includes('index.lock'))
    expect(warning?.content).toMatch(/checkpoint could not be recorded/)
    // The finished notice is not repeated for the failure.
    expect(watch.notices).toEqual([{ state: 'completed', replyShown: true }])
  })
})
