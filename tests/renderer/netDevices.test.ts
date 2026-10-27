import { describe, expect, it } from 'vitest'
import {
  deviceLine,
  isIncompatible,
  lastSeenLabel,
  routeDetails,
  routeLabel,
  updateInstructions,
  type Device
} from '../../src/renderer/lib/netDevices'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const device = (patch: Partial<Device> = {}): Device => ({
  node: 'nod_vps' as Device['node'],
  name: 'Linux VPS',
  caps: ['read', 'chat', 'write'],
  keyEpoch: 1,
  expiresAt: 0,
  self: false,
  revoked: false,
  state: 'open',
  ...patch
})

describe('lastSeenLabel', () => {
  it('reads as time since, and stays empty when the device was never seen', () => {
    expect(lastSeenLabel(undefined, NOW)).toBe('')
    expect(lastSeenLabel(NOW - 10_000, NOW)).toBe('last seen just now')
    expect(lastSeenLabel(NOW - 5 * 60_000, NOW)).toBe('last seen 5m ago')
    expect(lastSeenLabel(NOW - 2 * 3600_000, NOW)).toBe('last seen 2h ago')
    expect(lastSeenLabel(NOW - 3 * 86_400_000, NOW)).toBe('last seen 3d ago')
    expect(lastSeenLabel(NOW + 60_000, NOW)).toBe('last seen just now')
  })
})

describe('routeLabel', () => {
  it('names the transports people know and keeps an unknown add-on as it is', () => {
    expect(routeLabel('ssh')).toBe('SSH')
    expect(routeLabel('tailscale')).toBe('Tailscale')
    expect(routeLabel('cloudflared')).toBe('Cloudflare tunnel')
    expect(routeLabel('direct')).toBe('direct connection')
    expect(routeLabel('plus-relay')).toBe('Mousse ID relay')
    expect(routeLabel('carrier-pigeon')).toBe('carrier-pigeon')
    expect(routeLabel(undefined)).toBe('unknown route')
  })
})

describe('deviceLine', () => {
  it('shows route and version for an online device', () => {
    const line = deviceLine(device({ version: '0.1.3', route: { transport: 'ssh', direction: 'out' } }), NOW)
    expect(line).toBe('Online · via SSH · 0.1.3 · can read, chat, write')
  })

  it('shows last seen and version for an offline device', () => {
    const line = deviceLine(device({ state: 'closed', caps: [], version: '0.1.1', lastSeenAt: NOW - 2 * 3600_000 }), NOW)
    expect(line).toBe('Offline · last seen 2h ago · 0.1.1')
  })

  it('shows last seen only while the device is not connected', () => {
    expect(deviceLine(device({ lastSeenAt: NOW - 60_000 }), NOW)).not.toContain('last seen')
    expect(deviceLine(device({ state: 'connecting', lastSeenAt: NOW - 60_000 }), NOW)).toBe('Connecting · last seen 1m ago · can read, chat, write')
  })

  it('reads a daemon without the new fields as before, never as an error', () => {
    const old = device({ state: 'closed' })
    expect(deviceLine(old, NOW)).toBe('Offline · can read, chat, write')
    expect(deviceLine(device(), NOW)).toBe('Online · can read, chat, write')
    expect(routeDetails(old)).toBe('')
    expect(isIncompatible(old)).toBe(false)
  })

  it('says when a device is too old to report its version', () => {
    expect(deviceLine(device({ state: 'closed', olderThanThis: true, lastSeenAt: NOW - 60 * 60_000 }), NOW)).toBe(
      'Offline · last seen 1h ago · older version · can read, chat, write'
    )
  })

  it('names an incompatible version, but only for a device that is not connected', () => {
    const refused = device({ state: 'closed', error: 'incompatible_peer' })
    expect(isIncompatible(refused)).toBe(true)
    expect(deviceLine(refused, NOW)).toContain('incompatible version')
    expect(isIncompatible(device({ state: 'closed', error: 'unsupported_version' }))).toBe(true)
    expect(isIncompatible(device({ state: 'closed', error: 'route_unreachable' }))).toBe(false)
    expect(isIncompatible(device({ state: 'open', error: 'incompatible_peer' }))).toBe(false)
  })
})

describe('routeDetails', () => {
  it('lists the route in use and why another route is not', () => {
    const text = routeDetails(
      device({
        route: { transport: 'tailscale', address: 'ws://100.64.0.2:4100/mousse-net', direction: 'out' },
        routes: [
          { route: { transport: 'tailscale', address: 'ws://100.64.0.2:4100/mousse-net', priority: 10 }, state: 'ok' },
          { route: { transport: 'ssh', address: 'ssh://me@box/127.0.0.1:47821', priority: 40 }, state: 'failing', lastError: 'route_unreachable' },
          { route: { transport: 'cloudflared', address: 'wss://x.trycloudflare.com', priority: 30 }, state: 'unknown' }
        ]
      })
    )
    expect(text.split('\n')).toEqual([
      'Tailscale: in use (this computer connected)',
      'SSH: failing · route_unreachable',
      'Cloudflare tunnel: not tried yet'
    ])
  })

  it('says so when the device connected to this computer', () => {
    expect(routeDetails(device({ route: { transport: 'direct', direction: 'in' } }))).toBe('direct connection: in use (connected to this computer)')
  })
})

describe('updateInstructions', () => {
  it('gives a Linux host the download command for this version', () => {
    const result = updateInstructions(device({ platform: 'linux' }), '0.1.3')
    expect(result.command).toBe(
      'curl -fL -O https://github.com/mousse-agent/mousse/releases/download/v0.1.3/mousse-cli-0.1.3-linux-x86_64.AppImage && chmod +x mousse-cli-0.1.3-linux-x86_64.AppImage'
    )
    expect(result.summary).toContain('Linux VPS')
  })

  it('points a desktop at its own app and an unknown platform at the release page', () => {
    expect(updateInstructions(device({ platform: 'darwin', name: 'Build Mac' }), '0.1.3')).toEqual({
      summary: 'Open Mousse on Build Mac and install the update to 0.1.3.'
    })
    expect(updateInstructions(device({ platform: 'win32' }), '0.1.3').command).toBeUndefined()
    const unknown = updateInstructions(device(), '0.1.3')
    expect(unknown.command).toBeUndefined()
    expect(unknown.summary).toContain('releases/tag/v0.1.3')
  })
})
