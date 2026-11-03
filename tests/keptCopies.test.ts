import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_COPY_LIMITS, KeepCopyRefusedError, keepCopy, keptCopyNotice, keptCopyRestoreCommand, projectKeptFilesOwner, projectKeptFilesOwners, registerProjectKeptFilesFolder, settleInterruptedKeeps } from '../src/mms/actions/keptCopies'
import { retireProjectSnapshots } from '../src/mms/workspace/SnapshotWorkspace'
import { expirePreservedFiles, threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { UndoRetentionSweeper } from '../src/mms/actions/UndoRetentionSweeper'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import type { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { DEFAULT_UNDO_RETENTION_POLICY } from '../src/shared/undoRetention'
import { discardPendingChangesAsync } from '../src/mms/actions/git'
import { pressed } from './support/userRequest'

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

/**
 * Brings the working version of `path` back from the copy with the command the result shows, run by a shell in the
 * repository's top folder as a person would, and reads the file's bytes.
 */
function restoreWorking(cwd: string, ref: string, path: string): Buffer {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  execFileSync('sh', ['-c', keptCopyRestoreCommand(ref, path, 'posix')], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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

  it('keeps an edit Git can tell only by its content in a whole-tree copy: same size, and the time its index entry records', async () => {
    const cwd = repo()
    // Without the change time, an edit within the second its entry was written looks the same to Git by size and time.
    git(cwd, 'config', 'core.trustctime', 'false')
    // A file written an hour ago, so its entry is not racy when it is committed and Git records its real size.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    writeFileSync(join(cwd, 'base.txt'), 'kept\n'); utimesSync(join(cwd, 'base.txt'), hourAgo, hourAgo)
    git(cwd, 'commit', '-qam', 'kept')
    const recorded = statSync(join(cwd, 'base.txt'))
    writeFileSync(join(cwd, 'base.txt'), 'KEPT\n')
    // The file and the index both carry the entry's time, so only a racy-clean check reads the file again. The copy of the
    // index is written afresh, so it has a new time unless the keep gives it the real index's.
    utimesSync(join(cwd, 'base.txt'), recorded.atime, recorded.mtime)
    utimesSync(join(cwd, '.git', 'index'), recorded.atime, recorded.mtime)
    // Read without writing the index: a write would mark the entry changed and hide what is tested here.
    expect(git(cwd, '--no-optional-locks', 'status', '--porcelain')).toBe('M base.txt')
    const kept = await keepCopy({ owner: temp('mousse-kept-owner-'), top: cwd, operationType: 'git-discard', action: 'Discard' })
    expect(restoreWorking(cwd, kept.ref, 'base.txt').toString()).toBe('KEPT\n')
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

describe('the copy holds each file’s bytes as they were on disk', () => {
  /** Commits `files` (with `.gitattributes` among them, say) on top of the fixture's base. */
  function commit(cwd: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(cwd, path), text)
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'setup')
  }
  async function discardAndRestore(cwd: string, path: string, bytes: Buffer): Promise<void> {
    const kept = (await new GitService().discard(cwd, USER, [path], { owner: temp('mousse-kept-owner-') }))!
    expect(existsSync(join(cwd, path)) && readFileSync(join(cwd, path)).equals(bytes)).toBe(false)
    expect(restoreWorking(cwd, kept.ref, path).equals(bytes)).toBe(true)
  }

  it('keeps CRLF line endings that core.autocrlf=input would turn into LF', async () => {
    const cwd = repo()
    git(cwd, 'config', 'core.autocrlf', 'input')
    const bytes = Buffer.from('one\r\ntwo\r\nthree\r\n')
    writeFileSync(join(cwd, 'base.txt'), bytes)
    await discardAndRestore(cwd, 'base.txt', bytes)
  })

  it('keeps CRLF line endings that text=auto would turn into LF', async () => {
    const cwd = repo()
    commit(cwd, { '.gitattributes': '* text=auto\n' })
    const bytes = Buffer.from('untracked\r\nwindows file\r\n')
    writeFileSync(join(cwd, 'win.txt'), bytes)
    await discardAndRestore(cwd, 'win.txt', bytes)
  })

  it('keeps what a clean filter would change', async () => {
    const cwd = repo()
    const config = join(temp('mousse-kept-config-'), 'gitconfig')
    writeFileSync(config, '[filter "mask"]\n\tclean = sed s/SECRET/xxxxxx/\n\tsmudge = cat\n')
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
    commit(cwd, { '.gitattributes': '*.cfg filter=mask\n', 'app.cfg': 'token=none\n' })
    const bytes = Buffer.from('token=SECRET\n')
    writeFileSync(join(cwd, 'app.cfg'), bytes)
    await discardAndRestore(cwd, 'app.cfg', bytes)
  })

  it('keeps an $Id$ line that ident would collapse', async () => {
    const cwd = repo()
    commit(cwd, { '.gitattributes': '*.c ident\n', 'main.c': '/* $Id$ */\n' })
    const bytes = Buffer.from('/* $Id: written by hand $ */\nint kept;\n')
    writeFileSync(join(cwd, 'main.c'), bytes)
    await discardAndRestore(cwd, 'main.c', bytes)
  })

  it('keeps a symbolic link as its link', async () => {
    const cwd = repo()
    symlinkSync('base.txt', join(cwd, 'link'))
    const kept = (await new GitService().discard(cwd, USER, ['link'], { owner: temp('mousse-kept-owner-') }))!
    expect(existsSync(join(cwd, 'link'))).toBe(false)
    expect(git(cwd, 'ls-tree', kept.ref, '--', 'link')).toMatch(/^120000 blob /)
    expect(gitBytes(cwd, 'cat-file', 'blob', `${kept.ref}:link`).toString()).toBe('base.txt')
  })
})

describe('the copy’s objects', () => {
  const objectCounts = (cwd: string) => Object.fromEntries(git(cwd, 'count-objects', '-v').split('\n').map((line) => line.split(': ')).map(([key, value]) => [key, Number(value)]))

  it('go into the repository as one pack, with no loose object, however many files there are', async () => {
    const cwd = repo()
    const paths: string[] = []
    for (let folder = 0; folder < 20; folder++) {
      mkdirSync(join(cwd, 'build', `d${folder}`), { recursive: true })
      for (let file = 0; file < 100; file++) {
        const path = `build/d${folder}/f${file}.js`
        writeFileSync(join(cwd, path), `// ${folder}/${file}\n${'x'.repeat(file)}`)
        paths.push(path)
      }
    }
    const before = objectCounts(cwd)
    const kept = (await new GitService().discard(cwd, USER, paths, { owner: temp('mousse-kept-owner-') }))!
    const after = objectCounts(cwd)
    expect(after.count).toBe(before.count)
    expect(after.packs).toBe(before.packs + 1)
    // Every object the copy names is there.
    expect(() => git(cwd, 'rev-list', '--objects', '--missing=error', kept.ref)).not.toThrow()
    expect(restoreWorking(cwd, kept.ref, 'build/d7/f42.js').toString()).toBe(`// 7/42\n${'x'.repeat(42)}`)
  })

  it('count staged versions toward the cap too', async () => {
    const cwd = repo()
    const owner = temp('mousse-kept-owner-')
    KEEP_COPY_LIMITS.bytes = 1000
    writeFileSync(join(cwd, 'staged.bin'), randomBytes(4000)); git(cwd, 'add', 'staged.bin')
    // Nothing is left on disk: the staged version is all the copy would hold.
    rmSync(join(cwd, 'staged.bin'))
    const refusal = await new GitService().discard(cwd, USER, ['staged.bin'], { owner }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'keep_copy_too_large', message: expect.stringContaining('staged.bin (3.9 KB)') })
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('staged.bin')
    expect(preservedRefs(cwd)).toEqual([])
  })

  it('a tracked file replaced by a folder: the folder’s files are kept, and the file comes back', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'lib'), 'a file\n'); git(cwd, 'add', 'lib'); git(cwd, 'commit', '-qm', 'lib')
    rmSync(join(cwd, 'lib')); mkdirSync(join(cwd, 'lib')); writeFileSync(join(cwd, 'lib', 'inner.txt'), 'in the folder\n')
    const kept = (await new GitService().discard(cwd, USER, ['lib', 'lib/inner.txt'], { owner: temp('mousse-kept-owner-') }))!
    expect(readFileSync(join(cwd, 'lib'), 'utf8')).toBe('a file\n')
    expect(gitBytes(cwd, 'cat-file', 'blob', `${kept.ref}:lib/inner.txt`).toString()).toBe('in the folder\n')
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
    expect(keptCopyNotice(kept, 'posix')).toBe(`A copy is kept for 30 days as ${kept.ref}. To bring a file back exactly as it was, run in ${cwd}: git cat-file blob ${kept.ref}:base.txt > base.txt; git cat-file blob ${kept.ref}:loose.txt > loose.txt (its staged version: git restore --source=${kept.ref}^2 --staged -- <path>).`)
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
    expect(await settleInterruptedKeeps(owner, cwd)).toEqual([written])
    const latest = new ThreadJournal(owner).latestByOperation()
    expect(latest.get(operationOf(written))).toMatchObject({ state: 'completed', details: { phase: 'outcome', ref: written, interrupted: true } })
    expect(latest.get(operationOf(missing))).toMatchObject({ state: 'failed', details: { phase: 'outcome', interrupted: true } })
    expect(preservedRefs(cwd)).toEqual([written])
    // Settled once: a second call records nothing more.
    const count = new ThreadJournal(owner).list().length
    expect(await settleInterruptedKeeps(owner, cwd)).toEqual([])
    expect(new ThreadJournal(owner).list()).toHaveLength(count)
    // Both stay the owner's, so the one that exists expires with the others.
    expect(threadPreservedIndex(owner).owns(written)).toBe(true)
  })
})

describe('owners', () => {
  it('settles only the keeps of the repository whose locks the caller holds', async () => {
    const first = repo()
    const second = repo()
    const owner = temp('mousse-kept-owner-')
    const operationId = '33333333-3333-4333-8333-333333333333'
    const sha = git(first, 'rev-parse', 'HEAD')
    const ref = `refs/mousse/preserved/${operationId}-${sha.slice(0, 12)}`
    new ThreadJournal(owner).append({ operationId, operationType: 'git-discard', state: 'prepared', details: { phase: 'intent', ref, sha, top: first } })
    // A keep in the first repository may still be running while the second one's is settled.
    expect(await settleInterruptedKeeps(owner, second)).toEqual([])
    expect(new ThreadJournal(owner).latestByOperation().get(operationId)?.state).toBe('prepared')
    expect(await settleInterruptedKeeps(owner, first)).toEqual([])
    expect(new ThreadJournal(owner).latestByOperation().get(operationId)?.state).toBe('failed')
  })

  it('a project’s owner is outside its data folder, so removing the project leaves its copies to expire', () => {
    const home = temp('mousse-kept-home-')
    const owner = projectKeptFilesOwner(home, 'project-2')
    registerProjectKeptFilesFolder(owner, 'project-2', repo())
    mkdirSync(join(home, 'project-data', 'project-2'), { recursive: true })
    expect(retireProjectSnapshots('project-2', home)).toBe('trashed')
    expect(existsSync(join(home, 'project-data', 'project-2'))).toBe(false)
    expect(projectKeptFilesOwners(home).map((item) => item.owner)).toEqual([owner])
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

  it('a project’s clock that jumped resumes by itself, and the jump is not counted: the copy is kept that much longer', async () => {
    const cwd = repo()
    const home = temp('mousse-kept-home-')
    const start = Date.parse('2026-11-03T12:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const owner = projectKeptFilesOwner(home, 'project-3')
    registerProjectKeptFilesFolder(owner, 'project-3', cwd)
    writeFileSync(join(cwd, 'draft.txt'), 'draft\n')
    const kept = (await new GitService().discard(cwd, USER, ['draft.txt'], { owner }))!
    const sweeper = new UndoRetentionSweeper({ list: () => [], profileHome: home } as unknown as ResourceLifecycleStore)
    await sweeper.tick()
    // Ten days with no sweep: more than the clock trusts in one step, as after a week with the computer off.
    vi.setSystemTime(start + 10 * DAY)
    await sweeper.tick()
    expect(sweeper.outcomes.get(`project:project-3:${cwd}`)?.reason).toBeUndefined()
    expect(new UndoRetentionService(owner, Date.now, true).suspendedSince()).toBeUndefined()
    for (let day = 16; day < 40; day += 6) {
      vi.setSystemTime(start + day * DAY)
      await sweeper.tick()
    }
    // Thirty days after the copy, plus the ten the clock did not count.
    vi.setSystemTime(start + 40 * DAY - 60 * 60 * 1000)
    await sweeper.tick()
    expect(preservedRefs(cwd)).toEqual([kept.ref])
    vi.setSystemTime(start + 40 * DAY + 60 * 60 * 1000)
    await sweeper.tick()
    expect(preservedRefs(cwd)).toEqual([])
    await sweeper.stop()
  })
})

/** Every file and link in the working tree with its bytes (a link's: its target), nested repositories' included, and HEAD. */
function everything(cwd: string): Record<string, string> {
  const found: Record<string, string> = { HEAD: git(cwd, 'rev-parse', 'HEAD') }
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (!rel && name === '.git') continue
      const path = join(dir, name), at = rel ? `${rel}/${name}` : name
      const info = lstatSync(path)
      if (info.isSymbolicLink()) found[at] = `link:${readlinkSync(path)}`
      else if (info.isDirectory()) walk(path, at)
      else found[at] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(cwd, '')
  return found
}

/** Pending-changes Discard as the protocol runs it: a whole-tree copy, then Git puts HEAD back. */
const discardPending = (cwd: string, owner: string) =>
  pressed('Discard changes', () => discardPendingChangesAsync(cwd, (top) => keepCopy({ top, owner, operationType: 'git-discard', action: 'Discard' })))

describe('the copy also keeps what stands where Discard puts a file back', () => {
  /** HEAD tracks `base.txt`; it is now an ignored folder holding the only copy of `private.bin` (audit N1/N2, inverted). */
  function ignoredFolderWhereAFileWas(): { cwd: string; value: Buffer } {
    const cwd = repo()
    rmSync(join(cwd, 'base.txt')); mkdirSync(join(cwd, 'base.txt'))
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'base.txt/\n')
    const value = Buffer.concat([Buffer.from('sole ignored bytes 71b9c18e\n'), randomBytes(32)])
    writeFileSync(join(cwd, 'base.txt', 'private.bin'), value)
    return { cwd, value }
  }

  it('Git panel Discard keeps the ignored files of a folder standing where HEAD has a file', async () => {
    const { cwd, value } = ignoredFolderWhereAFileWas()
    const kept = (await new GitService().discard(cwd, USER, ['base.txt'], { owner: temp('mousse-kept-owner-') }))!
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    // The person moves HEAD's file aside and brings the folder's file back with the command the result shows.
    rmSync(join(cwd, 'base.txt'))
    expect(restoreWorking(cwd, kept.ref, 'base.txt/private.bin').equals(value)).toBe(true)
  })

  it('pending-changes Discard keeps them too', async () => {
    const { cwd, value } = ignoredFolderWhereAFileWas()
    const kept = await discardPending(cwd, temp('mousse-kept-owner-'))
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    rmSync(join(cwd, 'base.txt'))
    expect(restoreWorking(cwd, kept.ref, 'base.txt/private.bin').equals(value)).toBe(true)
  })

  it('keeps an ignored file standing where HEAD has a folder, from either Discard', async () => {
    for (const how of ['panel', 'pending'] as const) {
      const cwd = repo()
      mkdirSync(join(cwd, 'docs')); writeFileSync(join(cwd, 'docs', 'a.txt'), 'a\n'); writeFileSync(join(cwd, 'docs', 'b.txt'), 'b\n')
      git(cwd, 'add', 'docs'); git(cwd, 'commit', '-qm', 'docs')
      rmSync(join(cwd, 'docs'), { recursive: true })
      writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'docs\n')
      const value = Buffer.from(`only copy of the docs notes ${how} 5be0\n`)
      writeFileSync(join(cwd, 'docs'), value)
      const kept = how === 'panel'
        ? (await new GitService().discard(cwd, USER, ['docs/a.txt'], { owner: temp('mousse-kept-owner-') }))!
        : await discardPending(cwd, temp('mousse-kept-owner-'))
      expect(readFileSync(join(cwd, 'docs', 'a.txt'), 'utf8')).toBe('a\n')
      rmSync(join(cwd, 'docs'), { recursive: true })
      expect(restoreWorking(cwd, kept.ref, 'docs').equals(value)).toBe(true)
    }
  })

  it('keeps a link in the way as a link: never read through it, never walked through', async () => {
    const cwd = repo()
    mkdirSync(join(cwd, 'docs')); writeFileSync(join(cwd, 'docs', 'a.txt'), 'a\n')
    git(cwd, 'add', 'docs'); git(cwd, 'commit', '-qm', 'docs')
    rmSync(join(cwd, 'docs'), { recursive: true })
    const outside = temp('mousse-kept-outside-')
    writeFileSync(join(outside, 'a.txt'), 'outside bytes, not the repository\'s\n')
    symlinkSync(outside, join(cwd, 'docs'))
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'docs\n')
    const kept = (await new GitService().discard(cwd, USER, ['docs/a.txt'], { owner: temp('mousse-kept-owner-') }))!
    expect(git(cwd, 'ls-tree', kept.ref, '--', 'docs')).toMatch(/^120000 blob /)
    expect(git(cwd, 'cat-file', 'blob', `${kept.ref}:docs`)).toBe(outside)
    expect(() => git(cwd, 'cat-file', '-e', `${kept.ref}:docs/a.txt`)).toThrow()
    expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('outside bytes, not the repository\'s\n')
    expect(readFileSync(join(cwd, 'docs', 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('refuses, naming it, when a repository of its own stands where HEAD has a file, and changes nothing', async () => {
    for (const how of ['panel', 'pending'] as const) {
      const cwd = repo()
      rmSync(join(cwd, 'base.txt')); mkdirSync(join(cwd, 'base.txt'))
      git(join(cwd, 'base.txt'), 'init', '-q', '-b', 'main')
      writeFileSync(join(cwd, 'base.txt', 'history.txt'), 'nested history\n')
      git(join(cwd, 'base.txt'), 'add', '.'); git(join(cwd, 'base.txt'), '-c', 'user.name=N', '-c', 'user.email=n@example.invalid', 'commit', '-qm', 'nested')
      const before = everything(cwd)
      const index = indexDigest(cwd)
      const work = how === 'panel'
        ? new GitService().discard(cwd, USER, ['base.txt'], { owner: temp('mousse-kept-owner-') })
        : discardPending(cwd, temp('mousse-kept-owner-'))
      await expect(work).rejects.toThrow(/base\.txt is a separate Git repository/)
      if (how === 'pending') await expect(discardPending(cwd, temp('mousse-kept-owner-'))).rejects.toBeInstanceOf(KeepCopyRefusedError)
      expect(everything(cwd)).toEqual(before)
      expect(indexDigest(cwd)).toBe(index)
      expect(preservedRefs(cwd)).toEqual([])
    }
  })

  it('leaves an untracked repository of its own alone, as before', async () => {
    const cwd = repo()
    mkdirSync(join(cwd, 'other')); git(join(cwd, 'other'), 'init', '-q', '-b', 'main')
    writeFileSync(join(cwd, 'other', 'kept.txt'), 'nested\n')
    writeFileSync(join(cwd, 'base.txt'), 'edited\n')
    const kept = await discardPending(cwd, temp('mousse-kept-owner-'))
    expect(readFileSync(join(cwd, 'other', 'kept.txt'), 'utf8')).toBe('nested\n')
    expect(restoreWorking(cwd, kept.ref, 'base.txt').toString()).toBe('edited\n')
  })

  it('a dirty submodule does not block the copy, and is neither walked nor changed', async () => {
    const cwd = repo()
    const sub = join(cwd, 'sub')
    mkdirSync(sub); git(sub, 'init', '-q', '-b', 'main')
    writeFileSync(join(sub, 'lib.txt'), 'lib\n'); git(sub, 'add', '.'); git(sub, '-c', 'user.name=N', '-c', 'user.email=n@example.invalid', 'commit', '-qm', 'lib')
    git(cwd, 'add', 'sub'); git(cwd, 'commit', '-qm', 'submodule')
    writeFileSync(join(sub, 'lib.txt'), 'dirty submodule work\n')
    writeFileSync(join(cwd, 'base.txt'), 'edited\n')
    const kept = await keepCopy({ owner: temp('mousse-kept-owner-'), top: cwd, operationType: 'git-discard', action: 'Discard' })
    expect(() => git(cwd, 'cat-file', '-e', `${kept.ref}:sub/lib.txt`)).toThrow()
    expect(git(cwd, 'ls-tree', kept.ref, '--', 'sub')).toMatch(/^160000 commit /)
    expect(restoreWorking(cwd, kept.ref, 'base.txt').toString()).toBe('edited\n')
    expect(readFileSync(join(sub, 'lib.txt'), 'utf8')).toBe('dirty submodule work\n')
    const panel = (await new GitService().discard(cwd, USER, ['sub', 'base.txt'], { owner: temp('mousse-kept-owner-') }))!
    expect(panel.ref).toBeTruthy()
    expect(readFileSync(join(sub, 'lib.txt'), 'utf8')).toBe('dirty submodule work\n')
  })

  it('counts the files it walks toward the size limit, and refuses before changing anything', async () => {
    const { cwd } = ignoredFolderWhereAFileWas()
    writeFileSync(join(cwd, 'base.txt', 'large.bin'), randomBytes(64 * 1024))
    KEEP_COPY_LIMITS.bytes = 32 * 1024
    const before = everything(cwd)
    const error = await new GitService().discard(cwd, USER, ['base.txt'], { owner: temp('mousse-kept-owner-') }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'keep_copy_too_large', message: expect.stringContaining('base.txt/large.bin (64 KB)') })
    await expect(discardPending(cwd, temp('mousse-kept-owner-'))).rejects.toMatchObject({ code: 'keep_copy_too_large' })
    expect(everything(cwd)).toEqual(before)
    expect(preservedRefs(cwd)).toEqual([])
  })
})
