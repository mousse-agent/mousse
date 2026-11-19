import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
import { mousseIdNetModule } from '../../src/mms/net/plus'
import type { HostedNet, HostedNetHost, HostedNetModule } from '../../src/mms/net/hosted'
import { parseProtocolJson } from '../../src/mms/net/sync/codec'
import type { NetStatus } from '../../src/shared/net/local'
import type { TransportManifest } from '../../src/mms/net/contracts'

// Settings → Labs → Mousse Plus (legacy): off, a profile's Net runs as a build without the Mousse ID module and sends
// nothing to Mousse Plus; on again, the module comes back with the saved hosted relay row.

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-plus-legacy-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const HOSTED_ROW = { id: 'plus-relay', enabled: false, settings: { address: 'wss://id.example/v1/net/relay' } }

/** The real Mousse ID module, with each controller and the host it was given kept for the test to look at. */
function watchedModule() {
  const made: Array<{ host: HostedNetHost; controller: HostedNet }> = []
  const module: HostedNetModule = {
    create: (host) => {
      const controller = mousseIdNetModule.create(host)
      vi.spyOn(controller, 'identityReset')
      vi.spyOn(controller, 'recoverLease')
      vi.spyOn(controller, 'resumeRenewal')
      made.push({ host, controller })
      return controller
    }
  }
  return { module, made }
}

const manifests = async (net: NetService) =>
  ((await net.request('net.transport.list', {})) as { manifests: TransportManifest[] }).manifests.map((row) => row.id)

function savedRows(profileDir: string): Array<{ id: string }> {
  const database = new DatabaseSync(join(profileDir, 'net', 'net.db'))
  try {
    const row = database.prepare('SELECT value FROM net_service_config WHERE singleton=1').get() as { value: string }
    return (parseProtocolJson(Buffer.from(row.value)) as { transports?: Array<{ id: string }> }).transports ?? []
  } finally {
    database.close()
  }
}

it('turning Mousse Plus (legacy) off stops the module, drops the hosted relay and keeps networking on', async () => {
  const profileDir = directory()
  const { module, made } = watchedModule()
  const net = new NetService({ profileDir, hosted: module })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { name: 'laptop' })
  await net.request('net.transport.configure', HOSTED_ROW)
  expect(await manifests(net)).toContain('plus-relay')
  const first = made[0]!

  await net.setPlusLegacy(false)

  expect(first.host.signal.aborted).toBe(true)
  expect(first.controller.identityReset).toHaveBeenCalled()
  expect(net.request('net.plus.status', {})).toEqual({ configured: false, connected: false })
  await expect(Promise.resolve().then(() => net.request('net.plus.login.cancel', {}))).rejects.toMatchObject({
    code: 'profile_unsupported',
    message: expect.stringContaining('Labs')
  })
  await expect(Promise.resolve().then(() => net.request('net.plus.discover', { apiOrigin: 'https://id.example' }))).rejects.toMatchObject({
    code: 'profile_unsupported'
  })
  // The transports were rebuilt without the hosted relay; the rest of networking stays on.
  expect(await manifests(net)).not.toContain('plus-relay')
  const status = net.request('net.status', {}) as NetStatus
  expect(status.enabled).toBe(true)
  expect(status.transports?.map((row) => row.id)).toContain('direct')
  expect(status.routes.some((route) => route.transport === 'plus-relay')).toBe(false)

  // A late call from the stopped module (a sign-out or renewal that was under way) changes nothing.
  first.host.saveHostedTransport(undefined)
  await first.host.restartTransports()
  expect(savedRows(profileDir).map((row) => row.id)).toContain('plus-relay')
  expect(await manifests(net)).not.toContain('plus-relay')

  // On again: a new module, its lease recovered before the transports start, and the saved row back in use.
  await net.setPlusLegacy(true)
  expect(made).toHaveLength(2)
  const second = made[1]!
  expect(second.host.signal.aborted).toBe(false)
  expect(second.controller.recoverLease).toHaveBeenCalledOnce()
  expect(second.controller.resumeRenewal).toHaveBeenCalledOnce()
  expect(await manifests(net)).toContain('plus-relay')
  expect(savedRows(profileDir).map((row) => row.id)).toContain('plus-relay')
  expect((net.request('net.status', {}) as NetStatus).enabled).toBe(true)
})

it('a profile whose switch is off at start never runs the module', async () => {
  const profileDir = directory()
  const { module, made } = watchedModule()
  const net = new NetService({ profileDir, hosted: module, plusLegacyOff: true })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { name: 'desk' })
  expect(made).toHaveLength(0)
  expect(await manifests(net)).not.toContain('plus-relay')
  await expect(Promise.resolve().then(() => net.request('net.plus.enrollment.requests', {}))).rejects.toMatchObject({
    code: 'profile_unsupported',
    message: expect.stringContaining('Labs')
  })
  // Setting it to what it already is does nothing.
  await net.setPlusLegacy(false)
  expect(made).toHaveLength(0)
  await net.setPlusLegacy(true)
  expect(made).toHaveLength(1)
  expect(await manifests(net)).toContain('plus-relay')
})
