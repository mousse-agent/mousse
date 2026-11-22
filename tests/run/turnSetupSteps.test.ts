/**
 * While a turn is still being set up (its worktree made or checked, its snapshot taken), the line under Working names
 * that step instead of "Starting…": the thread's turn state is `queued` with a `preparing` step once the step has
 * taken a moment. Real orchestrator, Run Engine and Git; the test holds the project's repository, as another
 * operation would, so a step lasts as long as the test wants. Rows: a new thread's worktree (it then starts as usual),
 * a Stop during it, a worktree that then cannot be made, and an existing thread's next turn, which has no step to wait for.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireRepositoryLease, type RepositoryLeaseHandle } from '../../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import { defaultThreadWorktreePath } from '../../src/mms/worktree/worktreeLayout'
import type { TurnState } from '../../src/shared/types'
import { PI, phase6Daemon, piAdapter, waitFor, type Phase6Daemon } from './phase6Fixture'

vi.setConfig({ testTimeout: 60_000 })

describe('the line under Working names a slow setup step', () => {
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
    home = mkdtempSync(join(tmpdir(), 'mousse-setup-steps-'))
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
    const thread = () => {
      const made = d.store.createThread('Steps', project.id)
      d.orch.setThreadModelOverride(made.id, PI)
      return made
    }
    const states: TurnState[] = []
    d.orch.on('turn-state', (state: TurnState) => states.push(state))
    const holdRepository = async () => { held = await acquireRepositoryLease(resolveRepositoryIdentity(projectDir)) }
    const freeRepository = () => { held?.release(); held = undefined }
    const preparing = (threadId: string, what: string) => {
      const state = d.orch.getTurnState(threadId)
      return state.phase === 'queued' && state.step?.kind === 'preparing' && state.step.what === what
    }
    return { d, pi, projectDir, home: home!, thread, states, holdRepository, freeRepository, preparing }
  }

  it("names the worktree being made while a new thread's start waits for it, then starts the turn as usual", async () => {
    const w = world()
    const thread = w.thread()
    await w.holdRepository()
    const sent = await w.d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparing(thread.id, 'worktree'), 'the worktree step to show')
    expect(w.pi.turns).toHaveLength(0)
    // It is the turn that then starts: the same id, so its Working timer goes on.
    expect(w.d.orch.getTurnState(thread.id).turnId).toBe(sent.runId)

    w.freeRepository()
    await waitFor(() => w.pi.turns.length === 1 && !w.d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the turn to finish', 40_000)
    const mine = w.states.filter((state) => state.threadId === thread.id)
    const shown = mine.findIndex((state) => state.step?.kind === 'preparing')
    const started = mine.findIndex((state) => state.phase === 'thinking' && state.step?.kind === 'starting')
    expect(shown).toBeGreaterThanOrEqual(0)
    expect(started).toBeGreaterThan(shown)
    expect(mine[started]!.turnId).toBe(sent.runId)
    expect(w.d.orch.getTurnState(thread.id).step).toBeUndefined()
  })

  it('leaves no setup step behind when a Stop ends the start', async () => {
    const w = world()
    const thread = w.thread()
    await w.holdRepository()
    await w.d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparing(thread.id, 'worktree'), 'the worktree step to show')
    await w.d.orch.stopThread(thread.id, 'user')
    await waitFor(() => !w.d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the stopped start to end')
    const state = w.d.orch.getTurnState(thread.id)
    expect(state.step).toBeUndefined()
    expect(state.phase === 'idle' || state.phase === 'stopped').toBe(true)
    expect(w.pi.turns).toHaveLength(0)
  })

  it("still shows why when the worktree can't be made after its step showed", async () => {
    const w = world()
    const thread = w.thread()
    // Something already at the worktree's place, so `git worktree add` refuses it once the repository is free.
    const place = defaultThreadWorktreePath(w.home, resolveRepositoryIdentity(w.projectDir).key, thread.id, 'main')
    mkdirSync(join(place, '..'), { recursive: true })
    writeFileSync(place, 'in the way\n')
    await w.holdRepository()
    await w.d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.preparing(thread.id, 'worktree'), 'the worktree step to show')
    w.freeRepository()
    await waitFor(() => Boolean(w.d.store.getThread(thread.id)?.setupFailure), 'the failure to be recorded', 20_000)
    await waitFor(() => !w.d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the failed start to end')
    expect(w.d.orch.getTurnState(thread.id)).toMatchObject({ phase: 'failed' })
    expect(w.d.orch.getTurnState(thread.id).step).toBeUndefined()
  })

  it("an existing thread's next turn in its own worktree reaches the agent while the repository is held: no snapshot comes first", async () => {
    const w = world()
    const thread = w.thread()
    await w.d.orch.send('Hello', false, { threadId: thread.id, clientRequestId: 'first', awaitMode: 'ack' })
    await waitFor(() => w.pi.turns.length === 1 && !w.d.orch.getOrCreateSession(thread.id).isTurnRunning(), 'the first turn to finish', 40_000)

    await w.holdRepository()
    await w.d.orch.send('Again', false, { threadId: thread.id, clientRequestId: 'second', awaitMode: 'ack' })
    await waitFor(() => w.pi.turns.length === 2, 'the second turn to reach the agent', 40_000)
    expect(w.pi.turns[1]!.prompt).toMatch(/Again$/)
    expect(w.states.some((state) => state.threadId === thread.id && state.step?.kind === 'preparing' && state.step.what === 'snapshot')).toBe(false)
    // Its end still records the turn, once the repository is free.
    w.freeRepository()
  })
})
