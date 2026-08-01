/**
 * Cross-platform process liveness probe for lease/stale-lock recovery.
 * Uses Node's signal-0 check (works on Windows and POSIX).
 */

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
