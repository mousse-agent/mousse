import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, renameSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { lifecycleGit as git, WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'

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
  const home = join(root, 'profile'), task = join(home, 'thread-data', 'task'); mkdirSync(task, { recursive: true })
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
  f.service.prepare(f.input); f.service.retire(f.path); expect(existsSync(f.worktree)).toBe(false)
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  restarted.reconstruct(f.path); expect(existsSync(join(f.worktree, 'a.txt'))).toBe(true)
  expect(existsSync(join(f.worktree, 'b.txt'))).toBe(!sparse)
  expect(git(f.repo, ['status', '--porcelain'])).toBe('')
})
test('ignored sole copy, hidden index flags and changed content block retirement', async () => {
  const f = await fixture(true)
  writeFileSync(join(f.worktree, '.mousse', 'secret'), 'not captured')
  expect(() => f.service.prepare(f.input)).toThrow(/Uncaptured/)
  rmSync(join(f.worktree, '.mousse', 'secret'))
  git(f.worktree, ['update-index', '--assume-unchanged', 'a.txt'])
  expect(() => f.service.prepare(f.input)).toThrow(/flags/)
  git(f.worktree, ['update-index', '--no-assume-unchanged', 'a.txt'])
  // A write after the checks moves with the folder into the trash; the trash keeps it there, since no snapshot can hold it.
  f.service.prepare(f.input); writeFileSync(join(f.worktree, '.mousse', 'secret'), 'late copy')
  const trashed = f.service.retire(f.path)
  expect(trashed.state).toBe('trashed')
  expect(readFileSync(join(trashed.trashPath!, '.mousse', 'secret'), 'utf8')).toBe('late copy')
  expect(f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ kept: expect.stringMatching(/^Kept in the trash at .*requires retention/) })
  expect(readFileSync(join(trashed.trashPath!, '.mousse', 'secret'), 'utf8')).toBe('late copy')
})

test('retirement moves the folder into the trash in one step, and a restore moves it back as it is', async () => {
  const f = await fixture()
  f.service.prepare(f.input)
  // Written after the checks: a process that keeps its working directory in the worktree.
  writeFileSync(join(f.worktree, 'late.txt'), 'late write\n')
  const trashed = f.service.retire(f.path)
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
  expect(f.service.expireTrash(f.path)).toEqual({ kept: 'Waiting in the trash', waiting: true })
  f.service.reconstruct(f.path)
  expect(existsSync(trashed.trashPath!)).toBe(false)
  expect(readFileSync(join(f.worktree, 'late.txt'), 'utf8')).toBe('late write\n')
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
  expect(listed(f.repo)).toContain(slashes(f.worktree))
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({ state: 'materialized' })
})

test('trash expiry snapshots the folder, deletes it and its branch, and a restore rebuilds both with the same files', async () => {
  const f = await fixture()
  f.service.prepare(f.input)
  const trashed = f.service.retire(f.path)
  // Changed in the trash after the move: the expiry snapshot is taken from the folder as it is then.
  writeFileSync(join(trashed.trashPath!, 'a.txt'), 'edited in the trash\n'); writeFileSync(join(trashed.trashPath!, 'new.txt'), 'new\n')
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  expect(f.service.expireTrash(f.path, { now: later, inUse: () => 'Files in this worktree are in use' })).toEqual({ kept: 'Files in this worktree are in use' })
  expect(existsSync(trashed.trashPath!)).toBe(true)
  expect(f.service.expireTrash(f.path, { now: later })).toEqual({ removed: true })
  expect(existsSync(trashed.trashPath!)).toBe(false)
  expect(listed(f.repo)).not.toContain(slashes(trashed.trashPath!))
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(retired).toMatchObject({ state: 'retired', deletedBranches: [{ name: f.branch, sha: trashed.resultSha }] })
  expect(retired.trashPath).toBeUndefined()
  // The branch is gone; its tip is the HEAD the pins keep, and the snapshot holds the files.
  expect(git(f.repo, ['branch', '--list', f.branch])).toBe('')
  expect(git(f.repo, ['show', `${retired.snapshotRef}:a.txt`])).toBe('edited in the trash')
  expect(git(f.repo, ['rev-parse', `${retired.snapshotRef}^`])).toBe(trashed.resultSha)
  f.service.reconstruct(f.path)
  expect(git(f.worktree, ['branch', '--show-current'])).toBe(f.branch)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('edited in the trash\n')
  expect(readFileSync(join(f.worktree, 'new.txt'), 'utf8')).toBe('new\n')
})

test('trash expiry asks whether the folder is in use before its snapshot, so a write that slips in then is in the snapshot', async () => {
  const f = await fixture()
  f.service.prepare(f.input)
  const trashed = f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  expect(f.service.expireTrash(f.path, { now: later, inUse: (path) => { writeFileSync(join(path, 'a.txt'), 'written during the check\n'); return undefined } })).toEqual({ removed: true })
  expect(existsSync(trashed.trashPath!)).toBe(false)
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(git(f.repo, ['show', `${retired.snapshotRef}:a.txt`])).toBe('written during the check')
})

test('trash expiry reads the folder again before deleting it: a change since its snapshot is captured and the delete waits', async () => {
  const f = await fixture()
  f.service.prepare(f.input)
  const trashed = f.service.retire(f.path)
  const later = Date.now() + 2 * WORKTREE_TRASH_QUIET_MS
  const outcome = f.service.expireTrash(f.path, { now: later, afterCapture: (path) => writeFileSync(join(path, 'b.txt'), 'written after the snapshot\n') })
  expect(outcome).toEqual({ kept: expect.stringMatching(/changed while it was being deleted.*kept as a snapshot.*next run/), waiting: true })
  expect(readFileSync(join(trashed.trashPath!, 'b.txt'), 'utf8')).toBe('written after the snapshot\n')
  const manifest = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(manifest.state).toBe('trashed')
  expect(git(f.repo, ['show', `${manifest.snapshotRef}:b.txt`])).toBe('written after the snapshot')
  // With nothing changing any more, a later run deletes it.
  expect(f.service.expireTrash(f.path, { now: later + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
})

test('an owned branch name that is a symbolic ref is never followed: the branch it points at stays', async () => {
  const f = await fixture()
  const main = git(f.repo, ['symbolic-ref', '--short', 'HEAD']), mainSha = git(f.repo, ['rev-parse', main])
  git(f.worktree, ['switch', '-q', '--detach'])
  git(f.repo, ['symbolic-ref', `refs/heads/${f.branch}`, `refs/heads/${main}`])
  f.service.prepare(f.input)
  f.service.retire(f.path)
  expect(f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  expect(git(f.repo, ['rev-parse', main])).toBe(mainSha)
  expect(git(f.repo, ['symbolic-ref', `refs/heads/${f.branch}`])).toBe(`refs/heads/${main}`)
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toBeUndefined()
})

test('trash expiry never drops an earlier pin: a commit the folder moved away from stays kept, and a restore brings its branch back', async () => {
  const f = await fixture()
  writeFileSync(join(f.worktree, 'a.txt'), 'committed\n'); git(f.worktree, ['commit', '-qam', 'work'])
  const work = git(f.worktree, ['rev-parse', 'HEAD'])
  git(f.worktree, ['switch', '-q', '--detach'])
  f.service.prepare(f.input)
  const trashed = f.service.retire(f.path)
  // The branch was not checked out anywhere, so the move released it: only the pin keeps its commit now.
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toEqual([{ name: f.branch, sha: work }])
  // In the trash, the folder goes back to where it started, away from the commit.
  git(trashed.trashPath!, ['checkout', '-q', `${work}^`])
  expect(f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  const retired = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(retired.keptRefs).toEqual([expect.stringMatching(new RegExp(`/kept/${work}$`))])
  git(f.repo, ['gc', '--prune=now', '-q'])
  expect(git(f.repo, ['cat-file', '-t', work])).toBe('commit')
  f.service.reconstruct(f.path)
  expect(git(f.repo, ['rev-parse', `refs/heads/${f.branch}`])).toBe(work)
})

test('a branch the agent made itself, and a worktree the agent added, are never touched', async () => {
  const f = await fixture()
  git(f.worktree, ['switch', '-q', '-c', 'agent/own-work'])
  const own = join(f.root, 'agent-worktree'); git(f.worktree, ['worktree', 'add', '-q', '-b', 'agent/second', own])
  f.service.prepare(f.input)
  const trashed = f.service.retire(f.path)
  expect(f.service.expireTrash(f.path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
  // The thread's own branch was not checked out anywhere, so it went with the move; the agent's branches stay.
  expect(JSON.parse(readFileSync(f.path, 'utf8')).deletedBranches).toEqual([{ name: f.branch, sha: trashed.resultSha }])
  expect(git(f.repo, ['branch', '--list', 'agent/own-work', 'agent/second', '--format=%(refname:short)'])).toBe('agent/own-work\nagent/second')
  expect(readFileSync(join(own, 'a.txt'), 'utf8')).toBe('first\n')
  expect(listed(f.repo)).toContain(slashes(own))
})
test('missing pins never authorize recall or retirement', async () => {
  const f = await fixture(); const manifest = f.service.prepare(f.input)
  git(f.repo, ['update-ref', '-d', manifest.resultRef, manifest.resultSha])
  expect(() => f.service.retire(f.path)).toThrow()
  expect(existsSync(resolve(f.worktree))).toBe(true)
})

test('a byte-identical externally replaced checkout fails frozen root identity', async () => {
  const f = await fixture(); f.service.prepare(f.input)
  const original = join(f.root, 'original-checkout'); renameSync(f.worktree, original); cpSync(original, f.worktree, { recursive: true })
  expect(git(f.worktree, ['status', '--porcelain'])).toBe('')
  expect(() => f.service.retire(f.path)).toThrow(/identity|replaced|changed/i)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(readFileSync(join(original, 'a.txt'), 'utf8')).toBe('first\n')
})

test('empty directory shape is reproduced and a malformed manifest fails before reconstruction', async () => {
  const f = await fixture(); mkdirSync(join(f.worktree, 'empty', 'nested'), { recursive: true })
  const manifest = f.service.prepare(f.input); f.service.retire(f.path)
  writeFileSync(f.path, JSON.stringify({ ...manifest, checkoutFingerprint: 'unverified' }))
  expect(() => f.service.reconstruct(f.path)).toThrow(/Manifest/)
  expect(existsSync(f.worktree)).toBe(false)
  writeFileSync(f.path, JSON.stringify(manifest)); f.service.reconstruct(f.path)
  expect(existsSync(join(f.worktree, 'empty', 'nested'))).toBe(true)
})

test('an outside-root Mousse-named linked checkout remains retained even with a forged matching agent row', async () => {
  const f = await fixture(), foreign = join(f.root, 'user-checkout'), branch = 'mousse/agent/outside'
  git(f.repo, ['worktree', 'add', '-b', branch, foreign])
  writeFileSync(f.input.sourcePath, JSON.stringify([{ id: 'outside', worktreePath: foreign, branch }]))
  expect(() => f.service.prepare({ ...f.input, branch, worktreePath: foreign })).toThrow(/generated workspace location/)
  expect(() => f.service.inspectForDiscard({ ...f.input, branch, worktreePath: foreign })).toThrow(/generated workspace location/)
  expect(readFileSync(join(foreign, 'a.txt'), 'utf8')).toBe('first\n')
})

test('direct retirement preserves a checkout still referenced by another task', async () => {
  const f = await fixture(); f.service.prepare(f.input)
  const peer = join(f.home, 'thread-data', 'peer'); mkdirSync(peer, { recursive: true })
  writeFileSync(join(peer, 'meta.json'), JSON.stringify({ id: 'peer' }))
  writeFileSync(join(peer, 'agents.json'), JSON.stringify([{ id: 'worker', branch: f.branch, worktreePath: f.worktree, status: 'ready' }]))
  f.store.registerTask({ taskId: 'peer', location: peer })
  expect(() => f.service.retire(f.path)).toThrow(/Another task/)
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
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
  expect(() => f.service.prepare(f.input), 'Clean-filter equivalence cannot authorize loss of the original materialized bytes').toThrow(/reconstruct.*exact|materialized/i)
  expect(readFileSync(path)).toEqual(soleCopy)
})

test('retires canonical CRLF materialization and reconstructs exactly the same bytes after service restart', async () => {
  const f = await fixture(false, true)
  const original = readFileSync(join(f.worktree, 'value.txt'))
  expect(original).toEqual(Buffer.from('first\r\nsecond\r\n'))
  const primaryHead = git(f.repo, ['rev-parse', 'HEAD'])
  f.service.prepare(f.input); f.service.retire(f.path)
  expect(existsSync(f.worktree)).toBe(false)
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }), f.ownership)
  restarted.reconstruct(f.path)
  expect(readFileSync(join(f.worktree, 'value.txt'))).toEqual(original)
  expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(primaryHead)
})

test('refuses a reconstruction pin redirected to a primary branch before updating retained results', async () => {
  const f = await fixture(false, true)
  const manifest = f.service.prepare(f.input)
  const primary = git(f.repo, ['symbolic-ref', 'HEAD']), original = git(f.repo, ['rev-parse', primary])
  writeFileSync(join(f.worktree, 'value.txt'), 'new child result\r\n')
  git(f.worktree, ['add', 'value.txt']); git(f.worktree, ['commit', '-qm', 'new child result'])
  git(f.repo, ['symbolic-ref', manifest.resultRef, primary])
  expect(() => f.service.prepare(f.input)).toThrow(/symbolic|pin|reference/i)
  expect(git(f.repo, ['rev-parse', primary])).toBe(original)
  expect(git(f.repo, ['symbolic-ref', manifest.resultRef])).toBe(primary)
})
