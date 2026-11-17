import { NetError, isId } from '../../../shared/net'
import type { NodeId } from '../../../shared/net'
import type { Clock } from '../contracts'
import { CONNECTIONS_MARKER, type NetDatabase } from './database'

/**
 * Whether another device of this user's own list is connected here, on this computer alone. `none`: no record, so
 * not connected and open to the automatic rules (an invitation, Mousse ID). `connected` and `disconnected` are
 * records a person or a rule wrote; a disconnected device stays so until someone connects it again. `held`: it came
 * in by a connect link (made here, or pasted here to join), so it is not connected until someone answers Allow here.
 * A stored state this build does not know reads as `other`: not connected, and still a record the automatic rules
 * leave alone.
 */
export type ConnectionState = 'none' | 'connected' | 'disconnected' | 'held' | 'other'
/**
 * What wrote a record: a person here, an invitation either side, a connect link either side, Mousse ID, or the
 * one-time step for older stores.
 */
export type ConnectionSource = 'person' | 'invite' | 'join' | 'link' | 'account' | 'migration'
type Written = 'connected' | 'disconnected' | 'held'

export interface ConnectionEvent {
  node: NodeId
  before: ConnectionState
  after: ConnectionState
}

const KNOWN = new Set(['connected', 'disconnected', 'held'])

/** `net_connections`, in the Net database. Read on every call and record push, so answered from memory. */
export class SqliteConnections {
  private readonly listeners = new Set<(events: readonly ConnectionEvent[]) => void>()
  private readonly states = new Map<string, ConnectionState>()
  constructor(
    private readonly db: NetDatabase,
    private readonly clock: Clock
  ) {
    for (const row of this.db.database.prepare('SELECT node,state FROM net_connections').all())
      this.states.set(String(row.node), read(String(row.state)))
  }

  state(node: NodeId): ConnectionState {
    return this.states.get(node) ?? 'none'
  }
  connected(node: NodeId): boolean {
    return this.states.get(node) === 'connected'
  }
  /** The one-time step for a store from before this record: done, or not yet. */
  migrated(): boolean {
    return !!this.db.database
      .prepare('SELECT 1 FROM net_local_markers WHERE name=?')
      .get(CONNECTIONS_MARKER)
  }
  /**
   * For a store from before this record: every device listed now counts as connected, so nothing that worked stops,
   * and the marker is written in the same transaction, so this runs once.
   */
  migrate(listed: readonly NodeId[]): void {
    if (this.migrated()) return
    this.write(listed, 'connected', 'migration', { onlyUnrecorded: true, marker: true })
  }
  set(node: NodeId, state: Written, source: ConnectionSource): void {
    if (!isId('node', node) || !KNOWN.has(state)) throw new NetError('bad_request')
    this.write([node], state, source, { onlyUnrecorded: false, marker: false })
  }
  /** Connects the devices that have no record yet; a device that was disconnected stays so. */
  connectUnrecorded(nodes: readonly NodeId[], source: ConnectionSource): void {
    const fresh = nodes.filter((node) => isId('node', node) && !this.states.has(node))
    if (fresh.length) this.write(fresh, 'connected', source, { onlyUnrecorded: true, marker: false })
  }
  onChange(listener: (events: readonly ConnectionEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private write(
    nodes: readonly NodeId[],
    state: Written,
    source: ConnectionSource,
    options: { onlyUnrecorded: boolean; marker: boolean }
  ): void {
    const now = this.clock.now(),
      written: NodeId[] = []
    this.db.transaction(() => {
      for (const node of new Set(nodes)) {
        const held = this.db.database
          .prepare('SELECT state FROM net_connections WHERE node=?')
          .get(node)
        if (held && (options.onlyUnrecorded || String(held.state) === state)) continue
        this.db.charge(1)
        this.db.database
          .prepare(
            'INSERT INTO net_connections(node,state,source,at) VALUES(?,?,?,?) ' +
              'ON CONFLICT(node) DO UPDATE SET state=excluded.state,source=excluded.source,at=excluded.at'
          )
          .run(node, state, source, now)
        written.push(node)
      }
      if (options.marker)
        this.db.database
          .prepare('INSERT OR IGNORE INTO net_local_markers VALUES(?,?)')
          .run(CONNECTIONS_MARKER, now)
      // Listeners end live work, so they run only once the record is durable.
      this.db.afterCommit(() => {
        const events: ConnectionEvent[] = []
        for (const node of written) {
          const before = this.state(node)
          this.states.set(node, state)
          if (before !== state) events.push({ node, before, after: state })
        }
        if (events.length) this.notify(events)
      })
    })
  }
  private notify(events: readonly ConnectionEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(events)
      } catch {
        // One listener failing cannot keep a disconnect from taking effect in the others.
      }
    }
  }
}

function read(value: string): ConnectionState {
  return KNOWN.has(value) ? (value as Written) : 'other'
}
