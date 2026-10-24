import { describe, expect, it, vi } from 'vitest'
import type { NetService } from '../../../src/mms/net/NetService'
import {
  DataChannelDuplex,
  PHONE_ENDPOINTS_METHOD,
  PHONE_WEBRTC_OFFER_METHOD
} from '../../../src/mms/net/transports/phoneWebRtc'
import type { NodeId, UserId } from '../../../src/shared/net'
import { FakePeerFactory, fakeOffer } from '../harness/FakeWebRtc'
import {
  RELAY,
  fixture as baseFixture,
  relayedSession,
  rpc,
  sessionOver
} from '../harness/phoneWebRtcFixture'

/** The computer with a fake WebRTC stack, and a phone of the same user. */
async function fixture() {
  const factory = new FakePeerFactory()
  const base = await baseFixture({ factory, hostAddresses: () => new Set(['192.168.0.86']) })
  return { ...base, factory }
}

/** Request aliases and execution records of the WebRTC methods in the test profile. */
const storedRows = (net: NetService) =>
  ['net_rpc_aliases WHERE method', 'net_executions WHERE target'].map((table) =>
    Number(
      (
        net
          .runtime()
          .db.database.prepare(`SELECT count(*) AS n FROM ${table} LIKE 'net.direct.%'`)
          .get() as { n: number }
      ).n
    )
  )

describe('WebRTC direct path in the Net service', () => {
  it('is offered only to sessions that came through Mousse ID or WebRTC, and opens a full session', async () => {
    const { computer, phone, computerNode, mousseId, factory } = await fixture()
    // A session over the ordinary direct listener learns nothing and may not offer.
    await vi.waitFor(
      async () =>
        expect(await rpc(phone.net.session(computerNode), PHONE_ENDPOINTS_METHOD, {})).toEqual({
          endpoints: []
        }),
      { timeout: 10_000, interval: 100 }
    )
    await expect(
      rpc(phone.net.session(computerNode), PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(factory.peers).toHaveLength(0)

    const relayed = await relayedSession(phone.net, computer.net, mousseId)
    expect(await rpc(relayed, PHONE_ENDPOINTS_METHOD, {})).toEqual({
      endpoints: [],
      webrtc: { v: 1 }
    })
    for (const params of [{ sdp: fakeOffer() }, { sdp: fakeOffer(), v: 2 }, { sdp: 1, v: 1 }])
      await expect(rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, params)).rejects.toMatchObject({
        code: 'bad_request'
      })

    const answer = await rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    expect(Object.keys(answer)).toEqual(['sdp'])
    expect(String(answer.sdp).startsWith('v=0\r\n')).toBe(true)
    expect(answer.sdp).toContain('192.168.0.86 50014 typ host')
    expect(factory.log.slice(0, 4)).toEqual(['create', 'setRemote', 'setLocal', 'checking'])
    // Nothing about the offer or the answer is stored.
    expect(storedRows(computer.net)).toEqual([0, 0])

    // The phone opens the channel and runs inner TLS and the session hello over it.
    const phoneEnd = factory.peers[0].openChannel()
    const direct = await sessionOver(phone.net, new DataChannelDuplex(phoneEnd), computer.net)
    expect(direct.peer.node).toBe(computerNode)
    await vi.waitFor(() =>
      expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 0, live: 1 })
    )
    // Over the WebRTC session itself: the same answer, and re-offers are allowed.
    expect(await rpc(direct, PHONE_ENDPOINTS_METHOD, {})).toEqual({
      endpoints: [],
      webrtc: { v: 1 }
    })
    await rpc(direct, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer('10.0.0.9'), v: 1 })
    expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 1, live: 1 })

    // Ending the session closes its PeerConnection.
    direct.close()
    await vi.waitFor(() => expect(factory.peers[0].closed).toBe(true))
    expect(computer.net.phoneWebRtcCounts().live).toBe(0)
  }, 40_000)

  it('refuses a session whose node is not the ticket’s node', async () => {
    const { computer, phone, factory } = await fixture()
    const user = phone.net.runtime().identity.self()!.user as UserId
    // A ticket issued to another node of the same user.
    await (
      computer.net as unknown as {
        phoneWebRtc(): { offer(caller: unknown, sdp: string): Promise<unknown> }
      }
    )
      .phoneWebRtc()
      .offer({ node: 'node_someone_else' as NodeId, user }, fakeOffer())
    const phoneEnd = factory.peers[0].openChannel()
    const outcome = await sessionOver(
      phone.net,
      new DataChannelDuplex(phoneEnd),
      computer.net
    ).then(
      async (session) => {
        await vi.waitFor(() => expect(session.state()).toBe('closed'), { timeout: 5000 })
        return 'closed'
      },
      () => 'refused'
    )
    expect(['closed', 'refused']).toContain(outcome)
    await vi.waitFor(() => expect(factory.peers[0].closed).toBe(true))
    expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 0, live: 0 })
  }, 40_000)

  it('drops pending and live WebRTC connections of a revoked node', async () => {
    const { computer, phone, mousseId, factory } = await fixture()
    const relayed = await relayedSession(phone.net, computer.net, mousseId)
    await rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    const direct = await sessionOver(
      phone.net,
      new DataChannelDuplex(factory.peers[0].openChannel()),
      computer.net
    )
    await vi.waitFor(() => expect(computer.net.phoneWebRtcCounts().live).toBe(1))
    await rpc(direct, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer('10.0.0.9'), v: 1 })
    expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 1, live: 1 })
    await computer.net.request('bridge.revoke', {
      node: phone.net.runtime().identity.self()!.node
    })
    await vi.waitFor(() => expect(factory.peers.every((peer) => peer.closed)).toBe(true))
    expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 0, live: 0 })
  }, 40_000)

  it('turns off with the Mousse ID kill switch and when the relay listener goes down', async () => {
    const { computer, phone, mousseId, factory } = await fixture()
    const relayed = await relayedSession(phone.net, computer.net, mousseId)
    await rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    mousseId.setDirect({ webrtc: false, stun: [] })
    expect(factory.peers[0].closed).toBe(true)
    expect(await rpc(relayed, PHONE_ENDPOINTS_METHOD, {})).toEqual({ endpoints: [] })
    await expect(
      rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    ).rejects.toMatchObject({ code: 'disabled' })

    mousseId.setDirect({ webrtc: true, stun: ['stun:198.51.100.7:3478'] })
    await rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    expect(factory.peers[1].config.iceServers).toEqual(['stun:198.51.100.7:3478'])

    // Signing out of Mousse ID takes the relay listener down and closes every ticket.
    await computer.net.request('net.transport.configure', {
      id: 'plus-relay',
      enabled: false,
      settings: { address: RELAY }
    })
    await vi.waitFor(() => expect(factory.peers[1].closed).toBe(true))
    expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 0, live: 0 })
  }, 40_000)

  it('closes everything when the Net service shuts down', async () => {
    const { computer, phone, mousseId, factory } = await fixture()
    const relayed = await relayedSession(phone.net, computer.net, mousseId)
    await rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, { sdp: fakeOffer(), v: 1 })
    await computer.net.shutdown()
    expect(factory.peers[0].closed).toBe(true)
  }, 40_000)
})
