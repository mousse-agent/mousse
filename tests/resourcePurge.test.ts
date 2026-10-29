import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { lifecycleGit as git, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(options: { git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mousse-purge-')); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true })
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
