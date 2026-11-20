/**
 * Every thread's turn logs where its start and its end spend their time (`src/mms/diagnostics/turnBoundary.ts`): one
 * `[turn-boundary]` line as the turn reaches its provider and one as it settles, with the Git commands each phase ran.
 * Runs a real orchestrator, Run Engine and effect worker over a Git project, with a scripted provider, for an ordinary
 * thread (not a bot's) and two turns back to back: the second message waits while the first one's checkpoint waits
 * for the repository's lease, as a slow checkpoint of another thread would hold it.
 *
 * The Git count is checked against Git itself: every Git process writes its own trace (`GIT_TRACE2_EVENT` pointed at a
 * folder, one file per process), so the processes that started inside each logged boundary are counted independently
 * of how Mousse started them.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { inTurnBoundary, turnBoundaryMark } from '../../src/mms/diagnostics/turnBoundary'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'

// Each Git command can take a second on a loaded Windows machine, and a boundary runs dozens.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 60_000 })

/** A provider stand-in: each turn writes `<prompt>.txt` in its folder; `first` waits for the test's go before answering. */
class WritingAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  private gate: (() => void) | undefined
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities) {}

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
    if (name === 'first') await new Promise<void>((resolve) => { this.gate = resolve })
    sink.text({ phase: 'complete', content: 'Done', contentIndex: 0 })
    host.context.nativeHistoryAfterTurn('Done')
    return { text: 'Done', modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }

  async interrupt(): Promise<'interrupted' | 'not_active'> {
    return 'not_active'
  }
}

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

interface BoundaryLine {
  threadId: string
  runId?: string
  edge: 'start' | 'end'
  ended?: string
  ms: number
  git: number
  gitMs: number
  leaseMs?: number
  phases: Record<string, { ms: number; git?: number; leaseMs?: number }>
  /** When the line was written (epoch ms), from the test's clock. */
  at: number
}

/** The start time (epoch ms, to the microsecond) of each top-level Git process that wrote a trace to `folder`. */
function gitProcessStarts(folder: string): number[] {
  const starts: number[] = []
  for (const file of readdirSync(folder)) {
    for (const line of readFileSync(join(folder, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as { event: string; sid: string; time: string }
      // A process a Git command started itself (a hook, a helper) is nested under its parent's session id.
      if (event.event !== 'version' || event.sid.includes('/')) continue
      const [, whole, fraction] = /^(.*\.\d{3})(\d*)Z$/.exec(event.time)!
      starts.push(Date.parse(`${whole}Z`) + Number(`0.${fraction || '0'}`))
    }
  }
  return starts
}

describe('turn boundary timing for an ordinary thread', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let previousTrace: string | undefined
  let daemon: Phase6Daemon | undefined
  let held: RepositoryLeaseHandle | undefined

  afterEach(async () => {
    held?.release()
    held = undefined
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  it('logs one line per turn start and per turn end, counting every Git command each boundary ran', async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-turn-boundary-'))
    previousHome = process.env.MOUSSE_HOME
    previousTrace = process.env.GIT_TRACE2_EVENT
    process.env.MOUSSE_HOME = home
    const projectDir = gitProject(home)
    const lines: BoundaryLine[] = []
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const text = String(args[0])
      if (text.startsWith('[turn-boundary] ')) lines.push({ ...JSON.parse(text.slice('[turn-boundary] '.length)), at: Date.now() })
    })
    const adapter = new WritingAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES)
    const d = phase6Daemon(home, [adapter])
    daemon = d
    const project = d.projects.openProject(projectDir)
    const thread = d.store.createThread('Timed thread', project.id)
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const traces = join(home, 'git-trace')
    mkdirSync(traces)
    // From here every Git process Mousse starts writes its own trace file: Mousse's Git environment keeps this variable.
    process.env.GIT_TRACE2_EVENT = traces

    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    // Another thread's checkpoint holds the repository: the first turn's end waits for it, and the next message waits too.
    held = await acquireRepositoryLease(resolveRepositoryIdentity(projectDir))
    adapter.answer()
    await waitFor(() => d.engine.getRun(first.runId!)?.status === 'finalizing', 'the first turn to wait for its checkpoint', 180_000)
    const second = await d.orch.send('write second', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    expect(second.queued).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    held.release()
    held = undefined
    await waitFor(() => adapter.turns.length === 2 && !d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the queued message to run and settle', 300_000)
      .catch((error: Error) => { throw new Error(`${error.message}: turns ${adapter.turns.length}, lines ${JSON.stringify(lines)}`) })
    await waitFor(() => lines.length === 4, 'both turns to log their end', 60_000)
    delete process.env.GIT_TRACE2_EVENT

    const secondRunId = d.engine.listRuns(thread.id).find((run) => run.runId !== first.runId)?.runId
    // One start and one end per turn, in the order they happened, all on this thread.
    expect(lines.map((line) => [line.runId, line.edge])).toEqual([
      [first.runId, 'start'], [first.runId, 'end'], [secondRunId, 'start'], [secondRunId, 'end']
    ])
    expect(lines.every((line) => line.threadId === thread.id && line.ended === undefined)).toBe(true)

    // Each line's Git count is the number of Git processes that started inside its boundary, as Git itself traced them.
    const starts = gitProcessStarts(traces)
    for (const line of lines) {
      const inside = starts.filter((at) => at >= line.at - line.ms - 1 && at <= line.at).length
      expect({ runId: line.runId, edge: line.edge, git: line.git }).toEqual({ runId: line.runId, edge: line.edge, git: inside })
      // The phases add up to the line.
      expect(Object.values(line.phases).reduce((sum, phase) => sum + (phase.git ?? 0), 0)).toBe(line.git)
    }
    // Starting a turn in a Git worktree runs Git, and so does recording its end.
    expect(lines.every((line) => line.git > 0)).toBe(true)
  })

  it("counts the wait for a repository's lease in the phase that waited", async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-turn-boundary-lease-'))
    const identity = resolveRepositoryIdentity(gitProject(home))
    held = await acquireRepositoryLease(identity)
    const logged: string[] = []
    await inTurnBoundary({ threadId: 'thread' }, async () => {
      turnBoundaryMark('thread', 'before')
      const holder = held!
      setTimeout(() => holder.release(), 300)
      const lease = await acquireRepositoryLease(identity)
      lease.release()
      turnBoundaryMark('thread', 'checkpoint')
    }, (line) => logged.push(line))
    held = undefined
    expect(logged).toHaveLength(1)
    const line = JSON.parse(logged[0].slice('[turn-boundary] '.length)) as BoundaryLine
    expect(line).toMatchObject({ edge: 'start', ended: 'beforeProvider' })
    expect(line.phases.checkpoint.leaseMs).toBeGreaterThanOrEqual(250)
    expect(line.phases.before.leaseMs).toBeUndefined()
  })
})
