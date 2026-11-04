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
import { provisionOwnedAgentWorkspace } from '../src/mms/workspace/WorkflowWorkspace'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { normalizeStorageSettings, type WorktreeFolderEntry } from '../src/shared/settings'
import {
  checkWorktreeFolder, chosenWorktreeFolder, disconnectedWorktreeFolder, DriveNotConnectedError, folderConnected, forgetWorktreeFolders,
  isAgentWorktreePlace, isThreadWorktreePlace, placeAgentWorktreeBase, placeThreadWorktree, refreshWorktreeFolders,
  setWorktreeFolders, threadTag, trashRootFor, waitForWorktreeFolder, worktreeFolderStillNeeded, WORKTREE_FOLDER_MARKER, WORKTREE_TRASH_FOLDER,
  WorktreeFolderRefused
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
 * nowhere near the home, as a folder on an external drive is. The folder is chosen as the Storage setting chooses it
 * (`checkWorktreeFolder`, which writes its marker).
 */
async function fixture() {
  const root = scratch('mousse-wtfolder-')
  const repo = join(root, 'shop'); mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(repo, 'run.sh'), 0o755)
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
  const home = join(root, 'home'); mkdirSync(home); releases.push(ownedHome(home))
  process.env.MOUSSE_HOME = home
  const other = scratch('mousse-other-drive-')
  const entry = await checkWorktreeFolder(join(other, 'Worktrees'), home)
  const folder = entry.path
  const key = resolveRepositoryIdentity(repo).key
  const choose = async (current: WorktreeFolderEntry | null, previous: WorktreeFolderEntry[] = []) => {
    homes.push(home); setWorktreeFolders(home, { worktreeFolder: current, previousWorktreeFolders: previous }); await refreshWorktreeFolders()
  }
  const thread = (id: string) => { const directory = join(home, 'thread-data', id); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'meta.json'), JSON.stringify({ id })); return directory }
  const repositoryFolder = join(folder, `shop-${key.slice(0, 12)}`)
  return { root, repo, home, other, folder, entry, key, choose, thread, repositoryFolder }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function storeOf(f: Fixture): ResourceLifecycleStore {
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home })
  registerThreadLifecycleGate(f.home, store)
  return store
}

/** A thread `id` registered in `store`, with its worktree provisioned from `nameFrom`. */
async function provisioned(f: Fixture, store: ResourceLifecycleStore, id: string, nameFrom: string, repo = f.repo) {
  const location = f.thread(id)
  store.registerTask({ taskId: id, location })
  const metadata = await new ThreadWorkspaceManager(location).provision(id, 'main', repo, undefined, undefined, undefined, { nameFrom })
  return { location, metadata }
}

/** Retires the thread's worktree and lets its trash expire: it is deleted against its proof, and its name is free on disk. */
async function retireAndExpire(f: Fixture, store: ResourceLifecycleStore, thread: { location: string; metadata: { threadId: string; worktreePath: string; branch: string } }) {
  const taskLease = await waitAcquireExecutionLease(thread.location), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
  try {
    const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
    const path = service.pathFor(thread.metadata.threadId, thread.metadata.worktreePath)
    await service.prepare({ taskId: thread.metadata.threadId, worktreePath: thread.metadata.worktreePath, branch: thread.metadata.branch, sourcePath: join(thread.location, 'workspace.json') })
    await service.retire(path)
    expect(await service.expireTrash(path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  } finally { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) }
}

// ---- Where a new worktree goes ----

test('a new thread worktree goes to <folder>/<project>-<short key>/<slug>-<thread tag>, and agents go to agents/<id>', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const place = (threadId: string, branch: string) => placeThreadWorktree({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop', threadId, conversationBranchId: 'main', branch })
  const first = await place('7f3a9c2e-0000-4000-8000-000000000001', 'mousse/fix-prices')
  expect(first).toEqual({ path: join(f.repositoryFolder, 'fix-prices-7f3a9c'), folder: f.folder })
  // Another thread with the same branch name never gets the same folder.
  expect((await place('b41c55aa-0000-4000-8000-000000000002', 'mousse/fix-prices')).path).toBe(join(f.repositoryFolder, 'fix-prices-b41c55'))
  // A name already on disk gets a number.
  mkdirSync(first.path)
  expect((await place('7f3a9c2e-0000-4000-8000-000000000001', 'mousse/fix-prices')).path).toBe(join(f.repositoryFolder, 'fix-prices-7f3a9c-2'))
  // The repository keeps its folder when the project is renamed: it is found by its marker.
  const renamed = await placeThreadWorktree({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'Shop (new name)', threadId: 'c0ffee00', conversationBranchId: 'main', branch: 'mousse/other' })
  expect(dirname(renamed.path)).toBe(f.repositoryFolder)
  expect(await placeAgentWorktreeBase({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop' })).toBe(join(f.repositoryFolder, 'agents'))
  // Without a chosen folder, Mousse's own, as before.
  expect((await placeThreadWorktree({ home: f.home, repositoryId: f.key, projectName: 'shop', threadId: 't', conversationBranchId: 'main', branch: 'mousse/x' })).path)
    .toBe(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 't', 'main'))
  // The place check is the thread's own: another thread's folder is not this thread's place.
  expect(isThreadWorktreePlace(first.path, { home: f.home, repositoryId: f.key, threadId: '7f3a9c2e-0000-4000-8000-000000000001' })).toBe(true)
  expect(isThreadWorktreePlace(first.path, { home: f.home, repositoryId: f.key, threadId: 'b41c55aa-0000-4000-8000-000000000002' })).toBe(false)
  expect(isAgentWorktreePlace(join(f.repositoryFolder, 'agents', 'worker'), { home: f.home, repositoryId: f.key, agentId: 'worker' })).toBe(true)
  expect(trashRootFor(first.path, f.home)).toBe(join(f.folder, WORKTREE_TRASH_FOLDER))
  expect(trashRootFor(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 't', 'main'), f.home)).toBe(join(f.home, 'trash'))
})

test('a thread named "Agents" never takes the agents folder', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const made = await new ThreadWorkspaceManager(f.thread('thread-one')).provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Agents' })
  expect(made.worktreePath).toBe(join(f.repositoryFolder, `agents-${threadTag('thread-one')}`))
  expect(isThreadWorktreePlace(made.worktreePath, { home: f.home, repositoryId: f.key, threadId: 'thread-one' })).toBe(true)
  expect(existsSync(join(f.repositoryFolder, 'agents'))).toBe(false)
})

test('a thread provisioned with a chosen folder works there; after the setting changes, new threads use the new folder and earlier worktrees stay put', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const one = new ThreadWorkspaceManager(f.thread('thread-one'))
  expect(chosenWorktreeFolder(one.threadDirectory)).toBe(f.folder)
  const first = await one.provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Fix the prices page' })
  expect(first.worktreePath).toBe(join(f.repositoryFolder, `fix-the-prices-page-${threadTag('thread-one')}`))
  expect(git(first.worktreePath, ['branch', '--show-current'])).toBe('mousse/fix-the-prices-page')
  expect((await one.verify(first)).lifecycle).toBe('ready')
  const second = await checkWorktreeFolder(join(f.other, 'Elsewhere'), f.home)
  await f.choose(second, [f.entry])
  const two = new ThreadWorkspaceManager(f.thread('thread-two'))
  const made = await two.provision('thread-two', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Add a checkout button' })
  expect(made.worktreePath).toBe(join(second.path, `shop-${f.key.slice(0, 12)}`, `add-a-checkout-button-${threadTag('thread-two')}`))
  expect(one.load()!.worktreePath).toBe(first.worktreePath)
  expect((await one.verify()).lifecycle).toBe('ready')
  // Back to Mousse's own folder: both earlier worktrees stay where they are.
  await f.choose(null, [second, f.entry])
  const own = await new ThreadWorkspaceManager(f.thread('thread-three')).provision('thread-three', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Third' })
  expect(own.worktreePath).toBe(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 'thread-three', 'main'))
  expect((await one.verify()).lifecycle).toBe('ready')
  expect((await two.verify()).lifecycle).toBe('ready')
})

// ---- One thread, one folder ----

test("a thread whose trashed worktree expired gets its own worktree back, never another thread's that took its name", async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const store = storeOf(f)
  const a = await provisioned(f, store, 'aaaaaa11-0000-4000-8000-000000000001', 'Fix the prices')
  writeFileSync(join(a.metadata.worktreePath, 'mine-a.txt'), 'A\n')
  await retireAndExpire(f, store, a)
  expect(existsSync(a.metadata.worktreePath)).toBe(false)
  // A new thread with the same first message.
  const b = await provisioned(f, store, 'bbbbbb22-0000-4000-8000-000000000002', 'Fix the prices')
  writeFileSync(join(b.metadata.worktreePath, 'mine-b.txt'), 'B\n')
  expect(b.metadata.worktreePath).not.toBe(a.metadata.worktreePath)
  // Thread A is used again: its worktree is rebuilt at its own path, with its own file.
  const context = await new WorkspaceResolver(a.location, a.metadata.threadId, f.repo, 'worktree').resolve('agent')
  expect(context.lifecycle).toBe('ready')
  expect(context.workspacePath).toBe(a.metadata.worktreePath)
  expect(readFileSync(join(context.workspacePath, 'mine-a.txt'), 'utf8')).toBe('A\n')
  expect(existsSync(join(context.workspacePath, 'mine-b.txt'))).toBe(false)
  expect(readFileSync(join(b.metadata.worktreePath, 'mine-b.txt'), 'utf8')).toBe('B\n')
})

test('a name a record still names is never given to a new worktree', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const threadId = 'cccccc33-0000-4000-8000-000000000003'
  const path = join(f.repositoryFolder, `fix-${threadTag(threadId)}`)
  // Gone from disk, but still named (by Git, or a reconstruction manifest).
  const placed = await placeThreadWorktree({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop', threadId, conversationBranchId: 'main', branch: 'mousse/fix', taken: async (candidate) => candidate === path })
  expect(placed.path).toBe(`${path}-2`)
})

// ---- The folder that was chosen, and nothing else ----

test("an empty mount point, or another drive at the same path, is not the folder that was chosen: its threads wait and new worktrees go to Mousse's own folder", async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const store = storeOf(f)
  const a = await provisioned(f, store, 'thread-a', 'On the drive')
  // The drive is unmounted, and its mount point stays as an empty folder.
  renameSync(f.folder, `${f.folder}-contents`); mkdirSync(f.folder)
  expect(await disconnectedWorktreeFolder(a.metadata.worktreePath)).toBe(f.folder)
  await expect(new WorkspaceResolver(a.location, 'thread-a', f.repo, 'worktree').resolve('agent')).rejects.toThrow(DriveNotConnectedError)
  const b = await placeThreadWorktree({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop', threadId: 'second', conversationBranchId: 'main', branch: 'mousse/second' })
  expect(b.notConnected).toBe(f.folder)
  expect(b.path.startsWith(f.folder)).toBe(false)
  expect(readdirSync(f.folder)).toEqual([])
  // Another drive mounted there that was chosen as a worktree folder somewhere else: its marker has another id.
  writeFileSync(join(f.folder, WORKTREE_FOLDER_MARKER), JSON.stringify({ schemaVersion: 1, id: 'f'.repeat(32) }))
  expect(await folderConnected(f.folder)).toBe(false)
  // Changing the setting now keeps the folder known: it is not connected, and a record names a path in it.
  expect(await worktreeFolderStillNeeded(f.entry, [a.metadata.worktreePath])).toBe(true)
  expect(await worktreeFolderStillNeeded(f.entry, [])).toBe(true)
  // The drive is back: the thread carries on in its worktree.
  rmSync(f.folder, { recursive: true }); renameSync(`${f.folder}-contents`, f.folder)
  expect((await new WorkspaceResolver(a.location, 'thread-a', f.repo, 'worktree').resolve('agent')).workspacePath).toBe(a.metadata.worktreePath)
  // A connected folder with nothing of Mousse's left in it and no record naming it may be forgotten.
  const empty = await checkWorktreeFolder(join(f.other, 'Empty'), f.home)
  expect(await worktreeFolderStillNeeded(empty, [a.metadata.worktreePath])).toBe(false)
})

test("another repository at a worktree's recorded path is never used as the thread's worktree, and Mousse's Git is refused there", async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const manager = new ThreadWorkspaceManager(f.thread('thread-one'))
  const made = await manager.provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'On the drive' })
  // A replacement drive at the same path, with someone's own repository where the worktree was, and no marker.
  renameSync(f.folder, `${f.folder}-unplugged`)
  mkdirSync(made.worktreePath, { recursive: true }); git(made.worktreePath, ['init', '-q', '-b', 'personal']); git(made.worktreePath, ['config', 'user.email', 'test@example.com']); git(made.worktreePath, ['config', 'user.name', 'Test'])
  writeFileSync(join(made.worktreePath, 'personal.txt'), 'personal bytes'); git(made.worktreePath, ['add', '.']); git(made.worktreePath, ['commit', '-qm', 'personal'])
  const resolver = new WorkspaceResolver(manager.threadDirectory, 'thread-one', f.repo, 'worktree')
  await expect(resolver.resolve('agent')).rejects.toThrow(DriveNotConnectedError)
  expect(decideGitCommand({ cwd: made.worktreePath, args: ['checkout', '--', 'personal.txt'] }).allowed).toBe(false)
  // The same, with the chosen folder's own marker copied there: the folder is still not this repository's worktree.
  writeFileSync(join(f.folder, WORKTREE_FOLDER_MARKER), readFileSync(join(`${f.folder}-unplugged`, WORKTREE_FOLDER_MARKER)))
  await expect(resolver.resolve('agent')).rejects.toThrow(/recovery/i)
  expect(decideGitCommand({ cwd: made.worktreePath, args: ['checkout', '--', 'personal.txt'] }).allowed).toBe(false)
  expect(readFileSync(join(made.worktreePath, 'personal.txt'), 'utf8')).toBe('personal bytes')
  expect(git(made.worktreePath, ['branch', '--show-current'])).toBe('personal')
})

test("the Git check treats Mousse's folders in the chosen folder as owned, refuses by default, and leaves the person's folders there theirs, whatever they are called", async () => {
  const f = await fixture()
  // A repository of the person's own spelled like Mousse's, there before the folder is chosen: the folder is refused.
  const theirs = join(f.other, 'Theirs', 'my-project-123456abcdef'); mkdirSync(theirs, { recursive: true }); git(theirs, ['init', '-q'])
  await expect(checkWorktreeFolder(dirname(theirs), f.home)).rejects.toThrow(/holds the Git repository/)
  await f.choose(f.entry)
  expect(gitPolicyMode()).toBe('refuse')
  const { worktreePath } = await new ThreadWorkspaceManager(f.thread('thread-one')).provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Owned here' })
  expect(decideGitCommand({ cwd: worktreePath, args: ['checkout', '--', 'a.txt'] })).toMatchObject({ access: 'owned', allowed: true })
  expect(() => assertGitAllowed({ cwd: worktreePath, args: ['add', '-A'] })).not.toThrow()
  // Folders put there afterwards, a repository beside Mousse's and one named like Mousse's, are the person's.
  for (const name of ['my-own-repo', `shop-${'a'.repeat(12)}`]) {
    const path = join(f.folder, name); mkdirSync(path); git(path, ['init', '-q'])
    await refreshWorktreeFolders()
    expect(decideGitCommand({ cwd: path, args: ['checkout', '--', 'a.txt'] }).allowed, name).toBe(false)
    expect(() => assertGitAllowed({ cwd: path, args: ['add', '-A'] }), name).toThrow(GitPolicyError)
  }
  // Nor is anything in the chosen folder once it is no longer known.
  await f.choose(null)
  expect(() => assertGitAllowed({ cwd: worktreePath, args: ['add', '-A'] })).toThrow(GitPolicyError)
})

test('a chosen folder whose marker went missing is still the one chosen: its repository folders say so, and choosing it again keeps its id', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const manager = new ThreadWorkspaceManager(f.thread('thread-one'))
  const made = await manager.provision('thread-one', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Marker' })
  rmSync(join(f.folder, WORKTREE_FOLDER_MARKER))
  // The drive is plugged in: it reads as connected, and the marker is written again with the same id.
  expect(await folderConnected(f.folder)).toBe(true)
  expect(JSON.parse(readFileSync(join(f.folder, WORKTREE_FOLDER_MARKER), 'utf8')).id).toBe(f.entry.id)
  expect((await manager.verify()).lifecycle).toBe('ready')
  expect(decideGitCommand({ cwd: made.worktreePath, args: ['add', '-A'] }).allowed).toBe(true)
  // Chosen again with the marker gone: the same id, from its repository folders or the stored entry.
  rmSync(join(f.folder, WORKTREE_FOLDER_MARKER))
  expect((await checkWorktreeFolder(f.folder, f.home, [f.entry.id])).id).toBe(f.entry.id)
  rmSync(join(f.folder, WORKTREE_FOLDER_MARKER))
  expect((await checkWorktreeFolder(f.folder, f.home)).id).toBe(f.entry.id)
  await f.choose(f.entry)
  expect(decideGitCommand({ cwd: made.worktreePath, args: ['add', '-A'] }).allowed).toBe(true)
  expect((await new ThreadWorkspaceManager(f.thread('thread-two')).provision('thread-two', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Second' })).worktreePath.startsWith(f.repositoryFolder + '/')).toBe(true)
})

test('a worktree in a chosen folder stays the thread\'s after its repository is moved and repaired, and the record takes the new key', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const manager = new ThreadWorkspaceManager(f.thread('moved-task'))
  const made = await manager.provision('moved-task', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Moved' })
  const moved = join(f.root, 'moved-shop'); renameSync(f.repo, moved); git(moved, ['worktree', 'repair', made.worktreePath])
  const verified = await manager.verify()
  expect(verified.lifecycle).toBe('ready')
  const key = resolveRepositoryIdentity(moved).key
  expect(key).not.toBe(f.key)
  expect(verified.repositoryId).toBe(key)
  expect(manager.load()!.repositoryId).toBe(key)
  // A repository that merely registers a worktree at the same path, without the thread's own ref, is not taken for it.
  const other = join(f.root, 'other'); mkdirSync(other); git(other, ['init', '-q']); git(other, ['config', 'user.email', 'test@example.com']); git(other, ['config', 'user.name', 'Test'])
  writeFileSync(join(other, 'x.txt'), 'x\n'); git(other, ['add', '.']); git(other, ['commit', '-qm', 'x'])
  git(moved, ['worktree', 'remove', '--force', made.worktreePath])
  git(other, ['worktree', 'add', '-q', made.worktreePath])
  expect((await manager.verify()).lifecycle).toBe('recovery_required')
  expect(manager.load()!.repositoryId).toBe(key)
})

test('checking a chosen folder: a full path outside the Mousse home, outside any checkout, without a repository of its own at its top, writable, marked', async () => {
  const f = await fixture()
  await expect(checkWorktreeFolder('relative/path', f.home)).rejects.toThrow(WorktreeFolderRefused)
  await expect(checkWorktreeFolder(join(f.home, 'repositories', 'mine'), f.home)).rejects.toThrow(/Mousse's own data folder/)
  await expect(checkWorktreeFolder(join(f.repo, 'sub'), f.home)).rejects.toThrow(/inside the Git repository/)
  const made = await checkWorktreeFolder(join(f.other, 'new-folder'), f.home)
  expect(made.path).toBe(join(f.other, 'new-folder'))
  expect(JSON.parse(readFileSync(join(made.path, WORKTREE_FOLDER_MARKER), 'utf8'))).toMatchObject({ schemaVersion: 1, id: made.id })
  // Chosen again (here, or on another computer), it keeps its id.
  expect((await checkWorktreeFolder(made.path, f.home)).id).toBe(made.id)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = join(f.other, 'locked'); mkdirSync(locked); chmodSync(locked, 0o500)
    try { await expect(checkWorktreeFolder(locked, f.home)).rejects.toThrow(/can't write/) } finally { chmodSync(locked, 0o700) }
  }
})

test('stored worktree folders must be full paths with an id', () => {
  const id = 'a'.repeat(32)
  expect(normalizeStorageSettings({ worktreeFolder: { path: 'relative/folder', id }, previousWorktreeFolders: [{ path: '../up', id }, { path: '/Volumes/T7/W', id }, { path: '/Volumes/T7/X', id: 'short' }] }))
    .toEqual({ worktreeFolder: null, previousWorktreeFolders: [{ path: '/Volumes/T7/W', id }] })
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
async function agentInChosenFolder() {
  const f = await fixture()
  await f.choose(f.entry)
  const task = f.thread('task')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }); store.registerTask({ taskId: 'task', location: task })
  const base = await placeAgentWorktreeBase({ home: f.home, folder: f.folder, repositoryId: f.key, projectName: 'shop' })
  const worktree = join(base, 'worker'), branch = 'mousse/agent/worker'
  git(f.repo, ['worktree', 'add', '-q', '-b', branch, worktree])
  const sourcePath = join(task, 'agents.json'); writeFileSync(sourcePath, JSON.stringify([{ id: 'worker', worktreePath: worktree, branch }]))
  registerThreadLifecycleGate(f.home, store)
  const taskLease = await waitAcquireExecutionLease(task), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
  releases.push(() => repositoryLease.release(), () => releaseExecutionLeaseHandle(taskLease))
  const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
  return { ...f, task, store, service, worktree, branch, input: { taskId: 'task', worktreePath: worktree, branch, sourcePath }, path: service.pathFor('task', worktree) }
}

test('a worktree in a chosen folder is trashed on its own drive, and a restore moves it back byte for byte', async () => {
  const f = await agentInChosenFolder()
  writeFileSync(join(f.worktree, 'a.txt'), 'edited\n')
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(trashed.trashPath!.startsWith(join(f.folder, WORKTREE_TRASH_FOLDER, 'worktrees') + '/')).toBe(true)
  expect(existsSync(f.worktree)).toBe(false)
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
  expect(retired.keptFiles).toEqual([{ sha: expect.any(String), paths: expect.arrayContaining(['ignored/cache.bin']) }])
  expect(execFileSync('git', ['cat-file', '-p', `${retired.keptFiles[0].sha}:ignored/cache.bin`], { cwd: f.repo })).toEqual(Buffer.from([0, 1, 2, 254, 255, 13, 10]))
  git(f.repo, ['gc', '--prune=now', '-q'])
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(before)
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
})

test("a permanent deletion removes a trashed worktree in a chosen folder from that folder's trash", async () => {
  const f = await agentInChosenFolder()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  await (f.service as unknown as { removeTrashed(manifest: unknown): Promise<void> }).removeTrashed(trashed)
  expect(existsSync(trashed.trashPath!)).toBe(false)
  expect(git(f.repo, ['worktree', 'list', '--porcelain'])).not.toContain(trashed.trashPath!)
})

test('a delete interrupted after its rename settles nothing while the drive is away, and once it is back a restore keeps the late write', async () => {
  const f = await agentInChosenFolder()
  await f.service.prepare(f.input)
  await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  await expect(f.service.expireTrash(f.path, { now: later, afterRename: (path) => { writeFileSync(join(path, 'late.bin'), Buffer.from([1, 2, 3, 4])); throw new Error('simulated crash') } })).rejects.toThrow('simulated crash')
  const deleting = f.service.load(f.path)
  expect(deleting.state).toBe('deleting')
  const listed = git(f.repo, ['worktree', 'list', '--porcelain'])
  renameSync(f.folder, `${f.folder}-unplugged`)
  expect(await f.service.expireTrash(f.path, { now: later })).toEqual({ kept: `Drive not connected: ${f.folder}`, waiting: true })
  // The record and Git's registration are as they were, and nothing rebuilds while the drive is away.
  expect(f.service.load(f.path)).toEqual(deleting)
  expect(git(f.repo, ['worktree', 'list', '--porcelain'])).toBe(listed)
  await expect(f.service.reconstruct(f.path)).rejects.toThrow(DriveNotConnectedError)
  renameSync(`${f.folder}-unplugged`, f.folder)
  await f.service.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'late.bin'))).toEqual(Buffer.from([1, 2, 3, 4]))
})

// ---- A rebuild that fails, and a pin that would lose a commit ----

test('a rebuild in a chosen folder that fails after making the worktree is finished by the next use, with nothing left beside it', async () => {
  const f = await agentInChosenFolder()
  writeFileSync(join(f.worktree, 'a.txt'), 'edited\n')
  await f.service.prepare(f.input)
  await f.service.retire(f.path)
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  await expect(f.service.reconstruct(f.path, { prepare: () => { throw new Error('simulated failure') }, env: {} })).rejects.toThrow('simulated failure')
  expect(f.service.load(f.path).rebuilding).toBeDefined()
  await f.service.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited\n')
  expect(f.service.load(f.path).rebuilding).toBeUndefined()
  expect(readdirSync(dirname(f.worktree)).filter((name) => name.includes('.partial-'))).toEqual([])
})

test('a second retirement never moves a pin off a commit nothing else reaches', async () => {
  const f = await agentInChosenFolder()
  writeFileSync(join(f.worktree, 'a.txt'), 'first edit, never committed\n')
  const first = await f.service.prepare(f.input)
  expect(first.snapshotSha).toBeTruthy()
  // The files change again before the retirement goes ahead, and it is prepared once more.
  writeFileSync(join(f.worktree, 'a.txt'), 'second edit\n')
  const second = await f.service.prepare(f.input)
  expect(second.snapshotSha).not.toBe(first.snapshotSha)
  const kept = `${first.resultRef.slice(0, -'/result'.length)}/kept/${first.snapshotSha}`
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', '--contains', first.snapshotSha!]).split('\n')).toContain(kept)
  expect(second.keptRefs).toContain(kept)
  git(f.repo, ['gc', '--prune=now', '-q'])
  expect(git(f.repo, ['cat-file', '-p', `${first.snapshotSha}:a.txt`])).toBe('first edit, never committed')
})

// ---- A drive that is not connected ----

test('a chosen folder that is not there pauses only its threads: nothing is marked or rebuilt, other threads go on, and it carries on when the folder is back', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const away = new ThreadWorkspaceManager(f.thread('thread-away'))
  const offlineThread = await away.provision('thread-away', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'On the drive' })
  await f.choose(null, [f.entry])
  const local = new ThreadWorkspaceManager(f.thread('thread-local'))
  await local.provision('thread-local', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'On this disk' })
  const record = readFileSync(away.workspacePath, 'utf8')
  const unplugged = `${f.folder}-unplugged`
  renameSync(f.folder, unplugged)
  expect(await disconnectedWorktreeFolder(offlineThread.worktreePath)).toBe(f.folder)
  const resolver = new WorkspaceResolver(away.threadDirectory, 'thread-away', f.repo, 'worktree')
  await expect(resolver.resolve('agent')).rejects.toThrow(`Drive not connected: ${f.folder}`)
  await expect(away.restore(f.repo)).rejects.toThrow(DriveNotConnectedError)
  expect(existsSync(f.folder)).toBe(false)
  expect(readFileSync(away.workspacePath, 'utf8')).toBe(record)
  expect((await new WorkspaceResolver(local.threadDirectory, 'thread-local', f.repo, 'worktree').resolve('agent')).lifecycle).toBe('ready')
  // A new thread meanwhile, with the folder chosen, goes to Mousse's own folder and says so.
  await f.choose(f.entry)
  const made = await new WorkspaceResolver(f.thread('thread-new'), 'thread-new', f.repo, 'worktree').resolve('agent', 'main', undefined, undefined, 'While unplugged')
  expect(made.workspacePath).toBe(join(f.home, 'repositories', f.key, 'worktrees', 'threads', 'thread-new', 'main'))
  expect(made.startNote).toContain(`The worktree folder ${f.folder} is not connected`)
  const waiting = waitForWorktreeFolder(f.folder, undefined, 20)
  renameSync(unplugged, f.folder)
  await waiting
  const back = await resolver.resolve('agent')
  expect(back.lifecycle).toBe('ready')
  expect(back.workspacePath).toBe(offlineThread.worktreePath)
})

test('a drive that is not connected never blocks cleanup in another repository, and its own worktree is left as it is', async () => {
  const f = await agentInChosenFolder()
  const otherRepo = join(f.root, 'other'); mkdirSync(otherRepo)
  git(otherRepo, ['init', '-q']); git(otherRepo, ['config', 'user.email', 'test@example.com']); git(otherRepo, ['config', 'user.name', 'Test'])
  writeFileSync(join(otherRepo, 'b.txt'), 'other\n'); git(otherRepo, ['add', '.']); git(otherRepo, ['commit', '-qm', 'base'])
  const drive = await checkWorktreeFolder(join(f.other, 'Drive'), f.home)
  await f.choose(drive, [f.entry])
  const away = await provisioned(f, f.store, 'away', 'On the drive', otherRepo)
  renameSync(drive.path, `${drive.path}-unplugged`)
  await f.service.prepare(f.input)
  expect((await f.service.retire(f.path)).state).toBe('trashed')
  await f.service.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  renameSync(`${drive.path}-unplugged`, drive.path)
  expect((await new ThreadWorkspaceManager(away.location).verify()).lifecycle).toBe('ready')
  expect(readFileSync(join(away.metadata.worktreePath, 'b.txt'), 'utf8')).toBe('other\n')
})

test("a thread of the same repository on a drive that is not connected keeps that repository's checkouts where they are, and is named", async () => {
  const f = await agentInChosenFolder()
  const drive = await checkWorktreeFolder(join(f.other, 'Drive'), f.home)
  await f.choose(drive, [f.entry])
  // Made as a provision makes it (the fixture holds the repository's lease, which a provision would wait for).
  const base = await placeAgentWorktreeBase({ home: f.home, folder: drive.path, repositoryId: f.key, projectName: 'shop' })
  const worktree = join(dirname(base), `on-the-drive-${threadTag('away')}`)
  git(f.repo, ['worktree', 'add', '-q', '-b', 'mousse/on-the-drive', worktree])
  const sha = git(f.repo, ['rev-parse', 'HEAD'])
  const location = f.thread('away')
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'away', name: 'On the drive' })); writeFileSync(join(location, 'messages.json'), '[]')
  writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: 'away', worktreePath: worktree, branch: 'mousse/on-the-drive', repositoryId: f.key, retainedRef: 'refs/mousse/threads/away/main', baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: f.repo }, lifecycle: 'ready' }))
  f.store.registerTask({ taskId: 'away', location })
  renameSync(drive.path, `${drive.path}-unplugged`)
  await f.service.prepare(f.input)
  await expect(f.service.retire(f.path)).rejects.toThrow(`Thread “On the drive” has a worktree Mousse can’t check: ${worktree}.`)
  expect(existsSync(f.worktree)).toBe(true)
  renameSync(`${drive.path}-unplugged`, drive.path)
  expect((await f.service.retire(f.path)).state).toBe('trashed')
})

test('a Stop ends the wait for a drive that is not connected', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  renameSync(f.folder, `${f.folder}-unplugged`)
  const stop = new AbortController()
  const waiting = waitForWorktreeFolder(f.folder, stop.signal, 20)
  stop.abort(new DOMException('Thread stopped', 'AbortError'))
  await expect(waiting).rejects.toThrow('Thread stopped')
})

// ---- Agents ----

test('agent worktrees of a dispatch go to the chosen folder and are cleaned up there', async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const manager = new WorktreeManager(f.repo, f.home)
  const info = await manager.createWorktree('dispatch-one', f.repo, undefined, undefined, { worktreeFolder: f.folder })
  expect(info.path).toBe(join(f.repositoryFolder, 'agents', 'dispatch-one'))
  expect(manager.isValidatedAgentWorktreePath(info.path)).toBe(true)
  // Cleanup renames the folder beside itself, in the chosen folder and so on its drive, before it deletes it.
  const renamed: string[] = []
  expect(await manager.cleanupValidatedAgentWorktree(info, { keepIgnored: { owner: f.thread('dispatch-owner'), deleteIgnored: true, record: (step) => { if (step.phase === 'deleting') renamed.push(step.path) } } })).toMatchObject({ success: true })
  expect(renamed).toEqual([expect.stringMatching(/\/\.deleting-[a-f0-9]{16}$/)])
  expect(dirname(renamed[0]!)).toBe(join(f.repositoryFolder, 'agents'))
  expect(manager.isValidatedAgentWorktreePath(renamed[0]!)).toBe(true)
  expect(existsSync(info.path)).toBe(false)
  expect(existsSync(renamed[0]!)).toBe(false)
})

test("a workflow's isolated agents get their worktrees in the chosen folder", async () => {
  const f = await fixture()
  await f.choose(f.entry)
  const directory = f.thread('workflow-parent')
  await new ThreadWorkspaceManager(directory).provision('workflow-parent', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Parent' })
  const context = { profileId: 'test', threadId: 'workflow-parent', projectId: 'project' }
  const owner = { profileId: 'test', threads: { getThread: () => ({ id: 'workflow-parent', projectId: 'project' }), getThreadDir: () => directory }, projects: { getProject: () => ({ id: 'project', path: f.repo }) } }
  const registrationRoot = join(f.home, 'workflow-agent-bindings', 'workspaces')
  const made = await provisionOwnedAgentWorkspace({ owner, context, idempotencyKey: 'worker', registrationRoot, scratchRoot: registrationRoot } as never)
  expect(made.worktreePath.startsWith(join(f.repositoryFolder, 'agents') + '/')).toBe(true)
  expect(git(made.worktreePath, ['rev-parse', '--show-toplevel'])).toBe(made.worktreePath)
})

// ---- File modes ----

test("Mousse's own Git never overrides core.fileMode", async () => {
  const f = await fixture()
  await f.choose(f.entry)
  expect(repoProgramSettings(f.repo).some((setting) => setting.startsWith('core.fileMode'))).toBe(false)
})

/**
 * Opt-in (`MOUSSE_TEST_SECOND_VOLUME=1`, macOS): real second volumes. An exFAT disk image keeps no file modes, so it is
 * refused when chosen, by name; an APFS one is accepted, and the trash round trip stays on it, byte for byte.
 */
test.runIf(process.platform === 'darwin' && process.env.MOUSSE_TEST_SECOND_VOLUME === '1')('on real second volumes: exFAT is refused, and on APFS the trash round trip stays on that drive', async () => {
  const volume = (fs: string, name: string): string => {
    const images = scratch(`mousse-volume-${name}-`)
    const mount = join(images, 'mnt'); mkdirSync(mount)
    execFileSync('hdiutil', ['create', '-quiet', '-size', '64m', '-fs', fs, '-volname', name, '-o', join(images, 'volume.dmg')])
    execFileSync('hdiutil', ['attach', '-quiet', '-nobrowse', '-mountpoint', mount, join(images, 'volume.dmg')])
    releases.push(() => execFileSync('hdiutil', ['detach', '-quiet', '-force', mount]))
    return mount
  }
  const f = await fixture()
  const exfat = volume('ExFAT', 'MousseFAT')
  await expect(checkWorktreeFolder(join(exfat, 'Worktrees'), f.home)).rejects.toThrow("This drive (exFAT) can't store file permissions, which Git worktrees need. Pick a folder on an APFS, HFS+, NTFS or ext4 drive.")
  expect(existsSync(join(exfat, 'Worktrees'))).toBe(false)
  const apfs = volume('APFS', 'MousseAPFS')
  const entry = await checkWorktreeFolder(join(apfs, 'Worktrees'), f.home)
  await f.choose(entry)
  const store = storeOf(f)
  const a = await provisioned(f, store, 'thread-a', 'On the drive')
  expect(lstatSync(a.metadata.worktreePath).dev).not.toBe(lstatSync(f.home).dev)
  writeFileSync(join(a.metadata.worktreePath, 'a.txt'), 'edited on the drive\n')
  const before = filesOf(a.metadata.worktreePath)
  await retireAndExpire(f, store, a)
  const context = await new WorkspaceResolver(a.location, 'thread-a', f.repo, 'worktree').resolve('agent')
  expect(filesOf(context.workspacePath)).toEqual(before)
}, 120_000)
