/**
 * Bot Phase 1 §5.3.1: a bot is made from a look and one sentence. Without a name it names itself
 * on its own model (or from the description after a failure or 5 seconds); its starter grant is
 * approved by pressing Create; its first chat activation runs at once on the home thread and
 * leaves its first message. With no runtime it is stuck with one plain action.
 */
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { botManifestDigest } from '../../src/mms/bots/grants/compile'
import { cleanBotName, fallbackBotName, firstMessagePrompt } from '../../src/mms/bots/chat/BotChatService'
import { starterManifest } from '../../src/mms/bots/chat/projection'
import { botFixture, chatOf, createBot, flush, runDispatch, type BotFixture } from './botFixture'

let f: BotFixture

beforeEach(() => {
  f = botFixture()
})

afterEach(() => f.close())

describe('bots.create', () => {
  it('without a name, the bot names itself, and its first chat activation leaves a bot text row', async () => {
    const { bot } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, description: 'Check my inbox every morning and tell me what matters.', clientRequestId: 'c1' })
    expect(bot).toMatchObject({ name: 'Inbox Helper', description: 'Check my inbox every morning and tell me what matters.', look: { colour: 'teal', accessory: 'cap' }, state: 'working', stateText: 'Working…' })
    expect(f.oneShot.prompts[0]).toContain('Two or three words naming a helper that does: Check my inbox')
    const definition = f.host.definitions.get(bot.id)!.published!
    expect(definition).toMatchObject({ format: 2, role: 'Check my inbox every morning and tell me what matters.', main: { model: { mode: 'auto', depth: 'normal' } }, triggers: { manual: true } })
    // Pressing Create bot approved the starter grant: its files folder, its tools and 15 minutes.
    expect(f.store.activeGrant(bot.id)).toMatchObject({ digest: botManifestDigest(starterManifest()), manifest: { workspace: null, budget: { maxActiveMs: 15 * 60_000 } } })
    expect(existsSync(f.bots.filesFolder(bot.id))).toBe(true)
    const [first] = f.store.laneActivations(bot.id, 'chat', ['running'])
    expect(first).toMatchObject({ lane: 'chat', threadId: `thread:bot:${bot.id}`, trigger: { input: firstMessagePrompt('Check my inbox every morning and tell me what matters.') } })
    await runDispatch(f, first!.id, 1, { text: 'I\'ll read your inbox each morning. May I read your mail?' })
    expect(chatOf(f, bot.id)).toMatchObject([{ author: 'bot', kind: 'text', text: 'I\'ll read your inbox each morning. May I read your mail?', activationId: first!.id }])
    expect(f.bots.service.list().bots).toMatchObject([{ id: bot.id, state: 'idle', lastOutcome: 'ok', unread: 1 }])
  })

  it('a given name is kept, and a repeat of the request returns the same bot', async () => {
    const input = { look: { colour: 'blue', accessory: 'crown' }, name: 'Penny', description: 'Track my spending.', clientRequestId: 'same' }
    const first = await f.bots.service.create(input)
    const again = await f.bots.service.create(input)
    expect(first.bot).toMatchObject({ name: 'Penny', look: { colour: 'blue', accessory: 'crown' } })
    expect(again.bot.id).toBe(first.bot.id)
    expect(f.oneShot.prompts).toEqual([])
    expect(f.bots.service.list().bots).toHaveLength(1)
  })

  it('naming falls back to the description\'s first meaningful words on a failure or after 5 seconds', async () => {
    f.oneShot.fail = true
    const failed = await createBot(f, { description: 'Please summarise the AI news for me every day' })
    expect(f.bots.definitionOf(failed.botId).name).toBe('Summarise Ai News')
    // That name is a stand-in: the bot's first turn picks its own.
    expect(f.store.activation(failed.firstActivation)?.trigger).toMatchObject({ input: firstMessagePrompt('Please summarise the AI news for me every day', true) })
    expect(firstMessagePrompt('x', true)).toContain('set it with set_profile')
    expect(firstMessagePrompt('x')).not.toContain('set_profile')
    f.oneShot.fail = false
    f.oneShot.answer = '"Inbox Helper, the best one here"'
    const long = await createBot(f, { description: 'watch prices of flights to Lisbon' })
    // A rambling answer is not a name.
    expect(f.bots.definitionOf(long.botId).name).toBe('Watch Prices Flights')
  })

  it('adds no provider entry of its own: the bot runs on the owner\'s entries', async () => {
    const host = f.host as Record<string, unknown>
    expect(host.botRunner).toBeUndefined()
    const { bot } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Penny', description: 'Track my spending.', clientRequestId: 'r2' })
    expect(bot.name).toBe('Penny')
  })

  it('an unknown look reads as the default', async () => {
    const { bot } = await f.bots.service.create({ look: { colour: 'ultraviolet', accessory: 'jetpack' }, name: 'X', description: 'Do things.', clientRequestId: 'c1' })
    expect(bot.look).toEqual({ colour: 'coral', accessory: 'none' })
  })

  it('with no runtime, the first activation fails before dispatch, and the bot is stuck with one action', async () => {
    f.problem = { problem: 'no_provider' }
    const { botId, firstActivation } = await createBot(f)
    await flush()
    expect(f.store.dispatch(firstActivation, 1)?.runId ?? null).toBeNull()
    expect(f.store.activation(firstActivation)).toMatchObject({ status: 'failed', endReason: 'bot_no_provider' })
    expect(chatOf(f, botId)).toMatchObject([{ author: 'bot', kind: 'error', error: { text: 'Set up a provider so I can work.', action: { kind: 'open_providers' } } }])
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'stuck', stateText: 'Needs you: Set up a provider so I can work.', error: { action: { kind: 'open_providers' } } })
    // The bot runner entry is not signed in: its Sign in opens that entry.
    f.problem = { problem: 'no_provider', instanceId: 'claude:bots' }
    await f.bots.service.chatSend({ botId, text: 'hello?', clientRequestId: 'm1' })
    await flush()
    expect(f.bots.service.get(botId).summary.error).toEqual({ text: 'Sign in so I can work.', action: { kind: 'sign_in', label: 'Sign in', instanceId: 'claude:bots' } })
    // Once a provider is there, the next chat that ends done clears the error.
    f.problem = undefined
    await f.bots.service.chatSend({ botId, text: 'try again', clientRequestId: 'm2' })
    const [next] = f.store.laneActivations(botId, 'chat', ['running'])
    await runDispatch(f, next!.id, 1, { text: 'Here now.' })
    expect(f.bots.service.get(botId).summary).toMatchObject({ state: 'idle' })
    expect(f.bots.service.get(botId).summary.error).toBeUndefined()
  })
})

describe('naming helpers', () => {
  it('cleans a model\'s answer to a short title-case name, or refuses it', () => {
    expect(cleanBotName('  "inbox helper."\nmore')).toBe('Inbox Helper')
    expect(cleanBotName('Name: news digest')).toBe('News Digest')
    expect(cleanBotName('one two three four five')).toBeUndefined()
    expect(fallbackBotName('Every morning at 8, give me three AI headlines')).toBe('Morning 8 Give')
    expect(fallbackBotName('the a an')).toBe('New Bot')
    expect(fallbackBotName('Keep the notes in my Notes folder tidy')).toBe('Keep Notes Folder')
  })
})
