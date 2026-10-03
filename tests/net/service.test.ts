import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function service(): { net: NetService; path: string } {
  const path = mkdtempSync(join(tmpdir(), 'net-service-')), net = new NetService({ profileDir: path })
  cleanups.push(() => rmSync(path, { recursive: true, force: true }), () => net.shutdown())
  return { net, path }
}
it('keeps networking disabled until explicit init and listening off unless requested', async () => {
  const { net } = service(); await net.start()
  expect(net.status()).toMatchObject({ enabled: false, keystore: 'missing', routes: [] })
  await net.request('net.init', { name: 'authority' })
  expect(net.status()).toMatchObject({ enabled: true, keystore: 'unlocked', self: { isAuthority: true }, routes: [] })
  await expect(net.request('bridge.invite', {})).rejects.toMatchObject({ code: 'keystore_locked' })
  await net.request('net.protect', { passphrase: 'test-authority-protection' })
  await expect(net.request('bridge.invite', {})).rejects.toMatchObject({ code: 'route_unreachable' })
})
it('enrolls through the real direct gateway and reconnects both profiles after restart', async () => {
  const a = service(), b = service()
  await a.net.request('net.init', { name: 'authority', listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test-authority-protection' })
  const route = a.net.status().routes[0], invite = await a.net.request('bridge.invite', {}) as { invite: string }
  const enrolled = await b.net.request('bridge.join', { invite: invite.invite, name: 'follower' }) as { node: string; authority: string }
  await vi.waitFor(() => expect(a.net.status().peers).toContainEqual({ node: enrolled.node, state: 'open' }))
  expect(b.net.status().peers).toContainEqual({ node: enrolled.authority, state: 'open' })
  await a.net.shutdown(); await b.net.shutdown()
  const resumedA = new NetService({ profileDir: a.path }), resumedB = new NetService({ profileDir: b.path })
  cleanups.push(() => resumedA.shutdown(), () => resumedB.shutdown())
  await resumedA.start(); await resumedB.start()
  await resumedA.request('net.unlock', { passphrase: 'test-authority-protection' })
  expect(resumedA.status().routes[0]).toEqual(route)
  await vi.waitFor(() => expect(resumedB.status().peers).toContainEqual({ node: enrolled.authority, state: 'open' }), { timeout: 5000 })
  await resumedA.request('bridge.revoke', { node: enrolled.node })
  await vi.waitFor(() => expect(resumedB.status().peers.every(peer => peer.state !== 'open')).toBe(true))
  expect(resumedB.runtime().identity.roster()).toEqual(resumedA.runtime().identity.roster())
  expect(resumedA.status().peers.every(peer => peer.state !== 'open')).toBe(true)
})
