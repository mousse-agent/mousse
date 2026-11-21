/**
 * Whether Git lists a worktree at a path, and why it is locked, read from Git's own registrations
 * (`<common>/worktrees/<id>/gitdir`, `locked`) instead of running `git worktree list`, which reads every worktree of the
 * repository. These answers guard deletes (`verifiedDelete`), so each must be the listing's answer, for every kind of
 * registration and every spelling of a path Mousse compares, with no Git process started.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { worktreeLockAsync, worktreeRegisteredAsync, samePath } from '../src/mms/lifecycle/verifiedDelete'
import { findListedWorktreeAsync, WorktreeListPass, type SamePath } from '../src/mms/lifecycle/worktreeRegistry'

const FIXTURE_ENV = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const roots: string[] = []
afterEach(() => {
  delete process.env.GIT_TRACE2_EVENT
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: FIXTURE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const gitVersion = (): number[] => (git(tmpdir(), '--version').match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
const relativePathsSupported = (): boolean => { const [major = 0, minor = 0] = gitVersion(); return major > 2 || major === 2 && minor >= 48 }

/** The slow answer: `git worktree list --porcelain`, compared with `same` as each caller compared it before. */
async function listed(commonDir: string, path: string, same: SamePath): Promise<{ registered: boolean; locked?: string }> {
  let current: string | undefined
  let registered = false
  let locked: string | undefined
  for (const line of git(commonDir, 'worktree', 'list', '--porcelain').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { current = line.slice(9); if (await same(current, path)) registered = true }
    else if (current !== undefined && (line === 'locked' || line.startsWith('locked ')) && await same(current, path)) locked ??= line.slice('locked'.length).trim()
  }
  return { registered, ...(locked !== undefined ? { locked } : {}) }
}

/** `WorkflowWorkspace`'s comparison: both real paths (links resolved), case folded on Windows. */
const realSame: SamePath = async (a, b) => {
  const real = async (path: string) => { try { return await realpath(resolve(path)) } catch { return resolve(path) } }
  const [x, y] = [await real(a), await real(b)]
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * A repository with one worktree of each kind Git registers. The rows: the main worktree; a plain linked one; one locked
 * with a reason and one without; one whose folder was deleted (prunable); one moved by `git worktree move` (its
 * registration keeps the old name); one whose `.git` file names another registration; one written with relative paths
 * (Git 2.48 and later).
 */
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-worktree-registry-')))
  roots.push(root)
  const main = join(root, 'main')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'config', 'user.name', 'Registry fixture')
  git(main, 'config', 'user.email', 'registry@example.invalid')
  writeFileSync(join(main, 'base.txt'), 'base\n')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'base')
  const add = (name: string, ...extra: string[]) => { const path = join(root, 'wt', name); git(main, 'worktree', 'add', '-q', ...extra, '-b', name, path); return path }
  const plain = add('plain')
  const lockedWithReason = add('locked-reason')
  git(main, 'worktree', 'lock', '--reason', 'on a drive that is away', lockedWithReason)
  const lockedPlain = add('locked-plain')
  git(main, 'worktree', 'lock', lockedPlain)
  const prunable = add('prunable')
  rmSync(prunable, { recursive: true, force: true })
  const beforeMove = add('before-move')
  const moved = join(root, 'wt', 'moved-here')
  git(main, 'worktree', 'move', beforeMove, moved)
  const misled = add('misled')
  // Its own `.git` names the plain worktree's registration: only the full read finds it.
  // (Removed first: Git for Windows hides `.git`, and a hidden file cannot be opened for writing.)
  const pointer = readFileSync(join(plain, '.git'), 'utf8')
  rmSync(join(misled, '.git'))
  writeFileSync(join(misled, '.git'), pointer)
  const relativeOne = relativePathsSupported() ? add('relative', '--relative-paths') : undefined
  // The same folders through a link: a junction on Windows, a symbolic link elsewhere.
  const linked = join(root, 'linked-wt')
  symlinkSync(join(root, 'wt'), linked, process.platform === 'win32' ? 'junction' : 'dir')
  const commonDir = join(main, '.git')
  const worktrees = [main, plain, lockedWithReason, lockedPlain, prunable, moved, misled, ...(relativeOne ? [relativeOne] : [])]
  return { root, main, commonDir, worktrees, beforeMove, linked }
}

/** Every spelling of each worktree's path Mousse compares, and paths Git does not list. */
function queries(fixture: ReturnType<typeof repository>): string[] {
  const paths = new Set<string>()
  for (const path of fixture.worktrees) {
    paths.add(path)
    paths.add(`${path}${process.platform === 'win32' ? '\\' : '/'}`)
    if (process.platform === 'win32' || process.platform === 'darwin') paths.add(path.toUpperCase())
    if (dirname(path) === join(fixture.root, 'wt')) paths.add(join(fixture.linked, basename(path)))
  }
  paths.add(fixture.beforeMove)
  paths.add(join(fixture.root, 'wt', 'never-registered'))
  paths.add(fixture.root)
  return [...paths]
}

it('answers as `git worktree list` does for every kind of registration and every spelling of a path', async () => {
  const fixture = repository()
  for (const path of queries(fixture)) {
    for (const [name, same] of [['samePath', samePath], ['real paths', realSame]] as const) {
      const slow = await listed(fixture.commonDir, path, same)
      const found = await findListedWorktreeAsync(fixture.commonDir, path, same)
      expect({ path, name, registered: Boolean(found) }).toEqual({ path, name, registered: slow.registered })
      // Git never lists the main worktree as locked.
      const lock = (await findListedWorktreeAsync(fixture.commonDir, path, same, { main: false }))?.locked
      expect({ path, name, locked: lock }).toEqual({ path, name, locked: slow.locked })
    }
    expect(await worktreeRegisteredAsync(fixture.commonDir, path)).toBe((await listed(fixture.commonDir, path, samePath)).registered)
    expect(await worktreeLockAsync(fixture.commonDir, path)).toBe((await listed(fixture.commonDir, path, samePath)).locked)
  }
})

it('a repository that is not there stops the check, as the listing did', async () => {
  const fixture = repository()
  await expect(worktreeLockAsync(join(fixture.root, 'gone', '.git'), fixture.worktrees[1]!)).rejects.toThrow(/not a Git repository/)
  await expect(worktreeRegisteredAsync(join(fixture.root, 'gone', '.git'), fixture.worktrees[1]!)).rejects.toThrow(/not a Git repository/)
})

it('starts no Git process', async () => {
  const fixture = repository()
  const trace = join(fixture.root, 'trace')
  mkdirSync(trace)
  process.env.GIT_TRACE2_EVENT = trace
  for (const path of queries(fixture)) {
    await worktreeRegisteredAsync(fixture.commonDir, path)
    await worktreeLockAsync(fixture.commonDir, path)
  }
  delete process.env.GIT_TRACE2_EVENT
  const started = readdirSync(trace).flatMap((file) => readFileSync(join(trace, file), 'utf8').split('\n').filter((line) => line.includes('"event":"start"')))
  expect(started).toEqual([])
})

it('reads the registrations once for every path a pass asks about, and again once Git adds a worktree', async () => {
  const fixture = repository()
  const pass = new WorktreeListPass()
  const unlisted = join(fixture.root, 'wt', 'candidate')
  expect(await findListedWorktreeAsync(fixture.commonDir, unlisted, samePath, { pass })).toBeUndefined()
  // Registered after the pass read the registrations: the `worktrees/` folder changed, so it is read again.
  git(fixture.main, 'worktree', 'add', '-q', '-b', 'candidate', unlisted)
  rmSync(unlisted, { recursive: true, force: true })
  expect(await findListedWorktreeAsync(fixture.commonDir, unlisted, samePath, { pass })).toBeDefined()
})
