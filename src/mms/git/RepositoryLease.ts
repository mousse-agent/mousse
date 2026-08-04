/**
 * Fair, abortable mutation lease shared by all worktrees of a repository.
 * The on-disk lease coordinates processes; the in-process queue preserves FIFO fairness.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync, ftruncateSync, readSync, fsyncSync } from 'node:fs'
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
  /** Test-only owner overrides. */
  pid?: number
  processInstanceId?: string
  token?: string
}
export class RepositoryLeaseBusyError extends Error { constructor() { super('Repository mutation lease is busy'); this.name = 'RepositoryLeaseBusyError' } }
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
function safeReclaim(path: string, staleAfterMs: number): boolean {
  if (!existsSync(path)) return true
  const owner = readOwner(path)
  // A partial publication is deliberately never stolen; its creator may still be writing.
  if (!owner || locallyHeldTokens.has(owner.token) || !stale(owner, staleAfterMs)) return false
  try {
    const again = readOwner(path)
    if (!again || again.token !== owner.token || !stale(again, staleAfterMs)) return false
    unlinkSync(path)
    return true
  } catch { return false }
}
/** Update through the opened inode after verifying the token, never a replacement owner. */
function writeOwnerInPlace(path: string, token: string, owner: RepositoryLeaseOwner): boolean {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r+')
    const buffer = Buffer.alloc(16 * 1024)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    if (JSON.parse(buffer.subarray(0, length).toString('utf8')).token !== token) return false
    const payload = Buffer.from(JSON.stringify(owner))
    ftruncateSync(fd, 0)
    writeSync(fd, payload, 0, payload.length, 0)
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
    release: () => {
      if (released) return true
      if (readOwner(path)?.token !== owner.token) return false
      try { unlinkSync(path); released = true; locallyHeldTokens.delete(owner.token); releaseLocal(identity.key); return true } catch { return false }
    }
  }
  return handle
}

type Waiter = { identity: RepositoryIdentity; opts: AcquireRepositoryLeaseOptions; resolve: (h: RepositoryLeaseHandle) => void; reject: (e: Error) => void; abort?: () => void }
const queues = new Map<string, Waiter[]>()
const active = new Set<string>()
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
async function pump(key: string): Promise<void> {
  if (active.has(key)) return
  const queue = queues.get(key); const waiter = queue?.[0]
  if (!waiter) { queues.delete(key); return }
  active.add(key)
  try {
    while (true) {
      if (waiter.opts.signal?.aborted) throw new RepositoryLeaseAbortedError()
      const handle = tryAcquire(waiter.identity, waiter.opts)
      if (handle) { waiter.resolve(handle); return } // retained at queue head until release
      await delay(waiter.opts.retryDelayMs ?? 25)
    }
  } catch (error) {
    queue!.shift(); waiter.reject(error instanceof Error ? error : new RepositoryLeaseBusyError()); active.delete(key); void pump(key); return
  } finally { active.delete(key) }
}
function releaseLocal(key: string): void { const queue = queues.get(key); queue?.shift(); void pump(key) }

/** Acquire in FIFO order within this process and retry asynchronously across processes. */
export function acquireRepositoryLease(identity: RepositoryIdentity, opts: AcquireRepositoryLeaseOptions = {}): Promise<RepositoryLeaseHandle> {
  requireRepositoryMutationCapability(identity)
  if (opts.signal?.aborted) return Promise.reject(new RepositoryLeaseAbortedError())
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { identity, opts, resolve, reject }
    if (opts.signal) {
      waiter.abort = () => {
        const queue = queues.get(identity.key); const index = queue?.indexOf(waiter) ?? -1
        if (index > 0) { queue!.splice(index, 1); reject(new RepositoryLeaseAbortedError()) }
        // Head is noticed by pump immediately after its current sleep.
      }
      opts.signal.addEventListener('abort', waiter.abort, { once: true })
    }
    const queue = queues.get(identity.key) ?? []; queue.push(waiter); queues.set(identity.key, queue); void pump(identity.key)
  })
}
