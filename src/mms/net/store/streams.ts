import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AppendInput,
  AppendOutcome,
  ReplayPage,
  SnapshotReader,
  SnapshotStage,
  StreamStore
} from '../contracts'
import { decodeEnvelope } from '../sync/codec'
import { validateStreamDescriptor } from '../../../shared/net/schemas'
import {
  MAX_SEQ,
  NetError,
  STORE_TXN_MAX_BYTES,
  STORE_TXN_MAX_ROWS,
  isId
} from '../../../shared/net'
import type {
  Cursor,
  EventId,
  SnapshotReason,
  SpaceId,
  StoredRecord,
  StreamDescriptor,
  StreamHead,
  StreamId
} from '../../../shared/net'
import { NetDatabase, digest, fail, integer, json, same } from './database'

type Row = Record<string, any>
/** Validate/authenticate one bounded prefix extension. Carry must be JSON,
 * <=64 KiB, and sufficient to check the next batch without rescanning history.
 * This port must not perform unbounded I/O or accumulate the full history. */
export interface MetaSnapshotValidator {
  /** Reserve transaction rows for projection writes in addition to stream records. */
  readonly maxRecordsPerAppend?: number
  /** Private histories require a composed authenticated control validator too. */
  supports?(descriptor: StreamDescriptor): boolean
  append(
    records: readonly StoredRecord[],
    descriptor: StreamDescriptor,
    target: StreamHead,
    carry: unknown
  ): unknown
  /** Check that the bounded persisted carry proves the complete target. */
  finish(carry: unknown, descriptor: StreamDescriptor, target: StreamHead): void
}
interface SnapshotProgress {
  guard: string
  last: StreamHead | null
  firstSeq: number | null
  carry: unknown
  metaValidated: boolean
}
const sourceReaders = new Set<SnapshotReader>()
function streamGuard(row: Row): string {
  return json([row.active_generation, row.epoch, row.cursor, row.head, row.retained])
}

export function validateRecord(stream: StreamId, record: StoredRecord): EventId {
  integer(record.epoch, 1)
  integer(record.seq, 1)
  integer(record.recvTs)
  if (!(record.sig instanceof Uint8Array) || record.sig.length !== 64)
    fail('bad_request', 'Expected a detached 64-byte signature.')
  const { envelope } = decodeEnvelope(record.envelope)
  if (envelope.stream !== stream) fail('bad_request', 'Record belongs to another stream.')
  return envelope.id
}
function stored(row: Row): StoredRecord {
  return {
    epoch: row.epoch,
    seq: row.seq,
    recvTs: row.recv_ts,
    envelope: new Uint8Array(row.envelope),
    sig: new Uint8Array(row.sig)
  }
}
function bounded(records: StoredRecord[]): void {
  if (
    records.length > STORE_TXN_MAX_ROWS ||
    records.reduce((n, r) => n + r.envelope.byteLength + r.sig.byteLength, 0) > STORE_TXN_MAX_BYTES
  )
    fail('too_large', 'Record batch exceeds transaction bounds.')
}

export class SqliteStreamStore implements StreamStore {
  private readers = new Set<SnapshotReader>()
  constructor(
    private readonly db: NetDatabase,
    private readonly validateMeta?: MetaSnapshotValidator,
    private readonly afterStored?: (record: StoredRecord, descriptor: StreamDescriptor) => void
  ) {
    if (
      validateMeta?.maxRecordsPerAppend !== undefined &&
      integer(validateMeta.maxRecordsPerAppend, 1) > STORE_TXN_MAX_ROWS - 1
    )
      fail('bad_request', 'Invalid meta snapshot batch limit.')
    db.database.exec(
      'CREATE TABLE IF NOT EXISTS net_space_archive_hidden(stream TEXT PRIMARY KEY REFERENCES net_streams(id),operation TEXT NOT NULL) STRICT'
    )
  }

  snapshotBatchLimit(stream: StreamId): number {
    return ['space.meta', 'space.private'].includes(this.row(stream).kind)
      ? (this.validateMeta?.maxRecordsPerAppend ?? STORE_TXN_MAX_ROWS - 1)
      : STORE_TXN_MAX_ROWS - 1
  }

  createStream(descriptor: StreamDescriptor, epoch: number): void {
    integer(epoch, 1)
    if (!validateStreamDescriptor(descriptor)) fail('bad_request', 'Invalid stream descriptor.')
    this.db.transaction(() => {
      const previous = this.db.database
        .prepare('SELECT descriptor,epoch FROM net_streams WHERE id=?')
        .get(descriptor.id)
      if (previous) {
        if (
          this.db.database
            .prepare('SELECT 1 FROM net_space_archive_hidden WHERE stream=?')
            .get(descriptor.id)
        )
          fail('conflict', 'Stream identity belongs to a quarantined archive import.')
        if (
          !same(JSON.parse(previous.descriptor as string), descriptor) ||
          previous.epoch !== epoch
        )
          fail('conflict', 'Stream identity is already bound.')
        return
      }
      const gen = randomUUID()
      this.db.charge(2, Buffer.byteLength(json(descriptor)))
      this.db.database
        .prepare('INSERT INTO net_streams VALUES(?,?,?,?,?,0,0,0,?)')
        .run(descriptor.id, json(descriptor), descriptor.space ?? null, descriptor.kind, epoch, gen)
      this.db.database
        .prepare("INSERT INTO net_generations VALUES(?,?,'active',?,0,0)")
        .run(gen, descriptor.id, epoch)
    })
  }
  getStream(id: StreamId): StreamDescriptor | undefined {
    const row = this.db.database
      .prepare(
        'SELECT descriptor FROM net_streams WHERE id=? AND id NOT IN (SELECT stream FROM net_space_archive_hidden)'
      )
      .get(id)
    return row ? JSON.parse(row.descriptor as string) : undefined
  }
  listStreams(filter?: { space?: SpaceId; kind?: StreamDescriptor['kind'] }): StreamDescriptor[] {
    return this.db.database
      .prepare(
        'SELECT descriptor FROM net_streams WHERE (? IS NULL OR space_id=?) AND (? IS NULL OR kind=?) AND id NOT IN (SELECT stream FROM net_space_archive_hidden) ORDER BY id'
      )
      .all(filter?.space ?? null, filter?.space ?? null, filter?.kind ?? null, filter?.kind ?? null)
      .map((r) => JSON.parse(r.descriptor as string))
  }
  head(stream: StreamId): StreamHead {
    const r = this.row(stream)
    return { epoch: r.epoch, seq: r.head }
  }
  cursor(stream: StreamId): Cursor {
    const r = this.row(stream)
    return { stream, epoch: r.epoch, seq: r.cursor }
  }

  appendAsAuthority(stream: StreamId, input: AppendInput): AppendOutcome {
    if (!isId('event', input.id)) fail('bad_request', 'Invalid event identity.')
    return this.db.transaction(() => {
      const r = this.row(stream)
      const rec: StoredRecord = {
        epoch: r.epoch,
        seq: integer(r.head === MAX_SEQ ? r.head : r.head + 1, 1),
        recvTs: input.recvTs,
        envelope: input.envelope,
        sig: input.sig
      }
      if (validateRecord(stream, rec) !== input.id)
        fail('bad_request', 'Append identity does not match its envelope.')
      const previous = this.known(stream, input.id)
      if (previous) {
        this.matchBytes(previous, rec)
        return {
          kind: 'duplicate',
          epoch: previous.epoch,
          seq: previous.seq,
          recvTs: previous.recv_ts
        }
      }
      if (r.head === MAX_SEQ)
        fail('conflict', 'Stream sequence is exhausted; authority must stop writing.')
      this.insert(r.active_generation, stream, rec, input.id, false)
      this.db.charge(1)
      this.db.database
        .prepare('UPDATE net_streams SET head=?,cursor=? WHERE id=?')
        .run(rec.seq, rec.seq, stream)
      this.db.checkpoint('streams.append.beforeCursorCommit')
      return { kind: 'stored', epoch: rec.epoch, seq: rec.seq, recvTs: rec.recvTs }
    })
  }

  applyFromAuthority(stream: StreamId, records: StoredRecord[]): Cursor {
    bounded(records)
    return this.db.transaction(() => {
      const r = this.row(stream)
      let cursor = r.cursor
      for (const record of records) {
        const id = validateRecord(stream, record)
        if (record.epoch !== r.epoch)
          fail('snapshot_required', 'Record epoch differs from the active cursor.')
        if (record.seq <= cursor) {
          const previous = this.db.database
            .prepare('SELECT * FROM net_records WHERE generation=? AND epoch=? AND seq=?')
            .get(r.active_generation, record.epoch, record.seq)
          if (!previous) fail('snapshot_required', 'Duplicate position is no longer retained.')
          this.matchRecord(previous, record, id)
          continue
        }
        if (record.seq !== cursor + 1)
          fail('snapshot_required', 'Record would skip the contiguous cursor.')
        const previous = this.known(stream, id)
        if (previous) this.matchRecord(previous, record, id)
        this.insert(r.active_generation, stream, record, id, false)
        this.afterStored?.(record, JSON.parse(r.descriptor))
        cursor = record.seq
      }
      if (cursor !== r.cursor) {
        this.db.charge(1)
        this.db.database
          .prepare('UPDATE net_streams SET head=?,cursor=? WHERE id=?')
          .run(Math.max(r.head, cursor), cursor, stream)
        this.db.checkpoint('streams.apply.beforeCursorCommit')
      }
      return { stream, epoch: r.epoch, seq: cursor }
    })
  }

  snapshotReason(stream: StreamId, after: StreamHead): SnapshotReason | undefined {
    integer(after.epoch, 1)
    integer(after.seq)
    const r = this.row(stream)
    if (after.epoch !== r.epoch) return 'epochChanged'
    if (after.seq > r.head) return 'cursorAhead'
    if (after.seq < r.retained) return 'cursorTooOld'
    return undefined
  }
  read(stream: StreamId, after: StreamHead, through: number, budgetBytes: number): ReplayPage {
    integer(through)
    integer(budgetBytes, 1)
    const reason = this.snapshotReason(stream, after)
    if (reason) throw new NetError('snapshot_required', reason)
    const r = this.row(stream)
    if (through > r.head || through < after.seq)
      fail('bad_request', 'Replay range is outside the pinned head.')
    if (through === after.seq) return { records: [], done: true }
    const rows = this.db.database
      .prepare(
        'SELECT * FROM net_records WHERE generation=? AND epoch=? AND seq>? AND seq<=? ORDER BY seq LIMIT 499'
      )
      .all(r.active_generation, r.epoch, after.seq, through)
    const records = this.page(
      rows,
      Math.min(budgetBytes, STORE_TXN_MAX_BYTES),
      STORE_TXN_MAX_ROWS - 1
    )
    let expected = after.seq + 1
    for (const rec of records)
      if (rec.seq !== expected++) fail('snapshot_required', 'Replay contains a retention gap.')
    if (!records.length) fail('snapshot_required', 'Replay prefix is not retained.')
    return { records, done: records.at(-1)!.seq === through }
  }

  openSnapshot(stream: StreamId): SnapshotReader {
    if (sourceReaders.size >= 32) fail('rate_limited', 'Too many open snapshot source readers.')
    // A read-only WAL transaction pins the generation and bytes even while a
    // writer appends, truncates or switches its active pointer.
    const connection = new DatabaseSync(this.db.path, { readOnly: true })
    try {
      connection.exec('BEGIN')
      const r = connection
        .prepare(
          'SELECT * FROM net_streams WHERE id=? AND id NOT IN (SELECT stream FROM net_space_archive_hidden)'
        )
        .get(stream) as Row | undefined
      if (!r) fail('stream_unknown', 'Unknown stream.')
      const reader = this.reader(
        connection,
        r.active_generation,
        { epoch: r.epoch, seq: r.head },
        r.kind === 'space.meta',
        () => {
          try {
            connection.exec('ROLLBACK')
          } finally {
            connection.close()
            this.readers.delete(reader)
            sourceReaders.delete(reader)
          }
        }
      )
      this.readers.add(reader)
      sourceReaders.add(reader)
      return reader
    } catch (error) {
      connection.close()
      throw error
    }
  }
  close(): void {
    for (const reader of [...this.readers]) reader.close()
  }

  beginSnapshot(stream: StreamId, target: StreamHead): SnapshotStage {
    target = { ...target }
    integer(target.epoch, 1)
    integer(target.seq)
    const initial = this.row(stream)
    if (
      target.epoch < initial.epoch ||
      (target.epoch === initial.epoch && target.seq < initial.cursor)
    )
      fail('conflict', 'Snapshot would decrease the current cursor.')
    const generation = randomUUID()
    this.db.transaction(() => {
      const count = this.db.database
        .prepare("SELECT count(*) AS n FROM net_generations WHERE state='staging'")
        .get()!.n as number
      if (count >= 8) fail('rate_limited', 'Too many incomplete snapshot stages.')
      this.db.charge(2)
      this.db.database
        .prepare("INSERT INTO net_generations VALUES(?,?,'staging',?,?,1)")
        .run(generation, stream, target.epoch, target.seq)
      this.db.database.prepare('INSERT INTO net_snapshot_progress VALUES(?,?)').run(
        generation,
        json({
          guard: streamGuard(initial),
          last: null,
          firstSeq: null,
          carry: null,
          metaValidated: false
        } satisfies SnapshotProgress)
      )
    })
    let finished = false
    const active = (): void => {
      if (
        finished ||
        !this.db.database
          .prepare("SELECT id FROM net_generations WHERE id=? AND state='staging'")
          .get(generation)
      )
        fail('conflict', 'Snapshot stage is no longer active.')
    }
    return {
      append: (records) => {
        active()
        bounded(records)
        if (records.length > this.snapshotBatchLimit(stream))
          fail('too_large', 'Snapshot append exceeds its validation transaction budget.')
        this.db.transaction(() => {
          const r = this.row(stream)
          const progress = this.progress(generation)
          if (streamGuard(r) !== progress.guard)
            fail('conflict', 'Active state changed while the snapshot was staged.')
          let last = progress.last
          for (const rec of records) {
            const id = validateRecord(stream, rec)
            if (rec.epoch > target.epoch || (rec.epoch === target.epoch && rec.seq > target.seq))
              fail('bad_request', 'Snapshot record exceeds its target.')
            if (r.kind !== 'space.meta' && rec.epoch !== target.epoch)
              fail('bad_request', 'Content snapshot cannot contain abandoned epochs.')
            if (last) {
              if (
                rec.epoch === last.epoch
                  ? rec.seq !== last.seq + 1
                  : rec.epoch <= last.epoch || rec.seq !== 1
              )
                fail('bad_request', 'Snapshot records are not ordered dense epoch prefixes.')
            } else if (r.kind === 'space.meta' && (rec.epoch !== 1 || rec.seq !== 1))
              fail('bad_request', 'Meta snapshot omits its genesis prefix.')
            const previous = this.known(stream, id)
            if (previous) this.matchRecord(previous, rec, id)
            this.matchKnownPosition(stream, rec, id)
            this.insert(generation, stream, rec, id, false)
            last = { epoch: rec.epoch, seq: rec.seq }
            if (rec.epoch === target.epoch && progress.firstSeq === null)
              progress.firstSeq = rec.seq
          }
          if (r.kind === 'space.meta' || r.kind === 'space.private') {
            if (
              !this.validateMeta ||
              this.validateMeta.supports?.(JSON.parse(r.descriptor)) === false ||
              (r.kind === 'space.private' &&
                !this.validateMeta.supports?.(JSON.parse(r.descriptor)))
            )
              fail(
                'forbidden',
                'Space snapshots require an authenticated incremental history validator.'
              )
            const carry = this.validateMeta.append(
              records,
              JSON.parse(r.descriptor),
              { ...target },
              progress.carry
            )
            if (carry && typeof (carry as { then?: unknown }).then === 'function')
              fail('bad_request', 'Meta validation must be synchronous within snapshot append.')
            progress.carry = carry
            progress.metaValidated = true
          }
          progress.last = last
          // Both records and their validation carry commit or roll back together.
          const encoded = json(progress)
          if (Buffer.byteLength(encoded) > 64 * 1024)
            fail('too_large', 'Snapshot validation progress exceeds its carry bound.')
          this.db.charge(1, Buffer.byteLength(encoded))
          this.db.database
            .prepare('UPDATE net_snapshot_progress SET progress=? WHERE generation=?')
            .run(encoded, generation)
          this.db.checkpoint('snapshot.append.beforeCommit')
        })
      },
      commit: () => {
        active()
        const cursor = this.db.transaction(() => {
          const r = this.row(stream)
          const progress = this.progress(generation)
          if (streamGuard(r) !== progress.guard)
            fail('conflict', 'Active state changed while the snapshot was staged.')
          const last = progress.last
          if (
            (!last && target.seq !== 0) ||
            (last && (last.epoch !== target.epoch || last.seq !== target.seq))
          )
            fail('bad_request', 'Snapshot does not reach its complete target.')
          if (
            (r.kind === 'space.meta' || r.kind === 'space.private') &&
            (!this.validateMeta || !progress.metaValidated)
          )
            fail(
              'forbidden',
              'Space snapshots require authenticated incremental history validation.'
            )
          if (r.kind === 'space.meta' || r.kind === 'space.private') {
            const result: unknown = this.validateMeta!.finish(
              progress.carry,
              JSON.parse(r.descriptor),
              { ...target }
            )
            if (result && typeof (result as { then?: unknown }).then === 'function')
              fail('bad_request', 'Meta completion validation must be synchronous.')
            if (streamGuard(this.row(stream)) !== progress.guard)
              fail('conflict', 'Active state changed during completion validation.')
          }
          // All record/chain work happened during bounded appends. The guard
          // prevents later committed positions from invalidating those checks.
          this.db.charge(3)
          this.db.database
            .prepare("UPDATE net_generations SET state='archived' WHERE id=?")
            .run(r.active_generation)
          this.db.database
            .prepare("UPDATE net_generations SET state='active' WHERE id=?")
            .run(generation)
          this.db.database
            .prepare(
              'UPDATE net_streams SET active_generation=?,epoch=?,head=?,cursor=?,retained=? WHERE id=?'
            )
            .run(
              generation,
              target.epoch,
              target.seq,
              target.seq,
              progress.firstSeq === null ? 0 : progress.firstSeq - 1,
              stream
            )
          this.db.checkpoint('snapshot.activate.beforeCommit')
          return { stream, epoch: target.epoch, seq: target.seq }
        })
        finished = true
        return cursor
      },
      abort: () => {
        if (finished) return
        active()
        // Bounded cleanup; the old active generation is never touched.
        for (;;) {
          const rows = this.db.database
            .prepare('SELECT rowid FROM net_records WHERE generation=? LIMIT 500')
            .all(generation)
          if (!rows.length) break
          this.db.transaction(() => {
            this.db.charge(rows.length)
            for (const row of rows)
              this.db.database.prepare('DELETE FROM net_records WHERE rowid=?').run(row.rowid!)
          })
        }
        this.db.transaction(() =>
          this.db.database.prepare('DELETE FROM net_generations WHERE id=?').run(generation)
        )
        finished = true
      }
    }
  }
  installSnapshot(
    stream: StreamId,
    epoch: number,
    throughSeq: number,
    records: StoredRecord[]
  ): Cursor {
    bounded(records)
    const stage = this.beginSnapshot(stream, { epoch, seq: throughSeq })
    try {
      let batch: StoredRecord[] = []
      let bytes = 0
      const dataBudget = STORE_TXN_MAX_BYTES - 64 * 1024
      const rowBudget = this.snapshotBatchLimit(stream)
      for (const record of records) {
        const size = record.envelope.byteLength + record.sig.byteLength
        if (size > dataBudget)
          fail('too_large', 'Snapshot record leaves no room for validation progress.')
        if (batch.length && (batch.length === rowBudget || bytes + size > dataBudget)) {
          stage.append(batch)
          batch = []
          bytes = 0
        }
        batch.push(record)
        bytes += size
      }
      if (batch.length || !records.length) stage.append(batch)
      return stage.commit()
    } catch (error) {
      try {
        stage.abort()
      } catch {
        /* Restart cleanup discards a stage if writes were suspended. */
      }
      throw error
    }
  }
  beginEpoch(space: SpaceId, epoch: number): void {
    integer(epoch, 1)
    this.db.transaction(() => {
      const rows = this.db.database
        .prepare('SELECT id,epoch FROM net_streams WHERE space_id=?')
        .all(space)
      this.db.charge(rows.length)
      for (const r of rows)
        if (epoch <= Number(r.epoch)) fail('conflict', 'Authority epoch must increase.')
      this.db.database
        .prepare('UPDATE net_streams SET epoch=?,head=0,cursor=0,retained=0 WHERE space_id=?')
        .run(epoch, space)
    })
  }
  /** Trusted controlled Space activation. Old original records remain in their
   * generation; stream identity/authority and the new cursors change together. */
  activateSpaceEpoch(
    space: SpaceId,
    epoch: number,
    authority: StreamDescriptor['authority']
  ): void {
    if (!this.db.inTransaction)
      fail('forbidden', 'Space activation requires the domain transaction.')
    integer(epoch, 1)
    const rows = this.db.database
      .prepare('SELECT id,epoch,descriptor FROM net_streams WHERE space_id=? ORDER BY id LIMIT 129')
      .all(space)
    if (!rows.length || rows.length > 128)
      fail('too_large', 'Space activation exceeds its stream bound.')
    for (const row of rows)
      if (epoch <= Number(row.epoch)) fail('conflict', 'Authority epoch must increase.')
    for (const row of rows) {
      const descriptor = { ...JSON.parse(row.descriptor as string), authority }
      this.db.charge(1, Buffer.byteLength(json(descriptor)))
      this.db.database
        .prepare(
          'UPDATE net_streams SET descriptor=?,epoch=?,head=0,cursor=0,retained=0 WHERE id=?'
        )
        .run(json(descriptor), epoch, row.id!)
    }
  }
  /** A local thread source starts a fresh display generation after daemon restart.
   * Space epochs require their owner-signed descriptor and cannot use this seam.
   */
  beginNodeEpoch(stream: StreamId, epoch: number): void {
    integer(epoch, 1)
    this.db.transaction(() => {
      const row = this.row(stream)
      if (row.kind !== 'node.thread')
        fail('forbidden', 'Only node thread display generations use this seam.')
      if (epoch <= row.epoch) fail('conflict', 'Thread generation must increase.')
      this.db.charge(1)
      this.db.database
        .prepare('UPDATE net_streams SET epoch=?,head=0,cursor=0,retained=0 WHERE id=?')
        .run(epoch, stream)
    })
  }
  truncate(stream: StreamId, throughSeq: number): void {
    integer(throughSeq)
    const initial = this.row(stream)
    if (initial.kind === 'space.meta') fail('forbidden', 'Meta history cannot be truncated.')
    if (throughSeq > initial.head) fail('bad_request', 'Retention exceeds stream head.')
    // Tombstones precede physical removal. Each bounded deletion also moves
    // retention so a crash never advertises a readable missing prefix.
    for (;;) {
      const r = this.row(stream)
      const records = this.db.database
        .prepare(
          'SELECT * FROM net_records WHERE generation=? AND epoch=? AND seq<=? ORDER BY seq LIMIT 200'
        )
        .all(r.active_generation, r.epoch, throughSeq) as Row[]
      if (!records.length) break
      this.db.transaction(() => {
        for (const record of records) {
          this.db.charge(2)
          this.db.database
            .prepare('INSERT OR IGNORE INTO net_event_ids VALUES(?,?,?,?,?,?,?)')
            .run(
              stream,
              record.id,
              record.epoch,
              record.seq,
              record.recv_ts,
              digest(record.envelope),
              digest(record.sig)
            )
          this.db.database
            .prepare('DELETE FROM net_records WHERE generation=? AND epoch=? AND seq=?')
            .run(r.active_generation, r.epoch, record.seq)
        }
        this.removeDeadBlobRefs(stream, STORE_TXN_MAX_ROWS - records.length * 2 - 1)
        this.db.charge(1)
        this.db.database
          .prepare('UPDATE net_streams SET retained=max(retained,?) WHERE id=?')
          .run(records.at(-1)!.seq, stream)
      })
    }
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare('UPDATE net_streams SET retained=max(retained,?) WHERE id=?')
        .run(throughSeq, stream)
    })
    // A single event may hold many blob references. Drain the remaining dead
    // rows in bounded transactions, retaining references to archived history.
    while (this.db.transaction(() => this.removeDeadBlobRefs(stream, STORE_TXN_MAX_ROWS)) > 0) {
      /* bounded progress */
    }
  }
  getById(stream: StreamId, id: EventId): StoredRecord | undefined {
    const r = this.row(stream)
    const row = this.db.database
      .prepare('SELECT * FROM net_records WHERE generation=? AND id=?')
      .get(r.active_generation, id)
    return row ? stored(row) : undefined
  }
  private row(stream: StreamId): Row {
    const row = this.db.database
      .prepare(
        'SELECT * FROM net_streams WHERE id=? AND id NOT IN (SELECT stream FROM net_space_archive_hidden)'
      )
      .get(stream)
    if (!row) fail('stream_unknown', 'Unknown stream.')
    return row
  }
  private known(stream: StreamId, id: EventId): Row | undefined {
    return (
      this.db.database
        .prepare('SELECT * FROM net_event_ids WHERE stream=? AND id=?')
        .get(stream, id) ??
      this.db.database
        .prepare(
          "SELECT r.* FROM net_records r JOIN net_generations g ON g.id=r.generation WHERE g.stream=? AND g.state NOT IN ('staging','archive-staging') AND r.id=? ORDER BY r.epoch,r.seq LIMIT 1"
        )
        .get(stream, id)
    )
  }
  private progress(generation: string): SnapshotProgress {
    const row = this.db.database
      .prepare('SELECT progress FROM net_snapshot_progress WHERE generation=?')
      .get(generation)
    if (!row) fail('storage_corrupt', 'Snapshot validation progress is missing.')
    return JSON.parse(row.progress as string)
  }
  private removeDeadBlobRefs(stream: StreamId, limit: number): number {
    const rows = this.db.database
      .prepare(
        "SELECT b.rowid FROM net_blob_refs b WHERE b.stream=? AND NOT EXISTS(SELECT 1 FROM net_records r JOIN net_generations g ON g.id=r.generation WHERE g.stream=b.stream AND g.state!='staging' AND r.id=b.event) LIMIT ?"
      )
      .all(stream, limit)
    this.db.charge(rows.length)
    for (const row of rows)
      this.db.database.prepare('DELETE FROM net_blob_refs WHERE rowid=?').run(row.rowid!)
    return rows.length
  }
  private matchBytes(previous: Row, record: StoredRecord): void {
    if (
      (previous.payload_hash ?? digest(previous.envelope)) !== digest(record.envelope) ||
      (previous.signature_hash ?? digest(previous.sig)) !== digest(record.sig)
    )
      fail('conflict', 'Event identity has different signed bytes.')
  }
  private matchKnownPosition(stream: StreamId, record: StoredRecord, id: EventId): void {
    for (const previous of this.db.database
      .prepare('SELECT * FROM net_event_ids WHERE stream=? AND epoch=? AND seq=?')
      .iterate(stream, record.epoch, record.seq)) {
      this.matchRecord(previous, record, id)
    }
    for (const previous of this.db.database
      .prepare(
        "SELECT r.* FROM net_records r JOIN net_generations g ON g.id=r.generation WHERE g.stream=? AND g.state!='staging' AND r.epoch=? AND r.seq=?"
      )
      .iterate(stream, record.epoch, record.seq)) {
      this.matchRecord(previous, record, id)
    }
  }
  private matchRecord(previous: Row, record: StoredRecord, id: EventId): void {
    this.matchBytes(previous, record)
    if (
      previous.id !== id ||
      previous.epoch !== record.epoch ||
      previous.seq !== record.seq ||
      previous.recv_ts !== record.recvTs
    )
      fail('conflict', 'Duplicate event has conflicting authority metadata.')
  }
  private insert(
    generation: string,
    stream: StreamId,
    rec: StoredRecord,
    id: EventId,
    tombstone: boolean
  ): void {
    this.db.charge(tombstone ? 2 : 1, rec.envelope.byteLength + rec.sig.byteLength)
    this.db.database
      .prepare('INSERT INTO net_records VALUES(?,?,?,?,?,?,?)')
      .run(generation, rec.epoch, rec.seq, id, rec.recvTs, rec.envelope, rec.sig)
    if (tombstone)
      this.db.database
        .prepare('INSERT INTO net_event_ids VALUES(?,?,?,?,?,?,?)')
        .run(stream, id, rec.epoch, rec.seq, rec.recvTs, digest(rec.envelope), digest(rec.sig))
  }
  private page(rows: Row[], budget: number, maxRows: number): StoredRecord[] {
    const result: StoredRecord[] = []
    let bytes = 0
    for (const row of rows) {
      const length = row.envelope.byteLength + row.sig.byteLength
      if (result.length && (bytes + length > budget || result.length >= maxRows)) break
      result.push(stored(row))
      bytes += length
    }
    return result
  }
  private reader(
    connection: DatabaseSync,
    gen: string,
    target: StreamHead,
    meta: boolean,
    cleanup: () => void
  ): SnapshotReader {
    let afterEpoch = 0
    let afterSeq = 0
    let closed = false
    return {
      target: Object.freeze({ ...target }),
      next: (budgetBytes, maxRows = 500) => {
        integer(budgetBytes, 1)
        integer(maxRows, 1)
        if (closed) fail('conflict', 'Snapshot reader is closed.')
        const rows = connection
          .prepare(
            'SELECT * FROM net_records WHERE generation=? AND (?=1 OR epoch=?) AND (epoch>? OR (epoch=? AND seq>?)) AND (epoch<? OR (epoch=? AND seq<=?)) ORDER BY epoch,seq LIMIT 500'
          )
          .all(
            gen,
            meta ? 1 : 0,
            target.epoch,
            afterEpoch,
            afterEpoch,
            afterSeq,
            target.epoch,
            target.epoch,
            target.seq
          ) as Row[]
        // A wire snapshot page contains one original epoch.
        const records = this.page(
          rows.filter((r) => r.epoch === rows[0]?.epoch),
          Math.min(budgetBytes, STORE_TXN_MAX_BYTES),
          Math.min(maxRows, 500)
        )
        if (records.length) {
          afterEpoch = records.at(-1)!.epoch
          afterSeq = records.at(-1)!.seq
        }
        const remaining = connection
          .prepare(
            'SELECT 1 FROM net_records WHERE generation=? AND (?=1 OR epoch=?) AND (epoch>? OR (epoch=? AND seq>?)) AND (epoch<? OR (epoch=? AND seq<=?)) LIMIT 1'
          )
          .get(
            gen,
            meta ? 1 : 0,
            target.epoch,
            afterEpoch,
            afterEpoch,
            afterSeq,
            target.epoch,
            target.epoch,
            target.seq
          )
        return { records, done: !remaining }
      },
      close: () => {
        if (!closed) {
          cleanup()
          closed = true
        }
      }
    }
  }
}
