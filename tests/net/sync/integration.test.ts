import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  newId,
  NetError,
  type NodeDelegation,
  type StoredRecord,
  type StreamDescriptor
} from '../../../src/shared/net'
import { DirectTransport } from '../../../src/mms/net/transports/direct'
import { FakeClock } from '../harness/FakeClock'
import { systemClock } from '../../../src/mms/net/clock'
import { FileKeyStore, NetIdentityService } from '../../../src/mms/net/identity'
import { NetDatabase } from '../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../src/mms/net/store/streams'
import { FileBlobStore } from '../../../src/mms/net/store/blobs'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { SqliteExecutionLedger } from '../../../src/mms/net/store/executions'
import { openSecureChannel } from '../../../src/mms/net/link/secureChannel'
import { fingerprint, generateSelfSignedCert } from '../../../src/mms/net/link/selfSignedCert'
import { encodeEnvelope } from '../../../src/mms/net/sync/codec'
import { NetSyncSession } from '../../../src/mms/net/sync/session'
import { DurableRpcDispatcher } from '../../../src/mms/net/sync/rpcDispatcher'
import { SubscriptionReceiver } from '../../../src/mms/net/sync/subscription'
import { SyncSupervisor } from '../../../src/mms/net/sync/supervisor'
import { makeTempDir } from '../harness/tmp'
import { memoryPair } from '../harness/MemoryTransport'
import type { Clock, TlsCredentials } from '../../../src/mms/net/contracts'
import type { SessionCapability } from '../../../src/shared/net/capabilities'

const resources: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
})

async function profiles(clock: Clock = systemClock) {
  const aPath = makeTempDir('sync-a-').path,
    bPath = makeTempDir('sync-b-').path
  const aDb = new NetDatabase({ profileDir: aPath }),
    bDb = new NetDatabase({ profileDir: bPath })
  resources.push(
    () => aDb.close(),
    () => bDb.close()
  )
  const aKeys = new FileKeyStore(aPath),
    bKeys = new FileKeyStore(bPath)
  const aIdentity = new NetIdentityService({
    database: aDb.database,
    keys: aKeys,
    clock,
    coordinator: aDb
  })
  await aIdentity.bootstrapAuthority('authority')
  await bKeys.initialize({ asAuthority: false })
  const node = newId('node'),
    user = aIdentity.self()!.user
  const delegation = aIdentity.issueNodeDelegation({
    node,
    keys: bKeys.nodeKeys(),
    name: 'follower',
    caps: ['read', 'chat', 'write']
  })
  const bIdentity = new NetIdentityService({
    database: bDb.database,
    keys: bKeys,
    clock,
    coordinator: bDb,
    self: { node, user }
  })
  bIdentity.pinUser(user, aKeys.rootKey()!)
  bIdentity.acceptRoster(aIdentity.roster()!, aKeys.rootKey()!)
  const aStore = new SqliteStreamStore(aDb),
    bStore = new SqliteStreamStore(bDb)
  const aBlobs = new FileBlobStore(aDb)
  resources.push(() => aBlobs.close())
  const stream: StreamDescriptor = {
    id: newId('stream'),
    kind: 'node.thread',
    authority: aIdentity.self()!.node,
    createdAt: systemClock.now()
  }
  aStore.createStream(stream, 1)
  bStore.createStream(stream, 1)
  const record = (seq: number, streamId = stream.id): StoredRecord => {
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: streamId,
      type: 'message.posted',
      crit: false,
      author: { user, node: aIdentity.self()!.node, keyEpoch: 1 },
      ts: systemClock.now(),
      body: { text: `record ${seq}` }
    })
    return { epoch: 1, seq, recvTs: systemClock.now(), envelope, sig: aKeys.signAsNode(envelope) }
  }
  return {
    aPath,
    bPath,
    aDb,
    bDb,
    aKeys,
    bKeys,
    aIdentity,
    bIdentity,
    aStore,
    bStore,
    aBlobs,
    stream,
    record,
    delegation
  }
}

async function sessions(
  p: Awaited<ReturnType<typeof profiles>>,
  options: {
    clientCredentials?: TlsCredentials
    rpc?: DurableRpcDispatcher
    direct?: boolean
    clock?: Clock
    readerCapabilities?: SessionCapability[]
  } = {}
) {
  const pair = memoryPair()
  let aRaw: Duplex = pair.b,
    bRaw: Duplex = pair.a
  let direct: DirectTransport | undefined
  if (options.direct) {
    pair.cut()
    direct = new DirectTransport({ enabled: true })
    const dialer = new DirectTransport()
    await direct.provision()
    await dialer.provision()
    resources.push(
      () => direct!.teardown(),
      () => dialer.teardown()
    )
    let accept!: (raw: Duplex) => void
    const accepted = new Promise<Duplex>((resolve) => {
      accept = resolve
    })
    await direct.listen(accept)
    bRaw = await dialer.dial(direct.status().routes[0], new AbortController().signal)
    aRaw = await accepted
  }
  const [aChannel, bChannel] = await Promise.all([
    openSecureChannel(aRaw, {
      role: 'server',
      credentials: p.aKeys.tlsCredentials(),
      deadlineMs: 2_000
    }),
    openSecureChannel(bRaw, {
      role: 'client',
      credentials: options.clientCredentials ?? p.bKeys.tlsCredentials(),
      expectedPeerFingerprint: fingerprint(Buffer.from(p.aKeys.nodeKeys().transport, 'base64url')),
      deadlineMs: 2_000
    })
  ])
  const authority = new NodeStreamAuthority(
    p.aIdentity,
    p.aStore,
    p.aBlobs,
    options.clock ?? systemClock
  )
  const a = new NetSyncSession({
    channel: aChannel,
    identity: p.aIdentity,
    store: p.aStore,
    authority,
    blobs: p.aBlobs,
    rpc: options.rpc,
    clock: options.clock,
    onAuthenticated: () => direct?.markAuthenticated(aRaw)
  })
  const b = new NetSyncSession({
    channel: bChannel,
    identity: p.bIdentity,
    store: p.bStore,
    capabilities: options.readerCapabilities ?? ['streams.v1', 'rpc.v1', 'blobs.v1'],
    clock: options.clock
  })
  resources.push(
    () => a.close(),
    () => b.close()
  )
  return { a, b, pair }
}

function oversizedRecord(seq: number, bytes: number): StoredRecord {
  return {
    epoch: 1,
    seq,
    recvTs: systemClock.now(),
    envelope: new Uint8Array(bytes),
    sig: new Uint8Array(64)
  }
}
function handlers() {
  return { onRecord: vi.fn(), onCaughtUp: vi.fn(), onSnapshotInstalled: vi.fn(), onError: vi.fn() }
}
/** Appends `count` signed records of about `bytes` each to the owner's stream. */
function appendLarge(p: Awaited<ReturnType<typeof profiles>>, count: number, bytes: number) {
  const user = p.aIdentity.self()!.user,
    node = p.aIdentity.self()!.node
  for (let i = 0; i < count; i++) {
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: p.stream.id,
      type: 'message.posted',
      crit: false,
      author: { user, node, keyEpoch: 1 },
      ts: systemClock.now(),
      body: { text: 'x'.repeat(bytes) }
    })
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(envelope).toString()).id,
      envelope,
      sig: p.aKeys.signAsNode(envelope),
      recvTs: systemClock.now()
    })
  }
}
type MuxSend = (lane: string, message: { header: { t: string } }) => Promise<void>
/** The owner's mux lanes, snapshot jobs and authority, which these tests watch or switch. */
function internals(session: NetSyncSession) {
  return session as unknown as {
    mux: { send: MuxSend; lanes: { bulk: { active?: { offset: number } } } }
    snapshotJobs: Map<string, unknown>
    negotiatedCaps: string[]
    serving: Map<string, unknown>
    jobs: Map<Promise<unknown>, { stream?: string }>
    finishing: Map<string, unknown>
    held: Map<string, unknown>
    finishDeadlineMs: number
    receive(message: { header: { t: string } }): Promise<void>
    options: { authority: NodeStreamAuthority }
  }
}

describe('durable subscription fault boundaries', () => {
  it('keeps live 105 buffered during replay, then resumes from durable 89 after a cut', async () => {
    const p = await profiles(),
      rows = Array.from({ length: 105 }, (_, i) => p.record(i + 1))
    p.bStore.applyFromAuthority(p.stream.id, rows.slice(0, 79))
    const first = handlers(),
      request = vi.fn()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, first, () => {}, request)
    receiver.subscribed({ epoch: 1, seq: 104 }, 104)
    receiver.receive([rows[104]])
    receiver.receive(rows.slice(79, 89))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(89)
    expect(first.onRecord).toHaveBeenCalledTimes(10)
    receiver.close()
    const next = handlers(),
      resumed = new SubscriptionReceiver(p.stream.id, p.bStore, next, () => {}, request)
    resumed.subscribed({ epoch: 1, seq: 105 }, 105)
    resumed.receive(rows.slice(89))
    resumed.caughtUp()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(105)
    expect(next.onRecord).toHaveBeenCalledTimes(16)
    expect(next.onCaughtUp).toHaveBeenCalledOnce()
    resumed.receive([rows[104]])
    expect(next.onRecord).toHaveBeenCalledTimes(16)
  })
  it('resubscribes a caught-up gap without promoting the advertised head', async () => {
    const p = await profiles(),
      h = handlers(),
      request = vi.fn()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, h, () => {}, request)
    receiver.subscribed({ epoch: 1, seq: 2 }, 2)
    receiver.receive([p.record(2)])
    receiver.caughtUp()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(h.onCaughtUp).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(false)
  })
  it('rejects conflicting metadata at an already committed position', async () => {
    const p = await profiles(),
      row = p.record(1),
      receiver = new SubscriptionReceiver(p.stream.id, p.bStore, handlers(), () => {}, vi.fn())
    receiver.subscribed({ epoch: 1, seq: 1 }, 1)
    receiver.receive([row])
    expect(() => receiver.receive([{ ...row, recvTs: row.recvTs + 1 }])).toThrow(/Conflicting/)
    expect(p.bStore.cursor(p.stream.id).seq).toBe(1)
  })
  it('drops a 1001-row live overlap and restarts from the unchanged cursor', async () => {
    const p = await profiles(),
      h = handlers(),
      request = vi.fn()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, h, () => {}, request)
    receiver.subscribed({ epoch: 1, seq: 1002 }, 1002)
    receiver.receive(Array.from({ length: 1001 }, (_, i) => p.record(i + 2)))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(h.onRecord).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(false)
  })
  it('discards an interrupted snapshot and preserves the active durable generation', async () => {
    const p = await profiles(),
      old = p.record(1)
    p.bStore.applyFromAuthority(p.stream.id, [old])
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, handlers(), () => {}, vi.fn())
    receiver.snapshotRequired({ epoch: 1, seq: 2 })
    receiver.snapshotChunk({ epoch: 1, seq: 2 }, [old], false)
    receiver.close()
    expect(
      p.bStore.getById(p.stream.id, JSON.parse(Buffer.from(old.envelope).toString()).id)?.envelope
    ).toEqual(old.envelope)
    expect(p.bStore.cursor(p.stream.id).seq).toBe(1)
  })
  it('pins the first snapshot chunk when the source head grew after snapshotRequired', async () => {
    const p = await profiles(),
      h = handlers()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, h, () => {}, vi.fn())
    receiver.snapshotRequired({ epoch: 1, seq: 1 })
    receiver.snapshotChunk({ epoch: 1, seq: 2 }, [p.record(1), p.record(2)], true)
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(2)
  })
})

describe('real identity + SQLite + TLS + mux sessions', () => {
  it('discards already-started delivery after unsubscribe without closing the session', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers(),
      subscription = connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    const row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(row.envelope).toString()).id,
      envelope: row.envelope,
      sig: row.sig,
      recvTs: row.recvTs
    })
    const received = vi.spyOn(
      connection.b as unknown as { receive(message: unknown): Promise<void> },
      'receive'
    )
    const delivery = connection.a.publishRecord(p.stream.id, row)
    subscription.close()
    await delivery
    const send = (connection.a as unknown as { send(message: unknown): Promise<void> }).send.bind(
      connection.a
    )
    await send({
      t: 'subscribed',
      stream: p.stream.id,
      head: { epoch: 1, seq: 1 },
      replayThrough: 1
    })
    await send({ t: 'caughtUp', stream: p.stream.id })
    await send({
      t: 'snapshotRequired',
      stream: p.stream.id,
      head: { epoch: 1, seq: 1 },
      reason: 'cursorTooOld'
    })
    await send({
      t: 'snapshot.chunk',
      stream: p.stream.id,
      epoch: 1,
      throughSeq: 1,
      records: [],
      done: true,
      parts: []
    })
    await vi.waitFor(() =>
      expect(
        received.mock.calls.some(
          ([message]) => (message as { header: { t: string } }).header.t === 'snapshot.chunk'
        )
      ).toBe(true)
    )
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(h.onRecord).not.toHaveBeenCalled()
  })
  it('resumes live commits made during a pinned snapshot without closing or skipping', async () => {
    const p = await profiles(),
      rows = [p.record(1), p.record(2)]
    const append = (row: StoredRecord) =>
      p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(row.envelope).toString()).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
    append(rows[0])
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const original = p.aStore.openSnapshot.bind(p.aStore)
    let connection: Awaited<ReturnType<typeof sessions>>,
      injected = false
    vi.spyOn(p.aStore, 'openSnapshot').mockImplementation((stream) => {
      const reader = original(stream)
      return {
        target: reader.target,
        next: (bytes, records) => {
          const page = reader.next(bytes, records)
          if (!injected) {
            injected = true
            append(rows[1])
            void connection.a.publishRecord(stream, rows[1])
          }
          return page
        },
        close: () => reader.close()
      }
    })
    connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(2)
    expect(h.onRecord).toHaveBeenCalledTimes(1)
    expect(h.onRecord.mock.calls[0][0].seq).toBe(2)
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('delivers a burst of large live records in order without dropping any', async () => {
    // A refreshed thread display snapshot appends one ~44 KiB chunk record after another and
    // publishes each as it commits; together they exceed the 256 KiB control-lane queue.
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    const user = p.aIdentity.self()!.user,
      node = p.aIdentity.self()!.node,
      rows: StoredRecord[] = []
    for (let seq = 1; seq <= 16; seq++) {
      const envelope = encodeEnvelope({
        v: 1,
        minor: 0,
        id: newId('event'),
        stream: p.stream.id,
        type: 'thread.snapshot.chunk',
        crit: false,
        author: { user, node, keyEpoch: 1 },
        ts: systemClock.now(),
        body: {
          threadId: 'thread-1',
          snapshot: '00000000-0000-4000-8000-000000000000',
          index: seq - 1,
          data: Buffer.alloc(32 * 1024, seq).toString('base64url')
        }
      })
      const sig = p.aKeys.signAsNode(envelope)
      const position = p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(envelope).toString()).id,
        envelope,
        sig,
        recvTs: systemClock.now()
      })
      rows.push({ ...position, envelope, sig })
    }
    const results = await Promise.allSettled(
      rows.map((row) => connection.a.publishRecord(p.stream.id, row))
    )
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])
    await vi.waitFor(() => expect(p.bStore.cursor(p.stream.id).seq).toBe(16), { timeout: 10_000 })
    expect(h.onRecord.mock.calls.map(([row]) => row.seq)).toEqual(rows.map((row) => row.seq))
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('queues a burst larger than 8 MiB on a stalled link and delivers it when the link drains', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const send = vi
      .spyOn(connection.a as unknown as { sendRecords: () => Promise<void> }, 'sendRecords')
      .mockImplementation(() => stalled)
    // One refreshed display snapshot is enqueued all at once: 20 x 500 KiB passes the former cap.
    const queued = Array.from({ length: 20 }, (_, i) =>
      connection.a.publishRecord(p.stream.id, oversizedRecord(i + 1, 500 * 1024))
    )
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    release()
    expect((await Promise.allSettled(queued)).map((result) => result.status)).toEqual(
      Array(20).fill('fulfilled')
    )
    expect(send).toHaveBeenCalledTimes(20)
    expect(h.onError).not.toHaveBeenCalled()
    expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
  })
  it('resyncs a subscriber that lags past the live queue cap instead of detaching it', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    // A stalled link: the first send never completes, so every later record waits behind it.
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const send = vi
      .spyOn(connection.a as unknown as { sendRecords: () => Promise<void> }, 'sendRecords')
      .mockImplementationOnce(() => stalled)
    // Records share one buffer. Seven 8 MiB records fit under the 64 MiB cap and the eighth overflows.
    const body = new Uint8Array(8 * 1024 * 1024)
    const row = (seq: number): StoredRecord => ({ ...oversizedRecord(seq, 0), envelope: body })
    const queued = Array.from({ length: 7 }, (_, i) =>
      connection.a.publishRecord(p.stream.id, row(i + 1))
    )
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    await connection.a.publishRecord(p.stream.id, row(8))
    // The subscriber pulls a snapshot and resumes live: no error, no detach.
    await vi.waitFor(() => expect(h.onSnapshotInstalled).toHaveBeenCalledOnce(), {
      timeout: 10_000
    })
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    release()
    await Promise.allSettled(queued)
    expect(h.onError).not.toHaveBeenCalled()
    // Only the record already in flight went out live; the dropped backlog never reached the mux.
    expect(send.mock.calls.filter(([, , live]) => live === false)).toHaveLength(1)
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('stops a stalled replay when the live queue overflows so no caughtUp follows the resync', async () => {
    const p = await profiles()
    for (const row of Array.from({ length: 3 }, (_, i) => p.record(i + 1)))
      p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(row.envelope).toString()).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const sent: string[] = []
    const send = (
      connection.a as unknown as { send: (header: { t: string }) => Promise<void> }
    ).send.bind(connection.a)
    vi.spyOn(connection.a as never, 'send' as never).mockImplementation((async (
      header: { t: string },
      ...rest: unknown[]
    ) => {
      sent.push(header.t)
      return (send as (...args: unknown[]) => Promise<void>)(header, ...rest)
    }) as never)
    // The first replay page never completes, so the replay is still in flight at overflow time.
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    type SendRecords = (...args: unknown[]) => Promise<void>
    const realSendRecords = (
      connection.a as unknown as { sendRecords: SendRecords }
    ).sendRecords.bind(connection.a)
    let calls = 0
    const replay = vi
      .spyOn(connection.a as unknown as { sendRecords: SendRecords }, 'sendRecords')
      .mockImplementation((...args) => {
        // Replay stalls on its first page; the bogus live record is dropped; snapshot pages pass.
        if (++calls === 1) return stalled
        return args[2] === false ? Promise.resolve() : realSendRecords(...args)
      })
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce())
    const body = new Uint8Array(8 * 1024 * 1024)
    const overflow = Array.from({ length: 8 }, (_, i) =>
      connection.a.publishRecord(p.stream.id, { ...oversizedRecord(i + 1, 0), envelope: body })
    )
    await Promise.allSettled(overflow)
    release()
    await vi.waitFor(() => expect(h.onSnapshotInstalled).toHaveBeenCalledOnce(), {
      timeout: 10_000
    })
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 10_000 })
    // The only caughtUp is the one that follows the post-snapshot subscribe.
    const resync = sent.indexOf('snapshotRequired')
    expect(sent.slice(resync, sent.indexOf('caughtUp', resync) + 1)).toContain('subscribed')
    expect(sent.filter((t) => t === 'caughtUp')).toHaveLength(1)
    expect(h.onError).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('resyncs a subscriber whose replay start is trimmed mid-replay instead of closing the link', async () => {
    const p = await profiles()
    for (const row of Array.from({ length: 3 }, (_, i) => p.record(i + 1)))
      p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(row.envelope).toString()).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const sent: string[] = []
    const send = (
      connection.a as unknown as { send: (header: { t: string }) => Promise<void> }
    ).send.bind(connection.a)
    let trimmed = false
    vi.spyOn(connection.a as never, 'send' as never).mockImplementation((async (
      header: { t: string },
      ...rest: unknown[]
    ) => {
      sent.push(header.t)
      const result = await (send as (...args: unknown[]) => Promise<void>)(header, ...rest)
      // A display snapshot refresh trims the history the replay was about to read.
      if (header.t === 'subscribed' && !trimmed) {
        trimmed = true
        p.aStore.truncate(p.stream.id, 2, { forgetIds: true })
      }
      return result
    }) as never)
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onSnapshotInstalled).toHaveBeenCalledOnce(), {
      timeout: 10_000
    })
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(trimmed).toBe(true)
    // The trimmed replay ends in a resync request, never in a caughtUp of its own.
    const resync = sent.indexOf('snapshotRequired')
    expect(resync).toBeGreaterThan(sent.indexOf('subscribed'))
    expect(sent.filter((t) => t === 'caughtUp')).toHaveLength(1)
    expect(p.bStore.cursor(p.stream.id).seq).toBe(3)
    expect(h.onError).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('finishes a snapshot chunk being written when the reader lets the stream go, and keeps the link', async () => {
    const p = await profiles()
    appendLarge(p, 4, 40 * 1024)
    const other = { ...p.stream, id: newId('stream') }
    p.aStore.createStream(other, 1)
    p.bStore.createStream(other, 1)
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const owner = internals(connection.a)
    // A slow link from the owner, so the 160 KiB chunk is still being written when the reader lets go.
    connection.pair.backward.slow(1024)
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const h = handlers(),
      subscription = connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0), {
      interval: 1,
      timeout: 10_000
    })
    subscription.close()
    await vi.waitFor(() => expect(owner.snapshotJobs.size).toBe(0), { interval: 1 })
    await vi.waitFor(() => expect(owner.mux.lanes.bulk.active).toBeUndefined(), {
      interval: 1,
      timeout: 10_000
    })
    // Another stream on the same connection is still served.
    const next = handlers()
    connection.b.subscribe(other.id, next)
    await vi.waitFor(() => expect(next.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(errors).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
    expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
  })
  it.each(['slowed', 'stalled'] as const)(
    'ends a snapshot on a block without closing the link or starting another chunk (%s link)',
    async (link) => {
      const p = await profiles()
      // About three 512 KiB chunks.
      appendLarge(p, 30, 40 * 1024)
      const other = { ...p.stream, id: newId('stream') }
      p.aStore.createStream(other, 1)
      p.bStore.createStream(other, 1)
      const connection = await sessions(p)
      await Promise.all([connection.a.opened, connection.b.opened])
      const errors: unknown[] = []
      connection.a.onClosed((error) => errors.push(error))
      connection.b.onClosed((error) => errors.push(error))
      const owner = internals(connection.a)
      const sent = vi.spyOn(owner.mux, 'send')
      const chunks = () =>
        sent.mock.calls.filter(([, message]) => message.header.t === 'snapshot.chunk').length
      connection.pair.backward.slow(4 * 1024)
      vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
      const h = handlers()
      connection.b.subscribe(p.stream.id, h)
      await vi.waitFor(() => expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0), {
        interval: 1,
        timeout: 10_000
      })
      expect(chunks()).toBe(1)
      if (link === 'stalled') connection.pair.backward.stall()
      // The `forbidden` it sends waits for the link like everything else.
      const ended = connection.a.endServing('forbidden')
      if (link === 'stalled') {
        // A reader that reads nothing for a while still gets no new chunk once the block is in.
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(chunks()).toBe(1)
        connection.pair.backward.resume()
      }
      await ended
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('forbidden'), {
        timeout: 10_000
      })
      await vi.waitFor(() => expect(owner.mux.lanes.bulk.active).toBeUndefined(), {
        interval: 1,
        timeout: 10_000
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      // The chunk under way finished; no other started after the block.
      expect(chunks()).toBe(1)
      expect(owner.snapshotJobs.size).toBe(0)
      expect(errors).toEqual([])
      expect(connection.a.state()).toBe('open')
      expect(connection.b.state()).toBe('open')
      expect(h.onError).toHaveBeenCalledOnce()
      expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
      const next = handlers()
      connection.b.subscribe(other.id, next)
      await vi.waitFor(() => expect(next.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 10_000 })
    }
  )
  it.each([
    ['the last chunk', 2],
    ['an earlier chunk', 1]
  ] as const)(
    'installs the whole snapshot when the reader resubscribes while %s is being written',
    async (_, index) => {
      // 20 records of 40 KiB make two chunks (12 and 8 records).
      const p = await profiles()
      appendLarge(p, 20, 40 * 1024)
      const connection = await sessions(p)
      await Promise.all([connection.a.opened, connection.b.opened])
      const errors: unknown[] = []
      connection.a.onClosed((error) => errors.push(error))
      connection.b.onClosed((error) => errors.push(error))
      const owner = internals(connection.a)
      const sent = vi.spyOn(owner.mux, 'send')
      const chunks = () =>
        sent.mock.calls.filter(([, message]) => message.header.t === 'snapshot.chunk').length
      connection.pair.backward.slow(4 * 1024)
      vi.spyOn(p.aStore, 'snapshotReason')
        .mockReturnValueOnce('cursorTooOld')
        .mockReturnValueOnce('cursorTooOld')
      const first = handlers(),
        subscription = connection.b.subscribe(p.stream.id, first)
      await vi.waitFor(
        () => {
          expect(chunks()).toBe(index)
          expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0)
        },
        { interval: 1, timeout: 10_000 }
      )
      // Let go and subscribe again while that chunk is still being written.
      subscription.close()
      const h = handlers()
      connection.b.subscribe(p.stream.id, h)
      await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 20_000 })
      expect(h.onSnapshotInstalled).toHaveBeenCalledOnce()
      expect(
        p.bStore
          .read(p.stream.id, { epoch: 1, seq: 0 }, 20, 4 * 1024 * 1024)
          .records.map((record) => record.seq)
      ).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      expect(h.onError).not.toHaveBeenCalled()
      expect(first.onSnapshotInstalled).not.toHaveBeenCalled()
      expect(errors).toEqual([])
      expect(connection.a.state()).toBe('open')
      expect(connection.b.state()).toBe('open')
    }
  )
  it('still closes the link as before when a reader without snapshot.stale.v1 lets go during a chunk', async () => {
    const p = await profiles()
    appendLarge(p, 20, 40 * 1024)
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const owner = internals(connection.a)
    owner.negotiatedCaps = owner.negotiatedCaps.filter((cap) => cap !== 'snapshot.stale.v1')
    const closed: unknown[] = []
    connection.a.onClosed((error) => closed.push(error))
    const sent = vi.spyOn(owner.mux, 'send')
    const chunks = () =>
      sent.mock.calls.filter(([, message]) => message.header.t === 'snapshot.chunk').length
    connection.pair.backward.slow(4 * 1024)
    vi.spyOn(p.aStore, 'snapshotReason')
      .mockReturnValueOnce('cursorTooOld')
      .mockReturnValueOnce('cursorTooOld')
    const subscription = connection.b.subscribe(p.stream.id, handlers())
    await vi.waitFor(
      () => {
        expect(chunks()).toBe(2)
        expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0)
      },
      { interval: 1, timeout: 10_000 }
    )
    // An older reader would take the rest of the chunk as the start of its next snapshot, so the chunk
    // stops part way and the connection closes, retryably, as before. The reader's store is untouched.
    subscription.close()
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'), { timeout: 10_000 })
    expect(closed).toEqual([expect.objectContaining({ code: 'route_unreachable' })])
    expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
  })
  describe('a request for a stream whose stopped chunk is still being written', () => {
    /** A reader that let go of a stream while its 20-record snapshot chunk was half written. */
    async function letGoMidChunk(link: 'slowed' | 'stalled') {
      const p = await profiles()
      appendLarge(p, 20, 40 * 1024)
      const connection = await sessions(p)
      await Promise.all([connection.a.opened, connection.b.opened])
      const closed: unknown[] = []
      connection.a.onClosed((error) => closed.push(error))
      const owner = internals(connection.a)
      const sent = vi.spyOn(owner.mux, 'send')
      connection.pair.backward.slow(4 * 1024)
      vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
      const subscription = connection.b.subscribe(p.stream.id, handlers())
      await vi.waitFor(() => expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0), {
        interval: 1,
        timeout: 10_000
      })
      if (link === 'stalled') connection.pair.backward.stall()
      subscription.close()
      await vi.waitFor(() => expect(owner.finishing.has(p.stream.id)).toBe(true), { interval: 1 })
      const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(
        connection.b
      )
      return { p, connection, owner, sent, closed, send, from: sent.mock.calls.length }
    }

    it('holds at most one of many requests, however many the reader sends', async () => {
      const { p, owner, send, connection } = await letGoMidChunk('stalled')
      const received = vi.spyOn(owner, 'receive')
      for (let i = 0; i < 50; i++) {
        await send({ t: 'subscribe', stream: p.stream.id, after: { epoch: 1, seq: 0 } })
        await send({ t: 'snapshot.get', stream: p.stream.id })
      }
      await vi.waitFor(() =>
        expect(
          received.mock.calls.filter(([message]) =>
            ['subscribe', 'snapshot.get'].includes(message.header.t)
          )
        ).toHaveLength(100)
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      // The finishing chunk's own work, and the one request that waits for it.
      const waiting = [...owner.jobs.values()].filter((scope) => scope.stream === p.stream.id)
      expect(waiting.length).toBeLessThanOrEqual(3)
      expect(owner.held.size).toBe(1)
      expect(connection.a.state()).toBe('open')
    })

    it('serves nothing after unsubscribe, subscribe and unsubscribe during the chunk', async () => {
      const { p, connection, owner, sent, closed, from } = await letGoMidChunk('slowed')
      // The reader subscribes again and lets go once more while the chunk is still being written.
      connection.b.subscribe(p.stream.id, handlers()).close()
      await vi.waitFor(() => expect(owner.finishing.size).toBe(0), { timeout: 10_000 })
      await vi.waitFor(() => expect(owner.mux.lanes.bulk.active).toBeUndefined(), {
        timeout: 10_000
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(owner.serving.has(p.stream.id)).toBe(false)
      expect(owner.held.size).toBe(0)
      const after = sent.mock.calls.slice(from).map(([, message]) => message.header.t)
      expect(after).not.toContain('subscribed')
      expect(after).not.toContain('events')
      expect(after).not.toContain('snapshotRequired')
      expect(closed).toEqual([])
      expect(connection.a.state()).toBe('open')
    })

    it('closes the link retryably when the chunk does not finish in time', async () => {
      const { p, connection, owner, closed } = await letGoMidChunk('stalled')
      owner.finishDeadlineMs = 300
      const h = handlers()
      connection.b.subscribe(p.stream.id, h)
      await vi.waitFor(() => expect(connection.a.state()).toBe('closed'), { timeout: 3_000 })
      expect(closed).toEqual([expect.objectContaining({ code: 'route_unreachable' })])
      expect(owner.held.size).toBe(0)
      expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
      expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    })
  })
  it('closes the link retryably when a full control lane refuses the forbidden for a live record', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const closed: unknown[] = []
    connection.a.onClosed((error) => closed.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    vi.spyOn(internals(connection.a).options.authority, 'canRead').mockReturnValue(false)
    const send = (
      connection.a as unknown as { send: (...args: unknown[]) => Promise<void> }
    ).send.bind(connection.a)
    vi.spyOn(connection.a as never, 'send' as never).mockImplementation(((
      header: { t: string },
      ...rest: unknown[]
    ) =>
      header.t === 'error'
        ? Promise.reject(new NetError('rate_limited', 'Mux waiting queue is full.'))
        : send(header, ...rest)) as never)
    const row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(row.envelope).toString()).id,
      envelope: row.envelope,
      sig: row.sig,
      recvTs: row.recvTs
    })
    await Promise.allSettled([connection.a.publishRecord(p.stream.id, row)])
    // The reader is not left subscribed with nothing arriving: its supervisor reconnects.
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'))
    expect(closed).toEqual([expect.objectContaining({ code: 'route_unreachable' })])
    expect(h.onRecord).not.toHaveBeenCalled()
  })
  it('offers snapshot.stale.v1 once when a caller lists it too', async () => {
    const p = await profiles(),
      connection = await sessions(p, {
        readerCapabilities: ['streams.v1', 'rpc.v1', 'blobs.v1', 'snapshot.stale.v1']
      })
    await Promise.all([connection.a.opened, connection.b.opened])
    for (const session of [connection.a, connection.b])
      expect(
        internals(session).negotiatedCaps.filter((cap) => cap === 'snapshot.stale.v1')
      ).toHaveLength(1)
  })
  it('stops a chunk part way when its space is archived, so the archive drains and the reader is not left waiting', async () => {
    const p = await profiles()
    appendLarge(p, 20, 40 * 1024)
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const owner = internals(connection.a)
    connection.pair.backward.slow(4 * 1024)
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0), {
      interval: 1,
      timeout: 10_000
    })
    // A member that stops reading cannot hold the archive up.
    connection.pair.backward.stall()
    const space = 'spc_archive' as never
    connection.a.cancelSpaceStreams(space, [p.stream.id])
    const drained = await Promise.race([
      Promise.allSettled(connection.a.archiveTasks(space, [p.stream.id])).then(() => 'drained'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 2_000))
    ])
    expect(drained).toBe('drained')
    // The reader learns at once: its staged snapshot is dropped and it can reconnect.
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce())
    expect(connection.b.state()).toBe('closed')
    expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
  })
  it('closes at once on revocation while a stopped chunk is still being written', async () => {
    const p = await profiles()
    appendLarge(p, 30, 40 * 1024)
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const owner = internals(connection.a)
    const received = vi.spyOn(
      connection.b as unknown as { receive(message: { header: { t: string } }): Promise<void> },
      'receive'
    )
    // About half a second to write the 512 KiB chunk.
    connection.pair.backward.slow(1024)
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const subscription = connection.b.subscribe(p.stream.id, handlers())
    await vi.waitFor(() => expect(owner.mux.lanes.bulk.active?.offset ?? 0).toBeGreaterThan(0), {
      interval: 1,
      timeout: 10_000
    })
    subscription.close()
    await vi.waitFor(() => expect(owner.snapshotJobs.size).toBe(0), { interval: 1 })
    expect(owner.mux.lanes.bulk.active).toBeDefined()
    const revoked = Date.now()
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'), { interval: 1 })
    expect(Date.now() - revoked).toBeLessThan(300)
    await vi.waitFor(() => expect(connection.b.state()).toBe('closed'))
    // The rest of the chunk never reached the reader.
    expect(received.mock.calls.map(([message]) => message.header.t)).not.toContain('snapshot.chunk')
  })
  it('answers a new subscription of a stream it may no longer read with forbidden on that stream alone', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    vi.spyOn(internals(connection.a).options.authority, 'canRead').mockReturnValue(false)
    const row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(row.envelope).toString()).id,
      envelope: row.envelope,
      sig: row.sig,
      recvTs: row.recvTs
    })
    await connection.a.publishRecord(p.stream.id, row)
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('forbidden'))
    // The consumer subscribes again, as a supervisor does on every reconnect.
    const again = handlers()
    connection.b.subscribe(p.stream.id, again)
    await vi.waitFor(() => expect(again.onError).toHaveBeenCalledWith('forbidden'))
    const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(
      connection.b
    )
    await send({ t: 'snapshot.get', stream: p.stream.id })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(errors).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('ends a caught-up stream with forbidden when its read right is gone at the next record', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    // The reader's `read` capability is removed, or it leaves the space, without a block.
    vi.spyOn(internals(connection.a).options.authority, 'canRead').mockReturnValue(false)
    const received = vi.spyOn(
      connection.b as unknown as { receive(message: { header: { t: string } }): Promise<void> },
      'receive'
    )
    const row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(row.envelope).toString()).id,
      envelope: row.envelope,
      sig: row.sig,
      recvTs: row.recvTs
    })
    const [published] = await Promise.allSettled([connection.a.publishRecord(p.stream.id, row)])
    expect(published.status).toBe('fulfilled')
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('forbidden'))
    expect(h.onError).toHaveBeenCalledOnce()
    const types = received.mock.calls.map(([message]) => message.header.t)
    expect(types).not.toContain('events')
    expect(types).not.toContain('rosterUpdate')
    expect(h.onRecord).not.toHaveBeenCalled()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(errors).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('ends a lagging subscriber that lost its read right with forbidden, not a resync to the head', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const send = vi
      .spyOn(connection.a as unknown as { sendRecords: () => Promise<void> }, 'sendRecords')
      .mockImplementationOnce(() => stalled)
    const body = new Uint8Array(8 * 1024 * 1024)
    const row = (seq: number): StoredRecord => ({ ...oversizedRecord(seq, 0), envelope: body })
    const queued = Array.from({ length: 7 }, (_, i) =>
      connection.a.publishRecord(p.stream.id, row(i + 1))
    )
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    vi.spyOn(internals(connection.a).options.authority, 'canRead').mockReturnValue(false)
    const received = vi.spyOn(
      connection.b as unknown as { receive(message: { header: { t: string } }): Promise<void> },
      'receive'
    )
    // The eighth record overflows the live queue while the reader may no longer read the stream.
    await connection.a.publishRecord(p.stream.id, row(8))
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('forbidden'))
    release()
    await Promise.allSettled(queued)
    const types = received.mock.calls.map(([message]) => message.header.t)
    expect(types).not.toContain('snapshotRequired')
    expect(types.filter((t) => t === 'error')).toHaveLength(1)
    expect(h.onError).toHaveBeenCalledOnce()
    expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('fails the session when the resync request cannot be sent to a lagging subscriber', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    const closed: unknown[] = []
    connection.a.onClosed((error) => closed.push(error))
    vi.spyOn(
      connection.a as unknown as { sendRecords: () => Promise<void> },
      'sendRecords'
    ).mockImplementationOnce(() => new Promise<void>(() => undefined))
    vi.spyOn(
      connection.a as unknown as { send: (header: { t: string }) => Promise<void> },
      'send'
    ).mockImplementation(async (header) => {
      if (header.t === 'snapshotRequired') throw new NetError('rate_limited')
    })
    const body = new Uint8Array(8 * 1024 * 1024)
    for (let seq = 1; seq <= 8; seq++)
      void connection.a
        .publishRecord(p.stream.id, { ...oversizedRecord(seq, 0), envelope: body })
        .catch(() => undefined)
    // A swallowed send would leave the subscriber attached and silent; the session reconnects instead.
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'))
    // A carrier failure, so a supervised peer reconnects instead of treating it as terminal.
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ code: 'route_unreachable' })
  })
  it('keeps the code of a resync send failure that is not a full carrier', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    const closed: unknown[] = []
    connection.a.onClosed((error) => closed.push(error))
    vi.spyOn(
      connection.a as unknown as { sendRecords: () => Promise<void> },
      'sendRecords'
    ).mockImplementationOnce(() => new Promise<void>(() => undefined))
    vi.spyOn(
      connection.a as unknown as { send: (header: { t: string }) => Promise<void> },
      'send'
    ).mockImplementation(async (header) => {
      if (header.t === 'snapshotRequired') throw new NetError('bad_request')
    })
    const body = new Uint8Array(8 * 1024 * 1024)
    for (let seq = 1; seq <= 8; seq++)
      void connection.a
        .publishRecord(p.stream.id, { ...oversizedRecord(seq, 0), envelope: body })
        .catch(() => undefined)
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'))
    // Only a full carrier becomes a retryable carrier failure.
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ code: 'bad_request' })
  })
  it('accepts a valid 500-record wire snapshot through bounded storage appends', async () => {
    const p = await profiles()
    for (let i = 1; i <= 500; i++) {
      const row = p.record(i)
      p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(row.envelope).toString()).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
    }
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const original = p.aStore.openSnapshot.bind(p.aStore)
    vi.spyOn(p.aStore, 'openSnapshot').mockImplementation((stream) => {
      const reader = original(stream)
      return {
        target: reader.target,
        next: (bytes) => reader.next(bytes, 500),
        close: () => reader.close()
      }
    })
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const errors: unknown[] = []
    connection.a.onClosed((error) => errors.push(error))
    connection.b.onClosed((error) => errors.push(error))
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(
      () => {
        expect(errors).toEqual([])
        expect(h.onCaughtUp).toHaveBeenCalledOnce()
      },
      { timeout: 10_000 }
    )
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(500)
  })
  it('cuts signed replay at durable89 with live105 ahead, then resumes once over direct', async () => {
    const p = await profiles(),
      rows = Array.from({ length: 105 }, (_, i) => p.record(i + 1))
    for (const row of rows.slice(0, 104))
      p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(row.envelope).toString()).id,
        envelope: row.envelope,
        sig: row.sig,
        recvTs: row.recvTs
      })
    p.bStore.applyFromAuthority(p.stream.id, rows.slice(0, 79))
    const original = p.aStore.read.bind(p.aStore)
    vi.spyOn(p.aStore, 'read').mockImplementation((stream, after, through, bytes) => {
      const page = original(stream, after, through, bytes)
      return { records: page.records.slice(0, 10), done: page.records.length <= 10 && page.done }
    })
    const first = await sessions(p)
    await Promise.all([first.a.opened, first.b.opened])
    const h = handlers()
    h.onRecord.mockImplementation((row) => {
      if (row.seq === 89) first.b.close()
    })
    // Hook the signed subscribed boundary to place a committed live record ahead of replay.
    const send = (
      first.a as unknown as {
        send(
          message: import('../../../src/shared/net').WireMessage,
          parts?: Uint8Array[]
        ): Promise<void>
      }
    ).send.bind(first.a)
    const sendSpy = vi.spyOn(first.a as never, 'send' as never) as unknown as {
      mockImplementation(callback: typeof send): void
    }
    let injected = false
    sendSpy.mockImplementation(async (message, parts) => {
      await send(message, parts)
      if (message.t === 'subscribed' && !injected) {
        injected = true
        const row = rows[104]
        p.aStore.appendAsAuthority(p.stream.id, {
          id: JSON.parse(Buffer.from(row.envelope).toString()).id,
          envelope: row.envelope,
          sig: row.sig,
          recvTs: row.recvTs
        })
        await first.a.publishRecord(p.stream.id, row)
      }
    })
    first.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(first.b.state()).toBe('closed'))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(89)
    expect(h.onRecord).toHaveBeenCalledTimes(10)
    first.a.close()
    const next = await sessions(p, { direct: true })
    await Promise.all([next.a.opened, next.b.opened])
    const resumed = handlers()
    next.b.subscribe(p.stream.id, resumed)
    await vi.waitFor(() => expect(resumed.onCaughtUp).toHaveBeenCalledOnce())
    expect(p.bStore.cursor(p.stream.id).seq).toBe(105)
    expect(resumed.onRecord).toHaveBeenCalledTimes(16)
  })

  it('coalesces 100 stalled snapshot requests and closes the reader on unsubscribe', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const close = vi.fn(),
      open = vi.spyOn(p.aStore, 'openSnapshot').mockImplementation(() => ({
        target: { epoch: 1, seq: 0 },
        next: () => ({ records: [], done: true }),
        close
      }))
    connection.pair.backward.stall()
    const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(
      connection.b
    )
    await Promise.all(
      Array.from({ length: 100 }, () => send({ t: 'snapshot.get', stream: p.stream.id }))
    )
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(close).not.toHaveBeenCalled()
    await send({ t: 'unsubscribe', stream: p.stream.id })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    connection.a.close()
    expect(close).toHaveBeenCalledOnce()
  })
  it('releases a failed snapshot slot and starts the waiting subscription', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    connection.pair.backward.stall()
    const streams = [p.stream.id]
    for (let i = 0; i < 4; i++) {
      const descriptor = { ...p.stream, id: newId('stream') }
      streams.push(descriptor.id)
      p.aStore.createStream(descriptor, 1)
      p.bStore.createStream(descriptor, 1)
    }
    const receive = (
      connection.b as unknown as { receive(message: unknown): Promise<void> }
    ).receive.bind(connection.b)
    for (const stream of streams) {
      connection.b.subscribe(stream, handlers())
      await receive({
        header: {
          t: 'snapshotRequired',
          stream,
          reason: 'cursorTooOld',
          head: { epoch: 1, seq: 0 }
        },
        parts: []
      })
    }
    const state = connection.b as unknown as {
      snapshotReceiving: Set<string>
      snapshotWaiting: Set<string>
    }
    expect(state.snapshotReceiving.size).toBe(4)
    expect(state.snapshotWaiting.has(streams[4])).toBe(true)
    await receive({
      header: {
        t: 'error',
        re: streams[0],
        error: { code: 'forbidden', message: 'Forbidden', retryable: false }
      },
      parts: []
    })
    expect(state.snapshotReceiving.has(streams[0])).toBe(false)
    expect(state.snapshotReceiving.has(streams[4])).toBe(true)
    expect(state.snapshotWaiting.size).toBe(0)
  })
  it('closes a silent half-open TLS session after three unanswered ping intervals', async () => {
    const clock = new FakeClock(Date.now()),
      p = await profiles(clock),
      connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    const closed = vi.fn()
    connection.b.onClosed(closed)
    connection.pair.forward.halfOpen()
    connection.pair.backward.halfOpen()
    for (let i = 0; i < 4; i++) {
      clock.advance(20_000)
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(connection.b.state()).toBe('closed')
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ code: 'peer_offline' }))
  })
  it('supplies an expired original lease to a fresh subscriber before replay', async () => {
    const clock = new FakeClock(Date.now()),
      p = await profiles(clock),
      row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(row.envelope).toString()).id,
      envelope: row.envelope,
      sig: row.sig,
      recvTs: row.recvTs
    })
    for (let i = 0; i < 3; i++) {
      clock.advance(6 * 24 * 60 * 60 * 1_000)
      p.aIdentity.renewExpiring()
    }
    const path = makeTempDir('fresh-history-').path,
      db = new NetDatabase({ profileDir: path }),
      keys = new FileKeyStore(path)
    resources.push(() => db.close())
    await keys.initialize({ asAuthority: false })
    const node = newId('node'),
      user = p.aIdentity.self()!.user
    p.aIdentity.issueNodeDelegation({ node, keys: keys.nodeKeys(), name: 'fresh', caps: ['read'] })
    const identity = new NetIdentityService({
      database: db.database,
      keys,
      clock,
      coordinator: db,
      self: { node, user }
    })
    identity.pinUser(user, p.aKeys.rootKey()!)
    identity.acceptRoster(p.aIdentity.roster()!, p.aKeys.rootKey()!)
    expect(() =>
      identity.verifyAuthor(
        JSON.parse(Buffer.from(row.envelope).toString()).author,
        row.envelope,
        row.sig,
        JSON.parse(Buffer.from(row.envelope).toString()).ts,
        'history'
      )
    ).toThrow()
    const store = new SqliteStreamStore(db)
    store.createStream(p.stream, 1)
    Object.assign(p, { bKeys: keys, bIdentity: identity, bStore: store })
    const connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    expect(h.onRecord).toHaveBeenCalledOnce()
    expect(connection.b.state()).toBe('open')
    expect(identity.roster()!.payload).toBe(p.aIdentity.roster()!.payload)
  })
  it('fetches a referenced blob through the production same-user authority', async () => {
    const p = await profiles(),
      bytes = Buffer.alloc(150_000, 42),
      blob =
        `blb_${createHash('sha256').update(bytes).digest('hex')}` as import('../../../src/shared/net').BlobId
    const upload = p.aBlobs.begin(blob, bytes.length, false)
    for (let at = 0; at < bytes.length; at += 48 * 1024)
      upload.write(at, bytes.subarray(at, at + 48 * 1024))
    upload.commit()
    const id = newId('event'),
      envelope = encodeEnvelope({
        v: 1,
        minor: 0,
        id,
        stream: p.stream.id,
        type: 'message.posted',
        crit: false,
        author: { user: p.aIdentity.self()!.user, node: p.aIdentity.self()!.node, keyEpoch: 1 },
        ts: Date.now(),
        body: { text: 'attachment' },
        blobs: [{ id: blob, bytes: bytes.length, mime: 'application/octet-stream', sealed: false }]
      })
    p.aStore.appendAsAuthority(p.stream.id, {
      id,
      envelope,
      sig: p.aKeys.signAsNode(envelope),
      recvTs: Date.now()
    })
    p.aBlobs.addRef(blob, p.stream.id, id)
    const connection = await sessions(p, { direct: true })
    await Promise.all([connection.a.opened, connection.b.opened])
    expect(Buffer.from(await connection.b.getBlob(p.stream.id, blob)).equals(bytes)).toBe(true)
    const other = newId('stream')
    expect(() => connection.b.getBlob(other, blob)).toThrow()
    // Repeated same-blob requests cannot start competing offset loops.
    connection.a.close()
    connection.b.close()
    const stalled = await sessions(p)
    await Promise.all([stalled.a.opened, stalled.b.opened])
    stalled.pair.backward.stall()
    const read = vi.spyOn(p.aBlobs, 'read'),
      download = stalled.b.getBlob(p.stream.id, blob).catch((error) => error)
    const send = (stalled.b as unknown as { send(message: unknown): Promise<void> }).send.bind(
      stalled.b
    )
    await Promise.all(
      Array.from({ length: 20 }, () =>
        send({ t: 'blob.get', stream: p.stream.id, blob, offset: 0 })
      )
    )
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    stalled.a.close()
    stalled.b.close()
    await download
    expect(read).toHaveBeenCalledOnce()
  })

  it('authenticates, replicates signed records, disconnects and resumes once', async () => {
    const p = await profiles(),
      rows = Array.from({ length: 3 }, (_, i) => p.record(i + 1))
    for (const record of rows.slice(0, 2))
      p.aStore.appendAsAuthority(p.stream.id, {
        id: JSON.parse(Buffer.from(record.envelope).toString()).id,
        envelope: record.envelope,
        sig: record.sig,
        recvTs: record.recvTs
      })
    const first = await sessions(p)
    await Promise.all([first.a.opened, first.b.opened])
    expect(first.b.peer.node).toBe(p.aIdentity.self()!.node)
    const closed = vi.fn()
    first.b.onClosed(closed)
    first.a.onClosed(closed)
    const h = handlers()
    first.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => {
      expect(
        closed.mock.calls.map(([error]) => ({ code: error?.code, message: error?.message }))
      ).toEqual([])
      expect(h.onCaughtUp).toHaveBeenCalledOnce()
    })
    expect(p.bStore.cursor(p.stream.id).seq).toBe(2)
    first.a.close()
    first.b.close()
    const record = rows[2]
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(record.envelope).toString()).id,
      envelope: record.envelope,
      sig: record.sig,
      recvTs: record.recvTs
    })
    const next = await sessions(p)
    await Promise.all([next.a.opened, next.b.opened])
    const after = handlers()
    next.b.subscribe(p.stream.id, after)
    await vi.waitFor(() => expect(after.onCaughtUp).toHaveBeenCalledOnce())
    expect(p.bStore.cursor(p.stream.id).seq).toBe(3)
    expect(after.onRecord).toHaveBeenCalledTimes(1)
  })
  it('replicates a signed event through the production loopback WebSocket/TLS transport', async () => {
    const p = await profiles(),
      record = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(record.envelope).toString()).id,
      envelope: record.envelope,
      sig: record.sig,
      recvTs: record.recvTs
    })
    const connection = await sessions(p, { direct: true })
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    expect(p.bStore.cursor(p.stream.id).seq).toBe(1)
    expect(Buffer.from(h.onRecord.mock.calls[0][0].envelope).equals(record.envelope)).toBe(true)
  })
  it('qualifies only a correlated pong and exposes subsequent wall-clock discontinuity', async () => {
    const p = await profiles(),
      clock = new FakeClock(Date.now())
    const connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    expect(connection.b.clockEstimate()).toBeUndefined()
    clock.advance(20_000)
    await vi.waitFor(() => expect(connection.b.clockEstimate()).toBeDefined())
    expect(connection.b.clockEstimate()!.rttMs).toBe(0)
    clock.setWallTime(clock.now() + 5_000)
    expect(connection.b.clockEstimate()!.wallDeltaMs).toBe(5_000)
  })
  it('authenticates an older still-valid same-key renewal and adopts the current roster', async () => {
    const clock = new FakeClock(Date.now()),
      p = await profiles(clock)
    const prior = p.bIdentity.roster()!.payload
    clock.advance(6 * 24 * 60 * 60 * 1_000)
    expect(p.aIdentity.renewExpiring()).toBeDefined()
    expect(p.bIdentity.roster()!.payload).toBe(prior)
    const connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    expect(connection.a.state()).toBe('open')
    expect(p.bIdentity.roster()!.payload).toBe(p.aIdentity.roster()!.payload)
    expect(connection.a.peer.delegation.expiresAt).toBeGreaterThan(
      clock.now() + 24 * 60 * 60 * 1_000
    )
  })
  it('lets a follower whose delegation lapsed catch up from a peer with the renewed roster', async () => {
    const clock = new FakeClock(Date.now()),
      p = await profiles(clock)
    const prior = p.bIdentity.roster()!.payload
    clock.advance(6 * 24 * 60 * 60 * 1_000 + 12 * 60 * 60 * 1_000)
    expect(p.aIdentity.renewExpiring()).toBeDefined()
    // The follower missed the renewal and its own delegation has now lapsed.
    clock.advance(24 * 60 * 60 * 1_000)
    expect(p.bIdentity.roster()!.payload).toBe(prior)
    const connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
    expect(p.bIdentity.roster()!.payload).toBe(p.aIdentity.roster()!.payload)
  })
  it('rejects a hello whose delegation transport key differs from its real certificate', async () => {
    const p = await profiles(),
      connection = await sessions(p, { clientCredentials: generateSelfSignedCert('wrong-key') })
    await expect(connection.a.opened).rejects.toMatchObject({ code: 'peer_key_mismatch' })
    expect(connection.a.state()).toBe('closed')
  })
  it('counts unknown mux payload before dispatch and rejects oversized quarantine traffic', async () => {
    const p = await profiles(),
      pair = memoryPair()
    const [server, client] = await Promise.all([
      openSecureChannel(pair.b, {
        role: 'server',
        credentials: p.aKeys.tlsCredentials(),
        deadlineMs: 2_000
      }),
      openSecureChannel(pair.a, {
        role: 'client',
        credentials: p.bKeys.tlsCredentials(),
        expectedPeerFingerprint: fingerprint(
          Buffer.from(p.aKeys.nodeKeys().transport, 'base64url')
        ),
        deadlineMs: 2_000
      })
    ])
    const session = new NetSyncSession({ channel: server, identity: p.aIdentity, store: p.aStore })
    resources.push(
      () => session.close(),
      () => client.close()
    )
    const header = Buffer.from(JSON.stringify({ t: 'future.unknown', data: 'x'.repeat(18_000) }))
    const message = Buffer.alloc(4 + header.length)
    message.writeUInt32BE(header.length)
    header.copy(message, 4)
    const frame = Buffer.alloc(16 + message.length)
    frame[0] = 1
    frame[2] = 3
    frame.writeUInt32BE(1, 4)
    frame.writeUInt32BE(message.length, 8)
    message.copy(frame, 16)
    const rejected = expect(session.opened).rejects.toMatchObject({ code: 'too_large' })
    client.stream.write(frame)
    await rejected
    expect(session.state()).toBe('closed')
  })
  it('tears down an authenticated session when its verified roster revokes the peer', async () => {
    const p = await profiles(),
      connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'))
    await vi.waitFor(() => expect(connection.b.state()).toBe('closed'))
    expect(p.bIdentity.roster()).toEqual(p.aIdentity.roster())
  })
  it('closes a session with revoked once the live roster has dropped the peer', async () => {
    const p = await profiles(),
      connection = await sessions(p),
      closed: Array<Error | undefined> = []
    await Promise.all([connection.a.opened, connection.b.opened])
    connection.a.onClosed((error) => closed.push(error))
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'))
    expect(closed).toEqual([expect.objectContaining({ code: 'revoked' })])
  })
  it('refuses a revoked peer with revoked, not bad_delegation, once its delegation is dropped', async () => {
    const p = await profiles(),
      clock = new FakeClock(Date.now()),
      executions = new SqliteExecutionLedger(p.aDb),
      peer = {
        node: p.bIdentity.self()!.node,
        user: p.bIdentity.self()!.user,
        delegation: p.aIdentity.verifySigned<NodeDelegation>(p.delegation, p.aKeys.rootKey()!)
      }
    const rpc = new DurableRpcDispatcher({ db: p.aDb, executions, identity: p.aIdentity, clock })
    rpc.register({ method: 'test.revoked', capability: 'read', handle: async () => null })
    const authority = new NodeStreamAuthority(p.aIdentity, p.aStore, p.aBlobs, clock),
      record = p.record(1),
      context = {
        id: newId('rpc'),
        caller: peer,
        signal: new AbortController().signal,
        deadlineAt: clock.now() + 5_000,
        progress: () => {}
      }
    p.aIdentity.revoke(peer.node)
    await expect(rpc.dispatch('test.revoked', {}, undefined, context)).rejects.toMatchObject({
      code: 'revoked'
    })
    expect(() =>
      authority.append(p.stream.id, newId('event'), record.envelope, record.sig, peer)
    ).toThrow(expect.objectContaining({ code: 'revoked' }))
  })
  it('flushes revocation while an aborted RPC unwinds behind a stalled write', async () => {
    const p = await profiles(),
      clock = new FakeClock(Date.now()),
      executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({ db: p.aDb, executions, identity: p.aIdentity, clock })
    let started = false,
      aborted = false
    rpc.register({
      method: 'test.revokeDrain',
      capability: 'write',
      mutating: true,
      handle: async (_params, context) => {
        started = true
        await new Promise<void>((resolve) =>
          context.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true }
          )
        )
        return null
      }
    })
    const connection = await sessions(p, { rpc, clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    const result = connection.b
      .rpc('test.revokeDrain', {}, { id: newId('rpc'), idem: 'revoke-drain', deadlineMs: 5_000 })
      .catch((error) => error)
    await vi.waitFor(() => expect(started).toBe(true))
    connection.pair.backward.stall()
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(() =>
      expect(
        executions.find({
          scope: p.bIdentity.self()!.node,
          target: 'test.revokeDrain',
          trigger: 'revoke-drain'
        })?.state
      ).toBe('uncertain')
    )
    expect(aborted).toBe(true)
    expect(connection.a.state()).toBe('open')
    expect(p.bIdentity.roster()).not.toEqual(p.aIdentity.roster())
    connection.pair.backward.resume()
    await vi.waitFor(() => expect(p.bIdentity.roster()).toEqual(p.aIdentity.roster()))
    await vi.waitFor(() => {
      expect(connection.a.state()).toBe('closed')
      expect(connection.b.state()).toBe('closed')
    })
    expect(await result).toEqual(
      expect.objectContaining({ code: expect.stringMatching(/^(revoked|route_unreachable)$/) })
    )
  })
  it.each(['replay', 'snapshot', 'blob'] as const)(
    'flushes revocation while %s delivery unwinds',
    async (kind) => {
      const p = await profiles(),
        clock = new FakeClock(Date.now()),
        bytes = Buffer.from('revocation drain fixture')
      const blob =
        `blb_${createHash('sha256').update(bytes).digest('hex')}` as import('../../../src/shared/net').BlobId
      const upload = p.aBlobs.begin(blob, bytes.length, false)
      upload.write(0, bytes)
      upload.commit()
      const id = newId('event'),
        envelope = encodeEnvelope({
          v: 1,
          minor: 0,
          id,
          stream: p.stream.id,
          type: 'message.posted',
          crit: false,
          author: { user: p.aIdentity.self()!.user, node: p.aIdentity.self()!.node, keyEpoch: 1 },
          ts: Date.now(),
          body: { text: 'attachment' },
          blobs: [
            { id: blob, bytes: bytes.length, mime: 'application/octet-stream', sealed: false }
          ]
        })
      p.aStore.appendAsAuthority(p.stream.id, {
        id,
        envelope,
        sig: p.aKeys.signAsNode(envelope),
        recvTs: Date.now()
      })
      p.aBlobs.addRef(blob, p.stream.id, id)
      const connection = await sessions(p, { clock })
      await Promise.all([connection.a.opened, connection.b.opened])
      let revoked = false
      const revokeDuringRead = (): void => {
        if (revoked) return
        revoked = true
        connection.pair.backward.stall()
        p.aIdentity.revoke(p.bIdentity.self()!.node)
      }
      if (kind === 'replay') {
        const read = p.aStore.read.bind(p.aStore)
        vi.spyOn(p.aStore, 'read').mockImplementation((...args) => {
          const page = read(...args)
          revokeDuringRead()
          return page
        })
      } else if (kind === 'snapshot') {
        vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
        const open = p.aStore.openSnapshot.bind(p.aStore)
        vi.spyOn(p.aStore, 'openSnapshot').mockImplementation((stream) => {
          const reader = open(stream)
          return {
            target: reader.target,
            next: (...args) => {
              const page = reader.next(...args)
              revokeDuringRead()
              return page
            },
            close: () => reader.close()
          }
        })
      } else {
        const read = p.aBlobs.read.bind(p.aBlobs)
        vi.spyOn(p.aBlobs, 'read').mockImplementation((...args) => {
          const chunk = read(...args)
          revokeDuringRead()
          return chunk
        })
      }
      const h = handlers()
      const result =
        kind === 'blob'
          ? connection.b.getBlob(p.stream.id, blob).catch((error) => error)
          : undefined
      if (kind !== 'blob') connection.b.subscribe(p.stream.id, h)
      await vi.waitFor(() => expect(revoked).toBe(true))
      expect(connection.a.state()).toBe('open')
      expect(p.bIdentity.roster()).not.toEqual(p.aIdentity.roster())
      connection.pair.backward.resume()
      await vi.waitFor(() => expect(p.bIdentity.roster()).toEqual(p.aIdentity.roster()))
      await vi.waitFor(() => {
        expect(connection.a.state()).toBe('closed')
        expect(connection.b.state()).toBe('closed')
      })
      expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
      expect(h.onRecord).not.toHaveBeenCalled()
      expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
      if (result) expect(['revoked', 'route_unreachable']).toContain((await result).code)
    }
  )
  it('rejects invalid RPC DTOs before admission and permits corrected reuse of the unadmitted request id', async () => {
    const p = await profiles(),
      executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions,
      identity: p.aIdentity,
      clock: systemClock
    })
    let effects = 0
    rpc.register({
      method: 'test.dto',
      capability: 'write',
      mutating: true,
      validate: (params) => {
        if (!params || typeof params !== 'object' || Object.keys(params).join(',') !== 'valid')
          throw new NetError('bad_request')
        return params
      },
      handle: async () => {
        effects++
        return { effects }
      }
    })
    const connection = await sessions(p, { rpc })
    await Promise.all([connection.a.opened, connection.b.opened])
    const id = newId('rpc'),
      options = { id, idem: 'pure-dto', deadlineMs: 5000 }
    await expect(connection.b.rpc('test.dto', { extra: true }, options)).rejects.toMatchObject({
      code: 'bad_request'
    })
    expect(effects).toBe(0)
    expect(
      executions.find({ scope: p.bIdentity.self()!.node, target: 'test.dto', trigger: 'pure-dto' })
    ).toBeUndefined()
    expect(
      p.aDb.database.prepare('SELECT count(*) AS n FROM net_rpc_aliases WHERE id=?').get(id)?.n
    ).toBe(0)
    expect(await connection.b.rpc('test.dto', { valid: true }, options)).toEqual({ effects: 1 })
  })
  it('rechecks parameter-independent family policy and persisted selected capability without replaying request hooks', async () => {
    const p = await profiles(),
      executions = new SqliteExecutionLedger(p.aDb)
    let enabled = true
    const policy = vi.fn((method, _peer, capability) => {
      expect(method.family).toBe('bridge')
      expect(capability).toBe('write')
      if (!enabled) throw new NetError('disabled')
    })
    const rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions,
      identity: p.aIdentity,
      clock: systemClock,
      authorizeMethod: policy
    })
    const requestOnly = vi.fn((params) => {
      expect(params).toEqual({ selected: 'write' })
    })
    rpc.register({
      method: 'test.family',
      family: 'bridge',
      capability: 'read',
      capabilityFor: (params) => (params as { selected: 'write' }).selected,
      mutating: true,
      authorize: requestOnly,
      handle: async () => ({ retained: true })
    })
    const connection = await sessions(p, { rpc })
    await Promise.all([connection.a.opened, connection.b.opened])
    const id = newId('rpc')
    expect(
      await connection.b.rpc(
        'test.family',
        { selected: 'write' },
        { id, idem: 'family', deadlineMs: 5000 }
      )
    ).toEqual({ retained: true })
    expect(
      p.aDb.database.prepare('SELECT capability FROM net_rpc_aliases WHERE id=?').get(id)
        ?.capability
    ).toBe('write')
    const requestChecks = requestOnly.mock.calls.length
    enabled = false
    await expect(connection.b.rpcResult(id, { deadlineMs: 5000 })).rejects.toMatchObject({
      code: 'disabled'
    })
    await expect(rpc.cancel(id, connection.a.peer)).rejects.toMatchObject({ code: 'disabled' })
    expect(requestOnly).toHaveBeenCalledTimes(requestChecks)
    expect(policy).toHaveBeenCalled()
    enabled = true
    expect(await connection.b.rpcResult(id, { deadlineMs: 5000 })).toEqual({ retained: true })
    expect(requestOnly).toHaveBeenCalledTimes(requestChecks)
  })
  it('skips new-execution refusals for a retry and returns an admitted refusal as a plain error', async () => {
    const p = await profiles(),
      executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions,
      identity: p.aIdentity,
      clock: systemClock
    })
    let busy = false,
      effects = 0
    const refusal = vi.fn(() => {
      if (busy) throw new NetError('conflict', 'Busy.')
    })
    rpc.register({
      method: 'test.fresh',
      capability: 'write',
      mutating: true,
      authorizeNew: refusal,
      handle: async () => {
        effects++
        busy = true
        return { effects }
      }
    })
    const connection = await sessions(p, { rpc })
    await Promise.all([connection.a.opened, connection.b.opened])
    const first = { id: newId('rpc'), idem: 'send-1', deadlineMs: 5000 }
    expect(await connection.b.rpc('test.fresh', {}, first)).toEqual({ effects: 1 })
    // The lost-reply retry, under a new request id, gets the saved result while the work is still busy.
    expect(await connection.b.rpc('test.fresh', {}, { ...first, id: newId('rpc') })).toEqual({
      effects: 1
    })
    expect(effects).toBe(1)
    expect(refusal).toHaveBeenCalledTimes(1)
    // A new request is refused with its real code, never `outcome_uncertain`, and keeps that code on retry.
    const second = { id: newId('rpc'), idem: 'send-2', deadlineMs: 5000 }
    await expect(connection.b.rpc('test.fresh', {}, second)).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(
      connection.b.rpc('test.fresh', {}, { ...second, id: newId('rpc') })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(effects).toBe(1)
  })
  it('journals mutations, returns the same outcome after retry, and refuses changed payloads', async () => {
    const p = await profiles(),
      executions = new SqliteExecutionLedger(p.aDb)
    let rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions,
      identity: p.aIdentity,
      clock: systemClock
    })
    let effects = 0
    rpc.register({
      method: 'test.mutate',
      capability: 'write',
      mutating: true,
      handle: async (params) => {
        effects++
        return { params, effects }
      }
    })
    const first = await sessions(p, { rpc })
    await Promise.all([first.a.opened, first.b.opened])
    const id = newId('rpc'),
      result = await first.b.rpc(
        'test.mutate',
        { value: 1 },
        { id, idem: 'stable', deadlineMs: 2_000 }
      )
    expect(result).toEqual({ params: { value: 1 }, effects: 1 })
    first.a.close()
    first.b.close()
    p.aDb.close()
    p.aDb = new NetDatabase({ profileDir: p.aPath })
    resources.push(() => p.aDb.close())
    p.aIdentity = new NetIdentityService({
      database: p.aDb.database,
      keys: p.aKeys,
      clock: systemClock,
      coordinator: p.aDb
    })
    p.aStore = new SqliteStreamStore(p.aDb)
    rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions: new SqliteExecutionLedger(p.aDb),
      identity: p.aIdentity,
      clock: systemClock
    })
    rpc.register({
      method: 'test.mutate',
      capability: 'write',
      mutating: true,
      handle: async (params) => {
        effects++
        return { params, effects }
      }
    })
    const next = await sessions(p, { rpc })
    await Promise.all([next.a.opened, next.b.opened])
    expect(
      await next.b.rpc(
        'test.mutate',
        { value: 1 },
        { id: newId('rpc'), idem: 'stable', deadlineMs: 2_000 }
      )
    ).toEqual(result)
    expect(await next.b.rpcResult(id, { deadlineMs: 2_000 })).toEqual(result)
    await expect(
      next.b.rpc(
        'test.mutate',
        { value: 2 },
        { id: newId('rpc'), idem: 'stable', deadlineMs: 2_000 }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(next.b.rpcResult(newId('rpc'), { deadlineMs: 2_000 })).rejects.toMatchObject({
      code: 'outcome_uncertain'
    })
    expect(effects).toBe(1)
  })
  it('automatically reconnects and resubscribes from the durable cursor after a link cut', async () => {
    const p = await profiles(),
      clock = new FakeClock(Date.now())
    const connections: Awaited<ReturnType<typeof sessions>>[] = []
    const record = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(record.envelope).toString()).id,
      envelope: record.envelope,
      sig: record.sig,
      recvTs: record.recvTs
    })
    const supervisor = new SyncSupervisor({
      identity: p.bIdentity,
      clock,
      random: () => 1,
      connect: async (signal) => {
        const connection = await sessions(p)
        signal.addEventListener(
          'abort',
          () => {
            connection.a.close()
            connection.b.close()
          },
          { once: true }
        )
        await Promise.all([connection.a.opened, connection.b.opened])
        connections.push(connection)
        return connection.b
      }
    })
    resources.push(() => supervisor.close())
    const h = handlers()
    supervisor.subscribe(p.stream.id, h)
    await supervisor.opened
    await vi.waitFor(() => expect(p.bStore.cursor(p.stream.id).seq).toBe(1))
    connections[0].pair.cut()
    await vi.waitFor(() => expect(supervisor.state()).toBe('connecting'))
    const next = p.record(2)
    p.aStore.appendAsAuthority(p.stream.id, {
      id: JSON.parse(Buffer.from(next.envelope).toString()).id,
      envelope: next.envelope,
      sig: next.sig,
      recvTs: next.recvTs
    })
    clock.advance(1_000)
    await vi.waitFor(() => expect(p.bStore.cursor(p.stream.id).seq).toBe(2))
    expect(connections).toHaveLength(2)
    expect(h.onRecord).toHaveBeenCalledTimes(2)
    expect(supervisor.state()).toBe('open')
    supervisor.close()
    expect(clock.pending()).toBe(0)
  })
  it('reconnects subscriptions after cancelling a started send without replaying the mutation', async () => {
    const p = await profiles(),
      clock = new FakeClock(Date.now()),
      connections: Awaited<ReturnType<typeof sessions>>[] = []
    const rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions: new SqliteExecutionLedger(p.aDb),
      identity: p.aIdentity,
      clock: systemClock
    })
    const handle = vi.fn(async () => ({ done: true }))
    rpc.register({ method: 'test.partialCancel', capability: 'write', mutating: true, handle })
    const supervisor = new SyncSupervisor({
      identity: p.bIdentity,
      clock,
      random: () => 1,
      connect: async (signal) => {
        const connection = await sessions(p, { rpc })
        signal.addEventListener(
          'abort',
          () => {
            connection.a.close()
            connection.b.close()
          },
          { once: true }
        )
        await Promise.all([connection.a.opened, connection.b.opened])
        connections.push(connection)
        return connection.b
      }
    })
    resources.push(() => supervisor.close())
    const h = handlers()
    supervisor.subscribe(p.stream.id, h)
    await supervisor.opened
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    connections[0].pair.forward.stall()
    const controller = new AbortController()
    const request = supervisor.rpc(
      'test.partialCancel',
      {},
      { id: newId('rpc'), idem: 'partial', deadlineMs: 5_000, signal: controller.signal }
    )
    void request.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(supervisor.state()).toBe('connecting'))
    clock.advance(1_000)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledTimes(2))
    expect(connections).toHaveLength(2)
    expect(supervisor.state()).toBe('open')
    expect(handle).not.toHaveBeenCalled()
  })
  it('keeps the session open when cancellation removes an unadmitted request', async () => {
    const p = await profiles(),
      rpc = new DurableRpcDispatcher({
        db: p.aDb,
        executions: new SqliteExecutionLedger(p.aDb),
        identity: p.aIdentity,
        clock: systemClock
      })
    const handle = vi.fn(async () => ({ done: true }))
    rpc.register({ method: 'test.earlyCancel', capability: 'write', mutating: true, handle })
    const connection = await sessions(p, { rpc })
    await Promise.all([connection.a.opened, connection.b.opened])
    const controller = new AbortController(),
      id = newId('rpc')
    const request = connection.b.rpc(
      'test.earlyCancel',
      {},
      { id, idem: 'never-admitted', deadlineMs: 2_000, signal: controller.signal }
    )
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await expect(connection.b.rpcResult(id, { deadlineMs: 2_000 })).rejects.toMatchObject({
      code: 'outcome_uncertain'
    })
    expect(handle).not.toHaveBeenCalled()
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
  it('propagates caller cancellation to the running RPC handler without claiming rollback', async () => {
    const p = await profiles(),
      executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({
      db: p.aDb,
      executions,
      identity: p.aIdentity,
      clock: systemClock
    })
    let started = false,
      aborted = false
    rpc.register({
      method: 'test.cancel',
      capability: 'write',
      mutating: true,
      handle: async (_params, context) => {
        started = true
        await new Promise<void>((resolve) =>
          context.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true }
          )
        )
        return { stopped: true }
      }
    })
    const connection = await sessions(p, { rpc })
    await Promise.all([connection.a.opened, connection.b.opened])
    const signal = new AbortController(),
      id = newId('rpc')
    const request = connection.b.rpc(
      'test.cancel',
      {},
      { id, idem: 'cancel', deadlineMs: 5_000, signal: signal.signal }
    )
    void request.catch(() => {})
    await vi.waitFor(() => expect(started).toBe(true))
    signal.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(aborted).toBe(true))
    await vi.waitFor(() =>
      expect(
        executions.find({
          scope: p.bIdentity.self()!.node,
          target: 'test.cancel',
          trigger: 'cancel'
        })?.state
      ).toBe('uncertain')
    )
  })
})

/** Adds rows `from`..`to` to `stream` on the authority's side. */
function appendRows(p: Awaited<ReturnType<typeof profiles>>, stream: string, from: number, to: number) {
  for (let seq = from; seq <= to; seq++) {
    const row = p.record(seq, stream as never)
    const envelope = JSON.parse(Buffer.from(row.envelope).toString())
    p.aStore.appendAsAuthority(stream as never, {
      id: envelope.id,
      envelope: row.envelope,
      sig: row.sig,
      recvTs: row.recvTs
    })
  }
}

/** Every frame the authority's session sends, and a hook that runs once each one is sent. */
function frames(session: NetSyncSession) {
  type Frame = { t: string; stream?: string; code?: string }
  const sent: Frame[] = []
  const hooks: Array<(frame: Frame) => void | Promise<void>> = []
  const send = (session as unknown as { send: (...args: unknown[]) => Promise<void> }).send.bind(session)
  vi.spyOn(session as never, 'send' as never).mockImplementation((async (
    header: { t: string; stream?: string; re?: string; error?: { code: string } },
    ...rest: unknown[]
  ) => {
    const frame: Frame = {
      t: header.t,
      ...(header.stream ?? header.re ? { stream: header.stream ?? header.re } : {}),
      ...(header.error ? { code: header.error.code } : {})
    }
    sent.push(frame)
    await send(header, ...rest)
    for (const hook of hooks) await hook(frame)
  }) as never)
  return { sent, after: (hook: (frame: Frame) => void | Promise<void>) => hooks.push(hook) }
}

describe('a stream the peer loses the right to read while it is served', () => {
  async function setup() {
    const p = await profiles()
    // A second stream on the same connection, which must still be served afterwards.
    const other: StreamDescriptor = { ...p.stream, id: newId('stream') }
    p.aStore.createStream(other, 1)
    p.bStore.createStream(other, 1)
    appendRows(p, other.id, 1, 2)
    // Two replay pages and two snapshot chunks: a page holds at most 499 records.
    appendRows(p, p.stream.id, 1, 600)
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const authority = (connection.a as unknown as { options: { authority: NodeStreamAuthority } }).options
      .authority
    const canRead = authority.canRead.bind(authority)
    const lost = new Set<string>()
    vi.spyOn(authority, 'canRead').mockImplementation((stream, peer) => !lost.has(stream) && canRead(stream, peer))
    const closed: unknown[] = []
    connection.a.onClosed((error) => closed.push(error))
    connection.b.onClosed((error) => closed.push(error))
    const log = frames(connection.a)
    // Access goes once the first part of the stream (`kind`) has been sent.
    const loseAfter = (kind: string) =>
      log.after((frame) => {
        if (frame.t === kind && frame.stream === p.stream.id && !lost.size) {
          lost.add(p.stream.id)
          log.sent.push({ t: 'lost' })
        }
      })
    // After the loss: one `forbidden` for that stream and nothing else, the connection is up and serves another stream.
    const expectEndedAlone = async () => {
      await vi.waitFor(() => expect(log.sent.some((frame) => frame.t === 'error')).toBe(true), { timeout: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(log.sent.slice(log.sent.findIndex((frame) => frame.t === 'lost') + 1)).toEqual([
        { t: 'error', stream: p.stream.id, code: 'forbidden' }
      ])
      expect(closed).toEqual([])
      expect(connection.a.state()).toBe('open')
      expect(connection.b.state()).toBe('open')
      const h = handlers()
      connection.b.subscribe(other.id, h)
      await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 10_000 })
      expect(p.bStore.cursor(other.id).seq).toBe(2)
    }
    return { p, connection, log, loseAfter, expectEndedAlone }
  }

  it('ends the stream alone when access goes mid-replay', async () => {
    const { p, connection, loseAfter, expectEndedAlone } = await setup()
    loseAfter('events')
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await expectEndedAlone()
    expect(h.onError).toHaveBeenCalledExactlyOnceWith('forbidden')
    expect(h.onCaughtUp).not.toHaveBeenCalled()
  })

  it('ends the stream alone when access goes mid-snapshot, and installs nothing of it', async () => {
    const { p, connection, loseAfter, expectEndedAlone } = await setup()
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const open = p.aStore.openSnapshot.bind(p.aStore),
      close = vi.fn()
    vi.spyOn(p.aStore, 'openSnapshot').mockImplementation((stream) => {
      const reader = open(stream)
      return {
        target: reader.target,
        next: (bytes, records) => reader.next(bytes, records),
        close: () => {
          close()
          reader.close()
        }
      }
    })
    loseAfter('snapshot.chunk')
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await expectEndedAlone()
    expect(h.onError).toHaveBeenCalledExactlyOnceWith('forbidden')
    expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(close).toHaveBeenCalledOnce()
  })

  it('answers a snapshot request with no subscription with forbidden alone when access goes mid-transfer', async () => {
    const { p, connection, loseAfter, expectEndedAlone } = await setup()
    const open = p.aStore.openSnapshot.bind(p.aStore),
      close = vi.fn()
    vi.spyOn(p.aStore, 'openSnapshot').mockImplementation((stream) => {
      const reader = open(stream)
      return {
        target: reader.target,
        next: (bytes, records) => reader.next(bytes, records),
        close: () => {
          close()
          reader.close()
        }
      }
    })
    loseAfter('snapshot.chunk')
    const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(connection.b)
    await send({ t: 'snapshot.get', stream: p.stream.id })
    await expectEndedAlone()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(close).toHaveBeenCalledOnce()
  })

  it('ends a caught-up newer subscription that replaced a replay when access goes', async () => {
    const { p, connection, log, expectEndedAlone } = await setup()
    const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(
      connection.b
    )
    let replaced = false
    log.after(async (frame) => {
      // The first replay page is on its way; a newer subscription, already at the head, takes its place
      // and is caught up before access goes.
      if (frame.t !== 'rosterUpdate' || replaced) return
      replaced = true
      await send({ t: 'subscribe', stream: p.stream.id, after: { epoch: 1, seq: 600 } })
      await vi.waitFor(() =>
        expect(log.sent.some((sent) => sent.t === 'caughtUp' && sent.stream === p.stream.id)).toBe(
          true
        )
      )
      const canRead = vi.mocked(
        (connection.a as unknown as { options: { authority: NodeStreamAuthority } }).options
          .authority.canRead
      )
      const before = canRead.getMockImplementation()!
      canRead.mockImplementation((stream, peer) => stream !== p.stream.id && before(stream, peer))
      log.sent.push({ t: 'lost' })
    })
    await send({ t: 'subscribe', stream: p.stream.id, after: { epoch: 1, seq: 0 } })
    await vi.waitFor(() => expect(replaced).toBe(true))
    await expectEndedAlone()
  })

  it('ends a newer subscription whose snapshot request joined the transfer when access goes', async () => {
    const { p, connection, log, loseAfter, expectEndedAlone } = await setup()
    const reason = p.aStore.snapshotReason.bind(p.aStore)
    vi.spyOn(p.aStore, 'snapshotReason').mockImplementation((stream, after) =>
      stream === p.stream.id ? 'cursorTooOld' : reason(stream, after)
    )
    const serveSnapshot = vi.spyOn(connection.a as never, 'serveSnapshot' as never)
    const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(
      connection.b
    )
    let joined = false
    log.after(async (frame) => {
      // A's first chunk is out. The reader subscribes again without letting go (B), and B's snapshot
      // request joins the transfer already under way.
      if (frame.t !== 'snapshot.chunk' || joined) return
      joined = true
      await send({ t: 'subscribe', stream: p.stream.id, after: { epoch: 1, seq: 0 } })
      await vi.waitFor(() =>
        expect(log.sent.filter((sent) => sent.t === 'snapshotRequired')).toHaveLength(2)
      )
      await send({ t: 'snapshot.get', stream: p.stream.id })
      await vi.waitFor(() => expect(serveSnapshot).toHaveBeenCalledTimes(2))
      await (serveSnapshot.mock.results[1] as { value: Promise<void> }).value
    })
    loseAfter('snapshot.chunk')
    await send({ t: 'subscribe', stream: p.stream.id, after: { epoch: 1, seq: 0 } })
    await vi.waitFor(() =>
      expect(log.sent.some((sent) => sent.t === 'snapshotRequired')).toBe(true)
    )
    await send({ t: 'snapshot.get', stream: p.stream.id })
    await vi.waitFor(() => expect(joined).toBe(true))
    // B gets one forbidden instead of waiting for chunks that never come.
    await expectEndedAlone()
  })
})

describe('a replay trimmed after some of it was applied', () => {
  it('resyncs the subscriber from a snapshot with no gap and no duplicate', async () => {
    const p = await profiles()
    appendRows(p, p.stream.id, 1, 600)
    const connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const closed: unknown[] = []
    connection.a.onClosed((error) => closed.push(error))
    connection.b.onClosed((error) => closed.push(error))
    const log = frames(connection.a)
    let trimmed = false
    log.after(async (frame) => {
      if (frame.t !== 'events' || trimmed) return
      trimmed = true
      // The first page is applied on the subscriber, then a display snapshot refresh trims past it.
      await vi.waitFor(() => expect(p.bStore.cursor(p.stream.id).seq).toBe(499), { timeout: 10_000 })
      p.aStore.truncate(p.stream.id, 550, { forgetIds: true })
    })
    const h = handlers()
    connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(trimmed).toBe(true)
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce()
    const types = log.sent.map((frame) => frame.t)
    expect(types.indexOf('snapshotRequired')).toBeGreaterThan(types.indexOf('events'))
    expect(types.filter((t) => t === 'caughtUp')).toHaveLength(1)
    // What the replay applied came once each, in order; the snapshot then holds the rest without a gap.
    const applied = h.onRecord.mock.calls.map(([record]) => record.seq as number)
    expect(applied).toEqual(Array.from({ length: applied.length }, (_, i) => i + 1))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(600)
    const held = p.bStore.read(p.stream.id, { epoch: 1, seq: 550 }, 600, 4 * 1024 * 1024)
    expect(held.records.map((record) => record.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 551 + i))
    expect(closed).toEqual([])
    expect(connection.a.state()).toBe('open')
    expect(connection.b.state()).toBe('open')
  })
})
