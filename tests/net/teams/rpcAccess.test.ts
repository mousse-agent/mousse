/**
 * The same-person check of the request dispatcher, with the access decision for teammates behind it: off (or with
 * the default directory) another person gets the `forbidden` of today; on, with a directory that lets them in, only
 * the routed rows marked `crossUser` are reachable, and never for a thread kept on this computer only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { systemClock } from '../../../src/mms/net/clock'
import type { IdentityService } from '../../../src/mms/net/contracts'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteExecutionLedger } from '../../../src/mms/net/store/executions'
import { DurableRpcDispatcher, type TeamAccessPort } from '../../../src/mms/net/sync/rpcDispatcher'
import { CROSS_USER_METHODS, ROUTED_METHODS, routedNetMethod } from '../../../src/shared/bridge/routed'
import { newId, type NodeDelegation, type Roster, type UserId } from '../../../src/shared/net'
import type { TeamDirectory } from '../../../src/shared/teams/types'
import { makeTempDir } from '../harness/tmp'

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
})

const me = newId('user'),
  mate = newId('user'),
  team = newId('user'),
  here = newId('node')

/** Lets `mate` reach every thread of the team on this computer. */
const welcoming: TeamDirectory = {
  teamOf: (node) => (node === here ? team : undefined),
  isActiveMember: (of, user) => of === team && user === mate,
  threadAccess: () => ({ owner: me, people: [mate] })
}

/** A dispatcher with every routed row registered as a no-op, and a caller for `me` and for `mate`. */
function fixture(teams?: TeamAccessPort) {
  const dir = makeTempDir('teams-rpc-').path
  const db = new NetDatabase({ profileDir: dir })
  closers.push(() => db.close())
  // Roster checks are not under test: every node holds a current delegation in its person's roster.
  const node = newId('node')
  const delegation = {
    subject: node,
    keyEpoch: 1,
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    caps: ['read', 'chat', 'write']
  } as unknown as NodeDelegation
  const roster = { nodes: [delegation], revoked: [] } as unknown as Roster
  const identity = {
    self: () => ({ user: me, node: here }),
    pinnedRootKey: () => 'root',
    roster: () => roster,
    rosterState: () => 'ok',
    verifySigned: (signed: unknown) => signed
  } as unknown as IdentityService
  const rpc = new DurableRpcDispatcher({
    db,
    executions: new SqliteExecutionLedger(db),
    identity,
    clock: systemClock,
    ...(teams ? { teams } : {})
  })
  for (const [method, row] of Object.entries(ROUTED_METHODS))
    rpc.register({
      method: routedNetMethod(method),
      family: 'routed',
      capability: row.capability,
      ephemeral: true,
      handle: async () => ({ ok: true })
    })
  rpc.register({ method: 'bridge.nodes', family: 'bridge', capability: 'read', ephemeral: true, handle: async () => [] })
  const call = (user: UserId, method: string, params: Record<string, unknown> = paramsOf(method)) =>
    rpc.dispatch(method, params, undefined, {
      id: newId('rpc'),
      caller: { node, user, delegation },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      progress() {}
    })
  return { call }
}

/** The params of a call to a routed row on the thread `thr_shared`. */
function paramsOf(name: string): Record<string, unknown> {
  const row = ROUTED_METHODS[name.slice('routed.'.length)]
  return row ? { [row.threadIds?.[0] ?? 'threadId']: 'thr_shared' } : {}
}

/** What the call ends with: `ok`, or the error it was refused with, as text, so a changed message shows. */
const outcome = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'ok',
    (error: { code?: string; message?: string; details?: unknown }) =>
      JSON.stringify({ code: error.code, message: error.message, details: error.details })
  )

const routedNames = Object.keys(ROUTED_METHODS).map(routedNetMethod)

describe('a routed call from another person', () => {
  it('is refused the same way as before the flag, without a port, with the flag off, or with the default directory', async () => {
    const before = fixture()
    const refused = await outcome(before.call(mate, routedNetMethod('threads.get')))
    expect(JSON.parse(refused)).toMatchObject({ code: 'forbidden' })
    const off = fixture({ enabled: () => false, directory: welcoming, localOnly: () => false })
    const denyAll = fixture({ enabled: () => true, localOnly: () => false })
    for (const name of [...routedNames, 'bridge.nodes']) {
      expect(await outcome(before.call(mate, name)), name).toBe(refused)
      expect(await outcome(off.call(mate, name)), name).toBe(refused)
      expect(await outcome(denyAll.call(mate, name)), name).toBe(refused)
    }
    // The same person still goes through as always.
    expect(await outcome(off.call(me, routedNetMethod('threads.get')))).toBe('ok')
    expect(await outcome(before.call(me, routedNetMethod('threads.list')))).toBe('ok')
  })

  it('reaches only the rows marked crossUser once the flag is on and the directory lets the person in', async () => {
    const before = fixture()
    const refused = await outcome(before.call(mate, routedNetMethod('threads.get')))
    const on = fixture({ enabled: () => true, directory: welcoming, localOnly: () => false })
    const reached: string[] = []
    for (const [method, row] of Object.entries(ROUTED_METHODS)) {
      const result = await outcome(on.call(mate, routedNetMethod(method)))
      if (result === 'ok') reached.push(method)
      else expect(result, method).toBe(refused)
      expect(result === 'ok', method).toBe(row.crossUser === true)
    }
    expect(reached.sort()).toEqual([...CROSS_USER_METHODS].sort())
    // A method that is no routed row is never reachable.
    expect(await outcome(on.call(mate, 'bridge.nodes'))).toBe(refused)
  })

  it('never reaches a thread kept on this computer only, a call naming no thread, or a thread with no lookup', async () => {
    const before = fixture()
    const refused = await outcome(before.call(mate, routedNetMethod('threads.get')))
    const kept = fixture({ enabled: () => true, directory: welcoming, localOnly: () => true })
    const noLookup = fixture({ enabled: () => true, directory: welcoming })
    const on = fixture({ enabled: () => true, directory: welcoming, localOnly: () => false })
    for (const method of CROSS_USER_METHODS) {
      expect(await outcome(kept.call(mate, routedNetMethod(method))), method).toBe(refused)
      expect(await outcome(noLookup.call(mate, routedNetMethod(method))), method).toBe(refused)
    }
    // A folder row asked for a project, not a thread, names no thread.
    expect(await outcome(on.call(mate, routedNetMethod('review.files'), { projectId: 'prj_x' }))).toBe(refused)
    expect(await outcome(on.call(mate, routedNetMethod('review.files'), { threadId: 'thr_shared' }))).toBe('ok')
  })
})
