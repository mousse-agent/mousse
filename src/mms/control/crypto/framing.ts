/**
 * Chunking and reassembly framing for Control Protocol 2.0.
 *
 * Wire chunk header (8 bytes):
 * - msgId (uint32be, 4 bytes)
 * - chunkIndex (uint16be, 2 bytes)
 * - totalChunks (uint16be, 2 bytes)
 * Followed by raw chunk payload (<= 64 KiB).
 */

import { CHUNK_MAX_BYTES, MESSAGE_MAX_BYTES } from '../constants'

export const FRAME_HEADER_BYTES = 8
export const MAX_CHUNK_PAYLOAD_BYTES = CHUNK_MAX_BYTES - FRAME_HEADER_BYTES

export interface FrameChunk {
  msgId: number
  chunkIndex: number
  totalChunks: number
  payload: Buffer
}

/**
 * Split an application message buffer into framed chunks <= 64 KiB.
 */
export function chunkMessage(message: Buffer | Uint8Array, msgId: number): Buffer[] {
  const msgBuf = Buffer.from(message)
  if (msgBuf.length > MESSAGE_MAX_BYTES) {
    throw new Error(
      `Message size ${msgBuf.length} exceeds maximum application message size ${MESSAGE_MAX_BYTES}`
    )
  }

  const totalChunks = Math.max(1, Math.ceil(msgBuf.length / MAX_CHUNK_PAYLOAD_BYTES))
  if (totalChunks > 65535) {
    throw new Error(`Total chunks ${totalChunks} exceeds 16-bit bound`)
  }

  const chunks: Buffer[] = []
  for (let i = 0; i < totalChunks; i++) {
    const start = i * MAX_CHUNK_PAYLOAD_BYTES
    const end = Math.min(start + MAX_CHUNK_PAYLOAD_BYTES, msgBuf.length)
    const slice = msgBuf.subarray(start, end)

    const chunkBuf = Buffer.alloc(FRAME_HEADER_BYTES + slice.length)
    chunkBuf.writeUInt32BE(msgId >>> 0, 0)
    chunkBuf.writeUInt16BE(i, 4)
    chunkBuf.writeUInt16BE(totalChunks, 6)
    slice.copy(chunkBuf, FRAME_HEADER_BYTES)

    chunks.push(chunkBuf)
  }

  return chunks
}

/**
 * Parse a raw binary frame into its header and payload slice.
 */
export function parseChunk(frame: Buffer | Uint8Array): FrameChunk {
  const buf = Buffer.from(frame)
  if (buf.length < FRAME_HEADER_BYTES) {
    throw new Error(`Frame length ${buf.length} is shorter than header size ${FRAME_HEADER_BYTES}`)
  }
  if (buf.length > CHUNK_MAX_BYTES) {
    throw new Error(`Frame length ${buf.length} exceeds max chunk size ${CHUNK_MAX_BYTES}`)
  }

  const msgId = buf.readUInt32BE(0)
  const chunkIndex = buf.readUInt16BE(4)
  const totalChunks = buf.readUInt16BE(6)

  if (totalChunks === 0) {
    throw new Error('Frame totalChunks cannot be zero')
  }
  if (chunkIndex >= totalChunks) {
    throw new Error(`Frame chunkIndex ${chunkIndex} out of bounds for totalChunks ${totalChunks}`)
  }

  const payload = buf.subarray(FRAME_HEADER_BYTES)
  return { msgId, chunkIndex, totalChunks, payload }
}

interface InFlightAssembly {
  msgId: number
  totalChunks: number
  receivedCount: number
  chunks: (Buffer | null)[]
  totalBytes: number
  createdAt: number
}

/**
 * Reassembler for multi-chunk messages.
 * Handles reordering, bounds checking, and timeout cleanup.
 */
export class MessageReassembler {
  private inFlight = new Map<number, InFlightAssembly>()
  private maxAgeMs: number

  constructor(maxAgeMs = 30_000) {
    this.maxAgeMs = maxAgeMs
  }

  /**
   * Push a chunk into reassembly. Returns complete Buffer if reassembly is finished, or null.
   */
  push(chunk: FrameChunk): Buffer | null {
    this.gc()

    // Fast path: single-chunk message
    if (chunk.totalChunks === 1 && chunk.chunkIndex === 0) {
      if (chunk.payload.length > MESSAGE_MAX_BYTES) {
        throw new Error(`Chunk exceeds max message size ${MESSAGE_MAX_BYTES}`)
      }
      return chunk.payload
    }

    let assembly = this.inFlight.get(chunk.msgId)
    if (!assembly) {
      assembly = {
        msgId: chunk.msgId,
        totalChunks: chunk.totalChunks,
        receivedCount: 0,
        chunks: new Array(chunk.totalChunks).fill(null),
        totalBytes: 0,
        createdAt: Date.now()
      }
      this.inFlight.set(chunk.msgId, assembly)
    }

    if (assembly.totalChunks !== chunk.totalChunks) {
      this.inFlight.delete(chunk.msgId)
      throw new Error(`Mismatched totalChunks for msgId ${chunk.msgId}`)
    }

    if (!assembly.chunks[chunk.chunkIndex]) {
      assembly.chunks[chunk.chunkIndex] = chunk.payload
      assembly.receivedCount++
      assembly.totalBytes += chunk.payload.length

      if (assembly.totalBytes > MESSAGE_MAX_BYTES) {
        this.inFlight.delete(chunk.msgId)
        throw new Error(
          `Reassembled message for msgId ${chunk.msgId} exceeds max size ${MESSAGE_MAX_BYTES}`
        )
      }
    }

    if (assembly.receivedCount === assembly.totalChunks) {
      this.inFlight.delete(chunk.msgId)
      return Buffer.concat(assembly.chunks as Buffer[])
    }

    return null
  }

  /** Clean up stale incomplete assemblies. */
  private gc(): void {
    const now = Date.now()
    for (const [msgId, assembly] of this.inFlight.entries()) {
      if (now - assembly.createdAt > this.maxAgeMs) {
        this.inFlight.delete(msgId)
      }
    }
  }

  reset(): void {
    this.inFlight.clear()
  }
}
