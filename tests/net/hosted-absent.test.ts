import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
import { ProfileTransports } from '../../src/mms/net/transports/manager'
import { mousseIdNetModule } from '../../src/mms/net/plus'
import { canonicalAudience } from '../../src/mms/net/plus/wire/protocol'
import { canonicalHostedRelayAudience } from '../../src/mms/net/relay/hostedAudience'
import { canonicalJson, parseProtocolJson } from '../../src/mms/net/sync/codec'
import { systemClock } from '../../src/mms/net/clock'
import { NET_LOCAL_METHODS, type NetStatus } from '../../src/shared/net/local'
import type { TransportManifest } from '../../src/mms/net/contracts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-hosted-absent-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const HOSTED_ADDRESS = 'wss://id.example/v1/net/relay'

it('runs core Net without the Mousse ID module and refuses every hosted method', async () => {
  const net = new NetService({ profileDir: directory() })
  cleanup.push(() => net.shutdown())
  const status = (await net.request('net.init', { name: 'core only' })) as NetStatus
  expect(status.enabled).toBe(true)
  expect(net.request('net.plus.status', {})).toEqual({ configured: false, connected: false })
  const listed = (await net.request('net.transport.list', {})) as { manifests: TransportManifest[] }
  expect(listed.manifests.map((row) => row.id)).not.toContain('plus-relay')
  for (const method of NET_LOCAL_METHODS) {
    if (!method.startsWith('net.plus.') || method === 'net.plus.status') continue
    await expect(Promise.resolve().then(() => net.request(method, {}))).rejects.toMatchObject({
      code: 'profile_unsupported'
    })
  }
  await expect(
    net.request('net.transport.configure', {
      id: 'plus-relay',
      enabled: true,
      settings: { address: HOSTED_ADDRESS }
    })
  ).rejects.toMatchObject({ code: 'bad_request' })
  await expect(net.prepareSpaceRendezvous(Date.now() + 60_000, 1)).resolves.toBeUndefined()
})

it('lists the hosted relay only when the module is present', async () => {
  const net = new NetService({ profileDir: directory(), hosted: mousseIdNetModule })
  cleanup.push(() => net.shutdown())
  await net.request('net.init', { name: 'with module' })
  const listed = (await net.request('net.transport.list', {})) as { manifests: TransportManifest[] }
  expect(listed.manifests.map((row) => row.id)).toContain('plus-relay')
  expect(net.request('net.plus.status', {})).toEqual({ configured: false, connected: false })
})

it('keeps a stored hosted relay row but never starts it without the module', async () => {
  const path = directory()
  const first = new NetService({ profileDir: path })
  await first.request('net.init', { name: 'signed in elsewhere' })
  await first.shutdown()
  const database = new DatabaseSync(join(path, 'net', 'net.db'))
  const row = database.prepare('SELECT value FROM net_service_config WHERE singleton=1').get() as {
    value: string
  }
  const config = parseProtocolJson(Buffer.from(row.value)) as { transports?: unknown[] }
  config.transports = [
    ...(config.transports ?? []),
    { id: 'plus-relay', enabled: true, settings: { address: HOSTED_ADDRESS } }
  ]
  database
    .prepare('UPDATE net_service_config SET value=? WHERE singleton=1')
    .run(Buffer.from(canonicalJson(config)).toString())
  database.close()

  const second = new NetService({ profileDir: path })
  cleanup.push(() => second.shutdown())
  await second.start()
  const status = second.request('net.status', {}) as NetStatus
  expect(status.enabled).toBe(true)
  expect(status.error).toBeUndefined()
  expect(status.transports?.map((row) => row.id) ?? []).not.toContain('plus-relay')
  expect(status.routes.some((route) => route.transport === 'plus-relay')).toBe(false)
})

it('refuses hosted relay routes in transports built without the module', async () => {
  const transports = new ProfileTransports({
    clock: systemClock,
    profileDir: directory(),
    identity: () => {
      throw new Error('no identity needed')
    }
  })
  cleanup.push(() => transports.teardown())
  expect(transports.transports().map((row) => row.id)).not.toContain('plus-relay')
  await expect(
    transports.dial(
      { transport: 'plus-relay', address: `${HOSTED_ADDRESS}?node=x`, priority: 0 },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(() =>
    transports.validate({ id: 'plus-relay', enabled: true, settings: { address: HOSTED_ADDRESS } })
  ).toThrow()
})

it('checks hosted relay addresses in core exactly as the pinned wire copy does', () => {
  const inputs = [
    HOSTED_ADDRESS,
    'wss://id.example:8443/v1/net/relay',
    'ws://127.0.0.1:9000/v1/net/relay',
    'ws://localhost/v1/net/relay',
    'ws://[::1]:1/v1/net/relay',
    'ws://id.example/v1/net/relay',
    'https://id.example/v1/net/relay',
    'wss://id.example/v1/net/relay/',
    'wss://id.example/v1/net/relay?node=x',
    'wss://id.example/v1/net/relay#x',
    'wss://user:pass@id.example/v1/net/relay',
    'wss://id.example/mousse-relay',
    'not a url',
    ''
  ]
  const outcome = (check: (value: string) => string, value: string) => {
    try {
      return { ok: check(value) }
    } catch (error) {
      return { error: (error as { code?: string }).code }
    }
  }
  for (const input of inputs)
    expect(outcome(canonicalHostedRelayAudience, input), input).toEqual(
      outcome(canonicalAudience, input)
    )
})
