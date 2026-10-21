import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
import type { HostedNet, HostedNetHost } from '../../src/mms/net/hosted'
import { HostedNetController } from '../../src/mms/net/plus/HostedNetController'
import { listedDevices, type Device } from '../../src/renderer/lib/netDevices'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function service(hosted?: HostedNet): { net: NetService; path: string } {
  const path = mkdtempSync(join(tmpdir(), 'net-revoke-')),
    net = new NetService({
      profileDir: path,
      hosted: hosted && { create: () => hosted }
    })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { net, path }
}

/** A Mousse ID module that is installed but not signed in; it records roster pushes. */
function fakeHosted(): HostedNet & { rosterChanged: ReturnType<typeof vi.fn> } {
  return {
    transports: undefined as unknown as HostedNet['transports'],
    status: () => ({ configured: false }) as unknown as ReturnType<HostedNet['status']>,
    connected: () => false,
    consentFenced: () => false,
    cancelLogin: () => ({ cancelled: true }),
    enrollmentRequests: () => ({ requests: [] }),
    request: async () => undefined,
    recoverLease: async () => undefined,
    resumeRenewal: () => undefined,
    spaceJoined: async () => undefined,
    prepareSpaceRendezvous: async () => undefined,
    membershipChanged: () => undefined,
    rosterChanged: vi.fn()
  }
}

it('revoking a device closes its connection, refuses it again and sends the roster to Mousse ID', async () => {
  const hosted = fakeHosted(),
    a = service(hosted),
    b = service()
  await a.net.request('net.init', { name: 'authority', listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test-authority-protection' })
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await b.net.request('bridge.join', {
    invite: invite.invite,
    name: 'phone'
  })) as { node: string; authority: string }
  await vi.waitFor(() =>
    expect(a.net.status().peers).toContainEqual({ node: joined.node, state: 'open' })
  )
  hosted.rosterChanged.mockClear()

  await a.net.request('bridge.revoke', { node: joined.node })

  expect(hosted.rosterChanged).toHaveBeenCalled()
  await vi.waitFor(() => {
    expect(a.net.status().peers.some((peer) => peer.state === 'open')).toBe(false)
    expect(b.net.status().peers.some((peer) => peer.state === 'open')).toBe(false)
  })
  // The open session told the revoked device before closing.
  expect(b.net.runtime().identity.roster()).toEqual(a.net.runtime().identity.roster())
  const { nodes } = (await a.net.request('bridge.nodes', {})) as { nodes: Device[] }
  // Published rosters may leave out revoked delegations, so the device is gone or marked revoked.
  expect(nodes.find((node) => node.node === joined.node)?.revoked ?? true).toBe(true)
  // The revoked device's retries never open a session again.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(a.net.status().peers.some((peer) => peer.state === 'open')).toBe(false)
})

it('sends a changed roster to Mousse ID right away instead of at the next renewal', async () => {
  vi.useFakeTimers()
  const controller = new HostedNetController({
    clock: { now: () => Date.now() },
    signal: new AbortController().signal,
    loadedRuntime: () => undefined,
    requireEnrolled: () => ({}),
    closed: () => false,
    enabled: () => true,
    featureEnabled: () => true,
    hostedSpacePeerAuthorized: () => true,
    serial: (work: () => Promise<unknown>) => work(),
    emit: () => undefined,
    fail: () => undefined,
    transportRows: () => [{ id: 'plus-relay', enabled: true, settings: {} }],
    reactivateIfRunning: async () => undefined,
    suspendHostedTransport: async () => undefined
  } as unknown as HostedNetHost)
  const renew = vi.fn(async () => undefined)
  ;(controller as unknown as { hostedProfile: unknown }).hostedProfile = {
    status: () => ({
      configured: true,
      connected: true,
      registrationId: 'registration',
      expiresAt: Date.now() + 60_000
    }),
    renew,
    managedSpaceRoutes: () => [],
    reconcileSpaceRoutes: async () => undefined
  }
  controller.resumeRenewal()
  await vi.advanceTimersByTimeAsync(100)
  expect(renew).not.toHaveBeenCalled()

  controller.rosterChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect(renew).toHaveBeenCalledTimes(1)
  // The regular schedule continues afterwards, without a second immediate renewal.
  await vi.advanceTimersByTimeAsync(100)
  expect(renew).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(renew).toHaveBeenCalledTimes(2)
})

it('leaves revoked devices out of My devices', () => {
  const device = (node: string, revoked: boolean): Device => ({
    node: node as Device['node'],
    name: node,
    caps: [],
    keyEpoch: 1,
    expiresAt: 0,
    self: node === 'self',
    revoked,
    state: 'closed'
  })
  expect(
    listedDevices([device('self', false), device('phone', true), device('laptop', false)]).map(
      (row) => row.node
    )
  ).toEqual(['self', 'laptop'])
})
