import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { NodeStreamAuthority } from '../../../src/mms/net/sync/nodeAuthority'
import { systemClock } from '../../../src/mms/net/clock'
import { SpaceProfileService } from '../../../src/mms/spaces/SpaceProfileService'
import { SpaceCurrentIdentity } from '../../../src/mms/spaces/SpaceCurrentIdentity'
import { BotPresenceReceiver } from '../../../src/mms/bots/presence/receiver'
import { canonicalJson, decodeEnvelope } from '../../../src/mms/net/sync/codec'
import type { AdmissionInput } from '../../../src/mms/bots/admission'
import { newId, type NodeDelegation, type Roster, type PresenceMessage } from '../../../src/shared/net'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function owner() {
  const path = mkdtempSync(join(tmpdir(), 'space-current-'))
  let spaces!: SpaceProfileService, current!: SpaceCurrentIdentity, elapsed = 0
  const clock = { ...systemClock, monotonic: () => systemClock.monotonic() + elapsed }
  const net = new NetService({ profileDir: path, clock, composeRuntime: runtime => {
    spaces = new SpaceProfileService({ runtime, net, clock })
    current = new SpaceCurrentIdentity({ runtime, store: spaces.store, meta: spaces.meta, host: spaces.host, session: space => spaces.session(space) })
    const composition = spaces.composition(new NodeStreamAuthority(runtime.identity, spaces.store, runtime.blobs, clock))
    return { ...composition, close: async () => { current.close(); await composition.close?.() } }
  } })
  cleanup.push(() => rmSync(path, { recursive: true, force: true }), () => net.shutdown())
  await net.request('net.init', { listen: true })
  const space = spaces.host.create({ name: 'Scoped current proof' }), channel = spaces.host.createChannel(space.space, 'general'), bot = newId('bot')
  const id = spaces.client.post(channel, 'Original signed human', { mentions: [bot] })
  await spaces.flush(space.space)
  const record = spaces.store.getById(channel, id)!, envelope = decodeEnvelope(record.envelope).envelope, descriptor = spaces.store.getStream(channel)!
  const input: AdmissionInput = { stream: channel, bot, record, source: 'delivery' }
  return { net, spaces, current, space, input, envelope, descriptor, advance: (ms: number) => { elapsed += ms } }
}

it('requires an explicit current request before verifying an exact real Host receipt and never changes profile identity', async () => {
  const f = await owner(), rt = f.net.runtime(), before = rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value
  expect(() => f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(expect.objectContaining({ code: 'meta_stale' }))
  await f.current.prepareAdmission(f.input)
  expect(f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toMatchObject({ author: { kind: 'node', user: f.envelope.author.user, node: f.envelope.author.node, verifyOnly: false, revoked: false }, rootKey: rt.keys.rootKey() })
  expect(rt.db.database.prepare('SELECT value FROM net_identity_state').get()!.value).toBe(before)
  const substituted = canonicalJson({ ...f.envelope, body: { text: 'Different validly signed bytes' } })
  const record = { ...f.input.record, envelope: substituted, sig: rt.keys.signAsNode(substituted) }
  expect(() => f.current.verifyMentionAuthor({ ...f.input, record }, f.descriptor, decodeEnvelope(substituted).envelope)).toThrow(expect.objectContaining({ code: 'forbidden' }))
  let pending!: Promise<void>
  rt.db.transaction(() => { pending = f.current.prepareAdmission(f.input) })
  await expect(pending).rejects.toMatchObject({ code: 'bad_request' })
})

it('does not turn durable scoped identity history into fresh authority after expiry, restart or a current meta change', async () => {
  const f = await owner()
  await f.current.prepareAdmission(f.input)
  f.advance(30000)
  expect(() => f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(expect.objectContaining({ code: 'meta_stale' }))
  await f.current.prepareAdmission(f.input)
  expect(f.current.verifyMentionAuthor(f.input, f.descriptor, f.envelope).author.verifyOnly).toBe(false)
  const restored = new SpaceCurrentIdentity(f.current.options)
  cleanup.push(() => restored.close())
  expect(() => restored.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(expect.objectContaining({ code: 'meta_stale' }))
  await restored.prepareAdmission(f.input)
  f.spaces.host.postMeta(f.space.space, 'channel.renamed', { stream: f.input.stream, name: 'Changed current meta' })
  expect(() => restored.verifyMentionAuthor(f.input, f.descriptor, f.envelope)).toThrow(expect.objectContaining({ code: 'meta_stale' }))
  await restored.prepareAdmission(f.input)
  expect(restored.verifyMentionAuthor(f.input, f.descriptor, f.envelope).author.revoked).toBe(false)
  expect(f.net.runtime().db.database.prepare('SELECT count(*) AS n FROM net_space_current_identity').get()!.n).toBe(1)
})

it('retains a verified accepted display proof for 90 seconds without extending current packet authority', async () => {
  const f = await owner(), rt = f.net.runtime(), self = rt.identity.self()!, bot = f.input.bot
  const key = rt.keys.createBotKey(bot), delegation = rt.identity.issueBotDelegation({ bot, key, name: 'Display proof', hostNode: self.node })
  f.spaces.host.postMeta(f.space.space, 'bot.added', { record: { bot, owner: self.user, delegation, displayName: 'Display proof', profile: 'chat', policy: { visibility: 'public', steer: { kind: 'everyone' } } } })
  const receiver = new BotPresenceReceiver({ db: rt.db, identity: f.current.presenceIdentity(f.space.space), meta: f.spaces.meta, store: f.spaces.store })
  const roster = rt.identity.verifySigned<Roster>(rt.identity.roster()!, rt.keys.rootKey()!), node = roster.nodes.map(signed => rt.identity.verifySigned<NodeDelegation>(signed, roster.rootKey)).find(node => node.subject === self.node)!
  const unsigned = { t: 'presence' as const, stream: f.input.stream, subject: bot, counter: 1, ts: rt.db.clock.now(), state: 'idle' as const }
  const message: PresenceMessage = { ...unsigned, sig: Buffer.from(rt.keys.signAsBot(bot, canonicalJson(unsigned))).toString('base64url') }
  await f.current.preparePresence(f.space.space, bot)
  expect(() => f.current.recordVerifiedPresence(message)).toThrow(expect.objectContaining({ code: 'forbidden' }))
  expect(receiver.receive(message, { user: self.user, node: self.node, delegation: node })).toBe(true)
  f.current.recordVerifiedPresence(message)
  const author = { bot, node: self.node, keyEpoch: f.spaces.meta.state(f.space.space)!.bots.get(bot)!.delegation.keyEpoch }, bytes = canonicalJson(unsigned), sig = Buffer.from(message.sig, 'base64url')
  f.advance(45000)
  expect(() => f.current.presenceIdentity(f.space.space).verifyAuthor(author, bytes, sig, message.ts, 'newWork')).toThrow(expect.objectContaining({ code: 'meta_stale' }))
  expect(f.current.presenceDisplayIdentity(f.space.space).verifyAuthor(author, bytes, sig, message.ts, 'newWork')).toMatchObject({ kind: 'bot', user: self.user, verifyOnly: true })
  f.advance(45000)
  expect(() => f.current.presenceDisplayIdentity(f.space.space).verifyAuthor(author, bytes, sig, message.ts, 'newWork')).toThrow(expect.objectContaining({ code: 'meta_stale' }))
})
