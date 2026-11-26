import { str, type Row } from '../db/rows'
import type { RunStore } from '../RunStore'

/**
 * Whether each remote subagent's thread on its computer must be archived: table `remote_archive`, one row per subagent,
 * made the first time its stand-in here is archived. The app's Archive or Unarchive of the stand-in marks the row
 * `pending`; `RemoteSubagents` sends it to its computer (`threads.archive`) until that computer takes it, across restarts
 * and while it is offline, as it does a Stop. A computer that will not take it leaves the row `left_open`. An agent's
 * `thread_archive` of the stand-in waits for that computer's answer itself, and the row records it as `sent`.
 */

export type RemoteArchiveState = 'pending' | 'sent' | 'left_open'

export interface RemoteArchiveRecord {
  /** The subagent's stand-in thread here. */
  childThreadId: string
  node: string
  /** Its thread there. */
  remoteThreadId: string
  /** What it must be there. */
  archived: boolean
  /** Rises with each change, so a change is never mistaken for an older one already sent. */
  generation: number
  /** Rises when that computer refused a send of this change for now (still working there): the next send is a new request. */
  attempt: number
  state: RemoteArchiveState
  /** Why it is not so there yet (`pending`), or why that computer would not take it (`left_open`). */
  lastError: string | null
  createdAt: string
  updatedAt: string
}

function fromRow(row: Row): RemoteArchiveRecord {
  return {
    childThreadId: String(row.child_thread_id),
    node: String(row.node),
    remoteThreadId: String(row.remote_thread_id),
    archived: Number(row.archived) === 1,
    generation: Number(row.generation),
    attempt: Number(row.attempt ?? 0),
    state: row.state === 'pending' ? 'pending' : row.state === 'left_open' ? 'left_open' : 'sent',
    lastError: str(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/** The rows of `remote_archive`. Synchronous; every write joins the caller's transaction. */
export class RemoteArchiveRecords {
  constructor(private readonly store: RunStore) {}

  get(childThreadId: string): RemoteArchiveRecord | null {
    const row = this.store.db.statement('SELECT * FROM remote_archive WHERE child_thread_id = ?').get(childThreadId)
    return row ? fromRow(row) : null
  }

  /**
   * The subagent's thread there must be `archived`. A row that already says so changes nothing; any other is pending
   * again with a higher generation. A subagent with no row is given one only to archive: a thread there that was never
   * archived from here needs no unarchive. Returns whether the row is pending now.
   */
  want(input: { childThreadId: string; node: string; remoteThreadId: string; archived: boolean }): boolean {
    const now = this.now()
    const flag = input.archived ? 1 : 0
    const current = this.get(input.childThreadId)
    if (!current) {
      if (!input.archived) return false
      this.store.db
        .statement(
          `INSERT INTO remote_archive(child_thread_id, node, remote_thread_id, archived, generation, state, created_at, updated_at)
           VALUES(?, ?, ?, 1, 1, 'pending', ?, ?)`
        )
        .run(input.childThreadId, input.node, input.remoteThreadId, now, now)
      return true
    }
    // The same wish, already sent or on its way: nothing new. One left open is tried again: the person asked again.
    if (current.archived === input.archived && current.state !== 'left_open') return current.state === 'pending'
    this.store.db
      .statement(
        `UPDATE remote_archive SET archived = ?, remote_thread_id = ?, generation = generation + 1, attempt = 0, state = 'pending', last_error = NULL, updated_at = ?
         WHERE child_thread_id = ?`
      )
      .run(flag, input.remoteThreadId, now, input.childThreadId)
    return true
  }

  /**
   * That computer took an agent's archive (or unarchive) of the subagent's thread there (`thread_archive` of its
   * stand-in): the row says so, sent, and a change still on its way from before is superseded (a higher generation).
   */
  acknowledged(input: { childThreadId: string; node: string; remoteThreadId: string; archived: boolean }): void {
    const now = this.now()
    const flag = input.archived ? 1 : 0
    if (!this.get(input.childThreadId)) {
      if (!input.archived) return
      this.store.db
        .statement(
          `INSERT INTO remote_archive(child_thread_id, node, remote_thread_id, archived, generation, state, created_at, updated_at)
           VALUES(?, ?, ?, 1, 1, 'sent', ?, ?)`
        )
        .run(input.childThreadId, input.node, input.remoteThreadId, now, now)
      return
    }
    this.store.db
      .statement(
        `UPDATE remote_archive SET archived = ?, remote_thread_id = ?, generation = generation + 1, attempt = 0, state = 'sent', last_error = NULL, updated_at = ?
         WHERE child_thread_id = ?`
      )
      .run(flag, input.remoteThreadId, now, input.childThreadId)
  }

  /** The rows still to send, oldest first. */
  listPending(): RemoteArchiveRecord[] {
    return this.store.db
      .statement(`SELECT * FROM remote_archive WHERE state = 'pending' ORDER BY updated_at, rowid`)
      .all()
      .map(fromRow)
  }

  hasPending(): boolean {
    return Boolean(this.store.db.statement(`SELECT 1 FROM remote_archive WHERE state = 'pending' LIMIT 1`).get())
  }

  /** That computer took `generation`, or its thread there is gone: sent, unless a newer change came meanwhile. */
  markSent(childThreadId: string, generation: number): void {
    this.settle(childThreadId, generation, 'sent', null)
  }

  /** That computer will not take `generation`: left open there, with why. */
  markLeftOpen(childThreadId: string, generation: number, reason: string): void {
    this.settle(childThreadId, generation, 'left_open', reason)
  }

  /** Not delivered yet (offline, still working there): kept pending, with why. `updated_at` stays the time of the wish. */
  noteError(childThreadId: string, generation: number, error: string): void {
    this.store.db
      .statement('UPDATE remote_archive SET last_error = ? WHERE child_thread_id = ? AND generation = ?')
      .run(error, childThreadId, generation)
  }

  /**
   * That computer refused `generation` for now (the thread still works there) and keeps that refusal under the key it was
   * sent with: still pending, and the next send is a new request (`attempt`). `updated_at` stays the time of the wish.
   */
  noteRefused(childThreadId: string, generation: number, error: string): void {
    this.store.db
      .statement('UPDATE remote_archive SET last_error = ?, attempt = attempt + 1 WHERE child_thread_id = ? AND generation = ?')
      .run(error, childThreadId, generation)
  }

  /**
   * The stand-in here is not what `generation` asked of its thread there (its own change here never happened: the
   * process ended between the two writes): nothing is sent, and the row says what it is here.
   */
  superseded(childThreadId: string, generation: number, archived: boolean): void {
    this.store.db
      .statement(
        `UPDATE remote_archive SET archived = ?, generation = generation + 1, attempt = 0, state = 'sent', last_error = NULL, updated_at = ?
         WHERE child_thread_id = ? AND generation = ?`
      )
      .run(archived ? 1 : 0, this.now(), childThreadId, generation)
  }

  private settle(childThreadId: string, generation: number, state: RemoteArchiveState, reason: string | null): void {
    this.store.db
      .statement(`UPDATE remote_archive SET state = ?, last_error = ?, updated_at = ? WHERE child_thread_id = ? AND generation = ?`)
      .run(state, reason, this.now(), childThreadId, generation)
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}
