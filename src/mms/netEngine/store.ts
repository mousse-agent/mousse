import { NetError } from '../../shared/net/errors'
import { newId, type NodeId, type StreamId } from '../../shared/net'
import { parsePrivateKey } from '../bridge/remote/privateStreams'
import type { NetDatabase } from '../net/store/database'
import { ENGINE_PRESENCE_TABLE } from '../net/presence'

/**
 * Where a pairing is in its life. Only the serving states may call, be served or be read from disk. The `ssh_*`
 * states belong to rows with `source: "ssh"` (Phase 1b §3.6), which 1a's ceremony never touches.
 */
export type EnginePeerState =
  | 'consented'
  | 'joined'
  | 'granted'
  | 'awaiting_pairback'
  | 'connected'
  | 'ssh_requested'
  | 'ssh_granting'
  | 'ssh_granted'
  | 'removing'
  | 'removed'

/**
 * An SSH add's journal on a row (§3.4). On A (`ssh_requested` → `ssh_granted` → `connected`): the request it sent
 * and the route it used. On B (`ssh_granting` → `ssh_granted` → `connected`): the request that wrote the row.
 */
export interface EngineSshJournal {
  /** 16 random bytes in hex, so it also parses as a grant receipt. */
  requestId: string
  /** When A issued the request, in seconds since 1970 (A's clock). */
  issuedAt?: number
  /** A: the SSH route the request went over. */
  routeId?: string
  /** A: the profile on B, by its selector, or the label of the profile B makes. */
  selector?: string
  newLabel?: string
  /** A: the SSH target as the owner typed it, and the host and user `ssh -G` resolved, for the row's messages. */
  target?: string
  host?: string
  user?: string
  /** A: the remote shell B's SSH server runs commands in (`sh`, `cmd` or `powershell`); none means `sh`. */
  shell?: string
  /** A: the row has been `connected`; after that, `prepare` is never repeated (§3.4 retry safety). */
  everConnected?: boolean
  /** A: B removed this computer (`removed`), so A stops repeating. */
  removed?: boolean
  /** A: whether Mousse on B starts at login, from B's reply. */
  startsAtLogin?: boolean
}

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
  /** Addresses the owner added for the other computer (Add address), as routes (every §1.3 owner kind but `ssh`). */
  addresses?: string[]
  /** `ssh`: added over SSH (§3.4); 1a's pairback and recovery skip the row (§3.6). */
  source?: 'ssh'
  /** Joiner: the ticket's non-automatic hints the owner approved at Connect, reused by a repeated join (§1.3). */
  approved?: string[]
  /** Joiner: this computer's routes ticked under "Also share", sent in pairback beside its LAN ones (§1.3). */
  share?: string[]
  /** Host: routes the other computer offered in pairback outside the automatic rule, dialled only after Use. */
  offered?: string[]
  /** The SSH add's journal (§3.4), on rows with `source: "ssh"`. */
  ssh?: EngineSshJournal
  /** The Send link this computer consented to join (1b §5.3), while its outcome is open and until pairback. */
  link?: EngineLink
  /**
   * The one direction this pairing has, when it has only one (`in`: the other computer uses this one, through the
   * grant it holds here; `out`: this computer uses it, through the peer record its helper keeps). Unset: both, as
   * every pairing made before one-way pairing. While the joiner's ceremony runs, `out` means Connect left "Also let
   * <name> use this computer" unticked: no grant is made and no pairback is sent.
   */
  ways?: EngineWays
  /**
   * Joiner, while its ceremony runs: Connect left "Also let <name> use this computer" unticked, so no grant is made
   * and no pairback is sent, whatever the row held before. Cleared once the row is `connected`.
   */
  oneWay?: boolean
  /**
   * The grant this computer stopped serving when the owner removed only that the other computer uses it, until the
   * helper confirms it is gone (`grant.revoke_local`): recovery finishes it, and nothing gives that grant a row again.
   */
  revoking?: string
  /**
   * This computer's owner removed that it uses the other computer (on a row now `in`): nothing the other computer
   * says or serves puts that direction back, until this owner asks for it again.
   */
  stoppedUsing?: boolean
}

export type EngineWays = 'in' | 'out'

/**
 * A Send link joined from this computer (kind 2): its ticket, and what Connect approved and shares back, kept so a
 * join repeated after a restart sends the same lists. `pending` until the ticket's `PAIRED`: on a row added another
 * way (over SSH) it is a pending link beside the row, whose own columns change only on that `PAIRED` (§3.6).
 */
export interface EngineLink {
  ticket: string
  /** The ticket hash (hex): `join.status` and `join.ack` name the flow by it. */
  ticketHash: string
  invitation: string
  /** The ticket's hints Connect approved (`join {approved}`). */
  approved: string[]
  /** This computer's routes ticked under "Also share"; the row's `share` once paired. */
  share: string[]
  /** When the ticket's invitation ends, in seconds since 1970. */
  expiresAt?: number
  pending: boolean
  /** Connect left "Also let <name> use this computer" unticked: once paired, this computer only uses it. */
  oneWay?: boolean
}

/** What a pairing's row may change after it is saved; `null` deletes a stored value. */
export type EnginePeerChange = Partial<
  Pick<
    EnginePeerRow,
    'endpoint' | 'fingerprint' | 'grant' | 'name' | 'state' | 'receipt' | 'invitation'
  >
> & {
  ticket?: string | null
  source?: 'ssh' | null
  approved?: string[] | null
  share?: string[] | null
  offered?: string[] | null
  ssh?: EngineSshJournal | null
  link?: EngineLink | null
  ways?: EngineWays | null
  oneWay?: true | null
  revoking?: string | null
  stoppedUsing?: true | null
}

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
  approved: 'approved',
  share: 'share',
  offered: 'offered',
  ssh: 'ssh',
  link: 'link',
  ways: 'ways',
  oneWay: 'one_way',
  revoking: 'revoking',
  stoppedUsing: 'stopped_using'
}

/** Columns kept as JSON text; an empty list is stored as NULL. */
const JSON_COLUMNS = new Set<keyof EnginePeerChange>(['approved', 'share', 'offered', 'ssh', 'link'])

/** A change's value as its column stores it. */
function columnValue(key: keyof EnginePeerChange, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (JSON_COLUMNS.has(key)) return Array.isArray(value) && !value.length ? null : JSON.stringify(value)
  return String(value)
}

/** Columns a table from an earlier slice may lack, added when the store opens. */
const ADDED_COLUMNS = [
  'invitation',
  'ticket',
  'addresses',
  'source',
  'approved',
  'share',
  'offered',
  'ssh',
  'link',
  'ways',
  'one_way',
  'revoking',
  'stopped_using'
]

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
        'CREATE TABLE IF NOT EXISTS net_engine_peers(local_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,fingerprint TEXT NOT NULL,grant TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,paired_at INTEGER NOT NULL,invitation TEXT,ticket TEXT,addresses TEXT,source TEXT,approved TEXT,share TEXT,offered TEXT,ssh TEXT,link TEXT,ways TEXT,one_way TEXT,revoking TEXT,stopped_using TEXT) STRICT; CREATE TABLE IF NOT EXISTS net_engine_pending_access(invitation TEXT PRIMARY KEY,local_id TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS net_engine_streams(stream TEXT PRIMARY KEY,peer_local_id TEXT NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS net_engine_streams_peer ON net_engine_streams(peer_local_id)'
      )
      // A table from before the journal or address columns gets them.
      const columns = new Set(
        db.database
          .prepare('PRAGMA table_info(net_engine_peers)')
          .all()
          .map((row) => String(row.name))
      )
      for (const column of ADDED_COLUMNS)
        if (!columns.has(column))
          db.database.exec(`ALTER TABLE net_engine_peers ADD COLUMN ${column} TEXT`)
    })
  }

  /**
   * Saves a pairing; a new one gets a fresh local id. `reservedFor`: the row of the device that invitation let in
   * takes the id `pendingAccess` reserved for it (and the access saved under it), released in the same transaction,
   * so a stop at any point leaves either the reservation or the row.
   */
  add(row: Omit<EnginePeerRow, 'localId'> & { localId?: NodeId }, reservedFor?: string): EnginePeerRow {
    let saved: EnginePeerRow = { ...row, localId: row.localId ?? newId('node') }
    this.db.transaction(() => {
      this.db.charge(1)
      const reserved = reservedFor ? this.reserved(reservedFor) : undefined
      if (reserved) {
        saved = { ...saved, localId: reserved }
        this.db.database.prepare('DELETE FROM net_engine_pending_access WHERE invitation=?').run(reservedFor!)
      }
      this.db.database
        .prepare(
          'INSERT INTO net_engine_peers(local_id,endpoint,fingerprint,grant,name,state,receipt,paired_at,invitation,ticket,addresses,source,approved,share,offered,ssh,link,ways,one_way,revoking,stopped_using) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
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
          saved.addresses?.length ? JSON.stringify(saved.addresses) : null,
          saved.source ?? null,
          columnValue('approved', saved.approved),
          columnValue('share', saved.share),
          columnValue('offered', saved.offered),
          columnValue('ssh', saved.ssh),
          columnValue('link', saved.link),
          saved.ways ?? null,
          columnValue('oneWay', saved.oneWay || null),
          saved.revoking ?? null,
          columnValue('stoppedUsing', saved.stoppedUsing || null)
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
          .run(...keys.map((key) => columnValue(key, change[key])), localId)
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
          .run(...keys.map((key) => columnValue(key, change[key])), localId, ...from).changes > 0
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

  /**
   * The local id the row of the device let in by `invitation` will take, made when the owner picked its access, so
   * that access is saved under that id before the helper saves the grant (and before any connection is served).
   * Kept until the row exists, so a row written at the next start (an owed grant) takes the same id.
   */
  pendingAccess(invitation: string): NodeId {
    const held = this.reserved(invitation)
    if (held) return held
    const localId = newId('node')
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database
        .prepare('INSERT INTO net_engine_pending_access(invitation,local_id) VALUES(?,?)')
        .run(invitation, localId)
    })
    return localId
  }

  /** The id `pendingAccess` reserved for `invitation`, if any (it stays reserved). */
  reserved(invitation: string | undefined): NodeId | undefined {
    if (!invitation) return undefined
    const held = this.db.database
      .prepare('SELECT local_id FROM net_engine_pending_access WHERE invitation=?')
      .get(invitation)?.local_id
    return typeof held === 'string' ? (held as NodeId) : undefined
  }

  /**
   * Changes a pairing's row and releases the id reserved for `invitation` in one transaction (a row that existed
   * before the invitation took its access already). Answers the row.
   */
  updateReleasing(localId: NodeId, change: EnginePeerChange, invitation: string | undefined): EnginePeerRow | undefined {
    this.db.transaction(() => {
      this.update(localId, change)
      if (invitation) {
        this.db.charge(1)
        this.db.database.prepare('DELETE FROM net_engine_pending_access WHERE invitation=?').run(invitation)
      }
    })
    return this.get(localId)
  }

  /**
   * Drops every reserved id (each invitation ends with its helper channel, and the owed rows were written first),
   * with the access saved for an id that never got a row.
   */
  clearPendingAccess(): void {
    const database = this.db.database
    const held = database.prepare('SELECT local_id FROM net_engine_pending_access').all()
    if (!held.length) return
    this.db.transaction(() => {
      this.db.charge(1)
      const hasPolicy = !!database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='net_node_policy'")
        .get()
      for (const row of held) {
        const localId = String(row.local_id)
        const used = database.prepare('SELECT 1 FROM net_engine_peers WHERE local_id=?').get(localId)
        if (!used && hasPolicy) database.prepare('DELETE FROM net_node_policy WHERE node=?').run(localId)
      }
      database.prepare('DELETE FROM net_engine_pending_access').run()
    })
  }

  /** Every row in `state`, oldest first. */
  inState(state: EnginePeerState): EnginePeerRow[] {
    return this.all().filter((row) => row.state === state)
  }

  /** Whether any row, whatever its state, is for the grant `grant` this computer issued, or is revoking it. */
  holdsGrant(grant: string): boolean {
    return !!this.db.database
      .prepare('SELECT 1 FROM net_engine_peers WHERE grant=? OR revoking=? LIMIT 1')
      .get(grant, grant)
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
    // What the pairing said of itself (its version, whether it updates itself).
    if (has(ENGINE_PRESENCE_TABLE))
      database.prepare(`DELETE FROM ${ENGINE_PRESENCE_TABLE} WHERE node=?`).run(localId)
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
    addresses = readAddresses(row.addresses),
    approved = readAddresses(row.approved),
    share = readAddresses(row.share),
    offered = readAddresses(row.offered),
    ssh = readJournal(row.ssh),
    link = readLink(row.link)
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
    ...(row.source === 'ssh' ? { source: 'ssh' as const } : {}),
    ...(approved.length ? { approved } : {}),
    ...(share.length ? { share } : {}),
    ...(offered.length ? { offered } : {}),
    ...(ssh ? { ssh } : {}),
    ...(link ? { link } : {}),
    ...(row.ways === 'in' || row.ways === 'out' ? { ways: row.ways } : {}),
    ...(row.one_way === 'true' ? { oneWay: true } : {}),
    ...(typeof row.revoking === 'string' ? { revoking: row.revoking } : {}),
    ...(row.stopped_using === 'true' ? { stoppedUsing: true } : {})
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
      pending: link.pending === true,
      ...(link.oneWay === true ? { oneWay: true } : {})
    }
  } catch {
    return undefined
  }
}

function readJournal(value: unknown): EngineSshJournal | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const journal = JSON.parse(value) as EngineSshJournal
    return journal && typeof journal.requestId === 'string' ? journal : undefined
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
