import { createHash, randomBytes } from 'node:crypto'
import { isAgentAccessLevel, type AgentAccessLevel } from '../../../shared/settings'
import { str, type Row } from '../db/rows'
import { fail } from '../db/RunStoreError'
import type { RunStore } from '../RunStore'
import type { ModeCeiling } from '../types'
import type { McpTurnBinding } from './appTools/registry'
import type { RelayGrant } from './relay/types'

export type { RelayGrant } from './relay/types'

/** A credential expires after this long without a request (SPEC §15.1). */
export const CREDENTIAL_IDLE_TTL_MS = 24 * 60 * 60 * 1000

const TURN_BINDINGS: ReadonlySet<string> = new Set<McpTurnBinding>(['per_call', 'drained_turn', 'rotate'])

/** One Mousse MCP credential, without its token (only the hash is stored). */
export interface CredentialRecord {
  tokenHash: string
  threadId: string
  /** The run the credential acts for: re-bound only by `bearerForTurn`, never by a call. */
  runId: string
  provider: string
  modeCeiling: ModeCeiling
  /**
   * The agent access level the run's turn was granted (SPEC §15.1), re-pointed with the run like the
   * ceiling. The call-time check narrows it by the profile's setting as it is then.
   */
  accessLevel: AgentAccessLevel
  /**
   * The runtime epoch of (thread, instance) it was minted in; a newer epoch closes it. Kept in this
   * process's memory with the token, like the token never stored: a row from an earlier process is
   * revoked at boot anyway.
   */
  epoch: number
  /** How the runtime's calls are tied to a turn (in memory, like `epoch`). */
  binding: McpTurnBinding
  /** The MCP relay the turn attached, and who asks before a relayed tool runs (in memory, like `epoch`). */
  relay?: RelayGrant
  createdAt: string
  revokedAt: string | null
  lastSeenAt: string
}

/** What `runs.credentials` reports: never the hash. */
export type CredentialSummary = Omit<CredentialRecord, 'tokenHash' | 'threadId'>

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** One turn's bearer request (`bearerForTurn`). */
export interface BearerTurn {
  threadId: string
  /** The provider instance the turn runs on. */
  instanceId: string
  runId: string
  modeCeiling: ModeCeiling
  /** The level the turn was granted; absent, or anything but a known level, is `lineage`. */
  accessLevel?: AgentAccessLevel
  binding: McpTurnBinding
  /** The turn attaches the MCP relay. Not part of `generation`: turning it on or off keeps the bearer. */
  relay?: RelayGrant
  /**
   * The runtime the turn runs in: driver, home, account generation and config revision (and the
   * engine, once an instance has two). A change is a new runtime, so a new epoch.
   */
  generation: string
}

/** How a turn ended, for the drained-turn check (`settleTurn`). */
export interface TurnSettlement {
  status: 'completed' | 'failed' | 'aborted'
  /**
   * What the runtime announced of its Mousse calls in the turn: `mousseCalls`, the calls to Mousse's
   * server it announced (Codex names the server), which must equal what Mousse received; `toolCalls`,
   * every tool call it announced (ACP, whose updates do not name the server), which Mousse's received
   * calls cannot exceed; `toolsSettled`, each announced call reached a terminal update from the
   * runtime itself (a Codex completion it sent, an ACP `completed` update).
   */
  drain?: { mousseCalls?: number; toolCalls?: number; toolsSettled?: boolean }
}

/** What this process keeps of a credential it minted, beside its token. */
interface CredentialMeta {
  epoch: number
  binding: McpTurnBinding
  relay?: RelayGrant
}

interface EpochState {
  epoch: number
  generation?: string
}

interface CallCounts {
  runId: string
  received: number
  running: number
}

/**
 * Durable bearer credentials of the Mousse MCP server and their caller authority (SPEC §15.1, PR 2
 * §2 `McpAuthority`). A credential belongs to one runtime epoch of (thread, instance) and acts for
 * one run. `bearerForTurn` re-binds it to the next run only when the driver's turn binding allows:
 * `per_call` runtimes tag every call with the turn (the registry checks it), so their bearer and
 * warm runtime are kept; a `drained_turn` runtime keeps it only after a turn proven drained; a
 * `rotate` runtime gets a new one every turn. Anything else bumps the epoch, which revokes the
 * epoch's credentials at once.
 *
 * Only the SHA-256 is stored. The token itself, and its epoch and binding, are kept in this
 * process's memory so it can be handed out again; after a daemon restart the stored row cannot be
 * reused (its token is gone), so boot (`RunEngine.reconcileOnBoot`) revokes every live row and the
 * next turn mints a fresh one. Unlike an in-memory registry, the rows survive a restart and stay
 * auditable.
 */
export class McpCredentials {
  /** Tokens minted by this process, by hash; the database never holds them. */
  private readonly tokens = new Map<string, string>()
  /** The epoch, turn binding and relay grant of each credential this process minted, by hash. */
  private readonly meta = new Map<string, CredentialMeta>()
  /** The current runtime epoch per (thread, instance). */
  private readonly epochs = new Map<string, EpochState>()
  /** Calls received and running under each credential since it was bound to its run. */
  private readonly calls = new Map<string, CallCounts>()

  constructor(private readonly store: RunStore) {}

  /**
   * The turn's bearer: the epoch's live credential re-bound to `runId` and the turn's ceiling when the
   * binding allows reuse, else a fresh one in a new epoch when the runtime changed or the binding
   * rotates. Live credentials of the thread for another instance are revoked (instance switch), as is
   * one this process cannot hand out again.
   */
  bearerForTurn(input: BearerTurn): { token: string; tokenHash: string; reused: boolean; epoch: number } {
    if (input.modeCeiling !== 'plan' && input.modeCeiling !== 'default') fail('bad_request', 'modeCeiling must be plan or default.')
    if (!TURN_BINDINGS.has(input.binding)) fail('bad_request', 'binding must be per_call, drained_turn or rotate.')
    return this.db.transaction(() => {
      const key = epochKey(input.threadId, input.instanceId)
      const state = this.epochState(input.threadId, input.instanceId)
      if (state.generation !== undefined && state.generation !== input.generation) this.bump(input.threadId, input.instanceId)
      else if (input.binding === 'rotate') this.bump(input.threadId, input.instanceId)
      state.generation = input.generation
      const epoch = this.epochs.get(key)!.epoch
      const now = this.db.clock()
      const live = this.db
        .statement('SELECT * FROM credentials WHERE thread_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid')
        .all(input.threadId)
        .map((row) => this.toRecord(row))
      let reusable: { record: CredentialRecord; token: string } | null = null
      const stale: string[] = []
      for (const record of live) {
        const token = this.tokens.get(record.tokenHash)
        const fresh = now - Date.parse(record.lastSeenAt) <= CREDENTIAL_IDLE_TTL_MS
        if (!reusable && record.provider === input.instanceId && record.epoch === epoch && record.binding === input.binding && token && fresh)
          reusable = { record, token }
        else stale.push(record.tokenHash)
      }
      for (const tokenHash of stale) this.revokeHash(tokenHash)
      if (!reusable) return { ...this.mint({ ...input, epoch }), reused: false, epoch }
      this.db
        .statement('UPDATE credentials SET run_id = ?, mode_ceiling = ?, access_level = ?, last_seen_at = ? WHERE token_hash = ?')
        .run(input.runId, input.modeCeiling, grantedLevel(input.accessLevel), new Date(now).toISOString(), reusable.record.tokenHash)
      this.calls.set(reusable.record.tokenHash, { runId: input.runId, received: 0, running: 0 })
      const meta = this.meta.get(reusable.record.tokenHash)
      if (meta) this.meta.set(reusable.record.tokenHash, withRelay({ epoch: meta.epoch, binding: meta.binding }, input.relay))
      return { token: reusable.token, tokenHash: reusable.record.tokenHash, reused: true, epoch }
    })
  }

  /**
   * A fresh credential for a run in the given epoch (default: the current one of thread and
   * instance). Tests and `bearerForTurn` use it; a turn takes its bearer from `bearerForTurn`.
   */
  mint(input: { threadId: string; runId: string; provider?: string; instanceId?: string; modeCeiling: ModeCeiling; accessLevel?: AgentAccessLevel; binding?: McpTurnBinding; epoch?: number; relay?: RelayGrant }): {
    token: string
    tokenHash: string
  } {
    if (input.modeCeiling !== 'plan' && input.modeCeiling !== 'default')
      fail('bad_request', 'modeCeiling must be plan or default.')
    const provider = input.instanceId ?? input.provider
    if (!provider) fail('bad_request', 'A credential needs the provider instance it runs on.')
    const binding = input.binding ?? 'rotate'
    if (!TURN_BINDINGS.has(binding)) fail('bad_request', 'binding must be per_call, drained_turn or rotate.')
    const epoch = input.epoch ?? this.epochState(input.threadId, provider).epoch
    const token = randomBytes(32).toString('base64url')
    const tokenHash = hashToken(token)
    const now = this.now()
    this.db
      .statement(
        `INSERT INTO credentials(token_hash, thread_id, run_id, provider, mode_ceiling, access_level,
           created_at, revoked_at, last_seen_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(tokenHash, input.threadId, input.runId, provider, input.modeCeiling, grantedLevel(input.accessLevel), now, now)
    this.tokens.set(tokenHash, token)
    this.meta.set(tokenHash, withRelay({ epoch, binding }, input.relay))
    this.calls.set(tokenHash, { runId: input.runId, received: 0, running: 0 })
    return { token, tokenHash }
  }

  /**
   * The live credential for `token`, or null when it is unknown, revoked, idle for 24 h or of an
   * older epoch. A hit touches `last_seen_at`.
   */
  resolve(token: string): CredentialRecord | null {
    if (!token) return null
    const row = this.db.statement('SELECT * FROM credentials WHERE token_hash = ?').get(hashToken(token))
    if (!row) return null
    const record = this.toRecord(row)
    if (!this.isCurrent(record)) return null
    const now = this.db.clock()
    if (now - Date.parse(record.lastSeenAt) > CREDENTIAL_IDLE_TTL_MS) return null
    const lastSeenAt = new Date(now).toISOString()
    this.db.statement('UPDATE credentials SET last_seen_at = ? WHERE token_hash = ?').run(lastSeenAt, record.tokenHash)
    return { ...record, lastSeenAt }
  }

  /** The credential `tokenHash` names as it stands now, when it is live and of the current epoch. */
  current(tokenHash: string): CredentialRecord | null {
    const row = this.db.statement('SELECT * FROM credentials WHERE token_hash = ?').get(tokenHash)
    if (!row) return null
    const record = this.toRecord(row)
    return this.isCurrent(record) ? record : null
  }

  /** Still live and of the current epoch, read now (a call re-checks after any wait). */
  isCurrent(record: Pick<CredentialRecord, 'tokenHash' | 'threadId' | 'provider' | 'epoch'>): boolean {
    const row = this.db.statement('SELECT revoked_at FROM credentials WHERE token_hash = ?').get(record.tokenHash)
    if (!row || row.revoked_at !== null) return false
    return record.epoch === this.epochState(record.threadId, record.provider).epoch
  }

  /** The current epoch of (thread, instance). */
  currentEpoch(threadId: string, instanceId: string): number {
    return this.epochState(threadId, instanceId).epoch
  }

  /**
   * A new runtime epoch for (thread, instance): its process or session was replaced, it crashed or was
   * terminated, or its turn could not be proven drained. Revokes the epoch's credentials at once.
   */
  bumpEpoch(threadId: string, instanceId: string): number {
    return this.db.transaction(() => this.bump(threadId, instanceId))
  }

  /** A tools/call request arrived under the credential (counted for the drained-turn check). */
  callReceived(tokenHash: string, runId: string): void {
    const counts = this.countsFor(tokenHash, runId)
    counts.received += 1
  }

  /** A call admitted under the credential started (`running`) or ended. */
  callRunning(tokenHash: string, runId: string, delta: 1 | -1): void {
    const counts = this.calls.get(tokenHash)
    if (!counts || counts.runId !== runId) return
    counts.running = Math.max(0, counts.running + delta)
  }

  /**
   * The turn of the credential's run ended (PR 2 §2). A `drained_turn` credential is kept for the
   * next turn only when the turn settled `completed`, no call admitted under it is still running,
   * and the runtime's own account of its calls matches what Mousse received; otherwise, and for any
   * failed turn, the epoch is bumped, which revokes it now. Returns whether it was kept.
   */
  settleTurn(tokenHash: string, runId: string, settlement: TurnSettlement): 'kept' | 'rotated' {
    const row = this.db.statement('SELECT * FROM credentials WHERE token_hash = ?').get(tokenHash)
    if (!row) return 'rotated'
    const record = this.toRecord(row)
    if (record.revokedAt || record.runId !== runId || !this.isCurrent(record)) return 'rotated'
    const counts = this.calls.get(tokenHash)
    const running = counts && counts.runId === runId ? counts.running : 0
    const received = counts && counts.runId === runId ? counts.received : 0
    let keep: boolean
    if (record.binding === 'per_call') keep = settlement.status !== 'failed'
    else if (record.binding === 'drained_turn') {
      const drain = settlement.drain
      const proven = drain !== undefined && (drain.mousseCalls !== undefined || drain.toolCalls !== undefined) && drain.toolsSettled !== undefined
      keep = settlement.status === 'completed' && running === 0 && proven &&
        (drain!.mousseCalls === undefined || drain!.mousseCalls === received) &&
        (drain!.toolCalls === undefined || received <= drain!.toolCalls) &&
        drain!.toolsSettled === true
    } else keep = false
    if (keep) return 'kept'
    this.bumpEpoch(record.threadId, record.provider)
    return 'rotated'
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
        this.meta.delete(tokenHash)
        this.calls.delete(tokenHash)
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
        const { tokenHash: _hash, threadId: _thread, ...summary } = this.toRecord(row)
        return summary
      })
  }

  private epochState(threadId: string, instanceId: string): EpochState {
    const key = epochKey(threadId, instanceId)
    let state = this.epochs.get(key)
    if (!state) {
      state = { epoch: 0 }
      this.epochs.set(key, state)
    }
    return state
  }

  private bump(threadId: string, instanceId: string): number {
    const state = this.epochState(threadId, instanceId)
    state.epoch += 1
    const hashes = this.db
      .statement('SELECT token_hash FROM credentials WHERE thread_id = ? AND provider = ? AND revoked_at IS NULL')
      .all(threadId, instanceId)
      .map((row) => String(row.token_hash))
    for (const tokenHash of hashes) this.revokeHash(tokenHash)
    return state.epoch
  }

  private countsFor(tokenHash: string, runId: string): CallCounts {
    let counts = this.calls.get(tokenHash)
    if (!counts || counts.runId !== runId) {
      counts = { runId, received: 0, running: 0 }
      this.calls.set(tokenHash, counts)
    }
    return counts
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

  private toRecord(row: Row): CredentialRecord {
    return rowRecord(row, this.meta.get(String(row.token_hash)))
  }

  private get db() {
    return this.store.db
  }

  private now(): string {
    return new Date(this.db.clock()).toISOString()
  }
}

/** An absent or unknown level is the most restrictive one, `lineage`. */
function grantedLevel(level: unknown): AgentAccessLevel {
  return isAgentAccessLevel(level) ? level : 'lineage'
}

function epochKey(threadId: string, instanceId: string): string {
  return `${threadId}\u0000${instanceId}`
}

function withRelay(meta: CredentialMeta, relay: RelayGrant | undefined): CredentialMeta {
  return relay ? { ...meta, relay: { approvals: relay.approvals } } : meta
}

function rowRecord(row: Row, meta: CredentialMeta | undefined): CredentialRecord {
  return {
    tokenHash: String(row.token_hash),
    threadId: String(row.thread_id),
    runId: String(row.run_id),
    provider: String(row.provider),
    modeCeiling: row.mode_ceiling === 'plan' ? 'plan' : 'default',
    accessLevel: grantedLevel(row.access_level),
    // A row this process did not mint (one from before a restart, revoked at boot) is of epoch 0 and rotates.
    epoch: meta?.epoch ?? 0,
    binding: meta?.binding ?? 'rotate',
    ...(meta?.relay ? { relay: meta.relay } : {}),
    createdAt: String(row.created_at),
    revokedAt: str(row.revoked_at),
    lastSeenAt: String(row.last_seen_at)
  }
}
