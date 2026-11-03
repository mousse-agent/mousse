import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, renameSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'

/** Git lists worktrees with forward slashes on every platform; paths are compared in that form, and case-folded on Windows. */
const slashes = (path: string): string => { const value = resolve(path).replaceAll('\\', '/'); return process.platform === 'win32' ? value.toLowerCase() : value }
const listed = (repo: string): string[] => git(repo, ['worktree', 'list', '--porcelain']).split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => slashes(line.slice(9)))
const roots: string[] = []
const releases: Array<() => unknown> = []
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
  return { repo, task, worktree, branch, service, input: { taskId: 'task', worktreePath: worktree, branch, sourcePath: join(task, 'workspace.json') }, path: service.pathFor('task', worktree) }
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
  // A lock someone put on the worktree in the trash is not kept. It is lifted once the capture is done, so Git deletes the folder.
  const trashedAdmin = git(trashed.trashPath!, ['rev-parse', '--absolute-git-dir'])
  writeFileSync(join(trashedAdmin, 'locked'), 'stale lock\n')
  expect(await f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS, afterCapture: () => rmSync(join(trashedAdmin, 'locked')) })).toEqual({ removed: true })
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
