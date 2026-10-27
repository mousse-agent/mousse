import { afterEach, describe, expect, it } from 'vitest'
import { systemClock } from '../../../src/mms/net/clock'
import type { Clock, ExecutionKey, IdentityService } from '../../../src/mms/net/contracts'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteExecutionLedger } from '../../../src/mms/net/store/executions'
import {
  DurableRpcDispatcher,
  LEDGER_RESULT_MAX_BYTES
} from '../../../src/mms/net/sync/rpcDispatcher'
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
  rpc.register({
    method: 'test.write',
    capability: 'write',
    mutating: true,
    handle: async (params) => {
      handled++
      const size = (params as { size?: number }).size ?? 0
      return size ? { text: 'x'.repeat(size) } : { ok: true }
    }
  })
  const call = (idem: string, params: unknown = {}, id: RpcId = newId('rpc')) =>
    rpc.dispatch('test.write', params, idem, {
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
    expect(removed).toBe(2)
    expect(executions.get(done)).toBeUndefined()
    expect(executions.get(failed)).toBeUndefined()
    for (const kept of [uncertain, running, referenced, botOutcome])
      expect(executions.get(kept)).toBeDefined()
    // Nothing newer than the cutoff goes.
    const recent = settled(node, 'recent', 'completed')
    expect(executions.prune(1_001)).toBe(0)
    expect(executions.get(recent)).toBeDefined()
  })
})

describe('request ledger results', () => {
  it('keeps small results and only a hash of large ones', async () => {
    const f = await fixture()
    const small = await f.call('small', { size: 100 })
    expect(await f.call('small', { size: 100 })).toEqual(small)
    expect(f.handled()).toBe(1)

    const id = newId('rpc'),
      large = (await f.call('large', { size: LEDGER_RESULT_MAX_BYTES + 1 }, id)) as { text: string }
    // The caller that is waiting gets the whole result.
    expect(large.text).toHaveLength(LEDGER_RESULT_MAX_BYTES + 1)
    const row = f.db.database
      .prepare("SELECT length(result) AS bytes, result FROM net_executions WHERE trigger='large'")
      .get() as { bytes: number; result: string }
    expect(row.bytes).toBeLessThan(512)
    expect(JSON.parse(row.result)).toMatchObject({ $ledger: 'omitted', bytes: expect.any(Number) })
    // A retry cannot be given the answer back, and says so instead of inventing one.
    await expect(f.call('large', { size: LEDGER_RESULT_MAX_BYTES + 1 })).rejects.toMatchObject({
      code: 'outcome_uncertain'
    })
    await expect(f.rpc.result(id, f.peer)).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(f.handled()).toBe(2)
  })
})
