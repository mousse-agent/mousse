import { NetError } from '../../shared/net/errors'
import { newId, type NodeId, type StreamId } from '../../shared/net'
import { parsePrivateKey } from '../bridge/remote/privateStreams'
import type { NetDatabase } from '../net/store/database'

/** Where a pairing is in its life. Only the serving states may call, be served or be read from disk. */
export type EnginePeerState =
  'consented' | 'joined' | 'granted' | 'awaiting_pairback' | 'connected' | 'removing' | 'removed'

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
  /** The invitation this computer joined (the joiner's journal) or that the other computer used (the host's). */
  invitation?: string
  /** The ticket this computer consented to join: kept until `joined`, so a join cut short is repeated with it. */
  ticket?: string
  /** Addresses the user added for the other computer (Add address), as routes (`tcp://host:port`). */
  addresses?: string[]
  /** How the pairing began when not by a ticket: `ssh`, added over SSH (design 1b §3.6). */
  source?: string
  /** The Send link this computer consented to join (design 1b §5.3), while its outcome is open and until pairback. */
  link?: EngineLink
}

/**
 * A Send link joined from this computer (kind 2): what Connect approved and what it shares back, kept on the row so
 * a join repeated after a restart sends the same lists. `pending` while the ticket's `PAIRED` has not been seen: on a
 * row added another way (over SSH) it is a pending link beside the row, which converts only on that `PAIRED`.
 */
export interface EngineLink {
  ticket: string
  /** The ticket hash (hex): `join.status` and `join.ack` name the flow by it. */
  ticketHash: string
  invitation: string
  /** The ticket's non-private destinations the owner approved at Connect (`join {approved}`). */
  approved: string[]
  /** This computer's tailnet and public routes the owner ticked under "Also share", sent in pairback. */
  share: string[]
  /** When the ticket's invitation ends, in seconds since 1970. */
  expiresAt?: number
  pending: boolean
}

/** What a pairing's row may change after it is saved; `ticket: null` deletes the stored ticket. */
export type EnginePeerChange = Partial<
  Pick<
    EnginePeerRow,
    'endpoint' | 'fingerprint' | 'grant' | 'name' | 'state' | 'receipt' | 'invitation'
  >
> & { ticket?: string | null; source?: string | null; link?: EngineLink | null }

const COLUMNS: Record<keyof EnginePeerChange, string> = {
  endpoint: 'endpoint',
  fingerprint: 'fingerprint',
  grant: 'grant',
  name: 'name',
  state: 'state',
  receipt: 'receipt',
  invitation: 'invitation',
  ticket: 'ticket',
  source: 'source',
  link: 'link'
}

/** A change's value as its column holds it (the link as JSON). */
const columnValue = (key: keyof EnginePeerChange, change: EnginePeerChange): string | null => {
  const value = change[key]
  if (value === null || value === undefined) return null
  return key === 'link' ? JSON.stringify(value) : String(value)
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
    db.transaction(() => {
      db.database.exec(
        'CREATE TABLE IF NOT EXISTS net_engine_peers(local_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,fingerprint TEXT NOT NULL,grant TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,paired_at INTEGER NOT NULL,invitation TEXT,ticket TEXT,addresses TEXT) STRICT; CREATE TABLE IF NOT EXISTS net_engine_streams(stream TEXT PRIMARY KEY,peer_local_id TEXT NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS net_engine_streams_peer ON net_engine_streams(peer_local_id)'
      )
      // A table from before the journal or address columns gets them.
      const columns = new Set(
        db.database
          .prepare('PRAGMA table_info(net_engine_peers)')
          .all()
          .map((row) => String(row.name))
      )
      for (const column of ['invitation', 'ticket', 'addresses', 'source', 'link'])
        if (!columns.has(column))
          db.database.exec(`ALTER TABLE net_engine_peers ADD COLUMN ${column} TEXT`)
    })
  }

  /** Saves a pairing; a new one gets a fresh local id. */
  add(row: Omit<EnginePeerRow, 'localId'> & { localId?: NodeId }): EnginePeerRow {
    const saved: EnginePeerRow = { ...row, localId: row.localId ?? newId('node') }
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare(
          'INSERT INTO net_engine_peers(local_id,endpoint,fingerprint,grant,name,state,receipt,paired_at,invitation,ticket,source,link) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .run(
          saved.localId,
          saved.endpoint,
          saved.fingerprint,
          saved.grant,
          saved.name,
          saved.state,
          saved.receipt ?? null,
          saved.pairedAt,
          saved.invitation ?? null,
          saved.ticket ?? null,
          saved.source ?? null,
          saved.link ? JSON.stringify(saved.link) : null
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

  /** The serving pairing with the helper identity `endpoint`. */
  byEndpoint(endpoint: string): EnginePeerRow | undefined {
    return this.all().find((row) => row.endpoint === endpoint && isServingState(row.state))
  }

  /** Saves the addresses the user added for a pairing (empty: none). */
  setAddresses(localId: NodeId, addresses: string[]): EnginePeerRow | undefined {
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare('UPDATE net_engine_peers SET addresses=? WHERE local_id=?')
        .run(addresses.length ? JSON.stringify(addresses) : null, localId)
    })
    return this.get(localId)
  }

  setState(localId: NodeId, state: EnginePeerState): void {
    this.update(localId, { state })
  }

  /** Changes a pairing's row (a step of its ceremony). */
  update(localId: NodeId, change: EnginePeerChange): EnginePeerRow | undefined {
    const keys = (Object.keys(change) as (keyof EnginePeerChange)[]).filter(
      (key) => change[key] !== undefined
    )
    if (keys.length)
      this.db.transaction(() => {
        this.db.charge(1)
        this.db.database
          .prepare(
            `UPDATE net_engine_peers SET ${keys.map((key) => `${COLUMNS[key]}=?`).join(',')} WHERE local_id=?`
          )
          .run(...keys.map((key) => columnValue(key, change)), localId)
      })
    return this.get(localId)
  }

  /**
   * Changes a pairing's row only while it is in one of the states `from` (a step that ran while a removal or another
   * step moved the row on writes nothing). Answers the row, or undefined when it had moved on.
   */
  advance(
    localId: NodeId,
    from: readonly EnginePeerState[],
    change: EnginePeerChange
  ): EnginePeerRow | undefined {
    const keys = (Object.keys(change) as (keyof EnginePeerChange)[]).filter(
      (key) => change[key] !== undefined
    )
    let changed = false
    this.db.transaction(() => {
      this.db.charge(1)
      changed =
        this.db.database
          .prepare(
            `UPDATE net_engine_peers SET ${keys.map((key) => `${COLUMNS[key]}=?`).join(',')} WHERE local_id=? AND state IN (${from.map(() => '?').join(',')})`
          )
          .run(...keys.map((key) => columnValue(key, change)), localId, ...from).changes > 0
    })
    return changed ? this.get(localId) : undefined
  }

  /** Deletes a row that never served (a consented link whose join ended without pairing): nothing else holds it. */
  forgetUnpaired(localId: NodeId): void {
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare("DELETE FROM net_engine_peers WHERE local_id=? AND state='consented' AND grant=''")
        .run(localId)
    })
  }

  /** Every row in `state`, oldest first. */
  inState(state: EnginePeerState): EnginePeerRow[] {
    return this.all().filter((row) => row.state === state)
  }

  /** Whether any row, whatever its state, is for the grant `grant` this computer issued. */
  holdsGrant(grant: string): boolean {
    return !!this.db.database
      .prepare('SELECT 1 FROM net_engine_peers WHERE grant=? LIMIT 1')
      .get(grant)
  }

  /**
   * The last step of a removal (§5.4 step 3), in one transaction: the pairing's policy, the streams read from it
   * and their bindings, the private streams it read here, its call aliases, its artifacts and its hub threads go;
   * the row stays as a `removed` tombstone.
   */
  prune(localId: NodeId): void {
    this.db.transaction(() => {
      this.db.charge(16)
      this.dropRows(localId)
      this.db.database
        .prepare("UPDATE net_engine_peers SET state='removed',ticket=NULL,link=NULL WHERE local_id=?")
        .run(localId)
    })
  }

  /**
   * The start-up sweep (§5.4 step 4): what late writes of aborted handlers left under a tombstoned id goes, then
   * the tombstone. It works only from tombstoned ids. Answers the ids swept.
   */
  sweep(): NodeId[] {
    const swept: NodeId[] = []
    for (const row of this.inState('removed'))
      this.db.transaction(() => {
        this.db.charge(16)
        this.dropRows(row.localId)
        this.db.database.prepare('DELETE FROM net_engine_peers WHERE local_id=?').run(row.localId)
        swept.push(row.localId)
      })
    return swept
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

  /** Deletes every row this profile keeps for the pairing `localId`, inside the caller's transaction. */
  private dropRows(localId: NodeId): void {
    const database = this.db.database
    const has = (table: string): boolean =>
      !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    const streams = new Set<string>()
    if (has('net_node_policy'))
      database.prepare('DELETE FROM net_node_policy WHERE node=?').run(localId)
    for (const row of database
      .prepare('SELECT stream FROM net_engine_streams WHERE peer_local_id=?')
      .all(localId))
      streams.add(String(row.stream))
    database.prepare('DELETE FROM net_engine_streams WHERE peer_local_id=?').run(localId)
    if (has('bridge_thread_streams'))
      for (const row of database
        .prepare('SELECT thread_id,stream FROM bridge_thread_streams')
        .all())
        if (parsePrivateKey(String(row.thread_id))?.reader === localId) {
          streams.add(String(row.stream))
          database.prepare('DELETE FROM bridge_thread_streams WHERE thread_id=?').run(row.thread_id)
        }
    if (has('net_rpc_aliases'))
      database.prepare('DELETE FROM net_rpc_aliases WHERE caller=?').run(localId)
    if (has('net_bridge_artifacts')) {
      for (const row of database
        .prepare('SELECT stream FROM net_bridge_artifacts WHERE caller=?')
        .all(localId))
        streams.add(String(row.stream))
      database.prepare('DELETE FROM net_bridge_artifacts WHERE caller=?').run(localId)
    }
    if (has('net_bridge_artifact_uploads'))
      database.prepare('DELETE FROM net_bridge_artifact_uploads WHERE caller=?').run(localId)
    if (has('net_bridge_hub_threads'))
      database.prepare('DELETE FROM net_bridge_hub_threads WHERE target=?').run(localId)
    for (const stream of streams) dropStream(this.db, stream)
  }
}

/**
 * Deletes a stream and what is stored under it (its generations and records, event ids, blob references and
 * outbox), inside the caller's transaction. Blobs nothing references any more go with the next blob collection.
 */
function dropStream(db: NetDatabase, stream: string): void {
  const database = db.database
  database.prepare('DELETE FROM net_blob_refs WHERE stream=?').run(stream)
  database.prepare('DELETE FROM net_event_ids WHERE stream=?').run(stream)
  database.prepare('DELETE FROM net_outbox WHERE stream=?').run(stream)
  database
    .prepare(
      'DELETE FROM net_records WHERE generation IN (SELECT id FROM net_generations WHERE stream=?)'
    )
    .run(stream)
  database.prepare('DELETE FROM net_generations WHERE stream=?').run(stream)
  database.prepare('DELETE FROM net_streams WHERE id=?').run(stream)
}

function toRow(row: Record<string, unknown>): EnginePeerRow {
  const text = (value: unknown): string | undefined =>
    value === null || value === undefined ? undefined : String(value)
  const receipt = text(row.receipt),
    invitation = text(row.invitation),
    ticket = text(row.ticket),
    source = text(row.source),
    link = readLink(row.link),
    addresses = readAddresses(row.addresses)
  return {
    localId: row.local_id as NodeId,
    endpoint: String(row.endpoint),
    fingerprint: String(row.fingerprint),
    grant: String(row.grant),
    name: String(row.name),
    state: row.state as EnginePeerState,
    ...(receipt === undefined ? {} : { receipt }),
    pairedAt: Number(row.paired_at),
    ...(invitation === undefined ? {} : { invitation }),
    ...(ticket === undefined ? {} : { ticket }),
    ...(addresses.length ? { addresses } : {}),
    ...(source === undefined ? {} : { source }),
    ...(link ? { link } : {})
  }
}

function readLink(value: unknown): EngineLink | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const link = JSON.parse(value) as Partial<EngineLink>
    if (typeof link?.ticket !== 'string' || typeof link.ticketHash !== 'string') return undefined
    const strings = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
    return {
      ticket: link.ticket,
      ticketHash: link.ticketHash,
      invitation: typeof link.invitation === 'string' ? link.invitation : '',
      approved: strings(link.approved),
      share: strings(link.share),
      ...(typeof link.expiresAt === 'number' ? { expiresAt: link.expiresAt } : {}),
      pending: link.pending === true
    }
  } catch {
    return undefined
  }
}

function readAddresses(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const list: unknown = JSON.parse(value)
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}
