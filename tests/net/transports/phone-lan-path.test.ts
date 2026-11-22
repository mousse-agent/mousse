import { describe, expect, it, vi } from 'vitest'
import type { NetService } from '../../../src/mms/net/NetService'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import {
  PHONE_ENDPOINTS_METHOD,
  PHONE_LAN_MAX_ADDRESSES,
  phoneLanAddresses
} from '../../../src/mms/net/transports/phoneWebRtc'
import { FakePeerFactory } from '../harness/FakeWebRtc'
import {
  cleanups,
  fixture,
  profile,
  relayedSession,
  rpc,
  sessionOver
} from '../harness/phoneWebRtcFixture'

// One address of every kind: only the private IPv4 ones may reach a phone.
const HOSTS = [
  '192.168.0.86',
  '10.1.2.3',
  '172.20.0.5',
  '100.100.1.2', // Tailscale
  'fd12:3456::1', // unique local: the LAN listener binds IPv4 only
  '2001:4860::8', // global IPv6
  '8.8.8.8',
  '127.0.0.1',
  '169.254.3.4'
]

const lanPort = (net: NetService) =>
  (net as unknown as { transport: { lanPort(): number } }).transport.lanPort()

/** A raw WebSocket to the computer's automatic LAN listener, as a phone on the same network opens it. */
async function lanSocket(computer: NetService) {
  const client = new DirectTransport()
  await client.provision()
  cleanups.push(() => client.teardown())
  return client.dial(
    {
      transport: 'direct',
      address: `ws://127.0.0.1:${lanPort(computer)}/mousse-net`,
      priority: -10
    },
    new AbortController().signal
  )
}

describe('LAN addresses for phones', () => {
  it('are the LAN listener on private IPv4 addresses only, at most eight', () => {
    expect(phoneLanAddresses(41234, HOSTS)).toEqual([
      'ws://10.1.2.3:41234/mousse-net',
      'ws://172.20.0.5:41234/mousse-net',
      'ws://192.168.0.86:41234/mousse-net'
    ])
    const many = Array.from({ length: 20 }, (_, index) => `192.168.1.${index + 1}`)
    expect(phoneLanAddresses(41234, many)).toHaveLength(PHONE_LAN_MAX_ADDRESSES)
    expect(phoneLanAddresses(0, HOSTS)).toEqual([])
  })
})

describe('the phone path over the LAN listener', () => {
  it('a phone of this account learns the LAN addresses over the relay, then opens a session on the LAN and calls', async () => {
    const { computer, phone, computerNode, mousseId } = await fixture({
      factory: new FakePeerFactory(),
      hostAddresses: () => new Set(HOSTS)
    })
    const port = lanPort(computer.net)
    expect(port).toBeGreaterThan(0)
    const lan = {
      v: 1,
      addresses: ['10.1.2.3', '172.20.0.5', '192.168.0.86'].map(
        (host) => `ws://${host}:${port}/mousse-net`
      )
    }
    const relayed = await relayedSession(phone.net, computer.net, mousseId)
    expect(await rpc(relayed, PHONE_ENDPOINTS_METHOD, {})).toEqual({
      endpoints: [],
      webrtc: { v: 1 },
      lan
    })

    // The same pinned TLS and signed hello, on the LAN listener: no relay is involved.
    const direct = await sessionOver(phone.net, await lanSocket(computer.net), computer.net)
    expect(direct.peer.node).toBe(computerNode)
    expect(direct.state()).toBe('open')
    // Over the LAN session the phone refreshes the addresses; WebRTC needs no offer there.
    expect(await rpc(direct, PHONE_ENDPOINTS_METHOD, {})).toEqual({ endpoints: [], lan })
  }, 40_000)

  it('refuses a device of another account on the LAN listener, and tells it nothing', async () => {
    const { computer } = await fixture({
      factory: new FakePeerFactory(),
      hostAddresses: () => new Set(HOSTS)
    })
    const stranger = profile()
    await stranger.net.request('net.init', {})
    const outcome = await sessionOver(
      stranger.net,
      await lanSocket(computer.net),
      computer.net
    ).then(
      async (session) => {
        const asked = await rpc(session, PHONE_ENDPOINTS_METHOD, {}).then(
          (answer) => answer,
          () => undefined
        )
        expect(asked?.lan).toBeUndefined()
        await vi.waitFor(() => expect(session.state()).toBe('closed'), { timeout: 5000 })
        return 'closed'
      },
      () => 'refused'
    )
    expect(['closed', 'refused']).toContain(outcome)
  }, 40_000)
})
