import type { Socket } from 'node:net'
import { writeConnectionEventFrame } from './connectionEventWriter'
import { MMS_PROTOCOL_MAX_ENVELOPE_BYTES, MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES } from './types'

/** Bounded producer queue, with only one small frame written until it drains. */
export class OutboundWriter {
  private chain = Promise.resolve()
  private bytes = 0
  private pending = 0
  private lifetime = new AbortController()
  constructor(private readonly socket: Socket, private readonly onFailure: () => void) {}
  close(): void { this.lifetime.abort() }
  enqueue(bytes: number, frames: () => Iterable<Buffer>, signal?: AbortSignal, before?: () => void): Promise<void> | null {
    if (this.lifetime.signal.aborted || this.socket.destroyed) return null
    if (bytes > MMS_PROTOCOL_MAX_ENVELOPE_BYTES || this.bytes + bytes > 2 * MMS_PROTOCOL_MAX_ENVELOPE_BYTES || this.pending >= 1024) {
      this.onFailure()
      return null
    }
    this.bytes += bytes
    this.pending++
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const result = this.chain.then(async () => {
      before?.()
      const deadline = AbortSignal.timeout(60_000)
      const activeSignal = AbortSignal.any([combined, deadline])
      for (const frame of frames()) {
        if (this.socket.writableLength + frame.length > MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES) throw new Error('Outbound socket backlog exceeded')
        await writeConnectionEventFrame(this.socket, frame, activeSignal)
      }
    }).finally(() => { this.bytes -= bytes; this.pending-- })
    this.chain = result.catch(() => {
      // A canceled profile-scoped event need not kill unrelated requests.
      if (!signal?.aborted && !this.lifetime.signal.aborted) this.onFailure()
    })
    return result
  }
}
