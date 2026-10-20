import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadGenerationStore } from '../src/mms/data/ThreadGenerationStore'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { captureThreadLifecyclePath } from '../src/mms/queue/ThreadLifecycleAdmission'
import { settleThreadMutationOwnership } from '../src/mms/queue/ThreadExecutionLease'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function open(home: string) {
  const threads = new ThreadDataStore(new ProjectManager(home), home, { profileId: 'integration', allowLegacyProjectData: false })
  const coordinator = new ResourceLifecycleCoordinator(threads.lifecycleStore, {
    assertCanTrash: (record) => settleThreadMutationOwnership(record.location),
    drain: async () => undefined,
    settleMutationOwnership: async (record) => settleThreadMutationOwnership(record.location),
    projectIndex: (record) => {
      threads.cancelLifecycleQueue(record, record.operations.at(-1)!.id)
      threads.projectLifecycleIndex(record)
    }
  })
  return { threads, coordinator }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mousse-lifecycle-integration-')); homes.push(home)
  return { home, ...open(home) }
}

describe('managed thread lifecycle integration', () => {
  describe('legacy trash index', () => {
    function legacyHome(ids: string[]) {
      const home = mkdtempSync(join(tmpdir(), 'mousse-lifecycle-integration-')); homes.push(home)
      mkdirSync(join(home, 'trash', 'threads'), { recursive: true })
      const entries = ids.map((id) => {
        const trashPath = join(home, 'trash', 'threads', `${id}-old`)
        mkdirSync(trashPath, { recursive: true }); writeFileSync(join(trashPath, 'meta.json'), JSON.stringify({ id, name: id }))
        return { threadId: id, originalPath: join(home, 'thread-data', 'standalone', id), trashPath, tombstonedAt: '2026-01-01T00:00:00Z' }
      })
      const writeIndex = (rows: unknown[]) => writeFileSync(join(home, 'trash', 'threads', 'index.json'), JSON.stringify(rows))
      writeIndex(entries)
      return { home, entries, writeIndex }
    }

    it('adopts uniquely owned entries on open and keeps a restored entry out of the diagnostics', async () => {
      const { home } = legacyHome(['kept'])
      const { threads, coordinator } = open(home)
      expect(threads.lifecycleStore.get('kept')).toMatchObject({ state: 'trashed' })
      expect(threads.refreshLegacyTrash()).toEqual([])
      await coordinator.restore({ taskId: 'kept', operationId: 'restore-kept' })
      // The legacy index is immutable; a restored task must not be re-adopted or reported.
      expect(threads.refreshLegacyTrash()).toEqual([])
      expect(() => threads.assertLifecycleMutationAvailable()).not.toThrow()
    })

    it('reports each unusable entry, blocks lifecycle mutation until the index is repaired, and still adopts the good entries', () => {
      const { home, entries, writeIndex } = legacyHome(['good', 'wrong-meta'])
      writeFileSync(join(entries[1]!.trashPath, 'meta.json'), JSON.stringify({ id: 'someone-else' }))
      writeIndex([...entries, { threadId: 'no-paths' }, { ...entries[0], threadId: '../escape' }])
      const { threads } = open(home)
      expect(threads.lifecycleStore.get('good')).toMatchObject({ state: 'trashed' })
      expect(threads.lifecycleStore.get('wrong-meta')).toBeUndefined()
      const diagnostics = threads.refreshLegacyTrash()
      expect(diagnostics.map((entry) => entry.threadId).sort()).toEqual(['../escape', 'no-paths', 'wrong-meta'])
      expect(diagnostics.every((entry) => entry.reason.length > 0)).toBe(true)
      expect(diagnostics.find((entry) => entry.threadId === 'wrong-meta')?.reason).toMatch(/metadata identity/)
      expect(() => threads.assertLifecycleMutationAvailable()).toThrow(/^Lifecycle migration is blocked: .*Invalid legacy trash ownership record/)
      writeIndex([entries[0]])
      expect(threads.refreshLegacyTrash()).toEqual([])
      expect(() => threads.assertLifecycleMutationAvailable()).not.toThrow()
    })

    it('treats an index that is not an array as one diagnostic without a thread id', () => {
      const { home } = legacyHome([])
      writeFileSync(join(home, 'trash', 'threads', 'index.json'), '{"threadId":"x"}')
      const { threads } = open(home)
      expect(threads.refreshLegacyTrash()).toEqual([{ reason: 'Legacy trash index must be an array' }])
      expect(() => threads.assertLifecycleMutationAvailable()).toThrow(/must be an array/)
    })
  })

  it('leaves independently trashed invocation children trashed when their parent restores', async () => {
    const { lifecycleHarness } = await import('./fixtures/resource-lifecycle-harness')
    const f = await lifecycleHarness()
    try {
      const parent = f.services.threads.createThread('Parent')
      const child = f.services.threads.ensureExecutionThread('independent-trash-child', 'Child', undefined, { parentTaskId: parent.id })
      await f.rpc.request('threads.trash', { threadId: child.id })
      const childLocation = f.services.threads.lifecycleStore.require(child.id).location
      await f.rpc.request('threads.trash', { threadId: parent.id })
      await f.rpc.request('threads.restore', { threadId: parent.id })
      expect(f.services.threads.lifecycleStore.require(child.id)).toMatchObject({ state: 'trashed', location: childLocation })
      expect(f.services.threads.getThread(child.id)).toBeUndefined()
      await f.rpc.request('threads.restore', { threadId: child.id })
      expect(f.services.threads.getThread(child.id)?.id).toBe(child.id)
    } finally { await f.close() }
  })

  it('rejects deterministic execution-thread recreation after restart, then restores its original data', async () => {
    const f = fixture()
    const thread = f.threads.ensureExecutionThread('scheduled-key', 'Scheduled')
    const path = f.threads.getThreadDir(thread.id)
    const before = readFileSync(join(path, 'messages.json'), 'utf8')
    await f.coordinator.trash({ taskId: thread.id, operationId: 'trash' })
    const restarted = open(f.home)
    expect(() => restarted.threads.ensureExecutionThread('scheduled-key', 'Must not recreate')).toThrow()
    expect(existsSync(path)).toBe(false)
    await restarted.coordinator.restore({ taskId: thread.id, operationId: 'restore' })
    expect(readFileSync(join(restarted.threads.getThreadDir(thread.id), 'messages.json'), 'utf8')).toBe(before)
  })

  it('fences cached generation and journal writers across a complete trash/restore cycle', async () => {
    const f = fixture(), thread = f.threads.createThread('Cached writers')
    const path = f.threads.getThreadDir(thread.id)
    const generations = new ThreadGenerationStore(path), journal = new ThreadJournal(path)
    await f.coordinator.trash({ taskId: thread.id, operationId: 'trash' })
    await f.coordinator.restore({ taskId: thread.id, operationId: 'restore' })
    expect(() => generations.publish({ messages: [], agents: [], tasks: [], queue: [] }, 0)).toThrow(/generation|changed/i)
    expect(() => journal.append({ operationId: 'stale', operationType: 'test', state: 'planned' })).toThrow(/generation|changed/i)
    expect(existsSync(join(path, 'generations'))).toBe(false)
  })

  it('invalidates a captured child admission when only its parent moves', async () => {
    const f = fixture(), parent = f.threads.createThread('Parent')
    const child = f.threads.ensureExecutionThread('child-key', 'Child', undefined, { parentTaskId: parent.id })
    const assertCurrent = captureThreadLifecyclePath(f.threads.getThreadDir(child.id))
    await f.coordinator.trash({ taskId: parent.id, operationId: 'trash' })
    expect(() => f.threads.assertThreadAdmission(child.id)).toThrow()
    expect(open(f.home).threads.listAllThreads()).toHaveLength(0)
    await f.coordinator.restore({ taskId: parent.id, operationId: 'restore' })
    expect(assertCurrent).toThrow(/ancestor|generation|changed/i)
    expect(() => f.threads.assertThreadAdmission(child.id)).not.toThrow()
  })
})
