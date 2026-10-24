import type {
  PeerConnectionConfig,
  PeerConnectionFactory,
  WebRtcChannel,
  WebRtcPeer
} from '../../../src/mms/net/transports/phoneWebRtc'

/** One end of an in-memory DataChannel; `send` delivers to the other end on a later tick. */
export class FakeChannel implements WebRtcChannel {
  other?: FakeChannel
  opened = false
  closed = false
  buffered = 0
  readonly sent: Buffer[] = []
  private callbacks: {
    open?: () => void
    closed?: () => void
    error?: (message: string) => void
    low?: () => void
    message?: (data: Buffer | string) => void
  } = {}
  constructor(
    private readonly name: string,
    private readonly proto = ''
  ) {}
  label(): string {
    return this.name
  }
  protocol(): string {
    return this.proto
  }
  isOpen(): boolean {
    return this.opened && !this.closed
  }
  send(bytes: Uint8Array): void {
    if (!this.isOpen()) throw new Error('closed')
    const copy = Buffer.from(bytes)
    this.sent.push(copy)
    const other = this.other
    setImmediate(() => other?.deliver(copy))
  }
  bufferedAmount(): number {
    return this.buffered
  }
  setBufferedAmountLowThreshold(): void {}
  onOpen(callback: () => void): void {
    this.callbacks.open = callback
  }
  onClosed(callback: () => void): void {
    this.callbacks.closed = callback
  }
  onError(callback: (message: string) => void): void {
    this.callbacks.error = callback
  }
  onBufferedAmountLow(callback: () => void): void {
    this.callbacks.low = callback
  }
  onMessage(callback: (data: Buffer | string) => void): void {
    this.callbacks.message = callback
  }
  deliver(data: Buffer | string): void {
    if (!this.closed) this.callbacks.message?.(data)
  }
  open(): void {
    this.opened = true
    this.callbacks.open?.()
  }
  drained(): void {
    this.buffered = 0
    this.callbacks.low?.()
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    setImmediate(() => {
      this.callbacks.closed?.()
      this.other?.close()
    })
  }
}

/** A connected pair: `desktop` goes to the acceptor, `phone` to the test. */
export function channelPair(
  label = 'mousse-net/1',
  protocol = ''
): {
  desktop: FakeChannel
  phone: FakeChannel
} {
  const desktop = new FakeChannel(label, protocol),
    phone = new FakeChannel(label, protocol)
  desktop.other = phone
  phone.other = desktop
  return { desktop, phone }
}

export const FAKE_ANSWER_CANDIDATES = [
  'a=candidate:1 1 UDP 2114977791 192.168.0.86 50014 typ host',
  'a=candidate:2 1 UDP 2114977535 172.17.0.1 50014 typ host'
]

/** A PeerConnection that records the order of calls. */
export class FakePeer implements WebRtcPeer {
  remoteSdp?: string
  closed = false
  gathered = false
  fingerprint?: string
  private gatheredCallbacks: Array<() => void> = []
  private stateCallback?: (state: string) => void
  private channelCallback?: (channel: WebRtcChannel) => void
  constructor(
    readonly config: PeerConnectionConfig,
    readonly log: string[],
    private readonly options: { gatherOnAnswer: boolean; candidates: string[] }
  ) {}
  setRemoteOffer(sdp: string): void {
    this.log.push('setRemote')
    this.remoteSdp = sdp
  }
  setLocalAnswer(): void {
    if (!this.remoteSdp) throw new Error('no offer')
    this.log.push('setLocal')
    // ICE checks toward the offer's candidates start here.
    this.log.push('checking')
    if (this.options.gatherOnAnswer) this.completeGathering()
  }
  completeGathering(): void {
    this.gathered = true
    for (const callback of this.gatheredCallbacks.splice(0)) callback()
  }
  localSdp(): string | undefined {
    if (!this.remoteSdp) return undefined
    return (
      [
        'v=0',
        'o=rtc 1 0 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'm=application 50014 UDP/DTLS/SCTP webrtc-datachannel',
        'c=IN IP4 192.168.0.86',
        'a=setup:active',
        ...(this.gathered ? this.options.candidates : []),
        'a=end-of-candidates'
      ].join('\r\n') + '\r\n'
    )
  }
  gatheringComplete(): boolean {
    return this.gathered
  }
  onGatheringComplete(callback: () => void): void {
    this.gatheredCallbacks.push(callback)
  }
  onStateChange(callback: (state: string) => void): void {
    this.stateCallback = callback
  }
  onDataChannel(callback: (channel: WebRtcChannel) => void): void {
    this.channelCallback = callback
  }
  remoteFingerprint(): string | undefined {
    return this.fingerprint
  }
  /** The phone opens a DataChannel; returns the phone's end. */
  openChannel(label = 'mousse-net/1', protocol = ''): FakeChannel {
    const pair = channelPair(label, protocol)
    pair.phone.opened = true
    this.channelCallback?.(pair.desktop)
    pair.desktop.open()
    return pair.phone
  }
  state(state: string): void {
    this.stateCallback?.(state)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.log.push('close')
    this.stateCallback?.('closed')
  }
}

export class FakePeerFactory implements PeerConnectionFactory {
  readonly peers: FakePeer[] = []
  readonly log: string[] = []
  gatherOnAnswer = true
  candidates = FAKE_ANSWER_CANDIDATES
  async create(config: PeerConnectionConfig): Promise<FakePeer> {
    this.log.push('create')
    const peer = new FakePeer(config, this.log, {
      gatherOnAnswer: this.gatherOnAnswer,
      candidates: this.candidates
    })
    this.peers.push(peer)
    return peer
  }
}

const FINGERPRINT = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, '0').toUpperCase()
).join(':')
export const FAKE_OFFER_FINGERPRINT = FINGERPRINT.replaceAll(':', '').toLowerCase()

/** A valid phone offer with one LAN host candidate. */
export function fakeOffer(address = '192.168.1.20'): string {
  return (
    [
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      `a=candidate:1 1 udp 2122260223 ${address} 54321 typ host`,
      'a=ice-ufrag:abcd',
      'a=ice-pwd:abcdefghijklmnopqrstuv',
      `a=fingerprint:sha-256 ${FINGERPRINT}`,
      'a=setup:actpass',
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144'
    ].join('\r\n') + '\r\n'
  )
}
