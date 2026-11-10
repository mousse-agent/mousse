/**
 * Fair, abortable mutation lease of a repository, shared by every Mousse process that resolves the same metadata folder
 * for it (`RepositoryIdentity.metadataDir`: the repository's own `mousse` folder when it can be written, else a folder
 * under that process's home). All worktrees of the repository share it.
 *
 * Between processes of this build the lease is an OS lock: an exclusive transaction an open SQLite connection holds on
 * `repository-mutation.lock` in the metadata folder (`LockFileEx` on Windows, `fcntl` locks elsewhere). The OS lets it
 * go when the holder's process ends, however it ends, and never while that process holds it. Once every Mousse on the
 * machine runs this build, a live holder is never taken over, however long it holds, and a killed one never holds the
 * repository after it. That needs a file system whose locks work: not WebDAV, NFS without a lock manager, or (on
 * macOS) msdos and exFAT volumes, where SQLite falls back to lock folders a crash leaves behind.
 *
 * The lease file (`repository-mutation.lease`) names the holder, for diagnostics and for builds that predate the OS
 * lock, which decide by that file alone. Toward them:
 * - a holder keeps its file fresh while it holds the lease, so they never see it as stale;
 * - a lease of theirs is never taken over while its process lives, however old its heartbeat; this build waits, and
 *   says who holds it;
 * - they can still take a lease of this build over when its heartbeat is late (a long pause of this process), and they
 *   reclaim stale files without any lock among themselves. Neither can be prevented from here: upgrade or stop older
 *   Mousse builds that work in the same repositories.
 *
 * Within the process a FIFO queue keeps callers in order; the caller at its head keeps one connection to the lock file
 * while it waits.
 */
import { closeSync, existsSync, linkSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync, ftruncateSync, readSync, fsyncSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { RepositoryIdentity } from './RepositoryIdentity'
import { requireRepositoryMutationCapability } from './RepositoryIdentity'
import { isOwnerLive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { sqliteFilePath } from '../data/sqliteFilePath'

export const REPOSITORY_LEASE_FILENAME = 'repository-mutation.lease'
export const REPOSITORY_LOCK_FILENAME = 'repository-mutation.lock'
/** How long a lease file nobody can read, and that a holder of the OS lock did not start, stays its writer's. */
export const DEFAULT_REPOSITORY_LEASE_STALE_MS = 30_000
/** How often a holder refreshes the lease file, well inside the 30 s stale window older builds use. */
export const REPOSITORY_LEASE_HEARTBEAT_MS = 10_000
/** How a lease file of this build begins (`osLock` is written first), so an unfinished one is told from an older build's. */
const OS_LOCK_RECORD_PREFIX = '{"osLock":true'
/** The complete record is written here first, then linked into place (`publishLease`). */
const PUBLISH_PREFIX = `${REPOSITORY_LEASE_FILENAME}.publish-`

export interface RepositoryLeaseOwner {
  /** Written by a holder of the OS lock: the file is that holder's only while it holds the OS lock. */
  osLock?: boolean
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
  /** How long an unreadable lease file that a holder of the OS lock did not start is waited for before it is removed. */
  staleAfterMs?: number
  /** How long to wait for the lease at most; past it the wait ends with {@link RepositoryLeaseBusyError}. */
  maxWaitMs?: number
  /** Test-only: how often the holder refreshes its lease file ({@link REPOSITORY_LEASE_HEARTBEAT_MS}). */
  heartbeatMs?: number
  /** Test-only owner overrides. */
  pid?: number
  processInstanceId?: string
  token?: string
}

/** Who holds a lease, as its lease file names it. */
export interface RepositoryLeaseHolder {
  pid: number
  acquiredAt: string
  /** A Mousse without the OS lock. */
  olderBuild: boolean
}
export function describeLeaseHolder(holder: RepositoryLeaseHolder): string {
  return `held by process ${holder.pid} since ${holder.acquiredAt}${holder.olderBuild ? ' (an older Mousse)' : ''}`
}

export class RepositoryLeaseBusyError extends Error {
  readonly holder?: RepositoryLeaseHolder
  constructor(message = 'Repository mutation lease is busy', options: { holder?: RepositoryLeaseHolder; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'RepositoryLeaseBusyError'
    if (options.holder) this.holder = options.holder
  }
}
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

function parseOwner(text: string): RepositoryLeaseOwner | null {
  try {
    const value = JSON.parse(text) as Partial<RepositoryLeaseOwner>
    if (typeof value.pid !== 'number' || !value.token || !value.acquiredAt || !value.heartbeatAt) return null
    return { ...(value.osLock === true ? { osLock: true } : {}), pid: value.pid, processInstanceId: typeof value.processInstanceId === 'string' ? value.processInstanceId : '', token: value.token, acquiredAt: value.acquiredAt, heartbeatAt: value.heartbeatAt }
  } catch { return null }
}
function readOwner(path: string): RepositoryLeaseOwner | null {
  try { return parseOwner(readFileSync(path, 'utf8')) } catch { return null }
}
function holderOf(owner: RepositoryLeaseOwner): RepositoryLeaseHolder {
  return { pid: owner.pid, acquiredAt: owner.acquiredAt, olderBuild: owner.osLock !== true }
}
/** Protect a live in-process holder even if its heartbeat was delayed. */
const locallyHeldTokens = new Set<string>()

const SQLITE_BUSY = 5
const SQLITE_IOERR = 10
const SQLITE_CANTOPEN = 14
/** The primary SQLite result code of an error (an extended code's low byte), as elsewhere in the codebase. */
function sqliteCode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' ? code & 0xff : undefined
}
/** The lock file could not be opened or locked for now (a scanner holding it, a network drive's lock failing): try again. */
class LockUnavailableError extends Error {
  constructor(cause: unknown) { super('The repository lock file could not be opened or locked', { cause }); this.name = 'LockUnavailableError' }
}

/**
 * One connection to the lock file, kept by the caller at the head of the queue while it waits, so each retry only begins
 * a transaction again. It becomes the holder's when the lock is taken.
 */
class LockConnection {
  private db: DatabaseSync | undefined
  constructor(private readonly path: string) {}

  /** `locked` once this connection holds the OS lock, `busy` while another connection does. */
  tryLock(): 'locked' | 'busy' {
    try {
      this.db ??= new DatabaseSync(sqliteFilePath(this.path), { timeout: 0 })
      this.db.exec('BEGIN EXCLUSIVE')
      return 'locked'
    } catch (error) {
      const code = sqliteCode(error)
      if (code === SQLITE_BUSY) return 'busy'
      this.close()
      if (code === SQLITE_CANTOPEN || code === SQLITE_IOERR) throw new LockUnavailableError(error)
      throw error
    }
  }

  unlock(): void {
    try { this.db?.exec('ROLLBACK') } catch { this.close() }
  }

  close(): void {
    const db = this.db
    this.db = undefined
    try { db?.close() } catch { /* the OS lets go with the handle */ }
  }
}

/**
 * What to do with a lease file found while holding the OS lock (so no holder of it can be writing one):
 * - one a holder of the OS lock wrote, complete or not, was left by one that let go of it or ended: it goes at once;
 * - one of an older build goes once its process is gone, and never while it lives, however old its heartbeat;
 * - one nobody can read that does not begin as this build's (empty, or an older build's unfinished record) goes once it
 *   was unreadable for `staleAfterMs`, as older builds decide.
 */
function leaseFound(path: string, staleAfterMs: number): { remove: boolean; holder?: RepositoryLeaseHolder } {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { remove: !existsSync(path) } }
  const owner = parseOwner(text)
  if (!owner) {
    if (text.startsWith(OS_LOCK_RECORD_PREFIX)) return { remove: true }
    try { return { remove: Date.now() - statSync(path).mtimeMs > staleAfterMs } } catch { return { remove: !existsSync(path) } }
  }
  if (locallyHeldTokens.has(owner.token)) return { remove: false, holder: holderOf(owner) }
  if (owner.osLock) return { remove: true }
  return isOwnerLive(owner) ? { remove: false, holder: holderOf(owner) } : { remove: true }
}

/** Removes complete records an earlier holder wrote and did not link into place (it stopped in between). Under the OS lock. */
function removeUnpublished(path: string): void {
  const folder = dirname(path)
  let names: string[]
  try { names = readdirSync(folder) } catch { return }
  for (const name of names) if (name.startsWith(PUBLISH_PREFIX)) try { unlinkSync(join(folder, name)) } catch { /* the next holder tries again */ }
}

/**
 * Puts the lease file in place, under the OS lock, only where none is: the complete record is written to a file of its
 * own and linked as the lease, so the lease is never seen empty or cut short, and never replaces a lease an older build
 * made meanwhile (a rename would). Where the file system has no hard links, the record is written with a create-only
 * open; a failed write leaves no file. `taken` when a lease is there.
 */
function publishLease(path: string, record: string, token: string): 'published' | 'taken' {
  const staged = `${dirname(path)}/${PUBLISH_PREFIX}${token}`
  writeFileSync(staged, record, { flag: 'wx' })
  try {
    try {
      linkSync(staged, path)
      return 'published'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'taken'
    }
    let fd: number
    try { fd = openSync(path, 'wx') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'taken'
      throw error
    }
    try {
      writeSync(fd, record)
    } catch (error) {
      try { closeSync(fd) } catch { /* removed below */ }
      try { unlinkSync(path) } catch { /* begins as this build's, so the next holder removes it */ }
      throw error
    }
    closeSync(fd)
    return 'published'
  } finally {
    try { unlinkSync(staged) } catch { /* removed by the next holder (`removeUnpublished`) */ }
  }
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

type Attempt = { handle: RepositoryLeaseHandle } | { busy: RepositoryLeaseHolder | undefined }

function tryAcquire(identity: RepositoryIdentity, opts: AcquireRepositoryLeaseOptions, connection: LockConnection): Attempt {
  const path = getRepositoryLeasePath(identity)
  if (connection.tryLock() === 'busy') {
    const owner = readOwner(path)
    return { busy: owner ? holderOf(owner) : undefined }
  }
  const now = new Date().toISOString()
  // `osLock` first: an unfinished record of this build is known by how it begins.
  const owner: RepositoryLeaseOwner = { osLock: true, pid: opts.pid ?? process.pid, processInstanceId: opts.processInstanceId ?? PROCESS_INSTANCE_ID, token: opts.token ?? createRepositoryLeaseToken(), acquiredAt: now, heartbeatAt: now }
  try {
    removeUnpublished(path)
    let published = false
    for (let attempt = 0; attempt < 2 && !published; attempt += 1) {
      if (existsSync(path)) {
        const found = leaseFound(path, opts.staleAfterMs ?? DEFAULT_REPOSITORY_LEASE_STALE_MS)
        if (!found.remove) { connection.unlock(); return { busy: found.holder } }
        try { unlinkSync(path) } catch { connection.unlock(); return { busy: undefined } }
      }
      // `taken`: an older build made a lease meanwhile; it is looked at again.
      published = publishLease(path, JSON.stringify(owner), owner.token) === 'published'
    }
    if (!published) { connection.unlock(); return { busy: undefined } }
  } catch (error) {
    connection.unlock()
    throw error
  }
  locallyHeldTokens.add(owner.token)
  localHolders.set(identity.key, owner)
  let released = false
  const heartbeat = (): boolean => {
    if (released) return false
    owner.heartbeatAt = new Date().toISOString()
    return writeOwnerInPlace(path, owner.token, owner)
  }
  // Only for builds without the OS lock, which take over a lease file that is not kept fresh.
  const refresh = setInterval(heartbeat, opts.heartbeatMs ?? REPOSITORY_LEASE_HEARTBEAT_MS)
  refresh.unref()
  return {
    handle: {
      identity, path, owner, heartbeat,
      // The file goes first, then the OS lock, so a lease file of a holder of the OS lock is never there without it.
      // The holder's turn in this process always ends here, whatever happened to the file.
      release: () => {
        if (released) return true
        released = true
        clearInterval(refresh)
        locallyHeldTokens.delete(owner.token)
        localHolders.delete(identity.key)
        const removed = removeOwnLease(path, owner.token)
        connection.unlock()
        connection.close()
        releaseLocal(identity.key)
        return removed
      }
    }
  }
}

type Waiter = { identity: RepositoryIdentity; opts: AcquireRepositoryLeaseOptions; resolve: (h: RepositoryLeaseHandle) => void; reject: (e: Error) => void; abort?: () => void }
const queues = new Map<string, Waiter[]>()
/** Keys currently polling the cross-process lock. */
const pumping = new Set<string>()
/** Keys granted to a local caller and not yet released. */
const locallyHeldKeys = new Set<string>()
/** The owner of each lease this process holds, by key, to name it in a busy error. */
const localHolders = new Map<string, RepositoryLeaseOwner>()
/** What the last look found holding each repository waited for, to name it when a wait ends busy. */
const waitNotes = new Map<string, { holder?: RepositoryLeaseHolder; cause?: unknown }>()
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function removeAbortListener(waiter: Waiter): void {
  if (waiter.abort && waiter.opts.signal) waiter.opts.signal.removeEventListener('abort', waiter.abort)
}
async function pump(key: string): Promise<void> {
  if (pumping.has(key) || locallyHeldKeys.has(key)) return
  const queue = queues.get(key); const waiter = queue?.[0]
  if (!queue || !waiter) { queues.delete(key); return }
  pumping.add(key)
  const connection = new LockConnection(getRepositoryLockPath(waiter.identity))
  let granted = false
  try {
    while (true) {
      if (waiter.opts.signal?.aborted) throw new RepositoryLeaseAbortedError()
      let attempt: Attempt | undefined
      try {
        attempt = tryAcquire(waiter.identity, waiter.opts, connection)
      } catch (error) {
        if (!(error instanceof LockUnavailableError)) throw error
        waitNotes.set(key, { cause: error.cause })
      }
      if (attempt && 'handle' in attempt) {
        granted = true
        waitNotes.delete(key)
        queue.shift()
        if (queue.length === 0) queues.delete(key)
        locallyHeldKeys.add(key)
        removeAbortListener(waiter)
        waiter.resolve(attempt.handle)
        return
      }
      if (attempt) waitNotes.set(key, { ...(attempt.busy ? { holder: attempt.busy } : {}) })
      await delay(waiter.opts.retryDelayMs ?? 25)
    }
  } catch (error) {
    const index = queue.indexOf(waiter)
    if (index >= 0) queue.splice(index, 1)
    if (queue.length === 0) queues.delete(key)
    removeAbortListener(waiter)
    waiter.reject(error instanceof Error ? error : new RepositoryLeaseBusyError())
  } finally {
    if (!granted) connection.close()
    pumping.delete(key)
    if (!locallyHeldKeys.has(key)) void pump(key)
  }
}
function releaseLocal(key: string): void {
  locallyHeldKeys.delete(key)
  void pump(key)
}

/** The busy error for a wait on `key` that ran out: who holds the lease, as last seen, and what last failed. */
function busyError(key: string): RepositoryLeaseBusyError {
  const local = localHolders.get(key)
  const note = waitNotes.get(key)
  const holder = local ? holderOf(local) : note?.holder
  const failed = note?.cause instanceof Error ? note.cause.message : undefined
  const message = ['Repository mutation lease is busy', holder ? `: ${describeLeaseHolder(holder)}` : '', failed ? ` (the lock file could not be used: ${failed})` : ''].join('')
  return new RepositoryLeaseBusyError(message, { ...(holder ? { holder } : {}), ...(note?.cause !== undefined ? { cause: note.cause } : {}) })
}

/** Acquire in FIFO order within this process and retry asynchronously across processes. */
export function acquireRepositoryLease(identity: RepositoryIdentity, opts: AcquireRepositoryLeaseOptions = {}): Promise<RepositoryLeaseHandle> {
  requireRepositoryMutationCapability(identity)
  if (opts.signal?.aborted) return Promise.reject(new RepositoryLeaseAbortedError())
  if (opts.maxWaitMs !== undefined) {
    const timeout = AbortSignal.timeout(opts.maxWaitMs)
    const waited = acquireRepositoryLease(identity, { ...opts, maxWaitMs: undefined, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
    return waited.catch((error: unknown) => {
      throw error instanceof RepositoryLeaseAbortedError && timeout.aborted && !opts.signal?.aborted ? busyError(identity.key) : error
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
