import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { createHash } from 'node:crypto'
import { preserveBeforeAbortAsync } from '../src/mms/actions/leftMerge'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { getExternalResourceClaims, unverifiedOwnerOver } from '../src/mms/lifecycle/LifecycleClaims'
import { ProfileManager } from '../src/mms/profiles/ProfileManager'
import { createInstallationPaths } from '../src/mms/profiles/paths'
import { unverifiableThread } from './support/unverifiableThread'
import { canonicalPathAsync } from '../src/mms/lifecycle/canonicalPath'

const roots: string[] = []
const owned: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); for (const undo of owned.splice(0)) undo(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(options: { git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-purge-')); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true }); owned.push(ownedHome(home))
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const repo = join(root, 'repo'); let worktree = join(root, 'checkout')
  if (options.git) {
    mkdirSync(repo); git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base'])
    worktree = join(home, 'repositories', resolveRepositoryIdentity(repo).key, 'worktrees', 'threads', 'task', 'main'); mkdirSync(join(worktree, '..'), { recursive: true })
    const branch = 'mousse/thread/task/main'; git(repo, ['worktree', 'add', '-b', branch, worktree])
    const sha = git(repo, ['rev-parse', 'HEAD']), retainedRef = 'refs/mousse/threads/task/main'; git(repo, ['update-ref', retainedRef, sha])
    writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: 'task', worktreePath: worktree, branch, repositoryId: resolveRepositoryIdentity(repo).key, retainedRef, baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: repo }, lifecycle: 'ready' }))
    mkdirSync(join(location, 'journal')); writeFileSync(join(location, 'journal', '0000000000000001.json'), JSON.stringify({ schemaVersion: 1, sequence: 1, operationId: 'provision', operationType: 'workspace-provision', state: 'planned', expectedPreState: { branch, worktreePath: worktree } }))
    writeFileSync(join(location, 'journal', '0000000000000002.json'), JSON.stringify({ schemaVersion: 1, sequence: 2, operationId: 'provision', operationType: 'workspace-provision', state: 'completed' }))
  }
  const projected: string[] = []
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: (record) => { projected.push(record.taskId) } })
  return { root, home, location, repo, worktree, store, coordinator, projected }
}
test('complete purge removes exclusive checkout, refs and task data and retains tombstone', async () => {
  const f = fixture({ git: true }); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task'); expect(preview.blockers).toEqual([])
  expect(preview.items.some((item) => item.kind === 'worktree')).toBe(true)
  const record = await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
  expect(record.state).toBe('purged'); expect(existsSync(f.worktree)).toBe(false); expect(existsSync(record.location)).toBe(false)
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/'])).toBe('')
  expect(git(f.repo, ['status', '--porcelain'])).toBe('')
  expect(() => f.store.registerTask({ taskId: 'task', location: f.location, creating: true })).toThrow(/tombstone/)
  expect((await f.coordinator.purge({ taskId: 'task', operationId: 'purge' })).state).toBe('purged')
})
test('a purge releases the files the thread’s aborts kept, asks first while they may be the only copy, and leaves another thread’s', async () => {
  const f = fixture({ git: true })
  const keep = async (operationId: string, at: number) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at)
    try {
      const ref = (await preserveBeforeAbortAsync(f.worktree, operationId))
      new ThreadJournal(f.location).append({ operationId, operationType: 'publish', state: 'cancelled', details: { conflictAborted: true, preservedRef: ref } })
      return ref
    } finally { vi.useRealTimers() }
  }
  const old = (await keep('old-abort', Date.now() - 40 * 24 * 60 * 60 * 1000))
  const young = (await keep('young-abort', Date.now()))
  // Another thread's abort, whose id starts with this thread's: never this thread's.
  const theirs = (await preserveBeforeAbortAsync(f.worktree, 'old-abort-other'))
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task'); expect(preview.blockers).toEqual([])
  const kept = preview.items.filter((item) => item.kind === 'ref' && item.identity.startsWith('refs/mousse/preserved/'))
  expect(kept.map((item) => [item.identity, Boolean(item.discardRequired)]).sort()).toEqual([[old, false], [young, true]].sort())
  // Automatic cleanup keeps the thread while the young ones may be the only copy.
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toMatchObject({ code: 'resource_purge_discard_required' })
  expect((await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest, discard: true, human: true })).state).toBe('purged')
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/'])).toBe(theirs)
})
test('dirty sole copy needs a human exact preview discard; automatic request preserves it', async () => {
  const f = fixture({ git: true }); writeFileSync(join(f.worktree, 'secret.txt'), 'only copy')
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([]); expect(preview.items.some((item) => item.discardRequired)).toBe(true)
  const request = { taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest }
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_discard_required', message: expect.stringContaining('human-reviewed'), errorInfo: { category: 'denied', retryable: false } })
  expect(readFileSync(join(f.worktree, 'secret.txt'), 'utf8')).toBe('only copy')
  expect((await f.coordinator.purge({ ...request, discard: true, human: true })).state).toBe('purged')
})
test('scheduled definition and runtime rows are removed preserving unrelated configuration', async () => {
  const f = fixture(); mkdirSync(join(f.home, 'scheduled'))
  writeFileSync(join(f.home, 'mousse.conf'), JSON.stringify({ model: 'keep', scheduled: { jobs: [{ id: 'owned', threadId: 'task' }, { id: 'other', threadId: 'other' }] } }))
  writeFileSync(join(f.home, 'scheduled', 'jobs-runtime.json'), JSON.stringify({ owned: { state: 'completed' }, other: { state: 'scheduled' } }))
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([])
  await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
  expect(JSON.parse(readFileSync(join(f.home, 'mousse.conf'), 'utf8'))).toEqual({ model: 'keep', scheduled: { jobs: [{ id: 'other', threadId: 'other' }] } })
  expect(JSON.parse(readFileSync(join(f.home, 'scheduled', 'jobs-runtime.json'), 'utf8'))).toEqual({ other: { state: 'scheduled' } })
})

test('registered workflow scratch sole-copy output requires an exact human discard', async () => {
  const f = fixture(), key = 'scratch-call', hash = createHash('sha256').update(key).digest('hex')
  const root = join(f.home, 'workflow-agent-bindings', 'workspaces'), scratch = join(root, hash)
  mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'result.txt'), 'sole copy')
  writeFileSync(join(root, `${hash}.json`), JSON.stringify({ version: 1, kind: 'scratch', profileId: 'test', threadId: 'task', idempotencyKey: key, worktreePath: scratch, projectCwd: scratch, lifecycle: 'ready' }))
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([]); expect(preview.items.find((item) => item.identity === scratch)?.discardRequired).toBe(true)
  const request = { taskId: 'task', operationId: 'scratch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest }
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_discard_required', message: expect.stringContaining('human-reviewed'), errorInfo: { category: 'denied', retryable: false } })
  expect(readFileSync(join(scratch, 'result.txt'), 'utf8')).toBe('sole copy')
  expect((await f.coordinator.purge({ ...request, discard: true, human: true })).state).toBe('purged')
  expect(existsSync(scratch)).toBe(false)
})

test.each(['try-agent', 'terminal'])('nested %s scratch propagates sole-copy discard to its collapsed owner container', async (kind) => {
  const f = fixture(), id = 'try-agent-result'
  const container = kind === 'try-agent' ? join(f.home, 'agent-runs', id) : f.location
  const scratch = join(container, kind === 'try-agent' ? 'workspace' : 'terminal-workspace')
  mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'sole-copy.txt'), 'retained output')
  if (kind === 'try-agent') {
    writeFileSync(join(container, 'run.json'), JSON.stringify({ version: 1, profileId: 'test', threadId: 'task', runId: id }))
    writeFileSync(join(f.location, 'agents.json'), JSON.stringify([{ id, worktreePath: scratch, status: 'completed' }]))
  } else writeFileSync(join(f.location, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: 'task', workspaceRelativePath: 'terminal-workspace' }))
  await f.coordinator.trash({ taskId: 'task', operationId: 'nested-trash' })
  const record = f.store.require('task'), movedContainer = kind === 'terminal' ? record.location : container
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([])
  expect(preview.items.find((item) => item.identity === movedContainer)).toMatchObject({ discardRequired: true })
  const request = { taskId: 'task', operationId: 'nested-purge', expectedGeneration: preview.generation, previewDigest: preview.digest }
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_discard_required', message: expect.stringContaining('human-reviewed'), errorInfo: { category: 'denied', retryable: false } })
  expect(readFileSync(join(movedContainer, kind === 'terminal' ? 'terminal-workspace' : 'workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
  await f.coordinator.purge({ ...request, human: true, discard: true })
  expect(existsSync(movedContainer)).toBe(false)
})

test('retireTrashed removes a clean exclusive checkout and clears an earlier blocked reason', async () => {
  const f = fixture({ git: true }); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  f.store.update('task', (record) => { record.blockedReason = 'earlier failure' })
  await f.coordinator.cleanup.retireTrashed('task')
  expect(existsSync(f.worktree)).toBe(false)
  expect(f.store.require('task')).toMatchObject({ state: 'trashed' }); expect(f.store.require('task').blockedReason).toBeUndefined()
})
test('retireTrashed removes a checkout holding uncommitted files into a pinned snapshot, and a purge still asks before that work is dropped', async () => {
  const f = fixture({ git: true }); writeFileSync(join(f.worktree, 'secret.txt'), 'only copy')
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  await f.coordinator.cleanup.retireTrashed('task')
  expect(existsSync(f.worktree)).toBe(false)
  expect(f.store.require('task').blockedReason).toBeUndefined()
  const retirement = new WorktreeRetirementService(f.store)
  const manifest = retirement.load(retirement.pathFor('task', f.worktree))
  expect(git(f.repo, ['show', `${manifest.snapshotSha}:secret.txt`])).toBe('only copy')
  expect(git(f.repo, ['rev-parse', manifest.snapshotRef!])).toBe(manifest.snapshotSha)
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([]); expect(preview.items.find((item) => item.kind === 'worktree')).toMatchObject({ discardRequired: true })
  expect(preview.items.filter((item) => item.kind === 'ref').map((item) => item.identity)).toContain(manifest.snapshotRef)
  const request = { taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest }
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_discard_required' })
  expect((await f.coordinator.purge({ ...request, discard: true, human: true })).state).toBe('purged')
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/'])).toBe('')
})
test('retireTrashed keeps a checkout holding what a snapshot cannot hold (staged changes) and records why', async () => {
  const f = fixture({ git: true }); writeFileSync(join(f.worktree, 'secret.txt'), 'only copy'); git(f.worktree, ['add', 'secret.txt'])
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  await f.coordinator.cleanup.retireTrashed('task')
  expect(readFileSync(join(f.worktree, 'secret.txt'), 'utf8')).toBe('only copy')
  expect(f.store.require('task').blockedReason).toMatch(/^Checkout retained: .*Staged changes/)
})
test('retireTrashed keeps the checkout and reports the cause when the exact retirement fails', async () => {
  const f = fixture({ git: true }); await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  vi.spyOn(WorktreeRetirementService.prototype, 'retire').mockImplementation(() => { throw new Error('Workspace HEAD changed') })
  await f.coordinator.cleanup.retireTrashed('task')
  expect(existsSync(join(f.worktree, 'a.txt'))).toBe(true)
  expect(f.store.require('task').blockedReason).toBe('Checkout retained: Workspace HEAD changed')
})

// ---- Trash sweep outcomes, the storage cleanup seam ----
const DAY_MS = 86_400_000
async function trashedTask(f: ReturnType<typeof fixture>, id: string, extra?: (location: string) => void) {
  const location = id === 'task' ? f.location : join(f.home, 'thread-data', id)
  if (id !== 'task') {
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), JSON.stringify({ id })); writeFileSync(join(location, 'messages.json'), '[]'); extra?.(location)
    f.store.registerTask({ taskId: id, location })
  }
  await f.coordinator.trash({ taskId: id, operationId: `trash-${id}` })
  f.store.update(id, (record) => { record.trashedAt = new Date(Date.now() - 5 * DAY_MS).toISOString() })
}
const automatic = (f: ReturnType<typeof fixture>) => f.coordinator.cleanup.configure({ schemaVersion: 1, graceDays: 1, automaticPurge: true }, true)

test('sweep says what happened to each overdue record, with the bytes it recovered only when the purge succeeded', async () => {
  const f = fixture(); automatic(f)
  await trashedTask(f, 'task'); await trashedTask(f, 'sole', (location) => {
    mkdirSync(join(location, 'terminal-workspace')); writeFileSync(join(location, 'terminal-workspace', 'x.txt'), 'only copy')
    writeFileSync(join(location, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: 'sole', workspaceRelativePath: 'terminal-workspace' }))
  }); await trashedTask(f, 'boom')
  const purge = f.coordinator.cleanup.purge.bind(f.coordinator.cleanup)
  vi.spyOn(f.coordinator.cleanup, 'purge').mockImplementation(async (input) => { if (input.taskId === 'boom') throw new Error('disk is locked'); return purge(input) })
  const outcomes = await f.coordinator.cleanup.sweep(Date.now())
  const byId = Object.fromEntries(outcomes.map((outcome) => [outcome.taskId, outcome]))
  expect(byId.task).toMatchObject({ outcome: 'purged' }); expect(byId.task.bytes).toBeGreaterThan(0)
  expect(byId.sole).toMatchObject({ outcome: 'kept', bytes: 0, reason: expect.stringContaining('retains unpublished or sole-copy content') })
  expect(byId.boom).toMatchObject({ outcome: 'failed', bytes: 0, reason: 'disk is locked' })
  expect(existsSync(join(f.store.require('sole').location, 'terminal-workspace', 'x.txt'))).toBe(true)
})
test('a sweep purges at most five overdue records and the next call continues with the rest', async () => {
  const f = fixture(); automatic(f)
  await trashedTask(f, 'task'); for (let index = 0; index < 6; index++) await trashedTask(f, `t-${index}`)
  expect((await f.coordinator.cleanup.sweep(Date.now())).filter((outcome) => outcome.outcome === 'purged')).toHaveLength(5)
  expect((await f.coordinator.cleanup.sweep(Date.now())).filter((outcome) => outcome.outcome === 'purged')).toHaveLength(2)
  expect(f.coordinator.cleanup.overdueTaskIds(Date.now())).toEqual([])
})
test('a sweep limited to a snapshot attempts only those records, and a request during a sweep gets that sweep', async () => {
  const f = fixture(); automatic(f)
  await trashedTask(f, 'task'); await trashedTask(f, 'other')
  const first = f.coordinator.cleanup.requestSweep(Date.now(), { only: new Set(['other']) }), second = f.coordinator.cleanup.requestSweep(Date.now())
  expect(second).toBe(first)
  expect((await first).map((outcome) => outcome.taskId)).toEqual(['other'])
  expect(f.store.require('task').state).toBe('trashed')
  expect((await f.coordinator.cleanup.requestSweep(Date.now())).map((outcome) => outcome.taskId)).toEqual(['task'])
})
test('a sweep does nothing while automatic emptying is off or the clock guard has suspended it', async () => {
  const f = fixture(); await trashedTask(f, 'task')
  expect(await f.coordinator.cleanup.sweep(Date.now())).toEqual([])
  automatic(f); writeFileSync(join(f.store.root, 'trash-clock.json'), JSON.stringify({ highWater: Date.now(), suspended: true }))
  expect(await f.coordinator.cleanup.sweep(Date.now())).toEqual([]); expect(f.store.require('task').state).toBe('trashed')
})
test('a worktree already retired when the thread was deleted counts 0 bytes when the thread is purged later', async () => {
  const f = fixture({ git: true })
  writeFileSync(join(f.worktree, 'payload.bin'), Buffer.alloc(3 * 1024 * 1024, 7)); git(f.worktree, ['add', '.']); git(f.worktree, ['commit', '-qm', 'payload'])
  const head = git(f.worktree, ['rev-parse', 'HEAD'])
  const workspace = JSON.parse(readFileSync(join(f.location, 'workspace.json'), 'utf8')); workspace.headSha = head; workspace.integrationTarget.baseSha = head
  writeFileSync(join(f.location, 'workspace.json'), JSON.stringify(workspace))
  automatic(f); await trashedTask(f, 'task'); await f.coordinator.cleanup.retireTrashed('task')
  expect(existsSync(f.worktree)).toBe(false)
  const [outcome] = await f.coordinator.cleanup.sweep(Date.now())
  expect(outcome).toMatchObject({ taskId: 'task', outcome: 'purged' }); expect(outcome.bytes).toBeLessThan(1024 * 1024)
})
test('the reclaim estimate counts a present checkout and leaves the preview and its digest alone', async () => {
  const f = fixture({ git: true }); writeFileSync(join(f.worktree, 'payload.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task'), before = JSON.stringify(preview)
  const reclaim = await f.coordinator.cleanup.reclaimEstimate(preview)
  expect(reclaim.bytes).toBeGreaterThan(1024 * 1024); expect(reclaim.partial).toBe(false)
  expect(JSON.stringify(preview)).toBe(before)
  expect((await f.coordinator.cleanup.preview('task')).digest).toBe(preview.digest)
})
test('a purge that fails reports no bytes and records why', async () => {
  const f = fixture(); automatic(f); await trashedTask(f, 'task')
  vi.spyOn(f.coordinator.cleanup, 'purge').mockRejectedValue(new Error('locked'))
  expect(await f.coordinator.cleanup.sweep(Date.now())).toEqual([{ taskId: 'task', outcome: 'failed', reason: 'locked', bytes: 0 }])
  expect(f.store.require('task').blockedReason).toBe('locked')
})

test('the release of what a deleted thread holds outside its folder runs on every pass, and a failure leaves the purge to resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mousse-purge-')); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true }); owned.push(ownedHome(home))
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  let passes = 0
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {},
    beforePurgeRemoval: () => { passes++; if (passes === 1) throw new Error('a file another process holds') } })
  await coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await coordinator.cleanup.preview('task')
  await expect(coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toThrow()
  // Nothing was removed and the purge stays started: the next pass releases again and finishes.
  expect(store.require('task').state).toBe('purge-started')
  expect(existsSync(store.require('task').location)).toBe(true)
  expect((await coordinator.purge({ taskId: 'task', operationId: 'purge' })).state).toBe('purged')
  expect(passes).toBe(2)
})


// ---- A thread whose worktree can't be verified holds only what its records may name (live audit N4) ----
const brokenReason = (worktree: string) => `Thread “Fix prices” has a worktree Mousse can’t check: ${worktree}.`
const HOLD = 'What this thread may share with it stays in the trash with this thread until Mousse can check that worktree again.'

test('a thread whose worktree points at a deleted and recreated repository no longer blocks deleting a thread in another repository', async () => {
  const f = fixture({ git: true }); automatic(f)
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: join(f.root, 'other-repo'), how: 'recreated' })
  await trashedTask(f, 'task')
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([]); expect(preview.retained).toEqual([])
  expect(preview.items.map((item) => item.kind)).toEqual(expect.arrayContaining(['worktree', 'ref', 'path']))
  // The hourly sweep purges it too.
  expect((await f.coordinator.cleanup.sweep(Date.now())).find((outcome) => outcome.taskId === 'task')).toMatchObject({ outcome: 'purged' })
  expect(f.store.require('task').state).toBe('purged'); expect(existsSync(f.worktree)).toBe(false)
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/'])).toBe('')
  // The broken thread is untouched.
  expect(f.store.require('broken').state).toBe('active'); expect(readFileSync(join(broken.worktree, 'a.txt'), 'utf8')).toBe('first\n')
}, 60_000)

test('a broken thread in the same repository keeps this thread in the trash, owning what they may share, and the refusal names that thread and its worktree', async () => {
  const f = fixture({ git: true }); automatic(f)
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: f.repo, how: 'unlinked' })
  const reason = brokenReason(broken.worktree)
  writeFileSync(join(f.worktree, 'kept.txt'), 'kept bytes\n')
  const pins = git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/threads/task/', 'refs/heads/mousse/thread/task/'])
  await trashedTask(f, 'task')
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([`${reason} ${HOLD}`])
  expect(preview.retained).toContainEqual({ identity: f.worktree, reason, unverifiedOwner: 'broken' })
  expect(preview.retained).toContainEqual({ identity: 'refs/mousse/threads/task/main', reason, unverifiedOwner: 'broken' })
  expect(preview.items.filter((item) => item.kind === 'worktree' || item.kind === 'ref')).toEqual([])
  // Neither the sweep nor the person deletes it: what is kept would be left with no thread to own it.
  expect((await f.coordinator.cleanup.sweep(Date.now())).find((outcome) => outcome.taskId === 'task')).toMatchObject({ outcome: 'kept', reason: expect.stringContaining(reason) })
  const fresh = await f.coordinator.cleanup.preview('task')
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: fresh.generation, previewDigest: fresh.digest, discard: true, human: true })).rejects.toThrow()
  expect(f.store.require('task').state).toBe('trashed'); expect(existsSync(join(f.store.require('task').location, 'workspace.json'))).toBe(true)
  expect(readFileSync(join(f.worktree, 'kept.txt'), 'utf8')).toBe('kept bytes\n'); expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/threads/task/', 'refs/heads/mousse/thread/task/'])).toBe(pins)
}, 60_000)

test('a broken thread that names this thread’s worktree through an alias keeps it, with its untracked output and the files its abort kept', async () => {
  const f = fixture({ git: true })
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: join(f.root, 'other-repo'), how: 'recreated' })
  // The broken thread's helper names this worktree through a link to the profile folder, the way /tmp names /private/tmp.
  const alias = join(f.root, 'profile-alias'); symlinkSync(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(broken.location, 'agents.json'), JSON.stringify([{ id: 'helper', worktreePath: join(alias, relative(f.home, f.worktree)), branch: 'mousse/agent/helper', status: 'ready' }]))
  writeFileSync(join(f.worktree, 'output.txt'), 'untracked output\n')
  const kept = await preserveBeforeAbortAsync(f.worktree, 'abort-1')
  new ThreadJournal(f.location).append({ operationId: 'abort-1', operationType: 'publish', state: 'cancelled', details: { conflictAborted: true, preservedRef: kept } })
  const keptSha = git(f.repo, ['rev-parse', kept!])
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.items.filter((item) => item.kind === 'worktree' || item.identity === kept)).toEqual([])
  expect(preview.retained.map((item) => item.identity)).toEqual(expect.arrayContaining([f.worktree, kept]))
  // Both of its worktrees fail the check: its own, and this one named through the alias.
  expect(preview.blockers).toEqual([`Thread “Fix prices” has worktrees Mousse can’t check: ${broken.worktree}, ${join(alias, relative(f.home, f.worktree))}. ${HOLD}`])
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest, discard: true, human: true })).rejects.toThrow()
  expect(readFileSync(join(f.worktree, 'output.txt'), 'utf8')).toBe('untracked output\n')
  expect(git(f.repo, ['rev-parse', kept!])).toBe(keptSha); expect(git(f.repo, ['show', `${keptSha}:a.txt`])).toBe('first')
  expect(f.store.require('task').state).toBe('trashed')
}, 60_000)

test('an unverified thread holds its recorded and real repositories, its real paths and its refs, and nothing else', async () => {
  const f = fixture({ git: true })
  const other = join(f.root, 'other-repo')
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: other, how: 'recreated' })
  const folderRepository = 'f'.repeat(32)
  writeFileSync(join(broken.location, 'project-folder.json'), JSON.stringify({ schemaVersion: 1, kind: 'project-folder', threadId: 'broken', worktreePath: join(f.root, 'gone-folder'), repositoryId: folderRepository }))
  writeFileSync(join(broken.location, 'agents.json'), JSON.stringify([{ id: 'helper', branch: 'mousse/agent/helper', status: 'completed' }]))
  const ownerOf = async () => {
    const claims = await getExternalResourceClaims(f.store, new Set(['task']))
    return { claims, owner: claims.find((claim) => claim.unverified)!.unverified! }
  }
  const { claims, owner } = await ownerOf()
  const over = (target: Parameters<typeof unverifiedOwnerOver>[1]) => unverifiedOwnerOver(claims, target)
  expect(owner).toMatchObject({ taskId: 'broken', reason: brokenReason(broken.worktree), worktrees: [broken.worktree] })
  // The project folder is gone, but its record is the only one naming that repository, so it is held: uncertain.
  expect(owner.repositoryIds).toEqual(expect.arrayContaining([broken.repositoryId, folderRepository]))
  const repositoryA = resolveRepositoryIdentity(f.repo).key
  expect(over({ repositoryIds: [broken.repositoryId] })).toBe(owner)
  expect(over({ repositoryIds: [folderRepository] })).toBe(owner)
  expect(over({ path: await canonicalPathAsync(join(broken.worktree, 'src')) })).toBe(owner)
  expect(over({ path: await canonicalPathAsync(broken.location) })).toBe(owner)
  // Its own namespaces and its id-named refs are held in any repository; a branch name only where no repository tells them apart.
  expect(over({ repositoryIds: [], ref: 'refs/mousse/lifecycle/test/broken/abc/base' })).toBe(owner)
  expect(over({ ref: 'refs/mousse/agents/helper' })).toBe(owner)
  expect(over({ ref: 'refs/heads/mousse/agent/helper' })).toBe(owner)
  expect(over({ ref: 'refs/mousse/changes/11111111-1111-4111-8111-111111111111/before' })).toBeUndefined()
  expect(over({ path: await canonicalPathAsync(f.worktree) })).toBeUndefined()
  // A recorded repository nothing ties to a real one any more may be any repository. Every repository is not held for it;
  // its branch names are, in any repository, besides its id-named refs and namespaces.
  expect(owner.uncertain).toBe(true)
  expect(over({ repositoryIds: [repositoryA] })).toBeUndefined()
  expect(over({ repositoryIds: [repositoryA], path: await canonicalPathAsync(f.worktree), ref: 'refs/heads/mousse/thread/task/main' })).toBeUndefined()
  expect(over({ repositoryIds: [repositoryA], ref: 'refs/heads/mousse/agent/helper' })).toBe(owner)
  expect(over({ repositoryIds: [repositoryA], ref: 'refs/mousse/threads/broken/main' })).toBe(owner)
  rmSync(join(broken.location, 'project-folder.json'))
  const settled = await ownerOf()
  expect(settled.owner.uncertain).toBe(false)
  expect(unverifiedOwnerOver(settled.claims, { repositoryIds: [repositoryA], path: await canonicalPathAsync(f.worktree) })).toBeUndefined()
  expect(unverifiedOwnerOver(settled.claims, { repositoryIds: [repositoryA], ref: 'refs/heads/mousse/agent/helper' })).toBeUndefined()
  expect(unverifiedOwnerOver(settled.claims, { repositoryIds: [repositoryA], ref: 'refs/mousse/agents/helper' })).toBe(settled.owner)
  // The broken checkout and the repository it named both gone: nothing ties the recorded one to a real repository.
  rmSync(broken.worktree, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true })
  const gone = await ownerOf()
  expect(gone.owner.uncertain).toBe(true)
  expect(unverifiedOwnerOver(gone.claims, { repositoryIds: [repositoryA] })).toBeUndefined()
  expect(unverifiedOwnerOver(gone.claims, { repositoryIds: [repositoryA], ref: 'refs/heads/mousse/agent/helper' })).toBe(gone.owner)
}, 60_000)

test('a broken thread whose project folder and worktree were deleted outright no longer blocks deleting a thread in an unrelated repository', async () => {
  const f = fixture({ git: true }); automatic(f)
  const other = join(f.root, 'other-repo')
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: other, how: 'recreated' })
  rmSync(broken.worktree, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true })
  expect((await getExternalResourceClaims(f.store, new Set(['task']))).find((claim) => claim.unverified)?.unverified?.uncertain).toBe(true)
  await trashedTask(f, 'task')
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([]); expect(preview.retained).toEqual([])
  expect(preview.items.map((item) => item.kind)).toEqual(expect.arrayContaining(['worktree', 'ref', 'path']))
  expect((await f.coordinator.cleanup.sweep(Date.now())).find((outcome) => outcome.taskId === 'task')).toMatchObject({ outcome: 'purged' })
  expect(f.store.require('task').state).toBe('purged'); expect(existsSync(f.worktree)).toBe(false)
  expect(git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/'])).toBe('')
}, 60_000)

test('a broken thread whose repository moved without its worktrees repaired keeps its thread pins and receipt refs there through a peer’s purge', async () => {
  const f = fixture({ git: true })
  // The broken thread was made while the repository was at an old place; the repository then moved to where this
  // thread's records point, and the broken thread's worktree was never repaired, so it still points at the old place.
  const old = join(f.root, 'old-place')
  renameSync(f.repo, old)
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: old, how: 'intact' })
  // An Undo receipt of the broken thread, which this thread's journal holds too (as a fork's copy does), and a saved
  // conversation branch of this thread that keeps the broken thread's pin.
  const sha = git(old, ['rev-parse', 'HEAD']), receiptId = '22222222-2222-4222-8222-222222222222', at = new Date().toISOString()
  const receiptRefs = [`refs/mousse/changes/${receiptId}/before`, `refs/mousse/changes/${receiptId}/after`]
  for (const ref of receiptRefs) git(old, ['update-ref', ref, sha])
  const entry = (sequence: number) => JSON.stringify({ schemaVersion: 1, sequence, operationId: 'shared-turn', operationType: 'change-checkpoint', state: 'completed', createdAt: at, details: { receipt: { id: receiptId, kind: 'checkpoint', beforeSha: sha, afterSha: sha, retainedRefs: receiptRefs, createdAt: at } } })
  mkdirSync(join(broken.location, 'journal')); writeFileSync(join(broken.location, 'journal', '0000000000000001.json'), entry(1))
  writeFileSync(join(f.location, 'journal', '0000000000000003.json'), entry(3))
  writeFileSync(join(f.location, 'conversation-branches.json'), JSON.stringify([{ id: 'saved', retainedRef: broken.retainedRef }]))
  renameSync(old, f.repo)
  expect(readFileSync(join(broken.worktree, '.git'), 'utf8')).toContain(old)
  const theirs = () => git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/threads/broken/', 'refs/heads/mousse/thread/broken/', 'refs/mousse/changes/'])
  const ours = () => git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/threads/task/', 'refs/heads/mousse/thread/task/'])
  const before = theirs(), oursBefore = ours()
  expect(before.split('\n')).toHaveLength(4)
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  // The moved repository still registers the broken thread's worktree (the next `git worktree repair` there, which a
  // trash move runs, links it back), so it shares this repository: the delete is refused up front and nothing changes.
  const refused = await f.coordinator.cleanup.preview('task')
  expect(refused.blockers).toEqual([`${brokenReason(broken.worktree)} ${HOLD}`])
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'refused', expectedGeneration: refused.generation, previewDigest: refused.digest, discard: true, human: true })).rejects.toThrow()
  expect(f.store.require('task').state).toBe('trashed'); expect(existsSync(f.worktree)).toBe(true)
  expect(theirs()).toBe(before); expect(ours()).toBe(oursBefore)
  // The person deletes the broken worktree's folder and Git forgets it: nothing ties that thread to a repository now.
  // Its pins and receipt refs are still held by their names, so the purge goes on and leaves them.
  rmSync(broken.worktree, { recursive: true, force: true }); git(f.repo, ['worktree', 'prune'])
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([])
  expect(preview.items.filter((item) => [broken.retainedRef, ...receiptRefs].includes(item.identity))).toEqual([])
  expect((await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest, discard: true, human: true })).state).toBe('purged')
  expect(theirs()).toBe(before)
  expect(existsSync(f.worktree)).toBe(false); expect(ours()).toBe('')
}, 60_000)

test('profile storage the installation does not list still blocks every permanent delete, broken thread or not', async () => {
  const f = fixture({ git: true })
  unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: join(f.root, 'other-repo'), how: 'recreated' })
  ProfileManager.open(createInstallationPaths(f.home)).initializeFresh({ displayName: 'Peer', slug: 'peer' })
  mkdirSync(join(f.home, 'profiles', 'stray'), { recursive: true })
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([expect.stringContaining('Unregistered profile storage')]); expect(preview.items).toEqual([])
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toThrow()
  expect(f.store.require('task').state).toBe('trashed')
  expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
}, 60_000)

test('records that can no longer be read still block every permanent delete: their scope is unknown', async () => {
  const f = fixture({ git: true })
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: join(f.root, 'other-repo'), how: 'recreated' })
  writeFileSync(join(broken.location, 'workspace.json'), '{ not json')
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([expect.stringContaining('Shared ownership cannot be proven')]); expect(preview.items).toEqual([])
}, 60_000)
