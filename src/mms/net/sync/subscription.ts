import { NetError } from '../../../shared/net/errors'
import type { StoredRecord, StreamHead, StreamId } from '../../../shared/net'
import { OVERLAP_BUFFER_MAX_BYTES, OVERLAP_BUFFER_MAX_RECORDS } from '../../../shared/net/limits'
import type { SnapshotStage, StreamStore, SubscriptionHandlers } from '../contracts'
import { decodeEnvelope } from './codec'

export function sameRecord(a: StoredRecord, b: StoredRecord): boolean {
  return a.epoch === b.epoch && a.seq === b.seq && a.recvTs === b.recvTs &&
    Buffer.from(a.envelope).equals(b.envelope) && Buffer.from(a.sig).equals(b.sig)
}

/** A subscription attempt never promotes an advertised head into a durable cursor. */
export class SubscriptionReceiver {
  private head?: StreamHead
  private overlap = new Map<number, StoredRecord>()
  private overlapBytes = 0
  private caught = false
  private notified = false
  private stage?: SnapshotStage
  private snapshotTarget?: StreamHead
  private snapshotExpected?: StreamHead
  constructor(
    readonly stream: StreamId,
    private readonly store: StreamStore,
    private readonly handlers: SubscriptionHandlers,
    private readonly verify: (record: StoredRecord, snapshot: boolean) => void,
    private readonly request: (snapshot: boolean) => void
  ) {}

  subscribed(head: StreamHead, replayThrough: number): void {
    if (replayThrough !== head.seq) throw new NetError('bad_request')
    const cursor = this.store.cursor(this.stream)
    if (cursor.epoch !== head.epoch || cursor.seq > head.seq) throw new NetError('snapshot_required')
    this.clearOverlap()
    this.head = { ...head }; this.caught = false; this.notified = false
  }

  receive(records: StoredRecord[]): void {
    if (!this.head || this.stage) throw new NetError('bad_request', 'Events outside a subscribed attempt.')
    for (const record of records) {
      const cursor = this.store.cursor(this.stream)
      if (record.epoch !== cursor.epoch) throw new NetError('snapshot_required')
      this.verify(record, false)
      const envelope = decodeEnvelope(record.envelope).envelope
      if (envelope.stream !== this.stream) throw new NetError('bad_request')
      if (record.seq <= cursor.seq) {
        const existing = this.store.getById(this.stream, envelope.id)
        if (!existing || !sameRecord(existing, record)) throw new NetError('conflict', 'Conflicting committed overlap.')
        continue
      }
      const prior = this.overlap.get(record.seq)
      if (prior) {
        if (!sameRecord(prior, record)) throw new NetError('conflict', 'Conflicting buffered overlap.')
        continue
      }
      const bytes = record.envelope.length + record.sig.length
      if (record.seq !== cursor.seq + 1 && (this.overlap.size >= OVERLAP_BUFFER_MAX_RECORDS || this.overlapBytes + bytes > OVERLAP_BUFFER_MAX_BYTES)) {
        this.restart(); return
      }
      this.overlap.set(record.seq, record); this.overlapBytes += bytes
      this.drain()
    }
    this.notifyCaught()
  }

  caughtUp(): void {
    if (!this.head || this.stage) throw new NetError('bad_request')
    this.caught = true
    if (this.store.cursor(this.stream).seq < this.head.seq) { this.restart(); return }
    this.notifyCaught()
  }

  snapshotRequired(target: StreamHead): void {
    this.stage?.abort(); this.stage = undefined
    this.clearOverlap(); this.head = undefined; this.snapshotTarget = { ...target }; this.snapshotExpected = undefined
    this.request(true)
  }

  snapshotChunk(target: StreamHead, records: StoredRecord[], done: boolean): void {
    if (!this.snapshotTarget || target.epoch !== this.snapshotTarget.epoch || (this.stage ? target.seq !== this.snapshotTarget.seq : target.seq < this.snapshotTarget.seq)) throw new NetError('conflict', 'Snapshot target changed.')
    if (!this.stage) { this.snapshotTarget = { ...target }; this.stage = this.store.beginSnapshot(this.stream, target) }
    try {
      for (const record of records) {
        this.verify(record, true)
        const envelope = decodeEnvelope(record.envelope).envelope
        if (envelope.stream !== this.stream) throw new NetError('bad_request')
        if (this.snapshotExpected && (record.epoch < this.snapshotExpected.epoch ||
          (record.epoch === this.snapshotExpected.epoch && record.seq !== this.snapshotExpected.seq + 1) ||
          (record.epoch > this.snapshotExpected.epoch && record.seq !== 1))) throw new NetError('conflict', 'Snapshot chunk sequence gap.')
        this.snapshotExpected = { epoch: record.epoch, seq: record.seq }
      }
      let batch: StoredRecord[] = [], bytes = 0
      for (const record of records) {
        const size = record.envelope.length + record.sig.length
        if (batch.length && (batch.length === 499 || bytes + size > 1024 * 1024 - 64 * 1024)) { this.stage.append(batch); batch = []; bytes = 0 }
        batch.push(record); bytes += size
      }
      if (batch.length) this.stage.append(batch)
      if (done) {
        const cursor = this.stage.commit()
        this.stage = undefined; this.snapshotTarget = undefined; this.snapshotExpected = undefined
        this.handlers.onSnapshotInstalled(cursor)
        this.restart()
      }
    } catch (error) { this.stage?.abort(); this.stage = undefined; throw error }
  }

  close(): void {
    this.stage?.abort(); this.stage = undefined; this.snapshotTarget = undefined
    this.snapshotExpected = undefined; this.head = undefined; this.clearOverlap()
  }
  error(code: import('../../../shared/net/errors').NetErrorCode): void { this.close(); this.handlers.onError(code) }
  private clearOverlap(): void { this.overlap.clear(); this.overlapBytes = 0 }
  private restart(): void { this.close(); this.caught = false; this.notified = false; this.request(false) }
  private drain(): void {
    for (;;) {
      const next = this.overlap.get(this.store.cursor(this.stream).seq + 1)
      if (!next) return
      this.store.applyFromAuthority(this.stream, [next])
      this.overlap.delete(next.seq); this.overlapBytes -= next.envelope.length + next.sig.length
      this.handlers.onRecord(next)
    }
  }
  private notifyCaught(): void {
    if (this.caught && !this.notified && this.head && this.store.cursor(this.stream).seq >= this.head.seq) {
      this.notified = true; this.handlers.onCaughtUp()
    }
  }
}
