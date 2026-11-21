/**
 * A turn in the thread's own worktree starts from the last state Mousse recorded there (the baseline), with no Git
 * before the provider, while the worktree is still as Mousse left it (`OrchestratorService.ownWorktreeStart`): the
 * retained ref points at the baseline, the folder is the same physical checkout, and HEAD is where the baseline left it.
 * Every start is checked the same way, a queued message's and a wake's included; any mismatch reads the files first.
 * An edit made there between turns is the next turn's. A thread in the project folder always reads its folder first.
 *
 * Runs a real orchestrator, Run Engine and effect worker over a Git project, with a scripted provider. The idle Send
 * counts every process up to provider receipt in Git's trace. Queued turns measure setup after the previous checkpoint.
 * Undo is pressed for real and the files' bytes compared.
 *
 * Cases: a queued message; the settle's wake for a notice that came in during the turn; a wake the reconciler deferred;
 * an Undo between the turn and its wake; an idle Send after an edit; each mismatch that reads the files (the retained
 * ref removed, HEAD detached, a branch switched by hand, the worktree made again); Undo after a branch switch by hand
 * keeps the switch; Undo of a first turn that changed only line endings; Undo after a seeded fork, a restore of the
 * worktree, a Stop, a failure and a crash; the project folder; the placements that never start this way.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../src/mms/harness/drivers/claudeCode/adapter'
import type { AdapterHost, ProviderAdapter, ProviderCapabilities, TurnControl, TurnInput, TurnResult, TurnSink } from '../../src/mms/harness/adapter'
import type { ProviderDriverKind } from '../../src/shared/providerInstances'
import { ChangeReceiptService } from '../../src/mms/actions/ChangeReceiptService'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { recordExactTrees } from '../../src/mms/actions/snapshots'
import { readLinkedCheckout } from '../../src/mms/git/worktreeHeadFiles'
import { UndoService } from '../../src/mms/actions/UndoService'
import { EffectWorker, type EffectExecutor } from '../../src/mms/run/EffectWorker'
import { Reconciler } from '../../src/mms/run/Reconciler'
import { TERMINAL_RUN_STATUSES, type EffectRecord } from '../../src/mms/run/types'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { recordCheckoutIdentity } from '../../src/mms/workspace/checkoutIdentity'
import { phase6Daemon, waitFor, type Phase6Daemon } from './phase6Fixture'
import { pressed } from '../support/userRequest'

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 })

/**
 * Each turn's prompt says what it does: "write <name>" writes `<name>.txt`; "overwrite <file>" writes over it; "lf <file>"
 * rewrites it with LF line endings; "fail <name>" writes `<name>.txt` and fails; a turn named `first` or `held` waits
 * for the test's go (or its Stop). `gitAtReceipt` is how many Git processes had started when each turn reached it.
 */
class WritingAdapter implements ProviderAdapter {
  readonly turns: TurnInput[] = []
  readonly gitAtReceipt: number[] = []
  private gate: (() => void) | undefined
  constructor(readonly driver: ProviderDriverKind, readonly capabilities: ProviderCapabilities, private readonly gitCount: () => number) {}
  configured(): boolean { return true }
  answer(): void { this.gate?.(); this.gate = undefined }
  async startTurn(input: TurnInput, sink: TurnSink, _ctl: TurnControl, host: AdapterHost): Promise<TurnResult> {
    this.gitAtReceipt.push(this.gitCount())
    this.turns.push(input)
    const providerRef = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
    sink.providerRef(providerRef)
    const prompt = input.prompt.replace(/^[\s\S]*<\/handoff>\s*/, '')
    const operation = prompt.match(/\b(write|fail) (\w+)/)
    const name = operation?.[2]
    if (name && input.cwd) writeFileSync(join(input.cwd, `${name}.txt`), `${name}\n`)
    const overwritten = prompt.match(/overwrite (\S+)/)?.[1]
    if (overwritten && input.cwd) writeFileSync(join(input.cwd, overwritten), 'written by the agent\n')
    const lf = prompt.match(/lf (\S+)/)?.[1]
    if (lf && input.cwd) writeFileSync(join(input.cwd, lf), readFileSync(join(input.cwd, lf), 'utf8').replace(/\r\n/g, '\n'))
    if (name === 'first' || name === 'held') {
      await new Promise<void>((resolve, reject) => {
        this.gate = resolve
        input.signal.addEventListener('abort', () => reject(input.signal.reason ?? new Error('stopped')), { once: true })
      })
    }
    if (operation?.[1] === 'fail') throw new Error('scripted failure')
    sink.text({ phase: 'complete', content: 'Done', contentIndex: 0 })
    host.context.nativeHistoryAfterTurn('Done')
    return { text: 'Done', modelName: 'Scripted', totalResponseTimeMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextSignature: 'scripted', nativeMessages: [], providerRef }
  }
  async interrupt(): Promise<'interrupted' | 'not_active'> { return 'not_active' }
}

function gitProject(home: string, autocrlf = false): string {
  const projectDir = join(home, 'project')
  mkdirSync(projectDir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test'); git('config', 'core.autocrlf', 'false')
  writeFileSync(join(projectDir, 'README.md'), 'hello\n')
  git('add', '.'); git('commit', '-qm', 'init')
  if (autocrlf) git('config', 'core.autocrlf', 'true')
  return projectDir
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** Every file under `dir` but Git's own, with its bytes. */
function filesOf(dir: string): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else found[relative(dir, path).replace(/\\/g, '/')] = readFileSync(path).toString('hex')
    }
  }
  walk(dir)
  return found
}

interface StartLine { runId: string; edge: string; git: number; phases: Record<string, unknown> }

/** Where the thread works: its own worktree (the default), its project's folder, a project without Git, a folder it shares, the project's own checkout. */
type Placement = 'worktree' | 'project-folder' | 'no-git' | 'shared' | 'primary'

describe('a turn in the thread\'s own worktree', () => {
  let home: string | undefined
  let previousHome: string | undefined
  let previousTrace: string | undefined
  let daemon: Phase6Daemon | undefined
  let gatedWorker: EffectWorker | undefined
  let releaseWakes = (): void => undefined

  afterEach(async () => {
    releaseWakes()
    releaseWakes = () => undefined
    await gatedWorker?.stop().catch(() => undefined)
    gatedWorker = undefined
    await daemon?.stop().catch(() => undefined)
    daemon = undefined
    vi.restoreAllMocks()
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    home = undefined
  })

  /** A daemon over a Git project, its turns' start lines, and the thread's records. `holdWakes`: a wake turn waits for `releaseWakes`. */
  async function setup(options: { holdWakes?: boolean; placement?: Placement; autocrlf?: boolean } = {}) {
    const placement = options.placement ?? 'worktree'
    home = mkdtempSync(join(tmpdir(), 'mousse-own-start-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = placement === 'no-git' ? join(home, 'project') : gitProject(home, options.autocrlf)
    if (placement === 'no-git') mkdirSync(projectDir)
    // Every Git process Mousse starts from here on writes a line to this trace.
    const trace = join(home, 'git-trace.jsonl')
    previousTrace = process.env.GIT_TRACE2_EVENT
    process.env.GIT_TRACE2_EVENT = trace
    const gitCount = () => existsSync(trace) ? readFileSync(trace, 'utf8').split('\n').filter((line) => line.includes('"event":"start"')).length : 0
    const starts: StartLine[] = []
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      const text = String(args[0])
      if (text.startsWith('[turn-boundary] ')) {
        const line = JSON.parse(text.slice('[turn-boundary] '.length)) as StartLine
        if (line.edge === 'start') starts.push(line)
      }
    })
    const adapter = new WritingAdapter('claude', CLAUDE_SUBSCRIPTION_CAPABILITIES, gitCount)
    const d = phase6Daemon(home, [adapter])
    daemon = d
    if (options.holdWakes) {
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
    const thread = d.store.createThread('Own start', project.id, undefined, placement === 'project-folder' ? { worktreeEnabled: false } : {})
    d.orch.setThreadModelOverride(thread.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    if (placement === 'shared') d.orch.getOrCreateSession(thread.id).sharedWorkspace = { path: projectDir, parentThreadId: 'parent', access: 'write' }
    if (placement === 'primary') d.orch.getOrCreateSession(thread.id).primaryCheckout = { path: projectDir }
    const threadDir = d.store.getThreadDir(thread.id)
    const actionOf = (runId: string | undefined, dir = threadDir) => new ThreadActionService(dir).list().find((action) => action.turnId === runId)
    const idle = (threadId = thread.id) => !d.orch.getOrCreateSession(threadId).isTurnRunning() && !d.orch.getOrCreateSession(threadId).turnAdmitted
    const worktreeOf = (dir = threadDir) => new ThreadWorkspaceManager(dir).load()!.worktreePath
    const settled = (runId: string, threadId = thread.id) => {
      const run = d.engine.getRun(runId)
      return idle(threadId) && !!run && TERMINAL_RUN_STATUSES.has(run.status)
    }
    /** Sends `prompt` and waits until its turn has settled. */
    const turn = async (prompt: string, threadId = thread.id) => {
      const before = adapter.turns.length
      const sent = await d.orch.send(prompt, false, { threadId, clientRequestId: `${prompt}-${before}`, awaitMode: 'ack' })
      await waitFor(() => adapter.turns.length === before + 1 && settled(sent.runId!, threadId), `"${prompt}" to settle`, 300_000)
      return sent.runId!
    }
    /** Undo of the thread's latest turn, pressed as the person would. */
    const undo = (dir = threadDir) => pressed('Undo', () => new UndoService(dir).undoLatest('main', worktreeOf(dir)))
    return { d, adapter, thread, threadDir, projectDir, starts, actionOf, idle, settled, worktreeOf, turn, undo, gitCount, releaseWakes: () => releaseWakes() }
  }

  it('a message queued behind the turn starts from its end, with no Git up to the provider, and its diff holds only its own work', async () => {
    const { d, adapter, thread, threadDir, starts, actionOf, idle, worktreeOf, undo } = await setup()
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    const second = await d.orch.send('write second', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    expect(second.queued).toBe(true)
    adapter.answer()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the queued message to run and settle', 300_000)
    const secondRunId = d.engine.listRuns(thread.id).find((run) => run.runId !== first.runId)!.runId
    const started = starts.find((line) => line.runId === secondRunId)!
    expect(started.git).toBe(0)
    expect(started.phases.ownWorktree).toBeDefined()
    const firstAction = actionOf(first.runId)!, secondAction = actionOf(secondRunId)!
    expect(secondAction.startSha).toBe(firstAction.endSha)
    expect(secondAction.changedPaths.map((change) => change.path)).toEqual(['second.txt'])
    // Nothing was recorded between them as made outside Mousse.
    const ids = new ThreadActionService(threadDir).list().map((action) => action.id)
    expect(ids.indexOf(secondAction.id) - ids.indexOf(firstAction.id)).toBe(1)
    await undo()
    expect(readFileSync(join(worktreeOf(), 'first.txt'), 'utf8')).toBe('first\n')
    expect(existsSync(join(worktreeOf(), 'second.txt'))).toBe(false)
  })

  it('an idle Send runs no Git process from the Send to the provider, and an edit made since is the turn\'s', async () => {
    const { adapter, threadDir, starts, actionOf, worktreeOf, turn, gitCount, undo } = await setup()
    const first = await turn('write one')
    const before = filesOf(worktreeOf())
    writeFileSync(join(worktreeOf(), 'README.md'), 'edited by the person\n')
    const atSend = gitCount()
    const later = await turn('write later')
    expect(adapter.gitAtReceipt[1]).toBe(atSend)
    expect(starts.find((line) => line.runId === later)!.phases.ownWorktree).toBeDefined()
    const actions = new ThreadActionService(threadDir).list()
    const own = actionOf(later)!
    expect(actions.some((action) => action.actor?.kind === 'user')).toBe(false)
    expect(own.startSha).toBe(actionOf(first)!.endSha)
    expect(own.changedPaths.map((change) => change.path).sort()).toEqual(['README.md', 'later.txt'])
    await undo()
    expect(filesOf(worktreeOf())).toEqual(before)
  })

  it('captures a fresh start when the retained snapshot object is missing, so Undo keeps pre-turn edits', async () => {
    const { threadDir, starts, actionOf, worktreeOf, turn, undo } = await setup()
    await turn('write one')
    const worktree = worktreeOf()
    const { retainedRef, snapshotSha, headSha } = new ThreadWorkspaceManager(threadDir).load()!
    const baseline = snapshotSha!
    const common = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const loose = join(common, 'objects', baseline.slice(0, 2), baseline.slice(2))
    expect(baseline).not.toBe(headSha)
    expect(git(worktree, 'cat-file', '-t', baseline)).toBe('commit')
    const checkout = await readLinkedCheckout(worktree)
    expect(checkout).toBeDefined()
    renameSync(loose, join(common, 'moved-snapshot'))
    expect(await readLinkedCheckout(worktree)).toEqual(checkout)
    expect(readFileSync(join(common, retainedRef), 'utf8').trim()).toBe(baseline)
    expect(git(worktree, 'rev-parse', '--verify', 'HEAD^{commit}')).toBe(headSha)
    expect(() => git(worktree, 'cat-file', '-t', baseline)).toThrow()

    writeFileSync(join(worktree, 'outside.txt'), 'saved before Send\n')
    const before = filesOf(worktree)
    const index = join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'index')
    const beforeIndex = readFileSync(index)
    const next = await turn('write two')
    const started = starts.find((line) => line.runId === next)!
    expect(started.phases.ownWorktree).toBeUndefined()
    expect(started.phases.snapshotIndex).toBeDefined()
    expect(actionOf(next)?.changedPaths.map((change) => change.path)).toEqual(['two.txt'])
    await undo()
    expect(filesOf(worktree)).toEqual(before)
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(headSha)
    expect(readFileSync(index)).toEqual(beforeIndex)
  })

  it('uses a packed retained snapshot with zero Git starts after the repack is validated', async () => {
    const { adapter, threadDir, starts, actionOf, worktreeOf, turn, gitCount, undo } = await setup()
    const first = await turn('write one')
    const worktree = worktreeOf()
    const baseline = actionOf(first)!.endSha
    const common = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    git(worktree, '-c', 'pack.indexVersion=2', 'repack', '-ad')
    expect(existsSync(join(common, 'objects', baseline.slice(0, 2), baseline.slice(2)))).toBe(false)
    expect(git(worktree, 'cat-file', '-t', baseline)).toBe('commit')
    // Pack changes require Git to revalidate the checkout before the next fast start.
    await recordCheckoutIdentity(threadDir, worktree)

    const before = filesOf(worktree)
    const atSend = gitCount()
    const next = await turn('write two')
    expect(adapter.gitAtReceipt[1]).toBe(atSend)
    expect(starts.find((line) => line.runId === next)?.phases.ownWorktree).toBeDefined()
    expect(actionOf(next)?.startSha).toBe(baseline)
    await undo()
    expect(filesOf(worktree)).toEqual(before)
  })

  it('a notice that came in during the turn wakes the thread at its settle, and the wake starts from its end with no Git', async () => {
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

  it('a wake the reconciler made and deferred between the run\'s end and its settle is brought forward', async () => {
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

  it('an Undo pressed between the turn and its wake: the wake starts from the undone files, with no snapshot', async () => {
    const { d, adapter, thread, starts, actionOf, idle, worktreeOf, undo, releaseWakes } = await setup({ holdWakes: true })
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    d.engine.inbox.append({ inboxId: `inbox:notice:${thread.id}:1:0`, threadId: thread.id, kind: 'reconcile_notice', payload: { text: 'write woken' } })
    adapter.answer()
    await waitFor(() => idle() && d.engine.listRuns(thread.id).some((run) => run.source === 'wake'), 'the turn to settle with its wake waiting', 300_000)
    await undo()
    expect(existsSync(join(worktreeOf(), 'first.txt'))).toBe(false)
    releaseWakes()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the wake to run and settle', 300_000)
    const wake = d.engine.listRuns(thread.id).find((run) => run.source === 'wake')!
    const started = starts.find((line) => line.runId === wake.runId)!
    expect(started.phases.ownWorktree).toBeDefined()
    expect(started.phases.snapshotIndex).toBeUndefined()
    const woke = actionOf(wake.runId)!
    expect(woke.startSha).not.toBe(actionOf(first.runId)!.endSha)
    // It starts from the undone files: the undone file is not its to take back, and it changed only its own.
    expect(woke.changedPaths.map((change) => change.path)).toEqual(['woken.txt'])
  })

  it.each([
    ['the retained ref was removed', (worktree: string, threadDir: string) => { git(worktree, 'update-ref', '-d', new ThreadWorkspaceManager(threadDir).load()!.retainedRef) }],
    ['the retained ref was moved to a different commit', (worktree: string, threadDir: string) => {
      git(worktree, 'update-ref', new ThreadWorkspaceManager(threadDir).load()!.retainedRef, 'HEAD')
    }],
    ['HEAD was detached by hand', (worktree: string) => { git(worktree, 'switch', '-q', '--detach') }],
    ['a branch was switched to by hand', (worktree: string) => { git(worktree, 'switch', '-q', '-c', 'by-hand') }],
    ['the worktree was removed and added again at its path', (worktree: string) => {
      const branch = git(worktree, 'branch', '--show-current')
      const main = git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      git(join(main, '..'), 'worktree', 'remove', '--force', worktree)
      git(join(main, '..'), 'worktree', 'add', '-q', worktree, branch)
    }]
  ] as const)('when %s, the next turn reads the files first', async (_change, change) => {
    const { threadDir, starts, worktreeOf, turn } = await setup()
    await turn('write one')
    change(worktreeOf(), threadDir)
    const next = await turn('write two')
    const started = starts.find((line) => line.runId === next)!
    expect(started.phases.ownWorktree).toBeUndefined()
    expect(started.phases.snapshotIndex).toBeDefined()
    // And the turn after it, with nothing changed again, starts from its end.
    const third = await turn('write three')
    expect(starts.find((line) => line.runId === third)!.phases.ownWorktree).toBeDefined()
  })

  it('Undo of a turn after a branch switched by hand keeps the switch\'s files', async () => {
    const { worktreeOf, turn, undo } = await setup()
    await turn('write one')
    const worktree = worktreeOf()
    git(worktree, 'switch', '-q', '-c', 'by-hand')
    writeFileSync(join(worktree, 'README.md'), 'on the other branch\n')
    git(worktree, 'commit', '-qam', 'other')
    const before = filesOf(worktree)
    await turn('write two')
    await undo()
    expect(filesOf(worktree)).toEqual(before)
    expect(git(worktree, 'branch', '--show-current')).toBe('by-hand')
  })

  it('Undo of a first turn that changed only line endings puts back the bytes the checkout wrote', async () => {
    const { worktreeOf, turn, undo, starts } = await setup({ autocrlf: true })
    const first = await turn('lf README.md')
    expect(starts.find((line) => line.runId === first)!.phases.ownWorktree).toBeDefined()
    const worktree = worktreeOf()
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('hello\n')
    await undo()
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('hello\r\n')
  })

  it.each([true, false])('Undo restores the original checkout bytes after autocrlf changes (provisioning captured exact bytes: %s)', async (hasBaseline) => {
    const { thread, threadDir, projectDir, worktreeOf, turn, undo, starts } = await setup({ autocrlf: true })
    recordExactTrees(hasBaseline)
    try { await new ThreadWorkspaceManager(threadDir).provision(thread.id, 'main', projectDir) }
    finally { recordExactTrees(true) }
    const worktree = worktreeOf()
    const file = join(worktree, 'README.md')
    const original = Buffer.from('hello\r\n')
    expect(readFileSync(file)).toEqual(original)
    git(projectDir, 'config', 'core.autocrlf', 'false')
    const first = await turn('lf README.md')
    const phases = starts.find((line) => line.runId === first)!.phases
    expect(phases.ownWorktree).toBeUndefined()
    expect(phases.snapshotIndex).toBeDefined()
    expect(readFileSync(file)).toEqual(Buffer.from('hello\n'))
    const head = git(worktree, 'rev-parse', 'HEAD')
    const index = git(worktree, 'ls-files', '-s')
    await undo()
    expect(readFileSync(file)).toEqual(original)
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(worktree, 'ls-files', '-s')).toBe(index)
  })

  it('Undo after a Stop, after a failure, and after a restore puts back the bytes the turn started from', async () => {
    const { d, adapter, thread, threadDir, projectDir, starts, actionOf, worktreeOf, turn, undo, settled } = await setup({ autocrlf: true })
    await turn('write one')
    // A Stop: the turn wrote its file and was stopped.
    const stopped = await d.orch.send('write held', false, { threadId: thread.id, clientRequestId: 'held', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 2, 'the held turn to reach the provider', 180_000)
    expect(d.orch.abortActiveTurn(thread.id)).toBeTruthy()
    await waitFor(() => settled(stopped.runId!), 'the stopped turn to settle', 120_000)
    expect(actionOf(stopped.runId)?.state).toBe('stopped')
    let before = filesOf(worktreeOf())
    let next = await turn('write afterstop')
    expect(starts.find((line) => line.runId === next)!.phases.ownWorktree).toBeDefined()
    await undo()
    expect(filesOf(worktreeOf())).toEqual(before)
    // A failure: the turn wrote its file and failed.
    const failed = await turn('fail broken')
    expect(actionOf(failed)?.state).toBe('failed')
    before = filesOf(worktreeOf())
    next = await turn('write afterfail')
    expect(starts.find((line) => line.runId === next)!.phases.ownWorktree).toBeDefined()
    await undo()
    expect(filesOf(worktreeOf())).toEqual(before)
    // Restore the worktree from its retained snapshot, including the previous turns' LF bytes.
    const worktree = worktreeOf()
    before = filesOf(worktree)
    git(projectDir, 'worktree', 'remove', '--force', worktree)
    await pressed('Restore worktree', () => new ThreadWorkspaceManager(threadDir).restore(projectDir))
    expect(filesOf(worktreeOf())).toEqual(before)
    await turn('write afterrestore')
    expect(filesOf(worktreeOf())).toMatchObject({ 'afterrestore.txt': expect.any(String) })
    await undo()
    expect(filesOf(worktreeOf())).toEqual(before)
  })

  it('Undo of a forked thread\'s first turn puts back the files the fork was seeded with', async () => {
    const { d, thread, starts, worktreeOf, turn, undo } = await setup({ autocrlf: true })
    await turn('write one lf README.md')
    const seeded = filesOf(worktreeOf())
    const fork = await d.engine.forkThread({ sourceThreadId: thread.id, atRunOrdinal: 1, clientRequestId: `fork:${thread.id}` })
    const forkDir = d.store.getThreadDir(fork.threadId)
    d.orch.setThreadModelOverride(fork.threadId, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const forked = await turn('write forked', fork.threadId)
    expect(starts.find((line) => line.runId === forked)!.phases.ownWorktree).toBeDefined()
    expect(filesOf(worktreeOf(forkDir))).toMatchObject({ 'one.txt': expect.any(String), 'forked.txt': expect.any(String) })
    await undo(forkDir)
    expect(filesOf(worktreeOf(forkDir))).toEqual(seeded)
  })

  it('after a crash between the end snapshot and its record, recovery keeps the end it took: an edit made later is the next turn\'s, and Undo puts it back', async () => {
    const { actionOf, worktreeOf, turn, undo } = await setup()
    await turn('write one')
    // The end of the next turn is snapshotted, then the process dies before the change is recorded.
    const crash = vi.spyOn(ChangeReceiptService.prototype, 'record').mockRejectedValueOnce(new Error('interrupted checkpoint'))
    const crashed = await turn('write two')
    crash.mockRestore()
    const worktree = worktreeOf()
    const atEnd = filesOf(worktree)
    writeFileSync(join(worktree, 'README.md'), 'edited after the turn\n')
    // The next turn's start recovers the interrupted end, then starts from it.
    const next = await turn('write three')
    expect(actionOf(crashed)!.changedPaths.map((change) => change.path)).toEqual(['two.txt'])
    expect(actionOf(next)!.changedPaths.map((change) => change.path).sort()).toEqual(['README.md', 'three.txt'])
    await undo()
    expect(filesOf(worktree)).toEqual(atEnd)
  })

  it('in the project folder, a file the person saved between turns comes back when the agent\'s overwrite of it is undone', async () => {
    const { threadDir, starts, actionOf, worktreeOf, turn, undo } = await setup({ placement: 'project-folder' })
    await turn('write one')
    const folder = worktreeOf()
    // The person saves a file in an editor; the next turn's agent writes over it.
    writeFileSync(join(folder, 'README.md'), 'saved in the editor\n')
    const later = await turn('overwrite README.md')
    expect(starts.find((line) => line.runId === later)!.phases.ownWorktree).toBeUndefined()
    const actions = new ThreadActionService(threadDir).list()
    const own = actionOf(later)!
    const outside = actions[actions.findIndex((action) => action.id === own.id) - 1]!
    expect(outside.actor).toEqual({ kind: 'user' })
    expect(outside.changedPaths.map((change) => change.path)).toEqual(['README.md'])
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('written by the agent\n')
    await undo()
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('saved in the editor\n')
  })

  it.each(['project-folder', 'no-git', 'shared', 'primary'] as const)('a thread working in a %s folder never starts unread', async (placement) => {
    const { d, adapter, thread, starts, idle } = await setup({ placement })
    const first = await d.orch.send('write first', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => adapter.turns.length === 1, 'the first turn to reach the provider', 180_000)
    const second = await d.orch.send('write second', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    expect(second.queued).toBe(true)
    adapter.answer()
    await waitFor(() => adapter.turns.length === 2 && idle(), 'the queued message to run and settle', 300_000)
    expect(starts.filter((line) => line.runId !== first.runId)).toHaveLength(1)
    expect(starts.find((line) => line.runId !== first.runId)!.phases.ownWorktree).toBeUndefined()
  })
})
