import { randomUUID } from 'node:crypto'
import { int, json, str, type Row } from './db/rows'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'

/**
 * The messages one chain may send before a person decides whether it goes on (issue #1442). Every participant counts
 * against it, at any depth and in any order. A person's message in the chain, or Continue on its hold, renews it.
 */
export const CHAIN_BUDGET = 12

/** What a held message is: a `thread_send` of work, or a note that asks for attention. */
export type ChainHoldKind = 'work' | 'note'

export type ChainHoldStatus = 'held' | 'continued' | 'stopped' | 'failed'

export interface AgentChainRecord {
  chainId: string
  /** Where the chain started: the thread of the run no agent message started. */
  rootThreadId: string
  rootRunId: string
  /** Messages counted since the budget began. */
  used: number
  /** Messages counted since the chain began. */
  total: number
}

export interface ChainHoldRecord {
  holdId: string
  chainId: string
  requestKey: string
  kind: ChainHoldKind
  senderThreadId: string
  senderRunId: string | null
  targetThreadId: string
  /** What sending it again needs, as its sender wrote it. */
  payload: unknown
  status: ChainHoldStatus
}

export interface ChainMessage {
  chainId: string
  senderThreadId: string
  senderRunId: string | null
  targetThreadId: string
  kind: ChainHoldKind
  /** The sender's request: a retry finds the hold its first try made. */
  requestKey: string
  payload: unknown
  /** False for a message that cannot wait (a steer, a queue change on another thread): refused at the budget. */
  holdable?: boolean
}

export type ChainAdmission =
  | { status: 'go'; chainId: string; seq: number }
  | { status: 'held'; chainId: string; hold: ChainHoldRecord; replayed: boolean }

/** The chain a run's messages belong to: the one its run carries, or for a run nothing carried on, its own. */
export function chainIdOf(store: RunStore, runId: string): string {
  return store.getRun(runId)?.outcome?.agentChain ?? `chain:${runId}`
}

/**
 * The chain record (issues #1442, #1443): one row per chain counting its agent messages, and the messages held at its
 * budget. While a chain holds anything, its later messages wait behind it, so one decision covers them all.
 */
export class AgentChains {
  constructor(private readonly store: RunStore) {}

  get(chainId: string): AgentChainRecord | null {
    const row = this.db.statement('SELECT * FROM agent_chains WHERE chain_id = ?').get(chainId)
    return row ? toChain(row) : null
  }

  getHold(holdId: string): ChainHoldRecord | null {
    const row = this.db.statement('SELECT * FROM agent_chain_holds WHERE hold_id = ?').get(holdId)
    return row ? toHold(row) : null
  }

  /** The chains that started in `rootThreadId` and hold something, the one held longest first. */
  heldChains(rootThreadId: string): AgentChainRecord[] {
    return this.db
      .statement(`SELECT c.* FROM agent_chains c JOIN agent_chain_holds h ON h.chain_id = c.chain_id
        WHERE c.root_thread_id = ? AND h.status = 'held' GROUP BY c.chain_id ORDER BY MIN(h.created_at), MIN(h.rowid)`)
      .all(rootThreadId)
      .map(toChain)
  }

  /** The threads a chain that holds something started in. */
  heldRoots(): string[] {
    return this.db
      .statement(`SELECT DISTINCT c.root_thread_id AS root FROM agent_chains c JOIN agent_chain_holds h ON h.chain_id = c.chain_id WHERE h.status = 'held'`)
      .all()
      .map((row) => String(row.root))
  }

  /** A held `thread_send` of work with this text from `senderThreadId` to `targetThreadId`, under another request: a repeat coalesces into it. */
  heldCopy(senderThreadId: string, targetThreadId: string, content: string, requestKey: string): ChainHoldRecord | undefined {
    return this.db
      .statement("SELECT * FROM agent_chain_holds WHERE status = 'held' AND kind = 'work' AND sender_thread_id = ? AND target_thread_id = ? AND request_key <> ? ORDER BY created_at, rowid")
      .all(senderThreadId, targetThreadId, requestKey)
      .map(toHold)
      .find((hold) => (hold.payload as { input?: { content?: unknown } } | null)?.input?.content === content)
  }

  /** The chain's held messages, oldest first. */
  heldFor(chainId: string): ChainHoldRecord[] {
    return this.db.statement("SELECT * FROM agent_chain_holds WHERE chain_id = ? AND status = 'held' ORDER BY created_at, rowid").all(chainId).map(toHold)
  }

  /**
   * One more message of the chain. Under the budget, with nothing held, it goes and is counted. Otherwise a holdable
   * message is kept (a retry of the same request finds its hold) and one that cannot wait throws `ChainBudgetReached`.
   */
  admit(message: ChainMessage): ChainAdmission {
    return this.db.transaction((): ChainAdmission => {
      const earlier = this.db.statement('SELECT * FROM agent_chain_holds WHERE request_key = ?').get(message.requestKey)
      if (earlier) return { status: 'held', chainId: message.chainId, hold: toHold(earlier), replayed: true }
      const chain = this.ensure(message.chainId, message.senderThreadId)
      if (chain.used < CHAIN_BUDGET && !this.heldFor(chain.chainId).length) return { status: 'go', chainId: chain.chainId, seq: this.count(chain.chainId) }
      if (message.holdable === false) throw new ChainBudgetReached()
      const hold: ChainHoldRecord = {
        holdId: `hold:${randomUUID()}`,
        chainId: chain.chainId,
        requestKey: message.requestKey,
        kind: message.kind,
        senderThreadId: message.senderThreadId,
        senderRunId: message.senderRunId,
        targetThreadId: message.targetThreadId,
        payload: message.payload,
        status: 'held'
      }
      this.db
        .statement(`INSERT INTO agent_chain_holds(hold_id, chain_id, request_key, kind, sender_thread_id, sender_run_id, target_thread_id, payload, status, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`)
        .run(hold.holdId, hold.chainId, hold.requestKey, hold.kind, hold.senderThreadId, hold.senderRunId, hold.targetThreadId, stableStringify(hold.payload ?? null), this.now())
      // Where the chain started hears of it: the card (S3b) reads this.
      this.store.appendEvent({ threadId: chain.rootThreadId, runId: null, type: 'chain.held', payload: { chainId: chain.chainId, holdId: hold.holdId, used: chain.used, targetThreadId: hold.targetThreadId } })
      return { status: 'held', chainId: chain.chainId, hold, replayed: false }
    })
  }

  /** Throws `ChainBudgetReached`, counting nothing, when the chain could not send one more message now. */
  assertOpen(chainId: string): void {
    const chain = this.get(chainId)
    if (chain && (chain.used >= CHAIN_BUDGET || this.heldFor(chainId).length)) throw new ChainBudgetReached()
  }

  /** Counts one message past any hold: one Continue sends. Returns its place in the budget. */
  count(chainId: string): number {
    this.db.statement('UPDATE agent_chains SET used = used + 1, total = total + 1, updated_at = ? WHERE chain_id = ?').run(this.now(), chainId)
    return this.get(chainId)?.used ?? 1
  }

  /** Gives back a message's count when its send failed after it was admitted. */
  release(chainId: string): void {
    this.db.statement('UPDATE agent_chains SET used = MAX(used - 1, 0), total = MAX(total - 1, 0), updated_at = ? WHERE chain_id = ?').run(this.now(), chainId)
  }

  /** A new budget: a person wrote in the chain, or pressed Continue. What is held stays held until Continue sends it. */
  renew(chainId: string): void {
    const at = this.now()
    this.db.statement('UPDATE agent_chains SET used = 0, budget_started_at = ?, updated_at = ? WHERE chain_id = ?').run(at, at, chainId)
  }

  /**
   * Moves a hold from `from` to `to`, once: false when it was not in `from` any more. Continue claims a hold (`held` to
   * `continued`) before sending it, so a second Continue never sends it twice; a send that then fails ends `failed`.
   */
  settleHold(holdId: string, to: Exclude<ChainHoldStatus, 'held'>, from: ChainHoldStatus = 'held', result?: unknown): boolean {
    const changed = this.db
      .statement('UPDATE agent_chain_holds SET status = ?, result = ?, settled_at = ? WHERE hold_id = ? AND status = ?')
      .run(to, result === undefined ? null : stableStringify(result), this.now(), holdId, from)
    return Number(changed.changes) === 1
  }

  private ensure(chainId: string, senderThreadId: string): AgentChainRecord {
    const existing = this.get(chainId)
    if (existing) return existing
    const rootRunId = chainId.startsWith('chain:') ? chainId.slice('chain:'.length) : chainId
    const rootThreadId = this.store.getRun(rootRunId)?.threadId ?? senderThreadId
    const at = this.now()
    this.db
      .statement('INSERT INTO agent_chains(chain_id, root_thread_id, root_run_id, used, total, budget_started_at, created_at, updated_at) VALUES(?, ?, ?, 0, 0, ?, ?, ?)')
      .run(chainId, rootThreadId, rootRunId, at, at, at)
    return this.get(chainId)!
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }

  private get db() {
    return this.store.db
  }
}

/** A message kept at its chain's budget, as its sender learns of it. */
export interface HeldMessage {
  holdId: string
  chainId: string
  rootThreadId: string
  targetThreadId: string
  /** The same request was held before: this is that hold. */
  replayed: boolean
}

/** The send stopped at the chain's budget: the message is held, not refused. */
export class AgentMessageHeld extends Error {
  constructor(readonly held: HeldMessage) {
    super(`Not sent yet: this chain of agent messages reached ${CHAIN_BUDGET} without a person in between, so the message is kept for the person to Continue or Stop. Nothing was dropped. End your turn; do not send it again.`)
  }
}

export function isAgentMessageHeld(error: unknown): error is AgentMessageHeld {
  return error instanceof AgentMessageHeld
}

/**
 * A message that cannot wait reached a chain at its budget, or one with messages held. Its code is the refusal agents
 * already know (`agent_hops_exceeded`).
 */
export class ChainBudgetReached extends Error {
  readonly code = 'agent_hops_exceeded'
  constructor() {
    super(`This chain of agent messages reached ${CHAIN_BUDGET} without a person in between; a person decides whether it goes on. End your turn and let a person reply.`)
  }
}

function toChain(row: Row): AgentChainRecord {
  return {
    chainId: String(row.chain_id),
    rootThreadId: String(row.root_thread_id),
    rootRunId: String(row.root_run_id),
    used: int(row.used) ?? 0,
    total: int(row.total) ?? 0
  }
}

function toHold(row: Row): ChainHoldRecord {
  return {
    holdId: String(row.hold_id),
    chainId: String(row.chain_id),
    requestKey: String(row.request_key),
    kind: row.kind as ChainHoldKind,
    senderThreadId: String(row.sender_thread_id),
    senderRunId: str(row.sender_run_id),
    targetThreadId: String(row.target_thread_id),
    payload: json<unknown>(row.payload),
    status: row.status as ChainHoldStatus
  }
}
