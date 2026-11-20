/**
 * Relays through the Settings window's daemon calls (Phase 3 §B.5, §B.9, §B.11), over the fake helper: Your own
 * relay (paste a link, the state the helper reports, New relay key, Remove), a host's relay route waiting for
 * Allow and taken back, its stale relay info, the 256-caller limit, the "Through relay" route, and a ticket's relay
 * hint approved at Connect. A helper without relays shows none.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    // The answer comes while the new key is pending; when the old key stops arrives with the relay's next state.
    expect(a.mms.netEngine.status().relays!.list[0]).toMatchObject({ newKeyPending: true })
    expect(a.mms.netEngine.status().relays!.list[0]!.rotatingUntil).toBeUndefined()
    // Cancel while pending: the helper is told, and the row says it is cancelling.
    await a.dispatch('netEngine.relay.rotate', { relay: RELAY_ID, cancel: true }, true)
    expect(a.fake!.requests.filter((request) => request.op === 'relay.rotate').at(-1)).toMatchObject({
      relay: RELAY_ID,
      cancel: true
    })
    expect(a.mms.netEngine.status().relays!.list[0]).toMatchObject({ newKeyPending: true, cancelling: true })
    // The relay had taken the key already sent: it is committed.
    Object.assign(aRelays.relays[0]!, {
      new_key_pending: false,
      cancelling: false,
      rotating_until: Math.floor(Date.now() / 1000) + 3600
    })
    a.fake!.emit({ ev: 'relay.state', relay: aRelays.relays[0] })
    await eventually(() =>
      expect(a.mms.netEngine.status().relays!.list[0]!.rotatingUntil).toBeGreaterThan(Date.now())
    )
    expect(a.mms.netEngine.status().relays!.list[0]!.newKeyPending).toBeUndefined()
    expect(a.mms.netEngine.status().relays!.list[0]!.cancelling).toBeUndefined()

    // A full key chain: no new key until the time the helper names, and a refusal in words meanwhile.
    const chainUntil = Math.floor(Date.now() / 1000) + 7200
    Object.assign(aRelays.relays[0]!, { chain_full: true, chain_full_until: chainUntil })
    a.fake!.emit({ ev: 'relay.state', relay: aRelays.relays[0] })
    await eventually(() =>
      expect(a.mms.netEngine.status().relays!.list[0]).toMatchObject({
        chainFull: true,
        chainFullUntil: chainUntil * 1000
      })
    )
    await expect(a.dispatch('netEngine.relay.rotate', { relay: RELAY_ID }, true)).rejects.toMatchObject({
      message: 'Too many key changes. Try again later.',
      details: { reason: 'chain_full' }
    })
    // Once that time has passed, the chain no longer holds New relay key back.
    Object.assign(aRelays.relays[0]!, { chain_full_until: Math.floor(Date.now() / 1000) - 1 })
    a.fake!.emit({ ev: 'relay.state', relay: aRelays.relays[0] })
    await eventually(() => expect(a.mms.netEngine.status().relays!.list[0]!.chainFull).toBeUndefined())
    Object.assign(aRelays.relays[0]!, { chain_full: false, chain_full_until: null })

    await a.dispatch('netEngine.relay.remove', { relay: RELAY_ID }, true)
    expect(a.fake!.requests.filter((request) => request.op === 'relay.remove')).toEqual([
      expect.objectContaining({ relay: RELAY_ID })
    ])
    expect(a.mms.netEngine.status().relays!.list).toEqual([])
  }, 60_000)

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

  const route = (destination: string, approved = false) => ({
    destination,
    relay: RELAY_ID,
    from: 'manifest',
    approved,
    source: approved ? 'manifest' : null
  })
  const offer = (destinations: string[], manifest: Record<string, unknown> = { sequence: 1, issued_at: 1, expires_at: Math.floor(Date.now() / 1000) + 3600, stale: false }) => {
    bRelays.peers.set(a.endpoint, { routes: destinations.map((d) => route(d)), manifest, keys: true, caller: null })
    for (const destination of destinations)
      b.fake!.emit({ ev: 'peer.relay.offered', identity: a.endpoint, destination })
  }
  const OTHER = 'relay://relay2.example.org:8443'

  it('asks before dialling a host’s offered relay; Allow, and Stop using relay, go to the helper', async () => {
    offer([DESTINATION])
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
    // Stopping is the owner's answer: the row does not ask about that relay again, even after the app restarts.
    b.fake!.emit({ ev: 'peer.relay.offered', identity: a.endpoint, destination: DESTINATION })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(device(b, aOnB)?.relay).toBeUndefined()
  })

  it('refuses Allow for a relay the host does not offer', async () => {
    const before = b.fake!.requests.length
    await expect(
      b.dispatch('netEngine.relay.allow', { node: aOnB, destination: 'relay://elsewhere.example:443' }, true)
    ).rejects.toMatchObject({ details: { reason: 'not_offered' } })
    expect(b.fake!.requests.slice(before).some((request) => request.op === 'peer.relay.allow')).toBe(false)
  })

  it('takes Not now for good, and asks about a few relays at a time', async () => {
    const many = [OTHER, 'relay://r3.example:443', 'relay://r4.example:443', 'relay://r5.example:443', 'relay://r6.example:443']
    offer([DESTINATION, ...many])
    // DESTINATION was stopped above; of the rest, three at a time.
    await eventually(() => expect(device(b, aOnB)?.relay?.offered).toEqual(many.slice(0, 3)))
    await b.dispatch('netEngine.relay.dismiss', { node: aOnB, destination: OTHER }, true)
    expect(device(b, aOnB)?.relay?.offered).toEqual(many.slice(1, 4))
    expect(b.fake!.requests.some((request) => request.op === 'peer.relay.allow' && request.destination === OTHER)).toBe(false)
    await fabric.restartEngine(b)
    await eventually(() => expect(device(b, aOnB)?.relay?.offered).toEqual(many.slice(1, 4)))
  }, 60_000)

  it('reads each changed list once for a burst of relay events', async () => {
    const before = b.fake!.requests.length
    for (let i = 0; i < 5; i++) b.fake!.emit({ ev: 'peer.relay.offered', identity: a.endpoint, destination: OTHER })
    b.fake!.emit({ ev: 'peer.keys', identity: a.endpoint })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const ops = b.fake!.requests.slice(before).map((request) => request.op)
    expect(ops.filter((op) => op === 'peers.list')).toHaveLength(1)
    expect(ops.filter((op) => op === 'grants.list')).toHaveLength(1)
    expect(ops.filter((op) => op === 'relay.list')).toHaveLength(0)
  })

  it('marks a host’s relay info out of date when it expires by its own clock, and wakes the windows then', async () => {
    // The helper still says fresh: the app decides from expires_at.
    const expiresAt = Math.floor(Date.now() / 1000) + 3 * 86_400
    bRelays.peers.get(a.endpoint)!.manifest = { sequence: 2, issued_at: 1, expires_at: expiresAt, stale: false }
    b.fake!.emit({ ev: 'peer.manifest', identity: a.endpoint, manifest: bRelays.peers.get(a.endpoint)!.manifest })
    await eventually(() =>
      expect(b.fake!.requests.filter((request) => request.op === 'peers.list').length).toBeGreaterThan(0)
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(device(b, aOnB)?.relay?.stale).toBeUndefined()

    // Ten seconds before the expiry (by a fake clock), the status schedules the windows' next read for it.
    vi.useFakeTimers({ toFake: ['Date'] })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      vi.setSystemTime(expiresAt * 1000 - 10_000)
      b.mms.netEngine.status()
      expect(device(b, aOnB)?.relay?.stale).toBeUndefined()
      const call = timers.mock.calls.find(([, ms]) => typeof ms === 'number' && ms >= 10_000 && ms <= 11_000)
      expect(call).toBeDefined()
      timers.mockRestore()

      // When it fires, past the expiry, the windows read again and the row says so.
      vi.setSystemTime(expiresAt * 1000 + 1_000)
      const told = b.events.filter((event) => JSON.stringify(event).includes('"net-engine"')).length
      ;(call![0] as () => void)()
      expect(b.events.filter((event) => JSON.stringify(event).includes('"net-engine"')).length).toBeGreaterThan(told)
      expect(device(b, aOnB)?.relay?.stale).toBe(true)
    } finally {
      timers.mockRestore()
      vi.useRealTimers()
    }
  })

  it('says a device past the relay limit can’t come through it, with the limit the helper names', async () => {
    expect(device(a, bOnA)?.relay?.limit).toBeUndefined()
    aRelays.grants.set(b.endpoint, 'limit')
    a.fake!.emit({ ev: 'peer.keys', identity: b.endpoint })
    // No relay of A's names a limit yet: none is assumed.
    await eventually(() => expect(device(a, bOnA)?.relay).toEqual({ limit: {} }))
    await a.dispatch('netEngine.relay.enroll', { link: `mousse-relay://relay3.example:443/#${'E'.repeat(43)}.${'C'.repeat(22)}` }, true)
    aRelays.relays[aRelays.relays.length - 1]!.callers_max = 128
    a.fake!.emit({ ev: 'relay.state', relay: aRelays.relays[aRelays.relays.length - 1] })
    await eventually(() => expect(device(a, bOnA)?.relay).toEqual({ limit: { callersMax: 128 } }))
  }, 60_000)

  it('says a fixed line for a refusal it has no words for, never the helper’s reason', async () => {
    aRelays.enrollError = 'relay_new_thing'
    try {
      await expect(a.dispatch('netEngine.relay.enroll', { link: LINK }, true)).rejects.toMatchObject({
        message: "The relay request didn't go through.",
        details: { reason: 'relay_new_thing' }
      })
    } finally {
      delete aRelays.enrollError
    }
  })

  it('asks a helper that is still starting for its relays again, a bounded number of times', async () => {
    fabric.network.relays.set(identity('d'), { ...relays(), listFailures: 2 })
    fabric.network.relays.set(identity('e'), { ...relays(), listFailures: 1_000 })
    const d = await fabric.computer('d')
    const e = await fabric.computer('e')
    await eventually(() => expect(d.mms.netEngine.status().relays).toEqual({ available: true, list: [] }), 15_000)
    // relayReadTries (5) asks, relayReadRetryMs apart, then none until the next relay event.
    await eventually(
      () => expect(e.fake!.requests.filter((request) => request.op === 'relay.list')).toHaveLength(5),
      15_000
    )
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(e.fake!.requests.filter((request) => request.op === 'relay.list')).toHaveLength(5)
    expect(e.mms.netEngine.status().relays).toBeUndefined()
  }, 60_000)

  it('shows no relays from a helper without them, and refuses relay calls there', async () => {
    expect(c.mms.netEngine.status().relays).toBeUndefined()
    await expect(c.dispatch('netEngine.relay.enroll', { link: LINK }, true)).rejects.toMatchObject({
      details: { reason: 'no_relays' }
    })
  })
})
