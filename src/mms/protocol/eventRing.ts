/**
 * Globally monotonic event sequence with bounded in-memory replay ring.
 */

import type { ProtocolEvent } from './types'
import { MMS_PROTOCOL_REPLAY_RING_SIZE } from './types'

/**
 * Events that carry the whole state of what they name, keyed by that thing: a newer one makes an older one with the
 * same key useless for replay. A streaming reply sends its whole message about 20 times a second, so without this the
 * ring held hundreds of copies of the same growing reply, thinking or tool output (several MB per turn) long after
 * the turn ended.
 */
function supersededKey(type: string, data: unknown, threadId?: string): string | undefined {
  if (type === 'threads.updated') return type
  if (type !== 'thread.message-updated') return undefined
  const id = (data as { message?: { id?: unknown } } | null | undefined)?.message?.id
  return typeof id === 'string' ? `${type}\0${threadId ?? ''}\0${id}` : undefined
}

export class EventSequenceRing {
  private sequence = 0
  private readonly ring: ProtocolEvent[] = []
  private readonly maxSize: number
  /** The newest retained event per `supersededKey`. */
  private readonly latest = new Map<string, ProtocolEvent>()
  private readonly keys = new WeakMap<ProtocolEvent, string>()
  /** The newest sequence dropped for space; replay from before it has a gap. Superseded events leave no gap. */
  private evictedThrough = 0

  constructor(maxSize = MMS_PROTOCOL_REPLAY_RING_SIZE) {
    this.maxSize = maxSize
  }

  get currentSequence(): number {
    return this.sequence
  }

  /** Number of retained events. */
  get size(): number {
    return this.ring.length
  }

  /** The retained events' size as JSON text, in UTF-16 code units (about bytes for ASCII). */
  approximateBytes(): number {
    let bytes = 0
    for (const event of this.ring) {
      try {
        bytes += JSON.stringify(event.data)?.length ?? 0
      } catch {
        // An event that cannot be encoded is not counted.
      }
    }
    return bytes
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
    const key = supersededKey(type, data, threadId)
    if (key !== undefined) {
      const older = this.latest.get(key)
      if (older) {
        const index = this.ring.lastIndexOf(older)
        if (index !== -1) this.ring.splice(index, 1)
      }
      this.latest.set(key, event)
      this.keys.set(event, key)
    }
    this.ring.push(event)
    while (this.ring.length > this.maxSize) {
      const evicted = this.ring.shift()!
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
    if (this.ring.length === 0) {
      return { gap: false, events: [] }
    }
    if (afterSeq < this.evictedThrough) {
      return { gap: true, events: [...this.ring] }
    }
    return {
      gap: false,
      events: this.ring.filter((e) => e.sequence > afterSeq)
    }
  }
}
