import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetService } from '../../../src/mms/net/NetService'
import { systemClock } from '../../../src/mms/net/clock'
import { claimOffer, parseLink } from '../../../src/mms/net/enrollment/link'
import type { SecureChannel } from '../../../src/mms/net/contracts'
import type { ProfileTransports } from '../../../src/mms/net/transports/manager'
import {
  NetError,
  newId,
  type NetLinkCheck,
  type NetLinkMade,
  type NetLinkPasted,
  type NodeId,
  type StreamDescriptor
} from '../../../src/shared/net'
import type { HostedNetHost } from '../../../src/mms/net/hosted'
import type { Device } from '../../../src/renderer/lib/netDevices'

/**
 * A connect link: made on one computer, pasted on another. On the keeper it adds a computer, issued only once the
 * paster proves the link's key on a channel pinned to the maker; on any other device it only connects. A computer
 * that came in by a link made here is held until Allow. Real services on loopback; beacons are off throughout (no
 * interface to send on), so every address comes from the link, the published routes or the last address.
 */
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  networkInterfaces: () => ({})
}))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-connect-link-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))
  return path
}
function service(path: string, account?: ReturnType<typeof signedIn>): NetService {
  const net = new NetService({ profileDir: path, ...(account ? { hosted: account.factory } : {}) })
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
type Computer = { path: string; net: NetService; node: NodeId; account?: ReturnType<typeof signedIn> }
const self = (net: NetService) => net.runtime().identity.self()!.node
/** A keeper with a published direct route, as `net init --listen` leaves it. */
async function keeper(name = 'Studio Mac', account?: ReturnType<typeof signedIn>): Promise<Computer> {
  const path = directory(),
    net = service(path, account)
  await net.request('net.init', { name, listen: true, port: 0 })
  await net.request('net.protect', { passphrase: KEEPER_PASSPHRASE })
  return { path, net, node: self(net), ...(account ? { account } : {}) }
}
const make = async (net: NetService, params: Record<string, unknown> = {}) =>
  (await net.request('net.link.make', params)) as NetLinkMade
const paste = async (net: NetService, link: string, params: Record<string, unknown> = {}) =>
  (await net.request('net.link.paste', { link, ...params })) as NetLinkPasted
/** A fresh computer that joins `to` by pasting a link made there. */
async function joiner(to: Computer, name: string): Promise<Computer & { pasted: NetLinkPasted }> {
  const { link } = await make(to.net),
    path = directory(),
    net = service(path)
  const pasted = await paste(net, link, { name })
  return { path, net, node: self(net), pasted }
}
/** A computer that joins `to` with a raw invitation (connected both ways at once), and listens. */
async function member(to: Computer, name: string): Promise<Computer> {
  const path = directory(),
    net = service(path)
  const { invite } = (await to.net.request('bridge.invite', {})) as { invite: string }
  await net.request('bridge.join', { invite, name })
  await net.request('net.init', { listen: true, port: 0 })
  const node = self(net)
  await vi.waitFor(() => expect(open(to.net, node)).toBe(true), { timeout: 15_000 })
  return { path, net, node }
}
const KEEPER_PASSPHRASE = 'connect-link-keeper'
/** Restarts a computer; a keeper's keys are protected with a passphrase here, so it is unlocked again. */
async function restart<T extends Computer>(computer: T, passphrase?: string): Promise<T> {
  await computer.net.shutdown()
  const net = service(computer.path, computer.account)
  await net.start()
  if (passphrase !== undefined) await net.request('net.unlock', { passphrase })
  return { ...computer, net }
}
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
const invites = (net: NetService) =>
  net.runtime().db.database.prepare('SELECT state FROM net_enrollment_invites').all().map((row) => String(row.state))
const rosterSize = async (net: NetService) =>
  ((await net.request('bridge.nodes', {})) as { nodes: Device[] }).nodes.length
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: NetError) => error
  )
/** Dials a link from `from`, TLS pinned to the link and nothing sent yet. */
async function dial(from: NetService, link: string) {
  return (from as unknown as {
    dialLink(
      link: ReturnType<typeof parseLink>,
      credentials: unknown
    ): Promise<{ channel: SecureChannel; transport: ProfileTransports }>
  }).dialLink(parseLink(link), from.runtime().keys.tlsCredentials())
}
/** Runs `then` once the maker answered `net`'s claim with an invitation, before `net` redeems it. */
function afterClaim(net: NetService, then: () => void) {
  const target = net as unknown as { fetchFromLink(...args: unknown[]): Promise<unknown> },
    fetch = target.fetchFromLink.bind(net)
  target.fetchFromLink = async (...args) => {
    const answer = await fetch(...args)
    then()
    return answer
  }
}

describe('making a link', () => {
  it('on a fresh computer creates the identity, named after it, and asks for a passphrase once where the keychain refuses', async () => {
    const path = directory(),
      net = service(path)
    // Tests have no system keychain: the new keys cannot be protected without a passphrase.
    const refused = await rejection(make(net))
    expect(refused).toMatchObject({ code: 'keystore_locked', details: { reason: 'passphrase' } })
    const made = await make(net, { passphrase: 'connect-link-fresh' })
    expect(made).toMatchObject({ add: true, created: true })
    expect(net.status().self?.isAuthority).toBe(true)
    expect((await device(net, self(net))).name).toBe(hostname())
    const link = parseLink(made.link)
    expect(link.add).toBe(true)
    // Beacons off and no published route: the LAN listener on loopback is the one address, and the maker says so.
    expect(link.routes.map((route) => new URL(route.address).hostname)).toEqual(['127.0.0.1'])
    expect(made.reachable).toBe(false)
    // A new link stops the one before it.
    const next = await make(net)
    expect(net.runtime().links.state(link.offer)).toBe('cancelled')
    expect(net.runtime().links.state(parseLink(next.link).offer)).toBe('unused')
  }, 30_000)
})

describe('the offer path', () => {
  it('issues an invitation only for a proven claim: a bare connection or a wrong key binds and stores nothing, and a second joiner is refused', async () => {
    const a = await keeper()
    const { link } = await make(a.net)
    const offer = parseLink(link).offer
    expect(invites(a.net)).toEqual([])
    const other = await keeper('Other Mac')

    // TLS to the pinned key and nothing sent: the probe a Start over runs first.
    const bare = await dial(other.net, link)
    bare.channel.close()
    await bare.transport.teardown()
    // The right offer with a key that is not the link's.
    const wrong = await dial(other.net, link)
    const forged = { ...parseLink(link), key: new Uint8Array(32).fill(7) }
    expect(await rejection(claimOffer(wrong.channel, forged, 'add', systemClock))).toMatchObject({ code: 'invite_invalid' })
    await wrong.transport.teardown()
    expect(a.net.runtime().links.state(offer)).toBe('unused')
    expect(invites(a.net)).toEqual([])

    // A proven claim is issued an invitation at once, pinned to the claimer's key.
    const first = await dial(other.net, link)
    const answer = await claimOffer(first.channel, parseLink(link), 'add', systemClock)
    await first.transport.teardown()
    expect(answer.kind).toBe('invite')
    expect(a.net.runtime().links.state(offer)).toBe('claimed')
    expect(invites(a.net)).toEqual(['active'])

    // Another computer pasting the same link is refused, and nothing joins.
    const second = service(directory())
    const refused = await rejection(paste(second, link, { name: 'Laptop' }))
    expect(refused).toMatchObject({ code: 'invite_invalid', details: { reason: 'stale' } })
    expect(second.status().self).toBeUndefined()
    expect(await rosterSize(a.net)).toBe(1)
  }, 60_000)

  it('refuses an invitation still live on a cancelled link, as a stop between cancelling and revoking would leave it', async () => {
    const a = await keeper()
    const { link } = await make(a.net)
    const offer = parseLink(link).offer
    const b = service(directory())
    afterClaim(b, () => {
      a.net.runtime().db.database.prepare("UPDATE net_link_offers SET state='cancelled' WHERE id=?").run(offer)
    })
    expect(await rejection(paste(b, link, { name: 'Laptop' }))).toMatchObject({ code: 'invite_invalid' })
    expect(invites(a.net)).toEqual(['active'])
    expect(await rosterSize(a.net)).toBe(1)
  }, 60_000)

  it('ends an invitation with its link, and refuses it once the link has expired', async () => {
    const a = await keeper()
    const { link } = await make(a.net)
    const offer = parseLink(link).offer,
      db = a.net.runtime().db.database
    // Claimed a minute before the link ends.
    const deadline = systemClock.now() + 60_000
    db.prepare('UPDATE net_link_offers SET expires=? WHERE id=?').run(deadline, offer)
    const b = service(directory())
    let issuedUntil = Infinity
    afterClaim(b, () => {
      issuedUntil = Number((db.prepare('SELECT expires FROM net_enrollment_invites').get() as { expires: number }).expires)
      // The link ends before the invitation is redeemed.
      db.prepare('UPDATE net_link_offers SET expires=? WHERE id=?').run(systemClock.now() - 1, offer)
    })
    expect(await rejection(paste(b, link, { name: 'Laptop' }))).toMatchObject({ code: 'invite_invalid' })
    expect(issuedUntil).toBeLessThanOrEqual(deadline)
    expect(await rosterSize(a.net)).toBe(1)
  }, 60_000)

  it('Start over is offered from the link alone, and sets nothing aside until the maker answers', async () => {
    let a = await keeper()
    const path = directory(),
      alone = service(path)
    await alone.request('net.init', { name: 'Laptop' })
    let { link } = await make(a.net)
    expect((await alone.request('net.link.check', { link })) as NetLinkCheck).toMatchObject({
      row: 'start_over',
      startOver: { allowed: 'alone' }
    })
    expect(await rejection(paste(alone, link))).toMatchObject({ code: 'conflict', details: { reason: 'start_over' } })
    // The maker is off: nothing answers, and this computer keeps its network.
    await a.net.shutdown()
    expect(await rejection(paste(alone, link, { startOver: true }))).toMatchObject({
      code: 'route_unreachable',
      details: { reason: 'link_unreachable' }
    })
    expect(readdirSync(path).filter((entry) => entry.startsWith('net.'))).toEqual([])
    expect(alone.status().self?.isAuthority).toBe(true)

    a = await restart(a, KEEPER_PASSPHRASE)
    // The restart stopped the old link: it is stale now; a new one joins.
    ;({ link } = await make(a.net))
    const pasted = await paste(alone, link, { startOver: true, name: 'Laptop' })
    expect(pasted).toMatchObject({ row: 'join', node: a.node, connection: 'held' })
    expect(readdirSync(path).some((entry) => entry.startsWith('net.start-over-'))).toBe(true)
    expect(alone.status().self?.isAuthority).toBe(false)
  }, 60_000)
})

describe('a computer that came in by a link', () => {
  it('is held on the maker until Allow, also signed in to Mousse ID: its calls and subscriptions are refused through a dismissal and a restart, and Remove revokes it', async () => {
    const account = signedIn(true)
    let a = await keeper('Studio Mac', account)
    const b = await joiner(a, 'Laptop')
    expect(b.pasted).toMatchObject({ row: 'join', node: a.node, name: 'Studio Mac', connection: 'held', connected: true })
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'held' })
    // Mousse ID connects every device of the account as it appears, but not one waiting for Allow.
    account.set(false)
    account.set(true)
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'held' })
    await expect(info(b.net, a.node)).rejects.toMatchObject(notConnected)

    const descriptor: StreamDescriptor = { id: newId('stream'), kind: 'node.thread', authority: a.node, createdAt: systemClock.now() }
    a.net.runtime().streams.createStream(descriptor, 1)
    b.net.runtime().streams.createStream(descriptor, 1)
    const failed = vi.fn()
    const subscription = b.net.session(a.node).subscribe(descriptor.id, {
      onRecord: vi.fn(),
      onCaughtUp: vi.fn(),
      onSnapshotInstalled: vi.fn(),
      onError: failed
    })
    cleanups.push(() => subscription.close())
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith('forbidden'), { timeout: 15_000 })

    // Dismissing the notice writes nothing; a restart keeps the hold.
    a = await restart(a, KEEPER_PASSPHRASE)
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'held' })
    // B reaches the restarted maker again, and is still refused.
    await vi.waitFor(async () => expect(await rejection(info(b.net, a.node))).toMatchObject(notConnected), {
      timeout: 20_000,
      interval: 250
    })
    expect(await rejection(a.net.request('bridge.allow', { node: a.node }))).toMatchObject({ code: 'bad_request' })

    await a.net.request('bridge.allow', { node: b.node })
    expect(await device(a.net, b.node)).toMatchObject({
      connection: 'connected',
      policy: { work: true, terminal: false, editor: false, maxPermissionMode: 'accept_edits', agentReach: 'launched' }
    })
    expect(await info(b.net, a.node)).toBeTruthy()

    const c = await joiner(a, 'Desk PC')
    expect(await device(a.net, c.node)).toMatchObject({ connection: 'held' })
    await a.net.request('bridge.revoke', { node: c.node })
    expect(await device(a.net, c.node)).toBeUndefined()
  }, 120_000)

  it('is not connected by a plain connect, which skips choosing what it may do here', async () => {
    const a = await keeper(),
      b = await joiner(a, 'Laptop')
    expect(await rejection(a.net.request('bridge.connect', { node: b.node }))).toMatchObject({
      code: 'conflict',
      details: { reason: 'held' }
    })
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'held' })
  }, 60_000)

  it('takes Allow again after its answer was lost, and keeps what was changed since', async () => {
    const a = await keeper(),
      b = await joiner(a, 'Laptop')
    await a.net.request('bridge.allow', { node: b.node })
    await a.net.request('bridge.policy', { node: b.node, terminal: true })
    expect(await a.net.request('bridge.allow', { node: b.node })).toMatchObject({
      connection: 'connected',
      policy: { terminal: true, work: true }
    })
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'connected', policy: { terminal: true } })
  }, 60_000)

  it('collects its lost result after a new link and a maker restart, then both restart and a normal call works', async () => {
    let a = await keeper()
    const { link } = await make(a.net)
    const path = directory()
    let b = { path, net: service(path), node: '' as NodeId }
    // The joiner never sees the maker's answer once, though the maker committed it.
    const enrollment = b.net.runtime().enrollment,
      accept = enrollment.acceptNodeJoin.bind(enrollment)
    let lost = false
    enrollment.acceptNodeJoin = (...args) => {
      if (lost) return accept(...args)
      lost = true
      throw new NetError('peer_offline')
    }
    expect(await rejection(paste(b.net, link, { name: 'Laptop' }))).toMatchObject({ code: 'outcome_uncertain' })
    expect(b.net.status().unfinishedJoin).toBeDefined()

    await make(a.net)
    a = await restart(a, KEEPER_PASSPHRASE)
    const joined = (await b.net.request('net.join.retry', {})) as { node: NodeId; connected: boolean }
    expect(joined.connected).toBe(true)
    b = { ...b, node: joined.node }
    expect(await device(a.net, b.node)).toMatchObject({ connection: 'held' })
    expect(await device(b.net, a.node)).toMatchObject({ connection: 'held' })

    await a.net.request('bridge.allow', { node: b.node })
    await b.net.request('bridge.allow', { node: a.node })
    a = await restart(a, KEEPER_PASSPHRASE)
    b = await restart(b)
    await vi.waitFor(() => expect(open(b.net, a.node)).toBe(true), { timeout: 15_000 })
    expect(await info(b.net, a.node)).toBeTruthy()
    expect(await info(a.net, b.node)).toBeTruthy()
  }, 120_000)
})

describe('a link between two devices of one list', () => {
  it('connects them and enrolls nothing, and never lifts a hold', async () => {
    const a = await keeper(),
      b = await member(a, 'Laptop'),
      c = await member(a, 'Desk PC')
    const before = invites(a.net)
    const made = await make(b.net)
    expect(made).toMatchObject({ add: false, keeper: 'Studio Mac' })
    expect((await c.net.request('net.link.check', { link: made.link })) as NetLinkCheck).toMatchObject({ row: 'connect' })
    expect(await paste(c.net, made.link)).toMatchObject({ row: 'connect', node: b.node, connection: 'connected' })
    await vi.waitFor(() => expect(open(c.net, b.node) || open(b.net, c.node)).toBe(true), { timeout: 15_000 })
    expect(await device(b.net, c.node)).toMatchObject({ connection: 'connected' })
    expect(invites(a.net)).toEqual(before)
    expect(await rosterSize(a.net)).toBe(3)

    // A device held on the keeper stays held when the keeper pastes its connect-only link.
    const d = await joiner(a, 'Spare PC')
    const fromD = await make(d.net)
    expect(await paste(a.net, fromD.link)).toMatchObject({ row: 'connect', node: d.node, connection: 'held' })
    expect(await device(a.net, d.node)).toMatchObject({ connection: 'held' })
    expect(await device(d.net, a.node)).toMatchObject({ connection: 'held' })
  }, 120_000)

  it('with no published route and beacons off, a pairing and a connect-only link each open a session that survives a restart', async () => {
    let a: Computer = { path: directory(), net: undefined as never, node: '' as NodeId }
    a.net = service(a.path)
    const made = await make(a.net, { passphrase: KEEPER_PASSPHRASE })
    a.node = self(a.net)
    expect(((await a.net.request('net.routes', {})) as { routes: unknown[] }).routes).toEqual([])
    let b = await joiner(a, 'Laptop')
    expect(b.pasted.connected).toBe(true)
    expect(made.created).toBe(true)
    let c = await joiner(a, 'Desk PC')
    await vi.waitFor(() => expect(open(c.net, a.node)).toBe(true), { timeout: 15_000 })

    // B and C share no route at all: a connect-only link made on B is how C reaches it.
    const fromB = await make(b.net)
    expect(await paste(c.net, fromB.link)).toMatchObject({ row: 'connect', connection: 'connected' })
    await vi.waitFor(() => expect(open(c.net, b.node) || open(b.net, c.node)).toBe(true), { timeout: 15_000 })

    a = await restart(a, KEEPER_PASSPHRASE)
    b = { ...(await restart(b)), pasted: b.pasted }
    c = { ...(await restart(c)), pasted: c.pasted }
    await vi.waitFor(() => expect(open(b.net, a.node) || open(a.net, b.node)).toBe(true), { timeout: 20_000 })
    await vi.waitFor(() => expect(open(c.net, a.node) || open(a.net, c.node)).toBe(true), { timeout: 20_000 })
    await vi.waitFor(() => expect(open(c.net, b.node) || open(b.net, c.node)).toBe(true), { timeout: 20_000 })
  }, 150_000)
})
