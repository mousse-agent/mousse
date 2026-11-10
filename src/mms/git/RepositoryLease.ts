/**
 * Fair, abortable mutation lease shared by all worktrees of a repository, and by every Mousse process and home that
 * works in it (the installed app, development daemons, Mousse's own thread worktrees).
 *
 * Between processes the lease is an OS lock: an exclusive transaction an open SQLite connection holds on
 * `repository-mutation.lock` in the repository's metadata folder (`LockFileEx` on Windows, `fcntl` locks elsewhere).
 * The OS lets it go when the holder's process ends, however it ends, and never while that process holds it, so a live
 * holder is never taken over, however long it holds, and a killed one never holds the repository after it.
 *
 * The lease file (`repository-mutation.lease`) names the holder, for diagnostics and for builds that predate the OS
 * lock: they decide by that file alone, so a holder keeps it fresh for them while it holds the lease, and a new holder
 * waits while a fresh lease of theirs is there. Within the process a FIFO queue keeps callers in order.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync, ftruncateSync, readSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { RepositoryIdentity } from './RepositoryIdentity'
import { requireRepositoryMutationCapability } from './RepositoryIdentity'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'

export const REPOSITORY_LEASE_FILENAME = 'repository-mutation.lease'
export const REPOSITORY_LOCK_FILENAME = 'repository-mutation.lock'
/** How long a lease file of a build without the OS lock stays its holder's without a fresh heartbeat. */
export const DEFAULT_REPOSITORY_LEASE_STALE_MS = 30_000
/** How often a holder refreshes the lease file, well inside the stale window older builds use. */
export const REPOSITORY_LEASE_HEARTBEAT_MS = 10_000

export interface RepositoryLeaseOwner {
  pid: number
  processInstanceId: string
  token: string
  acquiredAt: string
  heartbeatAt: string
  /** Written by a holder of the OS lock: the file is that holder's only while it holds the OS lock. */
  osLock?: boolean
}
export interface RepositoryLeaseHandle {
  identity: RepositoryIdentity
  path: string
  owner: RepositoryLeaseOwner
  heartbeat(): boolean
  release(): boolean
}
export interface AcquireRepositoryLeaseOptions {
  signal?: AbortSignal
  retryDelayMs?: number
  staleAfterMs?: number
  /** How long to wait for the lease at most; past it the wait ends with {@link RepositoryLeaseBusyError}. */
  maxWaitMs?: number
  /** Test-only owner overrides. */
  pid?: number
  processInstanceId?: string
  token?: string
}
export class RepositoryLeaseBusyError extends Error { constructor(message = 'Repository mutation lease is busy') { super(message); this.name = 'RepositoryLeaseBusyError' } }
export class RepositoryLeaseAbortedError extends Error { constructor() { super('Repository mutation lease acquisition was aborted'); this.name = 'RepositoryLeaseAbortedError' } }
export class RepositoryLockOrderError extends Error { constructor(message: string) { super(message); this.name = 'RepositoryLockOrderError' } }

export function getRepositoryLeasePath(identity: Pick<RepositoryIdentity, 'metadataDir'>): string { return join(identity.metadataDir, REPOSITORY_LEASE_FILENAME) }
export function getRepositoryLockPath(identity: Pick<RepositoryIdentity, 'metadataDir'>): string { return join(identity.metadataDir, REPOSITORY_LOCK_FILENAME) }
export function createRepositoryLeaseToken(): string { return randomBytes(16).toString('hex') }

/** Development-only check for callers taking multiple repository locks. */
export function assertRepositoryLockOrder(held: readonly Pick<RepositoryIdentity, 'key'>[], next: Pick<RepositoryIdentity, 'key'>): void {
  if (process.env.NODE_ENV === 'production' || held.length === 0) return
  const last = held[held.length - 1].key
  if (last > next.key) throw new RepositoryLockOrderError(`Repository locks must be acquired by key order (${last} before ${next.key})`)
}

function readOwner(path: string): RepositoryLeaseOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<RepositoryLeaseOwner>
    if (typeof value.pid !== 'number' || !value.token || !value.acquiredAt || !value.heartbeatAt) return null
    return { pid: value.pid, token: value.token, acquiredAt: value.acquiredAt, heartbeatAt: value.heartbeatAt, processInstanceId: typeof value.processInstanceId === 'string' ? value.processInstanceId : '', ...(value.osLock === true ? { osLock: true } : {}) }
  } catch { return null }
}
function stale(owner: RepositoryLeaseOwner, staleAfterMs: number): boolean {
  return !isOwnerLive(owner) || Date.now() - Date.parse(owner.heartbeatAt) > staleAfterMs
}
/** Protect a live in-process holder even if its heartbeat was delayed. */
const locallyHeldTokens = new Set<string>()

/** The OS lock: an open connection holding an exclusive transaction on the lock file. */
interface OsLock { release(): void }

/** Takes the repository's OS lock without waiting; null while another connection (in any process) holds it. */
function tryOsLock(path: string): OsLock | null {
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    try { db.close() } catch { /* nothing held */ }
    if ((error as { errcode?: number }).errcode === 5 /* SQLITE_BUSY */) return null
    throw error
  }
  let held = true
  return {
    release: () => {
      if (!held) return
      held = false
      try { db.exec('ROLLBACK') } catch { /* closing ends the transaction too */ }
      try { db.close() } catch { /* the OS lets go with the handle */ }
    }
  }
}

/**
 * Whether the lease file may go, decided while holding the OS lock (so no other holder of it can be writing it):
 * a file a holder of the OS lock wrote was left by one that has let go of it, or ended; a file nobody could read for
 * longer than the stale window was left by a process that stopped while writing it; a lease of a build without the OS
 * lock goes as such builds decide, once it is stale.
 */
function leftBehind(path: string, staleAfterMs: number): boolean {
  const owner = readOwner(path)
  if (!owner) {
    try { return Date.now() - statSync(path).mtimeMs > staleAfterMs } catch { return !existsSync(path) }
  }
  if (locallyHeldTokens.has(owner.token)) return false
  return owner.osLock === true || stale(owner, staleAfterMs)
}
/**
 * Removes the lease file while it still names `token`, trying again when it cannot be read or removed for a moment (on
 * Windows another program may have it open). False when it names another holder, is gone, or could not be removed.
 */
function removeOwnLease(path: string, token: string): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = readOwner(path)
    if (current ? current.token !== token : !existsSync(path)) return false
    if (!current) continue
    try { unlinkSync(path); return true } catch { /* busy: try again */ }
  }
  return false
}
/**
 * Update through the opened inode after verifying the token, never a replacement owner: a reclaim that unlinked the file
 * and wrote its own leaves this write in the old inode. (A temporary file renamed over the lease would replace the new
 * owner's file instead.) The new owner record is written over the old one before the file is cut to its length, never
 * after emptying it, so a reader in another process never sees an empty or cut-short lease: the records only differ in
 * `heartbeatAt`, which has a fixed width, so they have the same length.
 */
function writeOwnerInPlace(path: string, token: string, owner: RepositoryLeaseOwner): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r+')
    const buffer = Buffer.alloc(16 * 1024)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    if (JSON.parse(buffer.subarray(0, length).toString('utf8')).token !== token) return false
    const payload = Buffer.from(JSON.stringify(owner))
    writeSync(fd, payload, 0, payload.length, 0)
    if (payload.length < length) ftruncateSync(fd, payload.length)
    fsyncSync(fd)
    return true
  } catch { return false } finally { if (fd !== null) try { closeSync(fd) } catch { /* ignore */ } }
}

function tryAcquire(identity: RepositoryIdentity, opts: AcquireRepositoryLeaseOptions): RepositoryLeaseHandle | null {
  const path = getRepositoryLeasePath(identity)
  const lock = tryOsLock(getRepositoryLockPath(identity))
  if (!lock) return null
  const now = new Date().toISOString()
  const owner: RepositoryLeaseOwner = { pid: opts.pid ?? process.pid, processInstanceId: opts.processInstanceId ?? PROCESS_INSTANCE_ID, token: opts.token ?? createRepositoryLeaseToken(), acquiredAt: now, heartbeatAt: now, osLock: true }
  const write = (): boolean => {
    try {
      const fd = openSync(path, 'wx')
      try { writeSync(fd, JSON.stringify(owner)) } finally { closeSync(fd) }
      return true
    } catch { return false }
  }
  let written = false
  try {
    // A lease file already there is left behind (removed), or a build without the OS lock holds the repository (wait).
    written = write() || (existsSync(path) && leftBehind(path, opts.staleAfterMs ?? DEFAULT_REPOSITORY_LEASE_STALE_MS) && (() => { try { unlinkSync(path) } catch { return false } return write() })())
  } finally {
    if (!written) lock.release()
  }
  if (!written) return null
  locallyHeldTokens.add(owner.token)
  let released = false
  const heartbeat = (): boolean => {
    if (released) return false
    owner.heartbeatAt = new Date().toISOString()
    return writeOwnerInPlace(path, owner.token, owner)
  }
  // Only for builds without the OS lock, which take over a lease file that is not kept fresh.
  const refresh = setInterval(heartbeat, REPOSITORY_LEASE_HEARTBEAT_MS)
  refresh.unref()
  const handle: RepositoryLeaseHandle = {
    identity, path, owner, heartbeat,
    // The file goes first, then the OS lock, so a lease file of a holder of the OS lock is never there without it.
    // The holder's turn in this process always ends here, whatever happened to the file.
    release: () => {
      if (released) return true
      released = true
      clearInterval(refresh)
      locallyHeldTokens.delete(owner.token)
      const removed = removeOwnLease(path, owner.token)
      lock.release()
      releaseLocal(identity.key)
      return removed
    }
  }
  return handle
}

type Waiter = { identity: RepositoryIdentity; opts: AcquireRepositoryLeaseOptions; resolve: (h: RepositoryLeaseHandle) => void; reject: (e: Error) => void; abort?: () => void }
const queues = new Map<string, Waiter[]>()
/** Keys currently polling the cross-process lease file. */
const pumping = new Set<string>()
/** Keys granted to a local caller and not yet released. */
const locallyHeldKeys = new Set<string>()
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function removeAbortListener(waiter: Waiter): void {
  if (waiter.abort && waiter.opts.signal) waiter.opts.signal.removeEventListener('abort', waiter.abort)
}
async function pump(key: string): Promise<void> {
  if (pumping.has(key) || locallyHeldKeys.has(key)) return
  const queue = queues.get(key); const waiter = queue?.[0]
  if (!queue || !waiter) { queues.delete(key); return }
  pumping.add(key)
  try {
    while (true) {
      if (waiter.opts.signal?.aborted) throw new RepositoryLeaseAbortedError()
      const handle = tryAcquire(waiter.identity, waiter.opts)
      if (handle) {
        queue.shift()
        if (queue.length === 0) queues.delete(key)
        locallyHeldKeys.add(key)
        removeAbortListener(waiter)
        waiter.resolve(handle)
        return
      }
      await delay(waiter.opts.retryDelayMs ?? 25)
    }
  } catch (error) {
    const index = queue.indexOf(waiter)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) queues.delete(key)
    removeAbortListener(waiter)
    waiter.reject(error instanceof Error ? error : new RepositoryLeaseBusyError())
  } finally {
    pumping.delete(key)
    if (!locallyHeldKeys.has(key)) void pump(key)
  }
}
function releaseLocal(key: string): void {
  locallyHeldKeys.delete(key)
  void pump(key)
}

/** Acquire in FIFO order within this process and retry asynchronously across processes. */
export function acquireRepositoryLease(identity: RepositoryIdentity, opts: AcquireRepositoryLeaseOptions = {}): Promise<RepositoryLeaseHandle> {
  requireRepositoryMutationCapability(identity)
  if (opts.signal?.aborted) return Promise.reject(new RepositoryLeaseAbortedError())
  if (opts.maxWaitMs !== undefined) {
    const timeout = AbortSignal.timeout(opts.maxWaitMs)
    const waited = acquireRepositoryLease(identity, { ...opts, maxWaitMs: undefined, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
    return waited.catch((error: unknown) => {
      throw error instanceof RepositoryLeaseAbortedError && timeout.aborted && !opts.signal?.aborted ? new RepositoryLeaseBusyError() : error
    })
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { identity, opts, resolve, reject }
    if (opts.signal) {
      waiter.abort = () => {
        const queue = queues.get(identity.key); const index = queue?.indexOf(waiter) ?? -1
        if (index < 0) return
        // A queued head behind a local holder has no active pump, so reject it here.
        // A head currently polling is rejected by pump after its current bounded sleep.
        if (index > 0 || !pumping.has(identity.key)) {
          queue!.splice(index, 1)
          if (queue!.length === 0) queues.delete(identity.key)
          removeAbortListener(waiter)
          reject(new RepositoryLeaseAbortedError())
        }
      }
      opts.signal.addEventListener('abort', waiter.abort, { once: true })
    }
    const queue = queues.get(identity.key) ?? []; queue.push(waiter); queues.set(identity.key, queue); void pump(identity.key)
  })
}
