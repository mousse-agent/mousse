/**
 * Durable cross-process file locks for scheduled jobs / channels / tick.
 * Exclusive create (O_EXCL / wx) is the ownership primitive.
 * No event-loop busy-spin; fail fast after one safe stale-reclaim retry.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'
import {
  getFileAgeMs,
  isOwnerLive,
  PROCESS_INSTANCE_ID
} from '../queue/processLiveness'

/** Just-created empty/partial locks are held for this grace window. */
export const FILE_LOCK_PUBLICATION_GRACE_MS = 2_000
/** Corrupt/unreadable lock files may be reclaimed only after this age. */
export const FILE_LOCK_CORRUPT_STALE_MS = 30_000

export interface FileLockOwner {
  pid: number
  processInstanceId: string
  token: string
  acquiredAt: string
  heartbeatAt?: string
}

export class FileLockBusyError extends Error {
  readonly lockPath: string
  readonly owner: FileLockOwner | null
  constructor(lockPath: string, owner: FileLockOwner | null = null) {
    super(
      owner
        ? `File lock busy: ${lockPath} (pid ${owner.pid})`
        : `File lock busy: ${lockPath}`
    )
    this.name = 'FileLockBusyError'
    this.lockPath = lockPath
    this.owner = owner
  }
}

const lockDepth = new Map<string, number>()
/** Token held for each lock path in this process (reentrant + ownership-checked release). */
const heldTokens = new Map<string, string>()

function createToken(): string {
  return randomBytes(16).toString('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

export function readFileLockOwner(lockPath: string): FileLockOwner | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = readFileSync(lockPath, 'utf-8').trim()
    if (!raw) return null
    // Legacy: plain pid only
    if (/^\d+$/.test(raw)) {
      return {
        pid: Number(raw),
        processInstanceId: '',
        token: `legacy-pid-${raw}`,
        acquiredAt: new Date(0).toISOString()
      }
    }
    const parsed = JSON.parse(raw) as Partial<FileLockOwner>
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid)) return null
    if (typeof parsed.token !== 'string' || !parsed.token) return null
    return {
      pid: parsed.pid,
      processInstanceId:
        typeof parsed.processInstanceId === 'string' ? parsed.processInstanceId : '',
      token: parsed.token,
      acquiredAt:
        typeof parsed.acquiredAt === 'string' && parsed.acquiredAt
          ? parsed.acquiredAt
          : new Date(0).toISOString(),
      heartbeatAt:
        typeof parsed.heartbeatAt === 'string' ? parsed.heartbeatAt : undefined
    }
  } catch {
    return null
  }
}

/**
 * Whether an unreadable/empty lock file may be unlinked.
 * Recent empty/partial files are treated as held (publication race).
 */
export function mayReclaimUnreadableLock(lockPath: string, nowMs = Date.now()): boolean {
  const age = getFileAgeMs(lockPath, nowMs)
  if (age == null) return false
  if (age < FILE_LOCK_PUBLICATION_GRACE_MS) return false
  return age >= FILE_LOCK_CORRUPT_STALE_MS
}

function tryReclaimStaleFileLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return true
  const owner = readFileLockOwner(lockPath)
  if (!owner) {
    // Empty / corrupt / unparseable
    if (!mayReclaimUnreadableLock(lockPath)) return false
    try {
      unlinkSync(lockPath)
      return true
    } catch {
      return false
    }
  }
  // Never reclaim a live owner (including this process if reentrant token is held).
  if (heldTokens.get(lockPath) === owner.token) return false
  if (isOwnerLive(owner)) return false
  try {
    const still = readFileLockOwner(lockPath)
    if (!still || still.token !== owner.token) return false
    if (isOwnerLive(still)) return false
    unlinkSync(lockPath)
    return true
  } catch {
    return false
  }
}

function ensureLockParent(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true })
}

function tryCreateFileLock(lockPath: string): { fd: number; owner: FileLockOwner } | null {
  ensureLockParent(lockPath)
  const owner: FileLockOwner = {
    pid: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    token: createToken(),
    acquiredAt: nowIso(),
    heartbeatAt: nowIso()
  }
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
    return { fd, owner }
  } catch {
    return null
  }
}

function releaseOwnedFileLock(lockPath: string, fd: number | null, token: string): void {
  try {
    if (fd !== null) closeSync(fd)
  } catch {
    /* ignore */
  }
  try {
    // Unlink only when a readable owner token exactly matches ours.
    // Missing/unreadable must not delete a new owner's empty/partial publication.
    const still = readFileLockOwner(lockPath)
    if (still && still.token === token) {
      unlinkSync(lockPath)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Run `fn` under an exclusive durable file lock.
 * Re-entrant within this process for the same path.
 * On contention: one stale-reclaim retry, then throws FileLockBusyError — never runs fn unlocked.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const depth = lockDepth.get(lockPath) ?? 0
  if (depth > 0) {
    lockDepth.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      lockDepth.set(lockPath, depth)
    }
  }

  let created = tryCreateFileLock(lockPath)
  if (!created) {
    tryReclaimStaleFileLock(lockPath)
    created = tryCreateFileLock(lockPath)
  }
  if (!created) {
    throw new FileLockBusyError(lockPath, readFileLockOwner(lockPath))
  }

  const { fd, owner } = created
  heldTokens.set(lockPath, owner.token)
  lockDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    lockDepth.delete(lockPath)
    heldTokens.delete(lockPath)
    releaseOwnedFileLock(lockPath, fd, owner.token)
  }
}

/**
 * Try to acquire the scheduler tick lock.
 * Reclaims dead/stale/corrupt-old owners; never steals a live owner or a recent empty file.
 * Returns an ownership-checked release function, or null if busy.
 */
export function tryAcquireTickLock(lockPath: string): (() => void) | null {
  let created = tryCreateFileLock(lockPath)
  if (!created) {
    tryReclaimStaleFileLock(lockPath)
    created = tryCreateFileLock(lockPath)
  }
  if (!created) return null

  const { fd, owner } = created
  heldTokens.set(lockPath, owner.token)
  let released = false
  return () => {
    if (released) return
    released = true
    heldTokens.delete(lockPath)
    releaseOwnedFileLock(lockPath, fd, owner.token)
  }
}

/** Test helper: clear reentrant depth / held tokens. */
export function resetFileLockStateForTests(): void {
  lockDepth.clear()
  heldTokens.clear()
}
