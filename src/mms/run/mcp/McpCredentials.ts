import { createHash, randomBytes } from 'node:crypto'
import { fail } from '../db/RunStoreError'
import type { RunStore } from '../RunStore'
import type { ModeCeiling } from '../types'

/** A credential expires after this long without a request (SPEC §15.1). */
export const CREDENTIAL_IDLE_TTL_MS = 24 * 60 * 60 * 1000

/** One run's Mousse MCP credential, without its token (only the hash is stored). */
export interface CredentialRecord {
  tokenHash: string
  threadId: string
  runId: string
  provider: string
  modeCeiling: ModeCeiling
  createdAt: string
  revokedAt: string | null
  lastSeenAt: string
}

/** What `runs.credentials` reports: never the hash. */
export type CredentialSummary = Omit<CredentialRecord, 'tokenHash' | 'threadId'>

type Row = Record<string, unknown>

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Durable bearer credentials for the Mousse MCP server (docs/run-engine/SPEC.md §15.1). One live
 * credential per (thread, provider): the `turn.start` executor reuses it on every turn
 * (`mintOrReuse`), so a provider runtime keeps one stable MCP configuration and its session can be
 * resumed. `run_id` and `mode_ceiling` follow the thread's latest turn. A credential is revoked
 * when its thread is deleted or switches provider, and expires after 24 h without use.
 *
 * Only the SHA-256 is stored. The token itself is kept in this process's memory so it can be
 * handed out again; after a daemon restart the stored row cannot be reused (its token is gone),
 * so the next turn revokes it and mints a fresh one. Unlike T3's in-memory registry the rows
 * survive a restart and stay revocable and auditable.
 */
export class McpCredentials {
  /** Tokens minted by this process, by hash; the database never holds them. */
  private readonly tokens = new Map<string, string>()

  constructor(private readonly store: RunStore) {}

  /**
   * The thread's live credential for `provider`, re-pointed at `runId` with the turn's
   * `modeCeiling` (and `last_seen_at` touched), or a fresh one. Live credentials of the thread for
   * another provider are revoked (provider switch), as is a stored one this process cannot hand
   * out again.
   */
  mintOrReuse(input: { threadId: string; runId: string; provider: string; modeCeiling: ModeCeiling }): {
    token: string
    tokenHash: string
    reused: boolean
  } {
    return this.db.transaction(() => {
      const now = this.db.clock()
      const live = this.db
        .statement('SELECT * FROM credentials WHERE thread_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid')
        .all(input.threadId)
        .map(toRecord)
      let reusable: { record: CredentialRecord; token: string } | null = null
      const stale: string[] = []
      for (const record of live) {
        const token = this.tokens.get(record.tokenHash)
        const fresh = now - Date.parse(record.lastSeenAt) <= CREDENTIAL_IDLE_TTL_MS
        if (!reusable && record.provider === input.provider && token && fresh) reusable = { record, token }
        else stale.push(record.tokenHash)
      }
      for (const tokenHash of stale) this.revokeHash(tokenHash)
      if (!reusable) return { ...this.mint(input), reused: false }
      if (input.modeCeiling !== 'plan' && input.modeCeiling !== 'default')
        fail('bad_request', 'modeCeiling must be plan or default.')
      this.db
        .statement('UPDATE credentials SET run_id = ?, mode_ceiling = ?, last_seen_at = ? WHERE token_hash = ?')
        .run(input.runId, input.modeCeiling, new Date(now).toISOString(), reusable.record.tokenHash)
      return { token: reusable.token, tokenHash: reusable.record.tokenHash, reused: true }
    })
  }

  mint(input: { threadId: string; runId: string; provider: string; modeCeiling: ModeCeiling }): {
    token: string
    tokenHash: string
  } {
    if (input.modeCeiling !== 'plan' && input.modeCeiling !== 'default')
      fail('bad_request', 'modeCeiling must be plan or default.')
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    const now = this.now()
    this.db
      .statement(
        `INSERT INTO credentials(token_hash, thread_id, run_id, provider, mode_ceiling, created_at,
           revoked_at, last_seen_at)
         VALUES(?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(tokenHash, input.threadId, input.runId, input.provider, input.modeCeiling, now, now)
    this.tokens.set(tokenHash, token)
    return { token, tokenHash }
  }

  /**
   * The live credential for `token`, or null when it is unknown, revoked or idle for 24 h. A hit
   * touches `last_seen_at`.
   */
  resolve(token: string): CredentialRecord | null {
    if (!token) return null
    const row = this.db.statement('SELECT * FROM credentials WHERE token_hash = ?').get(hashToken(token))
    if (!row) return null
    const record = toRecord(row)
    if (record.revokedAt) return null
    const now = this.db.clock()
    if (now - Date.parse(record.lastSeenAt) > CREDENTIAL_IDLE_TTL_MS) return null
    const lastSeenAt = new Date(now).toISOString()
    this.db.statement('UPDATE credentials SET last_seen_at = ? WHERE token_hash = ?').run(lastSeenAt, record.tokenHash)
    return { ...record, lastSeenAt }
  }

  /** Revokes every live credential of `runId`; returns how many. */
  revokeForRun(runId: string): number {
    return this.revoke('run_id', runId)
  }

  /** Revokes every live credential of `threadId`; returns how many. */
  revokeForThread(threadId: string): number {
    return this.revoke('thread_id', threadId)
  }

  /**
   * Deletes credentials that can no longer authenticate and are older than the idle window:
   * revoked 24 h ago, or unrevoked and idle for 24 h. Returns how many.
   */
  pruneExpired(): number {
    const cutoff = new Date(this.db.clock() - CREDENTIAL_IDLE_TTL_MS).toISOString()
    return this.db.transaction(() => {
      const hashes = this.db
        .statement('SELECT token_hash FROM credentials WHERE COALESCE(revoked_at, last_seen_at) < ?')
        .all(cutoff)
        .map((row) => String(row.token_hash))
      for (const tokenHash of hashes) {
        this.db.statement('DELETE FROM credentials WHERE token_hash = ?').run(tokenHash)
        this.tokens.delete(tokenHash)
      }
      return hashes.length
    })
  }

  /** Credentials minted for `threadId`, oldest first, without their hashes. */
  listForThread(threadId: string): CredentialSummary[] {
    return this.db
      .statement('SELECT * FROM credentials WHERE thread_id = ? ORDER BY created_at, rowid')
      .all(threadId)
      .map((row) => {
        const { tokenHash: _hash, threadId: _thread, ...summary } = toRecord(row)
        return summary
      })
  }

  private revoke(column: 'run_id' | 'thread_id', value: string): number {
    return this.db.transaction(() => {
      const hashes = this.db
        .statement(`SELECT token_hash FROM credentials WHERE ${column} = ? AND revoked_at IS NULL`)
        .all(value)
        .map((row) => String(row.token_hash))
      for (const tokenHash of hashes) this.revokeHash(tokenHash)
      return hashes.length
    })
  }

  private revokeHash(tokenHash: string): void {
    this.db.statement('UPDATE credentials SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(this.now(), tokenHash)
    this.tokens.delete(tokenHash)
  }

  private get db() {
    return this.store.db
  }

  private now(): string {
    return new Date(this.db.clock()).toISOString()
  }
}

function toRecord(row: Row): CredentialRecord {
  return {
    tokenHash: String(row.token_hash),
    threadId: String(row.thread_id),
    runId: String(row.run_id),
    provider: String(row.provider),
    modeCeiling: row.mode_ceiling === 'plan' ? 'plan' : 'default',
    createdAt: String(row.created_at),
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    lastSeenAt: String(row.last_seen_at)
  }
}
