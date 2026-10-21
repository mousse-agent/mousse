import { describe, expect, it } from 'vitest'
import {
  classifyAddress,
  directHostAddresses,
  normalizeAddress,
  parseDirectPathConfig,
  stripAnswer,
  validateOffer,
  type OfferPolicy
} from '../../../src/mms/net/transports/phoneWebRtc'

const FINGERPRINT = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, '0').toUpperCase()
).join(':')

/** A data-channel-only offer as an Android WebView writes it once gathering finished. */
function offer(
  options: { candidates?: string[]; extra?: string[]; replace?: Record<string, string> } = {}
): string {
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...(options.candidates ?? [
      'a=candidate:1467250027 1 udp 2122260223 192.168.1.20 54321 typ host generation 0 network-id 1 network-cost 10'
    ]),
    'a=end-of-candidates',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuv',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${FINGERPRINT}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ...(options.extra ?? [])
  ].map((line) => {
    const key = Object.keys(options.replace ?? {}).find((prefix) => line.startsWith(prefix))
    return key ? options.replace![key] : line
  })
  return lines.join('\r\n') + '\r\n'
}

const host = (address: string, port = 54321, type = 'host', transport = 'udp') =>
  `a=candidate:1 1 ${transport} 2122260223 ${address} ${port} typ ${type}`

const policy: OfferPolicy = { stun: false }

describe('WebRTC offer validator', () => {
  it('accepts a data-channel offer with every allowed attribute and rebuilds it from checked lines', () => {
    const result = validateOffer(offer({ extra: ['a=sendrecv'] }), policy)
    expect(result.fingerprint).toBe(FINGERPRINT.replaceAll(':', '').toLowerCase())
    expect(result.candidates).toEqual([{ address: '192.168.1.20', port: 54321, type: 'host' }])
    expect(result.sdp.startsWith('v=0\r\n')).toBe(true)
    expect(result.sdp).toContain('a=candidate:1467250027 1 udp')
    expect(result.sdp).toContain('a=extmap-allow-mixed')
  })

  it.each([
    ['ice-lite', ['a=ice-lite']],
    ['rtcp', ['a=rtcp:9 IN IP4 0.0.0.0']],
    ['rtcp-mux', ['a=rtcp-mux']],
    ['an unknown attribute', ['a=x-google-flag:conference']],
    ['a media section', ['m=audio 9 UDP/TLS/RTP/SAVPF 111']],
    ['a second application section', ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel']],
    ['a second fingerprint', [`a=fingerprint:sha-256 ${FINGERPRINT}`]],
    ['a bandwidth line', ['b=AS:30']],
    ['an identity attribute', ['a=identity:abc']]
  ])('rejects %s', (_name, extra) => {
    expect(() => validateOffer(offer({ extra }), policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })

  it.each([
    ['a sha-1 fingerprint', { 'a=fingerprint': `a=fingerprint:sha-1 ${FINGERPRINT}` }],
    ['setup other than actpass', { 'a=setup': 'a=setup:active' }],
    ['a short ICE password', { 'a=ice-pwd': 'a=ice-pwd:short' }],
    ['a host name in the connection line', { 'c=': 'c=IN IP4 example.com' }],
    ['a host name as the origin address', { 'o=': 'o=- 1 2 IN IP4 phone.local' }],
    ['another protocol', { 'm=': 'm=application 9 TCP/DTLS/SCTP webrtc-datachannel' }],
    ['another SDP version', { 'v=': 'v=1' }]
  ])('rejects %s', (_name, replace) => {
    expect(() => validateOffer(offer({ replace }), policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })

  it('rejects a missing ICE user fragment', () => {
    const text = offer().replace('a=ice-ufrag:abcd\r\n', '')
    expect(() => validateOffer(text, policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })

  it('rejects offers over 16 KiB, over 100 lines, with control characters or of the wrong type', () => {
    const long = offer({ extra: ['a=ice-options:' + 'x'.repeat(17 * 1024)] })
    expect(() => validateOffer(long, policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
    const many = offer({ extra: Array.from({ length: 90 }, () => 'a=extmap-allow-mixed') })
    expect(() => validateOffer(many, policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
    expect(() => validateOffer(offer().replace('s=-', 's=é'), policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
    expect(() => validateOffer(offer().replace('s=-', 's=\u0000'), policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
    expect(() => validateOffer(42, policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })

  it('rejects more than eight candidates and malformed candidate lines', () => {
    const nine = Array.from({ length: 9 }, (_, index) => host(`192.168.1.${index + 2}`))
    expect(() => validateOffer(offer({ candidates: nine }), policy)).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
    for (const line of [
      'a=candidate:1 2 udp 1 192.168.1.20 54321 typ host',
      'a=candidate:1 1 udp 1 192.168.1.20 54321 typ host secret-extension 1',
      'a=candidate:1 1 udp 1 192.168.1.20 54321 typ srflx raddr phone.local rport 1',
      'a=candidate:1 1 udp 1 192.168.1.20 54321'
    ])
      expect(() => validateOffer(offer({ candidates: [host('10.0.0.2'), line] }), policy)).toThrow(
        expect.objectContaining({ code: 'bad_request' })
      )
  })

  it('drops candidates that are not UDP, use a host name, a low port or a relay, and fails when none remain', () => {
    const result = validateOffer(
      offer({
        candidates: [
          host('192.168.1.20'),
          host('192.168.1.21', 54321, 'host', 'tcp'),
          host('3c1a5a3d-6a7e-4e0a-9d43-0cbb1e2a1f00.local'),
          host('phone.example.com'),
          host('192.168.1.22', 80),
          host('192.168.1.23', 54321, 'relay'),
          host('192.168.1.24', 54321, 'prflx')
        ]
      }),
      policy
    )
    expect(result.candidates.map((row) => row.address)).toEqual(['192.168.1.20'])
    expect(result.sdp).not.toContain('.local')
    expect(result.sdp).not.toContain('example.com')
    expect(result.sdp).not.toContain('typ relay')
    expect(() =>
      validateOffer(offer({ candidates: [host('phone.local'), host('127.0.0.1')] }), policy)
    ).toThrow(expect.objectContaining({ code: 'route_unreachable' }))
  })

  it.each([
    ['10.1.2.3', true],
    ['172.16.0.9', true],
    ['172.31.255.1', true],
    ['192.168.0.101', true],
    ['100.101.1.2', true],
    ['fd12:3456::5', true],
    ['fd7a:115c:a1e0::1', true],
    ['2401:4900:1c2a::5', true],
    ['8.8.8.8', false],
    ['127.0.0.1', false],
    ['::1', false],
    ['169.254.1.1', false],
    ['fe80::1', false],
    ['224.0.0.251', false],
    ['ff02::fb', false],
    ['0.0.0.0', false],
    ['::', false],
    ['255.255.255.255', false],
    ['::ffff:192.168.1.5', false],
    ['192.0.2.1', false],
    ['198.51.100.1', false],
    ['203.0.113.1', false],
    ['198.18.0.1', false],
    ['2001:db8::1', false],
    ['2001:2::1', false],
    ['3fff::1', false]
  ])('host candidate %s allowed: %s', (address, allowed) => {
    const run = () => validateOffer(offer({ candidates: [host(address)] }), policy)
    if (allowed) expect(run().candidates).toHaveLength(1)
    else expect(run).toThrow(expect.objectContaining({ code: 'route_unreachable' }))
  })

  it('uses server-reflexive candidates only with STUN and only on public addresses', () => {
    const srflx = [
      host('192.168.1.20'),
      'a=candidate:2 1 udp 1686052607 49.36.10.20 41000 typ srflx raddr 0.0.0.0 rport 0',
      'a=candidate:3 1 udp 1686052607 10.9.9.9 41000 typ srflx raddr 0.0.0.0 rport 0'
    ]
    expect(validateOffer(offer({ candidates: srflx }), { stun: false }).candidates).toHaveLength(1)
    expect(
      validateOffer(offer({ candidates: srflx }), { stun: true }).candidates.map((row) => row.type)
    ).toEqual(['host', 'srflx'])
  })

  it("drops candidates naming this computer's own addresses or the relay and STUN servers", () => {
    const result = validateOffer(
      offer({
        candidates: [
          host('192.168.1.20'),
          host('192.168.1.30'),
          host('2401:4900:0000::0005'),
          'a=candidate:2 1 udp 1686052607 49.36.10.20 41000 typ srflx raddr 0.0.0.0 rport 0'
        ]
      }),
      {
        stun: true,
        own: new Set(['192.168.1.30', normalizeAddress('2401:4900::5')]),
        blocked: new Set(['49.36.10.20'])
      }
    )
    expect(result.candidates.map((row) => row.address)).toEqual(['192.168.1.20'])
  })
})

describe('WebRTC answer stripping', () => {
  const answer = [
    'v=0',
    'o=rtc 1 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 50014 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 192.168.0.86',
    'a=candidate:1 1 UDP 2114977791 192.168.0.86 50014 typ host',
    'a=candidate:2 1 UDP 2114977535 172.17.0.1 50014 typ host',
    'a=candidate:3 1 UDP 2116025855 fe80::1 50014 typ host',
    'a=candidate:4 1 UDP 2116025855 2401:4900::86 50014 typ host',
    'a=candidate:5 1 UDP 1686052607 49.36.10.20 50014 typ srflx raddr 192.168.0.86 rport 50014',
    'a=candidate:6 1 TCP 1 192.168.0.86 9 typ host tcptype active',
    'a=end-of-candidates',
    ''
  ].join('\r\n')
  const hosts = new Set(['192.168.0.86', normalizeAddress('2401:4900::86')])

  it('keeps only the direct host addresses, and public reflexive ones with STUN', () => {
    const plain = stripAnswer(answer, { hosts, stun: false })
    expect(plain.candidates).toBe(2)
    expect(plain.sdp).toContain('192.168.0.86 50014 typ host')
    expect(plain.sdp).toContain('2401:4900::86')
    expect(plain.sdp).not.toContain('172.17.0.1')
    expect(plain.sdp).not.toContain('fe80::1')
    expect(plain.sdp).not.toContain('typ srflx')
    expect(plain.sdp).not.toContain('TCP')
    expect(stripAnswer(answer, { hosts, stun: true }).candidates).toBe(3)
  })

  it('takes only private, Tailscale and global IPv6 addresses of real interfaces', () => {
    const row = (address: string, family: 'IPv4' | 'IPv6', internal = false) =>
      ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never
    expect([
      ...directHostAddresses({
        lo: [row('127.0.0.1', 'IPv4', true), row('::1', 'IPv6', true)],
        wlan0: [
          row('192.168.1.5', 'IPv4'),
          row('fe80::1', 'IPv6'),
          row('2401:4900::5', 'IPv6'),
          row('fd12:3456::5', 'IPv6')
        ],
        eth0: [row('8.8.8.8', 'IPv4'), row('10.0.0.7', 'IPv4')],
        docker0: [row('172.17.0.1', 'IPv4')],
        tailscale0: [row('100.101.1.2', 'IPv4'), row('fd7a:115c:a1e0::1', 'IPv6')]
      })
    ]).toEqual([
      '192.168.1.5',
      normalizeAddress('2401:4900::5'),
      normalizeAddress('fd12:3456::5'),
      '10.0.0.7',
      '100.101.1.2',
      normalizeAddress('fd7a:115c:a1e0::1')
    ])
  })
})

describe('address classes', () => {
  it('names each class and normalizes IPv6 spellings', () => {
    expect(classifyAddress('100.64.0.1')).toBe('tailscale4')
    expect(classifyAddress('fd7a:115c:a1e0:ab12::1')).toBe('tailscale6')
    expect(classifyAddress('fc00::1')).toBe('ula')
    expect(classifyAddress('2a00:1450::1')).toBe('global6')
    expect(classifyAddress('49.36.10.20')).toBe('public4')
    expect(classifyAddress('phone.local')).toBeUndefined()
    expect(classifyAddress('fe80::1%wlan0')).toBeUndefined()
    expect(normalizeAddress('2401:4900:0000::0005')).toBe(normalizeAddress('2401:4900::5'))
    expect(normalizeAddress('::ffff:1.2.3.4')).toBe('0:0:0:0:0:ffff:102:304')
  })
})

describe('Mousse ID direct-path configuration', () => {
  it('turns WebRTC off only for an explicit false and keeps plain STUN servers', () => {
    expect(parseDirectPathConfig({})).toEqual({ webrtc: true, stun: [] })
    expect(parseDirectPathConfig({ directWebrtc: false })).toEqual({ webrtc: false, stun: [] })
    expect(parseDirectPathConfig({ directWebrtc: 'no' }).webrtc).toBe(true)
    expect(
      parseDirectPathConfig({
        stun: ['stun:api.mousse.work:3478', 'stuns:api.mousse.work:5349', 'stun:[2001:db8::1]']
      }).stun
    ).toEqual(['stun:api.mousse.work:3478', 'stun:[2001:db8::1]'])
    expect(parseDirectPathConfig({ stun: ['turn:relay.example:3478'] }).stun).toEqual([])
    expect(
      parseDirectPathConfig({ stun: ['stun:a', 'stun:b', 'stun:c', 'stun:d', 'stun:e'] }).stun
    ).toEqual([])
    expect(parseDirectPathConfig({ stun: 'stun:a' }).stun).toEqual([])
    expect(parseDirectPathConfig(null)).toEqual({ webrtc: true, stun: [] })
  })
})
