/**
 * Fair, abortable mutation lease shared by all worktrees of a repository.
 * The on-disk lease coordinates processes; the in-process queue preserves FIFO fairness.
 */
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, ftruncateSync, readSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { RepositoryIdentity } from './RepositoryIdentity'
import { requireRepositoryMutationCapability } from './RepositoryIdentity'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'

export const REPOSITORY_LEASE_FILENAME = 'repository-mutation.lease'
export const DEFAULT_REPOSITORY_LEASE_STALE_MS = 30_000

export interface RepositoryLeaseOwner {
  pid: number
  processInstanceId: string
  token: string
  acquiredAt: string
  heartbeatAt: string
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
    return { pid: value.pid, token: value.token, acquiredAt: value.acquiredAt, heartbeatAt: value.heartbeatAt, processInstanceId: typeof value.processInstanceId === 'string' ? value.processInstanceId : '' }
  } catch { return null }
}
function stale(owner: RepositoryLeaseOwner, staleAfterMs: number): boolean {
  return !isOwnerLive(owner) || Date.now() - Date.parse(owner.heartbeatAt) > staleAfterMs
}
/** Protect a live in-process holder even if its heartbeat was delayed. */
const locallyHeldTokens = new Set<string>()
/** Leases this process let go whose file it could not remove: nobody holds them, so the next caller takes the file over at once. */
const releasedTokens = new Set<string>()
/** A lease file nobody could read for longer than a holder may go without a heartbeat. */
function unreadableFor(path: string, staleAfterMs: number): boolean {
  try { return readOwner(path) === null && Date.now() - statSync(path).mtimeMs > staleAfterMs } catch { return false }
}
function reclaimable(owner: RepositoryLeaseOwner, staleAfterMs: number): boolean {
  return !locallyHeldTokens.has(owner.token) && (releasedTokens.has(owner.token) || stale(owner, staleAfterMs))
}

/**
 * Every removal of a lease file (a release, a reclaim) happens under the lease's removal guard: a file made with
 * `O_EXCL` beside it, held only for the few file operations of one check and removal. Making a lease needs no guard (it
 * only succeeds where no lease file is), so with every removal guarded, nothing can remove or replace the lease file
 * between the check that it may go and its removal: a lease another process has just taken is never removed by a
 * reclaim that looked at the file before it was taken.
 */
const GUARD_SUFFIX = '.guard'
/** A guard nobody could read for this long was left by a process that stopped while writing it. */
const UNREADABLE_GUARD_MS = 2_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void { Atomics.wait(sleeper, 0, 0, ms) }

/**
 * Removes a guard whose holder is gone (its process ended while it held it). It is moved aside first: only one move of
 * that file can succeed, and what was moved is compared with what was found before it is deleted. A guard taken
 * meanwhile by someone else is put back, unless yet another one was made since.
 */
function clearDeadGuard(guard: string): void {
  let text: string
  try { text = readFileSync(guard, 'utf8') } catch { return }
  let dead: boolean
  try {
    const owner = JSON.parse(text) as { pid?: unknown; processInstanceId?: unknown }
    dead = typeof owner.pid !== 'number' || !isOwnerLive({ pid: owner.pid, ...(typeof owner.processInstanceId === 'string' ? { processInstanceId: owner.processInstanceId } : {}) })
  } catch {
    try { dead = Date.now() - statSync(guard).mtimeMs > UNREADABLE_GUARD_MS } catch { return }
  }
  if (!dead) return
  const aside = `${guard}.${createRepositoryLeaseToken()}`
  try { renameSync(guard, aside) } catch { return }
  let moved: string | undefined
  try { moved = readFileSync(aside, 'utf8') } catch { moved = undefined }
  if (moved !== text) try { linkSync(aside, guard) } catch { /* another guard was made since: it stands */ }
  try { unlinkSync(aside) } catch { /* left beside the lease; nothing reads it */ }
}

/** Runs `work` under the removal guard of the lease at `path`, waiting up to `waitMs` for it; undefined when it stayed busy. */
function underRemovalGuard<T>(path: string, work: () => T, waitMs = 0): { value: T } | undefined {
  const guard = `${path}${GUARD_SUFFIX}`
  const record = JSON.stringify({ pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, token: createRepositoryLeaseToken() })
  const until = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(guard, 'wx')
      try { writeSync(fd, record) } finally { closeSync(fd) }
      break
    } catch {
      // Held by another (or, on Windows, a removed guard another program still has open): wait a moment.
      clearDeadGuard(guard)
      if (Date.now() >= until) return undefined
      sleepSync(1)
    }
  }
  try {
    return { value: work() }
  } finally {
    try { if (readFileSync(guard, 'utf8') === record) unlinkSync(guard) } catch { /* a dead-guard clear took it; nothing else holds it */ }
  }
}

function safeReclaim(path: string, staleAfterMs: number): boolean {
  if (!existsSync(path)) return true
  return underRemovalGuard(path, () => {
    try {
      if (!existsSync(path)) return true
      const owner = readOwner(path)
      // A partial publication is not stolen while its creator may still be writing. One that stayed unreadable for
      // longer than the stale window was left by a process that stopped while writing it, and would otherwise hold
      // the repository for good.
      if (!owner) {
        if (!unreadableFor(path, staleAfterMs)) return false
        unlinkSync(path)
        return true
      }
      if (!reclaimable(owner, staleAfterMs)) return false
      unlinkSync(path)
      releasedTokens.delete(owner.token)
      return true
    } catch { return false }
  })?.value ?? false
}
/**
 * Removes the lease file, under its removal guard, while it still names `token`, trying again when it cannot be read or
 * removed for a moment (on Windows another program may have it open). False when it names another holder, is gone, or
 * could not be removed.
 */
function removeOwnLease(path: string, token: string): boolean {
  return underRemovalGuard(path, () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = readOwner(path)
      if (current ? current.token !== token : !existsSync(path)) return false
      if (!current) continue
      try { unlinkSync(path); return true } catch { /* busy: try again */ }
    }
    return false
  }, 500)?.value ?? false
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
  const now = new Date().toISOString()
  const owner: RepositoryLeaseOwner = { pid: opts.pid ?? process.pid, processInstanceId: opts.processInstanceId ?? PROCESS_INSTANCE_ID, token: opts.token ?? createRepositoryLeaseToken(), acquiredAt: now, heartbeatAt: now }
  const write = (): boolean => {
    try {
      const fd = openSync(path, 'wx')
      try { writeSync(fd, JSON.stringify(owner)) } finally { closeSync(fd) }
      return true
    } catch { return false }
  }
  if (!write() && (!safeReclaim(path, opts.staleAfterMs ?? DEFAULT_REPOSITORY_LEASE_STALE_MS) || !write())) return null
  locallyHeldTokens.add(owner.token)
  let released = false
  const handle: RepositoryLeaseHandle = {
    identity, path, owner,
    heartbeat: () => {
      if (released) return false
      owner.heartbeatAt = new Date().toISOString()
      return writeOwnerInPlace(path, owner.token, owner)
    },
    // The holder's turn in this process always ends here, whatever happened to the file: a file another process took
    // over or removed, or one that could not be removed, must never leave every later caller waiting for good.
    release: () => {
      if (released) return true
      released = true
      locallyHeldTokens.delete(owner.token)
      const removed = removeOwnLease(path, owner.token)
      if (!removed && existsSync(path)) releasedTokens.add(owner.token)
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
