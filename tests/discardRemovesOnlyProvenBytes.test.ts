import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discardPendingChangesAsync } from '../src/mms/actions/git'
import { keepCopy } from '../src/mms/actions/keptCopies'
import { leftAsItIsText } from '../src/mms/actions/provenDiscard'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { pressed } from './support/userRequest'

/**
 * Discard removes only bytes its kept copy proves it holds, and Git only creates. Every preservation check brings the
 * kept version back from the copy and compares its bytes.
 */

const USER = userAction('button', 'Discard changes')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const scratch = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** A kept file's bytes, exactly as the copy holds them. */
const keptBytes = (cwd: string, ref: string, path: string): Buffer => execFileSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd })

function repo(): string {
  const cwd = scratch('mousse-proven-discard-')
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Discard fixture'); git(cwd, 'config', 'user.email', 'discard@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  writeFileSync(join(cwd, 'base.txt'), 'base\n'); writeFileSync(join(cwd, 'other.txt'), 'other\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'base')
  return git(cwd, 'rev-parse', '--show-toplevel')
}
const owner = () => ({ owner: scratch('mousse-proven-owner-') })
const keepPending = (journal: string) => (top: string, scope: { paths: string[]; writes: string[] }) =>
  keepCopy({ owner: journal, top, operationType: 'git-discard', action: 'Discard', ...scope })

/** A `git` first on PATH that runs `script` (sh) when its arguments contain `match`, then the real Git. */
function gitShim(match: string, script: string): () => void {
  const bin = scratch('mousse-proven-bin-')
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  *" ${match} "*) ${script} ;;\nesac\nexec "${real}" "$@"\n`, { mode: 0o755 })
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  return () => { process.env.PATH = previous }
}

describe('Git panel Discard removes only proven bytes', () => {
  it('a save after the copy was read stays on disk, keeps its staged version, and is named; the copy holds the bytes it read (N3B)', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'staged bytes\n'); git(cwd, 'add', 'base.txt')
    writeFileSync(join(cwd, 'base.txt'), 'old working bytes kept\n')
    writeFileSync(join(cwd, 'other.txt'), 'other edit\n')
    const late = 'save after copy completed 43e2b02f\n'
    // The copy's pack goes in after every file was read: a save then lands after the copy.
    const restore = gitShim('index-pack', `printf '%s' '${late}' > '${cwd}/base.txt'`)
    let kept
    try { kept = await new GitService().discard(cwd, USER, ['base.txt', 'other.txt'], owner()) } finally { restore() }
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(late)
    expect(git(cwd, 'show', ':base.txt')).toBe('staged bytes')
    expect(keptBytes(cwd, kept!.ref, 'base.txt').toString()).toBe('old working bytes kept\n')
    // The other path went back to HEAD.
    expect(readFileSync(join(cwd, 'other.txt'), 'utf8')).toBe('other\n')
    expect(git(cwd, 'diff', '--cached', '--name-only', '--', 'other.txt')).toBe('')
    expect(kept!.left).toEqual([{ path: 'base.txt', changed: 'base.txt' }])
    expect(leftAsItIsText(kept!.left)).toBe('base.txt changed after you pressed Discard, so it was left as it is.')
  })

  it('a save right before the unlink, after the file was proven, stays: the last check is synchronous', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'working bytes\n')
    const late = 'saved right before the unlink\n'
    const service = new GitService({ beforeDiscardUnlink: (path) => { if (path.endsWith('base.txt')) writeFileSync(path, late) } })
    const kept = await service.discard(cwd, USER, ['base.txt'], owner())
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(late)
    expect(keptBytes(cwd, kept!.ref, 'base.txt').toString()).toBe('working bytes\n')
    expect(kept!.left.map((item) => item.path)).toEqual(['base.txt'])
  })

  it('a file saved again after the unlink is not overwritten by Git', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'working bytes\n')
    const recreated = 'recreated after the unlink\n'
    const restore = gitShim('checkout-index', `printf '%s' '${recreated}' > '${cwd}/base.txt'`)
    let kept
    try { kept = await new GitService().discard(cwd, USER, ['base.txt'], owner()) } finally { restore() }
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(recreated)
    expect(keptBytes(cwd, kept!.ref, 'base.txt').toString()).toBe('working bytes\n')
    expect(kept!.left.map((item) => item.path)).toEqual(['base.txt'])
  })

  it('a folder in the way that gains a file is left whole, and the other paths are still discarded', async () => {
    const cwd = repo()
    rmSync(join(cwd, 'base.txt')); mkdirSync(join(cwd, 'base.txt'))
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'base.txt/\n')
    const ignored = 'sole ignored bytes 71b9c18e\n'
    writeFileSync(join(cwd, 'base.txt', 'private.bin'), ignored)
    writeFileSync(join(cwd, 'other.txt'), 'other edit\n'); writeFileSync(join(cwd, 'loose.txt'), 'untracked\n')
    const late = 'written into the folder meanwhile\n'
    const service = new GitService({ beforeDiscardUnlink: (path) => { if (path.endsWith('private.bin')) writeFileSync(join(cwd, 'base.txt', 'late.bin'), late) } })
    const kept = await service.discard(cwd, USER, ['base.txt', 'other.txt', 'loose.txt'], owner())
    expect(readFileSync(join(cwd, 'base.txt', 'late.bin'), 'utf8')).toBe(late)
    expect(lstatSync(join(cwd, 'base.txt')).isDirectory()).toBe(true)
    // Proven before the folder changed, the ignored file went; the copy holds it.
    expect(keptBytes(cwd, kept!.ref, 'base.txt/private.bin').toString()).toBe(ignored)
    expect(readFileSync(join(cwd, 'other.txt'), 'utf8')).toBe('other\n')
    expect(existsSync(join(cwd, 'loose.txt'))).toBe(false)
    expect(keptBytes(cwd, kept!.ref, 'loose.txt').toString()).toBe('untracked\n')
    expect(kept!.left).toEqual([{ path: 'base.txt', changed: 'base.txt' }])
  })

  it('a file in the way of a folder that changed leaves every path below it, and only those', async () => {
    const cwd = repo()
    mkdirSync(join(cwd, 'docs')); writeFileSync(join(cwd, 'docs', 'a.txt'), 'a\n'); writeFileSync(join(cwd, 'docs', 'b.txt'), 'b\n')
    git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'docs')
    rmSync(join(cwd, 'docs'), { recursive: true }); writeFileSync(join(cwd, 'docs'), 'a file where the folder was\n')
    writeFileSync(join(cwd, 'other.txt'), 'other edit\n')
    const late = 'the file in the way, saved again\n'
    const restore = gitShim('index-pack', `printf '%s' '${late}' > '${cwd}/docs'`)
    let kept
    try { kept = await new GitService().discard(cwd, USER, ['docs/a.txt', 'docs/b.txt', 'other.txt'], owner()) } finally { restore() }
    expect(readFileSync(join(cwd, 'docs'), 'utf8')).toBe(late)
    expect(readFileSync(join(cwd, 'other.txt'), 'utf8')).toBe('other\n')
    expect(kept!.left.map((item) => item.path).sort()).toEqual(['docs/a.txt', 'docs/b.txt'])
    expect(kept!.left.every((item) => item.changed === 'docs')).toBe(true)
    expect(keptBytes(cwd, kept!.ref, 'docs').toString()).toBe('a file where the folder was\n')
    expect(leftAsItIsText(kept!.left)).toBe('docs/a.txt and docs/b.txt changed after you pressed Discard, so they were left as they are.')
  })

  it('a hard-linked file is discarded: its other name keeps the bytes', async () => {
    const cwd = repo(), elsewhere = scratch('mousse-proven-link-')
    writeFileSync(join(cwd, 'base.txt'), 'shared bytes\n')
    linkSync(join(cwd, 'base.txt'), join(elsewhere, 'twin.txt'))
    const kept = await new GitService().discard(cwd, USER, ['base.txt'], owner())
    expect(kept!.left).toEqual([])
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(readFileSync(join(elsewhere, 'twin.txt'), 'utf8')).toBe('shared bytes\n')
  })

  it('writes back line endings, an executable bit and a link exactly as git restore does', async () => {
    const make = () => {
      const cwd = repo()
      writeFileSync(join(cwd, '.gitattributes'), 'crlf.txt text eol=crlf\n')
      writeFileSync(join(cwd, 'crlf.txt'), 'one\ntwo\n'); writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(cwd, 'run.sh'), 0o755)
      symlinkSync('base.txt', join(cwd, 'link'))
      git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'kinds')
      writeFileSync(join(cwd, 'crlf.txt'), 'edited\n'); chmodSync(join(cwd, 'run.sh'), 0o644); writeFileSync(join(cwd, 'run.sh'), 'edited\n')
      unlinkSync(join(cwd, 'link')); symlinkSync('other.txt', join(cwd, 'link'))
      return cwd
    }
    const viaRestore = make(), viaDiscard = make()
    git(viaRestore, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'crlf.txt', 'run.sh', 'link')
    const kept = await new GitService().discard(viaDiscard, USER, ['crlf.txt', 'run.sh', 'link'], owner())
    expect(kept!.left).toEqual([])
    for (const path of ['crlf.txt', 'run.sh']) {
      expect(readFileSync(join(viaDiscard, path))).toEqual(readFileSync(join(viaRestore, path)))
      expect(lstatSync(join(viaDiscard, path)).mode).toBe(lstatSync(join(viaRestore, path)).mode)
    }
    expect(readFileSync(join(viaDiscard, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
    expect(readlinkSync(join(viaDiscard, 'link'))).toBe(readlinkSync(join(viaRestore, 'link')))
    expect(git(viaDiscard, 'status', '--porcelain')).toBe('')
    // The kept link is a link, with its target as its bytes.
    expect(keptBytes(viaDiscard, kept!.ref, 'link').toString()).toBe('other.txt')
  })
})

describe('pending-changes Discard removes only proven bytes', () => {
  it('a save after the copy stays, keeps its staged version, and the unfinished merge stays with it', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); git(cwd, 'commit', '-q', '-am', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-q', '-am', 'main')
    expect(() => git(cwd, 'merge', 'feature')).toThrow()
    writeFileSync(join(cwd, 'other.txt'), 'other edit\n'); git(cwd, 'add', 'other.txt')
    const conflicted = readFileSync(join(cwd, 'base.txt'))
    const stagesBefore = git(cwd, 'ls-files', '-s', '--', 'base.txt')
    const late = 'manual resolution saved after the copy\n'
    const journal = scratch('mousse-proven-owner-')
    const kept = await pressed('Discard changes', () => discardPendingChangesAsync(cwd, async (top, scope) => {
      const copy = await keepPending(journal)(top, scope)
      writeFileSync(join(cwd, 'base.txt'), late)
      return copy
    }))
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(late)
    expect(git(cwd, 'ls-files', '-s', '--', 'base.txt')).toBe(stagesBefore)
    expect(keptBytes(cwd, kept.ref, 'base.txt')).toEqual(conflicted)
    expect(readFileSync(join(cwd, 'other.txt'), 'utf8')).toBe('other\n')
    expect(git(cwd, 'diff', '--cached', '--name-only', '--', 'other.txt')).toBe('')
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(kept.left.map((item) => item.path)).toEqual(['base.txt'])
  })

  it('ends a merge: MERGE_HEAD goes, the files are HEAD\'s, and the copy holds the conflict', async () => {
    const cwd = repo()
    git(cwd, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(cwd, 'base.txt'), 'feature\n'); writeFileSync(join(cwd, 'added.txt'), 'from feature\n')
    git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'feature')
    git(cwd, 'checkout', '-q', 'main'); writeFileSync(join(cwd, 'base.txt'), 'main\n'); git(cwd, 'commit', '-q', '-am', 'main')
    expect(() => git(cwd, 'merge', 'feature')).toThrow()
    writeFileSync(join(cwd, 'loose.txt'), 'untracked\n')
    const conflicted = readFileSync(join(cwd, 'base.txt'))
    const kept = await pressed('Discard changes', () => discardPendingChangesAsync(cwd, keepPending(scratch('mousse-proven-owner-'))))
    expect(kept.left).toEqual([])
    expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('main\n')
    expect(existsSync(join(cwd, 'added.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'loose.txt'))).toBe(false)
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(keptBytes(cwd, kept.ref, 'base.txt')).toEqual(conflicted)
    expect(keptBytes(cwd, kept.ref, 'added.txt').toString()).toBe('from feature\n')
    expect(keptBytes(cwd, kept.ref, 'loose.txt').toString()).toBe('untracked\n')
  })

  it('a staged-only change and an ignored folder in the way are kept and proven, then discarded', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'other.txt'), 'staged only\n'); git(cwd, 'add', 'other.txt')
    rmSync(join(cwd, 'base.txt')); mkdirSync(join(cwd, 'base.txt'))
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'base.txt/\n')
    const ignored = 'sole ignored pending bytes fde7c221\n'
    writeFileSync(join(cwd, 'base.txt', 'private.bin'), ignored)
    const kept = await pressed('Discard changes', () => discardPendingChangesAsync(cwd, keepPending(scratch('mousse-proven-owner-'))))
    expect(kept.left).toEqual([])
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe('base\n')
    expect(readFileSync(join(cwd, 'other.txt'), 'utf8')).toBe('other\n')
    expect(keptBytes(cwd, kept.ref, 'base.txt/private.bin').toString()).toBe(ignored)
    expect(keptBytes(cwd, kept.ref, 'other.txt').toString()).toBe('staged only\n')
  })

  it('a file saved again after the unlink is not overwritten, and the workspace says so instead of failing', async () => {
    const cwd = repo()
    writeFileSync(join(cwd, 'base.txt'), 'working bytes\n')
    const recreated = 'recreated after the unlink\n'
    const restore = gitShim('checkout-index', `printf '%s' '${recreated}' > '${cwd}/base.txt'`)
    let kept
    try { kept = await pressed('Discard changes', () => discardPendingChangesAsync(cwd, keepPending(scratch('mousse-proven-owner-')))) } finally { restore() }
    expect(readFileSync(join(cwd, 'base.txt'), 'utf8')).toBe(recreated)
    expect(keptBytes(cwd, kept.ref, 'base.txt').toString()).toBe('working bytes\n')
    expect(kept.left.map((item) => item.path)).toEqual(['base.txt'])
  })

  it('writes back line endings, an executable bit and a link exactly as reset --hard does', async () => {
    const make = () => {
      const cwd = repo()
      writeFileSync(join(cwd, '.gitattributes'), 'crlf.txt text eol=crlf\n')
      writeFileSync(join(cwd, 'crlf.txt'), 'one\ntwo\n'); writeFileSync(join(cwd, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(cwd, 'run.sh'), 0o755)
      symlinkSync('base.txt', join(cwd, 'link'))
      git(cwd, 'add', '.'); git(cwd, 'commit', '-q', '-m', 'kinds')
      writeFileSync(join(cwd, 'crlf.txt'), 'edited\n'); chmodSync(join(cwd, 'run.sh'), 0o644)
      unlinkSync(join(cwd, 'link')); symlinkSync('other.txt', join(cwd, 'link'))
      return cwd
    }
    const viaReset = make(), viaDiscard = make()
    git(viaReset, 'reset', '--hard', '-q', 'HEAD')
    const kept = await pressed('Discard changes', () => discardPendingChangesAsync(viaDiscard, keepPending(scratch('mousse-proven-owner-'))))
    expect(kept.left).toEqual([])
    for (const path of ['crlf.txt', 'run.sh']) {
      expect(readFileSync(join(viaDiscard, path))).toEqual(readFileSync(join(viaReset, path)))
      expect(lstatSync(join(viaDiscard, path)).mode).toBe(lstatSync(join(viaReset, path)).mode)
    }
    expect(readlinkSync(join(viaDiscard, 'link'))).toBe(readlinkSync(join(viaReset, 'link')))
    expect(git(viaDiscard, 'status', '--porcelain')).toBe('')
  })
})

describe('the line naming what was left', () => {
  it('names up to three paths, then counts the rest', () => {
    expect(leftAsItIsText([])).toBeUndefined()
    expect(leftAsItIsText([{ path: 'a', changed: 'a' }, { path: 'b', changed: 'b' }, { path: 'c', changed: 'c' }, { path: 'd', changed: 'd' }, { path: 'e', changed: 'e' }]))
      .toBe('a, b, c and 2 more changed after you pressed Discard, so they were left as they are.')
  })
})
