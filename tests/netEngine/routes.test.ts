/**
 * The route rules the app decides (1b §1.1–§1.3): how an address is classed, which route texts parse, what an owner
 * may type for Add address, what the join dialog lists, what Connect approves, what a joiner's pairback carries and
 * how a host reads one.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyIp,
  ownerRoute,
  parseRoute,
  routeText,
  ticketDestinations
} from '../../src/shared/netEngine/routes'
import { approvedHints, pairbackRoutes, splitPairback } from '../../src/mms/netEngine/routes'

describe('classifyIp (forbidden first, then the allowlist)', () => {
  it.each([
    ['192.168.1.20', 'lan'],
    ['10.0.0.1', 'lan'],
    ['172.31.255.1', 'lan'],
    ['169.254.3.4', 'lan'],
    ['fd12::1', 'lan'],
    ['100.101.7.2', 'tailnet'],
    ['fd7a:115c:a1e0::5', 'tailnet'],
    ['8.8.8.8', 'public'],
    ['2606:4700::1', 'public'],
    ['::ffff:192.168.1.2', 'lan'],
    ['127.0.0.1', 'forbidden'],
    ['::1', 'forbidden'],
    ['0.0.0.0', 'forbidden'],
    ['224.0.0.1', 'forbidden'],
    ['255.255.255.255', 'forbidden'],
    ['192.0.2.7', 'forbidden'],
    ['198.18.0.1', 'forbidden'],
    ['203.0.113.7', 'forbidden'],
    ['2001:db8::1', 'forbidden'],
    ['2002::1', 'forbidden'],
    ['64:ff9b::1', 'forbidden'],
    ['fe80::1', 'forbidden'],
    ['not-an-ip', undefined]
  ])('%s is %s', (ip, cls) => expect(classifyIp(ip)).toBe(cls))
})

describe('parseRoute', () => {
  it.each([
    ['tcp://192.168.1.20:47100', 'tcp://192.168.1.20:47100'],
    ['tcp://Host.Example:47100', 'tcp://host.example:47100'],
    ['tcp://[FD12::1]:47100', 'tcp://[fd12::1]:47100'],
    ['wss://x.example/mousse-net/1', 'wss://x.example:443/mousse-net/1'],
    ['wss://x.example:8443/a/b/mousse-net/1', 'wss://x.example:8443/a/b/mousse-net/1'],
    ['ws://127.0.0.1:9000/mousse-net/1', 'ws://127.0.0.1:9000/mousse-net/1'],
    ['ssh://me@box.example', 'ssh://me@box.example']
  ])('%s reads as %s', (text, canonical) => expect(parseRoute(text)?.canonical).toBe(canonical))

  it.each([
    ['tcp://192.168.1.20', 'no port'],
    ['tcp://192.168.1.20:0', 'port 0'],
    ['tcp://192.168.1.20:65536', 'port out of range'],
    ['wss://x.example/other', 'path without the suffix'],
    ['wss://x.example/a b/mousse-net/1', 'a space in the path'],
    ['ws://192.168.1.20:9000/mousse-net/1', 'plain ws off loopback'],
    ['ws://localhost:9000/mousse-net/1', 'plain ws to a name'],
    ['ws://127.0.0.1/mousse-net/1', 'plain ws without a port'],
    ['http://x.example', 'another scheme'],
    ['', 'nothing']
  ])('%s is refused (%s)', (text) => expect(parseRoute(text)).toBeUndefined())
})

describe('ownerRoute (what Add address takes)', () => {
  it.each([
    ['192.168.1.20:47100', 'tcp://192.168.1.20:47100'],
    ['100.101.7.2:47100', 'tcp://100.101.7.2:47100'],
    ['box.example:47100', 'tcp://box.example:47100'],
    ['https://x.example', 'wss://x.example/mousse-net/1'],
    ['https://x.example/base/', 'wss://x.example/base/mousse-net/1'],
    ['wss://x.example:8443/mousse-net/1', 'wss://x.example:8443/mousse-net/1'],
    ['ws://127.0.0.1:9000/mousse-net/1', 'ws://127.0.0.1:9000/mousse-net/1'],
    ['me@box.example', undefined],
    ['ssh://box.example', undefined],
    ['192.168.1.20', undefined]
  ])('%s → %s', (text, route) => expect(ownerRoute(text)).toBe(route))

  it('reads a route back as a person typed it', () => {
    expect(routeText('tcp://192.168.1.20:47100')).toBe('192.168.1.20:47100')
    expect(routeText('wss://x.example/mousse-net/1')).toBe('x.example')
  })
})

describe('the join dialog and Connect', () => {
  const hints = [
    'tcp://192.168.1.20:47100',
    'tcp://100.101.7.2:47100',
    'wss://x.example/mousse-net/1',
    'tcp://8.8.4.4:47100',
    'ws://127.0.0.1:9000/mousse-net/1',
    'ssh://me@box.example',
    'tcp://203.0.113.7:47100',
    'tcp://127.0.0.1:47100',
    'garbage'
  ]

  it('lists each dialable hint with its class; ws, ssh, broken and forbidden hints are skipped', () => {
    expect(ticketDestinations(hints).map((item) => [item.label, item.cls, item.automatic])).toEqual(
      [
        ['192.168.1.20:47100', 'lan', true],
        ['100.101.7.2:47100', 'tailnet', false],
        ['x.example', 'tunnel', false],
        ['8.8.4.4:47100', 'public', false]
      ]
    )
  })

  it('approves every listed hint outside the private ranges, loopback too in a debug build', () => {
    expect(approvedHints(hints)).toEqual([
      'tcp://100.101.7.2:47100',
      'wss://x.example/mousse-net/1',
      'tcp://8.8.4.4:47100',
      'tcp://127.0.0.1:47100'
    ])
  })
})

describe('pairback', () => {
  it('a joiner sends its LAN routes and only the ticked others', () => {
    const info = {
      port: 47100,
      routes: [
        'tcp://192.168.1.20:47100',
        'tcp://100.101.7.2:47100',
        'wss://x.example/mousse-net/1'
      ]
    }
    expect(pairbackRoutes(info, [])).toEqual(['tcp://192.168.1.20:47100'])
    expect(pairbackRoutes(info, ['wss://x.example/mousse-net/1'])).toEqual([
      'tcp://192.168.1.20:47100',
      'wss://x.example/mousse-net/1'
    ])
  })

  it('a host dials LAN routes, holds the others as offered, drops forbidden ones and refuses ws and ssh', () => {
    expect(
      splitPairback([
        'tcp://192.168.1.20:47100',
        'tcp://100.101.7.2:47100',
        'wss://x.example/mousse-net/1',
        'tcp://203.0.113.7:47100'
      ])
    ).toEqual({
      automatic: ['tcp://192.168.1.20:47100'],
      offered: ['tcp://100.101.7.2:47100', 'wss://x.example/mousse-net/1']
    })
    expect(splitPairback(['ws://127.0.0.1:9000/mousse-net/1'])).toBeUndefined()
    expect(splitPairback(['ssh://me@box.example'])).toBeUndefined()
  })

  it('keeps 1a’s limits: eight routes of 255 bytes at most', () => {
    const many = Array.from({ length: 10 }, (_, i) => `tcp://100.101.7.${i + 1}:47100`)
    expect(splitPairback(many)!.offered).toHaveLength(8)
    const long = `wss://${'a'.repeat(250)}.example/mousse-net/1`
    expect(splitPairback([long])!.offered).toEqual([])
  })
})

describe('loopback in a debug build (MOUSSE_NET_TEST_CLASS_MAP)', () => {
  it('is automatic except on a port the checks map to tailnet or public', async () => {
    const { automatic } = await import('../../src/mms/netEngine/routes')
    const before = process.env.MOUSSE_NET_TEST_CLASS_MAP
    try {
      process.env.MOUSSE_NET_TEST_CLASS_MAP = '47301=tailnet, 47302=public,47303=lan'
      expect(automatic('tcp://127.0.0.1:47300')).toBe(true)
      expect(automatic('tcp://127.0.0.1:47301')).toBe(false)
      expect(automatic('tcp://127.0.0.1:47302')).toBe(false)
      expect(automatic('tcp://127.0.0.1:47303')).toBe(true)
      expect(automatic('tcp://192.168.1.2:47301')).toBe(true)
      // `*=<class>`: every port the map leaves out.
      process.env.MOUSSE_NET_TEST_CLASS_MAP = '47303=lan,*=public'
      expect(automatic('tcp://127.0.0.1:47300')).toBe(false)
      expect(automatic('tcp://127.0.0.1:47303')).toBe(true)
    } finally {
      if (before === undefined) delete process.env.MOUSSE_NET_TEST_CLASS_MAP
      else process.env.MOUSSE_NET_TEST_CLASS_MAP = before
    }
  })
})
