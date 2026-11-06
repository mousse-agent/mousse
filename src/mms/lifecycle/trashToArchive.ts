import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { TaskLifecycleRecord } from '../../shared/resourceLifecycle'

/** The one-time move of the old trash to Archived: the threads it brings back, then that it is done. */
export const TRASH_TO_ARCHIVE_MARKER = 'trash-returned-to-archive.json'

interface Marker { schemaVersion: 1; status: 'pending' | 'done'; taskIds: string[]; attempts?: number; gaveUp?: string[]; completedAt?: string }

/** Starts at which a recorded thread is tried; after that it is left in the trash and the move is done. */
export const TRASH_TO_ARCHIVE_ATTEMPTS = 3

export interface TrashToArchiveResult {
  /** Every thread that was in the trash is back: from now on a thread in the trash is a delete cut short. */
  done: boolean
  /** Already done on an earlier start. */
  skipped: boolean
  restored: string[]
  failed: Array<{ taskId: string; error: string }>
  /** Recorded threads still waiting for a later start; nothing else may act on them meanwhile. */
  waiting: string[]
  /** Recorded threads given up on: left in the trash as they are. */
  gaveUp: string[]
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
 * says done. A thread that still cannot be restored after `TRASH_TO_ARCHIVE_ATTEMPTS` starts, or whose record is
 * gone, stops blocking: the move is done and the thread is left in the trash as it is (a thread there with no
 * recorded delete is never purged).
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
    marker = value.status === 'pending' && Array.isArray(value.taskIds)
      ? { schemaVersion: 1, status: 'pending', taskIds: value.taskIds, attempts: Number.isSafeInteger(value.attempts) ? value.attempts : 0 }
      : { schemaVersion: 1, status: 'done', taskIds: [] }
  }
  if (marker?.status === 'done') return { done: true, skipped: true, restored: [], failed: [], waiting: [], gaveUp: [] }
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
  const attempts = (marker.attempts ?? 0) + 1
  // A recorded thread whose record is gone has nothing left to bring back.
  const missing = marker.taskIds.filter((taskId) => !deps.store.get(taskId))
  const gaveUp = failed.length && attempts >= TRASH_TO_ARCHIVE_ATTEMPTS ? [...missing, ...failed.map((entry) => entry.taskId)] : missing
  const done = !failed.length || attempts >= TRASH_TO_ARCHIVE_ATTEMPTS
  if (gaveUp.length) console.warn('threads from the old trash could not be brought back; they stay in the trash as they are', { taskIds: gaveUp })
  write(done
    ? { schemaVersion: 1, status: 'done', taskIds: marker.taskIds, attempts, ...(gaveUp.length ? { gaveUp } : {}), completedAt: new Date().toISOString() }
    : { ...marker, attempts })
  return { done, skipped: false, restored, failed, waiting: done ? [] : failed.map((entry) => entry.taskId), gaveUp }
}
