/**
 * The owner's reaction on a bot's message (`bots.chat.react`), through the domain registry over a real engine and a
 * real `bots.db`: one per message, set, replaced and removed, kept across a reopen of `bots.db`, published to every
 * window, and never a turn of its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { BotStore } from '../../src/mms/bots/store/BotStore'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import type { BotChatMessage, BotSummary } from '../../src/shared/bots/personal/chat'
import { botFixture, runDispatch, type BotFixture } from './botFixture'

const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext

let f: BotFixture
let domains: DomainHandlerRegistry
let published: BotChatMessage[]

const call = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => domains.dispatch(context, method, params) as Promise<T>

beforeEach(() => {
  f = botFixture()
  domains = new DomainHandlerRegistry()
  registerPersonalBotMethods(domains, () => f.bots.service)
  published = []
  f.bots.events.on('message', (payload: unknown) => published.push((payload as { message: BotChatMessage }).message))
})
afterEach(() => f.close())

/** A bot with its first reply in the chat, and that reply. */
async function botWithReply(description = 'Read my invoices and sum them up.', request = 'c1'): Promise<{ botId: string; reply: BotChatMessage }> {
  const { bot } = await call<{ bot: BotSummary }>('bots.create', { look: { colour: 'teal', accessory: 'cap' }, description, clientRequestId: request })
  const [first] = f.store.laneActivations(bot.id, 'chat', ['running'])
  await runDispatch(f, first!.id, 1, { text: 'Hello, I sum up invoices.\nSend me one.' })
  const { messages } = await call<{ messages: BotChatMessage[] }>('bots.chat.list', { botId: bot.id })
  return { botId: bot.id, reply: messages.find((message) => message.author === 'bot')! }
}

/** The reaction on a message as a fresh open of the same `bots.db` reads it. */
function reopened(messageId: string): string | undefined {
  const store = new BotStore({ profileHome: f.profile, clock: () => f.clock.now })
  try {
    return store.message(messageId)?.ownerReaction?.emoji
  } finally {
    store.close()
  }
}

describe('bots.chat.react', () => {
  it('sets, replaces and removes the one reaction on a bot message, kept in bots.db and published, with no turn of its own', async () => {
    const { botId, reply } = await botWithReply()
    const activations = f.store.listActivations().length
    published = []

    const set = await call<{ message: BotChatMessage }>('bots.chat.react', { botId, messageId: reply.id, emoji: '❤️' })
    expect(set.message).toMatchObject({ id: reply.id, seq: reply.seq, reaction: '❤️' })
    expect(reopened(reply.id)).toBe('❤️')

    // Another emoji replaces it: still one.
    await call('bots.chat.react', { botId, messageId: reply.id, emoji: '👍' })
    const { messages } = await call<{ messages: BotChatMessage[] }>('bots.chat.list', { botId })
    expect(messages.find((message) => message.id === reply.id)?.reaction).toBe('👍')
    expect(reopened(reply.id)).toBe('👍')

    const removed = await call<{ message: BotChatMessage }>('bots.chat.react', { botId, messageId: reply.id, emoji: null })
    expect(removed.message).not.toHaveProperty('reaction')
    expect(reopened(reply.id)).toBeUndefined()

    // Every change reached every window as the row again; none started a turn.
    expect(published.map((message) => [message.id, message.reaction])).toEqual([[reply.id, '❤️'], [reply.id, '👍'], [reply.id, undefined]])
    expect(f.store.listActivations()).toHaveLength(activations)
  })

  it('takes a flag, a family and a skin tone as one emoji', async () => {
    const { botId, reply } = await botWithReply()
    for (const emoji of ['🇬🇧', '👨‍👩‍👧', '👍🏽', '1️⃣']) {
      await call('bots.chat.react', { botId, messageId: reply.id, emoji })
      expect(reopened(reply.id)).toBe(emoji)
    }
  })

  it('refuses the owner’s own message, a message of another bot or none, and anything but one emoji', async () => {
    const { botId, reply } = await botWithReply()
    const { botId: other, reply: otherReply } = await botWithReply('Watch my garden.', 'c2')
    const own = f.bots.chat.post({ botId, author: 'owner', kind: 'text', text: 'Thanks!' })
    await expect(call('bots.chat.react', { botId, messageId: own.id, emoji: '❤️' })).rejects.toMatchObject({ code: 'not_reactable' })
    await expect(call('bots.chat.react', { botId, messageId: otherReply.id, emoji: '❤️' })).rejects.toMatchObject({ code: 'message_not_found' })
    await expect(call('bots.chat.react', { botId, messageId: 'bm_nope', emoji: '❤️' })).rejects.toMatchObject({ code: 'message_not_found' })
    for (const emoji of ['', 'hi', '1', '#', '❤️ and more', 'a❤️', 42, undefined]) {
      await expect(call('bots.chat.react', { botId, messageId: reply.id, ...(emoji === undefined ? {} : { emoji }) }), String(emoji)).rejects.toMatchObject({ code: 'invalid_params' })
    }
    await expect(call('bots.chat.react', { botId, messageId: reply.id, emoji: '❤️', extra: 1 })).rejects.toMatchObject({ code: 'unknown_field' })
    expect(reopened(reply.id)).toBeUndefined()
    expect(reopened(otherReply.id)).toBeUndefined()
    expect(other).not.toBe(botId)
  })
})
