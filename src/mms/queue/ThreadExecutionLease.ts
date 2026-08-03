/**
 * Pure-Node, cross-process per-thread execution lease and queue mutation lock.
 *
 * Ownership primitive: atomic exclusive create (O_EXCL / wx).
 * Release is ownership-checked by token. Live owners are never force-deleted.
 * Empty/partial lock files are held for a grace interval (publication race).
 * No event-loop busy-spin; sync APIs fail fast after one stale-reclaim retry.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync
} from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  getFileAgeMs,
  isOwnerLive,
  PROCESS_INSTANCE_ID
} from './processLiveness'

export const EXECUTION_LEASE_FILENAME = 'execution.lease'
export const QUEUE_MUTATION_LOCK_FILENAME = 'queue.mut.lock'
/** Exclusive lock for thread data RMW (messages/agents/tasks/llm/mousse sessions — never queue). */
export const THREAD_DATA_MUTATION_LOCK_FILENAME = 'thread-data.mut.lock'

/** Just-created empty/partial locks are treated as held for this grace window. */
export const LOCK_PUBLICATION_GRACE_MS = 2_000
/** Corrupt/unreadable lock files may be reclaimed only after this age. */
export const LOCK_CORRUPT_STALE_MS = 30_000

export interface ThreadLeaseOwner {
  pid: number
  token: string
  /** Process instance id for PID-reuse / restart discrimination. */
  processInstanceId: string
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
  /** Override process instance id (tests). */
  processInstanceId?: string
  /** Max attempts when contending / reclaiming (async wait path only). */
  maxAttempts?: number
  /** Sleep between attempts (ms) — async wait path only. */
  retryDelayMs?: number
  /** Optional abort for wait/retry loops (channels). */
  signal?: AbortSignal
  /** When true, only try once (no wait). Default for sync acquire. */
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

export class QueueMutationLockBusyError extends Error {
  readonly threadDir: string
  constructor(threadDir: string, message?: string) {
    super(message ?? `Thread queue mutation lock is busy (${threadDir})`)
    this.name = 'QueueMutationLockBusyError'
    this.threadDir = threadDir
  }
}

export function getExecutionLeasePath(threadDir: string): string {
  return join(threadDir, EXECUTION_LEASE_FILENAME)
}

export function getQueueMutationLockPath(threadDir: string): string {
  return join(threadDir, QUEUE_MUTATION_LOCK_FILENAME)
}

export function getThreadDataMutationLockPath(threadDir: string): string {
  return join(threadDir, THREAD_DATA_MUTATION_LOCK_FILENAME)
}

export function createLeaseToken(): string {
  return randomBytes(16).toString('hex')
}

/** Tokens currently held in this process (prevents same-pid double-acquire / false reclaim). */
const heldTokensInProcess = new Set<string>()

function trackHeld(token: string): void {
  heldTokensInProcess.add(token)
}

function untrackHeld(token: string): void {
  heldTokensInProcess.delete(token)
}

/** Test helper: clear process-local held-token registry. */
export function resetHeldLeaseTokensForTests(): void {
  heldTokensInProcess.clear()
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

export function mayReclaimUnreadableLock(lockPath: string, nowMs = Date.now()): boolean {
  const age = getFileAgeMs(lockPath, nowMs)
  if (age == null) return false
  if (age < LOCK_PUBLICATION_GRACE_MS) return false
  return age >= LOCK_CORRUPT_STALE_MS
}

export function readLeaseOwner(lockPath: string): ThreadLeaseOwner | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = readFileSync(lockPath, 'utf-8').trim()
    if (!raw) return null
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
      processInstanceId:
        typeof parsed.processInstanceId === 'string' ? parsed.processInstanceId : '',
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
 * Dead owners are free. Recent empty/corrupt files are treated as held (not free).
 */
export function isLeaseHeldByLivePeer(
  threadDir: string,
  selfToken?: string
): { held: boolean; owner: ThreadLeaseOwner | null } {
  const lockPath = getExecutionLeasePath(threadDir)
  if (!existsSync(lockPath)) return { held: false, owner: null }

  const owner = readLeaseOwner(lockPath)
  if (!owner) {
    // Unreadable: held during grace/stale window; free only after corrupt stale threshold.
    const held = !mayReclaimUnreadableLock(lockPath)
    return { held, owner: null }
  }
  if (selfToken && owner.token === selfToken) return { held: false, owner }
  if (heldTokensInProcess.has(owner.token)) {
    return { held: false, owner }
  }
  if (!isOwnerLive(owner)) return { held: false, owner }
  // Same pid orphan after crash (not tracked): not an external peer.
  if (owner.pid === process.pid) return { held: false, owner }
  return { held: true, owner }
}

/**
 * Attempt to remove a lease only when the recorded owner is dead/stale or matches `token`.
 * Never unlinks a live foreign owner or a recent empty/partial publication.
 */
export function tryReclaimStaleLease(threadDir: string, expectedToken?: string): boolean {
  const lockPath = getExecutionLeasePath(threadDir)
  if (!existsSync(lockPath)) return true

  const owner = readLeaseOwner(lockPath)
  if (!owner) {
    if (!mayReclaimUnreadableLock(lockPath)) return false
    try {
      unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
  if (expectedToken && owner.token === expectedToken) {
    return releaseExecutionLease(threadDir, expectedToken)
  }
  if (heldTokensInProcess.has(owner.token)) return false
  if (isOwnerLive(owner) && owner.pid !== process.pid) return false
  // Same-pid but live instance with different token still held in process — already handled.
  // Dead owner, or same-pid orphan not in heldTokens: compare-and-unlink.
  try {
    const still = readLeaseOwner(lockPath)
    if (!still || still.token !== owner.token) return false
    if (heldTokensInProcess.has(still.token)) return false
    if (isOwnerLive(still) && still.pid !== process.pid) return false
    // Same process, live, different token not held: orphan from prior crash in-process.
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

/**
 * Heartbeat update on the currently opened path inode.
 * Opens r+, reads/verifies token from that fd, then truncates/writes/fsyncs the same fd.
 * If another process replaced the path, we only mutate the old unlinked inode — never the new owner.
 */
function writeOwnerInPlace(lockPath: string, expectedToken: string, owner: ThreadLeaseOwner): boolean {
  let fd: number | null = null
  try {
    fd = openSync(lockPath, 'r+')
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const raw = buf.subarray(0, n).toString('utf-8').trim()
    if (!raw) return false
    let parsed: Partial<ThreadLeaseOwner>
    try {
      parsed = JSON.parse(raw) as Partial<ThreadLeaseOwner>
    } catch {
      return false
    }
    if (typeof parsed.token !== 'string' || parsed.token !== expectedToken) {
      return false
    }
    const payload = Buffer.from(JSON.stringify(owner, null, 2), 'utf-8')
    ftruncateSync(fd, 0)
    writeSync(fd, payload, 0, payload.length, 0)
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
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
    processInstanceId: opts?.processInstanceId ?? PROCESS_INSTANCE_ID,
    acquiredAt: now,
    heartbeatAt: now,
    source: opts?.source
  }

  const attempt = (): ThreadLeaseHandle | null => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, JSON.stringify(owner, null, 2))
      } catch (err) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
        throw err
      }
      closeSync(fd)
      trackHeld(owner.token)
      return { threadDir, lockPath, owner }
    } catch {
      return null
    }
  }

  const first = attempt()
  if (first) return first
  // One safe stale-reclaim retry only (no busy-spin).
  if (tryReclaimStaleLease(threadDir)) {
    return attempt()
  }
  return null
}

/**
 * Sync acquire: fail fast after one stale-reclaim retry (no event-loop busy-spin).
 * Prefer waitAcquireExecutionLease for async retry with AbortSignal.
 */
export function acquireExecutionLease(
  threadDir: string,
  opts?: AcquireLeaseOptions
): ThreadLeaseHandle {
  if (opts?.signal?.aborted) {
    throw new LeaseBusyError('Lease acquire aborted', null)
  }
  const handle = tryAcquireExecutionLease(threadDir, opts)
  if (handle) return handle
  const lastOwner = readLeaseOwner(getExecutionLeasePath(threadDir))
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

/** Refresh heartbeat while holding the lease (ownership-checked, in-place inode write). */
export function heartbeatExecutionLease(handle: ThreadLeaseHandle): boolean {
  const next: ThreadLeaseOwner = {
    ...handle.owner,
    heartbeatAt: new Date().toISOString()
  }
  const ok = writeOwnerInPlace(handle.lockPath, handle.owner.token, next)
  if (ok) handle.owner = next
  return ok
}

/**
 * Ownership-checked release. Returns false if another owner holds the lock
 * or the file is missing/unreadable (never deletes without exact token match).
 */
export function releaseExecutionLease(threadDir: string, token: string): boolean {
  const lockPath = getExecutionLeasePath(threadDir)
  const owner = readLeaseOwner(lockPath)
  if (!owner) {
    // Missing/unreadable: do not unlink based on age — may be a new partial publication.
    untrackHeld(token)
    return false
  }
  if (owner.token !== token) return false
  try {
    const still = readLeaseOwner(lockPath)
    if (!still || still.token !== token) return false
    unlinkSync(lockPath)
    untrackHeld(token)
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
  processInstanceId: string
  token: string
  acquiredAt: string
}

function readQueueLockOwner(lockPath: string): QueueLockOwner | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = readFileSync(lockPath, 'utf-8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<QueueLockOwner>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      processInstanceId:
        typeof parsed.processInstanceId === 'string' ? parsed.processInstanceId : '',
      token: parsed.token,
      acquiredAt:
        typeof parsed.acquiredAt === 'string' && parsed.acquiredAt
          ? parsed.acquiredAt
          : new Date(0).toISOString()
    }
  } catch {
    return null
  }
}

function tryReclaimQueueLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return true
  const owner = readQueueLockOwner(lockPath)
  if (!owner) {
    if (!mayReclaimUnreadableLock(lockPath)) return false
    try {
      unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
  if (isOwnerLive(owner) && owner.pid !== process.pid) return false
  try {
    const still = readQueueLockOwner(lockPath)
    if (!still || still.token !== owner.token) return false
    if (isOwnerLive(still) && still.pid !== process.pid) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

/**
 * Short exclusive lock around durable queue read-modify-write.
 * Re-entrant within the same process for the same path.
 * Fail-fast after one stale-reclaim retry (no busy-spin).
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
  const payload = JSON.stringify({
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token,
    acquiredAt: new Date().toISOString()
  } satisfies QueueLockOwner)

  const tryOpen = (): number | null => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, payload)
      } catch (err) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
        throw err
      }
      return fd
    } catch {
      return null
    }
  }

  let fd = tryOpen()
  if (fd === null) {
    tryReclaimQueueLock(lockPath)
    fd = tryOpen()
  }
  if (fd === null) {
    throw new QueueMutationLockBusyError(threadDir)
  }

  queueLockDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    queueLockDepth.delete(lockPath)
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

const threadDataLockDepth = new Map<string, number>()

/**
 * Exclusive lock for thread-data RMW (messages, agents, tasks, llm context, mousse sessions).
 * Does **not** protect queue.json (use withQueueMutationLock).
 * Re-entrant in-process; fail-fast after one stale reclaim (same policy as queue lock).
 */
export function withThreadDataMutationLock<T>(threadDir: string, fn: () => T): T {
  mkdirSync(threadDir, { recursive: true })
  const lockPath = getThreadDataMutationLockPath(threadDir)
  const depth = threadDataLockDepth.get(lockPath) ?? 0
  if (depth > 0) {
    threadDataLockDepth.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      threadDataLockDepth.set(lockPath, depth)
    }
  }

  const token = createLeaseToken()
  const payload = JSON.stringify({
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token,
    acquiredAt: new Date().toISOString()
  } satisfies QueueLockOwner)

  const tryOpen = (): number | null => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, payload)
      } catch (err) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
        throw err
      }
      return fd
    } catch {
      return null
    }
  }

  let fd = tryOpen()
  if (fd === null) {
    tryReclaimQueueLock(lockPath)
    fd = tryOpen()
  }
  if (fd === null) {
    throw new QueueMutationLockBusyError(threadDir)
  }

  threadDataLockDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    threadDataLockDepth.delete(lockPath)
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
