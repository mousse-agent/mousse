import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteExecutionLedger } from '../../../src/mms/net/store/executions'
import { SqliteBudgetLedger } from '../../../src/mms/net/store/budgets'
import { newId } from '../../../src/shared/net'
import { profile, fixture } from './helpers'
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
})
it('binds a preplanned receipt ID atomically with admission and budget, preserving original duplicate identity', () => {
  const path = profile(),
    f = fixture(),
    db = new NetDatabase({ profileDir: path }),
    ledger = new SqliteExecutionLedger(db),
    budget = new SqliteBudgetLedger(db)
  closers.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => db.close()
  )
  const planned = newId('execution'),
    key = f.key(),
    hash = 'a'.repeat(64),
    staged = vi.fn((record) => {
      expect(record.id).toBe(planned)
      budget.reserve(f.bot, f.space, record.id, 60, 100)
      db.charge(1)
      db.database.prepare('INSERT INTO test_receipts VALUES(?)').run(record.id)
    })
  db.database.exec('CREATE TABLE test_receipts(execution TEXT PRIMARY KEY)')
  budget.setDailyBudget(f.bot, f.space, 100)
  expect(() =>
    ledger.admit(
      key,
      hash,
      100,
      (record) => {
        staged(record)
        throw Error('receipt rollback')
      },
      planned
    )
  ).toThrow('receipt rollback')
  expect(ledger.get(planned)).toBeUndefined()
  expect(db.database.prepare('SELECT count(*) AS n FROM net_budget_reservations').get()!.n).toBe(0)
  expect(db.database.prepare('SELECT count(*) AS n FROM test_receipts').get()!.n).toBe(0)
  expect(ledger.admit(key, hash, 100, staged, planned)).toMatchObject({
    kind: 'admitted',
    record: { id: planned }
  })
  staged.mockClear()
  expect(ledger.admit(key, hash, 101, staged, newId('execution'))).toMatchObject({
    kind: 'duplicate',
    record: { id: planned }
  })
  expect(staged).not.toHaveBeenCalled()
  expect(() => ledger.admit(f.key(), hash, 102, staged, planned)).toThrow(/another trigger/)
  expect(() => ledger.admit(f.key(), hash, 102, staged, 'invalid' as any)).toThrow(
    /Invalid planned/
  )
  expect(db.database.prepare('SELECT count(*) AS n FROM test_receipts').get()!.n).toBe(1)
  const expired = newId('execution')
  expect(ledger.expire(f.key(), hash, 103, undefined, expired)).toMatchObject({
    kind: 'expired',
    record: { id: expired }
  })
})
