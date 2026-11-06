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
import { ROUND_TRIP_BUDGET } from '../src/mms/actions/filterRoundTrip'
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
  ROUND_TRIP_BUDGET.files = 500
  ROUND_TRIP_BUDGET.ms = 2000
  ROUND_TRIP_BUDGET.storeBytes = 200 * 1024 ** 2
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

describe('filtered files: Git\'s form is checked, and a filter that loses bytes has them kept exactly (R3-F)', { timeout: 60_000 }, () => {
  /** A filter named `name`, trusted as the person's own, set on `pattern` by a committed `.gitattributes`. */
  function filter(name: string, clean: string, smudge: string, pattern = 'value.txt', extra = ''): void {
    git(cwd, 'config', `filter.${name}.clean`, clean); git(cwd, 'config', `filter.${name}.smudge`, smudge)
    commitAttributes(`${pattern} filter=${name}${extra}`)
    trustRepositoryPrograms(cwd)
  }
  /** A shell script at `name` in the fixture that logs its first word and `GIT_INDEX_FILE`, then runs `body`. */
  function logging(name: string, body: string): string {
    const path = join(f.root, name)
    writeFileSync(path, `#!/bin/sh\necho "$1 $GIT_INDEX_FILE" >> '${join(f.root, 'driver.log')}'\nshift\n${body}\n`, { mode: 0o755 })
    return path
  }
  const driverLog = (): string[] => existsSync(join(f.root, 'driver.log')) ? readFileSync(join(f.root, 'driver.log'), 'utf8').split('\n').filter(Boolean) : []
  const smudges = (): number => driverLog().filter((line) => line.startsWith('smudge')).length
  const exactPaths = async (sha: string): Promise<string[]> => execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', (await exactTreeOfAsync(cwd, sha))!], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean)
  const NOT_CHECKED = "not checked yet, so only Git's form of it is kept"

  it('a whitespace-stripping clean filter with a cat smudge: Undo gives back the trailing spaces, byte for byte', async () => {
    filter('audit', "sed 's/ *$//'", 'cat')
    const original = Buffer.from('unique lossy filter bytes 2b82c06d   \n')
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('agent\n')
    expect(action.notCovered).toBeUndefined()
    // Git's form drops the spaces; the exact tree holds the bytes as they were.
    expect(rawBlob(action.startSha).toString()).toBe('unique lossy filter bytes 2b82c06d\n')
    expect(rawBlob((await exactTreeOfAsync(cwd, action.startSha))!).equals(original)).toBe(true)
    const undone = await undo()
    expect(bytes().equals(original)).toBe(true)
    expect(undone.notice).toBeUndefined()
    await redo()
    expect(bytes().toString()).toBe('agent\n')
    await undo()
    expect(bytes().equals(original)).toBe(true)
  })

  it('an nbstripout-like filter (clean drops the outputs, smudge is cat): Undo gives the outputs back, byte for byte', async () => {
    filter('nbstrip', `sed -e 's/,"outputs":\\[[^]]*\\]//'`, 'cat', '*.ipynb')
    const notebook = Buffer.from('{"cells":[{"source":"plot()","outputs":[{"png":"iVBORw0KGgo="}]}]}\n')
    writeFileSync(join(cwd, 'lab.ipynb'), notebook)
    const action = await turn('{"cells":[{"source":"plot()","outputs":[]}]}\n', 'lab.ipynb')
    expect(action.notCovered).toBeUndefined()
    expect(rawBlob(action.startSha, 'lab.ipynb').toString()).toBe('{"cells":[{"source":"plot()"}]}\n')
    await undo()
    expect(bytes('lab.ipynb').equals(notebook)).toBe(true)
  })

  it('filters that give the bytes back (cat/cat, LFS-style with a local store, git-crypt-style) name nothing, store no raw-only object, and come back through the filter', async () => {
    const store = join(f.root, 'lfs-store')
    mkdirSync(store)
    git(cwd, 'config', 'filter.plain.clean', 'cat'); git(cwd, 'config', 'filter.plain.smudge', 'cat')
    git(cwd, 'config', 'filter.lfs.clean', `sh -c 't=$(mktemp); cat > "$t"; h=$(shasum -a 256 "$t" | cut -c1-64); mv "$t" '${store}'/"$h"; echo "oid $h"'`)
    git(cwd, 'config', 'filter.lfs.smudge', `sh -c 'read word h; cat '${store}'/"$h"'`)
    git(cwd, 'config', 'filter.lfs.required', 'true')
    git(cwd, 'config', 'filter.crypt.clean', 'base64'); git(cwd, 'config', 'filter.crypt.smudge', 'base64 -d')
    commitAttributes('plain.txt filter=plain\n*.bin filter=lfs\nsecret.txt filter=crypt')
    trustRepositoryPrograms(cwd)
    const media = `media bytes ${Date.now()}\n`, secret = `secret plaintext ${Date.now()}\n`
    writeFileSync(join(cwd, 'plain.txt'), 'plain bytes\n'); writeFileSync(join(cwd, 'asset.bin'), media); writeFileSync(join(cwd, 'secret.txt'), secret)
    const action = await turn(() => { for (const path of ['plain.txt', 'asset.bin', 'secret.txt']) writeFileSync(join(cwd, path), `agent ${path}\n`) })
    expect(action.notCovered).toBeUndefined()
    expect((await snapshotUncoveredAsync(cwd, action.startSha))?.exactGaps ?? []).toEqual([])
    expect(await exactPaths(action.startSha)).not.toEqual(expect.arrayContaining(['asset.bin']))
    for (const path of ['plain.txt', 'asset.bin', 'secret.txt']) expect(await exactPaths(action.startSha)).not.toContain(path)
    // The raw bytes of the two whose stored form differs are in no object: only their clean form is.
    expect(stored(media)).toBe(false)
    expect(stored(secret)).toBe(false)
    await undo()
    expect([bytes('plain.txt').toString(), bytes('asset.bin').toString(), bytes('secret.txt').toString()]).toEqual(['plain bytes\n', media, secret])
    expect(stored(media)).toBe(false)
    expect(stored(secret)).toBe(false)
  })

  it('a smudge that appends counts as lossy, though the raw blob is the stored one, and Undo gives the exact bytes back', async () => {
    filter('tail', 'cat', `sh -c 'cat; echo appended'`)
    const original = Buffer.from('exactly these bytes\n')
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('agent\n')
    expect(action.notCovered).toBeUndefined()
    expect(await exactPaths(action.startSha)).toContain('value.txt')
    await undo()
    expect(bytes().equals(original)).toBe(true)
  })

  it('a smudge that depends on the path (%f) gets a verdict per path', async () => {
    filter('bypath', 'cat', `sh -c 'cat; case "$1" in b.*) echo tail ;; esac' -- %f`, '*.dat')
    writeFileSync(join(cwd, 'a.dat'), 'same\n'); writeFileSync(join(cwd, 'b.dat'), 'same\n')
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    expect(snapshot.coverageGaps).toBeUndefined()
    const paths = await exactPaths(snapshot.sha)
    expect(paths).toContain('b.dat')
    expect(paths).not.toContain('a.dat')
  })

  it('a lossy filter .git/info/attributes sets (nbstripout --install): no driver runs while hashing, its bytes are stored, and Undo gives them back', async () => {
    const clean = logging('clean.sh', "sed 's/ *$//'")
    const smudge = logging('smudge.sh', 'cat')
    git(cwd, 'config', 'filter.info.clean', `'${clean}' clean`); git(cwd, 'config', 'filter.info.smudge', `'${smudge}' smudge`); git(cwd, 'config', 'filter.info.required', 'true')
    trustRepositoryPrograms(cwd)
    writeFileSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/attributes')), '*.txt filter=info\n')
    git(cwd, 'config', 'core.autocrlf', 'input')
    const original = Buffer.from('trailing   \n')
    writeFileSync(join(cwd, 'value.txt'), original); writeFileSync(join(cwd, 'other.txt'), 'kept\n')
    const action = await turn('agent\n')
    // Git's form runs the clean filter for the snapshot's own tree, and the smudge for the check; nothing on the exact or filtered index.
    expect(driverLog().filter((line) => /snapshot-(exact|filtered)-index/.test(line))).toEqual([])
    expect(driverLog().some((line) => line.startsWith('smudge'))).toBe(true)
    expect(action.notCovered).toBeUndefined()
    expect(rawBlob((await exactTreeOfAsync(cwd, action.startSha))!).equals(original)).toBe(true)
    await undo()
    expect(bytes().equals(original)).toBe(true)
  })

  it('a second unchanged snapshot runs the smudge 0 times', async () => {
    filter('counted', "sed 's/ *$//'", `'${logging('smudge.sh', 'cat')}' smudge`, '*.txt')
    writeFileSync(join(cwd, 'value.txt'), 'spaces   \n'); writeFileSync(join(cwd, 'other.txt'), 'round trip\n')
    const first = await takeSnapshotAsync(cwd, { reason: 'first' })
    expect(smudges()).toBe(2)
    const second = await takeSnapshotAsync(cwd, { reason: 'second' })
    expect(smudges()).toBe(2)
    expect(second.sha).toBe(first.sha)
    // A changed file is checked again, alone.
    writeFileSync(join(cwd, 'other.txt'), 'changed  \n')
    await takeSnapshotAsync(cwd, { reason: 'third' })
    expect(smudges()).toBe(3)
  })

  it('a smudge that fails, though not required, is never read as lossy: nothing is stored or kept, the file is named, and it is checked once it works', async () => {
    const failing = join(f.root, 'smudge-fails')
    writeFileSync(failing, '')
    filter('crypt', 'base64', `sh -c 'if test -e "${failing}"; then exit 1; fi; base64 -d'`, 'value.txt')
    git(cwd, 'config', 'filter.strip.clean', "sed 's/ *$//'"); git(cwd, 'config', 'filter.strip.smudge', 'cat')
    commitAttributes('value.txt filter=crypt\nother.txt filter=strip')
    trustRepositoryPrograms(cwd)
    const secret = 'unique secret optional failure abcdef\n'
    writeFileSync(join(cwd, 'value.txt'), secret); writeFileSync(join(cwd, 'other.txt'), 'spaces  \n')
    const failed = await takeSnapshotAsync(cwd, { reason: 'while the smudge fails' })
    expect(failed.coverageGaps).toEqual([{ path: 'value.txt', reason: NOT_CHECKED }])
    expect(stored(secret)).toBe(false)
    // The other file of the same batch is still checked, and stored.
    expect(rawBlob((await exactTreeOfAsync(cwd, failed.sha))!, 'other.txt').toString()).toBe('spaces  \n')
    expect(Object.keys(JSON.parse(readFileSync(join(cwd, '.git', 'mousse', 'snapshot-filter-verdicts.json'), 'utf8')))).toEqual(['other.txt'])
    rmSync(failing)
    const action = await turn(() => writeFileSync(join(cwd, 'other.txt'), 'agent\n'), 'other.txt')
    expect(await exactPaths(action.startSha)).not.toContain('value.txt')
    expect(stored(secret)).toBe(false)
    expect(action.notCovered).toBeUndefined()
    await undo()
    expect(bytes().toString()).toBe(secret)
    expect(bytes('other.txt').toString()).toBe('spaces  \n')
  })

  it('a save between the check and the store never puts other bytes in an object: only the bytes compared are stored', async () => {
    filter('crypt', 'base64', `sh -c 'base64 -d | sed "s/ *$//"'`)
    const original = 'old lossy secret    \n'
    const replacement = 'new roundtripping secret 88499\n'
    writeFileSync(join(cwd, 'value.txt'), original)
    // A save lands right as Git stores the lossy bytes.
    gitLauncher('*" hash-object -w --no-filters --stdin-paths "*', `printf '${replacement.replace('\n', '\\n')}' > '${join(cwd, 'value.txt')}'`)
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    process.env.PATH = previousPath
    expect(bytes().toString()).toBe(replacement)
    expect(stored(replacement)).toBe(false)
    expect(rawBlob(snapshot.exactTree!).toString()).toBe(original)
  })

  it('a filter line dropped from an ignored .gitattributes: with no attributes to read, no earlier verdict is reused and the file is named', async () => {
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), '.gitattributes\n')
    git(cwd, 'config', 'filter.crypt.clean', 'base64'); git(cwd, 'config', 'filter.crypt.smudge', 'base64 -d'); trustRepositoryPrograms(cwd)
    writeFileSync(join(cwd, '.gitattributes'), 'value.txt filter=crypt\n*.txt text\n')
    const secret = 'secret before dropped attribute 44100\n'
    writeFileSync(join(cwd, 'value.txt'), secret)
    const then = new Date(Date.now() - 30_000)
    for (const path of ['value.txt', '.gitattributes']) utimesSync(join(cwd, path), then, then)
    const first = await takeSnapshotAsync(cwd, { reason: 'first' })
    expect(first.coverageGaps).toBeUndefined()
    // The line goes, and the driver changes: the old verdict says nothing about the file now.
    writeFileSync(join(cwd, '.gitattributes'), '*.txt text\n')
    git(cwd, 'config', 'filter.crypt.smudge', `sh -c 'base64 -d; echo tail'`); trustRepositoryPrograms(cwd)
    const second = await takeSnapshotAsync(cwd, { reason: 'second' })
    expect(second.coverageGaps).toEqual([{ path: 'value.txt', reason: NOT_CHECKED }])
    expect(stored(secret)).toBe(false)
    expect(bytes().toString()).toBe(secret)
  })

  it('past the budget the rest is named not checked yet, and the next snapshots check it', async () => {
    ROUND_TRIP_BUDGET.files = 2
    filter('strip', "sed 's/ *$//'", 'cat', '*.txt')
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'value.txt']
    for (const name of names) writeFileSync(join(cwd, name), `${name}   \n`)
    const first = await takeSnapshotAsync(cwd, { reason: 'first' })
    expect(first.coverageGaps).toEqual(['c.txt', 'd.txt', 'value.txt'].map((path) => ({ path, reason: NOT_CHECKED })))
    expect((await snapshotUncoveredAsync(cwd, first.sha))?.exactGaps).toEqual(first.coverageGaps)
    const second = await takeSnapshotAsync(cwd, { reason: 'second' })
    expect(second.coverageGaps).toEqual([{ path: 'value.txt', reason: NOT_CHECKED }])
    const third = await takeSnapshotAsync(cwd, { reason: 'third' })
    expect(third.coverageGaps).toBeUndefined()
    expect(await exactPaths(third.sha)).toEqual(expect.arrayContaining(names))
    ROUND_TRIP_BUDGET.files = 500
    const action = await turn(() => { for (const name of names) writeFileSync(join(cwd, name), 'agent\n') })
    await undo()
    for (const name of names) expect(bytes(name).toString()).toBe(`${name}   \n`)
    expect(action.notCovered).toBeUndefined()
  })

  it('a slow smudge is stopped at the time budget, and later snapshots check the rest', async () => {
    filter('slow', "sed 's/ *$//'", `sh -c 'sleep 0.25; cat'`, '*.txt')
    const names = Array.from({ length: 24 }, (_, at) => `f${at}.txt`)
    for (const name of names) writeFileSync(join(cwd, name), `${name}   \n`)
    const started = Date.now()
    const first = await takeSnapshotAsync(cwd, { reason: 'first' })
    expect(Date.now() - started).toBeLessThan(4500)
    expect(first.coverageGaps?.length).toBeGreaterThan(0)
    for (let round = 0; round < 10 && (await takeSnapshotAsync(cwd, { reason: `round ${round}` })).coverageGaps; round++);
    const action = await turn(() => { for (const name of names) writeFileSync(join(cwd, name), 'agent\n') })
    await undo()
    for (const name of names) expect(bytes(name).toString()).toBe(`${name}   \n`)
    expect(action.startSha).toBeTruthy()
  })

  it('Git LFS: a snapshot never makes the smudge fetch, and a pointer naming the file\'s bytes holds them, so no media is stored', async () => {
    const store = join(f.root, 'lfs-store')
    mkdirSync(store)
    const clean = logging('lfs-clean.sh', `t=$(mktemp); cat > "$t"; h=$(shasum -a 256 "$t" | cut -c1-64); s=$(wc -c < "$t" | tr -d ' '); mv "$t" '${store}'/"$h"; printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %s\\n' "$h" "$s"`)
    // With GIT_LFS_SKIP_SMUDGE=1 (or `git lfs install --skip-smudge`) Git LFS gives the pointer back; otherwise it fetches.
    const smudge = logging('lfs-smudge.sh', `if [ "$GIT_LFS_SKIP_SMUDGE" = 1 ]; then cat; else echo fetch >> '${join(f.root, 'fetch.log')}'; h=$(sed -n 's/^oid sha256://p'); cat '${store}'/"$h"; fi`)
    git(cwd, 'config', 'filter.lfs.clean', `'${clean}' clean`); git(cwd, 'config', 'filter.lfs.smudge', `'${smudge}' smudge`); git(cwd, 'config', 'filter.lfs.required', 'true')
    commitAttributes('*.bin filter=lfs -text')
    trustRepositoryPrograms(cwd)
    const media = [0, 1, 2].map((at) => Buffer.from(`media ${at} `.repeat(20_000)))
    media.forEach((data, at) => writeFileSync(join(cwd, `m${at}.bin`), data))
    const action = await turn(() => writeFileSync(join(cwd, 'm0.bin'), 'agent\n'))
    expect(existsSync(join(f.root, 'fetch.log'))).toBe(false)
    expect(action.notCovered).toBeUndefined()
    expect(media.map((data) => stored(data))).toEqual([false, false, false])
    expect((await exactPaths(action.startSha)).filter((path) => path.endsWith('.bin'))).toEqual([])
    await undo()
    media.forEach((data, at) => expect(bytes(`m${at}.bin`).equals(data)).toBe(true))
  })

  it('a snapshot stores at most its byte budget of filtered files; the rest is named and stored by the next ones', async () => {
    ROUND_TRIP_BUDGET.storeBytes = 40
    filter('strip', "sed 's/ *$//'", 'cat', '*.txt')
    const names = ['a.txt', 'b.txt', 'value.txt']
    for (const name of names) writeFileSync(join(cwd, name), `${name} ${'x'.repeat(16)}   \n`)
    const first = await takeSnapshotAsync(cwd, { reason: 'first' })
    expect(first.coverageGaps?.map((gap) => gap.path)).toEqual(['b.txt', 'value.txt'])
    expect(first.coverageGaps?.[0]?.reason).toBe("not stored yet, as a snapshot stores at most 40 bytes of filtered files; only Git's form of it is kept")
    expect((await takeSnapshotAsync(cwd, { reason: 'second' })).coverageGaps?.map((gap) => gap.path)).toEqual(['value.txt'])
    expect((await takeSnapshotAsync(cwd, { reason: 'third' })).coverageGaps).toBeUndefined()
    await turn(() => { for (const name of names) writeFileSync(join(cwd, name), 'agent\n') })
    await undo()
    for (const name of names) expect(bytes(name).toString()).toBe(`${name} ${'x'.repeat(16)}   \n`)
  })

  it('a lossy filtered file whose name starts with a double quote is stored, and the rest of the exact tree stays', async () => {
    git(cwd, 'config', 'core.autocrlf', 'input')
    filter('strip', "sed 's/ *$//'", 'cat', '*.txt')
    writeFileSync(join(cwd, '"q.txt'), 'quoted   \n'); writeFileSync(join(cwd, 'crlf.md'), 'crlf\r\n')
    const action = await turn(() => { writeFileSync(join(cwd, '"q.txt'), 'agent\n'); writeFileSync(join(cwd, 'crlf.md'), 'agent\n') })
    expect(action.notCovered).toBeUndefined()
    expect(await exactPaths(action.startSha)).toEqual(expect.arrayContaining(['"q.txt', 'crlf.md']))
    await undo()
    expect(bytes('"q.txt').toString()).toBe('quoted   \n')
    expect(bytes('crlf.md').toString()).toBe('crlf\r\n')
  })

  it('a turn and its Undo name a file not checked yet only when the turn changed it', async () => {
    ROUND_TRIP_BUDGET.files = 1
    filter('strip', "sed 's/ *$//'", 'cat', '*.txt')
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(cwd, name), `${name}   \n`)
    const action = await turn(() => writeFileSync(join(cwd, 'c.txt'), 'agent\n'))
    expect(action.notCovered).toBe(`Not covered: c.txt (${NOT_CHECKED}, at the start of the turn).`)
    const undone = await undo()
    expect(undone.notice ?? '').not.toMatch(/\b[ab]\.txt\b/)
    // a.txt and b.txt were never touched; c.txt comes back in Git's form, as named.
    expect([bytes('a.txt').toString(), bytes('b.txt').toString(), bytes('c.txt').toString()]).toEqual(['a.txt   \n', 'b.txt   \n', 'c.txt\n'])
  })

  it('a smudge stopped at the deadline is stopped with Git: it never runs on after the snapshot', async () => {
    const started = join(f.root, 'smudge-started'), finished = join(f.root, 'smudge-finished')
    filter('slow', "sed 's/ *$//'", `sh -c 'echo $$ > "${started}"; sleep 3; echo finished > "${finished}"; cat'`)
    writeFileSync(join(cwd, 'value.txt'), 'slow original  \n')
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'probe' })
    expect(snapshot.coverageGaps).toEqual([{ path: 'value.txt', reason: NOT_CHECKED }])
    const pid = Number(readFileSync(started, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    execFileSync('sleep', ['3.2'])
    expect(existsSync(finished)).toBe(false)
    expect(bytes().toString()).toBe('slow original  \n')
  })

  it('copies a killed snapshot left are removed by the next one; nothing else in .git/mousse is', async () => {
    filter('strip', "sed 's/ *$//'", 'cat')
    const original = Buffer.from('crash temp raw original   \n')
    writeFileSync(join(cwd, 'value.txt'), original)
    const folder = join(cwd, '.git', 'mousse')
    mkdirSync(folder, { recursive: true })
    // A process that is gone, and this process before this snapshot: both left a copy of the bytes they were storing.
    const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
    for (const name of [`filtered-${gone}-abc123`, `filtered-${process.pid}-def456`]) { mkdirSync(join(folder, name)); writeFileSync(join(folder, name, '0'), original) }
    writeFileSync(join(folder, 'filtered-notes'), 'not a copy\n')
    const action = await turn('agent\n')
    expect(readdirSync(folder).filter((name) => name.startsWith('filtered-')).sort()).toEqual(['filtered-notes'])
    expect(readFileSync(join(folder, 'filtered-notes'), 'utf8')).toBe('not a copy\n')
    expect(action.notCovered).toBeUndefined()
    await undo()
    expect(bytes().equals(original)).toBe(true)
  })

  it('a file whose check cannot finish in the budget is asked last, so the files after it are checked and come back exactly', async () => {
    filter('strip', "sed 's/ *$//'", `sh -c 'case "$1" in a-slow.dat) sleep 3 ;; esac; cat' -- %f`, '*.dat')
    writeFileSync(join(cwd, 'a-slow.dat'), 'slow file\n')
    const names = Array.from({ length: 20 }, (_, at) => `b${String(at).padStart(2, '0')}.dat`)
    for (const name of names) writeFileSync(join(cwd, name), `${name}   \n`)
    const gaps: string[][] = []
    const times: number[] = []
    for (let round = 0; round < 3; round++) {
      const started = Date.now()
      gaps.push(((await takeSnapshotAsync(cwd, { reason: `round ${round}` })).coverageGaps ?? []).map((gap) => gap.path))
      times.push(Date.now() - started)
    }
    expect(gaps.at(-1)).toEqual(['a-slow.dat'])
    // Stopped twice, the slow file waits a few snapshots: the third takes none of the budget for it.
    expect(times[2]).toBeLessThan(1500)
    await turn(() => { for (const name of names) writeFileSync(join(cwd, name), 'agent\n') })
    await undo()
    for (const name of names) expect(bytes(name).toString()).toBe(`${name}   \n`)
  })

  it('files under a filter are never all held in memory at once: at most a bounded amount of their bytes is', async () => {
    filter('plain', 'cat', 'cat', '*.bin -text')
    for (let at = 0; at < 24; at++) writeFileSync(join(cwd, `m${String(at).padStart(2, '0')}.bin`), Buffer.alloc(20 * 1024 * 1024, at))
    // Every file is checked in this one snapshot, however slow the disk: the bound is on memory, not time.
    ROUND_TRIP_BUDGET.ms = 45_000
    const base = process.memoryUsage().arrayBuffers
    let peak = base
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers) }, 5)
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'memory' })
    clearInterval(timer)
    expect(snapshot.coverageGaps).toBeUndefined()
    expect((peak - base) / 1024 / 1024).toBeLessThan(200)
  })

  it('stores and checks share one time budget per snapshot', async () => {
    git(cwd, 'config', 'filter.strip.clean', "sed 's/ *$//'"); git(cwd, 'config', 'filter.strip.smudge', 'cat')
    git(cwd, 'config', 'filter.slow.clean', "sed 's/ *$//'"); git(cwd, 'config', 'filter.slow.smudge', `sh -c 'sleep 0.25; cat'`)
    commitAttributes('value.txt filter=strip\n*.dat filter=slow')
    trustRepositoryPrograms(cwd)
    writeFileSync(join(cwd, 'value.txt'), 'stored next time   \n')
    for (let at = 0; at < 20; at++) writeFileSync(join(cwd, `s${at}.dat`), `slow ${at}   \n`)
    // Every file is found lossy, and none stored: the snapshots may store nothing.
    ROUND_TRIP_BUDGET.storeBytes = 0
    for (let round = 0; round < 8; round++) if (((await takeSnapshotAsync(cwd, { reason: `check ${round}` })).coverageGaps ?? []).every((gap) => gap.reason.startsWith('not stored yet'))) break
    ROUND_TRIP_BUDGET.storeBytes = 200 * 1024 ** 2
    // The slow files change, so they are checked again; value.txt is stored from its earlier verdict, slowly.
    for (let at = 0; at < 20; at++) writeFileSync(join(cwd, `s${at}.dat`), `slow again ${at}   \n`)
    // Storing takes the whole budget, so the checks get none of their own: about 2 s more than the snapshot's own work.
    gitLauncher('*" hash-object -w --no-filters --stdin-paths "*', 'sleep 2')
    const started = Date.now()
    const snapshot = await takeSnapshotAsync(cwd, { reason: 'store and check' })
    const took = Date.now() - started
    process.env.PATH = previousPath
    expect(rawBlob(snapshot.exactTree!).toString()).toBe('stored next time   \n')
    expect(took).toBeLessThan(5200)
  })

  it('a filtered file .git/info/attributes also converts (text) is named as such and never read for a check', async () => {
    filter('counted', "sed 's/ *$//'", `'${logging('smudge.sh', 'cat')}' smudge`, 'other.txt')
    writeFileSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'info/attributes')), 'value.txt filter=counted text eol=crlf\n')
    writeFileSync(join(cwd, 'value.txt'), 'converted   \r\n')
    for (const reason of ['first', 'second']) {
      const snapshot = await takeSnapshotAsync(cwd, { reason })
      expect(snapshot.coverageGaps).toEqual([{ path: 'value.txt', reason: ".git/info/attributes converts it, so only Git's form of it is kept" }])
    }
    expect(smudges()).toBe(0)
    expect(bytes().toString()).toBe('converted   \r\n')
  })

  it('a repository whose path holds a double quote still stores lossy files', async () => {
    const quoted = join(f.root, 'quo"ted')
    execFileSync('cp', ['-R', cwd, quoted])
    cwd = quoted
    filter('strip', "sed 's/ *$//'", 'cat')
    const original = Buffer.from('spaces in a quoted repository   \n')
    writeFileSync(join(cwd, 'value.txt'), original)
    const action = await turn('agent\n')
    expect(action.notCovered).toBeUndefined()
    await undo()
    expect(bytes().equals(original)).toBe(true)
  })
})
