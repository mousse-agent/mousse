import { randomBytes } from 'node:crypto'
import { FrameDecodeError, encodeFrame } from './framing'
import { MMS_PROTOCOL_CHUNK_BYTES, MMS_PROTOCOL_MAX_ENVELOPE_BYTES, type ProtocolEnvelopeChunk } from './types'

/** Chunk bytes rather than JS characters so Unicode survives every boundary. */
export function *envelopeFrames(body: Buffer, chunked: boolean): Generator<Buffer> {
  if (!chunked) {
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(body.length)
    yield Buffer.concat([header, body])
    return
  }
  const transferId = randomBytes(16).toString('hex')
  for (let offset = 0, index = 0; offset < body.length; offset += MMS_PROTOCOL_CHUNK_BYTES, index++) {
    yield encodeFrame({ kind: 'envelope_chunk', transferId, index, totalBytes: body.length,
      data: body.subarray(offset, offset + MMS_PROTOCOL_CHUNK_BYTES).toString('base64') })
  }
}

export class EnvelopeAssembler {
  private transfer: { id: string; total: number; index: number; received: number; chunks: Buffer[] } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly onTimeout: () => void, private readonly timeoutMs = 15_000) {}
  get active(): boolean { return this.transfer !== null }
  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
    this.transfer = null
  }
  accept(chunk: ProtocolEnvelopeChunk): unknown | null {
    const bad = (): never => { this.reset(); throw new FrameDecodeError('Invalid envelope chunk sequence') }
    if (chunk.totalBytes > MMS_PROTOCOL_MAX_ENVELOPE_BYTES || chunk.totalBytes < 1) return bad()
    if (!this.transfer) {
      if (chunk.index !== 0) return bad()
      this.transfer = { id: chunk.transferId, total: chunk.totalBytes, index: 0, received: 0, chunks: [] }
      this.deadline = setTimeout(() => { this.reset(); this.onTimeout() }, 60_000)
      this.deadline.unref?.()
    }
    const current = this.transfer
    if (chunk.transferId !== current.id || chunk.totalBytes !== current.total || chunk.index !== current.index) return bad()
    const bytes = Buffer.from(chunk.data, 'base64')
    const expected = Math.min(MMS_PROTOCOL_CHUNK_BYTES, current.total - current.received)
    if (bytes.length !== expected || bytes.toString('base64') !== chunk.data) return bad()
    current.chunks.push(bytes)
    current.received += bytes.length
    current.index++
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.reset(); this.onTimeout() }, this.timeoutMs)
    this.timer.unref?.()
    if (current.received !== current.total) return null
    const body = Buffer.concat(current.chunks, current.total)
    this.reset()
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { throw new FrameDecodeError('Malformed assembled envelope') }
  }
}
