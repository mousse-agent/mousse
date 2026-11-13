import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { NetError, type NodeCapability, type NodeId } from '../../../shared/net'
import type { BotChatMessage, BotDetail, BotError, BotSummary } from '../../../shared/bots/personal/chat'
import { MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS } from '../../../shared/bots/personal/definition'
import type { BotLook } from '../../../shared/bots/personal/look'
import type { BotMemoryForgetResult, BotMemoryListing } from '../../../shared/bots/personal/memory'
import { MAX_BOT_CHAT_ATTACHMENTS, MAX_BOT_CHAT_PAGE, type BotsPersonalV2Api } from '../../../shared/bots/personal/methods'
import type { RpcContext, RpcMethod } from '../../net/contracts'
import type { PermissionMode } from '../../../shared/permissionMode'
import { canonicalJson } from '../../net/sync/codec'
import { isBotId } from '../../bots/definitions/BotDefinitionStore'
import type { BotReachPort } from '../../protocol/botReachPort'

/**
 * The personal-bot methods of the user's other devices (phones and other computers): a bot's chat and its images, its
 * asks, its pause, what it remembers and the rest of About, and a new bot. Deny-default like `BRIDGE_REMOTE_METHODS`;
 * each one calls the same `BotChatService` method the desktop's `bots.*` handler calls, with the same params (less
 * `attachments`, which name files on this computer) and results. No result carries a model, an instance id or a path
 * on this computer. While "Share bots with other devices" is off, every one is refused.
 *
 * Which devices reach which bot (`docs/bots.md`, Which devices reach a bot) is checked in `remoteBotMethods`'s one
 * wrapper, so a method added here later is held to it too: a device whose switch for bots is off is refused every one,
 * and a bot whose Devices choice leaves the device out answers exactly as a bot that is not there.
 */
export const REMOTE_BOT_METHODS = {
  'bots.get': { capability: 'read', mutating: false },
  'bots.chat.list': { capability: 'read', mutating: false },
  'bots.chat.attachment': { capability: 'read', mutating: false },
  'bots.memory.list': { capability: 'read', mutating: false },
  'bots.chat.send': { capability: 'chat', mutating: true },
  'bots.chat.stop': { capability: 'chat', mutating: true },
  'bots.work.stop': { capability: 'chat', mutating: true },
  'bots.chat.markRead': { capability: 'chat', mutating: true },
  'bots.asks.answer': { capability: 'chat', mutating: true },
  'bots.personal.pause': { capability: 'write', mutating: true },
  'bots.personal.resume': { capability: 'write', mutating: true },
  'bots.create': { capability: 'write', mutating: true },
  'bots.update': { capability: 'write', mutating: true },
  'bots.reminders.cancel': { capability: 'write', mutating: true },
  'bots.schedules.remove': { capability: 'write', mutating: true },
  'bots.permissions.revoke': { capability: 'write', mutating: true },
  'bots.memory.forget': { capability: 'write', mutating: true }
} as const satisfies Record<string, { capability: NodeCapability; mutating: boolean }>
export type RemoteBotMethod = keyof typeof REMOTE_BOT_METHODS

/** What the remote methods use of the profile's bots (`BotChatService`). */
export interface RemoteBotsPort {
  list(): { bots: BotSummary[] }
  get(botId: string): BotDetail
  chatList(botId: string, page?: { beforeSeq?: number; limit?: number }): BotsPersonalV2Api['bots.chat.list']['result']
  chatSend(input: { botId: string; text: string; clientRequestId: string; replyTo?: string; from?: { limit: PermissionMode; node?: string } }): Promise<{ message: BotChatMessage }>
  chatStop(botId: string): Promise<Record<string, never>>
  workStop(botId: string, workId: string): Promise<{ stopped: boolean }>
  markRead(botId: string, seq: number): Record<string, never>
  askKind(botId: string, askId: string): 'permission' | 'export_memory' | 'threads'
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<{ message: BotChatMessage }>
  pause(botId: string): { bot: BotSummary }
  resume(botId: string): Promise<{ bot: BotSummary }>
  create(input: { look: BotLook; name?: string; description: string; clientRequestId: string }): Promise<{ bot: BotSummary }>
  update(botId: string, change: { name?: string; look?: BotLook }): { bot: BotSummary }
  reminderCancel(botId: string, reminderId: string): BotDetail
  removeSchedule(botId: string, scheduleId: string): BotDetail
  revokePermission(botId: string, id: string): BotDetail
  memoryList(botId: string, history?: boolean): BotMemoryListing
  memoryForget(botId: string, id: string): BotMemoryForgetResult
  attachmentFile(botId: string, messageId: string, index: number): { name: string; path: string }
}

const KEYS: Record<RemoteBotMethod, { required: readonly string[]; optional?: readonly string[] }> = {
  'bots.get': { required: ['botId'] },
  'bots.chat.list': { required: ['botId'], optional: ['beforeSeq', 'limit'] },
  'bots.chat.attachment': { required: ['botId', 'messageId', 'index'], optional: ['offset'] },
  'bots.memory.list': { required: ['botId'] },
  // No `attachments`: they name files on this computer, which another device has none of.
  'bots.chat.send': { required: ['botId', 'text', 'clientRequestId'], optional: ['replyTo'] },
  'bots.chat.stop': { required: ['botId'] },
  'bots.work.stop': { required: ['botId', 'workId'] },
  'bots.chat.markRead': { required: ['botId', 'seq'] },
  'bots.asks.answer': { required: ['botId', 'askId', 'answer'] },
  'bots.personal.pause': { required: ['botId'] },
  'bots.personal.resume': { required: ['botId'] },
  'bots.create': { required: ['look', 'description', 'clientRequestId'], optional: ['name'] },
  'bots.update': { required: ['botId'], optional: ['name', 'look'] },
  'bots.reminders.cancel': { required: ['botId', 'reminderId'] },
  'bots.schedules.remove': { required: ['botId', 'scheduleId'] },
  'bots.permissions.revoke': { required: ['botId', 'permissionId'] },
  'bots.memory.forget': { required: ['botId', 'id'] }
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const ASK_ID = /^esc_[0-9a-f-]{36}$/
const WORK_ID = /^act_[0-9a-f-]{36}$/
const REMINDER_ID = /^rem_[0-9a-f-]{36}$/
const SCHEDULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const MEMORY_ID = /^m[0-9]{1,12}$/
const LOOK_KEYS = new Set(['colour', 'accessory', 'kind', 'eyes'])
/**
 * A remote message, in bytes. The desktop's limit is 64K characters; a remote one is smaller so the message the
 * send returns stays within one RPC reply.
 */
export const REMOTE_BOT_MESSAGE_BYTES = 32 * 1024
/** A read's result stays below one RPC reply (63 KiB); older messages are left for the next page. */
const RESULT_BYTES = 56 * 1024
/** The largest image another device may read from a bot's chat. */
export const REMOTE_BOT_IMAGE_BYTES = 1536 * 1024
/** One part of an image: 40 KiB, under 55 KiB as base64, so a part fits one reply. */
export const REMOTE_BOT_IMAGE_PART_BYTES = 40 * 1024

/** The types a remote device may read: raster images only, never SVG (which can carry scripts). */
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const OTHER_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime'
}
const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? ''

/** A file's type by its name; `image` only for the raster types `bots.chat.attachment` reads. */
export function remoteFileType(name: string): { mime: string; image?: true } {
  const extension = extensionOf(name)
  const image = IMAGE_TYPES[extension]
  if (image) return { mime: image, image: true }
  return { mime: OTHER_TYPES[extension] ?? 'application/octet-stream' }
}

/** The type an image's first bytes say it is; undefined for anything that is not a PNG, JPEG, GIF or WebP. */
export function sniffImage(head: Buffer): string | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

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
    (look.eyes === undefined || text(look.eyes, 40))
  )
}

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
  const { required, optional = [] } = KEYS[method]
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
    case 'bots.chat.send':
      ok(text(p.text, REMOTE_BOT_MESSAGE_BYTES) && Buffer.byteLength(p.text as string) <= REMOTE_BOT_MESSAGE_BYTES)
      if (p.replyTo !== undefined) ok(text(p.replyTo, 200))
      break
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
    case 'bots.create':
      ok(lookOf(p.look))
      ok(text(p.description, MAX_BOT_DESCRIPTION_CHARS))
      if (p.name !== undefined) ok(typeof p.name === 'string' && p.name.length <= MAX_BOT_NAME_CHARS)
      break
    case 'bots.update':
      ok(p.name !== undefined || p.look !== undefined)
      if (p.name !== undefined) ok(text(p.name, MAX_BOT_NAME_CHARS))
      if (p.look !== undefined) ok(lookOf(p.look))
      break
    case 'bots.reminders.cancel':
      ok(typeof p.reminderId === 'string' && REMINDER_ID.test(p.reminderId))
      break
    case 'bots.schedules.remove':
      ok(typeof p.scheduleId === 'string' && SCHEDULE_ID.test(p.scheduleId))
      break
    case 'bots.permissions.revoke':
      ok(text(p.permissionId, 4096))
      break
    case 'bots.memory.forget':
      ok(typeof p.id === 'string' && MEMORY_ID.test(p.id))
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
  const { error, ...rest } = bot
  return { ...rest, ...(error ? { error: remoteBotError(error) } : {}) }
}

/** About a bot as another device sees it. */
export function remoteBotDetail(detail: BotDetail): BotDetail {
  return { ...detail, summary: remoteBotSummary(detail.summary) }
}

/** An attached file as another device sees it: its name and type; `image` when `bots.chat.attachment` reads it. */
export interface RemoteBotFile {
  name: string
  mime: string
  image?: true
}

/** A chat row as another device sees it. */
export type RemoteBotMessage = Omit<BotChatMessage, 'attachments' | 'applets'> & { attachments?: RemoteBotFile[] }

/**
 * A chat row as another device sees it: a file's name and type without its path on this computer, an error without an
 * instance id, and an applet as one line naming it (it runs only in this computer's app, from the bot's thread here).
 */
export function remoteBotMessage(message: BotChatMessage): RemoteBotMessage {
  const { attachments, error, applets, ...rest } = message
  // The title is the bot's words: plain, so it can't add a link or an image to the line.
  const named = applets?.map((applet) => `_Applet: ${applet.reference.title.replace(/[\\`*_[\]()<>!#|~]/g, '').trim()}. It opens on the computer._`).join('\n')
  return {
    ...rest,
    ...(named ? { text: rest.text ? `${rest.text}\n\n${named}` : named } : {}),
    ...(error ? { error: remoteBotError(error) } : {}),
    ...(attachments ? { attachments: attachments.map((file) => ({ name: file.name, ...remoteFileType(file.path || file.name) })) } : {})
  }
}

const bytes = (value: unknown): number => Buffer.byteLength(canonicalJson(value))

/** One message within a reply: a very long text is cut, with a note that the rest is on the computer. */
function fitted(message: RemoteBotMessage, budget = RESULT_BYTES): RemoteBotMessage {
  if (bytes(message) <= budget) return message
  const over = bytes(message) - budget
  const keep = Math.max(0, Buffer.byteLength(message.text) - over - 256)
  let cut = Buffer.from(message.text).subarray(0, keep).toString()
  // A cut through a character leaves a replacement character at the end.
  cut = cut.replace(/�+$/, '')
  return { ...message, text: `${cut}\n\n… (the rest is on the computer)` }
}

type RemotePage = Omit<BotsPersonalV2Api['bots.chat.list']['result'], 'messages'> & { messages: RemoteBotMessage[] }

/** A page within one reply: the newest messages that fit; the device asks for the older ones with `beforeSeq`. */
function fittedPage(page: BotsPersonalV2Api['bots.chat.list']['result']): RemotePage {
  const messages = page.messages.map(remoteBotMessage)
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

/** One part of an image file of a bot's chat, checked to be a raster image within the size limit. */
function imagePart(file: { name: string; path: string }, offset: number): { name: string; mime: string; size: number; offset: number; dataB64: string } {
  if (!remoteFileType(file.name).image && !remoteFileType(file.path).image)
    throw new NetError('conflict', 'Only images open on another device.')
  let fd: number
  try {
    fd = openSync(file.path, 'r')
  } catch {
    throw new NetError('stream_unknown', `${file.name} is no longer on the computer.`)
  }
  try {
    const size = fstatSync(fd).size
    if (size > REMOTE_BOT_IMAGE_BYTES) throw new NetError('too_large', `${file.name} is too large to show here. Open it on the computer.`)
    const head = Buffer.alloc(Math.min(16, size))
    readSync(fd, head, 0, head.length, 0)
    const mime = sniffImage(head)
    if (!mime) throw new NetError('conflict', 'Only images open on another device.')
    if (offset > size) throw new NetError('bad_request')
    const part = Buffer.alloc(Math.min(REMOTE_BOT_IMAGE_PART_BYTES, size - offset))
    const read = part.length ? readSync(fd, part, 0, part.length, offset) : 0
    return { name: file.name, mime, size, offset, dataB64: part.subarray(0, read).toString('base64') }
  } finally {
    closeSync(fd)
  }
}

/** An engine refusal as a plain error; it never becomes an uncertain outcome. */
function refusal(error: unknown): never {
  if (error instanceof NetError) throw error
  const code = (error as { code?: unknown } | undefined)?.code
  // Only the engine's own refusals (which carry a code and plain words) are passed on.
  if (typeof code !== 'string') throw error
  const message = error instanceof Error ? error.message : undefined
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
   * "Share bots with other devices": undefined while it is on, the refusal's words while it is off. Every call is
   * refused then, with `forbidden` and the reason `setting_off` (the words stay on this computer: an error's own
   * words never cross the wire).
   */
  refusal?(): string | undefined
  /**
   * The most this computer lets the calling device run a turn in (Settings, Devices). A message from it holds what the
   * bot starts or messages in that chat turn to it, and its Allow of "use your threads" needs Full access. The service
   * passes `botDeviceLimitFrom` (a device with none on record: Accept edits). Absent (tests only): the strictest, Ask.
   */
  deviceLimit?(node: string): PermissionMode
  /**
   * Which bots the calling device reaches (`BotReachPort`): its switch for bots here, and each bot's Devices choice.
   * Absent (tests of other things only): every device reaches every bot, as before the setting existed.
   */
  reach?: Pick<BotReachPort, 'canReach' | 'deviceOn'> & Partial<Pick<BotReachPort, 'hiddenFor'>>
  /**
   * A bot a device just made: it is kept within reach of that device (its choice gains the device), so the device is not
   * locked out of what it made. No other bot changes.
   */
  madeBy?(botId: string, node: string): void
}): RpcMethod[] {
  const limitOf = (context: RpcContext): PermissionMode => {
    try {
      return options.deviceLimit?.(context.caller.node) ?? 'ask'
    } catch {
      return 'ask'
    }
  }
  const shared = (node: string): void => {
    const words = options.refusal?.()
    if (words) throw new NetError('forbidden', words, { details: { reason: 'setting_off' } })
    // The device's own switch for bots here: off, it is answered as if this computer shared none (only the code and the
    // reason cross the wire, the same for every bot, so nothing tells one bot from another).
    if (options.reach && !options.reach.deviceOn(node))
      throw new NetError('forbidden', "This computer doesn't share its bots with this device.", { details: { reason: 'setting_off' } })
  }
  const bots = (context: RpcContext): RemoteBotsPort => {
    shared(context.caller.node)
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
  const savedResult = (execution: string, caller: RpcContext['caller']): void => {
    shared(caller.node)
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
  const known = (params: unknown, context: RpcContext): void => {
    const botId = (params as { botId?: unknown }).botId
    const port = bots(context)
    if (typeof botId !== 'string') return
    reachable(botId, context)
    refusing(() => port.get(botId))
  }
  const method = (
    name: RemoteBotMethod,
    handle: (p: Record<string, unknown>, port: RemoteBotsPort, context: RpcContext) => Promise<unknown>,
    extra: Partial<RpcMethod> = {}
  ): RpcMethod => ({
    method: name,
    family: 'bridge',
    ...REMOTE_BOT_METHODS[name],
    // A read's result is the chat itself: it is never kept in the request ledger on disk.
    ...(REMOTE_BOT_METHODS[name].mutating ? {} : { ephemeral: true }),
    validate: (value) => validateRemoteBotParams(name, value),
    authorize: (value, context) => known(value, context),
    authorizeResult: (execution, caller) => savedResult(execution, caller),
    ...extra,
    handle: async (value, context) => {
      const p = value as Record<string, unknown>
      const port = bots(context)
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
  const first = (check: (p: Record<string, unknown>, port: RemoteBotsPort, context: RpcContext) => void): Partial<RpcMethod> => ({
    authorizeNew: (value, context) => {
      const p = value as Record<string, unknown>
      refusing(() => check(p, bots(context), context))
    }
  })
  const gone = (what: string): never => {
    throw new NetError('stream_unknown', `${what} is gone.`)
  }
  const botId = (p: Record<string, unknown>): string => p.botId as string
  return [
    method('bots.get', async (p, port) => remoteBotDetail(port.get(botId(p)))),
    method('bots.chat.list', async (p, port) =>
      fittedPage(
        port.chatList(botId(p), {
          ...(p.beforeSeq !== undefined ? { beforeSeq: p.beforeSeq as number } : {}),
          ...(p.limit !== undefined ? { limit: p.limit as number } : {})
        })
      )
    ),
    method('bots.chat.attachment', async (p, port) =>
      imagePart(port.attachmentFile(botId(p), p.messageId as string, p.index as number), (p.offset as number | undefined) ?? 0)
    ),
    method('bots.memory.list', async (p, port) => port.memoryList(botId(p))),
    method('bots.chat.send', async (p, port, context) => {
      // A retry with the same `clientRequestId` returns the first message and adds no second one.
      const { message } = await port.chatSend({
        botId: botId(p),
        text: p.text as string,
        clientRequestId: p.clientRequestId as string,
        ...(typeof p.replyTo === 'string' ? { replyTo: p.replyTo } : {}),
        // The device it came from: a message still queued when the device loses the bot is not delivered.
        from: { limit: limitOf(context), node: context.caller.node }
      })
      return { message: fitted(remoteBotMessage(message)) }
    }),
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
        return { message: fitted(remoteBotMessage(message)) }
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
    method('bots.personal.pause', async (p, port) => ({ bot: remoteBotSummary(port.pause(botId(p)).bot) })),
    method('bots.personal.resume', async (p, port) => ({ bot: remoteBotSummary((await port.resume(botId(p))).bot) })),
    method('bots.create', async (p, port, context) => {
      const before = new Set(port.list().bots.map((bot) => bot.id))
      const { bot } = await port.create({
        look: p.look as BotLook,
        ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name } : {}),
        description: p.description as string,
        clientRequestId: p.clientRequestId as string
      })
      remember(context.execution, bot.id)
      // The device that made it keeps it within reach; a request id that names a bot made before is answered only if the
      // device reaches that bot, and never widens it.
      if (before.has(bot.id)) reachable(bot.id, context)
      else
        try {
          options.madeBy?.(bot.id, context.caller.node)
        } catch {
          // The choice could not be written: the bot keeps what a new bot has (every device, unless what is stored
          // can't be read, when it stays on this computer until the owner picks). The device still learns of the bot
          // it just made, and of nothing else.
        }
      return { bot: remoteBotSummary(bot) }
    }),
    method('bots.update', async (p, port) => {
      const { bot } = port.update(botId(p), {
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
        ...(p.look !== undefined ? { look: p.look as BotLook } : {})
      })
      return { bot: remoteBotSummary(bot) }
    }),
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
    )
  ]
}
