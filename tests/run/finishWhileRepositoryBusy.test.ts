/**
 * A turn whose answer is complete shows as finished while its end-of-turn checkpoint still waits for the repository's
 * lease (another thread's checkpoint holds it), and the checkpoint it then records is this turn's alone. Runs a real
 * orchestrator, Run Engine and effect worker over a Git project, with a scripted provider that writes a file and is
 * held until the test has taken the repository's lease, as a slow checkpoint of another thread would hold it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { isTurnStoppable, turnPhaseActivity } from '../../src/shared/types'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
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
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    writeFileSync(join(projectDir, 'README.md'), 'hello\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    git('add', '.')
    git('commit', '-qm', 'init')
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
})
