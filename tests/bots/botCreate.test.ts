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
import type { BotModelOption } from '../../src/shared/bots/personal/methods'
import { slotsAllOn } from '../../src/shared/bots/personal/modelSlots'
import type { LlmProviderOption } from '../../src/shared/settings'
import { botFixture, chatOf, createBot, flush, runDispatch, type BotFixture } from './botFixture'

let f: BotFixture

/** Opus on a Claude subscription, and the same model through a paid API key. */
const OPUS_SUB: BotModelOption = { instanceId: 'claude', entry: 'Claude Code', model: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], credential: 'subscription', account: 'acct-1' }
const OPUS_KEY: BotModelOption = { instanceId: 'pi:key', entry: 'Anthropic API', model: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], credential: 'api_key' }
/** The app's listing of both entries, as the model picker takes it. */
const CLAUDE_LISTING: LlmProviderOption = { id: 'claude', instanceId: 'claude', label: 'Claude Code', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }, { id: 'haiku', label: 'Haiku' }] }
const KEY_LISTING: LlmProviderOption = { id: 'pi', instanceId: 'pi:key', label: 'Anthropic API', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'max'] }] }
const TALK = { instanceId: 'claude', model: 'opus' }
const WORK = { instanceId: 'pi:key', model: 'opus', effort: 'high' }
const ROWS = { talk: TALK, light: WORK, medium: WORK, hard: WORK } as { talk: typeof TALK | null; light: typeof WORK | null; medium: typeof WORK | null; hard: typeof WORK | null }

/** The service's choices, which a test sets as the daemon would. */
const serviceOptions = () => (f.bots.service as unknown as { options: { modelOptions?: () => Promise<BotModelOption[]>; modelListing?: () => Promise<LlmProviderOption[]> } }).options

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
    expect(f.store.activeGrant(bot.id)).toMatchObject({ digest: botManifestDigest(starterManifest()), manifest: { workspace: null, budget: { maxActiveMs: 60 * 60_000 } } })
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

  it('New bot\'s choices are each entry\'s models for the app\'s picker, without Off, and the owner\'s last picks still offered (#673)', async () => {
    const options = serviceOptions()
    options.modelOptions = async () => [OPUS_SUB, OPUS_KEY]
    options.modelListing = async () => [CLAUDE_LISTING, KEY_LISTING]
    const choices = await f.bots.service.modelChoices()
    // Only the models that can hold a bot, with the levels it may pick; the listing's other models and "Off" are gone.
    expect(choices.providers).toEqual([
      { ...CLAUDE_LISTING, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', thinkingOff: false }] },
      { ...KEY_LISTING, models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high'], thinkingOff: false }] }
    ])
    expect(choices).toMatchObject({ models: [{ model: 'opus', label: 'Claude Code · Opus' }], computer: 'this_computer', computers: [{ id: 'this_computer' }] })
    // The first bot starts empty: no last picks.
    expect(choices.last).toBeUndefined()
    await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Rows', description: 'Track my spending.', clientRequestId: 'rows', slots: ROWS })
    expect((await f.bots.service.modelChoices()).last).toEqual({ talk: TALK, light: WORK, medium: WORK, hard: WORK })
    // A remembered pick no longer offered starts empty.
    options.modelOptions = async () => [OPUS_SUB]
    expect((await f.bots.service.modelChoices()).last).toEqual({ talk: TALK, light: null, medium: null, hard: null })
  })

  it('Create bot takes a pick on every row, saved with its entry\'s sign-in; one not offered is refused, never swapped (#673)', async () => {
    const options = serviceOptions()
    options.modelOptions = async () => [OPUS_SUB, OPUS_KEY]
    const { bot } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Rows', description: 'Track my spending.', clientRequestId: 'rows', slots: ROWS })
    // The daemon stamps each pick with the entry's sign-in now; a client never sends it.
    const talk = { ...TALK, credential: 'subscription', account: 'acct-1' }
    const work = { ...WORK, credential: 'api_key' }
    expect(f.bots.ownerSlots(bot.id)).toEqual({ talk, light: work, medium: work, hard: work })
    // Older builds run every turn on the mirror: Talk's model, marked so their own later writes drop the rows.
    expect(f.bots.definitionOf(bot.id).main.model).toEqual({ mode: 'named', model: 'opus ', depth: 'normal' })
    const [first] = f.store.laneActivations(bot.id, 'chat', ['running'])
    await runDispatch(f, first!.id, 1, { text: 'Hello.' })
    expect(f.resolved.at(-1)).toEqual({ pick: talk, depth: 'normal' })
    // Without a name the bot names itself on its Talk pick.
    f.resolved.length = 0
    await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, description: 'Track my spending.', clientRequestId: 'named', slots: ROWS })
    expect(f.resolved[0]).toEqual({ pick: talk, depth: 'quick' })
    const refused = (clientRequestId: string, slots: typeof ROWS) => f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Gone', description: 'Track my spending.', clientRequestId, slots })
    // Gone between opening New bot and Create bot, or at a level the model doesn't offer: no bot, in plain words.
    await expect(refused('gone1', { ...ROWS, hard: { instanceId: 'pi:other', model: 'opus' } })).rejects.toMatchObject({ code: 'model_unavailable', message: 'The model you picked is not available now. Pick another one.' })
    await expect(refused('gone2', { ...ROWS, talk: { ...TALK, effort: 'max' } })).rejects.toMatchObject({ code: 'model_unavailable' })
    // Every row needs a pick: Mousse never chooses for a new bot.
    await expect(refused('gone3', { ...ROWS, light: null })).rejects.toMatchObject({ code: 'invalid_params', message: 'Pick a model for Talk and for Work.' })
    options.modelOptions = async () => { throw new Error('providers unreadable') }
    await expect(refused('gone4', ROWS)).rejects.toMatchObject({ code: 'model_unavailable' })
    expect(f.bots.service.list().bots.map((entry) => entry.name)).not.toContain('Gone')
  })

  it('an app from before rows sends one model by name, put on every row on an entry; one from before picks sends none, by usage (#673)', async () => {
    const options = serviceOptions()
    options.modelOptions = async () => [OPUS_KEY, OPUS_SUB]
    const { bot } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Name', description: 'Track my spending.', clientRequestId: 'name', model: 'opus' })
    // Two entries offer it: the subscription, as `use_model` ranks.
    expect(f.bots.ownerSlots(bot.id)).toEqual(slotsAllOn({ ...TALK, credential: 'subscription', account: 'acct-1' }))
    await expect(f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Gone', description: 'Track my spending.', clientRequestId: 'gone', model: 'sonnet' })).rejects.toMatchObject({ code: 'model_unavailable' })
    const { bot: byUsage } = await f.bots.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Auto', description: 'Track my spending.', clientRequestId: 'auto' })
    expect(f.bots.definitionOf(byUsage.id).main).toMatchObject({ model: { mode: 'auto', depth: 'normal' } })
    expect(f.bots.definitionOf(byUsage.id).main.slots).toBeUndefined()
  })

  it('Runs on names this computer by the name it is given, and "This computer" without one', async () => {
    const options = (f.bots.service as unknown as { options: { computerName?: () => string } }).options
    options.computerName = () => 'Ada’s Mac mini'
    expect((await f.bots.service.modelChoices()).computers[0]).toEqual({ id: 'this_computer', name: 'Ada’s Mac mini' })
    options.computerName = () => ''
    expect((await f.bots.service.modelChoices()).computers[0]).toEqual({ id: 'this_computer', name: 'This computer' })
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
