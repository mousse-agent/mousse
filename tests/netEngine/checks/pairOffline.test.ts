/**
 * Owner check `phase1a.pair-offline`, a cross-machine cell (`pc-to-mac-lan`): with the internet unreachable from
 * both computers, the caller (the PC) joins the host's (the Mac's) invitation over the local network, the host's
 * Yes injected through the test link (`./link`), and both rows read Connected, each computer having dialed the
 * other, within the bound from the join: 10 s by default, `MOUSSE_NET_ENGINE_CHECK_PAIR_WITHIN_MS` to change it.
 *
 * Both computers look for the internet first: either one reaching a public address fails the run with
 * `internet_reachable`. Its control, `cable-plugged`, runs with the WAN cable in: the harness must see it.
 * `MOUSSE_NET_ENGINE_CHECK_PAIR_ONLINE=1` pairs anyway, for a look; the run still fails with that reason.
 *
 * `scripts/net-engine-check.mjs phase1a.pair-offline --role host` on the Mac, `--role caller` on the PC (with
 * `MOUSSE_NET_ENGINE_CHECK_HOST` the Mac's address) run it with the real helper. Without a role, both sides run here
 * on one fabric and nobody looks for the internet.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { codeOf, Fabric, REAL_HELPER, recordedReason, step, type Computer } from './harness'
import {
  bothConnected,
  dialLink,
  hostSide,
  internetReached,
  keepHostBuilds,
  linkRole,
  localLink,
  serveLink,
  type Link
} from './link'

const ROLE = linkRole()
/** The check's bound: connected both ways this soon after the join. */
const WITHIN_MS = Number(process.env.MOUSSE_NET_ENGINE_CHECK_PAIR_WITHIN_MS || 10_000)
const RUN_MS = 40 * 60_000

const fail = (reason: string, message: string) =>
  step(reason, () => {
    throw new Error(message)
  })

describe('phase1a.pair-offline', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 120_000)

  async function hostComputers(): Promise<Map<string, Computer>> {
    return new Map([['mac', await step(undefined, () => fabric.computer('mac'))]])
  }

  it.runIf(ROLE === 'host')(
    'hosts the pairing',
    async () => {
      if (!REAL_HELPER) await fail('no_helper', 'a cross-machine cell runs with MOUSSE_NET_HELPER')
      const reason = await serveLink(hostSide(fabric, await hostComputers(), true))
      if (reason) await fail(reason, `the caller failed: ${reason}`)
    },
    RUN_MS
  )

  it.runIf(ROLE !== 'host')(
    `pairs over the local network, connected both ways in under ${WITHIN_MS} ms`,
    async () => {
      if (ROLE && !REAL_HELPER)
        await fail('no_helper', 'a cross-machine cell runs with MOUSSE_NET_HELPER')
      const link: Link =
        ROLE === 'caller'
          ? await step(undefined, () => dialLink())
          : localLink(hostSide(fabric, await hostComputers(), false))
      try {
        await pairOffline(link)
      } finally {
        await link.done(recordedReason())
      }
    },
    RUN_MS
  )

  async function pairOffline(link: Link): Promise<void> {
    const hello = await step(undefined, () => link.ask('hello'))
    if (ROLE) keepHostBuilds(hello)
    let online: string | undefined
    if (ROLE) {
      const here = await internetReached()
      if (here || hello.online)
        online = `the internet is reachable: ${here ? `this computer reaches ${here}` : `the host reaches ${hello.online}`}`
      if (online && process.env.MOUSSE_NET_ENGINE_CHECK_PAIR_ONLINE !== '1')
        await fail('internet_reachable', online)
      if (online) console.log(`${online}; pairing anyway`)
    }
    const pc = await step(undefined, () => fabric.computer('pc'))
    const ticket = await step(undefined, () => link.ask('invite', { name: 'mac' }))
    const started = Date.now()
    const joined = await step('not_paired', () =>
      pc.dispatch('netEngine.join', { ticket }, true).catch((error: unknown) => {
        throw Object.assign(new Error(`join: ${String(error)}`), { code: codeOf(error) })
      })
    )
    const there = { name: 'mac', endpoint: pc.endpoint }
    await step('one_way_stuck', () => bothConnected(link, pc, joined.node, 'mac'))
    // Each computer dials the other.
    await step('one_way_stuck', () => fabric.connect(pc, joined.node))
    await step('one_way_stuck', () => link.ask('dial', there))
    const took = Date.now() - started
    console.log(`connected both ways ${took} ms after the join`)
    await step('slow_pairing', () => expect(took).toBeLessThan(WITHIN_MS))
    if (online) await fail('internet_reachable', online)
  }
})
