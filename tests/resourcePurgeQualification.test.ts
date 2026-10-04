import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Thread } from '../src/shared/types'
import type { LifecyclePurgePreview } from '../src/shared/resourceLifecycle'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { measureTree } from './fixtures/resource-lifecycle-qualification'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

it('preserves a shared artifact across its first owner purge and reclaims its bytes after the final owner in repeated public-protocol cycles', async () => {
  const f = await lifecycleHarness()
  try {
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
        await f.rpc.request('threads.trash', { threadId: thread.id })
        const { preview } = await f.rpc.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
        expect(preview.blockers).toEqual([])
        if (index === 0) expect(preview.retained.some((resource) => resource.identity === artifactPath)).toBe(true)
        await f.rpc.request('threads.purge', { threadId: thread.id, operationId: `artifact-purge-${cycle}-${index}`, expectedGeneration: preview.generation, previewDigest: preview.digest })
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
        .rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: `qualification boundary ${boundary}` }) })
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
    await expect(coordinator.purge({ taskId: 'task', operationId: 'offline-purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: 'offline fixture boundary' }) })
    // Both fixed paths are inside this disposable fixture repository.
    renameSync(online, offline)
    await expect(coordinator.recover('task')).rejects.toMatchObject({ code: 'resource_purge_failed', details: { supportId: expect.any(String) }, cause: expect.objectContaining({ message: expect.stringMatching(/repository.*unavailable|unavailable.*repository/i) }) })
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
    await f.rpc.request('threads.trash', { threadId: thread.id })
    const { preview } = await f.rpc.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: thread.id, preview: true })
    expect(preview.blockers).toEqual([])
    const before = f.services.threads.lifecycleStore.require(thread.id)
    const path = join(before.location, 'after-review.bin'), bytes = Buffer.from([0, 255, 7, 91])
    writeFileSync(path, bytes)
    await expect(f.rpc.request('threads.purge', { threadId: thread.id, operationId: 'stale-preview', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toThrow(/preview.*changed|fresh.*inventory/i)
    expect(readFileSync(path)).toEqual(bytes)
    const after = f.services.threads.lifecycleStore.require(thread.id)
    expect(after.state).toBe('trashed')
    expect(after.purge).toBeUndefined()
    await f.rpc.request('threads.restore', { threadId: thread.id })
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
    await f.rpc.request('threads.trash', { threadId: other.id })
    // Unreadable or malformed association authority cannot become no owner.
    if (corruption === 'oversized') writeFileSync(index, original + ' '.repeat(33 * 1024 * 1024))
    else if (corruption === 'null') writeFileSync(index, 'null')
    else { const value = JSON.parse(original); delete value.scope.threadId; writeFileSync(index, JSON.stringify(value)) }
    const { preview } = await f.rpc.request<{ preview: LifecyclePurgePreview }>('threads.purge', { threadId: other.id, preview: true })
    expect(preview.blockers.length, 'Unreadable peer authority must fail closed before shared blob deletion').toBeGreaterThan(0)
    expect(readFileSync(join(profileHome, 'artifacts', ref.id, 'blob'))).toEqual(Buffer.from([17, 23, 41]))
  } finally { await f.close() }
})
