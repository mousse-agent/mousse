import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { backfillSubagentLineage, lineageForChild } from '../src/mms/data/subagentLineage'
import { ThreadDataStore } from '../src/mms/data/ThreadDataStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { settleThreadMutationOwnership } from '../src/mms/queue/ThreadExecutionLease'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function open(home: string) {
  const threads = new ThreadDataStore(new ProjectManager(home), home, { profileId: 'subagents', allowLegacyProjectData: false })
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
  const home = mkdtempSync(join(tmpdir(), 'mousse-subagent-lineage-')); homes.push(home)
  return { home, ...open(home) }
}

/** A subagent the way `createChildThread` makes one. */
function child(threads: ThreadDataStore, parentId: string, name = 'Child') {
  const parent = threads.getThread(parentId)!
  return threads.createThread(name, undefined, undefined, {
    lineage: lineageForChild(parent),
    ownerThreadId: parentId,
    workspaceBinding: { policy: 'isolated' },
    modelOverride: { instanceId: 'pi:openai', llmProvider: 'openai', model: 'gpt-x' }
  })
}

describe('subagent thread metadata and ownership', () => {
  it('writes lineage, binding and model with the first meta and registers the parent as owner', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const sub = child(threads, parent.id)
    expect(sub).toMatchObject({
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' },
      workspaceBinding: { policy: 'isolated' },
      modelOverride: { model: 'gpt-x' }
    })
    expect(threads.getThread(sub.id)).toMatchObject({ lineage: { parentThreadId: parent.id } })
    expect(threads.listAllThreads().find((thread) => thread.id === sub.id)?.lineage?.rootThreadId).toBe(parent.id)
    expect(threads.lifecycleStore.require(sub.id).parentTaskId).toBe(parent.id)
  })

  it('a grandchild keeps the root of its parent', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const sub = child(threads, parent.id)
    const grandchild = child(threads, sub.id)
    expect(grandchild.lineage).toMatchObject({ parentThreadId: sub.id, rootThreadId: parent.id })
  })

  it('registers an owner that had no lifecycle record yet', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    threads.lifecycleStore.forgetCreatedTask(parent.id)
    expect(threads.lifecycleStore.get(parent.id)).toBeUndefined()
    const sub = child(threads, parent.id)
    expect(threads.lifecycleStore.require(parent.id).state).toBe('active')
    expect(threads.lifecycleStore.require(sub.id).parentTaskId).toBe(parent.id)
  })

  it('trashing the parent takes its subagents along and restoring it brings them back with their lineage', async () => {
    const { threads, coordinator } = fixture()
    const parent = threads.createThread('Parent')
    const sub = child(threads, parent.id)
    await coordinator.trash({ taskId: parent.id, operationId: 'trash' })
    expect(threads.getThread(sub.id)).toBeUndefined()
    expect(threads.listAllThreads().map((thread) => thread.id)).not.toContain(sub.id)
    await coordinator.restore({ taskId: parent.id, operationId: 'restore' })
    expect(threads.getThread(sub.id)).toMatchObject({ id: sub.id, lineage: { parentThreadId: parent.id } })
    expect(threads.listAllThreads().map((thread) => thread.id)).toContain(sub.id)
  })

  it('updateThreadMeta can set lineage and keeps updatedAt on request', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const plain = threads.createThread('Plain')
    const lineage = lineageForChild(parent)
    const kept = threads.updateThreadMeta(plain.id, { lineage }, { touch: false })
    expect(kept).toMatchObject({ lineage, updatedAt: plain.updatedAt })
    const touched = threads.updateThreadMeta(plain.id, { name: 'Renamed' })
    expect(touched.updatedAt >= plain.updatedAt).toBe(true)
    expect(touched.lineage).toEqual(lineage)
  })
})

describe('failed creation of a subagent', () => {
  it('discarding an unused owned subagent removes it and its registration and leaves the owner alone', async () => {
    const { threads, coordinator } = fixture()
    const parent = threads.createThread('Parent')
    const sub = child(threads, parent.id)
    const dir = threads.getThreadDir(sub.id)
    threads.discardUnusedThread(sub.id)
    expect(existsSync(dir)).toBe(false)
    expect(threads.lifecycleStore.get(sub.id)).toBeUndefined()
    expect(threads.getThread(sub.id)).toBeUndefined()
    expect(threads.lifecycleStore.require(parent.id)).toMatchObject({ state: 'active' })
    // The owner still trashes and restores normally: nothing dangling is left under it.
    await coordinator.trash({ taskId: parent.id, operationId: 'trash' })
    await coordinator.restore({ taskId: parent.id, operationId: 'restore' })
    expect(threads.getThread(parent.id)?.id).toBe(parent.id)
  })

  it('refuses a subagent that has messages', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const sub = child(threads, parent.id)
    writeFileSync(join(threads.getThreadDir(sub.id), 'messages.json'), JSON.stringify([{ id: 'm', role: 'user', content: 'hi' }]))
    expect(() => threads.discardUnusedThread(sub.id)).toThrow(/has messages/)
    expect(threads.lifecycleStore.require(sub.id).parentTaskId).toBe(parent.id)
  })

  it('refuses, before touching anything, a thread owned by someone other than the parent its lineage names', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const other = threads.createThread('Other')
    const sub = child(threads, parent.id)
    threads.updateThreadMeta(sub.id, { lineage: lineageForChild(other) })
    const dir = threads.getThreadDir(sub.id)
    expect(() => threads.discardUnusedThread(sub.id)).toThrow(/owned by/)
    expect(existsSync(dir)).toBe(true)
    expect(threads.lifecycleStore.get(sub.id)).toBeDefined()
    expect(threads.getThread(sub.id)).toBeDefined()
  })

  describe('forgetCreatedTask on an owned task', () => {
    it.each([
      ['without naming the owner', undefined],
      ['naming a different owner', { ownedBy: 'someone-else' }]
    ])('refuses %s', (_name, options) => {
      const { threads } = fixture()
      const parent = threads.createThread('Parent')
      const sub = child(threads, parent.id)
      expect(() => threads.lifecycleStore.forgetCreatedTask(sub.id, options)).toThrow(/unused new task/)
      expect(threads.lifecycleStore.get(sub.id)).toBeDefined()
    })

    it('refuses a task that owns others', () => {
      const { threads } = fixture()
      const parent = threads.createThread('Parent')
      const sub = child(threads, parent.id)
      child(threads, sub.id)
      expect(() => threads.lifecycleStore.forgetCreatedTask(sub.id, { ownedBy: parent.id })).toThrow(/owns other tasks/)
    })

    it('still refuses an unowned task when an owner is named', () => {
      const { threads } = fixture()
      const plain = threads.createThread('Plain')
      expect(() => threads.lifecycleStore.forgetCreatedTask(plain.id, { ownedBy: 'x' })).toThrow(/unused new task/)
    })
  })

  describe('crash boundaries', () => {
    it('a subagent created but never committed to the run store is discarded at the next start', () => {
      const f = fixture()
      const parent = f.threads.createThread('Parent')
      const orphan = child(f.threads, parent.id, 'Orphan')
      const committed = child(f.threads, parent.id, 'Committed')
      // The daemon died here: only `committed` ever got its run-store lineage row.
      const restarted = open(f.home).threads
      expect(restarted.discardOrphanedSubagents((id) => id === committed.id)).toEqual([orphan.id])
      expect(restarted.getThread(orphan.id)).toBeUndefined()
      expect(restarted.lifecycleStore.get(orphan.id)).toBeUndefined()
      expect(restarted.getThread(committed.id)).toBeDefined()
      expect(restarted.discardOrphanedSubagents((id) => id === committed.id)).toEqual([])
    })

    it('a discard that died after dropping the registration leaves an unowned empty thread that the next start removes', () => {
      const f = fixture()
      const parent = f.threads.createThread('Parent')
      const sub = child(f.threads, parent.id)
      const dir = f.threads.getThreadDir(sub.id)
      f.threads.lifecycleStore.forgetCreatedTask(sub.id, { ownedBy: parent.id })
      expect(existsSync(dir)).toBe(true)
      const restarted = open(f.home).threads
      expect(restarted.discardOrphanedSubagents(() => false)).toEqual([sub.id])
      expect(existsSync(dir)).toBe(false)
      expect(restarted.getThread(sub.id)).toBeUndefined()
      expect(restarted.listAllThreads().map((thread) => thread.id)).toEqual([parent.id])
    })

    it('keeps an orphan that has messages and does not throw', () => {
      const f = fixture()
      const parent = f.threads.createThread('Parent')
      const sub = child(f.threads, parent.id)
      writeFileSync(join(f.threads.getThreadDir(sub.id), 'messages.json'), JSON.stringify([{ id: 'm', role: 'user', content: 'hi' }]))
      expect(open(f.home).threads.discardOrphanedSubagents(() => false)).toEqual([])
      expect(f.threads.getThread(sub.id)).toBeDefined()
    })

    it('ignores threads without lineage', () => {
      const f = fixture()
      f.threads.createThread('Plain')
      expect(open(f.home).threads.discardOrphanedSubagents(() => false)).toEqual([])
    })
  })
})

describe('lineage backfill for children created before thread metadata carried it', () => {
  it('copies the run store lineage into metadata, rooted at the top of the chain, and adopts no ownership', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const first = threads.createThread('First')
    const second = threads.createThread('Second')
    const repaired = backfillSubagentLineage(threads, [
      { threadId: first.id, parentThreadId: parent.id },
      { threadId: second.id, parentThreadId: first.id }
    ])
    expect(repaired.sort()).toEqual([first.id, second.id].sort())
    expect(threads.getThread(first.id)?.lineage).toEqual({ parentThreadId: parent.id, rootThreadId: parent.id, relationship: 'subagent' })
    expect(threads.getThread(second.id)?.lineage).toEqual({ parentThreadId: first.id, rootThreadId: parent.id, relationship: 'subagent' })
    // D7: old children stay unowned and keep their place in the list.
    expect(threads.lifecycleStore.require(first.id).parentTaskId).toBeUndefined()
    expect(threads.getThread(first.id)?.updatedAt).toBe(first.updatedAt)
  })

  it('is idempotent', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const old = threads.createThread('Old')
    const rows = [{ threadId: old.id, parentThreadId: parent.id }]
    expect(backfillSubagentLineage(threads, rows)).toEqual([old.id])
    expect(backfillSubagentLineage(threads, rows)).toEqual([])
    expect(threads.getThread(old.id)?.lineage?.parentThreadId).toBe(parent.id)
  })

  it('leaves a child that already has the same lineage alone', () => {
    const { threads } = fixture()
    const parent = threads.createThread('Parent')
    const sub = child(threads, parent.id)
    expect(backfillSubagentLineage(threads, [{ threadId: sub.id, parentThreadId: parent.id }])).toEqual([])
  })

  it('skips a trashed child and a missing one, and does not fail the rest', async () => {
    const { threads, coordinator } = fixture()
    const parent = threads.createThread('Parent')
    const trashed = threads.createThread('Trashed')
    const live = threads.createThread('Live')
    await coordinator.trash({ taskId: trashed.id, operationId: 'trash' })
    const repaired = backfillSubagentLineage(threads, [
      { threadId: trashed.id, parentThreadId: parent.id },
      { threadId: 'purged-long-ago', parentThreadId: parent.id },
      { threadId: live.id, parentThreadId: parent.id }
    ])
    expect(repaired).toEqual([live.id])
    await coordinator.restore({ taskId: trashed.id, operationId: 'restore' })
    expect(threads.getThread(trashed.id)?.lineage).toBeUndefined()
  })

  it('terminates on a cycle in the run store rows', () => {
    const { threads } = fixture()
    const a = threads.createThread('A')
    const b = threads.createThread('B')
    expect(() => backfillSubagentLineage(threads, [
      { threadId: a.id, parentThreadId: b.id },
      { threadId: b.id, parentThreadId: a.id }
    ])).not.toThrow()
  })
})
