/**
 * Globally monotonic event sequence with bounded in-memory replay ring.
 */

import type { ProtocolEvent } from './types'
import { MMS_PROTOCOL_REPLAY_RING_SIZE } from './types'

export class EventSequenceRing {
  private sequence = 0
  private readonly ring: ProtocolEvent[] = []
  private readonly maxSize: number

  constructor(maxSize = MMS_PROTOCOL_REPLAY_RING_SIZE) {
    this.maxSize = maxSize
  }

  get currentSequence(): number {
    return this.sequence
  }

  /** Append an event; returns the assigned sequence. */
  push(type: string, data: unknown, threadId?: string): ProtocolEvent {
    this.sequence += 1
    const event: ProtocolEvent = {
      kind: 'event',
      sequence: this.sequence,
      type,
      threadId,
      data,
      ts: new Date().toISOString()
    }
    this.ring.push(event)
    while (this.ring.length > this.maxSize) {
      this.ring.shift()
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
    const oldest = this.ring[0].sequence
    if (afterSeq < oldest - 1) {
      return { gap: true, events: [...this.ring] }
    }
    return {
      gap: false,
      events: this.ring.filter((e) => e.sequence > afterSeq)
    }
  }
}
