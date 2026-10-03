import { randomUUID } from 'node:crypto'
import { NetError } from '../../../shared/net'
import type { SpaceId, StoredRecord, StreamDescriptor, StreamId } from '../../../shared/net'
import { NetDatabase, digest, json } from '../../net/store/database'
import { validateRecord } from '../../net/store/streams'
import type { VerifiedSpaceArchive, ArchiveStream } from './contracts'
import { isVerifiedSpaceArchive } from './container'

export const ARCHIVE_IMPORT_MAX_STREAMS = 64
interface Entry extends ArchiveStream {
  generation: string
  previous?: string
  guard?: string
  fresh: boolean
}
interface Plan {
  operation: string
  space: SpaceId
  digest: string
  entries: Entry[]
  complete: boolean
}
const guard = (row: Record<string, unknown>) =>
  json([row.descriptor, row.active_generation, row.epoch, row.head, row.cursor, row.retained])

/** Durable archive-held generations, distinct from disposable wire snapshots.
 * No event identity, projection, descriptor or active generation becomes visible
 * before commit. A restore retains locally held abandoned generations. */
export class SpaceImportStage {
  private constructor(
    readonly db: NetDatabase,
    readonly plan: Plan
  ) {}
  static prepare(
    db: NetDatabase,
    archive: VerifiedSpaceArchive,
    operation: string,
    mode: 'restore' | 'move'
  ): SpaceImportStage {
    if (!isVerifiedSpaceArchive(archive)) throw new NetError('forbidden')
    db.database.exec(
      'CREATE TABLE IF NOT EXISTS net_space_archive_imports(operation TEXT PRIMARY KEY,space TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,value TEXT NOT NULL) STRICT'
    )
    if (
      db.database
        .prepare('SELECT 1 FROM net_space_archive_imports WHERE space=?')
        .get(archive.manifest.space)
    )
      throw new NetError('conflict')
    const ss = [...archive.streams()]
    if (!ss.length || ss.length > ARCHIVE_IMPORT_MAX_STREAMS || Buffer.byteLength(json(ss)) > 65536)
      throw new NetError('too_large')
    const existing = db.database
      .prepare('SELECT id FROM net_streams WHERE space_id=? ORDER BY id LIMIT 65')
      .all(archive.manifest.space)
    if (
      (mode === 'move' && existing.length) ||
      (mode === 'restore' && existing.some((row) => !ss.some((s) => s.descriptor.id === row.id)))
    )
      throw new NetError('conflict')
    const entries: Entry[] = ss.map((s) => {
      const previous = db.database
        .prepare('SELECT * FROM net_streams WHERE id=?')
        .get(s.descriptor.id)
      if (
        previous &&
        (mode !== 'restore' ||
          previous.space_id !== archive.manifest.space ||
          previous.kind !== s.descriptor.kind ||
          json(JSON.parse(previous.descriptor as string)) !== json(s.descriptor))
      )
        throw new NetError('conflict')
      return {
        ...s,
        generation: randomUUID(),
        fresh: !previous,
        ...(previous
          ? { previous: previous.active_generation as string, guard: guard(previous) }
          : {})
      }
    })
    const plan: Plan = {
      operation,
      space: archive.manifest.space,
      digest: archive.digest,
      entries,
      complete: false
    }
    db.transaction(() => {
      for (const entry of entries) {
        if (entry.fresh) {
          db.charge(2, Buffer.byteLength(json(entry.descriptor)))
          db.database
            .prepare('INSERT INTO net_streams VALUES(?,?,?,?,?,0,0,0,?)')
            .run(
              entry.descriptor.id,
              json(entry.descriptor),
              plan.space,
              entry.descriptor.kind,
              entry.head.epoch,
              entry.generation
            )
          db.database
            .prepare('INSERT INTO net_space_archive_hidden VALUES(?,?)')
            .run(entry.descriptor.id, operation)
        }
        db.charge(1)
        db.database
          .prepare("INSERT INTO net_generations VALUES(?,?,'archive-staging',?,?,0)")
          .run(entry.generation, entry.descriptor.id, entry.head.epoch, entry.head.seq)
      }
      db.charge(1, Buffer.byteLength(json(plan)))
      db.database
        .prepare('INSERT INTO net_space_archive_imports VALUES(?,?,?,?)')
        .run(operation, plan.space, plan.digest, json(plan))
    })
    const stage = new SpaceImportStage(db, plan)
    try {
      for (const entry of entries) {
        let last: StoredRecord | undefined
        for (const record of archive.records(entry.descriptor.id)) {
          const id = validateRecord(entry.descriptor.id, record)
          if (
            record.epoch > entry.head.epoch ||
            (record.epoch === entry.head.epoch && record.seq > entry.head.seq) ||
            (last &&
              (record.epoch === last.epoch
                ? record.seq !== last.seq + 1
                : record.epoch <= last.epoch || record.seq !== 1))
          )
            throw new NetError('bad_request')
          const known = db.database
            .prepare(
              "SELECT r.* FROM net_records r JOIN net_generations g ON g.id=r.generation WHERE g.stream=? AND g.state NOT IN ('staging','archive-staging') AND (r.id=? OR (r.epoch=? AND r.seq=?)) LIMIT 2"
            )
            .all(entry.descriptor.id, id, record.epoch, record.seq)
          for (const r of known)
            if (
              r.id !== id ||
              r.epoch !== record.epoch ||
              r.seq !== record.seq ||
              r.recv_ts !== record.recvTs ||
              digest(r.envelope as Uint8Array) !== digest(record.envelope) ||
              digest(r.sig as Uint8Array) !== digest(record.sig)
            )
              throw new NetError('conflict')
          db.transaction(() => {
            db.charge(1, record.envelope.length + record.sig.length)
            db.database
              .prepare('INSERT INTO net_records VALUES(?,?,?,?,?,?,?)')
              .run(
                entry.generation,
                record.epoch,
                record.seq,
                id,
                record.recvTs,
                record.envelope,
                record.sig
              )
          })
          last = record
        }
        if (
          entry.head.seq &&
          (!last || last.epoch !== entry.head.epoch || last.seq !== entry.head.seq)
        )
          throw new NetError('bad_request')
      }
      plan.complete = true
      db.transaction(() => {
        db.charge(1, Buffer.byteLength(json(plan)))
        db.database
          .prepare('UPDATE net_space_archive_imports SET value=? WHERE operation=?')
          .run(json(plan), operation)
      })
      return stage
    } catch (error) {
      stage.discard()
      throw error
    }
  }
  static resume(db: NetDatabase, operation: string, digest: string): SpaceImportStage {
    const row = db.database
      .prepare('SELECT value FROM net_space_archive_imports WHERE operation=? AND digest=?')
      .get(operation, digest)
    if (!row) throw new NetError('conflict')
    const plan = JSON.parse(row.value as string) as Plan
    if (!plan.complete) throw new NetError('outcome_uncertain')
    return new SpaceImportStage(db, plan)
  }
  /** Explicit re-import of the SAME verified archive may discard an interrupted
   * materialization. Restart alone never publishes or resumes it. */
  static discardOperation(db: NetDatabase, operation: string): void {
    const table = db.database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='net_space_archive_imports'"
      )
      .get()
    if (!table) return
    const row = db.database
      .prepare('SELECT value FROM net_space_archive_imports WHERE operation=?')
      .get(operation)
    if (row) new SpaceImportStage(db, JSON.parse(row.value as string)).discard()
  }
  descriptors(): StreamDescriptor[] {
    return this.plan.entries.map((e) => e.descriptor)
  }
  /** Trusted activation owner wraps this and metadata/descriptor/journal flips in
   * the SAME bounded transaction. It is deliberately unavailable standalone. */
  commit(): void {
    if (!this.db.inTransaction || !this.plan.complete) throw new NetError('forbidden')
    for (const entry of this.plan.entries) {
      const row = this.db.database
        .prepare('SELECT * FROM net_streams WHERE id=?')
        .get(entry.descriptor.id)
      const gen = this.db.database
        .prepare("SELECT 1 FROM net_generations WHERE id=? AND state='archive-staging'")
        .get(entry.generation)
      if (
        !row ||
        !gen ||
        (!entry.fresh && guard(row) !== entry.guard) ||
        (entry.fresh &&
          !this.db.database
            .prepare('SELECT 1 FROM net_space_archive_hidden WHERE stream=? AND operation=?')
            .get(entry.descriptor.id, this.plan.operation))
      )
        throw new NetError('conflict')
    }
    for (const entry of this.plan.entries) {
      if (entry.previous) {
        this.db.charge(1)
        this.db.database
          .prepare("UPDATE net_generations SET state='archived' WHERE id=?")
          .run(entry.previous)
      }
      this.db.charge(3, Buffer.byteLength(json(entry.descriptor)))
      this.db.database
        .prepare("UPDATE net_generations SET state='active' WHERE id=?")
        .run(entry.generation)
      this.db.database
        .prepare(
          'UPDATE net_streams SET descriptor=?,active_generation=?,epoch=?,head=?,cursor=?,retained=? WHERE id=?'
        )
        .run(
          json(entry.descriptor),
          entry.generation,
          entry.head.epoch,
          entry.head.seq,
          entry.head.seq,
          entry.retained,
          entry.descriptor.id
        )
      this.db.database
        .prepare('DELETE FROM net_space_archive_hidden WHERE stream=? AND operation=?')
        .run(entry.descriptor.id, this.plan.operation)
    }
    this.db.charge(1)
    this.db.database
      .prepare('DELETE FROM net_space_archive_imports WHERE operation=?')
      .run(this.plan.operation)
  }
  discard(): void {
    if (
      !this.db.database
        .prepare('SELECT 1 FROM net_space_archive_imports WHERE operation=?')
        .get(this.plan.operation)
    )
      return
    for (const entry of this.plan.entries) {
      for (;;) {
        const rows = this.db.database
          .prepare('SELECT rowid FROM net_records WHERE generation=? LIMIT 500')
          .all(entry.generation)
        if (!rows.length) break
        this.db.transaction(() => {
          this.db.charge(rows.length)
          for (const row of rows)
            this.db.database.prepare('DELETE FROM net_records WHERE rowid=?').run(row.rowid!)
        })
      }
      this.db.transaction(() => {
        this.db.charge(entry.fresh ? 3 : 1)
        this.db.database
          .prepare("DELETE FROM net_generations WHERE id=? AND state='archive-staging'")
          .run(entry.generation)
        if (entry.fresh) {
          this.db.database
            .prepare('DELETE FROM net_space_archive_hidden WHERE stream=? AND operation=?')
            .run(entry.descriptor.id, this.plan.operation)
          this.db.database
            .prepare(
              'DELETE FROM net_streams WHERE id=? AND NOT EXISTS(SELECT 1 FROM net_generations WHERE stream=?)'
            )
            .run(entry.descriptor.id, entry.descriptor.id)
        }
      })
    }
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare('DELETE FROM net_space_archive_imports WHERE operation=?')
        .run(this.plan.operation)
    })
  }
  /** Meta staging carry is persisted through the ordinary protected carry table;
   * the generation has archive lifetime and survives snapshot cleanup. */
  saveProjectionCarry(stream: StreamId, carry: unknown): void {
    const entry = this.plan.entries.find((e) => e.descriptor.id === stream)
    if (!entry || entry.descriptor.kind !== 'space.meta') throw new NetError('bad_request')
    this.db.transaction(() => {
      const value = json({ carry })
      if (Buffer.byteLength(value) > 65536) throw new NetError('too_large')
      this.db.charge(1, Buffer.byteLength(value))
      this.db.database
        .prepare(
          'INSERT INTO net_snapshot_progress VALUES(?,?) ON CONFLICT(generation) DO UPDATE SET progress=excluded.progress'
        )
        .run(entry.generation, value)
    })
  }
  projectionCarry(stream: StreamId): unknown {
    const entry = this.plan.entries.find((e) => e.descriptor.id === stream)
    if (!entry) throw new NetError('bad_request')
    const row = this.db.database
      .prepare('SELECT progress FROM net_snapshot_progress WHERE generation=?')
      .get(entry.generation)
    return row ? JSON.parse(row.progress as string).carry : undefined
  }
  clearProjectionCarry(stream: StreamId): void {
    if (!this.db.inTransaction) throw new NetError('forbidden')
    const entry = this.plan.entries.find((e) => e.descriptor.id === stream)
    if (!entry) throw new NetError('bad_request')
    this.db.charge(1)
    this.db.database
      .prepare('DELETE FROM net_snapshot_progress WHERE generation=?')
      .run(entry.generation)
  }
}
