import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { ensureSnapshotWorkspaceAsync, expireSnapshotTrash, inThreadSnapshotScope, SNAPSHOT_TRASH_QUIET_MS, snapshotTrashRoot } from '../src/mms/workspace/SnapshotWorkspace'
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
async function thread(work: string, projectId?: string) {
  const location = join(home, 'thread-data', 'task')
  mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' }))
  writeFileSync(join(location, 'messages.json'), '[]')
  const space = (await ensureSnapshotWorkspaceAsync({ threadDirectory: location, threadId: 'task', workTree: work, ...(projectId ? { projectId } : {}) }))
  const actions = new ThreadActionService(location)
  const turn = (id: string, start: number, mutate: () => void) =>
    actions.runCheckpointedAction({ ...actionOptions(space.record.workTree, id), threadId: 'task', presentationMessageStart: start, presentationMessageEnd: start + 2 }, mutate)
  return { location, space, actions, turn, work: space.record.workTree }
}

/** The thread in the lifecycle store, trashed, with the release the profile wires (`MmsProfileServices`, `beforePurgeRemoval`). */
async function trashed(location: string) {
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home })
  store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const coordinator = new ResourceLifecycleCoordinator(store, {
    drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {},
    beforePurgeRemoval: async (record) => { await releaseThreadSnapshots(store.require(record.taskId).location, undefined, { discardAuthorized: Boolean(record.purge?.discardAuthorized) }) }
  })
  await coordinator.trash({ taskId: 'task', operationId: 'trash' })
  return { store, coordinator }
}

/** A permanent delete of the thread. */
async function purge(location: string): Promise<void> {
  const { coordinator } = await trashed(location)
  const preview = await coordinator.cleanup.preview('task')
  expect((await coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).state).toBe('purged')
}

/** A file a turn stopped tracking (now ignored), made again as an only copy: Undo keeps it in the store before writing over it. */
async function keptByUndo(t: Awaited<ReturnType<typeof thread>>): Promise<string> {
  writeFileSync(join(t.work, 'secret'), 'tracked\n')
  await t.turn('add-secret', 0, () => undefined)
  await t.turn('drop-secret', 2, () => { rmSync(join(t.work, 'secret')); writeFileSync(join(t.work, '.gitignore'), 'secret\n') })
  writeFileSync(join(t.work, 'secret'), 'only copy\n')
  const undone = await withUserRequest(userAction('button', 'Undo'), () => new UndoService(t.location).undoLatest('main', t.work))
  expect(undone.notice).toMatch(/for 30 days: secret/)
  return /kept under (refs\/mousse\/preserved\/\S+) for /.exec(undone.notice!)![1]!
}

describe('a folder without Git under MOUSSE_GIT_POLICY=refuse', () => {
  it('records turns, reviews them, undoes and redoes them, and deletes the thread for good with no violation', async () => {
    const work = join(root, 'work')
    mkdirSync(work)
    writeFileSync(join(work, 'a.txt'), 'one\n')
    const t = (await thread(work, 'project-1'))
    const first = await t.turn('turn-1', 0, () => writeFileSync(join(work, 'a.txt'), 'two\n'))
    const second = await t.turn('turn-2', 2, () => writeFileSync(join(work, 'b.txt'), 'b\n'))
    expect(first.action.reversible && second.action.reversible).toBe(true)

    // The review reads the store, through the review's own runner.
    const scope = (await resolveReviewScope(t.location, { kind: 'turn', turnId: 'turn-1' }))!
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

  it('keeps a deleted thread whose store holds files an Undo kept within the Undo window until the person discards them', async () => {
    const work = join(root, 'work')
    mkdirSync(work)
    const t = (await thread(work, 'project-1'))
    const ref = await keptByUndo(t)
    const gitDir = t.space.store.gitDir
    const refs = (prefix: string) => execFileSync('git', ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)', prefix], { encoding: 'utf8' }).trim()
    const { store, coordinator } = await trashed(t.location)
    // The preview lists them as kept files that may be the only copy.
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.items.filter((item) => item.identity.startsWith('refs/mousse/preserved/'))).toEqual([expect.objectContaining({ kind: 'ref', identity: ref, discardRequired: true, reason: expect.stringMatching(/^Files set aside before a restore or an abort wrote over them, kept until \d{4}-\d{2}-\d{2}; they may be the only copy$/) })])
    // Automatic cleanup keeps the thread, and a purge without the person's discard refuses: nothing moves to the trash.
    coordinator.cleanup.configure({ schemaVersion: 1, graceDays: 1, automaticPurge: true }, true)
    store.update('task', (record) => { record.trashedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() })
    expect(await coordinator.cleanup.sweep(Date.now())).toEqual([expect.objectContaining({ taskId: 'task', outcome: 'kept', reason: expect.stringContaining('sole-copy') })])
    const again = await coordinator.cleanup.preview('task')
    await expect(coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: again.generation, previewDigest: again.digest })).rejects.toMatchObject({ code: 'resource_purge_discard_required' })
    expect(refs('refs/mousse/preserved/')).toBe(ref)
    expect(refs('refs/mousse/trash/')).toBe('')
    // The release itself refuses without the discard, too.
    await expect(releaseThreadSnapshots(store.require('task').location)).rejects.toThrow(/may be the only copy/)
    // With the person's discard they go with the thread, through the store's trash.
    expect((await coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: again.generation, previewDigest: again.digest, discard: true, human: true })).state).toBe('purged')
    expect(refs('refs/mousse/preserved/')).toBe('')
    expect(refs('refs/mousse/trash/')).toMatch(/\/preserved\//)
    expect(violations()).toEqual([])
  })

  it('lets automatic cleanup take kept files whose Undo window has passed', async () => {
    const work = join(root, 'work')
    mkdirSync(work)
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() - 40 * 24 * 60 * 60 * 1000)
    let ref: string
    try {
      const t = (await thread(work, 'project-1'))
      ref = await keptByUndo(t)
    } finally { vi.useRealTimers() }
    const { store, coordinator } = await trashed(join(home, 'thread-data', 'task'))
    expect((await coordinator.cleanup.preview('task')).items.find((item) => item.identity === ref)).toMatchObject({ kind: 'ref' })
    expect((await coordinator.cleanup.preview('task')).items.some((item) => item.discardRequired)).toBe(false)
    coordinator.cleanup.configure({ schemaVersion: 1, graceDays: 1, automaticPurge: true }, true)
    store.update('task', (record) => { record.trashedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() })
    expect(await coordinator.cleanup.sweep(Date.now())).toEqual([expect.objectContaining({ taskId: 'task', outcome: 'purged' })])
    expect(violations()).toEqual([])
  })

  it('moves a thread with no project’s store to the trash, and the expiry deletes it, with no violation', async () => {
    const work = join(root, 'scratch')
    mkdirSync(work)
    const t = (await thread(work))
    await t.turn('turn', 0, () => writeFileSync(join(work, 'notes.md'), '# notes\n'))
    await purge(t.location)
    expect(readdirSync(snapshotTrashRoot(home))).toEqual([expect.stringMatching(/^thread-task-/)])
    expect(expireSnapshotTrash(Date.now() + SNAPSHOT_TRASH_QUIET_MS + 60_000, home)).toMatchObject([{ removed: true }])
    expect(violations()).toEqual([])
  })
})
