import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { releaseExecutionLeaseHandle, waitAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

test('an activated historical conversation fork retires and reconstructs at its original provisioned checkout, its uncommitted code kept in a snapshot', async () => {
  const f = gitFoundationFixture()
  try {
    const directory = join(f.home, 'thread-data', 'task')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'meta.json'), JSON.stringify({ id: 'task' }))
    const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home })
    store.registerTask({ taskId: 'task', location: directory })
    registerThreadLifecycleGate(f.home, store)
    const manager = new ThreadWorkspaceManager(directory)
    const original = await manager.provision('task', 'main', f.repo)
    const actions = new ThreadActionService(directory)
    const { action: forkPoint } = await actions.runCheckpointedAction(actionOptions(original.worktreePath, 'first-turn'), () => {
      writeFileSync(join(original.worktreePath, 'value.txt'), 'historical fork result\n')
    })
    await actions.runCheckpointedAction(actionOptions(original.worktreePath, 'later-turn'), () => {
      writeFileSync(join(original.worktreePath, 'value.txt'), 'later main result\n')
    })
    const branches = new ConversationBranchService(directory)
    const fork = await branches.fork(original.worktreePath, 'main', forkPoint.id, 'Historical alternative')
    await branches.activate(original.worktreePath, fork.id)
    // Activating a fork switches the files only: the checkout stays on the thread's own Git branch.
    expect(manager.load()!.worktreePath).toBe(original.worktreePath)
    expect(manager.load()!.branch).toBe(original.branch)
    expect(manager.load()!.conversationBranchId).toBe(fork.id)
    expect(f.read(original.worktreePath)).toBe('historical fork result\n')
    // The fork's code is uncommitted files: retiring keeps them in a snapshot and the HEAD they were taken on.
    const head = git(original.worktreePath, 'rev-parse', 'HEAD')
    await actions.recordOutsideChanges({ threadId: 'task', conversationBranchId: fork.id, workspacePath: original.worktreePath })
    const selected = manager.load()!
    expect(selected.headSha).toBe(head)
    const taskLease = await waitAcquireExecutionLease(directory)
    const repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
    try {
      const retirement = new WorktreeRetirementService(store, { taskLease, repositoryLease })
      const input = { taskId: 'task', worktreePath: selected.worktreePath,
        branch: selected.branch, sourcePath: manager.workspacePath, baseSha: selected.baseSha, resultSha: selected.headSha }
      const journal = new ThreadJournal(directory, { readOnly: true })
      // The checkout is the thread's own: without the provisioning record that says so, it is retained.
      const authority = journal.list().find((entry) => entry.operationType === 'workspace-provision' && entry.state === 'planned')!
      expect(authority).toBeDefined()
      const path = join(journal.directory, `${String(authority.sequence).padStart(16, '0')}.json`)
      renameSync(path, path + '.withheld')
      try {
        expect(() => retirement.prepare(input)).toThrow(/Known source/)
        expect(f.read(selected.worktreePath)).toBe('historical fork result\n')
      } finally { renameSync(path + '.withheld', path) }
      const manifest = retirement.prepare(input)
      expect(manifest.branch).toBe(original.branch)
      expect(manifest).toMatchObject({ resultSha: head, snapshotSha: expect.stringMatching(/^[0-9a-f]{40}$/) })
      retirement.retire(retirement.pathFor('task', selected.worktreePath))
      expect(existsSync(selected.worktreePath)).toBe(false)
    } finally { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) }
    const restored = await new ThreadWorkspaceManager(directory).restore(f.repo)
    expect(restored.lifecycle).toBe('ready')
    expect(restored.worktreePath).toBe(original.worktreePath)
    expect(restored.branch).toBe(original.branch)
    expect(restored.conversationBranchId).toBe(fork.id)
    expect(git(restored.worktreePath, 'rev-parse', 'HEAD')).toBe(head)
    expect(f.read(restored.worktreePath)).toBe('historical fork result\n')
    expect(git(restored.worktreePath, 'status', '--porcelain')).toBe('M value.txt')
    expect(f.read(f.repo)).toBe('base\n')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  } finally { f.dispose() }
}, 30_000)
