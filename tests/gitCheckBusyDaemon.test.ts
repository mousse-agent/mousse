/**
 * The check before each of Mousse's own Git commands (the central Git check, the Git directory, the repository's
 * programs) waits on file reads. On a daemon whose main thread is busy, every such wait costs a whole turn of the event
 * loop, so the number of waits one after another is what a command pays: nine to fourteen of them made each command
 * of a checkpoint take about 280 ms on a saturated daemon (#1244). The turns are counted with a loop that keeps the
 * main thread busy, as a daemon serving several turns does.
 *
 * That the check still sees a change made since its last answer is covered where each part is: a config written since
 * (`repoProgramsAsync.test.ts`), a `.git` file pointed elsewhere after the async check answered the same command
 * (`gitPolicyGitFolderCache.test.ts`), and planted programs that still do not run (`gitNoRepoPrograms.test.ts`).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardedAsync, operationInProgressAsync } from '../src/mms/actions/git'
import { clearGitCheckReadAhead } from '../src/mms/git/gitPolicy'
import { clearGitFolderCache } from '../src/mms/git/gitFolderCache'
import { clearRepoProgramCache } from '../src/mms/git/repoPrograms'
import { folderAccess } from '../src/mms/files/folderAccess'

let root: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function repository(name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  git(path, 'init', '-q', '-b', 'main')
  writeFileSync(join(path, 'a.txt'), 'a\n')
  git(path, 'add', 'a.txt')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

/** Turns of the event loop `work` waited through while each turn holds the main thread for `busyMs`. */
async function turnsWhileBusy(work: () => Promise<unknown>, busyMs = 10): Promise<number> {
  let turns = 0
  let done = false
  const hog = (): void => {
    if (done) return
    turns += 1
    const end = performance.now() + busyMs
    while (performance.now() < end) { /* busy, as a daemon serving other turns */ }
    setImmediate(hog)
  }
  setImmediate(hog)
  try {
    await work()
  } finally {
    done = true
  }
  return turns
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-git-check-busy-')))
  clearRepoProgramCache()
  clearGitFolderCache()
  clearGitCheckReadAhead()
  folderAccess.reset()
})

afterEach(() => {
  clearRepoProgramCache()
  clearGitFolderCache()
  clearGitCheckReadAhead()
  folderAccess.reset()
  rmSync(root, { recursive: true, force: true })
})

describe('the check before a Git command on a busy daemon', () => {
  // Each row is a kind of command a checkpoint runs, with the most turns it may wait through once the check knows what
  // it reads. In this test, before #1244: 9 for a read, 21 for a private index and 11 for an owned ref.
  const rows: Array<{ name: string; args: string[]; most: number; env?: (path: string) => NodeJS.ProcessEnv }> = [
    // The check's read and a second pass, the Git directory, then each config file looked at one after another.
    { name: 'a read', args: ['rev-parse', 'HEAD'], most: 3 },
    // The central check also follows the private index to the checkout's Git folder (`gitFolderCache.ts`, whose own
    // few looks still run one after another).
    { name: 'a write to a private index', args: ['read-tree', 'HEAD'], most: 6, env: (path) => ({ GIT_INDEX_FILE: join(path, '.git', 'mousse', 'snapshot-index') }) },
    { name: 'a write to an owned ref', args: ['update-ref', '--no-deref', 'refs/mousse/snapshot', 'HEAD'], most: 3 }
  ]
  for (const row of rows) {
    it(`${row.name} waits through at most ${row.most} turns once the check knows what it reads`, async () => {
      const path = repository('repo')
      const env = row.env?.(path)
      const options = env ? { env } : undefined
      // The first command reads the repository's config and learns which files the check needs.
      const first = await guardedAsync(path, row.args, options)
      expect(first.slice(-row.args.length)).toEqual(row.args)
      const turns = await turnsWhileBusy(async () => expect(await guardedAsync(path, row.args, options)).toEqual(first))
      expect(turns).toBeLessThanOrEqual(row.most)
    })
  }

  it('a changed config is read before the next command, and that read looks at the files together, not one by one', async () => {
    const path = repository('changed')
    await guardedAsync(path, ['rev-parse', 'HEAD'])
    git(path, 'config', 'filter.planted.clean', 'planted-clean')
    let args: string[] = []
    const turns = await turnsWhileBusy(async () => { args = await guardedAsync(path, ['rev-parse', 'HEAD']) })
    expect(args).toContain('filter.planted.clean=')
    // Two Git processes (where the repository is, its config) and the files looked at before and after them: 39 turns
    // before #1244, about 18 now.
    expect(turns).toBeLessThanOrEqual(26)
  })
})

describe('the Git operation waiting in a checkout, read with one Git command', () => {
  /** Leaves `operation` unfinished in `path`, with a conflict where it stops on one. */
  function start(path: string, operation: 'merge' | 'revert' | 'cherry-pick' | 'rebase-merge' | 'rebase-apply' | 'none', home: string): void {
    if (operation === 'none') return
    const side = `${home}-side`
    git(path, 'switch', '-q', '-c', side)
    writeFileSync(join(path, 'a.txt'), 'side\n')
    git(path, 'commit', '-q', '-am', 'side')
    git(path, 'switch', '-q', home)
    writeFileSync(join(path, 'a.txt'), 'main\n')
    git(path, 'commit', '-q', '-am', 'main')
    const run = (...args: string[]): void => { expect(() => git(path, ...args)).toThrow() }
    if (operation === 'merge') run('merge', '-q', side)
    if (operation === 'revert') run('revert', '--no-edit', `${home}~1`)
    if (operation === 'cherry-pick') run('cherry-pick', side)
    if (operation === 'rebase-merge') run('rebase', '-q', '--merge', side)
    if (operation === 'rebase-apply') run('rebase', '-q', '--apply', side)
  }

  const rows = [
    { operation: 'none', expected: undefined },
    { operation: 'merge', expected: 'merge' },
    { operation: 'revert', expected: 'revert' },
    { operation: 'cherry-pick', expected: 'cherry-pick' },
    { operation: 'rebase-merge', expected: 'rebase' },
    { operation: 'rebase-apply', expected: 'rebase' }
  ] as const

  for (const { operation, expected } of rows) {
    it(`${operation}: in the main checkout and in a linked worktree`, async () => {
      const main = repository('main')
      start(main, operation, 'main')
      expect(await operationInProgressAsync(main)).toBe(expected)
      const base = repository('base')
      const linked = join(root, 'linked')
      git(base, 'worktree', 'add', '-q', '-b', 'thread', linked)
      start(linked, operation, 'thread')
      expect(await operationInProgressAsync(linked)).toBe(expected)
      // The worktree's operation is its own: the checkout it was made from has none.
      expect(await operationInProgressAsync(base)).toBeUndefined()
    })
  }
})
