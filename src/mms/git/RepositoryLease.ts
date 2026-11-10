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
 * The lock's connection keeps its journal in memory, so locking writes no journal file next to it.
 *
 * The lease file (`repository-mutation.lease`) names the holder, for diagnostics and for builds that predate the OS
 * lock, which decide by that file alone. Toward them:
 * - a holder keeps its file fresh while it holds the lease (and while a stopped Git command keeps it held), so they
 *   never see it as stale;
 * - a lease of theirs is never taken over while its process lives, however old its heartbeat; this build waits, and
 *   says who holds it. It is taken over when that process is gone, when the lease was taken before the computer last
 *   started, or when the process that has the pid now started after the lease was taken (the pid was reused);
 * - they can still take a lease of this build over when its heartbeat is late (a long pause of this process), and they
 *   reclaim stale files without any lock among themselves. Neither can be prevented from here: upgrade or stop older
 *   Mousse builds that work in the same repositories.
 *
 * Within the process a FIFO queue keeps callers in order; the caller at its head keeps one connection to the lock file
 * while it waits. A lock file that cannot be opened or locked is retried, for at most
 * {@link REPOSITORY_LEASE_TIMING}`.unavailableLimitMs` in a row, then reported as busy with what failed.
 *
 * The lease file is put in place whole (linked from a complete record). On a file system without hard links it is
 * written with one create-only write: a process that ends inside that write can leave it empty, and then the next holder
 * waits {@link UNFINISHED_LEASE_MS} for it, and older builds wait until it is removed.
 */
import { execFile } from 'node:child_process'
import { closeSync, existsSync, linkSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync, ftruncateSync, readSync, fsyncSync } from 'node:fs'
import { uptime } from 'node:os'
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
/**
 * Every Mousse writes its whole lease record right after creating the file, in one write; a file still empty or cut
 * short this long after it was made was left by a process that ended inside that write.
 */
export const UNFINISHED_LEASE_MS = 5_000
/** How often a holder refreshes the lease file, well inside the 30 s stale window older builds use. */
export const REPOSITORY_LEASE_HEARTBEAT_MS = 10_000
/**
 * `heartbeatMs`: how often a holder refreshes its lease file ({@link REPOSITORY_LEASE_HEARTBEAT_MS}).
 * `unavailableLimitMs`: how long a lock file that cannot be opened or locked is retried in a row before the wait ends busy.
 * Tests shorten them; `noHardLinks` makes publication take the path of a file system without hard links.
 */
export const REPOSITORY_LEASE_TIMING = { heartbeatMs: REPOSITORY_LEASE_HEARTBEAT_MS, unavailableLimitMs: 30_000, noHardLinks: false }
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
  /** The processes of a stopped Git command that keep the lease held until they are gone. */
  stoppedGitPids?: number[]
}
export interface RepositoryLeaseHandle {
  identity: RepositoryIdentity
  path: string
  owner: RepositoryLeaseOwner
  heartbeat(): boolean
  release(): boolean
  /** Says in the lease file that it stays held for these processes of a stopped Git command (see `gitCancellationScope`). */
  retainFor(pids: number[]): void
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
  /** Processes of a stopped Git command the holder waits for before it lets go. */
  stoppedGitPids?: number[]
}
/** `held by process N since …`, for a sentence about who holds the lease. */
export function describeLeaseHolder(holder: RepositoryLeaseHolder): string {
  return `held by process ${holder.pid} since ${holder.acquiredAt}${holder.olderBuild ? ' (an older Mousse)' : ''}`
}
/** What to tell a person when the lease is held only because a stopped Git command is still running. */
export function stoppedGitText(holder: RepositoryLeaseHolder | undefined): string | undefined {
  const pids = holder?.stoppedGitPids
  return pids?.length ? `A stopped git command is still running (pid ${pids.join(', ')}). Close it or restart Mousse.` : undefined
}

export class RepositoryLeaseBusyError extends Error {
  readonly holder?: RepositoryLeaseHolder
  /** The lease file that names the holder. */
  readonly leasePath?: string
  constructor(message = 'Repository mutation lease is busy', options: { holder?: RepositoryLeaseHolder; cause?: unknown; leasePath?: string } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'RepositoryLeaseBusyError'
    if (options.holder) this.holder = options.holder
    if (options.leasePath) this.leasePath = options.leasePath
  }
}
/**
 * For a holder of an older build: its process may be one that got the pid of an older Mousse that ended, so the lease
 * may be that Mousse's leftover. What clears it.
 */
export function olderBuildText(holder: RepositoryLeaseHolder | undefined, leasePath: string | undefined): string | undefined {
  if (!holder?.olderBuild) return undefined
  return `This may be a lock an older Mousse left behind: restart that Mousse, or, once no Mousse is running, delete ${leasePath ?? REPOSITORY_LEASE_FILENAME}.`
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
    const stopped = Array.isArray(value.stoppedGitPids) ? value.stoppedGitPids.filter((pid): pid is number => Number.isInteger(pid)) : []
    return { ...(value.osLock === true ? { osLock: true } : {}), pid: value.pid, processInstanceId: typeof value.processInstanceId === 'string' ? value.processInstanceId : '', token: value.token, acquiredAt: value.acquiredAt, heartbeatAt: value.heartbeatAt, ...(stopped.length ? { stoppedGitPids: stopped } : {}) }
  } catch { return null }
}
function readOwner(path: string): RepositoryLeaseOwner | null {
  try { return parseOwner(readFileSync(path, 'utf8')) } catch { return null }
}
function holderOf(owner: RepositoryLeaseOwner): RepositoryLeaseHolder {
  return { pid: owner.pid, acquiredAt: owner.acquiredAt, olderBuild: owner.osLock !== true, ...(owner.stoppedGitPids?.length ? { stoppedGitPids: owner.stoppedGitPids } : {}) }
}
/** Protect a live in-process holder even if its heartbeat was delayed. */
const locallyHeldTokens = new Set<string>()

const SQLITE_BUSY = 5
const SQLITE_IOERR = 10
const SQLITE_FULL = 13
const SQLITE_CANTOPEN = 14
/** File errors publishing the lease that may pass (a scanner, a delete still pending on Windows): retried like the lock. */
const PASSING_FILE_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
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
  /** The journal is kept in memory (set once the connection may set it: not while another holds the lock). */
  private memoryJournal = false
  /** Off Windows, the lock file this connection opened, to tell when another file has taken its name since. */
  private opened: { dev: number; ino: number } | undefined
  constructor(private readonly path: string) {}

  /** `locked` once this connection holds the OS lock, `busy` while another connection does. */
  tryLock(): 'locked' | 'busy' {
    // Off Windows a kept connection may have a file that is no longer at the lock path (its folder trashed, or deleted and
    // made again): it is opened again before it tries.
    if (this.db && this.opened && !sameFile(this.opened, fileIdentity(this.path))) this.close()
    try {
      if (!this.db) {
        this.db = new DatabaseSync(sqliteFilePath(this.path), { timeout: 0 })
        this.memoryJournal = false
        this.opened = process.platform === 'win32' ? undefined : fileIdentity(this.path)
      }
      if (!this.memoryJournal) {
        this.db.exec('PRAGMA journal_mode = MEMORY')
        this.memoryJournal = true
      }
      this.db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      const code = sqliteCode(error)
      if (code === SQLITE_BUSY) return 'busy'
      this.close()
      if (code === SQLITE_CANTOPEN || code === SQLITE_IOERR || code === SQLITE_FULL) throw new LockUnavailableError(error)
      throw error
    }
    // Off Windows a lock file can be removed while it is open; a lock on a file no longer at the path excludes nobody.
    if (this.opened && !sameFile(this.opened, fileIdentity(this.path))) {
      this.close()
      return 'busy'
    }
    return 'locked'
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

function fileIdentity(path: string): { dev: number; ino: number } | undefined {
  try { const stat = statSync(path); return { dev: stat.dev, ino: stat.ino } } catch { return undefined }
}
function sameFile(opened: { dev: number; ino: number }, now: { dev: number; ino: number } | undefined): boolean {
  return now !== undefined && now.dev === opened.dev && now.ino === opened.ino
}

/** When the computer last started, as the time now less how long it has run. */
function bootedAt(): number {
  return Date.now() - uptime() * 1000
}

/**
 * When each live process an older build's lease names started (ms), looked up without blocking: a lease taken before
 * its process started names a pid the system gave to another program since. Null when it could not be read.
 */
const processStarts = new Map<number, { at: number | null; lookedAt: number }>()
const PROCESS_START_TTL_MS = 60_000
function processStart(pid: number): number | null | undefined {
  const known = processStarts.get(pid)
  if (known && Date.now() - known.lookedAt < PROCESS_START_TTL_MS) return known.at
  if (!known || Date.now() - known.lookedAt >= PROCESS_START_TTL_MS) {
    processStarts.set(pid, { at: known?.at ?? null, lookedAt: Date.now() })
    lookUpProcessStart(pid).then((at) => processStarts.set(pid, { at, lookedAt: Date.now() }), () => undefined)
  }
  return known ? known.at : undefined
}
function lookUpProcessStart(pid: number): Promise<number | null> {
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]]
    : ['ps', ['-o', 'lstart=', '-p', String(pid)]]
  return new Promise((done) => {
    execFile(file, args as string[], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => {
      const at = error ? Number.NaN : Date.parse(stdout.trim())
      done(Number.isFinite(at) ? at : null)
    })
  })
}

/**
 * What to do with a lease file found while holding the OS lock (so no holder of it can be writing one):
 * - one a holder of the OS lock wrote, complete or not, was left by one that let go of it or ended: it goes at once;
 * - one of an older build goes once its process is gone, and never while it lives, however old its heartbeat;
 * - one nobody can read that does not begin as this build's (empty, or an older build's unfinished record) goes once it
 *   was left so for {@link UNFINISHED_LEASE_MS} (or `staleAfterMs`, if shorter): every build writes its record at once.
 */
function leaseFound(path: string, staleAfterMs: number): { remove: boolean; holder?: RepositoryLeaseHolder } {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { remove: !existsSync(path) } }
  const owner = parseOwner(text)
  if (!owner) {
    if (text.startsWith(OS_LOCK_RECORD_PREFIX)) return { remove: true }
    try { return { remove: Date.now() - statSync(path).mtimeMs > Math.min(staleAfterMs, UNFINISHED_LEASE_MS) } } catch { return { remove: !existsSync(path) } }
  }
  if (locallyHeldTokens.has(owner.token)) return { remove: false, holder: holderOf(owner) }
  if (owner.osLock) return { remove: true }
  if (!isOwnerLive(owner)) return { remove: true }
  // A pid that lives is the lease's process only if that process was running when the lease was taken.
  const acquired = Date.parse(owner.acquiredAt)
  if (Number.isFinite(acquired)) {
    if (acquired < bootedAt() - 60_000) return { remove: true }
    const started = processStart(owner.pid)
    if (typeof started === 'number' && started > acquired + 2_000) return { remove: true }
  }
  return { remove: false, holder: holderOf(owner) }
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
  const staged = join(dirname(path), `${PUBLISH_PREFIX}${token}`)
  writeFileSync(staged, record, { flag: 'wx' })
  try {
    if (!REPOSITORY_LEASE_TIMING.noHardLinks) {
      try {
        linkSync(staged, path)
        return 'published'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'taken'
      }
    }
    try {
      writeFileSync(path, record, { flag: 'wx' })
      return 'published'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'taken'
      // Created and not written: it is this holder's (an older build's would have been there first), so it goes.
      try { if (!readFileSync(path, 'utf8').startsWith('{"pid"')) unlinkSync(path) } catch { /* not created */ }
      throw error
    }
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
    throw PASSING_FILE_ERRORS.has((error as NodeJS.ErrnoException).code ?? '') ? new LockUnavailableError(error) : error
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
  // It runs until release, also while a stopped Git command keeps the lease held, however long that is.
  const refresh = setInterval(heartbeat, opts.heartbeatMs ?? REPOSITORY_LEASE_TIMING.heartbeatMs)
  refresh.unref()
  return {
    handle: {
      identity, path, owner, heartbeat,
      retainFor: (pids) => {
        if (released || !pids.length) return
        owner.stoppedGitPids = [...pids]
        heartbeat()
      },
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
  let unavailableSince: number | undefined
  try {
    while (true) {
      if (waiter.opts.signal?.aborted) throw new RepositoryLeaseAbortedError()
      let attempt: Attempt | undefined
      try {
        attempt = tryAcquire(waiter.identity, waiter.opts, connection)
        unavailableSince = undefined
      } catch (error) {
        if (!(error instanceof LockUnavailableError)) throw error
        waitNotes.set(key, { cause: error.cause })
        // A lock file that stays unusable ends the wait, with or without a limit of the caller's.
        unavailableSince ??= Date.now()
        if (Date.now() - unavailableSince >= REPOSITORY_LEASE_TIMING.unavailableLimitMs) throw busyError(key, getRepositoryLeasePath(waiter.identity))
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
    // What this wait saw goes with its rejection, so a later wait never reports it.
    waiter.reject(error instanceof RepositoryLeaseAbortedError ? Object.assign(error, { busy: busyError(key, getRepositoryLeasePath(waiter.identity)) }) : error instanceof Error ? error : new RepositoryLeaseBusyError())
  } finally {
    if (!granted) connection.close()
    pumping.delete(key)
    if (!queues.has(key)) waitNotes.delete(key)
    if (!locallyHeldKeys.has(key)) void pump(key)
  }
}
function releaseLocal(key: string): void {
  locallyHeldKeys.delete(key)
  void pump(key)
}

/** The busy error for a wait on `key` that ran out: who holds the lease, as last seen, and what last failed. */
function busyError(key: string, leasePath: string): RepositoryLeaseBusyError {
  const local = localHolders.get(key)
  const note = waitNotes.get(key)
  const holder = local ? holderOf(local) : note?.holder
  const failed = note?.cause instanceof Error ? note.cause.message : undefined
  const stopped = stoppedGitText(holder)
  const older = olderBuildText(holder, leasePath)
  const message = stopped
    ? `Repository mutation lease is busy. ${stopped}`
    : ['Repository mutation lease is busy', holder ? `: ${describeLeaseHolder(holder)}` : '', failed ? ` (the lock file could not be used: ${failed})` : '', older ? `. ${older}` : ''].join('')
  return new RepositoryLeaseBusyError(message, { ...(holder ? { holder } : {}), ...(note?.cause !== undefined ? { cause: note.cause } : {}), leasePath })
}

/** Acquire in FIFO order within this process and retry asynchronously across processes. */
export function acquireRepositoryLease(identity: RepositoryIdentity, opts: AcquireRepositoryLeaseOptions = {}): Promise<RepositoryLeaseHandle> {
  requireRepositoryMutationCapability(identity)
  if (opts.signal?.aborted) return Promise.reject(new RepositoryLeaseAbortedError())
  if (opts.maxWaitMs !== undefined) {
    const timeout = AbortSignal.timeout(opts.maxWaitMs)
    const waited = acquireRepositoryLease(identity, { ...opts, maxWaitMs: undefined, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
    return waited.catch((error: unknown) => {
      if (!(error instanceof RepositoryLeaseAbortedError) || !timeout.aborted || opts.signal?.aborted) throw error
      throw (error as RepositoryLeaseAbortedError & { busy?: RepositoryLeaseBusyError }).busy ?? busyError(identity.key, getRepositoryLeasePath(identity))
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
          reject(Object.assign(new RepositoryLeaseAbortedError(), { busy: busyError(identity.key, getRepositoryLeasePath(identity)) }))
        }
      }
      opts.signal.addEventListener('abort', waiter.abort, { once: true })
    }
    const queue = queues.get(identity.key) ?? []; queue.push(waiter); queues.set(identity.key, queue); void pump(identity.key)
  })
}
