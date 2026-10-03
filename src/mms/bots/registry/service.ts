import type { BotRuntimeAdapter, BudgetLedger, IdentityService, KeyStore, MetaProjection } from '../../net/contracts'
import type { Base64Url, BotAudiencePolicy, BotDelegation, BotId, BotProfile, NodeId, SpaceId, UserId } from '../../../shared/net'
import { BOT_PROFILES, isId, NetError } from '../../../shared/net'
import { NetDatabase, integer, json } from '../../net/store/database'
import { decodeBase64 } from '../../net/identity/crypto'
export interface BotConfiguration {
  space: SpaceId; bot: BotId; adapter: string; profile: BotProfile
  definitionRevision: string; profileDigest: Base64Url
  dailyBudgetUnits: number; runCeilingUnits: number; maxConcurrent: number; runsPerMemberHour: number
  /** Local owner selection; remote DTOs never contain project roots. */
  projectId?: string
}
export interface LocalBot extends BotConfiguration {
  owner: UserId; hostNode: NodeId; placementEpoch: number; activationHostTs: number
  revision: number; stopped: boolean; qualified: boolean
}
export interface ActiveBot extends LocalBot { delegation: BotDelegation; policy: BotAudiencePolicy }
export interface BotRegistryOptions {
  db: NetDatabase; identity: IdentityService; keys: KeyStore; meta: MetaProjection; budgets: BudgetLedger
  adapters: ReadonlyMap<string, BotRuntimeAdapter>
}
/** Owner configuration and executor-local evidence. The meta registry alone never qualifies a runtime. */
export class SqliteBotRegistry {
  private listeners = new Set<(bot: BotId) => void>()
  constructor(readonly options: BotRegistryOptions) {
    options.db.transaction(() => options.db.database.exec('CREATE TABLE IF NOT EXISTS net_bot_registry(space TEXT NOT NULL,bot TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(space,bot))'))
  }
  onChanged(listener: (bot: BotId) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get(space: SpaceId, bot: BotId): LocalBot | undefined {
    const row = this.options.db.database.prepare('SELECT record FROM net_bot_registry WHERE space=? AND bot=?').get(space, bot)
    return row ? JSON.parse(row.record as string) : undefined
  }
  list(): LocalBot[] { return this.options.db.database.prepare('SELECT record FROM net_bot_registry ORDER BY space,bot').all().map(row => JSON.parse(row.record as string)) }
  configure(input: BotConfiguration, activationHostTs: number): LocalBot {
    this.validate(input); integer(activationHostTs)
    const self = this.options.identity.self(), bot = this.options.meta.state(input.space)?.bots.get(input.bot)
    if (!self || !bot || bot.owner !== self.user || bot.delegation.hostNode !== self.node || bot.profile !== input.profile) throw new NetError('forbidden')
    this.verifyCurrent(bot.delegation)
    return this.options.db.transaction(() => {
      const old = this.get(input.space, input.bot)
      if (old && (old.owner !== bot.owner || old.hostNode !== self.node || old.placementEpoch > bot.delegation.keyEpoch || old.placementEpoch === bot.delegation.keyEpoch && old.activationHostTs !== activationHostTs)) throw new NetError('conflict')
      const record: LocalBot = { ...structuredClone(input), owner: bot.owner, hostNode: self.node, placementEpoch: bot.delegation.keyEpoch, activationHostTs, revision: integer((old?.revision ?? 0) + 1, 1), stopped: old?.stopped ?? false, qualified: false }
      // Definition changes always require explicit fresh qualification evidence.
      this.options.budgets.setDailyBudget(input.bot, input.space, input.dailyBudgetUnits)
      this.save(record); return record
    })
  }
  /** Owner-reviewed provider/tool/version evidence: supports() remains an independent live gate. */
  qualify(space: SpaceId, bot: BotId, definitionRevision: string, profileDigest: Base64Url): void {
    this.options.db.transaction(() => {
      const record = this.required(space, bot)
      if (record.definitionRevision !== definitionRevision || record.profileDigest !== profileDigest || !this.options.adapters.get(record.adapter)?.supports(record.profile)) throw new NetError('profile_unsupported')
      this.assertOwner(record); this.verifyPlacement(record)
      record.qualified = true; record.revision++; this.save(record)
    })
  }
  invalidate(bot: BotId): void {
    for (const record of this.list().filter(r => r.bot === bot && r.qualified)) this.options.db.transaction(() => { record.qualified = false; record.revision++; this.save(record) })
  }
  stop(space: SpaceId, bot: BotId, stopped = true): void {
    this.options.db.transaction(() => { const record = this.required(space, bot); this.assertOwner(record); record.stopped = stopped; record.revision++; this.save(record) })
  }
  current(space: SpaceId, bot: BotId): ActiveBot {
    const record = this.required(space, bot)
    if (record.stopped) throw new NetError('cancelled')
    if (!record.qualified || !this.options.adapters.get(record.adapter)?.supports(record.profile)) throw new NetError('profile_unsupported')
    const projected = this.verifyPlacement(record)
    return { ...record, delegation: projected.delegation, policy: projected.policy }
  }
  private verifyPlacement(record: LocalBot) {
    const projected = this.options.meta.state(record.space)?.bots.get(record.bot)
    const self = this.options.identity.self()
    if (!self || !projected || projected.owner !== record.owner || projected.profile !== record.profile || projected.delegation.hostNode !== self.node || record.hostNode !== self.node || projected.delegation.keyEpoch !== record.placementEpoch) throw new NetError('bad_delegation')
    this.verifyCurrent(projected.delegation); return projected
  }
  private verifyCurrent(delegation: BotDelegation): void {
    const bytes = new TextEncoder().encode('mousse-net/current-bot-placement/v1'), signature = this.options.keys.signAsBot(delegation.subject, bytes)
    const verified = this.options.identity.verifyAuthor({ bot: delegation.subject, node: delegation.hostNode, keyEpoch: delegation.keyEpoch }, bytes, signature, this.options.db.clock.now(), 'newWork')
    if (verified.kind !== 'bot' || verified.user !== delegation.owner || verified.delegation.keys.sign !== delegation.keys.sign) throw new NetError('bad_delegation')
  }
  private assertOwner(record: LocalBot): void { if (this.options.identity.self()?.user !== record.owner) throw new NetError('forbidden') }
  private required(space: SpaceId, bot: BotId): LocalBot { return this.get(space, bot) ?? (() => { throw new NetError('forbidden') })() }
  private save(record: LocalBot): void {
    const text = json(record); this.options.db.charge(1, Buffer.byteLength(text)); this.options.db.database.prepare('INSERT INTO net_bot_registry VALUES(?,?,?) ON CONFLICT(space,bot) DO UPDATE SET record=excluded.record').run(record.space, record.bot, text)
    this.options.db.afterCommit(() => { for (const listener of this.listeners) listener(record.bot) })
  }
  private validate(input: BotConfiguration): void {
    if (!isId('space', input.space) || !isId('bot', input.bot) || !BOT_PROFILES.includes(input.profile) || !input.adapter || input.adapter.length > 128 || !input.definitionRevision || input.definitionRevision.length > 256 || input.projectId !== undefined && (!input.projectId || input.projectId.length > 256) || input.profile === 'chat' && input.projectId !== undefined || input.profile === 'reader' && input.projectId === undefined) throw new NetError('bad_request')
    if (input.profile === 'operator') throw new NetError('profile_unsupported')
    decodeBase64(input.profileDigest, 32)
    integer(input.dailyBudgetUnits, 1); integer(input.runCeilingUnits, 1); integer(input.maxConcurrent, 1); integer(input.runsPerMemberHour, 1)
    if (input.runCeilingUnits > input.dailyBudgetUnits || input.maxConcurrent > 32 || input.runsPerMemberHour > 1000) throw new NetError('bad_request')
  }
}
