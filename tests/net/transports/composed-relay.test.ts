import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NetService } from '../../../src/mms/net/NetService'
import { registerNetMethods } from '../../../src/mms/net/registerMethods'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../../src/mms/protocol/handlers'
import { RelayServer } from '../../../src/mms/net/relay/server'
import { newId, type NodeId } from '../../../src/shared/net'

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function profile() {
  const path = mkdtempSync(join(tmpdir(), 'mousse-composed-relay-')),
    net = new NetService({ profileDir: path })
  cleanup.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}
it('composes signed protected relay enrollment, actual normal sessions and protected restart without bearer persistence in SQLite', async () => {
  const a = profile(),
    b = profile()
  await a.net.request('net.init', {})
  await a.net.request('net.protect', { passphrase: 'authority-keystore-password' })
  const rt = a.net.runtime(),
    self = rt.identity.self()!
  const relay = new RelayServer({
    databasePath: join(a.path, 'relay.sqlite'),
    allowUsers: [{ user: self.user, rootKey: rt.keys.rootKey()! }]
  })
  cleanup.push(() => relay.close())
  await relay.listen()
  const configured = await a.net.request('net.transport.configure', {
    id: 'relay',
    enabled: true,
    settings: { address: relay.address() }
  })
  expect(configured).toMatchObject({
    transports: [
      expect.objectContaining({ id: 'direct', enabled: false }),
      expect.objectContaining({ id: 'relay', enabled: true, state: 'ready' })
    ]
  })
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const outer = JSON.parse(Buffer.from(invite.invite.slice(4), 'base64url').toString()),
    auth = JSON.parse(Buffer.from(outer.authorization.payload, 'base64url').toString())
  expect(auth.rendezvous).toMatchObject({
    transport: 'relay',
    relay: relay.address(),
    expiresAt: auth.expiresAt
  })
  expect(JSON.stringify(a.net.status())).not.toContain(auth.rendezvous.ticket)
  expect(
    String(
      rt.db.database.prepare('SELECT authorization FROM net_enrollment_invites').get()!
        .authorization
    )
  ).not.toContain(auth.rendezvous.ticket)
  await expect(b.net.request('bridge.join', { invite: invite.invite })).rejects.toMatchObject({
    code: 'keystore_locked'
  })
  expect(b.net.runtime().keys.state()).toBe('missing')
  const joined = (await b.net.request('bridge.join', {
    invite: invite.invite,
    passphrase: 'follower-keystore-password'
  })) as { node: NodeId; authority: NodeId }
  expect(b.net.status()).toMatchObject({
    protected: true,
    peers: [expect.objectContaining({ node: self.node, state: 'open' })]
  })
  await vi.waitFor(() =>
    expect(
      a.net.status().peers.some((row) => row.node === joined.node && row.state === 'open')
    ).toBe(true)
  )
  expect(
    await b.net
      .session(joined.authority)
      .rpc('authority.transfer.ready', {}, { id: newId('rpc'), deadlineMs: 3000 })
  ).toMatchObject({ protected: true, node: self.node })
  expect(
    String(
      b.net.runtime().db.database.prepare('SELECT journal FROM net_enrollment_join').get()!.journal
    )
  ).not.toContain(auth.rendezvous.ticket)
  expect(b.net.runtime().enrollment.preparedNodeJoin()!.rendezvous).toEqual(auth.rendezvous)
  await b.net.shutdown()
  expect(
    readFileSync(join(b.path, 'net', 'net.db')).includes(Buffer.from(auth.rendezvous.ticket))
  ).toBe(false)
  const resumed = new NetService({ profileDir: b.path })
  cleanup.push(() => resumed.shutdown())
  await resumed.start()
  expect(resumed.status().keystore).toBe('locked')
  await resumed.request('net.unlock', { passphrase: 'follower-keystore-password' })
  expect(resumed.runtime().enrollment.preparedNodeJoin()!.rendezvous).toEqual(auth.rendezvous)
  await vi.waitFor(
    () =>
      expect(
        resumed.status().peers.some((row) => row.node === self.node && row.state === 'open')
      ).toBe(true),
    { timeout: 5000 }
  )
}, 15_000)

it('validates add-on settings before persistence and leaves protected blank join preparation unable to create a new authority', async () => {
  const a = profile(),
    b = profile()
  await a.net.request('net.init', { listen: true })
  await a.net.request('net.protect', { passphrase: 'protected-authority' })
  const before = a.net.runtime().db.database.prepare('SELECT value FROM net_service_config').get()
  await expect(
    a.net.request('net.transport.configure', {
      id: 'relay',
      enabled: true,
      settings: { address: 'ws://127.0.0.1/mousse-relay', token: 'unexpected secret' }
    })
  ).rejects.toMatchObject({ code: 'bad_request' })
  expect(a.net.runtime().db.database.prepare('SELECT value FROM net_service_config').get()).toEqual(
    before
  )
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  await a.net.shutdown()
  await expect(
    b.net.request('bridge.join', { invite: invite.invite, passphrase: 'prepared-follower' })
  ).rejects.toMatchObject({ code: 'route_unreachable' })
  expect(b.net.status()).toMatchObject({ protected: true, keystore: 'unlocked' })
  expect(b.net.runtime().identity.self()).toBeUndefined()
  expect(b.net.runtime().keys.rootKey()).toBeUndefined()
  await expect(b.net.request('net.init', {})).rejects.toMatchObject({ code: 'conflict' })
})

it('persists selected fake-binary cloudflared settings and signs newer route withdrawal and child recovery versions', async () => {
  const a = profile(),
    binary = join(a.path, 'cloudflared-fixture'),
    counter = join(a.path, 'starts')
  writeFileSync(
    binary,
    `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('fixture');process.exit(0)}const fs=require('fs'),p=${JSON.stringify(counter)},n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));console.error('https://start'+n+'.trycloudflare.com');console.error('Registered tunnel connection');if(!n)setTimeout(()=>process.exit(2),150);else setInterval(()=>{},1000)`,
    { mode: 0o700 }
  )
  await a.net.request('net.init', {})
  await a.net.request('net.transport.configure', {
    id: 'cloudflared',
    enabled: true,
    settings: { mode: 'quick', binary }
  })
  const initial = JSON.parse(Buffer.from(a.net.signedRoutes().payload, 'base64url').toString())
  expect(initial.routes).toEqual([
    { transport: 'cloudflared', address: 'wss://start0.trycloudflare.com/mousse-net', priority: 30 }
  ])
  await vi.waitFor(() => expect(a.net.status().routes).toEqual([]))
  const withdrawn = JSON.parse(Buffer.from(a.net.signedRoutes().payload, 'base64url').toString())
  expect(withdrawn.version).toBeGreaterThan(initial.version)
  await vi.waitFor(
    () =>
      expect(a.net.status().routes[0]?.address).toBe('wss://start1.trycloudflare.com/mousse-net'),
    { timeout: 4000 }
  )
  const recovered = JSON.parse(Buffer.from(a.net.signedRoutes().payload, 'base64url').toString())
  expect(recovered.version).toBeGreaterThan(withdrawn.version)
  await a.net.shutdown()
  const resumed = new NetService({ profileDir: a.path })
  cleanup.push(() => resumed.shutdown())
  await resumed.start()
  expect(resumed.status().transports).toContainEqual(
    expect.objectContaining({ id: 'cloudflared', enabled: true, state: 'ready' })
  )
  expect(resumed.status().routes[0]?.address).toBe('wss://start2.trycloudflare.com/mousse-net')
  expect(
    JSON.parse(Buffer.from(resumed.signedRoutes().payload, 'base64url').toString()).version
  ).toBeGreaterThan(recovered.version)
  await resumed.request('net.transport.configure', {
    id: 'cloudflared',
    enabled: false,
    settings: { mode: 'quick', binary }
  })
  expect(resumed.status().routes).toEqual([])
  expect(resumed.status().transports).toContainEqual(
    expect.objectContaining({ id: 'cloudflared', enabled: false, state: 'disabled' })
  )
}, 10_000)

it('reports a selected unavailable transport through bounded public status and doctor while retaining other listeners', async () => {
  const a = profile()
  await a.net.request('net.init', { listen: true })
  await a.net.request('net.transport.configure', {
    id: 'tailscale',
    enabled: true,
    settings: { binary: join(a.path, 'missing-provider-secret-file') }
  })
  const status = a.net.status()
  expect(status.routes).toHaveLength(1)
  expect(status.transports).toContainEqual({
    id: 'tailscale',
    enabled: true,
    state: 'failed',
    routes: [],
    error: 'route_unreachable'
  })
  const doctor = (await a.net.request('net.doctor', {})) as { ok: boolean; checks: unknown[] }
  expect(doctor.ok).toBe(false)
  expect(doctor.checks).toContainEqual(
    expect.objectContaining({ name: 'transport:tailscale', ok: false, code: 'route_unreachable' })
  )
  expect(JSON.stringify({ status, doctor })).not.toContain('missing-provider-secret-file')
  for (const settings of [
    { address: 'ws://public.invalid/mousse-relay' },
    { address: 'wss://user:secret@public.invalid/mousse-relay' },
    { address: 'wss://public.invalid/mousse-relay?node=nod_00000000000000000000000000' }
  ])
    await expect(
      a.net.request('net.transport.configure', { id: 'relay', enabled: true, settings })
    ).rejects.toMatchObject({ code: 'bad_request' })
})

it('binds transport configuration and protected-join validation through the actual local method registry', async () => {
  const a = profile()
  await a.net.request('net.init', {})
  const registry = new DomainHandlerRegistry()
  registerNetMethods(registry, (id) => {
    expect(id).toBe('selected-profile')
    return a.net
  })
  const context = {
    connection: {
      id: 'local-owner',
      binding: { profileId: 'selected-profile', epoch: 1 },
      capabilities: new Set(['net.v1'])
    }
  } as unknown as HandlerContext
  expect(await registry.dispatch(context, 'net.transport.list', {})).toMatchObject({
    manifests: expect.arrayContaining([expect.objectContaining({ id: 'relay' })])
  })
  expect(
    await registry.dispatch(context, 'net.transport.configure', {
      profileId: 'selected-profile',
      id: 'direct',
      enabled: true,
      settings: { host: '127.0.0.1', port: 0 }
    })
  ).toMatchObject({
    transports: [expect.objectContaining({ id: 'direct', enabled: true, state: 'ready' })]
  })
  for (const passphrase of ['', '\ud800', 'q'.repeat(4097)])
    await expect(
      registry.dispatch(context, 'bridge.join', { invite: 'mj1_c2VjcmV0', passphrase })
    ).rejects.toMatchObject({ code: 'bad_request', message: 'The request is malformed.' })
  await expect(
    registry.dispatch(context, 'net.transport.configure', {
      id: 'relay',
      enabled: true,
      settings: {},
      ticket: 'do-not-echo'
    })
  ).rejects.toMatchObject({ code: 'bad_request', message: 'The request is malformed.' })
})
