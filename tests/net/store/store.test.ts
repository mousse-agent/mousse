import { readFileSync, rmSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { SqliteNetStore } from '../../../src/mms/net/store'
import { newId, NetError, STORE_TXN_MAX_BYTES } from '../../../src/shared/net'
import type { BlobId, EventId } from '../../../src/shared/net'
import { decodeEnvelope, encodeEnvelope } from '../../../src/mms/net/sync/codec'
import { fixture, profile } from './helpers'

const roots: string[] = []; const stores: SqliteNetStore[] = []
function open(path: string, options: Partial<ConstructorParameters<typeof SqliteNetStore>[0]> = {}): SqliteNetStore {
  const store = new SqliteNetStore({ profileDir: path, ...options }); stores.push(store); return store
}
function fresh(): string { const path = profile(); roots.push(path); return path }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const hash = 'a'.repeat(64)

describe('durable stream storage', () => {
  it('persists dense authority positions and exact duplicate signatures across reopen and retention', () => {
    const path = fresh(); const f = fixture(); const store = open(path)
    store.streams.createStream(f.descriptor, 1)
    const rec = f.record(1); const id = decodeEnvelope(rec.envelope).envelope.id
    const input = { ...rec, id }
    expect(store.streams.appendAsAuthority(f.descriptor.id, input)).toMatchObject({ kind: 'stored', seq: 1 })
    expect(store.streams.appendAsAuthority(f.descriptor.id, { ...input, recvTs: input.recvTs + 10 })).toMatchObject({ kind: 'duplicate', seq: 1, recvTs: input.recvTs })
    expect(() => store.streams.appendAsAuthority(f.descriptor.id, { ...input, sig: new Uint8Array(64) })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    store.close()
    const restarted = open(path)
    expect(restarted.streams.cursor(f.descriptor.id)).toEqual({ stream: f.descriptor.id, epoch: 1, seq: 1 })
    restarted.streams.truncate(f.descriptor.id, 1)
    expect(restarted.streams.getById(f.descriptor.id, id)).toBeUndefined()
    expect(restarted.streams.snapshotReason(f.descriptor.id, { epoch: 1, seq: 0 })).toBe('cursorTooOld')
    expect(restarted.streams.appendAsAuthority(f.descriptor.id, input)).toMatchObject({ kind: 'duplicate', seq: 1 })
    expect(restarted.streams.head(f.descriptor.id).seq).toBe(1)
    expect(statSync(`${path}/net/net.db`).mode & 0o777).toBe(0o600)
  })
  it('never skips gaps, advances on rejected batches, or accepts a conflicting duplicate', () => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    const first = f.record(1); const third = f.record(3)
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, [first, third])).toThrowError(expect.objectContaining({ code: 'snapshot_required' }))
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(0)
    store.streams.applyFromAuthority(f.descriptor.id, [first, f.record(2)])
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, [{ ...first, sig: new Uint8Array(64) }])).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, [f.record(1, 2)])).toThrowError(expect.objectContaining({ code: 'snapshot_required' }))
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(2)
    expect(store.streams.read(f.descriptor.id, { epoch: 1, seq: 0 }, 2, 1)).toMatchObject({ done: false, records: [{ seq: 1 }] })
  })
  it('pins a source snapshot while writes and truncation continue', () => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    store.streams.applyFromAuthority(f.descriptor.id, [f.record(1), f.record(2)])
    const reader = store.streams.openSnapshot(f.descriptor.id)
    try {
      store.streams.applyFromAuthority(f.descriptor.id, [f.record(3)])
      store.streams.truncate(f.descriptor.id, 2)
      expect(reader.target).toEqual({ epoch: 1, seq: 2 })
      expect(reader.next(1024 * 1024)).toMatchObject({ done: true, records: [{ seq: 1 }, { seq: 2 }] })
    } finally { reader.close() }
  })
  it('activates only complete bounded snapshot generations and discards staging on reopen', () => {
    const path = fresh(); const f = fixture(); const store = open(path); store.streams.createStream(f.descriptor, 1)
    store.streams.applyFromAuthority(f.descriptor.id, [f.record(1)])
    const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 2, seq: 501 })
    stage.append(Array.from({ length: 499 }, (_, i) => f.record(i + 1, 2)))
    expect(() => stage.commit()).toThrowError(expect.objectContaining({ code: 'bad_request' }))
    expect(store.streams.cursor(f.descriptor.id)).toMatchObject({ epoch: 1, seq: 1 })
    store.close()
    const restarted = open(path)
    expect(restarted.database.prepare("SELECT count(*) AS n FROM net_generations WHERE state='staging'").get()!.n).toBe(0)
    expect(restarted.streams.cursor(f.descriptor.id)).toMatchObject({ epoch: 1, seq: 1 })
    const complete = restarted.streams.beginSnapshot(f.descriptor.id, { epoch: 2, seq: 501 })
    complete.append(Array.from({ length: 499 }, (_, i) => f.record(i + 1, 2)))
    complete.append([f.record(500, 2), f.record(501, 2)])
    expect(complete.commit()).toMatchObject({ epoch: 2, seq: 501 })
    expect(() => restarted.streams.installSnapshot(f.descriptor.id, 3, 501, Array.from({ length: 501 }, (_, i) => f.record(i + 1, 3)))).toThrowError(expect.objectContaining({ code: 'too_large' }))
  })
  it('pins caller-supplied staging targets and refuses exhausted sequence allocation', () => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    const target = { epoch: 2, seq: 1 }; const stage = store.streams.beginSnapshot(f.descriptor.id, target)
    target.epoch = 3; target.seq = 100
    stage.append([f.record(1, 2)]); expect(stage.commit()).toMatchObject({ epoch: 2, seq: 1 })
    store.database.prepare('UPDATE net_streams SET head=?,cursor=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, f.descriptor.id)
    const record = f.record(1, 2); const id = decodeEnvelope(record.envelope).envelope.id
    expect(() => store.streams.appendAsAuthority(f.descriptor.id, { ...record, id })).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })
  it('counts the cursor row inside the 500-row transaction limit', () => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    const records = Array.from({ length: 500 }, (_, i) => f.record(i + 1))
    expect(() => store.streams.applyFromAuthority(f.descriptor.id, records)).toThrowError(expect.objectContaining({ code: 'too_large' }))
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(0)
    store.streams.applyFromAuthority(f.descriptor.id, records.slice(0, 499)); store.streams.applyFromAuthority(f.descriptor.id, records.slice(499))
    expect(store.streams.read(f.descriptor.id, { epoch: 1, seq: 0 }, 500, 1_000_000).records).toHaveLength(499)
  })
  it.each([false, true])('splits convenience snapshot installation into bounded appends (near byte limit=%s)', (nearByteLimit) => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    const records = Array.from({ length: 500 }, (_, i) => {
      const rec = f.record(i + 1)
      if (nearByteLimit) {
        const envelope = decodeEnvelope(rec.envelope).envelope
        const textLength = Math.floor((STORE_TXN_MAX_BYTES - 500) / 500) - rec.envelope.byteLength - rec.sig.byteLength + (envelope.body as { text: string }).text.length
        rec.envelope = encodeEnvelope({ ...envelope, body: { text: 'x'.repeat(textLength) } })
      }
      return rec
    })
    const batches: Array<{ rows: number; bytes: number }> = []
    const begin = store.streams.beginSnapshot.bind(store.streams)
    const spy = vi.spyOn(store.streams, 'beginSnapshot').mockImplementation((stream, target) => {
      const stage = begin(stream, target)
      return { ...stage, append(batch) { batches.push({ rows: batch.length, bytes: batch.reduce((total, rec) => total + rec.envelope.byteLength + rec.sig.byteLength, 0) }); stage.append(batch) } }
    })
    try { expect(store.streams.installSnapshot(f.descriptor.id, 1, 500, records)).toMatchObject({ epoch: 1, seq: 500 }) } finally { spy.mockRestore() }
    expect(batches.reduce((total, batch) => total + batch.rows, 0)).toBe(500)
    expect(batches.every((batch) => batch.rows <= 499 && batch.bytes <= STORE_TXN_MAX_BYTES - 64 * 1024)).toBe(true)
    expect(batches).toHaveLength(2)
    expect(batches[0].rows).toBe(nearByteLimit ? Math.floor((STORE_TXN_MAX_BYTES - 64 * 1024) / (records[0].envelope.byteLength + records[0].sig.byteLength)) : 499)
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(500)
  })
  it.each(['active', 'archived', 'tombstone'] as const)('rejects snapshot replacement of a known %s authority position', (evidence) => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    const keys = generateKeyPairSync('ed25519')
    const original = f.record(1); original.sig = new Uint8Array(sign(null, original.envelope, keys.privateKey))
    store.streams.applyFromAuthority(f.descriptor.id, [original])
    const originalId = decodeEnvelope(original.envelope).envelope.id
    const second = f.record(2)
    if (evidence === 'archived') store.streams.installSnapshot(f.descriptor.id, 1, 2, [second])
    if (evidence === 'tombstone') store.streams.truncate(f.descriptor.id, 1)
    const before = store.streams.cursor(f.descriptor.id)
    const generation = store.database.prepare('SELECT active_generation FROM net_streams WHERE id=?').get(f.descriptor.id)!.active_generation
    const replacement = f.record(1); replacement.sig = new Uint8Array(sign(null, replacement.envelope, keys.privateKey))
    expect(verify(null, replacement.envelope, keys.publicKey, replacement.sig)).toBe(true)
    const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 1, seq: before.seq })
    expect(() => { stage.append(evidence === 'archived' ? [replacement, second] : [replacement]); stage.commit() }).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.streams.cursor(f.descriptor.id)).toEqual(before)
    expect(store.database.prepare('SELECT active_generation FROM net_streams WHERE id=?').get(f.descriptor.id)!.active_generation).toBe(generation)
    expect(store.streams.getById(f.descriptor.id, decodeEnvelope(replacement.envelope).envelope.id)).toBeUndefined()
    if (evidence === 'active') expect(store.streams.getById(f.descriptor.id, originalId)).toEqual(original)
    stage.abort()
  })
  it('requires authenticated meta validation and preserves original epoch positions', () => {
    const path = fresh(); const f = fixture(); f.descriptor.kind = 'space.meta'
    const store = open(path); store.streams.createStream(f.descriptor, 1)
    expect(() => store.streams.installSnapshot(f.descriptor.id, 2, 1, [f.record(1), f.record(2), f.record(1, 2)])).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    store.close()
    let epochs: number[] = []
    const validated = open(path, { validateMetaSnapshot: { append(records) { epochs.push(...records.map((r) => r.epoch)); return null }, finish() {} } })
    validated.streams.installSnapshot(f.descriptor.id, 2, 1, [f.record(1), f.record(2), f.record(1, 2)])
    expect(epochs).toEqual([1, 1, 2])
    const reader = validated.streams.openSnapshot(f.descriptor.id)
    try { expect(reader.next(1_000_000).records.map((r) => [r.epoch, r.seq])).toEqual([[1, 1], [1, 2]]); expect(reader.next(1_000_000).records.map((r) => [r.epoch, r.seq])).toEqual([[2, 1]]) } finally { reader.close() }
    expect(() => validated.streams.truncate(f.descriptor.id, 1)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })
  it('validates a history above 500 rows in bounded appends and never scans data at activation', () => {
    const f = fixture(); f.descriptor.kind = 'space.meta'
    const batches: number[] = []; const carries: number[] = []; let finishes = 0
    const store = open(fresh(), { validateMetaSnapshot: { append(records, _descriptor, target, carry) {
      batches.push(records.length); carries.push(carry === null ? 0 : carry as number)
      const next = (carry === null ? 0 : carry as number) + records.length
      expect(next).toBeLessThanOrEqual(target.seq)
      return next
    }, finish(carry, _descriptor, target) { finishes++; expect(carry).toBe(target.seq) } } })
    store.streams.createStream(f.descriptor, 1)
    const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 1, seq: 1001 })
    expect(() => stage.append(Array.from({ length: 500 }, (_, i) => f.record(i + 1)))).toThrowError(expect.objectContaining({ code: 'too_large' }))
    stage.append(Array.from({ length: 499 }, (_, i) => f.record(i + 1)))
    stage.append(Array.from({ length: 499 }, (_, i) => f.record(i + 500)))
    stage.append([f.record(999), f.record(1000), f.record(1001)])
    expect(batches).toEqual([499, 499, 3]); expect(carries).toEqual([0, 499, 998])
    const progress = JSON.parse(store.database.prepare('SELECT progress FROM net_snapshot_progress').get()!.progress as string)
    expect(progress).toMatchObject({ last: { epoch: 1, seq: 1001 }, carry: 1001, metaValidated: true })
    const queries: string[] = []; const originalPrepare = store.database.prepare.bind(store.database)
    const spy = vi.spyOn(store.database, 'prepare').mockImplementation((sql) => { queries.push(sql); return originalPrepare(sql) })
    try { expect(stage.commit()).toMatchObject({ epoch: 1, seq: 1001 }) } finally { spy.mockRestore() }
    expect(queries.some((sql) => sql.includes('net_records'))).toBe(false)
    expect(queries.filter((sql) => sql.startsWith('UPDATE'))).toHaveLength(3)
    expect(batches).toEqual([499, 499, 3])
    expect(finishes).toBe(1)
  })
  it('rejects an activation and further appends when committed authority state changed after validation', () => {
    const f = fixture(); const store = open(fresh()); store.streams.createStream(f.descriptor, 1)
    const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 1, seq: 1 })
    stage.append([f.record(1)])
    const committed = f.record(1)
    store.streams.applyFromAuthority(f.descriptor.id, [committed])
    expect(() => stage.commit()).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => stage.append([])).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(store.streams.getById(f.descriptor.id, decodeEnvelope(committed.envelope).envelope.id)).toEqual(committed)
    stage.abort()
  })
  it('rolls back validation carry with rejected data and enforces its byte limit', () => {
    const f = fixture(); f.descriptor.kind = 'space.meta'; let reject = false; let oversize = false
    const store = open(fresh(), { validateMetaSnapshot: { append(records, _descriptor, _target, carry) {
      if (reject) throw new Error('chain check rejected')
      return oversize ? 'x'.repeat(64 * 1024) : (carry === null ? 0 : carry as number) + records.length
    }, finish(carry, _descriptor, target) { expect(carry).toBe(target.seq) } } })
    store.streams.createStream(f.descriptor, 1)
    const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 1, seq: 2 })
    stage.append([f.record(1)]); reject = true
    expect(() => stage.append([f.record(2)])).toThrow('chain check rejected')
    reject = false; oversize = true
    expect(() => stage.append([f.record(2)])).toThrowError(expect.objectContaining({ code: 'too_large' }))
    expect(JSON.parse(store.database.prepare('SELECT progress FROM net_snapshot_progress').get()!.progress as string)).toMatchObject({ last: { epoch: 1, seq: 1 }, carry: 1 })
    expect(store.database.prepare('SELECT count(*) AS n FROM net_records').get()!.n).toBe(1)
    oversize = false; stage.append([f.record(2)]); expect(stage.commit()).toMatchObject({ seq: 2 })
  })
  it('requires the persisted validation carry to prove meta completion before activation', () => {
    const f = fixture(); f.descriptor.kind = 'space.meta'
    const store = open(fresh(), { validateMetaSnapshot: {
      append() { return { verifiedThrough: 0 } },
      finish(carry, _descriptor, target) { if ((carry as { verifiedThrough: number }).verifiedThrough !== target.seq) throw new Error('incomplete authenticated chain') }
    } })
    store.streams.createStream(f.descriptor, 1)
    const stage = store.streams.beginSnapshot(f.descriptor.id, { epoch: 1, seq: 1 })
    stage.append([f.record(1)])
    expect(() => stage.commit()).toThrow('incomplete authenticated chain')
    expect(store.streams.cursor(f.descriptor.id).seq).toBe(0)
    stage.abort()
  })
  it('caps pinned source readers globally at 32 before opening another connection and releases slots', () => {
    const f = fixture(); const a = open(fresh()); const b = open(fresh())
    a.streams.createStream(f.descriptor, 1); b.streams.createStream(f.descriptor, 1)
    const readers = Array.from({ length: 32 }, (_, i) => (i % 2 ? a : b).streams.openSnapshot(f.descriptor.id))
    expect(() => a.streams.openSnapshot(f.descriptor.id)).toThrowError(expect.objectContaining({ code: 'rate_limited' }))
    readers[0].close(); readers[0].close()
    const replacement = a.streams.openSnapshot(f.descriptor.id)
    expect(() => b.streams.openSnapshot(f.descriptor.id)).toThrowError(expect.objectContaining({ code: 'rate_limited' }))
    a.close(); b.close(); replacement.close()
    const c = open(fresh()); c.streams.createStream(f.descriptor, 1); c.streams.openSnapshot(f.descriptor.id).close()
  })
})

describe('execution/outbox/accounting transaction composition', () => {
  it('rolls back the whole admission, including notifications, when outbox fails', () => {
    const f = fixture(); let failed = false
    const store = open(fresh(), { clock: f.clock, fault(point) { if (failed && point === 'outbox.enqueue.beforeCommit') throw new Error('injected receipt failure') } })
    store.streams.createStream(f.descriptor, 1); store.budgets.setDailyBudget(f.bot, f.space, 100)
    let notifications = 0; store.outbox.onChanged(() => notifications++)
    const rec = f.record(1); const id = decodeEnvelope(rec.envelope).envelope.id; const key = f.key()
    failed = true
    expect(() => store.executions.admit(key, hash, f.clock.now(), (execution) => { store.budgets.reserve(f.bot, f.space, execution.id, 100, f.clock.now()); store.outbox.enqueue({ id, stream: f.descriptor.id, envelope: rec.envelope, sig: rec.sig }) })).toThrow('injected receipt failure')
    expect(store.executions.find(key)).toBeUndefined(); expect(store.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(100); expect(store.outbox.get(id)).toBeUndefined(); expect(notifications).toBe(0)
    failed = false
    const admitted = store.executions.admit(key, hash, f.clock.now(), (execution) => { store.budgets.reserve(f.bot, f.space, execution.id, 100, f.clock.now()); store.outbox.enqueue({ id, stream: f.descriptor.id, envelope: rec.envelope, sig: rec.sig }) })
    expect(admitted.kind).toBe('admitted'); expect(notifications).toBe(1)
    const duplicate = store.executions.admit(key, hash, f.clock.now() + 100_000, () => { throw new Error('duplicate side effect') })
    expect(duplicate.record.id).toBe(admitted.record.id); expect(store.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(0)
  })
  it('keeps outbox ambiguity and terminal positions through restart and forbids conflicting outcomes', () => {
    const f = fixture(); const path = fresh(); const store = open(path); store.streams.createStream(f.descriptor, 1)
    const rec = f.record(1); const id = decodeEnvelope(rec.envelope).envelope.id
    store.outbox.enqueue({ id, stream: f.descriptor.id, envelope: rec.envelope, sig: rec.sig }); store.outbox.markAttempt(id); store.close()
    const restarted = open(path); expect(restarted.outbox.due(f.descriptor.id)[0]).toMatchObject({ state: 'unknown', attempts: 1 })
    restarted.outbox.markSent(id, { epoch: 1, seq: 1 }); restarted.outbox.markSent(id, { epoch: 1, seq: 1 })
    expect(() => restarted.outbox.markSent(id, { epoch: 2, seq: 1 })).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => restarted.outbox.markFailed(id, 'forbidden')).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(restarted.outbox.due(f.descriptor.id)).toEqual([])
  })
  it('concurrent connections cannot reserve more daily funds than configured', () => {
    const path = fresh(); const f = fixture(); const a = open(path, { clock: f.clock }); const b = open(path, { clock: f.clock })
    a.budgets.setDailyBudget(f.bot, f.space, 100)
    a.executions.admit(f.key(), hash, f.clock.now(), (r) => a.budgets.reserve(f.bot, f.space, r.id, 60, f.clock.now()))
    const key = f.key()
    expect(() => b.executions.admit(key, hash, f.clock.now(), (r) => b.budgets.reserve(f.bot, f.space, r.id, 60, f.clock.now()))).toThrowError(expect.objectContaining({ code: 'budget_exhausted' }))
    expect(b.executions.find(key)).toBeUndefined(); expect(a.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(40)
  })
  it('holds unknown provider charges, settles idempotently, and preserves admission-day accounting', () => {
    const path = fresh(); const f = fixture(); const store = open(path, { clock: f.clock }); store.budgets.setDailyBudget(f.bot, f.space, 100)
    const run = store.executions.admit(f.key(), hash, f.clock.now(), (r) => store.budgets.reserve(f.bot, f.space, r.id, 100, f.clock.now())).record
    store.executions.transition(run.id, 'running', f.clock.now()); store.budgets.authorizeCall(run.id, 'first', 60)
    expect(() => store.budgets.authorizeCall(run.id, 'second', 41)).toThrowError(expect.objectContaining({ code: 'budget_exhausted' }))
    expect(() => store.budgets.settle(run.id, 20)).toThrowError(expect.objectContaining({ code: 'outcome_uncertain' }))
    store.close()
    const restarted = open(path, { clock: f.clock }); const recovered = restarted.executions.recoverAfterRestart(f.clock.now())
    expect(recovered[0].state).toBe('uncertain'); expect(restarted.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(0)
    f.setNow(86_400_000 + 1); expect(restarted.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(100)
    restarted.budgets.settleCall(run.id, 'first', 20); restarted.budgets.settleCall(run.id, 'first', 20); restarted.budgets.settle(run.id, 20); restarted.budgets.settle(run.id, 20)
    expect(restarted.budgets.remaining(f.bot, f.space, 1_000_000)).toBe(80)
    expect(() => restarted.budgets.settle(run.id, 21)).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => restarted.executions.transition(run.id, 'running', f.clock.now())).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })
  it('atomically couples restart and completion with accounting/receipt callbacks', () => {
    const f = fixture(); const store = open(fresh(), { clock: f.clock }); store.budgets.setDailyBudget(f.bot, f.space, 100)
    const accepted = store.executions.admit(f.key(), hash, f.clock.now(), (r) => store.budgets.reserve(f.bot, f.space, r.id, 40, f.clock.now())).record
    const running = store.executions.admit(f.key(), hash, f.clock.now(), (r) => store.budgets.reserve(f.bot, f.space, r.id, 60, f.clock.now())).record
    store.executions.transition(running.id, 'running', f.clock.now())
    expect(() => store.executions.transition(running.id, 'completed', f.clock.now(), { result: { text: 'done' } }, (r) => { store.budgets.settle(r.id, 20); throw new Error('receipt failure') })).toThrow('receipt failure')
    expect(store.executions.get(running.id)?.state).toBe('running'); expect(store.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(0)
    const changes = store.executions.recoverAfterRestart(f.clock.now(), (r) => { if (r.state === 'failed') store.budgets.settle(r.id, 0) })
    expect(changes.map((r) => r.state).sort()).toEqual(['failed', 'uncertain'])
    expect(store.executions.get(accepted.id)?.error?.code).toBe('not_started'); expect(store.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(40)
    expect(store.executions.recoverAfterRestart(f.clock.now(), () => { throw new Error('must not repeat') })).toEqual([])
  })
  it('transfers complete stopped outcomes and accounting without double charging', () => {
    const f = fixture(); const source = open(fresh(), { clock: f.clock }); source.budgets.setDailyBudget(f.bot, f.space, 100)
    const settled = source.executions.admit(f.key(), hash, f.clock.now(), (r) => source.budgets.reserve(f.bot, f.space, r.id, 40, f.clock.now())).record
    source.executions.transition(settled.id, 'running', f.clock.now()); source.executions.transition(settled.id, 'completed', f.clock.now(), { result: { text: 'done' } }, (r) => source.budgets.settle(r.id, 20))
    const pending = source.executions.admit(f.key(), hash, f.clock.now(), (r) => source.budgets.reserve(f.bot, f.space, r.id, 60, f.clock.now())).record
    source.executions.transition(pending.id, 'running', f.clock.now()); source.budgets.authorizeCall(pending.id, 'pending', 20); source.executions.transition(pending.id, 'uncertain', f.clock.now())
    const ledger = source.executions.exportFor(f.bot); const accounting = source.budgets.exportFor(f.bot)
    const destination = open(fresh(), { clock: f.clock })
    destination.transaction(() => { destination.executions.importFor(f.bot, ledger); destination.budgets.importFor(f.bot, accounting) })
    destination.transaction(() => { destination.executions.importFor(f.bot, ledger); destination.budgets.importFor(f.bot, accounting) })
    expect(destination.executions.get(settled.id)?.result).toEqual({ text: 'done' }); expect(destination.budgets.remaining(f.bot, f.space, f.clock.now())).toBe(20)
    expect(destination.budgets.exportFor(f.bot)).toEqual(accounting)
    expect(() => destination.budgets.importFor(f.bot, { ...accounting, daily: [] })).toThrowError(expect.objectContaining({ code: 'conflict' }))
  })
  it('atomically deduplicates expired markers and rejects swallowed nested failures', () => {
    const f = fixture(); const store = open(fresh()); const key = f.key()
    let callbacks = 0
    expect(store.executions.expire(key, hash, 1, () => callbacks++).kind).toBe('expired')
    expect(store.executions.expire(key, hash, 2, () => callbacks++).kind).toBe('duplicate'); expect(callbacks).toBe(1)
    const second = f.key()
    expect(() => store.executions.admit(second, hash, 2, () => { try { store.budgets.reserve(f.bot, f.space, newId('execution'), 5, 2) } catch { /* must still doom outer txn */ } })).toThrow()
    expect(store.executions.find(second)).toBeUndefined()
  })
})

describe('content-addressed filesystem blobs', () => {
  it.each([false, true])('releases pruned event references while preserving archived history (archived=%s)', (archived) => {
    const f = fixture(); const store = open(fresh(), { clock: f.clock }); store.streams.createStream(f.descriptor, 1)
    const data = Buffer.from('retained reference'); const id = `blb_${createHash('sha256').update(data).digest('hex')}` as BlobId
    const upload = store.blobs.begin(id, data.length, false); upload.write(0, data); upload.commit()
    const rec = f.record(1, 1, newId('event'), [{ id, bytes: data.length, mime: 'text/plain' }]); const event = decodeEnvelope(rec.envelope).envelope.id
    store.streams.applyFromAuthority(f.descriptor.id, [rec]); store.blobs.addRef(id, f.descriptor.id, event)
    if (archived) store.streams.installSnapshot(f.descriptor.id, 1, 1, [rec])
    store.streams.truncate(f.descriptor.id, 1)
    expect(store.blobs.isReferenced(id, f.descriptor.id)).toBe(false)
    expect(store.blobs.collectGarbage(f.clock.now() + 86_400_001)).toEqual(archived ? { removed: 0, bytes: 0 } : { removed: 1, bytes: data.length })
    expect(store.blobs.has(id)).toBe(archived)
  })
  it('persists a GC lease so crash recovery cannot unlink a newly reused hash path', () => {
    const path = fresh(); const f = fixture(); const data = Buffer.from('GC race guard'); const id = `blb_${createHash('sha256').update(data).digest('hex')}` as BlobId
    let armed = false
    const store = open(path, { clock: f.clock, fault(point) { if (armed && point === 'blobs.gc.afterMetadataCommit') throw new Error('GC interrupted') } })
    const upload = store.blobs.begin(id, data.length, false); upload.write(0, data); upload.commit(); armed = true
    expect(() => store.blobs.collectGarbage(f.clock.now() + 86_400_001)).toThrow('GC interrupted')
    expect(store.blobs.has(id)).toBe(false)
    expect(() => store.blobs.begin(id, data.length, false)).toThrowError(expect.objectContaining({ code: 'rate_limited' }))
    store.close()
    const restarted = open(path, { clock: f.clock })
    expect(restarted.blobs.collectGarbage(f.clock.now() + 86_400_001)).toEqual({ removed: 1, bytes: data.length })
    const replacement = restarted.blobs.begin(id, data.length, false); replacement.write(0, data); replacement.commit()
    expect(restarted.blobs.read(id, 0, data.length)).toEqual(data)
  })
  it('journals rename/metadata crash orphans so collection does not leak their bytes', () => {
    const path = fresh(); const f = fixture(); const data = Buffer.from('orphan after rename'); const id = `blb_${createHash('sha256').update(data).digest('hex')}` as BlobId
    const store = open(path, { clock: f.clock, fault(point) { if (point === 'blobs.commit.afterRename') throw new Error('crash after rename') } })
    const upload = store.blobs.begin(id, data.length, false); upload.write(0, data)
    expect(() => upload.commit()).toThrow('crash after rename')
    expect(store.blobs.has(id)).toBe(false); store.close()
    const restarted = open(path, { clock: f.clock })
    expect(restarted.blobs.collectGarbage(f.clock.now() + 86_400_001)).toEqual({ removed: 1, bytes: data.length })
  })
  it('publishes only verified complete uploads, keeps exact duplicate chunks, and survives reopen', () => {
    const path = fresh(); const store = open(path); const data = Buffer.from('private ciphertext placeholder'); const id = `blb_${createHash('sha256').update(data).digest('hex')}` as BlobId
    const upload = store.blobs.begin(id, data.length, true)
    expect(store.blobs.has(id)).toBe(false)
    upload.write(0, data.subarray(0, 10)); upload.write(0, data.subarray(0, 10))
    expect(() => upload.write(0, Buffer.alloc(10))).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => upload.commit()).toThrowError(expect.objectContaining({ code: 'conflict' }))
    upload.write(10, data.subarray(10)); upload.commit(); store.close()
    const restarted = open(path); expect(restarted.blobs.size(id)).toBe(data.length); expect(restarted.blobs.read(id, 0, data.length)).toEqual(data)
    expect(() => restarted.blobs.read(id, data.length, 1)).toThrowError(expect.objectContaining({ code: 'bad_request' }))
  })
  it('binds blob references to actual stored stream events and garbage-collects unreferenced bytes', () => {
    const f = fixture(); const store = open(fresh(), { clock: f.clock }); store.streams.createStream(f.descriptor, 1)
    const data = Buffer.from('blob'); const id = `blb_${createHash('sha256').update(data).digest('hex')}` as BlobId
    const upload = store.blobs.begin(id, 4, false); upload.write(0, data); upload.commit()
    const rec = f.record(1, 1, newId('event'), [{ id, bytes: 4, mime: 'text/plain' }]); const event = decodeEnvelope(rec.envelope).envelope.id
    store.streams.applyFromAuthority(f.descriptor.id, [rec]); store.blobs.addRef(id, f.descriptor.id, event)
    expect(store.blobs.isReferenced(id, f.descriptor.id)).toBe(true)
    expect(() => store.blobs.addRef(id, f.descriptor.id, newId('event'))).toThrowError(expect.objectContaining({ code: 'bad_request' }))
    expect(store.blobs.collectGarbage(f.clock.now() + 86_400_001)).toEqual({ removed: 0, bytes: 0 })
    const other = Buffer.from('unreferenced'); const otherId = `blb_${createHash('sha256').update(other).digest('hex')}` as BlobId
    const pending = store.blobs.begin(otherId, other.length, false); pending.write(0, other); pending.commit()
    expect(store.blobs.collectGarbage(f.clock.now() + 86_400_001)).toEqual({ removed: 1, bytes: other.length })
    expect(store.blobs.has(otherId)).toBe(false)
  })
})
