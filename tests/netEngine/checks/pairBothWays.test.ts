/**
 * Owner check `phase1a.pair-both-ways`: two fresh computers pair through their windows (§5.1). The caller's window
 * joins the owner's invitation, the owner's says Yes, and each row reads Connected only once both directions work.
 * Then the same ceremony is stopped, as a crash would stop it, at each of its steps on either computer; the stopped
 * computer starts again and the pairing finishes both ways from its journal, and meanwhile nothing removes the half
 * that is done.
 *
 * Its control (`MOUSSE_NET_ENGINE_CONTROL=no-consent-journal`) writes nothing before `join`, so a crash after the
 * host said yes loses the joiner's half: it fails with `one_way_stuck`. `scripts/net-engine-check.mjs
 * phase1a.pair-both-ways` runs it and prints the marker.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { PairingStep } from '../../../src/mms/netEngine/pairing'
import {
  approveAll,
  connectedBothWays,
  connectedWhole,
  deviceState,
  Fabric,
  CHECK_ROUTE,
  ONE_WAY,
  REAL_HELPER,
  rowFor,
  step,
  type Computer
} from './harness'

describe('phase1a.pair-both-ways', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 120_000)

  /** Whether `on`'s helper still lets `other` in (its grant is there). */
  async function grantHeld(on: Computer, other: Computer): Promise<boolean> {
    const answer = await on.engine.request('grants.list')
    return (answer.grants as Array<{ identity: string }>).some(
      (grant) => grant.identity === other.endpoint
    )
  }

  it('pairs both ways through the windows, Connected only when both directions work', async () => {
    const owner = await fabric.computer('owner'),
      caller = await fabric.computer('caller')
    // Each row reads Connected only with its own client ready (the other direction answered).
    const sawConnected: string[] = []
    const watch = setInterval(() => {
      for (const [on, other] of [
        [owner, caller],
        [caller, owner]
      ] as const) {
        const row = rowFor(on, other)
        if (row && deviceState(on, row.localId) === 'connected' && row.state !== 'connected')
          sawConnected.push(`${on.name}:${row.state}`)
      }
    }, 10)
    try {
      await step('one_way_stuck', () => fabric.pair(owner, caller))
    } finally {
      clearInterval(watch)
    }
    await step('false_connected', () => expect(sawConnected).toEqual([]))
    await bothGrants(owner, caller)
  }, 120_000)

  /**
   * The owner lets the caller in, and the caller the owner; over ssh with the real helper the pairing is Add over
   * SSH, one way (1b §3.6), and the caller holds no grant for the owner.
   */
  async function bothGrants(owner: Computer, caller: Computer): Promise<void> {
    await step('one_way_stuck', async () => expect(await grantHeld(owner, caller)).toBe(true))
    await step(ONE_WAY ? 'two_way' : 'one_way_stuck', async () =>
      expect(await grantHeld(caller, owner)).toBe(!ONE_WAY)
    )
  }

  // A real helper lists the addresses of the computer it runs on; this one has a tailnet's too.
  // A routes run gives each computer only the route under test, never this one's own addresses.
  it.skipIf(REAL_HELPER || !!CHECK_ROUTE)(
    'pairs both ways when the caller also listens on an address outside a private range',
    async () => {
      fabric.network.routes.set(Buffer.from('endpoint-tailnet-caller').toString('hex'), [
        'tcp://100.89.27.27:52862',
        'tcp://192.168.0.59:52862'
      ])
      const owner = await fabric.computer('tailnet-owner'),
        caller = await fabric.computer('tailnet-caller')
      await step('one_way_stuck', () => fabric.pair(owner, caller))
    },
    120_000
  )

  it('pairs both ways again after the owner removed the caller', async () => {
    const owner = await fabric.computer('owner-again'),
      caller = await fabric.computer('caller-again')
    const first = await fabric.pair(owner, caller)
    await owner.dispatch('netEngine.remove', { node: first.callerOnOwner }, true)
    // The caller keeps its row of the first pairing; joining again replays its grant and its pairback on it.
    const again = await step('one_way_stuck', () => fabric.pair(owner, caller))
    expect(again.callerOnOwner).not.toBe(first.callerOnOwner)
    // Over Add over SSH the new add's row takes the place of the one the owner removed.
    if (!ONE_WAY) expect(again.ownerOnCaller).toBe(first.ownerOnCaller)
    await bothGrants(owner, caller)
  }, 180_000)

  const stops: Array<{ at: PairingStep; on: 'owner' | 'caller' }> = [
    { at: 'consented', on: 'caller' },
    { at: 'join-replied', on: 'caller' },
    { at: 'joined', on: 'caller' },
    { at: 'granted', on: 'caller' },
    { at: 'enrolled', on: 'owner' },
    { at: 'pairback', on: 'owner' }
  ]
  // The window ceremony never runs over ssh (a ticket carries no ssh route): Add over SSH's own stops are
  // ssh-add-app's.
  for (const { at, on } of stops)
    it.skipIf(ONE_WAY)(
      `finishes after the ${on} stops at ${at}`,
      async () => {
        const owner = await fabric.computer(`owner-${at}`),
          caller = await fabric.computer(`caller-${at}`)
        const stopped = on === 'owner' ? owner : caller,
          other = on === 'owner' ? caller : owner
        let hit = false
        stopped.mms.netEngine.pairingCrash = (step) => {
          if (step !== at || hit) return false
          hit = true
          return true
        }
        const invite = await owner.dispatch('netEngine.invite', {}, true)
        const stopApproving = approveAll(owner)
        try {
          // The join itself may end with the stop.
          await caller
            .dispatch('netEngine.join', { ticket: invite.uri }, true)
            .catch(() => undefined)
          await step(undefined, () =>
            expect.poll(() => hit, { timeout: 60_000, interval: 50 }).toBe(true)
          )
          // While the stopped computer is down, the half that is done stays, and neither row reads Connected both
          // ways (the owner's may read Connected for the one direction it has: the caller uses it).
          await new Promise((resolve) => setTimeout(resolve, 1_500))
          await step('false_connected', () => {
            for (const [a, b] of [
              [owner, caller],
              [caller, owner]
            ] as const) {
              const row = rowFor(a, b)
              if (row) expect(connectedWhole(a, row.localId)).toBe(false)
            }
          })
          await step('auto_removed', async () => {
            const row = rowFor(other, stopped)
            if (row) expect(row.state).not.toMatch(/^remov/)
            if (other === owner && row) expect(await grantHeld(owner, caller)).toBe(true)
          })
          stopped.mms.netEngine.pairingCrash = undefined
          await step(undefined, () => fabric.restartEngine(stopped))
          await step('one_way_stuck', () => connectedBothWays(owner, caller, 60_000))
        } finally {
          stopApproving()
        }
        await step('one_way_stuck', async () => {
          expect(await grantHeld(owner, caller)).toBe(true)
          expect(await grantHeld(caller, owner)).toBe(true)
        })
      },
      180_000
    )
})
