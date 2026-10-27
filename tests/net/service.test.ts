import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../src/mms/net/NetService'
import type { Clock } from '../../src/mms/net/contracts'
import { NODE_DELEGATION_TTL_MS } from '../../src/shared/net/limits'
import { NetError, type Roster, type StreamId } from '../../src/shared/net'
import { FakeClock } from './harness/FakeClock'
import { fakeTailscale } from './harness/fakeTailscale'
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
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}
type Listed = { records: Record<string, unknown>; settings: Record<string, unknown> }
async function serveBed() {
  const { net, path } = service(),
    fake = await fakeTailscale(path)
  cleanups.push(() => fake.restore())
  await net.request('net.init', { name: 'authority' })
  const port = await freePort(),
    settings = { binary: fake.binary, mode: 'serve', port, servePort: 47890 },
    params = { id: 'tailscale', action: 'serve' },
    entry = { TCPForward: `127.0.0.1:${port}` },
    listen = () =>
      net.request('net.transport.configure', { id: 'tailscale', enabled: true, settings }),
    listed = () => net.request('net.transport.list', {}) as Promise<Listed>,
    tailscale = (from: NetService = net) =>
      from.status().transports?.find((row) => row.id === 'tailscale')
  return { net, path, fake, port, settings, params, entry, listen, listed, tailscale }
}
/** `request` refuses some calls before it returns a promise. */
function thrown(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
}
async function until(check: () => boolean) {
  for (let index = 0; index < 400 && !check(); index++)
    await new Promise((resolve) => setTimeout(resolve, 25))
  expect(check()).toBe(true)
}
it('turns Serve on once Mousse listens, keeps the record across a restart, and undoes it', async () => {
  const { net, path, fake, settings, params, entry, listen, listed, tailscale } = await serveBed()
  await listen()
  const before = await listed()
  expect(before.records).toEqual({})
  expect(before.settings.tailscale).toEqual(settings)
  await expect(
    net.request('net.transport.action.describe', { ...params, settings })
  ).resolves.toMatchObject({
    ok: true,
    changes: expect.arrayContaining([
      expect.objectContaining({ command: expect.stringContaining('serve') })
    ])
  })
  expect(fake.entries()).toEqual({})
  await expect(net.request('net.transport.action.apply', { ...params, settings })).resolves.toEqual(
    { ok: true }
  )
  expect(fake.entries()).toEqual({ '47890': entry })
  const stored = {
    tailscale: {
      action: 'serve',
      appliedAt: expect.any(Number),
      record: {
        servePort: 47890,
        port: settings.port,
        tailnet: { name: 'example.ts.net', node: 'node-1' },
        state: 'applied'
      }
    }
  }
  expect((await listed()).records).toEqual(stored)
  // The add-on is ready and advertises the tailnet port as soon as the mapping is confirmed.
  expect(tailscale()).toMatchObject({
    state: 'ready',
    routes: [{ address: 'ws://127.0.0.1:47890/mousse-net' }]
  })

  await net.shutdown()
  const again = new NetService({ profileDir: path })
  cleanups.push(() => again.shutdown())
  await again.start()
  expect(((await again.request('net.transport.list', {})) as Listed).records).toEqual(stored)
  // After the restart the recorded mapping is found in place and nothing is written again.
  await until(() => tailscale(again)?.state === 'ready')
  expect(fake.commands().filter((args) => args.includes('--bg'))).toHaveLength(1)

  // Undo uses the saved settings, removes only the recorded mapping, and a second undo has nothing left.
  await expect(again.request('net.transport.action.undo', params)).resolves.toMatchObject({
    ok: true,
    outcome: 'removed'
  })
  expect(fake.entries()).toEqual({})
  expect(((await again.request('net.transport.list', {})) as Listed).records).toEqual({})
  await expect(again.request('net.transport.action.undo', params)).resolves.toMatchObject({
    ok: true,
    outcome: 'already-removed'
  })
  expect(fake.commands().filter((args) => args.includes('off'))).toHaveLength(1)
})
it('keeps Serve visible and undoable while networking is off', async () => {
  const { net, fake, settings, params, listen, listed } = await serveBed()
  await listen()
  await net.request('net.transport.action.apply', { ...params, settings })
  await net.request('net.disable', {})
  // Everything else is refused now, but what Mousse changed outside itself is not hidden.
  expect(
    thrown(() => net.request('net.transport.configure', { id: 'tailscale', enabled: false }))
  ).toMatchObject({ code: 'disabled' })
  const shown = await listed()
  expect(shown.records).toMatchObject({ tailscale: { action: 'serve' } })
  await expect(net.request('net.transport.action.undo', params)).resolves.toMatchObject({
    ok: true,
    outcome: 'removed'
  })
  expect(fake.entries()).toEqual({})
  expect((await listed()).records).toEqual({})
})
it('shows an add-on refusal as a result with its message, and rejects unknown actions', async () => {
  const { net, fake, settings, params, listen, listed } = await serveBed()
  await listen()
  fake.setEntry(47890, { TCPForward: '127.0.0.1:9999' })
  await expect(
    net.request('net.transport.action.apply', { ...params, settings })
  ).resolves.toMatchObject({
    ok: false,
    code: 'conflict',
    message: expect.stringMatching(/127\.0\.0\.1:9999/)
  })
  fake.clearEntries()
  fake.failServeWith('requires --operator')
  await expect(
    net.request('net.transport.action.apply', { ...params, settings })
  ).resolves.toMatchObject({
    ok: false,
    code: 'forbidden',
    ...(process.platform === 'linux' ? { remedy: 'sudo tailscale set --operator=$USER' } : {})
  })
  // Nothing was made, so nothing stays recorded.
  expect((await listed()).records).toEqual({})
  expect(
    thrown(() => net.request('net.transport.action.apply', { ...params, action: 'nope', settings }))
  ).toMatchObject({ code: 'bad_request' })
  expect(
    thrown(() =>
      net.request('net.transport.action.apply', {
        id: 'cloudflared',
        action: 'serve',
        settings: {}
      })
    )
  ).toMatchObject({ code: 'bad_request' })
})
it('will not forward a tailnet port before Mousse listens on its loopback port', async () => {
  const { net, fake, settings, params, listed } = await serveBed()
  // The add-on was never turned on, so nothing holds the port.
  await expect(
    net.request('net.transport.action.apply', { ...params, settings })
  ).resolves.toMatchObject({ ok: false, code: 'conflict' })
  expect(fake.commands().some((args) => args.includes('--bg'))).toBe(false)
  expect((await listed()).records).toEqual({})
})
it('keeps the record and the mapping when undo cannot read Tailscale', async () => {
  const { net, fake, settings, params, entry, listen, listed } = await serveBed()
  await listen()
  await net.request('net.transport.action.apply', { ...params, settings })
  fake.setServeOutput('[]')
  await expect(net.request('net.transport.action.undo', params)).resolves.toMatchObject({
    ok: false,
    code: 'unsupported_version'
  })
  expect((await listed()).records).toMatchObject({ tailscale: { action: 'serve' } })
  expect(fake.entries()).toEqual({ '47890': entry })
  expect(fake.commands().some((args) => args.includes('off'))).toBe(false)
})
it('runs one change per add-on at a time', async () => {
  const { net, settings, params, listen } = await serveBed()
  await listen()
  const results = (await Promise.all([
    net.request('net.transport.action.apply', { ...params, settings }),
    net.request('net.transport.action.apply', { ...params, settings })
  ])) as Array<{ ok: boolean; code?: string }>
  expect(results.map((row) => row.ok).sort()).toEqual([false, true])
  expect(results.find((row) => !row.ok)).toMatchObject({ code: 'conflict' })
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
it('orchestrates protected transfer only after the target is protected and drops the old root key', async () => {
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
})
it('keeps delivering a live delta to later sessions when one session refuses it', async () => {
  const { net } = service()
  await net.request('net.init', { name: 'authority' })
  const delivered: unknown[] = [],
    stub = (publishDelta: () => void): object => ({ state: () => 'open', publishDelta }),
    sessions = (net as unknown as { sessions: Set<object> }).sessions
  sessions.add(
    stub(() => {
      throw new NetError('outcome_uncertain')
    })
  )
  sessions.add(stub(() => delivered.push('delta')))
  net.publishDelta('stream' as StreamId, { threadId: 't' })
  expect(delivered).toEqual(['delta'])
  sessions.clear()
})
