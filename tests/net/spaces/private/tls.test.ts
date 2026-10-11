import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { SpaceHostService } from '../../../../src/mms/spaces/host'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private'
import { SqlPrivateStreamKeys } from '../../../../src/mms/net/identity'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { NetSyncSession } from '../../../../src/mms/net/sync/session'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { NetError } from '../../../../src/shared/net'
import { profile, peer, trust, signed, channels, cleanup, disposers } from '../host/helpers'
afterEach(cleanup)
async function setup() {
  const host = await profile(),
    a = await profile(host.clock, 'Controller'),
    b = await profile(host.clock, 'Participant'),
    c = await profile(host.clock, 'Added later'),
    space = host.host.create({ name: 'Private TLS' }),
    parent = host.host.createChannel(space.space, 'general')
  for (const p of [a, b, c]) {
    trust(host, p)
    host.host.postMeta(space.space, 'member.joined', {
      member: {
        user: peer(p).user,
        rootKey: p.keys.rootKey()!,
        role: 'member',
        displayName: peer(p).delegation.name
      }
    })
  }
  const reader = host.store.openSnapshot(space.meta),
    records = reader.next(1024 * 1024, 64).records
  reader.close()
  for (const p of [a, b, c]) {
    for (const q of [host, a, b, c]) trust(p, q)
    p.store.createStream(host.store.getStream(space.meta)!, 1)
    const stage = p.store.beginSnapshot(space.meta, host.store.head(space.meta))
    stage.append(records)
    stage.commit()
    p.store.createStream(host.store.getStream(parent)!, 1)
  }
  const services = [host, a, b, c].map(
    (p) =>
      new PrivateSpaceService({
        db: p.db,
        identity: p.identity,
        keys: p.keys,
        store: p.store,
        meta: p.projection,
        outbox: new SqliteOutbox(p.db),
        clock: p.clock,
        privateKeys: new SqlPrivateStreamKeys({
          database: p.db.database,
          keys: p.keys,
          node: peer(p).node,
          user: peer(p).user,
          spaceForStream: (id) => p.store.getStream(id)!.space!,
          transaction: (work) => p.db.transaction(work)
        })
      })
  )
  const authority = new SpaceHostService({
    db: host.db,
    identity: host.identity,
    keys: host.keys,
    store: host.store,
    projection: host.projection,
    limits: host.limits,
    blobs: host.blobs,
    routes: host.routes,
    clock: host.clock,
    privateAuthorization: services[0]
  })
  const tls = await channels(host, a),
    server = new NetSyncSession({
      channel: tls.server,
      identity: host.identity,
      store: host.store,
      authority,
      blobs: host.blobs,
      clock: host.clock
    }),
    client = new NetSyncSession({
      channel: tls.client,
      identity: a.identity,
      store: a.store,
      blobs: a.blobs,
      clock: a.clock,
      canReceive: () => true,
      verifyRecord: (record) =>
        a.identity.verifyAuthor(
          decodeEnvelope(record.envelope).envelope.author,
          record.envelope,
          record.sig,
          a.clock.now(),
          'history'
        )
    })
  disposers.push(
    () => client.close(),
    () => server.close()
  )
  await Promise.all([server.opened, client.opened])
  return { host, a, b, c, space, parent, services, authority, client }
}
describe('P5 private existing-wire bootstrap and staged activation', () => {
  it('reserves no private read scope on parent open, then atomically binds the signed initial controller and participant set over real TLS', async () => {
    const f = await setup(),
      [gate, controller, participant] = f.services,
      created = controller.prepareCreation(f.space.space, f.parent, [
        peer(f.a).user,
        peer(f.b).user
      ]),
      open = created.parentEvent
    const parentPosition = await f.client
      .append(f.parent, open.id, open.envelope, open.sig)
      .catch((e) => {
        throw new Error('parent append: ' + e.code)
      })
    expect(f.host.store.getStream(created.descriptor.id)).toBeUndefined()
    expect(gate.canRead(created.descriptor, peer(f.a))).toBe(false)
    const parentRecord = { ...open, ...parentPosition }
    f.a.store.applyFromAuthority(f.parent, [parentRecord])
    f.b.store.applyFromAuthority(f.parent, [parentRecord])
    const position = await f.client
        .append(created.descriptor.id, created.event.id, created.event.envelope, created.event.sig)
        .catch((e) => {
          throw new Error('control append: ' + e.code)
        }),
      record = { ...created.event, ...position }
    controller.applyStored(created.descriptor, record, 'live')
    f.a.store.applyFromAuthority(created.descriptor.id, [record])
    participant.acceptCreation({
      descriptor: f.host.store.getStream(created.descriptor.id)!,
      controllerEvent: record,
      parentOpenEvent: parentRecord
    })
    expect(gate.state(created.descriptor.id)?.controller).toBe(peer(f.a).user)
    expect(gate.canRead(created.descriptor, peer(f.b))).toBe(true)
    expect(gate.canRead(created.descriptor, peer(f.host))).toBe(false)
    const blob = controller.sealBlob(
      created.descriptor.id,
      Buffer.from('tls-private-attachment-canary')
    )
    await f.client.putBlob(created.descriptor.id, blob.id, blob.bytes, true)
    const event = controller.seal(
        created.descriptor.id,
        'message.posted',
        { text: 'tls-private-message-canary' },
        undefined,
        [{ id: blob.id, bytes: blob.bytes.length, mime: 'application/octet-stream', sealed: true }]
      ),
      stored = await f.client
        .append(created.descriptor.id, event.id, event.envelope, event.sig)
        .catch((e) => {
          throw new Error('content append: ' + e.code)
        }),
      cipher = f.host.store.getById(created.descriptor.id, event.id)!
    expect(Buffer.from(cipher.envelope).toString()).not.toContain('tls-private-message-canary')
    expect(participant.open(created.descriptor.id, { ...event, ...stored })).toEqual({
      text: 'tls-private-message-canary'
    })
    expect(() => gate.open(created.descriptor.id, cipher)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(Buffer.from(f.host.blobs.read(blob.id, 0, blob.bytes.length))).not.toContain(
      Buffer.from('tls-private-attachment-canary')
    )
    const rotation = controller.rotate(created.descriptor.id, [peer(f.a).user]),
      next = await f.client
        .append(created.descriptor.id, rotation.id, rotation.envelope, rotation.sig)
        .catch((e) => {
          throw new Error('rotation append: ' + e.code)
        })
    controller.applyStored(created.descriptor, { ...rotation, ...next }, 'live')
    expect(f.authority.canRead(created.descriptor.id, peer(f.b))).toBe(false)
    expect(f.authority.canFetchBlob(created.descriptor.id, blob.id, peer(f.b))).toBe(false)
  })
  it('bootstraps a participant added after creation only from the complete signed control chain, exposing no earlier plaintext', async () => {
    const f = await setup(),
      controller = f.services[1],
      added = f.services[3],
      created = controller.prepareCreation(f.space.space, f.parent, [
        peer(f.a).user,
        peer(f.b).user
      ])
    controller.options.publishParentOpen = (entry) =>
      f.client.append(entry.stream, entry.id, entry.envelope, entry.sig)
    controller.options.publishCreation = (_descriptor, entry) =>
      f.client.append(created.descriptor.id, entry.id, entry.envelope, entry.sig)
    await controller.publishCreation(created.descriptor.id)
    const parent = f.host.store.getById(f.parent, created.parentEvent.id)!,
      first = f.host.store.getById(created.descriptor.id, created.event.id)!
    f.c.store.applyFromAuthority(f.parent, [parent])
    const old = controller.seal(created.descriptor.id, 'message.posted', {
        text: 'before addition'
      }),
      oldPosition = await f.client.append(created.descriptor.id, old.id, old.envelope, old.sig),
      rotation = controller.rotate(created.descriptor.id, [
        peer(f.a).user,
        peer(f.b).user,
        peer(f.c).user
      ]),
      position = await f.client.append(
        created.descriptor.id,
        rotation.id,
        rotation.envelope,
        rotation.sig
      )
    controller.applyStored(created.descriptor, { ...rotation, ...position }, 'live')
    expect(() =>
      added.acceptBootstrap({
        descriptor: created.descriptor,
        parentOpenEvent: parent,
        controllerEvents: [first]
      })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(f.c.store.getStream(created.descriptor.id)).toBeUndefined()
    const corrupted = { ...rotation, ...position, sig: Uint8Array.from(rotation.sig) }
    corrupted.sig[0] ^= 1
    expect(() =>
      added.acceptBootstrap({
        descriptor: created.descriptor,
        parentOpenEvent: parent,
        controllerEvents: [first, corrupted]
      })
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }))
    expect(added.state(created.descriptor.id)).toBeUndefined()
    added.acceptBootstrap({
      descriptor: created.descriptor,
      parentOpenEvent: parent,
      controllerEvents: [first, { ...rotation, ...position }]
    })
    expect(added.canRead(created.descriptor, peer(f.c))).toBe(true)
    expect(added.state(created.descriptor.id)?.control).toMatchObject({
      keyEpoch: 2,
      visibilityEpoch: 2
    })
    expect(() => added.open(created.descriptor.id, { ...old, ...oldPosition })).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    const current = controller.seal(created.descriptor.id, 'message.posted', {
      text: 'after addition'
    })
    expect(
      added.open(created.descriptor.id, { ...current, epoch: 1, seq: 4, recvTs: f.a.clock.now() })
    ).toEqual({ text: 'after addition' })
  })
  for (const mode of ['snapshot-before', 'snapshot-after'])
    it(`SIGKILL ${mode} leaves private state, adopted controls and cursor atomic`, async () => {
      const f = await setup(),
        [gate, controller] = f.services,
        created = controller.prepareCreation(f.space.space, f.parent, [
          peer(f.a).user,
          peer(f.b).user
        ]),
        first = { ...created.event, epoch: 1, seq: 1, recvTs: f.a.clock.now() }
      f.host.store.createStream(created.descriptor, 1)
      gate.applyStored(created.descriptor, first, 'live')
      controller.applyStored(created.descriptor, first, 'live')
      f.host.store.appendAsAuthority(created.descriptor.id, {
        ...created.event,
        recvTs: first.recvTs
      })
      const event = controller.seal(created.descriptor.id, 'message.posted', {
        text: 'process-private-canary'
      })
      f.host.store.appendAsAuthority(created.descriptor.id, { ...event, recvTs: first.recvTs })
      const rotation = controller.rotate(created.descriptor.id, [peer(f.a).user, peer(f.b).user]),
        last = { ...rotation, epoch: 1, seq: 3, recvTs: first.recvTs }
      gate.applyStored(created.descriptor, last, 'live')
      f.host.store.appendAsAuthority(created.descriptor.id, { ...rotation, recvTs: first.recvTs })
      f.b.store.createStream(created.descriptor, 1)
      const reader = f.host.store.openSnapshot(created.descriptor.id),
        records = reader.next(1024 * 1024, 64).records
      reader.close()
      const executable = join(f.b.path, 'private-crash-child.cjs'),
        input = join(f.b.path, 'private-crash-input.json')
      buildSync({
        entryPoints: [fileURLToPath(new URL('./crash-child.ts', import.meta.url))],
        outfile: executable,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        logLevel: 'silent'
      })
      writeFileSync(
        input,
        JSON.stringify({
          now: f.a.clock.now(),
          descriptor: created.descriptor,
          target: f.host.store.head(created.descriptor.id),
          records: records.map((r) => ({
            ...r,
            envelope: Buffer.from(r.envelope).toString('base64url'),
            sig: Buffer.from(r.sig).toString('base64url')
          }))
        })
      )
      f.b.store.close()
      f.b.db.close()
      const child = spawn(process.execPath, [executable, f.b.path, mode, input], {
          stdio: ['ignore', 'pipe', 'pipe']
        }),
        exit = once(child, 'exit')
      disposers.push(async () => {
        child.kill('SIGKILL')
        await exit
      })
      const [code, signal] = await exit
      expect(code).toBeNull()
      expect(signal).toBe('SIGKILL')
      const reopened = await profile(f.a.clock, 'Participant', f.b.path),
        privateService = new PrivateSpaceService({
          db: reopened.db,
          identity: reopened.identity,
          keys: reopened.keys,
          store: reopened.store,
          meta: reopened.projection,
          outbox: new SqliteOutbox(reopened.db),
          clock: reopened.clock,
          privateKeys: new SqlPrivateStreamKeys({
            database: reopened.db.database,
            keys: reopened.keys,
            node: peer(reopened).node,
            user: peer(reopened).user,
            spaceForStream: () => f.space.space,
            transaction: (work) => reopened.db.transaction(work)
          })
        })
      expect(reopened.store.cursor(created.descriptor.id).seq).toBe(
        mode === 'snapshot-after' ? 3 : 0
      )
      expect(privateService.state(created.descriptor.id)?.control.keyEpoch).toBe(
        mode === 'snapshot-after' ? 2 : undefined
      )
      expect(
        reopened.db.database.prepare('SELECT count(*) AS n FROM net_space_private_snapshot').get()!
          .n
      ).toBe(0)
      if (mode === 'snapshot-after')
        expect(privateService.open(created.descriptor.id, records[1])).toEqual({
          text: 'process-private-canary'
        })
      else
        expect(() => privateService.open(created.descriptor.id, records[1])).toThrow(
          expect.objectContaining({ code: 'forbidden' })
        )
    }, 10000)
  for (const mode of ['prepare-before', 'prepare-after'])
    it(`SIGKILL ${mode} retains only the committed exact creation journal`, async () => {
      const f = await setup(),
        executable = join(f.a.path, 'private-prepare-child.cjs'),
        input = join(f.a.path, 'private-prepare-input.json')
      buildSync({
        entryPoints: [fileURLToPath(new URL('./crash-child.ts', import.meta.url))],
        outfile: executable,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        logLevel: 'silent'
      })
      writeFileSync(
        input,
        JSON.stringify({
          now: f.a.clock.now(),
          space: f.space.space,
          parent: f.parent,
          participants: [peer(f.a).user, peer(f.b).user]
        })
      )
      f.client.close()
      f.a.store.close()
      f.a.db.close()
      const child = spawn(process.execPath, [executable, f.a.path, mode, input], {
          stdio: ['ignore', 'pipe', 'pipe']
        }),
        exit = once(child, 'exit')
      disposers.push(async () => {
        child.kill('SIGKILL')
        await exit
      })
      const [code, signal] = await exit
      expect(code).toBeNull()
      expect(signal).toBe('SIGKILL')
      const reopened = await profile(f.host.clock, 'Controller', f.a.path),
        outbox = new SqliteOutbox(reopened.db)
      expect(
        reopened.db.database.prepare('SELECT count(*) AS n FROM net_space_private_prepared').get()!
          .n
      ).toBe(mode === 'prepare-after' ? 1 : 0)
      expect(reopened.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n).toBe(
        mode === 'prepare-after' ? 2 : 0
      )
      if (mode === 'prepare-after') {
        const result = JSON.parse(readFileSync(input + '.result', 'utf8'))
        for (const event of [result.event, result.parentEvent])
          expect(Buffer.from(outbox.get(event.id)!.envelope).toString('base64url')).toBe(
            event.envelope
          )
        expect(
          reopened.db.database.prepare('SELECT adopted FROM net_private_control').get()!.adopted
        ).toBe(0)
      }
    }, 10000)
  it('keeps staged control/key history invisible and rolls back final activation together with its cursor', async () => {
    const f = await setup(),
      [gate, controller, participant] = f.services,
      created = controller.prepareCreation(f.space.space, f.parent, [
        peer(f.a).user,
        peer(f.b).user
      ]),
      first = { ...created.event, epoch: 1, seq: 1, recvTs: f.host.clock.now() }
    f.host.store.createStream(created.descriptor, 1)
    gate.applyStored(created.descriptor, first, 'live')
    controller.applyStored(created.descriptor, first, 'live')
    f.host.store.appendAsAuthority(created.descriptor.id, {
      ...created.event,
      recvTs: first.recvTs
    })
    const old = controller.seal(created.descriptor.id, 'message.posted', {
      text: 'retained-old-key'
    })
    f.host.store.appendAsAuthority(created.descriptor.id, { ...old, recvTs: first.recvTs })
    const rotate = controller.rotate(created.descriptor.id, [peer(f.a).user, peer(f.b).user]),
      second = { ...rotate, epoch: 1, seq: 3, recvTs: first.recvTs }
    gate.applyStored(created.descriptor, second, 'live')
    controller.applyStored(created.descriptor, second, 'live')
    f.host.store.appendAsAuthority(created.descriptor.id, { ...rotate, recvTs: first.recvTs })
    const store = new SqliteStreamStore(f.b.db, participant)
    store.createStream(created.descriptor, 1)
    const reader = f.host.store.openSnapshot(created.descriptor.id),
      records = reader.next(1024 * 1024, 64).records
    reader.close()
    const target = f.host.store.head(created.descriptor.id),
      stage = store.beginSnapshot(created.descriptor.id, target)
    stage.append(records)
    expect(participant.state(created.descriptor.id)).toBeUndefined()
    expect(() => participant.open(created.descriptor.id, records[1])).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    stage.abort()
    expect(store.cursor(created.descriptor.id).seq).toBe(0)
    const next = store.beginSnapshot(created.descriptor.id, target)
    next.append(records)
    next.commit()
    expect(store.cursor(created.descriptor.id).seq).toBe(3)
    expect(participant.state(created.descriptor.id)?.control.keyEpoch).toBe(2)
    expect(participant.open(created.descriptor.id, records[1])).toEqual({
      text: 'retained-old-key'
    })
    const failingStore = new SqliteStreamStore(f.b.db, {
        supports: (d) => participant.supports(d),
        maxRecordsPerAppend: 64,
        append: (...args) => participant.append(...args),
        finish(...args) {
          participant.finish(...args)
          throw new NetError('cancelled')
        }
      }),
      rollback = failingStore.beginSnapshot(created.descriptor.id, target)
    rollback.append(records)
    expect(() => rollback.commit()).toThrow(expect.objectContaining({ code: 'cancelled' }))
    expect(participant.state(created.descriptor.id)?.control.keyEpoch).toBe(2)
    expect(store.cursor(created.descriptor.id).seq).toBe(3)
  })
})
