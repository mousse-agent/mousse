import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { resolveReviewScope } from '../src/mms/actions/reviewRange'
import { expireTrashedSnapshotRefs, releaseThreadSnapshots } from '../src/mms/actions/SnapshotRefReleaseService'
import { GitPolicyError, onGitPolicyEntry, userAction, withUserRequest, type GitPolicyEntry } from '../src/mms/git/gitPolicy'
import { checkStoreCommand } from '../src/mms/git/hiddenStore'
import { listChangedFiles, readFileVersions } from '../src/mms/git/reviewDiff'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ensureSnapshotWorkspace, expireSnapshotTrash, inThreadSnapshotScope, SNAPSHOT_TRASH_QUIET_MS, snapshotTrashRoot } from '../src/mms/workspace/SnapshotWorkspace'
import { actionOptions } from './fixtures/gitFoundation'

/**
 * The central Git check refuses, and every decision it makes is recorded. In a folder without Git, Mousse's snapshot
 * store must not need anything it is not allowed: creating the store, a turn, the review, Undo and Redo (under the
 * user's request, as their protocol handlers run them), a permanent delete and the trash expiry. The folder is the
 * person's, outside the Mousse home; only the store is Mousse's.
 */
let root: string
let home: string
let entries: GitPolicyEntry[]
let stop: () => void
const previous = { home: process.env.MOUSSE_HOME, mode: process.env.MOUSSE_GIT_POLICY }
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'mousse-policy-store-'))
  home = join(root, 'home')
  mkdirSync(home)
  process.env.MOUSSE_HOME = home
  process.env.MOUSSE_GIT_POLICY = 'refuse'
  entries = []
  stop = onGitPolicyEntry((entry) => entries.push(entry))
})
afterEach(() => {
  stop()
  for (const [key, value] of [['MOUSSE_HOME', previous.home], ['MOUSSE_GIT_POLICY', previous.mode]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const violations = () => entries.filter((entry) => entry.kind === 'violation').map((entry) => `${entry.command} (${entry.decision.reason})`)
const asked = <T>(label: string, work: () => T): T => withUserRequest(userAction('button', label), work)

/** A thread of `projectId` (none: a thread with no project) whose folder is `work`, with its directory in the lifecycle store. */
function thread(work: string, projectId?: string) {
  const location = join(home, 'thread-data', 'task')
  mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' }))
  writeFileSync(join(location, 'messages.json'), '[]')
  const space = ensureSnapshotWorkspace({ threadDirectory: location, threadId: 'task', workTree: work, ...(projectId ? { projectId } : {}) })
  const actions = new ThreadActionService(location)
  const turn = (id: string, start: number, mutate: () => void) =>
    actions.runCheckpointedAction({ ...actionOptions(space.record.workTree, id), threadId: 'task', presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)
  return { location, space, actions, turn, work: space.record.workTree }
}

/** A permanent delete of the thread, with the release the profile wires (`MmsProfileServices`, `beforePurgeRemoval`). */
async function purge(location: string): Promise<void> {
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home })
  store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const coordinator = new ResourceLifecycleCoordinator(store, {
    drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {},
    beforePurgeRemoval: async (record) => { await releaseThreadSnapshots(store.require(record.taskId).location) }
  })
  await coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await coordinator.cleanup.preview('task')
  expect((await coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).state).toBe('purged')
}

describe('a folder without Git under MOUSSE_GIT_POLICY=refuse', () => {
  it('records turns, reviews them, undoes and redoes them, and deletes the thread for good with no violation', async () => {
    const work = join(root, 'work')
    mkdirSync(work)
    writeFileSync(join(work, 'a.txt'), 'one\n')
    const t = thread(work, 'project-1')
    const first = await t.turn('turn-1', 0, () => writeFileSync(join(work, 'a.txt'), 'two\n'))
    const second = await t.turn('turn-2', 2, () => writeFileSync(join(work, 'b.txt'), 'b\n'))
    expect(first.action.reversible && second.action.reversible).toBe(true)

    // The review reads the store, through the review's own runner.
    const scope = resolveReviewScope(t.location, { kind: 'turn', turnId: 'turn-1' })!
    const files = await inThreadSnapshotScope(t.location, work, () => listChangedFiles(work, scope.range))
    expect(files.files.map((file) => file.path)).toEqual(['a.txt'])
    const versions = await inThreadSnapshotScope(t.location, work, () => readFileVersions(work, scope.range, 'a.txt'))
    expect(versions.original).toMatchObject({ content: 'one\n' })

    // Writing the person's files needs their request: the check refuses it without one (the protocol always passes it).
    expect(() => checkStoreCommand(t.space.store, work, ['--no-optional-locks', 'checkout-index', '-a', '-f'])).toThrow(GitPolicyError)
    entries.length = 0
    const undo = new UndoService(t.location)
    await asked('Undo', () => undo.undoLatest('main', work))
    expect(existsSync(join(work, 'b.txt'))).toBe(false)
    await asked('Redo', () => undo.undoLatest('main', work, undefined, undefined, undefined, 'redo'))
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('b\n')

    // Deleted for good: the thread's refs go, the files its restores kept move to the trash, the store is collected.
    await purge(t.location)
    const store = t.space.store.gitDir
    expect(execFileSync('git', ['--git-dir', store, 'for-each-ref', '--format=%(refname)', 'refs/mousse/threads/'], { encoding: 'utf8' }).trim()).toBe('')
    expect(await expireTrashedSnapshotRefs(Date.now() + SNAPSHOT_TRASH_QUIET_MS + 60_000, home)).toEqual([])

    expect(violations()).toEqual([])
    // The person's folder never gained a .git, and its files are as the Redo left them.
    expect(readdirSync(work).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('moves a thread with no project’s store to the trash, and the expiry deletes it, with no violation', async () => {
    const work = join(root, 'scratch')
    mkdirSync(work)
    const t = thread(work)
    await t.turn('turn', 0, () => writeFileSync(join(work, 'notes.md'), '# notes\n'))
    await purge(t.location)
    expect(readdirSync(snapshotTrashRoot(home))).toEqual([expect.stringMatching(/^thread-task-/)])
    expect(expireSnapshotTrash(Date.now() + SNAPSHOT_TRASH_QUIET_MS + 60_000, home)).toMatchObject([{ removed: true }])
    expect(violations()).toEqual([])
  })
})
