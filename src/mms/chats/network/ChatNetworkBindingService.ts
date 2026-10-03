import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatConversation } from '../../../shared/chats'
import type { ChatNetworkBinding, ChatNetworkSendInput, ChatPublishInput } from '../../../shared/chatsNetwork'
import { isId, NetError, type EventId, type SpaceId, type StreamId, type UserId } from '../../../shared/net'
import type { NetRuntime } from '../../net/NetService'
import { digest, json } from '../../net/store/database'
import { decodeEnvelope } from '../../net/sync/codec'
import type { SpaceProfileService } from '../../spaces/SpaceProfileService'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { chatId } from '../ChatStore'
import type { AgentChatService } from '../AgentChatService'

interface PublicationRow {
  publication_id: string; request_hash: string; state: string; space: SpaceId | null; channel: StreamId | null;
  owner: UserId; local_count: number; local_last: string | null
}
export interface ChatNetworkBindingOptions {
  profileId: string; profileHome: string; chats: AgentChatService
  runtime(): NetRuntime
  spaces(): SpaceProfileService
}
const clientKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const hash = (value: unknown): string => digest(Buffer.from(json(value)))

/** Durable dispatch authority lives only in net.db; the local transcript is never rewritten. */
export class ChatNetworkBindingService {
  private stopped = false
  private readonly pending = new Set<Promise<unknown>>()
  private schemaRuntime?: NetRuntime
  constructor(readonly options: ChatNetworkBindingOptions) {
    if (options.chats.profileId !== options.profileId) throw new DomainRpcError('profile_mismatch', 'Chats belong to another profile')
    options.chats.setNetworkBindingGuard(id => this.blocksLocal(id))
  }
  private runtime(): NetRuntime {
    const rt = this.options.runtime()
    if (rt.db.directory !== join(realpathSync(this.options.profileHome), 'net')) throw new NetError('forbidden')
    if (this.schemaRuntime !== rt) {
      rt.db.transaction(() => rt.db.database.exec(`
        CREATE TABLE IF NOT EXISTS net_chat_publications(
          profile TEXT NOT NULL, chat TEXT NOT NULL, publication_id TEXT NOT NULL, request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('publishing','published')), owner TEXT NOT NULL,
          space TEXT, channel TEXT, local_count INTEGER NOT NULL, local_last TEXT,
          PRIMARY KEY(profile,chat), UNIQUE(profile,publication_id), UNIQUE(channel)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS net_chat_message_keys(
          profile TEXT NOT NULL, chat TEXT NOT NULL, client_key TEXT NOT NULL, request_hash TEXT NOT NULL, event TEXT NOT NULL UNIQUE,
          PRIMARY KEY(profile,chat,client_key), FOREIGN KEY(profile,chat) REFERENCES net_chat_publications(profile,chat)
        ) STRICT;
      `))
      this.schemaRuntime = rt
    }
    return rt
  }
  private row(id: string): PublicationRow | undefined {
    if (!chatId(id)) throw new DomainRpcError('invalid_params', 'Invalid Group identity')
    // Ordinary local Chats do not activate Net. An established missing ledger
    // must still hit NetDatabase's recovery fence instead of restoring local execution.
    const dir = join(this.options.profileHome, 'net')
    if (!existsSync(join(dir, 'net.db')) && !existsSync(join(dir, 'ledger-established'))) return undefined
    return this.runtime().db.database.prepare('SELECT * FROM net_chat_publications WHERE profile=? AND chat=?').get(this.options.profileId, id) as unknown as PublicationRow | undefined
  }
  blocksLocal(id: string): boolean { return !!this.row(id) }
  binding(id: string): ChatNetworkBinding | undefined {
    const row = this.row(id)
    if (!row) return undefined
    if (row.state !== 'published' || !row.space || !row.channel || !isId('space', row.space) || !isId('stream', row.channel) || !isId('user', row.owner)) throw new NetError('outcome_uncertain')
    return { publicationId: row.publication_id, space: row.space, channel: row.channel, owner: row.owner, state: 'published',
      localHistory: { messageCount: Number(row.local_count), ...(row.local_last ? { lastMessageId: row.local_last } : {}) } }
  }
  publish(input: ChatPublishInput): ChatNetworkBinding {
    this.accepting()
    if (!chatId(input.chatId) || !clientKey(input.publicationId) || input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name !== input.name.trim() || Array.from(input.name).length > 120 || /[\x00-\x1f\x7f]/.test(input.name))) throw new DomainRpcError('invalid_params', 'Invalid publication request')
    const rt = this.runtime()
    if (rt.db.inTransaction) throw new NetError('forbidden', 'Publication requires its own committed boundary')
    const conversation = this.options.chats.assertPublishable(input.chatId)
    const requestHash = hash({ chatId: input.chatId, name: input.name ?? conversation.name })
    const prior = this.row(input.chatId)
    if (prior) {
      if (prior.publication_id !== input.publicationId || prior.request_hash !== requestHash) throw new NetError('conflict')
      return this.checked(input.chatId)
    }
    if (rt.db.database.prepare('SELECT 1 FROM net_chat_publications WHERE profile=? AND publication_id=?').get(this.options.profileId, input.publicationId)) throw new NetError('conflict')
    const self = rt.identity.self()
    if (!self?.isAuthority || !rt.keys.rootKey()) throw new NetError('forbidden')
    if (!rt.keys.encryptedAtRest() || rt.keys.state() !== 'unlocked') throw new NetError('keystore_locked')
    const spaces = this.options.spaces()
    rt.db.transaction(() => {
      this.options.chats.assertPublishable(input.chatId)
      if (Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_publications').get()!.n) >= 10000) throw new NetError('too_large')
      rt.db.charge(1, 1024)
      rt.db.database.prepare("INSERT INTO net_chat_publications VALUES(?,?,?,?,'publishing',?,NULL,NULL,?,?)").run(this.options.profileId, input.chatId, input.publicationId, requestHash, self.user, conversation.messages.length, conversation.messages.at(-1)?.id ?? null)
      rt.db.checkpoint('chats.publication.reserved')
      const created = spaces.host.create({ name: input.name ?? conversation.name })
      const channel = spaces.host.createChannel(created.space, 'general')
      rt.db.checkpoint('chats.publication.hostCreated')
      rt.db.charge(1)
      rt.db.database.prepare("UPDATE net_chat_publications SET state='published',space=?,channel=? WHERE profile=? AND chat=?").run(created.space, channel, this.options.profileId, input.chatId)
      rt.db.checkpoint('chats.publication.beforeCommit')
    })
    // Losing the reply or the local display cannot undo the committed dispatch fence.
    rt.db.checkpoint('chats.publication.afterCommit')
    return this.checked(input.chatId)
  }
  private checked(id: string): ChatNetworkBinding {
    const binding = this.binding(id)
    if (!binding) throw new NetError('stream_unknown')
    const rt = this.runtime(), spaces = this.options.spaces(), self = rt.identity.self(), descriptor = spaces.store.getStream(binding.channel), meta = spaces.meta.assertUsable(binding.space)
    if (!self || self.user !== binding.owner || !spaces.meta.member(binding.space, self.user)) throw new NetError('not_member')
    if (descriptor?.kind !== 'space.channel' || descriptor.space !== binding.space || spaces.store.head(descriptor.id).epoch !== meta.epoch || !spaces.meta.channel(binding.space, descriptor.id)) throw new NetError('conflict')
    if (!spaces.meta.canRead(binding.space, descriptor, self.user)) throw new NetError('forbidden')
    return binding
  }
  get(id: string, deliveryId?: EventId): ChatConversation {
    this.accepting()
    const binding = this.checked(id), rt = this.runtime(), spaces = this.options.spaces()
    const conversation = this.options.chats.get(id), head = spaces.store.head(binding.channel)
    const page = spaces.store.read(binding.channel, { epoch: head.epoch, seq: 0 }, head.seq, 256 * 1024)
    const records = page.records.slice(0, 128).map(record => ({ epoch: record.epoch, seq: record.seq, recvTs: record.recvTs, envelope: decodeEnvelope(record.envelope).envelope }))
    const last = records.at(-1), entry = deliveryId ? rt.outbox.get(deliveryId) : undefined
    if (deliveryId && (!entry || entry.stream !== binding.channel)) throw new NetError('conflict')
    return { ...conversation, network: { binding, head, records, ...(last && last.seq < head.seq ? { nextAfter: { epoch: last.epoch, seq: last.seq } } : {}),
      ...(entry ? { delivery: { id: entry.id, stream: entry.stream, state: entry.state, attempts: entry.attempts, createdAt: entry.createdAt, ...(entry.position ? { position: entry.position } : {}), ...(entry.error ? { error: entry.error } : {}) } } : {}) } }
  }
  send(input: ChatNetworkSendInput): Promise<ChatConversation> {
    this.accepting()
    const original = { ...input, ...(Array.isArray(input.mentions) ? { mentions: [...input.mentions] } : {}) }
    // Register ownership before any synchronous Host or flush callback can
    // admit effects or initiate profile shutdown.
    const work = Promise.resolve().then(() => { this.accepting(); return this.sendOriginal(original) })
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
    return work
  }
  private async sendOriginal(input: ChatNetworkSendInput): Promise<ChatConversation> {
    if (!chatId(input.chatId) || !clientKey(input.clientMessageId) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 60 * 1024 || Buffer.from(input.text).toString() !== input.text || input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.length > 16 || new Set(input.mentions).size !== input.mentions.length || input.mentions.some(bot => !isId('bot', bot)))) throw new DomainRpcError('invalid_params', 'Invalid published Group message')
    const rt = this.runtime()
    if (rt.db.inTransaction) throw new NetError('forbidden', 'Sending requires a committed original')
    const binding = this.checked(input.chatId), spaces = this.options.spaces()
    const requestHash = hash({ text: input.text, mentions: input.mentions ?? [] })
    const event = rt.db.transaction(() => {
      this.checked(input.chatId); spaces.meta.assertUsable(binding.space, true)
      const old = rt.db.database.prepare('SELECT event,request_hash FROM net_chat_message_keys WHERE profile=? AND chat=? AND client_key=?').get(this.options.profileId, input.chatId, input.clientMessageId)
      if (old) { if (old.request_hash !== requestHash) throw new NetError('conflict'); return old.event as EventId }
      if (Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_message_keys WHERE profile=? AND chat=?').get(this.options.profileId, input.chatId)!.n) >= 4096 || Number(rt.db.database.prepare('SELECT count(*) AS n FROM net_chat_message_keys').get()!.n) >= 100000) throw new NetError('too_large')
      for (const bot of input.mentions ?? []) if (!spaces.meta.bot(binding.space, bot)) throw new NetError('forbidden')
      const id = spaces.client.post(binding.channel, input.text, input.mentions?.length ? { mentions: input.mentions } : undefined)
      rt.db.charge(1, Buffer.byteLength(json(input)))
      rt.db.database.prepare('INSERT INTO net_chat_message_keys VALUES(?,?,?,?,?)').run(this.options.profileId, input.chatId, input.clientMessageId, requestHash, id)
      rt.db.checkpoint('chats.message.beforeCommit')
      return id
    })
    rt.db.checkpoint('chats.message.afterCommit')
    await spaces.flush(binding.space)
    this.accepting()
    return this.get(input.chatId, event)
  }
  activeCount(): number { return this.pending.size }
  beginShutdown(): void { this.stopped = true }
  private accepting(): void { if (this.stopped) throw new NetError('cancelled') }
  async close(): Promise<void> { this.beginShutdown(); await Promise.allSettled([...this.pending]) }
}
