import type { BotModelPick, BotModelSlotKey, BotModelSlots, BotPickCredential, BotSchedule } from './definition'
import type { BotChatMessage, BotChip, BotDetail, BotSummary } from './chat'
import type { BotLook } from './look'
import type { BotMemoryForgetResult, BotMemoryListing } from './memory'
import type { LlmProviderOption } from '../../settings'

/** A computer on a bot's About and create row: this one (`this_computer`), or another of the person's computers by node. */
export interface BotComputerChoice {
  id: string
  name: string
  offline?: true
  /** Why it cannot be picked; absent for the computer that holds the bot. */
  unavailable?: string
}

/**
 * One model a bot's row can be given by hand (#673), in the daemon: an entry's model, with the reasoning levels it
 * offers and what the entry is signed in with now (stamped on a pick when it is saved). The same model on two entries
 * is two options, told apart by `entry`. Clients get `BotRunsOnChoices.providers` instead.
 */
export interface BotModelOption {
  instanceId: string
  /** The entry's name, as Settings → Providers shows it. */
  entry: string
  model: string
  /** The model's own name. */
  label: string
  /** The reasoning levels it offers, lowest first; empty when it has none to pick. */
  efforts: string[]
  credential?: BotPickCredential
  account?: string
  /** Other words that name it (catalog id and names, family word), lower case: `use_model` checks the owner said one. */
  names?: string[]
}

/** What a bot can run on (#673): the ready models that can hold a bot here, and the computers, this one first. */
export interface BotRunsOnChoices {
  /** One per model name, for an app from before rows (a single Model picker). */
  models: Array<{ model: string; label: string }>
  /**
   * The rows' choices, as the app's model picker takes them: each ready entry with the models on it that can hold a
   * bot, and their reasoning levels. Absent from an older service, whose app shows one Model picker.
   */
  providers?: LlmProviderOption[]
  /** The computer that holds (or will hold) the bot: always `this_computer` for now. */
  computer: string
  computers: BotComputerChoice[]
}

/** A bot's rows as Runs on shows them: each a pick on an entry, or null for "Pick a model" (Mousse chooses until then). */
export type BotShownRows = Record<BotModelSlotKey, BotModelPick | null>

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
 * `BotError.action.instanceId` (a Sign in button) and the Runs on methods (`bots.model.*`, #673). `bots.activate` stays internal, and
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
  'bots.schedules.add',
  'bots.schedules.remove',
  'bots.model.get',
  'bots.model.set',
  'bots.memory.list',
  'bots.memory.forget',
  'bots.memory.export'
] as const
/**
 * Methods added after the required Bot UI set (docs/plans/bot-always-free.md, #673): the app calls them when they are
 * there, and an older service that lacks them is still compatible (`guiDaemonCompatibility` lists only the set above).
 */
export const BOTS_WORK_METHODS = ['bots.work.stop', 'bots.reminders.cancel', 'bots.model.choices', 'bots.model.setSlots'] as const
export type BotsPersonalV2Method = (typeof BOTS_PERSONAL_V2_METHODS)[number] | (typeof BOTS_WORK_METHODS)[number]
export const BOTS_PERSONAL_V2_CAPABILITY = 'bots.personal.v2'

/** Most messages one `bots.chat.list` page returns. */
export const MAX_BOT_CHAT_PAGE = 100

/**
 * An attachment the owner sends with a chat message: a file on this computer. The service copies it
 * into the bot's files folder, where the bot may read it, and the message names that copy.
 */
export interface BotChatAttachment {
  name: string
  path: string
}

/** Most files one chat message carries. */
export const MAX_BOT_CHAT_ATTACHMENTS = 10
/** The largest file a chat message carries. */
export const MAX_BOT_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024

/** Each v2 method's params (`profileId` aside) and result. */
export interface BotsPersonalV2Api {
  'bots.personal.list': { params: Record<string, never>; result: { bots: BotSummary[] } }
  /**
   * `slots`: the rows picked on New bot (#673), all four, each a model on an entry among `bots.model.choices`'
   * `providers`. A pick that is not offered now is refused (`model_unavailable`) rather than replaced. `model` (an app
   * from before rows): one model by name on every row; neither, by usage (an app from before picks). Older services
   * refuse these keys, so the app sends `model` only to a service that has `bots.model.choices`, and `slots` only to one
   * whose choices carry `providers`.
   */
  'bots.create': { params: { look: BotLook; name?: string; description: string; clientRequestId: string; model?: string; slots?: BotModelSlots }; result: { bot: BotSummary } }
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
  'bots.chat.send': { params: { botId: string; text: string; attachments?: BotChatAttachment[]; clientRequestId: string; replyTo?: string }; result: { message: BotChatMessage } }
  'bots.chat.stop': { params: { botId: string }; result: Record<string, never> }
  /** Stops one piece of work (or a scheduled run) of the bot; the chat goes on. `stopped` is false when it had ended. */
  'bots.work.stop': { params: { botId: string; workId: string }; result: { stopped: boolean } }
  /** Cancels one waiting reminder; it is never said or started. One already said leaves the detail as it is. */
  'bots.reminders.cancel': { params: { botId: string; reminderId: string }; result: BotDetail }
  'bots.chat.markRead': { params: { botId: string; seq: number }; result: Record<string, never> }
  'bots.asks.answer': { params: { botId: string; askId: string; answer: 'allow' | 'not_now' }; result: { message: BotChatMessage } }
  /** `permissionId` is a `BotDetail.permissions` item's id (its fingerprint). */
  'bots.permissions.revoke': { params: { botId: string; permissionId: string }; result: BotDetail }
  /**
   * The owner adds a schedule (the Automations page's create row, with the bot as Who). `model`: one picked by hand for
   * its runs (#673), by name, saved on the entry that offers it now (refused when none does); absent, the bot's Work.
   */
  'bots.schedules.add': { params: { botId: string; when: BotSchedule['when']; prompt: string; model?: string }; result: BotDetail }
  /**
   * The bot's models and computer, by hand (#673). `slots`: its rows, each a pick on an entry, or null for "Pick a model"
   * (a bot from before picks, on which Mousse chooses until the owner picks; a model by name from it is `named`).
   * `model`: the Talk row's model by name, or null, for an app from before rows. Model names appear here and on the
   * pickers that use them only. `computers` are this one and the person's other computers; a bot runs on the computer
   * that holds it, so the others carry `unavailable` (why they cannot be picked) and `offline`. An older service sends
   * no `slots` or `providers`, and the app shows its single Model picker.
   */
  'bots.model.get': { params: { botId: string }; result: { model: string | null; slots?: BotShownRows; named?: Partial<Record<BotModelSlotKey, string>> } & BotRunsOnChoices }
  /**
   * What New bot's Runs on offers before the bot exists (#673): the same choices as `bots.model.get`, and `last`, the
   * rows of the owner's newest bot with picks, which a new bot starts from (null where it had none).
   */
  'bots.model.choices': { params: Record<string, never>; result: BotRunsOnChoices & { last?: BotShownRows } }
  /**
   * The single picker before rows: one model by name on every row, on the entry that offers it now, or null, which
   * leaves a bot from before picks by usage. A picked bot is never set back to by usage.
   */
  'bots.model.set': { params: { botId: string; model: string | null }; result: { bot: BotSummary } }
  /**
   * Changes the bot's rows (#673) over the rows as they are now, as a revision with the same grant. `slots`: some rows,
   * each a pick on an entry offered now (`model_unavailable` otherwise); only those change. `oneWork` (Advanced closing):
   * Medium work's pick, as it is, on all work. One of the two.
   */
  'bots.model.setSlots': { params: { botId: string; slots?: Partial<BotModelSlots>; oneWork?: true }; result: { bot: BotSummary } }
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
  /** A new or changed chat row: chat push and notifications (titled with `botName`, absent on older daemons). */
  'bots.message': { botId: string; message: BotChatMessage; botName?: string }
  /** The live chip of a working activation; null clears it. */
  'bots.activity': { botId: string; activationId: string; chip: BotChip | null }
}
