import { fail } from './db/RunStoreError'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'
import { str, type Row } from './db/rows'
import {
  DEFAULT_EFFECT_MAX_ATTEMPTS,
  EFFECT_KIND_SPEC,
  effectLaneClass,
  type EffectClass,
  type EffectKind,
  type EffectKindSpec,
  type EffectLaneClass,
  type EffectRecord,
  type EffectStatus
} from './types'

/** Extra lease time beyond the execution deadline (SPEC §12.3). */
export const EFFECT_LEASE_GRACE_MS = 15_000
const BACKOFF_BASE_MS = 100
const BACKOFF_MAX_MS = 30_000

export type EffectSettlement =
  { settled: true; effect: EffectRecord } | { settled: false; status: EffectStatus | null }

export interface EffectOutboxOptions {
  /** Test-only override of the §12.2 table (e.g. a short timeout). Merged over the defaults. */
  kindSpec?: Partial<Record<EffectKind, EffectKindSpec>>
  now?: () => string
  /** Test-only: lets reserved kinds (SPEC §12.2, no producer yet) be enqueued to exercise lanes. */
  allowReservedKinds?: boolean
}

/** Newest effects `runs.effects` returns per page. */
export const EFFECT_PAGE_MAX = 200

/** `min(30 s, 100 ms·2^(attempts−1))` (SPEC §12.3). */
export function effectBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

/**
 * Durable effect outbox (SPEC §12.1-§12.3) over the run database. Synchronous; every mutation
 * joins the caller's transaction or opens its own and appends an `effect.status` thread event
 * carrying the full record. Settlement is compare-and-set on `(status='running', lease_owner)`.
 */
export class EffectOutbox {
  readonly kindSpec: Readonly<Record<EffectKind, EffectKindSpec>>
  private readonly now: () => string
  private readonly allowReservedKinds: boolean
  private readonly listeners = new Set<() => void>()
  private readonly claimSql: string
  /** Claim statements restricted to a set of lane classes, keyed by the sorted class list. */
  private readonly claimSqlByLanes = new Map<string, string>()

  constructor(
    readonly store: RunStore,
    options: EffectOutboxOptions = {}
  ) {
    this.kindSpec = { ...EFFECT_KIND_SPEC, ...(options.kindSpec ?? {}) }
    this.now = options.now ?? (() => new Date(store.db.clock()).toISOString())
    this.allowReservedKinds = options.allowReservedKinds === true
    const lanes = (['title', 'control'] as const)
      .map((lane) => ({
        lane,
        kinds: (Object.keys(this.kindSpec) as EffectKind[])
          .filter((kind) => this.kindSpec[kind].lane === lane)
          .map((kind) => `'${kind}'`)
      }))
      .filter(({ kinds }) => kinds.length)
    const laneOf = (alias: string): string =>
      `(CASE ${lanes
        .map(({ lane, kinds }) => `WHEN ${alias}.kind IN (${kinds.join(',')}) THEN '${lane}' `)
        .join('')}ELSE 'thread' END)`
    // A candidate is claimable only when nothing else in its lane is live: no running row with an
    // unexpired lease, and no earlier pending row, even one waiting out a backoff or a deferral
    // (SPEC §12.3: a lane is FIFO). Each thread has three lanes: the thread lane (turns and
    // replay-safe work), the control lane (interrupt, steer and answers, which must reach a live
    // turn) and the title lane.
    this.claimSql = `UPDATE effects SET status = 'running', attempts = attempts + 1,
        lease_owner = :owner, updated_at = :now,
        lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', :now,
          '+' || ((timeout_ms + ${EFFECT_LEASE_GRACE_MS}) / 1000.0) || ' seconds')
      WHERE effect_id = (
        SELECT c.effect_id FROM effects c
        WHERE c.status = 'pending' AND c.available_at <= :now /*lanes*/
          AND NOT EXISTS (
            SELECT 1 FROM effects o
            WHERE o.thread_id = c.thread_id AND o.rowid <> c.rowid
              AND ${laneOf('o')} = ${laneOf('c')}
              AND ((o.status = 'running' AND o.lease_expires_at > :now)
                OR (o.status = 'pending' AND o.rowid < c.rowid)))
        ORDER BY c.available_at, c.rowid LIMIT 1)
      RETURNING *`
  }

  /** Registers a callback run after any commit that may make an effect claimable. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  specFor(kind: EffectKind): EffectKindSpec {
    const spec = this.kindSpec[kind] as EffectKindSpec | undefined
    if (!spec) fail('bad_request', `Unknown effect kind ${String(kind)}.`)
    return spec
  }

  /**
   * Inserts a pending effect. The default id is deterministic,
   * `effect:<runId|threadId>:<kind>:<n>` with n = existing effects of that kind for the run (or
   * run-less thread) + 1. An existing id is left untouched and returned (no event). A reserved kind
   * (SPEC §12.2: no producer and no executor yet) is refused with `bad_request`.
   */
  enqueue(input: {
    effectId?: string
    threadId: string
    runId?: string | null
    kind: EffectKind
    payload?: unknown
    availableAt?: string
  }): EffectRecord {
    const spec = this.specFor(input.kind)
    if (spec.reserved && !this.allowReservedKinds) fail('bad_request', 'reserved effect kind')
    return this.db.transaction(() => {
      const runId = input.runId ?? null
      const effectId = input.effectId ?? this.nextEffectId(input.threadId, runId, input.kind)
      const now = this.now()
      const inserted = this.db
        .statement(
          `INSERT INTO effects(effect_id, thread_id, run_id, kind, class, status, payload, attempts,
             max_attempts, timeout_ms, available_at, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)
           ON CONFLICT(effect_id) DO NOTHING RETURNING *`
        )
        .get(
          effectId,
          input.threadId,
          runId,
          input.kind,
          spec.class,
          stableStringify(input.payload ?? null),
          spec.maxAttempts ?? DEFAULT_EFFECT_MAX_ATTEMPTS,
          spec.timeoutMs,
          input.availableAt ?? now,
          now,
          now
        )
      if (!inserted) return this.get(effectId)!
      return this.recorded(toEffect(inserted))
    })
  }

  /**
   * Claims the oldest claimable effect for `owner`, or null. One `UPDATE … RETURNING`. `lanes`
   * restricts the claim to effect kinds of those lane classes (a worker fibre group, SPEC §12.3);
   * without it any kind may be claimed.
   */
  claimNext(
    owner: string,
    now: string,
    options: { lanes?: readonly EffectLaneClass[] } = {}
  ): EffectRecord | null {
    const sql = options.lanes ? this.claimSqlFor(options.lanes) : this.claimSql
    if (sql === null) return null
    return this.db.transaction(() => {
      const row = this.db.statement(sql).get({ owner, now })
      return row ? this.recorded(toEffect(row), false) : null
    })
  }

  /** The claim statement limited to the kinds of `lanes`; null when no kind belongs to them. */
  private claimSqlFor(lanes: readonly EffectLaneClass[]): string | null {
    const key = [...new Set(lanes)].sort().join(',')
    const cached = this.claimSqlByLanes.get(key)
    if (cached !== undefined) return cached
    const kinds = (Object.keys(this.kindSpec) as EffectKind[]).filter((kind) =>
      lanes.includes(effectLaneClass(kind))
    )
    if (!kinds.length) return null
    const sql = this.claimSql.replace(
      '/*lanes*/',
      `AND c.kind IN (${kinds.map((kind) => `'${kind}'`).join(',')})`
    )
    this.claimSqlByLanes.set(key, sql)
    return sql
  }

  /** Extends the lease while `owner` still holds a running effect. */
  renewLease(effectId: string, owner: string, now: string): boolean {
    return this.db.transaction(() => {
      const effect = this.get(effectId)
      if (!effect || effect.status !== 'running' || effect.leaseOwner !== owner) return false
      const result = this.db
        .statement(
          `UPDATE effects SET lease_expires_at = ?, updated_at = ?
           WHERE effect_id = ? AND status = 'running' AND lease_owner = ?`
        )
        .run(addMs(now, effect.timeoutMs + EFFECT_LEASE_GRACE_MS), now, effectId, owner)
      return Number(result.changes) === 1
    })
  }

  succeed(effectId: string, owner: string, now: string): EffectSettlement {
    return this.db.transaction(() => {
      const current = this.get(effectId)
      if (!current || current.status !== 'running' || current.leaseOwner !== owner)
        return { settled: false, status: current?.status ?? null }
      return {
        settled: true,
        effect: this.write(current, {
          status: 'succeeded',
          leaseExpiresAt: null,
          updatedAt: now,
          completedAt: now
        })
      }
    })
  }

  /** `failed` when attempts are exhausted, else `pending` after the backoff. */
  fail(effectId: string, owner: string, now: string, error: string): EffectSettlement {
    return this.db.transaction(() => {
      const current = this.get(effectId)
      if (!current || current.status !== 'running' || current.leaseOwner !== owner)
        return { settled: false, status: current?.status ?? null }
      return { settled: true, effect: this.retryOrFail(current, now, error) }
    })
  }

  /**
   * A running effect its executor could not run yet (the thread is busy): `pending` again at
   * `availableAt`, lease released, the attempt not counted. Settlement CAS like `succeed`.
   */
  defer(effectId: string, owner: string, now: string, availableAt: string, reason: string): EffectSettlement {
    return this.db.transaction(() => {
      const current = this.get(effectId)
      if (!current || current.status !== 'running' || current.leaseOwner !== owner)
        return { settled: false, status: current?.status ?? null }
      return {
        settled: true,
        effect: this.write(current, {
          status: 'pending',
          attempts: Math.max(0, current.attempts - 1),
          availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: reason,
          updatedAt: now
        })
      }
    })
  }

  /**
   * Cancels a pending or running effect. Without `owner` there is no lease check (a Stop or
   * boot); with it the cancel is a settlement CAS like `succeed`.
   */
  cancel(effectId: string, now: string, reason: string, owner?: string): EffectSettlement {
    return this.db.transaction(() => {
      const current = this.get(effectId)
      if (!current || (current.status !== 'pending' && current.status !== 'running'))
        return { settled: false, status: current?.status ?? null }
      if (owner !== undefined && (current.status !== 'running' || current.leaseOwner !== owner))
        return { settled: false, status: current.status }
      return { settled: true, effect: this.cancelRecord(current, now, reason) }
    })
  }

  get(effectId: string): EffectRecord | null {
    const row = this.db.statement('SELECT * FROM effects WHERE effect_id = ?').get(effectId)
    return row ? toEffect(row) : null
  }

  /** Oldest first. */
  listForThread(threadId: string, options: { status?: EffectStatus } = {}): EffectRecord[] {
    const rows = options.status
      ? this.db
          .statement('SELECT * FROM effects WHERE thread_id = ? AND status = ? ORDER BY rowid')
          .all(threadId, options.status)
      : this.db.statement('SELECT * FROM effects WHERE thread_id = ? ORDER BY rowid').all(threadId)
    return rows.map(toEffect)
  }

  /**
   * One page of the thread's effects, oldest first: the newest `limit` (at most `EFFECT_PAGE_MAX`)
   * with a cursor below `before`. `cursor` is the oldest returned row's position; pass it as
   * `before` for the previous page. `hasMore` says whether older rows exist.
   */
  pageForThread(
    threadId: string,
    options: { limit?: number; before?: number } = {}
  ): { effects: EffectRecord[]; cursor: number | null; hasMore: boolean } {
    const limit = Math.max(1, Math.min(EFFECT_PAGE_MAX, Math.floor(options.limit ?? EFFECT_PAGE_MAX)))
    const rows = this.db
      .statement(
        `SELECT rowid AS cursor, * FROM effects WHERE thread_id = ? AND rowid < ?
         ORDER BY rowid DESC LIMIT ?`
      )
      .all(threadId, options.before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit).reverse()
    return {
      effects: page.map(toEffect),
      cursor: page.length ? Number(page[0].cursor) : null,
      hasMore
    }
  }

  /** Oldest first. */
  listForRun(runId: string): EffectRecord[] {
    return this.db
      .statement('SELECT * FROM effects WHERE run_id = ? ORDER BY rowid')
      .all(runId)
      .map(toEffect)
  }

  listRunning(): EffectRecord[] {
    return this.db
      .statement(`SELECT * FROM effects WHERE status = 'running' ORDER BY rowid`)
      .all()
      .map(toEffect)
  }

  listPending(limit = 100): EffectRecord[] {
    return this.db
      .statement(
        `SELECT * FROM effects WHERE status = 'pending' ORDER BY available_at, rowid LIMIT ?`
      )
      .all(limit)
      .map(toEffect)
  }

  /** Earliest `available_at` among pending effects (may already be due but lane-blocked). */
  nextAvailableAt(): string | null {
    const row = this.db
      .statement(`SELECT MIN(available_at) AS next FROM effects WHERE status = 'pending'`)
      .get()
    return typeof row?.next === 'string' ? row.next : null
  }

  /** SPEC §12.4 rule 1: expired running leases go back to pending (or failed) without an owner check. */
  reclaimExpired(now: string): string[] {
    return this.db.transaction(() => {
      const expired = this.db
        .statement(
          `SELECT * FROM effects WHERE status = 'running' AND lease_expires_at <= ? ORDER BY rowid`
        )
        .all(now)
        .map(toEffect)
      for (const effect of expired) this.retryOrFail(effect, now, 'lease expired')
      return expired.map((effect) => effect.effectId)
    })
  }

  /** Boot step 2 (SPEC §12.5): process-bound effects died with the previous daemon. */
  cancelProcessBound(reason: string, now: string = this.now()): EffectRecord[] {
    return this.db.transaction(() =>
      this.listByClass('process_bound', ['pending', 'running']).map((effect) =>
        this.cancelRecord(effect, now, reason)
      )
    )
  }

  /** Boot step 3 (SPEC §12.5): running replay-safe effects become pending again, available now. */
  requeueRunningReplaySafe(now: string): EffectRecord[] {
    return this.db.transaction(() =>
      this.listByClass('replay_safe', ['running']).map((effect) =>
        this.write(effect, {
          status: 'pending',
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now
        })
      )
    )
  }

  private get db() {
    return this.store.db
  }

  private listByClass(effectClass: EffectClass, statuses: EffectStatus[]): EffectRecord[] {
    return this.db
      .statement(
        `SELECT * FROM effects WHERE class = ? AND status IN (${statuses.map(() => '?').join(',')})
         ORDER BY rowid`
      )
      .all(effectClass, ...statuses)
      .map(toEffect)
  }

  private nextEffectId(threadId: string, runId: string | null, kind: EffectKind): string {
    const row = runId
      ? this.db
          .statement('SELECT COUNT(*) AS n FROM effects WHERE run_id = ? AND kind = ?')
          .get(runId, kind)!
      : this.db
          .statement(
            'SELECT COUNT(*) AS n FROM effects WHERE thread_id = ? AND run_id IS NULL AND kind = ?'
          )
          .get(threadId, kind)!
    return `effect:${runId ?? threadId}:${kind}:${Number(row.n) + 1}`
  }

  private retryOrFail(current: EffectRecord, now: string, error: string): EffectRecord {
    if (current.attempts >= current.maxAttempts)
      return this.write(current, {
        status: 'failed',
        lastError: error,
        leaseExpiresAt: null,
        updatedAt: now,
        completedAt: now
      })
    return this.write(current, {
      status: 'pending',
      lastError: error,
      availableAt: addMs(now, effectBackoffMs(current.attempts)),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now
    })
  }

  private cancelRecord(current: EffectRecord, now: string, reason: string): EffectRecord {
    return this.write(current, {
      status: 'cancelled',
      lastError: reason,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: now
    })
  }

  /** Writes a transition guarded on the status this caller read. */
  private write(
    current: EffectRecord,
    patch: Partial<
      Pick<
        EffectRecord,
        | 'status'
        | 'attempts'
        | 'availableAt'
        | 'leaseOwner'
        | 'leaseExpiresAt'
        | 'lastError'
        | 'updatedAt'
        | 'completedAt'
      >
    >
  ): EffectRecord {
    const next: EffectRecord = { ...current, ...patch }
    const result = this.db
      .statement(
        `UPDATE effects SET status = ?, attempts = ?, available_at = ?, lease_owner = ?,
           lease_expires_at = ?, last_error = ?, updated_at = ?, completed_at = ?
         WHERE effect_id = ? AND status = ? AND lease_owner IS ?`
      )
      .run(
        next.status,
        next.attempts,
        next.availableAt,
        next.leaseOwner,
        next.leaseExpiresAt,
        next.lastError,
        next.updatedAt,
        next.completedAt,
        current.effectId,
        current.status,
        current.leaseOwner
      )
    if (Number(result.changes) !== 1)
      fail('stale_write', `Effect ${current.effectId} changed while it was being settled.`)
    return this.recorded(next)
  }

  /** Appends `effect.status`; `notify` wakes subscribers after commit (a lane may have freed). */
  private recorded(effect: EffectRecord, notify = true): EffectRecord {
    this.store.appendEvent({
      threadId: effect.threadId,
      runId: effect.runId,
      type: 'effect.status',
      payload: effect
    })
    if (notify)
      this.db.afterCommit(() => {
        for (const listener of this.listeners) listener()
      })
    return effect
  }
}

export function toEffect
(row: Row): EffectRecord {
  return {
    effectId: String(row.effect_id),
    threadId: String(row.thread_id),
    runId: str(row.run_id),
    kind: row.kind as EffectKind,
    class: row.class as EffectClass,
    status: row.status as EffectStatus,
    payload: JSON.parse(String(row.payload)) as unknown,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    timeoutMs: Number(row.timeout_ms),
    availableAt: String(row.available_at),
    leaseOwner: str(row.lease_owner),
    leaseExpiresAt: str(row.lease_expires_at),
    lastError: str(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: str(row.completed_at)
  }
}
