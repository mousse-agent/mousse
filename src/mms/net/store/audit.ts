import type { NodeId } from '../../../shared/net'
import type { Clock } from '../contracts'
import type { NetDatabase } from './database'

/** One call another computer made on this one, as the Devices screen shows it. */
export interface BridgeAuditEntry {
  at: number
  node: NodeId
  /** The protocol method (`files.write`), not the Net method. */
  method: string
  thread?: string
  project?: string
  /** `ok`, or the reason the call was refused here (`thread_not_found`, `forbidden`, ...). */
  outcome: string
}

/** What a computer read from this one in one hour: how many calls and how many bytes of results. */
export interface BridgeReadTotal {
  node: NodeId
  hour: number
  calls: number
  bytes: number
}

/** Rows of `bridge_audit` kept; the oldest go first. */
export const BRIDGE_AUDIT_MAX_ROWS = 20_000
/** Hourly read totals are kept this long. */
export const BRIDGE_READ_TOTALS_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const PRUNE_EVERY = 500

/**
 * What other computers did on this one (`bridge_audit`), and how much they read (`bridge_audit_reads`).
 * Kept in the Net database on this computer only. Changes and refusals are rows; reads are only
 * counted per computer and hour, because stealing data is read volume, not a list of file names.
 * Best effort: a write that fails never decides whether a call runs.
 */
export class SqliteBridgeAudit {
  private inserts = 0
  constructor(
    private readonly db: NetDatabase,
    private readonly clock: Clock
  ) {}

  record(entry: Omit<BridgeAuditEntry, 'at'>): void {
    try {
      this.db.transaction(() => {
        this.db.charge(1, 192)
        this.db.database
          .prepare(
            'INSERT INTO bridge_audit(at,node,method,thread,project,outcome) VALUES(?,?,?,?,?,?)'
          )
          .run(
            this.clock.now(),
            entry.node,
            entry.method.slice(0, 96),
            entry.thread?.slice(0, 256) ?? null,
            entry.project?.slice(0, 256) ?? null,
            entry.outcome.slice(0, 96)
          )
        if (++this.inserts % PRUNE_EVERY === 0) this.prune()
      })
    } catch {
      // The audit never decides whether a call runs.
    }
  }

  countRead(node: NodeId, bytes: number): void {
    try {
      const hour = Math.floor(this.clock.now() / HOUR_MS)
      this.db.transaction(() => {
        this.db.charge(1, 32)
        this.db.database
          .prepare(
            'INSERT INTO bridge_audit_reads(node,hour,calls,bytes) VALUES(?,?,1,?) ON CONFLICT(node,hour) DO UPDATE SET calls=calls+1,bytes=bytes+excluded.bytes'
          )
          .run(node, hour, Math.max(0, Math.floor(bytes)))
      })
    } catch {
      // Counting is best effort too.
    }
  }

  recent(limit = 100, node?: NodeId): BridgeAuditEntry[] {
    const rows = (
      node
        ? this.db.database
            .prepare(
              'SELECT at,node,method,thread,project,outcome FROM bridge_audit WHERE node=? ORDER BY id DESC LIMIT ?'
            )
            .all(node, limit)
        : this.db.database
            .prepare(
              'SELECT at,node,method,thread,project,outcome FROM bridge_audit ORDER BY id DESC LIMIT ?'
            )
            .all(limit)
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      at: Number(row.at),
      node: row.node as NodeId,
      method: String(row.method),
      ...(row.thread === null ? {} : { thread: String(row.thread) }),
      ...(row.project === null ? {} : { project: String(row.project) }),
      outcome: String(row.outcome)
    }))
  }

  reads(node?: NodeId): BridgeReadTotal[] {
    const rows = (
      node
        ? this.db.database
            .prepare(
              'SELECT node,hour,calls,bytes FROM bridge_audit_reads WHERE node=? ORDER BY hour DESC'
            )
            .all(node)
        : this.db.database
            .prepare('SELECT node,hour,calls,bytes FROM bridge_audit_reads ORDER BY hour DESC')
            .all()
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      node: row.node as NodeId,
      hour: Number(row.hour),
      calls: Number(row.calls),
      bytes: Number(row.bytes)
    }))
  }

  /** Keeps the newest rows and the recent hourly totals. Runs inside the insert that triggers it. */
  prune(): void {
    this.db.database
      .prepare(
        'DELETE FROM bridge_audit WHERE id <= (SELECT COALESCE(MAX(id),0) FROM bridge_audit) - ?'
      )
      .run(BRIDGE_AUDIT_MAX_ROWS)
    this.db.database
      .prepare('DELETE FROM bridge_audit_reads WHERE hour < ?')
      .run(Math.floor((this.clock.now() - BRIDGE_READ_TOTALS_KEEP_MS) / HOUR_MS))
  }
}
