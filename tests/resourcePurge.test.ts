import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { lifecycleGit as git } from '../src/mms/lifecycle/WorktreeRetirementService'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(options: { git?: boolean; boundary?: (record: ReturnType<ResourceLifecycleStore['require']>) => void } = {}) {
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
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: (record) => { projected.push(record.taskId) }, onPhase: (record, phase) => { if (phase === 'purge-started') options.boundary?.(record) } })
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
test('crash at irreversible boundary forbids restore and resumes from external ledger', async () => {
  let crash = true
  const f = fixture({ boundary: () => { if (crash) { crash = false; throw new Error('injected crash') } } })
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); const preview = await f.coordinator.cleanup.preview('task')
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: expect.stringContaining('injected') }) })
  await expect(f.coordinator.restore({ taskId: 'task', operationId: 'restore' })).rejects.toThrow(/purge-started/)
  expect((await f.coordinator.recover('task')).state).toBe('purged')
})
test('dirty sole copy needs a human exact preview discard; automatic request preserves it', async () => {
  const f = fixture({ git: true }); writeFileSync(join(f.worktree, 'secret.txt'), 'only copy')
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' }); const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([]); expect(preview.items.some((item) => item.discardRequired)).toBe(true)
  const request = { taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest }
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: expect.stringMatching(/human-reviewed/) }) })
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
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: expect.stringMatching(/human-reviewed/) }) })
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
  await expect(f.coordinator.purge(request)).rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: expect.stringMatching(/human-reviewed/) }) })
  expect(readFileSync(join(movedContainer, kind === 'terminal' ? 'terminal-workspace' : 'workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
  await f.coordinator.purge({ ...request, human: true, discard: true })
  expect(existsSync(movedContainer)).toBe(false)
})
