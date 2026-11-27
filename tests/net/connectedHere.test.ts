import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NetService, type NetRuntime } from '../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../src/mms/net/clock'
import { NET_SCHEMA_VERSION } from '../../src/mms/net/store/database'
import { encodeEnvelope, parseProtocolJson } from '../../src/mms/net/sync/codec'
import type { SyncSupervisor } from '../../src/mms/net/sync/supervisor'
import { SpaceProfileService } from '../../src/mms/spaces/SpaceProfileService'
import {
  newId,
  spaceMetaStream,
  type NodeId,
  type StoredRecord,
  type StreamDescriptor,
  type UserId
} from '../../src/shared/net'
import type { HostedNetHost } from '../../src/mms/net/hosted'
import type { Device } from '../../src/renderer/lib/netDevices'

/**
 * Each computer keeps its own record of which devices of its user's list are connected here. Two members open no
 * session until each connected the other; the keeper and a member always do, and serve each other nothing but the
 * keeper's control traffic until connected. Another user's device is governed by its Space membership alone.
 */
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-connected-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  return path
}
const spaceProfiles = new Map<NetService, SpaceProfileService>()
function composeSpaces(net: NetService, rt: NetRuntime) {
  const spaces = new SpaceProfileService({ runtime: rt, net })
  spaceProfiles.set(net, spaces)
  return spaces.composition(new NodeStreamAuthority(rt.identity, spaces.store, rt.blobs, systemClock))
}
function service(path: string, options: { spaces?: boolean; hosted?: ReturnType<typeof signedIn> } = {}): NetService {
  const net: NetService = new NetService({
    profileDir: path,
    ...(options.spaces ? { composeRuntime: (rt) => composeSpaces(net, rt) } : {}),
    ...(options.hosted ? { hosted: options.hosted.factory } : {})
  })
  cleanups.push(() => net.shutdown())
  return net
}
/** Mousse ID, as far as Net asks: signed in or not, and a way to say it changed. Nothing else does anything. */
function signedIn(initially: boolean) {
  const state = { connected: initially, host: undefined as HostedNetHost | undefined }
  const hosted = new Proxy({} as Record<string, unknown>, {
    get: (_target, name) =>
      name === 'status'
        ? () => ({ configured: true, connected: state.connected, accountId: 'acct_one' })
        : name === 'transports'
          ? undefined
          : ['connected', 'consentFenced', 'handlesJoin'].includes(String(name))
            ? () => false
            : async () => undefined
  })
  return {
    state,
    factory: {
      create: (host: HostedNetHost) => {
        state.host = host
        return hosted as never
      }
    },
    set(connected: boolean) {
      state.connected = connected
      state.host?.emit()
    }
  }
}

type Computer = { path: string; net: NetService; node: NodeId; user: UserId }
async function keeper(name = 'Studio Mac', options: { spaces?: boolean; hosted?: ReturnType<typeof signedIn> } = {}): Promise<Computer> {
  const path = directory(),
    net = service(path, options)
  await net.request('net.init', { name, listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'connected-keeper' })
  const self = net.runtime().identity.self()!
  return { path, net, node: self.node, user: self.user }
}
/** A computer that joins `to` with a link it made, and listens so others can dial it. */
async function member(to: Computer, name: string, options: { spaces?: boolean; path?: string; hosted?: ReturnType<typeof signedIn> } = {}): Promise<Computer> {
  const path = options.path ?? directory(),
    net = service(path, options)
  const link = (await to.net.request('bridge.invite', {})) as { invite: string }
  const joined = (await net.request('bridge.join', { invite: link.invite, name })) as { node: NodeId; user: UserId }
  await net.request('net.init', { listen: true, port: 0 })
  await vi.waitFor(() => expect(to.net.status().peers).toContainEqual({ node: joined.node, state: 'open' }), { timeout: 15_000 })
  await vi.waitFor(() => expect(open(net, to.node)).toBe(true), { timeout: 15_000 })
  return { path, net, node: joined.node, user: joined.user }
}
const internals = (net: NetService) =>
  net as unknown as { refreshPeers(): void; supervisors: Map<NodeId, SyncSupervisor> }
const device = async (on: NetService, node: NodeId) =>
  ((await on.request('bridge.nodes', {})) as { nodes: Device[] }).nodes.find((row) => row.node === node)!
const open = (on: NetService, node: NodeId) => {
  try {
    return on.session(node).state() === 'open'
  } catch {
    return false
  }
}
const info = (on: NetService, node: NodeId) =>
  on.session(node).rpc('net.info', {}, { id: newId('rpc'), deadlineMs: 5000 })
const notConnected = { code: 'forbidden', details: { reason: 'not_connected' } }

describe('two members of one keeper', () => {
  it('open no session and list nothing of each other until each connects the other', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop'),
      c = await member(a, 'Desk PC')
    // B learns C's routes (as from Mousse ID or another device): they are kept, and never dialled.
    b.net.adoptRoutes(c.net.signedRoutes(), c.node)
    internals(b.net).refreshPeers()
    expect(internals(b.net).supervisors.has(c.node)).toBe(false)
    expect(await device(b.net, c.node)).toMatchObject({ connection: 'none', routeHeld: true })
    expect(await device(c.net, b.node)).toMatchObject({ connection: 'none', routeHeld: false })
    // The keeper and the computer it joined through are connected at the invitation, both ways.
    expect(await device(b.net, a.node)).toMatchObject({ connection: 'connected' })
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'connected' })

    // B connects C. C has not connected B, so it refuses B in its hello, with the reason, and B waits.
    await b.net.request('bridge.connect', { node: c.node })
    await vi.waitFor(() => {
      const supervisor = internals(b.net).supervisors.get(c.node)
      expect(supervisor?.lastError()).toBe('forbidden')
      expect(supervisor?.lastReason()).toBe('not_connected')
    }, { timeout: 15_000 })
    expect(open(b.net, c.node)).toBe(false)
    expect(open(c.net, b.node)).toBe(false)
    // C kept the routes B sent in the hello it refused, so Connect can reach B from there.
    expect(await device(c.net, b.node)).toMatchObject({ connection: 'none', routeHeld: true })

    // C connects B: the session opens, and each serves the other.
    await c.net.request('bridge.connect', { node: b.node })
    await vi.waitFor(() => expect(open(b.net, c.node) && open(c.net, b.node)).toBe(true), { timeout: 15_000 })
    expect(await info(b.net, c.node)).toMatchObject({ v: 1 })
    expect(await info(c.net, b.node)).toMatchObject({ v: 1 })

    // Disconnect on one end ends the session, tells the other why, and stops the dialling there.
    await c.net.request('bridge.disconnect', { node: b.node })
    await vi.waitFor(() => expect(open(b.net, c.node) || open(c.net, b.node)).toBe(false), { timeout: 15_000 })
    expect(await device(c.net, b.node)).toMatchObject({ connection: 'disconnected', routeHeld: true })
    expect(internals(c.net).supervisors.has(b.node)).toBe(false)
  }, 90_000)
})

describe('the keeper and a member', () => {
  it('keep a control session while the member is disconnected on either end, in both dial directions, and refuse application calls on it', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop')
    await a.net.request('bridge.disconnect', { node: b.node })
    await b.net.request('bridge.disconnect', { node: a.node })
    // Each dials the other: the hello is admitted both ways.
    const dial = async (from: Computer, to: Computer) => {
      const { routes } = (await to.net.request('net.routes', {})) as { routes: never }
      const transportKey = (from.net as unknown as { currentNode(node: NodeId): { keys: { transport: string } } }).currentNode(to.node).keys.transport
      return from.net.connectDomainSession({ node: to.node, user: to.user, transportKey, routes } as never, new AbortController().signal)
    }
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const session = await dial(from, to)
      cleanups.push(() => session.close())
      expect(session.state()).toBe('open')
      // Application calls are refused both ways; the keeper's control calls pass.
      await expect(session.rpc('net.info', {}, { id: newId('rpc'), deadlineMs: 5000 })).rejects.toMatchObject(notConnected)
      expect(await session.rpc('authority.transfer.ready', {}, { id: newId('rpc'), deadlineMs: 5000 })).toMatchObject({ node: to.node })
    }
    // Connecting on one end takes effect on the open session, with no redial: that end serves the other again.
    await a.net.request('bridge.connect', { node: b.node })
    expect(await info(b.net, a.node)).toMatchObject({ v: 1 })
    await expect(info(a.net, b.node)).rejects.toMatchObject(notConnected)
  }, 90_000)

  it('a member disconnected on both ends still gets the list from the keeper, as renewals travel', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop')
    await a.net.request('bridge.disconnect', { node: b.node })
    await b.net.request('bridge.disconnect', { node: a.node })
    // The pair keeps its session for control traffic; a new list signed by the keeper reaches the member on it.
    await vi.waitFor(() => expect(open(b.net, a.node)).toBe(true), { timeout: 15_000 })
    await a.net.request('bridge.rename', { node: b.node, name: 'Laptop renamed' })
    await vi.waitFor(async () => expect((await device(b.net, b.node)).name).toBe('Laptop renamed'), { timeout: 15_000 })
  }, 60_000)

  it('refuses a saved result and ends a stream as the member is disconnected, and serves them again once connected', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop')
    let effects = 0
    a.net.runtime().rpc.register({
      method: 'test.write',
      capability: 'write',
      mutating: true,
      handle: async () => ({ effects: ++effects })
    })
    const written = newId('rpc')
    expect(await b.net.session(a.node).rpc('test.write', {}, { id: written, idem: 'write-1', deadlineMs: 5000 })).toEqual({ effects: 1 })

    // A stream long enough that its replay takes more than one page.
    const self = a.net.runtime().identity.self()!
    const descriptor: StreamDescriptor = { id: newId('stream'), kind: 'node.thread', authority: self.node, createdAt: systemClock.now() }
    a.net.runtime().streams.createStream(descriptor, 1)
    b.net.runtime().streams.createStream(descriptor, 1)
    const TOTAL = 1500
    for (let seq = 1; seq <= TOTAL; seq++) {
      const envelope = encodeEnvelope({
        v: 1,
        minor: 0,
        id: newId('event'),
        stream: descriptor.id,
        type: 'message.posted',
        crit: false,
        author: { user: self.user, node: self.node, keyEpoch: 1 },
        ts: systemClock.now(),
        body: { text: `record ${seq}` }
      })
      const row: StoredRecord = { epoch: 1, seq, recvTs: systemClock.now(), envelope, sig: a.net.runtime().keys.signAsNode(envelope) }
      a.net.runtime().streams.appendAsAuthority(descriptor.id, {
        id: (parseProtocolJson(Buffer.from(row.envelope)) as { id: never }).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
    }
    // The keeper disconnects the member as the first replayed record arrives.
    let received = 0,
      disconnecting: Promise<unknown> | undefined
    const failed = vi.fn()
    const subscription = b.net.session(a.node).subscribe(descriptor.id, {
      onRecord: () => {
        received++
        disconnecting ??= a.net.request('bridge.disconnect', { node: b.node })
      },
      onCaughtUp: vi.fn(),
      onSnapshotInstalled: vi.fn(),
      onError: failed
    })
    cleanups.push(() => subscription.close())
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith('forbidden'), { timeout: 15_000 })
    await disconnecting
    expect(received).toBeGreaterThan(0)
    expect(received).toBeLessThan(TOTAL)
    // What it asked for earlier cannot be read back; the session stays up.
    await expect(b.net.session(a.node).rpcResult(written, { deadlineMs: 5000 })).rejects.toMatchObject(notConnected)
    expect(open(b.net, a.node)).toBe(true)
    expect(effects).toBe(1)

    await a.net.request('bridge.connect', { node: b.node })
    expect(await b.net.session(a.node).rpcResult(written, { deadlineMs: 5000 })).toEqual({ effects: 1 })
  }, 90_000)

  it('moves the rule with the role: a pair that lost the keeper ends, and a pair that gained it opens', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop'),
      c = await member(a, 'Desk PC')
    await b.net.request('net.protect', { passphrase: 'connected-laptop' })
    // A disconnects C: as the keeper it keeps a control session with C.
    await a.net.request('bridge.disconnect', { node: c.node })
    expect(open(a.net, c.node)).toBe(true)
    // B holds C's routes, and the two never connected each other: no session.
    b.net.adoptRoutes(c.net.signedRoutes(), c.node)
    internals(b.net).refreshPeers()
    expect(open(b.net, c.node)).toBe(false)

    await a.net.request('net.authority.transfer', { node: b.node })
    await vi.waitFor(() => expect(b.net.status().self?.isAuthority).toBe(true), { timeout: 15_000 })
    // A is a member now, and C is not connected on A: their session ends. B keeps the list: B and C get one.
    await vi.waitFor(() => expect(open(a.net, c.node) || open(c.net, a.node)).toBe(false), { timeout: 15_000 })
    await vi.waitFor(() => expect(open(b.net, c.node)).toBe(true), { timeout: 15_000 })
    // It carries the keeper's control traffic only.
    await expect(info(b.net, c.node)).rejects.toMatchObject(notConnected)
  }, 120_000)
})

describe('how a device becomes connected', () => {
  it('a fresh computer, a join and a restart leave a device that joins later not connected; Start over does the same', async () => {
    const a = await keeper()
    // A computer that had its own network first, started over, and joined A.
    const path = directory()
    const solo = service(path)
    await solo.request('net.init', { name: 'Laptop' })
    await solo.request('net.startOver', {})
    const b = await member(a, 'Laptop', { path })
    await b.net.shutdown()
    const restarted = service(path)
    await restarted.start()
    const c = await member(a, 'Desk PC')
    await vi.waitFor(async () => expect(await device(restarted, c.node)).toBeDefined(), { timeout: 15_000 })
    expect(await device(restarted, c.node)).toMatchObject({ connection: 'none' })
    expect(await device(restarted, a.node)).toMatchObject({ connection: 'connected' })
    expect(await device(c.net, b.node)).toMatchObject({ connection: 'none' })
  }, 90_000)

  it('a store from before the record connects every listed device once, with the key store locked, and takes no schema step of its own', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop'),
      c = await member(a, 'Desk PC')
    await b.net.request('net.protect', { passphrase: 'connected-laptop' })
    await b.net.request('bridge.disconnect', { node: a.node })
    await b.net.shutdown()
    // As an older build left it: no records and no marker.
    const db = new DatabaseSync(join(b.path, 'net', 'net.db'))
    db.exec('DELETE FROM net_connections; DELETE FROM net_local_markers')
    db.close()
    const restarted = service(b.path)
    expect(restarted.runtime().keys.state()).toBe('locked')
    expect(restarted.runtime().connections.state(a.node)).toBe('connected')
    expect(restarted.runtime().connections.state(c.node)).toBe('connected')
    // Once: a choice made after it stays.
    await restarted.request('net.unlock', { passphrase: 'connected-laptop' })
    await restarted.request('bridge.disconnect', { node: c.node })
    await restarted.shutdown()
    const again = service(b.path)
    expect(again.runtime().connections.state(c.node)).toBe('disconnected')
    // The records take no schema step of their own: the version is the one this build writes anyway.
    expect(again.runtime().db.database.prepare('PRAGMA user_version').get()!.user_version).toBe(NET_SCHEMA_VERSION)
  }, 90_000)

  it('signed in to Mousse ID, a device of the account is connected when it appears, and one disconnected stays so across sign-out and sign-in', async () => {
    const account = signedIn(true)
    const a = await keeper('Studio Mac', { hosted: account })
    const b = await member(a, 'Laptop'),
      c = await member(a, 'Desk PC')
    expect(a.net.runtime().connections.state(b.node)).toBe('connected')
    // B and C joined through A; signed out, B has no record of C.
    expect(b.net.runtime().connections.state(c.node)).toBe('none')
    await a.net.request('bridge.disconnect', { node: c.node })
    account.set(false)
    const d = await member(a, 'Old Mac')
    expect(a.net.runtime().connections.state(d.node)).toBe('connected')
    account.set(true)
    // Signing in again does not undo a Disconnect.
    expect(a.net.runtime().connections.state(c.node)).toBe('disconnected')
    expect(a.net.runtime().connections.state(b.node)).toBe('connected')

    // A computer that joins while signed in connects every device of the list, as each appears.
    const signed = signedIn(true)
    const e = await member(a, 'Mini', { hosted: signed })
    for (const node of [a.node, b.node, c.node, d.node]) expect(e.net.runtime().connections.state(node)).toBe('connected')
    const f = await member(a, 'Tablet PC')
    await vi.waitFor(() => expect(e.net.runtime().connections.state(f.node)).toBe('connected'), { timeout: 15_000 })
    await e.net.request('bridge.disconnect', { node: b.node })
    // Signed out, the records stay; signed in again, a Disconnect stays.
    signed.set(false)
    expect(e.net.runtime().connections.state(f.node)).toBe('connected')
    signed.set(true)
    expect(e.net.runtime().connections.state(b.node)).toBe('disconnected')
  }, 120_000)

  it('an invitation as SSH setup issues it ends with the two connected in both directions, and calls pass', async () => {
    const a = await keeper()
    const path = directory(),
      net = service(path)
    // The setup's own invitation: a named computer that works on threads, short-lived.
    const link = (await a.net.request('bridge.invite', { name: 'build-box', caps: ['read', 'chat', 'write', 'settings'], ttlMs: 15 * 60_000 })) as { invite: string }
    const joined = (await net.request('bridge.join', { invite: link.invite, name: 'build-box' })) as { node: NodeId }
    await vi.waitFor(() => expect(open(a.net, joined.node)).toBe(true), { timeout: 15_000 })
    expect(a.net.runtime().connections.state(joined.node)).toBe('connected')
    expect(net.runtime().connections.state(a.node)).toBe('connected')
    expect(await info(a.net, joined.node)).toMatchObject({ v: 1 })
    expect(await info(net, a.node)).toMatchObject({ v: 1 })
  }, 60_000)
})

describe('Spaces', () => {
  it('another user keeps reading a Space after the record, and a same-user device not connected gets none of its streams', async () => {
    const a = await keeper('Studio Mac', { spaces: true }),
      b = await member(a, 'Laptop', { spaces: true })
    const guest = await keeper('Guest Mac', { spaces: true })
    const host = spaceProfiles.get(a.net)!,
      space = host.host.create({ name: 'Design review' })
    const visitor = spaceProfiles.get(guest.net)!
    await visitor.client.join(visitor.client.prepareJoin(host.host.invite(space.space).text))
    await visitor.client.connect(space.space)
    expect(guest.user).not.toBe(a.user)

    // B is A's user, so a member of the Space. A's session with B serves B its streams while B is connected on A,
    // and none of them once B is disconnected there; the other user's member is untouched by A's records.
    const meta = spaceMetaStream(space.space)
    const gate = (on: NetService, node: NodeId) => {
      const session = on.session(node) as unknown as {
        peer: never
        options: { authority: { canRead(stream: typeof meta, peer: never): boolean }; isStreamBlocked(stream: typeof meta, peer: never): boolean }
      }
      return {
        read: session.options.authority.canRead(meta, session.peer),
        blocked: session.options.isStreamBlocked(meta, session.peer)
      }
    }
    await vi.waitFor(() => expect(open(a.net, guest.node)).toBe(true), { timeout: 15_000 })
    expect(gate(a.net, b.node)).toEqual({ read: true, blocked: false })
    expect(gate(a.net, guest.node)).toEqual({ read: true, blocked: false })
    await a.net.request('bridge.disconnect', { node: b.node })
    expect(gate(a.net, b.node)).toEqual({ read: false, blocked: true })
    expect(gate(a.net, guest.node)).toEqual({ read: true, blocked: false })
    expect(open(a.net, guest.node)).toBe(true)
  }, 120_000)
})
