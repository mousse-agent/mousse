import { BOTS_PERSONAL_V2_CAPABILITY, BOTS_PERSONAL_V2_METHODS, BOTS_WORK_METHODS, MAX_BOT_CHAT_ATTACHMENTS, MAX_BOT_CHAT_PAGE, type BotChatAttachment, type BotsPersonalV2Method } from '../../shared/bots/personal/methods'
import { MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_MODEL_CHARS, MAX_BOT_NAME_CHARS, type BotModelPick, type BotModelSlots, type BotSchedule } from '../../shared/bots/personal/definition'
import { modelPickProblem, modelRowsProblem } from '../../shared/bots/personal/modelSlots'
import { isAbsolutePath } from '../../shared/bots/personal/manifest'
import type { BotLook } from '../../shared/bots/personal/look'
import { DomainHandlerRegistry, DomainRpcError, domainObject } from '../protocol/domainRegistry'
import { BotEngineError } from './activation/BotEngine'
import type { BotChatService } from './chat/BotChatService'
import { botMemoryMethods } from './memory/methods'
import { BotDefinitionError, isBotId } from './definitions/BotDefinitionStore'

/**
 * The Bot UI's methods (`bots.personal.v2`, Bot Phase 1 §5.11): profile-bound, validated with exact
 * keys, and answered from the admitted profile's bots. The form editor's v1 methods are no longer
 * registered for clients; they stay engine functions that tests use. `bots.activate` stays internal.
 */

type Params = Record<string, unknown>

const KEYS: Record<BotsPersonalV2Method, readonly string[]> = {
  'bots.personal.list': [],
  'bots.create': ['look', 'name', 'description', 'clientRequestId', 'model', 'slots', 'image'],
  'bots.get': ['botId'],
  'bots.update': ['botId', 'name', 'look'],
  'bots.personal.pause': ['botId'],
  'bots.personal.resume': ['botId'],
  'bots.delete': ['botId'],
  'bots.chat.list': ['botId', 'beforeSeq', 'limit'],
  'bots.chat.send': ['botId', 'text', 'attachments', 'clientRequestId', 'replyTo'],
  'bots.chat.stop': ['botId'],
  'bots.work.stop': ['botId', 'workId'],
  'bots.reminders.cancel': ['botId', 'reminderId'],
  'bots.chat.markRead': ['botId', 'seq'],
  'bots.chat.react': ['botId', 'messageId', 'emoji'],
  'bots.asks.answer': ['botId', 'askId', 'answer'],
  'bots.permissions.revoke': ['botId', 'permissionId'],
  'bots.schedules.add': ['botId', 'when', 'prompt', 'model'],
  'bots.schedules.remove': ['botId', 'scheduleId'],
  'bots.model.get': ['botId'],
  'bots.model.choices': [],
  'bots.model.set': ['botId', 'model'],
  'bots.model.setSlots': ['botId', 'slots', 'oneWork'],
  'bots.model.setImage': ['botId', 'pick'],
  'bots.memory.list': ['botId', 'history'],
  'bots.memory.forget': ['botId', 'id'],
  'bots.memory.export': ['botId', 'dir']
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const ASK_ID = /^esc_[0-9a-f-]{36}$/
const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_CHAT_TEXT = 64 * 1024
/**
 * Emoji code points: pictographs, with their joiners, variation selectors, skin tones and keycaps, at most 16 code points,
 * and at least one pictograph, flag letter or keycap (a digit or `#` alone is no emoji). `isReaction` adds: one character.
 */
export const REACTION = /^(?=.{1,16}$)(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3))(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3#*0-9]|\p{Emoji_Modifier})+$/u

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/** One emoji, one character on screen: a flag, a family or a keycap is one; `❤️👍` or `12👍` is not. */
export function isReaction(value: unknown): value is string {
  if (typeof value !== 'string' || !REACTION.test(value)) return false
  let count = 0
  for (const _ of GRAPHEMES.segment(value)) if (++count > 1) return false
  return count === 1
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const whole = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min

const LOOK_KEYS = new Set(['colour', 'accessory', 'kind', 'eyes'])

function look(value: unknown): BotLook {
  const given = value as { colour?: unknown; accessory?: unknown; kind?: unknown; eyes?: unknown } | null
  if (!given || typeof given !== 'object' || Array.isArray(given) || Object.keys(given).some((key) => !LOOK_KEYS.has(key)) ||
      !text(given.colour, 40) || !text(given.accessory, 40) ||
      (given.kind !== undefined && !text(given.kind, 40)) || (given.eyes !== undefined && !text(given.eyes, 40)))
    throw new DomainRpcError('invalid_params', 'A look is a colour and an accessory, with an optional kind and eye shape')
  return { colour: given.colour, accessory: given.accessory, ...(given.kind !== undefined ? { kind: given.kind } : {}), ...(given.eyes !== undefined ? { eyes: given.eyes } : {}) }
}

/** A bot's rows (#673): some of Talk, Light, Medium and Hard work (all four with `all`), each a pick on an entry. */
function slots(value: unknown, options: { all?: boolean } = {}): void {
  const problem = modelRowsProblem(value, options)
  if (problem) throw new DomainRpcError('invalid_params', problem)
}

/** The Images row's pick (#1088): a model on an entry, with no reasoning level. */
function imagePick(value: unknown): void {
  const problem = modelPickProblem(value, { client: true }) ?? ((value as { effort?: unknown }).effort !== undefined ? 'An image model has no reasoning level.' : undefined)
  if (problem) throw new DomainRpcError('invalid_params', problem)
}

const MODEL_NAME_TEXT = `A model is a name of 1 to ${MAX_BOT_MODEL_CHARS} characters`

function attachments(value: unknown): BotChatAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_BOT_CHAT_ATTACHMENTS) throw new DomainRpcError('invalid_params', `Attach at most ${MAX_BOT_CHAT_ATTACHMENTS} files`)
  return value.map((entry) => {
    const file = entry as { name?: unknown; path?: unknown } | null
    if (!file || typeof file !== 'object' || Object.keys(file).some((key) => key !== 'name' && key !== 'path') || !text(file.name, 256) || !text(file.path, 4096) || !isAbsolutePath(file.path))
      throw new DomainRpcError('invalid_params', 'An attachment is a name and a full path')
    return { name: file.name, path: file.path }
  })
}

function validate(method: BotsPersonalV2Method, value: unknown): Params {
  const p = domainObject(value ?? {}, ['profileId', ...KEYS[method]])
  if (KEYS[method].includes('botId') && !isBotId(p.botId)) throw new DomainRpcError('invalid_params', 'A bot id is required')
  if (KEYS[method].includes('clientRequestId') && (typeof p.clientRequestId !== 'string' || !REQUEST_ID.test(p.clientRequestId)))
    throw new DomainRpcError('invalid_params', 'A request id is required')
  switch (method) {
    case 'bots.create':
      p.look = look(p.look)
      if (!text(p.description, MAX_BOT_DESCRIPTION_CHARS)) throw new DomainRpcError('invalid_params', `Say what the bot should do in 1 to ${MAX_BOT_DESCRIPTION_CHARS} characters`)
      if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > MAX_BOT_NAME_CHARS)) throw new DomainRpcError('invalid_params', `A name is at most ${MAX_BOT_NAME_CHARS} characters`)
      if (p.model !== undefined && !text(p.model, MAX_BOT_MODEL_CHARS)) throw new DomainRpcError('invalid_params', MODEL_NAME_TEXT)
      if (p.slots !== undefined) slots(p.slots, { all: true })
      if (p.slots !== undefined && p.model !== undefined) throw new DomainRpcError('invalid_params', 'Give the models as slots or as one model, not both')
      if (p.image !== undefined) imagePick(p.image)
      break
    case 'bots.model.setImage':
      if (p.pick === undefined) throw new DomainRpcError('invalid_params', 'Give the pick, or null')
      if (p.pick !== null) imagePick(p.pick)
      break
    case 'bots.model.setSlots':
      if ((p.slots === undefined) === (p.oneWork === undefined)) throw new DomainRpcError('invalid_params', 'Give the rows, or oneWork')
      if (p.slots !== undefined) slots(p.slots)
      if (p.oneWork !== undefined && p.oneWork !== true) throw new DomainRpcError('invalid_params', 'oneWork is true')
      break
    case 'bots.update':
      if (p.name === undefined && p.look === undefined) throw new DomainRpcError('invalid_params', 'Give a name or a look')
      if (p.name !== undefined && !text(p.name, MAX_BOT_NAME_CHARS)) throw new DomainRpcError('invalid_params', `A name is 1 to ${MAX_BOT_NAME_CHARS} characters`)
      if (p.look !== undefined) p.look = look(p.look)
      break
    case 'bots.chat.list':
      if (p.beforeSeq !== undefined && !whole(p.beforeSeq, 1)) throw new DomainRpcError('invalid_params', 'beforeSeq must be a positive whole number')
      if (p.limit !== undefined && (!whole(p.limit, 1) || p.limit > MAX_BOT_CHAT_PAGE)) throw new DomainRpcError('invalid_params', `limit must be 1 to ${MAX_BOT_CHAT_PAGE}`)
      break
    case 'bots.chat.send':
      if (p.attachments !== undefined) p.attachments = attachments(p.attachments)
      // Files alone are a message too.
      if (typeof p.text !== 'string' || p.text.length > MAX_CHAT_TEXT || (!p.text.trim() && !(p.attachments as BotChatAttachment[] | undefined)?.length))
        throw new DomainRpcError('invalid_params', 'The message is empty or too long')
      if (p.replyTo !== undefined && !text(p.replyTo, 200)) throw new DomainRpcError('invalid_params', 'replyTo is a message id')
      break
    case 'bots.work.stop':
      if (typeof p.workId !== 'string' || !/^act_[0-9a-f-]{36}$/.test(p.workId)) throw new DomainRpcError('invalid_params', 'A work id is required')
      break
    case 'bots.reminders.cancel':
      if (typeof p.reminderId !== 'string' || !/^rem_[0-9a-f-]{36}$/.test(p.reminderId)) throw new DomainRpcError('invalid_params', 'A reminder id is required')
      break
    case 'bots.chat.markRead':
      if (!whole(p.seq, 0)) throw new DomainRpcError('invalid_params', 'seq must be a whole number')
      break
    case 'bots.chat.react':
      if (!text(p.messageId, 200)) throw new DomainRpcError('invalid_params', 'A message id is required')
      // One emoji (a flag or a family is several code points), or null to remove it.
      if (p.emoji !== null && !isReaction(p.emoji)) throw new DomainRpcError('invalid_params', 'The reaction is one emoji, or null')
      break
    case 'bots.asks.answer':
      if (typeof p.askId !== 'string' || !ASK_ID.test(p.askId)) throw new DomainRpcError('invalid_params', 'An ask id is required')
      if (p.answer !== 'allow' && p.answer !== 'not_now') throw new DomainRpcError('invalid_params', 'The answer must be allow or not_now')
      break
    case 'bots.permissions.revoke':
      if (!text(p.permissionId, 4096)) throw new DomainRpcError('invalid_params', 'A permission id is required')
      break
    case 'bots.schedules.add': {
      const when = p.when as { kind?: unknown; minutes?: unknown; expr?: unknown } | null
      const ok = when && typeof when === 'object' && !Array.isArray(when) && (
        (when.kind === 'interval' && Object.keys(when).every((key) => key === 'kind' || key === 'minutes') && whole(when.minutes, 1)) ||
        (when.kind === 'cron' && Object.keys(when).every((key) => key === 'kind' || key === 'expr') && text(when.expr, 128)))
      if (!ok) throw new DomainRpcError('invalid_params', 'When is every N minutes or a five-field cron')
      if (!text(p.prompt, MAX_CHAT_TEXT)) throw new DomainRpcError('invalid_params', 'Say what the bot should do')
      if (p.model !== undefined && !text(p.model, MAX_BOT_MODEL_CHARS)) throw new DomainRpcError('invalid_params', MODEL_NAME_TEXT)
      break
    }
    case 'bots.model.set':
      if (p.model !== null && !text(p.model, MAX_BOT_MODEL_CHARS)) throw new DomainRpcError('invalid_params', `${MODEL_NAME_TEXT}, or null`)
      break
    case 'bots.schedules.remove':
      if (typeof p.scheduleId !== 'string' || !SCHEDULE_ID.test(p.scheduleId)) throw new DomainRpcError('invalid_params', 'A schedule id is required')
      break
    case 'bots.memory.list':
      if (p.history !== undefined && typeof p.history !== 'boolean') throw new DomainRpcError('invalid_params', 'history must be true or false')
      break
    case 'bots.memory.forget':
      if (!text(p.id, 64)) throw new DomainRpcError('invalid_params', 'A memory id is required')
      break
    case 'bots.memory.export':
      if (!text(p.dir, 4096) || !isAbsolutePath(p.dir)) throw new DomainRpcError('invalid_params', 'The folder must be a full path')
      break
    default:
      break
  }
  return p
}

async function handle(method: BotsPersonalV2Method, p: Params, bots: BotChatService): Promise<unknown> {
  const botId = p.botId as string
  switch (method) {
    case 'bots.personal.list': return bots.list()
    case 'bots.create': return bots.create({ look: p.look as BotLook, ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name } : {}), description: p.description as string, clientRequestId: p.clientRequestId as string, ...(typeof p.model === 'string' ? { model: p.model.trim() } : {}), ...(p.slots !== undefined ? { slots: p.slots as BotModelSlots } : {}), ...(p.image !== undefined ? { image: p.image as BotModelPick } : {}) })
    case 'bots.get': return bots.get(botId)
    case 'bots.update': return bots.update(botId, { ...(p.name !== undefined ? { name: p.name as string } : {}), ...(p.look !== undefined ? { look: p.look as BotLook } : {}) })
    case 'bots.personal.pause': return bots.pause(botId)
    case 'bots.personal.resume': return bots.resume(botId)
    case 'bots.delete': return bots.delete(botId)
    case 'bots.chat.list': return bots.chatList(botId, { ...(p.beforeSeq !== undefined ? { beforeSeq: p.beforeSeq as number } : {}), ...(p.limit !== undefined ? { limit: p.limit as number } : {}) })
    case 'bots.chat.send': return bots.chatSend({ botId, text: p.text as string, ...(p.attachments ? { attachments: p.attachments as BotChatAttachment[] } : {}), clientRequestId: p.clientRequestId as string, ...(typeof p.replyTo === 'string' ? { replyTo: p.replyTo } : {}) })
    case 'bots.chat.stop': return bots.chatStop(botId)
    case 'bots.work.stop': return bots.workStop(botId, p.workId as string)
    case 'bots.reminders.cancel': return bots.reminderCancel(botId, p.reminderId as string)
    case 'bots.chat.markRead': return bots.markRead(botId, p.seq as number)
    case 'bots.chat.react': return bots.react(botId, p.messageId as string, p.emoji as string | null)
    case 'bots.asks.answer': return bots.answer(botId, p.askId as string, p.answer as 'allow' | 'not_now')
    case 'bots.permissions.revoke': return bots.revokePermission(botId, p.permissionId as string)
    case 'bots.schedules.add': return bots.addSchedule(botId, p.when as BotSchedule['when'], p.prompt as string, typeof p.model === 'string' ? p.model : undefined)
    case 'bots.model.get': return bots.modelGet(botId)
    case 'bots.model.choices': return bots.modelChoices()
    case 'bots.model.set': return bots.modelSet(botId, typeof p.model === 'string' ? p.model.trim() : null)
    case 'bots.model.setSlots': return bots.modelSlotsSet(botId, p.oneWork === true ? { oneWork: true } : { slots: p.slots as Partial<BotModelSlots> })
    case 'bots.model.setImage': return bots.modelImageSet(botId, p.pick as BotModelPick | null)
    case 'bots.schedules.remove': return bots.removeSchedule(botId, p.scheduleId as string)
    // WP6's handlers, over the profile's memory (their own checks: an entry id like m12, a folder that exists).
    case 'bots.memory.list':
    case 'bots.memory.forget':
    case 'bots.memory.export':
      return botMemoryMethods(bots.memoryFor(botId))[method](p)
  }
}

/** Bind once before server seal. The bots come from the daemon's admitted profile, never a client path. */
export function registerPersonalBotMethods(domains: DomainHandlerRegistry, botsForProfile: (profileId: string) => BotChatService | null | undefined | Promise<BotChatService | null | undefined>): void {
  for (const method of [...BOTS_PERSONAL_V2_METHODS, ...BOTS_WORK_METHODS]) {
    domains.register({
      method,
      scope: 'profile',
      capability: BOTS_PERSONAL_V2_CAPABILITY,
      validate: (params) => validate(method, params),
      async handle(_context, params, binding) {
        try {
          const bots = await botsForProfile(binding!.profileId)
          // The profile's bots.db could not be opened: bots are unavailable, nothing else is affected.
          if (!bots) throw new DomainRpcError('bots_unavailable', 'Bots are unavailable in this profile: their data could not be opened.')
          return await handle(method, params, bots)
        } catch (error) {
          if (error instanceof BotEngineError) throw new DomainRpcError(error.code, error.message, error.details)
          if (error instanceof BotDefinitionError) throw new DomainRpcError(error.code, error.message)
          throw error
        }
      }
    })
  }
}
