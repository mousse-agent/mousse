import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileKeyStore, NetIdentityService } from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { canonicalJson, encodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { systemClock } from '../../../../src/mms/net/clock'
import { BridgeHub } from '../../../../src/mms/bridge/hub'
import { COPY_LIMIT_DEFAULTS, readCopyLimits } from '../../../../src/mms/bridge/copyLimits'
import { newId } from '../../../../src/shared/net'
import type {
  NodeDelegation,
  NodeId,
  Roster,
  StoredRecord,
  StreamDescriptor
} from '../../../../src/shared/net'
import type { SubscriptionHandlers, SyncSession } from '../../../../src/mms/net/contracts'

/**
 * The copy this computer keeps of another computer's lists stream (`private:mousse:lists`). That computer publishes a
 * whole snapshot of its lists on every change; a copy that kept and re-checked every one of them grew to gigabytes and
 * held the service at full CPU. These tests hold the copy to its newest snapshot, and an attach to checking that.
 */

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-copy-')))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

const LISTS = 'mousse:lists'

/** Another computer of the user that writes a lists stream, and this computer, which keeps a copy of it. */
async function computers() {
  const ownerDir = temp(),
    ownerDb = new NetDatabase({ profileDir: ownerDir }),
    ownerKeys = new FileKeyStore(ownerDir)
  cleanups.push(() => ownerDb.close())
  const owner = new NetIdentityService({
    database: ownerDb.database,
    keys: ownerKeys,
    clock: systemClock,
    coordinator: ownerDb
  })
  await owner.bootstrapAuthority('Writer')
  const { user, node: writer } = owner.self()!
  const readerDir = temp(),
    readerKeys = new FileKeyStore(readerDir)
  await readerKeys.initialize({ asAuthority: false })
  const node = newId('node')
  owner.issueNodeDelegation({ node, keys: readerKeys.nodeKeys(), name: 'Reader', caps: ['read'] })
  const db = new NetDatabase({ profileDir: readerDir })
  cleanups.push(() => db.close())
  const identity = new NetIdentityService({
    database: db.database,
    keys: readerKeys,
    clock: systemClock,
    coordinator: db,
    self: { user, node }
  })
  identity.pinUser(user, ownerKeys.rootKey()!)
  identity.acceptRoster(owner.roster()!, ownerKeys.rootKey()!)
  const store = new SqliteStreamStore(db)
  cleanups.push(() => store.close())

  const descriptor: StreamDescriptor = {
    id: newId('stream'),
    kind: 'node.thread',
    authority: writer,
    createdAt: 1
  }
  store.createStream(descriptor, 1)
  let seq = 0
  let epoch = 1
  /** A record the other computer signed, at the next position of the copy. */
  const signed = (type: string, body: unknown, sign = true): StoredRecord => {
    const envelope = encodeEnvelope({
      v: 1,
      minor: 0,
      id: newId('event'),
      stream: descriptor.id,
      type,
      crit: false,
      author: { user, node: writer, keyEpoch: 1 },
      ts: Date.now(),
      body
    })
    return {
      epoch,
      seq: ++seq,
      recvTs: Date.now(),
      envelope,
      sig: sign ? ownerKeys.signAsNode(envelope) : new Uint8Array(64).fill(1)
    }
  }
  /** The records of one lists snapshot, as the other computer publishes it (begin, chunks, end). */
  const snapshot = (
    value: unknown,
    shape: { end?: boolean; sign?: boolean } = {}
  ): StoredRecord[] => {
    const bytes = canonicalJson(value),
      id = randomUUID(),
      sha256 = createHash('sha256').update(bytes).digest('base64url'),
      chunks = Math.max(1, Math.ceil(bytes.length / (32 * 1024)))
    const records = [
      signed('thread.snapshot.begin', {
        threadId: LISTS,
        snapshot: id,
        totalBytes: bytes.length,
        chunks,
        sha256
      })
    ]
    for (let index = 0; index < chunks; index++)
      records.push(
        signed(
          'thread.snapshot.chunk',
          {
            threadId: LISTS,
            snapshot: id,
            index,
            data: Buffer.from(bytes.subarray(index * 32 * 1024, (index + 1) * 32 * 1024)).toString(
              'base64url'
            )
          },
          shape.sign
        )
      )
    if (shape.end !== false)
      records.push(signed('thread.snapshot.end', { threadId: LISTS, snapshot: id, sha256 }))
    return records
  }
  const event = (): StoredRecord =>
    signed('thread.event', { threadId: LISTS, type: 'queue.updated', data: {} })
  /** Stores records in the copy as the subscription does, in bounded batches. */
  const receive = (records: StoredRecord[]): void => {
    for (let at = 0; at < records.length; at += 200)
      store.applyFromAuthority(descriptor.id, records.slice(at, at + 200))
  }
  const lists = (n: number) => ({ kind: 'mousse.lists', version: 1, n, threads: [{ id: `t${n}` }] })

  // The other computer's session, as this computer's checks see it; nothing goes over a network.
  const root = identity.pinnedRootKey(user)!
  const delegation = identity
    .verifySigned<Roster>(identity.roster(user)!, root)
    .nodes.map((row) => identity.verifySigned<NodeDelegation>(row, root))
    .find((row) => row.subject === writer)!
  let handlers: SubscriptionHandlers | undefined
  const session = {
    state: () => 'open',
    peer: { node: writer, user, delegation },
    subscribe: (_stream: unknown, next: SubscriptionHandlers) => {
      handlers = next
      return { close() {} }
    },
    onClosed: () => () => {},
    onEphemeral: () => () => {}
  } as unknown as SyncSession
  const hub = new BridgeHub({ db, identity, keys: readerKeys, store, session: () => session })
  cleanups.push(async () => {
    hub.close()
    await hub.drain()
  })

  /** Opens the lists stream as `MergedLists` does, and collects the lists it shows. */
  const attach = async () => {
    const shown: unknown[] = []
    const handle = await hub.attach(
      { nodeId: writer as NodeId, entityId: LISTS },
      (update) => {
        if (update.kind === 'snapshot') shown.push(update.value)
      },
      undefined,
      { room: 'lists', open: async () => ({ descriptor, head: store.head(descriptor.id) }) }
    )
    return { shown, handle }
  }
  /** Records arriving live: stored, then handed to the attachment, as `SubscriptionReceiver` does. */
  const live = async (records: StoredRecord[]) => {
    receive(records)
    for (const record of records) handlers!.onRecord(record)
    // Once to display them; once more for what displaying them started (the copy dropping what they replaced).
    await hub.drain()
    await hub.drain()
  }
  /** What the copy holds, as positions. */
  const held = (): string[] =>
    (
      db.database.prepare('SELECT epoch,seq FROM net_records ORDER BY epoch,seq').all() as Array<{
        epoch: number
        seq: number
      }>
    ).map((row) => `${row.epoch}/${row.seq}`)
  const remember = (): void => {
    db.database
      .prepare('INSERT INTO net_bridge_hub_threads VALUES(?,?,?)')
      .run(writer, `private:${LISTS}`, JSON.stringify(descriptor))
  }
  return {
    owner,
    ownerKeys,
    identity,
    db,
    store,
    hub,
    descriptor,
    writer,
    node,
    readerKeys,
    snapshot,
    event,
    receive,
    lists,
    attach,
    live,
    held,
    remember,
    nextEpoch: () => {
      epoch++
      seq = 0
    }
  }
}

describe("a copy of another computer's lists", () => {
  it('with thousands of snapshots, attaches by checking only its newest, and keeps only that', async () => {
    const f = await computers()
    const records: StoredRecord[] = []
    for (let n = 1; n <= 2000; n++) records.push(...f.snapshot(f.lists(n)))
    f.receive(records)
    expect(f.held()).toHaveLength(6000)
    const checks = vi.spyOn(f.identity, 'verifyAuthor')

    const first = await f.attach()
    // The newest lists, and only them: the 1999 replaced snapshots are neither shown nor checked again.
    expect(first.shown).toEqual([f.lists(2000)])
    expect(checks).toHaveBeenCalledTimes(3)
    await f.hub.drain()
    expect(f.held()).toEqual(['1/5998', '1/5999', '1/6000'])

    // A new snapshot arrives: shown, and the copy moves on to it.
    await f.live(f.snapshot(f.lists(2001)))
    expect(first.shown.at(-1)).toEqual(f.lists(2001))
    expect(f.held()).toEqual(['1/6001', '1/6002', '1/6003'])
    expect(checks).toHaveBeenCalledTimes(6)

    // A second window opens the same lists: shown from the copy, with no signature checked again.
    const second = await f.attach()
    expect(second.shown).toEqual([f.lists(2001)])
    expect(checks).toHaveBeenCalledTimes(6)

    // The roster changes: what was checked under the old one is checked again.
    f.owner.issueNodeDelegation({
      node: newId('node'),
      keys: f.readerKeys.nodeKeys(),
      name: 'Third',
      caps: ['read']
    })
    f.identity.acceptRoster(f.owner.roster()!, f.ownerKeys.rootKey()!)
    const third = await f.attach()
    expect(third.shown).toEqual([f.lists(2001)])
    expect(checks).toHaveBeenCalledTimes(9)
    first.handle.close()
    second.handle.close()
    third.handle.close()
  })

  // What a copy keeps when it is tidied after a start (`tidyCopies`): never less than its newest snapshot that
  // passes every check, and everything when none does.
  const cases: Array<{
    name: string
    build: (f: Awaited<ReturnType<typeof computers>>) => void
    held: string[]
    /** The lists an attach then shows. */
    shown?: number
  }> = [
    {
      name: 'a complete newest snapshot, then events: from that snapshot on',
      build: (f) =>
        f.receive([...f.snapshot(f.lists(1)), ...f.snapshot(f.lists(2)), f.event(), f.event()]),
      held: ['1/4', '1/5', '1/6', '1/7', '1/8'],
      shown: 2
    },
    {
      name: 'the newest snapshot still arriving (no end yet): from the snapshot before it',
      build: (f) =>
        f.receive([
          ...f.snapshot(f.lists(1)),
          ...f.snapshot(f.lists(2)),
          ...f.snapshot(f.lists(3), { end: false })
        ]),
      held: ['1/4', '1/5', '1/6', '1/7', '1/8'],
      shown: 2
    },
    {
      name: 'a newest snapshot whose signature does not check: everything',
      build: (f) =>
        f.receive([...f.snapshot(f.lists(1)), ...f.snapshot(f.lists(2), { sign: false })]),
      held: ['1/1', '1/2', '1/3', '1/4', '1/5', '1/6']
    },
    {
      name: 'events and no snapshot: everything',
      build: (f) => f.receive([f.event(), f.event()]),
      held: ['1/1', '1/2']
    }
  ]
  it.each(cases)('tidied after a start, keeps $name', async ({ build, held, shown }) => {
    const f = await computers()
    build(f)
    f.remember()
    await f.hub.tidyCopies()
    expect(f.held()).toEqual(held)
    // What it keeps still shows what it showed.
    if (shown) expect((await f.attach()).shown).toEqual([f.lists(shown)])
  })

  it('tidied after a start, drops the generations and epochs nothing reads', async () => {
    const f = await computers()
    f.receive([...f.snapshot(f.lists(1)), ...f.snapshot(f.lists(2))])
    // This computer fell behind: a fresh snapshot from the other computer replaced the copy's generation.
    f.store.installSnapshot(
      f.descriptor.id,
      1,
      9,
      f.snapshot(f.lists(3)).map((record, index) => ({ ...record, seq: 7 + index }))
    )
    const generations = () =>
      f.db.database
        .prepare('SELECT state FROM net_generations ORDER BY state')
        .all()
        .map((row) => row.state)
    expect(generations()).toEqual(['active', 'archived'])
    f.remember()
    await f.hub.tidyCopies()
    expect(generations()).toEqual(['active'])
    expect(f.held()).toEqual(['1/7', '1/8', '1/9'])
    expect((await f.attach()).shown).toEqual([f.lists(3)])
  })
})

describe('dropping from a copy', () => {
  it('drops nothing once the snapshot it keeps is no longer held, and never from a space stream', async () => {
    const f = await computers()
    const old = f.snapshot(f.lists(1))
    f.receive([...old, ...f.snapshot(f.lists(2))])
    const begin = old[0]
    const keep = { epoch: 1, seq: 4, id: newId('event') }
    // A position whose record is another one: nothing goes.
    expect(f.store.dropBefore(f.descriptor.id, keep, { rows: 200, bytes: 1 << 20 })).toBe(0)
    expect(f.held()).toHaveLength(6)
    // The kept snapshot was replaced by a new generation: nothing of the new one goes.
    f.store.installSnapshot(
      f.descriptor.id,
      1,
      9,
      f.snapshot(f.lists(3)).map((record, index) => ({ ...record, seq: 7 + index }))
    )
    expect(
      f.store.dropBefore(
        f.descriptor.id,
        { epoch: 1, seq: 1, id: idOf(begin) },
        { rows: 200, bytes: 1 << 20 }
      )
    ).toBe(0)
    expect(f.held().filter((at) => ['1/7', '1/8', '1/9'].includes(at))).toHaveLength(3)
    const space: StreamDescriptor = {
      id: newId('stream'),
      kind: 'space.channel',
      authority: f.writer,
      space: newId('space'),
      createdAt: 1
    }
    f.store.createStream(space, 1)
    expect(() => f.store.dropBefore(space.id, keep, { rows: 200, bytes: 1 << 20 })).toThrow(
      /Only thread display copies/
    )
  })

  it('stops a step once its records reach its bytes, at least one record a step', async () => {
    const f = await computers()
    f.receive([...f.snapshot(f.lists(1)), ...f.snapshot(f.lists(2)), ...f.snapshot(f.lists(3))])
    const keep = {
      epoch: 1,
      seq: 7,
      id: idOf(f.store.lastOfType!(f.descriptor.id, 'thread.snapshot.begin')!)
    }
    const steps: number[] = []
    for (
      let dropped;
      (dropped = f.store.dropBefore!(f.descriptor.id, keep, { rows: 200, bytes: 1 }));
    )
      steps.push(dropped)
    expect(steps).toEqual([1, 1, 1, 1, 1, 1])
    expect(f.held()[0]).toBe('1/7')
  })

  // Each limit is a named default; a variable overrides it, held to a range that keeps one drop step inside a
  // transaction's bounds.
  it.each([
    ['nothing set', {}, {}, 0],
    [
      'a step larger than a transaction allows',
      { MOUSSE_NET_COPY_DROP_BATCH_ROWS: '5000' },
      { dropBatchRows: 400 },
      1
    ],
    [
      'a step of more bytes than a transaction allows',
      { MOUSSE_NET_COPY_DROP_BATCH_BYTES: '9999999' },
      { dropBatchBytes: 1 << 20 },
      1
    ],
    ['no remembered checks', { MOUSSE_NET_VERIFIED_RECORDS: '0' }, { verifiedRecords: 0 }, 0],
    ['an interval that is not a number', { MOUSSE_NET_LISTS_TIMES_INTERVAL_MS: 'fast' }, {}, 1],
    [
      'an interval below a second',
      { MOUSSE_NET_LISTS_TIMES_INTERVAL_MS: '10' },
      { listsTimesIntervalMs: 1000 },
      1
    ],
    ['a tidy at once', { MOUSSE_NET_COPY_SWEEP_DELAY_MS: ' 0 ' }, { sweepDelayMs: 0 }, 0]
  ])('limits: %s', (_name, env, changed, problems) => {
    const read = readCopyLimits(env)
    expect(read.limits).toEqual({ ...COPY_LIMIT_DEFAULTS, ...changed })
    expect(read.problems).toHaveLength(problems)
  })
})

function idOf(record: StoredRecord) {
  return JSON.parse(Buffer.from(record.envelope).toString('utf8')).id
}
