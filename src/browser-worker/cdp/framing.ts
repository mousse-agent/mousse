/**
 * Chromium --remote-debugging-pipe default framing: ASCIIZ (NUL-terminated JSON).
 * Confirmed against Chromium DevToolsPipeHandler ProtocolMode::kASCIIZ
 * (content/browser/devtools/devtools_pipe_handler.cc). CBOR mode is not used.
 */

export const CDP_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export class CdpFrameTooLargeError extends Error {
  constructor(size: number) {
    super(`CDP message size ${size} exceeds max ${CDP_MAX_MESSAGE_BYTES}`)
    this.name = 'CdpFrameTooLargeError'
  }
}

export class CdpFrameDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdpFrameDecodeError'
  }
}

export function encodeCdpMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf-8')
  if (body.length > CDP_MAX_MESSAGE_BYTES) throw new CdpFrameTooLargeError(body.length)
  return Buffer.concat([body, Buffer.from([0])])
}

export class CdpAsciiDecoder {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > CDP_MAX_MESSAGE_BYTES + 1) {
      this.buffer = Buffer.alloc(0)
      throw new CdpFrameTooLargeError(CDP_MAX_MESSAGE_BYTES + 1)
    }
  }

  shift(): unknown | null {
    const idx = this.buffer.indexOf(0)
    if (idx < 0) {
      if (this.buffer.length > CDP_MAX_MESSAGE_BYTES) {
        this.buffer = Buffer.alloc(0)
        throw new CdpFrameTooLargeError(this.buffer.length)
      }
      return null
    }
    const body = this.buffer.subarray(0, idx)
    this.buffer = this.buffer.subarray(idx + 1)
    if (body.length > CDP_MAX_MESSAGE_BYTES) throw new CdpFrameTooLargeError(body.length)
    try {
      return JSON.parse(body.toString('utf-8'))
    } catch {
      throw new CdpFrameDecodeError('Malformed CDP JSON message')
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
