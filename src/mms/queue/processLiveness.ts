/**
 * Cross-platform process liveness and process-instance identity for lock recovery.
 * Deterministic only — no agent/LLM involvement.
 *
 * Cross-process PID-reuse protection is intentionally limited: foreign live PIDs are
 * treated as live (fail closed). Same-process restarts are distinguished via
 * PROCESS_INSTANCE_ID when the recorded owner pid is ours.
 */

import { randomBytes } from 'crypto'
import { existsSync, statSync } from 'fs'

/**
 * Opaque identity of this process instance (survives only for this OS process).
 * Distinguishes a restarted process that reused the same PID from the prior owner
 * when the recorded owner pid is this process.
 */
export const PROCESS_INSTANCE_ID = randomBytes(16).toString('hex')

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  // Our own process is always alive (avoids false negatives under rare race conditions).
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : ''
    // EPERM: process exists but we cannot signal it — treat as alive.
    if (code === 'EPERM') return true
    // ESRCH / EINVAL: no such process (or invalid pid).
    return false
  }
}

/** Minimal owner fields used for deterministic liveness checks. */
export interface ProcessOwnerRef {
  pid: number
  /** Process instance id recorded when the lock/claim was taken. */
  processInstanceId?: string
  /** Optional last heartbeat ISO timestamp for deadline-based reclaim. */
  heartbeatAt?: string
}

/**
 * True when the recorded owner is demonstrably still the live holder.
 * - Dead PIDs are never live.
 * - Same PID as us but a different processInstanceId (our restart) is not live.
 * - Foreign live PIDs are treated live (fail closed) unless heartbeat is past staleHeartbeatMs.
 *   No cross-platform foreign PID-reuse detection is claimed here.
 */
export function isOwnerLive(
  owner: ProcessOwnerRef,
  opts?: { staleHeartbeatMs?: number }
): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false

  // Our process: only live if the recorded instance id matches (or is absent on legacy locks).
  if (owner.pid === process.pid) {
    if (
      owner.processInstanceId &&
      owner.processInstanceId !== PROCESS_INSTANCE_ID
    ) {
      return false
    }
    return true
  }

  if (!isProcessAlive(owner.pid)) return false

  // Foreign live PID with optional heartbeat deadline (long-running holders must refresh).
  if (opts?.staleHeartbeatMs != null && owner.heartbeatAt) {
    const hb = Date.parse(owner.heartbeatAt)
    if (Number.isFinite(hb) && Date.now() - hb > opts.staleHeartbeatMs) {
      return false
    }
  }

  return true
}

/** File mtime in ms, or null if unavailable. */
export function getFileMtimeMs(path: string): number | null {
  try {
    if (!existsSync(path)) return null
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Age of a lock file in ms from mtime (null if unknown). */
export function getFileAgeMs(path: string, nowMs = Date.now()): number | null {
  const mtime = getFileMtimeMs(path)
  if (mtime == null) return null
  return Math.max(0, nowMs - mtime)
}
