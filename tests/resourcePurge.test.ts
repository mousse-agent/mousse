import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const BROKEN_REASON = 'Thread “Fix prices” points at a worktree whose repository is gone.'

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

test('what a broken thread in the same repository may still use is kept back with its name, and automatic cleanup waits for the person', async () => {
  const f = fixture({ git: true }); automatic(f)
  unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: f.repo, how: 'unlinked' })
  writeFileSync(join(f.worktree, 'kept.txt'), 'kept bytes\n')
  const pins = git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/threads/task/', 'refs/heads/mousse/thread/task/'])
  await trashedTask(f, 'task')
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([])
  expect(preview.retained).toContainEqual({ identity: f.worktree, reason: BROKEN_REASON, unverifiedOwner: 'broken' })
  expect(preview.retained).toContainEqual({ identity: 'refs/mousse/threads/task/main', reason: BROKEN_REASON, unverifiedOwner: 'broken' })
  expect(preview.items.filter((item) => item.kind === 'worktree' || item.kind === 'ref')).toEqual([])
  expect(preview.items.some((item) => item.kind === 'path' && item.identity === f.store.require('task').location)).toBe(true)
  // Deleting it unattended would leave what is kept with no thread: the sweep keeps it and says why.
  expect((await f.coordinator.cleanup.sweep(Date.now())).find((outcome) => outcome.taskId === 'task')).toMatchObject({ outcome: 'kept', reason: expect.stringContaining(BROKEN_REASON) })
  expect(f.store.require('task').state).toBe('trashed')
  // The person can still delete it; what is kept back stays byte for byte.
  const fresh = await f.coordinator.cleanup.preview('task')
  expect((await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: fresh.generation, previewDigest: fresh.digest })).state).toBe('purged')
  expect(readFileSync(join(f.worktree, 'kept.txt'), 'utf8')).toBe('kept bytes\n'); expect(readFileSync(join(f.worktree, 'a.txt'), 'utf8')).toBe('first\n')
  expect(git(f.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/mousse/threads/task/', 'refs/heads/mousse/thread/task/'])).toBe(pins)
}, 60_000)

test('an unverified thread holds its repositories, its paths and its refs, and a thread whose records name no repository never holds every one', async () => {
  const f = fixture({ git: true })
  const broken = unverifiableThread(f.store, { id: 'broken', name: 'Fix prices', repo: join(f.root, 'other-repo'), how: 'recreated' })
  const claims = await getExternalResourceClaims(f.store, new Set(['task']))
  const owner = claims.find((claim) => claim.unverified)!.unverified!
  expect(owner).toMatchObject({ taskId: 'broken', reason: BROKEN_REASON, repositoryIds: [broken.repositoryId] })
  const repositoryA = resolveRepositoryIdentity(f.repo).key
  expect(unverifiedOwnerOver(claims, { repositoryId: broken.repositoryId })).toBe(owner)
  expect(unverifiedOwnerOver(claims, { path: join(broken.worktree, 'src') })).toBe(owner)
  expect(unverifiedOwnerOver(claims, { path: broken.location })).toBe(owner)
  expect(unverifiedOwnerOver(claims, { repositoryId: repositoryA, path: f.worktree })).toBeUndefined()
  // A ref name counts only where no repository tells them apart.
  expect(unverifiedOwnerOver(claims, { ref: 'refs/mousse/threads/broken/other' })).toBe(owner)
  expect(unverifiedOwnerOver(claims, { repositoryId: repositoryA, ref: 'refs/mousse/threads/broken/other' })).toBeUndefined()
  const withoutRepository = claims.map((claim) => claim.unverified ? { ...claim, unverified: { ...claim.unverified, repositoryIds: [] } } : claim)
  expect(unverifiedOwnerOver(withoutRepository, { repositoryId: repositoryA, ref: 'refs/mousse/changes/11111111-1111-4111-8111-111111111111/before' })).toBeUndefined()
  expect(unverifiedOwnerOver(withoutRepository, { repositoryId: repositoryA, ref: broken.retainedRef })).toBe(withoutRepository.find((claim) => claim.unverified)!.unverified)
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
