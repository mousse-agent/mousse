import { NetError, type NodeCapability } from '../../../shared/net'
import type { BotChatMessage, BotDetail, BotError, BotSummary } from '../../../shared/bots/personal/chat'
import { MAX_BOT_DESCRIPTION_CHARS, MAX_BOT_NAME_CHARS } from '../../../shared/bots/personal/definition'
import type { BotLook } from '../../../shared/bots/personal/look'
import { MAX_BOT_CHAT_PAGE, type BotsPersonalV2Api } from '../../../shared/bots/personal/methods'
import type { RpcMethod } from '../../net/contracts'
import { canonicalJson } from '../../net/sync/codec'
import { isBotId } from '../../bots/definitions/BotDefinitionStore'

/**
 * The phone's personal-bot methods: a bot's chat, its asks, its pause, and a new bot. Deny-default like
 * `BRIDGE_REMOTE_METHODS`; each one calls the same engine method the desktop's `bots.*` handler calls, with the
 * same params (less `attachments`, which name files on this computer) and results. No result carries a model,
 * an instance id or a path on this computer.
 */
export const REMOTE_BOT_METHODS = {
  'bots.get': { capability: 'read', mutating: false },
  'bots.chat.list': { capability: 'read', mutating: false },
  'bots.chat.send': { capability: 'chat', mutating: true },
  'bots.chat.stop': { capability: 'chat', mutating: true },
  'bots.work.stop': { capability: 'chat', mutating: true },
  'bots.chat.markRead': { capability: 'chat', mutating: true },
  'bots.asks.answer': { capability: 'chat', mutating: true },
  'bots.personal.pause': { capability: 'write', mutating: true },
  'bots.personal.resume': { capability: 'write', mutating: true },
  'bots.create': { capability: 'write', mutating: true }
} as const satisfies Record<string, { capability: NodeCapability; mutating: boolean }>
export type RemoteBotMethod = keyof typeof REMOTE_BOT_METHODS

/** What the phone's methods use of the profile's bots (`BotChatService`). */
export interface RemoteBotsPort {
  get(botId: string): BotDetail
  chatList(botId: string, page?: { beforeSeq?: number; limit?: number }): BotsPersonalV2Api['bots.chat.list']['result']
  chatSend(input: { botId: string; text: string; clientRequestId: string; replyTo?: string }): Promise<{ message: BotChatMessage }>
  chatStop(botId: string): Promise<Record<string, never>>
  workStop(botId: string, workId: string): Promise<{ stopped: boolean }>
  markRead(botId: string, seq: number): Record<string, never>
  askKind(botId: string, askId: string): 'permission' | 'export_memory'
  answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<{ message: BotChatMessage }>
  pause(botId: string): { bot: BotSummary }
  resume(botId: string): Promise<{ bot: BotSummary }>
  create(input: { look: BotLook; name?: string; description: string; clientRequestId: string }): Promise<{ bot: BotSummary }>
}

const KEYS: Record<RemoteBotMethod, { required: readonly string[]; optional?: readonly string[] }> = {
  'bots.get': { required: ['botId'] },
  'bots.chat.list': { required: ['botId'], optional: ['beforeSeq', 'limit'] },
  // No `attachments`: they name files on this computer, which a phone has none of.
  'bots.chat.send': { required: ['botId', 'text', 'clientRequestId'], optional: ['replyTo'] },
  'bots.chat.stop': { required: ['botId'] },
  'bots.work.stop': { required: ['botId', 'workId'] },
  'bots.chat.markRead': { required: ['botId', 'seq'] },
  'bots.asks.answer': { required: ['botId', 'askId', 'answer'] },
  'bots.personal.pause': { required: ['botId'] },
  'bots.personal.resume': { required: ['botId'] },
  'bots.create': { required: ['look', 'description', 'clientRequestId'], optional: ['name'] }
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/
const ASK_ID = /^esc_[0-9a-f-]{36}$/
const WORK_ID = /^act_[0-9a-f-]{36}$/
const LOOK_KEYS = new Set(['colour', 'accessory', 'kind', 'eyes'])
/**
 * A phone's message, in bytes. The desktop's limit is 64K characters; a phone's is smaller so the message the
 * send returns stays within one RPC reply.
 */
export const REMOTE_BOT_MESSAGE_BYTES = 32 * 1024
/** A read's result stays below one RPC reply (63 KiB); older messages are left for the next page. */
const RESULT_BYTES = 56 * 1024

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
    default:
      break
  }
  return p
}

/** A bot error as a phone sees it: no instance id (its Sign in opens on the computer). */
export function remoteBotError(error: BotError): BotError {
  return {
    text: error.text,
    ...(error.action ? { action: { kind: error.action.kind, label: error.action.label } } : {})
  }
}

/** A bot as a phone sees it. */
export function remoteBotSummary(bot: BotSummary): BotSummary {
  const { error, ...rest } = bot
  return { ...rest, ...(error ? { error: remoteBotError(error) } : {}) }
}

/** A chat row as a phone sees it: an attachment's name without its path on this computer, an error without an instance id. */
export function remoteBotMessage(message: BotChatMessage): BotChatMessage {
  const { attachments, error, ...rest } = message
  return {
    ...rest,
    ...(error ? { error: remoteBotError(error) } : {}),
    // `path` is part of the shape the desktop reads; a phone gets it empty.
    ...(attachments ? { attachments: attachments.map((file) => ({ name: file.name }) as { name: string; path: string }) } : {})
  }
}

const bytes = (value: unknown): number => Buffer.byteLength(canonicalJson(value))

/** One message within a reply: a very long text is cut, with a note that the rest is on the computer. */
function fitted(message: BotChatMessage, budget = RESULT_BYTES): BotChatMessage {
  if (bytes(message) <= budget) return message
  const over = bytes(message) - budget
  const keep = Math.max(0, Buffer.byteLength(message.text) - over - 256)
  let cut = Buffer.from(message.text).subarray(0, keep).toString()
  // A cut through a character leaves a replacement character at the end.
  cut = cut.replace(/�+$/, '')
  return { ...message, text: `${cut}\n\n… (the rest is on the computer)` }
}

/** A page within one reply: the newest messages that fit; the phone asks for the older ones with `beforeSeq`. */
function fittedPage(page: BotsPersonalV2Api['bots.chat.list']['result']): BotsPersonalV2Api['bots.chat.list']['result'] {
  const messages = page.messages.map(remoteBotMessage)
  const result = { ...page, messages }
  if (bytes(result) <= RESULT_BYTES) return result
  const kept: BotChatMessage[] = []
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

/** An engine refusal as the plain error a phone sees; it never becomes an uncertain outcome. */
function refusal(error: unknown): never {
  if (error instanceof NetError) throw error
  const code = (error as { code?: unknown } | undefined)?.code
  // Only the engine's own refusals (which carry a code and plain words) are passed on.
  if (typeof code !== 'string') throw error
  const message = error instanceof Error ? error.message : undefined
  if (code === 'bot_not_found') throw new NetError('stream_unknown', 'This bot is gone.')
  throw new NetError(code === 'invalid_params' ? 'bad_request' : 'conflict', message)
}

function refusing<T>(check: () => T): T {
  try {
    return check()
  } catch (error) {
    refusal(error)
  }
}

export function remoteBotMethods(options: {
  /** The profile's bots; undefined when its `bots.db` could not be opened. */
  bots(): RemoteBotsPort | undefined
}): RpcMethod[] {
  const bots = (): RemoteBotsPort => {
    const port = options.bots()
    if (!port) throw new NetError('conflict', 'Bots are unavailable on this computer.')
    return port
  }
  /** A bot the call names must be there; checked before the call is admitted, so a refusal is plain. */
  const known = (params: unknown): void => {
    const botId = (params as { botId?: unknown }).botId
    if (typeof botId === 'string') refusing(() => bots().get(botId))
    else bots()
  }
  const method = (
    name: RemoteBotMethod,
    handle: (p: Record<string, unknown>, port: RemoteBotsPort) => Promise<unknown>,
    extra: Partial<RpcMethod> = {}
  ): RpcMethod => ({
    method: name,
    family: 'bridge',
    ...REMOTE_BOT_METHODS[name],
    // A read's result is the chat itself: it is never kept in the request ledger on disk.
    ...(REMOTE_BOT_METHODS[name].mutating ? {} : { ephemeral: true }),
    validate: (value) => validateRemoteBotParams(name, value),
    authorize: (value) => known(value),
    ...extra,
    handle: async (value) => {
      const p = value as Record<string, unknown>
      const port = bots()
      // A read refuses plainly whatever happens; a change refused after it started is reported as it is.
      if (!REMOTE_BOT_METHODS[name].mutating) {
        try {
          return await handle(p, port)
        } catch (error) {
          refusal(error)
        }
      }
      return handle(p, port)
    }
  })
  const botId = (p: Record<string, unknown>): string => p.botId as string
  return [
    method('bots.get', async (p, port) => {
      const detail = port.get(botId(p))
      return { ...detail, summary: remoteBotSummary(detail.summary) }
    }),
    method('bots.chat.list', async (p, port) =>
      fittedPage(
        port.chatList(botId(p), {
          ...(p.beforeSeq !== undefined ? { beforeSeq: p.beforeSeq as number } : {}),
          ...(p.limit !== undefined ? { limit: p.limit as number } : {})
        })
      )
    ),
    method('bots.chat.send', async (p, port) => {
      // A retry with the same `clientRequestId` returns the first message and adds no second one.
      const { message } = await port.chatSend({
        botId: botId(p),
        text: p.text as string,
        clientRequestId: p.clientRequestId as string,
        ...(typeof p.replyTo === 'string' ? { replyTo: p.replyTo } : {})
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
      {
        // Checked for a new answer only: a retry of an answer that went through gets its saved result.
        authorizeNew: (value) => {
          const p = value as Record<string, unknown>
          const kind = refusing(() => bots().askKind(botId(p), p.askId as string))
          if (kind === 'export_memory') throw new NetError('forbidden', 'Answer this on the computer.')
        }
      }
    ),
    method('bots.personal.pause', async (p, port) => {
      const { bot } = port.pause(botId(p))
      return { bot: remoteBotSummary(bot) }
    }),
    method('bots.personal.resume', async (p, port) => {
      const { bot } = await port.resume(botId(p))
      return { bot: remoteBotSummary(bot) }
    }),
    method('bots.create', async (p, port) => {
      const { bot } = await port.create({
        look: p.look as BotLook,
        ...(typeof p.name === 'string' && p.name.trim() ? { name: p.name } : {}),
        description: p.description as string,
        clientRequestId: p.clientRequestId as string
      })
      return { bot: remoteBotSummary(bot) }
    })
  ]
}
