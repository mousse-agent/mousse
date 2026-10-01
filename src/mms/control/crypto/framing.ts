/**
 * Canonical relay binary frame encoding and decoding for Control Protocol 2.0.
 * Aligned with docs/WIRE_PROTOCOL.md §5.3.
 *
 * Binary Frame Format:
 * - magic(2 BE) = 0x4D50 ('MP')
 * - version(1) = 1
 * - flags(1) (bit 0x01: FIN, bit 0x02: CONTROL)
 * - length(4 BE) (uint32 length of payload, max 64 KiB)
 * - payload(length)
 */

import {
  CHUNK_MAX_BYTES,
  FRAME_FLAG_CONTROL,
  FRAME_FLAG_FIN,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_MAX_PAYLOAD_BYTES,
  FRAME_VERSION,
  MAX_PLAINTEXT_CHUNK_BYTES,
  MESSAGE_MAX_BYTES
} from '../constants'

export {
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_BYTES,
  FRAME_FLAG_FIN,
  FRAME_FLAG_CONTROL,
  FRAME_MAX_PAYLOAD_BYTES,
  MAX_PLAINTEXT_CHUNK_BYTES
}

export class FrameError extends Error {
  override readonly name = 'FrameError'
}

/**
 * Write an 8-byte canonical frame header into a Uint8Array.
 */
export function writeFrameHeader(
  payloadLength: number,
  flags: number = FRAME_FLAG_FIN
): Uint8Array {
  if (
    !Number.isInteger(payloadLength) ||
    payloadLength < 0 ||
    payloadLength > FRAME_MAX_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      `frame payload length must be 0..${FRAME_MAX_PAYLOAD_BYTES}, got ${payloadLength}`
    )
  }
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xff) {
    throw new RangeError(`frame flags must be a byte, got ${flags}`)
  }
  const header = new Uint8Array(FRAME_HEADER_BYTES)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  view.setUint16(0, FRAME_MAGIC, false)
  view.setUint8(2, FRAME_VERSION)
  view.setUint8(3, flags)
  view.setUint32(4, payloadLength, false)
  return header
}

/**
 * Read and validate an 8-byte frame header from bytes.
 */
export function readFrameHeader(bytes: Uint8Array): {
  magic: number
  version: number
  flags: number
  length: number
} {
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    throw new RangeError(
      `frame header truncated: expected at least ${FRAME_HEADER_BYTES} bytes, got ${bytes.byteLength}`
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint16(0, false)
  const version = view.getUint8(2)
  const flags = view.getUint8(3)
  const length = view.getUint32(4, false)

  if (magic !== FRAME_MAGIC) {
    throw new Error(`invalid frame magic: 0x${magic.toString(16)}`)
  }
  if (version !== FRAME_VERSION) {
    throw new Error(`unsupported frame version: ${version}`)
  }
  if (length > FRAME_MAX_PAYLOAD_BYTES) {
    throw new Error(`frame payload exceeds ${FRAME_MAX_PAYLOAD_BYTES} bytes`)
  }

  return { magic, version, flags, length }
}

/**
 * Encode one complete canonical relay binary frame (header + payload).
 */
export function encodeRelayFrame(
  payload: Uint8Array,
  flags: number = FRAME_FLAG_FIN
): Uint8Array {
  const header = writeFrameHeader(payload.byteLength, flags)
  const out = new Uint8Array(header.byteLength + payload.byteLength)
  out.set(header, 0)
  out.set(payload, header.byteLength)
  return out
}

/**
 * Decode one complete canonical relay binary frame from a WebSocket binary message.
 */
export function decodeRelayFrame(bytes: Uint8Array): {
  flags: number
  payload: Uint8Array
} {
  const header = readFrameHeader(bytes)
  const total = FRAME_HEADER_BYTES + header.length
  if (bytes.byteLength !== total) {
    throw new Error(`frame length mismatch: got ${bytes.byteLength}, expected ${total}`)
  }
  return {
    flags: header.flags,
    payload: bytes.subarray(FRAME_HEADER_BYTES, total)
  }
}

/**
 * Encode frame around payload, verifying max payload limit and non-empty.
 */
export function encodeFrame(
  payload: Uint8Array,
  flags: number = FRAME_FLAG_FIN
): Uint8Array {
  if (payload.byteLength > FRAME_MAX_PAYLOAD_BYTES) {
    throw new FrameError(
      `frame payload ${payload.byteLength} exceeds limit ${FRAME_MAX_PAYLOAD_BYTES}`
    )
  }
  if (payload.byteLength === 0) {
    throw new FrameError('empty frame payload')
  }
  try {
    return encodeRelayFrame(payload, flags)
  } catch (err) {
    throw new FrameError(err instanceof Error ? err.message : 'encode failed')
  }
}

/**
 * Decode one complete relay frame. Rejects truncated, oversized, or empty payloads.
 */
export function decodeFrame(data: Uint8Array): {
  payload: Uint8Array
  flags: number
  bytesConsumed: number
} {
  try {
    const { payload, flags } = decodeRelayFrame(data)
    if (payload.byteLength === 0) {
      throw new FrameError('empty frame payload')
    }
    return {
      payload,
      flags,
      bytesConsumed: data.byteLength
    }
  } catch (err) {
    if (err instanceof FrameError) throw err
    throw new FrameError(err instanceof Error ? err.message : 'decode failed')
  }
}

/**
 * Chunk plaintext application data so ciphertext (with 16-byte Poly1305 tag) fits in <= 64 KiB frame.
 */
export function chunkPlaintext(plaintext: Uint8Array): Uint8Array[] {
  if (plaintext.byteLength === 0) {
    return [new Uint8Array(0)]
  }
  if (plaintext.byteLength > MESSAGE_MAX_BYTES) {
    throw new FrameError(
      `message ${plaintext.byteLength} exceeds limit ${MESSAGE_MAX_BYTES}`
    )
  }
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < plaintext.byteLength; offset += MAX_PLAINTEXT_CHUNK_BYTES) {
    chunks.push(plaintext.subarray(offset, offset + MAX_PLAINTEXT_CHUNK_BYTES))
  }
  return chunks
}

// --- Compatibility helpers for tests and existing callers ---

export const MAX_CHUNK_PAYLOAD_BYTES = MAX_PLAINTEXT_CHUNK_BYTES

export interface ParsedChunk {
  msgId: number
  chunkIndex: number
  totalChunks: number
  payload: Buffer
}

export function chunkMessage(plaintext: Buffer | Uint8Array, msgId: number): Buffer[] {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
  const totalChunks = Math.max(1, Math.ceil(pt.length / MAX_PLAINTEXT_CHUNK_BYTES))
  const chunks: Buffer[] = []
  for (let i = 0; i < totalChunks; i++) {
    const start = i * MAX_PLAINTEXT_CHUNK_BYTES
    const end = Math.min(start + MAX_PLAINTEXT_CHUNK_BYTES, pt.length)
    const payload = pt.subarray(start, end)
    const header = Buffer.alloc(8)
    header.writeUInt32BE(msgId, 0)
    header.writeUInt16BE(i, 4)
    header.writeUInt16BE(totalChunks, 6)
    chunks.push(Buffer.concat([header, payload]))
  }
  return chunks
}

export function parseChunk(raw: Buffer | Uint8Array): ParsedChunk {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (buf.length < 8) {
    throw new Error('Chunk header too short')
  }
  const msgId = buf.readUInt32BE(0)
  const chunkIndex = buf.readUInt16BE(4)
  const totalChunks = buf.readUInt16BE(6)
  const payload = buf.subarray(8)
  return { msgId, chunkIndex, totalChunks, payload }
}

export class MessageReassembler {
  private buffers = new Map<number, { chunks: (Buffer | null)[]; received: number; total: number }>()

  push(chunk: ParsedChunk): Buffer | null {
    let entry = this.buffers.get(chunk.msgId)
    if (!entry) {
      entry = {
        chunks: new Array(chunk.totalChunks).fill(null),
        received: 0,
        total: chunk.totalChunks
      }
      this.buffers.set(chunk.msgId, entry)
    }
    if (entry.chunks[chunk.chunkIndex] === null) {
      entry.chunks[chunk.chunkIndex] = Buffer.from(chunk.payload)
      entry.received++
    }
    if (entry.received === entry.total) {
      this.buffers.delete(chunk.msgId)
      return Buffer.concat(entry.chunks as Buffer[])
    }
    return null
  }
}

