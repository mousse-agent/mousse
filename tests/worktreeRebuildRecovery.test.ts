import { afterEach, describe, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'
import { installGitRemoveGuard, type GitRemoveGuard } from './fixtures/gitRemoveGuard'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { StorageCleanupService } from '../src/mms/lifecycle/StorageCleanupService'
import { StoragePolicyStore } from '../src/mms/lifecycle/StoragePolicyStore'
import { StorageSweepClock } from '../src/mms/lifecycle/sweepClock'
import { checkWorktreeFolder, forgetWorktreeFolders, placeAgentWorktreeBase, refreshWorktreeFolders, setWorktreeFolders } from '../src/mms/worktree/worktreeLayout'

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

/**
 * Clearing what an earlier rebuild left is a verified delete: captured, recorded, renamed to a `.deleting-` name and
 * deleted against its proof, and only then unregistered. Git never removes the folder, so a save that lands at any point
 * is kept as a copy the thread owns (`keptAside`), never lost.
 */
describe('clearing what an earlier rebuild left', () => {
  /** The guard launcher: `git worktree remove` of a folder that still exists is refused and recorded. */
  function guard(): GitRemoveGuard {
    const installed = installGitRemoveGuard()
    releases.push(() => installed.restore())
    return installed
  }
  function assertGitRemovedNothing(installed: GitRemoveGuard): void {
    installed.assertNoRemoveOfExisting()
    expect(installed.removes().flatMap((call) => call.args)).not.toContain('--force')
  }
  /** A retired thread whose next rebuild failed after it made the worktree; `a.txt` is then written in what it left. */
  async function halfBuilt(edit = 'edit copied before retry\n') {
    const f = await retiredThread()
    await expect(f.service.reconstruct(f.path, { prepare: () => { throw new Error('crash during rebuild') }, env: {} })).rejects.toThrow('crash during rebuild')
    writeFileSync(join(f.worktree, 'a.txt'), edit)
    return f
  }
  /** The bytes a kept copy holds for `path`, read back from the repository. */
  const keptBytes = (repo: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd: repo })
  /** Every version `keptAside` holds of `path`, oldest first. */
  const keptVersions = (repo: string, manifest: { keptAside?: Array<{ ref: string; paths: string[] }> }, path: string): string[] =>
    (manifest.keptAside ?? []).filter((entry) => entry.paths.includes(path)).map((entry) => keptBytes(repo, entry.ref, path).toString('binary'))
  const deletingFolders = (worktree: string): string[] => readdirSync(dirname(worktree)).filter((name) => /^\.deleting-/.test(name))

  test('a CRLF save that lands while the folder is being deleted comes back from keptAside byte for byte, and the worktree is rebuilt as retained', async () => {
    const f = await halfBuilt()
    const installed = guard()
    const late = Buffer.from('late save before rebuild force-remove 522cae33\r\n')
    let saved = ''
    const rebuilt = await f.service.reconstruct(f.path, undefined, {
      beforeRemove: (path) => {
        // The save lands through the folder's old handle, right before the file's removal: after its last read.
        if (!saved && basename(path) === 'a.txt' && /^\.deleting-[a-f0-9]{16}$/.test(basename(dirname(path)))) { saved = path; writeFileSync(path, late) }
      }
    })
    expect(saved).not.toBe('')
    // Both the edit read at the capture and the late save are kept, each exactly; the worktree is the retained one.
    expect(keptVersions(f.repo, rebuilt, 'a.txt')).toEqual(['edit copied before retry\n', late.toString('binary')])
    const lateCopy = rebuilt.keptAside!.find((entry) => entry.paths.includes('a.txt') && keptBytes(f.repo, entry.ref, 'a.txt').equals(late))!
    const restored = join(f.root, 'restored-a.txt')
    writeFileSync(restored, keptBytes(f.repo, lateCopy.ref, 'a.txt'))
    expect(readFileSync(restored)).toEqual(late)
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
    expect(readFileSync(join(f.worktree, 'b.txt'), 'utf8')).toBe('second\n')
    expect(rebuilt.rebuilding).toBeUndefined()
    // The thread is told, with the command that brings each version back.
    expect(f.service.keptAsideNotice(rebuilt)?.text).toContain('a.txt')
    expect(deletingFolders(f.worktree)).toEqual([])
    assertGitRemovedNothing(installed)
    expect(installed.removes().length).toBeGreaterThan(0)
  })

  test('a rebuild that stops right after the rename carries on from its record: a save into the renamed folder is kept, and the rebuild finishes', async () => {
    const f = await halfBuilt()
    const installed = guard()
    let deleting = ''
    await expect(f.service.reconstruct(f.path, undefined, { afterRename: (path) => { deleting = path; throw new Error('the process stopped') } })).rejects.toThrow('the process stopped')
    expect(existsSync(f.worktree)).toBe(false)
    expect(f.service.load(f.path).rebuilding?.clearing?.deletingPath).toBe(deleting)
    // A process whose working folder was in it saves there.
    const late = Buffer.from('saved into the renamed folder\r\nline two\r\n')
    writeFileSync(join(deleting, 'late.txt'), late)
    const rebuilt = await f.service.reconstruct(f.path)
    expect(keptVersions(f.repo, rebuilt, 'late.txt')).toEqual([late.toString('binary')])
    expect(keptVersions(f.repo, rebuilt, 'a.txt')).toEqual(['edit copied before retry\n'])
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
    expect(existsSync(join(f.worktree, 'late.txt'))).toBe(false)
    expect(existsSync(deleting)).toBe(false)
    assertGitRemovedNothing(installed)
  })

  test('a rebuild that stops between recording the clear and renaming the folder looks at the folder afresh, keeping what was saved there since', async () => {
    const f = await halfBuilt()
    const installed = guard()
    await expect(f.service.reconstruct(f.path, undefined, { afterRecord: () => { throw new Error('the process stopped') } })).rejects.toThrow('the process stopped')
    expect(f.service.load(f.path).rebuilding?.clearing).toBeDefined()
    expect(existsSync(join(f.worktree, '.git'))).toBe(true)
    const late = Buffer.from('saved before the rename\r\n')
    writeFileSync(join(f.worktree, 'a.txt'), late)
    const rebuilt = await f.service.reconstruct(f.path)
    expect(keptVersions(f.repo, rebuilt, 'a.txt')).toEqual(['edit copied before retry\n', late.toString('binary')])
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
    expect(deletingFolders(f.worktree)).toEqual([])
    assertGitRemovedNothing(installed)
  })

  test('writes in three rounds stop the clear: the rebuild refuses naming the folder, keeps every version, and the next one finishes', async () => {
    const f = await halfBuilt()
    const installed = guard()
    let round = 0
    let deleting = ''
    const versions: string[] = []
    const rewrite = (path: string): void => {
      if (basename(path) !== 'a.txt' || !/^\.deleting-/.test(basename(dirname(path)))) return
      deleting = dirname(path)
      const version = `round ${++round}\r\n`
      versions.push(version)
      writeFileSync(path, version)
    }
    const refused = await f.service.reconstruct(f.path, undefined, { beforeRemove: rewrite }).catch((error: unknown) => error as Error)
    expect(refused).toBeInstanceOf(Error)
    expect(refused.message).toMatch(/^The rebuild waits: /)
    expect(refused.message).toContain(deleting)
    expect(round).toBe(3)
    expect(readFileSync(join(deleting, 'a.txt'), 'utf8')).toBe('round 3\r\n')
    expect(existsSync(f.worktree)).toBe(false)
    // Nothing is taken for the worktree meanwhile.
    expect((await f.manager.verify()).lifecycle).not.toBe('ready')
    const rebuilt = await f.service.reconstruct(f.path)
    expect(keptVersions(f.repo, rebuilt, 'a.txt')).toEqual(['edit copied before retry\n', ...versions])
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
    expect(existsSync(deleting)).toBe(false)
    assertGitRemovedNothing(installed)
  })

  test('a version staged after the clear was recorded, with the working file put back, is kept and comes back byte for byte after Git collects its garbage', async () => {
    const f = await halfBuilt()
    const installed = guard()
    const staged = Buffer.from('late staged only 6d9a1\r\n')
    let stagedBlob = ''
    const rebuilt = await f.service.reconstruct(f.path, undefined, { afterRecord: () => {
      writeFileSync(join(f.worktree, 'a.txt'), staged)
      git(f.worktree, ['add', 'a.txt'])
      stagedBlob = git(f.worktree, ['rev-parse', ':a.txt'])
      // The working file goes back to the bytes the capture read: only the index holds the new version.
      writeFileSync(join(f.worktree, 'a.txt'), 'edit copied before retry\n')
    } })
    git(f.repo, ['reflog', 'expire', '--expire=now', '--all'])
    git(f.repo, ['gc', '--prune=now', '-q'])
    expect(execFileSync('git', ['cat-file', 'blob', stagedBlob], { cwd: f.repo })).toEqual(staged)
    // It is one of the versions the thread is told about, and its command's source gives the bytes back.
    expect(keptVersions(f.repo, rebuilt, 'a.txt')).toContain(staged.toString('binary'))
    const copy = rebuilt.keptAside!.find((entry) => entry.paths.includes('a.txt') && keptBytes(f.repo, entry.ref, 'a.txt').equals(staged))!
    const restored = join(f.root, 'restored-staged.txt')
    writeFileSync(restored, keptBytes(f.repo, copy.ref, 'a.txt'))
    expect(readFileSync(restored)).toEqual(staged)
    expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited before retirement\n')
    assertGitRemovedNothing(installed)
  })

  test('Storage never calls what is left of a stopped clear an unused worktree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-rebuild-storage-'))); roots.push(root)
    const repo = join(root, 'shop'); mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
    const home = join(root, 'home'); mkdirSync(home); releases.push(ownedHome(home)); process.env.MOUSSE_HOME = home
    // An agent's worktree in a worktree folder the person chose, beside its repository's other folders.
    const drive = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-rebuild-drive-'))); roots.push(drive)
    const entry = await checkWorktreeFolder(join(drive, 'Worktrees'), home)
    setWorktreeFolders(home, { worktreeFolder: entry, previousWorktreeFolders: [] }); releases.push(() => forgetWorktreeFolders(home))
    await refreshWorktreeFolders()
    const task = join(home, 'thread-data', 'task'); mkdirSync(task, { recursive: true }); writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' }))
    const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location: task })
    registerThreadLifecycleGate(home, store)
    const base = await placeAgentWorktreeBase({ home, folder: entry.path, repositoryId: resolveRepositoryIdentity(repo).key, projectName: 'shop' })
    const worktree = join(base, 'worker'), branch = 'mousse/agent/worker'
    git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
    const sourcePath = join(task, 'agents.json'); writeFileSync(sourcePath, JSON.stringify([{ id: 'worker', worktreePath: worktree, branch }]))
    const taskLease = await waitAcquireExecutionLease(task), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repo))
    releases.push(() => repositoryLease.release(), () => releaseExecutionLeaseHandle(taskLease))
    const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
    const path = service.pathFor('task', worktree)
    writeFileSync(join(worktree, 'a.txt'), 'edited\n')
    await service.prepare({ taskId: 'task', worktreePath: worktree, branch, sourcePath })
    await service.retire(path)
    expect(await service.expireTrash(path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
    await expect(service.reconstruct(path, { prepare: () => { throw new Error('crash during rebuild') }, env: {} })).rejects.toThrow('crash during rebuild')
    const edit = Buffer.from('edit in the half-built folder\r\n')
    writeFileSync(join(worktree, 'a.txt'), edit)
    let deleting = ''
    await expect(service.reconstruct(path, undefined, { beforeRemove: (at) => { if (basename(at) === 'a.txt') { deleting = dirname(at); throw new Error('the process stopped') } } })).rejects.toThrow('the process stopped')
    expect(readFileSync(join(deleting, 'a.txt'))).toEqual(edit)
    const clock = new StorageSweepClock(store.root, Date.now); clock.start()
    const storage = new StorageCleanupService({
      store, threads: { getThread: () => ({ id: 'task', name: 'Task', projectId: 'p' }) as never },
      purge: new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} }).cleanup,
      policy: new StoragePolicyStore(store, clock), clock, idle: () => undefined, installationHome: home, now: Date.now
    })
    const orphans = await (storage as unknown as { orphanItems(): Promise<Array<{ label: string }>> }).orphanItems()
    expect(orphans.map((item) => item.label).filter((label) => label.includes('.deleting-'))).toEqual([])
    // The folder and the copy of the edit are both still there; the copy gives the bytes back.
    expect(readFileSync(join(deleting, 'a.txt'))).toEqual(edit)
    const copies = service.load(path).rebuilding!.clearing!.copies.filter((copy) => copy.paths.includes('a.txt'))
    expect(copies.map((copy) => keptBytes(repo, copy.ref, 'a.txt'))).toContainEqual(edit)
  })

  test('a folder made at the worktree\'s path while the clear runs stops the unregister, and is kept as it is', async () => {
    const f = await halfBuilt()
    const installed = guard()
    const theirs = Buffer.from('someone made a folder here\n')
    const refused = await f.service.reconstruct(f.path, undefined, { afterRename: () => { mkdirSync(f.worktree); writeFileSync(join(f.worktree, 'theirs.txt'), theirs) } }).catch((error: unknown) => error as Error)
    expect(refused.message).toMatch(/^The rebuild waits: /)
    expect(refused.message).toContain(f.worktree)
    expect(readFileSync(join(f.worktree, 'theirs.txt'))).toEqual(theirs)
    // Git still registers the worktree there: only a folder that is gone is unregistered.
    expect(git(f.repo, ['worktree', 'list', '--porcelain'])).toContain(f.worktree)
    // The next rebuild does not take it for what an earlier rebuild left.
    await expect(f.service.reconstruct(f.path)).rejects.toThrow("is not this repository's worktree")
    expect(readFileSync(join(f.worktree, 'theirs.txt'))).toEqual(theirs)
    assertGitRemovedNothing(installed)
  })
})
