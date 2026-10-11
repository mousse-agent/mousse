import { createCipheriv, createDecipheriv } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalJson, decodeEnvelope } from '../../../../src/mms/net/sync/codec'
import { SubscriptionReceiver } from '../../../../src/mms/net/sync/subscription'
import { privateContentAAD } from '../../../../src/mms/spaces/private/service'
import {
  DEFAULT_NODE_CAPABILITIES,
  newId,
  type Envelope,
  type StoredRecord
} from '../../../../src/shared/net'
import { cleanup, profile } from '../discovery/profile'

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function setup(subscribe = true, discoverRecipient = true) {
  const host = profile(),
    recipient = profile(),
    participant = profile()
  for (const p of [host, recipient, participant]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'private-replica-test' })
  }
  const space = host.spaces.host.create({ name: 'Position-aware private replica' }),
    channel = host.spaces.host.createChannel(space.space, 'general')
  for (const p of [recipient, participant]) {
    await p.spaces.client.join(
      p.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
    )
    await p.spaces.client.connect(space.space)
  }
  const audience = [host, recipient, participant].map((p) => p.net.runtime().identity.self()!.user),
    created = host.spaces.private.prepareCreation(space.space, channel, audience)
  await host.spaces.private.publishCreation(created.descriptor.id)
  for (const p of [recipient, participant]) {
    await p.spaces.client.subscribe(channel)
    if (p !== recipient || discoverRecipient)
      await p.spaces.discover(space.space, created.descriptor.id)
  }
  if (subscribe) await recipient.spaces.client.subscribe(created.descriptor.id)
  return { host, recipient, participant, space, created, audience }
}

function sealed(p: ReturnType<typeof profile>, stream: Envelope['stream'], text: string) {
  const self = p.net.runtime().identity.self()!,
    meta = p.spaces.meta.position(p.spaces.store.getStream(stream)!.space!)!,
    envelope: Envelope = {
      v: 1,
      minor: 0,
      id: newId('event'),
      stream,
      type: 'message.posted',
      crit: false,
      author: { user: self.user, node: self.node, keyEpoch: 1 },
      ts: Date.now(),
      auth: { metaEpoch: meta.epoch, metaSeq: meta.seq }
    }
  envelope.sealed = p.spaces.private.options.privateKeys.seal(
    stream,
    canonicalJson({ text }),
    privateContentAAD(envelope)
  )
  const bytes = canonicalJson(envelope)
  return { id: envelope.id, envelope: bytes, sig: p.net.runtime().keys.signAsNode(bytes) }
}

async function maliciousDelivery(
  f: Awaited<ReturnType<typeof setup>>,
  event: ReturnType<typeof sealed>
) {
  const stream = f.created.descriptor.id,
    before = f.recipient.spaces.store.cursor(stream),
    session = f.recipient.spaces.session(f.space.space)!,
    closed: Error[] = []
  session.onClosed((error) => {
    if (error) closed.push(error)
  })
  // The malicious host bypasses its private append gate, but uses the real authenticated delivery.
  const position = f.host.spaces.store.appendAsAuthority(stream, { ...event, recvTs: Date.now() })
  await f.host.net.publish(stream, { ...event, ...position })
  await vi.waitFor(() =>
    expect(closed.length > 0 || !!f.recipient.spaces.store.getById(stream, event.id)).toBe(true)
  )
  expect(f.recipient.spaces.store.getById(stream, event.id)).toBeUndefined()
  expect(f.recipient.spaces.store.cursor(stream)).toEqual(before)
  expect(closed[0]).toMatchObject({ code: 'forbidden' })
}

it.each(['live', 'replay', 'snapshot'] as const)(
  'rejects a freshly signed old-key event delivered by a malicious host after participant removal through %s',
  async (mode) => {
    const f = await setup(),
      stream = f.created.descriptor.id
    f.participant.spaces.client.disconnect(f.space.space)
    const rotation = f.host.spaces.private.rotate(stream, f.audience.slice(0, 2))
    await f.host.spaces.flush(f.space.space)
    await vi.waitFor(() =>
      expect(f.recipient.spaces.private.state(stream)?.control.keyEpoch).toBe(2)
    )
    expect(f.recipient.spaces.store.getById(stream, rotation.id)).toBeDefined()
    const attack = sealed(f.participant, stream, 'Fresh forbidden old-key message')
    expect(decodeEnvelope(attack.envelope).envelope.sealed?.keyEpoch).toBe(1)
    expect(
      f.recipient.spaces.private.open(stream, { ...attack, epoch: 1, seq: 3, recvTs: Date.now() })
    ).toEqual({ text: 'Fresh forbidden old-key message' })
    if (mode === 'live') {
      await maliciousDelivery(f, attack)
    } else {
      const before = f.recipient.spaces.store.cursor(stream)
      f.recipient.spaces.client.disconnect(f.space.space)
      f.host.spaces.store.appendAsAuthority(stream, { ...attack, recvTs: Date.now() })
      if (mode === 'snapshot')
        f.host.net
          .runtime()
          .db.database.prepare('UPDATE net_streams SET retained=head WHERE id=?')
          .run(stream)
      await f.recipient.spaces.client.connect(f.space.space)
      const snapshot = vi.spyOn(f.recipient.spaces.store, 'beginSnapshot')
      await expect(f.recipient.spaces.client.subscribe(stream)).rejects.toMatchObject({
        code: 'forbidden'
      })
      expect(snapshot.mock.calls.length > 0).toBe(mode === 'snapshot')
      expect(f.recipient.spaces.store.getById(stream, attack.id)).toBeUndefined()
      expect(f.recipient.spaces.store.cursor(stream)).toEqual(before)
    }
  },
  20000
)

it.each(['replay', 'snapshot'] as const)(
  'keeps pre-removal history readable through %s after adopting the later control',
  async (mode) => {
    const f = await setup(false, false),
      stream = f.created.descriptor.id,
      old = sealed(f.participant, stream, 'Legitimate pre-removal history')
    await f.participant.spaces.session(f.space.space)!.append(stream, old.id, old.envelope, old.sig)
    f.host.spaces.private.rotate(stream, f.audience.slice(0, 2))
    await f.host.spaces.flush(f.space.space)
    // Discovery adopts the current control before replaying earlier ciphertext.
    await f.recipient.spaces.discover(f.space.space, stream)
    expect(f.recipient.spaces.private.state(stream)?.control.keyEpoch).toBe(2)
    if (mode === 'snapshot') {
      f.host.net
        .runtime()
        .db.database.prepare('UPDATE net_streams SET retained=head WHERE id=?')
        .run(stream)
    }
    const snapshot = vi.spyOn(f.recipient.spaces.store, 'beginSnapshot')
    await f.recipient.spaces.client.subscribe(stream)
    expect(snapshot.mock.calls.length > 0).toBe(mode === 'snapshot')
    expect(f.recipient.spaces.store.cursor(stream).seq).toBe(3)
    expect(
      f.recipient.spaces.private.open(stream, f.recipient.spaces.store.getById(stream, old.id)!)
    ).toEqual({ text: 'Legitimate pre-removal history' })
  },
  20000
)

it.each([false, true])(
  'validates a buffered record only once its preceding signed control is contiguous (attack=%s)',
  async (attack) => {
    const f = await setup(false),
      stream = f.created.descriptor.id,
      old = attack ? sealed(f.participant, stream, 'Buffered excluded writer') : undefined,
      rotation = f.host.spaces.private.rotate(stream, f.audience.slice(0, 2))
    await f.host.spaces.flush(f.space.space)
    const control = f.host.spaces.store.getById(stream, rotation.id)!,
      event = old ?? sealed(f.host, stream, 'Buffered current writer'),
      record: StoredRecord = { ...event, epoch: 1, seq: 3, recvTs: Date.now() },
      receiver = new SubscriptionReceiver(
        stream,
        f.recipient.spaces.store,
        { onRecord() {}, onCaughtUp() {}, onSnapshotInstalled() {}, onError() {} },
        (record, snapshot) =>
          f.recipient.spaces.client.verifyRecord(record, f.created.descriptor, snapshot),
        () => {}
      )
    receiver.subscribed({ epoch: 1, seq: 3 }, 3)
    receiver.receive([record])
    expect(f.recipient.spaces.store.cursor(stream).seq).toBe(1)
    expect(f.recipient.spaces.store.getById(stream, event.id)).toBeUndefined()
    if (attack) {
      expect(() => receiver.receive([control])).toThrow(
        expect.objectContaining({ code: 'forbidden' })
      )
      expect(f.recipient.spaces.store.cursor(stream).seq).toBe(2)
      expect(f.recipient.spaces.store.getById(stream, event.id)).toBeUndefined()
    } else {
      receiver.receive([control])
      expect(f.recipient.spaces.store.cursor(stream).seq).toBe(3)
      expect(f.recipient.spaces.private.open(stream, record)).toEqual({
        text: 'Buffered current writer'
      })
    }
  },
  20000
)

it.each(['nonce', 'node'] as const)(
  'rejects a current-key event with the wrong author %s incrementally',
  async (fault) => {
    const f = await setup(),
      stream = f.created.descriptor.id,
      valid = sealed(f.host, stream, 'Wrong writer'),
      envelope = decodeEnvelope(valid.envelope).envelope
    if (fault === 'nonce') {
      const nonce = Buffer.from(envelope.sealed!.nonce, 'base64url')
      nonce[0] ^= 255
      envelope.sealed!.nonce = nonce.toString('base64url')
    } else {
      // The participant user remains entitled, but this genuinely delegated node has no wrap/prefix.
      const rt = f.host.net.runtime(),
        node = newId('node')
      rt.identity.issueNodeDelegation({
        node,
        keys: rt.keys.nodeKeys(),
        name: 'Unassigned private writer node',
        caps: [...DEFAULT_NODE_CAPABILITIES]
      })
      await vi.waitFor(() =>
        expect(
          JSON.parse(
            Buffer.from(
              f.recipient.net.runtime().identity.roster(envelope.author.user)!.payload,
              'base64url'
            ).toString()
          ).nodes
        ).toHaveLength(2)
      )
      envelope.author.node = node
      envelope.ts = Date.now()
    }
    // Keep GCM valid even for the altered nonce/author: rejection must come from authorization.
    const key = f.host.net
        .runtime()
        .keys.getSecret(`private/${stream}/${envelope.sealed!.keyEpoch}`)!,
      cipher = createCipheriv('aes-256-gcm', key, Buffer.from(envelope.sealed!.nonce, 'base64url'))
    cipher.setAAD(privateContentAAD(envelope))
    envelope.sealed!.ct = Buffer.concat([
      cipher.update(canonicalJson({ text: 'Wrong writer' })),
      cipher.final(),
      cipher.getAuthTag()
    ]).toString('base64url')

    const bytes = canonicalJson(envelope),
      event = { id: envelope.id, envelope: bytes, sig: f.host.net.runtime().keys.signAsNode(bytes) }
    const encrypted = Buffer.from(envelope.sealed!.ct, 'base64url'),
      decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.sealed!.nonce, 'base64url')
      )
    decipher.setAAD(privateContentAAD(envelope))
    decipher.setAuthTag(encrypted.subarray(-16))
    expect(
      JSON.parse(
        Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString()
      )
    ).toEqual({ text: 'Wrong writer' })
    await maliciousDelivery(f, event)
  },
  20000
)

it.each(['incremental', 'snapshot'] as const)(
  'keeps bot owner decisions authorized through %s and rejects another entitled participant',
  async (mode) => {
    const f = await setup(),
      rt = f.host.net.runtime(),
      stream = f.created.descriptor.id,
      self = rt.identity.self()!,
      bot = newId('bot'),
      delegation = rt.identity.issueBotDelegation({
        bot,
        key: rt.keys.createBotKey(bot),
        name: 'Private permission owner',
        hostNode: self.node
      })
    f.host.spaces.host.postMeta(f.space.space, 'bot.added', {
      record: {
        bot,
        owner: self.user,
        delegation,
        displayName: 'Private permission owner',
        profile: 'chat',
        policy: { steer: { kind: 'everyone' }, visibility: 'private' }
      }
    })
    await vi.waitFor(() => expect(f.recipient.spaces.meta.bot(f.space.space, bot)).toBeDefined())
    f.host.spaces.private.rotate(stream, [...f.audience, bot])
    await f.host.spaces.flush(f.space.space)
    await vi.waitFor(() =>
      expect(f.recipient.spaces.private.state(stream)?.control.keyEpoch).toBe(2)
    )
    function permission(p: ReturnType<typeof profile>, request?: Envelope['id'], asBot = false) {
      const envelope = decodeEnvelope(sealed(p, stream, 'Permission').envelope).envelope
      envelope.type = request ? 'bot.permission.denied' : 'bot.permission.requested'
      if (request) envelope.refs = { subject: request }
      if (asBot) envelope.author = { bot, node: self.node, keyEpoch: 1 }
      envelope.sealed = p.spaces.private.options.privateKeys.seal(
        stream,
        canonicalJson(request ? { request } : { kind: 'steerPolicyChange' }),
        privateContentAAD(envelope)
      )
      const bytes = canonicalJson(envelope)
      return {
        id: envelope.id,
        envelope: bytes,
        sig: asBot ? rt.keys.signAsBot(bot, bytes) : p.net.runtime().keys.signAsNode(bytes)
      }
    }
    async function deliver(event: ReturnType<typeof sealed>) {
      const position = f.host.spaces.store.appendAsAuthority(stream, {
        ...event,
        recvTs: Date.now()
      })
      await f.host.net.publish(stream, { ...event, ...position })
      await vi.waitFor(() =>
        expect(f.recipient.spaces.store.getById(stream, event.id)).toBeDefined()
      )
    }
    const request = permission(f.host, undefined, true),
      ownerDecision = permission(f.host, request.id)
    await deliver(request)
    await deliver(ownerDecision)
    expect(
      f.recipient.spaces.private.open(
        stream,
        f.recipient.spaces.store.getById(stream, ownerDecision.id)!
      )
    ).toEqual({ request: request.id })
    if (mode === 'incremental') {
      await maliciousDelivery(f, permission(f.recipient, request.id))
    } else {
      const reader = f.host.spaces.store.openSnapshot(stream),
        records = reader.next(1024 * 1024, 64).records
      reader.close()
      expect(f.participant.spaces.store.getById(stream, request.id)).toBeUndefined()
      const accepted = f.participant.spaces.store.beginSnapshot(
        stream,
        f.host.spaces.store.head(stream)
      )
      accepted.append(records)
      accepted.commit()
      const before = f.participant.spaces.store.cursor(stream),
        invalid = permission(f.recipient, request.id),
        stage = f.participant.spaces.store.beginSnapshot(stream, { epoch: 1, seq: before.seq + 1 })
      expect(() =>
        stage.append([
          ...records,
          { ...invalid, epoch: 1, seq: before.seq + 1, recvTs: Date.now() }
        ])
      ).toThrow(expect.objectContaining({ code: 'forbidden' }))
      stage.abort()
      expect(f.participant.spaces.store.cursor(stream)).toEqual(before)
      expect(f.participant.spaces.store.getById(stream, invalid.id)).toBeUndefined()
    }
  },
  20000
)
