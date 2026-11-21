/**
 * This computer's routes and the owner's addresses over a protocol 1.1 helper (1b §1.3, §1.5), through the
 * Settings window's daemon calls: Reach saves `routes.config` and restarts the helper only when it needs new
 * listeners; Test runs `routes.test`; Add address takes every owner kind but SSH, and Remove drops one. A 1.0
 * helper keeps 1a's private-only rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventually, Fabric, type Computer } from './checks/harness'

describe('Reach and owner addresses (protocol 1.1)', () => {
  const fabric = new Fabric()
  let a: Computer, b: Computer
  let bOnA = ''
  beforeAll(async () => {
    fabric.network.minor = 1
    for (const name of ['a', 'b']) {
      const identity = Buffer.from(`endpoint-${name}`).toString('hex')
      fabric.network.routes.set(identity, [`tcp://192.168.60.${name === 'a' ? 1 : 2}:47100`])
      fabric.network.ports.set(identity, 47100)
    }
    a = await fabric.computer('a')
    b = await fabric.computer('b')
    ;({ callerOnOwner: bOnA } = await fabric.pair(a, b))
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  const reach = (computer: Computer) => computer.mms.netEngine.status().reach!

  it('restarts the helper for the first tunnel, not for a changed one, and advertises what was saved', async () => {
    expect(reach(a)).toMatchObject({ lan: true, tailnet: false, tunnels: [] })
    const first = a.engine
    const saved = await a.dispatch(
      'netEngine.routes.config',
      { tunnels: ['https://one.example'] },
      true
    )
    expect(saved.restarted).toBe(true)
    await eventually(() => expect(a.mms.netEngine.currentHelper()).not.toBe(first))
    await eventually(() => expect(a.mms.netEngine.helperStatus().state).toBe('running'))
    a.engine = a.mms.netEngine.currentHelper()!
    expect(reach(a).tunnels).toEqual(['wss://one.example/mousse-net/1'])
    expect(reach(a).wsPort).toBeTypeOf('number')
    expect(a.mms.netEngine.status().routes).toContain('wss://one.example/mousse-net/1')

    const second = a.engine
    const changed = await a.dispatch(
      'netEngine.routes.config',
      { tunnels: ['https://two.example'] },
      true
    )
    expect(changed.restarted).toBe(false)
    expect(a.mms.netEngine.currentHelper()).toBe(second)
    expect(a.mms.netEngine.status().routes).toContain('wss://two.example/mousse-net/1')
    expect(a.mms.netEngine.status().routes).not.toContain('wss://one.example/mousse-net/1')
    // The tunnel is now something a joiner here may share.
    expect(a.mms.netEngine.shareable()).toEqual(['wss://two.example/mousse-net/1'])
  }, 60_000)

  it('refuses a Reach value that is not an address of its kind before the helper hears it', async () => {
    await expect(
      a.dispatch('netEngine.routes.config', { tunnels: ['ftp://x.example'] }, true)
    ).rejects.toMatchObject({ details: { reason: 'bad_tunnel' } })
    await expect(
      a.dispatch('netEngine.routes.config', { public: ['192.168.1.2:47100'] }, true)
    ).rejects.toMatchObject({ details: { reason: 'bad_public' } })
  })

  it('tests its own routes', async () => {
    expect(
      await a.dispatch('netEngine.routes.test', { route: 'https://two.example' }, true)
    ).toEqual({ ok: true, ms: 1 })
    expect(
      await a.dispatch('netEngine.routes.test', { route: 'tcp://100.101.9.9:47100' }, true)
    ).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('adds a tailnet address and a tunnel URL as owner addresses, refuses SSH, and removes one', async () => {
    await b.dispatch(
      'netEngine.address.add',
      { node: rowOf(b, a), address: '100.101.7.2:47100' },
      true
    )
    await b.dispatch(
      'netEngine.address.add',
      { node: rowOf(b, a), address: 'https://two.example' },
      true
    )
    expect(b.fake!.addresses.get(a.endpoint)).toEqual([
      'tcp://100.101.7.2:47100',
      'wss://two.example/mousse-net/1'
    ])
    await expect(
      b.dispatch('netEngine.address.add', { node: rowOf(b, a), address: 'me@box.example' }, true)
    ).rejects.toMatchObject({ message: 'Use Add over SSH for an SSH address.' })
    await b.dispatch(
      'netEngine.address.remove',
      { node: rowOf(b, a), address: 'tcp://100.101.7.2:47100' },
      true
    )
    expect(b.fake!.addresses.get(a.endpoint)).toEqual(['wss://two.example/mousse-net/1'])
    const device = b.mms.netEngine.status().devices.find((row) => row.node === rowOf(b, a))
    expect(device?.addresses).toEqual(['wss://two.example/mousse-net/1'])
    // Connected over the LAN route: the row says so.
    expect(device?.route).toBe('lan')
    expect(bOnA).toBeTruthy()
  })
})

const rowOf = (on: Computer, other: Computer): string =>
  on.mms.netEngine.peerRows().find((row) => row.endpoint === other.endpoint)!.localId
