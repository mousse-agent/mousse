import type { NodeId } from '../../../shared/net'
import type { Clock } from '../contracts'
import type { NetDatabase } from './database'

/**
 * `change`: a routed call that changed something here, or may have (`uncertain`).
 * `refused`: a call that was admitted and then refused (the thread was gone, the limit forbade it...).
 */
export type BridgeAuditKind = 'change' | 'refused'

/** One call another computer made on this one, as the Devices screen shows it. */
export interface BridgeAuditEntry {
  at: number
  node: NodeId
  /** The protocol method (`files.write`), not the Net method. */
  method: string
  thread?: string
  project?: string
  /** `ok`, `uncertain`, or the reason the call was refused here (`thread_not_found`, ...). */
  outcome: string
  kind: BridgeAuditKind
}

/** What a computer read from this one in one hour: how many calls and how many bytes of results. */
export interface BridgeReadTotal {
  node: NodeId
  hour: number
  calls: number
  bytes: number
}

/**
 * What a device did is kept per device and per kind, so the device cannot push its own record out:
 * - A change row is deleted only when it is older than this AND beyond the newest `CHANGE_ROWS_PER_NODE`
 *   rows of that device. A flood of refusals never touches it, and replacing it takes that many real changes.
 * - Refusals have a small budget of their own, newest first.
 * - Refused reads are never rows (they are counted with the reads), so a device cannot make refusals for free.
 */
export const BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE = 20_000
export const BRIDGE_AUDIT_CHANGE_KEEP_MS = 30 * 24 * 60 * 60 * 1000
export const BRIDGE_AUDIT_REFUSED_ROWS_PER_NODE = 1_000
/** Hourly read totals are kept this long. */
export const BRIDGE_READ_TOTALS_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const PRUNE_EVERY = 50

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
            'INSERT INTO bridge_audit(at,node,kind,method,thread,project,outcome) VALUES(?,?,?,?,?,?,?)'
          )
          .run(
            this.clock.now(),
            entry.node,
            entry.kind,
            entry.method.slice(0, 96),
            entry.thread?.slice(0, 256) ?? null,
            entry.project?.slice(0, 256) ?? null,
            entry.outcome.slice(0, 96)
          )
        if (++this.inserts % PRUNE_EVERY === 0) this.prune(entry.node)
      })
    } catch {
      // The audit never decides whether a call runs.
    }
  }

  /** Whether this computer has a change row of `method` for `node` (the first terminal a device opens is told apart by it). */
  has(node: NodeId, method: string): boolean {
    try {
      return (
        this.db.database
          .prepare("SELECT 1 FROM bridge_audit WHERE node=? AND kind='change' AND method=? LIMIT 1")
          .get(node, method) !== undefined
      )
    } catch {
      // Unknown means a notice that may repeat, never one that is lost.
      return false
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

  /** The newest rows of one `method` for `node` since `since`: a query by method and time, not a look at the last rows. */
  since(node: NodeId, method: string, since: number, limit = 50): BridgeAuditEntry[] {
    const rows = this.db.database
      .prepare(
        'SELECT at,node,kind,method,thread,project,outcome FROM bridge_audit WHERE node=? AND method=? AND at>=? ORDER BY id DESC LIMIT ?'
      )
      .all(node, method, since, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      at: Number(row.at),
      node: String(row.node) as NodeId,
      kind: row.kind as BridgeAuditKind,
      method: String(row.method),
      ...(row.thread ? { thread: String(row.thread) } : {}),
      ...(row.project ? { project: String(row.project) } : {}),
      outcome: String(row.outcome)
    }))
  }

  recent(limit = 100, node?: NodeId): BridgeAuditEntry[] {
    const columns = 'at,node,kind,method,thread,project,outcome'
    const rows = (
      node
        ? this.db.database
            .prepare(`SELECT ${columns} FROM bridge_audit WHERE node=? ORDER BY id DESC LIMIT ?`)
            .all(node, limit)
        : this.db.database
            .prepare(`SELECT ${columns} FROM bridge_audit ORDER BY id DESC LIMIT ?`)
            .all(limit)
    ) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      at: Number(row.at),
      node: row.node as NodeId,
      kind: row.kind as BridgeAuditKind,
      method: String(row.method),
      ...(row.thread === null ? {} : { thread: String(row.thread) }),
      ...(row.project === null ? {} : { project: String(row.project) }),
      outcome: String(row.outcome)
    }))
  }

  /**
   * What one device did since `since`, for the one-line summary: the changes that went through, counted per
   * method; the ones that may have happened; and the calls that were refused. Notice rows are included, so the
   * caller decides what to count.
   */
  summary(
    node: NodeId,
    since: number
  ): { counts: Array<{ method: string; count: number }>; uncertain: number; refused: number } {
    const rows = this.db.database
      .prepare(
        'SELECT method, kind, outcome = ? AS lost, COUNT(*) AS n FROM bridge_audit WHERE node=? AND at>=? GROUP BY method, kind, lost'
      )
      .all('uncertain', node, since) as Array<{
      method: string
      kind: BridgeAuditKind
      lost: number
      n: number
    }>
    const counts = new Map<string, number>()
    let uncertain = 0
    let refused = 0
    for (const row of rows) {
      if (row.kind === 'refused') refused += row.n
      else if (row.lost) uncertain += row.n
      else counts.set(row.method, (counts.get(row.method) ?? 0) + row.n)
    }
    return {
      counts: [...counts.entries()].map(([method, count]) => ({ method, count })),
      uncertain,
      refused
    }
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

  /** Applies both budgets to one device. Runs inside the insert that triggers it. */
  prune(node: NodeId): void {
    this.db.database
      .prepare(
        'DELETE FROM bridge_audit WHERE node=? AND kind=? AND id IN (SELECT id FROM bridge_audit WHERE node=? AND kind=? ORDER BY id DESC LIMIT -1 OFFSET ?)'
      )
      .run(node, 'refused', node, 'refused', BRIDGE_AUDIT_REFUSED_ROWS_PER_NODE)
    this.db.database
      .prepare(
        'DELETE FROM bridge_audit WHERE node=? AND kind=? AND at<? AND id IN (SELECT id FROM bridge_audit WHERE node=? AND kind=? ORDER BY id DESC LIMIT -1 OFFSET ?)'
      )
      .run(
        node,
        'change',
        this.clock.now() - BRIDGE_AUDIT_CHANGE_KEEP_MS,
        node,
        'change',
        BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE
      )
    this.db.database
      .prepare('DELETE FROM bridge_audit_reads WHERE hour < ?')
      .run(Math.floor((this.clock.now() - BRIDGE_READ_TOTALS_KEEP_MS) / HOUR_MS))
  }
}
