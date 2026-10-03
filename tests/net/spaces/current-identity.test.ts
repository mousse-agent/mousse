import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../src/mms/spaces/SpaceProfileService'
import { SpaceCurrentIdentity } from '../../../src/mms/spaces/SpaceCurrentIdentity'
import { spaceHistoryAuthor } from '../../../src/mms/spaces/historyIdentity'
import { BotPresenceReceiver } from '../../../src/mms/bots/presence/receiver'
import { canonicalJson, decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { signedDocument } from '../../../src/mms/net/identity/crypto'
import type { AdmissionInput } from '../../../src/mms/bots/admission'
import {
  newId,
  type NodeDelegation,
  type Roster,
  type PresenceMessage,
  type Signed
} from '../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function owner() {
  const path = mkdtempSync(join(tmpdir(), 'space-current-'))
  let spaces!: SpaceProfileService,
    current!: SpaceCurrentIdentity,
    elapsed = 0
  const clock = { ...systemClock, monotonic: () => systemClock.monotonic() + elapsed }
  const net = new NetService({
    profileDir: path,
    clock,
    composeRuntime: (runtime) => {
      spaces = new SpaceProfileService({ runtime, net, clock })
      current = new SpaceCurrentIdentity({
        runtime,
        store: spaces.store,
        meta: spaces.meta,
        host: spaces.host,
        session: (space) => spaces.session(space),
        retainHistoryRoster: (signed) => spaces.evidence.retain(signed)
      })
      const composition = spaces.composition(
        new NodeStreamAuthority(runtime.identity, spaces.store, runtime.blobs, clock)
      )
      return {
        ...composition,
        close: async () => {
          current.close()
          await composition.close?.()
        }
      }
    }
  })
  cleanup.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  await net.request('net.init', { listen: true })
  const space = spaces.host.create({ name: 'Scoped current proof' }),
    channel = spaces.host.createChannel(space.space, 'general'),
    bot = newId('bot')
  const id = spaces.client.post(channel, 'Original signed human', { mentions: [bot] })
  await spaces.flush(space.space)
  const record = spaces.store.getById(channel, id)!,
    envelope = decodeEnvelope(record.envelope).envelope,
    descriptor = spaces.store.getStream(channel)!
  const input: AdmissionInput = { stream: channel, bot, record, source: 'delivery' }
  return {
    net,
    spaces,
    current,
    space,
    input,
    envelope,
    descriptor,
    advance: (ms: number) => {
      elapsed += ms
    }
  }
}
async function protectedReplica() {
  const path = mkdtempSync(join(tmpdir(), 'space-current-tls-'))
  let spaces!: SpaceProfileService, current!: SpaceCurrentIdentity
  const net = new NetService({
    profileDir: path,
    composeRuntime: (runtime) => {
      spaces = new SpaceProfileService({
        runtime,
        net,
        currentPrivateRoster: (space, user) => current.currentPrivateRoster(space, user)
      })
      current = new SpaceCurrentIdentity({
        runtime,
        store: spaces.store,
        meta: spaces.meta,
        host: spaces.host,
        session: (space) => spaces.session(space),
        retainHistoryRoster: (signed) => spaces.evidence.retain(signed)
      })
      const composition = spaces.composition(
        new NodeStreamAuthority(runtime.identity, spaces.store, runtime.blobs, systemClock)
      )
      return {
        ...composition,
        session: { ...composition.session, spaceIdentity: current.source },
        close: async () => {
          current.close()
          await composition.close?.()
        }
      }
    }
  })
  cleanup.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  await net.request('net.init', { listen: true })
  await net.request('net.protect', { passphrase: 'current-private-test-protection' })
  return { net, spaces, current }
}

it('requires an explicit current request before verifying an exact real Host receipt and never changes profile identity', async () => {
  const f = await owner(),
    rt = f.net.runtime(),
    before = rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value
  expect(() => f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  await f.current.prepareAdmission(f.input)
  expect(f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toMatchObject({
    author: {
      kind: 'node',
      user: f.envelope.author.user,
      node: f.envelope.author.node,
      verifyOnly: false,
      revoked: false
    },
    rootKey: rt.keys.rootKey()
  })
  expect(rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
  const substituted = canonicalJson({
    ...f.envelope,
    body: { text: 'Different validly signed bytes' }
  })
  const record = { ...f.input.record, envelope: substituted, sig: rt.keys.signAsNode(substituted) }
  expect(() =>
    f.current.verifyMentionAuthor(
      { ...f.input, record },
      f.descriptor,
      decodeEnvelope(substituted).envelope
    )
  ).toThrow(expect.objectContaining({ code: 'forbidden' }))
  let pending!: Promise<void>
  rt.db.transaction(() => {
    pending = f.current.prepareAdmission(f.input)
  })
  await expect(pending).rejects.toMatchObject({ code: 'bad_request' })
})

it('does not turn durable scoped identity history into fresh authority after expiry, restart or a current meta change', async () => {
  const f = await owner()
  await f.current.prepareAdmission(f.input)
  f.advance(30000)
  expect(() => f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  await f.current.prepareAdmission(f.input)
  expect(f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope).author.verifyOnly).toBe(
    false
  )
  const restored = new SpaceCurrentIdentity(f.current.options)
  cleanup.push(() => restored.close())
  expect(() => restored.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  await restored.prepareAdmission(f.input)
  f.spaces.host.postMeta(f.space.space, 'channel.renamed', {
    stream: f.input.stream,
    name: 'Changed current meta'
  })
  expect(() => restored.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  await restored.prepareAdmission(f.input)
  expect(restored.verifyMentionAuthor(f.input, f.descriptor, f.envelope).author.revoked).toBe(false)
  expect(
    f.net
      .runtime()
      .db.database.prepare('SELECT count(*) AS n FROM net_space_current_identity')
      .get()!.n
  ).toBe(1)
})

it('retains a verified accepted display proof for 90 seconds without extending current packet authority', async () => {
  const f = await owner(),
    rt = f.net.runtime(),
    self = rt.identity.self()!,
    bot = f.input.bot
  const key = rt.keys.createBotKey(bot),
    delegation = rt.identity.issueBotDelegation({
      bot,
      key,
      name: 'Display proof',
      hostNode: self.node
    })
  f.spaces.host.postMeta(f.space.space, 'bot.added', {
    record: {
      bot,
      owner: self.user,
      delegation,
      displayName: 'Display proof',
      profile: 'chat',
      policy: { visibility: 'public', steer: { kind: 'everyone' } }
    }
  })
  const receiver = new BotPresenceReceiver({
    db: rt.db,
    identity: f.current.presenceIdentity(f.space.space),
    meta: f.spaces.meta,
    store: f.spaces.store
  })
  const roster = rt.identity.verifySigned<Roster>(rt.identity.roster()!, rt.keys.rootKey()!),
    node = roster.nodes
      .map((signed) => rt.identity.verifySigned<NodeDelegation>(signed, roster.rootKey))
      .find((node) => node.subject === self.node)!
  const unsigned = {
    t: 'presence' as const,
    stream: f.input.stream,
    subject: bot,
    counter: 1,
    ts: rt.db.clock.now(),
    state: 'idle' as const
  }
  const message: PresenceMessage = {
    ...unsigned,
    sig: Buffer.from(rt.keys.signAsBot(bot, canonicalJson(unsigned))).toString('base64url')
  }
  await f.current.preparePresence(f.space.space, bot)
  expect(() => f.current.recordVerifiedPresence(message)).toThrow(
    expect.objectContaining({ code: 'forbidden' })
  )
  expect(receiver.receive(message, { user: self.user, node: self.node, delegation: node })).toBe(
    true
  )
  f.current.recordVerifiedPresence(message)
  const author = {
      bot,
      node: self.node,
      keyEpoch: f.spaces.meta.state(f.space.space)!.bots.get(bot)!.delegation.keyEpoch
    },
    bytes = canonicalJson(unsigned),
    sig = Buffer.from(message.sig, 'base64url')
  f.advance(45000)
  expect(() =>
    f.current
      .presenceIdentity(f.space.space)
      .verifyAuthor(author, bytes, sig, message.ts, 'newWork')
  ).toThrow(expect.objectContaining({ code: 'meta_stale' }))
  expect(
    f.current
      .presenceDisplayIdentity(f.space.space)
      .verifyAuthor(author, bytes, sig, message.ts, 'newWork')
  ).toMatchObject({ kind: 'bot', user: self.user, verifyOnly: true })
  f.advance(45000)
  expect(() =>
    f.current
      .presenceDisplayIdentity(f.space.space)
      .verifyAuthor(author, bytes, sig, message.ts, 'newWork')
  ).toThrow(expect.objectContaining({ code: 'meta_stale' }))
})

async function preparedHistoryProofs() {
  const f = await owner(),
    rt = f.net.runtime(),
    self = rt.identity.self()!,
    older = rt.identity.roster()!,
    bot = f.input.bot
  const key = rt.keys.createBotKey(bot),
    delegation = rt.identity.issueBotDelegation({
      bot,
      key,
      name: 'Historical presence comparison',
      hostNode: self.node
    })
  f.spaces.host.postMeta(f.space.space, 'bot.added', {
    record: {
      bot,
      owner: self.user,
      delegation,
      displayName: 'Historical presence comparison',
      profile: 'chat',
      policy: { visibility: 'public', steer: { kind: 'everyone' } }
    }
  })
  await f.current.prepareAdmission(f.input)
  await f.current.preparePrivateAudience(f.space.space, [self.user])
  await f.current.preparePresence(f.space.space, bot)
  const signed = rt.identity.roster()!,
    roster = rt.identity.verifySigned<Roster>(signed, rt.keys.rootKey()!),
    node = roster.nodes
      .map((row) => rt.identity.verifySigned<NodeDelegation>(row, roster.rootKey))
      .find((row) => row.subject === self.node)!
  const unsigned = {
      t: 'presence' as const,
      stream: f.input.stream,
      subject: bot,
      counter: 1,
      ts: rt.db.clock.now(),
      state: 'working' as const
    },
    message = {
      ...unsigned,
      sig: Buffer.from(rt.keys.signAsBot(bot, canonicalJson(unsigned))).toString('base64url')
    }
  const receiver = new BotPresenceReceiver({
    db: rt.db,
    identity: rt.identity,
    meta: f.spaces.meta,
    store: f.spaces.store,
    identityForSpace: (space) => f.current.presenceIdentity(space),
    viewIdentityForSpace: (space) => f.current.presenceDisplayIdentity(space)
  })
  expect(receiver.receive(message, { user: self.user, node: self.node, delegation: node })).toBe(
    true
  )
  f.current.recordVerifiedPresence(message)
  return { ...f, rt, self, bot, older, signed, roster, receiver }
}

it('preserves exact and older independently signed history without refreshing any current purpose or accepted display age', async () => {
  const f = await preparedHistoryProofs(),
    before = f.rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value,
    ledger = f.rt.db.database.prepare('SELECT state FROM net_space_current_identity').get()!.state
  f.advance(20000)
  f.current.observeHistoryRoster(f.signed)
  f.current.observeHistoryRoster(f.older)
  expect(f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope).author.verifyOnly).toBe(
    false
  )
  expect(f.receiver.view(f.input.stream, f.bot).state).toBe('working')
  expect(f.current.currentPrivateRoster(f.space.space, f.self.user).payload).toBe(f.signed.payload)
  f.advance(10000)
  f.current.observeHistoryRoster(f.signed)
  expect(() => f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  expect(() => f.current.presenceIdentity(f.space.space).roster(f.self.user)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  f.advance(15000)
  f.current.observeHistoryRoster(f.signed)
  expect(f.receiver.view(f.input.stream, f.bot).state).toBe('reconnecting')
  f.advance(45000)
  f.current.observeHistoryRoster(f.signed)
  expect(f.receiver.view(f.input.stream, f.bot).state).toBe('offline')
  expect(f.rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
  expect(
    f.rt.db.database.prepare('SELECT state FROM net_space_current_identity').get()!.state
  ).toBe(ledger)
})

it.each([
  'successor',
  'recovery',
  'same-position fork',
  'older other lineage',
  'wrong root',
  'bad signature'
] as const)(
  'invalidates scoped purposes for %s history without adopting or refreshing that document',
  async (kind) => {
    const f = await preparedHistoryProofs(),
      before = f.rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value,
      ledger = f.rt.db.database.prepare('SELECT state FROM net_space_current_identity').get()!.state
    let incoming: Signed
    if (kind === 'wrong root') {
      const foreign = await owner(),
        root = foreign.net.runtime().keys.rootKey()!
      incoming = signedDocument({ ...f.roster, rootKey: root }, (bytes) =>
        foreign.net.runtime().keys.signAsRoot(bytes)
      )
    } else if (kind === 'bad signature')
      incoming = { ...f.signed, sig: Buffer.alloc(64).toString('base64url') }
    else
      incoming = signedDocument(
        {
          ...f.roster,
          ...(kind === 'successor'
            ? { version: f.roster.version + 1 }
            : kind === 'recovery'
              ? {
                  recoveryEpoch: f.roster.recoveryEpoch + 1,
                  version: 1,
                  lineage: 'new-recovery-lineage'
                }
              : kind === 'same-position fork'
                ? { issuedAt: f.roster.issuedAt + 1 }
                : { version: 1, lineage: 'other-lineage-at-the-same-recovery' })
        },
        (bytes) => f.rt.keys.signAsRoot(bytes)
      )
    f.current.observeHistoryRoster(incoming)
    expect(() => f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(
      expect.objectContaining({ code: 'meta_stale' })
    )
    expect(() => f.current.presenceIdentity(f.space.space).roster(f.self.user)).toThrow(
      expect.objectContaining({ code: 'meta_stale' })
    )
    expect(f.receiver.view(f.input.stream, f.bot).state).toBe('offline')
    expect(f.rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(
      before
    )
    expect(
      f.rt.db.database.prepare('SELECT state FROM net_space_current_identity').get()!.state
    ).toBe(ledger)
  }
)

it('does not let a lower recovery roster supersede an independently current higher recovery proof', async () => {
  const f = await preparedHistoryProofs(),
    current = signedDocument(
      {
        ...f.roster,
        recoveryEpoch: f.roster.recoveryEpoch + 1,
        version: 1,
        lineage: 'actual-root-signed-higher-recovery'
      },
      (bytes) => f.rt.keys.signAsRoot(bytes)
    )
  expect(f.rt.identity.acceptRoster(current, f.roster.rootKey).state).toBe('ok')
  await f.current.prepareAdmission(f.input)
  await f.current.preparePresence(f.space.space, f.bot)
  const unsigned = {
      t: 'presence' as const,
      stream: f.input.stream,
      subject: f.bot,
      counter: 2,
      ts: f.rt.db.clock.now(),
      state: 'working' as const
    },
    message = {
      ...unsigned,
      sig: Buffer.from(f.rt.keys.signAsBot(f.bot, canonicalJson(unsigned))).toString('base64url')
    }
  const node = f.roster.nodes
    .map((row) => f.rt.identity.verifySigned<NodeDelegation>(row, f.roster.rootKey))
    .find((row) => row.subject === f.self.node)!
  expect(
    f.receiver.receive(message, { user: f.self.user, node: f.self.node, delegation: node })
  ).toBe(true)
  f.current.recordVerifiedPresence(message)
  const before = f.rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value
  f.current.observeHistoryRoster(f.signed)
  expect(f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope).author.verifyOnly).toBe(
    false
  )
  expect(f.receiver.view(f.input.stream, f.bot).state).toBe('working')
  expect(f.rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
})

it('creates and commits a real foreign-controller private audience after an explicit current TLS proof without adopting foreign identity', async () => {
  const host = await protectedReplica(),
    controller = await protectedReplica(),
    participant = await protectedReplica()
  const created = host.spaces.host.create({ name: 'Three current private users' }),
    channel = host.spaces.host.createChannel(created.space, 'general')
  for (const p of [controller, participant]) {
    await p.spaces.client.join(
      p.spaces.client.prepareJoin(host.spaces.host.invite(created.space).text)
    )
    await p.spaces.client.connect(created.space)
    await p.spaces.client.subscribe(channel)
  }
  const author = participant.net.runtime().identity.self()!.user,
    local = controller.net.runtime().identity.self()!.user
  await vi.waitFor(() => expect(controller.spaces.meta.member(created.space, author)).toBeDefined())
  const participantRuntime = participant.net.runtime(),
    bot = newId('bot'),
    key = participantRuntime.keys.createBotKey(bot)
  const delegation = participantRuntime.identity.issueBotDelegation({
    bot,
    key,
    name: 'Foreign audience bot',
    hostNode: participantRuntime.identity.self()!.node
  })
  await vi.waitFor(() =>
    expect(
      JSON.parse(
        Buffer.from(host.net.runtime().identity.roster(author)!.payload, 'base64url').toString()
      ).bots
    ).toHaveLength(1)
  )
  const registered = participant.spaces.client.queue(created.meta, 'bot.added', {
    record: {
      bot,
      owner: author,
      delegation,
      displayName: 'Foreign audience bot',
      profile: 'chat',
      policy: { visibility: 'private', steer: { kind: 'everyone' } }
    }
  })
  await participant.spaces.flush(created.space)
  expect(participantRuntime.outbox.get(registered)?.state).toBe('sent')
  await vi.waitFor(() => expect(controller.spaces.meta.bot(created.space, bot)).toBeDefined())
  const original = participant.spaces.client.post(
    channel,
    'Signed recipient history alone gives no current grant'
  )
  await participant.spaces.flush(created.space)
  await vi.waitFor(() => expect(controller.spaces.store.getById(channel, original)).toBeDefined())
  const rt = controller.net.runtime(),
    before = Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n)
  expect(rt.identity.pinnedRootKey(author)).toBeUndefined()
  const audience = [local, author, bot]
  expect(() => controller.spaces.private.prepareCreation(created.space, channel, audience)).toThrow(
    expect.objectContaining({ code: 'meta_stale' })
  )
  expect(Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_outbox').get()!.n)).toBe(
    before
  )
  await controller.current.preparePrivateAudience(created.space, audience)
  const pending = controller.spaces.private.prepareCreation(created.space, channel, audience)
  await controller.spaces.private.publishCreation(pending.descriptor.id)
  expect(rt.identity.pinnedRootKey(author)).toBeUndefined()
  expect(rt.outbox.get(pending.event.id)?.state).toBe('sent')
  expect(host.spaces.private.state(pending.descriptor.id)?.control.participants).toEqual(
    audience.sort()
  )
  expect(host.spaces.private.state(pending.descriptor.id)?.control.wrapped).toHaveLength(2)
  await vi.waitFor(() =>
    expect(participant.spaces.store.getById(channel, pending.parentEvent.id)).toBeDefined()
  )
  expect(participant.spaces.store.getStream(pending.descriptor.id)).toBeUndefined()
  expect(participantRuntime.identity.pinnedRootKey(local)).toBeUndefined()
  expect(
    spaceHistoryAuthor(
      participantRuntime.identity,
      participant.spaces.meta,
      participant.spaces.evidence,
      pending.descriptor,
      { envelope: pending.event.envelope, sig: pending.event.sig }
    )
  ).toMatchObject({ kind: 'node', user: local, verifyOnly: true })
  await participant.spaces.discover(created.space, pending.descriptor.id)
  expect(participantRuntime.identity.pinnedRootKey(local)).toBeUndefined()
  await participant.spaces.client.subscribe(pending.descriptor.id)
  await controller.current.preparePrivateAudience(created.space, audience)
  const reply = controller.spaces.client.post(
    pending.descriptor.id,
    'Current foreign bot audience original ciphertext'
  )
  await controller.spaces.flush(created.space)
  expect(rt.outbox.get(reply)?.state).toBe('sent')
  await vi.waitFor(() =>
    expect(participant.spaces.store.getById(pending.descriptor.id, reply)).toBeDefined()
  )
  expect(
    participant.spaces.private.open(
      pending.descriptor.id,
      participant.spaces.store.getById(pending.descriptor.id, reply)!
    )
  ).toEqual({ text: 'Current foreign bot audience original ciphertext' })
  expect(rt.identity.pinnedRootKey(author)).toBeUndefined()
}, 15000)
