import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as gitProcess from '../src/mms/git/runGitProcess'
import * as lifecycleGit from '../src/mms/lifecycle/lifecycleGit'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

it('does not dereference a user branch substituted after the irreversible purge boundary', async () => {
  const f = gitFoundationFixture()
  try {
    const location = join(f.home, 'thread-data', 'task')
    mkdirSync(location, { recursive: true })
    writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
    writeFileSync(join(location, 'messages.json'), '[]')
    const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
    store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
    const workspace = await new ThreadWorkspaceManager(location).provision('task', 'main', f.repo)
    const primary = git(f.repo, 'symbolic-ref', 'HEAD'), head = git(f.repo, 'rev-parse', primary)
    let replaced = false
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {},
      projectIndex: () => {}, projectPurged: () => {}, onPhase: (record, phase) => {
        if (phase === 'purge-started' && !replaced) {
          expect(record.purge?.items.some((item) => item.kind === 'ref' && item.identity === workspace.retainedRef)).toBe(true)
          git(f.repo, 'symbolic-ref', workspace.retainedRef, primary)
          replaced = true
        }
      } })
    await coordinator.trash({ taskId: 'task', operationId: 'qualification-trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    await expect(coordinator.purge({ taskId: 'task', operationId: 'qualification-purge', expectedGeneration: preview.generation, previewDigest: preview.digest }))
      .rejects.toThrow(/symbolic|reference/i)
    expect(replaced).toBe(true)
    expect(git(f.repo, 'rev-parse', primary)).toBe(head)
    expect(store.require('task').state).toBe('purge-started')
    expect(existsSync(store.require('task').location)).toBe(true)
    await expect(coordinator.restore({ taskId: 'task', operationId: 'qualification-restore' })).rejects.toThrow(/purge-started/)
  } finally { f.dispose() }
}, process.platform === 'win32' ? 60_000 : 30_000)

async function branchPurgeFixture() {
  const f = gitFoundationFixture()
  try {
    const location = join(f.home, 'thread-data', 'task')
    mkdirSync(location, { recursive: true })
    writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
    const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
    store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
    const made = await new ThreadWorkspaceManager(location).provision('task', 'main', f.repo)
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
    return { f, made, coordinator }
  } catch (error) {
    f.dispose()
    throw error
  }
}

it('permanent purge keeps a user-recreated branch at the same commit before preview', async () => {
  const { f, made, coordinator } = await branchPurgeFixture()
  try {
    const ref = 'refs/heads/' + made.branch
    git(made.worktreePath, 'switch', '--detach')
    git(f.repo, 'branch', '-D', made.branch)
    git(f.repo, 'branch', made.branch, made.headSha)
    git(made.worktreePath, 'switch', made.branch)

    await coordinator.trash({ taskId: 'task', operationId: 'branch-trash' })
    const preview = await coordinator.cleanup.preview('task')
    const result = await coordinator.purge({ taskId: 'task', operationId: 'branch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(result.state).toBe('purged')
    expect(existsSync(made.worktreePath)).toBe(false)
    expect(git(f.repo, 'rev-parse', ref)).toBe(made.headSha)
  } finally { f.dispose() }
}, 120_000)

it('permanent purge repairs a checkout that switches after the locked worktree scan', async () => {
  const { f, made, coordinator } = await branchPurgeFixture()
  const ref = 'refs/heads/' + made.branch
  const other = f.child('other')
  const run = gitProcess.runGitProcess
  let switched = false
  const scan = vi.spyOn(gitProcess, 'runGitProcess').mockImplementation(async (argv, options) => {
    const result = await run(argv, options)
    if (!switched && result.status === 0 && argv.includes('worktree') && argv.includes('list') &&
      existsSync(join(f.repo, '.git', ref + '.lock'))) {
      expect(result.stdout.split('\0')).not.toContain(`branch ${ref}`)
      git(other, 'switch', made.branch)
      switched = true
    }
    return result
  })
  try {
    await coordinator.trash({ taskId: 'task', operationId: 'branch-trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.items).toContainEqual(expect.objectContaining({ kind: 'ref', identity: ref }))
    const result = await coordinator.purge({ taskId: 'task', operationId: 'branch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(result.state).toBe('purged')
    expect(existsSync(made.worktreePath)).toBe(false)
    expect(switched).toBe(true)
    expect(git(f.repo, 'rev-parse', '--verify', ref)).toBe(made.headSha)
    expect(git(other, 'symbolic-ref', 'HEAD')).toBe(ref)
    expect(git(other, 'rev-parse', '--verify', 'HEAD')).toBe(made.headSha)
  } finally {
    scan.mockRestore()
    f.dispose()
  }
}, 120_000)

it('permanent purge keeps a branch checked out elsewhere after Git locks the ref for deletion', async () => {
  const { f, made, coordinator } = await branchPurgeFixture()
  const ref = 'refs/heads/' + made.branch
  const other = f.child('other')
  const deleteVerified = lifecycleGit.deleteVerifiedBranchAsync
  const deletion = vi.spyOn(lifecycleGit, 'deleteVerifiedBranchAsync').mockImplementation((cwd, branchRef, sha, verify) =>
    deleteVerified(cwd, branchRef, sha, () => {
      expect(branchRef).toBe(ref)
      expect(existsSync(join(f.repo, '.git', ref + '.lock'))).toBe(true)
      git(other, 'switch', made.branch)
      return verify()
    }))
  try {
    await coordinator.trash({ taskId: 'task', operationId: 'branch-trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.items).toContainEqual(expect.objectContaining({ kind: 'ref', identity: ref }))
    const result = await coordinator.purge({ taskId: 'task', operationId: 'branch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(result.state).toBe('purged')
    expect(existsSync(made.worktreePath)).toBe(false)
    expect(git(other, 'symbolic-ref', 'HEAD')).toBe(ref)
    expect(git(other, 'rev-parse', 'HEAD')).toBe(made.headSha)
  } finally {
    deletion.mockRestore()
    f.dispose()
  }
}, 120_000)
