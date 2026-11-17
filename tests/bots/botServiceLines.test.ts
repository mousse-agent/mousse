import { afterEach, expect, it } from 'vitest'
import { BotChatProjection } from '../../src/mms/bots/chat/projection'
import { BotMemoryStore } from '../../src/mms/bots/memory/BotMemoryStore'
import { createBotJournal } from '../../src/mms/bots/memory/capture'
import { createBotContextProvider } from '../../src/mms/bots/memory/contextPack'
import { botFixture } from './botFixture'
const f = botFixture()
afterEach(() => f.close())
it('later chat attributes quiet service lines to Mousse without changing delivery', async () => {
  const memory = new BotMemoryStore({ db: f.store.db })
  const journal = createBotJournal({ store: memory, readThread: () => ({ messages: [] }), listThreads: () => [] })
  const chat = new BotChatProjection({ store: f.store, journal, emit: () => {} })
  const lines = [['bm_schedule_done_1', 'Stopped ‘Inbox’.'], ['bm_wake_1', 'Following up'], ['bm_permission_1', 'You let Pip use the browser'], ['bm_schedule_ended_1', '‘Inbox’ ended, as planned.']]
  for (const [id, text] of lines) {
    const row = chat.post({ id, botId: 'ada', author: 'bot', kind: 'notice', text })
    expect(row).toMatchObject({ text, systemLine: true })
    expect(f.store.message(id!)?.tell).toBeNull()
  }
  expect(memory.journal('ada').map(row => row.who)).toEqual(lines.map(() => 'mousse'))
  const pack = await createBotContextProvider({ store: memory, journal: { syncThread: async () => {} } }).chatPreamble({ botId: 'ada', activationId: 'next' })
  expect(pack).toContain('Mousse')
})
