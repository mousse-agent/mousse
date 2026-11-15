import { afterEach, beforeEach, expect, it } from 'vitest'
import { botFixture, chatOf, createBot, runDispatch, T0, type BotFixture } from './botFixture'

let f: BotFixture
let botId: string
const MIN = 60_000
beforeEach(async () => { f = botFixture(); ({ botId } = await createBot(f)) })
afterEach(() => f.close())

it.each(['yesterday', '2000-01-01', '2026-02-30', '2030-13-01'])('refuses an unreadable or past until: %s', (until) => {
  expect(() => f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Check.', until } as never, 'owner')).toThrow(/until|date|past/i)
})

it('runs before its end, never after, leaves About and says once that it ended', async () => {
  // Input is local computer time, not UTC.
  const localEnd = new Date(T0 + 7 * MIN)
  const local = `${localEnd.getFullYear()}-${String(localEnd.getMonth()+1).padStart(2,'0')}-${String(localEnd.getDate()).padStart(2,'0')}T${String(localEnd.getHours()).padStart(2,'0')}:${String(localEnd.getMinutes()).padStart(2,'0')}`
  f.bots.addSchedule(botId, { when: { kind: 'interval', minutes: 5 }, prompt: 'Inbox check', until: local } as never, 'owner')
  expect(f.book.list(botId)[0]!.label).toContain(' · until ')
  await f.bots.reconcileOnStartup()
  const { inserted } = await f.tickSchedules(new Date(T0 + 5 * MIN))
  expect(inserted).toHaveLength(1)
  await runDispatch(f, inserted[0]!, 1, { text: 'Done.' })
  for (const minute of [8, 10, 15]) expect((await f.tickSchedules(new Date(T0 + minute * MIN))).inserted).toEqual([])
  expect(f.book.list(botId)).toEqual([])
  expect(chatOf(f, botId).filter((row) => row.text === '‘Inbox check’ ended, as planned.')).toHaveLength(1)
})
