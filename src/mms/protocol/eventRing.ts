/**
 * Globally monotonic event sequence with bounded in-memory replay ring.
 */

import type { ProtocolEvent } from './types'
import { MMS_PROTOCOL_REPLAY_RING_BYTES, MMS_PROTOCOL_REPLAY_RING_SIZE } from './types'

/**
 * Events that carry the whole state of what they name, keyed by that thing: a newer one makes an older one with the
 * same key useless for replay. A streaming reply sends its whole message about 20 times a second, so without this the
 * ring held hundreds of copies of the same growing reply, thinking or tool output (several MB per turn) long after
 * the turn ended. `thread.messages` carries a thread's whole visible transcript, sharing its message objects with the
 * live session, so each older copy kept a released thread's transcript in memory.
 */
function supersededKey(type: string, data: unknown, threadId?: string): string | undefined {
  if (type === 'threads.updated') return type
  // A thread's row carries its whole state: a later row of the same thread replaces it (a list sent between them
  // holds an older state still, so the later row is applied after it).
  if (type === 'threads.row') return `${type}\0${threadId ?? ''}`
  if (type === 'thread.messages') return `${type}\0${threadId ?? ''}`
  if (type !== 'thread.message-updated') return undefined
  const id = (data as { message?: { id?: unknown } } | null | undefined)?.message?.id
  return typeof id === 'string' ? `${type}\0${threadId ?? ''}\0${id}` : undefined
}

/**
 * A replacement (`replace: true`, after an undo or an edit) drops messages a client still shows; a plain list is
 * merged into what the client has. When a plain list supersedes a replacement, the one kept must still replace, or a
 * client that missed both would keep the dropped messages.
 */
function carriedForward(type: string, older: ProtocolEvent, data: unknown): unknown {
  if (type !== 'thread.messages') return data
  if ((older.data as { replace?: unknown } | null)?.replace !== true) return data
  if (!isRecord(data) || data.replace === true) return data
  return { ...data, replace: true }
}

/**
 * An event's measured size. The objects directly in its data (a message, each message of a list, each thread of the
 * thread list) are the parts other events may hold too; the ring counts each part once however many events hold it.
 */
interface Measure {
  own: number
  parts: object[]
}

export class EventSequenceRing {
  private sequence = 0
  private readonly ring: ProtocolEvent[] = []
  private readonly maxSize: number
  private readonly maxBytes: number
  /** The newest retained event per `supersededKey`. */
  private readonly latest = new Map<string, ProtocolEvent>()
  private readonly keys = new WeakMap<ProtocolEvent, string>()
  /** The newest sequence dropped for space; replay from before it has a gap. Superseded events leave no gap. */
  private evictedThrough = 0
  /** The retained events' estimated size: each event's own bytes, plus each shared part once. */
  private bytes = 0
  private readonly measures = new WeakMap<ProtocolEvent, Measure>()
  /** Parts the retained events hold, with their latest measured size and how many events hold them. */
  private readonly parts = new Map<object, { size: number; refs: number }>()

  constructor(maxSize = MMS_PROTOCOL_REPLAY_RING_SIZE, maxBytes = MMS_PROTOCOL_REPLAY_RING_BYTES) {
    this.maxSize = maxSize
    this.maxBytes = maxBytes
  }

  get currentSequence(): number {
    return this.sequence
  }

  /** Number of retained events. */
  get size(): number {
    return this.ring.length
  }

  /**
   * About how many bytes the retained events hold: string lengths and a few bytes a value, no JSON text made. An
   * object several events share (a message in a streaming update and in the thread's list) counts once. Each event is
   * measured as it arrives, so this is a running total.
   */
  approximateBytes(): number {
    return this.bytes
  }

  /** Append an event; returns the assigned sequence. */
  push(type: string, data: unknown, threadId?: string, profileId?: string): ProtocolEvent {
    this.sequence += 1
    const event: ProtocolEvent = {
      kind: 'event',
      sequence: this.sequence,
      type,
      threadId,
      profileId,
      data,
      ts: new Date().toISOString()
    }
    // A ring that keeps nothing only numbers events.
    if (this.maxSize <= 0) {
      this.evictedThrough = event.sequence
      return event
    }
    let stored = event
    const key = supersededKey(type, data, threadId)
    if (key !== undefined) {
      const older = this.latest.get(key)
      if (older) {
        const index = this.ring.lastIndexOf(older)
        if (index !== -1) {
          this.ring.splice(index, 1)
          this.release(older)
        }
        const carried = carriedForward(type, older, data)
        if (carried !== data) stored = { ...event, data: carried }
      }
      this.latest.set(key, stored)
      this.keys.set(stored, key)
    }
    this.measures.set(stored, this.measure(stored.data))
    this.ring.push(stored)
    while (this.ring.length > this.maxSize || (this.bytes > this.maxBytes && this.ring.length > 0)) {
      const evicted = this.ring.shift()!
      this.release(evicted)
      this.evictedThrough = evicted.sequence
      const evictedKey = this.keys.get(evicted)
      if (evictedKey !== undefined && this.latest.get(evictedKey) === evicted) this.latest.delete(evictedKey)
    }
    return event
  }

  /**
   * Events with sequence > afterSeq, in order.
   * If afterSeq is older than the ring, returns { gap: true, events: all retained }.
   */
  replayAfter(afterSeq: number): { gap: boolean; events: ProtocolEvent[] } {
    // An event too large for the byte budget leaves at once, so an empty ring can still have dropped what a client needs.
    if (afterSeq < this.evictedThrough) {
      return { gap: true, events: [...this.ring] }
    }
    return {
      gap: false,
      events: this.ring.filter((e) => e.sequence > afterSeq)
    }
  }

  private measure(data: unknown): Measure {
    const parts: object[] = []
    if (!isRecord(data)) {
      const own = approximateSize(data, 0)
      this.bytes += own
      return { own, parts }
    }
    let own = 2
    for (const [key, value] of Object.entries(data)) {
      own += key.length + 2
      if (Array.isArray(value)) {
        own += 2
        for (const item of value) {
          own += 1
          if (isRecord(item)) this.hold(item, parts)
          else own += approximateSize(item, 2)
        }
      } else if (isRecord(value)) {
        this.hold(value, parts)
      } else {
        own += approximateSize(value, 1)
      }
    }
    this.bytes += own
    return { own, parts }
  }

  /** Counts a part once for the ring. It is measured again each time an event holds it, since live objects change. */
  private hold(part: object, parts: object[]): void {
    const size = approximateSize(part, 2)
    const entry = this.parts.get(part)
    if (entry) {
      this.bytes += size - entry.size
      entry.size = size
      entry.refs += 1
    } else {
      this.parts.set(part, { size, refs: 1 })
      this.bytes += size
    }
    parts.push(part)
  }

  private release(event: ProtocolEvent): void {
    const measure = this.measures.get(event)
    if (!measure) return
    this.measures.delete(event)
    this.bytes -= measure.own
    for (const part of measure.parts) {
      const entry = this.parts.get(part)
      if (!entry) continue
      entry.refs -= 1
      if (entry.refs > 0) continue
      this.parts.delete(part)
      this.bytes -= entry.size
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A value's rough size: string lengths, 8 bytes a number, and the keys of objects. */
function approximateSize(value: unknown, depth: number): number {
  if (typeof value === 'string') return value.length
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  if (!value || typeof value !== 'object' || depth > 32) return 4
  let size = 2
  if (Array.isArray(value)) {
    for (const item of value) size += approximateSize(item, depth + 1) + 1
    return size
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) size += key.length + approximateSize(item, depth + 1) + 2
  return size
}
