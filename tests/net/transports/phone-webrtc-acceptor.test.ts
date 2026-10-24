import { describe, expect, it, vi } from 'vitest'
import type { NodeId, UserId } from '../../../src/shared/net'
import {
  DataChannelDuplex,
  PhoneWebRtcAcceptor,
  type AcceptedWebRtc
} from '../../../src/mms/net/transports/phoneWebRtc'
import { FakeClock } from '../harness/FakeClock'
import {
  FAKE_OFFER_FINGERPRINT,
  FakeChannel,
  FakePeerFactory,
  channelPair,
  fakeOffer
} from '../harness/FakeWebRtc'

const USER = 'user_a' as UserId
const node = (name: string) => `node_${name}` as NodeId

function acceptor(options: { stun?: string[]; ticketTtlMs?: number } = {}) {
  const clock = new FakeClock()
  const factory = new FakePeerFactory()
  const accepted: AcceptedWebRtc[] = []
  const webrtc = new PhoneWebRtcAcceptor({
    clock,
    factory,
    iceServers: () => options.stun ?? [],
    hostAddresses: () => new Set(['192.168.0.86']),
    ownAddresses: () => new Set(['192.168.0.86']),
    onChannel: (row) => accepted.push(row),
    ...(options.ticketTtlMs ? { ticketTtlMs: options.ticketTtlMs } : {})
  })
  return { clock, factory, webrtc, accepted }
}

describe('WebRTC acceptor', () => {
  it('sets the offer, then its answer, and starts ICE before it replies', async () => {
    const { factory, webrtc } = acceptor({ stun: ['stun:stun.example:3478'] })
    const answer = await webrtc.offer({ node: node('phone'), user: USER }, fakeOffer())
    factory.log.push('answered')
    expect(factory.log).toEqual(['create', 'setRemote', 'setLocal', 'checking', 'answered'])
    expect(factory.peers[0].config.iceServers).toEqual(['stun:stun.example:3478'])
    // Only this computer's direct host addresses reach the phone.
    expect(answer.sdp).toContain('192.168.0.86 50014 typ host')
    expect(answer.sdp).not.toContain('172.17.0.1')
    expect(webrtc.counts()).toEqual({ pending: 1, live: 0 })
  })

  it('waits for its own gathering, at most 1.5 seconds, before it answers', async () => {
    const { clock, factory, webrtc } = acceptor()
    factory.gatherOnAnswer = false
    let answered = false
    const pending = webrtc.offer({ node: node('phone'), user: USER }, fakeOffer()).then((row) => {
      answered = true
      return row
    })
    await vi.waitFor(() => expect(factory.log).toContain('checking'))
    await Promise.resolve()
    expect(answered).toBe(false)
    factory.peers[0].completeGathering()
    await expect(pending).resolves.toMatchObject({ sdp: expect.stringContaining('typ host') })

    // Without gathering, the deadline answers with what exists: here nothing usable.
    const late = webrtc.offer({ node: node('phone'), user: USER }, fakeOffer())
    await vi.waitFor(() => expect(factory.peers).toHaveLength(2))
    clock.advance(1_500)
    await expect(late).rejects.toMatchObject({ code: 'route_unreachable' })
    expect(factory.peers[1].closed).toBe(true)
  })

  it('refuses a malformed offer before any native object exists', async () => {
    const { factory, webrtc } = acceptor()
    await expect(
      webrtc.offer(
        { node: node('phone'), user: USER },
        fakeOffer().replace('a=setup:actpass', 'a=ice-lite')
      )
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(factory.peers).toHaveLength(0)
    expect(webrtc.counts()).toEqual({ pending: 0, live: 0 })
  })

  it('caps pending offers per node and overall', async () => {
    const { webrtc } = acceptor()
    const offer = (name: string) => webrtc.offer({ node: node(name), user: USER }, fakeOffer())
    await offer('a')
    await offer('a')
    await expect(offer('a')).rejects.toMatchObject({ code: 'rate_limited' })
    for (const name of ['b', 'b', 'c', 'c', 'd', 'd']) await offer(name)
    expect(webrtc.counts().pending).toBe(8)
    await expect(offer('e')).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('caps live connections per node and overall', async () => {
    const { factory, webrtc, accepted } = acceptor()
    const connect = async (name: string) => {
      await webrtc.offer({ node: node(name), user: USER }, fakeOffer())
      factory.peers.at(-1)!.openChannel()
      accepted.at(-1)!.authenticated()
    }
    for (let index = 0; index < 4; index++) await connect('a')
    expect(webrtc.counts(node('a'))).toEqual({ pending: 0, live: 4 })
    await expect(webrtc.offer({ node: node('a'), user: USER }, fakeOffer())).rejects.toMatchObject({
      code: 'rate_limited'
    })
    for (const name of ['b', 'c', 'd']) for (let index = 0; index < 4; index++) await connect(name)
    expect(webrtc.counts().live).toBe(16)
    await expect(webrtc.offer({ node: node('e'), user: USER }, fakeOffer())).rejects.toMatchObject({
      code: 'rate_limited'
    })
  })

  it('counts pending tickets against the live limits', async () => {
    const { factory, webrtc, accepted } = acceptor()
    const offer = (name: string) => webrtc.offer({ node: node(name), user: USER }, fakeOffer())
    const connect = async (name: string) => {
      await offer(name)
      factory.peers.at(-1)!.openChannel()
      accepted.at(-1)!.authenticated()
    }
    for (let index = 0; index < 3; index++) await connect('a')
    await offer('a')
    // Three live and one pending already fill the node's four slots.
    await expect(offer('a')).rejects.toMatchObject({ code: 'rate_limited' })
    factory.peers.at(-1)!.openChannel()
    accepted.at(-1)!.authenticated()
    expect(webrtc.counts(node('a'))).toEqual({ pending: 0, live: 4 })

    for (const name of ['b', 'c', 'd']) for (let index = 0; index < 4; index++) await connect(name)
    expect(webrtc.counts().live).toBe(16)
  })

  it('counts pending tickets against the overall live limit', async () => {
    const { factory, webrtc, accepted } = acceptor()
    const offer = (name: string) => webrtc.offer({ node: node(name), user: USER }, fakeOffer())
    for (const name of ['a', 'b', 'c']) {
      for (let index = 0; index < 4; index++) {
        await offer(name)
        factory.peers.at(-1)!.openChannel()
        accepted.at(-1)!.authenticated()
      }
    }
    for (let index = 0; index < 3; index++) {
      await offer('d')
      factory.peers.at(-1)!.openChannel()
      accepted.at(-1)!.authenticated()
    }
    expect(webrtc.counts()).toEqual({ pending: 0, live: 15 })
    await offer('e')
    await expect(offer('f')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(webrtc.counts()).toEqual({ pending: 1, live: 15 })
  })

  it('does not spend the offer budget on offers refused by the ticket limits', async () => {
    const { webrtc } = acceptor()
    const offer = () => webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    await offer()
    await offer()
    for (let index = 0; index < 10; index++)
      await expect(offer()).rejects.toMatchObject({ code: 'rate_limited' })
    webrtc.closeAll()
    // Two offers were admitted; the refused retries did not use up the six a minute.
    await expect(offer()).resolves.toMatchObject({ sdp: expect.any(String) })
  })

  it('allows six offers a minute per node', async () => {
    const { clock, webrtc } = acceptor()
    const offer = () => webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    for (let index = 0; index < 6; index++) {
      await offer()
      webrtc.closeAll()
    }
    await expect(offer()).rejects.toMatchObject({ code: 'rate_limited' })
    // Another node is not affected.
    await webrtc.offer({ node: node('b'), user: USER }, fakeOffer())
    clock.advance(60_000)
    await expect(offer()).resolves.toMatchObject({ sdp: expect.any(String) })
  })

  it('drops a ticket that does not reach an authenticated session within 15 seconds', async () => {
    const { clock, factory, webrtc, accepted } = acceptor()
    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    factory.peers[0].openChannel()
    expect(accepted).toHaveLength(1)
    expect(accepted[0].ticket).toMatchObject({
      node: node('a'),
      user: USER,
      fingerprint: FAKE_OFFER_FINGERPRINT
    })
    clock.advance(15_000)
    expect(factory.peers[0].closed).toBe(true)
    expect(accepted[0].raw.destroyed).toBe(true)
    expect(webrtc.counts()).toEqual({ pending: 0, live: 0 })

    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    factory.peers[1].openChannel()
    accepted[1].authenticated()
    clock.advance(60_000)
    expect(factory.peers[1].closed).toBe(false)
    expect(webrtc.counts()).toEqual({ pending: 0, live: 1 })
  })

  it('accepts exactly one channel, labelled mousse-net/1, from the offered certificate', async () => {
    const { factory, webrtc, accepted } = acceptor()
    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    factory.peers[0].openChannel('other')
    expect(factory.peers[0].closed).toBe(true)

    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    factory.peers[1].openChannel('mousse-net/1', 'chat')
    expect(factory.peers[1].closed).toBe(true)

    await webrtc.offer({ node: node('b'), user: USER }, fakeOffer())
    factory.peers[2].openChannel()
    factory.peers[2].openChannel()
    expect(factory.peers[2].closed).toBe(true)

    await webrtc.offer({ node: node('b'), user: USER }, fakeOffer())
    factory.peers[3].fingerprint = 'ff'.repeat(32)
    factory.peers[3].openChannel()
    expect(factory.peers[3].closed).toBe(true)
    expect(accepted).toHaveLength(1)
  })

  it('closes a node’s pending and live connections, and everything on stop', async () => {
    const { factory, webrtc, accepted } = acceptor()
    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    factory.peers[0].openChannel()
    accepted[0].authenticated()
    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    await webrtc.offer({ node: node('b'), user: USER }, fakeOffer())
    expect(webrtc.nodes().sort()).toEqual([node('a'), node('b')])
    webrtc.closeNode(node('a'))
    expect(factory.peers.map((peer) => peer.closed)).toEqual([true, true, false])
    webrtc.stop()
    expect(factory.peers[2].closed).toBe(true)
    await expect(webrtc.offer({ node: node('b'), user: USER }, fakeOffer())).rejects.toMatchObject({
      code: 'disabled'
    })
  })

  it('closes the ticket when ICE fails or the channel closes', async () => {
    const { factory, webrtc } = acceptor()
    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    factory.peers[0].state('failed')
    expect(factory.peers[0].closed).toBe(true)
    await webrtc.offer({ node: node('a'), user: USER }, fakeOffer())
    const phone = factory.peers[1].openChannel()
    phone.close()
    await vi.waitFor(() => expect(factory.peers[1].closed).toBe(true))
    expect(webrtc.counts()).toEqual({ pending: 0, live: 0 })
  })
})

describe('DataChannel byte stream', () => {
  it('writes messages of at most 64 KiB and waits while the channel buffer is full', async () => {
    const { desktop, phone } = channelPair()
    desktop.opened = phone.opened = true
    const raw = new DataChannelDuplex(desktop)
    const received: Buffer[] = []
    phone.onMessage((data) => received.push(data as Buffer))
    await new Promise<void>((resolve, reject) =>
      raw.write(Buffer.alloc(150 * 1024, 7), (error) => (error ? reject(error) : resolve()))
    )
    expect(desktop.sent.map((part) => part.length)).toEqual([65_536, 65_536, 22_528])
    await vi.waitFor(() => expect(received).toHaveLength(3))

    desktop.buffered = 2 * 1024 * 1024
    let done = false
    raw.write(Buffer.alloc(10), () => {
      done = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    desktop.drained()
    await vi.waitFor(() => expect(done).toBe(true))
    raw.destroy()
    expect(desktop.closed).toBe(true)
  })

  it('closes on text messages', async () => {
    const channel = new FakeChannel('mousse-net/1')
    const raw = new DataChannelDuplex(channel)
    const failed = new Promise<unknown>((resolve) => raw.once('error', resolve))
    channel.deliver('hello')
    await expect(failed).resolves.toMatchObject({ code: 'bad_request' })
  })

  it('allows 64 KiB before inner TLS completes and any amount after', async () => {
    const early = new DataChannelDuplex(new FakeChannel('mousse-net/1'))
    const channel = (early as unknown as { channel: FakeChannel }).channel
    early.on('data', () => {})
    const failed = new Promise<unknown>((resolve) => early.once('error', resolve))
    channel.deliver(Buffer.alloc(60 * 1024))
    expect(early.destroyed).toBe(false)
    channel.deliver(Buffer.alloc(8 * 1024))
    await expect(failed).resolves.toMatchObject({ code: 'too_large' })

    const later = new DataChannelDuplex(new FakeChannel('mousse-net/1'))
    const second = (later as unknown as { channel: FakeChannel }).channel
    later.on('data', () => {})
    later.secured()
    for (let index = 0; index < 4; index++) second.deliver(Buffer.alloc(64 * 1024))
    expect(later.destroyed).toBe(false)
  })

  it('closes on any message over 64 KiB, before and after inner TLS completes', async () => {
    const early = new DataChannelDuplex(new FakeChannel('mousse-net/1'))
    const first = (early as unknown as { channel: FakeChannel }).channel
    early.on('data', () => {})
    const earlyFailed = new Promise<unknown>((resolve) => early.once('error', resolve))
    first.deliver(Buffer.alloc(64 * 1024 + 1))
    await expect(earlyFailed).resolves.toMatchObject({ code: 'too_large' })

    const later = new DataChannelDuplex(new FakeChannel('mousse-net/1'))
    const second = (later as unknown as { channel: FakeChannel }).channel
    later.on('data', () => {})
    later.secured()
    second.deliver(Buffer.alloc(64 * 1024))
    expect(later.destroyed).toBe(false)
    const laterFailed = new Promise<unknown>((resolve) => later.once('error', resolve))
    second.deliver(Buffer.alloc(64 * 1024 + 1))
    await expect(laterFailed).resolves.toMatchObject({ code: 'too_large' })
  })

  it('closes when a reader falls more than 8 MiB behind', async () => {
    const channel = new FakeChannel('mousse-net/1')
    const raw = new DataChannelDuplex(channel, { inboundMaxBytes: 256 * 1024 })
    raw.secured()
    const failed = new Promise<unknown>((resolve) => raw.once('error', resolve))
    for (let index = 0; index < 5; index++) channel.deliver(Buffer.alloc(64 * 1024))
    await expect(failed).resolves.toMatchObject({ code: 'too_large' })
  })
})
