import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * An exclusive lock on one agent's installs (`<installationHome>/agents/<agentId>/lock.db`),
 * shared by every profile and process of the installation. Publishing a version, writing a
 * profile's references and deleting files take it.
 *
 * The lock is SQLite's write lock: a `BEGIN IMMEDIATE` transaction on a small database file,
 * held for the whole call and rolled back afterwards (the same mutex the ChatGPT store uses). It
 * belongs to the OS: it ends when its process does and never expires while the process lives, so
 * there is no stale holder to detect and no takeover to race. The file is never deleted.
 */

export const LOCK_FILE = 'lock.db'

/** SQLite's "database is locked" (and its extended codes). */
function busy(error: unknown): boolean {
  const { errcode, code, message } = error as { errcode?: unknown; code?: unknown; message?: unknown }
  if (typeof errcode === 'number' && (errcode & 0xff) === 5) return true
  return code === 'SQLITE_BUSY' || (typeof message === 'string' && /database is locked|SQLITE_BUSY/i.test(message))
}

export class LockBusyError extends Error {}

export interface LockOptions {
  /** How long to wait for another holder (default 60 s). */
  timeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
}

/**
 * Runs `work` while holding the lock at `path`; waits for another holder, up to `timeoutMs`. The
 * wait polls without blocking: a holder may be another profile in this same process. Not
 * reentrant: `work` must not take the same lock again.
 */
export async function withLock<T>(path: string, work: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA busy_timeout=0')
    const deadline = Date.now() + (options.timeoutMs ?? 60_000)
    for (;;) {
      options.signal?.throwIfAborted()
      try {
        database.exec('BEGIN IMMEDIATE')
        break
      } catch (error) {
        if (!busy(error)) throw error
        if (Date.now() >= deadline) throw new LockBusyError('Another Mousse profile is changing this agent’s files. Try again in a moment.')
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100))
      }
    }
    try {
      return await work()
    } finally {
      try {
        database.exec('ROLLBACK')
      } catch {
        /* nothing to roll back */
      }
    }
  } finally {
    try {
      database.close()
    } catch {
      /* already closed */
    }
  }
}
