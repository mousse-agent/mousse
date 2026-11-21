/**
 * A person's message starts its thread as its turn is admitted, not once the turn's worktree and snapshot are set up:
 * a new chat's empty thread (as New thread makes it) is listed started, on top of its project, while its first turn
 * still waits for its worktree. Before, it stayed an unstarted draft for that whole wait: its row did not open, and
 * New thread opened it again instead of a fresh one. Real orchestrator, Run Engine and Git; the test holds the
 * project's repository, as another operation would, so the worktree step lasts as long as the test wants.
 * Rows: one empty thread sent; two sent one after the other (their order, during the setup and after it).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { findUnstartedThread } from '../../src/shared/threadTitle'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

describe("a new chat's thread while its first turn is set up", () => {
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
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
  })

  const world = () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-started-at-admission-'))
    previousHome = process.env.MOUSSE_HOME
    process.env.MOUSSE_HOME = home
    const projectDir = join(home, 'project')
    mkdirSync(projectDir)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
    git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test')
    writeFileSync(join(projectDir, 'README.md'), 'hello\n'); git('add', '.'); git('commit', '-qm', 'init')
    const pi = piAdapter(() => 'Done')
    const d = (daemon = phase6Daemon(home, [pi]))
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
    return { d, pi, project, emptyThread, listed, holdRepository, freeRepository, preparingWorktree, idle }
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
