import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withGitMutationLocks } from '../src/mms/actions/GitOperationCoordinator'
import { releaseSnapshotRefs, releaseThreadSnapshots } from '../src/mms/actions/SnapshotRefReleaseService'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { resolveReviewScope } from '../src/mms/actions/reviewRange'
import { configureSnapshotLimits, isUnsafeSnapshotRoot, SnapshotRefusedError, takeSnapshot } from '../src/mms/actions/snapshots'
import { ChangeReceiptService } from '../src/mms/actions/ChangeReceiptService'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { inHiddenStore } from '../src/mms/git/hiddenStore'
import { isGitRepository, listChangedFiles, readFileVersions } from '../src/mms/git/reviewDiff'
import { restoreDiff } from '../src/mms/run/workspace/restoreSafety'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { WorkspaceResolver } from '../src/mms/workspace/WorkspaceResolver'
import { activeHiddenStore } from '../src/mms/git/hiddenStore'
import { tryGit } from '../src/mms/actions/git'
import { ensureSnapshotWorkspace, inThreadSnapshotScope, loadSnapshotWorkspace, projectStorePath, snapshotsOffReason, threadSnapshotStore, threadStorePath } from '../src/mms/workspace/SnapshotWorkspace'
import { actionOptions } from './fixtures/gitFoundation'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let root: string
let home: string
let previousHome: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-snapshot-workspace-'))
  home = join(root, 'home')
  mkdirSync(home)
  previousHome = process.env.MOUSSE_HOME
  process.env.MOUSSE_HOME = home
})
afterEach(() => {
  configureSnapshotLimits()
  if (previousHome === undefined) delete process.env.MOUSSE_HOME
  else process.env.MOUSSE_HOME = previousHome
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const folder = (name: string): string => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path }
const write = (dir: string, path: string, value: string): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), value)
}

/** A thread of a project without Git (or of no project, when `projectId` is left out) over `work`. */
function thread(name: string, work: string, projectId?: string) {
  const directory = folder(`thread-${name}`)
  const space = ensureSnapshotWorkspace({ threadDirectory: directory, threadId: name, workTree: work, ...(projectId ? { projectId } : {}) })
  const actions = new ThreadActionService(directory)
  let at = 0
  const turn = <T>(id: string, mutate: () => T) => {
    const start = at
    at += 2
    return actions.runCheckpointedAction({ ...actionOptions(space.record.workTree, id), threadId: name, presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)
  }
  const undo = () => new UndoService(directory).undoLatest('main', space.record.workTree)
  /** `git` in the store, as the code under test sees the folder. */
  const store = (...args: string[]) => git(space.store.gitDir, ...args)
  return { directory, space, actions, turn, undo, store, work: space.record.workTree }
}

describe('a hidden store keeps exact bytes', () => {
  let previousGlobal: string | undefined
  /** The person's global Git config for the test, as `~/.gitconfig` would be. */
  const globalConfig = (text: string): void => {
    const path = join(root, 'global.gitconfig')
    writeFileSync(path, text)
    previousGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = path
  }
  afterEach(() => {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    previousGlobal = undefined
  })
  /** The blob a snapshot holds for `path`, byte for byte. */
  const blob = (t: ReturnType<typeof thread>, sha: string, path: string): Buffer =>
    execFileSync('git', ['--git-dir', t.space.store.gitDir, 'cat-file', 'blob', `${sha}:${path}`], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })

  it('ignores a clean filter in the person’s global config and the folder’s attributes, and Undo restores the original', async () => {
    const attributes = join(root, 'global.gitattributes')
    writeFileSync(attributes, '* filter=upper\n')
    globalConfig(`[filter "upper"]\n\tclean = tr a-z A-Z\n\tsmudge = cat\n[core]\n\tattributesFile = ${attributes}\n`)
    const work = folder('work')
    write(work, 'a.txt', 'original lowercase\n')
    write(work, '.gitattributes', '*.md filter=upper\n')
    write(work, 'b.md', 'also lowercase\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { write(work, 'a.txt', 'changed\n'); write(work, 'b.md', 'changed too\n') })
    expect(blob(t, action.startSha, 'a.txt').toString()).toBe('original lowercase\n')
    expect(blob(t, action.endSha, 'b.md').toString()).toBe('changed too\n')
    await t.undo()
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('original lowercase\n')
    expect(readFileSync(join(work, 'b.md'), 'utf8')).toBe('also lowercase\n')
  })

  it('converts no line endings, whatever core.autocrlf or the folder’s eol attributes say', async () => {
    globalConfig('[core]\n\tautocrlf = true\n\tsafecrlf = true\n')
    const work = folder('work')
    const mixed = Buffer.from('one\r\ntwo\nthree\r\n')
    const lf = Buffer.from('lf only\n')
    write(work, '.gitattributes', '* text eol=crlf\n')
    writeFileSync(join(work, 'mixed.txt'), mixed)
    writeFileSync(join(work, 'lf.txt'), lf)
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { writeFileSync(join(work, 'mixed.txt'), 'gone\n'); writeFileSync(join(work, 'lf.txt'), 'gone\r\n') })
    expect(blob(t, action.startSha, 'mixed.txt').equals(mixed)).toBe(true)
    expect(blob(t, action.startSha, 'lf.txt').equals(lf)).toBe(true)
    expect(blob(t, action.endSha, 'lf.txt').toString()).toBe('gone\r\n')
    await t.undo()
    expect(readFileSync(join(work, 'mixed.txt')).equals(mixed)).toBe(true)
    expect(readFileSync(join(work, 'lf.txt')).equals(lf)).toBe(true)
  })
})

describe('a project without Git', () => {
  it('records a turn as a snapshot, Undo restores the files, and the folder never gains a .git', async () => {
    const work = folder('work')
    write(work, 'keep.txt', 'before\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => {
      write(work, 'keep.txt', 'after\n')
      write(work, 'src/new.ts', 'export {}\n')
    })
    expect(action).toMatchObject({ state: 'completed', reversible: true, commits: [] })
    expect(action.startSha).not.toBe(action.endSha)
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['keep.txt', 'src/new.ts'])
    // A snapshot has no parent: there is no HEAD to hang it on, and no Git record of a branch.
    expect(t.store('rev-list', '--parents', '-n', '1', action.endSha)).toBe(action.endSha)
    expect(action.git).toMatchObject({ rewroteHistory: false })
    expect(action.git?.headAfter).toBeUndefined()
    expect(action.git?.branchAfter).toBeUndefined()
    // The store pins the thread's latest snapshot and the receipt's pair.
    expect(t.store('rev-parse', 'refs/mousse/threads/a/main')).toBe(action.endSha)
    const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
    expect(t.store('rev-parse', receipt.retainedRefs[0]!)).toBe(action.startSha)
    expect(t.store('rev-parse', receipt.retainedRefs[1]!)).toBe(action.endSha)
    expect(loadSnapshotWorkspace(t.directory)?.record.snapshotSha).toBe(action.endSha)

    await t.undo()
    expect(readFileSync(join(work, 'keep.txt'), 'utf8')).toBe('before\n')
    expect(existsSync(join(work, 'src', 'new.ts'))).toBe(false)
    expect(readdirSync(work).sort()).toEqual(['keep.txt'])
    expect(existsSync(join(work, '.git'))).toBe(false)
    expect(existsSync(t.space.store.gitDir)).toBe(true)
    expect(t.space.store.gitDir).toBe(projectStorePath('project-1', home))
  })

  it('the folder is not a repository to anything outside the store’s own scope', async () => {
    const work = folder('work')
    write(work, 'a.txt', 'a\n')
    const t = thread('a', work, 'project-1')
    await t.turn('turn', () => write(work, 'b.txt', 'b\n'))
    expect(() => git(work, 'rev-parse', '--git-dir')).toThrow()
    expect(await isGitRepository(work)).toBe(false)
    // The store is the thread's, found from its own record; another thread's directory has none.
    expect(threadSnapshotStore(t.directory, work)?.gitDir).toBe(t.space.store.gitDir)
    expect(threadSnapshotStore(folder('thread-other'), work)).toBeUndefined()
  })

  it('keeps what the folder’s own .gitignore and the built-in list leave out of every snapshot', async () => {
    const work = folder('work')
    write(work, '.gitignore', 'secret.txt\nlogs/\n')
    write(work, 'secret.txt', 'hidden\n'); write(work, 'logs/run.log', 'log\n')
    write(work, 'node_modules/pkg/index.js', 'x\n'); write(work, '.venv/bin/python', 'x\n'); write(work, 'venv/pyvenv.cfg', 'x\n')
    write(work, '__pycache__/m.pyc', 'x\n'); write(work, '.DS_Store', 'x\n'); write(work, 'dist/out.js', 'x\n'); write(work, 'build/out.o', 'x\n')
    write(work, 'target/debug/app', 'x\n'); write(work, '.next/cache', 'x\n'); write(work, '.cache/x', 'x\n')
    write(work, '.mousse/state.json', '{}\n')
    write(work, 'src/build/keep.ts', 'a source folder that happens to be called build\n')
    write(work, 'src/node_modules/inner.js', 'x\n')
    write(work, 'kept.txt', 'kept\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => write(work, 'added.txt', 'added\n'))
    expect(t.store('ls-tree', '-r', '--name-only', action.endSha).split('\n')).toEqual(['.gitignore', 'added.txt', 'kept.txt', 'src/build/keep.ts'])
    // What the built-in list leaves out is named; the folder's own .gitignore, Git's and Mousse's folders and caches are not.
    const reported = { path: expect.any(String), reason: 'dependency or build folder, never kept in snapshots' }
    expect(action.git?.coverageGaps?.map((gap) => gap.path).sort()).toEqual(['.cache', '.next', '.venv', 'build', 'dist', 'node_modules', 'src/node_modules', 'target', 'venv'])
    expect(action.git?.coverageGaps?.every((gap) => gap.reason === reported.reason)).toBe(true)
    const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
    expect(receipt.notCovered).toMatch(/^Not covered: .*node_modules \(dependency or build folder, never kept in snapshots\)/)
    expect(action.notCovered).toBe(receipt.notCovered)
    expect(action.reversible).toBe(true)
  })

  it('keeps the built-in list out even when the folder’s .gitignore takes it back in, and names what it left out', async () => {
    const work = folder('work')
    write(work, '.gitignore', '!node_modules/\n!dist/\n!.mousse/\n')
    write(work, 'node_modules/pkg/index.js', 'x\n'); write(work, 'dist/out.js', 'x\n'); write(work, '.mousse/state.json', '{}\n')
    write(work, 'kept.txt', 'kept\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { write(work, 'node_modules/pkg/index.js', 'y\n'); write(work, 'added.txt', 'added\n') })
    expect(t.store('ls-tree', '-r', '--name-only', action.endSha).split('\n')).toEqual(['.gitignore', 'added.txt', 'kept.txt'])
    expect(t.store('ls-tree', '-r', '--name-only', action.startSha).split('\n')).toEqual(['.gitignore', 'kept.txt'])
    // What is named is what the snapshot does not hold.
    expect(action.git?.coverageGaps?.map((gap) => gap.path).sort()).toEqual(['dist', 'node_modules'])
    // Undo takes back the recorded files and leaves the folders it never held as they are.
    await t.undo()
    expect(existsSync(join(work, 'added.txt'))).toBe(false)
    expect(readFileSync(join(work, 'node_modules/pkg/index.js'), 'utf8')).toBe('y\n')
  })

  it('treats a repository with no commit the same, and leaves its own .git alone', async () => {
    const work = folder('work')
    git(work, 'init', '-q')
    write(work, 'a.txt', 'a\n')
    const gitFiles = (): string => execFileSync('find', ['.git', '-type', 'f', '-not', '-name', '*.sample'], { cwd: work, encoding: 'utf8' }).split('\n').sort().join('\n')
    const before = gitFiles()
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => write(work, 'b.txt', 'b\n'))
    expect(t.store('ls-tree', '-r', '--name-only', action.endSha).split('\n')).toEqual(['a.txt', 'b.txt'])
    await t.undo()
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
    expect(gitFiles()).toBe(before)
    expect(git(work, 'for-each-ref')).toBe('')
    expect(git(work, 'status', '--porcelain')).toBe('?? a.txt')
  })

  it('keeps the store a thread started with after git init, while a new thread uses the repository', async () => {
    const work = folder('work')
    write(work, 'a.txt', 'one\n')
    const t = thread('a', work, 'project-1')
    const first = await t.turn('first', () => { write(work, 'a.txt', 'two\n'); write(work, 'b.txt', 'b\n') })
    expect(first.action.reversible).toBe(true)

    // The person makes the folder a repository with a commit, and stages another file.
    const identity = ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.test']
    git(work, 'init', '-q', '-b', 'main')
    git(work, 'add', 'a.txt')
    git(work, ...identity, 'commit', '-q', '-m', 'init')
    write(work, 'staged.txt', 'staged\n')
    git(work, 'add', 'staged.txt')
    const repository = () => ({ head: git(work, 'rev-parse', 'HEAD'), index: git(work, 'ls-files', '--stage'), branches: git(work, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads') })
    const before = repository()
    const storeRefs = t.store('for-each-ref', '--format=%(refname)')

    // The thread keeps its store: no worktree is made for it, and its turns and Undo run there.
    const resolved = await new WorkspaceResolver(t.directory, 'a', work).resolve('agent')
    expect(resolved).toMatchObject({ lifecycle: 'unprovisioned', capability: { checkpointable: false, unavailableReason: 'snapshot-store' } })
    expect(new ThreadWorkspaceManager(t.directory).load()).toBeUndefined()
    const second = await t.turn('second', () => { write(work, 'a.txt', 'three\n'); write(work, 'c.txt', 'c\n') })
    expect(second.action.reversible).toBe(true)
    expect(t.store('ls-tree', '-r', '--name-only', second.action.endSha).split('\n')).toEqual(['a.txt', 'b.txt', 'c.txt', 'staged.txt'])
    // A file the person committed is restored from the store, like any other.
    await t.undo()
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('two\n')
    expect(existsSync(join(work, 'c.txt'))).toBe(false)
    // The turn before git init is still reviewed from the store.
    const earlier = resolveReviewScope(t.directory, { kind: 'turn', turnId: 'first' })!
    expect(earlier.unavailable).toBeUndefined()
    const listed = await inThreadSnapshotScope(t.directory, work, () => listChangedFiles(work, earlier.range))
    expect(listed.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    // Undo restored files only: the person's HEAD, index and branches are as they left them.
    expect(repository()).toEqual(before)
    expect(readFileSync(join(work, 'staged.txt'), 'utf8')).toBe('staged\n')
    expect(git(work, 'status', '--porcelain')).toBe('A  staged.txt\n?? b.txt')

    // A new thread on the folder uses the repository: Mousse's Git for it never goes through the other thread's store.
    const fresh = folder('thread-new')
    await withGitMutationLocks(fresh, work, 'new thread', () => {
      expect(activeHiddenStore(work)).toBeUndefined()
      expect(tryGit(work, ['rev-parse', 'HEAD']).stdout).toBe(before.head)
    })
    expect(inThreadSnapshotScope(fresh, work, () => tryGit(work, ['rev-parse', 'HEAD']).stdout)).toBe(before.head)
    expect(inThreadSnapshotScope(t.directory, work, () => tryGit(work, ['rev-parse', '--verify', '-q', 'HEAD']).ok)).toBe(false)
    expect(t.store('for-each-ref', '--format=%(refname)').split('\n')).toEqual(expect.arrayContaining(storeRefs.split('\n')))
  })

  it('names a nested repository with uncommitted changes, from its own Git, and not a clean one', async () => {
    const work = folder('work')
    write(work, 'a.txt', 'a\n')
    const identity = ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.test']
    for (const name of ['clean', 'dirty']) {
      const nested = folder(`work/${name}`)
      git(nested, 'init', '-q')
      write(nested, 'lib.txt', 'one\n')
      git(nested, 'add', 'lib.txt')
      git(nested, ...identity, 'commit', '-q', '-m', 'init')
    }
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => write(work, 'dirty/lib.txt', 'two\n'))
    expect(action.git?.coverageGaps).toEqual([{ path: 'dirty', reason: 'nested repository; only its commit is recorded' }])
    expect(action.notCovered).toBe('Not covered: dirty (nested repository; only its commit is recorded).')
    // The nested repositories are their own: their HEAD and status are as their owner left them.
    expect(git(join(work, 'dirty'), 'status', '--porcelain')).toBe('M lib.txt')
    expect(git(join(work, 'clean'), 'status', '--porcelain')).toBe('')
  })

  it('leaves a nested repository with no commit out of the snapshot instead of turning Undo off', async () => {
    const work = folder('work')
    write(work, 'a.txt', 'a\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => {
      write(work, 'b.txt', 'b\n')
      git(folder('work/tool'), 'init', '-q'); write(work, 'tool/x.txt', 'x\n')
    })
    expect(action).toMatchObject({ state: 'completed', reversible: true })
    expect(action.notice).toBeUndefined()
    expect(t.store('ls-tree', '-r', '--name-only', action.endSha).split('\n')).toEqual(['a.txt', 'b.txt'])
    await t.undo()
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
    expect(readFileSync(join(work, 'tool', 'x.txt'), 'utf8')).toBe('x\n')
  })

  it('records the user’s own edits between turns as an action of theirs, which Undo of the turn leaves alone', async () => {
    const work = folder('work')
    const t = thread('a', work, 'project-1')
    await t.turn('first', () => write(work, 'agent.txt', 'agent\n'))
    write(work, 'mine.txt', 'mine\n')
    const { action } = await t.turn('second', () => write(work, 'second.txt', 'second\n'), 2)
    const recorded = t.actions.list().find((item) => item.turnId.startsWith('user-changes:'))!
    expect(recorded).toMatchObject({ actor: { kind: 'user' }, state: 'completed' })
    expect(recorded.changedPaths.map((item) => item.path)).toEqual(['mine.txt'])
    expect(action.startSha).toBe(recorded.endSha)
    await t.undo()
    expect(existsSync(join(work, 'second.txt'))).toBe(false)
    expect(readFileSync(join(work, 'mine.txt'), 'utf8')).toBe('mine\n')
  })

  it('threads that share the folder: an edit that overlaps another thread’s refuses the Undo, names the file and changes nothing', async () => {
    const work = folder('work')
    write(work, 'shared.txt', 'one\ntwo\nthree\n')
    const a = thread('a', work, 'project-1')
    const b = thread('b', work, 'project-1')
    // One store for the project, whoever the thread is.
    expect(a.space.store.gitDir).toBe(b.space.store.gitDir)

    await a.turn('turn-a', () => { write(work, 'a.txt', 'a\n'); write(work, 'shared.txt', 'ONE\ntwo\nthree\n') })
    await b.turn('turn-b', () => { write(work, 'b.txt', 'b\n'); write(work, 'shared.txt', 'Uno\ntwo\nTHREE\n') })

    // Both changed the first line, differently: A's Undo would overwrite B's edit.
    await expect(a.undo()).rejects.toThrow(/shared\.txt/)
    expect(readFileSync(join(work, 'shared.txt'), 'utf8')).toBe('Uno\ntwo\nTHREE\n')
    expect(existsSync(join(work, 'a.txt'))).toBe(true)
    expect(existsSync(join(work, 'b.txt'))).toBe(true)

    // B undoes its own turn first: A's work is still there, B's is gone, and A's Undo then goes through.
    await b.undo()
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
    expect(readFileSync(join(work, 'shared.txt'), 'utf8')).toBe('ONE\ntwo\nthree\n')
    await a.undo()
    expect(readFileSync(join(work, 'shared.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(existsSync(join(work, 'a.txt'))).toBe(false)
  })

  it('edits to other lines of the same file survive another thread’s Undo', async () => {
    const work = folder('work')
    write(work, 'shared.txt', 'one\ntwo\nthree\n')
    const a = thread('a', work, 'project-1')
    const b = thread('b', work, 'project-1')
    await a.turn('turn-a', () => write(work, 'shared.txt', 'ONE\ntwo\nthree\n'))
    await b.turn('turn-b', () => write(work, 'shared.txt', 'ONE\ntwo\nTHREE\n'))
    await a.undo()
    expect(readFileSync(join(work, 'shared.txt'), 'utf8')).toBe('one\ntwo\nTHREE\n')
  })

  it('Undo of one thread keeps the files another thread wrote to the same folder', async () => {
    const work = folder('work')
    const a = thread('a', work, 'project-1')
    const b = thread('b', work, 'project-1')
    await a.turn('turn-a', () => write(work, 'a.txt', 'a\n'))
    await b.turn('turn-b', () => write(work, 'b.txt', 'b\n'))
    await a.undo()
    expect(existsSync(join(work, 'a.txt'))).toBe(false)
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('b\n')
    // B's history is whole: its own Undo still works.
    await b.undo()
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
  })

  it('serializes the threads of one folder on the store, not on the thread', async () => {
    const work = folder('work')
    const a = thread('a', work, 'project-1')
    const b = thread('b', work, 'project-1')
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = withGitMutationLocks(a.directory, work, 'first', async () => { order.push('a in'); await held; order.push('a out') })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = withGitMutationLocks(b.directory, work, 'second', () => { order.push('b in') })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(order).toEqual(['a in'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['a in', 'a out', 'b in'])
  })

  it('a folder past the limit makes no snapshot and says so, and the thread keeps its place', async () => {
    const work = folder('work')
    for (let index = 0; index < 5; index += 1) write(work, `f${index}.txt`, 'x\n')
    configureSnapshotLimits({ files: 4 })
    const t = thread('a', work, 'project-1')
    await expect(t.actions.recordOutsideChanges({ threadId: 'a', conversationBranchId: 'main', workspacePath: work })).rejects.toThrow(/Undo is off for this folder because it is too large/)
    await expect(t.actions.recordOutsideChanges({ threadId: 'a', conversationBranchId: 'main', workspacePath: work })).rejects.toBeInstanceOf(SnapshotRefusedError)
    expect(t.actions.list()).toEqual([])
    // Nothing of the folder was added to the store, and nothing was written into the folder.
    expect(git(t.space.store.gitDir, 'for-each-ref')).toBe('')
    expect(readdirSync(work).sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'])
    // When it fits again the next turn is recorded as usual.
    configureSnapshotLimits()
    const { action } = await t.turn('turn', () => write(work, 'g.txt', 'g\n'))
    expect(action.reversible).toBe(true)
  })

  it('refuses a folder past the total size', async () => {
    const work = folder('work')
    write(work, 'big.bin', 'x'.repeat(200))
    configureSnapshotLimits({ bytes: 100 })
    const t = thread('a', work, 'project-1')
    await expect(t.actions.recordOutsideChanges({ threadId: 'a', conversationBranchId: 'main', workspacePath: work })).rejects.toThrow(/too large \(more than 100 bytes\)/)
  })

  it('leaves a file over the size limit out, names it, and still records and undoes the rest', async () => {
    const work = folder('work')
    write(work, 'small.txt', 'one\n')
    write(work, 'big.bin', 'x'.repeat(200))
    configureSnapshotLimits({ fileBytes: 100 })
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { write(work, 'small.txt', 'two\n'); write(work, 'big.bin', 'y'.repeat(300)) })
    expect(action).toMatchObject({ state: 'completed', reversible: true })
    expect(t.store('ls-tree', '-r', '--name-only', action.endSha).split('\n')).toEqual(['small.txt'])
    expect(action.git?.coverageGaps).toEqual([{ path: 'big.bin', reason: 'over 100 bytes' }])
    const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
    expect(receipt.notCovered).toBe('Not covered: big.bin (over 100 bytes).')
    // Undo takes back what was recorded and never touches the file it left out.
    await t.undo()
    expect(readFileSync(join(work, 'small.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(work, 'big.bin'), 'utf8')).toBe('y'.repeat(300))
  })

  it('never deletes a file the start left out: the turn records both sides’ gaps, and Undo leaves it and says why', async () => {
    const work = folder('work')
    write(work, 'small.txt', 'one\n')
    write(work, 'data.bin', 'x'.repeat(200))
    configureSnapshotLimits({ fileBytes: 100 })
    const t = thread('a', work, 'project-1')
    // The agent shrinks the file below the limit: the end records it, the start never did.
    const { action } = await t.turn('turn', () => { write(work, 'data.bin', 'small now'); write(work, 'small.txt', 'two\n') })
    expect(action.git?.coverageGaps).toEqual([{ path: 'data.bin', reason: 'over 100 bytes, at the start of the turn' }])
    expect(action.notCovered).toBe('Not covered: data.bin (over 100 bytes, at the start of the turn).')
    const undone = await t.undo()
    expect(readFileSync(join(work, 'small.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(work, 'data.bin'), 'utf8')).toBe('small now')
    expect(undone.notice).toContain('Left as it is: data.bin (not covered at the start of the turn).')
  })

  it('never deletes a file that was ignored at the start and that the turn un-ignored', async () => {
    const work = folder('work')
    write(work, '.gitignore', 'secret.txt\n')
    write(work, 'secret.txt', 'keep me\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { write(work, '.gitignore', ''); write(work, 'notes.txt', 'new\n') })
    expect(t.store('ls-tree', '-r', '--name-only', action.endSha).split('\n')).toContain('secret.txt')
    const undone = await t.undo()
    expect(readFileSync(join(work, '.gitignore'), 'utf8')).toBe('secret.txt\n')
    expect(existsSync(join(work, 'notes.txt'))).toBe(false)
    expect(readFileSync(join(work, 'secret.txt'), 'utf8')).toBe('keep me\n')
    expect(undone.notice).toContain('Left as it is: secret.txt (not covered at the start of the turn).')
  })

  it('leaves a file that grew past the limit during the turn, says so, and restores the rest', async () => {
    const work = folder('work')
    write(work, 'small.txt', 'one\n')
    write(work, 'data.bin', 'x'.repeat(50))
    configureSnapshotLimits({ fileBytes: 100 })
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { write(work, 'data.bin', 'y'.repeat(300)); write(work, 'small.txt', 'two\n') })
    expect(action).toMatchObject({ reversible: true })
    expect(action.notCovered).toBe('Not covered: data.bin (over 100 bytes).')
    const undone = await t.undo()
    expect(readFileSync(join(work, 'small.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(work, 'data.bin'), 'utf8')).toBe('y'.repeat(300))
    expect(undone.notice).toContain('Left as it is: data.bin (not covered now: over 100 bytes).')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('leaves an unreadable file out and names it, as in a worktree', async () => {
    const work = folder('work')
    write(work, 'a.txt', 'a\n')
    write(work, 'locked.txt', 'secret\n')
    const t = thread('a', work, 'project-1')
    chmodSync(join(work, 'locked.txt'), 0o000)
    try {
      const { action } = await t.turn('turn', () => write(work, 'b.txt', 'b\n'))
      expect(action).toMatchObject({ state: 'completed', reversible: true })
      expect(action.git?.coverageGaps).toContainEqual({ path: 'locked.txt', reason: 'unreadable' })
      expect(action.notCovered).toMatch(/locked\.txt \(unreadable\)/)
    } finally {
      chmodSync(join(work, 'locked.txt'), 0o600)
    }
    expect(readFileSync(join(work, 'locked.txt'), 'utf8')).toBe('secret\n')
  })

  it('a turn that makes the folder too large is recorded without its files, cannot be undone, and says why', async () => {
    const work = folder('work')
    write(work, 'a.txt', 'a\n')
    const t = thread('a', work, 'project-1')
    configureSnapshotLimits({ files: 3 })
    const { action } = await t.turn('turn', () => { for (let index = 0; index < 5; index += 1) write(work, `n${index}.txt`, 'x\n') })
    expect(action).toMatchObject({ state: 'completed', reversible: false, changedPaths: [] })
    expect(action.endSha).toBe(action.startSha)
    // Reported as Git threads report a snapshot that could not be taken: the whole folder is not covered.
    expect(action.git?.coverageGaps).toEqual([{ path: '.', reason: 'too large (more than 3 files)' }])
    expect(action.notCovered).toBe('Not covered: . (too large (more than 3 files)).')
    const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
    expect(receipt.notCovered).toBe(action.notCovered)
    expect(snapshotsOffReason(t.directory)).toMatch(/too large/)
    // The files are still there: nothing was taken back or lost.
    expect(readdirSync(work)).toHaveLength(6)
    await expect(t.undo()).rejects.toThrow(/cannot be reversed/)
  })

  it('never snapshots a home or system folder', () => {
    expect(isUnsafeSnapshotRoot('/')).toBe(true)
    expect(isUnsafeSnapshotRoot(homedir())).toBe(true)
    expect(isUnsafeSnapshotRoot(join(homedir(), '..'))).toBe(true)
    expect(isUnsafeSnapshotRoot(join(root, 'project'), join(root, 'project'))).toBe(true)
    expect(isUnsafeSnapshotRoot(join(root, 'project', 'inside'), join(root, 'project'))).toBe(false)
    const directory = folder('thread-home')
    expect(() => ensureSnapshotWorkspace({ threadDirectory: directory, threadId: 'home', workTree: homedir(), projectId: 'p' })).toThrow(/home or system folder/)
    expect(() => ensureSnapshotWorkspace({ threadDirectory: directory, threadId: 'root', workTree: '/', projectId: 'p' })).toThrow(SnapshotRefusedError)
    expect(existsSync(join(directory, 'snapshot-workspace.json'))).toBe(false)
    // Even a store that was somehow pointed at one refuses to take a snapshot.
    const work = folder('work')
    const t = thread('a', work, 'project-1')
    expect(() => inHiddenStore({ workTree: homedir(), gitDir: t.space.store.gitDir }, () => takeSnapshot(homedir(), { reason: 'never' }))).toThrow(/home or system folder/)
  })

  it('reviews a turn from the store: the changed files with their counts, and both sides of each', async () => {
    const work = folder('work')
    write(work, 'keep.txt', 'one\ntwo\n')
    const t = thread('a', work, 'project-1')
    const { action } = await t.turn('turn', () => { write(work, 'keep.txt', 'one\ntwo\nthree\n'); write(work, 'new.txt', 'new\n') })
    const scope = resolveReviewScope(t.directory, { kind: 'turn', turnId: 'turn' })!
    expect(scope.unavailable).toBeUndefined()
    expect(scope.cwd).toBe(work)
    // Read in the thread's scope, as the review does; outside it the folder is just a folder.
    const read = <T>(work: () => T): T => inThreadSnapshotScope(t.directory, scope.cwd, work)
    const listed = await read(() => listChangedFiles(scope.cwd, scope.range))
    expect(listed.files.map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: 'keep.txt', status: 'modified', additions: 1, deletions: 0 },
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0 }
    ])
    const versions = await read(() => readFileVersions(scope.cwd, scope.range, 'keep.txt'))
    expect(versions.original).toMatchObject({ content: 'one\ntwo\n' })
    expect(versions.modified).toMatchObject({ content: 'one\ntwo\nthree\n' })
    // The restore review the gate shows is the same store's diff.
    expect(restoreDiff(t.directory, work, action.endSha, action.startSha)).toContain('-three')
    // The whole thread, from its first recorded action to the folder now.
    const whole = resolveReviewScope(t.directory, { kind: 'thread' })!
    expect(whole.range.from).toEqual({ kind: 'commit', sha: action.startSha })
    write(work, 'later.txt', 'later\n')
    expect((await read(() => listChangedFiles(whole.cwd, whole.range))).files.map((file) => file.path).sort()).toEqual(['keep.txt', 'later.txt', 'new.txt'])
  })

  it('offers the snapshot workspace to Undo and review as metadata, and the worktree code never sees it', async () => {
    const work = folder('work')
    const t = thread('a', work, 'project-1')
    await t.turn('turn', () => write(work, 'a.txt', 'a\n'))
    const manager = new ThreadWorkspaceManager(t.directory)
    expect(manager.load()).toBeUndefined()
    expect(existsSync(join(t.directory, 'workspace.json'))).toBe(false)
    expect(manager.loadOrSnapshot()).toMatchObject({ threadId: 'a', lifecycle: 'ready', worktreePath: work, conversationBranchId: 'main', snapshotOnly: true, retainedRef: 'refs/mousse/threads/a/main' })
  })
})

describe('a thread with no project', () => {
  it('records its turns in a store of its own in its data, and Undo restores its scratch folder', async () => {
    const scratch = folder('scratch')
    const t = thread('solo', scratch)
    expect(t.space.record.kind).toBe('standalone')
    expect(t.space.store.gitDir).toBe(threadStorePath('solo', home))
    const { action } = await t.turn('turn', () => { write(scratch, 'notes.md', '# notes\n'); write(scratch, 'out/result.txt', 'result\n') })
    expect(action.changedPaths.map((item) => item.path).sort()).toEqual(['notes.md', 'out/result.txt'])
    await t.undo()
    expect(readdirSync(scratch)).toEqual([])
    expect(existsSync(join(scratch, '.git'))).toBe(false)
    expect(existsSync(join(home, 'project-data'))).toBe(false)
  })

  it('keeps its store beside the project stores, and removes it when the thread is deleted for good', async () => {
    const scratch = folder('scratch')
    const t = thread('solo', scratch)
    await t.turn('turn', () => write(scratch, 'notes.md', '# notes\n'))
    expect(t.space.store.gitDir).toBe(join(home, 'thread-snapshots', 'solo', 'snapshots.git'))
    expect(existsSync(join(t.directory, 'snapshots.git'))).toBe(false)
    expect(await releaseThreadSnapshots(t.directory)).toEqual([])
    expect(existsSync(join(home, 'thread-snapshots', 'solo'))).toBe(false)
    // The scratch folder is the runtime's and stays as it is.
    expect(readFileSync(join(scratch, 'notes.md'), 'utf8')).toBe('# notes\n')
  })

  it('follows the folder when its runtime keeps the thread in another one, and keeps the history it had', async () => {
    const first = folder('scratch-one')
    const t = thread('solo', first)
    await t.turn('turn', () => write(first, 'a.txt', 'a\n'))
    const second = folder('scratch-two')
    write(second, 'other.txt', 'other\n')
    const moved = ensureSnapshotWorkspace({ threadDirectory: t.directory, threadId: 'solo', workTree: second })
    expect(moved.record.workTree).toBe(second)
    expect(moved.record.snapshotSha).toBe(t.actions.list().at(-1)!.endSha)
    const { action } = await new ThreadActionService(t.directory).runCheckpointedAction({ ...actionOptions(second, 'in-two'), threadId: 'solo', presentationMessageStart: 2, presentationMessageEnd: 4 }, () => write(second, 'b.txt', 'b\n'))
    expect(action.changedPaths.map((item) => item.path)).toContain('b.txt')
  })
})

describe('what happens to a store when its owner goes', () => {
  async function aged(name: string, work: string, projectId: string | undefined) {
    const t = thread(name, work, projectId)
    const { action } = await t.turn(`turn-${name}`, () => write(work, `${name}.txt`, `${name}\n`))
    const receipt = new ChangeReceiptService(t.directory).list().find((item) => item.id === action.receiptId)!
    return { ...t, action, receipt }
  }

  it('releases the refs of an expired Undo, collects the garbage in the store, and keeps the pin and the other thread’s refs', async () => {
    const work = folder('work')
    const a = await aged('a', work, 'project-1')
    const b = await aged('b', work, 'project-1')
    // The clock moves ahead in steps the policy allows, as the hourly sweep would, until the Undo of A's turn has expired.
    const DAY = 24 * 60 * 60 * 1000
    const start = Date.now()
    for (const day of [0, 6, 12, 18, 24, 30, 36, 42]) await new UndoRetentionService(a.directory, () => start + day * DAY).sweep(work)
    const now = () => start + 42 * DAY
    expect(new UndoRetentionService(a.directory, now).expiredReceiptIds().has(a.receipt.id)).toBe(true)
    const [before, after] = a.receipt.retainedRefs as [string, string]
    expect(a.store('rev-parse', '--verify', '-q', before)).toBe(a.action.startSha)

    const result = await releaseSnapshotRefs(a.directory, { now })
    expect(result.releasedRefs).toEqual([before, after])
    expect(result.collected).toBe(true)
    expect(() => a.store('rev-parse', '--verify', '-q', before)).toThrow()
    // Thread A's latest snapshot is still pinned, and so is everything of thread B's.
    expect(a.store('rev-parse', 'refs/mousse/threads/a/main')).toBe(a.action.endSha)
    expect(b.store('rev-parse', b.receipt.retainedRefs[1]!)).toBe(b.action.endSha)
    expect(b.store('cat-file', '-t', b.action.endSha)).toBe('commit')
    // B's Undo still works after the collection.
    await b.undo()
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
  })

  it('drops what a deleted thread pinned in the project’s store and nothing of another thread’s', async () => {
    const work = folder('work')
    const a = await aged('a', work, 'project-1')
    const b = await aged('b', work, 'project-1')
    const released = await releaseThreadSnapshots(a.directory)
    expect(released).toEqual(expect.arrayContaining(['refs/mousse/threads/a/main', ...a.receipt.retainedRefs]))
    expect(() => a.store('rev-parse', '--verify', '-q', 'refs/mousse/threads/a/main')).toThrow()
    expect(b.store('rev-parse', 'refs/mousse/threads/b/main')).toBe(b.action.endSha)
    expect(b.store('cat-file', '-t', b.action.endSha)).toBe('commit')
    // A thread with a store of its own has no refs to release: the store itself goes.
    const solo = await aged('solo', folder('scratch'), undefined)
    expect(await releaseThreadSnapshots(solo.directory)).toEqual([])
    expect(existsSync(solo.space.store.gitDir)).toBe(false)
    // The other threads' stores are untouched.
    expect(existsSync(b.space.store.gitDir)).toBe(true)
  })

  it('removes a project’s store with the project, and nothing else of the profile', async () => {
    const work = folder('work')
    const projects = new ProjectManager(home)
    const project = projects.openProject(work)
    const t = thread('a', work, project.id)
    await t.turn('turn', () => write(work, 'a.txt', 'a\n'))
    expect(existsSync(projectStorePath(project.id, home))).toBe(true)
    projects.removeProject(project.id)
    expect(existsSync(projectStorePath(project.id, home))).toBe(false)
    expect(existsSync(join(home, 'project-data', project.id))).toBe(false)
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('a\n')
  })
})

describe('a folder that is not a repository', () => {
  it('is never written into by Mousse looking for its repository', async () => {
    const { resolveRepositoryIdentity } = await import('../src/mms/git/RepositoryIdentity')
    const work = folder('plain')
    write(work, 'a.txt', 'a\n')
    const identity = resolveRepositoryIdentity(work)
    expect(identity.capability).toEqual({ allowed: false, reason: 'not-a-repository' })
    expect(readdirSync(work)).toEqual(['a.txt'])
  })
})
