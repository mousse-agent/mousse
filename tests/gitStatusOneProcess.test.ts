/**
 * The side card's status is one Git process (`git status --porcelain=v2 --branch`) once the repository's settings are
 * known, callers asking together share it, and its answer is the one the earlier read with many Git processes gave.
 *
 * States compared: clean; edited; staged; staged then edited again; staged rename; deleted; untracked files in a new
 * folder; a name with spaces; an intent-to-add file; a merge stopped on a conflict; detached; a branch with no commit
 * yet; ahead of and behind its upstream; an upstream whose branch is gone; a linked worktree. Not covered: submodules.
 */
import * as childProcess from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'

let root: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// Every Git process this process starts, however it is started.
let started = 0
const prototype = (childProcess as unknown as { ChildProcess: { prototype: { spawn(options: { file?: string }): unknown } } }).ChildProcess.prototype
const spawn = prototype.spawn
beforeAll(() => {
  prototype.spawn = function (this: unknown, options: { file?: string }) {
    if (/^git(\.exe)?$/i.test(basename(String(options?.file ?? '')))) started++
    return spawn.call(this, options)
  }
})
afterAll(() => { prototype.spawn = spawn })

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-status-one-'))) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function repository(name = 'repo'): string {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  git(cwd, 'init', '-q', '-b', 'main')
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'old.txt']) writeFileSync(join(cwd, file), `${file}\n`.repeat(20))
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', 'first')
  return cwd
}

const STATES: Array<[string, (cwd: string) => string | undefined | void]> = [
  ['clean', () => undefined],
  ['edited', (cwd) => writeFileSync(join(cwd, 'a.txt'), 'changed\n')],
  ['staged', (cwd) => { writeFileSync(join(cwd, 'new.txt'), 'new\n'); git(cwd, 'add', 'new.txt') }],
  ['staged then edited again', (cwd) => { writeFileSync(join(cwd, 'a.txt'), 'one\n'); git(cwd, 'add', 'a.txt'); writeFileSync(join(cwd, 'a.txt'), 'two\n') }],
  ['staged rename', (cwd) => git(cwd, 'mv', 'old.txt', 'renamed.txt')],
  ['deleted', (cwd) => unlinkSync(join(cwd, 'b.txt'))],
  ['untracked in a new folder, and a name with spaces', (cwd) => { mkdirSync(join(cwd, 'dir', 'sub'), { recursive: true }); writeFileSync(join(cwd, 'dir', 'sub', 'x.txt'), 'x'); writeFileSync(join(cwd, 'with space.txt'), 'y') }],
  ['intent to add', (cwd) => { writeFileSync(join(cwd, 'later.txt'), 'l\n'); git(cwd, 'add', '-N', 'later.txt') }],
  ['merge stopped on a conflict', (cwd) => {
    git(cwd, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(cwd, 'a.txt'), 'theirs\n')
    git(cwd, 'commit', '-qam', 'theirs')
    git(cwd, 'checkout', '-q', 'main')
    writeFileSync(join(cwd, 'a.txt'), 'ours\n')
    git(cwd, 'commit', '-qam', 'ours')
    try { git(cwd, 'merge', 'other') } catch { /* stops on the conflict */ }
  }],
  ['detached', (cwd) => git(cwd, 'checkout', '-q', '--detach')],
  ['remote in Git’s dotted config syntax', (cwd) => {
    const file = join(cwd, '.git', 'config')
    appendFileSync(file, '\n[remote.origin]\n\turl = ../origin.git\n')
    expect(git(cwd, 'remote')).toBe('origin')
  }],
  ['ahead of and behind its upstream', (cwd) => {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '-b', 'main', '--bare', remote])
    git(cwd, 'remote', 'add', 'origin', remote)
    git(cwd, 'push', '-q', '-u', 'origin', 'main')
    const other = join(root, 'other')
    git(root, 'clone', '-q', remote, other)
    writeFileSync(join(other, 'c.txt'), 'remote\n')
    git(other, 'commit', '-qam', 'remote')
    git(other, 'push', '-q')
    writeFileSync(join(cwd, 'b.txt'), 'local\n')
    git(cwd, 'commit', '-qam', 'local')
    git(cwd, 'fetch', '-q')
  }],
  ['upstream branch gone', (cwd) => {
    const remote = join(root, 'remote.git')
    execFileSync('git', ['init', '-q', '-b', 'main', '--bare', remote])
    git(cwd, 'remote', 'add', 'origin', remote)
    git(cwd, 'checkout', '-q', '-b', 'topic')
    git(cwd, 'push', '-q', '-u', 'origin', 'topic')
    git(cwd, 'push', '-q', 'origin', '--delete', 'topic')
    git(cwd, 'fetch', '-q', '--prune')
  }],
  ['linked worktree', (cwd) => {
    const worktree = join(root, 'wt')
    git(cwd, 'worktree', 'add', '-q', '-b', 'mousse/thread', worktree)
    writeFileSync(join(worktree, 'a.txt'), 'in the worktree\n')
    return worktree
  }]
]

it.each(STATES)('%s: one Git process, the same answer as the read with many', async (_name, arrange) => {
  // A row names another folder only when it returns one (the linked worktree).
  const repo = repository()
  const other = arrange(repo)
  const cwd = typeof other === 'string' && other ? other : repo
  const service = new GitService()
  // The repository's settings are read once, on the first read.
  const first = await service.getStatus(cwd)
  started = 0
  const status = await service.getStatus(cwd)
  expect(started).toBe(1)
  expect(status).toEqual(first)
  const earlier = await (service as unknown as { readStatusWithGit(cwd: string): Promise<unknown> }).readStatusWithGit(cwd)
  expect(status).toEqual(earlier)
})

it('a branch with no commit yet reads as unborn, as before', async () => {
  const cwd = join(root, 'empty')
  mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'start')
  writeFileSync(join(cwd, 'a.txt'), 'a')
  git(cwd, 'add', '.')
  const service = new GitService()
  const status = await service.getStatus(cwd)
  expect(status).toMatchObject({ isRepo: true, branch: 'start', tracking: 'unborn' })
  expect(status).toEqual(await (service as unknown as { readStatusWithGit(cwd: string): Promise<unknown> }).readStatusWithGit(cwd))
})

it('callers asking together share one read', async () => {
  const cwd = repository()
  const service = new GitService()
  await service.getStatus(cwd)
  started = 0
  const answers = await Promise.all([service.getStatus(cwd), service.getStatus(cwd), service.getStatus(cwd)])
  expect(started).toBe(1)
  expect(answers[1]).toBe(answers[0])
  // A read after they answered is a new read.
  writeFileSync(join(cwd, 'a.txt'), 'after\n')
  expect((await service.getStatus(cwd)).changes).toHaveLength(1)
})

it('uses Git’s checkout location when core.worktree points outside the .git parent', async () => {
  const parent = repository()
  const checkout = join(root, 'separate-worktree')
  mkdirSync(checkout)
  git(parent, 'config', 'core.worktree', checkout.replace(/\\/g, '/'))
  expect(git(parent, 'rev-parse', '--is-inside-work-tree')).toBe('false')
  const service = new GitService()
  expect(await service.getStatus(parent)).toMatchObject({ isRepo: false })
})
