import { randomUUID } from 'node:crypto'
import { fail } from '../db/RunStoreError'
import { stableStringify } from '../json'
import type { RunStore } from '../RunStore'
import type { TransferRecord, TransferStatus, TransferType } from '../types'

type Row = Record<string, unknown>

/** Allowed transfer status moves (SPEC §16.2). */
const TRANSITIONS: Record<TransferStatus, ReadonlySet<TransferStatus>> = {
  pending: new Set<TransferStatus>(['consumed', 'superseded', 'failed']),
  consumed: new Set<TransferStatus>(),
  superseded: new Set<TransferStatus>(),
  failed: new Set<TransferStatus>()
}

/**
 * Lazy context transfers between threads (docs/run-engine/SPEC.md §16.2): a `fork` row waits for
 * the fork's first message, a `merge_back` row for the parent's next turn. Every write joins the
 * caller's transaction or opens one and appends a `transfer.status` event carrying the full row to
 * the target thread (and to the source thread when it differs).
 */
export class ContextTransfers {
  constructor(private readonly store: RunStore) {}

  create(input: {
    type: TransferType
    sourceThreadId: string
    targetThreadId: string
    sourceRunOrdinal: number
    payload: Record<string, unknown>
  }): TransferRecord {
    return this.db.transaction(() => {
      const record: TransferRecord = {
        transferId: `transfer:${randomUUID()}`,
        ...input,
        status: 'pending',
        createdAt: this.now(),
        consumedAt: null
      }
      this.db
        .statement(
          `INSERT INTO context_transfers(transfer_id, type, source_thread_id, target_thread_id,
             source_run_ordinal, status, payload, created_at, consumed_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.transferId,
          record.type,
          record.sourceThreadId,
          record.targetThreadId,
          record.sourceRunOrdinal,
          record.status,
          stableStringify(record.payload),
          record.createdAt,
          null
        )
      this.recorded(record)
      return record
    })
  }

  get(transferId: string): TransferRecord | null {
    const row = this.db.statement('SELECT * FROM context_transfers WHERE transfer_id = ?').get(transferId)
    return row ? toTransfer(row) : null
  }

  /** Transfers into or out of `threadId`, oldest first. */
  listForThread(threadId: string): TransferRecord[] {
    return this.db
      .statement(
        `SELECT * FROM context_transfers WHERE target_thread_id = ? OR source_thread_id = ?
         ORDER BY created_at, rowid`
      )
      .all(threadId, threadId)
      .map(toTransfer)
  }

  /** Pending transfers of `type` waiting on `targetThreadId`, oldest first. */
  listPending(targetThreadId: string, type?: TransferType): TransferRecord[] {
    return this.db
      .statement(
        `SELECT * FROM context_transfers WHERE target_thread_id = ? AND status = 'pending'
         ORDER BY created_at, rowid`
      )
      .all(targetThreadId)
      .map(toTransfer)
      .filter((record) => type === undefined || record.type === type)
  }

  /** Transfers of `type` from `sourceThreadId` into `targetThreadId`, oldest first. */
  listBetween(type: TransferType, sourceThreadId: string, targetThreadId: string): TransferRecord[] {
    return this.db
      .statement(
        `SELECT * FROM context_transfers WHERE type = ? AND source_thread_id = ? AND target_thread_id = ?
         ORDER BY created_at, rowid`
      )
      .all(type, sourceThreadId, targetThreadId)
      .map(toTransfer)
  }

  /** CAS status move; `payloadPatch` is merged into the stored payload. */
  setStatus(input: {
    transferId: string
    from: TransferStatus
    to: TransferStatus
    payloadPatch?: Record<string, unknown>
  }): TransferRecord {
    return this.db.transaction(() => {
      const current = this.get(input.transferId)
      if (!current) fail('bad_request', `Unknown transfer ${input.transferId}.`)
      if (current.status !== input.from)
        fail('stale_write', `Transfer ${input.transferId} is ${current.status}, not ${input.from}.`)
      if (!TRANSITIONS[current.status].has(input.to))
        fail('bad_request', `Transfer ${input.transferId} cannot move from ${current.status} to ${input.to}.`)
      const next: TransferRecord = {
        ...current,
        status: input.to,
        payload: input.payloadPatch ? { ...current.payload, ...input.payloadPatch } : current.payload,
        consumedAt: input.to === 'pending' ? null : this.now()
      }
      this.db
        .statement('UPDATE context_transfers SET status = ?, payload = ?, consumed_at = ? WHERE transfer_id = ? AND status = ?')
        .run(next.status, stableStringify(next.payload), next.consumedAt, next.transferId, input.from)
      this.recorded(next)
      return next
    })
  }

  /** Merges `payloadPatch` into a pending transfer's payload (its status stays). */
  patchPayload(transferId: string, payloadPatch: Record<string, unknown>): TransferRecord {
    return this.db.transaction(() => {
      const current = this.get(transferId)
      if (!current) fail('bad_request', `Unknown transfer ${transferId}.`)
      const next: TransferRecord = { ...current, payload: { ...current.payload, ...payloadPatch } }
      this.db
        .statement('UPDATE context_transfers SET payload = ? WHERE transfer_id = ?')
        .run(stableStringify(next.payload), transferId)
      this.recorded(next)
      return next
    })
  }

  private recorded(record: TransferRecord): void {
    this.store.appendEvent({ threadId: record.targetThreadId, type: 'transfer.status', payload: record })
    if (record.sourceThreadId !== record.targetThreadId)
      this.store.appendEvent({ threadId: record.sourceThreadId, type: 'transfer.status', payload: record })
  }

  private get db() {
    return this.store.db
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}

function toTransfer(row: Row): TransferRecord {
  return {
    transferId: String(row.transfer_id),
    type: row.type as TransferType,
    sourceThreadId: String(row.source_thread_id),
    targetThreadId: String(row.target_thread_id),
    sourceRunOrdinal: Number(row.source_run_ordinal),
    status: row.status as TransferStatus,
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    createdAt: String(row.created_at),
    consumedAt: typeof row.consumed_at === 'string' ? row.consumed_at : null
  }
}
