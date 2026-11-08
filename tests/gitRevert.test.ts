import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keptFilesFromListing, PRESERVED_REF_FORMAT, threadPreservedRefs } from '../src/mms/actions/preservedFiles'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import type { SelectionPlace } from '../src/mms/git/gitSelection'
import type { GitChangedFile, GitChangesResult, GitRevertResult } from '../src/shared/types'
import { committedGitTemplate } from './support/gitBase'

// A seam right after the copy is kept and before anything is written: a save that lands there must win.
const seam = vi.hoisted(() => ({ afterKeep: undefined as undefined | (() => void) }))
vi.mock('../src/mms/actions/keptCopies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mms/actions/keptCopies')>()
  return {
    ...actual,
    keepCopy: async (...args: Parameters<typeof actual.keepCopy>) => {
      const kept = await actual.keepCopy(...args)
      seam.afterKeep?.()
      return kept
    }
  }
})

const USER = userAction('button', 'Test action')
const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
const text = (lines: string[], eol = '\n') => lines.map((line) => `${line}${eol}`).join('')
const changed = (at: readonly number[], eol = '\n') => text(LINES.map((line, index) => (at.includes(index + 1) ? `line ${index + 1} changed` : line)), eol)

const copyBase = committedGitTemplate((cwd) => {
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Revert fixture'); git(cwd, 'config', 'user.email', 'revert@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  git(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(cwd, 'a.txt'), text(LINES)); writeFileSync(join(cwd, 'b.txt'), 'b\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'baseline')
})
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-revert-')); roots.push(cwd)
  copyBase(cwd)
  git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  return cwd
}
const folder = () => { const dir = mkdtempSync(join(tmpdir(), 'mousse-revert-owner-')); roots.push(dir); return dir }
const projectPlace = (): Extract<SelectionPlace, { kind: 'project' }> => { const dir = folder(); return { kind: 'project', markerFile: join(dir, 'marker.json'), keepOwner: dir } }
const threadPlace = (): Extract<SelectionPlace, { kind: 'thread' }> => ({ kind: 'thread', overlayFile: join(folder(), 'git-selection.json') })
afterEach(() => {
  seam.afterKeep = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const service = new GitService()
const fileIn = (result: GitChangesResult, path: string): GitChangedFile => {
  const found = result.files.find((file) => file.path === path)
  if (!found) throw new Error(`${path} is not listed: ${result.files.map((file) => file.path).join(', ')}`)
  return found
}
const listed = async (cwd: string, place: SelectionPlace, path: string) => fileIn(await service.readChanges(cwd, place), path)
const read = (cwd: string, path: string) => readFileSync(join(cwd, path), 'utf8')
const staged = (cwd: string, path: string) => git(cwd, 'show', `:${path}`)
const keptRefs = (cwd: string) => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)

describe('revert in a project folder', () => {
  it('reverts one hunk, leaves an untouched index alone, lists it, and restores it once', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const a = await listed(cwd, place, 'a.txt')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
    expect(read(cwd, 'a.txt')).toBe(changed([25]))
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('')
    expect(done).toMatchObject({ path: 'a.txt', version: (await listed(cwd, place, 'a.txt')).version })
    expect(done.keptUntil).toBeGreaterThan(Date.now() + 24 * 3600_000)
    expect(await service.revertedList(cwd, owner)).toEqual([{ revertId: done.revertId, path: 'a.txt', at: expect.any(Number), keptUntil: done.keptUntil, summary: '1 hunk of a.txt' }])

    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect(read(cwd, 'a.txt')).toBe(changed([3, 25]))
    expect(await service.revertedList(cwd, owner)).toEqual([])
    // A retry finds it already restored and writes nothing.
    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
  })

  it('takes the reverted hunk out of a chosen index too, and a restore brings the staged version back', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25])); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    let a = await listed(cwd, place, 'a.txt')
    // Leaving b.txt out makes the index the selection; a.txt stays wholly included.
    const b = await listed(cwd, place, 'b.txt')
    await service.include(cwd, USER, place, { path: 'b.txt', version: b.version, include: false })
    a = await listed(cwd, place, 'a.txt')
    expect(staged(cwd, 'a.txt')).toBe(changed([3, 25]).trimEnd())
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[1]!.id] }, { owner })
    expect(read(cwd, 'a.txt')).toBe(changed([3]))
    expect(staged(cwd, 'a.txt')).toBe(changed([3]).trimEnd())
    expect((await service.readChanges(cwd, place)).selection.state).toBe('chosen')
    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect(read(cwd, 'a.txt')).toBe(changed([3, 25]))
    expect(staged(cwd, 'a.txt')).toBe(changed([3, 25]).trimEnd())
    expect(staged(cwd, 'b.txt')).toBe('b')
  })

  it('reverts single lines: an added line goes, a removed line comes back', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), text([...LINES.slice(0, 2), 'x', 'y', ...LINES.slice(3)]))
    const a = await listed(cwd, place, 'a.txt')
    const y = a.hunks[0]!.lines.findIndex((line) => line.kind === '+' && line.text === 'y')
    const removed = a.hunks[0]!.lines.findIndex((line) => line.kind === '-')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, lines: [{ hunk: a.hunks[0]!.id, indexes: [y, removed] }] }, { owner })
    expect(read(cwd, 'a.txt')).toBe(text([...LINES.slice(0, 2), 'line 3', 'x', ...LINES.slice(3)]))
    expect((await service.revertedList(cwd, owner))[0]!.summary).toBe('2 lines of a.txt')
    await service.restoreReverted(cwd, USER, place, done.revertId, { owner })
    expect(read(cwd, 'a.txt')).toBe(text([...LINES.slice(0, 2), 'x', 'y', ...LINES.slice(3)]))
  })

  it('reverts whole files: a new file goes, a deleted file comes back, and every hunk of a file is the whole file', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'new.txt'), 'new\n'); unlinkSync(join(cwd, 'b.txt')); writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const added = await service.revert(cwd, USER, place, { path: 'new.txt', version: (await listed(cwd, place, 'new.txt')).version }, { owner })
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    const deleted = await service.revert(cwd, USER, place, { path: 'b.txt', version: (await listed(cwd, place, 'b.txt')).version }, { owner })
    expect(read(cwd, 'b.txt')).toBe('b\n')
    const a = await listed(cwd, place, 'a.txt')
    await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: a.hunks.map((hunk) => hunk.id) }, { owner })
    expect(read(cwd, 'a.txt')).toBe(text(LINES))
    expect(git(cwd, 'status', '--porcelain')).toBe('')

    expect(await service.restoreReverted(cwd, USER, place, added.revertId, { owner })).toEqual({ restored: true })
    expect(read(cwd, 'new.txt')).toBe('new\n')
    expect(await service.restoreReverted(cwd, USER, place, deleted.revertId, { owner })).toEqual({ restored: true })
    expect(existsSync(join(cwd, 'b.txt'))).toBe(false)
  })

  it('reverts a rename as one pair, and restores both paths with the staged rename', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    git(cwd, 'mv', 'a.txt', 'c.txt')
    const c = await listed(cwd, place, 'c.txt')
    expect(c).toMatchObject({ change: 'renamed', oldPath: 'a.txt' })
    const done = await service.revert(cwd, USER, place, { path: 'c.txt', version: c.version }, { owner })
    expect(existsSync(join(cwd, 'c.txt'))).toBe(false)
    expect(read(cwd, 'a.txt')).toBe(text(LINES))
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect((await service.revertedList(cwd, owner))[0]).toMatchObject({ path: 'c.txt', oldPath: 'a.txt', summary: 'a.txt → c.txt' })
    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
    expect(read(cwd, 'c.txt')).toBe(text(LINES))
    expect(git(cwd, 'diff', '--cached', '--name-status', '-M')).toMatch(/^R\d*\ta\.txt\tc\.txt$/)
  })

  it('reverts a binary file and a link only whole', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255])); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'binary')
    writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 255]))
    const bin = await listed(cwd, place, 'bin.dat')
    expect(bin).toMatchObject({ binary: true, wholeFileOnly: true })
    await expect(service.revert(cwd, USER, place, { path: 'bin.dat', version: bin.version, hunks: ['x'] }, { owner })).rejects.toMatchObject({ code: 'whole_file_only' })
    const done = await service.revert(cwd, USER, place, { path: 'bin.dat', version: bin.version }, { owner })
    expect(readFileSync(join(cwd, 'bin.dat'))).toEqual(Buffer.from([0, 1, 2, 3, 0, 255]))
    await service.restoreReverted(cwd, USER, place, done.revertId, { owner })
    expect(readFileSync(join(cwd, 'bin.dat'))).toEqual(Buffer.from([0, 9, 9, 9, 0, 255]))

    try { symlinkSync('b.txt', join(cwd, 'link')) } catch { return } // No links here (Windows without the right): the binary case stands.
    const link = await listed(cwd, place, 'link')
    expect(link).toMatchObject({ kind: 'symlink', wholeFileOnly: true })
    const linked = await service.revert(cwd, USER, place, { path: 'link', version: link.version }, { owner })
    expect(existsSync(join(cwd, 'link'))).toBe(false)
    await service.restoreReverted(cwd, USER, place, linked.revertId, { owner })
    expect(lstatSync(join(cwd, 'link')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(cwd, 'link'))).toBe('b.txt')
  })

  it('reverts a file under a filter only whole, the way Discard writes it back', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    git(cwd, 'config', 'filter.upper.clean', 'tr a-z A-Z'); git(cwd, 'config', 'filter.upper.smudge', 'tr A-Z a-z')
    writeFileSync(join(cwd, '.gitattributes'), 'filtered.txt filter=upper\n'); writeFileSync(join(cwd, 'filtered.txt'), text(LINES))
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'filtered')
    writeFileSync(join(cwd, 'filtered.txt'), changed([3, 25]))
    const file = await listed(cwd, place, 'filtered.txt')
    expect(file.wholeFileOnly).toBe(true)
    await expect(service.revert(cwd, USER, place, { path: 'filtered.txt', version: file.version, hunks: [file.hunks[0]?.id ?? 'x'] }, { owner })).rejects.toMatchObject({ code: 'whole_file_only' })
    expect(read(cwd, 'filtered.txt')).toBe(changed([3, 25]))
    await service.revert(cwd, USER, place, { path: 'filtered.txt', version: file.version }, { owner })
    expect(read(cwd, 'filtered.txt')).toBe(text(LINES))
    expect(git(cwd, 'status', '--porcelain')).toBe('')
  })

  it('keeps CRLF line endings Git converts (core.autocrlf, eol=crlf), and LF files in an autocrlf repository', async () => {
    for (const setup of ['autocrlf', 'attributes'] as const) {
      const cwd = repo(), place = projectPlace(), owner = folder()
      if (setup === 'autocrlf') git(cwd, 'config', 'core.autocrlf', 'true')
      else { writeFileSync(join(cwd, '.gitattributes'), 'a.txt text eol=crlf\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'attributes') }
      writeFileSync(join(cwd, 'a.txt'), changed([3, 25], '\r\n'))
      const a = await listed(cwd, place, 'a.txt')
      expect(a.hunks).toHaveLength(2)
      const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
      expect(readFileSync(join(cwd, 'a.txt'), 'latin1')).toBe(changed([25], '\r\n'))
      await service.restoreReverted(cwd, USER, place, done.revertId, { owner })
      expect(readFileSync(join(cwd, 'a.txt'), 'latin1')).toBe(changed([3, 25], '\r\n'))
    }
    // An agent wrote LF in a repository that checks out CRLF: the lines left alone keep LF.
    const cwd = repo(), place = projectPlace(), owner = folder()
    git(cwd, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const a = await listed(cwd, place, 'a.txt')
    await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[1]!.id] }, { owner })
    expect(readFileSync(join(cwd, 'a.txt'), 'latin1')).toBe(changed([3]))
  })

  it('reverts a hunk of a file committed with CRLF under core.autocrlf, as git add stores it (CRLF kept)', async () => {
    const stagedBytes = (cwd: string, path: string) => execFileSync('git', ['cat-file', 'blob', `:${path}`], { cwd, encoding: 'latin1' })
    for (const kind of ['project', 'thread'] as const) {
      const cwd = repo(), owner = folder()
      const place = kind === 'project' ? projectPlace() : threadPlace()
      // Committed while autocrlf was off, so the blob holds CRLF; then autocrlf is turned on, as in older Windows repositories.
      writeFileSync(join(cwd, 'c.txt'), text(LINES, '\r\n')); git(cwd, 'add', 'c.txt'); git(cwd, 'commit', '-qm', 'crlf')
      git(cwd, 'config', 'core.autocrlf', 'true')
      writeFileSync(join(cwd, 'c.txt'), changed([3, 25], '\r\n')); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
      if (kind === 'project') {
        // Leaving b.txt out makes the index the selection: c.txt is staged whole, with CRLF.
        await service.include(cwd, USER, place, { path: 'b.txt', version: (await listed(cwd, place, 'b.txt')).version, include: false })
        expect(stagedBytes(cwd, 'c.txt')).toBe(changed([3, 25], '\r\n'))
      }
      const c = await listed(cwd, place, 'c.txt')
      expect(c.hunks).toHaveLength(2)
      const done = await service.revert(cwd, USER, place, { path: 'c.txt', version: c.version, hunks: [c.hunks[0]!.id] }, { owner })
      expect(readFileSync(join(cwd, 'c.txt'), 'latin1')).toBe(changed([25], '\r\n'))
      // Git reads the file as one changed line, not every line changed.
      expect(git(cwd, 'diff', '--numstat', 'HEAD', '--', 'c.txt')).toBe('1\t1\tc.txt')
      expect((await listed(cwd, place, 'c.txt')).hunks).toHaveLength(1)
      if (kind === 'project') expect(stagedBytes(cwd, 'c.txt')).toBe(changed([25], '\r\n'))
      expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
      expect(readFileSync(join(cwd, 'c.txt'), 'latin1')).toBe(changed([3, 25], '\r\n'))
      if (kind === 'project') expect(stagedBytes(cwd, 'c.txt')).toBe(changed([3, 25], '\r\n'))
    }
  })

  it('leaves a file saved after the copy was kept, and refuses with stale', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25])); writeFileSync(join(cwd, 'new.txt'), 'new\n')
    const a = await listed(cwd, place, 'a.txt')
    seam.afterKeep = () => writeFileSync(join(cwd, 'a.txt'), 'saved meanwhile\n')
    await expect(service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })).rejects.toMatchObject({ code: 'stale' })
    expect(read(cwd, 'a.txt')).toBe('saved meanwhile\n')
    // A whole file too: Discard's proof leaves it.
    const added = await listed(cwd, place, 'new.txt')
    seam.afterKeep = () => writeFileSync(join(cwd, 'new.txt'), 'new, saved meanwhile\n')
    await expect(service.revert(cwd, USER, place, { path: 'new.txt', version: added.version }, { owner })).rejects.toMatchObject({ code: 'stale' })
    expect(read(cwd, 'new.txt')).toBe('new, saved meanwhile\n')
    expect(await service.revertedList(cwd, owner)).toEqual([])
    // A version that is not the file's any more.
    seam.afterKeep = undefined
    await expect(service.revert(cwd, USER, place, { path: 'a.txt', version: a.version }, { owner })).rejects.toMatchObject({ code: 'stale' })
  })

  it('restore after later edits says changed, with the blobs to compare, and writes nothing', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const a = await listed(cwd, place, 'a.txt')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
    writeFileSync(join(cwd, 'a.txt'), 'edited later\n')
    const result = await service.restoreReverted(cwd, USER, place, done.revertId, { owner })
    expect(result).toEqual({ restored: false, reason: 'changed', currentBlob: git(cwd, 'hash-object', '--no-filters', 'a.txt'), keptBlob: expect.any(String) })
    expect(git(cwd, 'cat-file', 'blob', (result as { keptBlob: string }).keptBlob)).toBe(changed([3, 25]).trimEnd())
    expect(read(cwd, 'a.txt')).toBe('edited later\n')
  })

  it('restore after the files were put back another way (chat Undo) is restored, and after expiry is expired', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const a = await listed(cwd, place, 'a.txt')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect(read(cwd, 'a.txt')).toBe(changed([3, 25]))

    const again = await service.revert(cwd, USER, place, { path: 'a.txt', version: (await listed(cwd, place, 'a.txt')).version, hunks: [a.hunks[1]!.id] }, { owner })
    for (const ref of keptRefs(cwd)) git(cwd, 'update-ref', '-d', ref)
    expect(await service.restoreReverted(cwd, USER, place, again.revertId, { owner })).toEqual({ restored: false, reason: 'expired' })
    expect(await service.restoreReverted(cwd, USER, place, 'no-such-revert', { owner })).toEqual({ restored: false, reason: 'expired' })
    expect(await service.revertedList(cwd, owner)).toEqual([])
  })

  it('lists and restores after a restart, from the owner\'s journal', async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const a = await listed(cwd, place, 'a.txt')
    const done: GitRevertResult = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
    const restarted = new GitService()
    expect((await restarted.revertedList(cwd, owner)).map((item) => item.revertId)).toEqual([done.revertId])
    expect(await restarted.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect(read(cwd, 'a.txt')).toBe(changed([3, 25]))
  })

  it("is one of the owner's kept copies: the sweep and a purge find it by the owner's journal", async () => {
    const cwd = repo(), place = projectPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    const a = await listed(cwd, place, 'a.txt')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
    const listing = git(cwd, 'for-each-ref', `--format=${PRESERVED_REF_FORMAT}`, 'refs/mousse/preserved/')
    // The sweep expires what `threadPreservedRefs` names, counted from when it was kept.
    const owned = threadPreservedRefs(listing, owner)
    expect(owned).toEqual([{ ref: keptRefs(cwd)[0], sha: expect.any(String), keptAt: expect.any(Number) }])
    expect(Math.abs(owned[0]!.keptAt! - (done.keptUntil - 30 * 24 * 3600_000))).toBeLessThan(60_000)
    expect(keptFilesFromListing(listing, owner)).toEqual([expect.objectContaining({ discardReason: expect.stringContaining('only copy') })])
  })
})

describe('revert in a thread worktree', () => {
  it('keeps the other hunks\' choices, and a restore gives the overlay back as it was', async () => {
    const cwd = repo(), place = threadPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 15, 25]))
    let a = await listed(cwd, place, 'a.txt')
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[2]!.id] })
    a = await listed(cwd, place, 'a.txt')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version, hunks: [a.hunks[0]!.id] }, { owner })
    expect(read(cwd, 'a.txt')).toBe(changed([15, 25]))
    expect((await listed(cwd, place, 'a.txt')).hunks.map((hunk) => hunk.included)).toEqual(['yes', 'no'])
    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect(read(cwd, 'a.txt')).toBe(changed([3, 15, 25]))
    expect((await listed(cwd, place, 'a.txt')).hunks.map((hunk) => hunk.included)).toEqual(['yes', 'yes', 'no'])
  })

  it('a whole file leaves the overlay, and comes back with its choices', async () => {
    const cwd = repo(), place = threadPlace(), owner = folder()
    writeFileSync(join(cwd, 'a.txt'), changed([3, 25]))
    let a = await listed(cwd, place, 'a.txt')
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[1]!.id] })
    a = await listed(cwd, place, 'a.txt')
    const done = await service.revert(cwd, USER, place, { path: 'a.txt', version: a.version }, { owner })
    expect(read(cwd, 'a.txt')).toBe(text(LINES))
    expect(JSON.parse(readFileSync(place.overlayFile, 'utf8')).entries).toEqual({})
    // Choosing another file meanwhile does not block the restore.
    writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    const b = await listed(cwd, place, 'b.txt')
    await service.include(cwd, USER, place, { path: 'b.txt', version: b.version, include: false })
    expect(await service.restoreReverted(cwd, USER, place, done.revertId, { owner })).toEqual({ restored: true })
    expect((await listed(cwd, place, 'a.txt')).hunks.map((hunk) => hunk.included)).toEqual(['yes', 'no'])
    expect((await listed(cwd, place, 'b.txt')).included).toBe('no')
  })
})
