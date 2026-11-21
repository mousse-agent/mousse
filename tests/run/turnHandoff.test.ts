/**
 * A turn its previous turn's settle starts (a message queued behind it, or the wake for notices that came in while it
 * ran) starts from that turn's end snapshot: it runs no Git to check and snapshot the worktree again
 * (`OrchestratorService.recordTurnHandoff` / `settleTurnHandoff` / `takeTurnHandoff`). Runs a real orchestrator, Run
 * Engine and effect worker over a Git project, with a scripted provider; Git is counted from each turn's start line
 * (`[turn-boundary]`).
 *
 * Any other turn in the thread's own worktree starts from the last state Mousse recorded there without reading it
 * either (`OrchestratorService.ownWorktreeStart`): an edit made there between turns is the next turn's. A thread in the
 * project folder reads its folder first, so an edit the person made there is an action of its own.
 *
 * Cases: a queued message; a wake for a notice that arrived during the turn (the fixture runs no reconciler, so only
 * the settle's own wake starts it); a wake the reconciler made and deferred before the settle; an Undo pressed between
 * the turn and its wake; a Stop of the idle thread; a message sent or queued once the thread is idle, after the person
 * edited a file, in its worktree and in the project folder (where Undo of the agent gives the person's save back); each
 * check the hand-off must pass before use; the placements that never hand off.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { UndoService } from '../../src/mms/actions/UndoService'
import { EffectWorker, type EffectExecutor } from '../../src/mms/run/EffectWorker'
import { Reconciler } from '../../src/mms/run/Reconciler'
import type { EffectRecord } from '../../src/mms/run/types'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'
import { pressed } from '../support/userRequest'

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 })

/** Each turn writes `<name>.txt` for a prompt "write <name>"; `first` waits for the test's go. */
class WritingAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  private gate: (() => void) | undefined
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}
  configured(): boolean { return true }
  answer(): void { this.gate?.(); this.gate = undefined }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const name = input.prompt.match(/write (\w+)/)?.[1]
    if (name && input.cwd) writeFileSync(join(input.cwd, `${name}.txt`), `${name}\n`)
    const overwritten = input.prompt.match(/overwrite (\S+)/)?.[1]
    if (overwritten && input.cwd) writeFileSync(join(input.cwd, overwritten), 'written by the agent\n')
    if (name === 'first') await new Promise<void>((resolve) => { this.gate = resolve })
    sink.text({ phase: 'complete', content: 'Done', contentIndex: 0 })
    host.context.nativeHistoryAfterTurn('Done')
    return { text: 'Done', modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> { return 'not_active' }
}

function gitProject(home: string): string {
  const projectDir = join(home, 'project')
  mkdirSync(projectDir)
  writeFileSync(join(projectDir, 'README.md'), 'hello\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test'); git('config', 'core.autocrlf', 'false')
  git('add', '.'); git('commit', '-qm', 'init')
  return projectDir
}

interface StartLine { runId: string; edge: string; git: number; phases: Record<string, unknown> }

/** Where the thread works: its own worktree (the default), its project's folder, a project without Git, a folder it shares, the project's own checkout. */
type Placement = 'worktree' | 'project-folder' | 'no-git' | 'shared' | 'primary'

describe('a turn its previous turn\'s settle starts', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  let gatedWorker: EffectWorker | undefined

  afterEach(async () => {
    await gatedWorker?.stop().catch(() => undefined)
    gatedWorker = undefined
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    home = undefined
  })

  /** A daemon over a Git project, its turns' start lines, and the thread's records. `holdWakes`: a wake turn waits for `releaseWakes`. */
  async function setup(holdWakes = false, placement: Placement = 'worktree') {
    home = mkdtempSync(join(tmpdir(), 'mousse-handoff-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = placement === 'no-git' ? join(home, 'project') : gitProject(home)
    if (placement === 'no-git') mkdirSync(projectDir)
    const starts: StartLine[] = []
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const text = String(args[0])
      if (text.startsWith('[turn-boundary] ')) {
        const line = JSON.parse(text.slice('[turn-boundary] '.length)) as StartLine
        if (line.edge === 'start') starts.push(line)
      }
    })
    const adapter = new WritingAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES)
    const d = phase6Daemon(home, [adapter])
    daemon = d
    let releaseWakes = (): void => undefined
    if (holdWakes) {
      // The same executors, except that a wake turn waits for the test: an Undo can come between the turn and its wake.
      await d.worker.stop()
      const held = new Promise<void>((resolve) => { releaseWakes = resolve })
      const executors = d.orch.effectExecutors()
      const start = executors['turn.start']!
      const gated: EffectExecutor = async (effect, ctx) => {
        if ((effect.payload as { kind?: string } | null)?.kind === 'wake') await held
        return start(effect, ctx)
      }
      gatedWorker = new EffectWorker({ outbox: d.engine.outbox, executors: { ...executors, 'turn.start': gated }, owner: d.engine.leaseOwner })
      gatedWorker.start()
      d.orch.attachEffectWorker(gatedWorker)
    }
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Hand-off', project.id, undefined, placement === 'project-folder' ? { worktreeEnabled: false } : {})
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    if (placement === 'shared') d.orch.getOrCreateSession(thread.id).sharedWorkspace = { path: projectDir, parentThreadId: 'parent', access: 'write' }
    if (placement === 'primary') d.orch.getOrCreateSession(thread.id).primaryCheckout = { path: projectDir }
    const threadDir = d.store.getThreadDir(thread.id)
    const actionOf = (runId: string | undefined) => new ThreadActionService(threadDir).list().find((action) => action.turnId === runId)
    const idle = () => !d.orch.getOrCreateSession(thread.id).isTurnRunning() && !d.orch.getOrCreateSession(thread.id).turnAdmitted
    /** The thread's hand-off as the orchestrator holds it now. */
    const handoff = () => (d.orch as any).turnHandoffs.get(thread.id) as Record<string, any> | undefined
    return { d, adapter, thread, threadDir, starts, actionOf, idle, handoff, releaseWakes: () => releaseWakes() }
  }

  it('a message queued behind the turn starts from its end, with no Git, and its diff holds only its own work', async () => {
    const { d, adapter, thread, threadDir, starts, actionOf, idle } = await setup()
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    const second = await d.orch.send('write second', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    expect(second.queued).toBe(true)
    adapter.answer()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the queued message to run and settle', 300_000)
    const secondRunId = d.engine.listRuns(thread.id).find((run) => run.runId !== first.runId)!.runId
    expect(starts.find((line) => line.runId === secondRunId)?.git).toBe(0)
    expect(starts.find((line) => line.runId === secondRunId)?.phases.handoff).toBeDefined()
    const firstAction = actionOf(first.runId)!, secondAction = actionOf(secondRunId)!
    expect(secondAction.startSha).toBe(firstAction.endSha)
    expect(secondAction.changedPaths.map((change) => change.path)).toEqual(['second.txt'])
    // Nothing was recorded between them as made outside Mousse.
    const ids = new ThreadActionService(threadDir).list().map((action) => action.id)
    expect(ids.indexOf(secondAction.id) - ids.indexOf(firstAction.id)).toBe(1)
  })

  it('a notice that came in during the turn wakes the thread at its settle, and the wake starts from its end', async () => {
    const { d, adapter, thread, starts, actionOf, idle } = await setup()
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    d.engine.inbox.append({ inboxId: `inbox:notice:${thread.id}:1:0`, threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'write woken' } })
    adapter.answer()
    // No reconciler runs here: only the settle's own wake starts this turn.
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the wake to run and settle', 300_000)
    const wake = d.engine.listRuns(thread.id).find((run) => run.runId !== first.runId)!
    expect(wake.source).toBe('wake')
    expect(starts.find((line) => line.runId === wake.runId)?.git).toBe(0)
    expect(actionOf(wake.runId)!.startSha).toBe(actionOf(first.runId)!.endSha)
    expect(actionOf(wake.runId)!.changedPaths.map((change) => change.path)).toEqual(['woken.txt'])
  })

  it('an Undo pressed between the turn and its wake: the wake starts from the undone files, with no snapshot', async () => {
    const { d, adapter, thread, threadDir, starts, actionOf, idle, releaseWakes } = await setup(true)
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    d.engine.inbox.append({ inboxId: `inbox:notice:${thread.id}:1:0`, threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'write woken' } })
    adapter.answer()
    await waitFor(() => idle() && d.engine.listRuns(thread.id).some((run) => run.source === 'wake'), 'the turn to settle with its wake waiting', 300_000)
    const worktree = new ThreadWorkspaceManager(threadDir).load()!.worktreePath
    await pressed('Undo', () => new UndoService(threadDir).undoLatest('main', worktree))
    expect(existsSync(join(worktree, 'first.txt'))).toBe(false)
    releaseWakes()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the wake to run and settle', 300_000)
    const wake = d.engine.listRuns(thread.id).find((run) => run.source === 'wake')!
    const started = starts.find((line) => line.runId === wake.runId)!
    // The Undo ended the hand-off; the wake starts from what the Undo recorded, without reading the worktree.
    expect(started.phases.handoff).toBeUndefined()
    expect(started.phases.ownWorktree).toBeDefined()
    expect(started.phases.snapshotIndex).toBeUndefined()
    const woke = actionOf(wake.runId)!
    expect(woke.startSha).not.toBe(actionOf(first.runId)!.endSha)
    // It starts from the undone files: the undone file is not its to take back, and it changed only its own.
    expect(woke.changedPaths.map((change) => change.path)).toEqual(['woken.txt'])
  })

  it('a message sent once the thread is idle starts from the last end in its own worktree: an edit made there since is the turn\'s', async () => {
    const { d, adapter, thread, threadDir, starts, actionOf, idle } = await setup()
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    adapter.answer()
    await waitFor(() => idle() && d.engine.getRun(first.runId!)?.status === 'completed', 'the first turn to settle', 300_000)
    const worktree = new ThreadWorkspaceManager(threadDir).load()!.worktreePath
    writeFileSync(join(worktree, 'README.md'), 'edited by the person\n')
    const later = await d.orch.send('write later', false, { threadId: thread.id, clientRequestId: 'later', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the later turn to run and settle', 300_000)
    const started = starts.find((line) => line.runId === later.runId)!
    expect(started.phases.ownWorktree).toBeDefined()
    expect(started.phases.snapshotIndex).toBeUndefined()
    const actions = new ThreadActionService(threadDir).list()
    const own = actionOf(later.runId)!
    // No record of its own for the person's edit: the turn starts where the last one ended and covers it.
    expect(actions.some((action) => action.actor?.kind === 'user')).toBe(false)
    expect(own.startSha).toBe(actionOf(first.runId)!.endSha)
    expect(own.changedPaths.map((change) => change.path).sort()).toEqual(['README.md', 'later.txt'])
  })

  it('in the project folder, a file the person saved between turns comes back when the agent\'s overwrite of it is undone', async () => {
    const { d, adapter, thread, threadDir, starts, actionOf, idle } = await setup(false, 'project-folder')
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    adapter.answer()
    await waitFor(() => idle() && d.engine.getRun(first.runId!)?.status === 'completed', 'the first turn to settle', 300_000)
    const folder = new ThreadWorkspaceManager(threadDir).load()!.worktreePath
    // The person saves a file in an editor; the next turn's agent writes over it.
    writeFileSync(join(folder, 'README.md'), 'saved in the editor\n')
    const later = await d.orch.send('overwrite README.md', false, { threadId: thread.id, clientRequestId: 'later', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the later turn to run and settle', 300_000)
    expect(starts.find((line) => line.runId === later.runId)!.phases.ownWorktree).toBeUndefined()
    const actions = new ThreadActionService(threadDir).list()
    const own = actionOf(later.runId)!
    const outside = actions[actions.findIndex((action) => action.id === own.id) - 1]!
    expect(outside.actor).toEqual({ kind: 'user' })
    expect(outside.changedPaths.map((change) => change.path)).toEqual(['README.md'])
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('written by the agent\n')
    await pressed('Undo', () => new UndoService(threadDir).undoLatest('main', folder))
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('saved in the editor\n')
  })

  it('a wake the reconciler made and deferred between the run\'s end and its settle is brought forward and starts from its end', async () => {
    const { d, adapter, thread, starts, actionOf, idle } = await setup()
    const reconciler = new Reconciler({ store: d.engine.store, outbox: d.engine.outbox, tools: d.engine.tools, capabilitiesFor: (id) => d.orch.capabilitiesForThread(id) })
    // Once the run has ended its record but the turn has not settled, a reconciler pass wakes the thread for a notice,
    // and that wake is left as the worker's `thread_busy` defer leaves it, due in ten minutes: only the settle brings it
    // forward.
    let deferredWake: EffectRecord | undefined
    const record = (d.orch as any).recordTurnHandoff.bind(d.orch)
    ;(d.orch as any).recordTurnHandoff = (...args: unknown[]) => {
      record(...args)
      if (deferredWake) return
      d.engine.inbox.append({ inboxId: `inbox:notice:${thread.id}:1:0`, threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'write woken' } })
      reconciler.runOnce()
      const now = new Date(d.engine.store.db.clock()).toISOString()
      deferredWake = d.engine.outbox.listForThread(thread.id, { status: 'pending' }).find((effect) => (effect.payload as { kind?: string } | null)?.kind === 'wake')!
      ;(d.engine.outbox as any).write(deferredWake, { availableAt: new Date(Date.parse(now) + 600_000).toISOString(), lastError: 'thread_busy', updatedAt: now })
    }
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    adapter.answer()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the deferred wake to run and settle', 240_000)
    const wakes = d.engine.listRuns(thread.id).filter((run) => run.source === 'wake')
    expect(deferredWake).toBeDefined()
    expect(wakes.map((run) => run.runId)).toEqual([deferredWake!.runId])
    expect(starts.find((line) => line.runId === wakes[0].runId)?.git).toBe(0)
    expect(actionOf(wakes[0].runId)!.startSha).toBe(actionOf(first.runId)!.endSha)
  })

  it('a Stop of the idle thread ends the hand-off its wake was armed with: the wake checks the worktree again', async () => {
    const { d, adapter, thread, starts, idle, handoff, releaseWakes } = await setup(true)
    await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    d.engine.inbox.append({ inboxId: `inbox:notice:${thread.id}:1:0`, threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'write woken' } })
    adapter.answer()
    await waitFor(() => idle() && Boolean(handoff()?.armed), 'the turn to settle with its wake waiting', 300_000)
    d.orch.abortActiveTurn(thread.id)
    releaseWakes()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the wake to run and settle', 300_000)
    const wake = d.engine.listRuns(thread.id).find((run) => run.source === 'wake')!
    expect(starts.find((line) => line.runId === wake.runId)!.phases.handoff).toBeUndefined()
  })

  it('a turn whose settle starts nothing leaves no hand-off: a message queued later, after an edit, starts from its end and covers the edit', async () => {
    const { d, adapter, thread, threadDir, starts, idle, handoff } = await setup()
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    adapter.answer()
    await waitFor(() => idle() && d.engine.getRun(first.runId!)?.status === 'completed', 'the first turn to settle', 300_000)
    expect(handoff()).toBeUndefined()
    const worktree = new ThreadWorkspaceManager(threadDir).load()!.worktreePath
    writeFileSync(join(worktree, 'README.md'), 'edited by the person\n')
    d.orch.enqueueAndDrain(thread.id, { content: 'write later', mode: 'agent' }, 'test')
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the queued turn to run and settle', 300_000)
    expect(starts.find((line) => line.runId !== first.runId)!.phases.handoff).toBeUndefined()
    const actions = new ThreadActionService(threadDir).list()
    expect(actions.some((action) => action.actor?.kind === 'user')).toBe(false)
    expect(actions.at(-1)!.changedPaths.map((change) => change.path).sort()).toEqual(['README.md', 'later.txt'])
  })

  it('a hand-off is used only while each thing it was recorded against is unchanged', async () => {
    const { d, adapter, thread, threadDir, idle, handoff, releaseWakes } = await setup(true)
    await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    d.engine.inbox.append({ inboxId: `inbox:notice:${thread.id}:1:0`, threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'write woken' } })
    adapter.answer()
    await waitFor(() => idle() && Boolean(handoff()?.armed), 'the turn to settle with its wake waiting', 300_000)
    const recorded = handoff()!
    const session = d.orch.getOrCreateSession(thread.id)
    const holds = (candidate: Record<string, any>) => (d.orch as any).turnHandoffHolds(session, candidate, threadDir, 'main') as boolean
    const manager = new ThreadWorkspaceManager(threadDir)
    const record = readFileSync(manager.workspacePath, 'utf8')
    const worktree = manager.load()!.worktreePath
    // Each row changes one thing, so each check is the only one that refuses it.
    const rows: Array<[string, () => boolean]> = [
      ['a journal entry since', () => holds({ ...recorded, journalSequence: recorded.journalSequence - 1 })],
      ['another latest action', () => holds({ ...recorded, actionId: 'another-action' })],
      ['another recorded snapshot', () => {
        writeFileSync(manager.workspacePath, JSON.stringify({ ...JSON.parse(record), snapshotSha: '0'.repeat(40) }))
        try { return holds(recorded) } finally { writeFileSync(manager.workspacePath, record) }
      }],
      ['another conversation branch', () => holds({ ...recorded, conversationBranchId: 'another-branch' })],
      ['another workspace generation', () => holds({ ...recorded, generation: recorded.generation + 1 })],
      ['a missing worktree', () => {
        renameSync(worktree, `${worktree}-moved`)
        try { return holds(recorded) } finally { renameSync(`${worktree}-moved`, worktree) }
      }]
    ]
    expect(holds(recorded)).toBe(true)
    for (const [change, check] of rows) expect(check(), change).toBe(false)
    expect(holds(recorded)).toBe(true)
    releaseWakes()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the wake to run and settle', 300_000)
  })

  it.each(['project-folder', 'no-git', 'shared', 'primary'] as const)('a thread working in a %s folder never hands off', async (placement) => {
    const { d, adapter, thread, starts, idle } = await setup(false, placement)
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    const second = await d.orch.send('write second', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    expect(second.queued).toBe(true)
    adapter.answer()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the queued message to run and settle', 300_000)
    expect(starts.filter((line) => line.runId !== first.runId)).toHaveLength(1)
    expect(starts.find((line) => line.runId !== first.runId)!.phases.handoff).toBeUndefined()
    // Nor does it start from the last end unread: only a worktree of the thread's own is the agent's.
    expect(starts.find((line) => line.runId !== first.runId)!.phases.ownWorktree).toBeUndefined()
  })
})
