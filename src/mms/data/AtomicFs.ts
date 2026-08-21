import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AtomicWriteOptions {
  maxAttempts?: number
  initialDelayMs?: number
  /** Permission bits applied to the temp file so secrets are never world-readable mid-write. */
  mode?: number
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, ms)
}

function retryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

export function fsyncDirectorySync(directory: string): void {
  let fd: number | undefined
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is unsupported on some Windows/filesystem combinations.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function renameWithRetrySync(source: string, target: string, options: AtomicWriteOptions): void {
  const attempts = Math.max(1, options.maxAttempts ?? 6)
  const initialDelay = Math.max(1, options.initialDelayMs ?? 8)
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (!retryable(error) || attempt + 1 >= attempts) throw error
      sleepSync(initialDelay * 2 ** attempt)
    }
  }
}

/** Same-directory durable replacement: write, file fsync, rename, parent fsync. */
export function atomicWriteFileSync(
  filePath: string,
  value: string | Uint8Array,
  options: AtomicWriteOptions = {}
): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', options.mode)
    writeFileSync(fd, value)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameWithRetrySync(temporary, filePath, options)
    fsyncDirectorySync(directory)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* preserve original failure */ }
    throw error
  }
}

export function atomicWriteJsonSync(filePath: string, value: unknown, options?: AtomicWriteOptions): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options)
}

/** Create an immutable file and fsync both it and its parent directory. */
export function durableExclusiveWriteSync(filePath: string, value: string | Uint8Array): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true })
  const fd = openSync(filePath, 'wx')
  try {
    writeFileSync(fd, value)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDirectorySync(directory)
}
