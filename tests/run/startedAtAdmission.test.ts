/**
 * A person's message starts its thread as its turn is admitted, not once the turn's worktree and snapshot are set up:
 * a new chat's empty thread (as New thread makes it) is listed started, on top of its project, while its first turn
 * still waits for its worktree. Before, it stayed an unstarted draft for that whole wait: its row did not open, and
 * New thread opened it again instead of a fresh one. Real orchestrator, Run Engine and Git; the test holds the
 * project's repository, as another operation would, so the worktree step lasts as long as the test wants.
 * Rows: one empty thread sent (listed, and named from its message); one whose title model never answers (its agent still
 * gets the turn); two sent one after the other (their order, during the setup and after it).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../../src/mms/actions/ThreadActionService'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { ThreadWorkspaceManager } from '../../src/mms/workspace/ThreadWorkspaceManager'
import { registerBranchNamer } from '../../src/mms/workspace/branchNaming'
import { findUnstartedThread } from '../../src/shared/threadTitle'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

describe("a new chat's thread while its first turn is set up", () => {
  let home: string | undefined
  let previousHome: string | undefined
  let daemon: Phase6Daemon | undefined
  let held: RepositoryLeaseHandle | undefined
  let unregisterNamer: (() => void) | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    held?.release()
    held = undefined
    unregisterNamer?.()
    unregisterNamer = undefined
    await daemon?.shutdown()
    daemon = undefined
    if (previousHome === undefined) delete process.env.MOUSSE_HOME
    else process.env.MOUSSE_HOME = previousHome
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
  })

  const world = (reply: () => string | Promise<string> = () => 'Done') => {
    home = mkdtempSync(join(tmpdir(), 'mousse-started-at-admission-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
    git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
    writeFileSync(join(projectDir, 'README.md'), 'hello\n'); git('add', '.'); git('commit', '-qm', 'init')
    const pi = piAdapter(reply)
    const d = (daemon = phase6Daemon(home, [pi]))
    unregisterNamer = registerBranchNamer(home, {
      settings: () => d.settings.branches,
      ask: (request, signal) => d.orch.askBranchName(request, signal)
    })
    const project = d.projects.openProject(projectDir)
    /** An empty thread in a new worktree, as the sidebar's New thread makes it: not started until a message is sent. */
    const emptyThread = () => {
      const made = d.store.createThread('New Chat', project.id, projectDir, { worktreeEnabled: true })
      d.orch.setThreadModelOverride(made.id, PI)
      return made
    }
    const listed = () => d.store.listAllThreadsVersioned().threads.filter((thread) => thread.projectId === project.id)
    const holdRepository = async () => { held = await acquireRepositoryLease(resolveRepositoryIdentity(projectDir)) }
    const freeRepository = () => { held?.release(); held = undefined }
    const preparingWorktree = (threadId: string) => {
      const state = d.orch.getTurnState(threadId)
      return state.phase === 'queued' && state.step?.kind === 'preparing' && state.step.what === 'worktree'
    }
    const idle = (threadId: string) => !d.orch.getOrCreateSession(threadId).isTurnRunning()
    const localBranches = () => execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: projectDir, encoding: 'utf8' }).trim().split(/\r?\n/)
    return { d, pi, project, emptyThread, listed, holdRepository, freeRepository, preparingWorktree, idle, localBranches }
  }

  it('lists it started, on top of its project, while its worktree is still made, so New thread does not open it again', async () => {
    const w = world()
    const older = w.emptyThread()
    await w.d.orch.send('Earlier work', false, { threadId: older.id, clientRequestId: 'older', awaitMode: 'ack' })
    await waitFor(() => w.pi.turns.length === 1 && w.idle(older.id), 'the earlier thread to finish', 40_000)

    const draft = w.emptyThread()
    expect(findUnstartedThread(w.listed(), w.project.id)?.id).toBe(draft.id)
    await w.holdRepository()
    await w.d.orch.send('Plan the release', false, { threadId: draft.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparingWorktree(draft.id), 'the worktree step to show')
    // The setup has not got to the message yet: the agent has nothing, the transcript has nothing.
    expect(w.pi.turns).toHaveLength(1)
    expect(w.d.orch.getOrCreateSession(draft.id).messages.some((message) => message.role === 'user')).toBe(false)

    const shown = w.d.store.getThread(draft.id)!
    expect(shown.startedAt).toBeTruthy()
    expect(shown.order).toBeLessThan(w.d.store.getThread(older.id)!.order)
    expect(w.listed().map((thread) => thread.id)).toContain(draft.id)
    expect(findUnstartedThread(w.listed(), w.project.id)).toBeUndefined()

    w.freeRepository()
    await waitFor(() => w.pi.turns.length === 2 && w.idle(draft.id), 'the turn to finish', 40_000)
    expect(w.pi.turns[1]!.prompt).toMatch(/Plan the release$/)
  })

  it('names it from its message while its worktree is still made, not once the setup is over', async () => {
    const w = world()
    const draft = w.emptyThread()
    await w.holdRepository()
    await w.d.orch.send('Please plan the release for Friday', false, { threadId: draft.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparingWorktree(draft.id), 'the worktree step to show')
    expect(w.d.store.getThread(draft.id)!.name).toBe('Plan the release for Friday')
    w.freeRepository()
    await waitFor(() => w.pi.turns.length === 1 && w.idle(draft.id), 'the turn to finish', 40_000)
    expect(w.d.store.getThread(draft.id)!.name).toBe('Plan the release for Friday')
  })

  it('gives the agent its turn while the title model has not answered', async () => {
    const w = world()
    w.d.settings.title = { ...w.d.settings.title, ...PI }
    // The naming request never answers.
    const oneShot = vi.fn(() => new Promise<never>(() => undefined))
    ;(w.d.orch as unknown as { harness: { oneShot: unknown } }).harness.oneShot = oneShot
    const draft = w.emptyThread()
    await w.d.orch.send('Please plan the release for Friday', false, { threadId: draft.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.pi.turns.length === 1, 'the agent to get the turn', 40_000)
    expect(w.pi.turns[0]!.prompt).toMatch(/Please plan the release for Friday$/)
    expect(oneShot).toHaveBeenCalledTimes(1)
    expect(w.d.store.getThread(draft.id)).toMatchObject({ name: 'Plan the release for Friday', titleSource: 'provisional' })
  })

  it("discards the cancelled send's title and branch when a different first message is sent after Stop", async () => {
    const w = world()
    w.d.settings.title = { ...w.d.settings.title, ...PI }
    let answerStopped!: (answer: { text: string }) => void
    const stoppedAnswer = new Promise<{ text: string }>((resolve) => { answerStopped = resolve })
    const oneShot = vi.fn(async () => ({ text: 'Title: Fix checkout retries\nBranch: checkout-retries' }))
      .mockImplementationOnce(() => stoppedAnswer)
    ;(w.d.orch as unknown as { harness: { oneShot: unknown } }).harness.oneShot = oneShot
    const draft = w.emptyThread()
    await w.holdRepository()
    await w.d.orch.send('Plan the release for Friday', false, { threadId: draft.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparingWorktree(draft.id) && oneShot.mock.calls.length === 1, 'the first send to wait on setup and naming')
    expect(w.d.store.getThread(draft.id)!.name).toBe('Plan the release for Friday')
    expect((await w.d.orch.stopThread(draft.id, 'user', { clientRequestId: 'stop-first' })).ok).toBe(true)
    await waitFor(() => w.idle(draft.id), 'the cancelled send to settle')
    expect(w.d.store.getThread(draft.id)!.name).toBe('New Chat')

    await w.d.orch.send('Please fix checkout retries', false, { threadId: draft.id, clientRequestId: 'second', awaitMode: 'ack' })
    await waitFor(() => oneShot.mock.calls.length === 2, 'the second send to ask for a new name')
    expect(w.d.store.getThread(draft.id)!.name).toBe('Fix checkout retries')
    answerStopped({ text: 'Title: Stale release plan\nBranch: stale-release' })
    w.freeRepository()
    await waitFor(() => w.pi.turns.length === 1 && w.idle(draft.id), 'the new turn to finish', 40_000)
    expect(w.pi.turns[0]!.prompt).toMatch(/Please fix checkout retries$/)
    expect(w.d.store.getThread(draft.id)!.name).toBe('Fix checkout retries')
    await waitFor(() => w.localBranches().includes('mousse/checkout-retries'), 'the branch to get the new name', 40_000)
    expect(w.localBranches()).not.toContain('mousse/stale-release')
  })

  it('keeps the temporary branch when the naming answer arrives during snapshot setup before Stop', async () => {
    const w = world()
    const draft = w.emptyThread()
    w.d.settings.title = { ...w.d.settings.title, ...PI }
    const naming = Promise.withResolvers<{ text: string }>()
    const oneShot = vi.fn(() => naming.promise)
    ;(w.d.orch as unknown as { harness: { oneShot: unknown } }).harness.oneShot = oneShot
    const snapshot = Promise.withResolvers<void>()
    const renaming = vi.spyOn(ThreadWorkspaceManager.prototype, 'renameOwnBranch')
    const recordOutsideChanges = ThreadActionService.prototype.recordOutsideChanges
    const checkpoint = vi.spyOn(ThreadActionService.prototype, 'recordOutsideChanges').mockImplementation(async function (this: ThreadActionService, options) {
      await snapshot.promise
      options.signal?.throwIfAborted()
      return recordOutsideChanges.call(this, options)
    })
    await w.d.orch.send('Plan the release for Friday', false, { threadId: draft.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => checkpoint.mock.calls.length === 1 && oneShot.mock.calls.length === 1, 'snapshot setup and the naming request')
    const before = w.localBranches()
    expect(before).toContainEqual(expect.stringMatching(/^mousse\/[0-9a-f]{8}$/))
    try {
      naming.resolve({ text: 'Title: Friday release plan\nBranch: friday-release' })
      await waitFor(() => w.d.store.getThread(draft.id)?.name === 'Friday release plan', 'the naming answer to be received')
      // If a rename started, let its real Git operation finish while the snapshot is still paused.
      await Promise.allSettled(renaming.mock.results.map(({ value }) => value))
      expect(w.localBranches()).toEqual(before)
      const stopped = w.d.orch.stopThread(draft.id, 'user', { clientRequestId: 'stop-first' })
      await waitFor(() => checkpoint.mock.calls[0]![0].signal?.aborted === true, 'Stop to reach snapshot setup')
      snapshot.resolve()
      expect((await stopped).ok).toBe(true)
      await waitFor(() => w.idle(draft.id), 'the cancelled send to settle')
      expect(w.d.store.getThread(draft.id)?.name).toBe('New Chat')
      expect(w.pi.turns).toHaveLength(0)
      expect(w.localBranches()).toEqual(before)

      oneShot.mockResolvedValue({ text: 'Title: Checkout retries\nBranch: checkout-retries' })
      await w.d.orch.send('Fix checkout retries', false, { threadId: draft.id, clientRequestId: 'retry', awaitMode: 'ack' })
      await waitFor(() => w.pi.turns.length === 1 && w.idle(draft.id), 'the accepted Send to finish', 40_000)
      await waitFor(() => w.localBranches().includes('mousse/checkout-retries'), 'the branch to use the accepted first message', 40_000)
      expect(w.localBranches()).not.toContain('mousse/friday-release')
    } finally { snapshot.resolve() }
  })

  it('keeps the temporary Git branch until a workflow Send accepts its first message', async () => {
    const w = world()
    const draft = w.emptyThread()
    w.d.settings.title = { ...w.d.settings.title, ...PI }
    const oneShot = vi.fn(async () => ({ text: 'workflow-release' }))
    ;(w.d.orch as unknown as { harness: { oneShot: unknown } }).harness.oneShot = oneShot
    const admitted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const run = {
      invocationId: 'fixture-invocation', profileId: 'profile', threadId: draft.id, definitionId: 'definition',
      revisionId: 'revision', runId: 'workflow-run', title: 'Release', state: 'running' as const
    }
    w.d.orch.setWorkflowChatExecutor({
      prepare: async () => { throw new Error('not used') },
      execute: async () => { admitted.resolve(); await release.promise; return run },
      observe: async () => { throw new Error('not used') },
      abandon: () => undefined
    })
    const renaming = vi.spyOn(ThreadWorkspaceManager.prototype, 'renameOwnBranch')
    const send = w.d.orch.send({ content: '/release', mode: 'agent', workflowInvocationId: run.invocationId }, false, { threadId: draft.id, clientRequestId: 'workflow-first' })
    try {
      await admitted.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      await Promise.allSettled(renaming.mock.results.map(({ value }) => value))
      expect(w.d.orch.getMessages(draft.id)).toEqual([])
      expect(w.localBranches()).toContainEqual(expect.stringMatching(/^mousse\/[0-9a-f]{8}$/))
      expect(w.localBranches()).not.toContain('mousse/workflow-release')
      release.resolve()
      await expect(send).resolves.toMatchObject({ workflowRun: run })
      expect(w.d.orch.getMessages(draft.id)).toContainEqual(expect.objectContaining({ role: 'user', workflowInvocationId: run.invocationId }))
      await waitFor(() => w.localBranches().includes('mousse/workflow-release'), 'the accepted workflow branch name', 30_000)
    } finally {
      release.resolve()
      await send.catch(() => undefined)
    }
  })

  it('ignores a naming answer that arrives after Stop reaches a running provider', async () => {
    const reply = Promise.withResolvers<string>()
    const w = world(() => reply.promise)
    const draft = w.emptyThread()
    w.d.settings.title = { ...w.d.settings.title, ...PI }
    const naming = Promise.withResolvers<{ text: string }>()
    const oneShot = vi.fn(() => naming.promise)
    ;(w.d.orch as unknown as { harness: { oneShot: unknown } }).harness.oneShot = oneShot
    const interrupt = vi.spyOn(w.pi, 'interrupt')
    const renaming = vi.spyOn(ThreadWorkspaceManager.prototype, 'renameOwnBranch')
    try {
      await w.d.orch.send('Plan the release for Friday', false, { threadId: draft.id, clientRequestId: 'first', awaitMode: 'ack' })
      await waitFor(() => w.pi.turns.length === 1 && oneShot.mock.calls.length === 1, 'the running provider and naming request', 40_000)
      const before = w.localBranches()
      const stopped = w.d.orch.stopThread(draft.id, 'user', { clientRequestId: 'stop-first' })
      await waitFor(() => interrupt.mock.calls.length > 0, 'Stop to reach the running provider')
      naming.resolve({ text: 'Title: Stale release title\nBranch: stale-release' })
      reply.resolve('Done')
      expect((await stopped).ok).toBe(true)
      await waitFor(() => w.idle(draft.id) && w.d.store.getThread(draft.id)?.titleSource === 'auto', 'the stopped turn and naming to settle')
      expect(w.d.store.getThread(draft.id)?.name).toBe('Plan the release for Friday')
      await Promise.allSettled(renaming.mock.results.map(({ value }) => value))
      expect(w.localBranches()).toEqual(before)
    } finally { naming.resolve({ text: '' }); reply.resolve('Done') }
  })

  it('keeps two threads started one after the other in the order they were sent, during their setup and after it', async () => {
    const w = world()
    const first = w.emptyThread()
    const second = w.emptyThread()
    await w.holdRepository()
    await w.d.orch.send('First', false, { threadId: first.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparingWorktree(first.id), "the first thread's worktree step to show")
    await w.d.orch.send('Second', false, { threadId: second.id, clientRequestId: 'second', awaitMode: 'ack' })
    await waitFor(() => w.preparingWorktree(second.id), "the second thread's worktree step to show")
    const above = () => w.d.store.getThread(second.id)!.order < w.d.store.getThread(first.id)!.order
    expect(w.d.store.getThread(first.id)!.startedAt).toBeTruthy()
    expect(w.d.store.getThread(second.id)!.startedAt).toBeTruthy()
    expect(above()).toBe(true)

    // The first one's setup ends after the second was sent: it does not jump back on top.
    w.freeRepository()
    await waitFor(() => w.pi.turns.length === 2 && w.idle(first.id) && w.idle(second.id), 'both turns to finish', 40_000)
    expect(above()).toBe(true)
  })
})
