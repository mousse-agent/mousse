import { createHash } from 'node:crypto'
import type { BotAdmissionOutput, AuthorizedMention, PlannedBotOutput } from './service'
import type { BotExecutionBinding, ExecutionRecord, IdentityService, KeyStore, MetaProjection, Outbox, PrivateStreamKeys, StreamStore } from '../../net/contracts'
import type { Envelope, EventId, EventType, ExecutionId, StreamId } from '../../../shared/net'
import { NetError, newId, validateEventBody } from '../../../shared/net'
import { canonicalJson, decodeEnvelope } from '../../net/sync/codec'
import type { PrivateSpaceService } from '../../spaces/private'
import { privateContentAAD } from '../../spaces/private/service'
import { NetDatabase } from '../../net/store/database'
export interface PreparedBotReceipt { id: EventId; stream: StreamId; envelope: Uint8Array; sig: Uint8Array }
export interface BotOutboxOptions {
  db: NetDatabase; identity: IdentityService; keys: KeyStore; meta: MetaProjection; private?: PrivateSpaceService; privateKeys?: PrivateStreamKeys; store: StreamStore; outbox: Outbox
  plan(mention: AuthorizedMention): PlannedBotOutput
  /** Root installs any domain binding alongside receipt. No I/O/async allowed. */
  stage?(mention: AuthorizedMention, record: ExecutionRecord, plan: PlannedBotOutput): void
}
/** Actual signed bot receipts. Private nonce reservation always precedes the journal transaction. */
export class BotOutbox implements BotAdmissionOutput {
  constructor(readonly options: BotOutboxOptions) {}
  plan(mention: AuthorizedMention): PlannedBotOutput { return this.options.plan(mention) }
  prepareAccepted(mention: AuthorizedMention, execution: ExecutionId, plan: PlannedBotOutput): PreparedBotReceipt {
    return this.prepare(mention, execution, plan.stream, 'bot.run.accepted', { title: plan.visibilityEpoch === undefined ? 'Bot run' : 'Private bot run' }, plan.visibilityEpoch !== undefined)
  }
  prepareExpired(mention: AuthorizedMention, execution: ExecutionId): PreparedBotReceipt {
    return this.prepare(mention, execution, mention.input.stream, 'bot.run.expired', {}, mention.descriptor.kind === 'space.private')
  }
  accepted(mention: AuthorizedMention, record: ExecutionRecord, plan: PlannedBotOutput, prepared: unknown): void {
    this.requireTransaction(); const event = this.check(prepared, record, plan.stream, 'bot.run.accepted')
    if (plan.visibilityEpoch === undefined) this.options.store.createStream({ id: plan.stream, kind: 'space.thread', space: mention.bot.space, parent: mention.input.stream, authority: mention.descriptor.authority, createdAt: decodeEnvelope(event.envelope).envelope.ts }, this.options.meta.state(mention.bot.space)!.descriptor.epoch)
    if (!this.options.store.getStream(plan.stream)) throw new NetError('stream_unknown')
    this.options.stage?.(mention, record, plan); this.options.outbox.enqueue(event)
  }
  expired(mention: AuthorizedMention, record: ExecutionRecord, prepared: unknown): void {
    this.requireTransaction(); const event = this.check(prepared, record, mention.input.stream, 'bot.run.expired'); this.options.outbox.enqueue(event)
  }
  prepareTerminal(mention: AuthorizedMention, execution: ExecutionId, binding: BotExecutionBinding, type: EventType, body: unknown): PreparedBotReceipt {
    this.privateBinding(binding)
    return this.prepare(mention, execution, binding.stream, type, body, binding.visibilityEpoch !== undefined)
  }
  enqueueTerminal(record: ExecutionRecord, prepared: PreparedBotReceipt): void {
    this.requireTransaction(); if (!record.binding) throw new NetError('forbidden'); this.privateBinding(record.binding); const envelope = decodeEnvelope(prepared.envelope).envelope
    if (envelope.refs?.execution !== record.id || envelope.stream !== record.binding.stream || envelope.refs.replyTo !== record.trigger || envelope.author.bot !== record.target) throw new NetError('forbidden')
    this.options.outbox.enqueue(prepared)
  }
  private privateBinding(binding: BotExecutionBinding): void {
    if (binding.visibilityEpoch === undefined) return
    const state = this.options.private?.state(binding.stream), meta = this.options.meta.state(binding.space)
    if (!state || state.blocked || state.control.visibilityEpoch !== binding.visibilityEpoch || createHash('sha256').update(canonicalJson(state.control.participants)).digest('base64url') !== binding.participantHash || !state.control.participants.includes(binding.bot) || !meta?.bots.has(binding.bot)) throw new NetError('forbidden')
  }
  private prepare(mention: AuthorizedMention, execution: ExecutionId, stream: StreamId, type: EventType, body: unknown, sealed: boolean): PreparedBotReceipt {
    if (this.options.db.inTransaction) throw new NetError('bad_request', 'Prepare signed private receipts outside SQL.')
    if (!validateEventBody(type as any, body)) throw new NetError('bad_request')
    const self = this.options.identity.self(); if (!self || self.node !== mention.bot.hostNode) throw new NetError('bad_delegation')
    const envelope: Envelope = { v: 1, minor: 0, id: newId('event'), stream, type, crit: false, author: { bot: mention.bot.bot, node: self.node, keyEpoch: mention.bot.placementEpoch }, ts: this.options.db.clock.now(), auth: { metaEpoch: this.options.meta.state(mention.bot.space)!.applied.epoch, metaSeq: this.options.meta.state(mention.bot.space)!.applied.seq }, refs: { execution, subject: mention.envelope.id, replyTo: mention.envelope.id, thread: stream } }
    if (sealed) { if (!this.options.privateKeys) throw new NetError('forbidden'); envelope.sealed = this.options.privateKeys.seal(stream, canonicalJson(body), privateContentAAD(envelope)) } else envelope.body = body
    const bytes = canonicalJson(envelope); decodeEnvelope(bytes)
    return { id: envelope.id, stream, envelope: bytes, sig: this.options.keys.signAsBot(mention.bot.bot, bytes) }
  }
  private check(prepared: unknown, record: ExecutionRecord, stream: StreamId, type: EventType): PreparedBotReceipt {
    const event = prepared as PreparedBotReceipt, envelope = decodeEnvelope(event.envelope).envelope
    if (envelope.type !== type || envelope.id !== event.id || envelope.stream !== stream || envelope.refs?.execution !== record.id || envelope.refs.replyTo !== record.trigger || envelope.author.bot !== record.target) throw new NetError('forbidden')
    this.options.identity.verifyAuthor(envelope.author, event.envelope, event.sig, envelope.ts, 'newWork'); return event
  }
  private requireTransaction(): void { if (!this.options.db.inTransaction) throw new NetError('bad_request') }
}
