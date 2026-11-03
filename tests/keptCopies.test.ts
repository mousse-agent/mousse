import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_COPY_LIMITS, keepCopy, keptCopyNotice, projectKeptFilesOwner, registerProjectKeptFilesFolder, settleInterruptedKeeps } from '../src/mms/actions/keptCopies'
import { expirePreservedFiles, threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { UndoRetentionSweeper } from '../src/mms/actions/UndoRetentionSweeper'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import type { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { DEFAULT_UNDO_RETENTION_POLICY } from '../src/shared/undoRetention'

const USER = userAction('button', 'Discard changes')
const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitBytes = (cwd: string, ...args: string[]): Buffer => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
const blobSha = (value: Buffer | string): string => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex')
}
const indexDigest = (cwd: string): string => createHash('sha256').update(readFileSync(join(cwd, '.git', 'index'))).digest('hex')
const preservedRefs = (cwd: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/').split('\n').filter(Boolean)

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

function repo(): string {
  const cwd = temp('mousse-kept-')
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Kept copy test'); git(cwd, 'config', 'user.email', 'kept@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, '.gitignore'), 'ignored/\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  return cwd
}

/** Brings the working version of `path` back from the copy and reads it. */
function restoreWorking(cwd: string, ref: string, path: string): Buffer {
  git(cwd, 'restore', `--source=${ref}`, '--', path)
  return readFileSync(join(cwd, path))
}

/** Brings the staged version of `path` back from the copy and reads it from the index. */
function restoreStaged(cwd: string, ref: string, path: string): Buffer {
  git(cwd, 'restore', `--source=${ref}^2`, '--staged', '--', path)
  return gitBytes(cwd, 'show', `:${path}`)
}

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  // Any command Mousse runs here that the central Git check would not allow fails the test.
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  KEEP_COPY_LIMITS.bytes = 2 * 1024 ** 3
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Discard keeps a copy first', () => {
  it('keeps the bytes of an untracked file it deletes, owned by the journal it names (the audit reproduction, inverted)', async () => {
    const cwd = repo()
    const owner = temp('mousse-kept-owner-')
    const value = Buffer.from('unique discard bytes 08a5f864\n')
    writeFileSync(join(cwd, 'draft.txt'), value)
    const kept = await new GitService().discard(cwd, USER, ['draft.txt'], { owner })
    expect(existsSync(join(cwd, 'draft.txt'))).toBe(false)
    expect(kept?.ref).toMatch(/^refs\/mousse\/preserved\/[0-9a-f-]{36}-[0-9a-f]{12}$/)
    expect(preservedRefs(cwd)).toEqual([kept!.ref])
    expect(() => git(cwd, 'cat-file', '-e', blobSha(value))).not.toThrow()
    expect(threadPreservedIndex(owner).owns(kept!.ref)).toBe(true)
    expect(new ThreadJournal(owner).latestByOperation().get(kept!.operationId)).toMatchObject({ operationType: 'git-discard', state: 'completed' })
    expect(restoreWorking(cwd, kept!.ref, 'draft.txt').equals(value)).toBe(true)
  })

  it('brings back an untracked binary file byte for byte, and an executable edit with its mode', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'tool.sh'), '#!/bin/sh\necho one\n'); chmodSync(join(cwd, 'tool.sh'), 0o755)
    git(cwd, 'add', 'tool.sh'); git(cwd, 'commit', '-qm', 'tool')
    const binary = Buffer.concat([randomBytes(64 * 1024), Buffer.from([0, 0, 255, 0])])
    mkdirSync(join(cwd, 'assets')); writeFileSync(join(cwd, 'assets', 'blob.bin'), binary)
    writeFileSync(join(cwd, 'tool.sh'), '#!/bin/sh\necho two\n')
    const kept = await new GitService().discard(cwd, USER, ['assets/blob.bin', 'tool.sh'], { owner: temp('mousse-kept-owner-') })
    expect(existsSync(join(cwd, 'assets', 'blob.bin'))).toBe(false)
    expect(readFileSync(join(cwd, 'tool.sh'), 'utf8')).toBe('#!/bin/sh\necho one\n')
    expect(git(cwd, 'ls-tree', kept!.ref, '--', 'tool.sh')).toMatch(/^100755 blob /)
    expect(restoreWorking(cwd, kept!.ref, 'assets/blob.bin').equals(binary)).toBe(true)
    expect(restoreWorking(cwd, kept!.ref, 'tool.sh').toString()).toBe('#!/bin/sh\necho two\n')
    expect(statSync(join(cwd, 'tool.sh')).mode & 0o111).not.toBe(0)
  })

  it('keeps an edit Git can tell only by its content: same size, and the time its index entry records', async () => {
    const cwd = repo()
    // Without the change time, an edit within the second its entry was written looks the same to Git by size and time.
    git(cwd, 'config', 'core.trustctime', 'false')
    const recorded = statSync(join(cwd, 'base.txt'))
    writeFileSync(join(cwd, 'base.txt'), 'BASE\n')
    // The file and the index both carry the entry's time, so only a racy-clean check reads the file again.
    utimesSync(join(cwd, 'base.txt'), recorded.atime, recorded.mtime)
    utimesSync(join(cwd, '.git', 'index'), recorded.atime, recorded.mtime)
    // Read without writing the index: a write would mark the entry changed and hide what is tested here.
    expect(git(cwd, '--no-optional-locks', 'status', '--porcelain')).toBe('M base.txt')
    const kept = (await new GitService().discard(cwd, USER, ['base.txt'], { owner: temp('mousse-kept-owner-') }))!
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(restoreWorking(cwd, kept.ref, 'base.txt').toString()).toBe('BASE\n')
  })

  it('brings back a staged-only addition from its staged version', async () => {
    const cwd = repo()
    const staged = Buffer.from('only ever staged\n')
    writeFileSync(join(cwd, 'added.txt'), staged); git(cwd, 'add', 'added.txt')
    // The file on disk then goes, so the staged version is the only one there is.
    rmSync(join(cwd, 'added.txt'))
    const kept = await new GitService().discard(cwd, USER, ['added.txt'], { owner: temp('mousse-kept-owner-') })
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(restoreStaged(cwd, kept!.ref, 'added.txt').equals(staged)).toBe(true)
  })

  it('brings back both versions of a file staged and then edited again', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'staged version\n'); git(cwd, 'add', 'base.txt')
    writeFileSync(join(cwd, 'base.txt'), 'working version\n')
    const kept = await new GitService().discard(cwd, USER, ['base.txt'], { owner: temp('mousse-kept-owner-') })
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(restoreStaged(cwd, kept!.ref, 'base.txt').toString()).toBe('staged version\n')
    expect(restoreWorking(cwd, kept!.ref, 'base.txt').toString()).toBe('working version\n')
  })

  it('brings back a staged rename, edited after the rename', async () => {
    const cwd = repo()
    const text = 'a file to rename\nwith enough lines\nto be seen as one\n'
    writeFileSync(join(cwd, 'old.txt'), text); git(cwd, 'add', 'old.txt'); git(cwd, 'commit', '-qm', 'old')
    git(cwd, 'mv', 'old.txt', 'new.txt')
    writeFileSync(join(cwd, 'new.txt'), `${text}and an edit\n`)
    const kept = await new GitService().discard(cwd, USER, ['new.txt'], { owner: temp('mousse-kept-owner-') })
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    expect(readFileSync(join(cwd, 'old.txt'), 'utf8')).toBe(text)
    // The staged versions are the index as it was: the new name in, the old name out.
    expect(git(cwd, 'ls-tree', '--name-only', `${kept!.ref}^2`).split('\n')).toEqual(expect.arrayContaining(['new.txt']))
    expect(git(cwd, 'ls-tree', '--name-only', `${kept!.ref}^2`).split('\n')).not.toContain('old.txt')
    expect(restoreStaged(cwd, kept!.ref, 'new.txt').toString()).toBe(text)
    expect(restoreWorking(cwd, kept!.ref, 'new.txt').toString()).toBe(`${text}and an edit\n`)
  })

  it('brings back a conflict: its three stages and the file with its markers', async () => {
    const cwd = repo()
    git(cwd, 'switch', '-q', '-c', 'side'); writeFileSync(join(cwd, 'base.txt'), 'theirs\n'); git(cwd, 'commit', '-qam', 'theirs')
    git(cwd, 'switch', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'ours\n'); git(cwd, 'commit', '-qam', 'ours')
    expect(() => git(cwd, 'merge', 'side')).toThrow()
    const stages = git(cwd, 'ls-files', '-u', '--', 'base.txt')
    const marked = readFileSync(join(cwd, 'base.txt'))
    expect(stages.split('\n')).toHaveLength(3)
    const kept = await new GitService().discard(cwd, USER, ['base.txt'], { owner: temp('mousse-kept-owner-') })
    expect(git(cwd, 'ls-files', '-u')).toBe('')
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('ours\n')
    // The stages go back into the index, as Git had them.
    const lines = git(cwd, 'ls-tree', '-r', `${kept!.ref}^3`).split('\n').map((line) => {
      const [meta, path] = line.split('\t') as [string, string]
      const [mode, , sha] = meta.split(' ')
      const [, stage, name] = /^stage-(\d)\/(.*)$/.exec(path)!
      return `${mode} ${sha} ${stage}\t${name}`
    })
    execFileSync('git', ['update-index', '--index-info'], { cwd, input: `0 ${'0'.repeat(40)}\tbase.txt\n${lines.join('\n')}\n` })
    expect(git(cwd, 'ls-files', '-u', '--', 'base.txt')).toBe(stages)
    expect(restoreWorking(cwd, kept!.ref, 'base.txt').equals(marked)).toBe(true)
  })

  it('keeps a copy in a repository with no commit yet', async () => {
    const cwd = temp('mousse-kept-unborn-')
    git(cwd, 'init', '-q', '-b', 'main')
    writeFileSync(join(cwd, 'first.txt'), 'staged first\n'); git(cwd, 'add', 'first.txt'); writeFileSync(join(cwd, 'first.txt'), 'edited first\n')
    const kept = (await new GitService().discard(cwd, USER, ['first.txt'], { owner: temp('mousse-kept-owner-') }))!
    expect(existsSync(join(cwd, 'first.txt'))).toBe(false)
    expect(git(cwd, 'ls-tree', `${kept.ref}^1`)).toBe('')
    expect(restoreStaged(cwd, kept.ref, 'first.txt').toString()).toBe('staged first\n')
    expect(restoreWorking(cwd, kept.ref, 'first.txt').toString()).toBe('edited first\n')
  })

  it('refuses a discard over the byte cap, naming the largest files, and changes nothing', async () => {
    const cwd = repo()
    const owner = temp('mousse-kept-owner-')
    KEEP_COPY_LIMITS.bytes = 1000
    writeFileSync(join(cwd, 'big.bin'), randomBytes(4000)); writeFileSync(join(cwd, 'small.txt'), 'small\n')
    writeFileSync(join(cwd, 'base.txt'), 'edited\n')
    const before = { status: git(cwd, 'status', '--porcelain', '-uall'), index: indexDigest(cwd), big: readFileSync(join(cwd, 'big.bin')) }
    const refusal = await new GitService().discard(cwd, USER, ['big.bin', 'small.txt', 'base.txt'], { owner }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'keep_copy_too_large', message: expect.stringContaining('big.bin (3.9 KB)') })
    expect((refusal as Error).message).toContain('Nothing was changed')
    expect(git(cwd, 'status', '--porcelain', '-uall')).toBe(before.status)
    expect(indexDigest(cwd)).toBe(before.index)
    expect(readFileSync(join(cwd, 'big.bin')).equals(before.big)).toBe(true)
    expect(preservedRefs(cwd)).toEqual([])
    expect(new ThreadJournal(owner).list()).toEqual([])
  })
})

describe('keepCopy', () => {
  it('never changes the real index, HEAD or branches while it keeps a copy', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'staged\n'); git(cwd, 'add', 'base.txt'); writeFileSync(join(cwd, 'base.txt'), 'working\n')
    writeFileSync(join(cwd, 'loose.txt'), 'loose\n')
    const before = { index: indexDigest(cwd), head: git(cwd, 'rev-parse', 'HEAD'), branches: git(cwd, 'for-each-ref', 'refs/heads/'), status: git(cwd, 'status', '--porcelain', '-uall') }
    const kept = await keepCopy({ owner: temp('mousse-kept-owner-'), top: cwd, operationType: 'git-discard', action: 'Discard' })
    expect({ index: indexDigest(cwd), head: git(cwd, 'rev-parse', 'HEAD'), branches: git(cwd, 'for-each-ref', 'refs/heads/'), status: git(cwd, 'status', '--porcelain', '-uall') }).toEqual(before)
    // The whole working tree: both versions of the edit, and the untracked file.
    expect(git(cwd, 'show', `${kept.ref}:base.txt`)).toBe('working')
    expect(git(cwd, 'show', `${kept.ref}^2:base.txt`)).toBe('staged')
    expect(git(cwd, 'show', `${kept.ref}:loose.txt`)).toBe('loose')
    expect(git(cwd, 'rev-parse', `${kept.ref}^1`)).toBe(before.head)
    expect(keptCopyNotice(kept)).toBe(`A copy is kept for 30 days as ${kept.ref}. To bring a file back: git restore --source=${kept.ref} -- <path> (its staged version: --source=${kept.ref}^2 --staged).`)
  })

  it('keeps ignored files too when asked, for a cleanup that removes them', async () => {
    const cwd = repo()
    mkdirSync(join(cwd, 'ignored')); writeFileSync(join(cwd, 'ignored', '.env'), 'SECRET=1\n')
    const kept = await keepCopy({ owner: temp('mousse-kept-owner-'), top: cwd, operationType: 'worktree-cleanup', action: 'Cleanup', includeIgnored: true })
    rmSync(join(cwd, 'ignored'), { recursive: true })
    mkdirSync(join(cwd, 'ignored'))
    expect(restoreWorking(cwd, kept.ref, 'ignored/.env').toString()).toBe('SECRET=1\n')
  })

  it('settles a keep that stopped after its ref was written, and one that stopped before, recording what is there and replaying nothing', async () => {
    const cwd = repo()
    const owner = temp('mousse-kept-owner-')
    const journal = new ThreadJournal(owner)
    const commit = git(cwd, 'commit-tree', git(cwd, 'rev-parse', 'HEAD^{tree}'), '-m', 'a copy')
    const written = `refs/mousse/preserved/${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}-${commit.slice(0, 12)}`
    const missing = `refs/mousse/preserved/${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}-${commit.slice(0, 12)}`
    const operationOf = (ref: string) => ref.slice('refs/mousse/preserved/'.length, -13)
    for (const ref of [written, missing]) journal.append({ operationId: operationOf(ref), operationType: 'git-discard', state: 'prepared', details: { phase: 'intent', ref, sha: commit, top: cwd } })
    git(cwd, 'update-ref', written, commit)
    // An unsettled keep pauses nothing: it removed nothing yet.
    expect(new UndoRetentionService(owner).unfinishedOperation()).toBe(false)
    expect(await settleInterruptedKeeps(owner)).toEqual([written])
    const latest = new ThreadJournal(owner).latestByOperation()
    expect(latest.get(operationOf(written))).toMatchObject({ state: 'completed', details: { phase: 'outcome', ref: written, interrupted: true } })
    expect(latest.get(operationOf(missing))).toMatchObject({ state: 'failed', details: { phase: 'outcome', interrupted: true } })
    expect(preservedRefs(cwd)).toEqual([written])
    // Settled once: a second call records nothing more.
    const count = new ThreadJournal(owner).list().length
    expect(await settleInterruptedKeeps(owner)).toEqual([])
    expect(new ThreadJournal(owner).list()).toHaveLength(count)
    // Both stay the owner's, so the one that exists expires with the others.
    expect(threadPreservedIndex(owner).owns(written)).toBe(true)
  })
})

describe('kept copies expire', () => {
  /** Moves the owner's retention clock to `at` in steps the clock check accepts. */
  async function advance(owner: string, top: string, from: number, at: number): Promise<void> {
    for (let now = from; now < at; now = Math.min(at, now + 6 * DAY)) await new UndoRetentionService(owner, () => now).sweep(top)
    await new UndoRetentionService(owner, () => at).sweep(top)
  }

  it('removes a thread-owned copy after the Undo window and not before', async () => {
    const cwd = repo()
    const owner = temp('mousse-kept-thread-')
    const start = Date.now()
    await new UndoRetentionService(owner, () => start).sweep(cwd)
    writeFileSync(join(cwd, 'draft.txt'), 'draft\n')
    const kept = (await new GitService().discard(cwd, USER, ['draft.txt'], { owner }))!
    await advance(owner, cwd, start, start + DEFAULT_UNDO_RETENTION_POLICY.windowMs - 60 * 60 * 1000)
    expect((await expirePreservedFiles(owner, cwd, { now: () => start + DEFAULT_UNDO_RETENTION_POLICY.windowMs - 60 * 60 * 1000 })).expiredRefs).toEqual([])
    expect(restoreWorking(cwd, kept.ref, 'draft.txt').toString()).toBe('draft\n')
    const after = start + DEFAULT_UNDO_RETENTION_POLICY.windowMs + 60 * 60 * 1000
    await advance(owner, cwd, start + DEFAULT_UNDO_RETENTION_POLICY.windowMs - 60 * 60 * 1000, after)
    expect((await expirePreservedFiles(owner, cwd, { now: () => after })).expiredRefs).toEqual([kept.ref])
    expect(preservedRefs(cwd)).toEqual([])
  })

  it('the hourly sweep visits each project’s copies of the person’s own checkout and expires them after the window', async () => {
    const cwd = repo()
    const home = temp('mousse-kept-home-')
    const start = Date.parse('2026-11-03T12:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const owner = projectKeptFilesOwner(home, 'project-1')
    registerProjectKeptFilesFolder(owner, 'project-1', cwd)
    writeFileSync(join(cwd, 'draft.txt'), 'draft of the person\n')
    const kept = (await new GitService().discard(cwd, USER, ['draft.txt'], { owner }))!
    expect(threadPreservedIndex(owner).owns(kept.ref)).toBe(true)
    const sweeper = new UndoRetentionSweeper({ list: () => [], profileHome: home } as unknown as ResourceLifecycleStore)
    // The first pass belongs to starting up and never expires anything.
    await sweeper.tick()
    for (let day = 6; day < 30; day += 6) {
      vi.setSystemTime(start + day * DAY)
      await sweeper.tick()
    }
    vi.setSystemTime(start + 30 * DAY - 60 * 60 * 1000)
    await sweeper.tick()
    expect(preservedRefs(cwd)).toEqual([kept.ref])
    expect(sweeper.outcomes.get(`project:project-1:${cwd}`)).toMatchObject({ expiredPreservedRefs: 0 })
    vi.setSystemTime(start + 30 * DAY + 60 * 60 * 1000)
    await sweeper.tick()
    expect(preservedRefs(cwd)).toEqual([])
    expect(sweeper.outcomes.get(`project:project-1:${cwd}`)).toMatchObject({ expiredPreservedRefs: 1 })
    await sweeper.stop()
  })
})
