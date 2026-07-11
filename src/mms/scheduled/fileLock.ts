import { closeSync, openSync, unlinkSync, writeSync } from 'fs'

const lockDepth = new Map<string, number>()

function sleepMs(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* spin */
  }
}

export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const depth = lockDepth.get(lockPath) ?? 0
  if (depth > 0) {
    lockDepth.set(lockPath, depth + 1)
    try {
      return fn()
    } finally {
      lockDepth.set(lockPath, depth)
    }
  }

  let fd: number | null = null
  const maxAttempts = 50
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      break
    } catch {
      if (attempt === maxAttempts - 1) {
        return fn()
      }
      sleepMs(20)
    }
  }

  lockDepth.set(lockPath, 1)
  try {
    return fn()
  } finally {
    lockDepth.delete(lockPath)
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
    }
  }
}

export function tryAcquireTickLock(lockPath: string): (() => void) | null {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, String(process.pid))
    return () => {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
    }
  } catch {
    return null
  }
}
