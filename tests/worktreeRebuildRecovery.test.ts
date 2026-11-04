import { afterEach, expect, test, vi } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'

/**
 * A rebuild of a retired worktree that fails, or is cut off by the process stopping, after it made the worktree. Nothing
 * it left is ever taken for the worktree, and no version written there meanwhile is lost: a staged version included.
 */

const roots: string[] = []
const releases: Array<() => unknown> = []
const previousHome = process.env.MOUSSE_HOME
if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 })
afterEach(() => {
  for (const release of releases.splice(0)) release()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A thread with a worktree holding an uncommitted edit, retired, and its trash expired: only the pins and proof are left. */
async function retiredThread() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-rebuild-'))); roots.push(root)
  const repo = join(root, 'shop'); mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); writeFileSync(join(repo, 'b.txt'), 'second\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
  const home = join(root, 'home'); mkdirSync(home); releases.push(ownedHome(home))
  process.env.MOUSSE_HOME = home
  const location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const manager = new ThreadWorkspaceManager(location)
  const metadata = await manager.provision('task', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Rebuild me' })
  writeFileSync(join(metadata.worktreePath, 'a.txt'), 'edited before retirement\n')
  const taskLease = await waitAcquireExecutionLease(location), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repo))
  let leased = true
  const release = () => { if (leased) { leased = false; repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) } }
  releases.push(release)
  const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
  const path = service.pathFor('task', metadata.worktreePath)
  await service.prepare({ taskId: 'task', worktreePath: metadata.worktreePath, branch: metadata.branch, sourcePath: manager.workspacePath })
  await service.retire(path)
  expect(await service.expireTrash(path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  return { root, repo, home, location, store, manager, metadata, worktree: metadata.worktreePath, service, path, release }
}

const partials = (worktree: string): string[] => readdirSync(dirname(worktree)).filter((name) => name.includes('.partial-'))

test('a version staged in the worktree while it is rebuilt survives the rebuild failing, Git collecting its garbage, and the next rebuild', async () => {
  const f = await retiredThread()
  const staged = 'late staged bytes never committed\n'
  let blob = ''
  // During the rebuild, someone stages a version and writes another; then the repository's settings change, so the
  // rebuild refuses to check out.
  await expect(f.service.reconstruct(f.path, { prepare: (path) => {
    writeFileSync(join(path, 'a.txt'), staged); git(path, ['add', 'a.txt']); blob = git(path, ['rev-parse', ':a.txt'])
    writeFileSync(join(path, 'a.txt'), 'late working version\n')
    git(path, ['config', 'core.autocrlf', 'true'])
  }, env: {} })).rejects.toThrow('Checkout conversion policy changed')
  git(f.repo, ['gc', '--prune=now', '-q'])
  expect(git(f.repo, ['cat-file', '-p', blob])).toBe(staged.trimEnd())
  // The folder it left is not the worktree.
  expect((await f.manager.verify()).lifecycle).not.toBe('ready')
  // The settings go back; the next use keeps both versions in a copy owned by the thread, then rebuilds.
  git(f.repo, ['config', '--unset', 'core.autocrlf'])
  const rebuilt = await f.service.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
  const kept = rebuilt.keptAside!.find((entry) => entry.paths.includes('a.txt'))!
  expect(kept.ref.startsWith('refs/mousse/preserved/')).toBe(true)
  git(f.repo, ['gc', '--prune=now', '-q'])
  expect(git(f.repo, ['cat-file', '-p', `${kept.ref}^2:a.txt`])).toBe(staged.trimEnd())
  expect(git(f.repo, ['cat-file', '-p', `${kept.ref}:a.txt`])).toBe('late working version')
  expect(partials(f.worktree)).toEqual([])
})

test('a rebuild cut off after it made the worktree is never taken as ready: the next use rebuilds it whole', async () => {
  const f = await retiredThread()
  // The process stops right after Git made the worktree (simulated by a failure at that point, which leaves the same).
  await expect(f.service.reconstruct(f.path, { prepare: () => { throw new Error('the process stopped') }, env: {} })).rejects.toThrow('the process stopped')
  expect(existsSync(join(f.worktree, '.git'))).toBe(true)
  expect(existsSync(join(f.worktree, 'a.txt'))).toBe(false)
  expect((await f.manager.verify()).lifecycle).not.toBe('ready')
  f.release()
  // The thread is used again: the half-built folder is replaced by the worktree, with the edit.
  const context = await new WorkspaceResolver(f.location, 'task', f.repo, 'worktree').resolve('agent')
  expect(context.lifecycle).toBe('ready')
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
  expect(readFileSync(join(f.worktree, 'b.txt'), 'utf8')).toBe('second\n')
  expect(git(f.worktree, ['status', '--porcelain'])).toBe(' M a.txt')
  expect(partials(f.worktree)).toEqual([])
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a rebuild that fails where its folder can not be changed leaves nothing taken as ready, and finishes once it can', async () => {
  const f = await retiredThread()
  const parent = dirname(f.worktree), mode = lstatSync(parent).mode & 0o777
  try {
    await expect(f.service.reconstruct(f.path, { prepare: () => { chmodSync(parent, 0o555); throw new Error('checkout failed') }, env: {} })).rejects.toThrow('checkout failed')
  } finally { chmodSync(parent, mode) }
  expect(existsSync(f.worktree)).toBe(true)
  expect(existsSync(join(f.worktree, 'a.txt'))).toBe(false)
  expect((await f.manager.verify()).lifecycle).not.toBe('ready')
  f.release()
  const context = await new WorkspaceResolver(f.location, 'task', f.repo, 'worktree').resolve('agent')
  expect(context.lifecycle).toBe('ready')
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
})

test('a rebuild that fails again and again leaves no copies of the worktree behind', async () => {
  const f = await retiredThread()
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(f.service.reconstruct(f.path, { prepare: () => { throw new Error(`failure ${attempt}`) }, env: {} })).rejects.toThrow(`failure ${attempt}`)
  }
  expect(partials(f.worktree)).toEqual([])
  expect(readdirSync(dirname(f.worktree)).filter((name) => name !== '.mousse-repository.json')).toEqual([f.worktree.slice(dirname(f.worktree).length + 1)])
  // Nothing differed from the proof, so nothing was copied.
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/'])).toBe('')
  await f.service.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
})
