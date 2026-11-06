import type { BotChatMessage, BotChip, BotDetail, BotSummary } from './chat'
import type { BotLook } from './look'
import type { BotMemoryForgetResult, BotMemoryListing } from './memory'

/**
 * The personal-bot methods (PR 6 §4): profile-bound, apart from the Space-bot `bots.*` set and
 * not behind `net.v1`. Walls and escalation (6c-2) add `bots.escalations.*`, `continue`, `markDone`
 * and `bots.context.reset`.
 * These v1 form methods are no longer registered for clients (the v2 set below is); they stay
 * engine functions that tests use.
 */
export const BOTS_PERSONAL_METHODS = [
  'bots.definitions.list',
  'bots.definitions.get',
  'bots.definitions.save',
  'bots.definitions.publish',
  'bots.definitions.delete',
  'bots.approve',
  'bots.revoke',
  'bots.activate',
  'bots.activations.list',
  'bots.activations.get',
  'bots.activations.stop',
  'bots.activations.continue',
  'bots.activations.markDone',
  'bots.escalations.list',
  'bots.escalations.respond',
  'bots.context.reset'
] as const
export type BotsPersonalMethod = (typeof BOTS_PERSONAL_METHODS)[number]
export const BOTS_PERSONAL_CAPABILITY = 'bots.personal.v1'
/** Events of the personal-bot methods: `bots.changed` after every change, `bots.escalation` when a wall asks the owner. */
export const BOTS_PERSONAL_EVENTS = ['bots.changed', 'bots.escalation'] as const

/**
 * The Bot UI methods (Bot Phase 1 §5.11). No payload carries a model or an instance id, apart from
 * `BotError.action.instanceId` (a Sign in button). `bots.activate` stays internal, and
 * `bots.memory.reindex` is an engine function (`BotMemoryAdmin.reindex`) until Phase 2. The list,
 * pause and resume methods are `bots.personal.*`: `bots.list` and `bots.resume` already name the
 * Space-bot methods (`BOTS_LOCAL_METHODS`), and a method has one handler.
 */
export const BOTS_PERSONAL_V2_METHODS = [
  'bots.personal.list',
  'bots.create',
  'bots.get',
  'bots.update',
  'bots.personal.pause',
  'bots.personal.resume',
  'bots.delete',
  'bots.chat.list',
  'bots.chat.send',
  'bots.chat.stop',
  'bots.chat.markRead',
  'bots.asks.answer',
  'bots.permissions.revoke',
  'bots.schedules.remove',
  'bots.memory.list',
  'bots.memory.forget',
  'bots.memory.export'
] as const
export type BotsPersonalV2Method = (typeof BOTS_PERSONAL_V2_METHODS)[number]
export const BOTS_PERSONAL_V2_CAPABILITY = 'bots.personal.v2'

/** Most messages one `bots.chat.list` page returns. */
export const MAX_BOT_CHAT_PAGE = 100

/** An attachment the owner sends with a chat message: a file on this computer. */
export interface BotChatAttachment {
  name: string
  path: string
}

/** Each v2 method's params (`profileId` aside) and result. */
export interface BotsPersonalV2Api {
  'bots.personal.list': { params: Record<string, never>; result: { bots: BotSummary[] } }
  'bots.create': { params: { look: BotLook; name?: string; description: string; clientRequestId: string }; result: { bot: BotSummary } }
  'bots.get': { params: { botId: string }; result: BotDetail }
  'bots.update': { params: { botId: string; name?: string; look?: BotLook }; result: { bot: BotSummary } }
  'bots.personal.pause': { params: { botId: string }; result: { bot: BotSummary } }
  'bots.personal.resume': { params: { botId: string }; result: { bot: BotSummary } }
  /** Archives now; everything is purged at `purgeAt` (30 days). */
  'bots.delete': { params: { botId: string }; result: { purgeAt: string } }
  'bots.chat.list': {
    params: { botId: string; beforeSeq?: number; limit?: number }
    result: { messages: BotChatMessage[]; live?: { activationId: string; chip?: BotChip } }
  }
  'bots.chat.send': { params: { botId: string; text: string; attachments?: BotChatAttachment[]; clientRequestId: string }; result: { message: BotChatMessage } }
  'bots.chat.stop': { params: { botId: string }; result: Record<string, never> }
  'bots.chat.markRead': { params: { botId: string; seq: number }; result: Record<string, never> }
  'bots.asks.answer': { params: { botId: string; askId: string; answer: 'allow' | 'not_now' }; result: { message: BotChatMessage } }
  /** `permissionId` is a `BotDetail.permissions` item's id (its fingerprint). */
  'bots.permissions.revoke': { params: { botId: string; permissionId: string }; result: BotDetail }
  'bots.schedules.remove': { params: { botId: string; scheduleId: string }; result: BotDetail }
  'bots.memory.list': { params: { botId: string; history?: boolean }; result: BotMemoryListing }
  'bots.memory.forget': { params: { botId: string; id: string }; result: BotMemoryForgetResult }
  /** Writes `memory.md`, `memory.jsonl`, `journal.jsonl` and the definition into `dir`. */
  'bots.memory.export': { params: { botId: string; dir: string }; result: { files: string[] } }
}

export type BotsPersonalV2Params<M extends BotsPersonalV2Method> = BotsPersonalV2Api[M]['params']
export type BotsPersonalV2Result<M extends BotsPersonalV2Method> = BotsPersonalV2Api[M]['result']

/**
 * Events of the v2 methods. `bots.message` with an `ask` replaces `bots.escalation`, which is no
 * longer bridged to clients.
 */
export const BOTS_PERSONAL_V2_EVENTS = ['bots.changed', 'bots.message', 'bots.activity'] as const
export type BotsPersonalV2Event = (typeof BOTS_PERSONAL_V2_EVENTS)[number]

export interface BotsPersonalV2EventData {
  /** The list and the bot's state need refreshing. */
  'bots.changed': { botId: string }
  /** A new or changed chat row: chat push and notifications. */
  'bots.message': { botId: string; message: BotChatMessage }
  /** The live chip of a working activation; null clears it. */
  'bots.activity': { botId: string; activationId: string; chip: BotChip | null }
}
