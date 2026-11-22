/**
 * A folder's repository and branch read from Git's files, without a Git process (`gitHead`), for every layout the
 * sidebar meets, and Git asked only for a layout the files do not tell. Each row is checked against Git's own answer.
 *
 * Layouts: a main checkout, a folder inside it, a linked worktree (`.git` file), a detached HEAD, a branch with no
 * commit yet, a folder outside any repository, a `.git` file that names no Git folder, a folder inside a Git folder,
 * a `.git` that is a link (left to Git), a reftable repository's placeholder HEAD (left to Git).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commonDirFromFiles } from '../src/mms/git/gitDirFiles'
import { branchOfHeadFile, clearFolderHeadCache, folderBranch, headFileReads, readFolderHead } from '../src/mms/git/gitHead'

let root: string
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** Git's own answer: the branch, or null when detached. */
const gitBranch = (cwd: string) => {
  try { return git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD') } catch { return null }
}

function repository(name = 'repo'): string {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  git(cwd, 'init', '-q', '-b', 'main')
  writeFileSync(join(cwd, 'a.txt'), 'a\n')
  git(cwd, 'add', '.')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first')
  return cwd
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-git-head-')))
  clearFolderHeadCache()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('a folder read from Git files', () => {
  it('a main checkout, a folder inside it, a linked worktree and a detached HEAD name what Git names', async () => {
    const main = repository()
    const inner = join(main, 'src', 'deep')
    mkdirSync(inner, { recursive: true })
    const worktree = join(root, 'wt')
    git(main, 'worktree', 'add', '-q', '-b', 'mousse/thread-1', worktree)
    const detached = join(root, 'detached')
    git(main, 'worktree', 'add', '-q', '--detach', detached)

    for (const folder of [main, inner, worktree, detached]) {
      const head = await readFolderHead(folder)
      expect(head, folder).toMatchObject({ repo: true, branch: gitBranch(folder) })
    }
    expect(await readFolderHead(worktree)).toMatchObject({ top: worktree, commonDir: join(main, '.git') })
    expect(await readFolderHead(inner)).toMatchObject({ top: main })
  })

  it('finds the checkout through a junction into a subdirectory', async () => {
    const main = repository()
    const inside = join(main, 'src', 'deep')
    mkdirSync(inside, { recursive: true })
    const junction = join(root, 'junction')
    symlinkSync(inside, junction, 'junction')
    expect(await folderBranch(junction)).toMatchObject({ repo: true, branch: gitBranch(junction) })
    expect(await commonDirFromFiles(junction)).toBe(join(git(junction, 'rev-parse', '--path-format=absolute', '--git-common-dir')))
  })

  it('reads a relative gitdir and packed branch refs', async () => {
    const main = repository()
    const worktree = join(root, 'linked')
    git(main, 'worktree', 'add', '-qb', 'packed-branch', worktree)
    const directory = git(worktree, 'rev-parse', '--absolute-git-dir')
    const dotGit = join(worktree, '.git')
    renameSync(dotGit, `${dotGit}-original`)
    writeFileSync(dotGit, `gitdir: ${relative(worktree, directory).replaceAll('\\', '/')}\n`)
    git(main, 'pack-refs', '--all')
    expect(await folderBranch(worktree)).toMatchObject({ repo: true, branch: gitBranch(worktree) })
    expect(await commonDirFromFiles(worktree)).toBe(dirname(dirname(join(directory))))
  })

  it.each(['objects', 'refs'])('checks for %s in a linked worktree’s common Git directory', async (name) => {
    const main = repository()
    const worktree = join(root, 'wt')
    git(main, 'worktree', 'add', '-q', '-b', 'linked', worktree)
    expect(await folderBranch(worktree)).toEqual({ repo: true, branch: 'linked' })
    const directory = join(main, '.git', name)
    renameSync(directory, `${directory}-away`)

    expect(() => git(worktree, 'rev-parse', '--is-inside-work-tree')).toThrow(/not a git repository|gitfile does not point to a valid repository/)
    expect(await folderBranch(worktree)).toEqual({ repo: false, branch: null })
  })

  it('a branch with no commit yet names that branch', async () => {
    const cwd = join(root, 'empty')
    mkdirSync(cwd)
    git(cwd, 'init', '-q', '-b', 'start')
    expect(await readFolderHead(cwd)).toMatchObject({ repo: true, branch: 'start' })
  })

  it('a folder outside any repository is not one', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    // The temporary folder must not itself be inside a repository for this row to mean anything.
    expect(() => git(plain, 'rev-parse', '--git-dir')).toThrow()
    expect(await readFolderHead(plain)).toEqual({ repo: false })
    expect(await folderBranch(plain)).toEqual({ repo: false, branch: null })
  })

  it('leaves to Git a .git file it cannot read and a folder inside a Git folder', async () => {
    const odd = join(root, 'odd')
    mkdirSync(odd)
    writeFileSync(join(odd, '.git'), 'not a gitdir line\n')
    expect(await readFolderHead(odd)).toBeUndefined()
    const main = repository()
    expect(await readFolderHead(join(main, '.git', 'refs'))).toBeUndefined()
  })

  it('uses Git to confirm an existing checkout and branch when its .git is a link', async () => {
    const main = repository()
    const linked = join(root, 'linked')
    mkdirSync(linked)
    symlinkSync(join(main, '.git'), join(linked, '.git'), 'junction')
    expect(await readFolderHead(linked)).toBeUndefined()
    expect(await folderBranch(linked, { requireRoot: true })).toEqual({ repo: true, branch: 'main' })
  })

  it('does not read a branch from a .git parent outside its configured checkout', async () => {
    const main = repository()
    const checkout = join(root, 'actual-checkout')
    mkdirSync(checkout)
    expect(await folderBranch(main)).toEqual({ repo: true, branch: 'main' })
    git(main, 'config', 'core.worktree', checkout.replaceAll('\\', '/'))
    expect(git(main, 'rev-parse', '--is-inside-work-tree')).toBe('false')
    expect(await folderBranch(main)).toEqual({ repo: false, branch: null })
    expect(await folderBranch(main, { requireRoot: true })).toEqual({ repo: false, branch: null })
  })

  it('reads HEAD again only when it changed', async () => {
    const main = repository()
    await readFolderHead(main)
    await readFolderHead(main)
    expect(headFileReads).toBe(1)
    git(main, 'checkout', '-q', '-b', 'feature')
    expect(await readFolderHead(main)).toMatchObject({ branch: 'feature' })
    expect(headFileReads).toBe(2)
  })
})

it.each([
  ['ref: refs/heads/main\n', 'main'],
  ['ref: refs/heads/mousse/thread/a b\n', 'mousse/thread/a b'],
  [`${'a'.repeat(40)}\n`, null],
  [`${'b'.repeat(64)}\n`, null],
  // A reftable repository's placeholder: its refs are elsewhere.
  ['ref: refs/heads/.invalid\n', undefined],
  ['ref: refs/remotes/origin/main\n', undefined],
  ['garbage', undefined]
])('HEAD %j names %j', (text, branch) => {
  expect(branchOfHeadFile(text)).toBe(branch)
})

describe('a folder’s Git common directory from its .git (the folder-access check)', () => {
  it('names what Git names for a main checkout, a folder inside it and a linked worktree; null outside any repository', async () => {
    const main = repository()
    const inner = join(main, 'src')
    mkdirSync(inner)
    const worktree = join(root, 'wt')
    git(main, 'worktree', 'add', '-q', '-b', 'mousse/thread-1', worktree)
    for (const folder of [main, inner, worktree]) {
      const fromGit = git(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      expect(await commonDirFromFiles(folder), folder).toBe(join(fromGit))
    }
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await commonDirFromFiles(plain)).toBeNull()
  })

  it('leaves to Git a .git that is a link, a .git file it cannot read, and a folder inside a Git folder', async () => {
    const main = repository()
    const linked = join(root, 'linked')
    mkdirSync(linked)
    symlinkSync(join(main, '.git'), join(linked, '.git'), 'junction')
    const odd = join(root, 'odd')
    mkdirSync(odd)
    writeFileSync(join(odd, '.git'), 'not a gitdir line')
    for (const folder of [linked, odd, join(main, '.git', 'refs')]) expect(await commonDirFromFiles(folder), folder).toBeUndefined()
  })
})
