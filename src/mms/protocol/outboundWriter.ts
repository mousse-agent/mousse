import type { Socket } from 'node:net'
import { waitForDrain, writeBatchedFrame, writeConnectionEventFrame } from './connectionEventWriter'
import { MMS_PROTOCOL_MAX_ENVELOPE_BYTES, MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES } from './types'

/** Frames waiting to be written to one peer before it is disconnected as too slow. */
export const OUTBOUND_MAX_PENDING = 1024

/** How long one entry (all of its frames) may take to write before it fails. */
export const OUTBOUND_ENTRY_DEADLINE_MS = 60_000

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
    const result = new Promise<void>((resolve, reject) => {
      const entry: Entry = { bytes, frames, callerSignal: signal, before, flush: options.flush === true, key: options.supersedes, dropped: false, resolve, reject }
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
    // The write stops when its caller cancels, the connection closes or the deadline passes. The listeners and the
    // timer are removed as soon as the write ends: the service writes many frames a second while a reply streams, and
    // `AbortSignal.timeout` and `AbortSignal.any` here kept a timer and two signals alive for a minute after each one.
    const active = new AbortController()
    const sources = entry.callerSignal ? [entry.callerSignal, this.lifetime.signal] : [this.lifetime.signal]
    const stop = (): void => active.abort()
    for (const source of sources) source.addEventListener('abort', stop, { once: true })
    if (sources.some((source) => source.aborted)) stop()
    const deadline = setTimeout(stop, OUTBOUND_ENTRY_DEADLINE_MS)
    deadline.unref?.()
    try {
      for (const frame of entry.frames()) {
        if (entry.flush) {
          // Batched frames before it may still be in Node's buffer; the bound below is for the event's own frame.
          // Without a pending drain Node holds less than its high-water mark, far below the bound.
          if (this.socket.writableNeedDrain) await waitForDrain(this.socket, active.signal)
          if (this.socket.writableLength + frame.length > MMS_PROTOCOL_MAX_OUTBOUND_QUEUED_BYTES) throw new Error('Outbound socket backlog exceeded')
          await writeConnectionEventFrame(this.socket, frame, active.signal)
        } else {
          await writeBatchedFrame(this.socket, frame, active.signal)
        }
      }
    } finally {
      clearTimeout(deadline)
      for (const source of sources) source.removeEventListener('abort', stop)
    }
  }
}
