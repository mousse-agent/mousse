/**
 * A thread's worktree is checked from Git's files (`readWorktreeHead`), so its turn starts with no Git process. Each row
 * builds a real repository layout and compares the answer with Git's own (`rev-parse HEAD`, `symbolic-ref -q HEAD`);
 * a layout only Git can read answers undefined, so the caller asks Git.
 *
 * Rows: main checkout, linked worktree, a branch only in `packed-refs`, a loose ref newer than its packed line,
 * detached HEAD, a branch with no commit yet, the reftable format, a `.git` file pointing nowhere; and, for a linked
 * worktree only, the main checkout, a copied `.git` file, and a new repository made in an emptied worktree.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorktreeHead } from '../src/mms/git/worktreeHeadFiles'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (cwd: string, ...args: string[]): string | undefined => { try { return git(cwd, ...args) || undefined } catch { return undefined } }

function repository(...initArgs: string[]): string {
  const base = mkdtempSync(join(tmpdir(), 'mousse-head-files-')); roots.push(base)
  const repo = join(base, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', ...initArgs); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@example.test')
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one')
  return repo
}

/** What Git says of HEAD in `top`. */
const gitHead = (top: string) => {
  const head = tryGit(top, 'rev-parse', '--verify', '-q', 'HEAD^{commit}')
  const headRef = tryGit(top, 'symbolic-ref', '-q', 'HEAD')
  return { ...(head ? { head } : {}), ...(headRef ? { headRef } : {}) }
}

const gitVersion = (): [number, number] => { const [, major, minor] = git(tmpdir(), 'version').match(/(\d+)\.(\d+)/)!; return [Number(major), Number(minor)] }

describe('HEAD read from Git\'s files', () => {
  const rows: Array<[string, () => string]> = [
    ['the main checkout', () => repository()],
    ['a linked worktree on its own branch', () => {
      const repo = repository()
      const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/one', worktree)
      writeFileSync(join(worktree, 'b.txt'), 'b\n'); git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'two')
      return worktree
    }],
    ['a worktree whose branch is only in packed-refs', () => {
      const repo = repository()
      const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/packed', worktree)
      git(repo, 'pack-refs', '--all')
      return worktree
    }],
    ['a loose ref newer than its packed line', () => {
      const repo = repository()
      git(repo, 'pack-refs', '--all')
      writeFileSync(join(repo, 'c.txt'), 'c\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'three')
      return repo
    }],
    ['a detached worktree', () => {
      const repo = repository()
      const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '--detach', worktree)
      return worktree
    }],
    ['a branch with no commit yet', () => {
      const repo = repository()
      git(repo, 'switch', '-q', '--orphan', 'empty')
      return repo
    }]
  ]
  it.each(rows)('%s: the same as Git', (_name, make) => {
    const top = make()
    return expect(readWorktreeHead(top)).resolves.toEqual(gitHead(top))
  })

  it('leaves a reftable repository to Git', async () => {
    const [major, minor] = gitVersion()
    if (major < 2 || (major === 2 && minor < 45)) return
    const repo = repository('--ref-format=reftable')
    expect(gitHead(repo).head).toBeDefined()
    expect(await readWorktreeHead(repo)).toBeUndefined()
  })

  it('reads a linked worktree only while its Git folder links back to it', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/linked', worktree)
    expect(await readWorktreeHead(worktree, { linkedOnly: true })).toEqual(gitHead(worktree))
    // The main checkout is no linked worktree.
    expect(await readWorktreeHead(repo, { linkedOnly: true })).toBeUndefined()
    // A copy of the worktree's `.git` file elsewhere names a Git folder that links back to the worktree, not to it.
    const copy = join(repo, '..', 'copy'); mkdirSync(copy)
    writeFileSync(join(copy, '.git'), readFileSync(join(worktree, '.git')))
    expect(await readWorktreeHead(copy, { linkedOnly: true })).toBeUndefined()
  })

  it('leaves an emptied worktree that someone made a new repository in to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/reinit', worktree)
    rmSync(join(worktree, '.git'), { force: true }); rmSync(join(worktree, 'a.txt'), { force: true })
    git(worktree, 'init', '-q')
    expect(await readWorktreeHead(worktree, { linkedOnly: true })).toBeUndefined()
  })

  it('leaves a worktree whose Git folder is gone to Git', async () => {
    const repo = repository()
    const worktree = join(repo, '..', 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'thread/gone', worktree)
    rmSync(join(repo, '.git', 'worktrees'), { recursive: true, force: true })
    expect(await readWorktreeHead(worktree)).toBeUndefined()
  })
})
