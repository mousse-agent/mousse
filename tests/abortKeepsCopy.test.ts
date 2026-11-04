/**
 * Abort keeps what it writes over (`abortKeepingCopy`). Every check restores the kept copy with the command the result
 * shows and compares the bytes: a ref existing proves nothing.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { abortKeepingCopy } from '../src/mms/actions/abortKeepingCopy'
import { abortKeptNotice, keptCopyRestoreCommand, projectKeptFilesOwner, type KeptCopy } from '../src/mms/actions/keptCopies'
import { threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { MousseMainService } from '../src/mms/MousseMainService'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import type { GitKeptCopy, GitStatusSnapshot } from '../src/shared/types'
import { gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-abort-keeps-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const bytes = (cwd: string, ...args: string[]): Buffer => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
const USER = userAction('button', 'Abort')
let count = 0

function repo(config: Record<string, string> = {}): string {
  const cwd = join(root, `repo-${++count}`)
  mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null', ...config })) git(cwd, 'config', key, value)
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base')
  return cwd
}

function owner(): string {
  const path = join(root, `owner-${++count}`)
  mkdirSync(path)
  return path
}

/** `main` and `feature` both change base.txt; the merge of feature stops on it. */
function conflictedMerge(cwd: string): void {
  git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
  git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
  expect(() => git(cwd, 'merge', 'feature')).toThrow()
}

/** Runs the command the notice shows for `path`, in the folder it names. */
const restore = (kept: Pick<KeptCopy, 'ref' | 'top'>, path: string) => execFileSync('sh', ['-c', keptCopyRestoreCommand(kept.ref, path, 'posix')], { cwd: kept.top })

/** The conflict stages the index holds, as the copy's third parent lays them out. */
const stagesNow = (cwd: string): string[] => git(cwd, 'ls-files', '-u').split('\n').filter(Boolean).map((line) => {
  const [info, path] = line.split('\t') as [string, string]
  const [mode, sha, stage] = info.split(' ') as [string, string, string]
  return `${mode} blob ${sha}\tstage-${stage}/${path}`
}).sort()

describe('Git panel Abort keeps what it writes over', () => {
  for (const [name, value, config] of [
    ['a hand resolution', 'manual resolution after merge conflict 924d86\n', {}],
    ['a CRLF hand resolution under autocrlf=input', 'manual resolution\r\nwith CRLF line ends 7c1e\r\n', { 'core.autocrlf': 'input' }]
  ] as const) {
    it(`N7: keeps ${name} byte for byte, with the conflict stages, before Git aborts the merge`, async () => {
      const cwd = repo(config), keeper = owner()
      conflictedMerge(cwd)
      const stages = stagesNow(cwd)
      expect(stages).toHaveLength(3)
      writeFileSync(join(cwd, 'base.txt'), value)

      const kept = (await new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))!
      expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false)
      expect(git(cwd, 'status', '--porcelain')).toBe('')
      // The conflict stages Git held, as `<ref>^3`.
      expect(git(cwd, 'ls-tree', '-r', `${kept.ref}^3`).split('\n').sort()).toEqual(stages)
      // The thread's (here: the owner's) own copy, recorded as an Abort.
      expect(threadPreservedIndex(keeper).owns(kept.ref)).toBe(true)
      expect([...new ThreadJournal(keeper).latestByOperation().values()].find((entry) => entry.operationType === 'git-abort')).toMatchObject({ state: 'completed', details: { ref: kept.ref } })
      // Its notice, and the command in it, bring the resolution back exactly.
      const notice = abortKeptNotice('merge', kept, 'posix')
      // No command that restores a staged version from ^2, which has none for a conflicted file: its stages are named.
      expect(notice).toBe(`Merge aborted. Your edits are kept for 30 days as ${kept.ref}. To bring a file back exactly as it was, run in ${kept.top}: ${keptCopyRestoreCommand(kept.ref, 'base.txt', 'posix')} (base.txt had a conflict: its versions are kept as ${kept.ref}^3:stage-1/<path>, stage-2/<path> and stage-3/<path>).`)
      restore(kept, 'base.txt')
      expect(readFileSync(join(cwd, 'base.txt')).equals(Buffer.from(value))).toBe(true)
    })
  }

  it('leaves what Git’s abort does not write as it is: an edit to a file the merge did not touch, and untracked files', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'mine.txt'), 'committed\n'); git(cwd, 'add', 'mine.txt'); git(cwd, 'commit', '-qm', 'mine')
    conflictedMerge(cwd)
    writeFileSync(join(cwd, 'mine.txt'), 'edited during the merge, never staged\n')
    writeFileSync(join(cwd, 'scratch.txt'), 'untracked\n')
    const before = { mine: readFileSync(join(cwd, 'mine.txt')), scratch: readFileSync(join(cwd, 'scratch.txt')) }
    const ino = statSync(join(cwd, 'mine.txt')).ino

    const kept = (await new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))!
    expect(readFileSync(join(cwd, 'mine.txt')).equals(before.mine)).toBe(true)
    expect(readFileSync(join(cwd, 'scratch.txt')).equals(before.scratch)).toBe(true)
    // Never removed and written again: the very same file.
    expect(statSync(join(cwd, 'mine.txt')).ino).toBe(ino)
    expect([...kept.digests.keys()]).toEqual(['base.txt'])
  })

  it('a rebase stop keeps an ignored file at a path the commit it started from tracks', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'local.env'), 'tracked settings\n'); git(cwd, 'add', 'local.env'); git(cwd, 'commit', '-qm', 'track settings')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'rm', '-q', 'local.env')
    writeFileSync(join(cwd, '.gitignore'), 'local.env\n'); git(cwd, 'add', '.gitignore'); git(cwd, 'commit', '-qam', 'stop tracking settings')
    git(cwd, 'checkout', '-q', 'feature')
    expect(() => git(cwd, 'rebase', 'main')).toThrow()
    // At the stop the settings file is not tracked, and ignored: a tool writes the only copy of new settings there.
    expect(existsSync(join(cwd, 'local.env'))).toBe(false)
    const value = 'only copy of new settings 5d02a1\n'
    writeFileSync(join(cwd, 'local.env'), value)
    expect(git(cwd, 'check-ignore', 'local.env')).toBe('local.env')

    const kept = (await new GitService().abortInProgress(cwd, USER, 'rebase', { owner: keeper }))!
    expect(git(cwd, 'branch', '--show-current')).toBe('feature')
    expect(readFileSync(join(cwd, 'local.env'), 'utf8')).toBe('tracked settings\n')
    expect(bytes(cwd, 'cat-file', 'blob', `${kept.ref}:local.env`).equals(Buffer.from(value))).toBe(true)
    restore(kept, 'local.env')
    expect(readFileSync(join(cwd, 'local.env'), 'utf8')).toBe(value)
  })

  it('a commit the rebase made before it stopped survives reflog expiry and gc within the window', async () => {
    const cwd = repo(), keeper = owner()
    git(cwd, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(cwd, 'other.txt'), 'replays cleanly\n'); git(cwd, 'add', 'other.txt'); git(cwd, 'commit', '-qm', 'clean')
    writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'conflicts')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    git(cwd, 'checkout', '-q', 'feature')
    expect(() => git(cwd, 'rebase', 'main')).toThrow()
    const replayed = git(cwd, 'rev-parse', 'HEAD')
    expect(git(cwd, 'log', '-1', '--format=%s', replayed)).toBe('clean')

    const kept = (await new GitService().abortInProgress(cwd, USER, 'rebase', { owner: keeper }))!
    expect(git(cwd, 'rev-parse', `${kept.ref}^1`)).toBe(replayed)
    git(cwd, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all')
    git(cwd, 'gc', '-q', '--prune=now')
    expect(git(cwd, 'cat-file', '-t', replayed)).toBe('commit')
    expect(git(cwd, 'show', `${replayed}:other.txt`)).toBe('replays cleanly')
  })

  it('a save between the copy and Git’s abort is kept in a fresh copy, and the earlier copy stays', async () => {
    const cwd = repo(), keeper = owner()
    conflictedMerge(cwd)
    const resolution = 'resolution before the save\n', saved = 'save after the copy was kept 3b9e0d\n'
    writeFileSync(join(cwd, 'base.txt'), resolution)
    // The editor saves right after the first copy is named: the bytes it read are no longer what is on disk.
    const bin = join(root, `bin-${++count}`), fired = join(root, `fired-${count}`), realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" update-ref --no-deref refs/mousse/preserved/"*) if [ ! -e '${fired}' ]; then printf '%s' '${saved}' > '${cwd}/base.txt'; : > '${fired}'; fi ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
    const previous = process.env.PATH
    let kept: KeptCopy
    try {
      process.env.PATH = `${bin}:${previous}`
      kept = (await new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))!
    } finally { process.env.PATH = previous }
    expect(existsSync(fired)).toBe(true)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
    const refs = git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)
    expect(refs).toHaveLength(2)
    expect(refs.every((ref) => threadPreservedIndex(keeper).owns(ref))).toBe(true)
    const earlier = refs.find((ref) => ref !== kept.ref)!
    expect(bytes(cwd, 'cat-file', 'blob', `${earlier}:base.txt`).toString()).toBe(resolution)
    restore(kept, 'base.txt')
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(saved)
  })

  it('a file that keeps changing refuses the abort, naming it, and leaves the merge and the file as they are', async () => {
    const cwd = repo(), keeper = owner()
    conflictedMerge(cwd)
    writeFileSync(join(cwd, 'base.txt'), 'resolution 0\n')
    const bin = join(root, `bin-${++count}`), realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    mkdirSync(bin)
    // Every copy is out of date the moment it is named.
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" update-ref --no-deref refs/mousse/preserved/"*) printf 'resolution %s\\n' "$$" > '${cwd}/base.txt' ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
    const previous = process.env.PATH
    try {
      process.env.PATH = `${bin}:${previous}`
      await expect(new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper })).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringContaining('base.txt kept changing') })
    } finally { process.env.PATH = previous }
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toMatch(/^resolution \d+\n$/)
  })

  it('a Git abort that fails puts every removed file back where nothing stands', async () => {
    const cwd = repo(), keeper = owner()
    conflictedMerge(cwd)
    const value = 'resolution kept on disk when Git fails\n'
    writeFileSync(join(cwd, 'base.txt'), value)
    const bin = join(root, `bin-${++count}`), realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" merge --abort "*) echo 'fatal: simulated failure' >&2; exit 128 ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
    const previous = process.env.PATH
    try {
      process.env.PATH = `${bin}:${previous}`
      await expect(new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper })).rejects.toThrow(/simulated failure/)
    } finally { process.env.PATH = previous }
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(value)
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true)
  })

  it('a folder of ignored files where the abort puts a file back is kept and goes', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'notes'), 'tracked notes\n'); git(cwd, 'add', 'notes'); git(cwd, 'commit', '-qm', 'notes')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    git(cwd, 'checkout', '-q', 'feature')
    expect(() => git(cwd, 'rebase', 'main')).toThrow()
    // During the stop the tracked file is replaced by a folder of ignored output.
    git(cwd, 'rm', '-q', '--cached', 'notes'); rmSync(join(cwd, 'notes'))
    mkdirSync(join(cwd, 'notes', 'deep'), { recursive: true })
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'notes/\n')
    const value = 'only copy inside the folder 0e44\n'
    writeFileSync(join(cwd, 'notes', 'deep', 'out.bin'), value)

    const kept = (await new GitService().abortInProgress(cwd, USER, 'rebase', { owner: keeper }))!
    expect(readFileSync(join(cwd, 'notes'), 'utf8')).toBe('tracked notes\n')
    expect(bytes(cwd, 'cat-file', 'blob', `${kept.ref}:notes/deep/out.bin`).equals(Buffer.from(value))).toBe(true)
  })
})

/** A `git` on PATH that runs `script` (sh) once, the first time Git is asked to name a kept copy, then the real Git. */
function onFirstKeep(script: string): { bin: string; fired: string } {
  const bin = join(root, `bin-${++count}`), fired = join(root, `fired-${count}`), realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" update-ref --no-deref refs/mousse/preserved/"*) if [ ! -e '${fired}' ]; then ${script}; : > '${fired}'; fi ;;\nesac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
  return { bin, fired }
}
async function withPath<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  try { process.env.PATH = `${bin}:${previous}`; return await run() } finally { process.env.PATH = previous }
}
/** Every preserved ref's version of `path`, as bytes. */
const keptVersions = (cwd: string, path: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)
  .flatMap((ref) => { try { return [bytes(cwd, 'cat-file', 'blob', `${ref}:${path}`).toString()] } catch { return [] } })

describe('Abort keeps what the autostash and late saves write over, and refuses where Git does', () => {
  for (const kind of ['merge', 'rebase'] as const) {
    it(`${kind} --autostash: an ignored file at a path the autostash puts a staged file back at is kept`, async () => {
      const cwd = repo(), keeper = owner()
      git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
      git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
      if (kind === 'rebase') git(cwd, 'checkout', '-q', 'feature')
      writeFileSync(join(cwd, 'draft'), 'staged draft, stashed\n'); git(cwd, 'add', 'draft')
      expect(() => git(cwd, kind, '--autostash', kind === 'rebase' ? 'main' : 'feature')).toThrow()
      expect(existsSync(join(cwd, 'draft'))).toBe(false)
      // During the stop a tool writes the only copy of new bytes at the stashed path, ignored there.
      writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'draft\n')
      const value = 'only copy written during the stop 6e1f\r\n'
      writeFileSync(join(cwd, 'draft'), value)

      const kept = (await new GitService().abortInProgress(cwd, USER, kind, { owner: keeper }))!
      // Git's abort applied the autostash again, as plain Git does.
      expect(readFileSync(join(cwd, 'draft'), 'utf8')).toBe('staged draft, stashed\n')
      expect(bytes(cwd, 'cat-file', 'blob', `${kept.ref}:draft`).equals(Buffer.from(value))).toBe(true)
      rmSync(join(cwd, 'draft'))
      restore(kept, 'draft')
      expect(readFileSync(join(cwd, 'draft')).equals(Buffer.from(value))).toBe(true)
    })
  }

  it('a file saved at a write path that was empty when the copy was kept is kept in a fresh copy', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'local.env'), 'tracked\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'track')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'rm', '-q', 'local.env'); git(cwd, 'commit', '-qam', 'main')
    git(cwd, 'checkout', '-q', 'feature'); expect(() => git(cwd, 'rebase', 'main')).toThrow()
    expect(existsSync(join(cwd, 'local.env'))).toBe(false)
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'local.env\n')
    const saved = 'saved right after the copy 1938\n'
    const shim = onFirstKeep(`printf '%s' '${saved}' > '${cwd}/local.env'`)
    const kept = (await withPath(shim.bin, () => new GitService().abortInProgress(cwd, USER, 'rebase', { owner: keeper })))!
    expect(existsSync(shim.fired)).toBe(true)
    expect(readFileSync(join(cwd, 'local.env'), 'utf8')).toBe('tracked\n')
    expect(bytes(cwd, 'cat-file', 'blob', `${kept.ref}:local.env`).toString()).toBe(saved)
  })

  it('a conflicted file deleted at the stop and saved again right after the copy is kept', async () => {
    const cwd = repo(), keeper = owner()
    conflictedMerge(cwd)
    rmSync(join(cwd, 'base.txt'))
    const late = 'late save into a path that was empty at keep time\n'
    const shim = onFirstKeep(`printf '%s' '${late}' > '${cwd}/base.txt'`)
    await withPath(shim.bin, () => new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))
    expect(existsSync(shim.fired)).toBe(true)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
    expect(keptVersions(cwd, 'base.txt')).toContain(late)
  })

  it('a file that appears at an emptied path right before Git starts is kept: the last check runs with Git’s start', async () => {
    const cwd = repo(), keeper = owner()
    conflictedMerge(cwd)
    writeFileSync(join(cwd, 'base.txt'), 'hand resolution\n')
    const late = 'appeared after the files were removed 51c2\n'
    let fired = false
    const kept = (await pressed('Abort', () => abortKeepingCopy({ top: cwd, owner: keeper, kind: 'merge', action: 'Abort', abort: async (beforeStart) => {
      if (!fired) { fired = true; expect(existsSync(join(cwd, 'base.txt'))).toBe(false); writeFileSync(join(cwd, 'base.txt'), late) }
      beforeStart()
      git(cwd, 'merge', '--abort')
    } })))!
    expect(fired).toBe(true)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
    expect(bytes(cwd, 'cat-file', 'blob', `${kept.ref}:base.txt`).toString()).toBe(late)
    expect(keptVersions(cwd, 'base.txt')).toContain('hand resolution\n')
  })

  it('a file the merge staged and the person edited again refuses as plain Git does, changing nothing', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'a')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); writeFileSync(join(cwd, 'a.txt'), 'a2\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    expect(() => git(cwd, 'merge', 'feature')).toThrow()
    writeFileSync(join(cwd, 'a.txt'), 'a2 plus my unstaged edit\n')
    const before = git(cwd, 'status', '--porcelain')
    await expect(new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper })).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringContaining('a.txt has changes that are not staged') })
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a2 plus my unstaged edit\n')
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(git(cwd, 'status', '--porcelain')).toBe(before)
    expect(git(cwd, 'for-each-ref', 'refs/mousse/preserved/')).toBe('')
  })

  it('a file that is not tracked where the rebase’s start has one refuses as plain Git does, changing nothing', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'local.env'), 'tracked\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'track')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'rm', '-q', 'local.env'); git(cwd, 'commit', '-qam', 'main')
    git(cwd, 'checkout', '-q', 'feature'); expect(() => git(cwd, 'rebase', 'main')).toThrow()
    writeFileSync(join(cwd, 'local.env'), 'untracked, not ignored\n')
    await expect(new GitService().abortInProgress(cwd, USER, 'rebase', { owner: keeper })).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringContaining('local.env is not tracked') })
    expect(readFileSync(join(cwd, 'local.env'), 'utf8')).toBe('untracked, not ignored\n')
    expect(existsSync(join(cwd, '.git', 'rebase-merge'))).toBe(true)
  })

  it('a run of picks after which HEAD moved is only ended, as Git does: no file is removed', async () => {
    const cwd = repo(), keeper = owner()
    git(cwd, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(cwd, 'c1.txt'), 'c1\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'c1')
    writeFileSync(join(cwd, 'base.txt'), 'side\n'); git(cwd, 'commit', '-qam', 'c2')
    writeFileSync(join(cwd, 'c3.txt'), 'c3\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'c3')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    expect(() => git(cwd, 'cherry-pick', 'side~2', 'side~1', 'side')).toThrow()
    expect(existsSync(join(cwd, '.git', 'sequencer'))).toBe(true)
    // The person resolves and commits at the stop: HEAD moved past where the sequencer last was.
    writeFileSync(join(cwd, 'base.txt'), 'resolved and committed\n'); git(cwd, 'add', 'base.txt'); git(cwd, '-c', 'core.editor=true', 'commit', '-qm', 'resolved')
    const head = git(cwd, 'rev-parse', 'HEAD')
    expect(existsSync(join(cwd, '.git', 'sequencer'))).toBe(true)
    await new GitService().abortInProgress(cwd, USER, 'cherry-pick', { owner: keeper })
    expect(existsSync(join(cwd, '.git', 'sequencer'))).toBe(false)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('resolved and committed\n')
    expect(readFileSync(join(cwd, 'c1.txt'), 'utf8')).toBe('c1\n')
  })

  it('Git failing after it wrote names the copy, and its command brings the resolution back', async () => {
    const cwd = repo(), keeper = owner()
    mkdirSync(join(cwd, 'ro')); writeFileSync(join(cwd, 'ro', 'gone.txt'), 'HEAD has it\n'); writeFileSync(join(cwd, 'ro', 'stay.txt'), 's\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'ro')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'rm', '-q', 'ro/gone.txt'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    expect(() => git(cwd, 'merge', 'feature')).toThrow()
    const resolution = 'hand resolution kept when Git stops part way\n'
    writeFileSync(join(cwd, 'base.txt'), resolution)
    chmodSync(join(cwd, 'ro'), 0o555)
    let error: { message: string } | undefined
    try { await new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }) } catch (caught) { error = caught as typeof error } finally { chmodSync(join(cwd, 'ro'), 0o755) }
    expect(error).toBeDefined()
    const ref = /kept for 30 days as (refs\/mousse\/preserved\/\S+)\./.exec(error!.message)?.[1]
    expect(ref).toMatch(/^refs\/mousse\/preserved\//)
    // Git wrote HEAD's version over the resolution before it stopped.
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
    const command = keptCopyRestoreCommand(ref!, 'base.txt', 'posix')
    expect(error!.message).toContain(`Git's abort stopped part way, after it wrote over base.txt. What base.txt held is kept for 30 days as ${ref}.`)
    expect(error!.message).toContain(command)
    execFileSync('sh', ['-c', command], { cwd })
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(resolution)
  })
})

describe('Abort keeps what Git would write that was clean when the copy was kept', () => {
  /** A rebase of feature onto main that stops on base.txt, with `other` tracked and clean. */
  const stoppedRebase = (cwd: string): void => {
    writeFileSync(join(cwd, 'other'), 'original other\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'other')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    git(cwd, 'checkout', '-q', 'feature'); expect(() => git(cwd, 'rebase', 'main')).toThrow()
  }
  for (const staged of [false, true]) {
    it(`a clean tracked file saved${staged ? ' and staged' : ''} after the copy, which a rebase's abort writes over, is kept first`, async () => {
      const cwd = repo({ 'core.autocrlf': 'input' }), keeper = owner()
      stoppedRebase(cwd)
      const late = 'saved after the copy, raw CRLF 0b7e\r\n'
      const shim = onFirstKeep(`printf '%s' '${late}' > '${cwd}/other'${staged ? ` && git -C '${cwd}' add other` : ''}`)
      await withPath(shim.bin, () => new GitService().abortInProgress(cwd, USER, 'rebase', { owner: keeper }))
      expect(existsSync(shim.fired)).toBe(true)
      // Git's abort put orig-head's version back, as plain Git does; the save is in a copy, byte for byte.
      expect(readFileSync(join(cwd, 'other'), 'utf8')).toBe('original other\n')
      expect(keptVersions(cwd, 'other')).toContain(late)
    })
  }

  it('a file staged after the copy, which a merge abort writes over, is kept first', async () => {
    const cwd = repo({ 'core.autocrlf': 'input' }), keeper = owner()
    writeFileSync(join(cwd, 'other'), 'original other\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'other')
    conflictedMerge(cwd)
    const late = 'staged after the copy, raw CRLF 77aa\r\n'
    const shim = onFirstKeep(`printf '%s' '${late}' > '${cwd}/other' && git -C '${cwd}' add other`)
    await withPath(shim.bin, () => new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))
    expect(existsSync(shim.fired)).toBe(true)
    expect(readFileSync(join(cwd, 'other'), 'utf8')).toBe('original other\n')
    expect(keptVersions(cwd, 'other')).toContain(late)
  })

  for (const kind of ['merge', 'rebase'] as const) {
    it(`${kind}: an autostash that holds ignored files (stash -a) is read, and what it writes over is kept`, async () => {
      const cwd = repo(), keeper = owner()
      writeFileSync(join(cwd, '.gitignore'), 'draft\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'ignore')
      writeFileSync(join(cwd, 'draft'), 'stashed ignored bytes\n'); git(cwd, 'stash', 'push', '-q', '-a', '-m', 'ignored')
      const stash = git(cwd, 'rev-parse', 'stash')
      git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
      git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
      if (kind === 'rebase') git(cwd, 'checkout', '-q', 'feature')
      expect(() => git(cwd, kind, kind === 'rebase' ? 'main' : 'feature')).toThrow()
      writeFileSync(join(cwd, '.git', kind === 'merge' ? 'MERGE_AUTOSTASH' : 'rebase-merge/autostash'), `${stash}\n`)
      const value = 'during-stop ignored bytes 4d21\r\n'
      writeFileSync(join(cwd, 'draft'), value)
      const kept = (await new GitService().abortInProgress(cwd, USER, kind, { owner: keeper }))!
      expect(readFileSync(join(cwd, 'draft'), 'utf8')).toBe('stashed ignored bytes\n')
      expect(bytes(cwd, 'cat-file', 'blob', `${kept.ref}:draft`).equals(Buffer.from(value))).toBe(true)
    })
  }

  for (const kind of ['merge', 'rebase'] as const) {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      it(`${kind}: a staged file flagged ${flag} and edited again refuses as plain Git does`, async () => {
        const cwd = repo(), keeper = owner()
        writeFileSync(join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'a')
        git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-qam', 'feature')
        git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
        if (kind === 'rebase') git(cwd, 'checkout', '-q', 'feature')
        expect(() => git(cwd, kind, kind === 'rebase' ? 'main' : 'feature')).toThrow()
        writeFileSync(join(cwd, 'a.txt'), 'staged\n'); git(cwd, 'add', 'a.txt'); git(cwd, 'update-index', flag, 'a.txt')
        writeFileSync(join(cwd, 'a.txt'), 'staged, then edited again 9c3e\n')
        await expect(new GitService().abortInProgress(cwd, USER, kind, { owner: keeper })).rejects.toMatchObject({ code: 'keep_copy_refused', message: expect.stringContaining('a.txt has changes that are not staged') })
        expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('staged, then edited again 9c3e\n')
      })
    }
  }

  it('a file Git’s failed abort leaves out comes back with the permission bits it had', async () => {
    const cwd = repo(), keeper = owner()
    conflictedMerge(cwd)
    writeFileSync(join(cwd, 'base.txt'), 'private resolution\n'); chmodSync(join(cwd, 'base.txt'), 0o600)
    const lock = join(cwd, '.git', 'index.lock')
    await expect(pressed('Abort', () => abortKeepingCopy({ top: cwd, owner: keeper, kind: 'merge', action: 'Abort', abort: async (beforeStart) => {
      beforeStart()
      writeFileSync(lock, '')
      try { git(cwd, 'merge', '--abort') } finally { rmSync(lock, { force: true }) }
    } }))).rejects.toThrow()
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('private resolution\n')
    expect(statSync(join(cwd, 'base.txt')).mode & 0o777).toBe(0o600)
  })
})

describe('the commands the Abort notice shows', () => {
  it('replace a link standing at the path instead of writing through it, and bring a kept link back as a link', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'other.txt'), 'other file, never to be written\n'); symlinkSync('base.txt', join(cwd, 'link')); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'files')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); rmSync(join(cwd, 'link')); symlinkSync('other.txt', join(cwd, 'link')); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    expect(() => git(cwd, 'merge', 'feature')).toThrow()
    const resolution = 'hand resolution\n'
    writeFileSync(join(cwd, 'base.txt'), resolution)
    const kept = (await new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))!
    // After the abort, a link to other.txt stands where base.txt was.
    rmSync(join(cwd, 'base.txt')); symlinkSync('other.txt', join(cwd, 'base.txt'))
    const file = keptCopyRestoreCommand(kept.ref, 'base.txt', 'posix')
    expect(abortKeptNotice('merge', kept, 'posix')).toContain(file)
    execFileSync('sh', ['-c', file], { cwd })
    expect(readFileSync(join(cwd, 'other.txt'), 'utf8')).toBe('other file, never to be written\n')
    expect(lstatSync(join(cwd, 'base.txt')).isFile()).toBe(true)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(resolution)
    // The merge's retargeted link comes back as the link it was.
    expect(kept.kinds.get('link')).toBe('link')
    const link = keptCopyRestoreCommand(kept.ref, 'link', 'posix', 'link')
    expect(abortKeptNotice('merge', kept, 'posix')).toContain(link)
    execFileSync('sh', ['-c', link], { cwd })
    expect(readlinkSync(join(cwd, 'link'))).toBe('other.txt')
  })

  it('offer the staged command only for a staged file, and it puts that version back without staging a deletion', async () => {
    const cwd = repo(), keeper = owner()
    writeFileSync(join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'a')
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); writeFileSync(join(cwd, 'a.txt'), 'a from feature\n'); git(cwd, 'commit', '-qam', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-qam', 'main')
    expect(() => git(cwd, 'merge', 'feature')).toThrow()
    writeFileSync(join(cwd, 'base.txt'), 'resolution\n')
    const kept = (await new GitService().abortInProgress(cwd, USER, 'merge', { owner: keeper }))!
    const notice = abortKeptNotice('merge', kept, 'posix')
    expect(notice).toContain(`the staged version of a.txt: git restore --source=${kept.ref}^2 --staged -- <path>`)
    expect(notice).toContain(`base.txt had a conflict: its versions are kept as ${kept.ref}^3:stage-1/<path>`)
    // The conflicted file is listed first.
    expect(notice.indexOf('./base.txt')).toBeLessThan(notice.indexOf('./a.txt'))
    git(cwd, 'restore', `--source=${kept.ref}^2`, '--staged', '--', 'a.txt')
    expect(git(cwd, 'show', ':a.txt')).toBe('a from feature')
    expect(git(cwd, 'status', '--porcelain', '--', 'base.txt')).toBe('')
  })
})

type Aborted = { status: GitStatusSnapshot; kept?: GitKeptCopy }

describe('Git panel Abort through the daemon', () => {
  let f: ReturnType<typeof gitFoundationFixture>
  let mms: MousseMainService
  let server: MmsProtocolServer
  let client: LocalMmsClient

  beforeEach(async () => {
    f = gitFoundationFixture()
    git(f.repo, 'config', 'core.hooksPath', join(f.root, 'no-hooks'))
    git(f.repo, 'config', 'commit.gpgsign', 'false')
    mms = await MousseMainService.create({ homeDir: f.home, headless: true, ownerKind: 'test' })
    await mms.start()
    const ownerToken = mms.getOwnerLease()!.owner.token
    server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
    const endpoint = await server.start()
    client = new LocalMmsClient({ homeDir: f.home, endpoint, ownerToken, clientType: 'gui' })
    await client.connect()
  }, 30_000)
  afterEach(async () => {
    await client?.close()
    await server?.stop()
    await mms?.stop()
    f?.dispose()
  })

  /** A merge of `side` into the checked-out branch of `cwd` that stops on value.txt. */
  const stoppedMerge = (cwd: string): void => {
    const back = git(cwd, 'branch', '--show-current')
    git(cwd, 'checkout', '-q', '-b', 'side'); writeFileSync(join(cwd, 'value.txt'), 'side\n'); git(cwd, 'commit', '-qam', 'side')
    git(cwd, 'checkout', '-q', back); writeFileSync(join(cwd, 'value.txt'), 'ours\n'); git(cwd, 'commit', '-qam', 'ours')
    expect(() => git(cwd, 'merge', '-q', '--no-edit', 'side')).toThrow()
  }

  it('in the person’s own checkout: the project keeps the copy and the result’s line names it', async () => {
    const project = mms.projects.openProject(f.repo)
    stoppedMerge(f.repo)
    writeFileSync(join(f.repo, 'value.txt'), 'resolved by hand\n')
    const result = await client.request<Aborted>('git.abortInProgress', { projectId: project.id, kind: 'merge' })
    expect(result.status.inProgress ?? null).toBeNull()
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('ours\n')
    const kept = result.kept!
    const top = git(f.repo, 'rev-parse', '--show-toplevel')
    expect(kept.notice).toBe(`Merge aborted. Your edits are kept for 30 days as ${kept.ref}. To bring a file back exactly as it was, run in ${top}: ${keptCopyRestoreCommand(kept.ref, 'value.txt', 'posix')} (value.txt had a conflict: its versions are kept as ${kept.ref}^3:stage-1/<path>, stage-2/<path> and stage-3/<path>).`)
    expect(threadPreservedIndex(projectKeptFilesOwner(mms.threads.lifecycleStore.profileHome, project.id)).owns(kept.ref)).toBe(true)
    restore({ ref: kept.ref, top }, 'value.txt')
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('resolved by hand\n')
  })

  it('in a project-folder thread: the abort is a recorded action of the person, with snapshots before and after, and the thread owns the copy', async () => {
    const project = mms.projects.openProject(f.repo)
    const thread = mms.threads.createThread('Folder thread', project.id, undefined, { worktreeEnabled: false })
    const directory = mms.threads.getThreadDir(thread.id)
    await client.request('git.status', { threadId: thread.id })
    stoppedMerge(f.repo)
    writeFileSync(join(f.repo, 'value.txt'), 'resolved by hand in the thread\n')

    const result = await client.request<Aborted>('git.abortInProgress', { threadId: thread.id, kind: 'merge' })
    const kept = result.kept!
    expect(threadPreservedIndex(directory).owns(kept.ref)).toBe(true)
    expect([...new ThreadJournal(directory).latestByOperation().values()].find((entry) => entry.operationType === 'git-abort')).toMatchObject({ state: 'completed' })
    const action = new ThreadActionService(directory).list().at(-1)!
    expect(action).toMatchObject({ actor: { kind: 'user' }, state: 'completed', externalEffects: [expect.objectContaining({ description: 'Aborted the merge' })] })
    // The snapshot before has the resolution, the one after Git's abort has the branch's version.
    expect(git(f.repo, 'show', `${action.startSha}:value.txt`)).toBe('resolved by hand in the thread')
    expect(git(f.repo, 'show', `${action.endSha}:value.txt`)).toBe('ours')
    restore({ ref: kept.ref, top: git(f.repo, 'rev-parse', '--show-toplevel') }, 'value.txt')
    expect(readFileSync(join(f.repo, 'value.txt'), 'utf8')).toBe('resolved by hand in the thread\n')
  })
})
