import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../src/mms/spaces/SpaceProfileService'
import { canonicalJson, decodeEnvelope } from '../../../src/mms/net/sync/codec'
import { newId } from '../../../src/shared/net'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function profile() {
  const path = mkdtempSync(join(tmpdir(), 'space-composition-'))
  let spaces!: SpaceProfileService
  const net = new NetService({
    profileDir: path,
    composeRuntime: (rt) => {
      spaces = new SpaceProfileService({ runtime: rt, net })
      return spaces.composition(
        new NodeStreamAuthority(rt.identity, spaces.store, rt.blobs, systemClock)
      )
    }
  })
  cleanup.push(
    () => rmSync(path, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return {
    net,
    get spaces() {
      return spaces
    }
  }
}
it('constructs without enrollment and joins a foreign Space through actual composed direct TLS', async () => {
  const host = profile(),
    member = profile()
  expect(member.net.runtime().identity.self()).toBeUndefined()
  for (const p of [host, member]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'composition-protection' })
  }
  const space = host.spaces.host.create({ name: 'Composed Space' }),
    channel = host.spaces.host.createChannel(space.space, 'general')
  await member.spaces.client.join(
    member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  await member.spaces.client.connect(space.space)
  await member.spaces.client.subscribe(channel)
  const event = member.spaces.client.post(channel, 'actual composed message')
  await member.spaces.client.flush(space.space)
  expect(member.net.runtime().outbox.get(event)?.state).toBe('sent')
  expect(host.spaces.store.getById(channel, event)).toBeDefined()
}, 10000)

it('imports a third profile without pre-pinning earlier members and verifies their original public history', async () => {
  const host = profile(),
    member = profile(),
    fresh = profile()
  for (const p of [host, member, fresh]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'composition-protection' })
  }
  const space = host.spaces.host.create({ name: 'Three independent profiles' }),
    channel = host.spaces.host.createChannel(space.space, 'general')
  await member.spaces.client.join(
    member.spaces.client.prepareJoin(host.spaces.host.invite(space.space, { role: 'admin' }).text)
  )
  await member.spaces.client.connect(space.space)
  await member.spaces.client.subscribe(channel)
  const change = member.spaces.client.queue(space.meta, 'channel.renamed', {
    stream: channel,
    name: 'renamed by member'
  })
  await member.spaces.client.flush(space.space)
  expect(member.net.runtime().outbox.get(change)?.state).toBe('sent')
  await vi.waitFor(() =>
    expect(member.spaces.meta.channel(space.space, channel)?.name).toBe('renamed by member')
  )
  const event = member.spaces.client.post(channel, 'history from an independent member')
  await member.spaces.client.flush(space.space)
  const earlier = member.net.runtime().identity.self()!.user
  expect(fresh.net.runtime().identity.pinnedRootKey(earlier)).toBeUndefined()
  await fresh.spaces.client.join(
    fresh.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  await fresh.spaces.client.connect(space.space)
  expect(fresh.spaces.meta.channel(space.space, channel)?.name).toBe('renamed by member')
  await fresh.spaces.client.subscribe(channel)
  expect(fresh.spaces.store.getById(channel, event)).toEqual(
    host.spaces.store.getById(channel, event)
  )
  const original = host.spaces.store.getById(channel, event)!,
    envelope = decodeEnvelope(original.envelope).envelope,
    identity = fresh.spaces.client.options.identity
  expect(
    identity.verifyAuthor(envelope.author, original.envelope, original.sig, envelope.ts, 'history')
  ).toMatchObject({ kind: 'node', verifyOnly: true })
  expect(fresh.net.runtime().identity.pinnedRootKey(earlier)).toBeUndefined()
  expect(() =>
    identity.verifyAuthor(envelope.author, original.envelope, original.sig, envelope.ts, 'newWork')
  ).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
  const bad = new Uint8Array(original.sig)
  bad[0] ^= 1
  expect(() =>
    identity.verifyAuthor(envelope.author, original.envelope, bad, envelope.ts, 'history')
  ).toThrow(expect.objectContaining({ code: 'bad_signature' }))
  const outsider = profile()
  await outsider.net.request('net.init', {})
  await outsider.net.request('net.protect', { passphrase: 'composition-protection' })
  fresh.spaces.evidence.retain(outsider.net.runtime().identity.roster()!)
  const outsiderSelf = outsider.net.runtime().identity.self()!,
    forged = canonicalJson({
      ...envelope,
      id: newId('event'),
      author: { user: outsiderSelf.user, node: outsiderSelf.node, keyEpoch: 1 }
    })
  expect(() =>
    identity.verifyAuthor(
      { user: outsiderSelf.user, node: outsiderSelf.node, keyEpoch: 1 },
      forged,
      outsider.net.runtime().keys.signAsNode(forged),
      envelope.ts,
      'history'
    )
  ).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
}, 10000)

it('verifies an earlier foreign bot lease from signed meta and retained rosters without granting that bot current authority', async () => {
  const host = profile(),
    member = profile(),
    fresh = profile()
  for (const p of [host, member, fresh]) {
    await p.net.request('net.init', { listen: true })
    await p.net.request('net.protect', { passphrase: 'composition-protection' })
  }
  const space = host.spaces.host.create({ name: 'Historical bot proof' }),
    channel = host.spaces.host.createChannel(space.space, 'general')
  await member.spaces.client.join(
    member.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  await member.spaces.client.connect(space.space)
  const rt = member.net.runtime(),
    self = rt.identity.self()!,
    bot = newId('bot'),
    key = rt.keys.createBotKey(bot),
    delegation = rt.identity.issueBotDelegation({
      bot,
      key,
      name: 'Earlier bot',
      hostNode: self.node
    })
  await vi.waitFor(() =>
    expect(
      JSON.parse(
        Buffer.from(host.net.runtime().identity.roster(self.user)!.payload, 'base64url').toString()
      ).bots
    ).toHaveLength(1)
  )
  const registration = member.spaces.client.queue(space.meta, 'bot.added', {
    record: {
      bot,
      owner: self.user,
      delegation,
      displayName: 'Earlier bot',
      profile: 'chat',
      policy: { steer: { kind: 'everyone' }, visibility: 'public' }
    }
  })
  await member.spaces.client.flush(space.space)
  expect(rt.outbox.get(registration)?.state).toBe('sent')
  await vi.waitFor(() => expect(member.spaces.meta.bot(space.space, bot)).toBeDefined())
  const meta = member.spaces.meta.position(space.space)!,
    lease = JSON.parse(Buffer.from(delegation.payload, 'base64url').toString())
  const envelope = {
    v: 1,
    minor: 0,
    id: newId('event'),
    stream: channel,
    type: 'bot.run.progress',
    crit: false,
    author: { bot, node: self.node, keyEpoch: lease.keyEpoch },
    ts: Date.now(),
    auth: { metaEpoch: meta.epoch, metaSeq: meta.seq },
    refs: { execution: newId('execution'), subject: newId('event') },
    body: { text: 'Signed historical bot proof' }
  }
  const bytes = canonicalJson(envelope),
    sig = rt.keys.signAsBot(bot, bytes)
  expect(
    rt.identity.verifyAuthor(envelope.author, bytes, sig, envelope.ts, 'history')
  ).toMatchObject({ kind: 'bot', bot })
  await fresh.spaces.client.join(
    fresh.spaces.client.prepareJoin(host.spaces.host.invite(space.space).text)
  )
  await fresh.spaces.client.connect(space.space)
  await fresh.spaces.client.subscribe(channel)
  expect(fresh.spaces.meta.botAt(space.space, bot, envelope.auth)).toBeDefined()
  expect(fresh.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined()
  const identity = fresh.spaces.client.options.identity
  // Meta replay sends the node author's original roster. Bot receipt replay
  // additionally supplies the original bot roster; missing that proof denies.
  expect(() => identity.verifyAuthor(envelope.author, bytes, sig, envelope.ts, 'history')).toThrow(
    expect.objectContaining({ code: 'bad_delegation' })
  )
  fresh.spaces.evidence.retain(rt.identity.roster()!)
  expect(identity.verifyAuthor(envelope.author, bytes, sig, envelope.ts, 'history')).toMatchObject({
    kind: 'bot',
    bot,
    user: self.user,
    verifyOnly: true
  })
  expect(() => identity.verifyAuthor(envelope.author, bytes, sig, envelope.ts, 'newWork')).toThrow(
    expect.objectContaining({ code: 'bad_delegation' })
  )
  const bad = new Uint8Array(sig)
  bad[0] ^= 1
  expect(() => identity.verifyAuthor(envelope.author, bytes, bad, envelope.ts, 'history')).toThrow(
    expect.objectContaining({ code: 'bad_signature' })
  )
  for (const altered of [
    {
      ...envelope,
      auth: { metaEpoch: 1, metaSeq: rt.outbox.get(registration)!.position!.seq - 1 }
    },
    { ...envelope, author: { ...envelope.author, keyEpoch: lease.keyEpoch + 1 } },
    { ...envelope, author: { ...envelope.author, node: host.net.runtime().identity.self()!.node } }
  ]) {
    const changed = canonicalJson(altered)
    expect(() =>
      identity.verifyAuthor(
        altered.author,
        changed,
        rt.keys.signAsBot(bot, changed),
        envelope.ts,
        'history'
      )
    ).toThrow(expect.objectContaining({ code: 'bad_delegation' }))
  }
  expect(fresh.net.runtime().identity.pinnedRootKey(self.user)).toBeUndefined()
}, 10000)
