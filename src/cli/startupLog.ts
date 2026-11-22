import { fstatSync, renameSync, statSync } from 'fs'

/**
 * `<home>/mms-startup.log` takes the stdout and stderr of a daemon the app starts, for that daemon's whole life.
 * It stays bounded two ways: the app moves an oversized file aside before each start, and the daemon stops
 * writing to it once its share of the cap is used. `logs/daemon.log` keeps every diagnostic line either way.
 */
export const STARTUP_LOG_FILE = 'mms-startup.log'
export const STARTUP_LOG_MAX_BYTES = 1024 * 1024
/** Set by the app on the daemon it starts: the byte cap of the file its stdout and stderr go to. */
export const STARTUP_LOG_CAP_ENV = 'MOUSSE_STARTUP_LOG_MAX_BYTES'

/** Before a start: an oversized log becomes `<path>.1` (replacing the previous one). Never throws. */
export function rotateStartupLogSync(path: string, maxBytes = STARTUP_LOG_MAX_BYTES): void {
  try {
    if (statSync(path).size < maxBytes) return
    renameSync(path, `${path}.1`)
  } catch {
    // Missing file, or a rename the OS refused: the daemon's own cap still bounds what it adds.
  }
}

type WriteFn = (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean

interface WritableLike {
  write: WriteFn
}

/**
 * Lets the given streams write at most `budgetBytes` in total, then one notice line, then nothing.
 * Dropped writes still call their callback so callers never wait on them.
 */
export function capStreamOutput(streams: WritableLike[], budgetBytes: number, notice: string): void {
  const noticeLine = notice.endsWith('\n') ? notice : `${notice}\n`
  let remaining = Math.max(0, budgetBytes - Buffer.byteLength(noticeLine))
  let full = false
  for (const stream of streams) {
    const original = stream.write.bind(stream) as WriteFn
    stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      if (!full) {
        const bytes = typeof chunk === 'string'
          ? Buffer.byteLength(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
          : (chunk as Uint8Array).byteLength
        if (bytes <= remaining) {
          remaining -= bytes
          return original(chunk, encoding, callback)
        }
        full = true
        original(noticeLine)
      }
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') process.nextTick(done as () => void)
      return true
    }) as WriteFn
  }
}

/**
 * In a daemon the app started: cap its stdout and stderr by what is left of the startup log's cap.
 * The variable is dropped so programs the daemon starts do not inherit it.
 */
export function capDaemonStartupOutput(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env[STARTUP_LOG_CAP_ENV]
  delete env[STARTUP_LOG_CAP_ENV]
  const cap = raw ? Number(raw) : NaN
  if (!Number.isFinite(cap) || cap <= 0) return
  let used = 0
  try {
    const stat = fstatSync(1)
    if (!stat.isFile()) return
    used = stat.size
  } catch {
    return
  }
  capStreamOutput(
    [process.stdout, process.stderr] as unknown as WritableLike[],
    cap - used,
    `${new Date().toISOString()} [mousse] ${STARTUP_LOG_FILE} reached its size cap; further output goes to logs/daemon.log only`
  )
}
