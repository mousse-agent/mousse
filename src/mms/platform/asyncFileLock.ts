/**
 * A cross-process file lock that may be held across `await`.
 *
 * `withFileLock` (scheduled/fileLock.ts) is synchronous: it cannot cover a network round trip. This
 * lock uses the same owner record and the same stale rules, and adds waiting:
 * - callers in this process queue in FIFO order per lock path and never poll the file;
 * - callers in other processes poll every 100–250 ms (with jitter) until `waitMs`, then fail with
 *   `FileLockBusyError`.
 *
 * There is no heartbeat. An owner is live while its pid runs with the same process instance, and a
 * live holder is bounded by its own operation deadlines. With `maxHoldMs`, an owner older than that
 * is stale even when its pid runs, which covers a crashed holder whose pid was reused.
 *
 * Reclaiming a stale lock is exclusive. The file system has no compare-and-delete, so a plain
 * "check the owner, then unlink" lets two reclaimers that both saw the same dead owner delete each
 * other's fresh locks. Instead, a reclaimer must first create `<lock>.reclaim-<id>` with O_EXCL,
 * where `<id>` names the exact stale file (its owner token, or the identity of an unreadable file).
 * Only that marker's creator may unlink the file it names, and it checks the file is still the same
 * one before it does. A token is never reused, so a reclaimer that arrives late finds another file
 * and leaves it alone. Markers are held for a synchronous moment; a marker left by a crashed
 * reclaimer is itself reclaimed the same way (older than 30 s), up to three levels deep.
 * An OS mutex would be simpler, but Node has no portable one: named pipes free themselves only on
 * Windows, and a stale Unix socket file needs the same unsafe unlink.
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import {
  FileLockBusyError,
  mayReclaimUnreadableLock,
  readFileLockOwner,
  type FileLockOwner
} from '../scheduled/fileLock'

export { FileLockBusyError }

export interface AsyncFileLockOptions {
  /** How long to wait for the lock, in this process and across processes together. */
  waitMs: number
  /** Aborts the wait. Once the lock is held, `fn` receives it and decides what abort means. */
  signal?: AbortSignal
  /**
   * An owner that took the lock longer ago than this is stale even if its pid is alive (pid reuse
   * after a crash). Set it well above the longest operation run under the lock; unset, only a dead
   * owner is stale.
   */
  maxHoldMs?: number
}

const POLL_MIN_MS = 100
const POLL_JITTER_MS = 150

interface Waiter {
  wake: () => void
}

interface LocalQueue {
  waiters: Waiter[]
}

/** Lock paths held by this process; each holds the callers waiting behind the holder, in order. */
const local = new Map<string, LocalQueue>()

const NEVER = new AbortController().signal

function busy(lockPath: string): FileLockBusyError {
  return new FileLockBusyError(lockPath, readFileLockOwner(lockPath))
}

/** Waits for this process's turn on `key`. Resolves holding the in-process slot. */
function acquireLocal(key: string, lockPath: string, deadline: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const queue = local.get(key)
  if (!queue) {
    local.set(key, { waiters: [] })
    return Promise.resolve()
  }
  return new Promise<void>((resolveTurn, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const leave = () => {
      const index = queue.waiters.indexOf(waiter)
      if (index >= 0) queue.waiters.splice(index, 1)
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      leave()
      reject(signal.reason)
    }
    const waiter: Waiter = {
      wake: () => {
        if (timer) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolveTurn()
      }
    }
    queue.waiters.push(waiter)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      leave()
      reject(busy(lockPath))
    }, Math.max(0, deadline - Date.now()))
  })
}

/** Hands the in-process slot to the next waiter, or frees it. */
function releaseLocal(key: string): void {
  const queue = local.get(key)
  const next = queue?.waiters.shift()
  if (next) next.wake()
  else local.delete(key)
}

/**
 * Error codes of an exclusive create that mean "someone has this name": `EEXIST`, and on Windows a
 * file that was deleted while another process still had it open (delete-pending) or is in use.
 */
const BUSY_CREATE = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])

function tryCreate(lockPath: string): FileLockOwner | null {
  mkdirSync(dirname(lockPath), { recursive: true })
  const owner: FileLockOwner = {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token: randomBytes(16).toString('hex'),
    acquiredAt: new Date().toISOString()
  }
  let fd: number
  try {
    fd = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (BUSY_CREATE.has((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(owner))
  } catch (error) {
    try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(lockPath) } catch { /* ignore */ }
    throw error
  }
  closeSync(fd)
  return owner
}

/** Markers are held only while a reclaimer runs synchronous code; an older one was left by a crash. */
const MARKER_STALE_MS = 30_000
const RECLAIM_DEPTH = 3

/** The identity of the file at `path`: its owner token, or for an unreadable file its inode and write time. */
interface Snapshot {
  key: string
  owner: FileLockOwner | null
}

function snapshot(path: string): Snapshot | null {
  let stat
  try {
    stat = statSync(path, { bigint: true })
  } catch {
    return null
  }
  const owner = readFileLockOwner(path)
  return { key: owner ? `token:${owner.token}` : `file:${stat.ino}:${stat.mtimeNs}:${stat.size}`, owner }
}

function isStale(path: string, snap: Snapshot, maxHoldMs: number | undefined): boolean {
  if (!snap.owner) return mayReclaimUnreadableLock(path)
  if (maxHoldMs !== undefined) {
    const acquired = Date.parse(snap.owner.acquiredAt)
    if (Number.isFinite(acquired) && Date.now() - acquired > maxHoldMs) return true
  }
  return !isOwnerLive(snap.owner)
}

/** Tests only: runs at each step of a reclaim, so a test can interleave two reclaimers. */
let reclaimHook: ((step: 'checked' | 'marked', path: string) => void) | null = null
export function setReclaimHookForTests(hook: typeof reclaimHook): void {
  reclaimHook = hook
}

/**
 * Removes the file at `path` if it is stale, exclusively (see the header). True only when this call
 * removed it; a file that vanished on its own is retried after the normal poll pause, so a Windows
 * delete-pending name never turns the wait into a busy loop.
 */
function reclaim(path: string, maxHoldMs: number | undefined, depth = 0): boolean {
  const snap = snapshot(path)
  if (!snap) return false
  if (!isStale(path, snap, maxHoldMs)) return false
  reclaimHook?.('checked', path)
  const marker = `${path}.reclaim-${createHash('sha256').update(snap.key).digest('hex').slice(0, 16)}`
  let held = tryCreate(marker)
  if (!held) {
    if (depth + 1 >= RECLAIM_DEPTH || !reclaim(marker, MARKER_STALE_MS, depth + 1)) return false
    held = tryCreate(marker)
    if (!held) return false
  }
  try {
    reclaimHook?.('marked', path)
    const again = snapshot(path)
    if (!again || again.key !== snap.key) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  } finally {
    release(marker, held.token)
  }
}

/** Tests only: one acquisition attempt (reclaim, then create). Returns the owner token or null. */
export function tryAcquireOnceForTests(lockPath: string, maxHoldMs?: number): string | null {
  const created = tryCreate(lockPath) ?? (reclaim(lockPath, maxHoldMs) ? tryCreate(lockPath) : null)
  return created?.token ?? null
}

/** Deletes the lock file only while it still carries our token. */
function release(lockPath: string, token: string): void {
  try {
    if (readFileLockOwner(lockPath)?.token === token) unlinkSync(lockPath)
  } catch {
    /* a missing file is already released */
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePause, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePause()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function acquireFile(lockPath: string, deadline: number, signal: AbortSignal, maxHoldMs: number | undefined): Promise<FileLockOwner> {
  for (;;) {
    signal.throwIfAborted()
    const owner = tryCreate(lockPath)
    if (owner) return owner
    if (reclaim(lockPath, maxHoldMs)) continue
    const left = deadline - Date.now()
    if (left <= 0) throw busy(lockPath)
    await pause(Math.min(left, POLL_MIN_MS + Math.floor(Math.random() * POLL_JITTER_MS)), signal)
  }
}

/**
 * Runs `fn` while holding `lockPath` exclusively across processes. `fn` receives the caller's
 * signal. The lock is released when `fn` settles, whether it resolves or throws.
 */
export async function withAsyncFileLock<T>(
  lockPath: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: AsyncFileLockOptions
): Promise<T> {
  const signal = options.signal ?? NEVER
  const deadline = Date.now() + Math.max(0, options.waitMs)
  const key = resolve(lockPath)
  await acquireLocal(key, lockPath, deadline, signal)
  try {
    const owner = await acquireFile(lockPath, deadline, signal, options.maxHoldMs)
    try {
      return await fn(signal)
    } finally {
      release(lockPath, owner.token)
    }
  } finally {
    releaseLocal(key)
  }
}
