import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Thread } from '../../shared/types'
import { isLocalOnlyThread } from '../../shared/threadLineage'

/**
 * Whether the thread whose folder is `location` is private (`Thread.localOnly`), read from its own
 * `meta.json`. For a thread that is not listed (in the trash), where `getThread` cannot answer. An
 * unreadable record counts as private: a caller from another device is refused rather than shown it.
 */
export function threadFolderIsLocalOnly(location: string): boolean {
  try {
    const path = join(location, 'meta.json')
    if (!existsSync(path)) return false
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 1024 * 1024) return true
    const meta = JSON.parse(readFileSync(path, 'utf8')) as Partial<Thread>
    return isLocalOnlyThread({ localOnly: meta.localOnly, lineage: meta.lineage })
  } catch {
    return true
  }
}

/** The ids among `threads` that are private, with their lineage resolved against `threads` itself. */
export function localOnlyThreadIds(threads: readonly Thread[]): Set<string> {
  return new Set(threads.filter((thread) => isLocalOnlyThread(thread, threads)).map((thread) => thread.id))
}
