import { afterEach, describe, expect, it } from 'vitest'
import { systemClock } from '../../../src/mms/net/clock'
import type { Clock, ExecutionKey, IdentityService } from '../../../src/mms/net/contracts'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteExecutionLedger } from '../../../src/mms/net/store/executions'
import { DurableRpcDispatcher } from '../../../src/mms/net/sync/rpcDispatcher'
import {
  newId,
  type NodeDelegation,
  type NodeId,
  type Roster,
  type RpcId
} from '../../../src/shared/net'
import { makeTempDir } from '../harness/tmp'

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
})

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const CAP = 16 * 1024
const hash = (seed: string): string => seed.repeat(64).slice(0, 64)

function fakeClock(start = Date.now()): Clock & { advance(ms: number): void } {
  let now = start
  return {
    now: () => now,
    monotonic: () => now,
    setTimeout: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      return { cancel: () => clearTimeout(handle) }
    },
    advance(ms) {
      now += ms
    }
  }
}

async function fixture(options: { clock?: Clock; retention?: number } = {}) {
  const dir = makeTempDir('ledger-prune-').path
  const db = new NetDatabase({ profileDir: dir })
  closers.push(() => db.close())
  // Roster checks are not under test, and real signatures would dominate 10,000 requests.
  const node = newId('node'),
    user = newId('user'),
    delegation = {
      subject: node,
      keyEpoch: 1,
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      caps: ['read', 'chat', 'write']
    } as unknown as NodeDelegation
  const roster = { nodes: [delegation], revoked: [] } as unknown as Roster
  const identity = {
    self: () => ({ user, node: newId('node') }),
    pinnedRootKey: () => 'root',
    roster: () => roster,
    rosterState: () => 'ok',
    verifySigned: (signed: unknown) => signed
  } as unknown as IdentityService
  const executions = new SqliteExecutionLedger(db),
    clock = options.clock ?? systemClock
  const rpc = new DurableRpcDispatcher({
    db,
    executions,
    identity,
    clock,
    ...(options.retention ? { ledgerRetentionMs: options.retention } : {})
  })
  const peer = { node, user, delegation }
  let handled = 0
  const handle = async (params: unknown) => {
    handled++
    const size = (params as { size?: number }).size ?? 0
    return size ? { text: 'x'.repeat(size) } : { ok: true }
  }
  rpc.register({ method: 'test.write', capability: 'write', mutating: true, handle })
  rpc.register({
    method: 'test.capped',
    capability: 'write',
    mutating: true,
    ledgerResultMaxBytes: CAP,
    handle
  })
  const call = (
    idem: string,
    params: unknown = {},
    id: RpcId = newId('rpc'),
    method = 'test.write'
  ) =>
    rpc.dispatch(method, params, idem, {
      id,
      caller: peer,
      signal: new AbortController().signal,
      deadlineAt: clock.now() + 60_000,
      progress() {}
    })
  const count = (table: string): number =>
    (db.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  return { db, executions, rpc, peer, call, count, handled: () => handled, clock }
}

describe('request ledger retention', () => {
  it(
    'keeps the ledger and its aliases bounded across 10,000 writes',
    { timeout: 60_000 },
    async () => {
      const clock = fakeClock(),
        f = await fixture({ clock })
      // The first write is pinned by a budget reservation and must survive every pruning pass.
      await f.call('pinned')
      const pinned = f.db.database.prepare('SELECT id FROM net_executions').get() as { id: string }
      f.db.database
        .prepare('INSERT INTO net_budget_reservations VALUES(?,?,?,?,?,NULL)')
        .run(pinned.id, 'bot_x', 'spc_x', 0, 1)
      for (let i = 0; i < 10_000; i++) {
        clock.advance(2 * MINUTE)
        await f.call(`write-${i}`)
      }
      // Seven days at one write per two minutes, plus up to an hour before the next pass, plus the pinned row.
      const bound = (7 * DAY) / (2 * MINUTE) + 30 + 2
      expect(f.count('net_executions')).toBeLessThanOrEqual(bound)
      expect(f.count('net_rpc_aliases')).toBeLessThanOrEqual(bound)
      expect(f.executions.get(pinned.id as never)).toBeDefined()
      expect(
        f.db.database
          .prepare('SELECT count(*) AS n FROM net_rpc_aliases WHERE execution=?')
          .get(pinned.id)
      ).toMatchObject({ n: 1 })
    }
  )

  it('answers a repeated request from the ledger inside the window and runs it again after', async () => {
    const clock = fakeClock(),
      f = await fixture({ clock, retention: DAY })
    const first = await f.call('same', { n: 1 })
    expect(await f.call('same', { n: 1 })).toEqual(first)
    expect(f.handled()).toBe(1)
    clock.advance(DAY + 2 * 60 * MINUTE)
    await f.call('fresh')
    expect(f.count('net_executions')).toBe(1)
    await f.call('same', { n: 1 })
    expect(f.handled()).toBe(3)
  })

  it('prunes only settled, unreferenced rows owned by a node', async () => {
    const f = await fixture(),
      { executions, db } = f,
      node = f.peer.node as NodeId,
      space = newId('space')
    const settled = (
      scope: ExecutionKey['scope'],
      trigger: string,
      finish: 'completed' | 'failed' | 'uncertain' | 'running'
    ) => {
      const { record } = executions.admit({ scope, target: 'x', trigger }, hash('a'), 1_000)
      if (finish === 'failed') executions.transition(record.id, 'failed', 1_001)
      else if (finish !== 'running') {
        executions.transition(record.id, 'running', 1_001)
        executions.transition(record.id, finish, 1_002)
      } else executions.transition(record.id, 'running', 1_001)
      return record.id
    }
    const done = settled(node, 'done', 'completed'),
      failed = settled(node, 'failed', 'failed'),
      uncertain = settled(node, 'uncertain', 'uncertain'),
      running = settled(node, 'running', 'running'),
      referenced = settled(node, 'referenced', 'completed'),
      botOutcome = settled(space, 'bot', 'completed')
    db.database
      .prepare('INSERT INTO net_budget_reservations VALUES(?,?,?,?,?,NULL)')
      .run(referenced, 'bot_x', 'spc_x', 0, 1)
    const removed = executions.prune(10_000)
    expect(removed).toBe(3)
    for (const gone of [done, failed, uncertain]) expect(executions.get(gone)).toBeUndefined()
    for (const kept of [running, referenced, botOutcome]) expect(executions.get(kept)).toBeDefined()
    // Nothing newer than the cutoff goes.
    const recent = settled(node, 'recent', 'completed')
    expect(executions.prune(1_001)).toBe(0)
    expect(executions.get(recent)).toBeDefined()
  })
})

describe('request ledger pruning at scale', () => {
  it('deletes aliases through the execution index', async () => {
    const f = await fixture()
    const plan = f.db.database
      .prepare('EXPLAIN QUERY PLAN DELETE FROM net_rpc_aliases WHERE execution=?')
      .all('exe_x')
      .map((row) => String(row.detail))
      .join(' ')
    expect(plan).toContain('net_rpc_aliases_execution')
    const prune = f.db.database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM net_executions e WHERE e.scope>='nod_' AND e.scope<'nod`' AND e.updated_at<? ORDER BY e.updated_at LIMIT 1"
      )
      .all(1)
    // The node-owned range is a search on the (scope, target, trigger) key, not a table scan.
    expect(prune.map((row) => String(row.detail)).join(' ')).toMatch(
      /SEARCH e USING INDEX sqlite_autoindex_net_executions_\d \(scope>\? AND scope<\?\)/
    )
  })

  it('prunes a large backlog quickly and in passes that stop on a time budget', async () => {
    let tick = 0
    const clock: Clock = { ...systemClock, monotonic: () => (tick += 300) },
      f = await fixture({ clock })
    const node = f.peer.node as NodeId
    f.db.transaction(() => {
      const alias = f.db.database.prepare(
        'INSERT INTO net_rpc_aliases(caller,id,method,payload_hash,execution,capability) VALUES(?,?,?,?,?,?)'
      )
      // A large table of live aliases, so a scan per deleted request would be slow.
      for (let i = 0; i < 50_000; i++)
        alias.run(node, `rpc_filler${i}`, 'test.write', hash('f'), `exe_filler${i}`, 'write')
    })
    const ids: string[] = []
    for (let i = 0; i < 500; i++) {
      f.db.transaction(() => {
        const { record } = f.executions.admit(
          { scope: node, target: 'test.write', trigger: `old-${i}` },
          hash('b'),
          1_000
        )
        f.executions.transition(record.id, 'running', 1_001)
        f.executions.transition(record.id, 'completed', 1_002, { result: null })
        f.db.database
          .prepare(
            'INSERT INTO net_rpc_aliases(caller,id,method,payload_hash,execution,capability) VALUES(?,?,?,?,?,?)'
          )
          .run(node, `rpc_old${i}`, 'test.write', hash('b'), record.id, 'write')
        ids.push(record.id)
      })
    }
    // The fake monotonic clock jumps 300 ms per read: each pass does one batch of 100.
    const started = performance.now()
    expect(f.rpc.pruneLedger()).toBe(100)
    expect(f.count('net_executions')).toBe(400)
    let removed = 100
    for (let pass = 0; pass < 10 && removed < 500; pass++) removed += f.rpc.pruneLedger()
    expect(removed).toBe(500)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(f.count('net_rpc_aliases')).toBe(50_000)
  })
})

describe('request ledger results', () => {
  it('keeps the whole result of a method that sets no limit, so a lost reply can be replayed', async () => {
    const f = await fixture()
    const id = newId('rpc'),
      big = (await f.call('create', { size: 40 * 1024 }, id)) as { text: string }
    expect(big.text).toHaveLength(40 * 1024)
    expect(await f.call('create', { size: 40 * 1024 })).toEqual(big)
    expect(await f.rpc.result(id, f.peer)).toEqual(big)
    expect(f.handled()).toBe(1)
  })

  it('keeps small results and only a hash of large ones for a method that sets a limit', async () => {
    const f = await fixture()
    const small = await f.call('small', { size: 100 }, newId('rpc'), 'test.capped')
    expect(await f.call('small', { size: 100 }, newId('rpc'), 'test.capped')).toEqual(small)
    expect(f.handled()).toBe(1)

    const id = newId('rpc'),
      large = (await f.call('large', { size: CAP + 1 }, id, 'test.capped')) as { text: string }
    // The caller that is waiting gets the whole result.
    expect(large.text).toHaveLength(CAP + 1)
    const row = f.db.database
      .prepare("SELECT length(result) AS bytes, result FROM net_executions WHERE trigger='large'")
      .get() as { bytes: number; result: string }
    expect(row.bytes).toBeLessThan(512)
    expect(JSON.parse(row.result)).toMatchObject({ $ledger: 'omitted', bytes: expect.any(Number) })
    // A retry cannot be given the answer back, and says so instead of inventing one.
    await expect(
      f.call('large', { size: CAP + 1 }, newId('rpc'), 'test.capped')
    ).rejects.toMatchObject({ code: 'outcome_uncertain' })
    await expect(f.rpc.result(id, f.peer)).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(f.handled()).toBe(2)
  })
})
