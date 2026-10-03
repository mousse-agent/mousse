import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../src/mms/net/NetService'
import { SyncSupervisor } from '../../../src/mms/net/sync/supervisor'
import type { NodeId } from '../../../src/shared/net'

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
