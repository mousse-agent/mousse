/**
 * A turn its previous turn's settle starts (a message queued behind it, or the wake for notices that came in while it
 * ran) starts from that turn's end snapshot: it runs no Git to check and snapshot the worktree again
 * (`OrchestratorService.recordTurnHandoff` / `settleTurnHandoff` / `takeTurnHandoff`). Runs a real orchestrator, Run
 * Engine and effect worker over a Git project, with a scripted provider; Git is counted from each turn's start line
 * (`[turn-boundary]`).
 *
 * Cases: a queued message; a wake for a notice that arrived during the turn (the fixture runs no reconciler, so only
 * the settle's own wake starts it); an Undo pressed between the turn and its wake; a message sent once the thread is
 * idle, after the person edited a file.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { UndoService } from '../../src/mms/actions/UndoService'
import { EffectWorker, type EffectExecutor } from '../../src/mms/run/EffectWorker'
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

interface StartLine { runId: string; edge: string; git: number }

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
  async function setup(holdWakes = false) {
    home = mkdtempSync(join(tmpdir(), 'mousse-handoff-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = gitProject(home)
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
    const thread = d.store.createThread('Hand-off', project.id)
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const threadDir = d.store.getThreadDir(thread.id)
    const actionOf = (runId: string | undefined) => new ThreadActionService(threadDir).list().find((action) => action.turnId === runId)
    const idle = () => !d.orch.getOrCreateSession(thread.id).isTurnRunning() && !d.orch.getOrCreateSession(thread.id).turnAdmitted
    return { d, adapter, thread, threadDir, starts, actionOf, idle, releaseWakes: () => releaseWakes() }
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

  it('an Undo pressed between the turn and its wake makes the wake read and snapshot the worktree again', async () => {
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
    expect(starts.find((line) => line.runId === wake.runId)!.git).toBeGreaterThan(0)
    const woke = actionOf(wake.runId)!
    expect(woke.startSha).not.toBe(actionOf(first.runId)!.endSha)
    // It starts from the undone files: the undone file is not its to take back, and it changed only its own.
    expect(woke.changedPaths.map((change) => change.path)).toEqual(['woken.txt'])
  })

  it('a message sent once the thread is idle records the person\'s edits as their own action first', async () => {
    const { d, adapter, thread, threadDir, starts, actionOf, idle } = await setup()
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    adapter.answer()
    await waitFor(() => idle() && d.engine.getRun(first.runId!)?.status === 'completed', 'the first turn to settle', 300_000)
    const worktree = new ThreadWorkspaceManager(threadDir).load()!.worktreePath
    writeFileSync(join(worktree, 'README.md'), 'edited by the person\n')
    const later = await d.orch.send('write later', false, { threadId: thread.id, clientRequestId: 'later', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the later turn to run and settle', 300_000)
    expect(starts.find((line) => line.runId === later.runId)!.git).toBeGreaterThan(0)
    const actions = new ThreadActionService(threadDir).list()
    const own = actionOf(later.runId)!
    const outside = actions[actions.findIndex((action) => action.id === own.id) - 1]!
    expect(outside.actor).toEqual({ kind: 'user' })
    expect(outside.changedPaths.map((change) => change.path)).toEqual(['README.md'])
    expect(own.changedPaths.map((change) => change.path)).toEqual(['later.txt'])
  })
})
