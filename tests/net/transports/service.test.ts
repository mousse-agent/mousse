import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../src/mms/net/NetService'
import { SyncSupervisor } from '../../../src/mms/net/sync/supervisor'
import type { NodeId } from '../../../src/shared/net'
import type { NetRuntime } from '../../../src/mms/net/NetService'
import { NetError, newId } from '../../../src/shared/net'
import { registerNetMethods } from '../../../src/mms/net/registerMethods'
import { DomainHandlerRegistry } from '../../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../../src/mms/protocol/handlers'
import { approve, fakeSsh, trustHost } from './fakeSsh'
import { sshKnownHostsPath } from '../../../src/mms/net/transports/ssh'

const fixtures = vi.hoisted(() => ({ binaries: new Set<string>() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...input: unknown[]) => {
      // Windows cannot run a shebang fixture; run it through Node. Every other process keeps its real invocation.
      if (process.platform === 'win32' && fixtures.binaries.has(input[0] as string))
        return Reflect.apply(actual.spawn, undefined, [
          process.execPath,
          [input[0], ...(input[1] as string[])],
          ...input.slice(2)
        ])
      return Reflect.apply(actual.spawn, undefined, input)
    }) as typeof actual.spawn
  }
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function profile(ssh?: { binary?: string; userKnownHosts?: string }) {
  const path = mkdtempSync(join(tmpdir(), 'mousse-net-addon-service-')),
    net = new NetService({ profileDir: path, ssh })
  cleanups.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { path, net }
}

it('reconnects an existing supervisor using an adopted newer signed endpoint instead of its initial cached endpoint', async () => {
  const a = profile(),
    b = profile()
  await a.net.request('net.init', { listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test authority protection' })
  const old = a.net.status().routes[0],
    invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await b.net.request('bridge.join', { invite: invite.invite })) as {
    authority: NodeId
  }
  const supervisor = (
    b.net as unknown as { supervisors: Map<NodeId, SyncSupervisor> }
  ).supervisors.get(joined.authority)!
  expect(supervisor).toBeInstanceOf(SyncSupervisor)
  expect(supervisor.state()).toBe('open')
  // Identical settings retain the listener. Disable it and reserve its old port before moving it.
  await a.net.request('net.transport.configure', {
    id: 'direct',
    enabled: false,
    settings: { port: 0 }
  })
  const reserved = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    reserved.once('error', reject)
    reserved.listen(Number(new URL(old.address).port), '127.0.0.1', resolve)
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        reserved.close((error) => (error ? reject(error) : resolve()))
      )
  )
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
  let calls = 0,
    closed = 0,
    active = 1,
    runtime!: NetRuntime,
    finish!: () => void
  const drained = new Promise<void>((resolve) => {
    finish = () => {
      active = 0
      resolve()
    }
  })
  const net = new NetService({
    profileDir: path,
    composeRuntime: (rt) => {
      calls++
      runtime = rt
      expect(rt.identity.self()).toBeUndefined()
      expect(rt.keys.state()).toBe('missing')
      return {
        activeCount: () => active,
        close: () => {
          closed++
          return drained
        }
      }
    }
  })
  cleanups.push(() => {
    finish()
    return net.shutdown()
  })
  await net.request('net.init', {})
  expect(calls).toBe(1)
  expect(net.runtime()).toBe(runtime)
  expect(net.getActiveCount()).toBe(1)
  net.beginShutdown()
  let settled = false
  const shutdown = net.shutdown().then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(closed).toBe(1)
  expect(settled).toBe(false)
  expect(runtime.db.database.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 })
  finish()
  await shutdown
  expect(settled).toBe(true)
  expect(() => runtime.db.database.prepare('SELECT 1')).toThrow()
})

it('opens a trusted foreign-user domain session and retains its signed routes without automatically supervising foreign nodes', async () => {
  const a = profile(),
    b = profile()
  await a.net.request('net.init', { listen: true })
  await b.net.request('net.init', { listen: true })
  const ar = a.net.runtime(),
    br = b.net.runtime(),
    au = ar.identity.self()!,
    bu = br.identity.self()!
  ar.identity.pinUser(bu.user, br.keys.rootKey()!)
  ar.identity.acceptRoster(br.identity.roster()!, br.keys.rootKey()!)
  br.identity.pinUser(au.user, ar.keys.rootKey()!)
  br.identity.acceptRoster(ar.identity.roster()!, ar.keys.rootKey()!)
  const session = await a.net.connectDomainSession(
    {
      node: bu.node,
      user: bu.user,
      transportKey: br.keys.nodeKeys().transport,
      routes: b.net.status().routes
    },
    new AbortController().signal
  )
  expect(session.state()).toBe('open')
  expect(session.peer.user).toBe(bu.user)
  expect(
    ar.db.database.prepare('SELECT signed FROM net_peer_routes WHERE node=?').get(bu.node)
  ).toBeDefined()
  expect(
    (a.net as unknown as { supervisors: Map<NodeId, SyncSupervisor> }).supervisors.has(bu.node)
  ).toBe(false)
  expect(
    (b.net as unknown as { supervisors: Map<NodeId, SyncSupervisor> }).supervisors.has(au.node)
  ).toBe(false)
  expect(() => a.net.adoptRoutes(b.net.signedRoutes(), bu.node)).toThrow()
})

it.each(['sync', 'async'] as const)(
  'retains real stores after a %s domain drain failure and rechecks concurrent shutdown retries',
  async (kind) => {
    const path = mkdtempSync(join(tmpdir(), 'mousse-net-domain-uncertain-'))
    cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    let calls = 0,
      released = false,
      runtime!: NetRuntime
    const net = new NetService({
      profileDir: path,
      composeRuntime: (rt) => {
        runtime = rt
        return {
          close: () => {
            calls++
            if (!released) {
              const error = new NetError('outcome_uncertain')
              if (kind === 'sync') throw error
              return Promise.reject(error)
            }
          }
        }
      }
    })
    cleanups.push(() => {
      released = true
      return net.shutdown()
    })
    await net.request('net.init', {})
    net.beginShutdown()
    const first = net.shutdown()
    expect(net.shutdown()).toBe(first)
    await expect(first).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(calls).toBe(1)
    expect(runtime.db.database.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 })
    await expect(net.shutdown()).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(calls).toBe(2)
    expect(runtime.identity.self()).toBeDefined()
    released = true
    await net.shutdown()
    expect(calls).toBe(3)
    expect(() => runtime.db.database.prepare('SELECT 1')).toThrow()
    await net.shutdown()
    expect(calls).toBe(3)
  }
)

it('switches off an ssh add-on that failed to start using the saved settings', async () => {
  const a = profile()
  await a.net.request('net.init', {})
  const registry = new DomainHandlerRegistry()
  registerNetMethods(registry, () => a.net)
  const context = {
    connection: {
      id: 'local-owner',
      binding: { profileId: 'selected-profile', epoch: 1 },
      capabilities: new Set(['net.v1'])
    }
  } as unknown as HandlerContext
  type Rows = {
    transports: Array<{ id: string; enabled: boolean; state: string; routes: unknown[] }>
  }
  const configure = (params: Record<string, unknown>) =>
    registry.dispatch(context, 'net.transport.configure', {
      profileId: 'selected-profile',
      ...params
    }) as Promise<Rows>
  // The fixed port is taken, as after a restart: the add-on stays enabled but has no route.
  const busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => busy.close(() => resolve())))
  const settings = {
    endpoint: 'me@box.example.com:2222',
    port: (busy.address() as { port: number }).port,
    binary: '/opt/openssh/ssh'
  }
  expect(
    (await configure({ id: 'ssh', enabled: true, settings })).transports.find(
      (row) => row.id === 'ssh'
    )
  ).toMatchObject({ enabled: true, state: 'failed', routes: [] })
  // The screen was reopened: it has no form state, so it sends no settings.
  expect(
    (await configure({ id: 'ssh', enabled: false })).transports.find((row) => row.id === 'ssh')
  ).toMatchObject({ enabled: false, state: 'disabled', routes: [] })
  const saved = (a.net as unknown as { config: { transports: Array<{ id: string }> } }).config
    .transports
  expect(saved.find((row) => row.id === 'ssh')).toEqual({ id: 'ssh', enabled: false, settings })
  // Settings may be omitted only to switch something off that is configured.
  await expect(configure({ id: 'ssh', enabled: true })).rejects.toMatchObject({
    code: 'bad_request'
  })
  await expect(configure({ id: 'relay', enabled: false })).rejects.toMatchObject({
    code: 'bad_request'
  })
})

it('reaches a device that listens only on ssh, and serves rpc in both directions over one session', async () => {
  const where = mkdtempSync(join(tmpdir(), 'mousse-net-ssh-service-')),
    ssh = await fakeSsh(where, 'forward')
  fixtures.binaries.add(ssh.binary)
  cleanups.push(() => rmSync(where, { recursive: true, force: true }))
  const a = profile({ binary: ssh.binary, userKnownHosts: join(where, 'known_hosts') }),
    b = profile()
  await a.net.request('net.init', { listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test authority protection' })
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await b.net.request('bridge.join', { invite: invite.invite })) as {
    node: NodeId
    authority: NodeId
  }
  // A stops listening. B keeps nothing but an ssh listener on a fixed loopback port.
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const port = (closed.address() as { port: number }).port
  await new Promise<void>((resolve) => closed.close(() => resolve()))
  for (const side of [a, b])
    await side.net.request('net.transport.configure', {
      id: 'direct',
      enabled: false,
      settings: { port: 0 }
    })
  await b.net.request('net.transport.configure', {
    id: 'ssh',
    enabled: true,
    settings: { endpoint: 'me@box.example.com:2222', port, binary: ssh.binary }
  })
  expect(a.net.status().routes).toEqual([])
  expect(b.net.status().routes).toEqual([
    {
      transport: 'ssh',
      address: `ssh://me@box.example.com:2222/127.0.0.1:${port}`,
      priority: 40
    }
  ])
  // A approves B's endpoint, then adopts B's signed routes.
  await approve(a.path, { [joined.node]: 'me@box.example.com:2222' })
  await trustHost(sshKnownHostsPath(a.path), 'box.example.com', 2222)
  a.net.adoptRoutes(b.net.signedRoutes(), joined.node)
  const internals = a.net as unknown as {
    refreshPeers(): void
    supervisors: Map<NodeId, SyncSupervisor>
  }
  internals.refreshPeers()
  internals.supervisors.get(joined.node)?.retryAfterStateChange()
  await vi.waitFor(() => expect(a.net.session(joined.node).state()).toBe('open'), {
    timeout: 15_000
  })
  const ask = (side: typeof a, node: NodeId) =>
    side.net
      .session(node)
      .rpc('authority.transfer.ready', {}, { id: newId('rpc'), deadlineMs: 10_000 })
  // A dialed out through ssh; B answers on the inbound session it never dialed.
  expect(await ask(a, joined.node)).toMatchObject({ node: joined.node })
  await vi.waitFor(() => expect(b.net.session(joined.authority).state()).toBe('open'))
  expect(await ask(b, joined.authority)).toMatchObject({ node: joined.authority })
  const spawned = readFileSync(ssh.log, 'utf8').trim().split('\n')
  expect(spawned).toHaveLength(1)
  expect(JSON.parse(spawned[0])).toEqual(
    expect.arrayContaining(['-p', '2222', '-W', `127.0.0.1:${port}`, '--', 'box.example.com'])
  )
}, 30_000)

it('joins through the setup listener and the via tunnel while the invitation routes are unreachable', async () => {
  const a = profile(),
    b = profile()
  await a.net.request('net.init', { listen: true, port: 0 })
  await a.net.request('net.protect', { passphrase: 'test authority protection' })
  // The invitation advertises an address nothing answers on.
  await a.net.request('net.transport.configure', {
    id: 'direct',
    enabled: true,
    settings: { host: '127.0.0.1', advertiseHost: '192.0.2.1', port: 0 }
  })
  const listener = await (
    a.net as unknown as {
      openEnrollmentListener(): Promise<{ port: number; close(): Promise<void> }>
    }
  ).openEnrollmentListener()
  const via = `ws://127.0.0.1:${listener.port}/mousse-net`
  const invite = (await a.net.request('bridge.invite', {})) as { invite: string }
  // Only the loopback tunnel shape is accepted, through the real method registry too.
  await expect(
    b.net.request('bridge.join', { invite: invite.invite, via: 'ws://10.0.0.1:1/mousse-net' })
  ).rejects.toMatchObject({ code: 'bad_request' })
  const joined = (await b.net.request('bridge.join', { invite: invite.invite, via })) as {
    node: NodeId
    authority: NodeId
  }
  const nodes = (await a.net.request('bridge.nodes', {})) as { nodes: Array<{ node: NodeId }> }
  expect(nodes.nodes.map((row) => row.node)).toContain(joined.node)
  // The listener is not part of the saved configuration and goes away when closed.
  expect(JSON.stringify(a.net.status().transports)).not.toContain(String(listener.port))
  await listener.close()
  await expect(
    new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(listener.port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  ).resolves.toBeUndefined()
}, 30_000)

it('the method registry refuses via anywhere but bridge.join and any non-loopback shape', async () => {
  const registry = new DomainHandlerRegistry()
  const requests: string[] = []
  registerNetMethods(registry, () => ({
    request: (method) => {
      requests.push(method)
      return {}
    }
  }))
  const context = {
    connection: {
      id: 'local-owner',
      binding: { profileId: 'selected-profile', epoch: 1 },
      capabilities: new Set(['net.v1'])
    }
  } as unknown as HandlerContext
  const call = (method: string, params: Record<string, unknown>) =>
    registry.dispatch(context, method, { profileId: 'selected-profile', ...params })
  const invite = 'mj1_' + 'a'.repeat(20)
  for (const via of [
    'ws://127.0.0.1:9/mousse-net?x=1',
    'ws://user@127.0.0.1:9/mousse-net',
    'ws://[::1]:9/mousse-net',
    'wss://127.0.0.1:9/mousse-net',
    'ws://localhost:9/mousse-net',
    'ws://127.0.0.1:99999/mousse-net'
  ])
    await expect(call('bridge.join', { invite, via })).rejects.toBeTruthy()
  await expect(
    call('bridge.join', { invite, via: 'ws://127.0.0.1:47821/mousse-net' })
  ).resolves.toBeDefined()
  await expect(
    call('bridge.rename', { node: newId('node'), name: 'x', via: 'ws://127.0.0.1:1/mousse-net' })
  ).rejects.toBeTruthy()
  expect(requests).toEqual(['bridge.join'])
  // The remote machine methods validate their shapes and reach the service only when well formed.
  await expect(
    call('net.ssh.trust', { host: 'box', fingerprint: 'not-a-fingerprint' })
  ).rejects.toBeTruthy()
  await expect(call('net.ssh.approve', { node: 'nope', endpoint: 'box' })).rejects.toBeTruthy()
  await expect(call('net.ssh.check', { host: 'box' })).resolves.toBeDefined()
})
