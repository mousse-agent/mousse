import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import type { NodeId } from '../../../src/shared/net'

// Keep real multicast/TCP/TLS while avoiding the host WiFi firewall and unrelated LAN peers.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () => ({ test: [{ family: 'IPv4', internal: false, address: '127.0.0.1' }] })
}))

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function profile() {
  const path = mkdtempSync(join(tmpdir(), 'mousse-lan-offline-'))
  const net = new NetService({ profileDir: path })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}

// Real UDP discovery, TCP/WebSocket, pinned TLS and authenticated session; no hosted relay.
// Inputs: paired/unpaired, listener disabled, both restarted, changed ephemeral LAN ports.
it('paired computers reconnect after both restart with no configured listener or relay', async () => {
  const a = profile(),
    b = profile(),
    stranger = profile()
  await a.net.request('net.init', { listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'lan-test-protection' })
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const paired = (await b.net.request('bridge.join', { invite: invite.invite })) as {
    authority: NodeId
    node: NodeId
  }
  await a.net.request('net.transport.configure', {
    id: 'direct',
    enabled: false,
    settings: { port: 0 }
  })
  await a.net.shutdown()
  await b.net.shutdown()
  const resumedA = new NetService({ profileDir: a.path }),
    resumedB = new NetService({ profileDir: b.path })
  cleanups.push(
    () => resumedA.shutdown(),
    () => resumedB.shutdown()
  )
  await stranger.net.request('net.init', {})
  await resumedA.start()
  await resumedB.start()
  await resumedA.request('net.unlock', { passphrase: 'lan-test-protection' })
  expect(resumedA.status().routes).toEqual([])
  expect(resumedB.status().routes).toEqual([])
  await vi.waitFor(
    () => {
      expect(resumedB.status().peers).toContainEqual({ node: paired.authority, state: 'open' })
      expect(resumedA.status().peers).toContainEqual({ node: paired.node, state: 'open' })
    },
    { timeout: 20_000 }
  )
  expect(stranger.net.status().peers).toEqual([])
  await resumedA.request('bridge.revoke', { node: paired.node })
  await vi.waitFor(() => {
    expect(resumedA.status().peers.some((peer) => peer.state === 'open')).toBe(false)
    expect(resumedB.status().peers.some((peer) => peer.state === 'open')).toBe(false)
  })
  expect(resumedB.runtime().identity.roster()).toEqual(resumedA.runtime().identity.roster())
}, 30_000)
