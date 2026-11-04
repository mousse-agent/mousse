/**
 * A kept copy runs no filter driver (`keepCopy` under `withDrivers`). A file whose index entry is racily clean is read
 * again by any Git command that writes the private index, which ran the clean driver on it; now none runs, and the copy
 * holds the file's raw bytes. Every check reads the kept bytes back and compares them.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { abortKeepingCopy } from '../src/mms/actions/abortKeepingCopy'
import { discardPendingChangesAsync, gitAsync, guardedAsync } from '../src/mms/actions/git'
import { KEEP_COPY_LIMITS, KeepCopyTooLargeError, keepCopy, keptCopyRestoreCommand, type KeptCopy } from '../src/mms/actions/keptCopies'
import { withDrivers } from '../src/mms/git/gitEnv'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'
import { ownedHome } from './support/fixtureGit'
import { pressed } from './support/userRequest'

const roots: string[] = []
const owned: Array<() => void> = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const blob = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
const blobId = (bytes: Buffer | string): string => { const data = Buffer.from(bytes); return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') }
const hasObject = (cwd: string, id: string): boolean => { try { git(cwd, 'cat-file', '-e', id); return true } catch { return false } }

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  vi.stubEnv('MOUSSE_GIT_POLICY', 'refuse')
})
afterEach(() => {
  vi.unstubAllEnvs()
  KEEP_COPY_LIMITS.bytes = 2 * 1024 ** 3
  for (const undo of owned.splice(0)) undo()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A repository whose user config (global, so trusted) defines `filters`, each logging every run to `log`. `clean` and
 * `smudge` are shell bodies that read stdin and write stdout; a driver left out is not configured.
 */
function fixture(filters: Record<string, { clean?: string; smudge?: string }>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-kept-no-driver-')))
  roots.push(root)
  const cwd = join(root, 'repo'), owner = join(root, 'owner'), log = join(root, 'driver.log'), config = join(root, 'gitconfig')
  mkdirSync(cwd); mkdirSync(owner)
  let text = ''
  for (const [name, drivers] of Object.entries(filters)) {
    text += `[filter "${name}"]\n`
    for (const kind of ['clean', 'smudge'] as const) {
      if (drivers[kind] === undefined) continue
      const script = join(root, `${name}-${kind}.sh`)
      writeFileSync(script, `#!/bin/sh\nprintf '${name} ${kind}\\n' >> '${log}'\n${drivers[kind]}\n`, { mode: 0o755 })
      text += `\t${kind} = ${script}\n`
    }
    text += '\trequired = true\n'
  }
  writeFileSync(config, text)
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  git(cwd, 'init', '-q', '-b', 'main')
  for (const [key, value] of Object.entries({ 'user.name': 'Test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'core.hooksPath': '/dev/null' })) git(cwd, 'config', key, value)
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  const runs = (): string[] => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  const clear = (): void => rmSync(log, { force: true })
  return { root, cwd, owner, log, runs, clear }
}

/**
 * Makes the index entry of each of `paths` racily clean: the file and the index are given the same whole second, so Git
 * cannot trust the entry's times and reads the file again (running its clean driver, when one runs) to compare it.
 */
function racilyClean(cwd: string, ...paths: string[]): void {
  const second = Math.floor(Date.now() / 1000) - 120
  for (const path of paths) utimesSync(join(cwd, path), second, second)
  // Exits 1 while another file has changes; the entries of `paths` are refreshed either way.
  try { git(cwd, 'update-index', '-q', '--refresh') } catch { /* other files changed */ }
  utimesSync(join(cwd, '.git', 'index'), second, second)
  for (const path of paths) expect(statSync(join(cwd, path)).mtimeMs).toBe(statSync(join(cwd, '.git', 'index')).mtimeMs)
}

/** Runs the command a kept copy's notice shows for `path` and reads the bytes it wrote. */
function restored(kept: Pick<KeptCopy, 'ref' | 'top'>, path: string): Buffer {
  rmSync(join(kept.top, path), { force: true })
  execFileSync('sh', ['-c', keptCopyRestoreCommand(kept.ref, path, 'posix')], { cwd: kept.top })
  return readFileSync(join(kept.top, path))
}

/** A clean driver that writes the file in capitals: Git stores `HELLO` for `hello` on disk. */
const SHOUT = { clean: "tr 'a-z' 'A-Z'" }

describe('a kept copy runs no filter driver', () => {
  for (const [name, scope] of [['with paths', { paths: ['shout.txt', 'base.txt'] }], ['of the whole tree', {}]] as const) {
    it(`a racily clean file under a logging clean driver: no run, and the copy holds its raw bytes (${name})`, async () => {
      const f = fixture({ log: SHOUT })
      writeFileSync(join(f.cwd, '.gitattributes'), 'shout.txt filter=log\n'); writeFileSync(join(f.cwd, 'shout.txt'), 'hello\n')
      git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'base')
      expect(git(f.cwd, 'cat-file', 'blob', 'HEAD:shout.txt')).toBe('HELLO')
      writeFileSync(join(f.cwd, 'base.txt'), 'edited\n')
      racilyClean(f.cwd, 'shout.txt')
      f.clear()
      const kept = await keepCopy({ owner: f.owner, top: f.cwd, operationType: 'git-discard', action: 'Discard', ...scope })
      expect(f.runs()).toEqual([])
      // Git's form of it is `HELLO`; the copy holds what was on disk.
      expect(blob(f.cwd, kept.ref, 'shout.txt').toString()).toBe('hello\n')
      expect(git(f.cwd, 'rev-parse', `${kept.ref}:shout.txt`)).toBe(blobId('hello\n'))
      expect(blob(f.cwd, kept.ref, 'base.txt').toString()).toBe('edited\n')
      expect(restored(kept, 'shout.txt').toString()).toBe('hello\n')
      expect(f.runs()).toEqual([])
    })
  }

  it('the repository\'s own config naming the same filter does not bring the user\'s driver back', async () => {
    const f = fixture({ log: SHOUT })
    writeFileSync(join(f.cwd, '.gitattributes'), 'shout.txt filter=log\n'); writeFileSync(join(f.cwd, 'shout.txt'), 'hello\n')
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'base')
    racilyClean(f.cwd, 'shout.txt')
    // The central check answers a repository's own driver with the user's value for it, as a `-c` setting.
    const planted = join(f.root, 'planted'), plantedScript = join(f.root, 'planted.sh')
    writeFileSync(plantedScript, `#!/bin/sh\nprintf planted >> '${planted}'\ncat\n`, { mode: 0o755 })
    git(f.cwd, 'config', 'filter.log.clean', plantedScript)
    // Read once outside the copy, as the status poll does: the check's answer is then cached for the folder.
    await gitAsync(f.cwd, ['rev-parse', 'HEAD'])
    f.clear()
    const kept = await keepCopy({ owner: f.owner, top: f.cwd, operationType: 'git-discard', action: 'Discard', paths: ['shout.txt'] })
    expect(f.runs()).toEqual([])
    expect(existsSync(planted)).toBe(false)
    expect(blob(f.cwd, kept.ref, 'shout.txt').toString()).toBe('hello\n')
  })

  it('a process driver the central check puts back for the repository\'s own config stays off', async () => {
    const f = fixture({})
    // `git lfs install` globally and again with `--local`: the repository's entry is answered with the user's value.
    for (const scope of ['--global', '--local']) git(f.cwd, 'config', scope, 'filter.lfs.process', 'git-lfs filter-process')
    await gitAsync(f.cwd, ['rev-parse', 'HEAD^{tree}']).catch(() => undefined)
    const settings = (argv: string[]): string[] => argv.flatMap((arg, index) => argv[index - 1] === '-c' && arg.startsWith('filter.lfs.process=') ? [arg] : [])
    expect(settings(await guardedAsync(f.cwd, ['ls-files']))).toEqual(['filter.lfs.process=git-lfs filter-process'])
    // Git takes the last value given: under `withDrivers` it is the emptied one.
    const off = await withDrivers(false, f.cwd, () => guardedAsync(f.cwd, ['ls-files']))
    expect(settings(off).at(-1)).toBe('filter.lfs.process=')
  })
})

describe('a racily clean file under a Git LFS-style driver', () => {
  const MEDIA = 'real media bytes 7d1f\n'
  const media = () => {
    const f = fixture({ media: { clean: 'cat >/dev/null; printf "pointer\\n"', smudge: `cat >/dev/null; printf '${MEDIA.replace('\n', '\\n')}'` } })
    writeFileSync(join(f.cwd, '.gitattributes'), 'media.dat filter=media\n'); writeFileSync(join(f.cwd, 'media.dat'), MEDIA)
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'media')
    expect(git(f.cwd, 'cat-file', 'blob', 'HEAD:media.dat')).toBe('pointer')
    writeFileSync(join(f.cwd, 'base.txt'), 'edited\n')
    racilyClean(f.cwd, 'media.dat')
    f.clear()
    return f
  }

  it('in a checkout that runs its drivers puts no raw media object into the store: Git\'s form holds it', async () => {
    const f = media()
    const kept = await keepCopy({ owner: f.owner, top: f.cwd, operationType: 'git-discard', action: 'Discard' })
    // The smudge answers what Git writes back, as a restore asks; the clean never runs.
    expect(f.runs().filter((line) => line.endsWith('clean'))).toEqual([])
    expect(hasObject(f.cwd, blobId(MEDIA))).toBe(false)
    expect(git(f.cwd, 'rev-parse', `${kept.ref}:media.dat`)).toBe(git(f.cwd, 'rev-parse', 'HEAD:media.dat'))
    expect(blob(f.cwd, kept.ref, 'base.txt').toString()).toBe('edited\n')
    // The copy names it as no kept file; what Git writes from the copy's version of it is the media file, byte for byte.
    expect(kept.digests.has('media.dat')).toBe(false)
    expect(execFileSync('git', ['cat-file', '--filters', `${kept.ref}:media.dat`], { cwd: f.cwd }).toString()).toBe(MEDIA)
  })

  it('in a checkout no driver may run in, copies it raw and runs nothing', async () => {
    const f = media()
    const kept = await keepCopy({ owner: f.owner, top: f.cwd, operationType: 'worktree-cleanup', action: 'Cleanup', filters: false })
    expect(f.runs()).toEqual([])
    expect(blob(f.cwd, kept.ref, 'media.dat').toString()).toBe(MEDIA)
    rmSync(join(f.cwd, '.gitattributes'))
    expect(restored(kept, 'media.dat').toString()).toBe(MEDIA)
  })

  it('in a checkout no driver may run in, refuses over the limit and names the file, writing nothing', async () => {
    const f = media()
    KEEP_COPY_LIMITS.bytes = 12
    const refs = git(f.cwd, 'for-each-ref', 'refs/mousse/')
    const error = await keepCopy({ owner: f.owner, top: f.cwd, operationType: 'worktree-cleanup', action: 'Cleanup', filters: false }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(KeepCopyTooLargeError)
    expect((error as KeepCopyTooLargeError).paths).toContain('media.dat')
    expect((error as Error).message).toMatch(/media\.dat/)
    expect(git(f.cwd, 'for-each-ref', 'refs/mousse/')).toBe(refs)
    expect(hasObject(f.cwd, blobId(MEDIA))).toBe(false)
    expect(f.runs()).toEqual([])
  })
})

describe('Discard and Abort keep their copy without a driver', () => {
  it('Discard: the copy runs no driver, and the discarded edit comes back byte for byte', async () => {
    const f = fixture({ log: SHOUT })
    writeFileSync(join(f.cwd, '.gitattributes'), 'shout.txt filter=log\n'); writeFileSync(join(f.cwd, 'shout.txt'), 'hello\n')
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'base')
    writeFileSync(join(f.cwd, 'base.txt'), 'my edit 41c0\r\n')
    racilyClean(f.cwd, 'shout.txt')
    let during: string[] | undefined
    const kept = await pressed('Discard changes', () => discardPendingChangesAsync(f.cwd, async (top, scope) => {
      f.clear()
      const copy = await keepCopy({ owner: f.owner, top, operationType: 'git-discard', action: 'Discard', ...scope })
      during = f.runs()
      return copy
    }))
    expect(during).toEqual([])
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(restored(kept, 'base.txt').toString()).toBe('my edit 41c0\r\n')
  })

  it('Abort: the copy runs no driver before Git aborts, and the hand resolution comes back byte for byte', async () => {
    const f = fixture({ log: SHOUT })
    writeFileSync(join(f.cwd, '.gitattributes'), 'shout.txt filter=log\n'); writeFileSync(join(f.cwd, 'shout.txt'), 'hello\n')
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'base')
    git(f.cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(f.cwd, 'base.txt'), 'feature\n'); git(f.cwd, 'commit', '-qam', 'feature')
    git(f.cwd, 'checkout', '-q', 'main'); writeFileSync(join(f.cwd, 'base.txt'), 'main\n'); git(f.cwd, 'commit', '-qam', 'main')
    expect(() => git(f.cwd, 'merge', 'feature')).toThrow()
    writeFileSync(join(f.cwd, 'base.txt'), 'hand resolution 9e2a\n')
    racilyClean(f.cwd, 'shout.txt')
    f.clear()
    let before: string[] | undefined
    const kept = (await pressed('Abort', () => abortKeepingCopy({ top: f.cwd, owner: f.owner, kind: 'merge', action: 'Abort', abort: async (beforeStart) => {
      before = f.runs()
      beforeStart()
      git(f.cwd, 'merge', '--abort')
    } })))!
    expect(before).toEqual([])
    expect(readFileSync(join(f.cwd, 'base.txt'), 'utf8')).toBe('main\n')
    expect(restored(kept, 'base.txt').toString()).toBe('hand resolution 9e2a\n')
  })
})

describe('a dispatch\'s cleanup copies a filtered file raw', () => {
  it('cleans up a worktree whose filtered file Git cannot write back without its driver, and the copy restores it', async () => {
    const f = fixture({ probe: { clean: 'cat', smudge: 'cat' } })
    const home = join(f.root, 'home'); mkdirSync(home)
    owned.push(ownedHome(home))
    // Checked out with no driver, `eol=crlf` still writes CRLF: Git's form of the file needs the driver, so the
    // cleanup cannot prove it held by its blob and keeps a copy of its raw bytes.
    writeFileSync(join(f.cwd, '.gitattributes'), 'notes.txt filter=probe eol=crlf\n'); writeFileSync(join(f.cwd, 'notes.txt'), 'line one\nline two\n')
    git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'notes')
    const manager = new WorktreeManager(f.cwd, home)
    f.clear()
    const info = await manager.createWorktree('dispatch-filtered', f.cwd, undefined, undefined, { safeCheckout: true })
    const crlf = Buffer.from('line one\r\nline two\r\n')
    expect(readFileSync(join(info.path, 'notes.txt')).equals(crlf)).toBe(true)
    const result = await manager.cleanupValidatedAgentWorktree(info, { safeCheckout: true, keepIgnored: { owner: f.owner } })
    expect(result).toMatchObject({ success: true })
    expect(existsSync(info.path)).toBe(false)
    expect(f.runs()).toEqual([])
    expect(blob(f.cwd, result.copy!.ref, 'notes.txt').equals(crlf)).toBe(true)
    // Restored by the command its notice shows, in the repository the copy is in.
    expect(restored({ ref: result.copy!.ref, top: f.cwd }, 'notes.txt').equals(crlf)).toBe(true)
  })
})
