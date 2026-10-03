import type { Outbox, OutboxEntry } from '../contracts'
import type { EventId, NetErrorCode, StreamId } from '../../../shared/net'
import { isNetErrorCode } from '../../../shared/net'
import { decodeEnvelope } from '../sync/codec'
import { NetDatabase, fail, integer } from './database'

export class SqliteOutbox implements Outbox {
  private listeners = new Set<(entry: OutboxEntry) => void>()
  constructor(private readonly db: NetDatabase) {}
  enqueue(entry: Pick<OutboxEntry, 'id' | 'stream' | 'envelope' | 'sig'>): void {
    const { envelope } = decodeEnvelope(entry.envelope)
    if (envelope.id !== entry.id || envelope.stream !== entry.stream || entry.sig.length !== 64) fail('bad_request', 'Outbox binding or signature length is invalid.')
    this.db.transaction(() => {
      const previous = this.get(entry.id)
      if (previous) {
        if (previous.stream !== entry.stream || !Buffer.from(previous.envelope).equals(entry.envelope) || !Buffer.from(previous.sig).equals(entry.sig)) fail('conflict', 'Outbox id has different signed bytes.')
        return
      }
      const stream = this.db.database.prepare('SELECT space_id FROM net_streams WHERE id=?').get(entry.stream)
      if (!stream) fail('stream_unknown', 'Outbox requires a registered stream.')
      this.db.charge(1, entry.envelope.byteLength + entry.sig.byteLength)
      this.db.database.prepare("INSERT INTO net_outbox VALUES(?,?,?,?,?,'pending',0,?,NULL,NULL,NULL)").run(entry.id, entry.stream, stream.space_id, entry.envelope, entry.sig, integer(this.db.clock.now()))
      this.db.checkpoint('outbox.enqueue.beforeCommit')
      this.notify(entry.id)
    })
  }
  due(stream: StreamId): OutboxEntry[] { return this.rows("SELECT * FROM net_outbox WHERE stream=? AND state IN ('pending','unknown') ORDER BY created_at,id", stream) }
  markAttempt(id: EventId): void {
    this.db.transaction(() => {
      const entry = this.required(id)
      if (entry.state === 'sent' || entry.state === 'failed') return
      this.db.charge(1)
      this.db.database.prepare("UPDATE net_outbox SET state='unknown',attempts=? WHERE id=?").run(integer(entry.attempts + 1), id)
      this.notify(id)
    })
  }
  markSent(id: EventId, position: { epoch: number; seq: number }): void {
    integer(position.epoch, 1); integer(position.seq, 1)
    this.db.transaction(() => {
      const entry = this.required(id)
      if (entry.state === 'sent') {
        if (entry.position!.epoch !== position.epoch || entry.position!.seq !== position.seq) fail('conflict', 'Outbox acknowledgement position changed.')
        return
      }
      if (entry.state === 'failed') fail('conflict', 'A terminally rejected event cannot become sent.')
      this.db.charge(1)
      this.db.database.prepare("UPDATE net_outbox SET state='sent',epoch=?,seq=? WHERE id=?").run(position.epoch, position.seq, id)
      this.notify(id)
    })
  }
  markFailed(id: EventId, error: NetErrorCode): void {
    if (!isNetErrorCode(error)) fail('bad_request', 'Unknown outbox error code.')
    this.db.transaction(() => {
      const entry = this.required(id)
      if (entry.state === 'failed') { if (entry.error !== error) fail('conflict', 'Terminal rejection changed.'); return }
      if (entry.state === 'sent') fail('conflict', 'An acknowledged event cannot become failed.')
      this.db.charge(1)
      this.db.database.prepare("UPDATE net_outbox SET state='failed',error=? WHERE id=?").run(error, id)
      this.notify(id)
    })
  }
  get(id: EventId): OutboxEntry | undefined {
    const row = this.db.database.prepare('SELECT * FROM net_outbox WHERE id=?').get(id)
    return row ? this.entry(row) : undefined
  }
  list(stream: StreamId): OutboxEntry[] { return this.rows('SELECT * FROM net_outbox WHERE stream=? ORDER BY created_at,id', stream) }
  onChanged(listener: (entry: OutboxEntry) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private required(id: EventId): OutboxEntry { return this.get(id) ?? fail('bad_request', 'Unknown outbox event.') }
  private rows(sql: string, stream: StreamId): OutboxEntry[] { return this.db.database.prepare(sql).all(stream).map((row) => this.entry(row)) }
  private entry(row: Record<string, any>): OutboxEntry {
    return { id: row.id, stream: row.stream, envelope: new Uint8Array(row.envelope), sig: new Uint8Array(row.sig), state: row.state, attempts: row.attempts, createdAt: row.created_at,
      ...(row.error === null ? {} : { error: row.error }), ...(row.epoch === null ? {} : { position: { epoch: row.epoch, seq: row.seq } }) }
  }
  private notify(id: EventId): void {
    const entry = this.required(id)
    this.db.afterCommit(() => { for (const listener of this.listeners) { try { listener(entry) } catch { /* Other observers still receive this durable notification. */ } } })
  }
}
