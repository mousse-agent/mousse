import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import type { LifecyclePurgePreview } from '../src/shared/resourceLifecycle'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { measureTree } from './fixtures/resource-lifecycle-qualification'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { registerBranchNamer } from '../src/mms/workspace/branchNaming'
import { BRANCH_RENAME_OPERATION } from '../src/mms/workspace/threadBranchRecords'
import { WORKTREE_TRASH_QUIET_MS, WorktreeRetirementService } from '../src/mms/lifecycle/WorktreeRetirementService'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { releaseExecutionLeaseHandle, waitAcquireExecutionLease } from '../src/mms/queue/ThreadExecutionLease'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'
import { archived } from './support/archived'

it('preserves a shared artifact across its first owner purge and reclaims its bytes after the final owner in repeated public-protocol cycles', async () => {
  const f = await lifecycleHarness()
  try {
    // The conversation that keeps the artifact is written as a JSON transcript: these threads use JSON storage.
    f.services.threads.setSqliteStoreEnabled(false)
    const artifactRoot = join(f.home, 'profiles', f.alice.id, 'artifacts')
    const baseline = measureTree(artifactRoot)
    for (let cycle = 0; cycle < 3; cycle++) {
      const owners: Thread[] = []
      for (const label of ['creator', 'conversation-retainer']) owners.push((await f.rpc.request<{ thread: Thread }>('threads.create', { name: `artifact ${cycle} ${label}` })).thread)
      const bytes = new Uint8Array(4096 * (cycle + 1)).fill(cycle + 41)
      const ref = await f.services.platform.browserArtifacts.put({ profileId: f.alice.id, threadId: owners[0].id, sessionId: `qualification-artifact-${cycle}` },
        { bytes, mediaType: 'application/octet-stream', displayName: `shared artifact ${cycle}` }, 64 * 1024)
      const retainedPath = f.services.threads.getThreadDir(owners[1].id)
      writeFileSync(join(retainedPath, 'messages.json'), JSON.stringify([{ id: `attachment-${cycle}`, role: 'assistant', content: 'Keep this result', timestamp: new Date().toISOString(), artifactRef: ref.id }]))
      const artifactPath = join(artifactRoot, ref.id)
      expect(readFileSync(join(artifactPath, 'blob'))).toEqual(Buffer.from(bytes))
      for (const [index, thread] of owners.entries()) {
        await f.services.trashThread(thread.id)
        const preview = await f.services.lifecycle.cleanup.preview(thread.id)
        expect(preview.blockers).toEqual([])
        if (index === 0) expect(preview.retained.some((resource) => resource.identity === artifactPath)).toBe(true)
        await f.services.lifecycle.purge({ taskId: thread.id, operationId: `artifact-purge-${cycle}-${index}`, expectedGeneration: preview.generation, previewDigest: preview.digest })
        if (index === 0) expect(readFileSync(join(artifactPath, 'blob'))).toEqual(Buffer.from(bytes))
        else expect(existsSync(artifactPath)).toBe(false)
      }
      expect(measureTree(artifactRoot)).toEqual(baseline)
    }
  } finally { await f.close() }
}, 60_000)

it('restarts cleanup at every external irreversible ledger boundary without offering partial restoration', async () => {
  let boundaryCount = 1
  for (let boundary = 0; boundary < boundaryCount; boundary++) {
    const f = gitFoundationFixture()
    try {
      const location = join(f.home, 'thread-data', 'task')
      mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
      writeFileSync(join(location, 'messages.json'), '[{"role":"user","content":"retained until final purge"}]')
      const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
      store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
      const workspace = await new ThreadWorkspaceManager(location).provision('task', 'main', f.repo)
      let reached = 0, injected = false
      const hooks = { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} }
      const coordinator = new ResourceLifecycleCoordinator(store, { ...hooks, onPhase: (_record, phase) => {
        if (phase === 'purge-started' && reached++ === boundary) { injected = true; throw new Error(`qualification boundary ${boundary}`) }
      } })
      await coordinator.trash({ taskId: 'task', operationId: 'boundary-trash' })
      const preview = await coordinator.cleanup.preview('task')
      expect(preview.blockers).toEqual([])
      if (boundary === 0) boundaryCount = preview.items.length + 1
      else expect(preview.items.length + 1).toBe(boundaryCount)
      await expect(coordinator.purge({ taskId: 'task', operationId: 'boundary-purge', expectedGeneration: preview.generation, previewDigest: preview.digest }))
        .rejects.toMatchObject({ code: 'resource_purge_failed', cause: expect.objectContaining({ message: `qualification boundary ${boundary}` }), errorInfo: { category: 'internal', retryable: false } })
      expect(injected).toBe(true)
      expect(store.require('task').state).toBe('purge-started')
      await expect(coordinator.restore({ taskId: 'task', operationId: 'restore-partial' })).rejects.toThrow(/purge-started/)
      const restartedStore = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
      registerThreadLifecycleGate(f.home, restartedStore)
      const restarted = new ResourceLifecycleCoordinator(restartedStore, hooks)
      const recovered = await restarted.recover('task')
      expect(recovered.state).toBe('purged')
      expect(existsSync(recovered.location)).toBe(false)
      expect(existsSync(workspace.worktreePath)).toBe(false)
      expect((await restarted.purge({ taskId: 'task', operationId: 'boundary-purge' })).state).toBe('purged')
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/mousse/', 'refs/heads/mousse/')).toBe('')
      expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
    } finally { f.dispose() }
  }
  expect(boundaryCount).toBeGreaterThan(3)
}, 120_000)

it.each([
  ['named by the title model outside mousse/', false],
  ['a person\'s, named only by an edited workspace record', true]
])('a purged thread\'s branch %s', async (_case, edited) => {
  const f = gitFoundationFixture()
  try {
    const location = join(f.home, 'thread-data', 'task')
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
    const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
    store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
    const forget = registerBranchNamer(f.home, { settings: () => ({ mode: 'semantic', prefix: 'team', instructions: '' }), ask: async () => 'fix/login-button' })
    const manager = new ThreadWorkspaceManager(location)
    await manager.provision('task', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
    await manager.branchNaming
    forget()
    expect(manager.load()!.branch).toBe('fix/login-button')
    git(f.repo, 'branch', 'feature/theirs')
    if (edited) writeFileSync(join(location, 'workspace.json'), JSON.stringify({ ...manager.load(), branch: 'feature/theirs' }))
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
    await coordinator.trash({ taskId: 'task', operationId: 'branch-trash' })
    const preview = await coordinator.cleanup.preview('task')
    if (edited) {
      // The journal never names it: it is not Mousse's to delete, whatever the record says.
      expect(preview.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/not Mousse-owned|no longer owns/)]))
    } else {
      expect(preview.blockers).toEqual([])
      expect(preview.items).toContainEqual(expect.objectContaining({ kind: 'ref', identity: 'refs/heads/fix/login-button' }))
      await coordinator.purge({ taskId: 'task', operationId: 'branch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
      expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/fix/', 'refs/heads/team/')).toBe('')
    }
    expect(git(f.repo, 'branch', '--list', 'feature/theirs', '--format=%(refname:short)')).toBe('feature/theirs')
  } finally { f.dispose() }
}, 120_000)

/** A registered thread `task` in a fresh repository, with its worktree made on `prefix` and named `answer` (none: kept). */
async function threadWithBranch(prefix: string, answer: string | undefined) {
  const f = gitFoundationFixture()
  const location = join(f.home, 'thread-data', 'task')
  mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
  const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
  store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
  const forget = registerBranchNamer(f.home, { settings: () => ({ mode: 'semantic', prefix, instructions: '' }), ask: async () => answer })
  const manager = new ThreadWorkspaceManager(location)
  const made = await manager.provision('task', 'main', f.repo, undefined, undefined, undefined, { nameFrom: 'Fix the login button' })
  await manager.branchNaming
  forget()
  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
  return { f, location, store, manager, made, coordinator }
}

it.each(['mousse', 'team'])('a thread whose branch rename was settled without knowing its outcome (prefix %s) is purged, and its branch stays', async (prefix) => {
  const t = await threadWithBranch(prefix, undefined)
  try {
    const { made, manager } = t
    const fromSha = git(t.f.repo, 'rev-parse', made.branch)
    manager.journal.append({ operationId: 'rename-1', operationType: BRANCH_RENAME_OPERATION, state: 'planned', expectedPreState: { from: made.branch, to: 'fix/login-button', worktreePath: made.worktreePath, fromSha } })
    manager.journal.append({ operationId: 'rename-1', operationType: BRANCH_RENAME_OPERATION, state: 'cancelled', details: { from: made.branch, to: 'fix/login-button', settled: true, disowned: true } })
    await t.coordinator.trash({ taskId: 'task', operationId: 'branch-trash' })
    const preview = await t.coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    expect(preview.retained).toContainEqual(expect.objectContaining({ identity: `refs/heads/${made.branch}` }))
    expect(preview.items.some((item) => item.identity === `refs/heads/${made.branch}`)).toBe(false)
    await t.coordinator.purge({ taskId: 'task', operationId: 'branch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(git(t.f.repo, 'rev-parse', made.branch)).toBe(fromSha)
  } finally { t.f.dispose() }
}, 120_000)

it.each([
  { state: 'failed', legacy: false },
  { state: 'failed', legacy: true },
  { state: 'planned', legacy: true }
])('permanent purge preserves a replacement branch at the same commit after a $state provision (legacy: $legacy)', async ({ state, legacy }) => {
  const { f, store, location, manager, made, coordinator } = await threadWithBranch('mousse', undefined)
  try {
    // Keep the checkout available for the reconstruction proof without checking out the planned name.
    git(made.worktreePath, 'switch', '--detach')
    const taskLease = await waitAcquireExecutionLease(location)
    const repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
    try {
      const retirement = new WorktreeRetirementService(store, { taskLease, repositoryLease })
      await retirement.prepare({ taskId: 'task', worktreePath: made.worktreePath, branch: made.branch, sourcePath: join(location, 'workspace.json') })
      await retirement.retire(retirement.pathFor('task', made.worktreePath))
    } finally { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) }

    // The checkout has a reconstruction manifest, but its only provision record has no success record.
    // Git lets the user take its name at the same tip.
    renameSync(join(location, 'journal'), join(f.root, 'original-journal'))
    const journal = new ThreadWorkspaceManager(location).journal
    journal.append({ operationId: 'unproven', operationType: 'workspace-provision', state: 'planned', expectedPreState: { branch: made.branch, worktreePath: made.worktreePath, ...(legacy ? {} : { requiresCompletion: true }) } })
    if (state === 'failed') journal.append({ operationId: 'unproven', operationType: 'workspace-provision', state: 'failed' })
    if (git(f.repo, 'branch', '--list', made.branch)) git(f.repo, 'branch', '-D', made.branch)
    git(f.repo, 'branch', made.branch, made.headSha)
    expect(git(f.repo, 'rev-parse', made.branch)).toBe(made.headSha)
    expect(manager.load()!.branch).toBe(made.branch)

    await coordinator.trash({ taskId: 'task', operationId: 'collision-trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    expect(preview.retained).toContainEqual(expect.objectContaining({ identity: `refs/heads/${made.branch}` }))
    const purged = await coordinator.purge({ taskId: 'task', operationId: 'collision-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(purged.state).toBe('purged')
    expect(git(f.repo, 'rev-parse', made.branch)).toBe(made.headSha)
  } finally { f.dispose() }
}, 120_000)

it('a thread\'s branch that retirement deleted, made again by the person with their commits, survives the thread\'s purge', async () => {
  const t = await threadWithBranch('team', 'fix/login-button')
  try {
    const { f, store, location, manager } = t
    expect(manager.load()!.branch).toBe('fix/login-button')
    const worktreePath = manager.load()!.worktreePath
    // The worktree is retired and its trash expires: Mousse deletes the branch it made.
    const taskLease = await waitAcquireExecutionLease(location), repositoryLease = await acquireRepositoryLease(resolveRepositoryIdentity(f.repo))
    try {
      const service = new WorktreeRetirementService(store, { taskLease, repositoryLease })
      await service.prepare({ taskId: 'task', worktreePath, branch: 'fix/login-button', sourcePath: join(location, 'workspace.json') })
      const path = service.pathFor('task', worktreePath)
      await service.retire(path)
      expect(await service.expireTrash(path, { now: Date.now() + 2 * WORKTREE_TRASH_QUIET_MS })).toEqual({ removed: true })
    } finally { repositoryLease.release(); releaseExecutionLeaseHandle(taskLease) }
    expect(git(f.repo, 'branch', '--list', 'fix/login-button')).toBe('')
    // Later the person makes a branch of that name with their own work.
    const theirs = git(f.repo, 'commit-tree', `${f.baseSha}^{tree}`, '-p', f.baseSha, '-m', 'their own work')
    git(f.repo, 'branch', 'fix/login-button', theirs)
    await t.coordinator.trash({ taskId: 'task', operationId: 'branch-trash' })
    const preview = await t.coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    expect(preview.items.some((item) => item.identity === 'refs/heads/fix/login-button')).toBe(false)
    await t.coordinator.purge({ taskId: 'task', operationId: 'branch-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
    expect(git(f.repo, 'rev-parse', 'fix/login-button')).toBe(theirs)
  } finally { t.f.dispose() }
}, 120_000)

it.each(['replaced', 'legacy', 'unchanged'] as const)('resumes purge after worktree removal with a %s branch', async (scenario) => {
  const { f, store, made } = await threadWithBranch('mousse', undefined)
  const ref = `refs/heads/${made.branch}`
  const hooks = { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} }
  try {
    const interrupted = new ResourceLifecycleCoordinator(store, { ...hooks, onPhase: (record, phase) => {
      if (phase === 'purge-started' && record.purge?.items.some((item) => item.kind === 'worktree' && item.status === 'removed')) {
        throw new Error('worktree removed, branch still pending')
      }
    } })
    await interrupted.trash({ taskId: 'task', operationId: 'resume-trash' })
    const preview = await interrupted.cleanup.preview('task')
    await expect(interrupted.purge({ taskId: 'task', operationId: 'resume-purge', expectedGeneration: preview.generation, previewDigest: preview.digest }))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: 'worktree removed, branch still pending' }) })
    expect(existsSync(made.worktreePath)).toBe(false)
    expect(store.require('task').purge!.items.find((item) => item.identity === ref)?.status).toBe('pending')

    if (scenario === 'legacy') {
      store.update('task', (task) => {
        const branch = task.purge!.items.find((item) => item.identity === ref)!
        delete branch.branchProvenance
        const original = { ...preview, digest: '', items: preview.items.map((item) => {
          if (item.identity !== ref) return item
          const legacy = { ...item }
          delete legacy.branchProvenance
          return legacy
        }) }
        task.purge!.digest = createHash('sha256').update(JSON.stringify(original)).digest('hex')
      })
    }
    unlinkSync(join(store.require('task').location, 'workspace.json'))
    if (scenario === 'replaced') {
      git(f.repo, 'branch', '-D', made.branch)
      git(f.repo, 'branch', made.branch, made.headSha)
    }
    expect(git(f.repo, 'rev-parse', ref)).toBe(made.headSha)

    const restartedStore = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
    registerThreadLifecycleGate(f.home, restartedStore)
    const recovered = await new ResourceLifecycleCoordinator(restartedStore, hooks).recover('task')
    expect(recovered.state).toBe('purged')
    if (scenario === 'unchanged') {
      expect(git(f.repo, 'branch', '--list', made.branch)).toBe('')
    } else {
      expect(git(f.repo, 'rev-parse', ref)).toBe(made.headSha)
      expect(recovered.purge!.items).toContainEqual(expect.objectContaining({ identity: ref, status: 'retained', retainedReason: expect.any(String) }))
    }
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  } finally { f.dispose() }
}, 120_000)

it('keeps an interrupted purge pending while its repository is offline and resumes only after the same repository returns', async () => {
  const f = gitFoundationFixture()
  const online = join(f.repo, '.git'), offline = join(f.repo, '.git-qualification-offline')
  try {
    const location = join(f.home, 'thread-data', 'task')
    mkdirSync(location, { recursive: true }); writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
    const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
    store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
    await new ThreadWorkspaceManager(location).provision('task', 'main', f.repo)
    let interrupt = true
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {}, onPhase: (_record, phase) => {
      if (phase === 'purge-started' && interrupt) { interrupt = false; throw new Error('offline fixture boundary') }
    } })
    await coordinator.trash({ taskId: 'task', operationId: 'offline-trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    await expect(coordinator.purge({ taskId: 'task', operationId: 'offline-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toMatchObject({ code: 'resource_purge_failed', cause: expect.objectContaining({ message: 'offline fixture boundary' }) })
    // Both fixed paths are inside this disposable fixture repository.
    renameSync(online, offline)
    await expect(coordinator.recover('task')).rejects.toMatchObject({ code: 'resource_purge_repository_unavailable', errorInfo: { category: 'unavailable', retryable: false } })
    const pending = store.require('task')
    expect(pending.state).toBe('purge-started')
    expect(pending.purge!.completedAt).toBeUndefined()
    expect(pending.purge!.items.some((item) => item.status === 'pending')).toBe(true)
    await expect(coordinator.restore({ taskId: 'task', operationId: 'offline-restore' })).rejects.toThrow(/purge-started/)
    renameSync(offline, online)
    expect((await coordinator.recover('task')).state).toBe('purged')
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseSha)
  } finally { if (existsSync(offline)) renameSync(offline, online); f.dispose() }
}, 30_000)

it('rejects a reviewed purge preview after retained source bytes change and preserves the new sole copy', async () => {
  const f = await lifecycleHarness()
  try {
    const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'stale review proof' })
    await f.services.trashThread(thread.id)
    const preview = await f.services.lifecycle.cleanup.preview(thread.id)
    expect(preview.blockers).toEqual([])
    const before = f.services.threads.lifecycleStore.require(thread.id)
    const path = join(before.location, 'after-review.bin'), bytes = Buffer.from([0, 255, 7, 91])
    writeFileSync(path, bytes)
    await expect(f.services.lifecycle.purge({ taskId: thread.id, operationId: 'stale-preview', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toThrow(/preview.*changed|fresh.*inventory/i)
    expect(readFileSync(path)).toEqual(bytes)
    const after = f.services.threads.lifecycleStore.require(thread.id)
    expect(after.state).toBe('trashed')
    expect(after.purge).toBeUndefined()
    await f.services.restoreThread(thread.id)
    expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'after-review.bin'))).toEqual(bytes)
  } finally { await f.close() }
})

it.each(['oversized', 'null', 'missing-owner'] as const)('blocks cleanup when a %s peer artifact index prevents proving exclusive ownership', async (corruption) => {
  const f = await lifecycleHarness()
  try {
    const creator = (await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'oversized index creator' })).thread
    const other = (await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'other artifact retainer' })).thread
    const ref = await f.services.platform.browserArtifacts.put({ profileId: f.alice.id, threadId: creator.id, sessionId: 'oversized-index' }, { bytes: new Uint8Array([17, 23, 41]), mediaType: 'application/octet-stream', displayName: 'shared oversized index fixture' }, 1024)
    writeFileSync(join(f.services.threads.getThreadDir(other.id), 'messages.json'), JSON.stringify([{ role: 'assistant', content: 'Retain artifact', artifactRef: ref.id }]))
    const profileHome = join(f.home, 'profiles', f.alice.id)
    const index = join(profileHome, 'browser', 'artifact-index', `${ref.id}.json`)
    const original = readFileSync(index, 'utf8')
    await f.services.trashThread(other.id)
    // Unreadable or malformed association authority cannot become no owner.
    if (corruption === 'oversized') writeFileSync(index, original + ' '.repeat(33 * 1024 * 1024))
    else if (corruption === 'null') writeFileSync(index, 'null')
    else { const value = JSON.parse(original); delete value.scope.threadId; writeFileSync(index, JSON.stringify(value)) }
    const preview = await f.services.lifecycle.cleanup.preview(other.id)
    expect(preview.blockers.length, 'Unreadable peer authority must fail closed before shared blob deletion').toBeGreaterThan(0)
    expect(readFileSync(join(profileHome, 'artifacts', ref.id, 'blob'))).toEqual(Buffer.from([17, 23, 41]))
  } finally { await f.close() }
})
