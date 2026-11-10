import type { Socket } from 'node:net'
import { writeBatchedFrame, writeConnectionEventFrame } from './connectionEventWriter'
import { MMS_PROTOCOL_MAX_ENVELOPE_BYTES, MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES } from './types'

/** Frames waiting to be written to one peer before it is disconnected as too slow. */
export const OUTBOUND_MAX_PENDING = 1024

export interface OutboundEnqueueOptions {
  /** A connection event waits until its frame is flushed, so its producer is paced by the peer. */
  flush?: boolean
  /**
   * Names what the frame carries the whole current state of. A newer frame with the same key
   * replaces one still waiting, so a slow peer is sent the latest state once instead of every step.
   */
  supersedes?: string
}

interface Entry {
  bytes: number
  frames: () => Iterable<Buffer>
  signal: AbortSignal
  callerSignal?: AbortSignal
  before?: () => void
  flush: boolean
  key?: string
  dropped: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * Bounded producer queue, written in order. Responses and events are written in batches of up to
 * `OUTBOUND_BATCH_BYTES` before waiting for a drain; a `flush` frame waits for its write to finish.
 */
export class OutboundWriter {
  private queue: Entry[] = []
  private head = 0
  /** The entry still waiting for each `supersedes` key. */
  private waiting = new Map<string, Entry>()
  private running = false
  private bytes = 0
  private pending = 0
  private lifetime = new AbortController()
  constructor(private readonly socket: Socket, private readonly onFailure: () => void) {}
  close(): void { this.lifetime.abort() }
  enqueue(bytes: number, frames: () => Iterable<Buffer>, signal?: AbortSignal, before?: () => void, options: OutboundEnqueueOptions = {}): Promise<void> | null {
    if (this.lifetime.signal.aborted || this.socket.destroyed) return null
    const replaced = options.supersedes !== undefined ? this.waiting.get(options.supersedes) : undefined
    const queuedBytes = this.bytes - (replaced?.bytes ?? 0)
    const queuedFrames = this.pending - (replaced ? 1 : 0)
    if (bytes > MMS_PROTOCOL_MAX_ENVELOPE_BYTES || queuedBytes + bytes > 2 * MMS_PROTOCOL_MAX_ENVELOPE_BYTES || queuedFrames >= OUTBOUND_MAX_PENDING) {
      this.onFailure()
      return null
    }
    if (replaced) this.drop(replaced)
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    const result = new Promise<void>((resolve, reject) => {
      const entry: Entry = { bytes, frames, signal: combined, callerSignal: signal, before, flush: options.flush === true, key: options.supersedes, dropped: false, resolve, reject }
      this.queue.push(entry)
      if (entry.key !== undefined) this.waiting.set(entry.key, entry)
    })
    this.bytes += bytes
    this.pending++
    if (!this.running) {
      this.running = true
      // Started after the caller returns, as each write always has been.
      queueMicrotask(() => { void this.pump() })
    }
    return result
  }

  /** A superseded entry is never written; its caller is told it was delivered, as its state was. */
  private drop(entry: Entry): void {
    entry.dropped = true
    entry.frames = () => []
    this.waiting.delete(entry.key!)
    this.bytes -= entry.bytes
    this.pending--
    entry.resolve()
  }

  private async pump(): Promise<void> {
    try {
      while (this.head < this.queue.length) {
        const entry = this.queue[this.head++]
        if (this.head >= 256 && this.head * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.head)
          this.head = 0
        }
        if (entry.dropped) continue
        // Once its write begins, a newer state queues behind it.
        if (entry.key !== undefined && this.waiting.get(entry.key) === entry) this.waiting.delete(entry.key)
        try {
          await this.write(entry)
          entry.resolve()
        } catch (error) {
          entry.reject(error)
          // A canceled profile-scoped event need not kill unrelated requests.
          if (!entry.callerSignal?.aborted && !this.lifetime.signal.aborted) this.onFailure()
        } finally {
          this.bytes -= entry.bytes
          this.pending--
        }
      }
    } finally {
      this.running = false
    }
  }

  private async write(entry: Entry): Promise<void> {
    entry.before?.()
    const activeSignal = AbortSignal.any([entry.signal, AbortSignal.timeout(60_000)])
    for (const frame of entry.frames()) {
      if (entry.flush) {
        if (this.socket.writableLength + frame.length > MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES) throw new Error('Outbound socket backlog exceeded')
        await writeConnectionEventFrame(this.socket, frame, activeSignal)
      } else {
        await writeBatchedFrame(this.socket, frame, activeSignal)
      }
    }
  }
}
