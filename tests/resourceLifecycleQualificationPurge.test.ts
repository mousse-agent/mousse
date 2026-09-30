import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

it('does not dereference a user branch substituted after the irreversible purge boundary', async () => {
  const f = gitFoundationFixture()
  try {
    const location = join(f.home, 'thread-data', 'task')
    mkdirSync(location, { recursive: true })
    writeFileSync(join(location, 'meta.json'), '{"id":"task"}')
    writeFileSync(join(location, 'messages.json'), '[]')
    const store = new ResourceLifecycleStore({ profileId: 'qualification', profileHome: f.home })
    store.registerTask({ taskId: 'task', location }); registerThreadLifecycleGate(f.home, store)
    const workspace = await new ThreadWorkspaceManager(location).provision('task', 'main', f.repo)
    const primary = git(f.repo, 'symbolic-ref', 'HEAD'), head = git(f.repo, 'rev-parse', primary)
    let replaced = false
    const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {},
      projectIndex: () => {}, projectPurged: () => {}, onPhase: (record, phase) => {
        if (phase === 'purge-started' && !replaced) {
          expect(record.purge?.items.some((item) => item.kind === 'ref' && item.identity === workspace.retainedRef)).toBe(true)
          git(f.repo, 'symbolic-ref', workspace.retainedRef, primary)
          replaced = true
        }
      } })
    await coordinator.trash({ taskId: 'task', operationId: 'qualification-trash' })
    const preview = await coordinator.cleanup.preview('task')
    expect(preview.blockers).toEqual([])
    await expect(coordinator.purge({ taskId: 'task', operationId: 'qualification-purge', expectedGeneration: preview.generation, previewDigest: preview.digest }))
      .rejects.toThrow(/symbolic|reference/i)
    expect(replaced).toBe(true)
    expect(git(f.repo, 'rev-parse', primary)).toBe(head)
    expect(store.require('task').state).toBe('purge-started')
    expect(existsSync(store.require('task').location)).toBe(true)
    await expect(coordinator.restore({ taskId: 'task', operationId: 'qualification-restore' })).rejects.toThrow(/purge-started/)
  } finally { f.dispose() }
}, 30_000)
