import { botActionRefusalText, isBotActionRefusalCode } from '../../../shared/bots/personal/actionRefusal'
import { NetError, type NodeCapability, type NodeId } from '../../../shared/net'
import { launchedActive, type BotChatCard, type BotChatMessage, type BotDetail, type BotError, type BotSummary } from '../../../shared/bots/personal/chat'
import { isQualifiedId } from '../../../shared/threadRef'
import { managingLine } from '../../bots/chat/projection'
import { MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS } from '../../../shared/bots/personal/definition'
import { MAX_CHOICE_LABEL_CHARS } from '../../../shared/bots/personal/questions'
import type { BotLook } from '../../../shared/bots/personal/look'
import { MAX_BOT_CHAT_ATTACHMENTS, MAX_BOT_CHAT_PAGE, type BotRunsOnChoices, type BotsPersonalV2Api } from '../../../shared/bots/personal/methods'
import { REMOTE_BOT_METHOD_NAMES, remoteBotLevel, remoteBotMethod, type RemoteBotMethod } from '../../../shared/bots/personal/methodTable'
import { botLevelReaches, type BotLevel } from '../../../shared/net/local'
import { BOT_FULL_TRUST_PERMISSION } from '../../../shared/bots/personal/manifest'
import type { BotChatService } from '../../bots/chat/BotChatService'
import type { RpcContext, RpcMethod } from '../../net/contracts'
import type { PermissionMode } from '../../../shared/permissionMode'
import { canonicalJson } from '../../net/sync/codec'
import { isBotId } from '../../bots/definitions/BotDefinitionStore'
import type { BotReachPort } from '../../protocol/botReachPort'
import { BOT_DEVICES_REFUSALS, MAX_BOT_DEVICES, REMOTE_BOT_REACH, botDeviceAccessProblem, type BotDeviceAccess, type BotDevicesRefusal, type BotDeviceChoice, type BotDevicesView } from '../../../shared/bots/personal/deviceAccess'
import { modelPickProblem, modelRowsProblem } from '../../../shared/bots/personal/modelSlots'
import type { BotModelPick, BotModelSlots } from '../../../shared/bots/personal/definition'
import { botDevicesView, type BotDevicesSource } from '../../bots/deviceMethods'
import { BOT_STAGE_PART_BYTES, REMOTE_BOT_FILE_BYTES, isBotFileRef, isBotStageId, isSvgName } from '../../../shared/bots/personal/remoteFiles'
import { botFileRef, looksLikeSvg, openInside, readBotFilePage, remoteFileType, sniffImage } from './botFiles'
import type { BotStaging } from './botStaging'

/**
 * The personal-bot methods of the user's other devices (phones and other computers): a bot's chat and its files both
 * ways, its asks, its pause, what it remembers and the rest of About, and a new bot. Deny-default like
 * `BRIDGE_REMOTE_METHODS`; each one calls the same `BotChatService` method the desktop's `bots.*` handler calls, with
 * the same params (files sent ahead with `bots.stage` in place of `attachments`, which name files on this computer)
 * and results. No result carries a path on this computer, and only Runs on's rows (at Full) name its entries and
 * models, as About shows them. Which methods these are, their keys and their levels are the `remote` rows of
 * `BOT_METHODS` (`shared/bots/personal/methodTable.ts`).
 *
 * What a device may do with which bot (`docs/bots.md`, Bot access per device) is checked in `remoteBotMethods`'s one
 * wrapper, so a method added here later is held to it too: a device at Off is refused every one, a device at Use every
 * row that needs Full, and a bot whose Devices choice leaves the device out answers exactly as a bot that is not there.
 */
export const REMOTE_BOT_METHODS: Readonly<Record<RemoteBotMethod, { capability: NodeCapability; mutating: boolean }>> = Object.freeze(
  Object.fromEntries(REMOTE_BOT_METHOD_NAMES.map((name) => {
    const { capability, mutating } = remoteBotMethod(name)
    return [name, { capability, mutating }]
  })) as Record<RemoteBotMethod, { capability: NodeCapability; mutating: boolean }>
)
export type { RemoteBotMethod }

/**
 * The bot streams another device opens here, each for itself: the feed of the bots it reaches and one bot's chat. Both
 * stand apart from thread sharing; `remoteBotMethods`' gate admits them by the bot level and each bot's Devices.
 */
export const BOT_STREAM_METHODS: Readonly<Record<'bridge.bots.open' | 'bridge.bot.open', { capability: NodeCapability; mutating: false }>> = Object.freeze({
  'bridge.bots.open': { capability: 'read', mutating: false },
  'bridge.bot.open': { capability: 'read', mutating: false }
})

/** What a bot stream's open answers: the stream, where it is now, and the `threadId` its records carry. */
export interface RemoteBotStreamOpened {
  descriptor: unknown
  head: { epoch: number; seq: number }
  kind: 'bots' | 'bot'
  subject: string
}

/**
 * The version of each method above that this computer accepts, as `net.info` reports it (`bots`), so a device sends only
 * keys this computer knows: an older one refuses any other key. 2 for `bots.create`: `reach` (`RemoteBotReach`), which
 * this computer takes as `home_and_maker` whatever it says. An older computer reports none, and a device offers no
 * choice of reach for a bot it makes there.
 */
export function remoteBotVersions(): Record<RemoteBotMethod, number> {
  const out = {} as Record<RemoteBotMethod, number>
  for (const name of REMOTE_BOT_METHOD_NAMES) out[name] = remoteBotMethod(name).version ?? 1
  return out
}

/** The profile's bots, as the remote methods use them. */
export type RemoteBotsPort = BotChatService

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const ASK_ID = /^esc_[0-9a-f-]{36}$/
const QUESTION_ID = /^q_[0-9a-f-]{36}$/
const WORK_ID = /^act_[0-9a-f-]{36}$/
const REMINDER_ID = /^rem_[0-9a-f-]{36}$/
const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const MEMORY_ID = /^m[0-9]{1,12}$/
/** An entry's version as the owner saw it: `m12`, or `m12v2`. */
const MEMORY_REF = /^m[0-9]{1,12}(?:v[0-9]{1,9})?$/
/** The store refuses words over its own limit; this keeps a huge payload out. */
const MAX_MEMORY_EDIT = 4096
const LOOK_KEYS = new Set(['colour', 'accessory', 'kind', 'eyes', 'eyeColour'])
/**
 * A remote message, in bytes. The desktop's limit is 64K characters; a remote one is smaller so the message the
 * send returns stays within one RPC reply.
 */
export const REMOTE_BOT_MESSAGE_BYTES = 32 * 1024
/** A read's result stays below one RPC reply (63 KiB); older messages are left for the next page. */
const RESULT_BYTES = 56 * 1024
/** The largest image another device may read from a bot's chat with `bots.chat.attachment`. */
export const REMOTE_BOT_IMAGE_BYTES = 1536 * 1024
/** One part of an image: 40 KiB, under 55 KiB as base64, so a part fits one reply. */
export const REMOTE_BOT_IMAGE_PART_BYTES = 40 * 1024
/** A staged part as base64: `BOT_STAGE_PART_BYTES` of bytes, rounded up to whole groups of four. */
const STAGE_PART_B64 = Math.ceil(BOT_STAGE_PART_BYTES / 3) * 4
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const text = (value: unknown, max: number): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
const whole = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max

function lookOf(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const look = value as Record<string, unknown>
  return (
    Object.keys(look).every((key) => LOOK_KEYS.has(key)) &&
    text(look.colour, 40) &&
    text(look.accessory, 40) &&
    (look.kind === undefined || text(look.kind, 40)) &&
    (look.eyes === undefined || text(look.eyes, 40)) &&
    (look.eyeColour === undefined || text(look.eyeColour, 40))
  )
}

/** The Images row's pick, as a method takes it: an entry and a model, never a reasoning level. */
const imagePickOf = (value: unknown): boolean =>
  modelPickProblem(value, { client: true }) === undefined && (value as { effort?: unknown }).effort === undefined

/** Exact keys and bounded values; anything else is `bad_request`. */
export function validateRemoteBotParams(method: RemoteBotMethod, value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.byteLength(canonicalJson(value)) > 64 * 1024
  )
    throw new NetError('bad_request')
  const p = value as Record<string, unknown>
  const { required, optional = [] } = remoteBotMethod(method)
  if (
    required.some((key) => !Object.hasOwn(p, key)) ||
    Object.keys(p).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new NetError('bad_request')
  const ok = (check: boolean): void => {
    if (!check) throw new NetError('bad_request')
  }
  if (required.includes('botId')) ok(isBotId(p.botId))
  if (required.includes('clientRequestId'))
    ok(typeof p.clientRequestId === 'string' && REQUEST_ID.test(p.clientRequestId))
  switch (method) {
    case 'bots.chat.list':
      if (p.beforeSeq !== undefined) ok(whole(p.beforeSeq, 1))
      if (p.limit !== undefined) ok(whole(p.limit, 1, MAX_BOT_CHAT_PAGE))
      break
    case 'bots.chat.attachment':
      ok(text(p.messageId, 200))
      ok(whole(p.index, 0, MAX_BOT_CHAT_ATTACHMENTS - 1))
      if (p.offset !== undefined) ok(whole(p.offset, 0, REMOTE_BOT_IMAGE_BYTES))
      break
    case 'bots.chat.file':
      ok(isBotFileRef(p.path))
      if (p.offset !== undefined) ok(whole(p.offset, 0, REMOTE_BOT_FILE_BYTES))
      break
    case 'bots.stage': {
      ok(whole(p.offset, 0, REMOTE_BOT_FILE_BYTES))
      ok(typeof p.dataB64 === 'string' && p.dataB64.length <= STAGE_PART_B64 && p.dataB64.length % 4 === 0 && BASE64.test(p.dataB64))
      const length = ((p.dataB64 as string).length / 4) * 3 - ((p.dataB64 as string).endsWith('==') ? 2 : (p.dataB64 as string).endsWith('=') ? 1 : 0)
      // Every part carries bytes, never more than one part's worth.
      ok(length >= 1 && length <= BOT_STAGE_PART_BYTES)
      // The first part names the file and its size, and is no longer than that size; each later one the file it adds to.
      if (p.stage === undefined) ok(p.offset === 0 && text(p.name, 255) && whole(p.size, 1, REMOTE_BOT_FILE_BYTES) && length <= (p.size as number))
      else ok(isBotStageId(p.stage) && p.name === undefined && p.size === undefined)
      break
    }
    case 'bots.chat.send': {
      const staged = p.staged
      if (staged !== undefined)
        ok(Array.isArray(staged) && staged.length > 0 && staged.length <= MAX_BOT_CHAT_ATTACHMENTS && staged.every(isBotStageId) && new Set(staged).size === staged.length)
      // Files alone are a message too.
      ok(typeof p.text === 'string' && p.text.length <= REMOTE_BOT_MESSAGE_BYTES && Buffer.byteLength(p.text) <= REMOTE_BOT_MESSAGE_BYTES && (staged !== undefined || text(p.text, REMOTE_BOT_MESSAGE_BYTES)))
      if (p.replyTo !== undefined) ok(text(p.replyTo, 200))
      break
    }
    case 'bots.work.stop':
      ok(typeof p.workId === 'string' && WORK_ID.test(p.workId))
      break
    case 'bots.chat.markRead':
      ok(whole(p.seq, 0))
      break
    case 'bots.asks.answer':
      ok(typeof p.askId === 'string' && ASK_ID.test(p.askId))
      ok(p.answer === 'allow' || p.answer === 'not_now')
      break
    case 'bots.actions.answer':
      ok(text(p.actionId, 100) && text(p.digest, 64) && (p.answer === 'send' || p.answer === 'not_now'))
      break
    case 'bots.questions.answer':
      ok(typeof p.questionId === 'string' && QUESTION_ID.test(p.questionId))
      ok(text(p.choice, MAX_CHOICE_LABEL_CHARS))
      break
    case 'bots.create':
      ok(lookOf(p.look))
      ok(text(p.description, MAX_BOT_DESCRIPTION_CHARS))
      if (p.name !== undefined) ok(typeof p.name === 'string' && p.name.length <= MAX_BOT_NAME_CHARS)
      if (p.reach !== undefined) ok((REMOTE_BOT_REACH as readonly unknown[]).includes(p.reach))
      if (p.slots !== undefined) ok(modelRowsProblem(p.slots, { all: true }) === undefined)
      if (p.image !== undefined) ok(imagePickOf(p.image))
      if (p.access !== undefined) ok(botDeviceAccessProblem(p.access) === undefined)
      break
    case 'bots.update':
      ok(p.name !== undefined || p.look !== undefined || p.description !== undefined)
      if (p.name !== undefined) ok(text(p.name, MAX_BOT_NAME_CHARS))
      if (p.look !== undefined) ok(lookOf(p.look))
      // null: back to the prompt from before the owner's first edit, as About's Reset does.
      if (p.description !== undefined) ok(p.description === null || text(p.description, MAX_BOT_DESCRIPTION_CHARS))
      break
    case 'bots.model.setSlots':
      ok((p.slots === undefined) !== (p.oneWork === undefined))
      if (p.slots !== undefined) ok(modelRowsProblem(p.slots) === undefined)
      if (p.oneWork !== undefined) ok(p.oneWork === true)
      break
    case 'bots.model.setImage':
      ok(p.pick === null || imagePickOf(p.pick))
      break
    case 'bots.devices.set':
      ok(botDeviceAccessProblem(p.access) === undefined)
      break
    case 'bots.reminders.snooze':
      ok(text(p.messageId, 200) && ['10m', '1h', 'tomorrow'].includes(p.choice as string))
      break
    case 'bots.reminders.cancel':
      ok(typeof p.reminderId === 'string' && REMINDER_ID.test(p.reminderId))
      break
    case 'bots.schedules.remove':
      ok(typeof p.scheduleId === 'string' && SCHEDULE_ID.test(p.scheduleId))
      break
    case 'bots.permissions.set':
      ok(typeof p.enabled === 'boolean')
    case 'bots.permissions.revoke':
      ok(text(p.permissionId, 4096))
      break
    case 'bots.memory.forget':
      ok(typeof p.id === 'string' && MEMORY_ID.test(p.id))
      break
    case 'bots.memory.edit':
      ok(typeof p.id === 'string' && MEMORY_REF.test(p.id) && text(p.text, MAX_MEMORY_EDIT))
      break
    default:
      break
  }
  return p
}

/** A bot error as another device sees it: no instance id (its Sign in opens on the computer). */
export function remoteBotError(error: BotError): BotError {
  return {
    text: error.text,
    ...(error.action ? { action: { kind: error.action.kind, label: error.action.label } } : {})
  }
}

/** A bot as another device sees it. */
export function remoteBotSummary(bot: BotSummary): BotSummary {
  // Which devices reach the bot is set and shown on its own computer only, and only its own computer's app draws its face picture.
  const { error, reach: _reach, facePicture: _face, ...rest } = bot
  return { ...rest, ...withoutOtherComputersThreads(bot), ...(error ? { error: remoteBotError(error) } : {}) }
}

/**
 * The bot's threads as another device sees them: only those on this computer. A thread the bot started on a further
 * computer (a qualified id) is that computer's to share, and it may block the device reading this bot; "Managing …",
 * which names threads, then names only the threads left.
 */
function withoutOtherComputersThreads(bot: BotSummary): Partial<Pick<BotSummary, 'threads' | 'stateText'>> {
  const threads = bot.threads ?? []
  const here = threads.filter((thread) => !isQualifiedId(thread.threadId))
  if (here.length === threads.length) return {}
  const managing = here.filter(launchedActive)
  const stateText = bot.stateText.startsWith('Managing ') ? (managing.length ? managingLine(managing) : 'Working…') : bot.stateText
  return { threads: here, stateText }
}

/** About a bot as another device sees it. */
export function remoteBotDetail(detail: BotDetail): BotDetail {
  return { ...detail, summary: remoteBotSummary(detail.summary) }
}

/**
 * An attached file as another device sees it: its name and type, and its place inside the bot's files folder (`path`,
 * read with `bots.chat.file`) when it is there; never its path on this computer. `image`: a PNG, JPEG, GIF or WebP by
 * its name (the read checks its bytes).
 */
export interface RemoteBotFile {
  name: string
  mime: string
  image?: true
  path?: string
}

/**
 * A card as another device sees it: a gallery's pictures by name, each with its place inside the bot's files folder
 * (`path`, read with `bots.chat.file`) and its place among the message's files (`index`, read with
 * `bots.chat.attachment`) when it is one of them, never its path on this computer.
 */
export type RemoteBotCard = Exclude<BotChatCard, { type: 'gallery' }> | { type: 'gallery'; title?: string; files: Array<{ name: string; caption?: string; path?: string; index?: number }> }

/** A chat row as another device sees it. */
export type RemoteBotMessage = Omit<BotChatMessage, 'attachments' | 'applets' | 'cards'> & { attachments?: RemoteBotFile[]; cards?: RemoteBotCard[] }

/**
 * A chat row as another device sees it: a file's name and type and its place in the bot's files folder, without its
 * path on this computer; an error without an instance id; an applet as one line naming it (it runs only in this
 * computer's app, from the bot's thread here); and a gallery card's pictures by their places. A place is only ever in
 * the files folder of `botId`, the bot whose chat the message is in.
 */
export function remoteBotMessage(message: BotChatMessage, botId: string): RemoteBotMessage {
  const { attachments, error, applets, cards, ...rest } = message
  // The title is the bot's words: plain, so it can't add a link or an image to the line.
  const named = applets?.map((applet) => `_Applet: ${applet.reference.title.replace(/[\\`*_[\]()<>!#|~]/g, '').trim()}. It opens on the computer._`).join('\n')
  const ref = (path: string): { path?: string } => {
    const inside = botFileRef(path, botId)
    return inside ? { path: inside } : {}
  }
  const remoteCards = cards?.map((card): RemoteBotCard => card.type !== 'gallery' ? card : {
    type: 'gallery',
    ...(card.title ? { title: card.title } : {}),
    files: card.files.map((file) => {
      const index = attachments?.findIndex((attached) => attached.path === file.path) ?? -1
      return { name: file.name, ...(file.caption ? { caption: file.caption } : {}), ...ref(file.path), ...(index >= 0 ? { index } : {}) }
    })
  })
  return {
    ...rest,
    ...(named ? { text: rest.text ? `${rest.text}\n\n${named}` : named } : {}),
    ...(error ? { error: remoteBotError(error) } : {}),
    ...(attachments ? { attachments: attachments.map((file) => ({ name: file.name, ...remoteFileType(file.path || file.name), ...ref(file.path) })) } : {}),
    ...(remoteCards?.length ? { cards: remoteCards } : {})
  }
}

const bytes = (value: unknown): number => Buffer.byteLength(canonicalJson(value))

/** One message within a reply: a very long text is cut, with a note that the rest is on the computer. */
function fitted(message: RemoteBotMessage, budget = RESULT_BYTES): RemoteBotMessage {
  if (bytes(message) <= budget) return message
  if (message.action) {
    // Never send a partially reviewable card with a live Send button. Not now still names this row.
    const action = message.action
    message = { ...message, text: 'This action is too large to send from here. Open it on the computer.', action: {
      actionId: action.actionId, digest: action.digest, ...(action.askedAt ? { askedAt: action.askedAt } : {}), title: action.title, serverName: action.serverName,
      args: null, hasHiddenValues: action.hasHiddenValues, hiddenPaths: [], status: action.status,
      ...(action.previous ? { previous: action.previous } : {}), ...(action.at ? { at: action.at } : {}),
      ...(action.result?.notSentInTime ? { result: { text: action.result.text, notSentInTime: true } }
        : action.result?.toolReportedError ? { result: { toolReportedError: true } } : {}), tooLarge: true
    } }
    if (bytes(message) <= budget) return message
  }
  const over = bytes(message) - budget
  const keep = Math.max(0, Buffer.byteLength(message.text) - over - 256)
  let cut = Buffer.from(message.text).subarray(0, keep).toString()
  // A cut through a character leaves a replacement character at the end.
  cut = cut.replace(/�+$/, '')
  return { ...message, text: `${cut}\n\n… (the rest is on the computer)` }
}

type RemotePage = Omit<BotsPersonalV2Api['bots.chat.list']['result'], 'messages'> & { messages: RemoteBotMessage[] }
/** A page of a bot's chat as another device gets it (`bots.chat.list`, a bot stream's snapshot). */
export type RemoteBotPage = RemotePage

/** A chat row as another device gets it, within one reply or one stream record. */
export const fittedBotMessage = (message: BotChatMessage, botId: string): RemoteBotMessage => fitted(remoteBotMessage(message, botId))
/** The newest messages of a page that fit one reply or one snapshot, as `bots.chat.list` answers another device. */
export const fittedBotPage = (page: BotsPersonalV2Api['bots.chat.list']['result'], botId: string): RemotePage => fittedPage(page, botId)

/** A page within one reply: the newest messages that fit; the device asks for the older ones with `beforeSeq`. */
function fittedPage(page: BotsPersonalV2Api['bots.chat.list']['result'], botId: string): RemotePage {
  const messages = page.messages.map((message) => remoteBotMessage(message, botId))
  const result = { ...page, messages }
  if (bytes(result) <= RESULT_BYTES) return result
  const kept: RemoteBotMessage[] = []
  let total = bytes({ ...page, messages: [] })
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = kept.length ? messages[at]! : fitted(messages[at]!, RESULT_BYTES - total)
    const size = bytes(message) + 1
    if (total + size > RESULT_BYTES) break
    kept.unshift(message)
    total += size
  }
  return { ...page, messages: kept }
}

/**
 * One part of an image file of a bot's chat, checked to be a raster image (by its first bytes) within the size limit,
 * and opened only as the file inside the bot's files folder that was checked (`openInside`).
 */
async function imagePart(file: { name: string; path: string; folder: string }, offset: number): Promise<{ name: string; mime: string; size: number; offset: number; dataB64: string }> {
  if (!remoteFileType(file.name).image && !remoteFileType(file.path).image)
    throw new NetError('conflict', 'Only images open on another device.')
  const opened = await openInside(file.folder, file.path)
  if (!opened) throw new NetError('stream_unknown', `${file.name} is no longer on the computer.`)
  const { handle, size } = opened
  try {
    if (size > REMOTE_BOT_IMAGE_BYTES) throw new NetError('too_large', `${file.name} is too large to show here. Open it on the computer.`)
    const head = Buffer.alloc(Math.min(16, size))
    if (head.length) await handle.read(head, 0, head.length, 0)
    const mime = sniffImage(head)
    if (!mime) throw new NetError('conflict', 'Only images open on another device.')
    if (offset > size) throw new NetError('bad_request')
    const part = Buffer.alloc(Math.min(REMOTE_BOT_IMAGE_PART_BYTES, size - offset))
    const { bytesRead } = part.length ? await handle.read(part, 0, part.length, offset) : { bytesRead: 0 }
    return { name: file.name, mime, size, offset, dataB64: part.subarray(0, bytesRead).toString('base64') }
  } finally {
    await handle.close()
  }
}

/** An engine refusal as a plain error; it never becomes an uncertain outcome. */
function refusal(error: unknown): never {
  if (error instanceof NetError) throw error
  const code = (error as { code?: unknown } | undefined)?.code
  // Only the engine's own refusals (which carry a code and plain words) are passed on.
  if (typeof code !== 'string') throw error
  const message = error instanceof Error ? error.message : undefined
  if (isBotActionRefusalCode(code))
    throw new NetError('conflict', undefined, { details: { reason: code } })
  if (code === 'bot_not_found') throw new NetError('stream_unknown', 'This bot is gone.')
  if (code.endsWith('_not_found') || code === 'not_found') throw new NetError('stream_unknown', message)
  throw new NetError(code === 'invalid_params' ? 'bad_request' : 'conflict', message)
}

function refusing<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    refusal(error)
  }
}

/**
 * `deviceLimit` read from this computer's device settings (Settings, Devices): the device's own limit, and for a device
 * with no limit on record the device policy's default, Accept edits, the most it may run directly.
 */
export function botDeviceLimitFrom(policy: { get(node: NodeId): { maxPermissionMode: PermissionMode } }): (node: string) => PermissionMode {
  return (node) => policy.get(node as NodeId).maxPermissionMode
}

export function remoteBotMethods(options: {
  /** The profile's bots; undefined when its `bots.db` could not be opened. */
  bots(): RemoteBotsPort | undefined
  /**
   * The most this computer lets the calling device run a turn in (Settings, Devices). A message from it holds what the
   * bot starts or messages in that chat turn to it, and its Allow of "use your threads" needs Full access. The service
   * passes `botDeviceLimitFrom` (a device with none on record: Accept edits). Absent (tests only): the strictest, Ask.
   */
  deviceLimit?(node: string): PermissionMode
  /**
   * Which bots the calling device reaches and what it may do with them (`BotReachPort`): its bot level here, and each
   * bot's Devices choice. Absent (tests of other things only): every device reaches every bot at Full.
   */
  reach?: Pick<BotReachPort, 'canReach' | 'level'> & Partial<Pick<BotReachPort, 'hiddenFor'>>
  /**
   * A bot a device just made: it is kept within reach of that device (its choice gains the device), so the device is not
   * locked out of what it made. A bot with a choice of its own saved (asked for at creation, or set since) is left as it
   * is (`keepMakerInReach`). No other bot changes.
   */
  madeBy?(botId: string, node: string): void
  /**
   * Opens a bot stream for the calling device alone (`bridge.bots.open`, `bridge.bot.open`), after this gate: the
   * device's bot level (any but Off) and, for one bot's chat, that bot in its reach. Absent: neither is offered.
   */
  openStream?(reader: NodeId, stream: { kind: 'bots' } | { kind: 'bot'; botId: string }): Promise<RemoteBotStreamOpened>
  /**
   * Files another device sends ahead of a message (`bots.stage`), each bound to the bot and the device that sent it.
   * Absent: `bots.stage` refuses, and a message names no staged file.
   */
  staging?: Pick<BotStaging, 'checkBegin' | 'checkAppend' | 'begin' | 'append' | 'take' | 'check' | 'drop'>
  /**
   * Which devices reach each bot, as About's Devices row reads and sets it here (`bots.devices.get`, `bots.devices.set`).
   * Absent: both refuse, as on a computer that keeps no such choice. `known`: the account's devices now, connected or
   * not, which a choice sent by another device may name (undefined while they can't be read: not checked then).
   */
  devices?: Pick<BotDevicesSource, 'store' | 'devices' | 'changed'> & { known?(): readonly string[] | undefined }
}): RpcMethod[] {
  const limitOf = (context: RpcContext): PermissionMode => {
    try {
      return options.deviceLimit?.(context.caller.node) ?? 'ask'
    } catch {
      return 'ask'
    }
  }
  /**
   * The gate: the device's bot level here against the row's level (`BOT_METHODS`), read on every admission, every run
   * and every saved-result lookup, so a change applies to the device's next request. Off refuses every call alike, and
   * a Use device every Full row alike: only the code and the reason cross the wire, the same for every bot, so nothing
   * tells one bot from another. Which bot it reaches is the second check (`reachable`).
   */
  const admit = (node: string, name: RemoteBotMethod | 'use'): void => {
    if (!options.reach) return
    let level: BotLevel
    try {
      level = options.reach.level(node)
    } catch {
      level = 'off'
    }
    if (level === 'off')
      throw new NetError('forbidden', "This computer doesn't let this device reach its bots.", { details: { reason: 'bots_off' } })
    if (!botLevelReaches(level, name === 'use' ? 'use' : remoteBotLevel(name)))
      throw new NetError('forbidden', 'This computer lets this device use its bots, not set them up.', {
        details: { reason: 'bots_full_needed' }
      })
  }
  const bots = (context: RpcContext, name: RemoteBotMethod): RemoteBotsPort => {
    admit(context.caller.node, name)
    const port = options.bots()
    if (!port) throw new NetError('conflict', 'Bots are unavailable on this computer.')
    return port
  }
  /** What a bot that is not there answers; a bot the device may not reach answers the same, word for word. */
  const absent = (): never => {
    throw new NetError('stream_unknown', 'This bot is gone.')
  }
  /** The bot the call names, which the calling device must reach. */
  const reachable = (botId: string, context: RpcContext): void => {
    if (options.reach && !options.reach.canReach(botId, context.caller.node)) absent()
  }
  /**
   * The bot each kept call named, by execution: a saved result is asked for by request id alone (`rpc.result.get`), with
   * no parameters to check. Kept in memory, the newest few thousand; a result whose bot is no longer known here (this
   * service restarted since) goes only to a device that no bot is held from.
   */
  const named = new Map<string, string>()
  const remember = (execution: string | undefined, botId: string): void => {
    if (!execution) return
    named.delete(execution)
    named.set(execution, botId)
    if (named.size > 4096) named.delete(named.keys().next().value as string)
  }
  /** Before a saved result of a bot call is handed back: the device must still reach the bot it named. */
  const savedResult = (execution: string, caller: RpcContext['caller'], name: RemoteBotMethod): void => {
    admit(caller.node, name)
    if (!options.reach) return
    const botId = named.get(execution)
    if (botId !== undefined) {
      if (!options.reach.canReach(botId, caller.node)) absent()
      return
    }
    const hidden = options.reach.hiddenFor
    if (!hidden || hidden(caller.node) !== undefined) throw new NetError('outcome_uncertain')
  }
  /** A bot the call names must be there, and within the device's reach; checked before the call is admitted. */
  const known = (params: unknown, context: RpcContext, name: RemoteBotMethod): void => {
    const botId = (params as { botId?: unknown }).botId
    const port = bots(context, name)
    if (typeof botId !== 'string') return
    reachable(botId, context)
    refusing(() => port.get(botId))
  }
  type Check = (p: Record<string, unknown>, port: RemoteBotsPort, context: RpcContext) => void
  /**
   * One remote row. Every way in (admission, a new call's check, the run, a saved result's lookup) passes the gate with
   * this row's level; `firstCheck` (`first`) adds a check for a new call only, after the gate.
   */
  const method = (
    name: RemoteBotMethod,
    handle: (p: Record<string, unknown>, port: RemoteBotsPort, context: RpcContext) => Promise<unknown>,
    firstCheck?: { check: Check }
  ): RpcMethod => ({
    method: name,
    family: 'bridge',
    ...REMOTE_BOT_METHODS[name],
    // A read's result is the chat itself: it is never kept in the request ledger on disk.
    ...(REMOTE_BOT_METHODS[name].mutating ? {} : { ephemeral: true }),
    validate: (value) => validateRemoteBotParams(name, value),
    authorize: (value, context) => known(value, context, name),
    authorizeResult: (execution, caller) => savedResult(execution, caller, name),
    ...(firstCheck
      ? {
          authorizeNew: (value: unknown, context: RpcContext) => {
            const p = value as Record<string, unknown>
            refusing(() => firstCheck.check(p, bots(context, name), context))
          }
        }
      : {}),
    handle: async (value, context) => {
      const p = value as Record<string, unknown>
      const port = bots(context, name)
      // Read again as the call runs: a device taken off the bot meanwhile gets nothing.
      if (typeof p.botId === 'string') {
        reachable(p.botId, context)
        remember(context.execution, p.botId)
      }
      // A read refuses plainly whatever happens; a change refused after it started is reported as it is.
      if (!REMOTE_BOT_METHODS[name].mutating) {
        try {
          return await handle(p, port, context)
        } catch (error) {
          refusal(error)
        }
      }
      return handle(p, port, context)
    }
  })
  /** For a new call only (a retry of one that went through gets its saved result): `check` refuses plainly. */
  const first = (check: Check): { check: Check } => ({ check })
  const gone = (what: string): never => {
    throw new NetError('stream_unknown', `${what} is gone.`)
  }
  const botId = (p: Record<string, unknown>): string => p.botId as string
  /** A message names staged files only where files are taken from other devices. */
  const stagingOf = (): NonNullable<typeof options.staging> => {
    if (!options.staging) throw new NetError('stream_unknown', 'That file is no longer held. Send it again.', { details: { reason: 'stage_not_found' } })
    return options.staging
  }
  /** Where files from other devices are held, on a computer that takes them. */
  const stagerOf = (): NonNullable<typeof options.staging> => {
    if (!options.staging) throw new NetError('conflict', 'This computer takes no files from other devices.')
    return options.staging
  }
  const takeStaged = (node: string, bot: string, ids: readonly string[]): Array<{ name: string; path: string }> => stagingOf().take(node, bot, ids)
  /** Where each bot's Devices choice is kept, on a computer that keeps one. */
  const devicesOf = (): NonNullable<typeof options.devices> => {
    if (!options.devices) throw new NetError('conflict', 'Which devices reach a bot can only be set on its own computer.')
    return options.devices
  }
  /** The calling device among the devices listed, marked: it shows as the device in hand, and is never left out. */
  const withCaller = (devices: readonly BotDeviceChoice[], node: string): BotDeviceChoice[] =>
    devices.map((device) => (device.node === node ? { ...device, caller: true as const } : device))
  /**
   * A choice a device sends keeps that device: it is never locked out of a bot by its own change, and "this computer
   * alone" from it means this computer and that device.
   */
  const keepingCaller = (access: BotDeviceAccess, node: string): BotDeviceAccess => ({
    mode: 'chosen',
    nodes: access.mode === 'chosen' ? (access.nodes.includes(node) ? [...access.nodes] : [...access.nodes, node]) : [node]
  })
  /**
   * A Devices choice from a device, as it will be saved (`keepingCaller`): within the limit with that device counted,
   * and naming only the account's devices (the device itself always is one, as it is calling). Checked before the call
   * is taken, so a choice refused here is a plain bad request, never an outcome to wonder about. While the account's
   * devices can't be read, only a choice naming no other device is taken.
   */
  const checkChosen = (access: BotDeviceAccess, node: string): void => {
    const refuse = (reason: BotDevicesRefusal) => new NetError('bad_request', BOT_DEVICES_REFUSALS[reason], { details: { reason } })
    const kept = keepingCaller(access, node)
    const others = (kept.mode === 'chosen' ? kept.nodes : []).filter((id) => id !== node)
    if (others.length + 1 > MAX_BOT_DEVICES) throw refuse('bot_devices_too_many')
    if (!others.length) return
    const known = options.devices?.known?.()
    if (!known) throw refuse('bot_devices_unread')
    const account = new Set(known)
    if (others.some((id) => !account.has(id))) throw refuse('bot_devices_unknown')
  }
  /** Runs on's choices as another device gets them: this computer is the only one a bot here lives on. */
  const choicesFor = <T extends Pick<BotRunsOnChoices, 'computers' | 'devices'>>(choices: T, node: string): T => ({
    ...choices,
    computers: choices.computers.filter((computer) => computer.id === 'this_computer'),
    ...(choices.devices ? { devices: withCaller(choices.devices, node) } : {})
  })
  /**
   * Where the Devices choice is kept, with the calling device always among the account's devices: it is connected, as
   * it is calling, though this computer lists as connected only the devices it opened a connection to itself.
   */
  const devicesWithCaller = (node: string): NonNullable<typeof options.devices> => {
    const source = devicesOf()
    return {
      ...source,
      devices: async () => {
        const devices = await source.devices()
        // Not known now: left unknown, as the choice is then saved unchecked.
        if (!devices) return devices
        return devices.some((device) => device.node === node) ? devices : [...devices, { node, name: 'This device', kind: 'unknown' }]
      }
    }
  }
  const devicesView = async (bot: string, node: string): Promise<BotDevicesView> => {
    const view = await botDevicesView(devicesWithCaller(node), bot)
    return { ...view, devices: withCaller(view.devices, node) }
  }
  const actionSize = (p: Record<string, unknown>, port: RemoteBotsPort): void => {
      if (p.answer === 'send') {
        const message = port.actionMessage(botId(p), p.actionId as string)
        // Include the page envelope too: fittedPage may cut its only message to leave room for it.
        const page = port.chatList(botId(p), { limit: 1, beforeSeq: message.seq + 1 })
        if (bytes({ ...page, messages: [remoteBotMessage(message, botId(p))] }) + 1 > RESULT_BYTES)
          throw new NetError('conflict', botActionRefusalText('bot_action_too_large'), { details: { reason: 'bot_action_too_large' } })
      }
  }
  /**
   * The bot streams: the bots feed and one bot's chat, each the caller's own. The same gate as every row: the bot level
   * (at least Use) when the open is admitted and again as it runs; a bot it can't reach answers as one that is not
   * there. Every read afterwards is checked again where the stream is served (`privateReadable` in the Bridge).
   */
  const streamMethod = (name: 'bridge.bots.open' | 'bridge.bot.open', open: NonNullable<typeof options.openStream>): RpcMethod => {
    const botOf = (value: unknown): string | undefined => (name === 'bridge.bot.open' ? (value as { botId: string }).botId : undefined)
    const check = (value: unknown, context: RpcContext): void => {
      admit(context.caller.node, 'use')
      const id = botOf(value)
      if (id === undefined) return
      reachable(id, context)
      const port = options.bots()
      if (!port) throw new NetError('conflict', 'Bots are unavailable on this computer.')
      refusing(() => port.get(id))
    }
    return {
      method: name,
      family: 'bridge',
      ...BOT_STREAM_METHODS[name],
      ephemeral: true,
      validate: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetError('bad_request')
        const keys = Object.keys(value)
        if (name === 'bridge.bots.open') {
          if (keys.length) throw new NetError('bad_request')
          return {}
        }
        if (keys.length !== 1 || !isBotId((value as { botId?: unknown }).botId)) throw new NetError('bad_request')
        return { botId: (value as { botId: string }).botId }
      },
      authorize: check,
      handle: async (value, context) => {
        check(value, context)
        const id = botOf(value)
        return open(context.caller.node, id === undefined ? { kind: 'bots' } : { kind: 'bot', botId: id })
      }
    }
  }
  const streams = options.openStream
    ? [streamMethod('bridge.bots.open', options.openStream), streamMethod('bridge.bot.open', options.openStream)]
    : []
  return [
    ...streams,
    method('bots.get', async (p, port) => remoteBotDetail(port.get(botId(p)))),
    method('bots.chat.list', async (p, port) =>
      fittedPage(
        port.chatList(botId(p), {
          ...(p.beforeSeq !== undefined ? { beforeSeq: p.beforeSeq as number } : {}),
          ...(p.limit !== undefined ? { limit: p.limit as number } : {})
        }),
        botId(p)
      )
    ),
    method('bots.chat.attachment', async (p, port) =>
      imagePart(port.attachmentFile(botId(p), p.messageId as string, p.index as number), (p.offset as number | undefined) ?? 0)
    ),
    // A file of the bot's files folder, a page at a time: only inside that folder, never SVG (`readBotFilePage`).
    method('bots.chat.file', async (p, port) => readBotFilePage(port.filesFolderOf(botId(p)), p.path as string, (p.offset as number | undefined) ?? 0)),
    // A file for a message to this bot, in parts. Each part passes the gate again, so a device that lost the bot sends
    // no more; the file is bound to this bot and this device, and only a message of theirs takes it.
    // Every refusal is given before the call is taken (`first`), so the device reads it as certain, never as a change
    // that may have happened; the part is checked again as it is written.
    method('bots.stage', async (p, _port, context) => {
      const staging = stagerOf()
      const part = Buffer.from(p.dataB64 as string, 'base64')
      if (p.stage === undefined) return staging.begin(context.caller.node, botId(p), p.name as string, p.size as number, part)
      return staging.append(context.caller.node, botId(p), p.stage as string, p.offset as number, part)
    }, first((p, _port, context) => {
      const staging = stagerOf()
      const part = Buffer.from(p.dataB64 as string, 'base64')
      if (p.stage !== undefined) return staging.checkAppend(context.caller.node, botId(p), p.stage as string, p.offset as number, part.length)
      // An SVG is never taken from another device, by its name or its first bytes; the whole file's start is looked at
      // again when its last part arrives (`BotStaging`).
      if (isSvgName(p.name as string) || looksLikeSvg(part, part.length === p.size))
        throw new NetError('conflict', 'SVG files can’t be sent to another computer.', { details: { reason: 'svg' } })
      staging.checkBegin(context.caller.node, p.name as string, p.size as number)
    })),
    method('bots.memory.list', async (p, port) => port.memoryList(botId(p))),
    method('bots.chat.send', async (p, port, context) => {
      const staged = (p.staged as string[] | undefined) ?? []
      // Checked again as it runs: each file must be one this device staged for this bot, whole and unused.
      const files = staged.length ? takeStaged(context.caller.node, botId(p), staged) : []
      let message: BotChatMessage
      try {
        // A retry with the same `clientRequestId` returns the first message and adds no second one.
        ;({ message } = await port.chatSend({
          botId: botId(p),
          text: p.text as string,
          ...(files.length ? { attachments: files } : {}),
          clientRequestId: p.clientRequestId as string,
          ...(typeof p.replyTo === 'string' ? { replyTo: p.replyTo } : {}),
          // The device it came from: a message still queued when the device loses the bot is not delivered.
          from: { limit: limitOf(context), node: context.caller.node }
        }))
      } finally {
        // Used or refused, a staged file is done with: its copy is in the bot's files folder, or the device sends again.
        options.staging?.drop(staged)
      }
      return { message: fitted(remoteBotMessage(message, botId(p))) }
    }, first((p, _port, context) => {
      const staged = p.staged as string[] | undefined
      if (staged?.length) stagingOf().check(context.caller.node, botId(p), staged)
    })),
    method('bots.chat.stop', async (p, port) => port.chatStop(botId(p))),
    method('bots.work.stop', async (p, port) => {
      try {
        return await port.workStop(botId(p), p.workId as string)
      } catch (error) {
        // Work the bot does not have (any more) is not running: nothing was stopped.
        if ((error as { code?: unknown } | undefined)?.code === 'work_not_found') return { stopped: false }
        throw error
      }
    }),
    method('bots.chat.markRead', async (p, port) => port.markRead(botId(p), p.seq as number)),
    method(
      'bots.asks.answer',
      async (p, port) => {
        const { message } = await port.answer(botId(p), p.askId as string, p.answer as 'allow' | 'not_now')
        return { message: fitted(remoteBotMessage(message, botId(p))) }
      },
      first((p, port, context) => {
        const kind = port.askKind(botId(p), p.askId as string)
        // A memory export asks for a folder on this computer.
        if (kind === 'export_memory') throw new NetError('forbidden', 'Answer this on the computer.')
        // "Use your threads" starts threads that run with full access: only a device this computer lets run Full access
        // may allow it. Not now works from any device.
        if (kind === 'threads' && p.answer === 'allow' && limitOf(context) !== 'full')
          throw new NetError('forbidden', 'Allow this on the computer.')
      })
    ),
    // A tap on a question's answer is the owner's chat message, as `bots.chat.send` is: held to the device's limit and
    // dropped with the device. It grants nothing, so any device that may chat may answer. One already answered (on
    // another device) or no longer open is refused before anything is written.
    method(
      'bots.questions.answer',
      async (p, port, context) => {
        const { message, question } = await port.answerQuestion({
          botId: botId(p),
          questionId: p.questionId as string,
          choice: p.choice as string,
          clientRequestId: p.clientRequestId as string,
          from: { limit: limitOf(context), node: context.caller.node }
        })
        return { message: fitted(remoteBotMessage(message, botId(p))), ...(question ? { question: fitted(remoteBotMessage(question, botId(p))) } : {}) }
      },
      first((p, port) => port.questionCheck(botId(p), p.questionId as string))
    ),
    method('bots.actions.answer', async (p, port) => {
      actionSize(p, port)
      return port.answerAction({ botId: botId(p), actionId: p.actionId as string, digest: p.digest as string, answer: p.answer as 'send' | 'not_now' })
    }, first((p, port) => {
      port.actionCheck({ botId: botId(p), actionId: p.actionId as string, digest: p.digest as string, answer: p.answer as 'send' | 'not_now' })
      actionSize(p, port)
    })),
    method('bots.reminders.snooze', async (p, port) => fitted(remoteBotMessage(port.reminderSnooze(botId(p), p.messageId as string, p.choice as import('../../../shared/bots/personal/chat').BotSnoozeChoice), botId(p)))),
    method('bots.personal.pause', async (p, port) => ({ bot: remoteBotSummary(port.pause(botId(p)).bot) })),
    method('bots.personal.resume', async (p, port) => ({ bot: remoteBotSummary((await port.resume(botId(p))).bot) })),
    method('bots.create', async (p, port, context) => {
      const before = new Set(port.list().bots.map((bot) => bot.id))
      // Saved before the bot is published (`BotChatService.create`): this computer, the calling device and the devices
      // New bot's Devices step ticked (`access`), so no other device lists the bot even for a moment. Whatever `reach`
      // says: `all`, from a phone made before the lists were explicit, is taken as `home_and_maker`, and so is none.
      const access = keepingCaller((p.access as BotDeviceAccess | undefined) ?? { mode: 'this_computer' }, context.caller.node)
      const { bot } = await port.create({
        look: p.look as BotLook,
        ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name } : {}),
        description: p.description as string,
        clientRequestId: p.clientRequestId as string,
        ...(p.slots !== undefined ? { slots: p.slots as BotModelSlots } : {}),
        ...(p.image !== undefined ? { image: p.image as BotModelPick } : {}),
        access
      })
      remember(context.execution, bot.id)
      // The device that made it keeps it within reach; a request id that names a bot made before is answered only if the
      // device reaches that bot, and never widens it.
      if (before.has(bot.id)) reachable(bot.id, context)
      else
        try {
          options.madeBy?.(bot.id, context.caller.node)
        } catch {
          // The choice could not be written: the bot keeps what was saved for it, or what a new bot has (this computer
          // alone) until the owner picks. The device still learns of the bot it just made, and of nothing else.
        }
      return { bot: remoteBotSummary(bot) }
    }, first((p, _port, context) => checkChosen((p.access as BotDeviceAccess | undefined) ?? { mode: 'this_computer' }, context.caller.node))),
    method('bots.update', async (p, port) => {
      const { bot } = port.update(botId(p), {
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
        ...(p.look !== undefined ? { look: p.look as BotLook } : {}),
        ...(p.description !== undefined ? { description: p.description as string | null } : {})
      })
      return { bot: remoteBotSummary(bot) }
    }),
    method('bots.delete', async (p, port) => port.delete(botId(p))),
    // Runs on, as this computer offers it: its own entries and models. The bot lives here, so no other computer is offered.
    method('bots.model.get', async (p, port, context) => choicesFor(await port.modelGet(botId(p)), context.caller.node)),
    method('bots.model.choices', async (_p, port, context) => choicesFor(await port.modelChoices(), context.caller.node)),
    method('bots.model.setSlots', async (p, port) => {
      const { bot } = await port.modelSlotsSet(botId(p), p.oneWork === true ? { oneWork: true } : { slots: p.slots as Partial<BotModelSlots> })
      return { bot: remoteBotSummary(bot) }
    }),
    method('bots.model.setImage', async (p, port) => {
      const { bot } = await port.modelImageSet(botId(p), p.pick as BotModelPick | null)
      return { bot: remoteBotSummary(bot) }
    }),
    method('bots.devices.get', async (p, _port, context) => devicesView(botId(p), context.caller.node)),
    method(
      'bots.devices.set',
      async (p, _port, context) => {
        // Checked before the call was taken (`checkChosen`): saved as it is.
        const source = devicesOf()
        source.store.set(botId(p), keepingCaller(p.access as BotDeviceAccess, context.caller.node))
        source.changed?.(botId(p))
        return devicesView(botId(p), context.caller.node)
      },
      first((p, _port, context) => {
        devicesOf()
        checkChosen(p.access as BotDeviceAccess, context.caller.node)
      })
    ),
    method(
      'bots.reminders.cancel',
      async (p, port) => remoteBotDetail(port.reminderCancel(botId(p), p.reminderId as string)),
      first((p, port) => {
        if (!port.get(botId(p)).reminders?.some((item) => item.id === p.reminderId)) gone('This reminder')
      })
    ),
    method(
      'bots.schedules.remove',
      async (p, port) => remoteBotDetail(port.removeSchedule(botId(p), p.scheduleId as string)),
      first((p, port) => {
        if (!port.get(botId(p)).runs.some((item) => item.id === p.scheduleId)) gone('This schedule')
      })
    ),
    method(
      'bots.permissions.set',
      async (p, port) => remoteBotDetail(port.setPermission(botId(p), p.permissionId as string, p.enabled as boolean)),
      first((p, port, context) => {
        // Full bot access never widens thread access: Allow everything gives "use your threads" too, so turning it on
        // needs Full access here, as that permission does. Turning it off works from any device at Full.
        if (p.permissionId === BOT_FULL_TRUST_PERMISSION) {
          if (p.enabled && limitOf(context) !== 'full') throw new NetError('forbidden', 'Allow this on the computer.')
          return
        }
        const permission = port.get(botId(p)).permissions.find((item) => item.id === p.permissionId)
        if (!permission) gone('This permission')
        // Same rule as Allow on its card. The fingerprint is the permission's canonical request.
        if (p.enabled && limitOf(context) !== 'full' && permission?.needsFullAccess === true)
          throw new NetError('forbidden', 'Allow this on the computer.')
      })
    ),
    method(
      'bots.permissions.revoke',
      async (p, port) => remoteBotDetail(port.revokePermission(botId(p), p.permissionId as string)),
      first((p, port) => {
        if (!port.get(botId(p)).permissions.some((item) => item.id === p.permissionId)) gone('This permission')
      })
    ),
    method(
      'bots.memory.forget',
      async (p, port) => port.memoryForget(botId(p), p.id as string),
      first((p, port) => {
        if (!port.memoryList(botId(p)).entries.some((entry) => entry.id === p.id && entry.status === 'active')) gone('This memory')
      })
    ),
    method(
      'bots.memory.edit',
      async (p, port) => ({ entry: port.memoryEdit(botId(p), p.id as string, p.text as string) }),
      first((p, port) => {
        const id = (p.id as string).replace(/v[0-9]+$/, '')
        if (!port.memoryList(botId(p)).entries.some((entry) => entry.id === id && entry.status === 'active')) gone('This memory')
      })
    )
  ]
}
