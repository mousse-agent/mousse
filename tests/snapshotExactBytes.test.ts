/**
 * Snapshots record exact bytes (`snapshots.ts`, the exact-bytes note): next to Git's form of the files, each snapshot
 * records an exact tree, so Undo, Redo, a revert, a conversation switch and a rebuild give back the bytes that were on
 * disk, whatever line endings, encoding or attributes Git applies. Every check reads the restored file and compares bytes.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { PublishService } from '../src/mms/actions/PublishService'
import { EXACT_LIMITS, exactTreeOfAsync, moveFilesToSnapshotAsync, recordExactTrees, snapshotUncoveredAsync, takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { listChangedFiles } from '../src/mms/git/reviewDiff'
import { trustRepositoryPrograms } from '../src/mms/git/repoPrograms'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, CRASH_CHILD_REQUIRE, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

let f: ReturnType<typeof gitFoundationFixture>
let cwd: string
let previousPath: string | undefined
beforeEach(() => {
  f = gitFoundationFixture()
  cwd = f.repo
  previousPath = process.env.PATH
})
afterEach(() => {
  process.env.PATH = previousPath
  recordExactTrees(true)
  EXACT_LIMITS.fileBytes = 50 * 1024 ** 2
  vi.restoreAllMocks()
  f.dispose()
})

const bytes = (path = 'value.txt', at = cwd): Buffer => readFileSync(join(at, path))
const blobOf = (value: string | Buffer): string => { const data = Buffer.from(value); return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') }
const stored = (value: string | Buffer): boolean => { try { git(cwd, 'cat-file', '-e', blobOf(value)); return true } catch { return false } }
const rawBlob = (revision: string, path = 'value.txt'): Buffer => execFileSync('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd })
const keptRefs = (): string[] => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean)

/** Git's form of `text` written at `path` (its blob run through the checkout conversion). */
function gitsForm(text: string, path = 'value.txt'): Buffer {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: text, encoding: 'utf8' }).trim()
  return execFileSync('git', ['cat-file', '--filters', `--path=${path}`, blob], { cwd })
}

function commitAttributes(line: string): void {
  writeFileSync(join(cwd, '.gitattributes'), `${line}\n`)
  git(cwd, 'add', '.gitattributes'); git(cwd, 'commit', '-qm', 'attributes')
}

/** A turn that writes `value` to `path` (or runs it), then Undo of it. */
async function turn(value: string | Buffer | (() => void), path = 'value.txt', turnId = 'turn') {
  const write = typeof value === 'function' ? value : () => writeFileSync(join(cwd, path), value)
  return (await new ThreadActionService(f.thread).runCheckpointedAction(actionOptions(cwd, turnId), write)).action
}
const undo = () => pressed('Undo', () => new UndoService(f.thread).undoLatest('main', cwd))
const redo = () => pressed('Redo', () => new UndoService(f.thread).undoLatest('main', cwd, undefined, undefined, undefined, 'redo'))

/** A `git` first on PATH that runs `script` (sh) on each Git command whose words match `pattern`, then the real Git. */
function gitLauncher(pattern: string, script: string): void {
  const bin = join(f.root, 'bin')
  mkdirSync(bin, { recursive: true })
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in\n  ${pattern}) ${script} ;;\nesac\nexec '${real}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}:${previousPath}`
}

/** A `git` first on PATH whose updates of the exact index fail as a write error does, while every other command works. */
function exactIndexFails(): void {
  const bin = join(f.root, 'exact-fails')
  mkdirSync(bin, { recursive: true })
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$GIT_INDEX_FILE:$*" in\n  *snapshot-exact-index*update-index*) printf 'fatal: simulated write error\\n' >&2; exit 128 ;;\nesac\nexec '${real}' "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${bin}:${previousPath}`
}
const EXACT_FAILED = "exact bytes could not be recorded (fatal: simulated write error), so only Git's form of files it converts is kept"

describe('snapshots record exact bytes', { timeout: 60_000 }, () => {
  it('Undo under autocrlf=input brings back the CRLF file the agent overwrote, byte for byte (N5)', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = 'unique pre-turn CRLF bbb82f\r\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('agent replacement\n')
    const undone = await undo()
    expect(bytes().equals(Buffer.from(original))).toBe(true)
    // Nothing needed keeping: the turn's end snapshot holds the agent's bytes exactly.
    expect(undone.notice).toBeUndefined()
    expect(keptRefs()).toEqual([])
    // The snapshot's tree holds Git's form, as Publish commits it; its exact tree the bytes as they were on disk.
    expect(rawBlob(action.startSha).toString()).toBe('unique pre-turn CRLF bbb82f\n')
    expect(rawBlob((await exactTreeOfAsync(cwd, action.startSha))!).equals(Buffer.from(original))).toBe(true)
    expect(stored(original)).toBe(true)
    await redo()
    expect(bytes().toString()).toBe('agent replacement\n')
  })

  it('Undo under autocrlf=true brings back an LF file as LF, never CRLF', async () => {
    git(cwd, 'config', 'core.autocrlf', 'true')
    const original = 'written with LF only\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    await turn('agent replacement\r\n')
    await undo()
    expect(bytes().equals(Buffer.from(original))).toBe(true)
    await redo()
    expect(bytes().toString()).toBe('agent replacement\r\n')
  })

  it('text=auto: a CRLF file comes back as CRLF', async () => {
    commitAttributes('* text=auto')
    const original = 'first\r\nsecond\r\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    await turn('agent\n')
    await undo()
    expect(bytes().equals(Buffer.from(original))).toBe(true)
  })

  it('working-tree-encoding: UTF-16 in the other byte order comes back exactly, never encoded twice', async () => {
    commitAttributes('value.txt text working-tree-encoding=UTF-16')
    const original = Buffer.from(gitsForm('ünïcode line\n')).swap16()
    expect(original.equals(gitsForm('ünïcode line\n'))).toBe(false)
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn(gitsForm('agent line\n'))
    // Git stores UTF-8; the exact tree the UTF-16 bytes as they were.
    expect(rawBlob(action.startSha).toString()).toBe('ünïcode line\n')
    await undo()
    expect(bytes().equals(original)).toBe(true)
    await redo()
    expect(bytes().equals(gitsForm('agent line\n'))).toBe(true)
  })

  it('ident: an unexpanded $Id$ comes back unexpanded', async () => {
    commitAttributes('value.txt ident')
    const original = 'version $Id$\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    await turn('agent\n')
    await undo()
    expect(bytes().toString()).toBe(original)
  })

  it('a path under a filter (LFS-style) is left out of the exact tree and written through its filter, beside exact files', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    git(cwd, 'config', 'filter.fake.clean', 'sed -e s/^/P:/'); git(cwd, 'config', 'filter.fake.smudge', 'sed -e s/^P://'); trustRepositoryPrograms(cwd)
    commitAttributes('*.bin filter=fake')
    const media = 'media bytes v1\n'
    const original = 'line one\r\n'
    writeFileSync(join(cwd, 'asset.bin'), media); writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn(() => { writeFileSync(join(cwd, 'asset.bin'), 'media bytes v2\n'); writeFileSync(join(cwd, 'value.txt'), 'agent\n') })
    const exact = (await exactTreeOfAsync(cwd, action.startSha))!
    expect(git(cwd, 'ls-tree', '--name-only', exact, '--', 'asset.bin')).toBe('')
    expect(git(cwd, 'ls-tree', '--name-only', exact, '--', 'value.txt')).toBe('value.txt')
    expect(rawBlob(action.startSha, 'asset.bin').toString()).toBe(`P:${media}`)
    // The filter's input is never stored: only its clean form is.
    expect(stored(media)).toBe(false)
    await undo()
    expect(bytes('asset.bin').toString()).toBe(media)
    expect(bytes().equals(Buffer.from(original))).toBe(true)
  })

  it('a file over the size limit keeps Git\'s form, is named as a gap, and is still restored', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    EXACT_LIMITS.fileBytes = 16
    writeFileSync(join(cwd, 'big.txt'), 'a line longer than the limit\r\n')
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    expect(snapshot.coverageGaps).toEqual([{ path: 'big.txt', reason: "over 16 bytes, so only Git's form of it is kept" }])
    // Recorded under its own key, never as not covered: a restore still writes it.
    expect(await snapshotUncoveredAsync(cwd, snapshot.sha)).toEqual({ gaps: [], ignored: [], truncated: false, exactGaps: [{ path: 'big.txt', reason: "over 16 bytes, so only Git's form of it is kept" }] })
    const action = await turn('replaced by a line also over it\r\n', 'big.txt')
    expect(action.notCovered).toBe("Not covered: big.txt (over 16 bytes, so only Git's form of it is kept).")
    const undone = await undo()
    expect(bytes('big.txt').toString()).toBe('a line longer than the limit\n')
    // The bytes Git's form does not hold are kept first and named (the safety net), and the copy gives them back.
    expect(undone.notice).toMatch(/^Kept big\.txt exactly as it was on disk/)
    expect(rawBlob(keptRefs()[0]!, 'big.txt').toString()).toBe('replaced by a line also over it\r\n')
  })

  it('a file .git/info/attributes converts even with conversions off keeps Git\'s form, is named, and is restored', async () => {
    writeFileSync(join(cwd, 'other.txt'), 'other\r\n')
    writeFileSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/attributes')), 'value.txt eol=crlf\n')
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    expect(snapshot.coverageGaps).toEqual([{ path: 'value.txt', reason: ".git/info/attributes converts it, so only Git's form of it is kept" }])
    expect(git(cwd, 'ls-tree', '--name-only', snapshot.exactTree!)).toBe('other.txt')
    await turn(() => { writeFileSync(join(cwd, 'value.txt'), 'agent\r\n'); writeFileSync(join(cwd, 'other.txt'), 'agent other\n') })
    await undo()
    expect(bytes().toString()).toBe('base\r\n')
    expect(bytes('other.txt').toString()).toBe('other\r\n')
  })

  it('a snapshot is never a merge: one parent, the exact-bytes commit, whose parent is HEAD; the review counts no merged commits', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    writeFileSync(join(cwd, 'value.txt'), 'crlf\r\n')
    const action = await turn(() => { writeFileSync(join(cwd, 'value.txt'), 'committed\n'); git(cwd, 'commit', '-qam', 'agent commit') })
    for (const sha of [action.startSha, action.endSha]) {
      const parents = git(cwd, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1)
      expect(parents).toHaveLength(1)
      expect(git(cwd, 'log', '-1', '--format=%s', parents[0]!)).toBe('mousse snapshot: exact bytes')
      expect(git(cwd, 'rev-list', '--parents', '-n', '1', parents[0]!).split(' ').slice(1)).toEqual([git(cwd, 'log', '-1', '--format=%(trailers:key=Mousse-Head,valueonly)', sha)])
    }
    expect(git(cwd, 'merge-base', 'HEAD', action.endSha)).toBe(git(cwd, 'rev-parse', 'HEAD'))
    const listed = await listChangedFiles(cwd, { from: { kind: 'commit', sha: action.startSha }, to: { kind: 'commit', sha: action.endSha } })
    expect(listed.mergeCommits).toBe(0)
    expect(listed.files.map((file) => file.path)).toEqual(['value.txt'])
  })

  it('a repository that converts nothing records its tree as the exact tree, and Undo stays one read-tree', async () => {
    const action = await turn('agent\r\n')
    expect(await exactTreeOfAsync(cwd, action.startSha)).toBe(git(cwd, 'rev-parse', `${action.startSha}^{tree}`))
    await undo()
    expect(bytes().toString()).toBe('base\n')
  })

  it('snapshots from before (no exact tree) and new ones restore side by side', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = 'original\r\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    // The start is an older snapshot; the end a new one.
    recordExactTrees(false)
    const older = await turn(() => { recordExactTrees(true); writeFileSync(join(cwd, 'value.txt'), 'agent\r\n') })
    expect(await exactTreeOfAsync(cwd, older.startSha)).toBeUndefined()
    expect(await exactTreeOfAsync(cwd, older.endSha)).toBeDefined()
    const undone = await undo()
    // The older start holds Git's form only, which is written; the agent's bytes are held by the new end snapshot.
    expect(bytes().toString()).toBe('original\n')
    expect(undone.notice).toBeUndefined()
    await redo()
    expect(bytes().toString()).toBe('agent\r\n')

    // The start is new and the end older: the start's exact bytes come back.
    writeFileSync(join(cwd, 'value.txt'), original)
    const newer = await turn(() => { recordExactTrees(false); writeFileSync(join(cwd, 'value.txt'), 'second agent\n') }, 'value.txt', 'second')
    recordExactTrees(true)
    expect(await exactTreeOfAsync(cwd, newer.endSha)).toBeUndefined()
    await undo()
    expect(bytes().equals(Buffer.from(original))).toBe(true)
  })

  it('attributes that change between snapshots: the exact bytes of each side come back', async () => {
    // Converts nothing at the start; the agent adds an attribute that converts the file it writes.
    const action = await turn(() => {
      writeFileSync(join(cwd, '.gitattributes'), 'value.txt text eol=crlf\n')
      writeFileSync(join(cwd, 'value.txt'), 'agent line\r\n')
    })
    expect(await exactTreeOfAsync(cwd, action.startSha)).toBe(git(cwd, 'rev-parse', `${action.startSha}^{tree}`))
    await undo()
    expect(existsSync(join(cwd, '.gitattributes'))).toBe(false)
    expect(bytes().toString()).toBe('base\n')
    await redo()
    expect(bytes('.gitattributes').toString()).toBe('value.txt text eol=crlf\n')
    expect(bytes().toString()).toBe('agent line\r\n')
  })

  it('a change of line endings alone is restored, and an interrupted one is recovered from the exact bytes on disk', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = 'same words\r\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('same words\n')
    // Git's form is the same at both ends: only the exact trees tell the turn apart.
    expect(git(cwd, 'rev-parse', `${action.startSha}^{tree}`)).toBe(git(cwd, 'rev-parse', `${action.endSha}^{tree}`))
    expect(await exactTreeOfAsync(cwd, action.startSha)).not.toBe(await exactTreeOfAsync(cwd, action.endSha))

    // Stopped before anything is written: recovery reads the exact bytes, finds them unmoved, and cancels.
    gitLauncher('*" read-tree -m -u "*', 'exit 1')
    await expect(undo()).rejects.toThrow()
    process.env.PATH = previousPath
    await new UndoService(f.thread).recoverPending(cwd, async () => {})
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => entry.operationType === 'undo').map((entry) => entry.state)).toEqual(['cancelled'])
    expect(bytes().toString()).toBe('same words\n')

    // Stopped after the files were written, before the result was recorded: recovery finds them moved, and records the
    // planned exact bytes with the result, so Redo is exact too.
    gitLauncher('*"undo turn"*', 'exit 1')
    await expect(undo()).rejects.toThrow()
    process.env.PATH = previousPath
    expect(bytes().equals(Buffer.from(original))).toBe(true)
    await new UndoService(f.thread).recoverPending(cwd, async () => {})
    const compensation = new ThreadActionService(f.thread).list().at(-1)!
    expect(rawBlob((await exactTreeOfAsync(cwd, compensation.endSha))!).equals(Buffer.from(original))).toBe(true)
    await redo()
    expect(bytes().toString()).toBe('same words\n')
  })

  it('a conversation switch brings the CRLF edit along exactly where the merge leaves it, and names an exact command for the version left behind', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const middle = 'context a\ncontext b\ncontext c\ncontext d\ncontext e\n'
    writeFileSync(join(cwd, 'value.txt'), `start\n${middle}line2\n`); writeFileSync(join(cwd, 'other.txt'), 'other\n')
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'two files')
    await new ThreadWorkspaceManager(f.thread).ensureProjectFolder('task', 'main', cwd)
    const actions = new ThreadActionService(f.thread)
    const branches = new ConversationBranchService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(cwd, 'first'), () => writeFileSync(join(cwd, 'value.txt'), `fork\n${middle}line2\n`))
    await actions.runCheckpointedAction(actionOptions(cwd, 'second'), () => writeFileSync(join(cwd, 'value.txt'), `main\n${middle}line2\n`))
    const fork = await branches.fork(cwd, 'main', action.id, 'Older')
    // The person's own edits: one the switch leaves alone, one it merges with the fork's version.
    const typedOther = 'other, typed with CRLF\r\n'
    const typedValue = `main\n${middle}personal WIP\n`.replaceAll('\n', '\r\n')
    writeFileSync(join(cwd, 'other.txt'), typedOther); writeFileSync(join(cwd, 'value.txt'), typedValue)
    const switched = await pressed('Switch conversation branch', () => branches.activate(cwd, fork.id))
    expect(bytes('other.txt').equals(Buffer.from(typedOther))).toBe(true)
    // Content the merge made is written in Git's form.
    expect(bytes().toString()).toBe(`fork\n${middle}personal WIP\n`)
    // The notice's own command gives the left-behind version back byte for byte.
    const command = /running this in .*?: (\(.*?\))(?: \(kept for [^)]*\))?\.$/.exec(switched.notice!)![1]!
    expect(command).toContain('cat-file blob')
    execFileSync('sh', ['-c', command], { cwd })
    expect(bytes().equals(Buffer.from(typedValue))).toBe(true)
  })

  it('a worktree started from a snapshot gets its exact bytes', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = 'started\r\n'
    writeFileSync(join(cwd, 'value.txt'), original); writeFileSync(join(cwd, 'new.txt'), 'new\r\n')
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    const started = f.child('started')
    const moved = await pressed('Start', () => moveFilesToSnapshotAsync(started, git(started, 'rev-parse', 'HEAD^{tree}'), snapshot.sha))
    expect(moved).toEqual({})
    expect(bytes('value.txt', started).equals(Buffer.from(original))).toBe(true)
    expect(bytes('new.txt', started).toString()).toBe('new\r\n')
  })

  it('Publish commits Git\'s form of the files, as before', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const workspace = f.child('task')
    writeFileSync(join(workspace, 'value.txt'), 'published\r\nlines\r\n')
    writeFileSync(join(workspace, 'added.txt'), 'added\r\n')
    // The tree `git add -A` makes, through an index of its own.
    const index = join(f.root, 'expected.index')
    const env = { ...process.env, GIT_INDEX_FILE: index }
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: workspace, env }); execFileSync('git', ['add', '-A'], { cwd: workspace, env })
    const expected = execFileSync('git', ['write-tree'], { cwd: workspace, env, encoding: 'utf8' }).trim()
    const target = git(cwd, 'branch', '--show-current')
    const result = await pressed('Publish', () => new PublishService(f.thread).publish(workspace, cwd, target, undefined, { operationId: 'publish-exact' }))
    expect(result.state).toBe('completed')
    expect(git(cwd, 'rev-parse', 'HEAD^{tree}')).toBe(expected)
    expect(git(cwd, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([f.baseSha])
    expect(rawBlob('HEAD').toString()).toBe('published\nlines\n')
  })

  it('an ignored .gitattributes counts: its eol makes the snapshot record exact bytes, and Undo gives the CRLF file back', async () => {
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.gitattributes\n')
    writeFileSync(join(cwd, '.gitattributes'), 'value.txt text eol=lf\n')
    const original = Buffer.from('original\r\n')
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('agent\n')
    await undo()
    expect(bytes().equals(original)).toBe(true)
    expect(rawBlob((await exactTreeOfAsync(cwd, action.startSha))!).equals(original)).toBe(true)
  })

  it('a filter set only by an ignored .gitattributes is left out of the exact tree, so Undo writes the file through its filter', async () => {
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.gitattributes\n')
    writeFileSync(join(cwd, '.gitattributes'), 'value.txt filter=fake\n')
    git(cwd, 'config', 'filter.fake.clean', 'sed -e s/^/P:/'); git(cwd, 'config', 'filter.fake.smudge', 'sed -e s/^P://'); trustRepositoryPrograms(cwd)
    writeFileSync(join(cwd, 'value.txt'), 'media original\n')
    const action = await turn('media agent\n')
    expect(git(cwd, 'ls-tree', '--name-only', (await exactTreeOfAsync(cwd, action.startSha))!, '--', 'value.txt')).toBe('')
    await undo()
    expect(bytes().toString()).toBe('media original\n')
  })

  it('the size limit is on the bytes on disk, not the smaller form Git stores (UTF-16)', async () => {
    commitAttributes('value.txt text working-tree-encoding=UTF-16')
    EXACT_LIMITS.fileBytes = 24
    const value = gitsForm('some unicode é text\n')
    // Git stores 21 bytes of UTF-8; the file on disk is over the limit.
    expect(value.length).toBeGreaterThan(24)
    writeFileSync(join(cwd, 'value.txt'), value)
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'size' })
    expect(snapshot.coverageGaps).toContainEqual({ path: 'value.txt', reason: "over 24 bytes, so only Git's form of it is kept" })
    expect(git(cwd, 'ls-tree', '--name-only', snapshot.exactTree!, '--', 'value.txt')).toBe('')
  })

  it('a worktree started from a snapshot reads the snapshot\'s attributes: an LF file under a committed eol=crlf stays LF', async () => {
    commitAttributes('*.bat text eol=crlf')
    writeFileSync(join(cwd, 'run.bat'), 'echo a\r\n'); git(cwd, 'add', 'run.bat'); git(cwd, 'commit', '-qm', 'script')
    // The agent writes LF; Git stores LF either way, so the snapshot's exact tree is its tree.
    writeFileSync(join(cwd, 'run.bat'), 'echo b\n')
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    expect(snapshot.exactTree).toBe(snapshot.tree)
    const started = f.child('started', git(cwd, 'rev-parse', 'HEAD'))
    await pressed('Start', () => moveFilesToSnapshotAsync(started, git(started, 'rev-parse', 'HEAD^{tree}'), snapshot.sha))
    expect(bytes('run.bat', started).toString()).toBe('echo b\n')
  })

  it('the first exact build puts its new blobs in one pack on Git 2.37 and later', async () => {
    git(cwd, 'config', 'core.autocrlf', 'true')
    for (let index = 0; index < 40; index++) writeFileSync(join(cwd, `file-${index}.txt`), `line ${index}\r\n`)
    const packs = () => readdirSync(join(cwd, '.git', 'objects', 'pack')).filter((name) => name.endsWith('.pack')).length
    const before = packs()
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'first' })
    expect(packs()).toBe(before + 1)
    expect(rawBlob(snapshot.exactTree!, 'file-7.txt').toString()).toBe('line 7\r\n')
  })

  it('on Git older than 2.37 the first exact build writes loose objects, never one pack per file', async () => {
    git(cwd, 'config', 'core.autocrlf', 'true')
    for (let index = 0; index < 40; index++) writeFileSync(join(cwd, `file-${index}.txt`), `line ${index}\r\n`)
    const packs = () => readdirSync(join(cwd, '.git', 'objects', 'pack')).filter((name) => name.endsWith('.pack')).length
    const before = packs()
    // A Git that says it is 2.36, in a process of its own so the version is read afresh; every command is logged.
    const bin = join(f.root, 'old-git'), log = join(f.root, 'old-git.log'), out = join(f.root, 'old-git.json')
    mkdirSync(bin)
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase " $* " in\n  *" version ") echo "git version 2.36.6"; exit 0 ;;\nesac\nexec '${real}' "$@"\n`, { mode: 0o755 })
    const entry = join(f.root, 'old-git.ts'), bundle = join(f.root, 'old-git.mjs'), project = process.cwd()
    writeFileSync(entry, `import { writeFileSync } from 'node:fs'; import { takeSnapshotAsync } from '${project}/src/mms/actions/snapshots'; const snapshot = await takeSnapshotAsync(${JSON.stringify(cwd)}, { reason: 'old git' }); writeFileSync(${JSON.stringify(out)}, JSON.stringify(snapshot));`)
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: CRASH_CHILD_REQUIRE } })
    const child = spawnSync(process.execPath, [bundle], { env: { ...process.env, MOUSSE_HOME: f.home, PATH: `${bin}:${previousPath}` }, encoding: 'utf8', timeout: 60_000 })
    expect(child.status, child.stderr).toBe(0)
    const snapshot = JSON.parse(readFileSync(out, 'utf8')) as { exactTree: string }
    expect(readFileSync(log, 'utf8')).toContain('update-index -z --add --remove --stdin')
    expect(readFileSync(log, 'utf8')).not.toContain('bigFileThreshold')
    expect(packs()).toBe(before)
    expect(rawBlob(snapshot.exactTree, 'file-7.txt').toString()).toBe('line 7\r\n')
  })

  // Review round 2.
  for (const mode of ['autocrlf', 'ident'] as const) {
    it(`content the merge made goes through Git's checkout conversion (${mode}), never written as it is stored`, async () => {
      const middle = 'context 1\ncontext 2\ncontext 3\ncontext 4\ncontext 5\n'
      if (mode === 'autocrlf') git(cwd, 'config', 'core.autocrlf', 'true')
      else commitAttributes('value.txt ident')
      const suffix = mode === 'ident' ? 'version $Id$\n' : ''
      writeFileSync(join(cwd, 'value.txt'), `start\n${middle}end\n${suffix}`)
      await turn(`agent\n${middle}end\n${suffix}`)
      // The person edits the last line after the turn; Undo merges it with the restored first line.
      writeFileSync(join(cwd, 'value.txt'), `agent\n${middle}personal\n${suffix}`)
      await undo()
      expect(bytes().equals(gitsForm(`start\n${middle}personal\n${suffix}`))).toBe(true)
      expect(bytes().toString()).toBe(mode === 'autocrlf' ? `start\n${middle}personal\n`.replaceAll('\n', '\r\n') : bytes().toString())
      if (mode === 'ident') expect(bytes().toString()).toMatch(/version \$Id: [0-9a-f]{40} \$/)
    })
  }

  it('the size limit covers ident expansion: a file Git stores small but expands on disk is left out and named', async () => {
    commitAttributes('value.txt ident')
    EXACT_LIMITS.fileBytes = 1500
    // 35 lines of `$Id$` are 175 bytes stored, under an eighth of the limit; expanded on disk they are 1,680 bytes.
    writeFileSync(join(cwd, 'value.txt'), gitsForm('$Id$\n'.repeat(35)))
    expect(bytes().length).toBeGreaterThan(1500)
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'size' })
    expect(snapshot.coverageGaps).toContainEqual({ path: 'value.txt', reason: "over 1 KB, so only Git's form of it is kept" })
    expect(git(cwd, 'ls-tree', '--name-only', snapshot.exactTree!, '--', 'value.txt')).toBe('')
  })

  it('under autocrlf=true, a restore that only creates a file writes it as it was: an added LF file after Undo and Redo, a deleted one after Undo', async () => {
    git(cwd, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(cwd, 'other.txt'), 'other\nfile\n'); git(cwd, 'add', 'other.txt'); git(cwd, 'commit', '-qm', 'other')
    // Written by tools as LF, never checked out by Git.
    writeFileSync(join(cwd, 'other.txt'), 'other\nfile\n')
    await turn(() => writeFileSync(join(cwd, 'new.txt'), 'new\nfile\n'))
    await undo()
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    await redo()
    expect(bytes('new.txt').toString()).toBe('new\nfile\n')
    await turn(() => rmSync(join(cwd, 'other.txt')), 'value.txt', 'second')
    await undo()
    expect(bytes('other.txt').toString()).toBe('other\nfile\n')
  })

  it('recovery reads a finished create-only restore as finished', async () => {
    git(cwd, 'config', 'core.autocrlf', 'true')
    await turn(() => writeFileSync(join(cwd, 'new.txt'), 'new\nfile\n'))
    await undo()
    // The Redo writes the file, then stops before its result is recorded.
    gitLauncher('*"redo turn"*', 'exit 1')
    await expect(redo()).rejects.toThrow()
    process.env.PATH = previousPath
    expect(bytes('new.txt').toString()).toBe('new\nfile\n')
    await new UndoService(f.thread).recoverPending(cwd, async () => {})
    expect([...new ThreadJournal(f.thread).latestByOperation().values()].filter((entry) => entry.operationType === 'redo').map((entry) => entry.state)).toEqual(['completed'])
    expect(bytes('new.txt').toString()).toBe('new\nfile\n')
  })

  it('with core.fileMode=false an executable script keeps its exec bit through Undo, Redo and Undo of its removal', async () => {
    writeFileSync(join(cwd, 'run.sh'), 'echo a\n'); chmodSync(join(cwd, 'run.sh'), 0o755)
    git(cwd, 'add', 'run.sh'); git(cwd, 'commit', '-qm', 'script')
    git(cwd, 'config', 'core.fileMode', 'false'); git(cwd, 'config', 'core.autocrlf', 'true')
    writeFileSync(join(cwd, 'crlf.txt'), 'unrelated\r\n')
    const mode = () => statSync(join(cwd, 'run.sh')).mode & 0o777
    const action = await turn('echo agent\n', 'run.sh')
    expect(git(cwd, 'ls-tree', (await exactTreeOfAsync(cwd, action.startSha))!, '--', 'run.sh').split(' ')[0]).toBe('100755')
    await undo()
    expect([bytes('run.sh').toString(), mode()]).toEqual(['echo a\n', 0o755])
    await redo()
    expect([bytes('run.sh').toString(), mode()]).toEqual(['echo agent\n', 0o755])
    await turn(() => rmSync(join(cwd, 'run.sh')), 'value.txt', 'second')
    await undo()
    expect([bytes('run.sh').toString(), mode()]).toEqual(['echo agent\n', 0o755])
  })

  for (const variant of ['committed', 'ignored'] as const) {
    it(`a filter line the agent drops never puts the file's plaintext in .git/objects (${variant} .gitattributes)`, async () => {
      git(cwd, 'config', 'filter.crypt.clean', 'base64'); git(cwd, 'config', 'filter.crypt.smudge', 'base64 -d'); trustRepositoryPrograms(cwd)
      const plaintext = `secret plaintext ${Date.now()}\n`
      if (variant === 'ignored') writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.gitattributes\n')
      writeFileSync(join(cwd, '.gitattributes'), 'secret.txt filter=crypt\n*.txt text\n')
      writeFileSync(join(cwd, 'secret.txt'), plaintext)
      git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'secret')
      // Times in the past, so Git's stat cache trusts the files and never reads them again.
      const then = new Date(Date.now() - 30_000)
      for (const path of ['secret.txt', '.gitattributes', 'value.txt']) utimesSync(join(cwd, path), then, then)
      await takeSnapshotAsync(cwd, { reason: 'first' })
      expect(stored(plaintext)).toBe(false)
      // The agent drops the filter line (as `git lfs untrack` does), leaving the decrypted file as it is.
      await turn(() => writeFileSync(join(cwd, '.gitattributes'), '*.txt text\n'), '.gitattributes')
      expect(stored(plaintext)).toBe(false)
      await undo()
      expect(stored(plaintext)).toBe(false)
      // An ignored file is no snapshot's, so Undo leaves it as the agent left it; a committed one comes back.
      expect(bytes('.gitattributes').toString()).toBe(variant === 'committed' ? 'secret.txt filter=crypt\n*.txt text\n' : '*.txt text\n')
      expect(bytes('secret.txt').toString()).toBe(plaintext)
    })
  }
})

describe('every exact-bytes gap is recorded and reported', { timeout: 60_000 }, () => {
  it('an exact index that cannot be written names the gap, and Undo gives Git\'s form back (R3-C)', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = Buffer.from('unique raw before IO failure 9944\r\n')
    writeFileSync(join(cwd, 'value.txt'), original)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    exactIndexFails()
    const action = await turn('agent\n')
    process.env.PATH = previousPath
    expect(action.notCovered).toBe(`Not covered: . (${EXACT_FAILED}).`)
    expect(await exactTreeOfAsync(cwd, action.startSha)).toBeUndefined()
    // Recorded on the snapshot commits under `x`, never as left out: a restore still writes every file.
    for (const sha of [action.startSha, action.endSha]) expect(await snapshotUncoveredAsync(cwd, sha)).toEqual({ gaps: [], ignored: [], truncated: false, exactGaps: [{ path: '.', reason: EXACT_FAILED }] })
    // Logged once for the worktree, though both snapshots met it.
    expect(warn.mock.calls.filter(([message]) => String(message).includes('could not record exact bytes'))).toHaveLength(1)
    const undone = await undo()
    expect(bytes().equals(Buffer.from('unique raw before IO failure 9944\n'))).toBe(true)
    expect(undone.notice).toContain(`Not covered: . (${EXACT_FAILED}).`)
  })

  it('a repository that converts nothing names nothing under the same fault', async () => {
    exactIndexFails()
    const action = await turn('agent\r\n')
    process.env.PATH = previousPath
    expect(action.notCovered).toBeUndefined()
    expect(await exactTreeOfAsync(cwd, action.startSha)).toBe(git(cwd, 'rev-parse', `${action.startSha}^{tree}`))
    await undo()
    expect(bytes().toString()).toBe('base\n')
  })

  it('a failure only at the start of the turn is named as the start\'s, and never stops the restore', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    writeFileSync(join(cwd, 'value.txt'), 'before the turn\r\n')
    writeFileSync(join(cwd, 'other.txt'), 'other before\n')
    exactIndexFails()
    const action = await turn(() => { process.env.PATH = previousPath; writeFileSync(join(cwd, 'value.txt'), 'agent\r\n'); writeFileSync(join(cwd, 'other.txt'), 'agent other\n') })
    expect(await exactTreeOfAsync(cwd, action.startSha)).toBeUndefined()
    expect(await exactTreeOfAsync(cwd, action.endSha)).toBeDefined()
    expect(action.notCovered).toBe(`Not covered: . (${EXACT_FAILED}, at the start of the turn).`)
    await undo()
    // Every file comes back: the start's Git form where it had no exact bytes, nothing left as the agent wrote it.
    expect(bytes().equals(Buffer.from('before the turn\n'))).toBe(true)
    expect(bytes('other.txt').equals(Buffer.from('other before\n'))).toBe(true)
    await redo()
    expect(bytes().equals(Buffer.from('agent\r\n'))).toBe(true)
  })

  it('the next snapshot without the fault records exact bytes again, and Undo gives the CRLF file back byte for byte', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = Buffer.from('kept through a passing fault\r\n')
    writeFileSync(join(cwd, 'value.txt'), original)
    exactIndexFails()
    const failed = await takeSnapshotAsync(cwd, { reason: 'during the fault' })
    process.env.PATH = previousPath
    expect(failed.exactTree).toBeUndefined()
    expect(failed.coverageGaps).toEqual([{ path: '.', reason: EXACT_FAILED }])
    const action = await turn('agent\n')
    expect(action.startSha).not.toBe(failed.sha)
    expect(action.notCovered).toBeUndefined()
    await undo()
    expect(bytes().equals(original)).toBe(true)
  })

  it('a start file over the size limit is named for the turn, and other files still come back exactly', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    EXACT_LIMITS.fileBytes = 16
    const big = Buffer.from('a line longer than the limit\r\n')
    const original = Buffer.from('ok\r\n')
    writeFileSync(join(cwd, 'big.txt'), big); writeFileSync(join(cwd, 'value.txt'), original)
    // The agent shrinks the big file under the limit, so only the start names it.
    const action = await turn(() => { writeFileSync(join(cwd, 'big.txt'), 'small\n'); writeFileSync(join(cwd, 'value.txt'), 'agent\n') })
    expect(action.notCovered).toBe("Not covered: big.txt (over 16 bytes, so only Git's form of it is kept, at the start of the turn).")
    await undo()
    expect(bytes().equals(original)).toBe(true)
    expect(bytes('big.txt').equals(Buffer.from('a line longer than the limit\n'))).toBe(true)
  })

  it('exact gaps survive a restart and a recovered Undo, stay informational, and a recovered Undo names them', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    EXACT_LIMITS.fileBytes = 16
    const big = Buffer.from('a line longer than the limit\r\n')
    const original = Buffer.from('ok\r\n')
    writeFileSync(join(cwd, 'big.txt'), big); writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('agent\n')
    const named = { path: 'big.txt', reason: "over 16 bytes, so only Git's form of it is kept" }
    expect((await snapshotUncoveredAsync(cwd, action.startSha))?.exactGaps).toEqual([named])
    // The Undo writes the files, then stops before its result is recorded; a new service recovers it.
    gitLauncher('*"undo turn"*', 'exit 1')
    await expect(undo()).rejects.toThrow()
    process.env.PATH = previousPath
    expect(bytes().equals(original)).toBe(true)
    await new UndoService(f.thread).recoverPending(cwd, async () => {})
    const compensation = new ThreadActionService(f.thread).list().at(-1)!
    expect(compensation.git?.coverageGaps).toContainEqual(named)
    expect(compensation.notice).toContain("Not covered: big.txt (over 16 bytes, so only Git's form of it is kept)")
    const recorded = (await snapshotUncoveredAsync(cwd, compensation.endSha))!
    expect(recorded.exactGaps).toEqual([named])
    expect(recorded.gaps).toEqual([])
    // Informational: the big file was never touched, and Redo then Undo still move the other file exactly.
    expect(bytes('big.txt').equals(big)).toBe(true)
    await redo()
    expect(bytes().toString()).toBe('agent\n')
    await undo()
    expect(bytes().equals(original)).toBe(true)
    expect(bytes('big.txt').equals(big)).toBe(true)
  })
})
