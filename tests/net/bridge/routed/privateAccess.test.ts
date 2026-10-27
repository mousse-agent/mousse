/**
 * Who may read a private stream, over real sessions between real Net services: the one computer it
 * is bound to, while it holds "Works on threads", the owner's switch is on, the device is not blocked
 * and (for a terminal) its terminal switch is on. A phone, a read-only device and another computer never do.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadStreamAdapter,
  type ThreadSourceEvent
} from '../../../../src/mms/bridge/remote/ThreadStreamAdapter'
import type { PrivateSpec } from '../../../../src/mms/bridge/remote/privateStreams'
import { NetService, type NetDomainComposition } from '../../../../src/mms/net/NetService'
import { systemClock } from '../../../../src/mms/net/clock'
import { NodeStreamAuthority } from '../../../../src/mms/net/sync/nodeAuthority'
import type { NodeId, StreamDescriptor } from '../../../../src/shared/net'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function service(options: Partial<ConstructorParameters<typeof NetService>[0]> = {}): NetService {
  const net = new NetService({ profileDir: directory('net-private-'), ...options })
  cleanups.push(() => net.shutdown())
  return net
}

type Runtime = Parameters<
  NonNullable<ConstructorParameters<typeof NetService>[0]['composeRuntime']>
>[0]

/**
 * An owner whose display streams run on the real adapter, with a source that makes no claim about
 * threads: what is tested is who may read the stream, not what it holds.
 */
async function owner() {
  let adapter!: ThreadStreamAdapter
  let net!: NetService
  const compose = (rt: Runtime): NetDomainComposition => {
    adapter = new ThreadStreamAdapter({
      db: rt.db,
      store: rt.streams,
      generations: rt.streams,
      identity: rt.identity,
      keys: rt.keys,
      clock: systemClock,
      source: {
        snapshot: (key) => ({ kind: 'fake', key }),
        onThread: (_key, _listener: (event: ThreadSourceEvent) => void) => () => undefined
      },
      isSubscribed: (stream, holder) => net.streamSubscribed(stream, holder as NodeId | undefined)
    })
    cleanups.push(() => adapter.close())
    return {
      store: adapter.store,
      authority: new NodeStreamAuthority(
        rt.identity,
        adapter.store,
        rt.blobs,
        systemClock,
        adapter
      ),
      privateStreams: {
        access: (stream) => adapter.privateAccess(stream),
        close: (filter) => adapter.closePrivate(filter)
      }
    }
  }
  net = service({ composeRuntime: compose })
  await net.request('net.init', { name: 'owner', listen: true, port: 0 })
  await net.request('net.protect', { passphrase: 'test-owner-protection' })
  await net.request('bridge.workOnThreads', { enabled: true })
  const self = net.runtime().identity.self()!
  const join = async (invite: string, name: string) => {
    const device = service()
    const joined = (await device.request('bridge.join', { invite, name })) as { node: NodeId }
    await vi.waitFor(
      () => expect(net.status().peers).toContainEqual({ node: joined.node, state: 'open' }),
      { timeout: 10_000 }
    )
    await vi.waitFor(
      () => expect(device.status().peers).toContainEqual({ node: self.node, state: 'open' }),
      { timeout: 10_000 }
    )
    return { net: device, node: joined.node }
  }
  const invite = async (params: Record<string, unknown> = {}) =>
    ((await net.request('bridge.invite', params)) as { invite: string }).invite
  const phoneInvite = () =>
    net.runtime().enrollment.issueNodeInvite({ name: 'pocket', kind: 'phone' }).text

  /** A reader subscribing to a stream of the owner, and what it saw. */
  const watch = (reader: { net: NetService }, descriptor: StreamDescriptor) => {
    if (!reader.net.runtime().streams.getStream(descriptor.id))
      reader.net.runtime().streams.createStream(descriptor, 1)
    const seen = { records: 0, ready: false, error: undefined as string | undefined }
    const subscription = reader.net.session(self.node).subscribe(descriptor.id, {
      onRecord: () => {
        seen.records += 1
      },
      onCaughtUp: () => {
        seen.ready = true
      },
      onSnapshotInstalled: () => {
        seen.ready = true
      },
      onError: (code) => {
        seen.error = code
      }
    })
    let closed = false
    const stop = () => {
      if (!closed) subscription.close()
      closed = true
    }
    cleanups.push(stop)
    return { seen, stop }
  }
  const open = (spec: PrivateSpec) => adapter.openPrivate(spec)
  return { net, self, join, invite, phoneInvite, watch, open, adapter: () => adapter }
}

const ready = (watching: { seen: { ready: boolean } }) =>
  vi.waitFor(() => expect(watching.seen.ready).toBe(true), { timeout: 15_000 })
const refused = (watching: { seen: { error?: string } }) =>
  vi.waitFor(() => expect(watching.seen.error).toBe('forbidden'), { timeout: 15_000 })

describe('who reads a private stream', () => {
  it('is the computer it is bound to, and neither a phone, a read-only device nor another computer', async () => {
    const o = await owner()
    const laptop = await o.join(await o.invite(), 'laptop')
    const other = await o.join(await o.invite(), 'other computer')
    const phone = await o.join(o.phoneInvite(), 'pocket')
    const readOnly = await o.join(await o.invite({ caps: ['read'] }), 'read only')

    const mine = o.open({ reader: laptop.node, kind: 'thread', subject: 't1' })
    const watching = {
      laptop: o.watch(laptop, mine),
      other: o.watch(other, mine),
      phone: o.watch(phone, mine),
      readOnly: o.watch(readOnly, mine)
    }
    await ready(watching.laptop)
    expect(watching.laptop.seen.records).toBeGreaterThan(0)
    for (const denied of [watching.other, watching.phone, watching.readOnly]) {
      await refused(denied)
      expect(denied.seen.records).toBe(0)
      expect(denied.seen.ready).toBe(false)
    }

    // What a phone reads, the stream every device that may read has for the thread, is still open to it.
    const shared = o.watch(phone, o.adapter().activate('t-shared'))
    await ready(shared)
    expect(shared.seen.error).toBeUndefined()
  }, 120_000)

  it('stops being read when the computer loses Works on threads', async () => {
    const o = await owner()
    const laptop = await o.join(await o.invite(), 'laptop')
    const mine = o.open({ reader: laptop.node, kind: 'thread', subject: 't1' })
    const first = o.watch(laptop, mine)
    await ready(first)
    first.stop()

    // The owner takes the grant back (the authority re-signs the delegation without it).
    await o.net.request('bridge.setCaps', { node: laptop.node, caps: ['read', 'chat', 'write'] })
    const after = o.watch(laptop, mine)
    await refused(after)
    after.stop()

    await o.net.request('bridge.setCaps', {
      node: laptop.node,
      caps: ['read', 'chat', 'write', 'settings']
    })
    const back = o.watch(laptop, mine)
    await ready(back)
  }, 120_000)

  it('ends at once, and is refused again, when the owner turns the setting for other computers off', async () => {
    const o = await owner()
    const laptop = await o.join(await o.invite(), 'laptop')
    const phone = await o.join(o.phoneInvite(), 'pocket')
    const mine = o.open({ reader: laptop.node, kind: 'thread', subject: 't1' })
    const live = o.watch(laptop, mine)
    const shared = o.watch(phone, o.adapter().activate('t-shared'))
    await ready(live)
    await ready(shared)

    await o.net.request('bridge.workOnThreads', { enabled: false })
    await refused(live)
    live.stop()
    // The phone's stream is not a private one and goes on.
    expect(shared.seen.error).toBeUndefined()
    // While it is off a new subscription is refused too, and when it is on again the stream is there.
    const during = o.watch(laptop, mine)
    await refused(during)
    during.stop()
    await o.net.request('bridge.workOnThreads', { enabled: true })
    await ready(o.watch(laptop, mine))
  }, 120_000)

  it('ends at once for a blocked device, closes its streams, and serves it again when unblocked', async () => {
    const o = await owner()
    const laptop = await o.join(await o.invite(), 'laptop')
    const other = await o.join(await o.invite(), 'other computer')
    const mine = o.open({ reader: laptop.node, kind: 'thread', subject: 't1' })
    const theirs = o.open({ reader: other.node, kind: 'thread', subject: 't1' })
    const live = o.watch(laptop, mine)
    const otherLive = o.watch(other, theirs)
    await ready(live)
    await ready(otherLive)
    expect(o.adapter().privateHead(laptop.node, 't1')).toBeDefined()

    await o.net.request('bridge.policy', { node: laptop.node, blocked: true })
    await refused(live)
    live.stop()
    // Its stream is closed, not only unserved; another computer's is not touched.
    expect(o.adapter().privateHead(laptop.node, 't1')).toBeUndefined()
    expect(o.adapter().privateHead(other.node, 't1')).toBeDefined()
    expect(otherLive.seen.error).toBeUndefined()

    await o.net.request('bridge.policy', { node: laptop.node, blocked: false })
    await ready(o.watch(laptop, mine))
  }, 120_000)

  it('serves a terminal stream only while the device’s terminal switch is on', async () => {
    const o = await owner()
    const laptop = await o.join(await o.invite(), 'laptop')
    const terminal = o.open({ reader: laptop.node, kind: 'terminal', subject: 't1:pty-1' })
    // Off by default.
    const off = o.watch(laptop, terminal)
    await refused(off)
    off.stop()

    await o.net.request('bridge.policy', { node: laptop.node, terminal: true })
    const on = o.watch(laptop, terminal)
    await ready(on)
    // Another kind of stream of the same device does not depend on the switch.
    await ready(o.watch(laptop, o.open({ reader: laptop.node, kind: 'lists', subject: '' })))

    // Switching it off ends the terminal at once.
    await o.net.request('bridge.policy', { node: laptop.node, terminal: false })
    await refused(on)
  }, 120_000)
})
