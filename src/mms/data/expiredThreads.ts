import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Thread } from '../../shared/types'

/**
 * Whether the thread whose folder is `location` has passed its own expiry (`Thread.expiresAt`), read from
 * its `meta.json`. For a thread that is not listed (in the trash, or half deleted), where `getThread`
 * cannot answer. An unreadable record has not expired: nothing is deleted on a guess.
 */
export function threadFolderExpired(location: string, now = Date.now()): boolean {
  try {
    const path = join(location, 'meta.json')
    if (!existsSync(path)) return false
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 1024 * 1024) return false
    const meta = JSON.parse(readFileSync(path, 'utf8')) as Partial<Thread>
    if (typeof meta.expiresAt !== 'string') return false
    const at = Date.parse(meta.expiresAt)
    return Number.isFinite(at) && at <= now
  } catch {
    return false
  }
}

/** The root thread of the subagent thread whose folder is `location` (`Thread.lineage`), read from its `meta.json`. */
export function threadFolderRoot(location: string): string | undefined {
  try {
    const path = join(location, 'meta.json')
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024) return undefined
    const meta = JSON.parse(readFileSync(path, 'utf8')) as Partial<Thread>
    const root = meta.lineage?.rootThreadId
    return typeof root === 'string' && root !== meta.id ? root : undefined
  } catch {
    return undefined
  }
}
