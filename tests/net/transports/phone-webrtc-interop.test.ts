import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  DataChannelDuplex,
  PHONE_ENDPOINTS_METHOD,
  PHONE_WEBRTC_LABEL,
  PHONE_WEBRTC_OFFER_METHOD,
  directHostAddresses,
  normalizeAddress,
  type WebRtcChannel
} from '../../../src/mms/net/transports/phoneWebRtc'
import { cleanups, fixture, relayedSession, rpc, sessionOver } from '../harness/phoneWebRtcFixture'

/** The browser-style WebRTC API from node-datachannel, standing in for the phone's WebView. */
const { RTCPeerConnection } = createRequire(import.meta.url)('node-datachannel/polyfill') as {
  RTCPeerConnection: new (config: { iceServers: unknown[] }) => PhonePeer
}

interface PhoneChannel {
  binaryType: string
  readonly readyState: string
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(data: Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onbufferedamountlow: (() => void) | null
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null
}
interface PhonePeer {
  iceGatheringState: string
  localDescription: { sdp: string } | null
  connectionState: string
  onicegatheringstatechange: (() => void) | null
  createDataChannel(label: string, init: { ordered: boolean }): PhoneChannel
  createOffer(): Promise<{ type: string; sdp: string }>
  setLocalDescription(description: { type: string; sdp: string }): Promise<void>
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>
  close(): void
}

/** The phone's DataChannel behind the same interface as the computer's. */
function phoneChannel(channel: PhoneChannel): WebRtcChannel {
  channel.binaryType = 'arraybuffer'
  return {
    label: () => PHONE_WEBRTC_LABEL,
    protocol: () => '',
    isOpen: () => channel.readyState === 'open',
    send: (bytes) => channel.send(bytes),
    bufferedAmount: () => channel.bufferedAmount,
    setBufferedAmountLowThreshold: (bytes) => {
      channel.bufferedAmountLowThreshold = bytes
    },
    onOpen: (callback) => {
      channel.onopen = callback
    },
    onClosed: (callback) => {
      channel.onclose = callback
    },
    onError: (callback) => {
      channel.onerror = () => callback('error')
    },
    onBufferedAmountLow: (callback) => {
      channel.onbufferedamountlow = callback
    },
    onMessage: (callback) => {
      channel.onmessage = (event) =>
        callback(typeof event.data === 'string' ? event.data : Buffer.from(event.data))
    },
    close: () => channel.close()
  }
}

// Both ends run on this machine, so it needs one address the direct path may use.
const usable = directHostAddresses().size > 0

describe.skipIf(!usable)('WebRTC direct path with the real native stack', () => {
  it('discovers, offers, connects and opens a full session over the DataChannel', async () => {
    const { computer, phone, computerNode, mousseId } = await fixture()
    const relayed = await relayedSession(phone.net, computer.net, mousseId)
    expect(await rpc(relayed, PHONE_ENDPOINTS_METHOD, {})).toEqual({
      endpoints: [],
      webrtc: { v: 1 }
    })

    const peer = new RTCPeerConnection({ iceServers: [] })
    cleanups.push(() => peer.close())
    const channel = peer.createDataChannel(PHONE_WEBRTC_LABEL, { ordered: true })
    await peer.setLocalDescription(await peer.createOffer())
    await new Promise<void>((resolve) => {
      if (peer.iceGatheringState === 'complete') resolve()
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === 'complete') resolve()
      }
    })
    const answer = await rpc(relayed, PHONE_WEBRTC_OFFER_METHOD, {
      sdp: peer.localDescription!.sdp,
      v: 1
    })
    expect(Object.keys(answer)).toEqual(['sdp'])
    expect(String(answer.sdp).startsWith('v=0')).toBe(true)
    expect(Buffer.byteLength(String(answer.sdp))).toBeLessThanOrEqual(16 * 1024)
    for (const line of String(answer.sdp)
      .split('\r\n')
      .filter((row) => row.startsWith('a=candidate:')))
      expect(directHostAddresses().has(normalizeAddress(line.split(' ')[4]))).toBe(true)

    const wrapped = phoneChannel(channel)
    const raw = new DataChannelDuplex(wrapped)
    raw.secured()
    const opened = new Promise<void>((resolve) => {
      if (channel.readyState === 'open') resolve()
      else wrapped.onOpen(resolve)
    })
    await peer.setRemoteDescription({ type: 'answer', sdp: String(answer.sdp) })
    await opened

    const direct = await sessionOver(phone.net, raw, computer.net)
    expect(direct.peer.node).toBe(computerNode)
    await vi.waitFor(() =>
      expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 0, live: 1 })
    )
    expect(await rpc(direct, PHONE_ENDPOINTS_METHOD, {})).toEqual({
      endpoints: [],
      webrtc: { v: 1 }
    })

    // Revoking the phone ends the WebRTC session and its PeerConnection.
    await computer.net.request('bridge.revoke', { node: phone.net.runtime().identity.self()!.node })
    await vi.waitFor(() =>
      expect(computer.net.phoneWebRtcCounts()).toEqual({ pending: 0, live: 0 })
    )
    await vi.waitFor(() => expect(direct.state()).toBe('closed'), { timeout: 10_000 })
  }, 40_000)
})
