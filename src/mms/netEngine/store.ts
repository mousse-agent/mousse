import { NetError } from '../../shared/net/errors'
import { newId, type NodeId, type StreamId } from '../../shared/net'
import type { NetDatabase } from '../net/store/database'

/** Where a pairing is in its life. Only the serving states may call, be served or be read from disk. */
export type EnginePeerState =
  | 'consented'
  | 'joined'
  | 'granted'
  | 'awaiting_pairback'
  | 'connected'
  | 'removing'
  | 'removed'

export interface EnginePeerRow {
  /** This computer's own id for the pairing (`newId('node')`); a re-pair after Remove gets a new one. */
  localId: NodeId
  endpoint: string
  fingerprint: string
  /** The grant the other computer holds here (its `owner` role on this profile). */
  grant: string
  name: string
  state: EnginePeerState
  receipt?: string
  pairedAt: number
}

export const isServingState = (state: EnginePeerState): boolean =>
  state !== 'removing' && state !== 'removed'

/** The refusal of a subscribe to a stream another pairing (or v1) already reads. */
export const streamBoundElsewhere = (): NetError =>
  new NetError('conflict', 'This stream is read through another connection.', {
    details: { reason: 'stream_bound_elsewhere' }
  })

/**
 * The engine's rows in this profile's `net.db`: one per pairing (`net_engine_peers`) and the binding of each
 * stream this computer reads from one of them (`net_engine_streams`). They live in `net/`, so Start over moves
 * them aside with the rest of the network.
 */
export class EnginePeerStore {
  constructor(private readonly db: NetDatabase) {
    db.transaction(() =>
      db.database.exec(
        'CREATE TABLE IF NOT EXISTS net_engine_peers(local_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,fingerprint TEXT NOT NULL,grant TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,paired_at INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS net_engine_streams(stream TEXT PRIMARY KEY,peer_local_id TEXT NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS net_engine_streams_peer ON net_engine_streams(peer_local_id)'
      )
    )
  }

  /** Saves a pairing; a new one gets a fresh local id. */
  add(row: Omit<EnginePeerRow, 'localId'> & { localId?: NodeId }): EnginePeerRow {
    const saved: EnginePeerRow = { ...row, localId: row.localId ?? newId('node') }
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare('INSERT INTO net_engine_peers VALUES(?,?,?,?,?,?,?,?)')
        .run(
          saved.localId,
          saved.endpoint,
          saved.fingerprint,
          saved.grant,
          saved.name,
          saved.state,
          saved.receipt ?? null,
          saved.pairedAt
        )
    })
    return saved
  }

  get(localId: NodeId): EnginePeerRow | undefined {
    const row = this.db.database
      .prepare('SELECT * FROM net_engine_peers WHERE local_id=?')
      .get(localId)
    return row ? toRow(row) : undefined
  }

  all(): EnginePeerRow[] {
    return this.db.database
      .prepare('SELECT * FROM net_engine_peers ORDER BY paired_at')
      .all()
      .map(toRow)
  }

  serving(localId: NodeId): EnginePeerRow | undefined {
    const row = this.get(localId)
    return row && isServingState(row.state) ? row : undefined
  }

  setState(localId: NodeId, state: EnginePeerState): void {
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare('UPDATE net_engine_peers SET state=? WHERE local_id=?')
        .run(state, localId)
    })
  }

  /** The pairing a stream is read from, if it is bound to one. */
  binding(stream: StreamId): NodeId | undefined {
    return this.db.database
      .prepare('SELECT peer_local_id FROM net_engine_streams WHERE stream=?')
      .get(stream)?.peer_local_id as NodeId | undefined
  }

  /**
   * Binds `stream` to the pairing `localId`, in the caller's transaction (with the stream's descriptor). A stream
   * already bound to another pairing is refused with `stream_bound_elsewhere`.
   */
  bind(stream: StreamId, localId: NodeId): void {
    this.db.transaction(() => {
      const held = this.binding(stream)
      if (held === localId) return
      if (held) throw streamBoundElsewhere()
      this.db.charge(1)
      this.db.database.prepare('INSERT INTO net_engine_streams VALUES(?,?)').run(stream, localId)
    })
  }
}

function toRow(row: Record<string, unknown>): EnginePeerRow {
  return {
    localId: row.local_id as NodeId,
    endpoint: String(row.endpoint),
    fingerprint: String(row.fingerprint),
    grant: String(row.grant),
    name: String(row.name),
    state: row.state as EnginePeerState,
    ...(row.receipt === null || row.receipt === undefined ? {} : { receipt: String(row.receipt) }),
    pairedAt: Number(row.paired_at)
  }
}
