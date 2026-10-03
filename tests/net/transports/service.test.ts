import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../src/mms/net/NetService'
import { SyncSupervisor } from '../../../src/mms/net/sync/supervisor'
import type { NodeId } from '../../../src/shared/net'
import type { NetRuntime } from '../../../src/mms/net/NetService'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function profile() {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-addon-service-')), net = new NetService({ profileDir: path })
  cleanups.push(() => rmSync(path, { recursive: true, force: true }), () => net.shutdown())
  return { path, net }
}

it('reconnects an existing supervisor using an adopted newer signed endpoint instead of its initial cached endpoint', async () => {
  const a = profile(), b = profile()
  await a.net.request('net.init', { listen: true, port: 0 }); await a.net.request('net.protect', { passphrase: 'test authority protection' })
  const old = a.net.status().routes[0], invite = await a.net.request('bridge.invite', {}) as { invite: string }
  const joined = await b.net.request('bridge.join', { invite: invite.invite }) as { authority: NodeId }
  const supervisor = (b.net as unknown as { supervisors: Map<NodeId, SyncSupervisor> }).supervisors.get(joined.authority)!
  expect(supervisor).toBeInstanceOf(SyncSupervisor); expect(supervisor.state()).toBe('open')
  await a.net.request('net.init', { listen: true, port: 0 })
  expect(a.net.status().routes[0].address).not.toBe(old.address)
  await vi.waitFor(() => expect(supervisor.state()).not.toBe('open'))
  b.net.adoptRoutes(a.net.signedRoutes(), joined.authority)
  supervisor.retryAfterStateChange()
  await vi.waitFor(() => expect(supervisor.state()).toBe('open'), { timeout: 4000 })
}, 10_000)

it('composes an unenrolled runtime once and awaits the trusted domain drain before closing its real database', async () => {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-domain-drain-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  let calls = 0, closed = 0, active = 1, runtime!: NetRuntime, finish!: () => void
  const drained = new Promise<void>(resolve => { finish = () => { active = 0; resolve() } })
  const net = new NetService({ profileDir: path, composeRuntime: rt => {
    calls++; runtime = rt; expect(rt.identity.self()).toBeUndefined(); expect(rt.keys.state()).toBe('missing')
    return { activeCount: () => active, close: () => { closed++; return drained } }
  } })
  cleanups.push(() => { finish(); return net.shutdown() })
  await net.request('net.init', {})
  expect(calls).toBe(1); expect(net.runtime()).toBe(runtime); expect(net.getActiveCount()).toBe(1)
  net.beginShutdown(); let settled = false
  const shutdown = net.shutdown().then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(closed).toBe(1); expect(settled).toBe(false)
  expect(runtime.db.database.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 })
  finish(); await shutdown
  expect(settled).toBe(true); expect(() => runtime.db.database.prepare('SELECT 1')).toThrow()
})

it('opens a trusted foreign-user domain session and retains its signed routes without automatically supervising foreign nodes', async () => {
  const a = profile(), b = profile()
  await a.net.request('net.init', { listen: true }); await b.net.request('net.init', { listen: true })
  const ar = a.net.runtime(), br = b.net.runtime(), au = ar.identity.self()!, bu = br.identity.self()!
  ar.identity.pinUser(bu.user, br.keys.rootKey()!); ar.identity.acceptRoster(br.identity.roster()!, br.keys.rootKey()!)
  br.identity.pinUser(au.user, ar.keys.rootKey()!); br.identity.acceptRoster(ar.identity.roster()!, ar.keys.rootKey()!)
  const session = await a.net.connectDomainSession({ node: bu.node, user: bu.user, transportKey: br.keys.nodeKeys().transport, routes: b.net.status().routes }, new AbortController().signal)
  expect(session.state()).toBe('open'); expect(session.peer.user).toBe(bu.user)
  expect(ar.db.database.prepare('SELECT signed FROM net_peer_routes WHERE node=?').get(bu.node)).toBeDefined()
  expect((a.net as unknown as { supervisors: Map<NodeId, SyncSupervisor> }).supervisors.has(bu.node)).toBe(false)
  expect((b.net as unknown as { supervisors: Map<NodeId, SyncSupervisor> }).supervisors.has(au.node)).toBe(false)
  expect(() => a.net.adoptRoutes(b.net.signedRoutes(), bu.node)).toThrow()
})
