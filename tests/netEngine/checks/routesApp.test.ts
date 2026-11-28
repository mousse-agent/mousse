/**
 * Owner check `phase1b.routes-app`, its own cases (1b §14): over the route under test (`--route`; `tcp` when run
 * alone), the join dialog lists the ticket's destination with its class. Joining both ways, the joiner's own routes
 * of the link's kind go back with the pairback without a tick (the way it reached the owner is the way the owner
 * reaches it); then, with the reverse direction over that route too (E12, M8):
 *
 *   1. the pairback carries the joiner's routes of the link's kind and nothing off the route;
 *   2. on the owner, a tailnet route is dialled at once; any other kind waits on the owner's row as
 *      "Addresses <B> offered", and nothing is dialled before the owner taps Use;
 *   3. then the reverse connection works, and each row names the class it is connected on.
 *
 * Every connection must come up on the route under test (`conn.up.route`), else the run fails with
 * `route_mismatch`. The run also runs 1a's app cases over the route (`scripts/net-engine-check.mjs phase1b.routes-app
 * --route tcp|ws|ssh`). Its controls: `lan-only-candidates` (the app passes only LAN addresses: a join approves
 * none, and no pairing gets its other addresses or SSH route) leaves no connection on the route, which the kit
 * judges `route_mismatch` before the run's own `unreachable`; `route-leak` (routes other than the one under test, used first) with `route_mismatch`;
 * `plus-probe` and `egress-probe` with what the kit's egress guard records (`plus_contacted`,
 * `egress_attempted`), which this run records too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Run alone (the unit suite), the routes case is `tcp`.
  process.env.MOUSSE_NET_ENGINE_CHECK_ROUTE ||= 'tcp'
  process.env.MOUSSE_NET_ENGINE_PAIRING_RETRY_MS ||= '500'
})

import { parseRoute, routeClass } from '../../../src/shared/netEngine/routes'
import { loopbackClass } from '../../../src/mms/netEngine/routes'
import {
  approveAll,
  CHECK_ROUTE,
  connectedBothWays,
  deviceState,
  eventually,
  expectedRoute,
  Fabric,
  guardEgress,
  rowFor,
  step,
  type Computer
} from './harness'

// Over ssh nothing is advertised or shared: 1a's cases cover that route, each side holding the other's SSH route.
describe.skipIf(CHECK_ROUTE === 'ssh')('phase1b.routes-app', () => {
  const fabric = new Fabric()
  // This check taps Use itself.
  fabric.autoUse = false
  let owner: Computer
  beforeAll(async () => {
    guardEgress()
    owner = await fabric.computer('owner')
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  /** `caller` joins the owner's invitation through its window, sharing `share`. */
  async function join(caller: Computer, share: string[]) {
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    const preview = await step(undefined, () =>
      caller.dispatch('netEngine.join.preview', { ticket: invite.uri }, true)
    )
    const stop = approveAll(owner)
    try {
      await step('unreachable', () =>
        caller.dispatch('netEngine.join', { ticket: invite.uri, share }, true)
      )
    } finally {
      stop()
    }
    return preview as {
      destinations: Array<{ route: string; automatic: boolean }>
      sameWay?: Array<{ route: string }>
      shareable: Array<{ route: string }>
    }
  }

  /** A route that is not the route under test: another kind, or over tcp another class (LAN, say). */
  const offRoute = (route: string): boolean => {
    const expected = expectedRoute()!
    const kind = parseRoute(route)?.kind
    if ((kind === 'wss' ? 'ws' : kind) !== expected.kind) return true
    if (kind !== 'tcp') return false
    // The fake network's class for one of its routes; a loopback route the class its port maps to.
    const mapped = fabric.network?.classMap?.[route] ?? loopbackClass(route)
    return (mapped ?? 'lan') !== expected.class
  }

  /** The class this computer's app reads a route as: a loopback one by its mapped port, else by its address. */
  const appClass = (route: string): string | undefined => {
    const parsed = parseRoute(route)
    return parsed ? (loopbackClass(route) ?? routeClass(parsed)) : undefined
  }

  /** The routes of the pairbacks `from` sent so far. */
  const pairbacks = (from: Computer): string[][] =>
    fabric.crossed
      .filter((row) => row.from === from.endpoint && row.header.t === 'pairback')
      .map((row) => (row.header.routes as string[] | undefined) ?? [])

  it(`shares the way it was reached, holds other kinds until used, then connects both ways over ${CHECK_ROUTE}`, async () => {
    const expected = expectedRoute()!
    // 1. Both ways with nothing ticked: the joiner's own routes of the link's kind go back, nothing off the route.
    const joiner = await fabric.computer('joiner')
    const own = joiner.mms.netEngine.status().routes ?? []
    const preview = await join(joiner, [])
    await step('no_destinations', () => {
      expect(preview.destinations.length).toBeGreaterThan(0)
      expect(preview.destinations.some((item) => !item.automatic)).toBe(true)
      expect(preview.sameWay?.map((item) => item.route)).toEqual(expect.arrayContaining(own))
      for (const route of own) expect(preview.shareable.map((item) => item.route)).not.toContain(route)
    })
    // A route of another kind or class carried back (the `route-leak` control's listener) is off the route.
    await step('route_mismatch', async () => {
      await eventually(() => expect(pairbacks(joiner).length).toBeGreaterThan(0), 30_000)
      for (const routes of pairbacks(joiner)) expect(routes.filter(offRoute)).toEqual([])
    })
    await step('not_shared', async () => {
      await eventually(() => expect(pairbacks(joiner).length).toBeGreaterThan(0), 30_000)
      for (const routes of pairbacks(joiner)) expect(routes).toEqual(expect.arrayContaining(own))
    })

    // 2. A tailnet route is used at once; another kind waits on the owner's row until Use. The owner's app decides
    // by the address (a fake network's "public" one is still a tailnet address to it).
    const atOnce = own.every((route) => appClass(route) === 'tailnet')
    const onOwner = await step('not_offered', async () => {
      let node = ''
      await eventually(() => {
        const row = rowFor(owner, joiner)
        if (atOnce) expect(row?.addresses).toEqual(expect.arrayContaining(own))
        else expect(row?.offered).toEqual(own)
        node = row!.localId
      }, 30_000)
      return node
    })
    if (!atOnce) {
      await step('dialled_before_use', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        expect(owner.mms.netEngine.online(onOwner as never)).toBe(false)
        expect(deviceState(owner, onOwner as never)).not.toBe('connected')
      })
      await step(undefined, () => owner.dispatch('netEngine.address.use', { node: onOwner }, true))
    }

    // 3. The reverse connection comes up on the route, and each row names its class.
    await step('unreachable', () => connectedBothWays(owner, joiner))
    await step('route_mismatch', () => {
      const ownerRow = owner.mms.netEngine.status().devices.find((row) => row.node === onOwner)
      expect(ownerRow?.offered).toBeUndefined()
      expect(ownerRow?.route).toBe(expected.class)
      const joinerRow = joiner.mms.netEngine
        .status()
        .devices.find((row) => row.node === rowFor(joiner, owner)!.localId)
      expect(joinerRow?.route).toBe(expected.class)
    })
    // Every connection reported came up on the route under test (the watch records a mismatch as it comes).
    expect(fabric.routesSeen.length).toBeGreaterThan(0)
  }, 180_000)
})
