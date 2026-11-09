/**
 * A hold on a thread's queue, saved next to `queue.json` (`queue-hold.json`): while a compaction of the
 * thread runs, no drain may start a queued message, so nothing is sent with the history the compaction is
 * about to replace. It is a file so that every process that drains the thread's queue (another window's
 * daemon, the CLI) sees it, and a restart finds it.
 *
 * The hold names the process that set it. A hold whose process is gone (a crash, a restart) holds nothing;
 * the next reader removes it.
 */

import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { isProcessAlive, PROCESS_INSTANCE_ID } from './processLiveness'
import { withQueueMutationLock } from './ThreadExecutionLease'

export const QUEUE_HOLD_FILENAME = 'queue-hold.json'

export interface QueueHold {
  /** What holds the queue: a compaction of the thread's context. */
  kind: 'compaction'
  /** The compaction's row in the conversation. */
  id: string
  since: string
  ownerPid: number
  /** The owner process instance: tells a restarted process that reused the pid from the one that set the hold. */
  ownerInstance: string
}

export function getQueueHoldPath(threadDir: string): string {
  return join(threadDir, QUEUE_HOLD_FILENAME)
}

function isQueueHold(value: unknown): value is QueueHold {
  if (!value || typeof value !== 'object') return false
  const hold = value as Partial<QueueHold>
  return hold.kind === 'compaction' && typeof hold.id === 'string' && typeof hold.since === 'string' &&
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
export function setQueueHold(threadDir: string, input: { kind: 'compaction'; id: string }): QueueHold {
  const hold: QueueHold = { ...input, since: new Date().toISOString(), ownerPid: process.pid, ownerInstance: PROCESS_INSTANCE_ID }
  withQueueMutationLock(threadDir, () => atomicWriteJsonSync(getQueueHoldPath(threadDir), hold))
  return hold
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
 * Whether the hold still holds: its process is alive and still runs it. For a hold this process set, only the
 * caller knows whether it still runs (`ownRunning`); a hold left by an earlier process with the same pid holds nothing.
 */
export function isQueueHoldLive(hold: QueueHold, ownRunning: (hold: QueueHold) => boolean): boolean {
  if (hold.ownerInstance === PROCESS_INSTANCE_ID) return ownRunning(hold)
  if (hold.ownerPid === process.pid) return false
  return isProcessAlive(hold.ownerPid)
}
