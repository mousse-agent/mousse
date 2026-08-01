/**
 * Pure-Node, cross-process per-thread execution lease.
 *
 * Lock files live inside the thread runtime directory (not MOUSSE_HOME root).
 * Acquisition is atomic (O_EXCL / wx). Release is ownership-checked by token.
 * Stale owners (dead pid) may be reclaimed; live owners are never force-deleted.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { isProcessAlive } from './processLiveness'

export const EXECUTION_LEASE_FILENAME = 'execution.lease'
export const QUEUE_MUTATION_LOCK_FILENAME = 'queue.mut.lock'

export interface ThreadLeaseOwner {
  pid: number
  token: string
  acquiredAt: string
  heartbeatAt: string
  source?: string
}

export interface ThreadLeaseHandle {
  threadDir: string
  lockPath: string
  owner: ThreadLeaseOwner
}

export interface AcquireLeaseOptions {
  /** Caller identity label (gui, cli, channel, test). */
  source?: string
  /** Override owner pid (tests). */
  pid?: number
  /** Override owner token (tests). */
  token?: string
  /** Max attempts when contending / reclaiming. */
  maxAttempts?: number
  /** Sleep between attempts (ms). */
  retryDelayMs?: number
  /** Optional abort for wait/retry loops (channels). */
  signal?: AbortSignal
  /** When true, only try once (no wait). */
  tryOnce?: boolean
}

export class LeaseBusyError extends Error {
  readonly owner: ThreadLeaseOwner | null
  constructor(message: string, owner: ThreadLeaseOwner | null = null) {
    super(message)
    this.name = 'LeaseBusyError'
    this.owner = owner
  }
}

export function getExecutionLeasePath(threadDir: string): string {
  return join(threadDir, EXECUTION_LEASE_FILENAME)
}

export function getQueueMutationLockPath(threadDir: string): string {
  return join(threadDir, QUEUE_MUTATION_LOCK_FILENAME)
}

export function createLeaseToken(): string {
  return randomBytes(16).toString('hex')
}

function sleepMs(ms: number): void {
  if (ms <= 0) return
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin — pure sync helper, no timers required for short waits */
  }
}

function sleepMsAsync(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function readLeaseOwner(lockPath: string): ThreadLeaseOwner | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = readFileSync(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ThreadLeaseOwner>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string' ||
      !parsed.token ||
      typeof parsed.acquiredAt !== 'string' ||
      typeof parsed.heartbeatAt !== 'string'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      token: parsed.token,
      acquiredAt: parsed.acquiredAt,
      heartbeatAt: parsed.heartbeatAt,
      source: typeof parsed.source === 'string' ? parsed.source : undefined
    }
  } catch {
    return null
  }
}

/**
 * True when another *live* process owns the lease (not us).
 * Dead owners and missing/corrupt locks are treated as free.
 */
export function isLeaseHeldByLivePeer(
  threadDir: string,
  selfToken?: string
): { held: boolean; owner: ThreadLeaseOwner | null } {
  const owner = readLeaseOwner(getExecutionLeasePath(threadDir))
  if (!owner) return { held: false, owner: null }
  if (selfToken && owner.token === selfToken) return { held: false, owner }
  if (owner.pid === process.pid && (!selfToken || owner.token === selfToken)) {
    return { held: false, owner }
  }
  if (!isProcessAlive(owner.pid)) return { held: false, owner }
  // Same pid, different token: prior instance died and OS reused pid, or corrupt — treat as free.
  if (owner.pid === process.pid) return { held: false, owner }
  return { held: true, owner }
}

/**
 * Attempt to remove a lease only when the recorded owner is dead or matches `token`.
 * Never unlinks a live foreign owner.
 */
export function tryReclaimStaleLease(threadDir: string, expectedToken?: string): boolean {
  const lockPath = getExecutionLeasePath(threadDir)
  const owner = readLeaseOwner(lockPath)
  if (!owner) {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
  if (expectedToken && owner.token === expectedToken) {
    return releaseExecutionLease(threadDir, expectedToken)
  }
  if (isProcessAlive(owner.pid) && owner.pid !== process.pid) {
    return false
  }
  // Dead owner (or our pid after crash): compare-and-unlink.
  try {
    const still = readLeaseOwner(lockPath)
    if (!still || still.token !== owner.token) return false
    if (isProcessAlive(still.pid) && still.pid !== process.pid) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

function writeOwnerAtomic(lockPath: string, owner: ThreadLeaseOwner): void {
  const tmp = `${lockPath}.${owner.token}.tmp`
  writeFileSync(tmp, JSON.stringify(owner, null, 2), 'utf-8')
  renameSync(tmp, lockPath)
}

/**
 * Atomically acquire the per-thread execution lease.
 * Returns a handle for heartbeat + ownership-checked release.
 */
export function tryAcquireExecutionLease(
  threadDir: string,
  opts?: AcquireLeaseOptions
): ThreadLeaseHandle | null {
  mkdirSync(threadDir, { recursive: true })
  const lockPath = getExecutionLeasePath(threadDir)
  const now = new Date().toISOString()
  const owner: ThreadLeaseOwner = {
    pid: opts?.pid ?? process.pid,
    token: opts?.token ?? createLeaseToken(),
    acquiredAt: now,
    heartbeatAt: now,
    source: opts?.source
  }

  try {
    const fd = openSync(lockPath, 'wx')
    try {
      writeSync(fd, JSON.stringify(owner, null, 2))
    } finally {
      closeSync(fd)
    }
    return { threadDir, lockPath, owner }
  } catch {
    // Exists — try stale reclaim once for tryAcquire.
    if (tryReclaimStaleLease(threadDir)) {
      try {
        const fd = openSync(lockPath, 'wx')
        try {
          writeSync(fd, JSON.stringify(owner, null, 2))
        } finally {
          closeSync(fd)
        }
        return { threadDir, lockPath, owner }
      } catch {
        return null
      }
    }
    return null
  }
}

/** Blocking acquire with retries (sync). Prefer async waitAcquire for AbortSignal. */
export function acquireExecutionLease(
  threadDir: string,
  opts?: AcquireLeaseOptions
): ThreadLeaseHandle {
  const maxAttempts = opts?.tryOnce ? 1 : (opts?.maxAttempts ?? 40)
  const delay = opts?.retryDelayMs ?? 25
  let lastOwner: ThreadLeaseOwner | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.signal?.aborted) {
      throw new LeaseBusyError('Lease acquire aborted', lastOwner)
    }
    const handle = tryAcquireExecutionLease(threadDir, opts)
    if (handle) return handle
    lastOwner = readLeaseOwner(getExecutionLeasePath(threadDir))
    if (opts?.tryOnce) break
    sleepMs(delay)
  }
  throw new LeaseBusyError(
    `Thread execution lease busy${lastOwner ? ` (pid ${lastOwner.pid})` : ''}`,
    lastOwner
  )
}

/** Async wait/retry acquire (for channel turns with AbortSignal). */
export async function waitAcquireExecutionLease(
  threadDir: string,
  opts?: AcquireLeaseOptions
): Promise<ThreadLeaseHandle> {
  const maxAttempts = opts?.tryOnce ? 1 : (opts?.maxAttempts ?? 200)
  const delay = opts?.retryDelayMs ?? 50
  let lastOwner: ThreadLeaseOwner | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.signal?.aborted) {
      throw new LeaseBusyError('Lease acquire aborted', lastOwner)
    }
    const handle = tryAcquireExecutionLease(threadDir, opts)
    if (handle) return handle
    lastOwner = readLeaseOwner(getExecutionLeasePath(threadDir))
    if (opts?.tryOnce) break
    await sleepMsAsync(delay, opts?.signal)
  }
  throw new LeaseBusyError(
    `Thread execution lease busy${lastOwner ? ` (pid ${lastOwner.pid})` : ''}`,
    lastOwner
  )
}

/** Refresh heartbeat while holding the lease (ownership-checked). */
export function heartbeatExecutionLease(handle: ThreadLeaseHandle): boolean {
  const current = readLeaseOwner(handle.lockPath)
  if (!current || current.token !== handle.owner.token) return false
  const next: ThreadLeaseOwner = {
    ...current,
    heartbeatAt: new Date().toISOString()
  }
  try {
    writeOwnerAtomic(handle.lockPath, next)
    handle.owner = next
    return true
  } catch {
    return false
  }
}

/**
 * Ownership-checked release. Returns false if another owner holds the lock
 * (never deletes a foreign live lease).
 */
export function releaseExecutionLease(threadDir: string, token: string): boolean {
  const lockPath = getExecutionLeasePath(threadDir)
  const owner = readLeaseOwner(lockPath)
  if (!owner) return true
  if (owner.token !== token) return false
  try {
    const still = readLeaseOwner(lockPath)
    if (!still || still.token !== token) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

export function releaseExecutionLeaseHandle(handle: ThreadLeaseHandle): boolean {
  return releaseExecutionLease(handle.threadDir, handle.owner.token)
}

// ── Queue mutation lock (short RMW critical sections) ──────────────────────

const queueLockDepth = new Map<string, number>()

export interface QueueLockOwner {
  pid: number
  token: string
  acquiredAt: string
}

function readQueueLockOwner(lockPath: string): QueueLockOwner | null {
  try {
    if (!existsSync(lockPath)) return null
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<QueueLockOwner>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      token: parsed.token,
      acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : new Date().toISOString()
    }
  } catch {
    return null
  }
}

function tryReclaimQueueLock(lockPath: string): boolean {
  const owner = readQueueLockOwner(lockPath)
  if (!owner) {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
  if (isProcessAlive(owner.pid) && owner.pid !== process.pid) return false
  try {
    const still = readQueueLockOwner(lockPath)
    if (!still || still.token !== owner.token) return false
    if (isProcessAlive(still.pid) && still.pid !== process.pid) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

/**
 * Short exclusive lock around durable queue read-modify-write.
 * Re-entrant within the same process for the same path.
 */
export function withQueueMutationLock<T>(threadDir: string, fn: () => T): T {
  mkdirSync(threadDir, { recursive: true })
  const lockPath = getQueueMutationLockPath(threadDir)
  const depth = queueLockDepth.get(lockPath) ?? 0
  if (depth > 0) {
    queueLockDepth.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      queueLockDepth.set(lockPath, depth)
    }
  }

  const token = createLeaseToken()
  const maxAttempts = 80
  let fd: number | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fd = openSync(lockPath, 'wx')
      writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString()
        } satisfies QueueLockOwner)
      )
      break
    } catch {
      tryReclaimQueueLock(lockPath)
      if (attempt === maxAttempts - 1) {
        // Last resort: proceed without lock rather than deadlock (best-effort).
        return fn()
      }
      sleepMs(10)
    }
  }

  queueLockDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    queueLockDepth.delete(lockPath)
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
      try {
        const still = readQueueLockOwner(lockPath)
        if (still?.token === token) unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
    }
  }
}
