/**
 * Length-prefixed JSON framing (4-byte big-endian length + UTF-8 JSON body).
 * Handles fragmented/coalesced reads with a hard max frame size.
 */

import { MMS_PROTOCOL_MAX_FRAME_BYTES } from './types'

export class FrameTooLargeError extends Error {
  constructor(size: number, max = MMS_PROTOCOL_MAX_FRAME_BYTES) {
    super(`Frame size ${size} exceeds max ${max}`)
    this.name = 'FrameTooLargeError'
  }
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameDecodeError'
  }
}

/** Encode a JSON-serializable value as a length-prefixed frame. */
export function encodeFrame(value: unknown, maxBytes = MMS_PROTOCOL_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf-8')
  if (body.length > maxBytes) {
    throw new FrameTooLargeError(body.length, maxBytes)
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * Incremental frame decoder for a duplex stream.
 * Feed buffers via push(); drain complete frames with shift().
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0)
  private readonly maxBytes: number

  constructor(maxBytes = MMS_PROTOCOL_MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes
  }

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    // Reject oversize as soon as the length header is known.
    if (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0)
      if (len > this.maxBytes) {
        this.buffer = Buffer.alloc(0)
        throw new FrameTooLargeError(len, this.maxBytes)
      }
    }
    // Bound total buffer growth for incomplete frames
    if (this.buffer.length > this.maxBytes + 4) {
      this.buffer = Buffer.alloc(0)
      throw new FrameDecodeError('Decode buffer exceeded maximum without a complete frame')
    }
  }

  /** Returns next decoded JSON value, or null if more data needed. */
  shift(): unknown | null {
    if (this.buffer.length < 4) return null
    const len = this.buffer.readUInt32BE(0)
    if (len > this.maxBytes) {
      this.buffer = Buffer.alloc(0)
      throw new FrameTooLargeError(len, this.maxBytes)
    }
    if (this.buffer.length < 4 + len) return null
    const body = this.buffer.subarray(4, 4 + len)
    this.buffer = this.buffer.subarray(4 + len)
    try {
      return JSON.parse(body.toString('utf-8'))
    } catch {
      throw new FrameDecodeError('Malformed JSON frame body')
    }
  }

  /** Drain all complete frames currently buffered. */
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
