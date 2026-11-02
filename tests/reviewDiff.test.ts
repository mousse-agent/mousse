import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_TREE_SHA, REVIEW_MAX_FILE_BYTES, type ReviewRange } from '../src/shared/review'
import {
  countLinesBounded,
  emptyTreeSha,
  listChangedFiles,
  parseNameStatusZ,
  parseNumstatZ,
  readFileVersions,
  worktreeRange
} from '../src/mms/git/reviewDiff'

/** Lets one test make `lstat` report an earlier, smaller stat for a path, as if the file grew afterwards. */
const staleStat = vi.hoisted(() => ({ path: '', stat: undefined as unknown }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (path: string, ...rest: unknown[]) => {
      const real = await (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
      return staleStat.path && String(path) === staleStat.path ? staleStat.stat : real
    }
  }
})

const roots: string[] = []
const git =(cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function temp(prefix = 'mousse-review-diff-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir)
  return dir
}

function configure(cwd: string): void {
  git(cwd, 'config', 'user.name', 'Review fixture'); git(cwd, 'config', 'user.email', 'review-fixture@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  git(cwd, 'config', 'core.autocrlf', 'false')
}

/** A repository with no commit. */
function unborn(...initArgs: string[]): string {
  const cwd = temp()
  git(cwd, 'init', '-q', '-b', 'main', ...initArgs); configure(cwd)
  return cwd
}

/** A repository with one commit holding `base.txt`. */
function repo(): string {
  const cwd = unborn()
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'baseline')
  return cwd
}

const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD')
const commitAll = (cwd: string, message = 'change'): string => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message); return head(cwd) }
const commits = (from: string, to: string): ReviewRange => ({ from: { kind: 'commit', sha: from }, to: { kind: 'commit', sha: to } })
const toWorktree = (from: string): ReviewRange => ({ from: { kind: 'commit', sha: from }, to: { kind: 'worktree' } })
const text = (side: unknown): string => (side as { content: string }).content
/** File links need a privilege on Windows; junctions do not. Each skip is reported, not silently passed. */
function canLink(type: 'file' | 'junction'): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-review-probe-'))
  try {
    writeFileSync(join(dir, 'target.txt'), 'x')
    symlinkSync(type === 'file' ? join(dir, 'target.txt') : dir, join(dir, 'link'), type)
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const FILE_LINKS = canLink('file')
const JUNCTIONS = canLink('junction')

afterEach(() => { staleStat.path = ''; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('parsers', () => {
  it('parseNameStatusZ reads plain entries and renames with both paths', () => {
    expect(parseNameStatusZ('M\0a b.txt\0A\0new.txt\0D\0gone.txt\0R087\0old.txt\0new name.txt\0T\0link\0')).toEqual([
      { path: 'a b.txt', status: 'modified' },
      { path: 'new.txt', status: 'added' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'new name.txt', oldPath: 'old.txt', status: 'renamed' },
      { path: 'link', status: 'typechange' }
    ])
    expect(parseNameStatusZ('')).toEqual([])
  })

  it('parseNumstatZ reads counts, binary entries and renames', () => {
    expect(parseNumstatZ('3\t1\ta.txt\0-\t-\timage.png\x000\t0\t\0old.txt\0new.txt\0')).toEqual([
      { path: 'a.txt', additions: 3, deletions: 1, binary: false },
      { path: 'image.png', additions: 0, deletions: 0, binary: true },
      { path: 'new.txt', oldPath: 'old.txt', additions: 0, deletions: 0, binary: false }
    ])
  })

  it('parses a path that contains a newline or a tab', () => {
    expect(parseNameStatusZ('M\0odd\nname\tx.txt\0')).toEqual([{ path: 'odd\nname\tx.txt', status: 'modified' }])
    expect(parseNumstatZ('1\t0\todd\nname\tx.txt\0')).toEqual([{ path: 'odd\nname\tx.txt', additions: 1, deletions: 0, binary: false }])
  })
})

describe('listChangedFiles against the working tree, without refreshing the index', () => {
  /** A committed repository whose files then get new times only. */
  function touched() {
    const cwd = unborn()
    writeFileSync(join(cwd, 'same.txt'), 'same\n')
    writeFileSync(join(cwd, 'edited.txt'), 'before\n')
    writeFileSync(join(cwd, 'script.sh'), 'echo hi\n')
    writeFileSync(join(cwd, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(cwd, 'changed.bin'), Buffer.from([0, 1, 2, 3]))
    symlinkSync('same.txt', join(cwd, 'link'))
    git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'base')
    const old = new Date('2020-01-01')
    for (const name of ['same.txt', 'edited.txt', 'script.sh', 'blob.bin', 'changed.bin']) utimesSync(join(cwd, name), old, old)
    lutimesSync(join(cwd, 'link'), old, old)
    return cwd
  }

  it('leaves out files whose stat data alone changed, and keeps real content, mode and binary changes', async () => {
    const cwd = touched()
    writeFileSync(join(cwd, 'edited.txt'), 'after\n')
    chmodSync(join(cwd, 'script.sh'), 0o755)
    writeFileSync(join(cwd, 'changed.bin'), Buffer.from([0, 9, 9, 9]))
    // Git itself still reports every touched path, since the index is not refreshed.
    expect(git(cwd, '-c', 'diff.autoRefreshIndex=false', 'diff', '--name-only').split('\n')).toEqual(expect.arrayContaining(['same.txt', 'blob.bin', 'link']))
    const index = readFileSync(join(cwd, '.git', 'index'))
    const listed = await listChangedFiles(cwd, await worktreeRange(cwd, false))
    expect(listed.files.map((file) => [file.path, file.status])).toEqual([['changed.bin', 'modified'], ['edited.txt', 'modified'], ['script.sh', 'modified']])
    expect(listed.files.find((file) => file.path === 'edited.txt')).toMatchObject({ additions: 1, deletions: 1 })
    expect(listed.files.find((file) => file.path === 'changed.bin')).toMatchObject({ binary: true })
    // Reading it changed nothing.
    expect(readFileSync(join(cwd, '.git', 'index')).equals(index)).toBe(true)
  })

  it('lists nothing for a working tree that was only touched, against the index or against HEAD', async () => {
    const cwd = touched()
    expect((await listChangedFiles(cwd, await worktreeRange(cwd, false))).files).toEqual([])
    const head = git(cwd, 'rev-parse', 'HEAD')
    expect((await listChangedFiles(cwd, { from: { kind: 'commit', sha: head }, to: { kind: 'worktree' } })).files).toEqual([])
  })
})

describe('listChangedFiles between commits', () => {
  it('lists modified, added, deleted and renamed files with counts; a rename with edits keeps both paths', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'keep.txt'), '1\n2\n3\n'); writeFileSync(join(cwd, 'doomed.txt'), 'bye\n')
    writeFileSync(join(cwd, 'before.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const start = commitAll(cwd, 'start')
    writeFileSync(join(cwd, 'keep.txt'), '1\n2\n3\n4\n5\n'); rmSync(join(cwd, 'doomed.txt')); writeFileSync(join(cwd, 'added.txt'), 'a\nb\n')
    rmSync(join(cwd, 'before.txt'))
    writeFileSync(join(cwd, 'after.txt'), Array.from({ length: 20 }, (_, i) => (i === 3 ? 'edited line' : `line ${i}`)).join('\n') + '\n')
    const end = commitAll(cwd, 'end')

    const { files, truncated, mergeCommits } = await listChangedFiles(cwd, commits(start, end))
    expect(truncated).toBe(false); expect(mergeCommits).toBe(0)
    expect(files).toEqual([
      { path: 'added.txt', status: 'added', additions: 2, deletions: 0, binary: false, countsExact: true },
      { path: 'after.txt', oldPath: 'before.txt', status: 'renamed', additions: 1, deletions: 1, binary: false, countsExact: true },
      { path: 'doomed.txt', status: 'deleted', additions: 0, deletions: 1, binary: false, countsExact: true },
      { path: 'keep.txt', status: 'modified', additions: 2, deletions: 0, binary: false, countsExact: true }
    ])
  })

  it('parses paths with a space, a double quote and non-ASCII characters through -z', async () => {
    const cwd = repo(); const start = head(cwd)
    const names = ['with space.txt', 'ünï-日本.txt', ...(process.platform === 'win32' ? [] : ['say "hi".txt'])]
    for (const name of names) writeFileSync(join(cwd, name), 'x\n')
    const end = commitAll(cwd)
    const { files } = await listChangedFiles(cwd, commits(start, end))
    expect(files.map((file) => file.path).sort()).toEqual([...names].sort())
    expect(files.every((file) => file.status === 'added' && file.additions === 1)).toBe(true)
  })

  it('flags a binary file from its numstat entry and returns a binary side', async () => {
    const cwd = repo(); const start = head(cwd)
    writeFileSync(join(cwd, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0]))
    const end = commitAll(cwd)
    const { files } = await listChangedFiles(cwd, commits(start, end))
    expect(files).toEqual([{ path: 'image.bin', status: 'added', additions: 0, deletions: 0, binary: true, countsExact: true }])
    const result = await readFileVersions(cwd, commits(start, end), 'image.bin')
    expect(result.original).toBeNull()
    expect(result.modified).toEqual({ binary: true, size: 9 })
  })

  it('shows a 1.5 MB file of about 50,000 lines as too large with its size', async () => {
    const cwd = repo(); const start = head(cwd)
    writeFileSync(join(cwd, 'big.txt'), `${'a'.repeat(30)}\n`.repeat(50_000))
    const end = commitAll(cwd)
    const result = await readFileVersions(cwd, commits(start, end), 'big.txt')
    expect(result.modified).toEqual({ tooLarge: true, size: 31 * 50_000, reason: 'bytes' })
    const { files } = await listChangedFiles(cwd, commits(start, end))
    expect(files[0]).toMatchObject({ path: 'big.txt', additions: 50_000 })
  })

  it('uses the line cap for many short lines and the byte cap for long ones', async () => {
    const cwd = repo(); const start = head(cwd)
    const shortLines = 'x\n'.repeat(200_000)
    expect(shortLines.length).toBeLessThan(REVIEW_MAX_FILE_BYTES)
    writeFileSync(join(cwd, 'short-lines.txt'), shortLines)
    writeFileSync(join(cwd, 'long-lines.txt'), `${'y'.repeat(1000)}\n`.repeat(1500))
    const end = commitAll(cwd)
    const range = commits(start, end)
    expect((await readFileVersions(cwd, range, 'short-lines.txt')).modified).toEqual({ tooLarge: true, size: 400_000, lines: 200_000, reason: 'lines' })
    expect((await readFileVersions(cwd, range, 'long-lines.txt')).modified).toEqual({ tooLarge: true, size: 1_501_500, reason: 'bytes' })
  })

  it('lists trailing-whitespace-only and internal-spacing-only changes with real counts and keeps the whitespace', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'trailing.txt'), 'one\ntwo\n'); writeFileSync(join(cwd, 'spacing.txt'), 'a b\n')
    const start = commitAll(cwd, 'start')
    writeFileSync(join(cwd, 'trailing.txt'), 'one  \ntwo\t\n'); writeFileSync(join(cwd, 'spacing.txt'), 'a    b\n')
    const end = commitAll(cwd, 'end')
    const range = commits(start, end)
    const { files } = await listChangedFiles(cwd, range)
    expect(files).toEqual([
      { path: 'spacing.txt', status: 'modified', additions: 1, deletions: 1, binary: false, countsExact: true },
      { path: 'trailing.txt', status: 'modified', additions: 2, deletions: 2, binary: false, countsExact: true }
    ])
    const trailing = await readFileVersions(cwd, range, 'trailing.txt')
    expect(text(trailing.original)).toBe('one\ntwo\n')
    expect(text(trailing.modified)).toBe('one  \ntwo\t\n')
    expect(text((await readFileVersions(cwd, range, 'spacing.txt')).modified)).toBe('a    b\n')
  })

  it('returns an empty list for equal commits without running Git, and lists uncommitted edits against HEAD', async () => {
    const cwd = repo(); const sha = head(cwd)
    // A directory that is not a repository proves Git never ran for the equal-commit range.
    expect(await listChangedFiles(temp(), commits(sha, sha))).toEqual({ files: [], truncated: false, mergeCommits: 0 })
    writeFileSync(join(cwd, 'base.txt'), 'edited\n')
    const { files } = await listChangedFiles(cwd, toWorktree(sha))
    expect(files).toEqual([{ path: 'base.txt', status: 'modified', additions: 1, deletions: 1, binary: false, countsExact: true }])
  })

  it('cuts the list at the file cap and reports it', async () => {
    const cwd = repo(); const start = head(cwd)
    for (const name of ['c.txt', 'a.txt', 'd.txt', 'b.txt']) writeFileSync(join(cwd, name), 'x\n')
    const end = commitAll(cwd)
    const { files, truncated } = await listChangedFiles(cwd, commits(start, end), { maxFiles: 3 })
    expect(files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(truncated).toBe(true)
  })

  it('reports one merge commit and lists the pulled files when the agent ran git pull', async () => {
    const remote = temp(); git(remote, 'init', '-q', '--bare', '-b', 'main')
    const cwd = temp(); git(cwd, 'clone', '-q', remote, '.'); configure(cwd); git(cwd, 'checkout', '-q', '-B', 'main')
    writeFileSync(join(cwd, 'base.txt'), 'base\n'); commitAll(cwd, 'baseline'); git(cwd, 'push', '-q', '-u', 'origin', 'main')
    const other = temp(); git(other, 'clone', '-q', remote, '.'); configure(other)
    writeFileSync(join(other, 'pulled.txt'), 'from elsewhere\n'); commitAll(other, 'upstream'); git(other, 'push', '-q', 'origin', 'main')

    const start = head(cwd)
    writeFileSync(join(cwd, 'mine.txt'), 'mine\n'); commitAll(cwd, 'local work')
    git(cwd, 'pull', '-q', '--no-rebase', '--no-edit')
    const end = head(cwd)
    const { files, mergeCommits } = await listChangedFiles(cwd, commits(start, end))
    expect(mergeCommits).toBe(1)
    expect(files.map((file) => file.path)).toEqual(['mine.txt', 'pulled.txt'])
  })
})

describe('listChangedFiles in the working tree', () => {
  it('lists untracked files, excludes .mousse, and skips counting a large untracked file', async () => {
    const cwd = repo(); const sha = head(cwd)
    mkdirSync(join(cwd, '.mousse')); writeFileSync(join(cwd, '.mousse', 'state.json'), '{}\n')
    writeFileSync(join(cwd, 'notes.txt'), 'a\nb\nc')
    writeFileSync(join(cwd, 'huge.log'), Buffer.alloc(5 * 1024 * 1024, 0x61))
    writeFileSync(join(cwd, 'blob.bin'), Buffer.from([1, 0, 2]))
    const { files } = await listChangedFiles(cwd, toWorktree(sha))
    expect(files.map((file) => file.path)).toEqual(['blob.bin', 'huge.log', 'notes.txt'])
    expect(files.find((file) => file.path === 'notes.txt')).toEqual({ path: 'notes.txt', status: 'untracked', additions: 3, deletions: 0, binary: false, countsExact: true })
    expect(files.find((file) => file.path === 'huge.log')).toMatchObject({ status: 'untracked', additions: 0, countsExact: false })
    expect(files.find((file) => file.path === 'blob.bin')).toMatchObject({ binary: true, countsExact: false })
  })

  it('excludes .mousse from tracked changes too', async () => {
    const cwd = repo(); const start = head(cwd)
    mkdirSync(join(cwd, '.mousse')); writeFileSync(join(cwd, '.mousse', 'state.json'), '{}\n'); writeFileSync(join(cwd, 'real.txt'), 'x\n')
    const end = commitAll(cwd)
    expect((await listChangedFiles(cwd, commits(start, end))).files.map((file) => file.path)).toEqual(['real.txt'])
  })

  it('countLinesBounded stops reading at the cap', async () => {
    const cwd = temp(); const file = join(cwd, 'big.txt')
    writeFileSync(file, 'line\n'.repeat(100_000))
    const capped = await countLinesBounded(file, 1000)
    expect(capped.truncated).toBe(true)
    expect(capped.bytesRead).toBeLessThanOrEqual(1001)
    const whole = await countLinesBounded(file, 10_000_000)
    expect(whole).toMatchObject({ lines: 100_000, truncated: false, binary: false })
    writeFileSync(file, 'no newline'); expect((await countLinesBounded(file, 1000)).lines).toBe(1)
    writeFileSync(file, ''); expect((await countLinesBounded(file, 1000)).lines).toBe(0)
  })

  it.skipIf(!FILE_LINKS)('shows a symlink as its link text and lists a file turned into a link as typechange', async () => {
    const cwd = repo()
    const outside = temp(); writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
    writeFileSync(join(cwd, 'swap.txt'), 'plain\n'); const sha = commitAll(cwd, 'file')
    rmSync(join(cwd, 'swap.txt')); symlinkSync(join(outside, 'secret.txt'), join(cwd, 'swap.txt'))
    const { files } = await listChangedFiles(cwd, toWorktree(sha))
    expect(files.find((file) => file.path === 'swap.txt')?.status).toBe('typechange')
    const result = await readFileVersions(cwd, toWorktree(sha), 'swap.txt')
    expect(result.original).toMatchObject({ content: 'plain\n' })
    expect(result.modified).toMatchObject({ content: join(outside, 'secret.txt'), symlink: true })
  })

  it('marks a link stored in a commit or the index as a link, whatever the file system can do', async () => {
    const cwd = repo()
    // Store a mode 120000 entry directly, so the test does not depend on the platform creating links.
    const linkBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: 'target.txt', encoding: 'utf8' }).trim()
    git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},swap.txt`)
    git(cwd, 'commit', '-qm', 'link'); const start = head(cwd)
    writeFileSync(join(cwd, 'swap.txt'), 'plain\n'); git(cwd, 'update-index', '--add', 'swap.txt')
    const committed = await readFileVersions(cwd, commits(start, start), 'swap.txt')
    expect(committed.original).toMatchObject({ content: 'target.txt', symlink: true })
    const staged = await readFileVersions(cwd, await worktreeRange(cwd, true), 'swap.txt')
    expect(staged.original).toMatchObject({ content: 'target.txt', symlink: true })
    expect(staged.modified).toMatchObject({ content: 'plain\n' })
    expect(staged.modified).not.toHaveProperty('symlink')
    git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},swap.txt`)
    const viaIndex = await readFileVersions(cwd, { from: { kind: 'index' }, to: { kind: 'worktree' } }, 'swap.txt')
    expect(viaIndex.original).toMatchObject({ content: 'target.txt', symlink: true })
  })

  it.skipIf(!JUNCTIONS)('reports a file reached through a directory link that leaves the root as absent', async () => {
    const cwd = repo()
    const outside = temp(); writeFileSync(join(outside, 'secret.txt'), 'top secret\n')
    symlinkSync(outside, join(cwd, 'escape'), 'junction')
    const result = await readFileVersions(cwd, { from: { kind: 'index' }, to: { kind: 'worktree' } }, 'escape/secret.txt')
    expect(result.modified).toBeNull()
  })
})

describe('index and working tree sides', () => {
  it('compares HEAD to index when staged and index to working tree otherwise', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'f.txt'), 'committed\n'); commitAll(cwd)
    writeFileSync(join(cwd, 'f.txt'), 'staged\n'); git(cwd, 'add', 'f.txt')
    writeFileSync(join(cwd, 'f.txt'), 'unstaged\n')

    const stagedRange = await worktreeRange(cwd, true)
    const staged = await listChangedFiles(cwd, stagedRange)
    expect(staged.files).toEqual([{ path: 'f.txt', status: 'modified', additions: 1, deletions: 1, binary: false, countsExact: true }])
    const stagedFile = await readFileVersions(cwd, stagedRange, 'f.txt')
    expect([text(stagedFile.original), text(stagedFile.modified)]).toEqual(['committed\n', 'staged\n'])

    const unstagedRange = await worktreeRange(cwd, false)
    expect((await listChangedFiles(cwd, unstagedRange)).files).toHaveLength(1)
    const unstagedFile = await readFileVersions(cwd, unstagedRange, 'f.txt')
    expect([text(unstagedFile.original), text(unstagedFile.modified)]).toEqual(['staged\n', 'unstaged\n'])
  })

  it('lists staged and untracked files of an unborn repository against the empty tree', async () => {
    const cwd = unborn()
    writeFileSync(join(cwd, 'staged.txt'), 's\n'); git(cwd, 'add', 'staged.txt'); writeFileSync(join(cwd, 'loose.txt'), 'l\n')
    const stagedRange = await worktreeRange(cwd, true)
    expect(stagedRange.from).toBeNull()
    expect((await listChangedFiles(cwd, stagedRange)).files.map((file) => [file.path, file.status])).toEqual([['staged.txt', 'added']])
    const unstaged = await listChangedFiles(cwd, await worktreeRange(cwd, false))
    expect(unstaged.files.map((file) => [file.path, file.status])).toEqual([['loose.txt', 'untracked']])
    const thread = await listChangedFiles(cwd, { from: null, to: { kind: 'worktree' } })
    expect(thread.files.map((file) => [file.path, file.status])).toEqual([['loose.txt', 'untracked'], ['staged.txt', 'added']])
    expect(text((await readFileVersions(cwd, stagedRange, 'staged.txt')).modified)).toBe('s\n')
  })

  it('resolves the empty tree by constant on SHA-1 and by hashing on SHA-256', async () => {
    expect(await emptyTreeSha(unborn())).toBe(EMPTY_TREE_SHA)
    let sha256: string
    try { sha256 = unborn('--object-format=sha256') } catch { return }
    const expected = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: sha256, input: '', encoding: 'utf8' }).trim()
    const resolved = await emptyTreeSha(sha256)
    expect(resolved).toHaveLength(64)
    expect(resolved).toBe(expected)
    writeFileSync(join(sha256, 'a.txt'), 'a\n'); git(sha256, 'add', 'a.txt')
    expect((await listChangedFiles(sha256, await worktreeRange(sha256, true))).files.map((file) => file.path)).toEqual(['a.txt'])
  })

  it('reads a rename original at its old name', async () => {
    const cwd = repo()
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    writeFileSync(join(cwd, 'old.txt'), body); const start = commitAll(cwd, 'start')
    rmSync(join(cwd, 'old.txt')); writeFileSync(join(cwd, 'new.txt'), body.replace('line 4', 'changed')); const end = commitAll(cwd, 'rename')
    const range = commits(start, end)
    const entry = (await listChangedFiles(cwd, range)).files[0]
    expect(entry).toMatchObject({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed' })
    const result = await readFileVersions(cwd, range, entry.path, entry.oldPath)
    expect(text(result.original)).toBe(body)
    expect(text(result.modified)).toContain('changed')
    expect((await readFileVersions(cwd, range, entry.path)).original).toBeNull()
  })

  it('reads paths relative to a subdirectory root', async () => {
    const cwd = repo(); const start = head(cwd)
    mkdirSync(join(cwd, 'pkg')); writeFileSync(join(cwd, 'pkg', 'in.txt'), 'in\n'); writeFileSync(join(cwd, 'out.txt'), 'out\n')
    const end = commitAll(cwd)
    const root = join(cwd, 'pkg')
    expect((await listChangedFiles(root, commits(start, end))).files.map((file) => file.path)).toEqual(['in.txt'])
    expect(text((await readFileVersions(root, commits(start, end), 'in.txt')).modified)).toBe('in\n')
  })

  it('refuses a path that leaves the root', async () => {
    const cwd = repo()
    await expect(readFileVersions(cwd, await worktreeRange(cwd, false), '../x.txt')).rejects.toThrow()
  })
})

describe('reading sides safely', () => {
  it('bounds the working-tree read when the file grows after it was inspected', async () => {
    const cwd = repo()
    const file = join(cwd, 'grow.txt')
    writeFileSync(file, 'small\n')
    staleStat.stat = lstatSync(file); staleStat.path = file
    writeFileSync(file, 'x'.repeat(2_097_152))
    const result = await readFileVersions(cwd, { from: { kind: 'index' }, to: { kind: 'worktree' } }, 'grow.txt')
    expect(result.modified).toEqual({ tooLarge: true, size: 2_097_152, reason: 'bytes' })
  })

  it('treats a directory replaced by a file as absent on the original side, for commits and the index', async () => {
    const cwd = repo()
    mkdirSync(join(cwd, 'thing')); writeFileSync(join(cwd, 'thing', 'child.txt'), 'child\n')
    const start = commitAll(cwd, 'directory')
    rmSync(join(cwd, 'thing'), { recursive: true }); writeFileSync(join(cwd, 'thing'), 'now a file\n')
    const end = commitAll(cwd, 'file')
    const range = commits(start, end)
    expect((await listChangedFiles(cwd, range)).files.find((file) => file.path === 'thing')?.status).toBe('added')
    const result = await readFileVersions(cwd, range, 'thing')
    expect(result.original).toBeNull()
    expect(text(result.modified)).toBe('now a file\n')
    // The same file read as a directory path from the index side, after the swap is undone on disk only.
    rmSync(join(cwd, 'thing')); mkdirSync(join(cwd, 'thing')); writeFileSync(join(cwd, 'thing', 'child.txt'), 'child\n')
    expect((await readFileVersions(cwd, { from: { kind: 'commit', sha: start }, to: { kind: 'index' } }, 'thing')).modified).toMatchObject({ content: 'now a file\n' })
    expect((await readFileVersions(cwd, { from: { kind: 'index' }, to: { kind: 'worktree' } }, 'thing')).modified).toBeNull()
  })

  it('does not list a nested repository as an untracked file', async () => {
    const cwd = repo(); const sha = head(cwd)
    const nested = join(cwd, 'nested'); mkdirSync(nested); git(nested, 'init', '-q'); writeFileSync(join(nested, 'inner.txt'), 'x\n')
    writeFileSync(join(cwd, 'plain.txt'), 'p\n')
    expect((await listChangedFiles(cwd, toWorktree(sha))).files.map((file) => file.path)).toEqual(['plain.txt'])
  })

  it('surfaces a Git failure instead of showing the file as absent', async () => {
    const cwd = repo()
    await expect(readFileVersions(cwd, commits('a'.repeat(40), head(cwd)), 'base.txt')).rejects.toThrow()
  })

  it('returns the working-tree line endings as stored when core.autocrlf is on', async () => {
    const cwd = repo(); git(cwd, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(cwd, 'eol.txt'), 'a\r\nb\r\n'); const sha = commitAll(cwd, 'eol')
    expect(git(cwd, 'show', `${sha}:eol.txt`)).toBe('a\nb')
    // Git normalises on commit, so the list is empty while the two sides differ only in line endings.
    expect((await listChangedFiles(cwd, toWorktree(sha))).files).toEqual([])
    const result = await readFileVersions(cwd, toWorktree(sha), 'eol.txt')
    expect([text(result.original), text(result.modified)]).toEqual(['a\nb\n', 'a\r\nb\r\n'])
  })
})
