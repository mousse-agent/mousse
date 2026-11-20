import { randomBytes } from 'node:crypto'
import { FrameDecodeError, encodeFrame } from './framing'
import { MMS_PROTOCOL_CHUNK_BYTES, MMS_PROTOCOL_MAX_ENVELOPE_BYTES, MMS_PROTOCOL_MAX_FRAME_BYTES, MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES, type ProtocolEnvelopeChunk } from './types'

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

/**
 * The frames a client sends for `value`: one frame when it fits, its chunks when it does not and the service takes
 * chunked requests (`chunked`, `MMS_PROTOCOL_INBOUND_CHUNK_CAPABILITY`), up to one inbound envelope. Past that, how
 * large it is and the most that could have been sent.
 */
export function requestFrames(value: unknown, chunked: boolean): { frames: Buffer[] } | { tooLarge: { bytes: number; max: number } } {
  const body = Buffer.from(JSON.stringify(value), 'utf-8')
  if (body.length <= MMS_PROTOCOL_MAX_FRAME_BYTES) return { frames: [...envelopeFrames(body, false)] }
  if (!chunked || body.length > MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES) {
    return { tooLarge: { bytes: body.length, max: chunked ? MMS_PROTOCOL_MAX_INBOUND_ENVELOPE_BYTES : MMS_PROTOCOL_MAX_FRAME_BYTES } }
  }
  return { frames: [...envelopeFrames(body, true)] }
}

/** Bytes several assemblers may hold at once: a transfer reserves its whole size when it starts, or is refused. */
export interface EnvelopeBudget {
  reserve(bytes: number): boolean
  release(bytes: number): void
}

/** A budget of `limit` bytes shared by every assembler given it. */
export function envelopeBudget(limit: number): EnvelopeBudget & { readonly used: number } {
  let used = 0
  return {
    get used() { return used },
    reserve(bytes) {
      if (used + bytes > limit) return false
      used += bytes
      return true
    },
    release(bytes) { used = Math.max(0, used - bytes) }
  }
}

/**
 * Puts one envelope back together from its chunks: one transfer at a time, its chunks in order, at most `maxBytes`,
 * written into one buffer of its announced size (reserved from `budget` when given), which a broken sequence, a
 * stall or `reset` drops.
 */
export class EnvelopeAssembler {
  private transfer: { id: string; total: number; index: number; received: number; body: Buffer } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly onTimeout: () => void,
    private readonly timeoutMs = 15_000,
    private readonly maxBytes = MMS_PROTOCOL_MAX_ENVELOPE_BYTES,
    private readonly budget?: EnvelopeBudget
  ) {}
  get active(): boolean { return this.transfer !== null }
  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
    if (this.transfer) this.budget?.release(this.transfer.total)
    this.transfer = null
  }
  accept(chunk: ProtocolEnvelopeChunk): unknown | null {
    const bad = (): never => { this.reset(); throw new FrameDecodeError('Invalid envelope chunk sequence') }
    if (chunk.totalBytes > this.maxBytes || chunk.totalBytes < 1) return bad()
    if (!this.transfer) {
      if (chunk.index !== 0) return bad()
      if (this.budget && !this.budget.reserve(chunk.totalBytes)) throw new FrameDecodeError('Too many envelope transfers at once')
      this.transfer = { id: chunk.transferId, total: chunk.totalBytes, index: 0, received: 0, body: Buffer.allocUnsafe(chunk.totalBytes) }
      this.deadline = setTimeout(() => { this.reset(); this.onTimeout() }, 60_000)
      this.deadline.unref?.()
    }
    const current = this.transfer
    if (chunk.transferId !== current.id || chunk.totalBytes !== current.total || chunk.index !== current.index) return bad()
    const bytes = Buffer.from(chunk.data, 'base64')
    const expected = Math.min(MMS_PROTOCOL_CHUNK_BYTES, current.total - current.received)
    if (bytes.length !== expected || bytes.toString('base64') !== chunk.data) return bad()
    bytes.copy(current.body, current.received)
    current.received += bytes.length
    current.index++
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.reset(); this.onTimeout() }, this.timeoutMs)
    this.timer.unref?.()
    if (current.received !== current.total) return null
    const body = current.body
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { throw new FrameDecodeError('Malformed assembled envelope') }
    // The reservation lasts until the request is decoded, which is when its buffer can go.
    finally { this.reset() }
  }
}
