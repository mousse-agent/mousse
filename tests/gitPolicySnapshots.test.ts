import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PublishService } from '../src/mms/actions/PublishService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { takeSnapshot } from '../src/mms/actions/snapshots'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { onGitPolicyEntry, userAction, withUserRequest, type GitPolicyEntry } from '../src/mms/git/gitPolicy'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { releaseExecutionLeaseHandle, waitAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, gitFoundationFixture } from './fixtures/gitFoundation'

/**
 * The central Git check refuses, and every decision it makes is recorded: a turn snapshot, Undo, Publish, retirement
 * and trash expiry must not need anything they are not allowed. Undo and Publish run under the user's request, as
 * their protocol handlers do; snapshots, retirement and expiry run under none.
 */
const plain = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let f: ReturnType<typeof gitFoundationFixture>
let entries: GitPolicyEntry[]
let stop: () => void
const previousMode = process.env.MOUSSE_GIT_POLICY
beforeEach(() => {
  f = gitFoundationFixture()
  entries = []
  stop = onGitPolicyEntry((entry) => entries.push(entry))
})
afterEach(() => {
  stop()
  if (previousMode === undefined) delete process.env.MOUSSE_GIT_POLICY
  else process.env.MOUSSE_GIT_POLICY = previousMode
  f.dispose()
})
const refuse = () => { process.env.MOUSSE_GIT_POLICY = 'refuse' }
const violations = () => entries.filter((entry) => entry.kind === 'violation').map((entry) => `${entry.command} (${entry.decision.reason})`)
const turn = (actions: ThreadActionService, cwd: string, id: string, mutate: () => void, start = 0) =>
  actions.runCheckpointedAction({ ...actionOptions(cwd, id), presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)

describe('under MOUSSE_GIT_POLICY=refuse', () => {
  it('an owned linked worktree: turn snapshots, Undo and Publish into the primary need nothing they are not allowed', async () => {
    const cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
    refuse()
    const actions = new ThreadActionService(f.thread)
    await turn(actions, cwd, 'one', () => writeFileSync(join(cwd, 'value.txt'), 'one\n'))
    await turn(actions, cwd, 'two', () => writeFileSync(join(cwd, 'two.txt'), 'two\n'), 2)
    await withUserRequest(userAction('button', 'Undo'), () => new UndoService(f.thread).undoLatest('main', cwd))
    const published = await withUserRequest(userAction('button', 'Publish'), () =>
      new PublishService(f.thread).publish(cwd, f.repo, plain(f.repo, 'branch', '--show-current')))
    expect(published.state).toBe('completed')
    expect(plain(f.repo, 'show', 'HEAD:value.txt')).toBe('one')
    expect(violations()).toEqual([])
  })

  it('the primary checkout: a turn snapshot needs no request, and Undo runs under the user’s', async () => {
    refuse()
    const actions = new ThreadActionService(f.thread)
    const snapshot = takeSnapshot(f.repo, { reason: 'primary' })
    expect(snapshot.sha).toMatch(/^[0-9a-f]{40}$/)
    await turn(actions, f.repo, 'one', () => writeFileSync(join(f.repo, 'value.txt'), 'one\n'))
    await withUserRequest(userAction('button', 'Undo'), () => new UndoService(f.thread).undoLatest('main', f.repo))
    expect(f.read(f.repo)).toBe('base\n')
    expect(violations()).toEqual([])
  })

  it('an owned linked worktree: retirement into the trash, trash expiry and a restore need nothing they are not allowed', async () => {
    // A thread record and an agent worktree as the lifecycle store knows them, made with plain Git before refusal is on.
    const profile = join(f.home, 'profile'), task = join(profile, 'thread-data', 'task')
    mkdirSync(task, { recursive: true }); writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' }))
    const store = new ResourceLifecycleStore({ profileId: 'p', profileHome: profile }); store.registerTask({ taskId: 'task', location: task })
    const worktree = join(profile, 'repositories', resolveRepositoryIdentity(f.repo).key, 'worktrees', 'agents', 'worker'), branch = 'mousse/agent/worker'
    mkdirSync(join(worktree, '..'), { recursive: true })
    plain(f.repo, 'worktree', 'add', '-q', '-b', branch, worktree)
    const sourcePath = join(task, 'agents.json'); writeFileSync(sourcePath, JSON.stringify([{ id: 'worker', worktreePath: worktree, branch }]))
    registerThreadLifecycleGate(profile, store)
    const taskLease = await waitAcquireExecutionLease(task), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
    try {
      refuse()
      const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
      writeFileSync(join(worktree, 'uncommitted.txt'), 'kept\n')
      service.prepare({ taskId: 'task', worktreePath: worktree, branch, sourcePath })
      const path = service.pathFor('task', worktree)
      const trashed = service.retire(path)
      expect(existsSync(trashed.trashPath!)).toBe(true)
      expect(service.expireTrash(path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
      service.reconstruct(path)
      expect(f.read(worktree, 'uncommitted.txt')).toBe('kept\n')
      expect(violations()).toEqual([])
    } finally { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) }
  })
})
