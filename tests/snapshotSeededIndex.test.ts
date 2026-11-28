/**
 * A folder's first snapshot starts its private index from the folder's own index (`seededIndex` in `snapshots.ts`), so
 * Git reads only the files that changed since it last looked at them, instead of every file. What a snapshot records
 * must not change: each row takes the folder's first snapshot with seeding off (every file read) and on, and the trees
 * must be the same.
 *
 * The folder's own index, one row each: a fresh worktree; a staged change and a staged new file; assume-unchanged on a
 * changed file (Git's `add -A` skips such a file); skip-worktree and intent-to-add (index version 3); a merge stopped on
 * a conflict (unmerged entries); index version 4; a split index; an untracked cache; a file changed in the same moment
 * as the index was written (racily clean). Then line endings: Git converting (`core.autocrlf=true`), and a checkout made
 * while Git converted, with the setting turned off since (the index's entries hold LF blobs for CRLF files).
 * Each row runs with its own empty system and global config.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedSnapshotIndexes, takeSnapshotAsync, type Snapshot } from '../src/mms/actions/snapshots'

const roots: string[] = []
const scopes = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL }
afterEach(() => {
  seedSnapshotIndexes(true)
  for (const [key, value] of [['GIT_CONFIG_SYSTEM', scopes.system], ['GIT_CONFIG_GLOBAL', scopes.global]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const blob = (cwd: string, revision: string, path: string): string => execFileSync('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd }).toString()
const MINUTE_AGO = () => new Date(Date.now() - 60_000)

/** A repository with two committed files, `a.txt` and `b.txt`, under its own empty system and global config. */
function repository(): { base: string; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'mousse-seeded-')); roots.push(base)
  process.env.GIT_CONFIG_SYSTEM = join(base, 'system.gitconfig'); writeFileSync(process.env.GIT_CONFIG_SYSTEM, '')
  process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig'); writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
  const repo = join(base, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test')
  writeFileSync(join(repo, 'a.txt'), 'alpha\n'); writeFileSync(join(repo, 'b.txt'), 'bravo\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  return { base, repo }
}

/** The folder's first snapshot, with its private files removed first, with seeding off or on. */
async function firstSnapshot(cwd: string, seed: boolean): Promise<Snapshot> {
  rmSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'mousse')), { recursive: true, force: true })
  seedSnapshotIndexes(seed)
  try { return await takeSnapshotAsync(cwd, { reason: seed ? 'seeded' : 'read' }) } finally { seedSnapshotIndexes(true) }
}

const indexDigest = (cwd: string): string => createHash('sha1').update(readFileSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'index')))).digest('hex')
/** The names in the folder's Git directory, but Mousse's own folder. */
const gitDirectory = (cwd: string): string[] => readdirSync(resolve(cwd, git(cwd, 'rev-parse', '--git-dir'))).filter((name) => name !== 'mousse').sort()

/** Each row prepares the folder whose first snapshot is taken, and names the file whose change the snapshot must hold. */
const ROWS: Array<[string, (repo: string, base: string) => { cwd: string; path?: string; content?: string }]> = [
  ['a fresh worktree', (repo, base) => {
    const cwd = join(base, 'worktree'); git(repo, 'worktree', 'add', '-q', '-b', 'thread', cwd)
    return { cwd }
  }],
  ['a staged change and a staged new file', (repo) => {
    writeFileSync(join(repo, 'a.txt'), 'alpha staged\n'); writeFileSync(join(repo, 'new.txt'), 'new\n'); git(repo, 'add', 'a.txt', 'new.txt')
    return { cwd: repo, path: 'new.txt', content: 'new\n' }
  }],
  ['assume-unchanged on a changed file', (repo) => {
    git(repo, 'update-index', '--assume-unchanged', 'a.txt'); writeFileSync(join(repo, 'a.txt'), 'alpha changed after\n')
    return { cwd: repo, path: 'a.txt', content: 'alpha changed after\n' }
  }],
  ['skip-worktree on a changed file', (repo) => {
    git(repo, 'update-index', '--skip-worktree', 'a.txt'); writeFileSync(join(repo, 'a.txt'), 'alpha changed after\n')
    return { cwd: repo, path: 'a.txt', content: 'alpha changed after\n' }
  }],
  ['an intent-to-add file', (repo) => {
    writeFileSync(join(repo, 'later.txt'), 'later\n'); git(repo, 'add', '-N', 'later.txt')
    return { cwd: repo, path: 'later.txt', content: 'later\n' }
  }],
  ['a merge stopped on a conflict', (repo) => {
    git(repo, 'switch', '-q', '-c', 'other'); writeFileSync(join(repo, 'a.txt'), 'other side\n'); git(repo, 'commit', '-qam', 'other')
    git(repo, 'switch', '-q', 'main'); writeFileSync(join(repo, 'a.txt'), 'main side\n'); git(repo, 'commit', '-qam', 'main')
    try { git(repo, 'merge', '-q', 'other') } catch { /* stops on the conflict */ }
    return { cwd: repo }
  }],
  ['index version 4', (repo) => {
    git(repo, 'update-index', '--index-version', '4'); writeFileSync(join(repo, 'b.txt'), 'bravo changed\n')
    return { cwd: repo, path: 'b.txt', content: 'bravo changed\n' }
  }],
  ['a split index', (repo) => {
    git(repo, 'update-index', '--split-index'); writeFileSync(join(repo, 'c.txt'), 'charlie\n')
    return { cwd: repo, path: 'c.txt', content: 'charlie\n' }
  }],
  ['an untracked cache', (repo) => {
    git(repo, 'update-index', '--force-untracked-cache'); git(repo, 'status', '--porcelain'); writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
    return { cwd: repo, path: 'untracked.txt', content: 'untracked\n' }
  }],
  ['a file changed in the same moment as the index was written', (repo) => {
    // Racily clean: the entry's time, the file's and the index's are one. Git must read the file again.
    const index = resolve(repo, git(repo, 'rev-parse', '--git-path', 'index'))
    const at = MINUTE_AGO()
    utimesSync(join(repo, 'a.txt'), at, at); git(repo, 'update-index', '--refresh'); utimesSync(index, at, at)
    writeFileSync(join(repo, 'a.txt'), 'ALPHA\n'); utimesSync(join(repo, 'a.txt'), at, at)
    return { cwd: repo, path: 'a.txt', content: 'ALPHA\n' }
  }],
  ['Git converting line endings (autocrlf=true)', (repo) => {
    git(repo, 'config', 'core.autocrlf', 'true'); writeFileSync(join(repo, 'b.txt'), 'bravo\r\nchanged\r\n')
    return { cwd: repo }
  }],
  ['a checkout made under autocrlf=true, with the setting turned off since', (repo, base) => {
    git(repo, 'config', 'core.autocrlf', 'true')
    const cwd = join(base, 'crlf'); git(repo, 'worktree', 'add', '-q', '-b', 'crlf', cwd)
    // Checked out a while ago, so Git trusts the entries' stat data.
    const at = MINUTE_AGO()
    for (const file of ['a.txt', 'b.txt']) utimesSync(join(cwd, file), at, at)
    git(cwd, 'update-index', '--refresh')
    git(repo, 'config', 'core.autocrlf', 'false')
    // Git's own index takes the CRLF files as its LF blobs, as it did when it wrote them.
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('alpha\r\n')
    return { cwd, path: 'a.txt', content: 'alpha\r\n' }
  }]
]

describe('a folder\'s first snapshot starts from its own index', { timeout: 60_000 }, () => {
  it.each(ROWS)('%s: the same trees as reading every file', async (_name, prepare) => {
    const { base, repo } = repository()
    const { cwd, path, content } = prepare(repo, base)
    const read = await firstSnapshot(cwd, false)
    const before = { index: indexDigest(cwd), names: gitDirectory(cwd) }
    const seeded = await firstSnapshot(cwd, true)
    expect(seeded.tree).toBe(read.tree)
    expect(seeded.exactTree).toBe(read.exactTree)
    if (path) expect(blob(cwd, seeded.exactTree ?? seeded.tree, path)).toBe(content)
    // The folder's own index is only read, and nothing is added next to it (a split index's shared index).
    expect(indexDigest(cwd)).toBe(before.index)
    expect(gitDirectory(cwd)).toEqual(before.names)
  })

  it('reads only the files Git would read: a change that keeps a file\'s size and time is not read, as Git\'s own status does not see it', async () => {
    const { repo } = repository()
    const at = MINUTE_AGO()
    utimesSync(join(repo, 'a.txt'), at, at); git(repo, 'update-index', '--refresh')
    writeFileSync(join(repo, 'a.txt'), 'ALPHA\n'); utimesSync(join(repo, 'a.txt'), at, at)
    expect(statSync(join(repo, 'a.txt')).size).toBe('alpha\n'.length)
    expect(git(repo, 'status', '--porcelain')).toBe('')
    // Seeded, Git takes the file as its index has it; reading every file, the snapshot has the new bytes.
    expect(blob(repo, (await firstSnapshot(repo, true)).tree, 'a.txt')).toBe('alpha\n')
    expect(blob(repo, (await firstSnapshot(repo, false)).tree, 'a.txt')).toBe('ALPHA\n')
  })
})
