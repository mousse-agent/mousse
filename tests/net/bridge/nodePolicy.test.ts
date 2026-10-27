import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteNodePolicy } from '../../../src/mms/net/store/nodePolicy'
import { validateIdentityDocument } from '../../../src/mms/net/plus/wire/crypto'
import { encodeEnvelope, parseProtocolJson } from '../../../src/mms/net/sync/codec'
import { systemClock } from '../../../src/mms/net/clock'
import type { Clock } from '../../../src/mms/net/contracts'
import {
  COMPUTER_NODE_CAPABILITIES,
  DEFAULT_NODE_CAPABILITIES,
  newId,
  type NodeCapability,
  type NodeDelegation,
  type NodeId,
  type Roster,
  type Signed,
  type StoredRecord,
  type StreamDescriptor
} from '../../../src/shared/net'
import type { BridgeNodePolicy } from '../../../src/shared/net/local'
import type { Device } from '../../../src/renderer/lib/netDevices'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function directory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}
function service(): NetService {
  const net = new NetService({ profileDir: directory('net-policy-') })
  cleanups.push(() => net.shutdown())
  return net
}
const body = (value: unknown) => (value ?? {}) as Record<string, unknown>

/** An authority that listens, and the helpers to enroll devices into its set. */
async function authority() {
  const a = service()
  await a.request('net.init', { name: 'authority', listen: true, port: 0 })
  await a.request('net.protect', { passphrase: 'test-authority-protection' })
  const self = a.runtime().identity.self()!
  const join = async (invite: string, name: string) => {
    const device = service()
    const joined = (await device.request('bridge.join', { invite, name })) as { node: NodeId }
    await vi.waitFor(
      () => expect(a.status().peers).toContainEqual({ node: joined.node, state: 'open' }),
      { timeout: 10_000 }
    )
    await vi.waitFor(
      () => expect(device.status().peers).toContainEqual({ node: self.node, state: 'open' }),
      { timeout: 10_000 }
    )
    return { net: device, node: joined.node }
  }
  const nodes = async () => ((await a.request('bridge.nodes', {})) as { nodes: Device[] }).nodes
  const device = async (node: NodeId) => (await nodes()).find((row) => row.node === node)!
  return { a, self, join, nodes, device }
}
const inviteText = async (a: NetService, params: Record<string, unknown> = {}) =>
  ((await a.request('bridge.invite', params)) as { invite: string }).invite

describe('which devices work on threads', () => {
  it('gives the authority and a computer invite the grant, and a phone never gets it', async () => {
    const { a, self, join, device } = await authority()
    expect((await device(self.node)).caps).toEqual([...COMPUTER_NODE_CAPABILITIES])

    // The default invite is for another computer, also what `mousse-cli bridge invite` sends.
    const laptop = await join(await inviteText(a), 'laptop')
    expect((await device(laptop.node)).caps).toEqual([...COMPUTER_NODE_CAPABILITIES])

    // A Mousse ID approval carries the kind of the request.
    const phone = await join(
      a.runtime().enrollment.issueNodeInvite({ name: 'pocket', kind: 'phone' }).text,
      'pocket'
    )
    expect((await device(phone.node)).caps).toEqual([...DEFAULT_NODE_CAPABILITIES])
    expect((await device(phone.node)).caps).not.toContain('settings')
    const approvedComputer = await join(
      a.runtime().enrollment.issueNodeInvite({ name: 'desk', kind: 'computer' }).text,
      'desk'
    )
    expect((await device(approvedComputer.node)).caps).toContain('settings')

    // The QR offer names no kind, so it is the phone grant.
    const unnamed = await join(
      a.runtime().enrollment.issueNodeInvite({ name: 'scan' }).text,
      'scan'
    )
    expect((await device(unnamed.node)).caps).not.toContain('settings')
  }, 60_000)

  it('keeps settings out of an invite that says it is for a phone, and honours named capabilities', async () => {
    const { a, join, device } = await authority()
    expect(() =>
      a.runtime().enrollment.issueNodeInvite({
        name: 'pocket',
        kind: 'phone',
        caps: ['read', 'chat', 'write', 'settings']
      })
    ).toThrow(expect.objectContaining({ code: 'bad_request' }))
    const named = await join(await inviteText(a, { caps: ['read', 'chat', 'write'] }), 'named')
    expect((await device(named.node)).caps).toEqual(['read', 'chat', 'write'])
  }, 60_000)

  it('re-signs a delegation with settings, and an older validator still accepts it', async () => {
    const { a, join, device } = await authority()
    const phone = await join(
      a.runtime().enrollment.issueNodeInvite({ name: 'pocket', kind: 'phone' }).text,
      'pocket'
    )
    const laptop = await join(await inviteText(a, { caps: ['read', 'chat', 'write'] }), 'laptop')
    const before = await device(laptop.node)
    expect(before.caps).not.toContain('settings')

    await a.request('bridge.setCaps', {
      node: laptop.node,
      caps: ['read', 'chat', 'write', 'settings']
    })
    const granted = await device(laptop.node)
    expect(granted.caps).toContain('settings')
    // Same key epoch and the same lease: only the capabilities change.
    expect(granted.keyEpoch).toBe(before.keyEpoch)
    expect(granted.expiresAt).toBe(before.expiresAt)

    // The document an older peer or the hosted relay reads has a name from its closed list.
    const identity = a.runtime().identity
    const root = identity.pinnedRootKey(identity.self()!.user)!
    const roster = identity.verifySigned<Roster>(identity.roster()!, root)
    validateIdentityDocument(roster, 'roster')
    for (const row of roster.nodes) {
      const payload = parseProtocolJson(Buffer.from(row.payload, 'base64url')) as NodeDelegation
      validateIdentityDocument(payload, 'nodeDelegation')
      if (payload.subject === laptop.node) expect(payload.caps).toContain('settings')
    }

    // Asking again for the same set leaves the roster as it is.
    const version = roster.version
    await a.request('bridge.setCaps', {
      node: laptop.node,
      caps: ['settings', 'write', 'chat', 'read']
    })
    expect(identity.verifySigned<Roster>(identity.roster()!, root).version).toBe(version)

    // Taking it away works, and a phone cannot be given it.
    await a.request('bridge.setCaps', { node: laptop.node, caps: ['read', 'chat', 'write'] })
    expect((await device(laptop.node)).caps).not.toContain('settings')
    await expect(
      a.request('bridge.setCaps', { node: phone.node, caps: ['read', 'chat', 'write', 'settings'] })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect((await device(phone.node)).caps).not.toContain('settings')

    // Only the authority signs delegations.
    await expect(
      laptop.net.request('bridge.setCaps', { node: laptop.node, caps: ['read', 'settings'] })
    ).rejects.toMatchObject({ code: 'forbidden' })
  }, 60_000)

  it('keeps the device working after a re-sign, so the row is not dated in the future', async () => {
    const { a, join, device } = await authority()
    const laptop = await join(await inviteText(a, { caps: ['read', 'chat', 'write'] }), 'laptop')
    a.runtime().rpc.register({
      method: 'test.ping',
      family: 'bridge',
      capability: 'read',
      mutating: false,
      ephemeral: true,
      handle: async () => ({ pong: true })
    })
    await a.request('bridge.setCaps', {
      node: laptop.node,
      caps: ['read', 'chat', 'write', 'settings']
    })
    expect((await device(laptop.node)).caps).toContain('settings')
    await vi.waitFor(async () =>
      expect(
        await laptop.net
          .session(a.runtime().identity.self()!.node)
          .rpc('test.ping', {}, { id: newId('rpc'), deadlineMs: 5000 })
      ).toEqual({ pong: true })
    )
  }, 60_000)
})

describe('a re-signed delegation and a fast authority clock', () => {
  function clocks() {
    let real = 1_700_000_000_000,
      ahead = 0
    const peer: Clock = {
      now: () => real,
      monotonic: () => real,
      setTimeout: () => ({ cancel() {} })
    }
    const fast: Clock = {
      now: () => real + ahead,
      monotonic: () => real + ahead,
      setTimeout: () => ({ cancel() {} })
    }
    return {
      peer,
      fast,
      pass: (ms: number) => {
        real += ms
      },
      runFast: (ms: number) => {
        ahead = ms
      }
    }
  }

  it('dates the new row from the previous one, never from the authority clock', async () => {
    const time = clocks()
    const dir = directory('net-caps-')
    const keys = new FileKeyStore(dir)
    await keys.initialize({ asAuthority: true })
    const db = new NetDatabase({ profileDir: dir, clock: time.fast })
    cleanups.push(() => db.close())
    const identity = new NetIdentityService({
      database: db.database,
      keys,
      clock: time.fast,
      coordinator: db
    })
    await identity.bootstrapAuthority('authority')
    const followerKeys = new FileKeyStore(directory('net-caps-peer-'))
    await followerKeys.initialize({ asAuthority: false })
    const node = newId('node')
    identity.issueNodeDelegation({
      node,
      keys: followerKeys.nodeKeys(),
      name: 'follower',
      caps: ['read', 'chat', 'write']
    })
    const rowOf = (): NodeDelegation => {
      const root = identity.pinnedRootKey(identity.self()!.user)!
      const roster = identity.verifySigned<Roster>(identity.roster()!, root)
      return roster.nodes
        .map((signed: Signed) => identity.verifySigned<NodeDelegation>(signed, root))
        .find((row) => row.subject === node)!
    }
    const original = rowOf()

    // Time passes, then the authority's clock jumps an hour ahead of every peer's.
    time.pass(5_000)
    time.runFast(3_600_000)
    identity.setNodeCaps(node, ['read', 'chat', 'write', 'settings'])

    const changed = rowOf()
    expect(changed.caps).toEqual(['read', 'chat', 'write', 'settings'])
    expect(changed.keyEpoch).toBe(original.keyEpoch)
    expect(changed.expiresAt).toBe(original.expiresAt)
    expect(changed.issuedAt).toBe(original.issuedAt + 1)
    // A peer on the right time accepts a row only when it is not dated after its own now.
    expect(changed.issuedAt).toBeLessThanOrEqual(time.peer.now())
    expect(changed.issuedAt).toBeLessThan(time.fast.now() - 3_000_000)
  })

  it('refuses an empty, repeated or unknown capability list', async () => {
    const dir = directory('net-caps-bad-')
    const keys = new FileKeyStore(dir)
    await keys.initialize({ asAuthority: true })
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(() => db.close())
    const identity = new NetIdentityService({
      database: db.database,
      keys,
      clock: systemClock,
      coordinator: db
    })
    await identity.bootstrapAuthority('authority')
    const self = identity.self()!.node
    for (const caps of [[], ['read', 'read'], ['read', 'root']] as unknown as NodeCapability[][])
      expect(() => identity.setNodeCaps(self, caps)).toThrow(
        expect.objectContaining({ code: 'bad_request' })
      )
    expect(() => identity.setNodeCaps(newId('node'), ['read'])).toThrow(
      expect.objectContaining({ code: 'bad_request' })
    )
  })
})

describe('blocking a device on a computer', () => {
  function threadStream(a: NetService, b: NetService) {
    const self = a.runtime().identity.self()!
    const descriptor: StreamDescriptor = {
      id: newId('stream'),
      kind: 'node.thread',
      authority: self.node,
      createdAt: systemClock.now()
    }
    a.runtime().streams.createStream(descriptor, 1)
    b.runtime().streams.createStream(descriptor, 1)
    const record = (seq: number): StoredRecord => {
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
      return {
        epoch: 1,
        seq,
        recvTs: systemClock.now(),
        envelope,
        sig: a.runtime().keys.signAsNode(envelope)
      }
    }
    const append = async (seq: number) => {
      const row = record(seq)
      a.runtime().streams.appendAsAuthority(descriptor.id, {
        id: (parseProtocolJson(Buffer.from(row.envelope)) as { id: never }).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
      await a.publish(descriptor.id, row)
    }
    return { id: descriptor.id, append }
  }
  const call = (b: NetService, a: NetService, method: string, idem?: string, id = newId('rpc')) =>
    b
      .session(a.runtime().identity.self()!.node)
      .rpc(method, {}, { id, ...(idem ? { idem } : {}), deadlineMs: 5000 })

  it('refuses a blocked device on its next call, its stored results, and the phone API, until unblocked', async () => {
    const { a, join } = await authority()
    const laptop = await join(await inviteText(a), 'laptop')
    const rpc = a.runtime().rpc
    for (const family of ['bridge', 'routed'] as const)
      rpc.register({
        method: `test.${family}`,
        family,
        capability: 'read',
        mutating: false,
        ephemeral: true,
        handle: async () => ({ family })
      })
    let effects = 0
    rpc.register({
      method: 'test.write',
      family: 'bridge',
      capability: 'write',
      mutating: true,
      handle: async () => ({ effects: ++effects })
    })
    expect(await call(laptop.net, a, 'test.bridge')).toEqual({ family: 'bridge' })
    expect(await call(laptop.net, a, 'test.routed')).toEqual({ family: 'routed' })
    const written = newId('rpc')
    expect(await call(laptop.net, a, 'test.write', 'write-1', written)).toEqual({ effects: 1 })

    const blocked = body(await a.request('bridge.policy', { node: laptop.node, blocked: true }))
    expect((blocked.policy as BridgeNodePolicy).blocked).toBe(true)
    await expect(call(laptop.net, a, 'test.bridge')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call(laptop.net, a, 'test.routed')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call(laptop.net, a, 'test.write', 'write-2')).rejects.toMatchObject({
      code: 'forbidden'
    })
    // What it asked for earlier cannot be read back either.
    await expect(
      laptop.net.session(a.runtime().identity.self()!.node).rpcResult(written, { deadlineMs: 5000 })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(effects).toBe(1)
    // The connection stays: the device list and its version still work, and nothing was revoked.
    expect(
      await laptop.net.session(a.runtime().identity.self()!.node).rpc(
        'net.info',
        {},
        {
          id: newId('rpc'),
          deadlineMs: 5000
        }
      )
    ).toMatchObject({ v: 1 })
    const row = (await a.request('bridge.nodes', {})) as { nodes: Device[] }
    expect(row.nodes.find((entry) => entry.node === laptop.node)).toMatchObject({
      revoked: false,
      policy: { blocked: true }
    })

    await a.request('bridge.policy', { node: laptop.node, blocked: false })
    expect(await call(laptop.net, a, 'test.bridge')).toEqual({ family: 'bridge' })
    expect(
      await laptop.net
        .session(a.runtime().identity.self()!.node)
        .rpcResult(written, { deadlineMs: 5000 })
    ).toEqual({ effects: 1 })
  }, 60_000)

  it('closes the open subscription of a blocked device and refuses a new one, until unblocked', async () => {
    const { a, join } = await authority()
    const laptop = await join(await inviteText(a), 'laptop')
    const stream = threadStream(a, laptop.net)
    const session = () => laptop.net.session(a.runtime().identity.self()!.node)
    const received = vi.fn(),
      failed = vi.fn()
    const subscription = session().subscribe(stream.id, {
      onRecord: received,
      onCaughtUp: vi.fn(),
      onSnapshotInstalled: vi.fn(),
      onError: failed
    })
    cleanups.push(() => subscription.close())
    await stream.append(1)
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1))

    await a.request('bridge.policy', { node: laptop.node, blocked: true })
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith('forbidden'))
    await stream.append(2)
    expect(received).toHaveBeenCalledTimes(1)

    // Asking again is refused as well.
    const again = vi.fn()
    session().subscribe(stream.id, {
      onRecord: vi.fn(),
      onCaughtUp: vi.fn(),
      onSnapshotInstalled: vi.fn(),
      onError: again
    })
    await vi.waitFor(() => expect(again).toHaveBeenCalledWith('forbidden'))
    // Only that stream was refused: the connection, and what rides on it, stays up.
    expect(session().state()).toBe('open')

    await a.request('bridge.policy', { node: laptop.node, blocked: false })
    const resumed = vi.fn()
    const next = session().subscribe(stream.id, {
      onRecord: resumed,
      onCaughtUp: vi.fn(),
      onSnapshotInstalled: vi.fn(),
      onError: vi.fn()
    })
    cleanups.push(() => next.close())
    // It picks up from where it was: the record it missed while blocked arrives.
    await vi.waitFor(() => expect(resumed).toHaveBeenCalled())
  }, 60_000)

  it('asks the requests a blocked device has running to stop', async () => {
    const { a, join } = await authority()
    const laptop = await join(await inviteText(a), 'laptop')
    const started = vi.fn(),
      stopped = vi.fn()
    a.runtime().rpc.register({
      method: 'test.hold',
      family: 'bridge',
      capability: 'write',
      mutating: true,
      handle: (_params, context) =>
        new Promise((resolve) => {
          started()
          context.signal.addEventListener(
            'abort',
            () => {
              stopped()
              resolve({ stopped: true })
            },
            { once: true }
          )
        })
    })
    const running = call(laptop.net, a, 'test.hold', 'hold-1').catch((error) => error)
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    await a.request('bridge.policy', { node: laptop.node, blocked: true })
    await vi.waitFor(() => expect(stopped).toHaveBeenCalled())
    // A handler that had started cannot claim it rolled back.
    expect(await running).toMatchObject({ code: 'outcome_uncertain' })
  }, 60_000)

  it('lists the defaults and keeps the limits of one device apart from another', async () => {
    const { a, join, device, self } = await authority()
    const one = await join(await inviteText(a), 'one')
    const two = await join(await inviteText(a), 'two')
    expect((await device(one.node)).policy).toEqual({
      blocked: false,
      maxPermissionMode: 'accept_edits',
      terminal: false
    })

    await a.request('bridge.policy', { node: one.node, maxPermissionMode: 'full', terminal: true })
    expect((await device(one.node)).policy).toEqual({
      blocked: false,
      maxPermissionMode: 'full',
      terminal: true
    })
    expect((await device(two.node)).policy).toEqual({
      blocked: false,
      maxPermissionMode: 'accept_edits',
      terminal: false
    })

    // Unknown devices, this computer and unknown modes are refused; nothing is written for them.
    await expect(
      a.request('bridge.policy', { node: newId('node'), blocked: true })
    ).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(
      a.request('bridge.policy', { node: self.node, blocked: true })
    ).rejects.toMatchObject({
      code: 'bad_request'
    })
    await expect(
      a.request('bridge.policy', { node: one.node, maxPermissionMode: 'root' })
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(
      a
        .runtime()
        .policy.list()
        .map((row) => row.node)
    ).toEqual([one.node])
  }, 60_000)
})

describe('net_node_policy', () => {
  it('keeps limits across a restart and tells a listener only after the row is stored', () => {
    const profileDir = directory('net-policy-store-')
    const node = newId('node')
    let db = new NetDatabase({ profileDir })
    let policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node)).toMatchObject({
      blocked: false,
      maxPermissionMode: 'accept_edits',
      terminal: false
    })
    const seen: boolean[] = []
    policy.onChange((event) => seen.push(policy.isBlocked(event.node)))
    policy.set(node, { blocked: true, terminal: true })
    expect(seen).toEqual([true])
    // A change inside a failing transaction is not reported and not kept.
    expect(() =>
      db.transaction(() => {
        policy.set(node, { blocked: false })
        throw new Error('rolled back')
      })
    ).toThrow('rolled back')
    expect(seen).toEqual([true])
    expect(policy.isBlocked(node)).toBe(true)
    db.close()

    db = new NetDatabase({ profileDir })
    cleanups.push(() => db.close())
    policy = new SqliteNodePolicy(db, systemClock)
    expect(policy.get(node)).toMatchObject({ blocked: true, terminal: true })
    expect(policy.isBlocked(node)).toBe(true)
    // A mode this build does not know reads as the strictest one.
    db.database
      .prepare("UPDATE net_node_policy SET max_permission_mode='root' WHERE node=?")
      .run(node)
    expect(policy.get(node).maxPermissionMode).toBe('ask')
  })
})
