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

/**
 * Another computer of the user that writes a lists stream, and this computer, which keeps a copy of it. With `own`,
 * the stream is one this computer writes itself.
 */
async function computers(options: { own?: boolean } = {}) {
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

  const author = options.own ? node : writer
  const descriptor: StreamDescriptor = {
    id: newId('stream'),
    kind: 'node.thread',
    authority: author,
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
      author: { user, node: author, keyEpoch: 1 },
      ts: Date.now(),
      body
    })
    return {
      epoch,
      seq: ++seq,
      recvTs: Date.now(),
      envelope,
      sig: sign
        ? (options.own ? readerKeys : ownerKeys).signAsNode(envelope)
        : new Uint8Array(64).fill(1)
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
      { nodeId: author as NodeId, entityId: LISTS },
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
      .run(author, `private:${LISTS}`, JSON.stringify(descriptor))
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

describe('a copy that begins part-way through a snapshot', () => {
  it('passes over the cut-off snapshot when it is read whole, and shows the next one', async () => {
    const f = await computers()
    const first = f.snapshot(f.lists(1)),
      second = f.snapshot(f.lists(2))
    // The copy lost the start of the first snapshot, and the second is still arriving: it is read from its oldest
    // record, which belongs to a snapshot it cannot show.
    f.receive([...first, ...second.slice(0, -1)])
    f.db.database.prepare('DELETE FROM net_records WHERE epoch=1 AND seq=1').run()
    const { shown, handle } = await f.attach()
    expect(shown).toEqual([])
    await f.live(second.slice(-1))
    expect(shown).toEqual([f.lists(2)])
    handle.close()
  })

  it('says a copy whose snapshot does not read as needing a fresh one, so the copy can be dropped', async () => {
    const f = await computers()
    f.receive(f.snapshot(f.lists(1)))
    // Its chunk went missing from the disk: the copy, not the other computer, is at fault.
    f.db.database.prepare('DELETE FROM net_records WHERE epoch=1 AND seq=2').run()
    await expect(f.attach()).rejects.toMatchObject({ code: 'snapshot_required' })
  })
})

describe("dropping a copy of another computer's lists", () => {
  it('drops everything stored for it, a step at a time, so a stream offered anew attaches fresh', async () => {
    const f = await computers()
    const records: StoredRecord[] = []
    for (let n = 1; n <= 300; n++) records.push(...f.snapshot(f.lists(n)))
    f.receive(records)
    const first = await f.attach()
    expect(first.shown).toEqual([f.lists(300)])
    first.handle.close()
    // The other computer made its lists stream anew: the copy holds another stream under the same id.
    const offered: StreamDescriptor = { ...f.descriptor, createdAt: 2 }
    const options = {
      room: 'lists' as const,
      open: async () => ({ descriptor: offered, head: { epoch: 1, seq: 0 } })
    }
    const ref = { nodeId: f.writer as NodeId, entityId: LISTS }
    await expect(f.hub.attach(ref, () => {}, undefined, options)).rejects.toMatchObject({
      code: 'conflict'
    })
    const transactions = vi.spyOn(f.db, 'transaction')

    expect(await f.hub.dropCopy(ref, options)).toBe(true)
    // Records go in steps no larger than one drop step: 900 records, at most 200 a step.
    expect(transactions.mock.calls.length).toBeGreaterThanOrEqual(5)
    const count = (sql: string) =>
      Number(Object.values(f.db.database.prepare(sql).get(f.descriptor.id)!)[0])
    expect([
      count('SELECT count(*) FROM net_streams WHERE id=?'),
      count('SELECT count(*) FROM net_generations WHERE stream=?'),
      count('SELECT count(*) FROM net_event_ids WHERE stream=?')
    ]).toEqual([0, 0, 0])
    expect(f.db.database.prepare('SELECT count(*) AS n FROM net_records').get()!.n).toBe(0)
    expect(f.db.database.prepare('SELECT count(*) AS n FROM net_bridge_hub_threads').get()!.n).toBe(
      0
    )

    // Attached again, it reads the stream as offered now.
    const fresh = await f.hub.attach(ref, () => {}, undefined, options)
    expect(f.store.getStream(f.descriptor.id)).toEqual(offered)
    fresh.close()
    expect(
      await f.hub.dropCopy({ nodeId: newId('node') as NodeId, entityId: LISTS }, options)
    ).toBe(false)
  })
})

describe('a stream this computer writes', () => {
  it('loses only the records of epochs before its current one', async () => {
    const f = await computers({ own: true })
    f.receive([...f.snapshot(f.lists(1)), f.event()])
    // The thread restarted: its display began a new epoch, which every read takes from.
    f.store.beginNodeEpoch(f.descriptor.id, 2)
    f.nextEpoch()
    f.receive([...f.snapshot(f.lists(2)), ...f.snapshot(f.lists(3))])
    await f.hub.tidyCopies()
    expect(f.held()).toEqual(['2/1', '2/2', '2/3', '2/4', '2/5', '2/6'])
  })

  it('keeps every record of its current epoch, even ones a newer snapshot replaced', async () => {
    const f = await computers({ own: true })
    f.receive([...f.snapshot(f.lists(1)), ...f.snapshot(f.lists(2))])
    f.remember()
    await f.hub.tidyCopies()
    expect(f.held()).toEqual(['1/1', '1/2', '1/3', '1/4', '1/5', '1/6'])
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

  it('drops nothing while a snapshot of the copy is staged, so the snapshot installs', async () => {
    const f = await computers()
    const held = [...f.snapshot(f.lists(1)), ...f.snapshot(f.lists(2))]
    f.receive(held)
    const keep = { epoch: 1, seq: 4, id: idOf(held[3]!) }
    // The other computer answered a subscribe with a fresh snapshot, which arrives in two messages, and a drop
    // step comes between them.
    const fresh = f.snapshot(f.lists(3))
    const stage = f.store.beginSnapshot(f.descriptor.id, { epoch: 1, seq: 9 })
    stage.append(fresh.slice(0, 1))
    const dropped = f.store.dropBefore!(f.descriptor.id, keep, { rows: 200, bytes: 1 << 20 })
    stage.append(fresh.slice(1))
    stage.commit()
    expect(dropped).toBe(0)
    expect(f.store.head(f.descriptor.id)).toMatchObject({ epoch: 1, seq: 9 })
    expect((await f.attach()).shown).toEqual([f.lists(3)])
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
