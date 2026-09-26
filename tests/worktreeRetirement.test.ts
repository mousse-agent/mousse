import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { lifecycleGit as git, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(sparse = false) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-retire-')); roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); writeFileSync(join(repo, 'b.txt'), 'second\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base'])
  const home = join(root, 'profile'), task = join(home, 'thread-data', 'task'); mkdirSync(task, { recursive: true })
  writeFileSync(join(task, 'meta.json'), JSON.stringify({ id: 'task' }))
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location: task })
  const worktree = join(root, 'checkout'), branch = 'mousse/agent/worker'
  git(repo, ['worktree', 'add', ...(sparse ? ['--no-checkout'] : []), '-b', branch, worktree])
  if (sparse) {
    git(worktree, ['sparse-checkout', 'set', '--no-cone', '--stdin'], 'a.txt\n'); git(worktree, ['checkout', 'HEAD'])
    mkdirSync(join(worktree, '.mousse')); const exclude = join(worktree, '.mousse', 'materialized-inputs.exclude')
    writeFileSync(exclude, '.mousse/\nnode_modules\n\n'); git(worktree, ['config', '--worktree', 'core.excludesFile', exclude])
  }
  const sourcePath = join(task, 'agents.json'); writeFileSync(sourcePath, JSON.stringify([{ id: 'worker', worktreePath: worktree, branch }]))
  const service = new WorktreeRetirementService(store)
  return { root, repo, home, worktree, branch, store, service, input: { taskId: 'task', worktreePath: worktree, branch, sourcePath }, path: service.pathFor('task', worktree) }
}
test.each([false, true])('retire and reconstruct clean checkout including selective sparse controls (%s)', (sparse) => {
  const f = fixture(sparse)
  f.service.prepare(f.input); f.service.retire(f.path); expect(existsSync(f.worktree)).toBe(false)
  const restarted = new WorktreeRetirementService(new ResourceLifecycleStore({ profileId: 'test', profileHome: f.home }))
  restarted.reconstruct(f.path); expect(existsSync(join(f.worktree, 'a.txt'))).toBe(true)
  expect(existsSync(join(f.worktree, 'b.txt'))).toBe(!sparse)
  expect(git(f.repo, ['status', '--porcelain'])).toBe('')
})
test('ignored sole copy, hidden index flags and changed content block retirement', () => {
  const f = fixture(true)
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
test('missing pins and a replaced checkout never authorize recall or retirement', () => {
  const f = fixture(); const manifest = f.service.prepare(f.input)
  git(f.repo, ['update-ref', '-d', manifest.resultRef, manifest.resultSha])
  expect(() => f.service.retire(f.path)).toThrow()
  expect(existsSync(resolve(f.worktree))).toBe(true)
})
