/**
 * A cross-process ADVISORY file lock that may be held across `await`.
 *
 * It gives mutual exclusion in the normal case (one refresh at a time, one install at a time), but
 * no file lock can guarantee it: a holder suspended past `maxHoldMs` resumes as if it still held
 * the lock, and the rare races documented at `removeIfSame` remain. Callers that need correctness
 * must make their commit conditional on what they read (the ChatGPT store's
 * `UPDATE … WHERE revision = ?`), and treat a lost race as "read again".
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
 * and leaves it alone. The final removal is itself conditional (`removeIfSame`): the file is
 * renamed aside, checked, and linked back if it is not the stale one, so a reclaimer paused between
 * its check and its removal puts back a lock that replaced the stale one meanwhile.
 * Markers are held for a synchronous moment; a marker left by a crashed reclaimer is itself
 * reclaimed the same way (older than 30 s). Past eight levels of crashed markers, the deepest dead
 * marker is removed conditionally without a further marker, so repeated crashes never pin a lock.
 *
 * A lease cannot stop a suspended process (laptop sleep, a debugger) from resuming after
 * `maxHoldMs` and acting as if it still held the lock. Callers that need correctness, not just
 * mutual exclusion, must check a revision of their state before each write.
 * An OS mutex would be simpler, but Node has no portable one: named pipes free themselves only on
 * Windows, and a stale Unix socket file needs the same unsafe unlink.
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isOwnerLive, isProcessAlive, PROCESS_INSTANCE_ID } from '../queue/processLiveness'
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
/**
 * Each level of markers needs another reclaimer to crash at a synchronous instant. Past this many,
 * a dead marker is removed by the conditional removal alone (see `removeIfSame`).
 */
const RECLAIM_DEPTH = 8
let reclaimDepth = RECLAIM_DEPTH

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

/** Tests only: runs at each step of a reclaim, so a test can interleave reclaimers. */
let reclaimHook: ((step: 'checked' | 'marked' | 'removing' | 'releasing', path: string) => void) | null = null
export function setReclaimHookForTests(hook: typeof reclaimHook): void {
  reclaimHook = hook
}

/** Tests only: lowers the marker depth, to reach the fallback without crashing eight reclaimers. */
export function setReclaimDepthForTests(depth: number | null): void {
  reclaimDepth = depth ?? RECLAIM_DEPTH
}

/** The marker that guards removing the file at `path` whose identity is `key`. Fixed length at every depth. */
function markerFor(root: string, path: string, key: string): string {
  return `${root}.reclaim-${createHash('sha256').update(`${path}\0${key}`).digest('hex').slice(0, 16)}`
}

/**
 * Removes the file at `path` only if it is still the file `key` names, as close to atomically as a
 * portable file system allows: it is renamed to a unique name, checked, and put back with a hard
 * link (which fails rather than overwrite) when it turns out to be another file. A rename moves
 * exactly one file, so the check sees what was actually taken.
 *
 * Residual: if the file was another live lock and a third process creates a lock in the instant
 * between the rename and the link-back, the moved owner keeps running without its file. Closing
 * that needs compare-and-delete, which file systems do not offer. Callers that write shared state
 * under the lock must therefore check a revision of that state before each write (the ChatGPT
 * store does), so a holder that lost its lock this way, or was suspended past `maxHoldMs`, cannot
 * overwrite anything.
 */
function removeIfSame(path: string, key: string, notify = true): boolean {
  if (notify) reclaimHook?.('removing', path)
  const moved = `${path}.${process.pid}.${randomBytes(6).toString('hex')}${REMOVED_SUFFIX}`
  try {
    renameSync(path, moved)
  } catch {
    return false
  }
  if (snapshot(moved)?.key === key) {
    try { unlinkSync(moved) } catch { /* removed from the lock's name already */ }
    return true
  }
  try {
    linkSync(moved, path)
  } catch (error) {
    // No hard links on this file system: put it back only while the name is still free.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && !existsSync(path)) {
      try { renameSync(moved, path); return false } catch { /* fall through to cleanup */ }
    }
  }
  try { unlinkSync(moved) } catch { /* already gone */ }
  return false
}

/**
 * Removes the file at `path` if it is stale, exclusively (see the header). True only when this call
 * removed it; a file that vanished on its own is retried after the normal poll pause, so a Windows
 * delete-pending name never turns the wait into a busy loop.
 */
function reclaim(root: string, path: string, maxHoldMs: number | undefined, depth = 0): boolean {
  const snap = snapshot(path)
  if (!snap) return false
  if (!isStale(path, snap, maxHoldMs)) return false
  reclaimHook?.('checked', path)
  // Beyond the marker depth only crashed reclaimers' markers remain: remove this one conditionally.
  if (depth >= reclaimDepth) return removeIfSame(path, snap.key)
  const marker = markerFor(root, path, snap.key)
  let held = tryCreate(marker)
  if (!held) {
    if (!reclaim(root, marker, MARKER_STALE_MS, depth + 1)) return false
    held = tryCreate(marker)
    if (!held) return false
  }
  try {
    reclaimHook?.('marked', path)
    const again = snapshot(path)
    if (!again || again.key !== snap.key) return false
    return removeIfSame(path, snap.key)
  } catch {
    return false
  } finally {
    release(marker, held.token)
  }
}

/** Tests only: one acquisition attempt (reclaim, then create). Returns the owner token or null. */
export function tryAcquireOnceForTests(lockPath: string, maxHoldMs?: number): string | null {
  const created = tryCreate(lockPath) ?? (reclaim(lockPath, lockPath, maxHoldMs) ? tryCreate(lockPath) : null)
  return created?.token ?? null
}

/** Deletes the lock file only while it still carries our token. */
/**
 * Releases a lock (or marker) only while it still carries our token, with the same conditional
 * removal as a reclaim: a holder paused after its check, whose lock was reclaimed and replaced
 * meanwhile, puts the replacement back instead of deleting it.
 */
function release(lockPath: string, token: string): void {
  if (readFileLockOwner(lockPath)?.token !== token) return
  reclaimHook?.('releasing', lockPath)
  removeIfSame(lockPath, `token:${token}`, false)
}

/** Tests only: releases a lock taken with `tryAcquireOnceForTests`. */
export function releaseForTests(lockPath: string, token: string): void {
  release(lockPath, token)
}

const REMOVED_SUFFIX = '.removed'
const REMOVED_NAME = /\.(\d+)\.[0-9a-f]{12}\.removed$/

/**
 * Deletes files a conditional removal set aside and never cleaned up because its process died in
 * between. Only names whose process is gone (or is this one, which never sweeps while it removes)
 * are touched, so a removal in flight in another process is left alone.
 */
function sweepRemoved(lockPath: string): void {
  const directory = dirname(lockPath)
  const prefix = basename(lockPath)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    // `<lock>.<pid>.<hex>.removed`, and the same for its reclaim markers `<lock>.reclaim-<id>.…`.
    const match = REMOVED_NAME.exec(name)
    if (!name.startsWith(prefix) || !match) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || (pid !== process.pid && isProcessAlive(pid))) continue
    try { unlinkSync(join(directory, name)) } catch { /* gone already */ }
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
  sweepRemoved(lockPath)
  for (;;) {
    signal.throwIfAborted()
    const owner = tryCreate(lockPath)
    if (owner) return owner
    if (reclaim(lockPath, lockPath, maxHoldMs)) continue
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
