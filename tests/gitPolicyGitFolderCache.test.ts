/**
 * The Git check keeps a checkout's Git folder between commands (`gitFolderCache.ts`): a command on one of Mousse's
 * private index files no longer starts `git rev-parse --absolute-git-dir` each time, and anything that could change
 * Git's answer makes it read again. Processes are counted with a logging `git` first on PATH.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { clearGitFolderCache } from '../src/mms/git/gitFolderCache'
import { decideGitCommand, decideGitCommandAsync, type GitCommandRequest } from '../src/mms/git/gitPolicy'
import { actionOptions, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

const roots: string[] = []
let root: string
let log: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** How many `--absolute-git-dir` reads started since the last call. */
function reads(): number {
  if (!existsSync(log)) return 0
  const count = readFileSync(log, 'utf8').split('\n').filter(Boolean).length
  unlinkSync(log)
  return count
}

/** A `git` first on PATH that logs each `--absolute-git-dir` read, then runs the real Git. */
function countReads(): void {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" --absolute-git-dir "*) echo read >> '${log}' ;;\nesac\nexec '${real}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
}

/** Writes `index` through the Git check, run in `cwd`: whether a command on it would be allowed. */
const writes = (cwd: string, index: string, env: NodeJS.ProcessEnv = {}): boolean => decideGitCommand(request(cwd, index, env)).allowed
const request = (cwd: string, index: string, env: NodeJS.ProcessEnv = {}): GitCommandRequest => ({ cwd, args: ['read-tree', 'HEAD'], env: { ...env, GIT_INDEX_FILE: index } })

/** A repository with one commit, and two Mousse worktrees linked from it. */
function repository() {
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base')
  const linked = (name: string) => {
    const worktree = join(root, name)
    git(repo, 'worktree', 'add', '-q', '-b', `mousse/thread/${name}/main`, worktree)
    return { worktree, gitDir: git(worktree, 'rev-parse', '--absolute-git-dir') }
  }
  const made = { repo, gitDir: join(repo, '.git'), a: linked('a'), b: linked('b') }
  reads()
  return made
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-git-folder-cache-')))
  roots.push(root)
  log = join(root, 'reads.log')
  clearGitFolderCache()
  countReads()
})

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
  clearGitFolderCache()
})

describe('the Git check keeps a checkout\'s Git folder', () => {
  it('a 1-file Undo starts at most 2 Git folder reads, and gives back the bytes', { timeout: 60_000 }, async () => {
    const f = gitFoundationFixture()
    try {
      git(f.repo, 'config', 'core.autocrlf', 'true')
      for (let index = 0; index < 20; index++) writeFileSync(join(f.repo, `file-${index}.txt`), `file ${index}\r\n`)
      execFileSync('git', ['add', '.'], { cwd: f.repo, stdio: 'ignore' })
      execFileSync('git', ['commit', '-qm', 'files'], { cwd: f.repo, stdio: 'ignore' })
      const before = readFileSync(join(f.repo, 'file-7.txt'))
      await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(f.repo, 'turn'), () => writeFileSync(join(f.repo, 'file-7.txt'), 'agent\n'))
      clearGitFolderCache()
      reads()
      await pressed('Undo', () => new UndoService(f.thread).undoLatest('main', f.repo))
      expect(reads()).toBeLessThanOrEqual(2)
      expect(readFileSync(join(f.repo, 'file-7.txt')).equals(before)).toBe(true)
    } finally {
      f.dispose()
    }
  })

  it('answers again from the cache while nothing changed, and a Mousse index in the folder changes nothing', () => {
    const { repo, gitDir } = repository()
    expect(writes(repo, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
    // Making an index in `.git` changes the folder's times, not its identity.
    writeFileSync(join(gitDir, 'mousse-pending-1.index'), 'x')
    mkdirSync(join(gitDir, 'mousse'), { recursive: true })
    expect(writes(repo, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(writes(repo, join(gitDir, 'mousse', 'restore-a.index'))).toBe(true)
    expect(reads()).toBe(0)
  })

  it('a rewritten .git file reads again and follows the new Git folder', () => {
    const { a, b } = repository()
    expect(writes(a.worktree, join(a.gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(writes(a.worktree, join(a.gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
    // The same length: only the text tells them apart.
    writeFileSync(join(a.worktree, '.git'), `gitdir: ${b.gitDir}\n`)
    expect(writes(a.worktree, join(a.gitDir, 'mousse-pending-1.index'))).toBe(false)
    expect(writes(a.worktree, join(b.gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
  })

  it('git init in a subfolder reads again and follows the new repository', () => {
    const { repo, gitDir } = repository()
    const sub = join(repo, 'sub')
    mkdirSync(sub)
    expect(writes(sub, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(writes(sub, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
    git(sub, 'init', '-q')
    expect(writes(sub, join(gitDir, 'mousse-pending-1.index'))).toBe(false)
    expect(writes(sub, join(sub, '.git', 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
  })

  it('a Git folder replaced at the same path reads again', () => {
    const { repo, gitDir } = repository()
    expect(writes(repo, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
    renameSync(gitDir, join(repo, 'old.git'))
    git(repo, 'init', '-q')
    expect(writes(repo, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
    // A .git folder replaced by a .git file.
    rmSync(gitDir, { recursive: true })
    writeFileSync(join(repo, '.git'), `gitdir: ${join(repo, 'old.git')}\n`)
    expect(writes(repo, join(gitDir, 'mousse-pending-1.index'))).toBe(false)
    expect(writes(repo, join(repo, 'old.git', 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
  })

  it('a .git file whose target goes through a link reads every time, so a repointed link is followed', () => {
    const { a, b } = repository()
    const link = join(root, 'link')
    symlinkSync(a.gitDir, link)
    writeFileSync(join(a.worktree, '.git'), `gitdir: ${link}\n`)
    expect(writes(a.worktree, join(a.gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(writes(a.worktree, join(a.gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(2)
    unlinkSync(link)
    symlinkSync(b.gitDir, link)
    expect(writes(a.worktree, join(a.gitDir, 'mousse-pending-1.index'))).toBe(false)
    expect(writes(a.worktree, join(b.gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(2)
  })

  it('a changed GIT_DIR or GIT_COMMON_DIR reads again', () => {
    const { gitDir } = repository()
    // Run inside the Git folder, as retirement does: Mousse names it as GIT_DIR.
    expect(writes(gitDir, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(writes(gitDir, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(reads()).toBe(1)
    expect(writes(gitDir, join(gitDir, 'mousse-pending-1.index'), { GIT_DIR: '.' })).toBe(true)
    expect(writes(gitDir, join(gitDir, 'mousse-pending-1.index'), { GIT_DIR: '.' })).toBe(true)
    expect(reads()).toBe(1)
    // Inherited from Mousse's own environment, so the check lets it through; the read itself drops it.
    vi.stubEnv('GIT_COMMON_DIR', join(root, 'elsewhere'))
    expect(writes(gitDir, join(gitDir, 'mousse-pending-1.index'), { GIT_COMMON_DIR: join(root, 'elsewhere') })).toBe(true)
    expect(reads()).toBe(1)
  })

  it('still refuses a Mousse-named index in another checkout\'s Git folder, and a checkout\'s own index', () => {
    const { repo, gitDir, a } = repository()
    const other = join(root, 'other')
    mkdirSync(other)
    git(other, 'init', '-q')
    expect(writes(repo, join(gitDir, 'mousse-pending-1.index'))).toBe(true)
    expect(writes(repo, join(other, '.git', 'mousse-pending-1.index'))).toBe(false)
    expect(writes(repo, join(other, '.git', 'mousse', 'snapshot-index'))).toBe(false)
    expect(writes(repo, join(a.gitDir, 'mousse-pending-1.index'))).toBe(false)
    expect(writes(repo, join(gitDir, 'index'))).toBe(false)
    expect(writes(a.worktree, join(gitDir, 'mousse-pending-1.index'))).toBe(false)
    expect(writes(a.worktree, join(a.gitDir, 'index'))).toBe(false)
  })

  it('never keeps a failed read', () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(writes(plain, join(root, 'nowhere', '.git', 'mousse-pending-1.index'))).toBe(false)
    expect(writes(plain, join(root, 'nowhere', '.git', 'mousse-pending-1.index'))).toBe(false)
    expect(reads()).toBe(2)
  })

  it('the check without blocking decides the same, from the same cache', async () => {
    const { repo, gitDir, a, b } = repository()
    const cases = [request(repo, join(gitDir, 'mousse-pending-1.index')), request(repo, join(a.gitDir, 'mousse-pending-1.index')), request(a.worktree, join(a.gitDir, 'mousse', 'snapshot-index'))]
    for (const each of cases) expect(await decideGitCommandAsync(each)).toEqual(decideGitCommand(each))
    reads()
    for (const each of cases) await decideGitCommandAsync(each)
    expect(reads()).toBe(0)
    writeFileSync(join(a.worktree, '.git'), `gitdir: ${b.gitDir}\n`)
    expect((await decideGitCommandAsync(cases[2]!)).allowed).toBe(false)
    expect((await decideGitCommandAsync(request(a.worktree, join(b.gitDir, 'mousse-pending-1.index')))).allowed).toBe(true)
    expect(reads()).toBe(1)
    expect(decideGitCommand(cases[2]!).allowed).toBe(false)
  })
})
