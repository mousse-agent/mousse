import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { appendFile, mkdir, rename, rm, stat } from 'fs/promises'
import { dirname } from 'path'

export interface RotatingFileLogOptions {
  path: string
  /** Rotate when the active file would grow beyond this many bytes. */
  maxBytes?: number
  /** Number of rotated files to keep (path.1 .. path.N). */
  keep?: number
  /** Buffer window before an async flush, in ms. */
  flushIntervalMs?: number
}

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_LOG_KEEP = 3

/**
 * Small buffered, size-bounded log file. Lines are queued and appended
 * asynchronously so callers never block the event loop; flushSync drains the
 * buffer on process exit.
 */
export class RotatingFileLog {
  private readonly path: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly flushIntervalMs: number
  private buffer: string[] = []
  private timer: NodeJS.Timeout | null = null
  private size: number | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(options: RotatingFileLogOptions) {
    this.path = options.path
    this.maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES
    this.keep = options.keep ?? DEFAULT_LOG_KEEP
    this.flushIntervalMs = options.flushIntervalMs ?? 50
  }

  write(line: string): void {
    this.buffer.push(line.endsWith('\n') ? line : `${line}\n`)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, this.flushIntervalMs)
      this.timer.unref()
    }
  }

  /** Flush queued lines asynchronously; resolves when the write chain is idle. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.chain = this.chain.then(() => this.drain()).catch(() => undefined)
    return this.chain
  }

  /** Synchronously drain the buffer (process exit paths). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const chunk = this.buffer.join('')
    this.buffer = []
    if (!chunk) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      if (this.size === null) this.size = safeSizeSync(this.path)
      if (this.size > 0 && this.size + Buffer.byteLength(chunk) > this.maxBytes) {
        this.rotateSync()
        this.size = 0
      }
      appendFileSync(this.path, chunk)
      this.size += Buffer.byteLength(chunk)
    } catch {
      // Diagnostics must never take the process down.
    }
  }

  private async drain(): Promise<void> {
    const chunk = this.buffer.join('')
    this.buffer = []
    if (!chunk) return
    try {
      await mkdir(dirname(this.path), { recursive: true })
      if (this.size === null) this.size = await safeSize(this.path)
      const bytes = Buffer.byteLength(chunk)
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        await this.rotate()
        this.size = 0
      }
      await appendFile(this.path, chunk)
      this.size += bytes
    } catch {
      // Diagnostics must never take the process down.
    }
  }

  private async rotate(): Promise<void> {
    await rm(`${this.path}.${this.keep}`, { force: true })
    for (let i = this.keep - 1; i >= 1; i--) {
      await rename(`${this.path}.${i}`, `${this.path}.${i + 1}`).catch(() => undefined)
    }
    await rename(this.path, `${this.path}.1`).catch(() => undefined)
  }

  private rotateSync(): void {
    rmSync(`${this.path}.${this.keep}`, { force: true })
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`)
      } catch {
        // missing rotation slot
      }
    }
    try {
      renameSync(this.path, `${this.path}.1`)
    } catch {
      // nothing to rotate
    }
  }
}

async function safeSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

function safeSizeSync(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
