import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '../src/mms/git/GitService'
import { userAction } from '../src/mms/git/gitPolicy'
import { alignChoices, applyChoices, buildHunks, parseHunks, splitLines, type SelectionPlace } from '../src/mms/git/gitSelection'
import type { GitChangedFile, GitChangesResult } from '../src/shared/types'
import { committedGitTemplate } from './support/gitBase'

const USER = userAction('button', 'Test action')
const roots: string[] = []
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const gitInput = (cwd: string, input: string, ...args: string[]): string => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
const text = (lines: string[], eol = '\n') => lines.map((line) => `${line}${eol}`).join('')
/** Two separate hunks: line 3 changed, line 25 changed. */
const twoHunks = () => text(LINES.map((line, index) => (index === 2 ? 'line 3 changed' : index === 24 ? 'line 25 changed' : line)))

const copyBase = committedGitTemplate((cwd) => {
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Selection fixture'); git(cwd, 'config', 'user.email', 'selection@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  git(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(cwd, 'a.txt'), text(LINES)); writeFileSync(join(cwd, 'b.txt'), 'b\n')
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'baseline')
})
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-selection-')); roots.push(cwd)
  copyBase(cwd)
  git(cwd, 'config', 'core.hooksPath', join(cwd, '.no-hooks'))
  return cwd
}
const folder = () => { const dir = mkdtempSync(join(tmpdir(), 'mousse-selection-state-')); roots.push(dir); return dir }
const projectPlace = (): Extract<SelectionPlace, { kind: 'project' }> => { const dir = folder(); return { kind: 'project', markerFile: join(dir, 'marker.json'), keepOwner: dir } }
const threadPlace = (): Extract<SelectionPlace, { kind: 'thread' }> => ({ kind: 'thread', overlayFile: join(folder(), 'git-selection.json') })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const fileIn = (result: GitChangesResult, path: string): GitChangedFile => {
  const found = result.files.find((file) => file.path === path)
  if (!found) throw new Error(`${path} is not listed: ${result.files.map((file) => file.path).join(', ')}`)
  return found
}
const committed = (cwd: string, path: string, rev = 'HEAD') => git(cwd, 'show', `${rev}:${path}`)
const staged = (cwd: string) => git(cwd, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()
function withHook(cwd: string, script: string): void {
  const dir = join(dirname(cwd), `${basename(cwd)}-hooks`); roots.push(dir); mkdirSync(dir, { recursive: true })
  const body = join(dir, 'pre-commit.cjs'); writeFileSync(body, script)
  writeFileSync(join(dir, 'pre-commit'), `#!/bin/sh\nexec node "${body.replace(/\\/g, '/')}"\n`, { mode: 0o755 })
  git(cwd, 'config', 'core.hooksPath', dir)
}

describe('hunk alignment', () => {
  it('reads which changes a selected version holds, and rebuilds it from them', () => {
    const head = Buffer.from(text(LINES))
    const work = Buffer.from(twoHunks())
    const shapes = parseHunks('@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+line 3 changed\n line 4\n line 5\n line 6\n@@ -22,7 +22,7 @@\n line 22\n line 23\n line 24\n-line 25\n+line 25 changed\n line 26\n line 27\n line 28\n')
    if (!Array.isArray(shapes)) throw new Error('no hunks')
    const hunks = buildHunks(shapes, splitLines(head), splitLines(work))!
    expect(hunks).toHaveLength(2)
    const firstOnly = Buffer.from(text(LINES.map((line, index) => (index === 2 ? 'line 3 changed' : line))))
    const choices = alignChoices(splitLines(head), hunks, splitLines(firstOnly))!
    expect(choices[0]!.every(Boolean)).toBe(true)
    expect(choices[1]!.filter((_, index) => hunks[1]!.lines[index]!.kind !== ' ')).toEqual([false, false])
    expect(applyChoices(splitLines(head), hunks, choices).equals(firstOnly)).toBe(true)
    // A version holding a line no hunk has is not HEAD plus some of the hunks.
    expect(alignChoices(splitLines(head), hunks, splitLines(Buffer.from(text([...LINES, 'extra']))))).toBeNull()
  })
})

describe('project folder selection', () => {
  it('starts untouched with everything included, and a first exclusion stages the rest without touching other staging', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n'); writeFileSync(join(cwd, 'new.txt'), 'new\n')
    let changes = await service.readChanges(cwd, place)
    expect(changes.selection.state).toBe('untouched')
    expect(changes.files.map((file) => [file.path, file.change, file.included])).toEqual([['a.txt', 'modified', 'yes'], ['b.txt', 'modified', 'yes'], ['new.txt', 'added', 'yes']])
    const a = fileIn(changes, 'a.txt')
    expect(a.hunks).toHaveLength(2)
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[1]!.id] })
    changes = await service.readChanges(cwd, place)
    expect(changes.selection.state).toBe('chosen')
    expect(fileIn(changes, 'a.txt').included).toBe('partial')
    expect(fileIn(changes, 'a.txt').hunks.map((hunk) => hunk.included)).toEqual(['yes', 'no'])
    expect(fileIn(changes, 'b.txt').included).toBe('yes')
    expect(staged(cwd)).toEqual(['a.txt', 'b.txt', 'new.txt'])
    // The working tree is never written.
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe(twoHunks())

    await service.commit(cwd, USER, 'chosen', { selection: { mode: 'chosen', token: changes.selection.token }, place })
    expect(committed(cwd, 'a.txt')).toContain('line 3 changed')
    expect(committed(cwd, 'a.txt')).not.toContain('line 25 changed')
    // After a chosen commit the rest reads as `Commit all`.
    changes = await service.readChanges(cwd, place)
    expect(changes.selection.state).toBe('untouched')
    expect(changes.files.map((file) => [file.path, file.included])).toEqual([['a.txt', 'yes']])
  })

  it('keeps "everything left out" across a restart, refuses an empty chosen commit, and a terminal git add -A makes the token stale', async () => {
    const cwd = repo(), place = projectPlace()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'secret.txt'), 'token\n')
    const first = new GitService()
    const { selection } = await first.includeAll(cwd, USER, place, false)
    expect(selection.state).toBe('chosen')
    const restarted = new GitService()
    const changes = await restarted.readChanges(cwd, place)
    expect(changes.selection).toEqual(selection)
    expect(changes.files.every((file) => file.included === 'no')).toBe(true)
    await expect(restarted.commit(cwd, USER, 'nothing', { selection: { mode: 'chosen', token: selection.token }, place })).rejects.toMatchObject({ code: 'nothing_selected' })
    const head = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'add', '-A')
    await expect(restarted.commit(cwd, USER, 'sneaky', { selection: { mode: 'chosen', token: selection.token }, place })).rejects.toMatchObject({ code: 'stale' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    // The index a terminal prepared is a choice of its own; the marker is not adopted for it.
    const after = await restarted.readChanges(cwd, place)
    expect(after.selection.state).toBe('chosen')
    expect(after.files.every((file) => file.included === 'yes')).toBe(true)
  })

  it('reads a terminal `git add -p` as chosen, and a first include does not run add -A', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    // What `git add -p` leaves: the first hunk staged only.
    const partial = gitInput(cwd, text(LINES.map((line, index) => (index === 2 ? 'line 3 changed' : line))), 'hash-object', '-w', '--stdin')
    git(cwd, 'update-index', '--cacheinfo', `100644,${partial},a.txt`)
    let changes = await service.readChanges(cwd, place)
    expect(changes.selection.state).toBe('chosen')
    expect(fileIn(changes, 'a.txt').hunks.map((hunk) => hunk.included)).toEqual(['yes', 'no'])
    expect(fileIn(changes, 'a.txt').indexDiverged).toBe(false)
    expect(fileIn(changes, 'b.txt').included).toBe('no')
    const b = fileIn(changes, 'b.txt')
    await service.include(cwd, USER, place, { path: 'b.txt', version: b.version, include: true })
    changes = await service.readChanges(cwd, place)
    expect(fileIn(changes, 'a.txt').hunks.map((hunk) => hunk.included)).toEqual(['yes', 'no'])
    expect(git(cwd, 'show', ':a.txt')).not.toContain('line 25 changed')
  })

  it('makes an index-diverged file whole-file only, and keeps the staged version before replacing it', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), text([...LINES, 'staged only'])); git(cwd, 'add', 'a.txt')
    writeFileSync(join(cwd, 'a.txt'), twoHunks())
    const a = fileIn(await service.readChanges(cwd, place), 'a.txt')
    expect(a).toMatchObject({ indexDiverged: true, wholeFileOnly: true, included: 'partial' })
    await expect(service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[0]!.id] })).rejects.toMatchObject({ code: 'whole_file_only' })
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false })
    expect(staged(cwd)).toEqual([])
    // The staged version was kept in a copy under refs/mousse.
    const kept = git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/').split('\n').filter(Boolean)
    expect(kept.length).toBeGreaterThan(0)
    expect(git(cwd, 'show', `${kept[0]}^2:a.txt`)).toContain('staged only')
  })

  it('chooses lines of an untracked file: leaving out a + line drops it', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'new.txt'), 'one\ntwo\nthree\n')
    const file = fileIn(await service.readChanges(cwd, place), 'new.txt')
    expect(file.change).toBe('added')
    const hunk = file.hunks[0]!
    await service.include(cwd, USER, place, { path: 'new.txt', version: file.version, include: false, lines: [{ hunk: hunk.id, indexes: [1] }] })
    expect(git(cwd, 'show', ':new.txt')).toBe('one\nthree')
    const after = fileIn(await service.readChanges(cwd, place), 'new.txt')
    expect(after.hunks[0]!.included).toBe('partial')
  })

  it('leaving out a - line keeps it', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), text(LINES.filter((_, index) => index !== 2 && index !== 3)))
    const file = fileIn(await service.readChanges(cwd, place), 'a.txt')
    const hunk = file.hunks[0]!
    const removed = hunk.lines.findIndex((line) => line.kind === '-' && line.text === 'line 4')
    await service.include(cwd, USER, place, { path: 'a.txt', version: file.version, include: false, lines: [{ hunk: hunk.id, indexes: [removed] }] })
    const index = git(cwd, 'show', ':a.txt')
    expect(index).not.toContain('line 3\n')
    expect(index).toContain('line 4')
  })

  it('lists a staged rename once, whole-file only, and leaves both paths out together', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    git(cwd, 'mv', 'a.txt', 'moved.txt')
    const file = fileIn(await service.readChanges(cwd, place), 'moved.txt')
    expect(file).toMatchObject({ change: 'renamed', oldPath: 'a.txt', wholeFileOnly: true })
    expect((await service.readChanges(cwd, place)).files.some((item) => item.path === 'a.txt')).toBe(false)
    await service.include(cwd, USER, place, { path: 'moved.txt', version: file.version, include: false })
    expect(staged(cwd)).toEqual([])
    expect(git(cwd, 'ls-files', 'a.txt')).toBe('a.txt')
  })

  it('shows a mode-only change and a submodule as whole files without hunks', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    git(cwd, 'update-index', '--chmod=+x', 'b.txt')
    const nested = join(cwd, 'sub')
    mkdirSync(nested); git(nested, 'init', '-q', '-b', 'main'); git(nested, 'config', 'user.name', 'n'); git(nested, 'config', 'user.email', 'n@example.invalid')
    git(nested, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(nested, 'x'), 'x\n'); git(nested, 'add', 'x'); git(nested, 'commit', '-q', '-m', 'one')
    git(cwd, 'add', 'sub'); git(cwd, 'commit', '-q', '-m', 'add sub', '--', 'sub')
    writeFileSync(join(nested, 'x'), 'y\n'); git(nested, 'commit', '-q', '-am', 'two')
    const changes = await service.readChanges(cwd, place)
    expect(fileIn(changes, 'b.txt')).toMatchObject({ mode: { old: '100644', new: '100755' }, wholeFileOnly: true, hunks: [] })
    expect(fileIn(changes, 'sub')).toMatchObject({ kind: 'submodule', wholeFileOnly: true, hunks: [] })
  })

  it('gives repeated identical hunks their own ids and chooses them apart', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    const doubled = [...LINES.slice(0, 5), 'import x', ...LINES.slice(5, 20), 'import x', ...LINES.slice(20)]
    writeFileSync(join(cwd, 'a.txt'), text(doubled))
    const file = fileIn(await service.readChanges(cwd, place), 'a.txt')
    expect(file.hunks).toHaveLength(2)
    expect(new Set(file.hunks.map((hunk) => hunk.id)).size).toBe(2)
    await service.include(cwd, USER, place, { path: 'a.txt', version: file.version, include: false, hunks: [file.hunks[1]!.id] })
    expect(git(cwd, 'show', ':a.txt').split('\n').filter((line) => line === 'import x')).toHaveLength(1)
    expect(git(cwd, 'show', ':a.txt').split('\n').indexOf('import x')).toBe(5)
  })

  it('refuses a version that is no longer current', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks())
    const file = fileIn(await service.readChanges(cwd, place), 'a.txt')
    writeFileSync(join(cwd, 'a.txt'), `${twoHunks()}more\n`)
    await expect(service.include(cwd, USER, place, { path: 'a.txt', version: file.version, include: false })).rejects.toMatchObject({ code: 'stale' })
  })

  it.runIf(process.platform === 'win32')('keeps a CRLF file\'s bytes under core.autocrlf and eol=crlf while a hunk is left out', async () => {
    for (const setup of ['autocrlf', 'attributes'] as const) {
      const cwd = repo(), place = projectPlace(), service = new GitService()
      if (setup === 'autocrlf') git(cwd, 'config', 'core.autocrlf', 'true')
      else { writeFileSync(join(cwd, '.gitattributes'), '*.txt text eol=crlf\n'); git(cwd, 'add', '.gitattributes'); git(cwd, 'commit', '-q', '-m', 'attrs') }
      const crlf = twoHunks().replace(/\n/g, '\r\n')
      writeFileSync(join(cwd, 'a.txt'), crlf)
      const file = fileIn(await service.readChanges(cwd, place), 'a.txt')
      expect(file.wholeFileOnly).toBe(false)
      expect(file.hunks).toHaveLength(2)
      await service.include(cwd, USER, place, { path: 'a.txt', version: file.version, include: false, hunks: [file.hunks[1]!.id] })
      // Git's clean form in the index, the file's own bytes untouched.
      const index = execFileSync('git', ['cat-file', 'blob', ':a.txt'], { cwd }).toString('utf8')
      expect(index).not.toContain('\r')
      expect(index).toContain('line 3 changed')
      expect(index).not.toContain('line 25 changed')
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe(crlf)
      const after = fileIn(await service.readChanges(cwd, place), 'a.txt')
      expect(after.hunks.map((hunk) => hunk.included)).toEqual(['yes', 'no'])
    }
  })

  it('falls back to whole files for a path under a filter (LFS and the like)', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n*.id ident\n')
    writeFileSync(join(cwd, 'media.bin'), 'pretend media\n'); writeFileSync(join(cwd, 'v.id'), '$Id$\nx\n')
    git(cwd, 'add', '.gitattributes', 'media.bin', 'v.id'); git(cwd, 'commit', '-q', '-m', 'filtered')
    writeFileSync(join(cwd, 'media.bin'), 'pretend media changed\n'); writeFileSync(join(cwd, 'v.id'), '$Id$\ny\n')
    const changes = await service.readChanges(cwd, place)
    for (const path of ['media.bin', 'v.id']) {
      const file = fileIn(changes, path)
      expect(file.wholeFileOnly).toBe(true)
    }
    const media = fileIn(changes, 'media.bin')
    await expect(service.include(cwd, USER, place, { path: 'media.bin', version: media.version, include: false, hunks: media.hunks.map((hunk) => hunk.id).slice(0, 1).concat(['x']) })).rejects.toMatchObject({ code: expect.stringMatching(/whole_file_only|stale/) })
    await service.include(cwd, USER, place, { path: 'media.bin', version: media.version, include: false })
    expect(fileIn(await service.readChanges(cwd, place), 'media.bin').included).toBe('no')
  })

  it('keeps the marker through a Mousse stage only when it held right before', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    await service.includeAll(cwd, USER, place, false)
    await service.unstageAll(cwd, USER, { markerFile: place.markerFile })
    expect((await service.readChanges(cwd, place)).selection.state).toBe('chosen')
    // A terminal stages; the next Mousse write does not take that for the person's choice.
    git(cwd, 'add', 'b.txt')
    await service.unstage(cwd, USER, ['b.txt'], { markerFile: place.markerFile })
    expect((await service.readChanges(cwd, place)).selection.state).toBe('untouched')
  })

  it('a commit from an older client, without the field, keeps the old rule', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    await service.commit(cwd, USER, 'everything', { place })
    expect(git(cwd, 'status', '--porcelain')).toBe('')
  })

  it('describes only the selection for a commit message', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    const b = fileIn(await service.readChanges(cwd, place), 'b.txt')
    await service.include(cwd, USER, place, { path: 'b.txt', version: b.version, include: false })
    const { selection } = await service.readChanges(cwd, place)
    const input = await service.describeSelection(cwd, place, selection.token)
    expect(input.files).toEqual(['a.txt'])
    await expect(service.describeSelection(cwd, place, 'old')).rejects.toMatchObject({ code: 'stale' })
  })
})

describe('undo last commit', () => {
  it('soft-resets a local commit and refuses a root, a merge, a pushed commit and a moved HEAD', async () => {
    const cwd = repo(), place = projectPlace(), service = new GitService()
    writeFileSync(join(cwd, 'b.txt'), 'b changed\n'); git(cwd, 'commit', '-q', '-am', 'local')
    const head = git(cwd, 'rev-parse', 'HEAD')
    await expect(service.undoLastCommit(cwd, USER, 'f'.repeat(40), place)).rejects.toMatchObject({ code: 'stale' })
    await service.undoLastCommit(cwd, USER, head, place)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(cwd, 'rev-parse', `${head}^`))
    expect(staged(cwd)).toEqual(['b.txt'])
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('b changed\n')

    const root = git(cwd, 'rev-parse', 'HEAD')
    await expect(service.undoLastCommit(cwd, USER, root, place)).rejects.toMatchObject({ code: 'git_undo_root' })

    git(cwd, 'commit', '-q', '-m', 'again')
    git(cwd, 'checkout', '-q', '-b', 'side', 'HEAD^'); writeFileSync(join(cwd, 'side.txt'), 's\n'); git(cwd, 'add', 'side.txt'); git(cwd, 'commit', '-q', '-m', 'side')
    git(cwd, 'checkout', '-q', 'main'); git(cwd, 'merge', '-q', '--no-ff', '-m', 'merge', 'side')
    await expect(service.undoLastCommit(cwd, USER, git(cwd, 'rev-parse', 'HEAD'), place)).rejects.toMatchObject({ code: 'git_undo_merge' })

    const origin = join(folder(), 'origin.git'); git(cwd, 'init', '-q', '--bare', origin)
    git(cwd, 'remote', 'add', 'origin', origin); git(cwd, 'push', '-q', 'origin', 'main')
    writeFileSync(join(cwd, 'c.txt'), 'c\n'); git(cwd, 'add', 'c.txt'); git(cwd, 'commit', '-q', '-m', 'c')
    git(cwd, 'push', '-q', 'origin', 'main')
    await expect(service.undoLastCommit(cwd, USER, git(cwd, 'rev-parse', 'HEAD'), place)).rejects.toMatchObject({ code: 'git_amend_pushed' })
    expect(existsSync(join(cwd, 'c.txt'))).toBe(true)
  })
})

describe('thread worktree selection', () => {
  it('keeps the overlay across a restart and commits only the chosen hunks through a fresh index', async () => {
    const cwd = repo(), place = threadPlace()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n'); writeFileSync(join(cwd, 'new.txt'), 'new\n')
    const first = new GitService()
    const a = fileIn(await first.readChanges(cwd, place), 'a.txt')
    await first.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[0]!.id] })
    const b = fileIn(await first.readChanges(cwd, place), 'b.txt')
    await first.include(cwd, USER, place, { path: 'b.txt', version: b.version, include: false })
    // Nothing of it is in the real index.
    expect(staged(cwd)).toEqual([])
    const restarted = new GitService()
    const changes = await restarted.readChanges(cwd, place)
    expect(changes.selection.state).toBe('chosen')
    expect(fileIn(changes, 'a.txt').hunks.map((hunk) => hunk.included)).toEqual(['no', 'yes'])
    expect(fileIn(changes, 'b.txt').included).toBe('no')
    expect(fileIn(changes, 'new.txt').included).toBe('yes')
    await restarted.commit(cwd, USER, 'chosen', { selection: { mode: 'chosen', token: changes.selection.token }, place })
    expect(committed(cwd, 'a.txt')).toContain('line 25 changed')
    expect(committed(cwd, 'a.txt')).not.toContain('line 3 changed')
    expect(committed(cwd, 'b.txt')).toBe('b')
    expect(committed(cwd, 'new.txt')).toBe('new')
    // The real index is at the new HEAD and the files are untouched; the overlay is gone.
    expect(staged(cwd)).toEqual([])
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe(twoHunks())
    const after = await restarted.readChanges(cwd, place)
    expect(after.selection.state).toBe('untouched')
    expect(after.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
  })

  it('never reverses an agent commit of another file, and an old token is stale', async () => {
    const cwd = repo(), place = threadPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks())
    const a = fileIn(await service.readChanges(cwd, place), 'a.txt')
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[1]!.id] })
    const old = (await service.readChanges(cwd, place)).selection.token
    writeFileSync(join(cwd, 'agent.txt'), 'agent\n'); writeFileSync(join(cwd, 'b.txt'), 'agent b\n'); git(cwd, 'add', 'agent.txt', 'b.txt'); git(cwd, 'commit', '-q', '-m', 'agent')
    await expect(service.commit(cwd, USER, 'old', { selection: { mode: 'chosen', token: old }, place })).rejects.toMatchObject({ code: 'stale' })
    const fresh = (await service.readChanges(cwd, place)).selection.token
    await service.commit(cwd, USER, 'chosen', { selection: { mode: 'chosen', token: fresh }, place })
    expect(committed(cwd, 'b.txt')).toBe('agent b')
    expect(committed(cwd, 'agent.txt')).toBe('agent')
    expect(committed(cwd, 'a.txt')).toContain('line 3 changed')
    expect(committed(cwd, 'a.txt')).not.toContain('line 25 changed')
  })

  it('refuses a chosen commit when an agent committed the same file since', async () => {
    const cwd = repo(), place = threadPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks())
    const a = fileIn(await service.readChanges(cwd, place), 'a.txt')
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[1]!.id] })
    const agent = twoHunks().replace('line 10\n', 'line 10 agent\n')
    writeFileSync(join(cwd, 'a.txt'), agent); git(cwd, 'commit', '-q', '-am', 'agent edits a')
    const changes = await service.readChanges(cwd, place)
    expect(fileIn(changes, 'a.txt')).toMatchObject({ indexDiverged: true, wholeFileOnly: true })
    const head = git(cwd, 'rev-parse', 'HEAD')
    await expect(service.commit(cwd, USER, 'chosen', { selection: { mode: 'chosen', token: changes.selection.token }, place })).rejects.toMatchObject({ code: 'stale' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(committed(cwd, 'a.txt')).toContain('line 10 agent')
  })

  it('a hook that refuses leaves HEAD, the real index and the overlay as they were', async () => {
    const cwd = repo(), place = threadPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); git(cwd, 'add', 'a.txt')
    const a = fileIn(await service.readChanges(cwd, place), 'a.txt')
    await service.include(cwd, USER, place, { path: 'a.txt', version: a.version, include: false, hunks: [a.hunks[0]!.id] })
    const before = await service.readChanges(cwd, place)
    const head = git(cwd, 'rev-parse', 'HEAD')
    withHook(cwd, "console.error('hook says no'); process.exit(1)")
    await expect(service.commit(cwd, USER, 'refused', { selection: { mode: 'chosen', token: before.selection.token }, place })).rejects.toMatchObject({ code: 'git_commit_failed' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(staged(cwd)).toEqual(['a.txt'])
    expect(git(cwd, 'show', ':a.txt')).toBe(twoHunks().trimEnd())
    expect((await service.readChanges(cwd, place)).selection).toEqual(before.selection)
  })

  it('a hook that reformats and re-adds a file during a chosen commit is committed as it left it', async () => {
    const cwd = repo(), place = threadPlace(), service = new GitService()
    writeFileSync(join(cwd, 'a.txt'), twoHunks()); writeFileSync(join(cwd, 'b.txt'), 'b changed\n')
    const b = fileIn(await service.readChanges(cwd, place), 'b.txt')
    await service.include(cwd, USER, place, { path: 'b.txt', version: b.version, include: false })
    const { selection } = await service.readChanges(cwd, place)
    withHook(cwd, "const fs = require('node:fs'); const { execFileSync } = require('node:child_process'); fs.writeFileSync('a.txt', fs.readFileSync('a.txt', 'utf8').toUpperCase()); execFileSync('git', ['add', 'a.txt'])")
    await service.commit(cwd, USER, 'formatted', { selection: { mode: 'chosen', token: selection.token }, place })
    expect(committed(cwd, 'a.txt')).toContain('LINE 3 CHANGED')
    expect(committed(cwd, 'b.txt')).toBe('b')
  })
})
