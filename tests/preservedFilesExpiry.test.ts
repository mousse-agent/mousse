/**
 * Files a restore kept (`refs/mousse/preserved/<operation>-…`) expire once they are older than the thread's Undo
 * retention window. Only the thread's own refs go, each with the value it was read with; another thread's stay, and so
 * does a newer one. The Undo retention sweep does it, never in its first pass after the daemon starts.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expirePreservedFiles, PRESERVED_EXPIRY_OPERATION } from '../src/mms/actions/preservedFiles'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoRetentionService } from '../src/mms/actions/UndoRetentionService'
import { UndoRetentionSweeper } from '../src/mms/actions/UndoRetentionSweeper'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { clearGitPolicyLog, gitPolicyLog } from '../src/mms/git/gitPolicy'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { lifecycleGit as git } from '../src/mms/lifecycle/WorktreeRetirementService'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'

const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A thread working in its project's own folder, with one recorded action, so its journal has an operation. */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-preserved-'))); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])
  new ThreadWorkspaceManager(location).ensureProjectFolder('task', 'main', repo)
  await new ThreadActionService(location).runCheckpointedAction({
    threadId: 'task', turnId: 'edit', conversationBranchId: 'main', workspacePath: repo, actor: { kind: 'user' }, allowDirtyInput: true,
    presentationMessageStart: 0, presentationMessageEnd: 0, nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
  }, async () => { writeFileSync(join(repo, 'a.txt'), 'edited by the thread\n') })
  const operation = new ThreadJournal(location, { readOnly: true }).list()[0]!.operationId
  /** Keeps a commit under `ref` as if written `ageMs` ago, the way a restore does. */
  const keep = (ref: string, ageMs: number): string => {
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}'])
    const date = `@${Math.floor((Date.now() - ageMs) / 1000)} +0000`
    const sha = execFileSync('git', ['commit-tree', tree, '-m', 'mousse snapshot: files kept before a restore'], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).trim()
    git(repo, ['update-ref', ref, sha])
    return sha
  }
  const preserved = () => git(repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/preserved/']).split('\n').filter(Boolean).sort()
  return { root, home, location, repo, store, operation, keep, preserved }
}

test('a thread’s kept files older than its Undo window expire; newer ones and another thread’s stay', async () => {
  const f = await fixture()
  // The retention clock starts as the hourly sweep starts it.
  await new UndoRetentionService(f.location).sweep(f.repo)
  const old = `refs/mousse/preserved/${f.operation}-old`
  const recent = `refs/mousse/preserved/${f.operation}-recent`
  const other = 'refs/mousse/preserved/another-operation-old'
  const oldSha = f.keep(old, 31 * DAY)
  f.keep(recent, 29 * DAY)
  f.keep(other, 90 * DAY)

  clearGitPolicyLog()
  const result = await expirePreservedFiles(f.location, f.repo)
  expect(result).toEqual({ expiredRefs: [old] })
  expect(f.preserved()).toEqual([other, recent].sort())
  // The delete is a change only to what Mousse owns, declared as such: the central Git check logged nothing.
  expect(gitPolicyLog()).toEqual([])
  // What went, at which commit, is recorded in the thread's journal with the window it was kept for.
  const record = new ThreadJournal(f.location, { readOnly: true }).list().find((entry) => entry.operationType === PRESERVED_EXPIRY_OPERATION)
  expect(record).toMatchObject({ state: 'completed', details: { windowMs: 30 * DAY, refs: [{ name: old, sha: oldSha }] } })
  // Running again finds nothing more to do.
  expect(await expirePreservedFiles(f.location, f.repo)).toEqual({ expiredRefs: [] })
}, 60_000)

test('nothing expires while the retention clock needs review', async () => {
  const f = await fixture()
  await new UndoRetentionService(f.location).sweep(f.repo)
  const old = `refs/mousse/preserved/${f.operation}-old`
  f.keep(old, 60 * DAY)
  // The clock jumped further ahead than the policy allows in one step.
  const result = await expirePreservedFiles(f.location, f.repo, { now: () => Date.now() + 30 * DAY })
  expect(result.expiredRefs).toEqual([])
  expect(result.skipped).toMatch(/clock/)
  expect(f.preserved()).toEqual([old])
}, 60_000)

test('the sweep leaves kept files alone in its first pass after start and expires them in a later one', async () => {
  const f = await fixture()
  const old = `refs/mousse/preserved/${f.operation}-old`
  f.keep(old, 31 * DAY)
  const sweeper = new UndoRetentionSweeper(f.store, { intervalMs: 60 * 60 * 1000, tasksPerBatch: 20 })
  await sweeper.tick()
  expect(f.preserved()).toEqual([old])
  expect(sweeper.outcomes.get('task')?.expiredPreservedRefs).toBeUndefined()
  await sweeper.tick()
  expect(f.preserved()).toEqual([])
  expect(sweeper.outcomes.get('task')).toMatchObject({ expiredPreservedRefs: 1 })
  await sweeper.stop()
}, 60_000)
