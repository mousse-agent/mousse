import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ThreadGenerationStore } from '../src/mms/data/ThreadGenerationStore'
import { ThreadJournal } from '../src/mms/data/ThreadJournal'
import { atomicWriteJsonSync } from '../src/mms/data/AtomicFs'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { captureThreadLifecyclePath } from '../src/mms/queue/ThreadLifecycleAdmission'
import { settleThreadMutationOwnership, withQueueMutationLock, withThreadDataMutationLock } from '../src/mms/queue/ThreadExecutionLease'

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

  it('rejects old queue/data/atomic paths without recreating moved directories', async () => {
    const f = fixture(), thread = f.threads.createThread('Old paths')
    const path = f.threads.getThreadDir(thread.id)
    await f.coordinator.trash({ taskId: thread.id, operationId: 'trash' })
    expect(() => withQueueMutationLock(path, () => undefined)).toThrow()
    expect(() => withThreadDataMutationLock(path, () => undefined)).toThrow()
    expect(() => atomicWriteJsonSync(join(path, 'messages.json'), [])).toThrow()
    expect(existsSync(path)).toBe(false)
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
