/**
 * A hold on a thread's queue, saved next to `queue.json` (`queue-hold.json`): while a compaction of the
 * thread runs, no drain may start a queued message, so nothing is sent with the history the compaction is
 * about to replace. It is a file so that every process that drains the thread's queue (another window's
 * daemon, the CLI) sees it, and a restart finds it.
 *
 * The hold names the process that set it, which renews it every `QUEUE_HOLD_RENEW_MS` while the compaction
 * runs. A hold whose process is gone (a crash, a restart), or that nobody renewed for `QUEUE_HOLD_STALE_MS`
 * (its process hung, or the pid now belongs to another program), holds nothing; the next reader removes it.
 *
 * Another process asks the owner to stop the compaction through the hold (`stopRequested`, Send now on a
 * held message there); the owner reads it when it renews the hold and stops as a Stop would. Before the owner
 * takes the compaction's result it checks the hold once more and marks it `taken`, under the queue lock: a request
 * made before that stops the compaction, one made after is too late (the compaction had ended).
 */

import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { isProcessAlive, PROCESS_INSTANCE_ID } from './processLiveness'
import { withQueueMutationLock } from './ThreadExecutionLease'

export const QUEUE_HOLD_FILENAME = 'queue-hold.json'
/** How often the process that set a hold renews it. */
export const QUEUE_HOLD_RENEW_MS = 10_000
/** A hold not renewed for this long holds nothing, whatever process it names. */
export const QUEUE_HOLD_STALE_MS = 45_000

export interface QueueHold {
  /** What holds the queue: a compaction of the thread's context. */
  kind: 'compaction'
  /** The compaction's row in the conversation. */
  id: string
  since: string
  /** When the owner last renewed the hold; `since` for a hold saved before holds were renewed. */
  renewedAt?: string
  ownerPid: number
  /** The owner process instance: tells a restarted process that reused the pid from the one that set the hold. */
  ownerInstance: string
  /** Another process asked the owner to stop the compaction (Send now on a held message). */
  stopRequested?: true
  /** The owner took the compaction's result: the hold lifts once it is saved, and a stop comes too late. */
  taken?: true
}

export function getQueueHoldPath(threadDir: string): string {
  return join(threadDir, QUEUE_HOLD_FILENAME)
}

function isQueueHold(value: unknown): value is QueueHold {
  if (!value || typeof value !== 'object') return false
  const hold = value as Partial<QueueHold>
  return hold.kind === 'compaction' && typeof hold.id === 'string' && typeof hold.since === 'string' &&
    (hold.renewedAt === undefined || typeof hold.renewedAt === 'string') &&
    (hold.stopRequested === undefined || hold.stopRequested === true) &&
    (hold.taken === undefined || hold.taken === true) &&
    typeof hold.ownerPid === 'number' && typeof hold.ownerInstance === 'string'
}

/**
 * The saved hold, or null. A file that cannot be read or parsed holds nothing: the writes are atomic, so it is
 * not a hold being written, and a hold nobody can read could never be lifted.
 */
export function readQueueHold(threadDir: string): QueueHold | null {
  const path = getQueueHoldPath(threadDir)
  if (!existsSync(path)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isQueueHold(value) ? value : null
  } catch {
    return null
  }
}

/** Saves a hold this process owns, under the queue lock: a drain claiming now sees the queue before or after it. */
export function setQueueHold(threadDir: string, input: { kind: 'compaction'; id: string }, now = Date.now()): QueueHold {
  const at = new Date(now).toISOString()
  const hold: QueueHold = { ...input, since: at, renewedAt: at, ownerPid: process.pid, ownerInstance: PROCESS_INSTANCE_ID }
  withQueueMutationLock(threadDir, () => atomicWriteJsonSync(getQueueHoldPath(threadDir), hold))
  return hold
}

/**
 * Renews the hold `id` this process set, and returns it as saved. Null when it is no longer there: a reader
 * found it stale and lifted it (the queue may have gone on), or another hold replaced it.
 */
export function renewQueueHold(threadDir: string, id: string, now = Date.now()): QueueHold | null {
  return withQueueMutationLock(threadDir, () => {
    const hold = readQueueHold(threadDir)
    if (!hold || hold.id !== id || hold.ownerInstance !== PROCESS_INSTANCE_ID) return null
    const renewed: QueueHold = { ...hold, renewedAt: new Date(now).toISOString() }
    atomicWriteJsonSync(getQueueHoldPath(threadDir), renewed)
    return renewed
  })
}

/**
 * Asks the process that set the hold `id` to stop its compaction: the request is saved on the hold, which that
 * process reads when it next renews it. `taken` when the compaction's result was already taken (too late to stop),
 * `gone` when the hold is no longer there.
 */
export function requestQueueHoldStop(threadDir: string, id: string): 'requested' | 'taken' | 'gone' {
  return withQueueMutationLock(threadDir, () => {
    const hold = readQueueHold(threadDir)
    if (!hold || hold.id !== id) return 'gone'
    if (hold.taken) return 'taken'
    if (!hold.stopRequested) atomicWriteJsonSync(getQueueHoldPath(threadDir), { ...hold, stopRequested: true })
    return 'requested'
  })
}

/**
 * The owner of the hold `id` takes its compaction's result, under the queue lock: `taken` when the hold is still
 * its own and nobody asked it to stop (the hold is marked so, and renewed); `stop_requested` when another process
 * asked it to stop; `gone` when the hold was lifted (found stale) or replaced. Only `taken` lets the result stand.
 */
export function takeQueueHold(threadDir: string, id: string, now = Date.now()): 'taken' | 'stop_requested' | 'gone' {
  return withQueueMutationLock(threadDir, () => {
    const hold = readQueueHold(threadDir)
    if (!hold || hold.id !== id || hold.ownerInstance !== PROCESS_INSTANCE_ID) return 'gone'
    if (hold.stopRequested) return 'stop_requested'
    atomicWriteJsonSync(getQueueHoldPath(threadDir), { ...hold, renewedAt: new Date(now).toISOString(), taken: true })
    return 'taken'
  })
}

/** Lifts the hold `id` (any hold when `id` is omitted); a newer hold someone else set stays. Returns whether one was lifted. */
export function clearQueueHold(threadDir: string, id?: string): boolean {
  return withQueueMutationLock(threadDir, () => {
    const path = getQueueHoldPath(threadDir)
    if (!existsSync(path)) return false
    const hold = readQueueHold(threadDir)
    if (id !== undefined && hold && hold.id !== id) return false
    rmSync(path, { force: true })
    return true
  })
}

/**
 * Lifts the hold `id` found stale, unless, read again under the lock, it holds after all (its owner renewed it
 * meanwhile). Returns whether it was lifted.
 */
export function clearStaleQueueHold(threadDir: string, id: string, isLive: (hold: QueueHold) => boolean): boolean {
  return withQueueMutationLock(threadDir, () => {
    const hold = readQueueHold(threadDir)
    if (hold && (hold.id !== id || isLive(hold))) return false
    if (!existsSync(getQueueHoldPath(threadDir))) return false
    rmSync(getQueueHoldPath(threadDir), { force: true })
    return true
  })
}

/**
 * Whether the hold still holds. For a hold this process set, only the caller knows whether it still runs
 * (`ownRunning`); a hold left by an earlier process with the same pid holds nothing. Any other hold holds while it
 * was renewed within `QUEUE_HOLD_STALE_MS` of `now` and its process is alive.
 */
export function isQueueHoldLive(hold: QueueHold, ownRunning: (hold: QueueHold) => boolean, now = Date.now()): boolean {
  if (hold.ownerInstance === PROCESS_INSTANCE_ID) return ownRunning(hold)
  if (hold.ownerPid === process.pid) return false
  const renewedAt = Date.parse(hold.renewedAt ?? hold.since)
  if (!(now - renewedAt < QUEUE_HOLD_STALE_MS)) return false
  return isProcessAlive(hold.ownerPid)
}
