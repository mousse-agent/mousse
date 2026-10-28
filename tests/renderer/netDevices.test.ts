import { describe, expect, it } from 'vitest'
import {
  bindSettings,
  canWorkOnThreads,
  capabilityLabel,
  deviceLine,
  isComputer,
  isIncompatible,
  lastSeenLabel,
  netErrorWords,
  PAIRING_DISCLOSURE,
  routeDetails,
  routeLabel,
  serveSettings,
  updateInstructions,
  workOnThreadsDisclosure,
  worksOnThreads,
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

describe('Tailscale settings for Serve', () => {
  const saved = { binary: 'C:\\Program Files\\Tailscale\\tailscale.exe', port: 47000 }
  it('keeps the saved binary when Serve is turned on and when it is turned off', () => {
    expect(serveSettings(saved, 47890, 47890)).toEqual({
      binary: saved.binary,
      mode: 'serve',
      port: 47890,
      servePort: 47890
    })
    expect(bindSettings({ ...saved, mode: 'serve', servePort: 47890 })).toEqual(saved)
  })
  it('starts from nothing when no settings are saved', () => {
    expect(serveSettings(undefined, 1, 2)).toEqual({ mode: 'serve', port: 1, servePort: 2 })
    expect(bindSettings(undefined)).toEqual({})
    expect(bindSettings([1])).toEqual({})
  })
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

describe('what this computer lets a device do here, in the device line', () => {
  const policy = (patch: Partial<NonNullable<Device['policy']>> = {}) => ({ blocked: false, maxPermissionMode: 'accept_edits' as const, terminal: false, ...patch })
  const computer = (patch: Partial<Device> = {}) => device({ kind: 'computer', caps: ['read', 'chat', 'write', 'settings'], policy: policy(), ...patch })

  it('shows the default limit and the terminal switch for a computer that works on threads', () => {
    expect(deviceLine(computer(), NOW)).toBe('Online · can read, chat, write, work on threads · highest mode here: Auto-accept edits · terminals off')
  })

  it('shows a raised limit and terminals that were turned on', () => {
    expect(deviceLine(computer({ policy: policy({ maxPermissionMode: 'full', terminal: true }) }), NOW)).toContain('highest mode here: Full access · terminals on')
    expect(deviceLine(computer({ policy: policy({ maxPermissionMode: 'ask' }) }), NOW)).toContain('highest mode here: Ask before acting')
  })

  it('says nothing of limits for a phone, for a computer that does not work on threads, or from a daemon without them', () => {
    expect(deviceLine(computer({ kind: 'phone' }), NOW)).not.toContain('highest mode')
    expect(deviceLine(computer({ caps: ['read', 'chat', 'write'] }), NOW)).not.toContain('highest mode')
    expect(deviceLine(computer({ policy: undefined }), NOW)).not.toContain('highest mode')
  })

  it('says a blocked device is blocked, and not what it could have done', () => {
    const line = deviceLine(computer({ policy: policy({ blocked: true }) }), NOW)
    expect(line).toContain('blocked on this computer')
    expect(line).not.toContain('highest mode')
  })
})

describe('works on threads and blocking', () => {
  it('calls the settings capability "work on threads" in the device line', () => {
    expect(capabilityLabel('settings')).toBe('work on threads')
    expect(capabilityLabel('read')).toBe('read')
    expect(deviceLine(device({ caps: ['read', 'chat', 'write', 'settings'] }), NOW)).toBe(
      'Online · can read, chat, write, work on threads'
    )
  })

  it('offers the grant only for a device recorded as a computer', () => {
    expect(worksOnThreads(device({ caps: ['read', 'settings'] }))).toBe(true)
    expect(worksOnThreads(device())).toBe(false)
    expect(canWorkOnThreads(device({ kind: 'computer' }))).toBe(true)
    expect(canWorkOnThreads(device({ kind: 'phone' }))).toBe(false)
    expect(canWorkOnThreads(device({ kind: 'unknown' }))).toBe(false)
    expect(canWorkOnThreads(device())).toBe(false)
    // Limits are about the thread API, which a phone does not have.
    expect(isComputer(device({ kind: 'phone' }))).toBe(false)
    expect(isComputer(device({ kind: 'computer' }))).toBe(true)
    expect(isComputer(device({ kind: 'unknown' }))).toBe(true)
  })

  it('says a device is blocked on this computer, and reads a daemon without policy as before', () => {
    const policy = { blocked: true, maxPermissionMode: 'accept_edits' as const, terminal: false }
    expect(deviceLine(device({ policy }), NOW)).toBe('Online · can read, chat, write · blocked on this computer')
    expect(deviceLine(device({ policy: { ...policy, blocked: false } }), NOW)).toBe('Online · can read, chat, write')
    expect(deviceLine(device(), NOW)).toBe('Online · can read, chat, write')
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
  const lines = (command?: string) => (command ?? '').split('\n')

  it('gives a headless Linux x86_64 host the full sequence for this version', () => {
    const result = updateInstructions(device({ platform: 'linux', arch: 'x64' }), '0.1.3')
    const script = lines(result.command)
    const base = 'https://github.com/mousse-agent/mousse/releases/download/v0.1.3'
    expect(script).toContain(`curl -fLO ${base}/mousse-cli-0.1.3-linux-x86_64.AppImage`)
    expect(script).toContain(`curl -fLO ${base}/SHA256SUMS-0.1.3.txt`)
    expect(script).toContain('sha256sum -c --ignore-missing SHA256SUMS-0.1.3.txt')
    expect(script).toContain('export ELECTRON_DISABLE_SANDBOX=1')
    expect(script.at(-1)).toBe('systemctl --user restart mousse-mms')
    expect(result.command).toContain('Environment=ELECTRON_DISABLE_SANDBOX=1')
    // Stops at the first failure, and verifies before it installs anything.
    expect(script[0]).toBe('set -e')
    expect(script.findIndex((line) => line.startsWith('sha256sum'))).toBeLessThan(script.findIndex((line) => line.includes('service install')))
    expect(result.summary).toContain('Linux VPS')
    expect(result.summary).toContain('desktop app')
  })

  it('offers no command for Linux on another architecture or one that did not report it', () => {
    const arm = updateInstructions(device({ platform: 'linux', arch: 'arm64' }), '0.1.3')
    expect(arm.command).toBeUndefined()
    expect(arm.summary).toContain('arm64')
    expect(updateInstructions(device({ platform: 'linux' }), '0.1.3').command).toBeUndefined()
  })

  it('says a Mac has no in-app update and names the download for its chip', () => {
    const arm = updateInstructions(device({ platform: 'darwin', arch: 'arm64', name: 'Build Mac' }), '0.1.3')
    expect(arm.command).toBeUndefined()
    expect(arm.summary).toContain("can't update itself")
    expect(arm.summary).toContain('Mousse-0.1.3-arm64.dmg')
    expect(arm.summary).not.toContain('x64')
    expect(updateInstructions(device({ platform: 'darwin', arch: 'x64' }), '0.1.3').summary).toContain('Mousse-0.1.3-x64.dmg')
    const either = updateInstructions(device({ platform: 'darwin' }), '0.1.3').summary
    expect(either).toContain('arm64.dmg')
    expect(either).toContain('x64.dmg')
  })

  it('tells Windows to let the app update, and an unknown platform to use the release page', () => {
    const windows = updateInstructions(device({ platform: 'win32' }), '0.1.3')
    expect(windows.command).toBeUndefined()
    expect(windows.summary).toContain('updates itself')
    expect(windows.summary).toContain('Mousse.Setup.0.1.3.exe')
    const unknown = updateInstructions(device(), '0.1.3')
    expect(unknown.command).toBeUndefined()
    expect(unknown.summary).toContain('releases/tag/v0.1.3')
  })

  it('never builds a command from a target that is not a version', () => {
    const result = updateInstructions(device({ platform: 'linux', arch: 'x64' }), '1.0; rm -rf ~')
    expect(result.command).toBeUndefined()
    expect(result.summary.length).toBeGreaterThan(0)
  })
})

describe('what pairing and granting say they open', () => {
  it('says at pairing, in both directions, what a paired computer can do and what stays off', () => {
    expect(PAIRING_DISCLOSURE).toContain('each computer can run and change threads on the other')
    expect(PAIRING_DISCLOSURE).toContain('Auto-accept edits')
    expect(PAIRING_DISCLOSURE).toContain('Terminals stay off')
    expect(PAIRING_DISCLOSURE).toContain('limit or block either one in Devices')
  })

  it('names the computer and the limit when a grant or a kind is confirmed, and says it works both ways', () => {
    const words = workOnThreadsDisclosure('Computer B')
    expect(words).toContain('Computer B will be able to run and change threads on this computer, up to Auto-accept edits')
    expect(words).toContain("commit and push with this computer's sign-ins")
    expect(words).toContain('This computer can do the same on Computer B')
    expect(words).toContain('Terminals stay off')
    expect(workOnThreadsDisclosure('Computer B', 'full')).toContain('up to Full access')
  })
})

describe('Net errors in words', () => {
  it('turns the codes a person sees on the Devices screen into sentences, and softens an unknown one', () => {
    expect(netErrorWords('route_unreachable')).toBe('none of your other devices can be reached right now')
    expect(netErrorWords('some_new_code')).toBe('some new code')
  })
})
