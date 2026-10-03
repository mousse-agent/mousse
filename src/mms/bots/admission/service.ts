import { createHash } from 'node:crypto'
import type { AdmitOutcome, BotExecutionBinding, Clock, CompartmentStore, ExecutionLedger, ExecutionRecord, IdentityService, MetaProjection, QualifiedClockEstimate, StreamStore, BudgetLedger } from '../../net/contracts'
import type { BotId, Envelope, ExecutionId, SpaceId, StoredRecord, StreamDescriptor, StreamHead, StreamId, UserId } from '../../../shared/net'
import { NetError, newId } from '../../../shared/net'
import { decodeEnvelope, canonicalJson } from '../../net/sync/codec'
import { NetDatabase, same, json } from '../../net/store/database'
import type { ActiveBot, SqliteBotRegistry } from '../registry'
import type { PrivateSpaceService } from '../../spaces/private'
export interface ConfirmedMetaHead { head: StreamHead; confirmedAtMonotonic: number }
export interface AdmissionInput { stream: StreamId; bot: BotId; record: StoredRecord; source: 'delivery' | 'replay' }
export interface AuthorizedMention { input: AdmissionInput; descriptor: StreamDescriptor; envelope: Envelope; body: { text: string }; author: UserId; bot: ActiveBot; hostNow: number }
export interface PlannedBotOutput {
  stream: StreamId; compartment: string; backingThreadId: string; workspaceId: string
  visibilityEpoch?: number; participantHash?: string
}
export interface BotAdmissionOutput {
  /** Pure bounded plan; no filesystem/model/network effects. */
  plan(mention: AuthorizedMention): PlannedBotOutput
  /** Shared SQL transaction. Must register/bind output and enqueue exactly one signed receipt. */
  prepareAccepted(mention: AuthorizedMention, execution: ExecutionId, plan: PlannedBotOutput): unknown
  prepareExpired(mention: AuthorizedMention, execution: ExecutionId): unknown
  accepted(mention: AuthorizedMention, record: ExecutionRecord, plan: PlannedBotOutput, prepared: unknown): void
  expired(mention: AuthorizedMention, record: ExecutionRecord, prepared: unknown): void
}
export interface BotAdmissionOptions {
  profileId: string; db: NetDatabase; clock: Clock; identity: IdentityService; store: StreamStore; meta: MetaProjection
  registry: SqliteBotRegistry; executions: ExecutionLedger; budgets: BudgetLedger; compartments: CompartmentStore
  private?: PrivateSpaceService
  confirmedMeta(space: SpaceId): ConfirmedMetaHead | undefined
  clockEstimate(space: SpaceId): QualifiedClockEstimate | undefined
  output: BotAdmissionOutput
}
class WindowChanged extends Error {}
/** Only ordinary durable delivery/replay reaches this service. Snapshot installation is display-only. */
export class BotAdmissionService {
  constructor(readonly options: BotAdmissionOptions) {
    options.db.transaction(() => options.db.database.exec(`
      CREATE TABLE IF NOT EXISTS net_bot_admission_context(execution TEXT PRIMARY KEY,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS net_bot_admission_slots(execution TEXT PRIMARY KEY,bot TEXT NOT NULL,space TEXT NOT NULL,member TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)));
      CREATE TABLE IF NOT EXISTS net_bot_admission_rates(bot TEXT NOT NULL,space TEXT NOT NULL,member TEXT NOT NULL,hour INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(bot,space,member,hour));
    `))
  }
  admit(input: AdmissionInput): AdmitOutcome | { kind: 'expired'; record: ExecutionRecord } { return this.prepareAndAdmit(input,0) }
  private prepareAndAdmit(input: AdmissionInput, attempts: number): AdmitOutcome | { kind: 'expired'; record: ExecutionRecord } {
    if(attempts>1)throw new NetError('clock_skew')
    if (this.options.db.inTransaction) throw new NetError('bad_request', 'Admission must own its external boundary.')
    if (!['delivery','replay'].includes(input.source)) throw new NetError('forbidden')
    // Defensive copies prevent caller mutation between preparation and the serialized checks.
    input = { ...input, record: { ...input.record, envelope: new Uint8Array(input.record.envelope), sig: new Uint8Array(input.record.sig) } }
    const mention = this.authorize(input), key = { scope: mention.bot.space, target: input.bot, trigger: mention.envelope.id }, payloadHash = createHash('sha256').update(input.record.envelope).digest('hex')
    const duplicate = this.options.executions.find(key)
    if (duplicate) { if (duplicate.payloadHash !== payloadHash) throw new NetError('conflict'); return { kind: 'duplicate', record: duplicate } }
    const hostNow = this.hostNow(mention.bot.space), age = hostNow - input.record.recvTs, delay = input.record.recvTs - mention.envelope.ts
    if (age < 0 || delay < 0) throw new NetError('clock_skew')
    mention.hostNow = hostNow
    const execution = newId('execution')
    if (age > 30000 || delay > 120000) {
      const prepared = this.options.output.prepareExpired(mention, execution)
      try{return this.options.db.transaction(() => {
        this.revalidate(mention)
        if(!this.windowExpired(mention))throw new WindowChanged()
        return this.options.executions.expire(key, payloadHash, this.options.clock.now(), record => this.options.output.expired(mention, record, prepared), execution)
      })}catch(error){if(error instanceof WindowChanged)return this.prepareAndAdmit(input,attempts+1);throw error}
    }
    if (input.record.recvTs < mention.bot.activationHostTs) throw new NetError('bad_delegation')
    const plan = this.options.output.plan(mention), prepared = this.options.output.prepareAccepted(mention, execution, plan)
    try{return this.options.db.transaction(() => {
      this.revalidate(mention)
      if(this.windowExpired(mention))throw new WindowChanged()
      return this.options.executions.admit(key, payloadHash, this.options.clock.now(), record => {
        const active = Number(this.options.db.database.prepare('SELECT count(*) AS n FROM net_bot_admission_slots WHERE bot=? AND active=1').get(input.bot)!.n)
        if (active >= mention.bot.maxConcurrent) throw new NetError('rate_limited')
        const hour = Math.floor(mention.hostNow / 3600000), prior = Number(this.options.db.database.prepare('SELECT count FROM net_bot_admission_rates WHERE bot=? AND space=? AND member=? AND hour=?').get(input.bot, mention.bot.space, mention.author, hour)?.count ?? 0)
        if (prior >= mention.bot.runsPerMemberHour) throw new NetError('rate_limited')
        this.options.budgets.reserve(input.bot, mention.bot.space, record.id, mention.bot.runCeilingUnits, this.options.clock.now())
        const binding: BotExecutionBinding = { profileId: this.options.profileId, space: mention.bot.space, bot: input.bot, stream: plan.stream, compartment: plan.compartment, backingThreadId: plan.backingThreadId, workspaceId: plan.workspaceId, definitionRevision: mention.bot.definitionRevision, profileDigest: mention.bot.profileDigest, ...(plan.visibilityEpoch === undefined ? {} : { visibilityEpoch: plan.visibilityEpoch }), ...(plan.participantHash === undefined ? {} : { participantHash: plan.participantHash }) }
        this.validatePlan(mention, plan)
        this.options.compartments.bind(plan.compartment, { profileId: this.options.profileId, space: mention.bot.space, bot: input.bot, ...(plan.visibilityEpoch === undefined ? {} : { privateStream: plan.stream, visibilityEpoch: plan.visibilityEpoch, participantHash: plan.participantHash }) })
        this.options.executions.bindRun(record.id, binding)
        const context = json({ input: { ...input, record: { ...input.record, envelope: Buffer.from(input.record.envelope).toString('base64url'), sig: Buffer.from(input.record.sig).toString('base64url') } }, botRevision: mention.bot.revision, botPolicy: mention.bot.policy })
        this.options.db.charge(3, Buffer.byteLength(context))
        this.options.db.database.prepare('INSERT INTO net_bot_admission_context VALUES(?,?)').run(record.id, context)
        this.options.db.database.prepare('INSERT INTO net_bot_admission_slots VALUES(?,?,?,?,1)').run(record.id, input.bot, mention.bot.space, mention.author)
        this.options.db.database.prepare('INSERT INTO net_bot_admission_rates VALUES(?,?,?,?,?) ON CONFLICT(bot,space,member,hour) DO UPDATE SET count=excluded.count').run(input.bot, mention.bot.space, mention.author, hour, prior + 1)
        this.options.db.checkpoint('bots.admit.beforeReceipt')
        this.options.output.accepted(mention, { ...record, binding }, plan, prepared)
      }, execution)
    })}catch(error){if(error instanceof WindowChanged)return this.prepareAndAdmit(input,attempts+1);throw error}
  }
  /** After process/effects are actually quiesced, never merely after a cancel request. */
  release(execution: ExecutionId): void {
    if (!this.options.db.inTransaction) throw new NetError('bad_request')
    const record = this.options.executions.get(execution)
    if (!record || !['completed','failed','cancelled','uncertain'].includes(record.state)) throw new NetError('conflict')
    this.options.db.charge(1); this.options.db.database.prepare('UPDATE net_bot_admission_slots SET active=0 WHERE execution=?').run(execution)
  }
  mentionForExecution(execution: ExecutionId): AuthorizedMention {
    const row = this.options.db.database.prepare('SELECT context FROM net_bot_admission_context WHERE execution=?').get(execution)
    if (!row) throw new NetError('forbidden')
    const context = JSON.parse(row.context as string), input = context.input as AdmissionInput
    input.record.envelope = Buffer.from(context.input.record.envelope, 'base64url'); input.record.sig = Buffer.from(context.input.record.sig, 'base64url')
    const mention = this.authorize(input)
    if (mention.bot.revision !== context.botRevision || !same(mention.bot.policy, context.botPolicy)) throw new NetError('forbidden')
    return mention
  }
  /** Admission window is deliberately absent from execution continuation. */
  assertExecutionCurrent(execution: ExecutionId): ActiveBot {
    const record = this.options.executions.get(execution), binding = record?.binding
    if (!record || !binding || !['accepted','running','waitingApproval'].includes(record.state)) throw new NetError('forbidden')
    return this.assertAuthorityCurrent(execution)
  }
  /** Publication/terminal transaction gate; does not authorize model dispatch on terminal states. */
  assertAuthorityCurrent(execution: ExecutionId): ActiveBot {
    const record = this.options.executions.get(execution), binding = record?.binding
    if (!record || !binding) throw new NetError('forbidden')
    const bot = this.mentionForExecution(execution).bot, meta = this.usableMeta(binding.space)
    if (binding.profileId !== this.options.profileId || binding.definitionRevision !== bot.definitionRevision || binding.profileDigest !== bot.profileDigest) throw new NetError('forbidden')
    const row = this.options.db.database.prepare('SELECT member FROM net_bot_admission_slots WHERE execution=? AND active=1').get(execution)
    if (!row || !meta.members.has(row.member as UserId) || !this.options.meta.canSteer(binding.space, binding.bot, row.member as UserId)) throw new NetError('forbidden')
    if (binding.visibilityEpoch !== undefined) {
      const state = this.options.private?.state(binding.stream)
      if (!state || state.blocked || state.control.visibilityEpoch !== binding.visibilityEpoch || this.participantHash(state.control.participants) !== binding.participantHash || !state.control.participants.includes(binding.bot) || !state.control.participants.includes(row.member as UserId)) throw new NetError('forbidden')
    }
    return bot
  }
  private authorize(input: AdmissionInput): AuthorizedMention {
    const descriptor = this.options.store.getStream(input.stream), envelope = decodeEnvelope(input.record.envelope).envelope
    if (!descriptor?.space || !['space.channel','space.thread','space.private'].includes(descriptor.kind) || envelope.stream !== descriptor.id || envelope.type !== 'message.posted' || envelope.minor !== 0 || envelope.author.bot || !envelope.author.user || !envelope.refs?.mentions?.includes(input.bot) || envelope.origin !== undefined) throw new NetError('forbidden')
    // The current host registration/read proof covers channel→thread only. A nested child cannot be published safely yet.
    if(descriptor.kind==='space.thread')throw new NetError('forbidden','Nested public bot reply routing has not been qualified.')
    const persisted = this.options.store.getById(input.stream, envelope.id)
    if (!persisted || persisted.epoch !== input.record.epoch || persisted.seq !== input.record.seq || persisted.recvTs !== input.record.recvTs || !Buffer.from(persisted.envelope).equals(input.record.envelope) || !Buffer.from(persisted.sig).equals(input.record.sig)) throw new NetError('forbidden')
    const bot = this.options.registry.current(descriptor.space, input.bot), meta = this.usableMeta(descriptor.space)
    const author = this.options.identity.verifyAuthor(envelope.author, input.record.envelope, input.record.sig, envelope.ts, 'newWork')
    if (author.kind !== 'node' || !meta.members.has(author.user) || this.options.identity.pinnedRootKey(author.user) !== meta.members.get(author.user)!.rootKey || !this.options.meta.canSteer(descriptor.space, input.bot, author.user) || bot.profile === 'operator' && author.user !== bot.owner || !envelope.auth || envelope.auth.metaEpoch !== meta.applied.epoch || envelope.auth.metaSeq > meta.applied.seq) throw new NetError('forbidden')
    let body: { text: string }
    if (descriptor.kind === 'space.private') {
      const state = this.options.private?.state(input.stream)
      if (!state || state.blocked || !envelope.sealed || envelope.sealed.keyEpoch !== state.control.keyEpoch || !state.control.participants.includes(input.bot) || !state.control.participants.includes(author.user) || !state.control.participants.includes(bot.owner)) throw new NetError('forbidden')
      body = this.options.private!.open(input.stream, input.record) as { text: string }
    } else {
      if (!this.options.meta.canRead(descriptor.space, descriptor, author.user) || !this.options.meta.canRead(descriptor.space, descriptor, bot.owner) || !envelope.body || envelope.sealed) throw new NetError('forbidden')
      body = envelope.body as { text: string }
    }
    if (typeof body.text !== 'string' || Buffer.byteLength(body.text) > 65536) throw new NetError('too_large')
    return { input, descriptor, envelope, body, author: author.user, bot, hostNow: 0 }
  }
  private windowExpired(mention:AuthorizedMention):boolean {
    mention.hostNow=this.hostNow(mention.bot.space)
    const age=mention.hostNow-mention.input.record.recvTs,delay=mention.input.record.recvTs-mention.envelope.ts
    if(age<0||delay<0)throw new NetError('clock_skew')
    return age>30000||delay>120000
  }
  private revalidate(mention: AuthorizedMention): void {
    const fresh = this.authorize(mention.input)
    if (!same(fresh.bot, mention.bot) || !same(fresh.descriptor, mention.descriptor) || !same(fresh.body, mention.body)) throw new NetError('conflict')
  }
  private usableMeta(space: SpaceId) {
    const meta = this.options.meta.state(space), confirmed = this.options.confirmedMeta(space), now = this.options.clock.monotonic()
    if (!meta || meta.frozen || meta.upgradeRequired) throw new NetError(meta?.upgradeRequired ? 'upgrade_required' : 'space_frozen')
    if (!confirmed || !Number.isFinite(confirmed.confirmedAtMonotonic) || now < confirmed.confirmedAtMonotonic || now - confirmed.confirmedAtMonotonic > 30000 || confirmed.head.epoch !== meta.descriptor.epoch || meta.applied.epoch !== confirmed.head.epoch || meta.applied.seq < confirmed.head.seq) throw new NetError('meta_stale')
    return meta
  }
  private hostNow(space: SpaceId): number {
    const sample = this.options.clockEstimate(space), now = this.options.clock.monotonic()
    if (!sample || !Object.values(sample).every(Number.isFinite) || now < sample.measuredAtMonotonic || now - sample.measuredAtMonotonic > 30000 || sample.rttMs < 0 || sample.rttMs > 5000 || Math.abs(sample.wallDeltaMs) > 1000 || Math.abs(sample.offsetMs) > 60000) throw new NetError('clock_skew')
    return this.options.clock.now() + sample.offsetMs
  }
  private validatePlan(mention: AuthorizedMention, plan: PlannedBotOutput): void {
    const privateRun = mention.descriptor.kind === 'space.private' || mention.bot.policy.visibility === 'private'
    if (!plan.backingThreadId || !plan.workspaceId || privateRun !== (plan.visibilityEpoch !== undefined)) throw new NetError('forbidden')
    if (privateRun) {
      const state = this.options.private?.state(plan.stream)
      if (mention.descriptor.kind === 'space.private' && plan.stream !== mention.input.stream) throw new NetError('forbidden')
      if (mention.descriptor.kind !== 'space.private' && state && !same(state.control.participants, [...new Set([mention.bot.owner, mention.author, mention.bot.bot])].sort())) throw new NetError('forbidden')
      if (!state || state.blocked || state.control.visibilityEpoch !== plan.visibilityEpoch || this.participantHash(state.control.participants) !== plan.participantHash || !state.control.participants.includes(mention.bot.bot) || !state.control.participants.includes(mention.author) || !state.control.participants.includes(mention.bot.owner)) throw new NetError('forbidden')
    }
  }
  private participantHash(participants: Array<string>): string { return createHash('sha256').update(canonicalJson([...participants].sort())).digest('base64url') }
}
