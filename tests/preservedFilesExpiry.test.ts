/**
 * Files a restore or an abort kept (`refs/mousse/preserved/`) expire once they have been kept for the thread's Undo
 * retention window, counted from Mousse's own journal record, never from a commit date Git was told. Only the thread's
 * own refs go, matched by the exact names their writers use. The refs that are due are recorded first and deleted in one
 * transaction, and the outcome names exactly what went. The Undo retention sweep does it, never in its first pass.
 *
 * Every ref here comes from a real writer: an Undo that finds an ignored file in its way (`moveFiles`), switching
 * conversation branches, or `preserveBeforeAbort` recorded the way `ManagedConflictService.abort` records it.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationBranchService } from '../src/mms/actions/ConversationBranchService'
import { preserveBeforeAbort } from '../src/mms/actions/leftMerge'
import { abortPreservedNotice } from '../src/mms/actions/snapshots'
import { expirePreservedFiles, PRESERVED_EXPIRY_OPERATION, threadPreservedIndex } from '../src/mms/actions/preservedFiles'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { UndoRetentionSweeper } from '../src/mms/actions/UndoRetentionSweeper'
import { UndoService } from '../src/mms/actions/UndoService'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { clearGitPolicyLog, gitPolicyLog } from '../src/mms/git/gitPolicy'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { lifecycleGit } from '../src/mms/lifecycle/WorktreeRetirementService'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions } from './fixtures/gitFoundation'

const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A thread working in its project's own folder (`folder`) or in a worktree of its own (`worktree`). */
async function setup(kind: 'folder' | 'worktree') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-preserved-'))); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true })
  vi.stubEnv('MOUSSE_HOME', home)
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const repo = join(root, 'repo'); mkdirSync(repo)
  const git = (cwd: string, ...args: string[]) => lifecycleGit(cwd, args)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test')
  writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  const manager = new ThreadWorkspaceManager(location)
  const cwd = kind === 'folder' ? (manager.ensureProjectFolder('task', 'main', repo), repo) : (await manager.provision('task', 'main', repo)).worktreePath
  const actions = new ThreadActionService(location)
  let at = 0
  const turn = (id: string, mutate: () => void) => {
    const start = at; at += 2
    return actions.runCheckpointedAction({ ...actionOptions(cwd, id), presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)
  }
  const write = (path: string, value: string) => writeFileSync(join(cwd, path), value)
  /** A file the thread's turn stopped tracking, then made again as an ignored only copy, which the Undo keeps. */
  const keepByUndo = async (name: string) => {
    write(name, 'tracked\n'); git(cwd, 'add', name); git(cwd, 'commit', '-qm', `track ${name}`)
    await turn(`outside-${name}`, () => undefined)
    await turn(`untrack-${name}`, () => {
      git(cwd, 'rm', '-q', name)
      write('.gitignore', `${existsSync(join(cwd, '.gitignore')) ? readFileSync(join(cwd, '.gitignore'), 'utf8') : ''}${name}\n`)
      git(cwd, 'add', '.gitignore'); git(cwd, 'commit', '-qm', `stop tracking ${name}`)
    })
    write(name, 'only copy\n')
    const undone = await new UndoService(location).undoLatest('main', cwd)
    const ref = /kept under (refs\/mousse\/preserved\/\S+) for /.exec(undone.notice ?? '')?.[1]
    if (!ref) throw new Error(`No kept files in: ${undone.notice}`)
    return { ref, notice: undone.notice! }
  }
  /** What an abort keeps, recorded as `ManagedConflictService.abort` records it. */
  const keepByAbort = (operationId: string, threadDirectory = location) => {
    const ref = preserveBeforeAbort(cwd, operationId)
    new ThreadJournal(threadDirectory).append({ operationId, operationType: 'publish', state: 'cancelled', details: { conflictAborted: true, preservedRef: ref } })
    return ref
  }
  /** Moves Mousse's clock to `to` the way the hourly sweep sees it, in steps the retention policy accepts. */
  const walkClock = async (from: number, to: number) => {
    for (let time = from; time < to; time += 6 * DAY) { vi.setSystemTime(time); await new UndoRetentionService(location).sweep(cwd) }
    vi.setSystemTime(to); await new UndoRetentionService(location).sweep(cwd)
  }
  const preserved = () => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/').split('\n').filter(Boolean).sort()
  const expiries = () => new ThreadJournal(location, { readOnly: true }).list().filter((entry) => entry.operationType === PRESERVED_EXPIRY_OPERATION)
  return { root, home, location, repo, cwd, store, git, turn, write, keepByUndo, keepByAbort, walkClock, preserved, expiries }
}

const fakeClock = () => { const start = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start); return start }

test('kept files expire after the Undo window counted from Mousse’s record, whatever commit date Git was given', async () => {
  const start = fakeClock()
  const f = await setup('folder')
  // A commit date in 2000, as an inherited GIT_COMMITTER_DATE would give every commit.
  vi.stubEnv('GIT_COMMITTER_DATE', '@946684800 +0000'); vi.stubEnv('GIT_AUTHOR_DATE', '@946684800 +0000')
  const restore = await f.keepByUndo('secret')
  const abort = f.keepByAbort('client-chosen-op')
  // The notice says how long they are kept; the commits are dated by Mousse's clock, not the environment.
  expect(restore.notice).toMatch(/kept under refs\/mousse\/preserved\/\S+ for 30 days: secret\. Bring one back before then/)
  expect(abortPreservedNotice(abort, new UndoRetentionService(f.location).policy().windowMs)).toBe(`Every file as it was before the abort is kept under ${abort} for 30 days. Bring one back before then with git restore --source=${abort} -- <path>.`)
  for (const ref of [restore.ref, abort]) expect(Math.abs(Number(f.git(f.cwd, 'log', '-1', '--format=%ct', ref)) * 1000 - start)).toBeLessThan(60_000)

  expect(await expirePreservedFiles(f.location, f.cwd)).toEqual({ expiredRefs: [] })
  await f.walkClock(start, start + 29 * DAY)
  expect(await expirePreservedFiles(f.location, f.cwd)).toEqual({ expiredRefs: [] })
  expect(f.preserved()).toEqual([abort, restore.ref].sort())

  await f.walkClock(start + 29 * DAY, start + 31 * DAY)
  clearGitPolicyLog()
  const result = await expirePreservedFiles(f.location, f.cwd)
  expect(result.expiredRefs.sort()).toEqual([abort, restore.ref].sort())
  expect(f.preserved()).toEqual([])
  // Declared as a change to what Mousse owns: the central Git check logged nothing.
  expect(gitPolicyLog()).toEqual([])
  // The intent came first, then the outcome with exactly what went.
  expect(f.expiries().map((entry) => [entry.state, (entry.details as { phase: string }).phase])).toEqual([['planned', 'intent'], ['completed', 'outcome']])
  expect((f.expiries()[1]!.details as { refs: Array<{ name: string }> }).refs.map((item) => item.name).sort()).toEqual([abort, restore.ref].sort())
}, 60_000)

test('an operation id that starts another thread’s never claims its kept files', async () => {
  const start = fakeClock()
  const f = await setup('folder')
  const other = join(f.root, 'other-thread'); mkdirSync(other)
  const mine = f.keepByAbort('op')
  const theirs = f.keepByAbort('op-other', other)
  const { ref: restored } = await f.keepByUndo('secret')
  // Shapes no writer of this thread recorded: an abort name for a restore's operation, and a restore name for a plain id.
  const sha = f.git(f.cwd, 'rev-parse', 'HEAD')
  const undoOperation = /refs\/mousse\/preserved\/(.{36})-/.exec(restored)![1]!
  const forged = [`refs/mousse/preserved/${undoOperation}-abort-${sha.slice(0, 12)}`, `refs/mousse/preserved/op-${sha.slice(0, 12)}`]
  for (const ref of forged) f.git(f.cwd, 'update-ref', ref, sha)

  const index = threadPreservedIndex(f.location)
  expect([mine, restored].every((ref) => index.owns(ref))).toBe(true)
  expect([theirs, ...forged].some((ref) => index.owns(ref))).toBe(false)
  expect(threadPreservedIndex(other).owns(theirs)).toBe(true)
  expect(threadPreservedIndex(other).owns(mine)).toBe(false)

  await f.walkClock(start, start + 31 * DAY)
  expect((await expirePreservedFiles(f.location, f.cwd)).expiredRefs.sort()).toEqual([mine, restored].sort())
  expect(f.preserved()).toEqual([theirs, ...forged].sort())
}, 60_000)

test('a ref Git cannot lock stops the whole delete, nothing goes, and the journal says so; the next sweep finishes it', async () => {
  const start = fakeClock()
  const f = await setup('folder')
  const refs = [(await f.keepByUndo('secret')).ref, f.keepByAbort('op')].sort()
  await f.walkClock(start, start + 31 * DAY)
  // The person's Git or IDE holds the second ref's lock.
  const lock = join(f.repo, '.git', `${refs[1]}.lock`)
  writeFileSync(lock, '')
  const blocked = await expirePreservedFiles(f.location, f.cwd)
  expect(blocked.expiredRefs).toEqual([])
  expect(blocked.skipped).toMatch(/could not be deleted/)
  expect(f.preserved()).toEqual(refs)
  expect(f.expiries().map((entry) => [entry.state, (entry.details as { refs: unknown[] }).refs.length])).toEqual([['planned', 2], ['failed', 0]])

  rmSync(lock)
  expect((await expirePreservedFiles(f.location, f.cwd)).expiredRefs.sort()).toEqual(refs)
  expect(f.preserved()).toEqual([])
}, 60_000)

test('an expiry that stopped after its intent is settled from what is gone', async () => {
  const start = fakeClock()
  const f = await setup('folder')
  const ref = f.keepByAbort('op')
  const sha = f.git(f.cwd, 'rev-parse', ref)
  await f.walkClock(start, start + 31 * DAY)
  // Stopped after the transaction and before the outcome.
  new ThreadJournal(f.location).append({ operationId: 'interrupted', operationType: PRESERVED_EXPIRY_OPERATION, state: 'planned', details: { phase: 'intent', refs: [{ name: ref, sha }] } })
  f.git(f.cwd, 'update-ref', '-d', ref, sha)
  expect(await expirePreservedFiles(f.location, f.cwd)).toEqual({ expiredRefs: [ref] })
  expect(f.expiries().at(-1)).toMatchObject({ operationId: 'interrupted', state: 'completed', details: { phase: 'outcome', refs: [{ name: ref, sha }], interrupted: true } })
}, 60_000)

test('nothing expires while an operation is unfinished or the retention clock needs review', async () => {
  const start = fakeClock()
  const f = await setup('folder')
  const ref = f.keepByAbort('op')
  await f.walkClock(start, start + 31 * DAY)
  // The clock jumped further ahead than the policy allows in one step.
  vi.setSystemTime(start + 60 * DAY)
  const clock = await expirePreservedFiles(f.location, f.cwd)
  expect(clock).toMatchObject({ expiredRefs: [], skipped: expect.stringMatching(/clock/) })
  vi.setSystemTime(start + 31 * DAY)
  new ThreadJournal(f.location).append({ operationId: 'running-undo', operationType: 'undo', state: 'prepared' })
  expect(await expirePreservedFiles(f.location, f.cwd)).toMatchObject({ expiredRefs: [], skipped: expect.stringMatching(/unfinished/) })
  expect(f.preserved()).toEqual([ref])
}, 60_000)

test('switching conversation branches names its operation in the kept files, so they are the thread’s', async () => {
  const f = await setup('worktree')
  f.write('secret', 'tracked\n'); f.git(f.cwd, 'add', 'secret'); f.git(f.cwd, 'commit', '-qm', 'track secret')
  const { action } = await f.turn('outside', () => undefined)
  await f.turn('untrack', () => { f.git(f.cwd, 'rm', '-q', 'secret'); f.write('.gitignore', 'secret\n'); f.git(f.cwd, 'add', '.gitignore'); f.git(f.cwd, 'commit', '-qm', 'untrack') })
  f.write('secret', 'only copy\n')
  const service = new ConversationBranchService(f.location)
  const fork = await service.fork(f.cwd, 'main', action.id, 'Back to the secret')
  await service.activate(f.cwd, fork.id)
  const [ref] = f.preserved()
  const operation = new ThreadJournal(f.location, { readOnly: true }).list().find((entry) => entry.operationType === 'conversation-activate')!.operationId
  expect(ref).toMatch(new RegExp(`^refs/mousse/preserved/${operation}-[0-9a-f]{12}$`))
  expect(f.git(f.cwd, 'show', `${ref}:secret`)).toBe('only copy')
  expect(threadPreservedIndex(f.location).owns(ref!)).toBe(true)
}, 60_000)

test('the sweep expires a worktree thread’s kept files in a later pass, never the first, and says why it skipped', async () => {
  const start = Date.now() - 40 * DAY
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start)
  const f = await setup('worktree')
  const { ref } = await f.keepByUndo('secret')
  await f.walkClock(start, Date.now() + 40 * DAY - 1000)
  vi.useRealTimers()

  const sweeper = new UndoRetentionSweeper(f.store, { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20 })
  await sweeper.tick()
  expect(f.preserved()).toEqual([ref])
  expect(sweeper.outcomes.get('task')?.expiredPreservedRefs).toBeUndefined()

  // While an operation is unfinished the next pass skips, and its outcome says why.
  const journal = new ThreadJournal(f.location)
  journal.append({ operationId: 'running-revert', operationType: 'code-revert', state: 'prepared' })
  await sweeper.tick()
  expect(f.preserved()).toEqual([ref])
  expect(sweeper.outcomes.get('task')?.reason).toMatch(/Kept files: An unfinished operation protects kept files/)

  journal.append({ operationId: 'running-revert', operationType: 'code-revert', state: 'cancelled' })
  await sweeper.tick()
  expect(f.preserved()).toEqual([])
  expect(sweeper.outcomes.get('task')).toMatchObject({ expiredPreservedRefs: 1 })
  await sweeper.stop()
}, 60_000)
