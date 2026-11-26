import { NetError } from '../../../shared/net/errors'
import { engineLimits } from '../limits'

/**
 * The channel between the app and its network helper (design §2): frames of `u32 BE length | u8 type | body`,
 * where `length` counts the type byte and the body.
 *
 * - `0x01` JSON: a request (`{id, op, ...}`), a reply (`{re, ...}` or `{re, error, reason}`) or an event (`{ev, ...}`).
 * - `0x02` DATA: `u32 handle | u8 flags | payload`; flag `0x01` is FIN, which follows every byte queued before it.
 *   Other flag bits are malformed.
 * - `0x03` CREDIT: `u32 handle | u32 bytes`, at least 1 byte more room for the other side on that stream.
 *
 * A frame that cannot be read, or DATA beyond the credit granted, closes the channel.
 */
export const FRAME_JSON = 0x01
export const FRAME_DATA = 0x02
export const FRAME_CREDIT = 0x03
export const DATA_FIN = 0x01

export type StreamClass = 'interactive' | 'bulk'

export interface AppFrame {
  type: number
  body: Uint8Array
}

export function encodeFrame(type: number, body: Uint8Array): Uint8Array {
  if (5 + body.byteLength > engineLimits().appFrameMaxBytes) throw new NetError('too_large')
  const out = Buffer.allocUnsafe(5 + body.byteLength)
  out.writeUInt32BE(1 + body.byteLength, 0)
  out.writeUInt8(type, 4)
  out.set(body, 5)
  return out
}

export function jsonFrame(value: unknown): Uint8Array {
  return encodeFrame(FRAME_JSON, Buffer.from(JSON.stringify(value)))
}

export function dataFrame(handle: number, payload: Uint8Array, fin: boolean): Uint8Array {
  const body = Buffer.allocUnsafe(5 + payload.byteLength)
  body.writeUInt32BE(handle, 0)
  body.writeUInt8(fin ? DATA_FIN : 0, 4)
  body.set(payload, 5)
  return encodeFrame(FRAME_DATA, body)
}

export function creditFrame(handle: number, bytes: number): Uint8Array {
  const body = Buffer.allocUnsafe(8)
  body.writeUInt32BE(handle, 0)
  body.writeUInt32BE(bytes, 4)
  return encodeFrame(FRAME_CREDIT, body)
}

/** Splits the byte stream from the other side into frames; throws on one that cannot be read. */
export class FrameReader {
  private buffered = Buffer.alloc(0)
  push(bytes: Uint8Array): AppFrame[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, bytes]) : Buffer.from(bytes)
    const out: AppFrame[] = []
    for (;;) {
      if (this.buffered.length < 4) return out
      const length = this.buffered.readUInt32BE(0)
      if (length < 1 || 4 + length > engineLimits().appFrameMaxBytes)
        throw new NetError('bad_request', 'Unreadable frame from the helper.')
      if (this.buffered.length < 4 + length) return out
      const type = this.buffered.readUInt8(4)
      const body = Uint8Array.prototype.slice.call(this.buffered, 5, 4 + length) as Uint8Array
      this.buffered = this.buffered.subarray(4 + length)
      if (
        type === FRAME_DATA &&
        (body.byteLength < 5 || body.byteLength - 5 > engineLimits().appDataMaxBytes || (body[4]! & ~DATA_FIN) !== 0)
      )
        throw new NetError('bad_request', 'Unreadable frame from the helper.')
      if (type === FRAME_CREDIT && (body.byteLength !== 8 || Buffer.from(body).readUInt32BE(4) === 0))
        throw new NetError('bad_request', 'Unreadable frame from the helper.')
      if (type !== FRAME_JSON && type !== FRAME_DATA && type !== FRAME_CREDIT)
        throw new NetError('bad_request', 'Unreadable frame from the helper.')
      out.push({ type, body })
    }
  }
}

/** The pipe to the helper: its stdin and stdout, or a test's in-memory pair. */
export interface AppPipe {
  /** Writes bytes; false when the pipe wants `onDrain` before more. */
  write(bytes: Uint8Array): boolean
  onDrain(listener: () => void): void
  onData(listener: (bytes: Uint8Array) => void): void
  /** The helper ended the pipe or exited. */
  onClose(listener: () => void): void
  close(): void
}

/** What a stream's handle delivers to its owner. */
export interface HandleSink {
  data(bytes: Uint8Array, fin: boolean): void
  reset(code: string): void
}

interface SendStream {
  handle: number
  cls: StreamClass
  /** Credit the helper granted for this stream's DATA. */
  credit: number
  queue: Array<{ bytes: Uint8Array; fin: boolean }>
  /** Bytes in `queue`. */
  bytes: number
}

interface ReceiveStream {
  handle: number
  cls: StreamClass
  sink: HandleSink
  /** Credit granted to the helper for this stream and not yet used. */
  outstanding: number
  finished: boolean
}

type Json = Record<string, unknown>

/**
 * The app's end of the helper channel. Reading never waits on writing. The writer sends control (JSON and CREDIT)
 * first, then interactive DATA, then bulk DATA, with streams taking turns within a class. The app grants the
 * helper credit from one budget, at most a stream's share per stream, with a reserve only interactive streams
 * use; a stream that cannot get credit waits until some returns.
 *
 * What this side queues is bounded too: a stream past `appStreamQueueBytes` has its producer wait (`whenRoom`), one
 * past `appStreamQueueMaxBytes` is refused, and requests past `appControlQueueBytes` of control are refused.
 */
export class AppChannel {
  private readonly reader = new FrameReader()
  private readonly control: Uint8Array[] = []
  /** Bytes in `control`. */
  private controlBytes = 0
  /** Producers waiting for room on a stream's queue, by handle. */
  private readonly roomWaiters = new Map<number, Array<() => void>>()
  /** Streams this side may still write on. */
  private readonly sending = new Map<number, SendStream>()
  /** Streams with bytes queued, including ones whose writing side has ended. */
  private readonly queued = new Map<number, SendStream>()
  private readonly turns: Record<StreamClass, number[]> = { interactive: [], bulk: [] }
  private readonly receiving = new Map<number, ReceiveStream>()
  /** Streams waiting for credit from the budget, oldest first. */
  private readonly starved: number[] = []
  private readonly pending = new Map<
    number,
    {
      resolve(value: Json): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
      /** Runs as the reply is read, before any frame after it (a stream's first credit follows its open's reply). */
      onReply?: (reply: Json) => void
    }
  >()
  private readonly eventListeners = new Set<(event: Json) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private nextId = 1
  private granted = 0
  private writable = true
  private closed = false
  /** Frames dropped for a handle that is not open; kept for diagnostics. */
  dropped = 0

  constructor(private readonly pipe: AppPipe) {
    pipe.onData((bytes) => this.receive(bytes))
    pipe.onDrain(() => {
      this.writable = true
      this.pump()
    })
    pipe.onClose(() => this.shut('helper_exit'))
  }

  isOpen(): boolean {
    return !this.closed
  }

  /**
   * Sends a request and waits for its reply; a reply with `error` rejects with that code and reason. `onReply`
   * sees a good reply as it is read, before the frames after it.
   */
  request(
    name: string,
    fields: Json = {},
    deadlineMs = engineLimits().appRequestDeadlineMs,
    onReply?: (reply: Json) => void,
    /** Told the request's id as it is sent (a later request may name it, as `join.probe.cancel` does). */
    onId?: (id: number) => void
  ): Promise<Json> {
    if (this.closed) return Promise.reject(new NetError('peer_offline'))
    const id = this.nextId++
    onId?.(id)
    const frame = jsonFrame({ id, op: name, ...fields })
    if (this.controlBytes + frame.byteLength > engineLimits().appControlQueueBytes)
      return Promise.reject(new NetError('rate_limited', 'Too much waiting for the helper.'))
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new NetError('deadline_exceeded'))
      }, deadlineMs)
      this.pending.set(id, { resolve, reject, timer, onReply })
      this.sendControl(frame)
    })
  }

  /**
   * Opens a stream on connection `conn`: the handle the helper answers is bound to `sink` as its reply is read, so
   * the credit and data that follow it find the stream.
   */
  openStream(conn: number, label: string, cls: StreamClass, sink: HandleSink): Promise<number> {
    let bound: number | undefined
    return this.request('stream.open', { conn, label, class: cls }, undefined, (reply) => {
      if (typeof reply.handle !== 'number') return
      bound = reply.handle
      this.bind(bound, cls, sink)
    }).then(() => {
      if (bound === undefined) throw new NetError('bad_request', 'The helper named no stream.')
      return bound
    })
  }

  onEvent(listener: (event: Json) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onClose(listener: (reason: string) => void): void {
    if (this.closed) listener('helper_exit')
    else this.closeListeners.add(listener)
  }

  /**
   * Starts carrying a stream the helper gave a handle: what arrives on it goes to `sink`, and the helper gets its
   * first credit for it.
   */
  bind(handle: number, cls: StreamClass, sink: HandleSink): void {
    if (this.closed) {
      sink.reset('helper_exit')
      return
    }
    this.sending.set(handle, { handle, cls, credit: 0, queue: [], bytes: 0 })
    this.receiving.set(handle, { handle, cls, sink, outstanding: 0, finished: false })
    this.topUp(handle)
  }

  /** Queues bytes on a stream, with FIN after them when `fin`; they leave as the helper's credit allows. */
  send(handle: number, bytes: Uint8Array, fin = false): void {
    const stream = this.sending.get(handle)
    if (!stream || this.closed) throw new NetError('peer_offline')
    if (stream.bytes + bytes.byteLength > engineLimits().appStreamQueueMaxBytes)
      throw new NetError('too_large', 'The stream has too much waiting for the helper.')
    stream.bytes += bytes.byteLength
    const max = engineLimits().appDataMaxBytes
    if (!bytes.byteLength && fin) stream.queue.push({ bytes, fin })
    for (let at = 0; at < bytes.byteLength; at += max) {
      const end = Math.min(bytes.byteLength, at + max)
      stream.queue.push({ bytes: bytes.subarray(at, end), fin: fin && end === bytes.byteLength })
    }
    if (!this.turns[stream.cls].includes(handle)) this.turns[stream.cls].push(handle)
    if (fin) this.sending.delete(handle) // Nothing more is written; the queue keeps its place in the turns.
    this.queued.set(handle, stream)
    this.pump()
  }

  /** Whether a stream's producer may write more now (its queue is below `appStreamQueueBytes`, or it is gone). */
  hasRoom(handle: number): boolean {
    const stream = this.queued.get(handle) ?? this.sending.get(handle)
    return !stream || this.closed || stream.bytes < engineLimits().appStreamQueueBytes
  }

  /** Settles once the stream has room (see `hasRoom`), or is gone. */
  whenRoom(handle: number): Promise<void> {
    if (this.hasRoom(handle)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiting = this.roomWaiters.get(handle) ?? []
      waiting.push(resolve)
      this.roomWaiters.set(handle, waiting)
    })
  }

  /**
   * Drops a stream here without a word to the helper, which ended it already (its connection went down): its
   * queue, its credit from the budget and its producers' waits go.
   */
  release(handle: number): void {
    this.forget(handle)
  }

  /** Ends a stream at once both ways (it may overtake queued data, which is dropped). */
  reset(handle: number, code: string): void {
    this.forget(handle)
    if (!this.closed) this.sendControl(jsonFrame({ id: this.nextId++, op: 'stream.reset', handle, code: wireCode(code) }))
  }

  close(): void {
    this.shut('closed')
    this.pipe.close()
  }

  // ---------------------------------------------------------------- inside

  private forget(handle: number): void {
    this.sending.delete(handle)
    this.queued.delete(handle)
    for (const cls of ['interactive', 'bulk'] as const) {
      const at = this.turns[cls].indexOf(handle)
      if (at >= 0) this.turns[cls].splice(at, 1)
    }
    const receiving = this.receiving.get(handle)
    if (receiving) {
      this.granted -= receiving.outstanding
      this.receiving.delete(handle)
      this.feedStarved()
    }
    const starved = this.starved.indexOf(handle)
    if (starved >= 0) this.starved.splice(starved, 1)
    this.wakeRoom(handle)
  }

  private wakeRoom(handle: number): void {
    const waiting = this.roomWaiters.get(handle)
    if (!waiting) return
    this.roomWaiters.delete(handle)
    for (const resolve of waiting) resolve()
  }

  private shut(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new NetError('peer_offline'))
      this.pending.delete(id)
    }
    for (const stream of [...this.receiving.values()]) stream.sink.reset(reason)
    this.receiving.clear()
    this.sending.clear()
    this.queued.clear()
    this.control.length = 0
    this.controlBytes = 0
    for (const handle of [...this.roomWaiters.keys()]) this.wakeRoom(handle)
    for (const listener of [...this.closeListeners]) listener(reason)
    this.closeListeners.clear()
  }

  private sendControl(frame: Uint8Array): void {
    this.control.push(frame)
    this.controlBytes += frame.byteLength
    this.pump()
  }

  /** Writes while the pipe takes it: control first, then interactive, then bulk, streams taking turns. */
  private pump(): void {
    while (this.writable && !this.closed) {
      const control = this.control.shift()
      if (control) this.controlBytes -= control.byteLength
      const frame = control ?? this.nextData('interactive') ?? this.nextData('bulk')
      if (!frame) return
      this.writable = this.pipe.write(frame)
    }
  }

  private nextData(cls: StreamClass): Uint8Array | undefined {
    const turns = this.turns[cls]
    for (let tried = 0; tried < turns.length; tried += 1) {
      const handle = turns.shift()!
      const stream = this.queued.get(handle)
      const next = stream?.queue[0]
      if (!stream || !next) continue
      if (next.bytes.byteLength > stream.credit) {
        // Waits for the helper's credit; keeps its turn.
        turns.push(handle)
        continue
      }
      stream.queue.shift()
      stream.credit -= next.bytes.byteLength
      stream.bytes -= next.bytes.byteLength
      if (stream.queue.length) turns.push(handle)
      else if (!this.sending.has(handle)) {
        this.queued.delete(handle)
        if (this.receiving.get(handle)?.finished) this.receiving.delete(handle)
      }
      if (stream.bytes < engineLimits().appStreamQueueBytes) this.wakeRoom(handle)
      return dataFrame(handle, next.bytes, next.fin)
    }
    return undefined
  }

  private receive(bytes: Uint8Array): void {
    if (this.closed) return
    let frames: AppFrame[]
    try {
      frames = this.reader.push(bytes)
    } catch {
      // A malformed frame closes the channel; the daemon restarts the helper.
      this.close()
      return
    }
    for (const frame of frames) {
      if (this.closed) return
      try {
        this.frame(frame)
      } catch {
        this.close()
        return
      }
    }
  }

  private frame(frame: AppFrame): void {
    const body = Buffer.from(frame.body.buffer, frame.body.byteOffset, frame.body.byteLength)
    if (frame.type === FRAME_CREDIT) {
      const handle = body.readUInt32BE(0),
        bytes = body.readUInt32BE(4)
      const stream = this.queued.get(handle) ?? this.sending.get(handle)
      if (!stream) {
        this.dropped += 1
        return
      }
      stream.credit += bytes
      this.pump()
      return
    }
    if (frame.type === FRAME_DATA) {
      const handle = body.readUInt32BE(0),
        fin = (body.readUInt8(4) & DATA_FIN) !== 0
      const payload = frame.body.subarray(5)
      const stream = this.receiving.get(handle)
      if (!stream || stream.finished) {
        this.dropped += 1
        return
      }
      if (payload.byteLength > stream.outstanding) throw new NetError('bad_request', 'DATA beyond credit.')
      stream.outstanding -= payload.byteLength
      this.granted -= payload.byteLength
      if (fin) stream.finished = true
      // Handed on at once: what the session reads is credit back for the helper.
      stream.sink.data(payload, fin)
      if (fin) {
        this.granted -= stream.outstanding
        stream.outstanding = 0
        if (!this.sending.has(handle) && !this.queued.has(handle)) this.receiving.delete(handle)
        this.feedStarved()
      } else this.topUp(handle)
      return
    }
    const message = JSON.parse(body.toString('utf8')) as Json
    if (!message || typeof message !== 'object') throw new NetError('bad_request')
    if (typeof message.re === 'number') {
      const waiting = this.pending.get(message.re)
      if (!waiting) return
      this.pending.delete(message.re)
      clearTimeout(waiting.timer)
      if (typeof message.error === 'string') {
        const reason = typeof message.reason === 'string' ? message.reason : undefined
        const why = typeof message.why === 'string' ? message.why : undefined
        waiting.reject(helperError(message.error, reason, why))
      } else {
        try {
          waiting.onReply?.(message)
        } finally {
          waiting.resolve(message)
        }
      }
      return
    }
    if (typeof message.ev === 'string') {
      if (message.ev === 'stream.reset' && typeof message.handle === 'number') {
        const stream = this.receiving.get(message.handle)
        this.forget(message.handle)
        stream?.sink.reset(typeof message.code === 'string' ? message.code : 'reset')
        return
      }
      for (const listener of [...this.eventListeners]) listener(message)
    }
  }

  /** Keeps a stream's credit at its share, as far as the budget (and, for bulk, the reserve) allows. */
  private topUp(handle: number): void {
    const stream = this.receiving.get(handle)
    if (!stream || stream.finished || this.closed) return
    const limits = engineLimits()
    const room =
      limits.appCreditBudgetBytes - (stream.cls === 'bulk' ? limits.appInteractiveReserveBytes : 0) - this.granted
    const want = limits.appStreamCreditBytes - stream.outstanding
    const give = Math.min(want, Math.max(0, room))
    if (give <= 0) {
      if (want > 0 && !this.starved.includes(handle)) this.starved.push(handle)
      return
    }
    stream.outstanding += give
    this.granted += give
    this.sendControl(creditFrame(handle, give))
  }

  private feedStarved(): void {
    for (const handle of this.starved.splice(0)) this.topUp(handle)
  }
}

/** The wire's reset codes (`spec/wire.md`); the app's own words map onto them. */
const WIRE_CODES = new Set([
  'no_error',
  'protocol_error',
  'flow_control',
  'stream_closed',
  'not_authorized',
  'refused_stream',
  'cancelled',
  'internal_error'
])
function wireCode(code: string): string {
  if (WIRE_CODES.has(code)) return code
  if (code === 'refused' || code === 'forbidden') return 'refused_stream'
  if (code === 'internal' || code === 'storage_corrupt') return 'internal_error'
  if (code === 'bad_message' || code === 'bad_request') return 'protocol_error'
  return 'cancelled'
}

/**
 * A helper's error reply as a Net error: its code when the app knows it, with its reason; `details.helper` is the
 * helper's code and `details.why` the cause it named (a dial's SSH refusal, say).
 */
function helperError(code: string, reason?: string, why?: string): NetError {
  const cause = why ? { why } : {}
  try {
    return new NetError(code as never, undefined, { details: { ...(reason ? { reason } : {}), helper: code, ...cause } })
  } catch {
    return new NetError('internal', reason, { details: { reason: code, helper: code, ...cause } })
  }
}

/** The cause a helper's error reply named (`why`), if any. */
export function helperWhy(error: unknown): string | undefined {
  const why = (error as { details?: { why?: unknown } } | undefined)?.details?.why
  return typeof why === 'string' ? why : undefined
}

/** The helper's own code for an error its reply carried. */
export function helperCode(error: unknown): string | undefined {
  const helper = (error as { details?: { helper?: unknown } } | undefined)?.details?.helper
  return typeof helper === 'string' ? helper : undefined
}
