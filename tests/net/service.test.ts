import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
import type { Clock } from '../../src/mms/net/contracts'
import { NODE_DELEGATION_TTL_MS } from '../../src/shared/net/limits'
import type { Roster } from '../../src/shared/net'
import { FakeClock } from './harness/FakeClock'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function service(clock?: Clock): { net: NetService; path: string } {
  const path = mkdtempSync(join(tmpdir(), 'net-service-')),
    net = new NetService({ profileDir: path, clock })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { net, path }
}
it('renews through the owner timer when the authority clock ticks between reads', async () => {
  const clock = new FakeClock(Date.now()),
    { net } = service(clock)
  await net.request('net.init', { name: 'authority' })
  const rt = net.runtime(),
    original = rt.identity.verifySigned<Roster>(rt.identity.roster()!, rt.keys.rootKey()!)
  clock.setWallTime(clock.now() + NODE_DELEGATION_TTL_MS - 12 * 3600000)
  const readNow = clock.now.bind(clock),
    tick = vi.spyOn(clock, 'now').mockImplementation(() => {
      const now = readNow()
      clock.setWallTime(now + 1)
      return now
    })
  try {
    clock.advance(3600000)
    expect(net.status().error).toBeUndefined()
    const renewed = rt.identity.verifySigned<Roster>(rt.identity.roster()!, rt.keys.rootKey()!)
    expect(renewed.version).toBe(original.version + 1)
    expect(renewed.authorityNode).toBe(original.authorityNode)
    const delegation = rt.identity.verifySigned<{ issuedAt: number; expiresAt: number }>(
      renewed.nodes[0],
      rt.keys.rootKey()!
    )
    expect(delegation.issuedAt).toBeGreaterThan(original.issuedAt)
    expect(delegation.expiresAt - delegation.issuedAt).toBe(NODE_DELEGATION_TTL_MS)
  } finally {
    tick.mockRestore()
  }
})
it('keeps networking disabled until explicit init and listening off unless requested', async () => {
  const { net } = service()
  await net.start()
  expect(net.status()).toMatchObject({ enabled: false, keystore: 'missing', routes: [] })
  await net.request('net.init', { name: 'authority' })
  expect(net.status()).toMatchObject({
    enabled: true,
    keystore: 'unlocked',
    self: { isAuthority: true },
    routes: []
  })
  await expect(net.request('bridge.invite', {})).rejects.toMatchObject({ code: 'keystore_locked' })
  await net.request('net.protect', { passphrase: 'test-authority-protection' })
  await expect(net.request('bridge.invite', {})).rejects.toMatchObject({
    code: 'route_unreachable'
  })
})
it('enrolls through the real direct gateway and reconnects both profiles after restart', async () => {
  const a = service(),
    b = service()
  await a.net.request('net.init', { name: 'authority', listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test-authority-protection' })
  const route = a.net.status().routes[0],
    invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const enrolled = (await b.net.request('bridge.join', {
    invite: invite.invite,
    name: 'follower'
  })) as { node: string; authority: string }
  await vi.waitFor(() =>
    expect(a.net.status().peers).toContainEqual({ node: enrolled.node, state: 'open' })
  )
  expect(b.net.status().peers).toContainEqual({ node: enrolled.authority, state: 'open' })
  await a.net.shutdown()
  await b.net.shutdown()
  const resumedA = new NetService({ profileDir: a.path }),
    resumedB = new NetService({ profileDir: b.path })
  cleanups.push(
    () => resumedA.shutdown(),
    () => resumedB.shutdown()
  )
  await resumedA.start()
  await resumedB.start()
  await resumedA.request('net.unlock', { passphrase: 'test-authority-protection' })
  expect(resumedA.status().routes[0]).toEqual(route)
  await vi.waitFor(
    () =>
      expect(resumedB.status().peers).toContainEqual({ node: enrolled.authority, state: 'open' }),
    { timeout: 5000 }
  )
  await resumedA.request('bridge.revoke', { node: enrolled.node })
  await vi.waitFor(() =>
    expect(resumedB.status().peers.every((peer) => peer.state !== 'open')).toBe(true)
  )
  expect(resumedB.runtime().identity.roster()).toEqual(resumedA.runtime().identity.roster())
  expect(resumedA.status().peers.every((peer) => peer.state !== 'open')).toBe(true)
})
it('orchestrates protected transfer and resumes by reading receipts without repeating mutations', async () => {
  const a = service(),
    b = service()
  await a.net.request('net.init', { listen: true })
  await a.net.request('net.protect', { passphrase: 'test-source-protection' })
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await b.net.request('bridge.join', { invite: invite.invite })) as {
    node: string
    authority: string
  }
  // Join waits for the follower's hello gates. The authority may still be
  // processing its acknowledgment when this separate owner request starts.
  await vi.waitFor(() =>
    expect(a.net.status().peers).toContainEqual({ node: joined.node, state: 'open' })
  )
  await expect(
    a.net.request('net.authority.transfer', { node: joined.node })
  ).rejects.toMatchObject({ code: 'keystore_locked' })
  expect(a.net.runtime().identity.authorityTransferState()).toBeUndefined()
  await b.net.request('net.protect', { passphrase: 'test-target-protection' })
  const exported = (await a.net.request('net.recovery.export', {
    passphrase: 'test-offline-recovery'
  })) as { file: string }
  expect(exported.file).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(await a.net.request('net.authority.transfer', { node: joined.node })).toMatchObject({
    phase: 'activated',
    authority: joined.node
  })
  expect(a.net.status().self?.isAuthority).toBe(false)
  expect(a.net.runtime().keys.rootKey()).toBeUndefined()
  expect(b.net.status().self?.isAuthority).toBe(true)
  const aliases = a.net
    .runtime()
    .db.database.prepare('SELECT import_rpc,activation_rpc FROM net_authority_delivery')
    .get()
  await a.net.shutdown()
  await b.net.shutdown()
  const resumedA = new NetService({ profileDir: a.path }),
    resumedB = new NetService({ profileDir: b.path })
  cleanups.push(
    () => resumedA.shutdown(),
    () => resumedB.shutdown()
  )
  await resumedA.start()
  await resumedB.start()
  await resumedA.request('net.unlock', { passphrase: 'test-source-protection' })
  await resumedB.request('net.unlock', { passphrase: 'test-target-protection' })
  await vi.waitFor(
    () =>
      expect(
        resumedA.status().peers.some((peer) => peer.node === joined.node && peer.state === 'open')
      ).toBe(true),
    { timeout: 5000 }
  )
  expect(await resumedA.request('net.authority.transfer', { node: joined.node })).toMatchObject({
    phase: 'activated'
  })
  expect(
    resumedA
      .runtime()
      .db.database.prepare('SELECT import_rpc,activation_rpc FROM net_authority_delivery')
      .get()
  ).toEqual(aliases)
  // Recovery is an explicit owner operation on the selected survivor.
  await resumedB.shutdown()
  expect(
    await resumedA.request('net.recovery.import', {
      file: exported.file,
      passphrase: 'test-offline-recovery',
      becomeAuthority: true
    })
  ).toMatchObject({ self: { isAuthority: true } })
})
