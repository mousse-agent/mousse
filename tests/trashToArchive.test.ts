import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { returnTrashedThreadsToArchive, TRASH_TO_ARCHIVE_MARKER } from '../src/mms/lifecycle/trashToArchive'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A profile whose lifecycle store holds `tasks`, each with its own folder and state. */
function profile(tasks: Array<{ id: string; parent?: string; state: 'active' | 'trashed' }>) {
  const home = mkdtempSync(join(tmpdir(), 'trash-to-archive-'))
  roots.push(home)
  const store = new ResourceLifecycleStore({ profileId: 'p', profileHome: home })
  for (const task of tasks) {
    const location = join(home, 'thread-data', 'standalone', task.id)
    mkdirSync(location, { recursive: true })
    writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: task.id }))
    store.registerTask({ taskId: task.id, location, ...(task.parent ? { parentTaskId: task.parent } : {}) })
  }
  // Children first, so an owner's registration check still sees an active owner.
  for (const task of [...tasks].reverse()) if (task.state === 'trashed') store.update(task.id, (record) => { record.state = 'trashed' })
  const restored: string[] = [], archived: string[] = []
  const deps = {
    store,
    restore: async (taskId: string) => { restored.push(taskId); store.update(taskId, (record) => { record.state = 'active' }) },
    archive: (taskId: string) => { archived.push(taskId) }
  }
  return { store, deps, restored, archived, marker: join(store.root, TRASH_TO_ARCHIVE_MARKER) }
}

describe('threads in the old trash go back to Archived', () => {
  it('restores every trashed thread, owners before the threads they own, and asks to archive each', async () => {
    const p = profile([
      { id: 'kept', state: 'active' },
      { id: 'owner', state: 'trashed' },
      // Trashed on its own before its owner was: it is a trashed record of its own and comes back after the owner.
      { id: 'owned', parent: 'owner', state: 'trashed' }
    ])
    const result = await returnTrashedThreadsToArchive(p.deps)
    expect(result).toEqual({ done: true, skipped: false, restored: ['owner', 'owned'], failed: [] })
    expect(p.restored).toEqual(['owner', 'owned'])
    // Which of them a person started is the caller's decision.
    expect(p.archived).toEqual(['owner', 'owned'])
    expect(JSON.parse(readFileSync(p.marker, 'utf8'))).toMatchObject({ status: 'done', taskIds: ['owner', 'owned'] })
  })

  it('runs once: a thread trashed after the move stays where it is', async () => {
    const p = profile([{ id: 'first', state: 'trashed' }, { id: 'later', state: 'active' }])
    await returnTrashedThreadsToArchive(p.deps)
    p.store.update('later', (record) => { record.state = 'trashed' })
    expect(await returnTrashedThreadsToArchive(p.deps)).toEqual({ done: true, skipped: true, restored: [], failed: [] })
    expect(p.restored).toEqual(['first'])
    expect(p.store.require('later').state).toBe('trashed')
  })

  it('retries a failed restore at the next start for the threads it recorded, and never one trashed since', async () => {
    const p = profile([{ id: 'stuck', state: 'trashed' }, { id: 'fine', state: 'trashed' }, { id: 'later', state: 'active' }])
    let fail = true
    const restore = p.deps.restore
    p.deps.restore = async (taskId: string) => { if (taskId === 'stuck' && fail) throw new Error('busy'); await restore(taskId) }
    const first = await returnTrashedThreadsToArchive(p.deps)
    expect(first).toEqual({ done: false, skipped: false, restored: ['fine'], failed: [{ taskId: 'stuck', error: 'busy' }] })
    expect(JSON.parse(readFileSync(p.marker, 'utf8'))).toMatchObject({ status: 'pending', taskIds: ['fine', 'stuck'] })
    // A delete in progress between the two starts: not part of the move.
    p.store.update('later', (record) => { record.state = 'trashed' })
    fail = false
    const second = await returnTrashedThreadsToArchive(p.deps)
    expect(second).toEqual({ done: true, skipped: false, restored: ['stuck'], failed: [] })
    expect(p.store.require('later').state).toBe('trashed')
    expect(existsSync(p.marker)).toBe(true)
  })
})
