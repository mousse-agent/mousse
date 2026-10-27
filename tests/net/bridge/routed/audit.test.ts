import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE,
  BRIDGE_AUDIT_REFUSED_ROWS_PER_NODE,
  SqliteBridgeAudit
} from '../../../../src/mms/net/store/audit'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { systemClock } from '../../../../src/mms/net/clock'
import { newId, type NodeId } from '../../../../src/shared/net'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function audit() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-audit-')))
  const db = new NetDatabase({ profileDir: dir })
  cleanups.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const insert = db.database.prepare(
    'INSERT INTO bridge_audit(at,node,kind,method,thread,project,outcome) VALUES(?,?,?,?,NULL,NULL,?)'
  )
  /** Many rows at once, as a flood would leave them; the real path records one at a time. */
  const bulk = (node: NodeId, kind: 'change' | 'refused', count: number, at: number) => {
    db.database.exec('BEGIN')
    for (let index = 0; index < count; index++)
      insert.run(at, node, kind, 'files.write', kind === 'change' ? 'ok' : 'thread_not_found')
    db.database.exec('COMMIT')
  }
  return { store: new SqliteBridgeAudit(db, systemClock), db, bulk }
}

describe('the audit of what other computers did', () => {
  it('keeps a device’s earlier changes when it floods the audit with refusals', () => {
    const { store, bulk } = audit()
    const device = newId('node') as NodeId
    const other = newId('node') as NodeId
    store.record({
      node: device,
      method: 'files.write',
      thread: 't-1',
      outcome: 'ok',
      kind: 'change'
    })
    store.record({ node: device, method: 'git.push', thread: 't-1', outcome: 'ok', kind: 'change' })
    store.record({
      node: other,
      method: 'threads.rename',
      thread: 't-2',
      outcome: 'ok',
      kind: 'change'
    })
    // 25,000 refusals from the same device, then the ordinary pruning that follows its next calls.
    bulk(device, 'refused', 25_000, systemClock.now())
    for (let call = 0; call < 60; call++)
      store.record({
        node: device,
        method: 'files.write',
        outcome: 'thread_not_found',
        kind: 'refused'
      })

    const rows = store.recent(100_000, device)
    expect(rows.filter((row) => row.kind === 'change').map((row) => row.method)).toEqual([
      'git.push',
      'files.write'
    ])
    // Pruning runs every 50 inserts, so the budget is exceeded by less than that between runs.
    expect(rows.filter((row) => row.kind === 'refused').length).toBeLessThan(
      BRIDGE_AUDIT_REFUSED_ROWS_PER_NODE + 50
    )
    // Another device's trail is untouched by it.
    expect(store.recent(10, other)).toHaveLength(1)
  }, 120_000)

  it('deletes a change only when it is both old and beyond the newest rows of its device', () => {
    const { store, bulk, db } = audit()
    const device = newId('node') as NodeId
    const day = 24 * 60 * 60 * 1000
    // Old rows beyond the budget go; recent rows beyond it stay until they are old.
    bulk(device, 'change', BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE + 100, systemClock.now() - 40 * day)
    bulk(device, 'change', 50, systemClock.now())
    for (let call = 0; call < 50; call++)
      store.record({ node: device, method: 'git.commit', outcome: 'ok', kind: 'change' })
    const count = () =>
      (
        db.database
          .prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE node=? AND kind='change'")
          .get(device) as { n: number }
      ).n
    expect(count()).toBe(BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE)
    // Changes that are recent stay even beyond the budget: replacing them takes 30 days, not a burst of calls.
    const burst = newId('node') as NodeId
    bulk(burst, 'change', BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE + 100, systemClock.now())
    for (let call = 0; call < 50; call++)
      store.record({ node: burst, method: 'git.commit', outcome: 'ok', kind: 'change' })
    const burstCount = (
      db.database
        .prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE node=? AND kind='change'")
        .get(burst) as { n: number }
    ).n
    expect(burstCount).toBe(BRIDGE_AUDIT_CHANGE_ROWS_PER_NODE + 150)
  }, 120_000)

  it('counts reads per device and hour without rows', () => {
    const { store, db } = audit()
    const device = newId('node') as NodeId
    store.countRead(device, 100)
    store.countRead(device, 50)
    expect(store.reads(device)).toEqual([expect.objectContaining({ calls: 2, bytes: 150 })])
    expect(
      (db.database.prepare('SELECT COUNT(*) AS n FROM bridge_audit').get() as { n: number }).n
    ).toBe(0)
  })
})
