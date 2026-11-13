/**
 * The bot is told of the owner's reactions (contextPack.ts): its next chat turn's situation lists the reactions set
 * since its last one, one line each, and each only once; forgetting a message removes its reaction. A real `bots.db`
 * (every migration) with the memory store on it, wired as the profile's services wire them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BotChatProjection } from '../../../src/mms/bots/chat/projection'
import { BotMemoryStore } from '../../../src/mms/bots/memory/BotMemoryStore'
import { createBotJournal } from '../../../src/mms/bots/memory/capture'
import { BOT_PACK_REACTIONS, createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { BotStore } from '../../../src/mms/bots/store/BotStore'

const MINUTE = 60_000
let home: string
let clock: { now: number }
let store: BotStore
let memory: BotMemoryStore
let chat: BotChatProjection

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bot-reactions-'))
  clock = { now: Date.UTC(2026, 10, 13, 21, 0) }
  store = new BotStore({ profileHome: home, clock: () => clock.now })
  memory = new BotMemoryStore({ db: store.db, clock: () => clock.now, timeZone: () => 'Europe/London' })
  const journal = createBotJournal({ store: memory, readThread: () => ({ messages: [] }), listThreads: () => [] })
  chat = new BotChatProjection({ store, journal, emit: () => {} })
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

/** The chat pack's provider, its reactions read as the profile's services read them. */
const packs = () => createBotContextProvider({
  store: memory,
  journal: { syncThread: async () => {} },
  reactions: (botId, since) => store.reactionsSince(botId, since, BOT_PACK_REACTIONS).map((row) => ({ emoji: row.ownerReaction!.emoji, at: row.ownerReaction!.at, text: row.text }))
})
const react = (messageId: string, emoji: string | null) => {
  clock.now += MINUTE
  store.setOwnerReaction(messageId, emoji, new Date(clock.now).toISOString())
}
const reactionLines = (pack: string) => pack.split('\n').filter((line) => line.startsWith('Owner reacted'))

describe('reactions in the chat pack', () => {
  it('lists the reactions since the last chat turn, one line each with the message’s first line, each only once', async () => {
    const provider = packs()
    chat.post({ botId: 'ada', author: 'owner', kind: 'text', text: 'Find me SSDs', activationId: 'act-1' })
    const ssds = chat.post({ botId: 'ada', author: 'bot', kind: 'text', text: 'Here are three SSDs.\nThe 990 Pro is the pick.', activationId: 'act-1' })
    const weather = chat.post({ botId: 'ada', author: 'bot', kind: 'run_report', text: 'Rain at 4.', activationId: 'act-run' })
    react(ssds.id, '❤️')
    react(weather.id, '👍')

    const first = await provider.chatPreamble({ botId: 'ada', activationId: 'act-2' })
    expect(reactionLines(first)).toEqual(['Owner reacted ❤️ to: Here are three SSDs.', 'Owner reacted 👍 to: Rain at 4.'])
    // In the situation block, with the present.
    expect(first.indexOf('Owner reacted')).toBeGreaterThan(first.indexOf('Situation:'))
    // The pack of one turn is frozen: built again for it, it says the same.
    expect(await provider.chatPreamble({ botId: 'ada', activationId: 'act-2' })).toBe(first)

    // The next turn: nothing new, so no line; told once.
    expect(reactionLines(await provider.chatPreamble({ botId: 'ada', activationId: 'act-3' }))).toEqual([])

    // A reaction replaced since: the new one, alone.
    react(ssds.id, '😂')
    expect(reactionLines(await provider.chatPreamble({ botId: 'ada', activationId: 'act-4' }))).toEqual(['Owner reacted 😂 to: Here are three SSDs.'])
    // A reaction removed is nothing to tell.
    react(weather.id, null)
    expect(reactionLines(await provider.chatPreamble({ botId: 'ada', activationId: 'act-5' }))).toEqual([])
  })

  it('forgetting a message removes its reaction, so the bot is never told of it', async () => {
    const provider = packs()
    const kept = chat.post({ botId: 'ada', author: 'bot', kind: 'text', text: 'Your 9am moved to 10.', activationId: 'act-1' })
    const forgotten = chat.post({ botId: 'ada', author: 'bot', kind: 'text', text: 'Your cat Biscuit is nine.', activationId: 'act-1' })
    react(kept.id, '👍')
    react(forgotten.id, '❤️')
    const row = memory.windowRows('ada', 0).find((entry) => entry.sourceKey === `bm:${forgotten.id}`)!
    memory.forget('ada', { refs: [`j${row.seq}`], by: 'chat' })
    expect(store.message(forgotten.id)?.ownerReaction).toBeUndefined()
    expect(store.message(kept.id)?.ownerReaction?.emoji).toBe('👍')
    const pack = await provider.chatPreamble({ botId: 'ada', activationId: 'act-2' })
    expect(reactionLines(pack)).toEqual(['Owner reacted 👍 to: Your 9am moved to 10.'])
    expect(pack).not.toContain('Biscuit')
  })

  it('a run is not told of reactions: they are the chat’s', async () => {
    const provider = packs()
    const reply = chat.post({ botId: 'ada', author: 'bot', kind: 'text', text: 'Done.', activationId: 'act-1' })
    react(reply.id, '🙏')
    const run = await provider.runPreamble({ botId: 'ada', activationId: 'run-1', input: 'Go' })
    expect(reactionLines(run)).toEqual([])
    expect(reactionLines(await provider.chatPreamble({ botId: 'ada', activationId: 'act-2' }))).toEqual(['Owner reacted 🙏 to: Done.'])
  })
})
