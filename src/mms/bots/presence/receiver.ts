import type {
  IdentityService,
  MetaProjection,
  MetaState,
  StreamStore,
  SyncSession
} from '../../net/contracts'
import type {
  PresenceMessage,
  BotId,
  NodeDelegation,
  Roster,
  StreamId,
  SpaceId
} from '../../../shared/net'
import { validateWireMessage, NetError } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import { NetDatabase } from '../../net/store/database'
export interface BotPresenceReceiverOptions {
  db: NetDatabase
  identity: IdentityService
  meta: MetaProjection
  store: StreamStore
  identityForSpace?(space: SpaceId): IdentityService
  viewIdentityForSpace?(space: SpaceId): IdentityService
}
export type BotPresenceView = {
  state: 'idle' | 'working' | 'workingPrivate' | 'reconnecting' | 'offline'
  receivedAtMonotonic?: number
}
/** Current signed placement plus durable anti-replay counter; volatile display freshness never survives boot. */
export class BotPresenceReceiver {
  private received = new Map<string, { message: PresenceMessage; at: number }>()
  constructor(readonly options: BotPresenceReceiverOptions) {
    options.db.transaction(() =>
      options.db.database.exec(
        'CREATE TABLE IF NOT EXISTS net_bot_presence_seen(bot TEXT NOT NULL,key_epoch INTEGER NOT NULL,counter INTEGER NOT NULL,PRIMARY KEY(bot,key_epoch))'
      )
    )
  }
  receive(message: PresenceMessage, peer: SyncSession['peer']): boolean {
    try {
      if (this.options.db.inTransaction) return false
      if (!validateWireMessage(message) || message.t !== 'presence') return false
      const descriptor = this.options.store.getStream(message.stream),
        meta = descriptor?.space && this.options.meta.state(descriptor.space),
        bot = meta?.bots.get(message.subject as BotId)
      if (
        !descriptor?.space ||
        descriptor.kind !== 'space.channel' ||
        !meta ||
        meta.frozen ||
        meta.upgradeRequired ||
        descriptor.authority !== meta.descriptor.hostNode ||
        !meta.channels.has(descriptor.id) ||
        meta.channels.get(descriptor.id)!.archived ||
        !bot ||
        !meta.members.has(bot.owner) ||
        (message.state === 'workingPrivate' && message.activity !== undefined)
      )
        return false
      const identity = this.options.identityForSpace
        ? this.options.identityForSpace(descriptor.space)
        : this.options.identity
      if (!identity || identity.pinnedRootKey(bot.owner) !== meta.members.get(bot.owner)!.rootKey)
        return false
      const direct = bot.owner === peer.user && bot.delegation.hostNode === peer.node
      const relay =
        peer.user === meta.descriptor.owner &&
        peer.node === meta.descriptor.hostNode &&
        peer.delegation.keys.transport === meta.descriptor.hostTransportKey
      if ((!direct && !relay) || !this.currentPeer(meta, peer, identity)) return false
      if (Math.abs(this.options.db.clock.now() - message.ts) > 90000) return false
      const { sig, ...unsigned } = message,
        author = identity.verifyAuthor(
          {
            bot: message.subject as BotId,
            node: bot.delegation.hostNode,
            keyEpoch: bot.delegation.keyEpoch
          },
          canonicalJson(unsigned),
          Buffer.from(sig, 'base64url'),
          message.ts,
          'newWork'
        )
      if (
        author.kind !== 'bot' ||
        author.verifyOnly ||
        author.revoked ||
        author.user !== bot.owner ||
        author.delegation.keys.sign !== bot.delegation.keys.sign
      )
        return false
      return this.options.db.transaction(() => {
        const previous = Number(
          this.options.db.database
            .prepare('SELECT counter FROM net_bot_presence_seen WHERE bot=? AND key_epoch=?')
            .get(message.subject, bot.delegation.keyEpoch)?.counter ?? 0
        )
        if (message.counter <= previous) return false
        this.options.db.charge(1)
        this.options.db.database
          .prepare(
            'INSERT INTO net_bot_presence_seen VALUES(?,?,?) ON CONFLICT(bot,key_epoch) DO UPDATE SET counter=excluded.counter'
          )
          .run(message.subject, bot.delegation.keyEpoch, message.counter)
        this.options.db.afterCommit(() =>
          this.received.set(`${message.stream}/${message.subject}`, {
            message: structuredClone(message),
            at: this.options.db.clock.monotonic()
          })
        )
        return true
      })
    } catch (error) {
      if (error instanceof NetError) return false
      throw error
    }
  }
  view(stream: StreamId, bot: BotId): BotPresenceView {
    const row = this.received.get(`${stream}/${bot}`),
      descriptor = this.options.store.getStream(stream),
      meta = descriptor?.space && this.options.meta.state(descriptor.space)
    if (
      !row ||
      !meta?.bots.has(bot) ||
      meta.frozen ||
      meta.upgradeRequired ||
      descriptor?.authority !== meta.descriptor.hostNode ||
      meta.channels.get(stream)?.archived !== false
    )
      return { state: 'offline' }
    try {
      const scoped = this.options.viewIdentityForSpace ?? this.options.identityForSpace,
        identity = scoped ? scoped(descriptor!.space!) : this.options.identity,
        current = meta.bots.get(bot)!,
        { sig, ...unsigned } = row.message,
        author = identity.verifyAuthor(
          { bot, node: current.delegation.hostNode, keyEpoch: current.delegation.keyEpoch },
          canonicalJson(unsigned),
          Buffer.from(sig, 'base64url'),
          row.message.ts,
          'newWork'
        )
      if (
        !meta.members.has(current.owner) ||
        identity.pinnedRootKey(current.owner) !== meta.members.get(current.owner)!.rootKey ||
        author.kind !== 'bot' ||
        (author.verifyOnly && !this.options.viewIdentityForSpace) ||
        author.revoked ||
        author.user !== current.owner ||
        author.delegation.keys.sign !== current.delegation.keys.sign
      )
        return { state: 'offline' }
    } catch {
      return { state: 'offline' }
    }
    const age = this.options.db.clock.monotonic() - row.at
    return {
      state:
        age < 0 || age >= 90000 ? 'offline' : age >= 45000 ? 'reconnecting' : row.message.state,
      receivedAtMonotonic: row.at
    }
  }
  private currentPeer(
    meta: MetaState,
    peer: SyncSession['peer'],
    identity: IdentityService
  ): boolean {
    const root = meta.members.get(peer.user)?.rootKey,
      signed = identity.roster(peer.user),
      now = this.options.db.clock.now()
    if (
      !root ||
      identity.pinnedRootKey(peer.user) !== root ||
      identity.rosterState(peer.user) !== 'ok' ||
      !signed
    )
      return false
    const roster = identity.verifySigned<Roster>(signed, root),
      current = roster.nodes
        .map((row) => identity.verifySigned<NodeDelegation>(row, root))
        .filter((row) => row.subject === peer.node)
        .sort((a, b) => b.keyEpoch - a.keyEpoch || b.issuedAt - a.issuedAt)[0],
      claimed = peer.delegation
    return (
      !!current &&
      current.owner === peer.user &&
      current.kind === 'node' &&
      current.issuedAt <= now &&
      now < current.expiresAt &&
      !roster.revoked.some(
        (row) => row.subject === peer.node && row.throughKeyEpoch >= current.keyEpoch
      ) &&
      claimed.kind === 'node' &&
      claimed.owner === peer.user &&
      claimed.subject === peer.node &&
      claimed.keyEpoch === current.keyEpoch &&
      claimed.issuedAt <= now &&
      now < claimed.expiresAt &&
      Buffer.compare(canonicalJson(current.keys), canonicalJson(claimed.keys)) === 0
    )
  }
}
