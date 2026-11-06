import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, type ResourceLifecycleStore } from './ResourceLifecycleStore'

/** Written once every thread that was in the trash is back; later starts leave the trash alone. */
export const TRASH_TO_ARCHIVE_MARKER = 'trash-returned-to-archive.json'

export interface TrashToArchiveResult {
  /** Already done on an earlier start. */
  skipped: boolean
  restored: string[]
  failed: Array<{ taskId: string; error: string }>
}

/**
 * Threads no longer wait in a trash: a thread is archived, then deleted for good. The threads that were in the
 * trash when that changed come back, archived, so nothing is lost without the person choosing to delete it.
 *
 * Restores each trashed thread at the top of what was trashed (its subagent threads come back with it) and
 * archives the threads people started. Runs once: the marker is written only when every restore worked, so a
 * failed one is tried again at the next start, and a thread trashed afterwards is not brought back.
 */
export async function returnTrashedThreadsToArchive(deps: {
  store: ResourceLifecycleStore
  restore(taskId: string): Promise<unknown>
  archive(taskId: string): void
}): Promise<TrashToArchiveResult> {
  const marker = join(deps.store.root, TRASH_TO_ARCHIVE_MARKER)
  assertLifecyclePath(deps.store.root, marker)
  if (existsSync(marker)) return { skipped: true, restored: [], failed: [] }
  const records = deps.store.list()
  const byId = new Map(records.map((record) => [record.taskId, record]))
  const tops = records
    .filter((record) => record.state === 'trashed' && byId.get(record.parentTaskId ?? '')?.state !== 'trashed')
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
  const restored: string[] = [], failed: TrashToArchiveResult['failed'] = []
  for (const record of tops) {
    try {
      await deps.restore(record.taskId)
      restored.push(record.taskId)
    } catch (error) {
      failed.push({ taskId: record.taskId, error: error instanceof Error ? error.message : String(error) })
      continue
    }
    // A subagent thread comes back as it was, under its parent; a thread a person started goes to Archived.
    if (!record.parentTaskId) {
      try { deps.archive(record.taskId) } catch (error) {
        failed.push({ taskId: record.taskId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  if (!failed.length) {
    mkdirSync(deps.store.root, { recursive: true })
    atomicWriteJsonSync(marker, { schemaVersion: 1, completedAt: new Date().toISOString(), restored })
  }
  return { skipped: false, restored, failed }
}
