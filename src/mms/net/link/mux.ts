import type { Duplex } from 'node:stream'
import type { Clock, Mux, MuxMessage } from '../contracts'
import { systemClock } from '../clock'
import { NetError } from '../../../shared/net/errors'
import { FRAGMENT_STALL_MS, MAX_FRAME_BYTES } from '../../../shared/net/limits'
import { laneFor, type Lane } from '../../../shared/net/wire'
import { decodeMessage, encodeMessage, MAX_MESSAGE_BYTES } from '../sync/codec'

export const MUX_WINDOWS = { control: 256 * 1024, bulk: 1024 * 1024 } as const
const HEADER = 16, FIRST = 1, LAST = 2, CREDIT = 4
const LANES: Lane[] = ['control', 'bulk']
type Timer = { cancel(): void }
type Send = { bytes: Uint8Array; offset: number; id?: number; resolve(): void; reject(error: Error): void; signal?: AbortSignal; abort?: () => void }
type Receive = { id: number; chunks: Buffer[]; size: number; timer?: Timer }
type LaneState = { credit: number; receiveCredit: number; grants: number; active?: Send; waiting: Send[]; waitingBytes: number; receive?: Receive }

/** Independent lane credits; one bounded active message plus a bounded waiting queue per lane. */
export class StreamMux implements Mux {
  private readonly clock: Clock
  private readonly onBytesReceived?: (count: number) => void
  private readonly lanes: Record<Lane, LaneState>
  private readonly messages = new Set<(lane: Lane, message: MuxMessage) => void>()
  private readonly closedListeners = new Set<(error?: Error) => void>()
  private closed = false
  private closeError?: Error
  private writing = false
  private scheduled = false
  private nextId = 1
  private lastReceivedId = 0
  private frameHeader = Buffer.alloc(HEADER)
  private headerOffset = 0
  private payload?: Buffer
  private payloadOffset = 0
  private frame?: { lane: Lane; flags: number; id: number; length: number; grant: number }
  private inputTimer?: Timer
  constructor(private readonly stream: Duplex, options: MuxOptions = {}) {
    this.clock = options.clock ?? systemClock
    this.onBytesReceived = options.onBytesReceived
    const state = (lane: Lane): LaneState => ({ credit: MUX_WINDOWS[lane], receiveCredit: MUX_WINDOWS[lane], grants: 0, waiting: [], waitingBytes: 0 })
    this.lanes = { control: state('control'), bulk: state('bulk') }
    stream.on('data', this.data)
    stream.on('error', this.error)
    stream.on('end', this.ended)
    stream.on('close', this.ended)
  }
  send(lane: Lane, message: MuxMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError ?? new NetError('route_unreachable', 'Mux is closed.'))
    if (signal?.aborted) return Promise.reject(new NetError('cancelled', undefined, { cause: signal.reason }))
    if (!this.lanes[lane] || laneFor(message.header) !== lane) return Promise.reject(new NetError('bad_request', 'Message sent on wrong lane.'))
    let bytes: Uint8Array
    try { bytes = encodeMessage(message.header, message.parts) } catch (error) { return Promise.reject(error) }
    const state = this.lanes[lane]
    if (state.active && state.waitingBytes + bytes.length > MUX_WINDOWS[lane]) return Promise.reject(new NetError('rate_limited', 'Mux waiting queue is full.'))
    return new Promise((resolve, reject) => {
      const send: Send = { bytes, offset: 0, resolve, reject, signal }
      const abort = () => {
        if (state.active === send && send.offset > 0) {
          const cancelled = new NetError('cancelled', 'A fragmented send was cancelled.', { cause: signal?.reason })
          state.active = undefined; this.finish(send, cancelled)
          // The operation is cancelled; the unusable connection is a retryable interruption.
          this.close(new NetError('route_unreachable', 'Cancelled partial message requires reconnect.', { cause: cancelled })); return
        }
        if (state.active === send) { state.active = undefined; this.promote(state) }
        else { const index = state.waiting.indexOf(send); if (index < 0) return; state.waiting.splice(index, 1); state.waitingBytes -= send.bytes.length }
        this.finish(send, new NetError('cancelled', undefined, { cause: signal?.reason })); this.schedule()
      }
      send.abort = abort
      signal?.addEventListener('abort', abort, { once: true })
      if (!state.active) state.active = send
      else { state.waiting.push(send); state.waitingBytes += bytes.length }
      if (signal?.aborted) abort()
      this.schedule()
    })
  }
  onMessage(listener: (lane: Lane, message: MuxMessage) => void): () => void { this.messages.add(listener); return () => { this.messages.delete(listener) } }
  onClose(listener: (error?: Error) => void): () => void {
    this.closedListeners.add(listener)
    if (this.closed) queueMicrotask(() => { if (this.closedListeners.has(listener)) listener(this.closeError) })
    return () => { this.closedListeners.delete(listener) }
  }
  queued(lane: Lane): number { const state = this.lanes[lane]; return state.waitingBytes + (state.active ? state.active.bytes.length - state.active.offset : 0) }
  close(error?: Error): void {
    if (this.closed) return
    this.closed = true; this.closeError = error
    this.inputTimer?.cancel()
    for (const state of Object.values(this.lanes)) {
      state.receive?.timer?.cancel(); state.receive = undefined
      if (state.active) this.finish(state.active, error ?? new NetError('route_unreachable'))
      for (const send of state.waiting) this.finish(send, error ?? new NetError('route_unreachable'))
      state.active = undefined; state.waiting = []; state.waitingBytes = 0; state.grants = 0
    }
    this.stream.removeListener('data', this.data); this.stream.removeListener('end', this.ended); this.stream.removeListener('close', this.ended)
    // Keep the error sink through socket destruction; close observers retain the cause.
    this.stream.destroy()
    this.payload = undefined; this.frame = undefined; this.headerOffset = 0
    for (const listener of this.closedListeners) listener(error)
    this.messages.clear()
  }
  private finish(send: Send, error?: Error): void { if (send.abort) send.signal?.removeEventListener('abort', send.abort); error ? send.reject(error) : send.resolve() }
  private promote(state: LaneState): void { state.active = state.waiting.shift(); if (state.active) state.waitingBytes -= state.active.bytes.length }
  private transportError(cause: unknown): NetError { return cause instanceof NetError ? cause : new NetError('route_unreachable', undefined, { cause }) }
  private readonly error = (error: Error): void => { this.close(this.transportError(error)) }
  private readonly ended = (): void => { this.close(new NetError('route_unreachable', 'Mux peer closed.')) }
  private schedule(): void {
    if (this.closed || this.writing || this.scheduled) return
    this.scheduled = true; queueMicrotask(() => { this.scheduled = false; this.pump() })
  }
  private frameBytes(lane: Lane, flags: number, id: number, payload?: Uint8Array, grant = 0): Buffer {
    const bytes = Buffer.alloc(HEADER + (payload?.length ?? 0)); bytes[0] = 1; bytes[1] = lane === 'control' ? 0 : 1; bytes[2] = flags
    bytes.writeUInt32BE(id, 4); bytes.writeUInt32BE(payload?.length ?? 0, 8); bytes.writeUInt32BE(grant, 12)
    if (payload) bytes.set(payload, HEADER)
    return bytes
  }
  private pump(): void {
    if (this.closed || this.writing) return
    for (const lane of LANES) {
      const state = this.lanes[lane]
      if (state.grants) {
        const grant = state.grants; state.grants = 0; state.receiveCredit += grant
        if (state.receiveCredit > MUX_WINDOWS[lane]) { this.close(new NetError('bad_request', 'Receive credit overflow.')); return }
        this.write(this.frameBytes(lane, CREDIT, 0, undefined, grant)); return
      }
    }
    for (const lane of LANES) {
      const state = this.lanes[lane], send = state.active
      if (!send || !state.credit) continue
      if (send.id === undefined) {
        if (this.nextId > 0xffffffff) { this.close(new NetError('conflict', 'Mux message identifiers exhausted.')); return }
        send.id = this.nextId++
      }
      const size = Math.min(MAX_FRAME_BYTES - HEADER, state.credit, send.bytes.length - send.offset)
      const first = send.offset === 0, last = send.offset + size === send.bytes.length
      const payload = send.bytes.subarray(send.offset, send.offset + size)
      send.offset += size; state.credit -= size
      // Only the receiver can observe byte progress within a pending stream write.
      // Its reassembly watchdog measures progress; send cancellation belongs to
      // the caller's AbortSignal and session liveness.
      this.write(this.frameBytes(lane, (first ? FIRST : 0) | (last ? LAST : 0), send.id, payload), () => {
        if (last && state.active === send) { state.active = undefined; this.finish(send); this.promote(state) }
      })
      return
    }
  }
  private write(frame: Buffer, done?: () => void): void {
    this.writing = true
    try {
      this.stream.write(frame, error => {
        this.writing = false
        if (this.closed) return
        if (error) { this.close(this.transportError(error)); return }
        done?.(); this.schedule()
      })
    } catch (error) { this.writing = false; this.close(this.transportError(error)) }
  }
  private progress(): void { this.inputTimer?.cancel(); this.inputTimer = this.clock.setTimeout(() => this.close(new NetError('deadline_exceeded', 'Fragment receive stalled.')), FRAGMENT_STALL_MS) }
  private readonly data = (input: Buffer): void => {
    if (this.closed) return
    try {
      let offset = 0
      while (offset < input.length && !this.closed) {
        if (!this.frame) {
          const count = Math.min(HEADER - this.headerOffset, input.length - offset)
          input.copy(this.frameHeader, this.headerOffset, offset, offset + count); this.headerOffset += count; offset += count; this.progress()
          if (this.headerOffset < HEADER) continue
          const h = this.frameHeader, lane = LANES[h[1]], flags = h[2], id = h.readUInt32BE(4), length = h.readUInt32BE(8), grant = h.readUInt32BE(12)
          if (h[0] !== 1 || !lane || h[3] !== 0 || (flags & ~7) || length > MAX_FRAME_BYTES - HEADER) throw new NetError('bad_request', 'Invalid mux frame header.')
          this.headerOffset = 0
          if (flags === CREDIT) {
            const state = this.lanes[lane]
            if (id !== 0 || length !== 0 || !grant || state.credit + grant > MUX_WINDOWS[lane]) throw new NetError('bad_request', 'Invalid credit grant.')
            state.credit += grant; this.inputTimer?.cancel(); this.schedule(); continue
          }
          if ((flags & CREDIT) || grant || !id || !length) throw new NetError('bad_request', 'Invalid data frame.')
          const state = this.lanes[lane]
          if (length > state.receiveCredit) throw new NetError('bad_request', 'Peer exceeded lane credit.')
          if (flags & FIRST) {
            if (state.receive || id <= this.lastReceivedId) throw new NetError('bad_request', 'Invalid first fragment or reused message ID.')
            this.lastReceivedId = id; state.receive = { id, size: 0, chunks: [] }
          }
          const receive = state.receive
          if (!receive || receive.id !== id) throw new NetError('bad_request', 'Unexpected continuation fragment.')
          if (receive.size + length > MAX_MESSAGE_BYTES) throw new NetError('too_large', 'Reassembled message exceeds limit.')
          state.receiveCredit -= length
          this.frame = { lane, flags, id, length, grant }; this.payload = Buffer.allocUnsafe(length); this.payloadOffset = 0
        }
        if (this.frame && this.payload) {
          const count = Math.min(this.frame.length - this.payloadOffset, input.length - offset)
          input.copy(this.payload, this.payloadOffset, offset, offset + count); this.payloadOffset += count; offset += count
          if (count) { this.onBytesReceived?.(count); this.progress(); const receive = this.lanes[this.frame.lane].receive!; receive.timer?.cancel(); receive.timer = this.clock.setTimeout(() => this.close(new NetError('deadline_exceeded', 'Fragment reassembly stalled.')), FRAGMENT_STALL_MS) }
          if (this.payloadOffset !== this.frame.length) continue
          const frame = this.frame, state = this.lanes[frame.lane], receive = state.receive!
          receive.chunks.push(this.payload); receive.size += this.payload.length; state.grants += this.payload.length
          this.frame = undefined; this.payload = undefined; this.inputTimer?.cancel()
          if (frame.flags & LAST) {
            receive.timer?.cancel(); state.receive = undefined
            const bytes = Buffer.concat(receive.chunks, receive.size)
            try {
              const message = decodeMessage(bytes, frame.lane)
              for (const listener of this.messages) listener(frame.lane, message)
            } catch (error) {
              if (!(error instanceof NetError && error.code === 'unsupported_version')) throw error
              // Unknown complete wire types are skipped under protocol forward compatibility.
            }
          }
          this.schedule()
        }
      }
    } catch (error) { this.close(error instanceof Error ? error : new NetError('bad_request', undefined, { cause: error })) }
  }
}
export interface MuxOptions {
  clock?: Clock
  /** DATA message bytes, before decode/dispatch, including unknown/incomplete messages.
   * The session enforces its preauthentication byte budget here and may throw. */
  onBytesReceived?: (count: number) => void
}
export function createMux(stream: Duplex, options: MuxOptions = {}): Mux { return new StreamMux(stream, options) }
