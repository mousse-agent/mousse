import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, renameSync, cpSync, readFileSync, readdirSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, chmodSync, openSync, closeSync, writeSync, ftruncateSync, constants as fsConstants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { keptAsideNotice, WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { keptCopyWindowMs } from '../src/mms/actions/keptCopies'
import { retentionWindowText } from '../src/shared/undoRetention'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { unverifiableThread } from './support/unverifiableThread'

/** Git lists worktrees with forward slashes on every platform; paths are compared in that form, and case-folded on Windows. */
const slashes = (path: string): string => { const value = resolve(path).replaceAll('\\', '/'); return process.platform === 'win32' ? value.toLowerCase() : value }
const listed = (repo: string): string[] => git(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => slashes(line.slice(9)))
const roots: string[] = []
const releases: Array<() => unknown> = []
// Each test here runs Git dozens of times. Starting a process on the Windows runner takes several times longer, so its
// tests take 10 to 17 seconds there against the 20-second default; they get room, and nothing here waits on a timer.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 })
afterEach(() => { for (const release of releases.splice(0)) release(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(sparse = false, crlf = false) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-retire-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); writeFileSync(join(repo, 'b.txt'), 'second\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base'])
  if (crlf) {
    git(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(join(repo, '.gitattributes'), 'value.txt text eol=crlf\n'); writeFileSync(join(repo, 'value.txt'), 'first\nsecond\n')
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'explicit checkout line endings'])
  }
  const home = join(root, 'profile'), task = join(home, 'thread-data', 'task'); mkdirSync(task, { recursive: true }); releases.push(ownedHome(home))
  writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location: task })
  const worktree = join(home, 'repositories', resolveRepositoryIdentity(repo).key, 'worktrees', 'agents', 'worker'), branch = 'mousse/agent/worker'
  mkdirSync(join(worktree, '..'), { recursive: true })
  git(repo, ['worktree', 'add', ...(sparse ? ['--no-checkout'] : []), '-b', branch, worktree])
  if (sparse) {
    git(worktree, ['sparse-checkout', 'set', '--no-cone', '--stdin'], 'a.txt\n'); git(worktree, ['checkout', 'HEAD'])
    mkdirSync(join(worktree, '.mousse')); const exclude = join(worktree, '.mousse', 'materialized-inputs.exclude')
    writeFileSync(exclude, '.mousse/\nnode_modules\n\n'); git(worktree, ['config', '--worktree', 'core.excludesFile', exclude])
  }
  const sourcePath = join(task, 'agents.json'); writeFileSync(sourcePath, JSON.stringify([{ id: 'worker', worktreePath: worktree, branch }]))
  registerThreadLifecycleGate(home, store)
  const taskLease = await waitAcquireExecutionLease(task), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repo))
  const ownership = { taskLease, repositoryLease }
  releases.push(() => repositoryLease.release(), () => releaseExecutionLeaseHandle(taskLease))
  const service = new WorktreeRetirementService(store, ownership)
  return { root, repo, home, worktree, branch, store, service, ownership, input: { taskId: 'task', worktreePath: worktree, branch, sourcePath }, path: service.pathFor('task', worktree) }
}
test.each([false, true])('retire and reconstruct clean checkout including selective sparse controls (%s)', async (sparse) => {
  const f = await fixture(sparse)
  await f.service.prepare(f.input); await f.service.retire(f.path); expect(existsSync(f.worktree)).toBe(false)
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  await restarted.reconstruct(f.path); expect(existsSync(join(f.worktree, 'a.txt'))).toBe(true)
  expect(existsSync(join(f.worktree, 'b.txt'))).toBe(!sparse)
  expect(git(f.repo, ['status', '--porcelain'])).toBe('')
})
test('ignored sole copy, hidden index flags and changed content block retirement', async () => {
  const f = await fixture(true)
  writeFileSync(join(f.worktree, '.mousse', 'secret'), 'not captured')
  await expect(f.service.prepare(f.input)).rejects.toThrow(/Uncaptured/)
  rmSync(join(f.worktree, '.mousse', 'secret'))
  git(f.worktree, ['update-index', '--assume-unchanged', 'a.txt'])
  await expect(f.service.prepare(f.input)).rejects.toThrow(/flags/)
  git(f.worktree, ['update-index', '--no-assume-unchanged', 'a.txt'])
  // A write after the checks moves with the folder into the trash; the trash keeps it there, since no snapshot can hold it.
  await f.service.prepare(f.input); writeFileSync(join(f.worktree, '.mousse', 'secret'), 'late copy')
  const trashed = await f.service.retire(f.path)
  expect(trashed.state).toBe('trashed')
  expect(readFileSync(join(trashed.trashPath!, '.mousse', 'secret'), 'utf8')).toBe('late copy')
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ kept: expect.stringMatching(/^Kept in the trash at .*requires retention/) })
  expect(readFileSync(join(trashed.trashPath!, '.mousse', 'secret'), 'utf8')).toBe('late copy')
})

test('retirement moves the folder into the trash in one step, and a restore moves it back as it is', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  // Written after the checks: a process that keeps its working directory in the worktree.
  writeFileSync(join(f.worktree, 'late.txt'), 'late write\n')
  const trashed = await f.service.retire(f.path)
  expect(existsSync(f.worktree)).toBe(false)
  expect(trashed.trashPath).toBe(f.service.trashPathFor(trashed))
  expect(readFileSync(join(trashed.trashPath!, 'late.txt'), 'utf8')).toBe('late write\n')
  // Git follows the move, and the folder is still a working checkout on its branch.
  expect(listed(f.repo)).toContain(slashes(trashed.trashPath!))
  expect(git(trashed.trashPath!, ['branch', '--show-current'])).toBe(f.branch)
  expect(git(trashed.trashPath!, ['status', '--porcelain', '--untracked-files=all'])).toBe('?? late.txt')
  // Checked out in the trash, so the branch is kept for now.
  expect(git(f.repo, ['rev-parse', '--verify', `refs/heads/${f.branch}`])).toBe(trashed.resultSha)
  // Waiting, and nothing in it is old enough yet: the trash keeps it.
  expect(await f.service.expireTrash(f.path)).toEqual({ kept: 'Waiting in the trash', waiting: true })
  await f.service.reconstruct(f.path)
  expect(existsSync(trashed.trashPath!)).toBe(false)
  expect(readFileSync(join(f.worktree, 'late.txt'), 'utf8')).toBe('late write\n')
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
  expect(listed(f.repo)).toContain(slashes(f.worktree))
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({ state: 'materialized' })
})

test('trash expiry snapshots the folder, deletes it and its branch, and a restore rebuilds both with the same files', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  // Changed in the trash after the move: the expiry snapshot is taken from the folder as it is then.
  writeFileSync(join(trashed.trashPath!, 'a.txt'), 'edited in the trash\n'); writeFileSync(join(trashed.trashPath!, 'new.txt'), 'new\n')
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  expect(await f.service.expireTrash(f.path, { now: later, inUse: () => 'Files in this worktree are in use' })).toEqual({ kept: 'Files in this worktree are in use' })
  expect(existsSync(trashed.trashPath!)).toBe(true)
  expect(await f.service.expireTrash(f.path, { now: later })).toEqual({ removed: true })
  expect(existsSync(trashed.trashPath!)).toBe(false)
  expect(listed(f.repo)).not.toContain(slashes(trashed.trashPath!))
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(retired).toMatchObject({ state: 'retired', deletedBranches: [{ name: f.branch, sha: trashed.resultSha }] })
  expect(retired.trashPath).toBeUndefined()
  // The branch is gone; its tip is the HEAD the pins keep, and the snapshot holds the files.
  expect(git(f.repo, ['branch', '--list', f.branch])).toBe('')
  expect(git(f.repo, ['show', `${retired.snapshotRef}:a.txt`])).toBe('edited in the trash')
  expect(git(f.repo, ['rev-parse', `${retired.snapshotRef}^`])).toBe(trashed.resultSha)
  await f.service.reconstruct(f.path)
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited in the trash\n')
  expect(readFileSync(join(f.worktree, 'new.txt'), 'utf8')).toBe('new\n')
})

test('trash expiry asks whether the folder is in use before its snapshot, so a write that slips in then is in the snapshot', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  expect(await f.service.expireTrash(f.path, { now: later, inUse: (path) => { writeFileSync(join(path, 'a.txt'), 'written during the check\n'); return undefined } })).toEqual({ removed: true })
  expect(existsSync(trashed.trashPath!)).toBe(false)
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(git(f.repo, ['show', `${retired.snapshotRef}:a.txt`])).toBe('written during the check')
})

test('trash expiry reads the folder again before deleting it: a change since its snapshot is captured and the delete waits', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  const outcome = await f.service.expireTrash(f.path, { now: later, afterCapture: (path) => writeFileSync(join(path, 'b.txt'), 'written after the snapshot\n') })
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted.*kept as a snapshot.*next run/), waiting: true })
  expect(readFileSync(join(trashed.trashPath!, 'b.txt'), 'utf8')).toBe('written after the snapshot\n')
  const manifest = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(manifest.state).toBe('trashed')
  expect(git(f.repo, ['show', `${manifest.snapshotRef}:b.txt`])).toBe('written after the snapshot')
  // With nothing changing any more, a later run deletes it.
  expect(await f.service.expireTrash(f.path, { now: later + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
})

test('trash expiry deletes only what its snapshot holds: a write while the capture checks its pins keeps the folder', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  // The second check of the pins is the one at the end of the capture: after the snapshot and the proof of its contents.
  const verifyPins = f.service.verifyPins.bind(f.service)
  let checks = 0
  vi.spyOn(f.service, 'verifyPins').mockImplementation(async (manifest) => {
    checks += 1
    if (checks === 2) writeFileSync(join(trashed.trashPath!, 'a.txt'), 'written while the pins were checked\n')
    return verifyPins(manifest)
  })
  const outcome = await f.service.expireTrash(f.path, { now: later })
  expect(checks).toBeGreaterThanOrEqual(2)
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  expect(readFileSync(join(trashed.trashPath!, 'a.txt'), 'utf8')).toBe('written while the pins were checked\n')
  // The write is captured now, so nothing of it is lost when a later run deletes the folder.
  const manifest = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(git(f.repo, ['show', `${manifest.snapshotRef}:a.txt`])).toBe('written while the pins were checked')
})

test('trash expiry checks the folder again right before Git deletes it: a write after its last read keeps the folder', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  // The repository lease is read last right before the delete: after the folder was compared with the snapshot.
  const service = f.service as unknown as { readRepositoryLease(): Promise<unknown> }
  const readLease = service.readRepositoryLease.bind(service)
  let reads = 0
  vi.spyOn(service, 'readRepositoryLease').mockImplementation(async () => {
    reads += 1
    if (reads === 2) writeFileSync(join(trashed.trashPath!, 'b.txt'), 'written right before the delete\n')
    return readLease()
  })
  const outcome = await f.service.expireTrash(f.path, { now: later })
  expect(reads).toBe(2)
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  expect(readFileSync(join(trashed.trashPath!, 'b.txt'), 'utf8')).toBe('written right before the delete\n')
})

test('trash expiry never writes back a record a permanent deletion removed meanwhile, and deletes nothing then', async () => {
  const f = await fixture()
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  // Between the snapshot and the delete, a purge removes the record (it does so under its reservation, without this lease).
  const outcome = await f.service.expireTrash(f.path, { now: later, afterCapture: () => rmSync(f.path) })
  expect(outcome).toEqual({ kept: expect.stringMatching(/record changed while it was being deleted/), waiting: true })
  expect(existsSync(f.path)).toBe(false)
  expect(existsSync(join(trashed.trashPath!, 'a.txt'))).toBe(true)
})

test('an owned branch name that is a symbolic ref is never followed: the branch it points at stays', async () => {
  const f = await fixture()
  const main = git(f.repo, ['symbolic-ref', '--short', 'HEAD']), mainSha = git(f.repo, ['rev-parse', main])
  git(f.worktree, ['switch', '-q', '--detach'])
  git(f.repo, ['symbolic-ref', `refs/heads/${f.branch}`, `refs/heads/${main}`])
  await f.service.prepare(f.input)
  await f.service.retire(f.path)
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(git(f.repo, ['rev-parse', main])).toBe(mainSha)
  expect(git(f.repo, ['symbolic-ref', `refs/heads/${f.branch}`])).toBe(`refs/heads/${main}`)
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toBeUndefined()
})

test('trash expiry never drops an earlier pin: a commit the folder moved away from stays kept, and a restore brings its branch back', async () => {
  const f = await fixture()
  writeFileSync(join(f.worktree, 'a.txt'), 'committed\n'); git(f.worktree, ['commit', '-qam', 'work'])
  const work = git(f.worktree, ['rev-parse', 'HEAD'])
  git(f.worktree, ['switch', '-q', '--detach'])
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  // The branch was not checked out anywhere, so the move released it: only the pin keeps its commit now.
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toEqual([{ name: f.branch, sha: work }])
  // In the trash, the folder goes back to where it started, away from the commit.
  git(trashed.trashPath!, ['checkout', '-q', `${work}^`])
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(retired.keptRefs).toEqual([expect.stringMatching(new RegExp(`/kept/${work}$`))])
  git(f.repo, ['gc', '--prune=now', '-q'])
  expect(git(f.repo, ['cat-file', '-t', work])).toBe('commit')
  await f.service.reconstruct(f.path)
  expect(git(f.repo, ['rev-parse', `refs/heads/${f.branch}`])).toBe(work)
})

test('a branch the agent made itself, and a worktree the agent added, are never touched', async () => {
  const f = await fixture()
  git(f.worktree, ['switch', '-q', '-c', 'agent/own-work'])
  const own = join(f.root, 'agent-worktree'); git(f.worktree, ['worktree', 'add', '-q', '-b', 'agent/second', own])
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  // The thread's own branch was not checked out anywhere, so it went with the move; the agent's branches stay.
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toEqual([{ name: f.branch, sha: trashed.resultSha }])
  expect(git(f.repo, ['branch', '--list', 'agent/own-work', 'agent/second', '--format=%(refname:short)'])).toBe('agent/own-work\nagent/second')
  expect(readFileSync(join(own, 'a.txt'), 'utf8')).toBe('first\n')
  expect(listed(f.repo)).toContain(slashes(own))
})
test('missing pins never authorize recall or retirement', async () => {
  const f = await fixture(); const manifest = await f.service.prepare(f.input)
  git(f.repo, ['update-ref', '-d', manifest.resultRef, manifest.resultSha])
  await expect(f.service.retire(f.path)).rejects.toThrow()
  expect(existsSync(resolve(f.worktree))).toBe(true)
})

test('a byte-identical externally replaced checkout fails frozen root identity', async () => {
  const f = await fixture(); await f.service.prepare(f.input)
  const original = join(f.root, 'original-checkout'); renameSync(f.worktree, original); cpSync(original, f.worktree, { recursive: true })
  expect(git(f.worktree, ['status', '--porcelain'])).toBe('')
  await expect(f.service.retire(f.path)).rejects.toThrow(/identity|replaced|changed/i)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('first\n')
})

test('empty directory shape is reproduced and a malformed manifest fails before reconstruction', async () => {
  const f = await fixture(); mkdirSync(join(f.worktree, 'empty', 'nested'), { recursive: true })
  const manifest = await f.service.prepare(f.input); await f.service.retire(f.path)
  writeFileSync(f.path, JSON.stringify({ ...manifest, checkoutFingerprint: 'unverified' }))
  await expect(f.service.reconstruct(f.path)).rejects.toThrow(/Manifest/)
  expect(existsSync(f.worktree)).toBe(false)
  writeFileSync(f.path, JSON.stringify(manifest)); await f.service.reconstruct(f.path)
  expect(existsSync(join(f.worktree, 'empty', 'nested'))).toBe(true)
})

test('an outside-root Mousse-named linked checkout remains retained even with a forged matching agent row', async () => {
  const f = await fixture(), foreign = join(f.root, 'user-checkout'), branch = 'mousse/agent/outside'
  git(f.repo, ['worktree', 'add', '-b', branch, foreign])
  writeFileSync(f.input.sourcePath, JSON.stringify([{ id: 'outside', worktreePath: foreign, branch }]))
  await expect(f.service.prepare({ ...f.input, branch, worktreePath: foreign })).rejects.toThrow(/generated workspace location/)
  await expect(f.service.inspectForDiscard({ ...f.input, branch, worktreePath: foreign })).rejects.toThrow(/generated workspace location/)
  expect(readFileSync(join(foreign, 'a.txt'), 'utf8')).toBe('first\n')
})

test('direct retirement preserves a checkout still referenced by another task', async () => {
  const f = await fixture(); await f.service.prepare(f.input)
  const peer = join(f.home, 'thread-data', 'peer'); mkdirSync(peer, { recursive: true })
  writeFileSync(join(peer, 'meta.json'), JSON.stringify({ id: 'peer' }))
  writeFileSync(join(peer, 'agents.json'), JSON.stringify([{ id: 'worker', branch: f.branch, worktreePath: f.worktree, status: 'ready' }]))
  f.store.registerTask({ taskId: 'peer', location: peer })
  await expect(f.service.retire(f.path)).rejects.toThrow(/Another task/)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
})

test('a claim by another task that appears while retirement waits stops the move: the claims are read again right before it', async () => {
  const f = await fixture(); await f.service.prepare(f.input)
  const peer = join(f.home, 'thread-data', 'peer')
  // The second pin check comes after the first claims check; the other task names this checkout from then on.
  const verifyPins = WorktreeRetirementService.prototype.verifyPins
  let calls = 0
  const spy = vi.spyOn(WorktreeRetirementService.prototype, 'verifyPins').mockImplementation(async function (this: WorktreeRetirementService, manifest) {
    await verifyPins.call(this, manifest)
    if (++calls === 2) {
      mkdirSync(peer, { recursive: true })
      writeFileSync(join(peer, 'meta.json'), JSON.stringify({ id: 'peer' }))
      writeFileSync(join(peer, 'agents.json'), JSON.stringify([{ id: 'worker', branch: f.branch, worktreePath: f.worktree, status: 'ready' }]))
      f.store.registerTask({ taskId: 'peer', location: peer })
    }
  })
  try {
    await expect(f.service.retire(f.path)).rejects.toThrow(/Another task/)
  } finally { spy.mockRestore() }
  expect(calls).toBeGreaterThanOrEqual(2)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(f.service.load(f.path).trashPath).toBeUndefined()
})

test('a thread whose worktree points at a deleted and recreated repository does not stop moving a checkout of another repository to the trash', async () => {
  const f = await fixture(); await f.service.prepare(f.input)
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: join(f.root, 'other-repo'), how: 'recreated' })
  await f.service.retire(f.path)
  expect(existsSync(f.worktree)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.worktree))
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  await restarted.reconstruct(f.path); expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(readFileSync(join(broken.worktree, 'a.txt'), 'utf8')).toBe('first\n')
}, 60_000)

test('a broken thread in the same repository keeps the checkout where it is, and the refusal names that thread', async () => {
  const f = await fixture(); await f.service.prepare(f.input)
  writeFileSync(join(f.worktree, 'a.txt'), 'edited\n')
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: f.repo, how: 'unlinked' })
  await expect(f.service.retire(f.path)).rejects.toThrow(`Thread “Fix prices” has a worktree Mousse can’t check: ${broken.worktree}. This checkout is kept until Mousse can check that worktree again.`)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited\n'); expect(listed(f.repo)).toContain(slashes(f.worktree))
  expect(f.service.load(f.path).trashPath).toBeUndefined()
}, 60_000)

test("the caller's own check runs right before the move, and a refusal there moves nothing", async () => {
  const f = await fixture(); await f.service.prepare(f.input)
  await expect(f.service.retire(f.path, { beforeMove: () => { throw new Error('Thread became busy') } })).rejects.toThrow('Thread became busy')
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(f.service.load(f.path)).toMatchObject({ state: 'prepared' })
  expect(f.service.load(f.path).trashPath).toBeUndefined()
})

test('retains Git-clean mixed line endings that checkout cannot reconstruct byte for byte', async () => {
  const f = await fixture(false, true)
  const path = join(f.worktree, 'value.txt')
  const soleCopy = Buffer.from('first\r\nsecond\n')
  writeFileSync(path, soleCopy)
  // Refresh the index stat cache through an ordinary user staging operation;
  // the normalized blob remains identical to HEAD and creates no staged diff.
  git(f.worktree, ['add', 'value.txt'])
  expect(git(f.worktree, ['diff', '--cached', '--name-only'])).toBe('')
  expect(git(f.worktree, ['status', '--porcelain'])).toBe('')
  expect(git(f.worktree, ['hash-object', '--stdin-paths'], JSON.stringify(path.replaceAll('\\', '/')) + '\n'))
    .toBe(git(f.worktree, ['rev-parse', 'HEAD:value.txt']))
  await expect(f.service.prepare(f.input), 'Clean-filter equivalence cannot authorize loss of the original materialized bytes').rejects.toThrow(/reconstruct.*exact|materialized/i)
  expect(readFileSync(path)).toEqual(soleCopy)
})

test('retires canonical CRLF materialization and reconstructs exactly the same bytes after service restart', async () => {
  const f = await fixture(false, true)
  const original = readFileSync(join(f.worktree, 'value.txt'))
  expect(original).toEqual(Buffer.from('first\r\nsecond\r\n'))
  const primaryHead = git(f.repo, ['rev-parse', 'HEAD'])
  await f.service.prepare(f.input); await f.service.retire(f.path)
  expect(existsSync(f.worktree)).toBe(false)
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  await restarted.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'value.txt'))).toEqual(original)
  expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(primaryHead)
})

test('refuses a reconstruction pin redirected to a primary branch before updating retained results', async () => {
  const f = await fixture(false, true)
  const manifest = await f.service.prepare(f.input)
  const primary = git(f.repo, ['symbolic-ref', 'HEAD']), original = git(f.repo, ['rev-parse', primary])
  writeFileSync(join(f.worktree, 'value.txt'), 'new child result\r\n')
  git(f.worktree, ['add', 'value.txt']); git(f.worktree, ['commit', '-qm', 'new child result'])
  git(f.repo, ['symbolic-ref', manifest.resultRef, primary])
  await expect(f.service.prepare(f.input)).rejects.toThrow(/symbolic|pin|reference/i)
  expect(git(f.repo, ['rev-parse', primary])).toBe(original)
  expect(git(f.repo, ['symbolic-ref', manifest.resultRef])).toBe(primary)
})

/**
 * A thread's own worktree, as `ThreadWorkspaceManager.provision` makes it (its branch named from the first message), or as
 * an earlier version made it (an id-named `mousse/thread/<thread>/main`, with the same records).
 */
async function threadFixture(kind: 'named' | 'id-named') {
  const root = mkdtempSync(join(tmpdir(), 'mousse-retire-thread-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base'])
  const home = join(root, 'profile'), task = join(home, 'thread-data', 'task'); mkdirSync(task, { recursive: true }); releases.push(ownedHome(home))
  writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location: task })
  registerThreadLifecycleGate(home, store)
  const previous = process.env.MOUSSE_HOME; process.env.MOUSSE_HOME = home
  releases.push(() => { if (previous === undefined) delete process.env.MOUSSE_HOME; else process.env.MOUSSE_HOME = previous })
  let worktree: string, branch: string
  if (kind === 'named') {
    const metadata = await new ThreadWorkspaceManager(task).provision('task', 'main', repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    worktree = metadata.worktreePath; branch = metadata.branch
  } else {
    worktree = join(home, 'repositories', resolveRepositoryIdentity(repo).key, 'worktrees', 'threads', 'task', 'main'); branch = 'mousse/thread/task/main'
    mkdirSync(join(worktree, '..'), { recursive: true })
    new ThreadJournal(task).append({ operationId: 'provision', operationType: 'workspace-provision', state: 'planned', expectedPreState: { branch, worktreePath: worktree } })
    git(repo, ['worktree', 'add', '-b', branch, worktree])
    writeFileSync(join(task, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: 'task', conversationBranchId: 'main', worktreePath: worktree, branch, baseSha: git(repo, ['rev-parse', 'HEAD']) }))
  }
  const taskLease = await waitAcquireExecutionLease(task), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(repo))
  releases.push(() => repositoryLease.release(), () => releaseExecutionLeaseHandle(taskLease))
  const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
  return { repo, task, worktree, branch, service, input: { taskId: 'task', worktreePath: worktree, branch, sourcePath: join(task, 'workspace.json') }, path: service.pathFor('task', worktree), releaseLeases: () => { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) } }
}

test.each(['named', 'id-named'] as const)('a thread worktree whose branch is %s is owned: it retires, its branch goes at trash expiry, and a restore brings both back', async (kind) => {
  const f = await threadFixture(kind)
  expect(f.branch).toBe(kind === 'named' ? 'mousse/fix-the-login-button' : 'mousse/thread/task/main')
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toEqual([{ name: f.branch, sha: trashed.resultSha }])
  expect(git(f.repo, ['branch', '--list', f.branch])).toBe('')
  await f.service.reconstruct(f.path)
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
})

test('a thread\'s agent-made branches are never touched, a mousse/ one included, unless it is an id-named one of Mousse\'s', async () => {
  const f = await threadFixture('named')
  // The agent switches to a branch of its own whose name happens to start with mousse/, and makes another outside it.
  git(f.worktree, ['switch', '-q', '-c', 'mousse/agents-own-idea'])
  git(f.worktree, ['branch', 'feature/agent-work'])
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  expect(trashed.headBranch).toBe('mousse/agents-own-idea')
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  // Only the thread's own branch went; the branches the agent made stay where they were.
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toEqual([{ name: f.branch, sha: git(f.repo, ['rev-parse', 'mousse/agents-own-idea']) }])
  expect(git(f.repo, ['branch', '--list', 'mousse/agents-own-idea', 'feature/agent-work', '--format=%(refname:short)'])).toBe('feature/agent-work\nmousse/agents-own-idea')
})

test('a thread record that names a branch outside mousse/, or another thread\'s id-named branch, owns nothing', async () => {
  const f = await threadFixture('id-named')
  git(f.repo, ['branch', 'feature/theirs'])
  await expect(f.service.prepare({ ...f.input, branch: 'feature/theirs' })).rejects.toThrow(/Only owned linked worktrees can retire|no longer owns/)
  const record = JSON.parse(readFileSync(join(f.task, 'workspace.json'), 'utf8'))
  writeFileSync(join(f.task, 'workspace.json'), JSON.stringify({ ...record, branch: 'mousse/thread/other-task/main' }))
  // Not this thread's provision record, and not a fork of it either: refused before anything moves.
  await expect(f.service.prepare({ ...f.input, branch: 'mousse/thread/other-task/main' })).rejects.toThrow()
  expect(existsSync(f.worktree)).toBe(true)
  expect(git(f.repo, ['branch', '--list', 'feature/theirs', '--format=%(refname:short)'])).toBe('feature/theirs')
})

test("trash expiry keeps Git's own data of the worktree, and a rebuild brings back its configuration, HEAD history and own refs", async () => {
  const f = await threadFixture('named')
  const original = git(f.worktree, ['rev-parse', 'HEAD'])
  // A commit on a detached HEAD, then back: only the worktree's HEAD history names it.
  git(f.worktree, ['checkout', '-q', '--detach']); writeFileSync(join(f.worktree, 'a.txt'), 'unique abandoned commit\n'); git(f.worktree, ['commit', '-qam', 'abandoned user commit'])
  const abandoned = git(f.worktree, ['rev-parse', 'HEAD']); git(f.worktree, ['reset', '-q', '--hard', original])
  // A commit only a ref of the worktree's own names.
  const own = git(f.worktree, ['commit-tree', `${original}^{tree}`, '-p', original, '-m', 'named only by a worktree ref'])
  git(f.worktree, ['update-ref', 'refs/worktree/mine', own])
  git(f.repo, ['config', 'extensions.worktreeConfig', 'true']); git(f.worktree, ['config', '--worktree', 'audit.note', 'unique worktree configuration'])
  const adminDir = git(f.worktree, ['rev-parse', '--absolute-git-dir'])
  // A file Git may add there one day: kept as it is.
  const future = Buffer.from([0, 1, 2, 255, 10, 13, 0x6d]); writeFileSync(join(adminDir, 'future-data'), future)
  const configBytes = readFileSync(join(adminDir, 'config.worktree')), reflogBytes = readFileSync(join(adminDir, 'logs', 'HEAD')), refBytes = readFileSync(join(adminDir, 'refs', 'worktree', 'mine'))
  expect(reflogBytes.toString('utf8')).toContain(abandoned)
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  // A lock someone puts on the worktree in the trash as its capture starts is not kept. It is lifted once the capture is
  // done, so the folder is deleted. (A lock there before the run keeps the worktree in the trash without a capture.)
  const trashedAdmin = git(trashed.trashPath!, ['rev-parse', '--absolute-git-dir'])
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS, inUse: () => { writeFileSync(join(trashedAdmin, 'locked'), 'stale lock\n'); return undefined }, afterCapture: () => rmSync(join(trashedAdmin, 'locked')) })).toEqual({ removed: true })
  expect(existsSync(trashedAdmin)).toBe(false)
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  const kept = git(f.repo, ['ls-tree', '-r', '--name-only', retired.adminTree]).split('\n')
  expect(kept).toEqual(expect.arrayContaining(['config.worktree', 'logs/HEAD', 'refs/worktree/mine', 'future-data']))
  expect(kept).not.toContain('locked'); expect(kept).not.toContain('gitdir')
  // Nothing outside the pins names the two commits any more; garbage collection keeps them.
  git(f.repo, ['reflog', 'expire', '--expire=now', '--all']); git(f.repo, ['gc', '--prune=now', '-q'])
  for (const sha of [abandoned, own]) expect(git(f.repo, ['cat-file', '-t', sha])).toBe('commit')
  await f.service.reconstruct(f.path)
  const rebuiltAdmin = git(f.worktree, ['rev-parse', '--absolute-git-dir'])
  expect(git(f.worktree, ['config', '--worktree', '--get', 'audit.note'])).toBe('unique worktree configuration')
  expect(readFileSync(join(rebuiltAdmin, 'config.worktree'))).toEqual(configBytes)
  // The kept history comes first, then what the rebuild recorded.
  expect(readFileSync(join(rebuiltAdmin, 'logs', 'HEAD')).subarray(0, reflogBytes.length)).toEqual(reflogBytes)
  expect(git(f.worktree, ['reflog', 'show', '--format=%H', 'HEAD']).split('\n')).toContain(abandoned)
  expect(readFileSync(join(rebuiltAdmin, 'refs', 'worktree', 'mine'))).toEqual(refBytes)
  expect(git(f.worktree, ['rev-parse', 'refs/worktree/mine'])).toBe(own)
  expect(readFileSync(join(rebuiltAdmin, 'future-data'))).toEqual(future)
  expect(existsSync(join(rebuiltAdmin, 'locked'))).toBe(false)
  expect(git(f.repo, ['worktree', 'list', '--porcelain'])).not.toMatch(/^locked/m)
  expect(git(f.worktree, ['status', '--porcelain'])).toBe('')
})

test("a rebuild puts the kept configuration in place before the untrusted checkout's safety settings, which still win", async () => {
  const f = await fixture()
  git(f.repo, ['config', 'extensions.worktreeConfig', 'true'])
  git(f.worktree, ['config', '--worktree', 'audit.note', 'kept']); git(f.worktree, ['config', '--worktree', 'core.hooksPath', join(f.root, 'hooks-from-before')])
  await f.service.prepare(f.input); await f.service.retire(f.path)
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  let seenAtPrepare: string | undefined
  await f.service.reconstruct(f.path, {
    prepare: (path) => { seenAtPrepare = git(path, ['config', '--worktree', '--get', 'audit.note']); git(path, ['config', '--worktree', 'core.hooksPath', '/dev/null']) },
    env: {}
  })
  expect(seenAtPrepare).toBe('kept')
  expect(git(f.worktree, ['config', '--worktree', '--get', 'core.hooksPath'])).toBe('/dev/null')
})

test("a change to Git's own data of the worktree after its capture is captured again before the delete", async () => {
  const f = await fixture()
  git(f.repo, ['config', 'extensions.worktreeConfig', 'true']); git(f.worktree, ['config', '--worktree', 'audit.note', 'first'])
  await f.service.prepare(f.input); await f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  const outcome = await f.service.expireTrash(f.path, { now: later, afterCapture: (path) => git(path, ['config', '--worktree', 'audit.note', 'written after the capture']) })
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  expect(await f.service.expireTrash(f.path, { now: later + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  // The later capture builds on the earlier one, so neither is dropped.
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(git(f.repo, ['show', `${retired.adminCommit}:config.worktree`])).toContain('written after the capture')
  expect(git(f.repo, ['show', `${retired.adminCommit}^:config.worktree`])).toContain('note = first')
  await f.service.reconstruct(f.path)
  expect(git(f.worktree, ['config', '--worktree', '--get', 'audit.note'])).toBe('written after the capture')
})

// ---- Verified delete: the folder is renamed, compared with its proof, and deleted entry by entry ----

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
const LATER = (): number => Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
const deletingFolders = (trashPath: string): string[] => readdirSync(dirname(trashPath)).filter((name) => name.startsWith('.deleting-'))

/** A worktree in the trash with a changed tracked file, an untracked one in a folder, an ignored binary file and a link. */
async function trashedFixture(extra?: (trashPath: string) => void) {
  const f = await fixture()
  writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'ignored/\n')
  await f.service.prepare(f.input)
  const trashed = await f.service.retire(f.path)
  const trashPath = trashed.trashPath!
  writeFileSync(join(trashPath, 'a.txt'), 'edited in the trash\n')
  mkdirSync(join(trashPath, 'sub')); writeFileSync(join(trashPath, 'sub', 'x.txt'), 'x\n'); writeFileSync(join(trashPath, 'sub', 'y.txt'), 'y\n')
  mkdirSync(join(trashPath, 'ignored')); writeFileSync(join(trashPath, 'ignored', 'cache.bin'), Buffer.from([0, 1, 2, 254, 255, 13, 10]))
  if (process.platform !== 'win32') symlinkSync('a.txt', join(trashPath, 'ignored', 'link'))
  extra?.(trashPath)
  const adminDir = git(trashPath, ['rev-parse', '--absolute-git-dir'])
  return { ...f, trashed, trashPath, adminDir, before: filesOf(trashPath) }
}
const manifestOf = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

test('an unchanged folder is kept, removed entry by entry and unregistered; a restore rebuilds it byte for byte, ignored files included', async () => {
  const f = await trashedFixture()
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  expect(existsSync(f.trashPath)).toBe(false); expect(deletingFolders(f.trashPath)).toEqual([])
  expect(listed(f.repo)).not.toContain(slashes(f.trashPath)); expect(existsSync(f.adminDir)).toBe(false)
  const retired = manifestOf(f.path)
  expect(retired.state).toBe('retired'); expect(retired.deleting).toBeUndefined()
  // The ignored files are in a kept copy owned by the thread's journal, and pinned for as long as the record lasts.
  expect(retired.keptFiles).toEqual([{ sha: expect.any(String), paths: expect.arrayContaining(['ignored/cache.bin']) }])
  expect(retired.keptRefs).toContain(`${retired.resultRef.slice(0, -'/result'.length)}/kept/${retired.keptFiles[0].sha}`)
  const preserved = git(f.repo, ['for-each-ref', '--format=%(objectname)', 'refs/mousse/preserved/'])
  expect(preserved).toBe(retired.keptFiles[0].sha)
  expect(new ThreadJournal(join(f.home, 'thread-data', 'task')).list().some((entry) => entry.operationType === 'worktree-cleanup' && entry.state === 'completed')).toBe(true)
  git(f.repo, ['gc', '--prune=now', '-q'])
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
})

test.skipIf(process.platform === 'win32')('a writer at the boundary Git used to delete at fails to write instead of losing its bytes (the earlier expiry race, inverted)', async () => {
  const f = await trashedFixture()
  const bin = join(f.root, 'race-bin'); mkdirSync(bin)
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const value = 'late bytes after final validation 63fa0ee1\n'
  // A still-live writer that writes by path into the folder as Git is asked to remove the worktree.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" worktree remove "*) if printf '%s' '${value}' > '${f.trashPath}/a.txt' 2>/dev/null; then echo wrote; else echo failed; fi > '${f.root}/race-fired' ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath}`
  let outcome
  try { outcome = await f.service.expireTrash(f.path, { now: LATER() }) } finally { process.env.PATH = previousPath }
  expect(outcome).toEqual({ removed: true })
  // The folder was gone by then: the write failed, so no bytes were taken in and then lost.
  expect(readFileSync(join(f.root, 'race-fired'), 'utf8').trim()).toBe('failed')
  expect(existsSync(f.trashPath)).toBe(false)
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('a file held open in the folder: where the rename goes ahead (macOS, Linux) a write through it survives and is added to the proof; where it refuses the rename (Windows) the worktree stays in the trash, whole', async () => {
  const f = await trashedFixture()
  let handle: number | undefined
  let pathWrite: unknown
  const written = Buffer.from('through a handle still open\n')
  try {
    const outcome = await f.service.expireTrash(f.path, {
      now: LATER(),
      // Opened after the capture and kept open across the rename, as an editor or a build tool holds a file. On Windows
      // without sharing, as such programs often do.
      afterCapture: (path) => { handle = openSync(join(path, 'b.txt'), process.platform === 'win32' ? fsConstants.O_RDWR | fsConstants.UV_FS_O_EXLOCK : 'r+') },
      afterRename: (renamed) => {
        try { writeFileSync(join(f.trashPath, 'b.txt'), 'by path\n') } catch (error) { pathWrite = error }
        // The handle still points at the file, now in the renamed folder.
        writeSync(handle!, written, 0, written.length, 0); ftruncateSync(handle!, written.length)
        writeFileSync(join(renamed, 'sub', 'late.txt'), 'late\n')
      }
    })
    if (process.platform === 'win32') {
      // The rename is refused while the file is open, after its few retries: nothing moved and nothing is lost.
      expect(outcome).toEqual({ kept: expect.stringMatching(/in use/) })
      expect(manifestOf(f.path).state).toBe('trashed'); expect(deletingFolders(f.trashPath)).toEqual([])
      expect(filesOf(f.trashPath)).toEqual(f.before)
      closeSync(handle!); handle = undefined
      expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
      await f.service.reconstruct(f.path)
      expect(filesOf(f.worktree)).toEqual(f.before)
      return
    }
    expect((pathWrite as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(existsSync(f.trashPath)).toBe(false)
    expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted.*kept/), waiting: true })
    const manifest = manifestOf(f.path)
    expect(manifest.state).toBe('deleting')
    // Nothing was deleted: the folder is all there, with the late writes.
    const left = filesOf(manifest.deleting.path)
    expect(left).toEqual({ ...f.before, 'b.txt': expect.stringContaining(written.toString('base64')), 'sub/late.txt': expect.any(String) })
    // The proof grew: the late versions are kept, and the earlier ones stay in the snapshot.
    expect(manifest.keptFiles).toHaveLength(2)
    expect(manifest.keptFiles[1].paths.sort()).toEqual(['b.txt', 'sub/late.txt'])
    expect(git(f.repo, ['show', `${manifest.keptFiles[1].sha}:b.txt`])).toBe('through a handle still open')
    expect(listed(f.repo)).toContain(slashes(f.trashPath))
    closeSync(handle!); handle = undefined
    // A restore now rebuilds from the proof, with the late writes, and the half-deleted folder goes.
    await f.service.reconstruct(f.path)
    expect(filesOf(f.worktree)).toEqual(left)
    expect(existsSync(manifest.deleting.path)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
  } finally { if (handle !== undefined) closeSync(handle) }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a rename the system refuses stops the expiry at once: the worktree stays in the trash, whole, and the next run completes', async () => {
  const f = await trashedFixture()
  const parent = dirname(f.trashPath)
  const timers = (): number => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
  const timersBefore = timers(), started = Date.now()
  try {
    // The folder that holds it no longer lets anything be renamed in it, as a held file does on Windows.
    const outcome = await f.service.expireTrash(f.path, { now: LATER(), afterCapture: () => chmodSync(parent, 0o555), afterRename: () => { throw new Error('the rename went ahead') } })
    expect(outcome).toEqual({ kept: expect.stringMatching(/^Files in this worktree are in use/) })
  } finally { chmodSync(parent, 0o755) }
  expect(Date.now() - started).toBeLessThan(15_000)
  expect(timers()).toBe(timersBefore)
  expect(manifestOf(f.path).state).toBe('trashed'); expect(manifestOf(f.path).deleting).toBeUndefined()
  expect(filesOf(f.trashPath)).toEqual(f.before); expect(deletingFolders(f.trashPath)).toEqual([])
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('a file created in a folder as it is deleted makes rmdir stop: what is not deleted yet and the new file are kept', async () => {
  const f = await trashedFixture()
  const outcome = await f.service.expireTrash(f.path, {
    now: LATER(),
    beforeRemove: (path) => { if (path.endsWith(`${sep}sub`)) writeFileSync(join(path, 'new.txt'), 'created mid-delete\n') }
  })
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  const manifest = manifestOf(f.path)
  const left = filesOf(manifest.deleting.path)
  // sub/x.txt and sub/y.txt came first and are gone; sub itself stopped the delete, with its new file in it.
  expect(left['sub/new.txt']).toContain(Buffer.from('created mid-delete\n').toString('base64'))
  expect(left['sub/x.txt']).toBeUndefined(); expect(left['a.txt']).toBe(f.before['a.txt']); expect(left['ignored/cache.bin']).toBe(f.before['ignored/cache.bin'])
  expect(manifest.keptFiles.at(-1).paths).toEqual(['sub/new.txt'])
  // It waits an hour from the write; then what is left is deleted.
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toMatchObject({ waiting: true })
  expect(await f.service.expireTrash(f.path, { now: Date.parse(manifest.deleting.changedAt) + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(existsSync(manifest.deleting.path)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual({ ...f.before, 'sub/new.txt': left['sub/new.txt'] })
})

test.each(['after the rename', 'mid-delete'] as const)('a crash %s settles on restart, and a restore rebuilds byte for byte from the proof', async (when) => {
  const f = await trashedFixture()
  let removed = 0
  await expect(f.service.expireTrash(f.path, {
    now: LATER(),
    ...(when === 'after the rename'
      ? { afterRename: () => { throw new Error('the process stopped') } }
      : { beforeRemove: () => { if (++removed === 3) throw new Error('the process stopped') } })
  })).rejects.toThrow('the process stopped')
  const manifest = manifestOf(f.path)
  expect(manifest.state).toBe('deleting'); expect(existsSync(manifest.deleting.path)).toBe(true)
  expect(existsSync(f.trashPath)).toBe(false)
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  if (when === 'after the rename') expect(await restarted.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  // Mid-delete, the restore itself finishes the delete against the proof, then rebuilds.
  await restarted.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
  expect(existsSync(manifest.deleting.path)).toBe(false); expect(deletingFolders(f.trashPath)).toEqual([])
  expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
  expect(manifestOf(f.path).state).toBe('materialized')
})

test('a delete that stopped before the rename goes back to the trash as it was', async () => {
  const f = await trashedFixture()
  const manifest = manifestOf(f.path)
  // The state was recorded and the process stopped before the folder moved.
  writeFileSync(f.path, JSON.stringify({ ...manifest, state: 'deleting', deleting: { path: join(dirname(f.trashPath), '.deleting-0123456789abcdef'), startedAt: new Date().toISOString(), adminState: 'x' } }))
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ kept: 'Waiting in the trash', waiting: true })
  expect(manifestOf(f.path)).toMatchObject({ state: 'trashed' }); expect(filesOf(f.trashPath)).toEqual(f.before)
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('a file in use (Windows) stops the delete where it is; a later run carries on, and a restore rebuilds byte for byte', async () => {
  const f = await trashedFixture()
  // Windows refuses to delete a file another process holds open; the in-use check before the capture let it through.
  const busy = Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' })
  const outcome = await f.service.expireTrash(f.path, { now: LATER(), beforeRemove: (path) => { if (path.endsWith(`${sep}b.txt`)) throw busy } })
  expect(outcome).toEqual({ kept: expect.stringMatching(/in use; what is left of it waits at .*\.deleting-/) })
  const manifest = manifestOf(f.path)
  expect(manifest.state).toBe('deleting'); expect(manifest.deleting.changedAt).toBeUndefined()
  const left = filesOf(manifest.deleting.path)
  expect(left['b.txt']).toBe(f.before['b.txt']); expect(left['a.txt']).toBe(f.before['a.txt']); expect(left['sub/x.txt']).toBeUndefined()
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  expect(existsSync(manifest.deleting.path)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('a permanent deletion takes what is left of a stopped delete, and its registration', async () => {
  const f = await trashedFixture()
  await expect(f.service.expireTrash(f.path, { now: LATER(), afterRename: () => { throw new Error('the process stopped') } })).rejects.toThrow()
  const manifest = manifestOf(f.path)
  // Kept until then: the bytes are all in the proof, and a restore would still bring them back.
  expect(filesOf(manifest.deleting.path)).toEqual(f.before)
  await f.service.retire(f.path, { purging: true })
  expect(existsSync(manifest.deleting.path)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
})

// ---- Review round 1: what a delete must never follow, and what keeps a restore possible ----

/** Whether the volume of `path` tells names apart only by case. */
function caseInsensitive(path: string): boolean {
  const probe = join(path, `Case-${randomBytes(4).toString('hex')}`)
  writeFileSync(probe, '')
  try { return existsSync(probe.toLowerCase().replace(path.toLowerCase(), path)) } finally { rmSync(probe) }
}

test.skipIf(process.platform === 'win32').each(['a file', 'an empty folder'] as const)('a folder swapped for a link while %s in it is deleted stops the delete: nothing outside the trash is removed, and a restore rebuilds what the folder holds now', async (what) => {
  const f = await trashedFixture((trashPath) => mkdirSync(join(trashPath, 'empty', 'inner'), { recursive: true }))
  const outside = join(f.root, 'outside'); mkdirSync(join(outside, 'inner'), { recursive: true })
  let moved = ''
  const outcome = await f.service.expireTrash(f.path, {
    now: LATER(),
    beforeRemove: (path) => {
      if (moved) return
      if (what === 'a file' && path.endsWith(`${sep}sub${sep}y.txt`)) {
        // The proven file moves out with its folder, and a link to it takes the folder's place.
        moved = join(f.root, 'moved-sub'); renameSync(dirname(path), moved); symlinkSync(moved, dirname(path))
      }
      if (what === 'an empty folder' && path.endsWith(`${sep}empty${sep}inner`)) {
        moved = join(f.root, 'moved-empty'); renameSync(dirname(path), moved); symlinkSync(outside, dirname(path))
      }
    }
  }).catch((error: Error) => error)
  expect(moved).not.toBe('')
  // Nothing outside the trash was removed through the link: the moved file, and the empty folder the link points to.
  if (what === 'a file') expect(readdirSync(moved).sort()).toEqual(['x.txt', 'y.txt'])
  else { expect(existsSync(join(outside, 'inner'))).toBe(true); expect(existsSync(join(moved, 'inner'))).toBe(true) }
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  const manifest = manifestOf(f.path)
  const left = filesOf(manifest.deleting.path)
  expect(left[what === 'a file' ? 'sub' : 'empty']).toMatch(/^link /)
  // What was deleted before the swap comes back from the proof; the swapped folder comes back as the link it is now.
  const swapped = what === 'a file' ? 'sub' : 'empty'
  const expected = Object.fromEntries(Object.entries(f.before).filter(([path]) => !path.startsWith(`${swapped}/`)))
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual({ ...expected, [swapped]: left[swapped] })
  expect(existsSync(manifest.deleting.path)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
  if (what === 'a file') expect(readdirSync(moved).sort()).toEqual(['x.txt', 'y.txt'])
  else expect(existsSync(join(outside, 'inner'))).toBe(true)
})

test.skipIf(process.platform === 'win32')('a permanent deletion never follows a folder swapped for a link after its walk: the rest is kept, and a restore still rebuilds byte for byte', async () => {
  const f = await trashedFixture()
  await expect(f.service.expireTrash(f.path, { now: LATER(), afterRename: () => { throw new Error('the process stopped') } })).rejects.toThrow()
  const manifest = manifestOf(f.path)
  const outside = join(f.root, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'x.txt'), 'outside x\n'); writeFileSync(join(outside, 'y.txt'), 'outside y\n'); writeFileSync(join(outside, 'keep.txt'), 'outside keep\n')
  const sub = join(manifest.deleting.path, 'sub'), moved = join(f.root, 'moved-sub')
  const purged = await f.service.retire(f.path, { purging: true, beforeMove: () => { if (!lstatSync(sub).isSymbolicLink()) { renameSync(sub, moved); symlinkSync(outside, sub) } } }).catch((error: Error) => error)
  expect(readdirSync(outside).sort()).toEqual(['keep.txt', 'x.txt', 'y.txt'])
  expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('outside x\n')
  expect((purged as Error).message).toMatch(/changed while it was being deleted; the rest of it is kept/)
  // The swap is undone; the permanent deletion was not finished, so the worktree can still come back from its proof.
  unlinkSync(sub); renameSync(moved, sub)
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('a worktree Git has locked stays in the trash as it is, and the lock is named; once unlocked it is deleted and comes back byte for byte', async () => {
  const f = await trashedFixture()
  git(f.repo, ['worktree', 'lock', '--reason', 'an agent is using it', f.trashPath])
  const record = readFileSync(f.path, 'utf8')
  const timers = (): number => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
  const timersBefore = timers()
  const outcome = await f.service.expireTrash(f.path, { now: LATER() })
  expect(outcome).toEqual({ kept: expect.stringContaining('Git has this worktree locked (an agent is using it), so it stays in the trash') })
  expect(manifestOf(f.path)).toMatchObject({ state: 'trashed' }); expect(filesOf(f.trashPath)).toEqual(f.before)
  expect(deletingFolders(f.trashPath)).toEqual([])
  // Every later run says the same. Nothing is captured while it is locked: no kept copy, no new pins, the record as it was.
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual(outcome)
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/'])).toBe('')
  expect(readFileSync(f.path, 'utf8')).toBe(record)
  // The lease refresh the expiry starts is stopped when it returns.
  expect(timers()).toBe(timersBefore)
  git(f.repo, ['worktree', 'unlock', f.trashPath])
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('a lock Git is given while the folder is being deleted stops it before Git is asked to unregister, and names the lock', async () => {
  const f = await trashedFixture()
  const outcome = await f.service.expireTrash(f.path, { now: LATER(), afterRename: () => git(f.repo, ['worktree', 'lock', '--reason', 'late lock', f.trashPath]) })
  expect(outcome).toEqual({ kept: expect.stringContaining('locked (late lock)') })
  expect(manifestOf(f.path).state).toBe('deleting')
  expect(filesOf(manifestOf(f.path).deleting.path)).toEqual(f.before)
  git(f.repo, ['worktree', 'unlock', f.trashPath])
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test.each(['in use', 'a crash'] as const)('%s right after the .git file went: no Git runs in what is left, the next run finishes, and a restore rebuilds byte for byte', async (what) => {
  const f = await trashedFixture()
  const stopAtRoot = (path: string): void => {
    if (!/\.deleting-[a-f0-9]{16}$/.test(path)) return
    expect(existsSync(join(path, '.git'))).toBe(false)
    throw what === 'in use' ? Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' }) : new Error('the process stopped')
  }
  if (what === 'in use') expect(await f.service.expireTrash(f.path, { now: LATER(), beforeRemove: stopAtRoot })).toEqual({ kept: expect.stringMatching(/in use/) })
  else await expect(f.service.expireTrash(f.path, { now: LATER(), beforeRemove: stopAtRoot })).rejects.toThrow('the process stopped')
  const manifest = manifestOf(f.path)
  expect(readdirSync(manifest.deleting.path)).toEqual([])
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  if (what === 'in use') expect(await restarted.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  // After a crash, the restore itself finishes.
  await restarted.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
  expect(existsSync(manifest.deleting.path)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
})

test.skipIf(process.platform === 'win32').each([
  ['a file becomes a folder', (renamed: string) => { unlinkSync(join(renamed, 'b.txt')); mkdirSync(join(renamed, 'b.txt')); writeFileSync(join(renamed, 'b.txt', 'inner'), 'inner\n') }],
  ['a folder becomes a link', (renamed: string) => { rmSync(join(renamed, 'sub'), { recursive: true }); symlinkSync('ignored', join(renamed, 'sub')) }],
  ['a kept link points elsewhere', (renamed: string) => { unlinkSync(join(renamed, 'ignored', 'link')); symlinkSync('b.txt', join(renamed, 'ignored', 'link')) }],
  ['a link becomes a file', (renamed: string) => { unlinkSync(join(renamed, 'ignored', 'link')); writeFileSync(join(renamed, 'ignored', 'link'), 'now a file\n') }]
] as const)('when %s while the folder is being deleted, a restore rebuilds its newer form byte for byte', async (_what, change) => {
  const f = await trashedFixture()
  const outcome = await f.service.expireTrash(f.path, { now: LATER(), afterRename: change })
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  const manifest = manifestOf(f.path)
  const left = filesOf(manifest.deleting.path)
  expect(left).not.toEqual(f.before)
  // The next run deletes what is left against the grown proof; the restore brings the newer form back.
  expect(await f.service.expireTrash(f.path, { now: Date.parse(manifest.deleting.changedAt) + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(left)
})

test.runIf(caseInsensitive(tmpdir()))('a name changed only in case while the folder is being deleted is one path on this volume: the newer spelling is rebuilt', async () => {
  const f = await trashedFixture()
  const outcome = await f.service.expireTrash(f.path, {
    now: LATER(),
    afterRename: (renamed) => {
      renameSync(join(renamed, 'b.txt'), join(renamed, 'B.txt')); writeFileSync(join(renamed, 'B.txt'), 'renamed and edited\n')
      renameSync(join(renamed, 'sub'), join(renamed, 'Sub'))
    }
  })
  expect(outcome).toMatchObject({ waiting: true })
  const manifest = manifestOf(f.path)
  const left = filesOf(manifest.deleting.path)
  expect(Object.keys(left)).toEqual(expect.arrayContaining(['B.txt', 'Sub/', 'Sub/x.txt']))
  expect(manifest.content.map((entry: { path: string }) => entry.path)).not.toContain('b.txt')
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(left)
})

test('a repository lease lost while the folder is being deleted stops the delete before the next removal, and nothing is unregistered', async () => {
  const f = await trashedFixture()
  const leasePath = f.ownership.repositoryLease.path, held = readFileSync(leasePath, 'utf8')
  let removed = 0
  const outcome = await f.service.expireTrash(f.path, {
    now: LATER(),
    // Another process took the lease: its heartbeat had aged past the stale time.
    beforeRemove: () => { if (++removed === 2) writeFileSync(leasePath, JSON.stringify({ ...JSON.parse(held), token: 'another-process', pid: process.pid + 1 })) }
  })
  expect(outcome).toEqual({ kept: expect.stringMatching(/lost hold of the repository/) })
  const manifest = manifestOf(f.path)
  expect(manifest.state).toBe('deleting'); expect(listed(f.repo)).toContain(slashes(f.trashPath))
  // Only the entry before the lease went was removed.
  expect(Object.keys(f.before).length - Object.keys(filesOf(manifest.deleting.path)).length).toBe(1)
  writeFileSync(leasePath, held)
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

// ---- Review round 2: a rebuild never deletes what it did not write; layers of folders; permissions; the lease ----

test.skipIf(process.platform === 'win32')('a rebuild never deletes bytes it did not write: files that appear in the way are kept as a copy first, and the rebuild finishes', async () => {
  const f = await trashedFixture()
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  const personal = 'a sole copy written while the worktree was rebuilt 3ea43028\n', cache = 'other bytes at a kept path\n'
  // While the worktree is rebuilt, someone writes where the proof says there is a link, and over a file the proof holds.
  const manifest = await f.service.reconstruct(f.path, { env: {}, prepare: (root) => {
    mkdirSync(join(root, 'ignored', 'link'), { recursive: true }); writeFileSync(join(root, 'ignored', 'link', 'personal.txt'), personal)
    writeFileSync(join(root, 'ignored', 'cache.bin'), cache)
  } })
  expect(manifest.state).toBe('materialized')
  expect(filesOf(f.worktree)).toEqual(f.before)
  // Both were kept before they were cleared, owned by the thread's journal, byte for byte.
  const kept = new Map(manifest.keptAside!.flatMap((entry) => entry.paths.map((path) => [path, entry.ref] as const)))
  expect([...kept.keys()].sort()).toEqual(['ignored/cache.bin', 'ignored/link/personal.txt'])
  expect(git(f.worktree, ['cat-file', 'blob', `${kept.get('ignored/link/personal.txt')}:ignored/link/personal.txt`])).toBe(personal.trimEnd())
  expect(git(f.worktree, ['cat-file', 'blob', `${kept.get('ignored/cache.bin')}:ignored/cache.bin`])).toBe(cache.trimEnd())
  const owned = new ThreadJournal(join(f.home, 'thread-data', 'task')).list().filter((entry) => entry.operationType === 'worktree-cleanup' && entry.state === 'completed').map((entry) => (entry.details as { ref?: string }).ref)
  for (const ref of kept.values()) expect(owned).toContain(ref)
})

test('a tracked file that became an empty folder while the folder was being deleted is rebuilt as that folder', async () => {
  const f = await fixture()
  await f.service.prepare(f.input); await f.service.retire(f.path)
  expect(await f.service.expireTrash(f.path, { now: LATER(), afterRename: (renamed) => { unlinkSync(join(renamed, 'b.txt')); mkdirSync(join(renamed, 'b.txt')) } })).toMatchObject({ waiting: true })
  const manifest = manifestOf(f.path), left = filesOf(manifest.deleting.path)
  expect(left['b.txt/']).toBeDefined()
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(left)
  // The folder came from a layer of folders only: nothing in it to keep a copy of.
  expect(manifestOf(f.path).keptFiles).toEqual([{ paths: [], folders: ['b.txt'] }])
})

test.skipIf(process.platform === 'win32').each([
  ['a file', (root: string) => writeFileSync(join(root, 'ignored'), 'became a file\n')],
  ['a link', (root: string) => symlinkSync('sub', join(root, 'ignored'))]
] as const)('a folder that became %s and then a folder again across runs is rebuilt in its newest form', async (_what, become) => {
  const f = await trashedFixture()
  expect(await f.service.expireTrash(f.path, { now: LATER(), afterRename: (renamed) => { rmSync(join(renamed, 'ignored'), { recursive: true }); become(renamed) } })).toMatchObject({ waiting: true })
  const first = manifestOf(f.path), root = first.deleting.path
  rmSync(join(root, 'ignored')); mkdirSync(join(root, 'ignored')); writeFileSync(join(root, 'ignored', 'new.txt'), 'a folder again\n')
  expect(await f.service.expireTrash(f.path, { now: Date.parse(first.deleting.changedAt) + 2 * WORKTREE_TRASH_QUIET_MS })).toMatchObject({ waiting: true })
  const left = filesOf(root)
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(left)
  // A second restore of the same record is not stopped by the first: the worktree is there, as rebuilt.
  expect(manifestOf(f.path).state).toBe('materialized')
})

/** Gives every folder under `root` its owner's write permission back, so a test's folders can be removed. */
function writableTree(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = lstatSync(path)
    if (stat.isDirectory()) { chmodSync(path, 0o755); writableTree(path) }
  }
}

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder Mousse may not delete files in keeps the worktree in the trash, whole, naming the folder; a restore brings it back byte for byte', async () => {
  const f = await trashedFixture((trashPath) => { mkdirSync(join(trashPath, 'ignored', 'ro')); writeFileSync(join(trashPath, 'ignored', 'ro', 'mod.go'), 'package x\n'); chmodSync(join(trashPath, 'ignored', 'ro'), 0o555) })
  try {
    expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ kept: expect.stringContaining('Mousse may not delete the files in ignored/ro, so the worktree stays in the trash') })
    expect(manifestOf(f.path).state).toBe('trashed'); expect(filesOf(f.trashPath)).toEqual(f.before); expect(deletingFolders(f.trashPath)).toEqual([])
    await f.service.reconstruct(f.path)
    expect(filesOf(f.worktree)).toEqual(f.before)
  } finally { writableTree(f.root) }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a folder made read-only after the rename stops the delete; a restore rebuilds the worktree from the proof, with that folder read-only', async () => {
  const f = await trashedFixture()
  let root = ''
  try {
    expect(await f.service.expireTrash(f.path, { now: LATER(), afterRename: (renamed) => { root = renamed; chmodSync(join(renamed, 'sub'), 0o555) } })).toMatchObject({ waiting: true })
    // The next run gets as far as the folder, and stops there.
    const changedAt = Date.parse(manifestOf(f.path).deleting.changedAt)
    expect(await f.service.expireTrash(f.path, { now: changedAt + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ kept: expect.stringContaining('Mousse may not delete files in sub'), readOnly: true })
    expect(existsSync(join(root, 'sub', 'x.txt'))).toBe(true)
    await f.service.reconstruct(f.path)
    expect(filesOf(f.worktree)).toEqual({ ...f.before, 'sub/': 'folder 365' })
    expect(existsSync(root)).toBe(false); expect(listed(f.repo)).not.toContain(slashes(f.trashPath))
  } finally { writableTree(f.root) }
})

test('a lease read that meets the file while another process writes it is tried again instead of failing the expiry', async () => {
  const f = await trashedFixture()
  const leasePath = f.ownership.repositoryLease.path, held = readFileSync(leasePath, 'utf8')
  // The file is empty for a moment, as a writer that empties it first leaves it.
  writeFileSync(leasePath, ''); setTimeout(() => writeFileSync(leasePath, held), 10)
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  await f.service.reconstruct(f.path)
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test('the delete a restore finishes keeps the repository lease fresh', async () => {
  const f = await trashedFixture()
  await expect(f.service.expireTrash(f.path, { now: LATER(), afterRename: () => { throw new Error('the process stopped') } })).rejects.toThrow()
  const ticks: Array<() => void> = []
  const realSetInterval = globalThis.setInterval
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms?: number) => { if (ms === 5_000) ticks.push(callback); return realSetInterval(callback, ms) }) as typeof setInterval)
  const heartbeat = vi.spyOn(f.ownership.repositoryLease, 'heartbeat')
  try { await f.service.reconstruct(f.path) } finally { spy.mockRestore() }
  expect(ticks).toHaveLength(1)
  ticks[0]!()
  expect(heartbeat).toHaveBeenCalled()
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test.skipIf(process.platform === 'win32')('a folder swapped for a link just before a file in it is read stops the delete as a change, and a later run settles it', async () => {
  const f = await trashedFixture()
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'cache.bin'), 'outside\n')
  let swapped = false
  const outcome = await f.service.expireTrash(f.path, { now: LATER(), beforeRemove: (path) => {
    // Right as the folder before it goes, `ignored` (read next) becomes a link to outside the trash.
    if (swapped || !path.endsWith(`${sep}sub`)) return
    swapped = true
    const root = dirname(path)
    renameSync(join(root, 'ignored'), join(f.root, 'moved-ignored')); symlinkSync(outside, join(root, 'ignored'))
  } }).catch((error: Error) => error)
  expect(readFileSync(join(outside, 'cache.bin'), 'utf8')).toBe('outside\n')
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted/), waiting: true })
  const manifest = manifestOf(f.path), left = filesOf(manifest.deleting.path)
  expect(await f.service.expireTrash(f.path, { now: Date.parse(manifest.deleting.changedAt) + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(readFileSync(join(outside, 'cache.bin'), 'utf8')).toBe('outside\n')
  await f.service.reconstruct(f.path)
  // `sub` went before the swap and comes back from the proof; `ignored` comes back as the link it is now.
  expect(filesOf(f.worktree)).toEqual({ ...Object.fromEntries(Object.entries(f.before).filter(([path]) => !path.startsWith('ignored/'))), ignored: left.ignored })
})

// ---- Review round 3: what a rebuild set aside is said in the thread, with the command that brings it back ----

/** The commands a set-aside notice gives, as it gives them. */
function noticeCommands(text: string, worktree: string): string[] {
  const start = text.indexOf(`running this in ${worktree}: `) + `running this in ${worktree}: `.length
  return text.slice(start, text.lastIndexOf(' (kept for ')).split('; ').map((command) => command.replace(/^`|`$/g, ''))
}

test.skipIf(process.platform === 'win32')('a rebuild that set files aside says so in plain words, and each command it gives brings a file back byte for byte', async () => {
  const f = await trashedFixture()
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  const personal = Buffer.from('a sole copy written while the worktree was rebuilt 3ea43028\n'), cache = Buffer.from([7, 0, 255, 13, 10, 42])
  const manifest = await f.service.reconstruct(f.path, { env: {}, prepare: (root) => {
    mkdirSync(join(root, 'ignored', 'link'), { recursive: true }); writeFileSync(join(root, 'ignored', 'link', 'personal.txt'), personal)
    writeFileSync(join(root, 'ignored', 'cache.bin'), cache)
  } })
  const notice = f.service.keptAsideNotice(manifest)!
  const window = retentionWindowText(keptCopyWindowMs(join(f.home, 'thread-data', 'task')))
  expect(notice.text).toMatch(new RegExp(`^While rebuilding this worktree, Mousse set aside 2 files, which were written there during the rebuild: ignored/cache\\.bin, ignored/link/personal\\.txt\\. Bring them back by running this in .+: \`git cat-file blob refs/mousse/preserved/\\S+:ignored/cache\\.bin > ignored/cache\\.bin\`; \`git cat-file blob refs/mousse/preserved/\\S+:ignored/link/personal\\.txt > ignored/link/personal\\.txt\` \\(kept for ${window}\\)\\.$`))
  const [cacheCommand, personalCommand] = noticeCommands(notice.text, f.worktree)
  // The command as given, run where the notice says: the file is back exactly as it was written.
  execFileSync('/bin/sh', ['-c', cacheCommand!], { cwd: f.worktree })
  expect(readFileSync(join(f.worktree, 'ignored', 'cache.bin'))).toEqual(cache)
  // Its path holds the rebuilt link now, so the person picks where it goes: the bytes the command writes are the ones set aside.
  expect(execFileSync('/bin/sh', ['-c', personalCommand!.slice(0, personalCommand!.indexOf(' > '))], { cwd: f.worktree })).toEqual(personal)
})

test('a rebuild that set nothing aside says nothing', async () => {
  const f = await trashedFixture()
  expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
  const manifest = await f.service.reconstruct(f.path)
  expect(manifest.keptAside).toBeUndefined()
  expect(f.service.keptAsideNotice(manifest)).toBeUndefined()
  expect(keptAsideNotice({ worktreePath: f.worktree }, 1)).toBeUndefined()
  expect(filesOf(f.worktree)).toEqual(f.before)
})

test.skipIf(process.platform === 'win32')('restoring a thread tells it what the rebuild set aside, once, and nothing when it set nothing aside', async () => {
  for (const stranger of [true, false]) {
    const f = await threadFixture('named')
    writeFileSync(join(f.repo, '.git', 'info', 'exclude'), 'ignored/\n')
    await f.service.prepare(f.input)
    const trashed = await f.service.retire(f.path)
    mkdirSync(join(trashed.trashPath!, 'ignored')); writeFileSync(join(trashed.trashPath!, 'ignored', 'cache.bin'), 'kept with the worktree\n')
    const before = filesOf(trashed.trashPath!)
    expect(await f.service.expireTrash(f.path, { now: LATER() })).toEqual({ removed: true })
    f.releaseLeases()
    const restoreAdmin = (WorktreeRetirementService.prototype as unknown as { restoreAdmin(manifest: unknown): Promise<void> }).restoreAdmin
    // While the worktree is rebuilt, something writes over the ignored file the proof holds.
    const spy = vi.spyOn(WorktreeRetirementService.prototype as unknown as { restoreAdmin(manifest: unknown): Promise<void> }, 'restoreAdmin').mockImplementation(async function (this: unknown, manifest: unknown) {
      await restoreAdmin.call(this, manifest)
      if (stranger) { mkdirSync(join(f.worktree, 'ignored'), { recursive: true }); writeFileSync(join(f.worktree, 'ignored', 'cache.bin'), 'written during the rebuild\n') }
    })
    const notices: Array<{ id: string; text: string }> = []
    try { await new ThreadWorkspaceManager(f.task).restore(f.repo, undefined, undefined, (notice) => { notices.push(notice) }) } finally { spy.mockRestore() }
    expect(filesOf(f.worktree)).toEqual(before)
    if (!stranger) { expect(notices).toEqual([]); continue }
    expect(notices).toHaveLength(1)
    expect(notices[0]!.text).toContain('While rebuilding this worktree, Mousse set aside ignored/cache.bin, which was written there during the rebuild. Bring it back by running this in ')
    execFileSync('/bin/sh', ['-c', noticeCommands(notices[0]!.text, f.worktree)[0]!], { cwd: f.worktree })
    expect(readFileSync(join(f.worktree, 'ignored', 'cache.bin'), 'utf8')).toBe('written during the rebuild\n')
  }
}, 120_000)
