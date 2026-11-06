import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  for (const task of tasks) if (task.state === 'trashed') store.update(task.id, (record) => { record.state = 'trashed' })
  const restored: string[] = [], archived: string[] = []
  const deps = {
    store,
    restore: async (taskId: string) => { restored.push(taskId); store.update(taskId, (record) => { record.state = 'active' }) },
    archive: (taskId: string) => { archived.push(taskId) }
  }
  return { store, deps, restored, archived, marker: join(store.root, TRASH_TO_ARCHIVE_MARKER) }
}

describe('threads in the trash go back to Archived', () => {
  it('restores each trashed thread at the top of what was trashed and archives the ones a person started', async () => {
    const p = profile([
      { id: 'kept', state: 'active' },
      { id: 'deleted', state: 'trashed' },
      // Trashed with its owner: it comes back with it, not on its own.
      { id: 'owned', parent: 'deleted', state: 'trashed' },
      { id: 'owner', state: 'active' },
      // Trashed on its own under a thread in use: it comes back under it, as it was.
      { id: 'alone', parent: 'owner', state: 'trashed' }
    ])
    const result = await returnTrashedThreadsToArchive(p.deps)
    expect(result).toEqual({ skipped: false, restored: ['alone', 'deleted'], failed: [] })
    expect(p.restored).toEqual(['alone', 'deleted'])
    expect(p.archived).toEqual(['deleted'])
    expect(existsSync(p.marker)).toBe(true)
  })

  it('runs once: a thread trashed after the move stays where it is', async () => {
    const p = profile([{ id: 'first', state: 'trashed' }, { id: 'later', state: 'active' }])
    await returnTrashedThreadsToArchive(p.deps)
    p.store.update('later', (record) => { record.state = 'trashed' })
    const again = await returnTrashedThreadsToArchive(p.deps)
    expect(again).toEqual({ skipped: true, restored: [], failed: [] })
    expect(p.restored).toEqual(['first'])
    expect(p.store.require('later').state).toBe('trashed')
  })

  it('tries again at the next start when a restore fails, and writes nothing until every thread is back', async () => {
    const p = profile([{ id: 'stuck', state: 'trashed' }, { id: 'fine', state: 'trashed' }])
    let fail = true
    const restore = p.deps.restore
    p.deps.restore = async (taskId: string) => { if (taskId === 'stuck' && fail) throw new Error('busy'); await restore(taskId) }
    const first = await returnTrashedThreadsToArchive(p.deps)
    expect(first.failed).toEqual([{ taskId: 'stuck', error: 'busy' }])
    expect(first.restored).toEqual(['fine'])
    expect(existsSync(p.marker)).toBe(false)
    fail = false
    const second = await returnTrashedThreadsToArchive(p.deps)
    expect(second).toEqual({ skipped: false, restored: ['stuck'], failed: [] })
    expect(p.archived).toEqual(['fine', 'stuck'])
    expect(existsSync(p.marker)).toBe(true)
  })
})
