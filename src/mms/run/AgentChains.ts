import { randomUUID } from 'node:crypto'
import { int, json, str, type Row } from './db/rows'
import { stableStringify } from './json'
import type { RunStore } from './RunStore'

/**
 * The messages one chain may send before a person decides whether it goes on (issue #1442). Every participant counts
 * against it: thread agents and subagents at any depth, in any order. A person's message anywhere in the chain, or
 * Continue on its hold, gives it a new budget.
 */
export const CHAIN_BUDGET = 12

/** What a held message waits for and how it is sent again: a thread_send of work, or a note. */
export type ChainHoldKind = 'work' | 'note'

export type ChainHoldStatus = 'held' | 'continued' | 'stopped' | 'failed'

export interface AgentChainRecord {
  chainId: string
  /** Where the chain started: the thread whose run no agent message started. Its card shows there. */
  rootThreadId: string
  rootRunId: string
  /** Messages counted since the budget began. */
  used: number
  /** Messages counted since the chain began. */
  total: number
  budgetStartedAt: string
}

export interface ChainHoldRecord {
  holdId: string
  chainId: string
  requestKey: string
  kind: ChainHoldKind
  senderThreadId: string
  senderRunId: string | null
  targetThreadId: string
  /** What the send needs to run again, as the kind's sender wrote it. */
  payload: unknown
  status: ChainHoldStatus
  result: unknown
  createdAt: string
  settledAt: string | null
}

/** The chain a message joins, and where it stands in it (`seq` of `CHAIN_BUDGET`). */
export type ChainAdmission =
  | { status: 'go'; chainId: string; seq: number }
  | { status: 'held'; chainId: string; hold: ChainHoldRecord; replayed: boolean }

export interface ChainMessage {
  chainId: string
  /** The sending run; with `rootThreadId`, where the chain started when this message is its first. */
  senderThreadId: string
  senderRunId: string | null
  targetThreadId: string
  kind: ChainHoldKind
  /** The sender's request: a retry finds the hold its first try made. */
  requestKey: string
  payload: unknown
  /** Messages that cannot wait (an agent's steer, a queue edit) are refused at the budget instead of held. */
  holdable?: boolean
}

/**
 * The chain id a run's messages belong to: the chain its run carries (`RunOutcome.agentChain`), or for a run no agent
 * message, wake or delegation led to, a chain of its own.
 */
export function chainIdOf(store: RunStore, runId: string): string {
  return store.getRun(runId)?.outcome?.agentChain ?? `chain:${runId}`
}

/**
 * The causal chain record (issues #1442, #1443): one row per chain, counting the agent messages it sent, and the messages
 * held at its budget for the person's Continue or Stop. A held chain holds every later message too, so one decision
 * covers them; nothing is dropped.
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

  /** The chain's held messages, oldest first. */
  heldFor(chainId: string): ChainHoldRecord[] {
    return this.db.statement("SELECT * FROM agent_chain_holds WHERE chain_id = ? AND status = 'held' ORDER BY created_at, rowid").all(chainId).map(toHold)
  }

  /** Every chain with a held message, oldest hold first: one card each, where the chain started. */
  heldChains(rootThreadId?: string): AgentChainRecord[] {
    const sql = `SELECT c.* FROM agent_chains c
      JOIN (SELECT chain_id, MIN(rowid) AS first FROM agent_chain_holds WHERE status = 'held' GROUP BY chain_id) h ON h.chain_id = c.chain_id
      ${rootThreadId ? 'WHERE c.root_thread_id = ?' : ''} ORDER BY h.first`
    const rows = rootThreadId ? this.db.statement(sql).all(rootThreadId) : this.db.statement(sql).all()
    return rows.map(toChain)
  }

  /**
   * One more message in the chain. Under the budget, with nothing of the chain held, it goes and is counted. Otherwise a
   * holdable message is kept as held (a retry of the same request finds its hold), and one that cannot wait throws
   * `ChainBudgetReached`.
   */
  admit(message: ChainMessage): ChainAdmission {
    return this.db.transaction((): ChainAdmission => {
      const earlier = this.db.statement('SELECT * FROM agent_chain_holds WHERE request_key = ?').get(message.requestKey)
      if (earlier) return { status: 'held', chainId: message.chainId, hold: toHold(earlier), replayed: true }
      const chain = this.ensure(message.chainId, message.senderThreadId, message.senderRunId)
      const holding = this.heldFor(chain.chainId).length > 0
      if (!holding && chain.used < CHAIN_BUDGET) {
        const at = this.now()
        this.db.statement('UPDATE agent_chains SET used = used + 1, total = total + 1, updated_at = ? WHERE chain_id = ?').run(at, chain.chainId)
        return { status: 'go', chainId: chain.chainId, seq: chain.used + 1 }
      }
      if (message.holdable === false) throw new ChainBudgetReached(chain)
      const hold: ChainHoldRecord = {
        holdId: `hold:${randomUUID()}`,
        chainId: chain.chainId,
        requestKey: message.requestKey,
        kind: message.kind,
        senderThreadId: message.senderThreadId,
        senderRunId: message.senderRunId,
        targetThreadId: message.targetThreadId,
        payload: message.payload,
        status: 'held',
        result: null,
        createdAt: this.now(),
        settledAt: null
      }
      this.db
        .statement(`INSERT INTO agent_chain_holds(hold_id, chain_id, request_key, kind, sender_thread_id, sender_run_id, target_thread_id, payload, status, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`)
        .run(hold.holdId, hold.chainId, hold.requestKey, hold.kind, hold.senderThreadId, hold.senderRunId, hold.targetThreadId, stableStringify(hold.payload ?? null), hold.createdAt)
      this.store.appendEvent({ threadId: chain.rootThreadId, runId: null, type: 'chain.held', payload: { chainId: chain.chainId, holdId: hold.holdId, used: chain.used, targetThreadId: hold.targetThreadId } })
      return { status: 'held', chainId: chain.chainId, hold, replayed: false }
    })
  }

  /**
   * Throws `ChainBudgetReached` when the chain could not send one more message now (its budget is spent or something of
   * it is held), counting nothing: for a change to a message already sent, such as an edit of another thread's queue.
   */
  assertOpen(chainId: string): void {
    const chain = this.get(chainId)
    if (chain && (chain.used >= CHAIN_BUDGET || this.heldFor(chainId).length > 0)) throw new ChainBudgetReached(chain)
  }

  /** Gives back a message's count when its send failed after it was admitted. */
  release(chainId: string): void {
    this.db.statement('UPDATE agent_chains SET used = MAX(used - 1, 0), total = MAX(total - 1, 0), updated_at = ? WHERE chain_id = ?').run(this.now(), chainId)
  }

  /**
   * A new budget for the chain: a person wrote in it, or pressed Continue. Messages still held stay held; Continue sends
   * them itself (`settleHold`).
   */
  restartBudget(chainId: string): void {
    const at = this.now()
    this.db.statement('UPDATE agent_chains SET used = 0, budget_started_at = ?, updated_at = ? WHERE chain_id = ?').run(at, at, chainId)
  }

  /**
   * Counts a held message that Continue sends, in the budget Continue began. The message is no new step of the chain:
   * it is one the chain already made.
   */
  countContinued(chainId: string): number {
    this.db.statement('UPDATE agent_chains SET used = used + 1, total = total + 1, updated_at = ? WHERE chain_id = ?').run(this.now(), chainId)
    return this.get(chainId)?.used ?? 1
  }

  /** Ends a hold: Continue sent it (or could not), or Stop withdrew it. False when it was no longer held. */
  settleHold(holdId: string, status: Exclude<ChainHoldStatus, 'held'>, result?: unknown): boolean {
    const changed = this.db
      .statement("UPDATE agent_chain_holds SET status = ?, result = ?, settled_at = ? WHERE hold_id = ? AND status = 'held'")
      .run(status, result === undefined ? null : stableStringify(result), this.now(), holdId)
    return Number(changed.changes) === 1
  }

  /** A hold Continue claimed (`continued`) whose send then failed: it ends as `failed`, with why. */
  failContinued(holdId: string, reason: string): void {
    this.db
      .statement("UPDATE agent_chain_holds SET status = 'failed', result = ?, settled_at = ? WHERE hold_id = ? AND status = 'continued'")
      .run(stableStringify({ reason }), this.now(), holdId)
  }

  private ensure(chainId: string, senderThreadId: string, senderRunId: string | null): AgentChainRecord {
    const existing = this.get(chainId)
    if (existing) return existing
    // The chain's first message: it started at the run its id names, or (a chain id another way) at the sender.
    const rootRunId = chainId.startsWith('chain:') ? chainId.slice('chain:'.length) : senderRunId ?? chainId
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
  /** Where the person's card is: the thread the chain started in. */
  rootThreadId: string
  targetThreadId: string
  /** The same request was held before: this is that hold. */
  replayed: boolean
}

/** What a sender is told about its held message: kept, not sent, and the person decides; it ends its turn. */
export function heldMessageNote(held: HeldMessage): string {
  return `Not sent yet: this chain of agent messages reached ${CHAIN_BUDGET} without a person in between, so the message is kept for the person to Continue or Stop (in thread ${held.rootThreadId}). Nothing was dropped. End your turn; do not send it again.`
}

/** The send stopped at the chain's budget: the message is held (`held`), not refused. */
export class AgentMessageHeld extends Error {
  constructor(readonly held: HeldMessage) {
    super(heldMessageNote(held))
  }
}

export function isAgentMessageHeld(error: unknown): error is AgentMessageHeld {
  return error instanceof AgentMessageHeld
}

/** A message that cannot wait reached a chain at its budget (or one with messages held). */
export class ChainBudgetReached extends Error {
  constructor(readonly chain: AgentChainRecord) {
    super(`This chain of agent messages reached ${CHAIN_BUDGET} without a person in between; a person decides whether it goes on.`)
  }
}

function toChain(row: Row): AgentChainRecord {
  return {
    chainId: String(row.chain_id),
    rootThreadId: String(row.root_thread_id),
    rootRunId: String(row.root_run_id),
    used: int(row.used) ?? 0,
    total: int(row.total) ?? 0,
    budgetStartedAt: String(row.budget_started_at)
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
    status: row.status as ChainHoldStatus,
    result: json<unknown>(row.result),
    createdAt: String(row.created_at),
    settledAt: str(row.settled_at)
  }
}
