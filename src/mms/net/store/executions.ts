import type { AdmitOutcome, BotExecutionBinding, ExecutionKey, ExecutionLedger, ExecutionRecord, ExecutionState } from '../contracts'
import { isId, newId } from '../../../shared/net'
import type { BotId, ExecutionId } from '../../../shared/net'
import { NetDatabase, fail, integer, json, same } from './database'

const terminal = new Set<ExecutionState>(['completed', 'failed', 'cancelled', 'uncertain', 'expired'])
const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  accepted: ['running', 'failed', 'cancelled', 'uncertain'],
  running: ['waitingApproval', 'completed', 'failed', 'cancelled', 'uncertain'],
  waitingApproval: ['running', 'cancelled', 'uncertain'],
  completed: [], failed: [], cancelled: [], uncertain: [], expired: []
}

export class SqliteExecutionLedger implements ExecutionLedger {
  constructor(private readonly db: NetDatabase) {}
  admit(key: ExecutionKey, payloadHash: string, now: number, sideEffects?: (record: ExecutionRecord) => void, plannedId?: ExecutionId): AdmitOutcome {
    return this.insert(key, payloadHash, now, 'accepted', sideEffects, plannedId)
  }
  expire(key: ExecutionKey, payloadHash: string, now: number, sideEffects?: (record: ExecutionRecord) => void, plannedId?: ExecutionId): { kind: 'expired' | 'duplicate'; record: ExecutionRecord } {
    const result = this.insert(key, payloadHash, now, 'expired', sideEffects, plannedId)
    return { kind: result.kind === 'admitted' ? 'expired' : 'duplicate', record: result.record }
  }
  bindRun(id: ExecutionId, binding: BotExecutionBinding): void {
    if (!this.db.inTransaction) fail('bad_request', 'Run binding must be installed inside admission.')
    this.db.transaction(() => {
      const r = this.required(id)
      if (r.binding) { if (!same(r.binding, binding)) fail('conflict', 'Execution binding changed.'); return }
      if (r.state !== 'accepted' || r.scope !== binding.space || r.target !== binding.bot) fail('conflict', 'Execution scope does not match its run binding.')
      const bytes = json(binding)
      this.db.charge(1, Buffer.byteLength(bytes))
      this.db.database.prepare('UPDATE net_executions SET binding=? WHERE id=?').run(bytes, id)
    })
  }
  transition(id: ExecutionId, to: ExecutionState, now: number, patch?: Pick<ExecutionRecord, 'result' | 'error'>, sideEffects?: (record: ExecutionRecord) => void): ExecutionRecord {
    integer(now)
    return this.db.transaction(() => {
      const previous = this.required(id)
      if (!(to in transitions)) fail('bad_request', 'Unknown execution state.')
      const next = { ...previous, ...patch, state: to, updatedAt: now }
      if (previous.state === to) {
        if ((patch?.result !== undefined && !same(previous.result ?? null, patch.result)) || (patch?.error !== undefined && !same(previous.error ?? null, patch.error))) fail('conflict', 'Replayed execution outcome differs.')
        return previous
      }
      if (terminal.has(previous.state) || !transitions[previous.state].includes(to)) fail('conflict', 'Execution transition is not permitted.')
      if (now < previous.updatedAt) fail('bad_request', 'Execution update time decreased.')
      this.db.charge(1, Buffer.byteLength(json(next)))
      this.db.database.prepare('UPDATE net_executions SET state=?,updated_at=?,result=?,error=? WHERE id=?').run(to, now, next.result === undefined ? null : json(next.result), next.error === undefined ? null : json(next.error), id)
      this.db.checkpoint('executions.transition.beforeSideEffects')
      sideEffects?.(next)
      return this.required(id)
    })
  }
  get(id: ExecutionId): ExecutionRecord | undefined {
    const row = this.db.database.prepare('SELECT * FROM net_executions WHERE id=?').get(id)
    return row ? this.record(row) : undefined
  }
  find(key: ExecutionKey): ExecutionRecord | undefined {
    const row = this.db.database.prepare('SELECT * FROM net_executions WHERE scope=? AND target=? AND trigger=?').get(key.scope, key.target, key.trigger)
    return row ? this.record(row) : undefined
  }
  recoverAfterRestart(now: number, sideEffects?: (record: ExecutionRecord) => void): ExecutionRecord[] {
    integer(now)
    const changed: ExecutionRecord[] = []
    // Each outcome/accounting callback has its own bounded transaction. A crash
    // between records resumes the remaining rows without repeating callbacks.
    for (;;) {
      const rows = this.db.database.prepare("SELECT id,state FROM net_executions WHERE state IN ('accepted','running','waitingApproval') ORDER BY id LIMIT 100").all()
      if (!rows.length) break
      for (const r of rows) changed.push(this.transition(r.id as ExecutionId, r.state === 'accepted' ? 'failed' : 'uncertain', now,
        r.state === 'accepted' ? { error: { code: 'not_started', message: 'Execution was accepted but had not started before restart.' } } : { error: { code: 'outcome_uncertain', message: 'Execution may have performed unrecorded effects before restart.' } }, sideEffects))
    }
    return changed
  }
  exportFor(target: BotId): ExecutionRecord[] { return this.db.database.prepare('SELECT * FROM net_executions WHERE target=? ORDER BY scope,trigger').all(target).map((row) => this.record(row)) }
  importFor(target: BotId, rows: ExecutionRecord[]): void {
    if (rows.length > 500 || Buffer.byteLength(json(rows)) > 1024 * 1024) fail('too_large', 'Execution import requires bounded batches.')
    this.db.transaction(() => {
      for (const record of rows) {
        this.validateKey(record, record.payloadHash, record.startedAt)
        integer(record.updatedAt)
        if (!isId('execution', record.id) || record.target !== target || !terminal.has(record.state)) fail('bad_request', 'Only quiesced bot outcomes may be transferred.')
        const previous = this.find(record)
        if (previous) { if (!same(previous, record)) fail('conflict', 'Imported execution differs from its durable outcome.'); continue }
        if (this.get(record.id)) fail('conflict', 'Execution id is already bound to a different key.')
        this.db.charge(1, Buffer.byteLength(json(record)))
        this.db.database.prepare('INSERT INTO net_executions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(record.id, record.scope, record.target, record.trigger, record.payloadHash, record.state, record.startedAt, record.updatedAt, record.result === undefined ? null : json(record.result), record.error === undefined ? null : json(record.error), record.binding === undefined ? null : json(record.binding))
      }
    })
  }
  private insert(key: ExecutionKey, hash: string, now: number, state: 'accepted' | 'expired', sideEffects?: (record: ExecutionRecord) => void, plannedId?: ExecutionId): AdmitOutcome {
    this.validateKey(key, hash, now)
    if (plannedId !== undefined && !isId('execution', plannedId)) fail('bad_request', 'Invalid planned execution identity.')
    return this.db.transaction(() => {
      const previous = this.find(key)
      if (previous) { if (previous.payloadHash !== hash) fail('conflict', 'Trigger id has different exact payload bytes.'); return { kind: 'duplicate', record: previous } }
      if (plannedId && this.get(plannedId)) fail('conflict', 'Planned execution id already belongs to another trigger.')
      const record: ExecutionRecord = { ...key, id: plannedId ?? newId('execution'), payloadHash: hash, state, startedAt: now, updatedAt: now }
      this.db.charge(1, Buffer.byteLength(json(record)))
      this.db.database.prepare('INSERT INTO net_executions VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL)').run(record.id, key.scope, key.target, key.trigger, hash, state, now, now)
      this.db.checkpoint('executions.admit.beforeSideEffects')
      sideEffects?.(record)
      return { kind: 'admitted', record: this.required(record.id) }
    })
  }
  private validateKey(key: ExecutionKey, hash: string, now: number): void {
    integer(now)
    if ((!isId('space', key.scope) && !isId('node', key.scope)) || !key.target || !key.trigger || key.target.length > 256 || key.trigger.length > 256 || !/^[0-9a-f]{64}$/.test(hash)) fail('bad_request', 'Invalid scoped execution key or payload hash.')
  }
  private required(id: ExecutionId): ExecutionRecord { return this.get(id) ?? fail('bad_request', 'Unknown execution.') }
  private record(row: Record<string, any>): ExecutionRecord {
    return { id: row.id, scope: row.scope, target: row.target, trigger: row.trigger, payloadHash: row.payload_hash, state: row.state, startedAt: row.started_at, updatedAt: row.updated_at,
      ...(row.result === null ? {} : { result: JSON.parse(row.result) }), ...(row.error === null ? {} : { error: JSON.parse(row.error) }), ...(row.binding === null ? {} : { binding: JSON.parse(row.binding) }) }
  }
}
