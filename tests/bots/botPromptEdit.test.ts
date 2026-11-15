/**
 * The owner edits a bot's prompt in About (`bots.update` with a description, through the registered method): the next
 * turn works under the new words, also a turn of an activation that started before the edit; a turn already running
 * keeps the words it was given; the last of two quick edits wins; Reset to default (`description: null`) puts back the
 * words from before the first edit; and the bot's own `set_profile` can no longer change them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOT_OWNER_PROMPT_TEXT } from '../../src/mms/bots/activation/BotEngine'
import { BOT_PROMPT_CHANGED_NOTE, botInstructions } from '../../src/mms/bots/instructions'
import { registerPersonalBotMethods } from '../../src/mms/bots/registerMethods'
import { DomainHandlerRegistry } from '../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../src/mms/protocol/handlers'
import type { BotSummary } from '../../src/shared/bots/personal/chat'
import { botFixture, createBot, finish, start, type BotFixture } from './botFixture'

const context = { connection: { id: 'c', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>() } } as unknown as HandlerContext
const MADE_WITH = 'Look things up for me.'

let f: BotFixture
let domains: DomainHandlerRegistry
let botId: string

beforeEach(async () => {
  f = botFixture()
  // The real system text, as the profile builds it.
  f.host.instructions = (bot) => botInstructions(bot)
  domains = new DomainHandlerRegistry()
  registerPersonalBotMethods(domains, () => f.bots.service)
  await f.bots.reconcileOnStartup()
  botId = (await createBot(f, { name: 'Pip', description: MADE_WITH, reply: 'Hello! What should I look up?' })).botId
})

afterEach(() => f.close())

/** The owner edits the prompt in About, or resets it (null), as the app sends it. */
const edit = (description: string | null) => domains.dispatch(context, 'bots.update', { botId, description }) as Promise<{ bot: BotSummary }>

/** The owner writes; the chat turn that answers it starts. */
async function chat(text: string, id: string) {
  f.clock.now += 60_000
  await f.bots.service.chatSend({ botId, text, clientRequestId: id })
  const activation = f.store.laneActivations(botId, 'chat', ['running'])[0]!
  return { activation, ...(await start(f, activation.id)) }
}

/** The owner's words a turn works under: its system text's `<owner_words>` block. */
function words(instructions: string | undefined): string {
  const text = instructions ?? ''
  const open = text.indexOf('<owner_words>\n')
  return text.slice(open + '<owner_words>\n'.length, text.indexOf('\n</owner_words>', open))
}

describe("the owner's prompt edit", () => {
  it('reaches the next turn, says older replies followed older words, and Reset puts the first words back', async () => {
    const before = await chat('Hi', 'm1')
    expect(words(before.prepared.instructions)).toBe(MADE_WITH)
    expect(before.prepared.instructions).not.toContain(BOT_PROMPT_CHANGED_NOTE)
    await finish(f, before.payload, 'completed', { text: 'Hi! Ask me anything.' })

    const edited = 'Answer in one line. Say "ok" first.\nNo lists.'
    const { bot } = await edit(edited)
    expect(bot).toMatchObject({ description: edited, promptEdited: true })

    const after = await chat('What is the tallest mountain?', 'm2')
    expect(words(after.prepared.instructions)).toBe(edited)
    // The old words are gone from the system text, not added beside the new ones as a role.
    expect(after.prepared.instructions).not.toContain(MADE_WITH)
    // Its replies from before the edit are still in its recent chat: it is told not to copy them.
    expect(after.prepared.instructions).toContain(BOT_PROMPT_CHANGED_NOTE)
    await finish(f, after.payload, 'completed', { text: 'ok, Everest.' })

    const reset = await edit(null)
    expect(reset.bot.description).toBe(MADE_WITH)
    expect(reset.bot.promptEdited).toBeUndefined()
    const back = await chat('And the deepest lake?', 'm3')
    expect(words(back.prepared.instructions)).toBe(MADE_WITH)
    expect(back.prepared.instructions).not.toContain(edited)
  })

  it('made while a turn runs: that turn keeps its words, and the next turn of the same activation gets the new ones', async () => {
    const running = await chat('Find me a good vacuum', 'm1')
    const pinned = f.store.activation(running.activation.id)!.revision
    expect(words(running.prepared.instructions)).toBe(MADE_WITH)

    await edit('Keep every reply to one line.')
    // What the running turn was given does not change under it.
    expect(words(running.prepared.instructions)).toBe(MADE_WITH)

    // The owner writes again while it works: the message joins this turn, and goes on as its next dispatch.
    await f.bots.service.chatSend({ botId, text: 'Under 200 dollars, please.', clientRequestId: 'm2' })
    await finish(f, running.payload, 'completed', { text: 'Looking now.' })
    const next = f.store.lastMainDispatch(running.activation.id)!
    expect(next.n).toBe(2)
    // The activation still points at the revision from before the edit; the words are read as the turn is prepared.
    expect(f.store.activation(running.activation.id)!.revision).toBe(pinned)
    const continued = await start(f, running.activation.id, next.n)
    expect(words(continued.prepared.instructions)).toBe('Keep every reply to one line.')
  })

  it('two quick edits in a row: the last one wins, and Reset still goes back to the words it was made with', async () => {
    await Promise.all([edit('First try.'), edit('Second try, the one I meant.')])
    expect(f.bots.service.get(botId).summary.description).toBe('Second try, the one I meant.')
    const turn = await chat('Hi', 'm1')
    expect(words(turn.prepared.instructions)).toBe('Second try, the one I meant.')
    expect(turn.prepared.instructions).not.toContain('First try.')
    await finish(f, turn.payload, 'completed', { text: 'Hi.' })
    expect((await edit(null)).bot.description).toBe(MADE_WITH)
  })

  it("can't be changed by the bot's set_profile, which can still rename it", async () => {
    // Before the owner edits it, the bot may change its description when asked.
    f.bots.tools.setProfile(botId, { description: 'Looks things up.' })
    expect(f.bots.service.get(botId).summary.description).toBe('Looks things up.')

    await edit('Only answer questions about trains.')
    expect(() => f.bots.tools.setProfile(botId, { description: 'Answers anything.' })).toThrow(BOT_OWNER_PROMPT_TEXT)
    f.bots.tools.setProfile(botId, { name: 'Pippa' })
    expect(f.bots.service.get(botId).summary).toMatchObject({ name: 'Pippa', description: 'Only answer questions about trains.' })
  })
})
