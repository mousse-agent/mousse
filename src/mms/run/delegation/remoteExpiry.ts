import { int, str, type Row } from '../db/rows'
import type { RunStore } from '../RunStore'

/**
 * The expiry each remote subagent's thread on its computer must have (issue #685): table `remote_expiry`, one row per
 * subagent. A subagent expires with its root thread here (`Thread.expiresAt`); its thread there is an ordinary thread of
 * that computer, so it is given the same expiry and that computer deletes it then, also after being offline. Setting,
 * changing and removing the expiry here marks the rows `pending`; `RemoteSubagents` sends each to its computer
 * (`threads.setExpiry`) until that computer takes it, across restarts and while it is offline.
 */

export type RemoteExpiryState = 'pending' | 'sent'

export interface RemoteExpiryRecord {
  /** The subagent's stand-in thread here. */
  childThreadId: string
  /** The thread here whose expiry it follows. */
  rootThreadId: string
  node: string
  /** Its thread there; null until that computer created it. */
  remoteThreadId: string | null
  /** The expiry it must have there; null for none. */
  expiresAt: string | null
  stopsRun: boolean
  /** Rises with each change, so a change is never mistaken for an older one already sent. */
  generation: number
  state: RemoteExpiryState
  lastError: string | null
  createdAt: string
  updatedAt: string
}

function fromRow(row: Row): RemoteExpiryRecord {
  return {
    childThreadId: String(row.child_thread_id),
    rootThreadId: String(row.root_thread_id),
    node: String(row.node),
    remoteThreadId: str(row.remote_thread_id),
    expiresAt: str(row.expires_at),
    stopsRun: int(row.stops_run) === 1,
    generation: Number(row.generation),
    state: row.state === 'pending' ? 'pending' : 'sent',
    lastError: str(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/** The rows of `remote_expiry`. Synchronous; every write joins the caller's transaction. */
export class RemoteExpiryRecords {
  constructor(private readonly store: RunStore) {}

  /**
   * Starts following the expiry of `rootThreadId` for a subagent (its first task). A subagent already followed keeps its
   * row. Nothing is pending without an expiry: a new thread there has none.
   */
  track(input: { childThreadId: string; rootThreadId: string; node: string; expiresAt: string | null; stopsRun: boolean }): RemoteExpiryRecord {
    const now = this.now()
    this.store.db
      .statement(
        `INSERT INTO remote_expiry(child_thread_id, root_thread_id, node, expires_at, stops_run, generation, state, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT(child_thread_id) DO NOTHING`
      )
      .run(input.childThreadId, input.rootThreadId, input.node, input.expiresAt, input.expiresAt && input.stopsRun ? 1 : 0, input.expiresAt ? 'pending' : 'sent', now, now)
    return this.get(input.childThreadId)!
  }

  get(childThreadId: string): RemoteExpiryRecord | null {
    const row = this.store.db.statement('SELECT * FROM remote_expiry WHERE child_thread_id = ?').get(childThreadId)
    return row ? fromRow(row) : null
  }

  /** Its thread there exists now. */
  setRemoteThread(childThreadId: string, remoteThreadId: string): void {
    this.store.db
      .statement('UPDATE remote_expiry SET remote_thread_id = ?, updated_at = ? WHERE child_thread_id = ? AND remote_thread_id IS NULL')
      .run(remoteThreadId, this.now(), childThreadId)
  }

  /**
   * The root's expiry is now `expiresAt` (null: removed): every subagent that follows it must have it there. A row that
   * already has it changes nothing; any other is pending again with a higher generation. Returns how many changed.
   */
  rootChanged(rootThreadId: string, expiresAt: string | null, stopsRun: boolean): number {
    const stops = expiresAt && stopsRun ? 1 : 0
    const result = this.store.db
      .statement(
        `UPDATE remote_expiry SET expires_at = ?, stops_run = ?, generation = generation + 1, state = 'pending', last_error = NULL, updated_at = ?
         WHERE root_thread_id = ? AND (expires_at IS NOT ? OR stops_run <> ?)`
      )
      .run(expiresAt, stops, this.now(), rootThreadId, expiresAt, stops)
    return Number(result.changes ?? 0)
  }

  /** The rows still to send, oldest first. */
  listPending(): RemoteExpiryRecord[] {
    return this.store.db
      .statement(`SELECT * FROM remote_expiry WHERE state = 'pending' ORDER BY created_at, rowid`)
      .all()
      .map(fromRow)
  }

  hasPending(): boolean {
    return Boolean(this.store.db.statement(`SELECT 1 FROM remote_expiry WHERE state = 'pending' AND remote_thread_id IS NOT NULL LIMIT 1`).get())
  }

  /** That computer took `generation` (or its thread there is gone): sent, unless a newer change came meanwhile. */
  /** Nothing more to send for `generation`; `refused` keeps why that computer would not take it. */
  markSent(childThreadId: string, generation: number, refused?: string): void {
    this.store.db
      .statement(`UPDATE remote_expiry SET state = 'sent', last_error = ?, updated_at = ? WHERE child_thread_id = ? AND generation = ?`)
      .run(refused ?? null, this.now(), childThreadId, generation)
  }

  noteError(childThreadId: string, generation: number, error: string): void {
    this.store.db
      .statement('UPDATE remote_expiry SET last_error = ?, updated_at = ? WHERE child_thread_id = ? AND generation = ?')
      .run(error, this.now(), childThreadId, generation)
  }

  /** The subagent is gone here and nothing is left to send. */
  remove(childThreadId: string): void {
    this.store.db.statement(`DELETE FROM remote_expiry WHERE child_thread_id = ? AND state = 'sent'`).run(childThreadId)
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}
