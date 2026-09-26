import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { lifecycleGit, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'

async function fixture() {
  const f = gitFoundationFixture()
  writeFileSync(join(f.repo, '.gitattributes'), 'value.txt text eol=crlf\n')
  writeFileSync(join(f.repo, 'value.txt'), 'first\nsecond\n')
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'explicit checkout line endings')
  const branch = 'mousse/agent/qualified-worker', worktree = join(f.root, 'owned-worker')
  git(f.repo, 'worktree', 'add', '-q', '-b', branch, worktree)
  const location = join(f.home, 'thread-data', 'task')
  mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
  const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
  store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(f.home, store)
  const sourcePath = join(location, 'agents.json')
  writeFileSync(sourcePath, JSON.stringify([{ id: 'qualified-worker', worktreePath: worktree, branch }]))
  const taskLease = await waitAcquireExecutionLease(location)
  const repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
  const ownership = { taskLease, repositoryLease }
  return { ...f, worktree, store, ownership, service: new WorktreeRetirementService(store, ownership),
    dispose() { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease); f.dispose() },
    input: { taskId: 'task', worktreePath: worktree, branch, sourcePath } }
}

it('retains Git-clean mixed line endings that checkout cannot reconstruct byte for byte', async () => {
  const f = await fixture()
  try {
    const path = join(f.worktree, 'value.txt')
    const soleCopy = Buffer.from('first\r\nsecond\n')
    writeFileSync(path, soleCopy)
    // Refresh the index stat cache through an ordinary user staging operation;
    // the normalized blob remains identical to HEAD and creates no staged diff.
    git(f.worktree, 'add', 'value.txt')
    expect(git(f.worktree, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(f.worktree, 'status', '--porcelain')).toBe('')
    expect(lifecycleGit(f.worktree, ['hash-object', '--stdin-paths'], JSON.stringify(path.replaceAll('\\', '/')) + '\n'))
      .toBe(git(f.worktree, 'rev-parse', 'HEAD:value.txt'))
    expect(() => f.service.prepare(f.input), 'Clean-filter equivalence cannot authorize loss of the original materialized bytes').toThrow(/reconstruct.*exact|materialized/i)
    expect(readFileSync(path)).toEqual(soleCopy)
  } finally { f.dispose() }
})

it('retires canonical CRLF materialization and reconstructs exactly the same bytes after service restart', async () => {
  const f = await fixture()
  try {
    const original = readFileSync(join(f.worktree, 'value.txt'))
    expect(original).toEqual(Buffer.from('first\r\nsecond\r\n'))
    const primaryHead = git(f.repo, 'rev-parse', 'HEAD')
    f.service.prepare(f.input)
    const manifestPath = f.service.pathFor('task', f.worktree)
    f.service.retire(manifestPath)
    expect(existsSync(f.worktree)).toBe(false)
    const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home }), f.ownership)
    restarted.reconstruct(manifestPath)
    expect(readFileSync(join(f.worktree, 'value.txt'))).toEqual(original)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(primaryHead)
  } finally { f.dispose() }
})

it('refuses a reconstruction pin redirected to a primary branch before updating retained results', async () => {
  const f = await fixture()
  try {
    const manifest = f.service.prepare(f.input)
    const primary = git(f.repo, 'symbolic-ref', 'HEAD'), original = git(f.repo, 'rev-parse', primary)
    writeFileSync(join(f.worktree, 'value.txt'), 'new child result\r\n')
    git(f.worktree, 'add', 'value.txt'); git(f.worktree, 'commit', '-qm', 'new child result')
    git(f.repo, 'symbolic-ref', manifest.resultRef, primary)
    expect(() => f.service.prepare(f.input)).toThrow(/symbolic|pin|reference/i)
    expect(git(f.repo, 'rev-parse', primary)).toBe(original)
    expect(git(f.repo, 'symbolic-ref', manifest.resultRef)).toBe(primary)
  } finally { f.dispose() }
})
