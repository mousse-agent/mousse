import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeReceipt, ThreadAction } from '../../shared/threadActions'
import { DEFAULT_UNDO_RETENTION_POLICY, type UndoRetentionEligibility, type UndoRetentionPolicy } from '../../shared/undoRetention'
import { ThreadJournal } from '../data/ThreadJournal'
import { withGitMutationLocks } from './GitOperationCoordinator'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { enableVersionedLifecycleWriter } from '../queue/ThreadLifecycleAdmission'

interface RetentionEvent {
  version: 1
  kind: 'adopt' | 'clock' | 'configure' | 'expire' | 'pin' | 'refresh-pair'
  at: number
  policy?: UndoRetentionPolicy
  suspended?: boolean
  ids?: string[]
  pinned?: boolean
  reason?: string
  deadline?: number
}
interface State {
  adoptedAt?: number
  highWater: number
  suspended: boolean
  policy: UndoRetentionPolicy
  expired: Set<string>
  pins: Map<string, string>
  deadlines: Map<string, number>
}

/** Append-only capability authority. Old actions, snapshots and incidental Git reachability cannot revive expiry. */
export class UndoRetentionService {
  private readonly journal: ThreadJournal
  constructor(private readonly threadDirectory: string, private readonly now: () => number = Date.now, readOnly = false) {
    this.journal = new ThreadJournal(threadDirectory, { readOnly })
  }

  private state(): State {
    const state: State = { highWater: 0, suspended: false, policy: { ...DEFAULT_UNDO_RETENTION_POLICY }, expired: new Set(), pins: new Map(), deadlines: new Map() }
    for (const record of this.journal.list().filter((entry) => entry.operationType === 'undo-retention')) {
      const event = record.details as RetentionEvent
      if (record.state !== 'completed' || event?.version !== 1 || !['adopt', 'clock', 'configure', 'expire', 'pin', 'refresh-pair'].includes(event.kind) || !Number.isSafeInteger(event.at) || event.at < 0
        || (event.ids !== undefined && (!Array.isArray(event.ids) || event.ids.some((id) => typeof id !== 'string' || !/^(?:[a-f0-9-]{36}|action:[^\x00-\x1f]{1,256})$/i.test(id)) || new Set(event.ids).size !== event.ids.length))
        || (['expire', 'pin', 'refresh-pair'].includes(event.kind) && !event.ids?.length)
        || (event.kind === 'refresh-pair' && (event.ids?.length !== 2 || !Number.isSafeInteger(event.deadline) || event.deadline! < event.at))
        || (event.kind === 'pin' && (typeof event.pinned !== 'boolean' || typeof event.reason !== 'string' || event.reason.length > 512))
        || (event.suspended !== undefined && (typeof event.suspended !== 'boolean' || !['clock', 'configure'].includes(event.kind)))
        || (['adopt', 'configure'].includes(event.kind) && !event.policy)
        || (event.policy !== undefined && !['adopt', 'configure'].includes(event.kind))) throw new Error('Unknown Undo retention authority; cleanup and historical code operations are blocked.')
      if (event.kind === 'adopt') {
        if (state.adoptedAt !== undefined) throw new Error('Duplicate Undo retention adoption; history is blocked.')
        state.adoptedAt = event.at
      }
      if (state.adoptedAt === undefined) throw new Error('Undo retention authority lacks policy adoption.')
      if (event.policy) { this.validatePolicy(event.policy); state.policy = event.policy }
      state.highWater = Math.max(state.highWater, event.at)
      if (event.suspended !== undefined) state.suspended = event.suspended
      for (const id of event.ids ?? []) {
        if (event.kind === 'expire') state.expired.add(id)
        if (event.kind === 'pin') { if (event.pinned) state.pins.set(id, event.reason ?? 'Saved checkpoint'); else state.pins.delete(id) }
        if (event.kind === 'refresh-pair' && event.deadline && !state.expired.has(id)) state.deadlines.set(id, event.deadline)
      }
    }
    return state
  }

  private append(event: Omit<RetentionEvent, 'version'>): void {
    enableVersionedLifecycleWriter(this.threadDirectory)
    this.journal.append({ operationId: randomUUID(), operationType: 'undo-retention', state: 'completed', details: { version: 1, ...event } })
  }
  private validatePolicy(policy: UndoRetentionPolicy): void {
    if (![policy.windowMs, policy.migrationGraceMs, policy.maxForwardStepMs].every((value) => Number.isSafeInteger(value) && value > 0) || !Number.isSafeInteger(policy.batchSize) || policy.batchSize < 1 || policy.batchSize > 1000) throw new Error('Invalid Undo retention policy.')
  }
  private actions(): ThreadAction[] {
    const path = join(this.threadDirectory, 'actions.json')
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ThreadAction[] : []
  }
  private receipts(): ChangeReceipt[] {
    return this.journal.list().flatMap((entry) => {
      const receipt = (entry.details as { receipt?: ChangeReceipt })?.receipt
      return receipt ? [receipt] : []
    })
  }
  private pending(): boolean {
    return [...this.journal.latestByOperation().values()].some((entry) => ['planned', 'running', 'prepared', 'git_applied', 'context_pending', 'recovery_required'].includes(entry.state))
      || this.actions().some((action) => ['planned', 'running', 'checkpointing', 'undoing', 'undo_conflict'].includes(action.state))
  }
  private key(action: ThreadAction): string { return action.receiptId ?? `action:${action.id}` }
  private deadline(action: ThreadAction, state: State): number {
    const terminal = Date.parse(action.completedAt ?? action.createdAt)
    return state.deadlines.get(this.key(action)) ?? Math.max(terminal + state.policy.windowMs, (state.adoptedAt ?? this.now()) + state.policy.migrationGraceMs)
  }

  /** Read-only UI view; durable expiry is committed by sweep under the mutation lease. */
  eligibility(action: ThreadAction): UndoRetentionEligibility {
    return this.projectEligibility(action, this.state(), this.pending())
  }

  /** A request-local projection: journal and pending state are read once for the entire history. */
  eligibilityMany(actions: ThreadAction[]): ThreadAction[] {
    const state = this.state(), pending = this.pending()
    return actions.map((action) => ({ ...action, retention: this.projectEligibility(action, state, pending) }))
  }

  private projectEligibility(action: ThreadAction, state: State, pending: boolean): UndoRetentionEligibility {
    const key = this.key(action)
    const deadline = this.deadline(action, state)
    const date = Number.isFinite(deadline) ? new Date(deadline).toISOString() : undefined
    if (state.expired.has(key)) return { state: 'expired', reason: 'Undo code material expired. Conversation history is still available; continue on current code.', deadline: date }
    if (state.pins.has(key)) return { state: 'pinned', reason: state.pins.get(key)!, deadline: date }
    if (!Number.isFinite(deadline) || state.suspended || pending) return { state: 'blocked', reason: state.suspended ? 'Clock moved forward unexpectedly; review retention before resuming expiry.' : 'An active operation or recovery protects history.', deadline: date }
    return { state: 'available', reason: 'Undo and exact-code history are retained.', deadline: date }
  }

  isReceiptExpired(receiptId: string): boolean { return this.state().expired.has(receiptId) }
  expiredReceiptIds(): ReadonlySet<string> { return this.state().expired }
  policy(): UndoRetentionPolicy { return { ...this.state().policy } }
  clockAllowsRelease(): boolean {
    const state = this.state(), now = this.now()
    return !state.suspended && now >= state.highWater && now <= state.highWater + state.policy.maxForwardStepMs
  }

  /** Called only inside existing task/repository mutation ownership, before historical admission. */
  assertAvailable(action: ThreadAction): void {
    this.sweepHeld()
    const eligibility = this.eligibility(action)
    if (eligibility.state === 'expired' || eligibility.state === 'blocked') throw new Error(eligibility.reason)
  }

  async sweep(workspacePath: string, signal?: AbortSignal, heldThreadLease?: ThreadLeaseHandle): Promise<{ expired: string[]; suspended: boolean; retainedGitRefs: true }> {
    return withGitMutationLocks(this.threadDirectory, workspacePath, 'undo-retention', () => this.sweepHeld(), signal, heldThreadLease)
  }

  /** Logical transition only. Phase 3 never claims reclaimed Git bytes. */
  sweepHeld(): { expired: string[]; suspended: boolean; retainedGitRefs: true } {
    let state = this.state()
    const now = this.now()
    if (!Number.isFinite(now)) throw new Error('Invalid retention clock.')
    if (state.adoptedAt === undefined) {
      this.append({ kind: 'adopt', at: now, policy: state.policy })
      state = this.state()
    }
    if (now > state.highWater + state.policy.maxForwardStepMs) {
      if (!state.suspended) this.append({ kind: 'clock', at: state.highWater, suspended: true })
      return { expired: [], suspended: true, retainedGitRefs: true }
    }
    if (state.suspended || now < state.highWater || this.pending()) return { expired: [], suspended: state.suspended, retainedGitRefs: true }
    // Persist elapsed wall time even for empty sweeps. Rollback never makes a deadline older.
    if (now - state.highWater >= 86400000) this.append({ kind: 'clock', at: now })
    const actions = this.actions(), receipts = this.receipts()
    const candidates: string[] = []
    const branches = new Set(actions.map((action) => action.conversationBranchId))
    for (const branch of branches) {
      for (const action of actions.filter((item) => item.conversationBranchId === branch)) {
        const key = this.key(action)
        if (state.expired.has(key)) continue
        if (!['completed', 'failed', 'stopped', 'undone'].includes(action.state) || state.pins.has(key) || this.deadline(action, state) > now) break
        candidates.push(key)
      }
    }
    // Dependencies are indivisible: active compensation pair, integration contribution and receipt reversal.
    // Only the currently offered pair is coupled; older compensation ancestry must not refresh forever.
    const dependencies: string[][] = []
    const actionById = new Map(actions.map((action) => [action.id, action]))
    const actionKeys = new Set(actions.map((action) => this.key(action)))
    for (const action of actions) {
      const compensation = action.compensationActionId ? actionById.get(action.compensationActionId) : undefined
      if (compensation && compensation.state !== 'undone') dependencies.push([this.key(action), this.key(compensation)])
    }
    for (const receipt of receipts) for (const contribution of receipt.contributions) if (contribution.receiptId) dependencies.push([receipt.id, contribution.receiptId])
    const selected = new Set(candidates)
    // Contribution-only receipts follow the parent boundary only when no other live boundary needs them.
    for (const [parent, child] of dependencies) if (selected.has(parent) && !actionKeys.has(child) && !state.pins.has(child)) selected.add(child)
    let changed = true
    while (changed) {
      changed = false
      for (const pair of dependencies) if (pair.some((id) => !state.expired.has(id) && !selected.has(id))) for (const id of pair) if (selected.delete(id)) changed = true
      // Removing a dependency also stops its branch prefix: never leave arbitrary holes.
      for (const branch of branches) {
        let stopped = false
        for (const action of actions.filter((item) => item.conversationBranchId === branch)) {
          const key = this.key(action)
          if (state.expired.has(key)) continue
          if (!selected.has(key)) stopped = true
          if (stopped && selected.delete(key)) changed = true
        }
      }
    }
    // A batch must contain the entire dependency closure; defer an oversized closure safely.
    const expired = [...selected]
    if (expired.length > state.policy.batchSize) {
      const batch = new Set(expired.slice(0, state.policy.batchSize))
      let reduced = true
      while (reduced) { reduced = false; for (const pair of dependencies) if (pair.some((id) => selected.has(id) && !batch.has(id))) for (const id of pair) if (batch.delete(id)) reduced = true }
      // A closure trimmed at the batch boundary must still be an oldest prefix.
      for (const branch of branches) {
        let stopped = false
        for (const action of actions.filter((item) => item.conversationBranchId === branch)) {
          const key = this.key(action)
          if (state.expired.has(key)) continue
          if (!batch.has(key)) stopped = true
          if (stopped) batch.delete(key)
        }
      }
      // Prefix trimming can remove the other half of a cross-branch dependency.
      if (dependencies.some((pair) => pair.some((id) => batch.has(id)) && pair.some((id) => !state.expired.has(id) && !batch.has(id)))) batch.clear()
      expired.splice(0, expired.length, ...batch)
    }
    if (expired.length) this.append({ kind: 'expire', at: now, ids: expired, reason: 'Dependency-closed oldest terminal prefix reached its retention deadline.' })
    return { expired, suspended: false, retainedGitRefs: true }
  }

  /** Recovery calls this before its completed journal marker. Idempotent pair receipt fixes the deadline. */
  refreshPairHeld(target: ThreadAction, compensation: ThreadAction): void {
    let state = this.state()
    if (state.adoptedAt === undefined) {
      this.append({ kind: 'adopt', at: this.now(), policy: state.policy })
      state = this.state()
    }
    const ids = [this.key(target), this.key(compensation)]
    if (ids.some((id) => state.expired.has(id))) throw new Error('Expired history cannot be resurrected by receipt replay.')
    if (this.journal.list().some((entry) => entry.operationType === 'undo-retention' && (entry.details as RetentionEvent)?.kind === 'refresh-pair' && (entry.details as RetentionEvent).ids?.[1] === ids[1])) return
    const at = Math.max(this.now(), state.highWater)
    this.append({ kind: 'refresh-pair', at, ids, deadline: at + state.policy.windowMs })
  }

  async configure(workspacePath: string, input: Partial<UndoRetentionPolicy>, human: boolean, acknowledgeClock = false): Promise<void> {
    if (!human) throw new Error('Retention policy changes require a human-controlled action.')
    await withGitMutationLocks(this.threadDirectory, workspacePath, 'undo-retention-policy', () => {
      this.sweepHeld()
      const state = this.state(), policy = { ...state.policy, ...input }
      this.validatePolicy(policy)
      this.append({ kind: 'configure', at: acknowledgeClock ? Math.max(this.now(), state.highWater) : state.highWater, policy, ...(acknowledgeClock ? { suspended: false } : {}) })
    })
  }

  async pin(workspacePath: string, actionId: string, pinned: boolean, human: boolean, reason = 'Saved checkpoint'): Promise<void> {
    if (!human) throw new Error('Only a human-controlled action can pin an Undo checkpoint indefinitely.')
    await withGitMutationLocks(this.threadDirectory, workspacePath, 'undo-retention-pin', () => {
      this.sweepHeld()
      const action = this.actions().find((item) => item.id === actionId)
      if (!action) throw new Error('Action not found.')
      const state = this.state(), id = this.key(action)
      if (state.expired.has(id)) throw new Error('Expired Undo checkpoints cannot be pinned or recreated.')
      this.append({ kind: 'pin', at: state.highWater, ids: [id], pinned, reason: reason.slice(0, 512) })
    })
  }
}
