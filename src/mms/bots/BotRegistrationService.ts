import type {
  BotDelegation,
  BotId,
  Envelope,
  EventId,
  NodeDelegation,
  NodeId,
  Roster,
  RpcId,
  Signed,
  SpaceId,
  UserId
} from '../../shared/net'
import { NetError, isCritical, newId, spaceMetaStream } from '../../shared/net'
import type { BotsLocalParams, BotsLocalResults } from '../../shared/bots/local'
import type { BotProfileService } from './BotProfileService'
import { canonicalJson, decodeEnvelope } from '../net/sync/codec'
import { digest, json } from '../net/store/database'
import { verifyDocument } from '../net/identity/crypto'

type Input = BotsLocalParams['bots.add']
interface Registration {
  id: RpcId
  request: string
  owner: UserId
  node: NodeId
  space: SpaceId
  bot: BotId
  event: EventId
  phase: 'reserved' | 'leased' | 'queued'
  publicKey?: string
  delegation?: Signed
  envelopeHash?: string
  signatureHash?: string
}
/** One reserved identity, actual protected key, root lease and signed original.
 * Restart never starts another registration; an explicit identical request may
 * advance only its existing local journal and original outbox entry. */
export class BotRegistrationService {
  constructor(readonly profile: BotProfileService) {
    profile.options.runtime.db.database.exec(
      'CREATE TABLE IF NOT EXISTS net_bot_local_registration(id TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT'
    )
  }
  async add(input: Input): Promise<BotsLocalResults['bots.add']> {
    const rt = this.profile.options.runtime,
      self = rt.identity.self()
    if (!self) throw new NetError('not_enrolled')
    const request = Buffer.from(canonicalJson(input)).toString(),
      row = rt.db.database
        .prepare('SELECT value FROM net_bot_local_registration WHERE id=?')
        .get(input.id)
    let op = row ? (JSON.parse(row.value as string) as Registration) : undefined
    if (
      op &&
      (op.request !== request ||
        op.owner !== self.user ||
        op.node !== self.node ||
        op.space !== input.space)
    )
      throw new NetError('conflict')
    if (op?.phase === 'queued') {
      const result = this.result(op)
      if (
        result.state === 'registered' ||
        result.state === 'failed' ||
        result.delivery?.state === 'sent'
      )
        return result
    }
    this.authority(input)
    if (!op) {
      op = {
        id: input.id,
        request,
        owner: self.user,
        node: self.node,
        space: input.space,
        bot: newId('bot'),
        event: newId('event'),
        phase: 'reserved'
      }
      const reserved = op
      rt.db.transaction(() => {
        if (
          Number(
            rt.db.database.prepare('SELECT count(*) AS n FROM net_bot_local_registration').get()!.n
          ) >= 4096
        )
          throw new NetError('too_large')
        this.save(reserved, true)
        rt.db.checkpoint('bots.add.reservation.beforeCommit')
      })
    }
    if (op.phase === 'reserved') {
      const publicKey = rt.keys.ensureBotKey(op.bot)
      // The key file is its own real atomic boundary; retry derives this same
      // public key after a crash here, without creating or reading private data.
      rt.db.checkpoint('bots.add.keyCreated')
      const leased = rt.db.transaction(() => {
        this.authority(input)
        const delegation = rt.identity.issueBotDelegation({
          bot: op!.bot,
          key: publicKey,
          name: input.name,
          hostNode: self.node
        })
        rt.db.charge(
          1,
          Buffer.byteLength(
            rt.db.database.prepare('SELECT value FROM net_identity_state WHERE singleton=1').get()!
              .value as string
          )
        )
        const next: Registration = { ...op!, phase: 'leased', publicKey, delegation }
        this.save(next)
        rt.db.checkpoint('bots.add.lease.beforeCommit')
        return next
      })
      op = leased
    }
    if (op.phase === 'leased') {
      const peer = this.authority(input),
        delegation = this.lease(op)
      const meta = this.profile.options.spaces.meta.assertUsable(input.space, true),
        stream = spaceMetaStream(input.space),
        descriptor = this.profile.options.spaces.store.getStream(stream)
      if (!descriptor || descriptor.kind !== 'space.meta' || descriptor.space !== input.space)
        throw new NetError('forbidden')
      const envelope: Envelope<'bot.added'> = {
        v: 1,
        minor: 0,
        id: op.event,
        stream,
        type: 'bot.added',
        crit: isCritical({ type: 'bot.added', crit: false }, true),
        author: { user: self.user, node: self.node, keyEpoch: peer.keyEpoch },
        ts: rt.db.clock.now(),
        auth: { metaEpoch: meta.epoch, metaSeq: meta.seq },
        body: {
          record: {
            bot: op.bot,
            owner: self.user,
            delegation: op.delegation!,
            displayName: input.name,
            profile: input.profile,
            policy: input.policy
          }
        }
      }
      if (delegation.name !== input.name) throw new NetError('conflict')
      const bytes = canonicalJson(envelope),
        sig = rt.keys.signAsNode(bytes),
        author = rt.identity.verifyAuthor(
          envelope.author,
          bytes,
          sig,
          rt.db.clock.now(),
          'newWork'
        ),
        decision = this.profile.options.spaces.meta.canWrite(
          input.space,
          descriptor,
          envelope,
          author
        )
      if (!decision.ok) throw new NetError(decision.code)
      const queued: Registration = {
        ...op,
        phase: 'queued',
        envelopeHash: digest(bytes),
        signatureHash: digest(sig)
      }
      rt.db.transaction(() => {
        rt.outbox.enqueue({ id: op!.event, stream, envelope: bytes, sig })
        this.save(queued)
        rt.db.checkpoint('bots.add.queue.beforeCommit')
      })
      op = queued
    }
    this.lease(op)
    const entry = rt.outbox.get(op.event)
    if (!entry) throw new NetError('storage_corrupt')
    rt.identity.verifyAuthor(
      decodeEnvelope(entry.envelope).envelope.author,
      entry.envelope,
      entry.sig,
      rt.db.clock.now(),
      'newWork'
    )
    try {
      await this.profile.options.spaces.flush(input.space)
    } catch (error) {
      if (!(error instanceof NetError)) throw error
    }
    return this.result(op)
  }
  private authority(input: Input): NodeDelegation {
    const rt = this.profile.options.runtime,
      self = rt.identity.self(),
      keys = rt.keys as typeof rt.keys & { encryptedAtRest?(): boolean }
    if (keys.state() !== 'unlocked' || keys.encryptedAtRest?.() !== true)
      throw new NetError('keystore_locked')
    if (
      !self?.isAuthority ||
      !keys.rootKey() ||
      keys.rootKey() !== rt.identity.pinnedRootKey(self.user)
    )
      throw new NetError('forbidden')
    const state = this.profile.options.spaces.meta.assertUsable(input.space, true),
      member = this.profile.options.spaces.meta.member(input.space, self.user)
    if (
      !member ||
      member.rootKey !== keys.rootKey() ||
      (!['owner', 'admin'].includes(member.role) && !state.settings?.membersMayAddBots)
    )
      throw new NetError('forbidden')
    const roster = verifyDocument<Roster>(rt.identity.roster(self.user)!, keys.rootKey()!, 'roster')
    if (roster.authorityNode !== self.node || rt.identity.rosterState(self.user) !== 'ok')
      throw new NetError('forbidden')
    const peer = roster.nodes
      .map((row) => verifyDocument<NodeDelegation>(row, roster.rootKey, 'nodeDelegation'))
      .filter((row) => row.subject === self.node)
      .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0]
    if (!peer) throw new NetError('bad_delegation')
    const challenge = canonicalJson({ id: input.id, space: input.space }),
      signature = keys.signAsNode(challenge),
      author = rt.identity.verifyAuthor(
        { user: self.user, node: self.node, keyEpoch: peer.keyEpoch },
        challenge,
        signature,
        rt.db.clock.now(),
        'newWork'
      )
    if (
      author.kind !== 'node' ||
      author.user !== self.user ||
      author.node !== self.node ||
      author.verifyOnly ||
      author.revoked
    )
      throw new NetError('bad_delegation')
    return peer
  }
  private lease(op: Registration): BotDelegation {
    const rt = this.profile.options.runtime,
      root = rt.identity.pinnedRootKey(op.owner)
    if (!root || !op.delegation || !op.publicKey || rt.keys.ensureBotKey(op.bot) !== op.publicKey)
      throw new NetError('conflict')
    const lease = verifyDocument<BotDelegation>(op.delegation, root, 'botDelegation'),
      roster = verifyDocument<Roster>(rt.identity.roster(op.owner)!, root, 'roster')
    const current = roster.bots
      .map((row) => verifyDocument<BotDelegation>(row, root, 'botDelegation'))
      .filter((row) => row.subject === op.bot)
      .sort((a, b) => b.keyEpoch - a.keyEpoch)[0]
    if (
      lease.subject !== op.bot ||
      lease.owner !== op.owner ||
      lease.hostNode !== op.node ||
      lease.keys.sign !== op.publicKey ||
      lease.issuedAt > rt.db.clock.now() ||
      rt.db.clock.now() >= lease.expiresAt ||
      !current ||
      json(current) !== json(lease) ||
      (roster.revoked.find((row) => row.subject === op.bot)?.throughKeyEpoch ?? 0) >= lease.keyEpoch
    )
      throw new NetError('bad_delegation')
    return lease
  }
  private result(op: Registration): BotsLocalResults['bots.add'] {
    const rt = this.profile.options.runtime,
      stream = spaceMetaStream(op.space),
      entry = rt.outbox.get(op.event)
    if (
      !entry ||
      entry.stream !== stream ||
      digest(entry.envelope) !== op.envelopeHash ||
      digest(entry.sig) !== op.signatureHash
    )
      throw new NetError('storage_corrupt')
    const stored = this.profile.options.spaces.store.getById(stream, op.event)
    let registered = false
    if (
      stored &&
      Buffer.from(stored.envelope).equals(entry.envelope) &&
      Buffer.from(stored.sig).equals(entry.sig)
    ) {
      const original = decodeEnvelope(stored.envelope).envelope,
        record = this.profile.options.spaces.meta.botAt(op.space, op.bot, {
          metaEpoch: stored.epoch,
          metaSeq: stored.seq
        })
      registered =
        original.type === 'bot.added' &&
        json(record) === json((original.body as NonNullable<Envelope<'bot.added'>['body']>).record)
      if (registered && entry.state !== 'sent') rt.outbox.markSent(entry.id, stored)
    }
    const actual = rt.outbox.get(entry.id)!
    return {
      id: op.id,
      space: op.space,
      bot: op.bot,
      state: registered
        ? 'registered'
        : actual.state === 'failed'
          ? 'failed'
          : actual.state === 'pending'
            ? 'pending'
            : 'unknown',
      delivery: {
        id: actual.id,
        stream: actual.stream,
        state: actual.state,
        attempts: actual.attempts,
        createdAt: actual.createdAt,
        ...(actual.position ? { position: actual.position } : {}),
        ...(actual.error ? { error: actual.error } : {})
      }
    }
  }
  private save(op: Registration, insert = false): void {
    const db = this.profile.options.runtime.db,
      value = json(op)
    if (Buffer.byteLength(value) > 16 * 1024) throw new NetError('too_large')
    db.charge(1, Buffer.byteLength(value))
    if (insert)
      db.database.prepare('INSERT INTO net_bot_local_registration VALUES(?,?)').run(op.id, value)
    else if (
      db.database
        .prepare('UPDATE net_bot_local_registration SET value=? WHERE id=?')
        .run(value, op.id).changes !== 1
    )
      throw new NetError('conflict')
  }
}
