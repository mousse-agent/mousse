import { createHash, randomUUID } from 'node:crypto'
import {
  BLOB_CHUNK_BYTES,
  NetError,
  type BlobId,
  type NodeId,
  type RpcArtifactRef
} from '../../../shared/net'
import {
  ROUTED_STAGE_CALLER_BYTES,
  ROUTED_STAGE_ITEM_BYTES,
  ROUTED_STAGE_TOTAL_BYTES,
  ROUTED_STAGE_TTL_MS,
  isStageId,
  type RoutedReply
} from '../../../shared/bridge/routed'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { BlobStore, Clock, RpcContext, StreamStore } from '../../net/contracts'
import type { NetDatabase } from '../../net/store/database'

export interface RoutedStagingOptions {
  db: NetDatabase
  /** Where the uploaded bytes live: the Net blob store. */
  blobs: BlobStore
  /** The stream that carried an upload is emptied when its staged value is used or expires. */
  store: Pick<StreamStore, 'head' | 'truncate'>
  clock: Pick<Clock, 'now'>
  /** Reads the bytes of an upload that belongs to this request (the request-bound artifact). */
  readInput(ref: RpcArtifactRef, context: RpcContext): Uint8Array
  limits?: { item?: number; caller?: number; total?: number; ttlMs?: number; sweepMs?: number }
}

interface Row {
  id: string
  caller: string
  stream: string
  event: string
  blob: string
  bytes: number
  created_at: number
}

/**
 * Large values a computer sends ahead of the call that uses them (a long message, images, a file's
 * content), so that no request has to carry them. The caller uploads the value as a request
 * artifact of `routed.stage`; the owner checks it against its limits, keeps it in the blob store
 * and answers an id that the call names in `stagedValues`.
 *
 * Limits: one value 25 MiB at most, 64 MiB per computer and 256 MiB in all, kept for an hour. A
 * value is used by one call. The upload stays in the blob store until the stream that carried it
 * is emptied (when the value is used or expires) and the blob store collects it.
 */
export class RoutedStaging {
  /** Values a call is using right now. In memory only: a restart ends every call. */
  private readonly claimed = new Set<string>()
  constructor(private readonly options: RoutedStagingOptions) {
    options.db.database.exec(
      'CREATE TABLE IF NOT EXISTS routed_stage(id TEXT PRIMARY KEY,caller TEXT NOT NULL,stream TEXT NOT NULL,event TEXT NOT NULL,blob TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT'
    )
    options.db.database.exec(
      'CREATE INDEX IF NOT EXISTS routed_stage_caller ON routed_stage(caller,created_at)'
    )
  }

  private get item(): number {
    return this.options.limits?.item ?? ROUTED_STAGE_ITEM_BYTES
  }
  private get perCaller(): number {
    return this.options.limits?.caller ?? ROUTED_STAGE_CALLER_BYTES
  }
  private get inTotal(): number {
    return this.options.limits?.total ?? ROUTED_STAGE_TOTAL_BYTES
  }
  private get ttl(): number {
    return this.options.limits?.ttlMs ?? ROUTED_STAGE_TTL_MS
  }

  /** Takes the upload `ref` names and keeps it for `caller`, or refuses it. A refusal is a result, not an unknown outcome. */
  stage(ref: RpcArtifactRef, caller: NodeId, context: RpcContext): RoutedReply {
    this.sweep()
    // Reading also proves the upload belongs to this request and is what its record says.
    const size = this.options.readInput(ref, context).length
    const refuse = (code: string, message: string): RoutedReply => {
      this.emptyStreams([{ stream: ref.stream }])
      return { ok: false, error: { code, message } }
    }
    if (size === 0) return refuse('stage_empty', 'There is nothing to stage.')
    if (size > this.item)
      return refuse('stage_too_large', 'That value is larger than the 25 MiB a computer may stage.')
    const mine = this.used(caller)
    if (mine + size > this.perCaller)
      return refuse(
        'stage_full',
        'This computer has staged as much as it may hold at once. Try again when earlier calls have finished.'
      )
    if (this.used() + size > this.inTotal)
      return refuse(
        'stage_full',
        'The computer that runs the thread is holding as much staged data as it may. Try again shortly.'
      )
    const id = `stg_${randomUUID().replaceAll('-', '')}`
    const now = this.options.clock.now()
    this.options.db.transaction(() => {
      this.options.db.charge(1)
      this.options.db.database
        .prepare('INSERT INTO routed_stage VALUES(?,?,?,?,?,?,?)')
        .run(id, caller, ref.stream, ref.event, ref.blob, size, now)
    })
    return { ok: true, result: { stage: id, bytes: size, expiresAt: now + this.ttl } }
  }

  /**
   * The bytes of each staged value `caller` names, by id, and a claim on each: a value is used by one
   * call, so a second call that names it while the first is under way is refused (`stage_in_use`).
   * Nothing is used up here. The call gives the claims back with `release` when it is refused, and
   * `consume` removes the values once it has gone through.
   */
  resolve(caller: NodeId, ids: readonly string[]): Map<string, Buffer> {
    this.sweep()
    const rows: Row[] = []
    for (const id of ids) {
      const row = isStageId(id) ? this.get(id) : undefined
      // Another computer's value is reported as missing, not as someone else's.
      if (!row || row.caller !== caller)
        throw new DomainRpcError(
          'stage_not_found',
          'That staged value is no longer held. Send it again.',
          { stage: id }
        )
      if (this.claimed.has(id))
        throw new DomainRpcError(
          'stage_in_use',
          'Another call is using that staged value. Send it again for this call.',
          { stage: id }
        )
      rows.push(row)
    }
    // Claimed together, before any bytes are read, so concurrent calls never hold the same value in memory.
    for (const row of rows) this.claimed.add(row.id)
    try {
      return new Map(rows.map((row) => [row.id, this.read(row)]))
    } catch (error) {
      this.release(ids)
      throw error
    }
  }

  /** Gives back the claims of a call that did not use its values up. */
  release(ids: readonly string[]): void {
    for (const id of ids) this.claimed.delete(id)
  }

  /** The values a successful call used are done with. */
  consume(ids: readonly string[]): void {
    const rows = ids.map((id) => this.get(id)).filter((row): row is Row => Boolean(row))
    this.release(ids)
    this.remove(rows)
  }

  /**
   * Looks for expired values now and every `sweepMs` while the service runs, so none stays on disk
   * longer than its hour because nobody staged again. Returns what stops it.
   */
  start(): () => void {
    this.sweep()
    const timer = setInterval(() => {
      try {
        this.sweep()
      } catch {
        // The next interval tries again.
      }
    }, this.options.limits?.sweepMs ?? 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /** Drops values held longer than the hour. */
  sweep(): number {
    const cutoff = this.options.clock.now() - this.ttl
    const expired = this.options.db.database
      .prepare('SELECT * FROM routed_stage WHERE created_at<=?')
      .all(cutoff) as unknown as Row[]
    this.remove(expired)
    return expired.length
  }

  /** The caller is gone for good (blocked): what it staged goes. */
  dropCaller(caller: NodeId): void {
    this.remove(
      this.options.db.database
        .prepare('SELECT * FROM routed_stage WHERE caller=?')
        .all(caller) as unknown as Row[]
    )
  }

  /** Bytes held, for `caller` or in all. */
  used(caller?: NodeId): number {
    const row = caller
      ? this.options.db.database
          .prepare('SELECT coalesce(sum(bytes),0) AS n FROM routed_stage WHERE caller=?')
          .get(caller)
      : this.options.db.database
          .prepare('SELECT coalesce(sum(bytes),0) AS n FROM routed_stage')
          .get()
    return Number(row?.n ?? 0)
  }

  /** The computers that have a value staged. */
  callers(): NodeId[] {
    return this.options.db.database
      .prepare('SELECT DISTINCT caller FROM routed_stage')
      .all()
      .map((row) => String(row.caller) as NodeId)
  }

  count(caller?: NodeId): number {
    const row = caller
      ? this.options.db.database
          .prepare('SELECT count(*) AS n FROM routed_stage WHERE caller=?')
          .get(caller)
      : this.options.db.database.prepare('SELECT count(*) AS n FROM routed_stage').get()
    return Number(row?.n ?? 0)
  }

  private get(id: string): Row | undefined {
    return this.options.db.database.prepare('SELECT * FROM routed_stage WHERE id=?').get(id) as
      Row | undefined
  }

  private read(row: Row): Buffer {
    const blob = row.blob as BlobId
    const size = this.options.blobs.size(blob)
    if (size === undefined || size !== row.bytes)
      throw new DomainRpcError(
        'stage_not_found',
        'That staged value is no longer held. Send it again.',
        {
          stage: row.id
        }
      )
    const parts: Uint8Array[] = []
    for (let at = 0; at < size; at += BLOB_CHUNK_BYTES)
      parts.push(this.options.blobs.read(blob, at, Math.min(BLOB_CHUNK_BYTES, size - at)))
    const bytes = Buffer.concat(parts)
    if (`blb_${createHash('sha256').update(bytes).digest('hex')}` !== row.blob)
      throw new NetError('conflict')
    return bytes
  }

  private remove(rows: readonly Row[]): void {
    if (!rows.length) return
    for (const row of rows) this.claimed.delete(row.id)
    this.options.db.transaction(() => {
      for (const row of rows) {
        this.options.db.charge(1)
        this.options.db.database.prepare('DELETE FROM routed_stage WHERE id=?').run(row.id)
      }
    })
    this.emptyStreams(rows)
  }

  /** Empties the artifact streams that carried the uploads, so their blobs are no longer referenced. */
  private emptyStreams(rows: ReadonlyArray<{ stream: string }>): void {
    for (const stream of new Set(rows.map((row) => row.stream))) {
      try {
        const id = stream as Parameters<StreamStore['head']>[0]
        // Another staged value may still be on the same stream (a retry shares its request's stream).
        const shared = this.options.db.database
          .prepare('SELECT 1 FROM routed_stage WHERE stream=? LIMIT 1')
          .get(stream)
        if (shared) continue
        this.options.store.truncate(id, this.options.store.head(id).seq)
      } catch {
        // Freeing the bytes is best effort; the blob store collects what nothing references.
      }
    }
  }
}
