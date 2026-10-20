import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, renameSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { waitAcquireExecutionLease, releaseExecutionLeaseHandle } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { lifecycleGit as git, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'

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
  f.service.prepare(f.input); writeFileSync(join(f.worktree, '.mousse', 'secret'), 'late copy')
  expect(() => f.service.retire(f.path)).toThrow(/Uncaptured/)
  expect(existsSync(f.worktree)).toBe(true)
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
