/**
 * Idempotency deduplication store for remote MMS operations.
 * Keyed by pairingId + ':' + idempotencyKey.
 * Stores hash of canonical method/params and cached response.
 * Retains records for 24 hours with automatic expiration and pruning.
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from '../../../shared/agents/hashes'
import { IDEMPOTENCY_RETENTION_MS } from '../constants'

export interface IdempotencyRecord {
  pairingId: string
  idempotencyKey: string
  method: string
  payloadHash: string
  response: unknown
  createdAt: number
  expiresAt: number
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency conflict: key re-used with different method or parameters') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

export class IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>()
  private retentionMs: number

  constructor(retentionMs = IDEMPOTENCY_RETENTION_MS) {
    this.retentionMs = retentionMs
  }

  /**
   * Compute deterministic SHA-256 hash of method and parameters.
   */
  static hashPayload(method: string, params: unknown): string {
    // Recursive key sort: an array replacer would silently drop every nested key not present at the top level.
    const canonicalParams = canonicalJson(params) ?? 'null'
    return createHash('sha256').update(`${method}:${canonicalParams}`).digest('hex')
  }

  private makeKey(pairingId: string, idempotencyKey: string): string {
    return `${pairingId}:${idempotencyKey}`
  }

  /**
   * Check if a record exists for this pairingId + idempotencyKey.
   * If exists and payloadHash matches, returns the cached response.
   * If exists and payloadHash does NOT match, throws IdempotencyConflictError.
   * If does not exist, returns null.
   */
  get(pairingId: string, idempotencyKey: string, payloadHash: string): unknown | null {
    this.gc()
    const key = this.makeKey(pairingId, idempotencyKey)
    const record = this.records.get(key)
    if (!record) return null

    if (record.payloadHash !== payloadHash) {
      throw new IdempotencyConflictError()
    }

    return record.response
  }

  /**
   * Save a completed response for this idempotency key.
   */
  save(
    pairingId: string,
    idempotencyKey: string,
    method: string,
    payloadHash: string,
    response: unknown
  ): void {
    const now = Date.now()
    const key = this.makeKey(pairingId, idempotencyKey)
    this.records.set(key, {
      pairingId,
      idempotencyKey,
      method,
      payloadHash,
      response,
      createdAt: now,
      expiresAt: now + this.retentionMs
    })
  }

  /** Clean up expired records. */
  private gc(): void {
    const now = Date.now()
    for (const [key, record] of this.records.entries()) {
      if (now >= record.expiresAt) {
        this.records.delete(key)
      }
    }
  }

  clear(): void {
    this.records.clear()
  }

  size(): number {
    this.gc()
    return this.records.size
  }
}
