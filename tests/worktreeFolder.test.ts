import { afterEach, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { assertGitAllowed, decideGitCommand, GitPolicyError, gitPolicyMode } from '../src/mms/git/gitPolicy'
import { repoProgramSettings } from '../src/mms/git/repoPrograms'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import {
  checkWorktreeFolder, chosenWorktreeFolder, disconnectedWorktreeFolder, DriveNotConnectedError, forgetWorktreeFolders, ignoresFileModes,
  isAgentWorktreePlace, isThreadWorktreePlace, placeAgentWorktreeBase, placeThreadWorktree, probeFileModes, setWorktreeFolders, trashRootFor,
  waitForWorktreeFolder, WORKTREE_TRASH_FOLDER, WorktreeFolderRefused
} from '../src/mms/worktree/worktreeLayout'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'

const roots: string[] = []
const releases: Array<() => unknown> = []
const homes: string[] = []
const previousHome = process.env.MOUSSE_HOME
if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 })
afterEach(() => {
  for (const release of releases.splice(0)) release()
  for (const home of homes.splice(0)) forgetWorktreeFolders(home)
  if (previousHome === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previousHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root)
  return root
}

/**
 * A repository `shop`, a Mousse home, and a worktree folder on "another drive": a temporary folder in a separate tree,
 * nowhere near the home, as a folder on an external drive is.
 */
function fixture() {
  const root = scratch('mousse-wtfolder-')
  const repo = join(root, 'shop'); mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(repo, 'run.sh'), 0o755)
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
  const home = join(root, 'home'); mkdirSync(home); releases.push(ownedHome(home))
  process.env.MOUSSE_HOME = home
  const other = scratch('mousse-other-drive-')
  const folder = join(other, 'Worktrees'); mkdirSync(folder)
  const key = resolveRepositoryIdentity(repo).key
  const choose = (current: string | null, previous: string[] = []) => { homes.push(home); setWorktreeFolders(home, { worktreeFolder: current, previousWorktreeFolders: previous }) }
  const thread = (id: string) => { const directory = join(home, 'thread-data', id); mkdirSync(directory, { recursive: true }); return directory }
  return { root, repo, home, other, folder, key, choose, thread }
}

// ---- Where a new worktree goes ----

test('a new thread worktree goes to <folder>/<project>-<short key>/<slug>, a taken name gets a short suffix, and agents go to agents/<id>', async () => {
  const f = fixture()
  const place = (threadId: string, branch: string) => placeThreadWorktree({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop', threadId, conversationBranchId: 'main', branch })
  const first = await place('7f3a9c2e-0000-4000-8000-000000000001', 'mousse/fix-prices')
  expect(first).toEqual({ path: join(f.folder, `shop-${f.key.slice(0, 12)}`, 'fix-prices'), folder: f.folder })
  mkdirSync(first.path)
  const second = await place('b41c55aa-0000-4000-8000-000000000002', 'mousse/fix-prices')
  expect(second.path).toBe(join(f.folder, `shop-${f.key.slice(0, 12)}`, 'fix-prices-b41c55'))
  // The repository keeps its folder when the project is renamed: it is found by its key.
  const renamed = await placeThreadWorktree({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'Shop (new name)', threadId: 'c', conversationBranchId: 'main', branch: 'mousse/other' })
  expect(dirname(renamed.path)).toBe(join(f.folder, `shop-${f.key.slice(0, 12)}`))
  expect(await placeAgentWorktreeBase({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop' })).toBe(join(f.folder, `shop-${f.key.slice(0, 12)}`, 'agents'))
  // Without a chosen folder, Mousse's own, as before.
  expect((await placeThreadWorktree({ home: f.home, repositoryId: f.key, projectName: 'shop', threadId: 't', conversationBranchId: 'main', branch: 'mousse/x' })).path)
    .toBe(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 't', 'main'))
  f.choose(f.folder)
  expect(isThreadWorktreePlace(first.path, { home: f.home, repositoryId: f.key, threadId: 'any' })).toBe(true)
  expect(isThreadWorktreePlace(join(f.folder, 'someone-else', 'fix-prices'), { home: f.home, repositoryId: f.key, threadId: 'any' })).toBe(false)
  expect(isAgentWorktreePlace(join(f.folder, `shop-${f.key.slice(0, 12)}`, 'agents', 'worker'), { home: f.home, repositoryId: f.key, agentId: 'worker' })).toBe(true)
  expect(trashRootFor(first.path, f.home)).toBe(join(f.folder, WORKTREE_TRASH_FOLDER))
  expect(trashRootFor(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 't', 'main'), f.home)).toBe(join(f.home, 'trash'))
})

test('a thread provisioned with a chosen folder works there; after the setting changes, new threads use the new folder and earlier worktrees stay put', async () => {
  const f = fixture()
  f.choose(f.folder)
  const one = new ThreadWorkspaceManager(f.thread('thread-one'))
  expect(chosenWorktreeFolder(one.threadDirectory)).toBe(f.folder)
  const first = await one.provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Fix the prices page' })
  expect(first.worktreePath).toBe(join(f.folder, `shop-${f.key.slice(0, 12)}`, 'fix-the-prices-page'))
  expect(git(first.worktreePath, ['branch', '--show-current'])).toBe('mousse/fix-the-prices-page')
  expect((await one.verify(first)).lifecycle).toBe('ready')
  expect(readFileSync(join(first.worktreePath, 'a.txt'), 'utf8')).toBe('first\n')

  const second = join(f.other, 'Elsewhere'); mkdirSync(second)
  f.choose(second, [f.folder])
  const two = new ThreadWorkspaceManager(f.thread('thread-two'))
  const made = await two.provision('thread-two', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Add a checkout button' })
  expect(made.worktreePath).toBe(join(second, `shop-${f.key.slice(0, 12)}`, 'add-a-checkout-button'))
  // The first thread's worktree is where it was recorded, and still ready.
  expect(one.load()!.worktreePath).toBe(first.worktreePath)
  expect((await one.verify()).lifecycle).toBe('ready')
  // Back to Mousse's own folder: both earlier worktrees stay where they are.
  f.choose(null, [second, f.folder])
  const three = new ThreadWorkspaceManager(f.thread('thread-three'))
  const own = await three.provision('thread-three', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Third' })
  expect(own.worktreePath).toBe(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 'thread-three', 'main'))
  expect((await one.verify()).lifecycle).toBe('ready')
  expect((await two.verify()).lifecycle).toBe('ready')
})

test("the Git check treats Mousse's folders in the chosen folder as owned, refuses by default, and leaves the person's folders there theirs", async () => {
  const f = fixture()
  f.choose(f.folder)
  expect(gitPolicyMode()).toBe('refuse')
  const manager = new ThreadWorkspaceManager(f.thread('thread-one'))
  const { worktreePath } = await manager.provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Owned here' })
  // A change only Mousse's own worktree may get: it writes the index and the files.
  expect(decideGitCommand({ cwd: worktreePath, args: ['checkout', '--', 'a.txt'] })).toMatchObject({ access: 'owned', allowed: true })
  expect(() => assertGitAllowed({ cwd: worktreePath, args: ['add', '-A'] })).not.toThrow()
  // A repository of the person's own beside it, in the same chosen folder, is not Mousse's.
  const theirs = join(f.folder, 'my-own-repo'); mkdirSync(theirs); git(theirs, ['init', '-q'])
  expect(decideGitCommand({ cwd: theirs, args: ['checkout', '--', 'a.txt'] }).allowed).toBe(false)
  expect(() => assertGitAllowed({ cwd: theirs, args: ['add', '-A'] })).toThrow(GitPolicyError)
  // Nor is the chosen folder once it is no longer chosen and holds nothing of Mousse's.
  f.choose(null)
  expect(() => assertGitAllowed({ cwd: worktreePath, args: ['add', '-A'] })).toThrow(GitPolicyError)
})

test('checking a chosen folder: a full path outside the Mousse home, outside any checkout, without a repository of its own at its top, writable', async () => {
  const f = fixture()
  await expect(checkWorktreeFolder('relative/path', f.home)).rejects.toThrow(WorktreeFolderRefused)
  await expect(checkWorktreeFolder(join(f.home, 'repositories', 'mine'), f.home)).rejects.toThrow(/Mousse's own data folder/)
  await expect(checkWorktreeFolder(join(f.repo, 'sub'), f.home)).rejects.toThrow(/inside the Git repository/)
  const holding = join(f.other, 'holding'); mkdirSync(join(holding, 'project'), { recursive: true }); git(join(holding, 'project'), ['init', '-q'])
  await expect(checkWorktreeFolder(holding, f.home)).rejects.toThrow(/holds the Git repository/)
  expect(await checkWorktreeFolder(join(f.other, 'new-folder'), f.home)).toBe(join(f.other, 'new-folder'))
  expect(existsSync(join(f.other, 'new-folder'))).toBe(true)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = join(f.other, 'locked'); mkdirSync(locked); chmodSync(locked, 0o500)
    try { await expect(checkWorktreeFolder(locked, f.home)).rejects.toThrow(/can't write/) } finally { chmodSync(locked, 0o700) }
  }
})

// ---- The trash on the same drive ----

/** Every entry of a folder but its own `.git` file: each file's mode and exact bytes, each link's target, each folder's mode. */
function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (!rel && name === '.git') continue
      const path = join(dir, name), at = rel ? `${rel}/${name}` : name, stat = lstatSync(path)
      if (stat.isDirectory()) { out[`${at}/`] = `folder ${stat.mode & 0o777}`; walk(path, at) }
      else if (stat.isSymbolicLink()) out[at] = `link ${readlinkSync(path)}`
      else out[at] = `file ${stat.mode & 0o777} ${readFileSync(path).toString('base64')}`
    }
  }
  walk(root, '')
  return out
}

/** An agent worktree in the chosen folder, with its owner record, a lifecycle store and the leases a retirement needs. */
async function agentInChosenFolder(folder?: string) {
  const f = fixture()
  const chosen = folder ?? f.folder
  f.choose(chosen)
  const task = join(f.home, 'thread-data', 'task'); mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }); store.registerTask({ taskId: 'task', location: task })
  const base = await placeAgentWorktreeBase({ home: f.home, folder: chosen, repositoryId: f.key, projectName: 'shop' })
  const worktree = join(base, 'worker'), branch = 'mousse/agent/worker'
  git(f.repo, ['worktree', 'add', '-q', '-b', branch, worktree])
  const sourcePath = join(task, 'agents.json'); writeFileSync(sourcePath, JSON.stringify([{ id: 'worker', worktreePath: worktree, branch }]))
  registerThreadLifecycleGate(f.home, store)
  const taskLease = await waitAcquireExecutionLease(task), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
  releases.push(() => repositoryLease.release(), () => releaseExecutionLeaseHandle(taskLease))
  const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
  return { ...f, chosen, task, store, service, worktree, branch, input: { taskId: 'task', worktreePath: worktree, branch, sourcePath }, path: service.pathFor('task', worktree) }
}

test('a worktree in a chosen folder is trashed on its own drive, and a restore moves it back byte for byte', async () => {
  const f = await agentInChosenFolder()
  writeFileSync(join(f.worktree, 'a.txt'), 'edited\n')
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(trashed.trashPath!.startsWith(join(f.folder, WORKTREE_TRASH_FOLDER, 'worktrees') + '/')).toBe(true)
  expect(existsSync(f.worktree)).toBe(false)
  // Nothing of it went to the profile's trash, on another drive.
  expect(existsSync(join(f.home, 'trash', 'worktrees'))).toBe(false)
  const before = filesOf(trashed.trashPath!)
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(before)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited\n')
})

test('trash expiry in a chosen folder deletes against its proof there, keeps the ignored files, and a restore rebuilds byte for byte', async () => {
  const f = await agentInChosenFolder()
  writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'ignored/\n')
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const trashPath = trashed.trashPath!
  writeFileSync(join(trashPath, 'a.txt'), 'edited in the trash\n')
  mkdirSync(join(trashPath, 'sub')); writeFileSync(join(trashPath, 'sub', 'x.txt'), 'x\n')
  mkdirSync(join(trashPath, 'ignored')); writeFileSync(join(trashPath, 'ignored', 'cache.bin'), Buffer.from([0, 1, 2, 254, 255, 13, 10]))
  if (process.platform !== 'win32') symlinkSync('a.txt', join(trashPath, 'ignored', 'link'))
  const before = filesOf(trashPath)
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(existsSync(trashPath)).toBe(false)
  expect(readdirSync(dirname(trashPath)).filter((name) => name.startsWith('.deleting-'))).toEqual([])
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(retired.state).toBe('retired')
  // The kept copy of the ignored files, restored and compared byte for byte.
  expect(retired.keptFiles).toEqual([{ sha: expect.any(String), paths: expect.arrayContaining(['ignored/cache.bin']) }])
  expect(execFileSync('git', ['cat-file', '-p', `${retired.keptFiles[0].sha}:ignored/cache.bin`], { cwd: f.repo })).toEqual(Buffer.from([0, 1, 2, 254, 255, 13, 10]))
  git(f.repo, ['gc', '--prune=now', '-q'])
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(before)
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
})

test('a permanent deletion removes a trashed worktree in a chosen folder from that folder\'s trash', async () => {
  const f = await agentInChosenFolder()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  // The deletion a person confirms goes through Git, in the trash it is in.
  await (f.service as unknown as { removeTrashed(manifest: unknown): Promise<void> }).removeTrashed(trashed)
  expect(existsSync(trashed.trashPath!)).toBe(false)
  expect(git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(trashed.trashPath!)
})

// ---- A drive that is not connected ----

test('a chosen folder that is not there pauses only its threads: nothing is marked or rebuilt, other threads go on, and it carries on when the folder is back', async () => {
  const f = fixture()
  f.choose(f.folder)
  const away = new ThreadWorkspaceManager(f.thread('thread-away'))
  const offlineThread = await away.provision('thread-away', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'On the drive' })
  f.choose(null, [f.folder])
  const local = new ThreadWorkspaceManager(f.thread('thread-local'))
  await local.provision('thread-local', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'On this disk' })
  const record = readFileSync(away.workspacePath, 'utf8')

  // The drive goes away.
  const unplugged = `${f.folder}-unplugged`
  renameSync(f.folder, unplugged)
  expect(await disconnectedWorktreeFolder(offlineThread.worktreePath)).toBe(f.folder)
  const resolver = new WorkspaceResolver(away.threadDirectory, 'thread-away', f.repo, 'worktree')
  await expect(resolver.resolve('agent')).rejects.toThrow(DriveNotConnectedError)
  await expect(resolver.resolve('agent')).rejects.toThrow(`Drive not connected: ${f.folder}`)
  await expect(away.restore(f.repo)).rejects.toThrow(DriveNotConnectedError)
  // Nothing was made where the drive mounts, and the thread's record is as it was: no recovery, no rebuild.
  expect(existsSync(f.folder)).toBe(false)
  expect(readFileSync(away.workspacePath, 'utf8')).toBe(record)
  // The other thread is untouched.
  const other = await new WorkspaceResolver(local.threadDirectory, 'thread-local', f.repo, 'worktree').resolve('agent')
  expect(other.lifecycle).toBe('ready')
  // A new thread meanwhile, with the folder chosen, goes to Mousse's own folder and says so.
  f.choose(f.folder)
  const fresh = new WorkspaceResolver(f.thread('thread-new'), 'thread-new', f.repo, 'worktree')
  const made = await fresh.resolve('agent', 'main', undefined, undefined, 'While unplugged')
  expect(made.workspacePath).toBe(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 'thread-new', 'main'))
  expect(made.startNote).toContain(`The worktree folder ${f.folder} is not connected`)

  // The wait for the drive ends when it is back, and the thread carries on as it was.
  const waiting = waitForWorktreeFolder(f.folder, undefined, 20)
  renameSync(unplugged, f.folder)
  await waiting
  const back = await resolver.resolve('agent')
  expect(back.lifecycle).toBe('ready')
  expect(back.workspacePath).toBe(offlineThread.worktreePath)
})

/** A thread `id` of `repo` whose worktree is made in the worktree folder `drive`, registered in `store`. */
async function threadOnDrive(f: Awaited<ReturnType<typeof agentInChosenFolder>>, id: string, repo: string, drive: string) {
  f.choose(drive, [f.folder])
  const location = join(f.home, 'thread-data', id); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id, name: 'On the drive' })); writeFileSync(join(location, 'messages.json'), '[]')
  f.store.registerTask({ taskId: id, location })
  const metadata = await new ThreadWorkspaceManager(location).provision(id, 'main', repo, undefined, undefined, undefined, { nameFrom: 'On the drive' })
  return { location, metadata }
}

test('a drive that is not connected never blocks cleanup in another repository, and its own worktree is left as it is', async () => {
  const f = await agentInChosenFolder()
  const otherRepo = join(f.root, 'other'); mkdirSync(otherRepo)
  git(otherRepo, ['init', '-q']); git(otherRepo, ['config', 'user.email', 'test@example.com']); git(otherRepo, ['config', 'user.name', 'Test'])
  writeFileSync(join(otherRepo, 'b.txt'), 'other\n'); git(otherRepo, ['add', '.']); git(otherRepo, ['commit', '-qm', 'base'])
  const drive = join(f.other, 'Drive'); mkdirSync(drive)
  const away = await threadOnDrive(f, 'away', otherRepo, drive)
  renameSync(drive, `${drive}-unplugged`)
  // The agent worktree of `shop` goes to the trash and comes back, whatever the drive of the other repository's thread.
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(trashed.state).toBe('trashed')
  await f.service.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  // The drive is back: the thread's worktree is as it was.
  renameSync(`${drive}-unplugged`, drive)
  expect((await new ThreadWorkspaceManager(away.location).verify()).lifecycle).toBe('ready')
  expect(readFileSync(join(away.metadata.worktreePath, 'b.txt'), 'utf8')).toBe('other\n')
})

test('a thread of the same repository on a drive that is not connected keeps that repository\'s checkouts where they are, and is named', async () => {
  const f = await agentInChosenFolder()
  const drive = join(f.other, 'Drive'); mkdirSync(drive)
  f.choose(drive, [f.folder])
  // Made as a provision makes it (the fixture holds the repository's lease, which a provision would wait for).
  const worktree = join(drive, `shop-${f.key.slice(0, 12)}`, 'on-the-drive'); mkdirSync(dirname(worktree))
  git(f.repo, ['worktree', 'add', '-q', '-b', 'mousse/on-the-drive', worktree])
  const sha = git(f.repo, ['rev-parse', 'HEAD'])
  const location = join(f.home, 'thread-data', 'away'); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'away', name: 'On the drive' })); writeFileSync(join(location, 'messages.json'), '[]')
  writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: 'away', worktreePath: worktree, branch: 'mousse/on-the-drive', repositoryId: f.key, retainedRef: 'refs/mousse/threads/away/main', baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: f.repo }, lifecycle: 'ready' }))
  f.store.registerTask({ taskId: 'away', location })
  renameSync(drive, `${drive}-unplugged`)
  await f.service.prepare(f.input)
  await expect(f.service.retire(f.path)).rejects.toThrow(`Thread “On the drive” has a worktree Mousse can’t check: ${worktree}.`)
  expect(existsSync(f.worktree)).toBe(true)
  renameSync(`${drive}-unplugged`, drive)
  expect((await f.service.retire(f.path)).state).toBe('trashed')
})

test('a Stop ends the wait for a drive that is not connected', async () => {
  const f = fixture()
  const missing = join(f.other, 'never-there')
  const stop = new AbortController()
  const waiting = waitForWorktreeFolder(missing, stop.signal, 20)
  stop.abort(new DOMException('Thread stopped', 'AbortError'))
  await expect(waiting).rejects.toThrow('Thread stopped')
})

test('agent worktrees of a dispatch go to the chosen folder and are cleaned up there', async () => {
  const f = fixture()
  f.choose(f.folder)
  const manager = new WorktreeManager(f.repo, f.home)
  const info = await manager.createWorktree('dispatch-one', f.repo, undefined, undefined, { worktreeFolder: f.folder })
  expect(info.path).toBe(join(f.folder, `shop-${f.key.slice(0, 12)}`, 'agents', 'dispatch-one'))
  expect(manager.isValidatedAgentWorktreePath(info.path)).toBe(true)
  const removed = await manager.cleanupValidatedAgentWorktree(info, { keepIgnored: 'delete-confirmed' })
  expect(removed).toEqual({ success: true })
  expect(existsSync(info.path)).toBe(false)
})

// ---- A drive that keeps no file modes ----

test.skipIf(process.platform === 'win32')("Mousse's own Git ignores file modes in a chosen folder whose drive keeps none, and only there", async () => {
  const f = fixture()
  f.choose(f.folder)
  expect(await probeFileModes(f.folder)).toBe(true)
  const inFolder = join(f.folder, `shop-${f.key.slice(0, 12)}`, 'x')
  expect(ignoresFileModes(inFolder)).toBe(false)
  expect(repoProgramSettings(f.repo)).not.toContain('core.fileMode=false')
})

/** {@link filesOf} without macOS's `._` files, which it writes beside files with extended attributes on exFAT and FAT drives. */
const withoutAppleDouble = (files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).filter(([path]) => !path.split('/').some((part) => part.startsWith('._'))))

/**
 * Opt-in (`MOUSSE_TEST_SECOND_VOLUME=1`, macOS): a real second volume, an exFAT disk image, which keeps no file modes and
 * is case-insensitive. Mousse's own Git ignores the modes there, and the trash and its expiry stay on that volume. macOS
 * writes `._` files there beside files with extended attributes (`com.apple.provenance`); Git sees them as untracked
 * files, and a rebuild can meet one Git refuses to write over. Nothing is lost either way.
 */
test.runIf(process.platform === 'darwin' && process.env.MOUSSE_TEST_SECOND_VOLUME === '1')('on a real exFAT volume: modes are ignored, the trash and its expiry stay on the volume, and every byte is kept', async () => {
  const images = scratch('mousse-volume-')
  const mount = join(images, 'mnt'); mkdirSync(mount)
  execFileSync('hdiutil', ['create', '-quiet', '-size', '64m', '-fs', 'ExFAT', '-volname', 'MousseWT', '-o', join(images, 'volume.dmg')])
  execFileSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mount, join(images, 'volume.dmg')])
  releases.push(() => execFileSync('hdiutil', ['detach', '-quiet', '-force', mount]))
  const folder = await checkWorktreeFolder(join(mount, 'Worktrees'), join(images, 'home'))
  expect(await probeFileModes(folder)).toBe(false)
  const f = await agentInChosenFolder(folder)
  expect(ignoresFileModes(f.worktree)).toBe(true)
  expect(repoProgramSettings(f.worktree)).toContain('core.fileMode=false')
  // Every file there reads as 0700, run.sh included; Mousse's own status sees no change but macOS's `._` files.
  const status = (cwd: string, ...settings: string[]) => execFileSync('git', [...settings.flatMap((value) => ['-c', value]), 'status', '--porcelain'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
  expect(status(f.worktree).some((line) => line.startsWith(' M'))).toBe(true)
  expect(status(f.worktree, ...repoProgramSettings(f.worktree)).filter((line) => !line.includes('._'))).toEqual([])
  // macOS's `._` files are untracked files to Git: the retirement's snapshot holds them with the rest.
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(trashed.trashPath!.startsWith(join(folder, WORKTREE_TRASH_FOLDER))).toBe(true)
  expect(lstatSync(trashed.trashPath!).dev).toBe(lstatSync(folder).dev)
  writeFileSync(join(trashed.trashPath!, 'a.txt'), 'edited on the drive\n')
  const before = withoutAppleDouble(filesOf(trashed.trashPath!))
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(existsSync(trashed.trashPath!)).toBe(false)
  // Every byte is kept: the edit is in the expiry's snapshot.
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(execFileSync('git', ['cat-file', '-p', `${retired.snapshotSha}:a.txt`], { cwd: f.repo, encoding: 'utf8' })).toBe('edited on the drive\n')
  // A rebuild: where macOS writes a `._` file for the new `.git` file, Git refuses to write the snapshot's own over it, and
  // the record and the snapshot stay as they are; where it does not, the worktree comes back byte for byte.
  try {
    await f.service.reconstruct(f.path)
    expect(withoutAppleDouble(filesOf(f.worktree))).toEqual(before)
  } catch (error) {
    expect(String(error)).toMatch(/Untracked working tree file '\._/)
    expect(JSON.parse(readFileSync(f.path, 'utf8')).snapshotSha).toBe(retired.snapshotSha)
    expect(execFileSync('git', ['cat-file', '-p', `${retired.snapshotSha}:a.txt`], { cwd: f.repo, encoding: 'utf8' })).toBe('edited on the drive\n')
  }
})
