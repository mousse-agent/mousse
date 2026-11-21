/**
 * Add over SSH is route setup whichever way it goes (1b §14): the routes checks' egress controls run their probe
 * also when the computer is paired already and only gets its SSH route.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

const probes = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../src/mms/netEngine/probes', () => ({
  routeSetupProbes: () => {
    probes.count += 1
  }
}))

import { Fabric } from './checks/harness'

describe('Add over SSH of a computer paired already', () => {
  const fabric = new Fabric()
  fabric.network.minor = 1
  afterAll(() => fabric.close(), 120_000)

  it('runs the route-setup probes', async () => {
    // Both on the test LAN, where their 1a pairing goes.
    for (const [name, at] of [['b', 1], ['a', 2]] as const)
      fabric.network.routes.set(Buffer.from(`endpoint-${name}`).toString('hex'), [
        `tcp://192.168.71.${at}:47100`
      ])
    const b = await fabric.computer('b')
    const a = await fabric.computer('a')
    await fabric.sshServer('b.test', b)
    // A pairs with B the 1a way first.
    await fabric.pair(b, a)
    const resolved = await a.dispatch('netEngine.ssh.resolve', { target: 'me@b.test' }, true)
    const probe = await a.dispatch('netEngine.ssh.probe', { routeId: resolved.routeId, host: 'b.test' }, true)
    await a.dispatch(
      'netEngine.ssh.trust',
      { routeId: resolved.routeId, sha256: probe.sha256, host: 'b.test' },
      true
    )
    const list = await a.dispatch(
      'netEngine.ssh.profiles',
      { routeId: resolved.routeId, host: 'b.test', user: 'me' },
      true
    )
    const known = (list.profiles as Array<{ selector: string; identity?: string }>).find(
      (profile) => profile.identity === b.endpoint
    )!
    const before = probes.count
    await a.dispatch(
      'netEngine.ssh.connect',
      { routeId: resolved.routeId, target: 'me@b.test', host: 'b.test', user: 'me', selector: known.selector },
      true
    )
    // Paired already: the row only took the SSH route.
    expect(a.mms.netEngine.peerRows().find((row) => row.endpoint === b.endpoint)?.ssh?.routeId).toBe(
      resolved.routeId
    )
    expect(probes.count).toBeGreaterThan(before)
  }, 120_000)
})
