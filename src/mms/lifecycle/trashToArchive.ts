import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'

/** The one-time move of the old trash to Archived: the threads it brings back, then that it is done. */
export const TRASH_TO_ARCHIVE_MARKER = 'trash-returned-to-archive.json'

interface Marker { schemaVersion: 1; status: 'pending' | 'done'; taskIds: string[]; completedAt?: string }

export interface TrashToArchiveResult {
  /** Every thread that was in the trash is back: from now on a thread in the trash is a delete cut short. */
  done: boolean
  /** Already done on an earlier start. */
  skipped: boolean
  restored: string[]
  failed: Array<{ taskId: string; error: string }>
}

/** Owners before the threads they own, so each restore finds its owner back. */
function ownersFirst(records: readonly TaskLifecycleRecord[]): TaskLifecycleRecord[] {
  const byId = new Map(records.map((record) => [record.taskId, record]))
  const depth = (record: TaskLifecycleRecord): number => {
    let count = 0
    const seen = new Set<string>()
    for (let owner = record.parentTaskId; owner && byId.has(owner) && !seen.has(owner); owner = byId.get(owner)!.parentTaskId) { seen.add(owner); count++ }
    return count
  }
  return [...records].sort((a, b) => depth(a) - depth(b) || a.taskId.localeCompare(b.taskId))
}

/**
 * Threads no longer wait in a trash: a thread is archived, then deleted for good. The threads that were in the
 * trash when that changed come back, archived, so nothing is lost without the person choosing to delete it.
 *
 * The first start records which threads were in the trash and restores those, owners first (a thread trashed on
 * its own before its owner is restored after it). A failed restore is tried again at the next start, for the same
 * threads only: one trashed later is a delete in progress and is not brought back. When all are back the marker
 * says done.
 */
export async function returnTrashedThreadsToArchive(deps: {
  store: ResourceLifecycleStore
  restore(taskId: string): Promise<unknown>
  /** Archives a thread a person started; decides itself which those are. */
  archive(taskId: string): void
}): Promise<TrashToArchiveResult> {
  const path = join(deps.store.root, TRASH_TO_ARCHIVE_MARKER)
  assertLifecyclePath(deps.store.root, path)
  let marker: Marker | undefined
  if (existsSync(path)) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Marker> & { restored?: string[] }
    // A marker written before the set was recorded only ever meant done.
    marker = value.status === 'pending' && Array.isArray(value.taskIds) ? { schemaVersion: 1, status: 'pending', taskIds: value.taskIds } : { schemaVersion: 1, status: 'done', taskIds: [] }
  }
  if (marker?.status === 'done') return { done: true, skipped: true, restored: [], failed: [] }
  const write = (next: Marker): void => { mkdirSync(deps.store.root, { recursive: true }); atomicWriteJsonSync(path, next) }
  if (!marker) {
    marker = { schemaVersion: 1, status: 'pending', taskIds: ownersFirst(deps.store.list().filter((record) => record.state === 'trashed')).map((record) => record.taskId) }
    write(marker)
  }
  const wanted = new Set(marker.taskIds)
  const restored: string[] = [], failed: TrashToArchiveResult['failed'] = []
  for (const record of ownersFirst(deps.store.list().filter((entry) => wanted.has(entry.taskId)))) {
    if (deps.store.get(record.taskId)?.state !== 'trashed') continue
    try {
      await deps.restore(record.taskId)
      restored.push(record.taskId)
    } catch (error) {
      failed.push({ taskId: record.taskId, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    try { deps.archive(record.taskId) } catch (error) {
      // It is listed again either way; archiving is not tried a second time.
      console.warn('a thread back from the trash could not be archived', { taskId: record.taskId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const done = !failed.length
  if (done) write({ schemaVersion: 1, status: 'done', taskIds: marker.taskIds, completedAt: new Date().toISOString() })
  return { done, skipped: false, restored, failed }
}
