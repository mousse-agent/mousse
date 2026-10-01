/** Length-prefixed JSON framing for MMS ↔ browser-worker IPC (4-byte big-endian). Distinct from CDP ASCIIZ. */

export const BROWSER_WORKER_MAX_FRAME_BYTES = 16 * 1024 * 1024

export class WorkerFrameTooLargeError extends Error {
  constructor(size: number, max = BROWSER_WORKER_MAX_FRAME_BYTES) {
    super(`Worker frame size ${size} exceeds max ${max}`)
    this.name = 'WorkerFrameTooLargeError'
  }
}

export class WorkerFrameDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerFrameDecodeError'
  }
}

export function encodeWorkerFrame(value: unknown, maxBytes = BROWSER_WORKER_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf-8')
  if (body.length > maxBytes) throw new WorkerFrameTooLargeError(body.length, maxBytes)
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

export class WorkerFrameDecoder {
  private buffer = Buffer.alloc(0)
  constructor(private readonly maxBytes = BROWSER_WORKER_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    if (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0)
      if (len > this.maxBytes) {
        this.buffer = Buffer.alloc(0)
        throw new WorkerFrameTooLargeError(len, this.maxBytes)
      }
    }
    if (this.buffer.length > this.maxBytes + 4) {
      this.buffer = Buffer.alloc(0)
      throw new WorkerFrameDecodeError('Decode buffer exceeded maximum without a complete frame')
    }
  }

  shift(): unknown | null {
    if (this.buffer.length < 4) return null
    const len = this.buffer.readUInt32BE(0)
    if (len > this.maxBytes) {
      this.buffer = Buffer.alloc(0)
      throw new WorkerFrameTooLargeError(len, this.maxBytes)
    }
    if (this.buffer.length < 4 + len) return null
    const body = this.buffer.subarray(4, 4 + len)
    this.buffer = this.buffer.subarray(4 + len)
    try {
      return JSON.parse(body.toString('utf-8'))
    } catch {
      throw new WorkerFrameDecodeError('Malformed JSON frame body')
    }
  }

  shiftAll(): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const next = this.shift()
      if (next === null) break
      out.push(next)
    }
    return out
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }

  get pendingBytes(): number {
    return this.buffer.length
  }
}
