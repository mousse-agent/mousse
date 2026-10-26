import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * An exclusive lock on one agent's installs (`<installationHome>/agents/<agentId>/.lock`), shared
 * by every profile and process of the installation. Publishing a version, writing a profile's
 * references and deleting files take it. The file names its holder (pid and start time); a lock
 * whose process is gone is stale and taken over.
 */

export const LOCK_FILE = '.lock'

interface Holder {
  pid: number
  startedAt: number
  token: string
}

/** This process's start time, so a reused pid reads as another holder in logs. */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(path: string): Holder | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Holder>
    return typeof value.pid === 'number' && typeof value.token === 'string' ? (value as Holder) : undefined
  } catch {
    return undefined
  }
}

/** A lock file that no live process holds. An unreadable one counts as stale after `graceMs` (a holder mid-write). */
function stale(path: string, graceMs: number): boolean {
  const holder = readHolder(path)
  if (holder) return !alive(holder.pid)
  try {
    return Date.now() - statSync(path).mtimeMs > graceMs
  } catch {
    return true
  }
}

/**
 * Removes a stale lock file, only while it is still the one found stale: another waiter may have
 * taken the lock over in between, and its fresh file must stay.
 */
export function removeStale(path: string, seen: string | undefined): boolean {
  if (readHolder(path)?.token !== seen) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function tryAcquire(path: string, graceMs: number): string | undefined {
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: PROCESS_STARTED_AT, token } satisfies Holder))
      } finally {
        closeSync(fd)
      }
      // Held only while the file still names this holder (a racing takeover may have replaced it).
      return readHolder(path)?.token === token ? token : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt > 0 || !stale(path, graceMs)) return undefined
      if (!removeStale(path, readHolder(path)?.token)) return undefined
    }
  }
  return undefined
}

function release(path: string, token: string): void {
  if (readHolder(path)?.token !== token) return
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}

export class LockBusyError extends Error {}

export interface LockOptions {
  /** How long to wait for another holder (default 60 s). */
  timeoutMs?: number
  pollMs?: number
  signal?: AbortSignal
}

/** Runs `work` while holding the lock at `path`; waits for another holder, up to `timeoutMs`. */
export async function withLock<T>(path: string, work: () => Promise<T> | T, options: LockOptions = {}): Promise<T> {
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  let token = tryAcquire(path, 5_000)
  while (!token) {
    options.signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new LockBusyError('Another Mousse profile is changing this agent’s files. Try again in a moment.')
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100))
    token = tryAcquire(path, 5_000)
  }
  try {
    if (readHolder(path)?.token !== token) throw new LockBusyError('Another Mousse profile took over this agent’s files. Try again in a moment.')
    return await work()
  } finally {
    release(path, token)
  }
}
