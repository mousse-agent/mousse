/**
 * Owner check `phase1b.routes-app`, its own cases (1b §14): over the route under test (`--route`; `tcp` when run
 * alone), the join dialog lists the ticket's destination with its class and offers this computer's route under
 * "Also share", unticked. Then, with the reverse direction over that route too (E12, M8):
 *
 *   1. nothing is disclosed before the joiner ticks "Also share": a pairback without it carries none of its routes;
 *   2. nothing is dialled before the receiving owner taps Use: a ticked route waits on the owner's row as
 *      "Addresses <B> offered";
 *   3. then the reverse connection works, and each row names the class it is connected on.
 *
 * Every connection must come up on the route under test (`conn.up.route`), else the run fails with
 * `route_mismatch`. The run also runs 1a's app cases over the route (`scripts/net-engine-check.mjs phase1b.routes-app
 * --route tcp|ws|ssh`). Its controls: `lan-only-candidates` (the joiner passes only LAN addresses) fails it with
 * `unreachable`; `route-leak` (routes other than the one under test, used first) with `route_mismatch`;
 * `plus-probe` and `egress-probe` with what the kit's egress guard records (`plus_contacted`,
 * `egress_attempted`), which this run records too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Run alone (the unit suite), the routes case is `tcp`.
  process.env.MOUSSE_NET_ENGINE_CHECK_ROUTE ||= 'tcp'
  process.env.MOUSSE_NET_ENGINE_PAIRING_RETRY_MS ||= '500'
})

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
      shareable: Array<{ route: string }>
    }
  }

  /** The routes of the pairbacks `from` sent so far. */
  const pairbacks = (from: Computer): string[][] =>
    fabric.crossed
      .filter((row) => row.from === from.endpoint && row.header.t === 'pairback')
      .map((row) => (row.header.routes as string[] | undefined) ?? [])

  it(`lists destinations, keeps routes back until shared and used, then connects both ways over ${CHECK_ROUTE}`, async () => {
    // 1. Without "Also share", the pairback carries none of the joiner's routes.
    const quiet = await fabric.computer('quiet')
    const preview = await join(quiet, [])
    const own = quiet.mms.netEngine.status().routes ?? []
    // The destination Connect approved, and the joiner's own route offered unticked.
    await step('no_destinations', () => {
      expect(preview.destinations.length).toBeGreaterThan(0)
      if (CHECK_ROUTE !== 'ssh') {
        expect(preview.destinations.some((item) => !item.automatic)).toBe(true)
        expect(preview.shareable.map((item) => item.route)).toEqual(expect.arrayContaining(own))
      }
    })
    await step('disclosed', async () => {
      await eventually(() => expect(pairbacks(quiet).length).toBeGreaterThan(0), 30_000)
      for (const routes of pairbacks(quiet))
        for (const route of own) expect(routes).not.toContain(route)
    })

    // 2. Ticked, the route waits on the owner's row until Use.
    const sharer = await fabric.computer('sharer')
    const share = sharer.mms.netEngine.shareable()
    await join(sharer, share)
    const onOwner = await step('not_offered', async () => {
      let node = ''
      await eventually(() => {
        const row = rowFor(owner, sharer)
        expect(row?.offered).toEqual(share)
        node = row!.localId
      }, 30_000)
      return node
    })
    await step('dialled_before_use', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(owner.mms.netEngine.online(onOwner as never)).toBe(false)
      expect(deviceState(owner, onOwner as never)).not.toBe('connected')
    })

    // 3. Use: the reverse connection comes up on the route, and each row names its class.
    await step(undefined, () => owner.dispatch('netEngine.address.use', { node: onOwner }, true))
    await step('unreachable', () => connectedBothWays(owner, sharer))
    const expected = expectedRoute()!
    await step('route_mismatch', () => {
      const ownerRow = owner.mms.netEngine.status().devices.find((row) => row.node === onOwner)
      expect(ownerRow?.offered).toBeUndefined()
      expect(ownerRow?.route).toBe(expected.class)
      const sharerRow = sharer.mms.netEngine
        .status()
        .devices.find((row) => row.node === rowFor(sharer, owner)!.localId)
      expect(sharerRow?.route).toBe(expected.class)
    })
    // Every connection reported came up on the route under test (the watch records a mismatch as it comes).
    expect(fabric.routesSeen.length).toBeGreaterThan(0)
  }, 180_000)
})
