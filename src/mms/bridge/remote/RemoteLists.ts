import { NetError } from '../../../shared/net'
import type { ChatSummary, LocalChatConversation } from '../../../shared/chats'
import type { RpcMethod } from '../../net/contracts'
import { canonicalJson } from '../../net/sync/codec'

/** The phone's sidebar methods: open the live lists stream, and send to or stop an agent chat. */
export const REMOTE_LIST_METHODS = {
  'bridge.lists.open': { capability: 'read', mutating: false },
  'chats.send': { capability: 'chat', mutating: true },
  'chats.cancel': { capability: 'chat', mutating: true }
} as const

const MESSAGE_LIMIT = 64 * 1024

export interface RemoteChatsPort {
  snapshot(): { chats: ChatSummary[] }
  /** Throws why a new message cannot be sent now, without sending it. */
  assertSendable(chatId: string, text: string): void
  /** Throws unless `runId` is still the chat's current response. */
  assertCancellable(chatId: string, runId: string): void
  send(input: { chatId: string; text: string; clientMessageId?: string }): LocalChatConversation
  cancel(input: { chatId: string; runId: string }): LocalChatConversation
}

function exact(value: unknown, required: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Buffer.byteLength(canonicalJson(value)) > 128 * 1024
  )
    throw new NetError('bad_request')
  const params = value as Record<string, unknown>
  const keys = Object.keys(params)
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(params, key)))
    throw new NetError('bad_request')
  return params
}

function text(params: Record<string, unknown>, key: string, max: number): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max)
    throw new NetError('bad_request')
  return value
}

/** A local chat the phone may send to; Space conversations send through their Space instead. */
function localChat(chats: RemoteChatsPort, chatId: string): ChatSummary {
  const chat = chats.snapshot().chats.find((entry) => entry.id === chatId)
  if (!chat) throw new NetError('stream_unknown', 'Chat not found.')
  if (chat.presentation === 'network')
    throw new NetError(
      'forbidden',
      'This conversation sends through its Space. Open it on the computer.'
    )
  return chat
}

/** A chat service refusal as the plain error the phone sees; it never becomes an uncertain outcome. */
function refusal(error: unknown): never {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'chat_published')
    throw new NetError(
      'forbidden',
      'This conversation sends through its Space. Open it on the computer.'
    )
  const message = error instanceof Error ? error.message : undefined
  throw new NetError(code === 'invalid_params' ? 'bad_request' : 'conflict', message)
}

function refusing(check: () => void): void {
  try {
    check()
  } catch (error) {
    refusal(error)
  }
}

/** The state of a chat after a send or cancel; never the whole transcript. */
function result(conversation: LocalChatConversation): unknown {
  return {
    chatId: conversation.id,
    ...(conversation.run ? { run: { id: conversation.run.id, state: conversation.run.state } } : {})
  }
}

export function remoteListMethods(options: {
  openLists(): unknown
  chats(): RemoteChatsPort
}): RpcMethod[] {
  return [
    {
      method: 'bridge.lists.open',
      family: 'bridge',
      ...REMOTE_LIST_METHODS['bridge.lists.open'],
      validate: (value) => exact(value, []),
      handle: async () => options.openLists()
    },
    {
      method: 'chats.send',
      family: 'bridge',
      ...REMOTE_LIST_METHODS['chats.send'],
      validate: (value) => {
        const params = exact(value, ['chatId', 'text'])
        text(params, 'chatId', 256)
        text(params, 'text', MESSAGE_LIMIT)
        return params
      },
      // Refusals come back as plain errors, never as uncertain outcomes. The chat's current state
      // is checked only for a new execution, so a retry of a send that already went through still
      // gets its saved result while the reply it started is running.
      authorize: (value) => {
        localChat(options.chats(), (value as { chatId: string }).chatId)
      },
      authorizeNew: (value) => {
        const params = value as { chatId: string; text: string }
        refusing(() => options.chats().assertSendable(params.chatId, params.text))
      },
      handle: async (value, context) => {
        const params = value as { chatId: string; text: string }
        // A retried request keeps its ledger execution id, so a retry adds no second message.
        const clientMessageId = context.execution?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128)
        return result(
          options.chats().send({
            chatId: params.chatId,
            text: params.text,
            ...(clientMessageId ? { clientMessageId } : {})
          })
        )
      }
    },
    {
      method: 'chats.cancel',
      family: 'bridge',
      ...REMOTE_LIST_METHODS['chats.cancel'],
      validate: (value) => {
        const params = exact(value, ['chatId', 'runId'])
        text(params, 'chatId', 256)
        text(params, 'runId', 256)
        return params
      },
      authorize: (value) => {
        localChat(options.chats(), (value as { chatId: string }).chatId)
      },
      authorizeNew: (value) => {
        const params = value as { chatId: string; runId: string }
        refusing(() => options.chats().assertCancellable(params.chatId, params.runId))
      },
      handle: async (value) =>
        result(options.chats().cancel(value as { chatId: string; runId: string }))
    }
  ]
}
