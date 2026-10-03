import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { MmsProtocolServer } from '../../../src/mms/protocol/server'
import { LocalMmsClient } from '../../../src/mms/protocol/client'
import { NET_LOCAL_METHODS } from '../../../src/shared/net/local'
import { systemClock } from '../../../src/mms/net/clock'
import { newId } from '../../../src/shared/net'
import { FakeClock } from '../harness/FakeClock'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-default-off-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

it('rejects every non-opt-in Net method without composing runtime or creating any net files', async () => {
  const path = directory()
  const composeRuntime = vi.fn()
  const setTimeout = vi.fn(systemClock.setTimeout)
  const net = new NetService({ profileDir: path, composeRuntime, clock: { ...systemClock, setTimeout } })
  cleanup.push(() => net.shutdown())
  await net.start()
  expect(net.request('net.status', {})).toMatchObject({ enabled: false, routes: [], peers: [] })
  for (const method of NET_LOCAL_METHODS) {
    if (['net.status', 'net.init', 'bridge.join'].includes(method)) continue
    await expect(Promise.resolve().then(() => net.request(method, {}))).rejects.toMatchObject({
      code: 'disabled',
      message: 'Mousse Net is disabled for this profile. Opt in with net init or bridge join.'
    })
    expect(existsSync(join(path, 'net'))).toBe(false)
  }
  expect(composeRuntime).not.toHaveBeenCalled()
  expect(setTimeout).not.toHaveBeenCalled()
  expect(net.getActiveCount()).toBe(0)
})

it('does not create a ledger or keys while rejecting the original bridge.nodes read', async () => {
  const path = directory()
  const net = new NetService({ profileDir: path })
  cleanup.push(() => net.shutdown())
  const error = await Promise.resolve()
    .then(() => net.request('bridge.nodes', {}))
    .catch((error) => error)
  expect(existsSync(join(path, 'net'))).toBe(false)
  expect(error).toMatchObject({ code: 'disabled' })
})

it('rejects read-only and mutating composed IPC domains without creating profile net state', async () => {
  const root = directory()
  const main = await MousseMainService.create({
    homeDir: join(root, 'home'),
    repoRoot: root,
    headless: true,
    requireOwnership: false
  })
  cleanup.push(() => main.stop())
  const server = new MmsProtocolServer({ mms: main, ownerToken: 'default-off-owner' })
  const endpoint = await server.start()
  cleanup.push(() => server.stop())
  const client = new LocalMmsClient({
    homeDir: join(root, 'home'),
    endpoint,
    ownerToken: 'default-off-owner',
    requestedCapabilities: ['profiles-v1']
  })
  cleanup.push(() => client.close())
  await client.connect()
  const profileId = main.getInstallationHost()!.getDefaultProfileId()
  await client.request('profiles.bind', { profile: profileId })
  const services = await main.getProfileServices(profileId)
  const path = join(services.homeDir, 'net')
  expect(await client.request('net.status', {})).toMatchObject({ enabled: false, routes: [], peers: [] })
  expect(existsSync(path)).toBe(false)
  const calls = [
    ['bridge.nodes', {}],
    ['bridge.hub.threads', { target: newId('node') }],
    ['spaces.list', {}],
    ['spaces.create', { name: 'Rejected' }],
    ['spaces.archive.status', {}],
    ['bots.list', {}],
    ['bridge.invite', {}]
  ] as const
  for (const [method, params] of calls) {
    await expect(client.request(method, params)).rejects.toMatchObject({ code: 'disabled' })
    expect(existsSync(path)).toBe(false)
  }
  expect(services.net.getActiveCount()).toBe(0)
})

it('cancels renewal on disable and starts no network timer after a disabled restart', async () => {
  const path = directory()
  const clock = new FakeClock()
  const net = new NetService({ profileDir: path, clock })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', {})
  expect(clock.pending()).toBeGreaterThan(0)
  await net.request('net.disable', {})
  expect(clock.pending()).toBe(0)
  expect(existsSync(join(path, 'net', 'net.db'))).toBe(true)
  expect(existsSync(join(path, 'net', 'keys.json'))).toBe(true)
  await net.shutdown()
  const restarted = new NetService({ profileDir: path, clock })
  cleanup.push(() => restarted.shutdown())
  await restarted.start()
  expect(restarted.status()).toMatchObject({ enabled: false, routes: [], peers: [] })
  expect(clock.pending()).toBe(0)
  expect(restarted.getActiveCount()).toBe(0)
})

it('keeps status and rejected reads side-effect-free before starting a previously disabled profile', async () => {
  const path = directory()
  const net = new NetService({ profileDir: path })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', {})
  await net.request('net.disable', {})
  await net.shutdown()
  const before = readdirSync(join(path, 'net'), { recursive: true })
  const restarted = new NetService({ profileDir: path })
  cleanup.push(() => restarted.shutdown())
  expect(restarted.request('net.status', {})).toMatchObject({ enabled: false, routes: [], peers: [] })
  expect(() => restarted.request('bridge.nodes', {})).toThrow(expect.objectContaining({ code: 'disabled' }))
  expect(readdirSync(join(path, 'net'), { recursive: true })).toEqual(before)
})
