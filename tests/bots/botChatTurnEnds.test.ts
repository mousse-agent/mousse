/**
 * A chat turn that fails, is interrupted or is stopped by the owner leaves one short Mousse line in the bot's journal,
 * and the bot's next chat turn reads it in its recent chat, so it can tell the owner what went wrong. The engine runs as
 * in the other bot tests; its journal rows go to a real memory store on the same `bots.db`, and the next turn's pack is
 * built from it as the profile's services build it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotContextProvider } from '../../src/mms/bots/memory/contextPack'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { botFixture, chatOf, createBot, finish, flush, runDispatch, start, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
let memory: BotMemoryStore

beforeEach(async () => {
  f = botFixture()
  memory = new BotMemoryStore({ db: f.store.db, clock: () => f.clock.now, timeZone: () => 'UTC' })
  // Every journal row the engine and the chat write reaches the real store, in their transaction.
  f.host.journal!.appendInTx = (tx, row) => { memory.appendInTx(tx, row) }
  ;({ botId } = await createBot(f, { name: 'Inbox Helper', reply: 'Hello, I read your inbox.' }))
})

afterEach(() => f.close())

const chatActivation = () => f.store.laneActivations(botId, 'chat', ['running'])[0]!

async function send(text: string, clientRequestId: string): Promise<string> {
  await f.bots.service.chatSend({ botId, text, clientRequestId })
  await flush()
  return chatActivation().id
}

/** The Mousse lines the bot's chat turns left, as the journal keeps them. */
const turnEnds = () => memory.journal(botId).filter((row) => row.sourceKey.startsWith('turn:'))

/** The recent chat of the bot's next chat turn. */
const nextPack = () => createBotContextProvider({ store: memory, journal: { syncThread: async () => {} } }).chatPreamble({ botId, activationId: 'act-next' })

describe('a chat turn that ends without its reply', () => {
  it('a failed turn leaves one line with its error on one line, capped; the next turn reads it in recent chat', async () => {
    const activation = await send('What came in today?', 'm1')
    const error = `[provider_error] 529 Overloaded\n  at request (api.js:12)\n${'x'.repeat(600)}`
    const { payload } = await start(f, activation)
    await finish(f, payload, 'failed', { outcome: { error } })
    // The same end settled again adds nothing.
    f.bots.settle(payload, {})
    await flush()

    const rows = turnEnds()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'notice', who: 'mousse', lane: 'chat', activationId: activation, sourceKey: `turn:${activation}:failed` })
    expect(rows[0]!.text).toMatch(/^Your turn failed before it finished: \[provider_error\] 529 Overloaded at request \(api\.js:12\) x+…$/)
    expect(rows[0]!.text).not.toContain('\n')
    expect(rows[0]!.text.length).toBeLessThan(260)
    // The owner's chat is as before: its own plain error line, never the provider's words.
    expect(chatOf(f, botId).at(-1)).toMatchObject({ kind: 'error', error: { text: 'Something went wrong, so I stopped. Try again.' } })

    const pack = await nextPack()
    expect(pack).toMatch(/\] Owner: What came in today\?\n\[j\d+ · [^\]]+\] Mousse: Your turn failed before it finished: \[provider_error\] 529 Overloaded/)
  })

  it('an interrupted turn leaves one line saying so', async () => {
    const activation = await send('Summarise my inbox', 'm1')
    await runDispatch(f, activation, 1, { status: 'interrupted' })

    expect(turnEnds().map((row) => [row.sourceKey, row.text])).toEqual([[`turn:${activation}:interrupted`, 'Your turn was interrupted before it finished.']])
    expect(await nextPack()).toContain('Mousse: Your turn was interrupted before it finished.')
  })

  it("the owner's Stop leaves one line, not an error, even as the stopped run ends after it", async () => {
    const activation = await send('Read every email from 2019', 'm1')
    const { payload } = await start(f, activation)
    await f.bots.service.chatStop(botId)
    await finish(f, payload, 'interrupted', { outcome: { interruptedBy: 'user' } })

    expect(turnEnds().map((row) => [row.sourceKey, row.text])).toEqual([[`turn:${activation}:stopped`, 'The owner stopped your turn before it finished.']])
    expect(await nextPack()).toContain('Mousse: The owner stopped your turn before it finished.')
  })

  it('a turn that ends with its reply leaves no line', async () => {
    const activation = await send('Thanks', 'm1')
    await runDispatch(f, activation, 1, { text: 'Any time.' })
    expect(turnEnds()).toEqual([])
  })
})
