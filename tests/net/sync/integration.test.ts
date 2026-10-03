import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId, NetError, type StoredRecord, type StreamDescriptor } from '../../../src/shared/net'
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

const resources: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of resources.splice(0).reverse()) await dispose() })

async function profiles(clock: Clock = systemClock) {
  const aPath = makeTempDir('sync-a-').path, bPath = makeTempDir('sync-b-').path
  const aDb = new NetDatabase({ profileDir: aPath }), bDb = new NetDatabase({ profileDir: bPath })
  resources.push(() => aDb.close(), () => bDb.close())
  const aKeys = new FileKeyStore(aPath), bKeys = new FileKeyStore(bPath)
  const aIdentity = new NetIdentityService({ database: aDb.database, keys: aKeys, clock, coordinator: aDb })
  await aIdentity.bootstrapAuthority('authority')
  await bKeys.initialize({ asAuthority: false })
  const node = newId('node'), user = aIdentity.self()!.user
  const delegation = aIdentity.issueNodeDelegation({ node, keys: bKeys.nodeKeys(), name: 'follower', caps: ['read', 'chat', 'write'] })
  const bIdentity = new NetIdentityService({ database: bDb.database, keys: bKeys, clock, coordinator: bDb, self: { node, user } })
  bIdentity.pinUser(user, aKeys.rootKey()!); bIdentity.acceptRoster(aIdentity.roster()!, aKeys.rootKey()!)
  const aStore = new SqliteStreamStore(aDb), bStore = new SqliteStreamStore(bDb)
  const aBlobs = new FileBlobStore(aDb); resources.push(() => aBlobs.close())
  const stream: StreamDescriptor = { id: newId('stream'), kind: 'node.thread', authority: aIdentity.self()!.node, createdAt: systemClock.now() }
  aStore.createStream(stream, 1); bStore.createStream(stream, 1)
  const record = (seq: number): StoredRecord => {
    const envelope = encodeEnvelope({ v: 1, minor: 0, id: newId('event'), stream: stream.id, type: 'message.posted', crit: false, author: { user, node: aIdentity.self()!.node, keyEpoch: 1 }, ts: systemClock.now(), body: { text: `record ${seq}` } })
    return { epoch: 1, seq, recvTs: systemClock.now(), envelope, sig: aKeys.signAsNode(envelope) }
  }
  return { aPath, bPath, aDb, bDb, aKeys, bKeys, aIdentity, bIdentity, aStore, bStore, aBlobs, stream, record, delegation }
}

async function sessions(p: Awaited<ReturnType<typeof profiles>>, options: { clientCredentials?: TlsCredentials; rpc?: DurableRpcDispatcher; direct?: boolean; clock?: Clock } = {}) {
  const pair = memoryPair()
  let aRaw: Duplex = pair.b, bRaw: Duplex = pair.a
  let direct: DirectTransport | undefined
  if (options.direct) {
    pair.cut()
    direct = new DirectTransport({ enabled: true })
    const dialer = new DirectTransport()
    await direct.provision(); await dialer.provision()
    resources.push(() => direct!.teardown(), () => dialer.teardown())
    let accept!: (raw: Duplex) => void
    const accepted = new Promise<Duplex>(resolve => { accept = resolve })
    await direct.listen(accept)
    bRaw = await dialer.dial(direct.status().routes[0], new AbortController().signal)
    aRaw = await accepted
  }
  const [aChannel, bChannel] = await Promise.all([
    openSecureChannel(aRaw, { role: 'server', credentials: p.aKeys.tlsCredentials(), deadlineMs: 2_000 }),
    openSecureChannel(bRaw, { role: 'client', credentials: options.clientCredentials ?? p.bKeys.tlsCredentials(), expectedPeerFingerprint: fingerprint(Buffer.from(p.aKeys.nodeKeys().transport, 'base64url')), deadlineMs: 2_000 })
  ])
  const authority = new NodeStreamAuthority(p.aIdentity, p.aStore, p.aBlobs, options.clock ?? systemClock)
  const a = new NetSyncSession({ channel: aChannel, identity: p.aIdentity, store: p.aStore, authority, blobs: p.aBlobs, rpc: options.rpc, clock: options.clock, onAuthenticated: () => direct?.markAuthenticated(aRaw) })
  const b = new NetSyncSession({ channel: bChannel, identity: p.bIdentity, store: p.bStore, capabilities: ['streams.v1', 'rpc.v1', 'blobs.v1'], clock: options.clock })
  resources.push(() => a.close(), () => b.close())
  return { a, b, pair }
}

function handlers() { return { onRecord: vi.fn(), onCaughtUp: vi.fn(), onSnapshotInstalled: vi.fn(), onError: vi.fn() } }

describe('durable subscription fault boundaries', () => {
  it('keeps live 105 buffered during replay, then resumes from durable 89 after a cut', async () => {
    const p = await profiles(), rows = Array.from({ length: 105 }, (_, i) => p.record(i + 1))
    p.bStore.applyFromAuthority(p.stream.id, rows.slice(0, 79))
    const first = handlers(), request = vi.fn()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, first, () => {}, request)
    receiver.subscribed({ epoch: 1, seq: 104 }, 104)
    receiver.receive([rows[104]]); receiver.receive(rows.slice(79, 89))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(89)
    expect(first.onRecord).toHaveBeenCalledTimes(10)
    receiver.close()
    const next = handlers(), resumed = new SubscriptionReceiver(p.stream.id, p.bStore, next, () => {}, request)
    resumed.subscribed({ epoch: 1, seq: 105 }, 105)
    resumed.receive(rows.slice(89)); resumed.caughtUp()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(105)
    expect(next.onRecord).toHaveBeenCalledTimes(16)
    expect(next.onCaughtUp).toHaveBeenCalledOnce()
    resumed.receive([rows[104]])
    expect(next.onRecord).toHaveBeenCalledTimes(16)
  })
  it('resubscribes a caught-up gap without promoting the advertised head', async () => {
    const p = await profiles(), h = handlers(), request = vi.fn()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, h, () => {}, request)
    receiver.subscribed({ epoch: 1, seq: 2 }, 2)
    receiver.receive([p.record(2)]); receiver.caughtUp()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(h.onCaughtUp).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(false)
  })
  it('rejects conflicting metadata at an already committed position', async () => {
    const p = await profiles(), row = p.record(1), receiver = new SubscriptionReceiver(p.stream.id, p.bStore, handlers(), () => {}, vi.fn())
    receiver.subscribed({ epoch: 1, seq: 1 }, 1); receiver.receive([row])
    expect(() => receiver.receive([{ ...row, recvTs: row.recvTs + 1 }])).toThrow(/Conflicting/)
    expect(p.bStore.cursor(p.stream.id).seq).toBe(1)
  })
  it('drops a 1001-row live overlap and restarts from the unchanged cursor', async () => {
    const p = await profiles(), h = handlers(), request = vi.fn()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, h, () => {}, request)
    receiver.subscribed({ epoch: 1, seq: 1002 }, 1002)
    receiver.receive(Array.from({ length: 1001 }, (_, i) => p.record(i + 2)))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0)
    expect(h.onRecord).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(false)
  })
  it('discards an interrupted snapshot and preserves the active durable generation', async () => {
    const p = await profiles(), old = p.record(1)
    p.bStore.applyFromAuthority(p.stream.id, [old])
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, handlers(), () => {}, vi.fn())
    receiver.snapshotRequired({ epoch: 1, seq: 2 })
    receiver.snapshotChunk({ epoch: 1, seq: 2 }, [old], false)
    receiver.close()
    expect(p.bStore.getById(p.stream.id, JSON.parse(Buffer.from(old.envelope).toString()).id)?.envelope).toEqual(old.envelope)
    expect(p.bStore.cursor(p.stream.id).seq).toBe(1)
  })
  it('pins the first snapshot chunk when the source head grew after snapshotRequired', async () => {
    const p = await profiles(), h = handlers()
    const receiver = new SubscriptionReceiver(p.stream.id, p.bStore, h, () => {}, vi.fn())
    receiver.snapshotRequired({ epoch: 1, seq: 1 })
    receiver.snapshotChunk({ epoch: 1, seq: 2 }, [p.record(1), p.record(2)], true)
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce()
    expect(p.bStore.cursor(p.stream.id).seq).toBe(2)
  })
})

describe('real identity + SQLite + TLS + mux sessions', () => {
  it('discards already-started delivery after unsubscribe without closing the session', async () => {
    const p = await profiles(), connection = await sessions(p); await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers(), subscription = connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    const row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(row.envelope).toString()).id, envelope: row.envelope, sig: row.sig, recvTs: row.recvTs })
    const received = vi.spyOn(connection.b as unknown as { receive(message: unknown): Promise<void> }, 'receive')
    const delivery = connection.a.publishRecord(p.stream.id, row); subscription.close(); await delivery
    const send = (connection.a as unknown as { send(message: unknown): Promise<void> }).send.bind(connection.a)
    await send({ t: 'subscribed', stream: p.stream.id, head: { epoch: 1, seq: 1 }, replayThrough: 1 })
    await send({ t: 'caughtUp', stream: p.stream.id })
    await send({ t: 'snapshotRequired', stream: p.stream.id, head: { epoch: 1, seq: 1 }, reason: 'cursorTooOld' })
    await send({ t: 'snapshot.chunk', stream: p.stream.id, epoch: 1, throughSeq: 1, records: [], done: true, parts: [] })
    await vi.waitFor(() => expect(received.mock.calls.some(([message]) => (message as { header: { t: string } }).header.t === 'snapshot.chunk')).toBe(true))
    expect(connection.a.state()).toBe('open'); expect(connection.b.state()).toBe('open')
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0); expect(h.onRecord).not.toHaveBeenCalled()
  })
  it('resumes live commits made during a pinned snapshot without closing or skipping', async () => {
    const p = await profiles(), rows = [p.record(1), p.record(2)]
    const append = (row: StoredRecord) => p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(row.envelope).toString()).id, envelope: row.envelope, sig: row.sig, recvTs: row.recvTs })
    append(rows[0]); vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const original = p.aStore.openSnapshot.bind(p.aStore)
    let connection: Awaited<ReturnType<typeof sessions>>, injected = false
    vi.spyOn(p.aStore, 'openSnapshot').mockImplementation(stream => {
      const reader = original(stream)
      return { target: reader.target, next: (bytes, records) => {
        const page = reader.next(bytes, records)
        if (!injected) { injected = true; append(rows[1]); void connection.a.publishRecord(stream, rows[1]) }
        return page
      }, close: () => reader.close() }
    })
    connection = await sessions(p); await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers(); connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce(); expect(p.bStore.cursor(p.stream.id).seq).toBe(2)
    expect(h.onRecord).toHaveBeenCalledTimes(1); expect(h.onRecord.mock.calls[0][0].seq).toBe(2)
    expect(connection.a.state()).toBe('open'); expect(connection.b.state()).toBe('open')
  })
  it('accepts a valid 500-record wire snapshot through bounded storage appends', async () => {
    const p = await profiles()
    for (let i = 1; i <= 500; i++) { const row = p.record(i); p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(row.envelope).toString()).id, envelope: row.envelope, sig: row.sig, recvTs: row.recvTs }) }
    vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
    const original = p.aStore.openSnapshot.bind(p.aStore)
    vi.spyOn(p.aStore, 'openSnapshot').mockImplementation(stream => { const reader = original(stream); return { target: reader.target, next: bytes => reader.next(bytes, 500), close: () => reader.close() } })
    const connection = await sessions(p); await Promise.all([connection.a.opened, connection.b.opened])
    const errors: unknown[] = []; connection.a.onClosed(error => errors.push(error)); connection.b.onClosed(error => errors.push(error))
    const h = handlers(); connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => { expect(errors).toEqual([]); expect(h.onCaughtUp).toHaveBeenCalledOnce() }, { timeout: 10_000 })
    expect(h.onSnapshotInstalled).toHaveBeenCalledOnce(); expect(p.bStore.cursor(p.stream.id).seq).toBe(500)
  })
  it('cuts signed replay at durable89 with live105 ahead, then resumes once over direct', async () => {
    const p = await profiles(), rows = Array.from({ length: 105 }, (_, i) => p.record(i + 1))
    for (const row of rows.slice(0, 104)) p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(row.envelope).toString()).id, envelope: row.envelope, sig: row.sig, recvTs: row.recvTs })
    p.bStore.applyFromAuthority(p.stream.id, rows.slice(0, 79))
    const original = p.aStore.read.bind(p.aStore)
    vi.spyOn(p.aStore, 'read').mockImplementation((stream, after, through, bytes) => { const page = original(stream, after, through, bytes); return { records: page.records.slice(0, 10), done: page.records.length <= 10 && page.done } })
    const first = await sessions(p); await Promise.all([first.a.opened, first.b.opened])
    const h = handlers(); h.onRecord.mockImplementation(row => { if (row.seq === 89) first.b.close() })
    // Hook the signed subscribed boundary to place a committed live record ahead of replay.
    const send = (first.a as unknown as { send(message: import('../../../src/shared/net').WireMessage, parts?: Uint8Array[]): Promise<void> }).send.bind(first.a)
    const sendSpy = vi.spyOn(first.a as never, 'send' as never) as unknown as { mockImplementation(callback: typeof send): void }
    let injected = false
    sendSpy.mockImplementation(async (message, parts) => {
      await send(message, parts)
      if (message.t === 'subscribed' && !injected) {
        injected = true; const row = rows[104]
        p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(row.envelope).toString()).id, envelope: row.envelope, sig: row.sig, recvTs: row.recvTs })
        await first.a.publishRecord(p.stream.id, row)
      }
    })
    first.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(first.b.state()).toBe('closed'))
    expect(p.bStore.cursor(p.stream.id).seq).toBe(89); expect(h.onRecord).toHaveBeenCalledTimes(10)
    first.a.close()
    const next = await sessions(p, { direct: true }); await Promise.all([next.a.opened, next.b.opened])
    const resumed = handlers(); next.b.subscribe(p.stream.id, resumed)
    await vi.waitFor(() => expect(resumed.onCaughtUp).toHaveBeenCalledOnce())
    expect(p.bStore.cursor(p.stream.id).seq).toBe(105); expect(resumed.onRecord).toHaveBeenCalledTimes(16)
  })

  it('coalesces 100 stalled snapshot requests and closes the reader on unsubscribe', async () => {
    const p = await profiles(), connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    const close = vi.fn(), open = vi.spyOn(p.aStore, 'openSnapshot').mockImplementation(() => ({ target: { epoch: 1, seq: 0 }, next: () => ({ records: [], done: true }), close }))
    connection.pair.backward.stall()
    const send = (connection.b as unknown as { send(message: unknown): Promise<void> }).send.bind(connection.b)
    await Promise.all(Array.from({ length: 100 }, () => send({ t: 'snapshot.get', stream: p.stream.id })))
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(close).not.toHaveBeenCalled()
    await send({ t: 'unsubscribe', stream: p.stream.id })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    connection.a.close(); expect(close).toHaveBeenCalledOnce()
  })
  it('releases a failed snapshot slot and starts the waiting subscription', async () => {
    const p = await profiles(), connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    connection.pair.backward.stall()
    const streams = [p.stream.id]
    for (let i = 0; i < 4; i++) {
      const descriptor = { ...p.stream, id: newId('stream') }; streams.push(descriptor.id)
      p.aStore.createStream(descriptor, 1); p.bStore.createStream(descriptor, 1)
    }
    const receive = (connection.b as unknown as { receive(message: unknown): Promise<void> }).receive.bind(connection.b)
    for (const stream of streams) {
      connection.b.subscribe(stream, handlers())
      await receive({ header: { t: 'snapshotRequired', stream, reason: 'cursorTooOld', head: { epoch: 1, seq: 0 } }, parts: [] })
    }
    const state = connection.b as unknown as { snapshotReceiving: Set<string>; snapshotWaiting: Set<string> }
    expect(state.snapshotReceiving.size).toBe(4); expect(state.snapshotWaiting.has(streams[4])).toBe(true)
    await receive({ header: { t: 'error', re: streams[0], error: { code: 'forbidden', message: 'Forbidden', retryable: false } }, parts: [] })
    expect(state.snapshotReceiving.has(streams[0])).toBe(false)
    expect(state.snapshotReceiving.has(streams[4])).toBe(true); expect(state.snapshotWaiting.size).toBe(0)
  })
  it('closes a silent half-open TLS session after three unanswered ping intervals', async () => {
    const clock = new FakeClock(Date.now()), p = await profiles(clock), connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    const closed = vi.fn(); connection.b.onClosed(closed)
    connection.pair.forward.halfOpen(); connection.pair.backward.halfOpen()
    for (let i = 0; i < 4; i++) { clock.advance(20_000); await new Promise(resolve => setImmediate(resolve)) }
    expect(connection.b.state()).toBe('closed')
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ code: 'peer_offline' }))
  })
  it('supplies an expired original lease to a fresh subscriber before replay', async () => {
    const clock = new FakeClock(Date.now()), p = await profiles(clock), row = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(row.envelope).toString()).id, envelope: row.envelope, sig: row.sig, recvTs: row.recvTs })
    for (let i = 0; i < 3; i++) { clock.advance(6 * 24 * 60 * 60 * 1_000); p.aIdentity.renewExpiring(clock.now()) }
    const path = makeTempDir('fresh-history-').path, db = new NetDatabase({ profileDir: path }), keys = new FileKeyStore(path)
    resources.push(() => db.close()); await keys.initialize({ asAuthority: false })
    const node = newId('node'), user = p.aIdentity.self()!.user
    p.aIdentity.issueNodeDelegation({ node, keys: keys.nodeKeys(), name: 'fresh', caps: ['read'] })
    const identity = new NetIdentityService({ database: db.database, keys, clock, coordinator: db, self: { node, user } })
    identity.pinUser(user, p.aKeys.rootKey()!); identity.acceptRoster(p.aIdentity.roster()!, p.aKeys.rootKey()!)
    expect(() => identity.verifyAuthor(JSON.parse(Buffer.from(row.envelope).toString()).author, row.envelope, row.sig, JSON.parse(Buffer.from(row.envelope).toString()).ts, 'history')).toThrow()
    const store = new SqliteStreamStore(db); store.createStream(p.stream, 1)
    Object.assign(p, { bKeys: keys, bIdentity: identity, bStore: store })
    const connection = await sessions(p, { clock }); await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers(); connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    expect(h.onRecord).toHaveBeenCalledOnce(); expect(connection.b.state()).toBe('open')
    expect(identity.roster()!.payload).toBe(p.aIdentity.roster()!.payload)
  })
  it('fetches a referenced blob through the production same-user authority', async () => {
    const p = await profiles(), bytes = Buffer.alloc(150_000, 42), blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as import('../../../src/shared/net').BlobId
    const upload = p.aBlobs.begin(blob, bytes.length, false)
    for (let at = 0; at < bytes.length; at += 48 * 1024) upload.write(at, bytes.subarray(at, at + 48 * 1024))
    upload.commit()
    const id = newId('event'), envelope = encodeEnvelope({ v: 1, minor: 0, id, stream: p.stream.id, type: 'message.posted', crit: false, author: { user: p.aIdentity.self()!.user, node: p.aIdentity.self()!.node, keyEpoch: 1 }, ts: Date.now(), body: { text: 'attachment' }, blobs: [{ id: blob, bytes: bytes.length, mime: 'application/octet-stream', sealed: false }] })
    p.aStore.appendAsAuthority(p.stream.id, { id, envelope, sig: p.aKeys.signAsNode(envelope), recvTs: Date.now() }); p.aBlobs.addRef(blob, p.stream.id, id)
    const connection = await sessions(p, { direct: true }); await Promise.all([connection.a.opened, connection.b.opened])
    expect(Buffer.from(await connection.b.getBlob(p.stream.id, blob)).equals(bytes)).toBe(true)
    const other = newId('stream'); expect(() => connection.b.getBlob(other, blob)).toThrow()
    // Repeated same-blob requests cannot start competing offset loops.
    connection.a.close(); connection.b.close()
    const stalled = await sessions(p); await Promise.all([stalled.a.opened, stalled.b.opened])
    stalled.pair.backward.stall()
    const read = vi.spyOn(p.aBlobs, 'read'), download = stalled.b.getBlob(p.stream.id, blob).catch(error => error)
    const send = (stalled.b as unknown as { send(message: unknown): Promise<void> }).send.bind(stalled.b)
    await Promise.all(Array.from({ length: 20 }, () => send({ t: 'blob.get', stream: p.stream.id, blob, offset: 0 })))
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    stalled.a.close(); stalled.b.close(); await download
    expect(read).toHaveBeenCalledOnce()
  })

  it('authenticates, replicates signed records, disconnects and resumes once', async () => {
    const p = await profiles(), rows = Array.from({ length: 3 }, (_, i) => p.record(i + 1))
    for (const record of rows.slice(0, 2)) p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(record.envelope).toString()).id, envelope: record.envelope, sig: record.sig, recvTs: record.recvTs })
    const first = await sessions(p); await Promise.all([first.a.opened, first.b.opened])
    expect(first.b.peer.node).toBe(p.aIdentity.self()!.node)
    const closed = vi.fn(); first.b.onClosed(closed); first.a.onClosed(closed)
    const h = handlers(); first.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => { expect(closed.mock.calls.map(([error]) => ({ code: error?.code, message: error?.message }))).toEqual([]); expect(h.onCaughtUp).toHaveBeenCalledOnce() })
    expect(p.bStore.cursor(p.stream.id).seq).toBe(2)
    first.a.close(); first.b.close()
    const record = rows[2]
    p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(record.envelope).toString()).id, envelope: record.envelope, sig: record.sig, recvTs: record.recvTs })
    const next = await sessions(p); await Promise.all([next.a.opened, next.b.opened])
    const after = handlers(); next.b.subscribe(p.stream.id, after)
    await vi.waitFor(() => expect(after.onCaughtUp).toHaveBeenCalledOnce())
    expect(p.bStore.cursor(p.stream.id).seq).toBe(3)
    expect(after.onRecord).toHaveBeenCalledTimes(1)
  })
  it('replicates a signed event through the production loopback WebSocket/TLS transport', async () => {
    const p = await profiles(), record = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(record.envelope).toString()).id, envelope: record.envelope, sig: record.sig, recvTs: record.recvTs })
    const connection = await sessions(p, { direct: true })
    await Promise.all([connection.a.opened, connection.b.opened])
    const h = handlers(); connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    expect(p.bStore.cursor(p.stream.id).seq).toBe(1)
    expect(Buffer.from(h.onRecord.mock.calls[0][0].envelope).equals(record.envelope)).toBe(true)
  })
  it('qualifies only a correlated pong and exposes subsequent wall-clock discontinuity', async () => {
    const p = await profiles(), clock = new FakeClock(Date.now())
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
    const clock = new FakeClock(Date.now()), p = await profiles(clock)
    const prior = p.bIdentity.roster()!.payload
    clock.advance(6 * 24 * 60 * 60 * 1_000)
    expect(p.aIdentity.renewExpiring(clock.now())).toBeDefined()
    expect(p.bIdentity.roster()!.payload).toBe(prior)
    const connection = await sessions(p, { clock })
    await Promise.all([connection.a.opened, connection.b.opened])
    expect(connection.a.state()).toBe('open')
    expect(p.bIdentity.roster()!.payload).toBe(p.aIdentity.roster()!.payload)
    expect(connection.a.peer.delegation.expiresAt).toBeGreaterThan(clock.now() + 24 * 60 * 60 * 1_000)
  })
  it('rejects a hello whose delegation transport key differs from its real certificate', async () => {
    const p = await profiles(), connection = await sessions(p, { clientCredentials: generateSelfSignedCert('wrong-key') })
    await expect(connection.a.opened).rejects.toMatchObject({ code: 'peer_key_mismatch' })
    expect(connection.a.state()).toBe('closed')
  })
  it('counts unknown mux payload before dispatch and rejects oversized quarantine traffic', async () => {
    const p = await profiles(), pair = memoryPair()
    const [server, client] = await Promise.all([
      openSecureChannel(pair.b, { role: 'server', credentials: p.aKeys.tlsCredentials(), deadlineMs: 2_000 }),
      openSecureChannel(pair.a, { role: 'client', credentials: p.bKeys.tlsCredentials(), expectedPeerFingerprint: fingerprint(Buffer.from(p.aKeys.nodeKeys().transport, 'base64url')), deadlineMs: 2_000 })
    ])
    const session = new NetSyncSession({ channel: server, identity: p.aIdentity, store: p.aStore })
    resources.push(() => session.close(), () => client.close())
    const header = Buffer.from(JSON.stringify({ t: 'future.unknown', data: 'x'.repeat(18_000) }))
    const message = Buffer.alloc(4 + header.length); message.writeUInt32BE(header.length); header.copy(message, 4)
    const frame = Buffer.alloc(16 + message.length); frame[0] = 1; frame[2] = 3; frame.writeUInt32BE(1, 4); frame.writeUInt32BE(message.length, 8); message.copy(frame, 16)
    const rejected = expect(session.opened).rejects.toMatchObject({ code: 'too_large' })
    client.stream.write(frame)
    await rejected
    expect(session.state()).toBe('closed')
  })
  it('tears down an authenticated session when its verified roster revokes the peer', async () => {
    const p = await profiles(), connection = await sessions(p)
    await Promise.all([connection.a.opened, connection.b.opened])
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(() => expect(connection.a.state()).toBe('closed'))
    await vi.waitFor(() => expect(connection.b.state()).toBe('closed'))
    expect(p.bIdentity.roster()).toEqual(p.aIdentity.roster())
  })
  it('flushes revocation while an aborted RPC unwinds behind a stalled write', async () => {
    const p = await profiles(), clock = new FakeClock(Date.now()), executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({ db: p.aDb, executions, identity: p.aIdentity, clock })
    let started = false, aborted = false
    rpc.register({ method: 'test.revokeDrain', capability: 'write', mutating: true, handle: async (_params, context) => {
      started = true
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      return null
    } })
    const connection = await sessions(p, { rpc, clock }); await Promise.all([connection.a.opened, connection.b.opened])
    const result = connection.b.rpc('test.revokeDrain', {}, { id: newId('rpc'), idem: 'revoke-drain', deadlineMs: 5_000 }).catch(error => error)
    await vi.waitFor(() => expect(started).toBe(true))
    connection.pair.backward.stall()
    p.aIdentity.revoke(p.bIdentity.self()!.node)
    await vi.waitFor(() => expect(executions.find({ scope: p.bIdentity.self()!.node, target: 'test.revokeDrain', trigger: 'revoke-drain' })?.state).toBe('uncertain'))
    expect(aborted).toBe(true); expect(connection.a.state()).toBe('open')
    expect(p.bIdentity.roster()).not.toEqual(p.aIdentity.roster())
    connection.pair.backward.resume()
    await vi.waitFor(() => expect(p.bIdentity.roster()).toEqual(p.aIdentity.roster()))
    await vi.waitFor(() => { expect(connection.a.state()).toBe('closed'); expect(connection.b.state()).toBe('closed') })
    expect(await result).toEqual(expect.objectContaining({ code: expect.stringMatching(/^(revoked|route_unreachable)$/) }))
  })
  it.each(['replay', 'snapshot', 'blob'] as const)('flushes revocation while %s delivery unwinds', async kind => {
    const p = await profiles(), clock = new FakeClock(Date.now()), bytes = Buffer.from('revocation drain fixture')
    const blob = `blb_${createHash('sha256').update(bytes).digest('hex')}` as import('../../../src/shared/net').BlobId
    const upload = p.aBlobs.begin(blob, bytes.length, false); upload.write(0, bytes); upload.commit()
    const id = newId('event'), envelope = encodeEnvelope({ v: 1, minor: 0, id, stream: p.stream.id, type: 'message.posted', crit: false, author: { user: p.aIdentity.self()!.user, node: p.aIdentity.self()!.node, keyEpoch: 1 }, ts: Date.now(), body: { text: 'attachment' }, blobs: [{ id: blob, bytes: bytes.length, mime: 'application/octet-stream', sealed: false }] })
    p.aStore.appendAsAuthority(p.stream.id, { id, envelope, sig: p.aKeys.signAsNode(envelope), recvTs: Date.now() }); p.aBlobs.addRef(blob, p.stream.id, id)
    const connection = await sessions(p, { clock }); await Promise.all([connection.a.opened, connection.b.opened])
    let revoked = false
    const revokeDuringRead = (): void => { if (revoked) return; revoked = true; connection.pair.backward.stall(); p.aIdentity.revoke(p.bIdentity.self()!.node) }
    if (kind === 'replay') {
      const read = p.aStore.read.bind(p.aStore)
      vi.spyOn(p.aStore, 'read').mockImplementation((...args) => { const page = read(...args); revokeDuringRead(); return page })
    } else if (kind === 'snapshot') {
      vi.spyOn(p.aStore, 'snapshotReason').mockReturnValueOnce('cursorTooOld')
      const open = p.aStore.openSnapshot.bind(p.aStore)
      vi.spyOn(p.aStore, 'openSnapshot').mockImplementation(stream => {
        const reader = open(stream)
        return { target: reader.target, next: (...args) => { const page = reader.next(...args); revokeDuringRead(); return page }, close: () => reader.close() }
      })
    } else {
      const read = p.aBlobs.read.bind(p.aBlobs)
      vi.spyOn(p.aBlobs, 'read').mockImplementation((...args) => { const chunk = read(...args); revokeDuringRead(); return chunk })
    }
    const h = handlers()
    const result = kind === 'blob' ? connection.b.getBlob(p.stream.id, blob).catch(error => error) : undefined
    if (kind !== 'blob') connection.b.subscribe(p.stream.id, h)
    await vi.waitFor(() => expect(revoked).toBe(true))
    expect(connection.a.state()).toBe('open'); expect(p.bIdentity.roster()).not.toEqual(p.aIdentity.roster())
    connection.pair.backward.resume()
    await vi.waitFor(() => expect(p.bIdentity.roster()).toEqual(p.aIdentity.roster()))
    await vi.waitFor(() => { expect(connection.a.state()).toBe('closed'); expect(connection.b.state()).toBe('closed') })
    expect(p.bStore.cursor(p.stream.id).seq).toBe(0); expect(h.onRecord).not.toHaveBeenCalled(); expect(h.onSnapshotInstalled).not.toHaveBeenCalled()
    if (result) expect(['revoked', 'route_unreachable']).toContain((await result).code)
  })
  it('rejects invalid RPC DTOs before admission and permits corrected reuse of the unadmitted request id', async () => {
    const p = await profiles(), executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({ db: p.aDb, executions, identity: p.aIdentity, clock: systemClock })
    let effects = 0
    rpc.register({ method: 'test.dto', capability: 'write', mutating: true, validate: params => {
      if (!params || typeof params !== 'object' || Object.keys(params).join(',') !== 'valid') throw new NetError('bad_request')
      return params
    }, handle: async () => { effects++; return { effects } } })
    const connection = await sessions(p, { rpc }); await Promise.all([connection.a.opened, connection.b.opened])
    const id = newId('rpc'), options = { id, idem: 'pure-dto', deadlineMs: 5000 }
    await expect(connection.b.rpc('test.dto', { extra: true }, options)).rejects.toMatchObject({ code: 'bad_request' })
    expect(effects).toBe(0)
    expect(executions.find({ scope: p.bIdentity.self()!.node, target: 'test.dto', trigger: 'pure-dto' })).toBeUndefined()
    expect(p.aDb.database.prepare('SELECT count(*) AS n FROM net_rpc_aliases WHERE id=?').get(id)?.n).toBe(0)
    expect(await connection.b.rpc('test.dto', { valid: true }, options)).toEqual({ effects: 1 })
  })
  it('journals mutations, returns the same outcome after retry, and refuses changed payloads', async () => {
    const p = await profiles(), executions = new SqliteExecutionLedger(p.aDb)
    let rpc = new DurableRpcDispatcher({ db: p.aDb, executions, identity: p.aIdentity, clock: systemClock })
    let effects = 0
    rpc.register({ method: 'test.mutate', capability: 'write', mutating: true, handle: async params => { effects++; return { params, effects } } })
    const first = await sessions(p, { rpc }); await Promise.all([first.a.opened, first.b.opened])
    const id = newId('rpc'), result = await first.b.rpc('test.mutate', { value: 1 }, { id, idem: 'stable', deadlineMs: 2_000 })
    expect(result).toEqual({ params: { value: 1 }, effects: 1 })
    first.a.close(); first.b.close()
    p.aDb.close()
    p.aDb = new NetDatabase({ profileDir: p.aPath })
    resources.push(() => p.aDb.close())
    p.aIdentity = new NetIdentityService({ database: p.aDb.database, keys: p.aKeys, clock: systemClock, coordinator: p.aDb })
    p.aStore = new SqliteStreamStore(p.aDb)
    rpc = new DurableRpcDispatcher({ db: p.aDb, executions: new SqliteExecutionLedger(p.aDb), identity: p.aIdentity, clock: systemClock })
    rpc.register({ method: 'test.mutate', capability: 'write', mutating: true, handle: async params => { effects++; return { params, effects } } })
    const next = await sessions(p, { rpc }); await Promise.all([next.a.opened, next.b.opened])
    expect(await next.b.rpc('test.mutate', { value: 1 }, { id: newId('rpc'), idem: 'stable', deadlineMs: 2_000 })).toEqual(result)
    expect(await next.b.rpcResult(id, { deadlineMs: 2_000 })).toEqual(result)
    await expect(next.b.rpc('test.mutate', { value: 2 }, { id: newId('rpc'), idem: 'stable', deadlineMs: 2_000 })).rejects.toMatchObject({ code: 'conflict' })
    await expect(next.b.rpcResult(newId('rpc'), { deadlineMs: 2_000 })).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(effects).toBe(1)
  })
  it('automatically reconnects and resubscribes from the durable cursor after a link cut', async () => {
    const p = await profiles(), clock = new FakeClock(Date.now())
    const connections: Awaited<ReturnType<typeof sessions>>[] = []
    const record = p.record(1)
    p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(record.envelope).toString()).id, envelope: record.envelope, sig: record.sig, recvTs: record.recvTs })
    const supervisor = new SyncSupervisor({ identity: p.bIdentity, clock, random: () => 1, connect: async signal => {
      const connection = await sessions(p)
      signal.addEventListener('abort', () => { connection.a.close(); connection.b.close() }, { once: true })
      await Promise.all([connection.a.opened, connection.b.opened])
      connections.push(connection)
      return connection.b
    } })
    resources.push(() => supervisor.close())
    const h = handlers(); supervisor.subscribe(p.stream.id, h)
    await supervisor.opened
    await vi.waitFor(() => expect(p.bStore.cursor(p.stream.id).seq).toBe(1))
    connections[0].pair.cut()
    await vi.waitFor(() => expect(supervisor.state()).toBe('connecting'))
    const next = p.record(2)
    p.aStore.appendAsAuthority(p.stream.id, { id: JSON.parse(Buffer.from(next.envelope).toString()).id, envelope: next.envelope, sig: next.sig, recvTs: next.recvTs })
    clock.advance(1_000)
    await vi.waitFor(() => expect(p.bStore.cursor(p.stream.id).seq).toBe(2))
    expect(connections).toHaveLength(2)
    expect(h.onRecord).toHaveBeenCalledTimes(2)
    expect(supervisor.state()).toBe('open')
    supervisor.close()
    expect(clock.pending()).toBe(0)
  })
  it('reconnects subscriptions after cancelling a started send without replaying the mutation', async () => {
    const p = await profiles(), clock = new FakeClock(Date.now()), connections: Awaited<ReturnType<typeof sessions>>[] = []
    const rpc = new DurableRpcDispatcher({ db: p.aDb, executions: new SqliteExecutionLedger(p.aDb), identity: p.aIdentity, clock: systemClock })
    const handle = vi.fn(async () => ({ done: true }))
    rpc.register({ method: 'test.partialCancel', capability: 'write', mutating: true, handle })
    const supervisor = new SyncSupervisor({ identity: p.bIdentity, clock, random: () => 1, connect: async signal => {
      const connection = await sessions(p, { rpc })
      signal.addEventListener('abort', () => { connection.a.close(); connection.b.close() }, { once: true })
      await Promise.all([connection.a.opened, connection.b.opened]); connections.push(connection); return connection.b
    } })
    resources.push(() => supervisor.close())
    const h = handlers(); supervisor.subscribe(p.stream.id, h); await supervisor.opened
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledOnce())
    connections[0].pair.forward.stall()
    const controller = new AbortController()
    const request = supervisor.rpc('test.partialCancel', {}, { id: newId('rpc'), idem: 'partial', deadlineMs: 5_000, signal: controller.signal })
    void request.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(supervisor.state()).toBe('connecting'))
    clock.advance(1_000)
    await vi.waitFor(() => expect(h.onCaughtUp).toHaveBeenCalledTimes(2))
    expect(connections).toHaveLength(2); expect(supervisor.state()).toBe('open'); expect(handle).not.toHaveBeenCalled()
  })
  it('keeps the session open when cancellation removes an unadmitted request', async () => {
    const p = await profiles(), rpc = new DurableRpcDispatcher({ db: p.aDb, executions: new SqliteExecutionLedger(p.aDb), identity: p.aIdentity, clock: systemClock })
    const handle = vi.fn(async () => ({ done: true }))
    rpc.register({ method: 'test.earlyCancel', capability: 'write', mutating: true, handle })
    const connection = await sessions(p, { rpc }); await Promise.all([connection.a.opened, connection.b.opened])
    const controller = new AbortController(), id = newId('rpc')
    const request = connection.b.rpc('test.earlyCancel', {}, { id, idem: 'never-admitted', deadlineMs: 2_000, signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await expect(connection.b.rpcResult(id, { deadlineMs: 2_000 })).rejects.toMatchObject({ code: 'outcome_uncertain' })
    expect(handle).not.toHaveBeenCalled(); expect(connection.a.state()).toBe('open'); expect(connection.b.state()).toBe('open')
  })
  it('propagates caller cancellation to the running RPC handler without claiming rollback', async () => {
    const p = await profiles(), executions = new SqliteExecutionLedger(p.aDb)
    const rpc = new DurableRpcDispatcher({ db: p.aDb, executions, identity: p.aIdentity, clock: systemClock })
    let started = false, aborted = false
    rpc.register({ method: 'test.cancel', capability: 'write', mutating: true, handle: async (_params, context) => {
      started = true
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      return { stopped: true }
    } })
    const connection = await sessions(p, { rpc }); await Promise.all([connection.a.opened, connection.b.opened])
    const signal = new AbortController(), id = newId('rpc')
    const request = connection.b.rpc('test.cancel', {}, { id, idem: 'cancel', deadlineMs: 5_000, signal: signal.signal })
    void request.catch(() => {})
    await vi.waitFor(() => expect(started).toBe(true))
    signal.abort()
    await expect(request).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(aborted).toBe(true))
    await vi.waitFor(() => expect(executions.find({ scope: p.bIdentity.self()!.node, target: 'test.cancel', trigger: 'cancel' })?.state).toBe('uncertain'))
  })
})
