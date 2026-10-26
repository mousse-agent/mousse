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
 * live holder is bounded by its own operation deadlines.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
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
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
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

/** Removes a lock whose owner is dead, or an unreadable one past the corrupt-stale age. */
function tryReclaim(lockPath: string): boolean {
  const owner = readFileLockOwner(lockPath)
  try {
    if (!owner) {
      if (!mayReclaimUnreadableLock(lockPath)) return false
      unlinkSync(lockPath)
      return true
    }
    if (isOwnerLive(owner)) return false
    const still = readFileLockOwner(lockPath)
    if (!still || still.token !== owner.token || isOwnerLive(still)) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
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

async function acquireFile(lockPath: string, deadline: number, signal: AbortSignal): Promise<FileLockOwner> {
  for (;;) {
    signal.throwIfAborted()
    const owner = tryCreate(lockPath)
    if (owner) return owner
    if (tryReclaim(lockPath)) continue
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
    const owner = await acquireFile(lockPath, deadline, signal)
    try {
      return await fn(signal)
    } finally {
      release(lockPath, owner.token)
    }
  } finally {
    releaseLocal(key)
  }
}
