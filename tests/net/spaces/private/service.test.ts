import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileKeyStore,
  NetIdentityService,
  SqlPrivateStreamKeys
} from '../../../../src/mms/net/identity'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteStreamStore } from '../../../../src/mms/net/store/streams'
import { EnrollmentService } from '../../../../src/mms/net/enrollment/service'
import { SqliteOutbox } from '../../../../src/mms/net/store/outbox'
import { PrivateSpaceService } from '../../../../src/mms/spaces/private'
import { decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import {
  profile,
  peer,
  trust,
  signed,
  cleanup,
  channels,
  disposers,
  type Profile
} from '../host/helpers'
import { signedDocument } from '../../../../src/mms/net/identity/crypto'
import fixture from '../../../../test-vectors/net/security/private-key-decisions.json'
import { NetError, newId, DEFAULT_NODE_CAPABILITIES } from '../../../../src/shared/net'
afterEach(cleanup)
async function setup() {
  const host = await profile(),
    a = await profile(host.clock, 'Controller'),
    b = await profile(host.clock, 'Participant'),
    c = await profile(host.clock, 'Other'),
    space = host.host.create({ name: 'Private' }),
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
  const created = services[1].prepareCreation(space.space, parent, [peer(a).user, peer(b).user]),
    descriptor = created.descriptor
  for (const p of [host, b, c]) p.store.createStream(descriptor, 1)
  const record = { ...created.event, epoch: 1, seq: 1, recvTs: host.clock.now() }
  for (let i = 0; i < services.length; i++) services[i].applyStored(descriptor, record, 'live')
  return { host, a, b, c, space, parent, services, descriptor }
}
describe('P5 private signed-controller domain gate', () => {
  it.each(fixture.cases)('frozen signed private decision: $id', async (row) => {
    const f = await setup(),
      [gate, controller] = f.services,
      participants = row.input.participantsAfter.map(
        (p) => peer(p === 'A' ? f.a : p === 'B' ? f.b : f.c).user
      )
    if (!row.input.nonceStateTrusted) {
      controller.seal(f.descriptor.id, 'message.posted', { text: 'reserve' })
      f.a.db.database
        .prepare('UPDATE net_private_nonce SET counter=? WHERE stream=?')
        .run('0', f.descriptor.id)
      expect(() => controller.seal(f.descriptor.id, 'message.posted', { text: 'reuse' })).toThrow(
        expect.objectContaining({ code: row.expected.code })
      )
      return
    }
    const event = controller.rotate(f.descriptor.id, participants),
      env = decodeEnvelope(event.envelope).envelope,
      body = structuredClone(env.body as any)
    body.keyEpoch = row.input.keyEpochAfter
    body.visibilityEpoch = row.input.visibilityEpochAfter
    if (!row.input.writerPrefixesUnique) body.writers[1].noncePrefix = body.writers[0].noncePrefix
    if (!row.input.recipientAgreementKeysMatch)
      body.wrapped.find((w: any) => w.node === peer(f.b).node).recipientAgreementKey =
        f.a.keys.nodeKeys().agree
    if (row.input.revokedRecipients.length) {
      const oldNode = peer(f.b).node,
        replacement = newId('node')
      f.b.identity.issueNodeDelegation({
        node: replacement,
        keys: f.c.keys.nodeKeys(),
        name: 'Root-signed successor',
        caps: [...DEFAULT_NODE_CAPABILITIES]
      })
      const roster = f.b.identity.verifySigned<any>(f.b.identity.roster()!, f.b.keys.rootKey()!)
      roster.version++
      roster.authorityNode = replacement
      roster.revoked.push({ subject: oldNode, throughKeyEpoch: 1, revokedAt: f.b.clock.now() })
      f.host.identity.acceptRoster(
        signedDocument(roster, (bytes) => f.b.keys.signAsRoot(bytes)),
        f.b.keys.rootKey()!
      )
    }
    const signedEvent = signed(
      row.input.authorIsController ? f.a : f.b,
      f.descriptor.id,
      'participants.changed',
      body,
      env.auth
    )
    if (!row.input.controllerSignatureValid) signedEvent.sig[0] ^= 1
    if (row.expected.decision === 'allow') {
      expect(() =>
        gate.validateControl(f.descriptor, signedEvent.envelope, signedEvent.sig)
      ).not.toThrow()
      const before = gate.state(f.descriptor.id)!.control
      gate.applyStored(f.descriptor, { ...signedEvent, epoch: 1, seq: 2 }, 'live')
      expect(gate.state(f.descriptor.id)!.control.visibilityEpoch !== before.visibilityEpoch).toBe(
        row.expected.compartmentReset
      )
    } else
      expect(() =>
        gate.validateControl(f.descriptor, signedEvent.envelope, signedEvent.sig)
      ).toThrow(expect.objectContaining({ code: row.expected.code }))
  })
  it('burns a durably reserved nonce when outbox journaling fails, and the next output uses the next counter', async () => {
    const f = await setup(),
      controller = f.services[1]
    const first = controller.seal(f.descriptor.id, 'message.posted', { text: 'one' })
    vi.spyOn(controller.options.outbox, 'enqueue').mockImplementationOnce(() => {
      throw new NetError('cancelled')
    })
    expect(() =>
      controller.seal(f.descriptor.id, 'message.posted', { text: 'lost before send' })
    ).toThrow(expect.objectContaining({ code: 'cancelled' }))
    const next = controller.seal(f.descriptor.id, 'message.posted', { text: 'next' }),
      nonce = (event: typeof first) =>
        Buffer.from(
          decodeEnvelope(event.envelope).envelope.sealed!.nonce,
          'base64url'
        ).readBigUInt64BE(4)
    expect(nonce(first)).toBe(1n)
    expect(nonce(next)).toBe(3n)
  })
  it('rewraps the current key to a newly enrolled node of the same participant without changing audience, and denies outsider/removed nodes', async () => {
    const f = await setup(),
      controller = f.services[1]
    f.a.clock.advance(1)
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-private-follower-'))),
      db = new NetDatabase({ profileDir: path, clock: f.a.clock }),
      keys = new FileKeyStore(path, { passphrase: 'private-follower-master' }),
      identity = new NetIdentityService({
        database: db.database,
        keys,
        clock: f.a.clock,
        coordinator: db
      }),
      store = new SqliteStreamStore(db),
      follower = { path, db, keys, identity, store, clock: f.a.clock } as Profile
    disposers.push(
      () => rmSync(path, { recursive: true, force: true }),
      () => db.close(),
      () => store.close()
    )
    const enrollment = new EnrollmentService({
        db: f.a.db,
        identity: f.a.identity,
        keys: f.a.keys,
        clock: f.a.clock,
        routes: f.a.routes
      }),
      joiner = new EnrollmentService({
        db,
        identity,
        keys,
        clock: f.a.clock,
        routes: () => {
          throw new Error('unused joiner routes')
        }
      })
    const prepared = await joiner.prepareNodeJoin(
        enrollment.issueNodeInvite({ name: 'New current node' }).text
      ),
      tls = await channels(f.a, follower)
    joiner.acceptNodeJoin(
      enrollment.redeemNode(joiner.nodeJoinRequest(tls.client), tls.server),
      tls.client
    )
    expect(identity.self()?.user).toBe(peer(f.a).user)
    expect(identity.self()?.node).toBe(prepared.node)
    for (const p of [f.host, f.b, f.c]) trust(p, f.a)
    for (const q of [f.host, f.a, f.b, f.c]) trust(follower, q)
    const reader = f.host.store.openSnapshot(f.space.meta),
      records = reader.next(1024 * 1024, 64).records
    reader.close()
    let followerPrivate: PrivateSpaceService
    const followerMeta = new (
        f.a.projection
          .constructor as typeof import('../../../../src/mms/spaces/host').MetaProjection
      )({ db, identity, store, activatePins: (roots) => identity.pinUsers(roots) }),
      snapshotStore = new SqliteStreamStore(db, followerMeta)
    snapshotStore.createStream(f.host.store.getStream(f.space.meta)!, 1)
    const stage = snapshotStore.beginSnapshot(f.space.meta, f.host.store.head(f.space.meta))
    stage.append(records)
    stage.commit()
    store.createStream(f.descriptor, 1)
    followerPrivate = new PrivateSpaceService({
      db,
      identity,
      keys,
      store,
      meta: followerMeta,
      outbox: new SqliteOutbox(db),
      clock: f.a.clock,
      privateKeys: new SqlPrivateStreamKeys({
        database: db.database,
        keys,
        node: prepared.node,
        user: prepared.user,
        spaceForStream: () => f.space.space,
        transaction: (work) => db.transaction(work)
      })
    })
    const control = controller.rewrap(f.descriptor.id, prepared.node),
      record = { ...control, epoch: 1, seq: 2, recvTs: f.a.clock.now() }
    for (const service of f.services) service.applyStored(f.descriptor, record, 'live')
    followerPrivate.applyStored(f.descriptor, record, 'live')
    expect(followerPrivate.state(f.descriptor.id)?.control).toMatchObject({
      keyEpoch: 1,
      visibilityEpoch: 1
    })
    const event = controller.seal(f.descriptor.id, 'message.posted', {
      text: 'same participant history'
    })
    expect(
      followerPrivate.open(f.descriptor.id, { ...event, epoch: 1, seq: 3, recvTs: f.a.clock.now() })
    ).toEqual({ text: 'same participant history' })
    expect(() => controller.rewrap(f.descriptor.id, peer(f.c).node)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    f.a.identity.revoke(prepared.node)
    expect(() =>
      controller.seal(f.descriptor.id, 'message.posted', { text: 'revoked writer' })
    ).toThrow(expect.objectContaining({ code: 'revoked' }))
  })
  it('requires exact in-stream reference subjects and skips signed future noncritical ciphertext interpretation', async () => {
    const f = await setup(),
      controller = f.services[1]
    expect(() =>
      controller.seal(
        f.descriptor.id,
        'message.edited',
        { text: 'cross audience' },
        { subject: newId('event') }
      )
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
    const future = signed(
      f.a,
      f.descriptor.id,
      'reaction.future',
      {},
      { metaEpoch: 1, metaSeq: 5 },
      { minor: 1, crit: false }
    )
    expect(controller.open(f.descriptor.id, { ...future, epoch: 1, seq: 2 })).toBeUndefined()
    expect(controller.state(f.descriptor.id)?.blocked).toBe(false)
    const changed = vi.fn()
    controller.options.onControlChanged = changed
    const critical = signed(
      f.a,
      f.descriptor.id,
      'private.futureRule',
      {},
      { metaEpoch: 1, metaSeq: 5 },
      { minor: 1, crit: true }
    )
    expect(controller.open(f.descriptor.id, { ...critical, epoch: 1, seq: 3 })).toBeUndefined()
    expect(controller.state(f.descriptor.id)?.blocked).toBe(true)
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: false }),
      expect.objectContaining({ blocked: true })
    )
  })
  it('stores ciphertext on a nonparticipant host, decrypts only for authorized participants, and binds every metadata/blob field', async () => {
    const { host, a, b, c, services, descriptor } = await setup(),
      [hostPrivate, controller, participant, outsider] = services
    const event = controller.seal(descriptor.id, 'message.posted', {
        text: 'private-message-canary'
      }),
      record = { ...event, epoch: 1, seq: 2, recvTs: a.clock.now() }
    expect(Buffer.from(event.envelope).toString()).not.toContain('private-message-canary')
    expect(controller.open(descriptor.id, record)).toEqual({ text: 'private-message-canary' })
    expect(participant.open(descriptor.id, record)).toEqual({ text: 'private-message-canary' })
    expect(() => hostPrivate.open(descriptor.id, record)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(() => outsider.open(descriptor.id, record)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    expect(hostPrivate.canRead(descriptor, peer(a))).toBe(true)
    expect(hostPrivate.canRead(descriptor, peer(c))).toBe(false)
    const blob = controller.sealBlob(descriptor.id, Buffer.from('private-attachment-canary')),
      withBlob = controller.seal(
        descriptor.id,
        'message.posted',
        { text: 'attachment' },
        undefined,
        [{ id: blob.id, bytes: blob.bytes.length, mime: 'application/octet-stream', sealed: true }]
      ),
      blobRecord = { ...withBlob, epoch: 1, seq: 3, recvTs: a.clock.now() }
    expect(Buffer.from(blob.bytes).toString()).not.toContain('private-attachment-canary')
    expect(
      Buffer.from(participant.openBlob(descriptor.id, blobRecord, blob.id, blob.bytes)).toString()
    ).toBe('private-attachment-canary')
    expect(() => participant.openBlob(descriptor.id, record, blob.id, blob.bytes)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
  })
  it('requires controller signature, exact epochs, current agreement-key binding and unique writer prefixes', async () => {
    const { a, b, services, descriptor } = await setup(),
      controller = services[1],
      gate = services[0],
      first = controller.state(descriptor.id)!.control,
      event = controller.rotate(descriptor.id, [peer(a).user, peer(b).user]),
      valid = decodeEnvelope(event.envelope).envelope
    expect(() => gate.validateControl(descriptor, event.envelope, event.sig)).not.toThrow()
    const invalid = signed(b, descriptor.id, 'participants.changed', valid.body, valid.auth)
    expect(() => gate.validateControl(descriptor, invalid.envelope, invalid.sig)).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    const body = structuredClone(valid.body as any)
    body.visibilityEpoch = 2
    const wrong = signed(a, descriptor.id, 'participants.changed', body, valid.auth)
    expect(() => gate.validateControl(descriptor, wrong.envelope, wrong.sig)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    const prefixes = structuredClone(valid.body as any)
    prefixes.writers[1].noncePrefix = prefixes.writers[0].noncePrefix
    const dup = signed(a, descriptor.id, 'participants.changed', prefixes, valid.auth)
    expect(() => gate.validateControl(descriptor, dup.envelope, dup.sig)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    const keys = structuredClone(valid.body as any)
    keys.wrapped.find((w: any) => w.node === peer(b).node).recipientAgreementKey =
      a.keys.nodeKeys().agree
    const swapped = signed(a, descriptor.id, 'participants.changed', keys, valid.auth)
    expect(() => gate.validateControl(descriptor, swapped.envelope, swapped.sig)).toThrow(
      expect.objectContaining({ code: 'bad_delegation' })
    )
    const forged = { ...event, sig: Uint8Array.from(event.sig) }
    forged.sig[0] ^= 1
    expect(() => gate.validateControl(descriptor, forged.envelope, forged.sig)).toThrow(
      expect.objectContaining({ code: 'bad_signature' })
    )
    expect(gate.state(descriptor.id)?.control).toEqual(first)
  })
  it('changes visibility only with audience changes; excluded participants keep old local history and cannot read or decrypt new output', async () => {
    const { a, b, services, descriptor } = await setup(),
      [gate, controller, participant] = services,
      old = controller.seal(descriptor.id, 'message.posted', { text: 'old' }),
      oldRecord = { ...old, epoch: 1, seq: 2, recvTs: a.clock.now() },
      next = controller.rotate(descriptor.id, [peer(a).user]),
      record = { ...next, epoch: 1, seq: 3, recvTs: a.clock.now() }
    for (const service of services) service.applyStored(descriptor, record, 'live')
    expect(controller.state(descriptor.id)?.control).toMatchObject({
      keyEpoch: 2,
      visibilityEpoch: 2
    })
    expect(gate.canRead(descriptor, peer(b))).toBe(false)
    expect(participant.canUpload(descriptor, peer(b))).toBe(false)
    expect(participant.open(descriptor.id, oldRecord)).toEqual({ text: 'old' })
    expect(() => participant.seal(descriptor.id, 'message.posted', { text: 'forbidden' })).toThrow(
      expect.objectContaining({ code: 'forbidden' })
    )
    const current = controller.seal(descriptor.id, 'message.posted', { text: 'new' })
    expect(() =>
      participant.open(descriptor.id, { ...current, epoch: 1, seq: 4, recvTs: a.clock.now() })
    ).toThrow(expect.objectContaining({ code: 'forbidden' }))
  })
  it('blocks seal on restored counter rollback and recovers through a fresh key epoch without changing audience', async () => {
    const { a, b, services, descriptor } = await setup(),
      controller = services[1]
    controller.seal(descriptor.id, 'message.posted', { text: 'first' })
    a.db.database
      .prepare('UPDATE net_private_nonce SET counter=? WHERE stream=?')
      .run('0', descriptor.id)
    expect(() => controller.seal(descriptor.id, 'message.posted', { text: 'unsafe' })).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    const rotation = controller.rotate(descriptor.id, [peer(a).user, peer(b).user])
    for (const service of services)
      service.applyStored(
        descriptor,
        { ...rotation, epoch: 1, seq: 3, recvTs: a.clock.now() },
        'live'
      )
    expect(controller.state(descriptor.id)?.control).toMatchObject({
      keyEpoch: 2,
      visibilityEpoch: 1
    })
    expect(
      decodeEnvelope(controller.seal(descriptor.id, 'message.posted', { text: 'safe' }).envelope)
        .envelope.sealed?.keyEpoch
    ).toBe(2)
  })
})
