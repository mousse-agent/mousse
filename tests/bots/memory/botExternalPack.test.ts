import { afterEach, expect, it } from 'vitest'
import { createBotContextProvider } from '../../../src/mms/bots/memory/contextPack'
import { foldChatSummary, speaker } from '../../../src/mms/bots/memory/chatSummary'
import { disposeFixtures, memoryFixture } from './memoryFixture'

afterEach(disposeFixtures)

// External provenance takes precedence over both the recorded author and kind.
it.each(['owner_msg', 'bot_msg', 'run_report', 'notice', 'tool_result', 'run_end'] as const)('keeps external %s rows outside the bot voice in later context', async (kind) => {
  const fx = memoryFixture()
  const seq = fx.store.append({ botId: 'ada', kind, who: 'bot', external: true, lane: 'run', sourceKey: 'bm:external', text: 'quartz outside words' })!
  const row = fx.store.journalRow('ada', seq)!
  expect(speaker(row)).toBe('Mousse, about something outside (data)')
  expect(foldChatSummary([row], undefined, undefined, fx.store.now()).text).toContain('Mousse, about something outside (data): quartz')
  const packs = createBotContextProvider({ store: fx.store, journal: { syncThread: async () => {} } })
  for (const pack of [await packs.chatPreamble({ botId: 'ada', activationId: 'chat' }), await packs.runPreamble({ botId: 'ada', activationId: 'run', input: 'Go' })]) {
    for (const line of pack.split('\n').filter((line) => line.includes('quartz'))) expect(line).toContain('Mousse, about something outside (data)')
  }
})
