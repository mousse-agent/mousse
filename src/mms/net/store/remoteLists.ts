import type { NodeId } from '../../../shared/net'
import type { Clock } from '../contracts'
import type { NetDatabase } from './database'

/** The last lists a computer sent are kept for when it is offline, at most this much for each computer. */
export const REMOTE_LISTS_CACHE_MAX_BYTES = 2 * 1024 * 1024
/** A thread opened on this computer notifies for this long. */
export const REMOTE_THREAD_OPENED_KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** A transaction may touch only so many rows (`STORE_TXN_MAX_ROWS`), so a long list is written in batches. */
const BATCH_ROWS = 400

export interface CachedLists {
  node: NodeId
  savedAt: number
  /** The snapshot as the other computer wrote it, as JSON text. */
  snapshot: string
}

/**
 * What this computer remembers about the threads of its other computers, in the Net database:
 * - `remote_thread_order`: where a thread of another computer sits among the rows of its group here, so
 *   a row never moves unless a person moves it or sends in it;
 * - `remote_thread_opened`: when a thread was last opened here, for the notification rule;
 * - `remote_lists_cache`: the last lists each computer sent, so its threads stay listed while it is offline.
 *
 * Kept on this computer only, never sent anywhere. A write can fail (a full disk); the caller treats
 * that as best effort and keeps its in-memory state.
 */
export class SqliteRemoteLists {
  constructor(
    private readonly db: NetDatabase,
    private readonly clock: Clock
  ) {}

  positions(node: NodeId): Map<string, number> {
    const rows = this.db.database
      .prepare('SELECT thread,position FROM remote_thread_order WHERE node=?')
      .all(node)
    return new Map(rows.map((row) => [String(row.thread), Number(row.position)]))
  }

  setPositions(node: NodeId, entries: ReadonlyArray<readonly [string, number]>): void {
    for (let at = 0; at < entries.length; at += BATCH_ROWS) {
      const batch = entries.slice(at, at + BATCH_ROWS)
      this.db.transaction(() => {
        this.db.charge(batch.length, batch.length * 64)
        const write = this.db.database.prepare(
          'INSERT INTO remote_thread_order(node,thread,position) VALUES(?,?,?) ON CONFLICT(node,thread) DO UPDATE SET position=excluded.position'
        )
        for (const [thread, position] of batch) write.run(node, thread, position)
      })
    }
  }

  /** Forgets the positions of the threads of `node` that are not in `keep`. */
  forgetPositions(node: NodeId, keep: ReadonlySet<string>): void {
    const stored = [...this.positions(node).keys()].filter((thread) => !keep.has(thread))
    for (let at = 0; at < stored.length; at += BATCH_ROWS) {
      const batch = stored.slice(at, at + BATCH_ROWS)
      this.db.transaction(() => {
        this.db.charge(batch.length, batch.length * 64)
        const remove = this.db.database.prepare(
          'DELETE FROM remote_thread_order WHERE node=? AND thread=?'
        )
        for (const thread of batch) remove.run(node, thread)
      })
    }
  }

  markOpened(node: NodeId, thread: string): void {
    this.db.transaction(() => {
      this.db.charge(1, 64)
      this.db.database
        .prepare(
          'INSERT INTO remote_thread_opened(node,thread,opened_at) VALUES(?,?,?) ON CONFLICT(node,thread) DO UPDATE SET opened_at=excluded.opened_at'
        )
        .run(node, thread, this.clock.now())
    })
  }

  /** Threads opened here within the last seven days, by `<node>|<thread>`; older rows are dropped. */
  opened(): Map<string, number> {
    const cutoff = this.clock.now() - REMOTE_THREAD_OPENED_KEEP_MS
    this.db.transaction(() => {
      this.db.charge(1, 16)
      this.db.database.prepare('DELETE FROM remote_thread_opened WHERE opened_at < ?').run(cutoff)
    })
    const rows = this.db.database
      .prepare('SELECT node,thread,opened_at FROM remote_thread_opened')
      .all()
    return new Map(rows.map((row) => [`${row.node}|${row.thread}`, Number(row.opened_at)]))
  }

  saveSnapshot(node: NodeId, snapshot: string): void {
    if (Buffer.byteLength(snapshot) > REMOTE_LISTS_CACHE_MAX_BYTES) return
    this.db.transaction(() => {
      // One row; its size is bounded above, and is larger than the bytes a transaction is otherwise allowed.
      this.db.charge(1)
      this.db.database
        .prepare(
          'INSERT INTO remote_lists_cache(node,saved_at,snapshot) VALUES(?,?,?) ON CONFLICT(node) DO UPDATE SET saved_at=excluded.saved_at, snapshot=excluded.snapshot'
        )
        .run(node, this.clock.now(), snapshot)
    })
  }

  snapshots(): CachedLists[] {
    const rows = this.db.database
      .prepare('SELECT node,saved_at,snapshot FROM remote_lists_cache')
      .all()
    return rows.map((row) => ({
      node: String(row.node) as NodeId,
      savedAt: Number(row.saved_at),
      snapshot: String(row.snapshot)
    }))
  }

  /** Forgets the copy of one computer's lists. */
  dropCache(node: NodeId): void {
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database.prepare('DELETE FROM remote_lists_cache WHERE node=?').run(node)
    })
  }

  /** Forgets the copies of every computer's lists (routing went off); positions and openings stay. */
  dropCaches(): void {
    this.db.transaction(() => {
      this.db.charge(1)
      this.db.database.prepare('DELETE FROM remote_lists_cache').run()
    })
  }

  /** Forgets everything kept about computers that are not in `keep` (they left the roster, or were blocked). */
  dropOthers(keep: readonly NodeId[]): void {
    const kept = new Set<string>(keep)
    const known = new Set<string>()
    for (const table of ['remote_thread_order', 'remote_thread_opened', 'remote_lists_cache'])
      for (const row of this.db.database.prepare(`SELECT DISTINCT node FROM ${table}`).all())
        known.add(String(row.node))
    for (const node of known) if (!kept.has(node)) this.dropComputer(node as NodeId)
  }

  /** Forgets everything kept about a computer (it was removed from the user's computers). */
  dropComputer(node: NodeId): void {
    this.db.transaction(() => {
      this.db.charge(3, 48)
      for (const table of ['remote_thread_order', 'remote_thread_opened', 'remote_lists_cache'])
        this.db.database.prepare(`DELETE FROM ${table} WHERE node=?`).run(node)
    })
  }
}
