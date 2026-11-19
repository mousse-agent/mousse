/**
 * Relays through the Settings window's daemon calls (Phase 3 §B.5, §B.9, §B.11), over the fake helper: Your own
 * relay (paste a link, the state the helper reports, New relay key, Remove), a host's relay route waiting for
 * Allow and taken back, its stale relay info, the 256-caller limit, the "Through relay" route, and a ticket's relay
 * hint approved at Connect. A helper without relays shows none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FakeRelays } from './fakeHelper'
import { eventually, Fabric, type Computer } from './checks/harness'

const ID = 'A'.repeat(43)
const LINK = `mousse-relay://relay.example.net:443/#${ID}.${'C'.repeat(22)}`
const RELAY_ID = Buffer.from(ID, 'base64url').toString('hex')
const DESTINATION = 'relay://relay.example.net:443'
const HINT = `relay://relay.example.net:443/${ID}/${'B'.repeat(43)}`

const identity = (name: string) => Buffer.from(`endpoint-${name}`).toString('hex')
const relays = (): FakeRelays => ({ available: true, relays: [], peers: new Map(), grants: new Map() })

describe('relays (Phase 3)', () => {
  const fabric = new Fabric()
  let a: Computer, b: Computer, c: Computer
  let aOnB = '',
    bOnA = ''
  const aRelays = relays(),
    bRelays = relays()
  beforeAll(async () => {
    fabric.network.minor = 1
    for (const name of ['a', 'b']) {
      fabric.network.routes.set(identity(name), [`tcp://192.168.61.${name === 'a' ? 1 : 2}:47100`])
      fabric.network.ports.set(identity(name), 47100)
    }
    // A's ticket carries its relay; every dial to A comes up through it.
    fabric.network.routes.get(identity('a'))!.push(HINT)
    fabric.network.relayed.set(identity('a'), DESTINATION)
    fabric.network.relays.set(identity('a'), aRelays)
    fabric.network.relays.set(identity('b'), bRelays)
    a = await fabric.computer('a')
    b = await fabric.computer('b')
    c = await fabric.computer('c')
    ;({ callerOnOwner: bOnA, ownerOnCaller: aOnB } = await fabric.pair(a, b))
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  const device = (on: Computer, node: string) =>
    on.mms.netEngine.status().devices.find((row) => row.node === node)

  it('approves the ticket’s relay at Connect, and names the relay a connection runs through', async () => {
    const join = b.fake!.requests.find((request) => request.op === 'join')
    expect(join?.approved).toContain(DESTINATION)
    expect(b.mms.netEngine.joinPreview(join!.ticket).destinations).toContainEqual(
      expect.objectContaining({ cls: 'relay', label: 'relay.example.net:443' })
    )
    await eventually(() =>
      expect(device(b, aOnB)).toMatchObject({ route: 'relay', via: 'relay.example.net:443' })
    )
  })

  it('adds its own relay from a pasted link, follows its state, makes a new key and removes it', async () => {
    expect(a.mms.netEngine.status().relays).toEqual({ available: true, list: [] })
    await expect(
      a.dispatch('netEngine.relay.enroll', { link: 'https://relay.example.net' }, true)
    ).rejects.toMatchObject({ details: { reason: 'bad_link' } })
    expect(a.fake!.requests.some((request) => request.op === 'relay.enroll')).toBe(false)

    await a.dispatch('netEngine.relay.enroll', { link: ` ${LINK} ` }, true)
    expect(a.fake!.requests.find((request) => request.op === 'relay.enroll')?.link).toBe(LINK)
    expect(a.mms.netEngine.status().relays!.list).toEqual([
      expect.objectContaining({ id: RELAY_ID, endpoint: 'relay.example.net:443', state: 'registered' })
    ])

    const before = Date.now()
    // As the helper: the state is kept (`relay.list` says it too), then the event goes out.
    Object.assign(aRelays.relays[0]!, { state: 'retrying', reason: 'relay_unreachable', retry_ms: 30_000 })
    a.fake!.emit({ ev: 'relay.state', relay: aRelays.relays[0] })
    await eventually(() =>
      expect(a.mms.netEngine.status().relays!.list[0]).toMatchObject({
        state: 'retrying',
        reason: 'relay_unreachable'
      })
    )
    const retryAt = a.mms.netEngine.status().relays!.list[0]!.retryAt!
    expect(retryAt).toBeGreaterThanOrEqual(before + 30_000)
    expect(retryAt).toBeLessThan(Date.now() + 30_001)

    Object.assign(aRelays.relays[0]!, { state: 'registered', reason: null, retry_ms: null })
    a.fake!.emit({ ev: 'relay.state', relay: aRelays.relays[0] })
    await eventually(() => expect(a.mms.netEngine.status().relays!.list[0]!.state).toBe('registered'))
    await a.dispatch('netEngine.relay.rotate', { relay: RELAY_ID }, true)
    expect(a.mms.netEngine.status().relays!.list[0]!.rotatingUntil).toBeGreaterThan(Date.now())

    await a.dispatch('netEngine.relay.remove', { relay: RELAY_ID }, true)
    expect(a.fake!.requests.filter((request) => request.op === 'relay.remove')).toEqual([
      expect.objectContaining({ relay: RELAY_ID })
    ])
    expect(a.mms.netEngine.status().relays!.list).toEqual([])
  })

  it('says why a link was refused', async () => {
    aRelays.enrollError = 'relay_not_authorized'
    try {
      await expect(a.dispatch('netEngine.relay.enroll', { link: LINK }, true)).rejects.toMatchObject({
        message: 'This link was used already, or has expired.',
        details: { reason: 'relay_not_authorized' }
      })
    } finally {
      delete aRelays.enrollError
    }
  })

  it('asks before dialling a host’s offered relay, and Allow and its removal go to the helper', async () => {
    bRelays.peers.set(a.endpoint, {
      routes: [{ destination: DESTINATION, relay: RELAY_ID, from: 'manifest', approved: false, source: null }],
      manifest: { sequence: 1, issued_at: 1, expires_at: Math.floor(Date.now() / 1000) + 3600, stale: false },
      keys: true,
      caller: null
    })
    b.fake!.emit({ ev: 'peer.relay.offered', identity: a.endpoint, destination: DESTINATION })
    await eventually(() => expect(device(b, aOnB)?.relay).toEqual({ offered: [DESTINATION] }))

    await b.dispatch('netEngine.relay.allow', { node: aOnB, destination: DESTINATION }, true)
    expect(b.fake!.requests.filter((request) => request.op === 'peer.relay.allow')).toEqual([
      expect.objectContaining({ identity: a.endpoint, destination: DESTINATION })
    ])
    await eventually(() => expect(device(b, aOnB)?.relay).toEqual({ allowed: [DESTINATION] }))

    await b.dispatch('netEngine.relay.disallow', { node: aOnB, destination: DESTINATION }, true)
    expect(b.fake!.requests.filter((request) => request.op === 'peer.relay.disallow')).toEqual([
      expect.objectContaining({ identity: a.endpoint, destination: DESTINATION })
    ])
    await eventually(() => expect(device(b, aOnB)?.relay).toEqual({ offered: [DESTINATION] }))
  })

  it('marks a host’s relay info out of date once its manifest expires', async () => {
    bRelays.peers.get(a.endpoint)!.manifest = {
      sequence: 2,
      issued_at: 1,
      expires_at: Math.floor(Date.now() / 1000) - 1,
      stale: true
    }
    b.fake!.emit({ ev: 'peer.manifest', identity: a.endpoint, manifest: bRelays.peers.get(a.endpoint)!.manifest })
    await eventually(() => expect(device(b, aOnB)?.relay?.stale).toBe(true))
  })

  it('says a device past the 256-caller limit can’t come through the relay', async () => {
    expect(device(a, bOnA)?.relay?.limit).toBeUndefined()
    aRelays.grants.set(b.endpoint, 'limit')
    a.fake!.emit({ ev: 'peer.keys', identity: b.endpoint })
    await eventually(() => expect(device(a, bOnA)?.relay).toEqual({ limit: true }))
  })

  it('shows no relays from a helper without them, and refuses relay calls there', async () => {
    expect(c.mms.netEngine.status().relays).toBeUndefined()
    await expect(c.dispatch('netEngine.relay.enroll', { link: LINK }, true)).rejects.toMatchObject({
      details: { reason: 'no_relays' }
    })
  })
})
